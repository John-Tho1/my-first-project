/** T13(D24): 비밀 상자(AES-256-GCM) — 키 읽기·봉인·변조·AAD 바꿔치기·키 버전·교체. 키는 시험이 만든 난수(실제 키 아님). */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  envelopeKeyVersion,
  openSecret,
  readSecretKeyring,
  requireSecretKeyring,
  resealSecret,
  sealSecret,
  SecretDecryptError,
  secretsReadiness,
  SecretsNotConfiguredError,
  type SecretAad,
} from './secrets';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');
const OWNER = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const ACC2 = '33333333-3333-4333-8333-333333333333';
const aad: SecretAad = { ownerId: OWNER, channelAccountId: ACC, purpose: 'oauth_token' };
const ring1 = requireSecretKeyring({ SECRETS_MASTER_KEY: k1, SECRETS_KEY_VERSION: '1' });

function problem(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof SecretDecryptError) return e.problem;
    throw e;
  }
  return 'none';
}

describe('키 읽기 — 기본·개발용 키로 대신하지 않는다', () => {
  it('없으면 SecretsNotConfiguredError(503) — 메시지에는 변수 이름만', () => {
    expect(() => requireSecretKeyring({})).toThrow(SecretsNotConfiguredError);
    try {
      requireSecretKeyring({ SECRETS_MASTER_KEY: 'not-base64!!', SECRETS_KEY_VERSION: '1' });
    } catch (e) {
      expect(e).toBeInstanceOf(SecretsNotConfiguredError);
      expect((e as SecretsNotConfiguredError).kind).toBe('service_unavailable');
      expect((e as Error).message).not.toContain('not-base64');
    }
  });
  it('형식 검사: base64 아님·32바이트 아님·버전 없음/0/문자 → 거부, 이전 키 버전 중복·같은 키 거부', () => {
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: randomBytes(16).toString('base64'), SECRETS_KEY_VERSION: '1' }).ok).toBe(false);
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: k1 }).ok).toBe(false);
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: k1, SECRETS_KEY_VERSION: '0' }).ok).toBe(false);
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: k1, SECRETS_KEY_VERSION: 'v1' }).ok).toBe(false);
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: k1, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: k2 }).ok).toBe(false);
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: k1, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: k2, SECRETS_KEY_VERSION_PREVIOUS: '2' }).ok).toBe(false);
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: k1, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: k1, SECRETS_KEY_VERSION_PREVIOUS: '1' }).ok).toBe(false);
    const ok = readSecretKeyring({ SECRETS_MASTER_KEY: k2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: k1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
    expect(ok.ok).toBe(true);
    const r = secretsReadiness({ SECRETS_MASTER_KEY: k2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: k1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
    expect(r).toEqual({ configured: true, problems: [], currentVersion: 2, hasPrevious: true });
    expect(JSON.stringify(secretsReadiness({ SECRETS_MASTER_KEY: 'x' }))).not.toContain(k1);
  });
});

describe('봉인·열기', () => {
  it('왕복, 같은 평문도 매번 다른 암호문(iv 난수), 형식 csk1:<버전>:…, 평문이 암호문에 보이지 않음', () => {
    const a = sealSecret(ring1, 'mockthr_at_SECRET', aad);
    const b = sealSecret(ring1, 'mockthr_at_SECRET', aad);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.ciphertext.startsWith('csk1:1:')).toBe(true);
    expect(a.keyVersion).toBe(1);
    expect(a.ciphertext).not.toContain('SECRET');
    expect(envelopeKeyVersion(a.ciphertext)).toBe(1);
    expect(openSecret(ring1, a.ciphertext, 1, aad)).toBe('mockthr_at_SECRET');
  });

  it('변조: 암호문·태그·iv 한 글자 바꾸면 auth_failed, 형식 깨짐은 malformed', () => {
    const { ciphertext } = sealSecret(ring1, 'token-value', aad);
    const parts = ciphertext.split(':');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const i of [2, 3, 4]) {
      const p = [...parts];
      p[i] = flip(p[i]!);
      const r = problem(() => openSecret(ring1, p.join(':'), 1, aad));
      expect(['auth_failed', 'malformed'], `part ${i}`).toContain(r);
    }
    const ct = [...parts];
    ct[4] = flip(ct[4]!);
    expect(problem(() => openSecret(ring1, ct.join(':'), 1, aad))).toBe('auth_failed');
    const tag = [...parts];
    tag[3] = flip(tag[3]!);
    expect(problem(() => openSecret(ring1, tag.join(':'), 1, aad))).toBe('auth_failed');
    expect(problem(() => openSecret(ring1, 'plaintext-token', 1, aad))).toBe('malformed');
    expect(problem(() => openSecret(ring1, parts.slice(0, 4).join(':'), 1, aad))).toBe('malformed');
  });

  it('AAD 바꿔치기: 다른 계정·다른 owner·다른 용도·다른 요청 행으로 옮긴 암호문은 열리지 않는다', () => {
    const { ciphertext } = sealSecret(ring1, 'token-value', aad);
    expect(problem(() => openSecret(ring1, ciphertext, 1, { ...aad, channelAccountId: ACC2 }))).toBe('auth_failed');
    expect(problem(() => openSecret(ring1, ciphertext, 1, { ...aad, ownerId: ACC2 }))).toBe('auth_failed');
    expect(problem(() => openSecret(ring1, ciphertext, 1, { ...aad, purpose: 'pkce_verifier' }))).toBe('auth_failed');
    const v = sealSecret(ring1, 'verifier', { ...aad, purpose: 'pkce_verifier', scopeId: 'a' });
    expect(problem(() => openSecret(ring1, v.ciphertext, 1, { ...aad, purpose: 'pkce_verifier', scopeId: 'b' }))).toBe('auth_failed');
  });

  it('키 버전: 열(key_version)과 암호문 버전이 다르면 version_mismatch, 키 묶음에 없는 버전은 unknown_key_version, 다른 키는 auth_failed', () => {
    const { ciphertext } = sealSecret(ring1, 'token-value', aad);
    expect(problem(() => openSecret(ring1, ciphertext, 2, aad))).toBe('version_mismatch');
    const ring2 = requireSecretKeyring({ SECRETS_MASTER_KEY: k2, SECRETS_KEY_VERSION: '2' });
    expect(problem(() => openSecret(ring2, ciphertext, 1, aad))).toBe('unknown_key_version');
    // 같은 버전 번호인데 키가 다름(잘못된 키 주입)
    const wrong = requireSecretKeyring({ SECRETS_MASTER_KEY: k2, SECRETS_KEY_VERSION: '1' });
    expect(problem(() => openSecret(wrong, ciphertext, 1, aad))).toBe('auth_failed');
  });
});

describe('FIX-T13 Q6 — 비정규 base64url 거부', () => {
  it('같은 바이트로 디코딩되는 다른 표기(남는 비트)는 malformed', () => {
    const { ciphertext } = sealSecret(ring1, 'token-value', aad);
    const parts = ciphertext.split(':');
    const tag = parts[3]!;
    const canonical = Buffer.from(tag, 'base64url');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alt = [...alphabet].map((c) => tag.slice(0, -1) + c).find((t) => t !== tag && Buffer.from(t, 'base64url').equals(canonical))!;
    expect(alt).toBeDefined();
    const p = [...parts];
    p[3] = alt;
    expect(problem(() => openSecret(ring1, p.join(':'), 1, aad))).toBe('malformed');
    expect(openSecret(ring1, ciphertext, 1, aad)).toBe('token-value');
  });
});

describe('키 교체(rotation)', () => {
  it('새 키 + 이전 키: 옛 암호문을 열고 새 키로 다시 봉인, 이전 키를 빼도 새 암호문은 열림, 현재 버전이면 null', () => {
    const old = sealSecret(ring1, 'rotate-me', aad);
    const rotating = requireSecretKeyring({ SECRETS_MASTER_KEY: k2, SECRETS_KEY_VERSION: '2', SECRETS_MASTER_KEY_PREVIOUS: k1, SECRETS_KEY_VERSION_PREVIOUS: '1' });
    expect(openSecret(rotating, old.ciphertext, 1, aad)).toBe('rotate-me');
    const re = resealSecret(rotating, old.ciphertext, 1, aad)!;
    expect(re.keyVersion).toBe(2);
    expect(envelopeKeyVersion(re.ciphertext)).toBe(2);
    const onlyNew = requireSecretKeyring({ SECRETS_MASTER_KEY: k2, SECRETS_KEY_VERSION: '2' });
    expect(openSecret(onlyNew, re.ciphertext, 2, aad)).toBe('rotate-me');
    expect(problem(() => openSecret(onlyNew, old.ciphertext, 1, aad))).toBe('unknown_key_version');
    expect(resealSecret(onlyNew, re.ciphertext, 2, aad)).toBeNull();
  });
});
