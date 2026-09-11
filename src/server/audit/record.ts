import type { Tx } from '@/db';
import { auditLog } from '@/db/schema';
import type { Principal } from '@/server/authz/roles';

/**
 * Write one row to the append-only audit trail.
 *
 * Takes the surrounding transaction rather than opening its own, deliberately:
 * the audit row and the change it describes must commit or roll back together.
 * A trail that can record a change which then failed is worse than no trail,
 * because it is confidently wrong.
 *
 * Kept out of `src/server/services/` on purpose. Everything under that
 * directory is required by `npm run guard` to consult the permission matrix
 * before writing; this helper is a primitive that services call *after* they
 * have authorized, so it would fail that rule for no good reason.
 */

export interface AuditEntry {
  /** Dotted and past-tense-neutral: "fixture.reschedule", "venue.close". */
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Why, in the actor's words. Required for corrections and overrides. */
  reason?: string | null;
}

export async function recordAudit(
  tx: Tx,
  principal: Principal,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLog).values({
    orgId: principal.orgId,
    actorUserId: principal.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
  });
}
