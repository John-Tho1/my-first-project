// Next CLI 래퍼: 텔레메트리(외부 전송)를 끈 상태로 실행한다. 사용자 전역 설정은 바꾸지 않는다.
// Windows(cmd/PowerShell)에서도 동작하도록 `VAR=1 next ...` 대신 Node 에서 환경변수를 설정한다.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// 어디서 호출하든 apps/web 을 작업 디렉터리로 실행한다(루트 스크립트가 중첩 pnpm 없이 호출 가능).
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nextBin = require.resolve('next/dist/bin/next');
const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  cwd: webDir,
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
