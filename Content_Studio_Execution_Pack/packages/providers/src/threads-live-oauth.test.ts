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
  normalizeThreadsErrorBody,
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
  it('앱 시크릿 거부(코드 101) → invalid_client(메시지 원문은 결과에 없다)', async () => {
    const { fetch } = fixtureFetch({
      [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(400, { error: { message: 'Error validating client secret.', type: 'OAuthException', code: 101, fbtrace_id: 'FAKE' } }),
    });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('invalid_client');
    expect(JSON.stringify(e.detail)).not.toContain('validating');
    expect(e.message).toBe('oauth provider error: invalid_client');
  });
  it('FIX2-LIVET1(P0): 400 + 일시 코드 1·2 + 시크릿·redirect 문구 → invalid_client·redirect_mismatch 가 아니라 결과 불명(ambiguous)', async () => {
    for (const [message, code] of [['Error validating client secret.', 1], ['Temporary error validating client secret', 2], ['redirect_uri is not identical', 1], ['redirect_uri mismatch', 2]] as const) {
      const { fetch, seen } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(400, { error: { message, type: 'OAuthException', code } }) });
      const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
      expect(e.code, message).toBe('provider_error');
      expect(e.detail).toEqual({ reason: 'server_error', step: 'exchange', httpStatus: 400, providerCode: code, ambiguous: true });
      expect(seen).toHaveLength(1);
    }
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
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 341 } }], 'provider_error', { reason: 'rate_limited' }],
    [['account', 400, { error: { message: 'x', type: 'OAuthException', code: 80014 } }], 'provider_error', { reason: 'rate_limited' }],
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
    // FIX2-LIVET1(Codex review-FIX-LIVET1 P0 :138): 일시 코드는 문구보다 먼저 — 문구가 일시 코드를 확정 실패로 바꾸지 않는다
    ['400 + 코드 1 "Error validating client secret."(FIX2 재현)', ['exchange', 400, g('Error validating client secret.', 1)], 'provider_error', { reason: 'server_error', ambiguous: true, providerCode: 1 }],
    ['400 + 코드 2 "Temporary error validating client secret"(Codex 재현)', ['exchange', 400, g('Temporary error validating client secret', 2)], 'provider_error', { reason: 'server_error', ambiguous: true, providerCode: 2 }],
    ['400 + 코드 1 redirect_uri 문구', ['exchange', 400, g('redirect_uri is not identical', 1)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['400 + 코드 2 invalid client_id 문구(장기 교환)', ['long_lived', 400, g('Invalid client_id', 2)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['403 + 코드 4 + 시크릿 문구 → 제한', ['exchange', 403, g('Error validating client secret', 4)], 'provider_error', { reason: 'rate_limited' }],
    ['400 + 코드 341 + redirect_uri 문구 → 제한', ['exchange', 400, g('redirect_uri', 341)], 'provider_error', { reason: 'rate_limited' }],
    ['400 + 코드 80002(BUC) + client_id 문구 → 제한', ['exchange', 400, g('Invalid client_id', 80002)], 'provider_error', { reason: 'rate_limited' }],
    ['400 + 모르는 코드 + is_transient=true + 시크릿 문구', ['exchange', 400, g('Error validating client secret', 999, { is_transient: true })], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['400 + 코드 190 + is_transient=true(일시가 이긴다)', ['refresh', 400, g('Invalid OAuth access token', 190, { is_transient: true })], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['400 + 문자열 코드 "1" + 시크릿 문구', ['exchange', 400, { error_type: 'OAuthException', code: '1', error_message: 'Error validating client secret' }], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['400 + 코드 2 (읽기 단계 — ambiguous 아님)', ['account', 400, g('Error validating client secret', 2)], 'provider_error', { reason: 'server_error', ambiguous: false }],
    // 문구는 코드·하위 코드가 모두 없을 때만(또는 확정 범용 코드 100 을 더 구체적인 확정으로 좁힐 때만)
    // FIX3-LIVET1(Codex review-FIX2-LIVET1 P0 :212): 아래 두 줄은 FIX2 까지 invalid_client·redirect_mismatch 를 기대했다(버그를 담은 기대) —
    // 문구만으로는 확정하지 않으므로 더 엄격한 결과(결과 불명)로 뒤집었다. 식별자 OAuthException 은 확정 식별자가 아니다.
    ['400 + 코드 없음 + OAuthException + 시크릿 문구 → 결과 불명(FIX3 뒤집음)', ['exchange', 400, { error_type: 'OAuthException', error_message: 'Error validating client secret' }], 'provider_error', { reason: 'oauth_exception', ambiguous: true }],
    ['400 + 코드 없음 + OAuthException + redirect_uri 문구 → 결과 불명(FIX3 뒤집음)', ['exchange', 400, { error_type: 'OAuthException', error_message: 'redirect_uri is not identical' }], 'provider_error', { reason: 'oauth_exception', ambiguous: true }],
    ['400 + 하위 코드만 + 시크릿 문구 → 문구 안 봄(결과 불명)', ['exchange', 400, { error: { message: 'Error validating client secret', type: 'OAuthException', error_subcode: 1349 } }], 'provider_error', { reason: 'oauth_exception', ambiguous: true, providerSubcode: 1349 }],
    ['400 + 모르는 코드 + 시크릿 문구 → 문구 안 봄(결과 불명)', ['exchange', 400, g('Error validating client secret', 999)], 'provider_error', { reason: 'oauth_exception', ambiguous: true, providerCode: 999 }],
    ['400 + 코드 100 + 시크릿 문구 → invalid_client(확정 범용 코드만 좁힘)', ['exchange', 400, g('Error validating client secret', 100)], 'invalid_client', {}],
    ['400 + 코드 1 그 밖 문구', ['exchange', 400, g('An unknown error occurred', 1)], 'provider_error', { reason: 'server_error', ambiguous: true }],
    ['400 + 코드 100 redirect_uri', ['exchange', 400, g('redirect_uri is not identical', 100)], 'redirect_mismatch', {}],
    // 코드 교환: 알려진 코드만 invalid_grant
    ['exchange 400 코드 400', ['exchange', 400, t('Matching code was not found or was already used', 400)], 'invalid_grant', {}],
    ['exchange 400 코드 100', ['exchange', 400, g('Invalid verification code format', 100)], 'invalid_grant', {}],
    ['exchange 400 문자열 invalid_grant', ['exchange', 400, { error: 'invalid_grant' }], 'invalid_grant', {}],
    // FIX2-LIVET1(Codex review-FIX-LIVET1 Q7): 확정 거절로 검증된 코드만 확정 — 모르는 코드·분류 안 되는 본문은 쓰기 단계면 결과 불명
    ['exchange 401 형식 본문·모르는 코드', ['exchange', 401, g('x', 999)], 'provider_error', { reason: 'oauth_exception', ambiguous: true, httpStatus: 401, providerCode: 999 }],
    ['exchange 405 형식 본문·코드 없음', ['exchange', 405, { error_type: 'OAuthException', error_message: 'x' }], 'provider_error', { reason: 'oauth_exception', ambiguous: true, httpStatus: 405 }],
    ['exchange 404 형식 본문', ['exchange', 404, g('Unknown path', 803)], 'provider_error', { reason: 'oauth_exception', ambiguous: true }],
    ['long_lived 400 모르는 코드', ['long_lived', 400, g('x', 999)], 'provider_error', { reason: 'oauth_exception', ambiguous: true }],
    ['refresh 400 코드 100(24시간 안 갱신 — 확정)', ['refresh', 400, g('Token too new', 100)], 'invalid_request', {}],
    ['account 400 모르는 코드(읽기 — 확정 거절)', ['account', 400, g('x', 999)], 'invalid_request', {}],
    ['account 401 모르는 코드(읽기)', ['account', 401, g('x', 999)], 'invalid_token', {}],
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

// FIX3-LIVET1(Codex review-FIX2-LIVET1 P0 :212·놓친 케이스): 숫자 코드 없는 문자열 오류 식별자는 문구보다 먼저 — 문구는 확정 결과만 좁힌다
describe('문자열 오류 식별자 우선(FIX3-LIVET1 P0)', () => {
  const o = (error: string, error_description?: string) => ({ error, ...(error_description !== undefined ? { error_description } : {}) });
  const SECRET_MSG = 'Temporary error validating client secret.';
  const REDIRECT_MSG = 'Please retry. redirect_uri could not be verified';
  type Row = [string, Parameters<typeof mapThreadsError>, OAuthProviderErrorCode, Record<string, unknown>];
  const UNKNOWN_W = { reason: 'oauth_exception', ambiguous: true };
  const SERVER_W = { reason: 'server_error', ambiguous: true };
  const rows: Row[] = [
    // Codex 재현 입력 그대로
    ['Codex 재현: temporarily_unavailable + "Temporary error validating client secret."', ['exchange', 400, o('temporarily_unavailable', SECRET_MSG)], 'provider_error', SERVER_W],
    ['Codex 재현: server_error + redirect_uri 문구', ['exchange', 400, o('server_error', REDIRECT_MSG)], 'provider_error', SERVER_W],
    ['slow_down + 시크릿 문구 → 제한(쓰기 단계 결과 불명)', ['exchange', 400, o('slow_down', SECRET_MSG), { retryAfter: '5' }], 'provider_error', { reason: 'rate_limited', ambiguous: true, retryAfterSec: 5 }],
    ['대문자·공백 " Temporarily_Unavailable " → 일시', ['long_lived', 400, o(' Temporarily_Unavailable ', 'Invalid client_id')], 'provider_error', SERVER_W],
    ['Graph 형식 type=temporarily_unavailable(코드 없음) + 시크릿 문구', ['exchange', 400, { error: { message: SECRET_MSG, type: 'temporarily_unavailable' } }], 'provider_error', SERVER_W],
    ['Threads 형식 error_type=server_error + redirect_uri 문구', ['exchange', 400, { error_type: 'server_error', error_message: REDIRECT_MSG }], 'provider_error', SERVER_W],
    ['일시 식별자 + 확정 코드 190 → 일시가 이긴다', ['refresh', 400, { error: { message: 'x', type: 'temporarily_unavailable', code: 190 } }], 'provider_error', SERVER_W],
    ['읽기 단계 server_error → server_error, ambiguous 아님', ['account', 400, o('server_error', SECRET_MSG)], 'provider_error', { reason: 'server_error', ambiguous: false }],
    ['읽기 단계 slow_down → rate_limited, ambiguous 없음', ['account', 400, o('slow_down')], 'provider_error', { reason: 'rate_limited' }],
    // 모르는 식별자 → 문구로 확정하지 않는다
    ['모르는 식별자 + 시크릿 문구 → 결과 불명', ['exchange', 400, o('some_new_error', 'Error validating client secret')], 'provider_error', UNKNOWN_W],
    ['모르는 식별자 + redirect_uri 문구 → 결과 불명', ['exchange', 400, o('weird', 'redirect_uri mismatch')], 'provider_error', UNKNOWN_W],
    ['OAuthException(코드 없음) + 시크릿 문구(장기 교환) → 결과 불명', ['long_lived', 400, { error: { message: 'Error validating client secret', type: 'OAuthException' } }], 'provider_error', UNKNOWN_W],
    ['식별자 없음 + 문구만(Graph) → 결과 불명', ['exchange', 400, { error: { message: 'Error validating client secret' } }], 'provider_error', UNKNOWN_W],
    ['빈 문자열 식별자 + 시크릿 문구 → 결과 불명', ['exchange', 400, o('', 'Error validating client secret')], 'provider_error', UNKNOWN_W],
    ['읽기 단계 모르는 식별자 + 시크릿 문구 → invalid_request(문구로 invalid_client 안 함)', ['account', 400, o('weird', 'Error validating client secret')], 'invalid_request', {}],
    // 확정 식별자 → 확정(범용만 문구로 좁힘)
    ['invalid_grant(교환)', ['exchange', 400, o('invalid_grant', 'code already used')], 'invalid_grant', {}],
    ['invalid_grant + redirect_uri 문구(교환) → redirect_mismatch', ['exchange', 400, o('invalid_grant', 'redirect_uri does not match')], 'redirect_mismatch', {}],
    ['invalid_grant(갱신) → invalid_token', ['refresh', 400, o('invalid_grant')], 'invalid_token', {}],
    ['invalid_request + redirect_uri 문구(교환) → redirect_mismatch', ['exchange', 400, o('invalid_request', 'Invalid redirect_uri')], 'redirect_mismatch', {}],
    ['invalid_request + 시크릿 문구 → invalid_client', ['exchange', 400, o('invalid_request', 'Missing client_secret')], 'invalid_client', {}],
    ['invalid_request 문구 없음 → invalid_request', ['long_lived', 400, o('invalid_request')], 'invalid_request', {}],
    ['invalid_client', ['exchange', 401, o('invalid_client', 'redirect_uri ok')], 'invalid_client', {}],
    ['unauthorized_client', ['exchange', 400, o('unauthorized_client')], 'invalid_client', {}],
    ['unsupported_grant_type + redirect_uri 문구 → invalid_request(좁히지 않음)', ['exchange', 400, o('unsupported_grant_type', 'redirect_uri')], 'invalid_request', {}],
    ['invalid_scope', ['exchange', 400, o('invalid_scope')], 'scope_not_allowed', {}],
    ['access_denied', ['exchange', 400, o('access_denied')], 'scope_not_allowed', {}],
    ['invalid_token(읽기)', ['account', 401, o('invalid_token', 'client secret')], 'invalid_token', {}],
    ['redirect_uri_mismatch(교환)', ['exchange', 400, o('redirect_uri_mismatch')], 'redirect_mismatch', {}],
    // 하위 코드만 있으면 확정 식별자여도 확정하지 않는다
    ['invalid_grant + 하위 코드만 → 결과 불명', ['exchange', 400, { error: { message: 'x', type: 'invalid_grant', error_subcode: 1349 } }], 'provider_error', UNKNOWN_W],
    // 형식 깨진 코드 → "코드 없음"이 아니라 알 수 없음
    ['코드 "1.0" + invalid_client 식별자 → 결과 불명', ['exchange', 400, { error_type: 'invalid_client', code: '1.0', error_message: 'Error validating client secret' }], 'provider_error', UNKNOWN_W],
    ['코드 "abc" + OAuthException + redirect 문구 → 결과 불명', ['exchange', 400, { error: { message: 'redirect_uri', type: 'OAuthException', code: 'abc' } }], 'provider_error', UNKNOWN_W],
    ['코드 200.5(소수) → scope_not_allowed 아님, 결과 불명', ['exchange', 400, { error: { message: 'x', type: 'OAuthException', code: 200.5 } }], 'provider_error', UNKNOWN_W],
    ['코드 -1 → 결과 불명', ['exchange', 400, { error: { message: 'x', type: 'OAuthException', code: -1 } }], 'provider_error', UNKNOWN_W],
    ['하위 코드 "x" + 확정 코드 190 → 결과 불명', ['long_lived', 400, { error: { message: 'x', type: 'OAuthException', code: 190, error_subcode: 'x' } }], 'provider_error', UNKNOWN_W],
    ['형식 깨진 코드 + is_transient=true → 일시', ['exchange', 400, { error: { message: 'x', type: 'OAuthException', code: '1e3', is_transient: true } }], 'provider_error', SERVER_W],
    // FIX3(Q10): 숫자 제한 코드도 쓰기 단계면 결과 불명
    ['코드 341(쓰기) → rate_limited + ambiguous', ['exchange', 400, { error: { message: 'x', type: 'OAuthException', code: 341 } }], 'provider_error', { reason: 'rate_limited', ambiguous: true }],
  ];
  it.each(rows)('%s', (_label, args, code, detail) => {
    const e = mapThreadsError(...args);
    expect(e.code).toBe(code);
    expect(e.detail).toMatchObject(detail);
    if (!('ambiguous' in detail) && args[0] !== 'account' && code === 'provider_error') expect(e.detail?.ambiguous).toBeUndefined();
    expect(JSON.stringify(e.detail)).not.toMatch(/secret|client_id|redirect_uri|temporarily|slow_down|verified/i);
  });
  it('일시 식별자 × 문구 표 — 어떤 문구든 쓰기 단계 3곳 모두 확정 거절이 되지 않는다', () => {
    const ids = ['temporarily_unavailable', 'server_error', 'service_unavailable', 'internal_error', 'internal_server_error', 'timeout', 'request_timeout', 'slow_down', 'rate_limited', 'rate_limit_exceeded', 'too_many_requests'];
    const msgs = ['', SECRET_MSG, REDIRECT_MSG, 'Invalid client_id', 'Invalid OAuth access token', 'Matching code was not found or was already used', 'invalid_grant'];
    for (const step of ['exchange', 'long_lived', 'refresh'] as const) {
      for (const id of ids) {
        for (const m of msgs) {
          for (const body of [o(id, m), { error: { message: m, type: id } }, { error_type: id, error_message: m }]) {
            const e = mapThreadsError(step, 400, body);
            expect(e.code, `${step} ${id} "${m}"`).toBe('provider_error');
            expect(e.detail?.ambiguous, `${step} ${id} "${m}"`).toBe(true);
            expect(['server_error', 'rate_limited']).toContain(e.detail?.reason);
          }
        }
      }
    }
  });
  it('공급자 경유: 코드 교환 400 { error: temporarily_unavailable, error_description: 시크릿 문구 } → ambiguous, 장기 교환 안 부름', async () => {
    const { fetch, seen } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: () => jsonRes(400, o('temporarily_unavailable', SECRET_MSG)) });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('provider_error');
    expect(e.detail).toMatchObject({ reason: 'server_error', step: 'exchange', ambiguous: true, httpStatus: 400 });
    expect(seen).toHaveLength(1);
  });
});

// FIX4-LIVET1(Codex review-FIX3-LIVET1 P0 :89 — 구조적): 하나의 정규화 + 하나의 우선순위. 어떤 본문 형태든 신호를 버리지 않는다.
describe('정규화 일원화(FIX4-LIVET1 P0)', () => {
  type Row = [string, Parameters<typeof mapThreadsError>, OAuthProviderErrorCode, Record<string, unknown>];
  const UNKNOWN_W = { reason: 'oauth_exception', ambiguous: true };
  const SERVER_W = { reason: 'server_error', ambiguous: true };
  const SECRET_MSG = 'Error validating client secret';
  const rows: Row[] = [
    // Codex 재현 입력 그대로
    ['Codex 재현: { error: invalid_client, code: 2, is_transient: true } → 결과 불명(일시)', ['exchange', 400, { error: 'invalid_client', code: 2, is_transient: true }], 'provider_error', { ...SERVER_W, providerCode: 2 }],
    ['Codex 재현: { error: invalid_client, code: "abc" } → 결과 불명(형식 깨진 코드)', ['exchange', 400, { error: 'invalid_client', code: 'abc' }], 'provider_error', UNKNOWN_W],
    // 문자열 error + 다른 신호 하나씩
    ['문자열 error + is_transient=true 만', ['long_lived', 400, { error: 'invalid_client', is_transient: true }], 'provider_error', SERVER_W],
    ['문자열 error + 숫자 일시 코드 1(문자열 "1")', ['refresh', 400, { error: 'invalid_grant', code: '1' }], 'provider_error', SERVER_W],
    ['문자열 error + 제한 코드 4 → rate_limited(쓰기 단계 결과 불명)', ['exchange', 400, { error: 'invalid_grant', code: 4 }, { retryAfter: '7' }], 'provider_error', { reason: 'rate_limited', ambiguous: true, retryAfterSec: 7 }],
    ['문자열 error + 형식 깨진 error_subcode', ['exchange', 400, { error: 'invalid_client', error_subcode: 'x' }], 'provider_error', UNKNOWN_W],
    ['문자열 error + 하위 코드만(정수)', ['exchange', 400, { error: 'invalid_client', error_subcode: 1349 }], 'provider_error', { ...UNKNOWN_W, providerSubcode: 1349 }],
    ['문자열 error + is_transient="true"(불리언 아님) → 형식 깨짐', ['exchange', 400, { error: 'invalid_client', is_transient: 'true' }], 'provider_error', UNKNOWN_W],
    ['문자열 error + 모르는 숫자 코드', ['exchange', 400, { error: 'invalid_client', code: 999 }], 'provider_error', { ...UNKNOWN_W, providerCode: 999 }],
    ['문자열 error + 일치하는 확정 코드 101 → invalid_client', ['exchange', 400, { error: 'invalid_client', code: 101 }], 'invalid_client', { providerCode: 101 }],
    ['문자열 error + is_transient=false + 확정 → 확정(false 는 막지 않음)', ['exchange', 400, { error: 'invalid_client', is_transient: false }], 'invalid_client', {}],
    // error · error_type · error_message 가 서로 다른 분류(놓친 케이스)
    ['error=invalid_client + error_type=invalid_scope → 충돌, 결과 불명', ['exchange', 400, { error: 'invalid_client', error_type: 'invalid_scope', error_message: SECRET_MSG }], 'provider_error', UNKNOWN_W],
    ['error=invalid_grant + error_type=server_error → 일시', ['exchange', 400, { error: 'invalid_grant', error_type: 'server_error', error_message: 'code already used' }], 'provider_error', SERVER_W],
    ['error=invalid_client + error_type=모르는 식별자 → 결과 불명', ['exchange', 400, { error: 'invalid_client', error_type: 'brand_new_error' }], 'provider_error', UNKNOWN_W],
    ['error=invalid_client + error_type=OAuthException(범용 이름) → invalid_client', ['exchange', 400, { error: 'invalid_client', error_type: 'OAuthException' }], 'invalid_client', {}],
    ['확정 코드 101 + 확정 식별자 invalid_scope → 충돌, 결과 불명', ['exchange', 400, { error: { type: 'invalid_scope', code: 101, message: 'x' } }], 'provider_error', UNKNOWN_W],
    ['코드 100(교환 invalid_grant) + invalid_request 식별자 → 충돌, 결과 불명', ['exchange', 400, { error: 'invalid_request', code: 100 }], 'provider_error', UNKNOWN_W],
    ['코드 100 + invalid_request(교환 밖, 범용끼리 일치) + 시크릿 문구 → invalid_client(좁힘)', ['long_lived', 400, { error: 'invalid_request', code: 100, error_description: SECRET_MSG }], 'invalid_client', {}],
    ['범용 invalid_request + 서로 다른 쪽으로 좁히는 문구 둘 → 좁히지 않음', ['exchange', 400, { error: 'invalid_request', error_description: SECRET_MSG, error_message: 'redirect_uri mismatch' }], 'invalid_request', {}],
    // 최상위 + 중첩 error 객체 혼합(두 자리 모두 읽는다)
    ['중첩 error{ code: 101 } + 최상위 is_transient=true → 일시', ['exchange', 400, { error: { message: 'x', type: 'OAuthException', code: 101 }, is_transient: true }], 'provider_error', SERVER_W],
    ['중첩 error{ code: 101 } + 최상위 code 2 → 일시', ['exchange', 400, { error: { message: 'x', code: 101 }, code: 2 }], 'provider_error', SERVER_W],
    ['중첩 error{ code: 190 } + 최상위 code "abc" → 형식 깨짐', ['long_lived', 400, { error: { message: 'x', code: 190 }, code: 'abc' }], 'provider_error', UNKNOWN_W],
    ['중첩 error{ code: 101 } + 최상위 code 190 → 충돌, 결과 불명(providerCode 없음)', ['exchange', 400, { error: { message: 'x', code: 101 }, code: 190 }], 'provider_error', UNKNOWN_W],
    ['중첩 error{ type: invalid_client } + 최상위 error_type=temporarily_unavailable → 일시', ['exchange', 400, { error: { type: 'invalid_client' }, error_type: 'temporarily_unavailable' }], 'provider_error', SERVER_W],
    ['중첩 error.error 문자열 + 중첩 error_code 일시 2', ['exchange', 400, { error: { error: 'invalid_client', error_code: 2 } }], 'provider_error', SERVER_W],
    ['error 가 숫자(문자열·객체 아님) → 형식 깨짐', ['exchange', 400, { error: 5 }], 'provider_error', UNKNOWN_W],
    ['error_type 이 숫자 → 형식 깨짐', ['exchange', 400, { error_type: 7, code: 101 }], 'provider_error', UNKNOWN_W],
    ['최상위 code 만(2) — 인식되는 본문, 일시', ['exchange', 400, { code: 2 }], 'provider_error', SERVER_W],
    ['중첩 error_user_msg 만 시크릿 문구 + 코드 100 → invalid_client(중첩 문구도 읽음)', ['long_lived', 400, { error: { code: 100, error_user_msg: SECRET_MSG } }], 'invalid_client', {}],
    // HTTP 429 × 본문(놓친 케이스·Codex Q13): 쓰기 단계는 결과 불명, 읽기 단계는 ambiguous 없음
    ['exchange 429 + server_error 본문 → rate_limited + ambiguous', ['exchange', 429, { error: 'server_error' }, '12'], 'provider_error', { reason: 'rate_limited', ambiguous: true, retryAfterSec: 12 }],
    ['long_lived 429 + is_transient 본문 → rate_limited + ambiguous', ['long_lived', 429, { error: { code: 2, is_transient: true } }], 'provider_error', { reason: 'rate_limited', ambiguous: true }],
    ['refresh 429 + 확정 invalid_client 본문 → 상태가 이긴다, ambiguous', ['refresh', 429, { error: 'invalid_client' }], 'provider_error', { reason: 'rate_limited', ambiguous: true }],
    ['account 429 → rate_limited, ambiguous 없음', ['account', 429, { error: 'server_error' }], 'provider_error', { reason: 'rate_limited' }],
  ];
  it.each(rows)('%s', (_label, args, code, detail) => {
    const e = mapThreadsError(...args);
    expect(e.code).toBe(code);
    expect(e.detail).toMatchObject(detail);
    if (code !== 'provider_error') expect(e.detail?.ambiguous).toBeUndefined();
    if (args[0] === 'account') expect(e.detail?.ambiguous).not.toBe(true);
    // 충돌·형식 깨진 코드에는 대표 코드를 지어내지 않는다
    const n = normalizeThreadsErrorBody(args[2]);
    if (n && n.codes.length !== 1) expect(e.detail?.providerCode).toBeUndefined();
    expect(JSON.stringify(e.detail)).not.toMatch(/secret|client_id|redirect_uri|temporarily|invalid_client|invalid_scope|brand_new/i);
  });

  it('정규화: 모든 자리·모든 필드를 합친다(한 형태가 있다고 다른 신호를 버리지 않음)', () => {
    expect(normalizeThreadsErrorBody({ error: 'invalid_client', code: 2, is_transient: true, error_description: 'd' })).toEqual({
      identifiers: ['invalid_client'], codes: [2], numericCode: 2, subcodes: [], subcode: null, malformedCode: false, isTransientFlag: true, messages: ['d'],
    });
    expect(normalizeThreadsErrorBody({ error: { message: 'm', type: 'OAuthException', code: 190, error_subcode: '463', is_transient: false, error_user_msg: 'u' }, error_type: ' Server_Error ', code: 'abc', error_message: 't' })).toEqual({
      identifiers: ['server_error', 'oauthexception'], codes: [190], numericCode: 190, subcodes: [463], subcode: 463, malformedCode: true, isTransientFlag: false, messages: ['t', 'm', 'u'],
    });
    expect(normalizeThreadsErrorBody({ foo: 1 })).toBeNull();
    expect(normalizeThreadsErrorBody({ type: 'x', message: 'y' })).toBeNull();
    expect(normalizeThreadsErrorBody([{ error: 'x' }])).toBeNull();
    expect(normalizeThreadsErrorBody({ error: null, code: null })).toBeNull();
  });

  /**
   * 생성 조합 행렬 — 본문 형태 5(평면·중첩 객체·OAuth2 문자열·혼합 2종) × 신호 부분집합(12 신호 → 4095) × 단계 4.
   * 불변식: 쓰기 단계에서 일시·형식 깨짐·모르는 신호가 하나라도 있으면 ambiguous=true. 확정은 있는 모든 확정 신호가 한 결과로 일치할 때만.
   * 기대값은 구현과 독립된 단순 판정(oracle)으로 계산한다.
   */
  describe('생성 조합 행렬 — 형태 × 신호', () => {
    type Kind = 'code' | 'id' | 'flag' | 'sub' | 'msg';
    type Cls = 'transient' | 'malformed' | 'unknown' | 'neutral' | 'msg' | { definite: OAuthProviderErrorCode };
    interface Sig {
      name: string;
      kind: Kind;
      value: unknown;
      cls: Cls;
    }
    const SIGNALS: Sig[] = [
      { name: 'T_CODE', kind: 'code', value: 2, cls: 'transient' },
      { name: 'T_ID', kind: 'id', value: 'temporarily_unavailable', cls: 'transient' },
      { name: 'T_FLAG', kind: 'flag', value: true, cls: 'transient' },
      { name: 'F_FLAG', kind: 'flag', value: false, cls: 'neutral' },
      { name: 'MAL_CODE', kind: 'code', value: 'abc', cls: 'malformed' },
      { name: 'MAL_SUB', kind: 'sub', value: '1.5', cls: 'malformed' },
      { name: 'DEF_CODE', kind: 'code', value: 101, cls: { definite: 'invalid_client' } },
      { name: 'DEF_ID', kind: 'id', value: 'invalid_client', cls: { definite: 'invalid_client' } },
      { name: 'DEF_ID_OTHER', kind: 'id', value: 'invalid_scope', cls: { definite: 'scope_not_allowed' } },
      { name: 'UNK_CODE', kind: 'code', value: 999, cls: 'unknown' },
      { name: 'UNK_ID', kind: 'id', value: 'brand_new_error', cls: 'unknown' },
      { name: 'MSG', kind: 'msg', value: 'Temporary error validating client secret; redirect_uri', cls: 'msg' },
    ];
    type Loc = 'top' | 'nested';
    type Shape = 'flat' | 'nested' | 'oauth2' | 'mixed_a' | 'mixed_b';
    const KEYS: Record<Loc, Record<Kind, string[]>> = {
      top: { code: ['code', 'error_code'], id: ['error_type', 'type'], flag: ['is_transient'], sub: ['error_subcode'], msg: ['error_message', 'message'] },
      nested: { code: ['code', 'error_code'], id: ['type', 'error_type'], flag: ['is_transient'], sub: ['error_subcode'], msg: ['message', 'error_user_msg'] },
    };
    /** 신호를 형태에 맞는 자리에 놓는다. 자리가 모자라면 null(그 조합은 그 형태로 만들 수 없음). */
    function build(shape: Shape, sigs: Sig[]): Record<string, unknown> | null {
      const top: Record<string, unknown> = {};
      const nested: Record<string, unknown> = {};
      for (const [i, s] of sigs.entries()) {
        const order: Loc[] =
          shape === 'flat' || shape === 'oauth2' ? ['top'] : shape === 'nested' ? ['nested'] : (i % 2 === 0) === (shape === 'mixed_a') ? ['top', 'nested'] : ['nested', 'top'];
        let placed = false;
        for (const loc of order) {
          const target = loc === 'top' ? top : nested;
          const keys =
            shape === 'oauth2' && s.kind === 'id' ? ['error', ...KEYS.top.id] : shape === 'oauth2' && s.kind === 'msg' ? ['error_description', ...KEYS.top.msg] : KEYS[loc][s.kind];
          const k = keys.find((key) => !(key in target));
          if (k) {
            target[k] = s.value;
            placed = true;
            break;
          }
        }
        if (!placed) return null;
      }
      // OAuth2 형태는 문자열 error 가 있어야 한다 — 식별자 신호가 없으면 범용 이름을 넣는다
      if (shape === 'oauth2' && !('error' in top)) top.error = 'OAuthException';
      if (shape === 'nested' || ((shape === 'mixed_a' || shape === 'mixed_b') && Object.keys(nested).length)) top.error = nested;
      // 인식 근거가 없는 최상위(type·message 만)면 이 행렬의 대상이 아니다
      if (!['error', 'error_type', 'error_message', 'error_code', 'error_subcode', 'is_transient', 'code', 'error_description'].some((k) => k in top)) return null;
      return top;
    }
    type Expect = { kind: 'transient' } | { kind: 'unknown' } | { kind: 'definite'; code: OAuthProviderErrorCode };
    function oracle(sigs: Sig[]): Expect {
      if (sigs.some((s) => s.cls === 'transient')) return { kind: 'transient' };
      if (sigs.some((s) => s.cls === 'malformed' || s.cls === 'unknown')) return { kind: 'unknown' };
      const defs = new Set(sigs.flatMap((s) => (typeof s.cls === 'object' ? [s.cls.definite] : [])));
      if (defs.size !== 1) return { kind: 'unknown' }; // 확정 신호 없음 또는 불일치
      return { kind: 'definite', code: [...defs][0]! };
    }
    it('모든 조합에서 불변식을 지킨다', () => {
      const shapes: Shape[] = ['flat', 'nested', 'oauth2', 'mixed_a', 'mixed_b'];
      const steps = ['exchange', 'long_lived', 'refresh', 'account'] as const;
      let checked = 0;
      let definiteSeen = 0;
      let ambiguousSeen = 0;
      const failures: string[] = [];
      const perShape = new Map<Shape, number>();
      for (let mask = 1; mask < 1 << SIGNALS.length; mask++) {
        const sigs = SIGNALS.filter((_, i) => mask & (1 << i));
        const exp = oracle(sigs);
        for (const shape of shapes) {
          const body = build(shape, sigs);
          if (!body) continue;
          perShape.set(shape, (perShape.get(shape) ?? 0) + 1);
          for (const step of steps) {
            const e = mapThreadsError(step, 400, body);
            const write = step !== 'account';
            const d = e.detail;
            checked++;
            let ok: boolean;
            if (exp.kind === 'definite') {
              definiteSeen++;
              ok = e.code === exp.code && d?.ambiguous === undefined;
            } else if (exp.kind === 'transient') {
              ok = e.code === 'provider_error' && d?.reason === 'server_error' && d?.ambiguous === write;
            } else if (write) {
              ok = e.code === 'provider_error' && d?.reason === 'oauth_exception' && d?.ambiguous === true;
            } else {
              ok = e.code === 'invalid_request';
            }
            // 불변식 자체(위 기대와 별도로 한 번 더): 쓰기 단계 + 일시·형식 깨짐·모르는·불일치 신호 → ambiguous=true
            if (write && exp.kind !== 'definite') {
              ambiguousSeen++;
              if (d?.ambiguous !== true) ok = false;
            }
            if (!ok && failures.length < 20) failures.push(`${step} ${shape} [${sigs.map((x) => x.name).join(',')}] ${JSON.stringify(body)} → ${e.code} ${JSON.stringify(d)}`);
          }
        }
      }
      expect(failures).toEqual([]);
      // 행렬이 실제로 넓게 돌았는지(형태마다 수백 조합, 확정·결과 불명 양쪽 모두)
      for (const shape of shapes) expect(perShape.get(shape) ?? 0, shape).toBeGreaterThan(200);
      expect(definiteSeen).toBeGreaterThan(50);
      expect(ambiguousSeen).toBeGreaterThan(10_000);
      expect(checked).toBeGreaterThan(30_000);
    }, 60_000);
  });

  it('공급자 경유: 장기 교환 400 { error: invalid_client, code: 2, is_transient: true } → 결과 불명 + shortTokenIssued(단기 토큰 잔존 가능)', async () => {
    const { fetch, seen } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: EXCHANGE_OK, [K('GET', THREADS_LONG_LIVED_URL)]: () => jsonRes(400, { error: 'invalid_client', code: 2, is_transient: true }) });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('provider_error');
    expect(e.detail).toMatchObject({ reason: 'server_error', step: 'long_lived', ambiguous: true, shortTokenIssued: true, httpStatus: 400 });
    expect(seen).toHaveLength(2);
    expect(inspect(e, { depth: Infinity })).not.toContain(SHORT);
  });
  it('공급자 경유: 장기 교환 400 문자열 오류 { error: invalid_client, code: "abc" } → 결과 불명 + shortTokenIssued', async () => {
    const { fetch } = fixtureFetch({ [K('POST', THREADS_TOKEN_URL)]: EXCHANGE_OK, [K('GET', THREADS_LONG_LIVED_URL)]: () => jsonRes(400, { error: 'invalid_client', code: 'abc' }) });
    const e = await provider(fetch).exchangeCode({ code: CODE, codeVerifier: 'v'.repeat(43), redirectUri: REDIRECT, now: NOW }).catch((x) => x);
    expect(e.code).toBe('provider_error');
    expect(e.detail).toMatchObject({ reason: 'oauth_exception', step: 'long_lived', ambiguous: true, shortTokenIssued: true });
  });
});

// FIX2-LIVET1(Codex review-FIX-LIVET1 P2 :127): 제한 정보(Retry-After·BUC 사용량 헤더의 회복 시간)는 429 밖의 제한 코드에서도 숫자로만 남는다
describe('제한 응답의 다시 시도 시간(FIX2-LIVET1 P2)', () => {
  const lim = (code: number) => ({ error: { message: 'Application request limit reached', type: 'OAuthException', code } });
  type Row = [string, Parameters<typeof mapThreadsError>, number | undefined];
  const buc = (m: unknown) => JSON.stringify({ '1234': [{ type: 'threads', call_count: 100, total_cputime: 5, total_time: 5, estimated_time_to_regain_access: m }] });
  const rows: Row[] = [
    ['400 + 코드 4 + Retry-After 120(Codex 재현)', ['exchange', 400, lim(4), { retryAfter: '120' }], 120],
    ['403 + 코드 17 + Retry-After 문자열 인자', ['account', 403, lim(17), '45'], 45],
    ['400 + 코드 613 + BUC 5분', ['refresh', 400, lim(613), { businessUseCaseUsage: buc(5) }], 300],
    ['400 + 코드 32 + Retry-After 60 · BUC 3분 → 긴 쪽', ['account', 400, lim(32), { retryAfter: '60', businessUseCaseUsage: buc(3) }], 180],
    ['429 + BUC 2분(Retry-After 없이)', ['account', 429, null, { businessUseCaseUsage: buc(2) }], 120],
    ['429 + Retry-After 0', ['account', 429, null, '0'], 0],
    ['400 + 코드 4 + Retry-After 음수 → 없음', ['account', 400, lim(4), { retryAfter: '-5' }], undefined],
    ['400 + 코드 4 + Retry-After 소수 → 없음', ['account', 400, lim(4), { retryAfter: '1.5' }], undefined],
    ['400 + 코드 4 + Retry-After HTTP-date → 없음(읽지 않음)', ['account', 400, lim(4), { retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' }], undefined],
    ['400 + 코드 4 + Retry-After 너무 큼 → 없음', ['account', 400, lim(4), { retryAfter: '10000000' }], undefined],
    ['400 + 코드 4 + BUC 깨진 JSON → 없음', ['account', 400, lim(4), { businessUseCaseUsage: '{not json' }], undefined],
    ['400 + 코드 4 + BUC 음수·문자 → 없음', ['account', 400, lim(4), { businessUseCaseUsage: JSON.stringify({ a: [{ estimated_time_to_regain_access: -1 }, { estimated_time_to_regain_access: '9' }] }) }], undefined],
    ['400 + 코드 4 + 힌트 없음', ['account', 400, lim(4), null], undefined],
  ];
  it.each(rows)('%s', (_label, args, sec) => {
    const e = mapThreadsError(...args);
    expect(e.code).toBe('provider_error');
    expect(e.detail?.reason).toBe('rate_limited');
    if (sec === undefined) expect(e.detail).not.toHaveProperty('retryAfterSec');
    else expect(e.detail?.retryAfterSec).toBe(sec);
    // 원 헤더 값(날짜·JSON·사용량 수치)은 결과에 없다 — 숫자 필드만
    expect(JSON.stringify(e.detail)).not.toMatch(/GMT|call_count|total_cputime|not json|threads"/);
  });
  it('제한이 아닌 오류(확정·5xx)에는 retryAfterSec 를 붙이지 않는다', () => {
    expect(mapThreadsError('account', 400, { error: { message: 'x', type: 'OAuthException', code: 190 } }, { retryAfter: '30' }).detail).not.toHaveProperty('retryAfterSec');
    expect(mapThreadsError('account', 503, null, { retryAfter: '30' }).detail).not.toHaveProperty('retryAfterSec');
  });
  it('공급자 경유: 400 + 코드 4 + Retry-After·BUC 헤더 → retryAfterSec 만 남는다(헤더 원문 없음)', async () => {
    const { fetch } = fixtureFetch({
      [K('GET', THREADS_ME_URL)]: () => jsonRes(400, lim(4), { 'retry-after': '90', 'x-business-use-case-usage': buc(1), 'x-app-usage': '{"call_count":100}' }),
    });
    const e = await provider(fetch).accountInfo({ accessToken: LONG, now: NOW }).catch((x) => x);
    expect(e.code).toBe('provider_error');
    expect(e.detail).toEqual({ reason: 'rate_limited', step: 'account', httpStatus: 400, providerCode: 4, retryAfterSec: 90 });
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
