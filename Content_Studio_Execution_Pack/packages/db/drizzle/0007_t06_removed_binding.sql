-- FIX-T06 round 2(Codex review-FIX-T06): 'removed' 해결을 본문 버전에 연결(body_version_id)하고,
-- claim 하나에 해결 방식별 한 행을 허용한다(unique (run_id, claim_index, resolution)). 추가 전용 트리거는 그대로.
-- 기존 행의 body_version_id 는 null(0006 까지의 'removed' 는 게이트가 현재 본문으로 다시 검사한다).
-- drizzle-kit 출력 그대로(이 머리 주석만 추가).
ALTER TABLE "claim_confirmations" DROP CONSTRAINT "claim_confirmations_run_claim_uq";--> statement-breakpoint
ALTER TABLE "claim_confirmations" ADD COLUMN "body_version_id" uuid;--> statement-breakpoint
ALTER TABLE "claim_confirmations" ADD CONSTRAINT "claim_confirmations_body_version_id_content_versions_id_fk" FOREIGN KEY ("body_version_id") REFERENCES "public"."content_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_confirmations" ADD CONSTRAINT "claim_confirmations_run_claim_resolution_uq" UNIQUE("run_id","claim_index","resolution");