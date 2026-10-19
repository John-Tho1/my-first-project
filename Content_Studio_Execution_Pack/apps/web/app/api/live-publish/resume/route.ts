import { setLivePublishPaused } from '@cs/db';
import { assertSameOrigin, LIVE_PUBLISH_RESUME_CONFIRM_TEXT, LivePublishResumeConfirmError } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { readRequestFields } from '../../../../lib/body';
import { LIVE_PUBLISH_SECTION, livePublishFormFailure } from '../../../../lib/live-publish';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/live-publish/resume — { confirm_text: '재개' } (폼은 confirm_text 입력 칸). 실제 게시 재개(LIVE-P2, D39).
 * 같은 출처·로그인 필요. 확인 문구가 정확히 '재개' 가 아니면 400 live_resume_confirm_required(아무것도 바꾸지 않음).
 * 재개는 보류된 작업을 자동으로 다시 보내지 않는다 — 사용자가 항목마다 '재시도'를 눌러야 한다. 외부 호출 없음. 감사 live_publish_resumed.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, 1024);
    const raw = body.data && typeof body.data === 'object' ? (body.data as { confirm_text?: unknown }).confirm_text : undefined;
    if (typeof raw !== 'string' || raw.trim() !== LIVE_PUBLISH_RESUME_CONFIRM_TEXT) throw new LivePublishResumeConfirmError();
    const r = await setLivePublishPaused(owner.db, owner.ownerId, false);
    if (html) return seeOther(`/settings?live_publish=resumed${LIVE_PUBLISH_SECTION}`);
    return json({ paused: r.paused, changed: r.changed, changed_at: r.changedAt.toISOString() });
  } catch (e) {
    if (html) return livePublishFormFailure(e);
    return errorResponse(e, request);
  }
}
