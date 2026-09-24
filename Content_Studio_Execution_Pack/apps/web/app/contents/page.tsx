import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listContents, listSeries } from '@cs/db';
import {
  CONTENT_LIFECYCLES,
  contentLifecycleSchema,
  decodeCaptureCursor,
  encodeCaptureCursor,
  formatMsk,
  MAX_CONTENT_BODY,
  MAX_CONTENT_TITLE,
} from '@cs/domain';
import { getSession } from '../../lib/auth';
import { FORM_ERROR_TEXT, LIFECYCLE_LABEL } from '../../lib/contents';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** 아카이브: 원고 목록(최근 수정 순) + 연재·태그·상태 필터 + 새 원고. */
export default async function ContentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const params = await searchParams;
  const series = str(params.series)?.slice(0, 100);
  const tag = str(params.tag)?.slice(0, 30);
  const lc = contentLifecycleSchema.safeParse(str(params.lifecycle));
  const lifecycle = lc.success ? lc.data : undefined;
  const rawCursor = str(params.cursor) ?? null;
  const c = rawCursor ? decodeCaptureCursor(rawCursor) : null;
  const { db } = await getAppDb(getConfig());
  const [page, allSeries] = await Promise.all([
    listContents(db, session.ownerId, { series, tag, lifecycle, cursor: c ? { at: c.receivedAt, id: c.id } : null, limit: 20 }),
    listSeries(db, session.ownerId),
  ]);
  const filterQuery = new URLSearchParams();
  if (series) filterQuery.set('series', series);
  if (tag) filterQuery.set('tag', tag);
  if (lifecycle) filterQuery.set('lifecycle', lifecycle);
  const next = page.next ? encodeCaptureCursor(page.next.at, page.next.id) : null;
  const nextHref = next ? `/contents?${new URLSearchParams({ ...Object.fromEntries(filterQuery), cursor: next })}` : null;
  const err = str(params.error) ? (FORM_ERROR_TEXT[str(params.error)!] ?? FORM_ERROR_TEXT.server) : undefined;

  return (
    <main className="container">
      <h2 className="screen-title">아카이브</h2>
      {params.missing === '1' ? (
        <p className="notice" role="alert">
          원고를 찾을 수 없습니다.
        </p>
      ) : null}
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}

      <section className="card archive" aria-labelledby="filter-title">
        <h3 id="filter-title">필터</h3>
        <form className="form filters" method="get" action="/contents">
          <label>
            연재
            <select name="series" defaultValue={series ?? ''}>
              <option value="">전체</option>
              {allSeries.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            태그
            <input name="tag" type="text" maxLength={30} defaultValue={tag ?? ''} />
          </label>
          <label>
            상태
            <select name="lifecycle" defaultValue={lifecycle ?? ''}>
              <option value="">전체</option>
              {CONTENT_LIFECYCLES.map((l) => (
                <option key={l} value={l}>
                  {LIFECYCLE_LABEL[l]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">보기</button>
        </form>
        {series || tag || lifecycle ? (
          <p className="pager">
            <Link href="/contents">필터 지우기</Link>
          </p>
        ) : null}
      </section>

      <section className="card archive">
        {page.items.length ? (
          <ul className="list">
            {page.items.map((ct) => (
              <li key={ct.id} className="capture">
                <p className="capture-text">
                  <Link href={`/contents/${ct.id}`}>{ct.title}</Link>
                </p>
                <p className="meta">
                  <span className="tag">{LIFECYCLE_LABEL[ct.lifecycle] ?? ct.lifecycle}</span>
                  {ct.series ? <span>연재: {ct.series}</span> : null}
                  {ct.tags.map((t) => (
                    <span key={t} className="tag">
                      #{t}
                    </span>
                  ))}
                  <time dateTime={ct.updatedAt.toISOString()}>최근 수정 {formatMsk(ct.updatedAt)}</time>
                </p>
                {ct.audience ? <p className="note">독자: {ct.audience}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">원고가 없습니다. 소재나 카드에서 “원고 시작”을 누르거나 아래에서 새로 만드세요.</p>
        )}
        <p className="pager">
          {nextHref ? <Link href={nextHref}>더 보기</Link> : <span className="muted-text">마지막입니다</span>}
        </p>
      </section>

      <section className="card archive" aria-labelledby="new-content">
        <h3 id="new-content">새 원고</h3>
        <form className="form" method="post" action="/api/contents">
          <label htmlFor="title">제목</label>
          <input id="title" name="title" type="text" maxLength={MAX_CONTENT_TITLE} required />
          <label htmlFor="series">연재(선택)</label>
          <input id="series" name="series" type="text" maxLength={100} list="series-list" />
          <datalist id="series-list">
            {allSeries.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <label htmlFor="body">본문</label>
          <textarea id="body" name="body" rows={6} maxLength={MAX_CONTENT_BODY} />
          <button type="submit">원고 저장(버전 1)</button>
        </form>
      </section>
    </main>
  );
}
