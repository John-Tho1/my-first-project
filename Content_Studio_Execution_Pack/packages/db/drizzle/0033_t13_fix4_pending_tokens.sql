-- FIX4-T13(Codex review-FIX3-T13 P1 :908·:1037·:1017·P2 :1293): 정리 대기를 oauth_credentials 의 한 칸(pending_*)에서 별도 표
-- oauth_pending_tokens(계정마다 여러 행, 연결 정보 행 없이도 기록, revision·시도 시각)로 옮긴다. drizzle-kit 출력 + 데이터 이전 2문(손으로 추가).
CREATE TABLE "oauth_pending_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sealed_token" text,
	"key_version" integer,
	"base_generation" integer,
	"on_invalid_code" text,
	"source" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_pending_tokens_kind_chk" CHECK ("oauth_pending_tokens"."kind" in ('refresh_unknown', 'cleanup_revoke', 'verify_current')),
	CONSTRAINT "oauth_pending_tokens_token_chk" CHECK (("oauth_pending_tokens"."kind" = 'verify_current') = ("oauth_pending_tokens"."sealed_token" is null)),
	CONSTRAINT "oauth_pending_tokens_sealed_chk" CHECK (("oauth_pending_tokens"."sealed_token" is null) = ("oauth_pending_tokens"."key_version" is null) and ("oauth_pending_tokens"."sealed_token" is null or "oauth_pending_tokens"."sealed_token" like 'csk1:%')),
	CONSTRAINT "oauth_pending_tokens_verify_chk" CHECK ("oauth_pending_tokens"."kind" <> 'verify_current' or "oauth_pending_tokens"."base_generation" is not null),
	CONSTRAINT "oauth_pending_tokens_counters_chk" CHECK ("oauth_pending_tokens"."revision" >= 1 and "oauth_pending_tokens"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP CONSTRAINT "oauth_credentials_pending_kind_chk";--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP CONSTRAINT "oauth_credentials_pending_chk";--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP CONSTRAINT "oauth_credentials_pending_sealed_chk";--> statement-breakpoint
ALTER TABLE "oauth_pending_tokens" ADD CONSTRAINT "oauth_pending_tokens_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_pending_tokens" ADD CONSTRAINT "oauth_pending_tokens_account_same_owner_fk" FOREIGN KEY ("channel_account_id","owner_id") REFERENCES "public"."channel_accounts"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_pending_tokens_account_idx" ON "oauth_pending_tokens" USING btree ("owner_id","channel_account_id");--> statement-breakpoint
CREATE INDEX "oauth_pending_tokens_next_attempt_idx" ON "oauth_pending_tokens" USING btree ("next_attempt_at");--> statement-breakpoint
-- 데이터 이전(손으로 추가): 0030 정리 대기 표시 → 한 행씩. 봉인·키 버전·AAD(owner + 계정 + oauth_pending_token)는 그대로라 다시 봉인하지 않는다.
INSERT INTO "oauth_pending_tokens" ("id", "owner_id", "channel_account_id", "kind", "sealed_token", "key_version", "base_generation", "source", "next_attempt_at", "created_at", "updated_at")
SELECT "pending_op_id", "owner_id", "channel_account_id", "pending_kind", "pending_token", "pending_key_version",
  CASE WHEN "pending_kind" = 'refresh_unknown' THEN "token_generation" ELSE NULL END, 'migrated_0030', now(), "updated_at", "updated_at"
FROM "oauth_credentials" WHERE "pending_op_id" IS NOT NULL;--> statement-breakpoint
-- 0030 의 첫 연결 자리 표시 행(정리 대기만 담은 revoked 행)을 지운다. 실제 연결 정보 행과 섞이지 않게 모든 조건을 건다:
-- 정리 대기 있음 · revoked · 해제 세대 0 · 암호문 없음 · 해제 작업 ID 없음 · scope 없음 · 세대 1 · 그리고 계정이 한 번도 연결되지 않음(credential_state='none').
-- callback 저장은 항상 credential_state='linked' 로 바꾸고 해제는 linked 를 유지하므로, 옛(0029 이전) revoked + 해제 세대 0 행은 linked 라 지워지지 않는다.
DELETE FROM "oauth_credentials" c USING "channel_accounts" a
WHERE a."id" = c."channel_account_id" AND a."owner_id" = c."owner_id" AND a."credential_state" = 'none'
  AND c."pending_op_id" IS NOT NULL AND c."revoked_at" IS NOT NULL AND c."status" = 'revoked' AND c."revocation_epoch" = 0
  AND c."encrypted_token" IS NULL AND c."revoke_op_id" IS NULL AND c."token_generation" = 1 AND c."scopes" = '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP COLUMN "pending_op_id";--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP COLUMN "pending_kind";--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP COLUMN "pending_token";--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP COLUMN "pending_key_version";