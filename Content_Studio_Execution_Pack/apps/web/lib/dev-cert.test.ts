/**
 * EXPIRY-1(결정 D39): 로컬 인증서 만료 읽기(서버 전용) — 시험 전용 인증서로만 시험한다(실제 data/dev-certs 는 읽지 않는다).
 * - 저장소의 tests/fixtures/dev-cert/TEST-ONLY-throwaway-cert.pem: 공개 인증서만(개인 키는 만들 때 버림), 서버는 이 파일을 쓰지 않는다.
 * - openssl 이 있으면 임시 폴더에 진짜로 키·인증서를 만들어 한 번 더 확인한다(없으면 그 한 건만 건너뜀 — 위 고정 인증서 시험은 항상 실행).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { DEV_CERT_MAX_BYTES, DEV_TLS_CERT_DEFAULT_PATH, devCertPath, readDevCertExpiry, type DevCertFs } from './dev-cert';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_REL = 'tests/fixtures/dev-cert/TEST-ONLY-throwaway-cert.pem';
const FIXTURE = path.resolve(here, '../../..', FIXTURE_REL);
/** 고정 인증서의 notAfter(openssl x509 -enddate: "Oct 16 13:17:51 2036 GMT") */
const FIXTURE_VALID_TO = '2036-10-16T13:17:51.000Z';
const DEV = { NODE_ENV: 'development' } as const;

const tmp = mkdtempSync(path.join(tmpdir(), 'cs-dev-cert-unit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** 진짜 fs 를 감싼 spy — 어떤 경로를 열었는지 본다 */
function spyFs() {
  return {
    stat: vi.fn((p: string) => statSync(p)),
    readFile: vi.fn((p: string) => readFileSync(p)),
  };
}

const opensslOk = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0;

describe('readDevCertExpiry — 시험 전용 인증서', () => {
  it('고정 인증서(앞에 설명 글이 있는 PEM) → validTo 해석', () => {
    expect(readFileSync(FIXTURE, 'utf8')).not.toContain('PRIVATE KEY');
    const r = readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: FIXTURE } });
    expect(r).not.toBeNull();
    expect(r!.validTo.toISOString()).toBe(FIXTURE_VALID_TO);
  });

  it('DEV_TLS_CERT_PATH 상대 경로는 워크스페이스 루트 기준(다른 데이터 경로와 같음)', () => {
    const r = readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: FIXTURE_REL } });
    expect(r?.validTo.toISOString()).toBe(FIXTURE_VALID_TO);
  });

  it.skipIf(!opensslOk)('openssl 로 임시 폴더에 만든 EC P-256 자체 서명 인증서(10일) → validTo = openssl notAfter, 키 파일은 읽지 않음', () => {
    const dir = path.join(tmp, 'gen');
    mkdirSync(dir);
    const key = path.join(dir, 'localhost-key.pem');
    const cert = path.join(dir, 'localhost-cert.pem');
    const cnf = path.join(dir, 'req.cnf');
    writeFileSync(cnf, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
    expect(spawnSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]).status).toBe(0);
    expect(spawnSync('openssl', ['req', '-new', '-x509', '-key', key, '-out', cert, '-days', '10', '-config', cnf, '-extensions', 'v3']).status).toBe(0);
    const end = spawnSync('openssl', ['x509', '-in', cert, '-noout', '-enddate'], { encoding: 'utf8' }).stdout.trim().replace(/^notAfter=/, '');
    const fs = spyFs();
    const r = readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: cert }, fs });
    expect(r!.validTo.getTime()).toBe(new Date(end).getTime());
    expect(Math.abs(r!.validTo.getTime() - (Date.now() + 10 * 86_400_000))).toBeLessThan(5 * 60_000);
    expect(fs.readFile.mock.calls.map((c) => c[0])).toEqual([cert]);
  });

  it('파일 없음 → null(던지지 않음)', () => {
    expect(readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: path.join(tmp, 'missing.pem') } })).toBeNull();
  });

  it('인증서가 아닌 파일·빈 파일·폴더 → null', () => {
    const garbage = path.join(tmp, 'garbage.pem');
    writeFileSync(garbage, '-----BEGIN CERTIFICATE-----\nnot base64 !!!\n-----END CERTIFICATE-----\n');
    const text = path.join(tmp, 'text.pem');
    writeFileSync(text, 'hello');
    const empty = path.join(tmp, 'empty.pem');
    writeFileSync(empty, '');
    for (const p of [garbage, text, empty, tmp]) expect(readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: p } })).toBeNull();
  });

  it(`너무 큰 파일(> ${DEV_CERT_MAX_BYTES} 바이트) → 읽지 않고 null`, () => {
    const big = path.join(tmp, 'big.pem');
    writeFileSync(big, Buffer.concat([readFileSync(FIXTURE), Buffer.alloc(DEV_CERT_MAX_BYTES)]));
    const fs = spyFs();
    expect(readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: big }, fs })).toBeNull();
    expect(fs.stat).toHaveBeenCalledTimes(1);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('운영 빌드(NODE_ENV=production) → 파일을 열지 않고 null(경로가 맞는 인증서여도)', () => {
    const fs = spyFs();
    const resolve = vi.fn((p: string) => p);
    expect(readDevCertExpiry({ env: { NODE_ENV: 'production', DEV_TLS_CERT_PATH: FIXTURE }, fs, resolve })).toBeNull();
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    // 같은 조건에서 개발 모드면 읽는다(위 null 이 다른 이유가 아님)
    expect(readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: FIXTURE }, fs, resolve })?.validTo.toISOString()).toBe(FIXTURE_VALID_TO);
  });

  it('fs·경로 해석이 던져도 null, 로그를 쓰지 않는다', () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const throwing: DevCertFs = {
      stat: () => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${FIXTURE}'`), { code: 'EACCES' });
      },
      readFile: () => {
        throw new Error('unreachable');
      },
    };
    expect(readDevCertExpiry({ env: { ...DEV, DEV_TLS_CERT_PATH: FIXTURE }, fs: throwing })).toBeNull();
    expect(
      readDevCertExpiry({
        env: DEV,
        resolve: () => {
          throw new Error('워크스페이스 루트 없음');
        },
      }),
    ).toBeNull();
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('devCertPath — 기본 경로(실제 파일은 열지 않음)', () => {
  it('미설정·빈 값 → data/dev-certs/localhost-cert.pem, 앞뒤 공백은 뗀다', () => {
    const id = (p: string) => p;
    expect(DEV_TLS_CERT_DEFAULT_PATH).toBe('data/dev-certs/localhost-cert.pem');
    expect(devCertPath({}, id)).toBe('data/dev-certs/localhost-cert.pem');
    expect(devCertPath({ DEV_TLS_CERT_PATH: '   ' }, id)).toBe('data/dev-certs/localhost-cert.pem');
    expect(devCertPath({ DEV_TLS_CERT_PATH: ' certs/x.pem ' }, id)).toBe('certs/x.pem');
  });

  it('기본 경로로 읽을 때 그 경로만 확인한다(가짜 fs — 실제 data/ 를 열지 않음)', () => {
    const fs = {
      stat: vi.fn((): { isFile(): boolean; size: number } => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
      readFile: vi.fn((): Buffer => Buffer.alloc(0)),
    };
    expect(readDevCertExpiry({ env: DEV, fs, resolve: (p) => `/fake-root/${p}` })).toBeNull();
    expect(fs.stat.mock.calls).toEqual([['/fake-root/data/dev-certs/localhost-cert.pem']]);
    expect(fs.readFile).not.toHaveBeenCalled();
  });

  it('서버 코드는 시험 전용 인증서를 가리키지 않는다', () => {
    const src = readFileSync(path.join(here, 'dev-cert.ts'), 'utf8');
    expect(src).not.toContain('fixtures');
    expect(src).not.toContain('TEST-ONLY');
  });
});
