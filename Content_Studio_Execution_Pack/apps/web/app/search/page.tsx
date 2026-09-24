import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listSeries, search, type SearchItem, type SearchKindResult } from '@cs/db';
import {
  CONTENT_LIFECYCLES,
  decodeCaptureCursor,
  encodeCaptureCursor,
  formatMsk,
  MAX_SEARCH_Q,
  parseSearchParams,
  searchTerms,
} from '@cs/domain';
import { getSession } from '../../lib/auth';
import { LIFECYCLE_LABEL } from '../../lib/contents';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const FIELD_LABEL: Record<string, string> = {
  raw_text: '원문',
  user_note: '메모',
  title: '제목',
  body: '본문',
  idea: '아이디어',
  evidence: '근거',
  next_decision: '다음 결정',
};

/** 검색어 조각을 <mark> 로 강조(대소문자 무시). 텍스트는 React 가 escape 한다. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}
    </>
  );
}

const HREF: Record<SearchItem['kind'], string> = { capture: '/captures/', content: '/contents/', idea: '/ideas/' };

function Group({
  title,
  kind,
  result,
  terms,
  moreHref,
}: {
  title: string;
  kind: 'captures' | 'contents' | 'ideas';
  result: SearchKindResult;
  terms: string[];
  moreHref: string | null;
}) {
  return (
    <section className="card archive result-group" aria-labelledby={`g-${kind}`}>
      <h3 id={`g-${kind}`}>
        {title} <small>{result.items.length}건{result.next ? '+' : ''}</small>
      </h3>
      {result.items.length ? (
        <ul className="list">
          {result.items.map((i) => {
            const at = i.received_at ?? i.updated_at;
            return (
              <li key={i.id} className="capture">
                <p className="capture-text">
                  <Link href={`${HREF[i.kind]}${i.id}`}>{i.title}</Link>
                </p>
                <p className="note">
                  <Highlight text={i.snippet} terms={terms} />
                </p>
                <p className="meta">
                  {i.matched_field ? <span className="tag">{FIELD_LABEL[i.matched_field] ?? i.matched_field}에서 찾음</span> : null}
                  {at ? <time dateTime={at}>{formatMsk(at)}</time> : null}
                </p>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-text">결과가 없습니다</p>
      )}
      {moreHref ? (
        <p className="pager">
          <Link href={moreHref}>더 보기</Link>
        </p>
      ) : null}
    </section>
  );
}

/** 검색: 소재·원고·카드를 한국어 부분 문자열로(대소문자 무시). 필터·종류별 더 보기. */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const raw = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') usp.set(k, v);
  const parsed = parseSearchParams(usp);
  const { db } = await getAppDb(getConfig());
  const allSeries = await listSeries(db, session.ownerId);
  const query = parsed.success ? parsed.data : null;
  const cursor = query?.cursor ? decodeCaptureCursor(query.cursor) : null;
  const active = query && (query.q || query.series || query.tag || query.risk || query.lifecycle || query.from || query.to);
  const result = active ? await search(db, session.ownerId, query, cursor ? { at: cursor.receivedAt, id: cursor.id } : null) : null;
  const terms = searchTerms(query?.q);

  const base = new URLSearchParams(usp);
  base.delete('cursor');
  base.delete('type');
  const moreHref = (kind: 'captures' | 'contents' | 'ideas', r: SearchKindResult) => {
    if (!r.next || !query) return null;
    const p = new URLSearchParams(base);
    p.set('type', kind);
    // 전체 보기의 종류별 next 도 같은 (시각, id) keyset 이라 그 종류만 보는 화면의 cursor 로 그대로 이어진다.
    p.set('cursor', encodeCaptureCursor(r.next.at, r.next.id));
    return `/search?${p.toString()}`;
  };
  const v = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const show = (kind: 'captures' | 'contents' | 'ideas') => !query || query.type === 'all' || query.type === kind;

  return (
    <main className="container">
      <h2 className="screen-title">검색</h2>
      <section className="card archive" aria-labelledby="search-form">
        <h3 id="search-form">검색 조건</h3>
        <form className="form" method="get" action="/search" role="search">
          <label htmlFor="q">검색어(공백으로 나누면 모두 포함하는 항목)</label>
          <input id="q" name="q" type="search" maxLength={MAX_SEARCH_Q} defaultValue={v('q')} placeholder="예: 주재원, 재고 리스, AI" />
          <div className="filters">
            <label>
              종류
              <select name="type" defaultValue={v('type') || 'all'}>
                <option value="all">전체</option>
                <option value="captures">소재</option>
                <option value="contents">원고</option>
                <option value="ideas">카드</option>
              </select>
            </label>
            <label>
              연재(원고)
              <select name="series" defaultValue={v('series')}>
                <option value="">전체</option>
                {allSeries.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label>
              태그(원고·카드)
              <input name="tag" type="text" maxLength={30} defaultValue={v('tag')} />
            </label>
            <label>
              위험(소재·카드)
              <select name="risk" defaultValue={v('risk')}>
                <option value="">전체</option>
                <option value="needs_check">확인 필요</option>
                <option value="none">위험 표시 없음</option>
              </select>
            </label>
            <label>
              상태(원고)
              <select name="lifecycle" defaultValue={v('lifecycle')}>
                <option value="">전체</option>
                {CONTENT_LIFECYCLES.map((l) => (
                  <option key={l} value={l}>
                    {LIFECYCLE_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              시작일(MSK)
              <input name="from" type="date" defaultValue={v('from')} />
            </label>
            <label>
              종료일(MSK)
              <input name="to" type="date" defaultValue={v('to')} />
            </label>
          </div>
          <button type="submit">검색</button>
        </form>
        <p className="note">
          한국어는 글자 그대로 찾습니다(“주재원”은 “주재원으로”도 찾음). 연재·상태 필터는 원고에만, 위험 필터는 소재·카드에만 적용되어 다른 종류는 비어 보입니다.
        </p>
      </section>

      {!parsed.success ? (
        <p className="notice" role="alert">
          검색 조건이 올바르지 않습니다. 날짜 형식(YYYY-MM-DD)과 검색어 길이(200자 이하)를 확인하세요.
        </p>
      ) : null}

      {result ? (
        <>
          {show('captures') ? <Group title="소재" kind="captures" result={result.captures} terms={terms} moreHref={moreHref('captures', result.captures)} /> : null}
          {show('contents') ? <Group title="원고" kind="contents" result={result.contents} terms={terms} moreHref={moreHref('contents', result.contents)} /> : null}
          {show('ideas') ? <Group title="카드" kind="ideas" result={result.ideas} terms={terms} moreHref={moreHref('ideas', result.ideas)} /> : null}
        </>
      ) : parsed.success ? (
        <p className="empty-text">검색어나 필터를 입력하세요.</p>
      ) : null}
    </main>
  );
}
