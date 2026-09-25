-- T10(결정 D17): 배포 계정(모의)·배포 계획·불변 항목 스냅샷·승인·작업·작업 이력·실행 명령, variants.lifecycle 에 'approved' 추가.
-- drizzle-kit 출력의 순서는 그대로 두었다(복합 unique 가 CREATE TABLE 안에 있어 FK 보다 먼저 생긴다).
-- 손으로 더한 부분(맨 끝): distribution_items 스냅샷 불변 트리거, approvals 승인 가드 트리거(INSERT 시 항목 hash·목적 일치,
-- UPDATE 는 철회 한 번만, DELETE 금지), job_events·execute_commands 추가 전용 트리거(0005 의 append_only_immutable 재사용).
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"distribution_item_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"approval_version" integer DEFAULT 1 NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "approvals_purpose_chk" CHECK ("approvals"."purpose" in ('mock_publish', 'upload_private', 'public_publish')),
	CONSTRAINT "approvals_version_chk" CHECK ("approvals"."approval_version" >= 1),
	CONSTRAINT "approvals_revoke_pair_chk" CHECK (("approvals"."revoked_at" is null) = ("approvals"."revoke_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "channel_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"kind" text NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text NOT NULL,
	"state" text NOT NULL,
	"capability_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_accounts_owner_platform_external_uq" UNIQUE("owner_id","platform","external_account_id"),
	CONSTRAINT "channel_accounts_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "channel_accounts_platform_chk" CHECK ("channel_accounts"."platform" in ('threads', 'instagram', 'youtube', 'blog')),
	CONSTRAINT "channel_accounts_kind_chk" CHECK ("channel_accounts"."kind" in ('mock', 'live')),
	CONSTRAINT "channel_accounts_state_chk" CHECK ("channel_accounts"."state" in ('mock_ready', 'connected', 'disconnected', 'revoked')),
	CONSTRAINT "channel_accounts_mock_prefix_chk" CHECK (("channel_accounts"."kind" = 'mock') = ("channel_accounts"."external_account_id" like 'mock:%')),
	CONSTRAINT "channel_accounts_mock_ready_chk" CHECK ("channel_accounts"."state" <> 'mock_ready' or "channel_accounts"."kind" = 'mock')
);
--> statement-breakpoint
CREATE TABLE "distribution_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"channel_account_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"variant_version_id" uuid NOT NULL,
	"content_version_id" uuid NOT NULL,
	"brand_profile_id" uuid,
	"brand_profile_version" integer,
	"payload_json" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"requested_result" text NOT NULL,
	"visibility" text NOT NULL,
	"scheduled_at_utc" timestamp with time zone,
	"schedule_timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"status" text DEFAULT 'PLANNED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_items_local_key_uq" UNIQUE("owner_id","plan_id","channel_account_id","variant_version_id","payload_hash"),
	CONSTRAINT "distribution_items_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "distribution_items_requested_result_chk" CHECK ("distribution_items"."requested_result" in ('mock_publish', 'upload_private', 'public_publish')),
	CONSTRAINT "distribution_items_visibility_chk" CHECK ("distribution_items"."visibility" in ('private', 'unlisted', 'public')),
	CONSTRAINT "distribution_items_timezone_chk" CHECK ("distribution_items"."schedule_timezone" = 'Europe/Moscow'),
	CONSTRAINT "distribution_items_hash_chk" CHECK ("distribution_items"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "distribution_items_brand_chk" CHECK (("distribution_items"."brand_profile_id" is null) = ("distribution_items"."brand_profile_version" is null)),
	CONSTRAINT "distribution_items_status_chk" CHECK ("distribution_items"."status" in ('PLANNED', 'QUEUED', 'SENDING', 'REMOTE_PROCESSING', 'CONFIRMED', 'RETRY_WAIT', 'BLOCKED', 'RECONCILING', 'UNKNOWN', 'CANCEL_REQUESTED', 'CANCELED', 'FAILED', 'PARTIAL'))
);
--> statement-breakpoint
CREATE TABLE "distribution_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"target_summary" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "distribution_plans_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "distribution_plans_status_chk" CHECK ("distribution_plans"."status" in ('draft', 'partially_approved', 'approved', 'executing', 'partial', 'completed', 'canceled', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "execute_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"command_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result_json" jsonb NOT NULL,
	CONSTRAINT "execute_commands_owner_key_uq" UNIQUE("owner_id","command_key")
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"event_seq" integer NOT NULL,
	"state_before" text,
	"state_after" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"sanitized_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "job_events_job_seq_uq" UNIQUE("job_id","event_seq"),
	CONSTRAINT "job_events_seq_chk" CHECK ("job_events"."event_seq" >= 1)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"item_id" uuid,
	"payload_ref" text NOT NULL,
	"state" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_id_owner_uq" UNIQUE("id","owner_id"),
	CONSTRAINT "jobs_kind_chk" CHECK ("jobs"."kind" in ('publish')),
	CONSTRAINT "jobs_publish_item_chk" CHECK ("jobs"."kind" <> 'publish' or "jobs"."item_id" is not null),
	CONSTRAINT "jobs_state_chk" CHECK ("jobs"."state" in ('QUEUED', 'LEASED', 'RETRY_WAIT', 'BLOCKED', 'DONE', 'FAILED', 'CANCELED', 'RECONCILING', 'UNKNOWN')),
	CONSTRAINT "jobs_attempt_chk" CHECK ("jobs"."attempt" >= 0)
);
--> statement-breakpoint
ALTER TABLE "variants" DROP CONSTRAINT "variants_lifecycle_chk";--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_item_same_owner_fk" FOREIGN KEY ("distribution_item_id","owner_id") REFERENCES "public"."distribution_items"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_items" ADD CONSTRAINT "distribution_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_items" ADD CONSTRAINT "distribution_items_content_version_id_content_versions_id_fk" FOREIGN KEY ("content_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_items" ADD CONSTRAINT "distribution_items_plan_same_owner_fk" FOREIGN KEY ("plan_id","owner_id") REFERENCES "public"."distribution_plans"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_items" ADD CONSTRAINT "distribution_items_account_same_owner_fk" FOREIGN KEY ("channel_account_id","owner_id") REFERENCES "public"."channel_accounts"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_items" ADD CONSTRAINT "distribution_items_variant_same_owner_fk" FOREIGN KEY ("variant_id","owner_id") REFERENCES "public"."variants"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_items" ADD CONSTRAINT "distribution_items_variant_version_same_owner_fk" FOREIGN KEY ("variant_version_id","owner_id") REFERENCES "public"."variant_versions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_items" ADD CONSTRAINT "distribution_items_brand_same_owner_fk" FOREIGN KEY ("brand_profile_id","owner_id") REFERENCES "public"."brand_profiles"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_plans" ADD CONSTRAINT "distribution_plans_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execute_commands" ADD CONSTRAINT "execute_commands_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execute_commands" ADD CONSTRAINT "execute_commands_plan_same_owner_fk" FOREIGN KEY ("plan_id","owner_id") REFERENCES "public"."distribution_plans"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_same_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "public"."jobs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_item_same_owner_fk" FOREIGN KEY ("item_id","owner_id") REFERENCES "public"."distribution_items"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_active_item_uq" ON "approvals" USING btree ("distribution_item_id") WHERE "approvals"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "distribution_items_plan_idx" ON "distribution_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "distribution_items_variant_idx" ON "distribution_items" USING btree ("variant_id");--> statement-breakpoint
CREATE INDEX "distribution_items_account_idx" ON "distribution_items" USING btree ("channel_account_id");--> statement-breakpoint
CREATE INDEX "distribution_plans_owner_created_idx" ON "distribution_plans" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_active_item_uq" ON "jobs" USING btree ("item_id") WHERE "jobs"."state" in ('QUEUED', 'LEASED', 'RETRY_WAIT', 'RECONCILING', 'UNKNOWN');--> statement-breakpoint
CREATE INDEX "jobs_state_next_run_idx" ON "jobs" USING btree ("state","next_run_at");--> statement-breakpoint
ALTER TABLE "variants" ADD CONSTRAINT "variants_lifecycle_chk" CHECK ("variants"."lifecycle" in ('draft', 'review', 'approved'));--> statement-breakpoint
CREATE FUNCTION "distribution_items_snapshot_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'distribution_items_snapshot_immutable: 배포 항목은 삭제할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.channel_account_id IS DISTINCT FROM OLD.channel_account_id
    OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
    OR NEW.variant_version_id IS DISTINCT FROM OLD.variant_version_id
    OR NEW.content_version_id IS DISTINCT FROM OLD.content_version_id
    OR NEW.brand_profile_id IS DISTINCT FROM OLD.brand_profile_id
    OR NEW.brand_profile_version IS DISTINCT FROM OLD.brand_profile_version
    OR NEW.payload_json IS DISTINCT FROM OLD.payload_json
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.requested_result IS DISTINCT FROM OLD.requested_result
    OR NEW.visibility IS DISTINCT FROM OLD.visibility
    OR NEW.scheduled_at_utc IS DISTINCT FROM OLD.scheduled_at_utc
    OR NEW.schedule_timezone IS DISTINCT FROM OLD.schedule_timezone
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'distribution_items_snapshot_immutable: 승인 스냅샷 열은 바꿀 수 없습니다(새 배포 계획을 만드세요)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "distribution_items_snapshot_immutable" BEFORE UPDATE OR DELETE ON "distribution_items"
  FOR EACH ROW EXECUTE FUNCTION "distribution_items_snapshot_immutable"();--> statement-breakpoint
CREATE FUNCTION "approvals_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item_hash text;
  item_result text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'approvals_guard: 승인 기록은 삭제할 수 없습니다(철회만 가능)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT payload_hash, requested_result INTO item_hash, item_result FROM distribution_items
      WHERE id = NEW.distribution_item_id AND owner_id = NEW.owner_id;
    IF item_hash IS DISTINCT FROM NEW.payload_hash OR item_result IS DISTINCT FROM NEW.purpose THEN
      RAISE EXCEPTION 'approvals_guard: 승인 hash·목적이 배포 항목과 다릅니다' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'approvals_guard: 이미 철회한 승인은 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.revoked_at IS NULL
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.distribution_item_id IS DISTINCT FROM OLD.distribution_item_id
    OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.approval_version IS DISTINCT FROM OLD.approval_version
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'approvals_guard: 승인은 철회(revoked_at·revoke_reason 설정)만 한 번 할 수 있습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "approvals_guard" BEFORE INSERT OR UPDATE OR DELETE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION "approvals_guard"();--> statement-breakpoint
CREATE TRIGGER "job_events_immutable" BEFORE UPDATE OR DELETE ON "job_events"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();--> statement-breakpoint
CREATE TRIGGER "execute_commands_immutable" BEFORE UPDATE OR DELETE ON "execute_commands"
  FOR EACH ROW EXECUTE FUNCTION "append_only_immutable"();
