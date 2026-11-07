/**
 * FIX-T21P1B(Codex review-T21P1B P2 login/page.tsx:61): OIDC 가 준비되지 않은 채 /login 만 열어도 빠진 설정 **이름**이 서버 로그에 남는다
 * (프로세스당 1분에 한 번 — 반복 접속이 로그를 채우지 않게). 값은 남기지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// 정적 import — 전체 시험 부하에서 훅 안 동적 import(Next·openid-client)가 훅 시간 제한(10초)을 넘었다
import LoginPage from '../app/login/page';
import { resetOidcLoginClientForTests } from './oidc';

vi.mock('./auth', () => ({ getSession: async () => null }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect');
  },
}));

const SECRET_VALUE = 'FAKE_should_never_be_logged';

beforeEach(() => {
  resetOidcLoginClientForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('준비 안 된 OIDC — 로그인 화면이 빠진 이름을 로그에 남긴다', () => {
  it('/login 렌더 → [auth] oidc_not_configured: <이름들>, 1분 안 반복은 한 번만, 1분 뒤 다시', async () => {
    vi.stubEnv('AUTH_MODE', 'oidc');
    vi.stubEnv('OIDC_ISSUER_URL', 'https://idp.test');
    vi.stubEnv('OIDC_CLIENT_ID', 'client');
    vi.stubEnv('AUTH_ALLOWED_IDENTITY', 'owner@example.local');
    vi.stubEnv('OIDC_CLIENT_SECRET', '');
    vi.stubEnv('OIDC_SCOPES', 'openid email');
    vi.stubEnv('OIDC_REDIRECT_URI', '');
    vi.stubEnv('SECRETS_MASTER_KEY', '');
    vi.stubEnv('LLM_LIVE_APPROVAL_REF', SECRET_VALUE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const render = () => LoginPage({ searchParams: Promise.resolve({}) });
      await render();
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toBe('[auth] oidc_not_configured: OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI, SECRETS_MASTER_KEY');
      expect(line).not.toContain(SECRET_VALUE);
      await render();
      await render();
      expect(warn).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 61_000);
      await render();
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000); // 첫 import(Next·openid-client)가 느리다

  it('dev 모드나 준비된 oidc 에서는 남기지 않는다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await LoginPage({ searchParams: Promise.resolve({}) });
    expect(warn).not.toHaveBeenCalled();
  }, 60_000);
});
