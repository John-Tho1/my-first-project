/**
 * T21-P2: 서버 시작 훅의 순서 — 시작 가드(T21-P1a)가 먼저, 가드를 통과했을 때만 주기 tick 시작. nodejs 런타임이 아니면 아무것도 하지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, guard, startTimer } = vi.hoisted(() => {
  const calls: string[] = [];
  const guard = vi.fn((env: { AUTH_MODE: string | undefined; NODE_ENV: string | undefined }) => {
    calls.push(`guard:${env.AUTH_MODE ?? ''}`);
  });
  const startTimer = vi.fn(() => {
    calls.push('timer');
    return { outcome: 'interval_off', timer: null };
  });
  return { calls, guard, startTimer };
});

vi.mock('./lib/startup-guard', () => ({ refuseDevAuthInProductionAtStartup: guard }));
vi.mock('./lib/inline-worker-timer', () => ({ startInlineWorkerTimerFromEnv: startTimer }));

beforeEach(() => {
  calls.length = 0;
  guard.mockClear();
  startTimer.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('instrumentation register', () => {
  it('nodejs 런타임: 가드 → 타이머 순서로 한 번씩', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('AUTH_MODE', 'oidc');
    const { register } = await import('./instrumentation');
    await register();
    expect(calls).toEqual(['guard:oidc', 'timer']);
  });

  it('가드가 시작을 거부하면(종료) 타이머를 시작하지 않는다', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    guard.mockImplementationOnce(() => {
      calls.push('guard:exit');
      throw new Error('exit 1');
    });
    const { register } = await import('./instrumentation');
    await expect(register()).rejects.toThrow('exit 1');
    expect(calls).toEqual(['guard:exit']);
    expect(startTimer).not.toHaveBeenCalled();
  });

  it('edge 런타임·런타임 없음: 아무것도 하지 않는다', async () => {
    const { register } = await import('./instrumentation');
    for (const rt of ['edge', '']) {
      vi.stubEnv('NEXT_RUNTIME', rt);
      await register();
    }
    expect(calls).toEqual([]);
  });
});
