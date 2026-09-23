import { describe, expect, it } from 'vitest';
import {
  authorityOf,
  type MatchReportSource,
  resolveResult,
  type SubmissionFact,
} from '@/server/match/result';

/**
 * The result resolver, exercised directly.
 *
 * This is the function that decides what the score was, and it is pure — so
 * the whole decision table can be walked in milliseconds without a database.
 * Same discipline as the permission matrix, applied to the other question this
 * system will be argued with about for years.
 */

let sequence = 0;
const base = new Date('2025-10-04T22:00:00Z');

function submission(
  source: MatchReportSource,
  homeScore: number | null,
  awayScore: number | null,
  overrides: Partial<SubmissionFact> = {},
): SubmissionFact {
  sequence += 1;
  return {
    id: `s${String(sequence).padStart(3, '0')}`,
    source,
    homeScore,
    awayScore,
    homeForfeit: false,
    awayForfeit: false,
    homePenalties: null,
    awayPenalties: null,
    supersedesId: null,
    // Minutes apart, so "most recent" is unambiguous unless a test says otherwise.
    createdAt: new Date(base.getTime() + sequence * 60_000),
    ...overrides,
  };
}

describe('nothing reported', () => {
  it('says so rather than inventing a nil-nil', () => {
    const resolved = resolveResult([]);
    expect(resolved.state).toBe('NONE');
    expect(resolved.scoreline).toBeNull();
    expect(resolved.decidedBy).toBeNull();
  });
});

describe('a single submission', () => {
  it('is confirmed, and says who by', () => {
    const referee = submission('REFEREE', 2, 1);
    const resolved = resolveResult([referee]);

    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.scoreline).toMatchObject({ homeScore: 2, awayScore: 1 });
    expect(resolved.decidedBy?.id).toBe(referee.id);
    expect(resolved.basis).toContain('referee');
  });
});

describe('authority decides between sources that disagree', () => {
  it('lets the referee overrule both clubs', () => {
    const resolved = resolveResult([
      submission('HOME_TEAM', 3, 1),
      submission('AWAY_TEAM', 1, 1),
      submission('REFEREE', 2, 1),
    ]);

    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.scoreline).toMatchObject({ homeScore: 2, awayScore: 1 });
    expect(resolved.decidedBy?.source).toBe('REFEREE');
  });

  it('lets the league office overrule the referee', () => {
    const resolved = resolveResult([
      submission('REFEREE', 2, 1),
      submission('LEAGUE_ADMIN', 3, 0),
    ]);

    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.decidedBy?.source).toBe('LEAGUE_ADMIN');
    expect(resolved.scoreline).toMatchObject({ homeScore: 3, awayScore: 0 });
  });

  it('does not let an import overrule a human', () => {
    const resolved = resolveResult([submission('IMPORT', 5, 5), submission('AWAY_TEAM', 1, 2)]);
    expect(resolved.decidedBy?.source).toBe('AWAY_TEAM');
  });

  it('ranks the two clubs equally', () => {
    // Ranking home above away would silently resolve every contested match in
    // favour of whoever was at home.
    expect(authorityOf('HOME_TEAM')).toBe(authorityOf('AWAY_TEAM'));
  });
});

describe('when the two clubs disagree, nobody wins', () => {
  const clubsDisagree = () => [submission('HOME_TEAM', 3, 1), submission('AWAY_TEAM', 1, 1)];

  it('reports DISPUTED rather than picking a side', () => {
    const resolved = resolveResult(clubsDisagree());
    expect(resolved.state).toBe('DISPUTED');
    expect(resolved.scoreline).toBeNull();
    expect(resolved.decidedBy).toBeNull();
  });

  it('returns both claims so a human can see what is in dispute', () => {
    const resolved = resolveResult(clubsDisagree());
    expect(resolved.conflicting).toHaveLength(2);
    expect(resolved.conflicting.map((c) => c.source).sort()).toEqual(['AWAY_TEAM', 'HOME_TEAM']);
    expect(resolved.basis).toMatch(/disagree/);
  });

  it('does not resolve merely because the later one was later', () => {
    const early = submission('HOME_TEAM', 3, 1);
    const late = submission('AWAY_TEAM', 1, 1, {
      createdAt: new Date(early.createdAt.getTime() + 86_400_000),
    });
    expect(resolveResult([early, late]).state).toBe('DISPUTED');
  });

  it('is settled the moment the referee reports', () => {
    const resolved = resolveResult([...clubsDisagree(), submission('REFEREE', 2, 2)]);
    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.scoreline).toMatchObject({ homeScore: 2, awayScore: 2 });
  });

  it('is confirmed when both clubs happen to agree', () => {
    const resolved = resolveResult([
      submission('HOME_TEAM', 2, 2),
      submission('AWAY_TEAM', 2, 2),
    ]);
    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.basis).toContain('2 sources agree');
  });
});

describe('corrections supersede rather than overwrite', () => {
  it('uses the correction and remembers what it replaced', () => {
    const original = submission('REFEREE', 2, 1);
    const corrected = submission('REFEREE', 2, 2, { supersedesId: original.id });

    const resolved = resolveResult([original, corrected]);
    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.scoreline).toMatchObject({ homeScore: 2, awayScore: 2 });
    expect(resolved.supersededIds).toEqual([original.id]);
    expect(resolved.basis).toMatch(/1 earlier submission was corrected/);
  });

  it('follows a chain of two corrections to the head', () => {
    const first = submission('REFEREE', 1, 0);
    const second = submission('REFEREE', 2, 0, { supersedesId: first.id });
    const third = submission('REFEREE', 3, 0, { supersedesId: second.id });

    const resolved = resolveResult([first, second, third]);
    expect(resolved.scoreline?.homeScore).toBe(3);
    expect(resolved.supersededIds.sort()).toEqual([first.id, second.id].sort());
  });

  it('does not let a superseded claim keep a match in dispute', () => {
    const homeWrong = submission('HOME_TEAM', 5, 0);
    const homeCorrected = submission('HOME_TEAM', 1, 1, { supersedesId: homeWrong.id });
    const away = submission('AWAY_TEAM', 1, 1);

    expect(resolveResult([homeWrong, homeCorrected, away]).state).toBe('CONFIRMED');
  });

  it('survives a circular supersession chain instead of reporting NONE', () => {
    // The unique index forbids one row being superseded twice and a check
    // constraint forbids self-reference, but a ring stays expressible. Better
    // to say something with a warning than to report a match with two
    // submissions as never played.
    const a = submission('REFEREE', 1, 0, { id: 'ring-a', supersedesId: 'ring-b' });
    const b = submission('REFEREE', 1, 0, { id: 'ring-b', supersedesId: 'ring-a' });

    const resolved = resolveResult([a, b]);
    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.basis).toMatch(/circular/);
  });
});

describe('a source that reports twice is correcting itself, not arguing', () => {
  it('takes the later of two referee submissions without calling it a dispute', () => {
    const first = submission('REFEREE', 1, 0);
    const second = submission('REFEREE', 2, 0);

    const resolved = resolveResult([first, second]);
    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.scoreline?.homeScore).toBe(2);
  });

  it('breaks a timestamp tie deterministically rather than by row order', () => {
    // Two submissions in the same millisecond must not make the answer depend
    // on which order the database returned them in.
    const at = new Date('2025-10-04T22:30:00Z');
    const a = submission('REFEREE', 1, 0, { id: 'aaa', createdAt: at });
    const b = submission('REFEREE', 2, 0, { id: 'bbb', createdAt: at });

    expect(resolveResult([a, b]).scoreline?.homeScore).toBe(2);
    expect(resolveResult([b, a]).scoreline?.homeScore).toBe(2);
  });
});

describe('scorelines that are not two integers', () => {
  it('treats a forfeit as part of the scoreline', () => {
    const resolved = resolveResult([
      submission('LEAGUE_ADMIN', 3, 0, { awayForfeit: true }),
    ]);
    expect(resolved.scoreline).toMatchObject({ homeScore: 3, awayScore: 0, awayForfeit: true });
  });

  it('sees two reports of the same score but different forfeit flags as a dispute', () => {
    const resolved = resolveResult([
      submission('HOME_TEAM', 3, 0, { awayForfeit: true }),
      submission('AWAY_TEAM', 3, 0, { awayForfeit: false }),
    ]);
    expect(resolved.state).toBe('DISPUTED');
  });

  it('distinguishes a drawn tie decided on penalties from one that was not', () => {
    const resolved = resolveResult([
      submission('HOME_TEAM', 1, 1, { homePenalties: 4, awayPenalties: 3 }),
      submission('AWAY_TEAM', 1, 1, { homePenalties: null, awayPenalties: null }),
    ]);
    expect(resolved.state).toBe('DISPUTED');
  });

  it('carries an abandoned match through with no score at all', () => {
    const resolved = resolveResult([submission('REFEREE', null, null)]);
    expect(resolved.state).toBe('CONFIRMED');
    expect(resolved.scoreline).toMatchObject({ homeScore: null, awayScore: null });
  });
});

describe('the answer does not depend on the order rows arrive in', () => {
  it('is identical for every permutation of the same facts', () => {
    const facts = [
      submission('HOME_TEAM', 2, 1),
      submission('AWAY_TEAM', 2, 1),
      submission('REFEREE', 2, 2),
      submission('IMPORT', 9, 9),
    ];

    const expected = JSON.stringify(resolveResult(facts).scoreline);
    for (const permutation of permutations(facts)) {
      expect(JSON.stringify(resolveResult(permutation).scoreline)).toBe(expected);
    }
  });
});

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const output: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      const head = items[i];
      if (head !== undefined) output.push([head, ...tail]);
    }
  }
  return output;
}
