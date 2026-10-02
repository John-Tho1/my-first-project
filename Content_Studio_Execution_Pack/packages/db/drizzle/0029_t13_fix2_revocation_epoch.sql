-- FIX2-T13(Codex review-FIX-T13 P1): 해제 세대(revocation_epoch — 해제 시작마다 +1, 다시 연결로 초기화 안 됨)·해제 작업 ID(revoke_op_id)·연결 요청의 발급 시점 해제 세대.
-- drizzle-kit 출력 그대로.
ALTER TABLE "oauth_credentials" ADD COLUMN "revocation_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD COLUMN "revoke_op_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD COLUMN "revocation_epoch" integer DEFAULT 0 NOT NULL;