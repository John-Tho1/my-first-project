/**
 * M4-DEV1(개발 품질): 개발 서버 재시작 뒤 모의 OAuth 연결 유지.
 * 모의 공급자(mock_threads·mock_google·mock_instagram)는 발급한 토큰을 프로세스 메모리에만 둔다. 재시작(= 메모리·시뮬레이터 비움) 뒤 처음 연결 경로를
 * 쓸 때 DB 의 쓸 수 있는 모의 연결 정보로 한 번 다시 채워, 다시 연결하지 않아도 새 계획의 전송·갱신이 된다.
 * 다시 채우지 않는 것: 해제·오류·다시 연결 필요·열 수 없는 봉인·정리 대기 토큰·실제(live) 공급자·OAUTH_MODE=live·키 없음.
 * 채널 시뮬레이터 원격 기록(게시물·영상·컨테이너)은 다시 채우지 않는다 — 재시작 전 결과 불명 작업은 그대로 UNKNOWN(재전송 없음).
 * 마스터 키는 시험이 만든 난수. **네트워크 없음**(fetch 0).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  getAccountHealth,
  getDb,
  loadMockCredentialsForRehydration,
  runJobsTick,
  schema,
  seed,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, openSecret, requireSecretKeyring, sealSecret, type Channel } from '@cs/domain';
import {
  createMockAdapterRegistry,
  ensureMockOAuthRehydrated,
  LocalStorageAdapter,
  mockGoogleTokenCheck,
  mockInstagramTokenCheck,
  mockOAuthStore,
  mockOAuthTokenCheck,
  resetMockOAuthRehydration,
} from '@cs/providers';
import { POST as checkPOST } from '../../apps/web/app/api/channel-accounts/[id]/check/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as refreshPOST } from '../../apps/web/app/api/channel-accounts/[id]/refresh/route';
import { POST as revokePOST } from '../../apps/web/app/api/channel-accounts/[id]/revoke/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as googleAuthorizeGET } from '../../apps/web/app/api/oauth/mock-google/authorize/route';
import { GET as instagramAuthorizeGET } from '../../apps/web/app/api/oauth/mock-instagram/authorize/route';
import { GET as threadsAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as tickPOST } from '../../apps/web/app/api/worker/tick/route';
import { ensureMockOAuthReady, jobCredentials } from '../../apps/web/lib/oauth';
import { syntheticJpeg } from '../../packages/db/scripts/drill-instagram';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const config = loadConfig({});
/** 앱과 같은 프로세스 싱글턴(web route 의 tick 도 같은 시뮬레이터를 본다) */
const registry = createMockAdapterRegistry();

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let storage: LocalStorageAdapter;
let vt = 0;
let fetchCalls = 0;
let imageSeed = 500;
const logs: string[] = [];
/** 시험 중 본 모든 응답(헤더 + 본문) — 비밀 검사용 */
const seen: string[] = [];
/** 시험 중 DB 에서 연 모든 토큰 값(유출 검사용) */
const knownTokens = new Set<string>();

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
async function rec(res: Response): Promise<Response> {
  const body = await res.clone().text();
  seen.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${body}`);
  return res;
}
const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');

type Platform = 'threads' | 'youtube' | 'instagram';
const AUTHORIZE = { threads: threadsAuthorizeGET, youtube: googleAuthorizeGET, instagram: instagramAuthorizeGET } as const;

async function connectFully(accountId: string, platform: Platform): Promise<void> {
  const c = await rec(await connectPOST(post(`/api/channel-accounts/${accountId}/connect`), ctx(accountId)));
  expect(c.status, await c.clone().text()).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  const a = await rec(await AUTHORIZE[platform](new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(a.status, await a.clone().text()).toBe(303);
  const cb = await rec(await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(cb.status, await cb.clone().text()).toBe(200);
}

async function linkedAccount(platform: Platform): Promise<{ id: string; external: string }> {
  const external = `mock:${platform}:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform, kind: 'mock', externalAccountId: external, displayName: `MOCK ${platform} DEV1`, state: 'mock_ready' })
    .returning();
  await connectFully(row!.id, platform);
  return { id: row!.id, external };
}

const credOf = async (accountId: string) => (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, accountId)))[0]!;
/** DB 봉인을 열어 현재 토큰(시험 관찰용 — 유출 검사 목록에 넣는다) */
async function tokensOf(accountId: string): Promise<{ access: string; refresh: string | null }> {
  const c = await credOf(accountId);
  const plain = JSON.parse(openSecret(requireSecretKeyring(process.env), c.encryptedToken!, c.keyVersion!, { ownerId: owner, channelAccountId: accountId, purpose: 'oauth_token' })) as {
    access_token: string;
    refresh_token: string | null;
  };
  knownTokens.add(plain.access_token);
  if (plain.refresh_token) knownTokens.add(plain.refresh_token);
  return { access: plain.access_token, refresh: plain.refresh_token };
}
const inStore = (t: string) => mockOAuthStore().tokens.has(sha(t));

/** 재시작 흉내: 모의 공급자 메모리(+ 다시 채우기 표식)와 채널 시뮬레이터 원격 기록을 모두 잊는다. DB 는 그대로. */
function restart(): void {
  mockOAuthStore().reset();
  registry.threads.api.reset();
  registry.youtube.api.reset();
  registry.instagram.api.reset();
}

async function textVariant(channel: Channel, body: string): Promise<string> {
  const { content } = await createContent(db, owner, { title: `DEV1 ${channel}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel, baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}

/** VERIFIED 미디어 asset(저장소 파일 + 행 — 업로드 경로와 같은 결과) */
async function verifiedAsset(bytes: Uint8Array, mime: string): Promise<string> {
  const key = `assets/${randomUUID()}/${randomUUID()}`;
  await storage.put(key, bytes);
  const [row] = await db.insert(schema.assets).values({ ownerId: owner, key, mime, bytes: bytes.byteLength, checksum: sha(bytes), verificationState: 'VERIFIED' }).returning();
  return row!.id;
}
function syntheticVideo(bytes = 200 * 1024): Uint8Array {
  const out = new Uint8Array(bytes);
  let x = 2654435761 >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  out.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return out;
}
async function mediaVariant(channel: 'youtube' | 'instagram'): Promise<string> {
  const assetId = channel === 'youtube' ? await verifiedAsset(syntheticVideo(), 'video/mp4') : await verifiedAsset(syntheticJpeg(1080, 1080, ++imageSeed), 'image/jpeg');
  const { content } = await createContent(db, owner, { title: `DEV1 ${channel}`, body: '해외 영업 첫 분기 회고(합성 미디어)\n대리점과 재고 기준을 먼저 합의한 이야기.' });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel, baseVersion: 1 });
  await setVariantAssets(db, owner, variant.id, { baseVersion: 1, assets: [{ assetId, position: 1, role: channel === 'youtube' ? 'video' : 'image' }] });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 2 });
  return variant.id;
}

/** 새 계획 1항목 → (선택) 모의 시나리오 → 승인 → 실행. 항목 ID. */
async function planAndExecute(accountId: string, variantId: string, scenario?: string): Promise<string> {
  const res = await rec(await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variantId, channel_account_id: accountId }] })));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string; requested_result: string }> };
  const item = p.items[0]!;
  if (scenario) {
    const s = await scenarioPUT(
      new Request(`${BASE}/api/distribution-items/${item.id}/mock-scenario`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
        body: JSON.stringify({ scenario }),
      }),
      ctx(item.id),
    );
    expect(s.status, await s.clone().text()).toBe(200);
  }
  const ap = await rec(
    await approvePOST(
      post(`/api/distribution-plans/${p.plan.id}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: item.requested_result }),
      ctx(p.plan.id),
    ),
  );
  expect(ap.status, await ap.clone().text()).toBe(200);
  const ex = await rec(await executePOST(post(`/api/distribution-plans/${p.plan.id}/execute`, { command_key: `k-${randomUUID()}` }), ctx(p.plan.id)));
  expect(ex.status, await ex.clone().text()).toBe(200);
  return item.id;
}

/** 작업 처리기 1회(가상 시계) — 앱과 같은 jobCredentials·저장소 */
async function tick(advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 'dev1-w',
    config,
    ownerId: owner,
    clock: () => new Date(Date.now() + vt),
    random: () => 0.5,
    submitTimeoutMs: 10_000,
    maxJobs: 20,
    credentials: jobCredentials(config, db),
    media: storage,
  });
}
/** 화면의 "작업 처리 실행" 경로(POST /api/worker/tick — 실제 시계) */
const tickRoute = async () => rec(await tickPOST(post('/api/worker/tick', { max_jobs: 20 })));

const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const DONE = ['CONFIRMED', 'FAILED', 'BLOCKED', 'UNKNOWN', 'CANCELED'];
async function drainUntil(itemId: string, states: string[] = DONE, n = 16, stepMs = 20_000): Promise<string> {
  for (let i = 0; i < n; i++) {
    const j = await jobOf(itemId);
    if (states.includes(j.state)) return j.state;
    await tick(stepMs);
  }
  return (await jobOf(itemId)).state;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-dev1-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('M4-DEV1 시험: 네트워크 호출 금지');
  });
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity }))).join(' ')));
  }
  storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
});
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  await closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('재시작 뒤 모의 연결 유지(다시 연결 없이)', () => {
  let thr: { id: string; external: string };
  let yt: { id: string; external: string };
  let ig: { id: string; external: string };

  it('Threads·YouTube·Instagram 모의 연결 → 재시작(메모리·시뮬레이터 비움) → 첫 작업 처리(route)가 다시 채움 → 새 계획 전송 CONFIRMED', async () => {
    thr = await linkedAccount('threads');
    yt = await linkedAccount('youtube');
    ig = await linkedAccount('instagram');
    const tThr = await tokensOf(thr.id);
    const tYt = await tokensOf(yt.id);
    const tIg = await tokensOf(ig.id);

    restart();
    expect(mockOAuthStore().tokens.size).toBe(0);
    expect(mockOAuthStore().rehydration).toBeNull();
    // 다시 채우기 전: 시뮬레이터는 토큰을 모른다(재시작 증상 재현)
    const now = new Date();
    expect(mockOAuthTokenCheck()(tThr.access, thr.external, now)).toBe(false);
    expect(mockGoogleTokenCheck()(tYt.access, yt.external, now)).toBe(false);
    expect(mockInstagramTokenCheck()(tIg.access, ig.external, now)).toBe(false);

    const auditBefore = (await db.select().from(schema.auditEvents)).length;
    // Threads 새 계획 → 화면의 작업 처리(route) — 이 프로세스의 첫 연결 경로 사용 → 다시 채움 → 전송
    const thrItem = await planAndExecute(thr.id, await textVariant('threads', '해외 영업 첫 달, 대리점 재고 기준부터 합의했다.'));
    const tr = await tickRoute();
    expect(tr.status, await tr.clone().text()).toBe(200);
    expect((await jobOf(thrItem)).state).toBe('CONFIRMED');
    expect(await pubsOf(thrItem)).toHaveLength(1);
    expect(mockOAuthStore().rehydration).not.toBeNull();
    expect(await mockOAuthStore().rehydration).toMatchObject({ status: 'done', registered: 3, alreadyKnown: 0 });
    // 다시 채우기는 감사·DB 쓰기를 하지 않는다(작업 처리·전송 감사만 늘어남 — 다시 채우기 전용 행 없음)
    const audits = await db.select().from(schema.auditEvents);
    expect(audits.length).toBeGreaterThan(auditBefore);
    expect(audits.some((a) => /rehydrat/i.test(a.action))).toBe(false);
    for (const t of [tThr, tYt, tIg]) expect(inStore(t.access)).toBe(true);
    expect(inStore(tYt.refresh!)).toBe(true);
    expect(mockOAuthTokenCheck()(tThr.access, thr.external, new Date())).toBe(true);
    expect(mockGoogleTokenCheck()(tYt.access, yt.external, new Date())).toBe(true);
    expect(mockInstagramTokenCheck()(tIg.access, ig.external, new Date())).toBe(true);
    // 다른 사용자로는 여전히 거부(정체 그대로 복원)
    expect(mockOAuthTokenCheck()(tThr.access, `mock:threads:${randomUUID()}`, new Date())).toBe(false);

    // YouTube 새 계획(비공개 업로드) → CONFIRMED
    const ytItem = await planAndExecute(yt.id, await mediaVariant('youtube'));
    expect(await drainUntil(ytItem)).toBe('CONFIRMED');
    expect(registry.youtube.api.videosOf(yt.external)).toHaveLength(1);
    // Instagram 새 계획 → CONFIRMED
    const igItem = await planAndExecute(ig.id, await mediaVariant('instagram'));
    expect(await drainUntil(igItem)).toBe('CONFIRMED');
    expect(await pubsOf(igItem)).toHaveLength(1);

    // 연결 확인(공급자 계정 조회) — 세 계정 모두 연결됨, 다시 연결 안내 없음
    for (const a of [thr, yt, ig]) {
      const r = await rec(await checkPOST(post(`/api/channel-accounts/${a.id}/check`), ctx(a.id)));
      expect(r.status, await r.clone().text()).toBe(200);
      expect(((await r.json()) as { account: { status: string } }).account.status).toBe('connected');
      expect((await credOf(a.id)).status).toBe('active');
    }
  });

  it('다시 재시작 → 첫 사용이 연결 갱신(route)이어도 다시 채운 뒤 갱신 성공(세 공급자), 이어서 Threads 새 계획 전송', async () => {
    const before = { thr: await tokensOf(thr.id), yt: await tokensOf(yt.id), ig: await tokensOf(ig.id) };
    restart();
    for (const a of [yt, ig, thr]) {
      const gen = (await credOf(a.id)).tokenGeneration;
      const r = await rec(await refreshPOST(post(`/api/channel-accounts/${a.id}/refresh`), ctx(a.id)));
      expect(r.status, await r.clone().text()).toBe(200);
      const c = await credOf(a.id);
      expect(c).toMatchObject({ status: 'active', lastErrorCode: null });
      expect(c.tokenGeneration).toBe(gen + 1);
    }
    const after = { thr: await tokensOf(thr.id), yt: await tokensOf(yt.id), ig: await tokensOf(ig.id) };
    // 갱신은 새 토큰을 받았고, 다시 채운 이전 토큰은 공급자 규칙대로 무효(철회)가 됐다
    expect(after.thr.access).not.toBe(before.thr.access);
    expect(after.yt.refresh).not.toBe(before.yt.refresh);
    expect(mockOAuthTokenCheck()(before.thr.access, thr.external, new Date())).toBe(false);
    expect(mockOAuthTokenCheck()(after.thr.access, thr.external, new Date())).toBe(true);
    expect(mockGoogleTokenCheck()(before.yt.access, yt.external, new Date())).toBe(false);
    expect(mockInstagramTokenCheck()(after.ig.access, ig.external, new Date())).toBe(true);

    const item = await planAndExecute(thr.id, await textVariant('threads', '둘째 — 가격표는 마지막에 확정했다.'));
    expect((await tickRoute()).status).toBe(200);
    expect((await jobOf(item)).state).toBe('CONFIRMED');
  });

  it('재시작 전 결과 불명 작업: 연결은 다시 채워져도 시뮬레이터 원격 기록은 복원하지 않는다 → 조회 UNKNOWN, 재전송·새 의도 0', async () => {
    const item = await planAndExecute(thr.id, await textVariant('threads', '셋째 — 매주 같은 요일에 숫자를 맞췄다.'), 'threads_publish_timeout_sent');
    await tick();
    const job = await jobOf(item);
    expect(job.state).toBe('RECONCILING');
    expect(registry.threads.api.postsOf(thr.external).length).toBeGreaterThan(0);
    restart();
    const calls0 = { ...registry.threads.api.calls };
    // 재시작 뒤 첫 화면 작업 처리(route)가 연결을 다시 채운다(이 작업은 아직 다음 시도 시각 전)
    expect((await tickRoute()).status).toBe(200);
    for (let i = 0; i < 6; i++) await tick(20 * MIN);
    expect((await jobOf(item)).state).toBe('UNKNOWN');
    expect(await intentsOf(job.id)).toHaveLength(1);
    expect(await pubsOf(item)).toHaveLength(0);
    expect(registry.threads.api.calls.createContainer - calls0.createContainer).toBe(0);
    expect(registry.threads.api.calls.publish - calls0.publish).toBe(0);
    // 연결 자체는 다시 채워졌다(다시 연결 필요 아님)
    expect(await mockOAuthStore().rehydration).toMatchObject({ status: 'done' });
    expect((await getAccountHealth(db, owner, thr.id)).status).toBe('connected');
  });
});

describe('다시 채우지 않는 행·모드', () => {
  it('해제·오류·scope 부족(다시 연결 필요)·열 수 없는 봉인은 등록하지 않고 행도 바꾸지 않는다, 정리 대기 토큰은 등록하지 않는다', async () => {
    const good = await linkedAccount('threads');
    const revoked = await linkedAccount('threads');
    const errored = await linkedAccount('instagram');
    const scopeless = await linkedAccount('youtube');
    const unreadable = await linkedAccount('threads');
    const pending = await linkedAccount('threads');
    const t = {
      good: await tokensOf(good.id),
      revoked: await tokensOf(revoked.id),
      errored: await tokensOf(errored.id),
      scopeless: await tokensOf(scopeless.id),
      unreadable: await tokensOf(unreadable.id),
      pending: await tokensOf(pending.id),
    };
    const rv = await rec(await revokePOST(post(`/api/channel-accounts/${revoked.id}/revoke`), ctx(revoked.id)));
    expect(rv.status, await rv.clone().text()).toBe(200);
    expect((await credOf(revoked.id)).status).toBe('revoked');
    await db.update(schema.oauthCredentials).set({ status: 'error', lastErrorCode: 'invalid_token' }).where(eq(schema.oauthCredentials.channelAccountId, errored.id));
    await db.update(schema.oauthCredentials).set({ scopes: [] }).where(eq(schema.oauthCredentials.channelAccountId, scopeless.id));
    // 다른 키(같은 버전 번호)로 봉인 — 서버 키로는 열 수 없다
    const otherRing = requireSecretKeyring({ SECRETS_MASTER_KEY: randomBytes(32).toString('base64'), SECRETS_KEY_VERSION: '1' });
    const resealed = sealSecret(otherRing, JSON.stringify({ v: 1, access_token: t.unreadable.access, refresh_token: null }), {
      ownerId: owner,
      channelAccountId: unreadable.id,
      purpose: 'oauth_token',
    });
    await db.update(schema.oauthCredentials).set({ encryptedToken: resealed.ciphertext }).where(eq(schema.oauthCredentials.channelAccountId, unreadable.id));
    // 정리 대기(철회할 토큰) — 발급됐지만 저장하지 않은 토큰 흉내
    const pendingToken = `mockthr_at_${randomBytes(32).toString('base64url')}`;
    knownTokens.add(pendingToken);
    const sealedPending = sealSecret(requireSecretKeyring(process.env), JSON.stringify({ v: 1, access_token: pendingToken, refresh_token: null }), {
      ownerId: owner,
      channelAccountId: pending.id,
      purpose: 'oauth_token',
    });
    await db.insert(schema.oauthPendingTokens).values({
      ownerId: owner,
      channelAccountId: pending.id,
      kind: 'cleanup_revoke',
      sealedToken: sealedPending.ciphertext,
      keyVersion: sealedPending.keyVersion,
      source: 'dev1_test',
      nextAttemptAt: new Date(Date.now() + 3600_000),
    });
    const rowsBefore = await db.select().from(schema.oauthCredentials).orderBy(asc(schema.oauthCredentials.id));
    const auditBefore = (await db.select().from(schema.auditEvents)).length;

    restart();
    const out = await ensureMockOAuthReady(config, db);
    expect(out).toMatchObject({ status: 'done' });
    expect(inStore(t.good.access)).toBe(true);
    expect(inStore(t.revoked.access)).toBe(false);
    expect(inStore(t.errored.access)).toBe(false);
    expect(inStore(t.scopeless.access)).toBe(false);
    expect(inStore(t.scopeless.refresh!)).toBe(false);
    expect(inStore(t.unreadable.access)).toBe(false);
    expect(inStore(pendingToken)).toBe(false);
    // 정리 대기 계정의 **현재** 토큰은 공급자에 실제로 있던 토큰이라 등록하지만, 계정 실행 차단은 그대로(health = 정리 대기 오류)
    expect(inStore(t.pending.access)).toBe(true);
    const ph = await getAccountHealth(db, owner, pending.id);
    expect(ph.status).toBe('error');
    expect(ph.usable_for_execution).toBe(false);
    expect(ph.pending_reconcile).toBe('cleanup_revoke');
    // 다시 채우기는 읽기 전용: 연결 정보 행·감사 그대로(열 수 없는 행도 기존 오류 처리에 맡김 — 여기서 error 로 바꾸지 않음)
    expect(await db.select().from(schema.oauthCredentials).orderBy(asc(schema.oauthCredentials.id))).toEqual(rowsBefore);
    expect((await db.select().from(schema.auditEvents)).length).toBe(auditBefore);
    // 열 수 없는 행은 다음 실제 사용(연결 확인)에서 기존 규칙대로 decrypt_<문제> 오류가 된다
    const ck = await rec(await checkPOST(post(`/api/channel-accounts/${unreadable.id}/check`), ctx(unreadable.id)));
    expect(ck.status).toBe(409);
    expect((await credOf(unreadable.id)).lastErrorCode).toMatch(/^decrypt_/);
  });

  it('멱등: 두 번 불러도 같은 결과(프로세스당 한 번), 표식만 지우고 다시 불러도 이미 아는 토큰은 건드리지 않는다(철회 상태 유지)', async () => {
    const acc = await linkedAccount('threads');
    const tk = await tokensOf(acc.id);
    restart();
    const p1 = ensureMockOAuthReady(config, db);
    const p2 = ensureMockOAuthReady(config, db);
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o2).toBe(o1);
    expect(o1).toMatchObject({ status: 'done', alreadyKnown: 0 });
    const size = mockOAuthStore().tokens.size;
    expect(await ensureMockOAuthReady(config, db)).toBe(o1);
    // 같은 프로세스에서 철회된 토큰은 표식을 지우고 다시 채워도 되살아나지 않는다
    mockOAuthStore().tokens.get(sha(tk.access))!.revoked = true;
    resetMockOAuthRehydration();
    const o3 = await ensureMockOAuthReady(config, db);
    expect(o3).toMatchObject({ status: 'done', registered: 0 });
    expect((o3 as { alreadyKnown: number }).alreadyKnown).toBe((o1 as { registered: number }).registered);
    expect(mockOAuthStore().tokens.size).toBe(size);
    expect(mockOAuthTokenCheck()(tk.access, acc.external, new Date())).toBe(false);
  });

  it('OAUTH_MODE=live·마스터 키 없음이면 다시 채우지 않고 표식도 남기지 않는다(DB 를 읽지도 않음)', async () => {
    await linkedAccount('threads');
    restart();
    expect(await ensureMockOAuthReady({ ...config, OAUTH_MODE: 'live' }, db)).toEqual({ status: 'skipped_live_mode' });
    expect(mockOAuthStore().tokens.size).toBe(0);
    expect(mockOAuthStore().rehydration).toBeNull();
    const load = vi.fn(async () => ({ entries: [], skipped: 0 }));
    expect(await ensureMockOAuthRehydrated({ oauthMode: 'live', load })).toEqual({ status: 'skipped_live_mode' });
    expect(load).not.toHaveBeenCalled();
    expect(await ensureMockOAuthReady(config, db, {})).toBeNull();
    expect(mockOAuthStore().rehydration).toBeNull();
    expect(mockOAuthStore().tokens.size).toBe(0);
  });

  it('실제(live) 공급자 행은 읽지 않는다(봉인 안 토큰 모양이 모의여도) — DB 읽기 단계에서 제외', async () => {
    const [live] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: owner, platform: 'threads', kind: 'live', externalAccountId: `live-dev1-${randomUUID()}`, displayName: 'live DEV1', state: 'connected' })
      .returning();
    const fake = `mockthr_at_${randomBytes(32).toString('base64url')}`;
    knownTokens.add(fake);
    const sealed = sealSecret(requireSecretKeyring(process.env), JSON.stringify({ v: 1, access_token: fake, refresh_token: null }), {
      ownerId: owner,
      channelAccountId: live!.id,
      purpose: 'oauth_token',
    });
    await db.insert(schema.oauthCredentials).values({
      ownerId: owner,
      channelAccountId: live!.id,
      provider: 'threads',
      isMock: false,
      encryptedToken: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      scopes: ['threads_basic', 'threads_content_publish'],
      status: 'active',
      connectedAt: new Date(),
    });
    const { entries } = await loadMockCredentialsForRehydration(db, { keyring: requireSecretKeyring(process.env) });
    expect(entries.some((e) => e.accessToken === fake)).toBe(false);
    expect(entries.every((e) => e.provider.startsWith('mock_'))).toBe(true);
    restart();
    await ensureMockOAuthReady(config, db);
    expect(inStore(fake)).toBe(false);
  });
});

describe('비밀 유출 검사', () => {
  it('콘솔·감사·응답에 토큰(원문·모의 토큰 모양) 없음', async () => {
    expect(knownTokens.size).toBeGreaterThan(5);
    const audits = JSON.stringify(await db.select().from(schema.auditEvents));
    const corpus = [logs.join('\n'), audits, seen.join('\n')];
    for (const text of corpus) {
      for (const tk of knownTokens) expect(text.includes(tk)).toBe(false);
      expect(text).not.toMatch(/mock(?:thr|yt|ig)_(?:at|rt)_/);
    }
  });
});
