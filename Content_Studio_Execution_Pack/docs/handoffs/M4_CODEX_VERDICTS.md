# Codex 판정 요약 (M4, GPT-6 Astra / xhigh, 로컬 실행)

전문은 로컬 `.handoffs/review-*.md`(gitignore). 판정과 지적 제목만 옮긴다.

## T13 (bf57eae, OAuth·계정·비밀 보호 — 모의·로컬) — CHANGES_REQUESTED
- [P1] packages/db/src/oauth.ts:500 — 키 교체와 갱신이 겹치면 유효한 새 토큰을 잃고 철회된 옛 토큰만 저장된다
- [P1] packages/db/src/oauth.ts:540 — 이전 토큰의 확인 결과가 새 연결 정보의 상태를 덮어쓴다
- [P1] packages/db/src/oauth.ts:603 — 연결 해제가 실제로 철회하지 않은 최신 토큰을 삭제하면서 성공을 반환할 수 있다
- [P1] packages/db/src/restore.ts:48 — 연결 이력 차이를 전부 무시하면 복원 계정의 재연결 차단이 누락된다
- [P2] packages/domain/src/oauth.ts:191 — 설정에서 허용한 query 포함 redirect URI로는 연결을 완료할 수 없다
- 답 요지: 잠금 없는 실행 게이트는 승인 불가(계정 → 연결 정보 공통 잠금 순서 필요); 철회 시 승인 무효화는 보수적이고 타당; 콜백 세션 검사는 state 소비 전에; 회전은 현재 버전 행의 무결성도 검사해야; 실패 응답 헤더·객체 콘솔 출력 검사 보강.

## FIX-T13 (5479a7f, round 1: review-T13 + D25 3·5) — CHANGES_REQUESTED (P1 3)
- [P1] packages/db/src/oauth.ts:439 — 재연결이 `revokedAt`을 지우면 해제 전에 시작한 콜백이 다시 저장될 수 있음
- [P1] packages/db/src/oauth.ts:737 — 중복 해제 요청에서는 `incomplete`가 실행 차단 상태를 보장하지 않음
- [P1] packages/db/src/oauth.ts:575 — 갱신 토큰 저장 중 예외가 발생하면 발급 토큰 정리를 건너뜀
- 답 요지: 세션 검사 후 state 소비·restore 단방향 needs_reconnect·회전 exit 1 은 타당; reconnect_required_accounts 는 복원 화면에도 표시 필요; 실제 PostgreSQL 잠금 대기·프록시 뒤 콜백·서버 접근 로그는 미확인(not_run).

## FIX2-T13 (dfc9842, round 2: review-FIX-T13) — CHANGES_REQUESTED (P1 1·P2 1)
- [P1] packages/db/src/oauth.ts:690 — 갱신 토큰 저장 실패 후 무효화된 기존 토큰을 `active` 상태로 남긴다
- [P2] packages/db/src/secrets-cli.ts:51 — DB 종료 오류를 삼켜 CLI가 성공을 반환한다
- 답 요지: 해제 번호·작업 식별자·저장 결과 불명 시 즉시 철회 안 함은 타당; 결과 불명 T2 의 나중 정리를 보장하려면 내구성 있는 기록 필요; lease 테스트는 시간 확대보다 명시적 장벽·제어 시계 권고.

## FIX3-T13 (round 3: review-FIX2-T13) — (클라우드 세션에서 구현 중, 로컬 복귀 후 Codex 검증)

## FIX3-T13 (79201d6, round 3: review-FIX2-T13, 클라우드 구현) — CHANGES_REQUESTED (P1 3·P2 1)
- [P1] packages/db/src/oauth.ts:1037 — 현재 토큰의 유효성을 확인하지 못해도 pending을 지워 무효 토큰의 실행 차단을 해제한다
- [P1] packages/db/src/oauth.ts:1017 — 되쓰기에서 pending 작업 ID만 확인하여 동시 해제가 남긴 정리 의무를 삭제한다
- [P1] packages/db/src/oauth.ts:908 — `occupied`가 두 번째 미정리 토큰을 기록 없이 버린다
- [P2] packages/db/src/oauth.ts:1293 — 오래된 해독 불가 pending들이 뒤 계정의 자동 정리를 계속 막는다

## T14 (67ade9e, Threads 텍스트 — 모의, 클라우드 구현) — CHANGES_REQUESTED (P0 1·P1 1·P2 1)
- [P0] packages/db/src/jobs.ts:848 — 기존 전송 의도에 `adapter_id`가 없으면 다른 어댑터가 결과 불명을 확정 미전송으로 오판한다
- [P1] packages/domain/src/bundle.ts:123 — 복원에서 Threads 재확인에 필요한 원격 참조를 버린다
- [P2] packages/providers/src/threads-mock.ts:622 — 만료 컨테이너가 재시도 경로에서는 문서와 달리 `FAILED`로 끝난다

## T15 (427dc71, YouTube 재개 업로드 — 모의, 클라우드 구현) — CHANGES_REQUESTED (P1 3)
- [P1] packages/providers/src/youtube-mock.ts:794 — 파일 읽기 도중 작업이 중단되어도 다음 조각을 전송한다
- [P1] packages/db/src/jobs.ts:683 — 만료된 세션까지 차감하여 새 세션 생성 시 할당량 검사를 건너뛴다
- [P1] apps/web/app/api/worker/tick/route.ts:45 — 웹 요청 안에서 영상 전체 업로드를 수행하는 경로를 추가했다
