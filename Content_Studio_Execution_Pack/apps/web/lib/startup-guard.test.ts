import { afterEach, describe, expect, it, vi } from 'vitest';
import { refuseDevAuthInProductionAtStartup } from './startup-guard';

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}
const exit = (code: number): never => {
  throw new Exit(code);
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refuseDevAuthInProductionAtStartup (T21-P1a 서버 시작 거부)', () => {
  it('production + AUTH_MODE 미설정/dev → 종료 코드 1, 한국어 안내에 설정 이름만', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const AUTH_MODE of [undefined, 'dev']) {
      expect(() => refuseDevAuthInProductionAtStartup({ AUTH_MODE, NODE_ENV: 'production' }, exit)).toThrow(Exit);
    }
    expect(log).toHaveBeenCalledTimes(2);
    const text = String(log.mock.calls[0]![0]);
    expect(text).toContain('서버를 시작하지 않습니다');
    expect(text).toContain('AUTH_MODE(인증 방식)');
    try {
      refuseDevAuthInProductionAtStartup({ AUTH_MODE: 'dev', NODE_ENV: 'production' }, exit);
    } catch (e) {
      expect((e as Exit).code).toBe(1);
    }
  });
  it('production + oidc, development/test + dev → 통과(종료하지 않음)', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => refuseDevAuthInProductionAtStartup({ AUTH_MODE: 'oidc', NODE_ENV: 'production' }, exit)).not.toThrow();
    expect(() => refuseDevAuthInProductionAtStartup({ AUTH_MODE: 'dev', NODE_ENV: 'development' }, exit)).not.toThrow();
    expect(() => refuseDevAuthInProductionAtStartup({ AUTH_MODE: undefined, NODE_ENV: 'test' }, exit)).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
});
