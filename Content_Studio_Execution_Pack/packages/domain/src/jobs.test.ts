import { describe, expect, it } from 'vitest';
import { canTransitionJob as canT15, decideRetryAt as decideRetryAtT15, REMOTE_STEP_KIND_STATUSES as KS15 } from './jobs';
import {
  ACTIVE_JOB_STATES,
  canTransitionJob,
  classifyOutcome,
  countedAttempts,
  decideRetry,
  FREE_RESUME_MAX,
  LEGACY_SEND_ADAPTER_ID,
  recordedAdapterIdOf,
  IllegalJobTransitionError,
  itemStatusForJob,
  JOB_EVENTS,
  JOB_STATES,
  JOB_TRANSITIONS,
  WEB_TICK_UPLOAD_SLICE,
  localRateLimitDecision,
  MOCK_SCENARIO_VALUES,
  planStatusFrom,
  scenarioApplies,
  THREADS_MOCK_SCENARIOS,
  reconcileDelay,
  RETRY_AFTER_MAX_SEC,
  RETRY_CAP_MS,
  retryDelay,
  tickSchema,
  TERMINAL_JOB_STATES,
  transitionJobState,
  type JobEvent,
  type JobState,
} from './jobs';
import { computePlanStatus } from './distribution';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const delayOf = (d: Date) => d.getTime() - NOW.getTime();

describe('작업 상태 기계(JOB_TRANSITIONS)', () => {
  const allowed: Array<[JobState, JobEvent, JobState]> = [];
  for (const s of JOB_STATES) for (const [e, to] of Object.entries(JOB_TRANSITIONS[s])) allowed.push([s, e as JobEvent, to as JobState]);

  it.each(allowed)('%s --%s--> %s', (from, event, to) => {
    expect(transitionJobState(from, event)).toBe(to);
    expect(canTransitionJob(from, event)).toBe(true);
  });

  it('표에 없는 모든 조합은 IllegalJobTransitionError', () => {
    let illegal = 0;
    for (const s of JOB_STATES) {
      for (const e of JOB_EVENTS) {
        if (JOB_TRANSITIONS[s][e]) continue;
        illegal++;
        expect(() => transitionJobState(s, e)).toThrow(IllegalJobTransitionError);
        expect(canTransitionJob(s, e)).toBe(false);
      }
    }
    expect(illegal).toBeGreaterThan(150);
    expect(() => transitionJobState('DONE', 'lease')).toThrow(IllegalJobTransitionError);
  });

  it('끝난 상태(CONFIRMED·FAILED·CANCELED)에서는 어떤 전이도 없다', () => {
    for (const s of TERMINAL_JOB_STATES) expect(Object.keys(JOB_TRANSITIONS[s])).toEqual([]);
  });

  it('A08: UNKNOWN 에서 전송(lease)·재시도 대기로 가는 전이는 없다 — 찾음/처리 중/확인 기록만', () => {
    // LIVEP1-USERCONFIRM: 사용자 확인(user_confirmed → CONFIRMED, 외부 호출 없음)이 더해졌다 — 전송(lease)·재시도 대기 전이는 여전히 없다.
    expect(Object.keys(JOB_TRANSITIONS.UNKNOWN).sort()).toEqual(['reconcile_retry', 'reconciled_found', 'remote_accepted', 'user_confirmed']);
    expect(JOB_TRANSITIONS.UNKNOWN.user_confirmed).toBe('CONFIRMED');
    expect(canTransitionJob('UNKNOWN', 'lease')).toBe(false);
    expect(canTransitionJob('UNKNOWN', 'reconciled_not_found')).toBe(false);
  });

  it('A20: 의도 기록 뒤 lease 만료는 RECONCILING(재전송 대기 아님), 의도 전은 QUEUED', () => {
    expect(transitionJobState('SENDING', 'lease_expired_after_intent')).toBe('RECONCILING');
    expect(transitionJobState('LEASED', 'lease_expired_before_intent')).toBe('QUEUED');
    expect(canTransitionJob('SENDING', 'lease_expired_before_intent')).toBe(false);
  });

  it('A11: 전송 뒤 취소는 CANCEL_REQUESTED, 원격이 받았으면 cancel_too_late → CONFIRMED', () => {
    expect(transitionJobState('SENDING', 'cancel_requested')).toBe('CANCEL_REQUESTED');
    expect(transitionJobState('CANCEL_REQUESTED', 'cancel_too_late')).toBe('CONFIRMED');
    expect(canTransitionJob('SENDING', 'canceled')).toBe(false);
    expect(transitionJobState('QUEUED', 'canceled')).toBe('CANCELED');
  });

  it('SENDING 은 승인 재검사를 통과한 LEASED 에서만', () => {
    const into = JOB_STATES.filter((s) => JOB_TRANSITIONS[s].send_start === 'SENDING');
    expect(into).toEqual(['LEASED']);
  });

  it('진행 중 상태 목록은 BLOCKED·끝난 상태를 포함하지 않는다', () => {
    for (const s of [...TERMINAL_JOB_STATES, 'BLOCKED' as const]) expect(ACTIVE_JOB_STATES).not.toContain(s);
  });
});

describe('retryDelay / decideRetry', () => {
  it('지수 증가(30초 기준)와 ±20% jitter 경계', () => {
    expect(delayOf(retryDelay(1, null, NOW, () => 0))).toBe(24_000);
    expect(delayOf(retryDelay(1, null, NOW, () => 0.5))).toBe(30_000);
    expect(delayOf(retryDelay(1, null, NOW, () => 1))).toBe(36_000);
    expect(delayOf(retryDelay(2, null, NOW, () => 0.5))).toBe(60_000);
    expect(delayOf(retryDelay(3, null, NOW, () => 0.5))).toBe(120_000);
    for (let i = 0; i < 50; i++) {
      const d = delayOf(retryDelay(2, undefined, NOW));
      expect(d).toBeGreaterThanOrEqual(48_000);
      expect(d).toBeLessThanOrEqual(72_000);
    }
  });

  it('상한 15분(+jitter)', () => {
    expect(delayOf(retryDelay(20, null, NOW, () => 0.5))).toBe(RETRY_CAP_MS);
    expect(delayOf(retryDelay(99, null, NOW, () => 1))).toBe(RETRY_CAP_MS * 1.2);
  });

  it('Retry-After 보다 먼저 재시도하지 않는다', () => {
    expect(delayOf(retryDelay(1, 120, NOW, () => 0.5))).toBe(120_000);
    expect(delayOf(retryDelay(3, 10, NOW, () => 0.5))).toBe(120_000);
  });

  it('최대 시도·Retry-After 한도를 넘으면 재시도하지 않는다', () => {
    expect(decideRetry(4, 5, null, NOW, () => 0.5)).toEqual({ retry: true, nextRunAt: new Date(NOW.getTime() + 240_000) });
    expect(decideRetry(5, 5, null, NOW)).toEqual({ retry: false, reason: 'max_attempts' });
    expect(decideRetry(1, 5, RETRY_AFTER_MAX_SEC + 1, NOW)).toEqual({ retry: false, reason: 'retry_after_too_long' });
  });

  it('조회 간격 10초 × 2^(n-1)', () => {
    expect(delayOf(reconcileDelay(1, NOW))).toBe(10_000);
    expect(delayOf(reconcileDelay(3, NOW))).toBe(40_000);
  });
});

describe('classifyOutcome', () => {
  it('상태·재시도 분류 → 사건', () => {
    expect(classifyOutcome({ status: 'accepted' })).toEqual({ event: 'confirmed', retryClass: null, intentOutcome: 'accepted' });
    expect(classifyOutcome({ status: 'processing' }).event).toBe('remote_accepted');
    expect(classifyOutcome({ status: 'ambiguous' })).toEqual({ event: 'ambiguous', retryClass: 'transient_unknown_side_effect', intentOutcome: 'ambiguous' });
    expect(classifyOutcome({ status: 'rejected', retry_class: 'transient_no_side_effect' }).event).toBe('transient_failure');
    // 429/5xx 라도 부작용 불명이면 재시도가 아니라 조회
    expect(classifyOutcome({ status: 'rejected', retry_class: 'transient_unknown_side_effect' }).event).toBe('ambiguous');
    expect(classifyOutcome({ status: 'rejected', retry_class: 'permanent' }).event).toBe('permanent_failure');
    // 401: refresh 없음 → BLOCKED, 자동 재시도 없음
    expect(classifyOutcome({ status: 'rejected', retry_class: 'auth' })).toEqual({ event: 'blocked', retryClass: 'auth', intentOutcome: 'rejected' });
    // 분류가 없는 거절은 자동 반복하지 않는다
    expect(classifyOutcome({ status: 'rejected' }).event).toBe('permanent_failure');
  });
});

describe('항목·계획 상태', () => {
  it('itemStatusForJob: LEASED 는 아직 QUEUED 로 보인다', () => {
    expect(itemStatusForJob('LEASED')).toBe('QUEUED');
    expect(itemStatusForJob('RECONCILING')).toBe('RECONCILING');
    expect(itemStatusForJob('CONFIRMED')).toBe('CONFIRMED');
  });

  const I = (status: string, activeApproval = true) => ({ status, activeApproval });
  it('planStatusFrom: 진행 중·완료·취소·실패·PARTIAL·확인 필요(D19)', () => {
    expect(planStatusFrom([])).toBe('draft');
    expect(planStatusFrom([I('CONFIRMED'), I('RETRY_WAIT')])).toBe('executing');
    expect(planStatusFrom([I('CONFIRMED'), I('CANCEL_REQUESTED')])).toBe('executing');
    expect(planStatusFrom([I('CONFIRMED'), I('CONFIRMED')])).toBe('completed');
    expect(planStatusFrom([I('CANCELED'), I('CANCELED')])).toBe('canceled');
    expect(planStatusFrom([I('FAILED'), I('FAILED')])).toBe('failed');
    expect(planStatusFrom([I('FAILED'), I('CANCELED')])).toBe('failed');
    // D19: CONFIRMED 없이 사용자 조치가 필요한 항목(보류·결과 불명·다시 승인)이 있으면 failed 가 아니라 attention(확인 필요)
    expect(planStatusFrom([I('FAILED'), I('BLOCKED'), I('CANCELED')])).toBe('attention');
    expect(planStatusFrom([I('UNKNOWN'), I('FAILED')])).toBe('attention');
    expect(planStatusFrom([I('UNKNOWN')])).toBe('attention');
    expect(planStatusFrom([I('BLOCKED')])).toBe('attention');
    expect(planStatusFrom([I('PLANNED', false), I('FAILED')])).toBe('attention');
    // A09: 일부 성공 + 다른 채널 실패/보류/취소/불명/다시 승인 → partial(성공한 항목은 다시 보내지 않는다)
    for (const other of ['FAILED', 'CANCELED', 'BLOCKED', 'UNKNOWN']) expect(planStatusFrom([I('CONFIRMED'), I(other)])).toBe('partial');
    expect(planStatusFrom([I('PLANNED', false), I('CONFIRMED')])).toBe('partial');
    expect(planStatusFrom([I('PLANNED', true), I('PLANNED', false)])).toBe('partially_approved');
    expect(planStatusFrom([I('PLANNED', true), I('PLANNED', true)])).toBe('approved');
    expect(planStatusFrom([I('PLANNED', false), I('PLANNED', false)])).toBe('draft');
  });

  it('planStatusFrom 행렬: 항목 2개의 모든 상태 조합(D19 규칙표)', () => {
    const inFlight = ['QUEUED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'CANCEL_REQUESTED'];
    const all: Array<{ status: string; activeApproval: boolean }> = [
      I('PLANNED', false),
      I('PLANNED', true),
      ...[...inFlight, 'UNKNOWN', 'BLOCKED', 'CONFIRMED', 'FAILED', 'CANCELED'].map((st) => I(st)),
    ];
    // 규칙표(우선순위 순): 진행 중 → executing / 모두 PLANNED → 승인 수 / 모두 CONFIRMED → completed / 모두 CANCELED → canceled /
    // CONFIRMED 있음 → partial / BLOCKED·UNKNOWN·PLANNED 있음 → attention / 나머지 → failed
    const expected = (a: { status: string; activeApproval: boolean }, b: { status: string; activeApproval: boolean }): string => {
      const st = [a.status, b.status];
      if (st.some((x) => inFlight.includes(x))) return 'executing';
      if (st.every((x) => x === 'PLANNED')) {
        const n = [a, b].filter((x) => x.activeApproval).length;
        return n === 0 ? 'draft' : n === 2 ? 'approved' : 'partially_approved';
      }
      if (st.every((x) => x === 'CONFIRMED')) return 'completed';
      if (st.every((x) => x === 'CANCELED')) return 'canceled';
      if (st.includes('CONFIRMED')) return 'partial';
      if (st.some((x) => ['BLOCKED', 'UNKNOWN', 'PLANNED'].includes(x))) return 'attention';
      return 'failed';
    };
    let n = 0;
    for (const a of all) {
      for (const b of all) {
        const got = planStatusFrom([a, b]);
        expect(got, `${a.status}/${a.activeApproval} + ${b.status}/${b.activeApproval}`).toBe(expected(a, b));
        // 순서와 무관
        expect(planStatusFrom([b, a])).toBe(got);
        // 불변식: completed 는 모두 CONFIRMED 일 때만, partial 은 CONFIRMED 가 있고 모두 CONFIRMED 는 아닐 때만
        if (got === 'completed') expect([a.status, b.status]).toEqual(['CONFIRMED', 'CONFIRMED']);
        if (got === 'partial') expect([a.status, b.status]).toContain('CONFIRMED');
        if (got === 'failed') expect([a.status, b.status].every((x) => x === 'FAILED' || x === 'CANCELED')).toBe(true);
        n++;
      }
    }
    expect(n).toBe(all.length ** 2);
  });

  it('T10 computePlanStatus 는 planStatusFrom 과 같다', () => {
    const cases = [[I('CONFIRMED'), I('FAILED')], [I('QUEUED')], [I('PLANNED', true)], [I('UNKNOWN')]];
    for (const c of cases) expect(computePlanStatus(c)).toBe(planStatusFrom(c));
  });
});

describe('tickSchema', () => {
  it('max_jobs 1~20, worker_id 형식', () => {
    expect(tickSchema.parse({})).toEqual({});
    expect(tickSchema.parse({ max_jobs: '3' })).toEqual({ max_jobs: 3 });
    expect(tickSchema.safeParse({ max_jobs: 0 }).success).toBe(false);
    expect(tickSchema.safeParse({ max_jobs: 21 }).success).toBe(false);
    expect(tickSchema.safeParse({ worker_id: 'host.example.com' }).success).toBe(false);
    expect(tickSchema.parse({ worker_id: 'demo_1' })).toEqual({ worker_id: 'demo_1' });
  });
});

describe('FIX-T11(P0) late_result 전이', () => {
  it('새 시도를 기다리는 상태(QUEUED·LEASED·RETRY_WAIT)에서 옛 시도의 늦은 결과 → RECONCILING, 그 밖에서는 불법', () => {
    for (const s of ['QUEUED', 'LEASED', 'RETRY_WAIT'] as const) expect(transitionJobState(s, 'late_result')).toBe('RECONCILING');
    for (const s of ['SENDING', 'CONFIRMED', 'UNKNOWN', 'BLOCKED'] as const) expect(canTransitionJob(s, 'late_result')).toBe(false);
  });
});

describe('T14(D26) resume·local_rate_limited 전이, 로컬 요청 제한, 시나리오 적용', () => {
  it('resume 은 조회 상태(RECONCILING·REMOTE_PROCESSING)에서만 RETRY_WAIT, UNKNOWN·CANCEL_REQUESTED·전송 상태에서는 불법', () => {
    expect(transitionJobState('RECONCILING', 'resume')).toBe('RETRY_WAIT');
    expect(transitionJobState('REMOTE_PROCESSING', 'resume')).toBe('RETRY_WAIT');
    for (const s of ['UNKNOWN', 'CANCEL_REQUESTED', 'SENDING', 'QUEUED', 'BLOCKED', 'CONFIRMED'] as const) expect(canTransitionJob(s, 'resume')).toBe(false);
  });
  it('FIX-T15 upload_yield 는 SENDING(조각 예산 소진)에서만 RETRY_WAIT, 조회·취소·대기 상태에서는 불법; web tick 예산은 조각 1개', () => {
    expect(transitionJobState('SENDING', 'upload_yield')).toBe('RETRY_WAIT');
    for (const s of ['LEASED', 'REMOTE_PROCESSING', 'RECONCILING', 'CANCEL_REQUESTED', 'RETRY_WAIT', 'QUEUED', 'UNKNOWN', 'CONFIRMED'] as const) {
      expect(canTransitionJob(s, 'upload_yield')).toBe(false);
    }
    expect(WEB_TICK_UPLOAD_SLICE).toEqual({ max_bytes: 1, max_ms: 5000 });
    expect(Object.isFrozen(WEB_TICK_UPLOAD_SLICE)).toBe(true);
  });
  it('local_rate_limited 는 LEASED(전송 의도 전)에서만 RETRY_WAIT', () => {
    expect(transitionJobState('LEASED', 'local_rate_limited')).toBe('RETRY_WAIT');
    for (const s of ['SENDING', 'QUEUED', 'RETRY_WAIT', 'RECONCILING'] as const) expect(canTransitionJob(s, 'local_rate_limited')).toBe(false);
  });
  it('localRateLimitDecision: 창 안 사용 + 이번 단위 > 한도면 가장 오래된 사용 + 창까지 대기, 사용 0 이면 허용', () => {
    const limit = { max_units: 3, window_sec: 3600 };
    const oldest = new Date(NOW.getTime() - 600_000);
    expect(localRateLimitDecision({ used: 1, needed: 2, limit, oldestAt: oldest, now: NOW })).toEqual({ allowed: true });
    const d = localRateLimitDecision({ used: 2, needed: 2, limit, oldestAt: oldest, now: NOW });
    expect(d).toEqual({ allowed: false, resetAt: new Date(oldest.getTime() + 3600_000) });
    expect(localRateLimitDecision({ used: 0, needed: 9, limit, oldestAt: null, now: NOW })).toEqual({ allowed: true });
    expect(localRateLimitDecision({ used: 5, needed: 0, limit, oldestAt: oldest, now: NOW })).toEqual({ allowed: true });
    // 창이 이미 지난 기록만 남은 경우에도 resetAt 은 지금 이후
    const stale = localRateLimitDecision({ used: 3, needed: 1, limit, oldestAt: new Date(NOW.getTime() - 7200_000), now: NOW });
    expect(stale.allowed).toBe(false);
    if (!stale.allowed) expect(stale.resetAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
  it('FIX-T14 round 2 missed: 정확히 한도는 허용·한 단위 넘으면 대기, 빈 창의 needed > max 는 (D26 예외로) 허용, 서로 다른 시각에 만료되는 기록은 재검사 때 다음 기록 기준', () => {
    const limit = { max_units: 3, window_sec: 3600 };
    const oldest = new Date(NOW.getTime() - 600_000);
    expect(localRateLimitDecision({ used: 1, needed: 2, limit, oldestAt: oldest, now: NOW })).toEqual({ allowed: true }); // 1 + 2 = 3 = 한도
    expect(localRateLimitDecision({ used: 3, needed: 1, limit, oldestAt: oldest, now: NOW }).allowed).toBe(false); // 3 + 1 > 3
    expect(localRateLimitDecision({ used: 0, needed: 3, limit, oldestAt: null, now: NOW })).toEqual({ allowed: true });
    // 현재 D26 예외: 창이 비면 한도보다 큰 작업도 허용(영원히 막히지 않게) — 엄격한 상한과 양립하지 않음(인계 질문으로 남김)
    expect(localRateLimitDecision({ used: 0, needed: 4, limit, oldestAt: null, now: NOW })).toEqual({ allowed: true });
    // 미끄러지는 창: 기록 3개(−50분·−30분·−10분), 이번 2개. 첫 대기는 가장 오래된 기록 만료(+10분)까지, 그때 다시 보면 남은 2개 + 2 > 3 → 다음 기록(+30분)까지.
    const at = [-50, -30, -10].map((m) => new Date(NOW.getTime() + m * 60_000));
    const decideAt = (now: Date) => {
      const inWindow = at.filter((t) => t.getTime() > now.getTime() - 3600_000);
      return localRateLimitDecision({ used: inWindow.length, needed: 2, limit, oldestAt: inWindow[0] ?? null, now });
    };
    // 창 경계: 정확히 창 길이만큼 지난 기록은 빠진다(DB 도 created_at > since) — resetAt 에 다시 보면 그 기록은 실제로 풀려 있다.
    const d1 = decideAt(NOW);
    expect(d1).toEqual({ allowed: false, resetAt: new Date(NOW.getTime() + 10 * 60_000) });
    const d2 = decideAt((d1 as { resetAt: Date }).resetAt);
    expect(d2).toEqual({ allowed: false, resetAt: new Date(NOW.getTime() + 30 * 60_000) });
    expect(decideAt((d2 as { resetAt: Date }).resetAt)).toEqual({ allowed: true }); // 남은 1 + 2 = 3
  });
  it('scenarioApplies: threads_* 는 mock_threads 에만, 일반 시나리오는 mock_generic 에만, success 는 둘 다', () => {
    expect(scenarioApplies('mock_threads', 'threads_thread_partial')).toBe(true);
    expect(scenarioApplies('mock_threads', 'ambiguous_sent')).toBe(false);
    expect(scenarioApplies('mock_generic', 'threads_success')).toBe(false);
    expect(scenarioApplies('mock_generic', 'ambiguous_sent')).toBe(true);
    expect(scenarioApplies('mock_threads', 'success')).toBe(true);
    expect(THREADS_MOCK_SCENARIOS).toHaveLength(8);
    for (const s of THREADS_MOCK_SCENARIOS) expect(MOCK_SCENARIO_VALUES).toContain(s);
  });
});

// ---- T15(D27) ----

describe('T15(D27) 전이·재시도 시각·단계 상태', () => {
  it('CANCEL_REQUESTED 에서 원격 처리 실패 확인 → FAILED(취소 성공이라고 하지 않음), UNKNOWN 에는 여전히 재전송 전이 없음', () => {
    expect(canT15('CANCEL_REQUESTED', 'permanent_failure')).toBe(true);
    expect(canT15('UNKNOWN', 'lease')).toBe(false);
    expect(canT15('UNKNOWN', 'resume')).toBe(false);
  });
  it('decideRetryAt: 한도 안이면 그 시각(최소 지금 + 1초), 한도면 FAILED — Retry-After 1시간 상한을 쓰지 않는다', () => {
    const now = new Date('2026-10-02T10:00:00Z');
    const at = new Date('2026-10-03T07:00:00Z');
    expect(decideRetryAtT15(1, 5, at, now)).toEqual({ retry: true, nextRunAt: at });
    expect(decideRetryAtT15(1, 5, new Date(now.getTime() - 5000), now)).toEqual({ retry: true, nextRunAt: new Date(now.getTime() + 1000) });
    expect(decideRetryAtT15(5, 5, at, now)).toEqual({ retry: false, reason: 'max_attempts' });
  });
  it('단계 종류별 상태(DB CHECK 와 같은 표)', () => {
    expect(KS15.upload_session).toEqual(['created', 'finished', 'expired', 'error']);
    expect(KS15.video).toEqual(['uploaded', 'processed', 'error']);
    expect(KS15.publish).toEqual(['published']);
  });
});

describe('FIX-T14(Codex review-T14): 기록된 어댑터 해석·처리 지연 재개·부분 취소 전이', () => {
  it('adapter_id 없음·null → mock_generic(legacy, 현재 계정 상태로 대신하지 않음), 아는 ID 그대로, 모르는 값 → null', () => {
    expect(recordedAdapterIdOf(undefined)).toEqual({ id: LEGACY_SEND_ADAPTER_ID, legacy: true });
    expect(recordedAdapterIdOf({ mode: 'MOCK' })).toEqual({ id: 'mock_generic', legacy: true });
    expect(recordedAdapterIdOf({ adapter_id: null })).toEqual({ id: 'mock_generic', legacy: true });
    expect(recordedAdapterIdOf({ adapter_id: 'mock_threads' })).toEqual({ id: 'mock_threads', legacy: false });
    // LIVE-P1(D38): live_threads 는 이제 아는 어댑터(실제 Threads 게시) — 모르는 값의 예는 live_youtube 로 바꿨다(단언 의미 그대로)
    expect(recordedAdapterIdOf({ adapter_id: 'live_threads' })).toEqual({ id: 'live_threads', legacy: false });
    expect(recordedAdapterIdOf({ adapter_id: 'live_youtube' })).toMatchObject({ id: null });
    expect(recordedAdapterIdOf({ adapter_id: 7 })).toMatchObject({ id: null });
  });
  it('센 시도 = attempt − resume_count(음수 없음), 상한 상수', () => {
    expect(countedAttempts({ attempt: 6, resumeCount: 4 })).toBe(2);
    expect(countedAttempts({ attempt: 3 })).toBe(3);
    expect(countedAttempts({ attempt: 1, resumeCount: 5 })).toBe(0);
    expect(FREE_RESUME_MAX).toBe(20);
  });
  it('cancel_partial 은 아직 시작하지 않은 상태(QUEUED·RETRY_WAIT·BLOCKED)에서만 UNKNOWN', () => {
    for (const s of ['QUEUED', 'RETRY_WAIT', 'BLOCKED'] as const) expect(transitionJobState(s, 'cancel_partial')).toBe('UNKNOWN');
    for (const s of ['LEASED', 'SENDING', 'RECONCILING', 'REMOTE_PROCESSING', 'CANCEL_REQUESTED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'CANCELED'] as const) {
      expect(canTransitionJob(s, 'cancel_partial')).toBe(false);
    }
  });
});

describe('T21-P2 isScheduleStale (docs/07 오래 지난 예약)', () => {
  it('예약 없음 → false, 60분 이하 → false, 60분 초과 → true', async () => {
    const { isScheduleStale, SCHEDULE_STALE_GRACE_MS } = await import('./jobs');
    expect(SCHEDULE_STALE_GRACE_MS).toBe(60 * 60_000);
    const at = new Date('2026-10-12T09:00:00.000Z');
    expect(isScheduleStale(null, at)).toBe(false);
    expect(isScheduleStale(at, new Date(at.getTime() - 60_000))).toBe(false); // 아직 예약 전
    expect(isScheduleStale(at, at)).toBe(false);
    expect(isScheduleStale(at, new Date(at.getTime() + SCHEDULE_STALE_GRACE_MS))).toBe(false); // 경계값
    expect(isScheduleStale(at, new Date(at.getTime() + SCHEDULE_STALE_GRACE_MS + 1))).toBe(true);
    expect(isScheduleStale(at, new Date(at.getTime() + 3 * 24 * 3600_000))).toBe(true);
  });
});

describe('FIX1-T21P2 staleScheduleConfirmedBy (오래 지난 예약 확인은 schedule_stale 차단 뒤의 명시적 확인만)', () => {
  const target = { approvalId: 'a1', payloadHash: 'h1', scheduledAtUtc: '2026-10-12T09:00:00.000Z' };
  const block = (seq: number, reason = 'schedule_stale') => ({ eventSeq: seq, details: { event: 'blocked', reason } });
  const confirm = (seq: number, over: Record<string, unknown> = {}) => ({
    eventSeq: seq,
    details: {
      event: 'unblock',
      cause: 'user_retry',
      stale_schedule_confirmed: true,
      approval_id: 'a1',
      confirmed_payload_hash: 'h1',
      confirmed_scheduled_at_utc: '2026-10-12T09:00:00.000Z',
      ...over,
    },
  });
  it('차단 → 같은 승인·내용·예약의 확인 → 인정', async () => {
    const { staleScheduleConfirmedBy } = await import('./jobs');
    expect(staleScheduleConfirmedBy([block(2), confirm(3)], target)).toBe(true);
    // 확인 뒤 다른 사유 차단·일반 재시도가 있어도 같은 대상이면 인정
    expect(staleScheduleConfirmedBy([block(2), confirm(3), block(4, 'credential_blocked'), { eventSeq: 5, details: { event: 'unblock', cause: 'user_retry' } }], target)).toBe(true);
  });
  it('인정하지 않음: 차단 없음 / 일반 unblock / 다른 승인·내용·예약 / 확인 플래그 없음 / 마지막 차단보다 앞선 확인', async () => {
    const { staleScheduleConfirmedBy } = await import('./jobs');
    expect(staleScheduleConfirmedBy([], target)).toBe(false);
    expect(staleScheduleConfirmedBy([confirm(3)], target)).toBe(false);
    expect(staleScheduleConfirmedBy([block(2, 'credential_blocked'), { eventSeq: 3, details: { event: 'unblock', cause: 'user_retry', approval_id: 'a1' } }], target)).toBe(false);
    expect(staleScheduleConfirmedBy([block(2), confirm(3, { approval_id: 'a2' })], target)).toBe(false);
    expect(staleScheduleConfirmedBy([block(2), confirm(3, { confirmed_payload_hash: 'h2' })], target)).toBe(false);
    expect(staleScheduleConfirmedBy([block(2), confirm(3, { confirmed_scheduled_at_utc: '2026-10-12T08:00:00.000Z' })], target)).toBe(false);
    expect(staleScheduleConfirmedBy([block(2), confirm(3, { stale_schedule_confirmed: 'true' })], target)).toBe(false);
    expect(staleScheduleConfirmedBy([block(2), confirm(3, { cause: 'system' })], target)).toBe(false);
    expect(staleScheduleConfirmedBy([block(2), confirm(3), block(4)], target)).toBe(false); // 확인 뒤 다시 오래 지난 예약으로 차단 → 새 확인 필요
  });
});

describe('FIX-LIVEP2 resumeProvenRetryable (결과 불명 의도가 남은 보류 작업 재시도는 조회 resume 증명이 있을 때만)', () => {
  let seq = 0;
  const ev = (details: Record<string, unknown>) => ({ eventSeq: ++seq, details });
  const ambiguous = () => ev({ event: 'ambiguous', attempt: 1, error_code: 'container_status_unreadable' });
  const resume = (over: Record<string, unknown> = {}) => ev({ event: 'resume', attempt: 1, reconcile: 'resumable', published_parts: 0, ...over });
  const lease = () => ev({ event: 'lease' });
  const blocked = (reason: string, over: Record<string, unknown> = {}) => ev({ event: 'blocked', reason, not_sent: true, ...over });
  const unblock = () => ev({ event: 'unblock', cause: 'user_retry' });

  it('인정: resume → lease → 중지·일일 상한·연결 정보 보류(not_sent), 그 사이 사용자 재시도·다시 보류·요청 제한 대기·전송 전 lease 만료가 있어도', async () => {
    const { resumeProvenRetryable, RESUME_PROVEN_RETRY_BLOCK_REASONS } = await import('./jobs');
    expect([...RESUME_PROVEN_RETRY_BLOCK_REASONS]).toEqual(['live_publish_paused', 'live_publish_daily_limit', 'credential_blocked']);
    for (const reason of RESUME_PROVEN_RETRY_BLOCK_REASONS) {
      expect(resumeProvenRetryable([ambiguous(), resume(), lease(), blocked(reason)], 1)).toBe(true);
    }
    expect(
      resumeProvenRetryable(
        [
          ambiguous(),
          resume(),
          lease(),
          ev({ event: 'local_rate_limited', not_sent: true }),
          lease(),
          ev({ event: 'lease_expired_before_intent' }),
          lease(),
          blocked('live_publish_paused'),
          unblock(),
          lease(),
          blocked('live_publish_daily_limit', { used: 3, limit: 3 }),
        ],
        1,
      ),
    ).toBe(true);
    // 순서와 무관(eventSeq 로 정렬)
    const evs = [ambiguous(), resume(), lease(), blocked('live_publish_paused')];
    expect(resumeProvenRetryable([...evs].reverse(), 1)).toBe(true);
  });

  it('인정하지 않음: resume 없음 / 다른 사유·not_sent 없는 보류 / resume 뒤 새 시도(send_start) / 다른 attempt 의 resume / resumable 아닌 resume / 마지막 사건이 보류 아님', async () => {
    const { resumeProvenRetryable } = await import('./jobs');
    expect(resumeProvenRetryable([], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), blocked('live_publish_paused')], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), ev({ event: 'reconcile_retry', checks: 1 }), lease(), blocked('live_publish_paused')], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), blocked('adapter_changed')], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), blocked('live_publish_limit')], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), blocked('live_publish_paused', { not_sent: false })], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), ev({ event: 'blocked', reason: 'execution_not_allowed', code: 'publish_disabled' })], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), ev({ event: 'send_start', attempt: 2 }), ev({ event: 'ambiguous', attempt: 2 }), lease(), blocked('live_publish_paused')], 2)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), blocked('live_publish_paused')], 2)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume({ reconcile: 'unknown' }), lease(), blocked('live_publish_paused')], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), blocked('live_publish_paused'), unblock()], 1)).toBe(false);
    expect(resumeProvenRetryable([ambiguous(), resume(), lease(), blocked('live_publish_paused'), ev({ event: 'unblock', cause: 'system' }), lease(), blocked('live_publish_paused')], 1)).toBe(false);
  });
});

describe('FIX2-FULLREV(Q3) restoredCancelNotSentProven (복원한 작업의 취소는 기록이 "보내지 않음"을 증명할 때만 not_sent)', () => {
  const intent = (outcome: string, adapterId?: string | null) => ({ outcome, sanitizedDetails: adapterId === undefined ? { mode: 'MOCK' } : { adapter_id: adapterId } });
  it('증명됨: 전송 의도 없음 · 일반 모의 어댑터(옛 의도 포함) 의 확정 거절만 · 단계가 필요한 어댑터는 게시 근거 없는 단계 기록이 함께 있고 모두 확정 거절', async () => {
    const { restoredCancelNotSentProven, PUBLISH_EVIDENCE_STEP_KINDS } = await import('./jobs');
    expect([...PUBLISH_EVIDENCE_STEP_KINDS].sort()).toEqual(['ig_publish', 'publish', 'publish_attempt', 'video']);
    expect(restoredCancelNotSentProven({ intents: [], stepKinds: [] })).toBe(true);
    expect(restoredCancelNotSentProven({ intents: [], stepKinds: ['container'] })).toBe(true);
    expect(restoredCancelNotSentProven({ intents: [intent('rejected')], stepKinds: [] })).toBe(true);
    expect(restoredCancelNotSentProven({ intents: [intent('rejected', null), intent('rejected', 'mock_generic')], stepKinds: [] })).toBe(true);
    expect(restoredCancelNotSentProven({ intents: [intent('rejected', 'mock_threads')], stepKinds: ['container'] })).toBe(true);
    expect(restoredCancelNotSentProven({ intents: [intent('rejected', 'mock_youtube')], stepKinds: ['upload_session'] })).toBe(true);
    expect(restoredCancelNotSentProven({ intents: [intent('rejected', 'live_threads')], stepKinds: ['container'] })).toBe(true);
  });
  it('증명 안 됨: 게시 근거 단계 · 결과 불명·받아들여진 의도 · 단계가 필요한 어댑터인데 단계 기록 없음(0031 이전 묶음) · 기록된 어댑터를 모름', async () => {
    const { restoredCancelNotSentProven } = await import('./jobs');
    for (const k of ['publish', 'video', 'ig_publish', 'publish_attempt']) {
      expect(restoredCancelNotSentProven({ intents: [intent('rejected', 'mock_threads')], stepKinds: ['container', k] }), k).toBe(false);
      expect(restoredCancelNotSentProven({ intents: [], stepKinds: [k] }), `no intents/${k}`).toBe(false);
    }
    for (const o of ['pending', 'ambiguous', 'accepted']) {
      expect(restoredCancelNotSentProven({ intents: [intent('rejected'), intent(o)], stepKinds: [] }), o).toBe(false);
      expect(restoredCancelNotSentProven({ intents: [intent(o, 'mock_threads')], stepKinds: ['container'] }), `threads/${o}`).toBe(false);
    }
    for (const a of ['mock_threads', 'mock_youtube', 'mock_instagram', 'live_threads', 'live_youtube']) {
      expect(restoredCancelNotSentProven({ intents: [intent('rejected', a)], stepKinds: [] }), a).toBe(false);
      expect(restoredCancelNotSentProven({ intents: [intent('rejected', 'mock_generic'), intent('rejected', a)], stepKinds: [] }), `mixed/${a}`).toBe(false);
    }
  });
});
