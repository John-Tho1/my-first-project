-- T21-P1b: 진행 중인 OIDC 로그인 요청(로그인 전 단계, owner 없음 — 10분 임시 상태, export/restore 제외). 그 밖은 drizzle-kit 출력 그대로.
CREATE TABLE "auth_oidc_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state_hash" text NOT NULL,
	"browser_hash" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"key_version" integer NOT NULL,
	"settings_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_oidc_states_hash_uq" UNIQUE("state_hash"),
	CONSTRAINT "auth_oidc_states_sealed_chk" CHECK ("auth_oidc_states"."encrypted_payload" like 'csk1:%')
);
--> statement-breakpoint
CREATE INDEX "auth_oidc_states_created_idx" ON "auth_oidc_states" USING btree ("created_at");