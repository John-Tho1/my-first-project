/**
 * T13(결정 D24): 계정 연결 공급자.
 *
 * - MockThreadsOAuthProvider: Threads 형태의 모의 OAuth 공급자. **프로세스 안에서만** 동작한다(HTTP·DNS·소켓 없음).
 *   authorize(사용자 동의 흉내) → code(1회용, 60초, PKCE S256 challenge·redirect URI·scope 에 묶임) → exchangeCode(verifier 검증)
 *   → access token(60일, Threads 장기 토큰처럼 refresh token 없음) → refresh(만료 전, 같은 토큰으로) → revoke.
 *   토큰은 'mockthr_' 로 시작하는 난수이며 실제 Threads 에서 쓸 수 없다. 공급자 상태(code·토큰)는 프로세스 메모리(globalThis)에만 있어
 *   서버를 다시 시작하면 모의 토큰은 "알 수 없음"(invalid_token)이 된다 — 그 경우 화면은 다시 연결을 안내한다.
 * - resolveOAuthProvider: 계정 kind 로 공급자를 고른다. 모의 계정 + threads → 모의 공급자. 실제(live) 계정은 liveOAuthReadiness 가
 *   항상 거부한다(T13 에는 live 어댑터가 없다 — LiveOAuthNotConfiguredError, 외부 호출 0).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  codeChallengeS256,
  envPresent,
  liveOAuthReadiness,
  LiveOAuthNotConfiguredError,
  OAuthNotSupportedError,
  OAuthProviderError,
  readSecretKeyring,
  THREADS_REQUIRED_SCOPES,
  type AppConfig,
  type OAuthAccountInfo,
  type OAuthAuthorizeRequest,
  type OAuthProvider,
  type OAuthTokenSet,
  type StoredOAuthTokens,
} from '@cs/domain';

export const MOCK_THREADS_CLIENT_ID = 'mock-threads-client';
/** 모의 공급자의 "동의 화면" 경로(앱 안). 실제 공급자라면 외부 주소다. */
export const MOCK_THREADS_AUTHORIZE_PATH = '/api/oauth/mock-threads/authorize';
export const MOCK_TOKEN_TTL_MS = 60 * 24 * 3600_000;
export const MOCK_CODE_TTL_MS = 60_000;
/** 모의 공급자가 허용하는 scope(요청하지 않은 scope 는 주지 않는다) */
const MOCK_ALLOWED_SCOPES = new Set<string>([...THREADS_REQUIRED_SCOPES, 'threads_manage_replies', 'threads_read_replies', 'threads_manage_insights']);

interface MockCode {
  challenge: string;
  redirectUri: string;
  scopes: string[];
  user: string;
  displayName: string;
  expiresAt: number;
  used: boolean;
}

interface MockToken {
  user: string;
  displayName: string;
  scopes: string[];
  expiresAt: number;
  revoked: boolean;
}

/** 모의 공급자 쪽 상태(프로세스 메모리). 키는 SHA-256(값) — 원문을 Map 키로 들고 있지 않는다. */
export class MockOAuthStore {
  readonly codes = new Map<string, MockCode>();
  readonly tokens = new Map<string, MockToken>();
  /** 시험용: 다음 교환·갱신을 실패시키는 코드 */
  failNext: { op: 'exchange' | 'refresh' | 'revoke' | 'account'; code: 'provider_error' | 'invalid_grant' } | null = null;
  reset(): void {
    this.codes.clear();
    this.tokens.clear();
    this.failNext = null;
  }
}

const h = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

const globalForOAuth = globalThis as typeof globalThis & { __contentStudioMockOAuth?: MockOAuthStore };

/** 프로세스당 하나(web 과 시험이 같은 모의 "공급자"를 본다). */
export function mockOAuthStore(): MockOAuthStore {
  if (!globalForOAuth.__contentStudioMockOAuth) globalForOAuth.__contentStudioMockOAuth = new MockOAuthStore();
  return globalForOAuth.__contentStudioMockOAuth;
}

export interface MockAuthorizeParams {
  client_id: string | null;
  redirect_uri: string | null;
  response_type: string | null;
  scope: string | null;
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  login_hint: string | null;
  /** 시험·화면용: 이 사용자로 로그인한 것처럼(계정 바꿔치기 시험) */
  mock_user?: string | null;
  /** 시험용: 쉼표 목록 — 요청 scope 중 이것만 허락 */
  mock_grant?: string | null;
  /** 시험용: 사용자가 거부 */
  mock_deny?: string | null;
}

export type MockAuthorizeResult = { ok: true; redirect: string } | { ok: false; error: 'invalid_client' | 'redirect_mismatch' | 'invalid_request' | 'scope_not_allowed' };

export class MockThreadsOAuthProvider implements OAuthProvider {
  readonly id = 'mock_threads' as const;
  readonly platform = 'threads' as const;
  readonly mock = true;
  /** 공급자에 "등록된" redirect URI(정확 일치) */
  readonly registeredRedirectUri: string;
  private readonly appBaseUrl: string;
  private readonly store: MockOAuthStore;

  constructor(opts: { registeredRedirectUri: string; appBaseUrl: string; store?: MockOAuthStore }) {
    this.registeredRedirectUri = opts.registeredRedirectUri;
    this.appBaseUrl = opts.appBaseUrl;
    this.store = opts.store ?? mockOAuthStore();
  }

  requiredScopes(): readonly string[] {
    return THREADS_REQUIRED_SCOPES;
  }

  buildAuthorizeUrl(req: OAuthAuthorizeRequest): string {
    const u = new URL(MOCK_THREADS_AUTHORIZE_PATH, this.appBaseUrl);
    u.searchParams.set('client_id', MOCK_THREADS_CLIENT_ID);
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', req.scopes.join(','));
    u.searchParams.set('state', req.state);
    u.searchParams.set('code_challenge', req.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (req.loginHint) u.searchParams.set('login_hint', req.loginHint);
    return u.toString();
  }

  /**
   * 모의 "동의 화면": 요청을 검증하고 code 를 발급해 redirect_uri?code&state 로 보낼 주소를 만든다(공급자 쪽 동작).
   * redirect URI 는 등록값과 정확히 같아야 하고, PKCE 는 S256 만, scope 는 허용 목록 안에서만.
   */
  authorize(p: MockAuthorizeParams, now: Date): MockAuthorizeResult {
    if (p.client_id !== MOCK_THREADS_CLIENT_ID) return { ok: false, error: 'invalid_client' };
    if (!p.redirect_uri || p.redirect_uri !== this.registeredRedirectUri) return { ok: false, error: 'redirect_mismatch' };
    if (p.response_type !== 'code' || !p.state || !p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) {
      return { ok: false, error: 'invalid_request' };
    }
    const requested = (p.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (requested.length === 0 || requested.some((s) => !MOCK_ALLOWED_SCOPES.has(s))) return { ok: false, error: 'scope_not_allowed' };
    const back = new URL(p.redirect_uri);
    if (p.mock_deny === '1') {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', p.state);
      return { ok: true, redirect: back.toString() };
    }
    const grant = p.mock_grant ? new Set(p.mock_grant.split(',').map((s) => s.trim())) : null;
    const scopes = grant ? requested.filter((s) => grant.has(s)) : requested;
    const user = (p.mock_user || p.login_hint || '').slice(0, 200);
    if (!user) return { ok: false, error: 'invalid_request' };
    const code = `mockthr_code_${randomBytes(24).toString('base64url')}`;
    this.store.codes.set(h(code), {
      challenge: p.code_challenge,
      redirectUri: p.redirect_uri,
      scopes,
      user,
      displayName: 'MOCK Threads 사용자',
      expiresAt: now.getTime() + MOCK_CODE_TTL_MS,
      used: false,
    });
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.state);
    return { ok: true, redirect: back.toString() };
  }

  private takeFail(op: 'exchange' | 'refresh' | 'revoke' | 'account'): void {
    const f = this.store.failNext;
    if (f && f.op === op) {
      this.store.failNext = null;
      throw new OAuthProviderError(f.code);
    }
  }

  private issue(user: string, displayName: string, scopes: string[], now: Date): OAuthTokenSet {
    const accessToken = `mockthr_at_${randomBytes(32).toString('base64url')}`;
    const expiresAt = now.getTime() + MOCK_TOKEN_TTL_MS;
    this.store.tokens.set(h(accessToken), { user, displayName, scopes: [...scopes], expiresAt, revoked: false });
    return { accessToken, refreshToken: null, expiresAt: new Date(expiresAt), scopes: [...scopes] };
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; now: Date }): Promise<OAuthTokenSet> {
    this.takeFail('exchange');
    const c = this.store.codes.get(h(input.code));
    if (!c) throw new OAuthProviderError('invalid_grant');
    if (c.used) throw new OAuthProviderError('code_reused');
    c.used = true; // 성공·실패와 관계없이 code 는 한 번만
    if (c.expiresAt <= input.now.getTime()) throw new OAuthProviderError('code_expired');
    if (input.redirectUri !== c.redirectUri) throw new OAuthProviderError('redirect_mismatch');
    if (codeChallengeS256(input.codeVerifier) !== c.challenge) throw new OAuthProviderError('pkce_mismatch');
    return this.issue(c.user, c.displayName, c.scopes, input.now);
  }

  private live(token: string, now: Date): MockToken {
    const t = this.store.tokens.get(h(token));
    if (!t) throw new OAuthProviderError('invalid_token');
    if (t.revoked) throw new OAuthProviderError('token_revoked');
    if (t.expiresAt <= now.getTime()) throw new OAuthProviderError('token_expired');
    return t;
  }

  /** Threads 처럼 refresh token 없이, 만료 전의 장기 토큰으로 새 토큰을 받는다(이전 토큰은 무효). */
  async refresh(input: { tokens: StoredOAuthTokens; now: Date }): Promise<OAuthTokenSet> {
    this.takeFail('refresh');
    const t = this.live(input.tokens.accessToken, input.now);
    t.revoked = true;
    return this.issue(t.user, t.displayName, t.scopes, input.now);
  }

  async revoke(input: { tokens: StoredOAuthTokens; now: Date }): Promise<void> {
    this.takeFail('revoke');
    const t = this.store.tokens.get(h(input.tokens.accessToken));
    if (!t) throw new OAuthProviderError('invalid_token');
    t.revoked = true;
  }

  async accountInfo(input: { accessToken: string; now: Date }): Promise<OAuthAccountInfo> {
    this.takeFail('account');
    const t = this.live(input.accessToken, input.now);
    return { externalAccountId: t.user, displayName: t.displayName };
  }
}

/** 공급자 선택에 필요한 계정 필드 */
export interface OAuthAccountRef {
  kind: string;
  platform: string;
}

/**
 * 계정에 맞는 공급자. 모의 계정 + threads → 모의 공급자(네트워크 없음). 모의 계정의 다른 채널 → OAuthNotSupportedError(400).
 * 실제 계정 → liveOAuthReadiness 로 빠진 조건을 모아 LiveOAuthNotConfiguredError(503) — 조건이 모두 있어도 T13 에는 live 어댑터가 없어 항상 거부.
 */
export function resolveOAuthProvider(
  account: OAuthAccountRef,
  config: Pick<AppConfig, 'APP_BASE_URL' | 'OAUTH_REDIRECT_URI' | 'OAUTH_MODE' | 'THREADS_APP_ID' | 'OAUTH_LIVE_APPROVAL_REF' | 'PUBLISH_MODE'>,
  env: Record<string, string | undefined>,
  registeredRedirectUri: string,
  store?: MockOAuthStore,
): OAuthProvider {
  if (account.kind === 'mock') {
    if (account.platform !== 'threads') throw new OAuthNotSupportedError();
    return new MockThreadsOAuthProvider({ registeredRedirectUri, appBaseUrl: config.APP_BASE_URL, store });
  }
  const readiness = liveOAuthReadiness(config, {
    threadsAppSecretPresent: envPresent(env, 'THREADS_APP_SECRET'),
    masterKeyConfigured: readSecretKeyring(env).ok,
  });
  throw new LiveOAuthNotConfiguredError(readiness.missing);
}
