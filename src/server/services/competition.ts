import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  clubs,
  competitionEditions,
  competitionSeries,
  editionEntries,
  honourAwards,
  honours,
  ladders,
  seasons,
  stageGroups,
  stages,
  teams,
} from '@/db/schema';

/**
 * Reads for the public competition pages.
 *
 * Every function takes a branded `OrgId` and goes through `withOrg`, so RLS
 * scopes the query even if a caller passes a bad filter — and the brand means
 * an id lifted from a URL cannot reach here in the first place.
 *
 * These are shaped around QUESTIONS PEOPLE ASK rather than around tables. The
 * old site made you choose a year, then a division, then a report type before
 * showing you anything; the point of a sensible default is that the answer is
 * already on screen.
 */

/** The season to show when nobody has said otherwise. */
export async function getCurrentSeason(orgId: OrgId) {
  return withOrg(orgId, async (tx) => {
    const [inProgress] = await tx
      .select()
      .from(seasons)
      .where(and(eq(seasons.status, 'IN_PROGRESS'), isNull(seasons.deletedAt)))
      .limit(1);
    if (inProgress) return inProgress;

    // Out of season, show the most recent rather than an empty page.
    const [latest] = await tx
      .select()
      .from(seasons)
      .where(isNull(seasons.deletedAt))
      .orderBy(desc(seasons.startsOn))
      .limit(1);
    return latest ?? null;
  });
}

export interface CompetitionSummary {
  editionId: string;
  slug: string;
  name: string;
  tier: number | null;
  ladderName: string | null;
  isCup: boolean;
  teamCount: number;
  groupNames: string[];
}

/**
 * Every competition running this season, with enough shape for navigation.
 *
 * Note what is NOT here: a "kind" column. Whether something reads as a league
 * or a cup is derived from whether it sits on a ladder and from the format of
 * its stages — which is the whole point of the model.
 */
export async function listCompetitions(
  orgId: OrgId,
  seasonId: string,
): Promise<CompetitionSummary[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        editionId: competitionEditions.id,
        slug: competitionEditions.slug,
        seriesName: competitionSeries.name,
        nameOverride: competitionEditions.nameOverride,
        tier: competitionEditions.tier,
        ladderName: ladders.name,
        groupName: stageGroups.name,
        /**
         * The team's participation in the EDITION, not its placement in a
         * group.
         *
         * This originally counted stage_group_entries, which is one row per
         * team per group. That is correct only while every team sits in
         * exactly one group — true today, and false the moment a team
         * progresses from a section into a play-off, at which point it is
         * counted twice and the division appears to have more teams than it
         * has. Counting the entry itself is stable across any number of stages.
         */
        entryId: editionEntries.id,
      })
      .from(competitionEditions)
      .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
      .leftJoin(ladders, eq(competitionSeries.ladderId, ladders.id))
      .leftJoin(
        editionEntries,
        and(
          eq(editionEntries.editionId, competitionEditions.id),
          isNull(editionEntries.deletedAt),
        ),
      )
      .leftJoin(stages, and(eq(stages.editionId, competitionEditions.id), isNull(stages.deletedAt)))
      .leftJoin(stageGroups, and(eq(stageGroups.stageId, stages.id), isNull(stageGroups.deletedAt)))
      .where(
        and(eq(competitionEditions.seasonId, seasonId), isNull(competitionEditions.deletedAt)),
      )
      .orderBy(asc(competitionEditions.tier), asc(competitionSeries.sortOrder));

    /**
     * Both collections are Sets rather than counters.
     *
     * Joining entries AND groups in one query produces a cross product — an
     * edition with 8 entries across 3 groups yields 24 rows — so any counter
     * incremented per row would be wrong. De-duplicating by id is correct
     * regardless of how the join fans out.
     */
    const byEdition = new Map<
      string,
      Omit<CompetitionSummary, 'teamCount' | 'groupNames'> & {
        entryIds: Set<string>;
        groups: Set<string>;
      }
    >();

    for (const row of rows) {
      let edition = byEdition.get(row.editionId);
      if (!edition) {
        edition = {
          editionId: row.editionId,
          slug: row.slug,
          name: row.nameOverride ?? row.seriesName,
          tier: row.tier,
          ladderName: row.ladderName,
          // A cup is simply a competition that sits on no ladder.
          isCup: row.ladderName === null,
          entryIds: new Set<string>(),
          groups: new Set<string>(),
        };
        byEdition.set(row.editionId, edition);
      }
      if (row.entryId) edition.entryIds.add(row.entryId);
      if (row.groupName) edition.groups.add(row.groupName);
    }

    return [...byEdition.values()].map(({ entryIds, groups, ...rest }) => ({
      ...rest,
      teamCount: entryIds.size,
      groupNames: [...groups].sort(),
    }));
  });
}

/** Clubs, with how many sides each fields. */
export async function listClubs(orgId: OrgId) {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: clubs.id,
        name: clubs.name,
        slug: clubs.slug,
        crestUrl: clubs.crestUrl,
        foundedYear: clubs.foundedYear,
        teamId: teams.id,
      })
      .from(clubs)
      .leftJoin(teams, and(eq(teams.clubId, clubs.id), isNull(teams.deletedAt)))
      .where(isNull(clubs.deletedAt))
      .orderBy(asc(clubs.name));

    const byId = new Map<
      string,
      { id: string; name: string; slug: string; crestUrl: string | null; foundedYear: number | null; teamCount: number }
    >();
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (existing) {
        if (row.teamId) existing.teamCount += 1;
        continue;
      }
      byId.set(row.id, {
        id: row.id,
        name: row.name,
        slug: row.slug,
        crestUrl: row.crestUrl,
        foundedYear: row.foundedYear,
        teamCount: row.teamId ? 1 : 0,
      });
    }
    return [...byId.values()];
  });
}

/**
 * An honours board.
 *
 * This query is the reason trophies are entities rather than a text column: on
 * the old model, "who won this trophy, and when" was not expressible at all.
 */
export async function listHonoursBoard(orgId: OrgId) {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({
        honourId: honours.id,
        honourName: honours.name,
        honourSlug: honours.slug,
        recipientKind: honours.recipientKind,
        establishedYear: honours.establishedYear,
        awardedOn: honourAwards.awardedOn,
        recipient: honourAwards.recipientNameSnapshot,
        value: honourAwards.value,
      })
      .from(honours)
      .leftJoin(honourAwards, eq(honourAwards.honourId, honours.id))
      .where(isNull(honours.deletedAt))
      .orderBy(asc(honours.name), desc(honourAwards.awardedOn));

    const byHonour = new Map<
      string,
      {
        id: string;
        name: string;
        slug: string;
        recipientKind: string;
        establishedYear: number | null;
        winners: { awardedOn: string | null; recipient: string | null; value: number | null }[];
      }
    >();

    for (const row of rows) {
      let honour = byHonour.get(row.honourId);
      if (!honour) {
        honour = {
          id: row.honourId,
          name: row.honourName,
          slug: row.honourSlug,
          recipientKind: row.recipientKind,
          establishedYear: row.establishedYear,
          winners: [],
        };
        byHonour.set(row.honourId, honour);
      }
      if (row.recipient) {
        honour.winners.push({
          awardedOn: row.awardedOn,
          recipient: row.recipient,
          value: row.value,
        });
      }
    }

    return [...byHonour.values()];
  });
}

/** Total registered sides this season — used for the league's "at a glance". */
export async function countEntries(orgId: OrgId, seasonId: string): Promise<number> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ id: editionEntries.id })
      .from(editionEntries)
      .innerJoin(competitionEditions, eq(editionEntries.editionId, competitionEditions.id))
      .where(
        and(eq(competitionEditions.seasonId, seasonId), isNull(editionEntries.deletedAt)),
      );
    return rows.length;
  });
}
