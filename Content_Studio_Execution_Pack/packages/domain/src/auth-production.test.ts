/**
 * T21-P1a(G1a): 운영 빌드에서 비밀번호 없는 dev 로그인 거부 + 로그인 시도 횟수 제한(순수 함수 부분).
 */
import { describe, expect, it } from 'vitest';
import {
  assertLoginAvailable,
  assertLoginNotRateLimited,
  LOGIN_FAILURE_REASONS,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_MAX_FAILURES,
} from './auth';
import {
  ConfigError,
  DEV_AUTH_REFUSED_CONFIG_MESSAGE,
  devAuthRefusedByRuntime,
  isDevAuthAllowedForNodeEnv,
  loadConfig,
} from './config';
import {
  DevLoginNotAllowedError,
  DevLoginRefusedInProductionError,
  LoginRateLimitedError,
  OidcNotConfiguredError,
} from './errors';

describe('isDevAuthAllowedForNodeEnv', () => {
  it.each([undefined, '', 'development', 'test'])('%s → 허용', (v) => {
    expect(isDevAuthAllowedForNodeEnv(v)).toBe(true);
  });
  it.each(['production', 'Production', ' production', 'staging', 'prod', 'test ', 'dev'])('%s → 거부(허용 목록 밖은 모두 거부)', (v) => {
    expect(isDevAuthAllowedForNodeEnv(v)).toBe(false);
  });
});

describe('loadConfig — 운영 빌드 + AUTH_MODE=dev', () => {
  it('NODE_ENV=production + AUTH_MODE 미설정(기본 dev) → ConfigError', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
  });
  it('NODE_ENV=production + AUTH_MODE=dev / 빈 값 → ConfigError, 문구는 설정 이름만', () => {
    for (const AUTH_MODE of ['dev', '', '  ']) {
      let err: unknown;
      try {
        loadConfig({ NODE_ENV: 'production', AUTH_MODE, AUTH_ALLOWED_IDENTITY: 'secret-owner@example.local' });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as Error).message;
      expect(msg).toBe(DEV_AUTH_REFUSED_CONFIG_MESSAGE);
      expect(msg).toContain('AUTH_MODE(인증 방식)');
      expect(msg).not.toContain('secret-owner');
    }
  });
  it('NODE_ENV=staging 같은 다른 값도 거부(fail closed)', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(ConfigError);
  });
  it('NODE_ENV=production + AUTH_MODE=oidc → 설정은 읽힌다(로그인은 oidc 미구현으로 거부)', () => {
    const c = loadConfig({ NODE_ENV: 'production', AUTH_MODE: 'oidc' });
    expect(c.AUTH_MODE).toBe('oidc');
    expect(() => assertLoginAvailable(c, 'production')).toThrow(OidcNotConfiguredError);
  });
  it.each([undefined, 'development', 'test'])('NODE_ENV=%s + dev → 허용(기존 동작)', (NODE_ENV) => {
    expect(loadConfig({ NODE_ENV }).AUTH_MODE).toBe('dev');
  });
});

describe('devAuthRefusedByRuntime (원시 환경변수, 서버 시작·로그인 첫 검사)', () => {
  it('production + dev/미설정/빈 값 → true', () => {
    expect(devAuthRefusedByRuntime({ NODE_ENV: 'production' })).toBe(true);
    expect(devAuthRefusedByRuntime({ NODE_ENV: 'production', AUTH_MODE: 'dev' })).toBe(true);
    expect(devAuthRefusedByRuntime({ NODE_ENV: 'production', AUTH_MODE: ' ' })).toBe(true);
  });
  it('production + oidc → false, test/development/없음 + dev → false', () => {
    expect(devAuthRefusedByRuntime({ NODE_ENV: 'production', AUTH_MODE: 'oidc' })).toBe(false);
    expect(devAuthRefusedByRuntime({ NODE_ENV: 'test', AUTH_MODE: 'dev' })).toBe(false);
    expect(devAuthRefusedByRuntime({ NODE_ENV: 'development' })).toBe(false);
    expect(devAuthRefusedByRuntime({})).toBe(false);
  });
});

describe('assertLoginAvailable — 두 번째 방어선(설정 객체가 NODE_ENV 없이 만들어진 경우)', () => {
  const devConfig = loadConfig({}); // NODE_ENV 없이 만든 dev 설정
  it('nodeEnv=production → DevLoginRefusedInProductionError(503 계열, localhost 라도)', () => {
    expect(() => assertLoginAvailable(devConfig, 'production')).toThrow(DevLoginRefusedInProductionError);
    const e = (() => {
      try {
        assertLoginAvailable(devConfig, 'production');
      } catch (err) {
        return err as DevLoginRefusedInProductionError;
      }
      return null;
    })();
    expect(e?.kind).toBe('service_unavailable');
    expect(e?.code).toBe('dev_login_refused_in_production');
  });
  it('nodeEnv=test/development/undefined → 기존 localhost 검사만', () => {
    expect(() => assertLoginAvailable(devConfig, 'test')).not.toThrow();
    expect(() => assertLoginAvailable(devConfig, 'development')).not.toThrow();
    expect(() => assertLoginAvailable(devConfig, undefined)).not.toThrow();
    expect(() => assertLoginAvailable(loadConfig({ APP_BASE_URL: 'https://example.com' }), 'test')).toThrow(DevLoginNotAllowedError);
  });
});

describe('assertLoginNotRateLimited', () => {
  it('상수: 15분 창, 10회, 실패 사유 2종', () => {
    expect(LOGIN_FAILURE_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(LOGIN_MAX_FAILURES).toBe(10);
    expect([...LOGIN_FAILURE_REASONS]).toEqual(['identity_mismatch', 'invalid_request']);
  });
  it('상한 미만은 통과, 상한 이상은 429(login_rate_limited)', () => {
    expect(() => assertLoginNotRateLimited(0)).not.toThrow();
    expect(() => assertLoginNotRateLimited(LOGIN_MAX_FAILURES - 1)).not.toThrow();
    expect(() => assertLoginNotRateLimited(LOGIN_MAX_FAILURES)).toThrow(LoginRateLimitedError);
    expect(() => assertLoginNotRateLimited(LOGIN_MAX_FAILURES + 5)).toThrow(LoginRateLimitedError);
    const e = new LoginRateLimitedError();
    expect(e.kind).toBe('too_many_requests');
    expect(e.code).toBe('login_rate_limited');
  });
});
