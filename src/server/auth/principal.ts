import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { headers } from 'next/headers';
import { cache } from 'react';
import { type Tx, withOrg } from '@/db';
import { persons, roleGrants } from '@/db/schema';
import type { Principal, Role, ScopedRole, ScopeKind } from '@/server/authz/roles';
import { getCurrentLeague } from '@/server/tenancy/current-league';
import { auth } from './index';

/**
 * Turns an authenticated session plus the current hostname into a `Principal`
 * — the input to every authorization decision.
 *
 * Two properties matter here.
 *
 * First, role grants are loaded through `withOrg()`, so the DATABASE guarantees
 * only this league's grants come back. A person who is a LEAGUE_ADMIN of one
 * league and a PLAYER in another arrives at the second league holding only
 * PLAYER — and there is no application code that could get this wrong, because
 * the other rows are not returned at all.
 *
 * Second, grants are filtered by their VALIDITY WINDOW. A club secretary whose
 * term ended in June stops being one automatically, with nobody remembering to
 * delete a row — and the record of them having held it survives, which matters
 * when someone asks who approved a transfer last season.
 */
export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  const league = await getCurrentLeague();
  if (!league) return null;

  return withOrg(league.id, async (tx) => {
    // The login is global; the person is per-league. A user with no person
    // record in this league is authenticated but holds nothing here.
    const [person] = await tx
      .select({ id: persons.id })
      .from(persons)
      .where(and(eq(persons.userId, session.user.id), isNull(persons.deletedAt)))
      .limit(1);

    if (!person) return null;

    const roles = await loadActiveGrants(tx, person.id);

    return {
      userId: session.user.id,
      personId: person.id,
      orgId: league.id,
      roles,
      /**
       * A session only exists once any enrolled second factor has been
       * satisfied — better-auth withholds it until then. So an enrolled user
       * holding a session has passed MFA, and an unenrolled one has not.
       * Admin-tier roles therefore cannot write until they enrol, which is the
       * intent rather than a side effect.
       */
      mfaSatisfied: session.user.twoFactorEnabled === true,
    };
  });
});

/**
 * The grants a person currently holds, in whichever league the surrounding
 * transaction is scoped to.
 *
 * Exported separately from `getPrincipal` so the validity-window behaviour can
 * be tested without standing up a session — the expiry rule is a headline
 * claim of this design and deserves a real test rather than an assurance.
 *
 * Must be called inside `withOrg`; RLS supplies the league filter.
 */
export async function loadActiveGrants(tx: Tx, personId: string): Promise<ScopedRole[]> {
  const now = sql`now()`;

  const rows = await tx
    .select({
      role: roleGrants.role,
      scopeKind: roleGrants.scopeKind,
      scopeId: roleGrants.scopeId,
    })
    .from(roleGrants)
    .where(
      and(
        eq(roleGrants.personId, personId),
        eq(roleGrants.status, 'ACTIVE'),
        isNull(roleGrants.deletedAt),
        lte(roleGrants.validFrom, now),
        // Open-ended, or not yet expired.
        or(isNull(roleGrants.validUntil), gt(roleGrants.validUntil, now)),
      ),
    );

  return rows.map((r) => ({
    role: r.role as Role,
    scopeKind: r.scopeKind as ScopeKind,
    scopeId: r.scopeId,
  }));
}

export class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'UnauthenticatedError';
  }
}

/** Variant for code paths where an anonymous caller is an error. */
export async function requirePrincipal(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!principal) throw new UnauthenticatedError();
  return principal;
}
