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
// Match day
// ---------------------------------------------------------------------------

/**
 * What a team plays on.
 *
 * Genuinely closed and genuinely a category, so an enum is right here. Note
 * that the MUNICIPALITY a venue sits in is deliberately NOT an enum — the old
 * site has seventeen codes (VAN, BBY, SRY…) which are one league's geography,
 * and a second league arrives with a different list. That is a table.
 */
export const venueSurfaceEnum = pgEnum('venue_surface', [
  'GRASS',
  'ARTIFICIAL_TURF',
  'INDOOR',
  'UNKNOWN',
]);

/**
 * Where a fixture has got to.
 *
 * ABANDONED is distinct from CANCELLED: a cancelled match never started, an
 * abandoned one did and its events are already recorded. Conflating them
 * loses the cards shown before the referee took the teams off — which Phase 11
 * still has to act on. AWARDED covers a committee handing the result to one
 * side without it being played, which is not the same as a forfeit.
 */
export const fixtureStatusEnum = pgEnum('fixture_status', [
  'SCHEDULED',
  'POSTPONED',
  'CANCELLED',
  'PLAYED',
  'FORFEITED',
  'ABANDONED',
  'AWARDED',
]);

/** What kind of change a `fixture_changes` row records. */
export const fixtureChangeKindEnum = pgEnum('fixture_change_kind', [
  'SCHEDULED', // the fixture first appeared
  'RESCHEDULED', // kickoff moved
  'VENUE_CHANGED',
  'STATUS_CHANGED',
]);

/**
 * Who is telling us a score or an event.
 *
 * Authority is derived from this rather than stored, so a correction cannot be
 * laundered into a higher authority by editing a column. See
 * `src/server/match/result.ts`.
 */
export const matchReportSourceEnum = pgEnum('match_report_source', [
  'REFEREE',
  'HOME_TEAM',
  'AWAY_TEAM',
  'LEAGUE_ADMIN',
  'IMPORT', // historical data, believed but never authoritative over a human
]);

/**
 * What happened, and when in the match.
 *
 * `PENALTY_SHOOTOUT` is a separate period for a reason that bites every
 * football database eventually: shootout goals decide a tie but are NOT goals.
 * Counting them in a Golden Boot table is the classic version of this bug, and
 * it is only avoidable if the period is recorded at the time.
 */
export const matchPeriodEnum = pgEnum('match_period', [
  'FIRST_HALF',
  'SECOND_HALF',
  'EXTRA_TIME_FIRST',
  'EXTRA_TIME_SECOND',
  'PENALTY_SHOOTOUT',
]);

/**
 * One table feeds both the statistics engine (Phase 4) and discipline
 * (Phase 11), which is why cards are events rather than a column on a result.
 */
export const matchEventTypeEnum = pgEnum('match_event_type', [
  'GOAL',
  'OWN_GOAL',
  'PENALTY_SCORED',
  'PENALTY_MISSED',
  'YELLOW_CARD',
  'SECOND_YELLOW_CARD',
  'RED_CARD',
  'SUBSTITUTION',
  /**
   * Player of the match. An event rather than a column on the result, because
   * it is nominated by whoever filed the report and is therefore attributable
   * and retractable like everything else here. Filled in by the referee's match
   * report in Phase 10; the leaderboard that reads it exists now.
   */
  'MVP',
  /** Kept for the shutout leaderboard: the keeper who finished the match. */
  'CLEAN_SHEET',
]);

// ---------------------------------------------------------------------------
// Deciding a table
// ---------------------------------------------------------------------------

/**
 * The ordered chain applied when two teams finish level on points.
 *
 * This is the highest-consequence configuration in the system. Get the order
 * wrong and a team misses the play-offs in public, which is why it is data per
 * competition rather than logic in a query — leagues genuinely differ, and the
 * same league changes its mind between seasons.
 *
 * Points are always applied first and are not listed here.
 *
 * `DRAWING_OF_LOTS` is deliberately included even though no engine can compute
 * it. It is a real thing rulebooks say, and modelling it as a terminal marker —
 * "stop, a human must decide" — is honest. The alternative is an engine that
 * quietly invents an order and presents it as fact.
 */
export const tieBreakerEnum = pgEnum('tie_breaker', [
  'GOAL_DIFFERENCE',
  'GOALS_FOR',
  'GOALS_AGAINST', // fewer is better
  'HEAD_TO_HEAD_POINTS',
  'HEAD_TO_HEAD_GOAL_DIFFERENCE',
  'WINS',
  'AWAY_GOALS_SCORED',
  'DISCIPLINE_POINTS', // fewer is better
  'DRAWING_OF_LOTS',
]);

// ---------------------------------------------------------------------------
// Published content
// ---------------------------------------------------------------------------

/**
 * What kind of writing this is.
 *
 * Three values because the league genuinely publishes three things with
 * different lifecycles: news stays, a classified expires, and a weekly report
 * is a dated record people go back through. Not a filter widget copied from a
 * menu — the old site keeps these in three unrelated places, which is why its
 * constitution is findable and its weekly reports are not.
 */
export const articleKindEnum = pgEnum('article_kind', ['NEWS', 'NOTICE', 'WEEKLY_REPORT']);

// ---------------------------------------------------------------------------
// Historical import
// ---------------------------------------------------------------------------

/**
 * Where imported data came from.
 *
 * Recorded per batch because it decides how much the data is trusted: an export
 * handed over by the league outranks a scrape of its public pages, and both
 * outrank somebody retyping a printed table.
 */
export const importSourceKindEnum = pgEnum('import_source_kind', [
  'LEGACY_EXPORT',
  'SCRAPE',
  'CSV',
  'MANUAL',
]);

export const importStatusEnum = pgEnum('import_status', [
  'STAGED', // rows landed, nothing resolved
  'RESOLVED', // every row matched or flagged for review
  'PROMOTED', // written into the real tables
  'FAILED',
  'DISCARDED',
]);

/**
 * What an import row is about.
 *
 * Also the key entity aliases are scoped by: "Rutland Rovers" as a club name is
 * a different claim from "Rutland Rovers" as a team name, and a league has both.
 */
export const importEntityKindEnum = pgEnum('import_entity_kind', [
  'CLUB',
  'TEAM',
  'PERSON',
  'VENUE',
  'SEASON',
  'COMPETITION',
  'FIXTURE',
  'RESULT',
  'HONOUR_AWARD',
  'STANDING', // the source's own final table, kept for the diff
]);

export const importRecordStatusEnum = pgEnum('import_record_status', [
  'PENDING',
  'MATCHED', // resolved to an existing entity
  'NEW', // resolved as something to create
  'NEEDS_REVIEW', // a human must choose between candidates
  'PROMOTED',
  'SKIPPED',
  'FAILED',
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
