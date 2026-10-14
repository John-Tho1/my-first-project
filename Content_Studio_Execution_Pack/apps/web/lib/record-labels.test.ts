/**
 * FIX-UICLEAN(Codex review-UI-CLEAN P1 + 오래된 MOCK 문구): 실제/MOCK 안내 문구를 실제 계정·기록 상태에서 고르는 순수 함수.
 */
import { describe, expect, it } from 'vitest';
import {
  accountModeOf,
  mixedResultSuffix,
  opsAccountsNote,
  opsJobsTag,
  planCreatedBanner,
  planRowTag,
  planStatusText,
  retriedBanner,
} from './record-labels';

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
});

describe('계획 기록 기준 문구', () => {
  it('목록 한 줄 태그: 모든 항목이 모의 계정이면 MOCK, 아니면 "실제 게시 포함", 항목 없으면 없음', () => {
    expect(planRowTag({ mock: true, itemCount: 2 })).toEqual({ text: 'MOCK', className: 'tag warn' });
    expect(planRowTag({ mock: false, itemCount: 2 })).toEqual({ text: '실제 게시 포함', className: 'tag warn' });
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
