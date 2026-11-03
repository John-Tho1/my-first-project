/**
 * capture API 응답 모양과 폼 처리 보조(서버 전용).
 * JSON 필드명은 docs/04 의 snake_case 를 따른다.
 */
import type { CaptureRevisionRow, CaptureRow, SourceRow, SourceVersionRow } from '@cs/db';
import { MAX_RAW_TEXT, MAX_TITLE, MAX_URL_LENGTH, MAX_USER_NOTE } from '@cs/domain';

/**
 * FIX3-FULLREV2(G28): 수집 본문 상한은 허용 필드 전부가 최악으로 인코딩된 크기를 덮어야 한다.
 * urlencoded 폼에서 한국어 1글자(UTF-16 1단위)는 `%XX%XX%XX` 9바이트, 서로게이트 쌍은 2단위에 12바이트 — 단위당 최대 9바이트다.
 * 여유 있게 단위당 12바이트 × (원문 + 메모 + 제목 + URL) + 필드 이름·command_key 등 16KiB. 글자 수 검사는 파싱 뒤 zod 가 그대로 한다.
 * (128KiB 였을 때는 한국어 원문 약 14,500자부터 413 too_large 로 거부되었다.)
 */
export const MAX_CAPTURE_BODY = (MAX_RAW_TEXT + MAX_USER_NOTE + MAX_TITLE + MAX_URL_LENGTH) * 12 + 16 * 1024;

export function sourceView(s: SourceRow | null) {
  if (!s) return null;
  return { id: s.id, kind: s.kind, canonical_url: s.canonicalUrl, normalized_url: s.normalizedUrl };
}

export function captureView(c: CaptureRow, source: SourceRow | null = null, sourceUrl?: string | null) {
  return {
    id: c.id,
    input_type: c.inputType,
    raw_text: c.rawText,
    title: c.title,
    user_note: c.userNote,
    risk: c.risk,
    revision: c.revision,
    received_at: c.receivedAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
    content_hash: c.contentHash,
    source_id: c.sourceId,
    source_url: source?.canonicalUrl ?? sourceUrl ?? null,
  };
}

export function revisionView(r: CaptureRevisionRow) {
  return {
    revision: r.revision,
    user_note: r.userNote,
    title: r.title,
    risk: r.risk,
    changed_at: r.changedAt.toISOString(),
    changed_by: r.changedBy,
  };
}

export function extractionView(v: SourceVersionRow) {
  return { id: v.id, extraction_state: v.extractionState, fetched_at: v.fetchedAt.toISOString() };
}

/** ETag/If-Match 에 쓰는 revision 표기 */
export const revisionEtag = (revision: number) => `"${revision}"`;

// ---- 409 충돌(폼 제출) ----

export interface ConflictValues {
  revision?: number;
  user_note?: string | null;
  title?: string | null;
  risk?: string;
}

/** 폼 충돌 리다이렉트 URL 의 최대 길이(퍼센트 인코딩 후). 넘으면 409 HTML 로 응답한다. */
export const MAX_CONFLICT_REDIRECT = 2000;

/**
 * 충돌 시 사용자가 제출한 값(yours)을 query 로 실어 상세 화면으로 돌려보낸다.
 * 길이가 MAX_CONFLICT_REDIRECT 를 넘으면 null — 호출자는 잘라내지 않고 409 HTML 을 직접 렌더한다(입력 손실 방지).
 */
export function conflictRedirectLocation(id: string, yours: ConflictValues): string | null {
  const q = new URLSearchParams({ conflict: '1' });
  if (yours.revision !== undefined) q.set('y_rev', String(yours.revision));
  if (yours.user_note !== undefined) q.set('y_note', yours.user_note ?? '');
  if (yours.title !== undefined) q.set('y_title', yours.title ?? '');
  if (yours.risk !== undefined) q.set('y_risk', yours.risk);
  const location = `/captures/${id}?${q.toString()}`;
  return location.length <= MAX_CONFLICT_REDIRECT ? location : null;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const RISK_TEXT: Record<string, string> = { none: '위험 표시 없음', needs_check: '확인 필요' };

/**
 * 긴 입력의 충돌 화면(409, 서버 렌더 HTML). 스크립트 없음, 모든 값 escape.
 * 현재 서버 내용과 내가 입력한 내용을 나란히 보여 주고, 내 입력을 채운 폼으로 현재 revision 기준 재저장을 할 수 있다.
 */
export function renderConflictHtml(
  id: string,
  current: { revision: number; user_note: string | null; title: string | null; risk: string; updated_at: string },
  yours: ConflictValues,
): string {
  const row = (label: string, a: string, b: string) =>
    `<tr><th scope="row">${esc(label)}</th><td>${esc(a)}</td><td>${esc(b)}</td></tr>`;
  const riskOpt = (v: string) =>
    `<option value="${v}"${(yours.risk ?? current.risk) === v ? ' selected' : ''}>${esc(RISK_TEXT[v]!)}</option>`;
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>수정 충돌 — Content Studio</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:0 auto;padding:16px;line-height:1.5}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px;vertical-align:top;white-space:pre-wrap;word-break:break-word}
.notice{border:1px solid #c77;padding:8px}textarea,input,select{width:100%;box-sizing:border-box}label{display:block;margin-top:8px}</style>
</head><body>
<h1>수정 충돌</h1>
<p class="notice" role="alert">다른 곳에서 먼저 수정되었습니다. 현재 내용과 비교한 뒤 다시 저장하세요. 내가 입력한 내용은 아래 폼에 그대로 남아 있습니다.</p>
<table><thead><tr><th></th><th>현재 서버 내용 (수정 ${current.revision})</th><th>내가 입력한 내용</th></tr></thead><tbody>
${row('메모', current.user_note ?? '', yours.user_note ?? '')}
${row('제목', current.title ?? '', yours.title ?? '')}
${row('위험', RISK_TEXT[current.risk] ?? current.risk, yours.risk ? (RISK_TEXT[yours.risk] ?? yours.risk) : '')}
</tbody></table>
<form method="post" action="/api/captures/${esc(id)}">
<input type="hidden" name="_method" value="PATCH">
<input type="hidden" name="expected_revision" value="${current.revision}">
<label for="user_note">메모</label><textarea id="user_note" name="user_note" rows="6" maxlength="2000">${esc(yours.user_note ?? '')}</textarea>
<label for="title">제목</label><input id="title" name="title" maxlength="200" value="${esc(yours.title ?? '')}">
<label for="risk">위험</label><select id="risk" name="risk">${riskOpt('none')}${riskOpt('needs_check')}</select>
<p><button type="submit">내 입력으로 다시 저장(현재 수정 ${current.revision} 기준)</button> <a href="/captures/${esc(id)}">저장하지 않고 돌아가기</a></p>
</form></body></html>`;
}
