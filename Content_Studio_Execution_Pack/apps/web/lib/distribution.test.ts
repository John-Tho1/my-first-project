/**
 * FIX-T12(P2, Codex review-T12 lib/distribution.ts:269) · FIX-T11(P2): 보류 이유는 구조화된 코드로 판단하고 상세 사유는 따로 보인다,
 * 스냅샷이 바뀌어 다시 승인할 수 없으면 새 계획 안내, 승인 철회 안내는 저장된 작업 결과 수만 말한다.
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_BLOCK_REASONS, blockDetailLabel, blockInfoOf, itemHeadline, revocationCountParam, revocationNotice } from './distribution';

const job = (state: string, lastErrorCode: string | null) => ({ state, attempt: 1, maxAttempts: 5, nextRunAt: new Date('2030-01-01T00:00:00Z'), lastErrorCode });
const ev = (details: Record<string, unknown>) => [
  { stateAfter: 'BLOCKED', sanitizedDetails: details },
  { stateAfter: 'QUEUED', sanitizedDetails: { event: 'execute' } },
];

describe('blockInfoOf — 표준 코드와 상세 사유 분리', () => {
  it('RETRY_WAIT 첨부 변경 무효화: 이벤트 event=approval_invalidated·reason=invalidated:assets_changed → code 는 승인 코드, detail 은 상세', () => {
    const b = blockInfoOf(ev({ event: 'approval_invalidated', reason: 'invalidated:assets_changed', transition: 'blocked' }), job('BLOCKED', 'approval_invalidated'));
    expect(b).toEqual({ code: 'approval_invalidated', detail: 'invalidated:assets_changed' });
    // 수정 전(blockReasonOf)은 reason 을 먼저 돌려줘 'invalidated:assets_changed' 가 승인 코드를 가렸다
    const headline = itemHeadline({ status: 'PLANNED', channel: 'threads', job: job('BLOCKED', 'approval_invalidated'), pub: null, blockReason: b.code, blockDetail: b.detail });
    expect(headline).toBe('승인 없음 (첨부 파일이 바뀜) — 다시 승인 후 실행');
  });
  it('사용자 철회: reason=user → detail 사용자 철회', () => {
    const b = blockInfoOf(ev({ event: 'approval_revoked', reason: 'user: 날짜 변경' }), job('BLOCKED', 'approval_revoked'));
    expect(b.code).toBe('approval_revoked');
    expect(blockDetailLabel(b.detail)).toBe('사용자 철회: 날짜 변경');
  });
  it('전송 전 재검사(event=blocked, reason=approval_missing)·401 보류(reason=auth)는 예전과 같은 코드', () => {
    expect(blockInfoOf(ev({ event: 'blocked', reason: 'approval_missing' }), job('BLOCKED', 'approval_missing'))).toEqual({ code: 'approval_missing', detail: null });
    expect(blockInfoOf(ev({ event: 'blocked', reason: 'auth' }), job('BLOCKED', 'mock_401_unauthorized')).code).toBe('auth');
    expect(blockInfoOf([], null)).toEqual({ code: null, detail: null });
  });
});

describe('itemHeadline — 승인 문제·새 계획 안내', () => {
  it('401 보류 뒤 편집으로 승인 무효(항목 PLANNED, 작업 BLOCKED, 활성 승인 없음, 스냅샷 변경) → 새 계획 만들기', () => {
    const b = blockInfoOf(ev({ event: 'blocked', reason: 'auth' }), job('BLOCKED', 'mock_401_unauthorized'));
    const h = itemHeadline({
      status: 'PLANNED',
      channel: 'blog',
      job: job('BLOCKED', 'mock_401_unauthorized'),
      pub: null,
      blockReason: b.code,
      blockDetail: null,
      activeApproval: false,
      needsNewPlan: true,
    });
    expect(h).toContain('승인 무효');
    expect(h).toContain('새 계획 만들기');
  });
  it('작업 없는 PLANNED·활성 승인 있는 PLANNED 는 계획됨', () => {
    expect(itemHeadline({ status: 'PLANNED', channel: 'threads', job: null, pub: null, blockReason: null, activeApproval: false })).toBe('계획됨(실행 전)');
    expect(itemHeadline({ status: 'PLANNED', channel: 'threads', job: job('BLOCKED', 'auth'), pub: null, blockReason: 'auth', activeApproval: true })).toBe('계획됨(실행 전)');
  });
});

describe('revocationNotice — 저장된 작업 결과만 말한다', () => {
  it('보류·취소 확인 중·작업 없음·수 없음', () => {
    expect(revocationNotice(1, 0)).toContain('보류(BLOCKED) — 다음 전송이 차단');
    const c = revocationNotice(0, 1);
    expect(c).toContain('취소 확인 중');
    expect(c).not.toContain('보류');
    expect(revocationNotice(0, 0)).toContain('대기 중이던 작업은 없었습니다');
    expect(revocationNotice(null, null)).toBe('승인을 철회했습니다(MOCK).');
  });
});

describe('FIX round 2 (Codex review-FIX-T11T12) P2', () => {
  it('철회 리다이렉트 파라미터를 페이지와 같은 파싱(revocationCountParam)으로: revoked_blocked=0&revoked_cancel=1 → 취소 확인 중', () => {
    const q = new URL('http://localhost:3000/distribute/p?revoked=1&revoked_blocked=0&revoked_cancel=1').searchParams;
    const blocked = revocationCountParam(q.get('revoked_blocked') ?? undefined);
    const cancel = revocationCountParam(q.get('revoked_cancel') ?? undefined);
    expect([blocked, cancel]).toEqual([0, 1]);
    expect(revocationNotice(blocked, cancel)).toContain('취소 확인 중');
    for (const bad of [undefined, '', 'x', '-1', '1.5', '1234', ['1']]) expect(revocationCountParam(bad as string | string[] | undefined), String(bad)).toBeNull();
    expect(revocationCountParam(' 12 ')).toBe(12);
  });

  it('활성 승인이 있으면(다시 승인함) 과거 보류 사유와 관계없이 "승인 없음"이라고 하지 않는다 — activeApproval × 승인 관련 코드 행렬', () => {
    for (const code of [...APPROVAL_BLOCK_REASONS]) {
      for (const active of [true, false]) {
        const h = itemHeadline({ status: 'PLANNED', channel: 'threads', job: job('BLOCKED', code), pub: null, blockReason: code, blockDetail: null, activeApproval: active });
        if (active) expect(h, code).toBe('계획됨(실행 전)');
        else expect(h, code).toBe('승인 없음 — 다시 승인 후 실행');
      }
    }
  });
});
