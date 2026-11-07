/**
 * FIX1-FULLREV4(J1, 검토 기록 docs/handoffs/FULLREV4_CLAUDE_REVIEW.md J1): 보내기 직전(LEASED — 아직 보내지 않음) 작업은 승인 무효화 때 막히지 않고
 * 항목만 실행 전(PLANNED)으로 간다. 그 사이 worker 가 죽어 lease 가 만료되면 복구가 그 작업을 다시 대기시킨다. 되돌릴 수 있는 원인(계정 끔 → 켬,
 * 위험 표시 '확인 필요' → 해제)을 지우고 다시 승인(승인 B, 같은 payloadHash)하면 사용자의 실행은 409(already_executed — 항목당 활성 작업 1개)인데,
 * 전에는 옛 작업(승인 A 로 만든 작업, 키 publish:<항목>:<A>)이 보내기 직전 재검사에서 "지금 활성 승인 + 같은 hash"만 확인해 승인 B 로 게시됐다.
 * 이제 보내기 직전 재검사는 활성 승인이 **이 작업을 만든 승인**과 같은지도 본다 — 다르면 approval_missing(보내지 않음) → 작업 BLOCKED·항목 PLANNED.
 * 승인 B 는 그대로 살아 있어 사용자의 다음 실행이 새 작업(키 publish:<항목>:<B>)으로 게시한다(게시 1번).
 * 모의 계정·모의 어댑터만 — 네트워크 호출 없음.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import {
  approveItems,
  closeDb,
  createContent,
  createIdea,
  createPlan,
  createVariantDraft,
  executePlan,
  getDb,
  leaseJobs,
  listChannelAccounts,
  runJobsTick,
  schema,
  seed,
  setChannelAccountState,
  setVariantLifecycle,
  updateIdea,
  type Db,
} from '@cs/db';
import { loadConfig, type Channel } from '@cs/domain';
import { createMockAdapterRegistry } from '@cs/providers';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { cookieHeader, jsonPost, login } from './helpers';

const config = loadConfig({});
const BODY = '# 해외 영업 첫 분기\n\n대리점과 재고 기준을 먼저 합의했다.';

let db: Db;
let tmp: string;
const registry = createMockAdapterRegistry();
const adapter = registry.mock;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

interface Owner {
  id: string;
  token: string;
  accounts: Record<Channel, string>;
}

async function newOwner(): Promise<Owner> {
  const identity = `fr4-j1-${randomUUID().slice(0, 8)}@example.local`;
  const { ownerId } = await seed(db, { allowedIdentity: identity });
  const accounts = Object.fromEntries((await listChannelAccounts(db, ownerId)).map((a) => [a.platform, a.id])) as Record<Channel, string>;
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
  return { id: ownerId, token: await login(identity), accounts };
}

interface Executed {
  planId: string;
  itemId: string;
  hash: string;
  ideaId: string;
  approvalA: string;
  jobId: string;
}

/** 아이디어를 연결한 원고 → Threads 파생본(review) → 계획(모의 계정) → 승인 A(mock_publish) → 실행(작업 QUEUED) */
async function executed(o: Owner): Promise<Executed> {
  const idea = await createIdea(db, o.id, { idea: `J1 아이디어 ${randomUUID().slice(0, 8)}` });
  const { content } = await createContent(db, o.id, { title: 'FR4 J1', body: BODY, ideaId: idea.id });
  const { variant } = await createVariantDraft(db, o.id, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, o.id, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const { plan, items } = await createPlan(db, o.id, { items: [{ variant_id: variant.id, channel_account_id: o.accounts.threads }] });
  const it0 = items[0]!;
  const approvalA = (await approve(o, plan.id, it0.id, it0.payloadHash)).approvals[0]!.id;
  const ex = await executePlan(db, o.id, plan.id, { commandKey: `fr4-j1-${randomUUID()}` }, config);
  return { planId: plan.id, itemId: it0.id, hash: it0.payloadHash, ideaId: idea.id, approvalA, jobId: ex.queued[0]!.job_id };
}

const approve = (o: Owner, planId: string, itemId: string, hash: string) =>
  approveItems(db, o.id, planId, { item_ids: [itemId], expected_hashes: { [itemId]: hash }, confirm: true, purpose: 'mock_publish' });
const executeApi = (o: Owner, planId: string) =>
  executePOST(jsonPost(`/api/distribution-plans/${planId}/execute`, { command_key: `fr4-j1-${randomUUID()}` }, cookieHeader(o.token)), ctx(planId));

const tick = (o: Owner, offsetSec: number) =>
  runJobsTick(db, registry, {
    workerId: 'fr4-j1-w',
    config,
    ownerId: o.id,
    clock: () => new Date(Date.now() + offsetSec * 1000),
    random: () => 0.5,
    submitTimeoutMs: 500,
    maxJobs: 10,
  });

const jobsOf = (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
const jobRow = async (id: string) => (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;
const itemOf = async (id: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, id)))[0]!;
const approvalsOf = (itemId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId)).orderBy(asc(schema.approvals.approvedAt));
const pubsOf = (itemId: string) => db.select().from(schema.publications).where(eq(schema.publications.itemId, itemId));
const eventsOf = (jobId: string) => db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).orderBy(asc(schema.jobEvents.eventSeq));
const ideaRev = async (id: string) => (await db.select().from(schema.ideas).where(eq(schema.ideas.id, id)))[0]!.revision;

type Cause = '계정 끔→켬' | "위험 표시 '확인 필요'→해제";
/** 되돌릴 수 있는 원인 — 실제 db 함수(계정 상태 변경 훅 / 아이디어 위험 표시 훅)로 켠다·끈다 */
async function causeOn(o: Owner, x: Executed, cause: Cause) {
  if (cause === '계정 끔→켬') await setChannelAccountState(db, o.id, o.accounts.threads, 'disconnected');
  else await updateIdea(db, o.id, x.ideaId, { risk: 'needs_check' }, await ideaRev(x.ideaId));
}
async function causeOff(o: Owner, x: Executed, cause: Cause) {
  if (cause === '계정 끔→켬') await setChannelAccountState(db, o.id, o.accounts.threads, 'mock_ready');
  else await updateIdea(db, o.id, x.ideaId, { risk: 'none' }, await ideaRev(x.ideaId));
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr4-j1-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  db = (await getDb(loadConfig())).db;
});
beforeEach(() => adapter.reset());
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('FIX1-FULLREV4(J1): 승인 A 로 만든 lease 작업은 다시 승인한 승인 B 로 게시하지 않는다', () => {
  it.each<Cause>(['계정 끔→켬', "위험 표시 '확인 필요'→해제"])(
    'lease(보내기 전) → %s → 항목 PLANNED·작업 LEASED → 다시 승인 B → 실행 409 → lease 만료 복구·처리 → 보내지 않고 BLOCKED(approval_missing)·항목 PLANNED·승인 B 유지 → 실행 → 새 작업으로 게시 1번',
    async (cause) => {
      const o = await newOwner();
      const x = await executed(o);
      expect(await jobRow(x.jobId)).toMatchObject({ state: 'QUEUED', idempotencyKey: `publish:${x.itemId}:${x.approvalA}` });

      // worker 가 lease 만 잡고(보내기 전) 죽는다
      const [leased] = await leaseJobs(db, { workerId: 'dead-w', now: new Date(), limit: 1, leaseTtlMs: 1000, ownerId: o.id });
      expect(leased).toMatchObject({ id: x.jobId, state: 'LEASED', attempt: 0 });

      // 되돌릴 수 있는 원인 → 승인 A 무효 · 항목 PLANNED · 작업은 LEASED 그대로(전송 단계는 철회 훅이 건드리지 않음)
      await causeOn(o, x, cause);
      const [a0] = await approvalsOf(x.itemId);
      expect(a0).toMatchObject({ id: x.approvalA });
      expect(a0!.revokedAt).not.toBeNull();
      expect((await itemOf(x.itemId)).status).toBe('PLANNED');
      expect(await jobRow(x.jobId)).toMatchObject({ state: 'LEASED', leaseOwner: 'dead-w' });

      // 원인 해제 → 다시 승인 B(같은 payloadHash)
      await causeOff(o, x, cause);
      const approvalB = (await approve(o, x.planId, x.itemId, x.hash)).approvals[0]!.id;
      expect(approvalB).not.toBe(x.approvalA);
      // 사용자의 실행은 409 — 옛 작업이 아직 활성(LEASED)이라 항목당 활성 작업 1개 규칙에 걸린다
      const ex1 = await executeApi(o, x.planId);
      expect(ex1.status).toBe(409);
      expect(((await ex1.json()) as { error: string }).error).toBe('already_executed');
      expect(await jobsOf(x.itemId)).toHaveLength(1);

      // lease 만료 → 복구(QUEUED) → 같은 tick 에서 다시 lease → 보내기 직전 재검사: 활성 승인 B ≠ 작업의 승인 A → 보내지 않음
      const r = await tick(o, 5);
      expect(r.recovered).toBe(1);
      expect(r.results).toEqual({ BLOCKED: 1 });
      expect(adapter.calls.submit).toBe(0);
      expect(await pubsOf(x.itemId)).toHaveLength(0);
      const old = await jobRow(x.jobId);
      expect(old).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing', leaseOwner: null, attempt: 0 });
      const last = (await eventsOf(x.jobId)).at(-1)!;
      expect(last).toMatchObject({ stateBefore: 'LEASED', stateAfter: 'BLOCKED' });
      expect(last.sanitizedDetails).toMatchObject({ transition: 'blocked', reason: 'approval_missing', approval_binding: 'other_approval' });
      expect(await db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, x.jobId))).toHaveLength(0);
      // 항목은 실행 전(PLANNED) · 승인 B 는 그대로 살아 있다(철회하지 않음)
      expect((await itemOf(x.itemId)).status).toBe('PLANNED');
      const aps = await approvalsOf(x.itemId);
      expect(aps.map((a) => a.id)).toEqual([x.approvalA, approvalB]);
      expect(aps[1]!.revokedAt).toBeNull();
      // 더 돌려도 옛 작업은 다시 보내지 않는다
      expect((await tick(o, 60)).results).toEqual({});
      expect(adapter.calls.submit).toBe(0);

      // 사용자의 다음 실행 → 새 작업(승인 B 의 키)으로 게시 1번
      const ex2 = await executeApi(o, x.planId);
      expect(ex2.status, await ex2.clone().text()).toBe(200);
      const js = await jobsOf(x.itemId);
      expect(js).toHaveLength(2);
      expect(js[1]).toMatchObject({ state: 'QUEUED', idempotencyKey: `publish:${x.itemId}:${approvalB}` });
      expect((await tick(o, 120)).results).toEqual({ CONFIRMED: 1 });
      expect(adapter.calls.submit).toBe(1);
      expect(await pubsOf(x.itemId)).toHaveLength(1);
      expect((await itemOf(x.itemId)).status).toBe('CONFIRMED');
      expect((await jobRow(x.jobId)).state).toBe('BLOCKED');
    },
  );

  it('대조: 원인 없이 lease 만료 → 복구 → 같은 승인 A 로 그대로 게시(게시 1번)', async () => {
    const o = await newOwner();
    const x = await executed(o);
    const [leased] = await leaseJobs(db, { workerId: 'dead-w', now: new Date(), limit: 1, leaseTtlMs: 1000, ownerId: o.id });
    expect(leased?.id).toBe(x.jobId);
    const r = await tick(o, 5);
    expect(r.recovered).toBe(1);
    expect(r.results).toEqual({ CONFIRMED: 1 });
    expect(adapter.calls.submit).toBe(1);
    expect(await pubsOf(x.itemId)).toHaveLength(1);
  });

  it('작업 키에서 승인을 알 수 없으면(형식이 다른 행) 보내지 않고 BLOCKED(approval_missing)·항목 PLANNED — 다음 실행은 새 작업으로 게시', async () => {
    const o = await newOwner();
    const x = await executed(o);
    // 앱은 작업을 publish:<항목>:<승인> 키로만 만든다(distribution.ts executePlan — 작업 표가 생긴 0016 부터). 다른 형식은 시험용으로 직접 넣는다.
    await db.execute(sql`update jobs set idempotency_key = ${`legacy:${randomUUID()}`} where id = ${x.jobId}::uuid`);
    expect((await tick(o, 0)).results).toEqual({ BLOCKED: 1 });
    expect(adapter.calls.submit).toBe(0);
    expect(await jobRow(x.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing' });
    expect((await eventsOf(x.jobId)).at(-1)!.sanitizedDetails).toMatchObject({ reason: 'approval_missing', approval_binding: 'key_unparsed' });
    expect((await itemOf(x.itemId)).status).toBe('PLANNED');
    // 다른 항목의 키(승인 A 는 맞지만 항목 ID 가 다름)도 같은 규칙
    const y = await executed(o);
    await db.execute(sql`update jobs set idempotency_key = ${`publish:${randomUUID()}:${y.approvalA}`} where id = ${y.jobId}::uuid`);
    expect((await tick(o, 1)).results).toEqual({ BLOCKED: 1 });
    expect(await jobRow(y.jobId)).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing' });
    expect(adapter.calls.submit).toBe(0);
    // 승인 A 는 그대로 — 실행하면 새 작업(publish:<항목>:<A>)으로 게시
    const ex = await executeApi(o, x.planId);
    expect(ex.status, await ex.clone().text()).toBe(200);
    expect((await tick(o, 2)).results).toEqual({ CONFIRMED: 1 });
    expect(adapter.calls.submit).toBe(1);
  });
});
