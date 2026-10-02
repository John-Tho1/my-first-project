/**
 * `pnpm secrets:rotate [--confirm]` 의 본체(T13 FIX, D25-5). 스크립트(packages/db/scripts/secrets-rotate.ts)는 이것을 부르기만 한다 — 시험 가능하게.
 * 출력은 숫자·문제 종류·오류 종류(허용된 이름·코드)만. 키·암호문·토큰·DB 오류 메시지 본문(값이 들어 있을 수 있음)은 출력하지 않는다(FIX2·FIX3-T13 Q7).
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

/**
 * FIX3-T13(Codex Q7): 출력해도 되는 오류 종류 이름(허용 목록). 그 밖의 이름은 값이 섞였을 수 있으므로 'Error' 로만 쓴다.
 * 코드는 대문자·숫자·밑줄 1~40자(PostgreSQL SQLSTATE·Node 오류 코드 모양)일 때만 쓴다.
 */
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'AggregateError',
  'AbortError',
  'DbLockedError',
  'SecretDecryptError',
  'SecretsNotConfiguredError',
  'ConfigError',
  'DatabaseError',
  'DrizzleQueryError',
]);
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/;

/** 예상하지 못한 오류 → 허용된 종류 이름과(모양이 맞으면) 코드만. 메시지 본문은 쓰지 않는다. */
export function describeErrorSafely(e: unknown): string {
  if (e && typeof e === 'object') {
    const raw = e instanceof Error ? e.name : 'Error';
    const name = SAFE_ERROR_NAMES.has(raw) ? raw : 'Error';
    const c = 'code' in e ? (e as { code: unknown }).code : undefined;
    const code = typeof c === 'string' && SAFE_CODE.test(c) ? c : null;
    return code ? `${name}(${code})` : name;
  }
  return 'Error';
}

/** 종료 코드: 0 = 성공, 1 = 키 미설정·DB 잠금·열 수 없는 봉인·예상하지 못한 오류·DB 닫기 실패 */
export async function runSecretsRotateCli(deps: SecretsRotateCliDeps): Promise<number> {
  const confirm = deps.argv.includes('--confirm');
  const ring = readSecretKeyring(deps.env);
  if (!ring.ok) {
    deps.err(`서버 비밀 암호화 키가 설정되지 않았습니다: ${ring.problems.join(', ')}`);
    return 1;
  }
  let handle: DbHandle | null = null;
  let code = 0;
  try {
    handle = await deps.openDb(loadConfig(deps.env));
    const r = await rotateSecretKeys(handle.db, ring.keyring, { dryRun: !confirm });
    deps.out('키 교체(외부 호출 없음)\n');
    deps.out(formatRotationReport(r));
    code = [r.credentials, r.states, r.pendingTokens].some((c) => Object.keys(c.failed).length > 0) ? 1 : 0;
  } catch (e) {
    if (e instanceof DbLockedError) {
      deps.err(e.message);
      return 1;
    }
    deps.err(`키 교체를 마치지 못했습니다(오류 종류: ${describeErrorSafely(e)}). 적용된 행은 다시 실행하면 "현재 키"로 셉니다.`);
    code = 1;
  }
  // FIX3-T13(Codex P2): DB 닫기 실패도 종료 코드에 반영한다(같은 안전 출력).
  if (handle) {
    try {
      await handle.close();
    } catch (e) {
      deps.err(`DB 를 닫지 못했습니다(오류 종류: ${describeErrorSafely(e)}).`);
      code = 1;
    }
  }
  return code;
}
