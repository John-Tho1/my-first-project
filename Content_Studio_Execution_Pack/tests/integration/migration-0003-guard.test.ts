/**
 * T04 migration(0003) 의 ideas.source_capture_ids → idea_captures 이관 검증.
 * 해석되지 않는 항목(삭제된 소재·타 owner·잘못된 UUID)이 하나라도 있으면 migration 이 실패해야 하고(조용한 유실 금지),
 * 모두 해석되면 관계가 그대로 옮겨져야 한다. migrator 대신 SQL 파일을 순서대로 직접 실행해 0002 상태에서 데이터를 넣는다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, migrationsFolder, type DbHandle } from '@cs/db';

/** @cs/db 가 등록한 확장(pg_trgm)이 있는 메모리 PGlite. 패키지 의존성은 @cs/db 에만 있으므로 직접 import 하지 않는다. */
type PGlite = DbHandle['client'];

const journal = JSON.parse(readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((e) => e.tag);
const sqlFor = (tag: string) =>
  readFileSync(path.join(migrationsFolder(), `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

async function upTo0002(): Promise<PGlite> {
  const { client } = createDb({ driver: 'pglite', url: 'memory://' });
  for (const tag of tags.filter((t) => t < '0003')) {
    for (const stmt of sqlFor(tag)) await client.exec(stmt);
  }
  return client;
}

async function apply0003(client: PGlite): Promise<void> {
  const tag = tags.find((t) => t.startsWith('0003'))!;
  for (const stmt of sqlFor(tag)) await client.exec(stmt);
}

async function seedOwner(client: PGlite, identity: string, captureText: string) {
  const u = await client.query<{ id: string }>('insert into users (allowed_identity) values ($1) returning id', [identity]);
  const ownerId = u.rows[0]!.id;
  const c = await client.query<{ id: string }>(
    "insert into captures (owner_id, raw_text, input_type, command_key) values ($1, $2, 'text', $3) returning id",
    [ownerId, captureText, `k-${identity}`],
  );
  return { ownerId, captureId: c.rows[0]!.id };
}

type Owner = { ownerId: string; captureId: string };
const insertIdea = (client: PGlite, ownerId: string, ids: unknown) =>
  client.query<{ id: string }>("insert into ideas (owner_id, idea, source_capture_ids) values ($1, 'i', $2::jsonb) returning id", [
    ownerId,
    JSON.stringify(ids),
  ]);

describe('0003 migration: source_capture_ids 이관은 유실 없이', () => {
  it('모든 항목이 같은 owner 의 capture 면 idea_captures 로 옮기고 컬럼을 지운다', async () => {
    const client = await upTo0002();
    const a = await seedOwner(client, 'a@example.local', 'A');
    const idea = await insertIdea(client, a.ownerId, [a.captureId, a.captureId]); // 중복 항목은 1행으로
    await apply0003(client);
    const rel = await client.query<{ idea_id: string; capture_id: string; owner_id: string }>('select idea_id, capture_id, owner_id from idea_captures');
    expect(rel.rows).toEqual([{ idea_id: idea.rows[0]!.id, capture_id: a.captureId, owner_id: a.ownerId }]);
    const cols = await client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'ideas' and column_name = 'source_capture_ids'",
    );
    expect(cols.rows).toHaveLength(0);
    await client.close();
  });

  const cases: Array<[string, (a: Owner, b: Owner) => unknown[]]> = [
    ['삭제된(없는) 소재 ID', (a) => ['00000000-0000-4000-8000-00000000dead', a.captureId]],
    ['타 owner 의 소재 ID', (_a, b) => [b.captureId]],
    ['UUID 가 아닌 문자열', (a) => [a.captureId, 'not-a-uuid']],
  ];
  it.each(cases)('%s 가 있으면 migration 이 실패하고 아무것도 지우지 않는다', async (_label, ids) => {
    const client = await upTo0002();
    const a = await seedOwner(client, 'a@example.local', 'A');
    const b = await seedOwner(client, 'b@example.local', 'B');
    await insertIdea(client, a.ownerId, ids(a, b));
    await expect(apply0003(client)).rejects.toThrow(/T04 migration 중단/);
    // 컬럼과 원본 값은 그대로 남아 수동 정리가 가능하다
    const still = await client.query<{ source_capture_ids: unknown }>('select source_capture_ids from ideas');
    expect(still.rows[0]!.source_capture_ids).toEqual(ids(a, b));
    await client.close();
  });
});
