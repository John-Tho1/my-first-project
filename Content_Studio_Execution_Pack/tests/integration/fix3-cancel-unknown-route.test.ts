/**
 * FIX3-FULLREV(R2, 사용자 결정 2026-10-23 "다 권고 사항으로 진행해줘" · FULLREV1 인계 FIX round 2 질문 2): 취소 HTML 폼
 * (POST /api/distribution-items/{id}/cancel, accept text/html)의 303 리다이렉트를 결과마다 본다.
 *  - 취소됨 → canceled=1 · 취소 확인 중 → cancel_requested=1 (지금 그대로)
 *  - 결과 불명(UNKNOWN) — 부분 게시(thread_partial_canceled)·복원 미확정(restored_cancel_unverified) → cancel_unknown=1 + 항목 + 허용 목록 사유 코드
 *    (예전에는 cancel_requested=1 — "취소 확인 중"을 뜻함)
 * 리다이렉트 쿼리 + 저장된 계획 상세(getPlanDetail)를 계획 화면과 같은 함수(bannersFromState·cancelUnknownBannerOf)에 넣어 배너까지 확인한다.
 * JSON 응답은 그대로(같은 결과의 다른 항목을 JSON 으로 취소). 모의 어댑터만 — **네트워크 호출 0**(fetch 0 확인).
 * 복원한 작업 표시는 live-threads-publish·live-orphan-blocked 와 같이 작업 행에 직접 켠다(작업만 표시된 복원 작업 — fullrev2-restored-cancel S5 와 같은 모양).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import {
  closeDb,
  createContent,
  createVariantDraft,
  getDb,
  getPlanDetail,
  leaseJobs,
  listChannelAccounts,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig } from '@cs/domain';
import { createMockAdapterRegistry, THREADS_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { bannersFromState, CANCEL_UNKNOWN_BANNER, cancelUnknownBannerOf } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const config = loadConfig({});
const registry = createMockAdapterRegistry();
const api = registry.threads.api;

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let seedThreads: string;
let fetchCalls = 0;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
/** 계획 화면의 취소 폼과 같은 요청(HTML — accept text/html, plan_id 숨은 필드) */
const cancelForm = (itemId: string, planId: string) =>
  cancelPOST(
    new Request(`${BASE}/api/distribution-items/${itemId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(token) },
      body: new URLSearchParams({ plan_id: planId }).toString(),
    }),
    ctx(itemId),
  );

async function linkedThreadsAccount(): Promise<{ id: string; external: string }> {
  const external = `mock:threads:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads FIX3 R2', state: 'mock_ready' })
    .returning();
  const c = await connectPOST(post(`/api/channel-accounts/${row!.id}/connect`), ctx(row!.id));
  expect(c.status).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  const a = await mockAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  const cb = await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  return { id: row!.id, external };
}

/** 원고 → Threads 파생본(review) → 계획(항목 1개) → (모의 시나리오) → 승인 → 실행 */
async function executed(accountId: string, body: string, scenario?: string): Promise<{ planId: string; itemId: string }> {
  const { content } = await createContent(db, owner, { title: `FIX3 R2 ${randomUUID().slice(0, 6)}`, body });
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
  expect((await executePOST(post(`/api/distribution-plans/${p.plan.id}/execute`, { command_key: `k-${randomUUID()}` }), ctx(p.plan.id))).status).toBe(200);
  return { planId: p.plan.id, itemId: item.id };
}

const tickPlan = (planId: string) =>
  runJobsTick(db, registry, { workerId: 'fix3-r2', config, ownerId: owner, planId, random: () => 0.5, submitTimeoutMs: 5000, maxJobs: 5, credentials: jobCredentials(config, db) });
const jobOf = async (itemId: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const itemStatus = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!.status;

/** 303 Location 을 검사하고 그 쿼리를 계획 화면과 같은 모양(Record)으로 돌려준다 */
function redirectQuery(res: Response, planId: string, expectedQuery: string): Record<string, string> {
  expect(res.status).toBe(303);
  const loc = res.headers.get('location')!;
  expect(loc).toBe(`/distribute/${planId}?${expectedQuery}`);
  return Object.fromEntries(new URL(loc, BASE).searchParams.entries());
}
/** 저장된 계획 상세로 계획 화면의 취소 배너 판정(bannersFromState·cancelUnknownBannerOf) */
async function bannersFor(planId: string, q: Record<string, string>) {
  const d = (await getPlanDetail(db, owner, planId))!;
  return { old: bannersFromState(q, d), unknown: cancelUnknownBannerOf(q, d) };
}

/** 3개 게시물 스레드, 1번째 게시 뒤 2번째 429 → RETRY_WAIT(게시 1) */
async function partialThread(): Promise<{ planId: string; itemId: string; external: string }> {
  const acc = await linkedThreadsAccount();
  const x = await executed(acc.id, ['첫째 — 재고 기준.', '둘째 — 가격표.', '셋째 — 숫자 맞추기.'].join('\n\n'));
  api.setRateBudget(acc.external, 1, 60);
  await tickPlan(x.planId);
  api.clearRateBudget(acc.external);
  expect(await jobOf(x.itemId)).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited' });
  expect(api.postsOf(acc.external)).toHaveLength(1);
  return { ...x, external: acc.external };
}
/** 첫 컨테이너 401 → BLOCKED(의도 1 확정 거절·단계 0) → 작업에 복원 표시(작업만 표시된 복원 작업) */
async function restoredBlocked(): Promise<{ planId: string; itemId: string }> {
  const acc = await linkedThreadsAccount();
  const x = await executed(acc.id, '첫 컨테이너에서 401 이 난 글.', 'threads_token_invalid');
  await tickPlan(x.planId);
  const job = await jobOf(x.itemId);
  expect(job).toMatchObject({ state: 'BLOCKED', lastRetryClass: 'auth' });
  expect((await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, job.id))).map((i) => i.outcome)).toEqual(['rejected']);
  expect(await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.jobId, job.id))).toHaveLength(0);
  await db.update(schema.jobs).set({ restoredNeedsReview: true }).where(eq(schema.jobs.id, job.id));
  return x;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix3-r2-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FIX3 R2 시험: 네트워크 호출 금지');
  });
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
  registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT };
  seedThreads = (await listChannelAccounts(db, owner)).find((a) => a.platform === 'threads' && a.kind === 'mock' && a.credentialState === 'none')!.id;
}, 120_000);
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('FIX3-FULLREV(R2): 취소 HTML 리다이렉트 — 결과마다 다른 쿼리, 결과 불명은 "취소 확인 중"이 아니다', () => {
  it('취소됨(아직 보내지 않은 QUEUED 작업) → canceled=1 그대로 · 취소됨 배너만', async () => {
    const x = await executed(seedThreads, '보낸 적 없는 글.');
    expect((await jobOf(x.itemId)).state).toBe('QUEUED');
    const q = redirectQuery(await cancelForm(x.itemId, x.planId), x.planId, 'canceled=1');
    expect((await jobOf(x.itemId)).state).toBe('CANCELED');
    const b = await bannersFor(x.planId, q);
    expect(b.old).toMatchObject({ canceled: true, cancelRequested: false });
    expect(b.unknown).toBeNull();
  });

  it('취소 확인 중(이미 lease 된 작업) → cancel_requested=1 그대로 · 취소 확인 중 배너만', async () => {
    const x = await executed(seedThreads, '처리기가 막 가져간 글.');
    const leased = await leaseJobs(db, { workerId: 'fix3-r2-lease', now: new Date(), limit: 1, ownerId: owner, planId: x.planId });
    expect(leased.map((j) => j.itemId)).toEqual([x.itemId]);
    const q = redirectQuery(await cancelForm(x.itemId, x.planId), x.planId, 'cancel_requested=1');
    expect((await jobOf(x.itemId)).state).toBe('CANCEL_REQUESTED');
    const b = await bannersFor(x.planId, q);
    expect(b.old).toMatchObject({ canceled: false, cancelRequested: true });
    expect(b.unknown).toBeNull();
  });

  it('결과 불명 — 부분 게시(thread_partial_canceled) → cancel_unknown=1 + 항목 + 사유 코드(cancel_requested 아님) · 전용 배너(모의) · 다시 보내지 않음 · JSON 응답은 그대로', async () => {
    const x = await partialThread();
    const q = redirectQuery(await cancelForm(x.itemId, x.planId), x.planId, `cancel_unknown=1&cancel_item=${x.itemId}&cancel_reason=thread_partial_canceled`);
    expect(q).not.toHaveProperty('cancel_requested');
    expect(q).not.toHaveProperty('canceled');
    const job = await jobOf(x.itemId);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_canceled' });
    expect(job.cancelRequestedAt).not.toBeNull();
    expect(await itemStatus(x.itemId)).toBe('UNKNOWN');
    const b = await bannersFor(x.planId, q);
    expect(b.old).toMatchObject({ canceled: false, cancelRequested: false });
    expect(b.unknown).toBe(CANCEL_UNKNOWN_BANNER.partial.mock);
    // 남은 게시물은 보내지 않는다(작업 처리기가 가져가지 않음)
    expect((await tickPlan(x.planId)).leased).toBe(0);
    expect(api.postsOf(x.external)).toHaveLength(1);

    // JSON 경로는 그대로(같은 결과의 다른 항목)
    const y = await partialThread();
    const res = await cancelPOST(post(`/api/distribution-items/${y.itemId}/cancel`), ctx(y.itemId));
    expect(res.status).toBe(200);
    const yJob = await jobOf(y.itemId);
    expect(await res.json()).toEqual({
      item_id: y.itemId,
      job_id: yJob.id,
      canceled: false,
      cancel_requested: false,
      state: 'UNKNOWN',
      published_parts: 1,
      reason: 'thread_partial_canceled',
      message: '남은 부분은 보내지 않습니다. 이미 게시된 1개는 원격에 남아 있습니다(MOCK — 취소로 되돌리지 않음).',
    });
  });

  it('결과 불명 — 복원 미확정(restored_cancel_unverified) → cancel_unknown=1 + 항목 + 사유 코드 · 전용 배너(모의 — 실제 채널로 보낸 것 없음) · JSON 응답은 그대로', async () => {
    const x = await restoredBlocked();
    const q = redirectQuery(await cancelForm(x.itemId, x.planId), x.planId, `cancel_unknown=1&cancel_item=${x.itemId}&cancel_reason=restored_cancel_unverified`);
    expect(q).not.toHaveProperty('cancel_requested');
    const job = await jobOf(x.itemId);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'restored_cancel_unverified', restoredNeedsReview: true });
    expect(job.cancelRequestedAt).not.toBeNull();
    expect(await itemStatus(x.itemId)).toBe('UNKNOWN');
    const b = await bannersFor(x.planId, q);
    expect(b.old).toMatchObject({ canceled: false, cancelRequested: false });
    expect(b.unknown).toBe(CANCEL_UNKNOWN_BANNER.restored_unverified.mock);
    // 같은 쿼리의 사유 코드만 바꿔 끼우면(부분 게시라고 주장) 저장된 작업 코드와 달라 일반 문구 — 사유를 단정하지 않는다
    expect((await bannersFor(x.planId, { ...q, cancel_reason: 'thread_partial_canceled' })).unknown).toBe(CANCEL_UNKNOWN_BANNER.generic.mock);
    // 다른 계획의 화면에서는 이 항목의 배너가 나오지 않는다
    const other = await executed(seedThreads, '다른 계획의 글.');
    expect((await bannersFor(other.planId, q)).unknown).toBeNull();

    const y = await restoredBlocked();
    const res = await cancelPOST(post(`/api/distribution-items/${y.itemId}/cancel`), ctx(y.itemId));
    expect(res.status).toBe(200);
    const yJob = await jobOf(y.itemId);
    expect(await res.json()).toEqual({
      item_id: y.itemId,
      job_id: yJob.id,
      canceled: false,
      cancel_requested: false,
      state: 'UNKNOWN',
      published_parts: 0,
      reason: 'restored_cancel_unverified',
      message:
        'MOCK — 더 보내지 않습니다. 복원한 모의 작업이라 모의 전송 여부를 복원된 기록으로 확인할 수 없어 취소를 확정하지 않았습니다(결과 불명 — 자동 재전송 안 함). 실제 채널로 보낸 것은 없습니다.',
    });
  });

  it('결과 불명이 된 항목을 다시 취소(HTML)하면 지금처럼 409 cancel_unknown 오류 리다이렉트(배너 쿼리 아님)', async () => {
    const x = await restoredBlocked();
    redirectQuery(await cancelForm(x.itemId, x.planId), x.planId, `cancel_unknown=1&cancel_item=${x.itemId}&cancel_reason=restored_cancel_unverified`);
    const again = await cancelForm(x.itemId, x.planId);
    expect(again.status).toBe(303);
    const loc = new URL(again.headers.get('location')!, BASE);
    expect(loc.pathname).toBe(`/distribute/${x.planId}`);
    expect(loc.searchParams.get('error')).toBe('cancel_unknown');
    expect(loc.searchParams.has('cancel_unknown')).toBe(false);
  });
});
