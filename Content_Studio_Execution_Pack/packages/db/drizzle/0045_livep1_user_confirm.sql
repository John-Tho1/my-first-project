-- LIVEP1-USERCONFIRM(D38 후속): 결과 불명 실제 Threads 게시의 사용자 확인("Threads에서 확인함") — publications.verification 에 USER_CONFIRMED,
-- 확인자(confirmed_by — 'owner' 만)·확인 시각(confirmed_at) 열. USER_CONFIRMED 는 앱이 원격 조회로 검증한 VERIFIED 와 다른 값이다(verified_at 없음).
-- drizzle-kit 출력 그대로 + 맨 끝(손으로 추가): publications_guard 를 바꿔 confirmed_by·confirmed_at 변경과 USER_CONFIRMED 로/에서의 verification 변경을 거부한다
-- (기존 규칙 — 삭제 거부, 재확인 열만 변경 — 은 그대로). 기존 행은 새 열이 null 이고 USER_CONFIRMED 가 아니므로 그대로 통과한다.
ALTER TABLE "publications" DROP CONSTRAINT "publications_verification_chk";--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_user_confirmed_chk" CHECK (("publications"."verification" = 'USER_CONFIRMED') = ("publications"."confirmed_by" is not null) and ("publications"."confirmed_by" is null) = ("publications"."confirmed_at" is null) and ("publications"."confirmed_by" is null or "publications"."confirmed_by" = 'owner'));--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_user_confirmed_shape_chk" CHECK ("publications"."verification" <> 'USER_CONFIRMED' or (not "publications"."is_mock" and "publications"."verified_at" is null and "publications"."permalink" is not null and "publications"."result_kind" = 'PUBLISHED'));--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_verification_chk" CHECK ("publications"."verification" in ('MOCK', 'VERIFIED', 'UNVERIFIED', 'MANUAL_REPORTED', 'USER_CONFIRMED'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "publications_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publications_guard: 원격 결과 기록은 삭제할 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
    OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.job_id IS DISTINCT FROM OLD.job_id
    OR NEW.external_id IS DISTINCT FROM OLD.external_id
    OR NEW.permalink IS DISTINCT FROM OLD.permalink
    OR NEW.result_kind IS DISTINCT FROM OLD.result_kind
    OR NEW.is_mock IS DISTINCT FROM OLD.is_mock
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
    OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at THEN
    RAISE EXCEPTION 'publications_guard: 원격 결과는 재확인 열(verification·verified_at·remote_visibility)만 바꿀 수 있습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.verification IS DISTINCT FROM OLD.verification AND (OLD.verification = 'USER_CONFIRMED' OR NEW.verification = 'USER_CONFIRMED') THEN
    RAISE EXCEPTION 'publications_guard: 사용자 확인(USER_CONFIRMED)은 다른 확인 상태로 바꾸거나 나중에 붙일 수 없습니다' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
