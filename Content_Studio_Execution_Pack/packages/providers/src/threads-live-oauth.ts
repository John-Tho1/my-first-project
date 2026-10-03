/**
 * LIVE-T1(결정 D31 1단계): 실제 Threads OAuth 공급자 — 연결(인증 창 → 코드 교환 → 장기 토큰 교환) · 프로필 조회 · 장기 토큰 갱신.
 * **게시(컨테이너·threads_publish)는 없다**(D31 범위 밖 — LIVE_THREADS_PUBLISH(D31 범위 밖)).
 *
 * 공식 문서(2026-10-03 열람, docs/handoffs/LIVET1_IMPLEMENTATION_HANDOFF.md 에 출처):
 * - 인증 창: GET https://threads.com/oauth/authorize ? client_id · redirect_uri · scope(쉼표) · response_type=code · state.
 *   PKCE(code_challenge) 는 문서에 없다 → 보내지 않는다(pkce=false). state(세션 결합·1회용·10분) + redirect URI 정확 일치 + 서버 쪽 client_secret 으로 막는다.
 *   redirect 뒤 code 끝에 "#_" 가 붙을 수 있다(코드 일부 아님) — 떼고 쓴다.
 * - 코드 교환: POST https://graph.threads.com/oauth/access_token (form: client_id · client_secret · grant_type=authorization_code · redirect_uri · code)
 *   → { access_token, user_id } (단기 토큰). 코드는 1시간·1회용. user_id 는 JSON 숫자라 2^53 을 넘을 수 있어 **읽지 않는다**(프로필 /me 의 문자열 id 를 쓴다).
 * - 장기 토큰 교환: GET https://graph.threads.net/access_token ? grant_type=th_exchange_token · client_secret · access_token → { access_token, token_type, expires_in } (60일).
 * - 장기 토큰 갱신: GET https://graph.threads.net/refresh_access_token ? grant_type=th_refresh_token · access_token (발급 24시간 뒤 ~ 만료 전, 갱신 시점부터 60일).
 * - 프로필: GET https://graph.threads.net/v1.0/me ? fields=id,username · access_token → { id(문자열), username }.
 * - 토큰 철회 API: 문서에 없다 → revoke 는 네트워크 없이 { remoteRevoke: 'unsupported' } (T13 로컬 삭제 규칙 그대로). 사용자는 Threads 앱 설정에서 앱 권한을 지울 수 있다.
 *
 * 비밀 위생: client_secret·토큰은 이 클래스의 # 비공개 필드·지역 변수에만. 공식 문서대로 GET 질의 문자열에 들어가는 요청이 있으므로
 * URL 을 기록·직렬화하지 않는다 — 모든 실패는 새 OAuthProviderError(코드 + 숫자·열거 부가 정보)로 바꾸고 원 오류(cause)·URL·공급자 메시지 원문을 버린다.
 * 리다이렉트는 따르지 않는다(redirect: 'error' — 질의의 시크릿이 다른 호스트로 가지 않게). 허용 호스트 밖으로는 보내지 않는다.
 * 네트워크: 생성자에 fetch 를 주입할 수 있다(시험은 fixture fetch 만). 주입하지 않으면 호출 시점의 globalThis.fetch.
 */
import {
  isPlainRedirectUri,
  OAuthProviderError,
  THREADS_REQUIRED_SCOPES,
  type OAuthAccountInfo,
  type OAuthAuthorizeRequest,
  type OAuthProvider,
  type OAuthProviderErrorCode,
  type OAuthProviderErrorDetail,
  type OAuthRevokeOutcome,
  type OAuthTokenSet,
  type StoredOAuthTokens,
} from '@cs/domain';

export const THREADS_AUTHORIZE_URL = 'https://threads.com/oauth/authorize';
export const THREADS_TOKEN_URL = 'https://graph.threads.com/oauth/access_token';
export const THREADS_LONG_LIVED_URL = 'https://graph.threads.net/access_token';
export const THREADS_REFRESH_URL = 'https://graph.threads.net/refresh_access_token';
export const THREADS_ME_URL = 'https://graph.threads.net/v1.0/me';
/** 이 공급자가 요청을 보낼 수 있는 호스트(https 만). 인증 창(threads.com)은 브라우저가 연다 — 서버는 부르지 않는다. */
export const THREADS_API_HOSTS: ReadonlySet<string> = new Set(['graph.threads.com', 'graph.threads.net']);
export const LIVE_THREADS_HTTP_TIMEOUT_MS = 10_000;
/** 장기 토큰 expires_in 상한(초) — 문서상 60일. 이상한 값(음수·1년 초과)은 형식 오류로 본다. */
const MAX_EXPIRES_IN_SEC = 366 * 24 * 3600;

type Step = NonNullable<OAuthProviderErrorDetail['step']>;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 쓰기(코드 소비·토큰 발급)가 일어날 수 있는 단계 — 전송 실패·5xx·2xx 형식 오류면 결과 불명(ambiguous) */
const WRITE_STEPS: ReadonlySet<Step> = new Set(['exchange', 'long_lived', 'refresh']);

/** Meta 오류 본문의 두 형태: { error: { message, type, code, error_subcode } } · { error_type, code, error_message } (Threads OAuth 문서 예시) */
interface ParsedProviderError {
  code: number | null;
  subcode: number | null;
  type: string | null;
  /** 분류에만 쓰고 어디에도 저장하지 않는다 */
  message: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function parseThreadsErrorBody(body: unknown): ParsedProviderError | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>;
    return { code: num(e.code), subcode: num(e.error_subcode), type: str(e.type) || null, message: str(e.message) };
  }
  if ('error_type' in b || 'error_message' in b) {
    return { code: num(b.code), subcode: num(b.error_subcode), type: str(b.error_type) || null, message: str(b.error_message) };
  }
  if (typeof b.error === 'string') return { code: null, subcode: null, type: b.error, message: str(b.error_description) };
  return null;
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const TRANSIENT_CODES = new Set([1, 2]);
const CLIENT_MESSAGE = /client[_ ]?secret|app(lication)? secret|invalid client|client[_ ]?id|invalid app(lication)? id|validating application/i;
const REDIRECT_MESSAGE = /redirect[_ ]?uri/i;

/**
 * 공급자 오류 → 기존 T13 코드(OAuthProviderErrorCode) + 숫자·열거 부가 정보. 메시지 원문은 분류에만 쓰고 결과에 넣지 않는다.
 * - 429·코드 4/17/32/613 → provider_error(rate_limited, retryAfterSec)
 * - 앱 ID·시크릿 거부(메시지 또는 코드 101) → invalid_client
 * - 190 → invalid_token(하위 463 = token_expired, 458·460 = token_revoked)
 * - 10·200~299 → scope_not_allowed
 * - 5xx·코드 1/2 → provider_error(server_error, 쓰기 단계면 ambiguous)
 * - 코드 교환 단계의 그 밖 4xx(문서 예: code 400 "Matching code was not found or was already used") → invalid_grant
 *   (redirect_uri 언급 → redirect_mismatch). 그 밖 4xx → invalid_request.
 */
export function mapThreadsError(step: Step, httpStatus: number, body: unknown, retryAfterHeader: string | null = null): OAuthProviderError {
  const p = parseThreadsErrorBody(body);
  const base: OAuthProviderErrorDetail = { reason: p ? 'oauth_exception' : 'http_error', step, httpStatus };
  if (p?.code !== null && p?.code !== undefined) base.providerCode = p.code;
  if (p?.subcode !== null && p?.subcode !== undefined) base.providerSubcode = p.subcode;
  const err = (code: OAuthProviderErrorCode, extra: Partial<OAuthProviderErrorDetail> = {}) => new OAuthProviderError(code, { ...base, ...extra });
  const code = p?.code ?? null;
  if (httpStatus === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
    const ra = retryAfterHeader && /^\d{1,6}$/.test(retryAfterHeader.trim()) ? Number(retryAfterHeader.trim()) : undefined;
    return err('provider_error', { reason: 'rate_limited', ...(ra !== undefined ? { retryAfterSec: ra } : {}) });
  }
  if (code === 101 || (p && CLIENT_MESSAGE.test(p.message) && !REDIRECT_MESSAGE.test(p.message))) return err('invalid_client');
  if (code === 190) {
    if (p?.subcode === 463) return err('token_expired');
    if (p?.subcode === 458 || p?.subcode === 460) return err('token_revoked');
    return err('invalid_token');
  }
  if (code === 10 || (code !== null && code >= 200 && code < 300)) return err('scope_not_allowed');
  if (httpStatus >= 500 || (code !== null && TRANSIENT_CODES.has(code))) {
    return err('provider_error', { reason: 'server_error', ambiguous: WRITE_STEPS.has(step) });
  }
  if (step === 'exchange') {
    if (p && REDIRECT_MESSAGE.test(p.message)) return err('redirect_mismatch');
    return err('invalid_grant');
  }
  if (httpStatus === 401) return err('invalid_token');
  return err('invalid_request');
}

const isAbort = (e: unknown): boolean =>
  !!e && typeof e === 'object' && ((e as { name?: unknown }).name === 'TimeoutError' || (e as { name?: unknown }).name === 'AbortError');

export class LiveThreadsOAuthProvider implements OAuthProvider {
  readonly id = 'threads' as const;
  readonly platform = 'threads' as const;
  readonly mock = false;
  readonly pkce = false;
  /** 앱 ID(비밀 아님 — authorize URL 에 들어간다) */
  readonly appId: string;
  /** 앱 대시보드에 등록된 redirect URI(정확 일치) */
  readonly registeredRedirectUri: string;
  readonly #appSecret: string;
  readonly #fetch: FetchLike | null;
  readonly #timeoutMs: number;

  constructor(opts: { appId: string; appSecret: string; registeredRedirectUri: string; fetch?: FetchLike; timeoutMs?: number }) {
    if (!/^\d{1,30}$/.test(opts.appId)) throw new OAuthProviderError('invalid_client', { reason: 'local_check' });
    if (!opts.appSecret || /\s/.test(opts.appSecret)) throw new OAuthProviderError('invalid_client', { reason: 'local_check' });
    if (!isPlainRedirectUri(opts.registeredRedirectUri)) throw new OAuthProviderError('redirect_mismatch', { reason: 'local_check' });
    this.appId = opts.appId;
    this.#appSecret = opts.appSecret;
    this.registeredRedirectUri = opts.registeredRedirectUri;
    this.#fetch = opts.fetch ?? null;
    this.#timeoutMs = opts.timeoutMs ?? LIVE_THREADS_HTTP_TIMEOUT_MS;
  }

  requiredScopes(): readonly string[] {
    return THREADS_REQUIRED_SCOPES;
  }

  /** 직렬화(JSON·로그)해도 시크릿이 나가지 않는다(# 필드는 원래 직렬화되지 않지만 명시). */
  toJSON(): Record<string, unknown> {
    return { id: this.id, platform: this.platform, mock: this.mock, pkce: this.pkce, redirect_uri: this.registeredRedirectUri };
  }

  buildAuthorizeUrl(req: OAuthAuthorizeRequest): string {
    if (req.redirectUri !== this.registeredRedirectUri) throw new OAuthProviderError('redirect_mismatch', { reason: 'local_check', step: 'authorize' });
    const allowed = new Set<string>(THREADS_REQUIRED_SCOPES);
    if (!req.scopes.length || req.scopes.some((s) => !allowed.has(s))) throw new OAuthProviderError('scope_not_allowed', { reason: 'local_check', step: 'authorize' });
    if (!req.state) throw new OAuthProviderError('invalid_request', { reason: 'local_check', step: 'authorize' });
    const u = new URL(THREADS_AUTHORIZE_URL);
    u.searchParams.set('client_id', this.appId);
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('scope', req.scopes.join(','));
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('state', req.state);
    // PKCE 없음(문서에 없음) — code_challenge 를 싣지 않는다. login_hint 도 없다(실제 공급자는 사용자가 로그인한 계정).
    return u.toString();
  }

  /** 코드 교환(단기 토큰) → 장기 토큰 교환. 단기 토큰은 저장하지 않는다(장기 교환이 실패하면 버림 — 철회 API 없음, 수명 ≤ 1시간 추정). */
  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; now: Date }): Promise<OAuthTokenSet> {
    if (input.redirectUri !== this.registeredRedirectUri) throw new OAuthProviderError('redirect_mismatch', { reason: 'local_check', step: 'exchange' });
    const code = input.code.endsWith('#_') ? input.code.slice(0, -2) : input.code;
    if (!code || code.length > 2000 || /\s/.test(code)) throw new OAuthProviderError('invalid_grant', { reason: 'local_check', step: 'exchange' });
    const form = new URLSearchParams();
    form.set('client_id', this.appId);
    form.set('client_secret', this.#appSecret);
    form.set('grant_type', 'authorization_code');
    form.set('redirect_uri', input.redirectUri);
    form.set('code', code);
    const short = await this.#call('exchange', new URL(THREADS_TOKEN_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
    });
    const shortToken = this.#token(short.access_token, 'exchange');
    const u = new URL(THREADS_LONG_LIVED_URL);
    u.searchParams.set('grant_type', 'th_exchange_token');
    u.searchParams.set('client_secret', this.#appSecret);
    u.searchParams.set('access_token', shortToken);
    const long = await this.#call('long_lived', u, { method: 'GET', headers: { accept: 'application/json' } });
    return this.#tokenSet(long, 'long_lived', input.now);
  }

  /** 장기 토큰 갱신(refresh token 없음 — 장기 토큰 자체로). 발급 24시간 안의 갱신은 공급자가 거부할 수 있다(invalid_request — 상태는 active 유지). */
  async refresh(input: { tokens: StoredOAuthTokens; now: Date }): Promise<OAuthTokenSet> {
    const u = new URL(THREADS_REFRESH_URL);
    u.searchParams.set('grant_type', 'th_refresh_token');
    u.searchParams.set('access_token', this.#token(input.tokens.accessToken, 'refresh'));
    const body = await this.#call('refresh', u, { method: 'GET', headers: { accept: 'application/json' } });
    return this.#tokenSet(body, 'refresh', input.now);
  }

  /** 공식 문서에 토큰 철회 API 가 없다 — 네트워크 호출 없이 "지원 안 함". 호출자는 T13 로컬 삭제 규칙을 그대로 적용한다. */
  async revoke(_input: { tokens: StoredOAuthTokens; now: Date }): Promise<OAuthRevokeOutcome> {
    return { remoteRevoke: 'unsupported' };
  }

  async accountInfo(input: { accessToken: string; now: Date }): Promise<OAuthAccountInfo> {
    const u = new URL(THREADS_ME_URL);
    u.searchParams.set('fields', 'id,username');
    u.searchParams.set('access_token', this.#token(input.accessToken, 'account'));
    const body = await this.#call('account', u, { method: 'GET', headers: { accept: 'application/json' } });
    const id = body.id;
    const username = body.username;
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw new OAuthProviderError('provider_error', { reason: 'malformed_response', step: 'account' });
    const name = typeof username === 'string' && /^[A-Za-z0-9._]{1,64}$/.test(username) ? `@${username}` : 'Threads 계정';
    return { externalAccountId: id, displayName: name };
  }

  #token(v: unknown, step: Step): string {
    if (typeof v !== 'string' || v.length < 8 || v.length > 4096 || /\s/.test(v)) {
      throw new OAuthProviderError(step === 'refresh' || step === 'account' ? 'invalid_token' : 'provider_error', {
        reason: step === 'refresh' || step === 'account' ? 'local_check' : 'malformed_response',
        step,
        ambiguous: WRITE_STEPS.has(step) && step !== 'refresh',
      });
    }
    return v;
  }

  #tokenSet(body: Record<string, unknown>, step: Step, now: Date): OAuthTokenSet {
    const accessToken = this.#token(body.access_token, step === 'refresh' ? 'long_lived' : step);
    const sec = body.expires_in;
    if (typeof sec !== 'number' || !Number.isInteger(sec) || sec <= 0 || sec > MAX_EXPIRES_IN_SEC) {
      throw new OAuthProviderError('provider_error', { reason: 'malformed_response', step, ambiguous: true });
    }
    // Threads 토큰 응답에는 허용된 scope 가 없다 — 요청한 최소 scope 를 기록한다(부분 허용은 여기서 알 수 없음, 핸드오프 위험 항목).
    return { accessToken, refreshToken: null, expiresAt: new Date(now.getTime() + sec * 1000), accessExpiresAt: null, scopes: [...THREADS_REQUIRED_SCOPES] };
  }

  async #call(step: Step, url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    if (url.protocol !== 'https:' || !THREADS_API_HOSTS.has(url.hostname)) throw new OAuthProviderError('provider_error', { reason: 'host_not_allowed', step });
    const f: FetchLike = this.#fetch ?? ((i, o) => globalThis.fetch(i, o));
    const ambiguousOnTransport = WRITE_STEPS.has(step);
    let res: Response;
    try {
      res = await f(url.toString(), { ...init, redirect: 'error', signal: AbortSignal.timeout(this.#timeoutMs) });
    } catch (e) {
      // 원 오류는 버린다(undici 오류의 cause 에 URL — 질의의 시크릿·토큰 — 이 있을 수 있다)
      throw new OAuthProviderError('provider_error', { reason: isAbort(e) ? 'timeout' : 'network', step, ambiguous: ambiguousOnTransport });
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      throw new OAuthProviderError('provider_error', { reason: isAbort(e) ? 'timeout' : 'network', step, httpStatus: res.status, ambiguous: ambiguousOnTransport });
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    // 2xx 인데 오류 본문(성공 필드 없음)인 경우도 공급자 오류로 본다
    const hasSuccessField = !!body && typeof body === 'object' && ('access_token' in body || 'id' in body);
    if (!res.ok || (parseThreadsErrorBody(body) !== null && !hasSuccessField)) {
      throw mapThreadsError(step, res.status, body, res.headers.get('retry-after'));
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OAuthProviderError('provider_error', { reason: 'malformed_response', step, httpStatus: res.status, ambiguous: ambiguousOnTransport });
    }
    return body as Record<string, unknown>;
  }
}
