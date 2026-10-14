/**
 * LIVE-P1(결정 D38 1단계): 실제 Threads 텍스트 게시 — 승인 → 실행 → 작업 처리기 → 실제 어댑터(주입한 fixture fetch) → publication.
 * **실제 네트워크 호출 0**: 계정 연결(OAuth)은 globalThis.fetch 를 fixture 로 바꾸고(vi.stubGlobal), 게시 어댑터에는 fixture fetch 를 주입한다.
 * 그 밖의 Threads·Meta 요청은 setupFiles 가드가 막는다. 토큰·시크릿·code 는 모두 가짜(FAKE_…), ID 는 가짜 숫자.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  getDb,
  getPlanDetail,
  listAccountHealth,
  listChannelAccounts,
  reconcileItem,
  runJobsTick,
  runRestoreDrill,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { livePublishReadiness, loadConfig, type AppConfig, type Channel } from '@cs/domain';
import {
  createMockAdapterRegistry,
  LiveCapableAdapterRegistry,
  LiveThreadsPublishAdapter,
  LocalStorageAdapter,
  THREADS_LONG_LIVED_URL,
  THREADS_ME_URL,
  THREADS_TOKEN_URL,
} from '@cs/providers';
import { GET as accountsGET, POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as targetPOST } from '../../apps/web/app/api/channel-accounts/[id]/publish-target/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as reconcilePOST } from '../../apps/web/app/api/distribution-items/[id]/reconcile/route';
import { POST as tickPOST } from '../../apps/web/app/api/worker/tick/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { latestThreadsDiag, liveCandidateFromEvents, liveItemHeadline } from '../../apps/web/lib/distribution';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { GET as jobGET } from '../../apps/web/app/api/jobs/[id]/route';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const APP_ID = '000000000000001';
const SECRET = 'FAKE_app_secret_LIVEP1_integration_only';
const SHORT = 'FAKE_short_token_LIVEP1_it_ssssssssssss';
const LONG = 'FAKE_long_token_LIVEP1_it_publish_llllllll';
const REDIRECT = `${BASE}/api/oauth/callback`;
const PROFILE_ID = '17841400000000077';
const MIN = 60_000;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let liveAccount: string;
const mockAcc = {} as Record<Channel, string>;

const OAUTH_ENV = { OAUTH_MODE: 'live', THREADS_APP_ID: APP_ID, THREADS_APP_SECRET: SECRET, OAUTH_REDIRECT_URI: REDIRECT, OAUTH_LIVE_APPROVAL_REF: 'D31' } as const;
const GATE_KEYS = ['PUBLISH_MODE', 'PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_MAX_POSTS'] as const;
const setGates = (g: Partial<Record<(typeof GATE_KEYS)[number], string>>) => {
  for (const k of GATE_KEYS) vi.stubEnv(k, g[k] ?? '');
};
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
const seenResponses: string[] = [];
async function rec(res: Response): Promise<Response> {
  seenResponses.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await res.clone().text()}`);
  return res;
}
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// ---- 실제 게시 fixture(주입 fetch) ----
type Reply = (() => Response | Promise<Response>) | Error; // LIVEP1-TIMEOUT: 지연 응답(Promise)도
interface Call {
  method: string;
  url: URL;
  body: URLSearchParams;
}
let idSeq = 100;
const nextId = () => `18000000000${String(++idSeq).padStart(6, '0')}`;
function publishFixture(routes: (ids: { ct: string; media: string }) => Record<string, Reply | Reply[]>) {
  const ids = { ct: nextId(), media: nextId() };
  const calls: Call[] = [];
  const table = routes(ids);
  const queues = new Map(Object.entries(table).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
    const q = queues.get(`${method} ${url.pathname}`);
    if (!q?.length) throw new Error(`fixture 없음: ${method} ${url.pathname}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    return r();
  });
  return { fetch, calls, ids };
}
const P = (ids: { ct: string; media: string }) => ({
  create: `POST /v1.0/${PROFILE_ID}/threads`,
  status: `GET /v1.0/${ids.ct}`,
  publish: `POST /v1.0/${PROFILE_ID}/threads_publish`,
  read: `GET /v1.0/${ids.media}`,
  list: `GET /v1.0/${PROFILE_ID}/threads`,
});
const permalinkOf = (media: string) => `https://www.threads.com/@livep1tester/post/${media.slice(-6)}`;
const happy = (text: string) => (ids: { ct: string; media: string }) => {
  const p = P(ids);
  return {
    [p.create]: () => jsonRes(200, { id: ids.ct }),
    [p.status]: () => jsonRes(200, { status: 'FINISHED', id: ids.ct }),
    [p.publish]: () => jsonRes(200, { id: ids.media }),
    [p.read]: () => jsonRes(200, { id: ids.media, permalink: permalinkOf(ids.media), text, timestamp: new Date().toISOString().replace(/\.\d+Z$/, '+0000'), media_type: 'TEXT_POST' }),
  } as Record<string, Reply | Reply[]>;
};
const timeoutErr = () => Object.assign(new Error('timeout'), { name: 'TimeoutError' });

/** 시험용 레지스트리: 앱의 모의 싱글턴 + fixture fetch 를 주입한 실제 어댑터. 게이트는 그때의 설정(livePublishReadiness). */
function registryWith(fetch: (input: string, init?: RequestInit) => Promise<Response>, config: AppConfig) {
  const gate = () => livePublishReadiness(config);
  return new LiveCapableAdapterRegistry(createMockAdapterRegistry(), new LiveThreadsPublishAdapter({ gate, fetch, pollIntervalMs: 0 }), gate);
}
let vt = 0;
async function tick(registry: LiveCapableAdapterRegistry, config: AppConfig, advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 'livep1-w',
    config,
    ownerId: owner,
    clock: () => new Date(Date.now() + vt),
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: 20,
    credentials: jobCredentials(config, db),
  });
}

async function reviewVariant(body: string): Promise<string> {
  const { content } = await createContent(db, owner, { title: `LIVE-P1 ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}
interface Planned {
  planId: string;
  items: Array<{ id: string; payload_hash: string; requested_result: string; visibility: string }>;
}
async function planApproved(bodies: string[], accountId = liveAccount, purpose = 'public_publish'): Promise<Planned> {
  const items = [];
  for (const b of bodies) items.push({ variant_id: await reviewVariant(b), channel_account_id: accountId });
  const res = await rec(await plansPOST(post('/api/distribution-plans', { items })));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string; variant_id: string; requested_result: string; visibility: string }> };
  const ordered = items.map((x) => p.items.find((i) => i.variant_id === x.variant_id)!);
  const ap = await rec(
    await approvePOST(
      post(`/api/distribution-plans/${p.plan.id}/approve`, {
        item_ids: ordered.map((i) => i.id),
        expected_hashes: Object.fromEntries(ordered.map((i) => [i.id, i.payload_hash])),
        confirm: true,
        purpose,
      }),
      ctx(p.plan.id),
    ),
  );
  expect(ap.status, await ap.clone().text()).toBe(200);
  return { planId: p.plan.id, items: ordered };
}
const execute = async (planId: string) => rec(await executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId)));
const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const stepsOf = (itemId: string) => db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId)).orderBy(asc(schema.remoteSteps.stepIndex));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const fullCfg = (ref: string, max = '5') => {
  setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: ref, PUBLISH_LIVE_MAX_POSTS: max });
  return loadConfig();
};

/** 실제 Threads 계정(연결 전 행) → 실제 OAuth 연결(fixture) → 실제 게시 계정으로 사용 */
async function connectLiveAccount(): Promise<string> {
  for (const [k, v] of Object.entries(OAUTH_ENV)) vi.stubEnv(k, v);
  const created = await rec(await accountsPOST(post('/api/channel-accounts', { platform: 'threads', kind: 'live' })));
  const { account } = (await created.json()) as { account: { id: string } };
  const c = await rec(await connectPOST(post(`/api/channel-accounts/${account.id}/connect`), ctx(account.id)));
  expect(c.status, await c.clone().text()).toBe(200);
  const state = new URL(((await c.json()) as { authorize_url: string }).authorize_url).searchParams.get('state')!;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(input);
      const key = `${init?.method ?? 'GET'} ${u.origin}${u.pathname}`;
      if (key === `POST ${THREADS_TOKEN_URL}`) return jsonRes(200, { access_token: SHORT, token_type: 'bearer', user_id: 1 });
      if (key === `GET ${THREADS_LONG_LIVED_URL}`) return jsonRes(200, { access_token: LONG, token_type: 'bearer', expires_in: 5184000 });
      if (key === `GET ${THREADS_ME_URL}`) return jsonRes(200, { id: PROFILE_ID, username: 'livep1tester' });
      throw new Error(`fixture 없음: ${key}`);
    }),
  );
  const u = new URL(REDIRECT);
  u.searchParams.set('code', 'FAKE_code_LIVEP1_it_cccccccccccccc');
  u.searchParams.set('state', state);
  const cb = await rec(await callbackGET(new Request(u.toString(), { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(cb.status, await cb.clone().text()).toBe(200);
  vi.unstubAllGlobals();
  for (const k of Object.keys(OAUTH_ENV)) vi.stubEnv(k, '');
  return account.id;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-livep1-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  Object.assign(mockAcc, Object.fromEntries((await listChannelAccounts(db, owner)).map((a) => [a.platform, a.id])));
  token = await login(A);
  liveAccount = await connectLiveAccount();
});
beforeEach(() => {
  setGates({});
});
afterEach(() => {
  vi.unstubAllGlobals();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('실제 게시 계정으로 사용(publish-target) — 외부 호출 없음', () => {
  it('연결만 한 실제 계정은 계획에 못 고른다 → "사용" 뒤 connected, 모의 계정·연결 전 계정은 409', async () => {
    const before = (await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, liveAccount)))[0]!;
    expect(before).toMatchObject({ kind: 'live', state: 'disconnected', externalAccountId: PROFILE_ID, displayName: '@livep1tester' });
    const variant = await reviewVariant('연결만 한 계정으로는 계획을 만들 수 없다.');
    const refused = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variant, channel_account_id: liveAccount }] }));
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('account_not_ready');

    const mock = await rec(await targetPOST(post(`/api/channel-accounts/${mockAcc.threads}/publish-target`, { enabled: true }), ctx(mockAcc.threads)));
    expect(mock.status).toBe(409);
    expect(((await mock.json()) as { error: string }).error).toBe('live_target_not_live_threads');
    const mockOff = await rec(await targetPOST(post(`/api/channel-accounts/${mockAcc.threads}/publish-target`, { enabled: false }), ctx(mockAcc.threads)));
    expect(mockOff.status).toBe(409);
    const pending = (await (await accountsPOST(post('/api/channel-accounts', { platform: 'threads', kind: 'live' }))).json()) as { account: { id: string } };
    const unbound = await rec(await targetPOST(post(`/api/channel-accounts/${pending.account.id}/publish-target`, { enabled: true }), ctx(pending.account.id)));
    expect(unbound.status).toBe(409);
    expect(((await unbound.json()) as { error: string }).error).toBe('live_target_unbound');
    const bad = await rec(await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: 'yes' }), ctx(liveAccount)));
    expect(bad.status).toBe(400);

    const on = await rec(await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: true }), ctx(liveAccount)));
    expect(on.status, await on.clone().text()).toBe(200);
    expect(await on.json()).toMatchObject({ state: 'connected', live_publish_target: true });
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'channel_account.live_publish_target'));
    expect(audit.length).toBeGreaterThan(0);
  });
});

describe('실행 게이트(executePlan — 하나라도 없으면 전체 거부, 작업 없음)', () => {
  it('PUBLISH_MODE disabled → 503 publish_disabled · 승인 기록 없음 → 503 live_publish_not_ready · 게시 수 상한 없음 → 503 · 모두 있음 → LIVE', async () => {
    const p = await planApproved(['게이트 시험 글 하나.']);
    expect(p.items[0]).toMatchObject({ requested_result: 'public_publish', visibility: 'public' });
    setGates({});
    let r = await execute(p.planId);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toBe('publish_disabled');
    setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_MAX_POSTS: '1' });
    r = await execute(p.planId);
    expect(r.status).toBe(503);
    const b1 = (await r.json()) as { error: string; message: string };
    expect(b1.error).toBe('live_publish_not_ready');
    expect(b1.message).toContain('PUBLISH_LIVE_APPROVAL_REF');
    setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'D38-gate' });
    r = await execute(p.planId);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { message: string }).message).toContain('PUBLISH_LIVE_MAX_POSTS');
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, p.items[0]!.id))).toHaveLength(0);
    setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'D38-gate', PUBLISH_LIVE_MAX_POSTS: '1' });
    r = await execute(p.planId);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { mode: string; queued: Array<{ mode: string }>; notice: string };
    expect(body.mode).toBe('LIVE');
    expect(body.queued.map((q) => q.mode)).toEqual(['LIVE']);
    expect(body.notice).toContain('실제 게시');
    // 아직 보내지 않은 작업 — 취소하면 CANCELED(보내지 않음)
    const cn = await rec(await cancelPOST(post(`/api/distribution-items/${p.items[0]!.id}/cancel`), ctx(p.items[0]!.id)));
    expect(await cn.json()).toMatchObject({ state: 'CANCELED', canceled: true });
  });

  it('계획 규칙: 이어지는 글·mock_publish·비공개 → 400(실제 Threads 는 텍스트 1개 public_publish 만)', async () => {
    const two = await reviewVariant('첫 문단.\n\n둘째 문단.');
    let r = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: two, channel_account_id: liveAccount }] }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('live_threads_single_post_only');
    const one = await reviewVariant('글 하나.');
    r = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: one, channel_account_id: liveAccount, requested_result: 'mock_publish' }] }));
    expect(((await r.json()) as { error: string }).error).toBe('live_threads_public_publish_only');
    r = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: one, channel_account_id: liveAccount, visibility: 'private' }] }));
    expect(((await r.json()) as { error: string }).error).toBe('live_threads_visibility_public_only');
  });
});

describe('전체 경로: 승인 → 실행 → 작업 처리기 → 실제 어댑터(fixture) → publication', () => {
  it('성공: CONFIRMED + VERIFIED 실제 결과(threads:<id>·공식 링크), 단계 3개, 전송 의도에 승인 기록, 원격 호출 4번(순서), 비밀 없음', async () => {
    const TEXT = '해외 영업 첫 주, 대리점과 재고 기준부터 맞췄다.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-happy', '1');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture(happy(TEXT));
    const t = await tick(registryWith(fx.fetch, config), config);
    expect(t.results).toEqual({ CONFIRMED: 1 });
    const item = p.items[0]!;
    expect((await itemOf(item.id)).status).toBe('CONFIRMED');
    const [pub] = await pubsOf(item.id);
    expect(pub).toMatchObject({
      isMock: false,
      verification: 'VERIFIED',
      externalId: `threads:${fx.ids.media}`,
      permalink: permalinkOf(fx.ids.media),
      resultKind: 'PUBLISHED',
      remoteVisibility: 'unknown',
    });
    expect(pub!.verifiedAt).not.toBeNull();
    expect((await stepsOf(item.id)).map((s) => `${s.kind}:${s.status}:${s.remoteId}`)).toEqual([
      `container:finished:threads:ct:${fx.ids.ct}`,
      `publish_attempt:created:threads:pa:${fx.ids.ct}`,
      `publish:published:threads:post:${fx.ids.media}`,
    ]);
    const job = await jobOf(item.id);
    const [intent] = await intentsOf(job.id);
    expect(intent!.sanitizedDetails).toMatchObject({ mode: 'LIVE', adapter_id: 'live_threads', live_approval_ref: 'D38-happy' });
    expect(intent!.outcome).toBe('accepted');
    const pth = P(fx.ids);
    expect(fx.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([pth.create, pth.status, pth.publish, pth.read]);
    expect(fx.calls[0]!.body.get('access_token')).toBe(LONG); // 서버 안에서 봉인 해제한 장기 토큰(본문으로만)
    expect(fx.calls[0]!.body.get('text')).toBe(TEXT);
    // 화면 문구(실제 게시)
    const d = await getPlanDetail(db, owner, p.planId);
    const x = d!.items[0]!;
    const headline = liveItemHeadline({ status: x.item.status, channel: 'threads', job: x.jobs.at(-1) ?? null, pub: x.publications[0] ?? null, blockReason: null, verification: x.publications[0]!.verification });
    expect(headline).toContain('실제 게시됨');
    expect(headline).not.toContain('MOCK');
    // 비밀: DB 의 이력·감사·응답에 토큰 없음(봉인 값 제외)
    const events = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id));
    const audits = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.ownerId, owner));
    const dump = JSON.stringify({ events, audits, intent, pub, seenResponses }) + inspect(d, { depth: 8 });
    for (const s of [LONG, SHORT, SECRET]) expect(dump).not.toContain(s);
  });

  it('복원 훈련(내보내기 → 빈 DB 복원 → 비교): 실제 결과·실제 단계 ID 가 묶음 규칙·DB 트리거를 통과', async () => {
    const r = await runRestoreDrill(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { trigger: 'test', tmpRoot: tmp });
    expect(r.mismatches).toEqual([]);
    expect(r.result).toBe('pass');
  });

  it('전송 직전 게이트(beginSend): 대기열에 들어간 뒤 승인 기록이 빠지면 보내지 않고 BLOCKED, 원격 호출 0·전송 의도 0 → 조건을 갖추고 재시도하면 게시', async () => {
    const TEXT = '전송 직전 게이트 시험 글.';
    const p = await planApproved([TEXT]);
    const full = fullCfg('D38-begin', '3');
    expect((await execute(p.planId)).status).toBe(200);
    setGates({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_MAX_POSTS: '3' });
    const missing = loadConfig();
    const fx = publishFixture(happy(TEXT));
    const t = await tick(registryWith(fx.fetch, missing), missing);
    expect(t.results).toEqual({ BLOCKED: 1 });
    const job = await jobOf(p.items[0]!.id);
    expect(job.lastErrorCode).toBe('live_publish_not_ready');
    expect(await intentsOf(job.id)).toHaveLength(0);
    expect(fx.calls).toHaveLength(0);
    // PUBLISH_MODE 를 끄고 다시 실행해도 같은 규칙(publish_disabled)
    fullCfg('D38-begin', '3');
    const rt = await rec(await retryPOST(post(`/api/distribution-items/${p.items[0]!.id}/retry`), ctx(p.items[0]!.id)));
    expect(rt.status, await rt.clone().text()).toBe(200);
    expect(((await rt.json()) as { message: string }).message).toContain('실제 게시');
    const t2 = await tick(registryWith(fx.fetch, full), full);
    expect(t2.results).toEqual({ CONFIRMED: 1 });
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });

  it('게시 수 상한: 같은 승인 기록으로 이미 쓴 수 + 이번 > 상한 → 실행 429(작업 없음) · 전송 직전에 상한이 줄면 둘째는 BLOCKED(보내지 않음)', async () => {
    // 'D38-happy' 는 앞 시험에서 1건을 썼다(상한 1)
    const p = await planApproved(['상한 시험 글.']);
    fullCfg('D38-happy', '1');
    const r = await execute(p.planId);
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: 'live_publish_limit', limit: 1, used: 1 });
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, p.items[0]!.id))).toHaveLength(0);
    // 두 항목을 상한 2 로 넣고, 전송 직전에 상한을 1 로 줄인다 → 첫째만 게시
    const two = await planApproved(['상한 둘 중 첫째.', '상한 둘 중 둘째.']);
    fullCfg('D38-limit', '2');
    expect((await execute(two.planId)).status).toBe(200);
    const one = fullCfg('D38-limit', '1');
    const fxs = [publishFixture(happy('상한 둘 중 첫째.')), publishFixture(happy('상한 둘 중 둘째.'))];
    // 어느 항목이 먼저 처리될지 모르므로 두 fixture 를 경로로 합친다
    const merged = vi.fn(async (input: string, init?: RequestInit) => {
      for (const f of fxs) {
        try {
          return await f.fetch(input, init);
        } catch {
          // 다음 fixture
        }
      }
      throw new Error('fixture 없음');
    });
    const t = await tick(registryWith(merged, one), one);
    expect(t.results).toEqual({ CONFIRMED: 1, BLOCKED: 1 });
    const states = await Promise.all(two.items.map(async (i) => (await jobOf(i.id)).lastErrorCode));
    expect(states.filter((s) => s === 'live_publish_limit')).toHaveLength(1);
    const publishes = fxs.flatMap((f) => f.calls).filter((c) => c.method === 'POST' && c.url.pathname.endsWith('threads_publish'));
    expect(publishes).toHaveLength(1);
    const blocked = two.items.find((_, k) => states[k] === 'live_publish_limit')!;
    const cn = await rec(await cancelPOST(post(`/api/distribution-items/${blocked.id}/cancel`), ctx(blocked.id)));
    expect(await cn.json()).toMatchObject({ state: 'CANCELED' });
  });
});

describe('모의 계정은 그대로(실제 게시 조건이 모두 있어도 MOCK)', () => {
  it('seed 모의 Threads 계정: mock_publish → MOCK 실행 → 모의 결과(실제 호출 0)', async () => {
    const p = await planApproved(['모의 계정 글.'], mockAcc.threads, 'mock_publish');
    const config = fullCfg('D38-mock', '1');
    const r = await execute(p.planId);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { mode: string }).mode).toBe('MOCK');
    const fx = publishFixture(happy('x'));
    expect((await tick(registryWith(fx.fetch, config), config)).results).toEqual({ CONFIRMED: 1 });
    const [pub] = await pubsOf(p.items[0]!.id);
    expect(pub).toMatchObject({ isMock: true, verification: 'MOCK' });
    expect(pub!.externalId.startsWith('mock:')).toBe(true);
    expect(fx.calls).toHaveLength(0);
    const [intent] = await intentsOf((await jobOf(p.items[0]!.id)).id);
    expect(intent!.sanitizedDetails.live_approval_ref).toBeUndefined();
    // LIVEP1-DIAG: 모의 계획 API 의 mode 는 그대로 MOCK
    const g = (await (await planGET(new Request(`${BASE}/api/distribution-plans/${p.planId}`, { headers: { accept: 'application/json', ...cookieHeader(token) } }), ctx(p.planId))).json()) as {
      mode: string;
      items: Array<{ mode: string; jobs: Array<{ mode: string }> }>;
    };
    expect(g.mode).toBe('MOCK');
    expect(g.items[0]!.mode).toBe('MOCK');
    expect(g.items[0]!.jobs.map((j) => j.mode)).toEqual(['MOCK']);
  });
});

describe('LIVEP1-DIAG: 실제 실패 진단 · mode 표시 · 실패 뒤 다시 게시하는 길', () => {
  it('컨테이너 생성 403(code 10) → FAILED + 허용 목록 진단(이력·전송 의도·작업 API·화면 줄), 문구·토큰 없음 · 계획/작업 API mode LIVE · 재시도 409 → 같은 파생본 새 계획: 같은 승인 기록·상한 1 이면 429, 새 승인 기록이면 게시', async () => {
    const TEXT = '진단 시험 글.';
    const p = await planApproved([TEXT]);
    const item = p.items[0]!;
    const config = fullCfg('D38-diag', '1');
    expect((await execute(p.planId)).status).toBe(200);
    const USER_MSG = `이 작업을 할 권한이 없습니다 ${LONG}`;
    const fx = publishFixture((ids) => ({
      [P(ids).create]: () =>
        jsonRes(403, {
          error: {
            message: `(#10) Application does not have permission for this action access_token=${LONG}`,
            type: 'OAuthException',
            code: 10,
            error_subcode: 2207051,
            is_transient: false,
            error_user_title: USER_MSG,
            error_user_msg: USER_MSG,
            fbtrace_id: 'AbCdEf_123-x',
          },
        }),
    }));
    expect((await tick(registryWith(fx.fetch, config), config)).results).toEqual({ FAILED: 1 });
    const job = await jobOf(item.id);
    expect(job.lastErrorCode).toBe('container_permission_denied');
    const DIAG = { op: 'create', http_status: 403, code: 10, error_subcode: 2207051, error_type: 'OAuthException', is_transient: false, fbtrace_id: 'AbCdEf_123-x' };
    const events = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id));
    expect(events.find((e) => e.sanitizedDetails.provider_diag)!.sanitizedDetails.provider_diag).toEqual(DIAG);
    const [intent] = await intentsOf(job.id);
    expect(intent!.sanitizedDetails.provider_diag).toEqual(DIAG);
    // 작업 API(GET /api/jobs/{id}) — 진단 숫자는 보이고 문구·토큰은 없다, mode LIVE
    const jr = await rec(await jobGET(new Request(`${BASE}/api/jobs/${job.id}`, { headers: { accept: 'application/json', ...cookieHeader(token) } }), ctx(job.id)));
    const jText = await jr.clone().text();
    const jBody = (await jr.json()) as { job: { mode: string }; events: Array<{ details: Record<string, unknown> }> };
    expect(jBody.job.mode).toBe('LIVE');
    expect(jBody.events.map((e) => e.details.provider_diag).filter(Boolean)).toContainEqual(DIAG);
    // 계획 API — 실제 항목은 mode LIVE(계획·항목·작업)
    const pr = await rec(await planGET(new Request(`${BASE}/api/distribution-plans/${p.planId}`, { headers: { accept: 'application/json', ...cookieHeader(token) } }), ctx(p.planId)));
    const pText = await pr.clone().text();
    const pBody = (await pr.json()) as { mode: string; items: Array<{ mode: string; jobs: Array<{ mode: string }>; account: { capability_snapshot: Record<string, unknown> } }> };
    expect(pBody.mode).toBe('LIVE');
    expect(pBody.items[0]!.mode).toBe('LIVE');
    expect(pBody.items[0]!.jobs.map((j) => j.mode)).toEqual(['LIVE']);
    // capability_snapshot(표시용): 실제 게시 계정으로 사용 중 → D38 실제 텍스트 게시
    expect(pBody.items[0]!.account.capability_snapshot).toMatchObject({ mock: false, external_writes: true, publish: 'live_text_D38' });
    // 화면 줄(카드와 같은 도우미)
    const d = await getPlanDetail(db, owner, p.planId);
    const line = latestThreadsDiag(d!.items[0]!.events);
    expect(line).toBe('Threads 오류 코드: 컨테이너 생성 · HTTP 403 · code 10 · subcode 2207051 · OAuthException · is_transient=false · fbtrace AbCdEf_123-x');
    // 문구·사용자 문구·토큰이 이력·의도·API·화면 어디에도 없다
    const dump = JSON.stringify({ events, intent, jText, pText, line, seenResponses });
    for (const s of [LONG, 'Application does not have permission', '권한이 없습니다', 'access_token']) expect(dump).not.toContain(s);

    // 3) FAILED(컨테이너 단계 확정 실패, 게시 시도 없음)는 재시도 대상이 아니다(보류 BLOCKED 만) — 409
    expect((await rec(await retryPOST(post(`/api/distribution-items/${item.id}/retry`), ctx(item.id)))).status).toBe(409);
    expect(await stepsOf(item.id)).toEqual([]); // 컨테이너도 기록되지 않음(생성 실패)
    // 같은 파생본으로 새 계획 — 승인된 파생본도 계획 가능
    const variantId = (await itemOf(item.id)).variantId;
    const created = await rec(await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variantId, channel_account_id: liveAccount }] })));
    expect(created.status, await created.clone().text()).toBe(201);
    const np = (await created.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
    const ni = np.items[0]!;
    expect(
      (await approvePOST(post(`/api/distribution-plans/${np.plan.id}/approve`, { item_ids: [ni.id], expected_hashes: { [ni.id]: ni.payload_hash }, confirm: true, purpose: 'public_publish' }), ctx(np.plan.id))).status,
    ).toBe(200);
    // 실패한 시도도 그 승인 기록의 게시 수를 썼다(전송 의도가 생김) — 같은 승인 기록·상한 1 이면 실행 거부(429, 작업 없음)
    const sameRef = await execute(np.plan.id);
    expect(sameRef.status).toBe(429);
    expect(await sameRef.json()).toMatchObject({ error: 'live_publish_limit', limit: 1, used: 1 });
    // 새 승인 기록(사용자가 새로 승인) — 실행·게시
    const cfg2 = fullCfg('D38-diag-retry', '1');
    expect((await execute(np.plan.id)).status).toBe(200);
    const fx2 = publishFixture(happy(TEXT));
    expect((await tick(registryWith(fx2.fetch, cfg2), cfg2)).results).toEqual({ CONFIRMED: 1 });
    expect(await pubsOf(ni.id)).toHaveLength(1);
  });
});

describe('결과 불명 — 맹목 재게시 없음(AGENTS 불변식)', () => {
  // FIX-LIVEP1(Codex P0): 목록의 같은 본문은 확인 후보일 뿐 — 결과(publication)·게시 단계·VERIFIED 없이 UNKNOWN 으로 끝난다.
  it('게시 시간 초과 → 목록에 같은 본문 1개 → 확인 후보만 이력에 남고 UNKNOWN(결과·게시 단계·VERIFIED 없음, 재게시 0) → 실제 재확인 POST route(연결 정보 전달)도 조회만', async () => {
    const TEXT = '시간 초과 뒤 목록에 보이는 글.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-timeout-found', '2');
    expect((await execute(p.planId)).status).toBe(200);
    // FIX2-LIVEP1(Codex P2): 목록의 게시 시각은 재확인 시계와 분리 — 게시 시도 표식 시각(DB created_at)에 고정한다. 시도 +30초의 글은 후보,
    // 시도 +50분에 따로 올린 같은 글은(재확인이 1시간 뒤여도) 창 밖이라 후보 수에 들지 않는다.
    let attemptAt = 0;
    const ts = (ms: number) => new Date(ms).toISOString().replace('Z', '+0000');
    const listRoute = (ids: { ct: string; media: string }) => () =>
      jsonRes(200, {
        data: [
          { id: ids.media, text: TEXT, timestamp: ts(attemptAt + 30_000), permalink: permalinkOf(ids.media) },
          { id: '18000000000999998', text: TEXT, timestamp: ts(attemptAt + 50 * MIN), permalink: permalinkOf('18000000000999998') },
          { id: '18000000000999999', text: '다른 글', timestamp: ts(attemptAt) },
        ],
      });
    const fx = publishFixture((ids) => ({ ...happy(TEXT)(ids), [P(ids).publish]: timeoutErr(), [P(ids).list]: listRoute(ids) }));
    const reg = registryWith(fx.fetch, config);
    expect((await tick(reg, config)).results).toEqual({ RECONCILING: 1 });
    const item = p.items[0]!;
    attemptAt = (await stepsOf(item.id)).find((st) => st.kind === 'publish_attempt')!.createdAt.getTime();
    let last: Record<string, number> = {};
    for (let i = 0; i < 4 && !last.UNKNOWN; i++) last = (await tick(reg, config, 20 * MIN)).results; // 재확인은 20·40·60분 뒤
    expect(last).toEqual({ UNKNOWN: 1 });
    expect((await itemOf(item.id)).status).toBe('UNKNOWN');
    expect(await pubsOf(item.id)).toHaveLength(0);
    expect((await stepsOf(item.id)).map((st) => st.kind)).toEqual(['container', 'publish_attempt']);
    const job = await jobOf(item.id);
    const events = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, job.id));
    const withCandidate = events.filter((e) => e.sanitizedDetails.candidate_external_id === `threads:${fx.ids.media}`);
    expect(withCandidate.length).toBeGreaterThan(0);
    expect(withCandidate.at(-1)!.sanitizedDetails.candidate_permalink).toBe(permalinkOf(fx.ids.media));
    // 화면: UNKNOWN 안내 + 확인 후보(미확인) — 결과로 쓰지 않음
    const d = await getPlanDetail(db, owner, p.planId);
    const x = d!.items[0]!;
    expect(liveCandidateFromEvents(x.events)).toEqual({ externalId: `threads:${fx.ids.media}`, permalink: permalinkOf(fx.ids.media) });
    expect(liveItemHeadline({ status: x.item.status, channel: 'threads', job: x.jobs.at(-1) ?? null, pub: null, blockReason: null })).toContain('결과 불명');

    // 실제 재확인 POST route(앱 레지스트리 — 실제 어댑터는 호출 시점의 전역 fetch 를 쓴다): 전역 fetch 를 fixture 로 바꿔 경로 전체를 통과시킨다.
    const routeCalls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input);
        routeCalls.push({ method: init?.method ?? 'GET', url, body: new URLSearchParams(typeof init?.body === 'string' ? init.body : '') });
        if ((init?.method ?? 'GET') === 'GET' && url.pathname === `/v1.0/${PROFILE_ID}/threads`) return listRoute(fx.ids)();
        throw new Error(`fixture 없음: ${url.pathname}`);
      }),
    );
    const rr = await rec(await reconcilePOST(post(`/api/distribution-items/${item.id}/reconcile`), ctx(item.id)));
    expect(rr.status, await rr.clone().text()).toBe(200);
    expect(await rr.json()).toMatchObject({ state: 'UNKNOWN', found: false, remote: 'unknown', outcome: 'applied' });
    expect(routeCalls.map((c) => `${c.method} ${c.url.origin}${c.url.pathname}`)).toEqual([`GET https://graph.threads.net/v1.0/${PROFILE_ID}/threads`]);
    expect(routeCalls[0]!.url.searchParams.get('access_token')).toBe(LONG); // 서버 안에서 봉인 해제한 연결 정보가 route 경로로 전달됨
    expect((await itemOf(item.id)).status).toBe('UNKNOWN');
    expect(await pubsOf(item.id)).toHaveLength(0);
    vi.unstubAllGlobals();
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
    // 응답·이력 어디에도 토큰 없음
    expect(JSON.stringify({ seenResponses, events })).not.toContain(LONG);
  });

  it('게시 5xx → 목록에 없음 → 확인 3회 뒤 UNKNOWN(재게시 0), 사용자 재확인은 조회만, 재시도 409, 취소 409 — 화면 안내', async () => {
    const TEXT = '목록에서 찾을 수 없는 글.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-timeout-unknown', '2');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => {
      const pth = P(ids);
      return {
        ...happy(TEXT)(ids),
        [pth.publish]: () => jsonRes(503, { error: { code: 2, message: `Service unavailable ${LONG}` } }),
        [pth.list]: () => jsonRes(200, { data: [{ id: '18000000000888888', text: '다른 글', timestamp: new Date().toISOString().replace(/\.\d+Z$/, '+0000') }] }),
      };
    });
    const reg = registryWith(fx.fetch, config);
    expect((await tick(reg, config)).results).toEqual({ RECONCILING: 1 });
    let last: Record<string, number> = {};
    for (let i = 0; i < 4 && !last.UNKNOWN; i++) last = (await tick(reg, config, 20 * MIN)).results;
    expect(last).toEqual({ UNKNOWN: 1 });
    const item = p.items[0]!;
    expect((await itemOf(item.id)).status).toBe('UNKNOWN');
    expect(await pubsOf(item.id)).toHaveLength(0);
    // 사용자 재확인(route 와 같은 reconcileItem — 레지스트리만 fixture 주입) — 조회만, 찾지 못하면 상태 그대로(UNKNOWN), 재게시 없음
    const rr = await reconcileItem(db, reg, owner, item.id, { timeoutMs: 5000, credentials: jobCredentials(config, db) });
    expect(rr).toMatchObject({ state: 'UNKNOWN', found: false, remote: 'unknown', outcome: 'applied' });
    const rt = await retryPOST(post(`/api/distribution-items/${item.id}/retry`), ctx(item.id));
    expect(rt.status).toBe(409);
    const cn = await cancelPOST(post(`/api/distribution-items/${item.id}/cancel`), ctx(item.id));
    expect(cn.status).toBe(409);
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
    expect(fx.calls.filter((c) => c.method === 'GET' && c.url.pathname === `/v1.0/${PROFILE_ID}/threads`).length).toBeGreaterThanOrEqual(3);
    const d = await getPlanDetail(db, owner, p.planId);
    const x = d!.items[0]!;
    expect(liveItemHeadline({ status: x.item.status, channel: 'threads', job: x.jobs.at(-1) ?? null, pub: null, blockReason: null })).toContain('Threads 앱·웹에서');
  });

  it('게이트가 닫힌 뒤의 조회는 네트워크 없이 unknown(실제 게시 조건이 없으면 실제 호출 0)', async () => {
    const TEXT = '조회 게이트 시험 글.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-recon-gate', '2');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => ({ ...happy(TEXT)(ids), [P(ids).publish]: timeoutErr() }));
    expect((await tick(registryWith(fx.fetch, config), config)).results).toEqual({ RECONCILING: 1 });
    setGates({});
    const closed = loadConfig();
    const n = fx.calls.length;
    await tick(registryWith(fx.fetch, closed), closed, 11_000);
    expect(fx.calls.length).toBe(n);
    expect((await jobOf(p.items[0]!.id)).state).toBe('RECONCILING');
  });
});

describe('FIX2-LIVEP1: 게시 성공 응답 뒤 게시 단계 저장 실패', () => {
  it('threads_publish 성공 응답을 받았지만 게시 단계 기록이 실패 → 결과 불명(RECONCILING) → 표식만 있고 게시 기록 없음 → UNKNOWN, 재게시 0', async () => {
    const TEXT = '게시 단계 저장 실패 시험 글.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-step-fail', '5');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => ({ ...happy(TEXT)(ids), [P(ids).list]: () => jsonRes(200, { data: [] }) }));
    const gate = () => livePublishReadiness(config);
    /** 게시(publish) 단계 기록만 실패시키는 어댑터(작업 처리기의 단계 창구를 감싼다) — 그 밖은 실제 어댑터 그대로 */
    class FailPublishStep extends LiveThreadsPublishAdapter {
      override submit(prepared: Parameters<LiveThreadsPublishAdapter['submit']>[0], ctx: Parameters<LiveThreadsPublishAdapter['submit']>[1]) {
        const steps = ctx.steps!;
        return super.submit(prepared, {
          ...ctx,
          steps: { list: () => steps.list(), record: (st) => (st.kind === 'publish' ? Promise.reject(new Error('db down')) : steps.record(st)) },
        });
      }
    }
    const reg = new LiveCapableAdapterRegistry(createMockAdapterRegistry(), new FailPublishStep({ gate, fetch: fx.fetch, pollIntervalMs: 0 }), gate);
    expect((await tick(reg, config)).results).toEqual({ RECONCILING: 1 });
    const item = p.items[0]!;
    expect((await stepsOf(item.id)).map((st) => st.kind)).toEqual(['container', 'publish_attempt']);
    // (앞 시험이 남긴 다른 계획의 조회 작업도 같은 tick 에서 처리될 수 있어 항목 상태로 판단한다)
    for (let i = 0; i < 4 && (await itemOf(item.id)).status !== 'UNKNOWN'; i++) await tick(reg, config, 20 * MIN);
    expect((await itemOf(item.id)).status).toBe('UNKNOWN');
    expect(await pubsOf(item.id)).toHaveLength(0);
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
    // 재시도도 막힌다(결과 불명) — 다시 게시하지 않는다
    expect((await retryPOST(post(`/api/distribution-items/${item.id}/retry`), ctx(item.id))).status).toBe(409);
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });
});

// FIX-LIVEP1-DIAG(Codex P1 live-publish.ts:96): 이 변경 전에 이미 "실제 게시 계정으로 사용"(connected)이 된 실제 계정은 저장된 표시용 snapshot 이
// 옛 D31 값 그대로다. 다시 누르지 않아도 화면·API 는 지금 상태(kind·platform·state)로 계산한 D38 표시를 보여야 한다(저장값은 이력으로 그대로).
describe('FIX-LIVEP1-DIAG: 이미 사용 중이던 실제 계정의 표시(다시 누르지 않음)', () => {
  it('connected + 옛 D31 snapshot 그대로인 실제 Threads 계정 → 계정 API·설정 화면 데이터는 D38 실제 텍스트 게시, 저장값은 그대로', async () => {
    const OLD = { mock: false, external_writes: false, publish: 'out_of_scope_D31', note: '실제 계정 — 연결·프로필 조회만(D31), 게시 안 함' };
    const [acc] = await db
      .insert(schema.channelAccounts)
      .values({ ownerId: owner, platform: 'threads', kind: 'live', externalAccountId: '17841400000000099', displayName: '@legacy', state: 'connected', credentialState: 'linked', capabilitySnapshot: OLD })
      .returning();
    const list = (await (await accountsGET(new Request(`${BASE}/api/channel-accounts`, { headers: { accept: 'application/json', ...cookieHeader(token) } }), undefined)).json()) as {
      items: Array<{ id: string; capability_snapshot: Record<string, unknown>; capability_snapshot_stored: Record<string, unknown> }>;
    };
    const v = list.items.find((x) => x.id === acc!.id)!;
    expect(v.capability_snapshot).toMatchObject({ mock: false, external_writes: true, publish: 'live_text_D38' });
    expect(v.capability_snapshot_stored).toEqual(OLD);
    // 설정 화면(같은 데이터): 연결 상태 안내도 "실제 게시 계정으로 사용 중"
    const health = (await listAccountHealth(db, owner)).find((h) => h.account_id === acc!.id)!;
    expect(health.notice).toContain('실제 게시 계정으로 사용 중');
    expect(health.live_publish_target).toBe(true);
    // 저장된 행은 바꾸지 않았다(내보내기·이력 형식 그대로)
    expect((await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, acc!.id)))[0]!.capabilitySnapshot).toEqual(OLD);
    // 사용 안 함(disconnected)이면 저장값이 무엇이든 D31(연결만) 표시
    await db.update(schema.channelAccounts).set({ state: 'disconnected', capabilitySnapshot: { mock: false, external_writes: true, publish: 'live_text_D38' } }).where(eq(schema.channelAccounts.id, acc!.id));
    const list2 = (await (await accountsGET(new Request(`${BASE}/api/channel-accounts`, { headers: { accept: 'application/json', ...cookieHeader(token) } }), undefined)).json()) as {
      items: Array<{ id: string; capability_snapshot: Record<string, unknown> }>;
    };
    expect(list2.items.find((x) => x.id === acc!.id)!.capability_snapshot).toEqual(OLD);
  });
});

// LIVEP1-TIMEOUT(D38 2단계 실제 실행: 폼 tick 10초 예산 안에서 컨테이너 ~5초 + 상태 ~1.5초 + 게시 뒤 시간 초과 → 게시됐는데 UNKNOWN).
// 실제 Threads 작업은 실제 지연에 맞는 전송 예산(기본 60초)을 쓰고, 표식 전에 남은 시간이 모자라면 보내지 않고 멈춘다.
const delayed = (ms: number, make: () => Response) => () => new Promise<Response>((resolve) => setTimeout(() => resolve(make()), ms));
describe('LIVEP1-TIMEOUT: 실제 지연에서도 한 번의 폼 tick 안에 끝남', () => {
  it('화면 버튼(폼 tick, 10초 예산): 컨테이너 5초 + 상태 1.5초 + 게시 3초 + 읽기 1초 → 한 번에 CONFIRMED(결과 불명 아님)', async () => {
    const TEXT = '지연 시험 글.';
    const p = await planApproved([TEXT]);
    fullCfg('D38-latency', '3');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => {
      const h = happy(TEXT)(ids);
      const pth = P(ids);
      return {
        [pth.create]: delayed(5000, h[pth.create] as () => Response),
        [pth.status]: delayed(1500, h[pth.status] as () => Response),
        [pth.publish]: delayed(3000, h[pth.publish] as () => Response),
        [pth.read]: delayed(1000, h[pth.read] as () => Response),
      };
    });
    vi.stubGlobal('fetch', fx.fetch);
    const form = new Request(`${BASE}/api/worker/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: BASE, ...cookieHeader(token) },
      body: new URLSearchParams({ plan_id: p.planId, max_jobs: '5' }).toString(),
    });
    const started = Date.now();
    const r = await tickPOST(form);
    expect(r.status).toBe(303);
    expect(Date.now() - started).toBeGreaterThan(10_000); // 폼 예산(10초)을 넘는 실제 지연이었다
    vi.unstubAllGlobals();
    const item = p.items[0]!;
    expect((await itemOf(item.id)).status).toBe('CONFIRMED');
    expect((await pubsOf(item.id))[0]).toMatchObject({ isMock: false, externalId: `threads:${fx.ids.media}`, verification: 'VERIFIED' });
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });

  it('남은 예산이 게시 호출 시간 제한 + 여유보다 적으면 표식 전에 멈춤(보내지 않음 → RETRY_WAIT, threads_publish 0번) → 다음 시도가 같은 컨테이너로 게시', async () => {
    const TEXT = '예산 부족 시험 글.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-budget', '3');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => {
      const h = happy(TEXT)(ids);
      const pth = P(ids);
      return { ...h, [pth.create]: delayed(5000, h[pth.create] as () => Response) };
    });
    const reg = registryWith(fx.fetch, config);
    const run = (budget: number) =>
      runJobsTick(db, reg, { workerId: 'budget-w', config, ownerId: owner, planId: p.planId, clock: () => new Date(Date.now() + vt), random: () => 0.5, submitTimeoutMs: 5000, liveSubmitTimeoutMs: budget, maxJobs: 5, credentials: jobCredentials(config, db) });
    // 예산 13초: 컨테이너 5초 뒤 남은 약 8초 < 게시 호출 10초 + 여유 2초 → 표식 전에 멈춤
    expect((await run(13_000)).results).toEqual({ RETRY_WAIT: 1 });
    const item = p.items[0]!;
    const job = await jobOf(item.id);
    expect(job.lastErrorCode).toBe('publish_budget_insufficient');
    expect((await stepsOf(item.id)).map((st) => `${st.kind}:${st.status}`)).toEqual(['container:finished']);
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(0);
    // 다음 시도(재시도 시각 뒤, 기본 예산) — 같은 컨테이너로 게시
    vt += 20 * MIN;
    expect((await run(60_000)).results).toEqual({ CONFIRMED: 1 });
    expect(fx.calls.filter((c) => c.method === 'POST' && c.url.pathname === `/v1.0/${PROFILE_ID}/threads`)).toHaveLength(1);
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });
});

describe('FIX-LIVEP1: 계획 범위 작업 처리·동시 실행·실제 게시 계정 사용 확인', () => {
  it('계획 화면 버튼(폼 plan_id)은 그 계획의 작업만 처리 — 다른 계획의 실제 게시 작업은 그대로(실제 호출 0)', async () => {
    const live = await planApproved(['다른 계획의 실제 게시 글.']);
    fullCfg('D38-scope', '3');
    expect((await execute(live.planId)).status).toBe(200);
    const mock = await planApproved(['모의 계획 글.'], mockAcc.threads, 'mock_publish');
    expect((await execute(mock.planId)).status).toBe(200);
    let globalCalls = 0;
    vi.stubGlobal('fetch', async () => {
      globalCalls++;
      throw new Error('network forbidden');
    });
    const form = new Request(`${BASE}/api/worker/tick`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: BASE, ...cookieHeader(token) },
      body: new URLSearchParams({ plan_id: mock.planId, max_jobs: '5' }).toString(),
    });
    const r = await tickPOST(form);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/distribute/${mock.planId}?ticked=1`);
    expect((await itemOf(mock.items[0]!.id)).status).toBe('CONFIRMED');
    expect((await jobOf(live.items[0]!.id)).state).toBe('QUEUED');
    expect(globalCalls).toBe(0);
    vi.unstubAllGlobals();
    const cn = await rec(await cancelPOST(post(`/api/distribution-items/${live.items[0]!.id}/cancel`), ctx(live.items[0]!.id)));
    expect(await cn.json()).toMatchObject({ state: 'CANCELED' });
  });

  it('동시 실행(PGlite 한 연결): 같은 작업을 두 작업 처리기가 동시에 돌려도 threads_publish 1번', async () => {
    const TEXT = '동시 실행 같은 작업 글.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-conc-same', '3');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture(happy(TEXT));
    const reg = registryWith(fx.fetch, config);
    const run = (w: string) =>
      runJobsTick(db, reg, { workerId: w, config, ownerId: owner, clock: () => new Date(Date.now() + vt), random: () => 0.5, submitTimeoutMs: 5000, maxJobs: 5, credentials: jobCredentials(config, db) });
    const [a, b] = await Promise.all([run('conc-a'), run('conc-b')]);
    expect((a.results.CONFIRMED ?? 0) + (b.results.CONFIRMED ?? 0)).toBe(1);
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });

  it('동시 실행(PGlite 한 연결): PUBLISH_LIVE_MAX_POSTS=1 에서 두 작업을 두 작업 처리기가 동시에 처리해도 threads_publish 1번, 나머지는 보류(보내지 않음)', async () => {
    const two = await planApproved(['동시 상한 첫째 글.', '동시 상한 둘째 글.']);
    fullCfg('D38-conc-limit', '5'); // 실행 앞선 검사는 다른 계획의 진행 중 실제 작업도 보수적으로 센다
    expect((await execute(two.planId)).status).toBe(200);
    const one = fullCfg('D38-conc-limit', '1');
    const fx = publishFixture(happy('동시 상한 첫째 글.'));
    const reg = registryWith(fx.fetch, one);
    const run = (w: string) =>
      runJobsTick(db, reg, { workerId: w, config: one, ownerId: owner, clock: () => new Date(Date.now() + vt), random: () => 0.5, submitTimeoutMs: 5000, maxJobs: 1, credentials: jobCredentials(one, db) });
    await Promise.all([run('lim-a'), run('lim-b')]);
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
    const codes = await Promise.all(two.items.map(async (i) => (await jobOf(i.id)).lastErrorCode));
    expect(codes.filter((c) => c === 'live_publish_limit')).toHaveLength(1);
    const blocked = two.items[codes.indexOf('live_publish_limit')]!;
    expect(await intentsOf((await jobOf(blocked.id)).id)).toHaveLength(0);
    const cn = await rec(await cancelPOST(post(`/api/distribution-items/${blocked.id}/cancel`), ctx(blocked.id)));
    expect(await cn.json()).toMatchObject({ state: 'CANCELED' });
  });

  it('실제 게시 계정으로 사용: 연결 정보가 쓸 수 없으면(만료) 409 이고 상태는 그대로(확인·변경이 한 트랜잭션)', async () => {
    const off = await rec(await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: false }), ctx(liveAccount)));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ state: 'disconnected' });
    // LIVEP1-DIAG: 사용 중지 → capability_snapshot 은 D31(연결만)로 되돌린다(표시용 — 게이트 아님)
    expect((await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, liveAccount)))[0]!.capabilitySnapshot).toEqual({
      mock: false,
      external_writes: false,
      publish: 'out_of_scope_D31',
      note: '실제 계정 — 연결·프로필 조회만(D31), 게시 안 함',
    });
    await db.update(schema.oauthCredentials).set({ expiresAt: new Date(Date.now() - MIN) }).where(eq(schema.oauthCredentials.channelAccountId, liveAccount));
    const on = await rec(await targetPOST(post(`/api/channel-accounts/${liveAccount}/publish-target`, { enabled: true }), ctx(liveAccount)));
    expect(on.status).toBe(409);
    expect(((await on.json()) as { error: string }).error).toBe('live_target_credential_unusable');
    expect((await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, liveAccount)))[0]!.state).toBe('disconnected');
  });
});
