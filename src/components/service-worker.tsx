'use client';

import { useEffect } from 'react';

/**
 * Registers the service worker, and only in production.
 *
 * In development a service worker caches the dev server's output and then
 * serves it after the code has changed, which presents as "my edit did
 * nothing" and costs an hour before anybody suspects the cache.
 *
 * Registration is deferred until after `load` so it never competes with the
 * first render for bandwidth — the standings page has a sub-second LCP budget
 * on simulated 4G, and a service worker fetching in parallel is measurable
 * against it.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // A failed registration must never break the page. The site works
        // perfectly well without offline support; it just works less well on a
        // touchline with no signal.
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register);
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
