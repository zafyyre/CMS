import type { OrgId } from '@/db/org-id';

/**
 * Roles, scopes and the shape of a principal.
 *
 * Deliberately free of database imports, so the permission matrix can be
 * unit-tested as a pure function with no fixtures and no container running.
 */

export const ROLES = [
  'PLATFORM_OWNER',
  'LEAGUE_ADMIN',
  'REGISTRAR',
  'DISCIPLINE_OFFICER',
  'REFEREE_ASSIGNOR',
  'CLUB_ADMIN',
  'TEAM_MANAGER',
  'COACH',
  'REFEREE',
  'PLAYER',
] as const;

export type Role = (typeof ROLES)[number];

export const SCOPE_KINDS = ['ORGANIZATION', 'CLUB', 'TEAM'] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/**
 * The only role that crosses league boundaries. It exists to operate the
 * platform, not to run a league, and is deliberately not grantable from any
 * league-facing screen.
 */
export const PLATFORM_ROLES: readonly Role[] = ['PLATFORM_OWNER'];

/**
 * Roles that must have a second factor enrolled before they may write.
 *
 * These can move money, overturn suspensions, or alter the registration record
 * of thousands of people. A stolen password should not be enough.
 */
export const MFA_REQUIRED_ROLES: readonly Role[] = [
  'PLATFORM_OWNER',
  'LEAGUE_ADMIN',
  'REGISTRAR',
  'DISCIPLINE_OFFICER',
];

export interface ScopedRole {
  role: Role;
  scopeKind: ScopeKind;
  /** Null when scopeKind is ORGANIZATION. Otherwise the club or team id. */
  scopeId: string | null;
}

/**
 * Who is asking.
 *
 * Built once per request from the session plus the caller's role grants *in
 * the current league* — grants in other leagues are never loaded, so they
 * cannot accidentally confer anything here. That is enforced by the database,
 * not by remembering to filter: the query runs inside `withOrg`.
 */
export interface Principal {
  userId: string;
  /** The person record behind the login, in this league. */
  personId: string;
  /** Branded: comes from the resolved request league, never from user input. */
  orgId: OrgId;
  roles: readonly ScopedRole[];
  /** Whether this session has satisfied a second factor. */
  mfaSatisfied: boolean;
}

export const isPlatformRole = (role: Role): boolean => PLATFORM_ROLES.includes(role);

export const requiresMfa = (role: Role): boolean => MFA_REQUIRED_ROLES.includes(role);

/** True if any role this principal holds demands a second factor. */
export const principalRequiresMfa = (principal: Principal): boolean =>
  principal.roles.some((r) => requiresMfa(r.role));
