import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { type Tx, withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import { municipalities, venueClosures, venues } from '@/db/schema';
import { recordAudit } from '@/server/audit/record';
import { assertCan } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import { slugify } from '@/lib/slug';
import { NotFoundError, requireText, ValidationError } from './errors';

/**
 * Venues, and whether they are open.
 *
 * The field-status feature lives here. Between October and March it is the
 * most-read thing this league publishes and on the old site it is three clicks
 * down a menu — so the closure query is written to answer the site-wide banner
 * question ("is anything shut right now?") in one round trip rather than as a
 * per-venue lookup.
 */

export type VenueSurface = 'GRASS' | 'ARTIFICIAL_TURF' | 'INDOOR' | 'UNKNOWN';

export interface VenueSummary {
  id: string;
  name: string;
  slug: string;
  surface: VenueSurface;
  isFloodlit: boolean;
  municipalityCode: string | null;
  municipalityName: string | null;
  parentVenueId: string | null;
  parentVenueName: string | null;
  latitude: number | null;
  longitude: number | null;
  mapUrl: string | null;
  isActive: boolean;
  /** The closure in force at the moment this was read, if any. */
  closure: ClosureSummary | null;
}

export interface ClosureSummary {
  id: string;
  venueId: string;
  venueName: string;
  startsAt: Date;
  endsAt: Date | null;
  reason: string;
  source: string | null;
}

// --- reads -------------------------------------------------------------------

/**
 * Every venue, with its municipality, its complex, and whether it is shut.
 *
 * `at` is passed in rather than read from the clock so the caller controls it —
 * which is what makes "what did the field status look like on Saturday
 * morning" answerable, and what makes this testable without freezing time.
 */
export async function listVenues(orgId: OrgId, at: Date = new Date()): Promise<VenueSummary[]> {
  return withOrg(orgId, async (tx) => {
    // Self-join: a pitch's parent is another row in this table.
    const parent = alias(venues, 'parent_venue');

    const rows = await tx
      .select({
        id: venues.id,
        name: venues.name,
        slug: venues.slug,
        surface: venues.surface,
        isFloodlit: venues.isFloodlit,
        parentVenueId: venues.parentVenueId,
        parentVenueName: parent.name,
        municipalityCode: municipalities.code,
        municipalityName: municipalities.name,
        latitude: venues.latitude,
        longitude: venues.longitude,
        mapUrl: venues.mapUrl,
        isActive: venues.isActive,
      })
      .from(venues)
      .leftJoin(municipalities, eq(venues.municipalityId, municipalities.id))
      .leftJoin(parent, eq(venues.parentVenueId, parent.id))
      .where(isNull(venues.deletedAt))
      .orderBy(asc(municipalities.sortOrder), asc(venues.name));

    const closures = await selectClosuresInForce(tx, at);
    const byVenue = new Map(closures.map((c) => [c.venueId, c]));

    return rows.map((row) => ({
      ...row,
      surface: row.surface as VenueSurface,
      closure: byVenue.get(row.id) ?? null,
    }));
  });
}

/** Just the closures, for the site-wide "fields closed today" banner. */
export async function listClosuresInForce(
  orgId: OrgId,
  at: Date = new Date(),
): Promise<ClosureSummary[]> {
  return withOrg(orgId, (tx) => selectClosuresInForce(tx, at));
}

async function selectClosuresInForce(tx: Tx, at: Date): Promise<ClosureSummary[]> {
  return tx
    .select({
      id: venueClosures.id,
      venueId: venueClosures.venueId,
      venueName: venues.name,
      startsAt: venueClosures.startsAt,
      endsAt: venueClosures.endsAt,
      reason: venueClosures.reason,
      source: venueClosures.source,
    })
    .from(venueClosures)
    .innerJoin(venues, eq(venueClosures.venueId, venues.id))
    .where(
      and(
        isNull(venueClosures.deletedAt),
        isNull(venues.deletedAt),
        lte(venueClosures.startsAt, at),
        // An open-ended closure has no end date and stays in force.
        or(isNull(venueClosures.endsAt), gt(venueClosures.endsAt, at)),
      ),
    )
    .orderBy(asc(venues.name));
}

export async function getVenueBySlug(orgId: OrgId, slug: string): Promise<VenueSummary | null> {
  const all = await listVenues(orgId);
  return all.find((v) => v.slug === slug) ?? null;
}

export async function listMunicipalities(orgId: OrgId) {
  return withOrg(orgId, (tx) =>
    tx
      .select({
        id: municipalities.id,
        code: municipalities.code,
        name: municipalities.name,
      })
      .from(municipalities)
      .where(isNull(municipalities.deletedAt))
      .orderBy(asc(municipalities.sortOrder), asc(municipalities.name)),
  );
}

// --- writes ------------------------------------------------------------------

export interface CreateVenueInput {
  name: string;
  slug?: string;
  parentVenueId?: string | null;
  municipalityId?: string | null;
  surface?: VenueSurface;
  isFloodlit?: boolean;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  mapUrl?: string | null;
  notes?: string | null;
}

export async function createVenue(
  principal: Principal,
  input: CreateVenueInput,
): Promise<{ id: string; slug: string }> {
  assertCan(principal, 'create', { type: 'venue' });

  const name = requireText(input.name, 'name');
  const slug = slugify(input.slug ?? name);
  if (!slug) throw new ValidationError('A venue needs a name that yields a usable slug.');

  return withOrg(principal.orgId, async (tx) => {
    const [created] = await tx
      .insert(venues)
      .values({
        orgId: principal.orgId,
        name,
        slug,
        parentVenueId: input.parentVenueId ?? null,
        municipalityId: input.municipalityId ?? null,
        surface: input.surface ?? 'UNKNOWN',
        isFloodlit: input.isFloodlit ?? false,
        address: input.address ?? null,
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        mapUrl: input.mapUrl ?? null,
        notes: input.notes ?? null,
      })
      .returning({ id: venues.id, slug: venues.slug });

    if (!created) throw new Error('venue insert returned no row');

    await recordAudit(tx, principal, {
      action: 'venue.create',
      entityType: 'venue',
      entityId: created.id,
      after: { name, slug },
    });

    return created;
  });
}

export type UpdateVenueInput = Partial<Omit<CreateVenueInput, 'slug'>> & {
  isActive?: boolean;
};

export async function updateVenue(
  principal: Principal,
  venueId: string,
  patch: UpdateVenueInput,
): Promise<void> {
  assertCan(principal, 'update', { type: 'venue', id: venueId });

  await withOrg(principal.orgId, async (tx) => {
    const [before] = await tx
      .select()
      .from(venues)
      .where(and(eq(venues.id, venueId), isNull(venues.deletedAt)));
    if (!before) throw new NotFoundError('venue', venueId);

    // Enumerated rather than spread. A spread would happily accept `orgId` from
    // the caller and let a write cross leagues — RLS would reject it, but a
    // rejection at the database is a worse error message than never offering
    // the field.
    const next = {
      name: patch.name ?? before.name,
      parentVenueId: patch.parentVenueId === undefined ? before.parentVenueId : patch.parentVenueId,
      municipalityId:
        patch.municipalityId === undefined ? before.municipalityId : patch.municipalityId,
      surface: patch.surface ?? before.surface,
      isFloodlit: patch.isFloodlit ?? before.isFloodlit,
      address: patch.address === undefined ? before.address : patch.address,
      latitude: patch.latitude === undefined ? before.latitude : patch.latitude,
      longitude: patch.longitude === undefined ? before.longitude : patch.longitude,
      mapUrl: patch.mapUrl === undefined ? before.mapUrl : patch.mapUrl,
      notes: patch.notes === undefined ? before.notes : patch.notes,
      isActive: patch.isActive ?? before.isActive,
      updatedAt: new Date(),
    };

    await tx.update(venues).set(next).where(eq(venues.id, venueId));

    await recordAudit(tx, principal, {
      action: 'venue.update',
      entityType: 'venue',
      entityId: venueId,
      before: { name: before.name, surface: before.surface, isActive: before.isActive },
      after: { name: next.name, surface: next.surface, isActive: next.isActive },
    });
  });
}

export interface CloseVenueInput {
  venueId: string;
  startsAt: Date;
  /** Null means "until further notice", which is what a city usually says. */
  endsAt?: Date | null;
  reason: string;
  source?: string | null;
}

export async function closeVenue(
  principal: Principal,
  input: CloseVenueInput,
): Promise<{ id: string }> {
  assertCan(principal, 'update', { type: 'venue', id: input.venueId });

  const reason = requireText(input.reason, 'reason');
  if (input.endsAt && input.endsAt <= input.startsAt) {
    throw new ValidationError('A closure must end after it starts.');
  }

  return withOrg(principal.orgId, async (tx) => {
    const [venue] = await tx
      .select({ id: venues.id, name: venues.name })
      .from(venues)
      .where(and(eq(venues.id, input.venueId), isNull(venues.deletedAt)));
    if (!venue) throw new NotFoundError('venue', input.venueId);

    const [created] = await tx
      .insert(venueClosures)
      .values({
        orgId: principal.orgId,
        venueId: input.venueId,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        reason,
        source: input.source ?? null,
      })
      .returning({ id: venueClosures.id });

    if (!created) throw new Error('venue closure insert returned no row');

    await recordAudit(tx, principal, {
      action: 'venue.close',
      entityType: 'venueClosure',
      entityId: created.id,
      after: { venueId: input.venueId, startsAt: input.startsAt, endsAt: input.endsAt ?? null },
      reason,
    });

    return created;
  });
}

/**
 * Lift a closure.
 *
 * Sets the end to now rather than deleting the row: "the pitch was shut on
 * Saturday and reopened on Sunday" is a fact somebody will need when a match
 * played that weekend is protested.
 */
export async function reopenVenue(
  principal: Principal,
  closureId: string,
  at: Date = new Date(),
): Promise<void> {
  assertCan(principal, 'update', { type: 'venue' });

  await withOrg(principal.orgId, async (tx) => {
    const [closure] = await tx
      .select()
      .from(venueClosures)
      .where(and(eq(venueClosures.id, closureId), isNull(venueClosures.deletedAt)));
    if (!closure) throw new NotFoundError('venueClosure', closureId);

    // A closure that had not started yet is cancelled outright, since ending it
    // before it began would violate the ordering constraint.
    const endsAt = at > closure.startsAt ? at : closure.startsAt;
    const cancelled = endsAt <= closure.startsAt;

    await tx
      .update(venueClosures)
      .set({
        endsAt,
        deletedAt: cancelled ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(venueClosures.id, closureId));

    await recordAudit(tx, principal, {
      action: cancelled ? 'venue.closure.cancel' : 'venue.reopen',
      entityType: 'venueClosure',
      entityId: closureId,
      before: { endsAt: closure.endsAt },
      after: { endsAt },
    });
  });
}

/** Soft delete. A venue with forty fixtures against it is never removed. */
export async function retireVenue(principal: Principal, venueId: string): Promise<void> {
  assertCan(principal, 'delete', { type: 'venue', id: venueId });

  await withOrg(principal.orgId, async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(venues)
      .set({ deletedAt: now, updatedAt: now, isActive: false })
      .where(and(eq(venues.id, venueId), isNull(venues.deletedAt)))
      .returning({ id: venues.id });

    if (updated.length === 0) throw new NotFoundError('venue', venueId);

    await recordAudit(tx, principal, {
      action: 'venue.retire',
      entityType: 'venue',
      entityId: venueId,
    });
  });
}

/** Ensures a municipality exists for this code, and returns it. */
export async function upsertMunicipality(
  principal: Principal,
  input: { code: string; name: string; sortOrder?: number },
): Promise<{ id: string }> {
  assertCan(principal, 'create', { type: 'venue' });

  const code = requireText(input.code, 'code').toUpperCase();
  const name = requireText(input.name, 'name');

  return withOrg(principal.orgId, async (tx) => {
    const [existing] = await tx
      .select({ id: municipalities.id })
      .from(municipalities)
      .where(and(eq(municipalities.code, code), isNull(municipalities.deletedAt)));
    if (existing) return existing;

    const [created] = await tx
      .insert(municipalities)
      .values({
        orgId: principal.orgId,
        code,
        name,
        sortOrder: input.sortOrder ?? 0,
      })
      .returning({ id: municipalities.id });

    if (!created) throw new Error('municipality insert returned no row');
    return created;
  });
}
