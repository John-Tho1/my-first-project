/**
 * FIX2-FULLREV2(G13·G14): 실제 Threads 계정의 연결 해제·다시 연결 — route → DB. **실제 네트워크 호출 0**(fixture fetch, setupFiles 가드).
 * - G13: 실제 Threads 는 원격 철회 API 가 없으므로 live OAuth 준비 설정(승인 기록·OAUTH_MODE·시크릿 형식·마스터 키)이 빠져도 해제는 로컬 삭제로 끝난다.
 *   이전 판에서 revoking(incomplete)으로 멈춘 연결 정보도 다음 해제·worker tick 에서 마무리된다.
 * - G14: 해제가 끝나지 않은(revoking) 계정의 연결 시작은 409 credential_busy — 연결 요청 행·감사·인증 창 주소 없음, 외부 호출 0.
 * 앱 ID·시크릿·토큰·code 는 모두 가짜(FAKE_…).
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, oauthTestHooks, refreshExpiringCredentials, schema, seed, type Db } from '@cs/db';
import { loadConfig, requireSecretKeyring, sealSecret } from '@cs/domain';
import { THREADS_LONG_LIVED_URL, THREADS_ME_URL, THREADS_TOKEN_URL } from '@cs/providers';
import { POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as revokePOST } from '../../apps/web/app/api/channel-accounts/[id]/revoke/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { oauthDeps } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000001';
const SECRET = 'FAKE_app_secret_FULLREV2_G13_only';
const REDIRECT = `${BASE}/api/oauth/callback`;

let db: Db;
let ownerA: string;
let tokenA: string;
let tmp: string;
let profileSeq = 9_100_000;

const LIVE_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const liveEnv = (over: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ ...LIVE_ENV, ...over })) vi.stubEnv(k, v);
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(tokenA));

const calls: string[] = [];
function useFixture(routes: Record<string, () => Response>) {
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`;
    calls.push(key);
    const r = routes[key];
    if (!r) throw new Error(`fixture 없음: ${key}`);
    return r();
  });
  vi.stubGlobal('fetch', f);
  return f;
}
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const credRow = async (id: string) => (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, id)))[0] ?? null;
const statesOf = async (id: string) => db.select().from(schema.oauthStates).where(eq(schema.oauthStates.channelAccountId, id));
const auditOf = async (id: string, action: string) =>
  (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.entityId, id), eq(schema.auditEvents.action, action)))).map((e) => e.sanitizedDetails as Record<string, unknown>);
const connect = (id: string, html = false) =>
  connectPOST(
    html
      ? new Request(`${BASE}/api/channel-accounts/${id}/connect`, { method: 'POST', headers: { accept: 'text/html', origin: BASE, ...cookieHeader(tokenA) } })
      : post(`/api/channel-accounts/${id}/connect`),
    ctx(id),
  );
const revoke = (id: string) => revokePOST(post(`/api/channel-accounts/${id}/revoke`), ctx(id));

/** 실제 Threads 계정 하나를 fixture 로 끝까지 연결(계정마다 다른 프로필 ID) */
async function connectedLive(): Promise<string> {
  const created = await accountsPOST(post('/api/channel-accounts', { platform: 'threads', kind: 'live' }));
  const id = ((await created.json()) as { account: { id: string } }).account.id;
  liveEnv();
  const profile = String(++profileSeq);
  useFixture({
    [`POST ${THREADS_TOKEN_URL}`]: () => jsonRes(200, { access_token: `FAKE_short_${profile}_ssssssssssss`, token_type: 'bearer', user_id: 17841405793187218 }),
    [`GET ${THREADS_LONG_LIVED_URL}`]: () => jsonRes(200, { access_token: `FAKE_long_${profile}_llllllllllllll`, token_type: 'bearer', expires_in: 5184000 }),
    [`GET ${THREADS_ME_URL}`]: () => jsonRes(200, { id: profile, username: `g13user${profile}` }),
  });
  const c = await connect(id);
  expect(c.status, await c.clone().text()).toBe(200);
  const state = new URL(((await c.json()) as { authorize_url: string }).authorize_url).searchParams.get('state')!;
  const u = new URL(REDIRECT);
  u.searchParams.set('code', `FAKE_code_${profile}_cccccccccccc`);
  u.searchParams.set('state', state);
  const cb = await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(tokenA) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  const cred = (await credRow(id))!;
  expect(cred).toMatchObject({ status: 'active', isMock: false, provider: 'threads' });
  expect(cred.encryptedToken).not.toBeNull();
  vi.unstubAllGlobals();
  calls.length = 0; // 이후 검사는 연결 뒤의 호출만 센다
  return id;
}

/** 이전 판에서 멈춘 해제를 만든다: 1단계 커밋 직후 멈춤(revoking) + 이전 판이 남긴 이유 코드(revoke_provider_unavailable) */
async function stuckRevoking(id: string) {
  oauthTestHooks.afterRevokeMarked = async () => {
    throw new Error('process stopped');
  };
  const r = await revoke(id);
  delete oauthTestHooks.afterRevokeMarked;
  expect(r.status).not.toBe(200);
  await db.update(schema.oauthCredentials).set({ lastErrorCode: 'revoke_provider_unavailable' }).where(eq(schema.oauthCredentials.channelAccountId, id));
  const stuck = (await credRow(id))!;
  expect(stuck).toMatchObject({ status: 'revoking', revokedAt: null, lastErrorCode: 'revoke_provider_unavailable' });
  expect(stuck.encryptedToken).not.toBeNull();
  expect(stuck.revokeOpId).not.toBeNull();
  return stuck;
}

function expectLocallyRevoked(row: Awaited<ReturnType<typeof credRow>>) {
  expect(row).toMatchObject({ status: 'revoked', encryptedToken: null, keyVersion: null, lastErrorCode: null, revokeResumeAt: null, revokeResumeAttempts: 0 });
  expect(row!.revokedAt).not.toBeNull();
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr2-g13-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  tokenA = await login(A);
});
beforeEach(() => {
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  for (const k of Object.keys(LIVE_ENV)) vi.stubEnv(k, '');
  for (const k of Object.keys(oauthTestHooks) as Array<keyof typeof oauthTestHooks>) delete oauthTestHooks[k];
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

describe('FIX2-FULLREV2(G13) — 실제 Threads 연결 해제는 live 준비 설정과 무관하게 로컬 삭제로 끝난다', () => {
  it.each([
    ['OAUTH_LIVE_APPROVAL_REF 없음', { OAUTH_LIVE_APPROVAL_REF: '' }, {}],
    ['OAUTH_MODE=mock', { OAUTH_MODE: 'mock' }, {}],
    ['THREADS_APP_SECRET 형식 오류', { THREADS_APP_SECRET: 'FAKE secret with space' }, {}],
    ['SECRETS_MASTER_KEY 없음', {}, { SECRETS_MASTER_KEY: '' }],
  ] as const)('%s → revoke 200 outcome revoked·remote unsupported, 암호문·키 버전 삭제·revoked_at, 외부 호출 0', async (_name, liveOver, envOver) => {
    const id = await connectedLive();
    liveEnv(liveOver);
    for (const [k, v] of Object.entries(envOver)) vi.stubEnv(k, v);
    const f = useFixture({});
    const r = await revoke(id);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null, account: { status: 'revoked' } });
    expectLocallyRevoked(await credRow(id));
    expect(await db.select().from(schema.oauthPendingTokens).where(eq(schema.oauthPendingTokens.channelAccountId, id))).toHaveLength(0);
    expect(f).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect((await auditOf(id, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null, live_provider_unavailable: true });
    // 다시 해제해도 already_revoked(외부 호출 없음)
    const again = await revoke(id);
    expect(await again.json()).toMatchObject({ outcome: 'already_revoked' });
    expect(f).not.toHaveBeenCalled();
  });

  it('대조: live 준비가 갖춰진 해제도 같은 최종 상태(remote unsupported, 감사에 live_provider_unavailable 없음)', async () => {
    const id = await connectedLive();
    liveEnv();
    const f = useFixture({});
    const r = await revoke(id);
    expect(await r.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null });
    expectLocallyRevoked(await credRow(id));
    expect(f).not.toHaveBeenCalled();
    expect((await auditOf(id, 'oauth.revoked')).at(-1)).not.toHaveProperty('live_provider_unavailable');
  });

  it('이전 판에서 revoking(incomplete)으로 멈춘 실제 연결 정보 → 승인 기록 없이 연결 해제를 다시 누르면 같은 작업에 합류해 마무리', async () => {
    const id = await connectedLive();
    liveEnv({ OAUTH_LIVE_APPROVAL_REF: '' });
    const stuck = await stuckRevoking(id);
    const f = useFixture({});
    const r = await revoke(id);
    expect(await r.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null });
    const row = (await credRow(id))!;
    expectLocallyRevoked(row);
    expect(row).toMatchObject({ revokeOpId: stuck.revokeOpId, revocationEpoch: stuck.revocationEpoch });
    expect((await auditOf(id, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', joined: true });
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['OAUTH_MODE=mock', { OAUTH_MODE: 'mock' }, {}],
    ['SECRETS_MASTER_KEY 없음', {}, { SECRETS_MASTER_KEY: '' }],
  ] as const)('이전 판에서 멈춘 실제 연결 정보 + %s → worker tick 이 사용자 조작 없이 마무리(미루기만 반복하지 않음), 외부 호출 0', async (_name, liveOver, envOver) => {
    const id = await connectedLive();
    liveEnv({ OAUTH_LIVE_APPROVAL_REF: '' });
    const stuck = await stuckRevoking(id);
    liveEnv({ OAUTH_LIVE_APPROVAL_REF: '', ...liveOver });
    for (const [k, v] of Object.entries(envOver)) vi.stubEnv(k, v);
    const f = useFixture({});
    const d = oauthDeps(loadConfig(process.env));
    // 진행 중 표시 시각 전에는 잇지 않는다
    const w0 = await refreshExpiringCredentials(db, { providerFor: d.providerFor, keyring: d.keyring, ownerId: ownerA, now: new Date() });
    expect(w0.revokeResumed).toBe(0);
    expect((await credRow(id))!.status).toBe('revoking');
    const w = await refreshExpiringCredentials(db, { providerFor: d.providerFor, keyring: d.keyring, ownerId: ownerA, now: new Date(Date.now() + 2 * 60_000) });
    expect(w.revokeResumed).toBeGreaterThanOrEqual(1);
    const row = (await credRow(id))!;
    expectLocallyRevoked(row);
    expect(row).toMatchObject({ revokeOpId: stuck.revokeOpId, revocationEpoch: stuck.revocationEpoch });
    expect((await auditOf(id, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', joined: true, remote_revoke: 'unsupported', live_provider_unavailable: true });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('FIX2-FULLREV2(G13 fixup) — live 준비가 갖춰져도 현재 토큰을 열지 않는다(키 교체로 열 수 없어도 해제 완료)', () => {
  // 키 교체: 새 키(버전 2)만 있고 이전 버전(1)은 없다 — 연결 때 봉인한 토큰은 열 수 없다(skipped_unreadable 이 되던 경우)
  const rotateKeyWithoutOld = () => {
    vi.stubEnv('SECRETS_MASTER_KEY', randomBytes(32).toString('base64'));
    vi.stubEnv('SECRETS_KEY_VERSION', '2');
  };

  it('live 설정 완비 + 저장 토큰 복호화 불가(이전 키 버전 없음) → revoke outcome revoked·remote unsupported, 암호문 null, 외부 호출 0', async () => {
    const id = await connectedLive();
    liveEnv();
    rotateKeyWithoutOld();
    const f = useFixture({});
    const r = await revoke(id);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null, account: { status: 'revoked' } });
    expectLocallyRevoked(await credRow(id));
    expect(await db.select().from(schema.oauthPendingTokens).where(eq(schema.oauthPendingTokens.channelAccountId, id))).toHaveLength(0);
    expect(f).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    const audit = (await auditOf(id, 'oauth.revoked')).at(-1);
    expect(audit).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null, current_token_record: 'not_needed' });
    expect(audit).not.toHaveProperty('live_provider_unavailable');
  });

  // FIX2-FULLREV2(G13 재검토): 정리 대기(cleanup_revoke) 행도 열지 않는다 — 키 교체로 열 수 없어도 unsupported 로 보고 삭제(영구히 남아 다시 연결을 막지 않음)
  it('봉인된 정리 대기 행(이전 키로 봉인) + 키 교체 → 해제 outcome revoked, 정리 대기 행 0(pending_token_revoke ok), 계정 차단 행 없음, 외부 호출 0', async () => {
    const id = await connectedLive();
    liveEnv();
    const sealed = sealSecret(requireSecretKeyring(process.env), JSON.stringify({ v: 1, access_token: 'FAKE_pending_cleanup_token_g13', refresh_token: null }), {
      ownerId: ownerA,
      channelAccountId: id,
      purpose: 'oauth_pending_token',
    });
    await db.insert(schema.oauthPendingTokens).values({ ownerId: ownerA, channelAccountId: id, kind: 'cleanup_revoke', sealedToken: sealed.ciphertext, keyVersion: sealed.keyVersion, source: 'test', nextAttemptAt: new Date() });
    rotateKeyWithoutOld();
    const f = useFixture({});
    const r = await revoke(id);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: 'revoked', remote_revoke: 'unsupported', incomplete_code: null, account: { status: 'revoked' } });
    expectLocallyRevoked(await credRow(id));
    expect(await db.select().from(schema.oauthPendingTokens).where(eq(schema.oauthPendingTokens.channelAccountId, id))).toHaveLength(0);
    expect((await auditOf(id, 'oauth.revoked')).at(-1)).toMatchObject({ outcome: 'revoked', pending_token_revoke: 'ok' });
    expect(f).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('멈춘 revoking 실제 연결 정보 + live 설정 완비 + 복호화 불가 키 → worker tick 이 마무리(미루기만 반복하지 않음), 외부 호출 0', async () => {
    const id = await connectedLive();
    liveEnv();
    const stuck = await stuckRevoking(id);
    rotateKeyWithoutOld();
    const f = useFixture({});
    const d = oauthDeps(loadConfig(process.env));
    const w = await refreshExpiringCredentials(db, { providerFor: d.providerFor, keyring: d.keyring, ownerId: ownerA, now: new Date(Date.now() + 2 * 60_000) });
    expect(w.revokeResumed).toBeGreaterThanOrEqual(1);
    const row = (await credRow(id))!;
    expectLocallyRevoked(row);
    expect(row).toMatchObject({ revokeOpId: stuck.revokeOpId, revocationEpoch: stuck.revocationEpoch });
    const audit = (await auditOf(id, 'oauth.revoked')).at(-1);
    expect(audit).toMatchObject({ outcome: 'revoked', joined: true, remote_revoke: 'unsupported', incomplete_code: null });
    expect(audit).not.toHaveProperty('live_provider_unavailable');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('FIX2-FULLREV2(G14) — 해제 미완료(revoking) 계정의 연결 시작은 409 credential_busy', () => {
  it('live 준비가 모두 갖춰져도 revoking 실제 계정 connect → 409(JSON)·303 account_error=credential_busy(폼), 연결 요청 행·connect_start 감사 없음, 외부 호출 0', async () => {
    const id = await connectedLive();
    liveEnv();
    await stuckRevoking(id);
    const statesBefore = await statesOf(id);
    expect(statesBefore.every((s) => s.usedAt !== null)).toBe(true);
    const startsBefore = (await auditOf(id, 'oauth.connect_start')).length;
    const f = useFixture({});
    const r = await connect(id);
    expect(r.status).toBe(409);
    const body = await r.json();
    expect(body.error).toBe('credential_busy');
    expect(JSON.stringify(body)).not.toContain('threads.com');
    const form = await connect(id, true);
    expect(form.status).toBe(303);
    expect(form.headers.get('location')).toBe('/settings?account_error=credential_busy#accounts');
    const statesAfter = await statesOf(id);
    expect(statesAfter.map((s) => s.id).sort()).toEqual(statesBefore.map((s) => s.id).sort());
    expect(statesAfter.filter((s) => s.usedAt === null)).toHaveLength(0);
    expect((await auditOf(id, 'oauth.connect_start')).length).toBe(startsBefore);
    expect(f).not.toHaveBeenCalled();
    expect((await credRow(id))!.status).toBe('revoking');
    // 해제를 마치면 다시 연결을 시작할 수 있다(인증 창 주소만 — 외부 호출 0)
    expect((await revoke(id)).status).toBe(200);
    const ok = await connect(id);
    expect(ok.status).toBe(200);
    expect(new URL(((await ok.json()) as { authorize_url: string }).authorize_url).origin).toBe('https://threads.com');
    expect(f).not.toHaveBeenCalled();
  });
});
