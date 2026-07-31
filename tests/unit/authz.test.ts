import { describe, expect, it } from 'vitest';
import { unsafeAsOrgId } from '@/db/org-id';
import { can } from '@/server/authz/can';
import { ACTIONS, type Action, RESOURCES, ROLE_GRANTS } from '@/server/authz/permissions';
import { MFA_REQUIRED_ROLES, type Principal, ROLES, type Role } from '@/server/authz/roles';

/**
 * The permission matrix, exercised directly.
 *
 * A pure function with no database and no fixtures, so this runs in
 * milliseconds and can afford to be exhaustive. "What exactly can a club admin
 * do?" is a question this project will be asked for years; these tests are the
 * answer, and they fail the moment the answer changes by accident.
 */

const CLUB_A = '11111111-1111-7111-8111-111111111111';
const CLUB_B = '22222222-2222-7222-8222-222222222222';
const TEAM_A = '33333333-3333-7333-8333-333333333333';
const TEAM_B = '44444444-4444-7444-8444-444444444444';

function principal(roles: Principal['roles'], overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    personId: 'person-1',
    orgId: unsafeAsOrgId('00000000-0000-7000-8000-000000000000', 'unit test'),
    roles,
    mfaSatisfied: true,
    ...overrides,
  };
}

const orgRole = (role: Role) => [{ role, scopeKind: 'ORGANIZATION' as const, scopeId: null }];

describe('matrix integrity', () => {
  it('declares a grant table for every role', () => {
    for (const role of ROLES) {
      expect(ROLE_GRANTS[role], `${role} has no grant entry`).toBeDefined();
    }
  });

  it('never grants an unknown resource or action', () => {
    for (const role of ROLES) {
      for (const [resource, actions] of Object.entries(ROLE_GRANTS[role])) {
        expect(RESOURCES).toContain(resource);
        for (const action of actions as Action[]) expect(ACTIONS).toContain(action);
      }
    }
  });

  it('keeps the audit log append-only for every role', () => {
    for (const role of ROLES) {
      const granted = ROLE_GRANTS[role].auditLog ?? [];
      expect(granted, `${role} must not update audit rows`).not.toContain('update');
      expect(granted, `${role} must not delete audit rows`).not.toContain('delete');
    }
  });

  it('lets no league role create or delete a league', () => {
    for (const role of ROLES) {
      if (role === 'PLATFORM_OWNER') continue;
      const granted = ROLE_GRANTS[role].league ?? [];
      expect(granted, `${role} must not create leagues`).not.toContain('create');
      expect(granted, `${role} must not delete leagues`).not.toContain('delete');
    }
  });
});

describe('PLATFORM_OWNER', () => {
  it('may read everything, including resources added later', () => {
    const p = principal(orgRole('PLATFORM_OWNER'));
    for (const resource of RESOURCES) {
      expect(can(p, 'read', { type: resource }), `read ${resource}`).toBe(true);
    }
  });

  it('may write everything once MFA is satisfied', () => {
    const p = principal(orgRole('PLATFORM_OWNER'));
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        expect(can(p, action, { type: resource }), `${action} ${resource}`).toBe(true);
      }
    }
  });

  it('is still blocked from writing without a second factor', () => {
    // The most powerful role is not the one to make an exception for.
    const p = principal(orgRole('PLATFORM_OWNER'), { mfaSatisfied: false });
    expect(can(p, 'delete', { type: 'club' })).toBe(false);
    expect(can(p, 'read', { type: 'club' })).toBe(true);
  });
});

describe('scoping is what actually contains a club admin', () => {
  const clubAdmin = principal([{ role: 'CLUB_ADMIN', scopeKind: 'CLUB', scopeId: CLUB_A }]);

  it('may update its own club', () => {
    expect(can(clubAdmin, 'update', { type: 'club', id: CLUB_A })).toBe(true);
  });

  it('may not update another club', () => {
    expect(can(clubAdmin, 'update', { type: 'club', id: CLUB_B })).toBe(false);
  });

  it('may create a team inside its own club', () => {
    expect(can(clubAdmin, 'create', { type: 'team', clubId: CLUB_A })).toBe(true);
  });

  it('may not create a team inside another club', () => {
    expect(can(clubAdmin, 'create', { type: 'team', clubId: CLUB_B })).toBe(false);
  });

  it('fails closed on a resource with no club attribution', () => {
    // A resource that forgot to declare its owner must not become reachable by
    // every scoped role. Denying is the safe default.
    expect(can(clubAdmin, 'update', { type: 'team' })).toBe(false);
  });

  it('may not manage role grants at all', () => {
    expect(can(clubAdmin, 'create', { type: 'roleGrant', clubId: CLUB_A })).toBe(false);
  });
});

describe('team manager', () => {
  const manager = principal([{ role: 'TEAM_MANAGER', scopeKind: 'TEAM', scopeId: TEAM_A }]);

  it('manages registrations for its own team', () => {
    expect(can(manager, 'create', { type: 'registration', teamId: TEAM_A })).toBe(true);
  });

  it('may not touch another team\'s registrations', () => {
    expect(can(manager, 'create', { type: 'registration', teamId: TEAM_B })).toBe(false);
  });

  it('may not create clubs', () => {
    expect(can(manager, 'create', { type: 'club' })).toBe(false);
  });
});

describe('read-only roles stay read-only', () => {
  it.each(['DISCIPLINE_OFFICER', 'REFEREE_ASSIGNOR', 'REFEREE', 'PLAYER', 'COACH'] as const)(
    '%s may not write competition structure',
    (role) => {
      const p = principal(orgRole(role));
      expect(can(p, 'update', { type: 'competition' })).toBe(false);
      expect(can(p, 'create', { type: 'season' })).toBe(false);
      expect(can(p, 'delete', { type: 'team' })).toBe(false);
      expect(can(p, 'update', { type: 'honour' })).toBe(false);
    },
  );

  it('still lets them read the public competition data', () => {
    const p = principal(orgRole('PLAYER'));
    expect(can(p, 'read', { type: 'competition' })).toBe(true);
    expect(can(p, 'read', { type: 'club' })).toBe(true);
    expect(can(p, 'read', { type: 'honour' })).toBe(true);
  });

  it('does not let a player read another person\'s record', () => {
    const p = principal(orgRole('PLAYER'));
    expect(can(p, 'read', { type: 'person', subjectPersonId: 'someone-else' })).toBe(false);
  });
});

describe('self-service', () => {
  it('lets anyone read and correct their own record', () => {
    const p = principal(orgRole('PLAYER'));
    expect(can(p, 'read', { type: 'person', subjectPersonId: 'person-1' })).toBe(true);
    expect(can(p, 'update', { type: 'person', subjectPersonId: 'person-1' })).toBe(true);
  });

  it('never lets someone delete themselves out of the competition record', () => {
    const p = principal(orgRole('PLAYER'));
    expect(can(p, 'delete', { type: 'person', subjectPersonId: 'person-1' })).toBe(false);
  });

  it('lets a player see their own consent records', () => {
    const p = principal(orgRole('PLAYER'));
    expect(can(p, 'read', { type: 'consent', subjectPersonId: 'person-1' })).toBe(true);
    expect(can(p, 'read', { type: 'consent', subjectPersonId: 'other' })).toBe(false);
  });
});

describe('MFA gating on privileged roles', () => {
  it.each(MFA_REQUIRED_ROLES)('%s may not write without a second factor', (role) => {
    const withoutMfa = principal(orgRole(role), { mfaSatisfied: false });
    const writable = RESOURCES.find((r) => (ROLE_GRANTS[role][r] ?? []).includes('update'));
    if (!writable) return;
    expect(can(withoutMfa, 'update', { type: writable })).toBe(false);
  });

  it.each(MFA_REQUIRED_ROLES)('%s may still read without a second factor', (role) => {
    const withoutMfa = principal(orgRole(role), { mfaSatisfied: false });
    expect(can(withoutMfa, 'read', { type: 'club' })).toBe(true);
  });

  it('permits the write once MFA is satisfied', () => {
    const withMfa = principal(orgRole('LEAGUE_ADMIN'), { mfaSatisfied: true });
    expect(can(withMfa, 'update', { type: 'club' })).toBe(true);
  });

  it('does not gate roles carrying no elevated authority', () => {
    const manager = principal([{ role: 'TEAM_MANAGER', scopeKind: 'TEAM', scopeId: TEAM_A }], {
      mfaSatisfied: false,
    });
    expect(can(manager, 'update', { type: 'team', id: TEAM_A })).toBe(true);
  });

  it('can be disabled for tests that are about the matrix rather than MFA', () => {
    const withoutMfa = principal(orgRole('LEAGUE_ADMIN'), { mfaSatisfied: false });
    expect(can(withoutMfa, 'update', { type: 'club' }, { enforceMfa: false })).toBe(true);
  });
});

describe('a principal holding no roles', () => {
  it('can do nothing at all', () => {
    const nobody = principal([]);
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        expect(can(nobody, action, { type: resource }), `${action} ${resource}`).toBe(false);
      }
    }
  });
});

describe('multiple grants combine additively', () => {
  it('takes the union of two scoped grants without widening either', () => {
    const p = principal([
      { role: 'CLUB_ADMIN', scopeKind: 'CLUB', scopeId: CLUB_A },
      { role: 'TEAM_MANAGER', scopeKind: 'TEAM', scopeId: TEAM_A },
    ]);
    expect(can(p, 'update', { type: 'club', id: CLUB_A })).toBe(true);
    expect(can(p, 'update', { type: 'team', id: TEAM_A })).toBe(true);
    expect(can(p, 'update', { type: 'club', id: CLUB_B })).toBe(false);
    expect(can(p, 'update', { type: 'team', id: TEAM_B })).toBe(false);
  });

  it('models one human who plays, coaches and referees', () => {
    // Exactly the case the old system cannot express.
    const p = principal([
      { role: 'PLAYER', scopeKind: 'ORGANIZATION', scopeId: null },
      { role: 'COACH', scopeKind: 'TEAM', scopeId: TEAM_A },
      { role: 'REFEREE', scopeKind: 'ORGANIZATION', scopeId: null },
    ]);
    expect(can(p, 'read', { type: 'competition' })).toBe(true);
    expect(can(p, 'read', { type: 'registration', teamId: TEAM_A })).toBe(true);
    expect(can(p, 'update', { type: 'club', id: CLUB_A })).toBe(false);
  });
});
