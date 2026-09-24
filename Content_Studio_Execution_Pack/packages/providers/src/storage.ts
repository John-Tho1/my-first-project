/**
 * 파일 저장소 adapter(docs/02 media). 개발은 local-file, 운영 object storage(S3 호환 등)는 미구현.
 * DB 에는 메타데이터·checksum 만 두고 바이트는 여기에 저장한다.
 *
 * adapter 는 owner 를 모른다(owner-agnostic). 소유권은 route·query 계층(@cs/db getAssetById 등)에서 강제한다.
 * 대신 key 는 `assets/<uuid>/<uuid>` 형식만 허용해 경로 조작(`..`, 절대경로, 역슬래시)이 파일 시스템에 닿지 않게 한다.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertValidStorageKey, ObjectStorageNotImplementedError, type AppConfig } from '@cs/domain';

export interface StorageAdapter {
  readonly driver: 'local';
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** 없으면 null */
  get(key: string): Promise<Uint8Array<ArrayBuffer> | null>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly driver = 'local' as const;
  private readonly root: string;

  /** rootDir 는 절대 경로(호출자가 워크스페이스 루트 기준으로 해석해 넘긴다). */
  constructor(rootDir: string) {
    if (!path.isAbsolute(rootDir)) throw new Error('LocalStorageAdapter 의 rootDir 는 절대 경로여야 합니다');
    this.root = path.resolve(/*turbopackIgnore: true*/ rootDir);
  }

  /** key 검증 후 root 아래의 실제 경로. 검증을 통과해도 root 밖이면 거부(이중 방어). */
  private pathFor(key: string): string {
    assertValidStorageKey(key);
    const full = path.resolve(/*turbopackIgnore: true*/ this.root, ...key.split('/'));
    if (!full.startsWith(this.root + path.sep)) throw new Error('저장소 경로가 루트를 벗어났습니다');
    return full;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(/*turbopackIgnore: true*/ path.dirname(full), { recursive: true });
    // 임시 파일에 쓴 뒤 rename — 중간에 실패해도 반쯤 쓴 파일이 key 로 보이지 않는다.
    const tmp = `${full}.tmp-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(/*turbopackIgnore: true*/ tmp, bytes, { flag: 'wx' });
      await rename(/*turbopackIgnore: true*/ tmp, full);
    } catch (e) {
      await rm(/*turbopackIgnore: true*/ tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  async get(key: string): Promise<Uint8Array<ArrayBuffer> | null> {
    const full = this.pathFor(key);
    try {
      return new Uint8Array(await readFile(/*turbopackIgnore: true*/ full));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async exists(key: string): Promise<boolean> {
    const full = this.pathFor(key);
    try {
      return (await stat(/*turbopackIgnore: true*/ full)).isFile();
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(/*turbopackIgnore: true*/ this.pathFor(key), { force: true });
  }
}

/**
 * 설정으로 저장소를 만든다. resolvePath 는 STORAGE_LOCAL_DIR 을 절대 경로로 바꾸는 함수
 * (web 은 @cs/db 의 resolveFromRoot — DATABASE_URL 과 같은 워크스페이스 루트 기준).
 */
export function createStorage(
  config: Pick<AppConfig, 'STORAGE_DRIVER' | 'STORAGE_LOCAL_DIR'>,
  resolvePath: (p: string) => string,
): StorageAdapter {
  if (config.STORAGE_DRIVER !== 'local') throw new ObjectStorageNotImplementedError();
  return new LocalStorageAdapter(resolvePath(config.STORAGE_LOCAL_DIR));
}
