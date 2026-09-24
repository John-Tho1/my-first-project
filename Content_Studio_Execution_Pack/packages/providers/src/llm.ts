import { createHash } from 'node:crypto';
import { llmStructuredOutputSchema, type LlmStructuredOutput } from '@cs/domain';

export interface LlmGenerateInput {
  task: LlmStructuredOutput['result_type'];
  /** 생성 입력 버전(고정). 생성 중 원고가 바뀌어도 이 버전 기준으로만 제안한다. */
  inputVersion: string;
  text: string;
  /** 허용된 source_version ID 목록. claim.source_refs 는 이 안에서만 채운다. */
  allowedSourceRefs?: string[];
}

export interface LlmProvider {
  readonly name: string;
  readonly mode: 'mock' | 'live';
  generate(input: LlmGenerateInput): Promise<LlmStructuredOutput>;
}

export const MOCK_WARNING = '모의 응답: 실제 AI 호출 아님';

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

  async generate(input: LlmGenerateInput): Promise<LlmStructuredOutput> {
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
        // 모의 응답은 출처를 만들어내지 않는다.
        source_refs: [] as string[],
        needs_user_confirmation: firstPerson,
      };
    });
    const questions = [
      '이 소재를 읽을 독자가 가장 먼저 겪는 문제는 무엇인가요?',
      '직접 겪은 사례가 있다면 공개 가능한 범위에서 알려 주세요.',
      '이 주장을 뒷받침할 공개 자료가 있나요?',
    ];
    const output: LlmStructuredOutput = {
      result_type: input.task,
      input_version: input.inputVersion,
      proposed_text: `[모의 제안 #${seed.toString(16).slice(0, 6)}] ${sentences[0] ?? ''}`.trim(),
      proposed_tags: tags,
      claims,
      followup_questions: questions.slice(0, 1 + (seed % 3)),
      warnings: [MOCK_WARNING],
    };
    return llmStructuredOutputSchema.parse(output);
  }
}
