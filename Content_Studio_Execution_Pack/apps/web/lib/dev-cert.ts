/**
 * EXPIRY-1(결정 D39) 서버 전용: 로컬 개발용 HTTPS 인증서(자체 서명, `data/dev-certs`, gitignore)의 **만료 시각만** 읽는다.
 * - 운영 빌드(NODE_ENV=production)에서는 파일을 열지 않고 null(경고는 개발 모드만).
 * - 경로: DEV_TLS_CERT_PATH(선택, 비밀 아님 — 개발 전용이라 설정 스키마 밖, MOCK_CHANNEL_SCENARIO 처럼 환경에서 바로 읽음) 또는
 *   기본 `data/dev-certs/localhost-cert.pem`. 상대 경로는 다른 데이터 경로처럼 워크스페이스 루트 기준(resolveFromRoot).
 * - 없음·읽을 수 없음·인증서가 아님·너무 큼 → null(알림 없음). 절대 던지지 않고, 파일 내용·경로를 로그에 남기지 않는다(로그 자체를 쓰지 않음).
 * - 개인 키 파일은 읽지 않는다. 인증서 파일에 키가 함께 들어 있어도 X509Certificate 는 인증서만 해석하고, 돌려주는 값은 만료 시각뿐이다.
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolveFromRoot } from '@cs/db';
import type { DevCertExpiryInput } from '@cs/domain';

export const DEV_TLS_CERT_DEFAULT_PATH = 'data/dev-certs/localhost-cert.pem';
/** PEM 인증서 한 장은 수 KB — 다른 큰 파일을 가리켜도 통째로 읽지 않게 상한을 둔다. */
export const DEV_CERT_MAX_BYTES = 64 * 1024;

/** 시험에서 바꿔 끼우는 파일 접근(기본 node:fs). */
export interface DevCertFs {
  stat: (p: string) => { isFile(): boolean; size: number };
  readFile: (p: string) => Buffer;
}

const nodeFs: DevCertFs = {
  stat: (p) => statSync(/*turbopackIgnore: true*/ p),
  readFile: (p) => readFileSync(/*turbopackIgnore: true*/ p),
};

export interface ReadDevCertOptions {
  /**
   * 기본: `{ ...process.env, NODE_ENV: process.env.NODE_ENV }` — NODE_ENV 를 식 그대로 따로 넘겨 Next 운영 빌드가 상수(production)로 고정하게 한다
   * (lib/server.ts getConfig 와 같은 방식).
   */
  env?: Record<string, string | undefined>;
  fs?: DevCertFs;
  resolve?: (p: string) => string;
}

/** 읽을 인증서 경로(해석 뒤). */
export function devCertPath(env: Record<string, string | undefined>, resolve: (p: string) => string = resolveFromRoot): string {
  const raw = env.DEV_TLS_CERT_PATH?.trim();
  return resolve(raw ? raw : DEV_TLS_CERT_DEFAULT_PATH);
}

/** 로컬 인증서 만료 시각. 운영 빌드·파일 없음·해석 실패면 null. */
export function readDevCertExpiry(opts: ReadDevCertOptions = {}): DevCertExpiryInput | null {
  const env = opts.env ?? { ...process.env, NODE_ENV: process.env.NODE_ENV };
  if (env.NODE_ENV === 'production') return null;
  try {
    const fs = opts.fs ?? nodeFs;
    const p = devCertPath(env, opts.resolve);
    const st = fs.stat(p);
    if (!st.isFile() || st.size <= 0 || st.size > DEV_CERT_MAX_BYTES) return null;
    const validTo = new Date(new X509Certificate(fs.readFile(p)).validTo);
    return Number.isNaN(validTo.getTime()) ? null : { validTo };
  } catch {
    return null;
  }
}
