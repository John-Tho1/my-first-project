/**
 * 카드(idea)·원고(content) API 응답 모양, 폼 처리, 409 비교 화면(서버 전용). JSON 필드는 snake_case(docs/04).
 */
import type { ContentDetail, ContentRow, ContentVersionRow, IdeaRow, VersionSummary } from '@cs/db';
import {
  AppError,
  BadRequestError,
  diffLines,
  diffStats,
  MAX_CONTENT_BODY,
  parseTagsInput,
  type DiffLine,
} from '@cs/domain';
import { errorResponse, seeOther } from './api';
import { blankToUndefined } from './body';

/** 본문 100,000자(UTF-8 최대 4바이트) + 폼 인코딩 여유 */
export const MAX_CONTENT_REQUEST = MAX_CONTENT_BODY * 4 * 3 + 64 * 1024;
export const MAX_IDEA_REQUEST = 64 * 1024;

export const LIFECYCLE_LABEL: Record<string, string> = {
  draft: '초안',
  review: '검토 중',
  ready: '준비됨',
  archived: '보관',
};

export function ideaView(i: IdeaRow, captureIds?: string[]) {
  return {
    id: i.id,
    idea: i.idea,
    audience: i.audience,
    evidence: i.evidence,
    risk: i.risk,
    next_question: i.nextQuestion,
    next_decision: i.nextDecision,
    tags: i.tags,
    lifecycle: i.lifecycle,
    revision: i.revision,
    created_at: i.createdAt.toISOString(),
    updated_at: i.updatedAt.toISOString(),
    ...(captureIds ? { capture_ids: captureIds } : {}),
  };
}

export function contentView(c: ContentRow) {
  return {
    id: c.id,
    title: c.title,
    series: c.series,
    audience: c.audience,
    tags: c.tags,
    lifecycle: c.lifecycle,
    revision: c.revision,
    idea_id: c.ideaId,
    current_version_id: c.currentVersionId,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

export function versionView(v: ContentVersionRow) {
  return {
    id: v.id,
    content_id: v.contentId,
    version: v.version,
    body: v.body,
    note: v.note,
    created_by: v.createdBy,
    ai_run_id: v.aiRunId,
    created_at: v.createdAt.toISOString(),
  };
}

export function versionSummaryView(v: VersionSummary) {
  return {
    id: v.id,
    version: v.version,
    created_at: v.createdAt.toISOString(),
    created_by: v.createdBy,
    bytes: v.bytes,
    note: v.note,
    ai_run_id: v.aiRunId,
  };
}

export function contentDetailView(d: ContentDetail) {
  return {
    content: contentView(d.content),
    current_version: versionView(d.current),
    versions: d.versions.map(versionSummaryView),
    origin_captures: d.captures.map((c) => ({
      id: c.id,
      title: c.title,
      raw_text: c.rawText,
      received_at: c.receivedAt.toISOString(),
      role: 'origin',
    })),
    idea: d.idea ? ideaView(d.idea) : null,
  };
}

// ---- 폼 → API 입력 ----

/** 폼 칸: 빈 문자열은 "비우기"(null)로 보낸다 — 수정 폼은 모든 칸을 항상 보내므로. 칸이 없으면 undefined. */
const formText = (v: string | undefined) => (v === undefined ? undefined : v.trim() === '' ? null : v);

export function formToIdeaCreate(f: Record<string, string>, captureId?: string) {
  return {
    idea: f.idea ?? '',
    audience: blankToUndefined(f.audience),
    evidence: blankToUndefined(f.evidence),
    risk: blankToUndefined(f.risk),
    next_question: blankToUndefined(f.next_question),
    next_decision: blankToUndefined(f.next_decision),
    tags: parseTagsInput(f.tags),
    capture_ids: captureId ? [captureId] : undefined,
  };
}

export function formToIdeaPatch(f: Record<string, string>) {
  return {
    expected_revision: Number(f.expected_revision),
    idea: f.idea,
    audience: formText(f.audience),
    evidence: formText(f.evidence),
    risk: blankToUndefined(f.risk),
    next_question: formText(f.next_question),
    next_decision: formText(f.next_decision),
    tags: parseTagsInput(f.tags),
  };
}

export function formToContentMetaPatch(f: Record<string, string>) {
  return {
    expected_revision: Number(f.expected_revision),
    title: f.title,
    series: formText(f.series),
    audience: formText(f.audience),
    tags: parseTagsInput(f.tags),
    lifecycle: blankToUndefined(f.lifecycle),
  };
}

/** 폼 실패 공통: 401 → /login(만료 쿠키 삭제 유지), 404 → notFoundHref, 그 외 → back?error=<code>. */
export function formFailure(e: unknown, request: Request, back: string, notFoundHref: string): Response {
  const res = errorResponse(e, request);
  if (res.status === 401) {
    const headers = new Headers();
    const cookie = res.headers.get('set-cookie');
    if (cookie) headers.set('set-cookie', cookie);
    return seeOther('/login', headers);
  }
  if (res.status === 404) return seeOther(notFoundHref);
  const code =
    e instanceof AppError
      ? e.code === 'invalid_transition'
        ? 'invalid_transition'
        : e.code === 'unconfirmed_experience_claims'
          ? 'unconfirmed_claims'
          : e.kind === 'csrf'
          ? 'csrf'
          : e.kind === 'payload_too_large'
            ? 'too_large'
            : 'invalid'
      : 'server';
  const sep = back.includes('?') ? '&' : '?';
  return seeOther(`${back}${sep}error=${code}`);
}

/** 폼 오류 코드별 고정 문구(쿼리 값을 그대로 출력하지 않는다). */
export const FORM_ERROR_TEXT: Record<string, string> = {
  invalid: '저장하지 못했습니다. 입력값을 확인하세요.',
  invalid_transition: '그 상태로는 바로 바꿀 수 없습니다. 허용된 다음 상태만 고를 수 있습니다.',
  unconfirmed_claims:
    '채택한 AI 제안에 확인하지 않은 1인칭 경험 주장이 있어 "준비됨"으로 바꿀 수 없습니다. 아래 "AI 작성 보조"에서 사실인지 확인하세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  too_large: '내용이 너무 깁니다.',
  server: '서버 오류로 저장하지 못했습니다.',
};

// ---- 409 비교 화면(서버 렌더 HTML, 스크립트 없음, 모든 값 escape) ----

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CONFLICT_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  'referrer-policy': 'no-referrer',
} as const;

const PAGE_STYLE = `body{font-family:system-ui,sans-serif;max-width:1080px;margin:0 auto;padding:16px;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px;vertical-align:top;white-space:pre-wrap;word-break:break-word}
.notice{border:1px solid #c77;padding:8px}textarea,input,select{width:100%;box-sizing:border-box;font:inherit}label{display:block;margin-top:8px}
pre{white-space:pre-wrap;word-break:break-word;border:1px solid #ccc;padding:8px;max-height:60vh;overflow:auto}
.cols{display:grid;gap:12px}@media(min-width:720px){.cols{grid-template-columns:1fr 1fr}}
.diff{font-family:ui-monospace,monospace;font-size:.875rem;border:1px solid #ccc;padding:8px;max-height:60vh;overflow:auto}
.diff div{white-space:pre-wrap;word-break:break-word}.add{background:#e6ffec}.del{background:#ffebe9;text-decoration:line-through}
@media(prefers-color-scheme:dark){body{background:#14161a;color:#e8eaee}.add{background:#12361f}.del{background:#4a1f1f}a{color:#7ea0ff}}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} — Content Studio</title><style>${PAGE_STYLE}</style></head><body>
${body}
</body></html>`;
}

export function renderDiffHtml(d: readonly DiffLine[]): string {
  const stats = diffStats(d);
  const lines = d
    .map((l) => {
      const mark = l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  ';
      const cls = l.type === 'same' ? '' : ` class="${l.type}"`;
      return `<div${cls}>${esc(mark + l.text)}</div>`;
    })
    .join('');
  return `<p>추가 ${stats.added}줄 · 삭제 ${stats.removed}줄 · 같음 ${stats.same}줄</p><div class="diff">${lines || '<div>(차이 없음)</div>'}</div>`;
}

/**
 * 본문 저장 충돌(409): 현재 서버 본문과 내가 쓴 본문을 모두 그대로 보여 주고(A02 원문 손실 없음),
 * 현재→내 본문 diff, 그리고 내 본문이 채워진 재저장 폼(base_version = 현재 버전).
 */
export function renderVersionConflictHtml(
  contentId: string,
  current: { version: number; body: string },
  yours: { base_version: number; body: string; note: string | null },
): Response {
  const id = esc(contentId);
  const html = page(
    '본문 저장 충돌',
    `<h1>본문 저장 충돌</h1>
<p class="notice" role="alert">내가 편집을 시작한 뒤(버전 ${yours.base_version}) 다른 곳에서 버전 ${current.version} 이 먼저 저장되었습니다.
내가 쓴 본문은 아래에 그대로 남아 있습니다. 비교한 뒤 다시 저장하세요.</p>
<div class="cols">
<section><h2>현재 서버 본문 (버전 ${current.version})</h2><pre>${esc(current.body)}</pre></section>
<section><h2>내가 쓴 본문 (버전 ${yours.base_version} 기준)</h2><pre>${esc(yours.body)}</pre></section>
</div>
<h2>차이 (현재 버전 ${current.version} → 내 본문)</h2>
${renderDiffHtml(diffLines(current.body, yours.body))}
<form method="post" action="/api/contents/${id}/versions">
<input type="hidden" name="base_version" value="${current.version}">
<label for="body">본문(내가 쓴 내용)</label><textarea id="body" name="body" rows="18" maxlength="${MAX_CONTENT_BODY}">${esc(yours.body)}</textarea>
<label for="note">저장 메모(선택)</label><input id="note" name="note" maxlength="500" value="${esc(yours.note ?? '')}">
<p><button type="submit">내 본문으로 새 버전 저장(현재 버전 ${current.version} 기준)</button> <a href="/contents/${id}">저장하지 않고 돌아가기</a></p>
</form>`,
  );
  return new Response(html, { status: 409, headers: CONFLICT_HEADERS });
}

export interface ConflictField {
  name: string;
  label: string;
  current: string;
  yours: string;
  input: 'text' | 'textarea' | { options: ReadonlyArray<[string, string]> };
  maxLength?: number;
}

/** 메타데이터·카드 수정 충돌(409): 필드별 현재/내 입력 비교표 + 내 입력이 채워진 재저장 폼. */
export function renderFieldsConflictHtml(opts: {
  title: string;
  action: string;
  backHref: string;
  currentRevision: number;
  fields: readonly ConflictField[];
}): Response {
  const rows = opts.fields
    .map((f) => `<tr><th scope="row">${esc(f.label)}</th><td>${esc(f.current)}</td><td>${esc(f.yours)}</td></tr>`)
    .join('\n');
  const inputs = opts.fields
    .map((f) => {
      const idAttr = `f_${esc(f.name)}`;
      const label = `<label for="${idAttr}">${esc(f.label)}</label>`;
      const max = f.maxLength ? ` maxlength="${f.maxLength}"` : '';
      if (f.input === 'text') return `${label}<input id="${idAttr}" name="${esc(f.name)}"${max} value="${esc(f.yours)}">`;
      if (f.input === 'textarea') return `${label}<textarea id="${idAttr}" name="${esc(f.name)}" rows="4"${max}>${esc(f.yours)}</textarea>`;
      const options = f.input.options
        .map(([v, text]) => `<option value="${esc(v)}"${v === f.yours ? ' selected' : ''}>${esc(text)}</option>`)
        .join('');
      return `${label}<select id="${idAttr}" name="${esc(f.name)}">${options}</select>`;
    })
    .join('\n');
  const html = page(
    opts.title,
    `<h1>${esc(opts.title)}</h1>
<p class="notice" role="alert">다른 곳에서 먼저 수정되었습니다. 현재 내용과 비교한 뒤 다시 저장하세요. 내가 입력한 내용은 아래 폼에 그대로 남아 있습니다.</p>
<table><thead><tr><th></th><th>현재 서버 내용 (수정 ${opts.currentRevision})</th><th>내가 입력한 내용</th></tr></thead><tbody>
${rows}
</tbody></table>
<form method="post" action="${esc(opts.action)}">
<input type="hidden" name="_method" value="PATCH">
<input type="hidden" name="expected_revision" value="${opts.currentRevision}">
${inputs}
<p><button type="submit">내 입력으로 다시 저장(현재 수정 ${opts.currentRevision} 기준)</button> <a href="${esc(opts.backHref)}">저장하지 않고 돌아가기</a></p>
</form>`,
  );
  return new Response(html, { status: 409, headers: CONFLICT_HEADERS });
}

export const tagsText = (tags: unknown) => (Array.isArray(tags) ? tags.join(', ') : '');
export const nz = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** JSON 본문이 객체인지 확인한다(배열·null·폼은 400). */
export function jsonObject(body: { kind: 'json' | 'form'; data: unknown }): Record<string, unknown> {
  if (body.kind !== 'json' || typeof body.data !== 'object' || body.data === null || Array.isArray(body.data)) {
    throw new BadRequestError('application/json 객체로 보내야 합니다');
  }
  return body.data as Record<string, unknown>;
}

/** 폼 POST 로 PATCH 를 흉내 낼 때 `_method=PATCH` 가 없으면 405. */
export const methodNotAllowed = (allow: string) =>
  new Response(null, { status: 405, headers: { allow, 'cache-control': 'no-store' } });

