/**
 * LIVE-T1(D31 1단계): 실제 Threads OAuth 공급자 — fixture fetch 만(네트워크 없음). 값은 모두 가짜(FAKE_…).
 * 응답 모양은 공식 문서 예시를 따른다(코드 교환 { access_token, user_id }, 오류 { error_type, code, error_message }, Graph 오류 { error: { … } }).
 */
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_THREADS_REFRESH_MARKER,
  liveOAuthReadinessFromEnv,
  LiveOAuthNotConfiguredError,
  LiveRefreshOutOfScopeError,
  loadConfig,
  OAuthNotSupportedError,
  OAuthProviderError,
  type OAuthProviderErrorCode,
} from '@cs/domain';
import { MockThreadsOAuthProvider, resolveOAuthProvider } from './oauth';
import {
  LiveThreadsOAuthProvider,
  mapThreadsError,
  THREADS_AUTHORIZE_URL,
  THREADS_LONG_LIVED_URL,
  THREADS_ME_URL,
  THREADS_REFRESH_URL,
  THREADS_TOKEN_URL,
} from './threads-live-oauth';

const REDIRECT = 'http://localhost:3000/api/oauth/callback';
const APP_ID = '000000000000001';
const SECRET = 'FAKE_app_secret_LIVET1_do_not_use';
const CODE = 'FAKE_auth_code_LIVET1_ccccccccccccccccccc';
const SHORT = 'FAKE_short_token_LIVET1_ssssssssssssssssss';
const LONG = 'FAKE_long_token_LIVET1_llllllllllllllllllll';
const LONG2 = 'FAKE_long_token_LIVET1_refreshed_rrrrrrrrrr';
const NOW = new Date('2026-10-03T09:00:00Z');
const SECRETS = [SECRET, CODE, SHORT, LONG, LONG2];

interface Seen {
  method: string;
  url: URL;
  body: string;
  redirect: string | undefined;
  hasSignal: boolean;
}

type Reply = Response | (() => Response) | Error;

/** 경로별 고정 응답(fixture). 등록하지 않은 요청은 시험 실패. */
function fixtureFetch(routes: Record<string, Reply | Reply[]>) {
  const seen: Seen[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    seen.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? init.body : '', redirect: init?.redirect, hasSignal: !!init?.signal });
    const key = `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`;
    const q = queues.get(key);
    if (!q || !q.length) throw new Error(`fixture 없음: ${key}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone();
  });
  return { fetch, seen };
}

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const EXCHANGE_OK = () => jsonRes(200, { access_token: SHORT, token_type: 'bearer', user_id: 17841405793187218 });
const LONG_OK = () => jsonRes(200, { access_token: LONG, token_type: 'bearer', expires_in: 5183944 });
const ME_OK = () => jsonRes(200, { id: '1234567', username: 'threadsapitestuser' });

const K = (method: string, url: string) => `${method} ${url}`;

function provider(fetch: (i: string, o?: RequestInit) => Promise<Response>, timeoutMs?: number, refreshEnabled?: boolean) {
  return new LiveThreadsOAuthProvider({ appId: APP_ID, appSecret: SECRET, registeredRedirectUri: REDIRECT, fetch, timeoutMs, refreshEnabled });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('authorize URL — 공식 문서의 정확한 모양', () => {
  it('threads.com/oauth/authorize · client_id · redirect_uri 정확 · scope 2개(쉼표) · response_type=code · state, PKCE·login_hint·시크릿 없음', () => {
    const { fetch } = fixtureFetch({});
    const p = provider(fetch);
    expect(p.pkce).toBe(false);
    expect(p.mock).toBe(false);
    expect(p.id).toBe('threads');
    const url = p.buildAuthorizeUrl({ state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), redirectUri: REDIRECT, scopes: ['threads_basic', 'threads_content_publish'], loginHint: 'x' });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(THREADS_AUTHORIZE_URL);
    expect([...u.searchParams.keys()].sort()).toEqual(['client_id', 'redirect_uri', 'response_type', 'scope', 'state']);
    expect(u.searchParams.get('client_id')).toBe(APP_ID);
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('state')).toBe('s'.repeat(43));
    expect(url).not.toContain(SECRET);
    expect(url).not.toContain('code_challenge');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('다른 redirect URI(끝 슬래시 포함)·요청하지 않는 scope(reply·insights)는 거부', () => {
    const p = provider(fixtureFetch({}).fetch);
    const base = { state: 's'.repeat(43), codeChallenge: 'c'.repeat(43), scopes: ['threads_basic', 'threads_content_publish'] };
    expect(() => p.buildAuthorizeUrl({ ...base, redirectUri: `${REDIRECT}/` })).toThrow(OAuthProviderError);
    for (const extra of ['threads_manage_replies', 'threads_read_replies', 'threads_manage_insights']) {
      expect(() => p.buildAuthorizeUrl({ ...base, redirectUri: REDIRECT, scopes: ['threads_basic', extra] })).toThrow(OAuthProviderError);
    }
  });
});

describe('코드 교환 → 장기 토큰', () => {
  it('성공: POST graph.threads.com/oauth/access_token(form 5개) → GET graph.threads.net/access_token(th_exchange_token) — 장기 토큰·만료·scope', async () => {
    const { fetch, seen } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: EXCHANGE_OK, [K('GET', THREADS_LONG_LIVED_URL)]: LONG_OK });
    const t = await provider(fetch).exchangeCode({ code: `${CODE}#_`, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW });
    expect(t.accessToken).toBe(LONG);
    expect(t.refreshToken).toBeNull();
    expect(t.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 5183944 * 1000).toISOString());
    expect(t.scopes).toEqual(['threads_basic', 'threads_content_publish']);
    expect(seen).toHaveLength(2);
    const [ex, ll] = seen as [Seen, Seen];
    expect(ex.method).toBe('POST');
    expect(ex.url.href).toBe(THREADS_TOKEN_URL);
    const form = new URLSearchParams(ex.body);
    expect(Object.fromEntries(form)).toEqual({ client_id: APP_ID, client_secret: SECRET, grant_type: 'authorization_code', redirect_uri: REDIRECT, code: CODE });
    expect(ll.method).toBe('GET');
    expect(`${ll.url.origin}${ll.url.pathname}`).toBe(THREADS_LONG_LIVED_URL);
    expect(Object.fromEntries(ll.url.searchParams)).toEqual({ grant_type: 'th_exchange_token', client_secret: SECRET, access_token: SHORT });
    // 리다이렉트를 따르지 않고(시크릿이 다른 호스트로 가지 않음) 시간 제한이 있다
    for (const s of seen) {
      expect(s.redirect).toBe('error');
      expect(s.hasSignal).toBe(true);
    }
  });
  it('이미 쓴 code(문서 예시 OAuthException 400) → invalid_grant, 장기 교환은 부르지 않는다', async () => {
    const { fetch, seen } = fixtureFetch({
      [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(400, { error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' }),
    });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e).toBeInstanceOf(OAuthProviderError);
    expect(e.code).toBe('invalid_grant');
    expect(e.detail).toMatchObject({ reason: 'oauth_exception', step: 'exchange', httpStatus: 400, providerCode: 400 });
    expect(seen).toHaveLength(1);
  });
  it('앱 시크릿 거부 → invalid_client(메시지 원문은 결과에 없다)', async () => {
    const { fetch } = fixtureFetch({
      [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(400, { error: { message: 'Error validating client secret.', type: 'OAuthException', code: 1, fbtrace_id: 'FAKE' } }),
    });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('invalid_client');
    expect(JSON.stringify(e.detail)).not.toContain('validating');
    expect(e.message).toBe('oauth provider error: invalid_client');
  });
  it('redirect_uri 불일치 오류 → redirect_mismatch, 등록값과 다른 redirect 는 보내기 전에 거부', async () => {
    const { fetch } = fixtureFetch({
      [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(400, { error: { message: 'Error validating verification code. Please make sure your redirect_uri is identical', type: 'OAuthException', code: 100 } }),
    });
    const p = provider(fetch);
    expect((await p.exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x)).code).toBe('redirect_mismatch');
    const n = fetch.mock.calls.length;
    expect((await p.exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: `${REDIRECT}x`, now: NOW }).catch((x) => x)).code).toBe('redirect_mismatch');
    expect(fetch.mock.calls.length).toBe(n);
  });
  it('네트워크 끊김·시간 초과(코드 교환) → provider_error + ambiguous(코드가 소비됐을 수 있음)', async () => {
    for (const [err, reason] of [
      [new TypeError(`fetch failed ${THREADS_TOKEN_URL}?client_secret=${SECRET}`), 'network'],
      [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'timeout'],
    ] as const) {
      const { fetch } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: err });
      const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
      expect(e.code).toBe('provider_error');
      expect(e.detail).toEqual({ reason, step: 'exchange', ambiguous: true });
      expect(e.cause).toBeUndefined();
      expect(inspect(e, { depth: Infinity })).not.toContain(SECRET);
    }
  });
  it('실제 시간 제한: 응답이 오지 않으면 timeoutMs 뒤 timeout(ambiguous)', async () => {
    const hang = vi.fn(
      (_i: string, o?: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          o?.signal?.addEventListener('abort', () => rej(o.signal!.reason));
        }),
    );
    const e = await provider(hang, 30).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('provider_error');
    expect(e.detail).toMatchObject({ reason: 'timeout', ambiguous: true });
  });
  it('코드 교환은 됐는데 장기 교환이 5xx·형식 오류 → provider_error(ambiguous), 단기 토큰은 돌려주지 않는다', async () => {
    for (const bad of [() => jsonRes(503, { error: { message: 'x', type: 'OAuthException', code: 2 } }), () => new Response('<html>oops</html>', { status: 200 }), () => jsonRes(200, { access_token: LONG })]) {
      const { fetch } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: EXCHANGE_OK, [K('GET', THREADS_LONG_LIVED_URL)]: bad });
      const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
      expect(e).toBeInstanceOf(OAuthProviderError);
      expect(e.code).toBe('provider_error');
      expect(e.detail.ambiguous).toBe(true);
      expect(e.detail.step).toBe('long_lived');
      expect(e.detail.shortTokenIssued).toBe(true); // FIX1-LIVET1: 단기 토큰은 이미 발급됨
    }
  });
});

describe('갱신·프로필·철회', () => {
  it('refresh: GET graph.threads.net/refresh_access_token(th_refresh_token) → 새 장기 토큰(60일)', async () => {
    const { fetch, seen } = fixtureFetch({ [K('GET', THREADS_REFRESH_URL)]: () => jsonRes(200, { access_token: LONG2, token_type: 'bearer', expires_in: 5184000 }) });
    const t = await provider(fetch, undefined, true).refresh({ tokens: { accessToken: LONG, refreshToken: null }, now: NOW });
    expect(t.accessToken).toBe(LONG2);
    expect(t.expiresAt.getTime()).toBe(NOW.getTime() + 5184000 * 1000);
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ grant_type: 'th_refresh_token', access_token: LONG });
    expect(seen[0]!.url.searchParams.has('client_secret')).toBe(false);
  });
  it('refresh 오류: 190(무효) → invalid_token, 190/463 → token_expired, 그 밖 4xx(24시간 안 갱신 등) → invalid_request, 429 → provider_error(rate_limited)', async () => {
    const cases: Array<[Response, OAuthProviderErrorCode, string]> = [
      [jsonRes(400, { error: { message: 'Invalid OAuth access token.', type: 'OAuthException', code: 190 } }), 'invalid_token', 'oauth_exception'],
      [jsonRes(400, { error: { message: 'Session has expired', type: 'OAuthException', code: 190, error_subcode: 463 } }), 'token_expired', 'oauth_exception'],
      [jsonRes(400, { error: { message: 'Token too new', type: 'OAuthException', code: 100 } }), 'invalid_request', 'oauth_exception'],
      [jsonRes(429, {}, { 'retry-after': '120' }), 'provider_error', 'rate_limited'],
    ];
    for (const [res, code, reason] of cases) {
      const { fetch } = fixtureFetch({ [K('GET', THREADS_REFRESH_URL)]: () => res.clone() });
      const e = await provider(fetch, undefined, true).refresh({ tokens: { accessToken: LONG, refreshToken: null }, now: NOW }).catch((x) => x);
      expect(e.code, `${code}`).toBe(code);
      expect(e.detail.reason).toBe(reason);
    }
  });
  it('프로필: GET graph.threads.net/v1.0/me?fields=id,username → 문자열 id · @username', async () => {
    const { fetch, seen } = fixtureFetch({ [K('GET', THREADS_ME_URL)]: ME_OK });
    const info = await provider(fetch).accountInfo({ accessToken: LONG, now: NOW });
    expect(info).toEqual({ externalAccountId: '1234567', displayName: '@threadsapitestuser' });
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ fields: 'id,username', access_token: LONG });
  });
  it('프로필 id 가 숫자(JSON number)·없음 → provider_error(malformed_response) — 큰 수 정밀도 손실을 받아들이지 않는다', async () => {
    for (const body of [{ id: 17841405793187218, username: 'u' }, { username: 'u' }]) {
      const { fetch } = fixtureFetch({ [K('GET', THREADS_ME_URL)]: () => jsonRes(200, body) });
      const e = await provider(fetch).accountInfo({ accessToken: LONG, now: NOW }).catch((x) => x);
      expect(e.code).toBe('provider_error');
      expect(e.detail.reason).toBe('malformed_response');
    }
  });
  it('철회: 공식 철회 API 없음 → { remoteRevoke: unsupported }, 네트워크 호출 0', async () => {
    const { fetch } = fixtureFetch({});
    expect(await provider(fetch).revoke({ tokens: { accessToken: LONG, refreshToken: null }, now: NOW })).toEqual({ remoteRevoke: 'unsupported' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('오류 매핑 표', () => {
  const cases: Array<[Parameters<typeof mapThreadsError>, OAuthProviderErrorCode, Record<string, unknown>]> = [
    [['exchange', 400, { error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' }], 'invalid_grant', { providerCode: 400 }],
    [['exchange', 400, { error: { message: 'Invalid client_id', type: 'OAuthException', code: 101 } }], 'invalid_client', { providerCode: 101 }],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 190, error_subcode: 460 } }], 'token_revoked', { providerSubcode: 460 }],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 190, error_subcode: 458 } }], 'token_revoked', {}],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 190 } }], 'invalid_token', {}],
    [['account', 403, { error: { message: 'x', type: 'OAuthException', code: 10 } }], 'scope_not_allowed', {}],
    [['account', 403, { error: { message: 'x', type: 'OAuthException', code: 200 } }], 'scope_not_allowed', {}],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 4 } }], 'provider_error', { reason: 'rate_limited' }],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 17 } }], 'provider_error', { reason: 'rate_limited' }],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 32 } }], 'provider_error', { reason: 'rate_limited' }],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 613 } }], 'provider_error', { reason: 'rate_limited' }],
    [['account', 429, null, '30'], 'provider_error', { reason: 'rate_limited', retryAfterSec: 30 }],
    [['account', 500, null], 'provider_error', { reason: 'server_error', ambiguous: false }],
    [['exchange', 502, null], 'provider_error', { reason: 'server_error', ambiguous: true }],
    [['refresh', 400, { error: { message: 'x', type: 'OAuthException', code: 2 } }], 'provider_error', { reason: 'server_error', ambiguous: true }],
    [['account', 401, null], 'invalid_token', { reason: 'http_error' }],
    [['account', 400, { foo: 1 }], 'invalid_request', { reason: 'http_error' }],
  ];
  it.each(cases.map((c, i) => [i, ...c] as const))('#%i', (_i, args, code, detail) => {
    const e = mapThreadsError(...args);
    expect(e.code).toBe(code);
    expect(e.detail).toMatchObject(detail);
  });
});

describe('비밀 위생 — 시크릿·토큰·code 가 로그·오류·직렬화에 없다', () => {
  it('성공·실패 경로 전체에서 console 출력·오류 직렬화(JSON·inspect·message·stack)·공급자 직렬화에 가짜 비밀이 없다', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity }))).join(' ')));
    }
    const errors: unknown[] = [];
    const run = async (routes: Record<string, Reply | Reply[]>, fn: (p: LiveThreadsOAuthProvider) => Promise<unknown>) => {
      const { fetch } = fixtureFetch(routes);
      const p = provider(fetch, undefined, true); // refresh 오류 경로도 비밀 위생을 본다(fixture 만)
      try {
        await fn(p);
      } catch (e) {
        errors.push(e);
      }
      return p;
    };
    const ex = (p: LiveThreadsOAuthProvider) => p.exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW });
    const p1 = await run({ [K('POST', THREADS_TOKEN_URL)]: EXCHANGE_OK, [K('GET', THREADS_LONG_LIVED_URL)]: LONG_OK }, ex);
    // 공급자 오류 본문이 시크릿·토큰을 그대로 되돌려 보내는 최악의 경우도 결과에 실리지 않는다
    await run({ [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(400, { error: { message: `bad secret ${SECRET} code ${CODE}`, type: 'OAuthException', code: 1 } }) }, ex);
    await run({ [K('POST', THREADS_TOKEN_URL)]: new TypeError(`fetch failed: ${THREADS_TOKEN_URL}?client_secret=${SECRET}&code=${CODE}`) }, ex);
    await run({ [K('POST', THREADS_TOKEN_URL)]: EXCHANGE_OK, [K('GET', THREADS_LONG_LIVED_URL)]: new TypeError(`connect ECONNRESET ${THREADS_LONG_LIVED_URL}?client_secret=${SECRET}&access_token=${SHORT}`) }, ex);
    await run({ [K('GET', THREADS_ME_URL)]: () => jsonRes(400, { error: { message: `Invalid token ${LONG}`, type: 'OAuthException', code: 190 } }) }, (p) => p.accountInfo({ accessToken: LONG, now: NOW }));
    await run({ [K('GET', THREADS_REFRESH_URL)]: new TypeError(`fetch failed ${LONG}`) }, (p) => p.refresh({ tokens: { accessToken: LONG, refreshToken: null }, now: NOW }));
    expect(errors.length).toBe(5);
    const blobs = [
      ...logs,
      JSON.stringify(p1),
      inspect(p1, { depth: Infinity, showHidden: true }),
      String(p1),
      ...errors.flatMap((e) => [JSON.stringify(e), inspect(e, { depth: Infinity, showHidden: true }), String((e as Error).message), String((e as Error).stack)]),
    ].join('\n');
    for (const s of SECRETS) expect(blobs, `비밀 노출: ${s.slice(0, 12)}…`).not.toContain(s);
    for (const e of errors) {
      expect(e).toBeInstanceOf(OAuthProviderError);
      expect((e as Error).cause).toBeUndefined();
    }
  });
  it('허용 호스트·https 밖으로는 보내지 않는다(host_not_allowed)', async () => {
    // 내부 상수를 바꿀 수 없으므로 fetch 이전 단계의 허용 목록을 직접 확인한다: 정상 URL 은 graph.threads.com/net 뿐
    for (const u of [THREADS_TOKEN_URL, THREADS_LONG_LIVED_URL, THREADS_REFRESH_URL, THREADS_ME_URL]) {
      expect(new URL(u).protocol).toBe('https:');
      expect(['graph.threads.com', 'graph.threads.net']).toContain(new URL(u).hostname);
    }
  });
  it('생성자: 앱 ID 는 숫자, 시크릿은 공백 없이, redirect 는 scheme+host+path — 오류에 값 없음', () => {
    for (const opts of [
      { appId: 'abc', appSecret: SECRET, registeredRedirectUri: REDIRECT },
      { appId: APP_ID, appSecret: `${SECRET} x`, registeredRedirectUri: REDIRECT },
      { appId: APP_ID, appSecret: SECRET, registeredRedirectUri: `${REDIRECT}?x=1` },
    ]) {
      try {
        new LiveThreadsOAuthProvider(opts);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(OAuthProviderError);
        expect(inspect(e)).not.toContain(SECRET);
      }
    }
  });
});

describe('공급자 선택(준비 상태 행렬) — 실제 공급자는 모든 조건 + 실제 Threads 계정일 때만', () => {
  const FULL = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
  const ENV = { THREADS_APP_SECRET: SECRET, SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SECRETS_KEY_VERSION: '1' };
  const live = { kind: 'live', platform: 'threads' };
  it('모두 갖춤 → LiveThreadsOAuthProvider(외부 호출 없음), 시크릿은 직렬화에 없다', () => {
    const p = resolveOAuthProvider(live, loadConfig({ ...FULL }), ENV, REDIRECT);
    expect(p).toBeInstanceOf(LiveThreadsOAuthProvider);
    expect(p.mock).toBe(false);
    expect(JSON.stringify(p)).not.toContain(SECRET);
    expect(inspect(p, { depth: Infinity, showHidden: true })).not.toContain(SECRET);
  });
  const rows: Array<[string, Record<string, string | undefined>, Record<string, string | undefined>, string]> = [
    ['OAUTH_MODE=mock', { OAUTH_MODE: 'mock' }, {}, 'OAUTH_MODE=live'],
    ['앱 ID 없음', { THREADS_APP_ID: undefined }, {}, 'THREADS_APP_ID'],
    ['앱 시크릿 없음', {}, { THREADS_APP_SECRET: undefined }, 'THREADS_APP_SECRET'],
    ['앱 시크릿 공백', {}, { THREADS_APP_SECRET: '   ' }, 'THREADS_APP_SECRET'],
    ['redirect 없음', { OAUTH_REDIRECT_URI: undefined }, {}, 'OAUTH_REDIRECT_URI'],
    ['승인 기록 없음', { OAUTH_LIVE_APPROVAL_REF: undefined }, {}, 'OAUTH_LIVE_APPROVAL_REF'],
    ['마스터 키 없음', {}, { SECRETS_MASTER_KEY: undefined }, 'SECRETS_MASTER_KEY'],
  ];
  it.each(rows)('%s → LiveOAuthNotConfiguredError(이름만)', (_label, cfg, env, name) => {
    const config = loadConfig({ ...FULL, ...cfg } as Record<string, string | undefined>);
    try {
      resolveOAuthProvider(live, config, { ...ENV, ...env }, REDIRECT);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LiveOAuthNotConfiguredError);
      expect((e as LiveOAuthNotConfiguredError).missing).toContain(name);
      expect(inspect(e)).not.toContain(SECRET);
    }
  });
  it('등록 redirect 가 설정값과 다름 → OAUTH_REDIRECT_URI(불일치), 앱 ID 형식 → 형식 표식', () => {
    expect(() => resolveOAuthProvider(live, loadConfig({ ...FULL }), ENV, 'http://localhost:3001/api/oauth/callback')).toThrow(/OAUTH_REDIRECT_URI\(불일치\)/);
    expect(() => resolveOAuthProvider(live, loadConfig({ ...FULL, THREADS_APP_ID: 'not-numeric' }), ENV, REDIRECT)).toThrow(/형식/);
  });
  it('실제 계정이라도 Threads 밖 채널은 거부(LIVE_OAUTH_ADAPTER(<채널> 범위 밖)), 모의 계정은 OAUTH_MODE=live 여도 모의 공급자', () => {
    try {
      resolveOAuthProvider({ kind: 'live', platform: 'instagram' }, loadConfig({ ...FULL }), ENV, REDIRECT);
      expect.unreachable();
    } catch (e) {
      expect((e as LiveOAuthNotConfiguredError).missing).toEqual(['LIVE_OAUTH_ADAPTER(instagram 범위 밖)']);
    }
    expect(resolveOAuthProvider({ kind: 'mock', platform: 'threads' }, loadConfig({ ...FULL }), ENV, REDIRECT)).toBeInstanceOf(MockThreadsOAuthProvider);
    expect(() => resolveOAuthProvider({ kind: 'mock', platform: 'blog' }, loadConfig({ ...FULL }), ENV, REDIRECT)).toThrow(OAuthNotSupportedError);
  });
});

// FIX1-LIVET1(Codex review-LIVET1 P0 :104·Q2·놓친 케이스): 전송·상태가 본문 문구·코드보다 먼저 — 5xx 는 본문이 무엇이든 결과 불명(쓰기 단계)
describe('오류 분류 순서(FIX1-LIVET1 P0) — 상태 먼저, 4xx 안에서만 코드·문구', () => {
  const g = (message: string, code: number, extra: Record<string, unknown> = {}) => ({ error: { message, type: 'OAuthException', code, ...extra } });
  const t = (message: string, code: number) => ({ error_type: 'OAuthException', code, error_message: message });
  type Row = [string, Parameters<typeof mapThreadsError>, OAuthProviderErrorCode, Record<string, unknown>];
  const rows: Row[] = [
    // 5xx + 인증·시크릿·만료처럼 보이는 본문 → 모두 server_error, 쓰기 단계면 ambiguous
    ['503 + 코드 1 "validating client secret"(Codex 재현)', ['exchange', 503, g('Temporary error validating client secret', 1)], 'provider_error', { reason: 'server_error', ambiguous: true, httpStatus: 503, providerCode: 1 }],
    ['500 + 코드 101(invalid client_id)', ['exchange', 500, g('Invalid client_id', 101)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['502 + 코드 190/463(expired)', ['long_lived', 502, g('Session has expired', 190, { error_subcode: 463 })], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['504 + 코드 10(permission)', ['exchange', 504, g('Permission denied', 10)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['500 + 코드 400 "already used"', ['exchange', 500, t('Matching code was not found or was already used', 400)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['503 + redirect_uri 문구', ['exchange', 503, g('redirect_uri mismatch', 100)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['500 + 코드 4(rate limit)', ['refresh', 500, g('Application request limit reached', 4)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['500 + invalid token(읽기 단계 — ambiguous 아님)', ['account', 500, g('Invalid OAuth access token', 190)], 'provider_error', { reason: 'server_error', ambiguous: false }],
    // 408·2xx 오류 본문·4xx 비형식(쓰기 단계)
    ['408 + client secret 문구', ['exchange', 408, g('Error validating client secret', 1)], 'provider_error', { reason: 'timeout', ambiguous: true }],
    ['200 오류 본문(코드 101)', ['exchange', 200, g('Invalid client_id', 101)], 'provider_error', { reason: 'malformed_response', ambiguous: true }],
    ['200 오류 본문(읽기)', ['account', 200, g('x', 190)], 'provider_error', { reason: 'malformed_response', ambiguous: false }],
    ['exchange 401 비형식', ['exchange', 401, null], 'provider_error', { reason: 'http_error', ambiguous: true }],
    ['exchange 404 HTML', ['exchange', 404, null], 'provider_error', { reason: 'http_error', ambiguous: true }],
    ['long_lived 400 비형식', ['long_lived', 400, { foo: 1 }], 'provider_error', { reason: 'http_error', ambiguous: true }],
    // 4xx + 형식 맞는 본문: 코드가 문구보다 먼저
    ['400 + 코드 190, 문구에 client_id', ['account', 400, g('Invalid token for client_id 1', 190)], 'invalid_token', {}],
    ['400 + 코드 10, 문구에 client secret', ['exchange', 400, g('client secret permission', 10)], 'scope_not_allowed', {}],
    ['400 + 코드 4, 문구에 client secret', ['exchange', 400, g('client secret rate', 4)], 'provider_error', { reason: 'rate_limited' }],
    // 4xx 문구는 최후 수단
    ['400 + 코드 1 "Error validating client secret."', ['exchange', 400, g('Error validating client secret.', 1)], 'invalid_client', { providerCode: 1 }],
    ['400 + 코드 1 그 밖 문구', ['exchange', 400, g('An unknown error occurred', 1)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['400 + 코드 100 redirect_uri', ['exchange', 400, g('redirect_uri is not identical', 100)], 'redirect_mismatch', {}],
    // 코드 교환: 알려진 코드만 invalid_grant
    ['exchange 400 코드 400', ['exchange', 400, t('Matching code was not found or was already used', 400)], 'invalid_grant', {}],
    ['exchange 400 코드 100', ['exchange', 400, g('Invalid verification code format', 100)], 'invalid_grant', {}],
    ['exchange 400 문자열 invalid_grant', ['exchange', 400, { error: 'invalid_grant' }], 'invalid_grant', {}],
    ['exchange 401 형식 본문·모르는 코드', ['exchange', 401, g('x', 999)], 'provider_error', { reason: 'oauth_exception', ambiguous: false, httpStatus: 401, providerCode: 999 }],
    ['exchange 405 형식 본문·코드 없음', ['exchange', 405, { error_type: 'OAuthException', error_message: 'x' }], 'provider_error', { reason: 'oauth_exception', ambiguous: false, httpStatus: 405 }],
    ['exchange 404 형식 본문', ['exchange', 404, g('Unknown path', 803)], 'provider_error', { reason: 'oauth_exception', ambiguous: false }],
  ];
  it.each(rows)('%s', (_label, args, code, detail) => {
    const e = mapThreadsError(...args);
    expect(e.code).toBe(code);
    expect(e.detail).toMatchObject(detail);
    expect(JSON.stringify(e.detail)).not.toMatch(/secret|client_id|expired|already used/i);
  });
  it('공급자 경유: 코드 교환 503 + "validating client secret" → provider_error(ambiguous), 장기 교환 안 부름', async () => {
    const { fetch, seen } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(503, { error: { message: 'Temporary error validating client secret', type: 'OAuthException', code: 1 } }) });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('provider_error');
    expect(e.detail).toMatchObject({ reason: 'server_error', step: 'exchange', ambiguous: true });
    expect(e.detail.shortTokenIssued).toBeUndefined();
    expect(seen).toHaveLength(1);
  });
  it('공급자 경유: 단기 토큰 발급 뒤 장기 교환 4xx(확정 거절)여도 shortTokenIssued=true — "발급 없음"이 아니다', async () => {
    const { fetch } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: EXCHANGE_OK, [K('GET', THREADS_LONG_LIVED_URL)]: () => jsonRes(400, { error: { message: 'x', type: 'OAuthException', code: 190 } }) });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('invalid_token');
    expect(e.detail).toMatchObject({ step: 'long_lived', shortTokenIssued: true });
    expect(inspect(e, { depth: Infinity })).not.toContain(SHORT);
  });
});

// FIX1-LIVET1(Codex review-LIVET1 P1 :199): 실제 갱신은 D31 범위 밖 — 공급자 기본값은 외부 호출 없이 거부
describe('실제 갱신 차단(FIX1-LIVET1 P1) — 공급자 두 번째 방어선', () => {
  it('기본(resolveOAuthProvider 가 만드는 공급자 포함): refresh → LiveRefreshOutOfScopeError(409, LIVE_THREADS_REFRESH(D31 범위 밖)), fetch 0회', async () => {
    const { fetch } = fixtureFetch({ [K('GET', THREADS_REFRESH_URL)]: () => jsonRes(200, { access_token: LONG2, expires_in: 5184000 }) });
    for (const p of [
      provider(fetch),
      resolveOAuthProvider({ kind: 'live', platform: 'threads' }, loadConfig({ OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' }), { THREADS_APP_SECRET: SECRET, SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), SECRETS_KEY_VERSION: '1' }, REDIRECT, undefined, { fetch }),
    ]) {
      const e = await p.refresh({ tokens: { accessToken: LONG, refreshToken: null }, now: NOW }).catch((x) => x);
      expect(e).toBeInstanceOf(LiveRefreshOutOfScopeError);
      expect(e.code).toBe('live_refresh_out_of_scope');
      expect(e.kind).toBe('conflict');
      expect(e.message).toContain(LIVE_THREADS_REFRESH_MARKER);
      expect(inspect(e, { depth: Infinity })).not.toContain(LONG);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(LIVE_THREADS_REFRESH_MARKER).toBe('LIVE_THREADS_REFRESH(D31 범위 밖)');
  });
});

// FIX1-LIVET1(Codex review-LIVET1 P2 :401): 화면 준비 판정 === 실제 공급자 선택 성공(같은 검증 함수)
describe('준비 판정 ↔ 공급자 선택 일치 행렬(FIX1-LIVET1 P2)', () => {
  const KEY = Buffer.alloc(32, 7).toString('base64');
  const CFG = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' };
  const ENV = { THREADS_APP_SECRET: SECRET, SECRETS_MASTER_KEY: KEY, SECRETS_KEY_VERSION: '1' };
  type Case = [string, Record<string, string | undefined>, Record<string, string | undefined>, string, string[]];
  const cases: Case[] = [
    ['모두 갖춤', {}, {}, REDIRECT, []],
    ['시크릿 앞뒤 공백(뗀 값 사용)', {}, { THREADS_APP_SECRET: `  ${SECRET}  ` }, REDIRECT, []],
    ['OAUTH_MODE=mock', { OAUTH_MODE: 'mock' }, {}, REDIRECT, ['OAUTH_MODE=live']],
    ['앱 ID 없음', { THREADS_APP_ID: undefined }, {}, REDIRECT, ['THREADS_APP_ID']],
    ['앱 ID 숫자 아님(placeholder-app-id — Codex 재현)', { THREADS_APP_ID: 'placeholder-app-id' }, {}, REDIRECT, ['THREADS_APP_ID(형식)']],
    ['앱 ID 31자리', { THREADS_APP_ID: '1'.repeat(31) }, {}, REDIRECT, ['THREADS_APP_ID(형식)']],
    ['시크릿 없음', {}, { THREADS_APP_SECRET: undefined }, REDIRECT, ['THREADS_APP_SECRET']],
    ['시크릿 공백뿐', {}, { THREADS_APP_SECRET: '   ' }, REDIRECT, ['THREADS_APP_SECRET']],
    ['시크릿 중간 공백', {}, { THREADS_APP_SECRET: 'FAKE secret' }, REDIRECT, ['THREADS_APP_SECRET(형식)']],
    ['시크릿 513자', {}, { THREADS_APP_SECRET: 'x'.repeat(513) }, REDIRECT, ['THREADS_APP_SECRET(형식)']],
    ['redirect 없음', { OAUTH_REDIRECT_URI: undefined }, {}, REDIRECT, ['OAUTH_REDIRECT_URI']],
    ['등록 redirect 불일치', {}, {}, 'http://localhost:3001/api/oauth/callback', ['OAUTH_REDIRECT_URI(불일치)']],
    ['마스터 키 없음', {}, { SECRETS_MASTER_KEY: undefined }, REDIRECT, ['SECRETS_MASTER_KEY']],
    ['승인 기록 없음', { OAUTH_LIVE_APPROVAL_REF: undefined }, {}, REDIRECT, ['OAUTH_LIVE_APPROVAL_REF']],
    ['여러 개', { THREADS_APP_ID: 'abc', OAUTH_LIVE_APPROVAL_REF: undefined }, { THREADS_APP_SECRET: 'a b' }, REDIRECT, ['THREADS_APP_ID(형식)', 'THREADS_APP_SECRET(형식)', 'OAUTH_LIVE_APPROVAL_REF']],
  ];
  it.each(cases)('%s', (_label, cfg, env, registered, expected) => {
    const config = loadConfig({ ...CFG, ...cfg } as Record<string, string | undefined>);
    const fullEnv = { ...ENV, ...env };
    const readiness = liveOAuthReadinessFromEnv(config, fullEnv, registered);
    let resolved = false;
    let missing: string[] = [];
    try {
      resolveOAuthProvider({ kind: 'live', platform: 'threads' }, config, fullEnv, registered);
      resolved = true;
    } catch (e) {
      expect(e).toBeInstanceOf(LiveOAuthNotConfiguredError);
      missing = (e as LiveOAuthNotConfiguredError).missing;
    }
    expect(readiness.ready).toBe(resolved);
    expect(readiness.missing).toEqual(expected);
    expect(missing).toEqual(expected);
    expect(JSON.stringify(readiness)).not.toContain(SECRET);
  });
});

describe('네트워크 가드(setupFiles) — 실제 Threads·Meta 호스트로의 fetch 는 보내기 전에 거부된다', () => {
  it('주입하지 않은 실제 공급자 호출은 가드에 막히고(시도 기록), 기록을 비우면 파일은 통과한다', async () => {
    const g = globalThis as typeof globalThis & { __csMetaNetworkGuard?: { attempts: string[] } };
    expect(g.__csMetaNetworkGuard).toBeDefined();
    const p = new LiveThreadsOAuthProvider({ appId: APP_ID, appSecret: SECRET, registeredRedirectUri: REDIRECT });
    const e = await p.accountInfo({ accessToken: LONG, now: NOW }).catch((x) => x);
    expect(e).toBeInstanceOf(OAuthProviderError);
    expect(e.detail.reason).toBe('network');
    expect(g.__csMetaNetworkGuard!.attempts).toEqual(['graph.threads.net']);
    await expect(fetch('https://www.facebook.com/')).rejects.toThrow(/BLOCKED_EXTERNAL_NETWORK/);
    await expect(fetch(new URL('https://threads.com/oauth/authorize'))).rejects.toThrow(/BLOCKED_EXTERNAL_NETWORK/);
    expect(g.__csMetaNetworkGuard!.attempts).toHaveLength(3);
    // 의도한 시도였으므로 비운다(비우지 않으면 setupFiles 의 afterAll 이 이 파일을 실패시킨다)
    g.__csMetaNetworkGuard!.attempts.length = 0;
  });
});
