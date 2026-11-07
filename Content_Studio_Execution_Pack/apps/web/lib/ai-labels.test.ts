import { describe, expect, it } from 'vitest';
import { MOCK_WARNING } from '@cs/providers';
import { assistModeText, failedSettlementLabel, resultLabel, resultOrigin, unpricedLabel, usageSourceLabel } from './ai-labels';

describe('LIVE-UI: AI 화면 문구가 실제 모드를 숨기지 않는다', () => {
  it('live 모드: 실제 호출·과금을 알리고 "모의"라고 쓰지 않는다', () => {
    const t = assistModeText('live');
    for (const s of [t.notice, t.assistButton, t.variantButton]) expect(s).not.toContain('모의');
    expect(t.notice).toContain('실제');
    expect(t.assistButton).toContain('과금');
    expect(t.variantButton).toContain('과금');
  });
  it('mock 모드: 기존 모의 경고 그대로', () => {
    const t = assistModeText('mock');
    expect(t.notice.startsWith(MOCK_WARNING)).toBe(true);
    expect(t.assistButton).toBe('모의 제안 만들기');
    expect(t.variantButton).toBe('AI 초안(모의)');
  });
  it('결과 이름표는 설정이 아니라 그 결과의 provider/createdBy 로 정한다', () => {
    expect(resultOrigin({ provider: 'mock' })).toBe('mock');
    expect(resultOrigin({ provider: 'anthropic' })).toBe('live');
    expect(resultOrigin({ createdBy: 'ai:mock' })).toBe('mock');
    expect(resultOrigin({ createdBy: 'ai:live' })).toBe('live');
    expect(resultLabel('제안', 'mock')).toBe('AI 제안(모의)');
    expect(resultLabel('초안', 'live')).toBe('AI 초안(실제 AI)');
  });
  it('FIX-LIVEUI(P2): 출처를 모르면 모의도 실제도 아닌 "출처 미확인"', () => {
    for (const by of [{}, { provider: null }, { provider: '' }, { provider: 'openai' }, { createdBy: null }, { createdBy: '' }, { createdBy: 'ai:other' }, { createdBy: 'owner' }]) {
      expect(resultOrigin(by)).toBe('unknown');
    }
    expect(resultLabel('초안', 'unknown')).toBe('AI 초안(출처 미확인)');
    // provider 가 있으면 createdBy 보다 우선(작성 보조 run 기준)
    expect(resultOrigin({ provider: 'mock', createdBy: 'ai:live' })).toBe('mock');
    expect(resultOrigin({ provider: 'unknown-x', createdBy: 'ai:live' })).toBe('unknown');
  });
  it('가격 미설정 문구: "모의"는 모의 결과에만', () => {
    expect(unpricedLabel('mock')).toBe('가격 미설정(모의 0)');
    expect(unpricedLabel('live')).not.toContain('모의');
    expect(unpricedLabel('unknown')).not.toContain('모의');
  });
  it('토큰 출처·실패 확정 문구는 원장 스냅숏 usage_source 를 따른다', () => {
    expect(usageSourceLabel({ usage_source: 'provider' })).toBe('공급자 보고');
    expect(usageSourceLabel({ usage_source: 'estimate' })).toBe('추정');
    expect(usageSourceLabel({})).toBe('추정');
    expect(usageSourceLabel(null)).toBe('추정');
    expect(usageSourceLabel({ usage_source: 'none' })).toContain('예약액');
    expect(usageSourceLabel({ usage_source: 'provider_unstorable' })).toContain('운영자');
    expect(failedSettlementLabel({ usage_source: 'provider' })).toContain('큰 값');
    expect(failedSettlementLabel({ usage_source: 'none' })).toBe('실패(예약액으로 확정)');
    expect(failedSettlementLabel(undefined)).toBe('실패(예약액으로 확정)');
  });
});
