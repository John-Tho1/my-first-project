-- FIX round 1(Codex review-T20 P1, drizzle-kit 출력 그대로): 준비·비교 중 예외로 끝난 복원 훈련도 fail 로 남기고 정제된 오류 코드를 둔다.
ALTER TABLE "restore_drills" ADD COLUMN "error_code" text;