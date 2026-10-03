/**
 * LIVE-T1(결정 D31 1단계): 실제 Threads 연결 경로 — route → DB → 공급자. **실제 네트워크 호출 0**: globalThis.fetch 를 fixture 로 바꾸고
 * (vi.stubGlobal), 그 밖의 Threads·Meta 요청은 setupFiles 가드가 막는다. 앱 ID·시크릿·토큰·code 는 모두 가짜(FAKE_…).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  getDb,
  listChannelAccounts,
  loadMockCredentialsForRehydration,
  refreshExpiringCredentials,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, openSecret, requireSecretKeyring, type Channel } from '@cs/domain';
import { THREADS_LONG_LIVED_URL, THREADS_ME_URL, THREADS_TOKEN_URL } from '@cs/providers';
import { GET as accountsGET, POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as checkPOST } from '../../apps/web/app/api/channel-accounts/[id]/check/route';
import { POST as revokePOST } from '../../apps/web/app/api/channel-accounts/[id]/revoke/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { oauthDeps } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const B = 'livet1-other@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000001';
const SECRET = 'FAKE_app_secret_LIVET1_integration_only';
const SHORT = 'FAKE_short_token_LIVET1_it_ssssssssssss';
const LONG = 'FAKE_long_token_LIVET1_it_llllllllllllll';
const REDIRECT = `${BASE}/api/oauth/callback`;
const PROFILE_ID = '1234567';

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let tmp: string;
const mockAcc = {} as Record<Channel, string>;

const LIVE_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const liveEnv = (over: Partial<Record<keyof typeof LIVE_ENV, string>> = {}) => {
  for (const [k, v] of Object.entries({ ...LIVE_ENV, ...over })) vi.stubEnv(k, v);
};
const clearLive = () => {
  for (const k of Object.keys(LIVE_ENV)) vi.stubEnv(k, '');
};
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, token = tokenA, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));

/** 모든 응답을 모은다 — 비밀 검사용 */
const seen: string[] = [];
async function rec(res: Response): Promise<Response> {
  seen.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`);
  return res;
}

// ---- fixture fetch ----
type Reply = (() => Response) | Error;
const calls: Array<{ method: string; url: URL }> = [];
function useFixture(routes: Record<string, Reply | Reply[]>) {
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const q = queues.get(`${method} ${url.origin}${url.pathname}`);
    if (!q?.length) throw new Error(`fixture 없음: ${method} ${url.hostname}${url.pathname}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    return r();
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const EXCHANGE_OK = () => jsonRes(200, { access_token: SHORT, token_type: 'bearer', user_id: 17841405793187218 });
const LONG_OK = () => jsonRes(200, { access_token: LONG, token_type: 'bearer', expires_in: 5184000 });
const me = (id = PROFILE_ID, username = 'threadsapitestuser') => () => jsonRes(200, { id, username });
const happy = (profile = me()) => ({ [`POST ${THREADS_TOKEN_URL}`]: EXCHANGE_OK, [`GET ${THREADS_LONG_LIVED_URL}`]: LONG_OK, [`GET ${THREADS_ME_URL}`]: profile });

// ---- 흐름 도우미 ----
async function createLive(token = tokenA): Promise<{ status: number; account: { id: string; external_account_id: string; state: string; ready: boolean; mock: boolean }; created: boolean }> {
  const r = await rec(await accountsPOST(post('/api/channel-accounts', token, { platform: 'threads', kind: 'live' })));
  return { status: r.status, ...(await r.json()) };
}
const connect = async (id: string, token = tokenA) => rec(await connectPOST(post(`/api/channel-accounts/${id}/connect`, token), ctx(id)));
const callback = async (q: Record<string, string>, token = tokenA) => {
  const u = new URL(REDIRECT);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return rec(await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(token) } })));
};
async function startLive(id: string): Promise<{ state: string; url: URL }> {
  const c = await connect(id);
  expect(c.status, await c.clone().text()).toBe(200);
  const body = (await c.json()) as { authorize_url: string; provider: string; mock: boolean };
  expect(body.provider).toBe('threads');
  expect(body.mock).toBe(false);
  const url = new URL(body.authorize_url);
  return { state: url.searchParams.get('state')!, url };
}
const credRow = async (id: string) => (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, id)))[0] ?? null;
const accountRow = async (id: string) => (await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, id)))[0]!;
const auditFor = async (id: string) => db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, id));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-livet1-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  Object.assign(mockAcc, Object.fromEntries((await listChannelAccounts(db, ownerA)).map((a) => [a.platform, a.id])));
  as(B);
  tokenB = await login(B);
  as(A);
  tokenA = await login(A);
});
beforeEach(() => {
  as(A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  clearLive();
  calls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('실제 Threads 계정 행(연결 전) — owner 범위, 외부 호출 없음', () => {
  it('POST /api/channel-accounts {platform:threads, kind:live} → 201 pending: 행(state disconnected, ready=false), 다시 → 200 같은 행, 잘못된 본문 → 400, 다른 owner 는 404', async () => {
    const f = useFixture({});
    const a = await createLive();
    expect(a.status).toBe(201);
    expect(a.created).toBe(true);
    expect(a.account.mock).toBe(false);
    expect(a.account.external_account_id.startsWith('pending:')).toBe(true);
    expect(a.account.state).toBe('disconnected');
    expect(a.account.ready).toBe(false);
    const again = await createLive();
    expect(again.status).toBe(200);
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(a.account.id);
    for (const bad of [{ platform: 'instagram', kind: 'live' }, { platform: 'threads', kind: 'mock' }, {}]) {
      const r = await accountsPOST(post('/api/channel-accounts', tokenA, bad));
      expect(r.status).toBe(400);
    }
    // 다른 출처는 거부
    const cross = await accountsPOST(new Request(`${BASE}/api/channel-accounts`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example', ...cookieHeader(tokenA) }, body: '{"platform":"threads","kind":"live"}' }));
    expect(cross.status).toBe(403);
    // 다른 owner 는 A 의 행을 연결할 수 없다(404)
    liveEnv();
    as(B);
    expect((await connect(a.account.id, tokenB)).status).toBe(404);
    const list = (await (await accountsGET(new Request(`${BASE}/api/channel-accounts`, { headers: { accept: 'application/json', ...cookieHeader(tokenB) } }), undefined)).json()) as { items: Array<{ id: string }> };
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.some((i) => i.id === a.account.id)).toBe(false);
    expect((await listChannelAccounts(db, ownerB)).some((x) => x.kind === 'live')).toBe(false);
    as(A);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('준비 상태 행렬(route) — 하나라도 빠지면 503(이름만), 연결 요청 행·외부 호출 없음', () => {
  it.each([
    ['OAUTH_MODE=live', { OAUTH_MODE: 'mock' }],
    ['THREADS_APP_ID', { THREADS_APP_ID: '' }],
    ['THREADS_APP_SECRET', { THREADS_APP_SECRET: '' }],
    ['OAUTH_REDIRECT_URI', { OAUTH_REDIRECT_URI: '' }],
    ['OAUTH_LIVE_APPROVAL_REF', { OAUTH_LIVE_APPROVAL_REF: '' }],
  ] as const)('%s 빠짐', async (name, over) => {
    const f = useFixture({});
    const { account } = await createLive();
    liveEnv(over);
    const r = await connect(account.id);
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error).toBe('live_oauth_not_configured');
    expect(body.message).toContain(name);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(await db.select().from(schema.oauthStates).where(eq(schema.oauthStates.channelAccountId, account.id))).toHaveLength(0);
    expect(f).not.toHaveBeenCalled();
  });
  it('마스터 키가 없으면 503(secrets 또는 live 준비) — 시크릿 값 없음', async () => {
    const { account } = await createLive();
    liveEnv();
    vi.stubEnv('SECRETS_MASTER_KEY', '');
    const r = await connect(account.id);
    expect(r.status).toBe(503);
    expect(await r.text()).not.toContain(SECRET);
  });
});

describe('실제 연결 전체 흐름(fixture) — 묶기·봉인 저장·프로필 조회·철회 unsupported·비밀 위생', () => {
  it('connect → callback(코드 교환 → 장기 교환 → /me) → check → revoke: 비밀은 응답·감사·콘솔·DB 평문 어디에도 없다, 게시는 막혀 있다', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity }))).join(' ')));
    }
    seen.length = 0;
    // 다른 시험이 남긴 연결 전 행과 섞이지 않게 owner A 의 연결 전 행을 하나 쓴다(createLive 는 멱등)
    const { account } = await createLive();
    liveEnv();
    const f = useFixture(happy());
    const { state, url } = await startLive(account.id);
    expect(url.origin).toBe('https://threads.com');
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(APP_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(f).not.toHaveBeenCalled(); // 연결 시작은 주소만 만든다
    const startAudit = (await auditFor(account.id)).find((e) => e.action === 'oauth.connect_start')!;
    expect(startAudit.sanitizedDetails).toMatchObject({ provider: 'threads', mock: false, pkce: 'none' });

    const cb = await callback({ code: 'FAKE_code_LIVET1_it_cccccccccccccc', state });
    expect(cb.status, await cb.clone().text()).toBe(200);
    const view = (await cb.json()).account;
    expect(view).toMatchObject({ mock: false, kind: 'live', provider: 'threads', status: 'connected', display_name: '@threadsapitestuser', live_unbound: false });
    expect(view.notice).toContain('LIVE_THREADS_PUBLISH(D31 범위 밖)');
    expect(calls.map((c) => `${c.method} ${c.url.hostname}${c.url.pathname}`)).toEqual([
      'POST graph.threads.com/oauth/access_token',
      'GET graph.threads.net/access_token',
      'GET graph.threads.net/v1.0/me',
    ]);
    const acc = await accountRow(account.id);
    expect(acc.externalAccountId).toBe(PROFILE_ID);
    expect(acc.state).toBe('disconnected'); // 배포 계획에 고를 수 없다(게시 범위 밖)
    const cred = (await credRow(account.id))!;
    expect(cred.provider).toBe('threads');
    expect(cred.isMock).toBe(false);
    expect(cred.encryptedToken).not.toContain(LONG);
    const plain = openSecret(requireSecretKeyring(process.env), cred.encryptedToken!, cred.keyVersion!, { ownerId: ownerA, channelAccountId: account.id, purpose: 'oauth_token' });
    expect(JSON.parse(plain).access_token).toBe(LONG); // 장기 토큰만 저장(단기 토큰 아님)
    expect(plain).not.toContain(SHORT);

    // 모의 다시 채우기는 실제 연결 정보를 건드리지 않는다
    const re = await loadMockCredentialsForRehydration(db, { keyring: requireSecretKeyring(process.env) });
    expect(JSON.stringify(re.entries)).not.toContain(LONG);
    expect(re.entries.every((e) => e.provider.startsWith('mock_'))).toBe(true);

    // worker 자동 갱신은 실제 연결 정보를 갱신하지 않는다(실제 호출 0) — 만료 직전 시각이어도
    const before = calls.length;
    const w = await refreshExpiringCredentials(db, { ...oauthDeps(loadConfig(process.env)), ownerId: ownerA, now: new Date(Date.now() + 55 * 86_400_000) });
    expect(w.refreshed).toBe(0);
    expect(w.failed).toBe(0);
    expect(calls.length).toBe(before);

    // 배포 계획에 실제 계정을 넣을 수 없다(state disconnected → 준비 안 됨)
    const { content } = await createContent(db, ownerA, { title: 'live 계획 시험', body: '본문' });
    const { variant } = await createVariantDraft(db, ownerA, content.id, { channel: 'threads', baseVersion: 1 });
    await setVariantLifecycle(db, ownerA, variant.id, { lifecycle: 'review', baseVersion: 1 });
    const plan = await plansPOST(post('/api/distribution-plans', tokenA, { items: [{ variant_id: variant.id, channel_account_id: account.id }] }));
    expect(plan.status).not.toBe(201);

    // 연결 확인 = /me 한 번
    const chk = await rec(await checkPOST(post(`/api/channel-accounts/${account.id}/check`), ctx(account.id)));
    expect(chk.status).toBe(200);
    expect((await chk.json()).account.status).toBe('connected');
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.url.pathname).toBe('/v1.0/me');

    // 연결 해제 — Threads 철회 API 없음: 네트워크 0, remote_revoke=unsupported, 로컬 삭제(T13 규칙)
    const rv = await rec(await revokePOST(post(`/api/channel-accounts/${account.id}/revoke`), ctx(account.id)));
    expect(rv.status).toBe(200);
    const rb = await rv.json();
    expect(rb).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null });
    expect(calls.length).toBe(before + 1);
    const after = (await credRow(account.id))!;
    expect(after.encryptedToken).toBeNull();
    expect(after.revokedAt).not.toBeNull();
    expect(await db.select().from(schema.oauthPendingTokens).where(eq(schema.oauthPendingTokens.channelAccountId, account.id))).toHaveLength(0);
    const revAudit = (await auditFor(account.id)).find((e) => e.action === 'oauth.revoked')!;
    expect(revAudit.sanitizedDetails).toMatchObject({ remote_revoke: 'unsupported', outcome: 'revoked' });

    // 비밀 위생: 응답·감사·콘솔에 앱 시크릿·토큰·code 없음
    const audits = JSON.stringify(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.ownerId, ownerA)));
    const blob = [...seen, audits, ...logs].join('\n');
    for (const s of [SECRET, SHORT, LONG, 'FAKE_code_LIVET1_it_cccccccccccccc']) expect(blob, s.slice(0, 14)).not.toContain(s);
  });

  it('같은 계정 다시 연결은 같은 행·같은 정체, 다른 Threads 계정으로 돌아오면 409 oauth_account_mismatch(저장 안 함)', async () => {
    // 위 시험으로 묶인 행(PROFILE_ID)을 찾는다
    const bound = (await listChannelAccounts(db, ownerA)).find((a) => a.kind === 'live' && a.externalAccountId === PROFILE_ID)!;
    expect(bound).toBeDefined();
    liveEnv();
    useFixture(happy());
    const ok = await callback({ code: 'FAKE_code_LIVET1_reconnect_cccccc', state: (await startLive(bound.id)).state });
    expect(ok.status).toBe(200);
    expect((await credRow(bound.id))!.tokenGeneration).toBe(2);
    vi.unstubAllGlobals();
    useFixture(happy(me('7654321', 'someoneelse')));
    const gen = (await credRow(bound.id))!.tokenGeneration;
    const bad = await callback({ code: 'FAKE_code_LIVET1_mismatch_cccccc', state: (await startLive(bound.id)).state });
    expect(bad.status).toBe(409);
    expect((await bad.json()).error).toBe('oauth_account_mismatch');
    expect((await credRow(bound.id))!.tokenGeneration).toBe(gen);
    expect((await accountRow(bound.id)).externalAccountId).toBe(PROFILE_ID);
    const rej = (await auditFor(bound.id)).filter((e) => e.action === 'oauth.callback_rejected').at(-1)!;
    expect(rej.sanitizedDetails).toMatchObject({ reason: 'account_mismatch', issued_token_revoke: 'unsupported', pending_record: 'not_requested' });
  });

  it('다른 연결 전 행이 이미 묶인 Threads 계정으로 돌아오면 409 oauth_account_duplicate — 연결 전 행은 그대로', async () => {
    const { account } = await createLive(); // 앞 시험의 행은 묶였으므로 새 연결 전 행
    expect(account.external_account_id.startsWith('pending:')).toBe(true);
    liveEnv();
    useFixture(happy());
    const r = await callback({ code: 'FAKE_code_LIVET1_dup_cccccccccccc', state: (await startLive(account.id)).state });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('oauth_account_duplicate');
    expect((await accountRow(account.id)).externalAccountId).toBe(account.external_account_id);
    expect(await credRow(account.id)).toBeNull();
  });
});

describe('코드 교환 실패 — 오류 매핑·결과 불명(ambiguous)', () => {
  it('이미 쓴 code → 400 oauth_exchange_failed(reason invalid_grant), 장기 교환·프로필 호출 없음, 연결 정보 없음', async () => {
    const { account } = await createLive();
    liveEnv();
    useFixture({ [`POST ${THREADS_TOKEN_URL}`]: () => jsonRes(400, { error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' }) });
    const r = await callback({ code: 'FAKE_code_LIVET1_used_ccccccccccc', state: (await startLive(account.id)).state });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'oauth_exchange_failed', reason: 'invalid_grant' });
    expect(calls).toHaveLength(1);
    expect(await credRow(account.id)).toBeNull();
    const rej = (await auditFor(account.id)).filter((e) => e.action === 'oauth.callback_rejected').at(-1)!;
    expect(rej.sanitizedDetails).toMatchObject({ reason: 'exchange_failed', provider_error: 'invalid_grant', provider_step: 'exchange', outcome_ambiguous: 'no' });
  });
  it('코드 교환 중 네트워크 끊김 → 400 oauth_exchange_failed + outcome unknown, 감사 outcome_ambiguous=yes, 같은 state 재사용 불가', async () => {
    const { account } = await createLive();
    liveEnv();
    useFixture({ [`POST ${THREADS_TOKEN_URL}`]: new TypeError(`fetch failed ${THREADS_TOKEN_URL}?client_secret=${SECRET}`) });
    const { state } = await startLive(account.id);
    const r = await callback({ code: 'FAKE_code_LIVET1_net_cccccccccccc', state });
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body).toMatchObject({ error: 'oauth_exchange_failed', reason: 'provider_error', outcome: 'unknown' });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const rej = (await auditFor(account.id)).filter((e) => e.action === 'oauth.callback_rejected').at(-1)!;
    expect(rej.sanitizedDetails).toMatchObject({ provider_error: 'provider_error', provider_reason: 'network', outcome_ambiguous: 'yes' });
    expect(JSON.stringify(rej)).not.toContain(SECRET);
    expect(await credRow(account.id)).toBeNull();
    const again = await callback({ code: 'FAKE_code_LIVET1_net_cccccccccccc', state });
    expect((await again.json()).error).toBe('oauth_state_used');
  });
  it('장기 교환 5xx → 400 oauth_exchange_failed(outcome unknown), 단기 토큰은 어디에도 저장되지 않는다', async () => {
    const { account } = await createLive();
    liveEnv();
    useFixture({ [`POST ${THREADS_TOKEN_URL}`]: EXCHANGE_OK, [`GET ${THREADS_LONG_LIVED_URL}`]: () => jsonRes(503, { error: { message: 'x', type: 'OAuthException', code: 2 } }) });
    const r = await callback({ code: 'FAKE_code_LIVET1_5xx_cccccccccccc', state: (await startLive(account.id)).state });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'oauth_exchange_failed', outcome: 'unknown' });
    expect(await credRow(account.id)).toBeNull();
    expect(await db.select().from(schema.oauthPendingTokens).where(eq(schema.oauthPendingTokens.channelAccountId, account.id))).toHaveLength(0);
  });
});

describe('모의 경로는 그대로', () => {
  it('OAUTH_MODE=live 여도 모의 Threads 계정 연결은 모의 공급자(앱 안 주소, 외부 호출 0)', async () => {
    liveEnv();
    const f = useFixture({});
    const c = await connect(mockAcc.threads);
    expect(c.status).toBe(200);
    const body = await c.json();
    expect(body.mock).toBe(true);
    expect(body.provider).toBe('mock_threads');
    expect(new URL(body.authorize_url).origin).toBe(BASE);
    expect(f).not.toHaveBeenCalled();
  });
  it('OAUTH_MODE=mock(기본)에서 모의 계정 연결 시작 응답·준비 표시는 T13 그대로', async () => {
    const f = useFixture({});
    const c = await connect(mockAcc.threads);
    expect(c.status).toBe(200);
    expect((await c.json()).notice).toContain('MOCK');
    expect(f).not.toHaveBeenCalled();
  });
});
