// Next CLI 래퍼: 텔레메트리(외부 전송)를 끈 상태로 실행한다. 사용자 전역 설정은 바꾸지 않는다.
// Windows(cmd/PowerShell)에서도 동작하도록 `VAR=1 next ...` 대신 Node 에서 환경변수를 설정한다.
// FIX1-FULLREV2(G1): `dev` 는 hostname 을 주지 않으면 이 PC(loopback)에서만 듣는다 — 인자 조립은 next-args.mjs(build·start 인자는 그대로).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNextArgs, nextSubcommand, readAppBaseUrl } from './next-args.mjs';

const require = createRequire(import.meta.url);
// 어디서 호출하든 apps/web 을 작업 디렉터리로 실행한다(루트 스크립트가 중첩 pnpm 없이 호출 가능).
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(webDir, '../..');
const nextBin = require.resolve('next/dist/bin/next');
const argv = process.argv.slice(2);
const appBaseUrl = nextSubcommand(argv) === 'dev' ? readAppBaseUrl(process.env, appRoot, (p) => readFileSync(p, 'utf8')) : undefined;
const { args, warning } = buildNextArgs(argv, { appBaseUrl });
if (warning) process.stderr.write(`${warning}\n`);
const child = spawn(process.execPath, [nextBin, ...args], {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
