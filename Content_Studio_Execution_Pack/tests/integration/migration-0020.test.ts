/**
 * FIX-T12(P1, Codex review-T12 0018:22): 0020 이 모든 계획 상태를 항목 상태 + 활성 승인 수로 planStatusFrom 과 같은 규칙으로 다시 계산하는지.
 * 0018 이전 규칙은 PLANNED 항목이 하나라도 있으면 승인 수로 상태를 정했다 → PLANNED+CONFIRMED 가 draft/approved, PLANNED+CANCELED 가 draft 로
 * 저장돼 있을 수 있다(0018 은 failed·partial 만 재분류). migrator 대신 SQL 파일을 순서대로 직접 실행한다(migration-0005 와 같은 방식).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb, migrationsFolder, type DbHandle } from '@cs/db';
import { planStatusFrom } from '@cs/domain';

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

const hex = (n: number) => n.toString(16).padStart(64, '0');

describe('0020 migration: 계획 상태 전체 재계산', () => {
  it('PLANNED+CONFIRMED(draft·approved 로 저장) → partial, PLANNED+CANCELED(draft) → attention, 규칙과 같은 값은 그대로(revision 유지)', async () => {
    const { client } = createDb({ driver: 'pglite', url: 'memory://' });
    for (const tag of tags.filter((t) => t < '0020')) await applyTag(client, tag);

    const one = async <T>(q: string, params: unknown[] = []) => (await client.query<T>(q, params)).rows[0]!;
    const owner = (await one<{ id: string }>(`insert into users (allowed_identity) values ('m20@example.local') returning id`)).id;
    const content = (await one<{ id: string }>(`insert into contents (owner_id, title) values ($1, 't') returning id`, [owner])).id;
    const cv = (await one<{ id: string }>(`insert into content_versions (content_id, version, body, created_by) values ($1, 1, 'b', 'owner') returning id`, [content])).id;
    const variant = (await one<{ id: string }>(`insert into variants (owner_id, content_id, channel, lifecycle) values ($1, $2, 'threads', 'review') returning id`, [owner, content])).id;
    const vv = (
      await one<{ id: string }>(
        `insert into variant_versions (owner_id, variant_id, version, content_version_id, body, metadata_json, created_by) values ($1, $2, 1, $3, 'b', '{}'::jsonb, 'owner') returning id`,
        [owner, variant, cv],
      )
    ).id;
    const account = (
      await one<{ id: string }>(
        `insert into channel_accounts (owner_id, platform, kind, external_account_id, display_name, state) values ($1, 'threads', 'mock', 'mock:threads:m20', 'm', 'mock_ready') returning id`,
        [owner],
      )
    ).id;
    let n = 0;
    const plan = async (status: string, items: Array<{ status: string; approved?: boolean }>) => {
      const p = (await one<{ id: string }>(`insert into distribution_plans (owner_id, status) values ($1, $2) returning id`, [owner, status])).id;
      for (const it of items) {
        const h = hex(++n);
        const i = (
          await one<{ id: string }>(
            `insert into distribution_items (owner_id, plan_id, channel_account_id, variant_id, variant_version_id, content_version_id, payload_json, payload_hash, requested_result, visibility, status)
             values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, $7, 'mock_publish', 'private', $8) returning id`,
            [owner, p, account, variant, vv, cv, h, it.status],
          )
        ).id;
        if (it.approved) {
          await client.query(`insert into approvals (owner_id, distribution_item_id, payload_hash, purpose, approved_at) values ($1, $2, $3, 'mock_publish', now())`, [owner, i, h]);
        }
      }
      return p;
    };
    // 0018 이전 규칙으로 저장됐을 수 있는 조합
    const cases = [
      { stored: 'draft', items: [{ status: 'PLANNED' }, { status: 'CONFIRMED' }], expected: 'partial' },
      { stored: 'approved', items: [{ status: 'PLANNED', approved: true }, { status: 'CONFIRMED' }], expected: 'partial' },
      { stored: 'draft', items: [{ status: 'PLANNED' }, { status: 'CANCELED' }], expected: 'attention' },
      { stored: 'partially_approved', items: [{ status: 'PLANNED', approved: true }, { status: 'FAILED' }], expected: 'attention' },
      { stored: 'draft', items: [{ status: 'PLANNED' }, { status: 'PLANNED' }], expected: 'draft' },
      { stored: 'failed', items: [{ status: 'FAILED' }, { status: 'CANCELED' }], expected: 'failed' },
      { stored: 'executing', items: [{ status: 'CONFIRMED' }, { status: 'CONFIRMED' }], expected: 'completed' },
      { stored: 'approved', items: [], expected: 'draft' },
    ];
    const ids: string[] = [];
    for (const c of cases) ids.push(await plan(c.stored, c.items));

    await applyTag(client, tags.find((t) => t.startsWith('0020'))!);

    for (const [k, c] of cases.entries()) {
      const row = await one<{ status: string; revision: number }>(`select status, revision from distribution_plans where id = $1`, [ids[k]]);
      // SQL 재계산 = 도메인 규칙(planStatusFrom)
      const domain = planStatusFrom(c.items.map((i) => ({ status: i.status, activeApproval: Boolean(i.approved) })));
      expect(domain, `case ${k}`).toBe(c.expected);
      expect(row.status, `case ${k}`).toBe(c.expected);
      expect(row.revision, `case ${k} revision`).toBe(c.stored === c.expected ? 1 : 2);
    }
    // 0020 의 jobs.restored_needs_review 기본 false
    const col = await one<{ column_default: string; is_nullable: string }>(
      `select column_default, is_nullable from information_schema.columns where table_name = 'jobs' and column_name = 'restored_needs_review'`,
    );
    expect(col).toMatchObject({ column_default: 'false', is_nullable: 'NO' });
    await client.close();
  });
});
