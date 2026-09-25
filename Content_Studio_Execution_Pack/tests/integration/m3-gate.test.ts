/**
 * T12(결정 D19) M3 게이트 — `pnpm drill:mock` 과 같은 행렬을 프로그램으로 확인하고, A09(PARTIAL) 를 API 경로(모의 시나리오 PUT·재시도 POST·
 * worker tick·재확인)로 끝까지 돌린다. 모의 어댑터만 — 외부 호출 없음. 결과는 모두 MOCK(실제 발행 실적 아님).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  createContent,
  createPlan,
  createVariantDraft,
  executePlan,
  getDb,
  insertAsset,
  listChannelAccounts,
  runJobsTick,
  schema,
  seed,
  setVariantAssets,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildAssetKey, loadConfig, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter } from '@cs/providers';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { PUT as scenarioPUT, POST as scenarioPOST } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as reconcilePOST } from '../../apps/web/app/api/distribution-items/[id]/reconcile/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { POST as tickPOST } from '../../apps/web/app/api/worker/tick/route';
import { DRILL_HEADER, drillTableRows, formatDrillTable, runDrill } from '../../packages/db/scripts/drill-matrix';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const config = loadConfig({});
const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';

let db: Db;
let tmp: string;
const registry = createMockAdapterRegistry();
const adapter = registry.mock;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);

interface Owner {
  id: string;
  identity: string;
  token: string;
  accounts: Record<Channel, string>;
  image: string;
  video: string;
}

async function putAsset(ownerId: string, mime: string) {
  const id = randomUUID();
  const bytes = new TextEncoder().encode(`${mime}:${id}`);
  const key = buildAssetKey(ownerId, id);
  await new LocalStorageAdapter(path.join(tmp, 'assets')).put(key, bytes);
  await insertAsset(db, { id, ownerId, key, mime, bytes: bytes.byteLength, checksum: createHash('sha256').update(bytes).digest('hex'), rightsStatus: 'owned', verificationState: 'VERIFIED' });
  return id;
}

async function newOwner(): Promise<Owner> {
  const identity = `m3gate-${randomUUID().slice(0, 8)}@example.local`;
  const { ownerId } = await seed(db, { allowedIdentity: identity });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  as(identity);
  const token = await login(identity);
  return { id: ownerId, identity, token, accounts, image: await putAsset(ownerId, 'image/png'), video: await putAsset(ownerId, 'video/mp4') };
}

async function reviewVariant(o: Owner, channel: Channel) {
  const { content } = await createContent(db, o.id, { title: `게이트 ${channel}`, body: BODY });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel, baseVersion: 1 });
  let base = 1;
  if (channel === 'instagram' || channel === 'youtube') {
    await setVariantAssets(db, o.id, variant.id, {
      baseVersion: 1,
      assets: [channel === 'instagram' ? { assetId: o.image, position: 1, role: 'image' } : { assetId: o.video, position: 1, role: 'video' }],
    });
    base = 2;
  }
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: base });
  return variant.id;
}

const itemRow = async (id: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const planRow = async (id: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, id)))[0]!;
const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
async function intentsOfItem(itemId: string) {
  const ids = (await jobsOf(itemId)).map((j) => j.id);
  return ids.length ? db.select().from(schema.sendIntents).where(inArray(schema.sendIntents.jobId, ids)) : [];
}
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));

function tick(o: Owner, offsetSec: number) {
  return runJobsTick(db, registry, { workerId: 'gate-w', config, ownerId: o.id, clock: () => new Date(Date.now() + offsetSec * 1000), random: () => 0.5, submitTimeoutMs: 500, maxJobs: 20 });
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t12-gate-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
});
beforeEach(() => adapter.reset());
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('M3 게이트 훈련(drill) — pnpm drill:mock 과 같은 표', () => {
  it('모든 시나리오·PARTIAL·더블 실행·worker 2개·lease 만료·재시작·A10: 불변식 위반 0, fetch 0, 표가 기대와 같다', async () => {
    const r = await runDrill();
    expect(r.violations).toEqual([]);
    expect(r.fetch_calls).toBe(0);
    expect(r.rows.every((x) => x.ok)).toBe(true);
    const table = Object.fromEntries(drillTableRows(r).map((cols) => [cols[0], cols.slice(1, 5)]));
    const PRIV = 'MOCK UPLOADED_PRIVATE/private';
    expect(table).toEqual({
      success: ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'success · YouTube(A12 비공개 업로드)': ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'success_public · 공개 승인': ['CONFIRMED', 'CONFIRMED', '1', 'MOCK PUBLISHED/public'],
      'success_public · 비공개 승인(공개 전환 거부)': ['FAILED', 'FAILED', '1', '없음'],
      processing_then_confirm: ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'transient(503 반복)': ['FAILED', 'FAILED', '5', '없음'],
      transient_then_success: ['CONFIRMED', 'CONFIRMED', '2', PRIV],
      'rate_limited(429·Retry-After)': ['FAILED', 'FAILED', '5', '없음'],
      server_error_no_side_effect: ['FAILED', 'FAILED', '5', '없음'],
      server_error_side_effect_unknown: ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'permanent(400)': ['FAILED', 'FAILED', '1', '없음'],
      'auth(401)': ['BLOCKED', 'BLOCKED', '1', '없음'],
      ambiguous_sent: ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      ambiguous_not_sent: ['FAILED', 'FAILED', '5', '없음'],
      'hang(시간 초과)': ['FAILED', 'FAILED', '5', '없음'],
      'cancel_supported + 사용자 취소': ['CANCELED', 'CANCELED', '1', '없음'],
      reconcile_unsupported: ['UNKNOWN', 'UNKNOWN', '1', '없음'],
      'PARTIAL · threads success': ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'PARTIAL · instagram 401 → 재시도': ['CONFIRMED', 'CONFIRMED', '2', PRIV],
      'PARTIAL · youtube 처리 중 → 확인': ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'PARTIAL · blog 일시 오류 → 성공': ['CONFIRMED', 'CONFIRMED', '2', PRIV],
      '더블 실행(같은 key·다른 key)': ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'worker 2개 동시': ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'lease 만료(의도 뒤) → 조회': ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      '재시작 → UNKNOWN → 재확인': ['CONFIRMED', 'CONFIRMED', '1', PRIV],
      'A10 철회 → 재승인·재실행': ['CONFIRMED', 'CONFIRMED', '2', PRIV],
    });
    // 결과 불명·일시 오류 뒤 재전송은 "보내지 않음 확인 뒤"에만
    for (const row of r.rows) expect(row.resend).not.toContain('위반');
    expect(r.plans).toEqual([{ name: 'PARTIAL 계획(threads·instagram·youtube·blog)', statuses: ['partial', 'completed'] }]);
    const text = formatDrillTable(r);
    expect(text.split('\n')[0]).toBe(`| ${DRILL_HEADER.join(' | ')} |`);
    expect(text).not.toMatch(/게시 완료|공개 게시 성공/);
  }, 120_000);
});

describe('A09 — 채널 여러 개 중 일부 성공(API 경로)', () => {
  it('threads success · instagram 401 · youtube 처리 중 → 확인 · blog 일시 오류 → 성공: 계획 partial, 성공 항목은 다시 보내지 않음, instagram 재시도 → completed', async () => {
    const o = await newOwner();
    const channels: Channel[] = ['threads', 'instagram', 'youtube', 'blog'];
    const input: Array<{ variant_id: string; channel_account_id: string }> = [];
    for (const ch of channels) input.push({ variant_id: await reviewVariant(o, ch), channel_account_id: o.accounts[ch] });
    const { plan, items } = await createPlan(db, o.id, { items: input });
    const byCh = Object.fromEntries(channels.map((ch, k) => [ch, items.find((i) => i.variantId === input[k]!.variant_id)!])) as Record<Channel, (typeof items)[number]>;
    const scenarios: Record<Channel, string> = { threads: 'success', instagram: 'auth', youtube: 'processing_then_confirm', blog: 'transient_then_success' };
    as(o.identity);
    for (const ch of channels) {
      const res = await scenarioPUT(jsonPost(`/api/distribution-items/${byCh[ch].id}/mock-scenario`, { scenario: scenarios[ch] }, { ...cookieHeader(o.token) }), ctx(byCh[ch].id));
      expect(res.status, ch).toBe(200);
      expect(await res.json()).toMatchObject({ scenario: scenarios[ch], delay_ms: 0, mode: 'MOCK', notice: '개발용 · 모의 결과 선택 (실제 채널 없음)' });
    }
    await approveItems(db, o.id, plan.id, {
      item_ids: items.map((i) => i.id),
      expected_hashes: Object.fromEntries(items.map((i) => [i.id, i.payloadHash])),
      confirm: true,
      purpose: 'mock_publish',
    });
    await executePlan(db, o.id, plan.id, { commandKey: `gate-${randomUUID()}` }, config);

    // tick 1: threads CONFIRMED, instagram BLOCKED(401), youtube REMOTE_PROCESSING, blog RETRY_WAIT
    const t1 = await tick(o, 0);
    expect(t1.results).toEqual({ CONFIRMED: 1, BLOCKED: 1, REMOTE_PROCESSING: 1, RETRY_WAIT: 1 });
    expect((await planRow(plan.id)).status).toBe('executing');
    await tick(o, 20);
    await tick(o, 20 * 60);
    expect((await itemRow(byCh.threads.id)).status).toBe('CONFIRMED');
    expect((await itemRow(byCh.instagram.id)).status).toBe('BLOCKED');
    expect((await itemRow(byCh.youtube.id)).status).toBe('CONFIRMED');
    expect((await itemRow(byCh.blog.id)).status).toBe('CONFIRMED');
    expect((await planRow(plan.id)).status).toBe('partial');
    // A12: YouTube 결과는 비공개 업로드(공개 게시 아님)
    expect((await pubsOf(byCh.youtube.id))[0]).toMatchObject({ resultKind: 'UPLOADED_PRIVATE', remoteVisibility: 'private', isMock: true, verification: 'MOCK' });

    // 더 돌려도·수동 tick API·재확인 시도에도 성공 항목은 다시 보내지 않는다
    const submitsBefore = adapter.calls.submit;
    await tick(o, 3 * 3600);
    const tickRes = await tickPOST(jsonPost('/api/worker/tick', { max_jobs: 5 }, cookieHeader(o.token)));
    expect(tickRes.status).toBe(200);
    for (const it of items) {
      const rc = await reconcilePOST(jsonPost(`/api/distribution-items/${it.id}/reconcile`, {}, cookieHeader(o.token)), ctx(it.id));
      expect(rc.status).toBe(409);
    }
    expect(adapter.calls.submit).toBe(submitsBefore);
    for (const ch of ['threads', 'youtube', 'blog'] as const) {
      const accepted = (await intentsOfItem(byCh[ch].id)).filter((i) => i.outcome === 'accepted');
      expect(accepted, ch).toHaveLength(1);
      expect(await pubsOf(byCh[ch].id), ch).toHaveLength(1);
    }
    expect((await planRow(plan.id)).status).toBe('partial');
    const detail = await (await planGET(new Request(`${BASE}/api/distribution-plans/${plan.id}`, { headers: { accept: 'application/json', ...cookieHeader(o.token) } }), ctx(plan.id))).json();
    expect(detail.plan.status).toBe('partial');
    for (const it of detail.items) for (const p of it.publications) expect(p).toMatchObject({ is_mock: true, verification: 'MOCK', notice: 'MOCK — 실제 발행 실적 아님' });
    expect(detail.items.find((i: { id: string }) => i.id === byCh.instagram.id).mock_scenario).toMatchObject({ scenario: 'auth' });

    // 재시도 전: 시나리오 그대로면 다시 401 → 여전히 BLOCKED(재시도는 명시적 동작, 자동 반복 없음)
    // 계정 다시 연결(모의: 시나리오 success) → 재시도(같은 작업, 새 시도·새 의도)
    const sc = await scenarioPUT(jsonPost(`/api/distribution-items/${byCh.instagram.id}/mock-scenario`, { scenario: 'success' }, cookieHeader(o.token)), ctx(byCh.instagram.id));
    expect(sc.status).toBe(200);
    const rt = await retryPOST(jsonPost(`/api/distribution-items/${byCh.instagram.id}/retry`, {}, cookieHeader(o.token)), ctx(byCh.instagram.id));
    expect(rt.status).toBe(200);
    const rtBody = await rt.json();
    expect(rtBody).toMatchObject({ item_id: byCh.instagram.id, state: 'QUEUED', attempt_next: 2, mode: 'MOCK' });
    expect(rtBody.job_id).toBe((await jobsOf(byCh.instagram.id))[0]!.id);
    expect((await planRow(plan.id)).status).toBe('executing');
    const t2 = await tick(o, 4 * 3600);
    expect(t2.results).toEqual({ CONFIRMED: 1 });
    expect((await itemRow(byCh.instagram.id)).status).toBe('CONFIRMED');
    expect((await planRow(plan.id)).status).toBe('completed');
    // 전송 의도: threads 1 · instagram 2(401 + 재시도) · youtube 1 · blog 2(일시 오류 + 성공) = 6, 원격 결과 4(모두 MOCK)
    const counts = Object.fromEntries(await Promise.all(channels.map(async (ch) => [ch, (await intentsOfItem(byCh[ch].id)).length])));
    expect(counts).toEqual({ threads: 1, instagram: 2, youtube: 1, blog: 2 });
    expect(await jobsOf(byCh.instagram.id)).toHaveLength(1);
    const events = await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, rtBody.job_id)).orderBy(asc(schema.jobEvents.eventSeq));
    expect(events.map((e) => (e.sanitizedDetails as { transition?: string; event?: string }).transition ?? (e.sanitizedDetails as { event?: string }).event)).toEqual([
      'execute',
      'lease',
      'send_start',
      'blocked',
      'unblock',
      'lease',
      'send_start',
      'confirmed',
    ]);
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'item.retry'));
    expect(audit.some((a) => a.entityId === byCh.instagram.id)).toBe(true);
  });

  it('HTML 폼: 모의 시나리오 저장·재시도는 303 으로 계획 화면, /api/health 에 attention_plans', async () => {
    const o = await newOwner();
    const v = await reviewVariant(o, 'threads');
    const { plan, items } = await createPlan(db, o.id, { items: [{ variant_id: v, channel_account_id: o.accounts.threads }] });
    const form = (p: string, fields: Record<string, string>) =>
      new Request(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: BASE, ...cookieHeader(o.token) },
        body: new URLSearchParams(fields).toString(),
      });
    as(o.identity);
    const s = await scenarioPOST(form(`/api/distribution-items/${items[0]!.id}/mock-scenario`, { plan_id: plan.id, scenario: 'auth', delay_ms: '0' }), ctx(items[0]!.id));
    expect(s.status).toBe(303);
    expect(s.headers.get('location')).toBe(`/distribute/${plan.id}?scenario_saved=1`);
    const bad = await scenarioPOST(form(`/api/distribution-items/${items[0]!.id}/mock-scenario`, { plan_id: plan.id, scenario: 'publish_for_real' }), ctx(items[0]!.id));
    expect(bad.headers.get('location')).toBe(`/distribute/${plan.id}?error=invalid`);
    await approveItems(db, o.id, plan.id, { item_ids: [items[0]!.id], expected_hashes: { [items[0]!.id]: items[0]!.payloadHash }, confirm: true, purpose: 'mock_publish' });
    await executePlan(db, o.id, plan.id, { commandKey: `gate-${randomUUID()}` }, config);
    await tick(o, 0);
    expect((await planRow(plan.id)).status).toBe('attention');
    const h = await (await healthGET()).json();
    expect(h.jobs.attention_plans).toBeGreaterThanOrEqual(1);
    await scenarioPOST(form(`/api/distribution-items/${items[0]!.id}/mock-scenario`, { plan_id: plan.id, scenario: 'success' }), ctx(items[0]!.id));
    const r = await retryPOST(form(`/api/distribution-items/${items[0]!.id}/retry`, { plan_id: plan.id }), ctx(items[0]!.id));
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe(`/distribute/${plan.id}?retried=1`);
    const again = await retryPOST(form(`/api/distribution-items/${items[0]!.id}/retry`, { plan_id: plan.id }), ctx(items[0]!.id));
    expect(again.headers.get('location')).toBe(`/distribute/${plan.id}?error=not_retryable`);
  });
});
