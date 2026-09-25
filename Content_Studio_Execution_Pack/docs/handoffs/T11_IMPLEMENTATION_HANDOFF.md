# Implementation handoff — T11
- Task ID / milestone: T11 / M3 (transactional outbox / DB jobs · lease · retry · reconciliation · cancel)
- Purpose and changed behavior: T10 이 만든 QUEUED job 을 worker 가 처리한다. lease 만료 복구 → `FOR UPDATE SKIP LOCKED` lease(짧은 트랜잭션) → `beginSend`(승인 재검사·스냅샷 재검증·SENDING 전이·전송 의도(send_intents) 기록을 한 트랜잭션) → DB 잠금 없이 adapter.submit(heartbeat·timeout) → `finishSend`(결과 분류: accepted→CONFIRMED+MOCK publication, transient→RETRY_WAIT backoff, permanent→FAILED, auth→BLOCKED, ambiguous→RECONCILING). RECONCILING 은 조회만(found→CONFIRMED, not_found 확정→재시도, 3회 불가→UNKNOWN, 자동 재전송 없음). 취소는 미시작만 즉시, 전송 중은 CANCEL_REQUESTED(취소 확인 중).
- BASE_SHA: 1b36b62 (T10 코드 d1844d6 + 인계 사본)
- HEAD_SHA: a2a967070a0ef4a18b30732410fab40fa97011b6
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M3 T11, A07(두 worker·더블클릭 → intent 1·publication 1), A08(원격 성공 후 응답 유실 → RECONCILING→found→CONFIRMED, 재전송 0), A10(재시도 중 철회 → 다음 전송 차단 BLOCKED), A11(전송 중 취소 → CANCEL_REQUESTED, 즉시 취소 성공 주장 없음, `cancel_too_late`), A20(lease 만료+의도 있음 → RECONCILING, 중복 submit 없음), 앱/worker 종료 후 상태 보존, MOCK 표시 필수
- Changed files: `git show --stat a2a9670`. 주요: `packages/db/drizzle/0017_t11_jobs.sql`, `packages/domain/src/jobs.ts`, `packages/providers/src/channel-adapter.ts`, `packages/db/src/jobs.ts`, `packages/db/src/{approval-invalidation,distribution,schema,bundle-tables}.ts`, `apps/worker/src/{index,cli}.ts`, `apps/web/app/api/{distribution-items/[id]/{cancel,reconcile},jobs/[id],worker/tick}/route.ts`, `apps/web/app/distribute/**`, `tests/integration/jobs.test.ts`, `docs/DECISIONS.md`(D18), `README_KO.md`, `.env.example`(JOB_SUBMIT_TIMEOUT_MS)
- Migrations / restore implications: `0017_t11_jobs` — jobs 컬럼 추가·상태 CHECK 확장(DONE→CONFIRMED 갱신 SQL 수기), send_intents(1회 결과 기록 트리거), publications(`is_mock = (verification='MOCK')`, mock 은 `mock:`/`mock://` CHECK, verification/verified_at/remote_visibility 만 갱신 가능). send_intents·publications 는 **export 만, 복원 안 함**(복원 환경은 신뢰가 아니라 재확인). 복원된 CONFIRMED item 은 publication 없이 돌아온다.
- Actual commands and results (클라우드 Node 22.22.2, 오케스트레이터 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` → pass
  - `pnpm test` → pass 29 files / 515 tests
  - `pnpm test:integration` → pass 18 files / 295 tests, 62.2s
  - `pnpm build` → pass
  - `pnpm db:migrate` → 0017 적용; `pnpm db:seed` → 멱등; `pnpm worker` → tick 1회 exit 0(jobs 집계 출력)
  - `pnpm test:e2e` → NOT_RUN(exit 2)
  - 구현 에이전트 smoke(별도 DB, 삭제됨): 계획→승인→실행 QUEUED → `POST /api/worker/tick` `{leased:1, results:{CONFIRMED:1}, mode:MOCK}` → plan completed, publication `mock:threads:…`/`mock://threads/…`/UPLOADED_PRIVATE/private/verification MOCK/is_mock true → `/api/jobs/{id}` 이벤트 QUEUED→LEASED→SENDING→CONFIRMED, intent 1건 accepted → HTML 에 MOCK 배지·`실제 발행 실적 아님`, `게시 완료` 없음 → 새 QUEUED item 취소 200 canceled → 재취소 409 → CONFIRMED reconcile 409 nothing_to_reconcile; `pnpm worker -- --loop 1000` SIGINT 정상 종료·잠금 해제
- Demo route / local start steps: `/distribute/{id}` → 지금 실행 → `작업 처리 실행(모의 1회)` 버튼(또는 `pnpm worker`) → CONFIRMED · MOCK. 시나리오는 `MOCK_CHANNEL_SCENARIO`(test/dev) 로 전체 적용(항목별 선택은 T12).
- External calls performed: none. mock adapter 는 프로세스 메모리 맵만 사용.
- Mock-only functionality: 채널 어댑터는 MockChannelAdapter 만. live 계정은 `getAdapterFor` 가 LiveChannelNotConfiguredError.
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드). 브라우저 미확인.
  - PGlite 트랜잭션 직렬화 → SKIP LOCKED 경합·잠금 순서(content→variant→plan→item, lease tx 는 job 만)는 실제 PostgreSQL 미검증. A07 테스트는 순차 증명.
  - mock 원격 맵은 프로세스 메모리 → 서버 재시작 후 RECONCILING 은 UNKNOWN 으로 끝남(재전송 없음, 의도된 보수적 동작).
  - 재시도 수치는 잠정(30s base·15min cap·±20% jitter·5회·lease 60s·submit timeout 30s·Retry-After>1h → FAILED).
  - `@cs/providers` 를 worker CLI 가 루트 workspace devDependency 로 phantom 해석(lockfile 불변 위해 worker package.json 미변경).
  - 스펙 대비 추가: `reconcile_count` 컬럼, `reconcile_retry`/`cancel_too_late` 이벤트, UNKNOWN·PLANNED 취소 불가(409), 전송 중 철회 → CANCEL_REQUESTED, 의도 기록 전 반복 crash 는 한도에서 FAILED.
- Questions specifically for Codex:
  1. `beginSend` 의 단일 트랜잭션(검사+SENDING+의도)을 거치지 않고 `adapter.submit` 에 도달하는 경로가 있는가(`finishSend` 의 lease 상실 처리, 수동 reconcile 과 worker 조회 lease 경합)?
  2. `approval_missing`/`snapshot_stale` 뒤 항목을 PLANNED 로 되돌리는 것이 안전한가 — ambiguous 결과가 not_found 로 확정된 RETRY_WAIT job 의 경우 포함?
  3. UNKNOWN 만 있고 CONFIRMED 가 없을 때 plan 을 `partial` 로 둘지, 철회 시 RETRY_WAIT job 을 즉시 BLOCKED 로 할지(현재는 다음 전송 시점)?
  4. 복구·전송·완료 단계는 content→variant→plan→item 전체 잠금, lease 트랜잭션은 job 만 잠금 — 실제 PostgreSQL 에서 교착이 없는가?
  5. `publications` CHECK 와 트리거(verification/verified_at/remote_visibility 만 변경)가 MOCK 결과를 실제 발행 실적으로 세는 경로(복원 포함)를 모두 막는가?
  6. worker CLI 의 `@cs/providers` phantom 의존이 허용 가능한가, worker package.json 에 선언(lockfile 변경)해야 하는가?
- Next authorized task: T12 (MockChannelAdapter 성공·실패·불명확·부분 성공 시나리오)
