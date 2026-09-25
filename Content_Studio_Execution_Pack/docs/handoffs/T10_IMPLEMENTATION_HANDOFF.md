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
