# Implementation handoff — LIVEP1-USERCONFIRM ("Threads에서 확인함" — 결과 불명 실제 게시의 사용자 확인)
- Task ID / milestone: LIVEP1-USERCONFIRM / M4 D38 후속(사용자 "넣어줘"). DECISIONS D38 "발견·후속 (2)" — 결과 불명 항목을 사용자가 "Threads 에서 확인함"으로 표시하는 수단.
- Purpose and changed behavior:
  1. 새 route `POST /api/distribution-items/{id}/user-confirm` { candidate_external_id } — owner 세션 + 같은 출처 검사, HTML 폼(→ 303 `/distribute/{plan}?user_confirmed=1`)·JSON 둘 다.
  2. 허용(모두, 항목·작업 잠금 안에서 다시 판정 — `@cs/domain` `userConfirmProblem`): 실제(live) Threads 계정 항목 · 항목에 결과(publication) 없음 · 가장 최근 작업이 UNKNOWN/RECONCILING · 복원한 읽기 전용 작업 아님 · 그 작업에 게시 시도 표식(publish_attempt) 있음 · 게시 기록(publish — 결정적 미디어 ID) 없음 · **가장 최근 재확인 이력**의 후보가 형식 검사(threads:<숫자> + https://(www.)threads.com|net 링크)를 통과 · 요청의 candidate_external_id = 그 후보. 아니면 409 코드: `user_confirm_not_live` · `_already_published` · `_not_pending` · `_restored` · `_no_attempt` · `_publish_recorded` · `_no_candidate` · `_candidate_mismatch`. 형식이 틀린 ID 400, 다른 owner 404.
  3. 효과(한 트랜잭션): publications INSERT(external_id·permalink = 후보, result_kind PUBLISHED, remote_visibility unknown, **verification USER_CONFIRMED**(VERIFIED 아님, verified_at null), confirmed_by 'owner', confirmed_at) → 작업 UNKNOWN/RECONCILING → CONFIRMED(새 도메인 전이 `user_confirmed`, 이력 sanitized_details event=user_confirmed·confirmed_by·external_id·permalink·publication_id) → 항목 CONFIRMED → 계획 상태 재계산 → 감사 `item.user_confirm`. **네트워크 0·재게시 0·전송 의도 0**(어댑터·레지스트리·fetch 안 씀). PUBLISH_MODE 등 실제 게시 조건과 무관(이미 일어난 게시의 기록 — 잠금 상태에서도 동작).
  4. 동시 두 번 제출: 항목 행 FOR UPDATE 로 직렬화 → 늦은 쪽 409(already_published). (항목, 외부 ID) unique + ON CONFLICT DO NOTHING 이 한 번 더 막음.
  5. 화면(항목 카드): 확인 후보(미확인) 줄 아래, 서버와 같은 판정(`userConfirmCandidateForCard` → `userConfirmProblem`)일 때만 버튼 "Threads에서 확인함" + 경고 "후보 링크를 열어 내 글인지 직접 확인한 뒤 누르세요. 앱이 검증한 것은 아닙니다 (기록만 합니다 — 다시 게시하지 않음)". 결과는 배지 "사용자 확인"(보라 `tag user-confirmed`) — "확인됨(VERIFIED)"(초록 `tag verified`)와 다른 색, 머리줄·작업 줄·결과 목록 문구도 "사용자 확인(… 앱이 검증한 것은 아님)". 배너는 저장된 USER_CONFIRMED 결과가 있을 때만. 모의 항목은 판정상 언제나 버튼 없음(DB CHECK 로도 MOCK ≠ USER_CONFIRMED).
- BASE_SHA: f96aefc
- HEAD_SHA: a67f462c31b6125de55adf316ce8831fc7d6b0d9
- Clean tracked tree confirmed: 시작 시 yes(`?? .claude/` 만).
- Relevant acceptance IDs: AGENTS Invariants(결과 불명 → 조회 또는 UNKNOWN·맹목 재전송 금지, 모의 성공 ≠ 실제 게시, 실제 확인 상태 표시), docs/03(수동 기록 ≠ VERIFIED, 상태 전이는 domain 한 곳), A08·A16(취지 — 사용자 기록과 API 검증 구분)·A20, D38.

## 다른 시험 시스템과의 상호작용 확인
- 계획 상태: CONFIRMED 항목 → `planStatusFrom` 그대로(단일 항목 계획 → completed, 시험으로 확인).
- 재시도·취소·재확인: CONFIRMED 뒤 retry 409, cancel 409, reconcile 409 nothing_to_reconcile, 작업 처리기 lease 0(시험). 처리기가 RECONCILING 조회 lease 중이면 CONFIRMED(끝난 상태, lease 해제)로 바뀌어 처리기 적용은 기존 lease_lost 검사로 버려진다(코드 확인 — 시험은 없음).
- D38 게시 수: 사용자 확인은 전송 의도를 만들지 않음 → `liveApprovalUsage` 전후 같음(시험). `pendingLiveJobs` 에서는 CONFIRMED 가 끝난 작업이라 빠진다.
- 내보내기·복원: publications 묶음 스키마에 verification USER_CONFIRMED·`confirmed_by`(literal 'owner'|null, 0045 이전 묶음은 기본 null)·`confirmed_at` 추가, 무결성(USER_CONFIRMED ⇔ 확인자·시각, 실제·공식 링크·PUBLISHED·verified_at 없음 — DB CHECK 와 같은 규칙). 복원은 기존 경로(읽기 전용 이력 INSERT). 복원 훈련 PASS·변조 5종 거부(시험).

## Migrations / restore implications
- `0045_livep1_user_confirm`(drizzle-kit generate — schema.ts 만 읽음, DB 연결 없음 — + 손으로 추가한 `CREATE OR REPLACE FUNCTION publications_guard`): publications 열 `confirmed_by text`·`confirmed_at timestamptz`(nullable), `publications_verification_chk` 에 USER_CONFIRMED, 새 CHECK `publications_user_confirmed_chk`(USER_CONFIRMED ⇔ confirmed_by not null, by ⇔ at, by = 'owner')·`publications_user_confirmed_shape_chk`(USER_CONFIRMED → not is_mock·verified_at null·permalink not null·PUBLISHED). guard: confirmed_by·confirmed_at 변경과 USER_CONFIRMED 로/에서의 verification 변경 거부(기존 규칙 그대로). 기존 행은 그대로 통과(migration-0045 시험).
- **./data 에는 적용하지 않았다** — 오케스트레이터가 dev 서버를 끈 뒤 `pnpm db:migrate`(0045) 해야 route·화면이 동작한다(적용 전 실행하면 publications SELECT 가 없는 열을 찾아 실패).
- `tests/integration/migration-0044.test.ts`: 0043 상태 DB 에서 **현재** 작업 처리기(runJobsTick)로 모의 결과를 만들던 준비 단계가 0045 열(confirmed_by) 때문에 깨짐 → 같은 모양의 모의 결과(CONFIRMED 작업·accepted 의도·MOCK 결과)를 SQL 로 넣도록 준비 단계만 바꿈(0033 시험과 같은 방식). 0044 에 대한 단언은 모두 그대로(약화 없음).

## 변경 파일
- 새 파일: `packages/domain/src/user-confirm.ts`(판정·후보·코드·문구·스키마·`UserConfirmError`), `packages/domain/src/user-confirm.test.ts`, `packages/db/src/user-confirm.ts`(`userConfirmItem`), `apps/web/app/api/distribution-items/[id]/user-confirm/route.ts`, `packages/db/drizzle/0045_livep1_user_confirm.sql`, `packages/db/drizzle/meta/0045_snapshot.json`, `tests/integration/live-user-confirm.test.ts`(11), `tests/integration/migration-0045.test.ts`(1)
- 수정: `packages/domain/src/jobs.ts`(JOB_EVENTS `user_confirmed`, UNKNOWN·RECONCILING → CONFIRMED, PUBLICATION_VERIFICATIONS `USER_CONFIRMED`, 머리 주석), `packages/domain/src/jobs.test.ts`(A08 정확 집합에 user_confirmed 추가 + CONFIRMED 단언 — 의도한 변경, lease 없음 단언 그대로), `packages/domain/src/bundle.ts`, `packages/domain/src/index.ts`, `packages/db/src/schema.ts`, `packages/db/src/distribution.ts`(publication view 에 confirmed_by·confirmed_at·사용자 확인 notice), `packages/db/src/queries.ts`(감사 action), `packages/db/src/index.ts`, `packages/db/drizzle/meta/_journal.json`, `apps/web/lib/distribution.ts`(`userConfirmCandidateForCard`·`liveVerificationTag`·문구·오류 문구 8개·작업 줄), `apps/web/lib/distribution.test.ts`(+5 describe 항목), `apps/web/app/distribute/[id]/page.tsx`, `apps/web/app/globals.css`(토큰 4개 ×2 테마, `.tag.verified`·`.tag.user-confirmed`), `docs/04_DATA_AND_API.md`(API 표 1줄), `tests/integration/migration-0044.test.ts`(위 설명)
- **손대지 않음**: `packages/db/src/jobs.ts`·`packages/providers/src/threads-live-publish.ts`(LIVEP1-TIMEOUT 리뷰 중 — 변경 0), DECISIONS, docs/03, `.env.local`, `./data`.

## Actual commands and results
(Windows 10, Git Bash, `export PATH="/usr/bin:/mingw64/bin:$PATH"; source tools/env.sh`, Node 24.21.0, `corepack pnpm`, dev 서버 시작 안 함. db:migrate·drill:restore 는 ./data 를 열어 뺐다. 로그 `.handoffs/checks-LIVEP1USERCONFIRM*.log`)
| 명령 | 결과 |
|---|---|
| `vitest run --project unit packages/domain/src/user-confirm.test.ts`(구현 전) | FAIL — 모듈 없음(`checks-LIVEP1USERCONFIRM.repro-unit.log`) |
| `vitest run --project integration tests/integration/live-user-confirm.test.ts`(구현 전) | FAIL — route 없음(`checks-LIVEP1USERCONFIRM.repro-integ.log`) |
| `drizzle-kit generate --name livep1_user_confirm`(packages/db) | 0045 SQL·snapshot·journal → guard 함수 손으로 추가 |
| `vitest run --project integration migration-0044.test.ts`(0045 schema 뒤, 시험 수정 전) | FAIL 1 — 0043 DB 에서 현재 처리기가 confirmed_by 열을 씀 → 준비 단계 SQL 로 |
| 구현 뒤 unit 4 파일(user-confirm·jobs·web distribution·bundle) | PASS 232/232 |
| 구현 뒤 integration live-user-confirm 1회차 | FAIL 2/11 — 시험 설정(실행 앞선 검사가 다른 계획의 QUEUED·RECONCILING 실제 작업을 세어 상한 1 에서 429) → 시험 상한 5 로 → PASS 11/11, migration-0044·0045 PASS |
| `corepack pnpm lint` | PASS(`checks-LIVEP1USERCONFIRM.lint.log`) |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm build` | PASS |
| `corepack pnpm exec vitest run --project unit` | PASS — 69 files, 1699 tests |
| `corepack pnpm exec vitest run --project integration` | PASS — 49 files, 911 tests(워커 충돌 없음 — --maxWorkers=2 재실행 불필요) |
| `corepack pnpm drill:mock` | PASS — "불변식 위반 0건" |
| `db:migrate` · `drill:restore` | not_run(./data 금지) |
- 이번에는 내가 띄운 프로세스만 다뤘다(전체 node 종료 명령 없음). 요약 `.handoffs/checks-LIVEP1USERCONFIRM.summary.log`.

## Demo route / local start steps(오케스트레이터 0045 적용 뒤)
1. dev 서버 끄기 → `pnpm db:migrate`(0045) → dev 서버.
2. 배포 계획 26578f3c(작업 6e236a8f, UNKNOWN/RECONCILING, 후보 `…/post/DeeRJ-LjgdA`) 화면 → 후보 링크 열어 확인 → "Threads에서 확인함" → 배지 "사용자 확인", 계획 처리 끝. 외부 호출 없음(PUBLISH_MODE disabled 그대로 가능).
   - 주의: 그 작업의 **가장 최근 재확인 이력**에 후보가 있어야 버튼이 보인다(이후 재확인이 후보 없이 끝났다면 재확인을 한 번 더 — 실제 목록 조회 1회, PUBLISH_MODE 필요 여부는 기존 규칙). 화면은 최근 이력 10개만 보므로 그 뒤 이력이 10개를 넘으면 버튼이 안 보일 수 있다(서버는 전체 이력에서 판정).

## External calls performed
- **none**. 사용자 확인 경로는 fetch 를 쓰지 않는다(시험: 호출 동안 전역 fetch 를 "부르면 실패"로 바꿔 0회, fixture fetch 호출 수 그대로). 결과 불명 상태를 만드는 시험 단계는 주입 fixture fetch 만.

## Mock-only functionality
- 결과 불명 상태와 후보는 fixture 목록 응답으로 만든 것. 실제 6e236a8f 행에 대한 동작은 0045 적용 뒤 사용자가 확인해야 한다(미관찰).

## Known risks / not run
1. `db:migrate`·`drill:restore` not_run(./data 금지) — 0045 적용 전에는 새 코드가 publications 를 읽을 때 실패한다(배포 순서: 커밋 → dev 서버 끄기 → migrate).
2. 동시성은 PGlite 한 연결로만 확인(실제 PostgreSQL 독립 연결 미검증) — 항목 FOR UPDATE + unique 에 의존.
3. 복원한 작업(restored_needs_review)은 409 `user_confirm_restored` 로 막았다(과제 목록 밖의 보수적 추가 — 복원 작업은 읽기 전용 이력이라는 기존 규칙). 필요하면 풀 수 있다.
4. 게시 기록(publish 단계)이 있는 작업은 `user_confirm_publish_recorded`(재확인으로 확정)로 막았다(보수적 추가).
5. 후보 링크가 없는 후보(링크 형식 실패·누락)는 확인 대상이 아니다(사용자가 열어 볼 수 없으므로) — 화면은 기존처럼 후보 ID 만 보인다.
6. remote_visibility 는 'unknown' 그대로(사용자가 본 글이어도 공개 범위는 확인 값이 아님).
7. 화면은 서버 렌더링 코드만 바꾸고 브라우저로 보지 않았다(dev 서버 금지) — 문구·판정은 lib 단위·통합 시험으로만.
8. docs/03 의 "수동 URL 입력은 MANUAL_REPORTED, 실제 상태 조회만 VERIFIED" 줄은 바꾸지 않았다(USER_CONFIRMED 는 그 취지 — 사용자 기록 ≠ VERIFIED — 안의 새 값). 문서 반영 여부는 오케스트레이터 판단.

## Questions specifically for Codex
1. 허용 조건 묶음(실제 Threads·결과 없음·UNKNOWN/RECONCILING·표식 있음·게시 기록 없음·최근 재확인 후보 = 요청 ID)이 "앱은 본문·시각 일치로 확정하지 않는다"(FIX-LIVEP1 P0)와 충돌 없이 사용자 기록만 남기는가? USER_CONFIRMED 가 VERIFIED 로 오인될 경로(화면·API·묶음·DB)가 남아 있는가?
2. 작업을 CONFIRMED(끝난 상태)로 두는 선택 — 계획 completed·재시도/취소/재확인 거절·게시 수 계산과 맞는가? CONFIRMED 와 별도 상태(예: USER_CONFIRMED 작업 상태)가 필요했는가?
3. 처리기 조회 lease 와 겹칠 때 lease_lost 로 버려지는 경로(시험 없음)가 충분한가?
4. publications_guard 를 CREATE OR REPLACE 로 바꾼 것(기존 0017 본문 + 두 줄)이 0017·0044 트리거 규칙을 그대로 유지하는가?

## Next authorized task
- 오케스트레이터: 커밋 → Codex 검증(BASE f96aefc) → dev 서버 끄고 `pnpm db:migrate`(0045) → 사용자가 6e236a8f 를 "Threads에서 확인함"으로 기록(외부 호출 없음).
