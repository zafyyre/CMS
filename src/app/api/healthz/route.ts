import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { checkDatabase } from '@/db';
import { requestLogger } from '@/lib/logger';

/**
 * Liveness and readiness probe.
 *
 * It touches the database, because a process that is running but cannot reach
 * PostgreSQL is not ready to serve traffic.
 *
 * It deliberately does NOT echo the error. This endpoint is unauthenticated,
 * and `pg` errors routinely carry the host, port, database and user from the
 * connection string. The detail goes to the server log, where it belongs.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const database = await checkDatabase();
    return NextResponse.json(
      { status: 'ok', database, ts: new Date().toISOString() },
      { status: 200 },
    );
  } catch (error) {
    // Structured, and carrying the request id middleware stamped, so this line
    // can be joined to the request that produced it.
    const log = requestLogger((await headers()).get('x-request-id'));
    log.error({ err: error }, 'health check could not reach the database');

    return NextResponse.json(
      { status: 'degraded', database: { ok: false }, ts: new Date().toISOString() },
      { status: 503 },
    );
  }
}
