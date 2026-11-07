/**
 * FIX1-FULLREV(F2): 스레드 일부가 이미 게시된 뒤 승인 철회·무효(편집) — 항목을 실행 전(PLANNED)으로 되돌리지 않는다.
 * 되돌리면 다시 승인 → 실행이 새 작업을 만들고, 새 작업은 단계 기록이 비어 있어 이미 게시된 게시물을 처음부터 다시 게시한다(D26·A11 위반).
 * cancelItem 과 같은 판정: 게시된 단계(publish·video)나 게시 시도 표식(publish_attempt)이 있으면 cancel_partial → UNKNOWN(thread_partial_revoked).
 * 게시된 것이 없으면 지금까지와 같다(작업 BLOCKED · 항목 PLANNED). 모의 Threads 만 — **네트워크 호출 0**(fetch 0 확인).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import {
  appendContentVersion,
  closeDb,
  createContent,
  createVariantDraft,
  getDb,
  leaseJobs,
  processJob,
  recoverExpiredLeases,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig } from '@cs/domain';
import { createMockAdapterRegistry, THREADS_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as revokePOST } from '../../apps/web/app/api/approvals/[id]/revoke/route';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as accountRevokePOST } from '../../apps/web/app/api/channel-accounts/[id]/revoke/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { blockInfoOf, itemHeadline, revocationCountParam, revocationNotice } from '../../apps/web/lib/distribution';
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
const formPost = (p: string, fields: Record<string, string>) =>
  new Request(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(token) },
    body: new URLSearchParams(fields).toString(),
  });

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
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads F2', state: 'mock_ready' })
    .returning();
  await connectFully(row!.id);
  return { id: row!.id, external };
}

const P1 = '해외 영업 첫 달, 대리점 재고 기준부터 합의했다.';
const THREE = ['첫째 — 재고 기준을 먼저 합의했다.', '둘째 — 가격표는 마지막에 확정했다.', '셋째 — 매주 같은 요일에 숫자를 맞췄다.'];

interface Planned {
  planId: string;
  contentId: string;
  item: { id: string; payload_hash: string };
}
/** 원고 → Threads 파생본(review) → 계획(항목 1개) → (모의 시나리오) → 승인(mock_publish) */
async function planApproved(accountId: string, body: string, scenario?: string): Promise<Planned> {
  const { content } = await createContent(db, owner, { title: `F2 ${randomUUID().slice(0, 6)}`, body });
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
  return { planId: p.plan.id, contentId: content.id, item };
}
const approve = (planId: string, item: { id: string; payload_hash: string }) =>
  approvePOST(
    post(`/api/distribution-plans/${planId}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
    ctx(planId),
  );
const execute = (planId: string) => executePOST(post(`/api/distribution-plans/${planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(planId));
const retry = (itemId: string) => retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));
const cancel = (itemId: string) => cancelPOST(post(`/api/distribution-items/${itemId}/cancel`), ctx(itemId));

/** 작업 처리기 옵션(tick·processJob 공통) */
const runOpts = () => ({
  workerId: 'f2-w',
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
/** 경합 모사: 작업 처리기가 이 계획의 작업 하나를 lease 만 하고 아직 보내기 전(LEASED — leaseJobs 는 항목 상태를 바꾸지 않는다) */
async function leaseOnly(planId: string, itemId: string) {
  const leased = await leaseJobs(db, { workerId: 'f2-w', now: new Date(Date.now() + vt), limit: 1, ownerId: owner, planId });
  expect(leased).toHaveLength(1);
  expect(leased[0]).toMatchObject({ itemId, state: 'LEASED', leaseOwner: 'f2-w' });
  return leased[0]!;
}

const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
const planOf = async (planId: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, planId)))[0]!;
const approvalOf = async (approvalId: string) => (await db.select().from(schema.approvals).where(eq(schema.approvals.id, approvalId)))[0]!;
const activeApprovalId = async (itemId: string) =>
  (await db.select().from(schema.approvals).where(and(eq(schema.approvals.distributionItemId, itemId), isNull(schema.approvals.revokedAt))))[0]!.id;
const lastEvent = async (jobId: string) =>
  (await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq))).at(-1)!;
/** 계획 페이지(getPlanDetail)와 같은 순서 — 최근 작업의 이력, 최신 먼저 */
const eventsDesc = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(desc(schema.jobEvents.eventSeq));
const auditOf = async (action: string, approvalId: string) =>
  (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, action), eq(schema.auditEvents.entityId, approvalId))))[0]!;
const containersOf = async (itemId: string) =>
  (await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId))).filter((s) => s.kind === 'container').map((s) => s.remoteId);

/** 3개 스레드에서 1·2번째 게시 뒤 3번째 publish 429 → RETRY_WAIT(게시 2) */
async function partialThread() {
  const acc = await linkedThreadsAccount();
  const p = await planApproved(acc.id, THREE.join('\n\n'));
  expect((await execute(p.planId)).status).toBe(200);
  api.setRateBudget(acc.external, 2, 60);
  await tick();
  const [job] = await jobsOf(p.item.id);
  expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited' });
  expect(api.postsOf(acc.external)).toHaveLength(2);
  api.clearRateBudget(acc.external);
  return { acc, ...p, jobId: job!.id };
}

/** 3개 스레드에서 1번째 게시 → 2번째 publish 429(RETRY_WAIT) → 2번째 publish 401 → BLOCKED(게시 1, 항목 BLOCKED) */
async function blockedAfterOnePost() {
  const acc = await linkedThreadsAccount();
  const p = await planApproved(acc.id, THREE.join('\n\n'));
  expect((await execute(p.planId)).status).toBe(200);
  api.setRateBudget(acc.external, 1, 60);
  await tick();
  expect((await jobsOf(p.item.id))[0]).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited' });
  api.clearRateBudget(acc.external);
  api.injectFault({ op: 'publish', kind: 'auth_invalid_token', userId: acc.external });
  await tick(2 * MIN);
  expect((await jobsOf(p.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'auth_invalid_token' });
  expect((await itemOf(p.item.id)).status).toBe('BLOCKED');
  expect(api.postsOf(acc.external)).toHaveLength(1);
  return { acc, ...p };
}

/** 철회·무효 뒤 이 항목으로는 다시 승인·실행·재시도·취소할 수 없고, 작업 처리기를 돌려도 더 게시하지 않는다(처음부터 다시 보내지 않음). */
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

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-f2-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('F2 시험: 네트워크 호출 금지');
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

describe('FIX1-FULLREV(F2): 부분 게시 뒤 승인 철회 — 실행 전으로 되돌리지 않음(재게시 없음)', () => {
  it('RETRY_WAIT(3개 중 2개 게시) 철회(JSON) → 승인은 철회, 작업·항목 UNKNOWN(thread_partial_revoked) · 다시 승인 409·실행 409 · 작업 처리기를 돌려도 게시 2개 그대로', async () => {
    const x = await partialThread();
    const approvalId = await activeApprovalId(x.item.id);
    const res = await revokePOST(post(`/api/approvals/${approvalId}/revoke`, {}), ctx(approvalId));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ blocked_job_ids: [], partial_job_ids: [x.jobId], cancel_requested_job_ids: [] });
    // 승인 자체는 철회됐다
    expect((await approvalOf(approvalId)).revokedAt).not.toBeNull();
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', leaseOwner: null });
    expect(job!.cancelRequestedAt).not.toBeNull();
    expect((await lastEvent(x.jobId)).sanitizedDetails).toMatchObject({
      transition: 'cancel_partial',
      cause: 'approval_revoked',
      approval_id: approvalId,
      from: 'RETRY_WAIT',
      not_sent: false,
      published_parts: 2,
      publish_attempts: 0,
    });
    // 항목은 실행 전(PLANNED)이 아니다 — 작업을 따라 UNKNOWN, 계획은 확인 필요
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect((await planOf(x.planId)).status).toBe('attention');
    expect((await auditOf('approval.revoke', approvalId)).sanitizedDetails).toMatchObject({
      item_status_before: 'RETRY_WAIT',
      blocked_jobs: 0,
      partial: true,
      partial_jobs: 1,
      published_parts: 2,
      publish_attempts: 0,
    });
    const headline = itemHeadline({ status: 'UNKNOWN', channel: 'threads', job: job!, pub: null, blockReason: null });
    expect(headline).toContain('승인 철회·무효 뒤 남은 게시물은 보내지 않음');
    expect(headline).not.toContain('실행 전');
    await expectNoRepublish(x, 2);
  });

  it('보류(BLOCKED) 항목: 2번째 게시물 401 뒤 BLOCKED(게시 1) → 철회(HTML 폼) → 작업·항목 UNKNOWN(PLANNED 아님), 리다이렉트 revoked_partial=1 · 배너가 "대기 작업 없음"이라 하지 않음', async () => {
    const p = await blockedAfterOnePost();
    const approvalId = await activeApprovalId(p.item.id);
    const res = await revokePOST(formPost(`/api/approvals/${approvalId}/revoke`, { plan_id: p.planId }), ctx(approvalId));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!, BASE);
    expect([loc.searchParams.get('revoked_blocked'), loc.searchParams.get('revoked_cancel'), loc.searchParams.get('revoked_partial')]).toEqual(['0', '0', '1']);
    const notice = revocationNotice(
      revocationCountParam(loc.searchParams.get('revoked_blocked') ?? undefined),
      revocationCountParam(loc.searchParams.get('revoked_cancel') ?? undefined),
      revocationCountParam(loc.searchParams.get('revoked_partial') ?? undefined),
    );
    expect(notice).toContain('결과 불명(UNKNOWN)');
    expect(notice).toContain('실행 전으로 되돌리지 않으므로');
    expect(notice).not.toContain('대기 중이던 작업은 없었습니다');
    expect(notice).not.toContain('보류(BLOCKED)');

    expect((await approvalOf(approvalId)).revokedAt).not.toBeNull();
    const [after] = await jobsOf(p.item.id);
    expect(after).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked' });
    expect((await lastEvent(after!.id)).sanitizedDetails).toMatchObject({ transition: 'cancel_partial', from: 'BLOCKED', published_parts: 1 });
    expect((await itemOf(p.item.id)).status).toBe('UNKNOWN');
    // 화면(계획 페이지)과 같은 입력: 최근 작업의 이력(최신 먼저)에서 blockInfoOf — 앞선 401 BLOCKED 사유가 철회 결과 문구를 가리지 않는다
    const block = blockInfoOf(await eventsDesc(after!.id), after!);
    const headline = itemHeadline({ status: 'UNKNOWN', channel: 'threads', job: after!, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false });
    expect(headline).toContain('승인 철회·무효 뒤 남은 게시물은 보내지 않음');
    expect(headline).not.toContain('실행 전');
    await expectNoRepublish(p, 1);
  });
});

describe('FIX1-FULLREV(F2): 부분 게시 뒤 승인 무효(원고 편집) — 실행 전으로 되돌리지 않음', () => {
  it('RETRY_WAIT(게시 2) 중 원고 새 버전 → 승인 invalidated:content_changed, 작업·항목 UNKNOWN(thread_partial_revoked) · 작업 처리기를 돌려도 게시 2개 그대로', async () => {
    const x = await partialThread();
    const approvalId = await activeApprovalId(x.item.id);
    await appendContentVersion(db, owner, x.contentId, { baseVersion: 1, body: `${THREE.join('\n\n')}\n\n승인 뒤 고친 문단` });
    expect((await approvalOf(approvalId)).revokeReason).toBe('invalidated:content_changed');
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked' });
    // FIX1-FULLREV(F2 후속2): 무효(편집)는 취소가 아니다 — 취소 요청 시각을 쓰지 않는다(사용자 철회는 씀 — 위 RETRY_WAIT 철회 시험)
    expect(job!.cancelRequestedAt).toBeNull();
    expect((await lastEvent(x.jobId)).sanitizedDetails).toMatchObject({
      transition: 'cancel_partial',
      cause: 'approval_invalidated',
      reason: 'invalidated:content_changed',
      not_sent: false,
      published_parts: 2,
    });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect((await planOf(x.planId)).status).toBe('attention');
    expect((await auditOf('approval.invalidate', approvalId)).sanitizedDetails).toMatchObject({ partial: true, partial_jobs: 1, published_parts: 2, item_status_before: 'RETRY_WAIT' });
    await tick(20 * MIN);
    await tick(20 * MIN);
    expect(api.postsOf(x.acc.external)).toHaveLength(2);
    expect(await jobsOf(x.item.id)).toHaveLength(1);
    expect((await retry(x.item.id)).status).toBe(409);
  });
});

describe('FIX1-FULLREV(F2): 게시된 것이 없으면 지금까지와 같다(작업 BLOCKED · 항목 PLANNED)', () => {
  it('대기(QUEUED) 철회 → BLOCKED + PLANNED → 다시 승인 → 실행 → 새 작업 CONFIRMED(게시 1) · 컨테이너만 있는 RETRY_WAIT(429) 철회도 BLOCKED + PLANNED', async () => {
    const acc = await linkedThreadsAccount();
    const q = await planApproved(acc.id, P1);
    expect((await execute(q.planId)).status).toBe(200);
    const [qJob] = await jobsOf(q.item.id);
    expect(qJob!.state).toBe('QUEUED');
    const qa = await activeApprovalId(q.item.id);
    const qr = await revokePOST(post(`/api/approvals/${qa}/revoke`, {}), ctx(qa));
    expect(await qr.json()).toMatchObject({ blocked_job_ids: [qJob!.id], partial_job_ids: [], cancel_requested_job_ids: [] });
    expect((await jobsOf(q.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_revoked' });
    expect((await itemOf(q.item.id)).status).toBe('PLANNED');
    expect((await auditOf('approval.revoke', qa)).sanitizedDetails).toMatchObject({ blocked_jobs: 1, partial: false, partial_jobs: 0 });
    expect(revocationNotice(1, 0, 0)).toContain('보류(BLOCKED) — 다음 전송이 차단');
    // 다시 승인 → 새 실행 키 → 새 작업이 게시(게시 1, 재게시 없음)
    expect((await approve(q.planId, q.item)).status).toBe(200);
    expect((await execute(q.planId)).status).toBe(200);
    await tick(1000);
    const qJobs = await jobsOf(q.item.id);
    expect(qJobs.map((j) => j.state)).toEqual(['BLOCKED', 'CONFIRMED']);
    expect(api.postsOf(acc.external)).toHaveLength(1);

    // 컨테이너만 만든 뒤 publish 429(게시 0) → RETRY_WAIT → 철회: 컨테이너 단계는 게시가 아니다
    const acc2 = await linkedThreadsAccount();
    const r = await planApproved(acc2.id, P1);
    expect((await execute(r.planId)).status).toBe(200);
    api.setRateBudget(acc2.external, 0, 60);
    await tick();
    api.clearRateBudget(acc2.external);
    const [rJob] = await jobsOf(r.item.id);
    expect(rJob).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited' });
    expect(await containersOf(r.item.id)).toHaveLength(1);
    expect(api.postsOf(acc2.external)).toHaveLength(0);
    const ra = await activeApprovalId(r.item.id);
    const rr = await revokePOST(post(`/api/approvals/${ra}/revoke`, {}), ctx(ra));
    expect(await rr.json()).toMatchObject({ blocked_job_ids: [rJob!.id], partial_job_ids: [] });
    expect((await jobsOf(r.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_revoked' });
    expect((await itemOf(r.item.id)).status).toBe('PLANNED');
  });

  it('복원 표시(restored_needs_review) 보류 항목은 지금 규칙 그대로 — 게시된 단계가 있어도 항목 BLOCKED·작업 BLOCKED(다시 승인할 길 없음)', async () => {
    const p = await blockedAfterOnePost();
    await db.update(schema.distributionItems).set({ restoredNeedsReview: true }).where(eq(schema.distributionItems.id, p.item.id));
    const approvalId = await activeApprovalId(p.item.id);
    const res = await revokePOST(post(`/api/approvals/${approvalId}/revoke`, {}), ctx(approvalId));
    expect(await res.json()).toMatchObject({ blocked_job_ids: [], partial_job_ids: [] });
    expect((await jobsOf(p.item.id))[0]!.state).toBe('BLOCKED');
    expect((await itemOf(p.item.id)).status).toBe('BLOCKED');
  });
});

/**
 * FIX1-FULLREV(F2 후속): lease 된(LEASED — 보내기 전) 작업. leaseJobs 는 항목 상태를 바꾸지 않아 항목은 QUEUED·RETRY_WAIT 로 보이고,
 * 철회 훅의 대기 작업(QUEUED·RETRY_WAIT·BLOCKED) 판정에 들지 않는다. 보내기 직전 재검사(beginSend — approval_missing·snapshot_stale·취소 요청)와
 * lease 만료 복구가 부분 게시를 보지 않으면 항목이 PLANNED(다시 승인 → 새 작업이 처음부터 다시 게시)나 CANCELED("보내지 않음")로 끝난다.
 */
describe('FIX1-FULLREV(F2 후속): 보내기 직전(LEASED) 멈춤 — 부분 게시 작업은 PLANNED·CANCELED 가 아니라 UNKNOWN(재게시 없음)', () => {
  const SETTLED = ['UNKNOWN', 'BLOCKED', 'CONFIRMED', 'FAILED', 'CANCELED'];
  const transitionsOf = async (jobId: string) => (await eventsDesc(jobId)).map((e) => (e.sanitizedDetails as { transition?: string }).transition);
  /** 마지막 두 사건: 보내기 직전 멈춤(LEASED → BLOCKED, 사유 기록) → cancel_partial(BLOCKED → UNKNOWN) */
  async function expectLeasedPartialStop(jobId: string, reason: string, parts: number) {
    const [last, prev] = await eventsDesc(jobId);
    expect(prev).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
    expect(prev!.sanitizedDetails).toMatchObject({ transition: 'blocked', reason, not_sent: false, published_parts: parts, publish_attempts: 0 });
    expect(last).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
    expect(last!.sanitizedDetails).toMatchObject({ transition: 'cancel_partial', cause: reason, not_sent: false, published_parts: parts, publish_attempts: 0 });
  }
  /** 계획 페이지와 같은 입력(최근 작업의 이력, 최신 먼저)으로 만든 항목 문구 */
  async function headlineOf(job: typeof schema.jobs.$inferSelect) {
    const block = blockInfoOf(await eventsDesc(job.id), job);
    return itemHeadline({ status: 'UNKNOWN', channel: 'threads', job, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false });
  }

  it('(a) threads_thread_partial: 1·2 게시 뒤 3번째 결과 불명(RECONCILING) 중 원고 편집 — 진행 중이라 승인은 활성 → 조회가 이어 보내기(RETRY_WAIT) → 보내기 직전 snapshot_stale → 승인 무효, 작업·항목 UNKNOWN(PLANNED 아님) · 다시 승인 409 · 게시 2개 그대로', async () => {
    const acc = await linkedThreadsAccount();
    const x = { acc, ...(await planApproved(acc.id, THREE.join('\n\n'), 'threads_thread_partial')) };
    expect((await execute(x.planId)).status).toBe(200);
    await tick();
    const [job] = await jobsOf(x.item.id);
    expect(job!.state).toBe('RECONCILING');
    expect(api.postsOf(acc.external)).toHaveLength(2);
    const approvalId = await activeApprovalId(x.item.id);
    await appendContentVersion(db, owner, x.contentId, { baseVersion: 1, body: `${THREE.join('\n\n')}\n\n조회 중 고친 문단` });
    // 진행 중(RECONCILING) 항목은 편집 훅이 승인을 건드리지 않는다 — 보내기 직전 재검사가 처음 무효로 한다
    expect((await approvalOf(approvalId)).revokedAt).toBeNull();
    for (let i = 0; i < 8 && !SETTLED.includes((await jobsOf(x.item.id))[0]!.state); i++) await tick(20_000);
    const [after] = await jobsOf(x.item.id);
    expect(after).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', leaseOwner: null });
    // FIX1-FULLREV(F2 후속2): 편집 무효(snapshot_stale)는 취소가 아니다 — 취소 요청 시각을 쓰지 않는다(뒤에 CONFIRMED 가 돼도 "취소 불가"라고 하지 않게)
    expect(after!.cancelRequestedAt).toBeNull();
    expect(await transitionsOf(after!.id)).toContain('resume');
    await expectLeasedPartialStop(after!.id, 'snapshot_stale', 2);
    expect((await approvalOf(approvalId)).revokeReason).toBe('invalidated:content_changed');
    expect((await auditOf('approval.invalidate', approvalId)).sanitizedDetails).toMatchObject({ item_status_before: 'RETRY_WAIT', partial: false, leased_partial_jobs: 1 });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect((await planOf(x.planId)).status).toBe('attention');
    const headline = await headlineOf(after!);
    expect(headline).toContain('승인 철회·무효 뒤 남은 게시물은 보내지 않음');
    expect(headline).not.toContain('새 계획 만들기');
    expect(api.postsOf(acc.external)).toHaveLength(2);
    await expectNoRepublish(x, 2);
  });

  it('(b) 경합 모사 — RETRY_WAIT(게시 2) 작업의 승인만 사라짐(철회 훅을 거치지 않음) → 보내기 직전 approval_missing → 작업·항목 UNKNOWN(PLANNED 아님) · 다시 승인 409 · 게시 2개 그대로', async () => {
    const x = await partialThread();
    await db.update(schema.approvals).set({ revokedAt: new Date(), revokeReason: 'test: race' }).where(eq(schema.approvals.distributionItemId, x.item.id));
    expect((await itemOf(x.item.id)).status).toBe('RETRY_WAIT');
    await tick(2 * MIN);
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', leaseOwner: null });
    // FIX1-FULLREV(F2 후속2): 보내기 직전 approval_missing 은 취소가 아니다 — 취소 요청 시각을 쓰지 않는다
    expect(job!.cancelRequestedAt).toBeNull();
    await expectLeasedPartialStop(job!.id, 'approval_missing', 2);
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect((await planOf(x.planId)).status).toBe('attention');
    expect(await headlineOf(job!)).toContain('승인 철회·무효 뒤 남은 게시물은 보내지 않음');
    await expectNoRepublish(x, 2);
  });

  it('(c) lease 뒤 보내기 전(LEASED — 항목은 RETRY_WAIT 로 보임) 연결 해제(계정 승인 무효) → 항목을 PLANNED 로 두지 않음(다시 연결해도 다시 승인 409) → 작업 처리기가 죽어 lease 만료 복구 → 보내기 직전 approval_missing → UNKNOWN · 게시 2개 그대로', async () => {
    const x = await partialThread();
    vt += 2 * MIN;
    const leased = await leaseOnly(x.planId, x.item.id);
    expect((await itemOf(x.item.id)).status).toBe('RETRY_WAIT');
    const approvalId = await activeApprovalId(x.item.id);
    const rv = await accountRevokePOST(post(`/api/channel-accounts/${x.acc.id}/revoke`), ctx(x.acc.id));
    expect(rv.status, await rv.clone().text()).toBe(200);
    expect((await approvalOf(approvalId)).revokeReason).toBe('invalidated:account_changed');
    // 작업은 전송 단계라 그대로(LEASED) — 항목도 실행 전(PLANNED)으로 가지 않는다
    expect((await jobsOf(x.item.id))[0]).toMatchObject({ id: leased.id, state: 'LEASED' });
    expect((await itemOf(x.item.id)).status).toBe('RETRY_WAIT');
    expect((await auditOf('approval.invalidate', approvalId)).sanitizedDetails).toMatchObject({ blocked_jobs: 0, partial: false, leased_partial_jobs: 1 });
    // 다시 연결해도(계정 스냅샷은 다시 맞는다) 이 항목은 다시 승인할 수 없다 — 새 작업이 1·2번째를 다시 게시하지 않게
    await connectFully(x.acc.id);
    const ap = await approve(x.planId, x.item);
    expect(ap.status).toBe(409);
    expect(await ap.json()).toMatchObject({ error: 'item_not_planned' });
    // 작업 처리기가 lease 뒤 죽음 → 만료 복구(LEASED → QUEUED) → 다시 lease → 보내기 직전 approval_missing
    await tick(2 * MIN);
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked' });
    expect(job!.cancelRequestedAt).toBeNull(); // FIX1-FULLREV(F2 후속2): 연결 해제(계정 승인 무효)는 취소가 아니다
    expect(await transitionsOf(job!.id)).toContain('lease_expired_before_intent');
    await expectLeasedPartialStop(job!.id, 'approval_missing', 2);
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    await expectNoRepublish(x, 2);
  });

  it('(d) lease 뒤 보내기 전 사용자 승인 철회 → CANCEL_REQUESTED → 같은 작업 처리기의 보내기 직전 재검사 → CANCELED("보내지 않음")가 아니라 UNKNOWN(thread_partial_cancel_requested) · 게시 2개 그대로', async () => {
    const x = await partialThread();
    vt += 2 * MIN;
    const leased = await leaseOnly(x.planId, x.item.id);
    const approvalId = await activeApprovalId(x.item.id);
    const res = await revokePOST(post(`/api/approvals/${approvalId}/revoke`, {}), ctx(approvalId));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ blocked_job_ids: [], partial_job_ids: [], cancel_requested_job_ids: [leased.id] });
    expect((await itemOf(x.item.id)).status).toBe('CANCEL_REQUESTED');
    const r = await processJob(db, registry, leased, runOpts());
    expect(r.state).toBe('UNKNOWN');
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested', leaseOwner: null });
    expect(job!.cancelRequestedAt).not.toBeNull(); // FIX1-FULLREV(F2 후속2): 사용자 철회의 취소 요청 — 취소 요청 시각은 그대로 남는다
    const last = await lastEvent(job!.id);
    expect(last).toMatchObject({ stateBefore: 'CANCEL_REQUESTED', stateAfter: 'UNKNOWN' });
    expect(last.sanitizedDetails).toMatchObject({
      transition: 'reconcile_unsupported',
      reason: 'thread_partial_cancel_requested',
      not_sent: false,
      published_parts: 2,
      publish_attempts: 0,
    });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect(await headlineOf(job!)).toContain('취소 뒤 남은 게시물은 보내지 않음');
    await expectNoRepublish(x, 2);
  });

  it('(e) 같은 경합에서 작업 처리기가 죽음 → lease 만료 복구(취소 요청이 보내기 전) → CANCELED("보내지 않음")가 아니라 UNKNOWN · 게시 2개 그대로', async () => {
    const x = await partialThread();
    vt += 2 * MIN;
    const leased = await leaseOnly(x.planId, x.item.id);
    const approvalId = await activeApprovalId(x.item.id);
    const res = await revokePOST(post(`/api/approvals/${approvalId}/revoke`, {}), ctx(approvalId));
    expect(await res.json()).toMatchObject({ cancel_requested_job_ids: [leased.id] });
    expect((await tick(2 * MIN)).recovered).toBeGreaterThanOrEqual(1);
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested', leaseOwner: null });
    const last = await lastEvent(job!.id);
    expect(last).toMatchObject({ stateBefore: 'CANCEL_REQUESTED', stateAfter: 'UNKNOWN' });
    expect(last.sanitizedDetails).toMatchObject({
      transition: 'reconcile_unsupported',
      cause: 'lease_expired',
      reason: 'thread_partial_cancel_requested',
      not_sent: false,
      published_parts: 2,
    });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    await expectNoRepublish(x, 2);
  });

  it('(f) 게시된 것이 없으면 지금 규칙 그대로 — lease 뒤 보내기 전 연결 해제: 항목 PLANNED · 보내기 직전 approval_missing → BLOCKED(항목 PLANNED, 원격 호출 없음)', async () => {
    const acc = await linkedThreadsAccount();
    const p = await planApproved(acc.id, P1);
    expect((await execute(p.planId)).status).toBe(200);
    const leased = await leaseOnly(p.planId, p.item.id);
    expect((await itemOf(p.item.id)).status).toBe('QUEUED');
    const approvalId = await activeApprovalId(p.item.id);
    expect((await accountRevokePOST(post(`/api/channel-accounts/${acc.id}/revoke`), ctx(acc.id))).status).toBe(200);
    expect((await itemOf(p.item.id)).status).toBe('PLANNED');
    expect((await auditOf('approval.invalidate', approvalId)).sanitizedDetails).toMatchObject({ partial: false, leased_partial_jobs: 0 });
    const publishes = api.calls.publish;
    expect((await processJob(db, registry, leased, runOpts())).state).toBe('BLOCKED');
    expect((await jobsOf(p.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing' });
    expect((await itemOf(p.item.id)).status).toBe('PLANNED');
    expect(api.calls.publish).toBe(publishes);
    expect(api.postsOf(acc.external)).toHaveLength(0);
  });
});

/**
 * FIX1-FULLREV(F2 후속2): "보내지 않고 멈춤"의 공용 규칙(jobs.ts stopUnlessPartial)이 작업 처리기의 모든 멈춤 결정에 걸린다 —
 * 조회 lease 의 보내기 전 취소(checkJob), 전송 도중 취소 뒤 거절(finishSend), 보내기 전 lease 만료 한도·시도 한도·검증 실패(FAILED 대신),
 * 조회 결과가 단계 기록과 어긋날 때(applyReconcile). 게시된 단계·게시 시도 표식이 있으면 UNKNOWN, 없으면 지금까지와 같다(CANCELED·FAILED·BLOCKED+PLANNED).
 */
describe('FIX1-FULLREV(F2 후속2): 모든 멈춤 결정이 같은 규칙 — 부분 게시 작업은 CANCELED·FAILED("보내지 않음")가 아니라 UNKNOWN', () => {
  /** 마지막 사건(과 LEASED 멈춤이면 그 앞 BLOCKED 사건)의 모양 */
  async function expectStop(jobId: string, from: 'CANCEL_REQUESTED' | 'LEASED', reason: string, parts: number, extra: Record<string, unknown> = {}) {
    const [last, prev] = await eventsDesc(jobId);
    if (from === 'CANCEL_REQUESTED') {
      expect(last).toMatchObject({ stateBefore: 'CANCEL_REQUESTED', stateAfter: 'UNKNOWN' });
      expect(last!.sanitizedDetails).toMatchObject({ transition: 'reconcile_unsupported', reason, not_sent: false, published_parts: parts, publish_attempts: 0, ...extra });
      return;
    }
    expect(prev).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
    expect(prev!.sanitizedDetails).toMatchObject({ transition: 'blocked', reason, not_sent: false, published_parts: parts, publish_attempts: 0, ...extra });
    expect(last).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
    expect(last!.sanitizedDetails).toMatchObject({ transition: 'cancel_partial', cause: reason, not_sent: false, published_parts: parts, publish_attempts: 0 });
  }
  /** 계획 페이지와 같은 입력(최근 작업의 이력, 최신 먼저)으로 만든 항목 문구 */
  async function pageHeadline(job: typeof schema.jobs.$inferSelect) {
    const block = blockInfoOf(await eventsDesc(job.id), job);
    return itemHeadline({ status: 'UNKNOWN', channel: 'threads', job, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false });
  }
  /**
   * 전송 도중(어댑터 submit 안) 원격 단계가 기록된 직후에 끼어드는 훅 — 게시물 사이에 사용자 취소가 들어오는 경합 모사(어댑터는 게시물 사이에서
   * 취소를 보지 않는다). 한 번의 submit 에만 걸리고, 원래 submit·단계 기록은 그대로 부른다.
   */
  function duringSubmit(onRecorded: (step: { kind: string; post_index: number }) => Promise<void>) {
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
  /** 컨테이너만 만든 뒤 publish 429(게시 0) → RETRY_WAIT — 컨테이너 단계는 게시가 아니다 */
  async function containerOnly() {
    const acc = await linkedThreadsAccount();
    const p = await planApproved(acc.id, P1);
    expect((await execute(p.planId)).status).toBe(200);
    api.setRateBudget(acc.external, 0, 60);
    await tick();
    api.clearRateBudget(acc.external);
    const [job] = await jobsOf(p.item.id);
    expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited' });
    expect(await containersOf(p.item.id)).toHaveLength(1);
    expect(api.postsOf(acc.external)).toHaveLength(0);
    return { acc, ...p, jobId: job!.id };
  }
  const revokeApprovalOf = async (itemId: string) => {
    const approvalId = await activeApprovalId(itemId);
    const res = await revokePOST(post(`/api/approvals/${approvalId}/revoke`, {}), ctx(approvalId));
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { blocked_job_ids: string[]; partial_job_ids: string[]; cancel_requested_job_ids: string[] };
  };

  it('(g) 조회 lease 경로(checkJob): lease 뒤 철회(CANCEL_REQUESTED) → lease 만료 → 만료 복구 없이 다음 lease(조회 lease) → CANCELED 가 아니라 UNKNOWN · 게시 2개 그대로', async () => {
    const x = await partialThread();
    vt += 2 * MIN;
    const leased = await leaseOnly(x.planId, x.item.id);
    expect(await revokeApprovalOf(x.item.id)).toMatchObject({ cancel_requested_job_ids: [leased.id] });
    // 작업 처리기 A 가 죽고 lease 가 만료 — 이번 tick 의 만료 복구는 이미 지나갔고(또는 다른 처리기) 다음 lease 가 조회 lease 로 먼저 잡는다
    vt += 2 * MIN;
    const [checked] = await leaseJobs(db, { workerId: 'f2-w', now: new Date(Date.now() + vt), limit: 1, ownerId: owner, planId: x.planId });
    expect(checked).toMatchObject({ id: leased.id, state: 'CANCEL_REQUESTED', leaseOwner: 'f2-w' });
    expect((await processJob(db, registry, checked!, runOpts())).state).toBe('UNKNOWN');
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested', leaseOwner: null });
    await expectStop(job!.id, 'CANCEL_REQUESTED', 'thread_partial_cancel_requested', 2, { cause: 'check_lease' });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    expect(await pageHeadline(job!)).toContain('취소 뒤 남은 게시물은 보내지 않음');
    await expectNoRepublish(x, 2);
  });

  const MID_SUBMIT_FAULTS = [
    { name: '429(transient_failure)', code: 'rate_limited', arm: (ext: string) => api.setRateBudget(ext, 0, 60) },
    { name: '403(permanent_failure)', code: 'permission_denied', arm: (ext: string) => api.injectFault({ op: 'publish', kind: 'permission_denied', userId: ext }) },
    { name: '401(blocked)', code: 'auth_invalid_token', arm: (ext: string) => api.injectFault({ op: 'publish', kind: 'auth_invalid_token', userId: ext }) },
  ] as const;
  for (const f of MID_SUBMIT_FAULTS) {
    it(`(h) 전송 도중 취소(finishSend): 3개 스레드 1번째 게시 뒤 사용자 취소 → 2번째 게시 → 3번째 ${f.name} → CANCELED("보내지 않음")가 아니라 UNKNOWN · 게시 2개`, async () => {
      const acc = await linkedThreadsAccount();
      const x = { acc, ...(await planApproved(acc.id, THREE.join('\n\n'))) };
      expect((await execute(x.planId)).status).toBe(200);
      const seen: string[] = [];
      const spy = duringSubmit(async (s) => {
        if (s.kind !== 'publish') return;
        if (s.post_index === 0) {
          const c = await cancel(x.item.id);
          expect(c.status, await c.clone().text()).toBe(200);
          expect(await c.json()).toMatchObject({ cancel_requested: true, state: 'CANCEL_REQUESTED' });
          seen.push((await jobsOf(x.item.id))[0]!.state);
        }
        if (s.post_index === 1) f.arm(acc.external);
      });
      try {
        await tick();
      } finally {
        spy.mockRestore();
        api.clearRateBudget(acc.external);
      }
      expect(seen).toEqual(['CANCEL_REQUESTED']);
      expect(api.postsOf(acc.external)).toHaveLength(2);
      const [job] = await jobsOf(x.item.id);
      expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested', leaseOwner: null });
      await expectStop(job!.id, 'CANCEL_REQUESTED', 'thread_partial_cancel_requested', 2, { status: 'rejected', error_code: f.code });
      expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
      expect(await pageHeadline(job!)).toContain('취소 뒤 남은 게시물은 보내지 않음');
      await expectNoRepublish(x, 2);
    });
  }

  it('(i) 보내기 전 lease 만료가 한도(5)에 이름(LEASED → 복구 반복): FAILED("보내지 않음")가 아니라 UNKNOWN(thread_partial_stopped) · 시도·의도 그대로 · 게시 2개', async () => {
    const x = await partialThread();
    for (let k = 1; k <= 5; k++) {
      const t0 = new Date(Date.now() + vt + k * 10 * MIN);
      const [l] = await leaseJobs(db, { workerId: 'dead-w', now: t0, limit: 1, leaseTtlMs: 1000, ownerId: owner, planId: x.planId });
      expect(l?.id).toBe(x.jobId);
      await recoverExpiredLeases(db, { now: new Date(t0.getTime() + 5000), ownerId: owner });
    }
    vt += 60 * MIN;
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_stopped', leaseExpiredBeforeIntent: 5, attempt: 1, leaseOwner: null });
    expect(job!.cancelRequestedAt).toBeNull(); // FIX1-FULLREV(F2 후속2): 작업 처리기의 멈춤은 취소가 아니다
    await expectStop(job!.id, 'LEASED', 'lease_expired_before_intent', 2, { expiries: 5 });
    expect(await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job!.id))).toHaveLength(1);
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    const headline = await pageHeadline(job!);
    expect(headline).toContain('남은 게시물은 보내지 않음');
    expect(headline).not.toContain('새 계획');
    // FIX1-FULLREV(F2 후속2): 원인은 멈출 때의 BLOCKED 사유 — 일어나지 않은 원인(시도 한도·검증 실패)을 말하지 않는다
    expect(headline).toContain('보내기 전 멈춤(작업 처리기 중단 반복),');
    expect(headline).not.toContain('시도 한도');
    expect(headline).not.toContain('검증 실패');
    await expectNoRepublish(x, 2);
  });

  it('(j) 시도 한도(attempts_exhausted) — 마지막 시도로 이어 보내기 직전: FAILED("보내지 않음")가 아니라 UNKNOWN(thread_partial_stopped) · 새 의도 없음 · 게시 2개', async () => {
    const x = await partialThread();
    // 이 작업의 시도 한도 = 이미 쓴 시도 수(1) — 다음 lease 가 마지막 시도 뒤의 이어 보내기
    await db.update(schema.jobs).set({ maxAttempts: 1 }).where(eq(schema.jobs.id, x.jobId));
    const publishes = api.calls.publish;
    await tick(2 * MIN);
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_stopped', attempt: 1 });
    expect(job!.cancelRequestedAt).toBeNull(); // FIX1-FULLREV(F2 후속2): 시도 한도 멈춤은 취소가 아니다
    await expectStop(job!.id, 'LEASED', 'attempts_exhausted', 2);
    expect(await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job!.id))).toHaveLength(1);
    expect(api.calls.publish).toBe(publishes);
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    // FIX1-FULLREV(F2 후속2): 원인은 멈출 때의 BLOCKED 사유(attempts_exhausted) 하나만 — 중단 반복·검증 실패라고 하지 않는다
    const headline = await pageHeadline(job!);
    expect(headline).toContain('보내기 전 멈춤(시도 한도), 남은 게시물은 보내지 않음');
    expect(headline).not.toContain('중단 반복');
    expect(headline).not.toContain('검증 실패');
    await expectNoRepublish(x, 2);
  });

  it('(k) 검증 실패(어댑터 규칙이 바뀌어 같은 스냅샷이 이제 통과하지 못함) — 앞선 시도가 게시했으면 FAILED 가 아니라 UNKNOWN(thread_partial_stopped) · 게시 2개', async () => {
    const x = await partialThread();
    const spy = vi.spyOn(registry.threads, 'validate').mockReturnValue({ ok: false, error_code: 'invalid_media_spec:rule_changed' });
    try {
      await tick(2 * MIN);
    } finally {
      spy.mockRestore();
    }
    const [job] = await jobsOf(x.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_stopped' });
    expect(job!.cancelRequestedAt).toBeNull(); // FIX1-FULLREV(F2 후속2): 검증 실패 멈춤은 취소가 아니다
    await expectStop(job!.id, 'LEASED', 'validate_failed', 2, { error_code: 'invalid_media_spec:rule_changed' });
    expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
    // FIX1-FULLREV(F2 후속2): 화면 문구는 실제 원인(검증 실패) — 시도 한도·중단 반복이라고 하지 않는다
    const headline = await pageHeadline(job!);
    expect(headline).toContain('보내기 전 멈춤(검증 실패 — 내용이 지금 채널 규칙에 맞지 않음), 남은 게시물은 보내지 않음');
    expect(headline).not.toContain('시도 한도');
    expect(headline).not.toContain('중단 반복');
    await expectNoRepublish(x, 2);
  });

  const INCONSISTENT_RECONCILE = [
    { name: 'resumable(게시 0 보고)', r: { status: 'resumable', published_parts: 0, error_code: 'container_not_published' } },
    { name: 'not_found(확실히 없음 보고)', r: { status: 'not_found', error_code: 'no_remote_steps' } },
  ] as const;
  for (const c of INCONSISTENT_RECONCILE) {
    it(`(l) 취소 요청 뒤 조회가 ${c.name} — 단계 기록에 게시 2개가 있으면 CANCELED 가 아니라 UNKNOWN(조회 보고보다 단계 기록)`, async () => {
      const acc = await linkedThreadsAccount();
      const x = { acc, ...(await planApproved(acc.id, THREE.join('\n\n'), 'threads_thread_partial')) };
      expect((await execute(x.planId)).status).toBe(200);
      await tick();
      expect((await jobsOf(x.item.id))[0]!.state).toBe('RECONCILING');
      expect(api.postsOf(acc.external)).toHaveLength(2);
      expect(await (await cancel(x.item.id)).json()).toMatchObject({ cancel_requested: true });
      const spy = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce({ ...c.r });
      try {
        await tick(11_000);
      } finally {
        spy.mockRestore();
      }
      const [job] = await jobsOf(x.item.id);
      expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested' });
      await expectStop(job!.id, 'CANCEL_REQUESTED', 'thread_partial_cancel_requested', 2, { reconcile: c.r.status });
      expect((await itemOf(x.item.id)).status).toBe('UNKNOWN');
      await expectNoRepublish(x, 2);
    });
  }

  describe('게시된 것이 없으면(컨테이너만·손대지 않은 작업) 모든 경로가 지금까지와 같다', () => {
    it('lease 만료 복구(CANCEL_REQUESTED, 취소가 보내기 전): 컨테이너만 있는 작업·손대지 않은 단일 게시물 작업 모두 CANCELED{not_sent, cause:lease_expired}', async () => {
      const c = await containerOnly();
      const u = await (async () => {
        const acc = await linkedThreadsAccount();
        const p = await planApproved(acc.id, P1);
        expect((await execute(p.planId)).status).toBe(200);
        return { acc, ...p };
      })();
      vt += 2 * MIN;
      for (const x of [c, u]) {
        const publishes = api.calls.publish;
        const leased = await leaseOnly(x.planId, x.item.id);
        expect(await revokeApprovalOf(x.item.id)).toMatchObject({ cancel_requested_job_ids: [leased.id] });
        // 작업 처리기가 죽음 → 만료 복구가 이 작업을 정한다(다른 작업은 lease 하지 않도록 이 계획 범위로 lease)
        vt += 2 * MIN;
        expect(await recoverExpiredLeases(db, { now: new Date(Date.now() + vt), ownerId: owner })).toBeGreaterThanOrEqual(1);
        const [job] = await jobsOf(x.item.id);
        expect(job).toMatchObject({ state: 'CANCELED', leaseOwner: null });
        const last = await lastEvent(job!.id);
        expect(last).toMatchObject({ stateBefore: 'CANCEL_REQUESTED', stateAfter: 'CANCELED' });
        expect(last.sanitizedDetails).toMatchObject({ transition: 'canceled', not_sent: true, cause: 'lease_expired' });
        expect(last.sanitizedDetails).not.toHaveProperty('published_parts');
        expect((await itemOf(x.item.id)).status).toBe('CANCELED');
        expect(api.calls.publish).toBe(publishes);
        expect(api.postsOf(x.acc.external)).toHaveLength(0);
      }
    });

    it('보내기 직전(beginSend) 취소 요청·조회 lease(checkJob) 취소 요청: 컨테이너만 있는 작업은 CANCELED{not_sent}', async () => {
      const a = await containerOnly();
      vt += 2 * MIN;
      const la = await leaseOnly(a.planId, a.item.id);
      expect(await revokeApprovalOf(a.item.id)).toMatchObject({ cancel_requested_job_ids: [la.id] });
      expect((await processJob(db, registry, la, runOpts())).state).toBe('CANCELED');
      expect((await lastEvent(la.id)).sanitizedDetails).toMatchObject({ transition: 'canceled', not_sent: true, attempt: 1 });

      const b = await containerOnly();
      vt += 2 * MIN;
      const lb = await leaseOnly(b.planId, b.item.id);
      expect(await revokeApprovalOf(b.item.id)).toMatchObject({ cancel_requested_job_ids: [lb.id] });
      vt += 2 * MIN;
      const [checked] = await leaseJobs(db, { workerId: 'f2-w', now: new Date(Date.now() + vt), limit: 1, ownerId: owner, planId: b.planId });
      expect(checked).toMatchObject({ id: lb.id, state: 'CANCEL_REQUESTED' });
      expect((await processJob(db, registry, checked!, runOpts())).state).toBe('CANCELED');
      const last = await lastEvent(lb.id);
      expect(last).toMatchObject({ stateBefore: 'CANCEL_REQUESTED', stateAfter: 'CANCELED' });
      expect(last.sanitizedDetails).toMatchObject({ transition: 'canceled', not_sent: true });
      for (const x of [a, b]) {
        expect((await itemOf(x.item.id)).status).toBe('CANCELED');
        expect(api.postsOf(x.acc.external)).toHaveLength(0);
      }
    });

    it('보내기 직전 approval_missing: 컨테이너만 있는 작업은 BLOCKED·항목 PLANNED(다시 승인 가능)', async () => {
      const x = await containerOnly();
      vt += 2 * MIN;
      const leased = await leaseOnly(x.planId, x.item.id);
      await db.update(schema.approvals).set({ revokedAt: new Date(), revokeReason: 'test: race' }).where(eq(schema.approvals.distributionItemId, x.item.id));
      expect((await processJob(db, registry, leased, runOpts())).state).toBe('BLOCKED');
      expect((await jobsOf(x.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing' });
      expect((await lastEvent(leased.id)).sanitizedDetails).not.toHaveProperty('published_parts');
      expect((await itemOf(x.item.id)).status).toBe('PLANNED');
    });

    it('전송 도중 취소 뒤 거절(finishSend): 단일 게시물 컨테이너 직후 취소 → publish 429 → CANCELED{not_sent}(게시 0)', async () => {
      const acc = await linkedThreadsAccount();
      const x = await planApproved(acc.id, P1);
      expect((await execute(x.planId)).status).toBe(200);
      let fired = false;
      const spy = duringSubmit(async (s) => {
        if (s.kind !== 'container' || fired) return;
        fired = true;
        expect(await (await cancel(x.item.id)).json()).toMatchObject({ cancel_requested: true });
        api.setRateBudget(acc.external, 0, 60);
      });
      try {
        await tick();
      } finally {
        spy.mockRestore();
        api.clearRateBudget(acc.external);
      }
      expect(fired).toBe(true);
      const [job] = await jobsOf(x.item.id);
      expect(job).toMatchObject({ state: 'CANCELED' });
      expect((await lastEvent(job!.id)).sanitizedDetails).toMatchObject({ transition: 'canceled', not_sent: true, error_code: 'rate_limited' });
      expect((await itemOf(x.item.id)).status).toBe('CANCELED');
      expect(api.postsOf(acc.external)).toHaveLength(0);
    });
  });

  it('(n) FIX1-FULLREV(F2 후속2): 정말 취소인 멈춤만 cancelRequestedAt — 시작 전 사용자 취소(cancelItem, thread_partial_canceled)는 씀 · 무효·작업 처리기 멈춤은 쓰지 않음', async () => {
    // 사용자 취소(RETRY_WAIT, 게시 2) — 취소 요청 시각을 쓴다(뒤에 CONFIRMED 가 되면 "취소 불가(이미 전송됨)"가 맞다)
    const c = await partialThread();
    const res = await cancel(c.item.id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ canceled: false, state: 'UNKNOWN', published_parts: 2 });
    const [canceled] = await jobsOf(c.item.id);
    expect(canceled).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_canceled' });
    expect(canceled!.cancelRequestedAt).not.toBeNull();
    expect((await lastEvent(canceled!.id)).sanitizedDetails).toMatchObject({ transition: 'cancel_partial', cause: 'user', not_sent: false, published_parts: 2 });
    // 같은 모양의 작업이 시도 한도로 멈춤(보내기 직전) — 아무도 취소를 요청하지 않았다
    const s = await partialThread();
    await db.update(schema.jobs).set({ maxAttempts: 1 }).where(eq(schema.jobs.id, s.jobId));
    await tick(2 * MIN);
    const [stopped] = await jobsOf(s.item.id);
    expect(stopped).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_stopped' });
    expect(stopped!.cancelRequestedAt).toBeNull();
    await expectNoRepublish(c, 2);
    await expectNoRepublish(s, 2);
  });

  it('(m) 보류(401, 게시 1) → 재시도 → lease → 사용자 취소(보내기 전) → UNKNOWN — 앞선 401 BLOCKED 사유가 화면 문구를 가리지 않음("새 계획 필요" 아님)', async () => {
    const p = await blockedAfterOnePost();
    const r = await retry(p.item.id);
    expect(r.status, await r.clone().text()).toBe(200);
    const leased = await leaseOnly(p.planId, p.item.id);
    expect(await (await cancel(p.item.id)).json()).toMatchObject({ cancel_requested: true });
    expect((await processJob(db, registry, leased, runOpts())).state).toBe('UNKNOWN');
    const [job] = await jobsOf(p.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_cancel_requested' });
    await expectStop(job!.id, 'CANCEL_REQUESTED', 'thread_partial_cancel_requested', 1);
    // 화면 입력: 최근 BLOCKED 사건은 앞선 401(auth) — blockReason 이 그 사유여도 작업 코드로 고른다
    const block = blockInfoOf(await eventsDesc(job!.id), job!);
    expect(block.code).toBe('auth');
    const headline = await pageHeadline(job!);
    expect(headline).toContain('취소 뒤 남은 게시물은 보내지 않음');
    expect(headline).not.toContain('새 계획 필요');
    await expectNoRepublish(p, 1);
  });
});
