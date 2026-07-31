import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * Validated environment.
 *
 * Nothing in the application reads `process.env` directly — everything imports
 * from here, so a missing or malformed variable fails loudly at boot rather
 * than surfacing as `undefined` deep inside a request three weeks later.
 *
 * Note what is deliberately ABSENT: SEED_DATABASE_URL and
 * TEST_SEED_DATABASE_URL. Those are superuser connections used only by scripts,
 * and a superuser bypasses row-level security entirely. Omitting them here
 * means the application literally cannot reach for them.
 */

const PLACEHOLDER_SECRET = 'replace-me-with-32-bytes-of-base64-randomness';

/** Avoids zod-4's moved `.url()` API; also asserts the scheme we actually want. */
const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => v.startsWith('postgresql://') || v.startsWith('postgres://'), {
    message: 'must be a postgresql:// connection string',
  });

export const env = createEnv({
  server: {
    // app_user — powerless by design. See .env.example.
    POSTGRES_URL: postgresUrl,
    // migrator — owns the tables, runs migrations only.
    MIGRATION_DATABASE_URL: postgresUrl.optional(),

    TEST_DATABASE_URL: postgresUrl.optional(),
    TEST_MIGRATION_DATABASE_URL: postgresUrl.optional(),

    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    BETTER_AUTH_URL: z.string().min(1),

    DEFAULT_ORG_SLUG: z.string().min(1).default('demo'),

    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  },

  client: {
    NEXT_PUBLIC_APP_NAME: z.string().default('CMS'),
  },

  runtimeEnv: {
    POSTGRES_URL: process.env.POSTGRES_URL,
    MIGRATION_DATABASE_URL: process.env.MIGRATION_DATABASE_URL,
    TEST_DATABASE_URL: process.env.TEST_DATABASE_URL,
    TEST_MIGRATION_DATABASE_URL: process.env.TEST_MIGRATION_DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    DEFAULT_ORG_SLUG: process.env.DEFAULT_ORG_SLUG,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  },

  /**
   * Only skipped for an explicit opt-out, never for CI.
   *
   * The previous version skipped validation whenever `CI` was set, which meant
   * the one environment that should most rigorously prove its configuration was
   * the one environment that never checked it.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});

/**
 * Refuses the example placeholder secret outside development. Kept out of the
 * schema above so that a fresh checkout can still boot locally.
 */
if (env.NODE_ENV === 'production' && env.BETTER_AUTH_SECRET === PLACEHOLDER_SECRET) {
  throw new Error(
    'BETTER_AUTH_SECRET is still the example placeholder. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
  );
}
