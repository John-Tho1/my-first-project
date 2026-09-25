# Implementation handoff — T10
- Task ID / milestone: T10 / M3 (불변 payload·계정별 미리보기·approval revocation·execute idempotency)
- Purpose and changed behavior: 검토(review) 파생본을 모의 채널 계정에 배포하는 계획을 만들면 서버가 canonical payload(나가는 글·첨부 checksum·계정·공개 범위·시각) 스냅샷과 SHA-256 을 저장한다. 승인은 사용자가 본 해시와 서버 해시가 같고 스냅샷이 현재와 일치할 때만 기록되고, 본문·첨부·원고·계정이 바뀌면 자동 철회(A06). 실행은 활성 승인 + command_key 로 한 트랜잭션에서 QUEUED job 만 만든다(처리는 T11). 모의 계정만 존재하므로 결과는 항상 MOCK.
- BASE_SHA: 5d78a9558b… (`git rev-parse 5d78a95`, M2 최종)
- HEAD_SHA: d1844d698f64c5015118f11ee7bd27b388350280
- Clean tracked tree confirmed: yes
- Relevant acceptance IDs: M3 T10, A06(승인 뒤 변경 → 승인 무효), A07(더블클릭 로컬 절반: command_key·idempotency_key), A10(철회 → QUEUED job BLOCKED), A13(과거 예약 거부·MSK↔UTC), docs/03 승인 스냅샷·중복 규칙, docs/04 approvals/jobs/job_events
- Changed files: `git show --stat d1844d6`. 주요: `packages/db/drizzle/0016_t10_distribution.sql`, `packages/domain/src/distribution.ts`, `packages/domain/src/guards.ts`, `packages/db/src/{distribution,approval-invalidation}.ts`, `packages/db/src/{variants,contents,restore,seed,bundle-tables}.ts`, `apps/web/app/api/{distribution-plans,approvals,channel-accounts}/**`, `apps/web/app/distribute/**`, `apps/web/lib/distribution.ts`, `tests/integration/distribution.test.ts`, `docs/DECISIONS.md`(D17), `README_KO.md`
- Migrations / restore implications: `0016_t10_distribution` — channel_accounts(모의 4개 seed), distribution_plans, distribution_items(스냅샷 컬럼 불변 트리거), approvals(append-only·철회 1회·활성 1건 부분 unique·삽입 시 해시/목적 일치 트리거), jobs(item 당 활성 job 1건 부분 unique), job_events(append-only), execute_commands. 복원: plans/items/approvals 복원(변형이 바뀐 승인은 `restore_stale` 철회, 진행 중 item 은 BLOCKED, 그 plan 은 `failed` 로 재계산될 수 있음 — T11 재검토), jobs/job_events/execute_commands 는 export 만.
- Actual commands and results (클라우드 Node 22.22.2, 오케스트레이터 재실행):
  - `corepack pnpm install --frozen-lockfile` → pass, lockfile 변경 없음
  - `pnpm lint` / `pnpm typecheck` → pass
  - `pnpm test` → pass 27 files / 436 tests
  - `pnpm test:integration` → pass 17 files / 270 tests, 58.4s
  - `pnpm build` → pass
  - `pnpm db:migrate` → 0016 적용; `pnpm db:seed` → 모의 계정 4 → 재실행 0 (멱등)
  - `pnpm test:e2e` → NOT_RUN(exit 2)
  - 구현 에이전트 smoke(별도 DB, 삭제됨): 원고→threads 파생본→review→계획 201(body 에 `approved:true` 넣어도 승인 없음)→GET mode MOCK→승인 200→실행 200 `mode:"MOCK"`→같은 key 재실행 `idempotent_replay:true`·job 1건→다른 key 409 already_executed→`/distribute/{id}` HTML 에 MOCK 있고 `게시 완료` 없음; 폼: 미선택 303 error=invalid, 과거 예약 303 schedule_in_past, 미래 예약 MSK/UTC 동시 표시
- Demo route / local start steps: 로그인 → `/contents/{id}` 파생본 검토 → `배포 계획 만들기` → `/distribute/{id}` 항목 선택·확인·`선택 승인` → `지금 실행` → job QUEUED(MOCK, T11 에서 처리).
- External calls performed: none.
- Mock-only functionality: 채널 계정은 `kind='mock'` 만 seed. `assertExecutionAllowed`: mock → MOCK, live 는 PUBLISH_MODE=enabled + 서버 승인이 있어도 어댑터 없음(503). 실제 게시 경로 없음.
- Known risks / not run:
  - Codex 검증 **미실행**(클라우드). 브라우저 미확인(HTML fetch 만).
  - PGlite 는 트랜잭션을 직렬화하므로 "동시 실행" 테스트는 사실상 순차. 잠금 순서(contents→variants→plans→items→approvals→jobs)는 추론만, 실제 PostgreSQL 경합 미검증.
  - 실행 시 stale 감지는 2 트랜잭션(실행 tx 는 쓰지 않고, 두 번째 tx 가 재검사 후 철회 기록).
  - `getPlanDetail` 이 페이지 로드마다 PLANNED 항목 스냅샷을 재검사(≤20 항목 전제).
  - 계정 상태 변경 API/UI 없음(함수만). 브랜드 프로필 변경은 무효화 훅 대상 아님(스냅샷에 brand_profile_version 은 있음 — 실행 시 재검증 대상인지 Codex 질문 1).
  - 스펙 대비 추가: approved 파생본도 새 계획 가능, 무효화 시 QUEUED→PLANNED 복귀, `schedule_passed` 를 stale 로 취급, 승인된 파생본의 수동 lifecycle 변경 409.
- Questions specifically for Codex:
  1. 나가는 내용을 바꾸면서 무효화 훅과 `snapshotProblems` 재검증을 모두 피하는 편집 경로가 있는가(브랜드 프로필 새 버전, 첨부 재업로드로 key 교체, restore add_missing)?
  2. 잠금 순서가 실제 PostgreSQL 에서 교착 없이 동작하는가(`setChannelAccountState` 는 계정 먼저, `executePlan` 은 plan→items 만 잠그고 variants/contents 는 읽기만)?
  3. execute 멱등이 깨지는 경우 — 같은 command_key 를 다른 plan 에 재사용, `execute_commands` unique 경합 — 에 이중 큐잉이나 잘못된 409 가 생기는가?
  4. `canonicalJson`(NFC·정렬·undefined 제거·Date→ISO)이 해시 기준으로 건전한가? 저장 행에서 payload 를 재유도해 stale 을 판정하는 방식이 충분한가?
  5. 복원 후 BLOCKED item·`restore_stale` 승인·plan `failed` 재계산이 보수적으로 올바른가?
  6. `approvals_guard`·`distribution_items_snapshot_immutable` 트리거가 모든 변경 경로를 덮는가, 복원 경로에서 승인 INSERT 트리거가 트랜잭션을 중단시킬 수 있는가?
- Next authorized task: T11 (DB 작업함·lease·재시도·재확인·취소)

---

# FIX round 1 (Codex review-T10)
- Review input: `.handoffs/review-T10.md` (gpt-6-astra / xhigh, CHANGES_REQUESTED). Instruction: `prompts/CLAUDE_FIX.md`.
- BASE_SHA: be7fb5be0fe07243c20a604c0b75871bb5f95a4b (`content-studio/m3`, D20)
- HEAD_SHA: TBD (orchestrator commits; uncommitted working tree at hand-off)
- Reproduction: `tests/integration/fix-t10.test.ts` was run against the pre-fix `packages/db/src/{restore,distribution}.ts` + `packages/domain/src/bundle.ts` (HEAD copies swapped in temporarily, then restored) → **4 failed / 2 passed** (P0, P1-approve xmax, P1-plan xmax, P1-payload failed; the 2 trigger tests depend on 0019). After the fix → 6 passed. P2 unit tests fail on the old `canon` by construction (no throw, key overwritten); not separately executed against HEAD.

| Finding | Change | Test |
|---|---|---|
| P0 restore.ts:267 UNKNOWN → BLOCKED | `@cs/domain` `restoredItemStatus` / `RESTORE_AS_UNKNOWN_ITEM_STATUSES`: SENDING·REMOTE_PROCESSING·RECONCILING·UNKNOWN·CANCEL_REQUESTED → **UNKNOWN**, QUEUED·RETRY_WAIT → BLOCKED; new column `distribution_items.restored_needs_review` (0019) set true for both; `ApplyReport.unknownItems` + preview/commit `unknown_items`; `retryItem` refuses restored items first (UNKNOWN → 409 `outcome_unknown`, otherwise 409 `not_retryable`); item API view + `/distribute/{id}` tag `복원됨 — 자동 실행·재시도 안 함`. Bundle row schema: plan status `attention` added (an exported attention plan was previously unrestorable), `restored_needs_review` default false. `planStatusFrom` unchanged (UNKNOWN → attention). | `fix-t10` P0 (real ambiguous_sent → UNKNOWN, export, restore into fresh DB: UNKNOWN+flag, QUEUED→BLOCKED+flag, both plans `attention`, 0 jobs, retry → 409 outcome_unknown / not_retryable); unit `restoredItemStatus` matrix |
| P1 distribution.ts:169 approve vs account change | `lockAccountsInOrder(tx, owner, ids, share/update)`; `approveItems` locks the items' accounts FOR SHARE (id order) before `lockItemsInOrder`, readiness check and approval INSERT; `setChannelAccountState` keeps FOR UPDATE as its first lock; `executePlan` also locks the plan's accounts FOR SHARE before the plan row. Deviation from brief: readers use FOR SHARE, not FOR UPDATE (still conflicts with the state change's FOR UPDATE, but readers do not block each other; no path upgrades share → update). | `fix-t10` P1-approve: account row xmax changes across `approveItems` (approvals do not FK the account, so the change is the explicit lock); order A approve → disconnect ⇒ approval revoked; order B disconnect → approve ⇒ 409 snapshot_stale; 0 active approvals in both orders |
| P1 approval-invalidation.ts:43 FK-lock deadlock | One documented order (head comment of approval-invalidation.ts): `channel_accounts → contents → variants (→ variant_versions FK) → distribution_plans → distribution_items → approvals → jobs`. `createPlan` now locks accounts (FOR SHARE, sorted) then `shareLockVariantsInOrder` (contents → variants FOR SHARE, sorted) before any INSERT, so the item INSERT's KEY SHARE locks are already covered. Edit paths never lock accounts, so `lockItemsInOrder` does not either. | `fix-t10` P1-plan: 2-account plan (threads+blog) → approve → disconnect blog ⇒ only blog approval revoked, plan partially_approved; reverse order ⇒ createPlan 409 account_not_ready, no plan row; contents xmax changes on createPlan (items do not FK contents). **True concurrent PostgreSQL verification: not_run** (PGlite = one connection). |
| P1 bundle.ts:424 payload structure | `canonicalPayloadSchema` (strict, discriminated by channel; text per `channelOutgoingText`; assets[] strict {id uuid, checksum sha256, role enum, order int≥1 strictly increasing, mime}; brand uuid/null; visibility; scheduled_at_utc ISO/null; timezone literal; provider_metadata `{}`; snapshot_version 1) + `canonicalPayloadProblems`; `checkDistributionIntegrity` validates every item (approved or not) → problem `distribution_items[<id>].payload_json 구조: …`; also compares payload brand/timezone/channel with row/variant. | `fix-t10` Codex repro (unapproved item, text+assets removed, hash recomputed) → integrity error naming the item; untouched bundle passes; unit schema tests (4 channels pass, JSON round trip; removals, extra keys, wrong text shape, asset order, snapshot_version, provider_metadata rejected) |
| P2 distribution.ts:115 NFC key collision | `canon`: normalize keys → reject duplicates (`CanonicalKeyCollisionError`, code `canonical_key_collision`) → sort normalized keys → `Object.create(null)` result | unit: `{"é":1,"é":2}` throws (also nested); `__proto__` stays a plain key and round-trips; sort uses normalized keys |
| D19-b (D20) DB triggers | migration `0019_t10_fix_restore_triggers` (drizzle-kit column + hand-written triggers): `assets_content_immutable` (UPDATE of a set checksum/bytes rejected); `variant_assets_version_open` (INSERT rejected if the version is referenced by any `distribution_items`, or the variant's current version number is greater). Rule + rationale in `docs/DECISIONS.md` D20 follow-up. | `fix-t10` triggers: checksum/bytes UPDATE rejected, other column update ok; INSERT into old v1 rejected; INSERT into plan-referenced current v2 rejected; `setVariantAssets` still attaches; P0 restore restores both variant_assets incl. the old version's. `m3-hardening` C2 adapted: the direct tamper now asserts DB rejection, and the execute re-check is still proven by disabling the trigger temporarily (defense in depth kept, no assertion removed) |

- Changed files: `packages/domain/src/{distribution.ts,distribution.test.ts,bundle.ts}`, `packages/db/src/{approval-invalidation.ts,distribution.ts,restore.ts,jobs.ts,schema.ts}`, `packages/db/drizzle/0019_t10_fix_restore_triggers.sql`, `packages/db/drizzle/meta/{_journal.json,0019_snapshot.json}`, `apps/web/app/distribute/[id]/page.tsx`, `tests/integration/{fix-t10.test.ts (new),m3-hardening.test.ts}`, `docs/DECISIONS.md`.
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0):
  - `corepack pnpm lint` → pass
  - `corepack pnpm typecheck` → pass
  - `corepack pnpm test` → pass, 29 files / 536 tests (was 530)
  - `corepack pnpm test:integration` → pass, 21 files / 318 tests (was 312), 274 s
  - `corepack pnpm drill:mock` → exit 0, `불변식 위반 0건 — M3 게이트 통과(MOCK)`, submit 49, fetch 0
  - `corepack pnpm build` → **not_run** by the implementer (dev server is up; orchestrator order: preview_stop → build)
  - `pnpm db:migrate` on `./data/pglite` → not_run (dev server holds the lock); 0019 is applied on every memory:// test DB
- Remaining risks: real PostgreSQL concurrency not_run; `restored_needs_review` is mutable (not in the snapshot-immutable trigger) and has no clear/acknowledge action yet; restored in-flight items can only be superseded by a new plan (no reconcile — jobs are not restored); `executePlan` `now` is still fixed at entry (Codex missed case, not addressed).
- Questions specifically for Codex:
  1. Is FOR SHARE (createPlan/approve/execute) vs FOR UPDATE (setChannelAccountState) on `channel_accounts` sufficient to close the approve/disconnect race under PostgreSQL READ COMMITTED, and does any path take an account lock after contents/variants (order inversion) — e.g. worker `beginSend`, brand invalidation (`users` lock), mock-scenario API?
  2. `createPlan` share-locks contents → variants before INSERT; can the FK KEY SHARE on `variant_versions` / `content_versions` / `brand_profiles` still form a cycle with any FOR UPDATE path (append-only rows, but check restore and brand versioning)?
  3. `variant_assets_version_open` rule (b) relies on restore linking `variants.current_version_id` only after all tables are inserted — is there a restore/add_missing case (existing 'same' variant plus a new older version) where the trigger fires and aborts the restore transaction instead of producing a graceful conflict?
  4. Is the restore mapping CANCEL_REQUESTED → UNKNOWN and RETRY_WAIT → BLOCKED correct, and is `restored_needs_review` a sufficient "no automatic execution" attribute given there is no path to clear it?
  5. Does `canonicalPayloadSchema` accept every payload the app has ever produced (instagram `cards[].index` 0 fallback, empty `posts`, blog without title), so older bundles are not rejected?

---

# FIX round 2 (Codex review-FIX-T10)
- Review input: `.handoffs/review-FIX-T10.md` (CHANGES_REQUESTED, 2 × P1 on migration 0019).
- BASE_SHA: b0ab90c (`content-studio/m3`, FIX T11+T12 committed)
- HEAD_SHA: TBD (orchestrator commits; uncommitted working tree at hand-off)
- Reproduction: the new "FIX round 2" tests in `tests/integration/fix-t10.test.ts` were run with the HEAD `packages/db/src/{restore,variants}.ts` and a no-op 0021 → **2 failed** (the xmax lock trace was unchanged; the add_missing restore aborted on the trigger's `restrict_violation`). After the fix → 8/8 pass.

| Finding | Change | Test |
|---|---|---|
| P1 0019:26 lock-free check does not serialize with `createPlan` | App path: `insertCurrentVariantVersion` calls `assertVersionAttachable` before inserting attachments. It takes the variants row FOR UPDATE (re-entrant; all callers already lock it) and then the variant_versions row FOR UPDATE, which conflicts with `createPlan`'s variant FOR SHARE and the item INSERT's version FK KEY SHARE. Under the lock it re-checks "no distribution_items reference this version" (409 `variant_version_referenced`) and "not older than current" (409 `variant_version_superseded`). Migration `0021_t10_fix2_variant_assets_lock` replaces the trigger function so the backstop takes the same locks (variants → variant_versions) before checking. The D20 follow-up says the lock is the serialization and the trigger is the backstop. | `fix-t10` FIX2-1: order attach → createPlan puts the attachment in the snapshot payload; order createPlan → INSERT on the referenced version is refused; an allowed direct INSERT changes the variants row's xmax (variant_assets has no FK to variants, so the change is the trigger's lock). **True two-connection PostgreSQL check: not_run.** |
| P1 0019:31 add_missing backfill of an older version's attachments refused | Restore pre-check `variantAssetRestoreBlocker` (same rules as the trigger, against the target DB) reports `snapshot_referenced` / `immutable_version` as a per-row conflict and skips the row. `variant_assets` inserts run inside a savepoint, so a trigger rejection that still happens (a race after the pre-check) becomes the same conflict instead of aborting the restore. The older version row itself is still backfilled (with no attachments). Restore page labels added for both reasons. | `fix-t10` FIX2-2: target restored without v2 (current v3), then add_missing of the full bundle → preview and commit list `{variant_assets, <id>, immutable_version}`, v2's version row and the missing content are restored, 0 attachments on v2. |

- Changed files: `packages/db/drizzle/0021_t10_fix2_variant_assets_lock.sql`, `packages/db/drizzle/meta/{_journal.json,0021_snapshot.json}`, `packages/db/src/{variants.ts,restore.ts}`, `apps/web/app/settings/restores/[id]/page.tsx`, `tests/integration/fix-t10.test.ts`, `docs/DECISIONS.md`.
- Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; dev server stopped): `corepack pnpm lint` pass · `typecheck` pass · `test` pass, 30 files / 548 tests · `test:integration` pass, 23 files / 327 tests, 247 s · `build` pass · `drill:mock` exit 0, 불변식 위반 0건.
- Remaining risks: real PostgreSQL concurrency not_run. After an add_missing, a backfilled old version with no attachments differs from the source environment; this is reported as a conflict, not repaired.
- Questions specifically for Codex:
  1. With `assertVersionAttachable` (variants FOR UPDATE → variant_versions FOR UPDATE) and the 0021 trigger taking the same locks, is every attach/createPlan interleaving serialized on PostgreSQL READ COMMITTED, and is there a deadlock against paths that lock variant_versions first (none known) or the restore transaction?
  2. Is it acceptable to backfill the old version row without its attachments (conflict listed), or should the version row also be withheld so the restored history does not show an attachment-less version?
  3. Does the savepoint around `variant_assets` inserts in restore (converting only `variant_assets_version_open` errors) leave any other trigger error that could still abort a restore with a raw DB error?
