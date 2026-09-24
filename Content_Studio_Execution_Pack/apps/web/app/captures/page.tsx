import Link from 'next/link';
import { redirect } from 'next/navigation';
import { exactDuplicateIds, listCapturesPage } from '@cs/db';
import { decodeCaptureCursor, encodeCaptureCursor, formatMsk } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { INPUT_TYPE_LABEL, preview, RISK_LABEL } from '../../lib/labels';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

/** 소재함: 로그인한 owner 의 capture 를 최근 순으로(cursor pagination). */
export default async function CapturesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const params = await searchParams;
  const rawCursor = typeof params.cursor === 'string' ? params.cursor : null;
  const cursor = rawCursor ? decodeCaptureCursor(rawCursor) : null;
  const { db } = await getAppDb(getConfig());
  const page = await listCapturesPage(db, session.ownerId, { cursor, limit: PAGE_SIZE });
  const dupIds = await exactDuplicateIds(
    db,
    session.ownerId,
    page.items.map((i) => i.capture.id),
  );
  const next = page.next ? encodeCaptureCursor(page.next.receivedAt, page.next.id) : null;

  return (
    <main className="container">
      <header className="header">
        <h1>Content Studio</h1>
        <p className="now">
          <Link href="/">← 오늘</Link>
        </p>
      </header>
      <h2 className="screen-title">소재함</h2>
      {params.missing === '1' ? (
        <p className="notice" role="alert">
          소재를 찾을 수 없습니다.
        </p>
      ) : null}
      {rawCursor && !cursor ? (
        <p className="notice" role="alert">
          목록 위치 정보가 올바르지 않아 처음부터 보여 줍니다.
        </p>
      ) : null}
      <section className="card archive">
        {page.items.length ? (
          <ul className="list">
            {page.items.map(({ capture: c, sourceUrl }) => (
              <li key={c.id} className="capture">
                <p className="capture-text">
                  <Link href={`/captures/${c.id}`}>{c.title ? `${c.title} — ` : ''}{preview(c.rawText)}</Link>
                </p>
                <p className="meta">
                  <time dateTime={c.receivedAt.toISOString()}>{formatMsk(c.receivedAt)}</time>
                  <span className="tag">{INPUT_TYPE_LABEL[c.inputType] ?? c.inputType}</span>
                  <span className={c.risk === 'needs_check' ? 'tag warn' : 'tag'}>{RISK_LABEL[c.risk] ?? c.risk}</span>
                  {dupIds.has(c.id) ? <span className="tag warn">정확 중복 있음</span> : null}
                  {sourceUrl ? <span>출처: {sourceUrl}</span> : null}
                </p>
                {c.userNote ? <p className="note">메모: {c.userNote}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">저장된 소재가 없습니다. 오늘 화면의 빠른 수집으로 저장하세요.</p>
        )}
        <p className="pager">
          {next ? <Link href={`/captures?cursor=${next}`}>더 보기</Link> : <span className="muted-text">마지막입니다</span>}
          {rawCursor ? (
            <>
              {' · '}
              <Link href="/captures">처음으로</Link>
            </>
          ) : null}
        </p>
      </section>
    </main>
  );
}
