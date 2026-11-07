import { setLivePublishPaused } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { LIVE_PUBLISH_SECTION, livePublishFormFailure } from '../../../../lib/live-publish';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/live-publish/pause — 실제 게시 즉시 중지(LIVE-P2, D39). 확인 없이 바로(멈추는 쪽은 안전 방향). 본문 없음.
 * 같은 출처·로그인 필요(다른 변경 route 와 같은 검사 순서: 같은 출처 → 세션). 서버 재시작 없이 다음 전송부터 막힌다(전송 직전 같은 트랜잭션에서 확인).
 * 외부 호출 없음. 감사 live_publish_paused(누가·언제만). 폼은 303 으로 설정 화면, JSON 은 { paused, changed }.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const r = await setLivePublishPaused(owner.db, owner.ownerId, true);
    if (html) return seeOther(`/settings?live_publish=paused${LIVE_PUBLISH_SECTION}`);
    return json({ paused: r.paused, changed: r.changed, changed_at: r.changedAt.toISOString() });
  } catch (e) {
    if (html) return livePublishFormFailure(e);
    return errorResponse(e, request);
  }
}
