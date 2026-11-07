/**
 * FIX1-FULLREV2(G1): `pnpm dev` 가 모든 인터페이스(0.0.0.0)에서 듣지 않게 — next.mjs 의 인자 조립(next-args.mjs)을 고정한다.
 * - dev 이고 hostname 이 없으면 명령 바로 뒤에 loopback hostname 을 넣는다(APP_BASE_URL 호스트가 127.0.0.1 이면 127.0.0.1, 그 밖은 localhost).
 * - hostname 을 직접 주면(-H x · -Hx · -H=x · --hostname x · --hostname=x) 그대로 두고, loopback 이 아니면 경고 한 줄.
 * - build·start·typegen 인자는 바꾸지 않는다(운영 systemd 의 `start --hostname 127.0.0.1` 포함).
 * 프로세스를 띄우지 않는다(Next 를 실행하지 않음) — 순수 함수와 파일 내용만 본다.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildNextArgs,
  defaultDevHostname,
  devHostnameWarning,
  explicitHostname,
  isLoopbackHostname,
  nextSubcommand,
  readAppBaseUrl,
} from './next-args.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '../../..');
const hostnameOf = (args: readonly string[]) => explicitHostname(args.slice(args.indexOf('dev') + 1))?.value;

describe('dev 기본 hostname = loopback', () => {
  it('hostname 이 없으면 dev 바로 뒤에 --hostname localhost(기본 APP_BASE_URL)', () => {
    expect(buildNextArgs(['dev'])).toEqual({ args: ['dev', '--hostname', 'localhost'], warning: null });
    expect(buildNextArgs(['dev'], { appBaseUrl: 'http://localhost:3000' })).toEqual({ args: ['dev', '--hostname', 'localhost'], warning: null });
    // 로컬 HTTPS(D31·D39 dev-cert: CN=localhost, https://localhost:3000/api/oauth/callback)
    expect(buildNextArgs(['dev', '--experimental-https'], { appBaseUrl: 'https://localhost:3000' }).args).toEqual([
      'dev',
      '--hostname',
      'localhost',
      '--experimental-https',
    ]);
  });

  it('APP_BASE_URL 호스트가 127.0.0.1 이면 127.0.0.1 — request.url 의 호스트가 APP_BASE_URL 과 같게(OAuth redirect 정확 일치)', () => {
    expect(buildNextArgs(['dev'], { appBaseUrl: 'http://127.0.0.1:3000' }).args).toEqual(['dev', '--hostname', '127.0.0.1']);
    expect(buildNextArgs(['dev', '-p', '3001'], { appBaseUrl: 'https://127.0.0.1:3001/' }).args).toEqual(['dev', '--hostname', '127.0.0.1', '-p', '3001']);
  });

  it('APP_BASE_URL 이 없음·잘못됨·LAN·외부 도메인이어도 기본은 loopback(localhost) — 0.0.0.0 으로 열지 않는다', () => {
    for (const appBaseUrl of [undefined, '', 'not a url', 'http://192.168.0.10:3000', 'https://studio.example.com', 'http://0.0.0.0:3000', 'http://[::1]:3000']) {
      const r = buildNextArgs(['dev'], { appBaseUrl });
      expect(r.args, String(appBaseUrl)).toEqual(['dev', '--hostname', 'localhost']);
      expect(r.warning).toBeNull();
    }
    expect(defaultDevHostname(undefined)).toBe('localhost');
  });

  it('기본으로 넣는 hostname 은 언제나 loopback 이고 명령 바로 뒤(`--` 앞)에 들어간다', () => {
    for (const appBaseUrl of [undefined, 'http://localhost:3000', 'http://127.0.0.1:3000', 'https://x.example']) {
      const { args } = buildNextArgs(['dev', '--turbopack', '--', '--hostname', '0.0.0.0'], { appBaseUrl });
      expect(args.slice(0, 3)).toEqual(['dev', '--hostname', defaultDevHostname(appBaseUrl)]);
      expect(isLoopbackHostname(args[2])).toBe(true);
      expect(args.slice(3)).toEqual(['--turbopack', '--', '--hostname', '0.0.0.0']);
    }
  });

  it('`--` 뒤의 -H 는 옵션이 아니다(commander) — 직접 준 hostname 으로 보지 않는다', () => {
    expect(explicitHostname(['--', '-H', '0.0.0.0'])).toBeNull();
    expect(explicitHostname(['--', '--hostname=0.0.0.0'])).toBeNull();
  });
});

describe('hostname 을 직접 주면 그대로 두고, loopback 이 아니면 경고', () => {
  const forms = (h: string) => [
    ['dev', '-H', h],
    ['dev', `-H${h}`],
    ['dev', `-H=${h}`],
    ['dev', '--hostname', h],
    ['dev', `--hostname=${h}`],
    ['dev', '-p', '3001', '--hostname', h, '--turbopack'],
  ];

  it('loopback(localhost·127.0.0.0/8·::1): 인자 그대로, 경고 없음', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '127.0.0.2', '127.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
      for (const argv of forms(h)) {
        const r = buildNextArgs(argv);
        expect(r.args, argv.join(' ')).toEqual(argv);
        expect(r.warning, argv.join(' ')).toBeNull();
        expect(hostnameOf(r.args)).toBe(h);
      }
    }
  });

  it('모든 인터페이스·LAN·외부 이름: 인자 그대로(사용자 선택 유지) + 한국어 경고 한 줄(값 포함)', () => {
    for (const h of ['0.0.0.0', '::', '[::]', '192.168.0.10', '10.0.0.5', 'my-pc.local', 'example.com', '128.0.0.1', '127.0.0.1.example.com']) {
      for (const argv of forms(h)) {
        const r = buildNextArgs(argv);
        expect(r.args, argv.join(' ')).toEqual(argv);
        expect(r.warning, argv.join(' ')).toBe(devHostnameWarning(h));
      }
    }
    const w = devHostnameWarning('0.0.0.0');
    expect(w).not.toMatch(/[\r\n]/);
    expect(w).toContain('"0.0.0.0"');
    expect(w).toContain('개발용 로그인(AUTH_MODE=dev)은 비밀번호가 없어');
  });

  it('빈 값(--hostname=)은 모든 인터페이스로 열리므로 경고, 값 없이 끝난 -H 는 Next 가 거부하므로 기본값을 넣지 않고 경고도 없다', () => {
    expect(buildNextArgs(['dev', '--hostname=']).warning).toBe(devHostnameWarning(''));
    expect(buildNextArgs(['dev', '--hostname', '']).warning).toBe(devHostnameWarning(''));
    expect(buildNextArgs(['dev', '-H'])).toEqual({ args: ['dev', '-H'], warning: null });
  });

  it('여러 번 주면 마지막 값(commander 와 같음)으로 판단한다', () => {
    expect(buildNextArgs(['dev', '-H', '127.0.0.1', '--hostname', '0.0.0.0']).warning).toBe(devHostnameWarning('0.0.0.0'));
    expect(buildNextArgs(['dev', '-H', '0.0.0.0', '--hostname=localhost']).warning).toBeNull();
  });
});

describe('dev 밖의 명령은 바꾸지 않는다', () => {
  it('build·start·typegen·인자 없음: 그대로, 경고 없음', () => {
    for (const argv of [
      ['build'],
      ['start'],
      ['start', '--hostname', '127.0.0.1', '--port', '3000'], // deploy/content-studio.service ExecStart
      ['start', '-H', '0.0.0.0'],
      ['typegen'],
      [],
      ['--version'],
    ]) {
      expect(buildNextArgs(argv, { appBaseUrl: 'http://127.0.0.1:3000' }), argv.join(' ')).toEqual({ args: argv, warning: null });
    }
    expect(nextSubcommand(['--', 'dev'])).toBeUndefined();
    expect(buildNextArgs(['--', 'dev']).args).toEqual(['--', 'dev']);
  });

  it('운영 systemd unit 은 start 에 --hostname 127.0.0.1 을 직접 준다(이 수정과 무관하게 유지)', () => {
    const unit = readFileSync(path.join(appRoot, 'deploy/content-studio.service'), 'utf8');
    expect(unit).toMatch(/^ExecStart=\S+ apps\/web\/scripts\/next\.mjs start --hostname 127\.0\.0\.1 --port 3000$/m);
  });
});

describe('APP_BASE_URL 읽기(next.config.ts 와 같은 순서: 환경 → .env.local → .env)', () => {
  const files = (map: Record<string, string>) => (p: string) => {
    const v = map[path.basename(p)];
    if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return v;
  };

  it('환경 변수가 있으면 파일을 읽지 않는다(빈 값도 환경 값 — next.config 의 loadEnvFile 은 덮어쓰지 않음)', () => {
    const never = () => {
      throw new Error('읽으면 안 됨');
    };
    expect(readAppBaseUrl({ APP_BASE_URL: 'http://127.0.0.1:3000' }, '/app', never)).toBe('http://127.0.0.1:3000');
    expect(readAppBaseUrl({ APP_BASE_URL: '' }, '/app', never)).toBe('');
  });

  it('.env.local 이 .env 보다 먼저, 둘 다 없거나 값이 없으면 undefined', () => {
    const both = files({ '.env.local': 'APP_BASE_URL="http://127.0.0.1:3000" # 주석\n', '.env': 'APP_BASE_URL=http://localhost:3000\n' });
    expect(readAppBaseUrl({}, '/app', both)).toBe('http://127.0.0.1:3000');
    expect(readAppBaseUrl({}, '/app', files({ '.env.local': 'AUTH_MODE=dev\n', '.env': 'APP_BASE_URL=https://localhost:3000' }))).toBe(
      'https://localhost:3000',
    );
    expect(readAppBaseUrl({}, '/app', files({}))).toBeUndefined();
    expect(readAppBaseUrl({}, '/app', files({ '.env.local': 'X=1' }))).toBeUndefined();
  });

  it('앱 루트의 .env.local·.env 를 가리킨다', () => {
    const seen: string[] = [];
    readAppBaseUrl({}, '/srv/app', (p) => {
      seen.push(p);
      throw new Error('ENOENT');
    });
    expect(seen).toEqual([path.join('/srv/app', '.env.local'), path.join('/srv/app', '.env')]);
  });
});

describe('연결: pnpm dev → next.mjs → buildNextArgs', () => {
  it('next.mjs 는 process.argv 를 buildNextArgs 로 조립한 인자로만 Next 를 띄우고, 경고는 stderr 로 쓴다', () => {
    const src = readFileSync(path.join(here, 'next.mjs'), 'utf8');
    expect(src).toContain("from './next-args.mjs'");
    expect(src).toMatch(/const argv = process\.argv\.slice\(2\);/);
    expect(src).toMatch(/const \{ args, warning \} = buildNextArgs\(argv, \{ appBaseUrl \}\);/);
    expect(src).toMatch(/spawn\(process\.execPath, \[nextBin, \.\.\.args\]/);
    expect(src).not.toMatch(/\.\.\.process\.argv/);
    expect(src).toMatch(/if \(warning\) process\.stderr\.write\(`\$\{warning\}\\n`\);/);
    // APP_BASE_URL 은 dev 일 때만, 앱 루트(apps/web 의 두 단계 위)에서 읽는다
    expect(src).toMatch(/nextSubcommand\(argv\) === 'dev' \? readAppBaseUrl\(process\.env, appRoot,/);
    expect(src).toContain("const appRoot = path.resolve(webDir, '../..');");
  });

  it('루트·apps/web 의 dev 스크립트는 next.mjs dev 를 그대로 부른다(hostname 을 덮어쓰지 않음 → 기본 loopback)', () => {
    const root = JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const web = JSON.parse(readFileSync(path.join(appRoot, 'apps/web/package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(root.scripts.dev).toBe('node apps/web/scripts/next.mjs dev');
    expect(web.scripts.dev).toBe('node scripts/next.mjs dev');
    for (const s of [root.scripts.dev!, web.scripts.dev!]) {
      const argv = s.split(' ').slice(2);
      const r = buildNextArgs(argv);
      expect(r.warning).toBeNull();
      expect(isLoopbackHostname(hostnameOf(r.args))).toBe(true);
    }
  });

  it('Next 16.3.6 가정: dev 는 기본 host 를 두지 않고(모든 인터페이스), request.url 의 호스트는 --hostname 값으로 만든다', () => {
    const require = createRequire(import.meta.url);
    const nextDir = path.dirname(require.resolve('next/package.json'));
    expect(readFileSync(path.join(nextDir, 'dist/cli/next-dev.js'), 'utf8')).toContain('const host = options.hostname;');
    // 이 가정이 바뀌면(Next 업그레이드) defaultDevHostname 의 localhost/127.0.0.1 선택 이유를 다시 확인한다
    expect(readFileSync(path.join(nextDir, 'dist/server/lib/router-utils/resolve-routes.js'), 'utf8')).toContain(
      "(0, _formathostname.formatHostname)(opts.hostname || 'localhost')",
    );
  });
});
