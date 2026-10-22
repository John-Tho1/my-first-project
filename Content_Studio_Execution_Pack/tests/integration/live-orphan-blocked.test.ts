/**
 * FIX1-FULLREV(F1): 실행 앞선 검사(pendingLiveJobs)는 전송 직전 검사(beginSend)에 아직 닿을 수 있는 작업만 센다.
 * 승인 철회·무효나 beginSend approval_missing·snapshot_stale 로 항목이 PLANNED 로 돌아간 옛 BLOCKED 작업(고아)은 재시도·취소·전송 어느 길로도 보내지 않으므로
 * 세지 않는다 — 세면 PUBLISH_LIVE_MAX_POSTS=1 에서 다시 승인 → 실행이 승인 기록과 관계없이 늘 429 가 된다. 다시 보낼 수 있는 보류 작업은 지금처럼 센다.
 * + FIX1-FULLREV(F2) 실제 게시 변형: 게시 시도 표식(publish_attempt) 뒤 401 로 보류된 작업의 철회는 PLANNED 가 아니라 UNKNOWN.
 * **실제 네트워크 호출 0**: OAuth 는 fixture(globalThis.fetch 교체), 게시 어댑터에는 fixture fetch 주입. 토큰·시크릿은 가짜(FAKE_…), ID 는 가짜 숫자.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  getDb,
  getPlanDetail,
  leaseJobs,
  pendingLiveJobs,
  processJob,
  reconcileItem,
  runJobsTick,
  schema,
  seed,
  setLivePublishPaused,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { livePublishReadiness, loadConfig, type AppConfig } from '@cs/domain';
import { createMockAdapterRegistry, LiveCapableAdapterRegistry, LiveThreadsPublishAdapter, THREADS_LONG_LIVED_URL, THREADS_ME_URL, THREADS_TOKEN_URL } from '@cs/providers';
import { POST as revokePOST } from '../../apps/web/app/api/approvals/[id]/revoke/route';
import { POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as targetPOST } from '../../apps/web/app/api/channel-accounts/[id]/publish-target/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as userConfirmPOST } from '../../apps/web/app/api/distribution-items/[id]/user-confirm/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { blockInfoOf, liveItemHeadline } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000001';
const SECRET = 'FAKE_app_secret_F1_integration_only';
const SHORT = 'FAKE_short_token_F1_it_ssssssssssssss';
const LONG = 'FAKE_long_token_F1_it_publish_llllllllll';
const REDIRECT = `${BASE}/api/oauth/callback`;
const PROFILE_ID = '17841400000000088';

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let liveAccount: string;

const OAUTH_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const GATE_KEYS = ['PUBLISH_MODE', 'PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_MAX_POSTS'] as const;
const setGates = (g: Partial<Record<(typeof GATE_KEYS)[number], string>>) => {
  for (const k of GATE_KEYS) vi.stubEnv(k, g[k] ?? '');
};
const fullCfg = (ref: string, max: string) => {
  setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: ref, PUBLISH_LIVE_MAX_POSTS: max });
  return loadConfig();
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---- 실제 게시 fixture(주입 fetch) ----
interface Call {
  method: string;
  url: URL;
}
let idSeq = 500;
const nextId = () => `18000000000${String(++idSeq).padStart(6, '0')}`;
function publishFixture(routes: (ids: { ct: string; media: string }) => Record<string, () => Response>) {
  const ids = { ct: nextId(), media: nextId() };
  const calls: Call[] = [];
  const table = routes(ids);
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const r = table[`${method} ${url.pathname}`];
    if (!r) throw new Error(`fixture 없음: ${method} ${url.pathname}`);
    return r();
  });
  return { fetch, calls, ids };
}
const P = (ids: { ct: string; media: string }) => ({
  create: `POST /v1.0/${PROFILE_ID}/threads`,
  status: `GET /v1.0/${ids.ct}`,
  publish: `POST /v1.0/${PROFILE_ID}/threads_publish`,
  read: `GET /v1.0/${ids.media}`,
});
const happy = (text: string) => (ids: { ct: string; media: string }) => {
  const p = P(ids);
  return {
    [p.create]: () => jsonRes(200, { id: ids.ct }),
    [p.status]: () => jsonRes(200, { status: 'FINISHED', id: ids.ct }),
    [p.publish]: () => jsonRes(200, { id: ids.media }),
    [p.read]: () =>
      jsonRes(200, {
        id: ids.media,
        permalink: `https://www.threads.com/@f1tester/post/${ids.media.slice(-6)}`,
        text,
        timestamp: new Date().toISOString().replace(/\.\d+Z$/, '+0000'),
        media_type: 'TEXT_POST',
      }),
  };
};
const publishesOf = (calls: Call[]) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('threads_publish'));

function registryWith(fetch: (input: string, init?: RequestInit) => Promise<Response>, config: AppConfig) {
  const gate = () => livePublishReadiness(config);
  return new LiveCapableAdapterRegistry(createMockAdapterRegistry(), new LiveThreadsPublishAdapter({ gate, fetch, pollIntervalMs: 0 }), gate);
}
const runOpts = (config: AppConfig) => ({
  workerId: 'f1-w',
  config,
  ownerId: owner,
  clock: () => new Date(),
  random: () => 0.5,
  submitTimeoutMs: 5000,
  maxJobs: 20,
  credentials: jobCredentials(config, db),
});
async function tick(registry: LiveCapableAdapterRegistry, config: AppConfig) {
  return runJobsTick(db, registry, runOpts(config));
}

interface Planned {
  planId: string;
  item: { id: string; payload_hash: string };
}
async function planApproved(body: string): Promise<Planned> {
  const { content } = await createContent(db, owner, { title: `F1 ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variant.id, channel_account_id: liveAccount }] }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  const item = p.items[0]!;
  const ap = await approve(p.plan.id, item);
  expect(ap.status, await ap.clone().text()).toBe(200);
  return { planId: p.plan.id, item };
}
const approve = (planId: string, item: { id: string; payload_hash: string }) =>
  approvePOST(
    post(`/api/distribution-plans/${planId}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'public_publish' }),
    ctx(planId),
  );
const execute = (planId: string) => executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId));
const cancel = (itemId: string) => cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId));
const retry = (itemId: string) => retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));
const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const activeApprovalId = async (itemId: string) =>
  (await db.select().from(schema.approvals).where(and(eq(schema.approvals.distributionItemId, itemId), isNull(schema.approvals.revokedAt))))[0]!.id;
async function revoke(itemId: string) {
  const id = await activeApprovalId(itemId);
  const r = await revokePOST(post(`/api/approvals/${id}/revoke`, {}), ctx(id));
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as { blocked_job_ids: string[]; partial_job_ids: string[]; cancel_requested_job_ids: string[] };
}

/** 실제 Threads 계정(연결 전 행) → 실제 OAuth 연결(fixture) → 실제 게시 계정으로 사용 */
async function connectLiveAccount(): Promise<string> {
  for (const [k, v] of Object.entries(OAUTH_ENV)) vi.stubEnv(k, v);
  const created = await accountsPOST(post('/api/channel-accounts', { platform: 'threads', kind: 'live' }));
  const { account } = (await created.json()) as { account: { id: string } };
  const c = await connectPOST(post(`/api/channel-accounts/${account.id}/connect`), ctx(account.id));
  expect(c.status, await c.clone().text()).toBe(200);
  const state = new URL(((await c.json()) as { authorize_url: string }).authorize_url).searchParams.get('state')!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const key = `${init?.method ?? 'GET'} ${u.origin}${u.pathname}`;
      if (key === `POST ${THREADS_TOKEN_URL}`) return jsonRes(200, { access_token: SHORT, token_type: 'bearer', user_id: 1 });
      if (key === `GET ${THREADS_LONG_LIVED_URL}`) return jsonRes(200, { access_token: LONG, token_type: 'bearer', expires_in: 5184000 });
      if (key === `GET ${THREADS_ME_URL}`) return jsonRes(200, { id: PROFILE_ID, username: 'f1tester' });
      throw new Error(`fixture 없음: ${key}`);
    }),
  );
  const u = new URL(REDIRECT);
  u.searchParams.set('code', 'FAKE_code_F1_it_cccccccccccccccccc');
  u.searchParams.set('state', state);
  const cb = await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  vi.unstubAllGlobals();
  for (const k of Object.keys(OAUTH_ENV)) vi.stubEnv(k, '');
  const on = await targetPOST(post(`/api/channel-accounts/${account.id}/publish-target`, { enabled: true }), ctx(account.id));
  expect(on.status, await on.clone().text()).toBe(200);
  return account.id;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-f1-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
  liveAccount = await connectLiveAccount();
});
beforeEach(() => {
  setGates({});
});
afterEach(async () => {
  vi.unstubAllGlobals();
  // 다음 시험이 이 시험의 대기 작업을 세지 않게: 다시 보낼 수 있는 실제 작업이 남아 있으면 안 된다
  expect(await pendingLiveJobs(db, `after-each-${randomUUID()}`)).toBe(0);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('FIX1-FULLREV(F1): 고아 BLOCKED 작업은 실행 앞선 검사에서 세지 않는다(PUBLISH_LIVE_MAX_POSTS=1)', () => {
  it('실행 → (대기 중) 승인 철회 → 다시 승인 → 실행 200(429 아님), 센 작업은 새 작업 하나 → 작업 처리기 → 실제 게시 1번', async () => {
    const TEXT = 'F1 철회 뒤 다시 승인 글.';
    const p = await planApproved(TEXT);
    const cfg = fullCfg('F1-revoke', '1');
    expect((await execute(p.planId)).status).toBe(200);
    const [j1] = await jobsOf(p.item.id);
    expect(j1!.state).toBe('QUEUED');
    expect(await revoke(p.item.id)).toMatchObject({ blocked_job_ids: [j1!.id], partial_job_ids: [] });
    expect((await jobsOf(p.item.id))[0]!.state).toBe('BLOCKED');
    expect((await itemOf(p.item.id)).status).toBe('PLANNED');
    // 고아: 항목이 PLANNED — 재시도·취소 모두 거절(다시 보낼 길이 없다) → 세지 않는다
    expect((await retry(p.item.id)).status).toBe(409);
    expect((await cancel(p.item.id)).status).toBe(409);
    expect(await pendingLiveJobs(db, 'F1-revoke')).toBe(0);
    // 다시 승인 → 새 실행 키 → 실행(앞선 검사 0 + 0 + 1 ≤ 1)
    expect((await approve(p.planId, p.item)).status).toBe(200);
    const ex = await execute(p.planId);
    expect(ex.status, await ex.clone().text()).toBe(200);
    expect(await ex.json()).toMatchObject({ mode: 'LIVE' });
    const jobs = await jobsOf(p.item.id);
    expect(jobs.map((j) => j.state)).toEqual(['BLOCKED', 'QUEUED']);
    expect(await pendingLiveJobs(db, 'F1-revoke')).toBe(1);
    const fx = publishFixture(happy(TEXT));
    expect((await tick(registryWith(fx.fetch, cfg), cfg)).results).toEqual({ CONFIRMED: 1 });
    expect(publishesOf(fx.calls)).toHaveLength(1);
    // 상한 1 을 다 썼다 — 권위 있는 검사(게시 수)는 그대로: 같은 승인 기록의 다음 실행은 429
    const q = await planApproved('F1 상한 확인 글.');
    const again = await execute(q.planId);
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ error: 'live_publish_limit', limit: 1, used: 1 });
    expect(await jobsOf(q.item.id)).toHaveLength(0);
  });

  it('전송 직전 approval_missing(대기열에 넣은 뒤 승인이 사라진 경합 모사) → BLOCKED·항목 PLANNED(원격 호출 0) → 다시 승인 → 실행 200 → 게시 1번', async () => {
    const TEXT = 'F1 전송 직전 승인 없음 글.';
    const p = await planApproved(TEXT);
    const cfg = fullCfg('F1-missing', '1');
    expect((await execute(p.planId)).status).toBe(200);
    // 경합 모사: 철회 경로(작업을 BLOCKED 로 막음)를 거치지 않고 승인만 사라진 상태 — 작업 처리기의 전송 직전 재검사가 막는다
    await db.update(schema.approvals).set({ revokedAt: new Date(), revokeReason: 'test: race' }).where(eq(schema.approvals.distributionItemId, p.item.id));
    const none = publishFixture(() => ({}));
    expect((await tick(registryWith(none.fetch, cfg), cfg)).results).toEqual({ BLOCKED: 1 });
    expect(none.calls).toHaveLength(0);
    expect((await jobsOf(p.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing' });
    expect((await itemOf(p.item.id)).status).toBe('PLANNED');
    expect(await pendingLiveJobs(db, 'F1-missing')).toBe(0);
    expect((await approve(p.planId, p.item)).status).toBe(200);
    const ex = await execute(p.planId);
    expect(ex.status, await ex.clone().text()).toBe(200);
    const fx = publishFixture(happy(TEXT));
    expect((await tick(registryWith(fx.fetch, cfg), cfg)).results).toEqual({ CONFIRMED: 1 });
    expect(publishesOf(fx.calls)).toHaveLength(1);
  });

  it('전송 직전 snapshot_stale(편집 훅을 거치지 않은 스냅샷 변경 모사) → 승인 무효·BLOCKED·항목 PLANNED(원격 호출 0) → 다시 검토·다시 승인 → 실행 200 → 게시 1번', async () => {
    const TEXT = 'F1 전송 직전 스냅샷 변경 글.';
    const p = await planApproved(TEXT);
    const cfg = fullCfg('F1-stale', '1');
    expect((await execute(p.planId)).status).toBe(200);
    const variantId = (await itemOf(p.item.id)).variantId;
    // 경합 모사: 승인 무효화 훅을 거치지 않고 파생본이 검토 상태를 벗어남 — 작업 처리기의 전송 직전 스냅샷 재검사(variant_not_review)가 막는다
    await db.update(schema.variants).set({ lifecycle: 'draft' }).where(eq(schema.variants.id, variantId));
    const none = publishFixture(() => ({}));
    expect((await tick(registryWith(none.fetch, cfg), cfg)).results).toEqual({ BLOCKED: 1 });
    expect(none.calls).toHaveLength(0);
    expect((await jobsOf(p.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'snapshot_stale' });
    expect((await itemOf(p.item.id)).status).toBe('PLANNED');
    expect(await pendingLiveJobs(db, 'F1-stale')).toBe(0);
    // 같은 버전을 다시 검토로 → 스냅샷이 다시 맞는다 → 다시 승인 → 실행(앞선 검사 0 + 0 + 1 ≤ 1)
    await setVariantLifecycle(db, owner, variantId, { lifecycle: 'review', baseVersion: 1 });
    const ap = await approve(p.planId, p.item);
    expect(ap.status, await ap.clone().text()).toBe(200);
    const ex = await execute(p.planId);
    expect(ex.status, await ex.clone().text()).toBe(200);
    expect((await jobsOf(p.item.id)).map((j) => j.state)).toEqual(['BLOCKED', 'QUEUED']);
    const fx = publishFixture(happy(TEXT));
    expect((await tick(registryWith(fx.fetch, cfg), cfg)).results).toEqual({ CONFIRMED: 1 });
    expect(publishesOf(fx.calls)).toHaveLength(1);
  });

  it('새 승인 기록(D38-3 방식): 옛 승인 기록의 고아 작업이 있어도 새 승인 기록·상한 1 실행은 200', async () => {
    const old = await planApproved('F1 옛 승인 기록 글.');
    fullCfg('F1-old-ref', '1');
    expect((await execute(old.planId)).status).toBe(200);
    await revoke(old.item.id);
    expect((await itemOf(old.item.id)).status).toBe('PLANNED');
    expect((await jobsOf(old.item.id))[0]!.state).toBe('BLOCKED');
    const TEXT = 'F1 새 승인 기록 글.';
    const p = await planApproved(TEXT);
    const cfg = fullCfg('F1-new-ref', '1');
    expect(await pendingLiveJobs(db, 'F1-new-ref')).toBe(0);
    const ex = await execute(p.planId);
    expect(ex.status, await ex.clone().text()).toBe(200);
    const fx = publishFixture(happy(TEXT));
    expect((await tick(registryWith(fx.fetch, cfg), cfg)).results).toEqual({ CONFIRMED: 1 });
    expect(publishesOf(fx.calls)).toHaveLength(1);
  });

  it('지금처럼: 다시 보낼 수 있는 보류(즉시 중지 → BLOCKED·항목 BLOCKED) 작업은 센다 → 다른 항목 실행 429 · 같은 항목의 고아 + 새 보류는 한 번만 센다 · 취소하면 풀림', async () => {
    const cfg = fullCfg('F1-keep', '1');
    const a = await planApproved('F1 보류 유지 글 A.');
    expect((await execute(a.planId)).status).toBe(200);
    await setLivePublishPaused(db, owner, true);
    try {
      const none = publishFixture(() => ({}));
      expect((await tick(registryWith(none.fetch, cfg), cfg)).results).toEqual({ BLOCKED: 1 });
      expect(none.calls).toHaveLength(0);
      const [ja] = await jobsOf(a.item.id);
      expect(ja).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'live_publish_paused' });
      expect((await itemOf(a.item.id)).status).toBe('BLOCKED');
      // 재개 뒤 '재시도'로 보낼 수 있는 작업 — 센다(앞선 검사가 미리 알린다)
      expect(await pendingLiveJobs(db, 'F1-keep')).toBe(1);
      // retryItem 이 거절하는 복원 표시(작업 또는 항목)가 있으면 다시 보낼 길이 없다 — 세지 않는다(표시를 되돌리면 다시 센다)
      await db.update(schema.jobs).set({ restoredNeedsReview: true }).where(eq(schema.jobs.id, ja!.id));
      expect(await pendingLiveJobs(db, 'F1-keep')).toBe(0);
      await db.update(schema.jobs).set({ restoredNeedsReview: false }).where(eq(schema.jobs.id, ja!.id));
      await db.update(schema.distributionItems).set({ restoredNeedsReview: true }).where(eq(schema.distributionItems.id, a.item.id));
      expect(await pendingLiveJobs(db, 'F1-keep')).toBe(0);
      await db.update(schema.distributionItems).set({ restoredNeedsReview: false }).where(eq(schema.distributionItems.id, a.item.id));
      expect(await pendingLiveJobs(db, 'F1-keep')).toBe(1);
      const b = await planApproved('F1 보류 유지 글 B.');
      const r1 = await execute(b.planId);
      expect(r1.status).toBe(429);
      expect(await r1.json()).toMatchObject({ error: 'live_publish_limit', limit: 1, used: 1 });
      // A 의 승인 철회 → 옛 작업은 고아(항목 PLANNED) → 다시 승인·실행 → 새 작업도 중지로 BLOCKED: A 는 최근 작업 하나만 센다
      expect(await revoke(a.item.id)).toMatchObject({ blocked_job_ids: [], partial_job_ids: [] });
      expect((await itemOf(a.item.id)).status).toBe('PLANNED');
      expect(await pendingLiveJobs(db, 'F1-keep')).toBe(0);
      expect((await approve(a.planId, a.item)).status).toBe(200);
      expect((await execute(a.planId)).status).toBe(200);
      expect((await tick(registryWith(none.fetch, cfg), cfg)).results).toEqual({ BLOCKED: 1 });
      expect((await jobsOf(a.item.id)).map((j) => j.state)).toEqual(['BLOCKED', 'BLOCKED']);
      expect((await itemOf(a.item.id)).status).toBe('BLOCKED');
      expect(await pendingLiveJobs(db, 'F1-keep')).toBe(1);
      expect((await execute(b.planId)).status).toBe(429);
      // 보류 항목 취소 → CANCELED → 더 세지 않음 → B 실행 200
      expect(await (await cancel(a.item.id)).json()).toMatchObject({ state: 'CANCELED' });
      expect(await pendingLiveJobs(db, 'F1-keep')).toBe(0);
      expect((await execute(b.planId)).status).toBe(200);
      expect(await (await cancel(b.item.id)).json()).toMatchObject({ state: 'CANCELED' });
      expect(none.calls).toHaveLength(0);
    } finally {
      await setLivePublishPaused(db, owner, false);
    }
  });
});

describe('FIX1-FULLREV(F2) 실제 게시 변형: 게시 시도 표식 뒤 보류된 작업의 승인 철회 → UNKNOWN(PLANNED 아님)', () => {
  it('threads_publish 401(표식 있음, 게시 단계 없음) → BLOCKED → 철회 → 작업·항목 UNKNOWN(thread_partial_revoked) · 다시 승인 409·실행 409 · 다시 게시 0', async () => {
    const p = await planApproved('F2 실제 게시 시도 뒤 철회 글.');
    const cfg = fullCfg('F2-live', '5');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => {
      const r = P(ids);
      return {
        [r.create]: () => jsonRes(200, { id: ids.ct }),
        [r.status]: () => jsonRes(200, { status: 'FINISHED', id: ids.ct }),
        [r.publish]: () => jsonRes(401, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }),
      };
    });
    expect((await tick(registryWith(fx.fetch, cfg), cfg)).results).toEqual({ BLOCKED: 1 });
    expect(publishesOf(fx.calls)).toHaveLength(1);
    const [job] = await jobsOf(p.item.id);
    expect(job).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'publish_auth_invalid_token' });
    const steps = await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.jobId, job!.id));
    expect(steps.map((s) => s.kind).sort()).toEqual(['container', 'publish_attempt']);
    expect((await itemOf(p.item.id)).status).toBe('BLOCKED');

    expect(await revoke(p.item.id)).toMatchObject({ blocked_job_ids: [], partial_job_ids: [job!.id], cancel_requested_job_ids: [] });
    const [after] = await jobsOf(p.item.id);
    expect(after).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked' });
    const evs = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job!.id)).orderBy(asc(schema.jobEvents.eventSeq));
    expect(evs.at(-1)!.sanitizedDetails).toMatchObject({ transition: 'cancel_partial', from: 'BLOCKED', published_parts: 0, publish_attempts: 1, not_sent: false });
    expect((await itemOf(p.item.id)).status).toBe('UNKNOWN');
    const headline = liveItemHeadline({ status: 'UNKNOWN', channel: 'threads', job: after!, pub: null, blockReason: null });
    expect(headline).toContain('승인 철회·무효');
    expect(headline).toContain('다시 게시하지 않음');
    // 화면(계획 페이지)과 같은 입력: 이력(최신 먼저)에서 blockInfoOf — 앞선 401 BLOCKED 사유가 철회 결과 문구를 가리지 않는다
    const block = blockInfoOf([...evs].reverse(), after!);
    const pageHeadline = liveItemHeadline({ status: 'UNKNOWN', channel: 'threads', job: after!, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false });
    expect(pageHeadline).toContain('승인 철회·무효');
    expect(pageHeadline).toContain('다시 게시하지 않음');
    // 이 항목으로는 다시 승인·실행할 수 없다(새 작업 0 — 같은 글을 새로 게시하지 않음)
    const ap = await approve(p.planId, p.item);
    expect(ap.status).toBe(409);
    expect(await ap.json()).toMatchObject({ error: 'item_not_planned' });
    expect((await execute(p.planId)).status).toBe(409);
    expect(await jobsOf(p.item.id)).toHaveLength(1);
    expect(await pendingLiveJobs(db, 'F2-live')).toBe(0);
    expect((await tick(registryWith(fx.fetch, cfg), cfg)).results).toEqual({});
    expect(publishesOf(fx.calls)).toHaveLength(1);
  });
});

/**
 * FIX1-FULLREV(F2 후속2) 실제 게시 변형: 게시 시도 표식만 있는(게시 단계 0) 작업이 보류 → 재시도 → lease 된 뒤(보내기 전) 멈춤.
 * 작업 처리기의 공용 규칙(stopUnlessPartial)이 게시 시도 표식도 센다 — 셈에서 빠지면 계정 사용 중지(승인 무효)는 BLOCKED + 항목 PLANNED
 * (다시 승인 → 새 작업 → 새 컨테이너 → 같은 글 두 번째 실제 게시), 사용자 철회는 CANCELED("보내지 않음")가 된다.
 */
describe('FIX1-FULLREV(F2 후속2) 실제 게시 변형: 게시 시도 표식 뒤 401 → 재시도 → lease 뒤 멈춤 → UNKNOWN(PLANNED·CANCELED 아님)', () => {
  /** 실제 게시 401(표식 있음, 게시 단계 없음) → BLOCKED → 재시도(QUEUED) → lease 만(LEASED — 보내기 전) */
  async function leasedAfterMarker(text: string, ref: string) {
    const p = await planApproved(text);
    const cfg = fullCfg(ref, '5');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => {
      const r = P(ids);
      return {
        [r.create]: () => jsonRes(200, { id: ids.ct }),
        [r.status]: () => jsonRes(200, { status: 'FINISHED', id: ids.ct }),
        [r.publish]: () => jsonRes(401, { error: { message: 'Error validating access token', type: 'OAuthException', code: 190 } }),
      };
    });
    expect((await tick(registryWith(fx.fetch, cfg), cfg)).results).toEqual({ BLOCKED: 1 });
    expect(publishesOf(fx.calls)).toHaveLength(1);
    const [job] = await jobsOf(p.item.id);
    expect(job).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'publish_auth_invalid_token' });
    const steps = await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.jobId, job!.id));
    expect(steps.map((s) => s.kind).sort()).toEqual(['container', 'publish_attempt']);
    // 의도 결과가 rejected(확정 거절)라 재시도는 받아들여진다 → 대기열 → 작업 처리기가 lease 만 하고 보내기 전
    const rt = await retry(p.item.id);
    expect(rt.status, await rt.clone().text()).toBe(200);
    const [leased] = await leaseJobs(db, { workerId: 'f1-w', now: new Date(), limit: 1, ownerId: owner, planId: p.planId });
    expect(leased).toMatchObject({ id: job!.id, state: 'LEASED', leaseOwner: 'f1-w' });
    return { ...p, cfg, fx, leased: leased! };
  }
  const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));

  it('(a) 계정 "실제 게시 계정으로 사용" 중지(승인 무효 account_changed) → 항목 PLANNED 아님(leased_partial_jobs 1) → 보내기 직전 approval_missing → UNKNOWN(thread_partial_revoked, 게시 0·시도 표식 1) · 새 컨테이너·게시 0 · 다시 승인 409', async () => {
    const x = await leasedAfterMarker('F2 후속2 표식 뒤 계정 사용 중지 글.', 'F2b-live-off');
    const approvalId = await activeApprovalId(x.item.id);
    const off = await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: false }), ctx(liveAccount));
    try {
      expect(off.status, await off.clone().text()).toBe(200);
      const ap = (await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)))[0]!;
      expect(ap.revokeReason).toBe('invalidated:account_changed');
      const audit = (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'approval.invalidate'), eq(schema.auditEvents.entityId, approvalId))))[0]!;
      expect(audit.sanitizedDetails).toMatchObject({ partial: false, leased_partial_jobs: 1 });
      // 작업은 전송 단계(LEASED) 그대로, 항목은 실행 전(PLANNED)으로 가지 않는다
      expect((await jobsOf(x.item.id))[0]).toMatchObject({ id: x.leased.id, state: 'LEASED' });
      expect((await itemOf(x.item.id)).status).toBe('QUEUED');
      const none = publishFixture(() => ({}));
      expect((await processJob(db, registryWith(none.fetch, x.cfg), x.leased, runOpts(x.cfg))).state).toBe('UNKNOWN');
      expect(none.calls).toHaveLength(0);
      const [after] = await jobsOf(x.item.id);
      expect(after).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', leaseOwner: null });
      expect(after!.cancelRequestedAt).toBeNull(); // FIX1-FULLREV(F2 후속2): 계정 사용 중지(승인 무효)는 취소가 아니다
      const evs = await eventsOf(after!.id);
      const [prev, last] = evs.slice(-2);
      expect(prev).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
      expect(prev!.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing', not_sent: false, published_parts: 0, publish_attempts: 1 });
      expect(last).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
      expect(last!.sanitizedDetails).toMatchObject({ transition: 'cancel_partial', cause: 'approval_missing', not_sent: false, published_parts: 0, publish_attempts: 1 });
      expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
      const block = blockInfoOf([...evs].reverse(), after!);
      const headline = liveItemHeadline({ status: 'UNKNOWN', channel: 'threads', job: after!, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false });
      expect(headline).toContain('승인 철회·무효');
      expect(headline).toContain('다시 게시하지 않음');
    } finally {
      const on = await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: true }), ctx(liveAccount));
      expect(on.status, await on.clone().text()).toBe(200);
    }
    // 계정을 다시 써도 이 항목은 다시 승인·실행할 수 없다(새 작업·새 컨테이너 0 — 같은 글을 두 번째로 게시하지 않음)
    const ap = await approve(x.planId, x.item);
    expect(ap.status).toBe(409);
    expect(await ap.json()).toMatchObject({ error: 'item_not_planned' });
    expect((await execute(x.planId)).status).toBe(409);
    expect(await jobsOf(x.item.id)).toHaveLength(1);
    const later = publishFixture(() => ({}));
    expect((await tick(registryWith(later.fetch, x.cfg), x.cfg)).results).toEqual({});
    expect(later.calls).toHaveLength(0);
    expect(publishesOf(x.fx.calls)).toHaveLength(1);
    expect(x.fx.calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/threads'))).toHaveLength(1);
  });

  it('(b) lease 뒤 보내기 전 사용자 승인 철회 → CANCEL_REQUESTED → 보내기 직전 재검사 → CANCELED("보내지 않음")가 아니라 UNKNOWN(thread_partial_cancel_requested, 게시 0·시도 표식 1) · 새 호출 0 · 다시 승인 409', async () => {
    const x = await leasedAfterMarker('F2 후속2 표식 뒤 사용자 철회 글.', 'F2b-live-revoke');
    expect(await revoke(x.item.id)).toMatchObject({ blocked_job_ids: [], partial_job_ids: [], cancel_requested_job_ids: [x.leased.id] });
    expect((await itemOf(x.item.id)).status).toBe('CANCEL_REQUESTED');
    const none = publishFixture(() => ({}));
    expect((await processJob(db, registryWith(none.fetch, x.cfg), x.leased, runOpts(x.cfg))).state).toBe('UNKNOWN');
    expect(none.calls).toHaveLength(0);
    const [after] = await jobsOf(x.item.id);
    expect(after).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested', leaseOwner: null });
    expect(after!.cancelRequestedAt).not.toBeNull(); // FIX1-FULLREV(F2 후속2): 사용자 철회의 취소 요청 — 시각이 남는다
    const evs = await eventsOf(after!.id);
    expect(evs.at(-1)).toMatchObject({ stateBefore: 'CANCEL_REQUESTED', stateAfter: 'UNKNOWN' });
    expect(evs.at(-1)!.sanitizedDetails).toMatchObject({
      transition: 'reconcile_unsupported',
      reason: 'thread_partial_cancel_requested',
      not_sent: false,
      published_parts: 0,
      publish_attempts: 1,
    });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    // 화면 입력: 최근 BLOCKED 사건은 앞선 401 — 그 사유가 취소 문구를 가리지 않는다
    const block = blockInfoOf([...evs].reverse(), after!);
    const headline = liveItemHeadline({ status: 'UNKNOWN', channel: 'threads', job: after!, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false });
    expect(headline).toContain('취소 요청 — 이미 게시됐거나 게시됐을 수 있음');
    const ap = await approve(x.planId, x.item);
    expect(ap.status).toBe(409);
    expect(await ap.json()).toMatchObject({ error: 'item_not_planned' });
    expect(await jobsOf(x.item.id)).toHaveLength(1);
    const later = publishFixture(() => ({}));
    expect((await tick(registryWith(later.fetch, x.cfg), x.cfg)).results).toEqual({});
    expect(later.calls).toHaveLength(0);
    expect(publishesOf(x.fx.calls)).toHaveLength(1);
  });

  it('(c) FIX1-FULLREV(F2 후속2): (a) 경로(계정 사용 중지 → 보내기 직전 approval_missing → UNKNOWN) → 사용자 재확인(후보 1개) → "Threads에서 확인함" → CONFIRMED — 아무도 취소를 요청하지 않았으므로 화면이 "취소 불가(이미 전송됨)"라고 하지 않음', async () => {
    const TEXT = 'F2 후속2 표식 뒤 계정 사용 중지 후 사용자 확인 글.';
    const x = await leasedAfterMarker(TEXT, 'F2b-live-off-confirm');
    const off = await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: false }), ctx(liveAccount));
    try {
      expect(off.status, await off.clone().text()).toBe(200);
      const none = publishFixture(() => ({}));
      expect((await processJob(db, registryWith(none.fetch, x.cfg), x.leased, runOpts(x.cfg))).state).toBe('UNKNOWN');
      expect(none.calls).toHaveLength(0);
    } finally {
      const on = await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: true }), ctx(liveAccount));
      expect(on.status, await on.clone().text()).toBe(200);
    }
    const [stopped] = await jobsOf(x.item.id);
    expect(stopped).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', cancelRequestedAt: null });
    // 사용자 재확인(route 와 같은 reconcileItem — 레지스트리만 fixture 주입): 최근 글 목록에 같은 본문·시도 시각 +30초 글이 정확히 하나 → 확인 후보(미확인)
    const marker = (await db.select().from(schema.remoteSteps).where(and(eq(schema.remoteSteps.jobId, stopped!.id), eq(schema.remoteSteps.kind, 'publish_attempt'))))[0]!;
    const media = nextId();
    const permalink = `https://www.threads.com/@f1tester/post/${media.slice(-6)}`;
    const list = publishFixture(() => ({
      [`GET /v1.0/${PROFILE_ID}/threads`]: () =>
        jsonRes(200, { data: [{ id: media, text: TEXT, timestamp: new Date(marker.createdAt.getTime() + 30_000).toISOString().replace(/\.\d+Z$/, '+0000'), permalink }] }),
    }));
    const rr = await reconcileItem(db, registryWith(list.fetch, x.cfg), owner, x.item.id, { timeoutMs: 5000, credentials: jobCredentials(x.cfg, db) });
    expect(rr).toMatchObject({ state: 'UNKNOWN', found: false, remote: 'unknown', outcome: 'applied' });
    expect(publishesOf(list.calls)).toHaveLength(0);
    // "Threads에서 확인함"(외부 호출 없음) → CONFIRMED·USER_CONFIRMED
    const uc = await userConfirmPOST(post(`/api/distribution-items/${x.item.id}/user-confirm`, { candidate_external_id: `threads:${media}` }), ctx(x.item.id));
    expect(uc.status, await uc.clone().text()).toBe(200);
    expect(await uc.json()).toMatchObject({ state: 'CONFIRMED', verification: 'USER_CONFIRMED' });
    // 계획 페이지와 같은 입력(getPlanDetail): 작업 줄의 "취소 불가(이미 전송됨)"·항목 문구의 cancelTooLate 는 cancelRequestedAt && CONFIRMED 일 때만
    const d = (await getPlanDetail(db, owner, x.planId))!.items[0]!;
    const latest = d.jobs.at(-1)!;
    expect(latest).toMatchObject({ id: stopped!.id, state: 'CONFIRMED', cancelRequestedAt: null });
    expect(!!latest.cancelRequestedAt && latest.state === 'CONFIRMED').toBe(false);
    expect(publishesOf(x.fx.calls)).toHaveLength(1);
  });
});
