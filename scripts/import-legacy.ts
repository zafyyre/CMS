import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { unsafeAsOrgId } from '../src/db/org-id';
import * as schema from '../src/db/schema';

config({ path: '.env' });

/**
 * Historical import, from the command line.
 *
 *   npx tsx scripts/import-legacy.ts <file.json> [--promote]
 *
 * Runs the three steps in order and prints what each one did. Without
 * `--promote` it stages and resolves only — which is how it should be run
 * first, every time, because the review queue is the point.
 *
 * Note the invocation: `npx tsx` rather than `npm run`. On Windows PowerShell
 * npm silently drops everything after `--`, so a file path passed that way
 * never arrives. The same trap is documented for `npm run db:seed -- --reset`.
 *
 * Connects as the SUPERUSER, like the seed script, because an import is an
 * operational act. That means row-level security does not apply here, so the
 * league is selected explicitly by slug and every service call is given its id.
 */

const [, , filePath, ...flags] = process.argv;
const promote = flags.includes('--promote');
const orgSlug = process.env.DEFAULT_ORG_SLUG ?? 'demo';

if (!filePath) {
  console.error('\nUsage: npx tsx scripts/import-legacy.ts <file.json> [--promote]\n');
  process.exit(1);
}

const url = process.env.SEED_DATABASE_URL;
if (!url) throw new Error('SEED_DATABASE_URL is not set');

const client = new Client({ connectionString: url });

async function main() {
  await client.connect();
  const db = drizzle(client, { schema });

  const [org] = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.slug, orgSlug), isNull(schema.organizations.deletedAt)));

  if (!org) {
    throw new Error(`No league with slug "${orgSlug}". Set DEFAULT_ORG_SLUG, or seed one first.`);
  }

  const raw = readFileSync(filePath as string, 'utf8');
  console.log(`\n▸ importing ${filePath} into ${org.name}`);

  /**
   * The services take a `Principal`, and there is no logged-in user at a
   * command line. This one is constructed explicitly and labelled as such in
   * the audit trail, rather than reaching around the authorization layer —
   * every row this writes is attributable to a script run.
   */
  const orgId = unsafeAsOrgId(org.id, 'import CLI --org');
  const principal = {
    userId: `script:import-legacy`,
    personId: await anyPersonId(db, org.id),
    orgId,
    roles: [{ role: 'LEAGUE_ADMIN' as const, scopeKind: 'ORGANIZATION' as const, scopeId: null }],
    mfaSatisfied: true,
  };

  const { listReviewQueue, promoteImport, resolveImport, stageImport } = await import(
    '../src/server/services/import'
  );

  const batch = await stageImport(principal, raw, { source: filePath, dryRun: !promote });
  console.log(`  staged          ${batch.recordsTotal} records  (batch ${batch.batchId})`);

  const resolved = await resolveImport(principal, batch.batchId);
  console.log(`  matched         ${resolved.matched}`);
  console.log(`  new             ${resolved.createdAsNew}`);
  console.log(`  needs review    ${resolved.needsReview}`);
  console.log(`  deferred        ${resolved.deferred}  (fixtures, standings, honours)`);

  if (resolved.needsReview > 0) {
    console.log('\n  A person has to decide these before anything can be promoted:\n');
    for (const item of await listReviewQueue(orgId, batch.batchId)) {
      const best = item.candidates[0];
      console.log(
        `    ${item.entityKind.padEnd(6)} "${item.sourceName}"` +
          (best ? ` → "${best.name}" (${Math.round(best.score * 100)}%)` : ' → no candidate'),
      );
    }
    console.log('\n  Nothing was promoted.\n');
    return;
  }

  if (!promote) {
    console.log('\n  Dry run. Re-run with --promote to write these into the league.\n');
    return;
  }

  const outcome = await promoteImport(principal, batch.batchId);
  console.log(`  clubs created   ${outcome.clubsCreated}`);
  console.log(`  teams created   ${outcome.teamsCreated}`);
  console.log(`  venues created  ${outcome.venuesCreated}`);
  console.log(`  already existed ${outcome.skipped}`);
  console.log('✓ import complete\n');
}

/**
 * The audit trail needs a person, and the foreign key means it has to be a real
 * one. Any league administrator will do; failing loudly when the league has no
 * people at all is better than writing an unattributable row.
 */
async function anyPersonId(
  db: ReturnType<typeof drizzle<typeof schema, Client>>,
  orgId: string,
): Promise<string> {
  const [person] = await db
    .select({ id: schema.persons.id })
    .from(schema.persons)
    .where(and(eq(schema.persons.orgId, orgId), isNull(schema.persons.deletedAt)))
    .limit(1);

  if (!person) {
    throw new Error(
      'This league has no person records, so an import cannot be attributed to anybody. ' +
        'Seed or register at least one person first.',
    );
  }
  return person.id;
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error('\n✗ import failed\n');
    let current: unknown = err;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      console.error(`[${depth}] ${current.name}: ${current.message}`);
      const withIssues = current as Error & { issues?: string[]; detail?: string };
      for (const issue of withIssues.issues ?? []) console.error(`     ${issue}`);
      if (withIssues.detail) console.error(`     detail=${withIssues.detail}`);
      current = current.cause;
    }
    await client.end().catch(() => {});
    process.exit(1);
  });
