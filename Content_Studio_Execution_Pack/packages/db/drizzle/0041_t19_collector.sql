-- T19(제안 결정 D33): 허용 소스 수집(모의) — collector_sources(allowlist, 기본 꺼짐·주기 off)·collector_runs(미리보기 실행)·collected_items(판정 원장, 본문 없음·발췌만)·recommendation_dismissals(재추천 닫기).
-- drizzle-kit 출력 그대로(머리말 2줄만 더함). 자격 증명 열 없음. 기존 표의 행은 바꾸지 않는다.
CREATE TABLE "collected_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"external_key" text,
	"guid" text,
	"link" text,
	"link_normalized" text,
	"title" text,
	"excerpt" text DEFAULT '' NOT NULL,
	"published_text" text,
	"published_at" timestamp with time zone,
	"content_checksum" text NOT NULL,
	"raw_sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"outcome" text,
	"capture_id" uuid,
	"source_version_id" uuid,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collected_items_run_position_uq" UNIQUE("run_id","position"),
	CONSTRAINT "collected_items_decision_chk" CHECK ("collected_items"."decision" in ('new', 'duplicate', 'skipped')),
	CONSTRAINT "collected_items_reason_chk" CHECK (("collected_items"."decision" = 'new' and "collected_items"."reason" in ('new', 'updated')) or ("collected_items"."decision" = 'duplicate' and "collected_items"."reason" in ('same_item', 'existing_capture', 'in_feed')) or ("collected_items"."decision" = 'skipped' and "collected_items"."reason" in ('no_id', 'blocked_link', 'empty', 'too_long', 'limit'))),
	CONSTRAINT "collected_items_outcome_chk" CHECK ("collected_items"."outcome" is null or ("collected_items"."decision" = 'new' and "collected_items"."outcome" in ('accepted', 'not_selected', 'skipped_duplicate', 'failed_changed'))),
	CONSTRAINT "collected_items_accepted_chk" CHECK (("collected_items"."outcome" = 'accepted' and "collected_items"."capture_id" is not null and "collected_items"."source_version_id" is not null and "collected_items"."accepted_at" is not null) or ("collected_items"."outcome" is distinct from 'accepted' and "collected_items"."capture_id" is null and "collected_items"."source_version_id" is null and "collected_items"."accepted_at" is null)),
	CONSTRAINT "collected_items_checksum_chk" CHECK ("collected_items"."content_checksum" ~ '^[0-9a-f]{64}$' and "collected_items"."raw_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "collected_items_key_chk" CHECK ("collected_items"."external_key" is not null or "collected_items"."reason" in ('no_id', 'limit'))
);
--> statement-breakpoint
CREATE TABLE "collector_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"mode" text DEFAULT 'mock' NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "collector_runs_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "collector_runs_trigger_chk" CHECK ("collector_runs"."trigger" in ('manual', 'scheduled')),
	CONSTRAINT "collector_runs_mode_chk" CHECK ("collector_runs"."mode" = 'mock'),
	CONSTRAINT "collector_runs_status_chk" CHECK ("collector_runs"."status" in ('preview', 'accepted', 'discarded', 'failed', 'blocked')),
	CONSTRAINT "collector_runs_error_chk" CHECK (("collector_runs"."status" in ('failed', 'blocked')) = ("collector_runs"."error_code" is not null)),
	CONSTRAINT "collector_runs_accepted_chk" CHECK (("collector_runs"."status" = 'accepted') = ("collector_runs"."accepted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "collector_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"host" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"schedule" text DEFAULT 'off' NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_sources_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "collector_sources_owner_url_uq" UNIQUE("owner_id","normalized_url"),
	CONSTRAINT "collector_sources_kind_chk" CHECK ("collector_sources"."kind" in ('rss', 'atom', 'url')),
	CONSTRAINT "collector_sources_schedule_chk" CHECK ("collector_sources"."schedule" in ('off', 'daily', 'weekly')),
	CONSTRAINT "collector_sources_https_chk" CHECK ("collector_sources"."url" like 'https://%' and "collector_sources"."normalized_url" like 'https://%'),
	CONSTRAINT "collector_sources_status_chk" CHECK ("collector_sources"."last_status" is null or "collector_sources"."last_status" in ('preview', 'failed', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "recommendation_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"capture_id" uuid NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recommendation_dismissals_owner_capture_uq" UNIQUE("owner_id","capture_id")
);
--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_source_version_id_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_run_same_owner_fk" FOREIGN KEY ("run_id","owner_id") REFERENCES "public"."collector_runs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_source_same_owner_fk" FOREIGN KEY ("source_id","owner_id") REFERENCES "public"."collector_sources"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_capture_same_owner_fk" FOREIGN KEY ("capture_id","owner_id") REFERENCES "public"."captures"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_runs" ADD CONSTRAINT "collector_runs_source_same_owner_fk" FOREIGN KEY ("source_id","owner_id") REFERENCES "public"."collector_sources"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_sources" ADD CONSTRAINT "collector_sources_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_dismissals" ADD CONSTRAINT "recommendation_dismissals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_dismissals" ADD CONSTRAINT "recommendation_dismissals_capture_same_owner_fk" FOREIGN KEY ("capture_id","owner_id") REFERENCES "public"."captures"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collected_items_owner_key_idx" ON "collected_items" USING btree ("owner_id","source_id","external_key");--> statement-breakpoint
CREATE INDEX "collected_items_owner_capture_idx" ON "collected_items" USING btree ("owner_id","capture_id");--> statement-breakpoint
CREATE INDEX "collector_runs_owner_created_idx" ON "collector_runs" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collector_runs_source_idx" ON "collector_runs" USING btree ("source_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "collector_sources_owner_created_idx" ON "collector_sources" USING btree ("owner_id","created_at","id");