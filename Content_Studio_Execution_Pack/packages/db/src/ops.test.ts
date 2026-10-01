/**
 * FIX round 1(Codex review-T20 P2, ops.ts:46): 폴더 측정 실패를 정상값으로 보고하지 않는다 — complete / partial(하한값) / unavailable.
 */
import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cachedDiskUsage, dirUsage, resetDiskCache, type DirFs, type DiskUsage } from './ops';

const ROOT = path.resolve('/virtual-root');
const dirent = (name: string, kind: 'dir' | 'file') => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file' }) as unknown as Dirent;
const stats = (kind: 'dir' | 'file', size = 0) => ({ isDirectory: () => kind === 'dir', isFile: () => kind === 'file', size }) as unknown as Stats;
const fail = (code: string) => Object.assign(new Error(code), { code });

/** 가상 폴더: a.txt(10) + sub/b.txt(20) + locked/(읽기 실패 주입) */
function fakeFs(opts: { rootReaddir?: string; subReaddir?: string; fileLstat?: string } = {}): DirFs {
  return {
    lstat: async (p) => {
      if (p === ROOT || p === path.join(ROOT, 'sub')) return stats('dir');
      if (p === path.join(ROOT, 'a.txt')) {
        if (opts.fileLstat) throw fail(opts.fileLstat);
        return stats('file', 10);
      }
      if (p === path.join(ROOT, 'sub', 'b.txt')) return stats('file', 20);
      throw fail('ENOENT');
    },
    readdir: async (p) => {
      if (p === ROOT) {
        if (opts.rootReaddir) throw fail(opts.rootReaddir);
        return [dirent('a.txt', 'file'), dirent('sub', 'dir')];
      }
      if (p === path.join(ROOT, 'sub')) {
        if (opts.subReaddir) throw fail(opts.subReaddir);
        return [dirent('b.txt', 'file')];
      }
      throw fail('ENOENT');
    },
  };
}

describe('dirUsage — 측정 상태', () => {
  it('모두 읽으면 complete', async () => {
    expect(await dirUsage(ROOT, { fs: fakeFs() })).toMatchObject({ present: true, bytes: 30, files: 2, status: 'complete', errors: 0, truncated: false });
  });
  it('하위 폴더 읽기 실패 → partial(하한값), 오류 수', async () => {
    expect(await dirUsage(ROOT, { fs: fakeFs({ subReaddir: 'EACCES' }) })).toMatchObject({ present: true, bytes: 10, files: 1, status: 'partial', errors: 1 });
  });
  it('파일 크기 읽기 실패(EACCES) → partial, 세는 사이 지워진 파일(ENOENT)은 오류 아님', async () => {
    expect(await dirUsage(ROOT, { fs: fakeFs({ fileLstat: 'EACCES' }) })).toMatchObject({ bytes: 20, status: 'partial', errors: 1 });
    expect(await dirUsage(ROOT, { fs: fakeFs({ fileLstat: 'ENOENT' }) })).toMatchObject({ bytes: 20, status: 'complete', errors: 0 });
  });
  it('맨 위 폴더 읽기 실패 → unavailable(0 바이트를 측정값으로 쓰지 않음)', async () => {
    expect(await dirUsage(ROOT, { fs: fakeFs({ rootReaddir: 'EACCES' }) })).toMatchObject({ present: true, status: 'unavailable', errors: 1 });
  });
  it('폴더 없음 → present false, unavailable', async () => {
    expect(await dirUsage(path.join(ROOT, 'nope'), { fs: fakeFs() })).toMatchObject({ present: false, status: 'unavailable', errors: 0 });
  });
  it('항목 수 상한 → partial + truncated', async () => {
    expect(await dirUsage(ROOT, { fs: fakeFs(), maxEntries: 1 })).toMatchObject({ status: 'partial', truncated: true });
  });
});

describe('FIX round 3 (Codex review-FIX-T20)', () => {
  it('Q10: 측정 중 하위 폴더가 사라지면(ENOENT) partial + changedDuringScan, 접근 실패 수는 0', async () => {
    expect(await dirUsage(ROOT, { fs: fakeFs({ subReaddir: 'ENOENT' }) })).toMatchObject({ status: 'partial', changedDuringScan: true, errors: 0, bytes: 10 });
    expect(await dirUsage(ROOT, { fs: fakeFs() })).toMatchObject({ status: 'complete', changedDuringScan: false });
  });

  it('P2 ops.ts:141: 진행 중 측정은 TTL(60초)이 지나도 공유 — 끝나지 않는 측정에 두 번 요청해도 순회 1번', async () => {
    resetDiskCache();
    let calls = 0;
    const never = () => {
      calls++;
      return new Promise<DiskUsage>(() => undefined);
    };
    const cfg = { DATABASE_URL: 'memory://', STORAGE_LOCAL_DIR: './x', EXPORT_LOCAL_DIR: './y' };
    const a = cachedDiskUsage(cfg, 0, never);
    const b = cachedDiskUsage(cfg, 120_000, never);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    resetDiskCache();
  });

  it('끝난 측정에만 TTL: 60초 안에는 재사용, 지나면 다시 측정, 실패하면 캐시에 남기지 않음', async () => {
    resetDiskCache();
    let calls = 0;
    let t = 1_000;
    const value = { measuredAt: new Date(0) } as DiskUsage;
    const ok = async () => {
      calls++;
      return value;
    };
    const cfg = { DATABASE_URL: 'memory://', STORAGE_LOCAL_DIR: './x', EXPORT_LOCAL_DIR: './y' };
    await cachedDiskUsage(cfg, t, ok, () => t);
    await cachedDiskUsage(cfg, t + 59_000, ok, () => t);
    expect(calls).toBe(1);
    t += 61_000;
    await cachedDiskUsage(cfg, t, ok, () => t);
    expect(calls).toBe(2);
    resetDiskCache();
    const fail = async () => {
      calls++;
      throw new Error('x');
    };
    await expect(cachedDiskUsage(cfg, t, fail, () => t)).rejects.toThrow();
    await cachedDiskUsage(cfg, t, ok, () => t);
    expect(calls).toBe(4);
    resetDiskCache();
  });
});
