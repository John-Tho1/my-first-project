import { getCaptureDetail, recordExtractBlocked } from '@cs/db';
import {
  AppError,
  assertCollectorAllowed,
  assertFetchableUrl,
  assertSameOrigin,
  CollectorDisabledError,
  CollectorNotEnabledError,
  CollectorNotImplementedError,
  NotFoundError,
  UrlNotAllowedError,
} from '@cs/domain';
import { errorResponse, seeOther, wantsHtml } from '../../../../../lib/api';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

class NotUrlCaptureError extends AppError {
  constructor() {
    super('bad_request', 'not_url_capture', 'URL 로 수집한 소재만 원문을 추출할 수 있습니다');
  }
}

const EXTRACT_CODES = new Set(['url_not_allowed', 'collector_disabled', 'collector_not_implemented', 'not_url_capture']);

/**
 * POST /api/captures/{id}/extract — 원문 추출 요청. 이 단계(M1)에서는 어떤 경우에도 외부 fetch 를 하지 않는다.
 * 1) URL 수집이 아니면 400 not_url_capture
 * 2) assertFetchableUrl(canonical) — 내부망·로컬·메타데이터 주소면 400 url_not_allowed (A05, capture 는 그대로 보존)
 * 3) assertCollectorAllowed — 기본(COLLECTOR_MODE=disabled) 403 collector_disabled
 * 4) enabled 여도 실제 수집기가 없어 501 collector_not_implemented (T19)
 * 2~4 는 source_versions(extraction_state='blocked') 행과 audit capture.extract_blocked(사유만)를 남긴다.
 * 순서: SSRF 검사가 수집 모드 검사보다 먼저다 — 나중에 수집을 켜도 내부 주소는 같은 지점에서 막힌다.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const detail = await getCaptureDetail(owner.db, owner.ownerId, id.toLowerCase());
    if (!detail) throw new NotFoundError('소재를 찾을 수 없습니다');
    const { capture, source } = detail;
    if (capture.inputType !== 'url' || !source?.canonicalUrl) throw new NotUrlCaptureError();

    try {
      assertFetchableUrl(source.canonicalUrl);
    } catch (e) {
      if (e instanceof UrlNotAllowedError) await recordExtractBlocked(owner.db, owner.ownerId, capture, source, 'url_not_allowed');
      throw e;
    }
    try {
      assertCollectorAllowed(config);
    } catch (e) {
      if (e instanceof CollectorDisabledError) {
        await recordExtractBlocked(owner.db, owner.ownerId, capture, source, 'collector_disabled');
        throw new CollectorNotEnabledError();
      }
      throw e;
    }
    await recordExtractBlocked(owner.db, owner.ownerId, capture, source, 'collector_not_implemented');
    throw new CollectorNotImplementedError();
  } catch (e) {
    if (html) {
      const res = errorResponse(e, request);
      if (res.status === 401) {
        const headers = new Headers();
        const cookie = res.headers.get('set-cookie');
        if (cookie) headers.set('set-cookie', cookie);
        return seeOther('/login', headers);
      }
      if (res.status === 404) return seeOther('/captures?missing=1');
      const code = e instanceof AppError && EXTRACT_CODES.has(e.code) ? e.code : 'server';
      return seeOther(`/captures/${encodeURIComponent(id.toLowerCase())}?extract=${code}`);
    }
    return errorResponse(e, request);
  }
}
