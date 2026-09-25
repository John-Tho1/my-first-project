import { describe, expect, it } from 'vitest';
import {
  ACTIVE_JOB_STATES,
  canTransitionJob,
  classifyOutcome,
  decideRetry,
  IllegalJobTransitionError,
  itemStatusForJob,
  JOB_EVENTS,
  JOB_STATES,
  JOB_TRANSITIONS,
  planStatusFrom,
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
    expect(Object.keys(JOB_TRANSITIONS.UNKNOWN).sort()).toEqual(['reconcile_retry', 'reconciled_found', 'remote_accepted']);
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
