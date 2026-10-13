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
 * - 요청마다 시간 제한(OIDC_HTTP_TIMEOUT_MS, 주입 가능) — 주입 fetch 가 signal 을 무시해도 경쟁(race)으로 끊는다.
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
  /** 허용 호스트(host = 이름:포트) — discovery 전에는 issuer 호스트만. */
  readonly #allowedHosts: Set<string>;
  #cached: Cached | null = null;

  constructor(settings: OidcClientSettings, options: OidcLoginClientOptions = {}) {
    this.#settings = { ...settings, scopes: [...settings.scopes] };
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutMs ?? OIDC_HTTP_TIMEOUT_MS;
    this.#ttlMs = options.discoveryTtlMs ?? OIDC_DISCOVERY_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#allowedHosts = new Set([new URL(settings.issuer).host]);
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
      return { sub: claims.sub, email: claims.email, email_verified: claims.email_verified };
    });
  }

  /** 시험·설정 변경용: 캐시를 버린다. */
  reset(): void {
    this.#cached = null;
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

  async #configuration(): Promise<oidc.Configuration> {
    const now = this.#now();
    if (this.#cached && this.#cached.expiresAt > now) return this.#cached.config;
    this.#cached = null;
    const issuer = new URL(this.#settings.issuer);
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
      // 허용 호스트를 issuer 하나로 되돌린 뒤 discovery(이전 discovery 의 호스트를 남기지 않는다).
      this.#allowedHosts.clear();
      this.#allowedHosts.add(issuer.host);
      config = await oidc.discovery(issuer, this.#settings.clientId, undefined, auth, {
        [oidc.customFetch]: this.#guardedFetch(),
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
    this.#allowedHosts.add(new URL(meta.token_endpoint).host);
    this.#allowedHosts.add(new URL(meta.jwks_uri).host);
    this.#cached = { config, expiresAt: now + this.#ttlMs };
    return config;
  }

  /** https·허용 호스트만, 리다이렉트 안 따름, 시간 제한(경쟁), 전송 상태 기록. 던지는 오류에는 URL·본문을 넣지 않는다. */
  #guardedFetch(): oidc.CustomFetch {
    return async (url, options) => {
      const t = transportStore.getStore();
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        if (t) t.hostRejected = true;
        throw new Error('oidc: invalid request url');
      }
      if (u.protocol !== 'https:' || !this.#allowedHosts.has(u.host)) {
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
      try {
        const res = await Promise.race([f(u.href, { ...options, redirect: 'manual', signal } as RequestInit), timeout]);
        if (res.status >= 500) {
          if (t) t.serverError = true;
        }
        return res;
      } catch {
        if (t) t.failed = true;
        throw new Error('oidc: request failed');
      } finally {
        clearTimeout(timer);
      }
    };
  }
}
