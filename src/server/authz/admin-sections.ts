import { can } from './can';
import type { Principal } from './roles';

/**
 * Which admin sections a person's ROLES cover — deliberately ignoring MFA.
 *
 * Shared by the admin layout (which links only to these) and the site header
 * (which sends anyone who holds one of them to the admin area). Kept in one
 * place so the two cannot disagree about who gets in.
 *
 * `enforceMfa: false` is the important part. An administrator who has not yet
 * enrolled a second factor genuinely cannot write anything: the matrix
 * withholds every mutation, and the services enforce that. But hiding the
 * screens from them as well produced a page that said "every button below will
 * refuse" above no buttons at all, and gave them nowhere to see what they were
 * locked out of or why.
 *
 * So navigation asks "would this role ever be allowed here?" and the admin
 * banner explains the rest. Nothing is loosened: every write still passes
 * through `assertCan` with MFA enforced. This is navigation, not authorisation.
 */
export function adminSections(principal: Principal) {
  const readOnly = { enforceMfa: false };
  const fixtures = can(principal, 'update', { type: 'fixture' }, readOnly);
  const venues = can(principal, 'update', { type: 'venue' }, readOnly);
  const imports = can(principal, 'create', { type: 'club' }, readOnly);
  return { fixtures, venues, imports, any: fixtures || venues || imports };
}
