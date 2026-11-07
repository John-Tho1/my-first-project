-- FIX-T06(Codex review-T06): 경험 claim 해결 방식(resolution)과 인터뷰 답변 순번(seq).
-- drizzle-kit 출력에서 손으로 바꾼 부분:
--  1) interview_answers.seq 는 nullable 로 추가 → 기존 행을 원고별 (created_at, id) 순서로 1..n 채움 → NOT NULL.
--     채우는 동안만 추가 전용 트리거(interview_answers_immutable)를 끄고, 같은 migration 안에서 다시 켠다.
--  2) claim_confirmations.resolution 기존 행은 기본값 'confirmed'(0005 에서는 확인만 있었음). 트리거는 그대로 유지.
ALTER TABLE "claim_confirmations" ADD COLUMN "resolution" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_confirmations" ADD CONSTRAINT "claim_confirmations_resolution_chk" CHECK ("claim_confirmations"."resolution" in ('confirmed', 'removed'));--> statement-breakpoint
ALTER TABLE "interview_answers" ADD COLUMN "seq" integer;--> statement-breakpoint
ALTER TABLE "interview_answers" DISABLE TRIGGER "interview_answers_immutable";--> statement-breakpoint
UPDATE "interview_answers" AS a SET "seq" = n.rn
  FROM (SELECT "id", row_number() OVER (PARTITION BY "content_id" ORDER BY "created_at", "id") AS rn FROM "interview_answers") AS n
  WHERE a."id" = n."id";--> statement-breakpoint
ALTER TABLE "interview_answers" ENABLE TRIGGER "interview_answers_immutable";--> statement-breakpoint
ALTER TABLE "interview_answers" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_content_seq_uq" UNIQUE("content_id","seq");
