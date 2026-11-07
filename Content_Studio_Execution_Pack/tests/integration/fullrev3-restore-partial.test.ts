/**
 * FIX1-FULLREV3(H3, 검토 기록 docs/handoffs/FULLREV3_CLAUDE_REVIEW.md, 결정 D41):
 * 복원(add_missing)이 이 환경의 기존 승인을 무효로 할 때(브랜드 새 버전 — invalidated:brand_changed, '확인 필요' 소재 연결 — invalidated:risk_needs_check),
 * 이미 일부가 게시된 작업은 실행 전(PLANNED)이 아니라 UNKNOWN(thread_partial_revoked)이 된다. 미리보기·결과의 invalidated_approvals 는 그 작업을
 * partial_job_ids 로 보고하고(전에는 버렸다), 복원 화면은 "실행 전으로 — 다시 계획·승인"과 따로 "결과 불명(UNKNOWN) — 다시 게시하지 않음, 직접 확인"을 안내한다.
 * FIX1-FULLREV3(H2) 와 함께: 위험 표시 경로는 진행 중 항목(REMOTE_PROCESSING)의 승인도 무효로 하고(in_flight — 작업·항목 상태 그대로) 화면이 따로 안내한다.
 * 옛 미리보기·결과(partial_job_ids·in_flight 칸 없음)는 지금까지 문구 그대로 보인다(apps/web/lib/restore-view.test.ts).
 * 모의 Threads 만(T13 모의 OAuth 연결) — **네트워크 호출 0**(fetch 0 확인). 화면은 실제 화면 컴포넌트를 실제 DB 로 렌더한다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, desc, eq } from 'drizzle-orm';
import {
  closeDb,
  commitRestore,
  createBrandProfileVersion,
  createCapture,
  createContent,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  exportOwner,
  getDb,
  leaseJobs,
  linkContentCaptures,
  runJobsTick,
  schema,
  seed,
  setVariantLifecycle,
  type Db,
} from '@cs/db';
import { loadConfig, type AdapterResult, type ReconcileResult } from '@cs/domain';
import { createMockAdapterRegistry, LocalStorageAdapter, THREADS_PROVISIONAL_RATE_LIMIT } from '@cs/providers';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { PATCH as capturePATCH } from '../../apps/web/app/api/captures/[id]/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as executePOST } from '../../apps/web/app/api/distribution-plans/[id]/execute/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as mockAuthorizeGET } from '../../apps/web/app/api/oauth/mock-threads/authorize/route';
import { jobCredentials } from '../../apps/web/lib/oauth';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const h = vi.hoisted(() => ({ token: '' }));
vi.mock('../../apps/web/lib/auth', async () => {
  const session = await import('../../apps/web/lib/session');
  const server = await import('../../apps/web/lib/server');
  return {
    requireOwner: session.requireOwner,
    validateSessionCookie: session.validateSessionCookie,
    validateSessionToken: session.validateSessionToken,
    getSession: async () => {
      if (!h.token) return null;
      const config = server.getConfig();
      const { db: appDb } = await server.getAppDb(config);
      return session.validateSessionToken(appDb, h.token, config);
    },
  };
});

type PageFn = (props: { params?: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
const { renderToStaticMarkup } = createRequire(path.resolve(import.meta.dirname, '../../apps/web/package.json'))('react-dom/server') as { renderToStaticMarkup: (el: unknown) => string };
const RestorePage = ((await import(/* @vite-ignore */ path.resolve(import.meta.dirname, '../../apps/web/app', 'settings/restores/[id]/page.tsx'))) as { default: PageFn }).default;

const A = 'owner-h3@example.local';
const KEY = randomBytes(32).toString('base64');
const MIN = 60_000;
const config = loadConfig({});
const registry = createMockAdapterRegistry();
const api = registry.threads.api;
const BRAND = { pen_name: '복원 필명', audience: '해외 영업 실무자', pillars: ['해외 영업'], style_rules: [], tone: 'formal' as const, avoid_phrases: [], cta_rules: [], sample_texts: [] };
const THREE = ['첫째 — 주문 주기를 먼저 맞췄다.', '둘째 — 재고 표는 주마다 갱신했다.', '셋째 — 가격 조정은 분기마다 했다.'];

let db: Db;
let owner: string;
let tmp: string;
let vt = 0;
let fetchCalls = 0;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(h.token));

async function linkedThreadsAccount(): Promise<{ id: string; external: string }> {
  const external = `mock:threads:${randomUUID()}`;
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform: 'threads', kind: 'mock', externalAccountId: external, displayName: 'MOCK Threads H3', state: 'mock_ready' })
    .returning();
  const c = await connectPOST(post(`/api/channel-accounts/${row!.id}/connect`), ctx(row!.id));
  expect(c.status).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  const a = await mockAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(h.token) } }));
  expect(a.status).toBe(303);
  const cb = await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(h.token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  return { id: row!.id, external };
}

interface Planned {
  planId: string;
  item: { id: string; payload_hash: string };
  contentId: string;
}
async function executed(accountId: string, body: string): Promise<Planned> {
  const { content } = await createContent(db, owner, { title: `H3 ${randomUUID().slice(0, 6)}`, body });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  const res = await plansPOST(post('/api/distribution-plans', { items: [{ variant_id: variant.id, channel_account_id: accountId }] }));
  expect(res.status, await res.clone().text()).toBe(201);
  const p = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; payload_hash: string }> };
  const item = p.items[0]!;
  const ap = await approvePOST(
    post(`/api/distribution-plans/${p.plan.id}/approve`, { item_ids: [item.id], expected_hashes: { [item.id]: item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
    ctx(p.plan.id),
  );
  expect(ap.status, await ap.clone().text()).toBe(200);
  const ex = await executePOST(post(`/api/distribution-plans/${p.plan.id}/execute`, { command_key: `k-${randomUUID()}` }), ctx(p.plan.id));
  expect(ex.status, await ex.clone().text()).toBe(200);
  return { planId: p.plan.id, item, contentId: content.id };
}

async function tick(planId: string, advanceMs = 0) {
  vt += advanceMs;
  return runJobsTick(db, registry, {
    workerId: 'h3-w',
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
const approvalsOf = (itemId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId));

/** fullrev2-final-failure partialThread 와 같은 모양: 3개짜리 스레드 → 2개 게시 뒤 429 → RETRY_WAIT(게시 2) */
async function partialThread() {
  const acc = await linkedThreadsAccount();
  const p = await executed(acc.id, THREE.join('\n\n'));
  api.setRateBudget(acc.external, 2, 60);
  try {
    expect((await tick(p.planId)).results).toEqual({ RETRY_WAIT: 1 });
  } finally {
    api.clearRateBudget(acc.external);
  }
  const [job] = await jobsOf(p.item.id);
  expect(job).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'rate_limited', attempt: 1 });
  expect(api.postsOf(acc.external)).toHaveLength(2);
  return { acc, ...p, jobId: job!.id };
}
/** 대기(QUEUED) 항목 — 아직 보내지 않음 */
async function queued() {
  const acc = await linkedThreadsAccount();
  const p = await executed(acc.id, `해외 영업 대기 글 ${randomUUID().slice(0, 6)}`);
  const [job] = await jobsOf(p.item.id);
  expect(job!.state).toBe('QUEUED');
  return { acc, ...p, jobId: job!.id };
}
/** 원격 처리 중(REMOTE_PROCESSING) 항목 — 게시 0 */
async function remoteProcessing() {
  const acc = await linkedThreadsAccount();
  const p = await executed(acc.id, `해외 영업 원격 처리 중 글 ${randomUUID().slice(0, 6)}`);
  const processing: AdapterResult = { status: 'processing', error_code: 'container_in_progress' };
  const submit = vi.spyOn(registry.threads, 'submit').mockResolvedValueOnce(processing);
  try {
    expect((await tick(p.planId)).results).toEqual({ REMOTE_PROCESSING: 1 });
  } finally {
    submit.mockRestore();
  }
  const [job] = await jobsOf(p.item.id);
  return { acc, ...p, jobId: job!.id };
}

// ---- 복원: 이 환경(앱 DB) → 다른 DB(원본 묶음 만들기) → 다시 이 환경에 add_missing ----
const assets = () => new LocalStorageAdapter(path.join(tmp, 'assets'));
async function exportZip(source: Db, ownerId: string, storage: LocalStorageAdapter, tag: string): Promise<Uint8Array> {
  const ex = await exportOwner(source, storage, ownerId, { outDir: path.join(tmp, `exports-${tag}`) });
  return new Uint8Array(readFileSync(ex.zipPath));
}
/** 이 환경 전체를 새 DB 로 복원한 원본(같은 ID) — 원본에서 바꾼 뒤 다시 내보내 이 환경에 add_missing 한다 */
async function mirror(tag: string) {
  const b = await createTestDb();
  const src = (await ensureOwner(b.db, `fr3-h3-src-${tag}@example.local`)).id;
  const srcStore = new LocalStorageAdapter(path.join(tmp, `assets-src-${tag}`));
  const zip = await exportZip(db, owner, assets(), `${tag}-out`);
  const p = await createRestorePreview(b.db, src, zip, { restoresDir: path.join(tmp, `restores-src-${tag}`), source: 'upload' });
  await commitRestore(b.db, srcStore, src, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir: path.join(tmp, `restores-src-${tag}`) });
  return { b, src, srcStore };
}
const restoresDir = path.join(tmpdir(), `cs-fr3-h3-restores-${randomUUID().slice(0, 6)}`);

const textOf = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const renderRestore = async (id: string) => renderToStaticMarkup(await RestorePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
const noticeOf = (html: string, testid: string) => {
  const m = new RegExp(`<p[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</p>`).exec(html);
  return m ? textOf(m[1]!) : null;
};
const byItem = <T extends { item_id: string }>(xs: readonly T[]) => [...xs].sort((a, b) => a.item_id.localeCompare(b.item_id));

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr3-h3-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('FR3 H3 시험: 네트워크 호출 금지');
  });
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  h.token = await login(A);
});
beforeEach(() => {
  registry.threads.rateLimit = { ...THREADS_PROVISIONAL_RATE_LIMIT };
});
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(restoresDir, { recursive: true, force: true });
  await closeDb();
});

describe('FIX1-FULLREV3(H3): 복원이 무효로 한 승인 중 부분 게시 작업은 partial_job_ids 로 보고하고 화면이 따로 안내한다', () => {
  it('FIX1-FULLREV3(H3 후속) 브랜드 새 버전(add_missing): lease 된(보내기 전) 부분 게시 작업 → leased_partial_job_ids·항목 RETRY_WAIT 그대로(PLANNED 아님) · 화면이 "실행 전으로"로 세지 않고 따로 안내 · 다음 전송은 UNKNOWN, 다시 게시 0', async () => {
    const pt = await partialThread();
    vt += 2 * MIN;
    const leased = await leaseJobs(db, { workerId: 'h3-lease', now: new Date(Date.now() + vt), limit: 1, ownerId: owner, planId: pt.planId });
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({ id: pt.jobId, state: 'LEASED' });
    expect((await itemOf(pt.item.id)).status).toBe('RETRY_WAIT');
    const tag = randomUUID().slice(0, 6);
    const m = await mirror(tag);
    try {
      const brands = await m.b.db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, m.src)).orderBy(desc(schema.brandProfiles.version));
      await createBrandProfileVersion(m.b.db, m.src, { base_version: brands[0]!.version, ...BRAND, pen_name: '복원 필명 lease 버전' });
      const zip = await exportZip(m.b.db, m.src, m.srcStore, `${tag}-back`);
      const approvalId = (await approvalsOf(pt.item.id))[0]!.id;
      const expected = [{ approval_id: approvalId, item_id: pt.item.id, reasons: ['brand_changed'], blocked_job_ids: [], partial_job_ids: [], leased_partial_job_ids: [pt.jobId], in_flight: false, restored_review: false }]; // FIX2-FULLREV3(K2): restored_review 도 정확히
      const p = await createRestorePreview(db, owner, zip, { restoresDir, source: 'upload' });
      expect(p.preview.invalidated_approvals.filter((e) => e.item_id === pt.item.id)).toEqual(expected);
      const pv = await renderRestore(p.restoreId);
      expect(noticeOf(pv, 'restore-leased-partial')).toContain('무효가 될 승인 중 1건은 보내기 직전인 작업에 이미 일부가 게시됐거나 게시 시도가 있어, 항목을 실행 전으로 되돌리지 않습니다');

      const r = await commitRestore(db, assets(), owner, p.restoreId, { mode: 'add_missing', confirm: true, restoresDir });
      const mine = r.invalidated_approvals.filter((e) => e.item_id === pt.item.id);
      expect(mine).toEqual(expected);
      // 작업은 LEASED 그대로, 항목은 실행 전(PLANNED)으로 가지 않는다
      expect((await jobsOf(pt.item.id))[0]).toMatchObject({ id: pt.jobId, state: 'LEASED' });
      expect((await itemOf(pt.item.id)).status).toBe('RETRY_WAIT');
      expect((await approvalsOf(pt.item.id))[0]!.revokeReason).toBe('invalidated:brand_changed');

      const cv = await renderRestore(p.restoreId);
      const leasedText = noticeOf(cv, 'restore-leased-partial')!;
      expect(leasedText).toContain('무효가 된 승인 중 1건은 보내기 직전이던 작업에 이미 일부가 게시됐거나 게시 시도가 있어, 항목을 실행 전으로 되돌리지 않았습니다');
      expect(leasedText).toContain('다시 보내지 않고 결과 불명(UNKNOWN)으로 정해집니다');
      // 브랜드 안내가 이 항목을 "실행 전으로"로 세지 않는다(다른 항목이 같은 복원에 섞여도 이 항목은 빠진다)
      const all = r.invalidated_approvals.filter((e) => e.reasons.includes('brand_changed'));
      const plannedOthers = all.filter((e) => !(e.partial_job_ids ?? []).length && !(e.leased_partial_job_ids ?? []).length && !e.in_flight).length;
      const brandText = noticeOf(cv, 'restore-brand-invalidated')!;
      if (plannedOthers === 0) expect(brandText).not.toContain('실행 전으로');
      else expect(brandText).toContain(`그중 ${plannedOthers}건은`);
    } finally {
      await m.b.close();
    }
    // 작업 처리기가 lease 뒤 죽음 → 만료 복구 → 보내기 직전 재검사가 보내지 않고 UNKNOWN
    await tick(pt.planId, 20 * MIN);
    await tick(pt.planId, 20 * MIN);
    const [job] = await jobsOf(pt.item.id);
    expect(job).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked' });
    expect((await itemOf(pt.item.id)).status).toBe('UNKNOWN');
    expect(api.postsOf(pt.acc.external)).toHaveLength(2);
    expect(await jobsOf(pt.item.id)).toHaveLength(1);
  });

  it('브랜드 새 버전(add_missing): 부분 게시 RETRY_WAIT 항목 → UNKNOWN(thread_partial_revoked)·partial_job_ids, 대기 항목 → PLANNED·blocked_job_ids · 미리보기=결과 · 화면: "실행 전으로"는 1건만, UNKNOWN 안내 따로 · 다시 게시 0', async () => {
    const pt = await partialThread();
    const q = await queued();
    const tag = randomUUID().slice(0, 6);
    const m = await mirror(tag);
    try {
      const brands = await m.b.db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, m.src)).orderBy(desc(schema.brandProfiles.version));
      await createBrandProfileVersion(m.b.db, m.src, { base_version: brands[0]!.version, ...BRAND, pen_name: '복원 필명 새 버전' });
      const zip = await exportZip(m.b.db, m.src, m.srcStore, `${tag}-back`);

      const expected = byItem([
        { approval_id: (await approvalsOf(pt.item.id))[0]!.id, item_id: pt.item.id, reasons: ['brand_changed'], blocked_job_ids: [], partial_job_ids: [pt.jobId], leased_partial_job_ids: [], in_flight: false, restored_review: false },
        { approval_id: (await approvalsOf(q.item.id))[0]!.id, item_id: q.item.id, reasons: ['brand_changed'], blocked_job_ids: [q.jobId], partial_job_ids: [], leased_partial_job_ids: [], in_flight: false, restored_review: false },
      ]);
      const p = await createRestorePreview(db, owner, zip, { restoresDir, source: 'upload' });
      expect(p.preview.tables.brand_profiles).toMatchObject({ new: 1 });
      expect(byItem(p.preview.invalidated_approvals)).toEqual(expected);
      // 미리보기는 아무것도 바꾸지 않는다
      expect((await jobsOf(pt.item.id))[0]!.state).toBe('RETRY_WAIT');
      expect((await itemOf(q.item.id)).status).toBe('QUEUED');
      // 미리보기 화면: UNKNOWN 안내 따로, "실행 전으로"는 대기 항목 1건만
      const pv = await renderRestore(p.restoreId);
      expect(noticeOf(pv, 'restore-brand-invalidated')).toBe(
        '복원하면 브랜드 프로필 새 버전이 들어와, 이 환경에 있는 승인 2건이 무효가 됩니다. 그중 1건은 대기 중인 실행을 보류하고 항목을 실행 전으로 돌립니다.',
      );
      const pvPartial = noticeOf(pv, 'restore-partial-unknown')!;
      expect(pvPartial).toContain('무효가 될 승인 중 1건은 이미 일부가 게시됐거나 게시 시도가 있었던 작업이라');
      expect(pvPartial).toContain('결과 불명(UNKNOWN)으로 둡니다');
      expect(pvPartial).toContain('다시 승인·실행으로 처음부터 다시 보내지 않습니다');
      expect(pvPartial).toContain('Threads 등 게시 채널에서 직접 확인');
      expect(noticeOf(pv, 'restore-inflight-invalidated')).toBeNull();

      const r = await commitRestore(db, assets(), owner, p.restoreId, { mode: 'add_missing', confirm: true, restoresDir });
      expect(byItem(r.invalidated_approvals)).toEqual(expected);
      // 부분 게시 항목: 실행 전으로 가지 않고 UNKNOWN
      const [pj] = await jobsOf(pt.item.id);
      expect(pj).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked', cancelRequestedAt: null });
      expect((await itemOf(pt.item.id)).status).toBe('UNKNOWN');
      expect((await approvalsOf(pt.item.id))[0]!.revokeReason).toBe('invalidated:brand_changed');
      // 대기 항목: 지금 규칙 그대로
      expect((await jobsOf(q.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_invalidated' });
      expect((await itemOf(q.item.id)).status).toBe('PLANNED');

      const cv = await renderRestore(p.restoreId);
      const brandText = noticeOf(cv, 'restore-brand-invalidated')!;
      expect(brandText).toBe(
        '복원으로 브랜드 프로필 새 버전이 들어와, 이 환경에 있던 승인 2건을 무효로 했습니다. 그중 1건은 대기 중이던 실행을 보류하고 항목을 실행 전으로 돌렸습니다 — 배포 계획에서 새 브랜드로 다시 계획·승인하세요.',
      );
      expect(brandText).not.toContain('(대기 중이던 실행은 보류, 항목은 실행 전으로)');
      const cvPartial = noticeOf(cv, 'restore-partial-unknown')!;
      expect(cvPartial).toContain('무효가 된 승인 중 1건은 이미 일부가 게시됐거나 게시 시도가 있었던 작업이라, 남은 게시물을 보내지 않고 결과 불명(UNKNOWN)으로 두었습니다');
      expect(cvPartial).toContain('실행 전으로 되돌리지 않으므로');
      expect(cvPartial).toContain('Threads 등 게시 채널에서 직접 확인');

      // 다시 게시하지 않는다
      await tick(pt.planId, 20 * MIN);
      await tick(pt.planId, 20 * MIN);
      expect(api.postsOf(pt.acc.external)).toHaveLength(2);
      expect(await jobsOf(pt.item.id)).toHaveLength(1);
    } finally {
      await m.b.close();
    }
  });

  it("'확인 필요' 소재 연결(add_missing): 부분 게시 → partial_job_ids·UNKNOWN, 원격 처리 중 → in_flight(작업·항목 그대로, H2), 대기 → PLANNED · 화면 세 안내 · 해제 뒤 재개도 approval_missing", async () => {
    const pt = await partialThread();
    const rp = await remoteProcessing();
    const q = await queued();
    const tag = randomUUID().slice(0, 6);
    const m = await mirror(tag);
    let captureId: string;
    try {
      const { capture } = await createCapture(m.b.db, m.src, { input_type: 'text', raw_text: `복원 위험 소재 ${tag}`, command_key: `h3-${tag}` });
      captureId = capture.id;
      await m.b.db.update(schema.captures).set({ risk: 'needs_check' }).where(eq(schema.captures.id, capture.id));
      for (const x of [pt, rp, q]) await linkContentCaptures(m.b.db, m.src, x.contentId, [capture.id]);
      const zip = await exportZip(m.b.db, m.src, m.srcStore, `${tag}-back`);

      const expected = byItem([
        { approval_id: (await approvalsOf(pt.item.id))[0]!.id, item_id: pt.item.id, reasons: ['risk_needs_check'], blocked_job_ids: [], partial_job_ids: [pt.jobId], leased_partial_job_ids: [], in_flight: false, restored_review: false },
        { approval_id: (await approvalsOf(rp.item.id))[0]!.id, item_id: rp.item.id, reasons: ['risk_needs_check'], blocked_job_ids: [], partial_job_ids: [], leased_partial_job_ids: [], in_flight: true, restored_review: false },
        { approval_id: (await approvalsOf(q.item.id))[0]!.id, item_id: q.item.id, reasons: ['risk_needs_check'], blocked_job_ids: [q.jobId], partial_job_ids: [], leased_partial_job_ids: [], in_flight: false, restored_review: false },
      ]);
      const p = await createRestorePreview(db, owner, zip, { restoresDir, source: 'upload' });
      expect(p.preview.tables.content_captures).toMatchObject({ new: 3 });
      expect(byItem(p.preview.invalidated_approvals)).toEqual(expected);
      const pv = await renderRestore(p.restoreId);
      expect(noticeOf(pv, 'restore-risk-invalidated')).toBe(
        "복원하면 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 3건이 무효가 됩니다. 그중 1건은 대기 중인 실행을 보류하고 항목을 실행 전으로 돌립니다.",
      );
      expect(noticeOf(pv, 'restore-partial-unknown')).toContain('무효가 될 승인 중 1건은 이미 일부가 게시됐거나');
      expect(noticeOf(pv, 'restore-inflight-invalidated')).toBe(
        '무효가 될 승인 중 1건은 전송 중인 항목이라 지금 시도는 결과를 그대로 기록하고, 다음 전송(재개·재시도)은 보내지 않고 멈춥니다(다시 승인 필요).',
      );

      const r = await commitRestore(db, assets(), owner, p.restoreId, { mode: 'add_missing', confirm: true, restoresDir });
      expect(byItem(r.invalidated_approvals)).toEqual(expected);
      expect((await jobsOf(pt.item.id))[0]).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'thread_partial_revoked' });
      expect((await itemOf(pt.item.id)).status).toBe('UNKNOWN');
      expect((await jobsOf(rp.item.id))[0]).toMatchObject({ state: 'REMOTE_PROCESSING', cancelRequestedAt: null });
      expect((await itemOf(rp.item.id)).status).toBe('REMOTE_PROCESSING');
      expect((await approvalsOf(rp.item.id))[0]!.revokeReason).toBe('invalidated:risk_needs_check');
      expect((await itemOf(q.item.id)).status).toBe('PLANNED');

      const cv = await renderRestore(p.restoreId);
      const riskText = noticeOf(cv, 'restore-risk-invalidated')!;
      expect(riskText).toBe(
        "복원으로 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 3건을 무효로 했습니다. 그중 1건은 대기 중이던 실행을 보류하고 항목을 실행 전으로 돌렸습니다 — 소재의 '확인 필요'를 해제한 뒤 다시 승인하세요.",
      );
      expect(noticeOf(cv, 'restore-partial-unknown')).toContain('결과 불명(UNKNOWN)으로 두었습니다');
      expect(noticeOf(cv, 'restore-inflight-invalidated')).toContain('무효가 된 승인 중 1건은 전송 중이던 항목이라 지금 시도는 결과를 그대로 기록합니다');
      expect(noticeOf(cv, 'restore-brand-invalidated')).toBeNull();
    } finally {
      await m.b.close();
    }

    // 이 환경에서 소재 '확인 필요'를 해제해도(승인 되살아나지 않음) 원격 처리 중이던 항목은 재개 뒤 보내지 않는다
    const rev = (await db.select().from(schema.captures).where(eq(schema.captures.id, captureId)))[0]!.revision;
    const cr = await capturePATCH(
      new Request(`${BASE}/api/captures/${captureId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(h.token) },
        body: JSON.stringify({ expected_revision: rev, risk: 'none' }),
      }),
      ctx(captureId),
    );
    expect(cr.status, await cr.clone().text()).toBe(200);
    const resumable: ReconcileResult = { status: 'resumable', published_parts: 0, error_code: 'container_not_published' };
    const spy = vi.spyOn(registry.threads, 'reconcile').mockResolvedValueOnce(resumable);
    try {
      expect((await tick(rp.planId, 16_000)).results).toEqual({ RETRY_WAIT: 1 });
    } finally {
      spy.mockRestore();
    }
    expect((await tick(rp.planId, 1000)).results).toEqual({ BLOCKED: 1 });
    expect((await jobsOf(rp.item.id))[0]).toMatchObject({ state: 'BLOCKED', lastErrorCode: 'approval_missing' });
    expect((await itemOf(rp.item.id)).status).toBe('PLANNED');
    expect(api.postsOf(rp.acc.external)).toHaveLength(0);
    await tick(pt.planId, 20 * MIN);
    expect(api.postsOf(pt.acc.external)).toHaveLength(2);
  });
});

// FIX2-FULLREV3(K2): 이전 복원이 대기 항목을 BLOCKED + restored_needs_review 로 넣은 뒤(활성 승인 남음) 다음 복원이 브랜드 새 버전·'확인 필요' 소재 연결로
// 그 승인을 무효로 하면, 항목은 BLOCKED 그대로다(revokeActiveApprovalsLocked 의 toPlanned 에서 빠짐 — 다시 승인하면 409 item_not_planned).
// 예전에는 보고 줄에 구분 칸이 없어 화면이 "실행 전으로 … 다시 계획·승인"으로 셌다. 이제 restored_review=true 로 보고하고 따로 안내한다.
// 상태 만들기: 실제 첫 복원으로 "활성 승인이 남은 BLOCKED + 복원 표시" 항목을 만들려면 복원 재검사(snapshotProblems — 연결 정보가 묶음 밖이라 계정이
// needs_reconnect)가 승인을 restore_stale 로 철회해 버려 실제 진입점만으로는 만들기 어렵다. 그래서 대기(QUEUED) 항목을 실제 경로로 만든 뒤
// 복원이 남기는 모양(항목·작업 BLOCKED + restored_needs_review)으로 DB 를 직접 바꾼다(live-threads-publish 등 기존 시험과 같은 방식).
describe('FIX2-FULLREV3(K2): 이전 복원 확인 표시로 보류된 항목의 승인을 복원이 무효로 하면 restored_review 로 보고하고 "실행 전으로"로 세지 않는다', () => {
  async function restoredBlocked() {
    const q = await queued();
    await db.update(schema.distributionItems).set({ status: 'BLOCKED', restoredNeedsReview: true }).where(eq(schema.distributionItems.id, q.item.id));
    await db.update(schema.jobs).set({ state: 'BLOCKED', restoredNeedsReview: true }).where(eq(schema.jobs.id, q.jobId));
    expect(await approvalsOf(q.item.id)).toEqual([expect.objectContaining({ revokedAt: null })]);
    return q;
  }
  it.each([
    ['brand_changed', 'restore-brand-invalidated'],
    ['risk_needs_check', 'restore-risk-invalidated'],
  ] as const)('%s: 보류(BLOCKED+복원 표시) 항목 → restored_review=true·항목/작업 BLOCKED 그대로·다시 승인 409 item_not_planned · 대기 항목은 실행 전으로 · 화면 안내 따로', async (reason, reasonTestid) => {
    const rr = await restoredBlocked();
    const q = await queued();
    const tag = randomUUID().slice(0, 6);
    const m = await mirror(tag);
    try {
      if (reason === 'brand_changed') {
        const brands = await m.b.db.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, m.src)).orderBy(desc(schema.brandProfiles.version));
        await createBrandProfileVersion(m.b.db, m.src, { base_version: brands[0]!.version, ...BRAND, pen_name: `복원 필명 K2 ${tag}` });
      } else {
        const { capture } = await createCapture(m.b.db, m.src, { input_type: 'text', raw_text: `복원 위험 소재 K2 ${tag}`, command_key: `k2-${tag}` });
        await m.b.db.update(schema.captures).set({ risk: 'needs_check' }).where(eq(schema.captures.id, capture.id));
        for (const x of [rr, q]) await linkContentCaptures(m.b.db, m.src, x.contentId, [capture.id]);
      }
      const zip = await exportZip(m.b.db, m.src, m.srcStore, `${tag}-back`);
      const expected = byItem([
        {
          approval_id: (await approvalsOf(rr.item.id))[0]!.id,
          item_id: rr.item.id,
          reasons: [reason],
          blocked_job_ids: [],
          partial_job_ids: [],
          leased_partial_job_ids: [],
          in_flight: false,
          restored_review: true,
        },
        {
          approval_id: (await approvalsOf(q.item.id))[0]!.id,
          item_id: q.item.id,
          reasons: [reason],
          blocked_job_ids: [q.jobId],
          partial_job_ids: [],
          leased_partial_job_ids: [],
          in_flight: false,
          restored_review: false,
        },
      ]);
      const mineOf = <T extends { item_id: string }>(xs: readonly T[]) => byItem(xs.filter((e) => e.item_id === rr.item.id || e.item_id === q.item.id));
      const p = await createRestorePreview(db, owner, zip, { restoresDir, source: 'upload' });
      expect(mineOf(p.preview.invalidated_approvals)).toEqual(expected);
      expect((await itemOf(rr.item.id)).status).toBe('BLOCKED');
      const pv = await renderRestore(p.restoreId);
      expect(noticeOf(pv, 'restore-restored-review')).toContain('무효가 될 승인 중');
      expect(noticeOf(pv, 'restore-restored-review')).toContain('이전 복원에서 확인이 필요한 보류 항목이라 실행 전으로 돌리지 않습니다');

      const r = await commitRestore(db, assets(), owner, p.restoreId, { mode: 'add_missing', confirm: true, restoresDir });
      expect(mineOf(r.invalidated_approvals)).toEqual(expected);
      // 보류 항목: 승인은 철회, 항목·작업은 BLOCKED 그대로(실행 전으로 가지 않음)
      expect((await itemOf(rr.item.id))).toMatchObject({ status: 'BLOCKED', restoredNeedsReview: true });
      expect((await jobsOf(rr.item.id))[0]).toMatchObject({ id: rr.jobId, state: 'BLOCKED' });
      expect((await approvalsOf(rr.item.id))[0]!.revokeReason).toBe(`invalidated:${reason}`);
      // 대기 항목: 지금 규칙 그대로
      expect((await itemOf(q.item.id)).status).toBe('PLANNED');
      // 화면이 말한 대로 다시 승인할 수 없다(실행 전이 아니다)
      const again = await approvePOST(
        post(`/api/distribution-plans/${rr.planId}/approve`, { item_ids: [rr.item.id], expected_hashes: { [rr.item.id]: rr.item.payload_hash }, confirm: true, purpose: 'mock_publish' }),
        ctx(rr.planId),
      );
      expect(again.status).toBe(409);
      expect((await again.json()).error).toBe('item_not_planned');

      const cv = await renderRestore(p.restoreId);
      const rrText = noticeOf(cv, 'restore-restored-review')!;
      const all = r.invalidated_approvals.filter((e) => e.reasons.includes(reason));
      const rrCount = all.filter((e) => e.restored_review).length;
      expect(rrCount).toBe(1);
      expect(rrText).toBe(
        '무효가 된 승인 중 1건은 이전 복원에서 확인이 필요한 보류 항목이라 실행 전으로 돌리지 않았습니다(그대로 보류 — 다시 승인할 수 없음). 채널에서 이 계정의 최근 게시물을 직접 확인하세요 — 있으면 그대로 두고, 직접 확인해 게시물이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 내용이 두 번 올라갈 수 있습니다).',
      );
      // 사유 안내의 "실행 전으로" 수는 보류 항목을 빼고 센다
      const plannedCount = all.filter((e) => !(e.partial_job_ids ?? []).length && !(e.leased_partial_job_ids ?? []).length && !e.in_flight && !e.restored_review).length;
      expect(plannedCount).toBeGreaterThanOrEqual(1);
      expect(noticeOf(cv, reasonTestid)).toContain(`그중 ${plannedCount}건은 대기 중이던 실행을 보류하고 항목을 실행 전으로 돌렸습니다`);
    } finally {
      await m.b.close();
    }
  });
});
