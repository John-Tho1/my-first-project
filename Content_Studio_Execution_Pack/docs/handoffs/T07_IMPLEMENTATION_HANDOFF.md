# Implementation handoff
- Task ID / milestone: T07 (M2) — 입력 버전 고정(허용 출처) · claim–source 연결 · 경험 확인(user_confirmed 파생) · 비용 예약(A15) · live provider 경계(**모의 경계까지, 실제 호출 없음**)
- Purpose and changed behavior:
  - **입력 버전 고정 강화**: `POST /api/contents/{id}/assist` 가 `source_version_ids`(선택)를 받는다. 이 원고에 연결된 소재(content_captures → captures → sources, owner 일치)의 source_versions 만 허용(형식 오류 400, 그 밖 404, 아무것도 쓰지 않음). `generation_runs.input_version_refs.source_version_ids` 에 정렬해 고정, input_version 문자열에 `;sv:` 가 붙고 provider 에 `allowedSourceRefs` 로 전달. 출처가 있으면 프롬프트에 "허용 출처" 절, prompt_version `t07-assist-v2`(없으면 t06-assist-v1 과 바이트 동일).
  - **claim–source**: 새 표 `claims`(불변 트리거) · `claim_sources`(불변 트리거, owner 복합 FK). assist 성공 시 출력 claim 마다 claims 행(제안 버전·run), 허용 목록 안 출처만 claim_sources(locator = sources.canonical_url). 목록 밖 출처는 `filterClaimSources`(domain 순수 함수)가 버리고 개수(`dropped_source_refs`)·경고(`출처 미확인: …`)·`needs_check=true` 만 남긴다 — output_json 에도 원래 값은 저장하지 않는다. evidence_grade 'user_confirmed'·personal_experience_confirmed 는 claim_confirmations(resolution='confirmed')에서 파생(`listClaimsForRun`), claims 행은 바꾸지 않는다.
  - **비용 예약(A15)**: 새 표 `usage_ledger`(run 당 1행, owner 복합 FK). run 기록 트랜잭션 안에서 원고 잠금 → users 행 잠금 → 이번 달(MSK) 합계(reserved 예약액 + settled 실제액) → `checkBudget` → 초과면 429 `budget_exceeded`(run·원장·버전 없음). 통과하면 reserved 기록, 성공 후 실제 토큰 × 단가로 settled, 실패하면 settled + actual = reserved + failed=true. 가격이 없으면 예약 0·`pricing_snapshot {mode, priced:false}` 로 기록만(한도 검사 없음). 새 config `LLM_BUDGET_CURRENCY`(기본 USD) · `LLM_BUDGET_MONTHLY_LIMIT` · `LLM_BUDGET_PER_RUN_MAX` · `LLM_PRICE_INPUT_PER_1K` · `LLM_PRICE_OUTPUT_PER_1K`(소수 6자리까지 10진 문자열, 기본값 없음) · `LLM_LIVE_APPROVAL_REF`.
  - **live 경계**: `LiveLlmProvider`(providers, 공급자 중립) — HTTP 코드 없음, `assertReady()`·`generate()` 모두 `LiveProviderNotConfiguredError(missing)`. `getLlm()` 은 live 에서 `assertLiveLlmAllowed`(기존) → `new LiveLlmProvider(config).assertReady()` 로 항상 거부(503, 아무것도 쓰지 않음). `liveLlmReadiness(config)` 는 빠진 조건 이름만 반환하고 T07 에서는 `LIVE_ADAPTER(T07 미구현, D8 결정 후)` 가 항상 남아 ready=false. `/api/health` 에 `llm: {mode, live_ready:false, missing[]}`, 설정 화면에 "AI 모드·비용"(이번 달 사용/상한, 가격 설정 여부, live 준비 안 됨 목록).
  - 작성실 패널: claim 마다 근거 등급·출처 locator·"출처 미확인(허용 목록 밖 N건 — 저장하지 않음)"·확인 필요, 실행별 비용(예약·실제·토큰·실패) 표시, assist 폼이 연결된 출처 전체를 `source_version_ids` 로 보냄.
  - `LiveProviderNotConfiguredError` 는 선택 인자 `missing` 을 받고 문구가 "실제 AI 공급자가 구현·승인되어 있지 않습니다…" 로 바뀜(코드는 그대로). `AppErrorKind` 에 `budget_exceeded`(429).
- BASE_SHA: 5af8de7
- HEAD_SHA: bad21ededc1f60ee70abb79d475c4ff8ac243b30
- Clean tracked tree confirmed: 아니오 — 커밋 전 작업 트리(추적 파일 26개 수정 + 신규 6개). `.claude/` 는 무관한 기존 미추적 폴더.
- Relevant acceptance IDs: M2 통과 조건 "동시 AI 호출이 비용 상한을 넘지 않음"(A15), "live 호출은 허용된 API 설정 후 별도 확인", A03(경험 확인 파생), docs/04 "AI 구조화 출력"(source_ref 는 허용 source_version 목록 안에서만).
- Changed files:
  - DB: `packages/db/src/schema.ts`(claims·claim_sources·usage_ledger), `packages/db/drizzle/0008_t07_budget_claims.sql`(drizzle-kit 출력 + claims/claim_sources 추가 전용 트리거), `meta/0008_snapshot.json`, `meta/_journal.json`, `packages/db/src/budget.ts`(신규: 원장·허용 출처·claims 저장/조회), `writing.ts`(prepareAssist/runAssist/getWritingState), `bundle-tables.ts`, `restore.ts`(PARENTS), `index.ts`
  - Domain: `packages/domain/src/budget.ts`(신규: micro 금액·토큰 추정·예약·검사·MSK 월 시작·live 준비 상태·BudgetExceededError), `writing.ts`(source_version_ids·PromptSource·promptVersionFor·filterClaimSources), `config.ts`, `errors.ts`, `bundle.ts`(3개 표, TABLE_INTRODUCED_IN, checkIntegrity), `index.ts`
  - Providers: `packages/providers/src/llm.ts`(LiveLlmProvider, usageOf, 모의 provider 가 허용 출처 첫 항목을 의견 claim 에만 붙임)
  - Web: `apps/web/lib/{server.ts,api.ts,writing.ts}`, `apps/web/app/api/{health,contents/[id]/assist}/route.ts`, `apps/web/app/contents/[id]/{page.tsx,writing-panel.tsx}`, `apps/web/app/settings/page.tsx`
  - Tests: `packages/domain/src/budget.test.ts`(신규 17), `packages/providers/src/llm.test.ts`(+3), `packages/domain/src/{bundle,writing}.test.ts`(픽스처에 빈 표 3개만 추가), `tests/integration/budget-claims.test.ts`(신규 17)
  - Docs: `docs/DECISIONS.md` D13, `README_KO.md` T07 절, `.env.example`(빈 placeholder 만)
- Migrations / restore implications: 0008 은 새 표만 추가(기존 데이터 변경 없음). 새 표 3개는 EXPORTED(순서 claim_confirmations 다음). PARENTS: claims → content_versions·generation_runs(owned), claim_sources → claims(owned)·source_versions, usage_ledger → generation_runs(owned). checkIntegrity: claims 의 버전과 run 이 같은 원고, claim_sources·usage_ledger 참조 존재. 0008 이전 묶음은 새 표를 빈 표로 읽는다(TABLE_INTRODUCED_IN). 실행 중인 dev 서버는 재시작하면 0008 을 자동 적용한다(이 작업에서는 ./data/pglite 에 아무것도 실행하지 않음).
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0, pnpm 12.6.0):
  - 기준선(5af8de7): `pnpm test` 19 files / 303, `pnpm test:integration` 13 files / 155
  - `cd packages/db && pnpm exec drizzle-kit generate --name t07_budget_claims` → 0008 생성(DB 연결 없음), 트리거 2개 수동 추가
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → pass, 20 files / 323 tests
  - `pnpm test:integration` → pass, 14 files / 172 tests
  - `pnpm build` → pass
  - 수동 확인: `DATABASE_URL=memory:// APP_BASE_URL=http://localhost:3100 LLM_PRICE_INPUT_PER_1K=1 LLM_PRICE_OUTPUT_PER_1K=2 LLM_BUDGET_MONTHLY_LIMIT=5 next start -p 3100`(메모리 DB 별도 프로세스)에 curl — 로그인 → 브랜드 → 원고 → assist 폼 303 → 작성실 HTML 에 "비용(USD): 예약 0.750000 · 실제 0.254000 · 토큰 입력 238 · 출력 8(추정)"·근거 등급·확인 필요, 설정 HTML 에 "이번 달(MSK) 사용: 0.254000 USD / 상한 5.000000 USD … live 준비 안 됨: LLM_MODE=live, LLM_PROVIDER, LLM_MODEL, LLM_LIVE_APPROVAL_REF, LIVE_ADAPTER(…)", health JSON 의 `llm` 확인. 확인 후 3100 프로세스 종료. 설정 화면은 서버 컴포넌트라 자동 테스트는 health·`monthlyUsage`·`liveLlmReadiness` 수준(not_run: 설정 화면 자동 렌더 테스트).
- Demo route / local start steps: dev 서버 재시작(0008 적용) → 작성실에서 "모의 제안 만들기" → 실행 아래 비용·claim 근거 확인 → 설정 "AI 모드·비용". 예산 동작을 보려면 `.env.local` 에 `LLM_PRICE_INPUT_PER_1K`·`LLM_PRICE_OUTPUT_PER_1K`·`LLM_BUDGET_MONTHLY_LIMIT`(가상 값)을 넣는다 — 모의에서도 한도가 적용된다.
- External calls performed (exact scope, or none): none. 새 의존성 0, 비밀 0, 과금 0. LiveLlmProvider 에 HTTP 코드 없음.
- Mock-only functionality: 모든 AI 제안·토큰 사용량(글자/3 결정적 추정). 모의 provider 는 출처를 만들지 않고, 허용 목록이 있으면 첫 항목을 의견 claim 에만 붙인다. 만든 출처 처리·동시 예약은 테스트 stub(모의를 감싼 provider)으로 검증했다.
- Known risks / not run:
  - 토큰 추정(글자/3)은 실제 토크나이저가 아니다 — 과소 추정이면 실제 비용이 예약을 넘을 수 있고, 상한은 예약 시점에만 검사한다.
  - 프로세스가 provider 호출 중 죽으면 원장이 reserved 로 남아 이번 달 합계에 계속 잡힌다(정리·released 경로 없음). run 도 running 으로 남는다.
  - 실패한 호출을 예약액 전액 비용으로 본다(보수적 — 사용자 결정 필요, D13 (c)).
  - 모의 모드에서 가격을 설정하면 한도 때문에 모의 제안도 거부된다(의도된 동작이지만 혼동 가능).
  - claim_sources.source_version_id 의 owner 는 DB FK 로 강제되지 않는다(source_versions 에 owner_id 가 없음) — 앱은 허용 목록(owner 범위 join)에서만 넣고, 복원은 PARENTS·묶음 검사에 의존.
  - claims 는 제안 버전에만 저장된다(채택 버전에는 복사하지 않음 — 채택 버전의 ai_run_id 로 run 의 claims 를 찾는다).
  - 기존 한계 유지: 수동 복사 A03 우회(사용자 결정 필요), 'removed' 는 문자열 포함 검사.
  - 설정 화면 자동 렌더 테스트 없음, 브라우저 E2E not_run.
- Questions specifically for Codex:
  1. 예산 경합: 예약은 원고 잠금 → users 행 잠금 → 월 합계 → 기록을 한 트랜잭션에서 한다. 서로 다른 원고에 대한 동시 assist(원고 잠금이 다름)와 PostgreSQL READ COMMITTED 에서도 users 행 잠금만으로 합계가 직렬화되는가? 월 경계(MSK)를 가로지르는 예약·확정, 확정 시 실제액 > 예약액인 경우 상한 검사 누락이 문제인가?
  2. 만든 출처 처리: `filterClaimSources` 가 대소문자·공백만 정규화하고 목록 밖 값을 버린다. 허용 목록 자체가 올바른가(content_captures 에 연결된 소재의 출처만, extraction_state 무관 — 'blocked' 버전도 포함), 버린 출처의 원문이 output_json·감사·응답 어디에도 남지 않는가?
  3. live 우회 경로: `getLlm` 외에 LiveLlmProvider 나 외부 호출에 도달하는 경로(createProviders, worker, 환경변수 조합, `LLM_MOCK_FAIL_NEXT` 같은 테스트 스위치의 운영 노출)가 있는가? 오류 응답·health·설정 화면에 설정 값이 새지 않는가?
  4. 실패 시 원장: 실패 트랜잭션(run failed + ledger settled failed + 감사)이 실패하면 원장이 reserved 로 남는다 — 이 상태가 합계에서 예약액으로 계속 잡히는 것이 docs/02 "미확정 비용·실패 재시도도 예약량에 반영"을 만족하는가? 성공 트랜잭션에서 claims 저장이 실패하면 제안 버전·원장 확정이 함께 롤백되고 run 이 running 으로 남는데 괜찮은가?
  5. 복원: usage_ledger·claims·claim_sources 의 PARENTS 와 checkIntegrity 가 add_missing 에서 run 이 충돌로 빠질 때 claims/원장을 함께 막는가(owned=true)? 복원한 원장 행이 대상 owner 의 이번 달 예산 합계에 들어가는 것(created_at 보존)이 의도에 맞는가?
- Next authorized task: T09(채널별 초안·stale 표시·미디어 완성 여부·배포 파일 export) — 사용자·오케스트레이터 승인 후. live 연결은 D8 결정과 별도 승인 전 금지.

---

# FIX round 1 (Codex review-T07)
- Review: `.handoffs/review-T07.md` (CHANGES_REQUESTED, 5×P1 + 1×P2, review HEAD bad21ed)
- BASE_SHA: f45072f (T09 커밋 위 — T09 의 채널 AI 초안이 같은 예산·claim 코드를 쓰므로 두 경로를 함께 고쳤다)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: `0010_t07_fix_budget.sql`(+ `meta/0010_snapshot.json`, journal idx 10). drizzle-kit 출력 + 수동: CHECK 교체 전에 claims 추가 전용 트리거를 잠시 끄고 'user_confirmed' → 'none' 채움.

| Finding | Change | Test |
| --- | --- | --- |
| P1 writing.ts:564 — 실제액 > 예약액이면 상한 우회 | `LlmGenerateInput.maxOutputTokens`(= 예약의 출력 상한)를 provider 에 전달(원고 assist·채널 AI 초안). 모의는 제안을 상한×3 글자로 자름, LiveLlmProvider 계약에 포함. 확정 시 실제 > 예약이면 `usage_ledger.overage_amount`·`over_budget=true` 기록(자르지 않음), run output_json `over_budget`, 감사 `over_budget`. 확정(성공·실패) 모두 owner 행 잠금 아래. 설정 화면에 통화별 초과 건수·초과액 | integration "P1 예약 초과: … over_budget, 다음 예약 거부, provider 는 maxOutputTokens 를 받는다"; unit llm.test "모의 provider 는 제안을 출력 상한 안으로" |
| P1 budget.ts:42 — 통화 혼합 합산 | `monthlyUsedMicro(…, currency)`·`monthlyCurrencies`, `reserveOrThrow` 가 이번 달 다른 통화가 있으면 409 `budget_currency_mismatch`({configured, found}), `monthlyUsage` 는 통화별 목록, 설정 화면 통화별 표시. 복원 미리보기 `ledger_currency_mismatch` 경고(`budgetCurrency` 옵션 — API·CLI 가 설정 통화를 넘김) | integration "P1 통화: … 409 budget_currency_mismatch(아무것도 쓰지 않음), 사용량은 통화별, 복원 미리보기 경고" |
| P1 writing.ts:541 — 버린 출처 원문 누출 | `@cs/domain sanitizeLlmOutput`: 허용 목록 밖 참조 제거 + 그 문자열(≥4자, 대소문자 무시)을 제안 본문·경고·후속 질문·태그·claim 문장에서 `[출처 미확인 URL 제거]` 로 바꿈. 정제 결과 하나로 제안 버전·output_json·claims 행·`AssistResult.output/claims`·HTTP 응답(원고·채널 초안 모두) | unit "버린 출처 원문이 … 어디에도 남지 않는다"; integration "P1 버린 출처: 같은 가짜 URL 이 source_refs·warnings·proposed_text 에 …"(응답·output_json·제안·claims·result 모두 검사) |
| P1 budget.ts:182 — 복원된 user_confirmed 신뢰 | DB CHECK evidence_grade ∈ {none, source}(0010, 기존 값 none 으로), 묶음 행 스키마도 {none, source} 만 — 'user_confirmed' 묶음은 invalid_rows. 표시는 `listClaimsForRun` 이 claim_confirmations(confirmed)에서만 파생(기존) | unit "묶음의 … user_confirmed 는 거부"; integration "P1 user_confirmed 는 저장되지 않는다(DB CHECK)"; migration "0010: …"; 기존 "경험 claim 을 사용자가 확인하면 … user_confirmed 로 파생" |
| P1 writing-panel.tsx:144 — 51개 이상이면 항상 거부 | 작성실에 출처 체크박스(`sv_<id>`), 최대 50 안내, 기본 선택 = 출처마다 최신 버전(`pickDefaultSources`, 최대 50), 빠진 버전 수 표시. `formToAssist` 가 체크박스 우선, 없으면 기존 쉼표 칸. 서버 상한 50 유지. `allowedSourceVersions` 가 sourceId·fetchedAt 도 반환 | integration "P1 허용 출처 51개 이상: 기본 선택 ≤50, 그 선택으로 요청 성공(폼 체크박스 포함)"(전부 보내면 400 도 확인) |
| P2 domain/budget.ts:20 — numeric(18,6) 정밀도 | 금액 bigint micro(`toMicro`/`fromMicro`/`costMicro`/`checkBudget`/정책·예약 필드), numeric(18,6) 범위·형식 밖은 `AmountRangeError`, 저장 전 `isStorableMicro` 검사, 곱셈·올림 나눗셈 bigint | unit "Codex 경계값 9007199254.740993 를 정확히 왕복", "numeric(18,6) 최대값까지 허용…", "가격 × 토큰 곱을 … 올림" |

- 기존 테스트 변경(약화 없음): bigint 로 바뀐 반환 타입에 맞춰 `budget.test.ts`·`budget-claims.test.ts` 의 숫자 리터럴을 bigint 로, `monthlyUsage` 결과를 통화별 목록으로 읽도록 바꿈(단언 내용 동일 + 통화 단언 추가).
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(f45072f): `pnpm test` 21 files / 348, `pnpm test:integration` 15 files / 185
  - `cd packages/db && pnpm exec drizzle-kit generate --name t07_fix_budget` → 0010(DB 연결 없음), SQL 수동 수정
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → 21 files / 354 tests pass
  - `pnpm test:integration` → 15 files / 191 tests pass
  - `pnpm build` → pass
- Known risks (추가):
  - 초과 기록은 사후 기록이다 — provider 가 상한을 어기면 그 한 건은 월 상한을 넘을 수 있다(이후 예약은 거부). live 어댑터(D8 이후)가 `maxOutputTokens` 를 실제 요청에 넣는지는 어댑터 구현 때 검증해야 한다.
  - 통화 불일치 거부는 가격 미설정(모의 0 기록)에도 적용된다 — 통화 설정을 바꾸면 그 달의 모의 제안도 거부된다.
  - 정제는 문자열 일치(4자 미만 참조는 본문에서 찾지 않음)이며 URL 의 변형(인코딩·단축)은 잡지 못한다.
  - 이전 달 예약을 다음 달에 확정하면 created_at 기준이라 이전 달 합계에 남는다(Codex 답변 1 — 정책 확인 필요).
- Questions specifically for Codex (FIX round 1):
  1. 초과 처리: "최대 비용 예약 + maxOutputTokens + 사후 overage 기록 + 다음 예약 거부"가 A15("상한을 초과하는 신규 호출 차단")를 충족하는가, 아니면 초과가 난 run 의 제안 자체를 막아야(버전 저장 거부) 하는가? 성공 확정 트랜잭션에서 owner 잠금(원고 잠금 뒤)이 다른 경로와 교착을 만들 수 있는가?
  2. 통화: 이번 달 원장에 다른 통화가 있으면 가격 설정과 무관하게 거부하는 규칙과, 복원은 허용하되 경고만 하는 규칙의 조합이 우회(예: 복원으로 다른 통화 원장을 들여와 사용자가 스스로 막히는 것 외의 문제) 없이 일관적인가?
  3. 출력 정제: `sanitizeLlmOutput` 의 재등장 검사(대소문자 무시 부분 문자열, 4자 이상, 긴 것부터)가 버린 참조 원문을 제안·경고·claim 문장·태그·후속 질문·응답·채널 초안 메타데이터(channelDraft 는 정제된 proposed_text 에서 만든다)에서 모두 제거하는가? 짧은 참조(<4자)를 남기는 것이 문제인가?

---

# FIX round 2 (Codex review-FIX-T07)
- Review: `.handoffs/review-FIX-T07.md` (CHANGES_REQUESTED, 1×P1 + 2×P2)
- BASE_SHA: 55941e8 (T09 FIX 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: 없음.

| Finding | Change | Test |
| --- | --- | --- |
| P1 domain/writing.ts:337 — 정제가 source_refs 의 4자 이상 문자열에만 의존 | `sanitizeLlmOutput(output, allowed: {id, locator}[])` 재작성: 본문·경고·후속 질문·태그·claim 문장에서 URL(https?://, www.)·[출처…] 인용을 찾아 허용 locator(정규화: 대소문자·끝 문장부호·끝 슬래시·scheme·www 무시)나 허용 id 로 풀리지 않으면 '[출처 미확인 URL 제거]' + "확인 필요" 경고 + 바뀐 claim needs_check. [n] 은 1..허용 수(프롬프트 번호)만 허용, 아니면 `UnverifiableCitationError`. 버린 source_refs 중 4자 미만([n] 모양 제외)이 글에 남아도 같은 오류. 정제를 provider 호출 try 안으로 옮겨 실패 시 run failed·error `unverifiable_citation`·제안 없음·502 llm_failed(원고 assist·채널 초안 모두). 원고 assist 는 허용 출처의 locator 를 함께 넘김 | unit writing.test 4개(재현 1·2, [n] 범위, 허용 locator/id 유지); integration "P1 원고: [1] 인용 … unverifiable_citation, 제안 없음, 본문 그대로", "P1 원고: 가짜 URL 이 본문·경고에만 …", "P1 채널 초안: 같은 두 입력 …" |
| P2 budget.ts:189 — 합계에 행 범위 적용 | SQL 합계에서 `::numeric(18,6)` 캐스트 제거(제한 없는 numeric), JS 는 `sumToMicro`(자릿수 제한 없는 bigint micro). 행 저장·예약·확정은 기존 `toMicro`·`isStorableMicro` 범위 검사 유지 | unit "합계는 행 범위를 넘어도 정확히 읽는다"; integration "P2 합계: 600000000000.000000 두 행 … 예약 검사도 답한다(429)" |
| P2 budget.ts:68 — 월 조회 상한 없음 | `mskNextMonthStart` 추가, `monthlyUsedMicro`·`monthlyCurrencies`·`monthlyUsage` 모두 `created_at >= 월 시작 AND created_at < 다음 달 시작`(MSK) | unit "다음 달 시작(MSK)"; integration "P2 월 상한: 다음 달 created_at 의 RUB 원장은 이번 달 USD 예약·사용량에 영향이 없다" |

- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(55941e8): `pnpm test` 21 files / 357, `pnpm test:integration` 15 files / 200
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → 21 files / 363 tests pass
  - `pnpm test:integration` → 15 files / 205 tests pass
  - `pnpm build` → pass
- Known risks (추가):
  - 사용자 원문(원고 본문·인터뷰 답변)에 있던 URL·[n] 도 AI 제안에서는 허용 출처가 아니면 빠지거나(URL) 실행이 실패한다([n], 허용 출처 수를 넘을 때). 모의 제안은 원문 문장을 되풀이하므로 원문에 `[3]` 같은 표기가 있으면 모의 제안도 실패할 수 있다.
  - 버린 4자 미만 참조(예: '1')가 글 어디에든 나오면 실패로 본다 — 보수적이라 거짓 실패가 날 수 있다.
  - URL 탐지는 https?:// 와 www. 로 시작하는 것만 — 맨 도메인(example.com/x)·인코딩된 URL 은 잡지 않는다.
- Questions specifically for Codex (FIX round 2):
  1. 정제 규칙이 docs/04("그럴듯한 URL 을 모델이 생성하면 확인 전 채택하지 않는다")를 충분히 충족하는가 — 맨 도메인·[출처 없이 쓴 서지]·각주 기호(※1, ¹) 등 남는 인용 형태가 있는가? [n] 을 프롬프트 번호로 푸는 규칙(허용 출처 id 정렬 순서)이 프롬프트의 실제 번호 표시와 어긋날 여지는?
  2. 실패 처리: 정제 실패를 provider 실패와 같은 경로(run failed·원장 예약액 전액 확정·502)로 보내는 것이 맞는가, 아니면 비용은 실제 사용량으로 확정해야 하는가(호출은 성공했으므로)?
  3. 월 창·합계: `created_at` 기준 귀속과 상한(미만) 조건이 서머타임 없는 MSK 가정에서 경계(월말 23:59:59.999999 MSK)를 올바르게 처리하는가? 제한 없는 numeric 합이 PostgreSQL(M3)에서도 PGlite 와 같은 문자열 형식(지수 표기 없음)을 돌려주는가?

---

# FIX round 3 (Codex review-FIX2-T07)
- Review: `.handoffs/review-FIX2-T07.md` (CHANGES_REQUESTED, 3×P1 + 2×P2 — 모두 `sanitizeLlmOutput`)
- BASE_SHA: e7a14f2 (T09 FIX round 2 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: 없음. 변경 파일: `packages/domain/src/writing.ts`(정제 재작성, `canonicalCitationUrl` 추가, `MIN_REDACT_LENGTH`·`escapeRe` 제거), 테스트, `docs/DECISIONS.md` D13.

설계(정규식 덧대기 대신 인용 문법): 한 번의 스캔(`CITATION_RE`)으로 `[출처…]` → `[n]` → URL → `www.` → 맨 도메인 순서의 토큰만 찾고, 각 토큰을 전체 값으로 판정한다. 허용 출처는 `{id, locator}` 를 한 번 정규형(`normalizeUrl().normalized`)으로 바꿔 둔다.

| Finding | Change | Test |
| --- | --- | --- |
| P1 :388 — 허용 id 를 포함한 무관한 URL 통과 | 부분 문자열 비교 제거. URL 은 허용 locator 정규형과 동등할 때만, UUID 는 `[출처: <UUID>]` 에서 꺼낸 값이 허용 id 와 같을 때만 | unit "재현 1"; integration "원고: 허용 id 를 담은 가짜 URL …" |
| P1 :348 — URL 전체 소문자화로 다른 자료 동일시 | `normalizeUrl` 정규형(scheme·host 만 소문자, 경로·쿼리 대소문자 유지, 기본 포트·fragment·utm 등 제거). scheme·www 별칭 없음 | unit "재현 2", "추적 파라미터 … www·scheme 이 다르면 …" |
| P1 :340 — 맨 도메인 우회 | 맨 도메인 문법(점 + 영문 TLD 2~24자, 앞이 단어·@·.·/·: 가 아닐 것, 흔한 파일 확장자 제외) 추가 — 풀리지 않으면 제거·경고 | unit "재현 3"(README.md·3.14·이메일은 그대로); integration 원고·채널 경로 |
| P2 :410 — 허용 `[출처: URL]` 삭제 | `[출처…]` 는 괄호 안 값(URL·UUID)을 꺼내 비교, 허용이면 괄호째 보존 | unit "재현 4"(허용 URL·허용 UUID 보존, 다른 URL·자유 문구·다른 UUID 제거); integration 원고 경로 |
| P2 :380 — `[10]` 이상이 번호 검사 전에 삭제 | 숫자 인용은 길이와 무관하게 번호 규칙으로만(1..허용 수 보존, 밖이면 `unverifiable_citation`). "버린 4자 이상 참조 치환"·"4자 미만 휴리스틱" 제거 | unit "재현 5"([10] 보존, [99]·[11] 실패); integration 원고 [10] 보존·[99] 실패, 채널 [1] 실패 |

- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(e7a14f2): `pnpm test` 22 files / 368, `pnpm test:integration` 15 files / 207
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → 22 files / 374 tests pass
  - `pnpm test:integration` → 15 files / 209 tests pass
  - `pnpm build` → pass
- Known risks (추가·갱신):
  - source_refs 에만 있던 자유 문구(URL·UUID·[n] 이 아닌 서지 제목 등)는 이제 본문에서 찾아 지우지 않는다(부분 문자열 비교 금지 원칙). 그런 인용 형태는 문법 밖이라 탐지되지 않는다.
  - 맨 도메인 문법은 보수적이다: `.md` `.ts` 같은 파일 확장자로 끝나는 이름은 그대로 두고, 그 밖의 `word.word` 형태(예: 영문 약어 뒤 단어)는 URL 로 보아 지울 수 있다(거짓 양성).
  - http↔https·www 별칭을 두지 않으므로, 허용 locator 와 scheme 이 다른 같은 문서 링크도 제거된다(보수적).
- Questions specifically for Codex (FIX round 3):
  1. 인용 문법과 판정 순서(`[출처…]` 가 먼저 소비되어 안의 URL 이 따로 다시 검사되지 않음, URL 토큰 끝 문장부호 분리)가 허용 출처를 가장한 우회(예: `[출처: https://example.com/report]https://fake`, 괄호 안 공백·전각 콜론, IDN·퍼니코드 호스트)를 모두 막는가?
  2. 맨 도메인 탐지(앞 문자 조건·TLD 형태·파일 확장자 예외)가 한국어 본문에서 놓치는 형태(전각 마침표 `．`, 괄호 안 도메인 `(fake.example)`)나 과도한 거짓 양성을 낳는가?
  3. `normalizeUrl` 정규형(추적 파라미터 제거·파라미터 정렬·끝 슬래시 제거)이 "같은 자료"라는 판정에 충분히 보수적인가 — 파라미터 순서만 다른 URL 을 같다고 보는 것이 문제인가?

---

# FIX round 4 (Codex review-FIX3-T07)
- Review: `.handoffs/review-FIX3-T07.md` (CHANGES_REQUESTED, 3×P1 — 자유문 URL 허용 검사 우회)
- BASE_SHA: d8a8f81 (T08 f147847 + 잠금 테스트 조정 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: 없음. 변경 파일: `packages/domain/src/writing.ts`(sanitizeLlmOutput 재작성 — 탐지 전용 `hasFreeTextCitation`, `citationIds`/`citationLabel`, `canonicalCitationUrl`·`DROPPED_REF_MARKER`·`AllowedRef`·`normalizeUrl` 의존 제거, 프롬프트 t07-assist-v3), `packages/db/src/{writing,variants}.ts`(호출·주석), `apps/web/app/contents/[id]/writing-panel.tsx`(도움말·"[출처 n]" 표시), 테스트, `docs/DECISIONS.md` D13.

설계: 정규식 경쟁을 멈추고 **구조화 인용만**(source_refs 의 허용 id, 범위 안 `[n]`). 글(본문·경고·질문·태그·claim 문장)은 NFKC 뒤 넓게 **탐지만** 한다 — `://`, `www.`, `//host`, `[출처…]`, 호스트 모양 토큰(`.`/`。`/전각 `．`·`｡` 구분, 영문 2–24자 TLD), 버린 source_refs 문구, 범위 밖 `[n]` → 하나라도 있으면 출력 전체 `unverifiable_citation`(run failed, 제안·claims 없음, 본문 그대로, 502). URL 을 허용 목록과 비교하지 않는다(허용 URL 도 자유문이면 실패).

| Finding | Change | Test |
| --- | --- | --- |
| P1 :354 접두 일치(포트·쿼리·괄호) | URL 비교 자체를 없앰 — 호스트 모양이 보이면 실패 | unit "라운드 2–3 우회 문자열은 모두 실패"(`example.com?doc=x`, `example.com:8443/report`, `https://example.com/report(other)` …, 허용 출처 있을 때·없을 때); integration 원고·채널 |
| P1 :354 `출처:fake.example`·`//host`·전각 마침표 | 앞 문자 조건을 `@ . 문자 숫자 _ -` 만 제외로 넓힘(콜론 뒤 허용), 프로토콜 상대 `//` 탐지, NFKC + `。` 구분자 | unit 같은 describe(`출처:`/`출처：`, `//fake.example/report`, `fake．example`, `fake｡example`, 전각 WWW); integration 원고·채널 |
| P1 :398 버린 자유문 참조가 본문에 남음 | 허용 id 가 아닌 source_refs 문구(NFKC·소문자, 범위 안 `[n]` 표기 제외)가 어느 글에든 있으면 실패. 글에 없으면 기존처럼 버리고 개수·경고 | unit "버린 자유문 참조(가공연구소 2025 보고서)…"; integration 원고·채널 |

- 오탐 확인(통과): `README.md`, `CHANGELOG.md`, `3.14`, `v24.21.0`, 이메일, 한국어 문장, `budget.ts`·`report.pdf`·`data.csv`, `1.5배`, `[1]`·`[10]`(허용 10개). 알려진 보수성(실패로 고정한 테스트): `notes.md/report`, `report.pdf:8080/x`, 소문자 `fake.md`, `React.Component`.
- 모의 provider: 기존 출력에 URL 모양 글이 없음을 통합 테스트로 확인(출처가 있어도 성공). 모의는 자료의 앞 문장을 claim 으로 쓰므로 본문에 URL 이 있으면 실패한다(D13 트레이드오프, 사용자 결정 필요).
- 기존 테스트 변경: "가짜 URL·[출처…] 를 지우거나 허용 URL 을 보존" 을 기대하던 단위(FIX-T07 첫 정제 테스트, round 2 describe 의 3개, round 3 describe 6개 → round 4 describe 7개)·통합(원고·채널 "가짜 URL 제거" 2개, round 3 describe 2개 → round 4 describe 3개)은 새 규칙(출력 전체 실패)으로 바꿨다. 실패 경로의 단언(run failed·버전·claims 0·본문 그대로)은 더 강하게 했고, "source_refs 에만 있는 가짜 URL 은 버리고 어디에도 남지 않음" 단언은 유지했다. 프롬프트 버전 단언 t07-assist-v2 → v3.
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(d8a8f81): `pnpm test` 25 files / 398, `pnpm test:integration` 16 files / 233
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → pass, 25 files / 399 tests
  - `pnpm test:integration` → pass, 16 files / 234 tests
  - `pnpm build` → pass
- Known risks:
  - 탐지 누락 가능: 공백을 넣은 도메인(`fake . example`), 점 대신 다른 기호(`fake[.]example`, `fake dot example`), 영문이 아닌 TLD만 쓴 IDN(`예시.한국`), 퍼니코드 없이 설명만 한 출처("가공연구소 보고서" 를 source_refs 에 넣지 않고 글에만 쓴 경우 — 서지 제목 일반은 탐지하지 않음), 버린 참조의 변형(공백·조사 차이).
  - 오탐: "단어.영문" 표기·소문자 파일명 `.md`·사용자 본문의 URL(모의도 실패). 실패는 비용(예약액 확정)을 남긴다.
- Questions specifically for Codex (FIX round 4):
  1. 남은 탐지 누락: 위 목록 외에 NFKC 뒤에도 호스트·URL 로 읽히지만 `hasFreeTextCitation` 을 통과하는 형태(다른 유니코드 마침표·제로폭 문자·라벨 사이 공백, 퍼니코드 `xn--`, IP 주소 `203.0.113.5/report`)가 있는가? 서지 제목만 쓴 자유문 인용은 구조적으로 막을 수 없다는 한계를 받아들여도 되는가?
  2. 오탐률: 호스트 모양 규칙(영문 2–24자 TLD, 파일 확장자·대문자 .md 예외)이 한국어 비즈니스 글(제품명 `Node.js`, 약어 `U.S.`, 버전 `v1.2.3`, 회사명 `Amazon.com`)에서 실패를 얼마나 낳는가 — 예외를 더 좁히거나 넓혀야 하는가?
  3. 입력에서 URL 빼기: 사용자 본문·답변·출처 요약에 URL 이 있으면 모의(그리고 앞으로 live)가 그대로 옮겨 실패할 수 있다. 프롬프트 입력에서 URL 을 "[출처 n]"/제거로 바꿔 넣는 것이 안전한가, 아니면 실패로 두고 사용자에게 알리는 현재 방식이 맞는가?

---

# FIX round 5 (Codex review-FIX4-T07)
- Review: `.handoffs/review-FIX4-T07.md` (CHANGES_REQUESTED, 2×P1 + 1×P2, review HEAD 9c09ea0)
- BASE_SHA: a35b208 (T08 FIX 725b5cd + 잠금 테스트 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: 없음. 변경 파일: `packages/domain/src/writing.ts`(탐지 정규식), `apps/web/app/contents/[id]/writing-panel.tsx`(안내·미검증 표시), `packages/domain/src/writing.test.ts`, `tests/integration/budget-claims.test.ts`, `docs/DECISIONS.md` D13. `lock.test.ts`·`lock-race-child.ts` 는 건드리지 않음.

| Finding | Change | Test |
| --- | --- | --- |
| P1 :353 IP·퍼니코드 TLD·한국어 조사 | `IPV4`(점 네 묶음)·`IPV6`(괄호, 콜론 둘 이상) 탐지; TLD = 영문 시작 + 영문·숫자·하이픈(xn--…); TLD 뒤 경계 `(?![a-z0-9-])`(한국어·기타 문자 허용) | unit "FIX round 5: IP 주소·퍼니코드/숫자·하이픈 TLD·한국어 조사…"(11개 문자열, 허용 출처 있을 때·없을 때) + 통과 유지(`[1]`, `v24.21.0`, `3.14`); integration 원고·채널 BYPASSES 에 `203.0.113.5/report`, `example.xn--p1ai/report`, `fake.example에 따르면`, `FAKE.md` 추가 |
| P1 :373 대문자 .md 예외 | 예외 삭제 — 대소문자 기반 예외 없음 | unit "알려진 보수성"에 `FAKE.md 참고`·`README.md 를 보세요` 실패 추가; "오탐 없음"에서 README.md·CHANGELOG.md·AGENTS.md 통과 단언 삭제(대문자 `BUDGET.TS`·`Report.PDF` 통과로 대체 — 실제 TLD 아닌 확장자만 허용, 대소문자 무관); integration 통과 예시의 README.md → budget.ts |
| P2 panel:181 안내 과장 | 자동 거부 범위(URL·도메인·IP, 범위 밖 번호, 버린 source_refs 문구)와 "일반 문헌 제목은 자동 검증 안 됨" 명시, 출처 없는 needs_check 주장에 "출처 미검증 · 사용자 확인 필요" | (UI 문구 — 수동 확인 not_run) |

- 삭제한 테스트 단언: README.md·CHANGELOG.md·AGENTS.md 가 통과한다는 단언 3개(사용자 지시 — 대문자 예외 제거의 결과로 이제 실패가 맞다). 나머지 단언은 그대로 또는 강화.
- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(a35b208): `pnpm test` 26 files / 406, `pnpm test:integration` 16 files / 241
  - `pnpm lint` → pass / `pnpm typecheck` → pass
  - `pnpm test` → pass, 26 files / 407 tests
  - `pnpm test:integration` → pass, 16 files / 241 tests(기존 테스트 안의 우회 목록에 4개 추가 — 테스트 수는 같음)
  - `pnpm build` → pass
- Known risks: 점 네 묶음 버전(`1.2.3.4`)·`README.md`·"단어.영문" 은 실패(오탐). 공백·`[.]`·"dot" 으로 쓴 도메인, 영문 TLD 없는 순수 한글 도메인(`예시.한국`), 일반 서지 제목은 여전히 탐지하지 않는다(화면에 미검증으로 표시).
- Questions specifically for Codex (FIX round 5):
  1. TLD 경계를 ASCII 기준으로 바꾼 뒤에도 NFKC 후 호스트로 읽히는데 통과하는 형태(예: 라벨 사이 제로폭 문자, `fake.ex\u00ADample`, 숫자만인 TLD 를 가진 사설 호스트)가 남는가?
  2. IPv4 규칙(점 네 묶음 전부 거부)이 버전·계좌번호류 표기에서 받아들일 수 없는 오탐을 내는가 — 0–255 범위 검사를 넣어야 하는가?

---

# FIX round 6 (Codex review-FIX5-T07)
- Review: `.handoffs/review-FIX5-T07.md` (CHANGES_REQUESTED, 1×P1 + 1×P2)
- BASE_SHA: 5bf7daa (T08 FIX round 2 커밋 위)
- HEAD_SHA: TBD (orchestrator commits)
- Migration: 없음. 변경 파일: `packages/domain/src/writing.ts`(탐지 전처리·IPv6 영역 ID), `packages/domain/src/writing.test.ts`, `tests/integration/budget-claims.test.ts`, `docs/DECISIONS.md` D13. 잠금 테스트 파일은 건드리지 않음.

| Finding | Change | Test |
| --- | --- | --- |
| P1 :371 보이지 않는 문자로 호스트 탐지 우회 | 탐지용 정규화 = `\p{Cf}` 제거 → NFKC → 다시 `\p{Cf}` 제거(모든 탐지 — URL·호스트·IP·[n]·버린 참조 문구 — 가 이 문자열 사용). 원문은 그대로 | unit "FIX round 6 …"(ZWSP·소프트 하이픈·URL 안 ZWJ·단어 결합자·ZWNJ·방향 제어·BOM, 허용 출처 있을 때·없을 때; 서식 문자가 섞인 평범한 글·`[\u200B1]` 통과, `[\u200B9]` 실패); integration 원고·채널 BYPASSES 에 `fake\u200B.example/report`·`fake.e\u00ADxample/report`·`https:/\u200D/fake.example/report` 추가(source_refs 비움) |
| P2 :359 영역 ID 가 있는 괄호 IPv6 | `[…:…:…(%(25)?zone)]` 허용 | unit·integration 에 `[fe80::1%25eth0]:8080/report`, `[fe80::1%eth0]/x` |

- Actual commands and results (Windows 10, Git Bash, `source tools/env.sh`, Node v24.21.0):
  - 기준선(5bf7daa): `pnpm test` 26 files / 409, `pnpm test:integration` 16 files / 244
  - `pnpm lint` → pass(처음 한 번은 주석 안의 실제 제로폭 문자로 no-irregular-whitespace 실패 → 주석 문구 교체, 테스트 문자열은 \uXXXX 이스케이프로) / `pnpm typecheck` → pass
  - `pnpm test` → 1회차 26 files / 1 failed | 409 passed — 실패는 `packages/db/src/lock.test.ts` "죽은 잠금을 여러 프로세스가 동시에 회수…"(Windows EPERM, 이번 변경과 무관·건드리지 않음). 곧바로 두 번 다시 실행 → 둘 다 pass, 26 files / 410 tests
  - `pnpm test:integration` → pass, 16 files / 244 tests(기존 테스트의 우회 목록에 5개 추가)
  - `pnpm build` → pass
- Questions specifically for Codex (FIX round 6):
  1. Cf 제거 + NFKC 뒤에도 남는 우회(예: Cf 가 아닌 결합 문자·변형 선택자 U+FE0F·한자 호환 마침표 외의 유사 마침표 `․` U+2024·`﹒` U+FE52 — 이 둘은 NFKC 로 '.' 이 되는가)가 있는가?

---

# FIX round 7 (Codex review-FIX6-T07)
- Review: `.handoffs/review-FIX6-T07.md` (P1 1건 — Cf 가 아닌 무시 가능 문자로 탐지 우회)
- BASE_SHA: d93b864 — HEAD_SHA: TBD (orchestrator commits). Migration 없음.
- Change: `packages/domain/src/writing.ts` 탐지 전처리 문자 집합 = `\p{Cf}` + Default_Ignorable_Code_Point 명시 범위(U+00AD, U+034F, U+061C, U+115F–1160, U+17B4–17B5, U+180B–180F, U+200B–200F, U+202A–202E, U+2060–206F, U+3164, U+FE00–FE0F, U+FEFF, U+FFA0, U+FFF0–FFF8, U+1BCA0–1BCA3, U+1D173–1D17A, U+E0000–E0FFF). `\p{Mn}` 전체는 지우지 않는다(결합 발음 부호 보존). 모든 인용 검사(URL·호스트·IP·[n]·버린 참조 문구)가 같은 전처리를 쓴다. 코드·테스트 파일의 보이지 않는 문자는 모두 `\uXXXX` 이스케이프로 적었다.
- Tests: unit "FIX round 7 …"(`fake.\uFE0Fexample/report`·`fake\u034F.example/report`·한글 채움 문자·태그 문자·`www\uFE0F.`, 허용 출처 있을 때·없을 때; `보고서[\u034F9]` 실패; `cafe\u0301` 한국어 문장·`보고서[\uFE0F1]` 통과). integration: 원고·채널 BYPASSES 에 `fake.\uFE0Fexample/report`·`보고서[\u034F99]`(원고 경로는 허용 10개라 범위 밖 번호) 추가, 새 테스트 "허용 출처가 없고 source_refs 도 비면 `[\u034F9]`·`fake.\uFE0Fexample` 은 원고·채널 모두 실패, `[\uFE0F1]`+결합 부호는 허용 1개면 통과".
- Actual commands and results (`source tools/env.sh`): `pnpm lint` pass(첫 시도는 한 문자 클래스에 결합 문자 범위를 섞어 no-misleading-character-class 3건 → 결합 문자 범위를 각자의 클래스로 분리); `pnpm typecheck` pass; `pnpm test` 1회차 1 failed | 410 passed — `packages/db/src/lock.test.ts` "죽은 잠금을 여러 프로세스가 동시에 회수…"가 **open 단계의 Windows EPERM** 으로 실패(2dd392d 의 rmQuiet 는 rm 단계만 다룸 — 이번 변경과 무관, 잠금 파일은 건드리지 않음), 곧바로 두 번 재실행 → 둘 다 26 files / 411 pass; `pnpm test:integration` 16 files / 246 pass; `pnpm build` pass.
- Question for Codex: 명시 범위 밖에서 NFKC 뒤에도 남아 호스트·번호를 끊는 비가시 문자(예: 다른 Mn, 스킨톤 수정자 U+1F3FB–1F3FF)가 있는가?
