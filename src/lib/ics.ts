/**
 * iCalendar feeds, hand-written.
 *
 * RFC 5545 is fussy in ways that produce silent failures rather than errors:
 * Apple Calendar will accept a feed and show nothing, and Google will subscribe
 * and never refresh, and neither tells you why. The rules that actually bite,
 * all handled here:
 *
 *   - CRLF line endings. Not LF. Every line.
 *   - Lines folded at 75 OCTETS — not characters. A club name with an accent
 *     in it is multi-byte, and folding by character length splits a UTF-8
 *     sequence down the middle.
 *   - Commas, semicolons and backslashes escaped in TEXT values; newlines
 *     written as a literal `\n`.
 *   - A stable UID per event, forever. This is the one that matters most: if
 *     the UID changes when a fixture is rescheduled, subscribers get a second
 *     event instead of an updated one, and a season of reschedules leaves
 *     everyone with a calendar full of matches that are not happening.
 *   - SEQUENCE incremented on change, so clients accept the update.
 *
 * No dependency, because the whole format is about four hundred bytes of rules
 * and an ICS library is a thing to keep upgrading forever.
 */

export interface CalendarEvent {
  /** Stable for the life of the fixture. Never derived from the kickoff time. */
  uid: string;
  start: Date;
  /** Defaults to 105 minutes after the start: 90 plus half-time. */
  end?: Date;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  /** Incremented whenever the event changes, so clients take the update. */
  sequence?: number;
  /** Last time this fixture was modified, for DTSTAMP. */
  updatedAt?: Date;
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
}

export interface CalendarOptions {
  /** Shown as the calendar's name in the subscriber's client. */
  name: string;
  description?: string;
  /** The league's IANA zone. Written as X-WR-TIMEZONE for display only. */
  timeZone?: string;
  /** How often a client should re-fetch. Match days want an hour, not a day. */
  refreshInterval?: string;
}

const DEFAULT_DURATION_MS = 105 * 60 * 1000;

export function buildCalendar(
  events: readonly CalendarEvent[],
  options: CalendarOptions,
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    // PRODID identifies the generator. Required, and clients log it when
    // something goes wrong, so it is worth being specific.
    'PRODID:-//League CMS//Fixtures//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(options.name)}`,
  ];

  if (options.description) {
    lines.push(`X-WR-CALDESC:${escapeText(options.description)}`);
  }
  if (options.timeZone) {
    lines.push(`X-WR-TIMEZONE:${escapeText(options.timeZone)}`);
  }
  // Both spellings: the standard one and the Apple one that predates it.
  const refresh = options.refreshInterval ?? 'PT1H';
  lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${refresh}`);
  lines.push(`X-PUBLISHED-TTL:${refresh}`);

  for (const event of events) {
    lines.push(...eventLines(event));
  }

  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function eventLines(event: CalendarEvent): string[] {
  const end = event.end ?? new Date(event.start.getTime() + DEFAULT_DURATION_MS);
  const lines = [
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    // DTSTAMP is when this representation was produced. Using the fixture's
    // own updatedAt keeps the output byte-identical between requests, so a
    // client's conditional fetch can actually short-circuit.
    `DTSTAMP:${toUtcStamp(event.updatedAt ?? event.start)}`,
    // Kickoffs are instants, written in UTC with the Z suffix, so no client
    // has to agree with us about a timezone database.
    `DTSTART:${toUtcStamp(event.start)}`,
    `DTEND:${toUtcStamp(end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `SEQUENCE:${event.sequence ?? 0}`,
    `STATUS:${event.status ?? 'CONFIRMED'}`,
    'TRANSP:OPAQUE',
  ];

  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.url) lines.push(`URL:${escapeText(event.url)}`);

  lines.push('END:VEVENT');
  return lines;
}

/** `20260308T210000Z`. */
export function toUtcStamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Escapes the four characters RFC 5545 reserves in a TEXT value.
 *
 * The backslash must be replaced first, or the escapes inserted afterwards get
 * escaped in turn and the client shows `Rutland\\, Rovers`.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Fold a line at 75 OCTETS, continuing with a leading space.
 *
 * Counting characters instead of bytes is the subtle version of this bug: a
 * name containing "Peñarol" is longer in UTF-8 than in JavaScript's view of
 * it, so a character-counted fold produces a line over the limit — and, worse,
 * a fold placed mid-sequence emits a broken code point that some clients
 * reject outright.
 */
export function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;

  const pieces: string[] = [];
  let offset = 0;
  let limit = 75;

  while (offset < bytes.length) {
    let take = Math.min(limit, bytes.length - offset);
    // Walk back off a continuation byte (10xxxxxx) so a multi-byte character
    // is never split across the fold.
    while (take > 0 && offset + take < bytes.length) {
      const next = bytes[offset + take] as number;
      if ((next & 0b1100_0000) !== 0b1000_0000) break;
      take--;
    }
    /* c8 ignore next -- only reachable if a single character exceeded 75 bytes */
    if (take <= 0) take = Math.min(limit, bytes.length - offset);

    pieces.push(bytes.subarray(offset, offset + take).toString('utf8'));
    offset += take;
    // Continuation lines carry a leading space, which counts towards the 75.
    limit = 74;
  }

  return pieces.join('\r\n ');
}
