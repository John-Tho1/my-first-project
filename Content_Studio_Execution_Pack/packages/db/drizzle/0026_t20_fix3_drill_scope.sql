-- FIX round 3(Codex review-FIX-T20 Q2, drizzle-kit 출력 그대로): 복원 훈련의 검증 범위(빈 표·파일 수·검색 확인·부분 검증 이유)를 남긴다.
ALTER TABLE "restore_drills" ADD COLUMN "scope_json" jsonb;