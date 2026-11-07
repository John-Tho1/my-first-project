import { json, seeOther } from '../../../../../lib/api';
import { MOCK_TEST_PARAMS, mockTestParamsAllowed, mockGoogleProvider, oauthEndpoint } from '../../../../../lib/oauth';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/oauth/mock-google/authorize — T15(D27) **Google(YouTube) 형 모의 공급자**의 동의 화면 흉내. 실제 Google 이 아니다(앱 안, 네트워크 없음).
 * scope 는 업로드용 자리 표시 이름(youtube.upload(mock))만 허용. 그 밖의 규칙은 T13 모의 Threads 동의 화면과 같다.
 * 등록 redirect URI 정확 일치·PKCE S256·허용 scope 를 검사하고 1회용 code(60초)를 발급해 redirect_uri?code&state 로 303.
 * 로그인한 owner 만. 검증 실패는 400 { error } (redirect 하지 않음 — OAuth 규약). 모든 응답에 no-referrer·no-store.
 * 시험용 query(mock_user·mock_grant·mock_deny)는 개발·테스트에서만 — NODE_ENV=production 이면 400 mock_params_not_allowed(D25-3).
 */
export const GET = oauthEndpoint(async (request: Request): Promise<Response> => {
  const config = getConfig();
  await requireOwner(request);
  const q = new URL(request.url).searchParams;
  if (!mockTestParamsAllowed() && MOCK_TEST_PARAMS.some((k) => q.has(k))) {
    return json({ error: 'mock_params_not_allowed', message: '운영 환경에서는 모의 시험용 매개변수를 쓸 수 없습니다', mock: true }, { status: 400 });
  }
  const r = mockGoogleProvider(config).authorize(
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
  return seeOther(r.redirect);
});
