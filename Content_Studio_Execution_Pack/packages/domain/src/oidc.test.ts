/**
 * T21-P1b: OIDC 로그인 규칙(순수 함수) — 설정 형식, redirect 정확 일치, 준비 상태(이름만), 허용 신원 판정, 흐름 쿠키, 설정 지문.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import {
  buildClearedOidcFlowCookie,
  buildOidcFlowCookie,
  checkOidcIdentity,
  expectedOidcRedirectUri,
  oidcClientSettings,
  oidcIdentityPolicy,
  oidcLoginReadiness,
  oidcSettingsFingerprint,
} from './oidc';
import { isValidOidcIssuerUrl, isValidOidcScopes, parseOidcScopes } from './oidc-format';
import { OidcNotConfiguredError } from './errors';

const KEY = randomBytes(32).toString('base64');
const SECRET = 'FAKE_oidc_secret_domain_unit';
const READY_ENV = {
  AUTH_MODE: 'oidc',
  APP_BASE_URL: 'https://studio.example.com',
  OIDC_ISSUER_URL: 'https://idp.test',
  OIDC_CLIENT_ID: 'client-1',
  OIDC_CLIENT_SECRET: SECRET,
  OIDC_REDIRECT_URI: 'https://studio.example.com/api/auth/oidc/callback',
  AUTH_ALLOWED_IDENTITY: 'owner@example.com',
  SECRETS_MASTER_KEY: KEY,
  SECRETS_KEY_VERSION: '1',
} as const;
const readiness = (env: Record<string, string | undefined>) => oidcLoginReadiness(loadConfig(env), env);

describe('설정 형식(loadConfig)', () => {
  it('기본: OIDC_* 없음, OIDC_SCOPES = "openid email"', () => {
    const c = loadConfig({});
    expect(c.OIDC_ISSUER_URL).toBeUndefined();
    expect(c.OIDC_SCOPES).toBe('openid email');
    expect(c.AUTH_ALLOWED_SUBJECT).toBeUndefined();
  });
  it.each(['http://idp.test', 'https://idp.test?x=1', 'https://idp.test#f', 'https://u:p@idp.test', 'idp.test', 'ftp://idp.test'])('OIDC_ISSUER_URL %s → 설정 오류(값은 메시지에 없음)', (v) => {
    expect(isValidOidcIssuerUrl(v)).toBe(false);
    try {
      loadConfig({ OIDC_ISSUER_URL: v });
      throw new Error('no error');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('OIDC_ISSUER_URL');
      expect((e as Error).message).not.toContain(v);
    }
  });
  it('https issuer(경로 허용)는 통과', () => {
    expect(loadConfig({ OIDC_ISSUER_URL: 'https://idp.test/realms/x' }).OIDC_ISSUER_URL).toBe('https://idp.test/realms/x');
  });
  it.each(['email', 'openid  email', 'openid "x"', ' openid'])('OIDC_SCOPES %j → 설정 오류(openid 필수·공백 하나)', (v) => {
    expect(isValidOidcScopes(v)).toBe(false);
    expect(() => loadConfig({ OIDC_SCOPES: v })).toThrow(ConfigError);
  });
  it('scope 중복 제거', () => {
    expect(parseOidcScopes('openid email openid')).toEqual(['openid', 'email']);
  });
  it('OIDC_REDIRECT_URI 에 query 가 있으면 설정 오류, OIDC_CLIENT_ID 공백 → 설정 오류', () => {
    expect(() => loadConfig({ OIDC_REDIRECT_URI: 'https://studio.example.com/api/auth/oidc/callback?x=1' })).toThrow(ConfigError);
    expect(() => loadConfig({ OIDC_CLIENT_ID: 'a b' })).toThrow(ConfigError);
  });
  it('OIDC_CLIENT_SECRET 은 설정 객체에 없다(서버 환경에서만 읽음)', () => {
    const c = loadConfig({ ...READY_ENV });
    expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(JSON.stringify(c)).not.toContain(KEY);
  });
});

describe('redirect URI 정확 일치', () => {
  it('APP_BASE_URL 의 origin + /api/auth/oidc/callback', () => {
    expect(expectedOidcRedirectUri({ APP_BASE_URL: 'https://studio.example.com' })).toBe('https://studio.example.com/api/auth/oidc/callback');
    expect(expectedOidcRedirectUri({ APP_BASE_URL: 'https://studio.example.com/' })).toBe('https://studio.example.com/api/auth/oidc/callback');
  });
  it.each([
    'https://studio.example.com/api/auth/oidc/callback/',
    'https://studio.example.com:8443/api/auth/oidc/callback',
    'http://studio.example.com/api/auth/oidc/callback',
    'https://studio.example.com/api/oauth/callback',
  ])('%s → OIDC_REDIRECT_URI(불일치)', (v) => {
    expect(readiness({ ...READY_ENV, OIDC_REDIRECT_URI: v }).missing).toContain('OIDC_REDIRECT_URI(불일치)');
  });
});

describe('준비 상태(이름만)', () => {
  it('모두 갖추면 ready', () => {
    expect(readiness({ ...READY_ENV })).toEqual({ ready: true, missing: [] });
  });
  it('기본(dev) — 빠진 이름 목록, 값 없음', () => {
    const r = readiness({});
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([
      'AUTH_MODE=oidc',
      'OIDC_ISSUER_URL',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_REDIRECT_URI',
      'AUTH_ALLOWED_IDENTITY 또는 AUTH_ALLOWED_SUBJECT',
      'SECRETS_MASTER_KEY',
    ]);
  });
  it('시크릿 형식·https 아닌 APP_BASE_URL·email scope 없음·키 없음', () => {
    expect(readiness({ ...READY_ENV, OIDC_CLIENT_SECRET: 'a b' }).missing).toEqual(['OIDC_CLIENT_SECRET(형식)']);
    const http = readiness({ ...READY_ENV, APP_BASE_URL: 'http://studio.example.com', OIDC_REDIRECT_URI: 'http://studio.example.com/api/auth/oidc/callback' });
    expect(http.missing).toEqual(['APP_BASE_URL(https)']);
    // localhost 는 http 허용(로컬 시험용)
    expect(readiness({ ...READY_ENV, APP_BASE_URL: 'http://localhost:3000', OIDC_REDIRECT_URI: 'http://localhost:3000/api/auth/oidc/callback' }).ready).toBe(true);
    expect(readiness({ ...READY_ENV, OIDC_SCOPES: 'openid profile' }).missing).toEqual(['OIDC_SCOPES(email 필요)']);
    expect(readiness({ ...READY_ENV, SECRETS_MASTER_KEY: '' }).missing).toEqual(['SECRETS_MASTER_KEY']);
    for (const r of [readiness({ ...READY_ENV, OIDC_CLIENT_SECRET: 'a b' })]) expect(JSON.stringify(r)).not.toContain(SECRET);
  });
  it('AUTH_ALLOWED_IDENTITY 를 명시하지 않고(기본값만) sub 도 없으면 준비 안 됨, sub 만 있으면 email scope 없이도 준비됨', () => {
    const noIdentity = { ...READY_ENV, AUTH_ALLOWED_IDENTITY: '' };
    expect(readiness(noIdentity).missing).toEqual(['AUTH_ALLOWED_IDENTITY 또는 AUTH_ALLOWED_SUBJECT']);
    expect(readiness({ ...noIdentity, AUTH_ALLOWED_SUBJECT: 'sub-1', OIDC_SCOPES: 'openid' })).toEqual({ ready: true, missing: [] });
  });
  it('oidcClientSettings: 준비 안 됐으면 OidcNotConfiguredError, 준비되면 시크릿은 trim', () => {
    expect(() => oidcClientSettings(loadConfig({}), {})).toThrow(OidcNotConfiguredError);
    const env = { ...READY_ENV, OIDC_CLIENT_SECRET: `  ${SECRET} ` };
    expect(oidcClientSettings(loadConfig(env), env)).toEqual({
      issuer: 'https://idp.test',
      clientId: 'client-1',
      clientSecret: SECRET,
      redirectUri: 'https://studio.example.com/api/auth/oidc/callback',
      scopes: ['openid', 'email'],
    });
  });
  it('설정 지문: issuer·client·redirect·scope 가 바뀌면 달라지고 시크릿은 들어가지 않는다', () => {
    const base = { issuer: 'https://idp.test', clientId: 'c', redirectUri: 'https://a/cb', scopes: ['openid', 'email'] };
    const fp = oidcSettingsFingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(oidcSettingsFingerprint({ ...base, clientId: 'd' })).not.toBe(fp);
    expect(oidcSettingsFingerprint({ ...base, scopes: ['openid'] })).not.toBe(fp);
    expect(oidcSettingsFingerprint({ ...base, issuer: 'https://idp2.test' })).not.toBe(fp);
  });
});

describe('허용 신원 판정', () => {
  const emailOnly = oidcIdentityPolicy(loadConfig({ AUTH_ALLOWED_IDENTITY: 'Owner@Example.com' }), { AUTH_ALLOWED_IDENTITY: 'Owner@Example.com' });
  it('정책: AUTH_ALLOWED_IDENTITY 를 명시했을 때만 email 확인', () => {
    expect(emailOnly).toEqual({ email: 'Owner@Example.com', subject: null });
    expect(oidcIdentityPolicy(loadConfig({}), {})).toEqual({ email: null, subject: null });
    expect(oidcIdentityPolicy(loadConfig({ AUTH_ALLOWED_SUBJECT: 's' }), {})).toEqual({ email: null, subject: 's' });
  });
  it('email 일치(대소문자·앞뒤 공백 무시) + email_verified === true', () => {
    expect(checkOidcIdentity({ sub: 'x', email: 'owner@example.com', email_verified: true }, emailOnly)).toEqual({ ok: true });
    expect(checkOidcIdentity({ sub: 'x', email: ' OWNER@example.COM ', email_verified: true }, emailOnly)).toEqual({ ok: true });
  });
  it.each([
    [{ sub: 'x', email: 'other@example.com', email_verified: true }, 'email'],
    [{ sub: 'x', email_verified: true }, 'email'],
    [{ sub: 'x', email: 42, email_verified: true }, 'email'],
    [{ sub: 'x', email: 'owner@example.com', email_verified: false }, 'email_unverified'],
    [{ sub: 'x', email: 'owner@example.com', email_verified: 'true' }, 'email_unverified'],
    [{ sub: 'x', email: 'owner@example.com' }, 'email_unverified'],
  ] as const)('%j → 거부(%s)', (claims, check) => {
    expect(checkOidcIdentity(claims, emailOnly)).toEqual({ ok: false, check });
  });
  it('sub 고정: 정확히 같아야 함, 둘 다 설정하면 둘 다', () => {
    const subOnly = { email: null, subject: 'sub-1' };
    expect(checkOidcIdentity({ sub: 'sub-1' }, subOnly)).toEqual({ ok: true });
    expect(checkOidcIdentity({ sub: 'SUB-1' }, subOnly)).toEqual({ ok: false, check: 'subject' });
    const both = { email: 'owner@example.com', subject: 'sub-1' };
    expect(checkOidcIdentity({ sub: 'sub-1', email: 'owner@example.com', email_verified: true }, both)).toEqual({ ok: true });
    expect(checkOidcIdentity({ sub: 'sub-2', email: 'owner@example.com', email_verified: true }, both)).toEqual({ ok: false, check: 'subject' });
    expect(checkOidcIdentity({ sub: 'sub-1', email: 'x@example.com', email_verified: true }, both)).toEqual({ ok: false, check: 'email' });
  });
  it('정책이 비어 있으면 항상 거부(다른 사용자를 받지 않음)', () => {
    expect(checkOidcIdentity({ sub: 'x', email: 'a@b', email_verified: true }, { email: null, subject: null }).ok).toBe(false);
  });
});

describe('흐름 쿠키', () => {
  it('HttpOnly·SameSite=Lax·Path=/api/auth/oidc·10분, https 면 Secure', () => {
    const c = buildOidcFlowCookie('tok', { AUTH_COOKIE_SECURE: 'auto', APP_BASE_URL: 'https://studio.example.com' });
    expect(c).toBe('cs_oidc_flow=tok; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600; Secure');
    expect(buildOidcFlowCookie('tok', { AUTH_COOKIE_SECURE: 'auto', APP_BASE_URL: 'http://localhost:3000' })).not.toContain('Secure');
    expect(buildClearedOidcFlowCookie({ AUTH_COOKIE_SECURE: 'auto', APP_BASE_URL: 'http://localhost:3000' })).toBe(
      'cs_oidc_flow=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });
});
