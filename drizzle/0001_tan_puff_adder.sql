ALTER TABLE "org_domains" DROP CONSTRAINT "org_domains_hostname_unique";--> statement-breakpoint
ALTER TABLE "organizations" DROP CONSTRAINT "organizations_slug_unique";--> statement-breakpoint
ALTER TABLE "guardianships" DROP CONSTRAINT "guardianships_unique";--> statement-breakpoint
ALTER TABLE "role_grants" DROP CONSTRAINT "role_grants_unique";--> statement-breakpoint
ALTER TABLE "competition_editions" DROP CONSTRAINT "competition_editions_season_slug_unique";--> statement-breakpoint
ALTER TABLE "competition_series" DROP CONSTRAINT "competition_series_org_slug_unique";--> statement-breakpoint
ALTER TABLE "governing_bodies" DROP CONSTRAINT "governing_bodies_org_slug_unique";--> statement-breakpoint
ALTER TABLE "honours" DROP CONSTRAINT "honours_org_slug_unique";--> statement-breakpoint
ALTER TABLE "ladders" DROP CONSTRAINT "ladders_org_slug_unique";--> statement-breakpoint
ALTER TABLE "registration_years" DROP CONSTRAINT "registration_years_org_slug_unique";--> statement-breakpoint
ALTER TABLE "seasons" DROP CONSTRAINT "seasons_org_slug_unique";--> statement-breakpoint
ALTER TABLE "stage_entry_sources" DROP CONSTRAINT "stage_entry_sources_slot_unique";--> statement-breakpoint
ALTER TABLE "stage_groups" DROP CONSTRAINT "stage_groups_stage_slug_unique";--> statement-breakpoint
ALTER TABLE "stages" DROP CONSTRAINT "stages_edition_ordinal_unique";--> statement-breakpoint
ALTER TABLE "stages" DROP CONSTRAINT "stages_edition_slug_unique";--> statement-breakpoint
ALTER TABLE "clubs" DROP CONSTRAINT "clubs_org_slug_unique";--> statement-breakpoint
ALTER TABLE "edition_entries" DROP CONSTRAINT "edition_entries_unique";--> statement-breakpoint
ALTER TABLE "eligibility_profiles" DROP CONSTRAINT "eligibility_profiles_org_slug_unique";--> statement-breakpoint
ALTER TABLE "stage_group_entries" DROP CONSTRAINT "stage_group_entries_unique";--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_org_slug_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "org_domains_hostname_unique" ON "org_domains" USING btree ("hostname") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree ("slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "guardianships_unique" ON "guardianships" USING btree ("minor_person_id","guardian_person_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_grants_unique" ON "role_grants" USING btree ("org_id","person_id","role","scope_kind","scope_id","valid_from") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_editions_season_slug_unique" ON "competition_editions" USING btree ("season_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "competition_series_org_slug_unique" ON "competition_series" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "governing_bodies_org_slug_unique" ON "governing_bodies" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "honours_org_slug_unique" ON "honours" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ladders_org_slug_unique" ON "ladders" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_years_org_slug_unique" ON "registration_years" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "seasons_org_slug_unique" ON "seasons" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_entry_sources_slot_unique" ON "stage_entry_sources" USING btree ("stage_group_id","slot_number") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_groups_stage_slug_unique" ON "stage_groups" USING btree ("stage_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stages_edition_ordinal_unique" ON "stages" USING btree ("edition_id","ordinal") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stages_edition_slug_unique" ON "stages" USING btree ("edition_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clubs_org_slug_unique" ON "clubs" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "edition_entries_unique" ON "edition_entries" USING btree ("edition_id","team_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "eligibility_profiles_org_slug_unique" ON "eligibility_profiles" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "stage_group_entries_unique" ON "stage_group_entries" USING btree ("stage_group_id","edition_entry_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_org_slug_unique" ON "teams" USING btree ("org_id","slug") WHERE deleted_at IS NULL;