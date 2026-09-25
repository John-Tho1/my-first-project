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

---

# FIX round 1 (Codex review-T11)
- Review input: `.handoffs/review-T11.md` (CHANGES_REQUESTED). Instruction: `prompts/CLAUDE_FIX.md`. Done together with the T12 FIX round (same working tree; see `.handoffs/T12_IMPLEMENTATION_HANDOFF.md`).
- BASE_SHA: 5319cc7 (`content-studio/m3`, FIX T10 committed)
- HEAD_SHA: TBD (orchestrator commits; uncommitted working tree at hand-off)
- Reproduction: `tests/integration/fix-t11-t12.test.ts` was run with the HEAD copies of `packages/providers/src/channel-adapter.ts`, `packages/db/src/{jobs,restore}.ts`, `packages/domain/src/bundle.ts` and the revoke route swapped in temporarily → **6 failed / 6**. After the fix → 6 passed. The new unit tests (adapter in-flight/abort, `late_result` transitions) target new behaviour/exports and were not run against HEAD separately.

| Finding | Change | Test |
|---|---|---|
| P0 channel-adapter.ts:283 in-flight send judged not_found | Mock adapter tracks in-flight submits; `reconcile` answers `unknown` (`mock_in_flight`) for a key whose submit has not returned, and `not_found` only once it has finished without a side effect. `AdapterContext.heartbeat` now throws `LeaseLostError` and aborts the send signal when the lease is lost (`AbortSignal.any` of timeout + lease). The mock checks heartbeat + signal right before writing remotely; `sendJob` refuses to submit if `prepare` finished after an abort. New job event `late_result` (QUEUED·LEASED·RETRY_WAIT → RECONCILING): when `finishSend` finds the lease lost and the late result may have had a side effect, the job goes to reconcile instead of a new intent. | `fix-t11-t12` P0-1: the report's interleaving (A: lease 100 ms, submit delay 400 ms; B recovers and checks while A is in flight → RECONCILING, 1 intent; A's heartbeat fails → no remote write; B then drives to CONFIRMED) → remote entries = 1, publications = 1, intents `[ambiguous, accepted]`. P0-2: remote written, then job forced to RETRY_WAIT before A's reply → `late_result` → RECONCILING → found → CONFIRMED with 1 intent / 1 submit. Unit: in-flight `unknown` then `not_found`; heartbeat throw / abort → no remote entry; `late_result` transition matrix. |
| P1 jobs.ts:725 batch lease starves later jobs | `runJobsTick` leases one job at a time (`leaseJobs` gets `excludeIds` = jobs already handled in this tick; still at most `maxJobs` per tick). `beginSend` returns `lease_lost` without writing if `lease_until <= now`. Recovering an expired LEASED job (no intent) restores `attempt` to its pre-lease value; the old endless-re-lease guard now also counts `lease_expired_before_intent` events against `max_attempts`. | `fix-t11-t12` P1: 3 queued jobs with slow sends (lease 100 ms) → while each is being sent no other job is LEASED, all end with attempt 1 / 1 intent, no expiry events; expired-before-start lease → `processJob` = lease_lost, 0 intents, 0 submits, then sent as attempt 1. Updated `jobs.test.ts` "의도 기록 전에 죽음" to the new rule: attempt 1 (was 2). |
| P1 bundle.ts:110 restored CONFIRMED loses evidence/reconcile path | `jobs`, `send_intents`, `publications` are now restored as **read-only history** (`NON_RESTORED_TABLES` keeps users, audit_events, job_events, execute_commands, mock_scenarios). PARENTS: job → item (owned), intent → job (owned), publication → item + job (owned). Jobs are inserted via `restoredJobState` (terminal and BLOCKED unchanged, DONE → CONFIRMED, QUEUED·LEASED·RETRY_WAIT → BLOCKED, others → UNKNOWN), with the lease cleared and new column `jobs.restored_needs_review = true` (migration 0020). An item that was CONFIRMED but has no restored publication becomes UNKNOWN + flag, and its latest CONFIRMED job becomes UNKNOWN; this is reported as `unverified_confirmed_items`. `retryItem` also refuses restored jobs. MOCK marks are kept by the existing CHECKs. | `fix-t11-t12` P1-restore: publication removed from the bundle → restored item and job are UNKNOWN + flag, the worker leases 0, `reconcileItem` (lookup only, using the restored intent key) → CONFIRMED + MOCK publication, 0 submits. `m3-hardening` C3, `distribution.test` restore and `fix-t10` P0 updated to the new policy (restored jobs are flagged, lease-free and terminal/BLOCKED/UNKNOWN; the CONFIRMED item keeps a MOCK publication and its intent). |
| P2 page.tsx:267 revocation message | The revoke route redirects with `revoked_blocked=<jobs moved to BLOCKED>&revoked_cancel=<jobs set to CANCEL_REQUESTED>`. `revocationNotice` in lib builds the text from those stored results only (no counts → only "승인을 철회했습니다"). RETRY_WAIT is already blocked immediately (T12). | `fix-t11-t12` P2: revoke during SENDING (from the adapter `onSubmit` hook) → 303 `revoked_blocked=0&revoked_cancel=1`, text "취소 확인 중" with no "보류"; then `cancel_too_late` → CONFIRMED. Revoke while QUEUED → `1/0`, job BLOCKED. Lib unit test for all four message cases. |

- Changed files (T11 part): `packages/providers/src/{channel-adapter.ts,channel-adapter.test.ts}`, `packages/domain/src/{jobs.ts,jobs.test.ts,bundle.ts,distribution.ts}`, `packages/db/src/{jobs.ts,restore.ts,schema.ts}`, `packages/db/drizzle/0020_t11_t12_fix_restore_history_plan_status.sql`, `packages/db/drizzle/meta/{_journal.json,0020_snapshot.json}`, `apps/web/app/api/approvals/[id]/revoke/route.ts`, `apps/web/app/distribute/[id]/page.tsx`, `apps/web/lib/{distribution.ts,distribution.test.ts}`, `tests/integration/{fix-t11-t12.test.ts (new),jobs.test.ts,m3-hardening.test.ts,distribution.test.ts,fix-t10.test.ts}`, `docs/DECISIONS.md`.
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; dev server stopped): `corepack pnpm lint` pass · `typecheck` pass · `test` pass, 30 files / 548 tests · `test:integration` pass, 23 files / 325 tests, 196 s · `build` pass · `drill:mock` exit 0, 불변식 위반 0건, submit 49, fetch 0.
- Remaining risks: real PostgreSQL concurrency not_run. Aborting before the side effect is a mock property; a live adapter may already have sent, and then only the in-flight/`late_result` guards apply. A manual reconcile still does not compare the attempt it looked up with the current attempt (Codex missed case). Restored jobs have no job_events. The worker `@cs/providers` dependency declaration (Codex Q6) was not changed.
- Questions specifically for Codex:
  1. Is `unknown` for an in-flight key plus `late_result` (QUEUED·LEASED·RETRY_WAIT → RECONCILING) enough to rule out a second remote result when a **live** adapter cannot abort after heartbeat failure — e.g. a definitive not_found from another worker racing the original response?
  2. Restoring `attempt` on expired-before-intent and counting `lease_expired_before_intent` events for the poison guard: can a job now loop forever, or lose `intent_key` uniqueness (`<job>:<attempt>` reused after an intent was written)?
  3. The restore mapping for jobs (`restoredJobState`) versus items (`restoredItemStatus`): is there a bundle combination that breaks `jobs_active_item_uq` (two UNKNOWN jobs for one item) or leaves item and job states inconsistent?
  4. Does restoring publications/send_intents as history (with `jobs.restored_needs_review`) create any path where a restored MOCK result is counted as a real publication, or a restored pending intent is filled by a reconcile in the new environment incorrectly?
  5. One-job-at-a-time leasing: any throughput or fairness regression for the CLI worker (`maxJobs 20`) or `/api/worker/tick`?

---

# FIX round 2 (Codex review-FIX-T11T12)
- Review input: `.handoffs/review-FIX-T11T12.md` (1 × P1, 2 × P2). The T12-side item (P2 lib/distribution.ts:332) is recorded in `.handoffs/T12_IMPLEMENTATION_HANDOFF.md`.
- BASE_SHA: d67dde9 (`content-studio/m3`, FIX T10 round 2 committed)
- HEAD_SHA: TBD (orchestrator commits; uncommitted working tree at hand-off)
- Reproduction: with HEAD `packages/db/src/jobs.ts` and `apps/web/lib/distribution.ts` swapped in → the 2 new P1 integration tests and the 2 new P2 lib tests fail (4/4). After the fix they pass.

| Finding | Change | Test |
|---|---|---|
| P1 jobs.ts:276 pre-intent expiry burns the last attempt | `leaseJobs` no longer increments `attempt` (the event records `next_attempt`). `beginSend` increments it when it inserts the send intent (same transaction: `send_start` sets `attempt + 1`; intent key `<job>:<attempt+1>`). If `attempt >= max_attempts`, it FAILs without sending (`attempts_exhausted`). Recovering an expired LEASED job (no intent) → QUEUED, `jobs.lease_expired_before_intent += 1` (migration `0022_t11_fix2_pre_intent_expiry`, CHECK ≥ 0). The job FAILs (`lease_expired_before_intent`, not sent) when that counter reaches `PRE_INTENT_EXPIRY_LIMIT` = 5, independent of `max_attempts`. "Was the cancel requested before sending?" is now read from the latest `cancel_requested` event's `state_before` (LEASED/QUEUED), not from intent presence, in recovery and in `checkJob`. Bundle `jobs.lease_expired_before_intent` defaults to 0. | `fix-t11-t12` round 2: 4 real transient sends → the 5th lease expires before its intent → recovery keeps attempt 4 → the same tick makes the 5th real attempt → CONFIRMED, intents 1–5 (pre-fix: FAILED `lease_expired_max_attempts`); 5 repeated pre-intent expiries → FAILED `lease_expired_before_intent`, attempt 0, 0 intents, 0 submits. `jobs.test` poison-job test rewritten for the separate counter, plus a new `attempts_exhausted` test. Test and drill setups that simulate `beginSend` by hand now also set `attempt: 1`. `fix-t11-t12` P1 lease test expects attempt 0 after the lease. The drill table is byte-identical to the previous run. |
| P2 page.tsx:28 `/^d{1,3}$/` | Parsing moved to lib `revocationCountParam` (`/^\d{1,3}$/`, trimmed); the page uses it. The typo came from writing the regex through a JS template literal (`\d` → `d`). | lib unit test: redirect URL `revoked_blocked=0&revoked_cancel=1` → `[0, 1]` → "취소 확인 중"; invalid values → null. |

- Changed files: `packages/db/src/{jobs.ts,approval-invalidation.ts,schema.ts}`, `packages/domain/src/{jobs.ts,bundle.ts}`, `packages/db/drizzle/0022_t11_fix2_pre_intent_expiry.sql`, `packages/db/drizzle/meta/{_journal.json,0022_snapshot.json}`, `packages/db/scripts/drill-matrix.ts` (setup only), `apps/web/app/distribute/[id]/page.tsx`, `apps/web/lib/{distribution.ts,distribution.test.ts}`, `tests/integration/{jobs.test.ts,fix-t11-t12.test.ts}`, `docs/DECISIONS.md`.
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; dev server stopped): `corepack pnpm lint` pass · `typecheck` pass · `test` pass, 30 files / 550 tests · `test:integration` pass, 23 files / 330 tests, 214 s · `build` pass · `drill:mock` exit 0, 불변식 위반 0건, table identical.
- Remaining risks: real PostgreSQL concurrency not_run. The worker's `@cs/providers` dependency declaration (Codex Q6) and live-adapter duplicate protection (Codex FIX Q1) are still open.
- Questions specifically for Codex:
  1. With `attempt` now incremented only in `beginSend`, is there any remaining reader that assumes a LEASED job's `attempt` is the attempt about to be sent (intent lookup, `retryItem`, the `late_result` comparison `job.attempt !== plan.job.attempt`, `jobView`)?
  2. Is inferring "cancel requested before send" from the latest `cancel_requested` event's `state_before` sound for every path (user cancel, approval revoke, lease recovery), and safe when that event is missing (falls back to a remote check)?

---

# FIX round 3 (Codex review-FIX2-T11T12)
- Review input: `.handoffs/review-FIX2-T11T12.md` (1 × P1: 0022 does not normalize `attempt` that the pre-0022 worker incremented at lease time).
- BASE_SHA: 80f2881 · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: `tests/integration/migration-0023.test.ts` with a no-op 0023 → 2 failed / 2; with 0023 → 2 passed.

| Finding | Change | Test |
|---|---|---|
| P1 0022:3 pre-incremented attempt on existing LEASED jobs | Migration `0023_t11_fix3_normalize_attempt` (data only): for every non-terminal job (not CONFIRMED/FAILED/CANCELED) whose `attempt` is greater than the largest `send_intents.attempt` for that job, set `attempt` to that largest intent number (0 if there is none). Intent numbers that already exist are kept. The maximum is used instead of the count so the next key `<job>:<attempt+1>` never collides with an existing intent key when old recoveries skipped a number. Precondition in the migration header and the D20 follow-up: **stop the old worker (CLI, inline tick, `/api/worker/tick`) before upgrading**. | Migration order (0021 data → 0022 → 0023): LEASED attempt 2 / 1 intent → 1; LEASED attempt 5 / 4 intents → 4; gap (attempt 3, intent #2 only) → 2; BLOCKED attempt 1 / no intent → 0; RETRY_WAIT attempt 2 / intents 1–2 unchanged; FAILED unchanged. App: 1 real send then an old-style lease (attempt 2) → 0023 → recovery + `beginSend` writes intent #2 → CONFIRMED; 4 real sends then an old-style lease (attempt 5) → 0023 → the 5th real attempt (intent #5) → CONFIRMED; both have intents contiguous 1..n and `lease_expired_before_intent` = 1. |

- Changed files: `packages/db/drizzle/0023_t11_fix3_normalize_attempt.sql`, `packages/db/drizzle/meta/{_journal.json,0023_snapshot.json}`, `tests/integration/migration-0023.test.ts` (new), `docs/DECISIONS.md`.
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; dev server up, so **`pnpm build` not run** — orchestrator builds after stopping it): `corepack pnpm lint` pass · `typecheck` pass · `test` pass, 30 files / 550 · `test:integration` pass, 24 files / 332, 256 s · `drill:mock` exit 0, 불변식 위반 0건.
- Questions specifically for Codex:
  1. Is "largest intent number" (rather than count) the right target for every pre-0022 history, including a job whose latest intent is still `pending` while the job is LEASED (possible only if the old worker crashed between intent and state change)?
  2. Should 0023 refuse to run (or should the app refuse to start) while a lease held by a pre-0022 worker is still live, instead of relying on the documented stop-the-worker precondition?
