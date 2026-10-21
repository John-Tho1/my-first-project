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

# FIX round 2 (Codex review-FIX-LIVEL1, CHANGES_REQUESTED on d7da959)
- BASE_SHA: f170ecd (d7da959 + 판정·인계 docs 커밋, 코드는 d7da959 와 같음). HEAD_SHA: uncommitted (orchestrator commits). `git add -A` 하지 않음.
- 수정하지 않음: `.env.local`·`./data`·`docs/handoffs/*`·`docs/DECISIONS.md`·`.claude/`. External calls: **none**(Anthropic 요청 0, 의존성 변경 없음).
- **정정(이 문서 FIX round 1 의 표현)**: FIX round 1 머리와 남은 위험 1 의 "월·1회 상한은 **최대 한 호출분** 넘을 수 있다", "실제 사용량은 **성공·실패 모두** 기록"은 틀렸다. 맞는 설명은 아래 "초과 동작".
- 재현: 고치기 전에(작업 트리 = f170ecd, 코드 = d7da959) 새 시험만 추가해 실행했다.
  - unit `llm-anthropic.test.ts` FIX2 블록: **11 failed / 72 passed**.
  - unit `budget.test.ts` FIX2 블록: **1 failed / 43 passed**.
  - integration `live-llm.test.ts` FIX2 블록: **9 failed**. 처음 실행에서 10 failed 였는데, (b) 동시 초과 시험의 단언을 내가 잘못 세웠던 탓이다(두 호출이 실제로 겹치지 않음). 응답을 붙잡는 게이트를 넣어 다시 쓴 (b) 와 (a)·(d) 는 d7da959 에서도 **통과** — 지금 동작을 기록하는 시험이다(아래 표).

## 초과 동작(정확한 설명 — 코드 주석·`.env.example`·설정 화면을 이 내용으로 고침)
1. 실제 사용량은 **공급자가 유효 usage 를 보고한 경우에만** 기록한다(성공·실패 모두. 실패는 max(예약액, usage 비용)). 보고가 없거나 이상하거나 원장 열 범위 밖이면 예약액으로 확정하고 `tokens_in/out` 은 NULL, 스냅숏 `usage_source = 'none'`.
2. 실제액 > 예약액이면 `overage_amount`·`over_budget` 을 기록하고, 그 금액은 월 합계에 들어간다.
3. 다음 요청이 거부되는 경우는 둘이다. 하나는 "월 합계(기록된 초과액 포함) + 그 요청의 예약액 > 월 상한"(429 `monthly_limit`), 다른 하나는 "그 요청의 예약 **추정** > 1회 상한"(429 `per_run_max`). 1회 상한은 실제액에 적용되지 않는다 — 실제액이 1회 상한을 넘어도 월 잔여가 있으면 다음 요청은 허용된다(시험 (a)).
4. 예약 검사는 진행 중 호출의 **예약액**만 본다. 그래서 동시에 진행 중인 호출들이 각각 예약을 넘으면 초과액이 모두 합쳐져 월 상한을 넘는다(시험 (b)). 월 상한 초과가 한 호출분으로 묶이는 것은 같은 승인 기록에 `LLM_LIVE_MAX_RUNS=1` 일 때뿐이다.

## 지적 → 재현 → 수정 → 시험
| 지적 | 재현(d7da959 에서) | 수정 | 시험(수정 후) |
|---|---|---|---|
| [P1] llm-anthropic.ts:287 부분 claim 이 문장 전체를 덮음 | unit 3행 실패: 짧은 claim `제가 협상했습니다` 가 `제가 협상했습니다 그리고 계약을 따냈습니다.` 를 덮음 / 공백 없는 `…했습니다.그리고 제가…` 가 한 덩어리 / 여러 경험·`…있었습니다?우리는…` 이 안 나뉨. integ 1행 실패 | (1) 덮임 판정: 기존 experience claim 의 정규화 텍스트(NFKC·공백 접기·trim)가 문장 정규화 텍스트 **전체를 포함할 때만**. (2) 새 분리기 `splitSentencesStrict`(live 확인 claim 전용 — 모의 provider 의 분리는 그대로). 규칙: 종결 부호(`. ! ? 。 ！ ？ …`) 연속 + 닫는 따옴표·괄호 뒤에, **다음 글자가 끝·공백·영문/숫자가 아닌 글자(한글 등)** 면 끊는다. 다음 글자가 영문·숫자면 끊지 않는다 — 소수 `3.5`, 도메인·URL `example.com`, 약어 `e.g.` 안쪽은 한 문장으로 남는다(약어 뒤에 공백이 오면 끊길 수 있지만 확인 대상만 늘어나는 보수적 방향). 줄바꿈도 경계 | unit 4행: 짧은 부분 claim + 긴 문장 → 문장 claim 추가 · 공백 없이 이어진 두 경험 → 덮이지 않은 둘째만 추가 · 여러 경험(`!`·`?`·`。`·공백 없음)과 `3.5` → 1인칭 3문장만 · 전체를 포함한 claim(앞뒤 공백)은 중복 없음. integ: 그 출력 → claims 2개 → 채택 → **첫 claim 만 확인(`confirmClaims [0]`) → 미확인 [1] 남음 → `updateContentMeta` review → ready 가 `unconfirmed_experience_claims`** |
| [P2] writing.ts:489 추정을 실제 usage 로 저장 | unit 7행(`confirmedUsageOf` 없음 / usage 없음·이상·열 범위 밖에서 null 이 아님 / 응답 없는 실패 뒤). integ 6행(usage_source 없음, usage 이상한 성공·usage 없는 인용 검증 실패에서 tokens 에 추정값) | provider: `#confirmed` WeakMap 에는 **확인된 usage 만**(없으면 null) 넣고 `confirmedUsageOf(input)` 을 추가. `usageOf` 는 호환용(확인값 → 없으면 추정). db: `successUsage` — live 는 `confirmedUsageOf` 만, 없으면 usage null → 예약액·tokens NULL. 모의는 기존 결정적 추정(estimate). `liveFailureUsage` 도 `confirmedUsageOf` 만 쓴다(추정값 안 씀). `settleLedgerSucceeded(…, usage \| null, at, source)`·`settleLedgerFailed(…, known)` 이 `pricing_snapshot.usage_source`(`provider`·`estimate`·`none`)를 남긴다. 실패 정산의 usage_source 는 LLM 경로(`known` 을 넘길 때)만 — STT 실패 정산은 그대로. **열 정의 확인**: `usage_ledger.tokens_in/tokens_out` 은 `integer` **nullable**(schema.ts·migration 0008) → 모르면 NULL 로 둔다(추정값 저장 없음). 예산 합계는 그대로 확정액(actual_amount) | unit: 유효 → 그 값 · 없음/이상/2^31/출력 2^31/캐시 합 초과 → null(usageOf 는 추정, 실패 e.usage null) · 529 뒤 null. integ: 성공 유효 → provider·tokens · 성공 usage 이상 → 성공 run·예약액·tokens NULL·none · usage 없음 + 인용 검증 실패 → 예약액·NULL·none · 529 → NULL·none · refusal + usage → provider · 모의 성공 → estimate |
| [P2] .env.example:37 등 설명 | (설명 문제) | 위 "초과 동작" 1~4 로 고침: `packages/domain/src/budget.ts` 머리 (1)~(4), `llm-live.ts`, `config.ts`, `packages/db/src/budget.ts` reserveOrThrow 주석, `llm-anthropic.ts` 머리, `.env.example`, 설정 화면 문구("공급자가 사용량을 보고하면 그 값으로 확정 … 보고가 없으면 예약액 … 이번 달 합계(초과액 포함)가 월 상한을 넘게 되는 요청부터 거부 … 동시에 진행 중인 요청들의 초과액은 합쳐질 수 있습니다(LLM_LIVE_MAX_RUNS=1 이면 한 건)"), 이 문서 | 시험 (a)·(b) 가 설명 3·4 를 고정 |
| 놓친 (a) 실제 > 예약·1회 상한, 월 잔여 충분 | d7da959 에서 통과(동작 기록) | 코드 변경 없음, 설명 3 에 명시 | integ: 1회 0.5·월 10, usage 200000/4096(0.88 USD) → over_budget, 다음 요청 성공(호출 2번) |
| 놓친 (b) 횟수 제한 없는 동시 초과 누적 | d7da959 에서 통과(동작 기록) | 코드 변경 없음, 설명 4 에 명시(남은 위험) | integ: 월 0.3, 두 호출이 모두 공급자 호출 중일 때까지 응답을 붙잡는 게이트, 각 usage 0.88 → 둘 다 over_budget, **월 상한을 넘은 양 > 어느 한 호출의 초과액**, 그 뒤 요청은 `budget_exceeded` |
| 놓친 (c) JS 안전 정수지만 DB 범위 밖 | integ 2행 실패(2^31 tokens → integer 열 오류 / 금액이 numeric(18,6) 밖 → `AmountRangeError` 로 성공 트랜잭션이 깨짐) | `MAX_TOKEN_COLUMN = 2_147_483_647`(domain): provider `readUsage` 와 domain `failureUsageOf` 가 각 값·입력 합계가 넘으면 확인된 usage 가 아님. db `storableUsage`: provider usage 의 비용이 numeric(18,6) 밖이면 확인된 usage 로 쓰지 않음(예약액·NULL·none). 모의 추정은 기존대로 `AmountRangeError` | unit(2^31 3종) · domain `failureUsageOf` 경계 · integ: input 2^31 성공 → 예약액·NULL·none · 입력 단가 999999999 + usage 2e9(비용 > numeric 최대) 성공·refusal → 두 행 모두 settled·NULL·none, DB 오류 없음 |
| 놓친 (d) approval_ref 원장의 export→restore, 보존 정리 | d7da959 에서 통과 | 코드 변경 없음. **보존 정리 확인**: `packages/db/src/retention.ts`·`ops.ts` 와 db 패키지 전체에 `usage_ledger` 를 지우는 코드가 없다(grep `delete(usageLedger`·`delete from usage_ledger` 0건, 원장 트리거 없음). 그래서 보존 정리로 횟수가 0 으로 돌아가지 않는다. 다른 owner·DB 로 복원하면 그 대상 owner 의 행으로 들어와 같이 센다 | integ: live 1회(MAX_RUNS=1) → export → 빈 DB(createTestDb)에 empty_only 복원 → 대상 owner 의 `liveRunsUsed(ref)` = 1 |
| 놓친 (e) 같은 입력 객체 동시 재사용 | unit 1행 실패(두 호출 모두 나감) | 제품 경로(writing.ts·variants.ts)는 run 마다 새 `llmInput` 객체를 만든다. 그래도 provider 가 `#inflight` WeakSet 으로 진행 중인 입력 객체의 두 번째 `generate` 를 **보내기 전에** `llm_request_invalid` 로 거부한다(usage 대응이 섞일 수 없게). 순차 재사용은 허용(시작 때 이전 usage 를 지움) | unit: 첫 호출이 공급자 응답을 기다리는 동안 같은 객체로 두 번째 → 거부·fetch 1번, 끝난 뒤 같은 객체 순차 2회 → 성공 |

## 바뀐 파일(FIX round 2)
- 코드: `packages/providers/src/llm-anthropic.ts`(`confirmedUsageOf`·`#confirmed`·`#inflight`·`readUsage` 범위·`splitSentencesStrict`·전체 포함 판정·주석), `packages/providers/src/llm.ts`(`LlmProvider.confirmedUsageOf?`), `packages/domain/src/budget.ts`(`MAX_TOKEN_COLUMN`·`UsageSource`·`failureUsageOf` 범위·머리 주석), `packages/domain/src/llm-live.ts`·`config.ts`(주석), `packages/db/src/budget.ts`(`storableUsage`·`settleLedgerSucceeded` usage null·source·`settleLedgerFailed` usage_source·주석), `packages/db/src/writing.ts`(`successUsage`·`liveFailureUsage` 확인값만·`AssistLlm.confirmedUsageOf?`), `packages/db/src/variants.ts`(`successUsage`·쓰지 않게 된 import 제거), `apps/web/app/settings/page.tsx`(문구), `.env.example`(문구)
- 시험: `llm-anthropic.test.ts`·`budget.test.ts`·`live-llm.test.ts` 에 FIX2 블록 추가(import 추가). 기존 단언은 바꾸거나 지우지 않음. migration 없음

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, 실행 전 node 프로세스 0개 확인)
| 명령 | 결과 |
|---|---|
| 재현(수정 전): unit `llm-anthropic.test.ts` | 11 failed / 72 passed |
| 재현(수정 전): unit `budget.test.ts` | 1 failed / 43 passed |
| 재현(수정 전): integration `live-llm.test.ts` | 9 failed(첫 실행 10 — (b) 단언 오류, 게이트로 다시 쓴 (b)·(a)·(d) 는 d7da959 에서 통과) |
| 수정 후 단독: unit `packages/providers/src` + `budget.test.ts` | 16 files, 560 passed |
| 수정 후 단독: integration live-llm·budget-claims·writing·variants | 4 files, 126 passed |
| `bash .handoffs/run-checks.sh FIX2-LIVEL1` → `.handoffs/checks-FIX2-LIVEL1.log` | **LINT=0 · TYPECHECK=0 · BUILD=0 · UNIT=0(56 files, 1381 tests) · INTEG=0(37 files, 778 tests) · DRILL=0(불변식 위반 0건) · MIGRATE=0 · DRILL_RESTORE=0(PASS)** — 시간 초과·워커 비정상 종료 없음, 단독 재실행 불필요 |

## 남은 위험(FIX round 2 기준)
1. 예약은 추정이다. 확인된 실제액이 예약을 넘는 크기는 증명되지 않은 가정 2개(토큰 ≤ 바이트, 틀 여유 2048)에 달려 있다.
2. **동시 초과 누적**: `LLM_LIVE_MAX_RUNS` 가 없거나 2 이상이면, 진행 중인 호출들이 각각 예약을 넘을 때 초과액이 합쳐져 월 상한을 그 합만큼 넘을 수 있다(시험 (b)). 한 호출분으로 묶이는 것은 `LLM_LIVE_MAX_RUNS=1` 일 때뿐이다.
3. 1회 상한은 예약 추정에만 적용된다. 실제액이 1회 상한을 넘은 호출은 막지 못하고, 그 뒤 요청도 월 잔여가 있으면 허용된다(시험 (a)).
4. usage 를 모르는 경우(HTTP 오류·시간 초과·usage 없음·이상값·DB 범위 밖)에는 예약액으로 확정한다. 실제 청구액과 다를 수 있고(크거나 작게), tokens 는 NULL 이다.
5. **Postgres 드라이버 동시성 미검증**: `LLM_LIVE_MAX_RUNS` 의 동시 안전성(owner 행 `FOR UPDATE` → 세기 → 같은 트랜잭션 삽입)과 예약 직렬화는 **PGlite 에서만** 시험했다. 이 앱의 운영 DB 도 지금은 PGlite 이고, `DB_DRIVER=postgres`(다른 연결·READ COMMITTED)에서는 **시험하지 않았다**.
6. 1인칭 판별은 정규식 휴리스틱이라 주어를 생략한 경험은 놓친다. 새 분리기는 약어 뒤 공백에서 끊을 수 있다(확인 대상만 늘어남).
7. `usage_source` 는 스냅숏 jsonb 키라 DB 제약이 없다(값 검증은 코드에서만). 이전 원장 행에는 이 키가 없다(LIVE-L1 이전 행 = 출처 미표시).

## Codex 에게 묻는 것(FIX round 2)
1. "덮임 = 기존 claim 이 문장 전체를 포함" 판정과 `splitSentencesStrict` 규칙(다음 글자가 영문·숫자면 끊지 않음)에 우회 경로가 남는가? 예: 한 문장 안의 두 경험을 쉼표로 잇는 경우(한 claim 으로 묶임 — 확인 한 번으로 둘 다 해결됨).
2. live 성공인데 usage 를 모를 때 예약액으로 확정(tokens NULL, `usage_source none`)하는 것이 맞는가, 아니면 그 run 을 실패로 봐야 하는가(현재는 제안을 저장하는 성공)?
3. `usage_source` 를 `pricing_snapshot` 안에 둔 것(migration 없음)이 충분한가, 별도 열·CHECK 가 필요한가?
4. 같은 입력 객체 동시 호출을 거부(`llm_request_invalid`, 보내기 전)하는 방식이 호출별 키보다 나은가?
5. DB 범위 밖 usage(정수 2^31, 금액 numeric 초과)를 "확인된 usage 아님"으로 보고 예약액으로 확정하는 것이 맞는가(실제로는 큰 비용이 났을 수 있음 — 숨김이 되지 않는가)?


### FIX round 2 — 오케스트레이터 기록
- FIX2 HEAD: ea5954b02ab78d6a7ed4d9183070c66e7fb4c41c (code only, D28). BASE f170ecd.
- checks-FIX2-LIVEL1: lint 0 · typecheck 0 · build 0 · unit 0(56 파일 · 1381) · integration 0(37 파일 · 778) · drill:mock 0 · db:migrate 0 · drill:restore 0(PASS). 재실행 없음.

# FIX round 3 (Codex review-FIX2-LIVEL1, CHANGES_REQUESTED on ea5954b)
- BASE_SHA: 84aa2f0 (ea5954b + 판정·인계 docs 커밋, 코드는 ea5954b 와 같음). HEAD_SHA: uncommitted (orchestrator commits). `git add -A` 하지 않음.
- 수정하지 않음: `.env.local`·`./data`·`docs/handoffs/*`·`docs/DECISIONS.md`·`.claude/`. External calls: **none**(Anthropic 요청 0, 의존성 변경 없음).
- 재현: 고치기 전에(작업 트리 = 84aa2f0, 코드 = ea5954b) 새 시험만 추가해 실행했다.
  - unit(`llm-anthropic.test.ts`·`budget.test.ts`·`bundle.test.ts`) FIX3 블록: **11 failed / 147 passed**.
  - integration `live-llm.test.ts` FIX3 블록: **6 failed / 39 passed**.
  - FIX3 시험 중 "여러 문단"·"정확히 같은 claim 이 덮음"은 ea5954b 에서도 통과했다(규칙이 바뀌어도 유지되는 동작).
- **설계 전환(1인칭 영역, 3라운드 연속 지적)**: 문장 분리를 없애고 **문단 단위 + 정규화 텍스트 완전 일치**로 바꿨다. 포함·부분 일치는 어디에도 쓰지 않는다.

## 확정액 규칙(설정·/ops·`.env.example`·코드 주석이 같은 문장을 쓴다 — `LIVE_SETTLEMENT_POLICY_TEXT`)
확정액은 이 앱의 예산 기록이며 **Anthropic 청구액과 같다고 보장하지 않는다**.
| 경우 | 확정액 | tokens | usage_source |
|---|---|---|---|
| 성공 + 공급자 보고 usage(열·금액 범위 안) | 보고 토큰 × 설정 단가 | 보고값 | provider |
| 실패 + 보고 usage(범위 안) | max(예약액, 보고 비용) | 보고값 | provider |
| usage 모름(보고 없음·형식 오류·응답 없음) | 예약액 | NULL | none |
| 보고 usage 가 열(2^31-1)·금액(numeric(18,6)) 범위 밖 | 예약액 + 스냅숏에 `reported_tokens_in/out`·`reported_cost`(10진 문자열) 보존 | NULL | provider_unstorable → **그 owner 의 새 live 예약 모두 429 `live_usage_unresolved`**(운영자 수동 해결 전까지) |
| 모의 | 결정적 추정(글자/3) | 추정값 | estimate |
그 밖은 FIX round 2 의 "초과 동작" 2~4 그대로(초과액 기록, 월 합계 기준 거부, 1회 상한은 예약 추정에만, 동시 초과 누적 — `LLM_LIVE_MAX_RUNS=1` 이면 한 건).

## 지적 → 재현 → 수정 → 시험
| 지적 | 재현(ea5954b 에서 실패) | 수정 | 시험(수정 후 통과) |
|---|---|---|---|
| [P1] :310 부분 일치(부정·인용·가정문 claim 이 본문을 덮음) + [P1] :372 인용문 안 종결 부호에서 분리 | unit 6행: 부정·인용·가정문으로 감싼 긴 claim 3종이 본문을 덮음 / `저는 “좋습니다.”라고 답하고 계약을 따냈습니다.` 가 두 조각으로 나뉨 / 한 문단의 두 경험이 두 claim / 짧은 부분 claim 이 문단을 못 덮는지. integ 1행 | `splitSentencesStrict` 와 관련 상수를 **삭제**하고, `splitParagraphs`(줄바꿈 경계만 — `\r?\n`·`\r`, 빈 줄 포함, trim, 빈 문단 버림)로 바꿨다. 1인칭 표현이 든 문단마다, experience claim 의 정규화 텍스트(NFKC·공백 접기·trim)가 문단 정규화 텍스트와 **정확히 같을 때만** 덮였다고 본다. 아니면 문단 전체를 `experience`·`needs_user_confirmation:true`·`source_refs:[]` claim 으로 더한다. 모델 claim 의 1인칭 재분류는 그대로 | unit: 부정·인용·가정 3종 → 문단 claim 추가 · 인용문 품은 문단 → 문단 전체 한 claim · 한 문단 두 경험 → 한 claim · 여러 문단(빈 줄·줄바꿈) → 1인칭 문단마다 · 정규화 후 같은 claim 은 덮고 짧은 부분 claim 은 못 덮음. integ: 인용문 문단 → claim 저장 → 채택 → review → **ready 409 `unconfirmed_experience_claims` → 그 claim 확인 → ready 성공** |
| [P1] db/budget.ts:255 저장 범위 밖 보고 usage 를 버림 | unit 1행(2^31 보고값이 null 로 버려짐). integ 5행(assist 성공·assist 실패·variant·금액 범위 밖 → `none` 으로 끝나고 다음 live 예약이 허용됨) | provider `readUsage`·domain `failureUsageOf` 는 **0 이상 안전 정수면 그대로** 돌려준다(열 범위 판정을 하지 않음). db `judgeUsage` 가 판정한다: 토큰이 `MAX_TOKEN_COLUMN` 밖이거나 비용이 numeric(18,6) 밖이면 `unstorable` → 예약액 확정, tokens NULL, 스냅숏 `usage_source:'provider_unstorable'` + `reported_tokens_in/out`·`reported_cost`(10진 문자열, bigint 정확). `reserveOrThrow`(live 만): owner 잠금 뒤 `hasUnresolvedLiveUsage`(그 owner 의 provider_unstorable 행 존재, 기간·상태 무관) → 있으면 `LiveUsageUnresolvedError`(429 `live_usage_unresolved`, 아무것도 쓰지 않음·호출 0). 검사 순서: 잠금 → 미해결 → 횟수 → 예산. 모의 예약은 막지 않는다. 폼 오류 코드·문구 추가. **해결은 운영자 수동 작업**(해당 행의 usage_source 를 확인·정리) — 이 작업에 화면·API 없음. **단가 범위**: `LLM_PRICE_INPUT/OUTPUT_PER_1K` 를 0~100(1K 토큰당)으로 제한했다(2^31-1 토큰 × 100/1000 × 2 ≈ 4.29e8 USD(429,496,729.4) < numeric(18,6) 최대 ≈ 1e12 — 열 범위 안의 토큰이면 비용이 늘 저장 가능. FIX round 4 정정: 처음에 4.3e11 로 잘못 적었다). 차단은 이 범위와 상관없이 동작한다(설정을 우회한 정책으로 시험) | unit: 2^31 보고값을 confirmedUsageOf·e.usage 로 그대로. domain: 단가 100 허용·100.000001·101·999999999 거부, 최대 토큰 × 100 이 numeric 안. integ: **assist 성공**(보고값·계산 비용 문자열 보존, 예약액, 다음 live 429·호출 0·행 0, 모의는 허용) · **assist 실패(refusal)**(failed·보존, **유한 월 상한 10 에서 두 번째 live 예약 거부**) · **variant 성공**(보존, 이후 variant·assist live 모두 거부) · 금액 범위 밖(설정을 우회한 정책 객체) → 보존·차단 |
| [P2] settings/page.tsx:103 문구 | (설명 문제) | 확정액 규칙을 한 상수 `LIVE_SETTLEMENT_POLICY_TEXT`(domain budget.ts)로 만들어 설정 화면(준비됨 문구)·/ops(live 모드일 때 "AI 비용 확정 규칙")에 쓴다. `.env.example`·domain budget.ts 머리 (1) 도 같은 4가지 경우로 고쳤다. "청구액과 같다"는 표현은 쓰지 않는다 | lint·typecheck·build. 문구는 시험으로 고정하지 않음 |
| 놓친 (a) 같은 입력 객체 재사용 | unit 2행(순차 재사용이 나감) | `#inflight` 를 `#used` WeakSet 으로 바꿨다: 한 번 쓴 입력 객체로 두 번째 `generate` 는 **동시든 순차든 보내기 전에** `llm_request_invalid`. 그래서 `confirmedUsageOf`·`usageOf(input)` 는 그 객체의 유일한 호출만 가리킨다 | unit: 성공 뒤 재사용 거부·fetch 1·usage 는 첫 호출 / 실패 뒤 재사용 거부 / 진행 중 재사용 거부(기존) |
| 놓친 (b) export→restore 의 usage_source | unit 1행(`bogus` 등이 통과) + integ 1행 | `checkIntegrity`(domain bundle.ts): 원장 스냅숏에 `usage_source` 키가 **있으면** `provider`·`estimate`·`none`·`provider_unstorable` 중 하나여야 하고, 아니면 integrity 오류(복원 거부 — 다른 무결성 오류와 같은 경로). 키가 없으면(이전 행) 그대로 통과하고 복원도 키 없이 남긴다(none 으로 바꾸지 않음) | unit: 네 값 통과·키 없음 통과·`bogus`·빈 문자열·대문자·숫자·null·true·배열 → integrity. integ: 키를 지운 이전 행 + provider_unstorable 행을 내보내 빈 DB 에 복원 → 이전 행은 키 없음, unstorable 행 보존, **복원된 owner 의 live 예약이 `live_usage_unresolved`(호출 0)** |
| 놓친 (c) Postgres 다른 연결 경쟁 | — | **시험하지 않음**(이 환경에 Postgres 서버가 없다). 횟수 제한·미해결 차단·예산 직렬화는 owner 행 `FOR UPDATE` + 같은 트랜잭션 삽입에 기대며 PGlite 에서만 확인했다 | 없음(미검증으로 표시) |

## 의도한 동작 변경으로 고친 기존 시험(약화 아님 — 바뀐 규칙에 맞춘 단언, 주석으로 표시)
- `llm-anthropic.test.ts`
  - FIX1 (b): 재사용 후 usage 가 추정값 → 재사용 **거부**·usage 는 첫 호출.
  - FIX1 (c) 2개: 문장 claim → 문단 claim. "덮음"은 정확히 같은 문단으로.
  - FIX2 문장 분리 2개: 문단 전체 한 claim.
  - FIX2 열 범위 밖 3행: null 이 아니라 보고값을 돌려줌(별도 행으로 분리). 없음·이상 행에는 "안전 정수 밖"을 더함.
  - FIX2 (e) 꼬리: 순차 재사용 허용 → 거부.
- `budget.test.ts` FIX2 `failureUsageOf`: 2^31 null → 보고값 그대로, 안전 정수 밖·음수 null 을 더함.
- `live-llm.test.ts`
  - FIX1·FIX2 게이트 시험의 claim 텍스트: 문장 → 문단.
  - FIX2 (c) 2^31: `none` → `provider_unstorable` + 보고값.
  - FIX2 (c) 금액: 설정 999999999 로 만든 정책 → 설정 거부를 단언. 정산 경로는 FIX3 금액 시험(설정을 우회한 정책 객체)이 더 강하게 확인한다.

## 바뀐 파일(FIX round 3)
- 코드:
  - `packages/providers/src/llm-anthropic.ts`: `splitParagraphs`·완전 일치, `splitSentencesStrict` 삭제, `#used`, 열 범위 판정 제거.
  - `packages/domain/src/budget.ts`: `UsageSource` 에 provider_unstorable, `USAGE_SOURCES`, `LiveUsageUnresolvedError`, `LIVE_SETTLEMENT_POLICY_TEXT`, `failureUsageOf` 범위, 머리 주석.
  - `packages/domain/src/config.ts`: 단가 0~100.
  - `packages/domain/src/bundle.ts`: usage_source 무결성.
  - `packages/db/src/budget.ts`: `judgeUsage`·unstorable 보존·`hasUnresolvedLiveUsage`·`reserveOrThrow` 차단.
  - `apps/web/lib/writing.ts`: 폼 코드 `live_usage_unresolved`.
  - `apps/web/app/settings/page.tsx`·`apps/web/app/ops/page.tsx`: 규칙 문구.
  - `.env.example`.
- 시험: `llm-anthropic.test.ts`·`budget.test.ts`·`bundle.test.ts`·`live-llm.test.ts`(FIX3 블록 + 위 의도한 변경).
- migration 없음.

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, 실행 전 node 프로세스 0개 확인)
| 명령 | 결과 |
|---|---|
| 재현(수정 전): unit `llm-anthropic.test.ts`·`budget.test.ts`·`bundle.test.ts` | 11 failed / 147 passed |
| 재현(수정 전): integration `live-llm.test.ts` | 6 failed / 39 passed |
| 수정 후 단독: unit `packages/providers/src` + `packages/domain/src` | 46 files, 1287 passed |
| 수정 후 단독: integration live-llm(45 passed), live-llm·budget-claims·writing·variants·export-restore | 5 files — 기존 시험 4건을 바뀐 규칙에 맞춘 뒤 모두 통과 |
| `bash .handoffs/run-checks.sh FIX3-LIVEL1` → `.handoffs/checks-FIX3-LIVEL1.log` | **LINT=0 · TYPECHECK=0 · BUILD=0 · UNIT=0(56 files, 1394 tests) · INTEG=0(37 files, 784 tests) · DRILL=0(불변식 위반 0건) · MIGRATE=0 · DRILL_RESTORE=0(PASS)** — 시간 초과·워커 비정상 종료 없음, 단독 재실행 불필요 |

## 남은 위험(FIX round 3 기준)
1. **미해결 차단의 해결 경로가 수동**이다: provider_unstorable 행이 생기면 그 owner 의 실제 호출이 모두 막힌다. 해결은 운영자가 원장을 직접 확인·정리해야 하고 화면·API 가 없다(이 작업 범위 밖). 단가 0~100 제한 아래에서는 2^31 이상 토큰 보고가 아니면 생기지 않는다.
2. 문단 단위는 보수적이다. 긴 문단은 문단 전체를 확인해야 해서 확인 부담이 늘고, 모델이 문단 전체와 같은 claim 을 만들지 않으면 늘 서버 claim 이 더해진다(중복처럼 보일 수 있음). 1인칭 판별은 여전히 정규식이라 주어를 생략한 경험은 놓친다.
3. 예약은 추정이고 동시 초과는 누적된다(`LLM_LIVE_MAX_RUNS=1` 이면 한 건). 1회 상한은 예약 추정에만 적용된다.
4. 확정액은 예산 회계 값이다 — Anthropic 청구액과 다를 수 있다(usage 모름·실패 시 예약액 등).
5. **Postgres 드라이버(다른 연결) 경쟁: 미검증.** 횟수 제한·미해결 차단·예산 직렬화는 PGlite 에서만 시험했다.
6. 같은 입력 객체 거부는 provider 인스턴스 안에서만 동작한다(인스턴스가 다르면 각자 1회). 제품 경로는 run 마다 새 객체·요청마다 새 provider 다.

## Codex 에게 묻는 것(FIX round 3)
1. 문단 단위 + 정규화 완전 일치 규칙에 남은 우회가 있는가? (예: 모델이 문단과 글자까지 같은 claim 을 `opinion`/`fact` 로 내면 1인칭 표현이 있으므로 experience 로 재분류된다 — 그대로 덮음으로 본다.)
2. provider_unstorable 차단의 범위(그 owner 의 모든 live 예약, 기간·상태·승인 기록 무관)가 맞는가? 해결 절차를 화면 없이 운영자 수동으로 두는 것이 받아들일 만한가?
3. 단가 0~100 제한이 운영상 너무 좁거나 넓은가?
4. 복원 무결성: `usage_source` 키가 있으면 네 값만, 없으면 통과 — 이 구분이 충분한가? provider_unstorable 행의 `reported_*` 키도 검증해야 하는가?


### FIX round 3 — 오케스트레이터 기록
- FIX3 HEAD: a4da041c24167fdbc8934c7577530931bbc0db33 (code only, D28). BASE 84aa2f0.
- checks-FIX3-LIVEL1: lint 0 · typecheck 0 · build 0 · unit 0(56 파일 · 1394) · integration 0(37 파일 · 784) · drill:mock 0 · db:migrate 0 · drill:restore 0(PASS). 재실행 없음.

# FIX round 4 (Codex review-FIX3-LIVEL1, CHANGES_REQUESTED on a4da041 — P2 1건)
- BASE_SHA: e0d9aa2 (a4da041 + 판정·인계 docs, 코드는 a4da041 과 같음). HEAD_SHA: uncommitted (orchestrator commits). `git add -A` 하지 않음.
- 수정하지 않음: `.env.local`·`./data`·`docs/handoffs/*`·`docs/DECISIONS.md`·`.claude/`. External calls: **none**.
- 재현(작업 트리 = e0d9aa2, 코드 = a4da041 에서 새 시험만 추가):
  - unit(`bundle.test.ts`·`llm-anthropic.test.ts`) **4 failed / 117 passed**: P2 보고값 무결성 1건, 한 줄바꿈 문단 2건, NFKC→NFC 1건.
  - integration `live-llm.test.ts` 새 2건은 a4da041 에서도 **통과**: (d) 본문 수정 뒤 동작 고정, MAX_SAFE 보고값의 export→restore 보존. 지금 동작을 기록하는 시험이다.
- **정정 (FIX round 3 문서)**: 단가 상한 계산 "≈ 4.3e11" → **≈ 4.29e8 USD(429,496,729.4)**. FIX round 3 표 안의 문장도 고쳤다.

## 지적 → 재현 → 수정 → 시험
| 항목 | 재현(a4da041) | 수정 | 시험 |
|---|---|---|---|
| [P2] bundle.ts:1315 provider_unstorable 보고값 무결성 | unit 1건 실패: 보고값 없음·음수·소수·지수·잘못된 비용, 다른 출처·키 없는 행의 reported_* 가 모두 통과 | `checkIntegrity`: `usage_source === 'provider_unstorable'` 이면 세 보고값이 필수. **토큰**: `^(0\|[1-9]\d{0,39})$`(숫자만, 부호·소수점·지수 없음, "0" 외 앞자리 0 없음, 최대 40자리 — 안전 정수 너머도 문자열로 정확). **비용**: `^(0\|[1-9]\d{0,39})\.\d{6}$`(fromMicro 출력 형식 — 정수부 + 소수 정확히 6자리). 다른 출처이거나 usage_source 가 없는(이전) 행에 `reported_*` 가 하나라도 있으면 integrity 오류. 복원은 parseBundle → checkIntegrity 경로라 다른 무결성 오류처럼 거부된다 | unit: 정상 4종(보통·0·MAX_SAFE 근처와 너머·30자리) 통과 / 오류 18종(필드 하나 없음 3·음수·소수·지수·앞자리 0·부호·앞 공백·숫자형·빈 문자열·비용 문자·음수·소수 1자리·소수 없음·지수·앞자리 0·숫자형) / reported_* + provider·estimate·none / reported_* + usage_source 없음 → integrity. integ: `Number.MAX_SAFE_INTEGER` 입력 usage → `reported_tokens_in '9007199254740991'`·계산 비용 문자열, 스냅숏을 `'9007199254740993'`(안전 정수 너머)로 바꿔 export → 빈 DB 복원 → **같은 문자열**, 복원 owner 의 `hasUnresolvedLiveUsage` = true |
| 놓친 (a) 한 줄바꿈 | unit 2건 실패(`저는\n두바이에서 …` 가 두 문단으로 나뉨) | `splitParagraphs`: CRLF·CR → LF 로 바꾼 뒤 `\n\s*\n`(빈 줄 — 공백만 있는 줄 포함)으로만 나눈다. 한 줄바꿈은 문단 안 | unit: `저는\n두바이에서 …` → 한 claim · 빈 줄·공백 줄·CRLF 경계 · 한 줄바꿈 문단과 공백만 다른 claim 은 덮임(정규화가 줄바꿈을 공백으로 접음) |
| 놓친 (b) 유니코드 정규화 | unit 1건 실패(NFKC 라 전각 마침표 claim 이 본문을 덮음) | `normalizeForCoverage` = **NFC** + 공백 접기 + trim, 양쪽에 같은 함수. NFKC(호환 문자 접기)는 덮임을 넓히는 쪽이라 쓰지 않는다 | unit: NFD 한글 claim ↔ NFC 본문, 그 반대 → 덮임 · 전각 마침표 claim 은 덮지 못함 |
| 놓친 (c) claim 길이·개수 제한 | — | **확인 결과 제한이 없다**. `claimSchema.text` 는 `min(1)` 만 있고 max 가 없다. `llmStructuredOutputSchema.claims` 도 개수 제한이 없다. DB `claims.statement` 는 `text` 이다. 제안 본문 길이는 db 층 `MAX_PROPOSAL_BODY`(= MAX_CONTENT_BODY, 넘으면 run 실패 `proposal_too_large`)로 막히므로 문단 claim 은 그보다 길 수 없다. 그래서 자르기·나누기가 필요 없고 **자르지 않는다**(코드 변경 없음) | unit: 1만 자가 넘는 1인칭 문단 → 자르지 않은 한 claim |
| 놓친 (d) 확인 뒤 본문 수정 | 통과(동작 기록) | 코드 변경 없음. **실제 동작**: claims 는 AI 제안 run·제안 버전에 묶인 추가 전용 행이고, 사용자 버전으로 옮겨지지 않는다. 게이트(`listUnconfirmedExperienceClaims`)는 **채택한 run 의 claims** 만 본다. `confirmed` 는 본문이 바뀌어도 영구 해결이다(`removed` 만 현재 본문에 그 문장이 없을 때 유효 — FIX-T06 round 2). 그래서 문단 claim 을 확인한 뒤 사용자가 문단을 고치거나 새 1인칭 경험을 **직접** 써 넣어도 게이트는 다시 막지 않는다 — 사용자가 직접 쓴 글은 확인 대상이 아니다(모의 경로와 같음). AI 제안을 다시 받으면 그 run 의 claims 가 새로 생긴다 | integ: 문단 claim 확인 → 사용자 버전에서 문단 수정 + `제가 직접 팀을 꾸렸습니다.` 추가 → 미확인 [] · review → ready 성공 · claims 행은 원래 문단 하나 그대로 |
| 놓친 (e) provider_unstorable 수동 해결 절차 | — | 아래 "수동 해결 절차"(코드·화면 없음) | — |
| 놓친 (f) 계산 정정 | — | FIX round 3 문장을 ≈4.29e8 로 고침 | — |

## provider_unstorable 수동 해결 절차(운영자 — 코드·화면 없음, 앱 정지 후 DB 직접)
1. **멈춤·백업**: dev/운영 서버를 멈추고(PGlite 는 한 프로세스만) `corepack pnpm export` 로 owner 묶음을 내보내 보관한다. 이 묶음이 원래 증거(보고값 포함)다.
2. **확인**: 해당 행을 조회한다 — `select id, run_id, created_at, reserved_amount, actual_amount, failed, pricing_snapshot from usage_ledger where owner_id = … and pricing_snapshot->>'usage_source' = 'provider_unstorable'`. `reported_tokens_in/out`·`reported_cost` 와 run 의 status·error 를 기록한다.
3. **실제 청구 확인**: Anthropic 콘솔(사용자가 직접)의 그 시각 사용량·청구와 비교한다. 보고값이 비정상(공급자 오류)인지 실제 대량 사용인지 판단한다.
> **FIX2-LIVEL1H2 갱신(4~7)**: LIVEL1-H2 부터 복원 무결성(`checkIntegrity` → `isValidResolution`, `packages/domain/src/bundle.ts`)이 `resolution` 형식을 검사한다. 이전 4단계 예시(키 5개·`<UTC ISO>`)대로 하면 앱은 정상으로 돌지만 **해결 뒤 내보낸 묶음이 복원 때 integrity 로 거부**될 수 있었다(내보내기는 검사하지 않는다). 아래 4~6 은 그 검사와 정확히 같은 규칙이고, 7 에서 묶음을 믿기 전에 읽기 전용 확인을 한다. H2 이전에 이미 손으로 해결한 행이 있으면 최근 묶음을 7-③ 으로 먼저 확인한다(거부되면 6단계의 **정정 문** — FIX3-LIVEL1H2).

4. **보존 — `resolution` 객체(규칙이 닫혀 있다)**: 원래 보고값은 지우지 않는다. 스냅숏에 `resolution` 객체를 덧붙인다. 키는 **정확히 아래 6개** — 하나라도 빠지거나 다른 키(메모·콘솔 참조 등)가 있으면 그 묶음은 복원에서 거부된다.

   | 키 | 값(모두 JSON 문자열) |
   |---|---|
   | `resolved_at` | UTC 시각, **끝이 `Z`**: `YYYY-MM-DDTHH:MM:SS` + 선택 소수 1~6자리 + `Z`(예 `2026-10-20T09:15:00.123456Z`). `+00:00`·`+00`·`T` 대신 공백은 거부 — SQL 의 `to_jsonb(now())`(`…+00:00`)·`now()::text`(`… +00`)는 쓰지 않고 `to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` 를 쓴다 |
   | `resolved_by` | 공백만이 아닌 문자열, 200자 이하 |
   | `reason` | 공백만이 아닌 문자열, 4000자 이하 — 판단 근거·콘솔 확인 결과(5단계 상한을 썼으면 실제 청구액도) |
   | `settled_amount` | 확정할 금액: 정수부(`0` 이거나 앞자리 0 없음, 최대 40자리) + `.` + 소수 **정확히 6자리** — 예 `"9.950000"`. `"9.95"`·숫자 `9.95`·`"09.950000"` 은 거부 |
   | `original_usage_source` | 정확히 `"provider_unstorable"` |
   | `original_reported` | 키 정확히 3개 `reported_tokens_in`·`reported_tokens_out`·`reported_cost` — 6단계에서 최상위에서 옮긴 원래 값 그대로(토큰 = 숫자만 문자열, 비용 = 정수부 + 소수 6자리 문자열) |
5. **재정산 — `settled_amount` 와 `actual_amount` 규칙**: `actual_amount` 를 판단한 금액으로 바꾸고, **`settled_amount` 와 같은 금액**으로 둔다(micro 단위로 비교 — `actual_amount` 9.95 와 `"9.950000"` 은 같다). 예외는 하나뿐: 실제 청구가 numeric(18,6) 열 최대값 또는 월 예산 한도를 넘어 `actual_amount` 를 **그 고정 최대값**(열 최대값이나 월 한도 — "이번 달 남은 예산"이 아님)으로 깎은 경우만 `settled_amount`(실제 청구) > `actual_amount` 가 허용되고, 그때 `actual_amount` 는 `reserved_amount` 보다 커야 한다(위로 재정산이 실제로 일어남). 그래서 거부되는 것: `settled_amount` < `actual_amount`, `actual_amount` 를 예약액 그대로 두고 `settled_amount` 만 큼(재정산을 빠뜨림 — 월 합계가 돈을 모름). 행 `state` 는 `settled` 그대로(provider_unstorable 행은 처음부터 settled). `overage_amount = max(0, actual − reserved)`, `over_budget = actual > reserved`. `tokens_in/out` 은 열 범위 밖이면 NULL.
6. **차단 해제**: `usage_source` 를 `'provider'`(실제 사용으로 확정) 또는 `'none'`(보고값을 믿지 않고 예약액 유지 — 이때 `actual_amount` = `reserved_amount` = `settled_amount`)으로 바꾸고, 최상위 `reported_*` 세 키를 **지워** `resolution.original_reported` 로 옮긴다(최상위에 남으면 FIX4 검사가 거부). `resolution` 이 붙었는데 `usage_source` 가 아직 `provider_unstorable` 인 반쯤 끝난 상태도 거부되므로 **4~6 은 아래 한 문장으로 한 번에** 한다.
   - **채우는 곳은 문 맨 위 `values (…)` 한 줄뿐이다**(FIX3-LIVEL1H2 — 자리표시마다 문 안에 정확히 한 번. `actual_amount`·`overage_amount`·`over_budget` 은 모두 같은 `<ACTUAL>` 하나에서 계산된다). `<LEDGER_ID>`·`<OWNER_ID>` 는 2단계 조회 결과 그대로(소문자 uuid), `<USAGE_SOURCE>` 는 `provider` 또는 `none`, `<ACTUAL>`·`<SETTLED>` 는 소수 **정확히 6자리** 문자열(보통 같은 값, 5단계 상한일 때만 `<ACTUAL>` 이 작다. `<ACTUAL>` 은 열 범위라 정수부 최대 12자리, `<SETTLED>` 는 40자리), 글자 안 작은따옴표는 두 번(`''`). 다른 키를 덧붙이지 않는다.
   - **잘못 채우면 아무 행도 바뀌지 않는다(0행)**: `where` 가 4~6 규칙(복원 검사 `isValidResolution` 과 같은 규칙)을 입력에 그대로 건다 — 출처 `provider`|`none` · `<SETTLED>` 형식 `^(0|[1-9][0-9]{0,39})\.[0-9]{6}$`, `<ACTUAL>` 형식 `^(0|[1-9][0-9]{0,11})\.[0-9]{6}$` · settled = actual, 또는 settled > actual 이고 actual > 예약액(5단계 상한) · `none` 이면 actual = 예약액 · `<RESOLVED_BY>` 는 200자 이하, `<REASON>` 은 4000자 이하이고 둘 다 공백만이 아님(길이는 복원 검사와 같은 UTF-16 길이, 공백은 JS `trim()` 이 지우는 문자와 같은 집합) · 대상 행은 그 owner 의 그 id 이고 `settled`·아직 `provider_unstorable`·최상위 보고값 세 개가 FIX4 형식대로 있음(없으면 `original_reported` 를 만들 수 없으므로 고르지 않는다). `resolved_at` 은 문이 직접 `Z` 로 끝나는 UTC 문자열로 만든다(세션 시간대와 무관). 형식이 아주 틀려 SQL 오류가 나도 아무것도 바뀌지 않는다.
   - **결과는 정확히 1행이어야 한다**: 문은 `returning` 으로 바뀐 행(id·usage_source·actual_amount)을 돌려준다 — psql 류 클라이언트는 `UPDATE 1`, 결과 표를 보여 주는 클라이언트는 1행으로 보인다. `UPDATE 0`·결과 없음이면 아무것도 바뀌지 않은 것이니 값·id 를 다시 보고 고쳐서 **같은 문을 다시** 실행한다. 클라이언트가 개수를 보여 주지 않으면 아래 **확인 조회**로 본다(`target_resolved` = 1). 이미 해결 표시가 붙은 행을 고칠 때는 이 문이 아니라 아래 **정정 문**을 쓴다.

   ```sql
   -- LIVEL1 수동 해결 4~6 (한 문장, FIX3-LIVEL1H2 — 자리표시는 values 한 줄에만, 잘못 채우면 0행, 결과는 정확히 1행)
   with v as (
     select p.*,
            case when p.actual ~ '^(0|[1-9][0-9]{0,11})\.[0-9]{6}$' then p.actual::numeric end as actual_n,
            case when p.settled ~ '^(0|[1-9][0-9]{0,39})\.[0-9]{6}$' then p.settled::numeric end as settled_n
       from (values ('<LEDGER_ID>', '<OWNER_ID>', '<USAGE_SOURCE>', '<ACTUAL>', '<SETTLED>', '<RESOLVED_BY>', '<REASON>'))
            as p(ledger_id, owner_id, src, actual, settled, by_, reason)
   )
   update usage_ledger u
      set pricing_snapshot = (u.pricing_snapshot - 'reported_tokens_in' - 'reported_tokens_out' - 'reported_cost') || jsonb_build_object(
            'usage_source', v.src,
            'resolution', jsonb_build_object(
              'resolved_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'resolved_by', v.by_,
              'reason', v.reason,
              'settled_amount', v.settled,
              'original_usage_source', 'provider_unstorable',
              'original_reported', jsonb_build_object(
                'reported_tokens_in', u.pricing_snapshot -> 'reported_tokens_in',
                'reported_tokens_out', u.pricing_snapshot -> 'reported_tokens_out',
                'reported_cost', u.pricing_snapshot -> 'reported_cost'))),
          actual_amount = v.actual_n,
          overage_amount = greatest(v.actual_n - u.reserved_amount, 0),
          over_budget = v.actual_n > u.reserved_amount
     from v
    -- 행 선택: 그 owner 의 그 한 행, 아직 provider_unstorable, 원래 보고값 세 개가 최상위에 FIX4 형식대로
    where u.id::text = v.ledger_id and u.owner_id::text = v.owner_id and u.state = 'settled'
      and u.pricing_snapshot ->> 'usage_source' = 'provider_unstorable'
      and jsonb_typeof(u.pricing_snapshot -> 'reported_tokens_in') = 'string' and u.pricing_snapshot ->> 'reported_tokens_in' ~ '^(0|[1-9][0-9]{0,39})$'
      and jsonb_typeof(u.pricing_snapshot -> 'reported_tokens_out') = 'string' and u.pricing_snapshot ->> 'reported_tokens_out' ~ '^(0|[1-9][0-9]{0,39})$'
      and jsonb_typeof(u.pricing_snapshot -> 'reported_cost') = 'string' and u.pricing_snapshot ->> 'reported_cost' ~ '^(0|[1-9][0-9]{0,39})\.[0-9]{6}$'
      -- 입력 검사(복원 검사 isValidResolution 과 같은 규칙) — 하나라도 어긋나면 0행
      and v.src in ('provider', 'none')
      and v.actual_n is not null and v.settled_n is not null
      and (v.settled_n = v.actual_n or (v.settled_n > v.actual_n and v.actual_n > u.reserved_amount))
      and (v.src = 'provider' or v.actual_n = u.reserved_amount)
      and v.by_ !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$'
      and char_length(v.by_) + char_length(regexp_replace(v.by_, '[^\U00010000-\U0010FFFF]', '', 'g')) <= 200
      and v.reason !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$'
      and char_length(v.reason) + char_length(regexp_replace(v.reason, '[^\U00010000-\U0010FFFF]', '', 'g')) <= 4000
   returning u.id, u.pricing_snapshot ->> 'usage_source' as usage_source, u.actual_amount;
   ```

   **확인 조회(읽기 전용)** — 위 4~6 문이나 아래 정정 문을 실행한 뒤. `target_resolved` 가 **1** 이어야 하고(그 행이 provider/none + resolution), `unresolved_rows` 는 그 owner 에 아직 남은 `provider_unstorable` 행 수다(모두 해결했으면 0 — 0 이 아니면 남은 행마다 2~6 을 한다).

   ```sql
   -- LIVEL1 수동 해결 확인 (읽기 전용, FIX3-LIVEL1H2)
   select count(*) filter (where id::text = '<LEDGER_ID>' and pricing_snapshot ->> 'usage_source' in ('provider', 'none')
                                 and pricing_snapshot -> 'resolution' is not null) as target_resolved,
          count(*) filter (where pricing_snapshot ->> 'usage_source' = 'provider_unstorable') as unresolved_rows
     from usage_ledger
    where owner_id::text = '<OWNER_ID>';
   ```

   **정정 문(이미 `resolution` 이 붙었는데 7-③ 이 거부한 행)** — FIX3 이전 문(입력 검사 없음)이나 H2 이전 손 작업으로 해결 표시는 붙었지만 형식이 틀린 행(예: `settled_amount` `"9.95"`, `+00:00` 시각, 빈 `resolved_by`, 잘못된 `usage_source`, settled ≠ actual)은 4~6 문으로 **다시 고치지 않는다** — 그 문은 아직 `provider_unstorable` 이고 최상위 보고값이 있는 행만 고르므로 0행이고, 조건을 지워 억지로 돌리면 이미 옮겨 둔 원래 보고값 자리를 null 로 덮는다. 대신 아래 문을 쓴다. 바꾸는 것은 `resolution` 의 `resolved_at`(지금 시각으로 다시)·`resolved_by`·`reason`·`settled_amount` 네 키와 `usage_source`(같은 `provider`|`none` 검사)·`actual_amount`·`overage_amount`·`over_budget` 뿐이고, `resolution.original_usage_source`·**`resolution.original_reported` 는 읽기만 하고 그대로 둔다**(다시 만들거나 지우지 않음). 채우는 법·입력 검사·"결과는 정확히 1행"·확인 조회는 4~6 문과 같다. 행 조건: 그 owner 의 그 id·`settled`, `resolution` 이 객체이고 바꿀 네 키 말고는 `original_usage_source`='provider_unstorable' 과 `original_reported`(키 정확히 3개, FIX4 형식 문자열) 두 개뿐, 최상위 `reported_*` 없음. 이 조건 때문에 0행이면(메모 같은 다른 키가 더 있음, `original_reported` 가 없거나 형식이 틀림 — H2 이전 키 5개 예시대로 한 행 등) **SQL 을 더 고치지 말고 멈춘다** — 원래 보고값은 1단계 백업 묶음에 있으니 그 묶음과 2단계 조회 결과를 보관한 채 별도 작업으로 다룬다.

   ```sql
   -- LIVEL1 수동 해결 정정 (이미 resolution 이 있는 행, FIX3-LIVEL1H2 — original_reported 는 그대로, 잘못 채우면 0행, 결과는 정확히 1행)
   with v as (
     select p.*,
            case when p.actual ~ '^(0|[1-9][0-9]{0,11})\.[0-9]{6}$' then p.actual::numeric end as actual_n,
            case when p.settled ~ '^(0|[1-9][0-9]{0,39})\.[0-9]{6}$' then p.settled::numeric end as settled_n
       from (values ('<LEDGER_ID>', '<OWNER_ID>', '<USAGE_SOURCE>', '<ACTUAL>', '<SETTLED>', '<RESOLVED_BY>', '<REASON>'))
            as p(ledger_id, owner_id, src, actual, settled, by_, reason)
   )
   update usage_ledger u
      set pricing_snapshot = u.pricing_snapshot || jsonb_build_object(
            'usage_source', v.src,
            'resolution', (u.pricing_snapshot -> 'resolution') || jsonb_build_object(
              'resolved_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'resolved_by', v.by_,
              'reason', v.reason,
              'settled_amount', v.settled)),
          actual_amount = v.actual_n,
          overage_amount = greatest(v.actual_n - u.reserved_amount, 0),
          over_budget = v.actual_n > u.reserved_amount
     from v
    -- 행 선택: 그 owner 의 그 한 행, 이미 있는 resolution 은 바꿀 네 키 + original_usage_source + original_reported(형식 그대로)뿐, 최상위 reported_* 없음
    where u.id::text = v.ledger_id and u.owner_id::text = v.owner_id and u.state = 'settled'
      and jsonb_typeof(u.pricing_snapshot -> 'resolution') = 'object'
      and (u.pricing_snapshot -> 'resolution') - 'resolved_at' - 'resolved_by' - 'reason' - 'settled_amount'
          = jsonb_build_object('original_usage_source', 'provider_unstorable', 'original_reported', jsonb_build_object(
              'reported_tokens_in', u.pricing_snapshot #> '{resolution,original_reported,reported_tokens_in}',
              'reported_tokens_out', u.pricing_snapshot #> '{resolution,original_reported,reported_tokens_out}',
              'reported_cost', u.pricing_snapshot #> '{resolution,original_reported,reported_cost}'))
      and jsonb_typeof(u.pricing_snapshot #> '{resolution,original_reported,reported_tokens_in}') = 'string'
      and u.pricing_snapshot #>> '{resolution,original_reported,reported_tokens_in}' ~ '^(0|[1-9][0-9]{0,39})$'
      and jsonb_typeof(u.pricing_snapshot #> '{resolution,original_reported,reported_tokens_out}') = 'string'
      and u.pricing_snapshot #>> '{resolution,original_reported,reported_tokens_out}' ~ '^(0|[1-9][0-9]{0,39})$'
      and jsonb_typeof(u.pricing_snapshot #> '{resolution,original_reported,reported_cost}') = 'string'
      and u.pricing_snapshot #>> '{resolution,original_reported,reported_cost}' ~ '^(0|[1-9][0-9]{0,39})\.[0-9]{6}$'
      and u.pricing_snapshot -> 'reported_tokens_in' is null and u.pricing_snapshot -> 'reported_tokens_out' is null
      and u.pricing_snapshot -> 'reported_cost' is null
      -- 입력 검사(4~6 문과 같다) — 하나라도 어긋나면 0행
      and v.src in ('provider', 'none')
      and v.actual_n is not null and v.settled_n is not null
      and (v.settled_n = v.actual_n or (v.settled_n > v.actual_n and v.actual_n > u.reserved_amount))
      and (v.src = 'provider' or v.actual_n = u.reserved_amount)
      and v.by_ !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$'
      and char_length(v.by_) + char_length(regexp_replace(v.by_, '[^\U00010000-\U0010FFFF]', '', 'g')) <= 200
      and v.reason !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$'
      and char_length(v.reason) + char_length(regexp_replace(v.reason, '[^\U00010000-\U0010FFFF]', '', 'g')) <= 4000
   returning u.id, u.pricing_snapshot ->> 'usage_source' as usage_source, u.actual_amount;
   ```
   (`tests/integration/live-llm.test.ts` 의 FIX2·FIX3-LIVEL1H2 시험이 세 블록을 **그대로 읽어** 실행한다 — 4~6: 같음·상한·`none` 이 1행이고 묶음 통과, 잘못 채운 경우는 0행이며 대상·같은 owner 의 다른 미해결 행 모두 그대로, 다시 실행은 0행. 정정: 형식이 틀린 해결 행을 고친 뒤 `original_reported` 그대로·묶음 통과, 잘못 채우거나 고칠 수 없는 모양이면 0행. 확인 조회: 결과 수.)
7. **확인**:
   ① 앱을 다시 켜고 설정 화면의 이번 달 사용액이 재정산을 반영하는지, 새 live 예약이 `live_usage_unresolved` 없이 진행되는지(또는 월 상한으로 429 인지) 확인한다.
   ② `corepack pnpm export` 로 해결 후 묶음을 한 번 더 보관한다(6단계가 끝난 뒤에만 — 반쯤 끝난 상태의 묶음은 복원 거부).
   ③ **그 묶음을 믿기 전에** `corepack pnpm bundle:check data/exports/<id>.zip` — exit 0·`"ok":true` 여야 한다. 읽기 전용이다: 복원 미리보기와 같은 묶음 검증만 하고 DB 를 열지 않으며 아무것도 쓰지 않는다(dev 서버가 켜져 있어도 된다, `.env.local` 도 읽지 않음). **그리고 해결한 행이 더는 세어지지 않는지 본다(FIX3-LIVEL1H2)**: 출력 JSON 의 `"unresolved_live_usage"`(묶음 안 `usage_source` 가 아직 `provider_unstorable` 인 원장 행 수 — 같은 수가 stderr 에 `[bundle:check] 정보: … N행` 으로도 나온다)가 1단계 백업 묶음의 값보다 **해결한 행 수만큼 줄어야** 하고, 모두 해결했으면 **0** 이어야 한다. 이 수는 정보일 뿐 exit 코드를 바꾸지 않는다(1단계 백업 묶음에서는 0 이 아닌 것이 정상) — 줄지 않았다면 6단계 문이 0행이었는데 지나친 것이니 6단계로 돌아간다. exit 1·`"error":"integrity"` 이고 `problems` 에 `usage_ledger.pricing_snapshot.resolution 형식` 이 있으면 4~6 의 규칙(키 6개·`Z` 시각·소수 6자리·settled = actual)을 다시 보고 6단계의 **정정 문**으로 DB 를 고친 뒤(4~6 문을 다시 돌리는 것이 아님) ②·③ 을 다시 한다(문구에는 값·필드 이름이 없다).
   ④ (선택) 실제 복원 경로까지 보려면 **버릴 위치**에서만: `DATABASE_URL=./data/pglite-check-<날짜> RESTORE_LOCAL_DIR=./data/pglite-check-<날짜>-restores corepack pnpm restore:preview <zip>`(README 의 T05 방식), 끝나면 **두 폴더를 모두** 지운다. `restore:preview` 가 쓰는 곳은 이 두 곳뿐이다(FIX3-LIVEL1H2 정정 — 이전 문구는 ZIP 사본도 버릴 DB 에 남는다고 잘못 적었다): `DATABASE_URL` 폴더(PGlite 데이터·잠금 파일·migration·owner·`restore_runs`·감사 행)와 `RESTORE_LOCAL_DIR`(검증을 통과한 묶음의 ZIP 사본 `<restore_id>.zip` — owner 데이터 전체). 코드: `packages/db/scripts/restore.ts`(`loadRootEnv` → `loadConfig` → `openDb(config)` → `ensureOwner` → `resolveFromRoot(config.RESTORE_LOCAL_DIR)` → `createRestorePreview`; 저장소(`createStorage`)는 commit 에서만), `packages/db/src/restore.ts` `createRestorePreview`(`mkdir(restoresDir)` + `writeFile(<restoresDir>/<id>.zip, 'wx')`, restore_runs·감사 삽입), `packages/db/src/client.ts` `createDb`(DB 폴더 `mkdir` + `acquireDirLock`). `RESTORE_LOCAL_DIR` 를 **빼면** ZIP 사본이 실제 환경의 `RESTORE_LOCAL_DIR`(`.env.local` 값, 없으면 `./data/restores`)에 남고 실제 DB 에는 그 사본을 가리키는 행이 없어 아무도 치우지 않는다 — 이미 그렇게 실행했다면 출력 JSON 의 `restore_id` 로 그 폴더의 `<restore_id>.zip` 하나만 지운다. 앞에 붙인 값은 `.env.local` 이 덮어쓰지 않는다(`loadRootEnv` 는 이미 있는 환경변수를 바꾸지 않음). (`tests/integration/live-llm.test.ts` FIX3-LIVEL1H2 시험이 이 줄의 두 값을 그대로 읽어 실제 스크립트를 임시 작업 폴더에서 실행하고, 새로 생긴 것이 이 두 폴더뿐인지·ZIP 사본이 `RESTORE_LOCAL_DIR` 에 있고 버릴 DB 폴더에는 없는지, 빼면 쓰일 기본값이 `./data/restores` 인지 본다.)
- 이 절차는 감사 기록(audit)을 자동으로 남기지 않는다 — reason 을 스냅숏에 남기는 것이 유일한 기록이다. 반복된다면 해결 화면·API·감사가 필요하다(별도 작업).

## 바뀐 파일(FIX round 4)
- 코드: `packages/domain/src/bundle.ts`(보고값 형식·reported_* 출처 제한), `packages/providers/src/llm-anthropic.ts`(빈 줄 문단·NFC)
- 시험: `packages/domain/src/bundle.test.ts`(+FIX4 1건, FIX3 출처 시험은 provider_unstorable 에 유효한 보고값을 함께 두게 고침 — 의도한 변경), `packages/providers/src/llm-anthropic.test.ts`(+FIX4 6건, FIX3 "여러 문단" 기대값을 빈 줄 경계로 — 의도한 변경), `tests/integration/live-llm.test.ts`(+FIX4 2건, import 추가)
- 문서: 이 인계(FIX round 3 계산 정정 포함). migration 없음

## 실행한 명령과 결과(Windows 10, Git Bash, `source tools/env.sh`, Node 24.21.0, `corepack pnpm`, 실행 전 node 프로세스 0개 확인)
| 명령 | 결과 |
|---|---|
| 재현(수정 전): unit `bundle.test.ts`·`llm-anthropic.test.ts` | 4 failed / 117 passed |
| 재현(수정 전): integration `live-llm.test.ts` | 47 passed(새 2건은 동작 기록 — a4da041 에서도 통과) |
| 수정 후 단독: unit `packages/providers/src` + `packages/domain/src` | 46 files, 1294 passed |
| 수정 후 단독: integration live-llm·export-restore·budget-claims | 3 files, 94 passed |
| `bash .handoffs/run-checks.sh FIX4-LIVEL1` → `.handoffs/checks-FIX4-LIVEL1.log` | **LINT=0 · TYPECHECK=0 · BUILD=0 · UNIT=0(56 files, 1401 tests) · INTEG=0(37 files, 786 tests) · DRILL=0(불변식 위반 0건) · MIGRATE=0 · DRILL_RESTORE=0(PASS)** — 시간 초과·워커 비정상 종료 없음, 재실행 불필요 |

## 남은 위험(FIX round 4 기준)
1. provider_unstorable 해결은 위 수동 절차뿐이다 — 화면·API·감사 기록이 없다.
2. 문단 단위라 확인 부담이 크다. 사용자가 직접 쓴 경험은 확인 대상이 아니다(모의와 같은 기존 설계 — (d)). 1인칭 판별은 정규식이다.
3. 예약은 추정이고 동시 초과는 누적된다(`LLM_LIVE_MAX_RUNS=1` 이면 한 건). 확정액은 청구액이 아니다.
4. Postgres 드라이버(다른 연결) 경쟁: **미검증**(이 환경에 Postgres 없음). 다른 owner 가 영향받지 않는 것은 쿼리가 owner_id 로 한정돼 있다는 코드 근거뿐이고 Postgres 에서 시험하지 않았다.

## Codex 에게 묻는 것(FIX round 4)
1. 보고값 형식(토큰 최대 40자리, 비용 = 정수부 + 소수 6자리)과 "reported_* 는 provider_unstorable 에서만" 규칙이 수동 해결 절차 6(키를 `resolution.original_reported` 로 옮김)과 맞물려 충분한가?
2. 빈 줄 문단 + NFC 정규화로 문단 claim 규칙이 닫혔다고 보는가?
3. (d) 처럼 확인 뒤 사용자가 직접 쓴 경험을 게이트가 보지 않는 기존 설계를 LIVE-L1 범위에서 그대로 두는 것이 맞는가?


### FIX round 4 — 오케스트레이터 기록
- FIX4 HEAD: 2b05044237d7765bfdddcfe27e2232051742dfad (code only, D28). BASE e0d9aa2.
- checks-FIX4-LIVEL1: lint 0 · typecheck 0 · build 0 · unit 0(56 파일 · 1401) · integration 0(37 파일 · 786) · drill:mock 0 · db:migrate 0 · drill:restore 0(PASS). 재실행 없음.
