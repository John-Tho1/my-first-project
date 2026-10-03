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
  isValidThreadsAppId,
  isValidThreadsAppSecret,
  LiveRefreshOutOfScopeError,
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

/**
 * FIX4-LIVET1(Codex review-FIX3-LIVET1 P0 :89 — 구조적): 본문 형태별 분기(Graph 객체 · Threads error_type · OAuth2 문자열)를 없애고
 * **하나의 정규화**로 모은다. 알려진 모든 자리(최상위 + 중첩 error 객체)의 알려진 모든 필드를 읽어 한 기록에 **합친다** —
 * 한 자리·형태가 있다고 다른 자리의 신호를 버리지 않는다(예: { error: 'invalid_client', code: 2, is_transient: true } 의 code·is_transient).
 */
export interface NormalizedThreadsError {
  /** 문자열 식별자(trim·소문자, 빈 값 제외, 중복 제거) — 최상위 error(문자열)·error_type·type, 중첩 error.error(문자열)·error.error_type·error.type */
  identifiers: string[];
  /** 0 이상 정수로 읽힌 code·error_code 값(최상위·중첩, 중복 제거) */
  codes: number[];
  /** codes 가 정확히 1개일 때 그 값(부가 정보 providerCode), 아니면 null */
  numericCode: number | null;
  /** 0 이상 정수로 읽힌 error_subcode 값(최상위·중첩, 중복 제거) */
  subcodes: number[];
  /** subcodes 가 정확히 1개일 때 그 값, 아니면 null */
  subcode: number | null;
  /**
   * 있는데 형식이 깨진 신호(FIX3 의 "알 수 없는 코드" 를 모든 자리로 넓힘): code·error_code·error_subcode 가 0 이상 정수로 안 읽힘
   * ("1.0"·"abc"·""·1.5·-1), is_transient 가 불리언이 아님, 식별자 자리(error·error_type·type)에 문자열이 아닌 값(error 는 객체 허용).
   * "코드 없음"으로 바꾸지 않는다 — 알 수 없음(쓰기 단계면 결과 불명).
   */
  malformedCode: boolean;
  /** is_transient — 하나라도 true → true, 있는 것이 모두 false → false, 없음 → null */
  isTransientFlag: boolean | null;
  /** 이미 확정된 범용 결과를 좁힐 때만 쓰고 어디에도 저장하지 않는다 — error_description·error_message·message·error_user_msg·error_user_title(최상위·중첩) */
  messages: string[];
}

/** 0 이상 정수만(숫자 또는 1~9자리 숫자 문자열). 소수·음수·지수·공백은 null — 범위 비교(200~299 등)가 소수에 걸리지 않게 */
const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null;
const present = (v: unknown): boolean => v !== undefined && v !== null;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const ID_KEYS = ['error', 'error_type', 'type'] as const;
const CODE_KEYS = ['code', 'error_code'] as const;
const MESSAGE_KEYS = ['error_description', 'error_message', 'message', 'error_user_msg', 'error_user_title'] as const;
/** 최상위에 이 중 하나라도(null 아님) 있으면 공급자 오류 본문으로 본다. type·message 단독은 너무 흔한 이름이라 인식 근거로 쓰지 않는다(인식된 본문에서는 읽는다). */
const RECOGNIZED_TOP_KEYS = ['error', 'error_type', 'error_message', 'error_description', 'error_code', 'error_subcode', 'error_user_msg', 'error_user_title', 'is_transient', 'code'] as const;

export function normalizeThreadsErrorBody(body: unknown): NormalizedThreadsError | null {
  if (!isPlainObject(body)) return null;
  const top = body;
  if (!RECOGNIZED_TOP_KEYS.some((k) => present(top[k]))) return null;
  const nested = isPlainObject(top.error) ? top.error : null;
  const ids = new Set<string>();
  const codes = new Set<number>();
  const subcodes = new Set<number>();
  const messages: string[] = [];
  let malformedCode = false;
  let anyTrue = false;
  let anyFalse = false;
  for (const src of nested ? [top, nested] : [top]) {
    for (const k of ID_KEYS) {
      const v = src[k];
      if (!present(v) || (src === top && k === 'error' && v === nested)) continue;
      if (typeof v === 'string') {
        const id = v.trim().toLowerCase();
        if (id) ids.add(id);
      } else malformedCode = true;
    }
    for (const k of [...CODE_KEYS, 'error_subcode'] as const) {
      const v = src[k];
      if (!present(v)) continue;
      const n = num(v);
      if (n === null) malformedCode = true;
      else (k === 'error_subcode' ? subcodes : codes).add(n);
    }
    const t = src.is_transient;
    if (t === true) anyTrue = true;
    else if (t === false) anyFalse = true;
    else if (present(t)) malformedCode = true;
    for (const k of MESSAGE_KEYS) {
      const v = src[k];
      if (typeof v === 'string' && v) messages.push(v);
    }
  }
  const codeList = [...codes];
  const subList = [...subcodes];
  return {
    identifiers: [...ids],
    codes: codeList,
    numericCode: codeList.length === 1 ? codeList[0]! : null,
    subcodes: subList,
    subcode: subList.length === 1 ? subList[0]! : null,
    malformedCode,
    isTransientFlag: anyTrue ? true : anyFalse ? false : null,
    messages,
  };
}

/**
 * FIX2-LIVET1(Codex review-FIX-LIVET1 P0 :138): 일시(transient) 코드 표 — **문구보다 먼저** 보고, 문구가 절대 덮어쓰지 않는다.
 * Meta Graph API 오류 코드 관례(Graph API "Handling Errors"·"Rate Limiting" 문서): 1 API Unknown(재시도), 2 API Service(일시),
 * 4 앱 호출 제한, 17 사용자 호출 제한, 32 페이지 호출 제한, 341 앱 한도 도달, 613 호출 빈도 초과, 80000~80014 비즈니스 사용 사례(BUC) 제한.
 * Threads 문서에 같은 표가 따로 있는지는 이번 라운드에서 다시 확인하지 않았다(핸드오프 위험 항목).
 * FIX3-LIVET1(Codex review-FIX2-LIVET1 Q10): 이 표에서 나온 결과는 **쓰기 단계면 rate_limited 도 ambiguous=true** — 그래서 표에 넣는 것이
 * 확정 실패를 만들지 않는다(결과 불명 보존). 읽기 단계(account)는 부작용이 없어 ambiguous 를 달지 않는다.
 */
export const THREADS_TRANSIENT_CODES: ReadonlyMap<number, 'rate_limited' | 'server_error'> = new Map<number, 'rate_limited' | 'server_error'>([
  [1, 'server_error'],
  [2, 'server_error'],
  [4, 'rate_limited'],
  [17, 'rate_limited'],
  [32, 'rate_limited'],
  [341, 'rate_limited'],
  [613, 'rate_limited'],
  ...Array.from({ length: 15 }, (_, i): [number, 'rate_limited'] => [80000 + i, 'rate_limited']),
]);

/** 확정(definite) 코드 표 — 공급자가 처리하지 않고 거절했다고 아는 코드. 여기에 없는 코드는 "알 수 없음"(쓰기 단계면 결과 불명). */
function definiteByCode(step: Step, code: number, subcode: number | null): OAuthProviderErrorCode | null {
  if (code === 101) return 'invalid_client';
  if (code === 190) {
    if (subcode === 463) return 'token_expired';
    if (subcode === 458 || subcode === 460) return 'token_revoked';
    return 'invalid_token';
  }
  if (code === 10 || (code >= 200 && code < 300)) return 'scope_not_allowed';
  // 코드 교환: 문서 예시 400("Matching code was not found or was already used"), Graph 매개변수 오류 100 → code 무효
  if (step === 'exchange' && (code === 400 || code === 100)) return 'invalid_grant';
  // 그 밖 단계의 100(매개변수 오류 — 예: 발급 24시간 안 갱신) → 요청 거절
  if (code === 100) return 'invalid_request';
  return null;
}

/**
 * FIX3-LIVET1(Codex review-FIX2-LIVET1 P0 :212): 문자열 오류 식별자(OAuth2 { error, error_description } 의 error, 또는 Graph·Threads 본문의 type·error_type).
 * 소문자로 비교한다. **문구보다 먼저** 이 표로 분류한다(FIX4-LIVET1: 숫자 코드가 함께 있어도 — 어느 자리에 있든 일시 신호 하나면 일시).
 * 일시 표: RFC 6749 §4.1.2.1·§5.2(server_error·temporarily_unavailable), RFC 8628 §3.5(slow_down), 그 밖 흔한 일시 표기.
 * 쓰기 단계면 모두 ambiguous=true(결과 불명). 이 표에 없는 식별자(예: OAuthException·GraphMethodException)는 "알 수 없음".
 */
export const THREADS_TRANSIENT_IDENTIFIERS: ReadonlyMap<string, 'rate_limited' | 'server_error'> = new Map<string, 'rate_limited' | 'server_error'>([
  ['temporarily_unavailable', 'server_error'],
  ['server_error', 'server_error'],
  ['service_unavailable', 'server_error'],
  ['internal_error', 'server_error'],
  ['internal_server_error', 'server_error'],
  ['timeout', 'server_error'],
  ['request_timeout', 'server_error'],
  ['slow_down', 'rate_limited'],
  ['rate_limited', 'rate_limited'],
  ['rate_limit_exceeded', 'rate_limited'],
  ['too_many_requests', 'rate_limited'],
]);

/**
 * 확정 식별자 표(RFC 6749 §5.2·§4.1.2.1, RFC 6750 §3.1) — 공급자가 처리하지 않고 거절했다고 아는 식별자만.
 * refinable=true 인 범용 식별자(invalid_request·invalid_grant)만 문구로 더 구체적인 확정 오류로 좁힐 수 있다.
 */
function definiteByIdentifier(step: Step, id: string): { code: OAuthProviderErrorCode; refinable: boolean } | null {
  switch (id) {
    case 'invalid_grant':
      return { code: step === 'exchange' ? 'invalid_grant' : 'invalid_token', refinable: step === 'exchange' };
    case 'invalid_request':
      return { code: 'invalid_request', refinable: true };
    case 'invalid_client':
    case 'unauthorized_client':
      return { code: 'invalid_client', refinable: false };
    case 'unsupported_grant_type':
    case 'unsupported_response_type':
      return { code: 'invalid_request', refinable: false };
    case 'invalid_scope':
    case 'access_denied':
    case 'insufficient_scope':
      return { code: 'scope_not_allowed', refinable: false };
    case 'invalid_token':
      return { code: 'invalid_token', refinable: false };
    case 'redirect_uri_mismatch':
      return { code: step === 'exchange' ? 'redirect_mismatch' : 'invalid_request', refinable: false };
    default:
      return null;
  }
}

const CLIENT_MESSAGE = /client[_ ]?secret|app(lication)? secret|invalid client|client[_ ]?id|invalid app(lication)? id|validating application/i;
const REDIRECT_MESSAGE = /redirect[_ ]?uri/i;

/**
 * 문구 보정 — **이미 확정된 범용 결과**(코드 100, 식별자 invalid_request·invalid_grant)를 더 구체적인 확정 오류로 좁힐 때만.
 * FIX3-LIVET1(P0 :212): 문구만으로 확정 결과를 만들지 않는다(일시·모르는 식별자·코드 없는 본문 모두). 일시 코드·식별자에는 쓰지 않는다.
 */
function refineByMessage(step: Step, message: string): OAuthProviderErrorCode | null {
  const redirect = REDIRECT_MESSAGE.test(message);
  if (redirect && step === 'exchange') return 'redirect_mismatch';
  if (!redirect && CLIENT_MESSAGE.test(message)) return 'invalid_client';
  return null;
}

/** 제한 응답 힌트(헤더) — 숫자만 뽑는다. 원 헤더 값은 어디에도 남기지 않는다. */
export interface ThreadsRateLimitHints {
  /** Retry-After(초 단위 정수만 — HTTP-date 는 읽지 않는다) */
  retryAfter?: string | null;
  /** X-Business-Use-Case-Usage(JSON) — 항목들의 estimated_time_to_regain_access(분) 최댓값 */
  businessUseCaseUsage?: string | null;
}

const MAX_RETRY_AFTER_SEC = 999_999;

/** 제한 힌트 → 초(0 이상 정수) 또는 undefined. 이상한 값(음수·소수·문자·너무 큼·JSON 오류)은 버린다. 둘 다 있으면 긴 쪽. */
export function parseRetryAfterSec(hints: ThreadsRateLimitHints | string | null | undefined): number | undefined {
  const h: ThreadsRateLimitHints = typeof hints === 'string' ? { retryAfter: hints } : (hints ?? {});
  let best: number | undefined;
  const ra = h.retryAfter?.trim();
  if (ra && /^\d{1,6}$/.test(ra)) best = Number(ra);
  const buc = h.businessUseCaseUsage;
  if (buc && buc.length <= 8192) {
    try {
      const parsed = JSON.parse(buc) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const list of Object.values(parsed as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            const m = item && typeof item === 'object' ? (item as Record<string, unknown>).estimated_time_to_regain_access : undefined;
            if (typeof m === 'number' && Number.isInteger(m) && m > 0 && m * 60 <= MAX_RETRY_AFTER_SEC) best = Math.max(best ?? 0, m * 60);
          }
        }
      }
    } catch {
      // 형식 오류 — 버린다
    }
  }
  return best;
}

/**
 * FIX4-LIVET1: 정규화된 기록 → 판정(하나의 우선순위 함수). 4xx 의 형식 맞는 본문에만 쓴다(상태 판정은 mapThreadsError 가 먼저).
 * Meta 가 쓰는 범용 예외 분류 이름 — 확정도 일시도 아니고 다른 신호를 막지도 않는다(예: { error: { type: 'OAuthException', code: 190 } } → 190 으로 판정).
 */
const NEUTRAL_IDENTIFIERS: ReadonlySet<string> = new Set(['oauthexception', 'graphmethodexception', 'facebookapiexception']);

export type ThreadsOAuthErrorVerdict =
  | { kind: 'transient'; reason: 'rate_limited' | 'server_error' }
  | { kind: 'definite'; code: OAuthProviderErrorCode }
  | { kind: 'unknown'; why: 'malformed' | 'subcode_conflict' | 'subcode_only' | 'unknown_code' | 'unknown_identifier' | 'conflict' | 'no_signal' };

/**
 * 우선순위(위가 이긴다):
 *  a) 일시 신호가 **하나라도** — 숫자 일시 코드(THREADS_TRANSIENT_CODES) · 일시 식별자(THREADS_TRANSIENT_IDENTIFIERS) · is_transient=true
 *     → transient(제한 신호가 하나라도 있으면 rate_limited, 아니면 server_error). 확정 코드·식별자·문구와 충돌해도 일시가 이긴다.
 *  b) 형식 깨진 신호(malformedCode) → unknown
 *  c) 하위 코드가 여럿(서로 다름) → unknown · 숫자 코드 없이 하위 코드만 → unknown
 *  d) 숫자 코드가 하나라도 확정 표(definiteByCode)에 없음 → unknown
 *  e) 범용 예외 이름(NEUTRAL_IDENTIFIERS) 밖의 식별자가 하나라도 확정 표(definiteByIdentifier)에 없음 → unknown
 *  f) 확정 결과(코드·식별자 모두)가 **하나로 일치**해야 definite — 둘 이상이면 conflict(unknown), 하나도 없으면 no_signal(unknown)
 *  g) 문구는 f) 의 결과가 범용(코드 100·invalid_request·교환 invalid_grant — 참여한 모든 출처가 범용)일 때만 더 구체적인 확정으로 좁힌다.
 *     문구들이 서로 다른 쪽으로 좁히면 좁히지 않는다. 문구만으로는 아무것도 만들지 않는다.
 */
export function classifyThreadsOAuthError(step: Step, n: NormalizedThreadsError): ThreadsOAuthErrorVerdict {
  const unknown = (why: Extract<ThreadsOAuthErrorVerdict, { kind: 'unknown' }>['why']): ThreadsOAuthErrorVerdict => ({ kind: 'unknown', why });
  const transient = [
    ...n.codes.map((c) => THREADS_TRANSIENT_CODES.get(c)),
    ...n.identifiers.map((id) => THREADS_TRANSIENT_IDENTIFIERS.get(id)),
  ].filter((r): r is 'rate_limited' | 'server_error' => r !== undefined);
  if (transient.length || n.isTransientFlag === true) return { kind: 'transient', reason: transient.includes('rate_limited') ? 'rate_limited' : 'server_error' };
  if (n.malformedCode) return unknown('malformed');
  if (n.subcodes.length > 1) return unknown('subcode_conflict');
  if (!n.codes.length && n.subcodes.length) return unknown('subcode_only');
  const outcomes = new Set<OAuthProviderErrorCode>();
  let refinable = true;
  for (const c of n.codes) {
    const d = definiteByCode(step, c, n.subcode);
    if (!d) return unknown('unknown_code');
    outcomes.add(d);
    if (c !== 100) refinable = false;
  }
  for (const id of n.identifiers) {
    if (NEUTRAL_IDENTIFIERS.has(id)) continue;
    const d = definiteByIdentifier(step, id);
    if (!d) return unknown('unknown_identifier');
    outcomes.add(d.code);
    if (!d.refinable) refinable = false;
  }
  if (!outcomes.size) return unknown('no_signal');
  if (outcomes.size > 1) return unknown('conflict');
  const definite = [...outcomes][0]!;
  if (refinable) {
    const narrowed = new Set(n.messages.map((m) => refineByMessage(step, m)).filter((r): r is OAuthProviderErrorCode => r !== null));
    if (narrowed.size === 1) return { kind: 'definite', code: [...narrowed][0]! };
  }
  return { kind: 'definite', code: definite };
}

/**
 * 공급자 오류 → 기존 T13 코드(OAuthProviderErrorCode) + 숫자·열거 부가 정보. 메시지 원문은 분류에만 쓰고 결과에 넣지 않는다.
 * FIX4-LIVET1(Codex review-FIX3-LIVET1 P0 :89): 본문은 normalizeThreadsErrorBody 하나로 읽고 classifyThreadsOAuthError 하나로 판정한다.
 * 우선순위(엄격, 위가 이긴다):
 *  1) 429 → provider_error(rate_limited, retryAfterSec), **쓰기 단계면 ambiguous=true**(FIX4 — Codex Q13: 429 가 토큰 발급 전에만 온다는 보장 없음)
 *  2) 5xx → provider_error(server_error, 쓰기 단계면 ambiguous) — 본문이 무엇이든
 *  3) 408 → provider_error(timeout, 쓰기 단계면 ambiguous)
 *  4) 4xx 가 아닌 상태(2xx·1xx·3xx)의 오류 본문 → provider_error(malformed_response, 쓰기 단계면 ambiguous)
 *  5) 4xx 인데 공급자 오류 본문이 아님 → 쓰기 단계면 provider_error(http_error, ambiguous), 아니면 401 → invalid_token, 그 밖 → invalid_request
 *  6) 4xx + classifyThreadsOAuthError:
 *     transient → rate_limited(retryAfterSec) 또는 server_error, 쓰기 단계면 둘 다 ambiguous=true
 *     definite  → 그 코드
 *     unknown   → 쓰기 단계면 provider_error(oauth_exception, ambiguous=true), 읽기 단계면 401 → invalid_token, 그 밖 → invalid_request
 */
export function mapThreadsError(step: Step, httpStatus: number, body: unknown, hints: ThreadsRateLimitHints | string | null = null): OAuthProviderError {
  const write = WRITE_STEPS.has(step);
  const n = normalizeThreadsErrorBody(body);
  const base: OAuthProviderErrorDetail = { reason: n ? 'oauth_exception' : 'http_error', step, httpStatus };
  if (n && n.numericCode !== null) base.providerCode = n.numericCode;
  if (n && n.subcode !== null) base.providerSubcode = n.subcode;
  const err = (code: OAuthProviderErrorCode, extra: Partial<OAuthProviderErrorDetail> = {}) => new OAuthProviderError(code, { ...base, ...extra });
  /** 제한 응답(429 · 4xx 본문의 제한 신호) — 쓰기 단계면 결과 불명. 읽기 단계는 부작용이 없어 ambiguous 를 달지 않는다. */
  const rateLimited = () => {
    const ra = parseRetryAfterSec(hints);
    return err('provider_error', { reason: 'rate_limited', ...(write ? { ambiguous: true } : {}), ...(ra !== undefined ? { retryAfterSec: ra } : {}) });
  };
  // 1)~4) 전송·상태 먼저(본문과 관계없이)
  if (httpStatus === 429) return rateLimited();
  if (httpStatus >= 500) return err('provider_error', { reason: 'server_error', ambiguous: write });
  if (httpStatus === 408) return err('provider_error', { reason: 'timeout', ambiguous: write });
  if (httpStatus < 400) return err('provider_error', { reason: 'malformed_response', ambiguous: write });
  // 5) 4xx, 형식 모름
  if (!n) {
    if (write) return err('provider_error', { reason: 'http_error', ambiguous: true });
    return err(httpStatus === 401 ? 'invalid_token' : 'invalid_request');
  }
  // 6) 하나의 판정
  const v = classifyThreadsOAuthError(step, n);
  if (v.kind === 'transient') return v.reason === 'rate_limited' ? rateLimited() : err('provider_error', { reason: 'server_error', ambiguous: write });
  if (v.kind === 'definite') return err(v.code);
  if (write) return err('provider_error', { ambiguous: true });
  return err(httpStatus === 401 ? 'invalid_token' : 'invalid_request');
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
  readonly #refreshEnabled: boolean;

  /**
   * refreshEnabled: FIX1-LIVET1(Codex review-LIVET1 P1) — 실제 갱신(th_refresh_token)은 D31 범위 밖이라 기본 false(refresh 는 외부 호출 없이
   * LiveRefreshOutOfScopeError). resolveOAuthProvider 는 이 값을 넘기지 않는다(설정·환경으로 켤 수 없음). fixture 시험만 true 로 요청 모양을 확인한다.
   */
  constructor(opts: { appId: string; appSecret: string; registeredRedirectUri: string; fetch?: FetchLike; timeoutMs?: number; refreshEnabled?: boolean }) {
    // FIX1-LIVET1(P2): 형식 검증은 준비 판정(liveOAuthReadiness)과 같은 함수. 시크릿은 앞뒤 공백을 뗀 값이어야 한다(resolveOAuthProvider 가 뗀다).
    if (!isValidThreadsAppId(opts.appId)) throw new OAuthProviderError('invalid_client', { reason: 'local_check' });
    if (!isValidThreadsAppSecret(opts.appSecret) || opts.appSecret !== opts.appSecret.trim()) throw new OAuthProviderError('invalid_client', { reason: 'local_check' });
    if (!isPlainRedirectUri(opts.registeredRedirectUri)) throw new OAuthProviderError('redirect_mismatch', { reason: 'local_check' });
    this.appId = opts.appId;
    this.#appSecret = opts.appSecret;
    this.registeredRedirectUri = opts.registeredRedirectUri;
    this.#fetch = opts.fetch ?? null;
    this.#timeoutMs = opts.timeoutMs ?? LIVE_THREADS_HTTP_TIMEOUT_MS;
    this.#refreshEnabled = opts.refreshEnabled === true;
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
    try {
      const long = await this.#call('long_lived', u, { method: 'GET', headers: { accept: 'application/json' } });
      return this.#tokenSet(long, 'long_lived', input.now);
    } catch (e) {
      // FIX1-LIVET1(Codex review-LIVET1 Q3): 단기 토큰은 이미 발급됐다 — 공급자에 유효하게 남아 있을 수 있다(철회 API 없음)는 표시를 단다
      if (e instanceof OAuthProviderError && e.detail) throw new OAuthProviderError(e.code, { ...e.detail, shortTokenIssued: true });
      throw new OAuthProviderError('provider_error', { reason: 'local_check', step: 'long_lived', ambiguous: true, shortTokenIssued: true });
    }
  }

  /**
   * 장기 토큰 갱신(refresh token 없음 — 장기 토큰 자체로). 발급 24시간 안의 갱신은 공급자가 거부할 수 있다(invalid_request — 상태는 active 유지).
   * FIX1-LIVET1(P1): D31 범위 밖 — refreshEnabled 가 아니면 외부 호출 없이 LiveRefreshOutOfScopeError(LIVE_THREADS_REFRESH(D31 범위 밖)).
   * (서버 공통 갱신 진입점 refreshCredential 이 실제 계정을 먼저 거부하므로 이 검사는 두 번째 방어선이다.)
   */
  async refresh(input: { tokens: StoredOAuthTokens; now: Date }): Promise<OAuthTokenSet> {
    if (!this.#refreshEnabled) throw new LiveRefreshOutOfScopeError();
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
    if (!res.ok || (normalizeThreadsErrorBody(body) !== null && !hasSuccessField)) {
      // FIX2-LIVET1(P2 :127): 제한 힌트는 429 밖(코드 4·17·…)에서도 쓴다 — 숫자만 뽑고 원 헤더 값은 버린다
      throw mapThreadsError(step, res.status, body, { retryAfter: res.headers.get('retry-after'), businessUseCaseUsage: res.headers.get('x-business-use-case-usage') });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OAuthProviderError('provider_error', { reason: 'malformed_response', step, httpStatus: res.status, ambiguous: ambiguousOnTransport });
    }
    return body as Record<string, unknown>;
  }
}
