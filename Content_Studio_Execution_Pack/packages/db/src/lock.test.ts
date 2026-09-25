import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDirLock, DbLockedError, LOCK_FILE } from './lock';

const TOKEN_RE = new RegExp(`^${process.pid}:[0-9a-f-]{36}$`);
const DEAD_PID = '2147483646';

describe('acquireDirLock (PGlite 단일 프로세스 강제)', () => {
  const dirs: string[] = [];
  const mk = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cs-lock-'));
    dirs.push(d);
    return d;
  };
  const lockFile = (d: string) => path.join(d, LOCK_FILE);
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('잠금(<pid>:<nonce>)을 만들고 해제하면 파일이 사라진다', () => {
    const d = mk();
    const release = acquireDirLock(d);
    expect(readFileSync(lockFile(d), 'utf8')).toMatch(TOKEN_RE);
    release();
    expect(existsSync(lockFile(d))).toBe(false);
  });

  it('살아 있는 다른 프로세스가 잡고 있으면 DbLockedError', () => {
    const d = mk();
    writeFileSync(lockFile(d), `${process.ppid}:00000000-0000-4000-8000-000000000000`);
    expect(() => acquireDirLock(d)).toThrow(DbLockedError);
    expect(() => acquireDirLock(d)).toThrow(/개발 서버/);
  });

  it('같은 프로세스가 같은 디렉터리를 두 번 열면 DbLockedError(기존 잠금을 회수하지 않음)', () => {
    const d = mk();
    const release = acquireDirLock(d);
    const token = readFileSync(lockFile(d), 'utf8');
    expect(() => acquireDirLock(d)).toThrow(/이 프로세스\(PID/);
    expect(readFileSync(lockFile(d), 'utf8')).toBe(token); // 첫 잠금 그대로
    release();
    // 해제한 뒤에는 다시 열 수 있다
    acquireDirLock(d)();
  });

  it('죽은 PID 의 잠금은 회수한다(구버전 pid 전용 형식 포함)', () => {
    for (const content of [DEAD_PID, `${DEAD_PID}:11111111-1111-4111-8111-111111111111`]) {
      const d = mk();
      writeFileSync(lockFile(d), content);
      const release = acquireDirLock(d);
      expect(readFileSync(lockFile(d), 'utf8')).toMatch(TOKEN_RE);
      release();
      expect(existsSync(lockFile(d))).toBe(false);
    }
  });

  it('비어 있거나 깨진 잠금은 오래됐을 때만 회수한다', () => {
    const d = mk();
    writeFileSync(lockFile(d), '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockFile(d), old, old);
    const release = acquireDirLock(d);
    expect(readFileSync(lockFile(d), 'utf8')).toMatch(TOKEN_RE);
    release();

    const fresh = mk();
    writeFileSync(lockFile(fresh), 'garbage'); // 방금 만들어진(내용을 아직 못 읽은) 파일로 취급 → 재시도 후 포기
    expect(() => acquireDirLock(fresh)).toThrow(/재시도 초과/);
    expect(readFileSync(lockFile(fresh), 'utf8')).toBe('garbage');
  });

  it('해제는 자기 nonce 의 잠금만 지운다', () => {
    const d = mk();
    const release = acquireDirLock(d);
    const foreign = `${DEAD_PID}:22222222-2222-4222-8222-222222222222`;
    writeFileSync(lockFile(d), foreign); // 다른 프로세스가 (부당하게) 덮어쓴 상황을 흉내
    release();
    expect(readFileSync(lockFile(d), 'utf8')).toBe(foreign);
  });

  it('죽은 잠금을 여러 프로세스가 동시에 회수해도 한 프로세스만 잠금을 얻는다', { timeout: 120_000 }, async () => {
    const d = mk();
    writeFileSync(lockFile(d), DEAD_PID);
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const child = path.join(root, 'tests/helpers/lock-race-child.ts');
    const N = 6;
    // 자식은 ready-<pid> 를 만들고 go 파일을 기다린다 → 모두 준비된 뒤 동시에 출발시켜 회수 경합을 실제로 겹치게 한다.
    const readyCount = () => readdirSync(d).filter((f) => f.startsWith('ready-')).length;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        new Promise<string>((resolve, reject) => {
          const c = spawn(process.execPath, ['--import', 'tsx', child, d, '12000'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          c.stdout.on('data', (b) => (out += b));
          c.stderr.on('data', (b) => (err += b));
          c.on('error', reject);
          c.on('exit', () => resolve(out.trim() || `EXIT ${err.trim()}`));
        }),
      ).concat(
        (async () => {
          const until = Date.now() + 30_000;
          while (readyCount() < N) {
            if (Date.now() > until) throw new Error('자식 프로세스가 준비되지 않았습니다');
            await new Promise((r) => setTimeout(r, 20));
          }
          writeFileSync(path.join(d, 'go'), '');
          return 'GO';
        })(),
      ),
    ).then((r) => r.filter((x) => x !== 'GO'));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(results.filter((r) => r === 'LOCKED')).toHaveLength(N - 1);
    expect(existsSync(lockFile(d))).toBe(false); // 승자가 12초 뒤 해제(부하 시 자식 기동 지연 대비)
    expect(existsSync(lockFile(d) + '.reclaim')).toBe(false);
  });
});
