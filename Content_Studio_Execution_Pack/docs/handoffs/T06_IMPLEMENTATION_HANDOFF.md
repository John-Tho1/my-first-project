# Implementation handoff
- Task ID / milestone: T06 (M2) — Brand Profile 버전 · 인터뷰 질문 3개 · 작성실 assist(outline/draft/revise) · 모의 AI · 채택/diff · A03 게이트 · 프롬프트 복사용 보기
- Purpose and changed behavior:
  - `/brand` 페이지 + `GET/POST /api/brand`: Brand Profile 새 버전 append(최대+1), base_version ≠ 현재 → 409 `{current, yours}`. 새 열 tone(formal|casual)·avoid_phrases·cta_rules·sample_texts. 상단 메뉴 "브랜드", `/settings` 에 링크.
  - `interview_answers`(불변, 트리거) + `GET/POST /api/contents/{id}/answers`: 고정 3개 키(situation/judgment/takeaway), 바뀐 답만 새 행, 질문별 최신이 현재.
  - `POST /api/contents/{id}/assist`: 입력 버전 고정(현재 content_version id·brand_profile id/version·answer_ids) → `generation_runs`(running→succeeded|failed) → 제안을 **현재가 아닌** content_version(created_by='ai:mock', ai_run_id) 으로 저장. `contents.current_version_id` 불변. 실패 → 502 `llm_failed`, run failed, 버전 없음. stale base → 409 `stale_base`(run·버전 없음). `LLM_MODE=live` → 503 fail-closed(`live_llm_not_allowed` / `live_provider_not_configured`), run 없음.
  - `POST /api/contents/{id}/assist/{runId}/adopt`: 제안 본문으로 새 사용자 버전(created_by='owner', ai_run_id=run) → 현재. base_version ≠ 현재 또는 run 입력 버전 ≠ 현재 → 409 `stale_base`(재채택도 409). 감사 `content.adopt_ai`.
  - A03: 채택한 모든 run 의 미확인 experience/needs_user_confirmation claim 이 있으면 `ready` 전이 409 `unconfirmed_experience_claims`(updateContentMeta 잠금 안). 이미 `ready` 인 원고에 그런 제안을 채택하는 것도 409(우회 방지). `POST /api/contents/{id}/claims/confirm` 로 사용자 확인 → `claim_confirmations`(불변, unique(run_id, claim_index)).
  - 작성실 UI(`writing-panel.tsx`): 인터뷰 폼, 모의 제안 폼, MOCK_WARNING 상시 표시, 현재↔제안 diff(DiffView), 제안 채택/무시, claim 확인 버튼, 후속 질문, "프롬프트 복사용 보기" `<details>`(buildAssistPrompt 원문, 읽기 전용). 버전 목록·버전 화면에 "AI 제안(모의)" / "사용자 저장(AI 제안 채택)" 표시.
  - 본문 저장(`appendContentVersion`)의 새 번호를 "현재+1" → "최대+1" 로 변경(AI 제안 번호와 충돌 방지). 잠금·409 로직은 그대로(`lockContentForWrite`/`insertCurrentVersion` 로 추출).
  - `errorResponse` 가 GuardError 를 503 + 가드 코드로 변환(기존에는 500). `AppErrorKind` 에 `llm_failed`(502) 추가.
- BASE_SHA: 71e16c5
- HEAD_SHA: e5fab50cb746305a29f57232a614710160f77aea (FIX round 1; T06 원본 a6fc08a)
- Clean tracked tree confirmed: 아니오 — 커밋 전 작업 트리(변경 21개 추적 파일 + 신규 파일). `.claude/` 는 이 작업과 무관한 기존 미추적 폴더(건드리지 않음).
- Relevant acceptance IDs: M2 통과 조건 중 "AI 실패/중단에도 사용자 원문 보존", "미제공 1인칭 경험 생성 시 검토에서 막힘"(A03). A01(owner 범위), A02(stale 409). A15(비용 상한)·stale 파생본은 T07/T09 범위라 미구현.
- Changed files:
  - DB: `packages/db/src/schema.ts`(brand_profiles 4열 + unique(id, owner_id) + tone CHECK; 새 표 interview_answers·generation_runs·claim_confirmations), `packages/db/drizzle/0005_t06_writing.sql`(drizzle-kit 생성 후 수정: 복합 unique 를 FK 앞으로 이동, 추가 전용 트리거 `append_only_immutable`), `meta/0005_snapshot.json`, `meta/_journal.json`, `packages/db/src/{writing.ts(신규), claims-gate.ts(신규), contents.ts, queries.ts(AuditAction 5개), bundle-tables.ts, restore.ts(PARENTS), index.ts}`
  - Domain: `packages/domain/src/writing.ts`(신규: 스키마·프롬프트 빌더·A03 순수 게이트·오류), `bundle.ts`(EXPORTED_TABLES 3개 추가, ROW_SCHEMAS, TABLE_INTRODUCED_IN 호환, checkIntegrity), `errors.ts`, `index.ts`
  - Providers: `packages/providers/src/llm.ts`(MockLlmProvider `{fail}` 옵션, `MockLlmFailure`, `prompt?` 입력)
  - Web: `apps/web/lib/{writing.ts(신규), server.ts(getLlm), api.ts, contents.ts}`, `apps/web/app/api/brand/route.ts`, `apps/web/app/api/contents/[id]/{answers,assist,assist/[runId]/adopt,claims/confirm}/route.ts`, `apps/web/app/brand/page.tsx`, `apps/web/app/contents/[id]/{page.tsx,writing-panel.tsx,versions/[n]/page.tsx}`, `apps/web/app/{layout.tsx,settings/page.tsx}`
  - Tests: `packages/domain/src/writing.test.ts`(신규 17), `packages/providers/src/llm.test.ts`(신규 3), `packages/domain/src/bundle.test.ts`(픽스처에 새 빈 표 3개만 추가), `tests/integration/writing.test.ts`(신규 19), `tests/integration/migration-0005.test.ts`(신규 1)
  - Docs: `docs/DECISIONS.md` D12, `README_KO.md` T06 절
- Migrations / restore implications:
  - 0005 는 기존 brand_profiles 행에 tone='formal', 나머지 '[]' 기본값. migration-0005.test 가 0004 데이터 위 적용·복합 FK·트리거·CHECK 를 확인.
  - **실행 중인 dev 서버(./data/pglite)는 0005 없이 열린 싱글턴 DB 를 쓰고 있어, 재시작 전까지 /brand·작성실이 새 열/표 부재로 실패할 수 있다.** 재시작하면 getDb 가 0005 를 자동 적용한다(이 작업에서는 ./data/pglite 에 migrate/seed 를 실행하지 않았다).
  - 내보내기: 새 표 3개 EXPORTED(복원 순서 content_captures 다음). PARENTS: interview_answers→contents, generation_runs→contents/brand_profiles/content_versions(input, output), claim_confirmations→generation_runs. checkIntegrity 에 content_versions.ai_run_id→generation_runs 와 run 의 input/output 버전이 같은 원고인지 추가.
  - 호환: 0005 이전 묶음(M1)은 `TABLE_INTRODUCED_IN` 규칙으로 새 표를 빈 표로 읽고, brand_profiles 새 열은 zod default 로 채운다. 묶음 migrations 에 0005 가 있는데 표 파일이 없으면 거부(단위 테스트).
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0):
  - 변경 전 기준선: `pnpm test` 17 files / 277 passed, `pnpm test:integration` 11 files / 123 passed.
  - `cd packages/db && pnpm exec drizzle-kit generate --name t06_writing` → 0005 SQL·snapshot·journal 생성(DB 연결 없음), 이후 SQL 수동 수정.
  - `pnpm lint` → pass(exit 0)
  - `pnpm typecheck` → pass(exit 0)
  - `pnpm test` → pass, 19 files / 296 tests
  - `pnpm test:integration` → pass, 13 files / 143 tests
  - `pnpm build` → pass(exit 0, 새 라우트 /brand, /api/brand, /api/contents/[id]/{answers,assist,assist/[runId]/adopt,claims/confirm})
  - 수동 확인: `DATABASE_URL=memory:// APP_BASE_URL=http://localhost:3100 next start -p 3100`(별도 프로세스, 메모리 DB) 에 curl 로 로그인 → /api/brand 폼 303 → 원고 생성 → 답변 201 → assist 폼 303(?run=…#assist) → `/contents/{id}` HTML 에 인터뷰 질문·AI 작성 보조·MOCK_WARNING·diff·제안 채택/무시·1인칭 경험 미확인·확인 버튼·프롬프트 복사용 보기·"AI 제안(모의)" 태그 확인, `/brand` 200. 확인 후 3100 프로세스 종료. 브라우저 클릭 확인은 pane 렌더링 실패로 못 함(not_run).
  - `pnpm test:e2e` → not_run.
- Demo route / local start steps: dev 서버 재시작(0005 자동 적용) → 로그인 → 상단 "브랜드"에서 새 버전 저장 → 원고 작성실 `/contents/{id}` 에서 인터뷰 답변 저장 → "모의 제안 만들기" → diff 확인 → "제안 채택" → 상태를 검토 중 → 준비됨으로 바꾸면 409 안내 → "내가 실제로 겪은 일이 맞습니다(확인)" → 준비됨 가능.
- External calls performed (exact scope, or none): none. 새 의존성 0. 비밀값 0.
- Mock-only functionality: 모든 AI 제안(MockLlmProvider — 결정적, 답변→본문 앞 3문장으로 claim, 1인칭 표현 → experience). live provider 없음(`LLM_MODE=live` 는 항상 503). 실패 주입은 `NODE_ENV=test` + `LLM_MOCK_FAIL_NEXT=1` 에서만.
- Known risks / not run:
  - 채택하지 않고 제안 문장을 본문에 직접 복사하면 A03 게이트가 걸리지 않는다(채택 경로만 추적). **수동 복사는 추적하지 않음 — 사용자 결정 필요**(Codex P1, FIX round 1 에서도 미구현).
  - 복원 add_missing 에서 generation_runs 행이 충돌로 빠지고 채택 버전(ai_run_id 보유)만 들어가면 게이트가 그 run 을 보지 못한다(content_versions.ai_run_id 에 FK 없음 — 복원 순서 때문). → FIX round 1 에서 사후 검사로 복원 전체 중단하도록 수정.
  - run 이 provider 호출 중 프로세스가 죽으면 `running` 으로 남는다(청소 없음). assist 는 run 기록 트랜잭션 → provider 호출(트랜잭션 밖) → 결과 트랜잭션의 3단계.
  - 프롬프트 붙여넣기(결과 가져오기)는 T06 범위 밖 — 보기만 있다.
  - 채택 버전 created_by 는 지시문의 'user' 대신 기존 값 'owner'(D12 에 기록, 사용자 확인 요청).
  - Brand Profile 동시 저장은 잠금 없이 (owner_id, version) unique + onConflictDoNothing 으로 409 처리(동시성 테스트 없음).
  - 브라우저 클릭 E2E 미실행.
- Questions specifically for Codex:
  1. A03 우회 경로: `updateContentMeta`(ready 전이)와 `adoptProposal`(이미 ready 인 원고) 외에 lifecycle 이 `ready` 가 되거나 채택 버전이 생기는 경로가 있는가(복원 add_missing, 폼 경로, `claimsOf` 의 기본값 `needs_user_confirmation !== false`, 채택 판정 `created_by='owner' AND ai_run_id`)? `packages/db/src/claims-gate.ts`, `writing.ts#adoptProposal`, `contents.ts#updateContentMeta`.
  2. stale 입력 버전: `prepareAssist` 는 잠금 안에서 base 를 검사하지만 provider 호출 후 결과 트랜잭션은 현재 버전을 다시 비교하지 않는다(제안은 입력 버전 기준으로만 저장, 채택 시 `run.inputVersionId === current.id` 로 차단). 이 설계로 "오래된 제안이 최신 본문을 덮는" 경로가 남는가?
  3. owner 격리: generation_runs/claim_confirmations/interview_answers 의 모든 조회에 owner_id 가 있는가, 복합 FK(0005)가 다른 owner 의 brand_profile·content·run 참조를 모두 막는가? `adoptedRunIds` 는 content_id 만으로 content_versions 를 거르는데(owner_id 열 없음) 호출 전 run 목록이 owner 로 걸러져 있어 충분한가?
  4. 버전 번호 변경: 본문 저장이 "현재+1" → "최대+1" 이 되면서 기존 경로(409 비교 화면, diff "이전과 비교", 복원 current_version_id 연결, Markdown 내보내기의 현재 본문)가 제안 버전이 섞인 이력에서 올바른가?
  5. export/restore: 새 표 3개의 PARENTS·checkIntegrity·TABLE_INTRODUCED_IN 호환 규칙이 M1 묶음·변조 묶음(예: 다른 원고의 버전을 가리키는 output_ref, 존재하지 않는 ai_run_id)을 올바르게 거부/허용하는가?
  6. migration 0005: 수동으로 옮긴 `brand_profiles_id_owner_uq` 순서와 `append_only_immutable` 트리거가 PostgreSQL(M3 운영)에서도 PGlite 와 같게 동작하는가? drizzle snapshot 과 SQL 의 차이(트리거는 snapshot 에 없음)가 다음 generate 에 영향을 주는가?
- Next authorized task: T07(모의 경계까지) — 사용자·오케스트레이터 승인 후. live provider·키·과금은 D8 결정 전 금지.

---

# FIX round 1 (Codex review-T06)
- Review: `.handoffs/review-T06.md` (CHANGES_REQUESTED, review HEAD a6fc08a)
- BASE_SHA: a6fc08a
- HEAD_SHA: e5fab50cb746305a29f57232a614710160f77aea (FIX round 1; T06 원본 a6fc08a)
- Migration: `0006_t06_claim_resolution.sql`(+ `meta/0006_snapshot.json`, journal idx 6). drizzle-kit 생성 후 수동 수정 — `interview_answers.seq` 를 nullable 로 추가 → 추가 전용 트리거를 잠시 끄고 원고별 (created_at, id) 순으로 1..n 채움 → 트리거 다시 켬 → NOT NULL → unique(content_id, seq). `claim_confirmations.resolution` 기존 행은 'confirmed'.

| Finding | Change | Test |
| --- | --- | --- |
| P0 bundle.ts:759 — `ai_run_id` 가 다른 원고의 run 을 가리켜도 통과 | `checkIntegrity`: `content_versions.ai_run_id` → 같은 원고의 generation_runs 여야 함(run 의 input/output 버전 같은 원고 검사는 기존). `restore.ts#applyBundle`: 모든 표 적용 후 사후 검사 — 이번에 넣은 버전의 run 이 `inserted`/`same` 이 아니면 `restore_conflict`(conflicts: content_versions/dependency)로 전체 중단(미리보기·커밋 동일 코드) | unit `writing.test.ts` "다른 원고의 run 을 가리키는 ai_run_id → integrity"; integration `writing.test.ts` "P0 복원: … 복원 전체 중단, DB 그대로" |
| P1 claims-gate.ts:37 — 문장을 지워도 ready 계속 차단 | `claim_confirmations.resolution`('confirmed'\|'removed'), `POST /claims/confirm` body `resolution`(기본 confirmed, 그 외 값 400), 감사 details 에 resolution. UI 버튼 2개 "내 경험이 맞음(확인)" / "본문에서 뺐음(제외)", 도움말 갱신. 게이트는 두 값 모두 해결로 봄 | integration "P1 claims-gate: … removed 하면 ready 가능, 감사에 resolution"; migration-0005.test "0006: … resolution 은 confirmed, CHECK" |
| P1 writing.ts:634 — 최근 10개 밖 미확인 run 이 안 보임 | `getWritingState(db, owner, content, selectedRunId?)`: 최근 10 + 미해결 claim run + `?run=` 직접 조회(owner·원고 범위, 중복 제거). page.tsx 가 `run` 파라미터를 넘김 | integration "P1 최근 10개 밖: … 11개 실행 뒤에도 … URL run 직접 조회"(다른 원고·다른 owner 는 안 들어옴) |
| P2 writing.ts:171 — 같은 시각 답변의 최신 판정이 UUID 순 | `interview_answers.seq`(원고 잠금 안 최대+1), `latestAnswers`·목록 정렬을 seq 로. 묶음: 0005 묶음의 seq 누락은 `fillAnswerSeq` 가 migration 과 같은 규칙으로 채움 | integration "P2 답변 seq: 같은 시각…"; unit "seq 가 없는 0005 묶음…"; migration-0005.test "0006: 기존 답변 … seq" |
| P2 writing.ts:134 — 브랜드 충돌 409 의 current 가 오래됨 | owner(users) 행 `FOR UPDATE` 로 읽기→번호 할당 직렬화, 409 생성 시 current 를 다시 읽음 | integration "P2 브랜드 동시 저장: 409 본문의 current 는 방금 저장된 최신 버전"(Promise.all 2건 → 201+409) |
| P1 contents.ts:389 — 수동 복사로 A03 우회 | **구현하지 않음**(지시). D12 에 "수동 복사는 추적하지 않음 — 사용자 결정 필요" 명시, 패널 도움말에도 표시 | — |

- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - `cd packages/db && pnpm exec drizzle-kit generate --name t06_claim_resolution` → 0006 생성(DB 연결 없음), 이후 SQL 수동 수정
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → 19 files / 298 tests pass. 참고: FIX 후 첫 실행 1회가 실패로 끝났고(출력이 잘려 어떤 테스트인지 확인하지 못함) 이후 연속 7회 모두 통과 — 원인 미확인 flaky 로 기록
  - `pnpm test:integration` → 13 files / 149 tests pass
  - `pnpm build` → pass
- Known risks (추가·갱신):
  - **수동 복사는 추적하지 않음 — 사용자 결정 필요**(Codex P1 contents.ts:389, 미구현).
  - `resolution='removed'` 는 서버가 현재 본문과 대조하지 않는 사용자 표시다. 문장을 실제로 남겨 둔 채 "뺐음"을 눌러도 막지 않는다.
  - 복원 사후 검사는 버전↔run 순환만 다룬다. `input_version_refs` 내부 값·`output_json` 구조(claims 가 배열이 아닌 경우 `claimsOf` 는 [] → 게이트 통과)는 여전히 검증하지 않는다.
  - 기존 "이전과 비교"(n-1) 링크는 제안 버전이 섞인 이력에서 채택 직후 빈 diff 를 보일 수 있다(Codex 답변 4, 미수정).
  - `pnpm test` 1회 원인 미확인 실패(위).
- Questions specifically for Codex (FIX round 1):
  1. 복원 순환 처리: `applyBundle` 끝의 사후 검사(이번에 넣은 버전의 run 이 inserted/same 이 아니면 전체 중단)가 add_missing 의 모든 조합(run id_in_use·dependency 로 빠짐, run 은 같지만 버전만 새로 들어옴, 기존 버전이 이미 run 을 가리킴)에서 A03 이력 유실을 막는가? 전체 중단 대신 해당 버전만 제외하는 편이 나은 경우가 있는가?
  2. `resolution='removed'` 의미: 본문 대조 없는 사용자 표시로 A03("미제공 1인칭 경험이 생성되면 검토에서 막힘")을 충족한다고 볼 수 있는가? 최소한 현재 본문에 claim 원문이 그대로 있으면 'removed' 를 거부해야 하는가?
  3. URL run 조회: `getWritingState` 의 `selectedRunId` 직접 조회가 owner·원고 범위를 벗어나는 경로(대소문자·형식 오류 ID·다른 원고의 run)를 모두 막는가? 페이지가 목록에 없는 run 을 선택했을 때 제안 본문 조회(`versions.find`)가 다른 원고 버전을 보여 줄 수 있는가?
  4. 0006 채움: `DISABLE/ENABLE TRIGGER` 를 migration 트랜잭션 안에서 쓰는 방식이 PostgreSQL(M3)에서도 안전한가, 동시 쓰기와 겹치면 추가 전용 보장이 깨지는 창이 있는가?

---

# FIX round 2 (Codex review-FIX-T06)
- Review: `.handoffs/review-FIX-T06.md` (CHANGES_REQUESTED, review HEAD e5fab50)
- BASE_SHA: e5fab50
- HEAD_SHA: TBD (orchestrator commits)
- Migration: `0007_t06_removed_binding.sql`(+ `meta/0007_snapshot.json`, journal idx 7, drizzle-kit 출력 그대로 + 머리 주석). `claim_confirmations.body_version_id`(nullable uuid, FK content_versions), unique 를 (run_id, claim_index) → (run_id, claim_index, resolution) 로 교체. 추가 전용 트리거는 그대로. 묶음: `body_version_id` 는 이전 묶음에서 null 기본값, checkIntegrity 가 존재·run 과 같은 원고인지 확인, restore PARENTS 에 content_versions 추가.

| Finding | Change | Test |
| --- | --- | --- |
| P1 writing.ts:624 — `removed` 가 본문과 무관한 영구 해결 | `@cs/domain` 순수 함수 `normalizeForClaimMatch`·`bodyContainsClaim`(NFKC·소문자·`\p{L}\p{N}` 만 남긴 부분 문자열 일치, 퍼지 아님, 문장부호뿐인 claim 은 "있음")·`isClaimResolved`. `confirmClaims` 가 `lockContentForWrite` 안에서 현재 본문 검사 → 문장 있으면 409 `claim_still_in_body`(`ClaimStillInBodyError`, extra `claim_indexes`), 행 없음. 저장 시 `body_version_id` = 현재 버전(확인·제외 모두). 게이트(`claims-gate.ts`)는 현재 본문(`currentBodyOf`, owner 범위)을 넘겨 'removed' 를 매번 재검사, 본문을 못 찾으면 미해결. `confirmed` 는 영구. 패널: 같은 판정(`isClaimResolved`)으로 표시, "제외했던 문장이 본문에 다시 있음 — 다시 확인 필요", 도움말 "제외는 문장이 본문에 없을 때만, 다시 넣으면 다시 확인 필요". 폼 오류 코드 `claim_still_in_body` 문구 | unit `writing.test.ts` "FIX-T06 round 2" 5개(공백·문장부호·전각 무시, 한 글자 차이·일부만 → 없음, 문장부호뿐 claim, isClaimResolved, 재삽입 → 미해결); integration "P1: 문장이 본문에 남아 있으면 removed → 409, 행 없음(공백·문장부호 변형 포함)", "뺀 뒤 removed → body_version_id·ready 가능 → 다시 넣으면 ready 409 → 확인 후 ready", "confirmed 는 본문 변경과 무관"; migration "0007: …" |
| P2 apps/web/lib/writing.ts:54 — 폼 resolution 강제 변환 | `formToClaimConfirm` 이 받은 값을 그대로 넘기고 칸이 없을 때만 스키마 기본값 | integration "P2: 잘못된 resolution — JSON 400(빈 값), 폼 303 ?error=invalid(bogus·빈 값·대문자), 행 없음, 칸 없으면 confirmed" |
| P2 page.tsx:52 — 대문자 `?run=` | `normalizeRunParam`(소문자·UUID 검증·'none')과 `selectRun` 을 `apps/web/lib/writing.ts` 로 분리, page 는 같은 값으로 조회·선택 | integration "P2: 대문자 ?run= UUID 도 그 run 을 조회·선택"(12개 run 중 최근 목록 밖 run) |

- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - `cd packages/db && pnpm exec drizzle-kit generate --name t06_removed_binding` → 0007 생성(DB 연결 없음)
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → 19 files / 303 tests pass
  - `pnpm test:integration` → 13 files / 155 tests pass
  - `pnpm build` → pass
- Known risks (추가):
  - 포함 검사는 문자열 비교다. 어미·조사를 한 글자만 바꿔 같은 경험을 남겨도 "없음"으로 판정되어 제외가 허용된다(의미 비교 없음). 반대로 claim 이 짧은 흔한 구절이면 다른 문장 안에 우연히 포함되어 제외가 거부될 수 있다.
  - 0006 까지의 'removed' 행(body_version_id null)도 게이트에서는 현재 본문으로 다시 검사되므로 안전 쪽이지만, 기록상 어떤 본문 버전을 보고 제외했는지는 알 수 없다.
  - **수동 복사는 추적하지 않음 — 사용자 결정 필요**(변동 없음).
- Questions specifically for Codex (FIX round 2):
  1. 포함 검사의 한계: `bodyContainsClaim`(NFKC·소문자·글자/숫자만 남긴 부분 문자열)이 A03 의 "미제공 1인칭 경험이 남아 있으면 막힘"에 충분한가? 어미 변화·문장 분할·다른 문장과의 우연한 일치 같은 경계에서 거짓 음성(제외 허용)/거짓 양성(제외 거부) 중 어느 쪽을 더 허용할지 판단이 필요한가?
  2. 해결 방식별 unique(run, index, resolution)와 "confirmed 우선" 판정: 제외 → 재삽입 → 확인 순서, 그리고 확인이 제외보다 먼저 있는 경우에 게이트·패널·감사 기록이 일관되는가? `body_version_id` 가 run 의 원고와 같은 원고인지 DB 수준에서 강제되지 않는 점(복합 FK 없음, 앱·묶음 검사만)은 문제인가?
  3. `normalizeRunParam`/`selectRun`: 지정한 run 이 다른 원고·다른 owner 것이거나 목록에서 빠졌을 때 최신 run 으로 조용히 되돌아가는 동작이 사용자를 오도할 여지가 있는가?

## Codex 재검증 round 2 결과 (review-FIX2-T06, gpt-6-astra/xhigh) — 오케스트레이터 판단
- 남은 지적 1건(P1): `bodyContainsClaim` 은 어미만 바꿔도("설득했습니다"→"설득했어요") 삭제로 본다. 제안은 claim–본문 구간 연결 유지 + 수정/삭제 구분.
- 판단: **더 수정하지 않음 — 사용자 결정 필요(D14 후보).** 근거:
  1. 서버는 자연어 의미 단위의 "삭제됨"을 증명할 수 없다. 구간 추적(span)도 사용자가 문장을 고쳐 쓰면 끊어진다.
  2. `removed` 자체가 round 1 지적("거짓 경험을 사실이라 확인하지 않고도 검토 완료 가능해야")에 대한 응답이다. 두 요구를 동시에 기계적으로 만족시키는 방법은 없다.
  3. 현재 구현은 `removed` 를 **사용자 단언 + 문자열 재삽입 가드**로 두고, 재삽입 시 재차단한다. 라벨·도움말에 한계를 표시했다.
- 선택지(사용자): (a) 현재 방식 유지, D12 에 "removed 는 사용자 단언이며 어미 변경은 감지 못함" 명시 (b) `removed` 를 없애고 confirm 만 두되 "사실 아님(부인)" 이라는 3번째 resolution 을 추가해 ready 를 계속 차단(=거짓 경험이 있는 원고는 그 문장을 지우고 새 assist 를 돌려야 함) (c) claim–구간 연결 구현(T07 이후 별도 작업).
- 수동 복사 우회(P1, round 1 #6)와 함께 아침에 결정 요청.
