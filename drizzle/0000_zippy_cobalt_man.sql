CREATE TYPE "public"."age_reference_mode" AS ENUM('SEASON_START', 'SEASON_END', 'CALENDAR_YEAR_END', 'FIXED_DATE', 'MATCH_DATE');--> statement-breakpoint
CREATE TYPE "public"."consent_granted_by" AS ENUM('SELF', 'GUARDIAN', 'ADMIN');--> statement-breakpoint
CREATE TYPE "public"."consent_kind" AS ENUM('PHOTO_IDENTITY_VERIFICATION', 'PHOTO_PUBLICATION', 'CONTACT_BY_EMAIL', 'CONTACT_BY_SMS', 'NAME_PUBLICATION', 'MEDICAL_EMERGENCY_TREATMENT');--> statement-breakpoint
CREATE TYPE "public"."consent_state" AS ENUM('GRANTED', 'REFUSED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."edition_status" AS ENUM('DRAFT', 'REGISTRATION_OPEN', 'ENTRIES_CLOSED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."entry_source_kind" AS ENUM('DIRECT_ENTRY', 'STAGE_POSITION', 'STAGE_WINNER', 'STAGE_LOSER', 'EXTERNAL_QUALIFIER', 'BYE');--> statement-breakpoint
CREATE TYPE "public"."entry_status" AS ENUM('ACTIVE', 'WITHDRAWN', 'DISQUALIFIED', 'EXPUNGED');--> statement-breakpoint
CREATE TYPE "public"."grant_status" AS ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."honour_recipient_kind" AS ENUM('TEAM', 'PERSON');--> statement-breakpoint
CREATE TYPE "public"."progression_kind" AS ENUM('PROMOTION', 'RELEGATION', 'PLAYOFF_QUALIFICATION', 'CUP_QUALIFICATION', 'RETENTION');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'TRANSFERRED_OUT', 'LAPSED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('PLATFORM_OWNER', 'LEAGUE_ADMIN', 'REGISTRAR', 'DISCIPLINE_OFFICER', 'REFEREE_ASSIGNOR', 'CLUB_ADMIN', 'TEAM_MANAGER', 'COACH', 'REFEREE', 'PLAYER');--> statement-breakpoint
CREATE TYPE "public"."scope_kind" AS ENUM('ORGANIZATION', 'CLUB', 'TEAM');--> statement-breakpoint
CREATE TYPE "public"."screening_status" AS ENUM('NOT_REQUIRED', 'REQUIRED_NOT_STARTED', 'SUBMITTED', 'CLEARED', 'EXPIRED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('PLANNED', 'REGISTRATION_OPEN', 'IN_PROGRESS', 'COMPLETED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."stage_format" AS ENUM('ROUND_ROBIN', 'KNOCKOUT', 'RANKING');--> statement-breakpoint
CREATE TYPE "public"."tie_break_method" AS ENUM('NONE', 'EXTRA_TIME', 'PENALTIES', 'EXTRA_TIME_THEN_PENALTIES', 'REPLAY', 'AWAY_GOALS', 'DRAWING_OF_LOTS', 'COMMITTEE_DECISION');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid,
	"actor_user_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "org_domains_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"short_name" text,
	"timezone" text DEFAULT 'America/Vancouver' NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "consent_kind" NOT NULL,
	"state" "consent_state" NOT NULL,
	"granted_by" "consent_granted_by" DEFAULT 'SELF' NOT NULL,
	"granted_by_person_id" uuid,
	"source" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "guardianships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"minor_person_id" uuid NOT NULL,
	"guardian_person_id" uuid NOT NULL,
	"relationship" text,
	"can_give_consent" boolean DEFAULT true NOT NULL,
	"is_emergency_contact" boolean DEFAULT true NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "guardianships_unique" UNIQUE("minor_person_id","guardian_person_id")
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text,
	"given_name" text NOT NULL,
	"family_name" text NOT NULL,
	"display_name" text,
	"date_of_birth" date,
	"email" text,
	"phone" text,
	"photo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "role_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"scope_kind" "scope_kind" DEFAULT 'ORGANIZATION' NOT NULL,
	"scope_id" uuid,
	"status" "grant_status" DEFAULT 'ACTIVE' NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"granted_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "role_grants_unique" UNIQUE("org_id","person_id","role","scope_kind","scope_id","valid_from")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competition_editions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"series_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name_override" text,
	"tier" integer,
	"eligibility_profile_id" uuid,
	"rules_id" uuid,
	"entry_capacity" integer,
	"status" "edition_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "competition_editions_season_slug_unique" UNIQUE("season_id","slug")
);
--> statement-breakpoint
CREATE TABLE "competition_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ladder_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"founded_year" integer,
	"is_externally_operated" boolean DEFAULT false NOT NULL,
	"operated_by_body_id" uuid,
	"predecessor_series_id" uuid,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "competition_series_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "governing_bodies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"level" text,
	"parent_body_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "governing_bodies_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "honour_awards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"honour_id" uuid NOT NULL,
	"season_id" uuid,
	"edition_id" uuid,
	"team_id" uuid,
	"person_id" uuid,
	"recipient_name_snapshot" text,
	"value" integer,
	"awarded_on" date,
	"notes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "honours" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"recipient_kind" "honour_recipient_kind" DEFAULT 'TEAM' NOT NULL,
	"series_id" uuid,
	"established_year" integer,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "honours_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "ladders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"age_band_label" text,
	"default_eligibility_profile_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ladders_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "progression_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"stage_group_id" uuid NOT NULL,
	"kind" "progression_kind" NOT NULL,
	"from_position" integer NOT NULL,
	"to_position" integer NOT NULL,
	"target_series_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registration_years" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"slug" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"registration_opens_on" date,
	"registration_closes_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "registration_years_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"registration_year_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ordinal_in_year" integer DEFAULT 1 NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"roster_lock_on" date,
	"status" "season_status" DEFAULT 'PLANNED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "seasons_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "stage_entry_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"stage_group_id" uuid NOT NULL,
	"slot_number" integer NOT NULL,
	"kind" "entry_source_kind" NOT NULL,
	"source_stage_group_id" uuid,
	"source_position" integer,
	"external_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stage_entry_sources_slot_unique" UNIQUE("stage_group_id","slot_number")
);
--> statement-breakpoint
CREATE TABLE "stage_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"round_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stage_groups_stage_slug_unique" UNIQUE("stage_id","slug")
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"edition_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"format" "stage_format" NOT NULL,
	"legs_per_pairing" integer DEFAULT 1 NOT NULL,
	"legs_per_tie" integer DEFAULT 1 NOT NULL,
	"tie_break_method" "tie_break_method" DEFAULT 'NONE' NOT NULL,
	"has_third_place_playoff" boolean DEFAULT false NOT NULL,
	"enters_at_round" integer,
	"rules_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stages_edition_ordinal_unique" UNIQUE("edition_id","ordinal"),
	CONSTRAINT "stages_edition_slug_unique" UNIQUE("edition_id","slug")
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"short_name" text,
	"crest_url" text,
	"founded_year" integer,
	"contact_email" text,
	"contact_phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "clubs_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "edition_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"edition_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"status" "entry_status" DEFAULT 'ACTIVE' NOT NULL,
	"points_adjustment" integer DEFAULT 0 NOT NULL,
	"withdrawn_on" date,
	"withdrawal_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "edition_entries_unique" UNIQUE("edition_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "eligibility_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "eligibility_profiles_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE TABLE "eligibility_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"min_age" integer,
	"max_age" integer,
	"age_reference_mode" "age_reference_mode" DEFAULT 'SEASON_START' NOT NULL,
	"reference_date" date,
	"screening_required" "screening_status" DEFAULT 'NOT_REQUIRED' NOT NULL,
	"max_squad_size" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"edition_entry_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"status" "registration_status" DEFAULT 'PENDING' NOT NULL,
	"squad_number" integer,
	"valid_from" date NOT NULL,
	"valid_until" date,
	"screening_status" "screening_status" DEFAULT 'NOT_REQUIRED' NOT NULL,
	"screening_cleared_on" date,
	"screening_expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "stage_group_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"stage_group_id" uuid NOT NULL,
	"edition_entry_id" uuid NOT NULL,
	"slot_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "stage_group_entries_unique" UNIQUE("stage_group_id","edition_entry_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"designation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "teams_org_slug_unique" UNIQUE("org_id","slug")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domains" ADD CONSTRAINT "org_domains_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_granted_by_person_id_persons_id_fk" FOREIGN KEY ("granted_by_person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_minor_person_id_persons_id_fk" FOREIGN KEY ("minor_person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_guardian_person_id_persons_id_fk" FOREIGN KEY ("guardian_person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_editions" ADD CONSTRAINT "competition_editions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_editions" ADD CONSTRAINT "competition_editions_series_id_competition_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."competition_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_editions" ADD CONSTRAINT "competition_editions_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_series" ADD CONSTRAINT "competition_series_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_series" ADD CONSTRAINT "competition_series_ladder_id_ladders_id_fk" FOREIGN KEY ("ladder_id") REFERENCES "public"."ladders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competition_series" ADD CONSTRAINT "competition_series_operated_by_body_id_governing_bodies_id_fk" FOREIGN KEY ("operated_by_body_id") REFERENCES "public"."governing_bodies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governing_bodies" ADD CONSTRAINT "governing_bodies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honour_awards" ADD CONSTRAINT "honour_awards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honour_awards" ADD CONSTRAINT "honour_awards_honour_id_honours_id_fk" FOREIGN KEY ("honour_id") REFERENCES "public"."honours"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honour_awards" ADD CONSTRAINT "honour_awards_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honour_awards" ADD CONSTRAINT "honour_awards_edition_id_competition_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."competition_editions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honours" ADD CONSTRAINT "honours_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "honours" ADD CONSTRAINT "honours_series_id_competition_series_id_fk" FOREIGN KEY ("series_id") REFERENCES "public"."competition_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ladders" ADD CONSTRAINT "ladders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_stage_group_id_stage_groups_id_fk" FOREIGN KEY ("stage_group_id") REFERENCES "public"."stage_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_target_series_id_competition_series_id_fk" FOREIGN KEY ("target_series_id") REFERENCES "public"."competition_series"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_years" ADD CONSTRAINT "registration_years_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_registration_year_id_registration_years_id_fk" FOREIGN KEY ("registration_year_id") REFERENCES "public"."registration_years"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entry_sources" ADD CONSTRAINT "stage_entry_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_entry_sources" ADD CONSTRAINT "stage_entry_sources_stage_group_id_stage_groups_id_fk" FOREIGN KEY ("stage_group_id") REFERENCES "public"."stage_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_groups" ADD CONSTRAINT "stage_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_groups" ADD CONSTRAINT "stage_groups_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_edition_id_competition_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."competition_editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_entries" ADD CONSTRAINT "edition_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_entries" ADD CONSTRAINT "edition_entries_edition_id_competition_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."competition_editions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edition_entries" ADD CONSTRAINT "edition_entries_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_profiles" ADD CONSTRAINT "eligibility_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_rules" ADD CONSTRAINT "eligibility_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eligibility_rules" ADD CONSTRAINT "eligibility_rules_profile_id_eligibility_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."eligibility_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_registrations" ADD CONSTRAINT "person_registrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_registrations" ADD CONSTRAINT "person_registrations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_registrations" ADD CONSTRAINT "person_registrations_edition_entry_id_edition_entries_id_fk" FOREIGN KEY ("edition_entry_id") REFERENCES "public"."edition_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_registrations" ADD CONSTRAINT "person_registrations_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_group_entries" ADD CONSTRAINT "stage_group_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_group_entries" ADD CONSTRAINT "stage_group_entries_stage_group_id_stage_groups_id_fk" FOREIGN KEY ("stage_group_id") REFERENCES "public"."stage_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_group_entries" ADD CONSTRAINT "stage_group_entries_edition_entry_id_edition_entries_id_fk" FOREIGN KEY ("edition_entry_id") REFERENCES "public"."edition_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_created_idx" ON "audit_log" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "org_domains_hostname_idx" ON "org_domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "org_domains_org_idx" ON "org_domains" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "consents_person_kind_idx" ON "consents" USING btree ("person_id","kind");--> statement-breakpoint
CREATE INDEX "consents_org_kind_state_idx" ON "consents" USING btree ("org_id","kind","state");--> statement-breakpoint
CREATE INDEX "guardianships_minor_idx" ON "guardianships" USING btree ("minor_person_id");--> statement-breakpoint
CREATE INDEX "guardianships_guardian_idx" ON "guardianships" USING btree ("guardian_person_id");--> statement-breakpoint
CREATE INDEX "persons_org_idx" ON "persons" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "persons_org_name_idx" ON "persons" USING btree ("org_id","family_name","given_name");--> statement-breakpoint
CREATE INDEX "persons_user_idx" ON "persons" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "role_grants_org_person_idx" ON "role_grants" USING btree ("org_id","person_id");--> statement-breakpoint
CREATE INDEX "role_grants_scope_idx" ON "role_grants" USING btree ("scope_kind","scope_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_token_idx" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "two_factors_user_id_idx" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "competition_editions_org_season_idx" ON "competition_editions" USING btree ("org_id","season_id");--> statement-breakpoint
CREATE INDEX "competition_editions_series_idx" ON "competition_editions" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "competition_series_ladder_idx" ON "competition_series" USING btree ("ladder_id");--> statement-breakpoint
CREATE INDEX "honour_awards_honour_idx" ON "honour_awards" USING btree ("honour_id");--> statement-breakpoint
CREATE INDEX "honour_awards_org_season_idx" ON "honour_awards" USING btree ("org_id","season_id");--> statement-breakpoint
CREATE INDEX "progression_rules_group_idx" ON "progression_rules" USING btree ("stage_group_id");--> statement-breakpoint
CREATE INDEX "seasons_org_status_idx" ON "seasons" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "stage_entry_sources_org_idx" ON "stage_entry_sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stage_groups_org_idx" ON "stage_groups" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "stages_org_idx" ON "stages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "clubs_org_idx" ON "clubs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "clubs_name_idx" ON "clubs" USING btree ("name");--> statement-breakpoint
CREATE INDEX "edition_entries_org_idx" ON "edition_entries" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "edition_entries_team_idx" ON "edition_entries" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "eligibility_rules_profile_idx" ON "eligibility_rules" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "person_registrations_entry_idx" ON "person_registrations" USING btree ("edition_entry_id");--> statement-breakpoint
CREATE INDEX "person_registrations_person_idx" ON "person_registrations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_registrations_org_status_idx" ON "person_registrations" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "stage_group_entries_group_idx" ON "stage_group_entries" USING btree ("stage_group_id");--> statement-breakpoint
CREATE INDEX "teams_club_idx" ON "teams" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "teams_org_idx" ON "teams" USING btree ("org_id");