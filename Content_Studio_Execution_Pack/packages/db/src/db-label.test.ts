import { describe, expect, it } from 'vitest';
import { DbDriverNotImplementedError } from './client';
import { databaseLabel, dbCliErrorLine } from './db-label';
import { DbLockedError } from './lock';

describe('databaseLabel — DB 위치 표시에 비밀을 넣지 않는다(FULLREV3 남은 위험 migrate.ts)', () => {
  it('PGlite 경로·memory:// 는 그대로', () => {
    expect(databaseLabel('./data/pglite')).toBe('./data/pglite');
    expect(databaseLabel('/srv/content-studio/data/pglite')).toBe('/srv/content-studio/data/pglite');
    expect(databaseLabel('C:\\data\\pglite')).toBe('C:\\data\\pglite');
    expect(databaseLabel('memory://')).toBe('memory://');
  });

  it('postgres URL 은 scheme·host·port 만(사용자 이름·비밀번호·경로·fragment 없음)', () => {
    expect(databaseLabel('postgres://cs_user:s3cr3t-P%40ss@db.internal:5432/content_studio#frag')).toBe('postgres://db.internal:5432');
    expect(databaseLabel('postgresql://cs_user@db.internal/content_studio')).toBe('postgresql://db.internal');
    expect(databaseLabel('postgres://u:p@[::1]:5432/db')).toBe('postgres://[::1]:5432');
  });

  it('FULLREV3 재검토 P2: 인코딩하지 않은 / ? # 가 든 비밀번호도 새지 않는다', () => {
    const cases: Array<[string, string]> = [
      ['postgres://cs_user:1234/abc@db.internal/content_studio', 'postgres://db.internal'],
      ['postgres://cs_user:12#xyz@db.internal:5432/db', 'postgres://db.internal:5432'],
      ['postgres://cs_user:9?q/r@db.internal/db', 'postgres://db.internal'],
      ['postgres://cs_user:a@b@db.internal/db', 'postgres://db.internal'],
    ];
    for (const [raw, want] of cases) {
      const label = databaseLabel(raw);
      expect(label).toBe(want);
      for (const leaked of ['cs_user', '1234', 'abc', 'xyz', '9?q', 'a@b']) expect(label).not.toContain(leaked);
    }
  });

  it('query 값·키워드 형식에 비밀이 있을 수 있으면 (숨김)', () => {
    expect(databaseLabel('postgres://db.internal/db?sslmode=require&password=q-secret')).toBe('(숨김)');
    expect(databaseLabel('postgres://db.internal/db?password=p@ss')).toBe('(숨김)');
    expect(databaseLabel('host=db user=cs password=s3cret dbname=x')).toBe('(숨김)');
    // 재검토 P2: password 가 없어도 키워드 형식(user= 등)은 숨긴다
    expect(databaseLabel('host=db user=cs_user dbname=x')).toBe('(숨김)');
    expect(databaseLabel('host=x passwd=sec')).toBe('(숨김)');
    expect(databaseLabel('cs:pw@db/x')).toBe('(숨김)');
  });

  it('host 없는 값·읽을 수 없는 값은 (숨김)', () => {
    expect(databaseLabel('postgres://')).toBe('(숨김)');
    expect(databaseLabel('postgresql:///content_studio')).toBe('(숨김)');
    expect(databaseLabel('://user:pw@')).toBe('(숨김)');
    expect(databaseLabel('postgres://u:p w@ho st/db')).toBe('(숨김)');
  });
});

describe('DB CLI 출력이 databaseLabel·describeErrorSafely 를 거친다', () => {
  it('migrate.ts·seed.ts 는 DATABASE_URL·오류 메시지 본문을 그대로 출력하지 않는다', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    for (const name of ['migrate.ts', 'seed.ts']) {
      const src = readFileSync(fileURLToPath(new URL(`../scripts/${name}`, import.meta.url)), 'utf8');
      expect(src).toContain('databaseLabel(config.DATABASE_URL)');
      expect(src).not.toMatch(/database:\s*config\.DATABASE_URL/);
      // 예상하지 못한 오류는 다시 던지지 않는다(Node 가 메시지·스택 — 경로가 들어갈 수 있음 — 을 찍는다) → 종류·코드만
      expect(src).toContain('dbCliErrorLine(');
      expect(src).not.toMatch(/throw e;/);
      expect(src).not.toMatch(/console\.error\(e\b|e\.message|e\.stack/);
      // 재검토 P2: DB 닫기 오류도 종류·코드만(맨 위로 던지면 Node 가 메시지·스택을 찍는다)
      expect(src).toMatch(/try \{\s*await handle\.close\(\);\s*\} catch \(e\) \{\s*console\.error\(dbCliErrorLine\('DB 를 닫지 못했습니다', e\)\);/);
    }
  });
});

describe('dbCliErrorLine — DB CLI 오류 한 줄에 값·경로를 넣지 않는다', () => {
  it('파일 오류 메시지의 경로(= DATABASE_URL)는 쓰지 않고 종류·코드만', () => {
    const e = Object.assign(new Error("EACCES: permission denied, mkdir '/repo/postgres:/cs_user:s3cret@db/x'"), { code: 'EACCES' });
    const line = dbCliErrorLine('DB migration 을 마치지 못했습니다', e);
    expect(line).toBe('DB migration 을 마치지 못했습니다(오류 종류: Error(EACCES)).');
    expect(line).not.toContain('s3cret');
  });
  it('잠금·드라이버 미구현은 고정 안내 문구 그대로(재검토 P2 — 원인 안내 유지)', () => {
    const drv = new DbDriverNotImplementedError();
    expect(dbCliErrorLine('x', drv)).toBe(drv.message);
    expect(drv.message).toContain('DB_DRIVER=postgres');
    const lock = new DbLockedError(12345);
    expect(dbCliErrorLine('x', lock)).toBe(lock.message);
  });
});

describe('FULLREV3 후속: export·restore·restore-drill·worker CLI 도 열기 오류를 다시 던지지 않는다', () => {
  it('openDb 실패·예상하지 못한 오류·DB 닫기 오류는 dbCliErrorLine 한 줄(메시지·스택 없음)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    for (const name of ['export.ts', 'restore.ts', 'restore-drill.ts']) {
      const src = read(`../scripts/${name}`);
      expect(src).not.toMatch(/throw e;/);
      expect(src).toMatch(/openDb\(config\)\.catch\(\(e: unknown\) => \{\s*console\.error\(dbCliErrorLine\('DB 를 열지 못했습니다', e\)\);\s*process\.exit\(1\);/);
      expect(src).toMatch(/try \{\s*await handle\.close\(\);\s*\} catch \(e\) \{\s*console\.error\(dbCliErrorLine\('DB 를 닫지 못했습니다', e\)\);/);
      expect(src).toMatch(/\} catch \(e\) \{[\s\S]*dbCliErrorLine\('(내보내기를|복원을|복원 훈련을) 마치지 못했습니다', e\)/);
      // 메시지 본문은 앱이 만든 AppError(restore.ts — 코드·안내 문구)만
      const messages = src.match(/e\.message/g) ?? [];
      expect(messages.length).toBe(name === 'restore.ts' ? 1 : 0);
      expect(src).not.toMatch(/e\.stack/);
    }
    const worker = read('../../../apps/worker/src/cli.ts');
    expect(worker).toMatch(/openDb\(config\)\.catch\(\(e: unknown\) => \{\s*console\.error\(dbCliErrorLine\('DB 를 열지 못했습니다', e\)\);\s*process\.exit\(1\);/);
    // 재검토 P2: worker 의 DB 닫기도 같은 방식
    expect(worker).toMatch(/try \{\s*await handle\.close\(\);\s*\} catch \(e\) \{\s*console\.error\(dbCliErrorLine\('DB 를 닫지 못했습니다', e\)\);/);
  });
});
