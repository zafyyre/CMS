/**
 * Which match events still stand.
 *
 * `match_events` is append-only, so a mis-recorded card is corrected by
 * inserting a row that RETRACTS it rather than by deleting anything. Every
 * consumer — the goalscorer table in Phase 4, the disciplinary case in
 * Phase 11, the live timeline in Phase 12 — therefore has to filter the
 * retracted ones out, and every one of them getting that filter subtly
 * different is how a player ends up suspended for a card that was withdrawn.
 *
 * So the filter lives here once, pure and tested.
 */

export type MatchEventType =
  | 'GOAL'
  | 'OWN_GOAL'
  | 'PENALTY_SCORED'
  | 'PENALTY_MISSED'
  | 'YELLOW_CARD'
  | 'SECOND_YELLOW_CARD'
  | 'RED_CARD'
  | 'SUBSTITUTION'
  /**
   * Awards rather than incidents. They carry no minute, and they are events
   * rather than columns on a result so that they inherit the attribution and
   * retraction machinery every other match fact already has.
   */
  | 'MVP'
  | 'CLEAN_SHEET';

/** Events that describe the whole match rather than a moment within it. */
export const MATCH_LEVEL_EVENT_TYPES: readonly MatchEventType[] = ['MVP', 'CLEAN_SHEET'];

export type MatchPeriod =
  | 'FIRST_HALF'
  | 'SECOND_HALF'
  | 'EXTRA_TIME_FIRST'
  | 'EXTRA_TIME_SECOND'
  | 'PENALTY_SHOOTOUT';

export interface MatchEventFact {
  id: string;
  type: MatchEventType;
  period: MatchPeriod;
  minute: number | null;
  stoppageMinute: number | null;
  editionEntryId: string | null;
  personId: string | null;
  retractsEventId: string | null;
}

/**
 * The events that count: those not withdrawn, and not themselves withdrawals.
 *
 * A retraction row is bookkeeping, not something that happened on the pitch,
 * so it is excluded from the timeline as well as its target.
 */
export function liveEvents<T extends MatchEventFact>(events: readonly T[]): T[] {
  const retracted = new Set(
    events.map((e) => e.retractsEventId).filter((id): id is string => id !== null),
  );
  return events.filter((e) => e.retractsEventId === null && !retracted.has(e.id));
}

/**
 * Events that add to a team's score.
 *
 * PENALTY_SHOOTOUT is excluded, and this is the whole reason `period` is
 * recorded. A shootout decides who advances; its conversions are not goals.
 * Counting them inflates every goalscorer table and every goal difference in
 * the league — the classic version of this bug, invisible until a cup season
 * ends and someone wins the Golden Boot on penalties.
 *
 * An own goal counts for the OTHER side, which is why this returns the side it
 * is credited to rather than a boolean.
 */
export function scoringEvents<T extends MatchEventFact>(events: readonly T[]): T[] {
  return liveEvents(events).filter(
    (e) =>
      e.period !== 'PENALTY_SHOOTOUT' &&
      (e.type === 'GOAL' || e.type === 'OWN_GOAL' || e.type === 'PENALTY_SCORED'),
  );
}

/** Events that a disciplinary process has to look at. */
export function disciplinaryEvents<T extends MatchEventFact>(events: readonly T[]): T[] {
  return liveEvents(events).filter(
    (e) =>
      e.type === 'YELLOW_CARD' || e.type === 'SECOND_YELLOW_CARD' || e.type === 'RED_CARD',
  );
}

/** Awards, for the leaderboards that read them. */
export function awardEvents<T extends MatchEventFact>(events: readonly T[]): T[] {
  return liveEvents(events).filter((e) => MATCH_LEVEL_EVENT_TYPES.includes(e.type));
}

/**
 * The timeline: incidents on the pitch, in the order they happened.
 *
 * Awards are excluded — a player of the match is not a moment in the match, and
 * putting it in the timeline at minute null means every match ends with an
 * event nobody can place.
 */
export function timelineEvents<T extends MatchEventFact>(events: readonly T[]): T[] {
  return inMatchOrder(liveEvents(events).filter((e) => !MATCH_LEVEL_EVENT_TYPES.includes(e.type)));
}

/**
 * Chronological order, with the unknown-minute events last.
 *
 * `minute` is nullable because a referee genuinely does not always know, and
 * sorting nulls as zero would open every timeline with the events nobody could
 * place.
 */
export function inMatchOrder<T extends MatchEventFact>(events: readonly T[]): T[] {
  const PERIOD_ORDER: Record<MatchPeriod, number> = {
    FIRST_HALF: 0,
    SECOND_HALF: 1,
    EXTRA_TIME_FIRST: 2,
    EXTRA_TIME_SECOND: 3,
    PENALTY_SHOOTOUT: 4,
  };
  return [...events].sort((a, b) => {
    const period = PERIOD_ORDER[a.period] - PERIOD_ORDER[b.period];
    if (period !== 0) return period;
    if (a.minute === null && b.minute === null) return a.id < b.id ? -1 : 1;
    if (a.minute === null) return 1;
    if (b.minute === null) return -1;
    if (a.minute !== b.minute) return a.minute - b.minute;
    const stoppage = (a.stoppageMinute ?? 0) - (b.stoppageMinute ?? 0);
    if (stoppage !== 0) return stoppage;
    // Total order: UUIDv7 ids are time-ordered, so this is also chronological.
    return a.id < b.id ? -1 : 1;
  });
}
