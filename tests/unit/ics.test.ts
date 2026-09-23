import { describe, expect, it } from 'vitest';
import { buildCalendar, type CalendarEvent, escapeText, fold, toUtcStamp } from '@/lib/ics';

/**
 * iCalendar output.
 *
 * Every case here is a rule that fails SILENTLY when broken: Apple Calendar
 * accepts a malformed feed and displays nothing, Google subscribes and never
 * refreshes, and neither reports an error. So the format is asserted directly
 * rather than trusted.
 */

const event = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  uid: 'fixture-1@league.test',
  start: new Date('2026-03-08T21:00:00Z'),
  summary: 'Rutland Rovers v Glenmore Athletic',
  ...overrides,
});

const lines = (ics: string) => ics.split('\r\n');

describe('structure', () => {
  it('opens and closes the calendar and the event', () => {
    const ics = buildCalendar([event()], { name: 'Test' });
    const l = lines(ics);
    expect(l[0]).toBe('BEGIN:VCALENDAR');
    expect(l).toContain('BEGIN:VEVENT');
    expect(l).toContain('END:VEVENT');
    expect(l[l.length - 2]).toBe('END:VCALENDAR');
  });

  it('uses CRLF everywhere, not LF', () => {
    // The single most common reason a hand-built feed is rejected.
    const ics = buildCalendar([event()], { name: 'Test' });
    const strayLineFeeds = ics.split('\n').filter((part) => !part.endsWith('\r'));
    // Only the final empty string after the trailing CRLF may lack a CR.
    expect(strayLineFeeds).toEqual(['']);
  });

  it('ends with a trailing CRLF', () => {
    expect(buildCalendar([event()], { name: 'Test' }).endsWith('\r\n')).toBe(true);
  });

  it('declares a refresh interval in both the standard and the Apple spelling', () => {
    const ics = buildCalendar([], { name: 'Test' });
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(ics).toContain('X-PUBLISHED-TTL:PT1H');
  });
});

describe('timestamps', () => {
  it('writes UTC with the Z suffix', () => {
    expect(toUtcStamp(new Date('2026-03-08T21:00:00Z'))).toBe('20260308T210000Z');
  });

  it('pads every component', () => {
    expect(toUtcStamp(new Date('2026-01-02T03:04:05Z'))).toBe('20260102T030405Z');
  });

  it('defaults an event to 105 minutes', () => {
    const ics = buildCalendar([event()], { name: 'Test' });
    expect(ics).toContain('DTSTART:20260308T210000Z');
    // 90 minutes plus half-time.
    expect(ics).toContain('DTEND:20260308T224500Z');
  });

  it('is stable between builds, so a conditional fetch can short-circuit', () => {
    const updatedAt = new Date('2026-03-01T12:00:00Z');
    const first = buildCalendar([event({ updatedAt })], { name: 'Test' });
    const second = buildCalendar([event({ updatedAt })], { name: 'Test' });
    expect(first).toBe(second);
  });
});

describe('escaping', () => {
  it('escapes the four reserved characters', () => {
    expect(escapeText('a,b')).toBe('a\\,b');
    expect(escapeText('a;b')).toBe('a\\;b');
    expect(escapeText('a\\b')).toBe('a\\\\b');
    expect(escapeText('a\nb')).toBe('a\\nb');
  });

  it('escapes the backslash first', () => {
    // Doing it last double-escapes the escapes just inserted, and the client
    // shows "Rutland\, Rovers".
    expect(escapeText('a\\,b')).toBe('a\\\\\\,b');
  });

  it('escapes a club name containing a comma', () => {
    const ics = buildCalendar([event({ summary: 'Kelowna United, Reserves v Rutland' })], {
      name: 'Test',
    });
    expect(ics).toContain('SUMMARY:Kelowna United\\, Reserves v Rutland');
  });
});

describe('line folding', () => {
  it('leaves a short line alone', () => {
    expect(fold('SUMMARY:short')).toBe('SUMMARY:short');
  });

  it('folds a long line with a leading space on the continuation', () => {
    const folded = fold(`DESCRIPTION:${'x'.repeat(200)}`);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
  });

  it('folds at 75 OCTETS, not 75 characters', () => {
    // The subtle version of this bug. A name full of multi-byte characters is
    // longer in UTF-8 than JavaScript's length suggests, so counting
    // characters produces an over-long line.
    const folded = fold(`SUMMARY:${'ñ'.repeat(80)}`);
    for (const part of folded.split('\r\n')) {
      expect(Buffer.from(part, 'utf8').length).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character across the fold', () => {
    // A fold placed mid-sequence emits a broken code point, which some clients
    // reject outright and others render as a replacement character.
    const folded = fold(`SUMMARY:${'Peñarol Krešimir '.repeat(10)}`);
    const rejoined = folded.split('\r\n ').join('');
    expect(rejoined).not.toContain('�');
    expect(rejoined).toBe(`SUMMARY:${'Peñarol Krešimir '.repeat(10)}`);
  });
});

describe('the UID rule', () => {
  it('does not change when the fixture is rescheduled', () => {
    /**
     * The property this whole feed depends on. If the UID moved with the
     * kickoff, a reschedule would deliver a SECOND event rather than an update,
     * and a season of reschedules would leave every subscriber with a calendar
     * full of matches that are not happening — which they cannot fix without
     * unsubscribing.
     */
    const before = buildCalendar([event({ start: new Date('2026-03-08T21:00:00Z') })], {
      name: 'T',
    });
    const after = buildCalendar([event({ start: new Date('2026-03-15T21:00:00Z') })], {
      name: 'T',
    });

    const uidOf = (ics: string) => lines(ics).find((l) => l.startsWith('UID:'));
    expect(uidOf(before)).toBe(uidOf(after));
    expect(uidOf(before)).toBe('UID:fixture-1@league.test');
  });

  it('carries a sequence number so clients accept the update', () => {
    expect(buildCalendar([event({ sequence: 3 })], { name: 'T' })).toContain('SEQUENCE:3');
  });
});

describe('status', () => {
  it('marks a cancelled fixture cancelled rather than deleting it', () => {
    // Deleting it leaves the match in the subscriber's calendar. CANCELLED
    // removes it from their view and tells them why.
    expect(buildCalendar([event({ status: 'CANCELLED' })], { name: 'T' })).toContain(
      'STATUS:CANCELLED',
    );
  });

  it('marks a postponed fixture tentative', () => {
    expect(buildCalendar([event({ status: 'TENTATIVE' })], { name: 'T' })).toContain(
      'STATUS:TENTATIVE',
    );
  });
});

describe('an empty feed', () => {
  it('is still a valid calendar', () => {
    // A team with no fixtures yet must not produce a file the client rejects,
    // or the subscription fails permanently and is never retried.
    const ics = buildCalendar([], { name: 'Empty' });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).not.toContain('BEGIN:VEVENT');
  });
});
