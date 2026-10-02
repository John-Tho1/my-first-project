/** T13(D24): OAuth 공통 — PKCE S256, state, scope, 연결 상태 판정, live 준비 상태(항상 준비 안 됨). */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import {
  codeChallengeS256,
  credentialHealth,
  hashOAuthState,
  isPlainRedirectUri,
  isWellFormedOAuthState,
  liveOAuthReadiness,
  newCodeVerifier,
  newOAuthState,
  OAUTH_EXPIRING_SOON_MS,
  oauthRedirectUri,
  requestRedirectTarget,
  requiredScopesForPlatform,
  THREADS_NOT_REQUESTED_BY_DEFAULT,
  THREADS_REQUIRED_SCOPES,
} from './oauth';

const NOW = new Date('2026-10-02T12:00:00Z');
const DAY = 24 * 3600_000;

describe('PKCE·state', () => {
  it('S256 = RFC 7636 부록 B 시험 벡터', () => {
    expect(codeChallengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('state·verifier: 32바이트 난수(base64url 43자), 매번 다름, 저장은 SHA-256 hex', () => {
    const a = newOAuthState();
    const b = newOAuthState();
    expect(a).not.toBe(b);
    expect(isWellFormedOAuthState(a)).toBe(true);
    expect(isWellFormedOAuthState('short')).toBe(false);
    expect(isWellFormedOAuthState(undefined)).toBe(false);
    expect(hashOAuthState(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOAuthState(a)).not.toContain(a);
    expect(newCodeVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('redirect URI: 기본 APP_BASE_URL + /api/oauth/callback, 설정값 우선, 요청 대상은 query 제외', () => {
    expect(oauthRedirectUri(loadConfig({}))).toBe('http://localhost:3000/api/oauth/callback');
    expect(oauthRedirectUri(loadConfig({ OAUTH_REDIRECT_URI: 'https://studio.example.test/api/oauth/callback' }))).toBe('https://studio.example.test/api/oauth/callback');
    expect(requestRedirectTarget('http://localhost:3000/api/oauth/callback?code=x&state=y')).toBe('http://localhost:3000/api/oauth/callback');
  });
});

describe('scope', () => {
  it('Threads 는 기본 + 게시만 요청, 답글·통계는 기본 요청 목록에 없다', () => {
    expect([...requiredScopesForPlatform('threads')]).toEqual(['threads_basic', 'threads_content_publish']);
    for (const s of THREADS_NOT_REQUESTED_BY_DEFAULT) expect(THREADS_REQUIRED_SCOPES as readonly string[]).not.toContain(s);
    expect(requiredScopesForPlatform('instagram')).toEqual([]);
  });
});

describe('credentialHealth', () => {
  const base = { status: 'active', expiresAt: new Date(NOW.getTime() + 30 * DAY), scopes: [...THREADS_REQUIRED_SCOPES], revokedAt: null, lastErrorCode: null };
  const h = (account: { kind: string; credentialState: string }, credential: typeof base | null) =>
    credentialHealth({ account, credential, requiredScopes: THREADS_REQUIRED_SCOPES, now: NOW });
  const mockNone = { kind: 'mock', credentialState: 'none' };
  const mockLinked = { kind: 'mock', credentialState: 'linked' };

  it('연결한 적 없는 모의 계정 = not_connected, 실행 가능(M3 동작), 연결 정보 불필요', () => {
    expect(h(mockNone, null)).toMatchObject({ status: 'not_connected', usable: true, required: false });
  });
  it('live 계정·복원 계정·연결했던 계정에 연결 정보가 없으면 needs_reconnect(실행 불가)', () => {
    expect(h({ kind: 'live', credentialState: 'none' }, null)).toMatchObject({ status: 'needs_reconnect', usable: false, required: true });
    expect(h({ kind: 'mock', credentialState: 'needs_reconnect' }, null)).toMatchObject({ status: 'needs_reconnect', usable: false, reason: 'restored_without_credential' });
    expect(h(mockLinked, null)).toMatchObject({ status: 'needs_reconnect', usable: false });
  });
  it('연결됨 / 곧 만료(7일 안) / 만료 / 철회 / 오류 / scope 부족', () => {
    expect(h(mockLinked, base)).toMatchObject({ status: 'connected', usable: true, required: true });
    expect(h(mockLinked, { ...base, expiresAt: new Date(NOW.getTime() + OAUTH_EXPIRING_SOON_MS) })).toMatchObject({ status: 'expiring_soon', usable: true });
    expect(h(mockLinked, { ...base, expiresAt: NOW })).toMatchObject({ status: 'expired', usable: false });
    expect(h(mockLinked, { ...base, expiresAt: new Date(NOW.getTime() - 1) })).toMatchObject({ status: 'expired', usable: false });
    expect(h(mockLinked, { ...base, status: 'revoked', revokedAt: NOW } as unknown as typeof base)).toMatchObject({ status: 'revoked', usable: false });
    expect(h(mockLinked, { ...base, status: 'error', lastErrorCode: 'token_revoked' } as unknown as typeof base)).toMatchObject({ status: 'error', reason: 'token_revoked', usable: false });
    expect(h(mockLinked, { ...base, scopes: ['threads_basic'] })).toMatchObject({ status: 'needs_reconnect', reason: 'scope_missing', missingScopes: ['threads_content_publish'], usable: false });
  });
  it('FIX3: 정리 대기 표시가 있으면 active·유효 기간이어도 error(pending_<kind>)·실행 불가, 해제된 행·연결한 적 없는 모의 계정도 마찬가지', () => {
    const withPending = (kind: string) => ({ ...base, pendingKind: kind }) as unknown as typeof base;
    expect(h(mockLinked, withPending('refresh_unknown'))).toMatchObject({ status: 'error', reason: 'pending_refresh_unknown', usable: false });
    expect(h(mockLinked, withPending('cleanup_revoke'))).toMatchObject({ status: 'error', reason: 'pending_cleanup_revoke', usable: false });
    expect(h(mockNone, { ...withPending('cleanup_revoke'), status: 'revoked', revokedAt: NOW } as unknown as typeof base)).toMatchObject({ status: 'error', usable: false });
    expect(h(mockLinked, { ...base, pendingKind: null } as unknown as typeof base)).toMatchObject({ status: 'connected', usable: true });
  });
});

describe('live 준비 상태 — T13 에는 live 어댑터가 없어 항상 준비 안 됨', () => {
  it('기본 설정: 빠진 조건 이름만(값 없음)', () => {
    const r = liveOAuthReadiness(loadConfig({}), { threadsAppSecretPresent: false, masterKeyConfigured: false });
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual([
      'OAUTH_MODE=live',
      'THREADS_APP_ID',
      'THREADS_APP_SECRET',
      'OAUTH_REDIRECT_URI',
      'SECRETS_MASTER_KEY',
      'OAUTH_LIVE_APPROVAL_REF',
      'PUBLISH_MODE=enabled',
      'LIVE_OAUTH_ADAPTER(T14 미구현)',
    ]);
  });
  it('모든 조건이 있어도 ready=false, LIVE_OAUTH_ADAPTER 만 남는다', () => {
    const config = loadConfig({
      OAUTH_MODE: 'live',
      THREADS_APP_ID: 'placeholder-app-id',
      OAUTH_REDIRECT_URI: 'https://studio.example.test/api/oauth/callback',
      OAUTH_LIVE_APPROVAL_REF: 'D99',
      PUBLISH_MODE: 'enabled',
    });
    const r = liveOAuthReadiness(config, { threadsAppSecretPresent: true, masterKeyConfigured: true });
    expect(r).toEqual({ ready: false, missing: ['LIVE_OAUTH_ADAPTER(T14 미구현)'] });
    expect(JSON.stringify(r)).not.toContain('placeholder-app-id');
  });
});

describe('FIX-T13 P2 — redirect URI 는 query·fragment 없이', () => {
  it('query·fragment·사용자 정보·http(s) 아님 → 설정 오류(ConfigError), 경로만 있는 주소는 통과', () => {
    for (const bad of [
      'http://localhost:3000/api/oauth/callback?tenant=x',
      'http://localhost:3000/api/oauth/callback#frag',
      'http://localhost:3000/api/oauth/callback?',
      'http://user:pw@localhost:3000/api/oauth/callback',
      'ftp://localhost/api/oauth/callback',
    ]) {
      expect(() => loadConfig({ OAUTH_REDIRECT_URI: bad }), bad).toThrow(ConfigError);
      expect(isPlainRedirectUri(bad), bad).toBe(false);
    }
    expect(loadConfig({ OAUTH_REDIRECT_URI: 'https://studio.example.test/api/oauth/callback' }).OAUTH_REDIRECT_URI).toBe('https://studio.example.test/api/oauth/callback');
    expect(isPlainRedirectUri('https://studio.example.test/api/oauth/callback')).toBe(true);
    // 기본값은 APP_BASE_URL 의 origin 만 쓴다(경로·query 가 있어도)
    expect(oauthRedirectUri(loadConfig({ APP_BASE_URL: 'http://localhost:3000/app?x=1' }))).toBe('http://localhost:3000/api/oauth/callback');
  });
});
