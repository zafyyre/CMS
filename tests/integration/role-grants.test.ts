import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withOrg } from '@/db';
import { loadActiveGrants } from '@/server/auth/principal';
import { roleGrants } from '@/db/schema';
import {
  closeFixtures,
  createLeagueFixture,
  type LeagueFixture,
  rootDb,
  truncateAll,
} from '../helpers/fixtures';

/**
 * Role grants carry a validity window, and this suite proves it behaves.
 *
 * The claim being tested: a club secretary whose term ended in June stops being
 * one automatically, without anyone remembering to delete a row — and the
 * record of them having held it survives, which is what you need when someone
 * asks who approved a transfer last season.
 *
 * The old system has no way to express any of this.
 */

let alpha: LeagueFixture;
let bravo: LeagueFixture;

const CLUB_SCOPE = '11111111-1111-7111-8111-111111111111';

const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

beforeEach(async () => {
  await truncateAll();
  alpha = await createLeagueFixture('alpha');
  bravo = await createLeagueFixture('bravo');
});

afterAll(async () => {
  await closeFixtures();
});

describe('validity windows', () => {
  it('includes an open-ended grant that has started', async () => {
    await rootDb.insert(roleGrants).values({
      orgId: alpha.orgId,
      personId: alpha.personId,
      role: 'LEAGUE_ADMIN',
      scopeKind: 'ORGANIZATION',
      validFrom: daysFromNow(-30),
      validUntil: null,
    });

    const grants = await withOrg(alpha.orgId, (tx) => loadActiveGrants(tx, alpha.personId));
    expect(grants).toHaveLength(1);
    expect(grants[0]?.role).toBe('LEAGUE_ADMIN');
  });

  it('excludes a grant whose term has ended — with nobody deleting anything', async () => {
    await rootDb.insert(roleGrants).values({
      orgId: alpha.orgId,
      personId: alpha.personId,
      role: 'CLUB_ADMIN',
      scopeKind: 'CLUB',
      scopeId: CLUB_SCOPE,
      validFrom: daysFromNow(-400),
      validUntil: daysFromNow(-30), // ended a month ago
    });

    const grants = await withOrg(alpha.orgId, (tx) => loadActiveGrants(tx, alpha.personId));
    expect(grants).toHaveLength(0);

    // But the row is still there — the history of who held what survives.
    const stillRecorded = await withOrg(alpha.orgId, async (tx) => tx.select().from(roleGrants));
    expect(stillRecorded).toHaveLength(1);
  });

  it('excludes a grant that has not started yet', async () => {
    await rootDb.insert(roleGrants).values({
      orgId: alpha.orgId,
      personId: alpha.personId,
      role: 'REGISTRAR',
      scopeKind: 'ORGANIZATION',
      validFrom: daysFromNow(30), // takes office next month
    });

    const grants = await withOrg(alpha.orgId, (tx) => loadActiveGrants(tx, alpha.personId));
    expect(grants).toHaveLength(0);
  });

  it('excludes a revoked grant even while its window is open', async () => {
    await rootDb.insert(roleGrants).values({
      orgId: alpha.orgId,
      personId: alpha.personId,
      role: 'LEAGUE_ADMIN',
      scopeKind: 'ORGANIZATION',
      status: 'REVOKED',
      validFrom: daysFromNow(-30),
    });

    const grants = await withOrg(alpha.orgId, (tx) => loadActiveGrants(tx, alpha.personId));
    expect(grants).toHaveLength(0);
  });
});

describe('one human, several simultaneous roles', () => {
  it('returns every currently-valid grant together', async () => {
    await rootDb.insert(roleGrants).values([
      {
        orgId: alpha.orgId,
        personId: alpha.personId,
        role: 'PLAYER',
        scopeKind: 'ORGANIZATION',
        validFrom: daysFromNow(-100),
      },
      {
        orgId: alpha.orgId,
        personId: alpha.personId,
        role: 'COACH',
        scopeKind: 'TEAM',
        scopeId: alpha.teamId,
        validFrom: daysFromNow(-50),
      },
      {
        orgId: alpha.orgId,
        personId: alpha.personId,
        role: 'REFEREE',
        scopeKind: 'ORGANIZATION',
        validFrom: daysFromNow(-10),
      },
    ]);

    const grants = await withOrg(alpha.orgId, (tx) => loadActiveGrants(tx, alpha.personId));
    expect(grants.map((g) => g.role).sort()).toEqual(['COACH', 'PLAYER', 'REFEREE']);

    const coach = grants.find((g) => g.role === 'COACH');
    expect(coach?.scopeKind).toBe('TEAM');
    expect(coach?.scopeId).toBe(alpha.teamId);
  });
});

describe('grants never cross leagues', () => {
  it('does not return a grant held in another league', async () => {
    // The same person id does not exist in bravo, but assert the isolation
    // explicitly: a grant written into bravo must be invisible from alpha.
    await rootDb.insert(roleGrants).values({
      orgId: bravo.orgId,
      personId: bravo.personId,
      role: 'LEAGUE_ADMIN',
      scopeKind: 'ORGANIZATION',
      validFrom: daysFromNow(-30),
    });

    const fromAlpha = await withOrg(alpha.orgId, (tx) => loadActiveGrants(tx, bravo.personId));
    expect(fromAlpha).toHaveLength(0);

    const fromBravo = await withOrg(bravo.orgId, (tx) => loadActiveGrants(tx, bravo.personId));
    expect(fromBravo).toHaveLength(1);
  });
});
