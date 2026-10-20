/**
 * FIX-LIVEP2(D39 LIVE-P2 FIX round 1): 실제 화면 컴포넌트를 react-dom/server 로 렌더(DB·세션은 가짜, 설정은 **실제 loadConfig**).
 * - E(계획 3(b)): "실제로 게시됩니다"라고 말하는 준비 표시(배포 계획 만들기·운영)가 즉시 중지 중이면 "일시 중지됨"을 함께 보인다.
 * - H(b): 홈·설정·배포 계획 화면이 상한(PUBLISH_LIVE_DAILY_MAX — PUBLISH_LIVE_MAX_POSTS 아님)·준비 상태·중지 상태를 실제 설정 값에서 가져와 "n/3"을 그린다.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type AppConfig } from '@cs/domain';

const T = new Date('2026-10-14T09:00:00Z');

const state = vi.hoisted(() => ({
  config: null as unknown,
  overview: { hasLiveAccount: true, paused: false, changedAt: null as Date | null, used: 0, availableAt: null as Date | null },
  overviewCalls: [] as unknown[][],
  accounts: [] as unknown[],
  channelAccounts: [] as unknown[],
  detail: null as unknown,
}));

vi.mock('./auth', () => ({ getSession: async () => ({ ownerId: '00000000-0000-4000-8000-000000000001', identity: 'owner@example.local', expiresAt: new Date() }) }));
vi.mock('./server', () => ({ getConfig: () => state.config, getAppDb: async () => ({ db: {} }), getStorage: () => ({}) }));
vi.mock('./dev-cert', () => ({ readDevCertExpiry: () => null }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect');
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@cs/db', async (orig) => {
  const dir = { present: true, bytes: 0, files: 0, status: 'complete', errors: 0, truncated: false };
  const none = { total: 0, items: [], truncated: false };
  return {
    ...(await orig<typeof import('@cs/db')>()),
    livePublishOverview: async (...args: unknown[]) => {
      state.overviewCalls.push(args);
      return state.overview;
    },
    getLivePublishPaused: async () => ({ paused: state.overview.paused, changedAt: state.overview.changedAt }),
    listAccountHealth: async () => state.accounts,
    // 홈
    listCaptures: async () => [],
    listAssets: async () => [],
    listCapturesPage: async () => ({ items: [], next: null }),
    latestDraft: async () => null,
    listRecentPlans: async () => [],
    // 설정
    monthlyUsage: async () => ({ byCurrency: [] }),
    listExportRuns: async () => [],
    listRestoreRuns: async () => [],
    // 배포 계획 상세
    getPlanDetail: async () => state.detail,
    // 배포 계획 만들기
    getContentRow: async () => ({ id: '22222222-2222-4222-8222-222222222222', title: '시험 원고' }),
    reviewVariantsOfContent: async () => [],
    variantReviewBlockers: async () => [],
    listChannelAccounts: async () => state.channelAccounts,
    // 운영
    opsSnapshot: async () => ({
      measuredAt: new Date('2026-10-14T09:00:00Z'),
      jobs: { byState: {}, byKind: { mock: 0, live: 0 }, total: 0, oldestQueuedHours: null, nextRetryAt: null, attention: none, repeatedFailures: none, attentionPlans: none },
      intents: { pending: 0, oldestPendingAt: null },
      pendingDeletes: { count: 0, oldestAt: null },
      uploads: { expiredSessions: 0, openPastExpiry: 0 },
      disk: { measuredAt: new Date('2026-10-14T09:00:00Z'), db: null, assets: dir, uploads: dir, exports: dir, packages: dir, retention: dir },
      cost: { currency: 'USD', monthlyLimit: null, byCurrency: [], overBudgetRuns: 0, since: new Date('2026-10-01T00:00:00Z') },
      backup: { maxAgeHours: 24, lastExport: null, state: 'none', lastDrill: null },
      lastRetention: null,
      incompleteRetention: { total: 0, items: [] },
      partialRetention: { total: 0, items: [] },
      accounts: {},
    }),
    planRetention: async () => ({
      policy: { jobEventsDays: 90, packagesDays: 30, exportsKeep: 5 },
      cutoffs: { jobEvents: new Date('2026-07-16T09:00:00Z'), packages: new Date('2026-09-14T09:00:00Z') },
      jobEvents: { jobs: 0, events: 0, jobIds: [] },
      packages: [],
      exports: [],
      exportsExisting: 0,
      exportsKept: [],
      exportsMissingFile: [],
    }),
  };
});

const { default: HomePage } = await import('../app/page');
const { default: SettingsPage } = await import('../app/settings/page');
const { default: PlanPage } = await import('../app/distribute/[id]/page');
const { default: NewPlanPage } = await import('../app/distribute/new/page');
const { default: OpsPage } = await import('../app/ops/page');

/** 실제 설정 읽기(loadConfig) — 승인 기록당 상한 1000 과 일일 상한 3 을 일부러 다르게(잘못된 값을 이어 붙이면 보이게) */
const LIVE_ENV = { NODE_ENV: 'test', PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'D39', PUBLISH_LIVE_MAX_POSTS: '1000', PUBLISH_LIVE_DAILY_MAX: '3' } as const;
const configOf = (env: Record<string, string>): AppConfig => loadConfig(env as unknown as NodeJS.ProcessEnv);

const PLAN = '11111111-1111-4111-8111-111111111111';
function liveItem() {
  const jobId = 'j-live';
  return {
    item: {
      id: 'i-live',
      planId: PLAN,
      status: 'CONFIRMED',
      scheduledAtUtc: null,
      restoredNeedsReview: false,
      visibility: 'public',
      requestedResult: 'public_publish',
      payloadHash: 'a'.repeat(64),
    },
    payload: { channel: 'threads', text: { posts: ['본문'] }, assets: [] },
    account: { kind: 'live', platform: 'threads', credentialState: 'linked', displayName: '@tester' },
    variant: { id: 'v-live', channel: 'threads', contentId: 'c', lifecycle: 'approved' },
    activeApproval: null,
    approvals: [],
    jobs: [{ id: jobId, state: 'CONFIRMED', attempt: 1, maxAttempts: 5, nextRunAt: T, cancelRequestedAt: null, lastErrorCode: null, lastRetryClass: null, restoredNeedsReview: false }],
    publications: [],
    events: [],
    problems: [],
    mockScenario: null,
    remoteSteps: [],
    connection: null,
    latestIntent: null,
    latestReconcileEvent: null,
  };
}

const renderHome = async () => renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({}) }));
const renderSettings = async () => renderToStaticMarkup(await SettingsPage({ searchParams: Promise.resolve({}) }));
const renderPlan = async () => renderToStaticMarkup(await PlanPage({ params: Promise.resolve({ id: PLAN }), searchParams: Promise.resolve({}) }));
const renderNew = async () => renderToStaticMarkup(await NewPlanPage({ searchParams: Promise.resolve({ content_id: '22222222-2222-4222-8222-222222222222' }) }));
const renderOps = async () => renderToStaticMarkup(await OpsPage({ searchParams: Promise.resolve({}) }));
/** 설정 "실제 게시" 구역 */
const liveSection = (html: string) => {
  const i = html.indexOf('id="live-publish"');
  expect(i).toBeGreaterThan(-1);
  return html.slice(i, html.indexOf('</section>', i));
};

beforeEach(() => {
  state.config = configOf(LIVE_ENV);
  state.overview = { hasLiveAccount: true, paused: false, changedAt: null, used: 0, availableAt: null };
  state.overviewCalls = [];
  state.accounts = [];
  state.channelAccounts = [];
  state.detail = { plan: { id: PLAN, targetSummary: '시험 계획', status: 'completed', createdAt: T }, items: [liveItem()] };
});

describe('H(b) — 홈·설정·배포 계획: 상한·준비·중지를 실제 설정에서 그린다', () => {
  it('설정 확인: 실제 loadConfig 가 일일 상한 3·승인 기록당 1000 을 읽는다(아래 화면 단언의 전제)', () => {
    const c = state.config as AppConfig;
    expect([c.PUBLISH_MODE, c.PUBLISH_LIVE_DAILY_MAX, c.PUBLISH_LIVE_MAX_POSTS]).toEqual(['enabled', 3, 1000]);
  });

  it('홈: "실제 게시: 최근 24시간 2/3"(1000 아님·꺼짐 아님), 중지면 "실제 게시 일시 중지됨 …(최근 24시간 2/3)"', async () => {
    state.overview = { ...state.overview, used: 2 };
    let html = await renderHome();
    expect(html).toContain('>실제 게시: 최근 24시간 2/3</a>');
    expect(html).not.toContain('2/1000');
    state.overview = { ...state.overview, paused: true };
    html = await renderHome();
    expect(html).toContain('>실제 게시 일시 중지됨 — 재개 전에는 게시하지 않음(최근 24시간 2/3)</a>');
    // 일일 상한 없음·게시 꺼짐도 설정 그대로
    state.config = configOf({ ...LIVE_ENV, PUBLISH_LIVE_DAILY_MAX: '', PUBLISH_MODE: 'disabled' });
    state.overview = { ...state.overview, paused: false };
    expect(await renderHome()).toContain('>실제 게시: 최근 24시간 2건(일일 상한 없음) · 꺼짐(실제로 게시하지 않음)</a>');
  });

  it('배포 계획(실제 항목): "<strong>실제 게시: 최근 24시간 2/3</strong>", 중지면 일시 중지 줄', async () => {
    state.overview = { ...state.overview, used: 2 };
    expect(await renderPlan()).toContain('<p class="status-line" role="status"><strong>실제 게시: 최근 24시간 2/3</strong></p>');
    state.overview = { ...state.overview, paused: true };
    expect(await renderPlan()).toContain('<strong>실제 게시 일시 중지됨 — 재개 전에는 게시하지 않음(최근 24시간 2/3)</strong>');
  });

  it('설정 "실제 게시": 상태 켜짐/일시 중지됨, 사용 "최근 24시간 3/3 — 다음 게시 가능 …"(상한 3 을 요약에 넘겨 계산, 분 단위 올림), 준비 표시에 일시 중지', async () => {
    // 상한 다 씀: 다음 게시 가능 시각 09:00:01 UTC → 12:01 MSK(올림)
    state.overview = { ...state.overview, used: 3, availableAt: new Date('2026-10-21T09:00:01Z') };
    let html = await renderSettings();
    let sec = liveSection(html);
    expect(sec).toContain('<span class="tag live">켜짐</span>');
    expect(sec).toContain('<div class="row"><dt>사용</dt><dd>최근 24시간 3/3 — 다음 게시 가능 2026-10-21 12:01 (MSK)</dd></div>');
    expect(sec).not.toContain('/1000');
    // 요약은 일일 상한 3 으로 계산(available_at = 상한 아래로 내려가는 시각)
    expect(state.overviewCalls.at(-1)?.[3]).toBe(3);
    expect(html).toContain('<span class="tag live">실제 게시 준비됨</span>');
    expect(html).not.toContain('지금은 실제 게시 일시 중지됨');
    state.overview = { ...state.overview, paused: true, used: 1, availableAt: new Date('2026-10-21T09:00:00Z') };
    html = await renderSettings();
    sec = liveSection(html);
    expect(sec).toContain('<span class="tag warn">일시 중지됨</span>');
    expect(sec).toContain('<div class="row"><dt>사용</dt><dd>최근 24시간 1/3</dd></div>'); // 상한 아래면 다음 게시 가능 시각 없음
    expect(html).toContain('<strong> 지금은 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않습니다.</strong>');
  });
});

describe('E(계획 3(b)) — "실제로 게시됩니다" 준비 표시는 중지 중이면 "일시 중지됨"을 함께', () => {
  const liveAcc = { id: '33333333-3333-4333-8333-333333333333', kind: 'live', platform: 'threads', state: 'connected', credentialState: 'linked', displayName: '@tester' };
  const mockAcc = { id: '44444444-4444-4444-8444-444444444444', kind: 'mock', platform: 'threads', state: 'mock_ready', credentialState: 'none', displayName: '모의 Threads' };
  const firstNotice = (html: string) => /<p class="notice" role="note">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';

  it('배포 계획 만들기: 실제 게시 계정 + 중지 → 안내에 "일시 중지됨 — 재개 전에는 게시하지 않습니다", 중지 아님·모의만이면 없음', async () => {
    state.channelAccounts = [mockAcc, liveAcc];
    state.overview = { ...state.overview, paused: true };
    let n = firstNotice(await renderNew());
    expect(n).toContain('<strong>실제로 게시</strong>');
    expect(n).toContain('<span class="tag warn">일시 중지됨</span> <strong>지금은 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않습니다.</strong>');
    state.overview = { ...state.overview, paused: false };
    n = firstNotice(await renderNew());
    expect(n).toContain('<strong>실제로 게시</strong>');
    expect(n).not.toContain('일시 중지');
    state.channelAccounts = [mockAcc];
    state.overview = { ...state.overview, paused: true };
    n = firstNotice(await renderNew());
    expect(n).toContain('MOCK');
    expect(n).not.toContain('일시 중지');
  });

  it('운영: 실제 게시 준비 줄에 중지 상태(모두 갖춰지면 "없음(준비됨)" — 빈 목록 대신)', async () => {
    state.overview = { ...state.overview, paused: true };
    let html = await renderOps();
    expect(html).toContain('실제 게시 준비 안 됨: 없음(준비됨) · 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않음');
    state.overview = { ...state.overview, paused: false };
    html = await renderOps();
    expect(html).toContain('실제 게시 준비 안 됨: 없음(준비됨)');
    expect(html).not.toContain('일시 중지됨');
    state.config = configOf({ ...LIVE_ENV, PUBLISH_MODE: 'disabled' });
    expect(await renderOps()).toContain('실제 게시 준비 안 됨: PUBLISH_MODE=enabled');
  });
});

