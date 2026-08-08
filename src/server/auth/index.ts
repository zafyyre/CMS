import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor, username } from 'better-auth/plugins';
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

  /**
   * No social providers, deliberately and permanently.
   *
   * Sign-in is an email address or a username, with a password. Federated
   * sign-in was considered and removed: it hands a third party a dependency on
   * every official's ability to administer the league, it does not remove the
   * need for a password path (most of six thousand players will not have or
   * want a Google account), and it is not a second factor — which is the thing
   * that actually protects the admin-tier roles here.
   */

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
    /**
     * Sign in with a username as well as an email address.
     *
     * Not a convenience. A large part of this membership is players and
     * coaches who share a household email address, or who gave the league a
     * work address they no longer have — and an email-only login makes those
     * people permanently unreachable by their own account. A username they
     * chose is stable in a way their email is not.
     *
     * Usernames are normalised to lower case for lookup, so `RRovers` and
     * `rrovers` are the same account and cannot both be registered. The
     * original spelling is kept in `displayUsername` and is what the interface
     * shows back to them.
     */
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      /**
       * Letters, digits, underscore, hyphen and full stop.
       *
       * Deliberately narrow. A username is displayed next to a person's name
       * on public pages, and permitting arbitrary Unicode invites homoglyph
       * impersonation — a Cyrillic `а` in a club official's name is
       * indistinguishable at a glance from the Latin one.
       */
      usernameValidator: (value) => /^[a-zA-Z0-9._-]+$/.test(value),
    }),
    // TOTP second factor. Required for admin-tier roles before any write —
    // enforced in src/server/authz/can.ts, not merely encouraged in the UI.
    twoFactor({ issuer: 'League CMS' }),
    // Must remain last: it wraps the handlers to set cookies in Next.js.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
