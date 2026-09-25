import { defineConfig } from 'vitest/config';

// 단위(unit): packages/**, apps/** 의 *.test.ts
// 통합(integration): tests/integration/** (PGlite memory://)
const exclude = ['**/node_modules/**', '**/.next/**', '**/dist/**'];

export default defineConfig({
  test: {
    // 테스트는 외부 설정 파일을 읽지 않고 안전 기본값으로 실행한다.
    env: {
      DATABASE_URL: 'memory://',
      LLM_MODE: 'mock',
      PUBLISH_MODE: 'disabled',
      COLLECTOR_MODE: 'disabled',
      WORKER_MODE: 'inline',
    },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], exclude },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          exclude,
          // Windows/Node 24 + migration 19개: 파일 20개 병렬 실행 시 PGlite 초기화 훅이 30s 를 넘긴다(단독은 수 초). 부하 여유로 120s.
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // 워커(fork)마다 PGlite WASM 을 올리므로 코어 수만큼 띄우면 Windows 에서 메모리 고갈로 워커가 죽는다(exit 2147483651). 동시 3개로 제한.
          maxWorkers: 3,
        },
      },
    ],
  },
});
