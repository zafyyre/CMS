import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { type Tx, withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  competitionEditions,
  editionEntries,
  stageGroups,
  stages,
  standingsRows,
  standingsSnapshots,
  teams,
} from '@/db/schema';
import { recordAudit } from '@/server/audit/record';
import { assertCan } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import { recomputeStandingsWithin, type RecomputeOutcome } from '@/server/standings/recompute';
import { NotFoundError } from './errors';

/**
 * Reading and rebuilding league tables.
 *
 * The read path serves the most-visited page this product will ever have —
 * standings, on a phone, at the side of a pitch, by several thousand people
 * within the same twenty minutes on a Sunday evening. So it reads a stored
 * snapshot rather than deriving ninety fixtures per request.
 *
 * The write path is `recomputeStandings`, and it is authorized as a change to
 * the competition. The derivation itself is not a user action and lives in
 * `src/server/standings/recompute.ts` — see the note there.
 */

export interface StandingsTableRow {
  entryId: string;
  teamId: string;
  teamName: string;
  teamSlug: string;
  position: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  pointsEarned: number;
  pointsAdjustment: number;
  points: number;
  disciplinePoints: number;
  form: ('W' | 'D' | 'L')[];
  basis: string;
  requiresManualResolution: boolean;
}

export interface StandingsView {
  stageGroupId: string;
  stageGroupName: string;
  stageName: string;
  editionId: string;
  computedAt: Date;
  resultsThrough: Date | null;
  fixturesCounted: number;
  fixturesDisputed: number;
  fixturesOutstanding: number;
  requiresManualResolution: boolean;
  rows: StandingsTableRow[];
}

// --- reads -------------------------------------------------------------------

/**
 * The current table for one group, or null if it has never been computed.
 *
 * "Never been computed" is returned rather than computed on demand, because a
 * read path that can write is a read path that can deadlock under the Sunday
 * evening load this page exists for.
 */
export async function getStandings(
  orgId: OrgId,
  stageGroupId: string,
): Promise<StandingsView | null> {
  return withOrg(orgId, (tx) => selectStandings(tx, stageGroupId));
}

/** Every group's table in one competition, in stage then group order. */
export async function listEditionStandings(
  orgId: OrgId,
  editionId: string,
): Promise<StandingsView[]> {
  return withOrg(orgId, async (tx) => {
    const groups = await tx
      .select({ id: stageGroups.id })
      .from(stageGroups)
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .where(
        and(
          eq(stages.editionId, editionId),
          isNull(stageGroups.deletedAt),
          isNull(stages.deletedAt),
        ),
      )
      .orderBy(asc(stages.ordinal), asc(stageGroups.ordinal));

    const views: StandingsView[] = [];
    for (const group of groups) {
      const view = await selectStandings(tx, group.id);
      if (view) views.push(view);
    }
    return views;
  });
}

async function selectStandings(tx: Tx, stageGroupId: string): Promise<StandingsView | null> {
  const [snapshot] = await tx
    .select({
      id: standingsSnapshots.id,
      computedAt: standingsSnapshots.computedAt,
      resultsThrough: standingsSnapshots.resultsThrough,
      fixturesCounted: standingsSnapshots.fixturesCounted,
      fixturesDisputed: standingsSnapshots.fixturesDisputed,
      fixturesOutstanding: standingsSnapshots.fixturesOutstanding,
      requiresManualResolution: standingsSnapshots.requiresManualResolution,
      stageGroupName: stageGroups.name,
      stageName: stages.name,
      editionId: stages.editionId,
    })
    .from(standingsSnapshots)
    .innerJoin(stageGroups, eq(standingsSnapshots.stageGroupId, stageGroups.id))
    .innerJoin(stages, eq(stageGroups.stageId, stages.id))
    .where(
      and(eq(standingsSnapshots.stageGroupId, stageGroupId), isNull(standingsSnapshots.deletedAt)),
    )
    // The current table is simply the most recent one. No `isCurrent` flag to
    // get out of step with reality.
    .orderBy(desc(standingsSnapshots.computedAt), desc(standingsSnapshots.id))
    .limit(1);

  if (!snapshot) return null;

  const rows = await tx
    .select({
      entryId: standingsRows.editionEntryId,
      teamId: teams.id,
      teamName: teams.name,
      teamSlug: teams.slug,
      position: standingsRows.position,
      played: standingsRows.played,
      won: standingsRows.won,
      drawn: standingsRows.drawn,
      lost: standingsRows.lost,
      goalsFor: standingsRows.goalsFor,
      goalsAgainst: standingsRows.goalsAgainst,
      goalDifference: standingsRows.goalDifference,
      pointsEarned: standingsRows.pointsEarned,
      pointsAdjustment: standingsRows.pointsAdjustment,
      points: standingsRows.points,
      disciplinePoints: standingsRows.disciplinePoints,
      form: standingsRows.form,
      basis: standingsRows.basis,
      requiresManualResolution: standingsRows.requiresManualResolution,
    })
    .from(standingsRows)
    .innerJoin(editionEntries, eq(standingsRows.editionEntryId, editionEntries.id))
    .innerJoin(teams, eq(editionEntries.teamId, teams.id))
    .where(eq(standingsRows.snapshotId, snapshot.id))
    .orderBy(asc(standingsRows.position));

  return {
    stageGroupId,
    stageGroupName: snapshot.stageGroupName,
    stageName: snapshot.stageName,
    editionId: snapshot.editionId,
    computedAt: snapshot.computedAt,
    resultsThrough: snapshot.resultsThrough,
    fixturesCounted: snapshot.fixturesCounted,
    fixturesDisputed: snapshot.fixturesDisputed,
    fixturesOutstanding: snapshot.fixturesOutstanding,
    requiresManualResolution: snapshot.requiresManualResolution,
    rows: rows.map((row) => ({ ...row, form: row.form as ('W' | 'D' | 'L')[] })),
  };
}

/** The table as it stood at some earlier point — snapshots are never updated. */
export async function listStandingsHistory(orgId: OrgId, stageGroupId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: standingsSnapshots.id,
        computedAt: standingsSnapshots.computedAt,
        resultsThrough: standingsSnapshots.resultsThrough,
        fixturesCounted: standingsSnapshots.fixturesCounted,
      })
      .from(standingsSnapshots)
      .where(
        and(
          eq(standingsSnapshots.stageGroupId, stageGroupId),
          isNull(standingsSnapshots.deletedAt),
        ),
      )
      .orderBy(desc(standingsSnapshots.computedAt)),
  );
}

// --- writes ------------------------------------------------------------------

/** Rebuild one group's table on demand. */
export async function recomputeStandings(
  principal: Principal,
  stageGroupId: string,
): Promise<RecomputeOutcome> {
  assertCan(principal, 'update', { type: 'competition', id: stageGroupId });

  return withOrg(principal.orgId, async (tx) => {
    const [group] = await tx
      .select({ id: stageGroups.id })
      .from(stageGroups)
      .where(and(eq(stageGroups.id, stageGroupId), isNull(stageGroups.deletedAt)));
    if (!group) throw new NotFoundError('stageGroup', stageGroupId);

    const outcome = await recomputeStandingsWithin(tx, principal.orgId, stageGroupId);

    await recordAudit(tx, principal, {
      action: 'standings.recompute',
      entityType: 'stageGroup',
      entityId: stageGroupId,
      after: {
        snapshotId: outcome.snapshotId,
        fixturesCounted: outcome.fixturesCounted,
        fixturesDisputed: outcome.fixturesDisputed,
      },
    });

    return outcome;
  });
}

/**
 * Rebuild every table in a season.
 *
 * The operation you reach for after a rules change or a bulk import, and the
 * one that makes the historical importer's acceptance test possible: import a
 * past season, recompute, and diff against what the old site published.
 */
export async function recomputeSeasonStandings(
  principal: Principal,
  seasonId: string,
): Promise<RecomputeOutcome[]> {
  assertCan(principal, 'update', { type: 'competition' });

  return withOrg(principal.orgId, async (tx) => {
    const groups = await tx
      .select({ id: stageGroups.id })
      .from(stageGroups)
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .innerJoin(competitionEditions, eq(stages.editionId, competitionEditions.id))
      .where(
        and(
          eq(competitionEditions.seasonId, seasonId),
          isNull(stageGroups.deletedAt),
          isNull(stages.deletedAt),
          isNull(competitionEditions.deletedAt),
        ),
      );

    const outcomes: RecomputeOutcome[] = [];
    for (const group of groups) {
      outcomes.push(await recomputeStandingsWithin(tx, principal.orgId, group.id));
    }

    await recordAudit(tx, principal, {
      action: 'standings.recompute.season',
      entityType: 'season',
      entityId: seasonId,
      after: { groups: outcomes.length },
    });

    return outcomes;
  });
}
