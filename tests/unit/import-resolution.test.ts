import { describe, expect, it } from 'vitest';
import {
  isExactMatch,
  matchingKey,
  normalizeName,
  proposeCandidates,
  STRONG_MATCH,
  trigramSimilarity,
} from '@/server/import/names';
import {
  type ComputedRow,
  diffStandings,
  interpretDiff,
  type PublishedRow,
} from '@/server/import/standings-diff';

/**
 * Entity resolution, which is where a historical import actually spends its
 * time, and where getting it wrong is unrecoverable: silently merging two
 * clubs destroys the evidence that they were ever separate.
 */

describe('normalisation folds noise and nothing else', () => {
  it('keeps the letter when it strips the accent', () => {
    // "kreimir" is what a naive strip of non-ASCII produces, and it matches
    // nothing. This league's names are Croatian, Punjabi, Italian, Portuguese
    // and Vietnamese, so this is the common case, not an edge one.
    expect(normalizeName('Krešimir')).toBe('kresimir');
    expect(normalizeName('Peñarol')).toBe('penarol');
    expect(normalizeName('Sporting Braga Ação')).toBe('sporting braga acao');
  });

  it('folds case, punctuation and doubled spaces', () => {
    expect(normalizeName('  ST.  MARY’S   F.C. ')).toBe('st mary s f c');
  });

  it('writes an ampersand the same way however it arrived', () => {
    expect(normalizeName('Hope & Anchor')).toBe(normalizeName('Hope and Anchor'));
  });

  it('does not merge two different clubs', () => {
    expect(normalizeName('Rutland Rovers')).not.toBe(normalizeName('Rutland Wanderers'));
  });
});

describe('the looser matching key', () => {
  it('ignores a club-type suffix', () => {
    expect(matchingKey('Rutland Rovers FC')).toBe(matchingKey('Rutland Rovers'));
    expect(matchingKey('NK Croatia')).toBe(matchingKey('Croatia'));
  });

  it('never strips "United", because that is which club, not what kind', () => {
    // Stripping it merges every United in the league into one.
    expect(matchingKey('Black Mountain United')).toContain('united');
    expect(matchingKey('Black Mountain United')).not.toBe(matchingKey('Glenmore United'));
  });

  it('keeps a club-type word that is in the middle of a name', () => {
    expect(matchingKey('Sporting Club Milan')).toBe('sporting club milan');
  });

  it('never reduces a name to nothing', () => {
    // A club genuinely called "FC" is better matched on "fc" than on the empty
    // string, which would match everything in the league.
    expect(matchingKey('FC')).toBe('fc');
  });
});

describe('trigram similarity', () => {
  it('scores an identical name as 1', () => {
    expect(trigramSimilarity('Rutland Rovers', 'Rutland Rovers')).toBe(1);
  });

  it('scores an unrelated name near 0', () => {
    expect(trigramSimilarity('Rutland Rovers', 'Peachland Albion')).toBeLessThan(0.2);
  });

  it('scores a spelling variation highly', () => {
    expect(trigramSimilarity('Glenmore Athletic', 'Glenmore Atheltic')).toBeGreaterThan(0.6);
  });

  it('is symmetric', () => {
    const a = trigramSimilarity('Mission Creek', 'Mission Creak');
    const b = trigramSimilarity('Mission Creak', 'Mission Creek');
    expect(a).toBe(b);
  });
});

describe('proposing candidates', () => {
  const clubs = [
    { id: '1', name: 'Rutland Rovers' },
    { id: '2', name: 'Glenmore Athletic' },
    { id: '3', name: 'Mission Creek FC' },
    { id: '4', name: 'Black Mountain United' },
    { id: '5', name: 'Peachland Albion' },
  ];

  it('puts the obvious answer first', () => {
    const [best] = proposeCandidates('Rutland Rovers Football Club', clubs);
    expect(best?.name).toBe('Rutland Rovers');
    expect(best?.score).toBeGreaterThan(STRONG_MATCH);
  });

  it('finds a match through a typo', () => {
    const [best] = proposeCandidates('Glenmore Atheltic', clubs);
    expect(best?.name).toBe('Glenmore Athletic');
  });

  it('finds a match through a dropped suffix', () => {
    const [best] = proposeCandidates('Mission Creek', clubs);
    expect(best?.name).toBe('Mission Creek FC');
  });

  it('offers nothing for a genuinely new club', () => {
    expect(proposeCandidates('Vernon Vipers Soccer Club', clubs)).toHaveLength(0);
  });

  it('does not confidently match one United to another', () => {
    // The failure that silently merges two clubs' histories. If it appears at
    // all it must be BELOW the strong-match line, so a human is asked.
    const candidates = proposeCandidates('Glenmore United', clubs);
    const united = candidates.find((c) => c.name === 'Black Mountain United');
    expect(united?.score ?? 0).toBeLessThan(STRONG_MATCH);
  });

  it('caps the list, because a review queue of forty is a queue nobody works', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `${i}`, name: `Rutland Rovers ${i}` }));
    expect(proposeCandidates('Rutland Rovers', many, { limit: 5 })).toHaveLength(5);
  });

  it('is deterministic when two candidates score identically', () => {
    const tied = [
      { id: 'b', name: 'Zeta Athletic' },
      { id: 'a', name: 'Alpha Athletic' },
    ];
    const first = proposeCandidates('Athletic', tied).map((c) => c.name);
    const second = proposeCandidates('Athletic', [...tied].reverse()).map((c) => c.name);
    expect(first).toEqual(second);
  });
});

describe('exact matching', () => {
  it('treats a spelling difference as exact only after normalisation', () => {
    expect(isExactMatch('Peñarol', 'Penarol')).toBe(true);
    expect(isExactMatch('Rutland Rovers', 'Rutland Rovers FC')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('the recomputed-versus-published diff', () => {
  const computed = (overrides: Partial<ComputedRow> & { teamName: string }): ComputedRow => ({
    entryId: overrides.teamName,
    position: 1,
    played: 10,
    won: 7,
    drawn: 2,
    lost: 1,
    goalsFor: 20,
    goalsAgainst: 8,
    points: 23,
    ...overrides,
  });

  it('reports a clean match', () => {
    const ours = [computed({ teamName: 'Rutland Rovers' })];
    const theirs: PublishedRow[] = [
      { teamName: 'Rutland Rovers', position: 1, played: 10, points: 23 },
    ];
    const diff = diffStandings(ours, theirs);
    expect(diff.matches).toBe(true);
    expect(interpretDiff(diff)[0]).toMatch(/matches the published one exactly/);
  });

  it('ignores a column the source did not publish', () => {
    // Old sites routinely omit the drawn column. Treating absence as zero
    // manufactures a mismatch on every row and buries the real ones.
    const diff = diffStandings([computed({ teamName: 'Rutland Rovers' })], [
      { teamName: 'Rutland Rovers', points: 23, drawn: null },
    ]);
    expect(diff.matches).toBe(true);
  });

  it('names the field, our value and theirs', () => {
    const diff = diffStandings([computed({ teamName: 'Rutland Rovers', points: 23 })], [
      { teamName: 'Rutland Rovers', points: 26 },
    ]);
    expect(diff.matches).toBe(false);
    expect(diff.rows[0]?.differences[0]).toEqual({
      field: 'points',
      computed: 23,
      published: 26,
    });
    expect(diff.summary[0]).toMatch(/we computed 23, the source published 26/);
  });

  it('resolves the source\'s spelling through the alias table before comparing', () => {
    // Comparing raw strings reports every renamed club as a mismatch, which is
    // precisely the thing the import exists to reconcile.
    const diff = diffStandings(
      [computed({ teamName: 'Rutland Rovers' })],
      [{ teamName: 'Rutland Rovers FC', points: 23 }],
      (name) => (name === 'Rutland Rovers FC' ? 'Rutland Rovers' : name),
    );
    expect(diff.matches).toBe(true);
  });

  it('lists teams that appear on only one side', () => {
    const diff = diffStandings(
      [computed({ teamName: 'Rutland Rovers' })],
      [{ teamName: 'Glenmore Athletic', points: 23 }],
    );
    expect(diff.missingFromComputed).toEqual(['Glenmore Athletic']);
    expect(diff.missingFromPublished).toEqual(['Rutland Rovers']);
    expect(interpretDiff(diff)[0]).toMatch(/alias table first/);
  });

  describe('pointing at the likely culprit', () => {
    it('blames the importer when goal totals differ', () => {
      const diff = diffStandings([computed({ teamName: 'A', goalsFor: 20 })], [
        { teamName: 'A', goalsFor: 22 },
      ]);
      expect(interpretDiff(diff).join(' ')).toMatch(/imported RESULTS differ/);
    });

    it('blames the rules when only the order differs', () => {
      // The most valuable finding this diff produces: every figure agrees and
      // the order does not, which means the tiebreakers configured for the
      // competition are not the ones the league used.
      const diff = diffStandings([computed({ teamName: 'A', position: 2 })], [
        { teamName: 'A', position: 1 },
      ]);
      expect(interpretDiff(diff).join(' ')).toMatch(/tiebreaker disagreement/);
    });

    it('blames a deduction when results agree but points do not', () => {
      const diff = diffStandings([computed({ teamName: 'A', points: 23 })], [
        { teamName: 'A', points: 20, won: 7, drawn: 2 },
      ]);
      expect(interpretDiff(diff).join(' ')).toMatch(/points deduction/);
    });
  });
});
