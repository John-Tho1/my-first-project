-- FIX-T13(Codex review-T13 P1 1~3): 토큰 세대(token_generation — 새 토큰 저장마다 +1, 키 교체는 그대로)와 연결 해제 진행 중 상태(revoking).
-- drizzle-kit 출력 그대로.
ALTER TABLE "oauth_credentials" DROP CONSTRAINT "oauth_credentials_status_chk";--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD COLUMN "token_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_generation_chk" CHECK ("oauth_credentials"."token_generation" >= 1);--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_status_chk" CHECK ("oauth_credentials"."status" in ('active', 'error', 'revoking', 'revoked'));