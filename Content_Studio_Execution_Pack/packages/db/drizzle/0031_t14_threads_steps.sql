-- T14(결정 D26): Threads 모의 어댑터의 원격 단계 참조(remote_steps — 컨테이너 생성·게시 ID 를 다음 원격 호출 전에 기록), mock_scenarios 에
-- Threads 전용 시나리오(threads_*) 추가. drizzle-kit 생성분 + 맨 끝의 remote_steps_guard 트리거(손으로 추가):
-- DELETE 거부, remote_id·식별 열 변경 거부, published 상태는 바뀌지 않음, INSERT 때 전송 의도(intent_id)가 같은 작업·owner 인지 확인.
-- remote_id CHECK LIKE 'mock%' 는 live 어댑터가 없는 동안의 규칙이다(live 를 붙일 때 다시 정한다 — D26).
CREATE TABLE "remote_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"kind" text NOT NULL,
	"post_index" integer NOT NULL,
	"remote_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_steps_job_post_kind_uq" UNIQUE("job_id","post_index","kind"),
	CONSTRAINT "remote_steps_remote_id_uq" UNIQUE("remote_id"),
	CONSTRAINT "remote_steps_kind_chk" CHECK ("remote_steps"."kind" in ('container', 'publish')),
	CONSTRAINT "remote_steps_status_chk" CHECK ("remote_steps"."status" in ('created', 'finished', 'published', 'error')),
	CONSTRAINT "remote_steps_kind_status_chk" CHECK (("remote_steps"."kind" = 'publish') = ("remote_steps"."status" = 'published')),
	CONSTRAINT "remote_steps_post_index_chk" CHECK ("remote_steps"."post_index" >= 0),
	CONSTRAINT "remote_steps_step_index_chk" CHECK ("remote_steps"."step_index" >= 0),
	CONSTRAINT "remote_steps_mock_id_chk" CHECK ("remote_steps"."remote_id" like 'mock%')
);
--> statement-breakpoint
ALTER TABLE "mock_scenarios" DROP CONSTRAINT "mock_scenarios_scenario_chk";--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_intent_id_send_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."send_intents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_job_same_owner_fk" FOREIGN KEY ("job_id","owner_id") REFERENCES "public"."jobs"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_item_same_owner_fk" FOREIGN KEY ("item_id","owner_id") REFERENCES "public"."distribution_items"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remote_steps_item_idx" ON "remote_steps" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "mock_scenarios" ADD CONSTRAINT "mock_scenarios_scenario_chk" CHECK ("mock_scenarios"."scenario" in ('success', 'success_public', 'processing_then_confirm', 'transient', 'transient_then_success', 'rate_limited', 'server_error_no_side_effect', 'server_error_side_effect_unknown', 'permanent', 'auth', 'ambiguous_sent', 'ambiguous_not_sent', 'hang', 'cancel_supported', 'reconcile_unsupported', 'threads_success', 'threads_container_slow', 'threads_publish_timeout_sent', 'threads_publish_timeout_not_sent', 'threads_thread_partial', 'threads_rate_limited', 'threads_token_invalid', 'threads_text_too_long'));
--> statement-breakpoint
CREATE FUNCTION "remote_steps_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'remote_steps_guard: 원격 단계 기록은 삭제할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM "send_intents" i WHERE i."id" = NEW."intent_id" AND i."job_id" = NEW."job_id" AND i."owner_id" = NEW."owner_id") THEN
      RAISE EXCEPTION 'remote_steps_guard: 전송 의도가 같은 작업·owner 의 것이 아닙니다' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."id" = NEW."job_id" AND j."item_id" = NEW."item_id") THEN
      RAISE EXCEPTION 'remote_steps_guard: 작업의 항목과 다릅니다' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id" OR NEW."job_id" IS DISTINCT FROM OLD."job_id"
     OR NEW."intent_id" IS DISTINCT FROM OLD."intent_id" OR NEW."item_id" IS DISTINCT FROM OLD."item_id" OR NEW."step_index" IS DISTINCT FROM OLD."step_index"
     OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."post_index" IS DISTINCT FROM OLD."post_index" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'remote_steps_guard: 원격 단계의 식별 열은 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."remote_id" IS DISTINCT FROM OLD."remote_id" THEN
    RAISE EXCEPTION 'remote_steps_guard: 한 번 기록한 원격 ID 는 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'published' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'remote_steps_guard: 게시된 단계는 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'created' AND NEW."status" = 'created' THEN
    RAISE EXCEPTION 'remote_steps_guard: 단계 상태는 created 로 되돌릴 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "remote_steps_guard" BEFORE INSERT OR UPDATE OR DELETE ON "remote_steps"
  FOR EACH ROW EXECUTE FUNCTION "remote_steps_guard"();
