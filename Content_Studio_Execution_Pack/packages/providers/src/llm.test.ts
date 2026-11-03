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

// FIX3-FULLREV2(G20, D40-4): 1인칭 어휘·앞 경계 확대. 모의 provider 도 같은 판별 함수를 쓰므로 claim 종류까지 확인한다.
describe('FIX3-FULLREV2(G20) — 1인칭 어휘(저희·우리 ○○·저도·제게 …)와 괄호·꺾쇠·따옴표·강조 기호 뒤 경계', () => {
  it.each<[string, string]>([
    ['저희 + 공백', '저희 팀은 지난해 두바이 바이어 30곳과 계약을 맺었습니다.'],
    ['저희는', '저희는 작년에 30곳을 방문했습니다.'],
    ['문장 중간 저희', '지난해 저희 회사는 지사를 열었습니다.'],
    ['우리 + 공백(팀)', '우리 팀은 작년에 계약을 따냈다.'],
    ['우리 + 공백(회사)', '우리 회사가 첫 수출을 했다.'],
    ['우리의', '우리의 첫 해외 계약은 어려웠다.'],
    ['우리도', '우리도 같은 실수를 했다.'],
    ['우리에게', '우리에게 그 계약은 전환점이었다.'],
    ['저도', '저도 처음엔 실패했습니다.'],
    ['나도', '나도 그 시장에서 일했다.'],
    ['제게', '제게 가장 큰 교훈은 협상이었다.'],
    ['내게', '내게 그 일은 기회였다.'],
    ['저에게', '저에게 그 일은 기회였습니다.'],
    ['나에게', '나에게 그 일은 기회였다.'],
    ['저 역시', '저 역시 같은 실수를 했습니다.'],
    ['나 역시', '나 역시 같은 실수를 했다.'],
    ['필자', '필자는 2019년에 이직했다.'],
    ['본인', '본인은 2019년에 이직했다.'],
    ['괄호 ( 뒤', '(제가 맡았던 일이다)'],
    ['꺾쇠 「 뒤', '「저는 괜찮습니다」라고 말했다'],
    ['홑화살괄호 < 뒤', '<저희 팀의 기록>을 공개한다'],
    ['대괄호 [ 뒤', '[우리 팀] 기록을 공개한다'],
    ['작은따옴표 ‘ 뒤', '‘제가 하겠습니다’라고 답했다'],
    ['강조 ** 뒤', '**저는** 2019년에 이직했습니다.'],
    ['큰따옴표 " 뒤', '"저희가 맡겠습니다"라고 답했다'],
    ['영어 I', 'I moved to Dubai in 2019.'],
    ['영어 my', 'It was my first contract'],
    ['영어 We', 'We signed thirty buyers'],
    ['영어 our', 'This is our team record'],
    ['NFD 저희', '저희 팀은 계약을 맺었다.'.normalize('NFD')],
  ])('%s → 1인칭(모의 claim 도 experience + 확인 필요)', async (_label, sentence) => {
    expect(splitSentences(sentence)).toEqual([sentence.trim()]);
    expect(hasFirstPersonExpression(sentence)).toBe(true);
    const out = await new MockLlmProvider().generate({ task: 'draft', inputVersion: 'v', text: sentence, allowedSourceRefs: ['sv-1'] });
    expect(out.claims).toEqual([{ text: sentence, kind: 'experience', source_refs: [], needs_user_confirmation: true }]);
  });

  // 거짓 행에는 위 표현이 단어 경계에 없어야 한다(단어 안의 글자만 있다).
  it.each<[string, string]>([
    ['우리나라(붙여 쓴 한 단어 — 잡지 않기로 함)', '우리나라는 수출 비중이 크다.'],
    ['단어 안 저희·제가 아님(문제가)', '문제가 생겼다.'],
    ['단어 안 나도(하나도)', '하나도 남지 않았다.'],
    ['단어 안 본인(견본인)', '이것은 견본인 셈이다.'],
    ['영어 AI 안의 I', 'AI 활용이 늘었다.'],
    ['영어 IT 의 I', 'IT 업계가 커졌다.'],
    ['영어 web 안의 we', 'web 문서를 읽었다.'],
    ['영어 Mythos 안의 My', 'Mythos 라는 책이다.'],
    ['영어 tour 안의 our', 'tour 일정이 바뀌었다.'],
  ])('%s → 1인칭 아님(모의 claim opinion)', async (_label, sentence) => {
    expect(hasFirstPersonExpression(sentence)).toBe(false);
    const out = await new MockLlmProvider().generate({ task: 'draft', inputVersion: 'v', text: sentence, allowedSourceRefs: ['sv-1'] });
    expect(out.claims).toEqual([{ text: sentence, kind: 'opinion', source_refs: ['sv-1'], needs_user_confirmation: false }]);
  });

  it('긴 입력에도 선형 시간(역추적 폭발 없음)', () => {
    const long = `${'가나다 '.repeat(60_000)}(`;
    const t = performance.now();
    expect(hasFirstPersonExpression(long)).toBe(false);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

// FIX3-FULLREV2 fixup(G20, D40-4 보강): 목적격·기타 조사, \s 공백, 영어 me/us/myself/ourselves/mine, 대소문자 무시(온전한 단어만).
describe('FIX3-FULLREV2 fixup(G20) — 1인칭 어휘 보강(저를·우리와·저한테·저만·저로서는 …, \\s 공백, 영어 대소문자)', () => {
  it.each<[string, string]>([
    ['저를', '저를 믿어 준 바이어가 있었다.'],
    ['나를', '나를 뽑아 준 회사였다.'],
    ['우리를', '우리를 도와준 파트너가 있었다.'],
    ['우리와', '우리와 계약한 곳은 세 곳이다.'],
    ['저와', '저와 함께 일한 동료가 있었다.'],
    ['나와 + 공백', '나와 같은 팀이었다.'],
    ['저한테', '저한테 그 일은 기회였다.'],
    ['나한테', '나한테 그 일은 기회였다.'],
    ['우리한테', '우리한테 맡겨진 시장이었다.'],
    ['저만', '저만 그 회의에 갔다.'],
    ['나만', '나만 남아 협상을 마쳤다.'],
    ['우리만', '우리만 그 입찰에 들어갔다.'],
    ['저로서는', '저로서는 처음 해 본 계약이었다.'],
    ['나로서는', '나로서는 큰 결정이었다.'],
    ['우리로서는', '우리로서는 큰 결정이었다.'],
    ['내 + 줄바꿈 아닌 탭', '내\t경험은 이렇다.'],
    ['제 + NBSP', '제 경험은 이렇다.'],
    ['직접 + NBSP', '직접 협상했다.'],
    ['저 + NBSP + 역시', '저 역시 같은 실수를 했다.'],
    ['영어 me', 'They hired me in 2019'],
    ['영어 Me 문장 처음', 'Me and the team flew there'],
    ['영어 us', 'They gave us the contract'],
    ['영어 myself', 'I did it myself'],
    ['영어 ourselves', 'We built it ourselves'],
    ['영어 mine', 'The idea was mine'],
    ['영어 ours', 'The deal was ours'],
    ['영어 MY 대문자', 'MY FIRST DEAL'],
    ['영어 WE 대문자', 'WE SIGNED IT'],
    ['영어 OUR 대문자', 'OUR TEAM WON'],
    ['영어 소문자 i(단어)', 'then i moved to dubai'],
    ["영어 I'm", "I'm based in Dubai"],
  ])('%s → 1인칭(모의 claim 도 experience)', async (_label, sentence) => {
    expect(hasFirstPersonExpression(sentence)).toBe(true);
    const out = await new MockLlmProvider().generate({ task: 'draft', inputVersion: 'v', text: sentence, allowedSourceRefs: ['sv-1'] });
    expect(out.claims).toEqual([{ text: sentence, kind: 'experience', source_refs: [], needs_user_confirmation: true }]);
  });

  it.each<[string, string]>([
    ['우리나라(그대로 음성)', '우리나라는 수출 비중이 크다.'],
    ['저만큼(지시어)', '저만큼 큰 시장은 드물다.'],
    ['저만치(지시어)', '저만치 떨어진 공장이다.'],
    ['나와서(동사 나오다)', '시장에 나와서 팔린다.'],
    ['나와야(동사)', '결과가 나와야 안다.'],
    ['나와요(동사)', '결과가 곧 나와요.'],
    ['단어 안 저를(앞이 한글)', '물건저를 보았다'],
    ['US(미국 약어)', 'US 시장이 커졌다.'],
    ['ME(중동 약어)', 'ME 지역 수요가 늘었다.'],
    ['i.e.', '시장, i.e. 수요가 커졌다.'],
    ['(i) 목록 번호', '(i) 수요 (ii) 공급'],
    ['i) 목록 번호', 'i) 수요가 커졌다.'],
    ['iPhone', 'iPhone 판매가 늘었다.'],
    ['i5', 'i5 프로세서 수요'],
    ['mineral 안의 mine', 'mineral 수출이 늘었다.'],
    ['music 안의 us', 'music 시장이 커졌다.'],
    ['meeting 안의 me', 'meeting 일정이 잡혔다.'],
    ['Mythos·tour·web 그대로', 'Mythos tour web'],
  ])('%s → 1인칭 아님', (_label, sentence) => {
    expect(hasFirstPersonExpression(sentence)).toBe(false);
  });

  it('보강 후에도 긴 입력은 선형 시간(영어·한국어 판별 모두 끝까지 훑음)', () => {
    const long = `${'i.e. US ME 우리나라 저만큼 나와서 '.repeat(20_000)}(`;
    const t = performance.now();
    expect(hasFirstPersonExpression(long)).toBe(false);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
