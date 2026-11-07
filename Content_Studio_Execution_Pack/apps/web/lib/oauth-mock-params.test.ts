/**
 * FIX1-FULLREV(F6): D25-3 모의 시험 매개변수(mock_user·mock_grant·mock_deny) 허용 판정 — mockTestParamsAllowed.
 * 기본 env 는 `NODE_ENV: process.env.NODE_ENV` 식 그대로여야 Next 운영 빌드가 production 으로 고정한다(시험 실행기는 그 치환을
 * 재현하지 못하므로 소스 모양으로 확인 — dev-cert-default.test.ts 와 같은 방식). 허용 목록은 dev 로그인(isDevAuthAllowedForNodeEnv)과 같다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevAuthAllowedForNodeEnv } from '@cs/domain';
import { mockTestParamsAllowed } from './oauth';

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mockTestParamsAllowed — 허용 목록(fail closed)', () => {
  it.each([undefined, '', 'development', 'test'])('NODE_ENV=%j → 허용', (v) => {
    expect(mockTestParamsAllowed({ NODE_ENV: v })).toBe(true);
  });

  it.each(['production', 'Production', ' production', 'staging', 'prod', 'dev', 'test '])('NODE_ENV=%j → 거부(허용 목록 밖은 모두 거부)', (v) => {
    expect(mockTestParamsAllowed({ NODE_ENV: v })).toBe(false);
  });

  it('dev 로그인 판정(isDevAuthAllowedForNodeEnv)과 같은 결과', () => {
    for (const v of [undefined, '', 'development', 'test', 'production', 'staging', 'Development']) {
      expect(mockTestParamsAllowed({ NODE_ENV: v })).toBe(isDevAuthAllowedForNodeEnv(v));
    }
  });

  it('인자 없이 부르는 꼴(route 가 실제로 부르는 꼴): 시험 실행기에서는 실행 중 NODE_ENV 를 본다', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(mockTestParamsAllowed()).toBe(false);
    vi.stubEnv('NODE_ENV', 'staging');
    expect(mockTestParamsAllowed()).toBe(false);
    vi.stubEnv('NODE_ENV', 'test');
    expect(mockTestParamsAllowed()).toBe(true);
  });
});

describe('기본 env 식 — Next 운영 빌드의 상수 고정(소스로 확인)', () => {
  it('기본 env 는 `{ NODE_ENV: process.env.NODE_ENV }`(lib/server.ts getConfig·dev-cert.ts 와 같은 방식), `process.env` 통째 기본값이 아님', () => {
    const src = readFileSync(path.join(here, 'oauth.ts'), 'utf8');
    const start = src.indexOf('export function mockTestParamsAllowed');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\n}\n', start) + 2);
    expect(fn).toMatch(/^export function mockTestParamsAllowed\(env: \{ NODE_ENV\?: string \} = \{ NODE_ENV: process\.env\.NODE_ENV \}\): boolean \{/);
    expect(fn).not.toMatch(/=\s*process\.env\s*\)/);
    expect(fn).toContain('return isDevAuthAllowedForNodeEnv(env.NODE_ENV);');
    // route 3곳은 인자 없이 부른다(기본 env 식이 그대로 쓰인다)
    for (const p of ['mock-threads', 'mock-google', 'mock-instagram']) {
      const route = readFileSync(path.join(here, '..', 'app', 'api', 'oauth', p, 'authorize', 'route.ts'), 'utf8');
      expect(route, p).toContain('if (!mockTestParamsAllowed() && MOCK_TEST_PARAMS.some((k) => q.has(k))) {');
    }
  });
});
