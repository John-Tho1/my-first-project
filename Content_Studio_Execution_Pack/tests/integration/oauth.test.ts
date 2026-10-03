/**
 * T13(결정 D24): 계정 연결(모의 Threads OAuth)·비밀 보호·연결 상태·실행 차단·내보내기/복원 제외.
 * 마스터 키는 시험이 만든 난수(실제 키 아님). 외부 호출 없음(모의 공급자는 프로세스 안).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  commitRestore,
  createContent,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  exportOwner,
  formatRotationReport,
  getAccountHealth,
  oauthTestHooks,
  getDb,
  listChannelAccounts,
  parseBundleZip,
  refreshExpiringCredentials,
  revokeCredential,
  rotateSecretKeys,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildBundle, loadConfig, OAuthProviderError, openSecret, requireSecretKeyring, sealSecret, writeZip, type BundleTables, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, mockOAuthStore, MockThreadsOAuthProvider } from '@cs/providers';
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
import { oauthDeps } from '../../apps/web/lib/oauth';
import { revokeNotice } from '../../apps/web/lib/revoke-view';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

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
  for (const k of Object.keys(oauthTestHooks) as Array<keyof typeof oauthTestHooks>) delete oauthTestHooks[k];
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('전체 흐름 + 비밀이 어디에도 나가지 않음', () => {
  it('connect → 모의 동의 → callback → health → refresh → check → revoke: 토큰·code·verifier 는 응답·감사·내보내기·콘솔·DB 평문 어디에도 없다', async () => {
    const logs: string[] = [];
    // FIX-T13(Q7): 객체 인수도 깊게 직렬화해 검사한다(String() 은 객체 안의 비밀을 놓친다)
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity, getters: true }))).join(' ')));
    }
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

  it('다른 세션(같은 owner 의 새 로그인)으로 callback → oauth_state_invalid, state 는 소비되지 않아 원래 세션은 성공(Codex Q1)', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    const token2 = await login(A);
    const r = await callback(b.location!, token2);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('oauth_state_invalid');
    expect(await credRow(accountId)).toBeNull();
    const st = (await db.select().from(schema.oauthStates).where(eq(schema.oauthStates.channelAccountId, accountId)))[0]!;
    expect(st.usedAt).toBeNull();
    expect((await callback(b.location!)).status).toBe(200);
    expect((await (await callback(b.location!)).json()).error).toBe('oauth_state_used');
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

  // T16: Instagram 모의 연결이 생겨 "지원하지 않는 채널" 예시를 블로그로 바꿨다(같은 단언 — 400 oauth_not_supported).
  // LIVE-T1(D31): 실제 Threads 계정은 조건이 모두 있으면 연결할 수 있게 됐다(그 흐름은 live-threads-oauth.test.ts). 여기서는 조건 하나(앱 시크릿)가
  // 빠졌을 때의 503 거부(빠진 이름만, 연결 요청 행 없음)를 본다 — T13 의 "조건을 모두 넣어도 거부(LIVE_OAUTH_ADAPTER)" 단언은 의도한 동작 변경으로 바꿨다.
  it('지원하지 않는 채널(모의 blog) → 400 oauth_not_supported, 실제 계정 → 준비 조건이 빠지면 503 live_oauth_not_configured', async () => {
    const ig = await connect(acc[ownerA]!.blog);
    expect(ig.status).toBe(400);
    expect((await ig.json()).error).toBe('oauth_not_supported');
    const [live] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: ownerA, platform: 'threads', kind: 'live', externalAccountId: `threads-live-${randomUUID()}`, displayName: '실제 계정 시험 행', state: 'connected' })
      .returning();
    vi.stubEnv('OAUTH_MODE', 'live');
    vi.stubEnv('THREADS_APP_ID', 'placeholder-app-id');
    vi.stubEnv('THREADS_APP_SECRET', '');
    vi.stubEnv('OAUTH_REDIRECT_URI', `${BASE}/api/oauth/callback`);
    vi.stubEnv('OAUTH_LIVE_APPROVAL_REF', 'D99');
    try {
      const r = await connect(live!.id);
      expect(r.status).toBe(503);
      const body = await r.json();
      expect(body.error).toBe('live_oauth_not_configured');
      expect(body.message).toContain('THREADS_APP_SECRET');
      expect(body.message).not.toContain('LIVE_OAUTH_ADAPTER');
      expect(JSON.stringify(body)).not.toContain('placeholder-app-id');
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
  it('연결은 503 secrets_not_configured(요청 행 없음), 계정 목록·상태·계획 만들기는 그대로, 해제는 키 없이 암호문을 지우지 않고 incomplete(차단) — FIX6', async () => {
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
    const credBefore = (await credRow(accountId))!;
    expect(credBefore.encryptedToken).not.toBeNull();
    const rv = await revoke(accountId);
    expect(rv.status).toBe(200);
    // FIX6-T13(Codex review-FIX5-T13 P1 :1541): 키 없이 읽지 못한 현재 토큰은 철회된 것이 아니다 — 암호문을 남기고 차단(incomplete)
    expect(await rv.json()).toMatchObject({ outcome: 'incomplete', remote_revoke: 'skipped_no_key', incomplete_code: 'revoke_current_no_key', account: { usable_for_execution: false } });
    expect(await credRow(accountId)).toMatchObject({
      status: 'revoking',
      revokedAt: null,
      lastErrorCode: 'revoke_current_no_key',
      encryptedToken: credBefore.encryptedToken,
      keyVersion: credBefore.keyVersion,
    });
    // 키를 다시 설정하고 해제하면 같은 작업에 합류해 철회·마무리
    key1();
    const again = await revoke(accountId);
    expect(await again.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'ok', incomplete_code: null });
    expect((await credRow(accountId))!.encryptedToken).toBeNull();
  });

  it('M4UI FIX1: HTML 연결 해제 폼 — incomplete 는 ?revoke=incomplete&revoke_code=<허용 코드>(경고 문구), 끝나면 ?revoked=1', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    useKeys({});
    const htmlRevoke = () =>
      revokePOST(
        new Request(`${BASE}/api/channel-accounts/${accountId}/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
          body: '',
        }),
        ctx(accountId),
      ).then((r) => record('revoke-html', r));
    const r1 = await htmlRevoke();
    expect(r1.status).toBe(303);
    const loc1 = r1.headers.get('location')!;
    expect(loc1).toBe('/settings?revoke=incomplete&revoke_code=revoke_current_no_key#accounts');
    const q1 = new URL(loc1, BASE).searchParams;
    expect(q1.get('revoked')).toBeNull();
    const n1 = revokeNotice({ revoked: q1.get('revoked') ?? undefined, revoke: q1.get('revoke') ?? undefined, code: q1.get('revoke_code') ?? undefined })!;
    expect(n1.warn).toBe(true);
    expect(n1.text).toContain('연결 해제가 끝나지 않았습니다');
    expect(n1.text).toContain('키를 설정하면');
    // 여전히 해제 중(차단) — 암호문 그대로
    expect(await credRow(accountId)).toMatchObject({ status: 'revoking', revokedAt: null, lastErrorCode: 'revoke_current_no_key' });
    // 키를 맞추고 다시 누르면 끝남 → ?revoked=1
    key1();
    const r2 = await htmlRevoke();
    expect(r2.status).toBe(303);
    expect(r2.headers.get('location')).toBe('/settings?revoked=1#accounts');
    expect(revokeNotice({ revoked: '1' })!.warn).toBe(false);
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
    const dry = await rotateSecretKeys(db, requireSecretKeyring(process.env), { dryRun: true });
    expect(dry.credentials.toReseal).toBeGreaterThanOrEqual(2);
    expect(dry.credentials.resealed).toBe(0);
    expect((await credRow(accountId))!.keyVersion).toBe(1);
    const r = await rotateSecretKeys(db, requireSecretKeyring(process.env));
    expect(r.credentials.resealed).toBeGreaterThanOrEqual(2);
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

// ---------------- FIX round 1 (Codex review-T13 + D25) ----------------

/** 모의 공급자에서 이 계정(사용자)에게 아직 유효한 토큰 수 */
async function liveProviderTokens(accountId: string): Promise<number> {
  const user = (await accountRow(accountId)).externalAccountId;
  return [...mockOAuthStore().tokens.values()].filter((t) => t.user === user && !t.revoked).length;
}
const auditDetails = async (accountId: string, action: string) =>
  (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entityId, accountId), eq(schema.auditEvents.action, action)))).map(
    (a) => a.sanitizedDetails as Record<string, unknown>,
  );

describe('FIX P1 #1 — 갱신 vs 키 교체·다시 연결(토큰 세대)', () => {
  it('갱신 중 키 교체(재암호화) → 세대가 그대로라 새 토큰 T2 가 저장되고 유효, 옛 T1 은 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const t1 = await decryptToken(ownerA, accountId);
    const gen1 = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.afterProviderRefresh = async () => {
      useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: KEY1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
      const r = await rotateSecretKeys(db, requireSecretKeyring(process.env));
      expect(r.credentials.resealed).toBeGreaterThanOrEqual(1);
    };
    const res = await refresh(accountId);
    expect(res.status).toBe(200);
    const row = (await credRow(accountId))!;
    expect(row.tokenGeneration).toBe(gen1 + 1);
    expect(row.keyVersion).toBe(2);
    const t2 = await decryptToken(ownerA, accountId);
    expect(t2).not.toBe(t1);
    expect((await check(accountId)).status).toBe(200);
    expect((await getAccountHealth(db, ownerA, accountId)).status).toBe('connected');
    expect(await liveProviderTokens(accountId)).toBe(1);
  });

  it('갱신 중 다시 연결(세대 +1) → 갱신의 새 토큰은 저장하지 않고 공급자에서 철회, 409 credential_changed, 다시 연결 토큰은 유효', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.afterProviderRefresh = async () => {
      delete oauthTestHooks.afterProviderRefresh;
      await connectFully(accountId);
    };
    const res = await refresh(accountId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'credential_refresh_failed', reason: 'credential_changed' });
    expect((await check(accountId)).status).toBe(200);
    expect((await getAccountHealth(db, ownerA, accountId)).status).toBe('connected');
    expect(await liveProviderTokens(accountId)).toBe(1);
    expect((await auditDetails(accountId, 'oauth.refresh_discarded'))[0]).toMatchObject({ reason: 'credential_changed', issued_token_revoke: 'ok' });
  });
});

describe('FIX P1 #2 — 옛 토큰의 확인 결과가 새 연결을 덮지 않음', () => {
  it('확인이 T1 을 읽은 뒤 갱신이 T2 저장(T1 철회) → T1 확인 실패(token_revoked)는 버려지고 T2 는 connected 그대로', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.beforeProviderCheck = async () => {
      delete oauthTestHooks.beforeProviderCheck;
      expect((await refresh(accountId)).status).toBe(200);
    };
    const res = await check(accountId);
    expect(res.status).toBe(200);
    expect((await res.json()).account).toMatchObject({ status: 'connected', last_error_code: null });
    const row = (await credRow(accountId))!;
    expect(row.status).toBe('active');
    expect(row.lastErrorCode).toBeNull();
    expect((await auditDetails(accountId, 'oauth.checked')).some((d) => d.result === 'discarded_stale')).toBe(true);
  });
});

describe('FIX P1 #3 — 연결 해제는 철회한 세대만 지운다', () => {
  it('해제 진행 중(revoking): 갱신 409 credential_busy, 다시 연결 저장도 거부(받은 토큰 철회), 실행 차단 → 해제 완료 ok, 해제 전 연결 요청은 늦게 와도 거부', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const late = await begin(accountId); // 해제 전에 만든 연결 요청
    oauthTestHooks.afterRevokeMarked = async () => {
      delete oauthTestHooks.afterRevokeMarked;
      expect((await getAccountHealth(db, ownerA, accountId)).status).toBe('revoked');
      const rf = await refresh(accountId);
      expect(rf.status).toBe(409);
      expect((await rf.json()).error).toBe('credential_busy');
      const b = await begin(accountId);
      const cb = await callback(b.location!);
      expect(cb.status).toBe(409);
      expect((await cb.json()).error).toBe('credential_busy');
    };
    const rv = await revoke(accountId);
    expect(await rv.json()).toMatchObject({ remote_revoke: 'ok', account: { status: 'revoked' } });
    expect(await liveProviderTokens(accountId)).toBe(0);
    const lateRes = await callback(late.location!);
    expect(lateRes.status).toBe(400);
    expect(['oauth_state_used', 'oauth_state_invalid']).toContain((await lateRes.json()).error);
    expect((await credRow(accountId))!.revokedAt).not.toBeNull();
  });

  it('해제가 읽은 뒤 세대가 바뀌면 지우지 않고 incomplete(계속 차단), 다시 해제하면 마무리', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.afterRevokeMarked = async () => {
      delete oauthTestHooks.afterRevokeMarked;
      await db.update(schema.oauthCredentials).set({ tokenGeneration: 99 }).where(eq(schema.oauthCredentials.channelAccountId, accountId));
    };
    const rv = await revoke(accountId);
    expect((await rv.json()).remote_revoke).toBe('incomplete');
    const row = (await credRow(accountId))!;
    expect(row.status).toBe('revoking');
    expect(row.encryptedToken).not.toBeNull();
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    const again = await revoke(accountId);
    expect(again.status).toBe(200);
    expect((await credRow(accountId))!.revokedAt).not.toBeNull();
  });

  it('해제가 먼저 커밋되면(revoking) 작업 처리기는 전송 의도를 만들지 않는다', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const { planId, itemId } = await approvedPlanFor(accountId);
    expect((await execute(planId)).status).toBe(200);
    await db.update(schema.oauthCredentials).set({ status: 'revoking' }).where(eq(schema.oauthCredentials.channelAccountId, accountId));
    await tick();
    const job = (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)))[0]!;
    expect(job.state).toBe('BLOCKED');
    expect(job.lastErrorCode).toBe('credential_revoked');
    expect(await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job.id))).toHaveLength(0);
  });
});

describe('FIX — 교환 뒤 실패·늦은 callback', () => {
  it('교환 성공 뒤 계정 정보 실패 → 400, 받은 토큰은 공급자에서 철회', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    mockOAuthStore().failNext = { op: 'account', code: 'provider_error' };
    const r = await callback(b.location!);
    expect(r.status).toBe(400);
    expect(await credRow(accountId)).toBeNull();
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect((await auditDetails(accountId, 'oauth.callback_rejected')).some((d) => d.reason === 'account_info_failed' && d.issued_token_revoke === 'ok')).toBe(true);
  });

  it('DB 저장 실패(예외) → 500 일반 오류(헤더 no-referrer·no-store), 받은 토큰 철회, 저장 없음', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    oauthTestHooks.beforeCallbackStore = async () => {
      throw new Error('simulated db failure');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await callback(b.location!);
    errors.mockRestore();
    expect(r.status).toBe(500);
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await credRow(accountId)).toBeNull();
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect((await auditDetails(accountId, 'oauth.callback_rejected')).some((d) => d.reason === 'store_failed' && d.issued_token_revoke === 'ok')).toBe(true);
  });

  it('저장 직전에 연결 해제가 끼어듦(요청 뒤 해제) → 저장 거부, 받은 토큰 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const b = await begin(accountId);
    oauthTestHooks.beforeCallbackStore = async () => {
      delete oauthTestHooks.beforeCallbackStore;
      await new Promise((r) => setTimeout(r, 5));
      expect((await revoke(accountId)).status).toBe(200);
    };
    const r = await callback(b.location!);
    expect(r.status).toBe(400);
    expect((await credRow(accountId))!.revokedAt).not.toBeNull();
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});

describe('FIX Q7 — callback·동의 화면 응답 헤더', () => {
  it('비로그인·HTML 실패·HTML 성공·동의 화면 400·303·비로그인 모두 Referrer-Policy no-referrer, Cache-Control no-store', async () => {
    const accountId = await newThreadsAccount();
    const responses: Response[] = [];
    responses.push(await callbackGET(new Request(`${BASE}/api/oauth/callback?state=x&code=y`, { headers: { accept: 'application/json' } })));
    responses.push(await callbackGET(new Request(`${BASE}/api/oauth/callback?state=x&code=y`, { headers: { accept: 'text/html', ...cookieHeader(tokenA) } })));
    const b = await begin(accountId);
    responses.push(b.authorizeRes);
    const ok = await callbackGET(new Request(b.location!, { headers: { accept: 'text/html', ...cookieHeader(tokenA) } }));
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/settings?connected=1#accounts');
    responses.push(ok);
    const c = (await (await connect(accountId)).json()).authorize_url as string;
    responses.push(await authorize(c, { redirect_uri: 'http://evil.example.test/cb' }));
    responses.push(await mockAuthorizeGET(new Request(c, { headers: { accept: 'application/json' } })));
    expect(responses[0]!.status).toBe(401);
    expect(responses[1]!.status).toBe(303);
    expect(responses[5]!.status).toBe(401);
    for (const r of responses) {
      expect(r.headers.get('referrer-policy'), String(r.status)).toBe('no-referrer');
      expect(r.headers.get('cache-control'), String(r.status)).toBe('no-store');
    }
  });
});

describe('D25-3 — 모의 시험 매개변수는 운영에서 거부', () => {
  it('NODE_ENV=production: mock_user·mock_grant·mock_deny → 400 mock_params_not_allowed, 매개변수 없으면 정상 303', async () => {
    const accountId = await newThreadsAccount();
    vi.stubEnv('NODE_ENV', 'production');
    try {
      for (const p of [{ mock_user: 'mock:threads:other' }, { mock_grant: 'threads_basic' }, { mock_deny: '1' }] as Array<Record<string, string>>) {
        const url = (await (await connect(accountId)).json()).authorize_url as string;
        const r = await authorize(url, p);
        expect(r.status).toBe(400);
        expect((await r.json()).error).toBe('mock_params_not_allowed');
      }
      const url = (await (await connect(accountId)).json()).authorize_url as string;
      expect((await authorize(url)).status).toBe(303);
    } finally {
      vi.stubEnv('NODE_ENV', 'test');
    }
    const url = (await (await connect(accountId)).json()).authorize_url as string;
    expect((await authorize(url, { mock_deny: '1' })).status).toBe(303);
  });
});

describe('FIX Q6·D25-5 — 키 교체는 모든 봉인을 검사', () => {
  it('현재 버전 행의 손상 태그·열/봉투 버전 불일치를 failed(종류별)로 세고 그대로 둔다, 미리보기는 변경 없음, 출력에 암호문·키 없음', async () => {
    const good = await newThreadsAccount();
    const bad = await newThreadsAccount();
    const mism = await newThreadsAccount();
    for (const a of [good, bad, mism]) await connectFully(a);
    const cb = (await credRow(bad))!;
    const parts = cb.encryptedToken!.split(':');
    parts[4] = (parts[4]![0] === 'A' ? 'B' : 'A') + parts[4]!.slice(1);
    await db.update(schema.oauthCredentials).set({ encryptedToken: parts.join(':') }).where(eq(schema.oauthCredentials.channelAccountId, bad));
    const cm = (await credRow(mism))!;
    await db.update(schema.oauthCredentials).set({ encryptedToken: cm.encryptedToken!.replace(/^csk1:1:/, 'csk1:7:') }).where(eq(schema.oauthCredentials.channelAccountId, mism));
    const before = JSON.stringify(await db.select().from(schema.oauthCredentials));
    const dry = await rotateSecretKeys(db, requireSecretKeyring(process.env), { dryRun: true });
    expect(dry.credentials.failed.auth_failed).toBeGreaterThanOrEqual(1);
    expect(dry.credentials.failed.version_mismatch).toBeGreaterThanOrEqual(1);
    expect(dry.credentials.alreadyCurrent).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(await db.select().from(schema.oauthCredentials))).toBe(before);
    const text = formatRotationReport(dry);
    expect(text).toContain('미리보기');
    expect(text).toContain('auth_failed');
    for (const r of await db.select().from(schema.oauthCredentials)) if (r.encryptedToken) expect(text).not.toContain(r.encryptedToken);
    expect(text).not.toContain(KEY1);
    for (const a of [bad, mism]) expect((await revoke(a)).status).toBe(200);
  });
});

describe('FIX P1 #4 — 복원의 연결 이력 규칙', () => {
  it('add_missing: 로컬 none + 묶음 linked → needs_reconnect(미리보기·결과에 보고), 로컬 linked 는 그대로', async () => {
    const x = await newThreadsAccount();
    const y = await newThreadsAccount();
    await connectFully(x);
    await connectFully(y);
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'exp-p14') });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    // x 를 "연결 전 상태"(none, 연결 정보 없음)로 — 연결 전 백업을 복원한 대상 DB 를 흉내
    await db.delete(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, x));
    await db.update(schema.channelAccounts).set({ credentialState: 'none' }).where(eq(schema.channelAccounts.id, x));
    expect((await getAccountHealth(db, ownerA, x)).status).toBe('not_connected');
    const restoresDir = path.join(tmp, 'restores-p14');
    const p = await createRestorePreview(db, ownerA, zip, { restoresDir, source: 'upload' });
    expect(p.preview.reconnect_required_accounts).toContain(x);
    expect(p.preview.reconnect_required_accounts).not.toContain(y);
    expect((await accountRow(x)).credentialState).toBe('none');
    const r = await commitRestore(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, p.restoreId, { mode: 'add_missing', confirm: true, restoresDir });
    expect(r.reconnect_required_accounts).toContain(x);
    expect((await accountRow(x)).credentialState).toBe('needs_reconnect');
    expect(await getAccountHealth(db, ownerA, x)).toMatchObject({ status: 'needs_reconnect', usable_for_execution: false });
    expect((await accountRow(y)).credentialState).toBe('linked');
    expect((await getAccountHealth(db, ownerA, y)).status).toBe('connected');
  });

  it('0027 이전 묶음(credential_state 없음)도 복원되고 none', async () => {
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'exp-pre27') });
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const tables = structuredClone(parsed.tables) as BundleTables;
    for (const a of tables.channel_accounts as unknown as Array<Record<string, unknown>>) delete a.credential_state;
    const zip = writeZip(
      buildBundle({
        exportId: randomUUID(),
        exportedAt: new Date().toISOString(),
        appVersion: parsed.manifest.app_version,
        migrations: parsed.manifest.schema_migrations.filter((m) => m < '0027'),
        owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
        tables,
        assetBytes: new Map(parsed.assetBytes),
      }).entries,
    );
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-pre27@example.local')).id;
      const restoresDir = path.join(tmp, 'restores-pre27');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-pre27')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.restored.channel_accounts).toBeGreaterThan(0);
      expect(r.reconnect_required_accounts).toEqual([]);
      const states = new Set((await h.db.select().from(schema.channelAccounts)).map((a) => a.credentialState));
      expect([...states]).toEqual(['none']);
    } finally {
      await h.close();
    }
  });
});

// ---------------- FIX round 2 (Codex review-FIX-T13) ----------------

const KEY3 = randomBytes(32).toString('base64');
const deps = () => oauthDeps(loadConfig());
const stateRowsOf = (accountId: string) => db.select().from(schema.oauthStates).where(eq(schema.oauthStates.channelAccountId, accountId));

describe('FIX2 P1 :439 — 해제 세대(revocation_epoch)', () => {
  it('callback A 가 state 를 소비하고 멈춘 사이 해제 + 다시 연결 B 완료 → A 는 거부, B 의 토큰·scope 그대로, A 의 토큰은 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const a = await begin(accountId, { mock_grant: 'threads_basic' }); // A 는 일부 scope 만
    let bToken = '';
    oauthTestHooks.beforeCallbackStore = async () => {
      delete oauthTestHooks.beforeCallbackStore;
      expect((await revoke(accountId)).status).toBe(200);
      await connectFully(accountId); // B
      bToken = await decryptToken(ownerA, accountId);
    };
    const r = await callback(a.location!);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: 'oauth_state_invalid', reason: 'revoked_after_request' });
    const row = (await credRow(accountId))!;
    expect(row.status).toBe('active');
    expect(row.scopes).toEqual(['threads_basic', 'threads_content_publish']);
    expect(await decryptToken(ownerA, accountId)).toBe(bToken);
    expect(row.revocationEpoch).toBe(1);
    expect(await liveProviderTokens(accountId)).toBe(1);
    expect((await auditDetails(accountId, 'oauth.callback_rejected')).some((d) => d.reason === 'store_failed' && d.issued_token_revoke === 'ok')).toBe(true);
  });

  it('같은 밀리초: 해제 시각 = 연결 요청 발급 시각이어도 해제 세대로 거부(시각 비교 없음)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const a = await begin(accountId);
    const st = (await stateRowsOf(accountId)).find((s) => s.usedAt === null)!;
    oauthTestHooks.beforeCallbackStore = async () => {
      delete oauthTestHooks.beforeCallbackStore;
      const d = deps();
      const rv = await revokeCredential(db, { ownerId: ownerA, accountId, providerFor: d.providerFor, keyring: d.keyring, now: st.createdAt });
      expect(rv.outcome).toBe('revoked');
      expect((await credRow(accountId))!.revokedAt!.getTime()).toBe(st.createdAt.getTime());
    };
    const r = await callback(a.location!);
    expect(r.status).toBe(400);
    expect((await credRow(accountId))!.revokedAt).not.toBeNull();
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});

describe('FIX2 P1 :737 — 해제 작업 ID(revoke_op_id)', () => {
  it('A 가 revoking 표시 후 멈춤 → B 가 같은 작업에 합류해 완료 → C 다시 연결 → A 는 superseded, C 는 그대로 active', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    let cGen = 0;
    oauthTestHooks.afterRevokeMarked = async () => {
      delete oauthTestHooks.afterRevokeMarked;
      const b = await revoke(accountId);
      expect(await b.json()).toMatchObject({ outcome: 'revoked' });
      await connectFully(accountId); // C
      cGen = (await credRow(accountId))!.tokenGeneration;
    };
    const a = await revoke(accountId);
    expect(await a.json()).toMatchObject({ outcome: 'superseded', remote_revoke: 'superseded', account: { status: 'connected' } });
    const row = (await credRow(accountId))!;
    expect(row.status).toBe('active');
    expect(row.tokenGeneration).toBe(cGen);
    expect(row.revokeOpId).toBeNull();
    expect(row.revocationEpoch).toBe(1); // 합류한 B 는 세대를 다시 올리지 않음
    expect(await liveProviderTokens(accountId)).toBe(1);
  });

  it('A 가 멈춘 사이 B 가 합류해 완료(다시 연결 없음) → A 는 completed_by_other, 해제 상태 그대로', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.afterRevokeMarked = async () => {
      delete oauthTestHooks.afterRevokeMarked;
      expect((await (await revoke(accountId)).json()).outcome).toBe('revoked');
    };
    const a = await revoke(accountId);
    expect(await a.json()).toMatchObject({ outcome: 'completed_by_other', account: { status: 'revoked' } });
    expect((await credRow(accountId))!.revokedAt).not.toBeNull();
  });

  it('incomplete 는 자기 작업이 현재일 때만: revoking·암호문 유지(차단), 다시 해제하면 같은 작업에 합류해 revoked', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.afterRevokeMarked = async () => {
      delete oauthTestHooks.afterRevokeMarked;
      await db.update(schema.oauthCredentials).set({ tokenGeneration: 42 }).where(eq(schema.oauthCredentials.channelAccountId, accountId));
    };
    const a = await (await revoke(accountId)).json();
    expect(a).toMatchObject({ outcome: 'incomplete', remote_revoke: 'incomplete' });
    const op = (await credRow(accountId))!.revokeOpId;
    expect(op).not.toBeNull();
    expect((await credRow(accountId))!.status).toBe('revoking');
    const again = await (await revoke(accountId)).json();
    expect(again.outcome).toBe('revoked');
    expect((await credRow(accountId))!.revokeOpId).toBe(op);
    expect((await credRow(accountId))!.revocationEpoch).toBe(1);
  });
});

describe('FIX2 P1 :575 — 갱신 발급 뒤 봉인·저장 실패', () => {
  it('봉인 전 실패 → 저장 안 됨 확인 → T2 철회, 409 store_failed, 세대 그대로', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.beforeRefreshSeal = async () => {
      throw new Error('simulated seal failure');
    };
    const r = await refresh(accountId);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: 'credential_refresh_failed', reason: 'store_failed' });
    expect((await credRow(accountId))!.tokenGeneration).toBe(gen);
    expect(await liveProviderTokens(accountId)).toBe(0); // T1 은 공급자가 갱신 때 철회, T2 는 우리가 철회
    expect((await auditDetails(accountId, 'oauth.refresh_discarded')).some((d) => d.reason === 'store_failed' && d.issued_token_revoke === 'ok')).toBe(true);
  });

  it('저장 트랜잭션 안(감사 INSERT 자리) 실패 → 되돌림 → T2 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('simulated audit insert failure');
    };
    const r = await refresh(accountId);
    expect((await r.json()).reason).toBe('store_failed');
    expect((await credRow(accountId))!.tokenGeneration).toBe(gen);
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('커밋 뒤 예외(결과 불명) → 다시 읽어 저장 확인 → 성공으로 돌려줌, T2 유지', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.afterRefreshStoreCommit = async () => {
      throw new Error('simulated lost commit ack');
    };
    const r = await refresh(accountId);
    expect(r.status).toBe(200);
    expect((await credRow(accountId))!.tokenGeneration).toBe(gen + 1);
    expect(await liveProviderTokens(accountId)).toBe(1);
  });

  it('다시 읽어도 판정할 수 없으면(봉인 바뀜 + 열 수 없음) 철회하지 않고 409 store_outcome_unknown', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.afterRefreshStoreCommit = async () => {
      delete oauthTestHooks.afterRefreshStoreCommit;
      useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: KEY1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
      await rotateSecretKeys(db, requireSecretKeyring(process.env));
      useKeys({ SECRETS_MASTER_KEY: KEY3, SECRETS_KEY_VERSION: '3' });
      throw new Error('simulated lost commit ack');
    };
    const r = await refresh(accountId);
    expect(r.status).toBe(409);
    expect((await r.json()).reason).toBe('store_outcome_unknown');
    expect(await liveProviderTokens(accountId)).toBe(1);
  });

  it('callback: 저장 트랜잭션 안 실패 → 저장 안 됨 → 받은 토큰 철회', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    oauthTestHooks.insideCallbackStore = async () => {
      throw new Error('simulated audit insert failure');
    };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await callback(b.location!);
    errors.mockRestore();
    expect(r.status).toBe(500);
    expect(await credRow(accountId)).toBeNull();
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});

describe('FIX2 — 키 교체 집계: 훑은 뒤 바뀐 행은 skipped_changed', () => {
  it('연결 요청이 갱신 전에 소비되면 resealed 로 세지 않는다', async () => {
    const accountId = await newThreadsAccount();
    await begin(accountId);
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: KEY1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
    oauthTestHooks.beforeRotateStateUpdate = async () => {
      delete oauthTestHooks.beforeRotateStateUpdate;
      await db.update(schema.oauthStates).set({ usedAt: new Date() }).where(isNullUsed());
    };
    const r = await rotateSecretKeys(db, requireSecretKeyring(process.env));
    expect(r.states.toReseal).toBeGreaterThanOrEqual(1);
    expect(r.states.skippedChanged).toBe(r.states.toReseal);
    expect(r.states.resealed).toBe(0);
    expect(formatRotationReport(r)).toContain('그 사이 바뀌어 건너뜀');
  });
});

function isNullUsed() {
  return isNull(schema.oauthStates.usedAt);
}

describe('FIX2 Q7 — 실패 경로의 콘솔 출력에도 비밀 없음', () => {
  it('저장 실패(500) callback: console.error 를 깊게 직렬화해 code·state·verifier·발급 토큰을 찾는다 — 없음', async () => {
    const accountId = await newThreadsAccount();
    const b = await begin(accountId);
    const st = (await stateRowsOf(accountId)).find((s) => s.usedAt === null)!;
    const verifier = openSecret(requireSecretKeyring(process.env), st.encryptedVerifier, st.keyVersion, { ownerId: ownerA, channelAccountId: accountId, purpose: 'pkce_verifier', scopeId: st.id });
    const issued: string[] = [];
    const orig = MockThreadsOAuthProvider.prototype.exchangeCode;
    const spyEx = vi.spyOn(MockThreadsOAuthProvider.prototype, 'exchangeCode').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
      const t = await orig.call(this, input);
      issued.push(t.accessToken);
      return t;
    });
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((x) => (typeof x === 'string' ? x : inspect(x, { depth: Infinity }))).join(' ')));
    }
    oauthTestHooks.beforeCallbackStore = async () => {
      throw Object.assign(new Error(`db failure while storing ${b.state}`), { code: 'XX000' });
    };
    const r = await callback(b.location!);
    vi.restoreAllMocks();
    spyEx.mockRestore();
    expect(r.status).toBe(500);
    const body = await r.text();
    const code = new URL(b.location!).searchParams.get('code')!;
    expect(issued).toHaveLength(1);
    expect(logs.length).toBeGreaterThan(0);
    const audits = JSON.stringify(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, accountId)));
    for (const [name, v] of Object.entries({ code, state: b.state, verifier, token: issued[0]! })) {
      expect(logs.join('\n').includes(v), `${name} in console`).toBe(false);
      expect(body.includes(v), `${name} in body`).toBe(false);
      expect(audits.includes(v), `${name} in audit`).toBe(false);
    }
  });
});

// ---------------- FIX round 3 (Codex review-FIX2-T13) ----------------

/** 모의 공급자에서 이 사용자(external id)에게 아직 유효한 토큰 수 */
const liveTokensOfUser = (user: string) => [...mockOAuthStore().tokens.values()].filter((t) => t.user === user && !t.revoked).length;
/** FIX4-T13: 정리 대기 행(oauth_pending_tokens) — 계정마다 여러 건, 만든 순서 */
const pendingRows = (accountId: string) =>
  db
    .select()
    .from(schema.oauthPendingTokens)
    .where(eq(schema.oauthPendingTokens.channelAccountId, accountId))
    .orderBy(asc(schema.oauthPendingTokens.createdAt), asc(schema.oauthPendingTokens.id));
/** 첫 정리 대기 행(없으면 null) — FIX3 시험의 단일 표시 모양 그대로 */
const pendingOf = async (accountId: string) => {
  const c = (await pendingRows(accountId))[0];
  return c ? { opId: c.id, kind: c.kind, token: c.sealedToken, keyVersion: c.keyVersion } : null;
};
const jobOfItem = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)))[0]!;
const intentsOfJob = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId));
const retry = (itemId: string) => retryPOST(jsonPost(`/api/distribution-items/${itemId}/retry`, {}, cookieHeader(tokenA)), ctx(itemId));
/** 갱신이 공급자에서 받은 새 토큰(T2)을 엿본다(시험만 — 비밀 검사·판정용) */
function spyIssuedRefreshTokens(): string[] {
  const issued: string[] = [];
  const orig = MockThreadsOAuthProvider.prototype.refresh;
  vi.spyOn(MockThreadsOAuthProvider.prototype, 'refresh').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
    const t = await orig.call(this, input);
    issued.push(t.accessToken);
    return t;
  });
  return issued;
}

/**
 * 실행 경로 전체가 막혔는지: health 사용 불가 · 새 계획 실행 409(작업 0) · 이미 대기 중인 작업은 tick 에서 BLOCKED(전송 의도 0) · 재시도 409.
 * queued = 실패 전에 실행해 둔 계획의 항목, fresh = 승인만 된 계획.
 */
async function expectExecutionBlocked(accountId: string, queued: { itemId: string }, fresh: { planId: string; itemId: string }) {
  const hv = (await (await health(accountId)).json()).account;
  expect(hv).toMatchObject({ usable_for_execution: false, status: 'error' });
  const ex = await execute(fresh.planId);
  expect(ex.status).toBe(409);
  expect((await ex.json()).error).toBe('account_credential_blocked');
  expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, fresh.itemId))).toHaveLength(0);
  await tick();
  const job = await jobOfItem(queued.itemId);
  expect(job.state).toBe('BLOCKED');
  expect(job.lastErrorCode).toBe('credential_error');
  expect(await intentsOfJob(job.id)).toHaveLength(0);
  const rt = await retry(queued.itemId);
  expect(rt.status).toBe(409);
  expect((await rt.json()).error).toBe('account_credential_blocked');
}

/** 연결 + 실행해 둔 계획(작업 QUEUED) + 승인만 된 계획 */
async function connectedWithPlans(accountId: string) {
  await connectFully(accountId);
  const queued = await approvedPlanFor(accountId);
  expect((await execute(queued.planId)).status).toBe(200);
  const fresh = await approvedPlanFor(accountId);
  return { queued, fresh };
}

describe('FIX3 P1 :690 — 저장 안 됨이 확인된 갱신 실패는 수동 확인 없이 실행 차단', () => {
  it('봉인 실패 → T2 철회 + 읽은 세대에서 error(refresh_store_failed): health 사용 불가·execute 409·worker BLOCKED·의도 0·재시도 409', async () => {
    const accountId = await newThreadsAccount();
    const { queued, fresh } = await connectedWithPlans(accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.beforeRefreshSeal = async () => {
      throw new Error('simulated seal failure');
    };
    const r = await refresh(accountId);
    expect(r.status).toBe(409);
    expect((await r.json()).reason).toBe('store_failed');
    const row = (await credRow(accountId))!;
    expect(row).toMatchObject({ status: 'error', lastErrorCode: 'refresh_store_failed', tokenGeneration: gen });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect((await auditDetails(accountId, 'oauth.refresh_discarded')).at(-1)).toMatchObject({ reason: 'store_failed', issued_token_revoke: 'ok', credential_marked: 'refresh_store_failed' });
    await expectExecutionBlocked(accountId, queued, fresh);
    expect((await getAccountHealth(db, ownerA, accountId)).reason).toBe('refresh_store_failed');
    // 다시 연결하면 풀린다
    await connectFully(accountId);
    expect((await execute(fresh.planId)).status).toBe(200);
  });

  it('저장 트랜잭션 안 실패(되돌림) → 같은 결과: error(refresh_store_failed), 실행 경로 전부 차단', async () => {
    const accountId = await newThreadsAccount();
    const { queued, fresh } = await connectedWithPlans(accountId);
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('simulated audit insert failure');
    };
    const r = await refresh(accountId);
    expect((await r.json()).reason).toBe('store_failed');
    expect(await credRow(accountId)).toMatchObject({ status: 'error', lastErrorCode: 'refresh_store_failed' });
    expect(await liveProviderTokens(accountId)).toBe(0);
    await expectExecutionBlocked(accountId, queued, fresh);
  });

  it('저장 실패 직후(표시 전) 다시 연결이 새 세대를 저장 → 새 세대는 그대로 active·사용 가능, T2 만 철회', async () => {
    const accountId = await newThreadsAccount();
    const { fresh } = await connectedWithPlans(accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('simulated audit insert failure');
    };
    oauthTestHooks.beforeStoredOutcomeRead = async () => {
      delete oauthTestHooks.beforeStoredOutcomeRead;
      delete oauthTestHooks.insideRefreshStore;
      await connectFully(accountId); // 세대 +1(다시 연결)
    };
    const r = await refresh(accountId);
    expect((await r.json()).reason).toBe('store_failed');
    const row = (await credRow(accountId))!;
    expect(row).toMatchObject({ status: 'active', lastErrorCode: null, tokenGeneration: gen + 1 });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(1); // 다시 연결 토큰만
    expect((await auditDetails(accountId, 'oauth.refresh_discarded')).at(-1)).toMatchObject({ reason: 'store_failed', issued_token_revoke: 'ok', credential_marked: 'not_marked' });
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(true);
    expect((await execute(fresh.planId)).status).toBe(200);
  });
});

describe('FIX3 Q14 — 저장 결과 불명은 정리 대기(refresh_unknown)로 남기고 차단, 다음 확인이 정리', () => {
  it('되돌림 + 다시 읽기 실패 → 봉인한 T2 기록·차단(의도 0) → check 가 T2 철회·C 무효 → error(refresh_store_failed); 비밀은 응답·감사·콘솔에 없음', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity, getters: true }))).join(' ')));
    }
    const issued = spyIssuedRefreshTokens();
    seen.length = 0;
    const accountId = await newThreadsAccount();
    const { queued, fresh } = await connectedWithPlans(accountId);
    const t1 = await decryptToken(ownerA, accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error(`simulated rollback ${t1}`);
    };
    oauthTestHooks.beforeStoredOutcomeRead = async () => {
      throw new Error('simulated re-read failure');
    };
    const r = await refresh(accountId);
    delete oauthTestHooks.insideRefreshStore;
    delete oauthTestHooks.beforeStoredOutcomeRead;
    expect(r.status).toBe(409);
    expect((await r.json()).reason).toBe('store_outcome_unknown');
    expect(issued).toHaveLength(1);
    const t2 = issued[0]!;
    const p = (await pendingOf(accountId))!;
    expect(p.kind).toBe('refresh_unknown');
    expect(p.opId).toBeTruthy();
    expect(p.token!.startsWith('csk1:')).toBe(true);
    expect(p.keyVersion).toBe(1);
    expect(p.token).not.toContain(t2);
    // 봉인은 T2 이고(AAD purpose oauth_pending_token) 저장된 토큰은 여전히 T1(세대 그대로)
    expect(JSON.parse(openSecret(requireSecretKeyring(process.env), p.token!, 1, { ownerId: ownerA, channelAccountId: accountId, purpose: 'oauth_pending_token' })).access_token).toBe(t2);
    expect((await credRow(accountId))!).toMatchObject({ tokenGeneration: gen, status: 'active' });
    expect(liveTokensOfUser((await accountRow(accountId)).externalAccountId)).toBe(1); // T2 만 살아 있음(저장됐을 수 있어 철회 안 함)
    expect((await auditDetails(accountId, 'oauth.refresh_failed')).at(-1)).toMatchObject({ error_code: 'store_outcome_unknown', pending_record: 'recorded', pending_kind: 'refresh_unknown' });
    // 표시가 있는 동안: health error(pending_refresh_unknown), 실행 경로 전부 차단
    expect((await getAccountHealth(db, ownerA, accountId)).reason).toBe('pending_refresh_unknown');
    await expectExecutionBlocked(accountId, queued, fresh);

    // 다음 확인이 정리: C(T1) != P(T2) → T2 철회, C 는 공급자가 갱신 때 무효로 함 → error(refresh_store_failed)
    const ck = await check(accountId);
    expect(ck.status).toBe(200);
    expect((await ck.json()).account).toMatchObject({ status: 'error', reason: 'refresh_store_failed', pending_reconcile: null, usable_for_execution: false });
    expect(await pendingOf(accountId)).toBeNull();
    expect(liveTokensOfUser((await accountRow(accountId)).externalAccountId)).toBe(0);
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({
      kind: 'refresh_unknown',
      result: 'resolved',
      stored_was_pending: false,
      issued_token_revoke: 'ok',
      current_token_valid: 'no',
      status: 'error',
    });
    // 비밀 검사: T1·T2·봉인(P)은 응답·감사·콘솔 어디에도 없다
    const audits = JSON.stringify(await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, accountId)));
    vi.restoreAllMocks();
    for (const [name, v] of Object.entries({ t1, t2, pending: p.token!, pendingOp: p.opId! })) {
      for (const s of seen) expect(s.text.includes(v), `${name} in ${s.label}`).toBe(false);
      expect(audits.includes(v), `${name} in audit`).toBe(false);
      expect(logs.join('\n').includes(v), `${name} in console`).toBe(false);
    }
    // 다시 연결하면 풀린다
    await connectFully(accountId);
    expect((await execute(fresh.planId)).status).toBe(200);
  });

  it('커밋됐는데 다시 읽기 실패 → refresh_unknown(세대 +1) → check: 저장된 토큰 == T2 → 철회하지 않고 유지·active, 실행 가능', async () => {
    const accountId = await newThreadsAccount();
    const { fresh } = await connectedWithPlans(accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    oauthTestHooks.afterRefreshStoreCommit = async () => {
      throw new Error('simulated lost commit ack');
    };
    oauthTestHooks.beforeStoredOutcomeRead = async () => {
      throw new Error('simulated re-read failure');
    };
    const r = await refresh(accountId);
    delete oauthTestHooks.afterRefreshStoreCommit;
    delete oauthTestHooks.beforeStoredOutcomeRead;
    expect((await r.json()).reason).toBe('store_outcome_unknown');
    expect((await credRow(accountId))!.tokenGeneration).toBe(gen + 1);
    expect((await pendingOf(accountId))!.kind).toBe('refresh_unknown');
    expect((await execute(fresh.planId)).status).toBe(409);
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'connected', usable_for_execution: true, pending_reconcile: null });
    expect(await liveProviderTokens(accountId)).toBe(1);
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({ stored_was_pending: true, issued_token_revoke: 'not_needed', current_token_valid: 'yes', status: 'active' });
    expect((await execute(fresh.planId)).status).toBe(200);
  });

  it('표시 뒤 다시 연결(새 토큰 C 유효) → check: C != P → P 철회, C 유지 active(새 세대 그대로)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('rollback');
    };
    oauthTestHooks.beforeStoredOutcomeRead = async () => {
      throw new Error('re-read failure');
    };
    await refresh(accountId);
    delete oauthTestHooks.insideRefreshStore;
    delete oauthTestHooks.beforeStoredOutcomeRead;
    expect((await pendingOf(accountId))!.kind).toBe('refresh_unknown');
    await connectFully(accountId); // 다시 연결은 표시를 지우지 않는다(정리 전까지 차단)
    const gen = (await credRow(accountId))!.tokenGeneration;
    expect((await pendingOf(accountId))!.kind).toBe('refresh_unknown');
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    expect(await liveProviderTokens(accountId)).toBe(2); // 다시 연결 토큰 + P
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'connected', usable_for_execution: true });
    expect((await credRow(accountId))!).toMatchObject({ tokenGeneration: gen });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(1);
  });

  it('정리 대기 기록 자체가 실패 → 감사 pending_record_failed, 가능하면 error(refresh_pending_record_failed)로 차단', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('rollback');
    };
    oauthTestHooks.beforeStoredOutcomeRead = async () => {
      throw new Error('re-read failure');
    };
    oauthTestHooks.insidePendingRecord = async () => {
      throw new Error('pending write failure');
    };
    const r = await refresh(accountId);
    expect((await r.json()).reason).toBe('store_outcome_unknown');
    expect(await credRow(accountId)).toMatchObject({ status: 'error', lastErrorCode: 'refresh_pending_record_failed' });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    expect((await auditDetails(accountId, 'oauth.pending_record_failed')).at(-1)).toMatchObject({ context: 'refresh', error_code: 'refresh_pending_record_failed', result: 'write_failed' });
  });

  it('키 교체가 pending_token 도 다시 봉인(미리보기는 변경 없음), 새 키만으로 정리 가능; 내보내기 묶음에 연결 정보·봉인·T2 없음', async () => {
    const issued = spyIssuedRefreshTokens();
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('rollback');
    };
    oauthTestHooks.beforeStoredOutcomeRead = async () => {
      throw new Error('re-read failure');
    };
    await refresh(accountId);
    delete oauthTestHooks.insideRefreshStore;
    delete oauthTestHooks.beforeStoredOutcomeRead;
    vi.restoreAllMocks();
    const t2 = issued[0]!;
    const before = (await pendingOf(accountId))!;
    expect(before.keyVersion).toBe(1);

    // 내보내기: oauth_credentials(새 열 포함)는 묶음 밖
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'exp-fix3') });
    const zipText = Buffer.from(readFileSync(exported.zipPath)).toString('latin1');
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const bundleText = JSON.stringify(parsed.tables) + JSON.stringify(parsed.manifest);
    expect(parsed.manifest.excluded_tables).toContain('oauth_credentials');
    expect(Object.keys(parsed.tables)).not.toContain('oauth_credentials');
    // FIX4-T13: 정리 대기 표(oauth_pending_tokens)도 묶음 밖
    expect(parsed.manifest.excluded_tables).toContain('oauth_pending_tokens');
    expect(Object.keys(parsed.tables)).not.toContain('oauth_pending_tokens');
    for (const [name, v] of Object.entries({ t2, pending: before.token!, op: before.opId! })) {
      expect(bundleText.includes(v), `${name} in bundle`).toBe(false);
      expect(zipText.includes(v), `${name} in zip`).toBe(false);
    }
    // 연결 정보 행의 비밀·식별 열(JSON 키)도 없다(감사 세부의 pending_token_revoke·pending_kind 같은 결과 코드와 구분해 정확한 키로 검사)
    for (const col of ['pending_token', 'pending_op_id', 'pending_key_version', 'encrypted_token', 'sealed_token', 'on_invalid_code', 'next_attempt_at']) expect(bundleText.includes(`"${col}":`), col).toBe(false);

    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: KEY1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
    const dry = await rotateSecretKeys(db, requireSecretKeyring(process.env), { dryRun: true });
    expect(dry.pendingTokens.toReseal).toBeGreaterThanOrEqual(1);
    expect(dry.pendingTokens.resealed).toBe(0);
    expect(await pendingOf(accountId)).toEqual(before);
    const applied = await rotateSecretKeys(db, requireSecretKeyring(process.env));
    expect(applied.pendingTokens.resealed).toBeGreaterThanOrEqual(1);
    const report = formatRotationReport(applied);
    expect(report).toContain('정리 대기 봉인');
    for (const v of [t2, before.token!, KEY1, KEY2]) expect(report.includes(v)).toBe(false);
    const after = (await pendingOf(accountId))!;
    expect(after).toMatchObject({ opId: before.opId, kind: 'refresh_unknown', keyVersion: 2 });
    expect(after.token).not.toBe(before.token);
    // 이전 키를 빼도(새 키만) 정리 가능 — 봉인이 새 키로 바뀌었으므로
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2' });
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'error', reason: 'refresh_store_failed', pending_reconcile: null });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});

describe('FIX3 놓친 케이스 — 정리 철회 실패·결과 불명은 cleanup_revoke 로 남기고 차단', () => {
  it('저장 실패 + T2 철회 실패(failed) → 감사 cleanup_revoke_failed, 표시·차단 → check 가 다시 철회해 표시 지움(error 는 유지)', async () => {
    const accountId = await newThreadsAccount();
    const { queued, fresh } = await connectedWithPlans(accountId);
    oauthTestHooks.beforeRefreshSeal = async () => {
      throw new Error('simulated seal failure');
    };
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    const r = await refresh(accountId);
    expect((await r.json()).reason).toBe('store_failed');
    expect(await credRow(accountId)).toMatchObject({ status: 'error', lastErrorCode: 'refresh_store_failed' });
    expect((await pendingOf(accountId))!.kind).toBe('cleanup_revoke');
    expect(await liveProviderTokens(accountId)).toBe(1); // T2 가 아직 살아 있다
    expect((await auditDetails(accountId, 'oauth.cleanup_revoke_failed')).at(-1)).toMatchObject({ context: 'refresh_store_failed', issued_token_revoke: 'failed', pending_record: 'recorded' });
    expect((await getAccountHealth(db, ownerA, accountId)).reason).toBe('pending_cleanup_revoke');
    await expectExecutionBlocked(accountId, queued, fresh);
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'error', reason: 'refresh_store_failed', pending_reconcile: null, usable_for_execution: false });
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({ kind: 'cleanup_revoke', result: 'resolved', issued_token_revoke: 'ok' });
  });

  it('철회 결과 불명(provider_error) → cleanup_revoke_unknown; 다음 정리도 불명이면 그대로(차단), worker 정리(refreshExpiringCredentials)가 끝냄', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('rollback');
    };
    mockOAuthStore().failNext = { op: 'revoke', code: 'provider_error' };
    await refresh(accountId);
    delete oauthTestHooks.insideRefreshStore;
    expect((await pendingOf(accountId))!.kind).toBe('cleanup_revoke');
    expect((await auditDetails(accountId, 'oauth.cleanup_revoke_unknown')).at(-1)).toMatchObject({ context: 'refresh_store_failed', issued_token_revoke: 'unknown' });
    // 다음 확인: 다시 불명 → 표시 유지, 차단 유지
    mockOAuthStore().failNext = { op: 'revoke', code: 'provider_error' };
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ pending_reconcile: 'cleanup_revoke', usable_for_execution: false });
    expect((await auditDetails(accountId, 'oauth.cleanup_revoke_unknown')).at(-1)).toMatchObject({ context: 'reconcile_cleanup_revoke', pending_record: 'kept' });
    expect(await liveProviderTokens(accountId)).toBe(1);
    // 갱신은 정리 대기가 남아 있으면 하지 않는다
    mockOAuthStore().failNext = { op: 'revoke', code: 'provider_error' };
    const rf = await refresh(accountId);
    expect(rf.status).toBe(409);
    expect((await rf.json()).reason).toBe('pending_reconcile');
    // FIX4-T13(P2): 시도마다 다음 시도 시각이 미뤄진다 — 지금 tick 은 이 계정을 고르지 않는다
    const p0 = (await pendingRows(accountId))[0]!;
    expect(p0.attempts).toBeGreaterThanOrEqual(2);
    expect(p0.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    // worker tick 경로가 정리(다음 시도 시각 뒤)
    const w = await refreshExpiringCredentials(db, { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerA, now: new Date(Date.now() + 2 * 3600_000) });
    expect(w.pendingResolved).toBeGreaterThanOrEqual(1);
    expect(await pendingOf(accountId)).toBeNull();
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('첫 연결 callback 거부(다른 계정) + 철회 실패 → 연결 정보 행 없이 정리 대기 행(FIX4), 모의 계정도 차단 → check 가 철회(원래대로 not_connected)', async () => {
    const accountId = await newThreadsAccount();
    const plan = await approvedPlanFor(accountId);
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(true);
    const other = `mock:threads:other-${randomUUID()}`;
    const b = await begin(accountId, { mock_user: other });
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    const r = await callback(b.location!);
    expect(r.status).toBe(409);
    expect(liveTokensOfUser(other)).toBe(1);
    // FIX4-T13: 자리 표시 행을 만들지 않는다 — 연결 정보 행은 없고 정리 대기 행만
    expect(await credRow(accountId)).toBeNull();
    expect(await pendingRows(accountId)).toMatchObject([{ kind: 'cleanup_revoke', source: 'callback_account_mismatch' }]);
    expect((await auditDetails(accountId, 'oauth.cleanup_revoke_failed')).at(-1)).toMatchObject({ context: 'callback_account_mismatch', pending_record: 'recorded' });
    expect((await auditDetails(accountId, 'oauth.callback_rejected')).some((d) => d.reason === 'account_mismatch' && d.issued_token_revoke === 'failed' && d.pending_record === 'recorded')).toBe(true);
    expect(await getAccountHealth(db, ownerA, accountId)).toMatchObject({ status: 'error', reason: 'pending_cleanup_revoke', usable_for_execution: false });
    expect((await execute(plan.planId)).status).toBe(409);
    const ck = await check(accountId);
    expect(ck.status).toBe(200);
    expect((await ck.json()).account).toMatchObject({ status: 'not_connected', usable_for_execution: true });
    expect(await credRow(accountId)).toBeNull();
    expect(liveTokensOfUser(other)).toBe(0);
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({ kind: 'cleanup_revoke', result: 'resolved', remaining: 0 });
    expect((await execute(plan.planId)).status).toBe(200);
  });

  it('연결 해제가 정리 대기 T2 철회에 실패 → 해제는 끝나되 표시는 cleanup_revoke 로 남아 차단, 감사 → check 가 다시 철회(해제 상태 그대로)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks.beforeRefreshSeal = async () => {
      throw new Error('seal failure');
    };
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    await refresh(accountId);
    delete oauthTestHooks.beforeRefreshSeal;
    expect((await pendingOf(accountId))!.kind).toBe('cleanup_revoke');
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' }; // 해제의 정리 대기 철회(먼저 실행)가 실패
    const rv = await revoke(accountId);
    expect(rv.status).toBe(200);
    expect(await rv.json()).toMatchObject({ outcome: 'revoked' });
    const row = (await credRow(accountId))!;
    expect(row).toMatchObject({ status: 'revoked', encryptedToken: null });
    expect((await pendingOf(accountId))!.kind).toBe('cleanup_revoke');
    expect(row.revocationEpoch).toBe(1);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ pending_token_revoke: 'failed' });
    expect((await auditDetails(accountId, 'oauth.cleanup_revoke_failed')).at(-1)).toMatchObject({ context: 'revoke_pending', pending_record: 'kept' });
    expect(await liveProviderTokens(accountId)).toBe(1);
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'revoked', pending_reconcile: null });
    expect(await credRow(accountId)).not.toBeNull(); // 실제 해제 행은 지우지 않는다(해제 세대 보존)
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});

// ---------------- FIX round 4 (Codex review-FIX3-T13) ----------------

type RevokeMode = 'ok' | 'failed';
type AccountMode = 'ok' | 'invalid' | 'transient';

/**
 * 모의 공급자 동작을 정한다(시험만): 철회 실패(invalid_grant → failed) / 계정 확인 성공(이 계정) · 무효(token_revoked) · 일시 오류(provider_error).
 * mode 를 바꾸려면 객체 값을 바꾼다(spy 는 그대로).
 */
function controlProvider(externalAccountId: string, mode: { revoke: RevokeMode; account: AccountMode }) {
  const origRevoke = MockThreadsOAuthProvider.prototype.revoke;
  vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
    if (mode.revoke === 'failed') throw new OAuthProviderError('invalid_grant');
    return origRevoke.call(this, input);
  });
  vi.spyOn(MockThreadsOAuthProvider.prototype, 'accountInfo').mockImplementation(async function () {
    if (mode.account === 'invalid') throw new OAuthProviderError('token_revoked');
    if (mode.account === 'transient') throw new OAuthProviderError('provider_error');
    return { externalAccountId, displayName: 'MOCK' };
  });
  return mode;
}

/** 갱신 저장이 되돌려지고 다시 읽기도 실패 → refresh_unknown(C = T1, P = T2, C != P) */
async function refreshUnknownNotStored(accountId: string) {
  oauthTestHooks.insideRefreshStore = async () => {
    throw new Error('rollback');
  };
  oauthTestHooks.beforeStoredOutcomeRead = async () => {
    throw new Error('re-read failure');
  };
  const r = await refresh(accountId);
  delete oauthTestHooks.insideRefreshStore;
  delete oauthTestHooks.beforeStoredOutcomeRead;
  expect((await r.json()).reason).toBe('store_outcome_unknown');
  expect(await pendingRows(accountId)).toMatchObject([{ kind: 'refresh_unknown' }]);
}

/** 갱신은 커밋됐는데 다시 읽기 실패 → refresh_unknown(C == P) */
async function refreshUnknownStored(accountId: string) {
  oauthTestHooks.afterRefreshStoreCommit = async () => {
    throw new Error('lost commit ack');
  };
  oauthTestHooks.beforeStoredOutcomeRead = async () => {
    throw new Error('re-read failure');
  };
  const r = await refresh(accountId);
  delete oauthTestHooks.afterRefreshStoreCommit;
  delete oauthTestHooks.beforeStoredOutcomeRead;
  expect((await r.json()).reason).toBe('store_outcome_unknown');
  expect(await pendingRows(accountId)).toMatchObject([{ kind: 'refresh_unknown' }]);
}

describe('FIX4 P1 :1037 — refresh_unknown: P 정리와 C 확인을 따로 본다, C 가 미확정이면 차단 유지', () => {
  // 실패한 시험의 공급자 spy 가 다음 시험으로 새지 않게
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const matrix: Array<{ revoke: RevokeMode; account: AccountMode; rows: string[]; status: string; error: string | null; usable: boolean }> = [
    { revoke: 'ok', account: 'ok', rows: [], status: 'active', error: null, usable: true },
    { revoke: 'ok', account: 'invalid', rows: [], status: 'error', error: 'refresh_store_failed', usable: false },
    { revoke: 'ok', account: 'transient', rows: ['verify_current'], status: 'active', error: null, usable: false },
    { revoke: 'failed', account: 'ok', rows: ['cleanup_revoke'], status: 'active', error: null, usable: false },
    { revoke: 'failed', account: 'invalid', rows: ['cleanup_revoke'], status: 'error', error: 'refresh_store_failed', usable: false },
    { revoke: 'failed', account: 'transient', rows: ['cleanup_revoke', 'verify_current'], status: 'active', error: null, usable: false },
  ];
  it.each(matrix)('C != P · P 철회 $revoke × C 확인 $account → 행 $rows, usable=$usable; 이후 정리가 C 확인 전에는 풀지 않음', async (c) => {
    const accountId = await newThreadsAccount();
    const { fresh } = await connectedWithPlans(accountId);
    await refreshUnknownNotStored(accountId);
    const user = (await accountRow(accountId)).externalAccountId;
    const mode = controlProvider(user, { revoke: c.revoke, account: c.account });
    const ck = await check(accountId);
    expect(ck.status).toBe(200);
    const view = (await ck.json()).account;
    const rows = await pendingRows(accountId);
    expect(rows.map((r) => r.kind).sort()).toEqual([...c.rows].sort());
    expect(await credRow(accountId)).toMatchObject({ status: c.status, lastErrorCode: c.error });
    expect(view.usable_for_execution).toBe(c.usable);
    expect(view.pending_count).toBe(c.rows.length);
    // verify_current 는 봉인 없이 C 의 세대와 무효일 때 기록할 코드만 갖는다
    for (const r of rows.filter((x) => x.kind === 'verify_current')) {
      expect(r).toMatchObject({ sealedToken: null, keyVersion: null, baseGeneration: (await credRow(accountId))!.tokenGeneration, onInvalidCode: 'refresh_store_failed', attempts: 1 });
    }
    if (!c.usable) {
      expect((await execute(fresh.planId)).status).toBe(409);
      if (c.rows.length) {
        // 정리 대기가 남은 동안 갱신하지 않는다(발급을 더 늘리지 않음)
        const rf = await refresh(accountId);
        expect(rf.status).toBe(409);
        expect((await rf.json()).reason).toBe('pending_reconcile');
      }
    } else {
      expect((await execute(fresh.planId)).status).toBe(200);
    }
    if (c.account !== 'transient') {
      vi.restoreAllMocks();
      return;
    }
    // 다음 정리: P 철회는 성공하지만 C 는 여전히 판단 불가 → C 확인 의무가 남아 차단(cleanup_revoke → 성공 경로 포함)
    mode.revoke = 'ok';
    const ck2 = await check(accountId);
    expect((await ck2.json()).account).toMatchObject({ pending_reconcile: 'verify_current', pending_count: 1, usable_for_execution: false });
    expect((await pendingRows(accountId)).map((r) => r.kind)).toEqual(['verify_current']);
    expect(await liveTokensOfUser(user)).toBe(0); // P 는 철회됨(C 는 모의 갱신이 이미 무효로 함)
    expect((await execute(fresh.planId)).status).toBe(409);
    // C 가 유효로 확인되면 풀린다
    mode.account = 'ok';
    const ck3 = await check(accountId);
    expect((await ck3.json()).account).toMatchObject({ status: 'connected', pending_reconcile: null, pending_count: 0, usable_for_execution: true });
    expect(await credRow(accountId)).toMatchObject({ status: 'active', lastErrorCode: null });
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({ kind: 'verify_current', result: 'resolved', current_token_valid: 'yes', status: 'active' });
    vi.restoreAllMocks();
    expect((await execute(fresh.planId)).status).toBe(200);
  });

  it('verify_current 가 무효로 확인되면 error(refresh_store_failed)·행 삭제(차단은 error 로 계속)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownNotStored(accountId);
    const user = (await accountRow(accountId)).externalAccountId;
    const mode = controlProvider(user, { revoke: 'ok', account: 'transient' });
    await check(accountId);
    expect((await pendingRows(accountId)).map((r) => r.kind)).toEqual(['verify_current']);
    mode.account = 'invalid';
    const ck = await check(accountId);
    vi.restoreAllMocks();
    expect((await ck.json()).account).toMatchObject({ status: 'error', reason: 'refresh_store_failed', pending_count: 0, usable_for_execution: false });
    expect(await pendingRows(accountId)).toHaveLength(0);
  });

  it('C == P(저장돼 있었음) · C 확인 일시 오류 → 봉인 없는 verify_current 로 차단 유지(P 철회 없음) → 다음 확인 성공 시 풀림', async () => {
    const accountId = await newThreadsAccount();
    const { fresh } = await connectedWithPlans(accountId);
    await refreshUnknownStored(accountId);
    const gen = (await credRow(accountId))!.tokenGeneration;
    mockOAuthStore().failNext = { op: 'account', code: 'provider_error' };
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'error', reason: 'pending_verify_current', usable_for_execution: false });
    expect(await pendingRows(accountId)).toMatchObject([{ kind: 'verify_current', sealedToken: null, baseGeneration: gen, onInvalidCode: null }]);
    expect(await liveProviderTokens(accountId)).toBe(1); // 저장된 P(=C)는 철회하지 않음
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({
      kind: 'refresh_unknown',
      result: 'verify_pending',
      stored_was_pending: true,
      issued_token_revoke: 'not_needed',
      current_token_valid: 'unknown',
      current_check_error: 'provider_error',
    });
    expect((await execute(fresh.planId)).status).toBe(409);
    const ck2 = await check(accountId);
    expect((await ck2.json()).account).toMatchObject({ status: 'connected', usable_for_execution: true, pending_count: 0 });
    expect((await execute(fresh.planId)).status).toBe(200);
  });

  it('verify_current 의 세대가 다시 연결로 바뀌면(새 토큰은 callback 이 확인함) 의무가 없어져 삭제', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownStored(accountId);
    mockOAuthStore().failNext = { op: 'account', code: 'provider_error' };
    await check(accountId);
    expect((await pendingRows(accountId)).map((r) => r.kind)).toEqual(['verify_current']);
    await connectFully(accountId); // 세대 +1 — 다시 연결은 정리 대기를 지우지 않는다(정리 전까지 차단)
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'connected', usable_for_execution: true, pending_count: 0 });
  });
});

describe('FIX4 P1 :1017 — 공급자 호출 뒤 되쓰기 전에 해제가 끼어들면 낡은 판정을 버리고 다시 정리', () => {
  // 실패한 시험의 공급자 spy 가 다음 시험으로 새지 않게
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('C == P 판정 뒤 해제(P·C 철회 실패 → 같은 행을 cleanup_revoke 로) → 되쓰기는 행을 지우지 않고 다시 정리해 P 를 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownStored(accountId);
    const before = (await pendingRows(accountId))[0]!;
    let revokes = 0;
    const origRevoke = MockThreadsOAuthProvider.prototype.revoke;
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
      revokes++;
      if (revokes <= 2) throw new OAuthProviderError('invalid_grant'); // 해제의 P 철회·C 철회 모두 실패
      return origRevoke.call(this, input);
    });
    oauthTestHooks.afterReconcileProvider = async () => {
      delete oauthTestHooks.afterReconcileProvider;
      const rv = await revoke(accountId);
      expect(rv.status).toBe(200);
      // 해제는 같은 행을 cleanup_revoke 로 바꿔 남겼다(revision +1)
      expect(await pendingRows(accountId)).toMatchObject([{ id: before.id, kind: 'cleanup_revoke', revision: before.revision + 1 }]);
    };
    const ck = await check(accountId);
    vi.restoreAllMocks();
    expect(ck.status).toBe(200);
    expect(revokes).toBe(3); // 다시 정리가 P 를 철회
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect((await ck.json()).account).toMatchObject({ status: 'revoked', pending_count: 0 });
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({ kind: 'cleanup_revoke', result: 'resolved', issued_token_revoke: 'ok', pass: 2 });
  });

  it('같은 경우 다시 정리의 철회도 실패하면 행(cleanup_revoke)을 지우지 않고 차단 유지 → 이후 확인이 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownStored(accountId);
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function () {
      throw new OAuthProviderError('invalid_grant');
    });
    oauthTestHooks.afterReconcileProvider = async () => {
      delete oauthTestHooks.afterReconcileProvider;
      await revoke(accountId);
    };
    await check(accountId);
    vi.restoreAllMocks();
    expect(await pendingRows(accountId)).toMatchObject([{ kind: 'cleanup_revoke' }]);
    expect(await liveProviderTokens(accountId)).toBe(1); // 토큰은 살아 있고 기록도 남아 있다
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'revoked', pending_count: 0 });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('C != P 판정 뒤 다시 연결(세대 +1)이 끼어들면 옛 세대의 상태 판정(무효 → error)을 새 세대에 쓰지 않는다', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownNotStored(accountId);
    oauthTestHooks.afterReconcileProvider = async () => {
      delete oauthTestHooks.afterReconcileProvider;
      await connectFully(accountId);
    };
    const ck = await check(accountId);
    expect(ck.status).toBe(200);
    // 첫 판정(C=T1 무효 → error refresh_store_failed)은 버려지고, 다시 정리가 새 C(유효)로 판정
    expect((await ck.json()).account).toMatchObject({ status: 'connected', usable_for_execution: true, pending_count: 0 });
    expect(await credRow(accountId)).toMatchObject({ status: 'active', lastErrorCode: null });
    expect(await liveProviderTokens(accountId)).toBe(1);
  });
});

describe('FIX4 P1 :908 — 같은 계정의 정리 대기 여러 건(두 번째 토큰도 기록·철회)', () => {
  it('첫 연결 callback 두 개가 모두 정리 철회 실패 → 두 토큰 모두 기록(연결 정보 행 없음)·차단 → 하나만 정리돼도 차단 유지 → 둘 다 철회', async () => {
    const accountId = await newThreadsAccount();
    const plan = await approvedPlanFor(accountId);
    const other = `mock:threads:other-${randomUUID()}`;
    const b1 = await begin(accountId, { mock_user: other });
    const b2 = await begin(accountId, { mock_user: other });
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    expect((await callback(b1.location!)).status).toBe(409);
    mockOAuthStore().failNext = { op: 'revoke', code: 'provider_error' };
    expect((await callback(b2.location!)).status).toBe(409);
    expect(liveTokensOfUser(other)).toBe(2);
    expect(await credRow(accountId)).toBeNull();
    const rows = await pendingRows(accountId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'cleanup_revoke' && r.sealedToken!.startsWith('csk1:'))).toBe(true);
    // 두 봉인은 서로 다른 토큰
    const ring = requireSecretKeyring(process.env);
    const opened = rows.map((r) => JSON.parse(openSecret(ring, r.sealedToken!, r.keyVersion!, { ownerId: ownerA, channelAccountId: accountId, purpose: 'oauth_pending_token' })).access_token);
    expect(new Set(opened).size).toBe(2);
    expect(await getAccountHealth(db, ownerA, accountId)).toMatchObject({ status: 'error', reason: 'pending_cleanup_revoke', pending_count: 2, usable_for_execution: false });
    expect((await execute(plan.planId)).status).toBe(409);
    // 첫 정리: 첫 행 철회 실패, 둘째 행 철회 성공 → 하나 남아 차단
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ pending_count: 1, usable_for_execution: false });
    expect(liveTokensOfUser(other)).toBe(1);
    expect((await execute(plan.planId)).status).toBe(409);
    const ck2 = await check(accountId);
    expect((await ck2.json()).account).toMatchObject({ status: 'not_connected', pending_count: 0, usable_for_execution: true });
    expect(liveTokensOfUser(other)).toBe(0);
    expect(await credRow(accountId)).toBeNull();
    expect((await execute(plan.planId)).status).toBe(200);
  });

  it('연결된 계정에 다시 연결 callback 두 개(다른 계정)가 정리 실패 → 기존 연결 정보는 그대로, 두 토큰 모두 기록, 해제가 둘 다 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const before = (await credRow(accountId))!;
    const other = `mock:threads:other-${randomUUID()}`;
    for (let i = 0; i < 2; i++) {
      const b = await begin(accountId, { mock_user: other });
      mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
      expect((await callback(b.location!)).status).toBe(409);
    }
    expect(await pendingRows(accountId)).toHaveLength(2);
    expect(await credRow(accountId)).toMatchObject({ tokenGeneration: before.tokenGeneration, encryptedToken: before.encryptedToken, status: 'active' });
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    const rv = await revoke(accountId);
    expect(await rv.json()).toMatchObject({ outcome: 'revoked' });
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ pending_token_revoke: 'ok', pending_tokens: 2, pending_tokens_revoked: 2 });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(liveTokensOfUser(other)).toBe(0);
  });

  it('옛 모양(해제됨 + 해제 세대 0, linked) 행에 정리 대기가 생겨도 정리가 연결 정보 행을 지우지 않는다', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await revoke(accountId);
    await db.update(schema.oauthCredentials).set({ revocationEpoch: 0 }).where(eq(schema.oauthCredentials.channelAccountId, accountId)); // 0029 이전 해제 행 흉내
    const other = `mock:threads:other-${randomUUID()}`;
    const b = await begin(accountId, { mock_user: other });
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    expect((await callback(b.location!)).status).toBe(409);
    expect(await pendingRows(accountId)).toHaveLength(1);
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'revoked', pending_count: 0 });
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', revocationEpoch: 0 });
    expect(liveTokensOfUser(other)).toBe(0);
  });
});

describe('FIX4 P2 :1293 — worker 정리는 다음 시도 시각 순(열 수 없는 행이 뒤 계정을 막지 않음)', () => {
  it('limit=1, 계정 둘(앞 계정 봉인 손상): 첫 tick 은 앞 계정 시도·미룸, 둘째 tick 은 뒤 계정 정리, 셋째 tick 은 아무것도 고르지 않음', async () => {
    const T = new Date(Date.now() + 10 * DAY);
    const bad = await newThreadsAccount(ownerB);
    const good = await newThreadsAccount(ownerB);
    const ring = requireSecretKeyring(process.env);
    const sealedGood = sealSecret(ring, JSON.stringify({ v: 1, access_token: `mockthr_at_unknown_${randomUUID()}`, refresh_token: null }), {
      ownerId: ownerB,
      channelAccountId: good,
      purpose: 'oauth_pending_token',
    });
    await db.insert(schema.oauthPendingTokens).values([
      { ownerId: ownerB, channelAccountId: bad, kind: 'cleanup_revoke', sealedToken: 'csk1:1:AAAA:BBBB:CCCC', keyVersion: 1, source: 'test', nextAttemptAt: new Date(T.getTime() - 10 * 60_000) },
      { ownerId: ownerB, channelAccountId: good, kind: 'cleanup_revoke', sealedToken: sealedGood.ciphertext, keyVersion: sealedGood.keyVersion, source: 'test', nextAttemptAt: new Date(T.getTime() - 5 * 60_000) },
    ]);
    const deps = { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerB, limit: 1, now: T };
    const w1 = await refreshExpiringCredentials(db, deps);
    expect(w1).toMatchObject({ pendingResolved: 0, pendingRemaining: 1 });
    const badRow = (await pendingRows(bad))[0]!;
    expect(badRow.attempts).toBe(1);
    expect(badRow.nextAttemptAt.getTime()).toBeGreaterThan(T.getTime());
    expect(badRow.lastResult).toMatch(/^pending_/);
    expect(await pendingRows(good)).toHaveLength(1);
    const w2 = await refreshExpiringCredentials(db, deps);
    expect(w2).toMatchObject({ pendingResolved: 1, pendingRemaining: 0 });
    expect(await pendingRows(good)).toHaveLength(0);
    const w3 = await refreshExpiringCredentials(db, deps);
    expect(w3).toMatchObject({ pendingResolved: 0, pendingRemaining: 0 });
    // 시도 간격은 시도마다 늘어난다(상한 1시간)
    const w4 = await refreshExpiringCredentials(db, { ...deps, now: new Date(badRow.nextAttemptAt.getTime() + 1) });
    expect(w4.pendingRemaining).toBe(1);
    const again = (await pendingRows(bad))[0]!;
    expect(again.attempts).toBe(2);
    expect(again.nextAttemptAt.getTime() - (badRow.nextAttemptAt.getTime() + 1)).toBe(2 * 60_000);
    // 계정 차단은 그대로(정리할 수 없는 행이 남아 있음)
    expect((await getAccountHealth(db, ownerB, bad)).usable_for_execution).toBe(false);
  });
});

// ---------------- FIX round 5 (Codex review-FIX4-T13) ----------------

/** 정리 대기 봉인을 연다(시험만) */
const openPending = (ownerId: string, accountId: string, sealed: string, keyVersion: number) =>
  JSON.parse(openSecret(requireSecretKeyring(process.env), sealed, keyVersion, { ownerId, channelAccountId: accountId, purpose: 'oauth_pending_token' })).access_token as string;

describe('FIX5 P1 :1524 — 연결 해제가 현재 토큰 철회를 확인하지 못하면 그 토큰을 cleanup_revoke 로 봉인해 남긴다', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** refresh_unknown(C == P) → C 확인 일시 오류 → 봉인 없는 verify_current */
  async function verifyCurrentAccount() {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownStored(accountId);
    mockOAuthStore().failNext = { op: 'account', code: 'provider_error' };
    await check(accountId);
    expect(await pendingRows(accountId)).toMatchObject([{ kind: 'verify_current', sealedToken: null }]);
    const current = await decryptToken(ownerA, accountId);
    expect(await liveProviderTokens(accountId)).toBe(1);
    return { accountId, current };
  }

  it.each([
    { mode: 'failed', code: 'invalid_grant', audit: 'oauth.cleanup_revoke_failed' },
    { mode: 'unknown', code: 'provider_error', audit: 'oauth.cleanup_revoke_unknown' },
  ] as const)('verify_current + 해제의 C 철회 $mode → 암호문은 지우되 C 를 봉인한 cleanup_revoke 행이 남아 차단, worker 가 철회해 지움', async (c) => {
    const { accountId, current } = await verifyCurrentAccount();
    mockOAuthStore().failNext = { op: 'revoke', code: c.code }; // 정리 대기에 봉인 행이 없으므로 첫 철회 = C
    const rv = await revoke(accountId);
    expect(rv.status).toBe(200);
    expect(await rv.json()).toMatchObject({ outcome: 'revoked', remote_revoke: c.mode, account: { usable_for_execution: false, pending_reconcile: 'cleanup_revoke', pending_count: 1 } });
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, keyVersion: null });
    // verify_current 는 없어졌지만 철회 의무는 C 를 봉인한 cleanup_revoke 행으로 남는다
    const rows = await pendingRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'cleanup_revoke', source: 'revoke_current', keyVersion: 1, lastResult: c.code });
    expect(rows[0]!.sealedToken!.startsWith('csk1:')).toBe(true);
    expect(openPending(ownerA, accountId, rows[0]!.sealedToken!, rows[0]!.keyVersion!)).toBe(current);
    expect(await liveProviderTokens(accountId)).toBe(1); // 공급자에서는 아직 살아 있다 — 기록과 함께
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', remote_revoke: c.mode, current_token_record: 'recorded' });
    expect((await auditDetails(accountId, c.audit)).at(-1)).toMatchObject({ context: 'revoke_current', pending_record: 'recorded' });
    // 감사에 C 가 없다
    expect(JSON.stringify(await auditDetails(accountId, 'oauth.revoked'))).not.toContain(current);
    expect(JSON.stringify(await auditDetails(accountId, c.audit))).not.toContain(current);
    // worker(기한이 지난 행) → C 철회·행 삭제, 해제 상태 그대로
    const w = await refreshExpiringCredentials(db, { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerA, now: new Date(Date.now() + 1000) });
    expect(w.pendingResolved).toBeGreaterThanOrEqual(1);
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect(await getAccountHealth(db, ownerA, accountId)).toMatchObject({ status: 'revoked', pending_count: 0 });
    expect((await auditDetails(accountId, 'oauth.pending_reconciled')).at(-1)).toMatchObject({ kind: 'cleanup_revoke', result: 'resolved', issued_token_revoke: 'ok' });
  });

  it('C 봉인이 실패하면 암호문을 지우지 않고 revoking(차단) + verify_current 유지(incomplete) → 다시 해제가 합류해 철회·마무리', async () => {
    const { accountId } = await verifyCurrentAccount();
    const before = (await credRow(accountId))!;
    oauthTestHooks.beforeRevokeCurrentSeal = async () => {
      throw new Error('seal failure');
    };
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    const rv = await revoke(accountId);
    delete oauthTestHooks.beforeRevokeCurrentSeal;
    expect(rv.status).toBe(200);
    expect(await rv.json()).toMatchObject({ outcome: 'incomplete', remote_revoke: 'failed', account: { usable_for_execution: false } });
    const row = (await credRow(accountId))!;
    expect(row).toMatchObject({ status: 'revoking', encryptedToken: before.encryptedToken, keyVersion: before.keyVersion, revokedAt: null });
    expect((await pendingRows(accountId)).map((r) => r.kind)).toEqual(['verify_current']);
    expect(await liveProviderTokens(accountId)).toBe(1);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'incomplete', current_token_record: 'seal_failed' });
    expect((await auditDetails(accountId, 'oauth.cleanup_revoke_failed')).at(-1)).toMatchObject({ context: 'revoke_current', pending_record: 'seal_failed' });
    // 다시 해제: 같은 작업에 합류(해제 세대 그대로), C 철회 성공 → 마무리
    const again = await revoke(accountId);
    expect(await again.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'ok', account: { status: 'revoked', pending_count: 0 } });
    expect((await credRow(accountId))!).toMatchObject({ encryptedToken: null, revocationEpoch: row.revocationEpoch });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('C == P 인 refresh_unknown 행이 있고 두 철회가 모두 실패 → 같은 토큰을 진 행 하나만 cleanup_revoke(중복 없음), check 가 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownStored(accountId);
    const current = await decryptToken(ownerA, accountId);
    const before = (await pendingRows(accountId))[0]!;
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function () {
      throw new OAuthProviderError('invalid_grant');
    });
    const rv = await revoke(accountId);
    vi.restoreAllMocks();
    expect(await rv.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'failed' });
    const rows = await pendingRows(accountId);
    expect(rows).toMatchObject([{ id: before.id, kind: 'cleanup_revoke', revision: before.revision + 1 }]);
    expect(openPending(ownerA, accountId, rows[0]!.sealedToken!, rows[0]!.keyVersion!)).toBe(current);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ current_token_record: 'covered_by_pending' });
    expect(await liveProviderTokens(accountId)).toBe(1);
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'revoked', pending_count: 0 });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('C 철회 성공이면 행을 만들지 않는다(current_token_record not_needed)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const rv = await revoke(accountId);
    expect(await rv.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'ok' });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ current_token_record: 'not_needed' });
  });
});

describe('FIX5 P2 :1077 — worker 는 기한이 지난 행만 처리(같은 계정의 기한 전 행은 손대지 않음), 수동 확인은 모두', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    as(A);
  });
  const sealFor = (accountId: string, accessToken: string) =>
    sealSecret(requireSecretKeyring(process.env), JSON.stringify({ v: 1, access_token: accessToken, refresh_token: null }), {
      ownerId: ownerB,
      channelAccountId: accountId,
      purpose: 'oauth_pending_token',
    });
  const workerDeps = () => ({ providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerB });

  it('행 A(다음 시도 +1시간)·행 B(기한 지남) → worker 는 B 만 철회, A 의 attempts·next_attempt_at·revision 그대로, 계정 차단 유지 → 수동 확인은 A 도 처리', async () => {
    const T = new Date(Date.now() + DAY);
    const accountId = await newThreadsAccount(ownerB);
    const tokA = `mockthr_at_rowA_${randomUUID()}`;
    const tokB = `mockthr_at_rowB_${randomUUID()}`;
    const sa = sealFor(accountId, tokA);
    const sb = sealFor(accountId, tokB);
    const nextA = new Date(T.getTime() + 3600_000);
    const [rowA] = await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: ownerB, channelAccountId: accountId, kind: 'cleanup_revoke', sealedToken: sa.ciphertext, keyVersion: sa.keyVersion, source: 'test', attempts: 3, nextAttemptAt: nextA, lastResult: 'invalid_grant' })
      .returning();
    await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: ownerB, channelAccountId: accountId, kind: 'cleanup_revoke', sealedToken: sb.ciphertext, keyVersion: sb.keyVersion, source: 'test', nextAttemptAt: new Date(T.getTime() - 5 * 60_000) });
    const revoked: string[] = [];
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
      revoked.push(input.tokens.accessToken);
    });
    const w = await refreshExpiringCredentials(db, { ...workerDeps(), now: T });
    expect(w.pendingRemaining).toBeGreaterThanOrEqual(1);
    expect(revoked).toEqual([tokB]); // A 는 공급자에 묻지 않았다
    const rows = await pendingRows(accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: rowA!.id, attempts: 3, revision: rowA!.revision, lastResult: 'invalid_grant' });
    expect(rows[0]!.nextAttemptAt.getTime()).toBe(nextA.getTime());
    expect(await getAccountHealth(db, ownerB, accountId, T)).toMatchObject({ usable_for_execution: false, pending_reconcile: 'cleanup_revoke', pending_count: 1 });
    // 같은 시각에 다시 돌아도 A 는 기한 전이라 그대로
    await refreshExpiringCredentials(db, { ...workerDeps(), now: T });
    expect(revoked).toEqual([tokB]);
    expect((await pendingRows(accountId))[0]).toMatchObject({ attempts: 3, revision: rowA!.revision });
    // 수동 확인(사용자)은 백오프를 무시하고 A 도 처리
    as(B);
    const ck = await check(accountId, tokenB);
    expect(ck.status).toBe(200);
    expect((await ck.json()).account).toMatchObject({ pending_count: 0, usable_for_execution: true });
    expect(revoked).toEqual([tokB, tokA]);
    expect(await pendingRows(accountId)).toHaveLength(0);
  });

  it('놓친 케이스: 세 번 모두 낡은 판정(동시 변경)으로 끝나면 그 행의 다음 시도 시각을 미룬다(종류·봉인은 그대로, revision 은 다른 쓰기만 올림)', async () => {
    const T = new Date(Date.now() + DAY);
    const accountId = await newThreadsAccount(ownerB);
    const s = sealFor(accountId, `mockthr_at_stale_${randomUUID()}`);
    const [row] = await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: ownerB, channelAccountId: accountId, kind: 'cleanup_revoke', sealedToken: s.ciphertext, keyVersion: s.keyVersion, source: 'test', nextAttemptAt: new Date(T.getTime() - 60_000) })
      .returning();
    let calls = 0;
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function () {
      calls++;
    });
    // 공급자 호출 뒤마다 다른 쓰기가 같은 행을 바꾼다(revision +1) → 되쓰기는 매번 낡은 판정
    oauthTestHooks.afterReconcileProvider = async () => {
      const cur = (await pendingRows(accountId))[0];
      if (cur) await db.update(schema.oauthPendingTokens).set({ revision: cur.revision + 1 }).where(eq(schema.oauthPendingTokens.id, cur.id));
    };
    const w = await refreshExpiringCredentials(db, { ...workerDeps(), now: T });
    delete oauthTestHooks.afterReconcileProvider;
    expect(w.pendingRemaining).toBeGreaterThanOrEqual(1);
    expect(calls).toBe(3);
    const after = (await pendingRows(accountId))[0]!;
    expect(after).toMatchObject({ id: row!.id, kind: 'cleanup_revoke', sealedToken: s.ciphertext, attempts: 1, lastResult: 'reconcile_stale', revision: row!.revision + 3 });
    expect(after.nextAttemptAt.getTime()).toBe(T.getTime() + 60_000);
    // 미뤄진 동안 worker 는 이 행을 다시 처리하지 않는다
    await refreshExpiringCredentials(db, { ...workerDeps(), now: T });
    expect(calls).toBe(3);
    // 기한이 지나면 다시 시도해 정리
    await refreshExpiringCredentials(db, { ...workerDeps(), now: new Date(T.getTime() + 61_000) });
    expect(calls).toBe(4);
    expect(await pendingRows(accountId)).toHaveLength(0);
  });
});

// ---------------- FIX round 6 (Codex review-FIX5-T13) ----------------

/** refresh_unknown(C == P) → C 확인 일시 오류 → 봉인 없는 verify_current(FIX5 와 같은 준비) */
async function fix6VerifyCurrentAccount() {
  const accountId = await newThreadsAccount();
  await connectFully(accountId);
  await refreshUnknownStored(accountId);
  mockOAuthStore().failNext = { op: 'account', code: 'provider_error' };
  await check(accountId);
  const rows = await pendingRows(accountId);
  expect(rows).toMatchObject([{ kind: 'verify_current', sealedToken: null }]);
  const current = await decryptToken(ownerA, accountId);
  expect(await liveProviderTokens(accountId)).toBe(1);
  return { accountId, current, vc: rows[0]! };
}
const workerA = (now: Date) => refreshExpiringCredentials(db, { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerA, now });

describe('FIX6 P1 :1541 — 현재 토큰을 읽지 못한 해제는 암호문을 지우지 않는다(차단·incomplete), 키가 돌아오면 worker 가 같은 작업으로 철회', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: '키 없음', keys: {}, remote: 'skipped_no_key', code: 'revoke_current_no_key' },
    { name: '키 버전 모름', keys: { SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2' }, remote: 'skipped_unreadable', code: 'revoke_current_unreadable' },
    { name: '같은 버전의 다른 키(인증 실패)', keys: { SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '1' }, remote: 'skipped_unreadable', code: 'revoke_current_unreadable' },
  ] as const)('verify_current + $name → incomplete($code), 암호문·verify_current 유지, 키 없이 worker 는 손대지 않음 → 키 복구 후 worker 가 철회·마무리', async (c) => {
    const { accountId, vc } = await fix6VerifyCurrentAccount();
    const before = (await credRow(accountId))!;
    useKeys(c.keys as Record<string, string>);
    const rv = await revoke(accountId);
    expect(rv.status).toBe(200);
    expect(await rv.json()).toMatchObject({ outcome: 'incomplete', remote_revoke: c.remote, incomplete_code: c.code, account: { usable_for_execution: false } });
    const kept = (await credRow(accountId))!;
    expect(kept).toMatchObject({
      status: 'revoking',
      revokedAt: null,
      encryptedToken: before.encryptedToken,
      keyVersion: before.keyVersion,
      tokenGeneration: before.tokenGeneration,
      revocationEpoch: before.revocationEpoch + 1,
      lastErrorCode: c.code,
    });
    expect(kept.revokeOpId).not.toBeNull();
    // verify_current 는 그대로(이 해제가 연결 정보를 해제 상태로 만들지 않았다), 새 행 없음 — 철회 의무는 남은 암호문
    expect(await pendingRows(accountId)).toMatchObject([{ id: vc.id, kind: 'verify_current', revision: vc.revision }]);
    expect(await liveProviderTokens(accountId)).toBe(1);
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    const audits = await auditDetails(accountId, 'oauth.revoked');
    expect(audits.at(-1)).toMatchObject({ outcome: 'incomplete', remote_revoke: c.remote, current_token_record: 'unreadable_kept', incomplete_code: c.code });
    expect((await auditDetails(accountId, 'oauth.cleanup_revoke_failed')).filter((d) => d.context === 'revoke_current')).toHaveLength(0);
    // 다시 연결은 해제 중이라 거절(암호문을 덮어 C 의 기록을 잃지 않음) — 키가 없거나 틀리면 연결 시작부터 막히므로 여기서는 worker 만 본다
    // FIX7-T13: 해제 1단계가 다음 재개 시각을 정했다(지금 + 1분, 시도 1)
    expect(kept.revokeResumeAttempts).toBe(1);
    expect(kept.revokeResumeAt!.getTime() - kept.updatedAt.getTime()).toBe(60_000);
    // 키가 아직 그대로면 worker 는 암호문·updated_at·감사를 쓰지 않는다 — FIX7-T13: 다음 재개 시각만 backoff 로 미룬다(시도 2 → +2분)
    const t1 = new Date(Date.now() + 2 * 60_000);
    const w1 = await workerA(t1);
    expect(w1.revokeWaiting).toBeGreaterThanOrEqual(1);
    const waited = (await credRow(accountId))!;
    expect(waited).toMatchObject({ status: 'revoking', encryptedToken: before.encryptedToken, updatedAt: kept.updatedAt, lastErrorCode: c.code, revokeOpId: kept.revokeOpId, revokeResumeAttempts: 2 });
    expect(waited.revokeResumeAt!.getTime()).toBe(t1.getTime() + 2 * 60_000);
    expect(await auditDetails(accountId, 'oauth.revoked')).toHaveLength(audits.length);
    expect(await liveProviderTokens(accountId)).toBe(1);
    // 키 복구 — 다음 재개 시각 전에는 잇지 않는다(진행 중인 해제와 겹치지 않게 · backoff)
    key1();
    await workerA(new Date());
    await workerA(new Date(t1.getTime() + 60_000));
    expect((await credRow(accountId))!.status).toBe('revoking');
    const w2 = await workerA(new Date(t1.getTime() + 2 * 60_000));
    expect(w2.revokeResumed).toBeGreaterThanOrEqual(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, keyVersion: null, revocationEpoch: kept.revocationEpoch, revokeOpId: kept.revokeOpId });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect(await getAccountHealth(db, ownerA, accountId)).toMatchObject({ status: 'revoked', pending_count: 0 });
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', joined: true, remote_revoke: 'ok', incomplete_code: null });
  });

  it('키 없음 해제(incomplete) 뒤 키가 돌아와도 C 철회가 실패하면 → C 를 봉인한 cleanup_revoke 로 넘기고 해제 마무리(의무 유지), 다음 worker 가 철회', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const current = await decryptToken(ownerA, accountId);
    useKeys({});
    expect(await (await revoke(accountId)).json()).toMatchObject({ outcome: 'incomplete', incomplete_code: 'revoke_current_no_key' });
    key1();
    // 이 계정의 C 철회만 한 번 실패시킨다(worker 가 같은 tick 에 다른 계정의 정리 대기를 철회해도 영향 없게)
    const orig = MockThreadsOAuthProvider.prototype.revoke;
    let failedOnce = false;
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
      if (!failedOnce && input.tokens.accessToken === current) {
        failedOnce = true;
        throw new OAuthProviderError('invalid_grant');
      }
      return orig.call(this, input);
    });
    const w = await workerA(new Date(Date.now() + 2 * 60_000));
    expect(failedOnce).toBe(true);
    expect(w.revokeResumed).toBeGreaterThanOrEqual(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null });
    const rows = await pendingRows(accountId);
    expect(rows).toMatchObject([{ kind: 'cleanup_revoke', source: 'revoke_current' }]);
    expect(openPending(ownerA, accountId, rows[0]!.sealedToken!, rows[0]!.keyVersion!)).toBe(current);
    expect(await liveProviderTokens(accountId)).toBe(1);
    await workerA(new Date(Date.now() + 3 * 60_000));
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});

describe('FIX6 놓친 케이스 (Codex review-FIX5-T13)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    as(A);
  });

  it('해제 마무리 트랜잭션이 실패하면(INSERT·감사 뒤) 암호문·revoking·verify_current·정리 대기 모두 그대로, 새 행 없음 → 다시 해제가 합류해 마무리', async () => {
    const { accountId, vc } = await fix6VerifyCurrentAccount();
    const before = (await credRow(accountId))!;
    const auditsBefore = (await auditDetails(accountId, 'oauth.revoked')).length;
    mockOAuthStore().failNext = { op: 'revoke', code: 'invalid_grant' };
    oauthTestHooks.insideRevokeFinish = async () => {
      throw new Error('finish failure');
    };
    const rv = await revoke(accountId);
    delete oauthTestHooks.insideRevokeFinish;
    expect(rv.status).not.toBe(200);
    const row = (await credRow(accountId))!;
    expect(row).toMatchObject({ status: 'revoking', revokedAt: null, encryptedToken: before.encryptedToken, keyVersion: before.keyVersion });
    expect(await pendingRows(accountId)).toMatchObject([{ id: vc.id, kind: 'verify_current', revision: vc.revision }]);
    expect(await auditDetails(accountId, 'oauth.revoked')).toHaveLength(auditsBefore);
    expect(await liveProviderTokens(accountId)).toBe(1);
    const again = await revoke(accountId);
    expect(await again.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'ok', account: { status: 'revoked', pending_count: 0 } });
    expect((await credRow(accountId))!).toMatchObject({ encryptedToken: null, revocationEpoch: row.revocationEpoch });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('C == P: P 철회는 성공, C 철회(같은 토큰)는 실패 → 같은 토큰의 철회가 확인됐으므로 행을 만들지 않음(not_needed)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownStored(accountId);
    const orig = MockThreadsOAuthProvider.prototype.revoke;
    let calls = 0;
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
      calls++;
      if (calls === 1) return orig.call(this, input);
      throw new OAuthProviderError('invalid_grant');
    });
    const rv = await revoke(accountId);
    expect(calls).toBe(2);
    expect(await rv.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'failed', account: { pending_count: 0 } });
    expect(await pendingRows(accountId)).toHaveLength(0);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ current_token_record: 'not_needed', pending_tokens_revoked: 1 });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('C == P 행의 revision 이 해제 도중 바뀌면(조건부 UPDATE 0행) 그 행에 기대지 않고 C 를 새 cleanup_revoke 로 기록 → check 가 모두 정리', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    await refreshUnknownStored(accountId);
    const current = await decryptToken(ownerA, accountId);
    const p = (await pendingRows(accountId))[0]!;
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function () {
      throw new OAuthProviderError('invalid_grant');
    });
    oauthTestHooks.afterRevokeMarked = async () => {
      await db.update(schema.oauthPendingTokens).set({ revision: p.revision + 1 }).where(eq(schema.oauthPendingTokens.id, p.id));
    };
    const rv = await revoke(accountId);
    delete oauthTestHooks.afterRevokeMarked;
    expect(await rv.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'failed' });
    const rows = await pendingRows(accountId);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === p.id)).toMatchObject({ kind: 'refresh_unknown', revision: p.revision + 1 });
    const rec = rows.find((r) => r.id !== p.id)!;
    expect(rec).toMatchObject({ kind: 'cleanup_revoke', source: 'revoke_current' });
    expect(openPending(ownerA, accountId, rec.sealedToken!, rec.keyVersion!)).toBe(current);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ current_token_record: 'recorded' });
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(false);
    vi.restoreAllMocks();
    const ck = await check(accountId);
    expect((await ck.json()).account).toMatchObject({ status: 'revoked', pending_count: 0 });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('worker 의 정리가 예외로 끝나도 기한이 지난 행만 미루고 기한 전 행의 예약·시도 수·revision 은 그대로', async () => {
    const T = new Date(Date.now() + DAY);
    const accountId = await newThreadsAccount(ownerB);
    const seal = (t: string) =>
      sealSecret(requireSecretKeyring(process.env), JSON.stringify({ v: 1, access_token: t, refresh_token: null }), { ownerId: ownerB, channelAccountId: accountId, purpose: 'oauth_pending_token' });
    const s1 = seal(`mockthr_at_due_${randomUUID()}`);
    const s2 = seal(`mockthr_at_later_${randomUUID()}`);
    const [due] = await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: ownerB, channelAccountId: accountId, kind: 'cleanup_revoke', sealedToken: s1.ciphertext, keyVersion: s1.keyVersion, source: 'test', nextAttemptAt: new Date(T.getTime() - 60_000) })
      .returning();
    const nextLater = new Date(T.getTime() + 3600_000);
    const [later] = await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: ownerB, channelAccountId: accountId, kind: 'cleanup_revoke', sealedToken: s2.ciphertext, keyVersion: s2.keyVersion, source: 'test', attempts: 3, nextAttemptAt: nextLater, lastResult: 'invalid_grant' })
      .returning();
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function () {});
    oauthTestHooks.afterReconcileProvider = async () => {
      throw new Error('reconcile crash');
    };
    const w = await refreshExpiringCredentials(db, { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerB, now: T });
    delete oauthTestHooks.afterReconcileProvider;
    expect(w.pendingRemaining).toBeGreaterThanOrEqual(1);
    const rows = await pendingRows(accountId);
    const d = rows.find((r) => r.id === due!.id)!;
    expect(d).toMatchObject({ attempts: 1, lastResult: 'reconcile_error' });
    expect(d.nextAttemptAt.getTime()).toBe(T.getTime() + 60_000);
    const l = rows.find((r) => r.id === later!.id)!;
    expect(l).toMatchObject({ attempts: 3, revision: later!.revision, lastResult: 'invalid_grant' });
    expect(l.nextAttemptAt.getTime()).toBe(nextLater.getTime());
  });
});

describe('FIX6 P2 :1356 — 낡은 판정 뒤의 미루기는 다음 시도 시각을 앞당기지 않는다', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    as(A);
  });
  const sealB = (accountId: string, t: string) =>
    sealSecret(requireSecretKeyring(process.env), JSON.stringify({ v: 1, access_token: t, refresh_token: null }), { ownerId: ownerB, channelAccountId: accountId, purpose: 'oauth_pending_token' });
  const workerB = (now: Date) => refreshExpiringCredentials(db, { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerB, now });

  /** 세 pass 모두 낡은 판정이 되도록 공급자 호출 뒤마다 revision 을 올린다. 미루기 직전에 다른 호출이 예약을 바꾼다(set). */
  async function staleWithInterleave(set: (T: Date) => Partial<typeof schema.oauthPendingTokens.$inferInsert>) {
    const T = new Date(Date.now() + DAY);
    const accountId = await newThreadsAccount(ownerB);
    const s = sealB(accountId, `mockthr_at_stale6_${randomUUID()}`);
    const [row] = await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: ownerB, channelAccountId: accountId, kind: 'cleanup_revoke', sealedToken: s.ciphertext, keyVersion: s.keyVersion, source: 'test', nextAttemptAt: new Date(T.getTime() - 60_000) })
      .returning();
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function () {});
    oauthTestHooks.afterReconcileProvider = async () => {
      const cur = (await pendingRows(accountId))[0];
      if (cur) await db.update(schema.oauthPendingTokens).set({ revision: cur.revision + 1 }).where(eq(schema.oauthPendingTokens.id, cur.id));
    };
    oauthTestHooks.beforeStaleBump = async () => {
      const cur = (await pendingRows(accountId))[0]!;
      await db.update(schema.oauthPendingTokens).set({ ...set(T), revision: cur.revision + 1 }).where(eq(schema.oauthPendingTokens.id, cur.id));
    };
    await workerB(T);
    delete oauthTestHooks.afterReconcileProvider;
    delete oauthTestHooks.beforeStaleBump;
    return { T, accountId, row: row!, after: (await pendingRows(accountId))[0]! };
  }

  it('다른 호출이 더 늦게(T+1시간) 미뤄 둔 예약·시도 수·결과를 오래된 기준 시각(T+1분)으로 되돌리지 않는다', async () => {
    const { T, after, row } = await staleWithInterleave((T) => ({ nextAttemptAt: new Date(T.getTime() + 3600_000), attempts: 5, lastResult: 'other_call' }));
    expect(after).toMatchObject({ id: row.id, attempts: 5, lastResult: 'other_call', revision: row.revision + 4 });
    expect(after.nextAttemptAt.getTime()).toBe(T.getTime() + 3600_000);
  });

  it('다른 호출의 예약이 계산값보다 이르면(T+30초) 미루기는 그대로 적용(T+1분, attempts+1, reconcile_stale)', async () => {
    const { T, after } = await staleWithInterleave((T) => ({ nextAttemptAt: new Date(T.getTime() + 30_000), attempts: 0, lastResult: 'other_call' }));
    expect(after).toMatchObject({ attempts: 1, lastResult: 'reconcile_stale' });
    expect(after.nextAttemptAt.getTime()).toBe(T.getTime() + 60_000);
  });

  it('사용자 확인이 기한 전 행(attempts 3, +1시간)을 처리해 실패해도 다음 시도 시각을 앞당기지 않는다(+8분이 아니라 +1시간 유지)', async () => {
    const accountId = await newThreadsAccount(ownerB);
    const s = sealB(accountId, `mockthr_at_user_${randomUUID()}`);
    const next = new Date(Date.now() + 3600_000);
    const [row] = await db
      .insert(schema.oauthPendingTokens)
      .values({ ownerId: ownerB, channelAccountId: accountId, kind: 'cleanup_revoke', sealedToken: s.ciphertext, keyVersion: s.keyVersion, source: 'test', attempts: 3, nextAttemptAt: next, lastResult: 'invalid_grant' })
      .returning();
    vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function () {
      throw new OAuthProviderError('invalid_grant');
    });
    as(B);
    const ck = await check(accountId, tokenB);
    expect(ck.status).toBe(200);
    const after = (await pendingRows(accountId))[0]!;
    expect(after).toMatchObject({ id: row!.id, attempts: 4, revision: row!.revision + 1 });
    expect(after.nextAttemptAt.getTime()).toBe(next.getTime());
  });
});

describe('FIX6 P1 :1541 — 키 교체 경로: 모르는 키 버전으로 해제(incomplete) → 이전 키로 교체(다시 봉인) → worker 가 철회', () => {
  it('rotate 가 revoking 암호문도 새 키로 다시 봉인하고, 옛 키를 뺀 뒤 worker 가 같은 작업으로 철회·마무리', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2' });
    expect(await (await revoke(accountId)).json()).toMatchObject({ outcome: 'incomplete', remote_revoke: 'skipped_unreadable', incomplete_code: 'revoke_current_unreadable' });
    const kept = (await credRow(accountId))!;
    expect(kept).toMatchObject({ status: 'revoking', keyVersion: 1 });
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: KEY1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
    await rotateSecretKeys(db, requireSecretKeyring(process.env));
    const resealed = (await credRow(accountId))!;
    expect(resealed).toMatchObject({ status: 'revoking', keyVersion: 2, revokeOpId: kept.revokeOpId, lastErrorCode: 'revoke_current_unreadable' });
    expect(resealed.encryptedToken).not.toBe(kept.encryptedToken);
    useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2' });
    expect(await liveProviderTokens(accountId)).toBe(1);
    const w = await workerA(new Date(Date.now() + 2 * 60_000));
    expect(w.revokeResumed).toBeGreaterThanOrEqual(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, revocationEpoch: kept.revocationEpoch });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});

// ---------------- FIX round 7 (Codex review-FIX6-T13) ----------------

/** 공급자 철회 호출에 넘어간 access token 들(원래 동작은 그대로) */
function spyRevokedTokens(): string[] {
  const seenTokens: string[] = [];
  const orig = MockThreadsOAuthProvider.prototype.revoke;
  vi.spyOn(MockThreadsOAuthProvider.prototype, 'revoke').mockImplementation(async function (this: MockThreadsOAuthProvider, input) {
    seenTokens.push(input.tokens.accessToken);
    return orig.call(this, input);
  });
  return seenTokens;
}

describe('FIX7 P1 :1791 — worker 재개는 훑을 때 본 해제 작업(작업 ID·세대)에 묶인다', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('훑은 뒤 사용자가 해제를 마치고 다시 연결하면(새 세대) worker 는 새 연결 정보를 건드리지 않는다 — 공급자 철회 없음, skipped_changed', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const oldToken = await decryptToken(ownerA, accountId);
    useKeys({});
    expect(await (await revoke(accountId)).json()).toMatchObject({ outcome: 'incomplete', incomplete_code: 'revoke_current_no_key' });
    const stuck = (await credRow(accountId))!;
    key1();
    let fresh = null as Awaited<ReturnType<typeof credRow>>;
    let newToken = '';
    let revokedAuditsAfterReconnect = 0;
    oauthTestHooks.beforeRevokeResume = async (c) => {
      if (c.accountId !== accountId) return;
      delete oauthTestHooks.beforeRevokeResume;
      // 사용자가 해제를 다시 눌러 같은 작업을 마치고(옛 토큰 철회), 곧바로 다시 연결(새 토큰·새 세대)
      expect(await (await revoke(accountId)).json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'ok' });
      await connectFully(accountId);
      fresh = await credRow(accountId);
      newToken = await decryptToken(ownerA, accountId);
      revokedAuditsAfterReconnect = (await auditDetails(accountId, 'oauth.revoked')).length;
    };
    const tokens = spyRevokedTokens();
    const w = await workerA(new Date(Date.now() + 2 * 60_000));
    expect(fresh).not.toBeNull();
    expect(w.revokeSkippedChanged).toBeGreaterThanOrEqual(1);
    // 옛 토큰은 사용자 해제가 철회했고, 새 토큰은 누구도 철회하지 않았다
    expect(tokens).toContain(oldToken);
    expect(tokens).not.toContain(newToken);
    const after = (await credRow(accountId))!;
    expect(after).toEqual(fresh);
    expect(after).toMatchObject({
      status: 'active',
      revokedAt: null,
      revokeOpId: null,
      tokenGeneration: stuck.tokenGeneration + 1,
      revocationEpoch: stuck.revocationEpoch,
      revokeResumeAt: null,
      revokeResumeAttempts: 0,
    });
    expect(await decryptToken(ownerA, accountId)).toBe(newToken);
    expect(await liveProviderTokens(accountId)).toBe(1);
    expect(await auditDetails(accountId, 'oauth.revoked')).toHaveLength(revokedAuditsAfterReconnect);
    expect((await getAccountHealth(db, ownerA, accountId)).usable_for_execution).toBe(true);
  });

  it('훑은 뒤 해제가 끝나고 다시 연결 → 새 해제(다른 작업 ID)가 미완료로 남아도 worker 는 옛 작업으로 잇지 않는다(합류·새 작업·미루기 없음)', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    useKeys({});
    await revoke(accountId);
    const first = (await credRow(accountId))!;
    key1();
    let second = null as Awaited<ReturnType<typeof credRow>>;
    let callsInHook = 0;
    const tokens = spyRevokedTokens();
    oauthTestHooks.beforeRevokeResume = async (c) => {
      if (c.accountId !== accountId) return;
      delete oauthTestHooks.beforeRevokeResume;
      await revoke(accountId);
      await connectFully(accountId);
      useKeys({});
      expect(await (await revoke(accountId)).json()).toMatchObject({ outcome: 'incomplete' });
      key1();
      second = await credRow(accountId);
      callsInHook = tokens.length;
    };
    const w = await workerA(new Date(Date.now() + 2 * 60_000));
    expect(w.revokeSkippedChanged).toBeGreaterThanOrEqual(1);
    expect(second).not.toBeNull();
    expect(second!.revokeOpId).not.toBe(first.revokeOpId);
    // 두 번째 해제는 그대로 — 작업 ID·세대·재개 시각·시도 수 모두 같고, worker 는 공급자를 더 부르지 않았다
    expect(await credRow(accountId)).toEqual(second);
    expect(tokens.length).toBe(callsInHook);
  });
});

describe('FIX7 P2 :1779 — 열 수 없는 미완료 해제가 worker 처리 한도를 독점하지 않는다', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('limit=1, 앞 행은 열 수 없음(모르는 키 버전) · 뒤 행은 열림 → 첫 tick 은 앞 행을 미루고, 다음 tick 이 뒤 행을 철회·마무리', async () => {
    const bad = await newThreadsAccount();
    const good = await newThreadsAccount();
    await connectFully(bad);
    await connectFully(good);
    useKeys({});
    await revoke(bad);
    await revoke(good);
    key1();
    // 앞 행: 지금 키링에 없는 키 버전(분실한 키로 봉인된 것과 같음). 두 행 모두 이 owner 의 다른 행보다 앞서게 재개 시각을 둔다
    await db.update(schema.oauthCredentials).set({ keyVersion: 7, revokeResumeAt: new Date(0) }).where(eq(schema.oauthCredentials.channelAccountId, bad));
    await db.update(schema.oauthCredentials).set({ revokeResumeAt: new Date(1000) }).where(eq(schema.oauthCredentials.channelAccountId, good));
    const badBefore = (await credRow(bad))!;
    const badAudits = (await auditDetails(bad, 'oauth.revoked')).length;
    const T = new Date(Date.now() + 2 * 60_000);
    const w = (now: Date) => refreshExpiringCredentials(db, { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerA, now, limit: 1 });
    const w1 = await w(T);
    expect(w1).toMatchObject({ revokeWaiting: 1, revokeResumed: 0 });
    const badAfter = (await credRow(bad))!;
    expect(badAfter).toMatchObject({
      status: 'revoking',
      encryptedToken: badBefore.encryptedToken,
      keyVersion: 7,
      updatedAt: badBefore.updatedAt,
      lastErrorCode: badBefore.lastErrorCode,
      revokeResumeAttempts: badBefore.revokeResumeAttempts + 1,
    });
    expect(badAfter.revokeResumeAt!.getTime()).toBe(T.getTime() + 2 * 60_000);
    expect((await credRow(good))!.status).toBe('revoking');
    const w2 = await w(T);
    expect(w2).toMatchObject({ revokeResumed: 1, revokeWaiting: 0 });
    expect(await credRow(good)).toMatchObject({ status: 'revoked', encryptedToken: null, revokeResumeAt: null, revokeResumeAttempts: 0 });
    expect(await liveProviderTokens(good)).toBe(0);
    // 앞 행은 그대로 차단 — 감사·암호문 변화 없음
    expect(await credRow(bad)).toMatchObject({ status: 'revoking', encryptedToken: badBefore.encryptedToken });
    expect(await auditDetails(bad, 'oauth.revoked')).toHaveLength(badAudits);
    expect(await liveProviderTokens(bad)).toBe(1);
  });
});

describe('FIX7 놓친 케이스 (Codex review-FIX6-T13)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('공급자를 쓸 수 없어 incomplete(revoke_provider_unavailable) → 공급자 없는 동안 worker 는 미루기만 → 공급자 복구 뒤 사용자 조작 없이 worker 가 철회·마무리', async () => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    const d = oauthDeps(config);
    const noProvider = () => {
      throw new Error('provider unavailable');
    };
    const rv = await revokeCredential(db, { ownerId: ownerA, accountId, providerFor: noProvider, keyring: d.keyring });
    expect(rv).toMatchObject({ outcome: 'incomplete', remoteRevoke: 'skipped_unsupported', incompleteCode: 'revoke_provider_unavailable' });
    const kept = (await credRow(accountId))!;
    expect(kept).toMatchObject({ status: 'revoking', lastErrorCode: 'revoke_provider_unavailable' });
    const T1 = new Date(Date.now() + 2 * 60_000);
    const w1 = await refreshExpiringCredentials(db, { providerFor: noProvider, keyring: d.keyring, ownerId: ownerA, now: T1 });
    expect(w1.revokeWaiting).toBeGreaterThanOrEqual(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoking', encryptedToken: kept.encryptedToken, updatedAt: kept.updatedAt, revokeResumeAttempts: 2 });
    expect(await liveProviderTokens(accountId)).toBe(1);
    const w2 = await workerA(new Date(T1.getTime() + 2 * 60_000));
    expect(w2.revokeResumed).toBeGreaterThanOrEqual(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, revokeOpId: kept.revokeOpId, revocationEpoch: kept.revocationEpoch });
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', joined: true, remote_revoke: 'ok' });
  });

  it.each([
    { name: '1단계 커밋 직후 멈춤(공급자 호출 전)', hook: 'afterRevokeMarked' as const },
    { name: '마무리 트랜잭션 롤백', hook: 'insideRevokeFinish' as const },
  ])('$name → last_error_code 표시 없이 revoking 으로 남아도 1단계가 정한 시각 뒤 worker 만으로 같은 작업을 마무리', async (c) => {
    const accountId = await newThreadsAccount();
    await connectFully(accountId);
    oauthTestHooks[c.hook] = async () => {
      throw new Error('process stopped');
    };
    const rv = await revoke(accountId);
    delete oauthTestHooks[c.hook];
    expect(rv.status).not.toBe(200);
    const stuck = (await credRow(accountId))!;
    expect(stuck).toMatchObject({ status: 'revoking', revokedAt: null, lastErrorCode: null, revokeResumeAttempts: 1 });
    expect(stuck.revokeOpId).not.toBeNull();
    // 진행 중 표시 시각 전에는 잇지 않는다
    const w0 = await workerA(new Date());
    expect(w0.revokeResumed).toBe(0);
    expect((await credRow(accountId))!.status).toBe('revoking');
    const w = await workerA(new Date(Date.now() + 2 * 60_000));
    expect(w.revokeResumed).toBeGreaterThanOrEqual(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, revokeOpId: stuck.revokeOpId, revocationEpoch: stuck.revocationEpoch });
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect((await auditDetails(accountId, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', joined: true });
  });
});

// ---------------- FIX round 8 (Codex review-FIX7-T13) ----------------

describe('FIX8 P2 :1508 — worker 재개는 잠금 안에서 재개 예약도 확인하고 잡은 뒤에만 공급자를 부른다', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 키 없이 해제(incomplete) → 키 복구. 이 행을 재개 순서 맨 앞에 둔다(limit=1 worker 가 이 행만 고르게). */
  async function stuckRevokeFirst(accountId: string) {
    await connectFully(accountId);
    const token = await decryptToken(ownerA, accountId);
    useKeys({});
    expect(await (await revoke(accountId)).json()).toMatchObject({ outcome: 'incomplete', incomplete_code: 'revoke_current_no_key' });
    key1();
    await db.update(schema.oauthCredentials).set({ revokeResumeAt: new Date(0) }).where(eq(schema.oauthCredentials.channelAccountId, accountId));
    return { token, stuck: (await credRow(accountId))! };
  }
  const worker1 = (now: Date) => refreshExpiringCredentials(db, { providerFor: oauthDeps(config).providerFor, keyring: oauthDeps(config).keyring, ownerId: ownerA, now, limit: 1 });

  it('두 worker 가 같은 행을 함께 훑음 → A 가 잡아(1단계 커밋) 공급자 호출 전에 B 가 잠금 확인 → B 는 skipped_busy, 공급자 철회는 한 번', async () => {
    const accountId = await newThreadsAccount();
    const { token, stuck } = await stuckRevokeFirst(accountId);
    const audits = (await auditDetails(accountId, 'oauth.revoked')).length;
    const T = new Date(Date.now() + 2 * 60_000);
    const tokens = spyRevokedTokens();
    let bScanned!: () => void;
    const bScannedP = new Promise<void>((r) => (bScanned = r));
    let aMarked!: () => void;
    const aMarkedP = new Promise<void>((r) => (aMarked = r));
    let seen = 0;
    let wB: ReturnType<typeof worker1> | null = null;
    let leaseSeenByB: Date | null = null;
    oauthTestHooks.beforeRevokeResume = async (c) => {
      if (c.accountId !== accountId) return;
      seen++;
      if (seen === 1) {
        // A 가 훑은 뒤 — B 도 같은 행을 훑게 하고, B 가 재개 직전에 멈출 때까지 기다린다
        wB = worker1(T);
        await bScannedP;
      } else if (seen === 2) {
        bScanned();
        // A 가 1단계(재개 잡기)를 커밋할 때까지 B 의 잠금 확인을 늦춘다
        await aMarkedP;
        leaseSeenByB = (await credRow(accountId))!.revokeResumeAt;
      }
    };
    oauthTestHooks.afterRevokeMarked = async () => {
      delete oauthTestHooks.afterRevokeMarked;
      aMarked();
      // B 가 잠금 확인을 끝낸 뒤에야 A 가 공급자를 부른다(겹침 구간을 강제)
      await wB;
    };
    const wA = await worker1(T);
    const b = await wB!;
    expect(seen).toBe(2);
    expect(wA).toMatchObject({ revokeResumed: 1, revokeSkippedBusy: 0, revokeSkippedChanged: 0 });
    expect(b).toMatchObject({ revokeResumed: 0, revokeSkippedBusy: 1, revokeSkippedChanged: 0, revokeWaiting: 0 });
    // A 의 잡기: 예약이 now + backoff(시도 2 → 2분)로 옮겨졌다
    expect(leaseSeenByB!.getTime()).toBe(T.getTime() + 2 * 60_000);
    expect(tokens.filter((t) => t === token)).toHaveLength(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, revokeOpId: stuck.revokeOpId, revocationEpoch: stuck.revocationEpoch });
    expect(await liveProviderTokens(accountId)).toBe(0);
    expect(await auditDetails(accountId, 'oauth.revoked')).toHaveLength(audits + 1);
  });

  it('훑은 뒤 사용자 해제가 합류해 예약을 새로 잡고 공급자 응답 전 → worker 는 skipped_busy(공급자 호출·쓰기 없음), 사용자 해제만 철회', async () => {
    const accountId = await newThreadsAccount();
    const { token, stuck } = await stuckRevokeFirst(accountId);
    const T = new Date(Date.now() + 2 * 60_000);
    const tokens = spyRevokedTokens();
    let userMarked!: () => void;
    const userMarkedP = new Promise<void>((r) => (userMarked = r));
    let wP: ReturnType<typeof worker1> | null = null;
    let userP: Promise<Response> | null = null;
    let leased = null as Awaited<ReturnType<typeof credRow>>;
    let afterWorker = null as Awaited<ReturnType<typeof credRow>>;
    oauthTestHooks.beforeRevokeResume = async (c) => {
      if (c.accountId !== accountId) return;
      delete oauthTestHooks.beforeRevokeResume;
      userP = revoke(accountId);
      await userMarkedP;
      leased = await credRow(accountId);
    };
    oauthTestHooks.afterRevokeMarked = async () => {
      delete oauthTestHooks.afterRevokeMarked;
      userMarked();
      // 사용자 해제는 worker 가 잠금 확인을 끝낼 때까지 공급자를 부르지 않는다
      await wP;
      afterWorker = await credRow(accountId);
    };
    wP = worker1(T);
    const w = await wP;
    const rv = await userP!;
    expect(w).toMatchObject({ revokeResumed: 0, revokeSkippedBusy: 1, revokeSkippedChanged: 0 });
    // 사용자 합류가 예약·시도 수를 바꿨고(시도 +1), worker 는 그 행을 그대로 두었다
    expect(leased!.revokeResumeAttempts).toBe(stuck.revokeResumeAttempts + 1);
    expect(leased!.revokeResumeAt!.getTime()).toBeGreaterThan(Date.now());
    expect(afterWorker).toEqual(leased);
    expect(await rv.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'ok' });
    expect(tokens.filter((t) => t === token)).toHaveLength(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, revokeOpId: stuck.revokeOpId });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('놓친 케이스: 훑은 뒤 같은 작업의 예약만 미래로 연장 → worker 는 공급자 호출·예약·시도 수·감사 변경 없이 건너뜀, 기한이 지나면 잇는다', async () => {
    const accountId = await newThreadsAccount();
    const { token } = await stuckRevokeFirst(accountId);
    const T = new Date(Date.now() + 2 * 60_000);
    const audits = (await auditDetails(accountId, 'oauth.revoked')).length;
    const tokens = spyRevokedTokens();
    let extended = null as Awaited<ReturnType<typeof credRow>>;
    oauthTestHooks.beforeRevokeResume = async (c) => {
      if (c.accountId !== accountId) return;
      delete oauthTestHooks.beforeRevokeResume;
      // 다른 worker 가 잡은 것과 같음(시도 수는 그대로, 예약만 T + 1시간)
      await db.update(schema.oauthCredentials).set({ revokeResumeAt: new Date(T.getTime() + 60 * 60_000) }).where(eq(schema.oauthCredentials.channelAccountId, accountId));
      extended = await credRow(accountId);
    };
    const w = await worker1(T);
    expect(w).toMatchObject({ revokeResumed: 0, revokeSkippedBusy: 1, revokeWaiting: 0 });
    expect(await credRow(accountId)).toEqual(extended);
    expect(tokens).toHaveLength(0);
    expect(await auditDetails(accountId, 'oauth.revoked')).toHaveLength(audits);
    // 그 예약 시각 뒤의 tick 은 잇는다
    const w2 = await workerA(new Date(T.getTime() + 61 * 60_000));
    expect(w2.revokeResumed).toBeGreaterThanOrEqual(1);
    expect(tokens.filter((t) => t === token)).toHaveLength(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null });
  });

  it('놓친 케이스: 0035 이전 모양(예약 null·시도 0·오류 코드 null) — updated_at + 60초의 1ms 전에는 잇지 않고, 정확히 그 시각에는 잇는다', async () => {
    const accountId = await newThreadsAccount();
    const { token } = await stuckRevokeFirst(accountId);
    const T = new Date(Date.now() + 10 * 60_000);
    await db
      .update(schema.oauthCredentials)
      .set({ revokeResumeAt: null, revokeResumeAttempts: 0, lastErrorCode: null, updatedAt: new Date(T.getTime() - 60_000 + 1) })
      .where(eq(schema.oauthCredentials.channelAccountId, accountId));
    const before = (await credRow(accountId))!;
    const tokens = spyRevokedTokens();
    await workerA(T);
    expect(await credRow(accountId)).toEqual(before);
    expect(tokens.filter((t) => t === token)).toHaveLength(0);
    await db.update(schema.oauthCredentials).set({ updatedAt: new Date(T.getTime() - 60_000) }).where(eq(schema.oauthCredentials.channelAccountId, accountId));
    await workerA(T);
    expect(tokens.filter((t) => t === token)).toHaveLength(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, revokeOpId: before.revokeOpId });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });

  it('놓친 케이스: 훑은 뒤·잠금 전 키 교체(작업 ID·세대·예약 그대로, 암호문만 바뀜) → 잠금 안의 현재 암호문으로 철회·마무리', async () => {
    const accountId = await newThreadsAccount();
    const { token, stuck } = await stuckRevokeFirst(accountId);
    const T = new Date(Date.now() + 2 * 60_000);
    const tokens = spyRevokedTokens();
    let resealed = null as Awaited<ReturnType<typeof credRow>>;
    oauthTestHooks.beforeRevokeResume = async (c) => {
      if (c.accountId !== accountId) return;
      delete oauthTestHooks.beforeRevokeResume;
      useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: KEY1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
      await rotateSecretKeys(db, requireSecretKeyring(process.env));
      useKeys({ SECRETS_MASTER_KEY: KEY2, SECRETS_KEY_VERSION: '2' });
      resealed = await credRow(accountId);
    };
    const w = await worker1(T);
    expect(resealed).toMatchObject({ status: 'revoking', keyVersion: 2, revokeOpId: stuck.revokeOpId, tokenGeneration: stuck.tokenGeneration, revokeResumeAt: stuck.revokeResumeAt });
    expect(resealed!.encryptedToken).not.toBe(stuck.encryptedToken);
    expect(w).toMatchObject({ revokeResumed: 1, revokeSkippedBusy: 0, revokeSkippedChanged: 0 });
    expect(tokens.filter((t) => t === token)).toHaveLength(1);
    expect(await credRow(accountId)).toMatchObject({ status: 'revoked', encryptedToken: null, revokeOpId: stuck.revokeOpId, revocationEpoch: stuck.revocationEpoch });
    expect(await liveProviderTokens(accountId)).toBe(0);
  });
});
