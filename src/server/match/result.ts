/**
 * What was the score?
 *
 * A harder question than it looks, and the reason `result_submissions` is a
 * list of attributed claims rather than a `results` table with two integers in
 * it. Over one weekend a league receives, for the same match: the referee's
 * report, the home team's entry, the away team's entry, and occasionally a
 * committee decision the following Wednesday. They do not always agree, and
 * the disagreement is the thing the league has to resolve — so a schema that
 * can only hold one number has already thrown away the problem.
 *
 * This function derives the answer from the facts and SHOWS ITS WORKING. Pure:
 * no database, no clock, no I/O, so the whole decision table can be exercised
 * in milliseconds and reasoned about without running anything. It is the same
 * discipline as `src/server/authz/can.ts`, applied to a different question.
 *
 * It is allowed to answer "DISPUTED". A system that always produces a number
 * is a system that silently picks a side.
 */

export type MatchReportSource = 'REFEREE' | 'HOME_TEAM' | 'AWAY_TEAM' | 'LEAGUE_ADMIN' | 'IMPORT';

/**
 * Whose word counts for more, and why.
 *
 * LEAGUE_ADMIN is top because a committee decision is the end of the argument
 * by definition. The referee is the match official and outranks the clubs.
 * The two clubs are deliberately EQUAL — ranking the home team above the away
 * team would quietly resolve every disputed match in favour of whoever was at
 * home, which is precisely the bias this table exists to avoid.
 *
 * IMPORT is lowest: a scraped or migrated score has no author who can be asked
 * about it, so a human contradicting it deserves to be surfaced rather than
 * overruled by a historical file.
 */
const AUTHORITY: Record<MatchReportSource, number> = {
  LEAGUE_ADMIN: 4,
  REFEREE: 3,
  HOME_TEAM: 2,
  AWAY_TEAM: 2,
  IMPORT: 1,
};

export interface SubmissionFact {
  id: string;
  source: MatchReportSource;
  homeScore: number | null;
  awayScore: number | null;
  homeForfeit: boolean;
  awayForfeit: boolean;
  homePenalties: number | null;
  awayPenalties: number | null;
  supersedesId: string | null;
  createdAt: Date;
}

export interface Scoreline {
  homeScore: number | null;
  awayScore: number | null;
  homeForfeit: boolean;
  awayForfeit: boolean;
  homePenalties: number | null;
  awayPenalties: number | null;
}

export type ResultState =
  /** Nothing has been reported. */
  | 'NONE'
  /** Every claim that still stands agrees. */
  | 'CONFIRMED'
  /** Two sources of equal standing disagree; a human has to decide. */
  | 'DISPUTED';

export interface ResolvedResult {
  state: ResultState;
  /** Null unless CONFIRMED. Callers must not fall back to a default score. */
  scoreline: Scoreline | null;
  /** The submission the answer rests on, when there is one. */
  decidedBy: SubmissionFact | null;
  /** The competing claims, when DISPUTED. Empty otherwise. */
  conflicting: SubmissionFact[];
  /** Submissions replaced by a later correction. */
  supersededIds: string[];
  /**
   * The reasoning, in a sentence, for display next to the score.
   *
   * Persisted reasoning is the difference between a table you can defend and
   * one you re-derive under pressure when a coach emails to dispute it.
   */
  basis: string;
}

export function resolveResult(submissions: readonly SubmissionFact[]): ResolvedResult {
  if (submissions.length === 0) {
    return {
      state: 'NONE',
      scoreline: null,
      decidedBy: null,
      conflicting: [],
      supersededIds: [],
      basis: 'No result has been submitted.',
    };
  }

  const replaced = new Set(
    submissions.map((s) => s.supersedesId).filter((id): id is string => id !== null),
  );
  const supersededIds = submissions.map((s) => s.id).filter((id) => replaced.has(id));
  let live = submissions.filter((s) => !replaced.has(s.id));

  /**
   * A → B → A. The unique index stops one submission being superseded twice
   * and a check constraint stops self-reference, but neither forbids a ring,
   * so it stays possible in principle. Falling back to every submission and
   * saying so is better than reporting NONE for a match that plainly has
   * results attached.
   */
  const cyclic = live.length === 0;
  if (cyclic) live = [...submissions];

  const topAuthority = Math.max(...live.map((s) => AUTHORITY[s.source]));
  const contenders = live.filter((s) => AUTHORITY[s.source] === topAuthority);

  /**
   * One source correcting itself without bothering to set `supersedesId` — a
   * referee re-submitting their report — is not a dispute. Keep only each
   * source's latest claim before comparing.
   */
  const latestPerSource = new Map<MatchReportSource, SubmissionFact>();
  for (const submission of contenders) {
    const held = latestPerSource.get(submission.source);
    if (!held || isLater(submission, held)) latestPerSource.set(submission.source, submission);
  }
  const distinct = [...latestPerSource.values()];

  const [first, ...rest] = distinct;
  /* c8 ignore next -- `live` is non-empty here, so `distinct` cannot be */
  if (!first) throw new Error('resolveResult: no contenders after grouping');

  const disagreeing = rest.filter((other) => !sameScoreline(first, other));
  if (disagreeing.length > 0) {
    return {
      state: 'DISPUTED',
      scoreline: null,
      decidedBy: null,
      conflicting: [...distinct].sort(byRecency),
      supersededIds,
      basis:
        `${distinct.length} sources of equal standing disagree ` +
        `(${distinct.map(describe).join(' vs ')}). A ${higherThan(topAuthority)} decision is required.`,
    };
  }

  // Agreement. Report the most recent of the agreeing claims as the basis, so
  // the attribution shown is the freshest one rather than an arbitrary pick.
  const decidedBy = distinct.reduce((best, s) => (isLater(s, best) ? s : best), first);

  return {
    state: 'CONFIRMED',
    scoreline: toScoreline(decidedBy),
    decidedBy,
    conflicting: [],
    supersededIds,
    basis: basisFor(decidedBy, distinct.length, supersededIds.length, cyclic),
  };
}

function basisFor(
  decidedBy: SubmissionFact,
  agreeingCount: number,
  supersededCount: number,
  cyclic: boolean,
): string {
  const parts = [`Confirmed by the ${sourceLabel(decidedBy.source)} submission.`];
  if (agreeingCount > 1) parts.push(`${agreeingCount} sources agree.`);
  if (supersededCount > 0) {
    parts.push(
      `${supersededCount} earlier ${supersededCount === 1 ? 'submission was' : 'submissions were'} corrected.`,
    );
  }
  if (cyclic) {
    parts.push('Warning: the supersession chain is circular and was ignored.');
  }
  return parts.join(' ');
}

const SOURCE_LABELS: Record<MatchReportSource, string> = {
  LEAGUE_ADMIN: 'league office',
  REFEREE: 'referee',
  HOME_TEAM: 'home team',
  AWAY_TEAM: 'away team',
  IMPORT: 'imported records',
};

export const sourceLabel = (source: MatchReportSource): string => SOURCE_LABELS[source];

const describe = (s: SubmissionFact): string =>
  `${sourceLabel(s.source)} ${s.homeScore ?? '–'}–${s.awayScore ?? '–'}`;

const higherThan = (authority: number): string =>
  authority >= AUTHORITY.LEAGUE_ADMIN ? 'committee' : 'league office';

export const toScoreline = (s: Scoreline): Scoreline => ({
  homeScore: s.homeScore,
  awayScore: s.awayScore,
  homeForfeit: s.homeForfeit,
  awayForfeit: s.awayForfeit,
  homePenalties: s.homePenalties,
  awayPenalties: s.awayPenalties,
});

export const sameScoreline = (a: Scoreline, b: Scoreline): boolean =>
  a.homeScore === b.homeScore &&
  a.awayScore === b.awayScore &&
  a.homeForfeit === b.homeForfeit &&
  a.awayForfeit === b.awayForfeit &&
  a.homePenalties === b.homePenalties &&
  a.awayPenalties === b.awayPenalties;

/**
 * Ties on the timestamp are broken by id. UUIDv7 is time-ordered, so this is
 * still "later" in every practical sense — and, more importantly, it is
 * TOTAL: without it, two submissions recorded in the same millisecond would
 * make the resolved result depend on the order the database happened to return
 * rows in, which is the kind of non-determinism that shows up once a season.
 */
const isLater = (a: SubmissionFact, b: SubmissionFact): boolean =>
  a.createdAt.getTime() === b.createdAt.getTime()
    ? a.id > b.id
    : a.createdAt.getTime() > b.createdAt.getTime();

const byRecency = (a: SubmissionFact, b: SubmissionFact): number => (isLater(a, b) ? -1 : 1);

/** Ordering used when authority is equal and both submissions must be shown. */
export const authorityOf = (source: MatchReportSource): number => AUTHORITY[source];
