import { describe, expect, it } from 'vitest';
import { LiveProviderNotConfiguredError, loadConfig } from '@cs/domain';
import { MOCK_WARNING, MockLlmFailure, MockLlmProvider } from './llm';
import { ClaudeLlmProvider, resolveLiveLlmProvider } from './llm-anthropic';

describe('MockLlmProvider 실패 주입(T06)', () => {
  const input = { task: 'draft' as const, inputVersion: 'cv:x;bp:1;ans:', text: '제가 직접 협상했습니다. 시장은 커지고 있다.', prompt: 'P' };

  it('기본은 실패하지 않고, 결정적이며 경고와 경험 claim 확인 표시를 담는다', async () => {
    const a = await new MockLlmProvider().generate(input);
    const b = await new MockLlmProvider().generate(input);
    expect(a).toEqual(b);
    expect(a.warnings).toContain(MOCK_WARNING);
    expect(a.input_version).toBe(input.inputVersion);
    expect(a.claims[0]).toMatchObject({ kind: 'experience', needs_user_confirmation: true });
  });

  it('프롬프트는 모의 결과에 영향을 주지 않는다(text 기준 결정성)', async () => {
    const a = await new MockLlmProvider().generate(input);
    const b = await new MockLlmProvider().generate({ ...input, prompt: '다른 프롬프트' });
    expect(b).toEqual(a);
  });

  it('fail: true 면 MockLlmFailure 로 실패한다', async () => {
    await expect(new MockLlmProvider({ fail: true }).generate(input)).rejects.toBeInstanceOf(MockLlmFailure);
  });
});

describe('live 공급자 선택(LIVE-L1 — 준비 판정 기반, 외부 호출 없음)', () => {
  const full = {
    LLM_MODE: 'live',
    LLM_PROVIDER: 'provider-x',
    LLM_MODEL: 'model-y',
    LLM_PRICE_INPUT_PER_1K: '1',
    LLM_PRICE_OUTPUT_PER_1K: '1',
    LLM_BUDGET_MONTHLY_LIMIT: '10',
    LLM_LIVE_APPROVAL_REF: 'D99',
  };
  it('anthropic 이 아닌 공급자는 다른 조건이 모두 있어도 LiveProviderNotConfiguredError(이름만, 값 없음)', () => {
    try {
      resolveLiveLlmProvider(loadConfig(full), { ANTHROPIC_API_KEY: 'sk-ant-FAKE-x' });
      throw new Error('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(LiveProviderNotConfiguredError);
      expect((e as LiveProviderNotConfiguredError).missing).toEqual(['LLM_PROVIDER=anthropic']);
      expect((e as Error).message).not.toMatch(/provider-x|model-y|D99|sk-ant/);
    }
  });
  it('승인 기록이 없으면 그 이름이 빠진 조건에 나온다', () => {
    const { LLM_LIVE_APPROVAL_REF: _omit, ...rest } = full;
    void _omit;
    try {
      resolveLiveLlmProvider(loadConfig({ ...rest, LLM_PROVIDER: 'anthropic' }), { ANTHROPIC_API_KEY: 'sk-ant-FAKE-x' });
      throw new Error('should throw');
    } catch (e) {
      expect((e as LiveProviderNotConfiguredError).missing).toEqual(['LLM_LIVE_APPROVAL_REF']);
    }
  });
  it('모두 있으면 ClaudeLlmProvider(이름 anthropic, 모델 = LLM_MODEL) — 만들기만 하고 호출하지 않는다', () => {
    const p = resolveLiveLlmProvider(loadConfig({ ...full, LLM_PROVIDER: 'anthropic' }), { ANTHROPIC_API_KEY: 'sk-ant-FAKE-x' });
    expect(p).toBeInstanceOf(ClaudeLlmProvider);
    expect([p.name, p.mode, p.model]).toEqual(['anthropic', 'live', 'model-y']);
    expect(JSON.stringify(p)).not.toContain('sk-ant');
  });
  it('모의 provider 는 허용 출처만 의견 claim 에 붙이고, 사용량은 글자/3', async () => {
    const m = new MockLlmProvider();
    const input = { task: 'draft' as const, inputVersion: 'v', text: '시장이 커지고 있다. 제가 직접 봤습니다.', prompt: 'x'.repeat(30), allowedSourceRefs: ['sv-1', 'sv-2'] };
    const out = await m.generate(input);
    expect(out.claims.find((c) => c.kind === 'opinion')!.source_refs).toEqual(['sv-1']);
    expect(out.claims.find((c) => c.kind === 'experience')!.source_refs).toEqual([]);
    expect(m.usageOf(input, out)).toEqual({ tokensIn: 10, tokensOut: Math.ceil(out.proposed_text.length / 3) });
  });
});

describe('FIX-T07: maxOutputTokens', () => {
  it('모의 provider 는 제안을 출력 상한(글자/3) 안으로 자른다', async () => {
    const m = new MockLlmProvider();
    const input = { task: 'draft' as const, inputVersion: 'v', text: '아주 긴 문장입니다 '.repeat(50), maxOutputTokens: 5 };
    const out = await m.generate(input);
    expect(out.proposed_text.length).toBeLessThanOrEqual(15);
    expect(m.usageOf(input, out).tokensOut).toBeLessThanOrEqual(5);
  });
});
