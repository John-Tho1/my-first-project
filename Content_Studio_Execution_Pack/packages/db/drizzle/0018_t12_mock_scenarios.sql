-- T12(결정 D19): 항목별 모의 결과 시나리오(mock_scenarios — 개발·시험 전용, 승인 스냅샷 밖), 계획 상태 'attention'(확인 필요) 추가.
-- drizzle-kit 출력 순서는 그대로 두었다. 손으로 더한 부분(맨 끝): 기존 계획 상태 재분류(UPDATE — CONFIRMED 없이 사용자 조치가 필요한 계획
-- failed/partial → attention), mock_scenarios_mock_only 트리거(항목의 계정이 kind='mock' 일 때만 INSERT·UPDATE, 항목·owner 변경 금지).
CREATE TABLE "mock_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"distribution_item_id" uuid NOT NULL,
	"scenario" text NOT NULL,
	"delay_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mock_scenarios_item_uq" UNIQUE("distribution_item_id"),
	CONSTRAINT "mock_scenarios_scenario_chk" CHECK ("mock_scenarios"."scenario" in ('success', 'success_public', 'processing_then_confirm', 'transient', 'transient_then_success', 'rate_limited', 'server_error_no_side_effect', 'server_error_side_effect_unknown', 'permanent', 'auth', 'ambiguous_sent', 'ambiguous_not_sent', 'hang', 'cancel_supported', 'reconcile_unsupported')),
	CONSTRAINT "mock_scenarios_delay_chk" CHECK ("mock_scenarios"."delay_ms" between 0 and 5000)
);
--> statement-breakpoint
ALTER TABLE "distribution_plans" DROP CONSTRAINT "distribution_plans_status_chk";--> statement-breakpoint
ALTER TABLE "mock_scenarios" ADD CONSTRAINT "mock_scenarios_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mock_scenarios" ADD CONSTRAINT "mock_scenarios_item_same_owner_fk" FOREIGN KEY ("distribution_item_id","owner_id") REFERENCES "public"."distribution_items"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_plans" ADD CONSTRAINT "distribution_plans_status_chk" CHECK ("distribution_plans"."status" in ('draft', 'partially_approved', 'approved', 'executing', 'partial', 'attention', 'completed', 'canceled', 'failed'));--> statement-breakpoint
UPDATE "distribution_plans" p SET "status" = 'attention', "revision" = p."revision" + 1, "updated_at" = now()
  WHERE p."status" IN ('failed', 'partial')
    AND NOT EXISTS (SELECT 1 FROM "distribution_items" i WHERE i."plan_id" = p."id" AND i."status" IN ('CONFIRMED', 'PARTIAL', 'QUEUED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED'))
    AND EXISTS (SELECT 1 FROM "distribution_items" i WHERE i."plan_id" = p."id" AND i."status" IN ('BLOCKED', 'UNKNOWN', 'PLANNED'));--> statement-breakpoint
CREATE FUNCTION "mock_scenarios_mock_only"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.distribution_item_id IS DISTINCT FROM OLD.distribution_item_id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'mock_scenarios_mock_only: 항목·owner 는 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT ca.kind INTO acc_kind FROM distribution_items di
    JOIN channel_accounts ca ON ca.id = di.channel_account_id AND ca.owner_id = di.owner_id
    WHERE di.id = NEW.distribution_item_id AND di.owner_id = NEW.owner_id;
  IF acc_kind IS DISTINCT FROM 'mock' THEN
    RAISE EXCEPTION 'mock_scenarios_mock_only: 모의 시나리오는 모의(mock) 계정 항목에만 둘 수 있습니다' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "mock_scenarios_mock_only" BEFORE INSERT OR UPDATE ON "mock_scenarios"
  FOR EACH ROW EXECUTE FUNCTION "mock_scenarios_mock_only"();
