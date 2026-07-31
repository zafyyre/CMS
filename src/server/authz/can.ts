import { type Action, grants, type Resource } from './permissions';
import { type Principal, requiresMfa, type ScopedRole } from './roles';

/**
 * The single authorization decision point.
 *
 * Pure: no database, no session, no I/O. Everything it needs is passed in, so
 * the whole matrix can be exercised in milliseconds and reasoned about without
 * running anything.
 *
 * It answers "is this principal ALLOWED to do this?" — it does NOT answer "can
 * they reach this row?". That second question is answered independently by
 * row-level security in PostgreSQL. Both must pass. RLS is the backstop for
 * when a service forgets to call this; this is the backstop for when a query is
 * correctly scoped to the league but the caller still had no business making it.
 */

export interface ResourceRef {
  type: Resource;
  /** The resource's own id, where it has one. */
  id?: string | null;
  /** Which club it belongs to, for CLUB-scoped grants. */
  clubId?: string | null;
  /** Which team it belongs to, for TEAM-scoped grants. */
  teamId?: string | null;
  /** The person this record is about, enabling self-service on one's own data. */
  subjectPersonId?: string | null;
}

export interface CanOptions {
  /**
   * Enforce that privileged roles have satisfied a second factor before their
   * elevated grant applies to a mutating action. On by default; disable only in
   * tests that are specifically about the matrix rather than about MFA.
   */
  enforceMfa?: boolean;
}

export function can(
  principal: Principal,
  action: Action,
  resource: ResourceRef,
  options: CanOptions = {},
): boolean {
  const enforceMfa = options.enforceMfa ?? true;

  // Platform operator. Short-circuited so that adding a resource never requires
  // remembering to extend a grant list somewhere.
  if (principal.roles.some((r) => r.role === 'PLATFORM_OWNER')) {
    // Still gated on MFA for writes — the most powerful role is not the one to
    // make an exception for.
    if (enforceMfa && action !== 'read' && !principal.mfaSatisfied) return false;
    return true;
  }

  // Self-service: a person may always read their own record, and correct it.
  // Deletion is never self-service — someone with match history cannot remove
  // themselves from the competition record.
  if (
    resource.subjectPersonId &&
    resource.subjectPersonId === principal.personId &&
    (action === 'read' || action === 'update')
  ) {
    return true;
  }

  for (const grant of principal.roles) {
    if (!grants(grant.role, action, resource.type)) continue;
    if (!scopeCovers(grant, resource)) continue;

    // An elevated role's authority is withheld until MFA is satisfied — but
    // only for writes, so an admin without a second factor is degraded rather
    // than locked out, and can still enrol.
    if (enforceMfa && action !== 'read' && requiresMfa(grant.role) && !principal.mfaSatisfied) {
      continue;
    }

    return true;
  }

  return false;
}

/**
 * Does this grant's scope reach this resource?
 *
 * ORGANIZATION-scoped roles reach everything in the league. CLUB- and
 * TEAM-scoped roles reach only their own subtree — and, importantly, a resource
 * carrying no club or team attribution at all is NOT reachable by a scoped
 * role. Failing closed here is what stops a club admin editing league-wide
 * settings that simply forgot to declare an owner.
 */
function scopeCovers(grant: ScopedRole, resource: ResourceRef): boolean {
  switch (grant.scopeKind) {
    case 'ORGANIZATION':
      return true;

    case 'CLUB': {
      if (!grant.scopeId) return false;
      if (resource.type === 'club') return resource.id === grant.scopeId;
      return resource.clubId === grant.scopeId;
    }

    case 'TEAM': {
      if (!grant.scopeId) return false;
      if (resource.type === 'team') return resource.id === grant.scopeId;
      return resource.teamId === grant.scopeId;
    }
  }
}

export class ForbiddenError extends Error {
  constructor(action: Action, resource: Resource) {
    super(`Not permitted to ${action} ${resource}`);
    this.name = 'ForbiddenError';
  }
}

/** Throwing variant, for service-layer guards. */
export function assertCan(
  principal: Principal,
  action: Action,
  resource: ResourceRef,
  options: CanOptions = {},
): void {
  if (!can(principal, action, resource, options)) {
    throw new ForbiddenError(action, resource.type);
  }
}
