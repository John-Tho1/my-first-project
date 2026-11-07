/**
 * FIX1-EXPIRY1(D39 검토 P2 dev-cert.ts:47): 화면(app/page.tsx·app/settings/page.tsx)이 실제로 부르는 꼴 — `readDevCertExpiry()`(옵션 없음) —
 * 그대로 운영 빌드(NODE_ENV=production) 판정을 시험한다. 옵션으로 fs·resolve 를 넘기지 않으므로 node:fs 와 @cs/db(resolveFromRoot)를
 * 모듈째 바꿔 끼워 "경로 계산·파일 접근이 한 번도 없었다"를 본다. 시험 전용 인증서만 쓴다(실제 data/dev-certs 는 열지 않음 — resolve 가
 * 늘 시험 인증서 경로를 돌려준다).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '../../..', 'tests/fixtures/dev-cert/TEST-ONLY-throwaway-cert.pem');
const FIXTURE_VALID_TO = '2036-10-16T13:17:51.000Z';

const seen = vi.hoisted(() => ({ fs: [] as string[], resolve: [] as string[], fixture: '' }));

// node:fs 의 파일 접근 함수를 모두 기록(동작은 진짜 그대로)
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const names = ['statSync', 'lstatSync', 'readFileSync', 'openSync', 'readSync', 'existsSync', 'accessSync', 'realpathSync', 'readdirSync'] as const;
  const wrapped: Record<string, unknown> = {};
  for (const n of names) {
    const fn = real[n] as (...a: unknown[]) => unknown;
    wrapped[n] = (...a: unknown[]) => {
      seen.fs.push(`${n}:${String(a[0])}`);
      return fn(...a);
    };
  }
  return { ...real, ...wrapped, default: { ...real, ...wrapped } };
});
// 워크스페이스 루트 기준 경로 계산 — 호출을 기록하고 늘 시험 인증서를 가리킨다(실제 data/ 를 가리키지 않게)
vi.mock('@cs/db', () => ({
  resolveFromRoot: (p: string) => {
    seen.resolve.push(p);
    return seen.fixture;
  },
}));

const { readDevCertExpiry } = await import('./dev-cert');

beforeEach(() => {
  seen.fs.length = 0;
  seen.resolve.length = 0;
  seen.fixture = FIXTURE;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readDevCertExpiry() — 화면이 부르는 기본 경로(옵션 없음)', () => {
  it('NODE_ENV=production(+ DEV_TLS_CERT_PATH 가 맞는 인증서) → null, 경로 계산·stat·read 0회', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEV_TLS_CERT_PATH', FIXTURE);
    expect(readDevCertExpiry()).toBeNull();
    expect(seen.resolve).toEqual([]);
    expect(seen.fs).toEqual([]);
  });

  it('NODE_ENV=production, DEV_TLS_CERT_PATH 없음(기본 data/dev-certs 경로) → null, 경로 계산·파일 접근 0회', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DEV_TLS_CERT_PATH', undefined);
    expect(readDevCertExpiry()).toBeNull();
    expect(seen.resolve).toEqual([]);
    expect(seen.fs).toEqual([]);
  });

  it('대조: 같은 호출을 NODE_ENV=development 로 하면 읽는다(위 null 이 다른 이유가 아님 — 기록 장치가 실제 경로를 본다)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DEV_TLS_CERT_PATH', undefined);
    expect(readDevCertExpiry()?.validTo.toISOString()).toBe(FIXTURE_VALID_TO);
    expect(seen.resolve).toEqual(['data/dev-certs/localhost-cert.pem']);
    expect(seen.fs).toEqual([`statSync:${FIXTURE}`, `readFileSync:${FIXTURE}`]);
  });

  it('NODE_ENV=test(vitest 기본)도 운영이 아니므로 읽는다 — 운영 판정은 production 하나뿐', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(readDevCertExpiry()?.validTo.toISOString()).toBe(FIXTURE_VALID_TO);
    expect(seen.fs.length).toBe(2);
  });
});

describe('기본 env 식 — Next 운영 빌드의 상수 고정(시험 실행기는 재현하지 못하므로 소스로 확인)', () => {
  it('기본 env 는 `NODE_ENV: process.env.NODE_ENV` 를 따로 넘긴다(lib/server.ts getConfig 와 같은 방식), 운영 판정이 경로 계산보다 먼저', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    const src = readFileSync(path.join(here, 'dev-cert.ts'), 'utf8');
    const body = src.slice(src.indexOf('export function readDevCertExpiry'));
    expect(body).toMatch(/const env = opts\.env \?\? \{ \.\.\.process\.env, NODE_ENV: process\.env\.NODE_ENV \};/);
    const prodCheck = body.indexOf("if (env.NODE_ENV === 'production') return null;");
    expect(prodCheck).toBeGreaterThan(-1);
    expect(prodCheck).toBeLessThan(body.indexOf('devCertPath('));
    expect(prodCheck).toBeLessThan(body.indexOf('fs.stat('));
  });
});
