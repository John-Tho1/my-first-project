-- FIX-T09(Codex review-T09): 제안 처리 상태(generation_runs.proposal_status = proposed | adopted | dismissed).
-- drizzle-kit 출력에 채움만 덧붙였다: 이미 채택된 run(원고: ai_run_id 를 가진 사용자 원고 버전, 파생본: ai_run_id 를 가진 사용자 파생본 버전)은 'adopted'.
ALTER TABLE "generation_runs" ADD COLUMN "proposal_status" text DEFAULT 'proposed' NOT NULL;--> statement-breakpoint
UPDATE "generation_runs" AS r SET "proposal_status" = 'adopted'
  WHERE EXISTS (SELECT 1 FROM "content_versions" v WHERE v."ai_run_id" = r."id" AND v."created_by" = 'owner')
     OR EXISTS (SELECT 1 FROM "variant_versions" w WHERE w."ai_run_id" = r."id" AND w."created_by" = 'owner');--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_proposal_status_chk" CHECK ("generation_runs"."proposal_status" in ('proposed', 'adopted', 'dismissed'));
