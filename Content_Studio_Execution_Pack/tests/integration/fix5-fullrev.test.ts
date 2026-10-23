/**
 * FIX5-FULLREV(사용자 결정 2026-10-23 "다 권고 사항으로 진행해줘" · FULLREV1 인계 FIX round 4 "남은 것" 2·4):
 *  - T2: retryItem 의 복원 이력 거절(작업에만 복원 표시 · 복원 때 진행 중이던 항목) 문구는 무조건 "새 배포 계획을 만드세요"가 아니라 USER_CONFIRM_RESTORED_MESSAGE 와
 *    같은 조건(채널에서 직접 확인해 게시물이 없을 때만 새 배포 계획). JSON 코드는 그대로(not_retryable · restored: true), 폼 경로는 같은 조건의 화면 문구 코드
 *    (error=not_retryable_restored). T2 후속(리뷰 확정 jobs.ts:1857): 모의 계정 항목은 모의 문구(실제 채널로 보낸 것 없음 — 채널 확인·두 번 게시 경고 없음,
 *    details mock: true, 폼 error=not_retryable_restored_mock), 실제 계정 항목은 조건부 문구(details 그대로).
 *  - T4: 재시도·재확인·사용자 확인·모의 시나리오 HTML 폼이 plan_id 없이 오면 /distribute 대신 항목의 계획 화면(취소 경로와 같은 lib itemFormBack — owner 확인 뒤에만
 *    owner 범위 조회 planIdOfItem). 성공·오류 리다이렉트 모두. 조회 실패(예외·없음)면 /distribute, plan_id 가 있으면 그 값(조회 없음), CSRF·로그인 실패는 조회 없이
 *    그대로, 404 는 /distribute?missing=1.
 *  - FIX2-CODEX(U4, 같은 사용자 결정): 복원 때 결과 불명(UNKNOWN)이던 항목의 재시도 거절(outcome_unknown + restored: true)도 모의 계정은 모의 문구 + mock: true
 *    (원격 확인을 시키지 않음), 실제 계정은 지금 문구 그대로. 폼 경로는 코드 그대로 error=outcome_unknown(채널·원격을 말하지 않는 일반 문구 — 모의 변형 없음).
 * 취소 경로(FIX4 S4)도 같은 lib 로 옮겼으므로 같은 시험을 함께 돌린다. 조회 실패는 @cs/db 의 planIdOfItem 만 감싸서 흉내 낸다(나머지는 실제 모듈 — 기본은 실제 조회). 모의 어댑터만 — **네트워크 호출 0**(fetch 0 확인).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';

import { closeDb, createContent, createVariantDraft, getDb, listChannelAccounts, runJobsTick, schema, seed, setVariantLifecycle, type Db } from '@cs/db';
import { loadConfig } from '@cs/domain';
import { createMockAdapterRegistry } from '@cs/providers';
import { POST as cancelPOST } from '../../apps/web/app/api/distribution-items/[id]/cancel/route';
import { POST as scenarioPOST, PUT as scenarioPUT } from '../../apps/web/app/api/distribution-items/[id]/mock-scenario/route';
import { POST as reconcilePOST } from '../../apps/web/app/api/distribution-items/[id]/reconcile/route';
import { POST as retryPOST } from '../../apps/web/app/api/distribution-items/[id]/retry/route';
import { POST as userConfirmPOST } from '../../apps/web/app/api/distribution-items/[id]/user-confirm/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { DISTRIBUTE_ERROR_TEXT } from '../../apps/web/lib/distribution';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

// FIX5-FULLREV(T4): 계획 조회(planIdOfItem)만 감싼다 — 기본은 실제 조회, 시험이 실패(예외)·없음을 고른다. 나머지 @cs/db 는 실제 모듈.
const lookup = vi.hoisted(() => ({ mode: 'real' as 'real' | 'throw' | 'null', calls: 0 }));
vi.mock('@cs/db', async (orig) => {
  const real = await orig<typeof import('@cs/db')>();
  return {
    ...real,
    planIdOfItem: async (...args: Parameters<typeof real.planIdOfItem>) => {
      lookup.calls++;
      if (lookup.mode === 'throw') throw new Error('FIX5 T4 시험: 계획 조회 실패');
      if (lookup.mode === 'null') return null;
      return real.planIdOfItem(...args);
    },
  };
});

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const config = loadConfig({});
const registry = createMockAdapterRegistry();

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let seedThreads: string;
let fetchCalls = 0;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));

type Route = 'cancel' | 'retry' | 'reconcile' | 'user-confirm' | 'mock-scenario';
const HANDLER: Record<Route, (r: Request, c: ReturnType<typeof ctx>) => Promise<Response>> = {
  cancel: cancelPOST,
  retry: retryPOST,
  reconcile: reconcilePOST,
  'user-confirm': userConfirmPOST,
  'mock-scenario': scenarioPOST,
};
/** 계획 화면의 항목 폼과 같은 요청(HTML — accept text/html). fields 에 plan_id 가 없으면 plan_id 없이 */
function form(route: Route, itemId: string, fields: Record<string, string> = {}, o: { origin?: boolean; cookie?: boolean } = {}): Promise<Response> {
  return HANDLER[route](
    new Request(`${BASE}/api/distribution-items/${itemId}/${route}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'text/html',
        ...(o.origin === false ? {} : ORIGIN_HEADERS),
        ...(o.cookie === false ? {} : cookieHeader(token)),
      },
      body: new URLSearchParams(fields).toString(),
    }),
    ctx(itemId),
  );
}
const location = (res: Response) => {
  expect(res.status).toBe(303);
  return res.headers.get('location');
};

/** 원고 → Threads 파생본(review) → 계획(항목 1개, 기본 모의 Threads 계정) → (모의 시나리오) → (승인 → 실행) */
async function planned(body: string, o: { scenario?: string; execute?: boolean; accountId?: string } = {}): Promise<{ planId: string; itemId: string }> {
  const { content } = await createContent(db, owner, { title: `FIX5 ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variant.id, channel_account_id: o.accountId ?? seedThreads }] }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  const item = p.items[0]!;
  if (o.scenario) {
    const s = await scenarioPUT(
      new Request(`${BASE}/api/distribution-items/${item.id}/mock-scenario`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
        body: JSON.stringify({ scenario: o.scenario }),
      }),
      ctx(item.id),
    );
    expect(s.status, await s.clone().text()).toBe(200);
  }
  if (o.execute !== false) {
    const ap = await approvePOST(
      post(`/api/distribution-plans/${p.plan.id}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
      ctx(p.plan.id),
    );
    expect(ap.status, await ap.clone().text()).toBe(200);
    expect((await executePOST(post(`/api/distribution-plans/${p.plan.id}/execute`, { command_key: `k-${randomUUID()}` }), ctx(p.plan.id))).status).toBe(200);
  }
  return { planId: p.plan.id, itemId: item.id };
}

const tickPlan = (planId: string) =>
  runJobsTick(db, registry, { workerId: 'fix5', config, ownerId: owner, planId, random: () => 0.5, submitTimeoutMs: 5000, maxJobs: 5, credentials: jobCredentials(config, db) });
const jobsOf = async (itemId: string) => db.select().from(schema.jobs).where(eq(schema.jobs.itemId, itemId)).orderBy(asc(schema.jobs.createdAt));
const intentsOf = async (jobId: string) => db.select().from(schema.sendIntents).where(eq(schema.sendIntents.jobId, jobId));
const itemOf = async (itemId: string) => (await db.select().from(schema.distributionItems).where(eq(schema.distributionItems.id, itemId)))[0]!;

/** 모의 401(auth) → BLOCKED(보내지 않았음이 확실한 보류) — 재시도 가능 */
async function blocked(body: string, accountId?: string): Promise<{ planId: string; itemId: string }> {
  const x = await planned(body, { scenario: 'auth', accountId });
  await tickPlan(x.planId);
  const [job] = await jobsOf(x.itemId);
  expect(job).toMatchObject({ state: 'BLOCKED', lastRetryClass: 'auth' });
  expect((await itemOf(x.itemId)).status).toBe('BLOCKED');
  return x;
}
/** 모의 결과 불명(보내지 않음) → RECONCILING — 재확인(조회만) 대상 */
async function reconciling(body: string): Promise<{ planId: string; itemId: string }> {
  const x = await planned(body, { scenario: 'ambiguous_not_sent' });
  await tickPlan(x.planId);
  expect((await jobsOf(x.itemId))[0]!.state).toBe('RECONCILING');
  return x;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix5-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FIX5 시험: 네트워크 호출 금지');
  });
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
  seedThreads = (await listChannelAccounts(db, owner)).find((a) => a.platform === 'threads' && a.kind === 'mock' && a.credentialState === 'none')!.id;
}, 120_000);
beforeEach(() => {
  lookup.mode = 'real';
  lookup.calls = 0;
});
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

const JOB_MSG =
  '복원한 작업은 다시 보내지 않습니다(원격 결과를 이 환경에서 다시 확인하세요). 채널에서 이 계정의 최근 게시물을 직접 확인하세요 — 있으면 그대로 두고, 직접 확인해 게시물이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 내용이 두 번 올라갈 수 있습니다).';
const ITEM_MSG =
  '복원 때 진행 중이던 항목은 다시 보내지 않습니다. 채널에서 이 계정의 최근 게시물을 직접 확인하세요 — 있으면 그대로 두고, 직접 확인해 게시물이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 내용이 두 번 올라갈 수 있습니다).';
const FORM_MSG =
  '복원한 작업·복원 때 진행 중이던 항목은 다시 보내지 않습니다. 채널에서 이 계정의 최근 게시물을 직접 확인하세요 — 있으면 그대로 두고, 직접 확인해 게시물이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 내용이 두 번 올라갈 수 있습니다).';
// FIX5-FULLREV(T2 후속 — 리뷰 확정 jobs.ts:1857): 모의 계정 항목의 같은 거절(실제 채널로 보낸 것 없음 — 채널 확인·두 번 게시 경고 없음)
const MOCK_TAIL = '실제 채널로 보낸 것은 없습니다(확인할 게시물 없음). 모의 실행을 다시 하려면 새 배포 계획을 만드세요.';
const JOB_MOCK_MSG = `MOCK — 복원한 모의 작업은 다시 보내지 않습니다(자동 재전송 안 함). ${MOCK_TAIL}`;
const ITEM_MOCK_MSG = `MOCK — 복원 때 진행 중이던 모의 항목은 다시 보내지 않습니다(자동 재전송 안 함). ${MOCK_TAIL}`;
const FORM_MOCK_MSG = `MOCK — 복원한 모의 작업·복원 때 진행 중이던 모의 항목은 다시 보내지 않습니다(자동 재전송 안 함). ${MOCK_TAIL}`;
/** 모의 문구에 없어야 하는 실제 계정용 말(채널 확인 · 두 번 게시 경고) */
const LIVE_ONLY_WORDS = ['채널에서', '두 번 올라갈', '직접 확인'];

describe('FIX5-FULLREV(T2): 복원 이력 재시도 거절 — 계정 kind 별 복구 길(정확한 문구), 아무것도 바꾸지 않음', () => {
  async function expectUntouched(itemId: string, before: { jobState: string; intents: number; jobs: number }) {
    const js = await jobsOf(itemId);
    expect(js).toHaveLength(before.jobs);
    expect(js.at(-1)!.state).toBe(before.jobState);
    expect(await intentsOf(js.at(-1)!.id)).toHaveLength(before.intents);
  }
  /**
   * FIX5-FULLREV(T2 후속): 복원한 실제 계정 항목 — 항목의 계정은 바꿀 수 없으므로(승인 스냅샷 열) 이 시험만의 모의 Threads 계정 행(기본 모의 계정과 같은 값)으로
   * 모의 401 보류(BLOCKED)까지 만든 뒤, 그 계정 행을 실제 Threads 계정(시험 행 — 연결 정보 없음)으로 바꾼다(복원 묶음에 실제 계정으로 들어온 것과 같은 상태).
   * 복원 이력 거절은 승인·연결 정보 검사 전에 일어나므로 외부 호출이 없다(fetch 0).
   */
  async function blockedOnLiveAccount(body: string): Promise<{ planId: string; itemId: string }> {
    const [base] = await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, seedThreads));
    const [acc] = await db
      .insert(schema.channelAccounts)
      .values({
        ownerId: owner,
        platform: 'threads',
        kind: 'mock',
        externalAccountId: `mock:fix5-${randomUUID()}`,
        displayName: 'FIX5 시험 계정',
        state: base!.state,
        capabilitySnapshot: base!.capabilitySnapshot,
        credentialState: 'none',
      })
      .returning();
    const x = await blocked(body, acc!.id);
    await db
      .update(schema.channelAccounts)
      .set({ kind: 'live', externalAccountId: `fix5-live-${randomUUID()}`, state: 'connected', credentialState: 'linked' })
      .where(eq(schema.channelAccounts.id, acc!.id));
    return x;
  }

  // T2 후속(리뷰 확정 jobs.ts:1857): 기본 모의 Threads 계정 — 실제 채널로 보낸 것이 없으므로 채널 확인·두 번 게시 경고를 하지 않는다
  it('모의 계정 · 작업에만 복원 표시(보류 작업): JSON 409 not_retryable + restored + mock(정확한 모의 문구) · 폼(plan_id 있음·없음) → error=not_retryable_restored_mock', async () => {
    const x = await blocked('복원 표시가 붙은 보류 작업 글.');
    const [job] = await jobsOf(x.itemId);
    await db.update(schema.jobs).set({ restoredNeedsReview: true }).where(eq(schema.jobs.id, job!.id));
    const before = { jobState: 'BLOCKED', intents: (await intentsOf(job!.id)).length, jobs: 1 };
    const res = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body).toEqual({ status: 'BLOCKED', restored: true, mock: true, error: 'not_retryable', message: JOB_MOCK_MSG });
    for (const w of LIVE_ONLY_WORDS) expect(body.message, w).not.toContain(w);
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?error=not_retryable_restored_mock`);
    expect(location(await form('retry', x.itemId))).toBe(`/distribute/${x.planId}?error=not_retryable_restored_mock`);
    expect(DISTRIBUTE_ERROR_TEXT.not_retryable_restored_mock).toBe(FORM_MOCK_MSG);
    for (const w of LIVE_ONLY_WORDS) expect(DISTRIBUTE_ERROR_TEXT.not_retryable_restored_mock, w).not.toContain(w);
    await expectUntouched(x.itemId, before);
    expect((await tickPlan(x.planId)).leased).toBe(0);
  });

  it('모의 계정 · 복원 때 진행 중이던 항목(항목 표시, 보류): JSON 409 not_retryable + restored + mock(정확한 모의 문구) · 폼 → error=not_retryable_restored_mock', async () => {
    const x = await blocked('복원 때 진행 중이던 항목 글.');
    await db.update(schema.distributionItems).set({ restoredNeedsReview: true }).where(eq(schema.distributionItems.id, x.itemId));
    const [job] = await jobsOf(x.itemId);
    const before = { jobState: 'BLOCKED', intents: (await intentsOf(job!.id)).length, jobs: 1 };
    const res = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body).toEqual({ status: 'BLOCKED', restored: true, mock: true, error: 'not_retryable', message: ITEM_MOCK_MSG });
    for (const w of LIVE_ONLY_WORDS) expect(body.message, w).not.toContain(w);
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?error=not_retryable_restored_mock`);
    await expectUntouched(x.itemId, before);
  });

  // 실제 계정 항목은 조건부 복구 길(채널에서 직접 확인해 게시물이 없을 때만 새 배포 계획) — details 는 그대로(mock 없음)
  it('실제 계정 · 작업에만 복원 표시(보류 작업): JSON 409 not_retryable + restored(정확한 조건부 문구, mock 없음) · 폼 → error=not_retryable_restored', async () => {
    const x = await blockedOnLiveAccount('복원 표시가 붙은 실제 계정 보류 작업 글.');
    const [job] = await jobsOf(x.itemId);
    await db.update(schema.jobs).set({ restoredNeedsReview: true }).where(eq(schema.jobs.id, job!.id));
    const before = { jobState: 'BLOCKED', intents: (await intentsOf(job!.id)).length, jobs: 1 };
    const res = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: 'BLOCKED', restored: true, error: 'not_retryable', message: JOB_MSG });
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?error=not_retryable_restored`);
    expect(location(await form('retry', x.itemId))).toBe(`/distribute/${x.planId}?error=not_retryable_restored`);
    expect(DISTRIBUTE_ERROR_TEXT.not_retryable_restored).toBe(FORM_MSG);
    await expectUntouched(x.itemId, before);
    expect((await tickPlan(x.planId)).leased).toBe(0);
  });

  it('실제 계정 · 복원 때 진행 중이던 항목(항목 표시, 보류): JSON 409 not_retryable + restored(정확한 조건부 문구, mock 없음) · 폼 → error=not_retryable_restored', async () => {
    const x = await blockedOnLiveAccount('복원 때 진행 중이던 실제 계정 항목 글.');
    await db.update(schema.distributionItems).set({ restoredNeedsReview: true }).where(eq(schema.distributionItems.id, x.itemId));
    const [job] = await jobsOf(x.itemId);
    const before = { jobState: 'BLOCKED', intents: (await intentsOf(job!.id)).length, jobs: 1 };
    const res = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: 'BLOCKED', restored: true, error: 'not_retryable', message: ITEM_MSG });
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?error=not_retryable_restored`);
    await expectUntouched(x.itemId, before);
  });

  it('그대로: 복원 표시 없는 거절은 일반 not_retryable(화면 문구도 그대로)', async () => {
    const x = await blocked('복원 표시 없는 보류 글.');
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?retried=1`);
    const again = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error: string; restored?: unknown; message: string };
    expect(body.error).toBe('not_retryable');
    expect(body.restored).toBeUndefined();
    expect(body.message).toBe('보류(BLOCKED)된 작업이 있는 항목만 재시도할 수 있습니다');
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?error=not_retryable`);
  });
});

/** 경로마다: 성공·오류 결과를 만드는 준비 */
const CASES: Array<{
  route: Route;
  /** 성공 결과를 만드는 항목(같은 항목에 한 번 더 보내면 오류가 될 수 있음) */
  ok: () => Promise<{ planId: string; itemId: string }>;
  okFields: Record<string, string>;
  okQuery: string;
  /** 오류(409·400) 결과 */
  bad: () => Promise<{ planId: string; itemId: string }>;
  badFields: Record<string, string>;
  badQuery: string;
}> = [
  {
    // 취소는 FIX4 S4 에서 이미 이 규칙 — 같은 lib itemFormBack 으로 옮긴 뒤에도 같은지(조회 실패 경로 포함) 함께 본다
    route: 'cancel',
    ok: () => planned('취소 폼 — 아직 보내지 않은 글.'),
    okFields: {},
    okQuery: 'canceled=1',
    bad: () => planned('취소 폼 — 실행 전 글.', { execute: false }),
    badFields: {},
    badQuery: 'error=not_cancellable',
  },
  {
    route: 'retry',
    ok: () => blocked('재시도 폼 글.'),
    okFields: {},
    okQuery: 'retried=1',
    bad: () => planned('재시도할 수 없는 대기 글.'),
    badFields: {},
    badQuery: 'error=not_retryable',
  },
  {
    route: 'reconcile',
    ok: () => reconciling('재확인 폼 글.'),
    okFields: {},
    okQuery: 'reconciled=not_found',
    bad: () => planned('재확인할 작업이 없는 대기 글.'),
    badFields: {},
    badQuery: 'error=nothing_to_reconcile',
  },
  {
    // 사용자 확인 성공(실제 Threads 계정)은 live-user-confirm.test.ts(FIX5-FULLREV(T4)) — 여기서는 모의 계정 거절(409)의 되돌아갈 곳
    route: 'user-confirm',
    ok: () => reconciling('사용자 확인 폼 — 모의 계정 글.'),
    okFields: { candidate_external_id: 'threads:18000000000999994' },
    okQuery: 'error=user_confirm_not_live',
    bad: () => reconciling('사용자 확인 폼 — 형식이 틀린 후보.'),
    badFields: { candidate_external_id: 'threads:abc' },
    badQuery: 'error=invalid',
  },
  {
    route: 'mock-scenario',
    ok: () => planned('모의 시나리오 폼 글.', { execute: false }),
    okFields: { scenario: 'success' },
    okQuery: 'scenario_saved=1',
    bad: () => planned('모의 시나리오 폼 — 모르는 값.', { execute: false }),
    badFields: { scenario: 'publish_for_real' },
    badQuery: 'error=invalid',
  },
];

describe('FIX5-FULLREV(T4): plan_id 없는 항목 폼 → 항목의 계획 화면(취소 경로와 같은 규칙)', () => {
  for (const c of CASES) {
    describe(c.route, () => {
      it(`plan_id 없음 → /distribute/<계획>?${c.okQuery} · 오류도 /distribute/<계획>?${c.badQuery} (owner 범위 조회 1회씩)`, async () => {
        const ok = await c.ok();
        expect(location(await form(c.route, ok.itemId, c.okFields))).toBe(`/distribute/${ok.planId}?${c.okQuery}`);
        const bad = await c.bad();
        expect(location(await form(c.route, bad.itemId, c.badFields))).toBe(`/distribute/${bad.planId}?${c.badQuery}`);
        expect(lookup.calls).toBe(2);
      });

      it('조회 실패(예외)·조회 결과 없음 → /distribute 그대로(성공·오류 모두) — 동작 자체는 같다', async () => {
        lookup.mode = 'throw';
        const ok = await c.ok();
        expect(location(await form(c.route, ok.itemId, c.okFields))).toBe(`/distribute?${c.okQuery}`);
        const bad = await c.bad();
        expect(location(await form(c.route, bad.itemId, c.badFields))).toBe(`/distribute?${c.badQuery}`);
        lookup.mode = 'null';
        const ok2 = await c.ok();
        expect(location(await form(c.route, ok2.itemId, c.okFields))).toBe(`/distribute?${c.okQuery}`);
        const bad2 = await c.bad();
        expect(location(await form(c.route, bad2.itemId, c.badFields))).toBe(`/distribute?${c.badQuery}`);
        expect(lookup.calls).toBe(4);
      });

      it('plan_id 가 있으면 지금처럼 그 값(조회하지 않음) · 없는 항목·형식이 틀린 ID → /distribute?missing=1 · CSRF → /distribute?error=csrf · 로그인 없음 → /login(조회 없음)', async () => {
        const ok = await c.ok();
        expect(location(await form(c.route, ok.itemId, { ...c.okFields, plan_id: ok.planId }))).toBe(`/distribute/${ok.planId}?${c.okQuery}`);
        const bad = await c.bad();
        expect(location(await form(c.route, bad.itemId, { ...c.badFields, plan_id: bad.planId }))).toBe(`/distribute/${bad.planId}?${c.badQuery}`);
        expect(lookup.calls).toBe(0);
        for (const id of [randomUUID(), 'not-a-uuid']) expect(location(await form(c.route, id, c.okFields)), id).toBe('/distribute?missing=1');
        lookup.calls = 0;
        expect(location(await form(c.route, bad.itemId, c.badFields, { origin: false }))).toBe('/distribute?error=csrf');
        expect(location(await form(c.route, bad.itemId, c.badFields, { cookie: false }))).toBe('/login');
        expect(lookup.calls).toBe(0);
      });
    });
  }

  it('retry: 조회 실패여도 재시도 동작은 같다(대기열에 다시 넣음 — 작업 1개, 같은 작업)', async () => {
    lookup.mode = 'throw';
    const x = await blocked('조회 실패 재시도 글.');
    const [before] = await jobsOf(x.itemId);
    expect(location(await form('retry', x.itemId))).toBe('/distribute?retried=1');
    const after = await jobsOf(x.itemId);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before!.id, state: 'QUEUED' });
  });
});

describe('FIX2-CODEX(U4 — FIX5 후속 검토, 사용자 결정 2026-10-23): 복원 때 결과 불명(UNKNOWN)이던 항목의 재시도 거절 — 모의 계정은 모의 문구 + mock, 실제 계정은 그대로(코드 outcome_unknown 그대로), 아무것도 바꾸지 않음', () => {
  const LIVE_UNKNOWN_MSG = '복원 전 전송 결과를 알 수 없어 다시 보내지 않습니다. 원격에서 결과를 확인하세요.';
  const UNKNOWN_MOCK_MSG = `MOCK — 복원 전 모의 전송 결과를 알 수 없어 다시 보내지 않습니다(자동 재전송 안 함). ${MOCK_TAIL}`;
  /** 폼 경로(코드 outcome_unknown)의 화면 문구 — 채널·원격을 말하지 않는 일반 문구라 모의·실제 모두에 맞다(모의 변형을 만들지 않음) */
  const FORM_UNKNOWN = '마지막 전송 결과를 알 수 없어 다시 보내지 않았습니다. 재확인을 먼저 하세요.';

  /**
   * 모의 결과 불명(보내지 않음) → RECONCILING 뒤, 복원 묶음에서 결과 불명으로 들어온 모양(항목 UNKNOWN + 복원 표시 · 작업 UNKNOWN + 복원 표시, lease 없음)으로 둔다.
   * live=true 면 이 시험만의 계정 행(기본 모의 계정과 같은 값)으로 만든 뒤 그 행을 실제 Threads 계정(시험 행 — 연결 정보 없음)으로 바꾼다(T2 의 blockedOnLiveAccount 와 같은 방식).
   */
  async function restoredUnknown(body: string, live: boolean) {
    let accountId: string | undefined;
    if (live) {
      const [base] = await db.select().from(schema.channelAccounts).where(eq(schema.channelAccounts.id, seedThreads));
      const [acc] = await db
        .insert(schema.channelAccounts)
        .values({
          ownerId: owner,
          platform: 'threads',
          kind: 'mock',
          externalAccountId: `mock:fix2-codex-${randomUUID()}`,
          displayName: 'FIX2-CODEX 시험 계정',
          state: base!.state,
          capabilitySnapshot: base!.capabilitySnapshot,
          credentialState: 'none',
        })
        .returning();
      accountId = acc!.id;
    }
    const x = await planned(body, { scenario: 'ambiguous_not_sent', accountId });
    await tickPlan(x.planId);
    const [job] = await jobsOf(x.itemId);
    expect(job!.state).toBe('RECONCILING');
    if (accountId) {
      await db
        .update(schema.channelAccounts)
        .set({ kind: 'live', externalAccountId: `fix2-codex-live-${randomUUID()}`, state: 'connected', credentialState: 'linked' })
        .where(eq(schema.channelAccounts.id, accountId));
    }
    await db.update(schema.jobs).set({ state: 'UNKNOWN', restoredNeedsReview: true, leaseOwner: null, leaseUntil: null }).where(eq(schema.jobs.id, job!.id));
    await db.update(schema.distributionItems).set({ status: 'UNKNOWN', restoredNeedsReview: true }).where(eq(schema.distributionItems.id, x.itemId));
    return { ...x, jobId: job!.id, intents: (await intentsOf(job!.id)).length };
  }
  async function expectUntouched(x: { itemId: string; jobId: string; intents: number }) {
    const js = await jobsOf(x.itemId);
    expect(js.map((j) => [j.id, j.state, j.restoredNeedsReview])).toEqual([[x.jobId, 'UNKNOWN', true]]);
    expect(await intentsOf(x.jobId)).toHaveLength(x.intents);
    expect(await itemOf(x.itemId)).toMatchObject({ status: 'UNKNOWN', restoredNeedsReview: true });
  }

  it('모의 계정: JSON 409 outcome_unknown + restored + mock(정확한 모의 문구 — 원격·채널 확인을 시키지 않음) · 폼(plan_id 있음·없음) → error=outcome_unknown(일반 문구 그대로)', async () => {
    const x = await restoredUnknown('복원 때 결과 불명이던 모의 항목 글.', false);
    const res = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { message: string };
    expect(body).toEqual({ status: 'UNKNOWN', restored: true, mock: true, error: 'outcome_unknown', message: UNKNOWN_MOCK_MSG });
    for (const w of [...LIVE_ONLY_WORDS, '원격에서', '결과를 확인하세요']) expect(body.message, w).not.toContain(w);
    expect(body.message.startsWith('MOCK — ')).toBe(true);
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?error=outcome_unknown`);
    expect(location(await form('retry', x.itemId))).toBe(`/distribute/${x.planId}?error=outcome_unknown`);
    expect(DISTRIBUTE_ERROR_TEXT.outcome_unknown).toBe(FORM_UNKNOWN);
    for (const w of ['채널', 'Threads', '원격', '새 배포 계획', 'MOCK']) expect(DISTRIBUTE_ERROR_TEXT.outcome_unknown, w).not.toContain(w);
    await expectUntouched(x);
    expect((await tickPlan(x.planId)).leased).toBe(0);
    await expectUntouched(x);
  });

  it('실제 계정: JSON 409 outcome_unknown + restored(지금 문구 그대로, mock 없음) · 폼 → error=outcome_unknown — 외부 호출 0', async () => {
    const x = await restoredUnknown('복원 때 결과 불명이던 실제 계정 항목 글.', true);
    const res = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ status: 'UNKNOWN', restored: true, error: 'outcome_unknown', message: LIVE_UNKNOWN_MSG });
    expect(location(await form('retry', x.itemId, { plan_id: x.planId }))).toBe(`/distribute/${x.planId}?error=outcome_unknown`);
    expect(location(await form('retry', x.itemId))).toBe(`/distribute/${x.planId}?error=outcome_unknown`);
    await expectUntouched(x);
    expect(fetchCalls).toBe(0);
  });

  it('그대로: 같은 모의 항목이라도 복원 때 결과 불명이 아닌(보류) 항목은 T2 후속의 not_retryable 모의 문구, 작업에만 복원 표시면 작업 문구', async () => {
    const x = await restoredUnknown('복원 표시가 붙은 모의 항목 — 상태만 BLOCKED 로.', false);
    await db.update(schema.distributionItems).set({ status: 'BLOCKED' }).where(eq(schema.distributionItems.id, x.itemId));
    const item = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(await item.json()).toEqual({ status: 'BLOCKED', restored: true, mock: true, error: 'not_retryable', message: ITEM_MOCK_MSG });
    await db.update(schema.distributionItems).set({ status: 'UNKNOWN', restoredNeedsReview: false }).where(eq(schema.distributionItems.id, x.itemId));
    const job = await retryPOST(post(`/api/distribution-items/${x.itemId}/retry`), ctx(x.itemId));
    expect(await job.json()).toEqual({ status: 'UNKNOWN', restored: true, mock: true, error: 'not_retryable', message: JOB_MOCK_MSG });
  });
});
