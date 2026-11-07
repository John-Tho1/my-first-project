-- FIX7-T13(Codex review-FIX6-T13 P2 :1779): oauth_credentials.revoke_resume_at·revoke_resume_attempts — 끝나지 않은 해제(revoking)를 worker 가 다시 이어 볼
-- 다음 시도 시각·횟수(정리 대기의 next_attempt_at·attempts 와 같은 backoff). 열 수 없는 행이 처리 한도를 독점하지 않게 한다. drizzle-kit 출력 그대로.
ALTER TABLE "oauth_credentials" ADD COLUMN "revoke_resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD COLUMN "revoke_resume_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_revoke_resume_attempts_chk" CHECK ("oauth_credentials"."revoke_resume_attempts" >= 0);