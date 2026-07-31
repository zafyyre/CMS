import type { NextConfig } from 'next';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Content Security Policy — the main defence against XSS, and the header most
 * often missing. Next's runtime needs 'unsafe-inline' for bootstrap styles, and
 * dev mode additionally needs 'unsafe-eval' for fast refresh, so production
 * gets the stricter policy.
 *
 * When venue maps arrive (Phase 3), extend this deliberately rather than
 * loosening it wholesale.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProduction ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  ...(isProduction ? ['upgrade-insecure-requests'] : []),
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // `pg` relies on Node built-ins and dynamic requires the bundler cannot
  // statically resolve, so it must not be bundled.
  serverExternalPackages: ['pg'],

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // Only meaningful over HTTPS, and production-only so localhost is not
          // pinned to HTTPS in your browser for a year.
          ...(isProduction
            ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
            : []),
        ],
      },
      {
        // A probe is for load balancers, not for caches or crawlers.
        source: '/api/healthz',
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Robots-Tag', value: 'noindex' },
        ],
      },
    ];
  },
};

export default nextConfig;
