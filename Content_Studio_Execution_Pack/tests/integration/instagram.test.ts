/**
 * T16(제안 결정 D29): Instagram 조건부 연결 — **모의 어댑터만**(이미지·캐러셀 미디어 컨테이너 → 게시, 원격 단계 참조 저장, 조회로 확인, 잠정 규격 검사,
 * 모의 공개 미디어 URL). 계정은 Meta 형 모의 OAuth 흐름(route)으로 연결한다. 이미지는 헤더만 맞는 합성 JPEG(VERIFIED asset 으로 넣음).
 * **실제 Instagram/Meta 호출·네트워크·실제 공개 URL 없음**(fetch 0 확인).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  closeDb,
  commitRestore,
  createContent,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  exportOwner,
  getDb,
  listChannelAccounts,
  parseBundleZip,
  reconcileItem,
  runJobsTick,
  schema,
  seed,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import {
  adapterIdFor,
  buildBundle,
  INSTAGRAM_PROVISIONAL_MEDIA_SPEC,
  loadConfig,
  MOCK_PUBLIC_MEDIA_PREFIX,
  RESTORED_TABLES,
  writeZip,
  type BundleTables,
} from '@cs/domain';
import { createMockAdapterRegistry, INSTAGRAM_PROVISIONAL_RATE_LIMIT, LocalStorageAdapter, mockOAuthStore } from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as instagramAuthorizeGET } from '../../apps/web/app/api/oauth/mock-instagram/authorize/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { GET as jobGET } from '../../apps/web/app/api/jobs/[id]/route';
import { POST as tickPOST } from '../../apps/web/app/api/worker/tick/route';
import { itemHeadline } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { formatInstagramDrillTable, runInstagramDrill, syntheticJpeg } from '../../packages/db/scripts/drill-instagram';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const config = loadConfig({});
const registry = createMockAdapterRegistry();
const ig = registry.instagram;
const api = ig.api;
const publicMedia = ig.publicMedia;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let vt = 0;
let fetchCalls = 0;
let storage: LocalStorageAdapter;
let imageSeed = 100;
const logs: string[] = [];
const seen: string[] = [];

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (p: string) => new Request(`${BASE}${p}`, { headers: { accept: 'application/json', ...cookieHeader(token) } });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
async function rec(res: Response): Promise<Response> {
  const body = await res.clone().text();
  seen.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${body}`);
  return res;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** VERIFIED 이미지 asset(저장소 파일 + 행 — 업로드 경로와 같은 결과: 형식 서명·sha256·VERIFIED). */
async function verifiedImage(width: number, height: number, mime = 'image/jpeg'): Promise<{ id: string; checksum: string }> {
  const bytes = syntheticJpeg(width, height, ++imageSeed);
  const checksum = sha(bytes);
  const key = `assets/${randomUUID()}/${randomUUID()}`;
  await storage.put(key, bytes);
  const [row] = await db.insert(schema.assets).values({ ownerId: owner, key, mime, bytes: bytes.byteLength, checksum, verificationState: 'VERIFIED' }).returning();
  return { id: row!.id, checksum };
}

async function connectFully(accountId: string): Promise<void> {
  const c = await rec(await connectPOST(post(`/api/channel-accounts/${accountId}/connect`), ctx(accountId)));
  expect(c.status, await c.clone().text()).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  expect(new URL(authorize_url).pathname).toBe('/api/oauth/mock-instagram/authorize');
  const a = await rec(await instagramAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(a.status, await a.clone().text()).toBe(303);
  const cb = await rec(await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(cb.status, await cb.clone().text()).toBe(200);
}

async function linkedAccount(): Promise<{ id: string; external: string }> {
  const external = `mock:instagram:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform: 'instagram', kind: 'mock', externalAccountId: external, displayName: 'MOCK Instagram T16', state: 'mock_ready' })
    .returning();
  await connectFully(row!.id);
  return { id: row!.id, external };
}

const BODY = '해외 영업 첫 분기 회고 #해외영업\n\n대리점과 재고 기준을 먼저 합의한 이야기.';

async function instagramVariant(dims: Array<[number, number]>, mime = 'image/jpeg'): Promise<{ variantId: string; checksums: string[] }> {
  const imgs = [];
  for (const [w, h] of dims) imgs.push(await verifiedImage(w, h, mime));
  const { content } = await createContent(db, owner, { title: 'T16 instagram', body: BODY });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'instagram', baseVersion: 1 });
  await setVariantAssets(db, owner, variant.id, { baseVersion: 1, assets: imgs.map((im, i) => ({ assetId: im.id, position: i + 1, role: 'image' as const })) });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 2 });
  return { variantId: variant.id, checksums: imgs.map((i) => i.checksum) };
}

interface Planned {
  planId: string;
  itemId: string;
  hash: string;
  checksums: string[];
}

async function planFor(accountId: string, dims: Array<[number, number]> = [[1080, 1080]], opts: { scenario?: string; visibility?: string; approve?: boolean } = {}): Promise<Planned> {
  const v = await instagramVariant(dims);
  const res = await rec(await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: v.variantId, channel_account_id: accountId, visibility: opts.visibility }] })));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string; visibility: string; requested_result: string }> };
  const item = p.items[0]!;
  expect(item).toMatchObject({ visibility: 'public', requested_result: 'mock_publish' });
  if (opts.scenario) {
    const r = await setScenario(item.id, opts.scenario);
    expect(r.status, await r.clone().text()).toBe(200);
  }
  if (opts.approve !== false) {
    const ap = await approve(p.plan.id, item.id, item.payload_hash);
    expect(ap.status, await ap.clone().text()).toBe(200);
  }
  return { planId: p.plan.id, itemId: item.id, hash: item.payload_hash, checksums: v.checksums };
}
const approve = async (planId: string, itemId: string, hash: string) =>
  rec(await approvePOST(post(`/api/distribution-plans/${planId}/approve`, { item_ids: [itemId], expected_hashes: { [itemId]: hash }, confirm: true, purpose: 'mock_publish' }), ctx(planId)));
const setScenario = (itemId: string, scenario: string) =>
  scenarioPUT(
    new Request(`${BASE}/api/distribution-items/${itemId}/mock-scenario`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
      body: JSON.stringify({ scenario }),
    }),
    ctx(itemId),
  );
const execute = async (planId: string) => rec(await executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId)));

async function tick(advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 't16-w',
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

const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const stepsOf = (itemId: string) => db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId)).orderBy(asc(schema.remoteSteps.stepIndex));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));

async function drainUntil(itemId: string, states: string[], n = 16, stepMs = 20_000): Promise<string> {
  for (let i = 0; i < n; i++) {
    const j = await jobOf(itemId);
    if (states.includes(j.state)) return j.state;
    await tick(stepMs);
  }
  return (await jobOf(itemId)).state;
}
const DONE = ['CONFIRMED', 'FAILED', 'BLOCKED', 'UNKNOWN', 'CANCELED'];

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t16-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('T16 시험: 네트워크 호출 금지');
  });
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity }))).join(' ')));
  }
  storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
});
beforeEach(() => {
  ig.rateLimit = { ...INSTAGRAM_PROVISIONAL_RATE_LIMIT };
  ig.spec = { ...INSTAGRAM_PROVISIONAL_MEDIA_SPEC };
});
afterAll(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Meta 형 모의 OAuth 연결 → Instagram 모의 어댑터 선택', () => {
  it('연결한 Instagram 모의 계정은 mock_instagram(연결 정보 mock_instagram·자리 표시 scope), seed Instagram 계정(연결 없음)은 M3 일반 어댑터·기본 공개 범위 그대로', async () => {
    const acc = await linkedAccount();
    const row = (await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, acc.id)))[0]!;
    expect(row.credentialState).toBe('linked');
    expect(adapterIdFor({ kind: 'mock', platform: 'instagram', credential_state: row.credentialState })).toBe('mock_instagram');
    const cred = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, acc.id)))[0]!;
    expect(cred).toMatchObject({ provider: 'mock_instagram', isMock: true, scopes: ['instagram_basic(mock)', 'instagram_content_publish(mock)'], status: 'active' });
    expect(cred.encryptedToken).toMatch(/^csk1:/);
    const seededIg = (await listChannelAccounts(db, owner)).find((a) => a.platform === 'instagram' && a.credentialState === 'none')!;
    expect(adapterIdFor({ kind: 'mock', platform: 'instagram', credential_state: seededIg.credentialState })).toBe('mock_generic');
    // seed 계정: M3 규칙 그대로(공개 범위 생략 = private, 규격 검사 없음)
    const v = await instagramVariant([[1080, 1920]]);
    const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: v.variantId, channel_account_id: seededIg.id }] }));
    expect(res.status).toBe(201);
    const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string; visibility: string }> };
    expect(p.items[0]!.visibility).toBe('private');
    expect((await approve(p.plan.id, p.items[0]!.id, p.items[0]!.payload_hash)).status).toBe(200);
  });

  it('계획 규칙: 공개 범위 생략 → public, private·unlisted → 400 instagram_visibility_public_only, upload_private·public_publish → 400 mock_only', async () => {
    const acc = await linkedAccount();
    const v = await instagramVariant([[1080, 1080]]);
    for (const visibility of ['private', 'unlisted']) {
      const r = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: v.variantId, channel_account_id: acc.id, visibility }] }));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('instagram_visibility_public_only');
    }
    for (const requested_result of ['upload_private', 'public_publish']) {
      const r = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: v.variantId, channel_account_id: acc.id, requested_result, visibility: 'public' }] }));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('mock_only');
    }
    const ok = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: v.variantId, channel_account_id: acc.id }] }));
    expect(ok.status).toBe(201);
  });
});

describe('승인 전 잠정 규격 검사(approval blocker)', () => {
  it('9:16 세로 → 계획 화면 problems 에 media_spec, 승인 409 snapshot_stale(media_spec:aspect_out_of_range:1), 승인·작업 0; PNG → mime_not_allowed', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id, [[1080, 1920]], { approve: false });
    const detail = await rec(await planGET(get(`/api/distribution-plans/${p.planId}`), ctx(p.planId)));
    expect(detail.status).toBe(200);
    expect(JSON.stringify(await detail.json())).toContain('media_spec:aspect_out_of_range:1');
    const ap = await approve(p.planId, p.itemId, p.hash);
    expect(ap.status).toBe(409);
    const body = (await ap.json()) as { error: string; items: Array<{ reasons: string[] }> };
    expect(body.error).toBe('snapshot_stale');
    expect(body.items[0]!.reasons).toContain('media_spec:aspect_out_of_range:1');
    expect(await db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, p.itemId))).toHaveLength(0);
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, p.itemId))).toHaveLength(0);
    expect((await itemOf(p.itemId)).status).toBe('PLANNED');
    // PNG(역할은 image) — 잠정 규격은 JPEG 만
    const v = await instagramVariant([[1080, 1080]], 'image/png');
    const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: v.variantId, channel_account_id: acc.id }] }));
    const q = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
    const ap2 = await approve(q.plan.id, q.items[0]!.id, q.items[0]!.payload_hash);
    expect(ap2.status).toBe(409);
    expect(JSON.stringify(await ap2.json())).toContain('media_spec:mime_not_allowed:1');
  });

  it('규격이 보내기 직전에 달라지면(잠정 규격 변경 흉내) 원격 호출 0·URL 발급 0 으로 FAILED(재시도 없음)', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id);
    ig.spec = { ...INSTAGRAM_PROVISIONAL_MEDIA_SPEC, min_width: 4000 };
    const creates = api.calls.createImageContainer;
    const issued = publicMedia.stats.issued;
    await execute(p.planId);
    expect(await drainUntil(p.itemId, DONE)).toBe('FAILED');
    const job = await jobOf(p.itemId);
    expect(job.lastErrorCode).toBe('invalid_media_spec:width_too_small:1');
    expect(api.calls.createImageContainer).toBe(creates);
    expect(publicMedia.stats.issued).toBe(issued);
    await tick(3_600_000);
    expect(await intentsOf(job.id)).toHaveLength(1);
  });
});

describe('게시 → 확인', () => {
  it('이미지 1장: 컨테이너 → 게시 → CONFIRMED, publication 1개(MOCK·PUBLISHED/public·mock:instagram:·mock://instagram/p/), 받은 이미지 = 승인 파일, 공개 URL 은 철회됨', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id);
    expect((await execute(p.planId)).status).toBe(200);
    await tick();
    const job = await jobOf(p.itemId);
    expect(job.state).toBe('CONFIRMED');
    expect(await intentsOf(job.id)).toHaveLength(1);
    expect((await stepsOf(p.itemId)).map((s) => `${s.kind}:${s.postIndex}:${s.status}`)).toEqual(['ig_container:0:finished', 'ig_publish:0:published']);
    const [pub] = await pubsOf(p.itemId);
    expect(pub).toMatchObject({ isMock: true, verification: 'MOCK', resultKind: 'PUBLISHED', remoteVisibility: 'public' });
    expect(pub!.externalId).toMatch(/^mock:instagram:mockig_m_/);
    expect(pub!.permalink).toMatch(/^mock:\/\/instagram\/p\/mockig_m_/);
    const media = api.mediaOf(acc.external);
    expect(media).toHaveLength(1);
    expect(media[0]!.imageSha256).toEqual(p.checksums);
    expect(publicMedia.activeCount()).toBe(0);
    const intent = (await intentsOf(job.id))[0]!;
    expect(intent.sanitizedDetails).toMatchObject({ adapter_id: 'mock_instagram' });
    const headline = itemHeadline({ status: 'CONFIRMED', channel: 'instagram', job, pub: pub!, blockReason: null });
    expect(headline).toBe('MOCK 게시 확인(Instagram 모의 — 실제 발행 아님)');
  });

  it('캐러셀 3장: 자식 컨테이너 3 + 부모 1 → 게시 1 → CONFIRMED, 원격 미디어 1개(CAROUSEL_ALBUM), 이미지 순서 = 승인 순서', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id, [
      [1080, 1080],
      [1080, 1350],
      [1080, 566],
    ]);
    await execute(p.planId);
    await tick();
    expect((await jobOf(p.itemId)).state).toBe('CONFIRMED');
    expect((await stepsOf(p.itemId)).map((s) => `${s.kind}:${s.postIndex}`)).toEqual(['ig_container:1', 'ig_container:2', 'ig_container:3', 'ig_container:0', 'ig_publish:0']);
    const media = api.mediaOf(acc.external);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({ mediaType: 'CAROUSEL_ALBUM' });
    expect(media[0]!.imageSha256).toEqual(p.checksums);
  });

  it('A08: 게시 응답 유실 → RECONCILING(publication 없음) → 조회가 컨테이너로 미디어를 찾아 CONFIRMED, 두 번째 게시 없음', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id, [[1080, 1080]], { scenario: 'instagram_publish_timeout_sent' });
    await execute(p.planId);
    const publishes = api.calls.publish;
    await tick();
    expect((await jobOf(p.itemId)).state).toBe('RECONCILING');
    expect(await pubsOf(p.itemId)).toHaveLength(0);
    expect(await drainUntil(p.itemId, DONE)).toBe('CONFIRMED');
    expect(api.calls.publish - publishes).toBe(1);
    expect(api.mediaOf(acc.external)).toHaveLength(1);
    expect(await intentsOf((await jobOf(p.itemId)).id)).toHaveLength(1);
  });

  it('컨테이너 처리 지연 → REMOTE_PROCESSING(publication 없음) → 같은 컨테이너로 게시 → CONFIRMED(컨테이너 1개)', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id, [[1080, 1080]], { scenario: 'instagram_container_slow' });
    await execute(p.planId);
    await tick();
    expect((await jobOf(p.itemId)).state).toBe('REMOTE_PROCESSING');
    expect(await pubsOf(p.itemId)).toHaveLength(0);
    expect(await drainUntil(p.itemId, DONE)).toBe('CONFIRMED');
    expect((await stepsOf(p.itemId)).filter((s) => s.kind === 'ig_container')).toHaveLength(1);
    expect(api.containerIds(acc.external)).toHaveLength(1);
  });
});

describe('오류 경로', () => {
  it('401 → BLOCKED(컨테이너 0) "계정 다시 연결 필요", 403 → FAILED, 원격 규격 거부(400) → FAILED 재시도 없음', async () => {
    const acc = await linkedAccount();
    const a = await planFor(acc.id, [[1080, 1080]], { scenario: 'instagram_token_invalid' });
    await execute(a.planId);
    await tick();
    const ja = await jobOf(a.itemId);
    expect(ja.state).toBe('BLOCKED');
    expect(await stepsOf(a.itemId)).toHaveLength(0);
    expect(itemHeadline({ status: 'BLOCKED', channel: 'instagram', job: ja, pub: null, blockReason: ja.lastErrorCode })).toBe('계정 다시 연결 필요');
    const b = await planFor(acc.id, [[1080, 1080]], { scenario: 'instagram_permission_denied' });
    await execute(b.planId);
    expect(await drainUntil(b.itemId, DONE)).toBe('FAILED');
    expect((await jobOf(b.itemId)).lastErrorCode).toBe('permission_denied');
    const c = await planFor(acc.id, [[1080, 1080]], { scenario: 'instagram_invalid_spec_remote' });
    await execute(c.planId);
    expect(await drainUntil(c.itemId, DONE)).toBe('FAILED');
    const jc = await jobOf(c.itemId);
    expect(jc.lastErrorCode).toBe('invalid_image_spec');
    await tick(3_600_000);
    expect(await intentsOf(jc.id)).toHaveLength(1);
    expect(await pubsOf(c.itemId)).toHaveLength(0);
    expect(publicMedia.activeCount()).toBe(0);
  });

  it('원격 429 → RETRY_WAIT(의도 1, 부작용 없음) → 같은 컨테이너로 게시 → CONFIRMED; 로컬 제한(잠정 1개) → 의도 없이 local_rate_limited', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id, [[1080, 1080]], { scenario: 'instagram_rate_limited' });
    await execute(p.planId);
    await tick();
    const j = await jobOf(p.itemId);
    expect(j).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited' });
    expect(await drainUntil(p.itemId, DONE)).toBe('CONFIRMED');
    expect(api.containerIds(acc.external)).toHaveLength(1);
    // 로컬 요청 제한
    ig.rateLimit = { ...INSTAGRAM_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
    const q = await planFor(acc.id);
    await execute(q.planId);
    await tick();
    const jq = await jobOf(q.itemId);
    expect(jq).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'local_rate_limited' });
    expect(await intentsOf(jq.id)).toHaveLength(0);
    expect(await drainUntil(q.itemId, DONE, 8, 3_600_000)).toBe('CONFIRMED');
  });

  it('시나리오 적용: instagram_* 는 Instagram 모의 연결 항목에만(일반 시나리오는 400 scenario_not_applicable)', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id, [[1080, 1080]], { approve: false });
    const r = await setScenario(p.itemId, 'ambiguous_sent');
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('scenario_not_applicable');
    expect((await setScenario(p.itemId, 'instagram_container_slow')).status).toBe(200);
  });

  it('remote_steps(0036): ig_publish 상태는 published 만, 끝난 단계·원격 ID 변경·삭제 거부, 모의 아닌 ID 거부', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id);
    await execute(p.planId);
    await tick();
    const [ct, pb] = await stepsOf(p.itemId);
    expect(pb!.kind).toBe('ig_publish');
    await expect(db.execute(sql`update remote_steps set status = 'finished' where id = ${pb!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update remote_steps set remote_id = 'mockig_ct_other' where id = ${ct!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`delete from remote_steps where id = ${pb!.id}::uuid`)).rejects.toThrow();
    await expect(
      db.execute(sql`insert into remote_steps (owner_id, job_id, intent_id, item_id, step_index, kind, post_index, remote_id, status)
        values (${owner}::uuid, ${ct!.jobId}::uuid, ${ct!.intentId}::uuid, ${ct!.itemId}::uuid, 9, 'ig_container', 5, 'https://instagram.com/p/x', 'created')`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into remote_steps (owner_id, job_id, intent_id, item_id, step_index, kind, post_index, remote_id, status)
        values (${owner}::uuid, ${ct!.jobId}::uuid, ${ct!.intentId}::uuid, ${ct!.itemId}::uuid, 9, 'ig_publish', 1, 'mockig_m_other', 'created')`),
    ).rejects.toThrow();
  });

  it('web tick route(앱 경로)도 Instagram 모의 어댑터로 — 응답 MOCK, 저장소 창구로 규격 검사 후 CONFIRMED', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id);
    await execute(p.planId);
    const res = await rec(await tickPOST(post('/api/worker/tick', { max_jobs: 5 })));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('MOCK');
    const job = await jobOf(p.itemId);
    expect(job.state).toBe('CONFIRMED');
    expect((await rec(await jobGET(get(`/api/jobs/${job.id}`), ctx(job.id)))).status).toBe(200);
  });
});

describe('복원 — Instagram 단계는 읽기 전용 이력, 조회는 확인 불가(unknown)', () => {
  it('응답 유실(RECONCILING) 항목을 내보내고 복원 → 단계가 같은 값으로 들어오고 재확인은 unknown(전송 0), 단계 없는 묶음 → restored_steps_missing', async () => {
    const acc = await linkedAccount();
    const p = await planFor(acc.id, [[1080, 1080]], { scenario: 'instagram_publish_timeout_sent' });
    await execute(p.planId);
    await tick();
    expect((await jobOf(p.itemId)).state).toBe('RECONCILING');
    const sig = (rows: Array<typeof schema.remoteSteps.$inferSelect>) => rows.map((s) => `${s.id}:${s.kind}:${s.postIndex}:${s.remoteId}:${s.status}`);
    const src = sig(await stepsOf(p.itemId));
    expect(src).toHaveLength(1);
    const ex = await exportOwner(db, storage, owner, { outDir: path.join(tmp, 'exports') });
    const raw = readFileSync(ex.zipPath);
    expect(raw.includes(Buffer.from(MOCK_PUBLIC_MEDIA_PREFIX))).toBe(false);
    const parsed = await parseBundleZip(new Uint8Array(raw));
    expect(parsed.tables.remote_steps.some((r) => r.kind === 'ig_container')).toBe(true);
    const bundleOf = (tables: BundleTables) =>
      writeZip(
        buildBundle({
          exportId: randomUUID(),
          exportedAt: new Date().toISOString(),
          appVersion: parsed.manifest.app_version,
          migrations: parsed.manifest.schema_migrations,
          owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
          tables,
          assetBytes: new Map(parsed.assetBytes),
        }).entries,
      );
    const restoreInto = async (zip: Uint8Array) => {
      const h = await createTestDb();
      const target = (await ensureOwner(h.db, `restore-t16-${randomUUID().slice(0, 6)}@example.local`)).id;
      const restoresDir = path.join(tmp, 'restores');
      const pv = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, `assets-r-${randomUUID().slice(0, 6)}`)), target, pv.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      return { h, target };
    };
    const lastReconcileCode = async (hdb: Db, itemId: string) => {
      const j = (await hdb.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)))[0]!;
      const evs = await hdb.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, j.id)).orderBy(asc(schema.jobEvents.eventSeq));
      return (evs.at(-1)!.sanitizedDetails as { error_code?: string }).error_code;
    };
    expect(RESTORED_TABLES as readonly string[]).toContain('remote_steps');
    {
      const { h, target } = await restoreInto(bundleOf(structuredClone(parsed.tables) as BundleTables));
      try {
        const rs = await h.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, p.itemId)).orderBy(asc(schema.remoteSteps.stepIndex));
        expect(sig(rs)).toEqual(src);
        const j = (await h.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, p.itemId)))[0]!;
        expect(j).toMatchObject({ restoredNeedsReview: true, leaseOwner: null });
        const submits = ig.calls.submit;
        const rc = await reconcileItem(h.db, registry, target, p.itemId);
        expect(rc.remote).toBe('unknown');
        expect(ig.calls.submit).toBe(submits);
        expect((await runJobsTick(h.db, registry, { workerId: 'restored-w', config, ownerId: target, submitTimeoutMs: 500 })).leased).toBe(0);
      } finally {
        await h.close();
      }
    }
    {
      const old = structuredClone(parsed.tables) as BundleTables;
      old.remote_steps = old.remote_steps.filter((r) => r.item_id !== p.itemId);
      const { h, target } = await restoreInto(bundleOf(old));
      try {
        expect(await h.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, p.itemId))).toHaveLength(0);
        const rc = await reconcileItem(h.db, registry, target, p.itemId);
        expect(rc.remote).toBe('unknown');
        expect(await lastReconcileCode(h.db, p.itemId)).toBe('restored_steps_missing');
      } finally {
        await h.close();
      }
    }
    expect(api.mediaOf(acc.external)).toHaveLength(1);
  }, 180_000);
});

describe('비밀 — 토큰·공개 미디어 URL 은 어디에도 나가지 않는다', () => {
  it('콘솔·응답·감사·작업 이력·전송 의도·단계·결과·내보내기에 Instagram 토큰·mock://public-media/ 없음, 살아 있는 공개 URL 0, fetch 0', async () => {
    expect([...mockOAuthStore().tokens.values()].some((t) => t.provider === 'mock_instagram')).toBe(true);
    expect(publicMedia.stats.issued).toBeGreaterThan(0);
    const leak = /mockig_at_|mockig_code_|mock:\/\/public-media\//;
    const tables = [schema.auditEvents, schema.jobEvents, schema.sendIntents, schema.publications, schema.jobs, schema.mockScenarios, schema.remoteSteps, schema.distributionItems];
    for (const t of tables) expect(JSON.stringify(await db.select().from(t as typeof schema.auditEvents))).not.toMatch(leak);
    for (const s of seen) expect(s).not.toMatch(/mockig_at_|mock:\/\/public-media\//);
    for (const l of logs) expect(l).not.toMatch(leak);
    const ex = await exportOwner(db, storage, owner, { outDir: path.join(tmp, 'exports-leak'), record: false });
    const raw = readFileSync(ex.zipPath);
    expect(raw.includes(Buffer.from('mockig_at_'))).toBe(false);
    expect(raw.includes(Buffer.from(MOCK_PUBLIC_MEDIA_PREFIX))).toBe(false);
    expect(publicMedia.activeCount()).toBe(0);
    expect(fetchCalls).toBe(0);
  });
});

describe('drill:mock 의 Instagram 행(같은 표)', () => {
  it('불변식 위반 0·fetch 0, 표가 기대와 같다(게시 1회·캐러셀 컨테이너 n+1·승인 전 규격 거절·재시작 UNKNOWN)', async () => {
    const r = await runInstagramDrill();
    expect(r.violations).toEqual([]);
    expect(r.fetch_calls).toBe(0);
    expect(r.rows.every((x) => x.ok)).toBe(true);
    const table = formatInstagramDrillTable(r);
    expect(table).toContain('instagram_success · 캐러셀 3장 | 3 | CONFIRMED | CONFIRMED | 1 | 4 | 1 | MOCK PUBLISHED/public | 없음');
    expect(table).toContain('승인 전 규격 위반(9:16 세로) → 승인 거절 | 1 | (없음) | PLANNED | 0 | 0 | 0 | 없음 | 없음');
    expect(table).toContain('재시작(모의 Instagram 기록 유실) → UNKNOWN | 1 | UNKNOWN | UNKNOWN | 1 | 1 | 0 | 없음 | 없음');
    expect(fetchCalls).toBe(0);
  }, 180_000);
});
