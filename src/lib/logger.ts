import pino from 'pino';
import { env } from '@/env';

/**
 * Structured logging.
 *
 * JSON in production, because logs are read by a machine before they are read
 * by a person: an aggregator can filter on `orgId` or `requestId` only if those
 * are fields rather than words inside a sentence. Pretty-printed in
 * development, because there the reader is always a person.
 *
 * ── WHAT MUST NEVER APPEAR IN A LOG LINE ────────────────────────────────────
 * This is a multi-tenant system holding six thousand people's names, dates of
 * birth and disciplinary records, in a jurisdiction (BC) whose PIPA governs how
 * that information is handled. A log aggregator is a second, less-guarded copy
 * of whatever you put in it — and it usually has weaker access control than the
 * database and a longer retention than anyone remembers agreeing to.
 *
 * So the redaction list below is not decoration, and `redact` is configured
 * with paths rather than left to call sites remembering. The rule for new code:
 * log IDs, never people. `personId` is fine; `givenName` is not.
 * ────────────────────────────────────────────────────────────────────────────
 */

const isProduction = env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),

  /**
   * Paths blanked before anything is written.
   *
   * Wildcards cover the nested case: an error thrown by the driver can carry
   * the whole failing statement, and a statement inserting a person carries
   * that person.
   */
  redact: {
    paths: [
      'password',
      '*.password',
      '*.*.password',
      'token',
      '*.token',
      'secret',
      '*.secret',
      'backupCodes',
      '*.backupCodes',
      'authorization',
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      // People. See the note above.
      '*.email',
      '*.phone',
      '*.dateOfBirth',
      '*.givenName',
      '*.familyName',
      '*.displayName',
    ],
    censor: '[redacted]',
  },

  base: {
    // Which service produced the line, for an aggregator carrying several.
    service: 'league-cms',
    env: env.NODE_ENV,
  },

  // ISO rather than epoch milliseconds: a human reads these during an incident.
  timestamp: pino.stdTimeFunctions.isoTime,

  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,env' },
        },
      }),
});

/**
 * A logger bound to one request.
 *
 * The request id comes from middleware, which stamps every request with one and
 * echoes it in the response. That is what makes a user's "it failed at about
 * half past two" into a single grep — and, on a match night when four thousand
 * people load the standings in twenty minutes, the difference between a log you
 * can search and one you can only scroll.
 */
export const requestLogger = (requestId: string | null, extra: Record<string, unknown> = {}) =>
  logger.child({ requestId: requestId ?? 'unknown', ...extra });

export type Logger = typeof logger;
