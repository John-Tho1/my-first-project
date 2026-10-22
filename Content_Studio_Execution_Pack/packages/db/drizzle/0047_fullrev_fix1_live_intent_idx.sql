-- FIX1-FULLREV(F9): 실제 게시 사용 수 세기(liveApprovalUsage — 승인 기록별, livePublishDailyUsage — owner 별 최근 24시간)용 send_intents 부분 색인 2개.
-- 실제 게시 전송 의도(sanitized_details.live_approval_ref 가 있는 행)만 담는다. 표·열·행은 바꾸지 않는다(내보내기 묶음 형식 그대로).
-- drizzle-kit 출력 그대로 + 이 머리말 주석만 손으로 추가.
CREATE INDEX "send_intents_live_ref_job_idx" ON "send_intents" USING btree (("sanitized_details"->>'live_approval_ref'),"job_id") WHERE "send_intents"."sanitized_details"->>'live_approval_ref' is not null;--> statement-breakpoint
CREATE INDEX "send_intents_live_owner_created_idx" ON "send_intents" USING btree ("owner_id","created_at") WHERE "send_intents"."sanitized_details"->>'live_approval_ref' is not null;