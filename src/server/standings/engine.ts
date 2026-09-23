/**
 * THE LEAGUE TABLE.
 *
 * The highest-consequence pure function in this system. Get the permission
 * matrix wrong and somebody sees a page they should not have; get this wrong
 * and a team misses the play-offs, in public, and nobody notices until a coach
 * does the arithmetic by hand in April.
 *
 * So: no database, no clock, no I/O. Everything is passed in, which is what
 * makes it possible to run thousands of generated seasons through it in a
 * property test and assert that the ordering is total, deterministic and
 * stable — see tests/unit/standings.test.ts.
 *
 * ── HOW TIES ARE ACTUALLY BROKEN ────────────────────────────────────────────
 * Not with a pairwise comparator. A comparator cannot express head-to-head,
 * because "who did better between the tied teams" depends on WHICH teams are
 * tied — a fact no two-argument function has access to. Sorting three teams
 * with a naive head-to-head comparator produces an ordering that depends on
 * which pairs the sort algorithm happened to compare, and is not even
 * guaranteed to be transitive.
 *
 * Instead this partitions recursively. Teams level on points form a group; the
 * first tiebreaker splits that group into sub-groups; each sub-group is then
 * split by the next tiebreaker, with head-to-head recomputed among only the
 * teams still tied at that point. That is exactly what a rulebook means, and it
 * is the only formulation that gets three-way ties right.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type TieBreaker =
  | 'GOAL_DIFFERENCE'
  | 'GOALS_FOR'
  | 'GOALS_AGAINST'
  | 'HEAD_TO_HEAD_POINTS'
  | 'HEAD_TO_HEAD_GOAL_DIFFERENCE'
  | 'WINS'
  | 'AWAY_GOALS_SCORED'
  | 'DISCIPLINE_POINTS'
  | 'DRAWING_OF_LOTS';

export interface StandingsRules {
  pointsForWin: number;
  pointsForDraw: number;
  pointsForLoss: number;
  tieBreakers: readonly TieBreaker[];
  forfeitWinnerGoals: number;
  forfeitLoserGoals: number;
  forfeitCountsAsPlayed: boolean;
  yellowCardPoints: number;
  redCardPoints: number;
}

export const DEFAULT_RULES: StandingsRules = {
  pointsForWin: 3,
  pointsForDraw: 1,
  pointsForLoss: 0,
  tieBreakers: ['GOAL_DIFFERENCE', 'GOALS_FOR', 'HEAD_TO_HEAD_POINTS', 'WINS'],
  forfeitWinnerGoals: 3,
  forfeitLoserGoals: 0,
  forfeitCountsAsPlayed: true,
  yellowCardPoints: 1,
  redCardPoints: 3,
};

export type EntryStatus = 'ACTIVE' | 'WITHDRAWN' | 'DISQUALIFIED' | 'EXPUNGED';

export interface StandingsEntry {
  entryId: string;
  /** Used for the final alphabetical fallback, and in the basis sentences. */
  teamName: string;
  status: EntryStatus;
  pointsAdjustment: number;
  /** Derived from match events by the caller; see disciplinePointsFor(). */
  disciplinePoints?: number;
}

/** Only what the table needs. Deliberately not the service's `FixtureView`. */
export interface StandingsFixture {
  fixtureId: string;
  homeEntryId: string;
  awayEntryId: string;
  /** Ordering for the form guide. Null sorts last. */
  kickoffAt: Date | null;
  /**
   * `CONFIRMED` is the only state that contributes to the table. A disputed
   * result is counted as disputed and left out, because putting a contested
   * scoreline into a published table is how a table stops being evidence.
   */
  resultState: 'NONE' | 'CONFIRMED' | 'DISPUTED';
  homeScore: number | null;
  awayScore: number | null;
  homeForfeit: boolean;
  awayForfeit: boolean;
}

export interface StandingsRow {
  entryId: string;
  teamName: string;
  position: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  pointsEarned: number;
  pointsAdjustment: number;
  points: number;
  disciplinePoints: number;
  /** Most recent last. */
  form: ('W' | 'D' | 'L')[];
  /** The sentence shown beside the position. */
  basis: string;
  /** True when the rules ran out and a human must draw lots. */
  requiresManualResolution: boolean;
  /** Teams this one was level with before the deciding criterion. */
  tiedWith: string[];
}

export interface StandingsTable {
  rows: StandingsRow[];
  fixturesCounted: number;
  fixturesDisputed: number;
  fixturesOutstanding: number;
  requiresManualResolution: boolean;
}

// ---------------------------------------------------------------------------

interface Tally {
  entry: StandingsEntry;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  awayGoalsFor: number;
  form: { at: Date | null; outcome: 'W' | 'D' | 'L' }[];
  separatedBy: TieBreaker | 'POINTS' | 'ALPHABETICAL' | null;
  tiedWith: string[];
  needsLots: boolean;
}

export function computeStandings(
  entries: readonly StandingsEntry[],
  fixtures: readonly StandingsFixture[],
  rules: StandingsRules = DEFAULT_RULES,
): StandingsTable {
  /**
   * An expunged team is removed from the table AND its matches are struck from
   * everyone else's record. That is what expunging means, and it is different
   * from withdrawing: a team that withdraws in March keeps the results it
   * earned before then, and its opponents keep theirs.
   */
  const counted = entries.filter((e) => e.status !== 'EXPUNGED');
  const countedIds = new Set(counted.map((e) => e.entryId));

  const tallies = new Map<string, Tally>(
    counted.map((entry) => [
      entry.entryId,
      {
        entry,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        awayGoalsFor: 0,
        form: [],
        separatedBy: null,
        tiedWith: [],
        needsLots: false,
      },
    ]),
  );

  const relevant = fixtures.filter(
    (f) => countedIds.has(f.homeEntryId) && countedIds.has(f.awayEntryId),
  );

  let fixturesCounted = 0;
  let fixturesDisputed = 0;
  let fixturesOutstanding = 0;

  for (const fixture of relevant) {
    if (fixture.resultState === 'DISPUTED') {
      fixturesDisputed++;
      continue;
    }
    const scoreline = scorelineOf(fixture, rules);
    if (!scoreline) {
      fixturesOutstanding++;
      continue;
    }
    if (!scoreline.counts) {
      // A forfeit the league has chosen not to count as a played match.
      fixturesCounted++;
      continue;
    }

    fixturesCounted++;
    const home = tallies.get(fixture.homeEntryId);
    const away = tallies.get(fixture.awayEntryId);
    /* c8 ignore next -- both ids were checked against countedIds above */
    if (!home || !away) continue;

    applyScore(home, scoreline.home, scoreline.away, fixture.kickoffAt, false);
    applyScore(away, scoreline.away, scoreline.home, fixture.kickoffAt, true);
  }

  const ordered = orderMembers([...tallies.values()], rules, relevant);

  return {
    rows: ordered.map((tally, index) => toRow(tally, index + 1, rules)),
    fixturesCounted,
    fixturesDisputed,
    fixturesOutstanding,
    requiresManualResolution: ordered.some((t) => t.needsLots),
  };
}

/**
 * The scoreline a fixture contributes, or null if it contributes nothing.
 *
 * A forfeit takes its scoreline from the RULEBOOK, not from whatever was
 * submitted. If a team fails to appear, "3–0" is a sanction the competition
 * imposes; the score somebody typed alongside the forfeit flag is at best a
 * note about a match that was not played.
 */
function scorelineOf(
  fixture: StandingsFixture,
  rules: StandingsRules,
): { home: number; away: number; counts: boolean } | null {
  if (fixture.resultState !== 'CONFIRMED') return null;

  if (fixture.homeForfeit || fixture.awayForfeit) {
    const winner = rules.forfeitWinnerGoals;
    const loser = rules.forfeitLoserGoals;
    return fixture.homeForfeit
      ? { home: loser, away: winner, counts: rules.forfeitCountsAsPlayed }
      : { home: winner, away: loser, counts: rules.forfeitCountsAsPlayed };
  }

  // An abandoned or awarded match with no score contributes nothing until
  // somebody decides what it was.
  if (fixture.homeScore === null || fixture.awayScore === null) return null;
  return { home: fixture.homeScore, away: fixture.awayScore, counts: true };
}

function applyScore(
  tally: Tally,
  scored: number,
  conceded: number,
  at: Date | null,
  isAway: boolean,
): void {
  tally.played++;
  tally.goalsFor += scored;
  tally.goalsAgainst += conceded;
  if (isAway) tally.awayGoalsFor += scored;

  const outcome = scored > conceded ? 'W' : scored < conceded ? 'L' : 'D';
  if (outcome === 'W') tally.won++;
  else if (outcome === 'L') tally.lost++;
  else tally.drawn++;

  tally.form.push({ at, outcome });
}

const pointsOf = (tally: Tally, rules: StandingsRules): number =>
  tally.won * rules.pointsForWin +
  tally.drawn * rules.pointsForDraw +
  tally.lost * rules.pointsForLoss +
  tally.entry.pointsAdjustment;

// ---------------------------------------------------------------------------
// Ordering, by recursive partition
// ---------------------------------------------------------------------------

function orderMembers(
  members: Tally[],
  rules: StandingsRules,
  fixtures: readonly StandingsFixture[],
): Tally[] {
  // Points first, always, and never configurable — a league in which points do
  // not come first is not a league table.
  const byPoints = partition(members, (m) => pointsOf(m, rules), 'desc');

  return byPoints.flatMap((group) => {
    if (group.length === 1) {
      const [only] = group;
      /* c8 ignore next */
      if (!only) return [];
      only.separatedBy = 'POINTS';
      return [only];
    }
    return breakTie(group, rules.tieBreakers, rules, fixtures);
  });
}

function breakTie(
  group: Tally[],
  remaining: readonly TieBreaker[],
  rules: StandingsRules,
  fixtures: readonly StandingsFixture[],
): Tally[] {
  if (group.length <= 1) return group;

  const names = group.map((m) => m.entry.teamName);
  const [criterion, ...rest] = remaining;

  /**
   * Out of criteria. Order alphabetically so the result is TOTAL and stable —
   * an unordered table is useless — but record that nothing in the rulebook
   * actually separated these teams.
   */
  if (criterion === undefined || criterion === 'DRAWING_OF_LOTS') {
    const sorted = [...group].sort(byNameThenId);
    for (const member of sorted) {
      member.separatedBy = 'ALPHABETICAL';
      member.tiedWith = names.filter((n) => n !== member.entry.teamName);
      // Only a rulebook that explicitly ends in a drawing of lots gets flagged
      // for human resolution; running out of criteria is a configuration gap
      // and says so differently in the basis sentence.
      member.needsLots = criterion === 'DRAWING_OF_LOTS';
    }
    return sorted;
  }

  const { key, direction } = criterionKey(criterion, group, rules, fixtures);
  const partitioned = partition(group, key, direction);

  // Everyone still level: this criterion decided nothing, so move on without
  // claiming it did.
  if (partitioned.length === 1) {
    return breakTie(group, rest, rules, fixtures);
  }

  return partitioned.flatMap((subGroup) => {
    if (subGroup.length === 1) {
      const [only] = subGroup;
      /* c8 ignore next */
      if (!only) return [];
      only.separatedBy = criterion;
      only.tiedWith = names.filter((n) => n !== only.entry.teamName);
      return [only];
    }
    // Still tied with each other, but separated from the rest of the group.
    // Head-to-head below this point is recomputed among these teams only.
    return breakTie(subGroup, rest, rules, fixtures);
  });
}

function criterionKey(
  criterion: Exclude<TieBreaker, 'DRAWING_OF_LOTS'>,
  group: Tally[],
  rules: StandingsRules,
  fixtures: readonly StandingsFixture[],
): { key: (t: Tally) => number; direction: 'asc' | 'desc' } {
  switch (criterion) {
    case 'GOAL_DIFFERENCE':
      return { key: (t) => t.goalsFor - t.goalsAgainst, direction: 'desc' };
    case 'GOALS_FOR':
      return { key: (t) => t.goalsFor, direction: 'desc' };
    case 'GOALS_AGAINST':
      // Fewer conceded is better.
      return { key: (t) => t.goalsAgainst, direction: 'asc' };
    case 'WINS':
      return { key: (t) => t.won, direction: 'desc' };
    case 'AWAY_GOALS_SCORED':
      return { key: (t) => t.awayGoalsFor, direction: 'desc' };
    case 'DISCIPLINE_POINTS':
      // Fewer is better — this is a fair-play tiebreaker, not a merit one.
      return { key: (t) => t.entry.disciplinePoints ?? 0, direction: 'asc' };
    case 'HEAD_TO_HEAD_POINTS':
    case 'HEAD_TO_HEAD_GOAL_DIFFERENCE': {
      const mini = headToHead(group, rules, fixtures);
      const wantPoints = criterion === 'HEAD_TO_HEAD_POINTS';
      return {
        key: (t) => {
          const record = mini.get(t.entry.entryId);
          if (!record) return 0;
          return wantPoints ? record.points : record.goalsFor - record.goalsAgainst;
        },
        direction: 'desc',
      };
    }
  }
}

interface MiniRecord {
  points: number;
  goalsFor: number;
  goalsAgainst: number;
}

/**
 * A table containing only the matches the tied teams played against EACH OTHER.
 *
 * Recomputed at every level of the recursion, over whichever teams are still
 * level at that point — which is the part that makes three-way ties come out
 * right, and the part a pairwise comparator cannot express at all.
 */
function headToHead(
  group: Tally[],
  rules: StandingsRules,
  fixtures: readonly StandingsFixture[],
): Map<string, MiniRecord> {
  const ids = new Set(group.map((m) => m.entry.entryId));
  const records = new Map<string, MiniRecord>(
    group.map((m) => [m.entry.entryId, { points: 0, goalsFor: 0, goalsAgainst: 0 }]),
  );

  for (const fixture of fixtures) {
    if (!ids.has(fixture.homeEntryId) || !ids.has(fixture.awayEntryId)) continue;
    const scoreline = scorelineOf(fixture, rules);
    if (!scoreline || !scoreline.counts) continue;

    const home = records.get(fixture.homeEntryId);
    const away = records.get(fixture.awayEntryId);
    /* c8 ignore next */
    if (!home || !away) continue;

    home.goalsFor += scoreline.home;
    home.goalsAgainst += scoreline.away;
    away.goalsFor += scoreline.away;
    away.goalsAgainst += scoreline.home;

    if (scoreline.home > scoreline.away) {
      home.points += rules.pointsForWin;
      away.points += rules.pointsForLoss;
    } else if (scoreline.home < scoreline.away) {
      away.points += rules.pointsForWin;
      home.points += rules.pointsForLoss;
    } else {
      home.points += rules.pointsForDraw;
      away.points += rules.pointsForDraw;
    }
  }

  return records;
}

/** Splits into runs of equal key, in key order. Stable within each run. */
function partition(
  members: Tally[],
  key: (t: Tally) => number,
  direction: 'asc' | 'desc',
): Tally[][] {
  const sorted = [...members].sort((a, b) => {
    const delta = key(a) - key(b);
    if (delta !== 0) return direction === 'desc' ? -delta : delta;
    return byNameThenId(a, b);
  });

  const groups: Tally[][] = [];
  let current: Tally[] = [];
  let currentKey: number | null = null;

  for (const member of sorted) {
    const value = key(member);
    if (currentKey === null || value === currentKey) {
      current.push(member);
      currentKey = value;
    } else {
      groups.push(current);
      current = [member];
      currentKey = value;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * The final fallback, and the reason the ordering is TOTAL.
 *
 * Ties broken by entry id after name, because two sides of the same club can
 * genuinely carry the same name in different competitions, and an ordering that
 * depends on which row the database returned first is not deterministic.
 */
const byNameThenId = (a: Tally, b: Tally): number => {
  const byName = a.entry.teamName.localeCompare(b.entry.teamName, 'en');
  if (byName !== 0) return byName;
  return a.entry.entryId < b.entry.entryId ? -1 : a.entry.entryId > b.entry.entryId ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const FORM_LENGTH = 5;

function toRow(tally: Tally, position: number, rules: StandingsRules): StandingsRow {
  const pointsEarned =
    tally.won * rules.pointsForWin +
    tally.drawn * rules.pointsForDraw +
    tally.lost * rules.pointsForLoss;

  const form = [...tally.form]
    .sort((a, b) => {
      // Undated matches last, so a fixture with no kickoff cannot masquerade
      // as the team's most recent result.
      if (a.at === null && b.at === null) return 0;
      if (a.at === null) return 1;
      if (b.at === null) return -1;
      return a.at.getTime() - b.at.getTime();
    })
    .slice(-FORM_LENGTH)
    .map((f) => f.outcome);

  return {
    entryId: tally.entry.entryId,
    teamName: tally.entry.teamName,
    position,
    played: tally.played,
    won: tally.won,
    drawn: tally.drawn,
    lost: tally.lost,
    goalsFor: tally.goalsFor,
    goalsAgainst: tally.goalsAgainst,
    goalDifference: tally.goalsFor - tally.goalsAgainst,
    pointsEarned,
    pointsAdjustment: tally.entry.pointsAdjustment,
    points: pointsEarned + tally.entry.pointsAdjustment,
    disciplinePoints: tally.entry.disciplinePoints ?? 0,
    form,
    basis: describeBasis(tally, pointsEarned + tally.entry.pointsAdjustment),
    requiresManualResolution: tally.needsLots,
    tiedWith: tally.tiedWith,
  };
}

const CRITERION_PROSE: Record<TieBreaker, string> = {
  GOAL_DIFFERENCE: 'goal difference',
  GOALS_FOR: 'goals scored',
  GOALS_AGAINST: 'goals conceded',
  HEAD_TO_HEAD_POINTS: 'head-to-head record',
  HEAD_TO_HEAD_GOAL_DIFFERENCE: 'head-to-head goal difference',
  WINS: 'matches won',
  AWAY_GOALS_SCORED: 'goals scored away from home',
  DISCIPLINE_POINTS: 'disciplinary record',
  DRAWING_OF_LOTS: 'a drawing of lots',
};

/**
 * The sentence shown beside the position, written at the moment the ordering
 * was decided.
 *
 * This is not decoration. When a coach emails on Monday asking why his team is
 * second, the answer needs to be in the row — not re-derived a fortnight later
 * from data that has since changed.
 */
function describeBasis(tally: Tally, points: number): string {
  const adjustment =
    tally.entry.pointsAdjustment !== 0
      ? ` (includes a ${tally.entry.pointsAdjustment > 0 ? 'credit' : 'deduction'} of ${Math.abs(tally.entry.pointsAdjustment)})`
      : '';

  if (tally.tiedWith.length === 0 || tally.separatedBy === 'POINTS') {
    return `${points} points${adjustment}.`;
  }

  const others =
    tally.tiedWith.length === 1
      ? tally.tiedWith[0]
      : `${tally.tiedWith.slice(0, -1).join(', ')} and ${tally.tiedWith[tally.tiedWith.length - 1]}`;

  if (tally.separatedBy === 'ALPHABETICAL') {
    return tally.needsLots
      ? `Level on ${points} points${adjustment} with ${others}. The rules call for a drawing of lots; this order is provisional.`
      : `Level on ${points} points${adjustment} with ${others}, and the tiebreakers did not separate them. Listed alphabetically.`;
  }

  const criterion = tally.separatedBy ? CRITERION_PROSE[tally.separatedBy] : 'the tiebreakers';
  return `Level on ${points} points${adjustment} with ${others}; separated on ${criterion}.`;
}

// ---------------------------------------------------------------------------

/** Discipline points for the fair-play tiebreaker, from a team's cards. */
export function disciplinePointsFor(
  cards: readonly { type: string }[],
  rules: StandingsRules,
): number {
  return cards.reduce((total, card) => {
    if (card.type === 'YELLOW_CARD') return total + rules.yellowCardPoints;
    if (card.type === 'RED_CARD' || card.type === 'SECOND_YELLOW_CARD') {
      return total + rules.redCardPoints;
    }
    return total;
  }, 0);
}
