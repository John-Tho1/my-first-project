/**
 * LIVE-L1(결정 D34 1단계): 실제 Claude(Anthropic Messages API) 어댑터. 공식 SDK `@anthropic-ai/sdk`(0.128.0 정확 고정).
 * 1단계 시험은 주입한 가짜 fetch(기록된 응답)로만 한다 — 네트워크 0, 과금 0. 실제 호출은 D34 2단계 승인 뒤 사용자가 키를 넣었을 때만.
 *
 * 비용·안전 경계
 * - `maxRetries: 0`: SDK 자동 재시도는 과금을 예약 밖으로 늘린다(예약 1건 = 요청 1건). 시간 초과도 재시도하지 않는다.
 * - `max_tokens` = input.maxOutputTokens(필수 — 예약의 출력 몫). 없거나 범위 밖이면 **보내기 전에** 거부한다.
 * - 입력은 예약이 센 것과 같은 문자열만: 시스템 프롬프트(LIVE_LLM_SYSTEM_PROMPT) + input.prompt + 출력 스키마(LIVE_LLM_OUTPUT_JSON_SCHEMA).
 *   FIX1/FIX2-LIVEL1: 예약은 보수적 추정이지 증명된 비용 상한이 아니다 — 응답 usage 를 검증해 유효하면 돌려주고(성공은 confirmedUsageOf,
 *   실패는 오류의 usage), 없거나 이상하면 null(추정값을 실제처럼 넘기지 않음).
 *   db 층이 확인된 실제액(초과액 포함)을 기록해 월 합계에 넣는다(초과 동작은 @cs/domain budget.ts 머리 주석 (1)~(4)).
 * - thinking·temperature·tools·assistant prefill·server-side fallbacks 를 보내지 않는다(Opus 5.5 는 thinking 을 끌 수 없고 effort 로만 조절 —
 *   `effort: 'low'`. fallbacks 는 대체 모델 단가가 예약 밖이라 D34 가 끔).
 * - apiKey·baseURL 을 명시하고 authToken 은 null — ANTHROPIC_BASE_URL·ANTHROPIC_AUTH_TOKEN·프로필이 키를 다른 곳으로 보내거나 다른 자격 증명을
 *   싣지 못하게. 그 위에 fetch 감싸개가 목적지를 `https://api.anthropic.com/v1/messages` 로만 허용하고 `redirect: 'error'`,
 *   헤더는 허용 목록만 남기고 x-api-key·content-type·accept·anthropic-version 을 고정값으로 다시 쓰며 content-length 는 뺀다
 *   (ANTHROPIC_CUSTOM_HEADERS 가 키를 덮거나 beta·Authorization·잘못된 길이·형식·버전을 붙이지 못하게).
 * - `logLevel: 'off'`(ANTHROPIC_LOG 무시). SDK 오류의 message·headers·body(입력을 되풀이할 수 있음)는 버리고 고정 한국어 문구·코드만 던진다.
 * - 키는 `#apiKey`·`#client`(직렬화 안 됨). toJSON 은 이름·모델만.
 */
import Anthropic from '@anthropic-ai/sdk';
import {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_API_ORIGIN,
  ANTHROPIC_PROVIDER,
  AppError,
  LIVE_LLM_MAX_MAX_OUTPUT_TOKENS,
  LIVE_LLM_OUTPUT_JSON_SCHEMA,
  LIVE_LLM_SYSTEM_PROMPT,
  liveInputEstimateTokens,
  liveLlmReadiness,
  LiveProviderNotConfiguredError,
  liveModelOutputSchema,
  llmStructuredOutputSchema,
  type AppConfig,
  type LlmStructuredOutput,
} from '@cs/domain';
import { hasFirstPersonExpression, type LlmGenerateInput, type LlmProvider, type LlmUsage } from './llm';

export const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_API_ORIGIN}/v1/messages`;
/** 요청 1건의 시간 제한(ms). 넘으면 재시도 없이 실패(llm_timeout) — 과금됐을 수 있으므로 예약액 전액 확정(D13). */
export const CLAUDE_REQUEST_TIMEOUT_MS = 300_000;
/** D34: Opus 5.5 는 thinking 을 끌 수 없다 — 작성 보조는 낮은 effort 로 비용·지연을 줄인다. */
export const CLAUDE_EFFORT = 'low' as const;
/** 서버 규칙(llmStructuredOutputSchema)의 후속 질문 상한. 모델 스키마는 maxItems 를 지원하지 않아 서버가 앞의 3개만 쓴다. */
const MAX_FOLLOWUP_QUESTIONS = 3;

export type LiveLlmErrorCode =
  | 'llm_request_invalid'
  | 'llm_refusal'
  | 'llm_max_tokens'
  | 'llm_unexpected_stop'
  | 'llm_invalid_output'
  | 'llm_auth_failed'
  | 'llm_permission_denied'
  | 'llm_not_found'
  | 'llm_rate_limited'
  | 'llm_bad_request'
  | 'llm_server_error'
  | 'llm_timeout'
  | 'llm_connection_failed'
  | 'llm_blocked_destination'
  | 'llm_provider_error';

/** 사용자에게 보여도 되는 고정 문구(입력·모델 출력·공급자 메시지 없음). */
const MESSAGES: Record<LiveLlmErrorCode, string> = {
  llm_request_invalid: '실제 AI 요청 조건(출력 상한·프롬프트)이 맞지 않아 호출하지 않았습니다.',
  llm_refusal: 'AI 가 이 요청에 대한 응답을 거절했습니다. 본문은 바뀌지 않았습니다.',
  llm_max_tokens: 'AI 응답이 출력 상한(LLM_LIVE_MAX_OUTPUT_TOKENS)에서 끊겨 제안을 만들지 못했습니다.',
  llm_unexpected_stop: 'AI 응답이 예상하지 못한 이유로 끝나 제안을 만들지 못했습니다.',
  llm_invalid_output: 'AI 응답 형식이 올바르지 않아 제안을 만들지 못했습니다.',
  llm_auth_failed: '실제 AI 인증에 실패했습니다(ANTHROPIC_API_KEY 를 확인하세요).',
  llm_permission_denied: '실제 AI 계정에 이 요청 권한이 없습니다.',
  llm_not_found: '실제 AI 모델 또는 경로를 찾지 못했습니다(LLM_MODEL 을 확인하세요).',
  llm_rate_limited: '실제 AI 사용 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.',
  llm_bad_request: '실제 AI 가 요청 형식을 거부했습니다.',
  llm_server_error: '실제 AI 서버 오류입니다. 잠시 뒤 다시 시도하세요.',
  llm_timeout: '실제 AI 응답 시간이 초과되었습니다.',
  llm_connection_failed: '실제 AI 서버에 연결하지 못했습니다.',
  llm_blocked_destination: '허용되지 않은 주소로의 AI 요청을 막았습니다.',
  llm_provider_error: '실제 AI 호출에 실패했습니다.',
};

/**
 * 실제 AI 호출 실패(AppError kind llm_failed → 502). code 는 안정된 짧은 값이라 run.error·감사에 그대로 남는다.
 * message 는 고정 한국어 문구. 공급자 원문·헤더·요청 본문·cause 를 담지 않는다.
 */
export class LiveLlmError extends AppError {
  readonly code: LiveLlmErrorCode;
  /** HTTP 상태(숫자만, 있으면) */
  readonly httpStatus: number | null;
  /** Anthropic request-id(형식이 `req_` + 영숫자일 때만 — 입력을 되풀이하지 않는 불투명 값) */
  readonly requestId: string | null;
  /**
   * FIX1-LIVEL1: 응답을 받은 실패(refusal·max_tokens·unexpected_stop·invalid_output)의 검증된 사용량(숫자만, 텍스트 없음).
   * db 층이 max(예약액, 이 사용량 비용)으로 실패를 정산한다. 응답이 없거나 usage 가 이상하면 null(D13 — 예약액).
   */
  readonly usage: LlmUsage | null;
  constructor(code: LiveLlmErrorCode, detail: { httpStatus?: number | null; requestId?: string | null; usage?: LlmUsage | null } = {}) {
    super('llm_failed', code, MESSAGES[code]);
    this.code = code;
    this.httpStatus = typeof detail.httpStatus === 'number' && Number.isInteger(detail.httpStatus) ? detail.httpStatus : null;
    this.requestId = safeRequestId(detail.requestId);
    this.usage = detail.usage ? { tokensIn: detail.usage.tokensIn, tokensOut: detail.usage.tokensOut } : null;
  }
}

/** stop_reason=refusal(안전 분류기 거절). 모델 텍스트·stop_details 설명은 저장하지 않는다. */
export class LiveLlmRefusalError extends LiveLlmError {
  constructor(requestId: string | null = null, usage: LlmUsage | null = null) {
    super('llm_refusal', { requestId, usage });
  }
}

const safeRequestId = (v: unknown): string | null => (typeof v === 'string' && /^req_[A-Za-z0-9]{1,128}$/.test(v) ? v : null);

/** SDK 오류 → 앱 오류(구체적인 것부터). 원 오류는 버린다. */
export function mapAnthropicError(e: unknown): LiveLlmError {
  if (e instanceof LiveLlmError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new LiveLlmError('llm_timeout');
  if (e instanceof Anthropic.APIConnectionError) {
    // 우리 fetch 감싸개가 막은 목적지(SDK 가 연결 오류로 감싼다)
    if ((e as { cause?: unknown }).cause instanceof LiveLlmError) return (e as { cause: LiveLlmError }).cause;
    return new LiveLlmError('llm_connection_failed');
  }
  if (e instanceof Anthropic.APIError) {
    const d = { httpStatus: typeof e.status === 'number' ? e.status : null, requestId: e.requestID ?? null };
    if (e instanceof Anthropic.AuthenticationError) return new LiveLlmError('llm_auth_failed', d);
    if (e instanceof Anthropic.PermissionDeniedError) return new LiveLlmError('llm_permission_denied', d);
    if (e instanceof Anthropic.NotFoundError) return new LiveLlmError('llm_not_found', d);
    if (e instanceof Anthropic.RateLimitError) return new LiveLlmError('llm_rate_limited', d);
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError) return new LiveLlmError('llm_bad_request', d);
    if (e instanceof Anthropic.InternalServerError) return new LiveLlmError('llm_server_error', d);
    return new LiveLlmError('llm_provider_error', d);
  }
  return new LiveLlmError('llm_provider_error');
}

export interface ClaudeLlmOptions {
  apiKey: string;
  model: string;
  /** 시험 전용: 기록된 응답을 돌려주는 가짜 fetch. 없으면 호출 시점의 globalThis.fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const requestUrl = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/**
 * 보낼 수 있는 요청 헤더 이름(SDK 기본 헤더만). 그 밖(authorization·anthropic-beta·사용자 정의 등)은 버린다.
 * FIX1-LIVEL1: content-length 는 빼고(전송 계층이 본문으로 계산), content-type·accept·anthropic-version·x-api-key 는 아래에서 고정값으로 다시 쓴다.
 */
const ALLOWED_HEADER = /^(user-agent|x-stainless-[a-z0-9-]+)$/i;
/** 고정 SDK(0.128.0)가 보내는 API 버전(node_modules/@anthropic-ai/sdk/client.js buildHeaders 에서 확인). SDK 를 올리면 함께 확인한다. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** 0 이상 안전 정수. FIX3-LIVEL1: 원장 열 범위(MAX_TOKEN_COLUMN) 밖이어도 공급자 보고값으로 돌려준다 — 저장 가능 여부는 db 층이 판단(provider_unstorable). */
const isUsageInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export class ClaudeLlmProvider implements LlmProvider {
  readonly name = ANTHROPIC_PROVIDER;
  readonly mode = 'live' as const;
  readonly model: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #timeoutMs: number;
  #client: Anthropic | null = null;
  /**
   * 호출 입력 객체 → 그 응답에서 **공급자가 보고한 유효 usage**(없으면 null). db 층은 같은 입력 객체로 조회한다 — 출력은 zod 재파싱으로 새 객체라 키로 못 쓴다.
   * FIX2-LIVEL1: 추정값은 여기 넣지 않는다(confirmedUsageOf 가 null 을 돌려줘야 원장이 추정을 실제처럼 기록하지 않는다).
   */
  readonly #confirmed = new WeakMap<LlmGenerateInput, LlmUsage | null>();
  /**
   * FIX3-LIVEL1(놓친 a): 한 번이라도 generate 에 쓴 입력 객체. 같은 객체로 두 번째 generate(동시든 순차든)를 **보내기 전에** 거부한다 —
   * 그래서 confirmedUsageOf·usageOf(input) 는 그 객체의 유일한 호출만 가리킨다. 제품 경로(writing.ts·variants.ts)는 run 마다 새 입력 객체를 만든다.
   */
  readonly #used = new WeakSet<LlmGenerateInput>();

  constructor(opts: ClaudeLlmOptions) {
    const key = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
    if (!key || /\s/.test(key) || key.length > 512) throw new LiveProviderNotConfiguredError([`${ANTHROPIC_API_KEY_ENV}(형식)`]);
    if (typeof opts.model !== 'string' || !opts.model.trim()) throw new LiveProviderNotConfiguredError(['LLM_MODEL']);
    this.#apiKey = key;
    this.model = opts.model.trim();
    this.#fetch = opts.fetch;
    this.#timeoutMs = opts.timeoutMs ?? CLAUDE_REQUEST_TIMEOUT_MS;
  }

  /** 직렬화(로그·JSON)에 키가 나가지 않게 이름·모델만. */
  toJSON(): { name: string; mode: 'live'; model: string } {
    return { name: this.name, mode: this.mode, model: this.model };
  }

  #getClient(): Anthropic {
    if (this.#client) return this.#client;
    const base = this.#fetch;
    const apiKey = this.#apiKey;
    // 목적지 고정: 메시지 생성 주소 외에는 보내지 않는다(키가 실린 요청이 다른 호스트·경로로 가지 않게). 리다이렉트도 따라가지 않는다.
    // 헤더 허용 목록: SDK 가 늘 읽는 ANTHROPIC_CUSTOM_HEADERS(끌 옵션 없음)가 X-Api-Key 를 덮거나 Authorization·anthropic-beta 등을
    // 붙일 수 있다(시험으로 확인) → 허용 이름만 남기고 x-api-key 는 이 provider 의 키로 다시 쓴다.
    const guardedFetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (requestUrl(input) !== ANTHROPIC_MESSAGES_URL) return Promise.reject(new LiveLlmError('llm_blocked_destination'));
      const headers = new Headers();
      new Headers(init?.headers).forEach((value, name) => {
        if (ALLOWED_HEADER.test(name)) headers.set(name, value);
      });
      headers.set('accept', 'application/json');
      headers.set('content-type', 'application/json');
      headers.set('anthropic-version', ANTHROPIC_API_VERSION);
      headers.set('x-api-key', apiKey);
      return (base ?? globalThis.fetch)(input, { ...init, headers, redirect: 'error' });
    }) as typeof fetch;
    this.#client = new Anthropic({
      apiKey: this.#apiKey,
      authToken: null,
      baseURL: ANTHROPIC_API_ORIGIN,
      maxRetries: 0,
      timeout: this.#timeoutMs,
      logLevel: 'off',
      fetch: guardedFetch,
    });
    return this.#client;
  }

  async generate(input: LlmGenerateInput): Promise<LlmStructuredOutput> {
    if (this.#used.has(input)) throw new LiveLlmError('llm_request_invalid');
    this.#used.add(input);
    return this.#generate(input);
  }

  async #generate(input: LlmGenerateInput): Promise<LlmStructuredOutput> {
    const maxTokens = input.maxOutputTokens;
    // 예약의 출력 몫 = max_tokens — 없거나 범위 밖이면 보내기 전에 거부.
    if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > LIVE_LLM_MAX_MAX_OUTPUT_TOKENS) {
      throw new LiveLlmError('llm_request_invalid');
    }
    if (typeof input.prompt !== 'string' || input.prompt.trim() === '') throw new LiveLlmError('llm_request_invalid');

    let message: Anthropic.Message;
    try {
      message = await this.#getClient().messages.create({
        model: this.model,
        max_tokens: maxTokens,
        system: LIVE_LLM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: input.prompt }],
        output_config: { effort: CLAUDE_EFFORT, format: { type: 'json_schema', schema: LIVE_LLM_OUTPUT_JSON_SCHEMA } },
      });
    } catch (e) {
      throw mapAnthropicError(e);
    }

    const requestId = safeRequestId((message as { _request_id?: unknown } | null)?._request_id);
    // FIX1-LIVEL1: 사용량을 종료 사유·출력 검증보다 먼저 읽어 검증한다 — 실패해도 숫자만 오류에 실어 정산에 쓴다.
    const usage = readUsage((message as { usage?: unknown } | null)?.usage);
    // stop_reason 을 내용보다 먼저 본다.
    const stop = (message as { stop_reason?: unknown } | null)?.stop_reason;
    if (stop === 'refusal') throw new LiveLlmRefusalError(requestId, usage);
    if (stop === 'max_tokens') throw new LiveLlmError('llm_max_tokens', { requestId, usage });
    if (stop !== 'end_turn') throw new LiveLlmError('llm_unexpected_stop', { requestId, usage });

    const output = this.#parseOutput(message, input, requestId, usage);
    // FIX2-LIVEL1: 확인된 usage 만 저장(없으면 null). 추정이 필요한 곳은 usageOf(추정 대체)를 쓴다.
    this.#confirmed.set(input, usage);
    return output;
  }

  #parseOutput(message: Anthropic.Message, input: LlmGenerateInput, requestId: string | null, usage: LlmUsage | null): LlmStructuredOutput {
    const invalid = () => new LiveLlmError('llm_invalid_output', { requestId, usage });
    const content: unknown = (message as { content?: unknown }).content;
    // FIX1-LIVEL1: content 가 배열이 아니거나 블록이 객체가 아니면 안정된 코드로(TypeError 로 새지 않게)
    if (!Array.isArray(content)) throw invalid();
    const texts: string[] = [];
    for (const block of content as unknown[]) {
      if (!block || typeof block !== 'object') throw invalid();
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text') {
        if (typeof b.text !== 'string') throw invalid();
        texts.push(b.text);
      } else if (b.type !== 'thinking' && b.type !== 'redacted_thinking') throw invalid();
    }
    if (texts.length === 0) throw invalid();
    let raw: unknown;
    try {
      raw = JSON.parse(texts.join(''));
    } catch {
      throw invalid();
    }
    const model = liveModelOutputSchema.safeParse(raw);
    if (!model.success) throw invalid();
    const m = model.data;
    // 1인칭 표현이 있거나 experience 인 claim 은 experience + 사용자 확인 필요(모의와 같은 규칙, 보수적 방향으로만 바꾼다).
    const reclassified = m.claims.map((c) =>
      c.kind === 'experience' || hasFirstPersonExpression(c.text) ? { ...c, kind: 'experience' as const, needs_user_confirmation: true } : c,
    );
    const claims = dedupeExperienceClaims(reclassified);
    // FIX1-LIVEL1(놓친 케이스 c): 제안 본문의 1인칭 문장이 experience claim 으로 덮이지 않으면 서버가 experience claim(확인 필요, 출처 없음)을
    // 더한다 — 채택 뒤 미확인 경험 게이트(claims-gate)가 모의와 같이 막도록. 출처·증거 등급을 만들지 않는다(보수적 방향만).
    // FIX3-LIVEL1: 단위는 문단(splitParagraphs), 덮임은 **정규화 텍스트 완전 일치**만 — 포함·부분 일치는 쓰지 않는다
    // (부정·인용·가정문으로 감싼 긴 claim 이나 짧은 부분 claim 이 본문 경험을 덮지 못하게). 덮이지 않은 1인칭 문단은 문단 전체를 한 claim 으로.
    const experienceTexts = new Set(claims.filter((c) => c.kind === 'experience').map((c) => normalizeForCoverage(c.text)));
    for (const paragraph of splitParagraphs(m.proposed_text)) {
      if (!hasFirstPersonExpression(paragraph)) continue;
      const p = normalizeForCoverage(paragraph);
      if (p === '' || experienceTexts.has(p)) continue;
      claims.push({ text: paragraph, kind: 'experience', source_refs: [], needs_user_confirmation: true });
      experienceTexts.add(p);
    }
    // result_type·input_version 은 서버가 입력에서 정한다(모델 출력을 믿지 않음).
    const assembled = {
      result_type: input.task,
      input_version: input.inputVersion,
      proposed_text: m.proposed_text,
      proposed_tags: m.proposed_tags,
      claims,
      followup_questions: m.followup_questions.slice(0, MAX_FOLLOWUP_QUESTIONS),
      warnings: m.warnings,
    };
    const checked = llmStructuredOutputSchema.safeParse(assembled);
    if (!checked.success) throw invalid();
    return checked.data;
  }

  /** 예약과 같은 보수적 추정(입력 추정 + max_tokens) — usage 를 믿을 수 없을 때. 증명된 상한이 아니다. */
  #estimate(input: LlmGenerateInput): LlmUsage {
    return { tokensIn: liveInputEstimateTokens(input.prompt ?? ''), tokensOut: input.maxOutputTokens ?? LIVE_LLM_MAX_MAX_OUTPUT_TOKENS };
  }

  /** 그 호출에서 공급자가 보고한 유효 usage. 없거나(응답 없음·usage 없음·이상값·열 범위 밖) 모르는 입력이면 null — 추정값을 돌려주지 않는다. */
  confirmedUsageOf(input: LlmGenerateInput): LlmUsage | null {
    return this.#confirmed.get(input) ?? null;
  }

  /** LlmProvider 호환: 확인된 usage, 없으면 보수적 추정(원장 기록에는 쓰지 않는다 — db 층은 confirmedUsageOf 를 쓴다). */
  usageOf(input: LlmGenerateInput, output: LlmStructuredOutput): LlmUsage {
    void output;
    return this.confirmedUsageOf(input) ?? this.#estimate(input);
  }
}

/**
 * FIX4-LIVEL1: 덮임 판정용 정규화 = NFC(분해형 한글 등 같은 글자의 다른 표현만 맞춤 — 호환 문자 접기(NFKC)는 하지 않는 보수적 선택)
 * + 공백 접기(줄바꿈 포함) + trim. 본문 문단과 claim 양쪽에 같은 함수를 쓴다.
 */
const normalizeForCoverage = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim();

/**
 * LIVEL1-H2: 모델이 같은 경험 claim 을 NFC·NFD(또는 바이트까지 같게) 여러 번 내면 앞의 것 하나만 남긴다 — 같은 문장을 여러 번 확인하지 않게.
 * - 대상: 재분류 뒤 kind 'experience' 만. fact·opinion 은 게이트 대상이 아니므로 그대로 둔다.
 * - 키: **`text.normalize('NFC')` 그대로**(공백 접기·trim·NFKC 없음). 이 단계는 db 층의 sanitizeLlmOutput(인용·출처 검사)보다 **앞**이라,
 *   지운 claim 은 정제가 보지 못한다. normalizeForCoverage 처럼 `\s` 로 접으면 U+FEFF·탭만 다른 claim(예: `fake\uFEFF.example`,
 *   버린 출처 문구 `fake\tsource`)이 지워져 unverifiable_citation 을 피할 수 있다. NFC 로 같은 두 문자열은 정제의 전처리
 *   (서식 문자 제거 + NFKC) 결과도 같으므로 검사 결과가 바뀌지 않는다. 공백만 있는 claim 은 지우지 않는다.
 * - 출처: 뒤 claim 의 source_refs 원문이 모두 같은 키의 남은 claim 에 그대로(===) 있을 때만 지운다(빈 목록은 부분집합).
 *   그래서 정제가 버리는 출처 문구 집합이 같다. 아니면 둘 다 남긴다(확인이 한 번 더 필요할 뿐 — 안전 쪽).
 * - 남는 claim 은 고치지 않는다(원문 바이트·출처·확인 표시 그대로, 출처를 합치지 않음).
 * 부수 효과: 지운 중복이 허용 밖 출처를 들고 있었다면 정제의 "출처 미확인 … N건" 경고 개수가 그만큼 줄어든다(출처 문구 집합은 같음).
 * 본문 문단과의 덮임(아래 experienceTexts·normalizeForCoverage)은 바뀌지 않는다.
 */
function dedupeExperienceClaims<C extends { text: string; kind: string; source_refs: string[] }>(claims: readonly C[]): C[] {
  const kept: C[] = [];
  const refsByKey = new Map<string, Array<readonly string[]>>();
  for (const c of claims) {
    if (c.kind !== 'experience') {
      kept.push(c);
      continue;
    }
    const key = c.text.normalize('NFC');
    if (key.trim() === '') {
      kept.push(c);
      continue;
    }
    const seen = refsByKey.get(key);
    if (seen?.some((refs) => c.source_refs.every((r) => refs.includes(r)))) continue;
    kept.push(c);
    refsByKey.set(key, [...(seen ?? []), c.source_refs]);
  }
  return kept;
}

/**
 * FIX3/FIX4-LIVEL1: 1인칭 확인 claim 의 단위 = **문단** — 빈 줄(공백만 있는 줄 포함, CRLF·CR 은 LF 로 맞춘 뒤 `\n\s*\n`)로만 나눈다.
 * 한 줄바꿈은 문단 안(주어와 서술이 다른 줄이어도 한 단위). 문장 분리는 쓰지 않는다. 앞뒤 공백을 뗀 빈 문단은 버린다.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 응답 usage 검증(FIX1-LIVEL1). 입력 = input + 캐시 생성·읽기 입력, 출력 = output(thinking 포함).
 * input·output 은 0 이상 안전 정수여야 하고, 캐시 필드는 없음·null 이면 0, **있는데 이상하면**(문자열·음수·소수·안전 정수 밖) 전체를 믿지 않는다.
 * 합계도 안전 정수여야 한다. 믿을 수 없으면 null. FIX3-LIVEL1: 원장 열 범위 밖 값은 null 로 버리지 않는다(db 층 provider_unstorable).
 */
export function readUsage(raw: unknown): LlmUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  if (!isUsageInt(u.input_tokens) || !isUsageInt(u.output_tokens)) return null;
  const cache = (v: unknown): number | null => (v === undefined || v === null ? 0 : isUsageInt(v) ? v : null);
  const cacheCreate = cache(u.cache_creation_input_tokens);
  const cacheRead = cache(u.cache_read_input_tokens);
  if (cacheCreate === null || cacheRead === null) return null;
  const tokensIn = u.input_tokens + cacheCreate + cacheRead;
  if (!Number.isSafeInteger(tokensIn)) return null;
  return { tokensIn, tokensOut: u.output_tokens };
}

/**
 * LIVE-L1: 실제 AI 공급자 선택 — 화면과 같은 준비 판정(liveLlmReadiness)이 ready 일 때만 ClaudeLlmProvider, 아니면 빠진 이름만 담은
 * LiveProviderNotConfiguredError(503). 키는 env 에서 호출 시점에 읽고(서버 전용) 값은 오류·로그에 넣지 않는다.
 */
export function resolveLiveLlmProvider(
  config: AppConfig,
  env: Record<string, string | undefined>,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): ClaudeLlmProvider {
  const r = liveLlmReadiness(config, env);
  if (!r.ready) throw new LiveProviderNotConfiguredError(r.missing);
  return new ClaudeLlmProvider({ apiKey: env[ANTHROPIC_API_KEY_ENV]!, model: config.LLM_MODEL!, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
}
