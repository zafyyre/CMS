import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { liveUnique, primaryId, timestamps } from './_shared';
import {
  editionStatusEnum,
  entrySourceKindEnum,
  honourRecipientKindEnum,
  progressionKindEnum,
  seasonStatusEnum,
  stageFormatEnum,
  tieBreakerEnum,
  tieBreakMethodEnum,
} from './enums';
import { organizations } from './tenancy';

/**
 * THE COMPETITION MODEL
 *
 * The organising idea, and the thing that makes this not a copy of the old
 * site:
 *
 *   A competition is not a *kind*. It is a perpetual named line — a SERIES —
 *   that runs one EDITION per season. Each edition is an ordered pipeline of
 *   STAGES. Each stage holds one or more GROUPS. Each group's places are filled
 *   by declarative ENTRY SOURCES.
 *
 * A round-robin division, a division split into parallel sections, a cup with a
 * group phase feeding a bracket, a two-legged tie, a bye, a plate competition
 * fed by first-round losers, and a promotion play-off are all *configurations*
 * of that one structure. So there is no enum listing them, and the old site's
 * flat thirty-item dropdown — which mixed divisions, cups, trophies and the
 * words "Promotion" and "Relegation" together — has no way to reappear.
 *
 * `org_id` is repeated on every table even where it could be derived through a
 * join. That denormalisation is deliberate: it makes the security policy one
 * identical single-column comparison everywhere, rather than a join the
 * database must re-evaluate per row. A subtly wrong join in a security policy
 * is a silent data leak; a wrong column comparison is not expressible.
 */

// ---------------------------------------------------------------------------
// External bodies
// ---------------------------------------------------------------------------

/**
 * Organisations whose competitions and rules constrain us but which we do not
 * operate — BC Soccer, Canada Soccer.
 *
 * The old site listed "Provincials" in its division dropdown as though the
 * league ran it. It does not; BC Soccer does. Naming the operator lets us
 * record our teams' participation and honours in externally-run competitions
 * without pretending to own their fixtures.
 */
export const governingBodies = pgTable(
  'governing_bodies',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    level: text('level'), // national | provincial | regional | district
    parentBodyId: uuid('parent_body_id'),
    ...timestamps,
  },
  (t) => [
    unique('governing_bodies_org_id_key').on(t.orgId, t.id),
    liveUnique('governing_bodies_org_slug_unique', t.orgId, t.slug),
  ],
);

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * The affiliation year: the scope within which a person is registered, fees are
 * levied, and credentials must be valid.
 *
 * On the old site "Registration Year" is only a filter widget. Here it is the
 * actual unit of registration, which is why a player registered for 2025-26 is
 * eligible in both the autumn and spring campaigns without registering twice.
 */
export const registrationYears = pgTable(
  'registration_years',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    label: text('label').notNull(), // "2025-26"
    slug: text('slug').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    registrationOpensOn: date('registration_opens_on'),
    registrationClosesOn: date('registration_closes_on'),
    ...timestamps,
  },
  (t) => [
    unique('registration_years_org_id_key').on(t.orgId, t.id),
    liveUnique('registration_years_org_slug_unique', t.orgId, t.slug),
  ],
);

/**
 * A playing campaign inside a registration year — autumn/winter, or spring.
 *
 * This replaces the copied `FALL_WINTER | SPRING | YOUTH` enum. Those were
 * values from a dropdown; autumn and spring are two sibling *rows* in one
 * registration year, and "Youth" was never a season at all — it is an age band,
 * an orthogonal axis now carried by ladders and eligibility profiles.
 *
 * The `status` lifecycle is what lets the interface say "here is what matters
 * now" instead of presenting the user with four filters.
 */
export const seasons = pgTable(
  'seasons',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    registrationYearId: uuid('registration_year_id').notNull(),
    name: text('name').notNull(), // "Autumn/Winter 2025-26"
    slug: text('slug').notNull(),
    ordinalInYear: integer('ordinal_in_year').notNull().default(1),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    /** After this date squads freeze. */
    rosterLockOn: date('roster_lock_on'),
    status: seasonStatusEnum('status').notNull().default('PLANNED'),
    ...timestamps,
  },
  (t) => [
    unique('seasons_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.registrationYearId],
      foreignColumns: [registrationYears.orgId, registrationYears.id],
      name: 'seasons_registration_year_fk',
    }).onDelete('cascade'),
    liveUnique('seasons_org_slug_unique', t.orgId, t.slug),
    index('seasons_org_status_idx').on(t.orgId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Rules — versioned, and frozen once published
// ---------------------------------------------------------------------------

/**
 * How a table is decided: what a win is worth, and what happens when two teams
 * finish level.
 *
 * This is the highest-consequence configuration in the product. A wrong
 * tiebreaker order does not throw an error — it puts the wrong team in the
 * play-offs, in public, and nobody notices until a coach does the arithmetic
 * by hand. So it is DATA, versioned, and attached to a competition rather than
 * written into a query where nobody can find it or diff it.
 *
 * ── FROZEN ONCE PUBLISHED ───────────────────────────────────────────────────
 * `publishedAt` is not decoration. The rules a season was played under are part
 * of that season's record: changing next year's points-for-a-win must not
 * silently rewrite 2019's final table. So once `publishedAt` is set the row
 * becomes immutable — and that is enforced by a row-level security policy whose
 * USING clause excludes published rows, not by a service remembering to check.
 * A new season that wants different rules gets a NEW row.
 *
 * Editing a published row is therefore not "discouraged"; it matches zero rows.
 * See src/db/policies.ts.
 * ────────────────────────────────────────────────────────────────────────────
 */
export const competitionRules = pgTable(
  'competition_rules',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // "League — three points for a win"
    slug: text('slug').notNull(),

    pointsForWin: integer('points_for_win').notNull().default(3),
    pointsForDraw: integer('points_for_draw').notNull().default(1),
    pointsForLoss: integer('points_for_loss').notNull().default(0),

    /**
     * Applied in array order after points. Postgres keeps the order, which is
     * the entire reason this is an array and not a set of boolean columns.
     */
    tieBreakers: tieBreakerEnum('tie_breakers')
      .array()
      .notNull()
      .default(['GOAL_DIFFERENCE', 'GOALS_FOR', 'HEAD_TO_HEAD_POINTS', 'WINS']),

    /** The scoreline awarded when a team fails to appear. Commonly 3–0. */
    forfeitWinnerGoals: integer('forfeit_winner_goals').notNull().default(3),
    forfeitLoserGoals: integer('forfeit_loser_goals').notNull().default(0),
    /** Whether a forfeited match counts in the played column. Usually yes. */
    forfeitCountsAsPlayed: boolean('forfeit_counts_as_played').notNull().default(true),

    /** Weights for the DISCIPLINE_POINTS tiebreaker, where a league uses it. */
    yellowCardPoints: integer('yellow_card_points').notNull().default(1),
    redCardPoints: integer('red_card_points').notNull().default(3),

    /** Set once. From then on the row cannot be updated at all. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [
    unique('competition_rules_org_id_key').on(t.orgId, t.id),
    liveUnique('competition_rules_org_slug_unique', t.orgId, t.slug),
    check(
      'competition_rules_points_ordered',
      // A draw worth more than a win inverts every table in the league.
      sql`points_for_win >= points_for_draw AND points_for_draw >= points_for_loss`,
    ),
    check(
      'competition_rules_forfeit_scoreline',
      sql`forfeit_winner_goals >= 0 AND forfeit_loser_goals >= 0
          AND forfeit_winner_goals >= forfeit_loser_goals`,
    ),
    check(
      'competition_rules_discipline_weights',
      sql`yellow_card_points >= 0 AND red_card_points >= 0`,
    ),
  ],
);


// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * A competitive pyramid: an ordered stack of grades between which teams are
 * promoted and relegated. Open, Over-35, Over-45, Over-55, Under-21.
 *
 * The old site put fifteen grades from five separate pyramids into one flat
 * dropdown, encoding the age band inside the name string ("O35 Division 1").
 * Making the ladder a real thing is what turns "which grades can a team move
 * between" and "what is the default age rule here" into data.
 */
export const ladders = pgTable(
  'ladders',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // "Open", "Over-35"
    slug: text('slug').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Display only. Never parsed to derive a rule — see eligibility_profiles. */
    ageBandLabel: text('age_band_label'),
    defaultEligibilityProfileId: uuid('default_eligibility_profile_id'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('ladders_org_id_key').on(t.orgId, t.id),
    liveUnique('ladders_org_slug_unique', t.orgId, t.slug),
  ],
);

/**
 * The perpetual line of a competition — "Division 2", "Imperial Cup" — which
 * persists across decades and outlives any restructuring.
 *
 * There is deliberately NO kind or type column. Whether a series behaves like a
 * league or a cup is a consequence of whether it sits on a ladder and of how
 * its stages are configured. That is precisely why QUALIFICATION, PROMOTION,
 * RELEGATION and PROVINCIALS cannot creep back in as "kinds": the first two are
 * progression rules (see below), and the last is a series operated by somebody
 * else.
 */
export const competitionSeries = pgTable(
  'competition_series',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Set for pyramid grades; null for cups and one-off play-offs. */
    ladderId: uuid('ladder_id'),
    sortOrder: integer('sort_order').notNull().default(0),
    foundedYear: integer('founded_year'),
    /** True when another body runs it and we merely record participation. */
    isExternallyOperated: boolean('is_externally_operated').notNull().default(false),
    operatedByBodyId: uuid('operated_by_body_id'),
    /** Renames, splits and merges, so history stays connected. */
    predecessorSeriesId: uuid('predecessor_series_id'),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('competition_series_org_id_key').on(t.orgId, t.id),
    /**
     * NO ACTION rather than SET NULL on both of these. A composite FK's SET
     * NULL nulls every column in the reference, which would include the
     * NOT NULL org_id and fail at runtime. Retiring a ladder or a governing
     * body while a series still points at it is therefore blocked, which is
     * the honest behaviour.
     */
    foreignKey({
      columns: [t.orgId, t.ladderId],
      foreignColumns: [ladders.orgId, ladders.id],
      name: 'competition_series_ladder_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.operatedByBodyId],
      foreignColumns: [governingBodies.orgId, governingBodies.id],
      name: 'competition_series_body_fk',
    }),
    liveUnique('competition_series_org_slug_unique', t.orgId, t.slug),
    index('competition_series_ladder_idx').on(t.ladderId),
  ],
);

/**
 * One season's running of a series — "Division 2, Autumn/Winter 2025-26". This
 * is the thing teams actually enter.
 *
 * `tier` lives HERE and not on the series, which is what makes a pyramid
 * restructure an INSERT rather than a migration: Division 2 can be tier 3 in
 * 2019 and tier 4 in 2025 without either fact overwriting the other.
 */
export const competitionEditions = pgTable(
  'competition_editions',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    seriesId: uuid('series_id').notNull(),
    seasonId: uuid('season_id').notNull(),
    slug: text('slug').notNull(),
    /** Sponsor names and one-off renamings, without touching the series. */
    nameOverride: text('name_override'),
    /** Rung on the ladder for THIS season. 1 is the top. */
    tier: integer('tier'),
    eligibilityProfileId: uuid('eligibility_profile_id'),
    /**
     * Versioned rules, bound to this edition and frozen once published — so
     * changing next season's points-for-a-win cannot rewrite 2019's table.
     */
    rulesId: uuid('rules_id'),
    entryCapacity: integer('entry_capacity'),
    status: editionStatusEnum('status').notNull().default('DRAFT'),
    ...timestamps,
  },
  (t) => [
    unique('competition_editions_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.seriesId],
      foreignColumns: [competitionSeries.orgId, competitionSeries.id],
      name: 'competition_editions_series_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.seasonId],
      foreignColumns: [seasons.orgId, seasons.id],
      name: 'competition_editions_season_fk',
    }).onDelete('cascade'),
    // NO ACTION: a rules row a season was played under cannot be removed while
    // that season still points at it. See the note on competition_series.
    foreignKey({
      columns: [t.orgId, t.rulesId],
      foreignColumns: [competitionRules.orgId, competitionRules.id],
      name: 'competition_editions_rules_fk',
    }),
    liveUnique('competition_editions_season_slug_unique', t.seasonId, t.slug),
    index('competition_editions_org_season_idx').on(t.orgId, t.seasonId),
    index('competition_editions_series_idx').on(t.seriesId),
  ],
);

/**
 * An ordered phase within an edition: "Regular Season", "Quarter-finals",
 * "Championship Round", "Plate".
 *
 * Only three formats exist, because these are three genuinely different ways of
 * resolving an outcome. Everything the old site treated as a separate menu item
 * is a configuration of these.
 */
export const stages = pgTable(
  'stages',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    editionId: uuid('edition_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    format: stageFormatEnum('format').notNull(),
    /** ROUND_ROBIN: 1 single round, 2 double. */
    legsPerPairing: integer('legs_per_pairing').notNull().default(1),
    /** KNOCKOUT: 1 or 2 (two-legged ties). */
    legsPerTie: integer('legs_per_tie').notNull().default(1),
    /** How a level match or tie is decided. */
    tieBreakMethod: tieBreakMethodEnum('tie_break_method').notNull().default('NONE'),
    hasThirdPlacePlayoff: boolean('has_third_place_playoff').notNull().default(false),
    /** Lets lower grades enter a cup at a later round. */
    entersAtRound: integer('enters_at_round'),
    rulesId: uuid('rules_id'),
    ...timestamps,
  },
  (t) => [
    unique('stages_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.editionId],
      foreignColumns: [competitionEditions.orgId, competitionEditions.id],
      name: 'stages_edition_fk',
    }).onDelete('cascade'),
    /**
     * A stage may override its edition's rules — a cup's group phase counting
     * points differently from the knockout that follows it. Resolution order is
     * stage, then edition; see resolveRules() in src/server/standings.
     */
    foreignKey({
      columns: [t.orgId, t.rulesId],
      foreignColumns: [competitionRules.orgId, competitionRules.id],
      name: 'stages_rules_fk',
    }),
    // Partial: removing a stage must free its ordinal, or restructuring a
    // competition mid-planning would leave permanent gaps in the sequence.
    liveUnique('stages_edition_ordinal_unique', t.editionId, t.ordinal),
    liveUnique('stages_edition_slug_unique', t.editionId, t.slug),
    index('stages_org_idx').on(t.orgId),
  ],
);

/**
 * A group within a stage.
 *
 * For a round-robin stage this is a table — and a division running as three
 * parallel sections of ten is three groups, not three separate competitions
 * with a letter glued onto the name. For a knockout stage it is a round.
 */
export const stageGroups = pgTable(
  'stage_groups',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id').notNull(),
    name: text('name').notNull(), // "Section A", "Quarter-finals"
    slug: text('slug').notNull(),
    ordinal: integer('ordinal').notNull().default(0),
    /** KNOCKOUT: which round this is, counting from the first. */
    roundNumber: integer('round_number'),
    ...timestamps,
  },
  (t) => [
    unique('stage_groups_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.stageId],
      foreignColumns: [stages.orgId, stages.id],
      name: 'stage_groups_stage_fk',
    }).onDelete('cascade'),
    liveUnique('stage_groups_stage_slug_unique', t.stageId, t.slug),
    index('stage_groups_org_idx').on(t.orgId),
  ],
);

/**
 * Where the occupants of a group's places come from — as ROWS, so that
 * "the winners of the quarter-finals" and "the losers of round one, who go into
 * the Plate" are data rather than code.
 */
export const stageEntrySources = pgTable(
  'stage_entry_sources',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stageGroupId: uuid('stage_group_id').notNull(),
    slotNumber: integer('slot_number').notNull(),
    kind: entrySourceKindEnum('kind').notNull(),
    /** For STAGE_POSITION / STAGE_WINNER / STAGE_LOSER. */
    sourceStageGroupId: uuid('source_stage_group_id'),
    sourcePosition: integer('source_position'),
    /** For EXTERNAL_QUALIFIER — a note about where they came from. */
    externalDescription: text('external_description'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.stageGroupId],
      foreignColumns: [stageGroups.orgId, stageGroups.id],
      name: 'stage_entry_sources_group_fk',
    }).onDelete('cascade'),
    liveUnique('stage_entry_sources_slot_unique', t.stageGroupId, t.slotNumber),
    index('stage_entry_sources_org_idx').on(t.orgId),
  ],
);

/**
 * What happens to teams by virtue of where they finish.
 *
 * "Premier relegates two teams to Division 1" becomes a row, not a paragraph in
 * a rulebook and a special case in a query. This is where PROMOTION and
 * RELEGATION genuinely belong — as rules about positions in a table, which is
 * what they always were.
 */
export const progressionRules = pgTable(
  'progression_rules',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stageGroupId: uuid('stage_group_id').notNull(),
    kind: progressionKindEnum('kind').notNull(),
    fromPosition: integer('from_position').notNull(),
    toPosition: integer('to_position').notNull(),
    /** The series they move into. Null for RETENTION. */
    targetSeriesId: uuid('target_series_id'),
    note: text('note'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.stageGroupId],
      foreignColumns: [stageGroups.orgId, stageGroups.id],
      name: 'progression_rules_group_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.targetSeriesId],
      foreignColumns: [competitionSeries.orgId, competitionSeries.id],
      name: 'progression_rules_target_series_fk',
    }),
    index('progression_rules_group_idx').on(t.stageGroupId),
  ],
);

// ---------------------------------------------------------------------------
// Honours
// ---------------------------------------------------------------------------

/**
 * A perpetual trophy — "The William Azzi", awarded annually for decades.
 *
 * The previous version of this schema stored the trophy as a bare text column
 * on a division, which meant it could never answer "who won the William Azzi in
 * 2019". A trophy is an entity with a lineage of winners, and modelling it as
 * one makes the champions-since-1974 page and the Golden Boot history ordinary
 * queries rather than features.
 */
export const honours = pgTable(
  'honours',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(), // "The William Azzi"
    slug: text('slug').notNull(),
    recipientKind: honourRecipientKindEnum('recipient_kind').notNull().default('TEAM'),
    /** The series it is normally attached to, where there is one. */
    seriesId: uuid('series_id'),
    establishedYear: integer('established_year'),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('honours_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.seriesId],
      foreignColumns: [competitionSeries.orgId, competitionSeries.id],
      name: 'honours_series_fk',
    }),
    liveUnique('honours_org_slug_unique', t.orgId, t.slug),
  ],
);

/** One year's winner. The rows here ARE the honours board. */
export const honourAwards = pgTable(
  'honour_awards',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    honourId: uuid('honour_id').notNull(),
    seasonId: uuid('season_id'),
    editionId: uuid('edition_id'),
    /** Exactly one of these is set, per the honour's recipientKind. */
    teamId: uuid('team_id'),
    personId: uuid('person_id'),
    /** For imported history where the entity no longer resolves. */
    recipientNameSnapshot: text('recipient_name_snapshot'),
    /** e.g. goals scored, for a Golden Boot. */
    value: integer('value'),
    awardedOn: date('awarded_on'),
    notes: jsonb('notes'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.honourId],
      foreignColumns: [honours.orgId, honours.id],
      name: 'honour_awards_honour_fk',
    }).onDelete('cascade'),
    /**
     * NO ACTION, not SET NULL — see the note on competition_series. These are
     * historical records anyway: an honours board must not lose which season a
     * trophy was won in because someone tidied up an old season row.
     */
    foreignKey({
      columns: [t.orgId, t.seasonId],
      foreignColumns: [seasons.orgId, seasons.id],
      name: 'honour_awards_season_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.editionId],
      foreignColumns: [competitionEditions.orgId, competitionEditions.id],
      name: 'honour_awards_edition_fk',
    }),
    index('honour_awards_honour_idx').on(t.honourId),
    index('honour_awards_org_season_idx').on(t.orgId, t.seasonId),
  ],
);

// --- relations ---------------------------------------------------------------

export const seasonsRelations = relations(seasons, ({ one, many }) => ({
  organization: one(organizations, { fields: [seasons.orgId], references: [organizations.id] }),
  registrationYear: one(registrationYears, {
    fields: [seasons.registrationYearId],
    references: [registrationYears.id],
  }),
  editions: many(competitionEditions),
}));

export const competitionSeriesRelations = relations(competitionSeries, ({ one, many }) => ({
  ladder: one(ladders, { fields: [competitionSeries.ladderId], references: [ladders.id] }),
  editions: many(competitionEditions),
}));

export const competitionEditionsRelations = relations(competitionEditions, ({ one, many }) => ({
  series: one(competitionSeries, {
    fields: [competitionEditions.seriesId],
    references: [competitionSeries.id],
  }),
  season: one(seasons, { fields: [competitionEditions.seasonId], references: [seasons.id] }),
  stages: many(stages),
}));

export const stagesRelations = relations(stages, ({ one, many }) => ({
  edition: one(competitionEditions, {
    fields: [stages.editionId],
    references: [competitionEditions.id],
  }),
  groups: many(stageGroups),
}));

export const stageGroupsRelations = relations(stageGroups, ({ one, many }) => ({
  stage: one(stages, { fields: [stageGroups.stageId], references: [stages.id] }),
  entrySources: many(stageEntrySources),
  progressionRules: many(progressionRules),
}));

export const honoursRelations = relations(honours, ({ many }) => ({
  awards: many(honourAwards),
}));

export const honourAwardsRelations = relations(honourAwards, ({ one }) => ({
  honour: one(honours, { fields: [honourAwards.honourId], references: [honours.id] }),
  season: one(seasons, { fields: [honourAwards.seasonId], references: [seasons.id] }),
}));
