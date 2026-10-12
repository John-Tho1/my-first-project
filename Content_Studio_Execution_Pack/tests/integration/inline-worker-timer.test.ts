/**
 * T21-P2(T21_DEPLOY_REVIEW G3): web 안 작업 처리기 주기 실행 — 서버 시작 훅이 부르는 startInlineWorkerTimerFromEnv 를 그대로 쓴다.
 * - 꺼짐(기본·separate): 타이머가 없고, 기다려도 대기열 작업이 그대로다.
 * - 켜짐(최소 간격 5초, 실제 시계): HTTP 요청 없이(fetch 0, route 호출 없음) 같은 처리 함수(runInlineWorker)가 대기열 작업을 MOCK 으로 처리한다.
 *   PUBLISH_MODE=disabled 그대로 — 결과는 모의 publication 뿐.
 * - docs/07 "복구 뒤 오래 지난 예약을 자동 공개하지 않고 확인 요청": 타이머 경로에서 예약이 오래 지난 첫 전송은 보내지 않고 BLOCKED(schedule_stale),
 *   사용자 재시도 뒤에만 보낸다. 경계값·이미 보낸 작업(attempt > 0)은 runJobsTick 의 시계 주입으로 따로 확인한다.
 * 외부 호출 없음(모의 어댑터만). 파일 경로는 임시 폴더(./data 를 쓰지 않음).
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  createContent,
  createPlan,
  createVariantDraft,
  executePlan,
  leaseJobs,
  getDb,
  listChannelAccounts,
  retryItem,
  revokeApproval,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, SCHEDULE_STALE_GRACE_MS, type Channel } from '@cs/domain';
import { createMockAdapterRegistry } from '@cs/providers';
import { currentInlineTimer, uninstallInlineTimer } from '../../apps/web/lib/inline-timer';
import { startInlineWorkerTimerFromEnv } from '../../apps/web/lib/inline-worker-timer';

const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.\n\n가격표는 마지막에 확정했다.';
const HOUR = 3600_000;
const MIN = 60_000;

let db: Db;
let tmp: string;
const registry = createMockAdapterRegistry();
const adapter = registry.mock;

interface Owner {
  id: string;
  accounts: Record<Channel, string>;
}

async function newOwner(): Promise<Owner> {
  const { ownerId } = await seed(db, { allowedIdentity: `timer-${randomUUID().slice(0, 8)}@example.local` });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  return { id: ownerId, accounts };
}

/** MSK 날짜·시각(분 단위) — 계획 입력 형식 */
function mskSchedule(at: Date): { date: string; time: string } {
  const msk = new Date(at.getTime() + 3 * HOUR).toISOString();
  return { date: msk.slice(0, 10), time: msk.slice(11, 16) };
}

/** Threads 항목 하나 → 승인 → 실행(QUEUED). schedule 이 있으면 `at` 시각에 계획·승인·실행했다고 기록한다(그때는 미래 예약). */
async function queued(o: Owner, opts: { scheduleAt?: Date; at?: Date } = {}) {
  const at = opts.at ?? new Date();
  const { content } = await createContent(db, o.id, { title: `주기 ${randomUUID().slice(0, 6)}`, body: BODY });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const item = { variant_id: variant.id, channel_account_id: o.accounts.threads, ...(opts.scheduleAt ? { schedule: mskSchedule(opts.scheduleAt) } : {}) };
  const { plan, items } = await createPlan(db, o.id, { items: [item] }, at);
  await approveItems(db, o.id, plan.id, { item_ids: [items[0]!.id], expected_hashes: { [items[0]!.id]: items[0]!.payloadHash }, confirm: true, purpose: 'mock_publish' }, at);
  const ex = await executePlan(db, o.id, plan.id, { commandKey: `cmd-${randomUUID()}` }, loadConfig({}), at);
  return { itemId: items[0]!.id, jobId: ex.queued[0]!.job_id, scheduledAt: items[0]!.scheduledAtUtc };
}

const jobRow = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;
const itemRow = async (id: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const intentsOf = (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId)).orderBy(asc(schema.sendIntents.attempt));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));

async function waitFor(cond: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return cond();
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t21p2-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('RESTORE_LOCAL_DIR', path.join(tmp, 'restores'));
  vi.stubEnv('IMPORT_LOCAL_DIR', path.join(tmp, 'imports'));
  db = (await getDb(loadConfig())).db;
});
beforeEach(() => {
  adapter.reset();
  adapter.setScenario('success');
});
afterEach(async () => {
  await uninstallInlineTimer();
  vi.stubEnv('WORKER_INLINE_INTERVAL_SECONDS', '');
  vi.stubEnv('WORKER_MODE', 'inline');
  vi.restoreAllMocks();
});
afterAll(async () => {
  await uninstallInlineTimer();
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('주기 처리 꺼짐', () => {
  it('기본(간격 미설정 = 0): 타이머 없음, 기다려도 대기열 작업은 QUEUED 그대로', async () => {
    const o = await newOwner();
    const x = await queued(o);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = startInlineWorkerTimerFromEnv();
    expect(r).toEqual({ outcome: 'interval_off', timer: null });
    expect(warn).not.toHaveBeenCalled(); // 시험(NODE_ENV=test)에서는 운영 경고 없음
    expect(currentInlineTimer()).toBeNull();
    await new Promise((res) => setTimeout(res, 6000)); // 최소 간격(5초)보다 길게
    expect((await jobRow(x.jobId)).state).toBe('QUEUED');
    expect(await intentsOf(x.jobId)).toHaveLength(0);
  });

  it('WORKER_MODE=separate 면 간격이 있어도 web 은 시작하지 않는다', async () => {
    vi.stubEnv('WORKER_INLINE_INTERVAL_SECONDS', '5');
    vi.stubEnv('WORKER_MODE', 'separate');
    expect(startInlineWorkerTimerFromEnv()).toEqual({ outcome: 'worker_separate', timer: null });
    expect(currentInlineTimer()).toBeNull();
  });

  it('설정 오류면 시작하지 않고 종류만 경고(값 없음), 예외를 던지지 않는다', async () => {
    vi.stubEnv('WORKER_INLINE_INTERVAL_SECONDS', '3');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(startInlineWorkerTimerFromEnv()).toEqual({ outcome: 'config_invalid', timer: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('config_invalid');
    expect(String(warn.mock.calls[0]![0])).not.toContain('3');
    expect(currentInlineTimer()).toBeNull();
  });
});

describe('주기 처리 켜짐(5초, HTTP 없음)', () => {
  it('대기열 작업을 같은 처리 함수로 MOCK 처리, 오래 지난 예약은 보내지 않고 BLOCKED → 사용자 재시도 뒤에만 보냄', async () => {
    const o = await newOwner();
    const now = Date.now();
    const plain = await queued(o);
    // 3시간 전에 계획·승인·실행, 예약은 2시간 전(서버가 멈춰 있던 동안 지나감) → 오래 지난 예약
    const stale = await queued(o, { at: new Date(now - 3 * HOUR), scheduleAt: new Date(now - 2 * HOUR) });
    // 3시간 전에 실행, 예약은 10분 전 → 아직 오래되지 않음(보낸다)
    const recent = await queued(o, { at: new Date(now - 3 * HOUR), scheduleAt: new Date(now - 10 * MIN) });
    expect((await jobRow(stale.jobId)).state).toBe('QUEUED');

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error');
    vi.stubEnv('WORKER_INLINE_INTERVAL_SECONDS', '5');
    const r = startInlineWorkerTimerFromEnv();
    expect(r.outcome).toBe('started');
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toContain('5초');
    // 프로세스당 한 소유자: 두 번째 시작은 그대로
    expect(startInlineWorkerTimerFromEnv().outcome).toBe('already_running');
    expect(currentInlineTimer()).toBe(r.timer);
    expect((await jobRow(plain.jobId)).state).toBe('QUEUED'); // 시작 직후에는 아직 실행하지 않음

    // FIX1-T21P2(Codex P2 :171): 필요한 작업 상태 전부 + 그 상태를 만든 tick 이 끝났음(진행 중 아님·완료 1회 이상)을 함께 기다린 뒤 단언한다.
    const timer = r.timer!;
    const settled = async () =>
      (await jobRow(plain.jobId)).state === 'CONFIRMED' &&
      (await jobRow(recent.jobId)).state === 'CONFIRMED' &&
      (await jobRow(stale.jobId)).state === 'BLOCKED' &&
      timer.state().runs >= 1 &&
      !timer.state().inFlight;
    expect(await waitFor(settled, 60_000)).toBe(true);
    expect(r.timer!.state().failures).toBe(0);

    // 보통 작업·최근 예약: MOCK 확인(실제 게시 아님 — PUBLISH_MODE=disabled 그대로)
    expect(loadConfig().PUBLISH_MODE).toBe('disabled');
    for (const x of [plain, recent]) {
      expect((await jobRow(x.jobId)).state).toBe('CONFIRMED');
      const pubs = await pubsOf(x.itemId);
      expect(pubs).toHaveLength(1);
      expect(pubs[0]).toMatchObject({ isMock: true, verification: 'MOCK' });
      expect(pubs[0]!.externalId).toMatch(/^mock:/);
    }
    // 오래 지난 예약: 보내지 않음(전송 의도 0·publication 0), 항목 BLOCKED, 승인은 그대로(재시도 가능)
    const sj = await jobRow(stale.jobId);
    expect(sj).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale', attempt: 0, leaseOwner: null });
    expect((await itemRow(stale.itemId)).status).toBe('BLOCKED');
    expect(await intentsOf(stale.jobId)).toHaveLength(0);
    expect(await pubsOf(stale.itemId)).toHaveLength(0);
    const blockedEv = (await db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, stale.jobId))).find((e) => e.stateAfter === 'BLOCKED')!;
    expect(blockedEv.sanitizedDetails).toMatchObject({ event: 'blocked', reason: 'schedule_stale', not_sent: true });
    expect((blockedEv.sanitizedDetails as { late_minutes: number }).late_minutes).toBeGreaterThanOrEqual(119);

    // 다음 주기들이 지나도 그대로(자동으로 다시 보내지 않음) — 시간 대신 완료된 tick 수로 기다린다
    const runsBefore = timer.state().runs;
    expect(await waitFor(async () => timer.state().runs >= runsBefore + 2 && !timer.state().inFlight, 60_000)).toBe(true);
    expect((await jobRow(stale.jobId)).state).toBe('BLOCKED');
    expect(await intentsOf(stale.jobId)).toHaveLength(0);

    // 사용자 확인(재시도) → 다음 주기에 보냄
    const retry = await retryItem(db, o.id, stale.itemId);
    expect(retry.state).toBe('QUEUED');
    const runsAtRetry = timer.state().runs;
    expect(await waitFor(async () => (await jobRow(stale.jobId)).state === 'CONFIRMED' && timer.state().runs > runsAtRetry && !timer.state().inFlight, 60_000)).toBe(true);
    expect(await pubsOf(stale.itemId)).toHaveLength(1);

    // HTTP 요청 0(자기 자신에게도 외부로도), 오류 로그 없음
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();

    // 멈춤: 이후 새 작업은 처리되지 않는다
    expect(await uninstallInlineTimer()).toBe(true);
    expect(currentInlineTimer()).toBeNull();
    const after = await queued(o);
    await new Promise((res) => setTimeout(res, 6000));
    expect((await jobRow(after.jobId)).state).toBe('QUEUED');
  }, 240_000);
});

describe('오래 지난 예약 규칙(runJobsTick, 시계 주입) — CLI·화면 tick 도 같은 경로', () => {
  const config = loadConfig({});
  const tickAt = (o: Owner, at: Date) =>
    runJobsTick(db, registry, { workerId: 'stale-w', config, ownerId: o.id, clock: () => at, random: () => 0.5, submitTimeoutMs: 1500, maxJobs: 10 });

  it('경계값: 예약 + 60분 정각은 보냄, + 60분 1ms 는 보내지 않음', async () => {
    const o = await newOwner();
    const a = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    await tickAt(o, new Date(a.scheduledAt!.getTime() + SCHEDULE_STALE_GRACE_MS));
    expect((await jobRow(a.jobId)).state).toBe('CONFIRMED');

    const o2 = await newOwner();
    const b = await queued(o2, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    await tickAt(o2, new Date(b.scheduledAt!.getTime() + SCHEDULE_STALE_GRACE_MS + 1));
    expect(await jobRow(b.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale' });
    expect(await intentsOf(b.jobId)).toHaveLength(0);
  });

  it('예약 시각 전에는 lease 하지 않고, 예약 없는 작업은 오래 기다려도 이 규칙과 무관', async () => {
    const o = await newOwner();
    const a = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const r = await tickAt(o, new Date(a.scheduledAt!.getTime() - MIN));
    expect(r.leased).toBe(0);
    expect((await jobRow(a.jobId)).state).toBe('QUEUED');
    const plain = await queued(o);
    await tickAt(o, new Date(Date.now() + 5 * 24 * HOUR));
    expect((await jobRow(plain.jobId)).state).toBe('CONFIRMED');
  });

  it('이미 한 번 보낸 작업(attempt > 0 — 일시 실패 뒤 재시도)은 늦어져도 막지 않는다', async () => {
    const o = await newOwner();
    const a = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    adapter.setScenario('transient');
    await tickAt(o, new Date(a.scheduledAt!.getTime() + MIN));
    expect(await jobRow(a.jobId)).toMatchObject({ state: 'RETRY_WAIT', attempt: 1 });
    adapter.setScenario('success');
    await tickAt(o, new Date(a.scheduledAt!.getTime() + 3 * HOUR));
    expect((await jobRow(a.jobId)).state).toBe('CONFIRMED');
  });

  it('BLOCKED(schedule_stale) → 사용자 재시도 → 늦은 시각이어도 보냄(같은 작업, unblock 이력)', async () => {
    const o = await newOwner();
    const a = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const late = new Date(a.scheduledAt!.getTime() + 5 * HOUR);
    await tickAt(o, late);
    expect((await jobRow(a.jobId)).state).toBe('BLOCKED');
    await retryItem(db, o.id, a.itemId, late);
    await tickAt(o, new Date(late.getTime() + MIN));
    expect(await jobRow(a.jobId)).toMatchObject({ state: 'CONFIRMED', attempt: 1 });
    expect(await intentsOf(a.jobId)).toHaveLength(1);
  });
});

describe('FIX1-T21P2(Codex P1 jobs.ts:623): 오래 지난 예약 확인은 schedule_stale 차단 뒤의 명시적 확인만 — 같은 승인·예약·내용일 때만', () => {
  const config = loadConfig({});
  const tickAt = (o: Owner, at: Date) =>
    runJobsTick(db, registry, { workerId: 'confirm-w', config, ownerId: o.id, clock: () => at, random: () => 0.5, submitTimeoutMs: 1500, maxJobs: 10 });
  const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));
  const activeApprovalOf = async (itemId: string) =>
    (await db.select().from(schema.approvals).where(and(eq(schema.approvals.distributionItemId, itemId), isNull(schema.approvals.revokedAt))))[0]!;

  /** 작업 이력 행을 직접 넣는다(복원된 이력·다른 경로의 기록 흉내). */
  async function insertEvent(ownerId: string, jobId: string, stateBefore: string, stateAfter: string, details: Record<string, unknown>, at: Date) {
    const seq = (await db.select({ m: sql<number>`coalesce(max(${schema.jobEvents.eventSeq}), 0)::int` }).from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)))[0]!.m;
    await db.insert(schema.jobEvents).values({ ownerId, jobId, eventSeq: seq + 1, stateBefore, stateAfter, at, sanitizedDetails: details });
  }

  /** 보내기 전(attempt 0) 다른 사유(연결 정보 만료)로 BLOCKED 된 상태를 만든다 — 실제 credentialGate 차단과 같은 행 모양. */
  async function blockForOtherReason(o: Owner, x: { jobId: string; itemId: string }, at: Date) {
    await db.update(schema.jobs).set({ state: 'BLOCKED', lastErrorCode: 'credential_expired', leaseOwner: null, leaseUntil: null, updatedAt: at }).where(eq(schema.jobs.id, x.jobId));
    await db.update(schema.distributionItems).set({ status: 'BLOCKED', updatedAt: at }).where(eq(schema.distributionItems.id, x.itemId));
    await insertEvent(o.id, x.jobId, 'QUEUED', 'BLOCKED', { event: 'blocked', reason: 'credential_blocked', credential_status: 'expired', not_sent: true, transition: 'blocked' }, at);
  }

  it('다른 사유(연결 정보) 재시도 뒤 장시간 중단 → 첫 전송이 오래 지난 예약이면 여전히 BLOCKED(schedule_stale), 전송 의도 0', async () => {
    const o = await newOwner();
    const x = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const t1 = new Date(x.scheduledAt!.getTime() + MIN);
    await blockForOtherReason(o, x, t1);
    expect((await retryItem(db, o.id, x.itemId, t1)).state).toBe('QUEUED'); // 일반 재시도(오래 지난 예약 확인 아님)
    const unblock = (await eventsOf(x.jobId)).at(-1)!.sanitizedDetails as Record<string, unknown>;
    expect(unblock).toMatchObject({ event: 'unblock', cause: 'user_retry' });
    expect(unblock.stale_schedule_confirmed).toBeUndefined();
    // 전송 의도 전에 서버가 멈췄다가 5시간 뒤 복구
    await tickAt(o, new Date(x.scheduledAt!.getTime() + 5 * HOUR));
    expect(await jobRow(x.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale', attempt: 0 });
    expect(await intentsOf(x.jobId)).toHaveLength(0);
  });

  it('schedule_stale 재시도는 확인 기록(승인 ID·내용 hash·예약 시각)을 남기고, 그 뒤 다른 사유 차단·재시도가 있어도 같은 승인·예약이면 보낸다', async () => {
    const o = await newOwner();
    const x = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const late = new Date(x.scheduledAt!.getTime() + 5 * HOUR);
    await tickAt(o, late);
    expect((await jobRow(x.jobId)).lastErrorCode).toBe('schedule_stale');
    await retryItem(db, o.id, x.itemId, late);
    const approval = await activeApprovalOf(x.itemId);
    const item = await itemRow(x.itemId);
    const confirm = (await eventsOf(x.jobId)).at(-1)!.sanitizedDetails as Record<string, unknown>;
    expect(confirm).toMatchObject({
      event: 'unblock',
      cause: 'user_retry',
      stale_schedule_confirmed: true,
      approval_id: approval.id,
      confirmed_payload_hash: item.payloadHash,
      confirmed_scheduled_at_utc: x.scheduledAt!.toISOString(),
    });
    const audit = (await db.select().from(schema.auditEvents).where(and(eq(schema.auditEvents.ownerId, o.id), eq(schema.auditEvents.action, 'item.retry')))).at(-1)!;
    expect(audit.sanitizedDetails).toMatchObject({ stale_schedule_confirmed: true });
    // 확인 뒤 보내기 전에 다른 사유로 다시 막혔다가 일반 재시도 — 확인은 이 승인·예약에 대해 그대로 유효
    await blockForOtherReason(o, x, new Date(late.getTime() + MIN));
    await retryItem(db, o.id, x.itemId, new Date(late.getTime() + 2 * MIN));
    await tickAt(o, new Date(late.getTime() + 3 * MIN));
    expect(await jobRow(x.jobId)).toMatchObject({ state: 'CONFIRMED', attempt: 1 });
  });

  it('복원·위조된 이력: 일반 unblock 이나 다른 승인·예약·내용에 대한 확인, 차단 없는 확인, 복원 표시 작업의 확인은 인정하지 않는다', async () => {
    const o = await newOwner();
    const a = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const late = new Date(a.scheduledAt!.getTime() + 5 * HOUR);
    const item = await itemRow(a.itemId);
    const approval = await activeApprovalOf(a.itemId);
    // 1) 먼저 오래 지난 예약으로 차단(정상 경로)
    await tickAt(o, late);
    expect((await jobRow(a.jobId)).lastErrorCode).toBe('schedule_stale');
    // 2) 그 뒤의 기록 — 일반 unblock(복원된 이력 흉내), 다른 승인 ID·다른 예약 시각·다른 내용 hash 에 대한 확인
    const base = { event: 'unblock', cause: 'user_retry', transition: 'unblock' };
    const conf = { ...base, stale_schedule_confirmed: true };
    await insertEvent(o.id, a.jobId, 'BLOCKED', 'BLOCKED', base, late);
    await insertEvent(o.id, a.jobId, 'BLOCKED', 'BLOCKED', { ...conf, approval_id: randomUUID(), confirmed_payload_hash: item.payloadHash, confirmed_scheduled_at_utc: a.scheduledAt!.toISOString() }, late);
    await insertEvent(o.id, a.jobId, 'BLOCKED', 'BLOCKED', { ...conf, approval_id: approval.id, confirmed_payload_hash: item.payloadHash, confirmed_scheduled_at_utc: new Date(a.scheduledAt!.getTime() - HOUR).toISOString() }, late);
    await insertEvent(o.id, a.jobId, 'BLOCKED', 'BLOCKED', { ...conf, approval_id: approval.id, confirmed_payload_hash: 'f'.repeat(64), confirmed_scheduled_at_utc: a.scheduledAt!.toISOString() }, late);
    // 다시 대기열로(작업·항목만 — 확인 기록은 위의 위조뿐)
    await db.update(schema.jobs).set({ state: 'QUEUED', lastErrorCode: null, nextRunAt: late }).where(eq(schema.jobs.id, a.jobId));
    await db.update(schema.distributionItems).set({ status: 'QUEUED' }).where(eq(schema.distributionItems.id, a.itemId));
    await tickAt(o, new Date(late.getTime() + MIN));
    expect(await jobRow(a.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale' });
    expect(await intentsOf(a.jobId)).toHaveLength(0);

    // 3) schedule_stale 차단 이력 없이 맞는 모양의 확인만 있음 → 인정 안 함
    const b = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const bItem = await itemRow(b.itemId);
    const bAppr = await activeApprovalOf(b.itemId);
    await insertEvent(o.id, b.jobId, 'QUEUED', 'QUEUED', { ...conf, approval_id: bAppr.id, confirmed_payload_hash: bItem.payloadHash, confirmed_scheduled_at_utc: b.scheduledAt!.toISOString() }, new Date(b.scheduledAt!.getTime() + MIN));
    await tickAt(o, new Date(b.scheduledAt!.getTime() + 5 * HOUR));
    expect(await jobRow(b.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale' });
    expect(await intentsOf(b.jobId)).toHaveLength(0);

    // 4) 복원 표시(restored_needs_review) 작업은 올바른 확인 이력이 있어도 인정하지 않는다
    const c = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const cLate = new Date(c.scheduledAt!.getTime() + 5 * HOUR);
    await tickAt(o, cLate);
    await retryItem(db, o.id, c.itemId, cLate); // 올바른 확인
    await db.update(schema.jobs).set({ restoredNeedsReview: true }).where(eq(schema.jobs.id, c.jobId));
    await tickAt(o, new Date(cLate.getTime() + MIN));
    expect(await jobRow(c.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale' });
    expect(await intentsOf(c.jobId)).toHaveLength(0);
  });

  it('확인 뒤 승인 철회 → 보내지 않음(전송 의도 0, 항목 PLANNED)', async () => {
    const o = await newOwner();
    const x = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const late = new Date(x.scheduledAt!.getTime() + 5 * HOUR);
    await tickAt(o, late);
    await retryItem(db, o.id, x.itemId, late);
    const approval = await activeApprovalOf(x.itemId);
    await revokeApproval(db, o.id, approval.id, 'test', new Date(late.getTime() + MIN));
    await tickAt(o, new Date(late.getTime() + 2 * MIN));
    expect(await intentsOf(x.jobId)).toHaveLength(0);
    expect(await pubsOf(x.itemId)).toHaveLength(0);
    expect((await jobRow(x.jobId)).state).not.toBe('CONFIRMED');
    expect((await itemRow(x.itemId)).status).toBe('PLANNED');
  });

  it('lease 뒤·전송 의도 전 중단 → lease 만료 복구(QUEUED) 뒤에도 오래 지난 예약 판정은 같다(BLOCKED, 의도 0)', async () => {
    const o = await newOwner();
    const x = await queued(o, { scheduleAt: new Date(Date.now() + 2 * HOUR) });
    const leased = await leaseJobs(db, { workerId: 'crashed-w', now: new Date(x.scheduledAt!.getTime() + MIN), limit: 5, ownerId: o.id });
    expect(leased.map((j) => j.id)).toContain(x.jobId);
    expect((await jobRow(x.jobId)).state).toBe('LEASED');
    // 처리 없이 프로세스가 죽고 5시간 뒤 복구 tick
    const r = await tickAt(o, new Date(x.scheduledAt!.getTime() + 5 * HOUR));
    expect(r.recovered).toBeGreaterThanOrEqual(1);
    expect(await jobRow(x.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'schedule_stale', attempt: 0 });
    expect(await intentsOf(x.jobId)).toHaveLength(0);
  });
});
