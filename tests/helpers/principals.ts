import type { Principal, Role, ScopedRole } from '../../src/server/authz/roles';
import type { LeagueFixture } from './fixtures';

/**
 * Principals for integration tests.
 *
 * Built directly rather than through `getPrincipal()`, which needs a live
 * better-auth session and a request context. What these tests are about is
 * whether the SERVICES consult the matrix correctly, not whether the session
 * layer assembles a principal correctly — that has its own test in
 * role-grants.test.ts, against real `role_grants` rows.
 *
 * `personId` is a genuine person in the league, because the evidence tables
 * carry a composite foreign key to `persons` and a fabricated id would be
 * rejected by the database rather than by the code under test.
 */
export function principalFor(
  league: LeagueFixture,
  roles: readonly ScopedRole[],
  overrides: Partial<Principal> = {},
): Principal {
  return {
    userId: `user-${league.slug}`,
    personId: league.personId,
    orgId: league.orgId,
    roles,
    mfaSatisfied: true,
    ...overrides,
  };
}

export const orgScoped = (role: Role): ScopedRole[] => [
  { role, scopeKind: 'ORGANIZATION', scopeId: null },
];

export const teamScoped = (role: Role, teamId: string): ScopedRole[] => [
  { role, scopeKind: 'TEAM', scopeId: teamId },
];

export const clubScoped = (role: Role, clubId: string): ScopedRole[] => [
  { role, scopeKind: 'CLUB', scopeId: clubId },
];

/** The league office: everything, second factor satisfied. */
export const leagueAdmin = (league: LeagueFixture): Principal =>
  principalFor(league, orgScoped('LEAGUE_ADMIN'));
