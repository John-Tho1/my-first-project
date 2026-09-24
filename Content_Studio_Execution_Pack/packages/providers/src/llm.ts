import { createHash } from 'node:crypto';
import {
  estimateTokens,
  liveLlmReadiness,
  TOKEN_CHARS,
  LiveProviderNotConfiguredError,
  llmStructuredOutputSchema,
  type AppConfig,
  type LlmStructuredOutput,
} from '@cs/domain';

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
  generate(input: LlmGenerateInput): Promise<LlmStructuredOutput>;
  /** T07: 실제 사용량(토큰). 모의는 결정적 추정(글자/3), live 는 공급자 응답에서 읽는다(T07 미구현). */
  usageOf?(input: LlmGenerateInput, output: LlmStructuredOutput): LlmUsage;
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

/** 1인칭 경험 표현(한국어). 걸리면 experience + 사용자 확인 필요로 분류한다. */
const FIRST_PERSON = /(^|[\s,.'"“])(나는|내가|나의|내 |저는|제가|저의|제 |우리는|우리가|직접 )/;

function splitSentences(text: string): string[] {
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
      const firstPerson = FIRST_PERSON.test(s);
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

/**
 * T07 live provider 경계(공급자 중립, D8 미정). **HTTP 호출이 없다.**
 * - assertReady(): 전제 조건(LLM_MODE=live·공급자·모델·가격·월 상한·승인 기록 LLM_LIVE_APPROVAL_REF)과 무관하게
 *   T07 에서는 어댑터가 없으므로 항상 LiveProviderNotConfiguredError(빠진 조건 이름만 포함).
 * - generate(): 방어적으로 같은 오류. 환경변수만으로 실제 호출이 열리는 경로는 없다.
 */
export class LiveLlmProvider implements LlmProvider {
  readonly name: string;
  readonly mode = 'live' as const;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.name = config.LLM_PROVIDER ?? 'live';
  }

  assertReady(): void {
    throw new LiveProviderNotConfiguredError(liveLlmReadiness(this.config).missing);
  }

  async generate(input: LlmGenerateInput): Promise<LlmStructuredOutput> {
    void input;
    // T07: 실제 호출은 별도 승인 후 구현(D8)
    throw new LiveProviderNotConfiguredError(liveLlmReadiness(this.config).missing);
  }
}
