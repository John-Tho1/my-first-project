import { DbDriverNotImplementedError } from './client';
import { DbLockedError } from './lock';
import { describeErrorSafely } from './secrets-cli';

/**
 * FULLREV3 남은 위험(migrate.ts:14): CLI 출력에 넣는 DB 위치 표시. DATABASE_URL 을 그대로 찍지 않는다.
 * - PGlite 폴더 경로·memory:// 는 비밀이 아니므로 그대로 보인다(어느 폴더에 적용했는지 확인용).
 * - '://' 가 있는 값(postgres://… 등)은 `scheme://host[:port]` 만 남긴다 — 사용자 이름·비밀번호·경로·query·fragment 는 버린다.
 *   URL 해석기에 맡기지 않는다: 비밀번호에 인코딩하지 않은 '/'·'?'·'#' 가 있으면 해석기가 사용자 정보를 경로로 읽어
 *   그대로 내보낸다(FULLREV3 재검토 P2). 그래서 마지막 '@' 뒤에서 첫 '/'·'?'·'#' 앞까지만 host 로 본다.
 * - '://' 가 없어도 비밀이 섞였을 수 있는 모양(libpq 키워드 형식 `…=…`, '@')은 '(숨김)'.
 * - 남은 한계(비밀 아님): 마지막 '@' 기준이라 fragment 에 '@' 가 있으면 다른 host 를 보일 수 있고, pglite 드라이버로 postgres 모양 값을 열면
 *   실제로는 로컬 폴더인데 `postgres://host` 로 보인다.
 */
export function databaseLabel(databaseUrl: string): string {
  if (databaseUrl === 'memory://') return databaseUrl;
  const sep = databaseUrl.indexOf('://');
  // libpq 키워드 형식(`host=… user=… password=…`)일 수 있는 '=' 나 사용자 정보 '@' 가 있으면 통째로 숨긴다(재검토 P2 — user= 도 숨김).
  if (sep < 0) return /[=@]/.test(databaseUrl) ? '(숨김)' : databaseUrl;
  const scheme = databaseUrl.slice(0, sep);
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return '(숨김)';
  const rest = databaseUrl.slice(sep + 3);
  // query 의 값(`?password=p@ss` 등)에 '@' 가 있으면 마지막 '@' 기준이 비밀 일부를 host 로 읽는다 — '=' 가 있으면 통째로 숨긴다(보수적).
  if (rest.includes('=')) return '(숨김)';
  const afterUser = rest.slice(rest.lastIndexOf('@') + 1);
  const host = afterUser.split(/[/?#]/, 1)[0] ?? '';
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(host)) return '(숨김)';
  return `${scheme}://${host}`;
}

/**
 * FULLREV3 남은 위험(재검토 P2): DB CLI(migrate·seed)의 오류 한 줄. 잠금·드라이버 미구현은 고정 문구(값 없음)라 그대로,
 * 그 밖은 오류 메시지 본문(파일 오류는 경로 = DATABASE_URL 이 들어감)을 쓰지 않고 종류·코드만(describeErrorSafely).
 */
export function dbCliErrorLine(what: string, e: unknown): string {
  if (e instanceof DbLockedError || e instanceof DbDriverNotImplementedError) return e.message;
  return `${what}(오류 종류: ${describeErrorSafely(e)}).`;
}
