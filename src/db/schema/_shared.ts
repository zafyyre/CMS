import { sql } from 'drizzle-orm';
import { timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { uuidv7 } from 'uuidv7';

/**
 * UUIDv7 primary keys.
 *
 * Time-ordered, so inserts append to the end of the index instead of
 * scattering across it the way UUIDv4 does — which starts to matter once
 * fixtures and match events reach the hundreds of thousands of rows.
 * PostgreSQL 17 has no native uuidv7(), so it is generated application-side.
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

/**
 * Audit columns present on every table.
 *
 * `deletedAt` is a soft delete: a team that has played forty fixtures cannot
 * be hard-deleted without destroying the historical record those fixtures
 * belong to. Every query against a soft-deletable table must filter
 * `deletedAt IS NULL`; the service-layer helpers do this so callers cannot
 * forget.
 */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};

/**
 * A uniqueness rule that applies only to LIVE rows.
 *
 * A plain UNIQUE constraint counts soft-deleted rows, which means deleting
 * something makes its identifier permanently unusable. A club that folds and
 * refounds could never reclaim its own slug; the league would just get
 * "already exists" for a name nothing visible is using.
 *
 * This is a partial unique INDEX rather than a constraint, because PostgreSQL
 * only supports a WHERE clause on the index form.
 *
 * The trade-off, stated plainly: two rows may now share an identifier as long
 * as all but one are soft-deleted. Every read path already filters
 * `deletedAt IS NULL`, so lookups stay unambiguous — but a query that forgets
 * that filter can see duplicates. That is the price of being able to reuse a
 * name, and it is the right side of the trade for a league that will rename
 * and refound teams for decades.
 */
export function liveUnique(
  name: string,
  ...columns: Parameters<ReturnType<typeof uniqueIndex>['on']>
) {
  return uniqueIndex(name)
    .on(...columns)
    .where(sql`deleted_at IS NULL`);
}
