import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withOrg } from '@/db';
import { clubs, stageGroupEntries, stageGroups, stages } from '@/db/schema';
import { listCompetitions, getCurrentSeason } from '@/server/services/competition';
import {
  closeFixtures,
  createLeagueFixture,
  type LeagueFixture,
  rootDb,
  truncateAll,
} from '../helpers/fixtures';

/**
 * Regression tests for two defects found during code review.
 *
 * Both were confirmed against a live database before being fixed, and both are
 * the kind that stay invisible until real data exists — which is exactly when
 * they become expensive.
 */

let league: LeagueFixture;

beforeEach(async () => {
  await truncateAll();
  league = await createLeagueFixture('alpha');
});

afterAll(async () => {
  await closeFixtures();
});

describe('soft deleting something frees its identifier', () => {
  /**
   * The original defect: UNIQUE (org_id, slug) counted soft-deleted rows, so
   * deleting anything made its slug permanently unusable. A club that folded
   * and refounded could never reclaim its own name — the league would just get
   * "already exists" for an identifier nothing visible was using.
   *
   * Fixed with a partial unique index: UNIQUE ... WHERE deleted_at IS NULL.
   * Twenty constraints across nineteen tables had the same defect.
   */
  it('lets a refounded club reclaim its slug', async () => {
    await withOrg(league.orgId, async (tx) => {
      await tx.update(clubs).set({ deletedAt: new Date() }).where(eq(clubs.id, league.clubId));
    });

    const recreated = await withOrg(league.orgId, async (tx) =>
      tx
        .insert(clubs)
        .values({ orgId: league.orgId, name: 'alpha FC (refounded)', slug: 'alpha-fc' })
        .returning(),
    );

    expect(recreated).toHaveLength(1);
    expect(recreated[0]?.slug).toBe('alpha-fc');
  });

  it('still rejects a duplicate among LIVE rows', async () => {
    // The fix must not weaken the actual guarantee.
    let caught: unknown;
    try {
      await withOrg(league.orgId, async (tx) =>
        tx.insert(clubs).values({ orgId: league.orgId, name: 'Impostor', slug: 'alpha-fc' }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught, 'a live duplicate slug must still be rejected').toBeDefined();
  });

  it('keeps the deleted row intact rather than removing it', async () => {
    await withOrg(league.orgId, async (tx) => {
      await tx.update(clubs).set({ deletedAt: new Date() }).where(eq(clubs.id, league.clubId));
    });

    // Soft delete means the history survives — a club with match records
    // cannot simply vanish.
    const all = await withOrg(league.orgId, async (tx) => tx.select().from(clubs));
    expect(all).toHaveLength(1);
    expect(all[0]?.deletedAt).not.toBeNull();
  });
});

describe('competition team counts survive a team progressing between stages', () => {
  /**
   * The original defect: the count was taken from stage_group_entries, which is
   * one row per team PER GROUP. That is correct only while every team sits in
   * exactly one group — true of the seed, and false the moment a team advances
   * from a section into a play-off, at which point it is counted twice and the
   * division appears to have more teams than it has.
   *
   * Fixed by counting the team's entry into the EDITION instead, de-duplicated
   * by id so the join fan-out cannot distort it.
   */
  it('counts a team once even when placed in two stages', async () => {
    // Place the team in the fixture's existing group first — the fixture
    // creates the entry and the group but does not connect them.
    await rootDb.insert(stageGroupEntries).values({
      orgId: league.orgId,
      stageGroupId: league.stageGroupId,
      editionEntryId: league.entryId,
    });

    // Then add a second stage with its own group and place the SAME entry
    // there too, exactly as qualifying for a play-off would.
    const secondStageId = uuidv7();
    const secondGroupId = uuidv7();

    await rootDb.insert(stages).values({
      id: secondStageId,
      orgId: league.orgId,
      editionId: league.editionId,
      ordinal: 2,
      name: 'Championship Play-off',
      slug: 'championship',
      format: 'KNOCKOUT',
    });

    await rootDb.insert(stageGroups).values({
      id: secondGroupId,
      orgId: league.orgId,
      stageId: secondStageId,
      name: 'Final',
      slug: 'final',
    });

    await rootDb.insert(stageGroupEntries).values({
      orgId: league.orgId,
      stageGroupId: secondGroupId,
      editionEntryId: league.entryId,
    });

    // Sanity: the team really is in two groups now.
    const placements = await withOrg(league.orgId, async (tx) =>
      tx.select().from(stageGroupEntries),
    );
    expect(placements, 'test setup should place the team in two groups').toHaveLength(2);

    const season = await getCurrentSeason(league.orgId);
    expect(season).not.toBeNull();

    const competitions = await listCompetitions(league.orgId, season!.id);
    const premier = competitions.find((c) => c.slug === 'premier');

    // One team entered the competition. It appears in two groups. The count
    // must be 1 — before the fix this returned 2.
    expect(premier?.teamCount).toBe(1);
    // And both group names should still be listed.
    expect(premier?.groupNames.sort()).toEqual(['Final', 'Table']);
  });

  it('excludes a withdrawn entry from the count', async () => {
    const season = await getCurrentSeason(league.orgId);
    const before = await listCompetitions(league.orgId, season!.id);
    expect(before.find((c) => c.slug === 'premier')?.teamCount).toBe(1);

    // Soft-delete the entry the way a withdrawal would.
    await withOrg(league.orgId, async (tx) => {
      await tx.execute(
        sql`update edition_entries set deleted_at = now() where id = ${league.entryId}`,
      );
    });

    const after = await listCompetitions(league.orgId, season!.id);
    expect(after.find((c) => c.slug === 'premier')?.teamCount).toBe(0);
  });
});
