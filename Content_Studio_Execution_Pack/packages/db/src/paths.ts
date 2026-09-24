/**
 * 경로 규칙: 상대 경로(DATABASE_URL, STORAGE_LOCAL_DIR, fixture, migration)는
 * 프로세스 cwd 가 아니라 워크스페이스 루트(pnpm-workspace.yaml 이 있는 폴더) 기준으로 해석한다.
 * `pnpm dev`(cwd=apps/web)와 `pnpm db:seed`(cwd=루트)가 같은 데이터 디렉터리를 가리키게 하기 위함.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

export function findWorkspaceRoot(start: string = process.cwd()): string {
  let dir = path.resolve(/*turbopackIgnore: true*/ start);
  for (;;) {
    if (existsSync(/*turbopackIgnore: true*/ path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('워크스페이스 루트(pnpm-workspace.yaml)를 찾지 못했습니다');
    dir = parent;
  }
}

export function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(/*turbopackIgnore: true*/ findWorkspaceRoot(), p);
}

/** 루트의 .env.local → .env 순서로 읽는다. 이미 설정된 환경변수는 덮어쓰지 않는다. CLI 전용. */
export function loadRootEnv(): void {
  const root = findWorkspaceRoot();
  for (const name of ['.env.local', '.env']) {
    const file = path.join(/*turbopackIgnore: true*/ root, name);
    if (existsSync(/*turbopackIgnore: true*/ file)) process.loadEnvFile(/*turbopackIgnore: true*/ file);
  }
}
