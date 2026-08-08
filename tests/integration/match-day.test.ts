import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { formatKickoffTime, NonExistentLocalTimeError } from '@/lib/time';
import { ForbiddenError } from '@/server/authz/can';
import { scoringEvents } from '@/server/match/events';
import { importFixturesFromCsv } from '@/server/services/fixture-import';
import {
  getFixture,
  listFixtureChanges,
  listFixtures,
  rescheduleFixture,
  scheduleFixture,
  setFixtureStatus,
} from '@/server/services/fixtures';
import { getMatchReport, recordMatchEvents, retractMatchEvent, submitResult } from '@/server/services/results';
import { closeVenue, createVenue, listClosuresInForce, listVenues } from '@/server/services/venues';
import { NotFoundError, ValidationError } from '@/server/services/errors';
import {
  closeFixtures,
  createLeagueFixture,
  createMatchDayFixture,
  type LeagueFixture,
  type MatchDayFixture,
  truncateAll,
} from '../helpers/fixtures';
import { leagueAdmin, orgScoped, principalFor, teamScoped } from '../helpers/principals';

/**
 * Phase 3 end to end, through the real services against a real PostgreSQL with
 * row-level security switched on and the application connecting as `app_user`.
 *
 * The fixtures are created by a superuser so both leagues genuinely exist;
 * every assertion below runs through the ordinary application path.
 */

let league: LeagueFixture;
let matchDay: MatchDayFixture;

beforeEach(async () => {
  await truncateAll();
  league = await createLeagueFixture('alpha');
  matchDay = await createMatchDayFixture(league);
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

describe('scheduling a fixture', () => {
  it('stores the local kickoff as the correct UTC instant', async () => {
    // 8 March 2026 is the morning the clocks go forward in Vancouver, so a
    // 14:00 kickoff that day is 21:00Z and not 22:00Z.
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
      venueId: matchDay.venueId,
      kickoffLocal: '2026-03-08T14:00',
    });

    expect(created.kickoffAt?.toISOString()).toBe('2026-03-08T21:00:00.000Z');

    // And it renders back as what was typed, which is the property that
    // actually matters to a player reading the schedule.
    const stored = await getFixture(league.orgId, created.id);
    expect(stored?.kickoffAt).not.toBeNull();
    expect(formatKickoffTime(stored!.kickoffAt!, 'America/Vancouver')).toBe('14:00');
  });

  it('stores the same wall-clock time an hour differently the week before', async () => {
    const before = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
      kickoffLocal: '2026-03-01T14:00',
    });
    expect(before.kickoffAt?.toISOString()).toBe('2026-03-01T22:00:00.000Z');
  });

  it('refuses a kickoff at a local time that does not exist', async () => {
    const error = await catchError(() =>
      scheduleFixture(admin(), {
        stageGroupId: league.stageGroupId,
        homeEntryId: league.entryId,
        awayEntryId: matchDay.opponentEntryId,
        kickoffLocal: '2026-03-08T02:30',
      }),
    );
    expect(error).toBeInstanceOf(NonExistentLocalTimeError);
  });

  it('leaves a SCHEDULED change row, so the fixture has a history from the start', async () => {
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
      kickoffLocal: '2026-04-11T14:00',
      reason: 'Season schedule published.',
    });

    const changes = await listFixtureChanges(league.orgId, created.id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ kind: 'SCHEDULED', reason: 'Season schedule published.' });
    expect(changes[0]?.changedByPersonId).toBe(league.personId);
  });

  it('refuses a team that is not entered in that competition', async () => {
    const other = await createLeagueFixture('bravo');
    // A cross-league entry id is unreachable by RLS, so this proves the
    // within-league version: an entry that exists but in another edition.
    const error = await catchError(() =>
      scheduleFixture(admin(), {
        stageGroupId: league.stageGroupId,
        homeEntryId: league.entryId,
        awayEntryId: other.entryId,
      }),
    );
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it('refuses a team playing itself', async () => {
    const error = await catchError(() =>
      scheduleFixture(admin(), {
        stageGroupId: league.stageGroupId,
        homeEntryId: league.entryId,
        awayEntryId: league.entryId,
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('allows a cup round with the teams still unknown', async () => {
    // Rounds are scheduled — pitch, date, time — before anyone has qualified.
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      venueId: matchDay.venueId,
      kickoffLocal: '2026-05-16T11:00',
      round: 2,
    });

    const stored = await getFixture(league.orgId, created.id);
    expect(stored?.homeEntryId).toBeNull();
    expect(stored?.venueName).toBe('alpha Park');
  });

  it('refuses to schedule at a venue that does not exist', async () => {
    const error = await catchError(() =>
      scheduleFixture(admin(), {
        stageGroupId: league.stageGroupId,
        venueId: '00000000-0000-7000-8000-0000000000ff',
      }),
    );
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it('refuses an unauthorized caller before touching the database', async () => {
    const player = principalFor(league, orgScoped('PLAYER'));
    const error = await catchError(() =>
      scheduleFixture(player, { stageGroupId: league.stageGroupId }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });
});

describe('rescheduling leaves evidence', () => {
  it('records what it moved from and to', async () => {
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
      kickoffLocal: '2026-04-11T14:00',
    });

    await rescheduleFixture(admin(), {
      fixtureId: created.id,
      kickoffLocal: '2026-04-12T11:00',
      reason: 'Pitch unplayable on the Saturday.',
    });

    const changes = await listFixtureChanges(league.orgId, created.id);
    expect(changes.map((c) => c.kind)).toEqual(['SCHEDULED', 'RESCHEDULED']);

    const move = changes[1];
    expect(move?.previousKickoffAt?.toISOString()).toBe('2026-04-11T21:00:00.000Z');
    expect(move?.newKickoffAt?.toISOString()).toBe('2026-04-12T18:00:00.000Z');
    expect(move?.reason).toBe('Pitch unplayable on the Saturday.');
  });

  it('writes one row per aspect when both time and venue move', async () => {
    const secondVenue = await createVenue(admin(), { name: 'Reserve Ground' });
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
      kickoffLocal: '2026-04-11T14:00',
      venueId: matchDay.venueId,
    });

    await rescheduleFixture(admin(), {
      fixtureId: created.id,
      kickoffLocal: '2026-04-11T16:00',
      venueId: secondVenue.id,
      reason: 'Double-booked.',
    });

    const kinds = (await listFixtureChanges(league.orgId, created.id)).map((c) => c.kind);
    expect(kinds).toEqual(['SCHEDULED', 'RESCHEDULED', 'VENUE_CHANGED']);
  });

  it('requires a reason', async () => {
    const created = await scheduleFixture(admin(), { stageGroupId: league.stageGroupId });
    const error = await catchError(() =>
      rescheduleFixture(admin(), {
        fixtureId: created.id,
        kickoffLocal: '2026-04-11T14:00',
        reason: '   ',
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('does not manufacture a change row when nothing actually changed', async () => {
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      kickoffLocal: '2026-04-11T14:00',
    });

    const outcome = await rescheduleFixture(admin(), {
      fixtureId: created.id,
      kickoffLocal: '2026-04-11T14:00',
      reason: 'Re-saved with no edit.',
    });

    expect(outcome.changed).toBe(false);
    expect(await listFixtureChanges(league.orgId, created.id)).toHaveLength(1);
  });

  it('records a postponement, and drops the date with it', async () => {
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      kickoffLocal: '2026-04-11T14:00',
    });

    await setFixtureStatus(admin(), {
      fixtureId: created.id,
      status: 'POSTPONED',
      reason: 'Snow.',
      clearKickoff: true,
      publicNote: 'New date to follow.',
    });

    const stored = await getFixture(league.orgId, created.id);
    expect(stored?.status).toBe('POSTPONED');
    expect(stored?.kickoffAt).toBeNull();

    const change = (await listFixtureChanges(league.orgId, created.id))[1];
    expect(change).toMatchObject({ kind: 'STATUS_CHANGED', previousStatus: 'SCHEDULED', newStatus: 'POSTPONED' });
    expect(change?.previousKickoffAt?.toISOString()).toBe('2026-04-11T21:00:00.000Z');
  });

  it('reports an ambiguous local time rather than silently choosing', async () => {
    const created = await scheduleFixture(admin(), { stageGroupId: league.stageGroupId });
    const outcome = await rescheduleFixture(admin(), {
      fixtureId: created.id,
      // 01:30 on 1 November 2026 happens twice in Vancouver.
      kickoffLocal: '2026-11-01T01:30',
      reason: 'Testing the boundary.',
    });

    expect(outcome.kickoffAmbiguity?.kind).toBe('AMBIGUOUS');
    expect(outcome.kickoffAmbiguity?.instant.toISOString()).toBe('2026-11-01T08:30:00.000Z');
  });
});

describe('submitting a result', () => {
  let fixtureId: string;

  beforeEach(async () => {
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
      kickoffLocal: '2026-04-11T14:00',
    });
    fixtureId = created.id;
  });

  it('confirms a single submission from the league office', async () => {
    const { result } = await submitResult(admin(), {
      fixtureId,
      source: 'LEAGUE_ADMIN',
      homeScore: 2,
      awayScore: 1,
    });

    expect(result.state).toBe('CONFIRMED');
    expect(result.scoreline).toMatchObject({ homeScore: 2, awayScore: 1 });
  });

  it('surfaces a disagreement between the two clubs instead of picking one', async () => {
    const homeManager = principalFor(league, teamScoped('TEAM_MANAGER', league.teamId));
    const awayManager = principalFor(
      league,
      teamScoped('TEAM_MANAGER', matchDay.opponentTeamId),
    );

    await submitResult(homeManager, { fixtureId, source: 'HOME_TEAM', homeScore: 3, awayScore: 1 });
    const { result } = await submitResult(awayManager, {
      fixtureId,
      source: 'AWAY_TEAM',
      homeScore: 1,
      awayScore: 1,
    });

    expect(result.state).toBe('DISPUTED');
    expect(result.scoreline).toBeNull();
    expect(result.conflicting).toHaveLength(2);
  });

  it('is settled once the league office rules on it', async () => {
    const homeManager = principalFor(league, teamScoped('TEAM_MANAGER', league.teamId));
    await submitResult(homeManager, { fixtureId, source: 'HOME_TEAM', homeScore: 3, awayScore: 1 });

    const { result } = await submitResult(admin(), {
      fixtureId,
      source: 'LEAGUE_ADMIN',
      homeScore: 1,
      awayScore: 1,
    });
    expect(result.state).toBe('CONFIRMED');
    expect(result.scoreline).toMatchObject({ homeScore: 1, awayScore: 1 });
  });

  it('keeps the original claim readable after a correction', async () => {
    const first = await submitResult(admin(), {
      fixtureId,
      source: 'REFEREE',
      homeScore: 2,
      awayScore: 1,
    });
    await submitResult(admin(), {
      fixtureId,
      source: 'REFEREE',
      homeScore: 2,
      awayScore: 2,
      supersedesId: first.id,
      reason: 'Second-half equaliser missed off the card.',
    });

    const report = await getMatchReport(league.orgId, fixtureId);
    expect(report.result.scoreline).toMatchObject({ homeScore: 2, awayScore: 2 });
    // The superseded row is still there — the first question in any protest is
    // "what did they originally say".
    expect(report.submissions).toHaveLength(2);
    expect(report.submissions[0]).toMatchObject({ homeScore: 2, awayScore: 1 });
    expect(report.result.supersededIds).toEqual([first.id]);
  });

  it('refuses to correct a submission that has already been corrected', async () => {
    const first = await submitResult(admin(), {
      fixtureId,
      source: 'REFEREE',
      homeScore: 1,
      awayScore: 0,
    });
    await submitResult(admin(), {
      fixtureId,
      source: 'REFEREE',
      homeScore: 2,
      awayScore: 0,
      supersedesId: first.id,
      reason: 'First correction.',
    });

    const error = await catchError(() =>
      submitResult(admin(), {
        fixtureId,
        source: 'REFEREE',
        homeScore: 3,
        awayScore: 0,
        supersedesId: first.id,
        reason: 'Second correction of the same row.',
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('requires a reason for a correction', async () => {
    const first = await submitResult(admin(), {
      fixtureId,
      source: 'REFEREE',
      homeScore: 1,
      awayScore: 0,
    });
    const error = await catchError(() =>
      submitResult(admin(), {
        fixtureId,
        source: 'REFEREE',
        homeScore: 2,
        awayScore: 0,
        supersedesId: first.id,
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('refuses a result for a fixture whose teams are not both known', async () => {
    const blank = await scheduleFixture(admin(), { stageGroupId: league.stageGroupId, round: 2 });
    const error = await catchError(() =>
      submitResult(admin(), { fixtureId: blank.id, source: 'LEAGUE_ADMIN', homeScore: 1, awayScore: 0 }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('refuses half a scoreline', async () => {
    const error = await catchError(() =>
      submitResult(admin(), { fixtureId, source: 'LEAGUE_ADMIN', homeScore: 3, awayScore: null }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe('who may report a score', () => {
  let fixtureId: string;

  beforeEach(async () => {
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
    });
    fixtureId = created.id;
  });

  it('lets the home team report as the home team', async () => {
    const manager = principalFor(league, teamScoped('TEAM_MANAGER', league.teamId));
    const { result } = await submitResult(manager, {
      fixtureId,
      source: 'HOME_TEAM',
      homeScore: 2,
      awayScore: 0,
    });
    expect(result.state).toBe('CONFIRMED');
  });

  it('stops a club submitting as the referee', async () => {
    // The direct attack on the append-only design: claim a higher authority
    // and the resolver will faithfully honour it. The source is derived from
    // the caller's scope rather than trusted.
    const manager = principalFor(league, teamScoped('TEAM_MANAGER', league.teamId));
    const error = await catchError(() =>
      submitResult(manager, { fixtureId, source: 'REFEREE', homeScore: 9, awayScore: 0 }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toMatch(/HOME_TEAM/);
  });

  it('stops the home team submitting as the away team', async () => {
    const manager = principalFor(league, teamScoped('TEAM_MANAGER', league.teamId));
    const error = await catchError(() =>
      submitResult(manager, { fixtureId, source: 'AWAY_TEAM', homeScore: 0, awayScore: 9 }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('stops a team that is not playing in the fixture reporting at all', async () => {
    const outsider = principalFor(
      league,
      teamScoped('TEAM_MANAGER', '55555555-5555-7555-8555-555555555555'),
    );
    const error = await catchError(() =>
      submitResult(outsider, { fixtureId, source: 'HOME_TEAM', homeScore: 1, awayScore: 0 }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as Error).message).toMatch(/not involved/);
  });

  it('stops a player reporting anything', async () => {
    const player = principalFor(league, orgScoped('PLAYER'));
    const error = await catchError(() =>
      submitResult(player, { fixtureId, source: 'HOME_TEAM', homeScore: 1, awayScore: 0 }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('stops a league administrator without a second factor', async () => {
    const unenrolled = principalFor(league, orgScoped('LEAGUE_ADMIN'), { mfaSatisfied: false });
    const error = await catchError(() =>
      submitResult(unenrolled, { fixtureId, source: 'LEAGUE_ADMIN', homeScore: 1, awayScore: 0 }),
    );
    expect(error).toBeInstanceOf(ForbiddenError);
  });
});

describe('match events', () => {
  let fixtureId: string;

  beforeEach(async () => {
    const created = await scheduleFixture(admin(), {
      stageGroupId: league.stageGroupId,
      homeEntryId: league.entryId,
      awayEntryId: matchDay.opponentEntryId,
    });
    fixtureId = created.id;
  });

  it('records goals and cards against the right side', async () => {
    await recordMatchEvents(admin(), fixtureId, [
      { type: 'GOAL', minute: 12, editionEntryId: league.entryId, personId: league.personId },
      { type: 'YELLOW_CARD', minute: 40, editionEntryId: matchDay.opponentEntryId },
      { type: 'GOAL', period: 'SECOND_HALF', minute: 78, editionEntryId: matchDay.opponentEntryId },
    ]);

    const report = await getMatchReport(league.orgId, fixtureId);
    expect(report.events).toHaveLength(3);
    expect(report.events.map((e) => e.minute)).toEqual([12, 40, 78]);
  });

  it('does not count a shootout conversion as a goal', async () => {
    await recordMatchEvents(admin(), fixtureId, [
      { type: 'PENALTY_SCORED', period: 'SECOND_HALF', minute: 55, editionEntryId: league.entryId },
      {
        type: 'PENALTY_SCORED',
        period: 'PENALTY_SHOOTOUT',
        minute: 120,
        editionEntryId: league.entryId,
      },
    ]);

    const report = await getMatchReport(league.orgId, fixtureId);
    expect(scoringEvents(report.events)).toHaveLength(1);
  });

  it('refuses an event credited to a team not playing in the fixture', async () => {
    const other = await createMatchDayFixture({ ...league, slug: 'charlie' });
    const error = await catchError(() =>
      recordMatchEvents(admin(), fixtureId, [
        { type: 'GOAL', minute: 5, editionEntryId: other.opponentEntryId },
      ]),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('withdraws an event by adding a row, not by deleting one', async () => {
    const { ids } = await recordMatchEvents(admin(), fixtureId, [
      { type: 'RED_CARD', minute: 66, editionEntryId: league.entryId, personId: league.personId },
    ]);
    const [cardId] = ids;
    expect(cardId).toBeDefined();

    await retractMatchEvent(admin(), cardId!, 'Wrong player identified by the referee.');

    const report = await getMatchReport(league.orgId, fixtureId);
    expect(report.events).toHaveLength(0);
  });

  it('refuses to retract the same event twice', async () => {
    const { ids } = await recordMatchEvents(admin(), fixtureId, [
      { type: 'YELLOW_CARD', minute: 20, editionEntryId: league.entryId },
    ]);
    await retractMatchEvent(admin(), ids[0]!, 'First retraction.');
    const error = await catchError(() => retractMatchEvent(admin(), ids[0]!, 'Second.'));
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('refuses an impossible minute', async () => {
    const error = await catchError(() =>
      recordMatchEvents(admin(), fixtureId, [{ type: 'GOAL', minute: 500 }]),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe('venues and closures', () => {
  it('reports a venue as closed only while the closure is in force', async () => {
    await closeVenue(admin(), {
      venueId: matchDay.venueId,
      startsAt: new Date('2026-01-10T00:00:00Z'),
      endsAt: new Date('2026-01-12T00:00:00Z'),
      reason: 'Frozen pitch.',
      source: 'City parks department',
    });

    const during = await listVenues(league.orgId, new Date('2026-01-11T12:00:00Z'));
    expect(during.find((v) => v.id === matchDay.venueId)?.closure?.reason).toBe('Frozen pitch.');

    const after = await listVenues(league.orgId, new Date('2026-01-13T12:00:00Z'));
    expect(after.find((v) => v.id === matchDay.venueId)?.closure).toBeNull();
  });

  it('treats a closure with no end date as still in force', async () => {
    await closeVenue(admin(), {
      venueId: matchDay.venueId,
      startsAt: new Date('2026-01-10T00:00:00Z'),
      reason: 'Reconstruction.',
    });

    const later = await listClosuresInForce(league.orgId, new Date('2027-06-01T00:00:00Z'));
    expect(later).toHaveLength(1);
  });

  it('carries the municipality through to the public listing', async () => {
    const listed = await listVenues(league.orgId);
    expect(listed.find((v) => v.id === matchDay.venueId)?.municipalityName).toBe('alpha City');
  });

  it('refuses a closure that ends before it starts', async () => {
    const error = await catchError(() =>
      closeVenue(admin(), {
        venueId: matchDay.venueId,
        startsAt: new Date('2026-01-12T00:00:00Z'),
        endsAt: new Date('2026-01-10T00:00:00Z'),
        reason: 'Backwards.',
      }),
    );
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe('bulk import from CSV', () => {
  const header = 'competition,group,home,away,date,time,venue\n';
  const row = (
    home: string,
    away: string,
    date = '2026-04-11',
    time = '14:00',
  ) => `Premier Division,Table,${home},${away},${date},${time},alpha Park\n`;

  /**
   * The return leg. The seeded fixture is alpha FC at home to alpha Athletic,
   * so importing that pairing again is correctly treated as a duplicate — the
   * reverse pairing is a genuinely different match.
   */
  const returnLeg = (date = '2026-04-11', time = '14:00') =>
    row('alpha Athletic', 'alpha FC', date, time);

  it('reports what it would do and writes nothing on a dry run', async () => {
    const report = await importFixturesFromCsv(admin(), header + returnLeg(), { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.created).toBe(1);
    expect(report.errors).toBe(0);
    expect(await listFixtures(league.orgId)).toHaveLength(1); // only the seeded one
  });

  it('creates the fixtures on a live run, with the right kickoff instant', async () => {
    const report = await importFixturesFromCsv(admin(), header + returnLeg());

    expect(report.created).toBe(1);
    const imported = (await listFixtures(league.orgId)).find(
      (f) => f.kickoffAt?.toISOString() === '2026-04-11T21:00:00.000Z',
    );
    expect(imported).toBeDefined();
    expect(imported?.venueName).toBe('alpha Park');
  });

  it('skips a pairing that is already scheduled, so a re-upload is safe', async () => {
    await importFixturesFromCsv(admin(), header + returnLeg());
    const second = await importFixturesFromCsv(admin(), header + returnLeg());

    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.rows[0]?.message).toMatch(/already scheduled/);
  });

  it('skips a pairing that already existed before the import ran', async () => {
    // The realistic case: the league uploads a full season file over a
    // schedule that was partly entered by hand.
    const report = await importFixturesFromCsv(admin(), header + row('alpha FC', 'alpha Athletic'), {
      dryRun: true,
    });
    expect(report.skipped).toBe(1);
    expect(report.created).toBe(0);
  });

  it('skips a pairing repeated twice within one file', async () => {
    const report = await importFixturesFromCsv(admin(), header + returnLeg() + returnLeg(), {
      dryRun: true,
    });
    expect(report.created).toBe(1);
    expect(report.skipped).toBe(1);
  });

  it('imports nothing at all when any row is bad', async () => {
    const csv = header + returnLeg() + row('alpha FC', 'Nonexistent Rovers');

    const report = await importFixturesFromCsv(admin(), csv);
    expect(report.errors).toBe(2); // the bad row, plus the good one it blocked
    expect(report.created).toBe(0);
    expect(await listFixtures(league.orgId)).toHaveLength(1);
  });

  it('rejects a kickoff on the hour the clocks skip', async () => {
    const report = await importFixturesFromCsv(admin(), header + returnLeg('2026-03-08', '02:30'), {
      dryRun: true,
    });

    expect(report.errors).toBe(1);
    expect(report.rows[0]?.message).toMatch(/does not exist/);
  });

  it('names the line number of every problem at once', async () => {
    const csv =
      header +
      row('Unknown A', 'alpha Athletic') +
      row('alpha FC', 'Unknown B') +
      'Nonexistent Division,Table,alpha FC,alpha Athletic,2026-04-11,14:00,alpha Park\n';

    const report = await importFixturesFromCsv(admin(), csv, { dryRun: true });
    expect(report.errors).toBe(3);
    expect(report.rows.map((r) => r.line)).toEqual([2, 3, 4]);
  });

  it('refuses an unauthorized caller before parsing anything', async () => {
    const player = principalFor(league, orgScoped('PLAYER'));
    const error = await catchError(() => importFixturesFromCsv(player, 'nonsense'));
    expect(error).toBeInstanceOf(ForbiddenError);
  });
});
