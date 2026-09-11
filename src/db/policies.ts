/**
 * Row-level security, generated rather than hand-written.
 *
 * The failure this file exists to prevent: someone adds a table in eight
 * months, forgets the policy, and it quietly serves every league's rows to
 * every other league. So policies are DERIVED from the lists below and
 * re-applied on every migration, and `scripts/migrate.ts` then interrogates
 * `pg_catalog` to confirm reality matches intent — including checking that no
 * table carrying an `org_id` column is missing from these lists.
 *
 * A policy you wrote once and never verified is a policy you are hoping about.
 */

/**
 * Tables carrying `org_id`, protected by the standard tenant policy.
 * Adding a tenant table means adding it here. Forgetting fails the migration.
 */
export const TENANT_TABLES = [
  // people
  'persons',
  'role_grants',
  'guardianships',
  'consents',
  // competition structure
  'governing_bodies',
  'registration_years',
  'seasons',
  'ladders',
  'competition_series',
  'competition_editions',
  'stages',
  'stage_groups',
  'stage_entry_sources',
  'progression_rules',
  'honours',
  'honour_awards',
  // participation
  'clubs',
  'teams',
  'edition_entries',
  'stage_group_entries',
  'eligibility_profiles',
  'eligibility_rules',
  'person_registrations',
  // match day — mutable state. The evidence trail beside it is append-only.
  'municipalities',
  'venues',
  'venue_closures',
  'fixtures',
  // derived tables. Written only by the standings engine, never by hand.
  'standings_snapshots',
  'standings_rows',
  // historical import staging. Ordinary tenant tables: this is a workspace,
  // and discarding a bad batch has to be possible.
  'import_batches',
  'import_records',
  'entity_aliases',
  // published content
  'articles',
  'documents',
] as const;

/**
 * Readable and insertable within a league, never updatable or deletable by the
 * application at all.
 *
 * The permission matrix already withholds update and delete on the audit log,
 * but an application-layer rule is only as good as the code that consults it —
 * and the scenario an audit log exists to survive is precisely our own service
 * being compromised or buggy. So the database refuses too.
 *
 * The three match-day tables are here for the same reason in a narrower form:
 * a reschedule history the league office can rewrite is not evidence, and a
 * result submission that can be edited after the fact cannot show that two
 * clubs disagreed. Corrections in these tables are new rows that supersede or
 * retract earlier ones — see src/db/schema/match.ts.
 *
 * Note that this alone is not sufficient: with FOR ALL on the parent, deleting
 * a fixture would take its evidence with it. The foreign keys from these three
 * tables to `fixtures` are therefore NO ACTION rather than CASCADE, so
 * PostgreSQL refuses that route too.
 */
export const APPEND_ONLY_TABLES = [
  'audit_log',
  'fixture_changes',
  'result_submissions',
  'match_events',
] as const;

/**
 * Editable while a draft; frozen the moment they are published.
 *
 * The rules a season was played under are part of that season's record.
 * Changing next year's points-for-a-win must not silently rewrite 2019's final
 * table — and "must not" is worth nothing unless something enforces it.
 *
 * The mechanism is the UPDATE policy's USING clause, which excludes rows whose
 * `published_at` is set. An UPDATE aimed at a published row therefore matches
 * NOTHING: no error, zero rows, exactly as with the append-only tables. A draft
 * can still be edited, and can still be published, because WITH CHECK does not
 * repeat the condition.
 *
 * A consequence worth stating plainly: a published row can never be updated at
 * all, and that includes setting `deleted_at`. Published rules are permanent,
 * and their slug stays taken. That is the intended behaviour — a rule set is
 * versioned by creating the next one, not by editing or retiring the last.
 *
 * Every table listed here MUST have a `published_at` column; the migration
 * asserts it, because a missing column would make the policy silently
 * permissive rather than fail loudly.
 */
export const PUBLISHED_IMMUTABLE_TABLES = ['competition_rules'] as const;

/**
 * Routing tables. These must be readable BEFORE we know which league a request
 * belongs to, because resolving a hostname to a league is itself a query
 * against them. They hold a league's name and hostname — public by definition,
 * since they are how the public reaches the site.
 *
 * Reads are open; writes are restricted to the league itself. Neither table
 * grants INSERT or DELETE at all: creating a league is an operational act
 * performed by the seed script as superuser, not something a web request can do.
 */
export const ROUTING_TABLES = ['organizations', 'org_domains'] as const;

/**
 * Global login identity. No `org_id`, therefore no tenant policy: the same
 * human may referee in one league and play in another, and authentication
 * happens before any league is known.
 *
 * `scripts/migrate.ts` asserts these do NOT have RLS enabled, so the exception
 * stays deliberate instead of drifting into an accident.
 */
export const IDENTITY_TABLES = [
  'users',
  'sessions',
  'accounts',
  'verifications',
  'two_factors',
] as const;

/** The role the application connects as. Never a superuser, never an owner. */
export const APP_ROLE = 'app_user';

/**
 * Reads the transaction-local league id set by `withOrg()`.
 *
 * `current_setting(..., true)` returns NULL rather than raising when unset, and
 * the NULLIF guards the empty string, which would fail the ::uuid cast. When it
 * returns NULL every policy below evaluates false — so the default, with no
 * league context, is to deny everything.
 */
const CURRENT_ORG_FN = `
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.current_org_id', true), '')::uuid $$;
`;

function tenantPolicy(table: string): string {
  // IS NOT DISTINCT FROM rather than `=`, so NULL behaves predictably. For a
  // NOT NULL org column it is identical to `=`.
  const predicate = 'org_id IS NOT DISTINCT FROM app_current_org()';
  return `
ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
-- FORCE matters: without it, policies are skipped for the table's OWNER, and
-- every test would pass while production leaked.
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "${table}";
CREATE POLICY tenant_isolation ON "${table}"
  FOR ALL TO ${APP_ROLE}
  USING (${predicate})
  -- WITH CHECK is not optional. USING alone governs which rows may be read and
  -- updated FROM; without WITH CHECK, an INSERT or UPDATE could still write a
  -- row stamped with another league's org_id.
  WITH CHECK (${predicate});
`;
}

function appendOnlyPolicy(table: string): string {
  const predicate = 'org_id IS NOT DISTINCT FROM app_current_org()';
  return `
ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;

-- Dropped in case this table was ever listed as an ordinary tenant table,
-- which would have granted FOR ALL and with it the power to delete the record
-- of what happened.
DROP POLICY IF EXISTS tenant_isolation ON "${table}";

DROP POLICY IF EXISTS append_only_read ON "${table}";
CREATE POLICY append_only_read ON "${table}"
  FOR SELECT TO ${APP_ROLE} USING (${predicate});

DROP POLICY IF EXISTS append_only_insert ON "${table}";
CREATE POLICY append_only_insert ON "${table}"
  FOR INSERT TO ${APP_ROLE} WITH CHECK (${predicate});

-- No UPDATE or DELETE policy. With RLS forced and nothing permitting those
-- commands, PostgreSQL denies them outright.
`;
}

function publishedImmutablePolicy(table: string): string {
  const predicate = 'org_id IS NOT DISTINCT FROM app_current_org()';
  return `
ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;

-- Dropped in case this table was ever an ordinary tenant table, which would
-- have granted FOR ALL and with it the power to rewrite a published rule set.
DROP POLICY IF EXISTS tenant_isolation ON "${table}";

DROP POLICY IF EXISTS published_read ON "${table}";
CREATE POLICY published_read ON "${table}"
  FOR SELECT TO ${APP_ROLE} USING (${predicate});

DROP POLICY IF EXISTS published_insert ON "${table}";
CREATE POLICY published_insert ON "${table}"
  FOR INSERT TO ${APP_ROLE} WITH CHECK (${predicate});

-- The whole point of this category. USING is evaluated against the row as it
-- stands, so a published row is simply not visible to an UPDATE and the
-- statement matches zero rows. WITH CHECK deliberately does NOT repeat the
-- condition, because publishing is itself an update that sets published_at.
DROP POLICY IF EXISTS published_update_draft_only ON "${table}";
CREATE POLICY published_update_draft_only ON "${table}"
  FOR UPDATE TO ${APP_ROLE}
  USING (${predicate} AND published_at IS NULL)
  WITH CHECK (${predicate});

DROP POLICY IF EXISTS published_delete_draft_only ON "${table}";
CREATE POLICY published_delete_draft_only ON "${table}"
  FOR DELETE TO ${APP_ROLE}
  USING (${predicate} AND published_at IS NULL);
`;
}

function routingPolicy(table: string): string {
  const ownerColumn = table === 'organizations' ? 'id' : 'org_id';
  const predicate = `${ownerColumn} IS NOT DISTINCT FROM app_current_org()`;
  return `
ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS routing_read ON "${table}";
CREATE POLICY routing_read ON "${table}"
  FOR SELECT TO ${APP_ROLE} USING (true);

DROP POLICY IF EXISTS routing_self_update ON "${table}";
CREATE POLICY routing_self_update ON "${table}"
  FOR UPDATE TO ${APP_ROLE}
  USING (${predicate}) WITH CHECK (${predicate});

-- Deliberately no INSERT or DELETE policy: with RLS forced and nothing
-- permitting them, app_user cannot create or destroy a league.
`;
}

/** Full idempotent policy DDL, safe to re-run on every migration. */
export function buildPolicySql(): string {
  return [
    '-- Generated by src/db/policies.ts — do not edit by hand.',
    CURRENT_ORG_FN,
    `GRANT EXECUTE ON FUNCTION app_current_org() TO ${APP_ROLE};`,
    ...TENANT_TABLES.map(tenantPolicy),
    ...APPEND_ONLY_TABLES.map(appendOnlyPolicy),
    ...PUBLISHED_IMMUTABLE_TABLES.map(publishedImmutablePolicy),
    ...ROUTING_TABLES.map(routingPolicy),
  ].join('\n');
}

export const ALL_PROTECTED_TABLES: readonly string[] = [
  ...TENANT_TABLES,
  ...APPEND_ONLY_TABLES,
  ...PUBLISHED_IMMUTABLE_TABLES,
  ...ROUTING_TABLES,
];
