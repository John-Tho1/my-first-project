/**
 * 콘텐츠 카드(idea)·원고(content)·검색 입력 계약(T04, docs/04).
 * - 원고 본문은 불변 버전(content_versions)으로만 바뀐다. 본문 저장은 base_version 기반(stale → 409, A02).
 * - 원고 메타데이터(제목·연재·독자·태그·상태)와 카드는 revision 낙관적 잠금.
 * - 상태(lifecycle)는 draft|review|ready|archived. "published" 같은 단일 게시 플래그는 없다(배포는 M3 별도 기록).
 */
import { z } from 'zod';
import { AppError } from './errors';
import { riskSchema } from './schemas';

export const MAX_IDEA = 500;
export const MAX_IDEA_FIELD = 2000;
export const MAX_CONTENT_TITLE = 200;
export const MAX_CONTENT_BODY = 100_000;
export const MAX_SERIES = 100;
export const MAX_AUDIENCE = 500;
export const MAX_TAGS = 10;
export const MAX_TAG = 30;
export const MAX_VERSION_NOTE = 500;
export const MAX_SEARCH_Q = 200;
export const MAX_LINKED_CAPTURES = 20;

export const CONTENT_LIFECYCLES = ['draft', 'review', 'ready', 'archived'] as const;
export const contentLifecycleSchema = z.enum(CONTENT_LIFECYCLES);
export type ContentLifecycle = z.infer<typeof contentLifecycleSchema>;

/** 허용 전이(같은 상태로의 "전이"는 변경 없음으로 본다). */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<ContentLifecycle, readonly ContentLifecycle[]>> = {
  draft: ['review'],
  review: ['ready', 'draft'],
  ready: ['archived', 'review'],
  archived: ['draft'],
};

export function canTransition(from: ContentLifecycle, to: ContentLifecycle): boolean {
  return from === to || LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** 화면 select 에 보여 줄 선택지: 현재 상태 + 허용 전이. */
export function allowedLifecycleOptions(from: ContentLifecycle): ContentLifecycle[] {
  return [from, ...LIFECYCLE_TRANSITIONS[from]];
}

export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super('bad_request', 'invalid_transition', `상태를 ${from} 에서 ${to} 로 바꿀 수 없습니다`);
  }
}

export function assertLifecycleTransition(from: string, to: ContentLifecycle): void {
  const parsed = contentLifecycleSchema.safeParse(from);
  if (!parsed.success || !canTransition(parsed.data, to)) throw new InvalidTransitionError(from, to);
}

/** 태그: 앞뒤 공백 제거·NFC, 빈 값 제거, 대소문자 무시 중복 제거(처음 표기 유지). 최대 10개, 각 30자. */
export const tagsSchema = z
  .array(z.string().max(MAX_TAG * 2))
  .max(MAX_TAGS * 2)
  .transform((arr) => normalizeTags(arr))
  .pipe(z.array(z.string().min(1).max(MAX_TAG)).max(MAX_TAGS));

export function normalizeTags(arr: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    const t = raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** 폼의 "태그1, 태그2" 입력 → 배열(쉼표·줄바꿈 구분). */
export function parseTagsInput(input: string | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  return input.split(/[,\n]/u);
}

const optText = (max: number) => z.string().max(max).nullable().optional();
const captureIdsSchema = z.array(z.uuid()).max(MAX_LINKED_CAPTURES);

export const ideaCreateSchema = z
  .object({
    idea: z.string().trim().min(1).max(MAX_IDEA),
    audience: optText(MAX_AUDIENCE),
    evidence: optText(MAX_IDEA_FIELD),
    risk: riskSchema.optional(),
    next_question: optText(MAX_IDEA_FIELD),
    next_decision: optText(MAX_IDEA_FIELD),
    tags: tagsSchema.optional(),
    capture_ids: captureIdsSchema.optional(),
  })
  .strict();
export type IdeaCreateInput = z.infer<typeof ideaCreateSchema>;

/** 카드 수정. capture_ids 를 주면 연결 소재 집합을 그 목록으로 바꾼다. 바꿀 항목이 없으면 400. */
export const ideaPatchSchema = z
  .object({
    expected_revision: z.int().min(1),
    idea: z.string().trim().min(1).max(MAX_IDEA).optional(),
    audience: optText(MAX_AUDIENCE),
    evidence: optText(MAX_IDEA_FIELD),
    risk: riskSchema.optional(),
    next_question: optText(MAX_IDEA_FIELD),
    next_decision: optText(MAX_IDEA_FIELD),
    tags: tagsSchema.optional(),
    capture_ids: captureIdsSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'expected_revision' && v[k as keyof typeof v] !== undefined), {
    message: '바꿀 항목이 없습니다',
  });
export type IdeaPatchInput = z.infer<typeof ideaPatchSchema>;

export const contentCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_CONTENT_TITLE),
    body: z.string().max(MAX_CONTENT_BODY),
    series: optText(MAX_SERIES),
    audience: optText(MAX_AUDIENCE),
    tags: tagsSchema.optional(),
    idea_id: z.uuid().nullable().optional(),
    capture_ids: captureIdsSchema.optional(),
  })
  .strict();
export type ContentCreateInput = z.infer<typeof contentCreateSchema>;

export const contentMetaPatchSchema = z
  .object({
    expected_revision: z.int().min(1),
    title: z.string().trim().min(1).max(MAX_CONTENT_TITLE).optional(),
    series: optText(MAX_SERIES),
    audience: optText(MAX_AUDIENCE),
    tags: tagsSchema.optional(),
    lifecycle: contentLifecycleSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'expected_revision' && v[k as keyof typeof v] !== undefined), {
    message: '바꿀 항목이 없습니다',
  });
export type ContentMetaPatchInput = z.infer<typeof contentMetaPatchSchema>;

export const contentBodyUpdateSchema = z
  .object({
    base_version: z.int().min(1),
    body: z.string().max(MAX_CONTENT_BODY),
    note: z.string().max(MAX_VERSION_NOTE).nullable().optional(),
  })
  .strict();
export type ContentBodyUpdateInput = z.infer<typeof contentBodyUpdateSchema>;

export const SEARCH_TYPES = ['all', 'captures', 'contents', 'ideas'] as const;
export const searchTypeSchema = z.enum(SEARCH_TYPES);
export type SearchType = z.infer<typeof searchTypeSchema>;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '날짜는 YYYY-MM-DD 형식입니다').refine(
  (s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)),
  '날짜가 올바르지 않습니다',
);

/** GET /api/search 쿼리. 빈 문자열 값은 "지정 안 함"으로 본다(parseSearchParams). */
export const searchQuerySchema = z
  .object({
    q: z.string().max(MAX_SEARCH_Q).optional(),
    type: searchTypeSchema.default('all'),
    series: z.string().max(MAX_SERIES).optional(),
    tag: z.string().max(MAX_TAG).optional(),
    risk: riskSchema.optional(),
    lifecycle: contentLifecycleSchema.optional(),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    cursor: z.string().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.cursor !== undefined && v.type === 'all') {
      ctx.addIssue({ code: 'custom', path: ['cursor'], message: 'cursor 는 type(captures·contents·ideas)을 하나 지정할 때만 씁니다' });
    }
    if (v.from && v.to && v.from > v.to) {
      ctx.addIssue({ code: 'custom', path: ['from'], message: '시작일이 종료일보다 늦습니다' });
    }
  });
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/** URLSearchParams → 검색 입력(빈 값 제거, 같은 키는 마지막 값). */
export function parseSearchParams(params: URLSearchParams) {
  const raw: Record<string, string> = {};
  for (const [k, v] of params.entries()) if (v.trim() !== '') raw[k] = v;
  return searchQuerySchema.safeParse(raw);
}

/**
 * 검색어 → 부분 문자열 조건(AND). 공백으로 나눈 각 조각이 모두 포함되어야 한다.
 * 한국어는 형태소 분석 없이 부분 문자열로 찾는다(조사 붙은 "주재원으로" 도 "주재원" 으로 찾음).
 */
export function searchTerms(q: string | undefined): string[] {
  if (!q) return [];
  const terms = q.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  return [...new Set(terms)].slice(0, 8);
}

/** ILIKE 패턴 escape(\, %, _). ESCAPE '\' 와 함께 쓴다. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

/**
 * 첫 일치 위치 주변 ±radius 코드 포인트를 잘라 낸 미리보기. 일치가 없으면 앞부분.
 * 대소문자 무시(toLowerCase 가 길이를 바꾸지 않는 문자 기준 — 한국어·영문은 안전).
 */
export function makeSnippet(text: string, terms: readonly string[], radius = 60): string {
  const chars = Array.from(text);
  const lower = chars.map((c) => (c.toLowerCase().length === c.length ? c.toLowerCase() : c));
  const hay = lower.join('');
  let hitCp = -1;
  let termLen = 0;
  for (const t of terms) {
    const idx = hay.indexOf(t.toLowerCase());
    if (idx >= 0) {
      hitCp = Array.from(hay.slice(0, idx)).length;
      termLen = Array.from(t).length;
      break;
    }
  }
  if (hitCp < 0) return chars.length > radius * 2 ? `${chars.slice(0, radius * 2).join('')}…` : text;
  const start = Math.max(0, hitCp - radius);
  const end = Math.min(chars.length, hitCp + termLen + radius);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}

export function textIncludesAny(text: string | null | undefined, terms: readonly string[]): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  return terms.some((t) => hay.includes(t.toLowerCase()));
}

/** 소재 → 원고 초안 본문: 원문을 `> 원문:` 인용 블록으로 두고 빈 작성 칸을 붙인다. */
export function draftBodyFromCapture(rawText: string): string {
  const quoted = rawText.split(/\r?\n/u).map((l) => `> ${l}`.trimEnd());
  return `> 원문:\n${quoted.join('\n')}\n\n## 초안\n\n`;
}

/** 소재 → 원고 제목: capture.title, 없으면 원문 첫 60자(줄바꿈은 공백). */
export function draftTitleFromCapture(title: string | null, rawText: string): string {
  const t = title?.trim();
  if (t) return Array.from(t).slice(0, MAX_CONTENT_TITLE).join('');
  const flat = rawText.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  const head = chars.slice(0, 60).join('');
  return head ? (chars.length > 60 ? `${head}…` : head) : '제목 없음';
}

/** 카드 → 원고 초안 본문. 비어 있는 항목은 넣지 않는다. */
export function draftBodyFromIdea(i: {
  idea: string;
  audience: string | null;
  evidence: string | null;
  nextDecision: string | null;
}): string {
  const lines = [`> 카드: ${i.idea.replace(/\s+/gu, ' ').trim()}`];
  if (i.audience) lines.push(`> 독자: ${i.audience.replace(/\s+/gu, ' ').trim()}`);
  if (i.evidence) lines.push(`> 근거: ${i.evidence.replace(/\s+/gu, ' ').trim()}`);
  if (i.nextDecision) lines.push(`> 다음 결정: ${i.nextDecision.replace(/\s+/gu, ' ').trim()}`);
  return `${lines.join('\n')}\n\n## 초안\n\n`;
}

/** 카드 → 원고 제목: idea 첫 줄(최대 200자). */
export function draftTitleFromIdea(idea: string): string {
  const flat = idea.replace(/\s+/gu, ' ').trim();
  return Array.from(flat).slice(0, MAX_CONTENT_TITLE).join('') || '제목 없음';
}

/** 소재 → 카드 기본 문구: 원문 첫 100자. */
export function ideaSeedFromCapture(title: string | null, rawText: string): string {
  const base = title?.trim() ? title.trim() : rawText.replace(/\s+/gu, ' ').trim();
  return Array.from(base).slice(0, 100).join('');
}

/** UTF-8 바이트 길이 */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
