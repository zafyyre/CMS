import { and, eq, isNull } from 'drizzle-orm';
import { withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import { editionEntries, stageGroups, teams, venues } from '@/db/schema';
import { buildCalendar, type CalendarEvent } from '@/lib/ics';
import { type FixtureView, listFixtures } from './fixtures';

/**
 * Calendar feeds, per team, per competition and per venue.
 *
 * The feature the old site has no equivalent of, and the one that changes the
 * relationship between a league and its players: a fixture list you have to
 * remember to check is a fixture list you will miss a change to. A subscribed
 * calendar puts every reschedule into six thousand phones without anybody
 * being told to look.
 *
 * Which makes the UID rule below load-bearing rather than pedantic.
 */

export interface FeedRequest {
  orgId: OrgId;
  /** The site's own origin, for absolute links inside each event. */
  origin: string;
  leagueName: string;
  timeZone: string;
}

export async function teamCalendar(
  request: FeedRequest,
  teamId: string,
): Promise<{ name: string; body: string } | null> {
  const entries = await withOrg(request.orgId, (tx) =>
    tx
      .select({ entryId: editionEntries.id, teamName: teams.name })
      .from(editionEntries)
      .innerJoin(teams, eq(editionEntries.teamId, teams.id))
      .where(
        and(
          eq(editionEntries.teamId, teamId),
          isNull(editionEntries.deletedAt),
          isNull(teams.deletedAt),
        ),
      ),
  );

  const teamName = entries[0]?.teamName;
  if (!teamName) return null;

  // A team's calendar spans every competition it is entered in — a player does
  // not think of the cup as a different calendar from the league.
  const collected: FixtureView[] = [];
  for (const entry of entries) {
    collected.push(...(await listFixtures(request.orgId, { entryId: entry.entryId })));
  }

  const name = `${teamName} — ${request.leagueName}`;
  return {
    name,
    body: buildCalendar(datedOnly(dedupe(collected)).map((f) => toEvent(f, request)), {
      name,
      description: `Fixtures and results for ${teamName}.`,
      timeZone: request.timeZone,
    }),
  };
}

export async function competitionCalendar(
  request: FeedRequest,
  editionId: string,
): Promise<{ name: string; body: string } | null> {
  const fixtures = await listFixtures(request.orgId, { editionId });
  const competitionName = fixtures[0]?.competitionName;
  if (!competitionName) return null;

  const name = `${competitionName} — ${request.leagueName}`;
  return {
    name,
    body: buildCalendar(datedOnly(fixtures).map((f) => toEvent(f, request)), {
      name,
      description: `Every fixture in ${competitionName}.`,
      timeZone: request.timeZone,
    }),
  };
}

export async function venueCalendar(
  request: FeedRequest,
  venueId: string,
): Promise<{ name: string; body: string } | null> {
  const [venue] = await withOrg(request.orgId, (tx) =>
    tx
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(and(eq(venues.id, venueId), isNull(venues.deletedAt))),
  );
  if (!venue) return null;

  const fixtures = await listFixtures(request.orgId, { venueId });
  const name = `${venue.name} — ${request.leagueName}`;
  return {
    name,
    body: buildCalendar(datedOnly(fixtures).map((f) => toEvent(f, request)), {
      name,
      description: `Everything scheduled at ${venue.name}. Useful to a groundskeeper as well as a player.`,
      timeZone: request.timeZone,
    }),
  };
}

export async function groupCalendar(
  request: FeedRequest,
  stageGroupId: string,
): Promise<{ name: string; body: string } | null> {
  const [group] = await withOrg(request.orgId, (tx) =>
    tx
      .select({ name: stageGroups.name })
      .from(stageGroups)
      .where(and(eq(stageGroups.id, stageGroupId), isNull(stageGroups.deletedAt))),
  );
  if (!group) return null;

  const fixtures = await listFixtures(request.orgId, { stageGroupId });
  const name = `${group.name} — ${request.leagueName}`;
  return {
    name,
    body: buildCalendar(datedOnly(fixtures).map((f) => toEvent(f, request)), {
      name,
      timeZone: request.timeZone,
    }),
  };
}

// ---------------------------------------------------------------------------

/**
 * One fixture, as a calendar event.
 *
 * ── THE UID RULE ────────────────────────────────────────────────────────────
 * The UID is the fixture's own id and NOTHING ELSE. Not the kickoff time, not
 * a hash of the teams, not anything that changes when the fixture does.
 *
 * If the UID changed on a reschedule, every subscriber would receive a NEW
 * event rather than an update to the existing one — leaving the old match in
 * their calendar forever. Over a season of reschedules a player ends up with a
 * calendar full of games that are not happening, which is worse than having no
 * feed at all, and they cannot fix it without unsubscribing.
 * ────────────────────────────────────────────────────────────────────────────
 */
function toEvent(fixture: FixtureView, request: FeedRequest): CalendarEvent {
  const home = fixture.homeTeamName ?? 'To be confirmed';
  const away = fixture.awayTeamName ?? 'To be confirmed';
  const scoreline = fixture.result.scoreline;

  const summary =
    fixture.result.state === 'CONFIRMED' && scoreline
      ? `${home} ${scoreline.homeScore ?? '–'}–${scoreline.awayScore ?? '–'} ${away}`
      : `${home} v ${away}`;

  const detail = [
    fixture.competitionName,
    fixture.stageGroupName !== fixture.competitionName ? fixture.stageGroupName : null,
    fixture.publicNote,
    fixture.result.state === 'DISPUTED' ? 'The result of this match is disputed.' : null,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    uid: `fixture-${fixture.id}@${new URL(request.origin).host}`,
    // A fixture with no date yet cannot be an event; the caller filters these.
    start: fixture.kickoffAt as Date,
    summary,
    description: detail || undefined,
    location: fixture.venueName ?? undefined,
    url: `${request.origin}/fixtures/${fixture.id}`,
    status:
      fixture.status === 'CANCELLED'
        ? 'CANCELLED'
        : fixture.status === 'POSTPONED'
          ? 'TENTATIVE'
          : 'CONFIRMED',
  };
}

/** A team entered in two competitions can reach the same fixture twice. */
const dedupe = (fixtures: FixtureView[]): FixtureView[] => {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  return [...byId.values()];
};

/** Fixtures with no kickoff cannot be calendar events; everything else can. */
export const datedOnly = (fixtures: FixtureView[]): FixtureView[] =>
  fixtures.filter((f) => f.kickoffAt !== null);
