import { z } from 'zod';

/** M1 엔티티의 런타임 검증 스키마(docs/04). DB 스키마(@cs/db)와 필드명을 맞춘다. */

export const inputTypeSchema = z.enum(['text', 'url', 'file', 'voice']);
export type InputType = z.infer<typeof inputTypeSchema>;

export const riskSchema = z.enum(['none', 'needs_check']);
export type Risk = z.infer<typeof riskSchema>;

export const userSchema = z.object({
  id: z.uuid(),
  allowed_identity: z.string().min(3),
  created_at: z.date(),
});
export type User = z.infer<typeof userSchema>;

export const brandProfileSchema = z.object({
  id: z.uuid(),
  owner_id: z.uuid(),
  version: z.int().positive(),
  pen_name: z.string().min(1),
  audience: z.string().min(1),
  pillars: z.array(z.string().min(1)).min(1).max(5),
  style_rules: z.array(z.string()),
  created_at: z.date(),
});
export type BrandProfile = z.infer<typeof brandProfileSchema>;

// POST /api/captures 입력 계약은 T03 부터 capture.ts 의 captureCreateSchema 가 정본이다.

export const claimSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(['fact', 'opinion', 'experience']),
  source_refs: z.array(z.string()),
  needs_user_confirmation: z.boolean(),
});
export type Claim = z.infer<typeof claimSchema>;

/**
 * AI 구조화 출력. structured output 은 출처 진위나 공개 승인 증거가 아니다.
 * 경험(experience) claim 은 항상 사용자 확인이 필요하다.
 */
export const llmStructuredOutputSchema = z
  .object({
    result_type: z.enum(['idea', 'outline', 'draft', 'revision', 'questions']),
    input_version: z.string().min(1),
    proposed_text: z.string(),
    proposed_tags: z.array(z.string()),
    claims: z.array(claimSchema),
    followup_questions: z.array(z.string()).max(3),
    warnings: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    v.claims.forEach((c, i) => {
      if (c.kind === 'experience' && !c.needs_user_confirmation) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', i, 'needs_user_confirmation'],
          message: '경험 주장은 사용자 확인이 필요합니다',
        });
      }
    });
  });
export type LlmStructuredOutput = z.infer<typeof llmStructuredOutputSchema>;

/** 픽스처/시드용 capture 레코드 형식 */
export const fixtureCaptureSchema = z.object({
  command_key: z.string().min(1),
  input_type: z.enum(['text', 'url']),
  raw_text: z.string().min(1),
  url: z.url().optional(),
  user_note: z.string().optional(),
  risk: riskSchema,
  received_at: z.iso.datetime(),
});
export type FixtureCapture = z.infer<typeof fixtureCaptureSchema>;

/** POST /api/auth/login 입력(T02). identity 값은 로그·감사 기록에 남기지 않는다. */
export const loginInputSchema = z.object({ identity: z.string().min(1).max(320) });
export type LoginInput = z.infer<typeof loginInputSchema>;
