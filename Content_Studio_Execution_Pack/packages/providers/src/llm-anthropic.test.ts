/**
 * LIVE-L1(D34 1단계): ClaudeLlmProvider — 주입한 가짜 fetch 가 돌려주는 기록된 Messages API 응답(공식 문서의 모양: id·type 'message'·role·model·
 * content[thinking(빈 텍스트) + text(JSON)]·stop_reason·stop_details·usage)으로만 시험한다. 네트워크 0, 과금 0.
 * 시험 키는 가짜 sentinel 이며 어떤 출력(오류 메시지·JSON·inspect·console)에도 나오지 않아야 한다 — 비교만 하고 출력하지 않는다.
 */
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  LIVE_LLM_FIXED_INPUT_BYTES,
  LIVE_LLM_OUTPUT_JSON_SCHEMA,
  LIVE_LLM_SYSTEM_PROMPT,
  liveInputEstimateTokens,
  llmStructuredOutputSchema,
  LiveProviderNotConfiguredError,
  utf8ByteLength,
} from '@cs/domain';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_MESSAGES_URL,
  ClaudeLlmProvider,
  LiveLlmError,
  LiveLlmRefusalError,
  mapAnthropicError,
  type LiveLlmErrorCode,
} from './llm-anthropic';
import type { LlmGenerateInput } from './llm';

const KEY = 'sk-ant-FAKE-sentinel-key-0123456789abcdef';
/** 공급자 오류 본문·거절 설명에 일부러 넣는 "입력 되풀이" 표식 — 우리 오류·로그에 나오면 안 된다. */
const ECHO = 'UPSTREAM-ECHO-사용자원문-비밀-7f3a';
const MODEL = 'claude-opus-5-5';
const REQ_ID = 'req_011FAKEabc123';

interface Call {
  url: string;
  init: RequestInit;
  headers: Headers;
  body: Record<string, unknown>;
}

type Responder = (init: RequestInit) => Response | Promise<Response>;

function fakeFetch(...responders: Responder[]) {
  const calls: Call[] = [];
  const fn = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {}, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = responders.shift();
    if (!r) throw new Error('fake fetch: 준비된 응답 없음');
    return r(init ?? {});
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Responder => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': REQ_ID, ...headers } });

const modelOut = (over: Record<string, unknown> = {}) => ({
  proposed_text: '해외 영업에서 첫 미팅 전에 확인할 세 가지를 정리했습니다.',
  proposed_tags: ['해외영업', '실무팁'],
  claims: [{ text: '첫 미팅 전 준비가 계약 속도를 좌우한다.', kind: 'opinion', source_refs: [], needs_user_confirmation: false }],
  followup_questions: ['독자가 가장 먼저 겪는 문제는 무엇인가요?'],
  warnings: [],
  ...over,
});

/** 공식 문서 모양의 Message(thinking 블록은 display 기본 omitted → 빈 텍스트). */
const message = (over: Record<string, unknown> = {}, text: string = JSON.stringify(modelOut())) => ({
  id: 'msg_01FAKE',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-fake' },
    { type: 'text', text },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 1234, output_tokens: 567, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' },
  ...over,
});

const PROMPT = '# Content Studio 작성 보조\n## 지시\n초안을 쓰세요.\n## 현재 본문\n해외 영업 첫 미팅 준비.';
const input = (over: Partial<LlmGenerateInput> = {}): LlmGenerateInput => ({
  task: 'draft',
  inputVersion: 'cv:abc;bp:1;ans:',
  text: '자료',
  prompt: PROMPT,
  maxOutputTokens: 4096,
  allowedSourceRefs: [],
  ...over,
});

const provider = (f: typeof fetch, opts: { timeoutMs?: number } = {}) => new ClaudeLlmProvider({ apiKey: KEY, model: MODEL, fetch: f, ...opts });

/** 오류·객체의 모든 표면(메시지·스택·JSON·inspect)에 키·되풀이 원문이 없는지 */
function expectNoLeak(x: unknown) {
  const surfaces = [
    x instanceof Error ? x.message : '',
    x instanceof Error ? (x.stack ?? '') : '',
    JSON.stringify(x) ?? '',
    inspect(x, { showHidden: true, depth: 6 }),
    String(x),
  ].join('\n');
  expect(surfaces.includes(KEY)).toBe(false);
  expect(surfaces.includes(ECHO)).toBe(false);
  expect(surfaces.includes('sk-ant')).toBe(false);
}

async function rejectionOf(p: Promise<unknown>): Promise<LiveLlmError> {
  try {
    await p;
  } catch (e) {
    return e as LiveLlmError;
  }
  throw new Error('거부되지 않음');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ClaudeLlmProvider 성공(기록된 응답)', () => {
  it('스키마에 맞는 출력 — result_type·input_version 은 서버가 입력에서 정한다', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    const p = provider(fetch);
    const inp = input({ task: 'revision', inputVersion: 'cv:zzz;bp:2;ans:' });
    const out = await p.generate(inp);
    expect(llmStructuredOutputSchema.safeParse(out).success).toBe(true);
    expect(out).toMatchObject({ result_type: 'revision', input_version: 'cv:zzz;bp:2;ans:', proposed_text: modelOut().proposed_text });
    expect(calls).toHaveLength(1);
  });

  it('요청 본문: 모델·max_tokens=maxOutputTokens·시스템·사용자 프롬프트·output_config(effort low + json_schema) 만 — thinking·temperature·tools·fallbacks 없음', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    await provider(fetch).generate(input({ maxOutputTokens: 2345 }));
    const c = calls[0]!;
    expect(c.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(c.url).toBe('https://api.anthropic.com/v1/messages');
    expect(c.init.method).toBe('POST');
    expect(c.init.redirect).toBe('error');
    expect(Object.keys(c.body).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'system']);
    expect(c.body).toEqual({
      model: MODEL,
      max_tokens: 2345,
      system: LIVE_LLM_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: PROMPT }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: LIVE_LLM_OUTPUT_JSON_SCHEMA } },
    });
    for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'tools', 'tool_choice', 'fallbacks', 'stream', 'betas', 'stop_sequences']) {
      expect(c.body).not.toHaveProperty(k);
    }
    // 마지막 메시지는 user(assistant prefill 없음)
    expect((c.body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['user']);
  });

  it('예약이 센 바이트 = 실제로 보낸 시스템 + 스키마 + 프롬프트 바이트(같은 문자열)', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    await provider(fetch).generate(input());
    const b = calls[0]!.body as { system: string; messages: Array<{ content: string }>; output_config: { format: { schema: unknown } } };
    const sentBytes = utf8ByteLength(b.system) + utf8ByteLength(JSON.stringify(b.output_config.format.schema)) + utf8ByteLength(b.messages[0]!.content);
    expect(utf8ByteLength(b.system) + utf8ByteLength(JSON.stringify(b.output_config.format.schema))).toBe(LIVE_LLM_FIXED_INPUT_BYTES);
    expect(liveInputEstimateTokens(PROMPT)).toBeGreaterThanOrEqual(sentBytes);
  });

  it('헤더: x-api-key 는 키(값 비교만), Authorization 없음, anthropic-version 있음, 재시도 횟수 0', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    await provider(fetch).generate(input());
    const h = calls[0]!.headers;
    expect(h.get('x-api-key') === KEY).toBe(true);
    expect(h.has('authorization')).toBe(false);
    expect(h.get('anthropic-version')).toBeTruthy();
    expect(h.get('x-stainless-retry-count')).toBe('0');
  });

  it('usage: 그 호출 응답의 input(+캐시 생성·읽기) / output 토큰 — 같은 입력 객체로 조회', async () => {
    const usage = { input_tokens: 1000, output_tokens: 3000, cache_creation_input_tokens: 20, cache_read_input_tokens: 5 };
    const { fetch } = fakeFetch(jsonResponse(200, message({ usage })), jsonResponse(200, message({ usage: { input_tokens: 7, output_tokens: 9 } })));
    const p = provider(fetch);
    const a = input();
    const b = input();
    const outA = await p.generate(a);
    const outB = await p.generate(b);
    // 출력은 db 층에서 zod 로 다시 파싱돼 새 객체가 되어도 입력 객체로 찾는다
    expect(p.usageOf(a, llmStructuredOutputSchema.parse(outA))).toEqual({ tokensIn: 1025, tokensOut: 3000 });
    expect(p.usageOf(b, outB)).toEqual({ tokensIn: 7, tokensOut: 9 });
  });

  it('usage 가 없거나 이상하면 예약과 같은 보수적 추정값(실제보다 작게 기록하지 않으려는 것), 모르는 입력도 추정값', async () => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ usage: { input_tokens: -1, output_tokens: 'x' } })));
    const p = provider(fetch);
    const a = input({ maxOutputTokens: 3000 });
    const out = await p.generate(a);
    expect(p.usageOf(a, out)).toEqual({ tokensIn: liveInputEstimateTokens(PROMPT), tokensOut: 3000 });
    expect(p.usageOf(input({ maxOutputTokens: 1111 }), out)).toEqual({ tokensIn: liveInputEstimateTokens(PROMPT), tokensOut: 1111 });
  });

  it('기존 규칙 유지: 1인칭 표현·experience claim → experience + 사용자 확인 필요, 후속 질문은 앞의 3개', async () => {
    const out = modelOut({
      claims: [
        { text: '제가 직접 두바이에서 협상했습니다.', kind: 'fact', source_refs: [], needs_user_confirmation: false },
        { text: '현지 파트너와 신뢰가 먼저였다.', kind: 'experience', source_refs: [], needs_user_confirmation: false },
        { text: '시장은 커지고 있다.', kind: 'opinion', source_refs: ['sv-1'], needs_user_confirmation: false },
      ],
      followup_questions: ['q1', 'q2', 'q3', 'q4', 'q5'],
    });
    const { fetch } = fakeFetch(jsonResponse(200, message({}, JSON.stringify(out))));
    const r = await provider(fetch).generate(input());
    expect(r.claims.map((c) => [c.kind, c.needs_user_confirmation])).toEqual([
      ['experience', true],
      ['experience', true],
      ['opinion', false],
    ]);
    expect(r.claims[2]!.source_refs).toEqual(['sv-1']); // 허용 목록 거르기는 db 층(sanitizeLlmOutput) 그대로
    expect(r.followup_questions).toEqual(['q1', 'q2', 'q3']);
  });
});

describe('ClaudeLlmProvider 응답 처리(stop_reason 먼저)', () => {
  it('refusal → LiveLlmRefusalError(llm_refusal), 모델 텍스트·거절 설명은 오류에 없음', async () => {
    const { fetch, calls } = fakeFetch(
      jsonResponse(200, message({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: ECHO } }, `{"proposed_text":"${ECHO}`)),
    );
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e).toBeInstanceOf(LiveLlmRefusalError);
    expect(e).toBeInstanceOf(AppError);
    expect([e.kind, e.code]).toEqual(['llm_failed', 'llm_refusal']);
    expect(e.requestId).toBe(REQ_ID);
    expect(calls).toHaveLength(1);
    expectNoLeak(e);
  });

  it('max_tokens → llm_max_tokens(잘린 출력은 쓰지 않음)', async () => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ stop_reason: 'max_tokens' }, '{"proposed_text":"잘린')));
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e.code).toBe('llm_max_tokens');
    expect(e).not.toBeInstanceOf(LiveLlmRefusalError);
  });

  it.each(['pause_turn', 'tool_use', 'stop_sequence', 'model_context_window_exceeded', null])('stop_reason=%s → llm_unexpected_stop', async (sr) => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ stop_reason: sr })));
    expect((await rejectionOf(provider(fetch).generate(input()))).code).toBe('llm_unexpected_stop');
  });

  it.each([
    ['JSON 아님', message({}, `not json ${ECHO}`)],
    ['빈 텍스트', message({}, '')],
    ['text 블록 없음', message({ content: [{ type: 'thinking', thinking: '', signature: 's' }] })],
    ['tool_use 블록', message({ content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }, { type: 'text', text: JSON.stringify(modelOut()) }] })],
    ['필드 빠짐', message({}, JSON.stringify({ proposed_text: 'x' }))],
    ['모델이 result_type 을 씀(strict)', message({}, JSON.stringify({ ...modelOut(), result_type: 'draft' }))],
    ['모델이 input_version 을 씀(strict)', message({}, JSON.stringify({ ...modelOut(), input_version: 'forged' }))],
    ['claim 추가 필드', message({}, JSON.stringify(modelOut({ claims: [{ text: 'a', kind: 'fact', source_refs: [], needs_user_confirmation: false, evidence_grade: 'user_confirmed' }] })))],
    ['claim kind 이상', message({}, JSON.stringify(modelOut({ claims: [{ text: 'a', kind: 'rumor', source_refs: [], needs_user_confirmation: false }] })))],
    ['claim 빈 문장', message({}, JSON.stringify(modelOut({ claims: [{ text: '', kind: 'fact', source_refs: [], needs_user_confirmation: false }] })))],
    ['배열 대신 문자열', message({}, JSON.stringify(modelOut({ proposed_tags: '해외영업' })))],
  ])('형식 오류(%s) → llm_invalid_output, 원문 없음', async (_l, body) => {
    const { fetch } = fakeFetch(jsonResponse(200, body));
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e.code).toBe('llm_invalid_output');
    expectNoLeak(e);
  });
});

describe('ClaudeLlmProvider 오류 매핑(고정 문구·코드, 누출 없음, 재시도 없음)', () => {
  const errBody = (type: string) => ({ type: 'error', error: { type, message: `${ECHO} x-api-key ${KEY}` }, request_id: REQ_ID });
  it.each<[number, string, LiveLlmErrorCode, Record<string, string>]>([
    [400, 'invalid_request_error', 'llm_bad_request', {}],
    [401, 'authentication_error', 'llm_auth_failed', {}],
    [403, 'permission_error', 'llm_permission_denied', {}],
    [404, 'not_found_error', 'llm_not_found', {}],
    [413, 'request_too_large', 'llm_provider_error', {}],
    [422, 'invalid_request_error', 'llm_bad_request', {}],
    [429, 'rate_limit_error', 'llm_rate_limited', { 'retry-after': '1', 'x-should-retry': 'true' }],
    [500, 'api_error', 'llm_server_error', { 'x-should-retry': 'true' }],
    [529, 'overloaded_error', 'llm_server_error', { 'x-should-retry': 'true' }],
  ])('HTTP %i %s → %s, fetch 정확히 1번(maxRetries 0)', async (status, type, code, headers) => {
    const { fetch, calls } = fakeFetch(jsonResponse(status, errBody(type), headers), jsonResponse(200, message()));
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e).toBeInstanceOf(LiveLlmError);
    expect([e.kind, e.code, e.httpStatus, e.requestId]).toEqual(['llm_failed', code, status, REQ_ID]);
    expect(calls).toHaveLength(1);
    expectNoLeak(e);
    expect(e).not.toHaveProperty('cause');
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('연결 오류(fetch 가 던짐, 메시지에 키·원문) → llm_connection_failed, 1번만', async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new TypeError(`fetch failed ${KEY} ${ECHO}`);
    }, jsonResponse(200, message()));
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e.code).toBe('llm_connection_failed');
    expect(calls).toHaveLength(1);
    expectNoLeak(e);
  });

  it('시간 초과(응답 없음) → llm_timeout, 재시도 없음', async () => {
    const { fetch, calls } = fakeFetch(
      (init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(Object.assign(new Error(`aborted ${ECHO}`), { name: 'AbortError' })));
        }),
      jsonResponse(200, message()),
    );
    const e = await rejectionOf(provider(fetch, { timeoutMs: 50 }).generate(input()));
    expect(e.code).toBe('llm_timeout');
    expect(calls).toHaveLength(1);
    expectNoLeak(e);
  });

  it('mapAnthropicError: 알 수 없는 값 → llm_provider_error(원 오류 버림)', () => {
    const e = mapAnthropicError(new Error(ECHO));
    expect(e.code).toBe('llm_provider_error');
    expectNoLeak(e);
  });
});

describe('ClaudeLlmProvider 보내기 전 거부·설정 경계', () => {
  it.each([
    ['maxOutputTokens 없음', { maxOutputTokens: undefined }],
    ['0', { maxOutputTokens: 0 }],
    ['음수', { maxOutputTokens: -5 }],
    ['소수', { maxOutputTokens: 100.5 }],
    ['상한 초과(16001)', { maxOutputTokens: 16001 }],
    ['prompt 없음', { prompt: undefined }],
    ['prompt 공백', { prompt: '   ' }],
  ])('%s → llm_request_invalid, fetch 0번', async (_l, over) => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    const e = await rejectionOf(provider(fetch).generate(input(over as Partial<LlmGenerateInput>)));
    expect(e.code).toBe('llm_request_invalid');
    expect(calls).toHaveLength(0);
  });

  it('ANTHROPIC_BASE_URL·ANTHROPIC_AUTH_TOKEN·ANTHROPIC_LOG 환경변수는 무시된다(주소 고정, Bearer 없음, 로그 없음)', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://evil.example.invalid');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'FAKE-bearer-token-should-not-be-sent');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-OTHER-env-key-not-used');
    const debug = vi.spyOn(console, 'debug');
    const info = vi.spyOn(console, 'info');
    const log = vi.spyOn(console, 'log');
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    await provider(fetch).generate(input());
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.headers.has('authorization')).toBe(false);
    expect(calls[0]!.headers.get('x-api-key') === KEY).toBe(true);
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('ANTHROPIC_CUSTOM_HEADERS(SDK 가 늘 읽음)로 X-Api-Key 를 덮거나 Authorization·anthropic-beta·임의 헤더를 붙일 수 없다(허용 목록)', async () => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'X-Api-Key: OTHER-FAKE-key\nAuthorization: Bearer FAKE-bearer\nanthropic-beta: fast-mode-2026-02-01\nX-Extra: 1');
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    await provider(fetch).generate(input());
    const h = calls[0]!.headers;
    expect(h.get('x-api-key') === KEY).toBe(true);
    for (const k of ['authorization', 'anthropic-beta', 'x-extra']) expect(h.has(k)).toBe(false);
    const names: string[] = [];
    h.forEach((_v, k) => names.push(k));
    for (const k of names) expect(k).toMatch(/^(accept|content-type|content-length|user-agent|anthropic-version|x-api-key|x-stainless-[a-z0-9-]+)$/);
    expect(names).toContain('anthropic-version');
  });

  it('키는 직렬화·inspect 에 나오지 않는다(toJSON = 이름·모드·모델)', async () => {
    const { fetch } = fakeFetch(jsonResponse(200, message()));
    const p = provider(fetch);
    await p.generate(input()); // 내부 SDK 클라이언트가 만들어진 뒤에도
    expect(JSON.parse(JSON.stringify(p))).toEqual({ name: 'anthropic', mode: 'live', model: MODEL });
    expectNoLeak(p);
  });

  it('형식이 틀린 키·빈 모델 → 생성 거부(이름만, 값 없음)', () => {
    for (const bad of ['', '   ', 'sk-ant FAKE', 'x'.repeat(513)]) {
      try {
        new ClaudeLlmProvider({ apiKey: bad, model: MODEL });
        throw new Error('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(LiveProviderNotConfiguredError);
        expect((e as LiveProviderNotConfiguredError).missing).toEqual(['ANTHROPIC_API_KEY(형식)']);
        expect((e as Error).message).not.toContain('FAKE');
      }
    }
    expect(() => new ClaudeLlmProvider({ apiKey: KEY, model: ' ' })).toThrow(LiveProviderNotConfiguredError);
  });
});

// ---- FIX round 1(Codex review-LIVEL1) ----

const BIG_USAGE = { input_tokens: 200_000, output_tokens: 4096, cache_creation_input_tokens: null, cache_read_input_tokens: null };

describe('FIX1 P1 :222 — 실패 응답도 사용량(숫자만)을 오류에 싣는다(stop_reason·출력 검증 전에 읽음)', () => {
  it.each<[string, Record<string, unknown>, string | undefined, LiveLlmErrorCode]>([
    ['refusal', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: ECHO } }, `{"x":"${ECHO}`, 'llm_refusal'],
    ['max_tokens', { stop_reason: 'max_tokens' }, `{"proposed_text":"${ECHO}`, 'llm_max_tokens'],
    ['unexpected_stop', { stop_reason: 'pause_turn' }, undefined, 'llm_unexpected_stop'],
    ['invalid_output', {}, `not json ${ECHO}`, 'llm_invalid_output'],
    ['content 배열 아님', { content: { type: 'text', text: 'x' } }, undefined, 'llm_invalid_output'],
  ])('%s + 예약 초과 usage → 코드 그대로, e.usage = {200000, 4096}, 원문 없음', async (_l, over, text, code) => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ ...over, usage: BIG_USAGE }, text)));
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e.code).toBe(code);
    expect(e.usage).toEqual({ tokensIn: 200_000, tokensOut: 4096 });
    expectNoLeak(e);
  });

  it('실패 응답의 usage 가 이상하면 e.usage 없음(D13 — 예약액 확정)', async () => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ stop_reason: 'max_tokens', usage: { input_tokens: '5', output_tokens: 1 } })));
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e.code).toBe('llm_max_tokens');
    expect(e.usage).toBeNull();
  });

  it('HTTP 오류(응답 usage 없음)는 e.usage 없음', async () => {
    const { fetch } = fakeFetch(jsonResponse(529, { type: 'error', error: { type: 'overloaded_error', message: ECHO } }));
    expect((await rejectionOf(provider(fetch).generate(input()))).usage).toBeNull();
  });
});

describe('FIX1 P2 :271 — 캐시 usage: 없음·null → 0, 있는데 이상하면 전체를 보수적 상한으로', () => {
  const upper = (maxOut = 4096) => ({ tokensIn: liveInputEstimateTokens(PROMPT), tokensOut: maxOut });
  it.each<[string, Record<string, unknown>, { tokensIn: number; tokensOut: number } | 'upper']>([
    ['캐시 필드 없음', { input_tokens: 1000, output_tokens: 100 }, { tokensIn: 1000, tokensOut: 100 }],
    ['캐시 null', { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: null, cache_read_input_tokens: null }, { tokensIn: 1000, tokensOut: 100 }],
    ['캐시 문자열', { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: '2000' }, 'upper'],
    ['캐시 음수', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: -1 }, 'upper'],
    ['캐시 소수', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 1.5 }, 'upper'],
    ['캐시 안전 정수 초과', { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 2 ** 53 }, 'upper'],
    ['합계 안전 정수 초과', { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 100, cache_read_input_tokens: 1 }, 'upper'],
    ['input 안전 정수 초과', { input_tokens: 2 ** 53 + 2, output_tokens: 100 }, 'upper'],
  ])('%s', async (_l, usage, want) => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ usage })));
    const p = provider(fetch);
    const inp = input();
    const out = await p.generate(inp);
    expect(p.usageOf(inp, out)).toEqual(want === 'upper' ? upper() : want);
  });
});

describe('FIX1 P2 :181 — 프로토콜 헤더 값 고정(ANTHROPIC_CUSTOM_HEADERS 로 못 바꿈)', () => {
  it('Content-Length 제거, content-type·accept = application/json, anthropic-version = SDK 고정값', async () => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'Content-Length: 0\nContent-Type: text/plain\nAccept: text/html\nAnthropic-Version: 1999-01-01');
    const { fetch, calls } = fakeFetch(jsonResponse(200, message()));
    await provider(fetch).generate(input());
    const h = calls[0]!.headers;
    expect(ANTHROPIC_API_VERSION).toBe('2023-06-01');
    expect(h.has('content-length')).toBe(false);
    expect(h.get('content-type')).toBe('application/json');
    expect(h.get('accept')).toBe('application/json');
    expect(h.get('anthropic-version')).toBe(ANTHROPIC_API_VERSION);
    expect(h.get('x-api-key') === KEY).toBe(true);
  });
});

describe('FIX1 놓친 케이스', () => {
  it.each([
    ['content = null', { content: null }],
    ['content = 문자열', { content: 'text' }],
    ['content 에 null 블록', { content: [null, { type: 'text', text: JSON.stringify(modelOut()) }] }],
    ['content 에 숫자 블록', { content: [1] }],
  ])('(a) %s → llm_invalid_output', async (_l, over) => {
    const { fetch } = fakeFetch(jsonResponse(200, message(over)));
    const e = await rejectionOf(provider(fetch).generate(input()));
    expect(e).toBeInstanceOf(LiveLlmError);
    expect(e.code).toBe('llm_invalid_output');
  });

  // FIX3-LIVEL1: 같은 입력 객체 재사용은 거부로 바뀌었다(의도한 동작 변경) — 두 번째 호출은 보내지 않고, usage 는 첫 호출 그대로.
  it('(b) 같은 입력 객체로 성공 뒤 다시 generate → 보내기 전에 거부, usageOf 는 첫 호출의 usage', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, message({ usage: { input_tokens: 7, output_tokens: 9 } })), jsonResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }));
    const p = provider(fetch);
    const inp = input();
    const out = await p.generate(inp);
    expect(p.usageOf(inp, out)).toEqual({ tokensIn: 7, tokensOut: 9 });
    expect((await rejectionOf(p.generate(inp))).code).toBe('llm_request_invalid');
    expect(calls).toHaveLength(1);
    expect(p.usageOf(inp, out)).toEqual({ tokensIn: 7, tokensOut: 9 });
  });

  // FIX3-LIVEL1: 단위가 문단으로 바뀌었다(의도한 동작 변경) — 1인칭 문장이 든 문단 전체가 확인 대상.
  it('(c) proposed_text 의 1인칭 문단이 experience claim 으로 덮이지 않으면 서버가 문단 전체 experience claim(확인 필요)을 더한다', async () => {
    const text = '해외 영업은 준비가 중요하다. 제가 두바이에서 계약을 놓친 적이 있습니다. 결론은 사전 조사다.';
    const { fetch } = fakeFetch(jsonResponse(200, message({}, JSON.stringify(modelOut({ proposed_text: text, claims: [] })))));
    const r = await provider(fetch).generate(input());
    expect(r.claims).toEqual([{ text, kind: 'experience', source_refs: [], needs_user_confirmation: true }]);
  });

  it('(c) 이미 experience claim 이 그 문단과 정확히 같으면 더하지 않는다(중복 없음), 출처 참조는 만들지 않는다', async () => {
    const text = '제가 직접 협상했습니다.';
    const claims = [{ text: '제가 직접 협상했습니다.', kind: 'experience', source_refs: [], needs_user_confirmation: true }];
    const { fetch } = fakeFetch(jsonResponse(200, message({}, JSON.stringify(modelOut({ proposed_text: text, claims })))));
    const r = await provider(fetch).generate(input());
    expect(r.claims).toEqual(claims);
  });
});

// ---- FIX round 2(Codex review-FIX-LIVEL1) ----

const claimsOut = async (proposed_text: string, claims: unknown[] = []) => {
  const { fetch } = fakeFetch(jsonResponse(200, message({}, JSON.stringify(modelOut({ proposed_text, claims })))));
  return (await provider(fetch).generate(input())).claims;
};
const exp = (text: string) => ({ text, kind: 'experience', source_refs: [], needs_user_confirmation: true });

describe('FIX2 P1 :287 — 경험 claim 은 문장 전체를 덮을 때만 중복, 문장 분리는 공백 없는 종결도', () => {
  it('짧은 부분 claim 은 더 긴 본문 문장을 덮지 못한다 → 본문 문장 claim 추가', async () => {
    const short = exp('제가 협상했습니다');
    expect(await claimsOut('제가 협상했습니다 그리고 계약을 따냈습니다.', [short])).toEqual([short, exp('제가 협상했습니다 그리고 계약을 따냈습니다.')]);
  });

  // FIX3-LIVEL1: 문장 분리를 없애고 문단 단위로 바꿨다(의도한 동작 변경) — 아래 두 시험은 같은 입력에서 문단 전체가 한 claim 이 됨을 확인한다.
  it('공백 없이 이어진 두 경험 + 첫 문장 claim → 그 claim 은 문단과 같지 않으므로 문단 전체 claim 추가', async () => {
    const first = exp('제가 직접 협상했습니다.');
    const text = '제가 직접 협상했습니다.그리고 제가 매출을 두 배로 늘렸습니다.';
    expect(await claimsOut(text, [first])).toEqual([first, exp(text)]);
  });

  it('여러 경험이 한 문단에 있으면(소수점·!·?·。 포함) 문단 전체 한 claim', async () => {
    const text = '매출이 3.5배 늘었다.제가 팀을 이끌었습니다! 시장은 크다. 저는 두바이에 3년 있었습니다?우리는 계약을 지켰다。';
    expect(await claimsOut(text)).toEqual([exp(text)]);
  });

  it('claim 이 문단과 정규화 후 같으면(앞뒤 공백·NFKC 무시) 추가하지 않는다', async () => {
    const whole = exp('  제가 직접 협상했습니다. ');
    expect(await claimsOut('제가 직접 협상했습니다.', [whole])).toEqual([whole]);
  });
});

describe('FIX2 P2 :489 — 확인된 usage 와 추정 구분(confirmedUsageOf)', () => {
  it('유효 usage → confirmedUsageOf = 그 값', async () => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ usage: { input_tokens: 11, output_tokens: 22 } })));
    const p = provider(fetch);
    const inp = input();
    await p.generate(inp);
    expect(p.confirmedUsageOf(inp)).toEqual({ tokensIn: 11, tokensOut: 22 });
  });

  // FIX3-LIVEL1: 열 범위 밖(2^31 이상) 보고값은 provider 가 버리지 않는다(의도한 동작 변경) — 아래 별도 시험. 여기에는 없음·이상값만.
  it.each([
    ['usage 없음', undefined],
    ['usage 이상', { input_tokens: 'x', output_tokens: 1 }],
    ['안전 정수 밖', { input_tokens: 2 ** 53, output_tokens: 1 }],
  ])('%s → confirmedUsageOf = null(usageOf 는 추정값), 실패면 e.usage = null', async (_l, usage) => {
    const ok = fakeFetch(jsonResponse(200, message({ usage })));
    const p = provider(ok.fetch);
    const inp = input();
    await p.generate(inp);
    expect(p.confirmedUsageOf(inp)).toBeNull();
    expect(p.usageOf(inp, llmStructuredOutputSchema.parse({ result_type: 'draft', input_version: 'v', proposed_text: '', proposed_tags: [], claims: [], followup_questions: [], warnings: [] }))).toEqual({
      tokensIn: liveInputEstimateTokens(PROMPT),
      tokensOut: 4096,
    });
    const bad = fakeFetch(jsonResponse(200, message({ stop_reason: 'max_tokens', usage })));
    expect((await rejectionOf(provider(bad.fetch).generate(input()))).usage).toBeNull();
  });

  it.each([
    ['입력 2^31', { input_tokens: 2_147_483_648, output_tokens: 1 }, { tokensIn: 2_147_483_648, tokensOut: 1 }],
    ['출력 2^31', { input_tokens: 1, output_tokens: 2_147_483_648 }, { tokensIn: 1, tokensOut: 2_147_483_648 }],
    ['캐시 합 2^31 초과', { input_tokens: 2_000_000_000, output_tokens: 1, cache_read_input_tokens: 200_000_000 }, { tokensIn: 2_200_000_000, tokensOut: 1 }],
  ])('열 범위 밖 보고값(%s) → confirmedUsageOf·e.usage 는 그 보고값(저장 가능 여부는 db 층)', async (_l, usage, want) => {
    const ok = fakeFetch(jsonResponse(200, message({ usage })));
    const p = provider(ok.fetch);
    const inp = input();
    await p.generate(inp);
    expect(p.confirmedUsageOf(inp)).toEqual(want);
    const bad = fakeFetch(jsonResponse(200, message({ stop_reason: 'max_tokens', usage })));
    expect((await rejectionOf(provider(bad.fetch).generate(input()))).usage).toEqual(want);
  });

  it('응답을 못 받은 실패 뒤 confirmedUsageOf = null', async () => {
    const { fetch } = fakeFetch(jsonResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }));
    const p = provider(fetch);
    const inp = input();
    await rejectionOf(p.generate(inp));
    expect(p.confirmedUsageOf(inp)).toBeNull();
  });
});

describe('FIX2 놓친 (e) — 같은 입력 객체를 동시에 쓰는 호출은 거부(제품 경로 없음)', () => {
  it('진행 중인 입력으로 다시 generate → llm_request_invalid, fetch 1번만', async () => {
    let release: (r: Response) => void = () => undefined;
    let called: () => void = () => undefined;
    const fetched = new Promise<void>((r) => (called = r));
    const calls: string[] = [];
    const slow = (async (u: Parameters<typeof fetch>[0]) => {
      calls.push(String(u));
      const res = new Promise<Response>((r) => (release = r));
      called();
      return res;
    }) as typeof fetch;
    const p = provider(slow);
    const inp = input();
    const first = p.generate(inp);
    const second = await rejectionOf(p.generate(inp));
    expect(second.code).toBe('llm_request_invalid');
    await fetched;
    release(new Response(JSON.stringify(message()), { status: 200, headers: { 'content-type': 'application/json' } }));
    await first;
    expect(calls).toHaveLength(1);
    // FIX3-LIVEL1: 끝난 뒤의 순차 재사용도 거부(의도한 동작 변경) — 보내지 않는다
    expect((await rejectionOf(p.generate(inp))).code).toBe('llm_request_invalid');
    expect(calls).toHaveLength(1);
  });
});

// ---- FIX round 3(Codex review-FIX2-LIVEL1) — 문단 단위·정확 일치 ----

describe('FIX3 P1 :310·:372 — 1인칭 확인 claim 은 문단 단위, 정규화 텍스트가 정확히 같을 때만 덮임', () => {
  it.each([
    ['부정', '"제가 매출을 두 배로 늘렸습니다."라는 주장은 사실이 아닙니다.'],
    ['인용', '그는 "제가 매출을 두 배로 늘렸습니다."라고 말했다고 제가 들었습니다.'],
    ['가정', '만약 제가 매출을 두 배로 늘렸습니다.라고 쓴다면 과장입니다.'],
  ])('본문 문장을 감싼 더 긴 %s claim 은 덮지 못한다 → 본문 문단 claim 추가', async (_l, wrapping) => {
    const w = exp(wrapping);
    expect(await claimsOut('제가 매출을 두 배로 늘렸습니다.', [w])).toEqual([w, exp('제가 매출을 두 배로 늘렸습니다.')]);
  });

  it('인용문 안의 종결 부호에서 끊지 않는다 — 문단 전체가 한 claim', async () => {
    expect(await claimsOut('저는 “좋습니다.”라고 답하고 계약을 따냈습니다.')).toEqual([exp('저는 “좋습니다.”라고 답하고 계약을 따냈습니다.')]);
  });

  it('한 문단의 두 경험 → 문단 전체 한 claim', async () => {
    expect(await claimsOut('제가 협상했습니다. 저는 계약을 따냈습니다.')).toEqual([exp('제가 협상했습니다. 저는 계약을 따냈습니다.')]);
  });

  // FIX4-LIVEL1: 문단 경계는 빈 줄만(의도한 동작 변경) — 한 줄바꿈으로 이어진 "시장은 크다.\n저는 …" 은 한 문단이다.
  it('여러 문단 → 1인칭 문단마다 claim(빈 줄 경계, 한 줄바꿈은 문단 안), 1인칭 아닌 문단 제외', async () => {
    expect(await claimsOut('제가 협상했습니다.\n\n시장은 크다.\n저는 계약을 따냈습니다.\n\n시장은 크다.')).toEqual([
      exp('제가 협상했습니다.'),
      exp('시장은 크다.\n저는 계약을 따냈습니다.'),
    ]);
  });

  it('정규화(NFKC·공백 접기·trim) 후 정확히 같은 claim 은 덮는다, 짧은 부분 claim 은 못 덮는다', async () => {
    const same = exp('  제가   협상했습니다. ');
    expect(await claimsOut('제가 협상했습니다.', [same])).toEqual([same]);
    const part = exp('제가 협상했습니다.');
    expect(await claimsOut('제가 협상했습니다. 저는 계약을 따냈습니다.', [part])).toEqual([part, exp('제가 협상했습니다. 저는 계약을 따냈습니다.')]);
  });
});

describe('FIX3 놓친 (a) — 같은 입력 객체는 한 번만(순차 재사용도 보내기 전 거부)', () => {
  it('성공 뒤 같은 객체로 다시 generate → llm_request_invalid, fetch 1번, usage 는 첫 호출 그대로', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(200, message({ usage: { input_tokens: 7, output_tokens: 9 } })), jsonResponse(200, message({ usage: { input_tokens: 70, output_tokens: 90 } })));
    const p = provider(fetch);
    const inp = input();
    await p.generate(inp);
    const e = await rejectionOf(p.generate(inp));
    expect(e.code).toBe('llm_request_invalid');
    expect(calls).toHaveLength(1);
    expect(p.confirmedUsageOf(inp)).toEqual({ tokensIn: 7, tokensOut: 9 });
  });

  it('실패 뒤에도 같은 객체 재사용은 거부', async () => {
    const { fetch, calls } = fakeFetch(jsonResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }), jsonResponse(200, message()));
    const p = provider(fetch);
    const inp = input();
    await rejectionOf(p.generate(inp));
    expect((await rejectionOf(p.generate(inp))).code).toBe('llm_request_invalid');
    expect(calls).toHaveLength(1);
  });
});

describe('FIX3 P1 db/budget.ts:255 — 열 범위 밖이어도 공급자가 보고한 usage 는 버리지 않는다', () => {
  it('2^31 이상(안전 정수) usage → confirmedUsageOf 는 그 값, 실패면 e.usage 도 그 값(저장 가능 여부는 db 층이 판단)', async () => {
    const usage = { input_tokens: 2_147_483_648, output_tokens: 5 };
    const ok = fakeFetch(jsonResponse(200, message({ usage })));
    const p = provider(ok.fetch);
    const inp = input();
    await p.generate(inp);
    expect(p.confirmedUsageOf(inp)).toEqual({ tokensIn: 2_147_483_648, tokensOut: 5 });
    const bad = fakeFetch(jsonResponse(200, message({ stop_reason: 'refusal', usage })));
    expect((await rejectionOf(provider(bad.fetch).generate(input()))).usage).toEqual({ tokensIn: 2_147_483_648, tokensOut: 5 });
  });
});

// ---- FIX round 4(Codex review-FIX3-LIVEL1) ----

describe('FIX4 놓친 (a)·(b)·(c) — 문단은 빈 줄로만, NFC 정규화, 자르지 않음', () => {
  it('(a) 한 줄바꿈은 문단 경계가 아니다 — 주어와 서술이 다른 줄이어도 한 claim', async () => {
    expect(await claimsOut('저는\n두바이에서 계약을 따냈습니다.')).toEqual([exp('저는\n두바이에서 계약을 따냈습니다.')]);
  });

  it('(a) 빈 줄(공백만 있는 줄 포함, CRLF 포함)은 문단 경계', async () => {
    expect(await claimsOut('제가 협상했습니다.\r\n  \r\n시장은 크다.\n\n저는 계약을 따냈습니다.')).toEqual([exp('제가 협상했습니다.'), exp('저는 계약을 따냈습니다.')]);
  });

  it('(a) 한 줄바꿈으로 이어진 문단 + 그 문단과 같은 claim(줄바꿈↔공백 차이) → 덮임', async () => {
    const same = exp('저는 두바이에서 계약을 따냈습니다.');
    expect(await claimsOut('저는\n두바이에서 계약을 따냈습니다.', [same])).toEqual([same]);
  });

  it('(b) 분해된 한글(NFD) claim 과 조합형(NFC) 본문은 같은 것으로 본다 → 덮임', async () => {
    const nfd = exp('제가 협상했습니다.'.normalize('NFD'));
    expect(nfd.text).not.toBe('제가 협상했습니다.');
    expect(await claimsOut('제가 협상했습니다.', [nfd])).toEqual([nfd]);
    const nfc = exp('제가 협상했습니다.');
    expect(await claimsOut('제가 협상했습니다.'.normalize('NFD'), [nfc])).toEqual([nfc]);
  });

  it('(b) NFC 만 — 호환 문자(전각 등)는 같은 것으로 보지 않는다(NFKC 아님, 보수적)', async () => {
    const fullwidth = exp('제가 협상했습니다．'); // 전각 마침표
    expect(await claimsOut('제가 협상했습니다.', [fullwidth])).toEqual([fullwidth, exp('제가 협상했습니다.')]);
  });

  it('(c) 긴 문단(1만 자)도 자르지 않고 문단 전체가 한 claim(스키마에 claim 길이·개수 제한 없음)', async () => {
    const long = `제가 ${'계약을 검토했습니다 '.repeat(1000)}끝.`;
    expect(long.length).toBeGreaterThan(10_000);
    const claims = await claimsOut(long);
    expect(claims).toEqual([exp(long)]);
  });
});
