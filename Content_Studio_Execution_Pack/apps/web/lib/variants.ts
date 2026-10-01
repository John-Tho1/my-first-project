/**
 * T09 채널 초안 — 폼 → API 입력, 응답 모양, 되돌아갈 주소(서버 전용). 게시·승인 경로는 없다.
 */
import { getContentRow, variantContentId, variantStateView, type Db, type VariantState } from '@cs/db';
import { AppError, normalizeNewlines } from '@cs/domain';

export const MAX_VARIANT_REQUEST = 512 * 1024;

export function formToVariantCreate(f: Record<string, string>) {
  return { channel: f.channel ?? '', mode: f.mode ?? '', base_version: Number(f.base_version) };
}

/** 화면 폼의 채널 형식(JSON) 칸을 읽을 수 없음(문법 오류·객체 아님) → 400 metadata_json. */
export class MetadataJsonError extends AppError {
  constructor() {
    super('bad_request', 'metadata_json', '채널 형식(JSON)을 읽을 수 없습니다. 중괄호 { } 로 감싼 JSON 객체여야 합니다.');
  }
}

/**
 * 폼의 metadata 는 JSON 문자열(편집 textarea — 본문과 중복되지 않는 칸만). 읽을 수 없으면 400 metadata_json, 빈 칸은 {}.
 * M3 화면 FIX(D1): 브라우저는 textarea 줄바꿈을 CRLF 로 보낸다 — 본문은 여기서 LF 로 맞춘다(저장 본문은 LF).
 * 본문과 중복되는 칸은 라우트가 bodyAuthoritative 로 본문에서 만든다(D2).
 */
export function formToVariantEdit(f: Record<string, string>) {
  const raw = (f.metadata ?? '').trim();
  let metadata: unknown;
  try {
    metadata = raw === '' ? {} : JSON.parse(raw);
  } catch {
    throw new MetadataJsonError();
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new MetadataJsonError();
  return { base_version: Number(f.base_version), body: normalizeNewlines(f.body ?? ''), metadata: metadata as Record<string, unknown> };
}

export function formToVariantLifecycle(f: Record<string, string>) {
  return { lifecycle: f.lifecycle ?? '', base_version: Number(f.base_version) };
}

/** 변경 후 돌아갈 작성실 주소. 파생본이 이 owner 것이 아니면 원고 목록(404 대신). */
export async function variantBackHref(db: Db, ownerId: string, variantId: string): Promise<string> {
  const contentId = await variantContentId(db, ownerId, variantId.toLowerCase());
  return contentId ? `/contents/${contentId}` : '/contents?missing=1';
}

/** 라우트 응답: 파생본 상태(원고 현재 버전 기준 stale 포함). */
export async function contentCurrentVersionId(db: Db, ownerId: string, contentId: string): Promise<string | null> {
  return (await getContentRow(db, ownerId, contentId))?.currentVersionId ?? null;
}

export const stateJson = (s: VariantState) => variantStateView(s);
