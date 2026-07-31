import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { normalizeHost, resolveLeagueByHostname } from '@/server/tenancy/current-league';
import { closeFixtures, createLeagueFixture, truncateAll } from '../helpers/fixtures';

/**
 * Hostname → league resolution.
 *
 * Each league gets its own website, so this lookup is how a request finds the
 * league it belongs to. It is also the one piece of tenancy that runs BEFORE
 * any league context exists, which makes it easy to get subtly wrong.
 *
 * The port case below is a REGRESSION TEST. The resolver originally trusted the
 * raw `Host` header, which carries the port (`localhost:3000`). That matched
 * neither the local-host list nor any registered domain, so every request to
 * the dev server resolved to no league and the site rendered "No league
 * configured". It only appeared to work in the production build, because there
 * the middleware-normalised header happened to reach the resolver first.
 */

const DEFAULT_SLUG = process.env.DEFAULT_ORG_SLUG ?? 'demo';

beforeEach(async () => {
  await truncateAll();
  await createLeagueFixture('alpha');
  await createLeagueFixture(DEFAULT_SLUG);
});

afterAll(async () => {
  await closeFixtures();
});

describe('normalizeHost', () => {
  it.each([
    ['localhost:3000', 'localhost'],
    ['alpha.test.invalid:8443', 'alpha.test.invalid'],
    ['ALPHA.TEST.INVALID', 'alpha.test.invalid'],
    ['alpha.test.invalid.', 'alpha.test.invalid'],
    ['  alpha.test.invalid  ', 'alpha.test.invalid'],
    ['', ''],
    [null, ''],
    [undefined, ''],
  ])('normalises %s', (input, expected) => {
    expect(normalizeHost(input)).toBe(expected);
  });
});

describe('resolving a registered domain', () => {
  it('finds the league by its exact hostname', async () => {
    const league = await resolveLeagueByHostname('alpha.test.invalid');
    expect(league?.slug).toBe('alpha');
  });

  it('finds it when the header carries a port', async () => {
    // The regression. A raw Host header looks like this.
    const league = await resolveLeagueByHostname('alpha.test.invalid:3000');
    expect(league?.slug).toBe('alpha');
  });

  it('is case-insensitive', async () => {
    const league = await resolveLeagueByHostname('ALPHA.TEST.INVALID');
    expect(league?.slug).toBe('alpha');
  });

  it('returns nothing for an unregistered hostname', async () => {
    expect(await resolveLeagueByHostname('nobody.invalid')).toBeNull();
  });
});

describe('local development falls back to the default league', () => {
  it.each(['localhost', 'localhost:3000', '127.0.0.1', '127.0.0.1:3000', ''])(
    'resolves %s to the default league',
    async (host) => {
      const league = await resolveLeagueByHostname(host);
      expect(league?.slug).toBe(DEFAULT_SLUG);
    },
  );

  it('treats a *.localhost subdomain as local too', async () => {
    const league = await resolveLeagueByHostname('anything.localhost:3000');
    expect(league?.slug).toBe(DEFAULT_SLUG);
  });
});

describe('the resolved league is usable as a tenant key', () => {
  it('returns a branded, valid league id', async () => {
    const league = await resolveLeagueByHostname('alpha.test.invalid');
    expect(league?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
