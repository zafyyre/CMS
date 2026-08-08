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

  /**
   * Emit `.next/standalone` — a self-contained server plus only the traced
   * `node_modules`, so the deployment image does not need `npm ci` at all.
   *
   * Chosen over `next start` in a container because it keeps the runtime image
   * small and, more importantly, keeps the host generic: the artefact is a
   * plain Node process listening on `$PORT`, which every container platform can
   * run. Nothing here ties the project to one vendor, which is the property
   * Phase 14's hosting decision needs to stay reversible.
   *
   * `server.js` does NOT serve `public/` or `.next/static` on its own; the
   * Dockerfile copies both in beside it.
   */
  output: 'standalone',

  /**
   * Packages the bundler must leave alone.
   *
   * `pg` relies on Node built-ins and dynamic requires that cannot be resolved
   * statically. `pino` and `pino-pretty` are worse: pino loads its transport in
   * a worker thread by resolving a module path at RUNTIME, so bundling it
   * produces a build that fails while prerendering with a bare
   * "Cannot read properties of null (reading 'useContext')" — an error naming
   * neither the package nor the cause, which is why this line has a comment
   * rather than just three strings.
   */
  serverExternalPackages: ['pg', 'pino', 'pino-pretty'],

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
