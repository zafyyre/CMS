import { NextResponse } from 'next/server';
import { checkDatabase } from '@/db';

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
    console.error('[healthz] database check failed:', error);
    return NextResponse.json(
      { status: 'degraded', database: { ok: false }, ts: new Date().toISOString() },
      { status: 503 },
    );
  }
}
