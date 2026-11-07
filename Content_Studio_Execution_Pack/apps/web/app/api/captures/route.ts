import { computeDuplicates, createCapture, exactDuplicateIds, listCapturesPage } from '@cs/db';
import {
  AppError,
  assertSameOrigin,
  BadRequestError,
  captureCreateSchema,
  decodeCaptureCursor,
  encodeCaptureCursor,
} from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../lib/api';
import { blankToUndefined, readRequestFields, validationError } from '../../../lib/body';
import { captureView, MAX_CAPTURE_BODY } from '../../../lib/captures';
import { getConfig } from '../../../lib/server';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** 폼(오늘 화면 "빠른 수집") → API 입력. URL 칸을 채우면 URL 수집, 아니면 텍스트 수집. */
function formToCreateInput(f: Record<string, string>) {
  const url = blankToUndefined(f.url);
  return {
    input_type: url ? 'url' : 'text',
    raw_text: blankToUndefined(f.raw_text) === undefined ? undefined : f.raw_text,
    url,
    user_note: blankToUndefined(f.user_note),
    title: blankToUndefined(f.title),
    command_key: f.command_key,
  };
}

/** 폼 실패 시 /?capture_error=<코드>. 화면은 코드별 고정 문구만 보여 준다(입력값을 쿼리에 싣지 않음). */
function captureErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code === 'invalid_url') return 'invalid_url';
    if (e.kind === 'csrf') return 'csrf';
    if (e.kind === 'payload_too_large') return 'too_large';
    return 'invalid';
  }
  return 'server';
}

/**
 * POST /api/captures — 텍스트/URL 수집.
 * 201 { capture, created:true, duplicates:{exact,similar} } · 같은 command_key 재요청은 200 created:false(같은 capture).
 * 브라우저 폼은 303 → /captures/{id}?saved=1 (A19: "저장됨"은 서버 저장이 확인된 뒤의 화면에만 나온다).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request); // 로그인 확인 전에는 본문을 읽지 않는다
    const body = await readRequestFields(request, MAX_CAPTURE_BODY);
    const raw = body.kind === 'form' ? formToCreateInput(body.data) : body.data;
    const parsed = captureCreateSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error);

    const { capture, source, created } = await createCapture(owner.db, owner.ownerId, parsed.data);
    if (html) return seeOther(`/captures/${capture.id}?saved=${created ? '1' : 'existing'}`);
    const duplicates = await computeDuplicates(owner.db, owner.ownerId, capture, source);
    return json({ capture: captureView(capture, source), created, duplicates }, { status: created ? 201 : 200 });
  } catch (e) {
    if (html) {
      const res = errorResponse(e, request);
      if (res.status === 401) {
        const headers = new Headers();
        const cookie = res.headers.get('set-cookie');
        if (cookie) headers.set('set-cookie', cookie);
        return seeOther('/login', headers);
      }
      return seeOther(`/?capture_error=${captureErrorCode(e)}`);
    }
    return errorResponse(e, request);
  }
}

/** GET /api/captures?cursor=&limit= — (received_at desc, id desc) cursor pagination. */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const params = new URL(request.url).searchParams;
  const rawCursor = params.get('cursor');
  const cursor = rawCursor ? decodeCaptureCursor(rawCursor) : null;
  if (rawCursor && !cursor) throw new BadRequestError('cursor 가 올바르지 않습니다');
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestError('limit 은 1~50 사이 정수입니다');

  const page = await listCapturesPage(owner.db, owner.ownerId, { cursor, limit });
  const dupIds = await exactDuplicateIds(
    owner.db,
    owner.ownerId,
    page.items.map((i) => i.capture.id),
  );
  return json({
    items: page.items.map((i) => ({
      ...captureView(i.capture, null, i.sourceUrl),
      has_exact_duplicate: dupIds.has(i.capture.id),
    })),
    next_cursor: page.next ? encodeCaptureCursor(page.next.receivedAt, page.next.id) : null,
  });
});
