import { relations } from 'drizzle-orm';
import { date, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { liveUnique, primaryId, timestamps } from './_shared';
import {
  ageReferenceModeEnum,
  entryStatusEnum,
  registrationStatusEnum,
  screeningStatusEnum,
} from './enums';
import { competitionEditions, seasons, stageGroups } from './competition';
import { persons } from './identity';
import { organizations } from './tenancy';

/**
 * Clubs, teams, and who plays for whom.
 *
 * The two-level split matters: a TEAM is a stable identity that persists across
 * decades and moves between grades, while an EDITION ENTRY is that team's
 * participation in one competition in one season. Fixtures, standings and
 * registrations all point at the entry, so when a team is promoted its history
 * stays attached to the right rung rather than being retroactively rewritten.
 */

export const clubs = pgTable(
  'clubs',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    shortName: text('short_name'),
    crestUrl: text('crest_url'),
    foundedYear: integer('founded_year'),
    contactEmail: text('contact_email'),
    contactPhone: text('contact_phone'),
    ...timestamps,
  },
  (t) => [
    liveUnique('clubs_org_slug_unique', t.orgId, t.slug),
    index('clubs_org_idx').on(t.orgId),
    index('clubs_name_idx').on(t.name),
  ],
);

export const teams = pgTable(
  'teams',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    clubId: uuid('club_id')
      .notNull()
      .references(() => clubs.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    /** Distinguishes a club's sides: "First XI", "Reserves", "Masters". */
    designation: text('designation'),
    ...timestamps,
  },
  (t) => [
    liveUnique('teams_org_slug_unique', t.orgId, t.slug),
    index('teams_club_idx').on(t.clubId),
    index('teams_org_idx').on(t.orgId),
  ],
);

/**
 * A team's participation in one edition of one competition.
 *
 * `pointsAdjustment` carries deductions imposed by a disciplinary hearing. The
 * standings engine reads it as an input rather than anyone editing a computed
 * total — which is the whole difference between a table you can trust and a
 * page somebody maintains by hand.
 */
export const editionEntries = pgTable(
  'edition_entries',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    editionId: uuid('edition_id')
      .notNull()
      .references(() => competitionEditions.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    status: entryStatusEnum('status').notNull().default('ACTIVE'),
    pointsAdjustment: integer('points_adjustment').notNull().default(0),
    withdrawnOn: date('withdrawn_on'),
    withdrawalReason: text('withdrawal_reason'),
    ...timestamps,
  },
  (t) => [
    // Partial: a team that withdraws and is later reinstated must be able to
    // re-enter the same competition.
    liveUnique('edition_entries_unique', t.editionId, t.teamId),
    index('edition_entries_org_idx').on(t.orgId),
    index('edition_entries_team_idx').on(t.teamId),
  ],
);

/**
 * Which group an entry occupies within a stage.
 *
 * Separate from `edition_entries` because a team moves through stages: it plays
 * in Section A of the regular season, then in the championship round. One entry,
 * several placements.
 */
export const stageGroupEntries = pgTable(
  'stage_group_entries',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    stageGroupId: uuid('stage_group_id')
      .notNull()
      .references(() => stageGroups.id, { onDelete: 'cascade' }),
    editionEntryId: uuid('edition_entry_id')
      .notNull()
      .references(() => editionEntries.id, { onDelete: 'cascade' }),
    /** Seeding, and the bracket slot for a knockout. */
    slotNumber: integer('slot_number'),
    ...timestamps,
  },
  (t) => [
    liveUnique('stage_group_entries_unique', t.stageGroupId, t.editionEntryId),
    index('stage_group_entries_group_idx').on(t.stageGroupId),
  ],
);

// ---------------------------------------------------------------------------
// Eligibility, as data rather than as code
// ---------------------------------------------------------------------------

/**
 * A named set of rules deciding who may play in a competition.
 *
 * "Under 21" is meaningless until you say "as at what date", and leagues
 * genuinely differ. Making the reference mode a column is what stops that rule
 * being hard-coded inside a query where nobody can find it — and what lets a
 * second league arrive with a different cutoff without a code change.
 */
export const eligibilityProfiles = pgTable(
  'eligibility_profiles',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description'),
    ...timestamps,
  },
  (t) => [liveUnique('eligibility_profiles_org_slug_unique', t.orgId, t.slug)],
);

export const eligibilityRules = pgTable(
  'eligibility_rules',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => eligibilityProfiles.id, { onDelete: 'cascade' }),
    /** Inclusive bounds; null means unbounded on that side. */
    minAge: integer('min_age'),
    maxAge: integer('max_age'),
    ageReferenceMode: ageReferenceModeEnum('age_reference_mode').notNull().default('SEASON_START'),
    /** Used when ageReferenceMode is FIXED_DATE. */
    referenceDate: date('reference_date'),
    /** Whether a cleared criminal record check is required to participate. */
    screeningRequired: screeningStatusEnum('screening_required')
      .notNull()
      .default('NOT_REQUIRED'),
    /** Maximum squad size, where the competition caps it. */
    maxSquadSize: integer('max_squad_size'),
    notes: text('notes'),
    ...timestamps,
  },
  (t) => [index('eligibility_rules_profile_idx').on(t.profileId)],
);

/**
 * A person's affiliation with a team for a season, modelled as an INTERVAL.
 *
 * Intervals rather than a status flag, because "was this player registered on
 * the fourteenth of March" is a question this system will be asked during every
 * protest — and a mutable status column cannot answer it. A mid-season transfer
 * closes one interval and opens another; both remain true of their own period.
 */
export const personRegistrations = pgTable(
  'person_registrations',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    personId: uuid('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    editionEntryId: uuid('edition_entry_id')
      .notNull()
      .references(() => editionEntries.id, { onDelete: 'cascade' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'cascade' }),
    status: registrationStatusEnum('status').notNull().default('PENDING'),
    squadNumber: integer('squad_number'),

    /** The interval. `validUntil` null means still current. */
    validFrom: date('valid_from').notNull(),
    validUntil: date('valid_until'),

    screeningStatus: screeningStatusEnum('screening_status').notNull().default('NOT_REQUIRED'),
    screeningClearedOn: date('screening_cleared_on'),
    screeningExpiresOn: date('screening_expires_on'),
    ...timestamps,
  },
  (t) => [
    index('person_registrations_entry_idx').on(t.editionEntryId),
    index('person_registrations_person_idx').on(t.personId),
    index('person_registrations_org_status_idx').on(t.orgId, t.status),
  ],
);

// --- relations ---------------------------------------------------------------

export const clubsRelations = relations(clubs, ({ one, many }) => ({
  organization: one(organizations, { fields: [clubs.orgId], references: [organizations.id] }),
  teams: many(teams),
}));

export const teamsRelations = relations(teams, ({ one, many }) => ({
  club: one(clubs, { fields: [teams.clubId], references: [clubs.id] }),
  entries: many(editionEntries),
}));

export const editionEntriesRelations = relations(editionEntries, ({ one, many }) => ({
  team: one(teams, { fields: [editionEntries.teamId], references: [teams.id] }),
  edition: one(competitionEditions, {
    fields: [editionEntries.editionId],
    references: [competitionEditions.id],
  }),
  groupPlacements: many(stageGroupEntries),
  registrations: many(personRegistrations),
}));

export const personRegistrationsRelations = relations(personRegistrations, ({ one }) => ({
  person: one(persons, { fields: [personRegistrations.personId], references: [persons.id] }),
  entry: one(editionEntries, {
    fields: [personRegistrations.editionEntryId],
    references: [editionEntries.id],
  }),
}));
