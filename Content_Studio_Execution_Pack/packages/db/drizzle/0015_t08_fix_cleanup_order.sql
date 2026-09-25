-- FIX-T08 round 4(Codex review-FIX3-T08): 삭제 의도의 다음 시도 시각을 NULL 없이 한 시간축으로 — 기존 NULL 은 asset 생성 시각으로 채운다.
UPDATE "assets" SET "pending_delete_next_at" = "created_at" WHERE "pending_delete_key" IS NOT NULL AND "pending_delete_next_at" IS NULL;
