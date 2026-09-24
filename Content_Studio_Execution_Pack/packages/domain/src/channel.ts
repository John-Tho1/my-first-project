/**
 * T09 채널별 초안(결정 D14) — 순수 함수. DB·네트워크·게시 없음.
 *
 * - 채널: threads | instagram | youtube | blog. 채널 제약(글자 수)은 **잠정값**이다 — 게시 어댑터(M4) 전에 공식 자료로 다시 확인한다.
 *   글자 수는 유니코드 코드 포인트(Array.from) 기준(한글·이모지 한 글자 = 1).
 * - 원고 → 채널 초안(결정적): threads = 문단별 글(각 ≤500자, 긴 문단은 잘라 이어짐), instagram = 첫 문단 캡션 + 문단별 카드(≤10),
 *   youtube = 첫 줄 제목(≤100자) + 나머지 설명 + 원고 전체 대본, blog = 첫 줄(# 제거) 제목 + 원고 Markdown.
 * - stale 은 저장하지 않는다: 버전의 content_version_id ≠ 원고의 현재 버전이면 stale.
 * - 미디어 완성 여부: instagram 이미지 ≥1, youtube 영상 1(+선택 썸네일), threads·blog 없음.
 */
import { z } from 'zod';
import { AppError } from './errors';

export const CHANNELS = ['threads', 'instagram', 'youtube', 'blog'] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABEL: Record<Channel, string> = { threads: 'Threads', instagram: 'Instagram', youtube: 'YouTube', blog: '블로그' };

export const THREADS_MAX = 500;
export const THREADS_MAX_PARTS = 20;
export const INSTAGRAM_CAPTION_MAX = 2200;
export const INSTAGRAM_CARD_MAX = 300;
export const INSTAGRAM_MAX_CARDS = 10;
export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
export const YOUTUBE_MAX_TAGS = 30;
export const BLOG_TITLE_MAX = 200;
export const VARIANT_BODY_MAX = 100_000;

export const VARIANT_ROLES = ['image', 'video', 'thumbnail', 'attachment'] as const;
export type VariantRole = (typeof VARIANT_ROLES)[number];

/** 코드 포인트 기준 길이 */
export const cpLength = (s: string) => Array.from(s).length;

/** 코드 포인트 기준으로 max 이하 조각으로 나눈다(가능하면 공백에서). */
export function splitByLength(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = Array.from(text);
  while (rest.length > max) {
    let cut = max;
    for (let i = max; i > max * 0.6; i--) {
      if (/\s/u.test(rest[i - 1]!)) {
        cut = i;
        break;
      }
    }
    out.push(rest.slice(0, cut).join('').trim());
    rest = rest.slice(cut);
    while (rest.length && /\s/u.test(rest[0]!)) rest = rest.slice(1);
  }
  const last = rest.join('').trim();
  if (last) out.push(last);
  return out.filter(Boolean);
}

function truncate(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`;
}

export function paragraphs(body: string): string[] {
  return body
    .replace(/\r\n?/gu, '\n')
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter(Boolean);
}

// ---- 채널별 메타데이터 스키마(사용자 편집 검증) ----

const threadsMeta = z
  .object({
    text: z.string().refine((s) => cpLength(s) <= THREADS_MAX, `글은 ${THREADS_MAX}자 이하입니다`),
    thread_parts: z
      .array(z.string().min(1).refine((s) => cpLength(s) <= THREADS_MAX, `이어지는 글은 각각 ${THREADS_MAX}자 이하입니다`))
      .max(THREADS_MAX_PARTS),
  })
  .strict();
const instagramMeta = z
  .object({
    caption: z.string().refine((s) => cpLength(s) <= INSTAGRAM_CAPTION_MAX, `캡션은 ${INSTAGRAM_CAPTION_MAX}자 이하입니다`),
    cards: z
      .array(
        z
          .object({
            index: z.int().min(1),
            text: z.string().refine((s) => cpLength(s) <= INSTAGRAM_CARD_MAX, `카드 문구는 ${INSTAGRAM_CARD_MAX}자 이하입니다`),
          })
          .strict(),
      )
      .max(INSTAGRAM_MAX_CARDS),
  })
  .strict();
const youtubeMeta = z
  .object({
    title: z
      .string()
      .min(1)
      .refine((s) => cpLength(s) <= YOUTUBE_TITLE_MAX, `제목은 ${YOUTUBE_TITLE_MAX}자 이하입니다`),
    description: z.string().refine((s) => cpLength(s) <= YOUTUBE_DESCRIPTION_MAX, `설명은 ${YOUTUBE_DESCRIPTION_MAX}자 이하입니다`),
    script: z.string().max(VARIANT_BODY_MAX),
    tags: z.array(z.string().min(1).max(50)).max(YOUTUBE_MAX_TAGS),
  })
  .strict();
const blogMeta = z
  .object({
    title: z
      .string()
      .min(1)
      .refine((s) => cpLength(s) <= BLOG_TITLE_MAX, `제목은 ${BLOG_TITLE_MAX}자 이하입니다`),
    markdown: z.string().max(VARIANT_BODY_MAX),
  })
  .strict();

export const CHANNEL_METADATA_SCHEMAS = { threads: threadsMeta, instagram: instagramMeta, youtube: youtubeMeta, blog: blogMeta } as const;
export type ChannelMetadata = {
  threads: z.infer<typeof threadsMeta>;
  instagram: z.infer<typeof instagramMeta>;
  youtube: z.infer<typeof youtubeMeta>;
  blog: z.infer<typeof blogMeta>;
};

export function parseChannelMetadata(channel: Channel, value: unknown): Record<string, unknown> {
  const r = CHANNEL_METADATA_SCHEMAS[channel].safeParse(value);
  if (!r.success) {
    const custom = r.error.issues.find((i) => i.code === 'custom');
    throw new AppError('bad_request', 'invalid_metadata', custom?.message ?? `채널(${CHANNEL_LABEL[channel]}) 형식이 올바르지 않습니다`);
  }
  return r.data as Record<string, unknown>;
}

// ---- 원고 → 채널 초안(결정적) ----

export interface ChannelDraft {
  body: string;
  metadata: Record<string, unknown>;
}

export function channelDraft(channel: Channel, title: string, coreBody: string): ChannelDraft {
  const paras = paragraphs(coreBody);
  switch (channel) {
    case 'threads': {
      const parts = paras.flatMap((p) => splitByLength(p, THREADS_MAX)).slice(0, THREADS_MAX_PARTS);
      const safe = parts.length ? parts : [truncate(title, THREADS_MAX)];
      return { body: safe.join('\n\n'), metadata: { text: safe[0]!, thread_parts: safe } };
    }
    case 'instagram': {
      const caption = truncate(paras[0] ?? title, INSTAGRAM_CAPTION_MAX);
      const cards = paras.slice(0, INSTAGRAM_MAX_CARDS).map((p, i) => ({ index: i + 1, text: truncate(p, INSTAGRAM_CARD_MAX) }));
      return { body: caption, metadata: { caption, cards } };
    }
    case 'youtube': {
      const lines = coreBody.replace(/\r\n?/gu, '\n').split('\n');
      const firstIdx = lines.findIndex((l) => l.trim() !== '');
      const first = firstIdx >= 0 ? lines[firstIdx]!.replace(/^#+\s*/u, '').replace(/^>\s*/u, '').trim() : '';
      const t = truncate(first || title, YOUTUBE_TITLE_MAX);
      const description = truncate(lines.slice(firstIdx + 1).join('\n').trim(), YOUTUBE_DESCRIPTION_MAX);
      return { body: coreBody, metadata: { title: t, description, script: coreBody, tags: [] } };
    }
    case 'blog': {
      const firstLine = coreBody.replace(/\r\n?/gu, '\n').split('\n').find((l) => l.trim() !== '') ?? '';
      const t = truncate(firstLine.replace(/^#+\s*/u, '').replace(/^>\s*/u, '').trim() || title, BLOG_TITLE_MAX);
      return { body: coreBody, metadata: { title: t, markdown: coreBody } };
    }
  }
}

// ---- stale·미디어 완성 여부 ----

/** 파생본 버전이 원고의 현재 버전에서 나오지 않았으면 stale(저장하지 않는 파생 값). */
export function isVariantStale(versionContentVersionId: string | null | undefined, contentCurrentVersionId: string | null | undefined): boolean {
  if (!versionContentVersionId) return false; // 버전이 없으면 판단 대상 아님
  return versionContentVersionId !== contentCurrentVersionId;
}

export interface MediaItem {
  role: string;
  mime: string;
}

export interface MediaCompleteness {
  complete: boolean;
  missing: string[];
}

/** 채널별 필수 미디어(역할 + 실제 파일 형식). 역할만 맞고 형식이 다르면 없는 것으로 본다. */
export function mediaCompleteness(channel: Channel, items: readonly MediaItem[]): MediaCompleteness {
  const images = items.filter((i) => i.role === 'image' && i.mime.startsWith('image/')).length;
  const videos = items.filter((i) => i.role === 'video' && i.mime.startsWith('video/')).length;
  const missing: string[] = [];
  if (channel === 'instagram' && images < 1) missing.push('image(이미지 1개 이상)');
  if (channel === 'youtube' && videos < 1) missing.push('video(완성 영상 1개)');
  if (channel === 'youtube' && videos > 1) missing.push('video(영상은 1개만)');
  return { complete: missing.length === 0, missing };
}

/** 첨부 역할과 파일 형식이 맞는지(image·thumbnail 은 image/*, video 는 video/*, attachment 는 무관). */
export function roleMatchesMime(role: VariantRole, mime: string): boolean {
  if (role === 'image' || role === 'thumbnail') return mime.startsWith('image/');
  if (role === 'video') return mime.startsWith('video/');
  return true;
}

// ---- 입력 계약 ----

export const variantCreateSchema = z
  .object({ channel: z.enum(CHANNELS), mode: z.enum(['draft', 'ai_draft']), base_version: z.int().min(1) })
  .strict();

export const variantEditSchema = z
  .object({ base_version: z.int().min(0), body: z.string().max(VARIANT_BODY_MAX), metadata: z.record(z.string(), z.unknown()) })
  .strict();

export const variantAssetsSchema = z
  .object({
    base_version: z.int().min(1),
    assets: z
      .array(z.object({ asset_id: z.string().min(1), position: z.int().min(1).max(50), role: z.enum(VARIANT_ROLES) }).strict())
      .max(20),
  })
  .strict();

export const variantAdoptSchema = z.object({ base_version: z.int().min(0) }).strict();

export const variantLifecycleSchema = z.object({ lifecycle: z.enum(['draft', 'review']), base_version: z.int().min(1) }).strict();

// ---- 오류 ----

export class MediaIncompleteError extends AppError {
  constructor(missing: string[]) {
    super('conflict', 'media_incomplete', `검토로 보내려면 미디어가 더 필요합니다: ${missing.join(', ')}`, { missing });
  }
}

export class StaleVariantError extends AppError {
  constructor() {
    super('conflict', 'stale_variant', '원문이 바뀌었습니다. 현재 원문으로 다시 초안을 만든 뒤 검토로 보내세요.');
  }
}

export class VariantVersionConflictError extends AppError {
  constructor(extra: { current: Record<string, unknown> | null; yours: Record<string, unknown> }) {
    super('conflict', 'conflict', '다른 곳에서 채널 초안이 먼저 저장되었습니다. 현재 버전을 확인한 뒤 다시 저장하세요.', extra);
  }
}
