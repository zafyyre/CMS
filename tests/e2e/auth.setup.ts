import { expect, test as setup } from '@playwright/test';

/**
 * Sign in ONCE and save the session for every test that needs one.
 *
 * Not merely an optimisation. better-auth rate-limits `/sign-in` to **three
 * attempts per ten seconds per IP** by default whenever `NODE_ENV` is
 * production — and the e2e suite runs against a production build. Half a dozen
 * tests each signing in for themselves trip that limit, and the failure
 * presents as a sign-in that silently does nothing and a `waitForURL` timeout
 * naming no cause at all.
 *
 * So the credentials are used once, here, and the resulting cookie is reused.
 * The tests that are ABOUT being signed out deliberately do not load it.
 */

import { ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_STATE } from './auth-state';

setup('sign in as the league administrator', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.waitForURL(/\/admin|\/sign-in\/two-factor/);

  /**
   * The seeded administrator has no second factor, which is what makes the
   * "MFA refuses a write" test meaningful. If somebody has enrolled on this
   * database, say so in one sentence rather than letting every later test fail
   * on a URL mismatch.
   */
  if (page.url().includes('two-factor')) {
    throw new Error(
      'The seeded administrator has a second factor enrolled, so the suite cannot sign in. ' +
        'Run `npm run db:seed:reset` before `npm run test:e2e`.',
    );
  }

  await expect(page.getByRole('navigation', { name: 'Admin' })).toBeVisible();
  await page.context().storageState({ path: ADMIN_STATE });
});
