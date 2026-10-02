# Implementation handoff — T15
- Task ID / milestone: T15 / M4 (YouTube resumable upload · private 결과 · processing 상태 · 조건부 schedule — **모의 어댑터만**)
- Purpose and changed behavior: 모의 Google OAuth 로 연결된 YouTube 계정의 배포 항목을, T08 로 올린 VERIFIED 영상 파일에서 조각 단위로 읽어 재개 가능한 업로드 세션으로 보낸다. 세션·영상 ID·받은 바이트를 단계 기록에 남기고, 단절 시 같은 세션의 offset 을 조회해 이어서 보내며(A14), 완료 응답이 유실되면 조회로 영상을 확인한다(A08). 업로드 뒤 처리 상태를 거쳐 결과를 UPLOADED_PRIVATE / SCHEDULED_REMOTE / PUBLISHED 로 구분하고, 미검증 프로젝트는 공개 요청도 private 으로 강제돼 "비공개 업로드 완료, 공개 전환 확인 필요"로 표시한다(A12). 실제 Google/YouTube 호출 0, 실계정 시험 `blocked_external`.
- BASE_SHA: 00cc27e (T14 코드 67ade9e + 인계)
- HEAD_SHA: 427dc71557c315eb39a679f2ba1e69a8f6615e9b
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M4 T15, A08, A09, A12, A13, A14, docs/02 장시간 영상 업로드, docs/03 YouTube 행·승인 스냅샷(비공개 업로드 승인은 publishAt·공개 전환 불가), D14·D15·D16-D/E·D24~D27
- Changed files: `git show --stat 427dc71`. 신규: `packages/providers/src/youtube-mock.ts`(+test 34), `packages/db/drizzle/0032_t15_youtube_upload.sql`(+snapshot), `packages/db/scripts/drill-youtube.ts`, `tests/integration/youtube.test.ts`(22), `apps/web/app/api/oauth/mock-google/authorize/route.ts`. 수정: domain `jobs.ts`·`distribution.ts`·`oauth.ts`·`bundle.ts`, db `schema.ts`·`jobs.ts`·`remote-steps.ts`·`oauth.ts`·`distribution.ts`·`restore-expect.ts`·`bundle-tables.ts`·`scripts/drill.ts`, providers `oauth.ts`(모의 Google, Threads 공급자는 Google 토큰 거부)·`storage.ts`(`readRange`)·`channel-adapter.ts`, web `distribute/[id]/page.tsx`·`lib/distribution.ts`·`lib/oauth.ts`·`settings/page.tsx`·`api/worker/tick`, worker `index.ts`·`cli.ts`, `README_KO.md`, `docs/DECISIONS.md`(D27)
- Migrations / restore implications: `0032_t15_youtube_upload` — remote_steps 에 업로드 단계(upload_session·영상)와 `received_bytes`(단조 증가만 허용 트리거). remote_steps 는 export 만이며 export 에서 세션 URI 는 `mock-redacted:session:<sha16>` 로 가림. `remote_id LIKE 'mock%'` CHECK 유지(live 전 새 migration 필요).
- Actual commands and results (클라우드 Node 22.22.2, pnpm 12.6.0, 오케스트레이터 순차 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` / `pnpm build` → pass
  - `pnpm test` → pass 39 files / 697 tests
  - `pnpm test:integration`(단독) → pass 29 files / 517/517, 156 s
  - `pnpm drill:mock` → exit 0, `불변식 위반 0건 — M3 게이트 통과(MOCK), T14 Threads 모의 불변식 통과(MOCK), T15 YouTube 모의 불변식 통과(MOCK)`, fetch 0
  - `pnpm db:migrate` → 0032 적용
  - 구현 에이전트 운영 모드 smoke(`pnpm start`, 임시 DB 삭제됨): 모의 Google 연결(authorize 303 → callback 200 connected) → T08 업로드(session 201·chunk 201·complete 200, VERIFIED) → youtube 파생본·영상 첨부·검토 → 계획(upload_private) → 승인 → 실행 → tick1 REMOTE_PROCESSING(`업로드 100% (0.3/0.3 MB) · 세션 재개 0회`) → tick2 CONFIRMED, publication UPLOADED_PRIVATE/private/MOCK/`mock:youtube:mockyt_v_…`, 페이지 `비공개 업로드 완료, 공개 전환 확인 필요`·MOCK·`실제 발행 실적 아님`, `게시 완료` 없음, 토큰·세션 URI 노출 0(응답·HTML·job JSON·서버 로그)
- drill:mock YouTube 행 요약: 비공개 성공·처리 지연·단절 50% → 같은 세션 재개(보낸 바이트 1.11×)·완료 응답 유실 → 조회 확인·세션 만료 → 새 세션(영상 1개)·401 BLOCKED·거부 FAILED·미검증 프로젝트 공개 요청 → private·검증 프로젝트 공개(테스트 전용) PUBLISHED·예약 private SCHEDULED_REMOTE·할당량 소진 → 초기화 뒤 성공·재시작으로 모의 기록 유실 → UNKNOWN(재업로드 0)
- Demo route / local start steps: 설정에서 YouTube 모의 연결 → `/record` 또는 업로드로 영상 VERIFIED → 원고·youtube 파생본에 영상 첨부·검토 → `/distribute/new`(기본 upload_private) → 승인 → 실행 → `작업 처리 실행(모의 1회)` 2회.
- External calls performed: none.
- Mock-only functionality: 전부. `kind='live'` 계정은 기존대로 LiveChannelNotConfiguredError.
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드). 실제 브라우저·실제 PostgreSQL 병렬·실계정 미실행.
  - submit 1회가 파일 전체를 올리므로 실제 2 GB 는 `JOB_SUBMIT_TIMEOUT_MS`(30 s, UI 10 s)를 넘는다 — live 어댑터는 조각 진행에 따라 늘어나는 timeout 필요.
  - 배포함 승인 폼은 목적 1개만 보내므로 YouTube(upload_private)와 Threads(mock_publish) 항목이 섞인 계획은 한 번에 승인할 수 없다(API 로 목적별 승인은 가능).
  - `/distribute/new` 에 요청 결과·publish_at 입력이 없다(기본 upload_private, 공개·예약 계획은 API 전용).
  - 모의 갱신은 refresh token 을 회전(실제 Google 은 보통 유지 — live 전 재확인).
  - 원격 403 할당량은 `retry_at` 까지 기다리며 기존 Retry-After 1시간 상한(`decideRetryAt`)을 우회.
  - 미검증 프로젝트는 publishAt 도 버림 → SCHEDULED_REMOTE 는 검증 프로젝트에서만.
  - 업로드 뒤 취소는 `cancel_too_late` → CONFIRMED("업로드됨 — 삭제는 별도 동작(범위 밖)"), 재개는 다음 시도에서(시도 5회 중 하나 소모), 영상 옆 썸네일 첨부는 `thumbnail_not_supported_t15` 로 거부.
- Questions specifically for Codex:
  1. 세션 만료 뒤 reconcile `not_found` 가 건전한가(시뮬레이터가 영상 없음을 증명한다는 전제)? 실제 YouTube 는 "만료"와 "모름"에 같은 404 를 줄 수 있다 — 로컬 증거가 없으면 `unknown` 이어야 하는가?
  2. 업로드 뒤 취소를 `cancel_too_late` → CONFIRMED 로 끝내는 것이 A11·docs/03 을 만족하는가, CANCEL_REQUESTED/attention 으로 남겨야 하는가?
  3. 오래된 access token 이면 `readAccessTokenForSend` 가 `credential_access_token_stale` 을 주고 처리기가 트랜잭션 밖 `prepare` 에서 `refreshCredential` 을 부른다 — T13 잠금 순서·pending-reconcile 규칙과 안전한가?
  4. A12 "요청 vs 실제" 공개 범위를 job event 상세에만 남기는 것(publication 칼럼 없음)으로 충분한가?
  5. export 에서 세션 URI 를 가리는 방식이 맞는가, `upload_session` remote ID 를 토큰처럼 저장 시 봉인해야 하는가?
  6. 로컬 할당량의 24h 이동 창을 지금 일일 초기화로 바꿔야 하는가, 공식 할당량 확인 후로 미뤄야 하는가?
- Next authorized task: 로컬 복귀 → Codex 검증(FIX3-T13·T14·T15). 그 뒤 T16(Instagram, 모의)·M5 모의 부분은 사용자 지시 후.
