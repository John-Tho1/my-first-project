/**
 * FIX4-T13(Codex review-FIX3-T13 P1 :908 · 놓친 케이스 "revoked + epoch 0"): 0033 이 0030 의 정리 대기 열(pending_*)을 oauth_pending_tokens 로
 * 옮기고, 첫 연결 자리 표시 행만 지우는지(옛 해제 행 — revoked + 해제 세대 0 + linked — 은 남김). 0032 까지 적용한 DB 에 구버전 모양의 행을 넣고
 * 0033 SQL 을 직접 실행한다(migration-0023 과 같은 방식). 봉인 값은 형식만 맞춘 가짜(csk1:) — 실제 토큰 없음.
 */
import { randomUUID } from 'node:crypto';
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
const TAG_0033 = tags.find((t) => t.startsWith('0033'))!;

async function applyTag(client: PGlite, tag: string) {
  await client.transaction(async (tx) => {
    for (const stmt of sqlFor(tag)) await tx.exec(stmt);
  });
}

describe('0033 migration: 정리 대기 → oauth_pending_tokens, 자리 표시 행만 삭제', () => {
  it('살아 있는 행의 refresh_unknown·자리 표시 행의 cleanup_revoke·옛 해제 행의 cleanup_revoke 를 옮기고, 자리 표시 행만 지운다', async () => {
    expect(TAG_0033).toBe('0033_t13_fix4_pending_tokens');
    const { client } = createDb({ driver: 'pglite', url: 'memory://' });
    for (const tag of tags.filter((t) => t < '0033')) await applyTag(client, tag);
    const one = async <T>(q: string, params: unknown[] = []) => (await client.query<T>(q, params)).rows[0]!;
    const owner = (await one<{ id: string }>(`insert into users (allowed_identity) values ('m33@example.local') returning id`)).id;
    const account = async (state: string) =>
      (
        await one<{ id: string }>(
          `insert into channel_accounts (owner_id, platform, kind, external_account_id, display_name, state, credential_state) values ($1, 'threads', 'mock', $2, 'm', 'mock_ready', $3) returning id`,
          [owner, `mock:threads:${randomUUID()}`, state],
        )
      ).id;
    const live = await account('linked');
    const placeholder = await account('none');
    const legacyPending = await account('linked');
    const legacyPlain = await account('linked');
    const [op1, op2, op3] = [randomUUID(), randomUUID(), randomUUID()];
    const t0 = '2026-09-30T00:00:00Z';
    // (1) 살아 있는 연결 정보 + refresh_unknown
    await client.query(
      `insert into oauth_credentials (owner_id, channel_account_id, provider, is_mock, encrypted_token, key_version, token_generation, revocation_epoch, status, scopes, connected_at, expires_at,
         pending_op_id, pending_kind, pending_token, pending_key_version, updated_at)
       values ($1, $2, 'mock_threads', true, 'csk1:1:aa:bb:cc', 1, 3, 1, 'active', '["threads_basic"]'::jsonb, $3, $3, $4, 'refresh_unknown', 'csk1:1:p1:p1:p1', 1, $3)`,
      [owner, live, t0, op1],
    );
    // (2) 0030 첫 연결 자리 표시 행(credential_state none)
    await client.query(
      `insert into oauth_credentials (owner_id, channel_account_id, provider, is_mock, encrypted_token, key_version, token_generation, revocation_epoch, status, revoked_at, scopes, connected_at, created_at,
         pending_op_id, pending_kind, pending_token, pending_key_version, updated_at)
       values ($1, $2, 'mock_threads', true, null, null, 1, 0, 'revoked', $3, '[]'::jsonb, $3, $3, $4, 'cleanup_revoke', 'csk1:1:p2:p2:p2', 1, $3)`,
      [owner, placeholder, t0, op2],
    );
    // (3) 옛(0029 이전) 해제 행 — revoked + 해제 세대 0, linked — 에 정리 대기가 붙은 경우(FIX3 코드는 이 행을 지울 수 있었다)
    await client.query(
      `insert into oauth_credentials (owner_id, channel_account_id, provider, is_mock, encrypted_token, key_version, token_generation, revocation_epoch, status, revoked_at, scopes, connected_at,
         pending_op_id, pending_kind, pending_token, pending_key_version, updated_at)
       values ($1, $2, 'mock_threads', true, null, null, 1, 0, 'revoked', $3, '[]'::jsonb, $3, $4, 'cleanup_revoke', 'csk1:2:p3:p3:p3', 2, $3)`,
      [owner, legacyPending, t0, op3],
    );
    // (4) 옛 해제 행, 정리 대기 없음
    await client.query(
      `insert into oauth_credentials (owner_id, channel_account_id, provider, is_mock, encrypted_token, key_version, token_generation, revocation_epoch, status, revoked_at, scopes, connected_at)
       values ($1, $2, 'mock_threads', true, null, null, 1, 0, 'revoked', $3, '[]'::jsonb, $3)`,
      [owner, legacyPlain, t0],
    );

    await applyTag(client, TAG_0033);

    const pending = (
      await client.query<{ id: string; channel_account_id: string; kind: string; sealed_token: string; key_version: number; base_generation: number | null; source: string; revision: number; attempts: number }>(
        `select id, channel_account_id, kind, sealed_token, key_version, base_generation, source, revision, attempts from oauth_pending_tokens order by sealed_token`,
      )
    ).rows;
    expect(pending).toEqual([
      { id: op1, channel_account_id: live, kind: 'refresh_unknown', sealed_token: 'csk1:1:p1:p1:p1', key_version: 1, base_generation: 3, source: 'migrated_0030', revision: 1, attempts: 0 },
      { id: op2, channel_account_id: placeholder, kind: 'cleanup_revoke', sealed_token: 'csk1:1:p2:p2:p2', key_version: 1, base_generation: null, source: 'migrated_0030', revision: 1, attempts: 0 },
      { id: op3, channel_account_id: legacyPending, kind: 'cleanup_revoke', sealed_token: 'csk1:2:p3:p3:p3', key_version: 2, base_generation: null, source: 'migrated_0030', revision: 1, attempts: 0 },
    ]);
    const creds = (await client.query<{ channel_account_id: string; status: string }>(`select channel_account_id, status from oauth_credentials`)).rows;
    const byAccount = new Map(creds.map((c) => [c.channel_account_id, c.status]));
    expect(byAccount.get(live)).toBe('active');
    expect(byAccount.has(placeholder)).toBe(false); // 자리 표시 행만 삭제 — 정리 대기 행이 계정을 계속 막는다
    expect(byAccount.get(legacyPending)).toBe('revoked'); // 옛 해제 행은 남김
    expect(byAccount.get(legacyPlain)).toBe('revoked');
    const cols = (await client.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'oauth_credentials' and column_name like 'pending%'`)).rows;
    expect(cols).toEqual([]);

    // 새 표 CHECK: verify_current 는 봉인 없음·세대 있음, 그 밖은 봉인(csk1:) 있음, 종류 제한
    const bad = [
      `insert into oauth_pending_tokens (owner_id, channel_account_id, kind, sealed_token, key_version, base_generation, source) values ('${owner}', '${live}', 'verify_current', 'csk1:1:x:x:x', 1, 3, 't')`,
      `insert into oauth_pending_tokens (owner_id, channel_account_id, kind, source) values ('${owner}', '${live}', 'verify_current', 't')`,
      `insert into oauth_pending_tokens (owner_id, channel_account_id, kind, source) values ('${owner}', '${live}', 'cleanup_revoke', 't')`,
      `insert into oauth_pending_tokens (owner_id, channel_account_id, kind, sealed_token, key_version, source) values ('${owner}', '${live}', 'cleanup_revoke', 'plain-token', 1, 't')`,
      `insert into oauth_pending_tokens (owner_id, channel_account_id, kind, sealed_token, key_version, source) values ('${owner}', '${live}', 'other', 'csk1:1:x:x:x', 1, 't')`,
      `insert into oauth_pending_tokens (owner_id, channel_account_id, kind, sealed_token, key_version, source) values ('${randomUUID()}', '${live}', 'cleanup_revoke', 'csk1:1:x:x:x', 1, 't')`,
    ];
    for (const q of bad) await expect(client.exec(q), q).rejects.toThrow();
    await client.exec(`insert into oauth_pending_tokens (owner_id, channel_account_id, kind, base_generation, source) values ('${owner}', '${live}', 'verify_current', 3, 't')`);
    await client.close();
  });
});
