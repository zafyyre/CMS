/**
 * Service worker — offline support for the pages that are read at a pitch.
 *
 * Hand-written rather than generated. The whole thing is under a hundred lines
 * of genuinely load-bearing logic, and a service worker is the one script that
 * can permanently break a site for a returning visitor: it persists after
 * deployment, so a bug here outlives the release that introduced it. That is
 * not a place to take on a build-time dependency whose output nobody reads.
 *
 * The strategy, and why:
 *
 *   NETWORK FIRST for pages. Standings and schedules go stale in minutes on a
 *   match day, and a cached table showing yesterday's result is worse than a
 *   spinner. The cache is the fallback for when there is no signal — which at
 *   a suburban pitch in November is often.
 *
 *   CACHE FIRST for static assets. They are content-hashed, so a stale one
 *   cannot exist.
 *
 *   NEVER CACHE anything under /api/. Calendar feeds and health checks have
 *   their own cache headers, and an authenticated response cached here would
 *   be served to whoever opened the app next on a shared phone.
 */

// Incremented with the public-page cache allowlist below so activating this
// worker removes any authenticated pages stored by older clients.
const VERSION = 'v2';
const PAGE_CACHE = `pages-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const OFFLINE_URL = '/offline';

// Cache Storage keys navigations by URL, not by the caller's session cookie.
// Only the public routes are therefore eligible for offline HTML caching. Any
// account, admin, or future authenticated route is network-only by default.
const PUBLIC_PAGE_PREFIXES = [
  '/',
  '/clubs',
  '/cups',
  '/documents',
  '/fields',
  '/history',
  '/news',
  '/offline',
  '/schedule',
  '/standings',
  '/teams',
];

const isPublicPage = (pathname) =>
  PUBLIC_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`)),
  );

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PAGE_CACHE).then((cache) => cache.addAll([OFFLINE_URL])),
  );
  // Take over as soon as installed rather than waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions, or a deploy leaves the old bundle
      // on disk forever and the site never updates for returning visitors.
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== PAGE_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET. A POST replayed from a cache would submit a result twice.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Same-origin only. Caching a third party's response is not ours to do.
  if (url.origin !== self.location.origin) return;

  // API routes manage their own freshness, and some of them are per-user.
  if (url.pathname.startsWith('/api/')) return;

  // See isPublicPage: never place authenticated HTML in the shared cache.
  if (!isPublicPage(url.pathname)) return;

  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || /\.(css|js|woff2?|svg|png|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

/**
 * Fresh if we can, cached if we cannot, and an explicit offline page if
 * neither — rather than the browser's error page, which gives a player
 * standing in a field no indication that the app has anything for them.
 */
async function networkFirst(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    const offline = await cache.match(OFFLINE_URL);
    return (
      offline ??
      new Response('You are offline and this page has not been saved.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    );
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}
