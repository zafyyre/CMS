import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withOrg } from '@/db';
import { competitionRules, editionEntries, stageGroupEntries } from '@/db/schema';
import { ForbiddenError } from '@/server/authz/can';
import { scheduleFixture } from '@/server/services/fixtures';
import { listDiscipline, listScorers } from '@/server/services/leaderboards';
import { recordMatchEvents, retractMatchEvent, submitResult } from '@/server/services/results';
import {
  getStandings,
  listStandingsHistory,
  recomputeStandings,
} from '@/server/services/standings';
import {
  closeFixtures,
  createLeagueFixture,
  createMatchDayFixture,
  type LeagueFixture,
  type MatchDayFixture,
  rootDb,
  truncateAll,
} from '../helpers/fixtures';
import { leagueAdmin, orgScoped, principalFor } from '../helpers/principals';

/**
 * The standings engine against the real database.
 *
 * The unit suite proves the arithmetic and the ordering. This proves the
 * plumbing: that the right facts reach the engine, that the conclusion is
 * stored, and — the part most worth testing — that the table updates itself
 * when a result arrives, rather than waiting for somebody to remember.
 */

let league: LeagueFixture;
let matchDay: MatchDayFixture;

beforeEach(async () => {
  await truncateAll();
  league = await createLeagueFixture('alpha');
  matchDay = await createMatchDayFixture(league);

  // The fixture helper places only the home side in the group; the standings
  // engine reads group membership, so the opponent needs a placement too.
  await rootDb.insert(stageGroupEntries).values([
    { orgId: league.orgId, stageGroupId: league.stageGroupId, editionEntryId: league.entryId },
    {
      orgId: league.orgId,
      stageGroupId: league.stageGroupId,
      editionEntryId: matchDay.opponentEntryId,
    },
  ]);
});

afterAll(async () => {
  await closeFixtures();
});

const admin = () => leagueAdmin(league);

async function catchError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** A second fixture between the same two sides, so a table has some depth. */
async function scheduleReturnLeg(): Promise<string> {
  const created = await scheduleFixture(admin(), {
    stageGroupId: league.stageGroupId,
    homeEntryId: matchDay.opponentEntryId,
    awayEntryId: league.entryId,
    kickoffLocal: '2026-03-14T14:00',
  });
  return created.id;
}

describe('the table follows the facts', () => {
  it('has no table at all until something is computed', async () => {
    expect(await getStandings(league.orgId, league.stageGroupId)).toBeNull();
  });

  it('appears the moment a result is submitted, without anyone asking', async () => {
    // The single most common way a league system loses trust is a result being
    // visible while the table still shows the old one.
    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 3,
      awayScore: 1,
    });

    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table).not.toBeNull();
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[0]).toMatchObject({
      teamName: 'alpha FC',
      position: 1,
      played: 1,
      won: 1,
      goalsFor: 3,
      goalsAgainst: 1,
      points: 3,
    });
    expect(table?.rows[1]).toMatchObject({ teamName: 'alpha Athletic', points: 0, lost: 1 });
  });

  it('follows a correction rather than keeping the first answer', async () => {
    const first = await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 3,
      awayScore: 1,
    });
    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 1,
      awayScore: 3,
      supersedesId: first.id,
      reason: 'Scores were entered the wrong way round.',
    });

    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table?.rows[0]?.teamName).toBe('alpha Athletic');
    expect(table?.rows[0]?.points).toBe(3);
  });

  it('leaves a disputed result out of the table and counts it as disputed', async () => {
    const homeManager = principalFor(league, [
      { role: 'TEAM_MANAGER', scopeKind: 'TEAM', scopeId: league.teamId },
    ]);
    const awayManager = principalFor(league, [
      { role: 'TEAM_MANAGER', scopeKind: 'TEAM', scopeId: matchDay.opponentTeamId },
    ]);

    await submitResult(homeManager, {
      fixtureId: matchDay.fixtureId,
      source: 'HOME_TEAM',
      homeScore: 3,
      awayScore: 1,
    });
    await submitResult(awayManager, {
      fixtureId: matchDay.fixtureId,
      source: 'AWAY_TEAM',
      homeScore: 1,
      awayScore: 1,
    });

    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table?.fixturesDisputed).toBe(1);
    expect(table?.fixturesCounted).toBe(0);
    expect(table?.rows.every((r) => r.played === 0)).toBe(true);
  });

  it('counts an unplayed fixture as outstanding', async () => {
    await scheduleReturnLeg();
    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 1,
      awayScore: 0,
    });

    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table?.fixturesCounted).toBe(1);
    expect(table?.fixturesOutstanding).toBe(1);
  });

  it('records the reasoning next to the position', async () => {
    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 2,
      awayScore: 0,
    });

    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table?.rows[0]?.basis).toBe('3 points.');
  });

  it('keeps every earlier table, so "as at week seven" is a query', async () => {
    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 1,
      awayScore: 0,
    });
    const returnLeg = await scheduleReturnLeg();
    await submitResult(admin(), {
      fixtureId: returnLeg,
      source: 'REFEREE',
      homeScore: 4,
      awayScore: 0,
    });

    const history = await listStandingsHistory(league.orgId, league.stageGroupId);
    expect(history.length).toBeGreaterThanOrEqual(2);
    // Newest first.
    expect(history[0]?.fixturesCounted).toBe(2);
    expect(history[1]?.fixturesCounted).toBe(1);
  });
});

describe('points adjustments are an input, never an edit', () => {
  it('applies a deduction and shows it separately from points earned', async () => {
    // A hearing imposes the deduction on the ENTRY. Nothing writes to the
    // table itself — the deduction is an input to the derivation.
    await withOrg(league.orgId, async (tx) =>
      tx
        .update(editionEntries)
        .set({ pointsAdjustment: -3 })
        .where(eq(editionEntries.id, league.entryId)),
    );

    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 2,
      awayScore: 0,
    });

    const table = await getStandings(league.orgId, league.stageGroupId);
    const winner = table?.rows.find((r) => r.teamName === 'alpha FC');
    expect(winner).toMatchObject({ pointsEarned: 3, pointsAdjustment: -3, points: 0 });
    expect(winner?.basis).toMatch(/deduction of 3/);
  });
});

describe('rules', () => {
  it('uses the competition\'s own rules when it has them', async () => {
    const [rules] = await rootDb
      .insert(competitionRules)
      .values({
        orgId: league.orgId,
        name: 'Two points for a win',
        slug: 'two-points',
        pointsForWin: 2,
        pointsForDraw: 1,
        pointsForLoss: 0,
        tieBreakers: ['GOAL_DIFFERENCE'],
      })
      .returning({ id: competitionRules.id });

    await rootDb.execute(
      `UPDATE competition_editions SET rules_id = '${rules!.id}' WHERE id = '${league.editionId}'`,
    );

    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 1,
      awayScore: 0,
    });

    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table?.rows[0]?.points).toBe(2);
  });

  it('falls back to three-points-for-a-win when nothing is configured', async () => {
    await submitResult(admin(), {
      fixtureId: matchDay.fixtureId,
      source: 'REFEREE',
      homeScore: 1,
      awayScore: 0,
    });
    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table?.rows[0]?.points).toBe(3);
  });
});

describe('a published rule set is frozen by PostgreSQL', () => {
  async function insertRules(published: boolean) {
    const [row] = await rootDb
      .insert(competitionRules)
      .values({
        orgId: league.orgId,
        name: 'Standard',
        slug: `standard-${published ? 'published' : 'draft'}`,
        publishedAt: published ? new Date('2025-08-01T00:00:00Z') : null,
      })
      .returning({ id: competitionRules.id });
    return row!.id;
  }

  it('lets a draft be edited', async () => {
    const id = await insertRules(false);
    const updated = await withOrg(league.orgId, async (tx) =>
      tx
        .update(competitionRules)
        .set({ pointsForWin: 2 })
        .where(eq(competitionRules.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
  });

  it('lets a draft be published', async () => {
    // Publishing is itself an update, so the WITH CHECK deliberately does not
    // repeat the condition that the USING clause carries.
    const id = await insertRules(false);
    const updated = await withOrg(league.orgId, async (tx) =>
      tx
        .update(competitionRules)
        .set({ publishedAt: new Date() })
        .where(eq(competitionRules.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(1);
  });

  it('matches zero rows when rewriting a published rule set', async () => {
    /**
     * The mechanism is the same as the append-only tables': with RLS forced and
     * the USING clause excluding published rows, PostgreSQL does not raise — it
     * matches nothing. Asserting "it threw" would fail; asserting loosely would
     * give false confidence.
     */
    const id = await insertRules(true);

    const updated = await withOrg(league.orgId, async (tx) =>
      tx
        .update(competitionRules)
        .set({ pointsForWin: 99 })
        .where(eq(competitionRules.id, id))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const [row] = await withOrg(league.orgId, async (tx) =>
      tx.select().from(competitionRules).where(eq(competitionRules.id, id)),
    );
    expect(row?.pointsForWin).toBe(3);
  });

  it('cannot be deleted, or soft-deleted, once published', async () => {
    const id = await insertRules(true);

    const deleted = await withOrg(league.orgId, async (tx) =>
      tx.delete(competitionRules).where(eq(competitionRules.id, id)).returning(),
    );
    expect(deleted).toHaveLength(0);

    // A soft delete is an UPDATE, and is blocked by the same policy. Published
    // rules are permanent by design — a rule set is versioned by creating the
    // next one, not by retiring the last.
    const softDeleted = await withOrg(league.orgId, async (tx) =>
      tx
        .update(competitionRules)
        .set({ deletedAt: new Date() })
        .where(eq(competitionRules.id, id))
        .returning(),
    );
    expect(softDeleted).toHaveLength(0);
  });
});

describe('authorization', () => {
  it('refuses a recompute from someone who cannot change the competition', async () => {
    const player = principalFor(league, orgScoped('PLAYER'));
    const error = await catchError(() => recomputeStandings(player, league.stageGroupId));
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('allows a league administrator to force one', async () => {
    const outcome = await recomputeStandings(admin(), league.stageGroupId);
    expect(outcome.snapshotId).not.toBeNull();
    expect(outcome.entryCount).toBe(2);
  });
});

describe('leaderboards', () => {
  beforeEach(async () => {
    await recordMatchEvents(admin(), matchDay.fixtureId, [
      { type: 'GOAL', minute: 10, editionEntryId: league.entryId, personId: league.personId },
      { type: 'GOAL', minute: 25, editionEntryId: league.entryId, personId: league.personId },
      {
        type: 'PENALTY_SCORED',
        period: 'SECOND_HALF',
        minute: 70,
        editionEntryId: league.entryId,
        personId: league.personId,
      },
      {
        type: 'PENALTY_SCORED',
        period: 'PENALTY_SHOOTOUT',
        minute: 120,
        editionEntryId: league.entryId,
        personId: league.personId,
      },
      {
        type: 'OWN_GOAL',
        minute: 55,
        editionEntryId: matchDay.opponentEntryId,
        personId: league.personId,
      },
      {
        type: 'YELLOW_CARD',
        period: 'SECOND_HALF',
        minute: 80,
        editionEntryId: league.entryId,
        personId: league.personId,
      },
    ]);
  });

  it('counts goals and penalties, and not shootouts or own goals', async () => {
    // Three real goals: two open play, one penalty. The shootout conversion and
    // the own goal are excluded — the two mistakes that quietly hand somebody
    // the wrong Golden Boot.
    const scorers = await listScorers(league.orgId);
    expect(scorers).toHaveLength(1);
    expect(scorers[0]).toMatchObject({ goals: 3, penalties: 1 });
  });

  it('drops a goal that was retracted', async () => {
    const before = await listScorers(league.orgId);
    const events = await withOrg(league.orgId, async (tx) =>
      tx.execute(`SELECT id FROM match_events WHERE type = 'GOAL' LIMIT 1`),
    );
    const goalId = (events.rows[0] as { id: string }).id;

    await retractMatchEvent(admin(), goalId, 'Awarded to the wrong player.');

    const after = await listScorers(league.orgId);
    expect(before[0]?.goals).toBe(3);
    expect(after[0]?.goals).toBe(2);
  });

  it('reports cards', async () => {
    const discipline = await listDiscipline(league.orgId);
    expect(discipline[0]).toMatchObject({ yellowCards: 1, redCards: 0 });
  });

  it('scopes to a season', async () => {
    const inSeason = await listScorers(league.orgId, { seasonId: league.seasonId });
    const elsewhere = await listScorers(league.orgId, {
      seasonId: '00000000-0000-7000-8000-000000000099',
    });
    expect(inSeason).toHaveLength(1);
    expect(elsewhere).toHaveLength(0);
  });

  it('shows one league nothing of another league\'s scorers', async () => {
    const bravo = await createLeagueFixture('bravo');
    expect(await listScorers(bravo.orgId)).toHaveLength(0);
  });
});
