/**
 * FIX-T11·T12(Codex review-T11·T12) — 지적 사항 재현·회귀 시험:
 * T11 P0 진행 중 전송을 not_found 로 확정 → 중복 전송 / T11 P1 일괄 lease 로 뒤 작업 시도 소진 / T11 P1 복원된 CONFIRMED 의 근거·재확인 경로 /
 * T11 P2 승인 철회 안내 ↔ 저장된 작업 상태. (T12 P0 보류 항목 편집 → 승인 철회는 m3-hardening B, T12 P1 은 migration-0020, T12 P2 는 lib 단위 시험.)
 * PGlite 는 연결 하나지만 JS 비동기 흐름은 교차한다 — worker A 의 submit 지연 중에 worker B 의 tick 을 실제로 끼워 넣는다.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  commitRestore,
  createContent,
  createPlan,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  executePlan,
  exportOwner,
  getDb,
  leaseJobs,
  listChannelAccounts,
  parseBundleZip,
  processJob,
  reconcileItem,
  runJobsTick,
  schema,
  seed,
  setMockScenario,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { buildBundle, loadConfig, writeZip, type BundleTables, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter } from '@cs/providers';
import { POST as revokePOST } from '../../apps/web/app/api/approvals/[id]/revoke/route';
import { revocationNotice } from '../../apps/web/lib/distribution';
import { BASE, cookieHeader, login, ORIGIN_HEADERS } from './helpers';

const config = loadConfig({});
const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';

let db: Db;
let tmp: string;
const registry = createMockAdapterRegistry();
const adapter = registry.mock;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Owner {
  id: string;
  identity: string;
  token: string;
  accounts: Record<Channel, string>;
}

async function newOwner(): Promise<Owner> {
  const identity = `fixt11-${randomUUID().slice(0, 8)}@example.local`;
  const { ownerId } = await seed(db, { allowedIdentity: identity });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  as(identity);
  return { id: ownerId, identity, token: await login(identity), accounts };
}

async function executed(o: Owner, channel: Channel = 'threads') {
  const { content } = await createContent(db, o.id, { title: `FIX-T11 ${channel}`, body: BODY });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel, baseVersion: 1 });
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const { plan, items } = await createPlan(db, o.id, { items: [{ variant_id: variant.id, channel_account_id: o.accounts[channel] }] });
  const it0 = items[0]!;
  const a = await approveItems(db, o.id, plan.id, { item_ids: [it0.id], expected_hashes: { [it0.id]: it0.payloadHash }, confirm: true, purpose: 'mock_publish' });
  const ex = await executePlan(db, o.id, plan.id, { commandKey: `fixt11-${randomUUID()}` }, config);
  return { planId: plan.id, itemId: it0.id, approvalId: a.approvals[0]!.id, jobId: ex.queued[0]!.job_id };
}

function tick(o: Owner, offsetSec = 0, extra: { workerId?: string; leaseTtlMs?: number; submitTimeoutMs?: number } = {}) {
  return runJobsTick(db, registry, {
    workerId: extra.workerId ?? 'fixt11-w',
    config,
    ownerId: o.id,
    clock: () => new Date(Date.now() + offsetSec * 1000),
    random: () => 0.5,
    submitTimeoutMs: extra.submitTimeoutMs ?? 500,
    leaseTtlMs: extra.leaseTtlMs,
    maxJobs: 10,
  });
}

const jobRow = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const eventNames = async (jobId: string) =>
  (await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq))).map(
    (e) => (e.sanitizedDetails as { transition?: string }).transition,
  );

function formPost(p: string, fields: Record<string, string>, token: string): Request {
  return new Request(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(token) },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix-t11-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
});
beforeEach(() => adapter.reset());
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('T11 P0 — 진행 중 전송은 not_found 가 아니다, lease 를 잃은 전송은 부작용을 만들지 않는다', () => {
  it('A 의 submit 이 lease 보다 오래 걸리는 동안 B 가 만료 복구·조회 → 확인 불가(RECONCILING, 새 의도 없음), A 는 lease 상실로 원격에 쓰지 않음 → 원격 결과는 끝까지 1개', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await setMockScenario(db, o.id, x.itemId, { scenario: 'success', delay_ms: 400 });
    // worker A: lease 100ms, submit 지연 400ms(heartbeat 는 부작용 직전에만)
    const a = tick(o, 0, { workerId: 'worker-a', leaseTtlMs: 100, submitTimeoutMs: 5000 });
    await wait(250);
    expect((await jobRow(x.jobId)).state).toBe('SENDING');
    // worker B: A 의 lease 만료를 복구하고 원격 조회 — A 의 submit 은 아직 진행 중
    const b = await tick(o, 0, { workerId: 'worker-b' });
    expect(b.recovered).toBe(1);
    const mid = await jobRow(x.jobId);
    expect(mid.state).toBe('RECONCILING'); // 수정 전: not_found → RETRY_WAIT(새 의도 대기)
    expect(await intentsOf(x.jobId)).toHaveLength(1);
    await a;
    // A 는 heartbeat 에서 lease 상실을 알고 원격에 쓰지 않았다
    expect(adapter.remoteEntries()).toHaveLength(0);
    expect((await intentsOf(x.jobId)).map((i) => [i.attempt, i.outcome])).toEqual([[1, 'ambiguous']]);
    // 끝까지: A 가 끝난 뒤의 조회는 "확실히 없음" → 새 시도(새 의도) 1회 → 확인. 원격 결과는 1개뿐(중복 없음)
    for (const off of [11, 60, 120, 240, 480]) {
      if ((await jobRow(x.jobId)).state === 'CONFIRMED') break;
      await tick(o, off, { workerId: 'worker-b' });
    }
    expect((await jobRow(x.jobId)).state).toBe('CONFIRMED');
    expect(adapter.remoteEntries()).toHaveLength(1);
    expect(await pubsOf(x.itemId)).toHaveLength(1);
    expect((await intentsOf(x.jobId)).map((i) => i.outcome)).toEqual(['ambiguous', 'accepted']);
  });

  it('lease 를 잃은 옛 시도의 결과가 늦게 왔는데 작업이 이미 새 시도(RETRY_WAIT)를 기다리면 late_result → RECONCILING → 조회로 확인(새 의도 없음)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    // 원격 쓰기 뒤 응답 직전에, 다른 경로가 "보내지 않음"으로 판단해 작업을 RETRY_WAIT 로 옮긴 상황을 흉내(예: 확정적 not_found 를 주는 live 어댑터)
    adapter.onSubmit = async (c) => {
      adapter.onSubmit = null;
      await db.update(schema.jobs).set({ state: 'RETRY_WAIT', leaseOwner: null, leaseUntil: null }).where(eq(schema.jobs.id, c.jobId));
    };
    const r = await tick(o);
    expect(r.results).toEqual({ lease_lost: 1 });
    expect((await jobRow(x.jobId)).state).toBe('RECONCILING');
    expect(await eventNames(x.jobId)).toContain('late_result');
    await tick(o, 11);
    expect((await jobRow(x.jobId)).state).toBe('CONFIRMED');
    expect(await intentsOf(x.jobId)).toHaveLength(1);
    expect(adapter.remoteEntries()).toHaveLength(1);
    expect(adapter.calls.submit).toBe(1);
  });
});

describe('T11 P1 — 처리할 작업만 lease, 시작 전 만료는 시도가 아님', () => {
  it('느린 첫 작업을 처리하는 동안 뒤 작업은 lease 되지 않고(QUEUED), 모두 시도 1·의도 1로 확인된다', async () => {
    const o = await newOwner();
    const xs = [await executed(o), await executed(o), await executed(o)];
    for (const x of xs) await setMockScenario(db, o.id, x.itemId, { scenario: 'success', delay_ms: 150 });
    const leasedDuringFirst: number[] = [];
    adapter.onSubmit = async () => {
      leasedDuringFirst.push((await db.select().from(schema.jobs).where(and(eq(schema.jobs.ownerId, o.id), eq(schema.jobs.state, 'LEASED')))).length);
    };
    const r = await tick(o, 0, { leaseTtlMs: 100 });
    expect(r.results).toEqual({ CONFIRMED: 3 });
    expect(leasedDuringFirst).toEqual([0, 0, 0]); // 수정 전: 첫 전송 중에 나머지 2개가 LEASED(만료된 lease)
    for (const x of xs) {
      expect((await jobRow(x.jobId)).attempt).toBe(1);
      expect(await eventNames(x.jobId)).not.toContain('lease_expired_before_intent');
      expect((await intentsOf(x.jobId)).map((i) => i.attempt)).toEqual([1]);
    }
  });

  it('lease 가 시작 전에 만료되면 beginSend 는 아무것도 쓰지 않고(lease_lost), 복구는 attempt 를 되돌린다', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const [leased] = await leaseJobs(db, { workerId: 'slow-w', now: new Date(), limit: 1, leaseTtlMs: 50, ownerId: o.id });
    expect(leased!.attempt).toBe(1);
    await wait(80);
    const p = await processJob(db, registry, leased!, { workerId: 'slow-w', config, submitTimeoutMs: 500 });
    expect(p.state).toBe('lease_lost');
    expect(await intentsOf(x.jobId)).toHaveLength(0);
    expect(adapter.calls.submit).toBe(0);
    await tick(o);
    const j = await jobRow(x.jobId);
    expect(j.state).toBe('CONFIRMED');
    expect(j.attempt).toBe(1);
    expect((await intentsOf(x.jobId)).map((i) => i.attempt)).toEqual([1]);
  });
});

describe('T11 P1 — 복원된 CONFIRMED 의 근거·재확인 경로', () => {
  it('원격 결과가 묶음에 없으면 CONFIRMED 로 두지 않고 UNKNOWN(+표시), 복원된 전송 의도로 재확인(조회만) → CONFIRMED + MOCK 결과', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await tick(o);
    expect((await jobRow(x.jobId)).state).toBe('CONFIRMED');
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), o.id, { outDir: path.join(tmp, 'exports') });
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const tables = structuredClone(parsed.tables) as BundleTables;
    tables.publications = tables.publications.filter((p) => p.item_id !== x.itemId);
    const zip = writeZip(
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
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, `restore-fixt11-${randomUUID().slice(0, 6)}@example.local`)).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.unverified_confirmed_items).toEqual([x.itemId]);
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-r')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.unverified_confirmed_items).toEqual([x.itemId]);
      const [item] = await h.db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, x.itemId));
      expect(item).toMatchObject({ status: 'UNKNOWN', restoredNeedsReview: true });
      const [job] = await h.db.select().from(schema.jobs).where(eq(schema.jobs.id, x.jobId));
      expect(job).toMatchObject({ state: 'UNKNOWN', restoredNeedsReview: true, leaseOwner: null });
      // worker 는 복원 작업을 lease 하지 않는다
      const t = await runJobsTick(h.db, registry, { workerId: 'restored-w', config, ownerId: target, submitTimeoutMs: 500 });
      expect(t.leased).toBe(0);
      // 재확인(조회만) — 복원된 전송 의도 key 로 원격(같은 모의 원격)에서 찾는다 → CONFIRMED + MOCK 결과, 전송 0
      const before = adapter.calls.submit;
      const rc = await reconcileItem(h.db, registry, target, x.itemId);
      expect(rc).toMatchObject({ state_before: 'UNKNOWN', state: 'CONFIRMED', found: true });
      expect(adapter.calls.submit).toBe(before);
      const pubs = await h.db.select().from(schema.publications).where(eq(schema.publications.itemId, x.itemId));
      expect(pubs).toHaveLength(1);
      expect(pubs[0]).toMatchObject({ isMock: true, verification: 'MOCK' });
    } finally {
      await h.close();
    }
  });
});

describe('T11 P2 — 승인 철회 안내는 저장된 작업 상태를 따른다', () => {
  it('SENDING 중 철회 → "취소 확인 중"(보류라고 하지 않음), QUEUED 철회 → 보류·다음 전송 차단', async () => {
    const o = await newOwner();
    // SENDING: 전송 도중(원격 응답 직전) 철회
    const s = await executed(o);
    let sendingRes: Response | null = null;
    adapter.onSubmit = async () => {
      adapter.onSubmit = null;
      expect((await jobRow(s.jobId)).state).toBe('SENDING');
      sendingRes = await revokePOST(formPost(`/api/approvals/${s.approvalId}/revoke`, { plan_id: s.planId }, o.token), ctx(s.approvalId));
    };
    await tick(o);
    const sr = sendingRes as unknown as Response;
    expect(sr.status).toBe(303);
    const loc = new URL(sr.headers.get('location')!, BASE);
    expect(loc.searchParams.get('revoked_blocked')).toBe('0');
    expect(loc.searchParams.get('revoked_cancel')).toBe('1');
    const sText = revocationNotice(Number(loc.searchParams.get('revoked_blocked')), Number(loc.searchParams.get('revoked_cancel')));
    expect(sText).toContain('취소 확인 중');
    expect(sText).not.toContain('보류(BLOCKED)');
    // 원격이 이미 받았으므로 취소 불가(cancel_too_late) → CONFIRMED — 취소 성공이라고 하지 않는다
    expect((await jobRow(s.jobId)).state).toBe('CONFIRMED');
    // QUEUED: 대기 중 철회 → BLOCKED
    const q = await executed(o);
    const qr = await revokePOST(formPost(`/api/approvals/${q.approvalId}/revoke`, { plan_id: q.planId }, o.token), ctx(q.approvalId));
    const qloc = new URL(qr.headers.get('location')!, BASE);
    expect([qloc.searchParams.get('revoked_blocked'), qloc.searchParams.get('revoked_cancel')]).toEqual(['1', '0']);
    expect((await jobRow(q.jobId)).state).toBe('BLOCKED');
    expect(revocationNotice(1, 0)).toContain('보류(BLOCKED) — 다음 전송이 차단');
  });
});

