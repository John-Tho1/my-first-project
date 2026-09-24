import { describe, expect, it } from 'vitest';
import { MOCK_WARNING, MockLlmFailure, MockLlmProvider } from './llm';

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
