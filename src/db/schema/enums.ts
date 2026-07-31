import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Enums are used sparingly and only where the set of values is genuinely
 * closed and genuinely a category.
 *
 * The failure this avoids: the previous version of this schema had a
 * `competition_kind` enum containing QUALIFICATION, PROMOTION, RELEGATION and
 * PROVINCIALS — values lifted straight from a dropdown on the old website.
 * Promotion and relegation are *rules about a league table*, not kinds of
 * competition; "Provincials" is a competition run by somebody else. Encoding
 * a menu as a type is how a data model inherits another system's mistakes.
 */

// ---------------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------------

/**
 * Roles are fine-grained on purpose. A single "admin" role forces you to hand
 * the discipline officer the ability to issue refunds and the registrar the
 * ability to overturn suspensions.
 *
 * PLATFORM_OWNER is the only role that crosses league boundaries; it exists to
 * operate the platform, not to run a league.
 */
export const roleEnum = pgEnum('role', [
  'PLATFORM_OWNER',
  'LEAGUE_ADMIN',
  'REGISTRAR',
  'DISCIPLINE_OFFICER',
  'REFEREE_ASSIGNOR',
  'CLUB_ADMIN',
  'TEAM_MANAGER',
  'COACH',
  'REFEREE',
  'PLAYER',
]);

/**
 * A role is always granted over something. CLUB_ADMIN of *one* club, not of
 * every club — without this, any club administrator could edit every roster in
 * the league.
 */
export const scopeKindEnum = pgEnum('scope_kind', ['ORGANIZATION', 'CLUB', 'TEAM']);

export const grantStatusEnum = pgEnum('grant_status', [
  'INVITED',
  'ACTIVE',
  'SUSPENDED',
  'REVOKED',
]);

// ---------------------------------------------------------------------------
// Competition structure
// ---------------------------------------------------------------------------

/**
 * Only three, because these are three genuinely different algorithms for
 * resolving an outcome:
 *   ROUND_ROBIN — everyone plays everyone; a table decides it
 *   KNOCKOUT    — pairings; winners advance
 *   RANKING     — an order derived from other stages, with no matches of its own
 *                 (consolidating sectioned divisions, seeding a play-off)
 *
 * A sectioned Division 2, a two-legged cup tie, a group stage feeding a
 * bracket, and a promotion play-off are all *configurations* of these — not
 * new values.
 */
export const stageFormatEnum = pgEnum('stage_format', ['ROUND_ROBIN', 'KNOCKOUT', 'RANKING']);

/** How a level match or tie is resolved, where the stage allows a decision. */
export const tieBreakMethodEnum = pgEnum('tie_break_method', [
  'NONE',
  'EXTRA_TIME',
  'PENALTIES',
  'EXTRA_TIME_THEN_PENALTIES',
  'REPLAY',
  'AWAY_GOALS',
  'DRAWING_OF_LOTS',
  'COMMITTEE_DECISION',
]);

/** Where the teams in a stage group come from. Declarative, so it is data. */
export const entrySourceKindEnum = pgEnum('entry_source_kind', [
  'DIRECT_ENTRY', // entered this edition directly
  'STAGE_POSITION', // finished Nth in a named earlier stage group
  'STAGE_WINNER', // won a named earlier tie
  'STAGE_LOSER', // lost it — how a plate/consolation draw is fed
  'EXTERNAL_QUALIFIER', // arrived from a competition we do not run
  'BYE',
]);

export const seasonStatusEnum = pgEnum('season_status', [
  'PLANNED',
  'REGISTRATION_OPEN',
  'IN_PROGRESS',
  'COMPLETED',
  'ARCHIVED',
]);

export const editionStatusEnum = pgEnum('edition_status', [
  'DRAFT',
  'REGISTRATION_OPEN',
  'ENTRIES_CLOSED',
  'SCHEDULED',
  'IN_PROGRESS',
  'COMPLETED',
  'ABANDONED',
]);

export const entryStatusEnum = pgEnum('entry_status', [
  'ACTIVE',
  'WITHDRAWN',
  'DISQUALIFIED',
  'EXPUNGED', // withdrew and their results were struck from the record
]);

/** What a promotion rule does to the teams it selects. */
export const progressionKindEnum = pgEnum('progression_kind', [
  'PROMOTION',
  'RELEGATION',
  'PLAYOFF_QUALIFICATION',
  'CUP_QUALIFICATION',
  'RETENTION',
]);

// ---------------------------------------------------------------------------
// People, registration and eligibility
// ---------------------------------------------------------------------------

export const registrationStatusEnum = pgEnum('registration_status', [
  'PENDING',
  'ACTIVE',
  'SUSPENDED',
  'TRANSFERRED_OUT',
  'LAPSED',
]);

/**
 * Which date an age rule is measured against. "Under 21" is meaningless until
 * you say "as at what date" — and leagues genuinely differ. Making this data
 * is what stops the rule being hard-coded in a query somewhere.
 */
export const ageReferenceModeEnum = pgEnum('age_reference_mode', [
  'SEASON_START',
  'SEASON_END',
  'CALENDAR_YEAR_END',
  'FIXED_DATE',
  'MATCH_DATE',
]);

/**
 * Criminal record check state. A legal requirement in British Columbia for
 * anyone coaching minors, and something the old site tracks only on paper.
 */
export const screeningStatusEnum = pgEnum('screening_status', [
  'NOT_REQUIRED',
  'REQUIRED_NOT_STARTED',
  'SUBMITTED',
  'CLEARED',
  'EXPIRED',
  'REJECTED',
]);

/**
 * Consent is typed and queryable rather than a JSON blob, because the questions
 * asked of it are operational: "who has NOT consented to photo publication?"
 *
 * Note that photograph consent is split. Using a photo to verify identity at
 * the pitch and publishing that photo on a public team page are different acts
 * with different lawful bases, and a parent may reasonably permit one and
 * refuse the other.
 */
export const consentKindEnum = pgEnum('consent_kind', [
  'PHOTO_IDENTITY_VERIFICATION',
  'PHOTO_PUBLICATION',
  'CONTACT_BY_EMAIL',
  'CONTACT_BY_SMS',
  'NAME_PUBLICATION',
  'MEDICAL_EMERGENCY_TREATMENT',
]);

export const consentStateEnum = pgEnum('consent_state', ['GRANTED', 'REFUSED', 'WITHDRAWN']);

/** Who supplied a consent — the person, or someone with authority for them. */
export const consentGrantedByEnum = pgEnum('consent_granted_by', ['SELF', 'GUARDIAN', 'ADMIN']);

// ---------------------------------------------------------------------------
// Honours
// ---------------------------------------------------------------------------

/** A trophy can be won by a team or by an individual. */
export const honourRecipientKindEnum = pgEnum('honour_recipient_kind', ['TEAM', 'PERSON']);
