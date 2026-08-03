import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { uuidv7 } from 'uuidv7';
import { withOrg } from '@/db';
import { clubs, teams } from '@/db/schema';
import {
  closeFixtures,
  createLeagueFixture,
  type LeagueFixture,
  truncateAll,
} from '../helpers/fixtures';

/**
 * Foreign keys must not cross league boundaries.
 *
 * Row-level security filters what a league can READ, but foreign-key
 * constraint checks run with elevated privilege and bypass policies entirely.
 * Before composite keys, league A could create a team referencing a club in
 * league B — a club it could not see — and league B was then permanently
 * unable to delete its own club, blocked by an invisible row. Reproduced
 * against a live database, then fixed by carrying org_id into every reference
 * between league-scoped tables.
 *
 * These tests assert both halves: the cross-league reference is impossible,
 * and the ordinary same-league one still works.
 */

let alpha: LeagueFixture;
let bravo: LeagueFixture;

function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 6) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' | ');
}

beforeEach(async () => {
  await truncateAll();
  alpha = await createLeagueFixture('alpha');
  bravo = await createLeagueFixture('bravo');
});

afterAll(async () => {
  await closeFixtures();
});

describe('a league cannot reference another league\'s rows', () => {
  it('rejects a team whose club belongs to a different league', async () => {
    let caught: unknown;
    try {
      await withOrg(alpha.orgId, async (tx) =>
        tx.insert(teams).values({
          id: uuidv7(),
          orgId: alpha.orgId,
          // bravo's club — invisible to alpha, and now unreferenceable.
          clubId: bravo.clubId,
          name: 'Smuggled',
          slug: 'smuggled',
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught, 'a cross-league foreign key must be rejected').toBeDefined();
    expect(messageChain(caught)).toMatch(/foreign key constraint/i);
  });

  it('still allows an ordinary same-league reference', async () => {
    // The fix must not break the normal case.
    const created = await withOrg(alpha.orgId, async (tx) =>
      tx
        .insert(teams)
        .values({
          id: uuidv7(),
          orgId: alpha.orgId,
          clubId: alpha.clubId,
          name: 'Legitimate',
          slug: 'legitimate',
        })
        .returning(),
    );
    expect(created).toHaveLength(1);
  });

  it('leaves the other league able to delete an unreferenced club of its own', async () => {
    /**
     * The concrete harm the old behaviour caused: an invisible reference from
     * another league made a club permanently undeletable by its owner, with an
     * error naming a table outside its tenant.
     *
     * A fresh club with nothing pointing at it isolates that claim — the
     * fixture's own club is legitimately held by a team and an edition entry,
     * which is ordinary referential integrity and not what is under test.
     */
    const [fresh] = await withOrg(bravo.orgId, async (tx) =>
      tx
        .insert(clubs)
        .values({ id: uuidv7(), orgId: bravo.orgId, name: 'Spare FC', slug: 'spare-fc' })
        .returning(),
    );

    // Alpha cannot attach anything to it, so nothing invisible can block this.
    const deleted = await withOrg(bravo.orgId, async (tx) =>
      tx.delete(clubs).where(eq(clubs.id, fresh!.id)).returning(),
    );
    expect(deleted).toHaveLength(1);
  });
});
