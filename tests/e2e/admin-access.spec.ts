import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_STATE, ADMIN_USERNAME } from './auth-state';

/**
 * Who can reach the admin area, and what the second factor actually gates.
 *
 * This is the one place where an end-to-end test earns its cost over the unit
 * suite. `can()` is exhaustively tested as a pure function and the services are
 * tested against a real database — but neither can tell you whether a signed-out
 * visitor is actually redirected, or whether an unenrolled administrator sees a
 * usable page. Both of those are properties of the WIRING, and the wiring is
 * what this file tests.
 */

test.describe('signed out', () => {
  // Explicitly no stored session, whatever the project default is.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('is redirected away from the admin area, not shown an empty one', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });

  test('is redirected away from the account page', async ({ page }) => {
    await page.goto('/account');
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test('is told nothing useful by a wrong password', async ({ page }) => {
    // One message for every failure, so the form is not an oracle for which
    // email addresses belong to league officials.
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill('nobody@example.invalid');
    await page.getByLabel('Password').fill('not-the-right-password-at-all');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Scoped to the form: Next renders its own route announcer with
    // role="alert", so an unscoped query matches two elements.
    const error = page.locator('form').getByRole('alert');
    await expect(error).toBeVisible();
    await expect(error).toContainText(/do not match an account/i);
    // Must not distinguish "no such account" from "wrong password".
    await expect(error).not.toContainText(/no such|not found|unknown user/i);
  });

  test('signs in with a username instead of an email address', async ({ page }, testInfo) => {
    /**
     * The one field accepts either, and works out which from whether it
     * contains an `@`. There is no toggle to get wrong.
     *
     * Runs in one project only — a real sign-in, and better-auth allows three
     * per ten seconds per IP.
     */
    test.skip(
      testInfo.project.name !== 'chromium',
      'performs a real sign-in; runs once to stay under the rate limit',
    );

    await page.goto('/sign-in');
    await expect(page.getByLabel('Email or username')).toBeVisible();
    await page.getByLabel('Email or username').fill(ADMIN_USERNAME);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(/\/admin/);
    await expect(page.getByRole('navigation', { name: 'Admin' })).toBeVisible();
  });

  test('offers no third-party sign-in', async ({ page }) => {
    // Removed on purpose, and asserted so it cannot creep back in with a
    // dependency upgrade or a copied example.
    await page.goto('/sign-in');
    await expect(page.getByRole('button', { name: /google/i })).toHaveCount(0);
    await expect(page.getByText(/continue with/i)).toHaveCount(0);
  });

  test('cannot be sent somewhere else by the next parameter', async ({ page }, testInfo) => {
    /**
     * Runs in one project only. It is the sole test that still performs a real
     * sign-in, and better-auth allows three per ten seconds per IP — running it
     * in both the desktop and phone projects trips that limit and fails for a
     * reason that has nothing to do with what it is testing.
     */
    test.skip(
      testInfo.project.name !== 'chromium',
      'performs a real sign-in; runs once to stay under the rate limit',
    );

    // An open redirect here would turn the league's own sign-in page into a
    // convincing phishing landing.
    await page.goto('/sign-in?next=https://example.com/phish');
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL(/localhost:3000/);
    await expect(page).not.toHaveURL(/example\.com/);
  });
});

test.describe('signed in as a league administrator', () => {
  test.use({ storageState: ADMIN_STATE });

  test('sees the admin sections rather than an empty page', async ({ page }) => {
    // The bug this catches: an unenrolled admin was previously shown "Nothing
    // to administer" underneath a banner saying every button would refuse.
    await page.goto('/admin');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    await expect(nav.getByRole('link', { name: 'Fixtures' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Venues' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Import' })).toBeVisible();
    await expect(page.getByText(/nothing to administer/i)).toHaveCount(0);
  });

  test('can read every admin screen', async ({ page }) => {
    await page.goto('/admin');
    for (const [name, heading] of [
      ['Fixtures', 'Fixtures'],
      ['Venues', 'Venues'],
      ['Import', 'Historical import'],
    ] as const) {
      await page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name }).click();
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    }
  });

  test('sees their roles spelled out on the account page', async ({ page }) => {
    await page.goto('/account');
    // The space is a real character; without it a screen reader announces
    // "League administratoracross the whole league".
    await expect(page.getByText('League administrator across the whole league')).toBeVisible();
  });
});

test.describe('the second factor is a real gate', () => {
  test.use({ storageState: ADMIN_STATE });

  test('refuses a write until TOTP is enrolled, and says why', async ({ page }) => {
    /**
     * The headline security claim of Phase 1, asserted end to end.
     *
     * The seeded administrator has no second factor, so the permission matrix
     * withholds every mutation. Written to be correct EITHER WAY: if somebody
     * enrols the seeded account, the recompute succeeds and that message is
     * accepted instead. What it will not tolerate is a silent no-op, which is
     * how a broken gate usually presents.
     */
    await page.goto('/admin');

    const recompute = page.getByRole('button', { name: 'Recompute' }).first();
    await expect(recompute).toBeVisible();
    await recompute.click();

    const outcome = page.getByRole('status').first();
    await expect(outcome).toBeVisible();
    await expect(outcome).toContainText(/Not permitted to update competition|Recomputed:/);
  });
});
