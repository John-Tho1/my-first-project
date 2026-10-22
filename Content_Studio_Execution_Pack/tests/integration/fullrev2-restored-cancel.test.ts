/**
 * FIX2-FULLREV(Q3, 사용자 결정 2026-10-22 "다 권고 사항으로 진행해줘" · D18·FIX-T10·FIX-T14 후속): 복원한 작업(읽기 전용 이력 — restored_needs_review)의
 * 사용자 취소는 복원된 기록(전송 의도·단계 기록)이 "아무것도 보내지 않음"을 증명할 때만 CANCELED(not_sent). 증명이 없으면 UNKNOWN(restored_cancel_unverified)
 * — 다시 보내지 않는다(실제 계정이면 채널에서 직접 확인하라고 안내, FIX2-FULLREV(FX4): 모의 계정은 확인할 곳이 없어 "MOCK — 실제 채널로 보낸 것 없음"). 단계 기록은 migration 0031 이후 묶음에만 있으므로 이전 묶음(단계 없음)은 단계 기록을 지운 묶음으로 흉내 낸다.
 * 내보내기 → (그대로 / 단계 기록을 뺀) 묶음 → 빈 DB 복원 → 복원 환경에서 취소. 모의 어댑터만 — **네트워크 호출 0**(fetch 0 확인).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asc, desc, eq } from 'drizzle-orm';
import {
  cancelItem,
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
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildBundle, loadConfig, writeZip, type BundleTables } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, THREADS_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import {
  blockInfoOf,
  itemHeadline,
  jobStatusText,
  liveItemHeadline,
  UNKNOWN_JOB_LINE_BY_KIND,
  UNKNOWN_JOB_LINE_RESTORED_UNVERIFIED_MOCK,
  UNKNOWN_STATUS_LABEL_BY_KIND,
} from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { itemStatusText, jobStatusTextFor } from '../../apps/web/lib/record-labels';
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
let fetchCalls = 0;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));

async function linkedThreadsAccount(): Promise<{ id: string; external: string }> {
  const external = `mock:threads:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads FIX2 Q3', state: 'mock_ready' })
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
  const { content } = await createContent(db, owner, { title: `FIX2 Q3 ${randomUUID().slice(0, 6)}`, body });
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
  runJobsTick(db, registry, { workerId: 'fix2-q3', config, ownerId: owner, planId, random: () => 0.5, submitTimeoutMs: 5000, maxJobs: 5, credentials: jobCredentials(config, db) });
const jobOf = async (hdb: Db, itemId: string) => (await hdb.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt)))[0]!;
const lastEventOf = async (hdb: Db, jobId: string) => (await hdb.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(desc(schema.jobEvents.eventSeq)))[0]!;

/** 원본 작업 4개(모두 복원 때 BLOCKED + restored_needs_review 가 되는 대기 상태) */
interface Sources {
  /** S1 보낸 적 없음(실행만 — QUEUED, 전송 의도 0) */
  never: string;
  /** S2 일반 모의 어댑터 503(부작용 없음) → RETRY_WAIT — 의도 1(확정 거절), 단계 기록을 쓰지 않는 어댑터 */
  generic: string;
  /** S3 Threads 모의 3개 스레드, 1번째 게시 뒤 2번째 429 → RETRY_WAIT — 의도 1(확정 거절) · 단계: 컨테이너·게시 1 */
  partial: string;
  /** S4 Threads 모의 단일 게시물, 컨테이너 뒤 게시 429 → RETRY_WAIT — 의도 1(확정 거절) · 단계: 컨테이너만(게시 없음) */
  containerOnly: string;
}
let src: Sources;
/**
 * FIX2-FULLREV(FX1): S5 Threads 모의 단일 게시물, 첫 컨테이너 생성에서 401(threads_token_invalid) → BLOCKED(auth) — 의도 1(확정 거절) · 단계 0.
 * 항목 BLOCKED 는 진행 중 상태가 아니라(restoredItemStatus → null) 복원 때 **항목** 표시가 켜지지 않고 **작업** 표시(restored_needs_review)만 켜진다 —
 * 취소 판정은 작업 쪽 표시(job.restoredNeedsReview)로만 복원 규칙에 들어간다. 위 네 원본(항목·작업 모두 표시)과 따로 둔다.
 */
let blockedSrc: string;
let parsed: Awaited<ReturnType<typeof parseBundleZip>>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix2-q3-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FIX2 Q3 시험: 네트워크 호출 금지');
  });
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
  registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT };

  // S2: seed 모의 Threads 계정(연결한 적 없음 → 일반 모의 어댑터)
  const seedThreads = (await listChannelAccounts(db, owner)).find((a) => a.platform === 'threads' && a.kind === 'mock' && a.credentialState === 'none')!;
  const generic = await executed(seedThreads.id, '일반 모의 어댑터로 보낸 글.', 'transient');
  await tickPlan(generic.planId);
  // S3
  const a3 = await linkedThreadsAccount();
  const partial = await executed(a3.id, ['첫째 — 재고 기준.', '둘째 — 가격표.', '셋째 — 숫자 맞추기.'].join('\n\n'));
  api.setRateBudget(a3.external, 1, 60);
  await tickPlan(partial.planId);
  api.clearRateBudget(a3.external);
  // S4
  const a4 = await linkedThreadsAccount();
  const containerOnly = await executed(a4.id, '컨테이너만 만든 글.');
  api.setRateBudget(a4.external, 0, 60);
  await tickPlan(containerOnly.planId);
  api.clearRateBudget(a4.external);
  // S1: 실행만(작업 처리기를 돌리지 않음)
  const a1 = await linkedThreadsAccount();
  const never = await executed(a1.id, '보낸 적 없는 글.');
  src = { never: never.itemId, generic: generic.itemId, partial: partial.itemId, containerOnly: containerOnly.itemId };
  // S5(FIX2-FULLREV FX1): 첫 컨테이너 401 → BLOCKED(항목도 BLOCKED)
  const a5 = await linkedThreadsAccount();
  const blocked = await executed(a5.id, '첫 컨테이너에서 401 이 난 글.', 'threads_token_invalid');
  await tickPlan(blocked.planId);
  blockedSrc = blocked.itemId;

  // 원본 상태 확인
  const g = await jobOf(db, src.generic);
  expect(g).toMatchObject({ state: 'RETRY_WAIT', attempt: 1 });
  const p = await jobOf(db, src.partial);
  expect(p).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited', attempt: 1 });
  expect(api.postsOf(a3.external)).toHaveLength(1);
  const c = await jobOf(db, src.containerOnly);
  expect(c).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited', attempt: 1 });
  expect(api.postsOf(a4.external)).toHaveLength(0);
  const n = await jobOf(db, src.never);
  expect(n).toMatchObject({ state: 'QUEUED', attempt: 0 });
  for (const id of [g.id, p.id, c.id]) {
    const intents = await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, id));
    expect(intents.map((i) => i.outcome)).toEqual(['rejected']);
  }
  expect(await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, n.id))).toHaveLength(0);
  const b = await jobOf(db, blockedSrc);
  expect(b).toMatchObject({ state: 'BLOCKED', lastRetryClass: 'auth', attempt: 1 });
  expect((await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, blockedSrc)))[0]!.status).toBe('BLOCKED');
  expect((await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, b.id))).map((i) => i.outcome)).toEqual(['rejected']);
  expect(await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.jobId, b.id))).toHaveLength(0);
  expect(api.containerIds(a5.external)).toHaveLength(0);
  expect(await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.jobId, g.id))).toHaveLength(0);
  const partialKinds = (await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, src.partial))).map((s) => s.kind);
  expect(partialKinds.filter((k) => k === 'publish')).toHaveLength(1);
  expect(partialKinds).toContain('container');
  expect((await db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, src.containerOnly))).map((s) => s.kind)).toEqual(['container']);

  const ex = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), owner, { outDir: path.join(tmp, 'exports') });
  parsed = await parseBundleZip(new Uint8Array(readFileSync(ex.zipPath)));
}, 240_000);
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

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
async function restoreInto(zip: Uint8Array) {
  const h = await createTestDb();
  const target = (await ensureOwner(h.db, `restore-fix2-${randomUUID().slice(0, 6)}@example.local`)).id;
  const restoresDir = path.join(tmp, 'restores');
  const pv = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
  await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, `assets-r-${randomUUID().slice(0, 6)}`)), target, pv.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
  return { h, target };
}

/** 복원된 네 항목이 모두 BLOCKED + 복원 표시인지(취소 전) */
async function expectRestoredBlocked(hdb: Db) {
  for (const itemId of Object.values(src)) {
    const it = (await hdb.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;
    expect(it, itemId).toMatchObject({ status: 'BLOCKED', restoredNeedsReview: true });
    expect(await jobOf(hdb, itemId), itemId).toMatchObject({ state: 'BLOCKED', restoredNeedsReview: true, cancelRequestedAt: null });
  }
}
/** FIX2-FULLREV(FX1): S5 — 항목은 BLOCKED 그대로·표시 없음, 작업만 BLOCKED + 복원 표시(취소 전) */
async function expectJobOnlyRestored(hdb: Db) {
  const it = (await hdb.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, blockedSrc)))[0]!;
  expect(it).toMatchObject({ status: 'BLOCKED', restoredNeedsReview: false });
  expect(await jobOf(hdb, blockedSrc)).toMatchObject({ state: 'BLOCKED', restoredNeedsReview: true, cancelRequestedAt: null });
}
async function expectCanceledNotSent(hdb: Db, target: string, itemId: string) {
  expect(await cancelItem(hdb, target, itemId)).toMatchObject({ canceled: true, state: 'CANCELED' });
  const job = await jobOf(hdb, itemId);
  expect(job.state).toBe('CANCELED');
  expect(job.cancelRequestedAt).not.toBeNull();
  const ev = await lastEventOf(hdb, job.id);
  expect(ev).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'CANCELED' });
  expect(ev.sanitizedDetails).toMatchObject({ transition: 'canceled', cause: 'user', not_sent: true });
  expect((await hdb.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!.status).toBe('CANCELED');
}
/** 증명하지 못한 복원 작업 취소: UNKNOWN(restored_cancel_unverified) — 응답·사건·항목·화면 문구, 다시 보내지 않음 */
async function expectUnverified(hdb: Db, target: string, itemId: string, counts: { intents: number; steps: number }) {
  const out = await cancelItem(hdb, target, itemId);
  expect(out).toMatchObject({ canceled: false, cancel_requested: false, state: 'UNKNOWN', published_parts: 0, reason: 'restored_cancel_unverified' });
  // FIX2-FULLREV(FX4): 모의 계정 항목 — 확인할 수 없는 "채널에서 직접 확인"을 시키지 않고, MOCK 이며 실제 채널로 보낸 것이 없다고 말한다
  expect(out.message).toBe(
    'MOCK — 더 보내지 않습니다. 복원한 모의 작업이라 모의 전송 여부를 복원된 기록으로 확인할 수 없어 취소를 확정하지 않았습니다(결과 불명 — 자동 재전송 안 함). 실제 채널로 보낸 것은 없습니다.',
  );
  expect(out.message).not.toContain('채널에서 직접 확인');
  expect(out.message).not.toContain('취소했습니다');
  const job = await jobOf(hdb, itemId);
  expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'restored_cancel_unverified', restoredNeedsReview: true, leaseOwner: null });
  // 사용자가 취소를 요청했다 — 취소 요청 시각은 남긴다(뒤에 확인돼 CONFIRMED 가 되면 "취소 불가(이미 전송됨)"가 맞다)
  expect(job.cancelRequestedAt).not.toBeNull();
  const ev = await lastEventOf(hdb, job.id);
  expect(ev).toMatchObject({ stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN' });
  expect(ev.sanitizedDetails).toMatchObject({
    transition: 'cancel_partial',
    cause: 'user',
    reason: 'restored_cancel_unverified',
    restored: true,
    not_sent: false,
    intents: counts.intents,
    unresolved_intents: 0,
    remote_steps: counts.steps,
  });
  expect((await hdb.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!.status).toBe('UNKNOWN');
  // 화면: 상태 태그·작업 줄·머리줄 모두 "새 계획 필요"가 아니라 직접 확인 안내
  const block = blockInfoOf([ev], job);
  const headline = itemHeadline({ status: 'UNKNOWN', channel: 'threads', job, pub: null, blockReason: block.code, blockDetail: block.detail, activeApproval: false });
  // FIX2-FULLREV(FX4): 모의 카드의 머리줄·상태 태그·작업 줄(모의 카드는 jobStatusTextFor(…, live=false)) — MOCK, 채널 확인 지시 없음
  expect(headline).toBe('복원한 모의 작업 — 모의 전송 여부를 기록으로 확인할 수 없어 취소를 확정하지 않음, 자동 재전송 안 함(MOCK — 실제 채널로 보낸 것 없음)');
  expect(liveItemHeadline({ status: 'UNKNOWN', channel: 'threads', job, pub: null, blockReason: block.code })).toContain('Threads 에서 직접 확인하세요');
  const tag = itemStatusText('UNKNOWN', { live: false, lastErrorCode: job.lastErrorCode });
  expect(tag).toBe(UNKNOWN_STATUS_LABEL_BY_KIND.restored_unverified.mock);
  // 기록이 실제인지 모를 때의 공통 줄(조심스러운 기본값)은 그대로, 모의 카드의 줄은 모의 문구
  expect(jobStatusText(job, null, block.code, 'threads')).toBe(UNKNOWN_JOB_LINE_BY_KIND.restored_unverified);
  const line = jobStatusTextFor(job, null, block.code, 'threads', false);
  expect(line).toBe(UNKNOWN_JOB_LINE_RESTORED_UNVERIFIED_MOCK);
  for (const t of [headline, tag, line]) {
    expect(t).toContain('MOCK');
    expect(t).not.toContain('채널에서 직접 확인');
  }
  for (const t of [headline, itemStatusText('UNKNOWN', { live: true, lastErrorCode: job.lastErrorCode }), jobStatusText(job)]) expect(t).not.toContain('새 계획');
  // 다시 취소해도 확정하지 않는다(UNKNOWN 은 취소 대상 아님 — 409 cancel_unknown)
  await expect(cancelItem(hdb, target, itemId)).rejects.toMatchObject({ code: 'cancel_unknown' });
}

describe('FIX2-FULLREV(Q3): 복원한 작업의 취소 — 기록이 "보내지 않음"을 증명할 때만 CANCELED(not_sent)', () => {
  it('현재 묶음(단계 기록 포함): 보낸 적 없음·일반 모의 확정 거절·컨테이너만 있는 Threads 확정 거절 → CANCELED(not_sent, 지금과 같음) · 부분 게시(게시 1) → UNKNOWN(thread_partial_canceled — 부분 게시 규칙) · 작업 표시만 있는 첫 컨테이너 401 BLOCKED(단계 0) → UNKNOWN(restored_cancel_unverified)', async () => {
    const { h, target } = await restoreInto(bundleOf(structuredClone(parsed.tables) as BundleTables));
    try {
      await expectRestoredBlocked(h.db);
      await expectJobOnlyRestored(h.db);
      await expectCanceledNotSent(h.db, target, src.never);
      await expectCanceledNotSent(h.db, target, src.generic);
      await expectCanceledNotSent(h.db, target, src.containerOnly);
      // FIX2-FULLREV(FX1): 작업 표시만 있는 복원 작업(S5 — 항목 표시 없음)도 복원 규칙을 탄다: 단계 기록에 기대는 어댑터(mock_threads)의 의도인데 단계 0 —
      // "보내지 않음"을 증명하지 못해 UNKNOWN(restored_cancel_unverified). 작업 쪽 표시를 보지 않으면 CANCELED(not_sent)가 된다.
      await expectUnverified(h.db, target, blockedSrc, { intents: 1, steps: 0 });
      // 복원된 부분 게시 작업: 단계 기록(게시 1)이 함께 왔다 — 부분 게시 규칙이 먼저 UNKNOWN 으로 둔다
      expect(await cancelItem(h.db, target, src.partial)).toMatchObject({ canceled: false, state: 'UNKNOWN', published_parts: 1, reason: 'thread_partial_canceled' });
      const pj = await jobOf(h.db, src.partial);
      expect(pj).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_canceled', restoredNeedsReview: true });
      expect((await lastEventOf(h.db, pj.id)).sanitizedDetails).toMatchObject({ transition: 'cancel_partial', cause: 'user', not_sent: false, published_parts: 1, publish_attempts: 0 });
      // 복원 환경의 작업 처리기는 아무것도 lease 하지 않는다(다시 보내지 않음)
      const submits = registry.threads.calls.submit;
      expect((await runJobsTick(h.db, registry, { workerId: 'restored-w', config, ownerId: target, submitTimeoutMs: 500 })).leased).toBe(0);
      expect(registry.threads.calls.submit).toBe(submits);
    } finally {
      await h.close();
    }
  }, 240_000);

  it('이전 묶음(단계 기록 없음 — 0031 이전): 보낸 적 없음·일반 모의 확정 거절은 그대로 CANCELED(not_sent) · 의도가 있는 Threads 작업(부분 게시·컨테이너만)은 "보내지 않음"을 증명할 수 없어 UNKNOWN(restored_cancel_unverified) · 작업 표시만 있는 401 BLOCKED 도 같음', async () => {
    const old = structuredClone(parsed.tables) as BundleTables;
    old.remote_steps = [];
    const { h, target } = await restoreInto(bundleOf(old));
    try {
      await expectRestoredBlocked(h.db);
      await expectJobOnlyRestored(h.db);
      for (const itemId of [src.partial, src.containerOnly]) {
        expect(await h.db.select().from(schema.remoteSteps).where(eq(schema.remoteSteps.itemId, itemId))).toHaveLength(0);
      }
      await expectCanceledNotSent(h.db, target, src.never);
      await expectCanceledNotSent(h.db, target, src.generic);
      // 실제로는 1번째 게시물이 원격에 있다 — 단계 기록이 없다고 "보내지 않음"이라고 하면 틀린다
      await expectUnverified(h.db, target, src.partial, { intents: 1, steps: 0 });
      await expectUnverified(h.db, target, src.containerOnly, { intents: 1, steps: 0 });
      // FIX2-FULLREV(FX1): 작업 표시만 있는 S5 도 같은 판정
      await expectUnverified(h.db, target, blockedSrc, { intents: 1, steps: 0 });
      const submits = registry.threads.calls.submit;
      expect((await runJobsTick(h.db, registry, { workerId: 'restored-w', config, ownerId: target, submitTimeoutMs: 500 })).leased).toBe(0);
      expect(registry.threads.calls.submit).toBe(submits);
    } finally {
      await h.close();
    }
  }, 240_000);
});
