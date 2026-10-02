-- FIX3-T13(Codex review-FIX2-T13 P1·Q14): 정리 대기 표시(pending_op_id·pending_kind·봉인한 pending_token·pending_key_version) — 갱신 토큰 저장 판정 불가·정리 철회 실패를 내구성 있게 남긴다.
-- drizzle-kit 출력 그대로.
ALTER TABLE "oauth_credentials" ADD COLUMN "pending_op_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD COLUMN "pending_kind" text;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD COLUMN "pending_token" text;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD COLUMN "pending_key_version" integer;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_pending_kind_chk" CHECK ("oauth_credentials"."pending_kind" is null or "oauth_credentials"."pending_kind" in ('refresh_unknown', 'cleanup_revoke'));--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_pending_chk" CHECK (("oauth_credentials"."pending_kind" is null) = ("oauth_credentials"."pending_op_id" is null) and ("oauth_credentials"."pending_kind" is null) = ("oauth_credentials"."pending_token" is null) and ("oauth_credentials"."pending_token" is null) = ("oauth_credentials"."pending_key_version" is null));--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_pending_sealed_chk" CHECK ("oauth_credentials"."pending_token" is null or "oauth_credentials"."pending_token" like 'csk1:%');