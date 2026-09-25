-- T08(결정 D9·D15): 업로드 세션·조각, 모의 음성 전사 job·전사 버전, assets.verification_scope·deleted_at, captures.capture_transcript_id,
-- usage_ledger 의 전사 job 연결(run_id 와 둘 중 하나). drizzle-kit 출력에 transcripts 추가 전용 트리거(0005 의 append_only_immutable 재사용)만 맨 끝에 덧붙였다.
CREATE TABLE "transcription_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"provider" text DEFAULT 'mock' NOT NULL,
	"model" text NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"transcript_version_id" uuid,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"keep_original" boolean DEFAULT true NOT NULL,
	"audio_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "transcription_jobs_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "transcription_jobs_state_chk" CHECK ("transcription_jobs"."state" in ('queued', 'running', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "transcription_jobs_progress_chk" CHECK ("transcription_jobs"."progress" between 0 and 100),
	CONSTRAINT "transcription_jobs_audio_seconds_chk" CHECK ("transcription_jobs"."audio_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcripts_job_version_uq" UNIQUE("job_id","version"),
	CONSTRAINT "transcripts_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "transcripts_created_by_chk" CHECK ("transcripts"."created_by" in ('mock', 'owner')),
	CONSTRAINT "transcripts_version_chk" CHECK ("transcripts"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "upload_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_chunks_session_index_uq" UNIQUE("session_id","chunk_index"),
	CONSTRAINT "upload_chunks_index_chk" CHECK ("upload_chunks"."chunk_index" >= 0 and "upload_chunks"."bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"declared_mime" text NOT NULL,
	"declared_bytes" bigint NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"chunk_size" integer NOT NULL,
	"checksum_expected" text,
	"checksum_actual" text,
	"state" text DEFAULT 'open' NOT NULL,
	"reject_reason" text,
	"asset_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_sessions_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "upload_sessions_kind_chk" CHECK ("upload_sessions"."kind" in ('audio', 'video')),
	CONSTRAINT "upload_sessions_state_chk" CHECK ("upload_sessions"."state" in ('open', 'completed', 'verified', 'rejected', 'aborted', 'expired')),
	CONSTRAINT "upload_sessions_bytes_chk" CHECK ("upload_sessions"."declared_bytes" > 0 and "upload_sessions"."received_bytes" >= 0),
	CONSTRAINT "upload_sessions_chunk_size_chk" CHECK ("upload_sessions"."chunk_size" between 4194304 and 8388608)
);
--> statement-breakpoint
ALTER TABLE "usage_ledger" ALTER COLUMN "run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "verification_scope" text DEFAULT 'signature_size_checksum' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "captures" ADD COLUMN "capture_transcript_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "transcription_job_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "audio_seconds" integer;--> statement-breakpoint
ALTER TABLE "transcription_jobs" ADD CONSTRAINT "transcription_jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcription_jobs" ADD CONSTRAINT "transcription_jobs_asset_same_owner_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."assets"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_job_same_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "public"."transcription_jobs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_chunks" ADD CONSTRAINT "upload_chunks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_chunks" ADD CONSTRAINT "upload_chunks_session_same_owner_fk" FOREIGN KEY ("session_id","owner_id") REFERENCES "public"."upload_sessions"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_asset_same_owner_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."assets"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcription_jobs_owner_asset_idx" ON "transcription_jobs" USING btree ("owner_id","asset_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transcription_jobs_state_idx" ON "transcription_jobs" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_jobs_active_asset_uq" ON "transcription_jobs" USING btree ("asset_id") WHERE "transcription_jobs"."state" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "upload_sessions_owner_created_idx" ON "upload_sessions" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "upload_sessions_state_expires_idx" ON "upload_sessions" USING btree ("state","expires_at");--> statement-breakpoint
ALTER TABLE "captures" ADD CONSTRAINT "captures_transcript_same_owner_fk" FOREIGN KEY ("capture_transcript_id","owner_id") REFERENCES "public"."transcripts"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_transcription_job_same_owner_fk" FOREIGN KEY ("transcription_job_id","owner_id") REFERENCES "public"."transcription_jobs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_transcription_job_uq" UNIQUE("transcription_job_id");--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_subject_chk" CHECK (num_nonnulls("usage_ledger"."run_id", "usage_ledger"."transcription_job_id") = 1);--> statement-breakpoint
CREATE TRIGGER "transcripts_immutable" BEFORE UPDATE OR DELETE ON "transcripts"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();
