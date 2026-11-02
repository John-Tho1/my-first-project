/**
 * FIX1-FULLREV2(G5·G8, 검토 기록 docs/handoffs/FULLREV2_CLAUDE_REVIEW.md):
 * - G5: 원격 처리 중(processing) 조회 수와 확인 불가(unknown·unsupported) 횟수를 따로 센다 — 처리 중 조회 2회 뒤 확인 불가 1회로 바로 UNKNOWN 이 되지 않는다.
 *   확인 불가는 마지막 processing·재개 이후 **연속** 3회째에만 UNKNOWN(D18), 처리 중 조회는 REMOTE_POLL_MAX(20) 예산을 따로 쓴다(사이에 낀 확인 불가는 세지 않음).
 * - G8: 계정 상태 변경(사용 중지 → 다시 사용)은 진행 중 항목(REMOTE_PROCESSING 등)의 활성 승인도 철회한다(invalidated:account_changed, 작업·항목 상태는 그대로).
 *   그 뒤 재개(resumable)로 다음 전송에 가면 보내기 직전 재검사가 approval_missing 으로 멈춘다 — 게시된 것이 없으면 항목 PLANNED, 스레드 일부가 게시됐으면 UNKNOWN.
 *   대기(QUEUED) 항목은 지금처럼 BLOCKED·PLANNED.
 *   G8 후속: 보내는 중(SENDING) 승인이 철회된 시도가 보류(auth)로 끝나면 BLOCKED·항목 BLOCKED(재시도·다시 승인 둘 다 막힌 막다른 길)가 아니라 approval_missing —
 *   게시된 것이 없으면 항목 PLANNED(다시 승인 가능), 스레드 일부가 게시됐으면 UNKNOWN(thread_partial_revoked).
 * 모의 Threads 만(T13 모의 OAuth 연결) — **네트워크 호출 0**(fetch 0 확인). 조회 결과는 모의 어댑터의 reconcile 을 한 번씩 바꿔 끼워 정한다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { closeDb, createContent, createVariantDraft, getDb, runJobsTick, schema, seed, setChannelAccountState, setVariantLifecycle, type Db } from '@cs/db';
import { loadConfig, RECONCILE_MAX_ATTEMPTS, REMOTE_POLL_MAX, type AdapterResult, type ReconcileResult } from '@cs/domain';
import { createMockAdapterRegistry, THREADS_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { jobCredentials } from '../../apps/web/lib/oauth';
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
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads FR2', state: 'mock_ready' })
    .returning();
  await connectFully(row!.id);
  return { id: row!.id, external };
}

const P1 = '해외 영업 둘째 달, 대리점 주문 주기를 먼저 맞췄다.';
const THREE = ['첫째 — 주문 주기를 먼저 맞췄다.', '둘째 — 재고 표는 주마다 갱신했다.', '셋째 — 가격 조정은 분기마다 했다.'];

interface Planned {
  planId: string;
  item: { id: string; payload_hash: string };
}
/** 원고 → Threads 파생본(review) → 계획(항목 1개) → (모의 시나리오) → 승인(mock_publish) → 실행 */
async function executed(accountId: string, body: string, scenario?: string): Promise<Planned> {
  const { content } = await createContent(db, owner, { title: `FR2 ${randomUUID().slice(0, 6)}`, body });
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
  const ap = await approvePOST(
    post(`/api/distribution-plans/${p.plan.id}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
    ctx(p.plan.id),
  );
  expect(ap.status, await ap.clone().text()).toBe(200);
  const ex = await executePOST(post(`/api/distribution-plans/${p.plan.id}/execute`, { command_key: `k-${randomUUID()}` }), ctx(p.plan.id));
  expect(ex.status, await ex.clone().text()).toBe(200);
  return { planId: p.plan.id, item };
}
const cancel = (itemId: string) => cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId));

/** 이 계획의 작업만 처리(다른 시험의 작업과 섞이지 않게) */
async function tick(planId: string, advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 'fr2-w',
    config,
    ownerId: owner,
    planId,
    clock: () => new Date(Date.now() + vt),
    random: () => 0.5,
    submitTimeoutMs: 5000,
    maxJobs: 5,
    credentials: jobCredentials(config, db),
  });
}

const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));
const approvalsOf = (itemId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId)).orderBy(asc(schema.approvals.approvedAt));

const PROCESSING: ReconcileResult = { status: 'processing', published_parts: 0, error_code: 'container_in_progress' };
const UNREADABLE: ReconcileResult = { status: 'unknown', error_code: 'container_status_unreadable' };

/** 모의 Threads 의 첫 전송이 원격 처리 중(processing)을 돌려준다 → REMOTE_PROCESSING(reconcile_count 0, 시도 1). 게시물 0. */
async function remoteProcessing(body = P1) {
  const acc = await linkedThreadsAccount();
  const x = await executed(acc.id, body);
  const processing: AdapterResult = { status: 'processing', error_code: 'container_in_progress' };
  const submit = vi.spyOn(registry.threads, 'submit').mockResolvedValueOnce(processing);
  try {
    expect((await tick(x.planId)).results).toEqual({ REMOTE_PROCESSING: 1 });
  } finally {
    submit.mockRestore();
  }
  const [job] = await jobsOf(x.item.id);
  expect(job).toMatchObject({ state: 'REMOTE_PROCESSING', reconcileCount: 0, attempt: 1 });
  expect((await itemOf(x.item.id)).status).toBe('REMOTE_PROCESSING');
  return { acc, ...x, jobId: job!.id };
}

/** 조회 한 번 — 모의 어댑터의 reconcile 이 r 을 돌려주게 하고 이 계획의 작업만 처리 */
async function check(planId: string, r: ReconcileResult, advanceMs = MIN) {
  const spy = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce({ ...r });
  try {
    return (await tick(planId, advanceMs)).results;
  } finally {
    spy.mockRestore();
  }
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr2-ps-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FR2 시험: 네트워크 호출 금지');
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

describe('FIX1-FULLREV2(G5): 원격 처리 중 조회 수와 확인 불가 횟수를 따로 센다', () => {
  it('(a) processing 2회 → 확인 불가 1회: UNKNOWN 이 아니라 REMOTE_PROCESSING(reconcile_retry, checks 1, 10초 뒤) · 확인 불가가 연속 3회째에만 UNKNOWN', async () => {
    const x = await remoteProcessing();
    for (let i = 1; i <= 2; i++) {
      expect(await check(x.planId, PROCESSING)).toEqual({ REMOTE_PROCESSING: 1 });
      expect((await jobsOf(x.item.id))[0]).toMatchObject({ state: 'REMOTE_PROCESSING', reconcileCount: 0 });
    }
    expect(await check(x.planId, UNREADABLE)).toEqual({ REMOTE_PROCESSING: 1 });
    const [j1] = await jobsOf(x.item.id);
    expect(j1).toMatchObject({ state: 'REMOTE_PROCESSING', reconcileCount: 1, leaseOwner: null });
    const e1 = (await eventsOf(x.jobId)).at(-1)!;
    expect(e1).toMatchObject({ stateBefore: 'REMOTE_PROCESSING', stateAfter: 'REMOTE_PROCESSING' });
    expect(e1.sanitizedDetails).toMatchObject({ transition: 'reconcile_retry', reconcile: 'unknown', checks: 1, error_code: 'container_status_unreadable' });
    // D18: 확인 불가 재조회 간격 10초 × 2^(n-1) — 첫 확인 불가는 10초
    expect(j1!.nextRunAt.getTime() - e1.at.getTime()).toBe(10_000);
    expect((await itemOf(x.item.id)).status).toBe('REMOTE_PROCESSING');

    expect(await check(x.planId, UNREADABLE)).toEqual({ REMOTE_PROCESSING: 1 });
    expect((await jobsOf(x.item.id))[0]).toMatchObject({ state: 'REMOTE_PROCESSING', reconcileCount: 2 });
    expect(await check(x.planId, UNREADABLE)).toEqual({ UNKNOWN: 1 });
    const [j3] = await jobsOf(x.item.id);
    expect(j3).toMatchObject({ state: 'UNKNOWN', reconcileCount: RECONCILE_MAX_ATTEMPTS, leaseOwner: null });
    const last = (await eventsOf(x.jobId)).at(-1)!;
    expect(last).toMatchObject({ stateBefore: 'REMOTE_PROCESSING', stateAfter: 'UNKNOWN' });
    expect(last.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported', reconcile: 'unknown', checks: RECONCILE_MAX_ATTEMPTS });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    // 처리 중 조회 이력은 2개(processing), 확인 불가 이력은 3개
    const evs = await eventsOf(x.jobId);
    expect(evs.filter((e) => e.sanitizedDetails.reconcile === 'processing')).toHaveLength(2);
    expect(evs.filter((e) => e.sanitizedDetails.reconcile === 'unknown')).toHaveLength(3);
    expect(api.postsOf(x.acc.external)).toHaveLength(0);
  });

  it('(b) 섞인 순서 — processing·확인 불가 2·processing·확인 불가 2 → 여전히 REMOTE_PROCESSING(processing 이 연속 횟수를 되돌림) · 이어서 확인 불가 3회 연속에만 UNKNOWN', async () => {
    const x = await remoteProcessing();
    const seq: Array<[ReconcileResult, number]> = [
      [PROCESSING, 0],
      [UNREADABLE, 1],
      [UNREADABLE, 2],
      [PROCESSING, 0],
      [UNREADABLE, 1],
      [UNREADABLE, 2],
      [PROCESSING, 0],
      [UNREADABLE, 1],
      [UNREADABLE, 2],
    ];
    for (const [r, count] of seq) {
      expect(await check(x.planId, r)).toEqual({ REMOTE_PROCESSING: 1 });
      expect((await jobsOf(x.item.id))[0]).toMatchObject({ state: 'REMOTE_PROCESSING', reconcileCount: count });
    }
    // 확인 불가 이력의 checks 는 연속 횟수(1·2)만 — 3 은 아직 없다
    const checks = (await eventsOf(x.jobId)).filter((e) => e.sanitizedDetails.reconcile === 'unknown').map((e) => e.sanitizedDetails.checks);
    expect(checks).toEqual([1, 2, 1, 2, 1, 2]);
    expect(await check(x.planId, UNREADABLE)).toEqual({ UNKNOWN: 1 });
    const last = (await eventsOf(x.jobId)).at(-1)!;
    expect(last.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported', reconcile: 'unknown', checks: 3 });
    expect(api.postsOf(x.acc.external)).toHaveLength(0);
  });

  it('(c) REMOTE_POLL_MAX 는 처리 중 조회만 센다 — processing·확인 불가를 번갈아도 확인 불가로 끝나지 않고, processing 이 20번째일 때 UNKNOWN(polls 20)', async () => {
    const x = await remoteProcessing();
    for (let i = 1; i < REMOTE_POLL_MAX; i++) {
      expect(await check(x.planId, PROCESSING), `poll ${i}`).toEqual({ REMOTE_PROCESSING: 1 });
      expect(await check(x.planId, UNREADABLE), `unknown after poll ${i}`).toEqual({ REMOTE_PROCESSING: 1 });
    }
    const [mid] = await jobsOf(x.item.id);
    expect(mid).toMatchObject({ state: 'REMOTE_PROCESSING', reconcileCount: 1 });
    expect(await check(x.planId, PROCESSING)).toEqual({ UNKNOWN: 1 });
    const last = (await eventsOf(x.jobId)).at(-1)!;
    expect(last).toMatchObject({ stateBefore: 'REMOTE_PROCESSING', stateAfter: 'UNKNOWN' });
    expect(last.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported', reconcile: 'processing', polls: REMOTE_POLL_MAX });
    // 처리 중 조회 이력은 정확히 REMOTE_POLL_MAX 개(한도 사건 포함), 확인 불가는 19개(모두 checks 1)
    const evs = await eventsOf(x.jobId);
    expect(evs.filter((e) => e.sanitizedDetails.reconcile === 'processing')).toHaveLength(REMOTE_POLL_MAX);
    const unknowns = evs.filter((e) => e.sanitizedDetails.reconcile === 'unknown');
    expect(unknowns).toHaveLength(REMOTE_POLL_MAX - 1);
    expect(new Set(unknowns.map((e) => e.sanitizedDetails.checks))).toEqual(new Set([1]));
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
  });

  it('(d) 처리 중 조회만 계속되면 지금처럼 REMOTE_POLL_MAX 에서 UNKNOWN(polls 20) — 확인 불가 없이도', async () => {
    const x = await remoteProcessing();
    for (let i = 1; i < REMOTE_POLL_MAX; i++) expect(await check(x.planId, PROCESSING, 16_000)).toEqual({ REMOTE_PROCESSING: 1 });
    expect(await check(x.planId, PROCESSING, 16_000)).toEqual({ UNKNOWN: 1 });
    expect((await eventsOf(x.jobId)).at(-1)!.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported', reconcile: 'processing', polls: REMOTE_POLL_MAX });
  });

  it('(e) 원격 처리 중 취소 요청(CANCEL_REQUESTED — 연속 확인 불가 수를 그대로 가져감) — processing 2회 뒤 취소 → 확인 불가 1회는 CANCEL_REQUESTED 그대로 · 연속 3회째에 UNKNOWN(취소 성공이라고 하지 않음)', async () => {
    const x = await remoteProcessing();
    expect(await check(x.planId, PROCESSING)).toEqual({ REMOTE_PROCESSING: 1 });
    expect(await check(x.planId, PROCESSING)).toEqual({ REMOTE_PROCESSING: 1 });
    expect(await (await cancel(x.item.id)).json()).toMatchObject({ cancel_requested: true, state: 'CANCEL_REQUESTED' });
    expect(await check(x.planId, UNREADABLE)).toEqual({ CANCEL_REQUESTED: 1 });
    expect((await jobsOf(x.item.id))[0]).toMatchObject({ state: 'CANCEL_REQUESTED', reconcileCount: 1 });
    expect(await check(x.planId, UNREADABLE)).toEqual({ CANCEL_REQUESTED: 1 });
    expect(await check(x.planId, UNREADABLE)).toEqual({ UNKNOWN: 1 });
    const last = (await eventsOf(x.jobId)).at(-1)!;
    expect(last).toMatchObject({ stateBefore: 'CANCEL_REQUESTED', stateAfter: 'UNKNOWN' });
    expect(last.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported', checks: 3 });
    expect(api.postsOf(x.acc.external)).toHaveLength(0);
  });
});

describe('FIX1-FULLREV2(G8): 계정 사용 중지 → 다시 사용은 진행 중 항목의 승인도 철회 — 다음 전송은 다시 승인 필요', () => {
  it('(a) REMOTE_PROCESSING 항목 + 같은 계정의 대기(QUEUED) 항목 → 계정 disconnected: 두 승인 모두 invalidated:account_changed · 진행 중 작업·항목 상태는 그대로, 대기 작업은 지금처럼 BLOCKED·항목 PLANNED → mock_ready 로 되돌려도 승인 되살아나지 않음 → 재개(resumable) → 보내기 직전 approval_missing → 항목 PLANNED · 두 번째 전송 0', async () => {
    const x = await remoteProcessing();
    const q = await executed(x.acc.id, '해외 영업 셋째 달, 대기 항목 글.');
    expect((await jobsOf(q.item.id))[0]).toMatchObject({ state: 'QUEUED' });
    const off = await setChannelAccountState(db, owner, x.acc.id, 'disconnected');
    expect(off.revoked.map((r) => r.itemId).sort()).toEqual([x.item.id, q.item.id].sort());
    for (const id of [x.item.id, q.item.id]) {
      const aps = await approvalsOf(id);
      expect(aps).toHaveLength(1);
      expect(aps[0]!.revokedAt).not.toBeNull();
      expect(aps[0]!.revokeReason).toBe('invalidated:account_changed');
    }
    // 진행 중 항목: 작업·항목 상태 그대로(원격 처리 결과는 계속 확인한다), 취소 요청도 아님
    expect((await jobsOf(x.item.id))[0]).toMatchObject({ state: 'REMOTE_PROCESSING', cancelRequestedAt: null });
    expect((await itemOf(x.item.id)).status).toBe('REMOTE_PROCESSING');
    // 대기 항목: 지금 규칙 그대로
    expect((await jobsOf(q.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_invalidated' });
    expect((await itemOf(q.item.id)).status).toBe('PLANNED');
    const audit = (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'approval.invalidate'), eq(schema.auditEvents.entityId, (await approvalsOf(x.item.id))[0]!.id))))[0]!;
    expect(audit.sanitizedDetails).toMatchObject({ item_id: x.item.id, reason: 'invalidated:account_changed', item_status_before: 'REMOTE_PROCESSING', blocked_jobs: 0, partial: false });

    const on = await setChannelAccountState(db, owner, x.acc.id, 'mock_ready');
    expect(on.revoked).toEqual([]);
    expect((await approvalsOf(x.item.id)).every((a) => a.revokedAt !== null)).toBe(true);

    const submit = vi.spyOn(registry.threads, 'submit');
    try {
      // 컨테이너 처리 끝 + 게시 시도 없음 → 재개(resumable) → RETRY_WAIT
      expect(await check(x.planId, { status: 'resumable', published_parts: 0, error_code: 'container_not_published' }, 16_000)).toEqual({ RETRY_WAIT: 1 });
      // 다음 전송: 보내기 직전 재검사가 승인 없음으로 멈춘다(보내지 않음 → 작업 BLOCKED, 항목 PLANNED — 다시 승인 필요)
      expect((await tick(x.planId, 1000)).results).toEqual({ BLOCKED: 1 });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      submit.mockRestore();
    }
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing', leaseOwner: null });
    const last = (await eventsOf(job!.id)).at(-1)!;
    expect(last).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
    expect(last.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing' });
    expect((await itemOf(x.item.id)).status).toBe('PLANNED');
    expect(await jobsOf(x.item.id)).toHaveLength(1);
    expect(api.postsOf(x.acc.external)).toHaveLength(0);
    // 더 돌려도 보내지 않는다
    expect((await tick(x.planId, 20 * MIN)).results).toEqual({});
  });

  it('(b) 스레드 일부 게시(1·2 게시 → 3번째 원격 처리 중) → 계정 사용 중지·다시 사용 → 재개 → approval_missing → PLANNED 가 아니라 UNKNOWN(thread_partial_revoked) · 남은 게시물 보내지 않음(게시 2개 그대로)', async () => {
    const acc = await linkedThreadsAccount();
    const x = { acc, ...(await executed(acc.id, THREE.join('\n\n'), 'threads_thread_partial')) };
    expect((await tick(x.planId)).results).toEqual({ RECONCILING: 1 });
    expect(api.postsOf(acc.external)).toHaveLength(2);
    // 3번째 컨테이너가 처리 중이라는 보고(모의 Threads 의 IN_PROGRESS 조회 모양) → REMOTE_PROCESSING
    expect(await check(x.planId, { status: 'processing', published_parts: 2, error_code: 'container_in_progress' }, 11_000)).toEqual({ REMOTE_PROCESSING: 1 });
    const [rp] = await jobsOf(x.item.id);
    expect(rp!.state).toBe('REMOTE_PROCESSING');
    const off = await setChannelAccountState(db, owner, acc.id, 'disconnected');
    expect(off.revoked.map((r) => r.itemId)).toEqual([x.item.id]);
    expect(off.revoked[0]!.partialJobIds).toEqual([]); // 진행 중 작업은 여기서 건드리지 않는다
    expect((await setChannelAccountState(db, owner, acc.id, 'mock_ready')).revoked).toEqual([]);
    expect((await approvalsOf(x.item.id))[0]!.revokeReason).toBe('invalidated:account_changed');

    const submit = vi.spyOn(registry.threads, 'submit');
    try {
      expect(await check(x.planId, { status: 'resumable', published_parts: 2, error_code: 'container_not_published' }, 16_000)).toEqual({ RETRY_WAIT: 1 });
      expect((await tick(x.planId, 1000)).results).toEqual({ UNKNOWN: 1 });
      expect(submit).not.toHaveBeenCalled();
    } finally {
      submit.mockRestore();
    }
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', leaseOwner: null, cancelRequestedAt: null });
    const [prev, last] = (await eventsOf(job!.id)).slice(-2);
    expect(prev).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
    expect(prev!.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing', not_sent: false, published_parts: 2 });
    expect(last).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect(api.postsOf(acc.external)).toHaveLength(2);
    expect((await tick(x.planId, 20 * MIN)).results).toEqual({});
    expect(api.postsOf(acc.external)).toHaveLength(2);
  });

  it('(c) 계정 상태가 그대로면(같은 상태로 다시 설정) 아무 승인도 철회하지 않는다 — 진행 중 항목은 다음 재개에서 그대로 이어 보낸다(지금 동작)', async () => {
    const x = await remoteProcessing();
    expect((await setChannelAccountState(db, owner, x.acc.id, 'mock_ready')).revoked).toEqual([]);
    expect((await approvalsOf(x.item.id))[0]!.revokedAt).toBeNull();
    expect(await check(x.planId, { status: 'resumable', published_parts: 0, error_code: 'container_not_published' }, 16_000)).toEqual({ RETRY_WAIT: 1 });
    expect((await tick(x.planId, 1000)).results).toEqual({ CONFIRMED: 1 });
    expect(api.postsOf(x.acc.external)).toHaveLength(1);
  });
});

describe('FIX1-FULLREV2(G8 후속): 보내는 중(SENDING) 계정 사용 중지 → 다시 사용 → 그 시도가 보류(auth)로 끝나도 막다른 길이 아니다', () => {
  const approveAgain = (x: Planned) =>
    approvePOST(
      post(`/api/distribution-plans/${x.planId}/approve`, { item_ids: [x.item.id], expected_hashes: { [x.item.id]: x.item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
      ctx(x.planId),
    );
  const retry = (itemId: string) => retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));

  /** 이번 시도의 외부 호출 도중(작업 처리기는 DB 잠금 없음) 계정을 사용 중지했다가 다시 사용한 뒤, 모의 어댑터가 그대로 보낸다(주입한 장애가 결과를 정함) */
  function toggleAccountDuringSubmit(accountId: string, itemId: string) {
    const original = registry.threads.submit.bind(registry.threads);
    return vi.spyOn(registry.threads, 'submit').mockImplementationOnce(async (...args) => {
      expect((await itemOf(itemId)).status).toBe('SENDING');
      const off = await setChannelAccountState(db, owner, accountId, 'disconnected');
      expect(off.revoked.map((r) => r.itemId)).toEqual([itemId]);
      expect((await setChannelAccountState(db, owner, accountId, 'mock_ready')).revoked).toEqual([]);
      return original(...args);
    });
  }

  it('(d) 첫 컨테이너 생성 401(auth) — 승인이 철회된 시도 → 작업 BLOCKED(approval_missing, 원래 원인 auth 기록)·항목 PLANNED · 재시도는 "다시 승인" 409 · 다시 승인 200 → 실행 → 게시 1번', async () => {
    const acc = await linkedThreadsAccount();
    const x = await executed(acc.id, '해외 영업 넷째 달, 보내는 중 계정 사용 중지 글.');
    api.injectFault({ op: 'createContainer', kind: 'auth_invalid_token', userId: acc.external });
    const submit = toggleAccountDuringSubmit(acc.id, x.item.id);
    try {
      expect((await tick(x.planId)).results).toEqual({ BLOCKED: 1 });
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      submit.mockRestore();
    }
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing', leaseOwner: null });
    const last = (await eventsOf(job!.id)).at(-1)!;
    expect(last).toMatchObject({ stateBefore: 'SENDING', stateAfter: 'BLOCKED' });
    expect(last.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing', cause: 'auth', error_code: 'auth_invalid_token', retry_class: 'auth' });
    // 막다른 길이 아니다: 항목은 실행 전(PLANNED) — 다시 승인할 수 있다
    expect((await itemOf(x.item.id)).status).toBe('PLANNED');
    expect((await approvalsOf(x.item.id)).every((a) => a.revokedAt !== null && a.revokeReason === 'invalidated:account_changed')).toBe(true);
    expect(api.postsOf(acc.external)).toHaveLength(0);
    // 재시도는 다시 승인 안내(승인 없음 보류 — 항목 PLANNED)
    const rt = await retry(x.item.id);
    expect(rt.status).toBe(409);
    const rtBody = (await rt.json()) as { error: string; message: string };
    expect(rtBody.error).toBe('approval_required');
    expect(rtBody.message).toContain('다시 승인한 뒤 실행');
    // 옛 작업은 더 보내지 않는다
    expect((await tick(x.planId, MIN)).results).toEqual({});
    // 복구 길: 다시 승인 → 실행 → 새 작업이 게시
    const re = await approveAgain(x);
    expect(re.status, await re.clone().text()).toBe(200);
    const ex = await executePOST(post(`/api/distribution-plans/${x.planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(x.planId));
    expect(ex.status, await ex.clone().text()).toBe(200);
    expect((await tick(x.planId, MIN)).results).toEqual({ CONFIRMED: 1 });
    expect(await jobsOf(x.item.id)).toHaveLength(2);
    expect(api.postsOf(acc.external)).toHaveLength(1);
    expect((await itemOf(x.item.id)).status).toBe('CONFIRMED');
  });

  it('(e) 스레드 1번째 게시 뒤(2번째 429 → RETRY_WAIT) 다음 시도 중 계정 사용 중지·다시 사용 → 2번째 게시 401(auth) → PLANNED 가 아니라 UNKNOWN(thread_partial_revoked) · 남은 게시물 보내지 않음 · 다시 승인 409', async () => {
    const acc = await linkedThreadsAccount();
    api.setRateBudget(acc.external, 1, 60);
    const x = await executed(acc.id, THREE.join('\n\n'));
    try {
      expect((await tick(x.planId)).results).toEqual({ RETRY_WAIT: 1 });
    } finally {
      api.clearRateBudget(acc.external);
    }
    expect(api.postsOf(acc.external)).toHaveLength(1);
    api.injectFault({ op: 'publish', kind: 'auth_invalid_token', userId: acc.external });
    const submit = toggleAccountDuringSubmit(acc.id, x.item.id);
    try {
      expect((await tick(x.planId, 2 * MIN)).results).toEqual({ UNKNOWN: 1 });
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      submit.mockRestore();
    }
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', leaseOwner: null, cancelRequestedAt: null });
    const [prev, last] = (await eventsOf(job!.id)).slice(-2);
    expect(prev).toMatchObject({ stateBefore: 'SENDING', stateAfter: 'BLOCKED' });
    expect(prev!.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing', cause: 'auth', not_sent: false, published_parts: 1 });
    expect(last).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    // 이 항목으로는 다시 승인할 수 없다(새 작업이 1번째 게시물을 처음부터 다시 게시하지 않게)
    const re = await approveAgain(x);
    expect(re.status).toBe(409);
    expect(await re.json()).toMatchObject({ error: 'item_not_planned' });
    expect((await tick(x.planId, 20 * MIN)).results).toEqual({});
    expect(api.postsOf(acc.external)).toHaveLength(1);
    expect(await jobsOf(x.item.id)).toHaveLength(1);
  });

  it('(f) 대조 — 계정을 건드리지 않은 같은 401(auth) 보류는 지금처럼 작업·항목 BLOCKED(auth_invalid_token) · 승인 유지 · 재시도 200 → 게시 1번', async () => {
    const acc = await linkedThreadsAccount();
    const x = await executed(acc.id, '해외 영업 다섯째 달, 인증 거절 대조 글.');
    api.injectFault({ op: 'createContainer', kind: 'auth_invalid_token', userId: acc.external });
    expect((await tick(x.planId)).results).toEqual({ BLOCKED: 1 });
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'auth_invalid_token' });
    expect((await eventsOf(job!.id)).at(-1)!.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'auth' });
    expect((await itemOf(x.item.id)).status).toBe('BLOCKED');
    expect((await approvalsOf(x.item.id))[0]!.revokedAt).toBeNull();
    const rt = await retry(x.item.id);
    expect(rt.status, await rt.clone().text()).toBe(200);
    expect((await tick(x.planId, MIN)).results).toEqual({ CONFIRMED: 1 });
    expect(api.postsOf(acc.external)).toHaveLength(1);
    expect(await jobsOf(x.item.id)).toHaveLength(1);
  });
});
