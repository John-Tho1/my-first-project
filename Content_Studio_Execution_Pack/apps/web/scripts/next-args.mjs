// FIX1-FULLREV2(G1): next.mjs 가 Next CLI 에 넘길 인자를 만든다. 파일·프로세스를 직접 건드리지 않는 함수만 둔다(단위 시험: next-args.test.ts).
//
// `next dev` 는 -H/--hostname 이 없으면 모든 인터페이스(0.0.0.0)에서 듣는다(Next 16.3.6 cli/next-dev.js "We do not set a default host value").
// 그러면 비밀번호 없는 개발용 로그인(AUTH_MODE=dev)이 같은 Wi-Fi·LAN 에 열린다 — 'localhost 전용' 가드(isLocalhostBaseUrl)는 설정값만 보고
// Origin 은 브라우저가 아닌 도구가 위조할 수 있다. 그래서 dev 는 hostname 을 주지 않으면 이 PC(loopback)에서만 듣게 한다.
// 사용자가 hostname 을 직접 주면 그대로 두고, loopback 이 아니면 경고 한 줄만 낸다(stderr — next.mjs).
// build·start·typegen 등 다른 명령의 인자는 바꾸지 않는다(운영은 deploy/content-studio.service 가 `start --hostname 127.0.0.1` 을 직접 준다).
import path from 'node:path';
import { parseEnv } from 'node:util';

/**
 * Next CLI 의 하위 명령(dev·build·start 등). 최상위 옵션(-h·-v)은 값을 받지 않으므로 처음 나오는 '-' 로 시작하지 않는 인자가 명령이다.
 * @param {readonly string[]} argv
 * @returns {string | undefined}
 */
export function nextSubcommand(argv) {
  for (const a of argv) {
    if (a === '--') return undefined;
    if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/**
 * 하위 명령 뒤 인자에서 직접 준 hostname(-H x · -Hx · -H=x · --hostname x · --hostname=x). 여러 번 주면 Next(commander)처럼 마지막 값.
 * `--` 뒤는 옵션이 아니므로 보지 않는다. 없으면 null, 값 없이 끝나면 { value: undefined }(Next 가 인자 누락으로 거부한다).
 * @param {readonly string[]} args
 * @returns {{ value: string | undefined } | null}
 */
export function explicitHostname(args) {
  /** @type {{ value: string | undefined } | null} */
  let found = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    if (a === '-H' || a === '--hostname') {
      found = { value: args[i + 1] };
      i++;
    } else if (a.startsWith('--hostname=')) {
      found = { value: a.slice('--hostname='.length) };
    } else if (a.startsWith('-H')) {
      // commander 는 -Hx 의 x 를 값으로 받는다. -H=x 는 '=' 까지 값이 되지만(Next 가 그 이름을 찾지 못해 시작하지 않음) 의도한 주소로 판단한다.
      found = { value: a.slice(2).replace(/^=/, '') };
    }
  }
  return found;
}

/**
 * 이 PC 에서만 닿는 주소인가: localhost, 127.0.0.0/8, ::1(대괄호 포함). WHATWG URL 로 정규화해 판단한다(예: 127.1 → 127.0.0.1).
 * 0.0.0.0·::(모든 인터페이스)·빈 값·LAN 주소·그 밖의 이름은 false.
 * @param {unknown} host
 * @returns {boolean}
 */
export function isLoopbackHostname(host) {
  if (typeof host !== 'string' || host === '') return false;
  let h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  try {
    if (h.includes(':')) return new URL(`http://[${h}]/`).hostname === '[::1]';
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(new URL(`http://${h}/`).hostname);
  } catch {
    return false;
  }
}

/**
 * hostname 을 주지 않았을 때의 dev 기본값 — 언제나 loopback. APP_BASE_URL 의 호스트가 127.0.0.1 이면 127.0.0.1, 그 밖(localhost·없음·잘못된 값)은 localhost.
 * 127.0.0.1 로 고정하지 않는 이유: Next 는 --hostname 값으로 route handler 의 request.url 을 만든다(router-utils/resolve-routes.js 의 initUrl
 * `${protocol}://${hostname || 'localhost'}:${port}`). APP_BASE_URL 이 localhost(기본값·로컬 HTTPS)인데 127.0.0.1 로 띄우면 OAuth callback 의
 * redirect 정확 일치(requestRedirectTarget)가 어긋나 모의·실제 Threads 연결이 oauth_redirect_mismatch 로 실패했다.
 * FIX1-FULLREV3(H1): 이제 callback 은 APP_BASE_URL origin + 요청 경로(callbackRedirectTarget)로 비교하므로 그 이유는 사라졌지만,
 * 브라우저가 여는 주소와 서버가 아는 주소를 같게 두는 편이 덜 헷갈리므로 기본값은 그대로 둔다.
 * localhost 는 OS 가 loopback(127.0.0.1 또는 ::1)으로 푼다.
 * @param {string | undefined} appBaseUrl
 * @returns {'localhost' | '127.0.0.1'}
 */
export function defaultDevHostname(appBaseUrl) {
  try {
    if (appBaseUrl !== undefined && new URL(appBaseUrl).hostname === '127.0.0.1') return '127.0.0.1';
  } catch {
    // 잘못된 APP_BASE_URL 은 설정 검사(loadConfig)가 따로 알린다 — 여기서는 기본값 localhost
  }
  return 'localhost';
}

/**
 * 직접 준 hostname 이 loopback 이 아닐 때의 경고(한 줄).
 * @param {string} value
 * @returns {string}
 */
export function devHostnameWarning(value) {
  return (
    `[dev] 경고: dev 서버를 --hostname ${JSON.stringify(value)} 로 엽니다 — 이 PC 밖(같은 Wi-Fi·LAN 등)에서도 접속할 수 있고, ` +
    '개발용 로그인(AUTH_MODE=dev)은 비밀번호가 없어 그 망의 누구나 owner 로 로그인할 수 있습니다. 믿을 수 있는 망에서만 쓰세요' +
    '(hostname 을 주지 않으면 이 PC 에서만 듣습니다).'
  );
}

/**
 * Next CLI 인자. dev 이고 hostname 이 없으면 명령 바로 뒤에 `--hostname <loopback>` 을 넣는다(`--` 앞이 되도록).
 * dev 가 아니면 인자를 그대로 돌려준다.
 * @param {readonly string[]} argv process.argv.slice(2)
 * @param {{ appBaseUrl?: string }} [options]
 * @returns {{ args: string[], warning: string | null }}
 */
export function buildNextArgs(argv, options = {}) {
  const args = [...argv];
  if (nextSubcommand(args) !== 'dev') return { args, warning: null };
  const at = args.indexOf('dev');
  const explicit = explicitHostname(args.slice(at + 1));
  if (explicit === null) {
    args.splice(at + 1, 0, '--hostname', defaultDevHostname(options.appBaseUrl));
    return { args, warning: null };
  }
  if (explicit.value === undefined || isLoopbackHostname(explicit.value)) return { args, warning: null };
  return { args, warning: devHostnameWarning(explicit.value) };
}

/**
 * dev 기본 hostname 을 정할 APP_BASE_URL — apps/web/next.config.ts 와 같은 순서: 프로세스 환경 → 앱 루트 .env.local → .env.
 * 값만 읽고 출력·저장하지 않는다. 파일이 없거나 읽지 못하면 다음 파일로 넘어간다.
 * @param {Record<string, string | undefined>} env
 * @param {string} appRoot
 * @param {(p: string) => string} readText
 * @returns {string | undefined}
 */
export function readAppBaseUrl(env, appRoot, readText) {
  if (env.APP_BASE_URL !== undefined) return env.APP_BASE_URL;
  for (const name of ['.env.local', '.env']) {
    let parsed;
    try {
      parsed = parseEnv(readText(path.join(appRoot, name)));
    } catch {
      continue;
    }
    if (parsed.APP_BASE_URL !== undefined) return parsed.APP_BASE_URL;
  }
  return undefined;
}
