-- T09: 채널별 파생본(variants·variant_versions·variant_assets), 채널 초안 AI run(generation_runs.variant_id·mode=variant),
-- claim 의 채널 초안 연결(claims.variant_version_id)과 claim unique 를 (run_id, claim_index) 로 변경. 결정 D14.
-- drizzle-kit 출력에서 손으로 바꾼 부분: assets_id_owner_uq 를 variant_assets 의 복합 FK 앞으로 옮김(생성 순서),
-- 맨 끝에 variant_versions·variant_assets 추가 전용 트리거(0005 의 append_only_immutable 재사용).
CREATE TABLE "variant_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"variant_version_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "variant_assets_version_position_uq" UNIQUE("variant_version_id","position"),
	CONSTRAINT "variant_assets_role_chk" CHECK ("variant_assets"."role" in ('image', 'video', 'thumbnail', 'attachment')),
	CONSTRAINT "variant_assets_position_chk" CHECK ("variant_assets"."position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "variant_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content_version_id" uuid NOT NULL,
	"body" text NOT NULL,
	"metadata_json" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"ai_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variant_versions_variant_version_uq" UNIQUE("variant_id","version"),
	CONSTRAINT "variant_versions_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "variant_versions_created_by_chk" CHECK ("variant_versions"."created_by" = 'owner' or "variant_versions"."created_by" like 'ai:%'),
	CONSTRAINT "variant_versions_version_chk" CHECK ("variant_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"content_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"current_version_id" uuid,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "variants_content_channel_uq" UNIQUE("content_id","channel"),
	CONSTRAINT "variants_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "variants_channel_chk" CHECK ("variants"."channel" in ('threads', 'instagram', 'youtube', 'blog')),
	CONSTRAINT "variants_lifecycle_chk" CHECK ("variants"."lifecycle" in ('draft', 'review'))
);
--> statement-breakpoint
ALTER TABLE "claims" DROP CONSTRAINT "claims_version_index_uq";--> statement-breakpoint
ALTER TABLE "generation_runs" DROP CONSTRAINT "generation_runs_mode_chk";--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "variant_version_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "variant_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_id_owner_uq" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "variant_assets" ADD CONSTRAINT "variant_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_assets" ADD CONSTRAINT "variant_assets_version_same_owner_fk" FOREIGN KEY ("variant_version_id","owner_id") REFERENCES "public"."variant_versions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_assets" ADD CONSTRAINT "variant_assets_asset_same_owner_fk" FOREIGN KEY ("asset_id","owner_id") REFERENCES "public"."assets"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_versions" ADD CONSTRAINT "variant_versions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_versions" ADD CONSTRAINT "variant_versions_content_version_id_content_versions_id_fk" FOREIGN KEY ("content_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_versions" ADD CONSTRAINT "variant_versions_variant_same_owner_fk" FOREIGN KEY ("variant_id","owner_id") REFERENCES "public"."variants"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_content_same_owner_fk" FOREIGN KEY ("content_id","owner_id") REFERENCES "public"."contents"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_variant_version_id_variant_versions_id_fk" FOREIGN KEY ("variant_version_id") REFERENCES "public"."variant_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_variant_same_owner_fk" FOREIGN KEY ("variant_id","owner_id") REFERENCES "public"."variants"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_run_index_uq" UNIQUE("run_id","claim_index");--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_variant_chk" CHECK (("generation_runs"."mode" = 'variant') = ("generation_runs"."variant_id" is not null));--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_mode_chk" CHECK ("generation_runs"."mode" in ('outline', 'draft', 'revise', 'variant'));--> statement-breakpoint
CREATE TRIGGER "variant_versions_immutable" BEFORE UPDATE OR DELETE ON "variant_versions"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();--> statement-breakpoint
CREATE TRIGGER "variant_assets_immutable" BEFORE UPDATE OR DELETE ON "variant_assets"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();
