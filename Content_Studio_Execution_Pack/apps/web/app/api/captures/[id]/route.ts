import { computeDuplicates, getCaptureDetail, updateCapture } from '@cs/db';
import {
  AppError,
  assertSameOrigin,
  BadRequestError,
  ConflictError,
  NotFoundError,
  parseCapturePatch,
  parseIfMatchRevision,
  type CapturePatchInput,
} from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther } from '../../../../lib/api';
import { readRequestFields, validationError } from '../../../../lib/body';
import {
  captureView,
  conflictRedirectLocation,
  extractionView,
  MAX_CAPTURE_BODY,
  renderConflictHtml,
  revisionEtag,
  revisionView,
  sourceView,
  type ConflictValues,
} from '../../../../lib/captures';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = '소재를 찾을 수 없습니다';

/** GET /api/captures/{id} — owner 의 capture + source + 중복 후보 + 수정 이력. 그 외는 404. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const detail = await getCaptureDetail(owner.db, owner.ownerId, id.toLowerCase());
  if (!detail) throw new NotFoundError(NOT_FOUND);
  const duplicates = await computeDuplicates(owner.db, owner.ownerId, detail.capture, detail.source);
  return json(
    {
      capture: captureView(detail.capture, detail.source),
      source: sourceView(detail.source),
      duplicates,
      revisions: detail.revisions.map(revisionView),
      extractions: detail.extractions.map(extractionView),
    },
    { headers: { etag: revisionEtag(detail.capture.revision) } },
  );
});

async function applyPatch(owner: Awaited<ReturnType<typeof requireOwner>>, id: string, raw: unknown) {
  const parsed = parseCapturePatch(raw);
  if (!parsed.success) throw validationError(parsed.error);
  const { expected_revision, ...patch } = parsed.data satisfies CapturePatchInput;
  return updateCapture(owner.db, owner.ownerId, id.toLowerCase(), patch, expected_revision);
}

/**
 * PATCH /api/captures/{id} — 메모·제목·위험만 수정(원문 불변 → raw_text 가 있으면 400 raw_text_immutable).
 * 버전: `If-Match: "<revision>"` 또는 본문 expected_revision (둘 다 있으면 헤더 우선).
 * 오래된 revision → 409 { error:'conflict', message, current, yours } (A02: 제출 값을 그대로 돌려줘 잃지 않게 함).
 */
export const PATCH = apiHandler<Ctx>(async (request, ctx) => {
  assertSameOrigin(request, getConfig());
  const { id } = await ctx.params;
  const ifMatch = parseIfMatchRevision(request.headers.get('if-match'));
  if (ifMatch === undefined) throw new BadRequestError('If-Match 형식이 올바르지 않습니다. 예: If-Match: "3"');
  const owner = await requireOwner(request); // 로그인 확인 전에는 본문을 읽지 않는다
  const body = await readRequestFields(request, MAX_CAPTURE_BODY);
  if (body.kind !== 'json' || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    throw new BadRequestError('application/json 객체로 보내야 합니다');
  }
  const raw = ifMatch === null ? body.data : { ...body.data, expected_revision: ifMatch };
  const updated = await applyPatch(owner, id, raw);
  return json({ capture: captureView(updated) }, { headers: { etag: revisionEtag(updated.revision) } });
});

function editErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code === 'raw_text_immutable') return 'raw_text_immutable';
    if (e.kind === 'csrf') return 'csrf';
    return 'invalid';
  }
  return 'server';
}

/**
 * POST /api/captures/{id} — 브라우저 폼 전용 수정 경로(HTML 폼은 PATCH 를 못 보냄). `_method=PATCH` 필수.
 * 성공 303 → /captures/{id}?updated=<rev>. 충돌이면 제출 값을 query 에 실어 303 → /captures/{id}?conflict=1&y_…,
 * query 가 2000자를 넘으면 잘라내지 않고 409 HTML(비교표 + 내 입력이 채워진 폼)을 직접 응답한다.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  const back = `/captures/${encodeURIComponent(id)}`;
  let yours: ConflictValues = {};
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_CAPTURE_BODY);
    if (body.kind !== 'form' || body.data._method !== 'PATCH') {
      return new Response(null, { status: 405, headers: { allow: 'GET, PATCH', 'cache-control': 'no-store' } });
    }
    const f = body.data;
    const raw: Record<string, unknown> = { expected_revision: Number(f.expected_revision) };
    for (const k of ['user_note', 'title', 'risk', 'raw_text'] as const) if (f[k] !== undefined) raw[k] = f[k];
    yours = {
      revision: Number(f.expected_revision),
      user_note: f.user_note,
      title: f.title,
      risk: f.risk,
    };
    const updated = await applyPatch(owner, id, raw);
    return seeOther(`${back}?updated=${updated.revision}`);
  } catch (e) {
    if (e instanceof ConflictError) {
      const location = conflictRedirectLocation(id.toLowerCase(), yours);
      if (location) return seeOther(location);
      const current = e.extra!.current as Parameters<typeof renderConflictHtml>[1];
      return new Response(renderConflictHtml(id.toLowerCase(), current, yours), {
        status: 409,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
          'referrer-policy': 'no-referrer',
        },
      });
    }
    const res = errorResponse(e, request);
    if (res.status === 401) {
      const headers = new Headers();
      const cookie = res.headers.get('set-cookie');
      if (cookie) headers.set('set-cookie', cookie);
      return seeOther('/login', headers);
    }
    if (res.status === 404) return seeOther('/captures?missing=1');
    return seeOther(`${back}?edit_error=${editErrorCode(e)}`);
  }
}
