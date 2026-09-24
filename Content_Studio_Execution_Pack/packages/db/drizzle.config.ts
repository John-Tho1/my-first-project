import { defineConfig } from 'drizzle-kit';

// PostgreSQL 방언으로 SQL migration 을 생성한다. 같은 SQL 을 PGlite(개발)와 PostgreSQL(M3~ 운영)에 적용한다.
// generate 는 DB 연결 없이 schema.ts 만 읽는다.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
