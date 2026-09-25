# Implementation handoff — T12
- Task ID / milestone: T12 / M3 (MockChannelAdapter 로 성공·실패·불명확 응답·부분 성공 테스트) — **M3 마지막 작업**
- Purpose and changed behavior: 모의 어댑터 시나리오 15종(성공/공개 성공/처리 중/일시 오류/429/5xx 부작용 유무/영구/401/불명확 sent·not_sent/시간 초과/취소 지원/조회 불가)을 항목별로 선택(스냅샷·해시 밖의 `mock_scenarios` 표, 모의 계정만)해 M3 통과 조건을 끝까지 증명한다. A09 PARTIAL(4채널 계획, 성공 채널 재전송 0), 사용자 재시도(BLOCKED → 새 시도·새 의도), RETRY_WAIT 철회 즉시 차단, 계획 상태 `attention`, YouTube 비공개 업로드 문구(A12), `pnpm drill:mock` 게이트(26 케이스·불변식 4종).
- BASE_SHA: 6200cb9 (T11 코드 a2a9670 + 인계 사본)
- HEAD_SHA: 240080b7e31587179bfa12174d08b2fe8a2ac98a
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M3 전체 통과 조건(승인 없는 실행 거부·수정 뒤 승인 거부·중복 전송 방지·응답 유실 시 자동 재게시 없음·종료 후 상태 보존·성공 화면 MOCK 표시·실제 발행 실적 저장 금지), A07·A08·A09·A10·A11·A12·A20
- Changed files: `git show --stat 240080b`. 주요: `packages/db/drizzle/0018_t12_mock_scenarios.sql`, `packages/db/src/{mock-scenarios,jobs,approval-invalidation,distribution,writing}.ts`, `packages/db/scripts/{drill,drill-matrix}.ts`, `packages/providers/src/channel-adapter.ts`, `packages/domain/src/{jobs,distribution,bundle}.ts`, `apps/web/app/api/distribution-items/[id]/{mock-scenario,retry}/route.ts`, `apps/web/app/distribute/[id]/page.tsx`, `apps/web/lib/distribution.ts`, `tests/integration/{m3-gate,m3-hardening,jobs}.test.ts`, `docs/DECISIONS.md`(D19), `README_KO.md`, `package.json`(drill:mock)
- Migrations / restore implications: `0018_t12_mock_scenarios` — mock_scenarios(export 만), 계획 상태 CHECK 에 `attention` 추가 + 기존 계획 재분류 UPDATE(Codex 질문 2). 복원 관련 변경 없음(publications/send_intents 미복원 확인 테스트 추가).
- Actual commands and results (클라우드 Node 22.22.2, 오케스트레이터 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` → pass
  - `pnpm test` → pass 29 files / 530 tests, **2회 연속 통과**(구현 에이전트가 1회 1건 실패를 봤으나 어떤 테스트인지 미기록·5회 재실행 통과 → 불안정 가능성 잔존)
  - `pnpm test:integration` → pass 20 files / 312 tests, 77s
  - `pnpm build` → pass
  - `pnpm db:migrate` → 0018 적용; `pnpm db:seed` → 멱등
  - `pnpm drill:mock` → exit 0: 26 케이스, 모의 submit 49, fetch 0, 불변식 위반 0 (표는 README_KO.md 참조)
  - `pnpm test:e2e` → NOT_RUN(exit 2)
  - 구현 에이전트 smoke(포트 3100, 별도 DB): 4채널 계획 → 시나리오(threads success / instagram auth / youtube success / blog transient_then_success) 저장이 해시를 바꾸지 않음 → 승인·실행 MOCK 4 → tick ×3 → plan `partial`(instagram BLOCKED `계정 다시 연결 필요`, youtube `비공개 업로드 완료, 공개 전환 확인 필요`) → instagram 시나리오 success → retry → tick → plan `completed`; 의도 수 youtube 1·instagram 2·blog 2·threads 1; HTML 에 `게시 완료`·`공개 게시 성공` 없음
- Demo route / local start steps: `/distribute/{id}` 에서 각 항목 `개발용 · 모의 결과 선택` → 승인 → 실행 → `작업 처리 실행(모의 1회)` 반복 → 상태·MOCK publication 확인. 헤드리스: `corepack pnpm drill:mock`.
- External calls performed: none.
- Mock-only functionality: 전부. 항목별 시나리오는 production 빌드에서도 동작(모의 계정 한정, 환경변수 `MOCK_CHANNEL_SCENARIO` 만 test/dev 한정) — Codex 질문 4.
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드). 브라우저 미확인.
  - **D17(d) 뒤집음**: 브랜드 프로필 새 버전이 활성 승인을 무효화(`invalidated:brand_changed`). 사용자 확인 필요(D19).
  - DB 는 승인된 버전의 `assets.checksum` UPDATE·`variant_assets` INSERT 를 막지 않음 — 실행·재시도·전송 직전 재검사에서만 잡힘(hardening 테스트). 트리거로 막을지 Codex 질문 3.
  - 원고·첨부 수정 훅은 BLOCKED 항목의 승인을 철회하지 않음 — retry 가 `snapshot_stale` 로 거부.
  - 단위 테스트 1건 간헐 실패 가능성(미특정).
  - PGlite 직렬화 → 동시성 케이스는 순차 증명(T10·T11 과 동일).
  - 계획 상태 규칙 변경: PLANNED+CONFIRMED → partial, PLANNED+CANCELED → attention.
- Questions specifically for Codex:
  1. `retryItem` 이 같은 승인으로 재전송하는 것이 맞는가(401 뒤 재시도에 새 승인을 요구해야 하는가)? 조건(BLOCKED·마지막 의도 pending/ambiguous 아님·해시 일치·스냅샷 재검사·시도 한도)이 충분한가?
  2. `attention` 규칙(PLANNED+CANCELED → attention, PLANNED+CONFIRMED → partial)과 0018 의 기존 계획 재분류 UPDATE 가 잘못 분류하는 경우가 있는가?
  3. `assets.checksum`·기존 버전 `variant_assets` 불변을 DB 트리거로 강제해야 하는가(현재는 재검사 의존)?
  4. 항목별 모의 시나리오가 production 에서도 동작하는 것(모의 계정 한정)이 허용되는가, `MOCK_CHANNEL_SCENARIO` 처럼 게이트해야 하는가?
  5. RETRY_WAIT 즉시 철회로, 의도가 pending(이미 보냈을 수 있음)인 job 을 `revokeActiveApprovalsLocked` 가 BLOCKED 로 만드는 경로가 있는가?
  6. 브랜드 무효화가 복원(대상 환경의 현재 브랜드 버전이 다름)에서 `restore_stale` 을 과도하게 만드는가?
- Next authorized task: 없음. M3 완료(T10~T12). M4(T13 OAuth·비밀 암호화)는 실계정·외부 승인 필요 — 사용자 결정 후.

---

# FIX round 1 (Codex review-T12)
- Review input: `.handoffs/review-T12.md` (CHANGES_REQUESTED). Instruction: `prompts/CLAUDE_FIX.md`. Done together with the T11 FIX round (same working tree; see `.handoffs/T11_IMPLEMENTATION_HANDOFF.md`).
- BASE_SHA: 5319cc7 (`content-studio/m3`, FIX T10 committed)
- HEAD_SHA: TBD (orchestrator commits; uncommitted working tree at hand-off)
- Reproduction: the P0 case in `m3-hardening` B failed on HEAD, because the old test and code expected `snapshot_stale` with the approval still active. `migration-0020.test.ts` failed with a column-only 0020 (`case 0: expected 'draft' to be 'partial'`). The P2 lib test targets new exports; on HEAD the old `blockReasonOf` returned `invalidated:assets_changed` as the reason, which is how the Codex repro failed.

| Finding | Change | Test |
|---|---|---|
| P0 approval-invalidation.ts:44 editing a BLOCKED item keeps its approval | `REVOCABLE_ITEM_STATUSES` now includes BLOCKED, so every edit hook (variant/content/brand/account) and `invalidateItems` revokes the approval with `invalidated:<reason>` (audit `approval.invalidate`). The item goes BLOCKED → PLANNED unless it has `restored_needs_review`. The job **stays BLOCKED**, so an unconfirmed send is not made runnable again. This reverses D19(d); recorded in the D20 follow-up paragraph in `docs/DECISIONS.md`. | `m3-hardening` B: 401-BLOCKED item + `appendVariantVersion` → approval `invalidated:body_changed`, item PLANNED, job BLOCKED, retry → 409 `approval_required`. The `snapshot_stale` retry branch is still covered through a change that bypasses the hooks (direct account UPDATE). |
| P1 0018:22 incomplete plan backfill | Migration `0020_t11_t12_fix_restore_history_plan_status` recomputes **every** plan's status in SQL with the same priority as `planStatusFrom` (no items → draft; in-flight → executing; all PLANNED → by active-approval count; all CONFIRMED → completed; all CANCELED → canceled; any CONFIRMED/PARTIAL → partial; any BLOCKED/UNKNOWN/PLANNED → attention; else failed). Only changed plans get `revision + 1`. | `tests/integration/migration-0020.test.ts` (new): DB at 0019 with stale rows (PLANNED+CONFIRMED stored draft/approved → partial; PLANNED+CANCELED draft → attention; PLANNED+FAILED → attention; all-CONFIRMED stored executing → completed; empty → draft; unchanged cases keep revision 1). Each case is also checked against `planStatusFrom`. |
| P2 lib/distribution.ts:269 reason hides the standard code | New `blockInfoOf(events, job)` returns `{ code, detail }`. The code is the first approval code found in event `event` / `lastErrorCode` / `reason`, otherwise the reason. The detail (`invalidated:…`, `user: …`) is shown separately via `blockDetailLabel`. `itemHeadline` for PLANNED + BLOCKED job: an approval code **or** no active approval counts as an approval problem. If the snapshot changed (`problems`), the headline says "승인 무효 (…) — … 새 계획 만들기"; otherwise "승인 없음 (…) — 다시 승인 후 실행". The page uses these instead of the old `blockReasonOf`. | `apps/web/lib/distribution.test.ts` (new, unit): the RETRY_WAIT `assets_changed` repro gives code `approval_invalidated` and headline "승인 없음 (첨부 파일이 바뀜)…"; user-revocation detail; `approval_missing`/`auth` codes unchanged; 401-then-edit gives the new-plan guidance; plain PLANNED stays "계획됨". |

- Changed files (T12 part): `packages/db/src/approval-invalidation.ts`, `packages/db/drizzle/0020_…sql`, `apps/web/lib/{distribution.ts,distribution.test.ts}`, `apps/web/app/distribute/[id]/page.tsx`, `tests/integration/{m3-hardening.test.ts,migration-0020.test.ts (new)}`, `docs/DECISIONS.md` (shared with T11 — see that handoff for the full list).
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; dev server stopped): `corepack pnpm lint` pass · `typecheck` pass · `test` pass, 30 files / 548 tests · `test:integration` pass, 23 files / 325 tests, 196 s · `build` pass · `drill:mock` exit 0, 불변식 위반 0건.
- Remaining risks: `retryItem` still checks only the intent for `job.attempt` (Codex Q1/missed case: no intent for the current attempt while an older one is pending/ambiguous) — not changed. Restoring into an environment whose current brand differs still revokes as `restore_stale`/`brand_changed` (Codex Q6) — behaviour unchanged and not separately tested. Real PostgreSQL concurrency not_run.
- Questions specifically for Codex:
  1. Revoking a BLOCKED item's approval while leaving its job BLOCKED: can any path (`retryItem`, `executePlan` with a new command key, `cancelItem`) now send for that item without a fresh approval, or leave two active jobs?
  2. Is it right to keep a BLOCKED item with `restored_needs_review` in BLOCKED (approval revoked, item not PLANNED), or should it also go to PLANNED?
  3. Does the SQL in 0020 match `planStatusFrom` for every combination, including legacy `PARTIAL` items and plans with zero items?
  4. `blockInfoOf` gives approval codes priority over a later non-approval reason from the same event. Can an item that is BLOCKED for `auth` and later had its approval invalidated show the wrong headline (the item is PLANNED then; is "승인 무효/새 계획" always correct)?

---

# FIX round 2 (Codex review-FIX-T11T12)
- Review input: `.handoffs/review-FIX-T11T12.md`. The T12-side item is P2 lib/distribution.ts:332; the P1 and page.tsx:28 are in `.handoffs/T11_IMPLEMENTATION_HANDOFF.md`.
- BASE_SHA: d67dde9 · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: the new matrix test in `apps/web/lib/distribution.test.ts` fails with the HEAD `apps/web/lib/distribution.ts` (a re-approved item with a historical `approval_revoked` block showed "승인 없음").

| Finding | Change | Test |
|---|---|---|
| P2 lib/distribution.ts:332 re-approved item shows "승인 없음" | In `itemHeadline`'s PLANNED branch, `activeApproval === true` returns "계획됨(실행 전)" before any historical block reason is considered. The "승인 없음/승인 무효" headline only applies when there is no active approval. | Matrix of `activeApproval` ∈ {true, false} × every `APPROVAL_BLOCK_REASONS` code: true → "계획됨(실행 전)", false → "승인 없음 — 다시 승인 후 실행". |

- Commands: same run as T11 round 2 — lint/typecheck pass, unit 30 files / 550, integration 23 files / 330, build pass, drill:mock exit 0.
- Questions specifically for Codex:
  1. With an active approval now taking precedence, is there a state where a PLANNED item has an active approval and yet cannot be executed (e.g. the job is still BLOCKED because of `auth`), and should the headline then say something other than "계획됨"?
  2. Should an item with an active approval but snapshot `problems` (the approval will be refused at execute) show the "새 계획 만들기" guidance instead of "계획됨"?
