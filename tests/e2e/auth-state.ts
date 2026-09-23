/**
 * Shared between the sign-in setup and the specs that reuse its session.
 *
 * A plain module rather than an export from `auth.setup.ts`, because Playwright
 * refuses to let one test file import another — and a setup project counts as a
 * test file.
 */

export const ADMIN_STATE = 'tests/e2e/.auth/admin.json';

export const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@kelowna.localhost';
export const ADMIN_USERNAME = process.env.SEED_ADMIN_USERNAME ?? 'demoadmin';
export const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'demo-password-please-change';
