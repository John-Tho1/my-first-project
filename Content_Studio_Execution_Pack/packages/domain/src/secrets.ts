/**
 * T13(결정 D24): 서버 비밀 상자 — Node 표준 crypto 의 AES-256-GCM 만 쓴다(자체 암호 알고리즘 구현 없음, docs/02).
 *
 * - 마스터 키는 서버 환경변수에서만 읽는다(저장소·DB·백업·export 밖). 기본·개발용 키로 대신하지 않는다 — 없거나 잘못되면
 *   SecretsNotConfiguredError(503). 이 오류는 계정 연결(OAuth) 경로에서만 나고, 나머지 앱은 키 없이 그대로 동작한다.
 *     SECRETS_MASTER_KEY            base64, 디코딩하면 정확히 32바이트
 *     SECRETS_KEY_VERSION           1 ~ 9999 정수
 *     SECRETS_MASTER_KEY_PREVIOUS   (선택) 교체 직전 키 — 복호화·재암호화에만 쓴다
 *     SECRETS_KEY_VERSION_PREVIOUS  (선택) 이전 키의 버전(현재 버전과 달라야 함)
 * - 암호문 형식: `csk1:<key_version>:<iv b64url>:<tag b64url>:<ciphertext b64url>`(iv 12바이트, tag 16바이트).
 *   키 버전은 DB 열(key_version)에도 따로 저장하고 복호화 때 서로 같아야 한다.
 * - AAD = owner_id + channel_account_id + 용도(purpose). 다른 행·다른 용도로 옮긴 암호문은 복호화에 실패한다.
 * - 오류 메시지·extra 에는 환경변수 이름과 문제 종류만 넣는다. 키·평문·암호문은 넣지 않는다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from './errors';

export const SECRET_ENV_NAMES = {
  key: 'SECRETS_MASTER_KEY',
  version: 'SECRETS_KEY_VERSION',
  previousKey: 'SECRETS_MASTER_KEY_PREVIOUS',
  previousVersion: 'SECRETS_KEY_VERSION_PREVIOUS',
} as const;

export const SECRET_ENVELOPE_PREFIX = 'csk1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretKey {
  version: number;
  /** 32바이트. 로그·응답에 넣지 않는다. */
  key: Buffer;
}

export interface SecretKeyring {
  current: SecretKey;
  previous: SecretKey | null;
}

/** 암호문을 특정 행·용도에 묶는 값(AAD). */
export interface SecretAad {
  ownerId: string;
  channelAccountId: string;
  purpose: SecretPurpose;
  /** 같은 계정의 여러 상태 행을 구분(oauth_states 의 PKCE verifier) — 없으면 '' */
  scopeId?: string;
}

export type SecretPurpose = 'oauth_token' | 'pkce_verifier';

export class SecretsNotConfiguredError extends AppError {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(
      'service_unavailable',
      'secrets_not_configured',
      `서버 비밀 암호화 키가 설정되지 않아 계정을 연결할 수 없습니다(${problems.join(', ')}). 다른 기능은 그대로 쓸 수 있습니다.`,
      { missing: problems },
    );
    this.problems = problems;
  }
}

export type SecretDecryptProblem = 'malformed' | 'version_mismatch' | 'unknown_key_version' | 'auth_failed';

export class SecretDecryptError extends AppError {
  readonly problem: SecretDecryptProblem;
  constructor(problem: SecretDecryptProblem) {
    super('conflict', 'credential_unreadable', '저장된 연결 정보를 읽을 수 없습니다. 계정을 다시 연결하세요.', { problem });
    this.problem = problem;
  }
}

const VERSION_RE = /^\d{1,4}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseKey(raw: string | undefined, name: string, problems: string[]): Buffer | null {
  if (raw === undefined || raw.trim() === '') {
    problems.push(`${name} 없음`);
    return null;
  }
  const v = raw.trim();
  if (!B64_RE.test(v)) {
    problems.push(`${name} 형식 오류(base64)`);
    return null;
  }
  const buf = Buffer.from(v, 'base64');
  // 다시 인코딩한 값이 같아야 한다(잘린·남는 비트가 있는 입력 거부)
  if (buf.length !== KEY_BYTES || buf.toString('base64') !== v) {
    problems.push(`${name} 길이 오류(32바이트 필요)`);
    return null;
  }
  return buf;
}

function parseVersion(raw: string | undefined, name: string, problems: string[]): number | null {
  if (raw === undefined || raw.trim() === '') {
    problems.push(`${name} 없음`);
    return null;
  }
  const v = raw.trim();
  if (!VERSION_RE.test(v) || Number(v) < 1) {
    problems.push(`${name} 형식 오류(1~9999)`);
    return null;
  }
  return Number(v);
}

export type KeyringResult = { ok: true; keyring: SecretKeyring } | { ok: false; problems: string[] };

/** 환경변수에서 키 묶음을 읽는다. 값은 돌려주는 객체 밖으로 내보내지 않는다. */
export function readSecretKeyring(env: Record<string, string | undefined>): KeyringResult {
  const problems: string[] = [];
  const key = parseKey(env[SECRET_ENV_NAMES.key], SECRET_ENV_NAMES.key, problems);
  const version = parseVersion(env[SECRET_ENV_NAMES.version], SECRET_ENV_NAMES.version, problems);
  let previous: SecretKey | null = null;
  const prevKeyRaw = env[SECRET_ENV_NAMES.previousKey];
  const prevVerRaw = env[SECRET_ENV_NAMES.previousVersion];
  const hasPrev = (prevKeyRaw ?? '').trim() !== '' || (prevVerRaw ?? '').trim() !== '';
  if (hasPrev) {
    const pk = parseKey(prevKeyRaw, SECRET_ENV_NAMES.previousKey, problems);
    const pv = parseVersion(prevVerRaw, SECRET_ENV_NAMES.previousVersion, problems);
    if (pk && pv !== null) previous = { key: pk, version: pv };
  }
  if (key && version !== null && previous) {
    if (previous.version === version) problems.push(`${SECRET_ENV_NAMES.previousVersion} 는 ${SECRET_ENV_NAMES.version} 와 달라야 합니다`);
    if (previous.key.equals(key)) problems.push(`${SECRET_ENV_NAMES.previousKey} 는 현재 키와 달라야 합니다`);
  }
  if (problems.length || !key || version === null) return { ok: false, problems };
  return { ok: true, keyring: { current: { key, version }, previous } };
}

/** 키 묶음을 읽고, 없거나 잘못되면 SecretsNotConfiguredError. 기본 키로 대신하지 않는다. */
export function requireSecretKeyring(env: Record<string, string | undefined>): SecretKeyring {
  const r = readSecretKeyring(env);
  if (!r.ok) throw new SecretsNotConfiguredError(r.problems);
  return r.keyring;
}

/** 화면 표시용: 설정 여부와 문제 이름만(값 없음). */
export function secretsReadiness(env: Record<string, string | undefined>): { configured: boolean; problems: string[]; currentVersion: number | null; hasPrevious: boolean } {
  const r = readSecretKeyring(env);
  return r.ok
    ? { configured: true, problems: [], currentVersion: r.keyring.current.version, hasPrevious: r.keyring.previous !== null }
    : { configured: false, problems: r.problems, currentVersion: null, hasPrevious: false };
}

function aadBytes(aad: SecretAad): Buffer {
  return Buffer.from(
    `content-studio/secret/v1\nowner=${aad.ownerId}\naccount=${aad.channelAccountId}\npurpose=${aad.purpose}\nscope=${aad.scopeId ?? ''}`,
    'utf8',
  );
}

const b64u = (b: Buffer) => b.toString('base64url');

export interface SealedSecret {
  ciphertext: string;
  keyVersion: number;
}

/** 현재 키로 암호화한다(iv 는 매번 새 난수). */
export function sealSecret(keyring: SecretKeyring, plaintext: string, aad: SecretAad): SealedSecret {
  const { key, version } = keyring.current;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadBytes(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: `${SECRET_ENVELOPE_PREFIX}:${version}:${b64u(iv)}:${b64u(tag)}:${b64u(ct)}`, keyVersion: version };
}

interface Envelope {
  version: number;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

const B64U_RE = /^[A-Za-z0-9_-]*$/;

function parseEnvelope(ciphertext: string): Envelope {
  const parts = ciphertext.split(':');
  if (parts.length !== 5 || parts[0] !== SECRET_ENVELOPE_PREFIX || !VERSION_RE.test(parts[1]!)) throw new SecretDecryptError('malformed');
  if (!parts.slice(2).every((p) => B64U_RE.test(p))) throw new SecretDecryptError('malformed');
  const iv = Buffer.from(parts[2]!, 'base64url');
  const tag = Buffer.from(parts[3]!, 'base64url');
  const ct = Buffer.from(parts[4]!, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretDecryptError('malformed');
  return { version: Number(parts[1]), iv, tag, ct };
}

/** 암호문의 키 버전(형식이 틀리면 SecretDecryptError). */
export function envelopeKeyVersion(ciphertext: string): number {
  return parseEnvelope(ciphertext).version;
}

/**
 * 복호화. expectedKeyVersion(DB 의 key_version 열)과 암호문 안의 버전이 같아야 하고, 그 버전의 키가 키 묶음(현재·이전)에 있어야 한다.
 * GCM 태그·AAD 가 맞지 않으면 auth_failed. 실패 이유는 문제 종류만 알린다.
 */
export function openSecret(keyring: SecretKeyring, ciphertext: string, expectedKeyVersion: number, aad: SecretAad): string {
  const env = parseEnvelope(ciphertext);
  if (env.version !== expectedKeyVersion) throw new SecretDecryptError('version_mismatch');
  const k = keyring.current.version === env.version ? keyring.current : keyring.previous?.version === env.version ? keyring.previous : null;
  if (!k) throw new SecretDecryptError('unknown_key_version');
  try {
    const decipher = createDecipheriv('aes-256-gcm', k.key, env.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadBytes(aad));
    decipher.setAuthTag(env.tag);
    return Buffer.concat([decipher.update(env.ct), decipher.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError('auth_failed');
  }
}

/** 키 교체: 이전(또는 현재) 키로 연 뒤 현재 키로 다시 봉인한다. 이미 현재 버전이면 null(바꿀 것 없음). */
export function resealSecret(keyring: SecretKeyring, ciphertext: string, keyVersion: number, aad: SecretAad): SealedSecret | null {
  if (keyVersion === keyring.current.version && envelopeKeyVersion(ciphertext) === keyVersion) return null;
  const plain = openSecret(keyring, ciphertext, keyVersion, aad);
  return sealSecret(keyring, plain, aad);
}
