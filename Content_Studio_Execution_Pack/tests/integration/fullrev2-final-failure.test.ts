/**
 * FIX2-FULLREV(Q1·Q4, 사용자 결정 2026-10-22 "다 권고 사항으로 진행해줘"):
 * - Q1: 전송 뒤 최종 실패(영구 거부·일시 오류 재시도 소진 — finishSend, 조회의 not_found 시도 한도·원격 처리 실패 — applyReconcile)인데 이미 게시된 부분
 *   (publish·video 단계)이 있으면 FAILED("게시되지 않음" — 화면이 새 계획을 열어 게시된 부분을 처음부터 다시 게시)가 아니라 UNKNOWN(thread_partial_failed).
 *   게시된 부분이 없으면 지금까지와 같은 FAILED(사건 모양 그대로).
 * - Q4: 이미 취소 요청 시각이 있는 작업은 뒤의 정리가 그 시각을 덮어쓰지 않는다(처음 요청 시각 유지).
 * - FX2(독립 검토 후속): 조회 한도(확인 불가·원격 처리)로 UNKNOWN 인데 게시된 게시물이 있으면 사유 thread_partial_unresolved("새 계획 필요" 아님).
 * - FX5(독립 검토 후속): REMOTE_PROCESSING 에서의 원격 처리 실패도 게시된 부분이 있으면 UNKNOWN(thread_partial_failed).
 * 모의 Threads 만 — **네트워크 호출 0**(fetch 0 확인).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { cancelItem, closeDb, createContent, createVariantDraft, getDb, leaseJobs, processJob, runJobsTick, schema, seed, setVariantLifecycle, type Db } from '@cs/db';
import { loadConfig, RECONCILE_MAX_ATTEMPTS, REMOTE_POLL_MAX } from '@cs/domain';
import { createMockAdapterRegistry, THREADS_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as revokePOST } from '../../apps/web/app/api/approvals/[id]/revoke/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { blockInfoOf, itemHeadline, liveItemHeadline, UNKNOWN_JOB_LINE_BY_KIND, UNKNOWN_JOB_LINE_PARTIAL_MOCK, UNKNOWN_STATUS_LABEL_BY_KIND } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { itemStatusText, jobStatusTextFor } from '../../apps/web/lib/record-labels';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const config = loadConfig({});
const registry = createMockAdapterRegistry();
const api = registry.threads.api;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let vt = 0;
let fetchCalls = 0;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));

async function connectFully(accountId: string): Promise<void> {
  const c = await connectPOST(post(`/api/channel-accounts/${accountId}/connect`), ctx(accountId));
  expect(c.status).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  const a = await mockAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(a.status).toBe(303);
  const cb = await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
}

/** 새 모의 Threads 계정 + T13 모의 OAuth 연결(→ Threads 모의 어댑터) */
async function linkedThreadsAccount(): Promise<{ id: string; external: string }> {
  const external = `mock:threads:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads FIX2', state: 'mock_ready' })
    .returning();
  await connectFully(row!.id);
  return { id: row!.id, external };
}

const P1 = '해외 영업 첫 달, 대리점 재고 기준부터 합의했다.';
const THREE = ['첫째 — 재고 기준을 먼저 합의했다.', '둘째 — 가격표는 마지막에 확정했다.', '셋째 — 매주 같은 요일에 숫자를 맞췄다.'];

interface Planned {
  planId: string;
  item: { id: string; payload_hash: string };
}
/** 원고 → Threads 파생본(review) → 계획(항목 1개) → (모의 시나리오) → 승인(mock_publish) → 실행 */
async function executed(accountId: string, body: string, scenario?: string): Promise<Planned> {
  const { content } = await createContent(db, owner, { title: `FIX2 ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variant.id, channel_account_id: accountId }] }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
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
  expect((await approve(p.plan.id, item)).status).toBe(200);
  expect((await execute(p.plan.id)).status).toBe(200);
  return { planId: p.plan.id, item };
}
const approve = (planId: string, item: { id: string; payload_hash: string }) =>
  approvePOST(
    post(`/api/distribution-plans/${planId}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
    ctx(planId),
  );
const execute = (planId: string) => executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId));
const retry = (itemId: string) => retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));
const cancel = (itemId: string) => cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId));

const runOpts = () => ({
  workerId: 'fix2-w',
  config,
  ownerId: owner,
  clock: () => new Date(Date.now() + vt),
  random: () => 0.5,
  submitTimeoutMs: 5000,
  maxJobs: 20,
  credentials: jobCredentials(config, db),
});
async function tick(advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, runOpts());
}
async function leaseOnly(planId: string, itemId: string) {
  const leased = await leaseJobs(db, { workerId: 'fix2-w', now: new Date(Date.now() + vt), limit: 1, ownerId: owner, planId });
  expect(leased).toHaveLength(1);
  expect(leased[0]).toMatchObject({ itemId, state: 'LEASED', leaseOwner: 'fix2-w' });
  return leased[0]!;
}

const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const planOf = async (planId: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, planId)))[0]!;
const eventsDesc = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(desc(schema.jobEvents.eventSeq));
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const containersOf = async (itemId: string) =>
  (await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId))).filter((s) => s.kind === 'container').map((s) => s.remoteId);

/** 3개 스레드에서 1·2번째 게시 뒤 3번째 publish 429 → RETRY_WAIT(게시 2, 시도 1) */
async function partialThread() {
  const acc = await linkedThreadsAccount();
  const p = await executed(acc.id, THREE.join('\n\n'));
  api.setRateBudget(acc.external, 2, 60);
  await tick();
  const [job] = await jobsOf(p.item.id);
  expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited', attempt: 1 });
  expect(api.postsOf(acc.external)).toHaveLength(2);
  api.clearRateBudget(acc.external);
  return { acc, ...p, jobId: job!.id };
}

/**
 * 전송 도중(어댑터 submit 안) 원격 단계가 기록된 직후에 끼어드는 훅 — 게시물 사이에 장애를 거는 데 쓴다. 한 번의 submit 에만 걸린다.
 */
function duringSubmit(onRecorded: (step: { kind: string; post_index: number }) => Promise<void> | void) {
  const adapter = registry.threads;
  const original = adapter.submit.bind(adapter);
  return vi.spyOn(adapter, 'submit').mockImplementationOnce(async (prepared, c) => {
    const steps = c.steps!;
    const record: typeof steps.record = async (s) => {
      const r = await steps.record(s);
      await onRecorded(s);
      return r;
    };
    return original(prepared, { ...c, steps: { ...steps, record } });
  });
}

/** 철회·실패 뒤 이 항목으로는 다시 승인·실행·재시도·취소할 수 없고, 작업 처리기를 돌려도 더 게시하지 않는다(처음부터 다시 보내지 않음). */
async function expectNoRepublish(x: { acc: { external: string }; planId: string; item: { id: string; payload_hash: string } }, posts: number) {
  const ap = await approve(x.planId, x.item);
  expect(ap.status).toBe(409);
  expect(await ap.json()).toMatchObject({ error: 'item_not_planned' });
  const ex = await execute(x.planId);
  expect(ex.status).toBe(409);
  expect(await ex.json()).toMatchObject({ error: 'already_executed' });
  expect((await retry(x.item.id)).status).toBe(409);
  expect((await cancel(x.item.id)).status).toBe(409);
  await tick(20 * MIN);
  await tick(20 * MIN);
  expect(api.postsOf(x.acc.external)).toHaveLength(posts);
  expect(await jobsOf(x.item.id)).toHaveLength(1);
  for (const c of await containersOf(x.item.id)) expect(api.publishCount.get(c) ?? 0).toBeLessThanOrEqual(1);
}

/** 계획 페이지와 같은 입력(최근 작업의 이력, 최신 먼저)으로 만든 항목 문구·상태 태그·작업 줄 */
async function screenOf(job: typeof schema.jobs.$inferSelect) {
  const block = blockInfoOf(await eventsDesc(job.id), job);
  return {
    headline: itemHeadline({ status: 'UNKNOWN', channel: 'threads', job, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false }),
    tag: itemStatusText('UNKNOWN', { live: false, verification: null, lastErrorCode: job.lastErrorCode }),
    // FIX2-FULLREV(FX6): 페이지가 부르는 함수(모의 카드 live=false) 그대로
    line: jobStatusTextFor(job, null, block.code, 'threads', false),
  };
}

/** (FIX2-FULLREV FX2: Q1·FX2 describe 가 함께 쓰도록 모듈 수준) threads_thread_partial(1·2 게시 → 3번째 결과 불명 RECONCILING) 또는 threads_publish_timeout_not_sent(게시 0 → RECONCILING) */
async function reconciling(scenario: 'threads_thread_partial' | 'threads_publish_timeout_not_sent', posts: number) {
  const acc = await linkedThreadsAccount();
  const x = { acc, ...(await executed(acc.id, scenario === 'threads_thread_partial' ? THREE.join('\n\n') : P1, scenario)) };
  await tick();
  const [job] = await jobsOf(x.item.id);
  expect(job!.state).toBe('RECONCILING');
  expect(api.postsOf(acc.external)).toHaveLength(posts);
  await db.update(schema.jobs).set({ maxAttempts: 1 }).where(eq(schema.jobs.id, job!.id));
  return { ...x, jobId: job!.id };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix2-ff-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FIX2 시험: 네트워크 호출 금지');
  });
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
});
beforeEach(() => {
  registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT };
});
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('FIX2-FULLREV(Q1): 게시된 부분이 있는 작업의 전송 뒤 최종 실패 → FAILED 가 아니라 UNKNOWN(thread_partial_failed)', () => {
  /** 마지막 두 사건: SENDING → BLOCKED(원인·결과 기록) → cancel_partial(BLOCKED → UNKNOWN) */
  async function expectSendingFailStop(jobId: string, reason: string, errorCode: string, parts: number) {
    const [last, prev] = await eventsDesc(jobId);
    expect(prev).toMatchObject({ stateBefore: 'SENDING', stateAfter: 'BLOCKED' });
    expect(prev!.sanitizedDetails).toMatchObject({ transition: 'blocked', reason, status: 'rejected', error_code: errorCode, not_sent: false, published_parts: parts, publish_attempts: 0 });
    expect(last).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
    expect(last!.sanitizedDetails).toMatchObject({ transition: 'cancel_partial', cause: reason, error_code: errorCode, not_sent: false, published_parts: parts, publish_attempts: 0 });
  }

  it('(a) 영구 거부(403) — 같은 시도 안에서 1·2번째 게시 뒤 3번째 거절: UNKNOWN(thread_partial_failed) · 의도 rejected · 항목 UNKNOWN·계획 확인 필요 · 화면 문구에 "새 계획" 없음 · 게시 2개 그대로', async () => {
    const acc = await linkedThreadsAccount();
    const x = { acc, ...(await executed(acc.id, THREE.join('\n\n'))) };
    const spy = duringSubmit((s) => {
      if (s.kind === 'publish' && s.post_index === 1) api.injectFault({ op: 'publish', kind: 'permission_denied', userId: acc.external });
    });
    try {
      expect((await tick()).results).toEqual({ UNKNOWN: 1 });
    } finally {
      spy.mockRestore();
    }
    expect(api.postsOf(acc.external)).toHaveLength(2);
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_failed', lastRetryClass: 'permanent', leaseOwner: null, attempt: 1 });
    // 아무도 취소를 요청하지 않았다 — 취소 요청 시각을 쓰지 않는다
    expect(job!.cancelRequestedAt).toBeNull();
    await expectSendingFailStop(job!.id, 'permanent_failure', 'permission_denied', 2);
    const intents = await intentsOf(job!.id);
    expect(intents.map((i) => i.outcome)).toEqual(['rejected']);
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect((await planOf(x.planId)).status).toBe('attention');
    const s = await screenOf(job!);
    expect(s.headline).toBe('일부만 게시됨(MOCK) — 남은 게시물 전송 실패(원격 거절), 남은 게시물은 보내지 않음, 게시된 부분은 원격에 남음(자동 재전송 안 함)');
    expect(s.tag).toBe(UNKNOWN_STATUS_LABEL_BY_KIND.partial.mock);
    expect(s.line).toBe(UNKNOWN_JOB_LINE_PARTIAL_MOCK);
    expect(s.line).not.toBe(UNKNOWN_JOB_LINE_BY_KIND.partial);
    for (const t of [s.headline, s.tag, s.line]) expect(t).not.toContain('새 계획');
    for (const t of [s.headline, s.tag, s.line]) expect(t).not.toContain('직접 확인');
    await expectNoRepublish(x, 2);
  });

  it('(b) 일시 오류(429) 재시도 소진 — 앞선 시도가 1·2번째 게시, 마지막 시도의 3번째 429: UNKNOWN(thread_partial_failed, 원인 재시도 한도) · 게시 2개 그대로', async () => {
    const x = await partialThread();
    await db.update(schema.jobs).set({ maxAttempts: 2 }).where(eq(schema.jobs.id, x.jobId));
    api.setRateBudget(x.acc.external, 0, 60);
    try {
      expect((await tick(2 * MIN)).results).toEqual({ UNKNOWN: 1 });
    } finally {
      api.clearRateBudget(x.acc.external);
    }
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_failed', lastRetryClass: 'transient_no_side_effect', attempt: 2 });
    expect(job!.cancelRequestedAt).toBeNull();
    await expectSendingFailStop(job!.id, 'max_attempts', 'rate_limited', 2);
    expect((await intentsOf(job!.id)).map((i) => i.outcome)).toEqual(['rejected', 'rejected']);
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    const s = await screenOf(job!);
    expect(s.headline).toContain('남은 게시물 전송 실패(일시 오류 재시도 한도)');
    expect(s.headline).not.toContain('새 계획');
    expect(s.tag).not.toContain('새 계획 필요');
    await expectNoRepublish(x, 2);
  });

  it('(c) 게시된 것이 없으면 지금까지와 같다 — 단일 게시물 403 → FAILED(permission_denied) · 컨테이너만 만든 뒤 429 시도 한도 → FAILED(max_attempts), 사건에 부분 게시 기록 없음', async () => {
    const a1 = await linkedThreadsAccount();
    const p1 = await executed(a1.id, P1);
    api.injectFault({ op: 'publish', kind: 'permission_denied', userId: a1.external });
    expect((await tick()).results).toEqual({ FAILED: 1 });
    const [j1] = await jobsOf(p1.item.id);
    expect(j1).toMatchObject({ state: 'FAILED', lastErrorCode: 'permission_denied', lastRetryClass: 'permanent' });
    const [e1] = await eventsDesc(j1!.id);
    expect(e1).toMatchObject({ stateBefore: 'SENDING', stateAfter: 'FAILED' });
    expect(e1!.sanitizedDetails).toMatchObject({ transition: 'permanent_failure', status: 'rejected', error_code: 'permission_denied' });
    expect(e1!.sanitizedDetails).not.toHaveProperty('published_parts');
    expect(e1!.sanitizedDetails).not.toHaveProperty('not_sent');
    expect((await itemOf(p1.item.id)).status).toBe('FAILED');
    expect(api.postsOf(a1.external)).toHaveLength(0);
    expect(await containersOf(p1.item.id)).toHaveLength(1);

    const a2 = await linkedThreadsAccount();
    const p2 = await executed(a2.id, P1);
    const [q2] = await jobsOf(p2.item.id);
    await db.update(schema.jobs).set({ maxAttempts: 1 }).where(eq(schema.jobs.id, q2!.id));
    api.setRateBudget(a2.external, 0, 60);
    try {
      expect((await tick()).results).toEqual({ FAILED: 1 });
    } finally {
      api.clearRateBudget(a2.external);
    }
    const [j2] = await jobsOf(p2.item.id);
    expect(j2).toMatchObject({ state: 'FAILED', lastErrorCode: 'rate_limited' });
    const [e2] = await eventsDesc(j2!.id);
    expect(e2).toMatchObject({ stateBefore: 'SENDING', stateAfter: 'FAILED' });
    expect(e2!.sanitizedDetails).toMatchObject({ transition: 'permanent_failure', reason: 'max_attempts', error_code: 'rate_limited' });
    expect(e2!.sanitizedDetails).not.toHaveProperty('published_parts');
    expect((await itemOf(p2.item.id)).status).toBe('FAILED');
    expect(api.postsOf(a2.external)).toHaveLength(0);
  });

  const INCONSISTENT = [
    { name: 'not_found(확실히 없음 — 시도 한도)', r: { status: 'not_found', error_code: 'no_remote_steps' }, cause: 'max_attempts', failedCode: null },
    { name: 'failed(원격 처리 실패)', r: { status: 'failed', error_code: 'container_error' }, cause: 'remote_failed', failedCode: 'container_error' },
  ] as const;
  for (const c of INCONSISTENT) {
    it(`(d) 조회가 ${c.name}를 보고 — 단계 기록에 게시 2개가 있으면 FAILED 가 아니라 UNKNOWN(thread_partial_failed) · 게시가 없으면 지금처럼 FAILED`, async () => {
      const x = await reconciling('threads_thread_partial', 2);
      const spy = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce({ ...c.r });
      try {
        expect((await tick(11_000)).results).toEqual({ UNKNOWN: 1 });
      } finally {
        spy.mockRestore();
      }
      const [job] = await jobsOf(x.item.id);
      expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_failed', leaseOwner: null });
      expect(job!.cancelRequestedAt).toBeNull();
      const [last] = await eventsDesc(job!.id);
      expect(last).toMatchObject({ stateBefore: 'RECONCILING', stateAfter: 'UNKNOWN' });
      expect(last!.sanitizedDetails).toMatchObject({
        transition: 'reconcile_unsupported',
        reason: 'thread_partial_failed',
        cause: c.cause,
        reconcile: c.r.status,
        error_code: c.r.error_code,
        not_sent: false,
        published_parts: 2,
        publish_attempts: 0,
      });
      expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
      const s = await screenOf(job!);
      // 조회 중 멈춤은 BLOCKED 사건이 없어 원인을 단정하지 않는다
      expect(s.headline).toContain('남은 게시물 전송 실패(원격 거절·재시도 한도·원격 처리 실패 중 하나)');
      for (const t of [s.headline, s.tag, s.line]) expect(t).not.toContain('새 계획');
      await expectNoRepublish(x, 2);

      // 게시가 없는 같은 모양(게시 시간 초과 — 원격 게시 안 됨, 게시 0)은 지금처럼 FAILED
      const z = await reconciling('threads_publish_timeout_not_sent', 0);
      const spy2 = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce({ ...c.r });
      try {
        expect((await tick(11_000)).results).toEqual({ FAILED: 1 });
      } finally {
        spy2.mockRestore();
      }
      const [zj] = await jobsOf(z.item.id);
      expect(zj!.state).toBe('FAILED');
      // 원격 처리 실패는 그 코드를 남긴다(not_found 시도 한도는 앞선 코드를 그대로 둔다 — 지금까지와 같음)
      if (c.failedCode) expect(zj!.lastErrorCode).toBe(c.failedCode);
      expect(zj!.lastErrorCode).not.toBe('thread_partial_failed');
      const [ze] = await eventsDesc(zj!.id);
      expect(ze).toMatchObject({ stateBefore: 'RECONCILING', stateAfter: 'FAILED' });
      expect(ze!.sanitizedDetails).toMatchObject({ transition: 'permanent_failure', reason: c.cause });
      expect(ze!.sanitizedDetails).not.toHaveProperty('published_parts');
      expect((await itemOf(z.item.id)).status).toBe('FAILED');
    });
  }

  it('(e) FIX2-FULLREV(FX5): 원격 처리 중(REMOTE_PROCESSING — 3번째 컨테이너 IN_PROGRESS 보고) 조회가 failed(원격 처리 실패) — 단계 기록에 게시 2개 → FAILED 가 아니라 UNKNOWN(thread_partial_failed, REMOTE_PROCESSING 의 reconcile_unsupported)', async () => {
    const x = await reconciling('threads_thread_partial', 2);
    // 모의 Threads 가 IN_PROGRESS 컨테이너에 돌려주는 모양(threads-mock reconcile: processing·published_parts·container_in_progress) → REMOTE_PROCESSING
    const spy = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce({ status: 'processing', published_parts: 2, error_code: 'container_in_progress' });
    try {
      expect((await tick(11_000)).results).toEqual({ REMOTE_PROCESSING: 1 });
    } finally {
      spy.mockRestore();
    }
    // 이어서 원격 처리 실패(지금 Threads 어댑터는 게시가 있으면 돌려주지 않는 모양 — 조회 보고보다 단계 기록)
    const spy2 = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce({ status: 'failed', error_code: 'container_error' });
    try {
      expect((await tick(16_000)).results).toEqual({ UNKNOWN: 1 });
    } finally {
      spy2.mockRestore();
    }
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_failed', leaseOwner: null });
    expect(job!.cancelRequestedAt).toBeNull();
    const [last] = await eventsDesc(job!.id);
    expect(last).toMatchObject({ stateBefore: 'REMOTE_PROCESSING', stateAfter: 'UNKNOWN' });
    expect(last!.sanitizedDetails).toMatchObject({
      transition: 'reconcile_unsupported',
      reason: 'thread_partial_failed',
      cause: 'remote_failed',
      reconcile: 'failed',
      error_code: 'container_error',
      not_sent: false,
      published_parts: 2,
      publish_attempts: 0,
    });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    const s = await screenOf(job!);
    for (const t of [s.headline, s.tag, s.line]) expect(t).not.toContain('새 계획');
    await expectNoRepublish(x, 2);
  });
});

/**
 * FIX2-FULLREV(FX2): 조회 한도(확인 불가 RECONCILE_MAX_ATTEMPTS·원격 처리 REMOTE_POLL_MAX)로 UNKNOWN 이 될 때 단계 기록에 게시된 스레드 게시물이 있으면
 * 사유 코드 thread_partial_unresolved — 상태 태그·작업 줄·머리줄이 "재확인 또는 새 계획 필요"(새 계획은 게시된 부분을 처음부터 다시 게시)라고 하지 않는다.
 * 게시된 게시물이 없으면 지금까지와 같다(앞선 코드 그대로, 일반 UNKNOWN 문구).
 */
describe('FIX2-FULLREV(FX2): 조회 한도로 UNKNOWN 인데 게시된 게시물이 있음 → 사유 thread_partial_unresolved', () => {
  async function untilUnknown(itemId: string, advanceMs: number, max: number) {
    for (let i = 0; i < max; i++) {
      if ((await jobsOf(itemId))[0]!.state === 'UNKNOWN') break;
      await tick(advanceMs);
    }
    const [job] = await jobsOf(itemId);
    expect(job!.state).toBe('UNKNOWN');
    return job!;
  }
  const containerOf = async (itemId: string, postIndex: number) =>
    (await db.select().from(schema.remoteSteps).where(and(eq(schema.remoteSteps.itemId, itemId), eq(schema.remoteSteps.kind, 'container'), eq(schema.remoteSteps.postIndex, postIndex))))[0]!.remoteId;

  async function expectUnresolved(x: { acc: { external: string }; planId: string; item: { id: string; payload_hash: string } }, job: typeof schema.jobs.$inferSelect, stateBefore: string, extra: Record<string, unknown>) {
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_unresolved', leaseOwner: null });
    expect(job.cancelRequestedAt).toBeNull();
    const [last] = await eventsDesc(job.id);
    expect(last).toMatchObject({ stateBefore, stateAfter: 'UNKNOWN' });
    expect(last!.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported', reason: 'thread_partial_unresolved', not_sent: false, published_parts: 2, publish_attempts: 0, ...extra });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    const s = await screenOf(job);
    expect(s.headline).toBe('게시된 게시물이 있음(MOCK) — 조회 한도까지 나머지 결과를 확인하지 못함, 자동 재전송 안 함, 게시된 부분은 원격에 남음(재확인만 가능)');
    expect(s.tag).toBe(UNKNOWN_STATUS_LABEL_BY_KIND.partial.mock);
    expect(s.line).toBe(UNKNOWN_JOB_LINE_PARTIAL_MOCK);
    for (const t of [s.headline, s.tag, s.line]) expect(t).not.toContain('직접 확인');
    const live = liveItemHeadline({ status: 'UNKNOWN', channel: 'threads', job, pub: null, blockReason: null });
    // FIX4-FULLREV(S1, 사용자 결정 2026-10-23): (FIX3 R3 의 조건부 복구 꼬리를 뺌) 실제 머리줄은 다시 게시하지 않음·Threads 직접 확인만 — 조건부 복구 줄은
    // 실제 카드의 결과 불명 안내에 한 번만. 모의 머리줄·태그·작업 줄에도 그대로 없다
    expect(live).toBe('게시 뒤 결과 확인 불가(조회 한도) — 이미 게시된 부분이 있어 다시 게시하지 않음(되돌리지 않음). Threads 에서 직접 확인하세요');
    for (const t of [s.headline, s.tag, s.line, live]) expect(t).not.toContain('없을 때만');
    expect(live).not.toContain('새 배포 계획');
    for (const t of [s.headline, s.tag, s.line, live]) expect(t).not.toContain('새 계획');
    await expectNoRepublish(x, 2);
  }
  /** 게시된 게시물이 없는 같은 모양은 지금처럼 — 앞선 코드 그대로·사건에 부분 게시 기록 없음·일반 UNKNOWN 문구 */
  async function expectGenericUnknown(job: typeof schema.jobs.$inferSelect, codeBefore: string | null) {
    expect(job.lastErrorCode).toBe(codeBefore);
    const [last] = await eventsDesc(job.id);
    expect(last!.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported' });
    expect(last!.sanitizedDetails).not.toHaveProperty('published_parts');
    expect(last!.sanitizedDetails).not.toHaveProperty('not_sent');
    const s = await screenOf(job);
    expect(s.headline).toBe('확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요');
    expect(s.line).toBe('UNKNOWN · 확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요');
  }

  it('(a) 확인 불가 한도 — threads_thread_partial(1·2 게시, 3번째 결과 불명) 뒤 3번째 컨테이너 만료(재시작·만료 — D26) → 조회 unknown 3회 → UNKNOWN(thread_partial_unresolved) · 게시 0(게시 시간 초과 뒤 컨테이너 만료)은 지금처럼 앞선 코드', async () => {
    const x = await reconciling('threads_thread_partial', 2);
    api.expireContainer(await containerOf(x.item.id, 2));
    const job = await untilUnknown(x.item.id, 20 * MIN, RECONCILE_MAX_ATTEMPTS + 2);
    await expectUnresolved(x, job, 'RECONCILING', { checks: RECONCILE_MAX_ATTEMPTS, reconcile: 'unknown', error_code: 'container_expired' });

    const z = await reconciling('threads_publish_timeout_not_sent', 0);
    const codeBefore = (await jobsOf(z.item.id))[0]!.lastErrorCode;
    api.expireContainer(await containerOf(z.item.id, 0));
    await expectGenericUnknown(await untilUnknown(z.item.id, 20 * MIN, RECONCILE_MAX_ATTEMPTS + 2), codeBefore);
    expect(api.postsOf(z.acc.external)).toHaveLength(0);
  });

  it('(b) 원격 처리 한도 — 게시 2개 뒤 3번째 컨테이너 IN_PROGRESS 보고가 계속(REMOTE_PROCESSING) → REMOTE_POLL_MAX 에서 UNKNOWN(thread_partial_unresolved) · 게시 0 은 지금처럼 앞선 코드', async () => {
    const x = await reconciling('threads_thread_partial', 2);
    // 모의 Threads 가 IN_PROGRESS 컨테이너에 돌려주는 모양(threads-mock reconcile)을 계속 돌려준다
    const spy = vi.spyOn(registry.threads, 'reconcile').mockResolvedValue({ status: 'processing', published_parts: 2, error_code: 'container_in_progress' });
    let job: typeof schema.jobs.$inferSelect;
    try {
      job = await untilUnknown(x.item.id, 16_000, REMOTE_POLL_MAX + 2);
    } finally {
      spy.mockRestore();
    }
    await expectUnresolved(x, job, 'REMOTE_PROCESSING', { polls: REMOTE_POLL_MAX, reconcile: 'processing', error_code: 'container_in_progress' });

    const z = await reconciling('threads_publish_timeout_not_sent', 0);
    const codeBefore = (await jobsOf(z.item.id))[0]!.lastErrorCode;
    const spy2 = vi.spyOn(registry.threads, 'reconcile').mockResolvedValue({ status: 'processing', published_parts: 0, error_code: 'container_in_progress' });
    try {
      await expectGenericUnknown(await untilUnknown(z.item.id, 16_000, REMOTE_POLL_MAX + 2), codeBefore);
    } finally {
      spy2.mockRestore();
    }
  });
});

describe('FIX2-FULLREV(Q4): 이미 있는 취소 요청 시각은 뒤의 정리가 덮어쓰지 않는다(처음 요청 시각 유지)', () => {
  it('(a) 사용자 취소(t1 — 요청 시각, lease 뒤 보내기 전 → CANCEL_REQUESTED) → 작업 처리기가 t2(작업 처리기 시계 — 2분 넘게 뒤)에 보내기 직전 멈춤 → UNKNOWN, cancelRequestedAt === t1', async () => {
    const x = await partialThread();
    vt += 2 * MIN;
    const leased = await leaseOnly(x.planId, x.item.id);
    expect(await (await cancel(x.item.id)).json()).toMatchObject({ cancel_requested: true, state: 'CANCEL_REQUESTED' });
    const t1 = (await jobsOf(x.item.id))[0]!.cancelRequestedAt;
    expect(t1).not.toBeNull();
    // 작업 처리기 시계(Date.now() + vt)는 취소 요청 시각(실제 시계)보다 2분 넘게 뒤 — lease(60초)는 작업 처리기 시계 기준이라 아직 유효
    expect(runOpts().clock().getTime() - t1!.getTime()).toBeGreaterThan(MIN);
    expect((await processJob(db, registry, leased, runOpts())).state).toBe('UNKNOWN');
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested' });
    expect(job!.cancelRequestedAt!.getTime()).toBe(t1!.getTime());
    await expectNoRepublish(x, 2);
  });

  it('(b) LEASED + 취소 요청 시각이 이미 있음(t1) → 보내기 직전 취소 갈래(settlePartialStop LEASED 두 단계)가 t2 에 정리 → cancelRequestedAt === t1', async () => {
    const x = await partialThread();
    vt += 2 * MIN;
    const leased = await leaseOnly(x.planId, x.item.id);
    const t1 = new Date(Date.now() + vt - 30 * MIN);
    await db.update(schema.jobs).set({ cancelRequestedAt: t1 }).where(eq(schema.jobs.id, leased.id));
    const fresh = (await jobsOf(x.item.id))[0]!;
    expect(fresh).toMatchObject({ state: 'LEASED' });
    expect((await processJob(db, registry, fresh, runOpts())).state).toBe('UNKNOWN');
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested' });
    const [last, prev] = await eventsDesc(job!.id);
    expect(prev).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
    expect(last).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
    expect(job!.cancelRequestedAt!.getTime()).toBe(t1.getTime());
  });

  it('(c) 시작 전 사용자 취소(cancelItem, 부분 게시 → UNKNOWN) — 취소 요청 시각이 이미 있으면(t1) t2 의 취소가 덮어쓰지 않음 · 없으면 그 취소 시각(t2)', async () => {
    const a = await partialThread();
    const t1 = new Date(Date.now() + vt - 30 * MIN);
    await db.update(schema.jobs).set({ cancelRequestedAt: t1 }).where(eq(schema.jobs.id, a.jobId));
    const t2 = new Date(Date.now() + vt + 5 * MIN);
    expect(await cancelItem(db, owner, a.item.id, t2)).toMatchObject({ state: 'UNKNOWN', published_parts: 2, reason: 'thread_partial_canceled' });
    const [ja] = await jobsOf(a.item.id);
    expect(ja).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_canceled' });
    expect(ja!.cancelRequestedAt!.getTime()).toBe(t1.getTime());

    const b = await partialThread();
    expect((await jobsOf(b.item.id))[0]!.cancelRequestedAt).toBeNull();
    expect(await cancelItem(db, owner, b.item.id, t2)).toMatchObject({ state: 'UNKNOWN' });
    expect((await jobsOf(b.item.id))[0]!.cancelRequestedAt!.getTime()).toBe(t2.getTime());
  });

  it('(d) 사용자 승인 철회(부분 게시 대기 작업 → UNKNOWN) — 이미 있는 취소 요청 시각(t1)을 그대로 둔다', async () => {
    const x = await partialThread();
    const t1 = new Date(Date.now() + vt - 30 * MIN);
    await db.update(schema.jobs).set({ cancelRequestedAt: t1 }).where(eq(schema.jobs.id, x.jobId));
    const approvalId = (await db.select().from(schema.approvals).where(and(eq(schema.approvals.distributionItemId, x.item.id), isNull(schema.approvals.revokedAt))))[0]!.id;
    const res = await revokePOST(post(`/api/approvals/${approvalId}/revoke`, {}), ctx(approvalId));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ partial_job_ids: [x.jobId] });
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked' });
    expect(job!.cancelRequestedAt!.getTime()).toBe(t1.getTime());
  });
});
