import { channelAccountView, createLiveThreadsAccount, listChannelAccounts } from '@cs/db';
import { assertSameOrigin, BadRequestError } from '@cs/domain';
import { apiHandler, errorResponse, json, readBodyCapped, seeOther, wantsHtml } from '../../../lib/api';
import { accountFormFailure } from '../../../lib/oauth';
import { getConfig } from '../../../lib/server';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** GET /api/channel-accounts — 배포 계정(M3 은 모의 계정만, 인증 비밀 없음). */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const rows = await listChannelAccounts(owner.db, owner.ownerId);
  return json({ items: rows.map(channelAccountView) });
});

/**
 * POST /api/channel-accounts — LIVE-T1(D31 2단계 준비): 실제 Threads 계정 행(연결 전)을 만든다. body: platform=threads, kind=live(JSON 또는 폼).
 * 같은 출처·로그인 필요, owner 범위. 외부 호출 없음·연결 정보 없음. 이미 연결 전 실제 Threads 행이 있으면 그 행(200, created=false).
 * 이 행은 state=disconnected 라 배포 계획에 고를 수 없다(실제 게시는 D31 범위 밖). 연결은 설정 화면의 "실제 연결" — 준비 상태가 모두 갖춰졌을 때만.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const raw = new TextDecoder().decode(await readBodyCapped(request, 2048));
    let fields: Record<string, unknown> = {};
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        const v: unknown = raw ? JSON.parse(raw) : {};
        if (v && typeof v === 'object' && !Array.isArray(v)) fields = v as Record<string, unknown>;
      } catch {
        throw new BadRequestError();
      }
    } else {
      fields = Object.fromEntries(new URLSearchParams(raw).entries());
    }
    if (fields.platform !== 'threads' || fields.kind !== 'live') throw new BadRequestError('실제 계정은 Threads 만 만들 수 있습니다(platform=threads, kind=live).');
    const r = await createLiveThreadsAccount(owner.db, owner.ownerId);
    if (html) return seeOther('/settings?live_account=1#accounts');
    return json({ account: channelAccountView(r.account), created: r.created }, { status: r.created ? 201 : 200 });
  } catch (e) {
    if (html) return accountFormFailure(e);
    return errorResponse(e, request);
  }
}
