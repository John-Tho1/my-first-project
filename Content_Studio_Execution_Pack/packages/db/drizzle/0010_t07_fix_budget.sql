-- FIX-T07(Codex review-T07): 원장 초과액 기록(overage_amount·over_budget), claims.evidence_grade 에서 'user_confirmed' 제거.
-- drizzle-kit 출력에서 손으로 바꾼 부분: CHECK 를 바꾸기 전에 기존 'user_confirmed' 행을 'none' 으로 바꾼다
-- (등급은 claim_confirmations 에서 파생되므로 정보 손실 없음). 그동안만 claims 추가 전용 트리거를 끈다.
ALTER TABLE "claims" DROP CONSTRAINT "claims_evidence_grade_chk";--> statement-breakpoint
ALTER TABLE "claims" DISABLE TRIGGER "claims_immutable";--> statement-breakpoint
UPDATE "claims" SET "evidence_grade" = 'none' WHERE "evidence_grade" = 'user_confirmed';--> statement-breakpoint
ALTER TABLE "claims" ENABLE TRIGGER "claims_immutable";--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "overage_amount" numeric(18, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "over_budget" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_evidence_grade_chk" CHECK ("claims"."evidence_grade" in ('none', 'source'));
