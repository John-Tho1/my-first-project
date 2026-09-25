-- T11(결정 D18): 작업 처리기 — jobs 열(heartbeat·마지막 오류·재시도 분류·최대 시도·조회 횟수·취소 요청·끝난 시각), 상태 CHECK 확장
-- (DONE → CONFIRMED, SENDING·REMOTE_PROCESSING·CANCEL_REQUESTED 추가), 진행 중 부분 unique 확장, 전송 의도(send_intents)·원격 결과(publications).
-- drizzle-kit 출력 순서는 그대로 두었다. 손으로 더한 부분: jobs_state_chk 를 다시 만들기 전에 DONE → CONFIRMED(T10 은 DONE 을 쓰지 않았다),
-- 맨 끝의 send_intents_guard(결과 한 번만 기록, 삭제 금지)·publications_guard(재확인 열만 변경, 삭제 금지) 트리거.
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"permalink" text,
	"result_kind" text NOT NULL,
	"remote_visibility" text NOT NULL,
	"verification" text NOT NULL,
	"is_mock" boolean NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publications_item_external_uq" UNIQUE("item_id","external_id"),
	CONSTRAINT "publications_result_kind_chk" CHECK ("publications"."result_kind" in ('UPLOADED_PRIVATE', 'SCHEDULED_REMOTE', 'PUBLISHED', 'MANUAL_REPORTED')),
	CONSTRAINT "publications_visibility_chk" CHECK ("publications"."remote_visibility" in ('private', 'unlisted', 'public', 'unknown')),
	CONSTRAINT "publications_verification_chk" CHECK ("publications"."verification" in ('MOCK', 'VERIFIED', 'UNVERIFIED', 'MANUAL_REPORTED')),
	CONSTRAINT "publications_mock_verification_chk" CHECK ("publications"."is_mock" = ("publications"."verification" = 'MOCK')),
	CONSTRAINT "publications_mock_external_chk" CHECK (not "publications"."is_mock" or "publications"."external_id" like 'mock:%'),
	CONSTRAINT "publications_mock_permalink_chk" CHECK (not "publications"."is_mock" or "publications"."permalink" is null or "publications"."permalink" like 'mock://%'),
	CONSTRAINT "publications_real_not_mock_chk" CHECK ("publications"."is_mock" or "publications"."external_id" not like 'mock:%')
);
--> statement-breakpoint
CREATE TABLE "send_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"intent_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"provider_request_id" text,
	"remote_external_id" text,
	"sanitized_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "send_intents_intent_key_uq" UNIQUE("intent_key"),
	CONSTRAINT "send_intents_job_attempt_uq" UNIQUE("job_id","attempt"),
	CONSTRAINT "send_intents_outcome_chk" CHECK ("send_intents"."outcome" in ('pending', 'accepted', 'rejected', 'ambiguous')),
	CONSTRAINT "send_intents_attempt_chk" CHECK ("send_intents"."attempt" >= 1),
	CONSTRAINT "send_intents_key_chk" CHECK ("send_intents"."intent_key" = "send_intents"."job_id"::text || ':' || "send_intents"."attempt"::text)
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_state_chk";--> statement-breakpoint
UPDATE "jobs" SET "state" = 'CONFIRMED' WHERE "state" = 'DONE';--> statement-breakpoint
DROP INDEX "jobs_active_item_uq";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "last_retry_class" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "reconcile_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_item_same_owner_fk" FOREIGN KEY ("item_id","owner_id") REFERENCES "public"."distribution_items"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_job_same_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "public"."jobs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_intents" ADD CONSTRAINT "send_intents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_intents" ADD CONSTRAINT "send_intents_job_same_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "public"."jobs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publications_item_idx" ON "publications" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_item_uq" ON "jobs" USING btree ("item_id") WHERE "jobs"."state" in ('QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'UNKNOWN', 'CANCEL_REQUESTED');--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_max_attempts_chk" CHECK ("jobs"."max_attempts" between 1 and 20);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_reconcile_count_chk" CHECK ("jobs"."reconcile_count" >= 0);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_retry_class_chk" CHECK ("jobs"."last_retry_class" is null or "jobs"."last_retry_class" in ('transient_no_side_effect', 'transient_unknown_side_effect', 'permanent', 'auth'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_lease_pair_chk" CHECK (("jobs"."lease_owner" is null) = ("jobs"."lease_until" is null));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_state_chk" CHECK ("jobs"."state" in ('QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'BLOCKED', 'RECONCILING', 'UNKNOWN', 'CANCEL_REQUESTED', 'CANCELED', 'CONFIRMED', 'FAILED'));--> statement-breakpoint
CREATE FUNCTION "send_intents_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'send_intents_guard: 전송 의도 기록은 삭제할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.outcome <> 'pending' THEN
    RAISE EXCEPTION 'send_intents_guard: 결과를 이미 기록한 전송 의도는 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.outcome = 'pending'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.attempt IS DISTINCT FROM OLD.attempt
    OR NEW.intent_key IS DISTINCT FROM OLD.intent_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'send_intents_guard: 전송 의도는 결과(submitted_at·outcome·provider_request_id·remote_external_id)를 한 번만 채울 수 있습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "send_intents_guard" BEFORE UPDATE OR DELETE ON "send_intents"
  FOR EACH ROW EXECUTE FUNCTION "send_intents_guard"();--> statement-breakpoint
CREATE FUNCTION "publications_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publications_guard: 원격 결과 기록은 삭제할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
    OR NEW.permalink IS DISTINCT FROM OLD.permalink
    OR NEW.result_kind IS DISTINCT FROM OLD.result_kind
    OR NEW.is_mock IS DISTINCT FROM OLD.is_mock
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publications_guard: 원격 결과는 재확인 열(verification·verified_at·remote_visibility)만 바꿀 수 있습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "publications_guard" BEFORE UPDATE OR DELETE ON "publications"
  FOR EACH ROW EXECUTE FUNCTION "publications_guard"();
