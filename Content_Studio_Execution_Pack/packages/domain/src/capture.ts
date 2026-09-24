/**
 * 수집(capture) 입력 계약과 원문 해시(T03).
 * - 원문(raw_text)은 저장 후 불변이다. 수정 가능한 필드는 메모(user_note)·제목(title)·위험(risk)뿐이다.
 * - content_hash 는 정확 중복 판정용: NFC → 연속 공백을 하나로 → 앞뒤 공백 제거 → sha256 hex.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RawTextImmutableError } from './errors';
import { riskSchema } from './schemas';

export const MAX_RAW_TEXT = 20000;
export const MAX_USER_NOTE = 2000;
export const MAX_TITLE = 200;

export function normalizeForHash(rawText: string): string {
  return rawText.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function contentHash(rawText: string): string {
  return createHash('sha256').update(normalizeForHash(rawText), 'utf8').digest('hex');
}

export const commandKeySchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * POST /api/captures 입력.
 * - text: raw_text(공백만은 불가) 필수, url 은 넣지 않는다.
 * - url: url 필수. raw_text 는 선택(사용자가 직접 쓴 말). URL 형식·scheme 은 normalizeUrl 이 검사한다(invalid_url).
 */
export const captureCreateSchema = z
  .object({
    input_type: z.enum(['text', 'url']),
    raw_text: z.string().min(1).max(MAX_RAW_TEXT).optional(),
    url: z.string().min(1).max(2048).optional(),
    user_note: z.string().max(MAX_USER_NOTE).optional(),
    title: z.string().max(MAX_TITLE).optional(),
    command_key: commandKeySchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.input_type === 'text') {
      if (!v.raw_text?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['raw_text'], message: '텍스트 수집에는 원문이 필요합니다' });
      }
      if (v.url !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['url'], message: '텍스트 수집에는 URL 을 넣지 않습니다' });
      }
    }
    if (v.input_type === 'url' && !v.url?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL 수집에는 URL 이 필요합니다' });
    }
  });
export type CaptureCreateInput = z.infer<typeof captureCreateSchema>;

/**
 * PATCH /api/captures/{id} 입력. raw_text 는 받지 않는다(parseCapturePatch 가 raw_text_immutable 로 거부).
 * user_note/title 은 null 또는 빈 문자열이면 비운다. 바꿀 필드가 하나도 없으면 거부한다.
 */
export const capturePatchSchema = z
  .object({
    expected_revision: z.int().min(1),
    user_note: z.string().max(MAX_USER_NOTE).nullable().optional(),
    title: z.string().max(MAX_TITLE).nullable().optional(),
    risk: riskSchema.optional(),
  })
  .strict()
  .refine((v) => v.user_note !== undefined || v.title !== undefined || v.risk !== undefined, {
    message: '바꿀 항목(메모·제목·위험)이 없습니다',
  });
export type CapturePatchInput = z.infer<typeof capturePatchSchema>;

/** raw_text 가 들어 있으면 스키마 검사 전에 RawTextImmutableError. 나머지는 safeParse 결과. */
export function parseCapturePatch(raw: unknown) {
  if (raw && typeof raw === 'object' && 'raw_text' in raw) throw new RawTextImmutableError();
  return capturePatchSchema.safeParse(raw);
}

/**
 * If-Match 헤더의 revision. `"3"`, `3`, `W/"3"` 를 허용한다. 헤더가 없으면 null, 형식이 틀리면 undefined.
 */
export function parseIfMatchRevision(header: string | null): number | null | undefined {
  if (header === null) return null;
  const m = /^\s*(?:W\/)?"?([1-9][0-9]{0,8})"?\s*$/.exec(header);
  return m ? Number(m[1]) : undefined;
}

/** 목록 cursor: base64url(`<received_at ISO(마이크로초)>|<id>`). 해석 불가면 null. */
export function encodeCaptureCursor(receivedAt: string, id: string): string {
  return Buffer.from(`${receivedAt}|${id}`, 'utf8').toString('base64url');
}

const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function decodeCaptureCursor(cursor: string): { receivedAt: string; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const m = CURSOR_RE.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return m ? { receivedAt: m[1]!, id: m[2]! } : null;
}
