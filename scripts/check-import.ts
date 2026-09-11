import { config } from 'dotenv';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';
import { unsafeAsOrgId } from '../src/db/org-id';
import * as schema from '../src/db/schema';

config({ path: '.env' });

/**
 * THE ACCEPTANCE TEST for the historical import, from the command line.
 *
 *   npx tsx scripts/check-import.ts [batchId]
 *
 * Recomputes each imported season's table from the results that were imported
 * and diffs it against the table the source itself published. One comparison
 * validates the importer, the schema and the standings engine at once — where
 * they disagree, exactly one of the three is wrong.
 *
 * The check itself already existed; it was reachable only from the admin review
 * screen, which means it could not run in a terminal, in CI, or against a batch
 * imported by the CLI. This is the same function, printed.
 *
 * With no argument it checks every promoted batch, newest last.
 */

const [, , batchArg] = process.argv;
const orgSlug = process.env.DEFAULT_ORG_SLUG ?? 'demo';

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

  if (!org) throw new Error(`No league with slug "${orgSlug}".`);
  const orgId = unsafeAsOrgId(org.id, 'check-import CLI --org');

  const batches = batchArg
    ? [{ id: batchArg, source: batchArg }]
    : await db
        .select({ id: schema.importBatches.id, source: schema.importBatches.source })
        .from(schema.importBatches)
        .where(
          and(
            eq(schema.importBatches.orgId, org.id),
            eq(schema.importBatches.status, 'PROMOTED'),
            isNull(schema.importBatches.deletedAt),
          ),
        )
        .orderBy(desc(schema.importBatches.startedAt));

  if (batches.length === 0) {
    console.log('\nNo promoted batches to check.\n');
    return;
  }

  const { checkImportedStandings } = await import('../src/server/services/import');

  let tables = 0;
  let clean = 0;

  for (const batch of [...batches].reverse()) {
    const checks = await checkImportedStandings(orgId, batch.id);
    if (checks.length === 0) continue;

    console.log(`\n▸ ${batch.source}`);
    for (const check of checks) {
      tables++;
      const where = check.groupKey ? `${check.competitionKey} / ${check.groupKey}` : check.competitionKey;

      if (!check.resolved) {
        console.log(`  ✗ ${where}  cannot compare`);
        for (const line of check.summary) console.log(`      ${line}`);
        continue;
      }

      if (check.matches) {
        clean++;
        console.log(`  ✓ ${where}  recomputed table matches the published one exactly`);
        continue;
      }

      console.log(`  ✗ ${where}  ${check.summary.length} difference(s)`);
      for (const hint of check.hints) console.log(`      hint: ${hint}`);
      for (const line of check.summary.slice(0, 12)) console.log(`      ${line}`);
      if (check.summary.length > 12) {
        console.log(`      … and ${check.summary.length - 12} more`);
      }
    }
  }

  console.log(`\n${clean === tables ? '✓' : '✗'} ${clean}/${tables} tables match\n`);
  if (clean !== tables) process.exitCode = 1;
}

main()
  .then(() => client.end())
  .catch(async (err: unknown) => {
    console.error('\n✗ check failed\n');
    let current: unknown = err;
    for (let depth = 0; current instanceof Error && depth < 5; depth++) {
      console.error(`[${depth}] ${current.name}: ${current.message}`);
      current = current.cause;
    }
    await client.end().catch(() => {});
    process.exit(1);
  });
