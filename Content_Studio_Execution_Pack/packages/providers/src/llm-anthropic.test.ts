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
  liveInputUpperBoundTokens,
  llmStructuredOutputSchema,
  LiveProviderNotConfiguredError,
  utf8ByteLength,
} from '@cs/domain';
import {
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
    expect(liveInputUpperBoundTokens(PROMPT)).toBeGreaterThanOrEqual(sentBytes);
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

  it('usage 가 없거나 이상하면 예약 상한값(실제보다 작게 기록하지 않음), 모르는 입력도 상한값', async () => {
    const { fetch } = fakeFetch(jsonResponse(200, message({ usage: { input_tokens: -1, output_tokens: 'x' } })));
    const p = provider(fetch);
    const a = input({ maxOutputTokens: 3000 });
    const out = await p.generate(a);
    expect(p.usageOf(a, out)).toEqual({ tokensIn: liveInputUpperBoundTokens(PROMPT), tokensOut: 3000 });
    expect(p.usageOf(input({ maxOutputTokens: 1111 }), out)).toEqual({ tokensIn: liveInputUpperBoundTokens(PROMPT), tokensOut: 1111 });
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
