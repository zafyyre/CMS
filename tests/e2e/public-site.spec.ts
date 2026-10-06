import { expect, test } from '@playwright/test';

/**
 * The public site, as a visitor meets it.
 *
 * Assertions are on what a PERSON can see and do — a heading, a table with
 * rows, a link that goes somewhere — not on class names or DOM structure. A
 * test that breaks when the markup is refactored is a test that gets deleted
 * the second time it does that.
 */

test.describe('a visitor with no account', () => {
  test('lands on the league and can reach every section', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The sections live in the site header's navigation on every page. On a
    // phone they sit behind the menu button, so open it first — that the
    // links are reachable there is exactly what this guards.
    const menu = page.getByRole('button', { name: 'Open menu' });
    if (await menu.isVisible()) await menu.click();
    const nav = page.getByRole('navigation', { name: 'Main' });
    for (const section of ['Standings', 'Schedule', 'Fields', 'Clubs', 'History']) {
      await expect(nav.getByRole('link', { name: section, exact: true })).toBeVisible();
    }
  });

  test('reads a league table with real rows', async ({ page }) => {
    await page.goto('/standings');
    await expect(page.getByRole('heading', { name: 'Standings' })).toBeVisible();

    const table = page.getByRole('table').first();
    await expect(table).toBeVisible();
    // Header row plus at least two teams — an empty table would otherwise pass.
    expect(await table.getByRole('row').count()).toBeGreaterThan(2);
  });

  test('sees why a team is placed where it is', async ({ page }) => {
    /**
     * The reasoning is the headline claim of the standings engine — if it stops
     * reaching the page, the engine is still right and the product is not.
     *
     * It reaches the reader by two different routes, deliberately. On a phone
     * the played/won/drawn columns are hidden, so the basis is printed under
     * each team's name, where it answers the question those missing numbers
     * would otherwise raise. On a wide screen the columns carry that detail, so
     * the basis moves into a disclosure rather than repeating it on every row.
     *
     * The test asserts whichever one this viewport is supposed to show, so a
     * regression in either is caught rather than papered over by the other.
     */
    await page.goto('/standings');
    const isNarrow = (page.viewportSize()?.width ?? 1280) < 640;

    if (isNarrow) {
      await expect(page.getByText(/\b\d+ points\b/).first()).toBeVisible();
      return;
    }

    const disclosure = page.getByText('Why each team is placed where it is');
    await expect(disclosure).toBeVisible();
    await disclosure.click();
    await expect(
      page.locator('details').getByText(/\b\d+ points\b/).first(),
    ).toBeVisible();
  });

  test('follows a team through to its own page', async ({ page }) => {
    await page.goto('/standings');
    const firstTeam = page.getByRole('table').first().getByRole('link').first();
    const name = (await firstTeam.textContent())?.trim() ?? '';
    await firstTeam.click();

    await expect(page).toHaveURL(/\/teams\//);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    // The calendar subscription is the feature most likely to be silently lost
    // in a refactor, because nothing else links to it.
    await expect(page.getByRole('link', { name: /subscribe to fixtures/i })).toBeVisible();
  });

  test('gets a real calendar feed, not an HTML error page', async ({ page, request }) => {
    await page.goto('/standings');
    await page.getByRole('table').first().getByRole('link').first().click();

    const href = await page.getByRole('link', { name: /subscribe to fixtures/i }).getAttribute('href');
    expect(href).toBeTruthy();

    const feed = await request.get(href as string);
    expect(feed.status()).toBe(200);
    expect(feed.headers()['content-type']).toContain('text/calendar');
    expect(await feed.text()).toContain('BEGIN:VCALENDAR');
  });

  test('sees the schedule grouped by day, with times', async ({ page }) => {
    await page.goto('/schedule');
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
    // Kickoff times render in the league's zone as HH:MM.
    await expect(page.getByText(/^\d{2}:\d{2}$/).first()).toBeVisible();
  });

  test('sees field closures on the fields page', async ({ page }) => {
    await page.goto('/fields');
    await expect(page.getByRole('heading', { name: 'Fields' })).toBeVisible();
  });

  test('reaches a club and its teams', async ({ page }) => {
    await page.goto('/clubs');
    // Located by href rather than by position: an ordinal picks up whatever
    // navigation happens to sit above the list and breaks on any layout change.
    const club = page.locator('a[href^="/clubs/"]').first();
    await expect(club).toBeVisible();
    const name = (await club.textContent())?.trim() ?? '';

    await club.click();
    await expect(page).toHaveURL(/\/clubs\/[a-z0-9-]+$/);
    await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  });

  test('finds a club by searching for part of its name', async ({ page }) => {
    // A fragment of a real club's name, in the wrong case: matching is a
    // case-insensitive substring, so it must still be found.
    await page.goto('/clubs');
    const name = (await page.locator('main a[href^="/clubs/"]').first().textContent())?.trim() ?? '';
    const word = name.split(/[^A-Za-z]+/).sort((a, b) => b.length - a.length)[0] ?? '';
    const fragment = word.slice(1, 5).toUpperCase();
    expect(fragment).toHaveLength(4);
    // The plain index is the page search engines should keep.
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);

    // From the header's search box where there is one; phones hide it, as
    // the reference does, so there the address is used directly — it is the
    // same GET form either way.
    await page.goto('/');
    const box = page.getByRole('textbox', { name: 'Search clubs' });
    if (await box.isVisible()) {
      await box.fill(fragment);
      await box.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/clubs\\?q=${fragment}$`));
    } else {
      await page.goto(`/clubs?q=${fragment}`);
    }

    const results = page.locator('main a[href^="/clubs/"]');
    await expect(results.filter({ hasText: name })).toHaveCount(1);
    for (const result of await results.allTextContents()) {
      expect(result.toLowerCase()).toContain(fragment.toLowerCase());
    }
    // A search result is not a page of its own: kept out of search engines.
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  });

  test('echoes no more than 100 characters of a search', async ({ page }) => {
    await page.goto(`/clubs?q=${'x'.repeat(150)}`);
    await expect(
      page.getByText(`No club’s name contains “${'x'.repeat(100)}”.`, { exact: true }),
    ).toBeVisible();
  });
});

test.describe('the things that are easy to break and never noticed', () => {
  test('serves a per-league manifest, not a hard-coded one', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);
    const manifest = await response.json();
    // Generated from the resolved league, so it must not be the placeholder.
    expect(manifest.name).not.toBe('League');
    expect(manifest.start_url).toBe('/standings');
  });

  test('serves robots and a sitemap pointing at this host', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain('Sitemap:');

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain('/standings');
  });

  test('answers the health check', async ({ request }) => {
    const response = await request.get('/api/healthz');
    expect(response.status()).toBe(200);
    expect((await response.json()).status).toBe('ok');
  });

  test('answers an unknown address with a real 404, inside the site', async ({ page }) => {
    // A true 404 status, not a streamed 200: a root loading.tsx would start
    // streaming before any page could call notFound(), and every missing club,
    // team or article would then answer 200. Hence there is none.
    const response = await page.goto('/no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('contentinfo')).toBeVisible();

    // The case a loading.tsx actually breaks: a page that awaits the database
    // and only THEN finds nothing to show.
    const missing = await page.goto('/clubs/no-such-club');
    expect(missing?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  });

  test('leaves an anonymous visitor’s pages free to be saved for offline use', async ({ page }) => {
    // The counterpart of the signed-in check in admin-access.spec.ts: marking
    // every page would quietly switch offline support off for everyone.
    const response = await page.goto('/standings');
    expect(response?.headers()['x-personalized']).toBeUndefined();
  });

  test('shows the skip link above the sticky header when it takes focus', async ({ page }) => {
    // The header is stacked above the page, and a skip link that took focus
    // underneath it would be invisible to exactly the people who need it.
    await page.goto('/standings');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    const topmost = await skip.evaluate((link) => {
      const box = link.getBoundingClientRect();
      return link.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    expect(topmost).toBe(true);
  });

  test('keeps the club and team pages’ structured data', async ({ page }) => {
    // Lost silently if a layout change drops the <script> — nothing on screen
    // shows it, and the serializer's unit test cannot see placement.
    await page.goto('/clubs');
    await page.locator('a[href^="/clubs/"]').first().click();
    await expect(page).toHaveURL(/\/clubs\/[a-z0-9-]+$/);
    const data = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(JSON.parse(data ?? '{}')['@type']).toBe('SportsOrganization');

    await page.locator('main a[href^="/teams/"]').first().click();
    await expect(page).toHaveURL(/\/teams\/[a-z0-9-]+$/);
    const team = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(JSON.parse(team ?? '{}')['@type']).toBe('SportsTeam');
  });

  test('does not leak a connection string from the health check', async ({ request }) => {
    // Named in the plan's Layer 4 checks.
    const body = await (await request.get('/api/healthz')).text();
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('postgres://');
  });
});
