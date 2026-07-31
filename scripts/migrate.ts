import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import {
  ALL_PROTECTED_TABLES,
  APP_ROLE,
  APPEND_ONLY_TABLES,
  buildPolicySql,
  IDENTITY_TABLES,
} from '../src/db/policies';

config({ path: '.env' });

/**
 * Applies schema migrations, regenerates row-level security policies, and then
 * PROVES against pg_catalog that the protection is real.
 *
 * The proving is the point. RLS that is merely written is RLS you are hoping
 * about — a single missing FORCE, or the app connecting as a superuser, makes
 * every policy decorative while every test still passes.
 */

const useTestDb = process.argv.includes('--test');

const url = useTestDb
  ? process.env.TEST_MIGRATION_DATABASE_URL
  : process.env.MIGRATION_DATABASE_URL;

if (!url) {
  throw new Error(
    `${useTestDb ? 'TEST_MIGRATION_DATABASE_URL' : 'MIGRATION_DATABASE_URL'} is not set. ` +
      'Copy .env.example to .env first.',
  );
}

/** Connects as `migrator`, which owns the tables. The app never uses this role. */
const client = new Client({ connectionString: url });

async function main() {
  await client.connect();
  console.log(`\n▸ migrating ${useTestDb ? 'test' : 'development'} database`);

  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  console.log('  schema migrations applied');

  // Re-derived and re-applied every run, so a newly added table cannot ship
  // without protection.
  await client.query(buildPolicySql());
  console.log(`  RLS policies applied to ${ALL_PROTECTED_TABLES.length} tables`);

  await assertNoUnprotectedTenantTable();
  await assertPoliciesAreLive();
  await assertAppendOnlyTablesAreImmutable();
  await assertAppRoleCannotEscape();

  console.log('✓ migration and security verification complete\n');
}

/**
 * The important one. A table with an `org_id` column that nobody remembered to
 * list is, by definition, a table serving every league's rows to everyone.
 * Fail the migration rather than discover it in production.
 */
async function assertNoUnprotectedTenantTable() {
  const { rows } = await client.query<{ table_name: string }>(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attname = 'org_id' AND a.attisdropped = false
  `);

  const known = new Set<string>(ALL_PROTECTED_TABLES);
  const unlisted = rows.map((r) => r.table_name).filter((t) => !known.has(t));

  if (unlisted.length > 0) {
    throw new Error(
      'These tables carry org_id but are not listed in src/db/policies.ts:\n' +
        unlisted.map((t) => `  - ${t}`).join('\n') +
        '\n\nAdd them to TENANT_TABLES (or ROUTING_TABLES if they must be readable\n' +
        'before the league is known). Without a policy they leak across leagues.',
    );
  }
}

/** Confirms via the catalog that RLS is enabled, FORCEd, and has policies. */
async function assertPoliciesAreLive() {
  const { rows } = await client.query<{
    table_name: string;
    rls_enabled: boolean;
    rls_forced: boolean;
    policy_count: number;
  }>(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls_enabled,
           c.relforcerowsecurity AS rls_forced,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  `);

  const byName = new Map(rows.map((r) => [r.table_name, r]));
  const problems: string[] = [];

  for (const table of ALL_PROTECTED_TABLES) {
    const row = byName.get(table);
    if (!row) {
      problems.push(`${table}: table does not exist`);
      continue;
    }
    if (!row.rls_enabled) problems.push(`${table}: RLS not enabled`);
    // Without FORCE, the table owner silently bypasses every policy.
    if (!row.rls_forced) problems.push(`${table}: RLS not FORCEd`);
    if (row.policy_count === 0) problems.push(`${table}: no policies attached`);
  }

  // Identity tables are intentionally unprotected — say so out loud, so the
  // decision stays visible rather than becoming an unnoticed default.
  for (const table of IDENTITY_TABLES) {
    if (byName.get(table)?.rls_enabled) {
      problems.push(
        `${table}: RLS is enabled but this is declared an identity table — ` +
          'sign-in happens before any league context and will now fail',
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`RLS verification failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/** An audit log the application can rewrite is not evidence. */
async function assertAppendOnlyTablesAreImmutable() {
  const problems: string[] = [];

  for (const table of APPEND_ONLY_TABLES) {
    const { rows } = await client.query<{ polname: string; polcmd: string }>(
      `SELECT p.polname, p.polcmd::text AS polcmd
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );

    // polcmd: r=SELECT, a=INSERT, w=UPDATE, d=DELETE, *=ALL
    for (const p of rows) {
      if (['w', 'd', '*'].includes(p.polcmd)) {
        const what = p.polcmd === '*' ? 'ALL commands' : p.polcmd === 'w' ? 'UPDATE' : 'DELETE';
        problems.push(`${table}: policy "${p.polname}" permits ${what} — must be append-only`);
      }
    }
    if (!rows.some((p) => p.polcmd === 'a')) {
      problems.push(`${table}: no INSERT policy — nothing could ever be recorded`);
    }
    if (!rows.some((p) => p.polcmd === 'r')) {
      problems.push(`${table}: no SELECT policy — nothing could ever be read back`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Append-only verification failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
}

/** If app_user can turn policies off, the policies are decorative. */
async function assertAppRoleCannotEscape() {
  const { rows: roleRows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [APP_ROLE],
  );

  const role = roleRows[0];
  if (!role) throw new Error(`role ${APP_ROLE} does not exist`);
  if (role.rolsuper) throw new Error(`${APP_ROLE} is a SUPERUSER — RLS does not apply to it`);
  if (role.rolbypassrls) throw new Error(`${APP_ROLE} has BYPASSRLS — policies are decorative`);

  const { rows: owned } = await client.query<{ relname: string }>(
    `SELECT c.relname
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND pg_get_userbyid(c.relowner) = $1`,
    [APP_ROLE],
  );

  if (owned.length > 0) {
    throw new Error(
      `${APP_ROLE} owns tables (${owned.map((o) => o.relname).join(', ')}). ` +
        'An owner can DROP POLICY. Tables must be owned by migrator.',
    );
  }
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    // Drizzle wraps driver errors and reports the failing SQL; the actual
    // PostgreSQL detail lives on the cause. Print the whole chain, or you end
    // up debugging the wrapper instead of the problem.
    console.error('\n✗ migration failed\n');
    let current: unknown = err;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      console.error(`[${depth}] ${current.name}: ${current.message}`);
      const pg = current as Error & { code?: string; detail?: string };
      if (pg.code) console.error(`     code=${pg.code}`);
      if (pg.detail) console.error(`     detail=${pg.detail}`);
      current = current.cause;
    }
    await client.end().catch(() => {});
    process.exit(1);
  });
