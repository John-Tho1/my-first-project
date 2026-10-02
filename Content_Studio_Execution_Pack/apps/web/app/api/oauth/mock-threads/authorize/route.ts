import { errorResponse, json, seeOther } from '../../../../../lib/api';
import { mockThreadsProvider } from '../../../../../lib/oauth';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/oauth/mock-threads/authorize — **모의 공급자**의 동의 화면 흉내(T13). 실제 Threads 가 아니다(앱 안, 네트워크 없음).
 * 등록 redirect URI 정확 일치·PKCE S256·허용 scope 를 검사하고 1회용 code(60초)를 발급해 redirect_uri?code&state 로 303.
 * 로그인한 owner 만(모의라도 앱 밖 사용자가 code 를 받지 못하게). 검증 실패는 400 { error } (redirect 하지 않음 — OAuth 규약).
 * 시험용 query: mock_user(다른 계정으로 로그인한 것처럼), mock_grant(일부 scope 만 허락), mock_deny=1(거부).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const config = getConfig();
    await requireOwner(request);
    const q = new URL(request.url).searchParams;
    const r = mockThreadsProvider(config).authorize(
      {
        client_id: q.get('client_id'),
        redirect_uri: q.get('redirect_uri'),
        response_type: q.get('response_type'),
        scope: q.get('scope'),
        state: q.get('state'),
        code_challenge: q.get('code_challenge'),
        code_challenge_method: q.get('code_challenge_method'),
        login_hint: q.get('login_hint'),
        mock_user: q.get('mock_user'),
        mock_grant: q.get('mock_grant'),
        mock_deny: q.get('mock_deny'),
      },
      new Date(),
    );
    if (!r.ok) return json({ error: r.error, message: '모의 공급자가 연결 요청을 거부했습니다', mock: true }, { status: 400 });
    return seeOther(r.redirect, { 'referrer-policy': 'no-referrer' });
  } catch (e) {
    return errorResponse(e, request);
  }
}
