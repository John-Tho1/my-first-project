import { search } from '@cs/db';
import { BadRequestError, decodeCaptureCursor, encodeCaptureCursor, parseSearchParams } from '@cs/domain';
import { apiHandler, json } from '../../../lib/api';
import { validationError } from '../../../lib/body';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/search?q=&type=all|captures|contents|ideas&series=&tag=&risk=&lifecycle=&from=&to=&cursor=&limit=
 * 한국어·영문 부분 문자열(대소문자 무시) 검색, owner 범위만(결정 D5).
 * type=all: 종류별 첫 limit 건(next_cursor 는 null, more·next_cursors 로 종류별 다음 여부와 cursor). type=<종류>: 그 종류만 next_cursor 로 이어 본다.
 */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const parsed = parseSearchParams(new URL(request.url).searchParams);
  if (!parsed.success) throw validationError(parsed.error);
  const q = parsed.data;
  const c = q.cursor ? decodeCaptureCursor(q.cursor) : null;
  if (q.cursor && !c) throw new BadRequestError('cursor 가 올바르지 않습니다');
  const r = await search(owner.db, owner.ownerId, q, c ? { at: c.receivedAt, id: c.id } : null);
  const items = [...r.captures.items, ...r.contents.items, ...r.ideas.items];
  const one = q.type === 'captures' ? r.captures : q.type === 'contents' ? r.contents : q.type === 'ideas' ? r.ideas : null;
  return json({
    items,
    next_cursor: one?.next ? encodeCaptureCursor(one.next.at, one.next.id) : null,
    // type=all: 종류별 다음 여부와 그 종류(type=<종류>)로 이어 볼 cursor.
    more: q.type === 'all'
      ? { captures: r.captures.next !== null, contents: r.contents.next !== null, ideas: r.ideas.next !== null }
      : undefined,
    next_cursors: q.type === 'all'
      ? {
          captures: r.captures.next ? encodeCaptureCursor(r.captures.next.at, r.captures.next.id) : null,
          contents: r.contents.next ? encodeCaptureCursor(r.contents.next.at, r.contents.next.id) : null,
          ideas: r.ideas.next ? encodeCaptureCursor(r.ideas.next.at, r.ideas.next.id) : null,
        }
      : undefined,
  });
});
