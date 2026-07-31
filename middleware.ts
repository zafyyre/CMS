import { type NextRequest, NextResponse } from 'next/server';

/**
 * Edge middleware. Deliberately tiny.
 *
 * It cannot resolve the league itself: middleware runs on the Edge runtime,
 * which has no TCP sockets and therefore no PostgreSQL. So it does the part
 * needing no I/O — normalising the hostname and stamping a request id — and
 * leaves the database lookup to `getCurrentLeague()`, which runs in Node where
 * a connection exists.
 */

const REQUEST_ID_HEADER = 'x-request-id';
export const LEAGUE_HOST_HEADER = 'x-league-host';

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
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
