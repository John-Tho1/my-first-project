import { recordAudit, revokeSession } from '@cs/db';
import { assertSameOrigin, buildClearedSessionCookie, UnauthorizedError } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/auth/logout — 현재 세션을 폐기(revoked_at)하고 쿠키를 지운다.
 * 이미 폐기·만료된 쿠키로 다시 호출하면 401. GET 은 정의하지 않는다(Next 가 405, 상태 변경 없음).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const now = new Date();
    const revoked = await revokeSession(owner.db, owner.ownerId, owner.sessionId, now);
    if (!revoked) throw new UnauthorizedError(); // 동시 로그아웃 경합
    await recordAudit(owner.db, {
      ownerId: owner.ownerId,
      action: 'auth.logout',
      entity: 'session',
      entityId: owner.sessionId,
      at: now,
    });
    const headers = { 'set-cookie': buildClearedSessionCookie(config) };
    if (html) return seeOther('/login', headers);
    return json({ ok: true }, { headers });
  } catch (e) {
    if (html) {
      // 폼 제출: 어떤 경우든 로그인 화면으로. 세션이 없으면 쿠키도 지운다.
      const res = errorResponse(e, request);
      const headers = new Headers();
      const cookie = res.headers.get('set-cookie');
      if (cookie) headers.set('set-cookie', cookie);
      return seeOther(res.status === 401 ? '/login' : '/?error=logout', headers);
    }
    return errorResponse(e, request);
  }
}
