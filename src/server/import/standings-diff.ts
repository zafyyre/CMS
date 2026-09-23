/**
 * Compare a table we RECOMPUTED against the table the source PUBLISHED.
 *
 * This is the acceptance test for the whole historical import, and it is worth
 * more than any of its parts. Import a past season's results, recompute its
 * final table with the Phase 4 engine, and diff the answer against the table
 * the old site actually showed. One comparison simultaneously validates:
 *
 *   - the importer, because wrong results give wrong tables
 *   - the schema, because a result that will not fit is a result that is missing
 *   - the standings engine, because the tiebreakers have to reach the same
 *     conclusion the league did
 *
 * Where they disagree, one of those three is wrong and you have a precise,
 * bounded thing to look at — rather than a vague sense that the import "seems
 * about right", which is the state most data migrations ship in.
 *
 * Pure, so it can be run over a fixture corpus with no database.
 */

export interface PublishedRow {
  /** As the source spells it. Matched through the alias table before this. */
  teamName: string;
  position?: number | null;
  played?: number | null;
  won?: number | null;
  drawn?: number | null;
  lost?: number | null;
  goalsFor?: number | null;
  goalsAgainst?: number | null;
  points?: number | null;
}

export interface ComputedRow {
  entryId: string;
  teamName: string;
  position: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
}

export type DiffField =
  | 'position'
  | 'played'
  | 'won'
  | 'drawn'
  | 'lost'
  | 'goalsFor'
  | 'goalsAgainst'
  | 'points';

export interface FieldDifference {
  field: DiffField;
  computed: number;
  published: number;
}

export interface RowDifference {
  teamName: string;
  differences: FieldDifference[];
}

export interface StandingsDiff {
  matches: boolean;
  /** Teams in the published table that we did not compute a row for. */
  missingFromComputed: string[];
  /** Teams we computed that the published table does not list. */
  missingFromPublished: string[];
  rows: RowDifference[];
  /** One line per problem, ready to print from a script. */
  summary: string[];
}

const FIELDS: DiffField[] = [
  'position',
  'played',
  'won',
  'drawn',
  'lost',
  'goalsFor',
  'goalsAgainst',
  'points',
];

/**
 * @param resolveName maps a published team name to the canonical name we
 *   computed under. Supplied by the alias table, because the source's spelling
 *   is exactly what the import is trying to reconcile — comparing raw strings
 *   would report every renamed club as a mismatch and drown the real ones.
 */
export function diffStandings(
  computed: readonly ComputedRow[],
  published: readonly PublishedRow[],
  resolveName: (name: string) => string = (n) => n,
): StandingsDiff {
  const computedByName = new Map(computed.map((row) => [row.teamName, row]));
  const seen = new Set<string>();
  const rows: RowDifference[] = [];
  const missingFromComputed: string[] = [];

  for (const publishedRow of published) {
    const canonical = resolveName(publishedRow.teamName);
    const computedRow = computedByName.get(canonical);

    if (!computedRow) {
      missingFromComputed.push(publishedRow.teamName);
      continue;
    }
    seen.add(canonical);

    const differences: FieldDifference[] = [];
    for (const field of FIELDS) {
      const expected = publishedRow[field];
      // A field the source did not publish is not a disagreement. Old sites
      // routinely omit the drawn column, and treating absence as zero would
      // manufacture a mismatch on every row.
      if (expected === null || expected === undefined) continue;
      if (computedRow[field] !== expected) {
        differences.push({ field, computed: computedRow[field], published: expected });
      }
    }

    if (differences.length > 0) {
      rows.push({ teamName: publishedRow.teamName, differences });
    }
  }

  const missingFromPublished = computed
    .filter((row) => !seen.has(row.teamName))
    .map((row) => row.teamName);

  const summary: string[] = [];
  for (const name of missingFromComputed) {
    summary.push(`${name}: in the published table but not in ours — unresolved alias, or a missing entry.`);
  }
  for (const name of missingFromPublished) {
    summary.push(`${name}: in our table but not in the published one — an extra entry, or a name we failed to match.`);
  }
  for (const row of rows) {
    for (const difference of row.differences) {
      summary.push(
        `${row.teamName}: ${difference.field} — we computed ${difference.computed}, the source published ${difference.published}.`,
      );
    }
  }

  return {
    matches:
      rows.length === 0 && missingFromComputed.length === 0 && missingFromPublished.length === 0,
    missingFromComputed,
    missingFromPublished,
    rows,
    summary,
  };
}

/**
 * A hint at WHICH of the three suspects is wrong, from the shape of the
 * disagreement.
 *
 * Not authoritative — it is a starting point for the investigation, which is
 * what saves the time. A points-only difference has a very different cause from
 * a goals difference, and knowing which to look at first is most of the work.
 */
export function interpretDiff(diff: StandingsDiff): string[] {
  if (diff.matches) return ['The recomputed table matches the published one exactly.'];

  const fields = new Set(diff.rows.flatMap((r) => r.differences.map((d) => d.field)));
  const hints: string[] = [];

  if (diff.missingFromComputed.length > 0 || diff.missingFromPublished.length > 0) {
    hints.push(
      'Some teams did not line up at all. Check the alias table first — a rename ' +
        'between seasons is the usual cause, and every other difference is noise until it is fixed.',
    );
  }
  if (fields.has('goalsFor') || fields.has('goalsAgainst')) {
    hints.push(
      'Goal totals disagree, so the imported RESULTS differ from the source. ' +
        'Suspect the importer or a missing fixture, not the standings engine.',
    );
  }
  if (fields.has('played')) {
    hints.push(
      'Match counts disagree — fixtures are missing, duplicated, or a forfeit is ' +
        'being counted differently from the way the league counted it.',
    );
  }
  if (fields.has('points') && !fields.has('won') && !fields.has('drawn')) {
    hints.push(
      'Results agree but points do not: a points deduction the source applied and ' +
        'we have not imported, or the wrong points-for-a-win in the competition rules.',
    );
  }
  if (fields.has('position') && fields.size === 1) {
    hints.push(
      'Every figure agrees and only the ORDER differs. This is a tiebreaker ' +
        'disagreement — the most valuable kind of finding here, because it means ' +
        'the rules configured for this competition are not the ones the league used.',
    );
  }

  return hints;
}
