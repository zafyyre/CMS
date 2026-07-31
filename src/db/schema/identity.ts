import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { liveUnique, primaryId, timestamps } from './_shared';
import {
  consentGrantedByEnum,
  consentKindEnum,
  consentStateEnum,
  grantStatusEnum,
  roleEnum,
  scopeKindEnum,
} from './enums';
import { organizations } from './tenancy';

// ---------------------------------------------------------------------------
// Login identity — owned by better-auth
// ---------------------------------------------------------------------------

/**
 * These tables carry no `org_id` and have no tenant policy, deliberately.
 *
 * A user is a *global* identity: the same human may referee in one league and
 * play in another, and authentication necessarily happens before any league is
 * known, so an org-scoped policy would make signing in impossible. What IS
 * league-scoped is their `person` record and their `role_grants` — both of
 * which are protected.
 *
 * scripts/migrate.ts asserts these tables do NOT have RLS enabled, so the
 * decision stays deliberate rather than drifting into an accident.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_email_idx').on(t.email)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    /**
     * Database-backed sessions rather than stateless tokens, so a compromised
     * session can be revoked immediately — which a signed JWT cannot offer.
     */
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId), index('sessions_token_idx').on(t.token)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    /** Hashed by better-auth. Never plaintext. */
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('accounts_user_id_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

/** TOTP second factor. Required for admin-tier roles before any write. */
export const twoFactors = pgTable(
  'two_factors',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [index('two_factors_user_id_idx').on(t.userId)],
);

// ---------------------------------------------------------------------------
// People — who exist whether or not they ever log in
// ---------------------------------------------------------------------------

/**
 * A person is not a user.
 *
 * This is the most consequential decision in the schema. A player has a name,
 * a date of birth, a registration history and a suspension history long before
 * they ever create a login, and the overwhelming majority never will.
 * Conflating the two means minting six thousand fake accounts for people who
 * will never sign in — and unwinding it later touches every table.
 *
 * `userId` is the *optional* link, set when someone claims their account.
 */
export const persons = pgTable(
  'persons',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** Null until this person claims a login. Most rows stay null forever. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * Given and family name held separately, plus a display name.
     *
     * Club and player names in this league are Croatian, Punjabi, Italian,
     * Portuguese and Vietnamese. Assuming "first name then last name" is a
     * Western convention, so `displayName` is what the interface shows and the
     * separate parts are what search and sorting use.
     */
    givenName: text('given_name').notNull(),
    familyName: text('family_name').notNull(),
    displayName: text('display_name'),

    /** Drives age-banded eligibility (U21, O35, O45, O55). */
    dateOfBirth: date('date_of_birth'),
    email: text('email'),
    phone: text('phone'),
    photoUrl: text('photo_url'),
    ...timestamps,
  },
  (t) => [
    // FK target for every league-scoped table that references a person. See
    // the composite-foreign-key note in participation.ts: without org_id in
    // the reference, one league could point at another league's person record.
    unique('persons_org_id_key').on(t.orgId, t.id),
    index('persons_org_idx').on(t.orgId),
    index('persons_org_name_idx').on(t.orgId, t.familyName, t.givenName),
    index('persons_user_idx').on(t.userId),
  ],
);

/**
 * Who is allowed to do what, in which league, over which thing, and *when*.
 *
 * The validity interval is the point. One human is simultaneously a Division 3
 * player, a coach of a U21 side and a referee — and a club administrator whose
 * term ended in June should stop being one without anybody deleting a row.
 * The old system cannot express any of this.
 */
export const roleGrants = pgTable(
  'role_grants',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull(),
    role: roleEnum('role').notNull(),
    scopeKind: scopeKindEnum('scope_kind').notNull().default('ORGANIZATION'),
    /**
     * Deliberately not a foreign key: it points at clubs or teams depending on
     * `scopeKind`, which SQL cannot express as one constraint. Referential
     * integrity is enforced in the service layer on write.
     */
    scopeId: uuid('scope_id'),
    status: grantStatusEnum('status').notNull().default('ACTIVE'),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    /** Null means open-ended. */
    validUntil: timestamp('valid_until', { withTimezone: true }),
    grantedByPersonId: uuid('granted_by_person_id'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'role_grants_person_fk',
    }).onDelete('cascade'),
    // Partial: revoking a grant and later re-issuing an identical one is
    // normal — an official steps down and returns the following season.
    liveUnique(
      'role_grants_unique',
      t.orgId,
      t.personId,
      t.role,
      t.scopeKind,
      t.scopeId,
      t.validFrom,
    ),
    index('role_grants_org_person_idx').on(t.orgId, t.personId),
    index('role_grants_scope_idx').on(t.scopeKind, t.scopeId),
  ],
);

/**
 * Who may act for a minor.
 *
 * The league runs youth competition, so children are in scope. Most guardians
 * will never create a login, which is exactly why this points at `persons` and
 * not at `users` — modelling guardianship as a login relationship silently
 * excludes the majority of the people it is meant to describe.
 */
export const guardianships = pgTable(
  'guardianships',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    minorPersonId: uuid('minor_person_id').notNull(),
    guardianPersonId: uuid('guardian_person_id').notNull(),
    relationship: text('relationship'),
    /** Whether this guardian may give consent, as distinct from being a contact. */
    canGiveConsent: boolean('can_give_consent').notNull().default(true),
    isEmergencyContact: boolean('is_emergency_contact').notNull().default(true),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the minor reaches the age of majority. */
    validUntil: timestamp('valid_until', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.minorPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'guardianships_minor_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.orgId, t.guardianPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'guardianships_guardian_fk',
    }).onDelete('cascade'),
    liveUnique('guardianships_unique', t.minorPersonId, t.guardianPersonId),
    index('guardianships_minor_idx').on(t.minorPersonId),
    index('guardianships_guardian_idx').on(t.guardianPersonId),
  ],
);

/**
 * Typed, queryable consent with provenance.
 *
 * Stored as rows rather than a JSON blob because the questions asked of it are
 * operational and time-sensitive: "who has not consented to photo
 * publication?", "prove this person opted in before we emailed them".
 * Withdrawal is a new row, not an edit — consent history is itself evidence.
 */
export const consents = pgTable(
  'consents',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull(),
    kind: consentKindEnum('kind').notNull(),
    state: consentStateEnum('state').notNull(),
    grantedBy: consentGrantedByEnum('granted_by').notNull().default('SELF'),
    /** Set when `grantedBy` is GUARDIAN. */
    grantedByPersonId: uuid('granted_by_person_id'),
    /** Where it came from — a form, a paper record, an import. Evidence. */
    source: text('source'),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.personId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'consents_person_fk',
    }).onDelete('cascade'),
    /**
     * NO ACTION rather than SET NULL.
     *
     * A composite FK's SET NULL nulls EVERY column in the reference, which
     * here would include org_id — and org_id is NOT NULL, so the delete would
     * fail at runtime with a confusing constraint error rather than doing what
     * was intended. NO ACTION says the honest thing instead: a person who
     * granted a consent cannot be hard-deleted while that record stands. That
     * is already the intended behaviour, since people are soft-deleted.
     */
    foreignKey({
      columns: [t.orgId, t.grantedByPersonId],
      foreignColumns: [persons.orgId, persons.id],
      name: 'consents_granted_by_fk',
    }),
    index('consents_person_kind_idx').on(t.personId, t.kind),
    index('consents_org_kind_state_idx').on(t.orgId, t.kind, t.state),
  ],
);

// --- relations ---------------------------------------------------------------

export const personsRelations = relations(persons, ({ one, many }) => ({
  organization: one(organizations, { fields: [persons.orgId], references: [organizations.id] }),
  user: one(users, { fields: [persons.userId], references: [users.id] }),
  roleGrants: many(roleGrants),
  consents: many(consents),
}));

export const roleGrantsRelations = relations(roleGrants, ({ one }) => ({
  person: one(persons, { fields: [roleGrants.personId], references: [persons.id] }),
  organization: one(organizations, { fields: [roleGrants.orgId], references: [organizations.id] }),
}));
