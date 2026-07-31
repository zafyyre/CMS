import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';
import { identityDb } from '@/db';
import { accounts, sessions, twoFactors, users, verifications } from '@/db/schema';
import { env } from '@/env';

/**
 * Identity, and only identity.
 *
 * better-auth owns authentication — who you are, proving it, and session
 * lifecycle. It deliberately does NOT own authorization or tenancy: roles live
 * in `role_grants`, permissions in `src/server/authz`, and league isolation in
 * PostgreSQL row-level security. That separation is why swapping this library
 * out would touch this directory and nothing else.
 *
 * better-auth's own `organization` plugin is intentionally unused: it would
 * introduce a second, competing model of leagues and members alongside the
 * RLS-protected tables that are the actual tenant boundary.
 */
export const auth = betterAuth({
  appName: 'League CMS',
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(identityDb, {
    provider: 'pg',
    // Table names here are plural (users, sessions, …) rather than
    // better-auth's singular default.
    usePlural: true,
    schema: { users, sessions, accounts, verifications, twoFactors },
  }),

  emailAndPassword: {
    enabled: true,
    // NIST SP 800-63B favours length over composition rules: a 12-character
    // floor, and no forced symbol soup that drives people to Password1!
    minPasswordLength: 12,
    maxPasswordLength: 256,
    // Turned on in Phase 7, once transactional email exists to send from.
    requireEmailVerification: false,
  },

  session: {
    // Database-backed, so a compromised session can be revoked immediately —
    // which a stateless signed token cannot offer.
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },

  advanced: {
    // Pinned rather than left to defaults, because these are the difference
    // between a session cookie an attacker can steal and one they cannot.
    //   httpOnly — unreachable from JavaScript, so XSS cannot exfiltrate it
    //   sameSite — 'lax' blocks cross-site POST while normal links still work
    //   secure   — HTTPS only in production; off locally so http works
    useSecureCookies: env.NODE_ENV === 'production',
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
    },
  },

  plugins: [
    // TOTP second factor. Required for admin-tier roles before any write —
    // enforced in src/server/authz/can.ts, not merely encouraged in the UI.
    twoFactor({ issuer: 'League CMS' }),
    // Must remain last: it wraps the handlers to set cookies in Next.js.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
