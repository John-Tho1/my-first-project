import { describe, expect, it } from 'vitest';
import { llmStructuredOutputSchema } from './schemas';

describe('llmStructuredOutputSchema', () => {
  const base = {
    result_type: 'idea',
    input_version: 'v1',
    proposed_text: 't',
    proposed_tags: [],
    followup_questions: [],
    warnings: [],
  } as const;
  it('확인 없는 경험 주장은 거부', () => {
    const r = llmStructuredOutputSchema.safeParse({
      ...base,
      claims: [{ text: '나는 ~했다', kind: 'experience', source_refs: [], needs_user_confirmation: false }],
    });
    expect(r.success).toBe(false);
  });
  it('의견은 출처 없이 허용', () => {
    const r = llmStructuredOutputSchema.safeParse({
      ...base,
      claims: [{ text: '생각', kind: 'opinion', source_refs: [], needs_user_confirmation: false }],
    });
    expect(r.success).toBe(true);
  });
});
