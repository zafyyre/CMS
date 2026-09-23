CREATE TYPE "public"."article_kind" AS ENUM('NEWS', 'NOTICE', 'WEEKLY_REPORT');--> statement-breakpoint
CREATE TABLE "articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "article_kind" DEFAULT 'NEWS' NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"published_at" timestamp with time zone,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"author_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "articles_org_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "articles_expiry_after_publication" CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"category" text,
	"url" text NOT NULL,
	"size_label" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_url_is_http" CHECK (url ~* '^https?://')
);
--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "articles" ADD CONSTRAINT "articles_author_fk" FOREIGN KEY ("org_id","author_person_id") REFERENCES "public"."persons"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "articles_org_slug_unique" ON "articles" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "articles_org_published_idx" ON "articles" USING btree ("org_id","published_at");--> statement-breakpoint
CREATE INDEX "articles_org_kind_idx" ON "articles" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_org_slug_unique" ON "documents" USING btree ("org_id","slug") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "documents_org_category_idx" ON "documents" USING btree ("org_id","category");