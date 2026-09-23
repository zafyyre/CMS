import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared';
import { competitionRules, stageGroups } from './competition';
import { editionEntries } from './participation';
import { organizations } from './tenancy';

/**
 * STANDINGS — a conclusion, stored.
 *
 * Everything here is derived from facts elsewhere: result submissions, match
 * events, and the points adjustments a disciplinary hearing imposed. Nothing in
 * these tables is ever hand-edited, and there is deliberately no way for a
 * human to type a points total. When somebody must intervene, they change an
 * INPUT — a points adjustment on the entry, or a corrected result submission —
 * and the table is recomputed. That is the difference between a table you can
 * defend and a page somebody maintains by hand, which is what the old system is.
 *
 * So why store it at all, rather than compute it in a view?
 *
 *   1. **The reasoning has to survive.** "2nd, ahead of Glenmore on head-to-head"
 *      is the answer to the email a coach sends on Monday morning. Recomputing
 *      it under pressure, from data that may since have changed, is how you end
 *      up giving a different answer the second time.
 *   2. **The table as at a date is a real question.** Snapshots are inserted,
 *      never updated, so "what did the table look like in week seven" is a query
 *      rather than an archaeology project.
 *   3. Standings are read on phones at the side of a pitch on a Sunday evening,
 *      all at once. Reading ten rows beats deriving them from nine hundred.
 */

/**
 * One computation of one group's table.
 *
 * A new row per recompute; the current table is simply the most recent. There
 * is no `isCurrent` flag, because maintaining one means an UPDATE that can fail
 * halfway and leave two rows both claiming to be current.
 */
export const standingsSnapshots = pgTable(
  'standings_snapshots',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stageGroupId: uuid('stage_group_id').notNull(),
    /** Which rules produced this table. Null only for imported history. */
    rulesId: uuid('rules_id'),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * The most recent result submission this table accounts for.
     *
     * Lets a reader tell a stale table from a current one without re-deriving
     * it, which matters on a match night when results arrive over three hours.
     */
    resultsThrough: timestamp('results_through', { withTimezone: true }),

    fixturesCounted: integer('fixtures_counted').notNull().default(0),
    /** Played but not yet resolved — a disputed result blocks its own fixture. */
    fixturesDisputed: integer('fixtures_disputed').notNull().default(0),
    fixturesOutstanding: integer('fixtures_outstanding').notNull().default(0),

    /**
     * True when at least one placing could not be decided by the rules and
     * needs a human — a drawing of lots. The table is still ordered, because an
     * unordered table is useless, but it says so.
     */
    requiresManualResolution: boolean('requires_manual_resolution').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    unique('standings_snapshots_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.stageGroupId],
      foreignColumns: [stageGroups.orgId, stageGroups.id],
      name: 'standings_snapshots_group_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.rulesId],
      foreignColumns: [competitionRules.orgId, competitionRules.id],
      name: 'standings_snapshots_rules_fk',
    }),
    // The read path: newest snapshot for this group.
    index('standings_snapshots_group_computed_idx').on(t.stageGroupId, t.computedAt),
  ],
);

/**
 * One team's line in one computed table.
 *
 * `basis` is the column that justifies this whole design. It holds the sentence
 * shown next to the position — "level on 34 points, ahead on head-to-head" —
 * written at the moment the ordering was decided, by the code that decided it.
 */
export const standingsRows = pgTable(
  'standings_rows',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    snapshotId: uuid('snapshot_id').notNull(),
    editionEntryId: uuid('edition_entry_id').notNull(),

    position: integer('position').notNull(),
    played: integer('played').notNull().default(0),
    won: integer('won').notNull().default(0),
    drawn: integer('drawn').notNull().default(0),
    lost: integer('lost').notNull().default(0),
    goalsFor: integer('goals_for').notNull().default(0),
    goalsAgainst: integer('goals_against').notNull().default(0),
    goalDifference: integer('goal_difference').notNull().default(0),

    /** Points from results only. The adjustment is kept separate on purpose. */
    pointsEarned: integer('points_earned').notNull().default(0),
    /**
     * Deductions imposed by a hearing, copied from the entry at compute time.
     *
     * Separate from `pointsEarned` so the table can show "34 (−3)" rather than
     * 31 with no explanation — which is the version that generates a fortnight
     * of email.
     */
    pointsAdjustment: integer('points_adjustment').notNull().default(0),
    points: integer('points').notNull().default(0),

    disciplinePoints: integer('discipline_points').notNull().default(0),
    /** Most recent last: ['W','W','D','L','W']. */
    form: text('form').array().notNull().default(sql`ARRAY[]::text[]`),

    /** The sentence shown beside the position. Written when it was decided. */
    basis: text('basis').notNull(),
    /** This placing is provisional pending a drawing of lots. */
    requiresManualResolution: boolean('requires_manual_resolution').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.snapshotId],
      foreignColumns: [standingsSnapshots.orgId, standingsSnapshots.id],
      name: 'standings_rows_snapshot_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.editionEntryId],
      foreignColumns: [editionEntries.orgId, editionEntries.id],
      name: 'standings_rows_entry_fk',
    }).onDelete('cascade'),
    unique('standings_rows_snapshot_entry_unique').on(t.snapshotId, t.editionEntryId),
    index('standings_rows_snapshot_position_idx').on(t.snapshotId, t.position),
    check('standings_rows_position_positive', sql`position >= 1`),
    check(
      'standings_rows_counts_consistent',
      sql`played = won + drawn + lost
          AND won >= 0 AND drawn >= 0 AND lost >= 0
          AND goals_for >= 0 AND goals_against >= 0
          AND goal_difference = goals_for - goals_against
          AND points = points_earned + points_adjustment`,
    ),
  ],
);

// --- relations ---------------------------------------------------------------

export const standingsSnapshotsRelations = relations(standingsSnapshots, ({ one, many }) => ({
  stageGroup: one(stageGroups, {
    fields: [standingsSnapshots.stageGroupId],
    references: [stageGroups.id],
  }),
  rules: one(competitionRules, {
    fields: [standingsSnapshots.rulesId],
    references: [competitionRules.id],
  }),
  rows: many(standingsRows),
}));

export const standingsRowsRelations = relations(standingsRows, ({ one }) => ({
  snapshot: one(standingsSnapshots, {
    fields: [standingsRows.snapshotId],
    references: [standingsSnapshots.id],
  }),
  entry: one(editionEntries, {
    fields: [standingsRows.editionEntryId],
    references: [editionEntries.id],
  }),
}));
