import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertDevLoginAllowed,
  assertLoginAvailable,
  assertSameOrigin,
  buildClearedSessionCookie,
  buildSessionCookie,
  generateSessionToken,
  hashSessionToken,
  identityMatches,
  isSessionActive,
  isWellFormedSessionToken,
  maskIdentity,
  readCookie,
  resolveCookieSecure,
  shouldTouchSession,
} from './auth';
import { loadConfig } from './config';
import { CsrfError, DevLoginNotAllowedError, OidcNotConfiguredError } from './errors';

describe('assertDevLoginAllowed (localhost 전용)', () => {
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost', 'http://localhost'])('%s 허용', (url) => {
    expect(() => assertDevLoginAllowed({ APP_BASE_URL: url })).not.toThrow();
  });
  it.each([
    'https://example.com',
    'http://192.168.0.10:3000',
    'http://localhost.example.com',
    'http://[::1]:3000',
    'http://0.0.0.0:3000',
  ])('%s 거부', (url) => {
    expect(() => assertDevLoginAllowed({ APP_BASE_URL: url })).toThrow(DevLoginNotAllowedError);
  });
  it('oidc 는 항상 OidcNotConfiguredError(T13)', () => {
    expect(() => assertLoginAvailable(loadConfig({ AUTH_MODE: 'oidc' }))).toThrow(OidcNotConfiguredError);
    expect(() => assertLoginAvailable(loadConfig({ AUTH_MODE: 'oidc' }))).toThrow('운영 인증 공급자는 아직 설정되지 않았습니다(T13)');
    expect(() => assertLoginAvailable(loadConfig({}))).not.toThrow();
    expect(() => assertLoginAvailable(loadConfig({ APP_BASE_URL: 'https://example.com' }))).toThrow(DevLoginNotAllowedError);
  });
});

describe('identityMatches', () => {
  it('정확히 같을 때만 true (길이·대소문자 다르면 false)', () => {
    expect(identityMatches('owner@example.local', 'owner@example.local')).toBe(true);
    expect(identityMatches('owner@example.loca', 'owner@example.local')).toBe(false);
    expect(identityMatches('Owner@example.local', 'owner@example.local')).toBe(false);
    expect(identityMatches('', 'owner@example.local')).toBe(false);
  });
});

describe('maskIdentity', () => {
  it('앞 2글자와 도메인만 남긴다', () => {
    expect(maskIdentity('owner@example.local')).toBe('ow***@example.local');
    expect(maskIdentity('a@x.io')).toBe('a***@x.io');
    expect(maskIdentity('plainname')).toBe('pl***');
  });
});

describe('세션 토큰', () => {
  it('32바이트 base64url(43자), 매번 다름, 해시는 sha256 hex 64자', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(isWellFormedSessionToken(a)).toBe(true);
    const h = hashSessionToken(a);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(createHash('sha256').update(a).digest('hex'));
    expect(h).not.toBe(a);
  });
  it.each(['', 'short', 'x'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)};`])('형식이 다른 토큰 거부: %s', (t) => {
    expect(isWellFormedSessionToken(t)).toBe(false);
  });
  it('유효성: 만료·폐기', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    expect(isSessionActive({ expiresAt: new Date('2026-09-24T12:00:01Z'), revokedAt: null }, now)).toBe(true);
    expect(isSessionActive({ expiresAt: now, revokedAt: null }, now)).toBe(false);
    expect(isSessionActive({ expiresAt: new Date('2026-09-25T00:00:00Z'), revokedAt: now }, now)).toBe(false);
  });
  it('last_seen_at 은 5분 이상 지났을 때만 갱신', () => {
    const now = new Date('2026-09-24T12:00:00Z');
    expect(shouldTouchSession(new Date('2026-09-24T11:56:00Z'), now)).toBe(false);
    expect(shouldTouchSession(new Date('2026-09-24T11:55:00Z'), now)).toBe(true);
  });
});

describe('쿠키', () => {
  it('auto: http://localhost 는 Secure 없음, 그 외 Secure', () => {
    expect(resolveCookieSecure(loadConfig({}))).toBe(false);
    expect(resolveCookieSecure(loadConfig({ APP_BASE_URL: 'http://127.0.0.1:3000' }))).toBe(false);
    expect(resolveCookieSecure(loadConfig({ APP_BASE_URL: 'https://localhost:3000' }))).toBe(true);
    expect(resolveCookieSecure(loadConfig({ APP_BASE_URL: 'https://example.com' }))).toBe(true);
    expect(resolveCookieSecure(loadConfig({ AUTH_COOKIE_SECURE: 'true' }))).toBe(true);
    expect(resolveCookieSecure(loadConfig({ APP_BASE_URL: 'https://example.com', AUTH_COOKIE_SECURE: 'false' }))).toBe(false);
  });
  it('세션 쿠키 속성: HttpOnly, SameSite=Lax, Path=/, Max-Age=TTL', () => {
    const c = buildSessionCookie('tok', loadConfig({ AUTH_SESSION_TTL_MINUTES: '60' }));
    expect(c).toBe('cs_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600');
    expect(buildSessionCookie('tok', loadConfig({ AUTH_COOKIE_SECURE: 'true' }))).toMatch(/; Secure$/);
    expect(buildClearedSessionCookie(loadConfig({}))).toBe('cs_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  });
  it('readCookie', () => {
    expect(readCookie('a=1; cs_session=abc; b=2', 'cs_session')).toBe('abc');
    expect(readCookie('xcs_session=abc', 'cs_session')).toBeNull();
    expect(readCookie(null, 'cs_session')).toBeNull();
  });
});

describe('assertSameOrigin (CSRF)', () => {
  const config = { APP_BASE_URL: 'http://localhost:3000' };
  const req = (method: string, headers: Record<string, string>) => ({ method, headers: new Headers(headers) });

  it('같은 Origin 허용, Referer 대체 허용', () => {
    expect(() => assertSameOrigin(req('POST', { origin: 'http://localhost:3000' }), config)).not.toThrow();
    expect(() => assertSameOrigin(req('POST', { referer: 'http://localhost:3000/login?x=1' }), config)).not.toThrow();
    expect(() =>
      assertSameOrigin(req('POST', { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }), config),
    ).not.toThrow();
    expect(() => assertSameOrigin(req('POST', { origin: 'http://localhost:3000', 'sec-fetch-site': 'none' }), config)).not.toThrow();
  });
  it.each([
    [{}],
    [{ origin: 'http://evil.example' }],
    [{ origin: 'null' }],
    [{ origin: 'null', referer: 'http://localhost:3000/' }],
    [{ origin: 'http://localhost:3001' }],
    [{ origin: 'https://localhost:3000' }],
    [{ referer: 'http://evil.example/' }],
    [{ origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' }],
    [{ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }],
  ])('POST 거부: %j', (headers) => {
    expect(() => assertSameOrigin(req('POST', headers), config)).toThrow(CsrfError);
  });
  it('PATCH/DELETE 도 검사, GET 은 검사하지 않음', () => {
    expect(() => assertSameOrigin(req('DELETE', {}), config)).toThrow(CsrfError);
    expect(() => assertSameOrigin(req('patch', {}), config)).toThrow(CsrfError);
    expect(() => assertSameOrigin(req('GET', {}), config)).not.toThrow();
  });
});
