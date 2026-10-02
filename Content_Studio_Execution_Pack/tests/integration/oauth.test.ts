/**
 * T13(결정 D24): 계정 연결(모의 Threads OAuth)·비밀 보호·연결 상태·실행 차단·내보내기/복원 제외.
 * 마스터 키는 시험이 만든 난수(실제 키 아님). 외부 호출 없음(모의 공급자는 프로세스 안).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  closeDb,
  commitRestore,
  createContent,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  exportOwner,
  getAccountHealth,
  getDb,
  listChannelAccounts,
  parseBundleZip,
  refreshExpiringCredentials,
  rotateSecretKeys,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, openSecret, requireSecretKeyring, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, MockThreadsOAuthProvider } from '@cs/providers';
import { GET as accountsGET } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { GET as healthGET } from '../../apps/web/app/api/channel-accounts/[id]/health/route';
import { POST as refreshPOST } from '../../apps/web/app/api/channel-accounts/[id]/refresh/route';
import { POST as checkPOST } from '../../apps/web/app/api/channel-accounts/[id]/check/route';
import { POST as revokePOST } from '../../apps/web/app/api/channel-accounts/[id]/revoke/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { GET as opsSummaryGET } from '../../apps/web/app/api/ops/summary/route';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const B = 'oauth-other@example.local';
const KEY1 = randomBytes(32).toString('base64');
const KEY2 = randomBytes(32).toString('base64');
const DAY = 24 * 3600_000;
const config = loadConfig({});
const registry = createMockAdapterRegistry();

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let tmp: string;
const acc = {} as Record<string, Record<Channel, string>>;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const useKeys = (env: Record<string, string>) => {
  for (const k of ['SECRETS_MASTER_KEY', 'SECRETS_KEY_VERSION', 'SECRETS_MASTER_KEY_PREVIOUS', 'SECRETS_KEY_VERSION_PREVIOUS']) vi.stubEnv(k, env[k] ?? '');
};
const key1 = () => useKeys({ SECRETS_MASTER_KEY: KEY1, SECRETS_KEY_VERSION: '1' });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (p: string, token = tokenA) => new Request(`${BASE}${p}`, { headers: { accept: 'application/json', ...cookieHeader(token) } });
const post = (p: string, token = tokenA) => jsonPost(p, {}, cookieHeader(token));

/** 모든 응답(본문 + 헤더)을 모은다 — 비밀 검사용 */
const seen: Array<{ label: string; text: string }> = [];
async function record(label: string, res: Response): Promise<Response> {
  const body = await res.clone().text();
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n');
  seen.push({ label, text: `${headers}\n${body}` });
  return res;
}

const connect = (accountId: string, token = tokenA) => connectPOST(post(`/api/channel-accounts/${accountId}/connect`, token), ctx(accountId)).then((r) => record('connect', r));
const health = (accountId: string, token = tokenA) => healthGET(get(`/api/channel-accounts/${accountId}/health`, token), ctx(accountId)).then((r) => record('health', r));
const refresh = (accountId: string, token = tokenA) => refreshPOST(post(`/api/channel-accounts/${accountId}/refresh`, token), ctx(accountId)).then((r) => record('refresh', r));
const check = (accountId: string, token = tokenA) => checkPOST(post(`/api/channel-accounts/${accountId}/check`, token), ctx(accountId)).then((r) => record('check', r));
const revoke = (accountId: string, token = tokenA) => revokePOST(post(`/api/channel-accounts/${accountId}/revoke`, token), ctx(accountId)).then((r) => record('revoke', r));

/** 모의 동의 화면 → 303 Location(callback?code&state) */
async function authorize(authorizeUrl: string, extra: Record<string, string> = {}, token = tokenA): Promise<Response> {
  const u = new URL(authorizeUrl);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return record('mock-authorize', await mockAuthorizeGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(token) } })));
}
const callback = (url: string, token = tokenA) =>
  callbackGET(new Request(url, { headers: { accept: 'application/json', ...cookieHeader(token) } })).then((r) => record('callback', r));

/** 연결 시작 → 동의 → callback 직전까지. */
async function begin(accountId: string, extra: Record<string, string> = {}, token = tokenA) {
  const c = await connect(accountId, token);
  expect(c.status).toBe(200);
  const body = (await c.json()) as { authorize_url: string; scopes: string[]; mock: boolean };
  const state = new URL(body.authorize_url).searchParams.get('state')!;
  const a = await authorize(body.authorize_url, extra, token);
  return { body, state, authorizeRes: a, location: a.headers.get('location') };
}

/** 끝까지 연결(성공 기대) */
async function connectFully(accountId: string, token = tokenA) {
  const b = await begin(accountId, {}, token);
  expect(b.authorizeRes.status).toBe(303);
  const res = await callback(b.location!, token);
  expect(res.status, await res.clone().text()).toBe(200);
  return { ...b, account: (await res.json()).account };
}

const credRow = async (accountId: string) => (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, accountId)))[0] ?? null;
const accountRow = async (accountId: string) => (await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, accountId)))[0]!;
const decryptToken = async (ownerId: string, accountId: string) => {
  const c = (await credRow(accountId))!;
  const plain = openSecret(requireSecretKeyring(process.env), c.encryptedToken!, c.keyVersion!, { ownerId, channelAccountId: accountId, purpose: 'oauth_token' });
  return JSON.parse(plain).access_token as string;
};

/** 새 모의 Threads 계정(owner 별 여러 개 — 시험이 서로 간섭하지 않게) */
async function newThreadsAccount(ownerId = ownerA): Promise<string> {
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId, platform: 'threads', kind: 'mock', externalAccountId: `mock:threads:${randomUUID()}`, displayName: 'MOCK Threads 시험', state: 'mock_ready' })
    .returning();
  return row!.id;
}

const BODY = '# 첫 달 회고\n\n대리점과 첫 회의를 했다.';
async function approvedPlanFor(accountId: string) {
  const { content } = await createContent(db, ownerA, { title: 'oauth 배포', body: BODY });
  const { variant } = await createVariantDraft(db, ownerA, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, ownerA, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const res = await plansPOST(jsonPost('/api/distribution-plans', { items: [{ variant_id: variant.id, channel_account_id: accountId }] }, cookieHeader(tokenA)));
  expect(res.status).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  const item = p.items[0]!;
  const ap = await approvePOST(
    jsonPost(`/api/distribution-plans/${p.plan.id}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' }, cookieHeader(tokenA)),
    ctx(p.plan.id),
  );
  expect(ap.status).toBe(200);
  return { planId: p.plan.id, itemId: item.id, approvalId: (await ap.json()).approvals[0].id as string };
}
const execute = (planId: string) => executePOST(jsonPost(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }, cookieHeader(tokenA)), ctx(planId));
const tick = () => runJobsTick(db, registry, { workerId: 'oauth-w', config, ownerId: ownerA, submitTimeoutMs: 1500 });
const expireCredential = (accountId: string) =>
  db.update(schema.oauthCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthCredentials.channelAccountId, accountId));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t13-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  for (const o of [ownerA, ownerB]) acc[o] = Object.fromEntries((await listChannelAccounts(db, o)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  as(A);
  tokenA = await login(A);
  as(B);
  tokenB = await login(B);
  as(A);
});
beforeEach(() => {
  as(A);
  key1();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('전체 흐름 + 비밀이 어디에도 나가지 않음', () => {
  it('connect → 모의 동의 → callback → health → refresh → check → revoke: 토큰·code·verifier 는 응답·감사·내보내기·콘솔·DB 평문 어디에도 없다', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
    seen.length = 0;
    const accountId = await newThreadsAccount();
    const c = await connect(accountId);
    expect(c.status).toBe(200);
    const cb = (await c.json()) as { authorize_url: string; scopes: string[]; mock: boolean; notice: string };
    expect(cb.mock).toBe(true);
    expect(cb.notice).toContain('MOCK');
    expect(cb.scopes).toEqual(['threads_basic', 'threads_content_publish']);
    const authUrl = new URL(cb.authorize_url);
    const state = authUrl.searchParams.get('state')!;
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrl.searchParams.get('scope')).toBe('threads_basic,threads_content_publish');
    // 서버에는 state 원문이 없고(hash 만) verifier 는 봉인
    const st = (await db.select().from(schema.oauthStates).where(eq(schema.oauthStates.channelAccountId, accountId)))[0]!;
    expect(JSON.stringify(st)).not.toContain(state);
    const verifier = openSecret(requireSecretKeyring(process.env), st.encryptedVerifier, st.keyVersion, { ownerId: ownerA, channelAccountId: accountId, purpose: 'pkce_verifier', scopeId: st.id });
    expect(st.encryptedVerifier).not.toContain(verifier);

    const a = await authorize(cb.authorize_url);
    expect(a.status).toBe(303);
    const loc = new URL(a.headers.get('location')!);
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();
    const done = await callback(loc.toString());
    expect(done.status).toBe(200);
    const view = (await done.json()).account;
    expect(view).toMatchObject({ status: 'connected', mock: true, usable_for_execution: true, scopes_granted: ['threads_basic', 'threads_content_publish'], missing_scopes: [], key_version: 1 });
    const token1 = await decryptToken(ownerA, accountId);
    const cipher1 = (await credRow(accountId))!.encryptedToken!;

    expect((await health(accountId)).status).toBe(200);
    expect((await refresh(accountId)).status).toBe(200);
    const token2 = await decryptToken(ownerA, accountId);
    expect(token2).not.toBe(token1);
    const cipher2 = (await credRow(accountId))!.encryptedToken!;
    expect((await check(accountId)).status).toBe(200);
    expect((await accountsGET(get('/api/channel-accounts'), undefined).then((r) => record('accounts', r))).status).toBe(200);
    expect((await opsSummaryGET(get('/api/ops/summary'), undefined).then((r) => record('ops', r))).status).toBe(200);

    // 내보내기(연결 중인 상태)
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'exp-flow') });
    const zipText = Buffer.from(readFileSync(exported.zipPath)).toString('latin1');
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const bundleText = JSON.stringify(parsed.tables) + JSON.stringify(parsed.manifest);

    const rv = await revoke(accountId);
    expect(rv.status).toBe(200);
    expect(await rv.json()).toMatchObject({ account: { status: 'revoked', usable_for_execution: false }, remote_revoke: 'ok' });
    const after = (await credRow(accountId))!;
    expect(after.encryptedToken).toBeNull();
    expect(after.keyVersion).toBeNull();
    expect(after.revokedAt).not.toBeNull();

    const audits = JSON.stringify(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.ownerId, ownerA)));
    const dbCreds = JSON.stringify(await db.select().from(schema.oauthCredentials)) + JSON.stringify(await db.select().from(schema.oauthStates));
    const secrets = { token1, token2, code, verifier };
    for (const [name, v] of Object.entries(secrets)) {
      for (const s of seen) {
        // OAuth 규약상 code 는 모의 공급자의 303 Location(→ callback)에만 있다.
        if (name === 'code' && s.label === 'mock-authorize') continue;
        expect(s.text.includes(v), `${name} in ${s.label}`).toBe(false);
      }
      expect(audits.includes(v), `${name} in audit`).toBe(false);
      expect(bundleText.includes(v), `${name} in export`).toBe(false);
      expect(zipText.includes(v), `${name} in zip`).toBe(false);
      expect(logs.join('\n').includes(v), `${name} in console`).toBe(false);
      expect(dbCreds.includes(v), `${name} in db plaintext`).toBe(false);
    }
    // state 는 authorize URL(connect 응답)과 모의 공급자 redirect 에만(규약) — callback 이후 응답·감사·내보내기·콘솔에는 없다
    for (const s of seen) if (!['connect', 'mock-authorize'].includes(s.label)) expect(s.text.includes(state), `state in ${s.label}`).toBe(false);
    expect(audits.includes(state)).toBe(false);
    expect(bundleText.includes(state)).toBe(false);
    expect(logs.join('\n').includes(state)).toBe(false);
    // 암호문도 응답·감사·내보내기에 없다
    for (const cph of [cipher1, cipher2]) {
      for (const s of seen) expect(s.text.includes(cph), `cipher in ${s.label}`).toBe(false);
      expect(audits.includes(cph)).toBe(false);
      expect(bundleText.includes(cph)).toBe(false);
    }
    // 내보내기: 연결 표는 없고 제외 목록에 있음, 계정은 linked 로 들어 있음
    expect(parsed.manifest.excluded_tables).toEqual(expect.arrayContaining(['oauth_credentials', 'oauth_states']));
    expect(Object.keys(parsed.tables)).not.toContain('oauth_credentials');
    expect(parsed.tables.channel_accounts.find((r) => r.id === accountId)!.credential_state).toBe('linked');
    // 감사 동작 기록(코드 값만)
    for (const action of ['oauth.connect_start', 'oauth.connected', 'oauth.refreshed', 'oauth.checked', 'oauth.revoked']) expect(audits).toContain(action);
    vi.restoreAllMocks();
  });
});

describe('A01 — 다른 owner 의 계정·연결 요청', () => {
  it('connect·health·refresh·check·revoke 는 404, 다른 owner 세션의 callback 은 state 를 찾지 못함(그리고 원래 요청은 소비되지 않음)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    as(B);
    expect((await connect(accountId, tokenB)).status).toBe(404);
    expect((await health(accountId, tokenB)).status).toBe(404);
    expect((await refresh(accountId, tokenB)).status).toBe(404);
    expect((await check(accountId, tokenB)).status).toBe(404);
    expect((await revoke(accountId, tokenB)).status).toBe(404);
    expect((await health('not-a-uuid', tokenB)).status).toBe(404);
    as(A);
    const b = await begin(accountId);
    as(B);
    const r = await callback(b.location!, tokenB);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('oauth_state_invalid');
    as(A);
    expect((await callback(b.location!)).status).toBe(200);
    // B 의 계정 연결은 B 만
    expect((await connect(acc[ownerB]!.threads, tokenA)).status).toBe(404);
  });
});

describe('state·redirect·PKCE·거부', () => {
  it('재사용 → oauth_state_used, 형식 오류 → oauth_state_invalid, 만료 → oauth_state_expired', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    expect((await callback(b.location!)).status).toBe(200);
    const again = await callback(b.location!);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe('oauth_state_used');
    const bad = await callback(`${BASE}/api/oauth/callback?state=short&code=x`);
    expect((await bad.json()).error).toBe('oauth_state_invalid');
    const e = await begin(accountId);
    await db.update(schema.oauthStates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthStates.channelAccountId, accountId));
    const exp = await callback(e.location!);
    expect(exp.status).toBe(400);
    expect((await exp.json()).error).toBe('oauth_state_expired');
    // 만료로 거부된 요청도 다시 쓸 수 없다
    expect((await (await callback(e.location!)).json()).error).toBe('oauth_state_used');
  });

  it('다른 세션(같은 owner 의 새 로그인)으로 callback → oauth_state_invalid', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    const token2 = await login(A);
    const r = await callback(b.location!, token2);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('oauth_state_invalid');
    expect(await credRow(accountId)).toBeNull();
  });

  it('redirect URI 불일치: callback 주소가 다르면 oauth_redirect_mismatch, 공급자 쪽에서 redirect_uri 를 바꾸면 400', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    const other = b.location!.replace('http://localhost:3000', 'http://127.0.0.1:3000');
    const r = await callback(other);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('oauth_redirect_mismatch');
    const c = await connect(accountId);
    const url = (await c.json()).authorize_url as string;
    const a = await authorize(url, { redirect_uri: 'http://evil.example.test/api/oauth/callback' });
    expect(a.status).toBe(400);
    expect((await a.json()).error).toBe('redirect_mismatch');
    expect(a.headers.get('location')).toBeNull();
  });

  it('PKCE 불일치(다른 요청의 challenge 로 받은 code) → oauth_exchange_failed(pkce_mismatch), 저장 없음', async () => {
    const accountId = await newThreadsAccount();
    const c1 = (await (await connect(accountId)).json()).authorize_url as string;
    const c2 = (await (await connect(accountId)).json()).authorize_url as string;
    const a = await authorize(c1, { code_challenge: new URL(c2).searchParams.get('code_challenge')! });
    const r = await callback(a.headers.get('location')!);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'oauth_exchange_failed', reason: 'pkce_mismatch' });
    expect(await credRow(accountId)).toBeNull();
  });

  it('사용자 거부 → oauth_denied, 다른 계정으로 로그인 → 409 oauth_account_mismatch(저장 없음)', async () => {
    const accountId = await newThreadsAccount();
    const d = await begin(accountId, { mock_deny: '1' });
    const r = await callback(d.location!);
    expect((await r.json()).error).toBe('oauth_denied');
    const m = await begin(accountId, { mock_user: `mock:threads:${randomUUID()}` });
    const mr = await callback(m.location!);
    expect(mr.status).toBe(409);
    expect((await mr.json()).error).toBe('oauth_account_mismatch');
    expect(await credRow(accountId)).toBeNull();
    expect((await accountRow(accountId)).credentialState).toBe('none');
  });

  it('일부 scope 만 허락 → 저장은 되지만 needs_reconnect(scope_missing) 이고 실행 차단', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId, { mock_grant: 'threads_basic' });
    const r = await callback(b.location!);
    expect(r.status).toBe(200);
    expect((await r.json()).account).toMatchObject({ status: 'needs_reconnect', reason: 'scope_missing', missing_scopes: ['threads_content_publish'], usable_for_execution: false });
  });

  it('지원하지 않는 채널(모의 instagram) → 400 oauth_not_supported, 실제 계정 → 503 live_oauth_not_configured(조건을 모두 넣어도)', async () => {
    const ig = await connect(acc[ownerA]!.instagram);
    expect(ig.status).toBe(400);
    expect((await ig.json()).error).toBe('oauth_not_supported');
    const [live] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: ownerA, platform: 'threads', kind: 'live', externalAccountId: `threads-live-${randomUUID()}`, displayName: '실제 계정 시험 행', state: 'connected' })
      .returning();
    vi.stubEnv('OAUTH_MODE', 'live');
    vi.stubEnv('THREADS_APP_ID', 'placeholder-app-id');
    vi.stubEnv('THREADS_APP_SECRET', 'placeholder-secret');
    vi.stubEnv('OAUTH_REDIRECT_URI', `${BASE}/api/oauth/callback`);
    vi.stubEnv('OAUTH_LIVE_APPROVAL_REF', 'D99');
    try {
      const r = await connect(live!.id);
      expect(r.status).toBe(503);
      const body = await r.json();
      expect(body.error).toBe('live_oauth_not_configured');
      expect(body.message).toContain('LIVE_OAUTH_ADAPTER(T14 미구현)');
      expect(JSON.stringify(body)).not.toContain('placeholder-secret');
      expect(await db.select().from(schema.oauthStates).where(eq(schema.oauthStates.channelAccountId, live!.id))).toHaveLength(0);
      // live 계정은 연결 정보가 없으므로 다시 연결 필요(실행 불가)
      expect((await (await health(live!.id)).json()).account).toMatchObject({ status: 'needs_reconnect', usable_for_execution: false });
    } finally {
      for (const k of ['OAUTH_MODE', 'THREADS_APP_ID', 'THREADS_APP_SECRET', 'OAUTH_REDIRECT_URI', 'OAUTH_LIVE_APPROVAL_REF']) vi.stubEnv(k, '');
    }
    // DB 트리거: 모의 연결 정보를 실제 계정에 붙일 수 없다
    await expect(
      db.insert(schema.oauthCredentials).values({ ownerId: ownerA, channelAccountId: live!.id, provider: 'mock_threads', isMock: true, encryptedToken: 'csk1:1:a:b:c', keyVersion: 1, status: 'active', connectedAt: new Date() }),
    ).rejects.toThrow();
    // 평문 토큰은 CHECK 가 막는다
    const mockAcc = await newThreadsAccount();
    await expect(
      db.insert(schema.oauthCredentials).values({ ownerId: ownerA, channelAccountId: mockAcc, provider: 'mock_threads', isMock: true, encryptedToken: 'mockthr_at_plain', keyVersion: 1, status: 'active', connectedAt: new Date() }),
    ).rejects.toThrow();
  });
});

describe('마스터 키 없음', () => {
  it('연결은 503 secrets_not_configured(요청 행 없음), 계정 목록·상태·계획 만들기는 그대로, 해제는 키 없이도 로컬 삭제', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    useKeys({});
    const before = (await db.select().from(schema.oauthStates)).length;
    const r = await connect(accountId);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toBe('secrets_not_configured');
    expect((await db.select().from(schema.oauthStates)).length).toBe(before);
    expect((await accountsGET(get('/api/channel-accounts'), undefined)).status).toBe(200);
    expect((await health(accountId)).status).toBe(200);
    expect((await refresh(accountId)).status).toBe(503);
    const { planId } = await approvedPlanFor(acc[ownerA]!.threads); // 연결한 적 없는 모의 계정 — M3 동작 그대로
    expect((await execute(planId)).status).toBe(200);
    const rv = await revoke(accountId);
    expect(rv.status).toBe(200);
    expect((await rv.json()).remote_revoke).toBe('skipped_no_key');
    expect((await credRow(accountId))!.encryptedToken).toBeNull();
  });
});

describe('실행 차단·재연결·승인', () => {
  it('만료 → 실행 409(작업 0) · 다시 연결(같은 계정)은 승인 유지 → 실행 · 전송 직전 만료 → BLOCKED(credential_expired) · 재시도 409 · 다시 연결 후 재시도 → MOCK 확인', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const { planId, itemId, approvalId } = await approvedPlanFor(accountId);
    await expireCredential(accountId);
    const ex = await execute(planId);
    expect(ex.status).toBe(409);
    const body = await ex.json();
    expect(body.error).toBe('account_credential_blocked');
    expect(body.items).toEqual([{ item_id: itemId, account_id: accountId, status: 'expired' }]);
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId))).toHaveLength(0);
    // 갱신은 만료된 토큰으로 할 수 없음
    const rf = await refresh(accountId);
    expect(rf.status).toBe(409);
    expect(await rf.json()).toMatchObject({ error: 'credential_refresh_failed', reason: 'token_expired' });

    await connectFully(accountId); // 다시 연결
    const appr = (await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)))[0]!;
    expect(appr.revokedAt).toBeNull();
    expect((await execute(planId)).status).toBe(200);
    await expireCredential(accountId);
    await tick();
    const job = (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)))[0]!;
    expect(job.state).toBe('BLOCKED');
    expect(job.lastErrorCode).toBe('credential_expired');
    expect((await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job.id)))).toHaveLength(0);
    const rt = await retryPOST(jsonPost(`/api/distribution-items/${itemId}/retry`, {}, cookieHeader(tokenA)), ctx(itemId));
    expect(rt.status).toBe(409);
    expect((await rt.json()).error).toBe('account_credential_blocked');
    await connectFully(accountId);
    const rt2 = await retryPOST(jsonPost(`/api/distribution-items/${itemId}/retry`, {}, cookieHeader(tokenA)), ctx(itemId));
    expect(rt2.status).toBe(200);
    await tick();
    const j2 = (await db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)))[0]!;
    expect(j2.state).toBe('CONFIRMED');
    const pub = (await db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId)))[0]!;
    expect(pub.isMock).toBe(true);
  });

  it('연결 해제 → 그 계정의 활성 승인 철회(account_changed), 실행 차단(revoked)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const { planId, approvalId } = await approvedPlanFor(accountId);
    const rv = await revoke(accountId);
    expect((await rv.json()).revoked_approvals).toBe(1);
    const appr = (await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)))[0]!;
    expect(appr.revokeReason).toBe('invalidated:account_changed');
    expect((await execute(planId)).status).not.toBe(200);
    expect((await getAccountHealth(db, ownerA, accountId)).status).toBe('revoked');
    // 두 번 해제는 멱등
    expect((await (await revoke(accountId)).json()).remote_revoke).toBe('already_revoked');
  });
});

describe('갱신·키 교체·변조', () => {
  it('자동 갱신: 만료 7일 안이면 refreshExpiringCredentials 가 새 토큰·새 만료 시각', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const exp = (await credRow(accountId))!.expiresAt!;
    const now = new Date(exp.getTime() - 2 * DAY);
    const providerFor = () => new MockThreadsOAuthProvider({ registeredRedirectUri: `${BASE}/api/oauth/callback`, appBaseUrl: BASE });
    const r = await refreshExpiringCredentials(db, { providerFor, keyring: () => requireSecretKeyring(process.env), now, ownerId: ownerA });
    expect(r.refreshed).toBeGreaterThanOrEqual(1);
    expect((await credRow(accountId))!.expiresAt!.getTime()).toBeGreaterThan(exp.getTime());
    expect((await credRow(accountId))!.lastRefreshedAt).not.toBeNull();
  });

  it('키 교체: 새 키 + 이전 키로 읽히고 rotateSecretKeys 가 새 버전으로 다시 봉인, 이전 키를 빼도 동작. 이전 키 없이 옛 버전 → credential_unreadable', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const stuck = await newThreadsAccount();
    await connectFully(stuck);
    expect((await credRow(accountId))!.keyVersion).toBe(1);
    // 이전 키 없이 v2 만 → 옛 행은 읽을 수 없음
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2' });
    const bad = await check(stuck);
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ error: 'credential_unreadable', problem: 'unknown_key_version' });
    expect((await getAccountHealth(db, ownerA, stuck)).status).toBe('error');
    // 교체 기간: v2 + 이전 v1
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: KEY1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
    expect((await check(accountId)).status).toBe(200);
    const r = await rotateSecretKeys(db, requireSecretKeyring(process.env));
    expect(r.resealed).toBeGreaterThanOrEqual(1);
    expect((await credRow(accountId))!.keyVersion).toBe(2);
    expect((await credRow(accountId))!.encryptedToken!.startsWith('csk1:2:')).toBe(true);
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2' });
    expect((await check(accountId)).status).toBe(200);
    expect((await refresh(accountId)).status).toBe(200);
  });

  it('변조된 암호문·다른 계정 행으로 옮긴 암호문(AAD) → credential_unreadable', async () => {
    const x = await newThreadsAccount();
    const y = await newThreadsAccount();
    await connectFully(x);
    await connectFully(y);
    const cx = (await credRow(x))!;
    await db.update(schema.oauthCredentials).set({ encryptedToken: cx.encryptedToken, keyVersion: cx.keyVersion }).where(eq(schema.oauthCredentials.channelAccountId, y));
    const r = await check(y);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'credential_unreadable', problem: 'auth_failed' });
    const parts = cx.encryptedToken!.split(':');
    parts[4] = (parts[4]![0] === 'A' ? 'B' : 'A') + parts[4]!.slice(1);
    await db.update(schema.oauthCredentials).set({ encryptedToken: parts.join(':') }).where(eq(schema.oauthCredentials.channelAccountId, x));
    expect(await (await check(x)).json()).toMatchObject({ error: 'credential_unreadable', problem: 'auth_failed' });
  });
});

describe('내보내기·복원', () => {
  it('연결 정보는 묶음 밖, 복원한 계정은 "다시 연결 필요"(실행 차단), 대상 DB 에 연결 정보 0', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'exp-restore') });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-t13@example.local')).id;
      const restoresDir = path.join(tmp, 'restores-t13');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-r')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.restored.channel_accounts).toBeGreaterThan(0);
      const restored = (await h.db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, accountId)))[0]!;
      expect(restored.credentialState).toBe('needs_reconnect');
      const view = await getAccountHealth(h.db, target, accountId);
      expect(view).toMatchObject({ status: 'needs_reconnect', status_label: '다시 연결 필요', usable_for_execution: false });
      expect(await h.db.select().from(schema.oauthCredentials)).toHaveLength(0);
      expect(await h.db.select().from(schema.oauthStates)).toHaveLength(0);
      // 연결한 적 없는 모의 계정은 그대로(none)
      const plain = (await h.db.select().from(schema.channelAccounts).where(and(eq(schema.channelAccounts.id, acc[ownerA]!.instagram))))[0]!;
      expect(plain.credentialState).toBe('none');
    } finally {
      await h.close();
    }
    // 같은 환경으로 add_missing 복원: credential_state 차이는 충돌이 아님
    const restoresDir = path.join(tmp, 'restores-t13-same');
    const p2 = await createRestorePreview(db, ownerA, zip, { restoresDir, source: 'upload' });
    expect(p2.preview.conflicts.filter((c: { table: string }) => c.table === 'channel_accounts')).toHaveLength(0);
  });
});

describe('/ops 숫자', () => {
  it('GET /api/ops/summary 의 account_health 는 상태별 개수(owner 범위)', async () => {
    const res = await opsSummaryGET(get('/api/ops/summary'), undefined);
    const body = await res.json();
    expect(Object.keys(body.ops.account_health).sort()).toEqual(['connected', 'error', 'expired', 'expiring_soon', 'needs_reconnect', 'not_connected', 'revoked']);
    const total = Object.values(body.ops.account_health as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBe((await listChannelAccounts(db, ownerA)).length);
    as(B);
    const bodyB = await (await opsSummaryGET(get('/api/ops/summary', tokenB), undefined)).json();
    expect(bodyB.ops.account_health.connected).toBe(0);
    expect(bodyB.ops.account_health.not_connected).toBe(4);
  });
});
