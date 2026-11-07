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

---

# FIX round (M3 화면 검증, D1·D2·D3·D5·D8·D9)
- Input: `.handoffs/screen-notes-m3.md` ("진행 기록", "완료 기록"). This is the implementer checking its own work in the browser, not an independent Codex check. Decision: D21 in `docs/DECISIONS.md`.
- BASE_SHA: 77a152d · HEAD_SHA: TBD (uncommitted working tree; the orchestrator commits)
- Reproduction: run the new tests against the HEAD 77a152d sources. These fail there: D1 unit `channel.test.ts` "D1: 브라우저 폼의 \r\n …"; D1/D2 integration `variants.test.ts` "M3 화면 FIX D1·D2" (all 4 fail); D8 integration `m3-hardening.test.ts` "M3 화면 FIX D8" (got `reconciled=not_found`). D5 and D3 add new helpers or data functions, so their tests have no HEAD counterpart. D5's fake-query case is the live repro (`?approved=1&executed=1` on an unapproved plan with 0 jobs).

| Finding | Change | Test |
|---|---|---|
| D1 [P1] the form can't save a multi-paragraph body (browser sends CRLF) | `variantBodyMismatch` turns CRLF and CR into LF on both sides before comparing. `formToVariantEdit` saves the body as LF (`normalizeNewlines`). | unit: CRLF in all 4 channel shapes, plus CR alone and the reverse direction, and a real mismatch is still `true`. integration: a CRLF multi-paragraph form POST for threads/instagram/youtube/blog → 303 `variant_saved`, version 2, stored body LF. JSON API: CRLF body vs LF parts → 201. |
| D2 [P2] generic error, and the user had to keep raw JSON fields in sync | Form path only: `appendVariantVersion(bodyAuthoritative: true)` → `deriveBodyFields`. threads: parts = paragraphs(body), text = first part, body rejoined with single blank lines. A part over 500 chars → 400 `thread_part_too_long`. Over 20 parts → `thread_too_many_parts` (never auto-split). instagram caption, youtube script and blog markdown = body. The other fields keep the user's JSON, and the schema check is unchanged. The panel's JSON box shows only non-body fields (`editableMetadata`), and an empty box counts as {}. New help text. Specific error codes go through `writingFormFailure`: `metadata_json`, `invalid_metadata` (reworded), `metadata_body_mismatch`, `thread_part_too_long`, `thread_too_many_parts`. These also show inside the variants panel. JSON API unchanged (mismatch → 400). | unit: deriveBodyFields for 4 channels (result has no mismatch and passes the schema), >500 and >20, editableMetadata. integration: a body-only form edit with derived fields following and non-body fields kept; an old page whose JSON still has thread_parts → body wins; invalid JSON / array → `metadata_json`; empty title or unknown key → `invalid_metadata`; part >500 → `thread_part_too_long`; 21 parts → `thread_too_many_parts`; no new version on error; API mismatch still 400 `metadata_body_mismatch`. |
| D8 [P2] the reconcile banner says "찾지 못했습니다" for unsupported/unknown | Route redirects with `reconciled=reconciledParam(r.remote)`: found / not_found / unsupported / unknown (processing → unknown). Page shows `reconciledNotice` (4 fixed messages). Old values still work. Garbage, array or missing → no banner. Non-found results use the `notice` style. | unit: param mapping, 4 messages, garbage values (`__proto__`, `toString`, case, whitespace, array). integration: a reconcile_unsupported item, reconciled from the form, redirects to `?reconciled=unsupported`, state stays UNKNOWN, 0 re-sends. |
| D5 [P2] success banners come from the query string alone | `bannersFromState(q, planDetail)`. approved = number of items with an active approval (≥1). executed = items with jobs and job count (≥1 job), replay flag kept. canceled / cancel_requested only if an item or job is CANCELED or CANCEL_REQUESTED. retried only if a job is QUEUED. revoked_* is already count-based and unchanged. Informational banners left as they were: `created`, `ticked`, `scenario_saved` (they still trust the query; they describe an action, not a stored-state claim). | unit: fake query on an unapproved, 0-job plan → no claim banners. Real state → counts come from state (query numbers ignored). Cancel, retry and query-value gating. |
| D3 [P2] home 「최근 배포」 shows stale "M3에서 활성화됩니다" | `listRecentPlans(db, owner, 5)` in `packages/db/src/distribution.ts` reuses `listPlans`. The home page shows target summary → `/distribute/{id}`, MOCK tag, `PLAN_STATUS_LABEL`, channels and MSK time, plus 「배포함 전체 보기」. Empty state has the new wording plus `현재 게시: 비활성`. | integration: an owner with no plans → []. 6 plans → 5, newest first. The other owner's plan is excluded. |
| D9 [P2, env] dev 404 on dynamic routes after a restart or build | `apps/web/next.config.ts` `experimental.turbopackFileSystemCacheForDev: false` (exists in next 16.3.6 `config-shared.d.ts:726`). README_KO dev section gets a note and a manual fallback (delete `.next/dev` and `.next/cache`). | typecheck and build pass. The restart behaviour was **not** checked here (no dev server was started), so the orchestrator needs to check it live. |

- Changed files: `packages/domain/src/{channel.ts,channel.test.ts}`, `packages/db/src/{variants.ts,distribution.ts}`, `apps/web/lib/{variants.ts,writing.ts,distribution.ts,distribution.test.ts}`, `apps/web/app/api/variants/[id]/versions/route.ts`, `apps/web/app/api/distribution-items/[id]/reconcile/route.ts`, `apps/web/app/contents/[id]/{page.tsx,variants-panel.tsx}`, `apps/web/app/distribute/[id]/page.tsx`, `apps/web/app/page.tsx`, `apps/web/next.config.ts`, `tests/integration/{variants.test.ts,m3-hardening.test.ts}`, `README_KO.md`, `docs/DECISIONS.md` (D21).
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; no dev server): `corepack pnpm lint` pass · `typecheck` pass · `test` pass, 30 files / 559 tests (baseline 550) · `test:integration` pass, 24 files / 338 tests (baseline 332), 248 s · `build` pass · `drill:mock` exit 0, 불변식 위반 0, fetch 0, mock submit 49.
- Not done: no browser check of the panel, the banners or the home card, and no D9 restart check. P3 items (D4, D6, D7, D10, D11) are out of scope.
- Remaining risks: the JSON API path still stores a CRLF body as sent. Only the comparison is newline-insensitive, so a CRLF body can now be saved next to LF thread_parts, and `renderVariantText` / payload `rendered` would then mix line endings. Threads form normalization trims paragraph whitespace and collapses runs of blank lines, which changes the stored body compared with what was typed.
- Questions specifically for Codex:
  1. Newline normalization: should the JSON API also store LF (normalize body and the compared fields in `appendVariantVersion`), so the payload hash and `rendered` never mix CRLF and LF? Can the newline-insensitive comparison let a body through whose actual outgoing text (threads `posts`) differs from what was checked?
  2. Body-authoritative derivation: is rejecting (rather than auto-splitting) a paragraph over 500 chars right? Is the trim/collapse of empty or whitespace-only paragraphs acceptable? With an empty threads body, `thread_parts: []` and `text: ''` are allowed; should an empty body be rejected?
  3. bannersFromState: approved counts every active approval in the plan, not just the ones from this request. `retried` disappears once a tick takes the job. `canceled` shows if any item in the plan is canceled, even a different one. Are any of these misleading? Should `created`, `ticked` or `scenario_saved` also be checked against state?
  4. unsupported vs not_found: is mapping remote `processing` to `unknown` right? Should `not_found` be shown as "없음" only when the adapter's `definitive_not_found` capability is true?
  5. `turbopackFileSystemCacheForDev: false`: any effect on `next build`/`start` or on the HMR route manifest? Is turning off the cache better than a dev-start cleanup?

---

# FIX round P3 + missed cases (M3 화면 D4·D6·D7·D10·D11, T11 missed cases)
- BASE_SHA: d2b1db8 · HEAD_SHA: TBD (uncommitted working tree; the orchestrator commits)
- Reproduction: run the new tests against the d2b1db8 sources. These fail there:
  - D7: the form tick with `hang` took 30018 ms, past the 1 s UI cap the test sets.
  - Stale lookup: HEAD returned `found: true, state: CONFIRMED` even though the attempt had been bumped between the lookup and the apply.
  - D11 and D10 add new functions or behaviour, so their tests have no HEAD counterpart.
  - D4 and D6 are copy/doc only.

| Finding | Change | Test |
|---|---|---|
| D4 [P3] stale copy | contents page: "채널별 배포 기록은 배포함(/distribute)에서 봅니다" (link). Relation line: "파생본: 채널 초안 N개" (anchor #variants). YouTube media note (YouTube card only): "YouTube 는 완성 영상 1개가 붙어야 검토로 보낼 수 있습니다. 영상은 /record 의 분할 업로드로 올립니다." Grep of apps/web: the remaining "아직 지원하지 않습니다" lines (offline device storage) and "지금 단계(M3)는 모의 배포만" are still true and were left. | — (copy) |
| D6 [P3] checklist ↔ UI wording | `docs/handoffs/M3_LOCAL_RETURN.md` §3 #5 → title `작업(MOCK — 모의 어댑터)` + `QUEUED · 대기`; #8 → `처리 끝(MOCK — 실제 발행 아님)`. The mapping is noted in `docs/handoffs/M3_STATUS.md`. | — (docs) |
| D7 [P3] UI tick blocks for the full adapter timeout on hang | New config `WORKER_UI_TICK_TIMEOUT_MS` (1 s–10 min, default 10000, `.env.example`). `/api/worker/tick` **form** path uses min(that value, `JOB_SUBMIT_TIMEOUT_MS`). The JSON API and the worker CLI keep `JOB_SUBMIT_TIMEOUT_MS` (30 s). The job takes the existing timeout path (ambiguous → RECONCILING, no re-send). | integration (m3-hardening): hang plus UI cap 1 s → 303 in < 10 s, job RECONCILING, 1 intent. |
| D10 [P3] `/distribute/new` loses input after an error | The route appends `planFormEcho(form)` to the error redirect as `e_use`, `e_acc_<vid>`, `e_vis_<vid>`, `e_date_<vid>`, `e_time_<vid>`, `e_name`, keeping only values that validate (UUIDs, the visibility list, YYYY-MM-DD, HH:mm, name ≤200). The page applies `planFormDefaults(q)` only when `error` is present (fresh page = no default selection, docs/03). Approval checkboxes live on the plan page and are never echoed. | unit: echo/defaults round trip, garbage and array values dropped, 200-char name. integration: a past-schedule form → `/distribute/new?content_id…&e_…&error=schedule_in_past`, the parsed defaults equal the submitted values, no plan item created. I did not do an HTML render test: the server page needs a Next request context. |
| D11 [P3] channel draft titles copy the "> 카드:" scaffold | `withoutDraftScaffold(coreBody)`: skips a leading `> 카드:`/`> 원문:` blockquote block and the following `## 초안` line. It is used only for YouTube title/description, blog title and Instagram caption. Script, markdown, cards and thread parts stay as authored. | unit: helper cases (non-scaffold quote or heading kept), youtube/blog/instagram titles and caption, a scaffold-only body falls back to the content title, an unscaffolded body is unchanged. |
| T11 missed case: worker does not declare `@cs/providers` | Added `"@cs/providers": "workspace:*"` to `apps/worker/package.json` and the matching 3-line importer link to `pnpm-lock.yaml`. `install --offline` failed because the local cache lacks metadata (environment), so I ran `corepack pnpm install --frozen-lockfile` instead. It passed: "Lockfile is up to date, resolution step is skipped", 529 entries pass the supply-chain policy, no package added. It contacted registry.npmjs.org for metadata only. `apps/worker/node_modules/@cs/providers` now exists. | — |
| T11 missed case: manual `reconcileItem` applies a stale lookup | Inside the locked transaction, the job's `attempt` and `state` must equal the values seen at lookup time, otherwise the result is `outcome: 'stale_lookup'`: nothing applied, `found: false`, audit `outcome`. The form redirect uses the new `reconciled=stale` message. | integration: the attempt is bumped inside the adapter reconcile → stale_lookup, still RECONCILING, 0 publications. Control without the bump → applied, CONFIRMED, 1 publication. unit: stale notice. |

- Changed files: `packages/domain/src/{channel.ts,channel.test.ts,config.ts}`, `packages/db/src/jobs.ts`, `apps/web/lib/{distribution.ts,distribution.test.ts}`, `apps/web/app/api/{worker/tick,distribution-plans,distribution-items/[id]/reconcile}/route.ts`, `apps/web/app/contents/[id]/{page.tsx,variants-panel.tsx}`, `apps/web/app/distribute/new/page.tsx`, `apps/worker/{package.json,src/cli.ts}`, `pnpm-lock.yaml`, `.env.example`, `tests/integration/{m3-hardening,distribution}.test.ts`, `docs/handoffs/{M3_LOCAL_RETURN.md,M3_STATUS.md}`.
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 30 files / 563 tests.
  - `test:integration` pass: 24 files / 341 tests, 238 s. A first run failed with PGlite "Array buffer allocation failed" (out of memory) because I ran `drill:mock` at the same time; the rerun on its own was clean.
  - `drill:mock` exit 0, 불변식 위반 0, fetch 0, submit 49.
  - `build` **not_run**: a `next dev` (PID 20648, port 3000) was running in this tree, and building over a live dev server is unsafe (memory note), so I left it alone.
- Questions specifically for Codex:
  1. stale_lookup compares `attempt` and `state` only. Can an intent or remote ref change for the same attempt and state (e.g. a late_result write) so that a stale lookup is still applied? Should the comparison also include the intent key or `updated_at`?
  2. D10 puts the plan name and schedule into the redirect query string, so they can end up in access logs and history. Is that acceptable for a single-owner app, or should it be a short-lived cookie?
  3. D11 also skips a leading `> 원문:` block (the capture scaffold) in titles. Is that right when the raw quote is the only real content (the title then falls back to the content title)?

---

# FIX round 2 (Codex review-FIX-M3screen)
- Review input: `.handoffs/review-FIX-M3screen.md` (re-review of d2b1db8). BASE_SHA: 7548f12 · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: with the 7548f12 `apps/web/lib/distribution.ts`, 4 unit tests fail:
  - the 3 new negative tests;
  - the earlier "실제 상태" test, which had asserted the flagged behaviour (first-execution QUEUED → `retried` true) and is now corrected to `false`.

| Finding | Change | Test |
|---|---|---|
| P1 `bannersFromState` canceled and cancel_requested share one condition | `canceled` needs a CANCELED item or job. `cancel_requested` needs a CANCEL_REQUESTED item or job. Each state now triggers only its own banner. | unit: CANCEL_REQUESTED-only plan + `?canceled=1` → no banner, and `?cancel_requested=1` → banner. CANCELED-only plan + `?cancel_requested=1` → no banner, and `?canceled=1` → banner. |
| P2 `retried` fires on any QUEUED job | `retried` needs an item whose latest job is QUEUED **and** whose newest job event is `unblock` with `cause: 'user_retry'`. That event is written by `retryItem` through `settle(…, 'unblock', { cause: 'user_retry' })`. `BannerStateInput` items take an optional `events` (newest first), which `PlanItemDetail.events` already provides. | unit: first-execution QUEUED (event `execute`, or no events) → false. unblock with another cause → false. SENDING after unblock → false. user_retry + QUEUED → true. Without the query → false. integration (m3-hardening, real DB events): executed plan → false; auth BLOCKED → `retryItem` → QUEUED → true; after the tick (CONFIRMED) → false. |

- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; no dev server, port 3000 free):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 30 files / 566 tests.
  - `test:integration` pass: 24 files / 342 tests, 198 s.
  - `build` pass.
  - `drill:mock` exit 0, 불변식 위반 0, fetch 0, submit 49.
- Questions specifically for Codex:
  1. The retried banner reads only the newest event of the latest job. If a tick has already recovered or leased the job and then returned it to QUEUED (lease expired before intent), the newest event is no longer `unblock` and the banner hides. Is that acceptable, or should it look for "an unblock/user_retry with no send_start after it"?
  2. A plan with one item CANCELED and another item CANCEL_REQUESTED shows each banner only when its own query flag is set. The cancel route sets exactly one flag per request. Is any other entry point able to set both?
- **Added to this round — Codex `.handoffs/review-FIX-M3p3.md` P2 (`withoutDraftScaffold`, packages/domain/src/channel.ts):**
  - **Problem:** a `# 초안` / `## 초안` heading was stripped even with no leading `> 카드:` / `> 원문:` block. `channelDraft('youtube','기본 제목','# 초안\n\n본문')` changed its title from 초안 to 본문.
  - **Fix:** with no leading scaffold quote block, the text is returned untouched apart from LF normalization, leading blank lines included. The heading line is skipped only after a scaffold block was removed, and only when it is exactly `## 초안`; a `# 초안` there stays.
  - **Tests (unit, `channel.test.ts`):**
    - No-scaffold `# 초안` / `## 초안` bodies keep their heading-derived YouTube and blog title ("초안") and their Instagram caption.
    - Scaffold + `## 초안` is still stripped for all three.
    - Scaffold + `# 초안` keeps the heading.
    - Both new tests fail with the 7548f12 `channel.ts`.
  - **Commands (after both fixes):**
    - `lint` pass.
    - `typecheck` pass.
    - `test` pass: 30 files / 568 tests.
    - `test:integration` pass: 24 files / 342 tests.
    - `build` pass.
    - `drill:mock` exit 0, 불변식 위반 0.
