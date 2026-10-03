/** T13(D24): OAuth 공통 — PKCE S256, state, scope, 연결 상태 판정, live 준비 상태(항상 준비 안 됨). */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import {
  codeChallengeS256,
  credentialHealth,
  hashOAuthState,
  INSTAGRAM_NOT_REQUESTED_BY_DEFAULT,
  INSTAGRAM_REQUIRED_SCOPES,
  isPlainRedirectUri,
  isUnboundLiveExternalId,
  isWellFormedOAuthState,
  LIVE_THREADS_PUBLISH_MARKER,
  liveOAuthReadiness,
  livePublishReadiness,
  UNBOUND_LIVE_EXTERNAL_PREFIX,
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
    // T16: Instagram 은 모의 자리 표시 scope(기본 + 게시)가 생겼다 — 연결 공급자가 없는 채널은 블로그(같은 단언)
    expect(requiredScopesForPlatform('blog')).toEqual([]);
  });
  it('T16 Instagram: 자리 표시 scope(기본 + 콘텐츠 게시)만, 댓글·메시지·통계는 기본 요청 목록에 없다 — 이름은 모두 (mock) 표시', () => {
    expect([...requiredScopesForPlatform('instagram')]).toEqual(['instagram_basic(mock)', 'instagram_content_publish(mock)']);
    for (const s of INSTAGRAM_NOT_REQUESTED_BY_DEFAULT) expect(INSTAGRAM_REQUIRED_SCOPES as readonly string[]).not.toContain(s);
    for (const s of [...INSTAGRAM_REQUIRED_SCOPES, ...INSTAGRAM_NOT_REQUESTED_BY_DEFAULT]) expect(s.endsWith('(mock)')).toBe(true);
  });
});

describe('credentialHealth', () => {
  const base = { status: 'active', expiresAt: new Date(NOW.getTime() + 30 * DAY), scopes: [...THREADS_REQUIRED_SCOPES], revokedAt: null, lastErrorCode: null };
  const h = (account: { kind: string; credentialState: string }, credential: typeof base | null, pendingKind: string | null = null) =>
    credentialHealth({ account, credential, requiredScopes: THREADS_REQUIRED_SCOPES, now: NOW, pendingKind });
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
  it('FIX3·FIX4: 정리 대기가 있으면 active·유효 기간이어도 error(pending_<kind>)·실행 불가, 해제된 행·연결 정보 없는 모의 계정도 마찬가지', () => {
    expect(h(mockLinked, base, 'refresh_unknown')).toMatchObject({ status: 'error', reason: 'pending_refresh_unknown', usable: false });
    expect(h(mockLinked, base, 'cleanup_revoke')).toMatchObject({ status: 'error', reason: 'pending_cleanup_revoke', usable: false });
    expect(h(mockLinked, base, 'verify_current')).toMatchObject({ status: 'error', reason: 'pending_verify_current', usable: false });
    expect(h(mockNone, { ...base, status: 'revoked', revokedAt: NOW } as unknown as typeof base, 'cleanup_revoke')).toMatchObject({ status: 'error', usable: false });
    // FIX4: 첫 연결 정리 대기 — 연결 정보 행이 없고 연결한 적 없는 모의 계정(평소엔 실행 가능)도 차단
    expect(h(mockNone, null, 'cleanup_revoke')).toMatchObject({ status: 'error', reason: 'pending_cleanup_revoke', usable: false });
    expect(h(mockNone, null, null)).toMatchObject({ status: 'not_connected', usable: true });
    expect(h(mockLinked, base, null)).toMatchObject({ status: 'connected', usable: true });
  });
});

// LIVE-T1(D31): T13 의 "항상 준비 안 됨(LIVE_OAUTH_ADAPTER(T14 미구현))" → 실제 Threads 연결은 조건이 모두 갖춰지면 준비됨.
// PUBLISH_MODE 는 연결 준비에서 빠지고(D31 은 disabled 로 연결만 승인), 게시 준비(livePublishReadiness)는 항상 준비 안 됨.
describe('live 준비 상태 — 연결(LIVE-T1)과 게시(D31 범위 밖)를 나눠 본다', () => {
  const FULL = {
    OAUTH_MODE: 'live',
    THREADS_APP_ID: 'placeholder-app-id',
    OAUTH_REDIRECT_URI: 'https://studio.example.test/api/oauth/callback',
    OAUTH_LIVE_APPROVAL_REF: 'D31',
  } as const;
  it('기본 설정: 빠진 조건 이름만(값 없음), 게시 관련 이름은 연결 준비에 없다', () => {
    const r = liveOAuthReadiness(loadConfig({}), { threadsAppSecretPresent: false, masterKeyConfigured: false });
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(['OAUTH_MODE=live', 'THREADS_APP_ID', 'THREADS_APP_SECRET', 'OAUTH_REDIRECT_URI', 'SECRETS_MASTER_KEY', 'OAUTH_LIVE_APPROVAL_REF']);
    expect(r.missing.join(',')).not.toContain('LIVE_OAUTH_ADAPTER');
  });
  it('모든 조건(PUBLISH_MODE=disabled 그대로) → ready=true, 빠진 이름 없음, 값은 결과에 없다', () => {
    const config = loadConfig({ ...FULL });
    expect(config.PUBLISH_MODE).toBe('disabled');
    const r = liveOAuthReadiness(config, { threadsAppSecretPresent: true, masterKeyConfigured: true });
    expect(r).toEqual({ ready: true, missing: [] });
    expect(JSON.stringify(r)).not.toContain('placeholder-app-id');
  });
  it.each([
    ['OAUTH_MODE', { OAUTH_MODE: 'mock' }, {}, 'OAUTH_MODE=live'],
    ['THREADS_APP_ID', { THREADS_APP_ID: undefined }, {}, 'THREADS_APP_ID'],
    ['THREADS_APP_SECRET', {}, { threadsAppSecretPresent: false }, 'THREADS_APP_SECRET'],
    ['OAUTH_REDIRECT_URI', { OAUTH_REDIRECT_URI: undefined }, {}, 'OAUTH_REDIRECT_URI'],
    ['SECRETS_MASTER_KEY', {}, { masterKeyConfigured: false }, 'SECRETS_MASTER_KEY'],
    ['OAUTH_LIVE_APPROVAL_REF', { OAUTH_LIVE_APPROVAL_REF: undefined }, {}, 'OAUTH_LIVE_APPROVAL_REF'],
  ] as const)('%s 하나만 빠짐 → ready=false, 그 이름 하나만', (_n, cfg, sec, name) => {
    const r = liveOAuthReadiness(loadConfig({ ...FULL, ...cfg } as Record<string, string | undefined>), { threadsAppSecretPresent: true, masterKeyConfigured: true, ...sec });
    expect(r).toEqual({ ready: false, missing: [name] });
  });
  it('게시 준비: PUBLISH_MODE 와 관계없이 항상 준비 안 됨 + LIVE_THREADS_PUBLISH(D31 범위 밖)', () => {
    expect(livePublishReadiness(loadConfig({}))).toEqual({ ready: false, missing: ['PUBLISH_MODE=enabled', LIVE_THREADS_PUBLISH_MARKER] });
    expect(livePublishReadiness(loadConfig({ PUBLISH_MODE: 'enabled' }))).toEqual({ ready: false, missing: [LIVE_THREADS_PUBLISH_MARKER] });
    expect(LIVE_THREADS_PUBLISH_MARKER).toBe('LIVE_THREADS_PUBLISH(D31 범위 밖)');
  });
  it('연결 전 실제 계정 ID 접두(pending:)는 mock: 과 겹치지 않는다', () => {
    expect(isUnboundLiveExternalId(`${UNBOUND_LIVE_EXTERNAL_PREFIX}x`)).toBe(true);
    expect(isUnboundLiveExternalId('1234567')).toBe(false);
    expect(UNBOUND_LIVE_EXTERNAL_PREFIX.startsWith('mock:')).toBe(false);
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
