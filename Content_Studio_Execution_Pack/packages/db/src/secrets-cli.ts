/**
 * `pnpm secrets:rotate [--confirm]` 의 본체(T13 FIX, D25-5). 스크립트(packages/db/scripts/secrets-rotate.ts)는 이것을 부르기만 한다 — 시험 가능하게.
 * 출력은 숫자·문제 종류·오류 종류(이름·코드)만. 키·암호문·토큰·DB 오류 메시지 본문(값이 들어 있을 수 있음)은 출력하지 않는다(FIX2-T13 Q7).
 */
import { loadConfig, readSecretKeyring } from '@cs/domain';
import type { DbHandle } from './client';
import { DbLockedError } from './lock';
import { formatRotationReport, rotateSecretKeys } from './oauth';

export interface SecretsRotateCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  openDb: (config: ReturnType<typeof loadConfig>) => Promise<DbHandle>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 예상하지 못한 오류 → 종류 이름과(있으면) 코드만. 메시지 본문은 쓰지 않는다. */
export function describeErrorSafely(e: unknown): string {
  if (e && typeof e === 'object') {
    const name = e instanceof Error ? e.name : 'Error';
    const code = 'code' in e && typeof (e as { code: unknown }).code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test((e as { code: string }).code) ? (e as { code: string }).code : null;
    return code ? `${name}(${code})` : name;
  }
  return typeof e;
}

/** 종료 코드: 0 = 성공, 1 = 키 미설정·DB 잠금·열 수 없는 봉인·예상하지 못한 오류 */
export async function runSecretsRotateCli(deps: SecretsRotateCliDeps): Promise<number> {
  const confirm = deps.argv.includes('--confirm');
  const ring = readSecretKeyring(deps.env);
  if (!ring.ok) {
    deps.err(`서버 비밀 암호화 키가 설정되지 않았습니다: ${ring.problems.join(', ')}`);
    return 1;
  }
  let handle: DbHandle | null = null;
  try {
    handle = await deps.openDb(loadConfig(deps.env));
    const r = await rotateSecretKeys(handle.db, ring.keyring, { dryRun: !confirm });
    deps.out('키 교체(외부 호출 없음)\n');
    deps.out(formatRotationReport(r));
    return [r.credentials, r.states].some((c) => Object.keys(c.failed).length > 0) ? 1 : 0;
  } catch (e) {
    if (e instanceof DbLockedError) {
      deps.err(e.message);
      return 1;
    }
    deps.err(`키 교체를 마치지 못했습니다(오류 종류: ${describeErrorSafely(e)}). 적용된 행은 다시 실행하면 "현재 키"로 셉니다.`);
    return 1;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
