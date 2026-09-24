import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getIdea } from '@cs/db';
import { formatMsk, formatMskInline, MAX_IDEA } from '@cs/domain';
import { getSession } from '../../../lib/auth';
import { FORM_ERROR_TEXT, LIFECYCLE_LABEL } from '../../../lib/contents';
import { preview, RISK_LABEL } from '../../../lib/labels';
import { getAppDb, getConfig } from '../../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/** 콘텐츠 카드: Idea / Audience / Evidence / Risk / Next Decision, 연결 소재(원문), 원고 시작, 수정. */
export default async function IdeaPage({
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
  const d = await getIdea(db, session.ownerId, id.toLowerCase());
  if (!d) notFound();
  const { idea: i } = d;
  const err = str(q.error) ? (FORM_ERROR_TEXT[str(q.error)!] ?? FORM_ERROR_TEXT.server) : undefined;
  const updated = str(q.updated) === String(i.revision);

  const fields: Array<[string, string, string | null]> = [
    ['Idea', '핵심 아이디어', i.idea],
    ['Audience', '독자', i.audience],
    ['Evidence', '근거', i.evidence],
    ['Risk', '위험', RISK_LABEL[i.risk] ?? i.risk],
    ['Next Decision', '다음 결정', i.nextDecision],
  ];

  return (
    <main className="container">
      <p className="now">
        <Link href="/ideas">← 카드 목록</Link>
      </p>
      <h2 className="screen-title">콘텐츠 카드</h2>
      {str(q.saved) === '1' ? (
        <p className="saved" role="status">
          {`서버에 저장됨 ✓ (${formatMskInline(i.createdAt)})`}
        </p>
      ) : null}
      {updated ? (
        <p className="saved" role="status">
          {`서버에 저장됨 ✓ (수정 ${i.revision}, ${formatMskInline(i.updatedAt)})`}
        </p>
      ) : null}
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}

      <section className="card archive" aria-labelledby="card-title">
        <h3 id="card-title">카드</h3>
        <dl className="idea-card">
          {fields.map(([en, ko, v]) => (
            <div key={en}>
              <dt>
                {en}
                <small>{ko}</small>
              </dt>
              <dd className={v ? undefined : 'empty-text'}>{v || '(비어 있음)'}</dd>
            </div>
          ))}
        </dl>
        <p className="meta">
          {i.tags.map((t) => (
            <span key={t} className="tag">
              #{t}
            </span>
          ))}
          <span>수정 {i.revision}</span>
          <span>최근 수정: {formatMsk(i.updatedAt)}</span>
        </p>
        {i.nextQuestion ? <p className="note">다음 질문: {i.nextQuestion}</p> : null}
        <form className="form inline" method="post" action={`/api/ideas/${i.id}/contents`}>
          <button type="submit">원고 시작</button>
        </form>
        <p className="note">카드 내용과 연결된 소재를 원문으로 묶은 초안(버전 1)을 만듭니다.</p>
      </section>

      <section className="card archive" aria-labelledby="origin-title">
        <h3 id="origin-title">원문(수집)</h3>
        {d.captures.length ? (
          <ul className="list">
            {d.captures.map((c) => (
              <li key={c.id} className="capture">
                <p className="capture-text">
                  <Link href={`/captures/${c.id}`}>{c.title ? `${c.title} — ` : ''}{preview(c.rawText)}</Link>
                </p>
                <p className="meta">
                  <time dateTime={c.receivedAt.toISOString()}>{formatMsk(c.receivedAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">연결된 소재가 없습니다.</p>
        )}
      </section>

      {d.contents.length ? (
        <section className="card archive" aria-labelledby="derived-title">
          <h3 id="derived-title">이 카드에서 시작한 원고</h3>
          <ul className="list">
            {d.contents.map((c) => (
              <li key={c.id} className="capture">
                <p className="meta">
                  <Link href={`/contents/${c.id}`}>{c.title}</Link>
                  <span className="tag">{LIFECYCLE_LABEL[c.lifecycle] ?? c.lifecycle}</span>
                  <time dateTime={c.updatedAt.toISOString()}>{formatMsk(c.updatedAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="card archive" aria-labelledby="edit-title">
        <h3 id="edit-title">카드 수정</h3>
        <form className="form" method="post" action={`/api/ideas/${i.id}`}>
          <input type="hidden" name="_method" value="PATCH" />
          <input type="hidden" name="expected_revision" value={i.revision} />
          <label htmlFor="idea">Idea · 핵심 아이디어</label>
          <textarea id="idea" name="idea" rows={2} maxLength={MAX_IDEA} required defaultValue={i.idea} />
          <label htmlFor="audience">Audience · 독자</label>
          <input id="audience" name="audience" type="text" maxLength={500} defaultValue={i.audience ?? ''} />
          <label htmlFor="evidence">Evidence · 근거</label>
          <textarea id="evidence" name="evidence" rows={3} maxLength={2000} defaultValue={i.evidence ?? ''} />
          <label htmlFor="risk">Risk · 위험</label>
          <select id="risk" name="risk" defaultValue={i.risk}>
            <option value="none">위험 표시 없음</option>
            <option value="needs_check">확인 필요</option>
          </select>
          <label htmlFor="next_decision">Next Decision · 다음 결정</label>
          <textarea id="next_decision" name="next_decision" rows={2} maxLength={2000} defaultValue={i.nextDecision ?? ''} />
          <label htmlFor="next_question">다음 질문(선택)</label>
          <textarea id="next_question" name="next_question" rows={2} maxLength={2000} defaultValue={i.nextQuestion ?? ''} />
          <label htmlFor="tags">태그(쉼표로 구분)</label>
          <input id="tags" name="tags" type="text" defaultValue={i.tags.join(', ')} />
          <button type="submit">저장</button>
        </form>
        <p className="note">다른 곳에서 먼저 수정했다면 저장하지 않고 비교 화면을 보여 줍니다(입력은 그대로 남습니다).</p>
      </section>
    </main>
  );
}
