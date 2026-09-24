import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDirLock, DbLockedError, LOCK_FILE } from './lock';

describe('acquireDirLock (PGlite 단일 프로세스 강제)', () => {
  const dirs: string[] = [];
  const mk = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cs-lock-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('잠금을 만들고 해제하면 파일이 사라진다', () => {
    const d = mk();
    const release = acquireDirLock(d);
    expect(readFileSync(path.join(d, LOCK_FILE), 'utf8')).toBe(String(process.pid));
    release();
    expect(existsSync(path.join(d, LOCK_FILE))).toBe(false);
  });

  it('살아 있는 다른 프로세스가 잡고 있으면 DbLockedError', () => {
    const d = mk();
    writeFileSync(path.join(d, LOCK_FILE), String(process.ppid));
    expect(() => acquireDirLock(d)).toThrow(DbLockedError);
    expect(() => acquireDirLock(d)).toThrow(/개발 서버/);
  });

  it('죽은 PID 의 잠금은 회수한다', () => {
    const d = mk();
    writeFileSync(path.join(d, LOCK_FILE), '2147483646');
    const release = acquireDirLock(d);
    expect(readFileSync(path.join(d, LOCK_FILE), 'utf8')).toBe(String(process.pid));
    release();
  });
});
