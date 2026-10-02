-- T15(결정 D27): YouTube 재개 업로드(모의) — remote_steps 에 upload_session(세션 URI)·video(영상 ID) 종류와 진행 열(received_bytes·total_bytes·
-- resume_count), mock_scenarios 에 youtube_* 시나리오, oauth 공급자 CHECK 에 mock_google(Google 형 모의 OAuth). drizzle-kit 생성분 +
-- 맨 끝의 remote_steps_guard 교체(손으로 추가): 0031 규칙 그대로 + received_bytes 는 앞으로만(줄이거나 NULL 로 되돌리기 거부),
-- total_bytes 는 처음 값 그대로, resume_count 는 앞으로만, 끝난 상태(published·processed·expired·error)는 바뀌지 않음.
ALTER TABLE "mock_scenarios" DROP CONSTRAINT "mock_scenarios_scenario_chk";--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP CONSTRAINT "oauth_credentials_provider_chk";--> statement-breakpoint
ALTER TABLE "oauth_credentials" DROP CONSTRAINT "oauth_credentials_mock_chk";--> statement-breakpoint
ALTER TABLE "oauth_states" DROP CONSTRAINT "oauth_states_provider_chk";--> statement-breakpoint
ALTER TABLE "remote_steps" DROP CONSTRAINT "remote_steps_kind_chk";--> statement-breakpoint
ALTER TABLE "remote_steps" DROP CONSTRAINT "remote_steps_status_chk";--> statement-breakpoint
ALTER TABLE "remote_steps" DROP CONSTRAINT "remote_steps_kind_status_chk";--> statement-breakpoint
ALTER TABLE "remote_steps" ADD COLUMN "received_bytes" bigint;--> statement-breakpoint
ALTER TABLE "remote_steps" ADD COLUMN "total_bytes" bigint;--> statement-breakpoint
ALTER TABLE "remote_steps" ADD COLUMN "resume_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "mock_scenarios" ADD CONSTRAINT "mock_scenarios_scenario_chk" CHECK ("mock_scenarios"."scenario" in ('success', 'success_public', 'processing_then_confirm', 'transient', 'transient_then_success', 'rate_limited', 'server_error_no_side_effect', 'server_error_side_effect_unknown', 'permanent', 'auth', 'ambiguous_sent', 'ambiguous_not_sent', 'hang', 'cancel_supported', 'reconcile_unsupported', 'threads_success', 'threads_container_slow', 'threads_publish_timeout_sent', 'threads_publish_timeout_not_sent', 'threads_thread_partial', 'threads_rate_limited', 'threads_token_invalid', 'threads_text_too_long', 'youtube_success_private', 'youtube_processing_slow', 'youtube_network_drop', 'youtube_response_lost_after_complete', 'youtube_session_expired_before_complete', 'youtube_quota_exceeded', 'youtube_token_invalid', 'youtube_rejected', 'youtube_public_unverified_forced_private', 'youtube_scheduled_private', 'youtube_project_verified'));--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_provider_chk" CHECK ("oauth_credentials"."provider" in ('mock_threads', 'threads', 'mock_google'));--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_mock_chk" CHECK ("oauth_credentials"."is_mock" = ("oauth_credentials"."provider" in ('mock_threads', 'mock_google')));--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_provider_chk" CHECK ("oauth_states"."provider" in ('mock_threads', 'threads', 'mock_google'));--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_bytes_chk" CHECK (("remote_steps"."received_bytes" is null or "remote_steps"."received_bytes" >= 0) and ("remote_steps"."total_bytes" is null or "remote_steps"."total_bytes" > 0) and ("remote_steps"."received_bytes" is null or "remote_steps"."total_bytes" is null or "remote_steps"."received_bytes" <= "remote_steps"."total_bytes"));--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_resume_count_chk" CHECK ("remote_steps"."resume_count" >= 0);--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_kind_chk" CHECK ("remote_steps"."kind" in ('container', 'publish', 'upload_session', 'video'));--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_status_chk" CHECK ("remote_steps"."status" in ('created', 'finished', 'published', 'error', 'expired', 'uploaded', 'processed'));--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_kind_status_chk" CHECK (("remote_steps"."kind" = 'container' and "remote_steps"."status" in ('created', 'finished', 'error')) or ("remote_steps"."kind" = 'publish' and "remote_steps"."status" = 'published') or ("remote_steps"."kind" = 'upload_session' and "remote_steps"."status" in ('created', 'finished', 'expired', 'error')) or ("remote_steps"."kind" = 'video' and "remote_steps"."status" in ('uploaded', 'processed', 'error')));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "remote_steps_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD."status" IN ('published', 'processed', 'expired', 'error') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'remote_steps_guard: 끝난 단계(게시됨·처리됨·만료·오류)는 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'created' AND NEW."status" = 'created' THEN
    RAISE EXCEPTION 'remote_steps_guard: 단계 상태는 created 로 되돌릴 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."received_bytes" IS NOT NULL AND (NEW."received_bytes" IS NULL OR NEW."received_bytes" < OLD."received_bytes") THEN
    RAISE EXCEPTION 'remote_steps_guard: 받은 바이트 수는 줄어들 수 없습니다(앞으로만)' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."total_bytes" IS NOT NULL AND NEW."total_bytes" IS DISTINCT FROM OLD."total_bytes" THEN
    RAISE EXCEPTION 'remote_steps_guard: 전체 바이트 수는 바꿀 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."resume_count" < OLD."resume_count" THEN
    RAISE EXCEPTION 'remote_steps_guard: 재개 횟수는 줄어들 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
