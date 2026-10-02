/**
 * FIX2-T13(Codex review-FIX-T13 Q7·D25-5): pnpm secrets:rotate 본체(runSecretsRotateCli) — 오류 출력은 종류·코드만, 키 없음·DB 잠금·빈 DB.
 * oauth.test.ts 와 분리(그 파일은 PGlite 를 여러 개 열어 한 워커의 메모리가 빠듯하다).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb, DbLockedError, runSecretsRotateCli } from '@cs/db';

const KEY1 = randomBytes(32).toString('base64');

describe('FIX2 Q7·D25-5 — secrets:rotate 본체', () => {
  it('예상하지 못한 DB 오류는 종류·코드만 출력(메시지 본문의 값 없음), exit 1', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSecretsRotateCli({
      argv: [],
      env: { SECRETS_MASTER_KEY: KEY1, SECRETS_KEY_VERSION: '1', DATABASE_URL: 'memory://' },
      openDb: async () => {
        throw Object.assign(new Error('connection failed: csk1:1:SECRET-ish value mockthr_at_leak'), { code: '28P01' });
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('Error(28P01)');
    expect(err.join('\n')).not.toContain('csk1');
    expect(err.join('\n')).not.toContain('mockthr_at_leak');
    expect(err.join('\n')).not.toContain(KEY1);
  });

  it('키 없음 → exit 1(변수 이름만), DB 잠금 → 잠금 안내 exit 1, 빈 메모리 DB → 미리보기 exit 0', async () => {
    const err: string[] = [];
    expect(await runSecretsRotateCli({ argv: [], env: {}, openDb: async () => createTestDb(), out: () => undefined, err: (l) => err.push(l) })).toBe(1);
    expect(err[0]).toContain('SECRETS_MASTER_KEY');
    const lockedErr: string[] = [];
    expect(
      await runSecretsRotateCli({
        argv: [],
        env: { SECRETS_MASTER_KEY: KEY1, SECRETS_KEY_VERSION: '1' },
        openDb: async () => {
          throw new DbLockedError(999999);
        },
        out: () => undefined,
        err: (l) => lockedErr.push(l),
      }),
    ).toBe(1);
    expect(lockedErr[0]).toContain('PGlite');
    const out: string[] = [];
    expect(await runSecretsRotateCli({ argv: [], env: { SECRETS_MASTER_KEY: KEY1, SECRETS_KEY_VERSION: '1' }, openDb: async () => createTestDb(), out: (l) => out.push(l), err: () => undefined })).toBe(0);
    expect(out.join('\n')).toContain('미리보기');
  });
});
