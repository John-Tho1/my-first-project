import { setLivePublishTarget } from '@cs/db';
import { assertSameOrigin, BadRequestError } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields } from '../../../../../lib/body';
import { accountFormFailure } from '../../../../../lib/oauth';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/channel-accounts/{id}/publish-target — { enabled: true|false } (폼은 enabled=true|false).
 * LIVE-P1(D38 1단계): 실제 Threads 계정을 "실제 게시 계정으로 사용"(connected — 배포 계획에 고를 수 있음) / "사용 중지"(disconnected — 그 계정의 활성 승인 철회).
 * 사용은 묶인 계정 + 지금 쓸 수 있는 연결 정보일 때만(409 live_target_*). 외부 호출 없음. 실제 게시 자체는 승인·실행·실제 게시 환경 조건이 따로 막는다.
 * 같은 출처·로그인 필요, 다른 owner 의 계정은 404. 응답·감사에 토큰 없음(폼은 303 으로 설정 화면).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, 4096);
    const raw = body.data && typeof body.data === 'object' ? (body.data as { enabled?: unknown }).enabled : undefined;
    if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false') throw new BadRequestError('enabled 는 true 또는 false 입니다');
    const enabled = raw === true || raw === 'true';
    const r = await setLivePublishTarget(owner.db, owner.ownerId, id.toLowerCase(), enabled);
    if (html) return seeOther(`/settings?live_target=${enabled ? 'on' : 'off'}#accounts`);
    return json({ account_id: r.account.id, state: r.account.state, live_publish_target: r.account.state === 'connected', revoked_approvals: r.revoked.length });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
