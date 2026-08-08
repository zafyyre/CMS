import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Tx, withOrg } from '@/db';
import type { OrgId } from '@/db/org-id';
import {
  clubs,
  competitionEditions,
  competitionSeries,
  editionEntries,
  entityAliases,
  fixtureChanges,
  fixtures,
  honourAwards,
  honours,
  importBatches,
  importRecords,
  resultSubmissions,
  stageGroupEntries,
  stageGroups,
  stages,
  standingsRows,
  standingsSnapshots,
  teams,
  venues,
} from '@/db/schema';
import { slugify, uniqueSlug } from '@/lib/slug';
import { zonedWallTimeToInstant } from '@/lib/time';
import { recordAudit } from '@/server/audit/record';
import { assertCan } from '@/server/authz/can';
import type { Principal } from '@/server/authz/roles';
import {
  type LegacyExport,
  type LegacyFixture,
  type LegacyHonour,
  type LegacyStanding,
  parseLegacyExport,
} from '@/server/import/format';
import {
  type ComputedRow,
  diffStandings,
  interpretDiff,
} from '@/server/import/standings-diff';
import { recomputeStandingsWithin } from '@/server/standings/recompute';
import { getLeagueTimeZone } from './fixtures';
import {
  type Candidate,
  matchingKey,
  normalizeName,
  proposeCandidates,
  STRONG_MATCH,
} from '@/server/import/names';
import { NotFoundError, requireText, ValidationError } from './errors';

/**
 * The historical import, in three explicit steps.
 *
 *   STAGE     the file lands in `import_records`, verbatim. Nothing real is
 *             touched. Re-staging an identical file is refused by its digest.
 *   RESOLVE   every row is matched against confirmed aliases, then against
 *             existing names, then — only if neither works — proposed as a set
 *             of scored candidates for a human.
 *   PROMOTE   rows a human has accepted are written into the real tables.
 *
 * The steps are separate because they fail differently and because the middle
 * one needs a person. A single `import()` that did all three would either merge
 * clubs silently or refuse to import anything, and neither is usable.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It never resolves against an UNCONFIRMED alias, and it never accepts a fuzzy
 * match on its own, however high the score. `STRONG_MATCH` pre-selects a
 * candidate in the review queue; it does not decide. Silently merging two
 * clubs' histories is unrecoverable — the evidence that they were separate is
 * exactly what gets destroyed — and it is worth four seconds of somebody's
 * attention to avoid.
 * ────────────────────────────────────────────────────────────────────────────
 */

export type ImportEntityKind =
  | 'CLUB'
  | 'TEAM'
  | 'PERSON'
  | 'VENUE'
  | 'SEASON'
  | 'COMPETITION'
  | 'FIXTURE'
  | 'RESULT'
  | 'HONOUR_AWARD'
  | 'STANDING';

export interface StageOptions {
  source?: string;
  sourceKind?: 'LEGACY_EXPORT' | 'SCRAPE' | 'CSV' | 'MANUAL';
  dryRun?: boolean;
}

export interface BatchSummary {
  batchId: string;
  status: string;
  source: string;
  dryRun: boolean;
  recordsTotal: number;
  recordsMatched: number;
  recordsNeedingReview: number;
  recordsPromoted: number;
  recordsFailed: number;
}

// --- stage -------------------------------------------------------------------

export async function stageImport(
  principal: Principal,
  raw: string,
  options: StageOptions = {},
): Promise<BatchSummary> {
  // Before parsing. An unauthorized caller must not learn what a malformed
  // export contains from the error messages.
  assertCan(principal, 'create', { type: 'club' });
  assertCan(principal, 'create', { type: 'team' });

  const parsed = parseLegacyExport(raw);
  const digest = createHash('sha256').update(raw).digest('hex');

  return withOrg(principal.orgId, async (tx) => {
    const [existing] = await tx
      .select({ id: importBatches.id, status: importBatches.status })
      .from(importBatches)
      .where(
        and(eq(importBatches.sourceDigest, digest), isNull(importBatches.deletedAt)),
      );

    if (existing) {
      throw new ValidationError(
        `This exact file has already been staged as batch ${existing.id} (${existing.status}). ` +
          'Discard that batch first, or change the file.',
      );
    }

    const [batch] = await tx
      .insert(importBatches)
      .values({
        orgId: principal.orgId,
        source: options.source ?? parsed.source,
        sourceKind: options.sourceKind ?? 'LEGACY_EXPORT',
        sourceDigest: digest,
        dryRun: options.dryRun ?? false,
        status: 'STAGED',
      })
      .returning({ id: importBatches.id });

    if (!batch) throw new Error('import batch insert returned no row');

    const rows = flatten(parsed).map((record) => ({
      orgId: principal.orgId,
      batchId: batch.id,
      entityKind: record.kind,
      sourceKey: record.key,
      payload: record.payload as object,
      status: 'PENDING' as const,
    }));

    if (rows.length > 0) {
      // Chunked: a twelve-season export is tens of thousands of rows, and one
      // statement with that many parameters exceeds what the driver will bind.
      for (const chunk of chunked(rows, 500)) {
        await tx.insert(importRecords).values(chunk);
      }
    }

    await tx
      .update(importBatches)
      .set({ recordsTotal: rows.length, updatedAt: new Date() })
      .where(eq(importBatches.id, batch.id));

    await recordAudit(tx, principal, {
      action: 'import.stage',
      entityType: 'importBatch',
      entityId: batch.id,
      after: { source: parsed.source, records: rows.length, digest },
    });

    return summarize(await loadBatch(tx, batch.id));
  });
}

/** Every entity in the export, as staging rows. */
function flatten(
  parsed: LegacyExport,
): { kind: ImportEntityKind; key: string; payload: unknown }[] {
  return [
    ...parsed.clubs.map((c) => ({ kind: 'CLUB' as const, key: c.key, payload: c })),
    ...parsed.teams.map((t) => ({ kind: 'TEAM' as const, key: t.key, payload: t })),
    ...parsed.venues.map((v) => ({ kind: 'VENUE' as const, key: v.key, payload: v })),
    ...parsed.fixtures.map((f) => ({ kind: 'FIXTURE' as const, key: f.key, payload: f })),
    ...parsed.standings.map((s) => ({ kind: 'STANDING' as const, key: s.key, payload: s })),
    ...parsed.honours.map((h) => ({ kind: 'HONOUR_AWARD' as const, key: h.key, payload: h })),
  ];
}

// --- resolve -----------------------------------------------------------------

export interface ResolveOutcome {
  matched: number;
  createdAsNew: number;
  needsReview: number;
  /** Kinds this step does not attempt to resolve yet. */
  deferred: number;
}

/**
 * Match every staged name to something real, or ask.
 *
 * Only the name-bearing kinds are resolved here: clubs, teams and venues. A
 * fixture is resolved by resolving the teams it names, so there is nothing to
 * do for it until those are settled — and doing it in one pass would report a
 * thousand fixture failures caused by one unmatched club.
 */
export async function resolveImport(
  principal: Principal,
  batchId: string,
): Promise<ResolveOutcome> {
  assertCan(principal, 'update', { type: 'club' });

  return withOrg(principal.orgId, async (tx) => {
    const batch = await loadBatch(tx, batchId);
    if (batch.status === 'PROMOTED') {
      throw new ValidationError('That batch has already been promoted.');
    }

    const outcome: ResolveOutcome = {
      matched: 0,
      createdAsNew: 0,
      needsReview: 0,
      deferred: 0,
    };

    const known = {
      CLUB: await loadKnown(tx, 'CLUB'),
      TEAM: await loadKnown(tx, 'TEAM'),
      VENUE: await loadKnown(tx, 'VENUE'),
    };
    const aliases = await loadConfirmedAliases(tx);

    const pending = await tx
      .select()
      .from(importRecords)
      .where(
        and(
          eq(importRecords.batchId, batchId),
          inArray(importRecords.status, ['PENDING', 'NEEDS_REVIEW']),
        ),
      )
      .orderBy(asc(importRecords.entityKind), asc(importRecords.sourceKey));

    for (const record of pending) {
      const kind = record.entityKind as ImportEntityKind;
      if (kind !== 'CLUB' && kind !== 'TEAM' && kind !== 'VENUE') {
        outcome.deferred++;
        continue;
      }

      const payload = record.payload as { name?: string };
      const sourceName = payload.name?.trim();
      if (!sourceName) {
        await markRecord(tx, record.id, 'FAILED', null, null, 'The row has no name.');
        continue;
      }

      // 1. A confirmed alias is the end of the question.
      const aliased = aliases.get(`${kind}:${normalizeName(sourceName)}`);
      if (aliased) {
        await markRecord(tx, record.id, 'MATCHED', aliased, null, 'Matched by a confirmed alias.');
        outcome.matched++;
        continue;
      }

      // 2. An exact name, after normalisation, is safe to take.
      const exact = known[kind].find((e) => normalizeName(e.name) === normalizeName(sourceName));
      if (exact) {
        await markRecord(tx, record.id, 'MATCHED', exact.id, null, 'Matched on an identical name.');
        outcome.matched++;
        continue;
      }

      // 3. Anything else is a proposal, never a decision.
      const candidates = proposeCandidates(sourceName, known[kind]);
      if (candidates.length === 0) {
        await markRecord(tx, record.id, 'NEW', null, null, 'No similar name exists; will be created.');
        outcome.createdAsNew++;
        continue;
      }

      await markRecord(
        tx,
        record.id,
        'NEEDS_REVIEW',
        null,
        candidates,
        describeCandidates(sourceName, candidates),
      );
      outcome.needsReview++;
    }

    await tx
      .update(importBatches)
      .set({
        status: outcome.needsReview > 0 ? 'STAGED' : 'RESOLVED',
        recordsMatched: outcome.matched,
        recordsNeedingReview: outcome.needsReview,
        updatedAt: new Date(),
      })
      .where(eq(importBatches.id, batchId));

    await recordAudit(tx, principal, {
      action: 'import.resolve',
      entityType: 'importBatch',
      entityId: batchId,
      after: outcome,
    });

    return outcome;
  });
}

function describeCandidates(sourceName: string, candidates: Candidate[]): string {
  const best = candidates[0];
  if (best && best.score >= STRONG_MATCH) {
    return `"${sourceName}" is very likely "${best.name}" (${Math.round(best.score * 100)}%). Confirm or choose another.`;
  }
  return `"${sourceName}" resembles ${candidates.length} existing name${candidates.length === 1 ? '' : 's'}. A person must decide.`;
}

// --- review ------------------------------------------------------------------

export interface ReviewItem {
  recordId: string;
  entityKind: ImportEntityKind;
  sourceKey: string;
  sourceName: string;
  message: string | null;
  candidates: Candidate[];
}

export async function listReviewQueue(orgId: OrgId, batchId: string): Promise<ReviewItem[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(importRecords)
      .where(
        and(eq(importRecords.batchId, batchId), eq(importRecords.status, 'NEEDS_REVIEW')),
      )
      .orderBy(asc(importRecords.entityKind), asc(importRecords.sourceKey));

    return rows.map((row) => ({
      recordId: row.id,
      entityKind: row.entityKind as ImportEntityKind,
      sourceKey: row.sourceKey,
      sourceName: (row.payload as { name?: string }).name ?? row.sourceKey,
      message: row.message,
      candidates: (row.candidates as Candidate[] | null) ?? [],
    }));
  });
}

/**
 * "Yes, that is the same club."
 *
 * Records the decision as a CONFIRMED alias, so the remaining eleven seasons
 * resolve without asking again. That is the whole economics of this design: the
 * first season is laborious and the rest are not.
 */
export async function confirmMatch(
  principal: Principal,
  recordId: string,
  canonicalId: string,
): Promise<void> {
  assertCan(principal, 'update', { type: 'club' });

  await withOrg(principal.orgId, async (tx) => {
    const [record] = await tx
      .select()
      .from(importRecords)
      .where(eq(importRecords.id, recordId));
    if (!record) throw new NotFoundError('importRecord', recordId);

    const sourceName = requireText((record.payload as { name?: string }).name, 'name');
    const candidates = (record.candidates as Candidate[] | null) ?? [];
    const chosen = candidates.find((c) => c.id === canonicalId);

    await tx.insert(entityAliases).values({
      orgId: principal.orgId,
      entityKind: record.entityKind,
      alias: sourceName,
      normalizedAlias: normalizeName(sourceName),
      canonicalId,
      confidence: chosen?.score ?? null,
      confirmedAt: new Date(),
      confirmedByPersonId: principal.personId,
      proposedByBatchId: record.batchId,
    });

    await markRecord(tx, recordId, 'MATCHED', canonicalId, null, 'Confirmed by a person.');

    await recordAudit(tx, principal, {
      action: 'import.confirmMatch',
      entityType: 'importRecord',
      entityId: recordId,
      after: { alias: sourceName, canonicalId, confidence: chosen?.score ?? null },
    });
  });
}

/** "No, that is a different club." The row becomes something to create. */
export async function rejectMatch(principal: Principal, recordId: string): Promise<void> {
  assertCan(principal, 'update', { type: 'club' });

  await withOrg(principal.orgId, async (tx) => {
    const [record] = await tx
      .select({ id: importRecords.id })
      .from(importRecords)
      .where(eq(importRecords.id, recordId));
    if (!record) throw new NotFoundError('importRecord', recordId);

    await markRecord(tx, recordId, 'NEW', null, null, 'A person confirmed this is new.');

    await recordAudit(tx, principal, {
      action: 'import.rejectMatch',
      entityType: 'importRecord',
      entityId: recordId,
    });
  });
}

// --- promote -----------------------------------------------------------------

export interface PromoteOutcome {
  clubsCreated: number;
  teamsCreated: number;
  venuesCreated: number;
  entriesCreated: number;
  fixturesCreated: number;
  resultsCreated: number;
  honoursCreated: number;
  skipped: number;
  failed: number;
  blockedByReview: number;
  /** One line per row that could not be promoted, for the operator. */
  problems: string[];
}

const emptyOutcome = (): PromoteOutcome => ({
  clubsCreated: 0,
  teamsCreated: 0,
  venuesCreated: 0,
  entriesCreated: 0,
  fixturesCreated: 0,
  resultsCreated: 0,
  honoursCreated: 0,
  skipped: 0,
  failed: 0,
  blockedByReview: 0,
  problems: [],
});

/**
 * Write the accepted rows into the real tables.
 *
 * Refuses while anything still needs review, rather than promoting the settled
 * rows and leaving the rest — a half-promoted batch is the state in which
 * somebody re-runs the import and doubles the clubs.
 */
export async function promoteImport(
  principal: Principal,
  batchId: string,
): Promise<PromoteOutcome> {
  assertCan(principal, 'create', { type: 'club' });
  assertCan(principal, 'create', { type: 'team' });
  assertCan(principal, 'create', { type: 'venue' });

  return withOrg(principal.orgId, async (tx) => {
    const batch = await loadBatch(tx, batchId);
    if (batch.dryRun) {
      throw new ValidationError('That batch was staged as a dry run and cannot be promoted.');
    }
    if (batch.status === 'PROMOTED') {
      throw new ValidationError('That batch has already been promoted.');
    }

    const outstanding = await tx
      .select({ id: importRecords.id })
      .from(importRecords)
      .where(
        and(eq(importRecords.batchId, batchId), eq(importRecords.status, 'NEEDS_REVIEW')),
      );

    if (outstanding.length > 0) {
      return { ...emptyOutcome(), blockedByReview: outstanding.length };
    }

    const outcome = emptyOutcome();

    const records = await tx
      .select()
      .from(importRecords)
      .where(
        and(
          eq(importRecords.batchId, batchId),
          inArray(importRecords.status, ['NEW', 'MATCHED']),
        ),
      )
      // Clubs before teams, so a team can attach to the club it names.
      .orderBy(asc(sql`case ${importRecords.entityKind}
        when 'CLUB' then 1 when 'VENUE' then 2 when 'TEAM' then 3 else 4 end`));

    /** Source key → the real id it now denotes. */
    const resolvedByKey = new Map<string, string>();
    const takenSlugs = {
      CLUB: new Set((await tx.select({ slug: clubs.slug }).from(clubs)).map((r) => r.slug)),
      TEAM: new Set((await tx.select({ slug: teams.slug }).from(teams)).map((r) => r.slug)),
      VENUE: new Set((await tx.select({ slug: venues.slug }).from(venues)).map((r) => r.slug)),
    };

    for (const record of records) {
      const kind = record.entityKind as ImportEntityKind;

      if (record.status === 'MATCHED' && record.resolvedEntityId) {
        resolvedByKey.set(`${kind}:${record.sourceKey}`, record.resolvedEntityId);
        outcome.skipped++;
        await markRecord(tx, record.id, 'PROMOTED', record.resolvedEntityId, null, 'Already existed.');
        continue;
      }

      if (kind === 'CLUB') {
        const payload = record.payload as { name: string; shortName?: string; foundedYear?: number };
        const slug = uniqueSlug(payload.name, takenSlugs.CLUB);
        takenSlugs.CLUB.add(slug);
        const [created] = await tx
          .insert(clubs)
          .values({
            orgId: principal.orgId,
            name: payload.name,
            slug,
            shortName: payload.shortName ?? null,
            foundedYear: payload.foundedYear ?? null,
          })
          .returning({ id: clubs.id });
        if (!created) throw new Error('club insert returned no row');
        resolvedByKey.set(`CLUB:${record.sourceKey}`, created.id);
        await markRecord(tx, record.id, 'PROMOTED', created.id, null, 'Created.');
        outcome.clubsCreated++;
        continue;
      }

      if (kind === 'VENUE') {
        const payload = record.payload as {
          name: string;
          surface?: 'GRASS' | 'ARTIFICIAL_TURF' | 'INDOOR' | 'UNKNOWN';
          address?: string;
        };
        const slug = uniqueSlug(payload.name, takenSlugs.VENUE);
        takenSlugs.VENUE.add(slug);
        const [created] = await tx
          .insert(venues)
          .values({
            orgId: principal.orgId,
            name: payload.name,
            slug,
            surface: payload.surface ?? 'UNKNOWN',
            address: payload.address ?? null,
          })
          .returning({ id: venues.id });
        if (!created) throw new Error('venue insert returned no row');
        resolvedByKey.set(`VENUE:${record.sourceKey}`, created.id);
        await markRecord(tx, record.id, 'PROMOTED', created.id, null, 'Created.');
        outcome.venuesCreated++;
        continue;
      }

      if (kind === 'TEAM') {
        const payload = record.payload as {
          name: string;
          clubKey?: string;
          designation?: string;
        };
        const clubId = payload.clubKey
          ? resolvedByKey.get(`CLUB:${payload.clubKey}`)
          : undefined;

        if (!clubId) {
          await markRecord(
            tx,
            record.id,
            'FAILED',
            null,
            null,
            payload.clubKey
              ? `The club "${payload.clubKey}" was not imported, so this team has nothing to belong to.`
              : 'The row names no club.',
          );
          continue;
        }

        const slug = uniqueSlug(payload.name, takenSlugs.TEAM);
        takenSlugs.TEAM.add(slug);
        const [created] = await tx
          .insert(teams)
          .values({
            orgId: principal.orgId,
            clubId,
            name: payload.name,
            slug,
            designation: payload.designation ?? null,
          })
          .returning({ id: teams.id });
        if (!created) throw new Error('team insert returned no row');
        resolvedByKey.set(`TEAM:${record.sourceKey}`, created.id);
        await markRecord(tx, record.id, 'PROMOTED', created.id, null, 'Created.');
        outcome.teamsCreated++;
        continue;
      }

      // Fixtures, standings and honours are handled in the second pass below:
      // they carry no names of their own, so they can only be resolved once
      // every team in this batch has settled into a real id.
    }

    await promoteMatchRecords(tx, principal, batchId, resolvedByKey, outcome);
    await promoteHonourRecords(tx, principal, batchId, outcome);

    const promoted =
      outcome.clubsCreated +
      outcome.teamsCreated +
      outcome.venuesCreated +
      outcome.fixturesCreated +
      outcome.honoursCreated +
      outcome.skipped;

    await tx
      .update(importBatches)
      .set({
        status: 'PROMOTED',
        recordsPromoted: promoted,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(importBatches.id, batchId));

    await recordAudit(tx, principal, {
      action: 'import.promote',
      entityType: 'importBatch',
      entityId: batchId,
      after: outcome,
    });

    return outcome;
  });
}

/**
 * The second pass: fixtures, and the results attached to them.
 *
 * ── WHY COMPETITIONS ARE NOT CREATED FROM THE EXPORT ────────────────────────
 * A fixture names a competition and a group, and this refuses to invent either.
 * They must already exist, or the row fails with a message saying so.
 *
 * That is a deliberate limit, not an omission. The competition model here was
 * built from the sport — series, editions, stages, groups, entry sources — and
 * explicitly NOT from the old system's dropdown, which mixed divisions, cups
 * and the words "Promotion" and "Relegation" into one flat list. Auto-creating
 * competitions from a legacy dump would recreate that flat list one row at a
 * time, and it is exactly the mistake this schema was rebuilt to undo.
 *
 * Edition ENTRIES are created, because "this team played in this competition
 * that season" is the historical fact being imported rather than a modelling
 * decision somebody has to make.
 * ────────────────────────────────────────────────────────────────────────────
 */
async function promoteMatchRecords(
  tx: Tx,
  principal: Principal,
  batchId: string,
  resolvedByKey: Map<string, string>,
  outcome: PromoteOutcome,
): Promise<void> {
  const records = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.batchId, batchId),
        eq(importRecords.entityKind, 'FIXTURE'),
        inArray(importRecords.status, ['PENDING', 'NEW', 'MATCHED']),
      ),
    )
    .orderBy(asc(importRecords.sourceKey));

  if (records.length === 0) return;

  const timeZone = await getLeagueTimeZone(tx, principal.orgId);

  // --- what already exists ---------------------------------------------------
  const editionRows = await tx
    .select({
      id: competitionEditions.id,
      slug: competitionEditions.slug,
      nameOverride: competitionEditions.nameOverride,
      seriesName: competitionSeries.name,
      seriesSlug: competitionSeries.slug,
    })
    .from(competitionEditions)
    .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
    .where(isNull(competitionEditions.deletedAt));

  const editionsByKey = new Map<string, string>();
  for (const row of editionRows) {
    for (const key of [row.slug, row.seriesSlug, row.seriesName, row.nameOverride]) {
      if (key) editionsByKey.set(normalizeName(key), row.id);
    }
  }

  const groupRows = await tx
    .select({
      id: stageGroups.id,
      name: stageGroups.name,
      slug: stageGroups.slug,
      editionId: stages.editionId,
    })
    .from(stageGroups)
    .innerJoin(stages, eq(stageGroups.stageId, stages.id))
    .where(and(isNull(stageGroups.deletedAt), isNull(stages.deletedAt)));

  const groupsByKey = new Map<string, string>();
  /** An edition with exactly one group needs no group named in the file. */
  const groupCountByEdition = new Map<string, string[]>();
  for (const row of groupRows) {
    for (const key of [row.slug, row.name]) {
      groupsByKey.set(`${row.editionId}::${normalizeName(key)}`, row.id);
    }
    const list = groupCountByEdition.get(row.editionId) ?? [];
    list.push(row.id);
    groupCountByEdition.set(row.editionId, list);
  }

  const entryRows = await tx
    .select({
      id: editionEntries.id,
      editionId: editionEntries.editionId,
      teamId: editionEntries.teamId,
    })
    .from(editionEntries)
    .where(isNull(editionEntries.deletedAt));

  const entriesByEditionTeam = new Map(
    entryRows.map((row) => [`${row.editionId}::${row.teamId}`, row.id]),
  );

  const placements = new Set(
    (
      await tx
        .select({
          groupId: stageGroupEntries.stageGroupId,
          entryId: stageGroupEntries.editionEntryId,
        })
        .from(stageGroupEntries)
        .where(isNull(stageGroupEntries.deletedAt))
    ).map((row) => `${row.groupId}::${row.entryId}`),
  );

  const existingFixtures = new Set(
    (
      await tx
        .select({
          stageGroupId: fixtures.stageGroupId,
          homeEntryId: fixtures.homeEntryId,
          awayEntryId: fixtures.awayEntryId,
          leg: fixtures.leg,
        })
        .from(fixtures)
        .where(isNull(fixtures.deletedAt))
    ).map((row) => `${row.stageGroupId}|${row.homeEntryId}|${row.awayEntryId}|${row.leg}`),
  );

  const touchedGroups = new Set<string>();

  for (const record of records) {
    const payload = record.payload as LegacyFixture;

    const fail = async (message: string) => {
      await markRecord(tx, record.id, 'FAILED', null, null, message);
      outcome.failed++;
      outcome.problems.push(`${payload.key}: ${message}`);
    };

    const editionId = editionsByKey.get(normalizeName(payload.competitionKey));
    if (!editionId) {
      await fail(
        `No competition called "${payload.competitionKey}" exists. Create the competition first — ` +
          'this importer deliberately does not invent them.',
      );
      continue;
    }

    const groupsHere = groupCountByEdition.get(editionId) ?? [];
    const stageGroupId = payload.groupKey
      ? groupsByKey.get(`${editionId}::${normalizeName(payload.groupKey)}`)
      : groupsHere.length === 1
        ? groupsHere[0]
        : undefined;

    if (!stageGroupId) {
      await fail(
        payload.groupKey
          ? `"${payload.groupKey}" is not a group in that competition.`
          : 'That competition has more than one group, so the file must name which.',
      );
      continue;
    }

    const homeTeamId = resolvedByKey.get(`TEAM:${payload.homeTeamKey}`);
    const awayTeamId = resolvedByKey.get(`TEAM:${payload.awayTeamKey}`);
    if (!homeTeamId || !awayTeamId) {
      await fail(
        `The team "${!homeTeamId ? payload.homeTeamKey : payload.awayTeamKey}" is not in this batch, ` +
          'so the fixture has nobody to attach to.',
      );
      continue;
    }
    if (homeTeamId === awayTeamId) {
      await fail('A team cannot play itself.');
      continue;
    }

    // The historical fact: these two were entered in this competition.
    const placement = { editionId, stageGroupId, entriesByEditionTeam, placements };
    const homeEntryId = await ensureEntry(tx, principal, placement, homeTeamId, outcome);
    const awayEntryId = await ensureEntry(tx, principal, placement, awayTeamId, outcome);

    const pairing = `${stageGroupId}|${homeEntryId}|${awayEntryId}|${1}`;
    if (existingFixtures.has(pairing)) {
      await markRecord(tx, record.id, 'SKIPPED', null, null, 'Already scheduled.');
      outcome.skipped++;
      continue;
    }
    existingFixtures.add(pairing);

    let kickoffAt: Date | null = null;
    if (payload.date && payload.time) {
      try {
        kickoffAt = zonedWallTimeToInstant(`${payload.date}T${normalizeTime(payload.time)}`, timeZone);
      } catch (error) {
        await fail(
          error instanceof Error ? error.message : `"${payload.date} ${payload.time}" is not a valid time.`,
        );
        continue;
      }
    }

    const [created] = await tx
      .insert(fixtures)
      .values({
        orgId: principal.orgId,
        stageGroupId,
        homeEntryId,
        awayEntryId,
        venueId: payload.venueKey ? (resolvedByKey.get(`VENUE:${payload.venueKey}`) ?? null) : null,
        kickoffAt,
        round: payload.round ?? null,
        matchday: payload.matchday ?? null,
        status: payload.status ?? (hasScore(payload) ? 'PLAYED' : 'SCHEDULED'),
      })
      .returning({ id: fixtures.id });

    if (!created) throw new Error('fixture insert returned no row');

    await tx.insert(fixtureChanges).values({
      orgId: principal.orgId,
      fixtureId: created.id,
      kind: 'SCHEDULED',
      newKickoffAt: kickoffAt,
      newStatus: 'SCHEDULED',
      reason: `Imported from ${record.sourceKey}.`,
      changedByPersonId: principal.personId,
    });

    outcome.fixturesCreated++;
    touchedGroups.add(stageGroupId);

    if (hasScore(payload)) {
      /**
       * Source IMPORT, which the resolver ranks BELOW every human source. A
       * scraped or migrated score has no author who can be asked about it, so
       * a club contradicting it later deserves to be surfaced rather than
       * silently overruled by a historical file.
       */
      await tx.insert(resultSubmissions).values({
        orgId: principal.orgId,
        fixtureId: created.id,
        source: 'IMPORT',
        homeScore: payload.homeScore ?? null,
        awayScore: payload.awayScore ?? null,
        homeForfeit: payload.homeForfeit ?? false,
        awayForfeit: payload.awayForfeit ?? false,
        reason: `Imported from ${record.sourceKey}.`,
      });
      outcome.resultsCreated++;
    }

    await markRecord(tx, record.id, 'PROMOTED', created.id, null, 'Created.');
  }

  // Tables for everything this batch touched, so the recompute-and-diff
  // acceptance test can run immediately rather than after a manual step.
  for (const groupId of touchedGroups) {
    await recomputeStandingsWithin(tx, principal.orgId, groupId);
  }
}

interface EntryPlacement {
  editionId: string;
  stageGroupId: string;
  entriesByEditionTeam: Map<string, string>;
  placements: Set<string>;
}

/**
 * "This team was in this competition, in this section."
 *
 * Both rows matter, and for different reasons: `edition_entries` is what a
 * fixture points at, and `stage_group_entries` is what the standings engine
 * reads to decide who belongs in a table. Creating the first without the
 * second produces an imported season whose results exist and whose table is
 * empty — a failure that looks like a bug in the standings engine.
 */
async function ensureEntry(
  tx: Tx,
  principal: Principal,
  placement: EntryPlacement,
  teamId: string,
  outcome: PromoteOutcome,
): Promise<string> {
  const { editionId, stageGroupId, entriesByEditionTeam, placements } = placement;
  let entryId = entriesByEditionTeam.get(`${editionId}::${teamId}`);

  if (!entryId) {
    const [entry] = await tx
      .insert(editionEntries)
      .values({ orgId: principal.orgId, editionId, teamId, status: 'ACTIVE' })
      .returning({ id: editionEntries.id });
    if (!entry) throw new Error('edition entry insert returned no row');
    entryId = entry.id;
    entriesByEditionTeam.set(`${editionId}::${teamId}`, entryId);
    outcome.entriesCreated++;
  }

  if (!placements.has(`${stageGroupId}::${entryId}`)) {
    await tx.insert(stageGroupEntries).values({
      orgId: principal.orgId,
      stageGroupId,
      editionEntryId: entryId,
    });
    placements.add(`${stageGroupId}::${entryId}`);
  }

  return entryId;
}

const hasScore = (payload: LegacyFixture): boolean =>
  (payload.homeScore !== null && payload.homeScore !== undefined) ||
  (payload.awayScore !== null && payload.awayScore !== undefined) ||
  payload.homeForfeit === true ||
  payload.awayForfeit === true;

/** Accepts "14:00", "14:00:00" and "2:05". */
function normalizeTime(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim());
  if (!match) return raw;
  const [, h, m, s] = match;
  return `${String(h).padStart(2, '0')}:${m}${s ? `:${s}` : ''}`;
}

/**
 * Trophies, and who won them.
 *
 * The archive is not optional colour — it is what gives a league's site its
 * authority, and it is the reason honours are entities with a lineage rather
 * than a text label on a division. An award whose recipient no longer resolves
 * to a team keeps the name as it was published, which is the only honest thing
 * to do with a club that folded in 1987.
 */
async function promoteHonourRecords(
  tx: Tx,
  principal: Principal,
  batchId: string,
  outcome: PromoteOutcome,
): Promise<void> {
  const records = await tx
    .select()
    .from(importRecords)
    .where(
      and(
        eq(importRecords.batchId, batchId),
        eq(importRecords.entityKind, 'HONOUR_AWARD'),
        inArray(importRecords.status, ['PENDING', 'NEW', 'MATCHED']),
      ),
    )
    .orderBy(asc(importRecords.sourceKey));

  if (records.length === 0) return;

  const existing = await tx
    .select({ id: honours.id, name: honours.name, slug: honours.slug })
    .from(honours)
    .where(isNull(honours.deletedAt));

  const honoursByName = new Map(existing.map((row) => [normalizeName(row.name), row.id]));
  const takenSlugs = new Set(existing.map((row) => row.slug));

  for (const record of records) {
    const payload = record.payload as LegacyHonour;

    let honourId = honoursByName.get(normalizeName(payload.honourName));
    if (!honourId) {
      const slug = uniqueSlug(payload.honourName, takenSlugs);
      takenSlugs.add(slug);
      const [created] = await tx
        .insert(honours)
        .values({
          orgId: principal.orgId,
          name: payload.honourName,
          slug,
          // A value on the award means a countable achievement — a Golden Boot
          // rather than a championship — so it belongs to a person.
          recipientKind: payload.value !== undefined ? 'PERSON' : 'TEAM',
        })
        .returning({ id: honours.id });
      if (!created) throw new Error('honour insert returned no row');
      honourId = created.id;
      honoursByName.set(normalizeName(payload.honourName), honourId);
    }

    await tx.insert(honourAwards).values({
      orgId: principal.orgId,
      honourId,
      recipientNameSnapshot: payload.recipientName,
      value: payload.value ?? null,
      awardedOn: payload.awardedOn ?? null,
    });

    await markRecord(tx, record.id, 'PROMOTED', honourId, null, 'Recorded.');
    outcome.honoursCreated++;
  }
}

/** Throw a batch away, so its digest can be staged again. */
export async function discardBatch(principal: Principal, batchId: string): Promise<void> {
  assertCan(principal, 'delete', { type: 'club' });

  await withOrg(principal.orgId, async (tx) => {
    const batch = await loadBatch(tx, batchId);
    if (batch.status === 'PROMOTED') {
      throw new ValidationError(
        'That batch has been promoted. Discarding it would not undo what it wrote.',
      );
    }

    const now = new Date();
    await tx
      .update(importBatches)
      .set({ status: 'DISCARDED', deletedAt: now, updatedAt: now })
      .where(eq(importBatches.id, batchId));

    await recordAudit(tx, principal, {
      action: 'import.discard',
      entityType: 'importBatch',
      entityId: batchId,
    });
  });
}

export async function getBatch(orgId: OrgId, batchId: string): Promise<BatchSummary> {
  return withOrg(orgId, async (tx) => summarize(await loadBatch(tx, batchId)));
}

/** Every batch this league has staged, newest first. */
export async function listBatches(orgId: OrgId): Promise<(BatchSummary & { startedAt: Date })[]> {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(importBatches)
      .where(isNull(importBatches.deletedAt))
      .orderBy(desc(importBatches.startedAt));
    return rows.map((row) => ({ ...summarize(row), startedAt: row.startedAt }));
  });
}

export interface StandingsCheck {
  competitionKey: string;
  groupKey: string | null;
  resolved: boolean;
  matches: boolean;
  summary: string[];
  hints: string[];
}

/**
 * THE ACCEPTANCE TEST for the whole historical import.
 *
 * Recompute each imported season's table from the imported results, and diff it
 * against the table the source itself published. That single comparison
 * validates three things at once:
 *
 *   - the importer, because wrong results give wrong tables
 *   - the schema, because a result that will not fit is a result that is missing
 *   - the standings engine, because the tiebreakers must reach the same
 *     conclusion the league actually reached
 *
 * Where they disagree, one of those three is wrong and you have a precise,
 * bounded thing to investigate — instead of the vague "seems about right" that
 * most data migrations ship on. `interpretDiff` then names the likely culprit
 * from the SHAPE of the disagreement, which is most of the work.
 */
export async function checkImportedStandings(
  orgId: OrgId,
  batchId: string,
): Promise<StandingsCheck[]> {
  return withOrg(orgId, async (tx) => {
    const staged = await tx
      .select({ payload: importRecords.payload })
      .from(importRecords)
      .where(
        and(eq(importRecords.batchId, batchId), eq(importRecords.entityKind, 'STANDING')),
      );

    if (staged.length === 0) return [];

    const editionRows = await tx
      .select({
        id: competitionEditions.id,
        slug: competitionEditions.slug,
        nameOverride: competitionEditions.nameOverride,
        seriesName: competitionSeries.name,
        seriesSlug: competitionSeries.slug,
      })
      .from(competitionEditions)
      .innerJoin(competitionSeries, eq(competitionEditions.seriesId, competitionSeries.id))
      .where(isNull(competitionEditions.deletedAt));

    const editionsByKey = new Map<string, string>();
    for (const row of editionRows) {
      for (const key of [row.slug, row.seriesSlug, row.seriesName, row.nameOverride]) {
        if (key) editionsByKey.set(normalizeName(key), row.id);
      }
    }

    // Confirmed aliases map the source's spelling to ours. Without this every
    // renamed club reads as a mismatch and buries the real findings.
    const aliases = await loadConfirmedAliases(tx);
    const teamNames = new Map(
      (
        await tx
          .select({ id: teams.id, name: teams.name })
          .from(teams)
          .where(isNull(teams.deletedAt))
      ).map((row) => [row.id, row.name]),
    );

    const resolveName = (published: string): string => {
      const canonicalId = aliases.get(`TEAM:${normalizeName(published)}`);
      return (canonicalId && teamNames.get(canonicalId)) ?? published;
    };

    const checks: StandingsCheck[] = [];

    for (const row of staged) {
      const payload = row.payload as LegacyStanding;
      const editionId = editionsByKey.get(normalizeName(payload.competitionKey));

      if (!editionId) {
        checks.push({
          competitionKey: payload.competitionKey,
          groupKey: payload.groupKey ?? null,
          resolved: false,
          matches: false,
          summary: [`No competition called "${payload.competitionKey}" exists here.`],
          hints: ['The published table cannot be compared until its competition is created.'],
        });
        continue;
      }

      const tables = await tx
        .select({ id: stageGroups.id, name: stageGroups.name, slug: stageGroups.slug })
        .from(stageGroups)
        .innerJoin(stages, eq(stageGroups.stageId, stages.id))
        .where(
          and(
            eq(stages.editionId, editionId),
            isNull(stageGroups.deletedAt),
            isNull(stages.deletedAt),
          ),
        );

      const group = payload.groupKey
        ? tables.find(
            (t) =>
              normalizeName(t.slug) === normalizeName(payload.groupKey as string) ||
              normalizeName(t.name) === normalizeName(payload.groupKey as string),
          )
        : tables[0];

      if (!group) {
        checks.push({
          competitionKey: payload.competitionKey,
          groupKey: payload.groupKey ?? null,
          resolved: false,
          matches: false,
          summary: [`No group "${payload.groupKey}" in that competition.`],
          hints: [],
        });
        continue;
      }

      const computed = await selectComputedRows(tx, group.id);
      const diff = diffStandings(computed, payload.rows, resolveName);

      checks.push({
        competitionKey: payload.competitionKey,
        groupKey: payload.groupKey ?? null,
        resolved: true,
        matches: diff.matches,
        summary: diff.summary,
        hints: interpretDiff(diff),
      });
    }

    return checks;
  });
}

/** The most recent computed table for a group, in the diff's shape. */
async function selectComputedRows(tx: Tx, stageGroupId: string): Promise<ComputedRow[]> {
  const [snapshot] = await tx
    .select({ id: standingsSnapshots.id })
    .from(standingsSnapshots)
    .where(
      and(
        eq(standingsSnapshots.stageGroupId, stageGroupId),
        isNull(standingsSnapshots.deletedAt),
      ),
    )
    .orderBy(desc(standingsSnapshots.computedAt), desc(standingsSnapshots.id))
    .limit(1);

  if (!snapshot) return [];

  const rows = await tx
    .select({
      entryId: standingsRows.editionEntryId,
      teamName: teams.name,
      position: standingsRows.position,
      played: standingsRows.played,
      won: standingsRows.won,
      drawn: standingsRows.drawn,
      lost: standingsRows.lost,
      goalsFor: standingsRows.goalsFor,
      goalsAgainst: standingsRows.goalsAgainst,
      points: standingsRows.points,
    })
    .from(standingsRows)
    .innerJoin(editionEntries, eq(standingsRows.editionEntryId, editionEntries.id))
    .innerJoin(teams, eq(editionEntries.teamId, teams.id))
    .where(eq(standingsRows.snapshotId, snapshot.id))
    .orderBy(asc(standingsRows.position));

  return rows;
}

/** The source's own final tables, for the recompute-and-diff acceptance test. */
export async function listStagedStandings(orgId: OrgId, batchId: string) {
  return withOrg(orgId, async (tx) => {
    const rows = await tx
      .select({ sourceKey: importRecords.sourceKey, payload: importRecords.payload })
      .from(importRecords)
      .where(
        and(eq(importRecords.batchId, batchId), eq(importRecords.entityKind, 'STANDING')),
      );
    return rows;
  });
}

// --- internals ---------------------------------------------------------------

async function loadBatch(tx: Tx, batchId: string) {
  const [batch] = await tx
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, batchId));
  if (!batch) throw new NotFoundError('importBatch', batchId);
  return batch;
}

const summarize = (batch: Awaited<ReturnType<typeof loadBatch>>): BatchSummary => ({
  batchId: batch.id,
  status: batch.status,
  source: batch.source,
  dryRun: batch.dryRun,
  recordsTotal: batch.recordsTotal,
  recordsMatched: batch.recordsMatched,
  recordsNeedingReview: batch.recordsNeedingReview,
  recordsPromoted: batch.recordsPromoted,
  recordsFailed: batch.recordsFailed,
});

async function markRecord(
  tx: Tx,
  recordId: string,
  status: 'PENDING' | 'MATCHED' | 'NEW' | 'NEEDS_REVIEW' | 'PROMOTED' | 'SKIPPED' | 'FAILED',
  resolvedEntityId: string | null,
  candidates: Candidate[] | null,
  message: string | null,
): Promise<void> {
  await tx
    .update(importRecords)
    .set({ status, resolvedEntityId, candidates, message, updatedAt: new Date() })
    .where(eq(importRecords.id, recordId));
}

async function loadKnown(
  tx: Tx,
  kind: 'CLUB' | 'TEAM' | 'VENUE',
): Promise<{ id: string; name: string }[]> {
  if (kind === 'CLUB') {
    return tx.select({ id: clubs.id, name: clubs.name }).from(clubs).where(isNull(clubs.deletedAt));
  }
  if (kind === 'TEAM') {
    return tx.select({ id: teams.id, name: teams.name }).from(teams).where(isNull(teams.deletedAt));
  }
  return tx.select({ id: venues.id, name: venues.name }).from(venues).where(isNull(venues.deletedAt));
}

/** Confirmed aliases only, keyed `KIND:normalized`. */
async function loadConfirmedAliases(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx
    .select({
      entityKind: entityAliases.entityKind,
      normalizedAlias: entityAliases.normalizedAlias,
      canonicalId: entityAliases.canonicalId,
    })
    .from(entityAliases)
    .where(and(isNull(entityAliases.deletedAt), sql`${entityAliases.confirmedAt} IS NOT NULL`));

  return new Map(rows.map((r) => [`${r.entityKind}:${r.normalizedAlias}`, r.canonicalId]));
}

function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

export { matchingKey, slugify };
