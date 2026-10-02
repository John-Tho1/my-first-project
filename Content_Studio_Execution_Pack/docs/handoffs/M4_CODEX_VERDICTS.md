# Codex 판정 요약 (M4, GPT-6 Astra / xhigh, 로컬 실행)

전문은 로컬 `.handoffs/review-*.md`(gitignore). 판정과 지적 제목만 옮긴다.

## T13 (bf57eae, OAuth·계정·비밀 보호 — 모의·로컬) — CHANGES_REQUESTED
- [P1] packages/db/src/oauth.ts:500 — 키 교체와 갱신이 겹치면 유효한 새 토큰을 잃고 철회된 옛 토큰만 저장된다
- [P1] packages/db/src/oauth.ts:540 — 이전 토큰의 확인 결과가 새 연결 정보의 상태를 덮어쓴다
- [P1] packages/db/src/oauth.ts:603 — 연결 해제가 실제로 철회하지 않은 최신 토큰을 삭제하면서 성공을 반환할 수 있다
- [P1] packages/db/src/restore.ts:48 — 연결 이력 차이를 전부 무시하면 복원 계정의 재연결 차단이 누락된다
- [P2] packages/domain/src/oauth.ts:191 — 설정에서 허용한 query 포함 redirect URI로는 연결을 완료할 수 없다
- 답 요지: 잠금 없는 실행 게이트는 승인 불가(계정 → 연결 정보 공통 잠금 순서 필요); 철회 시 승인 무효화는 보수적이고 타당; 콜백 세션 검사는 state 소비 전에; 회전은 현재 버전 행의 무결성도 검사해야; 실패 응답 헤더·객체 콘솔 출력 검사 보강.

## FIX-T13 (round 1: review-T13 + D25 3·5) — (판정 대기)
