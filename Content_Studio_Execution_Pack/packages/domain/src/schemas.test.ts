import { describe, expect, it } from 'vitest';
import { captureInputSchema, llmStructuredOutputSchema } from './schemas';

describe('captureInputSchema', () => {
  it('텍스트 수집', () => {
    expect(captureInputSchema.parse({ input_type: 'text', raw_text: '메모', command_key: 'k1' })).toBeTruthy();
  });
  it('빈 텍스트는 거부', () => {
    expect(captureInputSchema.safeParse({ input_type: 'text', raw_text: ' ', command_key: 'k1' }).success).toBe(false);
  });
  it('http(s) 외 URL 은 거부', () => {
    expect(
      captureInputSchema.safeParse({ input_type: 'url', url: 'file:///etc/passwd', command_key: 'k2' }).success,
    ).toBe(false);
  });
  it('command_key 필수', () => {
    expect(captureInputSchema.safeParse({ input_type: 'text', raw_text: 'a' }).success).toBe(false);
  });
});

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
