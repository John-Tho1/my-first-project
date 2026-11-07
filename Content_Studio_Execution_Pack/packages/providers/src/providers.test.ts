import { describe, expect, it } from 'vitest';
import {
  ApprovalRequiredError,
  CollectorDisabledError,
  LiveProviderNotConfiguredError,
  llmStructuredOutputSchema,
  loadConfig,
  PublishDisabledError,
} from '@cs/domain';
import {
  createProviders,
  DisabledCollector,
  DisabledPublisher,
  isStorablePublication,
  MOCK_WARNING,
  MockLlmProvider,
  toStorablePublication,
  type PublishResult,
} from './index';

describe('createProviders', () => {
  it('기본 설정: 모의 LLM + 비활성 publisher/collector', () => {
    const p = createProviders(loadConfig({}));
    expect(p.llm.mode).toBe('mock');
    expect(p.publisher).toBeInstanceOf(DisabledPublisher);
    expect(p.collector).toBeInstanceOf(DisabledCollector);
  });
  it('LLM_MODE=live 는 M0 에서 거부', () => {
    expect(() => createProviders(loadConfig({ LLM_MODE: 'live', LLM_PROVIDER: 'x', LLM_MODEL: 'y' }))).toThrow(
      LiveProviderNotConfiguredError,
    );
  });
});

describe('MockLlmProvider', () => {
  const llm = new MockLlmProvider();
  it('결정적이며 스키마를 만족한다', async () => {
    const input = { task: 'idea' as const, inputVersion: 'cap-1@1', text: '대리점과 계획을 맞춘다. 재고 리스크를 먼저 합의한다.' };
    const a = await llm.generate(input);
    const b = await llm.generate(input);
    expect(a).toEqual(b);
    expect(llmStructuredOutputSchema.safeParse(a).success).toBe(true);
    expect(a.warnings).toContain(MOCK_WARNING);
    expect(a.input_version).toBe('cap-1@1');
  });
  it('1인칭 문장은 experience + 사용자 확인 필요', async () => {
    const out = await llm.generate({ task: 'draft', inputVersion: 'v1', text: '나는 첫 달에 역할을 정했다. 역할 정의가 중요하다.' });
    const exp = out.claims.filter((c) => c.kind === 'experience');
    expect(exp.length).toBeGreaterThan(0);
    expect(exp.every((c) => c.needs_user_confirmation)).toBe(true);
    expect(out.claims.every((c) => c.source_refs.length === 0)).toBe(true);
  });
});

describe('DisabledPublisher / DisabledCollector', () => {
  it('기본 모드에서 publish 는 PublishDisabledError', async () => {
    await expect(new DisabledPublisher(loadConfig({})).publish({ payloadHash: 'h', body: 'b' })).rejects.toBeInstanceOf(
      PublishDisabledError,
    );
  });
  it('enabled 여도 승인이 없으므로 ApprovalRequiredError', async () => {
    const pub = new DisabledPublisher(loadConfig({ PUBLISH_MODE: 'enabled' }));
    await expect(pub.publish({ payloadHash: 'h', body: 'b', approvalId: 'forged' })).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
  });
  it('collector 는 CollectorDisabledError', async () => {
    await expect(new DisabledCollector(loadConfig({})).collect({ url: 'https://example.com' })).rejects.toBeInstanceOf(
      CollectorDisabledError,
    );
  });
});

describe('발행 결과 저장 관문', () => {
  const cases: PublishResult[] = [
    { kind: 'MOCK', platform: 'threads', mockId: 'm1' },
    { kind: 'DISABLED', platform: 'threads', reason: 'off' },
    { kind: 'UNKNOWN', platform: 'threads', reason: 'timeout' },
    { kind: 'PUBLISHED', platform: 'threads', externalId: 'x', verified: false },
  ];
  it.each(cases)('$kind 결과는 실제 발행 실적으로 저장 불가', (r) => {
    expect(isStorablePublication(r)).toBe(false);
    expect(() => toStorablePublication(r)).toThrow(/저장할 수 없는 결과/);
  });
  it('검증된 PUBLISHED 만 저장 가능', () => {
    expect(isStorablePublication({ kind: 'PUBLISHED', platform: 't', externalId: 'x', verified: true })).toBe(true);
  });
});
