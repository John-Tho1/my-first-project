/**
 * FIX-UICLEAN(Codex review-UI-CLEAN P1 + 오래된 MOCK 문구): 실제/MOCK 안내 문구를 실제 계정·기록 상태에서 고르는 순수 함수.
 */
import { describe, expect, it } from 'vitest';
import {
  accountModeOf,
  mixedResultSuffix,
  opsAccountsNote,
  opsJobsTag,
  opsJobsTagClass,
  LIVE_TAG_CLASS,
  MOCK_TAG_CLASS,
  planCreatedBanner,
  planRowTag,
  planStatusText,
  retriedBanner,
  itemIsLive,
  itemStatusText,
  jobStatusTextFor,
  requestedResultLabel,
  revocationNoticeFor,
} from './record-labels';
import {
  ITEM_STATUS_LABEL,
  jobStatusText,
  REQUESTED_RESULT_LABEL,
  revocationNotice,
  UNKNOWN_JOB_LINE_PARTIAL_MOCK,
  UNKNOWN_JOB_LINE_RESTORED_UNVERIFIED_MOCK,
} from './distribution';

describe('accountModeOf — 지금 계정 상태', () => {
  it('없음 · 모의만 · 실제 계정(대상 미지정) · 실제 게시 대상 있음', () => {
    expect(accountModeOf([])).toBe('none');
    expect(accountModeOf([{ mock: true }, { mock: true, live_publish_target: false }])).toBe('mock_only');
    expect(accountModeOf([{ mock: true }, { mock: false, live_publish_target: false }])).toBe('live_no_target');
    expect(accountModeOf([{ mock: false }])).toBe('live_no_target');
    expect(accountModeOf([{ mock: true }, { mock: false, live_publish_target: false }, { mock: false, live_publish_target: true }])).toBe('live_target');
  });
  it('모의 계정의 live_publish_target 값은 무시(모의 계정은 실제 게시 대상이 될 수 없음)', () => {
    expect(accountModeOf([{ mock: true, live_publish_target: true }])).toBe('mock_only');
  });
});

describe('운영 화면 문구', () => {
  it('계정 연결 한 줄: 모의만일 때만 "모두 모의(MOCK)"', () => {
    expect(opsAccountsNote('mock_only')).toBe('현재 연결은 모두 모의(MOCK)입니다.');
    expect(opsAccountsNote('live_no_target')).toContain('실제 게시 대상 미지정');
    expect(opsAccountsNote('live_no_target')).not.toContain('MOCK');
    expect(opsAccountsNote('live_target')).toContain('실제로 게시');
    expect(opsAccountsNote('live_target')).not.toContain('모두 모의');
    expect(opsAccountsNote('none')).toBe('배포 계정이 없습니다.');
  });
  it('배포 작업 제목 태그: 작업 기록 기준 — 실제 계정 작업이 하나라도 있으면 MOCK 이 아니다', () => {
    expect(opsJobsTag({ mock: 0, live: 0 })).toBeNull();
    expect(opsJobsTag({ mock: 3, live: 0 })).toEqual({ text: 'MOCK', warn: true });
    expect(opsJobsTag({ mock: 3, live: 1 })).toEqual({ text: '실제 게시 작업 1개 포함', warn: true });
    expect(opsJobsTag({ mock: 0, live: 2 })).toEqual({ text: '실제 게시 작업 2개 포함', warn: true });
  });
  it('DESIGN-A 배포 작업 태그 클래스: 실제 작업이 있으면 주황 실제(tag live), 모의만이면 회색 MOCK(tag mock) — opsJobsTag 와 같은 기준', () => {
    expect(LIVE_TAG_CLASS).toBe('tag live');
    expect(MOCK_TAG_CLASS).toBe('tag mock');
    expect(opsJobsTagClass({ mock: 0, live: 0 })).toBeNull();
    expect(opsJobsTagClass({ mock: 3, live: 0 })).toBe('tag mock');
    expect(opsJobsTagClass({ mock: 3, live: 1 })).toBe('tag live');
    expect(opsJobsTagClass({ mock: 0, live: 2 })).toBe('tag live');
    for (const k of [{ mock: 0, live: 0 }, { mock: 3, live: 0 }, { mock: 3, live: 1 }, { mock: 0, live: 2 }]) {
      expect(opsJobsTagClass(k) === null).toBe(opsJobsTag(k) === null);
      if (opsJobsTag(k)?.text === 'MOCK') expect(opsJobsTagClass(k)).toBe('tag mock');
    }
  });
});

describe('계획 기록 기준 문구', () => {
  it('목록 한 줄 태그: 모든 항목이 모의 계정이면 MOCK, 아니면 "실제 게시 포함", 항목 없으면 없음', () => {
    expect(planRowTag({ mock: true, itemCount: 2 })).toEqual({ text: 'MOCK', className: 'tag mock' });
    expect(planRowTag({ mock: false, itemCount: 2 })).toEqual({ text: '실제 게시 포함', className: 'tag live' });
    expect(planRowTag({ mock: true, itemCount: 0 })).toBeNull();
  });
  it('요청 결과 혼합 안내 끝말: 고를 수 있는 항목의 계정 기록으로', () => {
    expect(mixedResultSuffix([{ live: false }, { live: false }])).toBe('(MOCK — 실제 게시 아님)');
    expect(mixedResultSuffix([{ live: true }, { live: false }])).toContain('실제 계정 항목은 승인·실행하면 실제로 게시');
    expect(mixedResultSuffix([{ live: true }, { live: false }])).toContain('모의 계정 항목은 MOCK');
    expect(mixedResultSuffix([{ live: true }, { live: true }])).not.toContain('MOCK');
  });
  it('계획 생성·재시도 배너: 실제 계정 항목이 있으면 MOCK 이라고 하지 않는다', () => {
    expect(planCreatedBanner(false)).toContain('MOCK');
    expect(planCreatedBanner(true)).not.toContain('MOCK');
    expect(planCreatedBanner(true)).toContain('실제로 게시');
    expect(retriedBanner(false)).toContain('MOCK');
    expect(retriedBanner(true)).not.toContain('MOCK');
    expect(retriedBanner(true)).toContain('실제로 게시');
  });
});

describe('planStatusText — 계획 상태 문구의 MOCK 꼬리표는 그 계획 기록이 모의일 때만', () => {
  it('모의 계획은 그대로, 실제 계정이 든 계획은 MOCK 꼬리표를 뗀다(나머지 뜻은 유지)', () => {
    expect(planStatusText('처리 끝(MOCK — 실제 발행 아님)', true)).toBe('처리 끝(MOCK — 실제 발행 아님)');
    expect(planStatusText('처리 끝(MOCK — 실제 발행 아님)', false)).toBe('처리 끝');
    expect(planStatusText('처리 중(MOCK)', false)).toBe('처리 중');
    expect(planStatusText('부분 성공(MOCK — 성공한 항목은 다시 보내지 않음)', false)).toBe('부분 성공(성공한 항목은 다시 보내지 않음)');
    expect(planStatusText('승인됨(실행 전)', false)).toBe('승인됨(실행 전)');
  });
});

/**
 * FIX2-UICLEAN(브라우저 확인): 실제 Threads 항목(USER_CONFIRMED, is_mock=false)의 상태 태그가 "CONFIRMED · MOCK 확인(실제 발행 아님)" 이었다.
 * 항목·작업·요청 결과·철회 문구도 그 항목 기록(계정 kind·publications.is_mock)으로 고른다. 모의 문구는 한 글자도 바꾸지 않는다.
 */
describe('FIX2 — 항목·작업 상태 문구를 그 항목 기록으로', () => {
  it('itemStatusText: 실제 CONFIRMED = "CONFIRMED · 실제 게시 완료" + 확인 종류, MOCK 없음', () => {
    expect(itemStatusText('CONFIRMED', { live: true, verification: 'VERIFIED' })).toBe('CONFIRMED · 실제 게시 완료 · 앱 확인(VERIFIED)');
    expect(itemStatusText('CONFIRMED', { live: true, verification: 'USER_CONFIRMED' })).toBe('CONFIRMED · 실제 게시 완료 · 사용자 확인');
    expect(itemStatusText('CONFIRMED', { live: true, verification: 'UNVERIFIED' })).toBe('CONFIRMED · 실제 게시 완료 · 확인 전');
    expect(itemStatusText('CONFIRMED', { live: true, verification: null })).toBe('CONFIRMED · 실제 게시 완료 · 확인 전');
    for (const v of ['VERIFIED', 'USER_CONFIRMED', 'UNVERIFIED', null]) expect(itemStatusText('CONFIRMED', { live: true, verification: v })).not.toContain('MOCK');
  });
  it('itemStatusText: 모의 항목은 기존 문구 그대로(ITEM_STATUS_LABEL), 다른 상태도 그대로', () => {
    expect(itemStatusText('CONFIRMED', { live: false, verification: 'MOCK' })).toBe('CONFIRMED · MOCK 확인(실제 발행 아님)');
    expect(itemStatusText('CONFIRMED', { live: false })).toBe(ITEM_STATUS_LABEL.CONFIRMED);
    for (const s of Object.keys(ITEM_STATUS_LABEL).filter((k) => k !== 'CONFIRMED')) {
      expect(itemStatusText(s, { live: true })).toBe(ITEM_STATUS_LABEL[s]);
      expect(itemStatusText(s, { live: true })).not.toContain('MOCK');
      expect(itemStatusText(s, { live: false })).toBe(ITEM_STATUS_LABEL[s]);
    }
    expect(itemStatusText('WHATEVER', { live: true })).toBe('WHATEVER');
  });
  it('itemIsLive: 결과 기록(is_mock)이 있으면 그것, 없으면 항목 계정 kind', () => {
    expect(itemIsLive({ accountKind: 'live', pub: null })).toBe(true);
    expect(itemIsLive({ accountKind: 'mock', pub: null })).toBe(false);
    expect(itemIsLive({ accountKind: null, pub: { isMock: false } })).toBe(true);
    expect(itemIsLive({ accountKind: 'live', pub: { isMock: false } })).toBe(true);
    expect(itemIsLive({ accountKind: 'mock', pub: { isMock: true } })).toBe(false);
  });
  it('jobStatusTextFor: 실제 작업이 CONFIRMED 인데 그 작업의 결과 기록이 없으면 MOCK 이라고 하지 않는다(모의는 기존 그대로)', () => {
    const job = { state: 'CONFIRMED', attempt: 1, maxAttempts: 5, nextRunAt: new Date(), lastErrorCode: null } as never;
    expect(jobStatusText(job, null)).toContain('MOCK');
    expect(jobStatusTextFor(job, null, null, 'threads', false)).toBe(jobStatusText(job, null, null, 'threads'));
    const live = jobStatusTextFor(job, null, null, 'threads', true);
    expect(live).not.toContain('MOCK');
    expect(live).toContain('CONFIRMED · 실제 게시');
    const pub = { isMock: false, resultKind: 'PUBLISHED', verification: 'VERIFIED', permalink: 'https://www.threads.com/@x/post/1' } as never;
    expect(jobStatusTextFor(job, pub, null, 'threads', true)).toBe(jobStatusText(job, pub, null, 'threads'));
    expect(jobStatusTextFor(job, pub, null, 'threads', true)).not.toContain('MOCK');
  });
  it('requestedResultLabel: 실제 계정 항목은 "실제 게시(public_publish)", 모의는 REQUESTED_RESULT_LABEL 그대로', () => {
    expect(requestedResultLabel('public_publish', true)).toBe('실제 게시(public_publish)');
    expect(requestedResultLabel('public_publish', false)).toBe(REQUESTED_RESULT_LABEL.public_publish);
    expect(requestedResultLabel('mock_publish', false)).toBe(REQUESTED_RESULT_LABEL.mock_publish);
  });
  it('revocationNoticeFor: 실제 계정 항목이 있는 계획이면 "(MOCK)" 을 떼고, 모의 계획은 그대로', () => {
    const t = revocationNotice(1, 0);
    expect(revocationNoticeFor(t, false)).toBe(t);
    expect(revocationNoticeFor(t, true)).not.toContain('MOCK');
    expect(revocationNoticeFor(t, true)).toContain('승인을 철회했습니다.');
    expect(revocationNoticeFor(t, true)).toContain('보류(BLOCKED) — 다음 전송이 차단');
  });
});

/**
 * FIX2-FULLREV(Q2): 부분 게시(thread_partial_*)·복원 취소 미확정(restored_cancel_unverified) UNKNOWN 의 상태 태그는 "재확인 또는 새 계획 필요"가 아니다
 * (새 계획은 게시된 부분을 처음부터 다시 게시). 그 밖의 UNKNOWN·다른 상태·사유 코드를 넘기지 않은 호출은 지금 문구 그대로.
 */
describe('FIX2-FULLREV(Q2) — 부분 게시 UNKNOWN 상태 태그', () => {
  // FIX2-FULLREV(FX2): thread_partial_unresolved(조회 한도 — 게시된 게시물이 있음)도 같은 부분 게시 문구
  const PARTIAL = ['thread_partial_canceled', 'thread_partial_cancel_requested', 'thread_partial_revoked', 'thread_partial_stopped', 'thread_partial_failed', 'thread_partial_unresolved'];
  it('부분 게시 사유 코드 전부: 모의 = 일부 게시됨(MOCK), 실제 = 게시됐거나 게시됐을 수 있음(MOCK 없음) — "새 계획" 없음', () => {
    for (const code of PARTIAL) {
      const mock = itemStatusText('UNKNOWN', { live: false, lastErrorCode: code });
      expect(mock, code).toBe('UNKNOWN · 일부 게시됨(MOCK) — 남은 부분은 보내지 않음, 자동 재전송 안 함(게시된 부분은 원격에 남음)');
      const live = itemStatusText('UNKNOWN', { live: true, verification: null, lastErrorCode: code });
      expect(live, code).toBe('UNKNOWN · 게시됐거나 게시됐을 수 있음 — 다시 게시하지 않음(Threads 에서 직접 확인)');
      for (const t of [mock, live]) expect(t, code).not.toContain('새 계획');
      expect(live, code).not.toContain('MOCK');
    }
  });
  it('복원 취소 미확정: 보냈는지 확인할 수 없음 — 실제는 Threads 에서 직접 확인, 모의는 MOCK(실제 채널로 보낸 것 없음 — 채널 확인 지시 없음), "새 계획" 없음', () => {
    // FIX2-FULLREV(FX4): 모의 항목은 확인할 곳이 없다(시뮬레이터는 복원되지 않음) — "채널에서 직접 확인"을 시키지 않는다
    const mock = itemStatusText('UNKNOWN', { live: false, lastErrorCode: 'restored_cancel_unverified' });
    expect(mock).toBe('UNKNOWN · 복원한 모의 작업 — 모의 전송 여부를 기록으로 확인할 수 없음, 자동 재전송 안 함(MOCK — 실제 채널로 보낸 것 없음)');
    expect(mock).not.toContain('채널에서 직접 확인');
    expect(itemStatusText('UNKNOWN', { live: true, lastErrorCode: 'restored_cancel_unverified' })).toBe(
      'UNKNOWN · 복원한 작업 — 게시됐는지 확인할 수 없음, 다시 게시하지 않음(Threads 에서 직접 확인)',
    );
  });
  it('그 밖은 지금 그대로: 부분 게시가 아닌 UNKNOWN(사유 없음·다른 사유) · UNKNOWN 이 아닌 상태(사유 코드가 남아 있어도) · 실제 CONFIRMED', () => {
    for (const code of [undefined, null, 'reconcile_timeout', 'publish_attempt_unresolved', 'restored_steps_missing', 'toString']) {
      expect(itemStatusText('UNKNOWN', { live: false, lastErrorCode: code }), String(code)).toBe(ITEM_STATUS_LABEL.UNKNOWN);
      expect(itemStatusText('UNKNOWN', { live: true, lastErrorCode: code }), String(code)).toBe(ITEM_STATUS_LABEL.UNKNOWN);
    }
    expect(ITEM_STATUS_LABEL.UNKNOWN).toBe('UNKNOWN · 확인 불가 — 자동 재전송 안 함, 재확인 또는 새 계획 필요');
    for (const s of Object.keys(ITEM_STATUS_LABEL).filter((k) => k !== 'UNKNOWN' && k !== 'CONFIRMED')) {
      for (const code of [...PARTIAL, 'restored_cancel_unverified']) expect(itemStatusText(s, { live: false, lastErrorCode: code }), `${s}/${code}`).toBe(ITEM_STATUS_LABEL[s]);
    }
    expect(itemStatusText('CONFIRMED', { live: true, verification: 'USER_CONFIRMED', lastErrorCode: 'thread_partial_canceled' })).toBe('CONFIRMED · 실제 게시 완료 · 사용자 확인');
    expect(itemStatusText('CONFIRMED', { live: false, lastErrorCode: 'thread_partial_failed' })).toBe(ITEM_STATUS_LABEL.CONFIRMED);
  });
  it('jobStatusTextFor: 부분 게시·복원 취소 미확정 UNKNOWN 작업 줄은 모의·실제 모두 "새 계획" 없음 · 실제 = 공통 줄(jobStatusText), 모의 = 모의 줄(FX4·FX6)', () => {
    for (const code of [...PARTIAL, 'restored_cancel_unverified']) {
      const job = { state: 'UNKNOWN', attempt: 1, maxAttempts: 5, nextRunAt: new Date(), lastErrorCode: code };
      for (const live of [false, true]) {
        const line = jobStatusTextFor(job, null, 'auth', 'threads', live);
        // FIX2-FULLREV(FX4·FX6): 모의 항목은 모의 줄(채널 확인 지시 없음) — 실제 항목은 jobStatusText 그대로
        if (!live) {
          expect(line, code).toBe(code === 'restored_cancel_unverified' ? UNKNOWN_JOB_LINE_RESTORED_UNVERIFIED_MOCK : UNKNOWN_JOB_LINE_PARTIAL_MOCK);
          expect(line).not.toBe(jobStatusText(job, null, 'auth', 'threads'));
          expect(line).toContain('MOCK');
          expect(line).not.toContain('채널에서 직접 확인');
        } else {
          expect(line, `${code}/${live}`).toBe(jobStatusText(job, null, 'auth', 'threads'));
        }
        expect(line, `${code}/${live}`).not.toContain('새 계획');
      }
    }
    // UNKNOWN 이 아닌 작업은 사유 코드가 남아 있어도 모의 줄로 바꾸지 않는다
    const failed = { state: 'FAILED', attempt: 1, maxAttempts: 5, nextRunAt: new Date(), lastErrorCode: 'restored_cancel_unverified' };
    expect(jobStatusTextFor(failed, null, null, 'threads', false)).toBe(jobStatusText(failed, null, null, 'threads'));
  });
});
