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

## FIX round 1 (Codex review-T15)
- Orchestrator: HEAD_SHA cc26535 (code only, D28) — reran lint·typecheck·build·unit 715·integration 563·drill:mock 0·real-DB drill:restore PASS.
- 판정 원본: 로컬 `.handoffs/review-T15.md`(CHANGES_REQUESTED, 리뷰 대상 427dc71). 범위: 모의 어댑터·모의 Google OAuth 만, 외부 호출 0, 새 의존성 0, migration 없음(0035 미사용).
- BASE_SHA: d00e3e6 · HEAD_SHA: TBD(오케스트레이터 커밋 — 이 파일은 커밋하지 않음)

### 지적 → 변경 → 시험
1. **[P1] youtube-mock.ts:794 — 파일 읽기 도중 중단돼도 다음 조각 전송**
   - 변경: 조각 루프를 "중단 신호 확인 → 범위 읽기 → `gateWrite`(중단 신호·heartbeat(lease)·취소 요청을 **읽기 뒤에** 다시 확인) → 동기 `putChunk`" 순서로 바꿨다. 확인과 전송 사이에 await 가 없다. 중단이면 AbortError/LeaseLostError 로 그 조각을 보내지 않고(세션의 받은 바이트 그대로), 취소면 `canceled_before_upload_complete`. 새 세션 생성(`initResumable`) 앞에도 중단 확인을 한 번 더 둔다.
   - 시험(단위 `youtube-mock.test.ts` FIX-T15 절): 중간 조각·마지막 조각 읽기 도중 abort → putChunk 추가 0·영상 0·세션 `created`(받은 바이트 = 읽기 시작 offset) → 조회 `resumable` → 다음 시도가 받은 바이트부터 이어 올림(보낸 바이트 합계 = 파일, 세션 1, sha256 같음); 읽기 도중 lease 상실 → LeaseLostError·전송 0; 읽기 도중 취소 → 전송 0·영상 0.
2. **[P1] jobs.ts:683 — 만료 세션 행이 새 세션의 할당량 검사를 건너뛰게 함**
   - 변경: 어댑터 계약에 `rateUnitsRemaining(snapshot, steps)`(선택) 추가 — YouTube 는 영상 있음·마지막 세션 유효 가능(created·finished) → 0(재개), 세션 없음·마지막 세션 만료/오류 → 1(새 세션). 작업 처리기 `rateUnitsNeeded` 가 이 값을 쓰고(없으면 기존 rateUnits − 단계 수 — Threads 불변), 진행 중 예약(`inflightRateUnits`)도 같은 함수. 만료 세션 행은 창 안 사용량(`recentPublishUsage`)에 그대로 남는다. 사전 검사 뒤 만료 경계: 처리기가 이 시도에 확인한 단위를 `ctx.rateUnitsReserved` 로 넘기고, 어댑터는 새 세션이 필요한데 예약 0 이면(재개로 검사받았는데 보낼 때 만료 확인) 새 세션을 만들지 않고 `rejected / transient_no_side_effect / upload_session_requires_quota_check` → RETRY_WAIT → 다음 시도가 요청 제한 검사를 다시 거친다.
   - 시험(통합 `youtube.test.ts`): 한도 1·세션 만료 → 조회 not_found → 다음 시도 `local_rate_limited`(의도 1·세션 `0:expired` 만, 사건 상세 used 1·needed 1) → 창 뒤 새 세션 `1:finished`·영상 1; 한도 1·유효 세션 재개 → `local_rate_limited` 없음·세션 1·의도 2; 재개 사전 검사 직후 원격 만료 → 그 시도 initResumable 0·`upload_session_requires_quota_check` → 다음 tick `local_rate_limited` → 창 뒤 CONFIRMED. 단위: `rateUnitsRemaining` 표, 예약 0 이면 새 세션 거부·예약 1 이면 허용.
3. **[P1] worker/tick/route.ts:45 — web 요청 안에서 영상 전체 업로드**
   - 선택한 설계: **조각 예산 + 양보**(web tick 에서 YouTube 를 건너뛰는 안은 inline 개발 모드에서 업로드가 영영 진행되지 않아 버림). `UploadSliceBudget {max_bytes, max_ms}` 을 `JobRunOptions.uploadSlice` → `AdapterContext.uploadSlice` 로 넘긴다. web 요청 경로 두 곳(POST /api/worker/tick, inline worker `runInlineWorker` — /api/health·전사 목록)은 `WEB_TICK_UPLOAD_SLICE = {max_bytes: 1, max_ms: 5000}`(= 작업당 조각 1개, 기본 조각 8MiB) 을 넣는다. 별도 worker 프로세스(`pnpm worker`, CLI)는 넣지 않는다(기존대로 시간 제한만). 어댑터는 최소 한 조각을 보낸 뒤 예산에 닿으면 받은 바이트를 기록하고 `status: processing` + `upload_yield {received_bytes,total_bytes}`(영상 ID 없음)를 돌려준다. 작업 처리기는 새 사건 `upload_yield`(SENDING → RETRY_WAIT, next_run_at = 지금, last_error_code `upload_slice_yield`)로 두고 resume_count + 1(받은 바이트가 단조 증가해야만 양보하므로 시도 한도에서 뺀다 — FREE_RESUME_MAX 와 별개로 끝이 보장됨). 다음 tick 은 새 전송 의도로 같은 세션을 queryOffset 뒤 이어 올린다(요청 제한 단위 0). 취소 요청 중 양보 결과는 기존 remote_accepted 취소 경로(조회 → resumable parts 0 → CANCELED). 화면: `RETRY_WAIT · 업로드 진행 중 — 다음 처리에서 같은 세션으로 이어 올림` / 항목 `비공개 업로드 진행 중 — 다음 처리에서 이어 올림`.
   - 시험: 통합 — route 를 조각 수(5)만큼 부르면 요청마다 putChunk 정확히 1·받은 바이트 i×64KiB·publication 0, 마지막 요청에서 REMOTE_PROCESSING, 합계 보낸 바이트 = 파일·세션 1·의도 5·`countedAttempts` 1·`upload_yield` 사건 4 → CONFIRMED·sha256 같음; inline worker 1회 → putChunk 1·RETRY_WAIT `upload_slice_yield` → 예산 없는 tick 이 나머지 → 세션 1. 단위 — 조각 예산 반복(실행마다 조각 1, 끝에서 영상 ID), 시간 예산 0 이어도 최소 1조각(진행 보장); 도메인 — `upload_yield` 는 SENDING 에서만; web 문구.
4. **놓친 케이스 중 저렴한 것**
   - Q1 복합 장애: 시뮬레이터 `queryOffset` 의 `session_expired` 장애 주입이 **완료된 세션**의 상태를 가리지 않게 했다(완료 세션은 만료로 답하지 않음 — 다른 장애는 그대로). 시험: 마지막 조각 응답 유실 + 조회 만료 주입 → 조회 found·두 번째 영상 0; 끝나지 않은 세션에는 주입 만료가 그대로 not_found.
   - 고정 미래 날짜 `2026-12-01` → 지금 + 60일(`FUTURE_DAY`)로 바꿈(통합 예약 공개·validate 시험).
   - 읽기 도중 마지막 조각 abort·취소·lease 상실(1번), 할당량 1 + 만료 뒤 새 세션·사전 검사 직후 만료(2번) — 위 시험.

### T14 FIX 와의 일관성
- 복원 remote_steps·`recordedAdapterIdOf`(null → mock_generic)·resume_count 규칙 변경 없음. `upload_yield` 의 resume_count 증가는 0034 CHECK(resume_count ≤ attempt)를 지킨다(양보 시 resume_count < attempt 일 때만 + 1). 내보내기의 세션 URI 가림(`mock-redacted:session:…`) 그대로 — 새 사건 상세에는 받은 바이트·전체 바이트만(세션 URI·토큰 없음, 기존 누출 검사 시험 통과).

### 명령과 결과 (로컬 Windows 10, Node 24.21.0, `corepack pnpm`, 순차)
- `pnpm lint` → pass(exit 0)
- `pnpm typecheck` → pass
- `pnpm build` → pass
- `pnpm test` → pass 39 files / 715 tests
- `pnpm test:integration`(단독) → pass 30 files / 563 tests, 316 s
- `pnpm drill:mock` → exit 0, `불변식 위반 0건 — M3 게이트 통과(MOCK), T14 Threads 모의 불변식 통과(MOCK), T15 YouTube 모의 불변식 통과(MOCK)`, fetch 0
- 실행하지 않음: 개발 서버·브라우저 smoke, 실제 PostgreSQL 동시성, Codex 재검증.

### 변경 파일
`packages/domain/src/jobs.ts`(+test) · `packages/db/src/jobs.ts` · `packages/providers/src/youtube-mock.ts`(+test) · `apps/web/app/api/worker/tick/route.ts` · `apps/web/lib/stt.ts` · `apps/web/lib/distribution.ts`(+test) · `apps/worker/src/index.ts` · `tests/integration/youtube.test.ts`

### 남은 위험
- 양보마다 전송 의도가 하나씩 생긴다(8MiB 조각·2GB → web tick 만으로 올리면 의도 최대 256개). 시도 한도에는 들어가지 않지만 이력이 길다 — inline 모드는 개발용이고 실제 대용량은 별도 worker 가 맡는 전제.
- inline 모드에서 web 요청이 없으면 업로드가 진행되지 않는다(health·목록 조회·"작업 처리 실행" 버튼이 tick). 예산은 작업당이며 tick 당 작업 최대 5개 → 한 요청 최대 5조각(40MiB).
- 별도 worker 의 submit 은 여전히 파일 전체를 한 번에(시간 제한 30 s) — 실제 2GB 는 진행 기반 시간 제한 또는 같은 조각 예산이 필요(D27 Consequences 그대로).
- `upload_session_requires_quota_check` 는 센 시도 1회를 쓴다(부작용 없음, 재시도 대기 백오프).
- 실제 YouTube 의 404 는 "만료"와 "모름"을 구분하지 못할 수 있다 — 모의는 시뮬레이터 규칙(완료 세션은 만료 안 됨)에 기댄다. live 어댑터는 확증 없으면 unknown 이어야 함(Codex 답 1, 미구현).
- 실제 PostgreSQL 병렬은 관찰하지 않았다(PGlite 연결 하나).

### D27 갱신이 필요한 결정(DECISIONS.md 는 이번에 수정하지 않음 — 오케스트레이터·사용자 확인)
- (i) web 요청 경로의 업로드는 작업당 조각 1개 + 양보(`upload_yield`, 시도 한도 밖)로 한다 — D27 Consequences "한 번의 submit 이 파일 전체를 올린다"를 "별도 worker 만"으로 고침.
- (ii) 요청 제한의 이번 시도 단위는 어댑터가 단계로 정한다(`rateUnitsRemaining`), 만료 세션은 사용량에 남고 새 세션 비용을 상계하지 않음, 사전 검사 뒤 만료면 그 시도는 새 세션을 만들지 않는다(`ctx.rateUnitsReserved`).
- (iii) 시뮬레이터 조회의 만료 장애 주입은 완료 세션에 적용하지 않음(Q1).

### Codex 에게 질문
1. 양보를 "새 전송 의도 + resume_count + 1(시도 한도 밖)"로 표현한 것이 A20(맹목 재전송 금지)·전송 의도 불변 규칙과 맞는가? 같은 의도를 이어 쓰는 쪽(의도를 pending 으로 남김)이 나은가?
2. 양보를 시도 한도에서 빼는 근거(받은 바이트 단조 증가 → 최대 ⌈크기/조각⌉회)가 충분한가, 아니면 별도 상한이 필요한가?
3. 사전 검사 뒤 만료를 `transient_no_side_effect`(센 시도 1회)로 닫는 것과, 같은 트랜잭션 경계에서 새 단위를 다시 예약하는 창구(advisory 잠금 + 사용량 재검사)를 어댑터에 주는 것 중 어느 쪽이 맞는가?
4. web 예산을 "작업당"으로 둔 것(tick 당 최대 5조각)이 docs/02 요구에 충분한가, tick 전체 예산이어야 하는가?
5. Q1 보완을 시뮬레이터 규칙(완료 세션은 만료 응답 안 함)으로 한 것이 충분한가, 어댑터가 마지막 조각 시도 여부를 단계에 남겨 만료 응답에도 unknown 으로 가야 하는가?
