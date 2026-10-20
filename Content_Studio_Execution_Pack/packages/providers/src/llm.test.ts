import { describe, expect, it } from 'vitest';
import { LiveProviderNotConfiguredError, loadConfig } from '@cs/domain';
import { hasFirstPersonExpression, MOCK_WARNING, MockLlmFailure, MockLlmProvider, splitSentences } from './llm';
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

describe('LIVEL1-H2 — 모의 provider 의 1인칭 판별 = hasFirstPersonExpression(live 와 같은 NFC 판별)', () => {
  const NFC_TEXT = '제가 직접 협상했습니다. 시장은 커지고 있다.';

  it('NFD 1인칭 문장 → experience + 확인 필요, 출처 없음, claim 원문은 NFD 그대로', async () => {
    const text = NFC_TEXT.normalize('NFD');
    expect(text).not.toBe(text.normalize('NFC'));
    const out = await new MockLlmProvider().generate({ task: 'draft', inputVersion: 'v', text, allowedSourceRefs: ['sv-1', 'sv-2'] });
    const first = splitSentences(text)[0]!;
    expect(out.claims[0]).toEqual({ text: first, kind: 'experience', source_refs: [], needs_user_confirmation: true });
    expect(out.claims[0]!.text).not.toBe('제가 직접 협상했습니다.'); // 원문(NFD)을 바꾸지 않는다
    expect(out.claims[1]).toMatchObject({ kind: 'opinion', source_refs: ['sv-1'], needs_user_confirmation: false });
  });

  // 거짓 행에는 정규식의 다른 표현(나는·내가·나의·내 ·저는·제가·저의·제 ·우리는·우리가·직접 )이 없어야 한다 — 그 표현으로 참이 되지 않게.
  it.each<[string, boolean, string]>([
    ['NFC 저는', true, '저는 현장에서 계약을 마무리했다.'],
    ['NFD 저는', true, '저는 현장에서 계약을 마무리했다.'.normalize('NFD')],
    ['따옴표 뒤 제가', true, '“제가 협상을 이끌었다.”'],
    ['쉼표 뒤 우리는', true, '시장은 크고, 우리는 준비가 됐다.'],
    ['제 + 공백', true, '제 경험은 이렇다.'],
    ['NFD 제 + 공백', true, '제 경험은 이렇다.'.normalize('NFD')],
    ['단어 경계 없음(문제가)', false, '문제가 생겼다.'],
    ['호환 자모 ㅈㅔ가(NFC 로 합쳐지지 않음 — NFKC 아님)', false, '\u3148\u3154가 협상을 마쳤다.'],
  ])('%s → 1인칭 %s', async (_label, expected, sentence) => {
    expect(splitSentences(sentence)).toEqual([sentence.trim()]);
    expect(hasFirstPersonExpression(sentence)).toBe(expected);
    const out = await new MockLlmProvider().generate({ task: 'draft', inputVersion: 'v', text: sentence, allowedSourceRefs: ['sv-1'] });
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]).toMatchObject({
      text: sentence,
      kind: expected ? 'experience' : 'opinion',
      needs_user_confirmation: expected,
      source_refs: expected ? [] : ['sv-1'],
    });
  });

  it('NFC 입력은 결과가 결정적이다; NFD/NFC 는 claim 종류·확인 표시가 같다(제안 문구의 시드는 원문 기준이라 비교하지 않음)', async () => {
    const m = new MockLlmProvider();
    const input = { task: 'draft' as const, inputVersion: 'v', text: NFC_TEXT, allowedSourceRefs: ['sv-1'] };
    const a = await m.generate(input);
    expect(await m.generate(input)).toEqual(a);
    const d = await m.generate({ ...input, text: NFC_TEXT.normalize('NFD') });
    expect(d.claims.map((c) => [c.kind, c.needs_user_confirmation, c.source_refs])).toEqual(a.claims.map((c) => [c.kind, c.needs_user_confirmation, c.source_refs]));
    expect(a.claims.map((c) => c.kind)).toEqual(['experience', 'opinion']);
  });
});
