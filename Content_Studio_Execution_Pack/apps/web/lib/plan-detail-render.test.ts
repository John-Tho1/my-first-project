/**
 * FIX2-UICLEAN(브라우저 확인): 배포 계획 상세(/distribute/[id])를 실제 화면 컴포넌트로 렌더(DB·세션 가짜) —
 * 실제 Threads 항목(결과 is_mock=false)은 상태 태그·카드 어디에도 "MOCK" 이 없고, 모의 항목은 기존 MOCK 문구 그대로.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ detail: null as unknown }));

vi.mock('./auth', () => ({ getSession: async () => ({ ownerId: '00000000-0000-4000-8000-000000000001', identity: 'owner@example.local', expiresAt: new Date() }) }));
vi.mock('./server', () => ({ getConfig: () => ({}), getAppDb: async () => ({ db: {} }), getStorage: () => ({}) }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect');
  },
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('@cs/db', async (orig) => ({ ...(await orig<typeof import('@cs/db')>()), getPlanDetail: async () => state.detail }));

const { default: PlanPage } = await import('../app/distribute/[id]/page');

const PLAN = '11111111-1111-4111-8111-111111111111';
const T = new Date('2026-10-14T09:00:00Z');

function item(o: { live: boolean; verification: string; withPub?: boolean; name: string }) {
  const n = o.name;
  const jobId = `j-${n}`;
  const pub = {
    id: `p-${n}`,
    jobId,
    itemId: `i-${n}`,
    isMock: !o.live,
    resultKind: 'PUBLISHED',
    remoteVisibility: 'public',
    verification: o.verification,
    externalId: o.live ? 'threads:17900000000000001' : 'mock:threads:1',
    permalink: o.live ? 'https://www.threads.com/@tester/post/ABC' : null,
    confirmedAt: o.verification === 'USER_CONFIRMED' ? T : null,
    createdAt: T,
  };
  return {
    item: {
      id: `i-${n}`,
      planId: PLAN,
      status: 'CONFIRMED',
      scheduledAtUtc: null,
      restoredNeedsReview: false,
      visibility: 'public',
      requestedResult: o.live ? 'public_publish' : 'mock_publish',
      payloadHash: 'a'.repeat(64),
    },
    payload: { channel: 'threads', text: { posts: [`${n} 본문`] }, assets: [] },
    account: { kind: o.live ? 'live' : 'mock', platform: 'threads', credentialState: o.live ? 'linked' : 'none', displayName: o.live ? '@tester' : '모의 Threads' },
    variant: { id: `v-${n}`, channel: 'threads', contentId: 'c', lifecycle: 'approved' },
    activeApproval: null,
    approvals: [],
    jobs: [{ id: jobId, state: 'CONFIRMED', attempt: 1, maxAttempts: 5, nextRunAt: T, cancelRequestedAt: null, lastErrorCode: null, lastRetryClass: null, restoredNeedsReview: false }],
    publications: o.withPub === false ? [] : [pub],
    events: [],
    problems: [],
    mockScenario: null,
    remoteSteps: [],
    connection: null,
    latestIntent: null,
    latestReconcileEvent: null,
  };
}

const detail = (...items: unknown[]) => ({ plan: { id: PLAN, targetSummary: '시험 계획', status: 'completed', createdAt: T }, items });

async function render(q: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await PlanPage({ params: Promise.resolve({ id: PLAN }), searchParams: Promise.resolve(q) }));
}
/** 항목 카드(section) 들 — 계획 순서대로 */
const cards = (html: string) => html.split('<section class="card archive" aria-label="').slice(1).filter((s) => s.startsWith('Threads 항목'));
/** 카드 안 첫 메타 줄의 상태 태그 */
const statusTag = (card: string) => /<p class="meta"><span class="tag">([^<]*)<\/span>/.exec(card)?.[1] ?? '';

beforeEach(() => {
  state.detail = null;
});

describe('계획 상세 — 항목 상태 태그는 그 항목 기록으로', () => {
  it('실제 Threads 사용자 확인(USER_CONFIRMED, is_mock=false): 태그 "CONFIRMED · 실제 게시 완료 · 사용자 확인", 카드 어디에도 MOCK 없음', async () => {
    state.detail = detail(item({ live: true, verification: 'USER_CONFIRMED', name: 'live' }));
    const [card] = cards(await render());
    expect(statusTag(card!)).toBe('CONFIRMED · 실제 게시 완료 · 사용자 확인');
    expect(card).not.toContain('MOCK');
    // 기존 표시는 그대로(사용자 확인 태그·실제 게시 태그)
    expect(card).toContain('tag user-confirmed');
    expect(card).toContain('실제 게시 — 실제 계정');
  });

  it('실제 VERIFIED: "앱 확인(VERIFIED)" · 결과 기록이 없는 실제 CONFIRMED 작업 줄도 MOCK 아님', async () => {
    state.detail = detail(item({ live: true, verification: 'VERIFIED', name: 'v' }), item({ live: true, verification: 'UNVERIFIED', withPub: false, name: 'nopub' }));
    const [v, nopub] = cards(await render());
    expect(statusTag(v!)).toBe('CONFIRMED · 실제 게시 완료 · 앱 확인(VERIFIED)');
    expect(v).not.toContain('MOCK');
    expect(statusTag(nopub!)).toBe('CONFIRMED · 실제 게시 완료 · 확인 전');
    expect(nopub).not.toContain('MOCK');
  });

  it('모의 항목은 기존 문구 그대로: "CONFIRMED · MOCK 확인(실제 발행 아님)" + MOCK 태그·실제 발행 실적 아님', async () => {
    state.detail = detail(item({ live: false, verification: 'MOCK', name: 'mock' }));
    const [card] = cards(await render());
    expect(statusTag(card!)).toBe('CONFIRMED · MOCK 확인(실제 발행 아님)');
    expect(card).toContain('<span class="tag warn">MOCK</span>');
    expect(card).toContain('실제 발행 실적 아님');
  });

  it('섞인 계획: 실제 카드는 MOCK 없음, 모의 카드는 MOCK — 서로의 표시가 섞이지 않는다', async () => {
    state.detail = detail(item({ live: true, verification: 'USER_CONFIRMED', name: 'live' }), item({ live: false, verification: 'MOCK', name: 'mock' }));
    const [live, mock] = cards(await render());
    expect(live).not.toContain('MOCK');
    expect(statusTag(mock!)).toBe('CONFIRMED · MOCK 확인(실제 발행 아님)');
  });

  it('승인 철회 배너: 실제 계정 항목이 있는 계획은 "(MOCK)" 없이, 모의만이면 그대로', async () => {
    state.detail = detail(item({ live: true, verification: 'USER_CONFIRMED', name: 'live' }));
    let html = await render({ revoked: '1' });
    expect(html).toContain('승인을 철회했습니다.');
    expect(html).not.toContain('승인을 철회했습니다(MOCK)');
    state.detail = detail(item({ live: false, verification: 'MOCK', name: 'mock' }));
    html = await render({ revoked: '1' });
    expect(html).toContain('승인을 철회했습니다(MOCK).');
  });

  it('계획 상태 태그: 실제 항목이 있으면 "(MOCK…)" 꼬리표 없이, 모의만이면 그대로', async () => {
    state.detail = detail(item({ live: true, verification: 'USER_CONFIRMED', name: 'live' }));
    expect(await render()).toContain('<span class="tag">처리 끝</span>');
    state.detail = detail(item({ live: false, verification: 'MOCK', name: 'mock' }));
    expect(await render()).toContain('<span class="tag">처리 끝(MOCK — 실제 발행 아님)</span>');
  });
});
