import { describe, expect, it } from 'vitest';
import {
  disciplinaryEvents,
  inMatchOrder,
  liveEvents,
  type MatchEventFact,
  type MatchEventType,
  type MatchPeriod,
  scoringEvents,
} from '@/server/match/events';

/**
 * Match events are append-only, so "which ones still count" is a filter every
 * consumer needs and every consumer could get subtly wrong. Getting it wrong
 * means a player suspended for a card that was withdrawn, or a Golden Boot won
 * on penalty shootouts.
 */

let sequence = 0;
function event(
  type: MatchEventType,
  overrides: Partial<MatchEventFact> = {},
): MatchEventFact {
  sequence += 1;
  return {
    id: `e${String(sequence).padStart(3, '0')}`,
    type,
    period: 'FIRST_HALF' as MatchPeriod,
    minute: 10,
    stoppageMinute: null,
    editionEntryId: 'entry-home',
    personId: 'person-1',
    retractsEventId: null,
    ...overrides,
  };
}

describe('retraction', () => {
  it('drops both the withdrawn event and the row that withdrew it', () => {
    const card = event('YELLOW_CARD');
    const withdrawal = event('YELLOW_CARD', { retractsEventId: card.id });
    const goal = event('GOAL');

    const live = liveEvents([card, withdrawal, goal]);
    expect(live.map((e) => e.id)).toEqual([goal.id]);
  });

  it('keeps everything when nothing was retracted', () => {
    const events = [event('GOAL'), event('YELLOW_CARD')];
    expect(liveEvents(events)).toHaveLength(2);
  });

  it('keeps a suspended player out of a disciplinary count once the card is withdrawn', () => {
    // The reason this filter exists at all.
    const card = event('RED_CARD');
    const withdrawal = event('RED_CARD', { retractsEventId: card.id });
    expect(disciplinaryEvents([card, withdrawal])).toHaveLength(0);
  });
});

describe('what counts as a goal', () => {
  it('counts goals, own goals and converted penalties', () => {
    const events = [
      event('GOAL'),
      event('OWN_GOAL'),
      event('PENALTY_SCORED'),
      event('PENALTY_MISSED'),
      event('YELLOW_CARD'),
      event('SUBSTITUTION'),
    ];
    expect(scoringEvents(events).map((e) => e.type).sort()).toEqual([
      'GOAL',
      'OWN_GOAL',
      'PENALTY_SCORED',
    ]);
  });

  it('excludes a shootout conversion', () => {
    // The classic version of this bug: a cup run inflating a goalscorer table
    // by however many penalties the tie went to. Invisible until a season ends.
    const inPlay = event('PENALTY_SCORED', { period: 'SECOND_HALF' });
    const shootout = event('PENALTY_SCORED', { period: 'PENALTY_SHOOTOUT' });

    expect(scoringEvents([inPlay, shootout]).map((e) => e.id)).toEqual([inPlay.id]);
  });

  it('counts a goal scored in extra time', () => {
    const extraTime = event('GOAL', { period: 'EXTRA_TIME_FIRST' });
    expect(scoringEvents([extraTime])).toHaveLength(1);
  });

  it('excludes a goal that was later retracted', () => {
    const goal = event('GOAL');
    const withdrawal = event('GOAL', { retractsEventId: goal.id });
    expect(scoringEvents([goal, withdrawal])).toHaveLength(0);
  });
});

describe('timeline ordering', () => {
  it('orders by period, then minute, then stoppage time', () => {
    const events = [
      event('GOAL', { period: 'SECOND_HALF', minute: 60 }),
      event('GOAL', { period: 'FIRST_HALF', minute: 45, stoppageMinute: 2 }),
      event('GOAL', { period: 'FIRST_HALF', minute: 45, stoppageMinute: null }),
      event('GOAL', { period: 'FIRST_HALF', minute: 12 }),
      event('GOAL', { period: 'EXTRA_TIME_FIRST', minute: 95 }),
    ];

    expect(inMatchOrder(events).map((e) => [e.period, e.minute, e.stoppageMinute])).toEqual([
      ['FIRST_HALF', 12, null],
      ['FIRST_HALF', 45, null],
      ['FIRST_HALF', 45, 2],
      ['SECOND_HALF', 60, null],
      ['EXTRA_TIME_FIRST', 95, null],
    ]);
  });

  it('puts events with an unknown minute last rather than first', () => {
    // A null minute sorted as zero would open every timeline with the events
    // nobody could place.
    const known = event('GOAL', { minute: 30 });
    const unknown = event('GOAL', { minute: null });

    expect(inMatchOrder([unknown, known]).map((e) => e.id)).toEqual([known.id, unknown.id]);
  });

  it('is a total order, so the same events always render identically', () => {
    const a = event('GOAL', { id: 'aaa', minute: 20 });
    const b = event('YELLOW_CARD', { id: 'bbb', minute: 20 });

    expect(inMatchOrder([a, b]).map((e) => e.id)).toEqual(['aaa', 'bbb']);
    expect(inMatchOrder([b, a]).map((e) => e.id)).toEqual(['aaa', 'bbb']);
  });
});
