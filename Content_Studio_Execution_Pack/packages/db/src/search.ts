/**
 * 통합 검색(T04, 결정 D5). owner 범위(A01)로만 찾는다.
 *
 * 일치 규칙: 검색어를 공백으로 나눈 각 조각이 (종류별 대상 필드 중 하나에) 모두 부분 문자열로 들어 있어야 한다(ILIKE, 대소문자 무시).
 * 한국어는 형태소 분석 없이 부분 문자열로 찾는다 — "주재원" 은 "주재원으로" 에도 걸린다. 영문 FTS 에 의존하지 않는다.
 * pg_trgm: GIN(gin_trgm_ops) 색인이 ILIKE '%…%' 를 가속하고, word_similarity 는 점수(score)로만 돌려준다.
 * 퍼지(%) 일치는 결과에 넣지 않는다(오타 허용보다 "없는 결과가 섞이지 않음"을 우선).
 *
 * 정렬·페이지: 종류별로 (시각 desc, id desc) keyset. type=all 은 종류별 첫 limit 건(커서 없음, more 로 다음 여부),
 * type=captures|contents|ideas 는 그 종류만 next_cursor 로 이어 본다.
 * 필터가 그 종류에 없는 속성이면(예: 소재에 lifecycle) 그 종류는 빈 결과다.
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { likePattern, makeSnippet, searchTerms, textIncludesAny, type SearchQuery } from '@cs/domain';
import type { DbOrTx } from './queries';
import { keysetBefore, microsText, type TimeCursor } from './ideas';
import { tagMatch } from './contents';
import { captures, contents, contentVersions, ideas } from './schema';

export type SearchKind = 'capture' | 'content' | 'idea';

export interface SearchItem {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string;
  matched_field: string | null;
  received_at?: string;
  updated_at?: string;
  score: number | null;
}

export interface SearchKindResult {
  items: SearchItem[];
  next: TimeCursor | null;
}

export interface SearchResult {
  captures: SearchKindResult;
  contents: SearchKindResult;
  ideas: SearchKindResult;
}

/** MSK(UTC+3, 서머타임 없음) 날짜 → UTC 시각 경계. to 는 다음 날 0시(미포함). */
export function mskDayRange(from?: string, to?: string): { from?: string; to?: string } {
  const out: { from?: string; to?: string } = {};
  if (from) out.from = new Date(`${from}T00:00:00+03:00`).toISOString();
  if (to) out.to = new Date(Date.parse(`${to}T00:00:00+03:00`) + 86_400_000).toISOString();
  return out;
}

/** 조각마다 (필드1 ILIKE p OR 필드2 ILIKE p …), 조각끼리 AND. */
function termsCondition(terms: readonly string[], fields: readonly SQL[]): SQL | undefined {
  if (terms.length === 0) return undefined;
  const perTerm = terms.map((t) => {
    const p = likePattern(t);
    return sql`(${sql.join(
      fields.map((f) => sql`${f} ilike ${p}`),
      sql` or `,
    )})`;
  });
  return and(...perTerm);
}

function scoreExpr(q: string | undefined, fields: readonly SQL[]): SQL<number | null> {
  if (!q) return sql<null>`null::real`;
  return sql<number>`greatest(${sql.join(
    fields.map((f) => sql`word_similarity(${q}, coalesce(${f}, ''))`),
    sql`, `,
  )})`;
}

const EMPTY: SearchKindResult = { items: [], next: null };

function dateRange(col: PgColumn, range: { from?: string; to?: string }): SQL[] {
  const out: SQL[] = [];
  if (range.from) out.push(sql`${col} >= ${range.from}::timestamptz`);
  if (range.to) out.push(sql`${col} < ${range.to}::timestamptz`);
  return out;
}

function pickMatch(terms: readonly string[], fields: ReadonlyArray<[string, string | null]>) {
  if (terms.length) {
    for (const [name, text] of fields) {
      if (textIncludesAny(text, terms)) return { name, text: text! };
    }
  }
  const first = fields.find(([, t]) => t);
  return { name: null, text: first?.[1] ?? '' };
}

const round = (n: number | null) => (n === null ? null : Math.round(Number(n) * 1000) / 1000);

async function searchCaptures(
  db: DbOrTx,
  ownerId: string,
  q: SearchQuery,
  terms: string[],
  cursor: TimeCursor | null,
  limit: number,
): Promise<SearchKindResult> {
  if (q.series || q.tag || q.lifecycle) return EMPTY;
  const fields = [sql`${captures.rawText}`, sql`${captures.userNote}`, sql`${captures.title}`];
  const range = mskDayRange(q.from, q.to);
  const rows = await db
    .select({
      id: captures.id,
      rawText: captures.rawText,
      userNote: captures.userNote,
      title: captures.title,
      receivedAt: captures.receivedAt,
      at: microsText(captures.receivedAt),
      score: scoreExpr(q.q, fields),
    })
    .from(captures)
    .where(
      and(
        eq(captures.ownerId, ownerId),
        termsCondition(terms, fields),
        q.risk ? eq(captures.risk, q.risk) : undefined,
        ...dateRange(captures.receivedAt, range),
        keysetBefore(captures.receivedAt, captures.id, cursor),
      ),
    )
    .orderBy(desc(captures.receivedAt), desc(captures.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => {
      const m = pickMatch(terms, [
        ['raw_text', r.rawText],
        ['user_note', r.userNote],
        ['title', r.title],
      ]);
      return {
        kind: 'capture' as const,
        id: r.id,
        title: r.title ?? makeSnippet(r.rawText, [], 30),
        snippet: makeSnippet(m.text, terms),
        matched_field: m.name,
        received_at: r.receivedAt.toISOString(),
        score: round(r.score),
      };
    }),
    next: rows.length > limit && last ? { at: last.at, id: last.id } : null,
  };
}

async function searchContents(
  db: DbOrTx,
  ownerId: string,
  q: SearchQuery,
  terms: string[],
  cursor: TimeCursor | null,
  limit: number,
): Promise<SearchKindResult> {
  if (q.risk) return EMPTY;
  const fields = [sql`${contents.title}`, sql`${contentVersions.body}`];
  const range = mskDayRange(q.from, q.to);
  const rows = await db
    .select({
      id: contents.id,
      title: contents.title,
      body: contentVersions.body,
      updatedAt: contents.updatedAt,
      at: microsText(contents.updatedAt),
      score: scoreExpr(q.q, fields),
    })
    .from(contents)
    .innerJoin(contentVersions, and(eq(contentVersions.id, contents.currentVersionId), eq(contentVersions.contentId, contents.id)))
    .where(
      and(
        eq(contents.ownerId, ownerId),
        termsCondition(terms, fields),
        q.series ? eq(contents.series, q.series) : undefined,
        q.tag ? tagMatch(contents.tags, q.tag) : undefined,
        q.lifecycle ? eq(contents.lifecycle, q.lifecycle) : undefined,
        ...dateRange(contents.updatedAt, range),
        keysetBefore(contents.updatedAt, contents.id, cursor),
      ),
    )
    .orderBy(desc(contents.updatedAt), desc(contents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => {
      const m = pickMatch(terms, [
        ['title', r.title],
        ['body', r.body],
      ]);
      return {
        kind: 'content' as const,
        id: r.id,
        title: r.title,
        snippet: makeSnippet(m.name === 'title' ? r.body || r.title : m.text, terms),
        matched_field: m.name,
        updated_at: r.updatedAt.toISOString(),
        score: round(r.score),
      };
    }),
    next: rows.length > limit && last ? { at: last.at, id: last.id } : null,
  };
}

async function searchIdeas(
  db: DbOrTx,
  ownerId: string,
  q: SearchQuery,
  terms: string[],
  cursor: TimeCursor | null,
  limit: number,
): Promise<SearchKindResult> {
  if (q.series || q.lifecycle) return EMPTY;
  const fields = [sql`${ideas.idea}`, sql`${ideas.evidence}`, sql`${ideas.nextDecision}`];
  const range = mskDayRange(q.from, q.to);
  const rows = await db
    .select({
      id: ideas.id,
      idea: ideas.idea,
      evidence: ideas.evidence,
      nextDecision: ideas.nextDecision,
      updatedAt: ideas.updatedAt,
      at: microsText(ideas.updatedAt),
      score: scoreExpr(q.q, fields),
    })
    .from(ideas)
    .where(
      and(
        eq(ideas.ownerId, ownerId),
        termsCondition(terms, fields),
        q.tag ? tagMatch(ideas.tags, q.tag) : undefined,
        q.risk ? eq(ideas.risk, q.risk) : undefined,
        ...dateRange(ideas.updatedAt, range),
        keysetBefore(ideas.updatedAt, ideas.id, cursor),
      ),
    )
    .orderBy(desc(ideas.updatedAt), desc(ideas.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => {
      const m = pickMatch(terms, [
        ['idea', r.idea],
        ['evidence', r.evidence],
        ['next_decision', r.nextDecision],
      ]);
      return {
        kind: 'idea' as const,
        id: r.id,
        title: makeSnippet(r.idea, [], 40),
        snippet: makeSnippet(m.text, terms),
        matched_field: m.name,
        updated_at: r.updatedAt.toISOString(),
        score: round(r.score),
      };
    }),
    next: rows.length > limit && last ? { at: last.at, id: last.id } : null,
  };
}

/**
 * 검색. type=all 이면 세 종류를 각 limit 건씩(cursor 무시), 아니면 그 종류만 cursor 로.
 * 결과는 종류별로 나눠 돌려준다(API 가 합쳐서 items 로 내보냄).
 */
export async function search(
  db: DbOrTx,
  ownerId: string,
  query: SearchQuery,
  cursor: TimeCursor | null = null,
): Promise<SearchResult> {
  const terms = searchTerms(query.q);
  const q = { ...query, q: terms.length ? terms.join(' ') : undefined };
  const limit = query.limit;
  const want = (t: SearchQuery['type']) => query.type === 'all' || query.type === t;
  const c = query.type === 'all' ? null : cursor;
  return {
    captures: want('captures') ? await searchCaptures(db, ownerId, q, terms, c, limit) : EMPTY,
    contents: want('contents') ? await searchContents(db, ownerId, q, terms, c, limit) : EMPTY,
    ideas: want('ideas') ? await searchIdeas(db, ownerId, q, terms, c, limit) : EMPTY,
  };
}
