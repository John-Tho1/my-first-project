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
import { normalizeUrl } from './url';

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
    source_version_ids: z.array(z.string()).max(50).default([]), // = MAX_ASSIST_SOURCES
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

// ---- FIX-T07: 허용 출처 기본 선택(순수) ----

/** assist 요청 한 번에 보낼 수 있는 source_version 수(assistRequestSchema 와 같다). */
export const MAX_ASSIST_SOURCES = 50;

/**
 * 작성실 기본 선택: 출처(source)마다 가장 최근 버전 하나(fetched_at, 같으면 id 큰 것), 최근 출처부터 최대 MAX_ASSIST_SOURCES 개.
 * excluded = 기본 선택에서 빠진 버전 수(이전 버전 + 상한 초과). 사용자는 체크박스로 바꿀 수 있다.
 */
export function pickDefaultSources<T extends { id: string; sourceId: string; fetchedAt: Date }>(
  all: readonly T[],
  max = MAX_ASSIST_SOURCES,
): { selected: T[]; excluded: number } {
  const latest = new Map<string, T>();
  for (const v of all) {
    const cur = latest.get(v.sourceId);
    if (!cur || v.fetchedAt > cur.fetchedAt || (v.fetchedAt.getTime() === cur.fetchedAt.getTime() && v.id > cur.id)) latest.set(v.sourceId, v);
  }
  const selected = [...latest.values()]
    .sort((a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime() || (a.id < b.id ? 1 : -1))
    .slice(0, max);
  return { selected, excluded: all.length - selected.length };
}

// ---- FIX-T07: 출력 전체 정제(순수) ----

export const DROPPED_REF_MARKER = '[출처 미확인 URL 제거]';

export interface SanitizedClaim {
  text: string;
  kind: 'fact' | 'opinion' | 'experience';
  source_refs: string[];
  needs_user_confirmation: boolean;
  dropped_source_refs: number;
  evidence_grade: 'none' | 'source';
  needs_check: boolean;
}

export interface SanitizedOutput {
  result_type: LlmOutputLike['result_type'];
  input_version: string;
  proposed_text: string;
  proposed_tags: string[];
  claims: SanitizedClaim[];
  followup_questions: string[];
  warnings: string[];
}

interface LlmOutputLike {
  result_type: 'idea' | 'outline' | 'draft' | 'revision' | 'questions';
  input_version: string;
  proposed_text: string;
  proposed_tags: readonly string[];
  claims: ReadonlyArray<{ text: string; kind: 'fact' | 'opinion' | 'experience'; source_refs: readonly string[]; needs_user_confirmation: boolean }>;
  followup_questions: readonly string[];
  warnings: readonly string[];
}


/** 허용 출처(정제 기준): source_version id 와 그 출처의 locator(URL). 순서는 프롬프트의 번호([1], [2] …)와 같다(id 정렬). */
export interface AllowedRef {
  id: string;
  locator?: string | null;
}

/** 모델 출력에 허용 목록으로 풀 수 없는 번호 인용([n], n 이 범위 밖)이 있어 안전하게 고칠 수 없음 → 출력 전체를 검증 실패로. */
export class UnverifiableCitationError extends AppError {
  constructor() {
    super('bad_request', 'unverifiable_citation', 'AI 출력에 확인할 수 없는 출처 인용이 있어 저장하지 않았습니다');
  }
}

// ---- 인용 문법(FIX-T07 round 3) ----
// 받아들이는 형태는 다음뿐이다. 판정은 모두 "전체 값의 동등성" — 부분 문자열 비교는 하지 않는다.
//   [n]                  n = 1..허용 출처 수(프롬프트 번호). 범위 밖이면 출력 전체 실패.
//   [출처: <URL|UUID>]   괄호 안의 값을 꺼내 URL 은 정규형 비교, UUID 는 허용 id 와 정확히 비교. 그 밖의 [출처…] 는 미확인.
//   <URL>                https?://… 또는 www.… (www. 는 https:// 를 붙여 해석)
//   <맨 도메인>          host.tld[/…] — 점이 있고 TLD 가 영문 2~24자, 흔한 파일 확장자(.md .ts .js …)는 제외
// URL 동등성 = normalizeUrl().normalized(scheme·host 소문자, 기본 포트·fragment·추적 파라미터 제거, 파라미터 정렬, 끝 슬래시 제거).
// **경로·쿼리의 대소문자는 그대로** 비교한다. http↔https, www 유무는 정규형이 다르면 같은 출처로 보지 않는다(별칭 없음).

const TOKEN_CHARS = String.raw`[^\s<>"'()[\]{}]`;
const HOST = String.raw`(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}`;
const CITATION_RE = new RegExp(
  [
    String.raw`\[출처[^\]]*\]`, // [출처…]
    String.raw`\[(\d+)\]`, // [n]
    String.raw`https?:\/\/${TOKEN_CHARS}+`, // URL
    String.raw`www\.${TOKEN_CHARS}+`, // www.…
    String.raw`(?<![\w@./:-])${HOST}(?:\/${TOKEN_CHARS}*)?(?![\w@-])`, // 맨 도메인
  ].join('|'),
  'giu',
);
/** 맨 도메인으로 보지 않을 흔한 파일 확장자(보수적 예외) */
const FILE_EXT = new Set(['md', 'ts', 'tsx', 'js', 'jsx', 'json', 'txt', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'csv', 'xlsx', 'docx', 'pptx', 'zip', 'html', 'css', 'mp4', 'mov', 'sql', 'yml', 'yaml']);
const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TRAILING_PUNCT = /[.,;:!?…。、]+$/u;

/** URL·www·맨 도메인 문자열 → 정규형(비교용). 해석할 수 없으면 null. */
export function canonicalCitationUrl(token: string): string | null {
  const t = token.trim();
  const withScheme = /^https?:\/\//iu.test(t) ? t : `https://${t}`;
  try {
    return normalizeUrl(withScheme).normalized;
  } catch {
    return null;
  }
}

/**
 * 모델 출력 한 개를 저장·반환 전에 정제한다(docs/04: 목록 밖 출처는 확인 전 채택 금지). FIX-T07 round 3 — 위 인용 문법으로만 판정.
 * - claim.source_refs: 허용 id 와 정확히 같은 것만(filterClaimSources), 버린 개수·needs_check
 * - 제안 본문·경고·후속 질문·태그·claim 문장의 URL·맨 도메인·[출처…] 중 허용 출처로 풀리지 않는 것은 DROPPED_REF_MARKER 로 바꾸고
 *   "확인 필요" 경고, 바뀐 claim 은 needs_check
 * - [n] 은 길이와 무관하게 번호 규칙으로만 판정 — 범위 밖이면 UnverifiableCitationError(run failed, 제안 없음)
 * 이 결과 하나를 제안 버전·output_json·claims 행·HTTP 응답에 똑같이 쓴다(원고 assist·채널 AI 초안).
 */
export function sanitizeLlmOutput(
  output: LlmOutputLike,
  allowedIn: ReadonlyArray<AllowedRef | string>,
): { output: SanitizedOutput; droppedTotal: number; redactedTotal: number } {
  const allowed: AllowedRef[] = allowedIn.map((a) => (typeof a === 'string' ? { id: a } : a));
  const allowedIds = allowed.map((a) => a.id);
  const okIds = new Set(allowedIds.map((s) => s.toLowerCase()));
  const okUrls = new Set(allowed.flatMap((a) => (a.locator ? [canonicalCitationUrl(a.locator)].filter((x): x is string => x !== null) : [])));

  let redactedTotal = 0;
  const urlAllowed = (token: string) => {
    const c = canonicalCitationUrl(token);
    return c !== null && okUrls.has(c);
  };
  const clean = (s: string): { text: string; changed: boolean } => {
    let changed = false;
    const text = s.replace(CITATION_RE, (m: string, num: string | undefined) => {
      if (m === DROPPED_REF_MARKER) return m;
      if (num !== undefined) {
        const n = Number(num);
        if (!(n >= 1 && n <= allowed.length)) throw new UnverifiableCitationError();
        return m;
      }
      if (m.startsWith('[')) {
        const inner = m.slice(1, -1).replace(/^출처\s*[:：]?\s*/u, '').trim();
        const ok = UUID_ONLY.test(inner) ? okIds.has(inner.toLowerCase()) : inner !== '' && urlAllowed(inner.replace(TRAILING_PUNCT, ''));
        if (ok) return m;
        changed = true;
        redactedTotal++;
        return DROPPED_REF_MARKER;
      }
      // URL·www·맨 도메인: 끝 문장부호는 인용이 아니라 문장의 것
      const punct = TRAILING_PUNCT.exec(m)?.[0] ?? '';
      const token = punct ? m.slice(0, -punct.length) : m;
      const isBare = !/^(?:https?:\/\/|www\.)/iu.test(token);
      if (isBare) {
        const host = token.split('/')[0]!;
        const tld = host.slice(host.lastIndexOf('.') + 1).toLowerCase();
        if (FILE_EXT.has(tld) && !token.includes('/')) return m; // 파일 이름으로 보이는 것은 그대로
      }
      if (urlAllowed(token)) return m;
      changed = true;
      redactedTotal++;
      return DROPPED_REF_MARKER + punct;
    });
    return { text, changed };
  };

  const filtered = filterClaimSources(output.claims, allowedIds);
  const droppedTotal = filtered.reduce((n, c) => n + c.dropped_source_refs, 0);
  const proposed = clean(output.proposed_text);
  const tags = output.proposed_tags.map((t) => clean(t).text);
  const questions = output.followup_questions.map((q) => clean(q).text);
  const claims = filtered.map((c) => {
    const t = clean(c.text);
    return {
      text: t.text,
      kind: c.kind,
      source_refs: c.source_refs,
      needs_user_confirmation: c.needs_user_confirmation,
      dropped_source_refs: c.dropped_source_refs,
      evidence_grade: c.evidence_grade,
      needs_check: c.needs_check || t.changed,
    };
  });
  const warnings = output.warnings.map((w) => clean(w).text);
  if (redactedTotal > 0) warnings.push(`출처 미확인: 허용 목록으로 확인할 수 없는 URL·인용 ${redactedTotal}건을 글에서 뺐습니다 — 확인 필요`);
  if (droppedTotal > 0) warnings.push(`출처 미확인: 허용 목록에 없는 출처 ${droppedTotal}건을 버렸습니다`);
  return {
    droppedTotal,
    redactedTotal,
    output: {
      result_type: output.result_type,
      input_version: output.input_version,
      proposed_text: proposed.text,
      proposed_tags: tags,
      claims,
      followup_questions: questions,
      warnings,
    },
  };
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
