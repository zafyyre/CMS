import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { liveUnique, primaryId, timestamps } from './_shared';
import {
  importEntityKindEnum,
  importRecordStatusEnum,
  importSourceKindEnum,
  importStatusEnum,
} from './enums';
import { persons } from './identity';
import { organizations } from './tenancy';

/**
 * HISTORICAL IMPORT — staging, and the entity resolution that is the real work.
 *
 * Twelve seasons of a league's records are not a parsing problem. Parsing is an
 * afternoon. The work is that across twelve seasons teams rename, clubs merge
 * and split, and the same club appears under three spellings — "Croatia SC",
 * "NK Croatia" and "Croatia Sports Club" — with nothing in the data to say they
 * are the same thing, and nothing to say that "United" in 2014 and "United" in
 * 2021 are NOT.
 *
 * So this schema is built around one rule: **the machine proposes, a human
 * disposes.** A fuzzy match is a candidate with a score, never a decision. Once
 * a person confirms it, the alias is remembered and the next eleven seasons
 * resolve automatically. Getting this wrong silently merges two clubs' histories
 * — which is not a bug you can find later, because the evidence that they were
 * separate is exactly what got destroyed.
 *
 * Nothing here writes to the real tables. `import_records` is a staging area;
 * promotion is a separate, explicit step over rows a human has accepted.
 */

/**
 * One run of an import.
 *
 * `sourceDigest` is a hash of the input file. Re-running a batch whose digest
 * already promoted is refused — which is what makes the loader safe to run
 * repeatedly, and repeated runs are the normal case when a twelve-season import
 * is being debugged.
 */
export const importBatches = pgTable(
  'import_batches',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The file or endpoint it came from, for the operator's benefit. */
    source: text('source').notNull(),
    sourceKind: importSourceKindEnum('source_kind').notNull(),
    /** SHA-256 of the input. Identical input, identical digest. */
    sourceDigest: text('source_digest').notNull(),
    status: importStatusEnum('status').notNull().default('STAGED'),
    /** A dry run stages and resolves but never promotes. */
    dryRun: boolean('dry_run').notNull().default(false),

    recordsTotal: integer('records_total').notNull().default(0),
    recordsMatched: integer('records_matched').notNull().default(0),
    recordsNeedingReview: integer('records_needing_review').notNull().default(0),
    recordsPromoted: integer('records_promoted').notNull().default(0),
    recordsFailed: integer('records_failed').notNull().default(0),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    unique('import_batches_org_id_key').on(t.orgId, t.id),
    index('import_batches_org_status_idx').on(t.orgId, t.status),
    // A digest may be re-staged after a failure, but only one live batch per
    // digest, so an accidental double-upload is caught rather than doubled.
    liveUnique('import_batches_digest_unique', t.orgId, t.sourceDigest),
  ],
);

/**
 * One row of source data, parked.
 *
 * `payload` is the source's own shape, kept verbatim. Transforming on the way
 * in would mean a mapping bug is only discoverable by re-fetching the original
 * file, which for a scrape may no longer exist.
 */
export const importRecords = pgTable(
  'import_records',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    batchId: uuid('batch_id').notNull(),
    entityKind: importEntityKindEnum('entity_kind').notNull(),
    /** The source system's own identifier, or a natural key we derived. */
    sourceKey: text('source_key').notNull(),
    payload: jsonb('payload').notNull(),

    status: importRecordStatusEnum('status').notNull().default('PENDING'),
    /** What it resolved to, once it has. */
    resolvedEntityId: uuid('resolved_entity_id'),
    /** Candidates and scores, when a human has to choose. */
    candidates: jsonb('candidates'),
    /** Why it is where it is. Shown in the review queue. */
    message: text('message'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.batchId],
      foreignColumns: [importBatches.orgId, importBatches.id],
      name: 'import_records_batch_fk',
    }).onDelete('cascade'),
    // Idempotency within a batch: staging the same file twice cannot produce
    // two rows for one source entity.
    unique('import_records_batch_key_unique').on(t.batchId, t.entityKind, t.sourceKey),
    index('import_records_batch_status_idx').on(t.batchId, t.status),
    index('import_records_kind_idx').on(t.orgId, t.entityKind),
  ],
);

/**
 * "This name, in the source, means this entity here."
 *
 * The table that makes the second, third and twelfth seasons cheap. A
 * confirmed alias short-circuits the whole fuzzy-matching apparatus, which is
 * why `confirmedAt` is the column everything keys off: an unconfirmed row is a
 * PROPOSAL and is never used to resolve anything automatically.
 */
export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    entityKind: importEntityKindEnum('entity_kind').notNull(),
    /** As the source spells it, verbatim. */
    alias: text('alias').notNull(),
    /** Lower-cased, unaccented, punctuation stripped. What matching compares. */
    normalizedAlias: text('normalized_alias').notNull(),
    /** The club, team, person or venue it means. */
    canonicalId: uuid('canonical_id').notNull(),
    /** Trigram similarity at the time it was proposed. Null if entered by hand. */
    confidence: real('confidence'),

    /**
     * Null until a human confirms. Nothing resolves automatically against an
     * unconfirmed alias — that is the entire safety property of this table.
     */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedByPersonId: uuid('confirmed_by_person_id'),
    /** Which batch proposed it, for auditing a bad merge afterwards. */
    proposedByBatchId: uuid('proposed_by_batch_id'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.confirmedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'entity_aliases_confirmed_by_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.proposedByBatchId],
      foreignColumns: [importBatches.orgId, importBatches.id],
      name: 'entity_aliases_batch_fk',
    }),
    // One meaning per spelling per kind. A spelling that turns out to be
    // ambiguous is a data problem a human has to resolve, not something to
    // paper over with two rows.
    liveUnique('entity_aliases_unique', t.orgId, t.entityKind, t.normalizedAlias),
    index('entity_aliases_canonical_idx').on(t.canonicalId),
    // Trigram index, so proposing candidates for an unknown name is a lookup
    // rather than a scan of every alias the league has ever recorded.
    index('entity_aliases_trgm_idx').using(
      'gin',
      sql`${t.normalizedAlias} gin_trgm_ops`,
    ),
    check('entity_aliases_confidence_range', sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`),
  ],
);

// --- relations ---------------------------------------------------------------

export const importBatchesRelations = relations(importBatches, ({ many }) => ({
  records: many(importRecords),
}));

export const importRecordsRelations = relations(importRecords, ({ one }) => ({
  batch: one(importBatches, {
    fields: [importRecords.batchId],
    references: [importBatches.id],
  }),
}));
