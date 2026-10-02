-- FIX-T14(Codex review-T14 missed case): jobs.resume_count — 원격 처리 지연(REMOTE_PROCESSING) 뒤 재개(resume) 횟수. 장애가 아니므로 시도 한도에서 뺀다
-- (센 시도 = attempt - resume_count, 상한 FREE_RESUME_MAX 는 앱). drizzle-kit 출력 그대로. P0(adapter_id 없는 옛 전송 의도)는 데이터 이전 대신 앱이
-- 명시적으로 mock_generic 으로 읽는다(LEGACY_SEND_ADAPTER_ID) — 결과를 기록한 의도는 불변(send_intents_guard)이고, 복원한 이전 묶음의 의도에도 같은 규칙이 필요하다.
ALTER TABLE "jobs" ADD COLUMN "resume_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_resume_count_chk" CHECK ("jobs"."resume_count" >= 0 and "jobs"."resume_count" <= "jobs"."attempt");
