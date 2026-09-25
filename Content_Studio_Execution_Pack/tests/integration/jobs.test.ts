/**
 * T11(결정 D18): 작업 처리기 — lease·전송 의도(outbox)·재시도·원격 재확인·취소·lease 만료 복구·재시작 보존.
 * 모의 어댑터(프로세스 싱글턴 레지스트리의 MockChannelAdapter)만 쓴다 — 외부 호출 없음. 시계는 runJobsTick 의 clock 으로 앞당긴다.
 * 테스트마다 새 owner 를 만들고 tick 을 그 owner 로 제한해 서로 섞이지 않게 한다.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  createContent,
  createPlan,
  createVariantDraft,
  executePlan,
  getDb,
  leaseJobs,
  listChannelAccounts,
  openDb,
  processJob,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, type Channel } from '@cs/domain';
import { createMockAdapterRegistry, MockChannelAdapter, MockChannelAdapterRegistry, toStorablePublication, type MockScenario } from '@cs/providers';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { POST as reconcilePOST } from '../../apps/web/app/api/distribution-items/[id]/reconcile/route';
import { GET as jobGET } from '../../apps/web/app/api/jobs/[id]/route';
import { GET as planGET } from '../../apps/web/app/api/distribution-plans/[id]/route';
import { POST as tickPOST } from '../../apps/web/app/api/worker/tick/route';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const config = loadConfig({});
const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';
const SECRET_LINE = '대리점과 재고 기준을 먼저 합의했다';

let db: Db;
const registry = createMockAdapterRegistry();
const adapter = registry.mock;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);

interface Owner {
  id: string;
  identity: string;
  accounts: Record<Channel, string>;
}

async function newOwner(): Promise<Owner> {
  const identity = `jobs-${randomUUID().slice(0, 8)}@example.local`;
  const { ownerId } = await seed(db, { allowedIdentity: identity });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  return { id: ownerId, identity, accounts };
}

async function tokenFor(o: Owner): Promise<string> {
  as(o.identity);
  return login(o.identity);
}

async function reviewVariant(o: Owner, channel: Channel) {
  const { content } = await createContent(db, o.id, { title: `작업 ${channel}`, body: BODY });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel, baseVersion: 1 });
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return variant.id;
}

/** 계획(채널마다 항목 1개) → 전부 승인 → 실행(QUEUED). */
async function executed(o: Owner, channels: Channel[] = ['threads'], commandKey = `cmd-${randomUUID()}`) {
  const items: Array<{ variant_id: string; channel_account_id: string }> = [];
  for (const ch of channels) items.push({ variant_id: await reviewVariant(o, ch), channel_account_id: o.accounts[ch] });
  const { plan, items: rows } = await createPlan(db, o.id, { items });
  const approved = await approveItems(db, o.id, plan.id, {
    item_ids: rows.map((r) => r.id),
    expected_hashes: Object.fromEntries(rows.map((r) => [r.id, r.payloadHash])),
    confirm: true,
    purpose: 'mock_publish',
  });
  const ex = await executePlan(db, o.id, plan.id, { commandKey }, config);
  const byChannel = Object.fromEntries(channels.map((ch, i) => [ch, rows.find((r) => r.variantId === items[i]!.variant_id)!.id])) as Record<Channel, string>;
  return { planId: plan.id, itemIds: rows.map((r) => r.id), byChannel, jobIds: ex.queued.map((q) => q.job_id), approvals: approved.approvals, commandKey };
}

/** 이 owner 의 작업만 tick. offsetSec = 지금부터 앞당긴 시계. */
function tick(o: Owner, offsetSec = 0, workerId = 'test-w') {
  return runJobsTick(db, registry, {
    workerId,
    config,
    ownerId: o.id,
    clock: () => new Date(Date.now() + offsetSec * 1000),
    random: () => 0.5,
    submitTimeoutMs: 1500,
    maxJobs: 10,
  });
}

const jobRow = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;
const jobOf = async (itemId: string) =>
  (await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt))).at(-1)!;
const itemRow = async (id: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const planRow = async (id: string) => (await db.select().from(schema.distributionPlans).where(eq(schema.distributionPlans.id, id)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));
const eventNames = async (jobId: string) => (await eventsOf(jobId)).map((e) => (e.sanitizedDetails as { transition?: string; event?: string }).transition ?? (e.sanitizedDetails as { event?: string }).event);

function useScenario(s: MockScenario | ((attempt: number, channel: string) => MockScenario)) {
  adapter.setScenario(typeof s === 'string' ? s : (c, snap) => s(c.attempt, snap.channel));
}

let tmp: string;
beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t11-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
});
beforeEach(() => {
  adapter.reset();
  adapter.setScenario('success');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('성공 경로', () => {
  it('실행 → tick → CONFIRMED, MOCK publication(mock: ID·mock:// 링크), 의도 accepted, 이력 seq 단조 증가, 계획 completed', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const r = await tick(o);
    expect(r.results).toEqual({ CONFIRMED: 1 });
    const job = await jobRow(x.jobIds[0]!);
    expect(job).toMatchObject({ state: 'CONFIRMED', attempt: 1, leaseOwner: null, leaseUntil: null });
    expect(job.doneAt).not.toBeNull();
    expect((await itemRow(x.itemIds[0]!)).status).toBe('CONFIRMED');
    expect((await planRow(x.planId)).status).toBe('completed');
    const pubs = await pubsOf(x.itemIds[0]!);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]).toMatchObject({ isMock: true, verification: 'MOCK', resultKind: 'UPLOADED_PRIVATE', remoteVisibility: 'private' });
    expect(pubs[0]!.externalId).toMatch(/^mock:threads:/);
    expect(pubs[0]!.permalink).toMatch(/^mock:\/\/threads\//);
    const intents = await intentsOf(job.id);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ attempt: 1, intentKey: `${job.id}:1`, outcome: 'accepted', remoteExternalId: pubs[0]!.externalId });
    const ev = await eventsOf(job.id);
    expect(ev.map((e) => e.eventSeq)).toEqual([1, 2, 3, 4]);
    expect(ev.map((e) => [e.stateBefore, e.stateAfter])).toEqual([
      [null, 'QUEUED'],
      ['QUEUED', 'LEASED'],
      ['LEASED', 'SENDING'],
      ['SENDING', 'CONFIRMED'],
    ]);
    // 이력에는 본문이 없다
    expect(JSON.stringify(ev.map((e) => e.sanitizedDetails))).not.toContain(SECRET_LINE);
    // MOCK 결과는 여전히 "실제 발행 실적"으로 저장할 수 없다
    expect(() => toStorablePublication({ kind: 'MOCK', platform: 'threads', mockId: pubs[0]!.externalId })).toThrow();
  });

  it('DB 가 모의 결과를 실제 결과처럼 저장하는 것을 막는다(CHECK) — 결과는 추가 전용, 의도는 결과 한 번만', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await tick(o);
    const job = await jobRow(x.jobIds[0]!);
    const bad = (sqlText: ReturnType<typeof sql>) => expect(db.execute(sqlText)).rejects.toThrow();
    await bad(sql`insert into publications (owner_id, item_id, job_id, external_id, result_kind, remote_visibility, verification, is_mock) values (${o.id}::uuid, ${x.itemIds[0]}::uuid, ${job.id}::uuid, 'mock:threads:zz', 'PUBLISHED', 'public', 'VERIFIED', false)`);
    await bad(sql`insert into publications (owner_id, item_id, job_id, external_id, permalink, result_kind, remote_visibility, verification, is_mock) values (${o.id}::uuid, ${x.itemIds[0]}::uuid, ${job.id}::uuid, 'mock:threads:yy', 'https://threads.net/x', 'PUBLISHED', 'public', 'MOCK', true)`);
    await bad(sql`update publications set external_id = 'mock:threads:other' where item_id = ${x.itemIds[0]}::uuid`);
    await bad(sql`delete from publications where item_id = ${x.itemIds[0]}::uuid`);
    await bad(sql`update send_intents set outcome = 'rejected' where job_id = ${job.id}::uuid`);
    await bad(sql`delete from send_intents where job_id = ${job.id}::uuid`);
    await bad(sql`update jobs set state = 'DONE' where id = ${job.id}::uuid`);
  });
});

describe('A07 — 더블클릭·worker 2개', () => {
  it('worker A 가 lease 한 작업은 worker B 가 잡지 못한다 → 의도·결과 1개', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const leasedA = await leaseJobs(db, { workerId: 'worker-a', now: new Date(), limit: 1, ownerId: o.id });
    expect(leasedA.map((j) => j.id)).toEqual([x.jobIds[0]]);
    const b = await tick(o, 0, 'worker-b');
    expect(b.leased).toBe(0);
    const pa = await processJob(db, registry, leasedA[0]!, { workerId: 'worker-a', config, submitTimeoutMs: 1500 });
    expect(pa.state).toBe('CONFIRMED');
    // B 가 A 의 lease 행으로 처리하려 해도 lease 소유자가 달라 아무것도 하지 않는다
    const pb = await processJob(db, registry, { ...leasedA[0]! }, { workerId: 'worker-b', config });
    expect(pb.state).toBe('lease_lost');
    expect(await intentsOf(x.jobIds[0]!)).toHaveLength(1);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect(adapter.calls.submit).toBe(1);
  });

  it('같은 실행 명령 두 번 + 다른 key 실행 + tick 두 번 → 작업·결과 1개', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const again = await executePlan(db, o.id, x.planId, { commandKey: x.commandKey }, config);
    expect(again.idempotent_replay).toBe(true);
    await expect(executePlan(db, o.id, x.planId, { commandKey: `cmd-${randomUUID()}` }, config)).rejects.toMatchObject({ code: 'already_executed' });
    await tick(o, 0, 'w1');
    await tick(o, 0, 'w2');
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.itemId, x.itemIds[0]!))).toHaveLength(1);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect(adapter.calls.submit).toBe(1);
  });
});

describe('A08·A20 — 결과 불명·lease 만료', () => {
  it('ambiguous_sent: RECONCILING → 다음 tick 조회로 찾음 → CONFIRMED, 두 번째 의도 없음', async () => {
    const o = await newOwner();
    const x = await executed(o);
    useScenario('ambiguous_sent');
    expect((await tick(o)).results).toEqual({ RECONCILING: 1 });
    const j1 = await jobRow(x.jobIds[0]!);
    expect(j1.state).toBe('RECONCILING');
    expect((await itemRow(x.itemIds[0]!)).status).toBe('RECONCILING');
    expect((await intentsOf(j1.id))[0]!.outcome).toBe('ambiguous');
    // 아직 조회 시각 전: 아무것도 하지 않는다
    expect((await tick(o, 1)).leased).toBe(0);
    useScenario('success');
    expect((await tick(o, 11)).results).toEqual({ CONFIRMED: 1 });
    expect(adapter.calls.submit).toBe(1);
    expect(adapter.calls.reconcile).toBe(1);
    expect(await intentsOf(j1.id)).toHaveLength(1);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect(await eventNames(j1.id)).toEqual(['execute', 'lease', 'send_start', 'ambiguous', 'reconciled_found']);
  });

  it('의도 기록 뒤 worker 가 죽음(lease 만료) → RECONCILING, 재전송 없이 원격에서 찾아 CONFIRMED', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const [leased] = await leaseJobs(db, { workerId: 'dead-worker', now: new Date(), limit: 1, ownerId: o.id });
    // 1단계(SENDING + 의도)까지 하고 죽은 상태를 흉내: 의도 기록, lease 만료, 원격은 받았다.
    // beginSend 흉내: SENDING + attempt 1(FIX-T11 round 2 — 시도는 의도를 쓸 때 센다) + 의도
    await db.update(schema.jobs).set({ state: 'SENDING', attempt: 1, leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, leased!.id));
    await db.insert(schema.sendIntents).values({ ownerId: o.id, jobId: leased!.id, attempt: 1, intentKey: `${leased!.id}:1` });
    adapter.plantRemote(`${leased!.id}:1`, 'threads');
    const r = await tick(o);
    expect(r.recovered).toBe(1);
    expect(r.results).toEqual({ CONFIRMED: 1 });
    expect(adapter.calls.submit).toBe(0);
    expect(await intentsOf(leased!.id)).toHaveLength(1);
    expect((await intentsOf(leased!.id))[0]!.outcome).toBe('accepted');
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect(await eventNames(leased!.id)).toEqual(['execute', 'lease', 'lease_expired_after_intent', 'reconciled_found']);
  });

  it('의도 기록 전에 죽음 → QUEUED 로 돌아가 한 번만 처리(FIX-T11: 시작 전 만료는 시도가 아님 — 시도 1, 의도 1)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const [leased] = await leaseJobs(db, { workerId: 'dead-worker', now: new Date(), limit: 1, ownerId: o.id });
    await db.update(schema.jobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, leased!.id));
    const r = await tick(o);
    expect(r.recovered).toBe(1);
    expect(r.results).toEqual({ CONFIRMED: 1 });
    expect(adapter.calls.submit).toBe(1);
    const intents = await intentsOf(leased!.id);
    expect(intents.map((i) => [i.attempt, i.outcome])).toEqual([[1, 'accepted']]);
    expect((await jobRow(leased!.id)).attempt).toBe(1);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect(await eventNames(leased!.id)).toEqual(['execute', 'lease', 'lease_expired_before_intent', 'lease', 'send_start', 'confirmed']);
  });

  it('보내기 전에 되풀이해 죽는 작업은 의도 없는 만료 횟수 한도에서 FAILED(끝없는 재lease 없음, 전송 0) — FIX-T11 round 2: 시도 한도와 별개', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const [leased] = await leaseJobs(db, { workerId: 'dead-worker', now: new Date(), limit: 1, ownerId: o.id });
    // 이미 4번 의도 없이 만료된 작업(한도 5) — 이번 만료로 FAILED
    await db.update(schema.jobs).set({ leaseExpiredBeforeIntent: 4, leaseUntil: new Date(Date.now() - 1000) }).where(eq(schema.jobs.id, leased!.id));
    const r = await tick(o);
    expect(r.recovered).toBe(1);
    expect(r.leased).toBe(0);
    const j = await jobRow(leased!.id);
    expect(j).toMatchObject({ state: 'FAILED', lastErrorCode: 'lease_expired_before_intent', leaseExpiredBeforeIntent: 5, attempt: 0 });
    expect((await itemRow(x.itemIds[0]!)).status).toBe('FAILED');
    expect(adapter.calls.submit).toBe(0);
  });

  it('시도를 다 쓴 작업은 lease 돼도 보내지 않고 FAILED(attempts_exhausted, 전송 0)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    await db.update(schema.jobs).set({ attempt: 5 }).where(eq(schema.jobs.id, x.jobIds[0]!));
    const r = await tick(o);
    expect(r.results).toEqual({ FAILED: 1 });
    expect(await jobRow(x.jobIds[0]!)).toMatchObject({ state: 'FAILED', lastErrorCode: 'attempts_exhausted' });
    expect(adapter.calls.submit).toBe(0);
    expect(await intentsOf(x.jobIds[0]!)).toHaveLength(0);
  });

  it('ambiguous_not_sent: 조회로 "확실히 없음" → RETRY_WAIT → 새 시도·새 의도 → CONFIRMED(의도 2, 결과 1)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    useScenario((attempt) => (attempt === 1 ? 'ambiguous_not_sent' : 'success'));
    expect((await tick(o)).results).toEqual({ RECONCILING: 1 });
    expect((await tick(o, 11)).results).toEqual({ RETRY_WAIT: 1 });
    const j = await jobRow(x.jobIds[0]!);
    expect(j.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    expect((await tick(o, 11 + 45)).results).toEqual({ CONFIRMED: 1 });
    const intents = await intentsOf(j.id);
    expect(intents.map((i) => [i.attempt, i.outcome])).toEqual([
      [1, 'ambiguous'],
      [2, 'accepted'],
    ]);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
  });

  it('조회 불가(read 권한 없음) 3회 → UNKNOWN, UNKNOWN 은 다시 lease·전송하지 않음, 사용자 재확인으로 찾으면 CONFIRMED', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    adapter.setCapabilities({ read: false });
    useScenario('ambiguous_sent');
    await tick(o);
    expect((await tick(o, 11)).results).toEqual({ RECONCILING: 1 });
    expect((await tick(o, 11 + 21)).results).toEqual({ RECONCILING: 1 });
    expect((await tick(o, 11 + 21 + 41)).results).toEqual({ UNKNOWN: 1 });
    expect((await itemRow(x.itemIds[0]!)).status).toBe('UNKNOWN');
    // D19: CONFIRMED 없이 UNKNOWN 만 → attention(확인 필요) — 실패로도, 부분 성공으로도 부르지 않는다
    expect((await planRow(x.planId)).status).toBe('attention');
    for (const off of [3600, 86_400]) expect((await tick(o, off)).leased).toBe(0);
    expect(adapter.calls.submit).toBe(1);
    // 취소는 확정할 수 없다(원격에 있을 수 있음)
    const c = await cancelPOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/cancel`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
    expect(c.status).toBe(409);
    expect((await c.json()).error).toBe('cancel_unknown');
    // 사용자 재확인(조회만): 원격 읽기가 되면 찾는다
    adapter.setCapabilities({ read: true });
    const res = await reconcilePOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/reconcile`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state_before: 'UNKNOWN', state: 'CONFIRMED', found: true, remote: 'found' });
    expect(adapter.calls.submit).toBe(1);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect((await planRow(x.planId)).status).toBe('completed');
  });

  it('사용자 재확인은 찾지 못하면 상태를 바꾸지 않고 보내지도 않는다', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    useScenario('ambiguous_not_sent');
    await tick(o);
    const res = await reconcilePOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/reconcile`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
    expect(await res.json()).toMatchObject({ state_before: 'RECONCILING', state: 'RECONCILING', found: false, remote: 'not_found' });
    expect(adapter.calls.submit).toBe(1);
    const none = await reconcilePOST(jsonPost(`/api/distribution-items/${randomUUID()}/reconcile`, {}, cookieHeader(token)), ctx(randomUUID()));
    expect(none.status).toBe(404);
  });

  it('processing_then_confirm: REMOTE_PROCESSING → 다음 조회 tick → CONFIRMED', async () => {
    const o = await newOwner();
    const x = await executed(o);
    useScenario('processing_then_confirm');
    expect((await tick(o)).results).toEqual({ REMOTE_PROCESSING: 1 });
    expect((await itemRow(x.itemIds[0]!)).status).toBe('REMOTE_PROCESSING');
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(0);
    expect((await tick(o, 16)).results).toEqual({ CONFIRMED: 1 });
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect(adapter.calls.submit).toBe(1);
  });

  it('hang: 시간 제한을 넘으면 결과 불명 → RECONCILING(재전송 아님)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    useScenario('hang');
    const r = await runJobsTick(db, registry, { workerId: 'w-hang', config, ownerId: o.id, submitTimeoutMs: 100 });
    expect(r.results).toEqual({ RECONCILING: 1 });
    const j = await jobRow(x.jobIds[0]!);
    expect(j.lastErrorCode).toBe('submit_timeout');
    expect((await intentsOf(j.id))[0]!.outcome).toBe('ambiguous');
  });
});

describe('재시도·실패·보류', () => {
  it('transient: RETRY_WAIT(다음 시각은 미래) → 시계를 앞당기면 재시도 → 5회 뒤 FAILED, 다른 채널 성공이면 계획 partial(A09)', async () => {
    const o = await newOwner();
    const x = await executed(o, ['threads', 'blog']);
    useScenario((_attempt, channel) => (channel === 'threads' ? 'transient' : 'success'));
    const first = await tick(o);
    expect(first.results).toEqual({ RETRY_WAIT: 1, CONFIRMED: 1 });
    const threadsJob = await jobOf(x.byChannel.threads);
    expect(threadsJob.state).toBe('RETRY_WAIT');
    expect(threadsJob.lastRetryClass).toBe('transient_no_side_effect');
    expect(threadsJob.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect((await tick(o, 5)).leased).toBe(0);
    let off = 0;
    for (let attempt = 2; attempt <= 5; attempt++) {
      off += 20 * 60;
      await tick(o, off);
      expect((await jobRow(threadsJob.id)).attempt).toBe(attempt);
    }
    const done = await jobRow(threadsJob.id);
    expect(done.state).toBe('FAILED');
    expect((await itemRow(x.byChannel.threads)).status).toBe('FAILED');
    expect((await itemRow(x.byChannel.blog)).status).toBe('CONFIRMED');
    expect((await planRow(x.planId)).status).toBe('partial');
    expect(await intentsOf(done.id)).toHaveLength(5);
    // 성공한 채널은 다시 보내지 않는다
    expect(await pubsOf(x.byChannel.blog)).toHaveLength(1);
    expect(adapter.calls.submit).toBe(6);
    expect((await eventsOf(done.id)).at(-1)!.sanitizedDetails).toMatchObject({ reason: 'max_attempts' });
  });

  it('permanent → 바로 FAILED(재시도 없음), auth → BLOCKED(재시도 없음)', async () => {
    const o = await newOwner();
    const x = await executed(o, ['threads', 'blog']);
    useScenario((_a, channel) => (channel === 'threads' ? 'permanent' : 'auth'));
    expect((await tick(o)).results).toEqual({ FAILED: 1, BLOCKED: 1 });
    expect((await tick(o, 3600)).leased).toBe(0);
    expect((await itemRow(x.byChannel.threads)).status).toBe('FAILED');
    expect((await itemRow(x.byChannel.blog)).status).toBe('BLOCKED');
    expect((await jobOf(x.byChannel.blog)).lastRetryClass).toBe('auth');
    // D19: 보류(계정 다시 연결 필요)가 있으면 failed 가 아니라 attention(확인 필요)
    expect((await planRow(x.planId)).status).toBe('attention');
    expect(adapter.calls.submit).toBe(2);
  });

  it('A10(D19): 재시도 대기 중 승인 철회 → 즉시 BLOCKED(approval_revoked), 항목 PLANNED, 이후 tick 은 lease 0·새 전송 의도 없음', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    useScenario('transient');
    await tick(o);
    expect((await jobRow(x.jobIds[0]!)).state).toBe('RETRY_WAIT');
    const { POST: revokePOST } = await import('../../apps/web/app/api/approvals/[id]/revoke/route');
    const rv = await revokePOST(jsonPost(`/api/approvals/${x.approvals[0]!.id}/revoke`, {}, cookieHeader(token)), ctx(x.approvals[0]!.id));
    expect(rv.status).toBe(200);
    expect(await rv.json()).toMatchObject({ blocked_job_ids: [x.jobIds[0]], cancel_requested_job_ids: [] });
    const j = await jobRow(x.jobIds[0]!);
    expect(j.state).toBe('BLOCKED');
    expect(j.lastErrorCode).toBe('approval_revoked');
    expect((await eventsOf(j.id)).at(-1)!.sanitizedDetails).toMatchObject({ event: 'approval_revoked', transition: 'blocked', from: 'RETRY_WAIT' });
    expect((await itemRow(x.itemIds[0]!)).status).toBe('PLANNED');
    useScenario('success');
    expect((await tick(o, 20 * 60)).leased).toBe(0);
    expect(await intentsOf(j.id)).toHaveLength(1);
    expect(adapter.calls.submit).toBe(1);
  });
});

describe('A11 — 취소', () => {
  it('QUEUED 취소 → 즉시 CANCELED(보내지 않음)', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    const res = await cancelPOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/cancel`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ canceled: true, cancel_requested: false, state: 'CANCELED' });
    expect((await tick(o)).leased).toBe(0);
    expect((await itemRow(x.itemIds[0]!)).status).toBe('CANCELED');
    expect((await planRow(x.planId)).status).toBe('canceled');
    expect(adapter.calls.submit).toBe(0);
    const again = await cancelPOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/cancel`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('not_cancellable');
  });

  it('전송 중 취소 → "취소 확인 중"(CANCEL_REQUESTED), 원격이 받았으면 CONFIRMED + cancel_too_late — 취소 성공이라고 하지 않는다', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    let cancelBody: Record<string, unknown> | null = null;
    adapter.onSubmit = async () => {
      const res = await cancelPOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/cancel`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
      cancelBody = (await res.json()) as Record<string, unknown>;
      expect((await itemRow(x.itemIds[0]!)).status).toBe('CANCEL_REQUESTED');
    };
    const r = await tick(o);
    expect(cancelBody).toMatchObject({ canceled: false, cancel_requested: true, state: 'CANCEL_REQUESTED', message: '취소 확인 중' });
    expect(r.results).toEqual({ CONFIRMED: 1 });
    const j = await jobRow(x.jobIds[0]!);
    expect(j.cancelRequestedAt).not.toBeNull();
    expect(await eventNames(j.id)).toEqual(['execute', 'lease', 'send_start', 'cancel_requested', 'cancel_too_late']);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
    expect((await itemRow(x.itemIds[0]!)).status).toBe('CONFIRMED');
  });

  it('전송 중 승인 철회 → CANCEL_REQUESTED 로 추적(원격 되돌림 주장 없음), 원격이 받았으면 cancel_too_late', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    const { POST: revokePOST } = await import('../../apps/web/app/api/approvals/[id]/revoke/route');
    let revokeBody: Record<string, unknown> | null = null;
    adapter.onSubmit = async () => {
      const res = await revokePOST(jsonPost(`/api/approvals/${x.approvals[0]!.id}/revoke`, {}, cookieHeader(token)), ctx(x.approvals[0]!.id));
      revokeBody = (await res.json()) as Record<string, unknown>;
    };
    expect((await tick(o)).results).toEqual({ CONFIRMED: 1 });
    expect(revokeBody).toMatchObject({ blocked_job_ids: [], cancel_requested_job_ids: [x.jobIds[0]] });
    expect(await eventNames(x.jobIds[0]!)).toEqual(['execute', 'lease', 'send_start', 'cancel_requested', 'cancel_too_late']);
    expect(await pubsOf(x.itemIds[0]!)).toHaveLength(1);
  });

  it('lease 뒤·전송 전 취소 → CANCEL_REQUESTED → worker 가 보내지 않고 CANCELED', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    const [leased] = await leaseJobs(db, { workerId: 'w-cancel', now: new Date(), limit: 1, ownerId: o.id });
    const res = await cancelPOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/cancel`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
    expect(await res.json()).toMatchObject({ cancel_requested: true, message: '취소 확인 중' });
    const p = await processJob(db, registry, leased!, { workerId: 'w-cancel', config });
    expect(p.state).toBe('CANCELED');
    expect(await intentsOf(leased!.id)).toHaveLength(0);
    expect(adapter.calls.submit).toBe(0);
  });

  it('확인 중(RECONCILING) 취소 → 요청만 기록, 조회에서 원격에 없으면 CANCELED', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o);
    useScenario('ambiguous_not_sent');
    await tick(o);
    const res = await cancelPOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/cancel`, {}, cookieHeader(token)), ctx(x.itemIds[0]!));
    expect(await res.json()).toMatchObject({ cancel_requested: true });
    expect((await tick(o, 11)).results).toEqual({ CANCELED: 1 });
    expect(adapter.calls.submit).toBe(1);
  });
});

describe('재시작 보존', () => {
  it('파일 DB 를 닫고 다시 열어도 작업·의도·이력이 남고, 새 프로세스의 모의 원격은 "없음"을 단정하지 않아 재전송하지 않는다', async () => {
    const dir = path.join(tmp, 'pglite-restart');
    const h1 = await openDb({ DB_DRIVER: 'pglite', DATABASE_URL: dir });
    const saved = db;
    try {
      db = h1.db;
      const o = await newOwner();
      const x = await executed(o);
      const jobId = x.jobIds[0]!;
      const a1 = new MockChannelAdapter({ scenario: 'ambiguous_sent', readEnv: false });
      await runJobsTick(db, new MockChannelAdapterRegistry(a1), { workerId: 'before-restart', config, ownerId: o.id });
      expect((await jobRow(jobId)).state).toBe('RECONCILING');
      await h1.close();
      const h2 = await openDb({ DB_DRIVER: 'pglite', DATABASE_URL: dir });
      db = h2.db;
      try {
        const j = await jobRow(jobId);
        expect(j).toMatchObject({ state: 'RECONCILING', attempt: 1 });
        expect(await intentsOf(jobId)).toHaveLength(1);
        expect((await eventsOf(jobId)).map((e) => e.stateAfter)).toEqual(['QUEUED', 'LEASED', 'SENDING', 'RECONCILING']);
        // 새 프로세스(새 모의 원격): 모르는 요청 → 확인 불가 → 3회 뒤 UNKNOWN, 전송 0
        const a2 = new MockChannelAdapter({ readEnv: false });
        const reg2 = new MockChannelAdapterRegistry(a2);
        const t = (off: number) => runJobsTick(db, reg2, { workerId: 'after-restart', config, ownerId: o.id, clock: () => new Date(Date.now() + off * 1000) });
        await t(11);
        await t(11 + 21);
        await t(11 + 21 + 41);
        expect((await jobRow(jobId)).state).toBe('UNKNOWN');
        expect(a2.calls.submit).toBe(0);
        expect(await intentsOf(jobId)).toHaveLength(1);
      } finally {
        await h2.close();
      }
    } finally {
      db = saved;
    }
  }, 60_000);
});

describe('API·owner·비밀 제거', () => {
  it('GET /api/jobs/{id}: 이력·의도·MOCK 결과, 본문·호스트 이름 없음. 다른 owner 는 취소·재확인·조회 404', async () => {
    const o = await newOwner();
    const other = await newOwner();
    const x = await executed(o);
    await tick(o, 0, 'label-w1');
    const tokenO = await tokenFor(o);
    const res = await jobGET(new Request(`${BASE}/api/jobs/${x.jobIds[0]}`, { headers: { accept: 'application/json', ...cookieHeader(tokenO) } }), ctx(x.jobIds[0]!));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.job).toMatchObject({ state: 'CONFIRMED', mode: 'MOCK', attempt: 1, leased: false });
    expect(body.intents).toHaveLength(1);
    expect(body.publications[0]).toMatchObject({ is_mock: true, verification: 'MOCK', notice: 'MOCK — 실제 발행 실적 아님' });
    expect(body.events.length).toBe(4);
    expect(text).not.toContain(SECRET_LINE);
    expect(text).not.toContain(hostname());
    expect(text).not.toMatch(/payload_json|"payload"/);

    const tokenX = await tokenFor(other);
    const g = await jobGET(new Request(`${BASE}/api/jobs/${x.jobIds[0]}`, { headers: { accept: 'application/json', ...cookieHeader(tokenX) } }), ctx(x.jobIds[0]!));
    expect(g.status).toBe(404);
    const c = await cancelPOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/cancel`, {}, cookieHeader(tokenX)), ctx(x.itemIds[0]!));
    expect(c.status).toBe(404);
    const rc = await reconcilePOST(jsonPost(`/api/distribution-items/${x.itemIds[0]}/reconcile`, {}, cookieHeader(tokenX)), ctx(x.itemIds[0]!));
    expect(rc.status).toBe(404);
  });

  it('POST /api/worker/tick: 로그인·같은 출처 필요, 내 작업만 처리, 계획 조회에 CONFIRMED + MOCK 결과, /api/health 에 작업 개수', async () => {
    const o = await newOwner();
    const other = await newOwner();
    const x = await executed(o);
    const y = await executed(other);
    const token = await tokenFor(o);
    const noOrigin = await tickPOST(
      new Request(`${BASE}/api/worker/tick`, { method: 'POST', headers: { 'content-type': 'application/json', ...cookieHeader(token) }, body: '{}' }),
    );
    expect(noOrigin.status).toBe(403);
    const anon = await tickPOST(jsonPost('/api/worker/tick', {}));
    expect(anon.status).toBe(401);
    const bad = await tickPOST(jsonPost('/api/worker/tick', { max_jobs: 50 }, cookieHeader(token)));
    expect(bad.status).toBe(400);
    const res = await tickPOST(jsonPost('/api/worker/tick', { max_jobs: 5, worker_id: 'demo' }, cookieHeader(token)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ leased: 1, results: { CONFIRMED: 1 }, mode: 'MOCK' });
    expect(body.worker_id).toMatch(/^api-demo/);
    expect((await jobRow(y.jobIds[0]!)).state).toBe('QUEUED');
    const plan = await planGET(new Request(`${BASE}/api/distribution-plans/${x.planId}`, { headers: { accept: 'application/json', ...cookieHeader(token) } }), ctx(x.planId));
    const pd = await plan.json();
    expect(pd.plan.status).toBe('completed');
    expect(pd.items[0].status).toBe('CONFIRMED');
    expect(pd.items[0].publications[0]).toMatchObject({ is_mock: true, verification: 'MOCK' });
    expect(pd.items[0].publications[0].permalink).toMatch(/^mock:\/\//);

    const h = await healthGET();
    const hb = await h.json();
    expect(Object.keys(hb.jobs).sort()).toEqual(['attention_plans', 'blocked', 'leased', 'queued', 'reconciling', 'retry_wait', 'unknown']);
    expect(Object.values(hb.jobs).every((v) => typeof v === 'number')).toBe(true);
  });

  it('HTML 폼: 취소·작업 처리 실행은 303 으로 계획 화면(canceled=1·ticked=n), 한 채널 취소 + 한 채널 확인 → partial', async () => {
    const o = await newOwner();
    const token = await tokenFor(o);
    const x = await executed(o, ['threads', 'blog']);
    const form = (p: string, fields: Record<string, string>) =>
      new Request(`${BASE}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', origin: BASE, ...cookieHeader(token) },
        body: new URLSearchParams(fields).toString(),
      });
    const c = await cancelPOST(form(`/api/distribution-items/${x.byChannel.blog}/cancel`, { plan_id: x.planId }), ctx(x.byChannel.blog));
    expect(c.status).toBe(303);
    expect(c.headers.get('location')).toBe(`/distribute/${x.planId}?canceled=1`);
    const t = await tickPOST(form('/api/worker/tick', { plan_id: x.planId, max_jobs: '5' }));
    expect(t.status).toBe(303);
    expect(t.headers.get('location')).toBe(`/distribute/${x.planId}?ticked=1`);
    expect((await planRow(x.planId)).status).toBe('partial');
    const pubs = await pubsOf(x.byChannel.threads);
    expect(pubs).toHaveLength(1);
    const events = await db
      .select()
      .from(schema.jobEvents)
      .where(and(eq(schema.jobEvents.ownerId, o.id), eq(schema.jobEvents.stateAfter, 'CANCELED')));
    expect(events).toHaveLength(1);
  });
});
