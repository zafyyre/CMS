/**
 * Comparing names across twelve seasons of a league's records.
 *
 * The hard constraint: this league's clubs are Croatian, Punjabi, Italian,
 * Portuguese and Vietnamese. Any normalisation that assumes English will merge
 * things that are different and separate things that are the same, and both
 * failures are silent.
 *
 * So normalisation here is deliberately CONSERVATIVE. It folds the differences
 * that are certainly noise — case, accents, punctuation, doubled spaces, the
 * club-type suffixes every league writes inconsistently — and stops. Anything
 * beyond that is left to trigram similarity, which produces a SCORE, which a
 * human then confirms. A confident normaliser and an unconfirmed match are the
 * two ways to silently merge two clubs' histories, and that is not a bug you
 * can find afterwards: the evidence that they were separate is exactly what
 * gets destroyed.
 */

/**
 * Suffixes that describe what kind of club something is rather than which club.
 *
 * Stripped only from the ends of a name, and only when something is left over.
 * "United" is NOT here, and never will be: it is part of a club's identity, and
 * removing it merges every United in the league into one.
 */
const CLUB_TYPE_TOKENS = new Set([
  'fc',
  'afc',
  'sc',
  'cf',
  'sac',
  'ssc',
  'nk',
  'fk',
  'cd',
  'club',
  'soccer',
  'football',
]);

/** Case, accents and punctuation folded. Word order and content preserved. */
export function normalizeName(value: string): string {
  return (
    value
      .normalize('NFKD')
      // Combining marks: "Krešimir" becomes "kresimir", not "kreimir".
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      // Ampersand is written three ways by the same person in one file.
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

/**
 * A second, looser key with club-type words removed.
 *
 * Used only to widen the CANDIDATE search, never to declare a match. "Rutland
 * Rovers FC" and "Rutland Rovers" produce the same loose key; whether they are
 * the same club is still a question for a person.
 */
export function matchingKey(value: string): string {
  const words = normalizeName(value).split(' ').filter(Boolean);

  /**
   * Strip from the ends REPEATEDLY, not once.
   *
   * "Rutland Rovers Football Club" carries two type words in a row, and
   * removing only the last leaves "rutland rovers football" — which scores
   * around 0.6 against "Rutland Rovers" and falls below the threshold for a
   * pairing any human would call obvious.
   *
   * Only from the ends, so "Sporting Club Milan" keeps its middle word.
   */
  let start = 0;
  let end = words.length;
  let changed = true;
  while (changed && end - start > 1) {
    changed = false;
    if (CLUB_TYPE_TOKENS.has(words[start] as string)) {
      start++;
      changed = true;
    }
    if (end - start > 1 && CLUB_TYPE_TOKENS.has(words[end - 1] as string)) {
      end--;
      changed = true;
    }
  }

  const result = words.slice(start, end).join(' ').trim();
  // Never return nothing: a club genuinely called "FC" is better matched on
  // "fc" than on the empty string, which would match everything.
  return result || normalizeName(value);
}

/**
 * Trigram similarity, matching PostgreSQL's `similarity()` closely enough to
 * rank candidates the same way.
 *
 * Exists so ranking and thresholds can be unit-tested without a database, and
 * so a proposal built in memory during a dry run scores the same as one built
 * by a query. It is Jaccard over the two strings' trigram sets, which is what
 * pg_trgm computes.
 */
export function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 && right.size === 0) return a === b ? 1 : 0;
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / (left.size + right.size - shared);
}

/**
 * pg_trgm pads each word with two leading spaces and one trailing space before
 * cutting it into three-character windows. Reproduced exactly, because a
 * different padding gives different scores and the whole point is that the
 * in-memory ranking agrees with the database's.
 */
function trigrams(value: string): Set<string> {
  const grams = new Set<string>();
  for (const word of normalizeName(value).split(' ').filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      grams.add(padded.slice(i, i + 3));
    }
  }
  return grams;
}

export interface Candidate {
  id: string;
  name: string;
  score: number;
}

/**
 * Rank known names against an unknown one.
 *
 * Returns everything above `threshold`, best first, capped — a review queue
 * showing forty candidates is a review queue nobody works through.
 */
export function proposeCandidates(
  unknown: string,
  known: readonly { id: string; name: string }[],
  { threshold = 0.35, limit = 5 }: { threshold?: number; limit?: number } = {},
): Candidate[] {
  const target = matchingKey(unknown);

  return known
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      // Score on the looser key so a club-type suffix does not push a genuine
      // match below the threshold.
      score: Math.max(
        trigramSimilarity(target, matchingKey(entity.name)),
        trigramSimilarity(normalizeName(unknown), normalizeName(entity.name)),
      ),
    }))
    .filter((candidate) => candidate.score >= threshold)
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.name.localeCompare(b.name, 'en')))
    .slice(0, limit);
}

/**
 * The confidence at which a proposal is offered as the obvious answer rather
 * than one of several.
 *
 * Deliberately high, and deliberately NOT a threshold for accepting
 * automatically. Above this the review queue pre-selects the candidate; a human
 * still confirms. The cost of a wrong automatic merge is losing the fact that
 * two clubs were ever separate; the cost of a needless confirmation is four
 * seconds.
 */
export const STRONG_MATCH = 0.85;

/** An exact match after normalisation. The only thing resolved without review. */
export const isExactMatch = (a: string, b: string): boolean =>
  normalizeName(a) === normalizeName(b);
