import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { countCaptures, createTestDb, loadFixtureCaptures, schema, seed, type DbHandle } from '@cs/db';

describe('migrate + seed (PGlite memory)', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createTestDb();
  });
  afterAll(async () => {
    await h.close();
  });

  it('픽스처는 가상 데이터 10건(text 7, url 3, example.com 만)', () => {
    const f = loadFixtureCaptures();
    expect(f).toHaveLength(10);
    expect(f.filter((x) => x.input_type === 'text')).toHaveLength(7);
    const urls = f.filter((x) => x.input_type === 'url');
    expect(urls).toHaveLength(3);
    for (const u of urls) expect(new URL(u.url!).hostname).toBe('example.com');
    expect(new Set(f.map((x) => x.command_key)).size).toBe(10);
  });

  it('첫 seed 는 10건, 재실행해도 10건(멱등)', async () => {
    const first = await seed(h.db, { allowedIdentity: 'owner@example.local' });
    expect(first.capturesInserted).toBe(10);
    expect(first.capturesTotal).toBe(10);
    const second = await seed(h.db, { allowedIdentity: 'owner@example.local' });
    expect(second.capturesInserted).toBe(0);
    expect(second.capturesTotal).toBe(10);
    expect(second.ownerId).toBe(first.ownerId);
    expect(await countCaptures(h.db)).toBe(10);
    expect(await h.db.select().from(schema.users)).toHaveLength(1);
    const profiles = await h.db.select().from(schema.brandProfiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ version: 1, penName: '가칭: 해외영업 노트' });
    expect(profiles[0]!.pillars).toEqual(['해외 사업·영업 운영', '전문성의 AI 적용', '해외·러시아·주재원·조직 차이 경험']);
  });

  it('시각은 UTC timestamptz 로 저장된다', async () => {
    const rows = await h.db.select().from(schema.captures).where(eq(schema.captures.commandKey, 'fx-001'));
    expect(rows[0]!.receivedAt.toISOString()).toBe('2026-09-01T06:10:00.000Z');
  });

  it('(owner_id, command_key) unique 로 중복 수집을 막는다', async () => {
    const [owner] = await h.db.select().from(schema.users);
    await expect(
      h.db.insert(schema.captures).values({ ownerId: owner!.id, rawText: 'dup', inputType: 'text', commandKey: 'fx-001' }),
    ).rejects.toThrow();
  });

  it('다른 owner 의 source 를 capture 에 연결할 수 없다(복합 FK)', async () => {
    const [ownerA] = await h.db.select().from(schema.users);
    const [ownerB] = await h.db.insert(schema.users).values({ allowedIdentity: 'other@example.local' }).returning();
    const [srcB] = await h.db.insert(schema.sources).values({ ownerId: ownerB!.id, kind: 'url' }).returning();
    await expect(
      h.db
        .insert(schema.captures)
        .values({ ownerId: ownerA!.id, rawText: 'x', inputType: 'url', commandKey: 'cross-owner', sourceId: srcB!.id }),
    ).rejects.toThrow();
  });
});
