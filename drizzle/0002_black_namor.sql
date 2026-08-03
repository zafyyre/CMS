-- Reordered by hand after generation.
--
-- drizzle-kit emitted the composite FOREIGN KEY constraints before the
-- UNIQUE(org_id, id) constraints they reference, so the migration failed with
-- "there is no unique constraint matching given keys". PostgreSQL requires the
-- referenced unique constraint to exist first, so the order is:
--   1. drop the old single-column FKs
--   2. add UNIQUE(org_id, id) on every referenced table
--   3. add the composite FKs
ALTER TABLE "consents" DROP CONSTRAINT "consents_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT "consents_granted_by_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "guardianships" DROP CONSTRAINT "guardianships_minor_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "guardianships" DROP CONSTRAINT "guardianships_guardian_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "role_grants" DROP CONSTRAINT "role_grants_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "competition_editions" DROP CONSTRAINT "competition_editions_series_id_competition_series_id_fk";
--> statement-breakpoint
ALTER TABLE "competition_editions" DROP CONSTRAINT "competition_editions_season_id_seasons_id_fk";
--> statement-breakpoint
ALTER TABLE "competition_series" DROP CONSTRAINT "competition_series_ladder_id_ladders_id_fk";
--> statement-breakpoint
ALTER TABLE "competition_series" DROP CONSTRAINT "competition_series_operated_by_body_id_governing_bodies_id_fk";
--> statement-breakpoint
ALTER TABLE "honour_awards" DROP CONSTRAINT "honour_awards_honour_id_honours_id_fk";
--> statement-breakpoint
ALTER TABLE "honour_awards" DROP CONSTRAINT "honour_awards_season_id_seasons_id_fk";
--> statement-breakpoint
ALTER TABLE "honour_awards" DROP CONSTRAINT "honour_awards_edition_id_competition_editions_id_fk";
--> statement-breakpoint
ALTER TABLE "honours" DROP CONSTRAINT "honours_series_id_competition_series_id_fk";
--> statement-breakpoint
ALTER TABLE "progression_rules" DROP CONSTRAINT "progression_rules_stage_group_id_stage_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "progression_rules" DROP CONSTRAINT "progression_rules_target_series_id_competition_series_id_fk";
--> statement-breakpoint
ALTER TABLE "seasons" DROP CONSTRAINT "seasons_registration_year_id_registration_years_id_fk";
--> statement-breakpoint
ALTER TABLE "stage_entry_sources" DROP CONSTRAINT "stage_entry_sources_stage_group_id_stage_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "stage_groups" DROP CONSTRAINT "stage_groups_stage_id_stages_id_fk";
--> statement-breakpoint
ALTER TABLE "stages" DROP CONSTRAINT "stages_edition_id_competition_editions_id_fk";
--> statement-breakpoint
ALTER TABLE "edition_entries" DROP CONSTRAINT "edition_entries_edition_id_competition_editions_id_fk";
--> statement-breakpoint
ALTER TABLE "edition_entries" DROP CONSTRAINT "edition_entries_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "eligibility_rules" DROP CONSTRAINT "eligibility_rules_profile_id_eligibility_profiles_id_fk";
--> statement-breakpoint
ALTER TABLE "person_registrations" DROP CONSTRAINT "person_registrations_person_id_persons_id_fk";
--> statement-breakpoint
ALTER TABLE "person_registrations" DROP CONSTRAINT "person_registrations_edition_entry_id_edition_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "person_registrations" DROP CONSTRAINT "person_registrations_season_id_seasons_id_fk";
--> statement-breakpoint
ALTER TABLE "stage_group_entries" DROP CONSTRAINT "stage_group_entries_stage_group_id_stage_groups_id_fk";
--> statement-breakpoint
ALTER TABLE "stage_group_entries" DROP CONSTRAINT "stage_group_entries_edition_entry_id_edition_entries_id_fk";
--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_club_id_clubs_id_fk";
--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "competition_editions" ADD CONSTRAINT "competition_editions_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "competition_series" ADD CONSTRAINT "competition_series_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "governing_bodies" ADD CONSTRAINT "governing_bodies_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "honours" ADD CONSTRAINT "honours_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "ladders" ADD CONSTRAINT "ladders_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "registration_years" ADD CONSTRAINT "registration_years_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "stage_groups" ADD CONSTRAINT "stage_groups_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "edition_entries" ADD CONSTRAINT "edition_entries_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "eligibility_profiles" ADD CONSTRAINT "eligibility_profiles_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_key" UNIQUE("org_id","id");
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_granted_by_fk" FOREIGN KEY ("org_id","granted_by_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_minor_fk" FOREIGN KEY ("org_id","minor_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_guardian_fk" FOREIGN KEY ("org_id","guardian_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "competition_editions" ADD CONSTRAINT "competition_editions_series_fk" FOREIGN KEY ("org_id","series_id") REFERENCES "public"."competition_series"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "competition_editions" ADD CONSTRAINT "competition_editions_season_fk" FOREIGN KEY ("org_id","season_id") REFERENCES "public"."seasons"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "competition_series" ADD CONSTRAINT "competition_series_ladder_fk" FOREIGN KEY ("org_id","ladder_id") REFERENCES "public"."ladders"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "competition_series" ADD CONSTRAINT "competition_series_body_fk" FOREIGN KEY ("org_id","operated_by_body_id") REFERENCES "public"."governing_bodies"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "honour_awards" ADD CONSTRAINT "honour_awards_honour_fk" FOREIGN KEY ("org_id","honour_id") REFERENCES "public"."honours"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "honour_awards" ADD CONSTRAINT "honour_awards_season_fk" FOREIGN KEY ("org_id","season_id") REFERENCES "public"."seasons"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "honour_awards" ADD CONSTRAINT "honour_awards_edition_fk" FOREIGN KEY ("org_id","edition_id") REFERENCES "public"."competition_editions"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "honours" ADD CONSTRAINT "honours_series_fk" FOREIGN KEY ("org_id","series_id") REFERENCES "public"."competition_series"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_group_fk" FOREIGN KEY ("org_id","stage_group_id") REFERENCES "public"."stage_groups"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "progression_rules" ADD CONSTRAINT "progression_rules_target_series_fk" FOREIGN KEY ("org_id","target_series_id") REFERENCES "public"."competition_series"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_registration_year_fk" FOREIGN KEY ("org_id","registration_year_id") REFERENCES "public"."registration_years"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_entry_sources" ADD CONSTRAINT "stage_entry_sources_group_fk" FOREIGN KEY ("org_id","stage_group_id") REFERENCES "public"."stage_groups"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_groups" ADD CONSTRAINT "stage_groups_stage_fk" FOREIGN KEY ("org_id","stage_id") REFERENCES "public"."stages"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_edition_fk" FOREIGN KEY ("org_id","edition_id") REFERENCES "public"."competition_editions"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "edition_entries" ADD CONSTRAINT "edition_entries_edition_fk" FOREIGN KEY ("org_id","edition_id") REFERENCES "public"."competition_editions"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "edition_entries" ADD CONSTRAINT "edition_entries_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "eligibility_rules" ADD CONSTRAINT "eligibility_rules_profile_fk" FOREIGN KEY ("org_id","profile_id") REFERENCES "public"."eligibility_profiles"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "person_registrations" ADD CONSTRAINT "person_registrations_person_fk" FOREIGN KEY ("org_id","person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "person_registrations" ADD CONSTRAINT "person_registrations_entry_fk" FOREIGN KEY ("org_id","edition_entry_id") REFERENCES "public"."edition_entries"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "person_registrations" ADD CONSTRAINT "person_registrations_season_fk" FOREIGN KEY ("org_id","season_id") REFERENCES "public"."seasons"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_group_entries" ADD CONSTRAINT "stage_group_entries_group_fk" FOREIGN KEY ("org_id","stage_group_id") REFERENCES "public"."stage_groups"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "stage_group_entries" ADD CONSTRAINT "stage_group_entries_entry_fk" FOREIGN KEY ("org_id","edition_entry_id") REFERENCES "public"."edition_entries"("org_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_club_fk" FOREIGN KEY ("org_id","club_id") REFERENCES "public"."clubs"("org_id","id") ON DELETE restrict ON UPDATE no action;
