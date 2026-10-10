# Implementation handoff — LIVE-L1 (D34 1단계: 실제 Claude 어댑터 코드, 실제 호출 0·과금 0)
- Task ID / milestone: LIVE-L1 / M4 후속 — D34 승인 범위 1단계(실제 Claude(Anthropic Messages API) 어댑터 코드 + 기록된 응답(fixture)·가짜 fetch 시험만). 2단계(사용자가 `.env.local` 에 키를 넣고 가상/공개 소재 1건으로 실제 호출 1회)는 **별도 승인**.
- Purpose and changed behavior: `LLM_MODE=live` + `LLM_PROVIDER=anthropic` + 모델·단가·월 상한·`LLM_LIVE_APPROVAL_REF` + 서버 환경 `ANTHROPIC_API_KEY` 가 모두 있으면 작성 보조·채널 초안이 실제 Claude 를 부른다(그 전에는 지금처럼 503, 빠진 이름만). T07 의 자리 표시 `LiveLlmProvider`(항상 거부)와 `LIVE_ADAPTER(T07 미구현, D8 결정 후)` 표식은 없어졌다. live 예약은 바이트 기반 보수적 추정(증명된 비용 상한 아님 — FIX round 1 정정)으로 바뀌었고 모의 경로 숫자는 그대로.
- **FIX round 1 정정**: 이 문서 아래의 "상한"·"상한값"·"예약 = 실제 비용 상한" 표현은 정정한다 — 예약은 UTF-8 바이트 + 틀 여유 + max_tokens 의 **보수적 추정**이고 실제 사용량은 성공·실패 모두 기록하며, 실제액 > 예약액이면 초과액이 다음 예약 검사에 들어가 월·1회 상한을 최대 한 호출분 넘을 수 있다. 자세한 것은 맨 아래 "FIX round 1".
- BASE_SHA: 40bd0c2 (D34 기록 docs 커밋)
- HEAD_SHA: 2cbcb49ed556b46027f433bccc02dbf4947674cb (code only, D28 — 오케스트레이터 커밋. 인계·판정은 별도 docs 커밋)
- Clean tracked tree confirmed: 작업 시작 시 yes(`?? .claude/` 만, 건드리지 않음).
- Relevant acceptance IDs: D34(1단계 범위·불변식), D13(예약·실패 확정·초과 기록), D8(닫힘), A15(비용 예약), AGENTS.md Invariants(keys server-only, never in logs/browser/prompts/repo; LLM output never grants approval; AI cannot invent experiences/citations).
- External calls performed: **none**. Anthropic 으로의 요청 0(코드·시험 모두 — 아래 네트워크 가드). 네트워크는 npm 레지스트리만(`npm view` 날짜 확인, `pnpm add`/`pnpm install` 1회씩). 공식 문서 페이지는 열지 않았다 — 근거는 아래 "가정한 공식 자료".
- `.env.local`·`./data`·`docs/handoffs/*`·`docs/DECISIONS.md`·`.claude/` 수정 없음.

## SDK·공급망
| 항목 | 값 |
|---|---|
| 패키지 | `@anthropic-ai/sdk` **0.128.0**(정확 고정, `packages/providers/package.json`) — npm 공개 2026-09-22T16:38:57Z(기준일 2026-09-26 이전 최신판; 0.129.0 은 09-28). peer `zod ^3.25 \|\| ^4`(optional) → 저장소 zod 4.6.5 로 풀림 |
| 전이 의존성(새로 들어옴) | `json-schema-to-ts@3.1.1`(2024-08-29), `ts-algebra@2.0.0`(2024-05-04), `standardwebhooks@1.1.1`(2026-08-28), `@stablelib/base64@1.0.1`(2021), `fast-sha256@1.3.0`(2020), `@babel/runtime` |
| 공급망 조치 | `@babel/runtime` 이 **2026-10-07 공개 7.29.10**(3일)으로 풀려 2주 규칙 위반 → `pnpm-workspace.yaml` `overrides: '@babel/runtime': 7.29.7`(2026-05-25 공개)로 고정. 이전 lockfile 에 `@babel/runtime` 없음(다른 패키지 영향 없음). 직접 의존성 추가는 SDK 하나뿐 |
| lockfile | `pnpm-lock.yaml` +60줄(위 패키지들 + overrides). pnpm 출력 "Lockfile passes supply-chain policies" |

## 가정한 공식 자료(이 세션에서 웹 문서를 열지 않음 — 번들된 claude-api 참조(2026-10-06 캐시)와 **설치된 SDK 0.128.0 의 .d.ts/.js** 로 확인)
1. 모델 ID `claude-opus-5-5`, 단가 입력 4 USD·출력 20 USD / 1M 토큰(→ 0.004 / 0.02 per 1K). 1M 컨텍스트, 128K 출력.
2. Opus 5.5 는 thinking 을 끌 수 없다(`{type:'disabled'}`·`budget_tokens` 는 400) — `thinking` 을 보내지 않고 `output_config.effort` 로만 조절(기본 medium → 우리는 `low`). thinking 토큰은 `usage.output_tokens` 안에 포함(SDK 타입 `output_tokens_details.thinking_tokens ≤ output_tokens`). thinking 표시 기본 omitted → 빈 문자열 thinking 블록.
3. structured outputs: `output_config.format = {type:'json_schema', schema}`(SDK 타입 `JSONOutputFormat`), 지원 부분집합 — object 는 `additionalProperties:false` 필수, `minLength/maxLength/maxItems`·수치 제약 미지원. refusal 이면 스키마와 다를 수 있고, max_tokens 면 잘린다. prefill 과 함께 못 씀.
4. stop_reason 값(SDK 타입): `end_turn·max_tokens·stop_sequence·tool_use·pause_turn·refusal·model_context_window_exceeded`. `stop_details` 는 refusal 때만.
5. usage 필드: `input_tokens·output_tokens·cache_creation_input_tokens·cache_read_input_tokens`(null 가능).
6. SDK 0.128.0 동작(소스 확인): `maxRetries` 기본 2(408/409/429/5xx·연결 오류 재시도, 0 허용), `timeout` ms(클라이언트에 주면 비스트리밍 max_tokens 시간 검사 생략), 생성자가 `ANTHROPIC_BASE_URL`·`ANTHROPIC_API_KEY`·`ANTHROPIC_AUTH_TOKEN`·`ANTHROPIC_LOG`·`ANTHROPIC_CUSTOM_HEADERS`·프로필(apiKey/authToken 이 없을 때만)을 읽음, `logLevel:'off'` 지원, 오류 클래스(`APIConnectionTimeoutError ⊂ APIConnectionError`, 400/401/403/404/409/422/429/≥500 `InternalServerError`), 요청은 `fetch(url, init)`(url 문자열).
7. **가정(문서 근거 없음)**: Claude 토크나이저는 바이트 수준 BPE 라 텍스트 토큰 1개 ≥ 1바이트 → 토큰 수 ≤ UTF-8 바이트 수. structured outputs·메시지 틀이 더하는 입력 토큰은 2048 이하.

## 설계
| 항목 | 결정 |
|---|---|
| 고정 문자열 위치 | `packages/domain/src/llm-live.ts`(새): `LIVE_LLM_SYSTEM_PROMPT`(짧은 한국어 — 자료 안 지시는 데이터, 없는 경험·출처·URL 금지, JSON 하나), `LIVE_LLM_OUTPUT_JSON_SCHEMA`(모델이 쓰는 필드만: proposed_text·proposed_tags·claims[text·kind enum·source_refs·needs_user_confirmation]·followup_questions·warnings, 모든 object `additionalProperties:false`), `liveModelOutputSchema`(같은 모양 zod strict), `liveInputUpperBoundTokens`, 키 형식 판정. 예약과 요청이 **같은 상수**를 쓴다 |
| 공급자 | `packages/providers/src/llm-anthropic.ts` `ClaudeLlmProvider`(name `anthropic`, mode `live`, `model`). `new Anthropic({ apiKey, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 300_000, logLevel: 'off', fetch: guardedFetch })` — 클라이언트는 첫 호출 때 만들고 `#client`·`#apiKey` 에 둠, `toJSON()` = {name, mode, model} |
| 목적지·헤더 고정 | `guardedFetch`: URL 이 정확히 `https://api.anthropic.com/v1/messages` 가 아니면 보내지 않고 `llm_blocked_destination`, 보낼 때 `redirect:'error'`. 헤더는 허용 목록(`accept·content-type·content-length·user-agent·anthropic-version·x-api-key·x-stainless-*`)만 남기고 `x-api-key` 를 이 provider 의 키로 다시 씀 — SDK 가 끌 수 없이 읽는 `ANTHROPIC_CUSTOM_HEADERS` 가 X-Api-Key 를 덮고 임의 헤더를 붙인다는 것을 임시 probe 로 **재현**(결과 `OVERRIDDEN/1`)한 뒤 막았다. 주입 fetch 가 없으면 호출 시점의 `globalThis.fetch` |
| 요청 | `messages.create({ model: LLM_MODEL, max_tokens: input.maxOutputTokens, system: LIVE_LLM_SYSTEM_PROMPT, messages:[{role:'user', content: input.prompt}], output_config:{ effort:'low', format:{type:'json_schema', schema} } })`. thinking·temperature·tools·tool_choice·prefill·fallbacks·betas·stream 없음. `maxOutputTokens` 가 없거나 1..16000 정수가 아니면, `prompt` 가 비면 **보내기 전에** `llm_request_invalid`. `messages.parse`·`zodOutputFormat` 대신 `create` + 직접 검증을 골랐다(providers 에 zod 직접 의존 없음, 파서 오류 문구가 원문을 담을 수 있어 통제하려고) |
| 응답 | stop_reason 먼저: `refusal` → `LiveLlmRefusalError`(`llm_refusal`), `max_tokens` → `llm_max_tokens`, `end_turn` 외 → `llm_unexpected_stop`. 그다음 블록: text 만 이어 붙이고 thinking/redacted_thinking 은 무시, 그 밖 블록·text 없음·JSON 아님·스키마 불일치(모델이 result_type/input_version 을 써도 strict 로 거부) → `llm_invalid_output`. 서버가 `result_type = input.task`, `input_version = input.inputVersion` 을 붙이고 `llmStructuredOutputSchema` 로 다시 검증 |
| 기존 규칙 | experience 이거나 1인칭 표현(모의와 같은 `FIRST_PERSON` 정규식, `hasFirstPersonExpression` 로 내보냄)이 있는 claim → `kind:'experience', needs_user_confirmation:true`(보수적 방향으로만). 후속 질문은 앞 3개(스키마가 maxItems 미지원). 허용 출처 거르기·자유문 인용 fail-closed(`sanitizeLlmOutput`)·input_version 대조는 db 층 그대로 |
| usage | `usageOf` = 그 호출 응답의 `input_tokens + cache_creation + cache_read`, `output_tokens`. **입력 객체 → usage WeakMap**(db 층은 출력을 zod 로 다시 파싱해 새 객체를 넘기므로 출력 키는 못 씀 — 같은 `llmInput` 객체로 usageOf 를 부르는 것은 writing.ts·variants.ts 에서 확인). usage 가 이상하거나 없으면 예약 상한값(과소 기록 방지) |
| 오류 | `LiveLlmError extends AppError(kind 'llm_failed')` 고정 한국어 문구 + 안정 코드: 연결 시간 초과 `llm_timeout` · 연결 `llm_connection_failed`(가드가 막은 목적지면 그 코드) · 401 `llm_auth_failed` · 403 `llm_permission_denied` · 404 `llm_not_found` · 429 `llm_rate_limited` · 400/422 `llm_bad_request` · ≥500(529 포함) `llm_server_error` · 그 밖 APIError/알 수 없음 `llm_provider_error`. SDK 메시지·헤더·본문·cause 를 담지 않는다. 숫자 `httpStatus` 와 형식이 `req_[A-Za-z0-9]{1,128}` 인 request-id 만 오류 객체에 둠(DB·로그에는 안 씀 — run.error 는 코드만). db 층의 기존 실패 경로가 그대로 run failed(error = 코드) + 502 `llm_failed` + **예약액 전액 확정(D13)** + 본문 보존 |
| 예약(live) | `reserveFor`: mode live 면 입력 = `utf8Bytes(prompt) + utf8Bytes(system) + utf8Bytes(JSON.stringify(schema))`(= `LIVE_LLM_FIXED_INPUT_BYTES`) `+ 2048`(틀 여유 `LIVE_LLM_FRAMING_OVERHEAD_TOKENS`), 출력 = `LLM_LIVE_MAX_OUTPUT_TOKENS`(새 설정, 1024~16000, 기본 4096) — 이 값이 그대로 `maxOutputTokens` → `max_tokens`. 스냅숏 `token_estimate: 'utf8_bytes+fixed+overhead'`, `fixed_input_bytes`, `overhead_tokens`. mock 경로(글자/3, max(256, 입력/2))·기존 시험 숫자 그대로 |
| 1회 상한 제안 | `.env.example` 주석에만 `LLM_BUDGET_PER_RUN_MAX=0.5`(한글 4천 자 프롬프트 ≈ 0.144 USD = 입력 ≈15.5K×0.004/1K + 4096×0.02/1K; 0.5 이면 한글 약 3만 자까지). 월 10 USD 면 보통 원고 최악 예약 기준 약 69회 |
| 초과 | 실제액이 예약보다 크면(가정이 틀린 경우) 기존 FIX-T07 경로대로 `overage_amount`·`over_budget` 로 숨기지 않고 기록(시험 있음) |
| 준비 판정 | `liveLlmReadiness(config, env)`(서명 변경 — env 필수): `{ready: missing.length===0, missing}`. 이름: `LLM_MODE=live`·`LLM_PROVIDER`(없음)/`LLM_PROVIDER=anthropic`(다른 값)·`LLM_MODEL`·두 단가·`LLM_BUDGET_MONTHLY_LIMIT`·`LLM_LIVE_APPROVAL_REF`·`ANTHROPIC_API_KEY`/`ANTHROPIC_API_KEY(형식)`(앞뒤 공백 뗀 값이 공백 없는 1~512자). 값·길이 없음 |
| 선택 | `resolveLiveLlmProvider(config, env)`(providers): 같은 판정이 ready 일 때만 `ClaudeLlmProvider`(키는 그 시점 env 에서), 아니면 `LiveProviderNotConfiguredError(missing)` → 503. `getLlm`: `assertLiveLlmAllowed` → `resolveLiveLlmProvider(config, process.env)` |
| 기록 | run `provider='anthropic'`, `model=LLM_MODEL`(AssistLlm 에 선택 필드 `model?` 추가, mock 은 그대로 'mock') |
| 화면·health | health `llm: {mode, live_ready, missing}`(이름만). 설정: 준비되면 "실제 AI(Claude) 준비됨 — 요청마다 실제 호출·과금(1회 출력 상한 N 토큰)", 아니면 빠진 이름. /ops 한 줄 |
| `.env.example` | 주석 처리한 Claude 블록(LLM_MODE=live, LLM_PROVIDER=anthropic, LLM_MODEL=claude-opus-5-5, 단가 0.004/0.02, 월 10, 1회 0.5 제안, LLM_LIVE_MAX_OUTPUT_TOKENS=4096, `ANTHROPIC_API_KEY=` 빈 값, 승인 기록은 2단계 승인 뒤에만) |
| 네트워크 가드 | `tests/setup/no-meta-network.ts` 의 차단 목록에 `*.anthropic.com` 추가(같은 fetch·undici dispatcher·http(s)·net/tls·dns 경로) |

## 변경 파일
- 새 파일: `packages/domain/src/llm-live.ts`, `packages/providers/src/llm-anthropic.ts`, `packages/providers/src/llm-anthropic.test.ts`, `packages/providers/src/no-anthropic-network.test.ts`, `tests/integration/live-llm.test.ts`, 이 문서(`.handoffs/`)
- 코드: `packages/domain/src/budget.ts`(live 예약·준비 판정), `packages/domain/src/config.ts`(`LLM_LIVE_MAX_OUTPUT_TOKENS`), `packages/domain/src/index.ts`, `packages/providers/src/llm.ts`(자리 표시 `LiveLlmProvider` 제거, `model?`, `hasFirstPersonExpression`), `packages/providers/src/index.ts`, `packages/providers/package.json`, `packages/db/src/writing.ts`·`variants.ts`(run.model, `AssistLlm.model?`), `apps/web/lib/server.ts`(getLlm), `apps/web/app/api/health/route.ts`·`settings/page.tsx`·`ops/page.tsx`(env 전달·문구), `.env.example`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`(overrides), `tests/setup/no-meta-network.ts`
- 시험 수정(의도한 동작 변경 — 단언 완화 아님): `packages/domain/src/budget.test.ts`(준비 상태 "항상 false + LIVE_ADAPTER" → 모두 있으면 ready, 하나씩 빠지면 **정확히 그 이름만**(`toEqual`, 이전 `toContain` 보다 강함)), `packages/providers/src/llm.test.ts`(LiveLlmProvider 시험 → resolveLiveLlmProvider 시험), `tests/integration/budget-claims.test.ts`(health 기대 목록: `['LLM_LIVE_APPROVAL_REF','LIVE_ADAPTER(…)']` → `['LLM_PROVIDER=anthropic','LLM_LIVE_APPROVAL_REF','ANTHROPIC_API_KEY']` — FULL 의 공급자가 placeholder 이므로). 503 행렬(7행)은 그대로 통과
- migration: 없음. 복원 영향 없음(원장 pricing_snapshot 에 키 2개가 더 붙을 수 있을 뿐 — jsonb)

## 변경 → 시험
| 변경 | 시험 |
|---|---|
| 성공·서버가 정하는 result_type/input_version | unit `llm-anthropic.test.ts` — 기록된 Message(thinking 빈 블록 + text JSON), `llmStructuredOutputSchema` 통과, task·inputVersion 그대로 |
| 요청 본문·헤더 | 본문 키 정확히 5개(model·max_tokens·system·messages·output_config), `max_tokens === maxOutputTokens`(2345), effort low + json_schema, thinking·temperature·top_p·top_k·tools·tool_choice·fallbacks·stream·betas·stop_sequences 없음, user 메시지 하나(prefill 없음), URL 정확, POST, `redirect:'error'`; `x-api-key` 는 값 비교만(출력 안 함), Authorization 없음, anthropic-version 있음, `x-stainless-retry-count: 0` |
| 예약 = 보낸 바이트 | 보낸 system+schema 바이트 = `LIVE_LLM_FIXED_INPUT_BYTES`, 상한 ≥ 보낸 바이트; 통합에서 원장 예약액 = `reserveFor(policy, 실제로 보낸 user content)` 이고 입력 추정 = 보낸 세 문자열 바이트 + 2048 |
| stop_reason | refusal(설명·부분 텍스트에 표식) → `LiveLlmRefusalError`·누출 없음; max_tokens; pause_turn·tool_use·stop_sequence·model_context_window_exceeded·null → unexpected_stop |
| 형식 오류 11종 | JSON 아님·빈 텍스트·text 없음·tool_use 블록·필드 빠짐·모델이 result_type/input_version 씀·claim 추가 필드(`evidence_grade`)·kind 이상·빈 claim·배열 대신 문자열 → `llm_invalid_output`, 원문 없음 |
| 오류 매핑·누출·재시도 | 400/401/403/404/413/422/429(retry-after)/500/529(`x-should-retry: true`) 각 1행: 코드·httpStatus·requestId, **fetch 정확히 1번**, 메시지·stack·JSON·inspect(showHidden)·String 에 키·`sk-ant`·되풀이 원문 없음, cause 없음, console.log/warn/error 0; 연결 오류(메시지에 키) → connection_failed 1번; 50ms 시간 초과 → `llm_timeout` 1번 |
| 보내기 전 거부 | maxOutputTokens 없음·0·음수·소수·16001, prompt 없음·공백 → `llm_request_invalid`, fetch 0번 |
| 환경변수 무시 | `ANTHROPIC_BASE_URL=https://evil…`·`ANTHROPIC_AUTH_TOKEN`·`ANTHROPIC_LOG=debug`·다른 `ANTHROPIC_API_KEY` → 주소 그대로, Bearer 없음, 주입 키 사용, console.debug/info/log 0 |
| 헤더 허용 목록 | `ANTHROPIC_CUSTOM_HEADERS` 에 X-Api-Key(다른 값)·Authorization·anthropic-beta·X-Extra → 보낸 헤더는 허용 이름만, x-api-key 는 주입 키 |
| 키 위생 | 호출 뒤에도 `JSON.stringify(provider)` = {name, mode, model}, inspect(showHidden)에 키 없음; 형식 틀린 키 → 생성 거부(이름만) |
| usage | 캐시 생성·읽기 포함 합, 두 호출이 각자 입력 객체로 조회(출력은 zod 재파싱한 새 객체여도), 이상한 usage·모르는 입력 → 예약 상한값 |
| 기존 규칙 | 1인칭 fact·experience(needs=false) → experience+확인 필요, opinion 은 그대로·source_refs 유지(거르기는 db 층), 후속 질문 5개 → 3개 |
| 변이 확인 | `maxRetries: 2`·`authToken: undefined` 로 임시 변경 → 위 시험 6개 실패 확인 후 원복 |
| 준비 판정·예약(domain) | `budget.test.ts` — 모두 → `{ready:true, missing:[]}`·값/키 길이 없음; 7개 조건 각각 빠지면 정확히 그 이름; 키 없음·빈 값·공백·중간 공백·513자; 앞뒤 공백 허용; anthropic 아닌 공급자 4종 → `LLM_PROVIDER=anthropic`; 기본 mock → 8개 이름(LIVE_ADAPTER 없음); live 예약 식·고정분 = 상수 바이트·한국어에서 글자/3 보다 큼·설정 범위(1023·16001·음수·소수·문자·1e4 거부)·mock 숫자 불변·0.5 USD 제안 경계 |
| 네트워크 가드 | unit `no-anthropic-network.test.ts`: 주입 없는 실제 ClaudeLlmProvider → 가드 fetch 에서 막힘(`api.anthropic.com`/`fetch`, 결과 `llm_connection_failed`, 키 없음); 대문자·끝의 점 fetch·https.request·net.connect·dns.lookup·dns.promises.resolve4(console.anthropic.com) 막힘; 비슷한 이름 통과; 모의 provider 기록 변화 0. 임시 probe(기록을 비우지 않는 fetch 1회) → 파일이 afterAll 에서 FAIL("… Anthropic 호스트로 1번 … api.anthropic.com / fetch") 확인 후 삭제 |
| 통합(db 층) | `tests/integration/live-llm.test.ts`: 성공(run succeeded·provider anthropic·model claude-opus-5-5·제안은 현재 아님·1인칭 claim 확인 필요·예약=보낸 문자열·max_tokens 4096·원장 = usage 1500/800 × 단가·DB 전체에 키/원문 없음); 초과(usage 200000/4096 → over_budget·overage 정확); refusal(run failed `llm_refusal`·output 없음·원장 failed=true 실제액=예약액>0·본문/현재 버전 그대로·감사 error 코드·DB 에 원문 없음); HTTP 401/429/529 → run failed 코드·호출 1번·예약액 확정; 예산 429(월 상한 0.01·1회 0.05 — reason monthly_limit/per_run_max, 호출 0, 행 0); 채널 초안(variant) 같은 예약·usage 확정 |
| 통합(route·health) | 서버 env + `vi.stubGlobal('fetch', 가짜)`: POST assist 201(provider anthropic·mock_warning null·응답에 키 없음, 요청 URL·x-api-key 확인), health `{mode:'live', live_ready:true, missing:[]}`(키·승인 값 없음); 키 빈 값·형식 오류 → 503 `live_provider_not_configured` 이름만·호출 0·행 0·health 같은 이름; mock 모드는 키가 있어도 모의 |

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, dev 서버 꺼짐 — :3000 LISTEN 없음 확인)
오케스트레이터가 `.handoffs/run-checks.sh LIVEL1` 로 돌린 결과(`.handoffs/checks-LIVEL1.log`):
- lint 0 · typecheck 0 · build 0 · unit 0(56 파일, 1341 시험 통과) · drill:mock 0(불변식 위반 0건) · db:migrate 0 · drill:restore 0(PASS).
- integration: 전체 실행 1회차 INTEG=1, 재실행(run-integ.sh) INTEG2=1 — 둘 다 코드 실패가 아니라 Windows 메모리 고갈로 vitest worker 가 죽은 것(`exit 2147483651`, `PGlite failed to initialize properly`; 그때 남은 실제 메모리 약 4GB). vitest.config.ts 주석에 적힌 기존 환경 문제와 같다.
- 같은 코드로 `vitest run --project integration --maxWorkers=2` → **37 파일 · 751 시험 모두 통과(INTEG3=0)**. 설정 파일(maxWorkers 3)은 바꾸지 않았다.
- 로그 첫 7줄은 구현자가 멈춘 이전 실행의 남은 줄(임시 probe 시험 파일 포함 — 그 파일은 삭제됨).

구현자 기록(사실만): `.handoffs/checks-LIVEL1.log` 의 첫 7줄(DRILL_RESTORE … 첫 CHECKS-DONE, `zz-custom-headers-probe` FAIL)은 **중단한 이전 실행**의 잔여다 — 그 실행 중에 임시 probe 파일(의도적으로 실패하는 헤더 재현 시험, 지금은 삭제됨)이 unit 실행에 섞였다. 그 뒤 헤더 허용 목록을 넣고 다시 돌린 실행(8줄부터): LINT=0 · TYPECHECK=0 · BUILD=0 · UNIT=0(56 files, 1341 tests) · INTEG=1 · DRILL=0 · MIGRATE=0 · DRILL_RESTORE=0. INTEG=1 은 `threads.test.ts` 1건 — 로그상 원인 `PGlite failed to initialize properly`(CREATE SCHEMA drizzle 실패) + 워커 비정상 종료 2건(exit 2147483651, ops-retention·export-restore — vitest.config 주석의 Windows 메모리 고갈 증상), 37개 중 35개 파일만 끝남. 이 작업과 무관한 환경 실패로 보이며, 통합 재실행은 오케스트레이터가 한다. 앞서 단독 실행한 `live-llm.test.ts` + `budget-claims.test.ts` 는 43/43 통과.

## 2단계에 필요한 것(별도 승인 뒤, 사용자 수동)
1. 사용자가 Anthropic 콘솔에서 키를 만들고 **`.env.local` 에만** 직접 넣는다: `ANTHROPIC_API_KEY=…`(대화·저장소·화면에 값 공유 금지).
2. `.env.example` 의 Claude 블록을 `.env.local` 로 옮긴다(LLM_MODE=live·LLM_PROVIDER=anthropic·LLM_MODEL=claude-opus-5-5·0.004/0.02·월 10·1회 0.5·출력 4096). 승인 뒤에만 `LLM_LIVE_APPROVAL_REF`(예: D34-2) 설정.
3. dev 서버 재시작 → 설정 화면 "실제 AI(Claude) 준비됨" 확인(health `live_ready:true`).
4. 사용자가 고른 가상/공개 소재 1건으로 작성 보조 1회. 결과는 화면의 run 상태·오류 코드·원장(예약액·실제액·tokens_in/out)만 공유.
5. 실제 `usage.input_tokens` 와 예약 입력 추정을 비교해 틀 여유(2048)·바이트 상한을 교정(D34 When to revisit).

## 남은 위험
1. **상한 증명의 가정 2개**: (a) 토큰 ≥ 1바이트(바이트 수준 BPE) — 문서로 확인하지 못함, (b) structured outputs 형식 지시·메시지 틀의 입력 토큰 ≤ 2048 — 공개 수치 없음. 틀리면 실제액 > 예약액이 될 수 있다(그 경우 숨기지 않고 overage 로 기록되고 다음 예약이 막힌다 — 월 상한은 "예약 시점 검사"라 1회분만큼 넘을 수 있음).
2. SDK 는 그 밖의 환경변수(`ANTHROPIC_WEBHOOK_SIGNING_KEY` 등)도 읽지만 이 경로에서 쓰지 않는다. `ANTHROPIC_CUSTOM_HEADERS` 는 헤더 허용 목록으로 무력화했다 — 허용 목록에 있는 `user-agent`·`x-stainless-*`·`anthropic-version` 은 그 변수로 바꿀 수 있다(목적지·키는 고정).
3. 실패 호출(refusal·max_tokens·형식 오류·시간 초과·5xx)은 D13 대로 **예약액 전액 확정** — refusal·max_tokens 처럼 응답 usage 를 아는 경우에도 실제액 대신 예약액(보수적 과대 기록). 401/403/404/400 처럼 과금되지 않았을 오류도 예약액 확정.
4. 시간 제한 300초 — 그동안 요청 처리기가 붙잡힌다. 시간 초과는 재시도하지 않지만 Anthropic 쪽에서는 생성·과금이 끝까지 갈 수 있다(예약액 확정으로 상한 안).
5. 1인칭 정규식 재분류는 휴리스틱 — "제 …" 가 들어간 사실 문장도 experience 로 바뀌어 확인 대상이 늘 수 있다(보수적 방향). 후속 질문 4개 이상은 앞 3개만.
6. thinking 은 끌 수 없어 출력 4096 중 일부를 쓴다 — 낮은 effort 에서도 긴 원고는 `llm_max_tokens` 로 실패(예약액 확정)할 수 있다. 2단계에서 실제 output_tokens 를 보고 기본값 조정.
7. 프롬프트(사용자 원고·인터뷰 답변·출처 요약)가 Anthropic 으로 간다 — 2단계는 D34 대로 가상/공개 소재로만. 프롬프트 인젝션 방어는 시스템 프롬프트 문구 + 기존 출력 정제(fail-closed 인용)뿐.
8. 키는 "존재·형식"만 판정 — 틀린 키는 첫 호출의 401(`llm_auth_failed`, 예약액 확정)로 드러난다.
9. 스트리밍 미사용(비스트리밍 + 출력 상한 16000 으로 SDK 시간 검사 범위 안).
10. 프로세스가 호출 중 죽으면 원장 reserved 가 남는 D13 의 기존 위험 그대로.

## Codex 에게 묻는 것
1. **예약 상한 증명**: 입력 = UTF-8 바이트(프롬프트+시스템+스키마 JSON) + 2048, 출력 = max_tokens 로 "예약액 ≥ 실제 청구액"이 성립하는가? 바이트 ≥ 토큰 가정, 스키마가 그대로 토큰화되지 않고 문법·지시로 바뀌는 점, 2048 여유가 약한 고리인지. 더 안전한 대안(예: 2단계에서 count_tokens 로 교정)이 필요한가?
2. **오류 누출**: SDK 오류의 message·headers·error 본문·cause 가 우리 오류·run.error·감사·응답·로그로 새는 경로가 남았는가? (`logLevel:'off'`, 원 오류를 버리고 새 오류만, route 의 미처리 로그는 이름만.) SDK 가 deprecated 모델에 대해 `console.warn`(모델 이름만) 하는 것은 허용 범위인가?
3. **재시도·과금**: `maxRetries: 0` 외에 SDK 가 같은 요청을 다시 보내는 경로(401 토큰 갱신 재시도는 토큰 캐시가 있을 때만 — apiKey 사용 시 없음)가 있는가? 시간 초과·연결 오류 때 "재시도 없음"이 사용자 재시도(새 예약)로만 이어지는지.
4. 헤더 허용 목록(fetch 감싸개)이 충분한가 — `anthropic-version` 을 환경변수로 바꿀 수 있는 점, SDK 가 앞으로 필요한 헤더를 추가하면 조용히 빠지는 점(시험이 anthropic-version 존재만 확인)은 괜찮은가?
5. 입력 객체 키 WeakMap 으로 usage 를 찾는 방식이 db 층(writing.ts·variants.ts) 호출 순서와 맞는가? 같은 입력 객체를 두 번 generate 하면 마지막 usage 만 남는데 그런 경로가 있는가?
6. refusal·max_tokens 에서 응답 usage 를 알고도 예약액 전액을 확정하는 것(D13 유지)과, 401/400 같은 비과금 오류까지 전액 확정하는 것 — 유지가 맞는가?
7. 1인칭 재분류·후속 질문 3개 자르기가 "모델 출력을 고쳐 살리는" 정제로 보아 fail-closed 원칙(FIX-T07 round 4)과 충돌하는가? (둘 다 확인 필요를 늘리는 쪽·질문 목록 자르기.)

- Next authorized task: 없음 — D34 2단계(실제 호출 1회)는 사용자 별도 승인 필요.

# FIX round 1 (Codex review-LIVEL1, CHANGES_REQUESTED on 2cbcb49)
- BASE_SHA: 8a54ef3 (2cbcb49 + 인계 docs 커밋). 리뷰 대상 HEAD 2cbcb49 와 코드 동일(8a54ef3 은 docs 만).
- HEAD_SHA: uncommitted (orchestrator commits). `git add -A` 하지 않음. `.env.local`·`./data`·`docs/handoffs/*`·`docs/DECISIONS.md`·`.claude/` 수정 없음.
- External calls: **none**(Anthropic 요청 0 — 가짜 fetch·setupFiles 가드). 이번 라운드엔 npm 레지스트리 접근도 없음(의존성 변경 없음).
- 재현 방법: 코드를 고치기 전에(작업 트리 = 8a54ef3, 코드는 2cbcb49 와 같음) 새 시험만 추가해 실행 → 아래 "재현" 열의 시험이 **실패**함을 확인한 뒤 고쳤다.
  - unit `llm-anthropic.test.ts` FIX1 블록: 2cbcb49 코드에서 **17 failed / 54 passed**.
  - unit `budget.test.ts` FIX1 블록: **4 failed / 39 passed**.
  - integration `live-llm.test.ts` FIX1 블록: **11 failed / 16 passed**. P1 :93 의 "다음 예약 429" 시험은 2cbcb49 에서도 통과했다. 성공 경로의 초과 기록과 다음 예약 차단은 이미 있었고, 지적의 핵심은 "상한이라고 주장한 것"과 실패 경로였다.

## 지적 → 재현 → 수정 → 시험
| 지적 | 재현(2cbcb49 에서 실패) | 수정 | 시험(수정 후 통과) |
|---|---|---|---|
| [P1] llm-live.ts:93 증명 안 된 상한 | 주장의 문제라 코드 실패는 없음(성공 경로 초과 시험은 통과) | 상한 주장 제거: `liveInputUpperBoundTokens` → **`liveInputEstimateTokens`** 이름 변경, llm-live.ts·budget.ts(domain·db)·config.ts·llm-anthropic.ts 주석, `.env.example`, 설정 화면 문구("예약액은 추정이며 실제 사용량이 기록됩니다 — 초과하면 다음 요청부터 거부"), 이 문서 머리 정정. 식(바이트 + 2048 + max_tokens)은 그대로. count_tokens 등 네트워크 없음 | integ "실제액이 1회 상한·월 잔여를 넘는 호출 → 초과액 그대로 기록, 다음 예약은 429(호출 0)": 1회 0.5·월 0.6, usage 300000/4096(= 1.281920 USD) → actual·overage·over_budget 정확, 다음 예약 `budget_exceeded`/`monthly_limit`, fetch 1번, 행 변화 0 |
| [P1] llm-anthropic.ts:222 실패 응답의 usage 버림 | unit 5행(refusal·max_tokens·unexpected_stop·invalid_output·content 비배열 + usage 200000/4096 → `e.usage` 없음), 2행(usage 이상·HTTP 오류 → `e.usage` 가 null 이 아니라 undefined). integ 7행(실패 4종·인용 정제 실패·작은 usage·variant → 원장에 tokens/actual/overage 없음) | provider: `readUsage` 로 **stop_reason·출력 검증 전에** usage 를 검증하고, `LiveLlmError.usage`(숫자 `{tokensIn,tokensOut}` 만, 텍스트 없음)를 refusal·max_tokens·unexpected_stop·invalid_output 에 싣는다. domain: `failureUsageOf(e)`(구조로 읽고 안전 정수만), `failedSettlement(pricing, reserved, usage)` = max(예약액, usage 비용) + 초과액. db: `settleLedgerFailed(…, {pricing, usage})` — usage 가 있으면 actual = max, `tokens_in/out`, `overage_amount`, `over_budget`, failed=true, 없으면 D13 그대로. `liveFailureUsage`(writing.ts·variants.ts 공용)는 live 만: 오류의 usage, 또는 provider 는 성공했는데 서버 검증(input_version·크기·`unverifiable_citation`)이 실패하면 그 호출의 `usageOf`. 모의와 HTTP 오류(usage 모름)는 D13 그대로 | unit 7행(원문 누출 없음 포함). domain `failedSettlement`·`failureUsageOf`. integ: 실패 5종 + usage 200000/4096 → actual = usage 비용 > 예약, overage·over_budget·tokens, 본문 그대로, DB 에 원문·키 없음. 작은 usage → actual = 예약(D13), tokens 기록. HTTP 529 → tokens null·예약액. variant 실패도 같은 정산. 모의 실패는 기존 그대로 |
| [P2] :271 캐시 usage | unit 6행(캐시 문자열·음수·소수·2^53·합계 초과·input 2^53+2 → 추정값 대신 그 값을 씀) | `readUsage`: input·output 은 `Number.isSafeInteger` ≥ 0. 캐시 필드는 없음·null 이면 0, 있는데 이상하면 **전체 null**. 그러면 성공은 보수적 추정, 실패는 usage 없음(D13). 합계도 안전 정수 검사 | unit 8행(없음·null → 그 값, 이상한 6종 → 추정값) |
| [P2] :181 헤더 값 | unit 1행(CUSTOM_HEADERS 로 `Content-Length: 0`·`Content-Type: text/plain`·`Accept: text/html`·`Anthropic-Version: 1999-01-01` 을 넣으면 그대로 나감) | 허용 목록을 `user-agent·x-stainless-*` 로 줄이고 `accept`·`content-type` = `application/json`, `anthropic-version` = **`ANTHROPIC_API_VERSION = '2023-06-01'`**(node_modules/@anthropic-ai/sdk/client.js buildHeaders 에서 확인한 고정 SDK 값), `x-api-key` = 키로 다시 쓴다. `content-length` 는 버림(전송 계층이 계산) | unit: 최종 헤더 **값** 단언(content-length 없음, 세 값 고정, 키) + 기존 허용 목록 시험 |
| 놓친 (a) content 비배열·null 블록 | unit 1행(null 블록 → TypeError 가 나고 LiveLlmError 가 아님) | `Array.isArray(content)`, 블록 객체, text 문자열 검사 → `llm_invalid_output` | unit 4행(null·문자열·null 블록·숫자 블록) |
| 놓친 (b) 같은 입력 재사용 | unit 1행(성공 뒤 실패해도 지난 usage 를 돌려줌) | `generate` 시작 때 `#usage.delete(input)` | unit 1행(실패 뒤 usageOf = 추정값) |
| 놓친 (c) proposed_text 의 1인칭 | unit 1행·integ 1행(claims=[] 이면 경험 claim 없음) | provider: `splitSentences`(모의와 같은 문장 분리, llm.ts 에서 export)로 제안 본문을 나누고, 1인칭 표현이 있는데 experience claim 으로 덮이지 않은 문장마다 `{kind:'experience', needs_user_confirmation:true, source_refs:[]}` 를 더한다(출처·증거 등급을 만들지 않음, 중복 없음). 하류 게이트 확인: `claims-gate.ts` `listUnconfirmedExperienceClaims` 가 채택한 run 의 output_json claims 중 확인 안 된 experience 를 찾고, lifecycle(ready 등) 전이가 409 `unconfirmed_experience_claims` 로 막힌다(writing.test.ts 의 모의 경로와 같은 함수) | unit 2행(더함·이미 덮였으면 안 더함). integ: live 출력 → 저장된 claim → `adoptProposal` → `listUnconfirmedExperienceClaims` = [[run, 0]] |
| 놓친 (d) D34 2단계 호출 횟수 | integ 3행(2번째 호출도 나감, 동시 2건 모두 호출) + domain 2행(설정·스냅숏 없음) | 새 설정 **`LLM_LIVE_MAX_RUNS`**(선택, 1~1000000 정수). live 예약 스냅숏에 `approval_ref`(LLM_LIVE_APPROVAL_REF)를 저장. `reserveOrThrow`: live 이고 설정이 있으면 **owner 잠금(lockOwnerForBudget) 아래에서** 이 owner 의 live 원장 행 중 같은 approval_ref 수(상태·기간 무관, 실패 호출 포함)를 세어 한도 이상이면 429 `live_run_limit`(`LiveRunLimitError`, kind budget_exceeded). 예산 검사보다 먼저이고 같은 트랜잭션이라 아무것도 쓰지 않고 호출하지 않는다. 원장 행이 같은 트랜잭션에서 바로 쓰여 동시 요청도 직렬화된다. `usageLedgerView` 는 `approval_ref` 를 빼고 내보낸다(화면·API 응답). 폼 오류 코드 `live_run_limit` 문구 추가. `.env.example` 에 `LLM_LIVE_MAX_RUNS=1`(2단계 권장) 주석 | domain: 설정 범위(0·-1·1.5·문자·1000001·1e3 거부), 스냅숏 approval_ref(mock 은 없음). integ: 순차(2번째는 429 `live_run_limit`·호출 0·행 0, 새 승인 기록이면 다시 1회, view 에 ref 없음), 실패 호출도 1회로 셈, **동시 2건 → fulfilled 1·`live_run_limit` 1·fetch 1·원장 1행**, 설정이 없으면 제한 없음 |

## 바뀐 파일(FIX round 1)
- 코드: `packages/domain/src/llm-live.ts`(이름 변경·주석), `packages/domain/src/budget.ts`(`liveMaxRuns`·`liveApprovalRef`·스냅숏 `approval_ref`·`LiveRunLimitError`·`failureUsageOf`·`failedSettlement`·주석), `packages/domain/src/config.ts`(`LLM_LIVE_MAX_RUNS`·주석), `packages/db/src/budget.ts`(`reserveOrThrow` 횟수 검사·`liveRunsUsed`·`settleLedgerFailed` usage 정산·view 에서 approval_ref 제외), `packages/db/src/writing.ts`(`liveFailureUsage`·실패 정산), `packages/db/src/variants.ts`(같음), `packages/providers/src/llm-anthropic.ts`(usage 선검증·오류 usage·`readUsage`·헤더 값 고정·`ANTHROPIC_API_VERSION`·content 검사·WeakMap 초기화·1인칭 문장 claim), `packages/providers/src/llm.ts`(`splitSentences` export), `apps/web/app/settings/page.tsx`(문구), `apps/web/lib/writing.ts`(폼 코드 `live_run_limit`), `.env.example`
- 시험: `packages/providers/src/llm-anthropic.test.ts`(+FIX1 블록, 기존 시험 제목 1개에서 "상한값" 표현만 바꿈 — 단언 그대로), `packages/domain/src/budget.test.ts`(+FIX1 블록, describe 제목 "실제 비용 상한" → "보수적 추정" — 단언 그대로), `tests/integration/live-llm.test.ts`(+FIX1 블록, import 추가). 함수 이름 변경(`liveInputUpperBoundTokens` → `liveInputEstimateTokens`)에 따라 참조를 고침. 지우거나 약하게 바꾼 단언은 없음
- migration 없음(스냅숏은 jsonb, 횟수는 기존 열로 센다)

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, node 프로세스 0개를 확인한 뒤)
| 명령 | 결과 |
|---|---|
| 재현(수정 전): `vitest run --project unit packages/providers/src/llm-anthropic.test.ts` | 17 failed / 54 passed (FIX1 시험만 실패) |
| 재현(수정 전): `vitest run --project unit packages/domain/src/budget.test.ts` | 4 failed / 39 passed |
| 재현(수정 전): `vitest run --project integration tests/integration/live-llm.test.ts` | 11 failed / 16 passed |
| 수정 후 단독: unit 4개 파일(llm-anthropic·budget·llm·no-anthropic-network) | 128 passed |
| 수정 후 단독: integration live-llm + budget-claims | 58 passed |
| `bash .handoffs/run-checks.sh FIX-LIVEL1` → `.handoffs/checks-FIX-LIVEL1.log` | LINT=0 · TYPECHECK=0 · BUILD=0 · **UNIT=1** · INTEG=0 · DRILL=0 · MIGRATE=0 · DRILL_RESTORE=0 |
| ├ unit | Test Files 1 failed / 55 passed (56), Tests 1 failed / 1367 passed (1368). 실패 1건: `packages/domain/src/imports-fix3.test.ts > FIX-T18 round 3 … > 엔티티만` — **"Test timed out in 5000ms"(5345ms)**. 이 작업이 건드리지 않은 파일(가져오기 파서의 걸음 수 시험)이고, 전체 실행 부하 아래에서 시간 초과가 난 것으로 보인다 |
| ├ 그 파일만 다시(`corepack pnpm exec vitest run --project unit packages/domain/src/imports-fix3.test.ts`, 다른 시험 없이) | 86 passed (7.9 s) |
| ├ integration | Test Files 37 passed (37), Tests 766 passed (766) — 이번에는 워커 비정상 종료 없음(`--maxWorkers=2` 재실행 불필요) |
| ├ drill:mock | 불변식 위반 0건(M3·T14·T15·T16 MOCK) |
| └ drill:restore | PASS — 복원한 빈 환경이 원본 묶음과 일치 |

## 남은 위험(FIX round 1 기준)
1. 예약은 추정이다. 실제액이 예약보다 크면 월·1회 상한을 **최대 한 호출분** 넘을 수 있다(초과액을 기록하고 다음 예약을 거부). 한 호출의 최대 초과 크기는 입력 추정의 오차(가정 2개)에 달려 있고 증명되지 않았다. 2단계 실제 usage 로 교정해야 한다.
2. 동시 요청: 예약 검사 때의 합계에는 진행 중 호출의 **예약액**만 들어간다. 동시에 여러 호출이 각자 예약을 넘으면 초과가 호출 수만큼 쌓일 수 있다(`LLM_LIVE_MAX_RUNS=1` 이면 1건으로 묶인다).
3. HTTP 오류·시간 초과·연결 오류는 응답 usage 가 없어 D13(예약액 전액)이다. 실제로 과금됐는지는 모른다(401/400 은 아마 0).
4. 1인칭 문장 판별은 모의와 같은 정규식 휴리스틱이다. 놓치는 표현(예: 주어를 생략한 "작년에 두바이로 이직했다")에는 claim 이 생기지 않는다. 오탐은 확인 대상만 늘린다.
5. `LLM_LIVE_MAX_RUNS` 는 approval_ref 문자열 기준으로 센다. 승인 기록 값을 바꾸면 새로 센다(의도). 복원한 원장 행도 센다(보수적). 설정을 비우면 제한이 없다(운영자 책임).
6. `anthropic-version` 은 고정 SDK 값을 상수로 둔다. SDK 를 올리면 함께 확인해야 한다(시험이 상수 = '2023-06-01' 을 단언).

## Codex 에게 묻는 것(FIX round 1)
1. 실패 정산 = max(예약액, 응답 usage 비용)과 "usage 모름 → 예약액"의 경계가 맞는가? 특히 provider 성공 뒤 서버 검증 실패(`unverifiable_citation` 등)에서 `usageOf` 를 쓰는 것, 그 usage 가 이상해 추정값이 들어가면 tokens 열에 추정값이 기록되는 것.
2. `LLM_LIVE_MAX_RUNS` 횟수 검사가 동시성에서 안전한가? 원고 잠금(lockContentForWrite) → owner 잠금 → 횟수 → 예산 → 원장 삽입이 한 트랜잭션이다. PGlite 밖의 postgres 드라이버에서도 같은가? 세는 조건(스냅숏 mode='live' + approval_ref 같음, 상태·기간 무관)이 맞는가?
3. 헤더: 허용 목록(`user-agent`·`x-stainless-*`) + 고정 4개(`accept`·`content-type`·`anthropic-version`·`x-api-key`)로 충분한가? `user-agent`·`x-stainless-*` 를 환경변수로 바꿀 수 있다는 점은 받아들일 만한가?
4. 1인칭 문장 claim 추가가 FIX-T07 round 4 의 fail-closed 원칙(모델 출력을 고쳐 살리지 않음)과 충돌하는가? (출력은 고치지 않고 확인 대상만 더한다.)
5. 상한 주장 정정(코드 주석·화면·`.env.example`·이 문서)이 충분한가, 남은 표현이 있는가?


### FIX round 1 — 오케스트레이터 기록
- FIX HEAD: d7da959b4da89311efa622f6101cac38d0967b48 (code only, D28). BASE 8a54ef3.
- checks-FIX-LIVEL1: lint 0 · typecheck 0 · build 0 · unit 1회차 1 실패(이 변경과 무관한 `imports-fix3.test.ts` 성능 시험 5초 초과 5345ms) → 단위만 재실행 **56 파일 · 1368 시험 모두 통과(UNIT2=0)** · integration 0(37 파일 · 766 시험) · drill:mock 0 · db:migrate 0 · drill:restore 0(PASS).
