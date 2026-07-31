import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '@/env';
import type { OrgId } from './org-id';
import * as schema from './schema';

/**
 * The database client, and the only two sanctioned ways to use it.
 *
 * Note the import path: `drizzle-orm/node-postgres`. An earlier version
 * imported `drizzle-orm/pg-protocol`, which does not exist — `pg-protocol` is
 * an internal package of the `pg` driver and exports no Drizzle adapter.
 *
 * The raw handle is not exported. Every league-scoped read or write goes
 * through `withOrg()`, which opens a transaction and sets the context that RLS
 * policies read. `npm run guard` fails the build if anything routes around it.
 */

const pool = new Pool({
  connectionString: env.POSTGRES_URL,
  max: env.NODE_ENV === 'test' ? 5 : 10,
  idleTimeoutMillis: 20_000,
  connectionTimeoutMillis: 10_000,
});

const db = drizzle(pool, { schema });

/** A transaction handle. Services accept this rather than the global client. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside a transaction scoped to one league.
 *
 * Everything the callback does is filtered by RLS to that league's rows — and
 * because the policies carry WITH CHECK, anything it writes is forced to carry
 * that league's id too.
 *
 * Note `set_config(name, value, is_local => true)` rather than `SET LOCAL`.
 * `SET LOCAL` cannot take a bind parameter, so using it would mean
 * interpolating a value into SQL text in the single worst place in the system
 * for an injection. `set_config()` is an ordinary function call and takes the
 * value as a proper parameter.
 *
 * `is_local = true` scopes the setting to this transaction, so it is cleared
 * automatically on commit or rollback and cannot leak to whoever next borrows
 * this pooled connection.
 */
export async function withOrg<T>(orgId: OrgId, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Belt and braces: the brand makes an unverified string a compile error, and
  // this makes it a runtime error too — for JavaScript callers, and for
  // anything that arrived here through a cast.
  if (!UUID_RE.test(orgId)) {
    throw new Error(`withOrg: orgId must be a UUID, received ${JSON.stringify(orgId)}`);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` with no league context.
 *
 * RLS then denies every tenant table, so this reaches only the login-identity
 * tables and the read-open routing tables — which is exactly what the two
 * legitimate uses need: resolving a hostname to a league before the league is
 * known, and looking up a session during authentication.
 *
 * The `reason` argument is required so every call site documents itself and an
 * audit can enumerate them.
 */
export async function withSystem<T>(reason: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!reason || reason.trim().length < 8) {
    throw new Error('withSystem: a descriptive reason is required');
  }

  return db.transaction(async (tx) => {
    // Explicit clear. Transaction-local settings reset at commit so this should
    // already be empty; asserting it costs nothing and removes any dependence
    // on that guarantee holding for a pooled connection.
    await tx.execute(sql`select set_config('app.current_org_id', '', true)`);
    return fn(tx);
  });
}

/**
 * Raw handle, exported solely for better-auth's Drizzle adapter.
 *
 * The auth library owns the login-identity tables — none of which carry
 * `org_id` or have RLS, for the reasons set out in schema/identity.ts — and it
 * must manage its own connections rather than being handed a transaction.
 *
 * `npm run guard` fails the build if anything outside `src/server/auth/`
 * imports this.
 */
export const identityDb = db;

/** Liveness probe. Deliberately touches no league data. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now();
  const client = await pool.connect();
  try {
    await client.query('select 1');
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } finally {
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export { schema };
