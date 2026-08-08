import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  competitionEditions,
  competitionRules,
  editionEntries,
  fixtures,
  matchEvents,
  resultSubmissions,
  stageGroupEntries,
  stageGroups,
  stages,
  standingsRows,
  standingsSnapshots,
  teams,
} from '@/db/schema';
import { disciplinaryEvents, type MatchEventType } from '@/server/match/events';
import { resolveResult } from '@/server/match/result';
import {
  computeStandings,
  DEFAULT_RULES,
  disciplinePointsFor,
  type EntryStatus,
  type StandingsEntry,
  type StandingsFixture,
  type StandingsRules,
  type TieBreaker,
} from './engine';

/**
 * Reads the facts, runs the engine, stores the conclusion.
 *
 * ── WHY THIS IS NOT IN src/server/services ──────────────────────────────────
 * Everything under `services/` is required by `npm run guard` to consult the
 * permission matrix before writing, and that rule is right for anything a user
 * asks for. This is not that. Recomputing a table is a DERIVATION from facts
 * whose authorization already happened when they were written — a team manager
 * who was permitted to submit a score does not need a second permission for the
 * table to reflect it, and requiring one would mean the table silently stops
 * updating for exactly the people most likely to submit results.
 *
 * So the authorized entry point lives in `services/standings.ts`, and this is
 * the primitive it calls. The distinction is the same one `src/server/audit`
 * makes, and it is deliberate rather than a way around the guard.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Must be called inside `withOrg`. Every query below relies on RLS for its
 * league filter.
 */

export interface RecomputeOutcome {
  snapshotId: string | null;
  stageGroupId: string;
  entryCount: number;
  fixturesCounted: number;
  fixturesDisputed: number;
  fixturesOutstanding: number;
  requiresManualResolution: boolean;
}

export async function recomputeStandingsWithin(
  tx: Tx,
  orgId: OrgId,
  stageGroupId: string,
): Promise<RecomputeOutcome> {
  const { rules, rulesId } = await resolveRules(tx, stageGroupId);

  const entryRows = await tx
    .select({
      entryId: editionEntries.id,
      teamName: teams.name,
      status: editionEntries.status,
      pointsAdjustment: editionEntries.pointsAdjustment,
    })
    .from(stageGroupEntries)
    .innerJoin(editionEntries, eq(stageGroupEntries.editionEntryId, editionEntries.id))
    .innerJoin(teams, eq(editionEntries.teamId, teams.id))
    .where(
      and(
        eq(stageGroupEntries.stageGroupId, stageGroupId),
        isNull(stageGroupEntries.deletedAt),
        isNull(editionEntries.deletedAt),
      ),
    );

  const empty: RecomputeOutcome = {
    snapshotId: null,
    stageGroupId,
    entryCount: 0,
    fixturesCounted: 0,
    fixturesDisputed: 0,
    fixturesOutstanding: 0,
    requiresManualResolution: false,
  };
  // A group with nobody in it has no table. Writing an empty snapshot would
  // just be a row that says nothing.
  if (entryRows.length === 0) return empty;

  const fixtureRows = await tx
    .select({
      fixtureId: fixtures.id,
      homeEntryId: fixtures.homeEntryId,
      awayEntryId: fixtures.awayEntryId,
      kickoffAt: fixtures.kickoffAt,
    })
    .from(fixtures)
    .where(and(eq(fixtures.stageGroupId, stageGroupId), isNull(fixtures.deletedAt)));

  const fixtureIds = fixtureRows.map((f) => f.fixtureId);

  const submissions = fixtureIds.length
    ? await tx
        .select()
        .from(resultSubmissions)
        .where(inArray(resultSubmissions.fixtureId, fixtureIds))
    : [];

  const events = fixtureIds.length
    ? await tx
        .select({
          id: matchEvents.id,
          type: matchEvents.type,
          period: matchEvents.period,
          minute: matchEvents.minute,
          stoppageMinute: matchEvents.stoppageMinute,
          editionEntryId: matchEvents.editionEntryId,
          personId: matchEvents.personId,
          retractsEventId: matchEvents.retractsEventId,
        })
        .from(matchEvents)
        .where(inArray(matchEvents.fixtureId, fixtureIds))
    : [];

  const submissionsByFixture = new Map<string, (typeof submissions)[number][]>();
  let resultsThrough: Date | null = null;
  for (const submission of submissions) {
    const list = submissionsByFixture.get(submission.fixtureId);
    if (list) list.push(submission);
    else submissionsByFixture.set(submission.fixtureId, [submission]);
    if (!resultsThrough || submission.createdAt > resultsThrough) {
      resultsThrough = submission.createdAt;
    }
  }

  // Discipline points, from cards that still stand.
  const cardsByEntry = new Map<string, { type: MatchEventType }[]>();
  for (const event of disciplinaryEvents(
    events.map((e) => ({ ...e, type: e.type as MatchEventType, period: e.period as never })),
  )) {
    if (!event.editionEntryId) continue;
    const list = cardsByEntry.get(event.editionEntryId);
    if (list) list.push({ type: event.type });
    else cardsByEntry.set(event.editionEntryId, [{ type: event.type }]);
  }

  const entries: StandingsEntry[] = entryRows.map((row) => ({
    entryId: row.entryId,
    teamName: row.teamName,
    status: row.status as EntryStatus,
    pointsAdjustment: row.pointsAdjustment,
    disciplinePoints: disciplinePointsFor(cardsByEntry.get(row.entryId) ?? [], rules),
  }));

  const engineFixtures: StandingsFixture[] = fixtureRows
    // A fixture with a side still unknown — an unfilled cup round — cannot
    // contribute to anyone's record.
    .filter((f) => f.homeEntryId !== null && f.awayEntryId !== null)
    .map((f) => {
      const resolved = resolveResult(submissionsByFixture.get(f.fixtureId) ?? []);
      return {
        fixtureId: f.fixtureId,
        homeEntryId: f.homeEntryId as string,
        awayEntryId: f.awayEntryId as string,
        kickoffAt: f.kickoffAt,
        resultState: resolved.state,
        homeScore: resolved.scoreline?.homeScore ?? null,
        awayScore: resolved.scoreline?.awayScore ?? null,
        homeForfeit: resolved.scoreline?.homeForfeit ?? false,
        awayForfeit: resolved.scoreline?.awayForfeit ?? false,
      };
    });

  const table = computeStandings(entries, engineFixtures, rules);

  const [snapshot] = await tx
    .insert(standingsSnapshots)
    .values({
      orgId,
      stageGroupId,
      rulesId,
      resultsThrough,
      fixturesCounted: table.fixturesCounted,
      fixturesDisputed: table.fixturesDisputed,
      fixturesOutstanding: table.fixturesOutstanding,
      requiresManualResolution: table.requiresManualResolution,
    })
    .returning({ id: standingsSnapshots.id });

  if (!snapshot) throw new Error('standings snapshot insert returned no row');

  if (table.rows.length > 0) {
    await tx.insert(standingsRows).values(
      table.rows.map((row) => ({
        orgId,
        snapshotId: snapshot.id,
        editionEntryId: row.entryId,
        position: row.position,
        played: row.played,
        won: row.won,
        drawn: row.drawn,
        lost: row.lost,
        goalsFor: row.goalsFor,
        goalsAgainst: row.goalsAgainst,
        goalDifference: row.goalDifference,
        pointsEarned: row.pointsEarned,
        pointsAdjustment: row.pointsAdjustment,
        points: row.points,
        disciplinePoints: row.disciplinePoints,
        form: row.form,
        basis: row.basis,
        requiresManualResolution: row.requiresManualResolution,
      })),
    );
  }

  return {
    snapshotId: snapshot.id,
    stageGroupId,
    entryCount: entries.length,
    fixturesCounted: table.fixturesCounted,
    fixturesDisputed: table.fixturesDisputed,
    fixturesOutstanding: table.fixturesOutstanding,
    requiresManualResolution: table.requiresManualResolution,
  };
}

/** Every group a fixture's result could have changed. */
export async function stageGroupsForFixtures(
  tx: Tx,
  fixtureIds: readonly string[],
): Promise<string[]> {
  if (fixtureIds.length === 0) return [];
  const rows = await tx
    .select({ stageGroupId: fixtures.stageGroupId })
    .from(fixtures)
    .where(inArray(fixtures.id, [...fixtureIds]));
  return [...new Set(rows.map((r) => r.stageGroupId))];
}

/**
 * Which rules apply here: the stage's own, else the edition's, else the
 * built-in defaults.
 *
 * The fallback is deliberate and worth stating. A league that has not
 * configured anything still gets a correct table under three-points-for-a-win,
 * rather than an error or an empty page — and the snapshot records a null
 * `rulesId`, so it is visible that nothing was configured rather than looking
 * like a deliberate choice.
 */
export async function resolveRules(
  tx: Tx,
  stageGroupId: string,
): Promise<{ rules: StandingsRules; rulesId: string | null }> {
  const [row] = await tx
    .select({
      stageRulesId: stages.rulesId,
      editionRulesId: competitionEditions.rulesId,
    })
    .from(stageGroups)
    .innerJoin(stages, eq(stageGroups.stageId, stages.id))
    .innerJoin(competitionEditions, eq(stages.editionId, competitionEditions.id))
    .where(eq(stageGroups.id, stageGroupId));

  const rulesId = row?.stageRulesId ?? row?.editionRulesId ?? null;
  if (!rulesId) return { rules: DEFAULT_RULES, rulesId: null };

  const [rules] = await tx
    .select()
    .from(competitionRules)
    .where(and(eq(competitionRules.id, rulesId), isNull(competitionRules.deletedAt)));

  if (!rules) return { rules: DEFAULT_RULES, rulesId: null };

  return {
    rulesId: rules.id,
    rules: {
      pointsForWin: rules.pointsForWin,
      pointsForDraw: rules.pointsForDraw,
      pointsForLoss: rules.pointsForLoss,
      tieBreakers: rules.tieBreakers as TieBreaker[],
      forfeitWinnerGoals: rules.forfeitWinnerGoals,
      forfeitLoserGoals: rules.forfeitLoserGoals,
      forfeitCountsAsPlayed: rules.forfeitCountsAsPlayed,
      yellowCardPoints: rules.yellowCardPoints,
      redCardPoints: rules.redCardPoints,
    },
  };
}
