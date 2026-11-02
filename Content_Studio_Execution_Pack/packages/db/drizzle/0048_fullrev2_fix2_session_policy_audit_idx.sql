-- FIX2-FULLREV2(G16, D40-3): sessions.policy_fingerprint — 세션을 만들 때의 인증 정책 지문. 검증 때 현재 정책 지문과 다르면 거부한다.
-- 기존 세션은 null 로 남고 언제나 거부된다(적용 뒤 1회 재로그인 — D40 결과). sessions 는 내보내기·복원 대상이 아니다(묶음 형식 그대로).
-- FIX2-FULLREV2(G15): audit_events(action, at) 색인 — 로그인 판정·취소 기록 상한의 시간 창 조회용. 표·행은 바꾸지 않는다.
-- drizzle-kit 출력 그대로 + 이 머리말 주석만 손으로 추가.
ALTER TABLE "sessions" ADD COLUMN "policy_fingerprint" text;--> statement-breakpoint
CREATE INDEX "audit_events_action_at_idx" ON "audit_events" USING btree ("action","at");