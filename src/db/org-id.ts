/**
 * A verified league id.
 *
 * Row-level security defends against *forgetting to filter*. It cannot defend
 * against *filtering to the wrong league* — `withOrg(attackerSuppliedId)` will
 * faithfully scope the query to whichever league that id names. Without this
 * type, the safety of the whole system would rest on every future caller
 * remembering to pass the league resolved from the request, which is exactly
 * the discipline this architecture exists to remove.
 *
 * So `OrgId` is a branded type. It cannot be built from a bare string: it comes
 * either from resolving the request's hostname or from an authenticated
 * principal. A route handler that reads an id out of a URL and hands it to a
 * service now fails to compile.
 */

declare const brand: unique symbol;

export type OrgId = string & { readonly [brand]: 'OrgId' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only way to mint an `OrgId`, and deliberately awkward to call.
 *
 * Legitimate callers are the hostname resolver, the principal builder, and test
 * fixtures. Reaching for this anywhere else means the value you hold is almost
 * certainly untrusted input.
 */
export function unsafeAsOrgId(value: string, provenance: string): OrgId {
  if (!UUID_RE.test(value)) {
    throw new Error(`Not a valid organization id (from ${provenance}): ${JSON.stringify(value)}`);
  }
  return value as OrgId;
}

export function isOrgId(value: string): value is OrgId {
  return UUID_RE.test(value);
}
