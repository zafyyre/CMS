CREATE TYPE "public"."import_entity_kind" AS ENUM('CLUB', 'TEAM', 'PERSON', 'VENUE', 'SEASON', 'COMPETITION', 'FIXTURE', 'RESULT', 'HONOUR_AWARD', 'STANDING');--> statement-breakpoint
CREATE TYPE "public"."import_record_status" AS ENUM('PENDING', 'MATCHED', 'NEW', 'NEEDS_REVIEW', 'PROMOTED', 'SKIPPED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."import_source_kind" AS ENUM('LEGACY_EXPORT', 'SCRAPE', 'CSV', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('STAGED', 'RESOLVED', 'PROMOTED', 'FAILED', 'DISCARDED');--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_kind" "import_entity_kind" NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL,
	"canonical_id" uuid NOT NULL,
	"confidence" real,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_person_id" uuid,
	"proposed_by_batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "entity_aliases_confidence_range" CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);
--> statement-breakpoint
CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_kind" "import_source_kind" NOT NULL,
	"source_digest" text NOT NULL,
	"status" "import_status" DEFAULT 'STAGED' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"records_total" integer DEFAULT 0 NOT NULL,
	"records_matched" integer DEFAULT 0 NOT NULL,
	"records_needing_review" integer DEFAULT 0 NOT NULL,
	"records_promoted" integer DEFAULT 0 NOT NULL,
	"records_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "import_batches_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "import_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"entity_kind" "import_entity_kind" NOT NULL,
	"source_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "import_record_status" DEFAULT 'PENDING' NOT NULL,
	"resolved_entity_id" uuid,
	"candidates" jsonb,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "import_records_batch_key_unique" UNIQUE("batch_id","entity_kind","source_key")
);
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_confirmed_by_fk" FOREIGN KEY ("org_id","confirmed_by_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_batch_fk" FOREIGN KEY ("org_id","proposed_by_batch_id") REFERENCES "public"."import_batches"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_records" ADD CONSTRAINT "import_records_batch_fk" FOREIGN KEY ("org_id","batch_id") REFERENCES "public"."import_batches"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_unique" ON "entity_aliases" USING btree ("org_id","entity_kind","normalized_alias") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "entity_aliases_canonical_idx" ON "entity_aliases" USING btree ("canonical_id");--> statement-breakpoint
CREATE INDEX "entity_aliases_trgm_idx" ON "entity_aliases" USING gin ("normalized_alias" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "import_batches_org_status_idx" ON "import_batches" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "import_batches_digest_unique" ON "import_batches" USING btree ("org_id","source_digest") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "import_records_batch_status_idx" ON "import_records" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "import_records_kind_idx" ON "import_records" USING btree ("org_id","entity_kind");