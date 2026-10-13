/**
 * T21-P1b: OIDC 설정 값의 형식 검사(의존성 없는 순수 함수). config.ts(스키마)와 oidc.ts(준비 상태)가 함께 쓴다 —
 * config.ts 가 oidc.ts 를 직접 가져오면 config → oidc → auth → config 순환이 생기므로 따로 둔다.
 */

export const OIDC_DEFAULT_SCOPES = 'openid email';

/** OIDC_ISSUER_URL 형식: https + host(+path), query·fragment·사용자 정보 없음. */
export function isValidOidcIssuerUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || !u.hostname) return false;
  if (u.search || u.hash || raw.includes('?') || raw.includes('#') || u.username || u.password) return false;
  return true;
}

/** OIDC_CLIENT_ID: 공백 없는 1~512자. */
export const isValidOidcClientId = (v: string | null | undefined): boolean => typeof v === 'string' && /^\S{1,512}$/.test(v);

/** OIDC_CLIENT_SECRET: 앞뒤 공백을 뗀 값이 공백 없는 1~1024자(서버는 뗀 값을 쓴다). 값은 돌려주지 않는다. */
export const isValidOidcClientSecret = (v: string | null | undefined): boolean => typeof v === 'string' && /^\S{1,1024}$/.test(v.trim());

/** scope 목록(RFC 6749 scope-token, 공백 하나로 구분)이고 openid 를 포함해야 한다. */
export function isValidOidcScopes(raw: string): boolean {
  if (!/^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(raw)) return false;
  return raw.split(' ').includes('openid');
}

export function parseOidcScopes(raw: string): string[] {
  return [...new Set(raw.split(' ').filter(Boolean))];
}
