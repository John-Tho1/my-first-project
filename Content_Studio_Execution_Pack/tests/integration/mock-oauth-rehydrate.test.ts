/**
 * M4-DEV1(개발 품질): 개발 서버 재시작 뒤 모의 OAuth 연결 유지.
 * 모의 공급자(mock_threads·mock_google·mock_instagram)는 발급한 토큰을 프로세스 메모리에만 둔다. 재시작(= 메모리·시뮬레이터 비움) 뒤 처음 연결 경로를
 * 쓸 때 DB 의 쓸 수 있는 모의 연결 정보로 한 번 다시 채워, 다시 연결하지 않아도 새 계획의 전송·갱신이 된다.
 * 다시 채우지 않는 것: 해제·오류·다시 연결 필요·열 수 없는 봉인·현재 토큰을 무효로 만들 수 있는 정리 대기가 있는 계정(같은 세대 refresh_unknown·verify_current,
 * base 없는 refresh_unknown, C 와 토큰을 공유하거나 열 수 없는 cleanup_revoke — FIX2)·정리 대기 토큰 자체·만료·내용이 잘못된 행·실제(live) 공급자·OAUTH_MODE=live·키 없음.
 * FIX1-M4DEV1: 다시 채우기가 일시적으로 실패하면 공급자를 부르지 않고 연결 상태를 바꾸지 않는다(route 503 mock_rehydration_unavailable, worker 는 그 tick 의 연결 정보 작업 건너뜀).
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
  oauthTestHooks,
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
import { DISTRIBUTE_ERROR_TEXT, distributeFormFailure } from '../../apps/web/lib/distribution';
import { ACCOUNT_ERROR_TEXT, accountFormFailure, ensureMockOAuthReady, jobCredentials, mockRehydrationUnavailable } from '../../apps/web/lib/oauth';
import { runInlineWorker } from '../../apps/web/lib/stt';
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
  const assetId = channel === 'youtube' ? await verifiedAsset(syntheticVideo(200 * 1024 + ++imageSeed), 'video/mp4') : await verifiedAsset(syntheticJpeg(1080, 1080, ++imageSeed), 'image/jpeg');
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
    // 정리 대기(철회할 토큰) — 발급됐지만 저장하지 않은 토큰 흉내. 정리 대기 용도(oauth_pending_token)가 아닌 봉인이라 열 수 없다(FIX2: 판정 불가 → 현재 토큰 미등록)
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
    // FIX1-M4DEV1(Codex review-M4DEV1 P1 :781) → FIX2-M4DEV1: 열 수 없는 정리 대기는 현재 토큰과의 관계를 판정할 수 없어 **현재** 토큰도 등록하지 않는다 — 계정 실행 차단도 그대로
    expect(inStore(t.pending.access)).toBe(false);
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

describe('FIX1-M4DEV1: 다시 채우기가 일시적으로 실패하면 공급자를 부르지 않고 연결 상태를 바꾸지 않는다(Codex review-M4DEV1 P1 check/route.ts:25)', () => {
  const failLoad = () => {
    oauthTestHooks.beforeMockRehydrationLoad = async () => {
      throw new Error('FIX1-M4DEV1 시험: 일시적 DB 읽기 실패');
    };
  };
  const recoverLoad = () => {
    delete oauthTestHooks.beforeMockRehydrationLoad;
  };
  const allCreds = () => db.select().from(schema.oauthCredentials).orderBy(asc(schema.oauthCredentials.id));
  const allPending = () => db.select().from(schema.oauthPendingTokens).orderBy(asc(schema.oauthPendingTokens.id));
  const expectUnavailable = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('mock_rehydration_unavailable');
  };

  it('check·refresh·revoke·worker tick route·inline worker: 503(또는 연결 정보 작업 건너뜀) — 연결 정보 행·정리 대기·작업 그대로, 다음 요청(회복 뒤)은 성공', async () => {
    const thr = await linkedAccount('threads');
    const yt = await linkedAccount('youtube');
    const tThr = await tokensOf(thr.id);
    const item = await planAndExecute(thr.id, await textVariant('threads', '실패 주입 — 재시작 직후 DB 읽기만 잠깐 실패.'));
    const job0 = await jobOf(item);
    restart();
    failLoad();
    try {
      const creds0 = await allCreds();
      const pending0 = await allPending();
      for (const a of [thr, yt]) {
        await expectUnavailable(await rec(await checkPOST(post(`/api/channel-accounts/${a.id}/check`), ctx(a.id))));
        await expectUnavailable(await rec(await refreshPOST(post(`/api/channel-accounts/${a.id}/refresh`), ctx(a.id))));
        await expectUnavailable(await rec(await revokePOST(post(`/api/channel-accounts/${a.id}/revoke`), ctx(a.id))));
      }
      await expectUnavailable(await tickRoute());
      // inline worker: 이번 tick 은 배포 작업·만료 임박 갱신을 건너뛴다(던지지 않음 — 업로드 만료·전사는 그대로)
      const inline = await runInlineWorker({ ...config, WORKER_MODE: 'inline' }, db);
      expect(inline).not.toBeNull();
      expect(inline!.jobs).toBeNull();
      expect(inline!.credentials).toBeNull();
      // 공급자를 부르지 않았다: 모의 공급자 메모리는 비어 있고 표식도 없다(다음 요청이 다시 읽는다)
      expect(mockOAuthStore().tokens.size).toBe(0);
      expect(mockOAuthStore().rehydration).toBeNull();
      // 연결 정보 행·정리 대기·작업 상태 그대로(error 로 굳지 않음)
      expect(await allCreds()).toEqual(creds0);
      expect(await allPending()).toEqual(pending0);
      const job1 = await jobOf(item);
      expect({ state: job1.state, attempt: job1.attempt, nextRunAt: job1.nextRunAt }).toEqual({ state: job0.state, attempt: job0.attempt, nextRunAt: job0.nextRunAt });
      expect(await intentsOf(job0.id)).toHaveLength(0);
      for (const a of [thr, yt]) expect((await getAccountHealth(db, owner, a.id)).status).toBe('connected');
    } finally {
      recoverLoad();
    }
    // 회복 뒤 첫 요청이 다시 읽어 성공 — 연결 확인 connected, 작업 처리 CONFIRMED
    const ck = await rec(await checkPOST(post(`/api/channel-accounts/${thr.id}/check`), ctx(thr.id)));
    expect(ck.status, await ck.clone().text()).toBe(200);
    expect(((await ck.json()) as { account: { status: string } }).account.status).toBe('connected');
    expect(await mockOAuthStore().rehydration).toMatchObject({ status: 'done' });
    expect(inStore(tThr.access)).toBe(true);
    expect((await tickRoute()).status).toBe(200);
    expect((await jobOf(item)).state).toBe('CONFIRMED');
    expect((await credOf(yt.id)).status).toBe('active');
  });

  it('callback: 실패하면 503(연결 요청 state 를 쓰지 않음) → 회복 뒤 같은 callback 이 성공', async () => {
    const [row] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: `mock:threads:${randomUUID()}`, displayName: 'MOCK threads DEV1 cb', state: 'mock_ready' })
      .returning();
    const c = await rec(await connectPOST(post(`/api/channel-accounts/${row!.id}/connect`), ctx(row!.id)));
    expect(c.status).toBe(200);
    const { authorize_url } = (await c.json()) as { authorize_url: string };
    const a = await rec(await threadsAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
    expect(a.status).toBe(303);
    const cbUrl = a.headers.get('location')!;
    resetMockOAuthRehydration(); // 표식만 지움(발급한 code 는 그대로) — 다음 경로가 다시 읽게
    failLoad();
    try {
      const cb = await rec(await callbackGET(new Request(cbUrl, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
      await expectUnavailable(cb);
      expect(await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, row!.id))).toHaveLength(0);
    } finally {
      recoverLoad();
    }
    const cb2 = await rec(await callbackGET(new Request(cbUrl, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
    expect(cb2.status, await cb2.clone().text()).toBe(200);
    expect((await credOf(row!.id)).status).toBe('active');
  });

  it('화면 폼: 설정(계정)·배포 화면 모두 일시 오류 문구로 돌아간다(live_blocked·server 로 뭉개지 않음)', () => {
    const acc = accountFormFailure(mockRehydrationUnavailable());
    expect(acc.headers.get('location')).toContain('account_error=mock_rehydration_unavailable');
    expect(ACCOUNT_ERROR_TEXT.mock_rehydration_unavailable).toMatch(/[가-힣]/u);
    const dist = distributeFormFailure(mockRehydrationUnavailable(), post('/api/worker/tick'), '/distribute');
    expect(dist.headers.get('location')).toBe('/distribute?error=mock_rehydration_unavailable');
    expect(DISTRIBUTE_ERROR_TEXT.mock_rehydration_unavailable).toMatch(/[가-힣]/u);
  });
});

describe('FIX2-M4DEV1: 정리 대기는 현재 토큰을 무효로 만들 수 있을 때만 다시 채우기에서 뺀다(Codex review-FIX-M4DEV1 P1 db/oauth.ts:778)', () => {
  const ring = () => requireSecretKeyring(process.env);
  const sealPending = (accountId: string, t: { access: string; refresh: string | null }) =>
    sealSecret(ring(), JSON.stringify({ v: 1, access_token: t.access, refresh_token: t.refresh }), { ownerId: owner, channelAccountId: accountId, purpose: 'oauth_pending_token' });
  const newThreadsToken = () => {
    const b = `mockthr_at_${randomBytes(32).toString('base64url')}`;
    knownTokens.add(b);
    return b;
  };
  /** 합성 정리 대기 한 행(공급자 호출 없이 — 판정 규칙 시험용). 봉인 토큰이 없으면 verify_current 처럼 봉인 없음. */
  async function addPending(accountId: string, kind: 'refresh_unknown' | 'verify_current' | 'cleanup_revoke', baseGeneration: number | null, p: { access: string; refresh: string | null } | null) {
    const sealed = p ? sealPending(accountId, p) : null;
    await db.insert(schema.oauthPendingTokens).values({
      ownerId: owner,
      channelAccountId: accountId,
      kind,
      sealedToken: sealed?.ciphertext ?? null,
      keyVersion: sealed?.keyVersion ?? null,
      baseGeneration,
      source: 'dev1_fix2_test',
      nextAttemptAt: new Date(Date.now() + 3600_000),
    });
  }
  const pendingOf = (accountId: string) => db.select().from(schema.oauthPendingTokens).where(eq(schema.oauthPendingTokens.channelAccountId, accountId));
  const checkAccount = async (accountId: string) => {
    const r = await rec(await checkPOST(post(`/api/channel-accounts/${accountId}/check`), ctx(accountId)));
    return { status: r.status, account: ((await r.clone().json()) as { account?: { status: string; usable_for_execution: boolean; pending_reconcile: string | null } }).account };
  };
  const loaded = async () => (await loadMockCredentialsForRehydration(db, { keyring: ring() })).entries;

  it('판정 규칙: 같은 세대의 refresh_unknown·verify_current, callback refresh_unknown(base 없음), C 와 토큰을 공유하는 cleanup_revoke 는 제외 — 지난 세대 행·C 와 무관한 cleanup_revoke 만 있으면 등록', async () => {
    const mk = async () => {
      const acc = await linkedAccount('threads');
      return { acc, c: await tokensOf(acc.id), gen: (await credOf(acc.id)).tokenGeneration };
    };
    const ruSame = await mk();
    await addPending(ruSame.acc.id, 'refresh_unknown', ruSame.gen, { access: newThreadsToken(), refresh: null });
    const vcSame = await mk();
    await addPending(vcSame.acc.id, 'verify_current', vcSame.gen, null);
    const ruCallback = await mk();
    await addPending(ruCallback.acc.id, 'refresh_unknown', null, { access: newThreadsToken(), refresh: null });
    const crSameToken = await mk();
    await addPending(crSameToken.acc.id, 'cleanup_revoke', null, { access: crSameToken.c.access, refresh: null });
    // C 와 무관한 cleanup_revoke + 같은 세대 refresh_unknown 이 함께 있으면 제외(한 행이라도 C 를 무효로 만들 수 있으면)
    const mixed = await mk();
    await addPending(mixed.acc.id, 'cleanup_revoke', null, { access: newThreadsToken(), refresh: null });
    await addPending(mixed.acc.id, 'refresh_unknown', mixed.gen, { access: newThreadsToken(), refresh: null });
    // Google 형: P 가 C 의 refresh token 을 공유하면 제외
    const ytShared = await linkedAccount('youtube');
    const ytC = await tokensOf(ytShared.id);
    await addPending(ytShared.id, 'cleanup_revoke', null, { access: `mockyt_at_${randomBytes(32).toString('base64url')}`, refresh: ytC.refresh });
    // 등록되는 경우: 지난 세대(C 가 그 뒤 저장된 토큰)의 refresh_unknown·verify_current, C 와 무관한 cleanup_revoke(Threads·Google)
    const ruOld = await mk();
    await db.update(schema.oauthCredentials).set({ tokenGeneration: ruOld.gen + 1 }).where(eq(schema.oauthCredentials.channelAccountId, ruOld.acc.id));
    await addPending(ruOld.acc.id, 'refresh_unknown', ruOld.gen, { access: ruOld.c.access, refresh: null });
    const vcOld = await mk();
    await db.update(schema.oauthCredentials).set({ tokenGeneration: vcOld.gen + 1 }).where(eq(schema.oauthCredentials.channelAccountId, vcOld.acc.id));
    await addPending(vcOld.acc.id, 'verify_current', vcOld.gen, null);
    const crOther = await mk();
    const crP = newThreadsToken();
    await addPending(crOther.acc.id, 'cleanup_revoke', null, { access: crP, refresh: null });
    const ytOther = await linkedAccount('youtube');
    const ytOtherC = await tokensOf(ytOther.id);
    const ytP = { access: `mockyt_at_${randomBytes(32).toString('base64url')}`, refresh: `mockyt_rt_${randomBytes(32).toString('base64url')}` };
    knownTokens.add(ytP.access);
    knownTokens.add(ytP.refresh);
    await addPending(ytOther.id, 'cleanup_revoke', null, ytP);

    const rowsBefore = await db.select().from(schema.oauthPendingTokens).orderBy(asc(schema.oauthPendingTokens.id));
    restart();
    const entries = await loaded();
    const has = (t: string) => entries.some((e) => e.accessToken === t || e.refreshToken === t);
    for (const x of [ruSame, vcSame, ruCallback, crSameToken, mixed]) expect(has(x.c.access)).toBe(false);
    expect(has(ytC.access)).toBe(false);
    for (const x of [ruOld, vcOld, crOther]) expect(has(x.c.access)).toBe(true);
    expect(has(ytOtherC.access)).toBe(true);
    // 정리 대기 토큰 P 는 어느 경우에도 읽혀 나오지 않는다
    expect(has(crP)).toBe(false);
    expect(has(ytP.access) || has(ytP.refresh)).toBe(false);
    expect(await ensureMockOAuthReady(config, db)).toMatchObject({ status: 'done' });
    for (const x of [ruSame, vcSame, ruCallback, crSameToken, mixed]) expect(mockOAuthTokenCheck()(x.c.access, x.acc.external, new Date())).toBe(false);
    expect(inStore(ytC.access) || inStore(ytC.refresh!)).toBe(false);
    expect(mockOAuthTokenCheck()(crOther.c.access, crOther.acc.external, new Date())).toBe(true);
    expect(mockGoogleTokenCheck()(ytOtherC.access, ytOther.external, new Date())).toBe(true);
    expect(inStore(crP) || inStore(ytP.access) || inStore(ytP.refresh)).toBe(false);
    // 읽기 전용: 정리 대기 행 그대로, 등록돼도 정리 대기가 남은 동안 계정은 계속 차단
    expect(await db.select().from(schema.oauthPendingTokens).orderBy(asc(schema.oauthPendingTokens.id))).toEqual(rowsBefore);
    for (const id of [crOther.acc.id, ytOther.id]) expect((await getAccountHealth(db, owner, id)).usable_for_execution).toBe(false);
  });

  it('cleanup_revoke 만 남은 계정(실제 callback 정리 철회 불명): 재시작 뒤 현재 토큰 등록 → 첫 확인이 정리를 마치고 connected·실행 가능 → 바로 전송 CONFIRMED, 정리 직후 재시작해도 유지', async () => {
    const acc = await linkedAccount('threads');
    const c = await tokensOf(acc.id);
    const gen0 = (await credOf(acc.id)).tokenGeneration;
    // 다시 연결 시도: 받은 토큰 P 저장 전에 실패 → P 철회가 공급자 오류(불명) → cleanup_revoke(P). 현재 토큰 C 는 그대로(세대 그대로).
    const cn = await rec(await connectPOST(post(`/api/channel-accounts/${acc.id}/connect`), ctx(acc.id)));
    expect(cn.status).toBe(200);
    const { authorize_url } = (await cn.json()) as { authorize_url: string };
    const au = await rec(await threadsAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
    expect(au.status).toBe(303);
    oauthTestHooks.beforeCallbackStore = async () => {
      mockOAuthStore().failNext = { op: 'revoke', code: 'provider_error' };
      throw new Error('FIX2-M4DEV1 시험: callback 저장 실패');
    };
    try {
      const cb = await rec(await callbackGET(new Request(au.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
      expect(cb.status).not.toBe(200);
    } finally {
      delete oauthTestHooks.beforeCallbackStore;
    }
    const pend = await pendingOf(acc.id);
    expect(pend.map((p) => p.kind)).toEqual(['cleanup_revoke']);
    const p = JSON.parse(openSecret(ring(), pend[0]!.sealedToken!, pend[0]!.keyVersion!, { ownerId: owner, channelAccountId: acc.id, purpose: 'oauth_pending_token' })) as { access_token: string };
    knownTokens.add(p.access_token);
    expect(p.access_token).not.toBe(c.access);
    expect((await credOf(acc.id)).tokenGeneration).toBe(gen0);
    // 재시작 전: P 는 공급자에서 유효(철회 불명), C 도 유효, 계정은 정리 대기로 차단
    expect(mockOAuthTokenCheck()(c.access, acc.external, new Date())).toBe(true);
    expect((await getAccountHealth(db, owner, acc.id)).usable_for_execution).toBe(false);

    restart();
    // 다시 채우기는 C 를 등록한다(정리 대기 P 는 C 와 무관) — 정리 대기가 남은 동안 계정 실행 차단은 그대로
    expect(await ensureMockOAuthReady(config, db)).toMatchObject({ status: 'done' });
    expect(inStore(c.access)).toBe(true);
    expect(inStore(p.access_token)).toBe(false);
    // 첫 확인: 정리(P 철회 — 모르는 토큰 = 이미 철회)로 정리 대기가 걷히고, 응답은 실제로 쓸 수 있는 C 기준 connected·실행 가능
    const first = await checkAccount(acc.id);
    expect(first.status).toBe(200);
    expect(first.account).toMatchObject({ status: 'connected', usable_for_execution: true, pending_reconcile: null });
    expect(await pendingOf(acc.id)).toHaveLength(0);
    expect(mockOAuthTokenCheck()(c.access, acc.external, new Date())).toBe(true);
    expect(mockOAuthTokenCheck()(p.access_token, acc.external, new Date())).toBe(false);
    // 바로 전송 → CONFIRMED(C 로), 다시 연결 없음(세대 그대로)
    const item = await planAndExecute(acc.id, await textVariant('threads', '정리 대기 해소 직후 전송 — 다시 연결 없이.'));
    expect((await tickRoute()).status).toBe(200);
    expect(await drainUntil(item)).toBe('CONFIRMED');
    expect(await pubsOf(item)).toHaveLength(1);
    expect((await credOf(acc.id)).tokenGeneration).toBe(gen0);
    // 일반 확인도 connected(이전 FIX1 의 두 번째 확인 invalid_token 이 사라짐)
    expect((await checkAccount(acc.id)).account).toMatchObject({ status: 'connected', usable_for_execution: true });
    // 정리 직후 재시작: 정리 대기 없음 → C 다시 등록, 연결 유지
    restart();
    expect((await checkAccount(acc.id)).account).toMatchObject({ status: 'connected', usable_for_execution: true });
    expect(inStore(p.access_token)).toBe(false);
  });

  it('refresh_unknown(실제 공급자 갱신으로 C 무효): 재시작 뒤 C·P 모두 미등록, 정리 중 C 확인이 불명이면 verify_current 로 남고 재시작해도 미등록 → 확인되면 error(실행 불가), 이후 재시작에도 미등록', async () => {
    const acc = await linkedAccount('threads');
    const c = await tokensOf(acc.id);
    const gen0 = (await credOf(acc.id)).tokenGeneration;
    // 실제 갱신: 공급자가 P 를 발급하며 C 를 무효로 함 → 저장 트랜잭션 실패 + 저장 여부 다시 읽기 실패 → refresh_unknown(base = C 의 세대)
    oauthTestHooks.insideRefreshStore = async () => {
      throw new Error('FIX2-M4DEV1 시험: 갱신 저장 실패');
    };
    oauthTestHooks.beforeStoredOutcomeRead = async () => {
      throw new Error('FIX2-M4DEV1 시험: 저장 여부 읽기 실패');
    };
    try {
      const rf = await rec(await refreshPOST(post(`/api/channel-accounts/${acc.id}/refresh`), ctx(acc.id)));
      expect(rf.status).not.toBe(200);
    } finally {
      delete oauthTestHooks.insideRefreshStore;
      delete oauthTestHooks.beforeStoredOutcomeRead;
    }
    const pend = await pendingOf(acc.id);
    expect(pend.map((x) => ({ kind: x.kind, base: x.baseGeneration }))).toEqual([{ kind: 'refresh_unknown', base: gen0 }]);
    const p = JSON.parse(openSecret(ring(), pend[0]!.sealedToken!, pend[0]!.keyVersion!, { ownerId: owner, channelAccountId: acc.id, purpose: 'oauth_pending_token' })) as { access_token: string };
    knownTokens.add(p.access_token);
    expect((await credOf(acc.id)).tokenGeneration).toBe(gen0);
    expect((await tokensOf(acc.id)).access).toBe(c.access);
    // 재시작 전 공급자 상태: C 무효(갱신이 회전), P 유효
    expect(mockOAuthTokenCheck()(c.access, acc.external, new Date())).toBe(false);
    expect(mockOAuthTokenCheck()(p.access_token, acc.external, new Date())).toBe(true);

    restart();
    expect((await loaded()).some((e) => e.accessToken === c.access || e.accessToken === p.access_token)).toBe(false);
    expect(await ensureMockOAuthReady(config, db)).toMatchObject({ status: 'done' });
    expect(inStore(c.access) || inStore(p.access_token)).toBe(false);
    // 첫 확인: P 정리(모르는 토큰 = 철회됨) + C 확인이 공급자 일시 오류(불명) → verify_current(base = C 의 세대)로 남아 차단
    mockOAuthStore().failNext = { op: 'account', code: 'provider_error' };
    const first = await checkAccount(acc.id);
    mockOAuthStore().failNext = null;
    expect(first.account?.status).not.toBe('connected');
    expect(first.account?.usable_for_execution).toBe(false);
    expect((await pendingOf(acc.id)).map((x) => ({ kind: x.kind, base: x.baseGeneration }))).toEqual([{ kind: 'verify_current', base: gen0 }]);
    // 정리 대기 일부가 걷힌 직후(C 검증 전) 재시작: C 는 여전히 등록되지 않는다
    restart();
    expect((await loaded()).some((e) => e.accessToken === c.access)).toBe(false);
    expect(await ensureMockOAuthReady(config, db)).toMatchObject({ status: 'done' });
    expect(inStore(c.access)).toBe(false);
    // 확인: C 는 공급자에서 알 수 없음 → 무효로 판정 → error(실행 불가, 다시 연결 안내). C 로 성공한 공급자 호출 없음.
    const second = await checkAccount(acc.id);
    expect(second.account).toMatchObject({ usable_for_execution: false });
    expect(second.account?.status).not.toBe('connected');
    expect(await pendingOf(acc.id)).toHaveLength(0);
    expect((await credOf(acc.id)).status).toBe('error');
    // 그 뒤 재시작해도(오류 행) 등록하지 않는다
    restart();
    expect((await loaded()).some((e) => e.accessToken === c.access)).toBe(false);
    expect(mockOAuthTokenCheck()(c.access, acc.external, new Date())).toBe(false);
  });

  it('동시 요청·worker 가 함께 다시 채우기 실패를 받으면 모두 503·건너뜀, 다음 시도에서 함께 회복(읽기 1회)', async () => {
    const thr = await linkedAccount('threads');
    const ig = await linkedAccount('instagram');
    const tThr = await tokensOf(thr.id);
    const tIg = await tokensOf(ig.id);
    restart();
    let loads = 0;
    oauthTestHooks.beforeMockRehydrationLoad = async () => {
      loads++;
      throw new Error('FIX2-M4DEV1 시험: 일시적 DB 읽기 실패');
    };
    try {
      const [a, b, t, w] = await Promise.all([
        checkPOST(post(`/api/channel-accounts/${thr.id}/check`), ctx(thr.id)),
        checkPOST(post(`/api/channel-accounts/${ig.id}/check`), ctx(ig.id)),
        tickPOST(post('/api/worker/tick', { max_jobs: 20 })),
        runInlineWorker({ ...config, WORKER_MODE: 'inline' }, db),
      ]);
      for (const r of [a, b, t]) {
        await rec(r);
        expect(r.status).toBe(503);
        expect(((await r.json()) as { error: string }).error).toBe('mock_rehydration_unavailable');
      }
      expect(w!.jobs).toBeNull();
      expect(w!.credentials).toBeNull();
      expect(loads).toBeGreaterThanOrEqual(1);
      expect(mockOAuthStore().tokens.size).toBe(0);
      expect(mockOAuthStore().rehydration).toBeNull();
      for (const id of [thr.id, ig.id]) expect((await credOf(id)).status).toBe('active');
    } finally {
      oauthTestHooks.beforeMockRehydrationLoad = async () => {
        loads++;
      };
    }
    const before = loads;
    try {
      const [a, b, t] = await Promise.all([
        checkPOST(post(`/api/channel-accounts/${thr.id}/check`), ctx(thr.id)),
        checkPOST(post(`/api/channel-accounts/${ig.id}/check`), ctx(ig.id)),
        tickPOST(post('/api/worker/tick', { max_jobs: 20 })),
      ]);
      for (const r of [a, b, t]) expect((await rec(r)).status).toBe(200);
      expect(((await a.json()) as { account: { status: string } }).account.status).toBe('connected');
      expect(((await b.json()) as { account: { status: string } }).account.status).toBe('connected');
      expect(loads - before).toBe(1);
      expect(inStore(tThr.access) && inStore(tIg.access)).toBe(true);
    } finally {
      delete oauthTestHooks.beforeMockRehydrationLoad;
    }
  });
});

describe('FIX1-M4DEV1: 놓친 경우(Codex 목록)', () => {
  it('만료된 연결 정보·알 수 없는 키 버전·복호화는 되지만 내용이 잘못된 행은 등록하지 않고(행 그대로) 나머지는 등록한다', async () => {
    const good = await linkedAccount('instagram');
    const expired = await linkedAccount('threads');
    const badVer = await linkedAccount('threads');
    const garbage = await linkedAccount('threads');
    const t = { good: await tokensOf(good.id), expired: await tokensOf(expired.id), badVer: await tokensOf(badVer.id), garbage: await tokensOf(garbage.id) };
    await db.update(schema.oauthCredentials).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.oauthCredentials.channelAccountId, expired.id));
    await db.update(schema.oauthCredentials).set({ keyVersion: 99 }).where(eq(schema.oauthCredentials.channelAccountId, badVer.id));
    const resealed = sealSecret(requireSecretKeyring(process.env), JSON.stringify({ v: 1, access_token: 'not-a-mock-token', refresh_token: null }), {
      ownerId: owner,
      channelAccountId: garbage.id,
      purpose: 'oauth_token',
    });
    await db.update(schema.oauthCredentials).set({ encryptedToken: resealed.ciphertext, keyVersion: resealed.keyVersion }).where(eq(schema.oauthCredentials.channelAccountId, garbage.id));
    const rowsBefore = await db.select().from(schema.oauthCredentials).orderBy(asc(schema.oauthCredentials.id));
    restart();
    const out = await ensureMockOAuthReady(config, db);
    expect(out).toMatchObject({ status: 'done' });
    expect((out as { skipped: number }).skipped).toBeGreaterThanOrEqual(3);
    expect(inStore(t.good.access)).toBe(true);
    expect(inStore(t.expired.access)).toBe(false);
    expect(inStore(t.badVer.access)).toBe(false);
    expect(inStore(t.garbage.access)).toBe(false);
    expect(mockOAuthStore().tokens.has(sha('not-a-mock-token'))).toBe(false);
    expect(await db.select().from(schema.oauthCredentials).orderBy(asc(schema.oauthCredentials.id))).toEqual(rowsBefore);
  });

  it('Google 형 access 는 만료·refresh 는 유효: 재시작 뒤 첫 사용이 작업 처리여도 보내기 전 갱신 → 비공개 업로드 CONFIRMED', async () => {
    const yt = await linkedAccount('youtube');
    const tk = await tokensOf(yt.id);
    const resealed = sealSecret(
      requireSecretKeyring(process.env),
      JSON.stringify({ v: 1, access_token: tk.access, refresh_token: tk.refresh, access_expires_at: new Date(Date.now() - 60_000).toISOString() }),
      { ownerId: owner, channelAccountId: yt.id, purpose: 'oauth_token' },
    );
    await db.update(schema.oauthCredentials).set({ encryptedToken: resealed.ciphertext, keyVersion: resealed.keyVersion }).where(eq(schema.oauthCredentials.channelAccountId, yt.id));
    const gen = (await credOf(yt.id)).tokenGeneration;
    restart();
    const item = await planAndExecute(yt.id, await mediaVariant('youtube'));
    expect((await tickRoute()).status).toBe(200);
    expect(await drainUntil(item)).toBe('CONFIRMED');
    const c = await credOf(yt.id);
    expect(c).toMatchObject({ status: 'active', lastErrorCode: null });
    expect(c.tokenGeneration).toBeGreaterThan(gen);
    expect(mockGoogleTokenCheck()(tk.access, yt.external, new Date())).toBe(false);
  });

  it('재시작 뒤 첫 사용이 연결 해제(revoke)여도 다시 채운 토큰을 공급자에서 철회하고 정리 대기를 남기지 않는다', async () => {
    const thr = await linkedAccount('threads');
    const tk = await tokensOf(thr.id);
    restart();
    const r = await rec(await revokePOST(post(`/api/channel-accounts/${thr.id}/revoke`), ctx(thr.id)));
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await credOf(thr.id)).status).toBe('revoked');
    expect(mockOAuthStore().tokens.get(sha(tk.access))?.revoked).toBe(true);
    expect(await db.select().from(schema.oauthPendingTokens).where(eq(schema.oauthPendingTokens.channelAccountId, thr.id))).toHaveLength(0);
  });

  it('재시작 뒤 첫 사용이 inline worker(WORKER_MODE=inline)여도 다시 채운 뒤 Threads 전송 CONFIRMED', async () => {
    const thr = await linkedAccount('threads');
    const item = await planAndExecute(thr.id, await textVariant('threads', 'inline worker 첫 사용 — 재시작 직후.'));
    restart();
    const inline = await runInlineWorker({ ...config, WORKER_MODE: 'inline' }, db);
    expect(inline?.jobs).not.toBeNull();
    expect(await mockOAuthStore().rehydration).toMatchObject({ status: 'done' });
    expect((await jobOf(item)).state).toBe('CONFIRMED');
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
