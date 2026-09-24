/**
 * T06 migration(0005) 을 데이터가 있는 0004 상태 DB 에 적용: 기존 brand_profiles 행은 새 열 기본값을 받고 그대로 남으며,
 * 새 표의 복합 FK(다른 owner 의 브랜드 프로필·원고 참조 금지)와 추가 전용 트리거가 동작한다.
 * migrator 대신 SQL 파일을 순서대로 직접 실행한다(migration-0003-guard 와 같은 방식).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, migrationsFolder, type DbHandle } from '@cs/db';

type PGlite = DbHandle['client'];

const journal = JSON.parse(readFileSync(path.join(migrationsFolder(), 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
const tags = journal.entries.map((e) => e.tag);
const sqlFor = (tag: string) =>
  readFileSync(path.join(migrationsFolder(), `${tag}.sql`), 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);

async function applyTag(client: PGlite, tag: string) {
  await client.transaction(async (tx) => {
    for (const stmt of sqlFor(tag)) await tx.exec(stmt);
  });
}

async function errorOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

describe('0005 migration: 기존 데이터 위에 적용', () => {
  it('기존 브랜드 프로필은 기본값을 받고, 새 표는 owner 복합 FK·추가 전용 트리거를 가진다', async () => {
    const { client } = createDb({ driver: 'pglite', url: 'memory://' });
    for (const tag of tags.filter((t) => t < '0005')) await applyTag(client, tag);

    const owner = async (identity: string) => {
      const u = await client.query<{ id: string }>('insert into users (allowed_identity) values ($1) returning id', [identity]);
      const ownerId = u.rows[0]!.id;
      const bp = await client.query<{ id: string }>(
        `insert into brand_profiles (owner_id, version, pen_name, audience, pillars) values ($1, 1, 'p', 'a', '["x"]'::jsonb) returning id`,
        [ownerId],
      );
      const c = await client.query<{ id: string }>(`insert into contents (owner_id, title) values ($1, 't') returning id`, [ownerId]);
      const v = await client.query<{ id: string }>(
        `insert into content_versions (content_id, version, body, created_by) values ($1, 1, 'b', 'owner') returning id`,
        [c.rows[0]!.id],
      );
      return { ownerId, brandId: bp.rows[0]!.id, contentId: c.rows[0]!.id, versionId: v.rows[0]!.id };
    };
    const a = await owner('a@example.local');
    const b = await owner('b@example.local');

    await applyTag(client, tags.find((t) => t.startsWith('0005'))!);

    const row = (
      await client.query<{ tone: string; avoid_phrases: unknown; cta_rules: unknown; sample_texts: unknown; pen_name: string }>(
        'select * from brand_profiles where id = $1',
        [a.brandId],
      )
    ).rows[0]!;
    expect(row).toMatchObject({ tone: 'formal', avoid_phrases: [], cta_rules: [], sample_texts: [], pen_name: 'p' });

    const insertRun = (ownerId: string, contentId: string, brandId: string, versionId: string) =>
      client.query<{ id: string }>(
        `insert into generation_runs (owner_id, content_id, mode, input_version_id, brand_profile_id, input_version_refs, prompt_version, provider, model, status)
         values ($1, $2, 'outline', $3, $4, '{}'::jsonb, 'v', 'mock', 'mock', 'running') returning id`,
        [ownerId, contentId, versionId, brandId],
      );
    // 다른 owner 의 브랜드 프로필·원고는 참조할 수 없다(복합 FK)
    expect(await errorOf(insertRun(a.ownerId, a.contentId, b.brandId, a.versionId))).toMatch(/generation_runs_brand_same_owner_fk/);
    expect(await errorOf(insertRun(a.ownerId, b.contentId, a.brandId, b.versionId))).toMatch(/generation_runs_content_same_owner_fk/);
    const run = await insertRun(a.ownerId, a.contentId, a.brandId, a.versionId);
    expect(
      await errorOf(client.query('insert into claim_confirmations (owner_id, run_id, claim_index) values ($1, $2, 0)', [b.ownerId, run.rows[0]!.id])),
    ).toMatch(/claim_confirmations_run_same_owner_fk/);
    expect(
      await errorOf(
        client.query(`insert into interview_answers (owner_id, content_id, question_key, question, answer) values ($1, $2, 'situation', 'q', 'x')`, [
          b.ownerId,
          a.contentId,
        ]),
      ),
    ).toMatch(/interview_answers_content_same_owner_fk/);
    await client.query(`insert into interview_answers (owner_id, content_id, question_key, question, answer) values ($1, $2, 'situation', 'q', 'x')`, [
      a.ownerId,
      a.contentId,
    ]);
    expect(await errorOf(client.query(`update interview_answers set answer = 'y'`))).toMatch(/append_only_immutable/);
    expect(await errorOf(client.query(`update brand_profiles set tone = 'rude'`))).toMatch(/brand_profiles_tone_chk/);
    await client.close();
  });
});
