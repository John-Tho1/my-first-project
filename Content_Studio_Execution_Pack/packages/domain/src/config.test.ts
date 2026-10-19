import { describe, expect, it } from 'vitest';
import { ConfigError, describeModes, getModes, loadConfig } from './config';

describe('loadConfig', () => {
  it('빈 환경에서는 안전한 기본값을 쓴다', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      APP_BASE_URL: 'http://localhost:3000',
      APP_TIMEZONE: 'Europe/Moscow',
      DB_DRIVER: 'pglite',
      DATABASE_URL: './data/pglite',
      LLM_MODE: 'mock',
      PUBLISH_MODE: 'disabled',
      COLLECTOR_MODE: 'disabled',
      WORKER_MODE: 'inline',
      AUTH_ALLOWED_IDENTITY: 'owner@example.local',
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: './data/assets',
      EXPORT_LOCAL_DIR: './data/exports',
      RESTORE_LOCAL_DIR: './data/restores',
      AUTH_MODE: 'dev',
      AUTH_SESSION_TTL_MINUTES: 720,
      AUTH_COOKIE_SECURE: 'auto',
    });
    expect(c.LLM_PROVIDER).toBeUndefined();
    expect(c.LLM_MODEL).toBeUndefined();
    expect(getModes(c)).toEqual({ llm: 'mock', publish: 'disabled', collectors: 'disabled' });
  });

  it('빈 문자열은 미설정으로 취급한다', () => {
    expect(loadConfig({ PUBLISH_MODE: '', LLM_MODE: '  ' }).PUBLISH_MODE).toBe('disabled');
  });

  it('T21-P2: WORKER_INLINE_INTERVAL_SECONDS — 기본 0(끔), 0 또는 5~600 정수만, 오류에는 이름만(값 없음)', () => {
    expect(loadConfig({}).WORKER_INLINE_INTERVAL_SECONDS).toBe(0);
    expect(loadConfig({ WORKER_INLINE_INTERVAL_SECONDS: '' }).WORKER_INLINE_INTERVAL_SECONDS).toBe(0);
    expect(loadConfig({ WORKER_INLINE_INTERVAL_SECONDS: '  ' }).WORKER_INLINE_INTERVAL_SECONDS).toBe(0);
    for (const [raw, n] of [['0', 0], ['5', 5], ['30', 30], ['600', 600], ['0030', 30]] as const) {
      expect(loadConfig({ WORKER_INLINE_INTERVAL_SECONDS: raw }).WORKER_INLINE_INTERVAL_SECONDS).toBe(n);
    }
    for (const bad of ['1', '4', '601', '3600', '-1', '1.5', '30s', 'abc', '99999', ' 30']) {
      let msg = '';
      try {
        loadConfig({ WORKER_INLINE_INTERVAL_SECONDS: bad });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        msg = (e as Error).message;
      }
      expect(msg).toContain('WORKER_INLINE_INTERVAL_SECONDS');
      expect(msg).not.toContain(`: ${bad}`);
    }
  });

  it('LIVE-P2(D39): PUBLISH_LIVE_DAILY_MAX — 없으면 일일 상한 없음(undefined), 1~50 정수만, 0·51·정수 아님은 거부(오류에는 이름·라벨만, 값 없음)', () => {
    expect(loadConfig({}).PUBLISH_LIVE_DAILY_MAX).toBeUndefined();
    expect(loadConfig({ PUBLISH_LIVE_DAILY_MAX: '' }).PUBLISH_LIVE_DAILY_MAX).toBeUndefined();
    expect(loadConfig({ PUBLISH_LIVE_DAILY_MAX: '  ' }).PUBLISH_LIVE_DAILY_MAX).toBeUndefined();
    for (const n of [1, 2, 3, 10, 49, 50]) expect(loadConfig({ PUBLISH_LIVE_DAILY_MAX: String(n) }).PUBLISH_LIVE_DAILY_MAX).toBe(n);
    expect(loadConfig({ PUBLISH_LIVE_DAILY_MAX: '03' }).PUBLISH_LIVE_DAILY_MAX).toBe(3);
    for (const bad of ['0', '00', '51', '99', '100', '-1', '1.5', '3.0', '3e1', '3 ', ' 3', 'abc', 'three', '0x3', '+3']) {
      let msg = '';
      try {
        loadConfig({ PUBLISH_LIVE_DAILY_MAX: bad });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        msg = (e as Error).message;
      }
      expect({ bad, named: msg.includes('PUBLISH_LIVE_DAILY_MAX(최근 24시간 실제 게시 수 상한, 1~50 — 없으면 일일 상한 없음)') }).toEqual({ bad, named: true });
      expect(msg).not.toContain(`: ${bad}`);
    }
    // 다른 실제 게시 설정과 독립 — 일일 상한만 있어도 게시 준비 조건(승인 기록·게시 수 상한)은 그대로 필요하다
    const c = loadConfig({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_DAILY_MAX: '3' });
    expect(c.PUBLISH_LIVE_DAILY_MAX).toBe(3);
    expect(c.PUBLISH_LIVE_APPROVAL_REF).toBeUndefined();
    expect(c.PUBLISH_LIVE_MAX_POSTS).toBeUndefined();
  });

  it('memory:// DATABASE_URL 을 허용한다', () => {
    expect(loadConfig({ DATABASE_URL: 'memory://' }).DATABASE_URL).toBe('memory://');
  });

  it.each([
    ['PUBLISH_MODE', 'yes'],
    ['PUBLISH_MODE', 'ENABLED'],
    ['LLM_MODE', 'real'],
    ['COLLECTOR_MODE', 'on'],
    ['DB_DRIVER', 'sqlite'],
    ['WORKER_MODE', 'cluster'],
    ['APP_TIMEZONE', 'Asia/Seoul'],
    ['APP_BASE_URL', 'not a url'],
    ['STORAGE_DRIVER', 's3'],
    ['AUTH_MODE', 'password'],
    ['AUTH_MODE', 'DEV'],
    ['AUTH_SESSION_TTL_MINUTES', '4'],
    ['AUTH_SESSION_TTL_MINUTES', '43201'],
    ['AUTH_SESSION_TTL_MINUTES', '12.5'],
    ['AUTH_SESSION_TTL_MINUTES', '-10'],
    ['AUTH_SESSION_TTL_MINUTES', 'abc'],
    ['AUTH_COOKIE_SECURE', 'yes'],
  ])('%s=%s 이면 한국어 메시지로 실패한다', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
    expect(() => loadConfig({ [key]: value })).toThrow(/환경변수 설정이 올바르지 않습니다/);
    expect(() => loadConfig({ [key]: value })).toThrow(new RegExp(key));
  });

  it('AUTH_* 새 변수를 파싱한다', () => {
    const c = loadConfig({ AUTH_MODE: 'oidc', AUTH_SESSION_TTL_MINUTES: '60', AUTH_COOKIE_SECURE: 'true' });
    expect(c.AUTH_MODE).toBe('oidc');
    expect(c.AUTH_SESSION_TTL_MINUTES).toBe(60);
    expect(c.AUTH_COOKIE_SECURE).toBe('true');
    expect(loadConfig({ AUTH_SESSION_TTL_MINUTES: '5' }).AUTH_SESSION_TTL_MINUTES).toBe(5);
    expect(loadConfig({ AUTH_SESSION_TTL_MINUTES: '43200' }).AUTH_SESSION_TTL_MINUTES).toBe(43200);
    expect(loadConfig({ AUTH_SESSION_TTL_MINUTES: '' }).AUTH_SESSION_TTL_MINUTES).toBe(720);
  });

  it('오류 메시지에 입력값을 노출하지 않는다', () => {
    try {
      loadConfig({ PUBLISH_MODE: 'secret-looking-value-123' });
      expect.unreachable();
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('secret-looking-value-123');
    }
  });
});

describe('describeModes', () => {
  it('기본 모드의 한국어 배지', () => {
    expect(describeModes(loadConfig({})).map((b) => b.label)).toEqual(['LLM: 모의', '게시: 비활성', '수집: 비활성']);
  });
  it('활성 상태도 사실대로 표시한다', () => {
    const labels = describeModes(
      loadConfig({ LLM_MODE: 'live', PUBLISH_MODE: 'enabled', COLLECTOR_MODE: 'enabled' }),
    ).map((b) => b.label);
    expect(labels).toEqual(['LLM: 실제', '게시: 활성', '수집: 활성']);
  });
});
