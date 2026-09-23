import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withOrg } from '@/db';
import { clubs, entityAliases, stageGroupEntries, teams } from '@/db/schema';
import { ForbiddenError } from '@/server/authz/can';
import { ImportFormatError } from '@/server/import/format';
import { listHonoursBoard } from '@/server/services/competition';
import { listFixtures } from '@/server/services/fixtures';
import { getMatchReport } from '@/server/services/results';
import { getStandings } from '@/server/services/standings';
import {
  checkImportedStandings,
  confirmMatch,
  discardBatch,
  listReviewQueue,
  listStagedStandings,
  promoteImport,
  rejectMatch,
  resolveImport,
  stageImport,
} from '@/server/services/import';
import { ValidationError } from '@/server/services/errors';
import {
  closeFixtures,
  createLeagueFixture,
  type LeagueFixture,
  truncateAll,
} from '../helpers/fixtures';
import { leagueAdmin, orgScoped, principalFor } from '../helpers/principals';

/**
 * The historical import, end to end.
 *
 * The property under test throughout: nothing is merged without a person
 * saying so. A silent merge destroys the evidence that two clubs were ever
 * separate, which makes it the one failure here that cannot be found later.
 */

let league: LeagueFixture;

beforeEach(async () => {
  await truncateAll();
  league = await createLeagueFixture('alpha');
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

/**
 * The league fixture already contains a club called "alpha FC". The export
 * below deliberately spells it three ways: identically, with a suffix, and as
 * something genuinely new.
 */
function exportFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    source: 'legacy-2014-2026.json',
    clubs: [
      { key: 'c1', name: 'alpha FC' },
      { key: 'c2', name: 'Glenmore Athletic', foundedYear: 1981 },
    ],
    teams: [{ key: 't1', name: 'Glenmore Athletic', clubKey: 'c2' }],
    venues: [{ key: 'v1', name: 'Glenmore Recreation Park', surface: 'GRASS' }],
    fixtures: [],
    standings: [],
    honours: [],
    ...overrides,
  });
}

describe('staging', () => {
  it('lands every row without touching anything real', async () => {
    const before = await withOrg(league.orgId, (tx) => tx.select().from(clubs));
    const batch = await stageImport(admin(), exportFile());

    expect(batch.recordsTotal).toBe(4); // 2 clubs, 1 team, 1 venue
    expect(batch.status).toBe('STAGED');

    const after = await withOrg(league.orgId, (tx) => tx.select().from(clubs));
    expect(after).toHaveLength(before.length);
  });

  it('refuses the identical file twice', async () => {
    // Re-uploading is the normal thing to try when an import is being
    // debugged, and doubling a league's clubs is the normal consequence.
    await stageImport(admin(), exportFile());
    const error = await catchError(() => stageImport(admin(), exportFile()));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/already been staged/);
  });

  it('accepts the same file again once the batch is discarded', async () => {
    const batch = await stageImport(admin(), exportFile());
    await discardBatch(admin(), batch.batchId);
    const second = await stageImport(admin(), exportFile());
    expect(second.recordsTotal).toBe(4);
  });

  it('reports every format problem at once, not the first', async () => {
    const error = await catchError(() =>
      stageImport(admin(), JSON.stringify({ version: 1, source: 'x', clubs: [{ name: 'No key' }] })),
    );
    expect(error).toBeInstanceOf(ImportFormatError);
    expect((error as ImportFormatError).issues.length).toBeGreaterThan(0);
  });

  it('rejects a file that is not JSON at all', async () => {
    const error = await catchError(() => stageImport(admin(), 'not json'));
    expect(error).toBeInstanceOf(ImportFormatError);
  });

  it('refuses an unauthorized caller before parsing anything', async () => {
    const player = principalFor(league, orgScoped('PLAYER'));
    const error = await catchError(() => stageImport(player, exportFile()));
    expect(error).toBeInstanceOf(ForbiddenError);
  });
});

describe('resolution', () => {
  it('matches an identical name without asking', async () => {
    const batch = await stageImport(admin(), exportFile());
    const outcome = await resolveImport(admin(), batch.batchId);

    expect(outcome.matched).toBe(1); // "alpha FC" already exists
    expect(outcome.needsReview).toBe(0);
  });

  it('treats a genuinely new name as something to create', async () => {
    const batch = await stageImport(admin(), exportFile());
    const outcome = await resolveImport(admin(), batch.batchId);
    // Glenmore Athletic resembles nothing in a league of one club.
    expect(outcome.createdAsNew).toBeGreaterThanOrEqual(1);
  });

  it('asks a person about a near-miss rather than deciding', async () => {
    // The whole safety property. "alpha FCC" is one character from an existing
    // club, which is exactly when an automatic matcher does its damage.
    const batch = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'alpha FCC' }] }),
    );
    const outcome = await resolveImport(admin(), batch.batchId);

    expect(outcome.needsReview).toBe(1);
    expect(outcome.matched).toBe(0);

    const queue = await listReviewQueue(league.orgId, batch.batchId);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.sourceName).toBe('alpha FCC');
    expect(queue[0]?.candidates[0]?.name).toBe('alpha FC');
  });

  it('does not resolve against an unconfirmed alias', async () => {
    // An alias with no confirmedAt is a PROPOSAL. Using it would defeat the
    // point of having a review step at all.
    await withOrg(league.orgId, async (tx) =>
      tx.insert(entityAliases).values({
        orgId: league.orgId,
        entityKind: 'CLUB',
        alias: 'Alpha Football Club',
        normalizedAlias: 'alpha football club',
        canonicalId: league.clubId,
        confirmedAt: null,
      }),
    );

    const batch = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'Alpha Football Club' }] }),
    );
    const outcome = await resolveImport(admin(), batch.batchId);
    expect(outcome.matched).toBe(0);
  });

  it('resolves instantly against a confirmed alias', async () => {
    await withOrg(league.orgId, async (tx) =>
      tx.insert(entityAliases).values({
        orgId: league.orgId,
        entityKind: 'CLUB',
        alias: 'Alpha Football Club',
        normalizedAlias: 'alpha football club',
        canonicalId: league.clubId,
        confirmedAt: new Date(),
      }),
    );

    const batch = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'Alpha Football Club' }] }),
    );
    const outcome = await resolveImport(admin(), batch.batchId);
    expect(outcome.matched).toBe(1);
  });
});

describe('the review decision is remembered', () => {
  it('confirming a match records a confirmed alias', async () => {
    // The economics of the whole design: the first season is laborious and the
    // remaining eleven are not.
    const batch = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'alpha FCC' }] }),
    );
    await resolveImport(admin(), batch.batchId);
    const [item] = await listReviewQueue(league.orgId, batch.batchId);

    await confirmMatch(admin(), item!.recordId, league.clubId);

    const aliases = await withOrg(league.orgId, (tx) => tx.select().from(entityAliases));
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatchObject({
      alias: 'alpha FCC',
      canonicalId: league.clubId,
      confirmedByPersonId: league.personId,
    });
    expect(aliases[0]?.confirmedAt).not.toBeNull();
  });

  it('refuses a canonical id that was not offered as a candidate', async () => {
    const batch = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'alpha FCC' }] }),
    );
    await resolveImport(admin(), batch.batchId);
    const [item] = await listReviewQueue(league.orgId, batch.batchId);

    const error = await catchError(() => confirmMatch(admin(), item!.recordId, league.teamId));

    expect(error).toBeInstanceOf(ValidationError);
    expect(await listReviewQueue(league.orgId, batch.batchId)).toHaveLength(1);
    expect(await withOrg(league.orgId, (tx) => tx.select().from(entityAliases))).toHaveLength(0);
  });

  it('a confirmed alias resolves the next batch without asking again', async () => {
    const first = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'alpha FCC' }] }),
    );
    await resolveImport(admin(), first.batchId);
    const [item] = await listReviewQueue(league.orgId, first.batchId);
    await confirmMatch(admin(), item!.recordId, league.clubId);

    const second = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'alpha FCC' }], teams: [], venues: [] }),
    );
    const outcome = await resolveImport(admin(), second.batchId);
    expect(outcome.matched).toBe(1);
    expect(outcome.needsReview).toBe(0);
  });

  it('rejecting a match marks the row as new', async () => {
    const batch = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'alpha FCC' }] }),
    );
    await resolveImport(admin(), batch.batchId);
    const [item] = await listReviewQueue(league.orgId, batch.batchId);

    await rejectMatch(admin(), item!.recordId);
    expect(await listReviewQueue(league.orgId, batch.batchId)).toHaveLength(0);
  });
});

describe('promotion', () => {
  it('refuses while anything still needs review', async () => {
    // A half-promoted batch is the state in which somebody re-runs the import
    // and doubles the clubs.
    const batch = await stageImport(
      admin(),
      exportFile({ clubs: [{ key: 'c9', name: 'alpha FCC' }] }),
    );
    await resolveImport(admin(), batch.batchId);

    const outcome = await promoteImport(admin(), batch.batchId);
    expect(outcome.blockedByReview).toBe(1);
    expect(outcome.clubsCreated).toBe(0);
  });

  it('creates what is new and leaves what already existed alone', async () => {
    const batch = await stageImport(admin(), exportFile());
    await resolveImport(admin(), batch.batchId);
    const outcome = await promoteImport(admin(), batch.batchId);

    expect(outcome.clubsCreated).toBe(1); // Glenmore Athletic
    expect(outcome.venuesCreated).toBe(1);
    expect(outcome.teamsCreated).toBe(1);

    const allClubs = await withOrg(league.orgId, (tx) => tx.select().from(clubs));
    // The original plus one — "alpha FC" was matched, not duplicated.
    expect(allClubs).toHaveLength(2);
  });

  it('attaches an imported team to its imported club', async () => {
    const batch = await stageImport(admin(), exportFile());
    await resolveImport(admin(), batch.batchId);
    await promoteImport(admin(), batch.batchId);

    const [team] = await withOrg(league.orgId, (tx) =>
      tx.select().from(teams).where(eq(teams.name, 'Glenmore Athletic')),
    );
    const [club] = await withOrg(league.orgId, (tx) =>
      tx.select().from(clubs).where(eq(clubs.name, 'Glenmore Athletic')),
    );
    expect(team?.clubId).toBe(club?.id);
  });

  it('fails a team whose club was not imported, rather than orphaning it', async () => {
    const batch = await stageImport(
      admin(),
      exportFile({
        clubs: [],
        teams: [{ key: 't9', name: 'Orphan Rovers', clubKey: 'missing' }],
        venues: [],
      }),
    );
    await resolveImport(admin(), batch.batchId);
    const outcome = await promoteImport(admin(), batch.batchId);
    expect(outcome.teamsCreated).toBe(0);
  });

  it('gives two imported clubs of the same name distinct slugs', async () => {
    const batch = await stageImport(
      admin(),
      exportFile({
        clubs: [
          { key: 'c1', name: 'Lakeside Rangers' },
          { key: 'c2', name: 'Lakeside  Rangers' },
        ],
        teams: [],
        venues: [],
      }),
    );
    await resolveImport(admin(), batch.batchId);
    const [item] = await listReviewQueue(league.orgId, batch.batchId);
    if (item) await rejectMatch(admin(), item.recordId);

    await promoteImport(admin(), batch.batchId);
    const slugs = (await withOrg(league.orgId, (tx) => tx.select().from(clubs))).map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('refuses to promote a dry run', async () => {
    const batch = await stageImport(admin(), exportFile(), { dryRun: true });
    await resolveImport(admin(), batch.batchId);
    const error = await catchError(() => promoteImport(admin(), batch.batchId));
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('refuses to promote the same batch twice', async () => {
    const batch = await stageImport(admin(), exportFile());
    await resolveImport(admin(), batch.batchId);
    await promoteImport(admin(), batch.batchId);
    const error = await catchError(() => promoteImport(admin(), batch.batchId));
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('refuses to discard a promoted batch, because that would not undo it', async () => {
    const batch = await stageImport(admin(), exportFile());
    await resolveImport(admin(), batch.batchId);
    await promoteImport(admin(), batch.batchId);
    const error = await catchError(() => discardBatch(admin(), batch.batchId));
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe('promoting fixtures, results and honours', () => {
  /**
   * A tiny season between the two clubs the fixture helper already provides,
   * played in the competition it already provides. The importer deliberately
   * refuses to invent competitions, so the export names an existing one.
   */
  function seasonExport(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: 1,
      source: 'season-2019.json',
      clubs: [{ key: 'c1', name: 'alpha FC' }, { key: 'c2', name: 'Glenmore Athletic' }],
      teams: [
        { key: 't1', name: 'alpha FC', clubKey: 'c1' },
        { key: 't2', name: 'Glenmore Athletic', clubKey: 'c2' },
      ],
      venues: [],
      fixtures: [
        {
          key: 'f1',
          competitionKey: 'Premier Division',
          groupKey: 'Table',
          homeTeamKey: 't1',
          awayTeamKey: 't2',
          date: '2026-04-11',
          time: '14:00',
          homeScore: 3,
          awayScore: 1,
        },
      ],
      standings: [],
      honours: [
        {
          key: 'h1',
          honourName: "The Founders' Trophy",
          recipientName: 'alpha FC',
          awardedOn: '2026-05-10',
        },
      ],
      ...overrides,
    });
  }

  async function runImport(csv = seasonExport()) {
    const batch = await stageImport(admin(), csv);
    await resolveImport(admin(), batch.batchId);
    // "alpha FC" as a TEAM is a near-miss on the existing team of that name.
    for (const item of await listReviewQueue(league.orgId, batch.batchId)) {
      await confirmMatch(admin(), item.recordId, item.candidates[0]!.id);
    }
    return { batch, outcome: await promoteImport(admin(), batch.batchId) };
  }

  it('creates the fixture and its result', async () => {
    const { outcome } = await runImport();
    expect(outcome.fixturesCreated).toBe(1);
    expect(outcome.resultsCreated).toBe(1);

    const created = (await listFixtures(league.orgId)).find(
      (f) => f.kickoffAt?.toISOString() === '2026-04-11T21:00:00.000Z',
    );
    expect(created).toBeDefined();
    expect(created?.result.scoreline).toMatchObject({ homeScore: 3, awayScore: 1 });
  });

  it('records an imported score as IMPORT, below every human source', async () => {
    // A migrated score has no author who can be asked about it, so a club
    // contradicting it later must be surfaced rather than silently overruled.
    const { outcome } = await runImport();
    expect(outcome.fixturesCreated).toBe(1);

    const created = (await listFixtures(league.orgId)).find((f) => f.result.state === 'CONFIRMED');
    const report = await getMatchReport(league.orgId, created!.id);
    expect(report.submissions[0]?.source).toBe('IMPORT');
  });

  it('enters both teams in the competition and places them in the group', async () => {
    // Creating the entry without the group placement gives an imported season
    // whose results exist and whose table is empty.
    await runImport();
    const placements = await withOrg(league.orgId, (tx) =>
      tx.select().from(stageGroupEntries),
    );
    expect(placements.length).toBeGreaterThanOrEqual(2);
  });

  it('computes the table from what it imported', async () => {
    await runImport();
    const table = await getStandings(league.orgId, league.stageGroupId);
    expect(table).not.toBeNull();
    const winner = table?.rows.find((r) => r.teamName === 'alpha FC');
    expect(winner).toMatchObject({ position: 1, points: 3, goalsFor: 3, goalsAgainst: 1 });
  });

  it('records the honour with the name as it was published', async () => {
    const { outcome } = await runImport();
    expect(outcome.honoursCreated).toBe(1);

    const board = await listHonoursBoard(league.orgId);
    const trophy = board.find((h) => h.name === "The Founders' Trophy");
    expect(trophy?.winners[0]?.recipient).toBe('alpha FC');
  });

  it('refuses to invent a competition, and says so', async () => {
    // The deliberate limit: auto-creating competitions from a legacy dump would
    // rebuild the old site's flat dropdown one row at a time.
    const { outcome } = await runImport(
      seasonExport({
        fixtures: [
          {
            key: 'f9',
            competitionKey: 'Division 7',
            homeTeamKey: 't1',
            awayTeamKey: 't2',
          },
        ],
        honours: [],
      }),
    );
    expect(outcome.fixturesCreated).toBe(0);
    expect(outcome.failed).toBe(1);
    expect(outcome.problems[0]).toMatch(/No competition called "Division 7"/);
  });

  it('fails a fixture whose team is not in the batch', async () => {
    const { outcome } = await runImport(
      seasonExport({
        fixtures: [
          {
            key: 'f9',
            competitionKey: 'Premier Division',
            groupKey: 'Table',
            homeTeamKey: 't1',
            awayTeamKey: 'not-in-this-file',
          },
        ],
        honours: [],
      }),
    );
    expect(outcome.fixturesCreated).toBe(0);
    expect(outcome.problems[0]).toMatch(/not in this batch/);
  });

  it('rejects a kickoff on the hour the clocks skip', async () => {
    const { outcome } = await runImport(
      seasonExport({
        fixtures: [
          {
            key: 'f9',
            competitionKey: 'Premier Division',
            groupKey: 'Table',
            homeTeamKey: 't1',
            awayTeamKey: 't2',
            date: '2026-03-08',
            time: '02:30',
          },
        ],
        honours: [],
      }),
    );
    expect(outcome.failed).toBe(1);
    expect(outcome.problems[0]).toMatch(/does not exist/);
  });
});

describe('the recompute-and-diff acceptance test', () => {
  function exportWithStandings(rows: unknown[]): string {
    return JSON.stringify({
      version: 1,
      source: 'season-with-table.json',
      clubs: [{ key: 'c1', name: 'alpha FC' }, { key: 'c2', name: 'Glenmore Athletic' }],
      teams: [
        { key: 't1', name: 'alpha FC', clubKey: 'c1' },
        { key: 't2', name: 'Glenmore Athletic', clubKey: 'c2' },
      ],
      venues: [],
      fixtures: [
        {
          key: 'f1',
          competitionKey: 'Premier Division',
          groupKey: 'Table',
          homeTeamKey: 't1',
          awayTeamKey: 't2',
          homeScore: 3,
          awayScore: 1,
        },
      ],
      standings: [{ key: 's1', competitionKey: 'Premier Division', groupKey: 'Table', rows }],
      honours: [],
    });
  }

  async function importAndCheck(rows: unknown[]) {
    const batch = await stageImport(admin(), exportWithStandings(rows));
    await resolveImport(admin(), batch.batchId);
    for (const item of await listReviewQueue(league.orgId, batch.batchId)) {
      await confirmMatch(admin(), item.recordId, item.candidates[0]!.id);
    }
    await promoteImport(admin(), batch.batchId);
    return checkImportedStandings(league.orgId, batch.batchId);
  }

  it('reports a clean match when our table agrees with theirs', async () => {
    const checks = await importAndCheck([
      { teamName: 'alpha FC', position: 1, played: 1, won: 1, points: 3, goalsFor: 3, goalsAgainst: 1 },
      { teamName: 'Glenmore Athletic', position: 2, played: 1, lost: 1, points: 0, goalsFor: 1, goalsAgainst: 3 },
    ]);

    expect(checks).toHaveLength(1);
    expect(checks[0]?.matches).toBe(true);
    expect(checks[0]?.hints[0]).toMatch(/matches the published one exactly/);
  });

  it('names the disagreement and points at the likely cause', async () => {
    // Points differ while the results agree — the signature of a deduction the
    // source applied that we have not imported.
    const checks = await importAndCheck([
      { teamName: 'alpha FC', position: 1, played: 1, won: 1, points: 6, goalsFor: 3, goalsAgainst: 1 },
      { teamName: 'Glenmore Athletic', position: 2, played: 1, lost: 1, points: 0, goalsFor: 1, goalsAgainst: 3 },
    ]);

    expect(checks[0]?.matches).toBe(false);
    expect(checks[0]?.summary.join(' ')).toMatch(/we computed 3, the source published 6/);
    expect(checks[0]?.hints.join(' ')).toMatch(/points deduction/);
  });

  it('cannot compare a competition that does not exist here', async () => {
    const batch = await stageImport(
      admin(),
      JSON.stringify({
        version: 1,
        source: 'orphan.json',
        clubs: [],
        teams: [],
        venues: [],
        fixtures: [],
        standings: [
          { key: 's1', competitionKey: 'Division 9', rows: [{ teamName: 'Anyone', points: 1 }] },
        ],
        honours: [],
      }),
    );
    await resolveImport(admin(), batch.batchId);
    await promoteImport(admin(), batch.batchId);

    const checks = await checkImportedStandings(league.orgId, batch.batchId);
    expect(checks[0]?.resolved).toBe(false);
    expect(checks[0]?.matches).toBe(false);
  });
});

describe('the source\'s own tables are kept for the diff', () => {
  it('stages a published standing verbatim', async () => {
    const batch = await stageImport(
      admin(),
      exportFile({
        standings: [
          {
            key: 's1',
            competitionKey: 'premier-2019',
            rows: [
              { teamName: 'alpha FC', position: 1, played: 18, points: 40 },
              { teamName: 'Glenmore Athletic', position: 2, played: 18, points: 38 },
            ],
          },
        ],
      }),
    );

    const staged = await listStagedStandings(league.orgId, batch.batchId);
    expect(staged).toHaveLength(1);
    const payload = staged[0]?.payload as { rows: { teamName: string; points: number }[] };
    expect(payload.rows[0]).toMatchObject({ teamName: 'alpha FC', points: 40 });
  });
});

describe('leagues cannot see each other\'s imports', () => {
  it('stages into the importing league only', async () => {
    const bravo = await createLeagueFixture('bravo');
    await stageImport(admin(), exportFile());

    const bravoBatches = await withOrg(bravo.orgId, (tx) =>
      tx.select().from(entityAliases),
    );
    expect(bravoBatches).toHaveLength(0);

    const error = await catchError(() =>
      listReviewQueue(bravo.orgId, '00000000-0000-7000-8000-0000000000aa'),
    );
    // A batch id from another league resolves to nothing rather than to rows.
    expect(error).toBeUndefined();
  });
});
