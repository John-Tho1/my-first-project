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
import { POST as accountsPOST } from '../../apps/web/app/api/channel-accounts/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as targetPOST } from '../../apps/web/app/api/channel-accounts/[id]/publish-target/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { liveItemHeadline } from '../../apps/web/lib/distribution';
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
type Reply = (() => Response) | Error;
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
  });
});

describe('결과 불명 — 맹목 재게시 없음(AGENTS 불변식)', () => {
  it('게시 시간 초과 → RECONCILING → 목록에서 같은 본문 정확히 1개 → CONFIRMED(재게시 0)', async () => {
    const TEXT = '시간 초과 뒤 목록으로 확인되는 글.';
    const p = await planApproved([TEXT]);
    const config = fullCfg('D38-timeout-found', '2');
    expect((await execute(p.planId)).status).toBe(200);
    const fx = publishFixture((ids) => {
      const pth = P(ids);
      return {
        ...happy(TEXT)(ids),
        [pth.publish]: timeoutErr(),
        [pth.list]: () =>
          jsonRes(200, {
            data: [
              { id: ids.media, text: TEXT, timestamp: new Date(Date.now() + vt).toISOString().replace(/\.\d+Z$/, '+0000'), permalink: permalinkOf(ids.media) },
              { id: '18000000000999999', text: '다른 글', timestamp: new Date().toISOString().replace(/\.\d+Z$/, '+0000') },
            ],
          }),
      };
    });
    const reg = registryWith(fx.fetch, config);
    expect((await tick(reg, config)).results).toEqual({ RECONCILING: 1 });
    const item = p.items[0]!;
    expect((await stepsOf(item.id)).map((s) => s.kind)).toEqual(['container', 'publish_attempt']);
    expect((await tick(reg, config, 11_000)).results).toEqual({ CONFIRMED: 1 });
    const [pub] = await pubsOf(item.id);
    expect(pub).toMatchObject({ isMock: false, externalId: `threads:${fx.ids.media}`, verification: 'VERIFIED' });
    expect(fx.calls.filter((c) => c.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
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
