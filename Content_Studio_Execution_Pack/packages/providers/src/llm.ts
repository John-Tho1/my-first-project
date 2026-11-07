import { createHash } from 'node:crypto';
import { estimateTokens, TOKEN_CHARS, llmStructuredOutputSchema, type LlmStructuredOutput } from '@cs/domain';

export interface LlmGenerateInput {
  task: LlmStructuredOutput['result_type'];
  /** 생성 입력 버전(고정). 생성 중 원고가 바뀌어도 이 버전 기준으로만 제안한다. */
  inputVersion: string;
  text: string;
  /** 허용된 source_version ID 목록. claim.source_refs 는 이 안에서만 채운다. */
  allowedSourceRefs?: string[];
  /**
   * FIX-T07: 출력 토큰 상한(예약한 최대 비용의 근거). provider 는 이보다 많이 생성하면 안 된다.
   * 모의는 제안 글자 수를 상한×3 으로 자른다. live 어댑터(D8 이후)는 이 값을 공급자 요청의 최대 출력 토큰으로 보내야 한다.
   */
  maxOutputTokens?: number;
  /**
   * T06: provider 가 받는 정확한 프롬프트(@cs/domain buildAssistPrompt). live provider(T07)는 이것을 보낸다.
   * 모의 provider 는 결정성을 위해 text 만으로 제안을 만든다(프롬프트는 결과에 영향 없음).
   */
  prompt?: string;
}

export interface LlmUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly mode: 'mock' | 'live';
  /** LIVE-L1: 실제 모델 ID(live 만 — run 기록의 model). 모의는 없음. */
  readonly model?: string;
  generate(input: LlmGenerateInput): Promise<LlmStructuredOutput>;
  /** T07: 실제 사용량(토큰). 모의는 결정적 추정(글자/3), live(LIVE-L1)는 그 호출의 공급자 응답 usage 에서 읽는다. */
  usageOf?(input: LlmGenerateInput, output: LlmStructuredOutput): LlmUsage;
  /** FIX2-LIVEL1: 공급자가 보고한 유효 usage 만(없거나 이상하면 null — 추정값 없음). live 만 구현. */
  confirmedUsageOf?(input: LlmGenerateInput): LlmUsage | null;
}

export const MOCK_WARNING = '모의 응답: 실제 AI 호출 아님';

/** 모의 provider 의 실패 주입(테스트 전용). 사용자 본문 보존·run failed 경로를 검증한다. */
export class MockLlmFailure extends Error {
  constructor() {
    super('모의 AI 실패(주입)');
    this.name = 'MockLlmFailure';
  }
}

export interface MockLlmOptions {
  /** true 면 generate 가 항상 MockLlmFailure 로 실패한다(테스트 전용 — 앱은 NODE_ENV=test 에서만 켠다). */
  fail?: boolean;
}

/**
 * 1인칭 경험 표현. 걸리면 experience + 사용자 확인 필요로 분류한다.
 * FIX3-FULLREV2(G20, D40-4): 어휘와 앞 경계를 넓힌다.
 * - 어휘: 저희·우리+조사(는/가/의/도/에게)·우리+공백(우리 팀/회사 등)·저도/나도·제게/내게/저에게/나에게·저 역시/나 역시·필자·본인,
 *   영어 I/my/we/our(앞뒤가 문자·숫자가 아닌 온전한 단어 — 'AI'·'web'·'IT' 안의 글자는 잡지 않는다).
 * - FIX3-FULLREV2(G20 보강): 목적격·기타 조사 저를/나를/우리를·저와/나와/우리와·저한테/나한테/우리한테·저만/나만/우리만·
 *   저로서는/나로서는/우리로서는. '내 '·'제 '·'직접 '·'저 역시' 의 공백은 리터럴 ASCII 공백이 아니라 \s(줄바꿈·NBSP 등 포함).
 *   '저만큼'·'저만치'(지시어)와 '나와서'·'나와야'·'나와요'(동사 나오다)는 뺀다. 영어는 아래 FIRST_PERSON_EN·_CASED.
 * - 앞 경계: 문자·숫자가 아닌 모든 문자 또는 문자열 시작(`(?<![\p{L}\p{N}])`, u 플래그) — 괄호·꺾쇠·「」·‘’·강조 기호(*) 뒤 대명사도 잡는다.
 *   '문제가'·'하나도' 처럼 단어 안에 든 글자는 앞이 한글이라 잡지 않는다.
 * - '우리나라'(붙여 쓴 한 단어)는 잡지 않는다 — 우리 뒤에 조사나 공백이 있어야 한다. 국가 일반을 가리키는 흔한 표현이라 경험 주장으로 보지 않는다.
 * - '본인'·'우리 ' 는 3인칭·일반 서술에도 쓰여 오탐이 생길 수 있다 — D40 은 확인 대상만 늘리는 쪽을 받아들였다.
 * - FIX1-FULLREV3(H4): 축약형 — 우린·저흰·난(뒤가 \s 또는 ',' 일 때만)·내겐·제겐·저한텐·나한텐·우리한텐·저\s혼자·나\s혼자·우리끼리.
 *   '난' 은 난초·고난·난관 같은 단어에도 들어 있어 뒤에 공백(\s)이나 쉼표가 올 때만 잡는다(앞 경계는 다른 표현과 같다 — '고난 '은 앞이 한글이라 안 잡힘).
 *   FIX1-FULLREV3(H4 후속): 바로 앞이 '가'·'이' + 공백 하나(`(?<![가이]\s)`, 고정 길이 2)이면 잡지 않는다 — '화가 난 고객'·'차이가 난 이유'·
 *   '결론이 난 사안'·'불이 난 공장' 처럼 동사 나다의 관형형 '난'(주격 조사 가/이 뒤)이 아주 흔하기 때문이다. '난 그때…'·'난, …'·'그래서 난 …' 은 그대로 잡힌다.
 *   받아들이는 오탐(1인칭으로 잡힘): '난 키우기'(식물 난 + 공백)·'는/도/만 + 난 …'(예: '소문만 난 회사' — 조사 가/이 밖의 관형형)·공백 두 칸 이상 뒤 관형형.
 *   받아들이는 놓침(1인칭인데 안 잡힘): 주어 '가/이 ' 바로 뒤에 오는 '난'(예: '그 일이 난 싫었다') — 드물고, 주어 생략과 같은 부류의 남은 위험.
 *   '우린' 은 뒤가 문자·숫자가 아닐 때만 잡는다(동사 우리다의 '우린다'·'우려낸' 은 빠진다. 관형형 '우린 차'(우려낸 차)는 오탐으로 받아들인다).
 *   '전'(저는 축약)·'날'(나를 축약)은 '전 세계'·'그 날' 처럼 흔한 다른 뜻이 많아 넣지 않는다 — 남은 위험(주어 생략과 같은 부류).
 * 정규식 휴리스틱이라는 한계(주어 생략 등을 놓침, LIVEL1 남은 위험)는 그대로다. 고정 길이 lookbehind + 문자열 상수 선택지뿐이라
 * 역추적이 입력 길이에 선형이다(중첩 반복 없음).
 */
const FIRST_PERSON =
  /(?<![\p{L}\p{N}])(?:나는|내가|나의|내\s|나를|나와(?![서야요])|나한테|나만|나로서는|저는|제가|저의|제\s|저를|저와|저한테|저만(?![큼치])|저로서는|우리는|우리가|우리의|우리도|우리에게|우리를|우리와|우리한테|우리만|우리로서는|우리\s|저희|저도|나도|제게|내게|저에게|나에게|저\s역시|나\s역시|필자|본인|직접\s|우린(?![\p{L}\p{N}])|저흰|(?<![가이]\s)난(?=[\s,])|내겐|제겐|저한텐|나한텐|우리한텐|저\s혼자|나\s혼자|우리끼리)/u;
/**
 * FIX3-FULLREV2(G20, D40-4 보강): 영어 1인칭 — 앞뒤가 문자·숫자가 아닌 온전한 단어만, 대소문자 무시(MY·We·OUR 등).
 * 'me'·'us' 는 소문자·첫 글자 대문자만 잡는다 — 'ME'(중동)·'US'(미국)는 이 앱 주제(해외 영업)에서 흔한 약어라 1인칭으로 보지 않는다.
 */
const FIRST_PERSON_EN = /(?<![\p{L}\p{N}])(?:my|we|our|ours|myself|ourselves|mine)(?![\p{L}\p{N}])/iu;
/**
 * FIX3-FULLREV2(G20): 'I'(대문자)와 단독 소문자 'i' 도 온전한 단어일 때만. 'i.e.'(i 뒤 '.' + 글자)와 목록 번호 '(i)'·'i)'(뒤에 ')')는 빼 오탐을 줄인다.
 * 고정 길이 lookaround + 상수 선택지뿐이라 선형이다.
 */
const FIRST_PERSON_EN_CASED = /(?<![\p{L}\p{N}])(?:I|i(?!\.\p{L}|\))|[Mm]e|[Uu]s)(?![\p{L}\p{N}])/u;
/**
 * LIVE-L1: live 출력에도 같은 규칙(1인칭 표현이 있는 claim → experience + 사용자 확인 필요)을 적용한다.
 * LIVEL1-H1: 판별 전에 NFC 로 정규화한다 — 분해형(NFD) 한글 "저는" 도 같은 표현으로 잡는다(원문은 바꾸지 않음).
 * LIVEL1-H2: 모의 provider(MockLlmProvider)도 이 함수로 판별한다 — live 와 같은 판정. NFC 는 순수 함수라 결정성은 그대로이고,
 * NFC 입력의 모의 출력은 전과 같다(바뀌는 것은 NFC 가 아닌 입력의 claim 종류뿐 — 확인이 필요한 쪽으로).
 */
export const hasFirstPersonExpression = (text: string): boolean => {
  const t = text.normalize('NFC');
  return FIRST_PERSON.test(t) || FIRST_PERSON_EN.test(t) || FIRST_PERSON_EN_CASED.test(t);
};

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 결정적 모의 LLM. 네트워크에 접근하지 않는다.
 * 같은 입력 → 같은 출력(입력 해시로 시드). 출력은 항상 도메인 스키마로 검증한다.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly mode = 'mock' as const;
  private readonly fail: boolean;

  constructor(opts: MockLlmOptions = {}) {
    this.fail = opts.fail === true;
  }

  async generate(input: LlmGenerateInput): Promise<LlmStructuredOutput> {
    if (this.fail) throw new MockLlmFailure();
    const hash = createHash('sha256').update(`${input.task}\u0000${input.inputVersion}\u0000${input.text}`).digest();
    const seed = hash.readUInt32BE(0);
    const tagPool = ['해외영업', '조직문화', 'AI활용', '주재원', '실무팁', '커뮤니케이션'];
    const tags = [tagPool[seed % tagPool.length]!, tagPool[(seed >>> 8) % tagPool.length]!].filter(
      (t, i, a) => a.indexOf(t) === i,
    );
    const sentences = splitSentences(input.text).slice(0, 3);
    const claims = sentences.map((s) => {
      const firstPerson = hasFirstPersonExpression(s);
      return {
        text: s,
        kind: firstPerson ? ('experience' as const) : ('opinion' as const),
        // 모의 응답은 출처를 만들어내지 않는다. 허용 목록(allowedSourceRefs)이 있으면 의견 claim 에 그 첫 항목만 붙인다(T07 표시 확인용).
        source_refs: !firstPerson && input.allowedSourceRefs?.length ? [input.allowedSourceRefs[0]!] : ([] as string[]),
        needs_user_confirmation: firstPerson,
      };
    });
    const questions = [
      '이 소재를 읽을 독자가 가장 먼저 겪는 문제는 무엇인가요?',
      '직접 겪은 사례가 있다면 공개 가능한 범위에서 알려 주세요.',
      '이 주장을 뒷받침할 공개 자료가 있나요?',
    ];
    const full = `[모의 제안 #${seed.toString(16).slice(0, 6)}] ${sentences[0] ?? ''}`.trim();
    // 출력 상한을 지킨다(글자/3 추정 기준).
    const proposed = input.maxOutputTokens !== undefined ? full.slice(0, Math.max(0, input.maxOutputTokens) * TOKEN_CHARS) : full;
    const output: LlmStructuredOutput = {
      result_type: input.task,
      input_version: input.inputVersion,
      proposed_text: proposed,
      proposed_tags: tags,
      claims,
      followup_questions: questions.slice(0, 1 + (seed % 3)),
      warnings: [MOCK_WARNING],
    };
    return llmStructuredOutputSchema.parse(output);
  }

  /** 결정적 사용량: 입력 = 프롬프트(없으면 자료) 글자/3, 출력 = 제안 글자/3(D13 경험칙). */
  usageOf(input: LlmGenerateInput, output: LlmStructuredOutput): LlmUsage {
    return { tokensIn: estimateTokens(input.prompt ?? input.text), tokensOut: estimateTokens(output.proposed_text) };
  }
}

// LIVE-L1(D34): T07 의 자리 표시 LiveLlmProvider(항상 거부)는 실제 Claude 어댑터(llm-anthropic.ts ClaudeLlmProvider)와
// 준비 판정 기반 선택(resolveLiveLlmProvider)으로 바뀌었다.
