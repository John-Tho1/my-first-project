import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';

// 환경변수는 워크스페이스 루트의 .env.local / .env 에서 읽는다(README: `cp .env.example .env.local`).
// 이미 설정된 값은 덮어쓰지 않는다. 비밀은 서버 프로세스에만 존재하며 NEXT_PUBLIC_* 로 노출하지 않는다.
const root = path.resolve(process.cwd(), '../..');
for (const name of ['.env.local', '.env']) {
  const file = path.join(root, name);
  if (existsSync(file)) process.loadEnvFile(file);
}

const nextConfig: NextConfig = {
  // PGlite 는 WASM/데이터 파일을 런타임에 읽으므로 번들하지 않고 node_modules 에서 그대로 로드한다.
  serverExternalPackages: ['@electric-sql/pglite'],
  // 워크스페이스 TS 소스 패키지를 Next 가 트랜스파일한다.
  transpilePackages: ['@cs/db', '@cs/domain', '@cs/providers', '@cs/worker'],
  poweredByHeader: false,
  // next dev 가 apps/web 에 AGENTS.md/CLAUDE.md 를 자동 생성하지 않게 한다(저장소 규칙은 루트 AGENTS.md 가 정본).
  agentRules: false,
  turbopack: { root },
};

export default nextConfig;
