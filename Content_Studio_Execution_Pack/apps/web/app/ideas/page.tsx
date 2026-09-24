import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listIdeas } from '@cs/db';
import { decodeCaptureCursor, encodeCaptureCursor, formatMsk, MAX_IDEA } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { FORM_ERROR_TEXT } from '../../lib/contents';
import { preview, RISK_LABEL } from '../../lib/labels';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

/** 콘텐츠 카드 목록(최근 수정 순, cursor) + 새 카드 폼. */
export default async function IdeasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const params = await searchParams;
  const rawCursor = typeof params.cursor === 'string' ? params.cursor : null;
  const c = rawCursor ? decodeCaptureCursor(rawCursor) : null;
  const { db } = await getAppDb(getConfig());
  const page = await listIdeas(db, session.ownerId, { cursor: c ? { at: c.receivedAt, id: c.id } : null, limit: 20 });
  const next = page.next ? encodeCaptureCursor(page.next.at, page.next.id) : null;
  const err = typeof params.error === 'string' ? (FORM_ERROR_TEXT[params.error] ?? FORM_ERROR_TEXT.server) : undefined;

  return (
    <main className="container">
      <h2 className="screen-title">콘텐츠 카드</h2>
      {params.missing === '1' ? (
        <p className="notice" role="alert">
          카드를 찾을 수 없습니다.
        </p>
      ) : null}
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}

      <section className="card archive" aria-labelledby="new-idea">
        <h3 id="new-idea">새 카드</h3>
        <form className="form" method="post" action="/api/ideas">
          <label htmlFor="idea">핵심 아이디어(Idea)</label>
          <textarea id="idea" name="idea" rows={2} maxLength={MAX_IDEA} required />
          <label htmlFor="audience">독자(Audience)</label>
          <input id="audience" name="audience" type="text" maxLength={500} />
          <label htmlFor="tags">태그(쉼표로 구분, 최대 10개)</label>
          <input id="tags" name="tags" type="text" />
          <button type="submit">카드 저장</button>
        </form>
        <p className="note">근거·위험·다음 결정은 저장 후 카드 화면에서 채웁니다. 소재함의 소재에서 바로 카드로 발전시킬 수도 있습니다.</p>
      </section>

      <section className="card archive">
        {page.items.length ? (
          <ul className="list">
            {page.items.map((i) => (
              <li key={i.id} className="capture">
                <p className="capture-text">
                  <Link href={`/ideas/${i.id}`}>{preview(i.idea, 100)}</Link>
                </p>
                <p className="meta">
                  <time dateTime={i.updatedAt.toISOString()}>{formatMsk(i.updatedAt)}</time>
                  <span className={i.risk === 'needs_check' ? 'tag warn' : 'tag'}>{RISK_LABEL[i.risk] ?? i.risk}</span>
                  {i.tags.map((t) => (
                    <span key={t} className="tag">
                      #{t}
                    </span>
                  ))}
                  {i.audience ? <span>독자: {preview(i.audience, 40)}</span> : null}
                </p>
                {i.nextDecision ? <p className="note">다음 결정: {preview(i.nextDecision, 80)}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">아직 카드가 없습니다.</p>
        )}
        <p className="pager">
          {next ? <Link href={`/ideas?cursor=${next}`}>더 보기</Link> : <span className="muted-text">마지막입니다</span>}
          {rawCursor ? (
            <>
              {' · '}
              <Link href="/ideas">처음으로</Link>
            </>
          ) : null}
        </p>
      </section>
    </main>
  );
}
