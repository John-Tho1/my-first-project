/**
 * LIVEP1-USERCONFIRM: "Threads에서 확인함"(사용자 확인) 판정 — 순수 함수 시험(DB·네트워크 없음).
 * 후보는 가장 최근 재확인 이력 하나만, 형식(threads:<숫자>·공식 Threads 링크)이 맞을 때만. 허용 조건이 하나라도 빠지면 정해진 코드.
 */
import { describe, expect, it } from 'vitest';
import { canTransitionJob, JOB_TRANSITIONS, PUBLICATION_VERIFICATIONS, transitionJobState } from './jobs';
import {
  USER_CONFIRM_WARNING,
  USER_CONFIRMABLE_JOB_STATES,
  UserConfirmError,
  userConfirmCandidateFromEvents,
  userConfirmProblem,
  userConfirmSchema,
  type UserConfirmFacts,
} from './user-confirm';

const ID = 'threads:18000000000123456';
const LINK = 'https://www.threads.com/@tester/post/DeeRJ-LjgdA';
const ev = (eventSeq: number, d: Record<string, unknown>) => ({ eventSeq, sanitizedDetails: d });

describe('userConfirmCandidateFromEvents — 가장 최근 재확인 이력의 후보 하나만', () => {
  it('최근 재확인이 후보(외부 ID + 공식 링크)를 남겼으면 그 후보', () => {
    const events = [ev(1, { event: 'ambiguous' }), ev(2, { reconcile: 'unknown', candidate_external_id: ID, candidate_permalink: LINK })];
    expect(userConfirmCandidateFromEvents(events)).toEqual({ external_id: ID, permalink: LINK });
  });
  it('threads.net 링크·www 없는 링크도 공식 링크', () => {
    expect(userConfirmCandidateFromEvents([ev(1, { reconcile: 'unknown', candidate_external_id: ID, candidate_permalink: 'https://threads.net/@t/post/A1' })])).toEqual({
      external_id: ID,
      permalink: 'https://threads.net/@t/post/A1',
    });
  });
  it('순서와 관계없이 event_seq 가 가장 큰 재확인 이력만 본다 — 그 재확인에 후보가 없으면 null(옛 후보를 꺼내지 않음)', () => {
    const events = [ev(5, { reconcile: 'unknown', checks: 3 }), ev(3, { reconcile: 'unknown', candidate_external_id: ID, candidate_permalink: LINK })];
    expect(userConfirmCandidateFromEvents(events)).toBeNull();
  });
  it('재확인이 아닌 나중 이력은 판단을 바꾸지 않는다', () => {
    const events = [ev(2, { reconcile: 'unknown', candidate_external_id: ID, candidate_permalink: LINK }), ev(3, { event: 'reconcile_unsupported' })];
    expect(userConfirmCandidateFromEvents(events)).toEqual({ external_id: ID, permalink: LINK });
  });
  it.each<[string, Record<string, unknown>]>([
    ['링크 없음(사용자가 열어 볼 수 없음)', { candidate_external_id: ID }],
    ['링크가 공식 Threads 가 아님', { candidate_external_id: ID, candidate_permalink: 'https://evil.example/@t/post/1' }],
    ['링크가 http', { candidate_external_id: ID, candidate_permalink: 'http://www.threads.com/@t/post/1' }],
    ['외부 ID 형식이 아님', { candidate_external_id: 'threads:abc', candidate_permalink: LINK }],
    ['외부 ID 가 모의', { candidate_external_id: 'mock:1', candidate_permalink: LINK }],
    ['외부 ID 가 여러 개(배열)', { candidate_external_id: [ID, 'threads:2'], candidate_permalink: LINK }],
    ['외부 ID 없음', { candidate_permalink: LINK }],
  ])('%s → null', (_, d) => {
    expect(userConfirmCandidateFromEvents([ev(1, { reconcile: 'unknown', ...d })])).toBeNull();
  });
  it('재확인 이력이 없으면 null', () => {
    expect(userConfirmCandidateFromEvents([])).toBeNull();
    expect(userConfirmCandidateFromEvents([ev(1, { event: 'ambiguous', candidate_external_id: ID, candidate_permalink: LINK })])).toBeNull();
  });
});

const ok: UserConfirmFacts = {
  account: { kind: 'live', platform: 'threads' },
  jobState: 'UNKNOWN',
  restored: false,
  publishAttempts: 1,
  publishSteps: 0,
  publications: 0,
  candidate: { external_id: ID, permalink: LINK },
};

describe('userConfirmProblem — 허용 조건이 모두 있을 때만 null', () => {
  it('UNKNOWN·RECONCILING + 실제 Threads + 게시 시도 표식 + 결과 없음 + 같은 후보 → 허용', () => {
    expect(USER_CONFIRMABLE_JOB_STATES).toEqual(['UNKNOWN', 'RECONCILING']);
    expect(userConfirmProblem(ok, ID)).toBeNull();
    expect(userConfirmProblem({ ...ok, jobState: 'RECONCILING' }, ID)).toBeNull();
  });
  it.each<[string, Partial<UserConfirmFacts>, string | null, string]>([
    ['모의 계정', { account: { kind: 'mock', platform: 'threads' } }, ID, 'user_confirm_not_live'],
    ['실제 계정이지만 Threads 아님', { account: { kind: 'live', platform: 'youtube' } }, ID, 'user_confirm_not_live'],
    ['계정 없음', { account: null }, ID, 'user_confirm_not_live'],
    ['이미 결과 있음', { publications: 1 }, ID, 'user_confirm_already_published'],
    ['작업 없음', { jobState: null }, ID, 'user_confirm_not_pending'],
    ['CONFIRMED', { jobState: 'CONFIRMED' }, ID, 'user_confirm_not_pending'],
    ['REMOTE_PROCESSING', { jobState: 'REMOTE_PROCESSING' }, ID, 'user_confirm_not_pending'],
    ['CANCEL_REQUESTED', { jobState: 'CANCEL_REQUESTED' }, ID, 'user_confirm_not_pending'],
    ['FAILED', { jobState: 'FAILED' }, ID, 'user_confirm_not_pending'],
    ['QUEUED', { jobState: 'QUEUED' }, ID, 'user_confirm_not_pending'],
    ['복원한 작업(읽기 전용 이력)', { restored: true }, ID, 'user_confirm_restored'],
    ['게시 시도 표식 없음', { publishAttempts: 0 }, ID, 'user_confirm_no_attempt'],
    ['게시 기록(미디어 ID)이 이미 있음 — 재확인으로 확정', { publishSteps: 1 }, ID, 'user_confirm_publish_recorded'],
    ['후보 없음', { candidate: null }, ID, 'user_confirm_no_candidate'],
    ['요청한 후보가 다름(낡은 화면)', {}, 'threads:18000000000999999', 'user_confirm_candidate_mismatch'],
    ['요청한 후보 없음', {}, null, 'user_confirm_candidate_mismatch'],
  ])('%s → %s', (_, patch, requested, code) => {
    expect(userConfirmProblem({ ...ok, ...patch }, requested)).toBe(code);
  });
  it('모의 계정은 다른 조건이 다 맞아 보여도 실제가 아님이 먼저(모의 결과는 사용자 확인이 될 수 없음)', () => {
    expect(userConfirmProblem({ ...ok, account: { kind: 'mock', platform: 'threads' }, publications: 1, jobState: 'CONFIRMED' }, ID)).toBe('user_confirm_not_live');
  });
  it('UserConfirmError 는 409 conflict + 코드', () => {
    const e = new UserConfirmError('user_confirm_no_candidate');
    expect(e.kind).toBe('conflict');
    expect(e.code).toBe('user_confirm_no_candidate');
  });
});

describe('입력·전이·문구', () => {
  it('userConfirmSchema: threads:<숫자> 만(형식이 틀리면 400 — 같은지 비교는 서버 잠금 안에서)', () => {
    expect(userConfirmSchema.safeParse({ candidate_external_id: ID }).success).toBe(true);
    for (const bad of [{}, { candidate_external_id: '' }, { candidate_external_id: 'threads:abc' }, { candidate_external_id: 'mock:1' }, { candidate_external_id: 7 }]) {
      expect(userConfirmSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('전이 user_confirmed: UNKNOWN·RECONCILING → CONFIRMED 만(전송 lease 없음)', () => {
    expect(transitionJobState('UNKNOWN', 'user_confirmed')).toBe('CONFIRMED');
    expect(transitionJobState('RECONCILING', 'user_confirmed')).toBe('CONFIRMED');
    for (const s of Object.keys(JOB_TRANSITIONS)) {
      if (s === 'UNKNOWN' || s === 'RECONCILING') continue;
      expect(canTransitionJob(s, 'user_confirmed')).toBe(false);
    }
  });
  it('확인 상태 USER_CONFIRMED 는 VERIFIED 와 다른 값', () => {
    expect(PUBLICATION_VERIFICATIONS).toContain('USER_CONFIRMED');
    expect(PUBLICATION_VERIFICATIONS).toContain('VERIFIED');
  });
  it('경고 문구', () => {
    expect(USER_CONFIRM_WARNING).toBe('후보 링크를 열어 내 글인지 직접 확인한 뒤 누르세요. 앱이 검증한 것은 아닙니다');
  });
});
