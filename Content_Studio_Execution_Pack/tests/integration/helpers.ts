/** 통합 테스트 공용: route handler 를 new Request(...) 로 직접 호출한다(Next 서버 없이). */
import { POST as loginPOST } from '../../apps/web/app/api/auth/login/route';

export const BASE = 'http://localhost:3000';
export const ORIGIN_HEADERS = { origin: BASE } as const;

/** Set-Cookie 에서 cs_session 값만 꺼낸다(없으면 null). */
export function sessionCookieValue(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const m = /(?:^|,\s*)cs_session=([^;]*)/.exec(raw);
  return m ? m[1]! : null;
}

export function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...ORIGIN_HEADERS, ...headers },
    body: JSON.stringify(body),
  });
}

export function cookieHeader(token: string): Record<string, string> {
  return { cookie: `cs_session=${token}` };
}

/** 허용 식별자로 로그인하고 쿠키 토큰을 돌려준다. */
export async function login(identity: string): Promise<string> {
  const res = await loginPOST(jsonPost('/api/auth/login', { identity }));
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  const token = sessionCookieValue(res);
  if (!token) throw new Error('no cookie');
  return token;
}

export function assetGet(id: string, token?: string): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request(`${BASE}/api/assets/${id}`, { headers: token ? cookieHeader(token) : {} }),
    { params: Promise.resolve({ id }) },
  ];
}
