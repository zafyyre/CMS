import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withOrg, withSystem } from '@/db';
import { auditLog } from '@/db/schema';
import {
  closeFixtures,
  createLeagueFixture,
  type LeagueFixture,
  truncateAll,
} from '../helpers/fixtures';

/**
 * An audit trail the application can rewrite is not evidence.
 *
 * The permission matrix withholds update and delete on audit rows, but an
 * application-layer rule is only as strong as the code that consults it — and
 * the scenario an audit log exists to survive is precisely our own service
 * being compromised or buggy. So PostgreSQL has to refuse as well, and these
 * tests prove that it does.
 */

let alpha: LeagueFixture;
let bravo: LeagueFixture;

beforeEach(async () => {
  await truncateAll();
  alpha = await createLeagueFixture('alpha');
  bravo = await createLeagueFixture('bravo');
});

afterAll(async () => {
  await closeFixtures();
});

async function writeEntry(league: LeagueFixture, action = 'club.create') {
  return withOrg(league.orgId, async (tx) => {
    const [row] = await tx
      .insert(auditLog)
      .values({
        orgId: league.orgId,
        action,
        entityType: 'club',
        entityId: league.clubId,
        after: { name: `${league.slug} FC` },
      })
      .returning();
    return row;
  });
}

describe('the audit log records', () => {
  it('accepts an append and reads it back', async () => {
    const written = await writeEntry(alpha);
    expect(written?.id).toBeDefined();

    const rows = await withOrg(alpha.orgId, async (tx) => tx.select().from(auditLog));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('club.create');
    expect(rows[0]?.orgId).toBe(alpha.orgId);
  });

  it('keeps entries inside their own league', async () => {
    await writeEntry(alpha);

    const visibleToBravo = await withOrg(bravo.orgId, async (tx) => tx.select().from(auditLog));
    expect(visibleToBravo).toHaveLength(0);
  });
});

describe('the audit log is immutable in the database, not merely by convention', () => {
  /**
   * Note the MECHANISM. With RLS forced and no DELETE or UPDATE policy present,
   * PostgreSQL does not raise an error — it simply matches no rows. So the
   * assertion is "nothing changed", not "it threw". Asserting a throw here
   * would fail, and asserting it loosely would give false confidence.
   */
  it('cannot delete an entry', async () => {
    const written = await writeEntry(alpha);

    const deleted = await withOrg(alpha.orgId, async (tx) =>
      tx.delete(auditLog).where(eq(auditLog.id, written!.id)).returning(),
    );
    expect(deleted).toHaveLength(0);

    const survivors = await withOrg(alpha.orgId, async (tx) => tx.select().from(auditLog));
    expect(survivors).toHaveLength(1);
  });

  it('cannot rewrite an entry', async () => {
    const written = await writeEntry(alpha);

    const updated = await withOrg(alpha.orgId, async (tx) =>
      tx
        .update(auditLog)
        .set({ action: 'something.else', reason: 'covering tracks' })
        .where(eq(auditLog.id, written!.id))
        .returning(),
    );
    expect(updated).toHaveLength(0);

    const [row] = await withOrg(alpha.orgId, async (tx) => tx.select().from(auditLog));
    expect(row?.action).toBe('club.create');
    expect(row?.reason).toBeNull();
  });

  it('cannot delete another league\'s entries either', async () => {
    await writeEntry(bravo);

    const deleted = await withOrg(alpha.orgId, async (tx) =>
      tx.delete(auditLog).returning(),
    );
    expect(deleted).toHaveLength(0);

    const bravoRows = await withOrg(bravo.orgId, async (tx) => tx.select().from(auditLog));
    expect(bravoRows).toHaveLength(1);
  });

  it('cannot be wiped from a system context either', async () => {
    await writeEntry(alpha);

    const deleted = await withSystem('attempt a global wipe', async (tx) =>
      tx.delete(auditLog).returning(),
    );
    expect(deleted).toHaveLength(0);

    const rows = await withOrg(alpha.orgId, async (tx) => tx.select().from(auditLog));
    expect(rows).toHaveLength(1);
  });
});
