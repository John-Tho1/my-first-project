-- FIX-T19 round 1(Codex review-T19 P1 0041:31): collected_items_accepted_chk 를 NULL 에 안전한 식으로 바꾼다 — outcome 이 null 이고 capture_id·source_version_id·accepted_at 이 채워진 행이 통과하던 구멍.
-- 앞 검사: 새 규칙을 어기는 기존 행이 있으면 데이터를 바꾸지 않고 멈춘다(앱 경로는 이런 행을 만들지 않는다 — 있으면 사람이 확인). 그 밖은 drizzle-kit 출력 그대로.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM "collected_items"
   WHERE not (((outcome is not distinct from 'accepted') = (capture_id is not null))
          and ((outcome is not distinct from 'accepted') = (source_version_id is not null))
          and ((outcome is not distinct from 'accepted') = (accepted_at is not null)));
  IF bad > 0 THEN
    RAISE EXCEPTION 'collected_items: % row(s) violate the accepted-link rule (outcome must be accepted iff capture_id/source_version_id/accepted_at are set); fix them before migrating', bad;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "collected_items" DROP CONSTRAINT "collected_items_accepted_chk";--> statement-breakpoint
ALTER TABLE "collected_items" ADD CONSTRAINT "collected_items_accepted_chk" CHECK ((("collected_items"."outcome" is not distinct from 'accepted') = ("collected_items"."capture_id" is not null)) and (("collected_items"."outcome" is not distinct from 'accepted') = ("collected_items"."source_version_id" is not null)) and (("collected_items"."outcome" is not distinct from 'accepted') = ("collected_items"."accepted_at" is not null)));
