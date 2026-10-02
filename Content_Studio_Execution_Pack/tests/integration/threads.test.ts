/**
 * T14(결정 D26): Threads 텍스트 — 모의 어댑터만(컨테이너 생성 → 게시 2단계, 원격 단계 참조 저장, 조회로 확인, 요청 제한).
 * 계정은 T13 모의 OAuth 흐름(route)으로 연결한다. 마스터 키는 시험이 만든 난수. **실제 Threads/Meta 호출·네트워크 없음**(fetch 0 확인).
 */
import { randomBytes, randomUUID } from 'node:crypto';
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
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import {
  buildBundle,
  loadConfig,
  openSecret,
  requireSecretKeyring,
  RESTORED_TABLES,
  writeZip,
  type BundleTables,
  type Channel,
  type ChannelAdapterRegistry,
  type RemoteStepsPort,
} from '@cs/domain';
import {
  createMockAdapterRegistry,
  LocalStorageAdapter,
  MockChannelAdapter,
  MockChannelAdapterRegistry,
  MockOAuthStore,
  mockOAuthStore,
  mockOAuthTokenCheck,
  THREADS_PROVISIONAL_RATE_LIMIT,
  ThreadsMockApi,
  ThreadsMockChannelAdapter,
} from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as revokePOST } from '../../apps/web/app/api/channel-accounts/[id]/revoke/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as reconcilePOST } from '../../apps/web/app/api/distribution-items/[id]/reconcile/route';
import { GET as jobGET } from '../../apps/web/app/api/jobs/[id]/route';
import { POST as tickPOST } from '../../apps/web/app/api/worker/tick/route';
import { itemHeadline, jobStatusText } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { formatThreadsDrillTable, runThreadsDrill, threadsDrillTableRows } from '../../packages/db/scripts/drill-threads';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const config = loadConfig({});
/** 앱과 같은 프로세스 싱글턴(web route 의 tick 도 같은 모의 Threads 를 본다) */
const registry = createMockAdapterRegistry();
const api = registry.threads.api;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let seeded: Record<Channel, string>;
/** 가상 시계 오프셋(앞으로만) */
let vt = 0;
let fetchCalls = 0;
const logs: string[] = [];
/** 시험 중 본 모든 응답(헤더 + 본문) — 비밀 검사용 */
const seen: string[] = [];

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (p: string) => new Request(`${BASE}${p}`, { headers: { accept: 'application/json', ...cookieHeader(token) } });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
async function rec(res: Response): Promise<Response> {
  const body = await res.clone().text();
  seen.push(`${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${body}`);
  return res;
}

async function connectFully(accountId: string): Promise<void> {
  const c = await rec(await connectPOST(post(`/api/channel-accounts/${accountId}/connect`), ctx(accountId)));
  expect(c.status).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  const a = await rec(await mockAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(a.status).toBe(303);
  const cb = await rec(await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } })));
  expect(cb.status, await cb.clone().text()).toBe(200);
}

/** 새 모의 Threads 계정 + T13 모의 OAuth 연결(→ credential_state linked → Threads 모의 어댑터) */
async function linkedThreadsAccount(): Promise<{ id: string; external: string }> {
  const external = `mock:threads:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads T14', state: 'mock_ready' })
    .returning();
  await connectFully(row!.id);
  return { id: row!.id, external };
}

const accessTokenOf = async (accountId: string) => {
  const c = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, accountId)))[0]!;
  return JSON.parse(openSecret(requireSecretKeyring(process.env), c.encryptedToken!, c.keyVersion!, { ownerId: owner, channelAccountId: accountId, purpose: 'oauth_token' }))
    .access_token as string;
};

const P1 = '해외 영업 첫 달, 대리점 재고 기준부터 합의했다.';
const THREE = ['첫째 — 재고 기준을 먼저 합의했다.', '둘째 — 가격표는 마지막에 확정했다.', '셋째 — 매주 같은 요일에 숫자를 맞췄다.'];

async function reviewVariant(channel: Channel, body: string): Promise<string> {
  const { content } = await createContent(db, owner, { title: `T14 ${channel}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel, baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}

interface Planned {
  planId: string;
  items: Array<{ id: string; payload_hash: string; channel_account_id: string }>;
}
async function plan(specs: Array<{ accountId: string; channel: Channel; body: string; scenario?: string }>, approve = true): Promise<Planned> {
  const items = [];
  for (const s of specs) items.push({ variant_id: await reviewVariant(s.channel, s.body), channel_account_id: s.accountId });
  const res = await plansPOST(post('/api/distribution-plans', { items }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string; channel_account_id: string; variant_id: string }> };
  const ordered = items.map((x) => p.items.find((i) => i.variant_id === x.variant_id)!);
  for (let k = 0; k < specs.length; k++) {
    if (specs[k]!.scenario) {
      const r = await setScenario(ordered[k]!.id, specs[k]!.scenario!);
      expect(r.status, await r.clone().text()).toBe(200);
    }
  }
  if (approve) {
    const ap = await approvePOST(
      post(`/api/distribution-plans/${p.plan.id}/approve`, {
        item_ids: ordered.map((i) => i.id),
        expected_hashes: Object.fromEntries(ordered.map((i) => [i.id, i.payload_hash])),
        confirm: true,
        purpose: 'mock_publish',
      }),
      ctx(p.plan.id),
    );
    expect(ap.status, await ap.clone().text()).toBe(200);
  }
  return { planId: p.plan.id, items: ordered };
}
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
const retry = async (itemId: string) => rec(await retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId)));

/** 작업 처리기 1회(가상 시계를 advanceMs 만큼 먼저 민다). 연결 의존성은 앱과 같은 jobCredentials(키 묶음 + 401 뒤 T13 확인). */
async function tick(advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 't14-w',
    config,
    ownerId: owner,
    clock: () => new Date(Date.now() + vt),
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: 20,
    credentials: jobCredentials(config, db),
  });
}

const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const stepsOf = (itemId: string) => db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId)).orderBy(asc(schema.remoteSteps.stepIndex));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const eventsOf = async (jobId: string) =>
  (await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq))).map(
    (e) => (e.sanitizedDetails as { transition?: string }).transition,
  );
const stepSig = async (itemId: string) => (await stepsOf(itemId)).map((s) => `${s.kind}:${s.postIndex}:${s.status}`);
const containersOf = async (itemId: string) => (await stepsOf(itemId)).filter((s) => s.kind === 'container').map((s) => s.remoteId);

/** 이 항목이 끝날 때까지(또는 n 회) tick — 매번 가상 20초 */
async function drainUntil(itemId: string, states: string[], n = 12): Promise<string> {
  for (let i = 0; i < n; i++) {
    const j = await jobOf(itemId);
    if (states.includes(j.state)) return j.state;
    await tick(20_000);
  }
  return (await jobOf(itemId)).state;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t14-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('T14 시험: 네트워크 호출 금지');
  });
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void logs.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: Infinity }))).join(' ')));
  }
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  seeded = Object.fromEntries((await listChannelAccounts(db, owner)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  token = await login(A);
});
beforeEach(() => {
  registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT };
});
afterAll(async () => {
  // 기본 경로 전체에서 네트워크 0(외부 쓰기 0)
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('성공 — 단일 게시물·3개 스레드', () => {
  it('단일 게시물: 컨테이너 → 게시 → CONFIRMED, publication 1개(MOCK, mock://threads/…), 단계 = 컨테이너 1 + 게시 1, 원격 ID 마다 한 번', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    const itemId = p.items[0]!.id;
    expect((await execute(p.planId)).status).toBe(200);
    const before = { ...api.calls };
    await tick();
    const job = await jobOf(itemId);
    expect(job.state).toBe('CONFIRMED');
    const intents = await intentsOf(job.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]!.sanitizedDetails).toMatchObject({ adapter_id: 'mock_threads', status: 'accepted' });
    const pubs = await pubsOf(itemId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({ isMock: true, verification: 'MOCK' });
    expect(pubs[0]!.externalId).toMatch(/^mock:threads:mockthr_post_/);
    expect(pubs[0]!.permalink).toMatch(/^mock:\/\/threads\/mockthr_post_/);
    expect(await stepSig(itemId)).toEqual(['container:0:finished', 'publish:0:published']);
    const steps = await stepsOf(itemId);
    expect(new Set(steps.map((s) => s.remoteId)).size).toBe(steps.length);
    expect(steps.every((s) => s.intentId === intents[0]!.id)).toBe(true);
    expect(api.calls.createContainer - before.createContainer).toBe(1);
    expect(api.calls.publish - before.publish).toBe(1);
    expect(api.publishCount.get(steps[0]!.remoteId)).toBe(1);
    // 화면·API: 단계 목록·연결 상태·MOCK, "게시 완료" 없음
    const view = (await (await rec(await planGET(get(`/api/distribution-plans/${p.planId}`), ctx(p.planId)))).json()) as {
      mode: string;
      items: Array<{ remote_steps: Array<{ kind: string; remote_id: string; mock: boolean }>; connection: { status: string; mock: boolean } | null }>;
    };
    expect(view.mode).toBe('MOCK');
    expect(view.items[0]!.remote_steps.map((s) => s.kind)).toEqual(['container', 'publish']);
    expect(view.items[0]!.remote_steps.every((s) => s.mock && s.remote_id.startsWith('mockthr_'))).toBe(true);
    expect(view.items[0]!.connection).toMatchObject({ status: 'connected', mock: true });
    expect(JSON.stringify(view)).not.toMatch(/게시 완료/);
    expect(itemHeadline({ status: 'CONFIRMED', channel: 'threads', job, pub: pubs[0]!, blockReason: null })).toBe('MOCK 비공개 결과 확인');
  });

  it('3개 스레드: 게시물마다 컨테이너 → 게시(앞 게시물에 답글), publication 은 첫 게시물 하나, 단계 6개', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.join('\n\n') }]);
    const itemId = p.items[0]!.id;
    const item = (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
    expect((item.payloadJson as { text: { posts: string[] } }).text.posts).toEqual(THREE);
    expect((await execute(p.planId)).status).toBe(200);
    await tick();
    expect((await jobOf(itemId)).state).toBe('CONFIRMED');
    expect(await stepSig(itemId)).toEqual([
      'container:0:finished',
      'publish:0:published',
      'container:1:finished',
      'publish:1:published',
      'container:2:finished',
      'publish:2:published',
    ]);
    const posts = api.postsOf(acc.external);
    expect(posts.map((x) => x.text)).toEqual(THREE);
    expect(posts[1]!.replyToId).toBe(posts[0]!.id);
    expect(posts[2]!.replyToId).toBe(posts[1]!.id);
    const pubs = await pubsOf(itemId);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]!.externalId).toBe(`mock:threads:${posts[0]!.id}`);
    // 더 돌려도 다시 보내지 않는다
    await tick(MIN);
    expect(api.postsOf(acc.external)).toHaveLength(3);
    expect(await intentsOf((await jobOf(itemId)).id)).toHaveLength(1);
  });
});

describe('A08 — 응답 유실·시간 초과는 조회, 맹목 재게시 없음', () => {
  it('threads_publish_timeout_sent: RECONCILING → 조회가 컨테이너로 게시물을 찾아 CONFIRMED, 두 번째 컨테이너·두 번째 게시 없음', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_sent' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    const job = await jobOf(itemId);
    expect(job.state).toBe('RECONCILING');
    expect(await pubsOf(itemId)).toHaveLength(0);
    expect(api.postsOf(acc.external)).toHaveLength(1); // 원격은 게시함(앱은 모름)
    await tick(11_000);
    expect((await jobOf(itemId)).state).toBe('CONFIRMED');
    expect(await intentsOf(job.id)).toHaveLength(1);
    expect(await containersOf(itemId)).toHaveLength(1);
    expect(api.containerIds(acc.external)).toHaveLength(1);
    expect(api.postsOf(acc.external)).toHaveLength(1);
    expect(api.publishCount.get((await containersOf(itemId))[0]!)).toBe(1);
    expect(await stepSig(itemId)).toEqual(['container:0:finished', 'publish:0:published']);
    expect(await pubsOf(itemId)).toHaveLength(1);
  });

  it('threads_publish_timeout_not_sent: 조회 → 끝났지만 게시 안 된 컨테이너(resumable) → 같은 컨테이너로 게시 → CONFIRMED(컨테이너 1개)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_not_sent' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    const [container] = await containersOf(itemId);
    await tick(11_000);
    expect((await jobOf(itemId)).state).toBe('RETRY_WAIT');
    expect(await eventsOf((await jobOf(itemId)).id)).toContain('resume');
    await tick(1000);
    const job = await jobOf(itemId);
    expect(job.state).toBe('CONFIRMED');
    expect(await containersOf(itemId)).toEqual([container]);
    expect(api.containerIds(acc.external)).toEqual([container]);
    expect(api.publishCount.get(container!)).toBe(1);
    const intents = await intentsOf(job.id);
    expect(intents.map((i) => i.outcome)).toEqual(['ambiguous', 'accepted']);
  });

  it('threads_container_slow: REMOTE_PROCESSING → 나중 tick 에 같은 컨테이너로 게시 → CONFIRMED', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_container_slow' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    expect((await jobOf(itemId)).state).toBe('REMOTE_PROCESSING');
    expect(await stepSig(itemId)).toEqual(['container:0:created']);
    const [container] = await containersOf(itemId);
    expect(await drainUntil(itemId, ['CONFIRMED', 'FAILED', 'UNKNOWN'])).toBe('CONFIRMED');
    expect(await containersOf(itemId)).toEqual([container]);
    expect(api.containerIds(acc.external)).toEqual([container]);
    expect(api.publishCount.get(container!)).toBe(1);
  });

  it('부분 스레드(threads_thread_partial): 1·2 게시 뒤 3번째 결과 불명 → RECONCILING(publication 없음) → 3번째만 이어서 → CONFIRMED, 1·2 재게시 없음', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.join('\n\n'), scenario: 'threads_thread_partial' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    const job = await jobOf(itemId);
    expect(job.state).toBe('RECONCILING');
    expect(await stepSig(itemId)).toEqual(['container:0:finished', 'publish:0:published', 'container:1:finished', 'publish:1:published', 'container:2:finished']);
    expect(await pubsOf(itemId)).toHaveLength(0); // 스레드 전체가 게시되기 전에는 publication 없음
    expect((await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!.status).not.toBe('CONFIRMED');
    expect(await drainUntil(itemId, ['CONFIRMED', 'FAILED', 'UNKNOWN'])).toBe('CONFIRMED');
    const containers = await containersOf(itemId);
    expect(containers).toHaveLength(3);
    for (const c of containers) expect(api.publishCount.get(c)).toBe(1);
    expect(api.postsOf(acc.external)).toHaveLength(3);
    expect(api.containerIds(acc.external)).toHaveLength(3);
    expect(await pubsOf(itemId)).toHaveLength(1);
    const events = await eventsOf(job.id);
    expect(events).toContain('resume');
    expect(events).not.toContain('reconciled_not_found');
  });

  it('조회는 보낸 어댑터(전송 의도의 adapter_id)로 — 그 사이 선택 규칙이 바뀌어도 일반 모의 어댑터로 가지 않는다', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_sent' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    // 선택 규칙만 바꾼다(credential_state none → 규칙상 일반 모의). 보낸 것은 Threads 모의이므로 Threads 로 조회해야 한다.
    await db.update(schema.channelAccounts).set({ credentialState: 'none' }).where(eq(schema.channelAccounts.id, acc.id));
    const genericReconciles = registry.mock.calls.reconcile;
    await tick(11_000);
    expect((await jobOf(itemId)).state).toBe('CONFIRMED');
    expect(registry.mock.calls.reconcile).toBe(genericReconciles);
    expect(api.postsOf(acc.external)).toHaveLength(1);
    await db.update(schema.channelAccounts).set({ credentialState: 'linked' }).where(eq(schema.channelAccounts.id, acc.id));
  });

  it('사용자 재확인은 조회만: resumable 이어도 이어 보내지 않는다(UI 값 resumable)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_not_sent' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    const publishes = api.calls.publish;
    const r = await rec(await reconcilePOST(post(`/api/distribution-items/${itemId}/reconcile`), ctx(itemId)));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ remote: 'resumable', state: 'RECONCILING', found: false });
    expect(api.calls.publish).toBe(publishes);
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
  });
});

describe('취소 요청 중 재개 가능(resumable) 판정', () => {
  it('게시된 것이 없으면 CANCELED(컨테이너는 게시되지 않은 채 남음), 스레드 일부가 게시됐으면 취소 성공이라 하지 않고 UNKNOWN(남은 게시물 보내지 않음)', async () => {
    const a1 = await linkedThreadsAccount();
    const p1 = await plan([{ accountId: a1.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_not_sent' }]);
    await execute(p1.planId);
    await tick();
    expect((await jobOf(p1.items[0]!.id)).state).toBe('RECONCILING');
    const c1 = await rec(await cancelPOST(post(`/api/distribution-items/${p1.items[0]!.id}/cancel`), ctx(p1.items[0]!.id)));
    expect((await c1.json()).cancel_requested).toBe(true);
    await tick(11_000);
    expect((await jobOf(p1.items[0]!.id)).state).toBe('CANCELED');
    expect(api.postsOf(a1.external)).toHaveLength(0);

    const a2 = await linkedThreadsAccount();
    const p2 = await plan([{ accountId: a2.id, channel: 'threads', body: THREE.join('\n\n'), scenario: 'threads_thread_partial' }]);
    await execute(p2.planId);
    await tick();
    expect((await jobOf(p2.items[0]!.id)).state).toBe('RECONCILING');
    await rec(await cancelPOST(post(`/api/distribution-items/${p2.items[0]!.id}/cancel`), ctx(p2.items[0]!.id)));
    await tick(11_000);
    const j2 = await jobOf(p2.items[0]!.id);
    expect(j2.state).toBe('UNKNOWN');
    expect(j2.lastErrorCode).toBe('thread_partial_cancel_requested');
    await tick(20 * MIN);
    expect(api.postsOf(a2.external)).toHaveLength(2);
    expect(await pubsOf(p2.items[0]!.id)).toHaveLength(0);
  });
});

describe('A09 — 한 채널 401·다른 채널 성공', () => {
  it('Threads 401(시나리오) + 일반 모의 성공 → partial, 성공 항목 의도 1개 유지, Threads 는 BLOCKED "계정 다시 연결 필요" → 다시 연결 + 재시도 → CONFIRMED', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([
      { accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_token_invalid' },
      { accountId: seeded.blog, channel: 'blog', body: P1, scenario: 'success' },
    ]);
    const [thr, blog] = p.items;
    await execute(p.planId);
    await tick();
    await tick(MIN);
    await tick(MIN);
    const tj = await jobOf(thr!.id);
    expect(tj.state).toBe('BLOCKED');
    expect(tj.lastErrorCode).toBe('auth_invalid_token');
    expect(itemHeadline({ status: 'BLOCKED', channel: 'threads', job: tj, pub: null, blockReason: null })).toBe('계정 다시 연결 필요');
    const bj = await jobOf(blog!.id);
    expect(bj.state).toBe('CONFIRMED');
    expect(await intentsOf(bj.id)).toHaveLength(1);
    const planRow = (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, p.planId)))[0]!;
    expect(planRow.status).toBe('partial');
    // 401 뒤 T13 확인 경로(checkCredential)를 한 번 불렀다(감사 oauth.checked)
    const checked = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'oauth.checked'));
    expect(checked.some((a) => a.entityId === acc.id)).toBe(true);
    await connectFully(acc.id); // 다시 연결(같은 계정 — 승인 유지)
    expect((await retry(thr!.id)).status).toBe(200);
    await tick(1000);
    expect((await jobOf(thr!.id)).state).toBe('CONFIRMED');
    expect(await intentsOf(bj.id)).toHaveLength(1);
    expect((await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, p.planId)))[0]!.status).toBe('completed');
  });

  it('공급자에서 토큰이 무효가 되면(401) → BLOCKED + T13 확인이 연결 정보를 error 로 → 재시도 409 → 다시 연결 → 재시도 → CONFIRMED', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    // 원격(모의 Meta)에서 토큰을 무효로 만든다 — 앱의 DB 는 아직 "연결됨"
    const at = await accessTokenOf(acc.id);
    const { createHash } = await import('node:crypto');
    mockOAuthStore().tokens.get(createHash('sha256').update(at, 'utf8').digest('hex'))!.revoked = true;
    const callsBefore = api.calls.publish;
    await tick();
    const job = await jobOf(itemId);
    expect(job.state).toBe('BLOCKED');
    expect(job.lastErrorCode).toBe('auth_invalid_token');
    expect(api.calls.publish).toBe(callsBefore);
    const cred = (await db.select().from(schema.oauthCredentials).where(eq(schema.oauthCredentials.channelAccountId, acc.id)))[0]!;
    expect(cred.status).toBe('error');
    const rt = await retry(itemId);
    expect(rt.status).toBe(409);
    expect((await rt.json()).error).toBe('account_credential_blocked');
    await connectFully(acc.id);
    expect((await retry(itemId)).status).toBe(200);
    await tick(1000);
    expect((await jobOf(itemId)).state).toBe('CONFIRMED');
  });
});

describe('연결 정보를 쓸 수 없으면 보내지 않는다(T13 게이트)', () => {
  it('만료 → 실행 409(작업 0)·시뮬레이터 호출 0, 해제 → 대기 작업 BLOCKED(의도 0), 정리 대기(FIX3) → BLOCKED(의도 0)', async () => {
    const calls = () => Object.values(api.calls).reduce((a, b) => a + b, 0);
    // (a) 만료
    const a1 = await linkedThreadsAccount();
    const p1 = await plan([{ accountId: a1.id, channel: 'threads', body: P1 }]);
    await db.update(schema.oauthCredentials).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.oauthCredentials.channelAccountId, a1.id));
    const before = calls();
    const ex = await execute(p1.planId);
    expect(ex.status).toBe(409);
    expect((await ex.json()).error).toBe('account_credential_blocked');
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, p1.items[0]!.id))).toHaveLength(0);
    // (b) 실행 뒤 해제(revoke route)
    const a2 = await linkedThreadsAccount();
    const p2 = await plan([{ accountId: a2.id, channel: 'threads', body: P1 }]);
    expect((await execute(p2.planId)).status).toBe(200);
    expect((await rec(await revokePOST(post(`/api/channel-accounts/${a2.id}/revoke`), ctx(a2.id)))).status).toBe(200);
    await tick();
    const j2 = await jobOf(p2.items[0]!.id);
    expect(j2.state).toBe('BLOCKED');
    expect(await intentsOf(j2.id)).toHaveLength(0);
    // (c) 정리 대기 표시(FIX3 pending record)가 있으면 상태와 관계없이 차단
    const a3 = await linkedThreadsAccount();
    const p3 = await plan([{ accountId: a3.id, channel: 'threads', body: P1 }]);
    expect((await execute(p3.planId)).status).toBe(200);
    // FIX4-T13: 정리 대기는 oauth_pending_tokens 행(계정마다 여러 건)
    await db
      .insert(schema.oauthPendingTokens)
      .values({ id: randomUUID(), ownerId: owner, channelAccountId: a3.id, kind: 'cleanup_revoke', sealedToken: 'csk1:1:AAAA:BBBB:CCCC', keyVersion: 1, source: 'test' });
    await tick();
    const j3 = await jobOf(p3.items[0]!.id);
    expect(j3.state).toBe('BLOCKED');
    expect(j3.lastErrorCode).toBe('credential_error');
    expect(await intentsOf(j3.id)).toHaveLength(0);
    expect(calls()).toBe(before);
  });
});

describe('요청 제한(로컬·원격 429)·형식·권한 오류', () => {
  it('로컬 제한: 창 안 한도를 넘으면 전송 의도 없이 RETRY_WAIT(local_rate_limited, 창이 풀리는 시각), 화면 "요청 제한 — HH:mm MSK 이후 재시도"', async () => {
    registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT, max_units: 1, window_sec: 3600 };
    const acc = await linkedThreadsAccount();
    const first = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    await execute(first.planId);
    await tick();
    expect((await jobOf(first.items[0]!.id)).state).toBe('CONFIRMED');
    const firstPublishAt = (await stepsOf(first.items[0]!.id)).find((s) => s.kind === 'publish')!.createdAt;
    const second = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    await execute(second.planId);
    const containers = api.calls.createContainer;
    await tick(1000);
    const job = await jobOf(second.items[0]!.id);
    expect(job.state).toBe('RETRY_WAIT');
    expect(job.lastErrorCode).toBe('local_rate_limited');
    expect(job.attempt).toBe(0);
    expect(await intentsOf(job.id)).toHaveLength(0);
    expect(api.calls.createContainer).toBe(containers);
    expect(job.nextRunAt.getTime()).toBe(firstPublishAt.getTime() + 3600_000);
    expect(await eventsOf(job.id)).toContain('local_rate_limited');
    expect(jobStatusText(job)).toMatch(/^RETRY_WAIT · 요청 제한 — \d\d:\d\d MSK 이후 재시도$/);
    expect(itemHeadline({ status: 'RETRY_WAIT', channel: 'threads', job, pub: null, blockReason: null })).toMatch(/^요청 제한 — \d\d:\d\d MSK 이후 재시도$/);
    // 창이 풀리기 전에는 다시 lease 되지 않는다, 지나면 보낸다
    await tick(10 * MIN);
    expect((await jobOf(second.items[0]!.id)).state).toBe('RETRY_WAIT');
    await tick(55 * MIN);
    expect((await jobOf(second.items[0]!.id)).state).toBe('CONFIRMED');
  });

  it('원격 429: Retry-After 를 지키는 RETRY_WAIT(의도 1, 부작용 없음) → 같은 컨테이너로 게시 → CONFIRMED', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    await execute(p.planId);
    api.setRateBudget(acc.external, 0, 300);
    const t0 = Date.now() + vt;
    await tick();
    const job = await jobOf(p.items[0]!.id);
    expect(job.state).toBe('RETRY_WAIT');
    expect(job.lastErrorCode).toBe('rate_limited');
    expect(job.nextRunAt.getTime() - t0).toBeGreaterThanOrEqual(300_000);
    expect(jobStatusText(job)).toMatch(/요청 제한/);
    api.clearRateBudget(acc.external);
    await tick(2 * MIN);
    expect((await jobOf(p.items[0]!.id)).state).toBe('RETRY_WAIT');
    await tick(4 * MIN);
    const done = await jobOf(p.items[0]!.id);
    expect(done.state).toBe('CONFIRMED');
    expect(await intentsOf(done.id)).toHaveLength(2);
    expect(await containersOf(p.items[0]!.id)).toHaveLength(1);
  });

  it('400(threads_text_too_long) → FAILED 재시도 없음, 403(permission_denied) → FAILED', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_text_too_long' }]);
    await execute(p.planId);
    await tick();
    await tick(20 * MIN);
    const j = await jobOf(p.items[0]!.id);
    expect(j.state).toBe('FAILED');
    expect(j.lastErrorCode).toBe('invalid_parameter:text_too_long');
    expect(await intentsOf(j.id)).toHaveLength(1);
    const acc2 = await linkedThreadsAccount();
    const p2 = await plan([{ accountId: acc2.id, channel: 'threads', body: P1 }]);
    await execute(p2.planId);
    api.injectFault({ op: 'publish', kind: 'permission_denied', userId: acc2.external });
    await tick();
    await tick(20 * MIN);
    const j2 = await jobOf(p2.items[0]!.id);
    expect(j2.state).toBe('FAILED');
    expect(j2.lastErrorCode).toBe('permission_denied');
    expect(await intentsOf(j2.id)).toHaveLength(1);
    expect(api.postsOf(acc2.external)).toHaveLength(0);
  });
});

describe('시나리오·DB 규칙', () => {
  it('threads_* 는 Threads 모의 연결 항목에만, 일반 시나리오는 Threads 항목에 400 scenario_not_applicable(success 는 둘 다)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan(
      [
        { accountId: acc.id, channel: 'threads', body: P1 },
        { accountId: seeded.blog, channel: 'blog', body: P1 },
      ],
      false,
    );
    const [thr, blog] = p.items;
    const r1 = await setScenario(blog!.id, 'threads_success');
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe('scenario_not_applicable');
    const r2 = await setScenario(thr!.id, 'ambiguous_sent');
    expect(r2.status).toBe(400);
    expect((await setScenario(thr!.id, 'success')).status).toBe(200);
    expect((await setScenario(thr!.id, 'threads_container_slow')).status).toBe(200);
    expect((await setScenario(blog!.id, 'success')).status).toBe(200);
  });

  it('remote_steps: remote_id 변경·삭제 거부, 모의 아닌 ID 거부, 같은 게시물에 두 번째 컨테이너 거부', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    await execute(p.planId);
    await tick();
    const [ct] = await stepsOf(p.items[0]!.id);
    await expect(db.execute(sql`update remote_steps set remote_id = 'mockthr_ct_other' where id = ${ct!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`delete from remote_steps where id = ${ct!.id}::uuid`)).rejects.toThrow();
    await expect(db.execute(sql`update remote_steps set status = 'created' where id = ${ct!.id}::uuid`)).rejects.toThrow();
    await expect(
      db.execute(sql`insert into remote_steps (owner_id, job_id, intent_id, item_id, step_index, kind, post_index, remote_id, status)
        values (${owner}::uuid, ${ct!.jobId}::uuid, ${ct!.intentId}::uuid, ${ct!.itemId}::uuid, 9, 'container', 5, 'https://threads.net/x', 'created')`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`insert into remote_steps (owner_id, job_id, intent_id, item_id, step_index, kind, post_index, remote_id, status)
        values (${owner}::uuid, ${ct!.jobId}::uuid, ${ct!.intentId}::uuid, ${ct!.itemId}::uuid, 9, 'container', 0, 'mockthr_ct_second', 'created')`),
    ).rejects.toThrow();
    expect(await stepsOf(p.items[0]!.id)).toHaveLength(2);
  });

  it('web tick route(앱 경로)도 Threads 모의 어댑터로 처리한다 — 응답은 MOCK, 토큰 없음', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    await execute(p.planId);
    const res = await rec(await tickPOST(post('/api/worker/tick', { max_jobs: 5 })));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('MOCK');
    const job = await jobOf(p.items[0]!.id);
    expect(job.state).toBe('CONFIRMED');
    const detail = await rec(await jobGET(get(`/api/jobs/${job.id}`), ctx(job.id)));
    expect(detail.status).toBe(200);
  });
});

describe('FIX round 1(Codex review-T14)', () => {
  /** 다른 레지스트리로 작업 처리기 1회(같은 가상 시계) */
  async function tickWith(reg: ChannelAdapterRegistry, advanceMs = 0, workerId = 't14-fix-w') {
    vt += advanceMs;
    return runJobsTick(db, reg, {
      workerId,
      config,
      ownerId: owner,
      clock: () => new Date(Date.now() + vt),
      random: () => 0.5,
      submitTimeoutMs: 5000,
      maxJobs: 20,
      credentials: jobCredentials(config, db),
    });
  }
  const cancel = async (itemId: string) => rec(await cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId)));
  const eventDetails = async (jobId: string) =>
    (await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq))).map(
      (e) => e.sanitizedDetails as Record<string, unknown>,
    );

  /** T14 이전 코드가 만든 것처럼 전송 의도의 adapter_id 를 없앤다(그때 의도에는 이 키가 없었다 — 트리거를 잠시 끄고 이 시험 행만). */
  async function stripAdapterId(jobId: string) {
    await db.execute(sql`alter table send_intents disable trigger send_intents_guard`);
    try {
      await db.execute(sql`update send_intents set sanitized_details = sanitized_details - 'adapter_id' where job_id = ${jobId}::uuid`);
    } finally {
      await db.execute(sql`alter table send_intents enable trigger send_intents_guard`);
    }
    for (const i of await intentsOf(jobId)) expect(i.sanitizedDetails).not.toHaveProperty('adapter_id');
  }

  /** T14 이전 선택 규칙: 모든 모의 계정 → 일반 모의 어댑터(getAdapterById 없음) */
  const legacyRegistry = (generic: MockChannelAdapter): ChannelAdapterRegistry => ({ getAdapterFor: () => generic });

  async function legacyAmbiguousSend(generic: MockChannelAdapter) {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    const itemId = p.items[0]!.id;
    // 일반 모의 시나리오(응답 유실, 원격은 받음) — T14 이전에는 Threads 항목도 일반 시나리오를 썼다(API 적용 검사를 거치지 않고 넣는다).
    await db.insert(schema.mockScenarios).values({ ownerId: owner, distributionItemId: itemId, scenario: 'ambiguous_sent', delayMs: 0 });
    expect((await execute(p.planId)).status).toBe(200);
    await tickWith(legacyRegistry(generic));
    const job = await jobOf(itemId);
    expect(job.state).toBe('RECONCILING');
    expect(generic.calls.submit).toBeGreaterThan(0);
    await stripAdapterId(job.id);
    return { acc, itemId, jobId: job.id };
  }

  it('P0 업그레이드: adapter_id 없는 미확정 의도(T13 연결 Threads 계정·일반 모의로 전송·응답 유실) → T14 조회는 기록된(legacy) 일반 모의 어댑터로 — 같은 원격이면 CONFIRMED, Threads 조회·재전송 0', async () => {
    const generic = new MockChannelAdapter({ readEnv: false });
    const x = await legacyAmbiguousSend(generic);
    const t14 = new MockChannelAdapterRegistry(generic, registry.threads);
    const thrReconciles = registry.threads.calls.reconcile;
    const thrSubmits = registry.threads.calls.submit;
    const genericSubmits = generic.calls.submit;
    await tickWith(t14, 11_000);
    const job = await jobOf(x.itemId);
    expect(job.state).toBe('CONFIRMED');
    expect(registry.threads.calls.reconcile).toBe(thrReconciles);
    expect(registry.threads.calls.submit).toBe(thrSubmits);
    expect(generic.calls.submit).toBe(genericSubmits);
    expect(await intentsOf(job.id)).toHaveLength(1);
    expect(api.postsOf(x.acc.external)).toHaveLength(0);
  });

  it('P0 업그레이드: 같은 의도를 원격 기록이 없는(재시작) 환경에서 조회 → not_found 아님(unknown → UNKNOWN), 재전송·새 의도 0', async () => {
    const generic = new MockChannelAdapter({ readEnv: false });
    const x = await legacyAmbiguousSend(generic);
    const restarted = new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }), registry.threads);
    const thrReconciles = registry.threads.calls.reconcile;
    for (let i = 0; i < 6; i++) await tickWith(restarted, 20 * MIN);
    const job = await jobOf(x.itemId);
    expect(job.state).toBe('UNKNOWN');
    const ev = await eventsOf(job.id);
    expect(ev).not.toContain('reconciled_not_found');
    expect(ev.filter((e) => e === 'send_start')).toHaveLength(1);
    expect(await intentsOf(job.id)).toHaveLength(1);
    expect(registry.threads.calls.reconcile).toBe(thrReconciles); // 현재 선택(Threads)으로 대신 조회하지 않는다
    expect(api.postsOf(x.acc.external)).toHaveLength(0);
    expect(await pubsOf(x.itemId)).toHaveLength(0);
  });

  it('P0: 기록된 adapter_id 를 레지스트리가 모르면 unknown(adapter_unresolved) — not_found·재전송 없음', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_not_sent' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    const job = await jobOf(itemId);
    expect(job.state).toBe('RECONCILING');
    const unknownReg: ChannelAdapterRegistry = { getAdapterFor: () => registry.threads, getAdapterById: () => null };
    const creates = api.calls.createContainer;
    const publishes = api.calls.publish;
    for (let i = 0; i < 4; i++) await tickWith(unknownReg, 20 * MIN);
    expect((await jobOf(itemId)).state).toBe('UNKNOWN');
    expect((await eventDetails(job.id)).some((d) => d.error_code === 'adapter_unresolved')).toBe(true);
    expect(api.calls.createContainer).toBe(creates);
    expect(api.calls.publish).toBe(publishes);
    expect(await intentsOf(job.id)).toHaveLength(1);
  });

  it('P1: 응답 유실·부분 스레드를 내보내고 복원 → remote_steps 가 읽기 전용 이력으로 함께 들어오고 수동 재확인은 not_found 가 아님, 단계 없는(이전) 묶음 → unknown(restored_steps_missing)', async () => {
    const a1 = await linkedThreadsAccount();
    const lost = await plan([{ accountId: a1.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_sent' }]);
    await execute(lost.planId);
    await tick();
    const a2 = await linkedThreadsAccount();
    const partial = await plan([{ accountId: a2.id, channel: 'threads', body: THREE.join('\n\n'), scenario: 'threads_thread_partial' }]);
    await execute(partial.planId);
    await tick();
    const lostId = lost.items[0]!.id;
    const partId = partial.items[0]!.id;
    expect((await jobOf(lostId)).state).toBe('RECONCILING');
    expect((await jobOf(partId)).state).toBe('RECONCILING');
    const sig = (rows: Array<typeof schema.remoteSteps.$inferSelect>) => rows.map((s) => `${s.id}:${s.kind}:${s.postIndex}:${s.remoteId}:${s.status}`);
    const srcSteps = new Map([
      [lostId, sig(await stepsOf(lostId))],
      [partId, sig(await stepsOf(partId))],
    ]);
    expect(srcSteps.get(partId)).toHaveLength(5);
    const ex = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { outDir: path.join(tmp, 'exports') });
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(ex.zipPath)));
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
      const target = (await ensureOwner(h.db, `restore-t14fix-${randomUUID().slice(0, 6)}@example.local`)).id;
      const restoresDir = path.join(tmp, 'restores');
      const pv = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, `assets-r-${randomUUID().slice(0, 6)}`)), target, pv.restoreId, {
        mode: 'empty_only',
        confirm: true,
        restoresDir,
      });
      return { h, target };
    };
    const lastReconcileCode = async (hdb: Db, itemId: string) => {
      const j = (await hdb.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)))[0]!;
      const evs = await hdb.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, j.id)).orderBy(asc(schema.jobEvents.eventSeq));
      return (evs.at(-1)!.sanitizedDetails as { error_code?: string }).error_code;
    };
    expect(RESTORED_TABLES as readonly string[]).toContain('remote_steps');
    // (1) 현재 묶음: 단계가 같은 ID·값으로 함께 복원된다
    {
      const { h, target } = await restoreInto(bundleOf(structuredClone(parsed.tables) as BundleTables));
      try {
        for (const itemId of [lostId, partId]) {
          const rs = await h.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId)).orderBy(asc(schema.remoteSteps.stepIndex));
          expect(sig(rs)).toEqual(srcSteps.get(itemId));
          expect(rs.every((s) => s.ownerId === target)).toBe(true);
          const j = (await h.db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)))[0]!;
          expect(j).toMatchObject({ restoredNeedsReview: true, leaseOwner: null });
          const submits = registry.threads.calls.submit;
          const rc = await reconcileItem(h.db, registry, target, itemId);
          // 연결 정보는 묶음 밖 — 이 환경에서는 확인할 수 없다(unknown). not_found 로 단정하지 않는다. 전송 0.
          expect(rc.remote).toBe('unknown');
          expect(registry.threads.calls.submit).toBe(submits);
        }
        expect((await runJobsTick(h.db, registry, { workerId: 'restored-w', config, ownerId: target, submitTimeoutMs: 500 })).leased).toBe(0);
      } finally {
        await h.close();
      }
    }
    // (2) 이전 묶음(단계 기록 없음): 조회는 not_found 가 아니라 unknown(restored_steps_missing)
    {
      const old = structuredClone(parsed.tables) as BundleTables;
      old.remote_steps = [];
      const { h, target } = await restoreInto(bundleOf(old));
      try {
        for (const itemId of [lostId, partId]) {
          expect(await h.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId))).toHaveLength(0);
          const rc = await reconcileItem(h.db, registry, target, itemId);
          expect(rc.remote).toBe('unknown');
          expect(await lastReconcileCode(h.db, itemId)).toBe('restored_steps_missing');
        }
      } finally {
        await h.close();
      }
    }
    expect(api.postsOf(a1.external)).toHaveLength(1);
    expect(api.postsOf(a2.external)).toHaveLength(2);
  }, 180_000);

  it('P2: publish 429 → RETRY_WAIT 중 컨테이너 만료 → 재시도는 영구 FAILED 가 아니라 조회 → UNKNOWN(새 컨테이너·게시 0)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    api.setRateBudget(acc.external, 0, 60);
    await tick();
    expect((await jobOf(itemId)).state).toBe('RETRY_WAIT');
    api.clearRateBudget(acc.external);
    const [container] = await containersOf(itemId);
    api.expireContainer(container!);
    expect(await drainUntil(itemId, ['CONFIRMED', 'FAILED', 'UNKNOWN'], 20)).toBe('UNKNOWN');
    const job = await jobOf(itemId);
    expect(await eventsOf(job.id)).not.toContain('permanent_failure');
    expect(await containersOf(itemId)).toEqual([container]);
    expect(api.containerIds(acc.external)).toEqual([container]);
    expect(api.postsOf(acc.external)).toHaveLength(0);
  });

  it('P2: resumable 판정(resume) 뒤 컨테이너 만료 → 다음 시도 ambiguous → UNKNOWN, FAILED 아님', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_not_sent' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    await tick(11_000);
    expect((await jobOf(itemId)).state).toBe('RETRY_WAIT');
    const [container] = await containersOf(itemId);
    api.expireContainer(container!);
    expect(await drainUntil(itemId, ['CONFIRMED', 'FAILED', 'UNKNOWN'], 20)).toBe('UNKNOWN');
    expect(api.containerIds(acc.external)).toEqual([container]);
    expect(api.postsOf(acc.external)).toHaveLength(0);
  });

  /** 3개 스레드에서 1번째 게시 뒤 2번째 publish 429 → RETRY_WAIT(게시 1) */
  async function partialAfter429() {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.join('\n\n') }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    api.setRateBudget(acc.external, 1, 60);
    await tick();
    const job = await jobOf(itemId);
    expect(job.state).toBe('RETRY_WAIT');
    expect(job.lastErrorCode).toBe('rate_limited');
    expect(api.postsOf(acc.external)).toHaveLength(1);
    api.clearRateBudget(acc.external);
    return { acc, itemId };
  }

  it('missed: 2번째 게시물 429 뒤 RETRY_WAIT 취소 → CANCELED("보내지 않음")가 아니라 UNKNOWN(thread_partial_canceled), 남은 게시물 보내지 않음', async () => {
    const x = await partialAfter429();
    const c = await cancel(x.itemId);
    expect(c.status).toBe(200);
    expect(await c.json()).toMatchObject({ canceled: false, cancel_requested: false, state: 'UNKNOWN', published_parts: 1 });
    const job = await jobOf(x.itemId);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_canceled' });
    expect((await eventDetails(job.id)).at(-1)).toMatchObject({ transition: 'cancel_partial', not_sent: false, published_parts: 1 });
    await tick(20 * MIN);
    await tick(20 * MIN);
    expect(api.postsOf(x.acc.external)).toHaveLength(1);
    expect(itemHeadline({ status: 'UNKNOWN', channel: 'threads', job, pub: null, blockReason: null })).toMatch(/^일부만 게시됨\(MOCK\)/);
    expect((await retry(x.itemId)).status).toBe(409);
  });

  it('missed: 2번째 게시물 429 뒤 대기 → 2번째부터 이어서 CONFIRMED, 1번째 재게시 없음', async () => {
    const x = await partialAfter429();
    expect(await drainUntil(x.itemId, ['CONFIRMED', 'FAILED', 'UNKNOWN'])).toBe('CONFIRMED');
    expect(api.postsOf(x.acc.external)).toHaveLength(3);
    for (const c of await containersOf(x.itemId)) expect(api.publishCount.get(c)).toBe(1);
  });

  it('missed: 2번째 게시물 401 → BLOCKED(게시 1) → 재시도 → 2번째부터 이어서 CONFIRMED / 같은 상황 취소 → UNKNOWN(부분)', async () => {
    for (const action of ['retry', 'cancel'] as const) {
      const x = await partialAfter429();
      api.injectFault({ op: 'publish', kind: 'auth_invalid_token', userId: x.acc.external });
      await tick(2 * MIN);
      expect(await jobOf(x.itemId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'auth_invalid_token' });
      expect(api.postsOf(x.acc.external)).toHaveLength(1);
      if (action === 'retry') {
        expect((await retry(x.itemId)).status).toBe(200);
        await tick(1000);
        expect((await jobOf(x.itemId)).state).toBe('CONFIRMED');
        expect(api.postsOf(x.acc.external)).toHaveLength(3);
        for (const c of await containersOf(x.itemId)) expect(api.publishCount.get(c)).toBe(1);
      } else {
        expect(await (await cancel(x.itemId)).json()).toMatchObject({ state: 'UNKNOWN', published_parts: 1 });
        await tick(20 * MIN);
        expect(api.postsOf(x.acc.external)).toHaveLength(1);
      }
    }
  });

  it('missed: 2번째 게시물 400 → FAILED(게시 1, 단계 목록이 보여 줌), 취소·재시도 409', async () => {
    const x = await partialAfter429();
    api.injectFault({ op: 'publish', kind: 'invalid_parameter', userId: x.acc.external });
    await tick(2 * MIN);
    expect((await jobOf(x.itemId)).state).toBe('FAILED');
    expect((await stepSig(x.itemId)).filter((s) => s.startsWith('publish:'))).toEqual(['publish:0:published']);
    expect((await cancel(x.itemId)).status).toBe(409);
    expect((await retry(x.itemId)).status).toBe(409);
    expect(api.postsOf(x.acc.external)).toHaveLength(1);
  });

  it('missed: 부분 스레드 resume 직후(RETRY_WAIT) 취소 → UNKNOWN(부분), 3번째 게시 없음', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.join('\n\n'), scenario: 'threads_thread_partial' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    await tick(11_000);
    const j = await jobOf(itemId);
    expect(j.state).toBe('RETRY_WAIT');
    expect(await eventsOf(j.id)).toContain('resume');
    expect(await (await cancel(itemId)).json()).toMatchObject({ state: 'UNKNOWN', published_parts: 2 });
    await tick(20 * MIN);
    expect(api.postsOf(acc.external)).toHaveLength(2);
    expect(await pubsOf(itemId)).toHaveLength(0);
  });

  it('missed: 게시된 것이 없는 RETRY_WAIT 취소는 그대로 CANCELED(보내지 않음)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_rate_limited' }]);
    await execute(p.planId);
    await tick();
    expect((await jobOf(p.items[0]!.id)).state).toBe('RETRY_WAIT');
    expect(await (await cancel(p.items[0]!.id)).json()).toMatchObject({ canceled: true, state: 'CANCELED' });
  });

  it('missed: 처리 지연 재개(REMOTE_PROCESSING → resume)는 시도 한도를 쓰지 않는다 — 게시물 7개가 모두 처리 지연이어도 max_attempts 5 안에서 CONFIRMED', async () => {
    const slow = new ThreadsMockChannelAdapter({ api, pollBudget: 2 });
    // 모든 컨테이너가 조회 예산만큼 IN_PROGRESS(시험 전용 — 시뮬레이터 동작만 바꿈, payload 불변)
    (slow as unknown as { faultFor: (...a: unknown[]) => unknown }).faultFor = (_s: unknown, op: unknown) => (op === 'createContainer' ? { finishAfterPolls: 2 } : {});
    const reg = new MockChannelAdapterRegistry(registry.mock, slow);
    const acc = await linkedThreadsAccount();
    const posts = Array.from({ length: 7 }, (_, i) => `${i + 1}번째 — 처리 지연 시험 문장.`);
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: posts.join('\n\n') }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    let state = '';
    for (let i = 0; i < 40; i++) {
      await tickWith(reg, 20_000);
      state = (await jobOf(itemId)).state;
      if (['CONFIRMED', 'FAILED', 'UNKNOWN'].includes(state)) break;
    }
    const job = await jobOf(itemId);
    expect(state).toBe('CONFIRMED');
    expect(job.maxAttempts).toBe(5);
    expect(job.attempt).toBeGreaterThan(job.maxAttempts);
    expect(job.resumeCount).toBe(job.attempt - 1);
    expect(api.postsOf(acc.external)).toHaveLength(7);
    for (const c of await containersOf(itemId)) expect(api.publishCount.get(c)).toBe(1);
    expect((await eventDetails(job.id)).filter((d) => d.transition === 'resume').every((d) => d.counted === false)).toBe(true);
  }, 120_000);

  it('missed: 결과 불명(RECONCILING) 뒤의 재개는 시도로 센다(끝없는 재개 없음)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1, scenario: 'threads_publish_timeout_not_sent' }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tick();
    await tick(11_000);
    const j = await jobOf(itemId);
    expect(j.state).toBe('RETRY_WAIT');
    expect(j.resumeCount).toBe(0);
    expect((await eventDetails(j.id)).find((d) => d.transition === 'resume')).toMatchObject({ counted: true });
  });

  it('missed: 로컬 요청 제한은 같은 계정에서 진행 중인 다른 작업의 남은 단위를 예약으로 센다(계정별 advisory 잠금 안) — 실제 사용량만으로는 통과해도 짧게 대기', async () => {
    registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT, max_units: 3, window_sec: 3600 };
    const acc = await linkedThreadsAccount();
    const first = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    await execute(first.planId);
    await tick();
    expect((await jobOf(first.items[0]!.id)).state).toBe('CONFIRMED'); // 사용 1
    const a = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.slice(0, 2).join('\n\n'), scenario: 'threads_container_slow' }]);
    await execute(a.planId);
    await tick(1000);
    expect((await jobOf(a.items[0]!.id)).state).toBe('REMOTE_PROCESSING'); // 진행 중(남은 2)
    const b = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.slice(0, 2).join('\n\n') }]);
    await execute(b.planId);
    const t0 = Date.now() + vt + 1000;
    await tick(1000);
    const jb = await jobOf(b.items[0]!.id);
    expect(jb.state).toBe('RETRY_WAIT');
    expect(jb.lastErrorCode).toBe('local_rate_limited');
    expect(await intentsOf(jb.id)).toHaveLength(0);
    expect((await eventDetails(jb.id)).find((x) => x.transition === 'local_rate_limited')).toMatchObject({ used: 1, inflight: 2, needed: 2 });
    expect(jb.nextRunAt.getTime() - t0).toBeLessThanOrEqual(61_000);
  });

  /**
   * FIX-T14 round 2(Codex review-FIX-T14 P1): 다른 작업(A)이 게시 단계를 기록하고 CONFIRMED 로 끝나는 커밋이 B 의 요청 제한 검사 **안**에
   * 끼어드는 순서를 강제한다. PGlite 는 연결이 하나라 A 의 커밋을 B 의 트랜잭션(tx)에서 직접 써서 흉내 낸다 — READ COMMITTED 에서 B 의 다음
   * 문장이 보게 되는 상태와 같다. 'after_usage' 는 이전 코드(사용량 조회 → 진행 중 조회가 서로 다른 문장)에서 B 가 한도를 넘던 순서다.
   */
  async function finishElsewhere(tx: Parameters<NonNullable<Parameters<typeof runJobsTick>[2]['rateCheckHook']>>[0], jobId: string, itemId: string, posts: number, at: Date) {
    const intent = (await tx.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt))).at(-1)!;
    const before = await tx.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.jobId, jobId));
    for (let k = 0; k < posts; k++) {
      await tx.insert(schema.remoteSteps).values({
        ownerId: owner,
        jobId,
        intentId: intent.id,
        itemId,
        stepIndex: before.length + k,
        kind: 'publish',
        postIndex: k,
        remoteId: `mockthr_post_race${k}_${randomUUID().replace(/-/g, '')}`,
        status: 'published',
        resumeCount: 0,
        createdAt: at,
        updatedAt: at,
      });
    }
    await tx.update(schema.jobs).set({ state: 'CONFIRMED', doneAt: at, leaseOwner: null, leaseUntil: null }).where(eq(schema.jobs.id, jobId));
  }

  it.each(['after_usage', 'before_snapshot'] as const)(
    'P1 round 2: 한도 3, A·B 각 2개 — A 의 게시 기록·CONFIRMED 가 B 의 검사 중(%s)에 커밋돼도 B 는 제한(전송 의도 0, 합계 ≤ 3)',
    async (phase) => {
      registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT, max_units: 3, window_sec: 3600 };
      const acc = await linkedThreadsAccount();
      const a = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.slice(0, 2).join('\n\n'), scenario: 'threads_container_slow' }]);
      await execute(a.planId);
      await tick(1000);
      const ja = await jobOf(a.items[0]!.id);
      expect(ja.state).toBe('REMOTE_PROCESSING'); // 진행 중, 게시 단계 0(남은 2)
      expect((await stepsOf(a.items[0]!.id)).filter((s) => s.kind === 'publish')).toHaveLength(0);
      const b = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.slice(0, 2).join('\n\n') }]);
      await execute(b.planId);
      const jb0 = await jobOf(b.items[0]!.id);
      let fired = 0;
      vt += 1000;
      await runJobsTick(db, registry, {
        workerId: 't14-race-w',
        config,
        ownerId: owner,
        clock: () => new Date(Date.now() + vt),
        random: () => 0.5,
        submitTimeoutMs: 5000,
        maxJobs: 20,
        credentials: jobCredentials(config, db),
        rateCheckHook: async (tx, at) => {
          if (at.jobId !== jb0.id || at.phase !== phase || fired++) return;
          await finishElsewhere(tx, ja.id, a.items[0]!.id, 2, new Date(Date.now() + vt));
        },
      });
      expect(fired).toBe(1);
      expect((await jobOf(a.items[0]!.id)).state).toBe('CONFIRMED');
      const jb = await jobOf(b.items[0]!.id);
      expect(jb.state).toBe('RETRY_WAIT');
      expect(jb.lastErrorCode).toBe('local_rate_limited');
      expect(await intentsOf(jb.id)).toHaveLength(0);
      expect((await stepsOf(b.items[0]!.id)).filter((s) => s.kind === 'publish')).toHaveLength(0);
      const d = (await eventDetails(jb.id)).find((x) => x.transition === 'local_rate_limited')!;
      // 한 스냅샷: 끼어든 커밋 앞이면 사용 0 + 예약 2, 뒤면 사용 2 + 예약 0 — 어느 쪽이든 합계 2 + 이번 2 > 3
      expect(phase === 'after_usage' ? { used: 0, inflight: 2 } : { used: 2, inflight: 0 }).toEqual({ used: d.used, inflight: d.inflight });
      expect(d.needed).toBe(2);
    },
  );

  it('missed: publish 성공 직후 단계 기록 실패 → 결과 불명 → 조회가 컨테이너로 게시물을 찾아 기록·CONFIRMED(재게시 0)', async () => {
    class FlakyStepThreads extends ThreadsMockChannelAdapter {
      failPublishRecord = true;
      override async submit(prepared: Parameters<ThreadsMockChannelAdapter['submit']>[0], c: Parameters<ThreadsMockChannelAdapter['submit']>[1]) {
        const steps = c.steps!;
        const wrapped: RemoteStepsPort = {
          list: () => steps.list(),
          record: async (s) => {
            if (s.kind === 'publish' && this.failPublishRecord) {
              this.failPublishRecord = false;
              throw new Error('simulated db failure');
            }
            return steps.record(s);
          },
        };
        return super.submit(prepared, { ...c, steps: wrapped });
      }
    }
    const reg = new MockChannelAdapterRegistry(registry.mock, new FlakyStepThreads({ api }));
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tickWith(reg);
    expect((await jobOf(itemId)).state).toBe('RECONCILING');
    expect(await stepSig(itemId)).toEqual(['container:0:finished']);
    expect(api.postsOf(acc.external)).toHaveLength(1);
    await tick(11_000);
    expect((await jobOf(itemId)).state).toBe('CONFIRMED');
    expect(await stepSig(itemId)).toEqual(['container:0:finished', 'publish:0:published']);
    expect(api.postsOf(acc.external)).toHaveLength(1);
    expect(api.publishCount.get((await containersOf(itemId))[0]!)).toBe(1);
  });

  it('missed: 단계 기록 직후 lease 상실(다음 원격 호출 전 heartbeat 실패) → 만료 복구 → 조회 → 남은 게시물만 이어서, 재게시 0', async () => {
    class LeaseThief extends ThreadsMockChannelAdapter {
      stolen = false;
      override async submit(prepared: Parameters<ThreadsMockChannelAdapter['submit']>[0], c: Parameters<ThreadsMockChannelAdapter['submit']>[1]) {
        const steps = c.steps!;
        const wrapped: RemoteStepsPort = {
          list: () => steps.list(),
          record: async (s) => {
            const r = await steps.record(s);
            if (s.kind === 'publish' && !this.stolen) {
              this.stolen = true;
              await db.execute(sql`update jobs set lease_owner = 'thief', lease_until = now() - interval '1 second' where id = ${c.jobId}::uuid`);
            }
            return r;
          },
        };
        return super.submit(prepared, { ...c, steps: wrapped });
      }
    }
    const reg = new MockChannelAdapterRegistry(registry.mock, new LeaseThief({ api }));
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.slice(0, 2).join('\n\n') }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tickWith(reg);
    expect(api.postsOf(acc.external)).toHaveLength(1);
    expect(await drainUntil(itemId, ['CONFIRMED', 'FAILED', 'UNKNOWN'], 20)).toBe('CONFIRMED');
    expect(api.postsOf(acc.external)).toHaveLength(2);
    for (const c of await containersOf(itemId)) expect(api.publishCount.get(c)).toBe(1);
  });

  it('조사: 별도 worker 프로세스(모의 OAuth·Threads 시뮬레이터 메모리가 비어 있음) → 원격 401 → BLOCKED, 게시·결과 0(거짓 성공 없음)', async () => {
    // 같은 DB, 다른 프로세스 흉내: 이 프로세스의 OAuth 발급 기록을 모르는 시뮬레이터
    const freshApi = new ThreadsMockApi({ tokenCheck: mockOAuthTokenCheck(new MockOAuthStore()) });
    const reg = new MockChannelAdapterRegistry(registry.mock, new ThreadsMockChannelAdapter({ api: freshApi }));
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: P1 }]);
    const itemId = p.items[0]!.id;
    await execute(p.planId);
    await tickWith(reg);
    expect(await jobOf(itemId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'auth_invalid_token' });
    expect(freshApi.postsOf(acc.external)).toHaveLength(0);
    expect(api.postsOf(acc.external)).toHaveLength(0);
    expect(await pubsOf(itemId)).toHaveLength(0);
  });
});

describe('비밀 — 접근 토큰은 어디에도 나가지 않는다', () => {
  it('콘솔·응답·감사·작업 이력·전송 의도·단계·결과·내보내기 묶음에 토큰 없음(단계는 내보내기만)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await plan([{ accountId: acc.id, channel: 'threads', body: THREE.join('\n\n'), scenario: 'threads_thread_partial' }]);
    await execute(p.planId);
    await drainUntil(p.items[0]!.id, ['CONFIRMED']);
    const at = await accessTokenOf(acc.id);
    expect(at).toMatch(/^mockthr_at_/);
    const dump = async (t: unknown) => JSON.stringify(await db.select().from(t as typeof schema.auditEvents));
    for (const t of [schema.auditEvents, schema.jobEvents, schema.sendIntents, schema.remoteSteps, schema.publications, schema.jobs, schema.mockScenarios]) {
      expect(await dump(t)).not.toContain(at);
    }
    for (const s of seen) expect(s).not.toContain(at);
    for (const l of logs) expect(l).not.toContain(at);
    const ex = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { outDir: path.join(tmp, 'exports') });
    expect(ex.manifest.tables.remote_steps!.rows).toBeGreaterThan(0);
    const raw = readFileSync(ex.zipPath);
    expect(raw.includes(Buffer.from(at))).toBe(false);
    const parsed = await parseBundleZip(raw);
    expect(parsed.tables.remote_steps.every((r) => r.remote_id.startsWith('mockthr_'))).toBe(true);
  });
});

describe('drill:mock 의 Threads 행(같은 표)', () => {
  it('불변식 위반 0·fetch 0, 표가 기대와 같다(중복 컨테이너·중복 게시 없음, 스레드 전체 전 publication 없음)', async () => {
    const r = await runThreadsDrill();
    expect(r.violations).toEqual([]);
    expect(r.fetch_calls).toBe(0);
    expect(r.rows.every((x) => x.ok)).toBe(true);
    const table = Object.fromEntries(threadsDrillTableRows(r).map((c) => [c[0], c.slice(1)]));
    const P = 'MOCK UPLOADED_PRIVATE/private';
    expect(table).toEqual({
      'threads_success · 1개': ['1', 'CONFIRMED', 'CONFIRMED', '1', '1', '1', P, '없음'],
      'threads_success · 스레드 3개': ['3', 'CONFIRMED', 'CONFIRMED', '1', '3', '3', P, '없음'],
      'threads_container_slow → 같은 컨테이너': ['1', 'CONFIRMED', 'CONFIRMED', '2', '1', '1', P, '없음'],
      'threads_publish_timeout_sent → 조회로 확인': ['1', 'CONFIRMED', 'CONFIRMED', '1', '1', '1', P, '없음'],
      'threads_publish_timeout_not_sent → 같은 컨테이너로 게시': ['1', 'CONFIRMED', 'CONFIRMED', '2', '1', '1', P, '없음'],
      'threads_thread_partial → 3번째부터 이어서': ['3', 'CONFIRMED', 'CONFIRMED', '2', '3', '3', P, '없음'],
      'threads_rate_limited(429) → 재시도': ['1', 'CONFIRMED', 'CONFIRMED', '2', '1', '1', P, '없음'],
      'threads_token_invalid(401)': ['1', 'BLOCKED', 'BLOCKED', '1', '0', '0', '없음', '없음'],
      'threads_text_too_long(400)': ['1', 'FAILED', 'FAILED', '1', '0', '0', '없음', '없음'],
      '로컬 요청 제한 · 1번째': ['1', 'CONFIRMED', 'CONFIRMED', '1', '1', '1', P, '없음'],
      '로컬 요청 제한 · 2번째(창 뒤, 의도 없이 대기)': ['1', 'CONFIRMED', 'CONFIRMED', '1', '1', '1', P, '없음'],
      '재시작(모의 Threads 기록 유실) → UNKNOWN': ['1', 'UNKNOWN', 'UNKNOWN', '1', '1', '0', '없음', '없음'],
    });
    expect(formatThreadsDrillTable(r)).not.toMatch(/게시 완료|공개 게시 성공/);
  }, 120_000);
});
