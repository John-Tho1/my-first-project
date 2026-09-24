/**
 * T06 작성 지원(결정 D12) — 순수 함수·입력 계약. DB·네트워크 없음.
 *
 * - Brand Profile 새 버전 입력(append 전용, base_version 으로 충돌 검사)
 * - 인터뷰 질문 3개(고정 키). 답변은 사용자만 입력한다 — AI 는 답변을 채우지 않는다.
 * - assist(outline/draft/revise) 요청·채택·경험 확인 입력
 * - 프롬프트 빌더(결정적): 모의·live provider 가 받는 "정확한 프롬프트". 비밀·환경변수 값은 넣지 않는다.
 * - A03 게이트(순수): 채택한 AI 제안의 미확인 1인칭 경험 claim 목록
 */
import { z } from 'zod';
import { MAX_CONTENT_BODY } from './content';
import { AppError } from './errors';

// ---- Brand Profile ----

export const BRAND_TONES = ['formal', 'casual'] as const;
export type BrandTone = (typeof BRAND_TONES)[number];
export const BRAND_TONE_LABEL: Record<BrandTone, string> = { formal: '존댓말', casual: '평어(반말)' };

export const MAX_BRAND_TEXT = 500;
export const MAX_BRAND_ITEM = 300;
export const MAX_BRAND_ITEMS = 10;
export const MAX_SAMPLE_TEXT = 3000;
export const MAX_SAMPLE_TEXTS = 5;

const itemList = (maxItem: number, maxItems: number) =>
  z.array(z.string().trim().min(1).max(maxItem)).max(maxItems);

export const brandProfileCreateSchema = z
  .object({
    /** 현재 버전 번호(아직 없으면 0). 다르면 409. */
    base_version: z.int().min(0),
    pen_name: z.string().trim().min(1).max(100),
    audience: z.string().trim().min(1).max(MAX_BRAND_TEXT),
    pillars: itemList(100, 5).min(1),
    style_rules: itemList(MAX_BRAND_ITEM, MAX_BRAND_ITEMS).default([]),
    tone: z.enum(BRAND_TONES).default('formal'),
    avoid_phrases: itemList(100, 20).default([]),
    cta_rules: itemList(MAX_BRAND_ITEM, MAX_BRAND_ITEMS).default([]),
    sample_texts: itemList(MAX_SAMPLE_TEXT, MAX_SAMPLE_TEXTS).default([]),
  })
  .strict();
export type BrandProfileCreateInput = z.infer<typeof brandProfileCreateSchema>;

/** 폼 textarea(한 줄에 하나) → 배열. 빈 줄은 버린다. */
export function linesToList(v: string | undefined): string[] {
  if (v === undefined) return [];
  return v
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 예문 textarea: 빈 줄 한 줄 이상("---" 줄 포함)으로 구분한다. */
export function blocksToList(v: string | undefined): string[] {
  if (v === undefined) return [];
  return v
    .replace(/\r\n?/gu, '\n')
    .split(/\n\s*(?:---\s*)?\n/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- 인터뷰 질문(고정 3개) ----

export const INTERVIEW_QUESTIONS = [
  { key: 'situation', question: '어떤 상황이었나요? (언제·어디서·누구와 — 공개해도 되는 범위에서)' },
  { key: 'judgment', question: '그 상황에서 무엇을 판단했고, 왜 그렇게 판단했나요?' },
  { key: 'takeaway', question: '독자에게 남기고 싶은 한 가지는 무엇인가요?' },
] as const;
export type InterviewQuestionKey = (typeof INTERVIEW_QUESTIONS)[number]['key'];
export const INTERVIEW_KEYS = INTERVIEW_QUESTIONS.map((q) => q.key) as [InterviewQuestionKey, ...InterviewQuestionKey[]];
export const MAX_ANSWER = 5000;

export function interviewQuestion(key: InterviewQuestionKey): string {
  return INTERVIEW_QUESTIONS.find((q) => q.key === key)!.question;
}

/** { answers: { situation?, judgment?, takeaway? } } — 빈 답변은 저장하지 않는다. */
export const interviewAnswersSchema = z
  .object({
    answers: z
      .object({
        situation: z.string().max(MAX_ANSWER).optional(),
        judgment: z.string().max(MAX_ANSWER).optional(),
        takeaway: z.string().max(MAX_ANSWER).optional(),
      })
      .strict(),
  })
  .strict();
export type InterviewAnswersInput = z.infer<typeof interviewAnswersSchema>;

// ---- assist ----

export const ASSIST_MODES = ['outline', 'draft', 'revise'] as const;
export type AssistMode = (typeof ASSIST_MODES)[number];
export const ASSIST_MODE_LABEL: Record<AssistMode, string> = { outline: '개요', draft: '초안', revise: '다듬기' };
/** LLM 구조화 출력 result_type 과의 대응. */
export const ASSIST_RESULT_TYPE = { outline: 'outline', draft: 'draft', revise: 'revision' } as const;

/** 프롬프트 형식 버전. 프롬프트 문구를 바꾸면 올린다(generation_runs.prompt_version). */
export const PROMPT_VERSION = 't06-assist-v1';
/** T07: 허용 출처 목록이 들어간 프롬프트의 형식 버전(출처가 없으면 t06-assist-v1 과 바이트 단위로 같다). */
export const PROMPT_VERSION_WITH_SOURCES = 't07-assist-v2';
export const promptVersionFor = (sourceCount: number) => (sourceCount > 0 ? PROMPT_VERSION_WITH_SOURCES : PROMPT_VERSION);

export const assistRequestSchema = z
  .object({
    mode: z.enum(ASSIST_MODES),
    base_version: z.int().min(1),
    brand_profile_version: z.int().min(1),
    answer_ids: z.array(z.string()).max(20).default([]),
    /** T07: 이번 제안에서 근거로 허용할 source_version id(이 원고에 연결된 소재의 출처만). 없으면 근거 없음. */
    source_version_ids: z.array(z.string()).max(50).default([]),
  })
  .strict();
export type AssistRequest = z.infer<typeof assistRequestSchema>;

export const adoptRequestSchema = z.object({ base_version: z.int().min(1) }).strict();

export const claimConfirmSchema = z
  .object({
    run_id: z.string().min(1),
    claim_indexes: z.array(z.int().min(0).max(99)).min(1).max(20),
    /** 'confirmed' = 내 실제 경험이 맞음, 'removed' = 본문에서 그 문장을 뺐거나 고침(FIX-T06). 둘 다 사용자 주장. */
    resolution: z.enum(['confirmed', 'removed']).default('confirmed'),
  })
  .strict();

export interface PromptBrand {
  version: number;
  penName: string;
  audience: string;
  pillars: readonly string[];
  styleRules: readonly string[];
  tone: string;
  avoidPhrases: readonly string[];
  ctaRules: readonly string[];
  sampleTexts: readonly string[];
}

export interface PromptAnswer {
  id: string;
  questionKey: string;
  question: string;
  answer: string;
}

export interface AssistPromptInput {
  mode: AssistMode;
  inputVersion: string;
  brand: PromptBrand;
  answers: readonly PromptAnswer[];
  title: string;
  body: string;
  /** T07: 허용 출처(이 목록의 id 만 claim.source_refs 에 쓸 수 있다). */
  sources?: readonly PromptSource[];
}

export interface PromptSource {
  id: string;
  locator: string | null;
  excerpt: string | null;
}

const MODE_INSTRUCTION: Record<AssistMode, string> = {
  outline: '현재 본문과 인터뷰 답변을 바탕으로 글의 개요(소제목 3~6개와 각 한 줄 요지)를 제안하세요.',
  draft: '현재 본문과 인터뷰 답변을 바탕으로 한 편의 초안을 제안하세요.',
  revise: '현재 본문의 의미를 바꾸지 말고 문장·구성만 다듬은 수정안을 제안하세요.',
};

const bullet = (items: readonly string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '- (없음)');

/** 답변은 질문 순서(situation → judgment → takeaway), 같은 키면 id 순으로 정렬한다(결정적). */
export function sortAnswers<T extends { questionKey: string; id: string }>(answers: readonly T[]): T[] {
  const order = (k: string) => {
    const i = INTERVIEW_KEYS.indexOf(k as InterviewQuestionKey);
    return i < 0 ? 99 : i;
  };
  return [...answers].sort((a, b) => order(a.questionKey) - order(b.questionKey) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * provider 가 받는 정확한 프롬프트(결정적 — 같은 입력 → 같은 문자열). "프롬프트 복사용 보기"도 이 함수를 쓴다.
 * 들어가는 것: Brand Profile(해당 버전)·인터뷰 답변(사용자 입력)·현재 본문·지시문. 비밀·환경변수·다른 owner 데이터 없음.
 */
export function buildAssistPrompt(input: AssistPromptInput): string {
  const b = input.brand;
  const answers = sortAnswers(input.answers);
  const samples = b.sampleTexts.length
    ? b.sampleTexts.map((s, i) => `[예문 ${i + 1}]\n${s}`).join('\n\n')
    : '(없음)';
  return [
    `# Content Studio 작성 보조 (${promptVersionFor(input.sources?.length ?? 0)}, 모드: ${input.mode})`,
    `입력 버전: ${input.inputVersion}`,
    '',
    '## 지시',
    MODE_INSTRUCTION[input.mode],
    '- 1인칭 경험은 아래 "인터뷰 답변"에 사용자가 직접 쓴 것만 쓰세요. 없는 경험·사례·수치·인용·출처를 만들지 마세요.',
    '- 문체 예문에 나온 사건을 새 글의 사실로 옮기지 마세요. 예문은 말투 참고용입니다.',
    '- 경험 주장은 claims 에 kind=experience, needs_user_confirmation=true 로 표시하세요.',
    '- 확인되지 않은 사실은 warnings 에 적고, 부족한 정보는 followup_questions(최대 3개)로 물으세요.',
    '- 출력은 result_type, input_version, proposed_text, proposed_tags, claims, followup_questions, warnings 구조로 하세요.',
    '',
    `## Brand Profile (버전 ${b.version})`,
    `필명: ${b.penName}`,
    `독자: ${b.audience}`,
    `말투: ${b.tone === 'casual' ? '평어(반말)' : '존댓말'}`,
    '연재 축:',
    bullet(b.pillars),
    '문체 원칙:',
    bullet(b.styleRules),
    '피할 표현:',
    bullet(b.avoidPhrases),
    'CTA 원칙:',
    bullet(b.ctaRules),
    '문체 예문(사용자 제공, 말투 참고용):',
    samples,
    '',
    '## 인터뷰 답변(사용자 입력)',
    answers.length ? answers.map((a) => `### ${a.question}\n${a.answer}`).join('\n\n') : '(답변 없음)',
    '',
    `## 현재 본문 — 제목: ${input.title}`,
    input.body === '' ? '(비어 있음)' : input.body,
    '',
    ...sourceSection(input.sources ?? []),
  ].join('\n');
}

/** 허용 출처 절(출처가 없으면 빈 배열 — t06 프롬프트와 같아진다). id 순 정렬(결정적). */
function sourceSection(sources: readonly PromptSource[]): string[] {
  if (sources.length === 0) return [];
  const sorted = [...sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return [
    '## 허용 출처(source_refs 에는 아래 id 만 쓰세요 — 목록에 없는 URL·문헌을 만들지 마세요)',
    ...sorted.map((s) => `- ${s.id}${s.locator ? ` · ${s.locator}` : ''}${s.excerpt ? ` · ${s.excerpt}` : ''}`),
    '',
  ];
}

/**
 * 모의 provider 가 제안·claim 을 만드는 자료(인터뷰 답변 → 현재 본문 순). 모의 provider 는 앞 문장들로 claim 을 만든다.
 * live provider 는 buildAssistPrompt 결과를 받는다(T07).
 */
export function assistMaterial(answers: readonly PromptAnswer[], body: string): string {
  const parts = sortAnswers(answers).map((a) => a.answer.trim()).filter(Boolean);
  if (body.trim()) parts.push(body.trim());
  return parts.join('\n');
}

/** input_version 문자열: 현재 본문 버전 id + 브랜드 버전 + 답변 id(정렬). 출력의 input_version 이 이것과 같아야 한다. */
export function assistInputVersion(refs: {
  contentVersionId: string;
  brandProfileVersion: number;
  answerIds: readonly string[];
  sourceVersionIds?: readonly string[];
}): string {
  const base = `cv:${refs.contentVersionId};bp:${refs.brandProfileVersion};ans:${[...refs.answerIds].sort().join(',')}`;
  // T07: 허용 출처가 있을 때만 덧붙인다(없으면 T06 형식 그대로).
  return refs.sourceVersionIds?.length ? `${base};sv:${[...refs.sourceVersionIds].sort().join(',')}` : base;
}

// ---- T07: claim 출처 거르기(순수) ----

export interface FilteredClaim {
  index: number;
  text: string;
  kind: 'fact' | 'opinion' | 'experience';
  needs_user_confirmation: boolean;
  /** 허용 목록 안의 출처(소문자, 중복 제거, 순서 유지) */
  source_refs: string[];
  /** 허용 목록 밖이라 버린 출처 개수(값은 저장하지 않는다) */
  dropped_source_refs: number;
  evidence_grade: 'none' | 'source';
  needs_check: boolean;
}

/**
 * 모델 출력 claim 의 source_refs 를 허용 source_version 목록으로 거른다(docs/04: 모델이 만든 URL 은 확인 전 채택 금지).
 * 목록 밖 값은 버리고 개수만 남긴다. needs_check = 경험 claim | 확인 필요 표시 | 근거 없는 사실 claim | 버린 출처가 있음.
 */
export function filterClaimSources(
  claims: ReadonlyArray<{ text: string; kind: 'fact' | 'opinion' | 'experience'; source_refs: readonly string[]; needs_user_confirmation: boolean }>,
  allowed: readonly string[],
): FilteredClaim[] {
  const ok = new Set(allowed.map((s) => s.toLowerCase()));
  return claims.map((c, index) => {
    const kept: string[] = [];
    let dropped = 0;
    for (const ref of c.source_refs) {
      const r = ref.trim().toLowerCase();
      if (ok.has(r)) {
        if (!kept.includes(r)) kept.push(r);
      } else dropped++;
    }
    return {
      index,
      text: c.text,
      kind: c.kind,
      needs_user_confirmation: c.needs_user_confirmation,
      source_refs: kept,
      dropped_source_refs: dropped,
      evidence_grade: kept.length > 0 ? 'source' : 'none',
      needs_check: c.kind === 'experience' || c.needs_user_confirmation || dropped > 0 || (c.kind === 'fact' && kept.length === 0),
    };
  });
}

// ---- A03 게이트(순수) ----

export interface GateClaim {
  text: string;
  kind: string;
  needs_user_confirmation: boolean;
}

export interface GateRun {
  runId: string;
  /** 이 run 의 제안이 채택됐는가(채택 버전이 있음) */
  adopted: boolean;
  claims: readonly GateClaim[];
}

/** 사용자 확인이 필요한 claim: experience 이거나 needs_user_confirmation=true(스키마상 experience ⇒ true). */
export const claimNeedsConfirmation = (c: GateClaim) => c.kind === 'experience' || c.needs_user_confirmation;

export interface UnconfirmedClaim {
  run_id: string;
  claim_index: number;
  text: string;
}

/**
 * 채택한 모든 AI 제안의 experience claim 중 사용자가 확인하지 않은 것. 비어 있지 않으면 `ready` 전이를 막는다(A03).
 * "마지막 run" 만 보지 않는다 — 이전에 채택한 제안의 경험 claim 이 뒤의 run 으로 가려지지 않게.
 */
export function unconfirmedExperienceClaims(
  runs: readonly GateRun[],
  confirmations: ReadonlyArray<ClaimResolutionRecord>,
  currentBody?: string,
): UnconfirmedClaim[] {
  const out: UnconfirmedClaim[] = [];
  for (const r of runs) {
    if (!r.adopted) continue;
    r.claims.forEach((c, i) => {
      if (claimNeedsConfirmation(c) && !isClaimResolved(r.runId, i, c.text, confirmations, currentBody)) {
        out.push({ run_id: r.runId, claim_index: i, text: c.text });
      }
    });
  }
  return out;
}

/** 해결 기록 한 행(resolution 이 없으면 0006 이전 확인 = 'confirmed'). */
export interface ClaimResolutionRecord {
  runId: string;
  claimIndex: number;
  resolution?: string;
}

/**
 * claim 이 해결됐는가(FIX-T06 round 2).
 * - 'confirmed' 행이 있으면 해결(사용자가 사실이라고 영구히 주장).
 * - 'removed' 행은 **현재 본문에 그 문장이 없을 때만** 해결. 다시 넣으면 다시 미해결. 현재 본문을 모르면(undefined) 미해결(fail closed).
 */
export function isClaimResolved(
  runId: string,
  claimIndex: number,
  claimText: string,
  confirmations: ReadonlyArray<ClaimResolutionRecord>,
  currentBody: string | undefined,
): boolean {
  const rows = confirmations.filter((c) => c.runId === runId && c.claimIndex === claimIndex);
  if (rows.some((c) => (c.resolution ?? 'confirmed') === 'confirmed')) return true;
  if (rows.some((c) => c.resolution === 'removed')) return currentBody !== undefined && !bodyContainsClaim(currentBody, claimText);
  return false;
}

/**
 * 비교용 정규화: NFKC → 소문자 → 글자(\p{L})·숫자(\p{N})만 남김(공백·문장부호·기호 제거). 유사도·형태소 비교는 하지 않는다.
 */
export function normalizeForClaimMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 본문에 claim 문장이 (공백·문장부호 차이를 무시하고) 그대로 들어 있는가. 퍼지 일치 아님 — 한 글자라도 바꾸면 "없음".
 * claim 이 정규화 후 비어 있으면(문장부호만) 비교할 수 없으므로 "있음"으로 본다(제외를 허용하지 않음).
 */
export function bodyContainsClaim(body: string, claimText: string): boolean {
  const needle = normalizeForClaimMatch(claimText);
  if (needle === '') return true;
  return normalizeForClaimMatch(body).includes(needle);
}

// ---- 오류 ----

/** assist·채택의 기준 버전이 현재 버전이 아님(409). 409 본문 모양은 본문 저장 충돌과 같다(current/yours). */
export class StaleBaseError extends AppError {
  constructor(extra: { current: Record<string, unknown>; yours: Record<string, unknown> }) {
    super('conflict', 'stale_base', '현재 본문이 바뀌었습니다. 최신 본문을 기준으로 다시 요청하세요.', extra);
  }
}

/** Brand Profile 새 버전 저장 시 base_version 이 현재 버전과 다름(409). */
export class BrandVersionConflictError extends AppError {
  constructor(extra: { current: Record<string, unknown> | null; yours: Record<string, unknown> }) {
    super('conflict', 'conflict', '다른 곳에서 Brand Profile 이 먼저 저장되었습니다. 현재 버전을 확인한 뒤 다시 저장하세요.', extra);
  }
}

/** AI(모의 포함) 호출 실패. 사용자 본문은 바뀌지 않는다. */
export class LlmFailedError extends AppError {
  constructor() {
    super('llm_failed', 'llm_failed', 'AI 제안을 만들지 못했습니다. 본문은 바뀌지 않았습니다. 잠시 뒤 다시 시도하세요.');
  }
}

/** 'removed'(본문에서 뺐음)인데 현재 본문에 그 문장이 아직 있음(409). 기록을 남기지 않는다. */
export class ClaimStillInBodyError extends AppError {
  constructor(claimIndexes: number[]) {
    super('conflict', 'claim_still_in_body', '그 문장이 아직 현재 본문에 있습니다. 본문에서 빼거나 고쳐 저장한 뒤 "본문에서 뺐음"을 누르세요.', {
      claim_indexes: claimIndexes,
    });
  }
}

/** A03: 채택한 AI 제안의 경험 claim 이 확인되지 않아 `ready` 로 바꿀 수 없음(409). */
export class UnconfirmedExperienceClaimsError extends AppError {
  constructor(claims: UnconfirmedClaim[]) {
    super(
      'conflict',
      'unconfirmed_experience_claims',
      '채택한 AI 제안에 확인하지 않은 1인칭 경험 주장이 있어 "준비됨"으로 바꿀 수 없습니다. 작성실에서 사실인지 확인하세요.',
      { claims },
    );
  }
}

/** 제안 본문 상한(원고 본문과 같음). */
export const MAX_PROPOSAL_BODY = MAX_CONTENT_BODY;
