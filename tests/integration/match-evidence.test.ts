import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withOrg } from '@/db';
import { fixtureChanges, fixtures, matchEvents, resultSubmissions, venues } from '@/db/schema';
import { rescheduleFixture, scheduleFixture } from '@/server/services/fixtures';
import { recordMatchEvents, submitResult } from '@/server/services/results';
import {
  closeFixtures,
  createLeagueFixture,
  createMatchDayFixture,
  type LeagueFixture,
  type MatchDayFixture,
  truncateAll,
} from '../helpers/fixtures';
import { leagueAdmin } from '../helpers/principals';

/**
 * The match-day evidence tables, proved immutable in PostgreSQL rather than by
 * convention.
 *
 * A reschedule history the league office can rewrite is not evidence, and a
 * result submission that can be edited after the fact cannot show that two
 * clubs disagreed. The permission matrix already withholds update and delete
 * on these, but the scenario they exist to survive is our own service being
 * compromised or buggy — so the database has to refuse as well.
 *
 * There is a second, less obvious route to the same end, which these tests
 * also close: the append-only policies protect the ROWS, but the application
 * holds FOR ALL on `fixtures`, so deleting the parent fixture would take its
 * whole trail with it. The foreign keys are NO ACTION for exactly that reason.
 */

let alpha: LeagueFixture;
let bravo: LeagueFixture;
let alphaMatch: MatchDayFixture;

beforeEach(async () => {
  await truncateAll();
  alpha = await createLeagueFixture('alpha');
  bravo = await createLeagueFixture('bravo');
  alphaMatch = await createMatchDayFixture(alpha);
});

afterAll(async () => {
  await closeFixtures();
});

const admin = () => leagueAdmin(alpha);

function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 6) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

async function catchError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A fixture with one reschedule, one result and one card behind it. */
async function fixtureWithHistory(): Promise<string> {
  const created = await scheduleFixture(admin(), {
    stageGroupId: alpha.stageGroupId,
    homeEntryId: alpha.entryId,
    awayEntryId: alphaMatch.opponentEntryId,
    venueId: alphaMatch.venueId,
    kickoffLocal: '2026-04-11T14:00',
  });
  await rescheduleFixture(admin(), {
    fixtureId: created.id,
    kickoffLocal: '2026-04-12T11:00',
    reason: 'Waterlogged.',
  });
  await submitResult(admin(), {
    fixtureId: created.id,
    source: 'REFEREE',
    homeScore: 2,
    awayScore: 1,
  });
  await recordMatchEvents(admin(), created.id, [
    { type: 'RED_CARD', minute: 70, editionEntryId: alpha.entryId, personId: alpha.personId },
  ]);
  return created.id;
}

describe('the reschedule history cannot be rewritten', () => {
  /**
   * Note the MECHANISM, which is the same as the audit log's: with RLS forced
   * and no UPDATE or DELETE policy, PostgreSQL does not raise — it matches no
   * rows. So the assertion is "nothing changed", not "it threw".
   */
  it('cannot change the time a fixture was moved from', async () => {
    const fixtureId = await fixtureWithHistory();

    const updated = await withOrg(alpha.orgId, async (tx) =>
      tx
        .update(fixtureChanges)
        .set({ reason: 'no reason given', previousKickoffAt: null })
        .where(eq(fixtureChanges.fixtureId, fixtureId))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const rows = await withOrg(alpha.orgId, async (tx) =>
      tx.select().from(fixtureChanges).where(eq(fixtureChanges.fixtureId, fixtureId)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.reason === 'Waterlogged.')).toBe(true);
  });

  it('cannot delete a change row', async () => {
    const fixtureId = await fixtureWithHistory();

    const deleted = await withOrg(alpha.orgId, async (tx) =>
      tx.delete(fixtureChanges).where(eq(fixtureChanges.fixtureId, fixtureId)).returning(),
    );
    expect(deleted).toHaveLength(0);

    const survivors = await withOrg(alpha.orgId, async (tx) => tx.select().from(fixtureChanges));
    expect(survivors).toHaveLength(2);
  });
});

describe('result submissions cannot be edited into agreement', () => {
  it('cannot change a submitted score', async () => {
    const fixtureId = await fixtureWithHistory();

    const updated = await withOrg(alpha.orgId, async (tx) =>
      tx
        .update(resultSubmissions)
        .set({ homeScore: 9, awayScore: 0 })
        .where(eq(resultSubmissions.fixtureId, fixtureId))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const [row] = await withOrg(alpha.orgId, async (tx) => tx.select().from(resultSubmissions));
    expect(row?.homeScore).toBe(2);
  });

  it('cannot delete a submission', async () => {
    const fixtureId = await fixtureWithHistory();

    const deleted = await withOrg(alpha.orgId, async (tx) =>
      tx.delete(resultSubmissions).where(eq(resultSubmissions.fixtureId, fixtureId)).returning(),
    );
    expect(deleted).toHaveLength(0);
    expect(
      await withOrg(alpha.orgId, async (tx) => tx.select().from(resultSubmissions)),
    ).toHaveLength(1);
  });

  it('cannot supersede the same submission twice, even by raw insert', async () => {
    // The application refuses this with a readable error. The unique index is
    // what stops two competing "corrections" both looking current, which would
    // make the resolved score depend on row order.
    const fixtureId = await fixtureWithHistory();
    const [original] = await withOrg(alpha.orgId, async (tx) =>
      tx.select().from(resultSubmissions),
    );

    await withOrg(alpha.orgId, async (tx) =>
      tx.insert(resultSubmissions).values({
        orgId: alpha.orgId,
        fixtureId,
        source: 'LEAGUE_ADMIN',
        homeScore: 3,
        awayScore: 1,
        supersedesId: original!.id,
      }),
    );

    const error = await catchError(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.insert(resultSubmissions).values({
          orgId: alpha.orgId,
          fixtureId,
          source: 'LEAGUE_ADMIN',
          homeScore: 4,
          awayScore: 1,
          supersedesId: original!.id,
        }),
      ),
    );
    expect(messageChain(error)).toMatch(/result_submissions_supersedes_unique|duplicate key/i);
  });
});

describe('match events cannot be quietly withdrawn', () => {
  it('cannot delete a red card', async () => {
    const fixtureId = await fixtureWithHistory();

    const deleted = await withOrg(alpha.orgId, async (tx) =>
      tx.delete(matchEvents).where(eq(matchEvents.fixtureId, fixtureId)).returning(),
    );
    expect(deleted).toHaveLength(0);

    const [row] = await withOrg(alpha.orgId, async (tx) => tx.select().from(matchEvents));
    expect(row?.type).toBe('RED_CARD');
  });

  it('cannot change who it was shown to', async () => {
    const fixtureId = await fixtureWithHistory();

    const updated = await withOrg(alpha.orgId, async (tx) =>
      tx
        .update(matchEvents)
        .set({ type: 'YELLOW_CARD', personId: null })
        .where(eq(matchEvents.fixtureId, fixtureId))
        .returning(),
    );
    expect(updated).toHaveLength(0);
  });
});

describe('deleting the fixture is not a way to delete its history', () => {
  it('refuses to remove a fixture that has evidence attached', async () => {
    // The application holds FOR ALL on `fixtures`, so this DELETE is permitted
    // by row-level security. What stops it is the NO ACTION foreign key from
    // each evidence table — without which the append-only policies would be
    // defeated by removing the parent.
    const fixtureId = await fixtureWithHistory();

    const error = await catchError(() =>
      withOrg(alpha.orgId, async (tx) => tx.delete(fixtures).where(eq(fixtures.id, fixtureId))),
    );

    expect(messageChain(error)).toMatch(/violates foreign key constraint/i);

    const survivors = await withOrg(alpha.orgId, async (tx) =>
      tx.select().from(fixtures).where(eq(fixtures.id, fixtureId)),
    );
    expect(survivors).toHaveLength(1);
  });

  it('still allows the fixture to be soft-deleted, which is what withdrawal means', async () => {
    const fixtureId = await fixtureWithHistory();

    const updated = await withOrg(alpha.orgId, async (tx) =>
      tx
        .update(fixtures)
        .set({ deletedAt: new Date() })
        .where(eq(fixtures.id, fixtureId))
        .returning(),
    );
    expect(updated).toHaveLength(1);

    const changes = await withOrg(alpha.orgId, async (tx) => tx.select().from(fixtureChanges));
    expect(changes.length).toBeGreaterThan(0);
  });

  it('refuses to remove a venue that a fixture points at', async () => {
    await fixtureWithHistory();

    const error = await catchError(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.delete(venues).where(eq(venues.id, alphaMatch.venueId)),
      ),
    );
    expect(messageChain(error)).toMatch(/violates foreign key constraint/i);
  });
});

describe('match day is confined to its own league', () => {
  it('shows one league nothing of another league\'s match day', async () => {
    await fixtureWithHistory();

    const seenByBravo = await withOrg(bravo.orgId, async (tx) => ({
      fixtures: await tx.select().from(fixtures),
      changes: await tx.select().from(fixtureChanges),
      submissions: await tx.select().from(resultSubmissions),
      events: await tx.select().from(matchEvents),
      venues: await tx.select().from(venues),
    }));

    for (const [table, rows] of Object.entries(seenByBravo)) {
      expect(rows, `bravo should see no ${table}`).toHaveLength(0);
    }
  });

  it('cannot fetch another league\'s fixture by its exact primary key', async () => {
    const fixtureId = await fixtureWithHistory();

    const found = await withOrg(bravo.orgId, async (tx) =>
      tx.select().from(fixtures).where(eq(fixtures.id, fixtureId)),
    );
    expect(found).toHaveLength(0);
  });

  it('rejects a fixture stamped with another league\'s id', async () => {
    const error = await catchError(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.insert(fixtures).values({
          orgId: bravo.orgId,
          stageGroupId: bravo.stageGroupId,
        }),
      ),
    );
    expect(messageChain(error)).toMatch(/row-level security/i);
  });

  it('makes a fixture pointing at another league\'s venue inexpressible', async () => {
    // The composite foreign key carries org_id, so this cannot be written even
    // though foreign-key checks run with elevated privilege and bypass RLS.
    const bravoMatch = await createMatchDayFixture(bravo);

    const error = await catchError(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.insert(fixtures).values({
          orgId: alpha.orgId,
          stageGroupId: alpha.stageGroupId,
          venueId: bravoMatch.venueId,
        }),
      ),
    );
    expect(messageChain(error)).toMatch(/violates foreign key constraint/i);
  });

  it('makes a match event crediting another league\'s team inexpressible', async () => {
    const fixtureId = await fixtureWithHistory();
    const bravoMatch = await createMatchDayFixture(bravo);

    const error = await catchError(() =>
      withOrg(alpha.orgId, async (tx) =>
        tx.insert(matchEvents).values({
          orgId: alpha.orgId,
          fixtureId,
          editionEntryId: bravoMatch.opponentEntryId,
          type: 'GOAL',
        }),
      ),
    );
    expect(messageChain(error)).toMatch(/violates foreign key constraint/i);
  });
});
