-- T20(결정 D22): 복원 훈련 기록(restore_drills, drizzle-kit 출력 그대로) + 끝난 작업 이력의 보존 정리 허용(아래 수기 부분).
CREATE TABLE "restore_drills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"export_run_id" uuid,
	"trigger" text NOT NULL,
	"tables_compared" integer NOT NULL,
	"rows_compared" integer NOT NULL,
	"assets_compared" integer NOT NULL,
	"result" text NOT NULL,
	"mismatch_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bundle_sha256" text,
	CONSTRAINT "restore_drills_result_chk" CHECK ("restore_drills"."result" in ('pass', 'fail')),
	CONSTRAINT "restore_drills_trigger_chk" CHECK ("restore_drills"."trigger" in ('cli', 'api', 'test'))
);
--> statement-breakpoint
ALTER TABLE "restore_drills" ADD CONSTRAINT "restore_drills_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "restore_drills_owner_started_idx" ON "restore_drills" USING btree ("owner_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
-- 수기: job_events 는 계속 추가 전용(UPDATE 금지, 일반 DELETE 금지). 예외는 보존 정리 하나 —
-- 같은 트랜잭션에서 set_config('cs.retention_sweep', 'on', true) 를 켜고, 부모 작업이 끝난 상태(CONFIRMED·FAILED·CANCELED)인 행만 지울 수 있다.
-- 앱은 지우기 전에 그 행들을 EXPORT_LOCAL_DIR/retention/ 아래 JSONL 로 내보낸다(packages/db/src/retention.ts).
CREATE FUNCTION "job_events_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('cs.retention_sweep', true), '') = 'on'
     AND EXISTS (SELECT 1 FROM "jobs" j WHERE j."id" = OLD."job_id" AND j."state" IN ('CONFIRMED', 'FAILED', 'CANCELED')) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'append_only_immutable: % 행은 수정·삭제할 수 없습니다(새 행을 추가하세요)', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
DROP TRIGGER "job_events_immutable" ON "job_events";--> statement-breakpoint
CREATE TRIGGER "job_events_immutable" BEFORE UPDATE OR DELETE ON "job_events"
  FOR EACH ROW EXECUTE FUNCTION "job_events_guard"();
