import { createCookieGetter } from 'better-auth/cookies';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { auth } from '@/server/auth';
import { middleware, PERSONALIZED_HEADER, SESSION_COOKIE_NAMES } from '../../middleware';

const request = (cookie?: string) =>
  new NextRequest('http://league.test/standings', { headers: cookie ? { cookie } : {} });

describe('middleware: marking responses to signed-in visitors', () => {
  it('knows the session cookie by every name this app’s auth can give it', () => {
    // Derived from the live auth configuration, over HTTP and over HTTPS, so
    // a changed cookie prefix or name fails here rather than silently letting
    // signed-in pages into the offline cache.
    for (const useSecureCookies of [false, true]) {
      const cookie = createCookieGetter({
        ...auth.options,
        advanced: { ...auth.options.advanced, useSecureCookies },
      });
      expect(SESSION_COOKIE_NAMES).toContain(cookie('session_token').name);
    }
  });

  it('marks a response to a visitor holding a session cookie', () => {
    for (const name of SESSION_COOKIE_NAMES) {
      expect(middleware(request(`${name}=token`)).headers.get(PERSONALIZED_HEADER)).toBe('1');
    }
  });

  it('leaves a response to an anonymous visitor unmarked', () => {
    expect(middleware(request()).headers.has(PERSONALIZED_HEADER)).toBe(false);
    expect(middleware(request('unrelated=1')).headers.has(PERSONALIZED_HEADER)).toBe(false);
  });
});
