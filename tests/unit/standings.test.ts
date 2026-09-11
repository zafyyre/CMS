import { describe, expect, it } from 'vitest';
import {
  computeStandings,
  DEFAULT_RULES,
  disciplinePointsFor,
  type StandingsEntry,
  type StandingsFixture,
  type StandingsRules,
  type TieBreaker,
} from '@/server/standings/engine';

/**
 * The league table, exercised directly.
 *
 * Named in the build plan as a suite that must exist and must never be
 * deleted. What it guards: a team missing the play-offs on a bad tiebreak, in
 * public, discovered by a coach doing the arithmetic by hand in April.
 *
 * The property tests at the bottom are the part that matters most. Worked
 * examples prove the cases somebody thought of; the properties prove the ones
 * nobody did.
 */

const rulesWith = (tieBreakers: TieBreaker[], overrides: Partial<StandingsRules> = {}) => ({
  ...DEFAULT_RULES,
  tieBreakers,
  ...overrides,
});

function entry(id: string, name = id, overrides: Partial<StandingsEntry> = {}): StandingsEntry {
  return { entryId: id, teamName: name, status: 'ACTIVE', pointsAdjustment: 0, ...overrides };
}

let matchCounter = 0;
function played(
  home: string,
  homeScore: number,
  awayScore: number,
  away: string,
  overrides: Partial<StandingsFixture> = {},
): StandingsFixture {
  matchCounter += 1;
  return {
    fixtureId: `f${matchCounter}`,
    homeEntryId: home,
    awayEntryId: away,
    kickoffAt: new Date(Date.UTC(2025, 8, 1) + matchCounter * 86_400_000),
    resultState: 'CONFIRMED',
    homeScore,
    awayScore,
    homeForfeit: false,
    awayForfeit: false,
    ...overrides,
  };
}

const positions = (table: { rows: { teamName: string }[] }) => table.rows.map((r) => r.teamName);

describe('the arithmetic', () => {
  it('counts a win, a draw and a defeat correctly', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo')],
      [played('a', 2, 1, 'b'), played('b', 1, 1, 'a'), played('a', 0, 3, 'b')],
    );

    const alpha = table.rows.find((r) => r.teamName === 'Alpha');
    expect(alpha).toMatchObject({
      played: 3,
      won: 1,
      drawn: 1,
      lost: 1,
      goalsFor: 3,
      goalsAgainst: 5,
      goalDifference: -2,
      pointsEarned: 4,
      points: 4,
    });
  });

  it('honours a points deduction, and shows it separately', () => {
    // "34 (−3)" rather than 31 with no explanation, which is the version that
    // generates a fortnight of email.
    const table = computeStandings(
      [entry('a', 'Alpha', { pointsAdjustment: -3 }), entry('b', 'Bravo')],
      [played('a', 5, 0, 'b')],
    );

    const alpha = table.rows.find((r) => r.teamName === 'Alpha');
    expect(alpha).toMatchObject({ pointsEarned: 3, pointsAdjustment: -3, points: 0 });
    expect(alpha?.basis).toMatch(/deduction of 3/);
  });

  it('respects a league that plays two points for a win', () => {
    const table = computeStandings(
      [entry('a'), entry('b')],
      [played('a', 1, 0, 'b')],
      rulesWith(['GOAL_DIFFERENCE'], { pointsForWin: 2, pointsForDraw: 1 }),
    );
    expect(table.rows[0]?.points).toBe(2);
  });

  it('builds the form guide in kickoff order, most recent last', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo')],
      [
        played('a', 1, 0, 'b', { kickoffAt: new Date('2025-09-01T00:00:00Z') }),
        played('a', 0, 1, 'b', { kickoffAt: new Date('2025-09-08T00:00:00Z') }),
        played('a', 2, 2, 'b', { kickoffAt: new Date('2025-09-15T00:00:00Z') }),
      ],
    );
    expect(table.rows.find((r) => r.teamName === 'Alpha')?.form).toEqual(['W', 'L', 'D']);
  });
});

describe('which fixtures count', () => {
  it('ignores a fixture nobody has reported', () => {
    const table = computeStandings(
      [entry('a'), entry('b')],
      [played('a', 0, 0, 'b', { resultState: 'NONE', homeScore: null, awayScore: null })],
    );
    expect(table.fixturesOutstanding).toBe(1);
    expect(table.fixturesCounted).toBe(0);
    expect(table.rows[0]?.played).toBe(0);
  });

  it('leaves a disputed result out of the table and says so', () => {
    // Putting a contested scoreline into a published table is how a table
    // stops being evidence.
    const table = computeStandings(
      [entry('a'), entry('b')],
      [played('a', 3, 1, 'b', { resultState: 'DISPUTED' })],
    );
    expect(table.fixturesDisputed).toBe(1);
    expect(table.rows.every((r) => r.played === 0)).toBe(true);
  });

  it('applies the rulebook scoreline to a forfeit, not the submitted one', () => {
    // If a team fails to appear, 3–0 is a sanction the competition imposes.
    // Whatever score was typed alongside the flag describes a match that was
    // not played.
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo')],
      [played('a', 7, 2, 'b', { awayForfeit: true })],
    );
    const alpha = table.rows.find((r) => r.teamName === 'Alpha');
    expect(alpha).toMatchObject({ goalsFor: 3, goalsAgainst: 0, won: 1 });
  });

  it('can be told not to count a forfeit as a played match', () => {
    const table = computeStandings(
      [entry('a'), entry('b')],
      [played('a', 0, 0, 'b', { awayForfeit: true })],
      rulesWith(['GOAL_DIFFERENCE'], { forfeitCountsAsPlayed: false }),
    );
    expect(table.rows.every((r) => r.played === 0)).toBe(true);
    expect(table.fixturesCounted).toBe(1);
  });
});

describe('a team that leaves mid-season', () => {
  it('keeps a withdrawn team and everyone else\'s results against it', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo', { status: 'WITHDRAWN' })],
      [played('a', 4, 0, 'b')],
    );
    expect(positions(table)).toEqual(['Alpha', 'Bravo']);
    expect(table.rows.find((r) => r.teamName === 'Alpha')?.points).toBe(3);
  });

  it('strikes an expunged team\'s matches from everyone\'s record', () => {
    // Which is what expunging means, and the reason it is a separate status
    // from withdrawing.
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie', { status: 'EXPUNGED' })],
      [played('a', 4, 0, 'c'), played('a', 1, 2, 'b')],
    );

    expect(positions(table)).toEqual(['Bravo', 'Alpha']);
    expect(table.rows.find((r) => r.teamName === 'Alpha')).toMatchObject({
      played: 1,
      goalsFor: 1,
      points: 0,
    });
  });
});

describe('breaking ties', () => {
  it('separates on goal difference', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')],
      [played('a', 5, 0, 'c'), played('b', 1, 0, 'c')],
      rulesWith(['GOAL_DIFFERENCE']),
    );
    expect(positions(table)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(table.rows[0]?.basis).toMatch(/separated on goal difference/);
  });

  it('separates on goals scored when goal difference is level', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')],
      [played('a', 3, 1, 'c'), played('b', 2, 0, 'c')],
      rulesWith(['GOAL_DIFFERENCE', 'GOALS_FOR']),
    );
    expect(positions(table).slice(0, 2)).toEqual(['Alpha', 'Bravo']);
    expect(table.rows[0]?.basis).toMatch(/goals scored/);
  });

  it('treats fewer goals conceded as better', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')],
      [played('a', 3, 1, 'c'), played('b', 2, 0, 'c')],
      rulesWith(['GOALS_AGAINST']),
    );
    expect(positions(table)[0]).toBe('Bravo');
  });

  it('treats fewer discipline points as better', () => {
    const table = computeStandings(
      [
        entry('a', 'Alpha', { disciplinePoints: 12 }),
        entry('b', 'Bravo', { disciplinePoints: 3 }),
      ],
      [played('a', 1, 1, 'b')],
      rulesWith(['DISCIPLINE_POINTS']),
    );
    expect(positions(table)).toEqual(['Bravo', 'Alpha']);
    expect(table.rows[0]?.basis).toMatch(/disciplinary record/);
  });
});

describe('head-to-head, which is where naive implementations break', () => {
  it('uses only the matches the tied teams played against each other', () => {
    // Alpha and Bravo finish level on 3 points. Alpha has by far the better
    // overall goal difference (+9 against +1); Bravo beat Alpha. Head-to-head
    // must put Bravo first, and must ignore Alpha's nine goals against a team
    // that is not part of the tie.
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')],
      [played('a', 9, 0, 'c'), played('b', 1, 0, 'a')],
      rulesWith(['HEAD_TO_HEAD_POINTS']),
    );
    expect(positions(table)).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(table.rows[0]?.basis).toMatch(/head-to-head record/);
  });

  it('falls through when the mini-table is itself level', () => {
    /**
     * The circular case: each of three teams beat one of the others, so the
     * head-to-head table among them is 3–3–3 and decides nothing. The engine
     * must move on to the next criterion rather than inventing an order out of
     * whichever pair it compared first — which is precisely what a pairwise
     * head-to-head comparator does.
     */
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')],
      [played('a', 9, 0, 'c'), played('c', 1, 0, 'b'), played('b', 1, 0, 'a')],
      rulesWith(['HEAD_TO_HEAD_POINTS', 'GOAL_DIFFERENCE']),
    );
    // Head-to-head separated nobody, so overall goal difference decided it.
    expect(positions(table)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(table.rows[0]?.basis).toMatch(/goal difference/);
  });

  it('resolves a three-way tie using the mini-table among all three', () => {
    /**
     * The case a pairwise comparator cannot express. Alpha, Bravo and Charlie
     * each beat one of the others, so no pair alone decides anything — only
     * the mini-table over all three does, and it is decided on goals within
     * those matches.
     *
     * A → B 3–0, B → C 1–0, C → A 1–0.
     * Mini-table: Alpha 3pts GD +2, Bravo 3pts GD −2, Charlie 3pts GD 0.
     */
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')],
      [played('a', 3, 0, 'b'), played('b', 1, 0, 'c'), played('c', 1, 0, 'a')],
      rulesWith(['HEAD_TO_HEAD_POINTS', 'HEAD_TO_HEAD_GOAL_DIFFERENCE']),
    );
    expect(positions(table)).toEqual(['Alpha', 'Charlie', 'Bravo']);
  });

  it('recomputes head-to-head among only the teams still level', () => {
    /**
     * Four teams level on points. Goal difference splits them into two pairs;
     * the head-to-head applied afterwards must consider only the pair, not all
     * four — otherwise a match against a team already separated out still
     * influences the order.
     */
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie'), entry('d', 'Delta')],
      [
        // Alpha and Bravo both +2; Charlie and Delta both −2.
        played('a', 3, 1, 'c'),
        played('b', 3, 1, 'd'),
        // Within the top pair, Bravo won.
        played('b', 1, 0, 'a'),
        played('a', 0, 0, 'b'),
        // Within the bottom pair, Delta won.
        played('d', 2, 0, 'c'),
        played('c', 1, 1, 'd'),
      ],
      rulesWith(['GOAL_DIFFERENCE', 'HEAD_TO_HEAD_POINTS']),
    );

    const names = positions(table);
    expect(names.indexOf('Bravo')).toBeLessThan(names.indexOf('Alpha'));
    expect(names.indexOf('Delta')).toBeLessThan(names.indexOf('Charlie'));
  });

  it('skips a criterion that separates nobody rather than claiming it decided', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo')],
      [played('a', 1, 1, 'b')],
      rulesWith(['GOAL_DIFFERENCE', 'WINS', 'GOALS_FOR']),
    );
    // Everything is level, so nothing separated them.
    expect(table.rows[0]?.basis).toMatch(/did not separate them/);
  });
});

describe('when the rules run out', () => {
  it('still produces a total order, listed alphabetically', () => {
    const table = computeStandings(
      [entry('b', 'Bravo'), entry('a', 'Alpha')],
      [played('a', 1, 1, 'b')],
      rulesWith(['GOAL_DIFFERENCE']),
    );
    expect(positions(table)).toEqual(['Alpha', 'Bravo']);
    expect(table.rows[0]?.requiresManualResolution).toBe(false);
  });

  it('flags a drawing of lots for a human, and says the order is provisional', () => {
    // No engine can draw lots. Saying so is honest; inventing an order and
    // presenting it as fact is not.
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo')],
      [played('a', 1, 1, 'b')],
      rulesWith(['GOAL_DIFFERENCE', 'DRAWING_OF_LOTS']),
    );
    expect(table.requiresManualResolution).toBe(true);
    expect(table.rows[0]?.requiresManualResolution).toBe(true);
    expect(table.rows[0]?.basis).toMatch(/drawing of lots.*provisional/);
  });

  it('separates two teams with the same name by entry id', () => {
    // Two sides of one club genuinely carry the same name. An order that
    // depends on which row the database returned first is not deterministic.
    const table = computeStandings(
      [entry('zzz', 'United'), entry('aaa', 'United')],
      [],
      rulesWith([]),
    );
    expect(table.rows.map((r) => r.entryId)).toEqual(['aaa', 'zzz']);
  });
});

describe('the basis sentence', () => {
  it('states the points when nothing was tied', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo')],
      [played('a', 1, 0, 'b')],
    );
    expect(table.rows[0]?.basis).toBe('3 points.');
  });

  it('names who the team was level with', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie')],
      [played('a', 5, 0, 'c'), played('b', 1, 0, 'c')],
      rulesWith(['GOAL_DIFFERENCE']),
    );
    expect(table.rows[0]?.basis).toContain('Bravo');
    expect(table.rows[0]?.tiedWith).toEqual(['Bravo']);
  });

  it('lists three tied teams readably', () => {
    const table = computeStandings(
      [entry('a', 'Alpha'), entry('b', 'Bravo'), entry('c', 'Charlie'), entry('d', 'Delta')],
      [played('a', 3, 0, 'd'), played('b', 2, 0, 'd'), played('c', 1, 0, 'd')],
      rulesWith(['GOAL_DIFFERENCE']),
    );
    expect(table.rows[0]?.basis).toMatch(/Bravo, Charlie and Delta|Bravo and Charlie/);
  });
});

// ---------------------------------------------------------------------------
// Property tests — the part that catches what nobody thought of
// ---------------------------------------------------------------------------

/** Deterministic generator, so a failure is reproducible from its seed. */
function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface GeneratedSeason {
  entries: StandingsEntry[];
  fixtures: StandingsFixture[];
  rules: StandingsRules;
}

const ALL_TIEBREAKERS: TieBreaker[] = [
  'GOAL_DIFFERENCE',
  'GOALS_FOR',
  'GOALS_AGAINST',
  'HEAD_TO_HEAD_POINTS',
  'HEAD_TO_HEAD_GOAL_DIFFERENCE',
  'WINS',
  'AWAY_GOALS_SCORED',
  'DISCIPLINE_POINTS',
];

function generateSeason(seed: number): GeneratedSeason {
  const rng = makeRng(seed);
  const teamCount = 3 + Math.floor(rng() * 6);

  const entries: StandingsEntry[] = Array.from({ length: teamCount }, (_, i) => ({
    entryId: `e${i}`,
    teamName: `Team ${String.fromCharCode(65 + i)}`,
    status: rng() > 0.94 ? 'WITHDRAWN' : 'ACTIVE',
    pointsAdjustment: rng() > 0.9 ? -Math.floor(rng() * 6) : 0,
    disciplinePoints: Math.floor(rng() * 30),
  }));

  const fixtures: StandingsFixture[] = [];
  let n = 0;
  for (let i = 0; i < teamCount; i++) {
    for (let j = 0; j < teamCount; j++) {
      if (i === j) continue;
      n++;
      const roll = rng();
      // Deliberately low scores, so ties are common and the tiebreaker chain
      // is exercised rather than skipped.
      fixtures.push({
        fixtureId: `g${seed}-${n}`,
        homeEntryId: `e${i}`,
        awayEntryId: `e${j}`,
        kickoffAt: new Date(Date.UTC(2025, 8, 1) + n * 3_600_000),
        resultState: roll > 0.9 ? 'NONE' : roll > 0.86 ? 'DISPUTED' : 'CONFIRMED',
        homeScore: Math.floor(rng() * 3),
        awayScore: Math.floor(rng() * 3),
        homeForfeit: rng() > 0.97,
        awayForfeit: false,
      });
    }
  }

  // A random, possibly short, tiebreaker chain — including the empty one.
  const chainLength = Math.floor(rng() * (ALL_TIEBREAKERS.length + 1));
  const pool = [...ALL_TIEBREAKERS];
  const tieBreakers: TieBreaker[] = [];
  for (let i = 0; i < chainLength; i++) {
    const [picked] = pool.splice(Math.floor(rng() * pool.length), 1);
    if (picked) tieBreakers.push(picked);
  }

  return {
    entries,
    fixtures,
    rules: { ...DEFAULT_RULES, tieBreakers },
  };
}

const SEASONS = 400;

describe('properties, over generated seasons', () => {
  it('produces a total order: one row per team, positions 1..n with no gaps', () => {
    for (let seed = 1; seed <= SEASONS; seed++) {
      const { entries, fixtures, rules } = generateSeason(seed);
      const table = computeStandings(entries, fixtures, rules);

      const expected = entries.filter((e) => e.status !== 'EXPUNGED').length;
      expect(table.rows, `seed ${seed}`).toHaveLength(expected);
      expect(table.rows.map((r) => r.position)).toEqual(
        Array.from({ length: expected }, (_, i) => i + 1),
      );
      expect(new Set(table.rows.map((r) => r.entryId)).size).toBe(expected);
    }
  });

  it('is deterministic: the same input always gives the same order', () => {
    for (let seed = 1; seed <= SEASONS; seed++) {
      const { entries, fixtures, rules } = generateSeason(seed);
      const first = computeStandings(entries, fixtures, rules).rows.map((r) => r.entryId);
      const second = computeStandings(entries, fixtures, rules).rows.map((r) => r.entryId);
      expect(second, `seed ${seed}`).toEqual(first);
    }
  });

  it('does not depend on the order the rows arrived in', () => {
    // The one that catches an unstable sort. A table that changes because
    // PostgreSQL returned rows differently is a table nobody can trust.
    for (let seed = 1; seed <= SEASONS; seed++) {
      const { entries, fixtures, rules } = generateSeason(seed);
      const rng = makeRng(seed * 7919);

      const shuffledEntries = [...entries].sort(() => rng() - 0.5);
      const shuffledFixtures = [...fixtures].sort(() => rng() - 0.5);

      const canonical = computeStandings(entries, fixtures, rules).rows.map((r) => r.entryId);
      const shuffled = computeStandings(shuffledEntries, shuffledFixtures, rules).rows.map(
        (r) => r.entryId,
      );
      expect(shuffled, `seed ${seed}`).toEqual(canonical);
    }
  });

  it('never places a team above one with strictly more points', () => {
    for (let seed = 1; seed <= SEASONS; seed++) {
      const { entries, fixtures, rules } = generateSeason(seed);
      const table = computeStandings(entries, fixtures, rules);

      for (let i = 1; i < table.rows.length; i++) {
        const above = table.rows[i - 1];
        const below = table.rows[i];
        if (!above || !below) continue;
        expect(above.points, `seed ${seed}, positions ${i}/${i + 1}`).toBeGreaterThanOrEqual(
          below.points,
        );
      }
    }
  });

  it('keeps every row internally consistent', () => {
    // The same invariants the database CHECK constraint enforces, asserted
    // before anything reaches the database.
    for (let seed = 1; seed <= SEASONS; seed++) {
      const { entries, fixtures, rules } = generateSeason(seed);
      const table = computeStandings(entries, fixtures, rules);

      for (const row of table.rows) {
        expect(row.played, `seed ${seed}`).toBe(row.won + row.drawn + row.lost);
        expect(row.goalDifference).toBe(row.goalsFor - row.goalsAgainst);
        expect(row.points).toBe(row.pointsEarned + row.pointsAdjustment);
        expect(row.pointsEarned).toBe(
          row.won * rules.pointsForWin +
            row.drawn * rules.pointsForDraw +
            row.lost * rules.pointsForLoss,
        );
        expect(row.form.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it('conserves goals: every goal scored is a goal conceded by somebody', () => {
    for (let seed = 1; seed <= SEASONS; seed++) {
      const { entries, fixtures, rules } = generateSeason(seed);
      const table = computeStandings(entries, fixtures, rules);

      const scored = table.rows.reduce((sum, r) => sum + r.goalsFor, 0);
      const conceded = table.rows.reduce((sum, r) => sum + r.goalsAgainst, 0);
      expect(scored, `seed ${seed}`).toBe(conceded);
      expect(table.rows.reduce((sum, r) => sum + r.goalDifference, 0)).toBe(0);
    }
  });

  it('accounts for every fixture exactly once', () => {
    for (let seed = 1; seed <= SEASONS; seed++) {
      const { entries, fixtures, rules } = generateSeason(seed);
      const table = computeStandings(entries, fixtures, rules);

      const involvesOnlyCounted = fixtures.filter((f) => {
        const ids = new Set(entries.filter((e) => e.status !== 'EXPUNGED').map((e) => e.entryId));
        return ids.has(f.homeEntryId) && ids.has(f.awayEntryId);
      }).length;

      expect(
        table.fixturesCounted + table.fixturesDisputed + table.fixturesOutstanding,
        `seed ${seed}`,
      ).toBe(involvesOnlyCounted);
    }
  });
});

describe('discipline points', () => {
  it('weights reds above yellows', () => {
    const cards = [{ type: 'YELLOW_CARD' }, { type: 'YELLOW_CARD' }, { type: 'RED_CARD' }];
    expect(disciplinePointsFor(cards, DEFAULT_RULES)).toBe(5);
  });

  it('ignores anything that is not a card', () => {
    expect(disciplinePointsFor([{ type: 'GOAL' }, { type: 'SUBSTITUTION' }], DEFAULT_RULES)).toBe(0);
  });
});
