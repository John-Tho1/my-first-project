-- FIX-T08 round 2(Codex review-FIX-T08): 원음 삭제 의도(pending_delete_key). drizzle-kit 출력에 채움만 덧붙였다:
-- 이미 지운 원본(deleted_at)은 이전 구현에서 파일 삭제 실패가 무시됐을 수 있으므로 현재 key 를 삭제 대상으로 기록해 worker 가 다시 지우게 한다.
ALTER TABLE "assets" ADD COLUMN "pending_delete_key" text;--> statement-breakpoint
UPDATE "assets" SET "pending_delete_key" = "key" WHERE "deleted_at" IS NOT NULL;
