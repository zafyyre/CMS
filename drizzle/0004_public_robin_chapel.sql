-- Phase 4: competition rules and standings snapshots.
--
-- Ordering checked by hand, as for 0003. competition_rules is created with its
-- UNIQUE(org_id, id) inline and before the ALTER TABLE statements that
-- reference it, so nothing needed moving.
--
-- The two ALTER TYPE ... ADD VALUE statements are safe inside drizzle's
-- per-file transaction because nothing in this migration USES the new values.
-- PostgreSQL only rejects an added enum value that is referenced before the
-- transaction adding it commits.
CREATE TYPE "public"."tie_breaker" AS ENUM('GOAL_DIFFERENCE', 'GOALS_FOR', 'GOALS_AGAINST', 'HEAD_TO_HEAD_POINTS', 'HEAD_TO_HEAD_GOAL_DIFFERENCE', 'WINS', 'AWAY_GOALS_SCORED', 'DISCIPLINE_POINTS', 'DRAWING_OF_LOTS');--> statement-breakpoint
ALTER TYPE "public"."match_event_type" ADD VALUE 'MVP';--> statement-breakpoint
ALTER TYPE "public"."match_event_type" ADD VALUE 'CLEAN_SHEET';--> statement-breakpoint
CREATE TABLE "competition_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"points_for_win" integer DEFAULT 3 NOT NULL,
	"points_for_draw" integer DEFAULT 1 NOT NULL,
	"points_for_loss" integer DEFAULT 0 NOT NULL,
	"tie_breakers" "tie_breaker"[] DEFAULT '{"GOAL_DIFFERENCE","GOALS_FOR","HEAD_TO_HEAD_POINTS","WINS"}' NOT NULL,
	"forfeit_winner_goals" integer DEFAULT 3 NOT NULL,
	"forfeit_loser_goals" integer DEFAULT 0 NOT NULL,
	"forfeit_counts_as_played" boolean DEFAULT true NOT NULL,
	"yellow_card_points" integer DEFAULT 1 NOT NULL,
	"red_card_points" integer DEFAULT 3 NOT NULL,
	"published_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "competition_rules_org_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "competition_rules_points_ordered" CHECK (points_for_win >= points_for_draw AND points_for_draw >= points_for_loss),
	CONSTRAINT "competition_rules_forfeit_scoreline" CHECK (forfeit_winner_goals >= 0 AND forfeit_loser_goals >= 0
          AND forfeit_winner_goals >= forfeit_loser_goals),
	CONSTRAINT "competition_rules_discipline_weights" CHECK (yellow_card_points >= 0 AND red_card_points >= 0)
);
--> statement-breakpoint
CREATE TABLE "standings_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"edition_entry_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"played" integer DEFAULT 0 NOT NULL,
	"won" integer DEFAULT 0 NOT NULL,
	"drawn" integer DEFAULT 0 NOT NULL,
	"lost" integer DEFAULT 0 NOT NULL,
	"goals_for" integer DEFAULT 0 NOT NULL,
	"goals_against" integer DEFAULT 0 NOT NULL,
	"goal_difference" integer DEFAULT 0 NOT NULL,
	"points_earned" integer DEFAULT 0 NOT NULL,
	"points_adjustment" integer DEFAULT 0 NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"discipline_points" integer DEFAULT 0 NOT NULL,
	"form" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"basis" text NOT NULL,
	"requires_manual_resolution" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "standings_rows_snapshot_entry_unique" UNIQUE("snapshot_id","edition_entry_id"),
	CONSTRAINT "standings_rows_position_positive" CHECK (position >= 1),
	CONSTRAINT "standings_rows_counts_consistent" CHECK (played = won + drawn + lost
          AND won >= 0 AND drawn >= 0 AND lost >= 0
          AND goals_for >= 0 AND goals_against >= 0
          AND goal_difference = goals_for - goals_against
          AND points = points_earned + points_adjustment)
);
--> statement-breakpoint
CREATE TABLE "standings_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"stage_group_id" uuid NOT NULL,
	"rules_id" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"results_through" timestamp with time zone,
	"fixtures_counted" integer DEFAULT 0 NOT NULL,
	"fixtures_disputed" integer DEFAULT 0 NOT NULL,
	"fixtures_outstanding" integer DEFAULT 0 NOT NULL,
	"requires_manual_resolution" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "standings_snapshots_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "competition_rules" ADD CONSTRAINT "competition_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_rows" ADD CONSTRAINT "standings_rows_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_rows" ADD CONSTRAINT "standings_rows_snapshot_fk" FOREIGN KEY ("org_id","snapshot_id") REFERENCES "public"."standings_snapshots"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_rows" ADD CONSTRAINT "standings_rows_entry_fk" FOREIGN KEY ("org_id","edition_entry_id") REFERENCES "public"."edition_entries"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_snapshots" ADD CONSTRAINT "standings_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_snapshots" ADD CONSTRAINT "standings_snapshots_group_fk" FOREIGN KEY ("org_id","stage_group_id") REFERENCES "public"."stage_groups"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standings_snapshots" ADD CONSTRAINT "standings_snapshots_rules_fk" FOREIGN KEY ("org_id","rules_id") REFERENCES "public"."competition_rules"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_rules_org_slug_unique" ON "competition_rules" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "standings_rows_snapshot_position_idx" ON "standings_rows" USING btree ("snapshot_id","position");--> statement-breakpoint
CREATE INDEX "standings_snapshots_group_computed_idx" ON "standings_snapshots" USING btree ("stage_group_id","computed_at");--> statement-breakpoint
ALTER TABLE "competition_editions" ADD CONSTRAINT "competition_editions_rules_fk" FOREIGN KEY ("org_id","rules_id") REFERENCES "public"."competition_rules"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_rules_fk" FOREIGN KEY ("org_id","rules_id") REFERENCES "public"."competition_rules"("org_id","id") ON DELETE no action ON UPDATE no action;