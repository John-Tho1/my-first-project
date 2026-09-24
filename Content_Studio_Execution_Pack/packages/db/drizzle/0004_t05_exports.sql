-- T05: 내보내기·복원 실행 기록(export_runs, restore_runs). 두 표는 export/restore 대상에서 제외한다(@cs/domain EXCLUDED_TABLES).
-- drizzle-kit 출력 그대로(손으로 바꾼 부분 없음, 이 머리 주석만 추가).
CREATE TABLE "export_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"format_version" integer NOT NULL,
	"manifest_sha256" text NOT NULL,
	"zip_bytes" bigint NOT NULL,
	"path" text NOT NULL,
	"status" text NOT NULL,
	"totals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "export_runs_status_chk" CHECK ("export_runs"."status" in ('completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "restore_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"preview" jsonb NOT NULL,
	"status" text NOT NULL,
	"committed_at" timestamp with time zone,
	"mode" text,
	"result" jsonb,
	CONSTRAINT "restore_runs_source_chk" CHECK ("restore_runs"."source" in ('upload', 'export_run')),
	CONSTRAINT "restore_runs_status_chk" CHECK ("restore_runs"."status" in ('previewed', 'committed', 'rejected', 'failed')),
	CONSTRAINT "restore_runs_mode_chk" CHECK ("restore_runs"."mode" is null or "restore_runs"."mode" in ('empty_only', 'add_missing'))
);
--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_runs" ADD CONSTRAINT "restore_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_runs_owner_created_idx" ON "export_runs" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "restore_runs_owner_created_idx" ON "restore_runs" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);