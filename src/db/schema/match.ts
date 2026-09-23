import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { liveUnique, primaryId, timestamps } from './_shared';
import {
  fixtureChangeKindEnum,
  fixtureStatusEnum,
  matchEventTypeEnum,
  matchPeriodEnum,
  matchReportSourceEnum,
  venueSurfaceEnum,
} from './enums';
import { stageGroups } from './competition';
import { persons } from './identity';
import { editionEntries } from './participation';
import { organizations } from './tenancy';

/**
 * MATCH DAY — where the competition stops being a structure and becomes events
 * that people argue about.
 *
 * The organising discipline here is FACT / RULE / CONCLUSION:
 *
 *   - A FACT is append-only and attributed. A result submission, a match event
 *     and a fixture change are all facts: they are inserted, never edited. A
 *     correction is a NEW row that supersedes or retracts an earlier one, so
 *     the original claim and the correction both survive with their authors
 *     attached.
 *   - A CONCLUSION — the score of a match, the standings, who is suspended — is
 *     DERIVED from those facts. Nothing writes a conclusion to a column that a
 *     human can then quietly adjust.
 *
 * The `fixtures` table is the deliberate exception: it is mutable state (a
 * kickoff time moves, a venue changes) and every mutation is required to leave
 * a typed `fixture_changes` row behind. That is what makes "the league moved
 * our game twice and never told us" answerable with evidence rather than with
 * recollection.
 *
 * ── WHY THE EVIDENCE TABLES USE NO ACTION, NOT CASCADE ──────────────────────
 * `fixture_changes`, `result_submissions` and `match_events` reference
 * `fixtures` with NO ACTION rather than ON DELETE CASCADE.
 *
 * Row-level security grants the application FOR ALL on tenant tables, so
 * `app_user` genuinely can DELETE a fixture in its own league. With CASCADE,
 * deleting the fixture would take its entire evidence trail with it — the
 * append-only policies on those three tables would be trivially defeated by
 * deleting the parent instead of the rows. NO ACTION makes PostgreSQL refuse.
 *
 * NO ACTION rather than RESTRICT specifically, because NO ACTION is checked at
 * the end of the statement: deleting an entire league still cascades cleanly
 * through every table's `org_id`, while deleting one fixture that has history
 * is blocked. RESTRICT, being checked immediately, would break the former.
 * ────────────────────────────────────────────────────────────────────────────
 */

// ---------------------------------------------------------------------------
// Where matches are played
// ---------------------------------------------------------------------------

/**
 * The regions a league's venues sit in — VAN, BBY, SRY on the old site.
 *
 * A table and not an enum. Those seventeen codes are one league's geography;
 * a league in the Okanagan or on Vancouver Island arrives with a different
 * list, and an enum would require a migration to admit them. Referees also
 * express travel preferences in these terms (Phase 10), so it needs to be a
 * thing that can be referenced rather than a string repeated on every venue.
 */
export const municipalities = pgTable(
  'municipalities',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Short form used on schedules where space is tight. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique('municipalities_org_id_key').on(t.orgId, t.id),
    liveUnique('municipalities_org_code_unique', t.orgId, t.code),
    index('municipalities_org_idx').on(t.orgId),
  ],
);

/**
 * A place a match is played.
 *
 * `parentVenueId` models the complex/field relationship that the old site
 * flattens into ~140 separate rows with the field number glued onto the name.
 * "Is anything on at Rutland Sports Fields today" and "field 3 is closed but
 * fields 1 and 2 are open" are both ordinary queries once the hierarchy is
 * real, and neither is expressible against a flat list of strings.
 */
export const venues = pgTable(
  'venues',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** The complex this pitch belongs to, where it is one of several. */
    parentVenueId: uuid('parent_venue_id'),
    municipalityId: uuid('municipality_id'),
    surface: venueSurfaceEnum('surface').notNull().default('UNKNOWN'),
    /** Decides whether a 7pm kickoff in November is possible at all. */
    isFloodlit: boolean('is_floodlit').notNull().default(false),
    address: text('address'),
    /**
     * Plain WGS84 degrees. `double precision` rather than `numeric` because
     * Phase 10's assignor console computes travel time between venues, and a
     * numeric column arrives in JavaScript as a string. Six decimal places of
     * a double is ~0.1 m — far beyond what a pitch location needs.
     */
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    mapUrl: text('map_url'),
    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique('venues_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.parentVenueId],
      foreignColumns: [t.orgId, t.id],
      name: 'venues_parent_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.municipalityId],
      foreignColumns: [municipalities.orgId, municipalities.id],
      name: 'venues_municipality_fk',
    }),
    liveUnique('venues_org_slug_unique', t.orgId, t.slug),
    index('venues_org_idx').on(t.orgId),
    index('venues_municipality_idx').on(t.municipalityId),
    index('venues_parent_idx').on(t.parentVenueId),
    // A pitch cannot be its own complex.
    check('venues_parent_not_self', sql`parent_venue_id IS NULL OR parent_venue_id <> id`),
    check(
      'venues_coordinates_in_range',
      sql`(latitude IS NULL OR (latitude >= -90 AND latitude <= 90))
          AND (longitude IS NULL OR (longitude >= -180 AND longitude <= 180))`,
    ),
  ],
);

/**
 * A period during which a venue is unusable.
 *
 * This is the field-status feature, and it is the highest-value piece of
 * information this league publishes between October and March — currently
 * buried several clicks deep on the old site. An open-ended closure (`endsAt`
 * null) means "until further notice", which is what a city actually says.
 *
 * Mutable rather than append-only on purpose: a closure being lifted is a
 * correction to operational state, not a contested historical fact. The audit
 * log records who lifted it.
 */
export const venueClosures = pgTable(
  'venue_closures',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    venueId: uuid('venue_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    /** Null means "until further notice". */
    endsAt: timestamp('ends_at', { withTimezone: true }),
    reason: text('reason').notNull(),
    /** Who says so — the city, the league, the club. */
    source: text('source'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.venueId],
      foreignColumns: [venues.orgId, venues.id],
      name: 'venue_closures_venue_fk',
    }).onDelete('cascade'),
    index('venue_closures_venue_idx').on(t.venueId),
    index('venue_closures_org_window_idx').on(t.orgId, t.startsAt, t.endsAt),
    check('venue_closures_window_ordered', sql`ends_at IS NULL OR ends_at > starts_at`),
  ],
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * One scheduled match.
 *
 * A fixture belongs to a STAGE GROUP — a section of a division, or a round of a
 * cup — and through it to a stage, an edition, a season. The edition id is
 * deliberately NOT copied down here: `org_id` is denormalised everywhere
 * because it makes every security policy one identical column comparison, and
 * that reason does not extend to the competition chain. A second denormalised
 * key is just a second thing that can disagree with the first.
 *
 * `homeEntryId` and `awayEntryId` are NULLABLE, which is not laziness. Cup
 * rounds are scheduled — venue, pitch, kickoff time — before anyone knows who
 * qualified, and a league that cannot publish "Round 2, Saturday 14:00, Field
 * 3, teams TBD" will have its scheduler kept in a spreadsheet instead. A check
 * constraint keeps the two sides distinct whenever both are known, and the
 * service layer refuses a result for a fixture whose sides are not both set.
 */
export const fixtures = pgTable(
  'fixtures',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stageGroupId: uuid('stage_group_id').notNull(),
    homeEntryId: uuid('home_entry_id'),
    awayEntryId: uuid('away_entry_id'),
    venueId: uuid('venue_id'),

    /**
     * UTC. Always. Rendered in the league's IANA zone at the edge of the
     * system and nowhere else — see src/lib/time.ts.
     *
     * Null means the date is genuinely not yet fixed, which is different from
     * "midnight", and different again from a fixture that has been postponed.
     */
    kickoffAt: timestamp('kickoff_at', { withTimezone: true }),

    /** Knockout round number, matching the stage group's `roundNumber`. */
    round: integer('round'),
    /** League matchday, for "week 7 of the season" navigation. */
    matchday: integer('matchday'),
    /** 1 or 2, for two-legged ties. */
    leg: integer('leg').notNull().default(1),
    status: fixtureStatusEnum('status').notNull().default('SCHEDULED'),
    /** Free text shown on the public schedule, e.g. "moved for pitch works". */
    publicNote: text('public_note'),
    ...timestamps,
  },
  (t) => [
    unique('fixtures_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.stageGroupId],
      foreignColumns: [stageGroups.orgId, stageGroups.id],
      name: 'fixtures_stage_group_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.homeEntryId],
      foreignColumns: [editionEntries.orgId, editionEntries.id],
      name: 'fixtures_home_entry_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.awayEntryId],
      foreignColumns: [editionEntries.orgId, editionEntries.id],
      name: 'fixtures_away_entry_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.venueId],
      foreignColumns: [venues.orgId, venues.id],
      name: 'fixtures_venue_fk',
    }),
    // The schedule page's query: everything in this league between two dates.
    index('fixtures_org_kickoff_idx').on(t.orgId, t.kickoffAt),
    index('fixtures_group_idx').on(t.stageGroupId),
    index('fixtures_home_entry_idx').on(t.homeEntryId),
    index('fixtures_away_entry_idx').on(t.awayEntryId),
    index('fixtures_venue_kickoff_idx').on(t.venueId, t.kickoffAt),
    check(
      'fixtures_sides_distinct',
      sql`home_entry_id IS NULL OR away_entry_id IS NULL OR home_entry_id <> away_entry_id`,
    ),
    check('fixtures_leg_positive', sql`leg >= 1`),
  ],
);

/**
 * Every change ever made to a fixture. APPEND-ONLY, enforced in PostgreSQL.
 *
 * Leagues argue about reschedules more than about almost anything else, and
 * "the system says it was always at 2pm" is only an answer if the system could
 * not have been edited to say so. The policy on this table grants SELECT and
 * INSERT and nothing else, and the foreign key to `fixtures` is NO ACTION so
 * the row cannot be removed by deleting its parent either.
 *
 * This is deliberately separate from `audit_log`. The audit log is generic —
 * `before`/`after` as opaque jsonb — and answers "what did this user do".
 * These columns are typed, so "which fixtures moved more than twice", "how
 * much notice did clubs get", and "show this team every change to its season"
 * are ordinary indexed queries rather than JSON archaeology. Both rows are
 * written; they answer different questions.
 */
export const fixtureChanges = pgTable(
  'fixture_changes',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fixtureId: uuid('fixture_id').notNull(),
    kind: fixtureChangeKindEnum('kind').notNull(),

    previousKickoffAt: timestamp('previous_kickoff_at', { withTimezone: true }),
    newKickoffAt: timestamp('new_kickoff_at', { withTimezone: true }),
    previousVenueId: uuid('previous_venue_id'),
    newVenueId: uuid('new_venue_id'),
    previousStatus: fixtureStatusEnum('previous_status'),
    newStatus: fixtureStatusEnum('new_status'),

    /** Required by the service layer on every change. Never optional. */
    reason: text('reason').notNull(),
    changedByPersonId: uuid('changed_by_person_id'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    // NO ACTION: see the note at the top of this file. Deleting the fixture
    // must not be a way to delete its history.
    foreignKey({
      columns: [t.orgId, t.fixtureId],
      foreignColumns: [fixtures.orgId, fixtures.id],
      name: 'fixture_changes_fixture_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.changedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'fixture_changes_person_fk',
    }),
    index('fixture_changes_fixture_idx').on(t.fixtureId, t.createdAt),
    index('fixture_changes_org_created_idx').on(t.orgId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Results and events — facts, not conclusions
// ---------------------------------------------------------------------------

/**
 * Somebody's claim about how a match finished. APPEND-ONLY.
 *
 * There is no `results` table with a score column, and that is the central
 * decision in this file. A score column has exactly one value, so the moment
 * the home team says 2–1 and the away team says 1–1 the system has to pick one
 * and forget the other — and the record of the disagreement, which is the
 * thing the league actually has to adjudicate, is gone.
 *
 * So each submission is a row, attributed to a source. The score of a match is
 * DERIVED from the submissions by `resolveResult()` in
 * `src/server/match/result.ts`, which is a pure function, returns its own
 * reasoning, and can say DISPUTED. A correction is a new row pointing at the
 * one it replaces via `supersedesId`, so both the original claim and the
 * correction survive with their authors attached.
 *
 * Authority is derived from `source`, never stored — otherwise a correction
 * could be laundered into a higher authority simply by writing a column.
 */
export const resultSubmissions = pgTable(
  'result_submissions',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fixtureId: uuid('fixture_id').notNull(),
    source: matchReportSourceEnum('source').notNull(),
    submittedByPersonId: uuid('submitted_by_person_id'),

    /** Null when the match produced no score — a forfeit, or an abandonment. */
    homeScore: integer('home_score'),
    awayScore: integer('away_score'),
    homeForfeit: boolean('home_forfeit').notNull().default(false),
    awayForfeit: boolean('away_forfeit').notNull().default(false),
    /** Shootout, where the stage's tie-break method calls for one. */
    homePenalties: integer('home_penalties'),
    awayPenalties: integer('away_penalties'),

    /** The submission this one replaces. Corrections are inserts, never edits. */
    supersedesId: uuid('supersedes_id'),
    /** Required by the service layer whenever `supersedesId` is set. */
    reason: text('reason'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique('result_submissions_org_id_key').on(t.orgId, t.id),
    // NO ACTION: deleting the fixture must not erase what was reported.
    foreignKey({
      columns: [t.orgId, t.fixtureId],
      foreignColumns: [fixtures.orgId, fixtures.id],
      name: 'result_submissions_fixture_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.submittedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'result_submissions_person_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.supersedesId],
      foreignColumns: [t.orgId, t.id],
      name: 'result_submissions_supersedes_fk',
    }),
    /**
     * A submission may be superseded at most once. Without this, two competing
     * "corrections" of the same row both look current and the resolution is
     * whichever the query happened to sort first. PostgreSQL treats NULLs as
     * distinct, so the many un-superseding rows are unaffected.
     */
    unique('result_submissions_supersedes_unique').on(t.orgId, t.supersedesId),
    index('result_submissions_fixture_idx').on(t.fixtureId, t.createdAt),
    check('result_submissions_not_self', sql`supersedes_id IS NULL OR supersedes_id <> id`),
    check(
      'result_submissions_scores_non_negative',
      sql`(home_score IS NULL OR home_score >= 0)
          AND (away_score IS NULL OR away_score >= 0)
          AND (home_penalties IS NULL OR home_penalties >= 0)
          AND (away_penalties IS NULL OR away_penalties >= 0)`,
    ),
    // Both sides cannot forfeit to each other; that is an abandonment, and the
    // fixture status says so.
    check('result_submissions_single_forfeit', sql`NOT (home_forfeit AND away_forfeit)`),
  ],
);

/**
 * What happened during the match, minute by minute. APPEND-ONLY.
 *
 * This one table feeds statistics (Phase 4) and discipline (Phase 11). A red
 * card is not a column on a result — it is an event with a player, a minute
 * and a side, which is exactly what a disciplinary case needs as its origin
 * and exactly what a goalscorer table needs as its input.
 *
 * `personId` is nullable because the referee genuinely does not always know who
 * scored, and a schema that insists will get a fictional name instead of a
 * null. `retractsEventId` is how a mis-recorded event is corrected: a new row,
 * pointing back, leaving both visible.
 */
export const matchEvents = pgTable(
  'match_events',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    fixtureId: uuid('fixture_id').notNull(),
    /** Which side it belongs to. Null only for events attributable to neither. */
    editionEntryId: uuid('edition_entry_id'),
    personId: uuid('person_id'),
    /** The assisting player, or the one coming off in a substitution. */
    relatedPersonId: uuid('related_person_id'),

    type: matchEventTypeEnum('type').notNull(),
    period: matchPeriodEnum('period').notNull().default('FIRST_HALF'),
    /** Null when unknown — better than inventing a minute. */
    minute: integer('minute'),
    /** Added time within the period: 45+3 is minute 45, stoppage 3. */
    stoppageMinute: integer('stoppage_minute'),

    source: matchReportSourceEnum('source').notNull().default('REFEREE'),
    recordedByPersonId: uuid('recorded_by_person_id'),
    /** Set when this row exists to withdraw an earlier one. */
    retractsEventId: uuid('retracts_event_id'),
    note: text('note'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    unique('match_events_org_id_key').on(t.orgId, t.id),
    foreignKey({
      columns: [t.orgId, t.fixtureId],
      foreignColumns: [fixtures.orgId, fixtures.id],
      name: 'match_events_fixture_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.editionEntryId],
      foreignColumns: [editionEntries.orgId, editionEntries.id],
      name: 'match_events_entry_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'match_events_person_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.relatedPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'match_events_related_person_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.recordedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'match_events_recorded_by_fk',
    }),
    foreignKey({
      columns: [t.orgId, t.retractsEventId],
      foreignColumns: [t.orgId, t.id],
      name: 'match_events_retracts_fk',
    }),
    // An event may be retracted once. Two retractions of one event would make
    // "is this still standing" ambiguous.
    unique('match_events_retracts_unique').on(t.orgId, t.retractsEventId),
    index('match_events_fixture_idx').on(t.fixtureId),
    index('match_events_person_type_idx').on(t.personId, t.type),
    index('match_events_org_type_idx').on(t.orgId, t.type),
    check('match_events_not_self', sql`retracts_event_id IS NULL OR retracts_event_id <> id`),
    check(
      'match_events_minute_sane',
      sql`(minute IS NULL OR (minute >= 0 AND minute <= 200))
          AND (stoppage_minute IS NULL OR (stoppage_minute >= 0 AND stoppage_minute <= 60))`,
    ),
  ],
);

// --- relations ---------------------------------------------------------------

export const municipalitiesRelations = relations(municipalities, ({ many }) => ({
  venues: many(venues),
}));

export const venuesRelations = relations(venues, ({ one, many }) => ({
  organization: one(organizations, { fields: [venues.orgId], references: [organizations.id] }),
  municipality: one(municipalities, {
    fields: [venues.municipalityId],
    references: [municipalities.id],
  }),
  closures: many(venueClosures),
  fixtures: many(fixtures),
}));

export const venueClosuresRelations = relations(venueClosures, ({ one }) => ({
  venue: one(venues, { fields: [venueClosures.venueId], references: [venues.id] }),
}));

export const fixturesRelations = relations(fixtures, ({ one, many }) => ({
  stageGroup: one(stageGroups, {
    fields: [fixtures.stageGroupId],
    references: [stageGroups.id],
  }),
  venue: one(venues, { fields: [fixtures.venueId], references: [venues.id] }),
  homeEntry: one(editionEntries, {
    fields: [fixtures.homeEntryId],
    references: [editionEntries.id],
    relationName: 'homeFixtures',
  }),
  awayEntry: one(editionEntries, {
    fields: [fixtures.awayEntryId],
    references: [editionEntries.id],
    relationName: 'awayFixtures',
  }),
  changes: many(fixtureChanges),
  submissions: many(resultSubmissions),
  events: many(matchEvents),
}));

export const fixtureChangesRelations = relations(fixtureChanges, ({ one }) => ({
  fixture: one(fixtures, { fields: [fixtureChanges.fixtureId], references: [fixtures.id] }),
}));

export const resultSubmissionsRelations = relations(resultSubmissions, ({ one }) => ({
  fixture: one(fixtures, { fields: [resultSubmissions.fixtureId], references: [fixtures.id] }),
}));

export const matchEventsRelations = relations(matchEvents, ({ one }) => ({
  fixture: one(fixtures, { fields: [matchEvents.fixtureId], references: [fixtures.id] }),
  person: one(persons, { fields: [matchEvents.personId], references: [persons.id] }),
}));
