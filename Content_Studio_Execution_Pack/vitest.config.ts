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
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
