-- FIX-T08 round 3(Codex review-FIX2-T08): 파일 삭제 의도 재시도 backoff(실패 횟수·다음 시도 시각). 계속 실패하는 의도가 배치를 독점하지 않게 한다.
ALTER TABLE "assets" ADD COLUMN "pending_delete_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "pending_delete_next_at" timestamp with time zone;