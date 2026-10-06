import { type NextRequest, NextResponse } from 'next/server';

/**
 * Edge middleware. Deliberately tiny.
 *
 * It cannot resolve the league itself: middleware runs on the Edge runtime,
 * which has no TCP sockets and therefore no PostgreSQL. So it does the part
 * needing no I/O — normalising the hostname, stamping a request id, and
 * marking responses to signed-in visitors — and
 * leaves the database lookup to `getCurrentLeague()`, which runs in Node where
 * a connection exists.
 */

const REQUEST_ID_HEADER = 'x-request-id';
export const LEAGUE_HOST_HEADER = 'x-league-host';

/**
 * Set on every response to a visitor who holds a session cookie. The site
 * header on every page shows whether its visitor is signed in, so such a page
 * is theirs alone — and the service worker's offline cache is keyed by address,
 * not by visitor, so it must never store one: the next person to open the app
 * on a shared phone, offline, would be shown it. `public/sw.js` reads this.
 */
export const PERSONALIZED_HEADER = 'x-personalized';

/**
 * better-auth's session cookie, under both of its names: `__Secure-` prefixed
 * when served over HTTPS in production, bare in development. Presence is all
 * that is checked — an expired cookie only costs that visitor an offline copy.
 * Checked by name rather than through better-auth's own helper, which would
 * pull its JWT and database code into this bundle; a unit test holds the two
 * to agreement.
 */
export const SESSION_COOKIE_NAMES = ['better-auth.session_token', '__Secure-better-auth.session_token'];

function normalizeHost(raw: string | null): string {
  if (!raw) return '';
  return raw.split(':')[0]?.toLowerCase().replace(/\.$/, '') ?? '';
}

export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);

  // Only the Host header is trusted. X-Forwarded-Host is attacker-controllable
  // unless a known proxy rewrites it, and treating it as authoritative here
  // would let a crafted header select a different league.
  //
  // This `set` also OVERWRITES any x-league-host a client tried to send.
  headers.set(LEAGUE_HOST_HEADER, normalizeHost(request.headers.get('host')));

  const requestId = request.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID();
  headers.set(REQUEST_ID_HEADER, requestId);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  if (SESSION_COOKIE_NAMES.some((name) => request.cookies.has(name))) {
    response.headers.set(PERSONALIZED_HEADER, '1');
  }
  return response;
}

export const config = {
  /**
   * Excludes only Next's own static output.
   *
   * The previous matcher also excluded any path ending in an image extension —
   * `.*\.(?:svg|png|jpg|...)$` — which applies to the WHOLE pathname, not just
   * files under /_next or /public. That silently exempted application routes:
   * `/clubs/rutland-rovers.png` matched the exclusion and skipped middleware,
   * so nothing stamped a request id and nothing normalised the host.
   */
  matcher: ['/((?!_next/static|_next/image).*)'],
};
