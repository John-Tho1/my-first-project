/**
 * T09 채널 초안 — 폼 → API 입력, 응답 모양, 되돌아갈 주소(서버 전용). 게시·승인 경로는 없다.
 */
import { getContentRow, variantContentId, variantStateView, type Db, type VariantState } from '@cs/db';
import { BadRequestError } from '@cs/domain';

export const MAX_VARIANT_REQUEST = 512 * 1024;

export function formToVariantCreate(f: Record<string, string>) {
  return { channel: f.channel ?? '', mode: f.mode ?? '', base_version: Number(f.base_version) };
}

/** 폼의 metadata 는 JSON 문자열(편집 textarea). 형식이 틀리면 400. */
export function formToVariantEdit(f: Record<string, string>) {
  let metadata: unknown;
  try {
    metadata = JSON.parse(f.metadata ?? '');
  } catch {
    throw new BadRequestError('채널 형식(JSON)을 읽을 수 없습니다');
  }
  return { base_version: Number(f.base_version), body: f.body ?? '', metadata };
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
