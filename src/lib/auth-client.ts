'use client';

import { createAuthClient } from 'better-auth/react';
import { twoFactorClient, usernameClient } from 'better-auth/client/plugins';

/**
 * The browser half of authentication.
 *
 * No `baseURL`: the client talks to `/api/auth` on whatever origin it was
 * served from. That is not laziness — this is a multi-tenant product where each
 * league has its own domain, and a configured absolute URL would send one
 * league's sign-in request to another league's host, arriving with the wrong
 * cookie domain and failing in a way that looks like a password problem.
 *
 * The session cookie is `httpOnly`, so nothing here can read it. Everything on
 * this side goes through the API; the server decides who you are.
 */
export const authClient = createAuthClient({
  plugins: [
    // Lets `signIn.username({ username, password })` reach the server route the
    // matching server-side plugin registers.
    usernameClient(),
    /**
     * Deliberately configured WITHOUT `onTwoFactorRedirect`.
     *
     * That hook fires outside React, so the only navigation available to it is
     * `window.location.href` — a full page reload that discards the router's
     * state, and which Next now flags as a lint error for internal routes.
     *
     * Instead, `signIn.email()` and `signIn.username()` resolve with
     * `data.twoFactorRedirect === true` when a factor is outstanding, and the
     * sign-in form navigates with the router. Same behaviour, in the place that
     * owns navigation.
     *
     * The property this preserves either way: better-auth withholds the session
     * until the factor is verified, so `session.user.twoFactorEnabled` on the
     * server implies it was satisfied — which is exactly what `getPrincipal()`
     * relies on when it sets `mfaSatisfied`.
     */
    twoFactorClient(),
  ],
});

export const { signIn, signOut, signUp, useSession, twoFactor } = authClient;
