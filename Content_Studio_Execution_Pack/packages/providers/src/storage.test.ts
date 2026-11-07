import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidStorageKeyError, loadConfig, ObjectStorageNotImplementedError } from '@cs/domain';
import { createStorage, LocalStorageAdapter } from './storage';

const OWNER = '11111111-2222-4333-8444-555555555555';
const ASSET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const KEY = `assets/${OWNER}/${ASSET}`;

describe('LocalStorageAdapter', () => {
  const dirs: string[] = [];
  const mk = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'cs-storage-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('put → exists → get → delete', async () => {
    const root = mk();
    const s = new LocalStorageAdapter(root);
    expect(await s.get(KEY)).toBeNull();
    expect(await s.exists(KEY)).toBe(false);
    await s.put(KEY, new Uint8Array([1, 2, 3]));
    expect(existsSync(path.join(root, 'assets', OWNER, ASSET))).toBe(true);
    expect(readdirSync(path.join(root, 'assets', OWNER))).toEqual([ASSET]); // 임시 파일이 남지 않음
    expect(await s.exists(KEY)).toBe(true);
    expect(Array.from((await s.get(KEY))!)).toEqual([1, 2, 3]);
    await s.delete(KEY);
    expect(await s.exists(KEY)).toBe(false);
  });

  it.each([
    '../outside',
    `assets/../../${ASSET}`,
    `assets/${OWNER}/../../../etc/passwd`,
    '/etc/passwd',
    `assets\\${OWNER}\\${ASSET}`,
    `assets/${OWNER}/${ASSET}/../${ASSET}`,
  ])('경로 조작 키는 파일 시스템에 닿기 전에 거부: %j', async (key) => {
    const root = mk();
    // 루트 밖에 파일을 만들어 두고 읽히지 않는지 확인
    writeFileSync(path.join(path.dirname(root), `${path.basename(root)}-outside`), 'secret');
    const s = new LocalStorageAdapter(root);
    await expect(s.get(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(s.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(s.exists(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(s.delete(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    rmSync(path.join(path.dirname(root), `${path.basename(root)}-outside`), { force: true });
  });

  it('상대 rootDir 거부', () => {
    expect(() => new LocalStorageAdapter('./data/assets')).toThrow();
  });
});

describe('createStorage', () => {
  it('local → LocalStorageAdapter (resolvePath 로 절대 경로화)', () => {
    const s = createStorage(loadConfig({}), (p) => path.resolve('/tmp/cs-root', p));
    expect(s.driver).toBe('local');
  });
  it('STORAGE_DRIVER=object → ObjectStorageNotImplementedError', () => {
    expect(() => createStorage(loadConfig({ STORAGE_DRIVER: 'object' }), (p) => p)).toThrow(
      ObjectStorageNotImplementedError,
    );
  });
});
