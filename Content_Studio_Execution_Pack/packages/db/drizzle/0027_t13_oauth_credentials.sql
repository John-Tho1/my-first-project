-- T13(결정 D24): 계정 연결 정보(oauth_credentials — 봉인한 토큰만, 평문 없음)·연결 요청(oauth_states — state 는 SHA-256 만)·channel_accounts.credential_state.
-- drizzle-kit 출력 순서는 그대로 두었다. 손으로 더한 부분(맨 끝): oauth_credentials_kind_match 트리거(연결 정보의 is_mock 이 계정 kind 와 같아야 함 —
-- 모의 토큰을 실제 계정에, 실제 토큰을 모의 계정에 붙일 수 없음. id·owner·계정·공급자 변경 금지).
CREATE TABLE "oauth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"is_mock" boolean NOT NULL,
	"encrypted_token" text,
	"key_version" integer,
	"expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"last_error_code" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_credentials_account_uq" UNIQUE("channel_account_id"),
	CONSTRAINT "oauth_credentials_provider_chk" CHECK ("oauth_credentials"."provider" in ('mock_threads', 'threads')),
	CONSTRAINT "oauth_credentials_mock_chk" CHECK ("oauth_credentials"."is_mock" = ("oauth_credentials"."provider" = 'mock_threads')),
	CONSTRAINT "oauth_credentials_status_chk" CHECK ("oauth_credentials"."status" in ('active', 'error', 'revoked')),
	CONSTRAINT "oauth_credentials_revoked_chk" CHECK (("oauth_credentials"."status" = 'revoked') = ("oauth_credentials"."revoked_at" is not null)),
	CONSTRAINT "oauth_credentials_secret_chk" CHECK (("oauth_credentials"."revoked_at" is null) = ("oauth_credentials"."encrypted_token" is not null)),
	CONSTRAINT "oauth_credentials_key_version_chk" CHECK (("oauth_credentials"."encrypted_token" is null) = ("oauth_credentials"."key_version" is null)),
	CONSTRAINT "oauth_credentials_sealed_chk" CHECK ("oauth_credentials"."encrypted_token" is null or "oauth_credentials"."encrypted_token" like 'csk1:%')
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"encrypted_verifier" text NOT NULL,
	"key_version" integer NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_states_hash_uq" UNIQUE("state_hash"),
	CONSTRAINT "oauth_states_provider_chk" CHECK ("oauth_states"."provider" in ('mock_threads', 'threads')),
	CONSTRAINT "oauth_states_sealed_chk" CHECK ("oauth_states"."encrypted_verifier" like 'csk1:%')
);
--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN "credential_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_account_same_owner_fk" FOREIGN KEY ("channel_account_id","owner_id") REFERENCES "public"."channel_accounts"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_account_same_owner_fk" FOREIGN KEY ("channel_account_id","owner_id") REFERENCES "public"."channel_accounts"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_states_owner_expires_idx" ON "oauth_states" USING btree ("owner_id","expires_at");--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_credential_state_chk" CHECK ("channel_accounts"."credential_state" in ('none', 'linked', 'needs_reconnect'));--> statement-breakpoint
CREATE FUNCTION "oauth_credentials_kind_match"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.channel_account_id IS DISTINCT FROM OLD.channel_account_id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.is_mock IS DISTINCT FROM OLD.is_mock) THEN
    RAISE EXCEPTION 'oauth_credentials_kind_match: 계정·owner·공급자는 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT ca.kind INTO acc_kind FROM channel_accounts ca WHERE ca.id = NEW.channel_account_id AND ca.owner_id = NEW.owner_id;
  IF acc_kind IS NULL OR (acc_kind = 'mock') IS DISTINCT FROM NEW.is_mock THEN
    RAISE EXCEPTION 'oauth_credentials_kind_match: 모의 연결 정보는 모의 계정에만, 실제 연결 정보는 실제 계정에만 둘 수 있습니다' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "oauth_credentials_kind_match" BEFORE INSERT OR UPDATE ON "oauth_credentials"
  FOR EACH ROW EXECUTE FUNCTION "oauth_credentials_kind_match"();
