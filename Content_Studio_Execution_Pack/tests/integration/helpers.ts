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

/**
 * FIX1-FULLREV3(H5): 브라우저가 <textarea>·<pre> 의 원문(여는 태그와 닫는 태그 사이)을 읽는 규칙 — HTML 트리 구성 단계는 여는 태그 바로 뒤
 * LF 하나(입력 전처리에서 CRLF·CR 도 LF 가 된다)를 버린다. 409 화면 폼을 "사용자가 손대지 않고 다시 제출"하는 시험이 이 규칙을 따라야
 * 서버가 맨 앞 LF 를 넣지 않았을 때 생기는 빈 줄 손실을 잡는다. raw 는 escape 를 풀기 전 값(escape 는 LF·CR 을 바꾸지 않음).
 */
export function browserTextareaRaw(raw: string): string {
  if (raw.startsWith('\r\n')) return raw.slice(2);
  if (raw.startsWith('\n') || raw.startsWith('\r')) return raw.slice(1);
  return raw;
}
