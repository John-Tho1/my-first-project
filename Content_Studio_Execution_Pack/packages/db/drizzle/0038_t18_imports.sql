-- T18(제안 결정 D32): Notion·Drive 선택 가져오기 원장(import_runs·import_items) + 가져온 출처 중복 방지 부분 unique(sources_owner_import_external_uq).
-- drizzle-kit 출력 그대로. 본문·자격 증명은 원장에 없다(본문은 captures.raw_text, 원본 checksum 은 source_versions.raw_hash). 기존 표의 행은 바꾸지 않는다.
CREATE TABLE "import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"external_path" text NOT NULL,
	"folder" text DEFAULT '' NOT NULL,
	"title" text,
	"format" text NOT NULL,
	"content_checksum" text,
	"byte_size" integer NOT NULL,
	"external_created_text" text,
	"decision" text NOT NULL,
	"skip_reason" text,
	"matched_source_id" uuid,
	"outcome" text,
	"target_capture_id" uuid,
	"target_source_id" uuid,
	"target_source_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_items_run_external_uq" UNIQUE("run_id","external_id"),
	CONSTRAINT "import_items_format_chk" CHECK ("import_items"."format" in ('md', 'txt', 'html', 'csv', 'other')),
	CONSTRAINT "import_items_decision_chk" CHECK ("import_items"."decision" in ('new', 'identical', 'conflict', 'skipped')),
	CONSTRAINT "import_items_outcome_chk" CHECK ("import_items"."outcome" is null or "import_items"."outcome" in ('imported', 'versioned', 'skipped_identical', 'skipped_unselected', 'skipped_conflict', 'skipped_unsupported', 'failed_changed')),
	CONSTRAINT "import_items_checksum_chk" CHECK ("import_items"."content_checksum" is null or "import_items"."content_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "import_items_skip_chk" CHECK (("import_items"."decision" = 'skipped') = ("import_items"."skip_reason" is not null)),
	CONSTRAINT "import_items_target_chk" CHECK (("import_items"."outcome" in ('imported', 'versioned')) = ("import_items"."target_capture_id" is not null and "import_items"."target_source_id" is not null and "import_items"."target_source_version_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"file_name" text,
	"file_checksum" text,
	"file_bytes" bigint,
	"status" text DEFAULT 'preview' NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	CONSTRAINT "import_runs_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "import_runs_source_kind_chk" CHECK ("import_runs"."source_kind" in ('notion_export', 'drive_export', 'mock_connector')),
	CONSTRAINT "import_runs_status_chk" CHECK ("import_runs"."status" in ('preview', 'committed', 'failed', 'canceled')),
	CONSTRAINT "import_runs_checksum_chk" CHECK (("import_runs"."source_kind" = 'mock_connector' and "import_runs"."file_checksum" is null) or ("import_runs"."source_kind" <> 'mock_connector' and "import_runs"."file_checksum" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "import_runs_committed_chk" CHECK (("import_runs"."status" = 'committed') = ("import_runs"."committed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_target_source_version_id_source_versions_id_fk" FOREIGN KEY ("target_source_version_id") REFERENCES "public"."source_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_run_same_owner_fk" FOREIGN KEY ("run_id","owner_id") REFERENCES "public"."import_runs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_capture_same_owner_fk" FOREIGN KEY ("target_capture_id","owner_id") REFERENCES "public"."captures"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_source_same_owner_fk" FOREIGN KEY ("target_source_id","owner_id") REFERENCES "public"."sources"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_items" ADD CONSTRAINT "import_items_matched_source_same_owner_fk" FOREIGN KEY ("matched_source_id","owner_id") REFERENCES "public"."sources"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_items_owner_capture_idx" ON "import_items" USING btree ("owner_id","target_capture_id");--> statement-breakpoint
CREATE INDEX "import_runs_owner_created_idx" ON "import_runs" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "sources_owner_import_external_uq" ON "sources" USING btree ("owner_id","external_provider","external_id") WHERE "sources"."external_provider" in ('notion_export', 'drive_export', 'mock_connector') and "sources"."external_id" is not null;