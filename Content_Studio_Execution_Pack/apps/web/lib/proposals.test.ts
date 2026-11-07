import { describe, expect, it } from 'vitest';
import { proposalActions } from './proposals';

describe('proposalActions(FIX-T09 round 2: 무시는 채택 가능 여부와 따로)', () => {
  const run = (over: Partial<{ status: string; proposalStatus: string; inputVersionId: string }> = {}) => ({
    status: 'succeeded',
    proposalStatus: 'proposed',
    inputVersionId: 'v1',
    ...over,
  });
  it('현재 버전 기준 제안: 채택·무시 모두 가능', () => {
    expect(proposalActions(run(), { hasProposal: true, currentVersionId: 'v1', adopted: false })).toEqual({ canAdopt: true, canDismiss: true });
  });
  it('원고가 바뀐(오래된) 제안: 채택은 불가, 무시는 가능', () => {
    expect(proposalActions(run(), { hasProposal: true, currentVersionId: 'v2', adopted: false })).toEqual({ canAdopt: false, canDismiss: true });
  });
  it('이미 채택·무시·실패한 run: 둘 다 불가', () => {
    expect(proposalActions(run({ proposalStatus: 'adopted' }), { hasProposal: true, currentVersionId: 'v1', adopted: true })).toEqual({ canAdopt: false, canDismiss: false });
    expect(proposalActions(run({ proposalStatus: 'dismissed' }), { hasProposal: true, currentVersionId: 'v1', adopted: false })).toEqual({ canAdopt: false, canDismiss: false });
    expect(proposalActions(run({ status: 'failed' }), { hasProposal: false, currentVersionId: 'v1', adopted: false })).toEqual({ canAdopt: false, canDismiss: false });
    expect(proposalActions(null, { hasProposal: false, currentVersionId: 'v1', adopted: false })).toEqual({ canAdopt: false, canDismiss: false });
  });
});
