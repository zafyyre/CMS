import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  competitionEditions,
  competitionSeries,
  editionEntries,
  fixtures,
  matchEvents,
  persons,
  stageGroups,
  stages,
  teams,
} from '@/db/schema';

/**
 * Leaderboards, aggregated over `match_events`.
 *
 * Two rules decide what counts, and both are the sort of thing that is
 * invisible until a season ends and somebody is presented with the wrong
 * trophy.
 *
 * **Retracted events do not count.** The table is append-only, so a
 * mis-recorded goal is withdrawn by inserting a row that retracts it. Every
 * query here therefore excludes both the withdrawn event and the row that
 * withdrew it. The same filter exists in TypeScript in
 * `src/server/match/events.ts`; it is repeated in SQL rather than pulling
 * hundreds of thousands of rows into memory to apply it, and
 * tests/integration/leaderboards.test.ts asserts the two agree.
 *
 * **Shootout conversions are not goals.** They decide who advances; they are
 * not goals, and counting them inflates the Golden Boot by however far a cup
 * run went to penalties. This is the single most common bug in football
 * statistics and it is only avoidable because `period` was recorded at the time.
 *
 * An own goal is likewise excluded from a player's tally. It counts towards the
 * opposing team's SCORE — which is why `scoringEvents()` includes it — but no
 * league has ever credited it to the scorer.
 */

/**
 * "This event still stands."
 *
 * The NOT EXISTS is the retraction check. It is correlated on the outer row, so
 * PostgreSQL uses the `match_events_retracts_unique` index rather than scanning.
 */
const stillStands: SQL = sql`${matchEvents.retractsEventId} IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM match_events retraction
    WHERE retraction.retracts_event_id = ${matchEvents.id}
  )`;

export interface LeaderboardScope {
  seasonId?: string;
  editionId?: string;
  limit?: number;
}

export interface ScorerRow {
  personId: string;
  personName: string;
  teamId: string | null;
  teamName: string | null;
  goals: number;
  /** Of those goals, how many were penalties. Leagues publish this separately. */
  penalties: number;
}

/**
 * The goalscorers chart.
 *
 * Scoped to a competition, or to a whole season for the Golden Boot — which is
 * the same query, and the reason it is one function rather than two that drift.
 */
export async function listScorers(
  orgId: OrgId,
  scope: LeaderboardScope = {},
): Promise<ScorerRow[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        personId: matchEvents.personId,
        personName: sql<string>`coalesce(${persons.displayName}, ${persons.givenName} || ' ' || ${persons.familyName})`,
        teamId: teams.id,
        teamName: teams.name,
        goals: sql<number>`count(*)::int`,
        penalties: sql<number>`count(*) filter (where ${matchEvents.type} = 'PENALTY_SCORED')::int`,
      })
      .from(matchEvents)
      .innerJoin(fixtures, eq(matchEvents.fixtureId, fixtures.id))
      .innerJoin(stageGroups, eq(fixtures.stageGroupId, stageGroups.id))
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .innerJoin(competitionEditions, eq(stages.editionId, competitionEditions.id))
      .innerJoin(persons, eq(matchEvents.personId, persons.id))
      .leftJoin(editionEntries, eq(matchEvents.editionEntryId, editionEntries.id))
      .leftJoin(teams, eq(editionEntries.teamId, teams.id))
      .where(
        and(
          stillStands,
          // An own goal belongs to the other team's score, never to the
          // scorer's tally.
          sql`${matchEvents.type} IN ('GOAL', 'PENALTY_SCORED')`,
          sql`${matchEvents.period} <> 'PENALTY_SHOOTOUT'`,
          isNull(fixtures.deletedAt),
          isNull(persons.deletedAt),
          ...scopeConditions(scope),
        ),
      )
      .groupBy(matchEvents.personId, persons.displayName, persons.givenName, persons.familyName, teams.id, teams.name)
      .orderBy(
        desc(sql`count(*)`),
        // Alphabetical within a tie, so the chart is stable between reloads.
        asc(sql`coalesce(${persons.displayName}, ${persons.givenName} || ' ' || ${persons.familyName})`),
      )
      .limit(scope.limit ?? 50);

    return rows.map((row) => ({ ...row, personId: row.personId as string }));
  });
}

export interface DisciplineRow {
  personId: string;
  personName: string;
  teamId: string | null;
  teamName: string | null;
  yellowCards: number;
  redCards: number;
}

/** Cards per player. Feeds the Phase 11 accumulation rules as well as the page. */
export async function listDiscipline(
  orgId: OrgId,
  scope: LeaderboardScope = {},
): Promise<DisciplineRow[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        personId: matchEvents.personId,
        personName: sql<string>`coalesce(${persons.displayName}, ${persons.givenName} || ' ' || ${persons.familyName})`,
        teamId: teams.id,
        teamName: teams.name,
        yellowCards: sql<number>`count(*) filter (where ${matchEvents.type} = 'YELLOW_CARD')::int`,
        redCards: sql<number>`count(*) filter (where ${matchEvents.type} in ('RED_CARD', 'SECOND_YELLOW_CARD'))::int`,
      })
      .from(matchEvents)
      .innerJoin(fixtures, eq(matchEvents.fixtureId, fixtures.id))
      .innerJoin(stageGroups, eq(fixtures.stageGroupId, stageGroups.id))
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .innerJoin(competitionEditions, eq(stages.editionId, competitionEditions.id))
      .innerJoin(persons, eq(matchEvents.personId, persons.id))
      .leftJoin(editionEntries, eq(matchEvents.editionEntryId, editionEntries.id))
      .leftJoin(teams, eq(editionEntries.teamId, teams.id))
      .where(
        and(
          stillStands,
          sql`${matchEvents.type} IN ('YELLOW_CARD', 'SECOND_YELLOW_CARD', 'RED_CARD')`,
          isNull(fixtures.deletedAt),
          isNull(persons.deletedAt),
          ...scopeConditions(scope),
        ),
      )
      .groupBy(matchEvents.personId, persons.displayName, persons.givenName, persons.familyName, teams.id, teams.name)
      .orderBy(
        desc(sql`count(*) filter (where ${matchEvents.type} in ('RED_CARD', 'SECOND_YELLOW_CARD'))`),
        desc(sql`count(*) filter (where ${matchEvents.type} = 'YELLOW_CARD')`),
        asc(sql`coalesce(${persons.displayName}, ${persons.givenName} || ' ' || ${persons.familyName})`),
      )
      .limit(scope.limit ?? 50);

    return rows.map((row) => ({ ...row, personId: row.personId as string }));
  });
}

export interface AwardRow {
  personId: string;
  personName: string;
  teamId: string | null;
  teamName: string | null;
  count: number;
}

/** Shutouts, from the clean-sheet events a match report files. */
export const listShutouts = (orgId: OrgId, scope: LeaderboardScope = {}) =>
  listAwards(orgId, 'CLEAN_SHEET', scope);

/** Players of the match. */
export const listMvps = (orgId: OrgId, scope: LeaderboardScope = {}) =>
  listAwards(orgId, 'MVP', scope);

async function listAwards(
  orgId: OrgId,
  type: 'CLEAN_SHEET' | 'MVP',
  scope: LeaderboardScope,
): Promise<AwardRow[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        personId: matchEvents.personId,
        personName: sql<string>`coalesce(${persons.displayName}, ${persons.givenName} || ' ' || ${persons.familyName})`,
        teamId: teams.id,
        teamName: teams.name,
        count: sql<number>`count(*)::int`,
      })
      .from(matchEvents)
      .innerJoin(fixtures, eq(matchEvents.fixtureId, fixtures.id))
      .innerJoin(stageGroups, eq(fixtures.stageGroupId, stageGroups.id))
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .innerJoin(competitionEditions, eq(stages.editionId, competitionEditions.id))
      .innerJoin(persons, eq(matchEvents.personId, persons.id))
      .leftJoin(editionEntries, eq(matchEvents.editionEntryId, editionEntries.id))
      .leftJoin(teams, eq(editionEntries.teamId, teams.id))
      .where(
        and(
          stillStands,
          eq(matchEvents.type, type),
          isNull(fixtures.deletedAt),
          isNull(persons.deletedAt),
          ...scopeConditions(scope),
        ),
      )
      .groupBy(matchEvents.personId, persons.displayName, persons.givenName, persons.familyName, teams.id, teams.name)
      .orderBy(
        desc(sql`count(*)`),
        asc(sql`coalesce(${persons.displayName}, ${persons.givenName} || ' ' || ${persons.familyName})`),
      )
      .limit(scope.limit ?? 50);

    return rows.map((row) => ({ ...row, personId: row.personId as string }));
  });
}

export interface TeamScoringRow {
  editionEntryId: string;
  teamId: string;
  teamName: string;
  competitionName: string;
  goalsFor: number;
}

/** Goals by team, for the "most goals scored" column a league likes to publish. */
export async function listTeamScoring(
  orgId: OrgId,
  scope: LeaderboardScope = {},
): Promise<TeamScoringRow[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        editionEntryId: editionEntries.id,
        teamId: teams.id,
        teamName: teams.name,
        competitionName: sql<string>`coalesce(${competitionEditions.nameOverride}, ${competitionSeries.name})`,
        goalsFor: sql<number>`count(*)::int`,
      })
      .from(matchEvents)
      .innerJoin(fixtures, eq(matchEvents.fixtureId, fixtures.id))
      .innerJoin(stageGroups, eq(fixtures.stageGroupId, stageGroups.id))
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .innerJoin(competitionEditions, eq(stages.editionId, competitionEditions.id))
      .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
      .innerJoin(editionEntries, eq(matchEvents.editionEntryId, editionEntries.id))
      .innerJoin(teams, eq(editionEntries.teamId, teams.id))
      .where(
        and(
          stillStands,
          sql`${matchEvents.type} IN ('GOAL', 'PENALTY_SCORED')`,
          sql`${matchEvents.period} <> 'PENALTY_SHOOTOUT'`,
          isNull(fixtures.deletedAt),
          ...scopeConditions(scope),
        ),
      )
      .groupBy(
        editionEntries.id,
        teams.id,
        teams.name,
        competitionEditions.nameOverride,
        competitionSeries.name,
      )
      .orderBy(desc(sql`count(*)`), asc(teams.name))
      .limit(scope.limit ?? 50);

    return rows;
  });
}

function scopeConditions(scope: LeaderboardScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.seasonId) conditions.push(eq(competitionEditions.seasonId, scope.seasonId));
  if (scope.editionId) conditions.push(eq(competitionEditions.id, scope.editionId));
  return conditions;
}
