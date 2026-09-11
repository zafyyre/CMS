import { config } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

/**
 * Load `.env` WITHOUT letting it set NODE_ENV.
 *
 * `.env` contains `NODE_ENV=development`, which is correct for `next dev` and
 * poison here. dotenv writes it into this process's real environment; the
 * `npm run build` that `webServer` spawns then inherits it, and Next builds in
 * development mode. The result is a React dev/production mismatch that fails
 * while prerendering with:
 *
 *   TypeError: Cannot read properties of null (reading 'useContext')
 *   Error occurred prerendering page "/_global-error"
 *
 * — an error naming neither NODE_ENV nor dotenv, and which does NOT occur when
 * the identical `npm run build` is run by hand, because then nothing has put
 * NODE_ENV in the environment ahead of Next.
 */
// Next types NODE_ENV as read-only and `next build` typechecks this file, so
// the restore goes through a widened reference rather than fighting the type.
const mutableEnv = process.env as Record<string, string | undefined>;
const nodeEnvBefore = mutableEnv.NODE_ENV;
config({ path: '.env' });
if (nodeEnvBefore === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
else mutableEnv.NODE_ENV = nodeEnvBefore;

/**
 * End-to-end tests.
 *
 * These exist to cover what the integration suite structurally cannot: the
 * integration tests call services directly, so they prove the DATA layer is
 * correct while saying nothing about whether a person can actually reach it.
 * A page that throws on render, a Server Action that is never wired to its
 * form, a redirect loop in front of the admin area — every one of those passes
 * 386 green tests and fails the first human who tries.
 *
 * Deliberately few, and deliberately about paths rather than pixels. A large
 * e2e suite is slow and brittle, and this project already has fast, thorough
 * coverage one layer down. What is wanted here is a smoke alarm.
 *
 * `webServer` runs the PRODUCTION build. Development mode compiles routes on
 * first request, which makes the first navigation of every test slow enough to
 * trip timeouts, and it also skips the production-only code paths — the
 * service worker registration among them.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker in CI: these tests share one seeded database, and a parallel
  // run that mutates it produces failures that look exactly like real bugs.
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Signs in once and saves the cookie. See the note in auth.setup.ts:
    // better-auth rate-limits sign-in to three attempts per ten seconds.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    /**
     * A phone profile, because that is how this is actually read: at the side
     * of a pitch, on a Sunday evening. The standings table hides columns below
     * `sm`, and nothing else in the suite would notice if that broke.
     */
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      dependencies: ['setup'],
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run build && npm run start',
        url: 'http://localhost:3000/api/healthz',
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        stdout: 'pipe',
        stderr: 'pipe',
      },
});
