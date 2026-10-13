/**
 * T21-P1b(T21_DEPLOY_REVIEW G1): 일반 OpenID Connect 로그인 클라이언트 — 검증된 라이브러리 openid-client(panva, 6.8.8 고정)를 감싼다.
 * IdP 를 정하지 않는다(OIDC_ISSUER_URL 의 discovery 로만). 자체 JWT·서명 검증은 없다 — 아래 검사는 모두 라이브러리가 한다:
 * - discovery: issuer 일치(문서의 issuer = 설정한 issuer).
 * - 인증 응답: state 정확 일치(expectedState), RFC 9207 iss 파라미터(IdP 가 지원하면), error 파라미터.
 * - code 교환: authorization_code + PKCE S256(code_verifier) + redirect_uri(설정값 그대로 — 요청 Host 로 만들지 않는다) + 클라이언트 인증
 *   (IdP 가 알리는 token_endpoint_auth_methods_supported 에 client_secret_basic 이 있으면 basic, 없고 post 만 있으면 post. 목록이 없으면 OIDC 기본값 basic).
 * - ID token: 서명(JWKS — discovery 의 jwks_uri, 라이브러리 캐시. 라이브러리 기본은 TLS 직접 수신 ID token 의 서명 검사를 생략하므로
 *   enableNonRepudiationChecks 로 켠다), iss, aud(client_id), exp·iat(허용 오차 30초), nonce 정확 일치. ID token 필수.
 *
 * 네트워크(비밀 위생):
 * - 모든 IdP HTTP 는 이 클래스의 감싼 fetch 를 지난다 — 주입한 fetch(시험은 프로세스 안 가짜 IdP) 또는 호출 시점의 globalThis.fetch.
 * - https 만, 허용 호스트(issuer 호스트 + discovery 문서의 token_endpoint·jwks_uri 호스트)만. 리다이렉트는 따르지 않는다(manual).
 * - 요청마다 시간 제한(OIDC_HTTP_TIMEOUT_MS, 주입 가능) — 헤더뿐 아니라 **본문 끝까지 받는 데까지** 포함(FIX-T21P1B P1 :252). 본문은 감싼 fetch 가
 *   다 읽어(최대 1 MiB) 새 Response 로 넘긴다 — 본문 끊김·멈춤·초과는 전송 실패(unavailable), 다 받은 뒤의 형식·검증 실패만 invalid.
 *   주입 fetch·본문 스트림이 signal 을 무시해도 경쟁(race)으로 끊는다.
 * - 허용 호스트 집합과 감싼 fetch 는 **Configuration 마다 따로**(FIX-T21P1B P1 :199) — 새 discovery 가 끝나 완성된 뒤에만 캐시를 바꾸고,
 *   진행 중인 callback 은 자기 Configuration 의 집합을 계속 쓴다. 동시 discovery 는 진행 중 요청 하나로 합친다.
 * - ID token iat: 라이브러리는 존재·타입만 보므로 미래(허용 오차 30초 초과) iat 는 여기서 거부한다(FIX-T21P1B). 시각 클레임은 유한한 숫자만(FIX2).
 * - JWKS 키 교체: 모르는 kid 는 라이브러리가 JWKS 캐시가 60초 이상 됐을 때만 다시 받는다(재요청 폭주 방지 — 라이브러리 설계, 그대로 둠).
 * - 실패는 OidcLoginFailure(kind: invalid | unavailable, step)로만 바꾼다 — 원 오류(cause)·URL·IdP 응답 본문·토큰·code 를 버린다.
 *   unavailable = 전송 실패·시간 초과·5xx·허용 밖 호스트·discovery 실패(다시 시도할 일). invalid = 그 밖(검증 실패 — 로그인 실패로 센다).
 * discovery 결과(Configuration — JWKS 캐시 포함)는 OIDC_DISCOVERY_TTL_MS 동안 재사용한다(실패는 캐시하지 않음).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import { OIDC_DISCOVERY_TTL_MS, OIDC_HTTP_TIMEOUT_MS, type OidcClientSettings, type OidcVerifiedClaims } from '@cs/domain';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type OidcFailureKind = 'invalid' | 'unavailable';
export type OidcFailureStep = 'discovery' | 'authorization_response' | 'token' | 'claims';

/** 값 없는 실패(코드만). cause 를 붙이지 않는다. */
export class OidcLoginFailure extends Error {
  readonly kind: OidcFailureKind;
  readonly step: OidcFailureStep;
  constructor(kind: OidcFailureKind, step: OidcFailureStep) {
    super(`oidc login failure: ${kind}/${step}`);
    this.name = 'OidcLoginFailure';
    this.kind = kind;
    this.step = step;
  }
}

export interface OidcLoginClientOptions {
  /** IdP HTTP 에 쓸 fetch. 없으면 호출 시점의 globalThis.fetch. */
  fetch?: FetchLike;
  /** 요청 하나의 시간 제한(ms). 기본 OIDC_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  /** discovery 재사용 시간(ms). 기본 OIDC_DISCOVERY_TTL_MS. */
  discoveryTtlMs?: number;
  now?: () => number;
}

export interface OidcAuthorizationRequest {
  /** 브라우저를 보낼 IdP 인증 URL(state·nonce·code_challenge 포함). 기록하지 않는다. */
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

/** 한 작업(시작·callback) 동안의 전송 상태 — 감싼 fetch 가 기록하고 실패 분류에 쓴다. */
interface Transport {
  failed: boolean;
  serverError: boolean;
  hostRejected: boolean;
}

interface Cached {
  config: oidc.Configuration;
  expiresAt: number;
}

/** 감싼 fetch 가 받는 응답 본문 상한. */
export const OIDC_MAX_RESPONSE_BYTES = 1024 * 1024;
/** ID token 시각 허용 오차(초) — 라이브러리 기본 clockTolerance 와 같다. */
const CLOCK_TOLERANCE_SEC = 30;
/** 본문이 없어야 하는 상태 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const transportStore = new AsyncLocalStorage<Transport>();

const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

export class OidcLoginClient {
  readonly #settings: OidcClientSettings;
  readonly #fetch: FetchLike | undefined;
  readonly #timeoutMs: number;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #cached: Cached | null = null;
  /** 진행 중인 discovery(동시 요청은 이것 하나를 기다린다). */
  #inflight: Promise<oidc.Configuration> | null = null;

  constructor(settings: OidcClientSettings, options: OidcLoginClientOptions = {}) {
    this.#settings = { ...settings, scopes: [...settings.scopes] };
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs ?? OIDC_HTTP_TIMEOUT_MS;
    this.#ttlMs = options.discoveryTtlMs ?? OIDC_DISCOVERY_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** 같은 설정인지 비교하는 지문(비밀 포함 — 해시만, 밖으로 내보내지 않는다). */
  static fingerprint(s: OidcClientSettings): string {
    return createHash('sha256').update(JSON.stringify([s.issuer, s.clientId, s.clientSecret, s.redirectUri, s.scopes]), 'utf8').digest('hex');
  }

  /** 인증 요청 만들기: discovery(캐시) → state·nonce·PKCE verifier 난수 → 인증 URL. 실패는 unavailable/discovery. */
  async createAuthorizationRequest(): Promise<OidcAuthorizationRequest> {
    return this.#run(async () => {
      const config = await this.#configuration();
      try {
        const state = oidc.randomState();
        const nonce = oidc.randomNonce();
        const codeVerifier = oidc.randomPKCECodeVerifier();
        const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
        const url = oidc.buildAuthorizationUrl(config, {
          redirect_uri: this.#settings.redirectUri,
          scope: this.#settings.scopes.join(' '),
          response_type: 'code',
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        });
        if (url.protocol !== 'https:') throw new OidcLoginFailure('unavailable', 'discovery');
        return { url: url.href, state, nonce, codeVerifier };
      } catch {
        throw new OidcLoginFailure('unavailable', 'discovery');
      }
    });
  }

  /**
   * callback 처리: 인증 응답(callbackParams — 요청 query 그대로) 검증 → code 교환 → ID token 검증(라이브러리). 성공하면 검증된 클레임(sub·email·email_verified).
   * 검사 기준값(state·nonce·verifier)은 서버에 봉인해 둔 것. redirect_uri 는 설정값(정확 일치 대상)에 query 를 붙여 라이브러리에 넘긴다.
   */
  async completeAuthorization(input: {
    callbackParams: URLSearchParams;
    expectedState: string;
    expectedNonce: string;
    codeVerifier: string;
  }): Promise<OidcVerifiedClaims> {
    return this.#run(async () => {
      const config = await this.#configuration();
      const current = new URL(this.#settings.redirectUri);
      for (const [k, v] of input.callbackParams) current.searchParams.append(k, v);
      let claims: oidc.IDToken | undefined;
      try {
        const tokens = await oidc.authorizationCodeGrant(config, current, {
          expectedState: input.expectedState,
          expectedNonce: input.expectedNonce,
          pkceCodeVerifier: input.codeVerifier,
          idTokenExpected: true,
        });
        claims = tokens.claims();
      } catch {
        throw new OidcLoginFailure(this.#unavailable() ? 'unavailable' : 'invalid', 'token');
      }
      if (!claims || typeof claims.sub !== 'string' || !claims.sub) throw new OidcLoginFailure('invalid', 'claims');
      // 라이브러리는 iat 의 존재·타입만 본다 — 허용 오차를 넘는 미래 발급은 거부(서버 시계 기준, 라이브러리와 같은 Date.now)
      if (typeof claims.iat !== 'number' || claims.iat > Math.floor(Date.now() / 1000) + CLOCK_TOLERANCE_SEC) {
        throw new OidcLoginFailure('invalid', 'claims');
      }
      // FIX2-T21P1B: 시각 클레임은 유한한 숫자만 — JSON 숫자 1e400 은 Infinity 로 파싱되고 라이브러리는 exp=Infinity 를 "만료 안 됨"으로 통과시킨다
      for (const k of ['iat', 'exp', 'nbf', 'auth_time'] as const) {
        const v = (claims as Record<string, unknown>)[k];
        if ((k === 'iat' || k === 'exp' || v !== undefined) && !(typeof v === 'number' && Number.isFinite(v))) throw new OidcLoginFailure('invalid', 'claims');
      }
      return { sub: claims.sub, email: claims.email, email_verified: claims.email_verified };
    });
  }

  /** 시험·설정 변경용: 캐시를 버린다(진행 중 discovery 는 끝나도 캐시에 넣지 않는다). */
  reset(): void {
    this.#cached = null;
    this.#inflight = null;
  }

  async #run<T>(fn: () => Promise<T>): Promise<T> {
    const t: Transport = { failed: false, serverError: false, hostRejected: false };
    try {
      return await transportStore.run(t, fn);
    } catch (e) {
      if (e instanceof OidcLoginFailure) throw e;
      throw new OidcLoginFailure(t.failed || t.serverError || t.hostRejected ? 'unavailable' : 'invalid', 'token');
    }
  }

  #unavailable(): boolean {
    const t = transportStore.getStore();
    return !!t && (t.failed || t.serverError || t.hostRejected);
  }

  /** 캐시가 살아 있으면 그것, 아니면 진행 중 discovery 를 함께 기다리거나 새로 시작한다. 완성된 결과만 캐시에 넣는다(교체는 한 번에). */
  async #configuration(): Promise<oidc.Configuration> {
    const now = this.#now();
    if (this.#cached && this.#cached.expiresAt > now) return this.#cached.config;
    if (!this.#inflight) {
      const p: Promise<oidc.Configuration> = this.#discover().then(
        (config) => {
          if (this.#inflight === p) {
            this.#cached = { config, expiresAt: this.#now() + this.#ttlMs };
            this.#inflight = null;
          }
          return config;
        },
        (e: unknown) => {
          if (this.#inflight === p) this.#inflight = null;
          throw e;
        },
      );
      this.#inflight = p;
    }
    return this.#inflight;
  }

  /** discovery 한 번 — 이 Configuration 전용 허용 호스트 집합과 감싼 fetch 를 만든다(다른 Configuration 의 집합은 건드리지 않는다). */
  async #discover(): Promise<oidc.Configuration> {
    const issuer = new URL(this.#settings.issuer);
    const hosts = new Set<string>([issuer.host]);
    const secret = this.#settings.clientSecret;
    const basic = oidc.ClientSecretBasic(secret);
    const post = oidc.ClientSecretPost(secret);
    // IdP 가 알리는 방식에 맞춘다(목록이 없으면 OIDC Discovery 기본값 client_secret_basic).
    const auth: oidc.ClientAuth = (as, client, body, headers) => {
      const methods = as.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
      return (methods.includes('client_secret_basic') ? basic : post)(as, client, body, headers);
    };
    let config: oidc.Configuration;
    try {
      config = await oidc.discovery(issuer, this.#settings.clientId, undefined, auth, {
        [oidc.customFetch]: this.#guardedFetch(hosts),
        timeout: this.#timeoutMs / 1000,
        // 라이브러리 기본은 TLS 로 받은 ID token 의 서명 검사를 생략한다(OIDC Core 3.1.3.7 허용) — 서명(JWKS)도 검사하게 켠다.
        execute: [oidc.enableNonRepudiationChecks],
      });
    } catch {
      throw new OidcLoginFailure('unavailable', 'discovery');
    }
    const meta = config.serverMetadata();
    const methods = meta.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (
      !isHttpsUrl(meta.authorization_endpoint) ||
      !isHttpsUrl(meta.token_endpoint) ||
      !isHttpsUrl(meta.jwks_uri) ||
      !(methods.includes('client_secret_basic') || methods.includes('client_secret_post'))
    ) {
      throw new OidcLoginFailure('unavailable', 'discovery');
    }
    // 아직 아무도 쓰지 않는(캐시 전) 이 Configuration 의 집합에만 더한다
    hosts.add(new URL(meta.token_endpoint).host);
    hosts.add(new URL(meta.jwks_uri).host);
    return config;
  }

  /**
   * https·허용 호스트(이 Configuration 의 집합)만, 리다이렉트 안 따름, 전송 상태 기록. 시간 제한은 헤더 + 본문 끝까지(경쟁).
   * 본문은 여기서 다 읽어(OIDC_MAX_RESPONSE_BYTES 상한) 새 Response 로 돌려준다 — 본문 단계의 끊김·멈춤·초과도 전송 실패(unavailable).
   * 던지는 오류에는 URL·본문을 넣지 않는다.
   */
  #guardedFetch(hosts: ReadonlySet<string>): oidc.CustomFetch {
    return async (url, options) => {
      const t = transportStore.getStore();
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        if (t) t.hostRejected = true;
        throw new Error('oidc: invalid request url');
      }
      if (u.protocol !== 'https:' || !hosts.has(u.host)) {
        if (t) t.hostRejected = true;
        throw new Error('oidc: request host not allowed');
      }
      const f: FetchLike = this.#fetch ?? ((i, init) => globalThis.fetch(i, init));
      const ctrl = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, ctrl.signal]) : ctrl.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort();
          reject(new Error('oidc: timeout'));
        }, this.#timeoutMs);
      });
      const receive = async (): Promise<Response> => {
        const res = await f(u.href, { ...options, redirect: 'manual', signal } as RequestInit);
        // FIX2-T21P1B(P2 :318): signal 을 무시한 fetch 가 시간 제한 뒤에 응답했으면 본문을 바로 취소(완료를 기다리지 않음)하고 실패
        if (signal.aborted) {
          void res.body?.cancel().catch(() => undefined);
          throw new Error('oidc: response after abort');
        }
        const body = await readCapped(res, signal);
        return new Response(NULL_BODY_STATUS.has(res.status) ? null : body, { status: res.status, statusText: res.statusText, headers: res.headers });
      };
      try {
        const res = await Promise.race([receive(), timeout]);
        if (res.status >= 500) {
          if (t) t.serverError = true;
        }
        return res;
      } catch {
        if (t) t.failed = true;
        ctrl.abort();
        throw new Error('oidc: request failed');
      } finally {
        clearTimeout(timer);
      }
    };
  }
}

/** 본문을 끝까지 읽는다(상한 초과·스트림 오류·중단이면 던진다). 끝나지 않으면 바깥 경쟁의 시간 제한이 끊는다. */
async function readCapped(res: Response, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  // 이미 중단된 signal 의 abort 이벤트는 다시 오지 않는다 — 리더를 만든 직후에도 확인하고, 취소는 완료를 기다리지 않는다
  if (signal.aborted) {
    void reader.cancel().catch(() => undefined);
    throw new Error('oidc: response aborted');
  }
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > OIDC_MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined); // 취소 완료를 무기한 기다리지 않는다
        throw new Error('oidc: response too large');
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  // 중단(시간 제한·라이브러리 signal)으로 끝난 읽기는 잘린 본문이다 — 정상 수신으로 넘기지 않는다
  if (signal.aborted) throw new Error('oidc: response aborted');
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
