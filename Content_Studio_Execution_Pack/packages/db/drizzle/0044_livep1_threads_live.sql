-- LIVE-P1(결정 D38 1단계): 실제 Threads 텍스트 게시 — remote_steps 에 publish_attempt(threads_publish 직전 표식, 컨테이너마다 하나) 종류와 실제 단계 ID
-- ('threads:ct|pa|post:<숫자>'), publications 의 실제 결과 형식(external_id 'threads:<숫자>'·permalink https://(www.)threads.com|net/·VERIFIED 는 verified_at 필수).
-- drizzle-kit 출력 그대로 + 맨 끝의 INSERT 트리거 2개(손으로 추가): remote_steps_account_guard(실제 ID ⇔ 실제 Threads 계정 작업, 모의 ID ⇔ 모의 계정 작업),
-- publications_account_guard(is_mock ⇔ 항목 계정 kind = mock). 기존 remote_steps_guard·publications_guard 는 그대로.
ALTER TABLE "remote_steps" DROP CONSTRAINT "remote_steps_mock_id_chk";--> statement-breakpoint
ALTER TABLE "remote_steps" DROP CONSTRAINT "remote_steps_kind_chk";--> statement-breakpoint
ALTER TABLE "remote_steps" DROP CONSTRAINT "remote_steps_kind_status_chk";--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_real_external_chk" CHECK ("publications"."is_mock" or "publications"."external_id" ~ '^threads:[0-9]{1,30}$');--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_real_permalink_chk" CHECK ("publications"."is_mock" or "publications"."permalink" is null or "publications"."permalink" ~ '^https://(www[.])?threads[.](com|net)/');--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_verified_at_chk" CHECK ("publications"."verification" <> 'VERIFIED' or "publications"."verified_at" is not null);--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_remote_id_chk" CHECK (("remote_steps"."remote_id" like 'mock%' and "remote_steps"."kind" <> 'publish_attempt') or ("remote_steps"."kind" = 'container' and "remote_steps"."remote_id" ~ '^threads:ct:[0-9]{1,30}$') or ("remote_steps"."kind" = 'publish_attempt' and "remote_steps"."remote_id" ~ '^threads:pa:[0-9]{1,30}$') or ("remote_steps"."kind" = 'publish' and "remote_steps"."remote_id" ~ '^threads:post:[0-9]{1,30}$'));--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_kind_chk" CHECK ("remote_steps"."kind" in ('container', 'publish', 'upload_session', 'video', 'ig_container', 'ig_publish', 'ig_parent_request', 'publish_attempt'));--> statement-breakpoint
ALTER TABLE "remote_steps" ADD CONSTRAINT "remote_steps_kind_status_chk" CHECK (("remote_steps"."kind" = 'container' and "remote_steps"."status" in ('created', 'finished', 'error')) or ("remote_steps"."kind" = 'publish' and "remote_steps"."status" = 'published') or ("remote_steps"."kind" = 'upload_session' and "remote_steps"."status" in ('created', 'finished', 'expired', 'error')) or ("remote_steps"."kind" = 'video' and "remote_steps"."status" in ('uploaded', 'processed', 'error')) or ("remote_steps"."kind" = 'ig_container' and "remote_steps"."status" in ('created', 'finished', 'error')) or ("remote_steps"."kind" = 'ig_publish' and "remote_steps"."status" = 'published') or ("remote_steps"."kind" = 'ig_parent_request' and "remote_steps"."status" = 'created') or ("remote_steps"."kind" = 'publish_attempt' and "remote_steps"."status" = 'created'));--> statement-breakpoint
CREATE FUNCTION "remote_steps_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc_kind text;
  acc_platform text;
BEGIN
  SELECT a."kind", a."platform" INTO acc_kind, acc_platform
    FROM "distribution_items" di JOIN "channel_accounts" a ON a."id" = di."channel_account_id" AND a."owner_id" = di."owner_id"
   WHERE di."id" = NEW."item_id" AND di."owner_id" = NEW."owner_id";
  IF acc_kind IS NULL THEN
    RAISE EXCEPTION 'remote_steps_account_guard: 항목의 계정을 찾을 수 없습니다' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."remote_id" LIKE 'threads:%' AND NOT (acc_kind = 'live' AND acc_platform = 'threads') THEN
    RAISE EXCEPTION 'remote_steps_account_guard: 실제 Threads 단계 ID 는 실제 Threads 계정 작업에만 기록합니다' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."remote_id" LIKE 'mock%' AND acc_kind <> 'mock' THEN
    RAISE EXCEPTION 'remote_steps_account_guard: 모의 단계 ID 는 모의 계정 작업에만 기록합니다' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "remote_steps_account_guard" BEFORE INSERT ON "remote_steps"
  FOR EACH ROW EXECUTE FUNCTION "remote_steps_account_guard"();--> statement-breakpoint
CREATE FUNCTION "publications_account_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc_kind text;
  acc_platform text;
BEGIN
  SELECT a."kind", a."platform" INTO acc_kind, acc_platform
    FROM "distribution_items" di JOIN "channel_accounts" a ON a."id" = di."channel_account_id" AND a."owner_id" = di."owner_id"
   WHERE di."id" = NEW."item_id" AND di."owner_id" = NEW."owner_id";
  IF acc_kind IS NULL THEN
    RAISE EXCEPTION 'publications_account_guard: 항목의 계정을 찾을 수 없습니다' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."is_mock" <> (acc_kind = 'mock') THEN
    RAISE EXCEPTION 'publications_account_guard: 모의 결과는 모의 계정, 실제 결과는 실제 계정 항목에만 기록합니다' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT NEW."is_mock" AND acc_platform <> 'threads' THEN
    RAISE EXCEPTION 'publications_account_guard: 실제 결과는 실제 Threads 계정만 지원합니다' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "publications_account_guard" BEFORE INSERT ON "publications"
  FOR EACH ROW EXECUTE FUNCTION "publications_account_guard"();
