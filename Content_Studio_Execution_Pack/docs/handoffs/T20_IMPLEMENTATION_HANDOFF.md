# T20 Implementation Handoff — 모니터링·backup restore drill·보존·용량·비용 (로컬·모의 범위)
- Task: T20 (tasks.json, depends on T12). M4 is still on hold (D20). No external alerts, cloud storage, external calls or new dependencies.
- Decision: D22 in `docs/DECISIONS.md`.
- BASE_SHA: 97b6103 · HEAD_SHA: TBD (uncommitted working tree; the orchestrator commits)
- Implementer: Claude Code. Verifier: Codex (not run yet).

## What was built
| Area | Change | Test |
|---|---|---|
| A. `/ops` (owner-only, read-only, nav "운영" + link from settings) | `opsSnapshot(db, owner, config)` (packages/db/src/ops.ts) counts everything from DB rows and the filesystem:<br>• Jobs: per-state counts, oldest due QUEUED age, next RETRY_WAIT, RECONCILING/UNKNOWN/BLOCKED jobs with a plan link, items with ≥3 rejected/ambiguous send intents in 7 days, `attention` plans.<br>• Pending send intents; pending deletes (count + oldest).<br>• Disk bytes/files for DB dir (null for memory), assets (excluding uploads), uploads, exports, packages and retention archive. Paths are never shown.<br>• Upload sessions expired / past expiry.<br>• Monthly cost per currency (reuses `monthlyUsage`) and limit.<br>• Backup: last completed export age and size, state none/recent/stale against `BACKUP_MAX_AGE_HOURS`, last restore drill.<br>• Modes and live-readiness missing names.<br>• Last retention sweep (from the audit event).<br>No "healthy" badges; "측정 없음" when there is no source. | integration `ops-retention.test.ts`:<br>• counts by state, attention job with plan id, repeated failure = 3, pending delete, backup none → recent → stale (1 h threshold, +3 h), memory DB → `disk.db` null, asset file count, other-owner isolation. |
| A. `/api/health` `ops` | `healthOps`: `backup_age_hours`, `attention_plans`, `repeated_failures`, `pending_deletes`, `disk{db,assets,uploads,exports}`. Numbers only, totals across all owners (health is unauthenticated), disk measurement cached for 60 s. | integration: exact key set, number/null types, no tmp path and no UUID in `ops`. |
| B. Restore drill | `runRestoreDrill` (packages/db/src/restore-drill.ts):<br>1. Exports with `record:false` to a temp dir (not counted as a backup; deleted afterwards).<br>2. Asserts no credentials in the bundle: sessions table, session files, `token_hash`, plain identity.<br>3. Restores into a throwaway memory PGlite plus an empty temp-dir store via preview + `empty_only` commit.<br>4. Compares each RESTORED table: row count, id set, and content sha256. Columns that restore intentionally transforms (`RESTORE_TRANSFORM_COLUMNS`) are dropped from the content comparison only.<br>5. Checks asset bytes sha256 = checksum = source; a missing source file is a FAIL.<br>6. Search probe: a capture found in the source by its first word must be found in the target.<br>7. Writes a `restore_drills` row (migration 0024, excluded from export) and an audit `restore_drill.run`.<br>CLI `pnpm drill:restore` (packages/db/scripts/restore-drill.ts) opens DATABASE_URL, so the existing lock message fires if a dev server holds it. `POST /api/ops/restore-drill` runs against the live DB in-process (memory target, no lock issue). | integration:<br>• owner with confirmed, blocked and failed-intent jobs → PASS (29 tables, search found, row recorded, export_runs unchanged, temp dir removed).<br>• tampered restored capture → FAIL with `content_sha256` on captures and no body text in `mismatch_json`.<br>• missing source asset file → FAIL `asset_missing_in_source`.<br>• route form 303 → `/ops?drill=<id>`, JSON 200 pass, no Origin → 403.<br>Also ran CLI `drill:restore` against a temp seeded DB: PASS, exit 0. |
| C. Retention | `planRetention` (dry-run, no change) / `applyRetention` (needs `confirm === true`) in packages/db/src/retention.ts. Deletable things are exactly `job_events`, package ZIPs and export ZIPs/dirs (`RETENTION_TARGETS`):<br>• job_events: only for terminal jobs (CONFIRMED/FAILED/CANCELED) whose **latest** event is older than `RETENTION_JOB_EVENTS_DAYS`. Inside a transaction: lock the job rows, re-check, write `EXPORT_LOCAL_DIR/retention/<owner>/job-events-*.jsonl`, read it back and compare the line count, `set_config('cs.retention_sweep','on', true)`, delete, compare the deleted count.<br>• Migration 0024 replaces the `job_events_immutable` trigger function with `job_events_guard`, which allows DELETE only under that flag and only for terminal jobs.<br>• Package ZIPs are deleted by mtime > `RETENTION_PACKAGES_DAYS`. Export ZIPs/dirs beyond the newest `RETENTION_EXPORT_RUNS_KEEP` are deleted; the export_runs rows are kept.<br>• Audit `retention.sweep` stores counts only.<br>`RETENTION_SWEEP_MODE=auto` lets the worker tick apply it at most once per hour per process for all owners. The default is manual.<br>UI: `/ops` shows a live preview plus a confirm checkbox (`confirm=yes`). API `POST /api/ops/retention` `{dry_run:true}` or `{confirm:"yes"}`. | integration:<br>• dry-run changes nothing; `confirm:false` → `confirm_required`.<br>• Apply (now + 200 days): confirmed job's events archived (JSONL lines = deleted rows) then deleted; BLOCKED job's events and other owner's events kept; captures, revisions, sources, source_versions, contents, content_versions, assets, jobs, send_intents and export_runs counts unchanged; 2 packages and 2 old export ZIPs removed; audit counts; second run all zeros.<br>• Trigger rejects DELETE without the flag, DELETE of a non-terminal job's events even with the flag, and any UPDATE.<br>• API dry_run / 400 / form error redirect / confirm=yes.<br>unit `ops.test.ts`: deletable tables ∩ protected = ∅, every exported/excluded table classified, exportsToPrune, package cutoff boundary, age/threshold math, byte/age formatting, config defaults and range validation. |
| D. Docs | D22; README_KO section "운영·복원 훈련·보존 정리" and a `drill:restore` row in the command table; `.env.example` placeholders. Also updated: `EXCLUDED_TABLES` += `restore_drills`; the expected-exclusion lists in `bundle-tables.test.ts` and `export-restore.test.ts` (7) now include `restore_drills` (list update, not a weakened assertion). | — |

## Deviations from the brief (need confirmation)
- `RETENTION_UPLOAD_SESSION_HOURS` was not added. Upload TTL is the fixed 24 h constant (`UPLOAD_SESSION_TTL_MS`, D15), written into `expires_at` at session creation. Wiring a config into upload creation was outside this task. `/ops` and the README state the 24 h policy.
- `RETENTION_LOG_DAYS` is documented only (no config) because the app writes no log files.
- Retention defaults to **manual**. The brief said "Worker tick retention.sweep applies them"; the tick does so only with `RETENTION_SWEEP_MODE=auto`. Reason: auto mode deletes older export ZIPs (backups) without a person looking.
- `restore_drills.export_run_id` holds the drill bundle's export id. There is no export_runs row and no FK, on purpose, so drills never count as backups. Extra column `trigger` (cli/api/test).
- The drill's first run against a DB with distribution data was a false FAIL: `distribution_plans.status`/`revision` are recomputed on restore. Those columns were added to the transform list. `columns` (names only) was added to content mismatches for diagnosis.

## Commands (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0; no dev server — port 3000 checked)
- `corepack pnpm lint`: pass.
- `corepack pnpm typecheck`: pass.
- `corepack pnpm test`: pass, 31 files / 576 tests (baseline 30 / 568).
- `corepack pnpm test:integration`: pass, 25 files / 353 tests (baseline 24 / 342).
- `corepack pnpm build`: pass; routes `/ops`, `/api/ops/restore-drill`, `/api/ops/retention` listed.
- `corepack pnpm drill:mock`: exit 0, 불변식 위반 0.
- `corepack pnpm drill:restore` against a temp seeded DB (DATABASE_URL/STORAGE/EXPORT/RESTORE pointed at a mktemp dir, then deleted): exit 0, PASS, 29 tables / 18 rows, search found.
- Not run against `./data/pglite`, by rule; migration 0024 will apply there on the next `pnpm dev`/`db:migrate`.
- `drizzle-kit generate --name t20_restore_drills` (local, no network) produced 0024 + snapshot. Trigger SQL was appended by hand.
- not_run: real PostgreSQL (set_config/trigger semantics), browser check of `/ops`, the CLI lock path (relies on the existing `DbLockedError`).

## Remaining risks
- Drill false-pass:
  - Transform columns are excluded from the content comparison (`RESTORE_TRANSFORM_COLUMNS`), so a real corruption confined to e.g. `jobs.state` or `variants.lifecycle` would not be caught.
  - Tables restored with 0 rows pass trivially.
  - The search probe tests one capture only.
  - The drill re-exports the current DB, not a past ZIP. It proves "today's export restores", not that older backups are intact.
- The retention JSONL is written inside the transaction before the delete. If the commit fails afterwards, the file remains and a rerun writes a second file with the same rows. That duplicates but never loses data. Archive files have no retention of their own yet.
- Disk walk is capped at 50k entries (marked truncated). `/ops` walks on every render; health caches for 60 s per process.
- `repeatedFailures` counts send intents with outcome rejected/ambiguous. Transient retries that end `rejected` are counted; pre-intent lease expiries are not.
- Auto retention throttle is per process (globalThis), not persisted. After a restart it runs on the first tick.

## Questions specifically for Codex
1. Drill false-pass: is excluding `RESTORE_TRANSFORM_COLUMNS` safe? Should the drill instead re-apply the documented transforms to the source rows (restoredJobState, restoredItemStatus, plan recompute) and compare exact values, so corruption in those columns is detected?
2. Is the empty-table case acceptable? A table with 0 rows on both sides passes. Should the drill require minimum coverage (e.g., ≥1 capture, ≥1 content version, ≥1 asset) before reporting PASS, or report "PASS (partial coverage)"?
3. Retention of events for non-terminal jobs: only terminal jobs whose latest event is older than the cutoff are eligible. Can a job leave a terminal state later (e.g., restored history, late_result, reconcile on a CANCELED job) so that `job_events_guard` lets an in-use history be deleted between the app re-check and the delete? Should the trigger also check that the event is older than a server-side cutoff?
4. Disk measurement cost: `/ops` walks the dirs synchronously per render (cap 50k entries). Should `/ops` use the 60 s cache too, or a background measurement stored in the DB?
5. Backup-age semantics: age = last *completed* export_runs row, even if that ZIP has since been deleted by retention or moved off-box. Should backup age require the file to still exist (or a recorded off-box copy), and should a drill PASS be required within N days?
6. `/api/health` exposes `ops` without auth (numbers only, totals across all owners). Is that acceptable for a single-owner deployment, or should `ops` move behind the session?

## 오케스트레이터 실행 기록 (2026-10-01, HEAD 41ff399)
- `corepack pnpm db:migrate` → 0024 적용(./data/pglite).
- `corepack pnpm drill:restore` (실제 로컬 DB, dev 서버 중지 상태) → **PASS**: 표 29 · 행 89 · 파일 2 · 검색 found. 복원 변환 열 제외 표시(distribution_items·approvals·jobs).
  → docs/02 "운영 전 최소 1회 통과" 를 로컬 PGlite 기준으로 1회 충족. 운영(PostgreSQL) 환경에서의 통과는 M7/운영 전 별도.
- dev 서버 재기동(0024 적용) 뒤 /ops 200: 작업·전송 의도·용량(경로 노출 없음)·비용·백업·모드 섹션 렌더, 출처 없는 값 "측정 없음" 8곳, 확인 필요 계획 2개 링크, 마지막 복원 훈련(CLI PASS) 표시.
- /api/ops/restore-drill(화면 버튼 경로) → 200 result pass, 표 29·행 89. /api/ops/retention 빈 본문 → 400 confirm_required(아무것도 안 지움).

---

# FIX round 1 (Codex review-T20)
- Review input: `.handoffs/review-T20.md` (1×P0, 2×P1, 2×P2). BASE_SHA: 41ff399 · HEAD_SHA: 0c0d969 (FIX round 1 commit; orchestrator reran lint·typecheck·build·unit 582·integration 368·drill:mock 0 — all PASS; db:migrate applied 0025 locally)
- Reproduction:
  - P0 — the 3 new retention tests fail on the 41ff399 `retention.ts`. That code planned to delete the older ZIP when the newest run's file was missing, and it counted run rows.
  - P2 — the 6 `dirUsage` unit tests fail on 41ff399, which returned `present:false, bytes:0` with no status.
  - P1 — the new tests use the new `faultInjection` / `drillErrorCode` / `columns` API, so I did not run them against 41ff399. The 41ff399 drill removed the corrupted columns from the comparison (`RESTORE_TRANSFORM_COLUMNS`), so every corruption case would have reported PASS.

| Finding | Change | Test |
|---|---|---|
| P0 retention.ts:77 | `usableBackup`: a run counts only if its ZIP is a regular file, readable, size > 0, and size = `export_runs.zip_bytes`. `keep` applies to usable backups only. Runs with a missing or damaged file are neither counted nor deleted; they are reported as `exportsMissingFile` (shown on /ops as "파일 없음 기록"; the API returns `exports_missing_file` and `exports_existing`). Floor: `Math.max(1, keep)`, so the newest usable ZIP is never deleted. | integration:<br>• the report's scenario (keep=1, newest file gone, older ZIP present) → nothing planned or deleted, older ZIP still exists, newest listed as missing<br>• 0-byte newest ZIP → not counted; with keep=2 nothing deleted; with keep=1 only the oldest usable one is deleted<br>• keep=0 config → the newest is never in the plan<br>• the existing normal case (3 usable, keep 1 → 2 deleted) still passes |
| P1 restore-drill.ts:184 | No columns are excluded any more. New `restore-expect.ts` builds the **expected post-restore rows** from the source bundle by applying the documented rules independently (it does not call the restore code):<br>• items: restoredItemStatus → BLOCKED/UNKNOWN + restored_needs_review; CONFIRMED without a publication → UNKNOWN<br>• jobs: restoredJobState, lease_owner/lease_until/heartbeat_at = null, restored_needs_review = true; for unverified items the latest CONFIRMED job → UNKNOWN with done_at = null<br>• plans: planStatusFrom over the expected items and active approvals; if the status changed, revision + 1 and updated_at = restore time<br>• approvals: unchanged except the ones the commit result *declares* restore_stale-revoked<br>• variants: draft if declared downgraded; approved with no expected active approval on the current version → review<br>• transcription_jobs and usage_ledger: interrupted jobs → canceled / settled with actual = reserved; every other amount exact<br>Every column of every row is compared. Restore-time values must fall inside the drill window. Mismatches list the column names (no values). | integration:<br>• PASS for an owner with confirmed, blocked and queued jobs, approvals, an approved variant and a usage_ledger row (mock AI run)<br>• 7 corruption tests, one column each in the target: `jobs.state`, `jobs.lease_owner`, `approvals.revoked_at`, `variants.lifecycle`, `distribution_items.status`, `distribution_plans.revision`, `usage_ledger.actual_amount` → FAIL, with the column named in `mismatch_json` |
| P1 restore-drill.ts:244 | Export → parse → credential check → migrate target → restore → compare all run in one try/catch. Any throw becomes a `drill_error` mismatch and a `restore_drills` row with result `fail` and `error_code` (new column, migration 0025). The code is sanitized: a safe `code` such as ENOSPC, else the error class name, else `unknown_error`; no message or path. Temp files and the memory DB are always cleaned in `finally`. /ops shows "FAIL(error_code)". The credential check now scans the unpacked ZIP entries rather than the raw ZIP bytes (missed case). The result also carries `emptyTables` (coverage note for Codex Q2). | integration:<br>• injected fault at the export step and at the compare step → row `fail` + `injected_fault`, no temp dir left, `/ops` lastDrill shows the FAIL<br>• `drillErrorCode` sanitization cases |
| P2 ops.ts:246 | `Listed<T> = { total, items (≤ OPS_LIST_LIMIT 50), truncated }` for attention jobs, attention plans and repeated failures; totals come from count queries. /ops shows "(전체 N개 중 50개 표시)". Health `attention_plans` and `repeated_failures` use the true totals. | integration: 51 attention plans → total 51, 50 items, truncated; health ≥ 51 |
| P2 ops.ts:46 | `dirUsage` returns `status: complete \| partial \| unavailable` and `errors`:<br>• root readdir failure → unavailable<br>• subfolder or file read failure (other than ENOENT during counting) → partial, so bytes is a lower bound<br>• entry cap → partial + truncated<br>The fs is injectable for tests. /ops shows "하한값(일부 측정 실패 N건)" or "측정 불가". Health gives `null` for unavailable and a new `disk_partial` boolean. Per Codex Q4, /ops and health share one 60 s cache, including the in-flight Promise; /ops shows the measurement time. | unit `packages/db/src/ops.test.ts` (mocked fs): complete, sub-readdir EACCES → partial, file lstat EACCES → partial (ENOENT does not count), root readdir EACCES → unavailable, missing folder, cap → partial; integration health has `disk_partial: false` |

- Commands (Windows 10, Git Bash, `source tools/env.sh`; a dev server is running, so **build not run**, per the orchestrator):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 32 files / 582 tests.
  - `test:integration` pass: 25 files / 368 tests, 258 s.
  - `drill:mock` exit 0, 불변식 위반 0.
  - Migration 0025 (`restore_drills.error_code`) was generated by drizzle-kit locally. It is not applied to ./data/pglite here; it applies on the next dev start or `db:migrate`.
- Not done (outside this round): Codex Q5 (backup age should be based on usable files or confirmed off-box copies, and periodic drills of stored ZIPs); Codex Q6 (move health `ops` behind the session); the retention missed cases (concurrent sweeps, damaged JSONL with the right line count).
- Questions specifically for Codex:
  1. `restore-expect.ts` trusts the commit result for two declared transforms: `revoked_approvals` (restore_stale) and `downgraded_variants`. Everything else is recomputed independently. Is it acceptable to accept declared revocations and downgrades, as long as every other column must match exactly and undeclared changes fail? Or should snapshotProblems / variantReviewBlockers be re-derived from bundle rows?
  2. Restore-time values (plan updated_at after a status change, approval revoked_at, ledger settled_at, transcription finished_at, variant updated_at after approved→review) are checked only against the drill window [start − 5 s, now + 60 s]. Is that tolerance enough to avoid false passes?
  3. A usable backup means file present + readable + size = recorded zip_bytes. There is no sha256 re-hash, for cost. Should retention re-hash the kept candidate (the newest usable) before deleting older ones?
  4. `dirUsage` treats ENOENT during counting as benign (file deleted mid-scan), not as an error. Could that hide a real failure, e.g. a whole subtree removed by another process during the scan?

---

# FIX round 2 (Codex 놓친 케이스)
- BASE_SHA: 0c0d969 · HEAD_SHA: cef5eaf (orchestrator reran lint·typecheck·build·unit 582·integration 375·drill:mock 0 — all PASS)
- Scope: the retention cases in the review-T20 "놓친 케이스" list that need no user decision. BASE_SHA: 0c0d969 · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: with the 0c0d969 `retention.ts`, 6 of the 7 new tests fail: concurrency, archive sha256, unlink failure, and the three export file states. The export→restore-after-sweep test already passed on 0c0d969; it is kept as a regression guard.

| Finding (missed case) | Change | Test |
|---|---|---|
| Concurrent sweeps | `applyRetention` is now a single transaction that starts with `pg_advisory_xact_lock(hashtext('cs.retention:<owner>'))`. Inside it, the plan is recomputed, the archive is written and the events deleted, the files are deleted and the audit is written. A second sweep for the same owner waits, then plans again and finds nothing left. File deletions are counted from `unlink` results; ENOENT counts as "already gone", not as deleted.<br>Why an advisory lock rather than `SKIP LOCKED`: the sweep also covers files that have no row to lock, so one owner-wide lock is the simpler rule.<br>Note: PGlite already serialises transactions on its single connection, so in this test the lock itself is not what decides the outcome. What is tested is that planning happens inside the serialised transaction. Real PostgreSQL concurrency is not_run. | integration: two `Promise.all` sweeps → event, package and export deletions sum to the real counts; exactly one archive file; audit `*_deleted` totals equal the real deletions |
| JSONL integrity | sha256 and byte count of the bytes written; read back (fs injectable) and compare length, sha256 and line count. A mismatch throws `RetentionArchiveMismatchError` (code `retention_archive_mismatch`) and the whole transaction rolls back. The audit stores `archive_sha256` and `archive_bytes`, and no longer the file name (no paths, no event bodies). | integration: read-back with an extra byte → abort, events intact, no audit. Same line count but changed content → abort. Normal run → audit sha matches the archive file on disk, and the audit has no path or event fields |
| Partial file-deletion failure | Each package or export file is deleted on its own. A failure such as EACCES is counted and the loop continues. The result has `{deleted, failed, bytes, errorCodes}` per kind; codes only, `[A-Z0-9_]`. The audit adds `packages_failed`, `exports_failed` and `error_codes`. For exports, the folder is removed only after the ZIP is gone. `/ops` "마지막 정리" shows failures. Files that failed remain on disk, so they appear again in the next preview. | integration: 3 old packages, one with an injected EACCES → 2 deleted, 1 failed, `['EACCES']`; audit `packages_failed 1`, `error_codes EACCES`; the next plan lists exactly the failed file |
| Export run file states | Rule: **only the ZIP is a backup.**<br>• ZIP present, folder missing → usable.<br>• Folder present, ZIP missing → not counted; reported in `exportsMissingFile` with `dirPresent: true`; its folder is pruned (`kind: 'dir_only'`) only when it is older than the newest usable backup that is kept.<br>• No usable backup at all → nothing is deleted, not even folders. | integration: three cases — ZIP only → counted, older one pruned as `zip`; folder only → the older folder is pruned and the folder newer than the kept ZIP is kept; all ZIPs missing → nothing deleted, every run listed as missing, folders intact |
| Export → restore right after a sweep | No code change needed. The test runs a sweep (events deleted), then export, then preview + `empty_only` commit into a memory DB. | integration: the pruned job restores as CONFIRMED with `restored_needs_review` and no lease, and has 0 job_events in the target |

- Also adapted: the idempotency assertion in the existing sweep test now uses the new result shape (same values, extra zero fields). `/ops` shows deletion failures in "마지막 정리".
- Commands (Windows 10, Git Bash, `source tools/env.sh`; dev server down — port 3000 checked):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 32 files / 582 tests.
  - `test:integration` pass: 25 files / 375 tests (was 368), 231 s.
  - `drill:mock` exit 0, 불변식 위반 0.
  - `build` pass.
- Remaining risks:
  - The whole sweep now holds one DB transaction while it deletes files. On PGlite this blocks other requests in the process for the duration, which is short at local scale.
  - If a file deletion succeeds and a later DB step fails (e.g. the audit insert), the transaction rolls back but the file stays deleted. The audit then undercounts. Only the JSONL archive is written before the irreversible delete.
  - Leftover archive files from aborted sweeps are not cleaned up; by design they are never lost.
- Questions specifically for Codex:
  1. Is one owner-wide advisory lock held across file I/O acceptable on PostgreSQL? Or should file deletion run after the commit, with a separate "pending file deletion" record so DB and files cannot diverge?
  2. Folder-only runs are pruned only when older than the newest usable ZIP kept. Should they ever be pruned, given the unpacked folder may be the last readable copy if a ZIP later turns out damaged?
  3. A sweep whose only outcome is failures (nothing deleted) still writes a `retention.sweep` audit with the failure counts. Is that the right signal, or should failures be visible only in /ops?

---

# FIX round 3 (Codex review-FIX-T20)
- BASE_SHA: cef5eaf · HEAD_SHA: 9458dff (orchestrator reran lint·typecheck·build·unit 588·integration 389·drill:mock 0 — all PASS; db:migrate applied 0026 locally)
- Review inputs: `.handoffs/review-FIX-T20.md` (on 0c0d969) and `.handoffs/review-FIX2-T20.md` (on cef5eaf; its items are marked "from review-FIX2-T20"). BASE_SHA: cef5eaf · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: the new tests use the new APIs (`zipFs`, `tamperCommit`, `scope`, `resultMissing`, `measure` injection), so I did not run them against cef5eaf. Each scenario maps directly to a defect in the reviewed code:
  - same-size corrupted ZIP: the old check was size-only, so it counted as usable and the older ZIP was deleted with keep=1.
  - damaged ZIP: classified as `missing` → `dir_only` folder deletion.
  - zip OK + folder EACCES: the result was merged into one failed entry.
  - in-flight measurement: the TTL was applied while the measurement was still running.

| Finding | Change | Test |
|---|---|---|
| P0 retention.ts:86 — same-size corrupted ZIP counted as usable | New `zipState()`. A ZIP is **verified** only if: size = `zip_bytes`, it unpacks with `parseBundleZip` (ZIP structure, manifest, every entry sha256, every asset checksum) and its manifest sha256 = `export_runs.manifest_sha256` stored at creation. There is no ZIP-level hash column, so the manifest hash recorded at creation is the trusted value. Results are cached per (run, size, mtime, manifest). Only verified ZIPs count toward keep. If fewer than keep are verified, **nothing** is deleted, folders included. | integration: newest ZIP with one byte flipped (same length) → `damaged`, not counted, older good ZIP and the damaged ZIP/folder all kept; 1 verified < keep 2 → nothing planned |
| from review-FIX2-T20 P1 retention.ts:136 — damaged/unreadable ZIP folders deleted | `zipState` returns `absent` (ENOENT on stat or read), `damaged` (0 bytes, size mismatch, parse/checksum/manifest failure) or `unreadable` (EACCES etc.). Only `absent` + folder qualifies for `dir_only`, and only when older than the newest kept verified ZIP. Damaged and unreadable ZIPs and their folders are kept and reported (`exportsMissingFile[].zipState`; /ops shows counts per state). | integration: size-mismatched ZIP + good folder → damaged, ZIP and folder kept; 0-byte → damaged; injected EACCES on stat → unreadable, folder kept; ENOENT control → `dir_only` |
| from review-FIX2-T20 P2 retention.ts:324 — ZIP and folder results merged | `ExportDeleteResult` counts ZIP deletions (`deleted`, `failed`, `bytes`, where bytes are added only when the unlink succeeds) separately from folder cleanup (`dirsDeleted`, `dirsFailed`). The audit `retention.files` has `exports_deleted`, `exports_bytes`, `export_dirs_deleted`, `export_dirs_failed` and `error_codes`. | integration: ZIP deleted + folder EACCES → `{deleted 1, bytes = zip_bytes, dirsFailed 1, ['EACCES']}`; next run → `{deleted 0, bytes 0, dirsDeleted 1}` |
| from review-FIX2-T20 missed case — equal createdAt | `dir_only` eligibility uses a stable `(createdAt, id)` comparison against the newest kept verified run. | integration: two runs with the same createdAt; the smaller-id run is folder-only → planned as `dir_only` |
| from review-FIX2-T20 Q11/Q13 — record lost if the DB fails after file deletion | Restructured into 3 phases:<br>① transaction with the owner advisory lock: plan, archive (written, **fsync'd**, re-read sha256), delete events, audit `retention.sweep` with the deleted event count and the *planned* file counts (`planned_packages`, `planned_export_zips`, `planned_export_dirs`), then commit.<br>② file deletions outside the transaction, counted from unlink/rm results; ENOENT is not counted, so concurrent sweeps cannot double-count.<br>③ audit `retention.files` with the actual results.<br>`lastRetentionSweep` merges both and sets `resultMissing` when a plan has no later result; /ops shows "파일 삭제 결과 기록이 없습니다".<br>fsync opens the archive `r+` because Windows rejects fsync on a read-only handle (EPERM, observed). | integration: during `unlink` the planned audit is already committed and visible; merged view has `resultMissing false`; after removing the result audit → `resultMissing true`. Round-2 sum tests now read event counts from `retention.sweep` and file counts from `retention.files` |
| P1 restore-expect.ts:79 — declared transforms trusted | New `deriveRestoreTransforms(bundle, restoreWindow)` recomputes, from bundle rows only (no call into restore code):<br>• **variant downgrades**: review/approved with blockers. The blockers are no current version, stale, media incomplete via `mediaCompleteness`, and unresolved experience claims via `unconfirmedExperienceClaims` over the content's adopted runs and the variant's run with `renderVariantText`.<br>• **approval revocations** (snapshot problems): variant version or lifecycle after the downgrade, content version, attachments, account readiness and external id, recomputed payload hash via `buildCanonicalPayload`/`payloadHash`, stored payload hash, latest brand, blockers, and schedule before the restore start.<br>A schedule inside the restore-call window is *ambiguous*: either outcome is accepted, for both the row and the declaration.<br>Expected rows are built from the derived sets. The declared `revoked_approvals` / `downgraded_variants` are compared with the derived sets as a separate mismatch kind, `declared_transforms`. | integration:<br>• an approval scheduled in the past (created via `createPlan`/`approveItems` with a past `now`) → derived = declared → PASS<br>• the restore leaves the approval unrevoked AND declares `[]` → FAIL with both `declared_transforms(revoked_approvals)` and a `revoked_at` column mismatch<br>• an unnecessary draft downgrade AND it is listed → FAIL with both `declared_transforms(downgraded_variants)` and a `lifecycle` mismatch |
| P2 restore-expect.ts:153 — marker collides with JSON | The markers are now a `Symbol` (`RESTORE_TIME`) and class instances (`SameOrRestoreTime`, `OneOf`), checked with `instanceof`; plain JSON can never be one. | unit `restore-expect.test.ts`: `{sameOrRestoreTime:'x'}` equals itself and not `'x'`; window edges inclusive; just outside and null fail; `OneOf` |
| P2 ops.ts:141 — in-flight measurement duplicated after the TTL | The cache entry holds `settledAt` (null while running). An in-flight Promise is shared regardless of age; the 60 s TTL applies only after it settles; a failure clears the entry. Measure and clock are injectable; `resetDiskCache` exists for tests. | unit: a never-resolving measure called at t=0 and t=120 s → same Promise, 1 traversal; settled result reused within 60 s, re-measured after; a failure is not cached |
| Q8 — time window | The restore-time window is now the actual `commitRestore` call: `restoreFrom` just before, `restoreTo` just after. Columns that keep their original time are still compared exactly. | covered by every PASS/FAIL drill test; unit window-edge cases |
| Missed case — inner `restore_error` | The inner restore failure path now sets the top-level `errorCode` as well, so the `restore_drills.error_code` column is filled on every failure path. A `faultInjection: 'restore'` hook was added. | integration: restore fault → `result fail`, `errorCode injected_fault`, row `error_code` |
| Q10 — subtree vanished | A non-root readdir ENOENT sets `changedDuringScan: true` and makes the status `partial` (not counted as an access error). | unit: sub-readdir ENOENT → partial, changedDuringScan, errors 0 |
| Concurrency after the 3-phase split | With phase ② outside the transaction, the first full run counted export deletions 3/2 in the two-concurrent-sweeps test. My suspicion is overlapping unlink and verification between the two sweeps; I did not confirm the cause. `applyRetention` now also takes an **in-process per-owner mutex** (chained Promise) around all three phases. Cross-process overlap of phase ② (multiple PostgreSQL workers) is a remaining risk. | integration: the concurrency test passed in 3 consecutive file runs plus the full suite |
| Q2 — verification scope | Migration **0026** adds `restore_drills.scope_json` = `{empty_tables, tables_compared, files_checked, search_probe, partial, partial_reasons}`. `partial` is true when there are no files, the search was skipped, or captures/contents/content_versions is empty. CLI and /ops show "PASS(부분 검증: …)" with the search result and the empty tables. | integration: owner with no attachments → PASS, `scope.partial`, `no_files`, saved in the row and visible via `opsSnapshot` |

- Tests changed to the newly requested semantics:
  - The round-2 folder-only test used keep=5 with 1 verified backup. Under the new "fewer verified than keep → delete nothing" rule I changed it to keep=1, and it also asserts that keep=5 plans nothing.
  - Its result assertion now checks `dirsDeleted: 1, deleted: 0` (folder only), not the merged count.
  - Audit assertions now read the split `retention.sweep` / `retention.files` records.
  - The idempotency shape gained `dirsDeleted`/`dirsFailed`.
  - No check was removed.
- Commands (Windows 10, Git Bash, `source tools/env.sh`; dev server down — port 3000 checked):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 33 files / 588 tests.
  - `test:integration` pass: 25 files / 389 tests (was 375), 232 s.
  - `drill:mock` exit 0, 불변식 위반 0.
  - `build` pass.
  - Migration 0026 was generated by drizzle-kit locally; it is not applied to ./data/pglite here.
- Not in scope (user decisions): Q5 backup-age semantics; Q6 health `ops` behind the session.
- Remaining risks:
  - `deriveRestoreTransforms` re-implements the restore conditions. If restore and drill change together in the same wrong way, both can still agree. The rules live in one documented place on each side.
  - The `claimsOf` parser is shared with the restore code. It is a JSON-shape helper, not a decision.
  - Phase ② deletions are not retried automatically. Leftover files reappear in the next preview, and `resultMissing` flags a missing result.
  - ZIP verification reads every candidate ZIP once per (size, mtime); the cache lives per process.
- Questions specifically for Codex:
  1. Is the manifest sha256 recorded at export time, plus full `parseBundleZip` verification, an acceptable "trusted hash" substitute? Or should 0027 add a whole-ZIP sha256 to `export_runs` for new exports, with today's rule as the fallback for old runs?
  2. Ambiguous schedule (inside the restore-call window) accepts either outcome. Is that window small enough in practice, or should the drill inject the restore clock into `applyBundle` so the outcome is exact?
  3. The 3-phase sweep writes the plan before deleting files and the result after. Should a "planned, no result" sweep block the next sweep until it is acknowledged, or is showing it on /ops enough?
  4. `partial` is triggered by no files, a skipped search, or empty captures/contents/content_versions. Should jobs/approvals (distribution history) also be required before a drill counts as a full PASS?

- Orchestrator: real local DB `corepack pnpm drill:restore` on 9458dff (dev down, 0026 applied) → PASS, 29 tables / 89 rows / 2 files / search found; restore-rule rows items 2 · approvals 3 · jobs 8; 10 empty tables listed as scope.

---

# FIX round 4 (Codex review-FIX3-T20)
- BASE_SHA: 9458dff · HEAD_SHA: 19986fc (orchestrator reran lint·typecheck·build·unit 589·integration 398·drill:mock 0·real-DB drill:restore PASS — all PASS)
- Review input: `.handoffs/review-FIX3-T20.md` (on 9458dff). BASE_SHA: 9458dff · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: the new tests use new result and option fields (`exportsAborted`, `sweepId`, `alreadyAbsent`, `restoreNow`), so I did not run them against 9458dff. Each scenario maps to the reviewed defect:
  - cache hit after a same-size corruption with the mtime restored → the 9458dff apply deleted the older ZIP.
  - an approval with its schedule inside the window → `OneOf` excluded it from active approvals.
  - plan and result audits were linked by timestamp only.
  - all-ENOENT runs wrote no result audit.

| Finding | Change | Test |
|---|---|---|
| P0 retention.ts:123 — the verification cache let a damaged newest ZIP count as kept | The cache key now includes the actual ZIP path, and `zipState` takes `{ noCache }`. The preview (and the apply's phase-① plan) may still use the cache. But phase ② first **re-verifies every kept candidate (`plan.exportsKept`) from actual bytes with no cache**. If any fails, no export ZIP or folder is deleted: `exportsAborted = 'kept_unverified'`, recorded in the result and the `retention.files` audit, and shown on /ops. Packages are unaffected. | integration:<br>• newest ZIP's mtime set to whole seconds, then preview (cached), then one byte flipped with the size and mtime restored. The preview still plans deletion of the older ZIP (the risk Codex described), but apply aborts and the older ZIP remains.<br>• kept ZIP readable during planning but EACCES on the re-read → abort; exactly 2 reads |
| P1 restore-expect.ts:257 — ambiguous approval handled inconsistently | `applyBundle` takes a decision time `now`; `commitRestore` passes its existing `opts.now`. The drill passes one `decisionAt` to restore and uses it in `deriveRestoreTransforms`, so `schedule <= decisionAt` gives the same answer on both sides. Removed `OneOf` and the ambiguous set, so there is no two-branch allowance left. Values set from the decision time (approval `revoked_at`, plan/variant `updated_at`) must now **equal** that instant in bundle format (`bundleTime`, 6-digit µs). DB `now()` values (ledger `settled_at`, transcription `finished_at`) are still window-checked. | integration (new owner, approval scheduled at T = yesterday 12:00 MSK):<br>• `restoreNow = T` → revoked on both sides → PASS<br>• `restoreNow = T − 1 s` → kept; variant stays approved, plan approved; approvals table 'same' → PASS<br>• kept but declared revoked → FAIL `declared_transforms`<br>unit: `bundleTime` exact match and off-by-1 ms |
| P1 ops.ts:402 — plan and result linked by time | Each run gets a `sweepId` (UUID). It is in the result and in both audits (`details.sweep_id`). `lastRetentionSweep` = the latest plan (ordered by at, then id) plus the result with the **same `sweep_id`**. New `incompleteRetentionSweeps`: every plan with files and no matching result; later sweeps do not hide it. Legacy audits without `sweep_id` cannot be paired and are not flagged. /ops lists the incomplete runs (time, planned count, short id). | integration: two sweeps with the same `now`; the second's result audit removed (simulated interruption) → listed as incomplete; a third successful sweep → still listed (total 1); `lastRetentionSweep` = third, `resultMissing false`; `opsSnapshot.incompleteRetention.total` = 1 |
| P2 retention.ts:454 — all-ENOENT run looked interrupted | The result audit is now written whenever the plan had any files, even if nothing was deleted or exports were aborted. `alreadyAbsent` counts ENOENT outcomes for packages, ZIPs and folders, and is stored as `already_absent`. /ops shows "이미 없던 파일 N개". | integration: injected ENOENT for unlink and rmDir → `alreadyAbsent 2`, audit `already_absent 2` with matching `sweep_id`, `resultMissing false` |
| Missed case — a required downgrade | No code change; verified by test. | integration: a review variant made stale by a later content version → derived downgrade = restore downgrade → PASS; the variants table shows "same(복원 규칙 1행)" |
| Codex Q17 — distribution coverage | `drillScope` adds `no_distribution` when both `jobs` and `approvals` are empty. `DRILL_PARTIAL_LABEL` maps reasons to Korean ("배포 복구 미검증(작업·승인 없음)" …). CLI and /ops use the labels. | integration: owner with a capture, a content and a file but no jobs/approvals → PASS with `no_distribution` and without `no_files` |

- Tests adapted:
  - The idempotency result shape gained `sweepId`, `alreadyAbsent` and `exportsAborted`.
  - The audit test now also asserts that plan and result share the `sweep_id`.
  - In `restore-expect.test.ts` I removed the two `OneOf` assertions, because `OneOf` itself is removed. A `bundleTime` exactness test was added in their place.
- Commands (Windows 10, Git Bash, `source tools/env.sh`; dev server down — port 3000 checked):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 33 files / 589 tests.
  - `test:integration` pass: 25 files / 398 tests (was 389), 272 s.
  - `drill:mock` exit 0, 불변식 위반 0.
  - `build` pass.
- Remaining risks:
  - The re-verify reads every kept ZIP fully once per apply, which is slower for large backups.
  - Between the re-verify and the unlinks, a kept ZIP could still be corrupted. The window is now milliseconds, not the age of the cache.
  - Phase ② across processes (multi-worker PostgreSQL) is still guarded only by the in-process mutex.
  - Old plans written before round 4 (no `sweep_id`) are not paired or flagged.
- Questions specifically for Codex:
  1. On a re-verify failure, exports are aborted entirely (packages still proceed). Should the whole sweep instead stop, including packages, and should the plan audit be marked `aborted` rather than relying on the result audit?
  2. `incompleteRetentionSweeps` scans the latest 1000 plan/result audits per owner in memory. Is a stored per-sweep status row (e.g. a `retention_sweeps` table with planned/completed) preferable before multi-worker support?
  3. `applyBundle` now accepts a decision time used only for approval re-checks and the plan/variant timestamps. Should the same `now` also drive the DB `now()` values (ledger `settled_at`, transcription `finished_at`) so every restore-time value is exact?

---

# FIX round 5 (Codex review-FIX4-T20)
- BASE_SHA: 19986fc · HEAD_SHA: 82cde4a (orchestrator reran lint·typecheck·build·unit 589·integration 403·drill:mock 0·real-DB drill:restore PASS — all PASS)
- Review input: `.handoffs/review-FIX4-T20.md` (on 19986fc; P1 ×2, no P0). BASE_SHA: 19986fc · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: the >1,000-plan test uses only the existing API and **fails on the 19986fc `ops.ts`**: total 0 instead of 1. The candidate-corruption test needs the new `candidatesDamagedKept` field, so I did not run it against 19986fc. There, the candidate was taken from the cached plan and deleted.

| Finding | Change | Test |
|---|---|---|
| P1 retention.ts:441 — damaged deletion candidate deleted because of the cache | In phase ②, every export candidate is re-verified with `zipState(..., { noCache: true })` immediately before its own deletion:<br>• verified → delete the ZIP, then the folder<br>• damaged/unreadable → keep both and count `candidatesDamagedKept`<br>• absent → only the folder<br>For a `dir_only` candidate, the ZIP must still be absent, otherwise it is skipped and counted. Plan entries now carry `manifestSha256` for this. The result and the `retention.files` audit have `candidates_damaged_kept`, and /ops says "지울 예정이던 백업 N개가 손상·읽기 실패로 확인되어 ZIP·폴더를 남겼습니다". | integration (the mirror of the round-4 test): two good ZIPs; the older ZIP's mtime pinned to whole seconds; preview (cached); older ZIP corrupted at the same size with the mtime restored. The preview still plans it, but apply keeps the ZIP and folder: `candidatesDamagedKept 1`, outcome `partial`, audit matches |
| P1 ops.ts:433 — 1,000-row window hides old incomplete sweeps | `incompleteRetentionSweeps` is now one SQL query over **all** `retention.sweep` audits of the owner that have a `sweep_id` and planned files `> 0`, filtered with `NOT EXISTS` against a `retention.files` audit with the same owner and `sweep_id`. The total is a separate `count(*)`, and `limit` applies only to the listed rows, ordered by (at desc, id desc). | integration: 1 incomplete plan, then 1,005 completed plan/result pairs inserted directly → total 1, listed (limit 5), /ops snapshot total 1. Fails on 19986fc |
| Ordering (Codex note) | Package deletion runs first. The kept-ZIP re-verification now runs **after** the packages, immediately before export deletion, and each candidate is re-checked right before its own unlink. | covered by the two tests above and the round-4 abort tests (still green) |
| Q18 — kept re-verify failure | Package cleanup is never aborted by an export problem. The result has `outcome: 'complete' \| 'partial'`; it is `partial` on export abort, any failure or any kept damaged candidate. `outcome` goes into the `retention.files` audit with the same `sweep_id` as the plan. /ops shows "결과: 일부만 처리(전체 성공 아님)". | integration: kept ZIP EACCES on re-read → exports aborted, the old package still deleted, plan and result share `sweep_id`, result `partial` |
| Tie-break | `lastRetentionSweep` takes the plan ordered by (at desc, id desc) and pairs it by `sweep_id`, never by time. | integration: two plan/result pairs with the same `at` → repeated calls return the same row; the merged details come from that plan's own result; incomplete = 0 |
| Q17 — one-sided distribution history | Both `jobs` and `approvals` empty → `no_distribution`. Only one empty → `empty:jobs` or `empty:approvals`, with labels "작업(jobs) 없음 — 작업 복구 미검증" / "승인(approvals) 없음 — 승인 복구 미검증". | integration: owner with an approval but no job → PASS with `empty:jobs`, and neither `no_distribution` nor `empty:approvals` |

- Tests adapted: two exact-shape assertions gained `candidatesDamagedKept: 0` and `outcome` (the idempotency check expects `complete`; the folder-EACCES run expects `partial`, then the cleanup re-run expects `complete`). No check was removed.
- Commands (Windows 10, Git Bash, `source tools/env.sh`; dev server down — port 3000 checked):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 33 files / 589 tests.
  - `test:integration` pass: 25 files / 403 tests (was 398), 236 s.
  - `drill:mock` exit 0, 불변식 위반 0.
  - `build` pass.
- Remaining risks:
  - Each apply now fully reads every kept ZIP and every candidate ZIP once, so cost grows with backup size × count.
  - The race window is now just the time between one ZIP's re-check and its unlink.
  - The `NOT EXISTS` query scans the owner's audit rows by action without a JSON index. That is fine at local scale; an index on `(owner_id, action, (sanitized_details->>'sweep_id'))` would be needed at volume.
  - Multi-process phase ② is still guarded only by the in-process mutex.
- Questions specifically for Codex:
  1. Should a candidate found damaged at apply time also trigger a warning on the kept set? A damaged older ZIP may indicate disk trouble affecting the newer ones, which were just re-verified.
  2. Is an expression index on the audit JSON `sweep_id` (or a dedicated `retention_sweeps` table) warranted now, or only when multi-worker support lands?
  3. With `outcome: 'partial'` in the result audit, should the /ops incomplete list also include partial sweeps, or only sweeps with no result at all?

---

# FIX round 6 (Codex review-FIX5-T20)
- BASE_SHA: 82cde4a · HEAD_SHA: 6e99eef (orchestrator reran lint·typecheck·build·unit 589·integration 412·drill:mock 0·real-DB drill:restore PASS — all PASS)
- Review input: `.handoffs/review-FIX5-T20.md` (on 82cde4a; single P2). BASE_SHA: 82cde4a · HEAD_SHA: TBD (uncommitted working tree)
- Reproduction: the reappeared-ZIP test needs the new `candidatesZipReappeared` field, so I did not run it against 82cde4a. In 82cde4a a good reappeared ZIP was counted as damaged, and it was checked against the planned `zipBytes` (0), so it could only ever be classified "damaged".

| Finding | Change | Test |
|---|---|---|
| P2 page.tsx:277 + retention.ts:496 — reappeared ZIP counted as damaged | Plan entries carry `runZipBytes` (`export_runs.zip_bytes`), so the folder-only re-check verifies a reappeared ZIP against the recorded size:<br>• verified → `candidatesZipReappeared` (kept, not damaged)<br>• damaged/unreadable → `candidatesDamagedKept`<br>• still absent → the folder is removed<br>Both counts are separate in the result, in the `retention.files` audit (`candidates_zip_reappeared` / `candidates_damaged_kept`) and on /ops ("정상 ZIP 이 다시 생겨 남겼습니다(손상 아님)"). A reappearance also makes the outcome `partial`: the plan was not carried out, though nothing failed. | integration: an injected `zipFs.stat` puts the saved good ZIP back between planning and deletion → `reappeared 1, damaged 0`, folder kept, `rmDir` never called; the same with a same-length corrupted ZIP → `damaged 1, reappeared 0` |
| Missed case — candidate re-verification failure modes | No code change; verified that the existing `zipState` mapping is aggregated and audited correctly. | integration, one test per mode:<br>• stat EACCES → kept, `damaged_kept 1`, `partial`<br>• read EACCES → the same<br>• ENOENT between stat and read → treated as absent, folder cleaned, `alreadyAbsent ≥ 1`, audit `export_dirs_deleted 1` |
| Missed case — incomplete query: isolation and limit | No code change needed: `NOT EXISTS` already matches on owner + `sweep_id`, and the order is (at desc, id desc). | integration: 7 incomplete plans, and another owner has a result with the same `sweep_id` as one of them → total 7; limit 3 returns the 3 newest in order |
| Missed case — malformed audit JSON | `incompleteRetentionSweeps` reads the planned counts with `jsonb_typeof = 'number'` guards and requires `jsonb_typeof(sweep_id) = 'string'`, so non-numeric counts and null or numeric `sweep_id`s neither throw nor flag. | integration: inserted rows with `sweep_id: null`, `planned_packages: 'many'` and `sweep_id: 12345` → total 0; `lastRetentionSweep` and `opsSnapshot` resolve |
| Missed case — earlier partial run hidden by a later complete one | New `partialRetentionSweeps` (count of `retention.files` with `outcome = 'partial'` plus the newest 5). `opsSnapshot.partialRetention` holds it, and /ops shows "일부만 처리된 정리 실행 N개" independently of the latest run. | integration: run 1 partial (unlink EACCES), run 2 complete → partial total 1 listing run 1; last = run 2 |
| Missed case — drill scope mirror | No code change needed. | integration: job present (inserted directly as BLOCKED without an approval, since approvals cannot be deleted) and no approvals → PASS with `empty:approvals`, and neither `empty:jobs` nor `no_distribution` |

- Tests adapted: three exact-shape `exports` assertions gained `candidatesZipReappeared: 0`. No check was removed.
- Commands (Windows 10, Git Bash, `source tools/env.sh`; dev server down — port 3000 checked):
  - `lint` pass.
  - `typecheck` pass.
  - `test` pass: 33 files / 589 tests.
  - `test:integration` pass: 25 files / 412 tests (was 403), 264 s.
  - `drill:mock` exit 0, 불변식 위반 0.
  - `build` pass.
- Questions specifically for Codex:
  1. Is marking a reappeared good ZIP as outcome `partial` right, or should `partial` be reserved for failures and aborts, with reappearance counted only?
  2. The partial-run list never expires. Should there be an acknowledge step, or a cutoff, so old partial runs stop showing once a later run has verifiably handled the same files?
