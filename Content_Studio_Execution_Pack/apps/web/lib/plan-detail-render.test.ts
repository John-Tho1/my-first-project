/**
 * FIX2-UICLEAN(브라우저 확인): 배포 계획 상세(/distribute/[id])를 실제 화면 컴포넌트로 렌더(DB·세션 가짜) —
 * 실제 Threads 항목(결과 is_mock=false)은 상태 태그·카드 어디에도 "MOCK" 이 없고, 모의 항목은 기존 MOCK 문구 그대로.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  detail: null as unknown,
  // LIVE-P2(D39): 계획 화면의 실제 게시 한 줄(표시용 요약 — DB 가짜)
  overview: { hasLiveAccount: true, paused: false, changedAt: null as Date | null, used: 0, availableAt: null as Date | null },
}));

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
vi.mock('@cs/db', async (orig) => ({
  ...(await orig<typeof import('@cs/db')>()),
  getPlanDetail: async () => state.detail,
  livePublishOverview: async () => state.overview,
}));

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
  state.overview = { hasLiveAccount: true, paused: false, changedAt: null, used: 0, availableAt: null };
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
    expect(card).toContain('<span class="tag mock">MOCK</span>');
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

describe('DESIGN-A — 항목 카드: 실제 게시(주황 tag live)와 MOCK(회색 tag mock)을 섞지 않고, 공개 범위·일정·요청 결과는 묶음 목록 행', () => {
  it('실제 카드: tag live 표시 · tag mock 없음 · 공개 범위 행(승인 값 public) · 요청 결과 행(실제 게시)', async () => {
    state.detail = detail(item({ live: true, verification: 'USER_CONFIRMED', name: 'live' }));
    const [card] = cards(await render());
    expect(card).toContain('<span class="tag live">실제 게시 — 실제 계정</span>');
    expect(card).not.toContain('tag mock');
    expect(card).toContain('<dl class="group-list">');
    expect(card).toMatch(/<div class="row"><dt>공개 범위<\/dt><dd>[^<]*\(승인 값 public\)<\/dd><\/div>/);
    expect(card).toContain('<div class="row"><dt>일정</dt><dd>즉시(실행 후 대기열)</dd></div>');
    expect(card).toContain('<div class="row"><dt>요청 결과</dt><dd>실제 게시(public_publish — Threads 텍스트 1개)</dd></div>');
  });

  it('모의 카드: tag mock 표시 · tag live 없음 · 요청 결과 행은 MOCK 실행(실제 게시 아님)', async () => {
    state.detail = detail(item({ live: false, verification: 'MOCK', name: 'mock' }));
    const [card] = cards(await render());
    expect(card).toContain('<span class="tag mock">MOCK</span>');
    expect(card).not.toContain('tag live');
    expect(card).toContain('<div class="row"><dt>요청 결과</dt><dd>MOCK 실행(실제 게시 아님)</dd></div>');
  });
});

describe('LIVE-P2(D39) — 계획 화면의 실제 게시 한 줄·보류 문구', () => {
  it('실제 항목이 있는 계획: "실제 게시: 최근 24시간 n…" 한 줄(설정 없음 = 일일 상한 없음·꺼짐), 일시 중지면 "실제 게시 일시 중지됨"', async () => {
    state.detail = detail(item({ live: true, verification: 'VERIFIED', name: 'live' }));
    state.overview = { ...state.overview, used: 2 };
    expect(await render()).toContain('<p class="status-line" role="status"><strong>실제 게시: 최근 24시간 2건(일일 상한 없음) · 꺼짐(실제로 게시하지 않음)</strong></p>');
    state.overview = { ...state.overview, paused: true, used: 1 };
    expect(await render()).toContain('<strong>실제 게시 일시 중지됨 — 재개 전에는 게시하지 않음(최근 24시간 1건(일일 상한 없음))</strong>');
  });

  it('모의만인 계획에는 실제 게시 한 줄이 없다', async () => {
    state.detail = detail(item({ live: false, verification: 'MOCK', name: 'mock' }));
    const html = await render();
    expect(html).not.toContain('최근 24시간');
    expect(html).not.toContain('일시 중지');
  });

  it('최근 24시간 상한으로 보류된 실제 항목: 상한·다시 보낼 수 있는 모스크바 시각 · 일시 중지 보류는 재개 안내', async () => {
    const blocked = (name: string, code: string, details: Record<string, unknown>) => {
      const x = item({ live: true, verification: 'UNVERIFIED', withPub: false, name });
      return {
        ...x,
        item: { ...x.item, status: 'BLOCKED' },
        activeApproval: { id: 'a', payloadHash: 'a'.repeat(64) },
        jobs: [{ ...x.jobs[0]!, state: 'BLOCKED', attempt: 0, lastErrorCode: code }],
        events: [{ id: `e-${name}`, eventSeq: 2, at: T, stateBefore: 'LEASED', stateAfter: 'BLOCKED', sanitizedDetails: { event: 'blocked', not_sent: true, reason: code, ...details } }],
      };
    };
    state.detail = detail(
      blocked('daily', 'live_publish_daily_limit', { used: 3, limit: 3, available_at: '2026-10-20T09:00:00.000Z' }),
      blocked('paused', 'live_publish_paused', {}),
    );
    const [daily, paused] = cards(await render());
    expect(daily).toContain("보류 — 최근 24시간 실제 게시 상한(3건)을 다 써서 게시하지 않았습니다. 2026-10-20 12:00 (MSK) 이후 &#x27;재시도&#x27;로 다시 보낼 수 있습니다.");
    expect(paused).toContain('보류 — 실제 게시가 일시 중지되어 게시하지 않았습니다. 설정에서 재개한 뒤 &#x27;재시도&#x27;로 다시 보낼 수 있습니다.');
    for (const c of [daily!, paused!]) expect(c).not.toContain('MOCK');
  });
});

/**
 * FIX2-FULLREV(Q2): 부분 게시·복원 취소 미확정 UNKNOWN 항목 — 페이지가 최근 작업의 사유 코드(lastErrorCode)를 상태 태그·작업 줄·안내에 넘겨
 * 카드 어디에서도 "새 계획 필요"(새 계획은 게시된 부분을 처음부터 다시 게시)를 말하지 않는다. 일반 UNKNOWN 은 그대로.
 * FIX3-FULLREV(R3, 사용자 결정 2026-10-23): 실제 카드(단일 게시물)는 조건부 복구 길("직접 확인해 글이 없을 때만 새 배포 계획으로 다시 승인하세요")을
 * 다시 말한다 — FIX2 의 "실제 카드에 없음" 단언은 정확한 새 문구·모든 "새 배포 계획"이 조건 아래에만 있음으로 바꿨다. 모의 카드는 그대로(새 계획 권유 없음).
 */
/** FIX3-FULLREV(R3): 카드 안 "새 배포 계획"이 모두 "없을 때만 " 조건 바로 뒤에만 나오는지(무조건 새 계획 권유 없음) — 나온 횟수 */
const conditionalNewPlanCount = (html: string) => {
  const parts = html.split('새 배포 계획');
  for (const before of parts.slice(0, -1)) expect(before.endsWith('없을 때만 '), before.slice(-40)).toBe(true);
  return parts.length - 1;
};
describe('FIX2-FULLREV(Q2) — 부분 게시 UNKNOWN 카드는 새 계획을 권하지 않는다', () => {
  const unknownItem = (name: string, o: { live: boolean; code: string | null; reason?: string; problems?: string[] }) => {
    const x = item({ live: o.live, verification: o.live ? 'UNVERIFIED' : 'MOCK', withPub: false, name });
    return {
      ...x,
      item: { ...x.item, status: 'UNKNOWN' },
      jobs: [{ ...x.jobs[0]!, state: 'UNKNOWN', lastErrorCode: o.code }],
      events: o.reason
        ? [
            { id: `e2-${name}`, eventSeq: 3, at: T, stateBefore: 'BLOCKED', stateAfter: 'UNKNOWN', sanitizedDetails: { event: 'cancel_partial', transition: 'cancel_partial', cause: o.reason } },
            { id: `e1-${name}`, eventSeq: 2, at: T, stateBefore: 'SENDING', stateAfter: 'BLOCKED', sanitizedDetails: { event: 'blocked', transition: 'blocked', reason: o.reason } },
          ]
        : [],
      problems: o.problems ?? [],
    };
  };

  it('모의 부분 게시(thread_partial_failed, 스냅샷 바뀜): 상태 태그·작업 줄·머리줄·스냅샷 안내 모두 부분 게시 문구, "새 계획 필요" 없음', async () => {
    const { UNKNOWN_JOB_LINE_BY_KIND, UNKNOWN_JOB_LINE_PARTIAL_MOCK, UNKNOWN_STATUS_LABEL_BY_KIND, SNAPSHOT_PROBLEMS_PREFIX_BY_KIND } = await import('./distribution');
    state.detail = detail(unknownItem('mp', { live: false, code: 'thread_partial_failed', reason: 'permanent_failure', problems: ['content_changed'] }));
    const [card] = cards(await render());
    expect(statusTag(card!)).toBe(UNKNOWN_STATUS_LABEL_BY_KIND.partial.mock);
    // FIX2-FULLREV(FX6): 작업 목록 줄(<strong>)만 본다 — 모의 카드는 모의 줄(채널 확인 지시 없음), 공통 줄 없음
    expect(card).toContain(`<strong>${UNKNOWN_JOB_LINE_PARTIAL_MOCK}</strong>`);
    expect(card).not.toContain(UNKNOWN_JOB_LINE_BY_KIND.partial);
    expect(card).not.toContain('채널에서 직접 확인');
    expect(card).toContain('일부만 게시됨(MOCK) — 남은 게시물 전송 실패(원격 거절)');
    expect(card).toContain(`${SNAPSHOT_PROBLEMS_PREFIX_BY_KIND.partial.mock}: 원고가 바뀜`);
    expect(card).not.toContain('새 계획 필요');
    expect(card).not.toContain('재확인 또는 새 계획');
    // FIX3-FULLREV(R3): 모의 카드는 그대로 — 조건부 복구 길도 새 배포 계획 권유도 없다(모의 스레드는 여러 게시물, 새 계획은 게시된 부분을 다시 게시)
    expect(card).not.toContain('없을 때만');
    expect(card).not.toContain('새 배포 계획');
  });

  it('실제 부분 게시(thread_partial_revoked): 상태 태그(MOCK 없음)·결과 불명 안내가 부분 게시 문구 — FIX3-FULLREV(R3): 새 계획은 "직접 확인해 글이 없을 때만"(조건부)', async () => {
    const { LIVE_UNKNOWN_GUIDANCE_BY_KIND, UNKNOWN_STATUS_LABEL_BY_KIND, UNKNOWN_JOB_LINE_BY_KIND, SNAPSHOT_PROBLEMS_PREFIX_BY_KIND } = await import('./distribution');
    state.detail = detail(unknownItem('lp', { live: true, code: 'thread_partial_revoked', problems: ['content_changed'] }));
    const [card] = cards(await render());
    expect(statusTag(card!)).toBe(UNKNOWN_STATUS_LABEL_BY_KIND.partial.live);
    expect(card).toContain(LIVE_UNKNOWN_GUIDANCE_BY_KIND.partial);
    expect(card).toContain(`<strong>${UNKNOWN_JOB_LINE_BY_KIND.partial}</strong>`);
    // FIX2-FULLREV(FX3): 실제 카드의 스냅샷 안내는 실제 문구 — 단일 게시물·게시 시도 표식뿐일 수 있어 "일부 게시된 작업"·"게시된 부분"이라고 단정하지 않는다
    expect(card).toContain(`${SNAPSHOT_PROBLEMS_PREFIX_BY_KIND.partial.live}: 원고가 바뀜`);
    expect(card).not.toContain('일부 게시된');
    expect(card).not.toContain('게시된 부분');
    // FIX3-FULLREV(R3): (FIX2 의 "없을 때만 새 배포 계획으로 다시 승인하세요 없음"을 바꿈) 실제 카드는 조건부 복구 길을 정확한 문구로 말하고 —
    // 결과 불명 안내(1)·머리줄(1)·스냅샷 안내(1) — 모든 "새 배포 계획"이 "없을 때만" 조건 아래에만 있다. 무조건 "새 계획 필요"는 없다.
    expect(card).toContain(
      'Threads 앱·웹에서 이 계정의 최근 글을 직접 확인하세요 — 있으면 그대로 두고(이 카드에 「Threads에서 확인함」 버튼이 보이면 눌러 기록할 수 있음), 직접 확인해 글이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 글이 두 번 올라갈 수 있습니다).',
    );
    expect(card!.split('없을 때만 새 배포 계획으로 다시 승인하세요').length - 1).toBe(1);
    expect(card).toContain('<strong>승인 철회·무효 — 이미 게시됐거나 게시됐을 수 있어 다시 게시하지 않음(되돌리지 않음). Threads 에서 직접 확인하세요(글이 없을 때만 새 배포 계획으로 다시 승인)</strong>');
    expect(conditionalNewPlanCount(card!)).toBe(3);
    expect(card).not.toContain('새 계획 필요');
    expect(card).not.toContain('MOCK');
  });

  it('복원 취소 미확정(restored_cancel_unverified): 실제 카드는 Threads 직접 확인 안내, 모의 카드는 MOCK(실제 채널로 보낸 것 없음 — 채널 확인 지시 없음), "새 계획 필요" 없음', async () => {
    const { LIVE_UNKNOWN_GUIDANCE_BY_KIND, UNKNOWN_STATUS_LABEL_BY_KIND, UNKNOWN_JOB_LINE_BY_KIND, UNKNOWN_JOB_LINE_RESTORED_UNVERIFIED_MOCK, SNAPSHOT_PROBLEMS_PREFIX_BY_KIND } =
      await import('./distribution');
    state.detail = detail(
      unknownItem('rm', { live: false, code: 'restored_cancel_unverified', problems: ['content_changed'] }),
      unknownItem('rl', { live: true, code: 'restored_cancel_unverified', problems: ['content_changed'] }),
    );
    const [mock, live] = cards(await render());
    expect(statusTag(mock!)).toBe(UNKNOWN_STATUS_LABEL_BY_KIND.restored_unverified.mock);
    expect(statusTag(live!)).toBe(UNKNOWN_STATUS_LABEL_BY_KIND.restored_unverified.live);
    expect(live).toContain(LIVE_UNKNOWN_GUIDANCE_BY_KIND.restored_unverified);
    // FIX2-FULLREV(FX4): 작업 줄 — 실제 카드는 공통 줄(직접 확인), 모의 카드는 모의 줄 · 스냅샷 안내도 모의·실제(FX3)
    // FIX2-FULLREV(FX6): 모의 작업 줄 문구는 상태 태그와 같은 글이라 카드 전체가 아니라 작업 목록 줄(<strong>)에서 본다
    expect(live).toContain(`<strong>${UNKNOWN_JOB_LINE_BY_KIND.restored_unverified}</strong>`);
    expect(mock).toContain(`<strong>${UNKNOWN_JOB_LINE_RESTORED_UNVERIFIED_MOCK}</strong>`);
    expect(live).toContain(`${SNAPSHOT_PROBLEMS_PREFIX_BY_KIND.restored_unverified.live}: 원고가 바뀜`);
    expect(mock).toContain(`${SNAPSHOT_PROBLEMS_PREFIX_BY_KIND.restored_unverified.mock}: 원고가 바뀜`);
    expect(mock).toContain('복원한 모의 작업 — 모의 전송 여부를 기록으로 확인할 수 없어 취소를 확정하지 않음');
    expect(mock).not.toContain('채널에서 직접 확인');
    expect(live).not.toContain('MOCK');
    for (const c of [mock!, live!]) expect(c).not.toContain('새 계획 필요');
    // FIX3-FULLREV(R3): (FIX2 의 두 카드 모두 "없을 때만 새 배포 계획으로 다시 승인하세요 없음"을 나눔) 모의 카드는 그대로 없음(새 배포 계획 권유 자체가 없음),
    // 실제 카드는 조건부 복구 길 — 결과 불명 안내(1)·머리줄(1)·스냅샷 안내(1), 모두 "없을 때만" 조건 아래. 복원한 작업은 사용자 확인이 거절되므로 버튼을 가리키지 않는다.
    expect(mock).not.toContain('없을 때만');
    expect(mock).not.toContain('새 배포 계획');
    expect(live).toContain(
      'Threads 앱·웹에서 이 계정의 최근 글을 직접 확인하세요 — 있으면 그대로 두고(복원한 작업은 이 환경에서 사용자 확인으로 기록하지 않음), 직접 확인해 글이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 글이 두 번 올라갈 수 있습니다).',
    );
    expect(live!.split('없을 때만 새 배포 계획으로 다시 승인하세요').length - 1).toBe(1);
    expect(live).toContain('<strong>복원한 작업 — 게시됐는지 이 환경에서 확인할 수 없어 취소를 확정하지 않음(다시 게시하지 않음). Threads 에서 직접 확인하세요(글이 없을 때만 새 배포 계획으로 다시 승인)</strong>');
    expect(conditionalNewPlanCount(live!)).toBe(3);
    expect(live).not.toContain('Threads에서 확인함');
  });

  it('일반 UNKNOWN(부분 게시 사유 아님)은 지금 그대로: 상태 태그·작업 줄 "재확인 또는 새 계획 필요", 스냅샷 안내 "(새 계획 필요)", 실제 카드는 일반 결과 불명 안내', async () => {
    const { ITEM_STATUS_LABEL, LIVE_UNKNOWN_GUIDANCE } = await import('./distribution');
    state.detail = detail(unknownItem('gm', { live: false, code: 'reconcile_timeout', problems: ['content_changed'] }), unknownItem('gl', { live: true, code: null }));
    const [mock, live] = cards(await render());
    expect(statusTag(mock!)).toBe(ITEM_STATUS_LABEL.UNKNOWN);
    expect(mock).toContain('UNKNOWN · 확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요');
    expect(mock).toContain('스냅샷이 지금과 다릅니다 — 승인·실행할 수 없습니다(새 계획 필요): 원고가 바뀜');
    expect(statusTag(live!)).toBe(ITEM_STATUS_LABEL.UNKNOWN);
    expect(live).toContain(LIVE_UNKNOWN_GUIDANCE);
  });
});

/**
 * FIX3-FULLREV(R2, 사용자 결정 2026-10-23): 취소(HTML)가 결과 불명(UNKNOWN — 부분 게시·복원 미확정)으로 끝나면 계획 화면은 "취소 확인 중"이 아니라 전용 배너.
 * 배너는 리다이렉트 쿼리(cancel_unknown=1 + 항목 + 허용 목록 사유 코드)가 가리키는 이 계획의 항목이 저장된 상태로 "취소 요청·결과 불명"일 때만이고,
 * 모의·실제 문구는 그 항목 계정으로 고른다. 사유 값이 이상하면 사유를 단정하지 않는 일반 배너(쿼리 글자는 그리지 않음). 기존 취소 배너는 그대로.
 */
describe('FIX3-FULLREV(R2) — 취소 결과 불명 배너', () => {
  const U1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const U2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  const canceledUnknown = (name: string, o: { live: boolean; code: string; id: string }) => {
    const x = item({ live: o.live, verification: o.live ? 'UNVERIFIED' : 'MOCK', withPub: false, name });
    return { ...x, item: { ...x.item, id: o.id, status: 'UNKNOWN' }, jobs: [{ ...x.jobs[0]!, state: 'UNKNOWN', lastErrorCode: o.code, cancelRequestedAt: T }] };
  };
  const inState = (name: string, state: string, id?: string) => {
    const x = item({ live: false, verification: 'MOCK', withPub: false, name });
    return { ...x, item: { ...x.item, ...(id ? { id } : {}), status: state }, jobs: [{ ...x.jobs[0]!, state, lastErrorCode: 'thread_partial_canceled', cancelRequestedAt: T }] };
  };
  const cancelQ = (id: string, reason?: string) => ({ cancel_unknown: '1', cancel_item: id, ...(reason === undefined ? {} : { cancel_reason: reason }) });
  const OLD_CANCELED = '<p class="saved" role="status">취소했습니다(아직 보내지 않은 작업).</p>';
  const OLD_REQUESTED =
    '<p class="notice" role="status">취소 확인 중 — 이미 전송 단계에 들어간 작업입니다. 원격 결과를 확인한 뒤 취소됨 또는 &quot;취소 불가(이미 전송됨)&quot;으로 표시됩니다.</p>';
  const shownUnknownBanners = async (html: string) => {
    const { CANCEL_UNKNOWN_BANNER } = await import('./distribution');
    return Object.values(CANCEL_UNKNOWN_BANNER)
      .flatMap((b) => [b.mock, b.live])
      .filter((t) => html.includes(t));
  };

  it('모의 부분 게시 취소(thread_partial_canceled): 전용 배너(모의 — 실제 채널로 보낸 것 없음), 취소됨·취소 확인 중 배너 없음', async () => {
    const { CANCEL_UNKNOWN_BANNER } = await import('./distribution');
    state.detail = detail(canceledUnknown('mp', { live: false, code: 'thread_partial_canceled', id: U1 }));
    const html = await render(cancelQ(U1, 'thread_partial_canceled'));
    expect(html).toContain(`<p class="notice" role="alert">${CANCEL_UNKNOWN_BANNER.partial.mock}</p>`);
    expect(await shownUnknownBanners(html)).toEqual([CANCEL_UNKNOWN_BANNER.partial.mock]);
    expect(html).not.toContain('취소 확인 중 — 이미 전송 단계');
    expect(html).not.toContain('취소했습니다(아직 보내지 않은 작업)');
  });

  it('실제 복원 미확정 취소(restored_cancel_unverified): 실제 문구(Threads 직접 확인, MOCK 없음) — 섞인 계획에서도 쿼리가 가리킨 항목의 계정으로 고른다', async () => {
    const { CANCEL_UNKNOWN_BANNER } = await import('./distribution');
    state.detail = detail(
      canceledUnknown('mp', { live: false, code: 'thread_partial_canceled', id: U1 }),
      canceledUnknown('lr', { live: true, code: 'restored_cancel_unverified', id: U2 }),
    );
    const live = await render(cancelQ(U2, 'restored_cancel_unverified'));
    expect(live).toContain(`<p class="notice" role="alert">${CANCEL_UNKNOWN_BANNER.restored_unverified.live}</p>`);
    expect(await shownUnknownBanners(live)).toEqual([CANCEL_UNKNOWN_BANNER.restored_unverified.live]);
    const mock = await render(cancelQ(U1, 'thread_partial_canceled'));
    expect(await shownUnknownBanners(mock)).toEqual([CANCEL_UNKNOWN_BANNER.partial.mock]);
    // 사유 코드를 바꿔 끼워도(저장된 작업 코드와 다름) 그 사유를 주장하지 않는다 — 일반 문구
    expect(await shownUnknownBanners(await render(cancelQ(U2, 'thread_partial_canceled')))).toEqual([CANCEL_UNKNOWN_BANNER.generic.live]);
    for (const html of [live, mock]) {
      expect(html).not.toContain('취소 확인 중 — 이미 전송 단계');
      expect(html).not.toContain('취소했습니다(아직 보내지 않은 작업)');
    }
  });

  it('사유 값이 허용 목록 밖·이상한 값: 일반 배너(사유 단정 없음)이고 쿼리 글자는 화면에 없다 · 사유가 없어도 일반 배너', async () => {
    const { CANCEL_UNKNOWN_BANNER } = await import('./distribution');
    state.detail = detail(canceledUnknown('mp', { live: false, code: 'thread_partial_canceled', id: U1 }));
    const weird = '<img src=x onerror=alert(1)>';
    const html = await render(cancelQ(U1, weird));
    expect(await shownUnknownBanners(html)).toEqual([CANCEL_UNKNOWN_BANNER.generic.mock]);
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('&lt;img');
    expect(await shownUnknownBanners(await render(cancelQ(U1)))).toEqual([CANCEL_UNKNOWN_BANNER.generic.mock]);
    expect(await shownUnknownBanners(await render(cancelQ(U1, 'thread_partial_failed')))).toEqual([CANCEL_UNKNOWN_BANNER.generic.mock]);
  });

  it('배너 없음: 이 계획에 없는 항목·형식이 틀린 항목·쿼리 없음 · 예전 리다이렉트(cancel_requested=1)도 결과 불명 항목에 "취소 확인 중"을 띄우지 않는다', async () => {
    state.detail = detail(canceledUnknown('mp', { live: false, code: 'thread_partial_canceled', id: U1 }));
    const queries: Array<Record<string, string>> = [cancelQ(U2, 'thread_partial_canceled'), cancelQ('i-mp', 'thread_partial_canceled'), {}, { cancel_requested: '1' }, { canceled: '1' }];
    for (const q of queries) {
      const html = await render(q);
      expect(await shownUnknownBanners(html), JSON.stringify(q)).toEqual([]);
      expect(html, JSON.stringify(q)).not.toContain('취소 확인 중 — 이미 전송 단계');
      expect(html, JSON.stringify(q)).not.toContain('취소했습니다(아직 보내지 않은 작업)');
    }
  });

  it('기존 취소 배너는 그대로: canceled=1(CANCELED 항목) · cancel_requested=1(CANCEL_REQUESTED 항목) — 결과 불명 배너 없음', async () => {
    state.detail = detail(inState('c', 'CANCELED', U1), inState('r', 'CANCEL_REQUESTED', U2));
    const canceled = await render({ canceled: '1' });
    expect(canceled).toContain(OLD_CANCELED);
    expect(canceled).not.toContain('취소 확인 중 — 이미 전송 단계');
    const requested = await render({ cancel_requested: '1' });
    expect(requested).toContain(OLD_REQUESTED);
    expect(requested).not.toContain(OLD_CANCELED);
    for (const html of [canceled, requested]) expect(await shownUnknownBanners(html)).toEqual([]);
    // 결과 불명 쿼리로 취소됨·취소 확인 중 항목을 가리켜도(쿼리만 바꿈) 결과 불명 배너는 없다 — 저장된 상태가 UNKNOWN 이 아니다
    for (const id of [U1, U2]) expect(await shownUnknownBanners(await render(cancelQ(id, 'thread_partial_canceled'))), id).toEqual([]);
  });
});
