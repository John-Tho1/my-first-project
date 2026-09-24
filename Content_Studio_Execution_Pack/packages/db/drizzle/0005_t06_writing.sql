-- T06: 브랜드 프로필 버전 필드·인터뷰 답변·AI 작성 보조 실행 기록·경험 claim 확인(결정 D12).
-- drizzle-kit 출력에서 손으로 바꾼 부분:
--  1) brand_profiles_id_owner_uq(복합 unique)를 generation_runs 의 복합 FK 보다 먼저 만든다(생성 순서).
--  2) interview_answers·claim_confirmations 의 UPDATE·DELETE 를 막는 트리거(맨 끝, content_versions_immutable 과 같은 방식).
-- 기존 brand_profiles 행은 새 열의 기본값(tone='formal', 나머지 '[]')을 받는다.
CREATE TABLE "claim_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"claim_index" integer NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_confirmations_run_claim_uq" UNIQUE("run_id","claim_index"),
	CONSTRAINT "claim_confirmations_claim_index_chk" CHECK ("claim_confirmations"."claim_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"input_version_id" uuid NOT NULL,
	"brand_profile_id" uuid NOT NULL,
	"input_version_refs" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"status" text NOT NULL,
	"output_ref" uuid,
	"output_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "generation_runs_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "generation_runs_mode_chk" CHECK ("generation_runs"."mode" in ('outline', 'draft', 'revise')),
	CONSTRAINT "generation_runs_status_chk" CHECK ("generation_runs"."status" in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "interview_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"question_key" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_answers_question_key_chk" CHECK ("interview_answers"."question_key" in ('situation', 'judgment', 'takeaway'))
);
--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "tone" text DEFAULT 'formal' NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "avoid_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "cta_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD COLUMN "sample_texts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_id_owner_uq" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_tone_chk" CHECK ("brand_profiles"."tone" in ('formal', 'casual'));--> statement-breakpoint
ALTER TABLE "claim_confirmations" ADD CONSTRAINT "claim_confirmations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_confirmations" ADD CONSTRAINT "claim_confirmations_run_same_owner_fk" FOREIGN KEY ("run_id","owner_id") REFERENCES "public"."generation_runs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_input_version_id_content_versions_id_fk" FOREIGN KEY ("input_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_output_ref_content_versions_id_fk" FOREIGN KEY ("output_ref") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_content_same_owner_fk" FOREIGN KEY ("content_id","owner_id") REFERENCES "public"."contents"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_brand_same_owner_fk" FOREIGN KEY ("brand_profile_id","owner_id") REFERENCES "public"."brand_profiles"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_content_same_owner_fk" FOREIGN KEY ("content_id","owner_id") REFERENCES "public"."contents"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_runs_content_idx" ON "generation_runs" USING btree ("content_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "interview_answers_content_idx" ON "interview_answers" USING btree ("content_id","question_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE FUNCTION "append_only_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_immutable: % 행은 수정·삭제할 수 없습니다(새 행을 추가하세요)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "interview_answers_immutable" BEFORE UPDATE OR DELETE ON "interview_answers"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();--> statement-breakpoint
CREATE TRIGGER "claim_confirmations_immutable" BEFORE UPDATE OR DELETE ON "claim_confirmations"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();
