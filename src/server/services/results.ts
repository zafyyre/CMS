import { and, asc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type Tx, withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  editionEntries,
  fixtures,
  matchEvents,
  resultSubmissions,
  teams,
} from '@/db/schema';
import { recordAudit } from '@/server/audit/record';
import { assertCan, can, ForbiddenError } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import {
  awardEvents,
  type MatchEventFact,
  type MatchEventType,
  type MatchPeriod,
  timelineEvents,
} from '@/server/match/events';
import {
  type MatchReportSource,
  resolveResult,
  type ResolvedResult,
} from '@/server/match/result';
import { recomputeStandingsWithin } from '@/server/standings/recompute';
import { NotFoundError, requireText, ValidationError } from './errors';

/**
 * Results and match events — the two append-only fact tables.
 *
 * Nothing in this file updates a row. A correction to a score inserts a
 * submission that supersedes the earlier one; a correction to a card inserts an
 * event that retracts it. The database enforces this too: the policies on both
 * tables grant SELECT and INSERT only, so a bug here cannot quietly rewrite
 * what a referee reported.
 *
 * The authorization is the interesting part. A team manager may report on
 * their OWN match and only as their OWN side — otherwise a club could submit
 * as `REFEREE` and outrank the actual match official, which
 * `src/server/match/result.ts` would then faithfully honour. Scope decides who
 * may report; the source they are allowed to claim is derived from that same
 * scope rather than accepted from the caller.
 */

export interface SubmitResultInput {
  fixtureId: string;
  source: MatchReportSource;
  homeScore?: number | null;
  awayScore?: number | null;
  homeForfeit?: boolean;
  awayForfeit?: boolean;
  homePenalties?: number | null;
  awayPenalties?: number | null;
  /** Set when this replaces an earlier submission. Requires a reason. */
  supersedesId?: string | null;
  reason?: string | null;
}

export async function submitResult(
  principal: Principal,
  input: SubmitResultInput,
): Promise<{ id: string; result: ResolvedResult }> {
  validateScoreline(input);

  return withOrg(principal.orgId, async (tx) => {
    const sides = await loadFixtureSides(tx, input.fixtureId);

    if (!sides.homeEntryId || !sides.awayEntryId) {
      throw new ValidationError(
        'This fixture does not yet have both teams, so there is nothing to report a score for.',
      );
    }

    assertMayReportAs(principal, sides, input.source);

    if (input.supersedesId) {
      await assertSupersedable(tx, input.fixtureId, input.supersedesId);
      requireText(input.reason, 'reason');
    }

    const [created] = await tx
      .insert(resultSubmissions)
      .values({
        orgId: principal.orgId,
        fixtureId: input.fixtureId,
        source: input.source,
        submittedByPersonId: principal.personId,
        homeScore: input.homeScore ?? null,
        awayScore: input.awayScore ?? null,
        homeForfeit: input.homeForfeit ?? false,
        awayForfeit: input.awayForfeit ?? false,
        homePenalties: input.homePenalties ?? null,
        awayPenalties: input.awayPenalties ?? null,
        supersedesId: input.supersedesId ?? null,
        reason: input.reason?.trim() || null,
      })
      .returning({ id: resultSubmissions.id });

    if (!created) throw new Error('result submission insert returned no row');

    await recordAudit(tx, principal, {
      action: input.supersedesId ? 'result.correct' : 'result.submit',
      entityType: 'resultSubmission',
      entityId: created.id,
      after: {
        fixtureId: input.fixtureId,
        source: input.source,
        homeScore: input.homeScore ?? null,
        awayScore: input.awayScore ?? null,
      },
      reason: input.reason ?? null,
    });

    /**
     * The table follows the facts, in the same transaction.
     *
     * Not a separate step somebody has to remember, and not a background job
     * that can silently fall behind: a result that is visible while the table
     * still shows the old one is the single most common way a league system
     * loses people's trust. Deriving a conclusion from a fact the caller was
     * already permitted to write needs no second authorization — see the note
     * in src/server/standings/recompute.ts.
     */
    await recomputeStandingsWithin(tx, principal.orgId, sides.stageGroupId);

    return { id: created.id, result: await resolveFor(tx, input.fixtureId) };
  });
}

// --- match events ------------------------------------------------------------

export interface MatchEventInput {
  type: MatchEventType;
  period?: MatchPeriod;
  minute?: number | null;
  stoppageMinute?: number | null;
  /** Which side. Must be one of the fixture's two entries. */
  editionEntryId?: string | null;
  personId?: string | null;
  /** The assisting player, or the one coming off. */
  relatedPersonId?: string | null;
  note?: string | null;
}

export async function recordMatchEvents(
  principal: Principal,
  fixtureId: string,
  events: readonly MatchEventInput[],
  options: { source?: MatchReportSource } = {},
): Promise<{ ids: string[] }> {
  assertCan(principal, 'create', { type: 'matchEvent' });
  if (events.length === 0) return { ids: [] };

  return withOrg(principal.orgId, async (tx) => {
    const sides = await loadFixtureSides(tx, fixtureId);
    const allowedEntries = new Set(
      [sides.homeEntryId, sides.awayEntryId].filter((id): id is string => id !== null),
    );

    for (const event of events) {
      if (event.editionEntryId && !allowedEntries.has(event.editionEntryId)) {
        throw new ValidationError(
          'A match event must be credited to one of the two teams playing this fixture.',
        );
      }
      validateMinute(event);
    }

    const inserted = await tx
      .insert(matchEvents)
      .values(
        events.map((event) => ({
          orgId: principal.orgId,
          fixtureId,
          editionEntryId: event.editionEntryId ?? null,
          personId: event.personId ?? null,
          relatedPersonId: event.relatedPersonId ?? null,
          type: event.type,
          period: event.period ?? 'FIRST_HALF',
          minute: event.minute ?? null,
          stoppageMinute: event.stoppageMinute ?? null,
          source: options.source ?? 'REFEREE',
          recordedByPersonId: principal.personId,
          note: event.note ?? null,
        })),
      )
      .returning({ id: matchEvents.id });

    await recordAudit(tx, principal, {
      action: 'matchEvent.record',
      entityType: 'fixture',
      entityId: fixtureId,
      after: { count: inserted.length, types: events.map((e) => e.type) },
    });

    return { ids: inserted.map((row) => row.id) };
  });
}

/**
 * Withdraw an event that should not have been recorded.
 *
 * Inserts a row rather than deleting one, and copies the original's type,
 * period and minute so the retraction is legible on its own — a bare
 * "retracted X" row forces anyone auditing the file to go and look up what X
 * was.
 */
export async function retractMatchEvent(
  principal: Principal,
  eventId: string,
  reason: string,
): Promise<{ id: string }> {
  assertCan(principal, 'delete', { type: 'matchEvent', id: eventId });
  const stated = requireText(reason, 'reason');

  return withOrg(principal.orgId, async (tx) => {
    const [original] = await tx
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.id, eventId));
    if (!original) throw new NotFoundError('matchEvent', eventId);
    if (original.retractsEventId) {
      throw new ValidationError('That row is itself a retraction and cannot be retracted.');
    }

    const [already] = await tx
      .select({ id: matchEvents.id })
      .from(matchEvents)
      .where(eq(matchEvents.retractsEventId, eventId));
    if (already) throw new ValidationError('That event has already been retracted.');

    const [created] = await tx
      .insert(matchEvents)
      .values({
        orgId: principal.orgId,
        fixtureId: original.fixtureId,
        editionEntryId: original.editionEntryId,
        personId: original.personId,
        relatedPersonId: original.relatedPersonId,
        type: original.type,
        period: original.period,
        minute: original.minute,
        stoppageMinute: original.stoppageMinute,
        source: original.source,
        recordedByPersonId: principal.personId,
        retractsEventId: eventId,
        note: stated,
      })
      .returning({ id: matchEvents.id });

    if (!created) throw new Error('retraction insert returned no row');

    await recordAudit(tx, principal, {
      action: 'matchEvent.retract',
      entityType: 'matchEvent',
      entityId: eventId,
      before: { type: original.type, minute: original.minute, personId: original.personId },
      reason: stated,
    });

    return created;
  });
}

// --- reads -------------------------------------------------------------------

export interface MatchReport {
  fixtureId: string;
  result: ResolvedResult;
  /** Incidents on the pitch, in the order they happened. */
  events: (MatchEventFact & { note: string | null; source: MatchReportSource })[];
  /**
   * Player of the match and clean sheets — kept out of the timeline because
   * they describe the whole match rather than a moment in it, and a null-minute
   * entry at the end of every timeline is noise.
   */
  awards: (MatchEventFact & { note: string | null; source: MatchReportSource })[];
  submissions: {
    id: string;
    source: MatchReportSource;
    homeScore: number | null;
    awayScore: number | null;
    supersedesId: string | null;
    reason: string | null;
    createdAt: Date;
  }[];
}

/**
 * Everything reported about one match, including the superseded claims.
 *
 * The superseded submissions are returned on purpose. "What did the away team
 * originally say?" is the first question asked in any protest, and a read
 * model that hides corrections makes the append-only table pointless.
 */
export async function getMatchReport(orgId: OrgId, fixtureId: string): Promise<MatchReport> {
  return withOrg(orgId, async (tx) => {
    const submissions = await tx
      .select()
      .from(resultSubmissions)
      .where(eq(resultSubmissions.fixtureId, fixtureId))
      .orderBy(asc(resultSubmissions.createdAt), asc(resultSubmissions.id));

    const events = await tx
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.fixtureId, fixtureId));

    return {
      fixtureId,
      result: resolveResult(submissions),
      events: timelineEvents(events).map(toReportEvent),
      awards: awardEvents(events).map(toReportEvent),
      submissions: submissions.map((s) => ({
        id: s.id,
        source: s.source as MatchReportSource,
        homeScore: s.homeScore,
        awayScore: s.awayScore,
        supersedesId: s.supersedesId,
        reason: s.reason,
        createdAt: s.createdAt,
      })),
    };
  });
}

// --- internals ---------------------------------------------------------------

type StoredEvent = {
  id: string;
  type: string;
  period: string;
  minute: number | null;
  stoppageMinute: number | null;
  editionEntryId: string | null;
  personId: string | null;
  retractsEventId: string | null;
  note: string | null;
  source: string;
};

const toReportEvent = (event: StoredEvent) => ({
  id: event.id,
  type: event.type as MatchEventType,
  period: event.period as MatchPeriod,
  minute: event.minute,
  stoppageMinute: event.stoppageMinute,
  editionEntryId: event.editionEntryId,
  personId: event.personId,
  retractsEventId: event.retractsEventId,
  note: event.note,
  source: event.source as MatchReportSource,
});

interface FixtureSides {
  fixtureId: string;
  stageGroupId: string;
  homeEntryId: string | null;
  homeTeamId: string | null;
  homeClubId: string | null;
  awayEntryId: string | null;
  awayTeamId: string | null;
  awayClubId: string | null;
}

async function loadFixtureSides(tx: Tx, fixtureId: string): Promise<FixtureSides> {
  const homeEntry = alias(editionEntries, 'home_entry');
  const awayEntry = alias(editionEntries, 'away_entry');
  const homeTeam = alias(teams, 'home_team');
  const awayTeam = alias(teams, 'away_team');

  const [row] = await tx
    .select({
      fixtureId: fixtures.id,
      stageGroupId: fixtures.stageGroupId,
      homeEntryId: fixtures.homeEntryId,
      homeTeamId: homeTeam.id,
      homeClubId: homeTeam.clubId,
      awayEntryId: fixtures.awayEntryId,
      awayTeamId: awayTeam.id,
      awayClubId: awayTeam.clubId,
    })
    .from(fixtures)
    .leftJoin(homeEntry, eq(fixtures.homeEntryId, homeEntry.id))
    .leftJoin(homeTeam, eq(homeEntry.teamId, homeTeam.id))
    .leftJoin(awayEntry, eq(fixtures.awayEntryId, awayEntry.id))
    .leftJoin(awayTeam, eq(awayEntry.teamId, awayTeam.id))
    .where(and(eq(fixtures.id, fixtureId), isNull(fixtures.deletedAt)));

  if (!row) throw new NotFoundError('fixture', fixtureId);
  return row;
}

/**
 * May this principal report on this match, and as whom?
 *
 * The `source` is checked against the caller's scope rather than trusted. A
 * team manager holds a TEAM-scoped grant, so `can()` only says yes when the
 * resource carries their team — which lets us work out which side they are and
 * refuse any source but that one. Without this the append-only design would be
 * defeated in the most direct way available: a club submitting as `REFEREE`,
 * outranking the referee, and quietly deciding its own result.
 */
function assertMayReportAs(
  principal: Principal,
  sides: FixtureSides,
  source: MatchReportSource,
): void {
  // No club or team attribution, so only an ORGANIZATION-scoped grant passes.
  const leagueWide = can(principal, 'create', { type: 'result' });
  const asHome = can(principal, 'create', {
    type: 'result',
    teamId: sides.homeTeamId,
    clubId: sides.homeClubId,
  });
  const asAway = can(principal, 'create', {
    type: 'result',
    teamId: sides.awayTeamId,
    clubId: sides.awayClubId,
  });

  if (!leagueWide && !asHome && !asAway) {
    throw new ForbiddenError('create', 'result', 'you are not involved in this fixture');
  }

  if (leagueWide) return;

  const permitted: MatchReportSource[] = [];
  if (asHome) permitted.push('HOME_TEAM');
  if (asAway) permitted.push('AWAY_TEAM');

  if (!permitted.includes(source)) {
    throw new ForbiddenError(
      'create',
      'result',
      `you may only report as ${permitted.join(' or ')}, not as ${source}`,
    );
  }
}

async function assertSupersedable(
  tx: Tx,
  fixtureId: string,
  supersedesId: string,
): Promise<void> {
  const [target] = await tx
    .select({ id: resultSubmissions.id, fixtureId: resultSubmissions.fixtureId })
    .from(resultSubmissions)
    .where(eq(resultSubmissions.id, supersedesId));

  if (!target) throw new NotFoundError('resultSubmission', supersedesId);
  if (target.fixtureId !== fixtureId) {
    throw new ValidationError('A correction must supersede a submission for the same fixture.');
  }

  const [already] = await tx
    .select({ id: resultSubmissions.id })
    .from(resultSubmissions)
    .where(eq(resultSubmissions.supersedesId, supersedesId));

  if (already) {
    throw new ValidationError(
      'That submission has already been corrected. Correct the most recent one instead.',
    );
  }
}

async function resolveFor(tx: Tx, fixtureId: string): Promise<ResolvedResult> {
  const submissions = await tx
    .select()
    .from(resultSubmissions)
    .where(eq(resultSubmissions.fixtureId, fixtureId));
  return resolveResult(submissions);
}

function validateScoreline(input: SubmitResultInput): void {
  const home = input.homeScore ?? null;
  const away = input.awayScore ?? null;

  // Both or neither. "3–null" is not a score anyone means.
  if ((home === null) !== (away === null)) {
    throw new ValidationError('Report both scores, or neither.');
  }
  for (const [label, value] of [
    ['homeScore', home],
    ['awayScore', away],
    ['homePenalties', input.homePenalties ?? null],
    ['awayPenalties', input.awayPenalties ?? null],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new ValidationError(`${label} must be a whole number of 0 or more.`);
    }
  }
  if (input.homeForfeit && input.awayForfeit) {
    throw new ValidationError(
      'Both teams cannot forfeit to each other. Mark the fixture ABANDONED instead.',
    );
  }
}

function validateMinute(event: MatchEventInput): void {
  if (event.minute !== null && event.minute !== undefined) {
    if (!Number.isInteger(event.minute) || event.minute < 0 || event.minute > 200) {
      throw new ValidationError('minute must be a whole number between 0 and 200.');
    }
  }
  if (event.stoppageMinute !== null && event.stoppageMinute !== undefined) {
    if (
      !Number.isInteger(event.stoppageMinute) ||
      event.stoppageMinute < 0 ||
      event.stoppageMinute > 60
    ) {
      throw new ValidationError('stoppageMinute must be a whole number between 0 and 60.');
    }
  }
}
