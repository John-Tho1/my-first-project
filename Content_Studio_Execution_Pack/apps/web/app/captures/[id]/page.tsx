import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { computeDuplicates, getCaptureDetail, getCapturesByIds, listCaptureDerivations } from '@cs/db';
import { formatMsk, formatMskInline, ideaSeedFromCapture, isFetchableUrl, MAX_IDEA, MAX_TITLE, MAX_USER_NOTE } from '@cs/domain';
import { getSession } from '../../../lib/auth';
import { FORM_ERROR_TEXT, LIFECYCLE_LABEL } from '../../../lib/contents';
import { INPUT_TYPE_LABEL, preview, RISK_LABEL } from '../../../lib/labels';
import { getAppDb, getConfig } from '../../../lib/server';

export const dynamic = 'force-dynamic';

/** ?extract= 코드별 고정 문구 */
const EXTRACT_TEXT: Record<string, string> = {
  url_not_allowed: '내부망·로컬 주소는 추출할 수 없습니다. URL 과 메모는 그대로 저장되어 있습니다.',
  collector_disabled: '수집 기능이 비활성 상태입니다(M5에서 활성화). 외부 사이트에 접속하지 않았습니다.',
  collector_not_implemented: '실제 수집기는 아직 구현되지 않았습니다(T19). 외부 사이트에 접속하지 않았습니다.',
  not_url_capture: 'URL 로 수집한 소재만 원문을 추출할 수 있습니다.',
  server: '서버 오류가 발생했습니다.',
};

/** ?edit_error= 코드별 고정 문구 */
const EDIT_ERROR_TEXT: Record<string, string> = {
  raw_text_immutable: '원문은 수정할 수 없습니다. 메모·제목·위험 표시만 수정할 수 있습니다.',
  invalid: '저장하지 못했습니다. 입력값을 확인하세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  server: '서버 오류로 저장하지 못했습니다.',
};

const REASON_TEXT = { url: 'URL 같음', content: '원문 같음' } as const;

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export default async function CaptureDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;
  const q = await searchParams;
  const { db } = await getAppDb(getConfig());
  // owner 범위로만 조회(다른 owner·없는 ID 는 404).
  const detail = await getCaptureDetail(db, session.ownerId, id.toLowerCase());
  if (!detail) notFound();
  const { capture: c, source, revisions, extractions } = detail;
  const dups = await computeDuplicates(db, session.ownerId, c, source);
  const derived = await listCaptureDerivations(db, session.ownerId, c.id);
  const related = await getCapturesByIds(db, session.ownerId, [
    ...dups.exact.map((d) => d.id),
    ...dups.similar.map((d) => d.id),
  ]);

  // A19: "저장됨"은 서버에서 다시 읽은 capture 가 있을 때만(이 페이지는 DB 에서 방금 읽었다) 보여 준다.
  const saved = str(q.saved);
  const updatedRev = Number(str(q.updated));
  const updatedRow = Number.isInteger(updatedRev) ? revisions.find((r) => r.revision === updatedRev) : undefined;
  const extractMsg = str(q.extract) ? (EXTRACT_TEXT[str(q.extract)!] ?? EXTRACT_TEXT.server) : undefined;
  const formErr = str(q.error) ? (FORM_ERROR_TEXT[str(q.error)!] ?? FORM_ERROR_TEXT.server) : undefined;
  const editErr = str(q.edit_error) ? (EDIT_ERROR_TEXT[str(q.edit_error)!] ?? EDIT_ERROR_TEXT.server) : undefined;

  // 409 충돌: 리다이렉트 query 에 실려 온 "내가 입력한 내용"(yours). 폼 기본값으로 다시 채워 입력을 잃지 않게 한다.
  const conflict = str(q.conflict) === '1';
  const yours = conflict
    ? {
        revision: str(q.y_rev),
        user_note: str(q.y_note) ?? '',
        title: str(q.y_title) ?? '',
        risk: str(q.y_risk) === 'needs_check' ? 'needs_check' : str(q.y_risk) === 'none' ? 'none' : c.risk,
      }
    : null;
  const form = yours ?? { user_note: c.userNote ?? '', title: c.title ?? '', risk: c.risk };
  const sourceUrl = source?.canonicalUrl ?? null;
  const fetchable = sourceUrl ? isFetchableUrl(sourceUrl) : false;

  return (
    <main className="container">
      <header className="header">
        <h1>Content Studio</h1>
        <p className="now">
          <Link href="/">← 오늘</Link> · <Link href="/captures">소재함</Link>
        </p>
      </header>

      <h2 className="screen-title">{c.title ?? '소재'}</h2>

      {saved === '1' ? (
        <p className="saved" role="status">
          {`서버에 저장됨 ✓ (${formatMskInline(c.receivedAt)})`}
        </p>
      ) : saved === 'existing' ? (
        <p className="saved" role="status">
          {`이미 서버에 저장된 요청입니다 ✓ (${formatMskInline(c.receivedAt)}) — 같은 제출이 다시 와서 새로 만들지 않았습니다.`}
        </p>
      ) : null}
      {updatedRow ? (
        <p className="saved" role="status">
          {`서버에 저장됨 ✓ (수정 ${updatedRow.revision}, ${formatMskInline(updatedRow.changedAt)})`}
        </p>
      ) : null}
      <p className="note">이 화면은 서버 저장만 표시합니다. 기기 임시 저장(오프라인)은 아직 지원하지 않습니다.</p>

      <section className="card archive" aria-labelledby="raw-title">
        <h3 id="raw-title">원문(수정 불가)</h3>
        <pre className="raw-text">{c.rawText}</pre>
        <p className="meta">
          <span className="tag">{INPUT_TYPE_LABEL[c.inputType] ?? c.inputType}</span>
          <span className={c.risk === 'needs_check' ? 'tag warn' : 'tag'}>{RISK_LABEL[c.risk] ?? c.risk}</span>
          <span>수집: {formatMsk(c.receivedAt)}</span>
          <span>수정 {c.revision}</span>
        </p>
        {c.userNote ? <p className="note">메모: {c.userNote}</p> : null}
        {sourceUrl ? (
          <p className="note">
            출처 URL:{' '}
            <a href={sourceUrl} rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" target="_blank">
              {sourceUrl}
            </a>
            {fetchable ? null : ' (내부망·로컬 주소 — 추출할 수 없음)'}
          </p>
        ) : null}
      </section>

      <section className="card archive" aria-labelledby="develop-title">
        <h3 id="develop-title">발전시키기</h3>
        {formErr ? (
          <p className="notice" role="alert">
            {formErr}
          </p>
        ) : null}
        <form className="form" method="post" action={`/api/captures/${c.id}/ideas`}>
          <label htmlFor="idea">핵심 아이디어(카드 문구)</label>
          <textarea id="idea" name="idea" rows={2} maxLength={MAX_IDEA} required defaultValue={ideaSeedFromCapture(c.title, c.rawText)} />
          <button type="submit">카드로 발전</button>
        </form>
        <form className="form inline" method="post" action={`/api/captures/${c.id}/contents`}>
          <button type="submit">원고 시작</button>
        </form>
        <p className="note">원고 시작은 이 원문을 인용한 초안(버전 1)을 만들고 원문(수집)으로 연결합니다. 원문은 바뀌지 않습니다.</p>
        {derived.ideas.length || derived.contents.length ? (
          <ul className="list">
            {derived.ideas.map((i) => (
              <li key={i.id} className="capture">
                <p className="meta">
                  <span className="tag">카드</span>
                  <Link href={`/ideas/${i.id}`}>{preview(i.idea, 60)}</Link>
                </p>
              </li>
            ))}
            {derived.contents.map((ct) => (
              <li key={ct.id} className="capture">
                <p className="meta">
                  <span className="tag">원고</span>
                  <Link href={`/contents/${ct.id}`}>{ct.title}</Link>
                  <span>{LIFECYCLE_LABEL[ct.lifecycle] ?? ct.lifecycle}</span>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">이 소재에서 나온 카드·원고가 없습니다</p>
        )}
      </section>

      {c.inputType === 'url' ? (
        <section className="card archive" aria-labelledby="extract-title">
          <h3 id="extract-title">원문 추출</h3>
          {extractMsg ? (
            <p className="notice" role="alert">
              {extractMsg}
            </p>
          ) : null}
          <form className="form inline" method="post" action={`/api/captures/${c.id}/extract`}>
            <button type="submit">원문 추출 요청</button>
          </form>
          <p className="note">
            수집 기능은 M5 전까지 비활성입니다. 요청해도 외부 사이트에 접속하지 않고 차단 기록만 남깁니다.
          </p>
          {extractions.length ? (
            <ul className="list">
              {extractions.map((v) => (
                <li key={v.id} className="capture">
                  <p className="meta">
                    <span className="tag warn">{v.extractionState === 'blocked' ? '차단됨' : v.extractionState}</span>
                    <time dateTime={v.fetchedAt.toISOString()}>{formatMsk(v.fetchedAt)}</time>
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="card archive" aria-labelledby="dup-title">
        <h3 id="dup-title">중복 후보</h3>
        {dups.exact.length === 0 && dups.similar.length === 0 ? (
          <p className="empty-text">중복 후보가 없습니다</p>
        ) : (
          <ul className="list">
            {dups.exact.map((d) => (
              <li key={`e-${d.id}`} className="capture">
                <p className="meta">
                  <span className="tag warn">정확 중복</span>
                  <span>{REASON_TEXT[d.reason]}</span>
                  <Link href={`/captures/${d.id}`}>{preview(related.get(d.id)?.rawText ?? d.id, 60)}</Link>
                </p>
              </li>
            ))}
            {dups.similar.map((d) => (
              <li key={`s-${d.id}`} className="capture">
                <p className="meta">
                  <span className="tag">유사 ({Math.round(d.score * 100)}%)</span>
                  <Link href={`/captures/${d.id}`}>{preview(related.get(d.id)?.rawText ?? d.id, 60)}</Link>
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="note">중복 후보는 제안일 뿐입니다. 자동으로 합치거나 지우지 않습니다.</p>
      </section>

      <section className="card archive" aria-labelledby="edit-title">
        <h3 id="edit-title">메모·제목·위험 수정</h3>
        {editErr ? (
          <p className="notice" role="alert">
            {editErr}
          </p>
        ) : null}
        {yours ? (
          <>
            <p className="notice" role="alert">
              다른 곳에서 먼저 수정되었습니다. 현재 내용과 비교한 뒤 다시 저장하세요. 내가 입력한 내용은 아래 폼에 남아 있습니다.
            </p>
            <table className="compare">
              <thead>
                <tr>
                  <th />
                  <th>현재 서버 내용 (수정 {c.revision})</th>
                  <th>내가 입력한 내용{yours.revision ? ` (수정 ${yours.revision} 기준)` : ''}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">메모</th>
                  <td>{c.userNote ?? ''}</td>
                  <td>{yours.user_note}</td>
                </tr>
                <tr>
                  <th scope="row">제목</th>
                  <td>{c.title ?? ''}</td>
                  <td>{yours.title}</td>
                </tr>
                <tr>
                  <th scope="row">위험</th>
                  <td>{RISK_LABEL[c.risk] ?? c.risk}</td>
                  <td>{RISK_LABEL[yours.risk] ?? yours.risk}</td>
                </tr>
              </tbody>
            </table>
          </>
        ) : null}
        <form className="form" method="post" action={`/api/captures/${c.id}`}>
          <input type="hidden" name="_method" value="PATCH" />
          <input type="hidden" name="expected_revision" value={c.revision} />
          <label htmlFor="user_note">메모</label>
          <textarea id="user_note" name="user_note" rows={3} maxLength={MAX_USER_NOTE} defaultValue={form.user_note} />
          <label htmlFor="title">제목</label>
          <input id="title" name="title" type="text" maxLength={MAX_TITLE} defaultValue={form.title} />
          <label htmlFor="risk">위험</label>
          <select id="risk" name="risk" defaultValue={form.risk}>
            <option value="none">위험 표시 없음</option>
            <option value="needs_check">확인 필요</option>
          </select>
          <button type="submit">{yours ? `내 입력으로 다시 저장(현재 수정 ${c.revision} 기준)` : '저장'}</button>
        </form>
      </section>

      <section className="card archive" aria-labelledby="history-title">
        <h3 id="history-title">수정 이력</h3>
        {revisions.length ? (
          <ul className="list">
            {revisions.map((r) => (
              <li key={r.id} className="capture">
                <p className="meta">
                  <span className="tag">수정 {r.revision}</span>
                  <time dateTime={r.changedAt.toISOString()}>{formatMsk(r.changedAt)}</time>
                  <span>{r.changedBy === 'system' ? '이전 값 보존' : '사용자'}</span>
                  <span className={r.risk === 'needs_check' ? 'tag warn' : 'tag'}>{RISK_LABEL[r.risk] ?? r.risk}</span>
                </p>
                {r.title ? <p className="note">제목: {r.title}</p> : null}
                <p className="note">메모: {r.userNote ?? '(없음)'}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">아직 수정 이력이 없습니다</p>
        )}
      </section>
    </main>
  );
}
