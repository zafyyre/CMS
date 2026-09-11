const APPLICATION_ORIGIN = 'https://league.invalid';
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;

/**
 * Restrict a post-authentication destination to this application's origin.
 *
 * `router.push()` and Next's `redirect()` both accept absolute URLs. Parsing
 * against a fixed origin, rather than only checking a leading slash, closes
 * protocol-relative and backslash-normalized external destinations.
 */
export function safeNext(next: string | undefined, fallback = '/admin'): string {
  if (!next || !next.startsWith('/') || CONTROL_OR_BACKSLASH.test(next)) return fallback;

  const destination = new URL(next, APPLICATION_ORIGIN);
  if (destination.origin !== APPLICATION_ORIGIN) return fallback;

  return `${destination.pathname}${destination.search}${destination.hash}`;
}
