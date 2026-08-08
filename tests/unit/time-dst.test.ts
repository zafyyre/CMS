import { describe, expect, it } from 'vitest';
import {
  formatKickoff,
  formatKickoffTime,
  instantToWallTime,
  InvalidWallTimeError,
  leagueDateKey,
  leagueDayBounds,
  NonExistentLocalTimeError,
  parseWallTime,
  resolveZonedWallTime,
  timeZoneOffsetMs,
  zonedWallTimeToInstant,
} from '@/lib/time';

/**
 * The daylight-saving suite. Named in the build plan as one of the tests that
 * must exist and must never be deleted.
 *
 * What it guards: a schedule that shows the wrong kickoff time twice a year.
 * That bug destroys trust in a fixtures system faster than almost anything
 * else, it is invisible to anyone testing in July, and by the time it is
 * noticed several hundred people have turned up an hour late.
 *
 * Vancouver in 2026:
 *   - 08 March, 02:00 PST becomes 03:00 PDT. 02:00–02:59 never happens.
 *   - 01 November, 02:00 PDT becomes 01:00 PST. 01:00–01:59 happens twice.
 * PST is UTC-8; PDT is UTC-7.
 */

const VANCOUVER = 'America/Vancouver';
const iso = (date: Date) => date.toISOString();

describe('the same wall-clock kickoff is a different instant either side of a transition', () => {
  it('stores a 14:00 Saturday as 22:00Z in winter and 21:00Z in summer', () => {
    // The single assertion this whole file exists for. A naive implementation
    // that adds a fixed offset gets one of these two wrong.
    expect(iso(zonedWallTimeToInstant('2026-03-07T14:00', VANCOUVER))).toBe(
      '2026-03-07T22:00:00.000Z',
    );
    expect(iso(zonedWallTimeToInstant('2026-03-08T14:00', VANCOUVER))).toBe(
      '2026-03-08T21:00:00.000Z',
    );
  });

  it('does the same across the November transition, in the other direction', () => {
    expect(iso(zonedWallTimeToInstant('2026-10-31T14:00', VANCOUVER))).toBe(
      '2026-10-31T21:00:00.000Z',
    );
    expect(iso(zonedWallTimeToInstant('2026-11-01T14:00', VANCOUVER))).toBe(
      '2026-11-01T22:00:00.000Z',
    );
  });

  it('round-trips every stored instant back to the wall time that was typed', () => {
    for (const local of [
      '2026-03-07T14:00',
      '2026-03-08T14:00',
      '2026-03-08T03:00',
      '2026-03-08T01:59',
      '2026-10-31T19:30',
      '2026-11-01T14:00',
      '2026-06-21T09:15',
      '2026-12-25T11:45',
    ]) {
      const instant = zonedWallTimeToInstant(local, VANCOUVER);
      const wall = instantToWallTime(instant, VANCOUVER);
      const rendered =
        `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}` +
        `T${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
      expect(rendered, `${local} did not survive the round trip`).toBe(local);
    }
  });
});

describe('the hour that does not exist', () => {
  it('refuses 02:30 on the morning the clocks go forward', () => {
    // Rejected rather than nudged. A fixture landing here is a typo or a
    // botched import, and storing "one hour from what was typed" is precisely
    // the failure this module exists to prevent.
    expect(() => zonedWallTimeToInstant('2026-03-08T02:30', VANCOUVER)).toThrow(
      NonExistentLocalTimeError,
    );
  });

  it('names the zone and the reason, so the message is actionable', () => {
    let caught: unknown;
    try {
      zonedWallTimeToInstant('2026-03-08T02:00', VANCOUVER);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NonExistentLocalTimeError);
    expect((caught as Error).message).toContain(VANCOUVER);
    expect((caught as Error).message).toMatch(/clocks go forward/);
  });

  it('accepts the minutes either side of the gap', () => {
    expect(iso(zonedWallTimeToInstant('2026-03-08T01:59', VANCOUVER))).toBe(
      '2026-03-08T09:59:00.000Z',
    );
    expect(iso(zonedWallTimeToInstant('2026-03-08T03:00', VANCOUVER))).toBe(
      '2026-03-08T10:00:00.000Z',
    );
  });
});

describe('the hour that happens twice', () => {
  it('reports 01:30 on 1 November as ambiguous and offers both instants', () => {
    const resolved = resolveZonedWallTime('2026-11-01T01:30', VANCOUVER);
    expect(resolved.kind).toBe('AMBIGUOUS');
    // The first occurrence is still daylight time, which is what somebody
    // writing "01:30" on that morning almost always means.
    expect(iso(resolved.instant)).toBe('2026-11-01T08:30:00.000Z');
    expect(resolved.alternative && iso(resolved.alternative)).toBe('2026-11-01T09:30:00.000Z');
  });

  it('is exact an hour either side', () => {
    expect(resolveZonedWallTime('2026-11-01T00:30', VANCOUVER).kind).toBe('EXACT');
    expect(resolveZonedWallTime('2026-11-01T02:30', VANCOUVER).kind).toBe('EXACT');
  });
});

describe('the calendar day a fixture belongs to', () => {
  it('files a Saturday-evening kickoff under Saturday, not Sunday', () => {
    // 19:00 on 4 October in Vancouver is 02:00 on the 5th in UTC. Slicing the
    // ISO string — the obvious implementation — files half of every weekend's
    // matches under the wrong day.
    const kickoff = zonedWallTimeToInstant('2025-10-04T19:00', VANCOUVER);
    expect(kickoff.toISOString().slice(0, 10)).toBe('2025-10-05');
    expect(leagueDateKey(kickoff, VANCOUVER)).toBe('2025-10-04');
  });

  it('makes the spring transition day 23 hours long', () => {
    const { start, end } = leagueDayBounds('2026-03-08', VANCOUVER);
    expect(iso(start)).toBe('2026-03-08T08:00:00.000Z');
    expect(iso(end)).toBe('2026-03-09T07:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('makes the autumn transition day 25 hours long', () => {
    const { start, end } = leagueDayBounds('2026-11-01', VANCOUVER);
    expect(iso(start)).toBe('2026-11-01T07:00:00.000Z');
    expect(iso(end)).toBe('2026-11-02T08:00:00.000Z');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });

  it('covers every kickoff on the long day exactly once', () => {
    // A half-open window, so a midnight kickoff belongs to one day only.
    const { start, end } = leagueDayBounds('2026-11-01', VANCOUVER);
    for (const local of ['2026-11-01T00:00', '2026-11-01T01:30', '2026-11-01T23:59']) {
      const kickoff = resolveZonedWallTime(local, VANCOUVER).instant;
      expect(kickoff >= start && kickoff < end, `${local} fell outside its own day`).toBe(true);
    }
    const nextDay = zonedWallTimeToInstant('2026-11-02T00:00', VANCOUVER);
    expect(nextDay >= end).toBe(true);
  });
});

describe('offsets come from the runtime timezone database, not from arithmetic', () => {
  it('reports Vancouver as UTC-8 in winter and UTC-7 in summer', () => {
    expect(timeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), VANCOUVER)).toBe(-8 * 3_600_000);
    expect(timeZoneOffsetMs(new Date('2026-07-15T12:00:00Z'), VANCOUVER)).toBe(-7 * 3_600_000);
  });

  it('handles a zone with no daylight saving at all', () => {
    expect(iso(zonedWallTimeToInstant('2026-03-08T14:00', 'UTC'))).toBe('2026-03-08T14:00:00.000Z');
    expect(iso(zonedWallTimeToInstant('2026-07-08T14:00', 'UTC'))).toBe('2026-07-08T14:00:00.000Z');
  });

  it('handles a zone whose transition is not a whole hour', () => {
    // Lord Howe Island shifts by thirty minutes. Included because an
    // implementation that hardcodes "one hour" passes every Vancouver test and
    // fails here — and the second league to arrive may not be in Canada.
    const zone = 'Australia/Lord_Howe';
    expect(() => zonedWallTimeToInstant('2026-10-04T02:15', zone)).toThrow(
      NonExistentLocalTimeError,
    );
    expect(resolveZonedWallTime('2026-10-04T01:30', zone).kind).toBe('EXACT');
  });

  it('handles a southern-hemisphere zone, where the seasons are inverted', () => {
    const zone = 'Pacific/Auckland';
    const january = timeZoneOffsetMs(new Date('2026-01-15T12:00:00Z'), zone);
    const july = timeZoneOffsetMs(new Date('2026-07-15T12:00:00Z'), zone);
    expect(january).toBe(13 * 3_600_000);
    expect(july).toBe(12 * 3_600_000);
  });
});

describe('rendering', () => {
  it('shows the league-local time and the zone in force that day', () => {
    const march7 = zonedWallTimeToInstant('2026-03-07T14:00', VANCOUVER);
    const march8 = zonedWallTimeToInstant('2026-03-08T14:00', VANCOUVER);

    expect(formatKickoff(march7, VANCOUVER)).toMatch(/14:00/);
    expect(formatKickoff(march7, VANCOUVER)).toMatch(/PST/);
    expect(formatKickoff(march8, VANCOUVER)).toMatch(/14:00/);
    expect(formatKickoff(march8, VANCOUVER)).toMatch(/PDT/);
  });

  it('renders the same instant differently for two leagues in different zones', () => {
    // The multi-tenant version of the same bug: one stored instant, two
    // leagues, two correct answers.
    const instant = new Date('2026-03-08T21:00:00.000Z');
    expect(formatKickoffTime(instant, VANCOUVER)).toBe('14:00');
    expect(formatKickoffTime(instant, 'America/Toronto')).toBe('17:00');
    expect(formatKickoffTime(instant, 'Europe/London')).toBe('21:00');
  });

  it('does not report midnight as hour 24', () => {
    // Some ICU builds do exactly this with `hour12: false`, which files a
    // midnight kickoff on the previous day.
    const midnight = zonedWallTimeToInstant('2026-06-01T00:00', VANCOUVER);
    expect(formatKickoffTime(midnight, VANCOUVER)).toBe('00:00');
    expect(instantToWallTime(midnight, VANCOUVER).hour).toBe(0);
  });
});

describe('parsing rejects what the calendar does not contain', () => {
  it.each([
    ['2026-02-30T10:00', 'a day February does not have'],
    ['2026-13-01T10:00', 'a thirteenth month'],
    ['2026-03-08T25:00', 'a twenty-fifth hour'],
    ['not a date', 'free text'],
    ['2026-03-08', 'a date with no time'],
  ])('rejects %s (%s)', (value) => {
    expect(() => parseWallTime(value)).toThrow(InvalidWallTimeError);
  });

  it('accepts both the T and the space separator, and optional seconds', () => {
    expect(parseWallTime('2026-03-08T14:00').hour).toBe(14);
    expect(parseWallTime('2026-03-08 14:00').hour).toBe(14);
    expect(parseWallTime('2026-03-08T14:00:30').second).toBe(30);
  });
});
