/**
 * T05 표 범위 검사: schema.ts 의 모든 pgTable 은 내보내기(EXPORTED_TABLES) 또는 제외(EXCLUDED_TABLES) 중 정확히 하나에 있어야 한다.
 * 새 표를 추가하고 목록을 갱신하지 않으면 이 테스트가 실패한다(조용히 빠지는 표가 없게).
 * 또한 내보내는 열(owner_id 제외)은 @cs/domain 행 스키마의 키와 같아야 한다(새 열이 묶음에서 빠지지 않게).
 */
import { describe, expect, it } from 'vitest';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { EXCLUDED_TABLES, EXPORTED_TABLES, ROW_SCHEMAS } from '@cs/domain';
import { BUNDLE_TABLES, bundleColumns } from './bundle-tables';
import * as schema from './schema';

const allTables = Object.values(schema)
  .filter((v) => is(v, PgTable))
  .map((t) => getTableName(t as PgTable))
  .sort();

describe('export 표 범위', () => {
  it('모든 pgTable 은 EXPORTED 또는 EXCLUDED 중 정확히 하나에 있다', () => {
    const exported = new Set<string>(EXPORTED_TABLES);
    const excluded = new Set(Object.keys(EXCLUDED_TABLES));
    for (const t of allTables) {
      expect(exported.has(t) !== excluded.has(t), `${t} 는 EXPORTED_TABLES/EXCLUDED_TABLES 중 하나에만 있어야 합니다`).toBe(true);
    }
    for (const t of [...exported, ...excluded]) expect(allTables, `${t} 는 schema.ts 에 없는 표`).toContain(t);
  });

  it('sessions·export_runs·restore_runs 는 제외된다', () => {
    expect(Object.keys(EXCLUDED_TABLES).sort()).toEqual(['export_runs', 'restore_runs', 'sessions']);
  });

  it('BUNDLE_TABLES 는 이름이 맞는 drizzle 표를 가리킨다', () => {
    for (const name of EXPORTED_TABLES) expect(getTableName(BUNDLE_TABLES[name])).toBe(name);
  });

  it('내보내는 열(owner_id 제외) = 행 스키마 키', () => {
    for (const name of EXPORTED_TABLES) {
      const cols = bundleColumns(name).map((c) => c.name);
      const keys = Object.keys(ROW_SCHEMAS[name].shape).filter((k) => k !== 'identity_masked');
      expect(cols.sort(), name).toEqual(keys.sort());
    }
  });
});
