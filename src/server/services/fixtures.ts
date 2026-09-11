import { and, asc, eq, gte, inArray, isNull, lt, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type Tx, withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  competitionEditions,
  competitionSeries,
  editionEntries,
  fixtureChanges,
  fixtures,
  organizations,
  resultSubmissions,
  stageGroups,
  stages,
  teams,
  venues,
} from '@/db/schema';
import { resolveZonedWallTime, type ZonedResolution } from '@/lib/time';
import { recordAudit } from '@/server/audit/record';
import { assertCan } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import { resolveResult, type ResolvedResult } from '@/server/match/result';
import { NotFoundError, requireText, ValidationError } from './errors';

/**
 * Fixtures: the schedule, and every change ever made to it.
 *
 * Two invariants hold everywhere in this file.
 *
 * 1. **Kickoff times are instants.** Nothing here ever stores or compares a
 *    local time. Callers hand in either a UTC `Date` or a local wall-clock
 *    string plus the league's own timezone, and the conversion goes through
 *    `src/lib/time.ts` exactly once. That is what stops the schedule being an
 *    hour wrong between March and November.
 *
 * 2. **Every mutation leaves evidence.** A fixture cannot be created, moved or
 *    called off without a `fixture_changes` row and an `audit_log` row written
 *    in the same transaction. Both tables are append-only in PostgreSQL, so
 *    the trail cannot be tidied up afterwards — including by deleting the
 *    fixture, which the foreign keys refuse while history exists.
 */

export type FixtureStatus =
  | 'SCHEDULED'
  | 'POSTPONED'
  | 'CANCELLED'
  | 'PLAYED'
  | 'FORFEITED'
  | 'ABANDONED'
  | 'AWARDED';

export interface FixtureView {
  id: string;
  kickoffAt: Date | null;
  status: FixtureStatus;
  round: number | null;
  matchday: number | null;
  leg: number;
  publicNote: string | null;

  competitionName: string;
  competitionSlug: string;
  editionId: string;
  seasonId: string;
  stageGroupId: string;
  stageGroupName: string;

  homeEntryId: string | null;
  homeTeamName: string | null;
  awayEntryId: string | null;
  awayTeamName: string | null;

  venueId: string | null;
  venueName: string | null;
  venueSlug: string | null;

  /** Derived from the submissions — see src/server/match/result.ts. */
  result: ResolvedResult;
}

export interface FixtureFilter {
  fixtureId?: string;
  seasonId?: string;
  editionId?: string;
  stageGroupId?: string;
  venueId?: string;
  /** Either side. Answers "show me this team's season". */
  entryId?: string;
  /** Half-open instant window: `from <= kickoff < to`. */
  from?: Date;
  to?: Date;
  status?: FixtureStatus;
  limit?: number;
}

// --- reads -------------------------------------------------------------------

export async function listFixtures(
  orgId: OrgId,
  filter: FixtureFilter = {},
): Promise<FixtureView[]> {
  return withOrg(orgId, async (tx) => {
    const homeEntry = alias(editionEntries, 'home_entry');
    const awayEntry = alias(editionEntries, 'away_entry');
    const homeTeam = alias(teams, 'home_team');
    const awayTeam = alias(teams, 'away_team');

    const conditions = [isNull(fixtures.deletedAt), isNull(stageGroups.deletedAt)];
    if (filter.fixtureId) conditions.push(eq(fixtures.id, filter.fixtureId));
    if (filter.entryId) {
      // Either side — "show me this team's season" is one list, not two.
      const eitherSide = or(
        eq(fixtures.homeEntryId, filter.entryId),
        eq(fixtures.awayEntryId, filter.entryId),
      );
      if (eitherSide) conditions.push(eitherSide);
    }
    if (filter.seasonId) conditions.push(eq(competitionEditions.seasonId, filter.seasonId));
    if (filter.editionId) conditions.push(eq(competitionEditions.id, filter.editionId));
    if (filter.stageGroupId) conditions.push(eq(fixtures.stageGroupId, filter.stageGroupId));
    if (filter.venueId) conditions.push(eq(fixtures.venueId, filter.venueId));
    if (filter.from) conditions.push(gte(fixtures.kickoffAt, filter.from));
    // Half-open, so a fixture never appears in two adjacent windows.
    if (filter.to) conditions.push(lt(fixtures.kickoffAt, filter.to));
    if (filter.status) conditions.push(eq(fixtures.status, filter.status));

    const base = tx
      .select({
        id: fixtures.id,
        kickoffAt: fixtures.kickoffAt,
        status: fixtures.status,
        round: fixtures.round,
        matchday: fixtures.matchday,
        leg: fixtures.leg,
        publicNote: fixtures.publicNote,
        stageGroupId: fixtures.stageGroupId,
        stageGroupName: stageGroups.name,
        editionId: competitionEditions.id,
        seasonId: competitionEditions.seasonId,
        competitionSlug: competitionEditions.slug,
        seriesName: competitionSeries.name,
        nameOverride: competitionEditions.nameOverride,
        homeEntryId: fixtures.homeEntryId,
        homeTeamName: homeTeam.name,
        awayEntryId: fixtures.awayEntryId,
        awayTeamName: awayTeam.name,
        venueId: fixtures.venueId,
        venueName: venues.name,
        venueSlug: venues.slug,
      })
      .from(fixtures)
      .innerJoin(stageGroups, eq(fixtures.stageGroupId, stageGroups.id))
      .innerJoin(stages, eq(stageGroups.stageId, stages.id))
      .innerJoin(competitionEditions, eq(stages.editionId, competitionEditions.id))
      .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
      .leftJoin(homeEntry, eq(fixtures.homeEntryId, homeEntry.id))
      .leftJoin(homeTeam, eq(homeEntry.teamId, homeTeam.id))
      .leftJoin(awayEntry, eq(fixtures.awayEntryId, awayEntry.id))
      .leftJoin(awayTeam, eq(awayEntry.teamId, awayTeam.id))
      .leftJoin(venues, eq(fixtures.venueId, venues.id))
      .where(and(...conditions))
      // Nulls last: a fixture with no date yet belongs at the end of a
      // schedule, not at the top of it.
      .orderBy(asc(fixtures.kickoffAt), asc(fixtures.id));

    const rows = filter.limit ? await base.limit(filter.limit) : await base;

    const results = await resolveResultsFor(
      tx,
      rows.map((r) => r.id),
    );

    return rows.map((row) => ({
      id: row.id,
      kickoffAt: row.kickoffAt,
      status: row.status as FixtureStatus,
      round: row.round,
      matchday: row.matchday,
      leg: row.leg,
      publicNote: row.publicNote,
      competitionName: row.nameOverride ?? row.seriesName,
      competitionSlug: row.competitionSlug,
      editionId: row.editionId,
      seasonId: row.seasonId,
      stageGroupId: row.stageGroupId,
      stageGroupName: row.stageGroupName,
      homeEntryId: row.homeEntryId,
      homeTeamName: row.homeTeamName,
      awayEntryId: row.awayEntryId,
      awayTeamName: row.awayTeamName,
      venueId: row.venueId,
      venueName: row.venueName,
      venueSlug: row.venueSlug,
      result: results.get(row.id) ?? resolveResult([]),
    }));
  });
}

export async function getFixture(orgId: OrgId, fixtureId: string): Promise<FixtureView | null> {
  const [found] = await listFixtures(orgId, { fixtureId, limit: 1 });
  return found ?? null;
}

/**
 * Every change ever made to a fixture, oldest first.
 *
 * This is the answer to "when did you move our game, and why" — the question
 * that generates more email than anything else the league does.
 */
export async function listFixtureChanges(orgId: OrgId, fixtureId: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: fixtureChanges.id,
        kind: fixtureChanges.kind,
        previousKickoffAt: fixtureChanges.previousKickoffAt,
        newKickoffAt: fixtureChanges.newKickoffAt,
        previousVenueId: fixtureChanges.previousVenueId,
        newVenueId: fixtureChanges.newVenueId,
        previousStatus: fixtureChanges.previousStatus,
        newStatus: fixtureChanges.newStatus,
        reason: fixtureChanges.reason,
        changedByPersonId: fixtureChanges.changedByPersonId,
        createdAt: fixtureChanges.createdAt,
      })
      .from(fixtureChanges)
      .where(eq(fixtureChanges.fixtureId, fixtureId))
      .orderBy(asc(fixtureChanges.createdAt), asc(fixtureChanges.id)),
  );
}

/**
 * Resolve the score of many fixtures in one round trip.
 *
 * Deliberately not a per-fixture lookup: a division page lists ninety
 * fixtures, and ninety extra queries to answer "what was the score" is how a
 * page that should render in 200ms takes four seconds on match night.
 */
async function resolveResultsFor(
  tx: Tx,
  fixtureIds: string[],
): Promise<Map<string, ResolvedResult>> {
  const resolved = new Map<string, ResolvedResult>();
  if (fixtureIds.length === 0) return resolved;

  const submissions = await tx
    .select()
    .from(resultSubmissions)
    .where(inArray(resultSubmissions.fixtureId, fixtureIds));

  const byFixture = new Map<string, (typeof submissions)[number][]>();
  for (const submission of submissions) {
    const list = byFixture.get(submission.fixtureId);
    if (list) list.push(submission);
    else byFixture.set(submission.fixtureId, [submission]);
  }

  for (const fixtureId of fixtureIds) {
    resolved.set(fixtureId, resolveResult(byFixture.get(fixtureId) ?? []));
  }
  return resolved;
}

// --- writes ------------------------------------------------------------------

export interface ScheduleFixtureInput {
  stageGroupId: string;
  homeEntryId?: string | null;
  awayEntryId?: string | null;
  venueId?: string | null;
  /**
   * Local wall-clock time in the LEAGUE's timezone — "2026-03-08T14:00".
   *
   * Prefer this over `kickoffAt`. It is what a scheduler actually types, and
   * routing it through here means the DST conversion happens in one audited
   * place instead of at every call site.
   */
  kickoffLocal?: string | null;
  /** An instant, for callers that genuinely already hold UTC. */
  kickoffAt?: Date | null;
  round?: number | null;
  matchday?: number | null;
  leg?: number;
  publicNote?: string | null;
  reason?: string;
}

export interface ScheduledFixture {
  id: string;
  kickoffAt: Date | null;
  /** Set when the local time given was ambiguous — see resolveZonedWallTime. */
  kickoffAmbiguity: ZonedResolution | null;
}

export async function scheduleFixture(
  principal: Principal,
  input: ScheduleFixtureInput,
): Promise<ScheduledFixture> {
  assertCan(principal, 'create', { type: 'fixture' });
  return withOrg(principal.orgId, (tx) => insertFixture(tx, principal, input));
}

/**
 * The body of `scheduleFixture`, taking a transaction.
 *
 * Exists so the CSV importer can create four hundred fixtures inside ONE
 * transaction rather than four hundred of them — which is what makes a failed
 * import leave nothing behind instead of half a season.
 *
 * Contract, since it bypasses the wrapper: the caller must already be inside
 * `withOrg` for `principal.orgId`, and must already have authorized the
 * `create fixture` action. Both of its call sites do.
 */
export async function insertFixture(
  tx: Tx,
  principal: Principal,
  input: ScheduleFixtureInput,
): Promise<ScheduledFixture> {
  const group = await loadStageGroup(tx, input.stageGroupId);
  const kickoff = await resolveKickoff(tx, principal.orgId, input);

  const homeEntryId = input.homeEntryId ?? null;
  const awayEntryId = input.awayEntryId ?? null;
  if (homeEntryId && awayEntryId && homeEntryId === awayEntryId) {
    throw new ValidationError('A team cannot play itself.');
  }
  await assertEntryInEdition(tx, homeEntryId, group.editionId, 'home');
  await assertEntryInEdition(tx, awayEntryId, group.editionId, 'away');
  await assertVenueExists(tx, input.venueId ?? null);

  const leg = input.leg ?? 1;
  if (!Number.isInteger(leg) || leg < 1) {
    throw new ValidationError('leg must be a whole number of 1 or more.');
  }

  const [created] = await tx
    .insert(fixtures)
    .values({
      orgId: principal.orgId,
      stageGroupId: input.stageGroupId,
      homeEntryId,
      awayEntryId,
      venueId: input.venueId ?? null,
      kickoffAt: kickoff?.instant ?? null,
      round: input.round ?? null,
      matchday: input.matchday ?? null,
      leg,
      publicNote: input.publicNote ?? null,
      status: 'SCHEDULED',
    })
    .returning({ id: fixtures.id, kickoffAt: fixtures.kickoffAt });

  if (!created) throw new Error('fixture insert returned no row');

  const reason = input.reason?.trim() || 'Fixture created.';
  await tx.insert(fixtureChanges).values({
    orgId: principal.orgId,
    fixtureId: created.id,
    kind: 'SCHEDULED',
    newKickoffAt: created.kickoffAt,
    newVenueId: input.venueId ?? null,
    newStatus: 'SCHEDULED',
    reason,
    changedByPersonId: principal.personId,
  });

  await recordAudit(tx, principal, {
    action: 'fixture.schedule',
    entityType: 'fixture',
    entityId: created.id,
    after: {
      stageGroupId: input.stageGroupId,
      kickoffAt: created.kickoffAt,
      venueId: input.venueId ?? null,
      homeEntryId,
      awayEntryId,
    },
    reason,
  });

  return {
    id: created.id,
    kickoffAt: created.kickoffAt,
    kickoffAmbiguity: kickoff?.kind === 'AMBIGUOUS' ? kickoff : null,
  };
}

export interface RescheduleFixtureInput {
  fixtureId: string;
  /** Omit to leave the kickoff alone; `null` to clear it back to "date TBC". */
  kickoffLocal?: string | null;
  kickoffAt?: Date | null;
  /** Omit to leave the venue alone; `null` to clear it. */
  venueId?: string | null;
  /** Never optional. A reschedule with no stated reason is what leagues fight about. */
  reason: string;
}

export async function rescheduleFixture(
  principal: Principal,
  input: RescheduleFixtureInput,
): Promise<{ changed: boolean; kickoffAmbiguity: ZonedResolution | null }> {
  assertCan(principal, 'update', { type: 'fixture', id: input.fixtureId });
  const reason = requireText(input.reason, 'reason');

  return withOrg(principal.orgId, async (tx) => {
    const before = await loadFixture(tx, input.fixtureId);

    const movesKickoff = input.kickoffLocal !== undefined || input.kickoffAt !== undefined;
    const movesVenue = input.venueId !== undefined;
    if (!movesKickoff && !movesVenue) {
      throw new ValidationError('A reschedule must change the kickoff time, the venue, or both.');
    }

    const kickoff = movesKickoff ? await resolveKickoff(tx, principal.orgId, input) : null;
    const nextKickoff = movesKickoff ? (kickoff?.instant ?? null) : before.kickoffAt;
    const nextVenueId = movesVenue ? (input.venueId ?? null) : before.venueId;

    if (movesVenue) await assertVenueExists(tx, nextVenueId);

    const kickoffChanged = sameInstant(before.kickoffAt, nextKickoff) === false;
    const venueChanged = before.venueId !== nextVenueId;
    if (!kickoffChanged && !venueChanged) {
      return { changed: false, kickoffAmbiguity: null };
    }

    await tx
      .update(fixtures)
      .set({ kickoffAt: nextKickoff, venueId: nextVenueId, updatedAt: new Date() })
      .where(eq(fixtures.id, input.fixtureId));

    /**
     * One row per aspect changed, rather than one row describing both.
     *
     * It keeps `kind` meaningful — "how many times was this moved" and "how
     * many times did the pitch change under us" are different questions clubs
     * genuinely ask, and a single combined row cannot answer either without
     * inspecting the other columns.
     */
    if (kickoffChanged) {
      await tx.insert(fixtureChanges).values({
        orgId: principal.orgId,
        fixtureId: input.fixtureId,
        kind: 'RESCHEDULED',
        previousKickoffAt: before.kickoffAt,
        newKickoffAt: nextKickoff,
        reason,
        changedByPersonId: principal.personId,
      });
    }
    if (venueChanged) {
      await tx.insert(fixtureChanges).values({
        orgId: principal.orgId,
        fixtureId: input.fixtureId,
        kind: 'VENUE_CHANGED',
        previousVenueId: before.venueId,
        newVenueId: nextVenueId,
        reason,
        changedByPersonId: principal.personId,
      });
    }

    await recordAudit(tx, principal, {
      action: 'fixture.reschedule',
      entityType: 'fixture',
      entityId: input.fixtureId,
      before: { kickoffAt: before.kickoffAt, venueId: before.venueId },
      after: { kickoffAt: nextKickoff, venueId: nextVenueId },
      reason,
    });

    return {
      changed: true,
      kickoffAmbiguity: kickoff?.kind === 'AMBIGUOUS' ? kickoff : null,
    };
  });
}

export interface SetFixtureStatusInput {
  fixtureId: string;
  status: FixtureStatus;
  reason: string;
  /** Postponing usually means the date is no longer known. */
  clearKickoff?: boolean;
  publicNote?: string | null;
}

export async function setFixtureStatus(
  principal: Principal,
  input: SetFixtureStatusInput,
): Promise<void> {
  assertCan(principal, 'update', { type: 'fixture', id: input.fixtureId });
  const reason = requireText(input.reason, 'reason');

  await withOrg(principal.orgId, async (tx) => {
    const before = await loadFixture(tx, input.fixtureId);
    if (before.status === input.status && !input.clearKickoff) return;

    const nextKickoff = input.clearKickoff ? null : before.kickoffAt;

    await tx
      .update(fixtures)
      .set({
        status: input.status,
        kickoffAt: nextKickoff,
        publicNote: input.publicNote === undefined ? before.publicNote : input.publicNote,
        updatedAt: new Date(),
      })
      .where(eq(fixtures.id, input.fixtureId));

    await tx.insert(fixtureChanges).values({
      orgId: principal.orgId,
      fixtureId: input.fixtureId,
      kind: 'STATUS_CHANGED',
      previousStatus: before.status,
      newStatus: input.status,
      // Only recorded when the status change also dropped the date, so a
      // reader can tell "postponed, new date to follow" from "postponed but
      // still pencilled in for Saturday".
      previousKickoffAt: input.clearKickoff ? before.kickoffAt : null,
      newKickoffAt: nextKickoff,
      reason,
      changedByPersonId: principal.personId,
    });

    await recordAudit(tx, principal, {
      action: 'fixture.status',
      entityType: 'fixture',
      entityId: input.fixtureId,
      before: { status: before.status, kickoffAt: before.kickoffAt },
      after: { status: input.status, kickoffAt: nextKickoff },
      reason,
    });
  });
}

// --- internals ---------------------------------------------------------------

interface LoadedFixture {
  id: string;
  stageGroupId: string;
  kickoffAt: Date | null;
  venueId: string | null;
  status: FixtureStatus;
  homeEntryId: string | null;
  awayEntryId: string | null;
  publicNote: string | null;
}

async function loadFixture(tx: Tx, fixtureId: string): Promise<LoadedFixture> {
  const [row] = await tx
    .select({
      id: fixtures.id,
      stageGroupId: fixtures.stageGroupId,
      kickoffAt: fixtures.kickoffAt,
      venueId: fixtures.venueId,
      status: fixtures.status,
      homeEntryId: fixtures.homeEntryId,
      awayEntryId: fixtures.awayEntryId,
      publicNote: fixtures.publicNote,
    })
    .from(fixtures)
    .where(and(eq(fixtures.id, fixtureId), isNull(fixtures.deletedAt)));

  if (!row) throw new NotFoundError('fixture', fixtureId);
  return { ...row, status: row.status as FixtureStatus };
}

async function loadStageGroup(tx: Tx, stageGroupId: string): Promise<{ editionId: string }> {
  const [row] = await tx
    .select({ editionId: stages.editionId })
    .from(stageGroups)
    .innerJoin(stages, eq(stageGroups.stageId, stages.id))
    .where(and(eq(stageGroups.id, stageGroupId), isNull(stageGroups.deletedAt)));

  if (!row) throw new NotFoundError('stageGroup', stageGroupId);
  return row;
}

/**
 * A fixture's two sides must be entered in the competition the fixture belongs
 * to.
 *
 * The composite foreign keys already make a cross-LEAGUE reference
 * inexpressible. This closes the within-league version: scheduling a Premier
 * side into a Division 3 fixture is a data-entry slip that CSV import makes
 * easy and that nothing downstream would catch — it would simply appear in the
 * wrong table for the rest of the season.
 */
async function assertEntryInEdition(
  tx: Tx,
  entryId: string | null,
  editionId: string,
  side: 'home' | 'away',
): Promise<void> {
  if (!entryId) return;

  const [entry] = await tx
    .select({ editionId: editionEntries.editionId })
    .from(editionEntries)
    .where(and(eq(editionEntries.id, entryId), isNull(editionEntries.deletedAt)));

  if (!entry) throw new NotFoundError('editionEntry', entryId);
  if (entry.editionId !== editionId) {
    throw new ValidationError(
      `The ${side} team is not entered in this competition. ` +
        'A fixture can only be played between two teams in the same edition.',
    );
  }
}

async function assertVenueExists(tx: Tx, venueId: string | null): Promise<void> {
  if (!venueId) return;
  const [venue] = await tx
    .select({ id: venues.id })
    .from(venues)
    .where(and(eq(venues.id, venueId), isNull(venues.deletedAt)));
  if (!venue) throw new NotFoundError('venue', venueId);
}

/**
 * Turn whatever the caller supplied into the instant to store.
 *
 * `kickoffLocal` wins over `kickoffAt` when both are given, because the local
 * form is the one a human typed. Supplying neither, or `null`, leaves the
 * kickoff unset — a fixture whose date is genuinely not yet fixed, which is a
 * different thing from midnight.
 */
async function resolveKickoff(
  tx: Tx,
  orgId: OrgId,
  input: { kickoffLocal?: string | null; kickoffAt?: Date | null },
): Promise<ZonedResolution | null> {
  if (input.kickoffLocal !== undefined && input.kickoffLocal !== null) {
    const timeZone = await getLeagueTimeZone(tx, orgId);
    return resolveZonedWallTime(input.kickoffLocal, timeZone);
  }
  if (input.kickoffLocal === null) return null;
  if (input.kickoffAt) return { instant: input.kickoffAt, kind: 'EXACT' };
  return null;
}

/**
 * The league's IANA zone, used for every local-to-instant conversion.
 *
 * `organizations` is a routing table with an open read policy, so this must
 * filter by id explicitly — RLS will not do it here, and reading whichever row
 * came back first would silently schedule one league's fixtures in another
 * league's timezone.
 */
export async function getLeagueTimeZone(tx: Tx, orgId: OrgId): Promise<string> {
  const [row] = await tx
    .select({ timezone: organizations.timezone })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!row) throw new NotFoundError('organization', orgId);
  return row.timezone;
}

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();
