-- FIX-T11 round 2(Codex review-FIX-T11T12 jobs.ts:276): drizzle-kit 출력 그대로. 시도(attempt)는 전송 의도를 쓸 때만 센다(beginSend).
-- 전송 의도 없이 lease 가 만료된 횟수는 이 열에 따로 세고, 한도(PRE_INTENT_EXPIRY_LIMIT=5)에 이르면 보내지 않은 채 FAILED(lease_expired_before_intent).
ALTER TABLE "jobs" ADD COLUMN "lease_expired_before_intent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_lease_expired_before_intent_chk" CHECK ("jobs"."lease_expired_before_intent" >= 0);
