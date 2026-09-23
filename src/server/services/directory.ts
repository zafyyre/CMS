import { and, asc, eq, isNull } from 'drizzle-orm';
import { withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  clubs,
  competitionEditions,
  competitionSeries,
  editionEntries,
  seasons,
  stageGroupEntries,
  stageGroups,
  stages,
  teams,
} from '@/db/schema';

/**
 * Entity pages: a page for THIS club, THIS team.
 *
 * The old site has none of these. It is a report generator — you choose a
 * year, then a division, then a report type, and it renders a table. There is
 * no address for "Rutland Rovers", so nothing about them can be linked to,
 * shared, or found by search. Every function here exists to make one entity
 * addressable.
 */

export interface ClubDetail {
  id: string;
  name: string;
  slug: string;
  shortName: string | null;
  crestUrl: string | null;
  foundedYear: number | null;
  contactEmail: string | null;
  teams: {
    id: string;
    name: string;
    slug: string;
    designation: string | null;
    competitions: string[];
  }[];
}

export async function getClubBySlug(orgId: OrgId, slug: string): Promise<ClubDetail | null> {
  return withOrg(orgId, async (tx) => {
    const [club] = await tx
      .select()
      .from(clubs)
      .where(and(eq(clubs.slug, slug), isNull(clubs.deletedAt)));
    if (!club) return null;

    const rows = await tx
      .select({
        teamId: teams.id,
        teamName: teams.name,
        teamSlug: teams.slug,
        designation: teams.designation,
        seriesName: competitionSeries.name,
        nameOverride: competitionEditions.nameOverride,
      })
      .from(teams)
      .leftJoin(
        editionEntries,
        and(eq(editionEntries.teamId, teams.id), isNull(editionEntries.deletedAt)),
      )
      .leftJoin(
        competitionEditions,
        eq(editionEntries.editionId, competitionEditions.id),
      )
      .leftJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
      .where(and(eq(teams.clubId, club.id), isNull(teams.deletedAt)))
      .orderBy(asc(teams.name));

    // The join fans out one row per team per competition, so de-duplicate by
    // team id rather than counting rows.
    const byTeam = new Map<string, ClubDetail['teams'][number]>();
    for (const row of rows) {
      let team = byTeam.get(row.teamId);
      if (!team) {
        team = {
          id: row.teamId,
          name: row.teamName,
          slug: row.teamSlug,
          designation: row.designation,
          competitions: [],
        };
        byTeam.set(row.teamId, team);
      }
      const competition = row.nameOverride ?? row.seriesName;
      if (competition && !team.competitions.includes(competition)) {
        team.competitions.push(competition);
      }
    }

    return {
      id: club.id,
      name: club.name,
      slug: club.slug,
      shortName: club.shortName,
      crestUrl: club.crestUrl,
      foundedYear: club.foundedYear,
      contactEmail: club.contactEmail,
      teams: [...byTeam.values()],
    };
  });
}

export interface TeamDetail {
  id: string;
  name: string;
  slug: string;
  designation: string | null;
  club: { id: string; name: string; slug: string };
  entries: {
    entryId: string;
    editionId: string;
    competitionName: string;
    competitionSlug: string;
    seasonName: string;
    seasonSlug: string;
    seasonId: string;
    status: string;
    stageGroupIds: string[];
  }[];
}

export async function getTeamBySlug(orgId: OrgId, slug: string): Promise<TeamDetail | null> {
  return withOrg(orgId, async (tx) => {
    const [team] = await tx
      .select({
        id: teams.id,
        name: teams.name,
        slug: teams.slug,
        designation: teams.designation,
        clubId: clubs.id,
        clubName: clubs.name,
        clubSlug: clubs.slug,
      })
      .from(teams)
      .innerJoin(clubs, eq(teams.clubId, clubs.id))
      .where(and(eq(teams.slug, slug), isNull(teams.deletedAt)));
    if (!team) return null;

    const rows = await tx
      .select({
        entryId: editionEntries.id,
        editionId: competitionEditions.id,
        competitionSlug: competitionEditions.slug,
        nameOverride: competitionEditions.nameOverride,
        seriesName: competitionSeries.name,
        seasonId: seasons.id,
        seasonName: seasons.name,
        seasonSlug: seasons.slug,
        status: editionEntries.status,
        stageGroupId: stageGroups.id,
      })
      .from(editionEntries)
      .innerJoin(competitionEditions, eq(editionEntries.editionId, competitionEditions.id))
      .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
      .innerJoin(seasons, eq(competitionEditions.seasonId, seasons.id))
      .leftJoin(
        stageGroupEntries,
        and(
          eq(stageGroupEntries.editionEntryId, editionEntries.id),
          isNull(stageGroupEntries.deletedAt),
        ),
      )
      .leftJoin(stageGroups, eq(stageGroupEntries.stageGroupId, stageGroups.id))
      .where(and(eq(editionEntries.teamId, team.id), isNull(editionEntries.deletedAt)))
      .orderBy(asc(seasons.startsOn), asc(competitionSeries.sortOrder));

    const byEntry = new Map<string, TeamDetail['entries'][number]>();
    for (const row of rows) {
      let entry = byEntry.get(row.entryId);
      if (!entry) {
        entry = {
          entryId: row.entryId,
          editionId: row.editionId,
          competitionName: row.nameOverride ?? row.seriesName,
          competitionSlug: row.competitionSlug,
          seasonName: row.seasonName,
          seasonSlug: row.seasonSlug,
          seasonId: row.seasonId,
          status: row.status,
          stageGroupIds: [],
        };
        byEntry.set(row.entryId, entry);
      }
      if (row.stageGroupId && !entry.stageGroupIds.includes(row.stageGroupId)) {
        entry.stageGroupIds.push(row.stageGroupId);
      }
    }

    return {
      id: team.id,
      name: team.name,
      slug: team.slug,
      designation: team.designation,
      club: { id: team.clubId, name: team.clubName, slug: team.clubSlug },
      entries: [...byEntry.values()],
    };
  });
}

/** Everything addressable, for the sitemap and for `generateStaticParams`. */
export async function listPublicSlugs(orgId: OrgId) {
  return withOrg(orgId, async (tx) => {
    const [clubSlugs, teamSlugs, editionSlugs, seasonSlugs] = await Promise.all([
      tx.select({ slug: clubs.slug, updatedAt: clubs.updatedAt }).from(clubs).where(isNull(clubs.deletedAt)),
      tx.select({ slug: teams.slug, updatedAt: teams.updatedAt }).from(teams).where(isNull(teams.deletedAt)),
      tx
        .select({
          slug: competitionEditions.slug,
          seasonSlug: seasons.slug,
          updatedAt: competitionEditions.updatedAt,
        })
        .from(competitionEditions)
        .innerJoin(seasons, eq(competitionEditions.seasonId, seasons.id))
        .where(isNull(competitionEditions.deletedAt)),
      tx.select({ slug: seasons.slug, updatedAt: seasons.updatedAt }).from(seasons).where(isNull(seasons.deletedAt)),
    ]);
    return { clubs: clubSlugs, teams: teamSlugs, editions: editionSlugs, seasons: seasonSlugs };
  });
}

/** A competition by season slug and its own slug — the standings page's key. */
export async function getEditionBySlugs(
  orgId: OrgId,
  seasonSlug: string,
  editionSlug: string,
) {
  return withOrg(orgId, async (tx) => {
    const [row] = await tx
      .select({
        editionId: competitionEditions.id,
        editionSlug: competitionEditions.slug,
        nameOverride: competitionEditions.nameOverride,
        seriesName: competitionSeries.name,
        tier: competitionEditions.tier,
        seasonId: seasons.id,
        seasonName: seasons.name,
        seasonSlug: seasons.slug,
      })
      .from(competitionEditions)
      .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
      .innerJoin(seasons, eq(competitionEditions.seasonId, seasons.id))
      .where(
        and(
          eq(seasons.slug, seasonSlug),
          eq(competitionEditions.slug, editionSlug),
          isNull(competitionEditions.deletedAt),
          isNull(seasons.deletedAt),
        ),
      );

    if (!row) return null;
    return { ...row, name: row.nameOverride ?? row.seriesName };
  });
}

/** Which groups a competition has, for navigation between sections. */
export async function listEditionGroups(orgId: OrgId, editionId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: stageGroups.id,
        name: stageGroups.name,
        slug: stageGroups.slug,
        stageName: stages.name,
        stageFormat: stages.format,
        stageOrdinal: stages.ordinal,
      })
      .from(stageGroups)
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .where(
        and(
          eq(stages.editionId, editionId),
          isNull(stageGroups.deletedAt),
          isNull(stages.deletedAt),
        ),
      )
      .orderBy(asc(stages.ordinal), asc(stageGroups.ordinal)),
  );
}

/** Seasons for the archive navigation, newest first. */
export async function listSeasons(orgId: OrgId) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: seasons.id,
        name: seasons.name,
        slug: seasons.slug,
        status: seasons.status,
        startsOn: seasons.startsOn,
      })
      .from(seasons)
      .where(isNull(seasons.deletedAt))
      .orderBy(asc(seasons.startsOn)),
  );
}
