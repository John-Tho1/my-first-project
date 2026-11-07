CREATE TYPE "public"."capture_input_type" AS ENUM('text', 'url', 'file', 'voice');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"checksum" text NOT NULL,
	"rights_status" text DEFAULT 'unknown' NOT NULL,
	"verification_state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"version_or_hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"sanitized_details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"pen_name" text NOT NULL,
	"audience" text NOT NULL,
	"pillars" jsonb NOT NULL,
	"style_rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_profiles_owner_version_uq" UNIQUE("owner_id","version")
);
--> statement-breakpoint
CREATE TABLE "captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"raw_text" text NOT NULL,
	"input_type" "capture_input_type" NOT NULL,
	"source_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"risk" text DEFAULT 'none' NOT NULL,
	"user_note" text,
	"command_key" text NOT NULL,
	CONSTRAINT "captures_owner_command_key_uq" UNIQUE("owner_id","command_key")
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"ai_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_versions_content_version_uq" UNIQUE("content_id","version")
);
--> statement-breakpoint
CREATE TABLE "contents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"idea_id" uuid,
	"series" text,
	"title" text NOT NULL,
	"current_version_id" uuid,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"idea" text NOT NULL,
	"audience" text,
	"next_question" text,
	"risk" text DEFAULT 'none' NOT NULL,
	"lifecycle" text DEFAULT 'candidate' NOT NULL,
	"source_capture_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ideas_id_owner_uq" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "source_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"raw_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"excerpt" text,
	"extraction_state" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"canonical_url" text,
	"external_provider" text,
	"external_id" text,
	"external_revision" text,
	"checked_at" timestamp with time zone,
	"content_hash" text,
	"rights_status" text DEFAULT 'unknown' NOT NULL,
	CONSTRAINT "sources_id_owner_uq" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"allowed_identity" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_allowed_identity_unique" UNIQUE("allowed_identity")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_source_same_owner_fk" FOREIGN KEY ("source_id","owner_id") REFERENCES "public"."sources"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_content_id_contents_id_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_idea_same_owner_fk" FOREIGN KEY ("idea_id","owner_id") REFERENCES "public"."ideas"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_versions" ADD CONSTRAINT "source_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;