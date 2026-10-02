# M4 현황 (작성 2026-10-02, 로컬 세션 → 클라우드 인계)

## 브랜치·커밋
- `content-studio/m3` HEAD `dfc9842` = 검증 완료된 마지막 지점(T13 FIX round 2 까지, 전체 검사 통과). origin 푸시됨.
- `content-studio/m4` = m3 에서 분기. 이 문서·인계 사본 커밋 + **T13 FIX round 3 미완성 WIP 커밋**(아래). 클라우드는 이 브랜치에서 이어간다.

## 결정 (docs/DECISIONS.md)
- D20: M4 는 실계정·외부 승인 범위 확인 전 보류 → **D24 로 해제**(2026-10-02, 사용자 "M4 작업 시작해줘"). T13 은 로컬·모의 범위.
- D23: T20 운영 결정 확정(공개 /api/health 에서 ops 제거 → 로그인 필요 GET /api/ops/summary).
- D24: 첫 채널 Threads(잠정), Threads 형 모의 OAuth, AES-256-GCM(Node crypto)·키 버전·환경변수 마스터 키, 토큰은 export/backup/로그/응답 밖, 실계정 연결은 승인 대기.
- D25: T13 잠정 판단 5건 확정 — 철회 시 승인 무효·부분 scope 차단·경로 `/api/channel-accounts/` 유지, 운영(NODE_ENV=production)에서 모의 테스트 매개변수 거부, `pnpm secrets:rotate`(기본 미리보기, --confirm 적용).

## T13 (OAuth·계정·비밀 보호, 모의·로컬) 라운드
| 라운드 | 커밋 | 검사(오케스트레이터) | Codex |
|---|---|---|---|
| 구현 | bf57eae | unit 612·integ 432·build·drill:mock·0027·실DB 복원 훈련 PASS | P1 4·P2 1 |
| FIX1 (+D25 3·5) | 5479a7f | unit 614·integ 446·…·0028 | P1 3 |
| FIX2 | dfc9842 | unit 617·integ 460/460·…·0029 | **P1 1·P2 1** (전문: `T13_CODEX_REVIEW_FIX2.md`) |
| FIX3 | **WIP (content-studio/m4)** | 미실행(typecheck 만 통과) | — |
판정 요약 `M4_CODEX_VERDICTS.md`, 라운드별 상세 `T13_IMPLEMENTATION_HANDOFF.md`(로컬 .handoffs 사본).

## FIX round 3 할 일 (review-FIX2-T13)
1. [P1] oauth.ts:690 — 갱신 토큰 저장 실패가 **확인된** 경로에서 계정 잠금 + 읽은 세대가 현재일 때만 `status='error'`(예: `refresh_store_failed`) → 수동 확인 없이 health 사용 불가·execute 409·worker BLOCKED·send intent 0. 동시 재연결로 생긴 새 세대는 건드리지 않음. 테스트: 봉인 실패·저장 트랜잭션 실패 후 각각 + 동시 재연결 변형.
2. [P2] secrets-cli.ts:51 — `handle.close()` 실패를 삼키고 exit 0 → exit 1 + 안전 출력. close 실패 주입 테스트. 오류 이름은 허용 목록, 코드는 `/^[A-Z0-9_]{1,40}$/` 일 때만 출력(**WIP 에 구현됨, 테스트 필요**) — 토큰처럼 생긴 name/code 를 가진 오류로 테스트.
3. Q14 저장 결과 불명: **WIP 에 migration 0030(`pending_op_id`·`pending_kind ∈ {refresh_unknown, cleanup_revoke}`·봉인한 `pending_token`·`pending_key_version`, 제약 3개)과 oauth.ts 일부 구현이 들어 있음.** 남은 것: 다음 check/refresh/health 가 공급자(모의)에 현재 유효성을 물어 정리(유지 또는 error, pending_token 철회 후 비움), 정리될 때까지 실행 차단, 키 회전이 pending_token 도 재봉인, export 제외 확인. 테스트: 롤백 + 재조회 실패 경로.
4. 정리 철회 실패·결과 불명 → 감사 `cleanup_revoke_failed`/`cleanup_revoke_unknown`, 계정 차단 유지. 테스트.
5. Q16: `tests/integration/fix-t11-t12.test.ts` "느린 첫 작업을 처리하는 동안…"(leaseTtlMs 100, 모의 지연 150) 은 부하 시 가끔 실패. 시간 확대 대신 명시적 장벽·제어 시계로 결정적으로 — 원래 버그(여러 작업 동시 lease)를 여전히 잡는지 인계에 논증. 불가하면 그대로 두고 명시.

## 그다음
- T13 이 Codex PASS 되면(로컬 복귀 후) T14: Threads 텍스트 — 컨테이너 생성 → `threads_publish` 2단계, 컨테이너 참조 저장, 성공 확인(조회), 요청 제한(공식 rate limit 재확인 전 잠정값, D19-d), 실패·불명 → RECONCILING/UNKNOWN(맹목 재게시 금지). **모의 어댑터만**, 실제 Threads 호출·앱 등록 없음(D24).
- 실계정 연결 전 사용자에게 받을 것(D24): Meta 앱 등록·앱 ID 보관 방식, 테스트 Threads 계정, redirect URI, 마스터 키 위치, 첫 실계정 시험 원고·공개 범위.

## 남은 위험 / not_run
- 실제 PostgreSQL 다중 연결 동시성(경합 테스트는 PGlite 단일 연결 위 순서 주입).
- 프록시 뒤 콜백 URL·서버 접근 로그의 비밀 노출, 복원 화면 브라우저 렌더링(T13 화면은 브라우저로 아직 확인 안 함).
- 공개 /api/health 의 jobs·uploads·db.captures 를 세션 뒤로 옮길지(사용자 결정 대기, D23).
