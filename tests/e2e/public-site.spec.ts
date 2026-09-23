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

    for (const section of ['Standings', 'Schedule', 'Fields', 'Clubs', 'History']) {
      await expect(page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: section })).toBeVisible();
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

  test('does not leak a connection string from the health check', async ({ request }) => {
    // Named in the plan's Layer 4 checks.
    const body = await (await request.get('/api/healthz')).text();
    expect(body).not.toContain('postgresql://');
    expect(body).not.toContain('postgres://');
  });
});
