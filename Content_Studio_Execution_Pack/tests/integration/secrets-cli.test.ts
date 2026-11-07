/**
 * FIX2-T13(Codex review-FIX-T13 Q7·D25-5): pnpm secrets:rotate 본체(runSecretsRotateCli) — 오류 출력은 종류·코드만, 키 없음·DB 잠금·빈 DB.
 * oauth.test.ts 와 분리(그 파일은 PGlite 를 여러 개 열어 한 워커의 메모리가 빠듯하다).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb, DbLockedError, describeErrorSafely, runSecretsRotateCli, type DbHandle } from '@cs/db';

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

describe('FIX3 Codex review-FIX2-T13 P2·Q7 — DB 닫기 실패·민감해 보이는 오류 이름·코드', () => {
  it('회전(적용)이 성공한 뒤 close() 가 거부되면 exit 1, 출력은 허용된 종류·코드뿐(키·토큰·암호문·메시지 본문 없음)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    let closed = 0;
    const code = await runSecretsRotateCli({
      argv: ['--confirm'],
      env: { SECRETS_MASTER_KEY: KEY1, SECRETS_KEY_VERSION: '1' },
      openDb: async (): Promise<DbHandle> => {
        const h = await createTestDb();
        return {
          ...h,
          close: async () => {
            closed++;
            await h.close();
            throw Object.assign(new Error(`close failed csk1:1:AAAA mockthr_at_leak ${KEY1}`), { code: '57P01' });
          },
        };
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(closed).toBe(1);
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('적용함'); // 회전 자체는 끝났다
    const text = err.join('\n');
    expect(text).toContain('DB 를 닫지 못했습니다');
    expect(text).toContain('Error(57P01)');
    for (const v of ['csk1', 'mockthr_at_leak', KEY1, 'close failed']) expect(text.includes(v), v).toBe(false);
  });

  it('미리보기 성공 뒤 close() 거부도 exit 1(이전에는 0)', async () => {
    const err: string[] = [];
    const code = await runSecretsRotateCli({
      argv: [],
      env: { SECRETS_MASTER_KEY: KEY1, SECRETS_KEY_VERSION: '1' },
      openDb: async (): Promise<DbHandle> => {
        const h = await createTestDb();
        return {
          ...h,
          close: async () => {
            await h.close();
            throw new TypeError('x');
          },
        };
      },
      out: () => undefined,
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('TypeError');
  });

  it('토큰처럼 생긴 오류 name·code(name mockthr_at_*, code csk1:*·소문자·41자) → 일반 이름 Error 만, 코드 없음', async () => {
    const tokenish = Object.assign(new Error('boom mockthr_at_abc'), { code: 'csk1:xyz' });
    tokenish.name = 'mockthr_at_abc';
    expect(describeErrorSafely(tokenish)).toBe('Error');
    const lower = Object.assign(new Error('x'), { code: 'mockthr_at_abcdef' });
    lower.name = 'csk1:1:AAAA';
    expect(describeErrorSafely(lower)).toBe('Error');
    expect(describeErrorSafely(Object.assign(new Error('x'), { code: 'A'.repeat(41) }))).toBe('Error');
    expect(describeErrorSafely(Object.assign(new Error('x'), { code: 12345 }))).toBe('Error');
    expect(describeErrorSafely({ name: 'mockthr_at_abc', code: 'csk1:xyz' })).toBe('Error');
    expect(describeErrorSafely('mockthr_at_abc')).toBe('Error');
    expect(describeErrorSafely(undefined)).toBe('Error');
    // 허용된 이름·모양이 맞는 코드는 그대로(진단용)
    expect(describeErrorSafely(Object.assign(new RangeError('x'), { code: 'ERR_OUT_OF_RANGE' }))).toBe('RangeError(ERR_OUT_OF_RANGE)');
    expect(describeErrorSafely(new DbLockedError(1))).toBe('DbLockedError');

    // CLI 전체 경로: openDb 가 그런 오류를 던져도 출력에 값이 없다
    const err: string[] = [];
    const code = await runSecretsRotateCli({
      argv: [],
      env: { SECRETS_MASTER_KEY: KEY1, SECRETS_KEY_VERSION: '1' },
      openDb: async () => {
        throw tokenish;
      },
      out: () => undefined,
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    const text = err.join('\n');
    expect(text).toContain('오류 종류: Error)');
    for (const v of ['mockthr_at_abc', 'csk1', 'xyz', 'boom']) expect(text.includes(v), v).toBe(false);
  });
});
