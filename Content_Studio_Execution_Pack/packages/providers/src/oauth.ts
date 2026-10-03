/**
 * T13(결정 D24): 계정 연결 공급자.
 *
 * - MockThreadsOAuthProvider: Threads 형태의 모의 OAuth 공급자. **프로세스 안에서만** 동작한다(HTTP·DNS·소켓 없음).
 *   authorize(사용자 동의 흉내) → code(1회용, 60초, PKCE S256 challenge·redirect URI·scope 에 묶임) → exchangeCode(verifier 검증)
 *   → access token(60일, Threads 장기 토큰처럼 refresh token 없음) → refresh(만료 전, 같은 토큰으로) → revoke.
 *   토큰은 'mockthr_' 로 시작하는 난수이며 실제 Threads 에서 쓸 수 없다. 공급자 상태(code·토큰)는 프로세스 메모리(globalThis)에만 있어
 *   서버를 다시 시작하면 모의 토큰은 "알 수 없음"(invalid_token)이 된다 — 그 경우 화면은 다시 연결을 안내한다.
 *   M4-DEV1: 단, 모의 모드(OAUTH_MODE=mock)에서는 프로세스가 처음 연결 경로를 쓸 때 DB 의 쓸 수 있는 모의 연결 정보로 이 메모리를 한 번 다시 채운다
 *   (ensureMockOAuthRehydrated) — 재시작 뒤에도 모의 연결이 유지된다. 채널 시뮬레이터의 원격 기록은 다시 채우지 않는다(재시작 → UNKNOWN 유지).
 * - resolveOAuthProvider: 계정 kind 로 공급자를 고른다. 모의 계정 + threads → 모의 공급자. 실제(live) 계정은 liveOAuthReadiness 가
 *   항상 거부한다(T13 에는 live 어댑터가 없다 — LiveOAuthNotConfiguredError, 외부 호출 0).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  codeChallengeS256,
  envPresent,
  INSTAGRAM_NOT_REQUESTED_BY_DEFAULT,
  INSTAGRAM_REQUIRED_SCOPES,
  liveOAuthReadiness,
  LiveOAuthNotConfiguredError,
  OAuthNotSupportedError,
  OAuthProviderError,
  readSecretKeyring,
  THREADS_REQUIRED_SCOPES,
  YOUTUBE_NOT_REQUESTED_BY_DEFAULT,
  YOUTUBE_REQUIRED_SCOPES,
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
  /** T15: 발급한 모의 공급자(없으면 mock_threads — T13 행 호환) */
  provider?: 'mock_threads' | 'mock_google' | 'mock_instagram';
  /** T15: access | refresh(Google 형만 refresh token 이 있다) */
  kind?: 'access' | 'refresh';
  /** T15: 같은 동의(grant)에서 나온 토큰 묶음 — Google 형 철회는 묶음 전체를 무효로 한다 */
  grant?: string;
}

/** 모의 공급자 쪽 상태(프로세스 메모리). 키는 SHA-256(값) — 원문을 Map 키로 들고 있지 않는다. */
export class MockOAuthStore {
  readonly codes = new Map<string, MockCode>();
  readonly tokens = new Map<string, MockToken>();
  /** 시험용: 다음 교환·갱신을 실패시키는 코드 */
  failNext: { op: 'exchange' | 'refresh' | 'revoke' | 'account'; code: 'provider_error' | 'invalid_grant' } | null = null;
  /** M4-DEV1: 이 프로세스에서 DB 로부터 다시 채우기를 시작(또는 마쳤)는가 — 프로세스당 한 번(ensureMockOAuthRehydrated). */
  rehydration: Promise<MockRehydrateOutcome> | null = null;
  /** 재시작 흉내: code·토큰·실패 주입·다시 채우기 표식을 모두 잊는다. */
  reset(): void {
    this.codes.clear();
    this.tokens.clear();
    this.failNext = null;
    this.rehydration = null;
  }

  /**
   * M4-DEV1: DB 에 봉인돼 있던 모의 토큰을 "공급자가 발급해 둔 유효 토큰"으로 다시 등록한다(재시작 전 공급자 상태 복원).
   * 이미 아는 토큰(같은 프로세스에서 발급·철회됨)은 건드리지 않는다(멱등 — 철회 상태를 되살리지 않음). 모의 공급자 ID·토큰 접두가 맞지 않으면 등록하지 않는다.
   * 반환: 'registered'(등록), 'already_known'(이미 아는 토큰 — 그대로 둠), 'rejected'(모양·공급자·계정이 맞지 않음 — 등록 안 함).
   * 토큰 값은 SHA-256 키로만 남는다(원문 보관·기록 없음).
   */
  registerRehydrated(e: MockRehydrateEntry): 'registered' | 'already_known' | 'rejected' {
    const spec = REHYDRATE_SPEC[e.provider as MockOAuthProviderId];
    if (!spec) return 'rejected';
    if (typeof e.accessToken !== 'string' || !e.accessToken.startsWith(spec.access) || e.accessToken.length <= spec.access.length) return 'rejected';
    if (!(e.expiresAt instanceof Date) || !Number.isFinite(e.expiresAt.getTime())) return 'rejected';
    if (spec.refresh !== null && (!e.refreshToken || !e.refreshToken.startsWith(spec.refresh) || e.refreshToken.length <= spec.refresh.length)) return 'rejected';
    if (spec.refresh === null && e.refreshToken !== null) return 'rejected';
    const user = typeof e.externalAccountId === 'string' ? e.externalAccountId.slice(0, 200) : '';
    if (!user) return 'rejected';
    const accessKey = h(e.accessToken);
    const refreshKey = e.refreshToken ? h(e.refreshToken) : null;
    if (this.tokens.has(accessKey) || (refreshKey && this.tokens.has(refreshKey))) return 'already_known';
    const scopes = [...e.scopes];
    const provider = e.provider as MockOAuthProviderId;
    if (provider === 'mock_google') {
      // Google 형: access(짧음)·refresh(연결 정보 expires_at)를 같은 동의(grant) 묶음으로 — 갱신·철회가 묶음 전체를 무효로 하도록.
      const accessExp = e.accessExpiresAt && Number.isFinite(e.accessExpiresAt.getTime()) ? e.accessExpiresAt.getTime() : 0;
      const base = { user, displayName: spec.displayName, revoked: false, provider, grant: randomBytes(12).toString('base64url') };
      this.tokens.set(accessKey, { ...base, scopes: [...scopes], expiresAt: accessExp, kind: 'access' });
      this.tokens.set(refreshKey!, { ...base, scopes: [...scopes], expiresAt: e.expiresAt.getTime(), kind: 'refresh' });
      return 'registered';
    }
    this.tokens.set(accessKey, { user, displayName: spec.displayName, scopes, expiresAt: e.expiresAt.getTime(), revoked: false, provider, kind: 'access' });
    return 'registered';
  }
}

const h = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

const globalForOAuth = globalThis as typeof globalThis & { __contentStudioMockOAuth?: MockOAuthStore };

/** 프로세스당 하나(web 과 시험이 같은 모의 "공급자"를 본다). */
export function mockOAuthStore(): MockOAuthStore {
  if (!globalForOAuth.__contentStudioMockOAuth) globalForOAuth.__contentStudioMockOAuth = new MockOAuthStore();
  return globalForOAuth.__contentStudioMockOAuth;
}

// ---- M4-DEV1: 개발 서버 재시작 뒤 모의 연결 유지(DB → 모의 공급자 메모리 다시 채우기) ----

export type MockOAuthProviderId = 'mock_threads' | 'mock_google' | 'mock_instagram';
/** 모의 공급자 ID(oauth_credentials.provider 의 모의 값과 같다). 이 목록 밖(실제 공급자)은 다시 채우지 않는다. */
export const MOCK_OAUTH_PROVIDER_IDS: readonly MockOAuthProviderId[] = ['mock_threads', 'mock_google', 'mock_instagram'];

const REHYDRATE_SPEC: Record<MockOAuthProviderId, { access: string; refresh: string | null; displayName: string }> = {
  mock_threads: { access: 'mockthr_at_', refresh: null, displayName: 'MOCK Threads 사용자' },
  mock_google: { access: 'mockyt_at_', refresh: 'mockyt_rt_', displayName: 'MOCK YouTube 채널' },
  mock_instagram: { access: 'mockig_at_', refresh: null, displayName: 'MOCK Instagram 비즈니스 계정' },
};

/** DB 의 쓸 수 있는 모의 연결 정보 하나(봉인을 연 값 — 서버 메모리 안에서만, 기록·응답 없음). */
export interface MockRehydrateEntry {
  provider: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken: string | null;
  /** oauth_credentials.expires_at — Threads·Instagram 형은 access 만료, Google 형은 refresh 만료 */
  expiresAt: Date;
  /** Google 형 access 만료(봉인 평문의 access_expires_at). 없으면 이미 만료로 등록(보내기 전 갱신 경로가 refresh 로 새로 받는다). */
  accessExpiresAt: Date | null;
  scopes: readonly string[];
}

/** 다시 채우기 결과(개수만 — 토큰·계정 값 없음). */
export type MockRehydrateOutcome =
  | { status: 'skipped_live_mode' }
  | { status: 'failed' }
  | { status: 'done'; registered: number; alreadyKnown: number; skipped: number };

/**
 * M4-DEV1: 프로세스에서 처음 모의 OAuth·작업 처리기 연결 정보 경로를 쓸 때 한 번, DB 의 모의 연결 정보로 모의 공급자 메모리를 다시 채운다.
 * - OAUTH_MODE 가 mock 이 아니면 아무것도 하지 않는다(표식도 남기지 않음). load 는 모의 공급자 행만 돌려줘야 하고, 여기서도 모의 ID·접두를 다시 확인한다.
 * - 프로세스당 한 번(store.rehydration). 두 번 불러도 같은 결과(멱등). load 가 실패하면 표식을 지워 다음 호출이 다시 시도한다.
 * - 채널 시뮬레이터의 원격 기록(게시물·영상·컨테이너)은 다시 만들지 않는다 — 재시작 뒤 조회는 여전히 UNKNOWN 이다.
 */
export function ensureMockOAuthRehydrated(input: {
  oauthMode: string;
  load: () => Promise<{ entries: readonly MockRehydrateEntry[]; skipped: number }>;
  store?: MockOAuthStore;
}): Promise<MockRehydrateOutcome> {
  if (input.oauthMode !== 'mock') return Promise.resolve({ status: 'skipped_live_mode' });
  const store = input.store ?? mockOAuthStore();
  if (store.rehydration) return store.rehydration;
  let run: Promise<MockRehydrateOutcome> | null = null;
  run = (async (): Promise<MockRehydrateOutcome> => {
    await Promise.resolve(); // store.rehydration 에 run 이 들어간 뒤 시작(동시 호출은 같은 Promise 를 받는다)
    try {
      const { entries, skipped } = await input.load();
      let registered = 0;
      let alreadyKnown = 0;
      let invalid = 0;
      for (const e of entries) {
        if (!MOCK_OAUTH_PROVIDER_IDS.includes(e.provider as MockOAuthProviderId)) {
          invalid++;
          continue;
        }
        const r = store.registerRehydrated(e);
        if (r === 'registered') registered++;
        else if (r === 'already_known') alreadyKnown++;
        else invalid++;
      }
      return { status: 'done', registered, alreadyKnown, skipped: skipped + invalid };
    } catch {
      if (store.rehydration === run) store.rehydration = null;
      return { status: 'failed' };
    }
  })();
  store.rehydration = run;
  return run;
}

/**
 * FIX1-M4DEV1(Codex review-M4DEV1 P1 check/route.ts:25): 이번 요청·tick 에서 모의 연결 정보(공급자 호출·작업 처리·만료 임박 갱신)를 써도 되는가.
 * 다시 채우기가 실패했으면(`failed`) false — 모의 공급자 메모리가 비어 있어 공급자가 토큰을 "알 수 없음"으로 판정하고, 그 결과가 연결 정보를
 * error 로 굳히기 때문이다. 이때 호출자는 공급자를 부르지 않고 연결 상태도 바꾸지 않는다(route 503 mock_rehydration_unavailable, worker 는 그 tick 의
 * 연결 정보 작업을 건너뜀). 표식은 이미 지워져 다음 요청이 다시 읽는다. live 모드·키 없음(null)·완료는 true(기존 처리 그대로).
 */
export function mockCredentialWorkAllowed(outcome: MockRehydrateOutcome | null): boolean {
  return outcome?.status !== 'failed';
}

/** 시험용: 다시 채우기 표식만 지운다(다음 ensureMockOAuthRehydrated 가 다시 읽는다). 토큰은 그대로. */
export function resetMockOAuthRehydration(store: MockOAuthStore = mockOAuthStore()): void {
  store.rehydration = null;
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
    // T15: 다른 모의 공급자(Google 형)가 발급한 토큰은 모른다
    if (!t || (t.provider !== undefined && t.provider !== 'mock_threads')) throw new OAuthProviderError('invalid_token');
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
    if (!t || (t.provider !== undefined && t.provider !== 'mock_threads')) throw new OAuthProviderError('invalid_token');
    t.revoked = true;
  }

  async accountInfo(input: { accessToken: string; now: Date }): Promise<OAuthAccountInfo> {
    this.takeFail('account');
    const t = this.live(input.accessToken, input.now);
    return { externalAccountId: t.user, displayName: t.displayName };
  }
}

// ---- T15(D27): Google(YouTube) 형 모의 OAuth 공급자 ----

export const MOCK_GOOGLE_CLIENT_ID = 'mock-google-client';
export const MOCK_GOOGLE_AUTHORIZE_PATH = '/api/oauth/mock-google/authorize';
/** Google 형 access token 은 짧다(모의 1시간 — 실제 값은 live 전에 공식 문서로 확인). */
export const MOCK_GOOGLE_ACCESS_TTL_MS = 3600_000;
/** refresh token 은 길다(모의 180일 — 연결 정보 expires_at 으로 쓰고, 7일 전부터 자동 갱신 대상). */
export const MOCK_GOOGLE_REFRESH_TTL_MS = 180 * 24 * 3600_000;
const MOCK_GOOGLE_ALLOWED_SCOPES = new Set<string>([...YOUTUBE_REQUIRED_SCOPES, ...YOUTUBE_NOT_REQUESTED_BY_DEFAULT]);

/**
 * Google(YouTube) 형 모의 OAuth 공급자 — **프로세스 안**(HTTP·DNS 없음). authorization code + PKCE S256 + state, scope 는 업로드용 자리 표시
 * 이름(`youtube.upload(mock)` — 실제 Google scope 이름 아님)만. 토큰: access `mockyt_at_…`(1시간), refresh `mockyt_rt_…`(180일).
 * 갱신은 refresh token 으로 새 access·refresh 를 받고 이전 둘을 무효로 한다(**모의 가정: 회전** — 실제 Google 은 보통 refresh token 을 그대로 둔다,
 * T13 의 세대·정리 철회 규칙이 새 묶음만 철회하도록). 철회는 그 동의(grant)의 토큰을 모두 무효로 한다. 상태는 T13 과 같은 MockOAuthStore.
 */
export class MockGoogleOAuthProvider implements OAuthProvider {
  readonly id = 'mock_google' as const;
  readonly platform = 'youtube' as const;
  readonly mock = true;
  readonly registeredRedirectUri: string;
  private readonly appBaseUrl: string;
  private readonly store: MockOAuthStore;

  constructor(opts: { registeredRedirectUri: string; appBaseUrl: string; store?: MockOAuthStore }) {
    this.registeredRedirectUri = opts.registeredRedirectUri;
    this.appBaseUrl = opts.appBaseUrl;
    this.store = opts.store ?? mockOAuthStore();
  }

  requiredScopes(): readonly string[] {
    return YOUTUBE_REQUIRED_SCOPES;
  }

  buildAuthorizeUrl(req: OAuthAuthorizeRequest): string {
    const u = new URL(MOCK_GOOGLE_AUTHORIZE_PATH, this.appBaseUrl);
    u.searchParams.set('client_id', MOCK_GOOGLE_CLIENT_ID);
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('response_type', 'code');
    // Google 형: scope 는 공백 구분(URLSearchParams 가 '+' 로 인코딩)
    u.searchParams.set('scope', req.scopes.join(' '));
    u.searchParams.set('state', req.state);
    u.searchParams.set('code_challenge', req.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('access_type', 'offline');
    if (req.loginHint) u.searchParams.set('login_hint', req.loginHint);
    return u.toString();
  }

  /** 모의 동의 화면(공급자 쪽): 등록 redirect URI 정확 일치·S256 만·허용 scope 만. */
  authorize(p: MockAuthorizeParams, now: Date): MockAuthorizeResult {
    if (p.client_id !== MOCK_GOOGLE_CLIENT_ID) return { ok: false, error: 'invalid_client' };
    if (!p.redirect_uri || p.redirect_uri !== this.registeredRedirectUri) return { ok: false, error: 'redirect_mismatch' };
    if (p.response_type !== 'code' || !p.state || !p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) {
      return { ok: false, error: 'invalid_request' };
    }
    const requested = (p.scope ?? '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    if (requested.length === 0 || requested.some((x) => !MOCK_GOOGLE_ALLOWED_SCOPES.has(x))) return { ok: false, error: 'scope_not_allowed' };
    const back = new URL(p.redirect_uri);
    if (p.mock_deny === '1') {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', p.state);
      return { ok: true, redirect: back.toString() };
    }
    const grant = p.mock_grant ? new Set(p.mock_grant.split(/[\s,]+/).map((x) => x.trim())) : null;
    const scopes = grant ? requested.filter((x) => grant.has(x)) : requested;
    const user = (p.mock_user || p.login_hint || '').slice(0, 200);
    if (!user) return { ok: false, error: 'invalid_request' };
    const code = `mockyt_code_${randomBytes(24).toString('base64url')}`;
    this.store.codes.set(h(code), {
      challenge: p.code_challenge,
      redirectUri: p.redirect_uri,
      scopes,
      user,
      displayName: 'MOCK YouTube 채널',
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
    const grant = randomBytes(12).toString('base64url');
    const accessToken = `mockyt_at_${randomBytes(32).toString('base64url')}`;
    const refreshToken = `mockyt_rt_${randomBytes(32).toString('base64url')}`;
    const accessExp = now.getTime() + MOCK_GOOGLE_ACCESS_TTL_MS;
    const refreshExp = now.getTime() + MOCK_GOOGLE_REFRESH_TTL_MS;
    const base = { user, displayName, scopes: [...scopes], revoked: false, provider: 'mock_google' as const, grant };
    this.store.tokens.set(h(accessToken), { ...base, expiresAt: accessExp, kind: 'access' });
    this.store.tokens.set(h(refreshToken), { ...base, scopes: [...scopes], expiresAt: refreshExp, kind: 'refresh' });
    return { accessToken, refreshToken, expiresAt: new Date(refreshExp), accessExpiresAt: new Date(accessExp), scopes: [...scopes] };
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; now: Date }): Promise<OAuthTokenSet> {
    this.takeFail('exchange');
    const c = this.store.codes.get(h(input.code));
    if (!c || !input.code.startsWith('mockyt_code_')) throw new OAuthProviderError('invalid_grant');
    if (c.used) throw new OAuthProviderError('code_reused');
    c.used = true;
    if (c.expiresAt <= input.now.getTime()) throw new OAuthProviderError('code_expired');
    if (input.redirectUri !== c.redirectUri) throw new OAuthProviderError('redirect_mismatch');
    if (codeChallengeS256(input.codeVerifier) !== c.challenge) throw new OAuthProviderError('pkce_mismatch');
    return this.issue(c.user, c.displayName, c.scopes, input.now);
  }

  private live(token: string, kind: 'access' | 'refresh', now: Date): MockToken {
    const t = this.store.tokens.get(h(token));
    if (!t || t.provider !== 'mock_google' || t.kind !== kind) throw new OAuthProviderError(kind === 'refresh' ? 'invalid_grant' : 'invalid_token');
    if (t.revoked) throw new OAuthProviderError(kind === 'refresh' ? 'invalid_grant' : 'token_revoked');
    if (t.expiresAt <= now.getTime()) throw new OAuthProviderError(kind === 'refresh' ? 'invalid_grant' : 'token_expired');
    return t;
  }

  private revokeGrant(grant: string | undefined): void {
    if (!grant) return;
    for (const t of this.store.tokens.values()) if (t.grant === grant) t.revoked = true;
  }

  /** refresh token 으로 새 묶음(모의: 회전 — 이전 access·refresh 무효). */
  async refresh(input: { tokens: StoredOAuthTokens; now: Date }): Promise<OAuthTokenSet> {
    this.takeFail('refresh');
    if (!input.tokens.refreshToken) throw new OAuthProviderError('invalid_grant');
    const t = this.live(input.tokens.refreshToken, 'refresh', input.now);
    this.revokeGrant(t.grant);
    return this.issue(t.user, t.displayName, t.scopes, input.now);
  }

  /** 철회: 그 동의(grant)의 토큰 모두 무효(access·refresh 어느 쪽으로 불러도). 모르는 토큰은 invalid_token(T13 FIX3: 이미 철회로 본다). */
  async revoke(input: { tokens: StoredOAuthTokens; now: Date }): Promise<void> {
    this.takeFail('revoke');
    const t = this.store.tokens.get(h(input.tokens.refreshToken ?? input.tokens.accessToken)) ?? this.store.tokens.get(h(input.tokens.accessToken));
    if (!t || t.provider !== 'mock_google') throw new OAuthProviderError('invalid_token');
    this.revokeGrant(t.grant);
  }

  async accountInfo(input: { accessToken: string; now: Date }): Promise<OAuthAccountInfo> {
    this.takeFail('account');
    const t = this.live(input.accessToken, 'access', input.now);
    return { externalAccountId: t.user, displayName: t.displayName };
  }
}

// ---- T16(D29 제안): Instagram(Meta 형) 모의 OAuth 공급자 ----

export const MOCK_INSTAGRAM_CLIENT_ID = 'mock-instagram-client';
export const MOCK_INSTAGRAM_AUTHORIZE_PATH = '/api/oauth/mock-instagram/authorize';
/** 모의 장기 토큰 60일(Meta 형 — 실제 수명·갱신 규칙은 live 전에 공식 문서로 확인). */
export const MOCK_INSTAGRAM_TOKEN_TTL_MS = 60 * 24 * 3600_000;
const MOCK_INSTAGRAM_ALLOWED_SCOPES = new Set<string>([...INSTAGRAM_REQUIRED_SCOPES, ...INSTAGRAM_NOT_REQUESTED_BY_DEFAULT]);

/**
 * Instagram(Meta 형) 모의 OAuth 공급자 — **프로세스 안**(HTTP·DNS 없음). Threads 모의와 같은 모양: authorization code + PKCE S256 + state,
 * refresh token 없이 장기 access token(`mockig_at_…`, 60일)을 만료 전에 같은 토큰으로 갱신(이전 토큰 무효), 철회는 그 토큰.
 * scope 는 자리 표시 이름(`instagram_basic(mock)`·`instagram_content_publish(mock)` — "(mock) — 공식 이름 live 전 재확인")만.
 * 모의 사용자는 **비즈니스·크리에이터(professional) 계정이라고 가정**한다(실제 계정 종류 확인은 live 전 사용자 결정·공식 재확인).
 * 다른 모의 공급자(Threads·Google)가 발급한 토큰은 모른다(invalid_token). 상태는 T13 과 같은 MockOAuthStore.
 */
export class MockInstagramOAuthProvider implements OAuthProvider {
  readonly id = 'mock_instagram' as const;
  readonly platform = 'instagram' as const;
  readonly mock = true;
  readonly registeredRedirectUri: string;
  private readonly appBaseUrl: string;
  private readonly store: MockOAuthStore;

  constructor(opts: { registeredRedirectUri: string; appBaseUrl: string; store?: MockOAuthStore }) {
    this.registeredRedirectUri = opts.registeredRedirectUri;
    this.appBaseUrl = opts.appBaseUrl;
    this.store = opts.store ?? mockOAuthStore();
  }

  requiredScopes(): readonly string[] {
    return INSTAGRAM_REQUIRED_SCOPES;
  }

  buildAuthorizeUrl(req: OAuthAuthorizeRequest): string {
    const u = new URL(MOCK_INSTAGRAM_AUTHORIZE_PATH, this.appBaseUrl);
    u.searchParams.set('client_id', MOCK_INSTAGRAM_CLIENT_ID);
    u.searchParams.set('redirect_uri', req.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', req.scopes.join(','));
    u.searchParams.set('state', req.state);
    u.searchParams.set('code_challenge', req.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    if (req.loginHint) u.searchParams.set('login_hint', req.loginHint);
    return u.toString();
  }

  /** 모의 동의 화면(공급자 쪽): 등록 redirect URI 정확 일치·S256 만·허용 scope 만. */
  authorize(p: MockAuthorizeParams, now: Date): MockAuthorizeResult {
    if (p.client_id !== MOCK_INSTAGRAM_CLIENT_ID) return { ok: false, error: 'invalid_client' };
    if (!p.redirect_uri || p.redirect_uri !== this.registeredRedirectUri) return { ok: false, error: 'redirect_mismatch' };
    if (p.response_type !== 'code' || !p.state || !p.code_challenge || p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) {
      return { ok: false, error: 'invalid_request' };
    }
    const requested = (p.scope ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (requested.length === 0 || requested.some((x) => !MOCK_INSTAGRAM_ALLOWED_SCOPES.has(x))) return { ok: false, error: 'scope_not_allowed' };
    const back = new URL(p.redirect_uri);
    if (p.mock_deny === '1') {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', p.state);
      return { ok: true, redirect: back.toString() };
    }
    const grant = p.mock_grant ? new Set(p.mock_grant.split(',').map((x) => x.trim())) : null;
    const scopes = grant ? requested.filter((x) => grant.has(x)) : requested;
    const user = (p.mock_user || p.login_hint || '').slice(0, 200);
    if (!user) return { ok: false, error: 'invalid_request' };
    const code = `mockig_code_${randomBytes(24).toString('base64url')}`;
    this.store.codes.set(h(code), {
      challenge: p.code_challenge,
      redirectUri: p.redirect_uri,
      scopes,
      user,
      displayName: 'MOCK Instagram 비즈니스 계정',
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
    const accessToken = `mockig_at_${randomBytes(32).toString('base64url')}`;
    const expiresAt = now.getTime() + MOCK_INSTAGRAM_TOKEN_TTL_MS;
    this.store.tokens.set(h(accessToken), { user, displayName, scopes: [...scopes], expiresAt, revoked: false, provider: 'mock_instagram', kind: 'access' });
    return { accessToken, refreshToken: null, expiresAt: new Date(expiresAt), scopes: [...scopes] };
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string; now: Date }): Promise<OAuthTokenSet> {
    this.takeFail('exchange');
    const c = this.store.codes.get(h(input.code));
    if (!c || !input.code.startsWith('mockig_code_')) throw new OAuthProviderError('invalid_grant');
    if (c.used) throw new OAuthProviderError('code_reused');
    c.used = true;
    if (c.expiresAt <= input.now.getTime()) throw new OAuthProviderError('code_expired');
    if (input.redirectUri !== c.redirectUri) throw new OAuthProviderError('redirect_mismatch');
    if (codeChallengeS256(input.codeVerifier) !== c.challenge) throw new OAuthProviderError('pkce_mismatch');
    return this.issue(c.user, c.displayName, c.scopes, input.now);
  }

  private live(token: string, now: Date): MockToken {
    const t = this.store.tokens.get(h(token));
    if (!t || t.provider !== 'mock_instagram') throw new OAuthProviderError('invalid_token');
    if (t.revoked) throw new OAuthProviderError('token_revoked');
    if (t.expiresAt <= now.getTime()) throw new OAuthProviderError('token_expired');
    return t;
  }

  /** Meta 형: refresh token 없이 만료 전의 장기 토큰으로 새 토큰(이전 토큰 무효 — 모의 가정, live 전 재확인). */
  async refresh(input: { tokens: StoredOAuthTokens; now: Date }): Promise<OAuthTokenSet> {
    this.takeFail('refresh');
    const t = this.live(input.tokens.accessToken, input.now);
    t.revoked = true;
    return this.issue(t.user, t.displayName, t.scopes, input.now);
  }

  async revoke(input: { tokens: StoredOAuthTokens; now: Date }): Promise<void> {
    this.takeFail('revoke');
    const t = this.store.tokens.get(h(input.tokens.accessToken));
    if (!t || t.provider !== 'mock_instagram') throw new OAuthProviderError('invalid_token');
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
    if (account.platform === 'threads') return new MockThreadsOAuthProvider({ registeredRedirectUri, appBaseUrl: config.APP_BASE_URL, store });
    // T15(D27): YouTube 모의 계정 → Google 형 모의 공급자(네트워크 없음)
    if (account.platform === 'youtube') return new MockGoogleOAuthProvider({ registeredRedirectUri, appBaseUrl: config.APP_BASE_URL, store });
    // T16(D29 제안): Instagram 모의 계정 → Meta 형 모의 공급자(네트워크 없음)
    if (account.platform === 'instagram') return new MockInstagramOAuthProvider({ registeredRedirectUri, appBaseUrl: config.APP_BASE_URL, store });
    throw new OAuthNotSupportedError();
  }
  const readiness = liveOAuthReadiness(config, {
    threadsAppSecretPresent: envPresent(env, 'THREADS_APP_SECRET'),
    masterKeyConfigured: readSecretKeyring(env).ok,
  });
  throw new LiveOAuthNotConfiguredError(readiness.missing);
}
