/**
 * Wall-clock time in a league's timezone, and the single conversion between it
 * and the instants stored in the database.
 *
 * THE RULE, and it has no exceptions: every timestamp in PostgreSQL is
 * `timestamptz` holding a UTC instant. A local time only ever exists at the
 * two edges of the system — the form where a scheduler types "Saturday 14:00",
 * and the page where a player reads it back. This module is both edges.
 *
 * Why it is worth a dedicated file rather than a `new Date(...)` at each call
 * site: on 8 March 2026 the clocks in Vancouver go forward, so 02:30 that
 * morning does not exist, and on 1 November they go back, so 01:30 happens
 * twice. A naive conversion silently produces a kickoff an hour wrong for the
 * weeks between those dates. A schedule that is wrong twice a year destroys
 * trust faster than almost any other bug in this system, and it is invisible
 * to anyone testing in July.
 *
 * There is no dependency here. `Intl.DateTimeFormat` already carries the full
 * IANA database, and the conversion below is derived from it, so a timezone
 * rule change arrives with the runtime rather than with an npm upgrade.
 */

/** A local date and time with no zone attached — "2026-03-08T14:00". */
export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
}

export class InvalidWallTimeError extends Error {
  constructor(value: string) {
    super(`Not a local date-time of the form YYYY-MM-DDTHH:mm[:ss]: ${JSON.stringify(value)}`);
    this.name = 'InvalidWallTimeError';
  }
}

/**
 * Thrown for a local time that the calendar skips over.
 *
 * Deliberately an error rather than a silent nudge to the next valid minute.
 * Nobody schedules a match at 02:30 on the morning the clocks change; a
 * fixture landing there is a typo or a botched import, and the honest response
 * is to say so at the point of entry rather than to store a time that is one
 * hour from what was typed and looks perfectly reasonable afterwards.
 */
export class NonExistentLocalTimeError extends Error {
  constructor(
    readonly wall: string,
    readonly timeZone: string,
  ) {
    super(
      `${wall} does not exist in ${timeZone} — the clocks go forward across it. ` +
        'Choose a time before or after the transition.',
    );
    this.name = 'NonExistentLocalTimeError';
  }
}

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function parseWallTime(value: string): WallTime {
  const match = WALL_RE.exec(value.trim());
  if (!match) throw new InvalidWallTimeError(value);

  const [, y, mo, d, h, mi, s] = match;
  const wall: WallTime = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: s ? Number(s) : 0,
  };

  // Rejects 31 February and 25:00, which the regex alone cannot: Date.UTC
  // rolls those over into the following month or day rather than complaining.
  const roundTrip = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
  );
  if (
    roundTrip.getUTCFullYear() !== wall.year ||
    roundTrip.getUTCMonth() !== wall.month - 1 ||
    roundTrip.getUTCDate() !== wall.day ||
    roundTrip.getUTCHours() !== wall.hour ||
    roundTrip.getUTCMinutes() !== wall.minute
  ) {
    throw new InvalidWallTimeError(value);
  }

  return wall;
}

export const formatWallTime = (wall: WallTime): string =>
  `${String(wall.year).padStart(4, '0')}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}` +
  (wall.second ? `:${pad(wall.second)}` : '');

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Formatters are expensive to construct and this runs once per fixture on a
 * schedule page listing hundreds.
 */
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // `hourCycle: 'h23'` rather than `hour12: false`. The latter reports
      // midnight as hour 24 in some ICU versions, which is off by a day.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading a wall clock in `timeZone` shows at `instant`. */
export function instantToWallTime(instant: Date, timeZone: string): WallTime {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`Intl did not report ${type} for ${timeZone}`);
    return Number(found.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The zone's UTC offset at a given instant, in milliseconds.
 *
 * Positive east of Greenwich. Vancouver returns -28_800_000 in winter and
 * -25_200_000 in summer.
 */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const wall = instantToWallTime(instant, timeZone);
  const asIfUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  // Milliseconds are not reported by the formatter, so compare on whole
  // seconds — otherwise a non-zero millisecond field shifts the answer.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export interface ZonedResolution {
  /** The UTC instant to store. */
  instant: Date;
  /**
   * `AMBIGUOUS` means the clocks went back across this local time, so it
   * happened twice. `instant` is the FIRST occurrence — still daylight time,
   * which is what a person writing "01:30" on that morning almost always
   * means — and `alternative` is the second.
   */
  kind: 'EXACT' | 'AMBIGUOUS';
  alternative?: Date;
}

/**
 * Turn a local date-time in `timeZone` into the instant to store.
 *
 * The approach: a local time is at most two instants — one for each side of a
 * possible transition — so sample the zone's offset a day either side, build a
 * candidate from each, and keep those that actually read back as the requested
 * local time. None surviving means the calendar skips it. Two surviving means
 * it happened twice.
 *
 * This is exact by construction rather than by iteration: it asks the runtime's
 * own timezone database what the clock reads, and believes only the answers
 * that agree with the question.
 *
 * @throws NonExistentLocalTimeError when the local time is skipped by a
 *   forward transition.
 */
export function resolveZonedWallTime(
  wall: WallTime | string,
  timeZone: string,
): ZonedResolution {
  const parsed = typeof wall === 'string' ? parseWallTime(wall) : wall;
  const naive = Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    parsed.hour,
    parsed.minute,
    parsed.second,
  );

  const DAY = 86_400_000;
  const offsets = new Set([
    timeZoneOffsetMs(new Date(naive - DAY), timeZone),
    timeZoneOffsetMs(new Date(naive + DAY), timeZone),
  ]);

  const matches = [...offsets]
    .map((offset) => new Date(naive - offset))
    .filter((candidate) => sameWallTime(instantToWallTime(candidate, timeZone), parsed))
    // Deterministic ordering, so "the first occurrence" is a stable claim.
    .sort((a, b) => a.getTime() - b.getTime());

  const [first, second] = matches;
  if (!first) throw new NonExistentLocalTimeError(formatWallTime(parsed), timeZone);
  if (second) return { instant: first, kind: 'AMBIGUOUS', alternative: second };
  return { instant: first, kind: 'EXACT' };
}

/** `resolveZonedWallTime`, for callers that do not need to know about the edge cases. */
export const zonedWallTimeToInstant = (wall: WallTime | string, timeZone: string): Date =>
  resolveZonedWallTime(wall, timeZone).instant;

const sameWallTime = (a: WallTime, b: WallTime): boolean =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute &&
  a.second === b.second;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(
  timeZone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let formatter = displayFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { ...options, timeZone });
    displayFormatters.set(key, formatter);
  }
  return formatter;
}

export interface KickoffFormatOptions {
  locale?: string;
  /** Include the zone abbreviation (PST/PDT). Worth it on a date near a change. */
  withZone?: boolean;
}

/** "Sun, 8 Mar 2026, 14:00 PDT" — the schedule page's line. */
export function formatKickoff(
  instant: Date,
  timeZone: string,
  { locale = 'en-CA', withZone = true }: KickoffFormatOptions = {},
): string {
  return displayFormatter(timeZone, locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(withZone ? { timeZoneName: 'short' } : {}),
  }).format(instant);
}

/** "14:00" — for a table where the date is already the row group. */
export function formatKickoffTime(
  instant: Date,
  timeZone: string,
  locale = 'en-CA',
): string {
  return displayFormatter(timeZone, locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}

/**
 * The calendar date in the league's zone, as `YYYY-MM-DD`.
 *
 * This is what a schedule groups by, and it is emphatically not
 * `instant.toISOString().slice(0, 10)`: a 19:00 Saturday kickoff in Vancouver
 * is 03:00 Sunday in UTC, so the naive version files half the weekend's
 * matches under the wrong day.
 */
export function leagueDateKey(instant: Date, timeZone: string): string {
  const wall = instantToWallTime(instant, timeZone);
  return `${String(wall.year).padStart(4, '0')}-${pad(wall.month)}-${pad(wall.day)}`;
}

/**
 * Midnight-to-midnight in the league's zone, as the instants to query with.
 *
 * The end bound is built from the NEXT calendar date, not from `start` plus
 * twenty-four hours: a day containing a transition is 23 or 25 hours long, and
 * the arithmetic version loses or duplicates an hour of fixtures exactly on
 * the two weekends when the schedule is already confusing.
 *
 * The range is half-open — `start <= kickoff < end` — so a midnight kickoff
 * belongs to one day and not to both.
 */
export function leagueDayBounds(dateKey: string, timeZone: string): { start: Date; end: Date } {
  return { start: startOfLeagueDay(dateKey, timeZone), end: startOfLeagueDay(nextDateKey(dateKey), timeZone) };
}

/**
 * A handful of zones move their clocks at midnight, so the day's first local
 * instant is not always 00:00 — in São Paulo it used to be 01:00. Walk forward
 * in half-hour steps until the calendar admits one, which also covers Lord
 * Howe Island's thirty-minute shift.
 */
function startOfLeagueDay(dateKey: string, timeZone: string): Date {
  for (const time of ['00:00', '00:30', '01:00', '01:30']) {
    try {
      return zonedWallTimeToInstant(`${dateKey}T${time}`, timeZone);
    } catch (error) {
      if (!(error instanceof NonExistentLocalTimeError)) throw error;
    }
  }
  throw new NonExistentLocalTimeError(`${dateKey}T00:00`, timeZone);
}

function nextDateKey(dateKey: string): string {
  const wall = parseWallTime(`${dateKey}T00:00`);
  const next = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + 86_400_000);
  return next.toISOString().slice(0, 10);
}
