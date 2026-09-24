import { createHash, randomUUID } from 'node:crypto';
import { findAssetByChecksum, insertAsset, recordAudit, type AssetRow } from '@cs/db';
import {
  AppError,
  assertSameOrigin,
  BadRequestError,
  buildAssetKey,
  MAX_UPLOAD_BYTES,
  PayloadTooLargeError,
  resolveUploadMime,
  rightsStatusSchema,
} from '@cs/domain';
import { errorResponse, json, readBodyCapped, seeOther, wantsHtml } from '../../../../lib/api';
import { getConfig, getStorage } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** multipart 경계·헤더 여유분. 파일 자체의 10MB 제한은 아래에서 따로 검사한다. */
const MULTIPART_OVERHEAD = 64 * 1024;

function view(a: AssetRow) {
  return {
    id: a.id,
    mime: a.mime,
    bytes: a.bytes,
    checksum: a.checksum,
    rights_status: a.rightsStatus,
    verification_state: a.verificationState,
  };
}

function uploadErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.kind === 'payload_too_large') return 'too_large';
    if (e.kind === 'unsupported_media_type') return 'unsupported';
    if (e.kind === 'csrf') return 'csrf';
    return 'invalid';
  }
  return 'server';
}

/**
 * POST /api/assets/uploads — multipart `file` (+ 선택 `rights_status`).
 *
 * M1 단순화(T02): 파일을 web 요청 안에서 받아 서버가 직접 크기(≤10MB)·내용(magic bytes)·checksum 을 검증하므로
 * 곧바로 verification_state=VERIFIED 로 저장한다. docs/02 의 "제한된 업로드 권한 → 완료 검증" 업로드 세션 흐름은
 * 대용량 파일(M2 T08)에서 구현한다.
 * 같은 owner 의 같은 checksum 이면 새로 쓰지 않고 기존 asset 을 200 + duplicate:true 로 반환한다.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request); // 로그인 확인 전에는 본문을 읽지 않는다
    const storage = getStorage(config);

    const type = request.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('multipart/form-data')) throw new BadRequestError('multipart/form-data 로 보내야 합니다');
    const body = await readBodyCapped(request, MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD);
    let form: FormData;
    try {
      form = await new Response(body, { headers: { 'content-type': type } }).formData();
    } catch {
      throw new BadRequestError();
    }
    const file = form.get('file');
    if (!(file instanceof Blob)) throw new BadRequestError('file 필드가 필요합니다');
    if (file.size > MAX_UPLOAD_BYTES) throw new PayloadTooLargeError();
    if (file.size === 0) throw new BadRequestError('빈 파일은 올릴 수 없습니다');

    const rawRights = form.get('rights_status');
    const rights = rightsStatusSchema.safeParse(typeof rawRights === 'string' && rawRights !== '' ? rawRights : 'unknown');
    if (!rights.success) throw new BadRequestError('rights_status 값이 올바르지 않습니다');

    const bytes = new Uint8Array(await file.arrayBuffer());
    const filename = 'name' in file && typeof file.name === 'string' ? file.name : null;
    const mime = resolveUploadMime(bytes, filename);
    const checksum = createHash('sha256').update(bytes).digest('hex');

    const existing = await findAssetByChecksum(owner.db, owner.ownerId, checksum);
    if (existing) return done(existing, true);

    const id = randomUUID();
    const key = buildAssetKey(owner.ownerId, id);
    await storage.put(key, bytes);
    const inserted = await insertAsset(owner.db, {
      id,
      ownerId: owner.ownerId,
      key,
      mime,
      bytes: bytes.byteLength,
      checksum,
      rightsStatus: rights.data,
      verificationState: 'VERIFIED',
    });
    if (!inserted) {
      // 동시 중복 업로드: 방금 쓴 파일을 지우고 먼저 저장된 asset 을 돌려준다.
      await storage.delete(key);
      const winner = await findAssetByChecksum(owner.db, owner.ownerId, checksum);
      if (!winner) throw new Error('asset 중복 처리 실패');
      return done(winner, true);
    }
    await recordAudit(owner.db, {
      ownerId: owner.ownerId,
      action: 'asset.upload',
      entity: 'asset',
      entityId: inserted.id,
      versionOrHash: checksum,
      details: { mime, bytes: bytes.byteLength },
    });
    return done(inserted, false);
  } catch (e) {
    if (html) {
      const res = errorResponse(e, request);
      if (res.status === 401) {
        const headers = new Headers();
        const cookie = res.headers.get('set-cookie');
        if (cookie) headers.set('set-cookie', cookie);
        return seeOther('/login', headers);
      }
      return seeOther(`/?upload_error=${uploadErrorCode(e)}`);
    }
    return errorResponse(e, request);
  }

  function done(a: AssetRow, duplicate: boolean): Response {
    if (html) return seeOther(duplicate ? '/?upload=duplicate' : '/?upload=ok');
    return duplicate ? json({ ...view(a), duplicate: true }) : json(view(a), { status: 201 });
  }
}
