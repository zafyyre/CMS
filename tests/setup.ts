import { config } from 'dotenv';

config({ path: '.env' });

/**
 * Point the application's database client at the TEST database before any
 * module reads the environment.
 *
 * `src/env.ts` validates eagerly on import and Vitest runs setup files before
 * test files, so this reassignment lands first. Without it, an integration test
 * that truncates tables would destroy development data instead.
 */
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Copy .env.example to .env, run `npm run db:up`, ' +
      'then `npm run db:migrate:test`.',
  );
}

process.env.POSTGRES_URL = testUrl;
process.env.BETTER_AUTH_SECRET ??= 'test-secret-at-least-32-characters-long!!';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
