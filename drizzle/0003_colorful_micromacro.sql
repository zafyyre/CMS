-- Phase 3: venues, fixtures, results.
--
-- Ordering checked by hand before running, because 0002 had to be repaired for
-- exactly this: drizzle-kit emitted composite FOREIGN KEYs ahead of the
-- UNIQUE(org_id, id) constraints they reference. Here every referenced unique
-- is declared inline in its CREATE TABLE, and all of the CREATE TABLEs precede
-- all of the ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY statements, so the
-- generated order is already valid and nothing was moved.
CREATE TYPE "public"."fixture_change_kind" AS ENUM('SCHEDULED', 'RESCHEDULED', 'VENUE_CHANGED', 'STATUS_CHANGED');--> statement-breakpoint
CREATE TYPE "public"."fixture_status" AS ENUM('SCHEDULED', 'POSTPONED', 'CANCELLED', 'PLAYED', 'FORFEITED', 'ABANDONED', 'AWARDED');--> statement-breakpoint
CREATE TYPE "public"."match_event_type" AS ENUM('GOAL', 'OWN_GOAL', 'PENALTY_SCORED', 'PENALTY_MISSED', 'YELLOW_CARD', 'SECOND_YELLOW_CARD', 'RED_CARD', 'SUBSTITUTION');--> statement-breakpoint
CREATE TYPE "public"."match_period" AS ENUM('FIRST_HALF', 'SECOND_HALF', 'EXTRA_TIME_FIRST', 'EXTRA_TIME_SECOND', 'PENALTY_SHOOTOUT');--> statement-breakpoint
CREATE TYPE "public"."match_report_source" AS ENUM('REFEREE', 'HOME_TEAM', 'AWAY_TEAM', 'LEAGUE_ADMIN', 'IMPORT');--> statement-breakpoint
CREATE TYPE "public"."venue_surface" AS ENUM('GRASS', 'ARTIFICIAL_TURF', 'INDOOR', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "fixture_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"fixture_id" uuid NOT NULL,
	"kind" "fixture_change_kind" NOT NULL,
	"previous_kickoff_at" timestamp with time zone,
	"new_kickoff_at" timestamp with time zone,
	"previous_venue_id" uuid,
	"new_venue_id" uuid,
	"previous_status" "fixture_status",
	"new_status" "fixture_status",
	"reason" text NOT NULL,
	"changed_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixtures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"stage_group_id" uuid NOT NULL,
	"home_entry_id" uuid,
	"away_entry_id" uuid,
	"venue_id" uuid,
	"kickoff_at" timestamp with time zone,
	"round" integer,
	"matchday" integer,
	"leg" integer DEFAULT 1 NOT NULL,
	"status" "fixture_status" DEFAULT 'SCHEDULED' NOT NULL,
	"public_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "fixtures_org_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "fixtures_sides_distinct" CHECK (home_entry_id IS NULL OR away_entry_id IS NULL OR home_entry_id <> away_entry_id),
	CONSTRAINT "fixtures_leg_positive" CHECK (leg >= 1)
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"fixture_id" uuid NOT NULL,
	"edition_entry_id" uuid,
	"person_id" uuid,
	"related_person_id" uuid,
	"type" "match_event_type" NOT NULL,
	"period" "match_period" DEFAULT 'FIRST_HALF' NOT NULL,
	"minute" integer,
	"stoppage_minute" integer,
	"source" "match_report_source" DEFAULT 'REFEREE' NOT NULL,
	"recorded_by_person_id" uuid,
	"retracts_event_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_events_org_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "match_events_retracts_unique" UNIQUE("org_id","retracts_event_id"),
	CONSTRAINT "match_events_not_self" CHECK (retracts_event_id IS NULL OR retracts_event_id <> id),
	CONSTRAINT "match_events_minute_sane" CHECK ((minute IS NULL OR (minute >= 0 AND minute <= 200))
          AND (stoppage_minute IS NULL OR (stoppage_minute >= 0 AND stoppage_minute <= 60)))
);
--> statement-breakpoint
CREATE TABLE "municipalities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "municipalities_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "result_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"fixture_id" uuid NOT NULL,
	"source" "match_report_source" NOT NULL,
	"submitted_by_person_id" uuid,
	"home_score" integer,
	"away_score" integer,
	"home_forfeit" boolean DEFAULT false NOT NULL,
	"away_forfeit" boolean DEFAULT false NOT NULL,
	"home_penalties" integer,
	"away_penalties" integer,
	"supersedes_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "result_submissions_org_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "result_submissions_supersedes_unique" UNIQUE("org_id","supersedes_id"),
	CONSTRAINT "result_submissions_not_self" CHECK (supersedes_id IS NULL OR supersedes_id <> id),
	CONSTRAINT "result_submissions_scores_non_negative" CHECK ((home_score IS NULL OR home_score >= 0)
          AND (away_score IS NULL OR away_score >= 0)
          AND (home_penalties IS NULL OR home_penalties >= 0)
          AND (away_penalties IS NULL OR away_penalties >= 0)),
	CONSTRAINT "result_submissions_single_forfeit" CHECK (NOT (home_forfeit AND away_forfeit))
);
--> statement-breakpoint
CREATE TABLE "venue_closures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"venue_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"reason" text NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "venue_closures_window_ordered" CHECK (ends_at IS NULL OR ends_at > starts_at)
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"parent_venue_id" uuid,
	"municipality_id" uuid,
	"surface" "venue_surface" DEFAULT 'UNKNOWN' NOT NULL,
	"is_floodlit" boolean DEFAULT false NOT NULL,
	"address" text,
	"latitude" double precision,
	"longitude" double precision,
	"map_url" text,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "venues_org_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "venues_parent_not_self" CHECK (parent_venue_id IS NULL OR parent_venue_id <> id),
	CONSTRAINT "venues_coordinates_in_range" CHECK ((latitude IS NULL OR (latitude >= -90 AND latitude <= 90))
          AND (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)))
);
--> statement-breakpoint
ALTER TABLE "fixture_changes" ADD CONSTRAINT "fixture_changes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_changes" ADD CONSTRAINT "fixture_changes_fixture_fk" FOREIGN KEY ("org_id","fixture_id") REFERENCES "public"."fixtures"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixture_changes" ADD CONSTRAINT "fixture_changes_person_fk" FOREIGN KEY ("org_id","changed_by_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_stage_group_fk" FOREIGN KEY ("org_id","stage_group_id") REFERENCES "public"."stage_groups"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_home_entry_fk" FOREIGN KEY ("org_id","home_entry_id") REFERENCES "public"."edition_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_away_entry_fk" FOREIGN KEY ("org_id","away_entry_id") REFERENCES "public"."edition_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixtures" ADD CONSTRAINT "fixtures_venue_fk" FOREIGN KEY ("org_id","venue_id") REFERENCES "public"."venues"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_fixture_fk" FOREIGN KEY ("org_id","fixture_id") REFERENCES "public"."fixtures"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_entry_fk" FOREIGN KEY ("org_id","edition_entry_id") REFERENCES "public"."edition_entries"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_related_person_fk" FOREIGN KEY ("org_id","related_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_recorded_by_fk" FOREIGN KEY ("org_id","recorded_by_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_retracts_fk" FOREIGN KEY ("org_id","retracts_event_id") REFERENCES "public"."match_events"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "municipalities" ADD CONSTRAINT "municipalities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_fixture_fk" FOREIGN KEY ("org_id","fixture_id") REFERENCES "public"."fixtures"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_person_fk" FOREIGN KEY ("org_id","submitted_by_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_submissions" ADD CONSTRAINT "result_submissions_supersedes_fk" FOREIGN KEY ("org_id","supersedes_id") REFERENCES "public"."result_submissions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_closures" ADD CONSTRAINT "venue_closures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_closures" ADD CONSTRAINT "venue_closures_venue_fk" FOREIGN KEY ("org_id","venue_id") REFERENCES "public"."venues"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_parent_fk" FOREIGN KEY ("org_id","parent_venue_id") REFERENCES "public"."venues"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_municipality_fk" FOREIGN KEY ("org_id","municipality_id") REFERENCES "public"."municipalities"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fixture_changes_fixture_idx" ON "fixture_changes" USING btree ("fixture_id","created_at");--> statement-breakpoint
CREATE INDEX "fixture_changes_org_created_idx" ON "fixture_changes" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "fixtures_org_kickoff_idx" ON "fixtures" USING btree ("org_id","kickoff_at");--> statement-breakpoint
CREATE INDEX "fixtures_group_idx" ON "fixtures" USING btree ("stage_group_id");--> statement-breakpoint
CREATE INDEX "fixtures_home_entry_idx" ON "fixtures" USING btree ("home_entry_id");--> statement-breakpoint
CREATE INDEX "fixtures_away_entry_idx" ON "fixtures" USING btree ("away_entry_id");--> statement-breakpoint
CREATE INDEX "fixtures_venue_kickoff_idx" ON "fixtures" USING btree ("venue_id","kickoff_at");--> statement-breakpoint
CREATE INDEX "match_events_fixture_idx" ON "match_events" USING btree ("fixture_id");--> statement-breakpoint
CREATE INDEX "match_events_person_type_idx" ON "match_events" USING btree ("person_id","type");--> statement-breakpoint
CREATE INDEX "match_events_org_type_idx" ON "match_events" USING btree ("org_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "municipalities_org_code_unique" ON "municipalities" USING btree ("org_id","code") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "municipalities_org_idx" ON "municipalities" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "result_submissions_fixture_idx" ON "result_submissions" USING btree ("fixture_id","created_at");--> statement-breakpoint
CREATE INDEX "venue_closures_venue_idx" ON "venue_closures" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "venue_closures_org_window_idx" ON "venue_closures" USING btree ("org_id","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "venues_org_slug_unique" ON "venues" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "venues_org_idx" ON "venues" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "venues_municipality_idx" ON "venues" USING btree ("municipality_id");--> statement-breakpoint
CREATE INDEX "venues_parent_idx" ON "venues" USING btree ("parent_venue_id");