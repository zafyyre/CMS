import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

config({ path: '.env' });

/**
 * drizzle-kit 0.31 config shape.
 *
 * The previous version of this file used `driver: 'pg'` with
 * `dbCredentials.connectionString`, which is the pre-0.21 API and is rejected
 * outright by the installed drizzle-kit — so `drizzle-kit push`/`generate`
 * could never run. 0.31 wants `dialect` + `dbCredentials.url`.
 */

const url = process.env.MIGRATION_DATABASE_URL ?? process.env.POSTGRES_URL;

if (!url) {
  throw new Error(
    'Neither MIGRATION_DATABASE_URL nor POSTGRES_URL is set. Copy .env.example to .env first.',
  );
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  verbose: true,
  strict: true,
});
