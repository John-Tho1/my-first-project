/**
 * FIX1-FULLREV3(H2, 검토 기록 docs/handoffs/FULLREV3_CLAUDE_REVIEW.md, 결정 D40-2 "표시를 붙이면 승인 무효, 지워도 되살아나지 않음"):
 * 위험 표시 '확인 필요' 훅(invalidateApprovalsForRisk — 아이디어·소재)은 계정 훅(G8)처럼 진행 중 항목(SENDING·REMOTE_PROCESSING·RECONCILING·CANCEL_REQUESTED)의
 * 활성 승인도 invalidated:risk_needs_check 로 철회한다(작업·항목 상태는 그대로). 전에는 대기 상태만 봐서, 진행 중에 표시를 붙였다 해제한 뒤 재개하면
 * 다음 전송이 옛 승인으로 게시됐다. 이제:
 *  - 재개(resumable) → 다음 전송의 보내기 직전 재검사가 approval_missing → 게시된 것이 없으면 항목 PLANNED, 스레드 일부가 게시됐으면 UNKNOWN(thread_partial_revoked).
 *  - 보내는 중(SENDING) 표시 → 그 시도가 보류(auth)로 끝나면 finishSend 의 blockedUnlessApprovalGone → 항목 PLANNED(막다른 길 아님).
 *  - 해제한 뒤 다시 승인 → 실행은 정상으로 게시한다.
 * 모의 Threads 만(T13 모의 OAuth 연결) — **네트워크 호출 0**(fetch 0 확인).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { closeDb, createCapture, createContent, createIdea, createVariantDraft, getDb, runJobsTick, schema, seed, setVariantLifecycle, type Db } from '@cs/db';
import { loadConfig, type AdapterResult, type ReconcileResult } from '@cs/domain';
import { createMockAdapterRegistry, THREADS_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { PATCH as capturePATCH } from '../../apps/web/app/api/captures/[id]/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { PATCH as ideaPATCH } from '../../apps/web/app/api/ideas/[id]/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner-h2@example.local';
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
const patchReq = (p: string, body: unknown) =>
  new Request(`${BASE}${p}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
    body: JSON.stringify(body),
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
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads H2', state: 'mock_ready' })
    .returning();
  await connectFully(row!.id);
  return { id: row!.id, external };
}

const P1 = '해외 영업 첫 달, 대리점 주문 주기를 먼저 맞췄다.';
const THREE = ['첫째 — 주문 주기를 먼저 맞췄다.', '둘째 — 재고 표는 주마다 갱신했다.', '셋째 — 가격 조정은 분기마다 했다.'];

interface Planned {
  planId: string;
  item: { id: string; payload_hash: string };
  ideaId: string;
  captureId: string;
  variantId: string;
}
/** 아이디어 + 소재(위험 표시 없음)를 연결한 원고 → Threads 파생본(review) → 계획(항목 1개) → (모의 시나리오) → 승인(mock_publish) → 실행 */
async function executed(accountId: string, body: string, scenario?: string): Promise<Planned> {
  const tag = randomUUID().slice(0, 8);
  const idea = await createIdea(db, owner, { idea: `H2 아이디어 ${tag}` });
  const { capture } = await createCapture(db, owner, { input_type: 'text', raw_text: `H2 소재 ${tag}`, command_key: `h2-${tag}` });
  const { content } = await createContent(db, owner, { title: `H2 ${tag}`, body, ideaId: idea.id, captureIds: [capture.id] });
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
  const x = { planId: p.plan.id, item, ideaId: idea.id, captureId: capture.id, variantId: variant.id };
  const ap = await approveAgain(x);
  expect(ap.status, await ap.clone().text()).toBe(200);
  await executeAgain(x);
  return x;
}
const approveAgain = (x: { planId: string; item: { id: string; payload_hash: string } }) =>
  approvePOST(
    post(`/api/distribution-plans/${x.planId}/approve`, { item_ids: [x.item.id], expected_hashes: { [x.item.id]: x.item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
    ctx(x.planId),
  );
async function executeAgain(x: { planId: string }) {
  const ex = await executePOST(post(`/api/distribution-plans/${x.planId}/execute`, { command_key: `k-${randomUUID()}` }), ctx(x.planId));
  expect(ex.status, await ex.clone().text()).toBe(200);
}
const retry = (itemId: string) => retryPOST(post(`/api/distribution-items/${itemId}/retry`), ctx(itemId));

const ideaRev = async (id: string) => (await db.select().from(schema.ideas).where(eq(schema.ideas.id, id)))[0]!.revision;
const captureRev = async (id: string) => (await db.select().from(schema.captures).where(eq(schema.captures.id, id)))[0]!.revision;
/** 아이디어 위험 표시 PATCH(실제 경로 — 훅 invalidateApprovalsForRisk) */
async function setIdeaRisk(id: string, risk: 'none' | 'needs_check') {
  const r = await ideaPATCH(patchReq(`/api/ideas/${id}`, { expected_revision: await ideaRev(id), risk }), ctx(id));
  expect(r.status, await r.clone().text()).toBe(200);
}
/** 소재 위험 표시 PATCH(실제 경로 — 훅 invalidateApprovalsForRisk) */
async function setCaptureRisk(id: string, risk: 'none' | 'needs_check') {
  const r = await capturePATCH(patchReq(`/api/captures/${id}`, { expected_revision: await captureRev(id), risk }), ctx(id));
  expect(r.status, await r.clone().text()).toBe(200);
}

/** 이 계획의 작업만 처리(다른 시험의 작업과 섞이지 않게) */
async function tick(planId: string, advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 'h2-w',
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
const variantOf = async (id: string) => (await db.select().from(schema.variants).where(eq(schema.variants.id, id)))[0]!;
const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));
const approvalsOf = (itemId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId)).orderBy(asc(schema.approvals.approvedAt));

/** 조회 한 번 — 모의 어댑터의 reconcile 이 r 을 돌려주게 하고 이 계획의 작업만 처리 */
async function check(planId: string, r: ReconcileResult, advanceMs = MIN) {
  const spy = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce({ ...r });
  try {
    return (await tick(planId, advanceMs)).results;
  } finally {
    spy.mockRestore();
  }
}

/** 모의 Threads 의 첫 전송이 원격 처리 중(processing)을 돌려준다 → REMOTE_PROCESSING(시도 1). 게시물 0. */
async function remoteProcessing() {
  const acc = await linkedThreadsAccount();
  const x = await executed(acc.id, P1);
  const processing: AdapterResult = { status: 'processing', error_code: 'container_in_progress' };
  const submit = vi.spyOn(registry.threads, 'submit').mockResolvedValueOnce(processing);
  try {
    expect((await tick(x.planId)).results).toEqual({ REMOTE_PROCESSING: 1 });
  } finally {
    submit.mockRestore();
  }
  const [job] = await jobsOf(x.item.id);
  expect(job).toMatchObject({ state: 'REMOTE_PROCESSING', attempt: 1 });
  expect((await itemOf(x.item.id)).status).toBe('REMOTE_PROCESSING');
  return { acc, ...x, jobId: job!.id };
}

/** 진행 중 항목의 승인이 위험 표시로 철회됐는지 — 작업·항목 상태는 그대로, 취소 요청 아님, 감사 기록 item_status_before */
async function expectRevokedInFlight(itemId: string, state: string) {
  const aps = await approvalsOf(itemId);
  expect(aps).toHaveLength(1);
  expect(aps[0]!.revokedAt).not.toBeNull();
  expect(aps[0]!.revokeReason).toBe('invalidated:risk_needs_check');
  expect((await jobsOf(itemId))[0]).toMatchObject({ state, cancelRequestedAt: null });
  expect((await itemOf(itemId)).status).toBe(state);
  const audit = (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.action, 'approval.invalidate'), eq(schema.auditEvents.entityId, aps[0]!.id))))[0]!;
  expect(audit.sanitizedDetails).toMatchObject({ item_id: itemId, reason: 'invalidated:risk_needs_check', item_status_before: state, blocked_jobs: 0, partial: false });
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr3-h2-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FR3 H2 시험: 네트워크 호출 금지');
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

describe("FIX1-FULLREV3(H2): 진행 중 항목에 '확인 필요' → 해제 → 재개해도 옛 승인으로 게시하지 않는다", () => {
  it.each(['아이디어', '소재'] as const)(
    "(a) REMOTE_PROCESSING → %s '확인 필요'(PATCH): 승인 invalidated:risk_needs_check · 작업·항목 그대로 → 해제(승인 되살아나지 않음) → 재개(resumable) → 보내기 직전 approval_missing → 작업 BLOCKED·항목 PLANNED · 게시 0 → 다시 승인·실행 → 게시 1번",
    async (source) => {
      const x = await remoteProcessing();
      const setRisk = (risk: 'none' | 'needs_check') => (source === '아이디어' ? setIdeaRisk(x.ideaId, risk) : setCaptureRisk(x.captureId, risk));
      await setRisk('needs_check');
      await expectRevokedInFlight(x.item.id, 'REMOTE_PROCESSING');
      expect((await variantOf(x.variantId)).lifecycle).toBe('review');
      // 해제해도 승인은 되살아나지 않는다(D40-2)
      await setRisk('none');
      expect((await approvalsOf(x.item.id)).every((a) => a.revokedAt !== null)).toBe(true);

      const submit = vi.spyOn(registry.threads, 'submit');
      try {
        expect(await check(x.planId, { status: 'resumable', published_parts: 0, error_code: 'container_not_published' }, 16_000)).toEqual({ RETRY_WAIT: 1 });
        expect((await tick(x.planId, 1000)).results).toEqual({ BLOCKED: 1 });
        expect(submit).not.toHaveBeenCalled();
      } finally {
        submit.mockRestore();
      }
      const [job] = await jobsOf(x.item.id);
      expect(job).toMatchObject({ id: x.jobId, state: 'BLOCKED', lastErrorCode: 'approval_missing', leaseOwner: null });
      const last = (await eventsOf(job!.id)).at(-1)!;
      expect(last).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
      expect(last.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing' });
      expect((await itemOf(x.item.id)).status).toBe('PLANNED');
      expect(api.postsOf(x.acc.external)).toHaveLength(0);
      expect((await tick(x.planId, 20 * MIN)).results).toEqual({});
      expect(api.postsOf(x.acc.external)).toHaveLength(0);

      // 해제한 뒤 다시 승인 → 실행: 새 작업이 게시
      const re = await approveAgain(x);
      expect(re.status, await re.clone().text()).toBe(200);
      await executeAgain(x);
      expect((await tick(x.planId, MIN)).results).toEqual({ CONFIRMED: 1 });
      expect(await jobsOf(x.item.id)).toHaveLength(2);
      expect(api.postsOf(x.acc.external)).toHaveLength(1);
      expect((await itemOf(x.item.id)).status).toBe('CONFIRMED');
    },
  );

  it("(b) 스레드 일부 게시(1·2 게시 → 3번째 원격 처리 중) → 소재 '확인 필요' → 해제 → 재개 → approval_missing → PLANNED 가 아니라 UNKNOWN(thread_partial_revoked) · 게시 2개 그대로 · 다시 승인 409", async () => {
    const acc = await linkedThreadsAccount();
    const x = { acc, ...(await executed(acc.id, THREE.join('\n\n'), 'threads_thread_partial')) };
    expect((await tick(x.planId)).results).toEqual({ RECONCILING: 1 });
    expect(api.postsOf(acc.external)).toHaveLength(2);
    expect(await check(x.planId, { status: 'processing', published_parts: 2, error_code: 'container_in_progress' }, 11_000)).toEqual({ REMOTE_PROCESSING: 1 });
    await setCaptureRisk(x.captureId, 'needs_check');
    await expectRevokedInFlight(x.item.id, 'REMOTE_PROCESSING');
    await setCaptureRisk(x.captureId, 'none');

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
    const re = await approveAgain(x);
    expect(re.status).toBe(409);
    expect(await re.json()).toMatchObject({ error: 'item_not_planned' });
    expect((await tick(x.planId, 20 * MIN)).results).toEqual({});
    expect(api.postsOf(acc.external)).toHaveLength(2);
  });

  it("(c) 보내는 중(SENDING — 어댑터 호출 도중) 아이디어 '확인 필요' → 해제, 그 시도가 첫 컨테이너 401(auth) → 작업 BLOCKED(approval_missing, 원인 auth)·항목 PLANNED(막다른 길 아님) · 재시도 409 다시 승인 안내 → 다시 승인·실행 → 게시 1번", async () => {
    const acc = await linkedThreadsAccount();
    const x = await executed(acc.id, '해외 영업 둘째 달, 보내는 중 위험 표시 글.');
    api.injectFault({ op: 'createContainer', kind: 'auth_invalid_token', userId: acc.external });
    const original = registry.threads.submit.bind(registry.threads);
    const submit = vi.spyOn(registry.threads, 'submit').mockImplementationOnce(async (...args) => {
      // 작업 처리기는 외부 호출 중 DB 잠금을 쥐지 않는다 — 항목 SENDING 에서 훅이 승인을 철회한다
      expect((await itemOf(x.item.id)).status).toBe('SENDING');
      await setIdeaRisk(x.ideaId, 'needs_check');
      await expectRevokedInFlight(x.item.id, 'SENDING');
      await setIdeaRisk(x.ideaId, 'none');
      return original(...args);
    });
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
    expect(last.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing', cause: 'auth', error_code: 'auth_invalid_token' });
    expect((await itemOf(x.item.id)).status).toBe('PLANNED');
    expect(api.postsOf(acc.external)).toHaveLength(0);
    const rt = await retry(x.item.id);
    expect(rt.status).toBe(409);
    expect(((await rt.json()) as { error: string }).error).toBe('approval_required');
    expect((await tick(x.planId, MIN)).results).toEqual({});

    const re = await approveAgain(x);
    expect(re.status, await re.clone().text()).toBe(200);
    await executeAgain(x);
    expect((await tick(x.planId, MIN)).results).toEqual({ CONFIRMED: 1 });
    expect(await jobsOf(x.item.id)).toHaveLength(2);
    expect(api.postsOf(acc.external)).toHaveLength(1);
  });

  it("(d) 대조: 위험 표시를 'none' 으로만 다시 저장하면 진행 중 항목의 승인은 그대로 — 재개 뒤 그대로 이어 보낸다(게시 1번)", async () => {
    const x = await remoteProcessing();
    await setIdeaRisk(x.ideaId, 'none');
    await setCaptureRisk(x.captureId, 'none');
    expect((await approvalsOf(x.item.id))[0]!.revokedAt).toBeNull();
    expect(await check(x.planId, { status: 'resumable', published_parts: 0, error_code: 'container_not_published' }, 16_000)).toEqual({ RETRY_WAIT: 1 });
    expect((await tick(x.planId, 1000)).results).toEqual({ CONFIRMED: 1 });
    expect(api.postsOf(x.acc.external)).toHaveLength(1);
  });
});
