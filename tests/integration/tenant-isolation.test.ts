import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withOrg, withSystem } from '@/db';
import { unsafeAsOrgId } from '@/db/org-id';
import {
  clubs,
  competitionEditions,
  competitionSeries,
  honours,
  organizations,
  persons,
  seasons,
  stageGroups,
  stages,
  teams,
} from '@/db/schema';
import {
  closeFixtures,
  createLeagueFixture,
  type LeagueFixture,
  truncateAll,
} from '../helpers/fixtures';

/**
 * The suite that must never be deleted or skipped.
 *
 * It guards the one failure that would be genuinely unrecoverable for this
 * product: one league reading another league's data. Everything else can be
 * fixed after the fact; that cannot.
 *
 * Fixtures are written as superuser, so both leagues genuinely exist with real
 * rows. The assertions then run through the ordinary application path as
 * `app_user`, which is what production uses.
 */

let alpha: LeagueFixture;
let bravo: LeagueFixture;

/**
 * Drizzle wraps driver errors, so PostgreSQL's message ("new row violates
 * row-level security policy") sits on `.cause`, not `.message`. Asserting on
 * the wrapper alone would pass for ANY query failure — including a typo — which
 * would make these tests worse than useless. Walk the chain.
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 6) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

async function expectRlsRejection(operation: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the operation to be rejected by RLS').toBeDefined();
  expect(messageChain(caught)).toMatch(/row-level security/i);
}

beforeEach(async () => {
  await truncateAll();
  alpha = await createLeagueFixture('alpha');
  bravo = await createLeagueFixture('bravo');
});

afterAll(async () => {
  // Only the superuser fixture pool is closed here. The application pool is a
  // module-level singleton shared by every test file, so closing it from one
  // file's teardown would break any file that runs afterwards — a failure that
  // would look like a connection bug rather than a teardown bug.
  await closeFixtures();
});

describe('reads are confined to the current league', () => {
  it('sees only its own rows across every kind of tenant table', async () => {
    const rows = await withOrg(alpha.orgId, async (tx) => ({
      seasons: await tx.select().from(seasons),
      clubs: await tx.select().from(clubs),
      teams: await tx.select().from(teams),
      series: await tx.select().from(competitionSeries),
      editions: await tx.select().from(competitionEditions),
      stages: await tx.select().from(stages),
      stageGroups: await tx.select().from(stageGroups),
      persons: await tx.select().from(persons),
      honours: await tx.select().from(honours),
    }));

    // Each fixture creates exactly one row per table, so "1" proves the other
    // league's identical row is invisible rather than merely absent.
    for (const [table, found] of Object.entries(rows)) {
      expect(found, `${table} should contain only alpha's row`).toHaveLength(1);
      expect((found[0] as { orgId: string }).orgId).toBe(alpha.orgId);
    }
  });

  it('cannot fetch another league\'s row even by its exact primary key', async () => {
    const found = await withOrg(alpha.orgId, async (tx) =>
      tx.select().from(clubs).where(eq(clubs.id, bravo.clubId)),
    );
    expect(found).toHaveLength(0);
  });

  it('returns nothing for another league\'s person — the most sensitive table', async () => {
    const found = await withOrg(alpha.orgId, async (tx) =>
      tx.select().from(persons).where(eq(persons.id, bravo.personId)),
    );
    expect(found).toHaveLength(0);
  });

  it('cannot reach another league\'s competition structure by id', async () => {
    const found = await withOrg(alpha.orgId, async (tx) =>
      tx.select().from(competitionEditions).where(eq(competitionEditions.id, bravo.editionId)),
    );
    expect(found).toHaveLength(0);
  });
});

describe('writes cannot reach or forge another league', () => {
  it('updates zero rows when targeting another league\'s record', async () => {
    const updated = await withOrg(alpha.orgId, async (tx) =>
      tx.update(clubs).set({ name: 'hijacked' }).where(eq(clubs.id, bravo.clubId)).returning(),
    );
    expect(updated).toHaveLength(0);

    // And the row is genuinely untouched, not merely unreported.
    const [row] = await withOrg(bravo.orgId, async (tx) =>
      tx.select().from(clubs).where(eq(clubs.id, bravo.clubId)),
    );
    expect(row?.name).toBe('bravo FC');
  });

  it('deletes zero rows when targeting another league\'s record', async () => {
    const deleted = await withOrg(alpha.orgId, async (tx) =>
      tx.delete(clubs).where(eq(clubs.id, bravo.clubId)).returning(),
    );
    expect(deleted).toHaveLength(0);

    const survivors = await withOrg(bravo.orgId, async (tx) => tx.select().from(clubs));
    expect(survivors).toHaveLength(1);
  });

  /**
   * The WITH CHECK test, and the one most often missing in the wild. A
   * USING-only policy filters what you can READ; without WITH CHECK an INSERT
   * can still stamp a row with another tenant's id, quietly planting data
   * inside somebody else's league.
   */
  it('rejects an insert that forges another league\'s id', async () => {
    await expectRlsRejection(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.insert(clubs).values({ orgId: bravo.orgId, name: 'smuggled', slug: 'smuggled' }),
      ),
    );

    const bravoClubs = await withOrg(bravo.orgId, async (tx) => tx.select().from(clubs));
    expect(bravoClubs).toHaveLength(1);
  });

  it('rejects an update that would move a row into another league', async () => {
    await expectRlsRejection(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.update(clubs).set({ orgId: bravo.orgId }).where(eq(clubs.id, alpha.clubId)),
      ),
    );
  });
});

describe('the league context itself is trustworthy', () => {
  it('denies every tenant table when no league context is set', async () => {
    const rows = await withSystem('verify default-deny in tests', async (tx) =>
      tx.select().from(clubs),
    );
    expect(rows).toHaveLength(0);
  });

  it('does not leak the context between transactions on a pooled connection', async () => {
    await withOrg(alpha.orgId, async (tx) => tx.select().from(clubs));

    // A fresh system transaction must not inherit alpha's context from whichever
    // pooled connection it happens to borrow.
    const leaked = await withSystem('verify no context bleed', async (tx) =>
      tx.select().from(clubs),
    );
    expect(leaked).toHaveLength(0);
  });

  it('scopes the setting to the transaction', async () => {
    const inside = await withOrg(alpha.orgId, async (tx) =>
      tx.execute(sql`select current_setting('app.current_org_id', true) as org`),
    );
    expect((inside.rows[0] as { org: string }).org).toBe(alpha.orgId);

    const outside = await withSystem('verify setting is cleared', async (tx) =>
      tx.execute(sql`select nullif(current_setting('app.current_org_id', true), '') as org`),
    );
    expect((outside.rows[0] as { org: string | null }).org).toBeNull();
  });

  it('refuses a non-UUID league id rather than silently querying unscoped', async () => {
    // The brand makes this a compile error for ordinary callers; the cast
    // simulates something arriving through JavaScript or an unsafe cast, and
    // asserts the runtime check still catches it.
    await expectRejection(
      () =>
        withOrg("'; drop table clubs; --" as ReturnType<typeof unsafeAsOrgId>, async (tx) =>
          tx.select().from(clubs),
        ),
      /must be a UUID/,
    );
  });
});

describe('routing tables stay readable, but writable only by their owner', () => {
  it('allows resolving any league by hostname before context exists', async () => {
    const orgs = await withSystem('hostname resolution needs open read', async (tx) =>
      tx.select().from(organizations),
    );
    // Both leagues are visible here — the deliberate exception that makes
    // hostname-to-league resolution possible at all.
    expect(orgs.length).toBeGreaterThanOrEqual(2);
  });

  it('forbids renaming another league', async () => {
    const updated = await withOrg(alpha.orgId, async (tx) =>
      tx
        .update(organizations)
        .set({ name: 'hijacked' })
        .where(eq(organizations.id, bravo.orgId))
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('forbids creating a league from the application role', async () => {
    await expectRlsRejection(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.insert(organizations).values({ slug: 'charlie', name: 'charlie league' }),
      ),
    );
  });
});

async function expectRejection(operation: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught, 'expected the operation to be rejected').toBeDefined();
  expect(messageChain(caught)).toMatch(pattern);
}
