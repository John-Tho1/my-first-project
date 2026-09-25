/**
 * 내보내기·복원 공용: 묶음 표 이름 ↔ drizzle 표, owner 범위 조건, 열 → JSON 값 변환(T05).
 *
 * 행 JSON 은 DB 열 이름(snake_case)을 쓰고 owner_id 는 뺀다(묶음은 owner 한 명의 것 — @cs/domain bundle.ts).
 * 시각은 DB 에서 마이크로초까지 UTC ISO 문자열로 꺼낸다(JS Date 로 바꾸면 밀리초로 잘려 복원 후 값이 달라짐).
 * bigint 는 float8 로 꺼내 number 로 둔다(파일 크기 등 2^53 미만 값만 있음).
 */
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { maskIdentity, type ExportedTable } from '@cs/domain';
import type { DbOrTx } from './queries';
import * as schema from './schema';

export const BUNDLE_TABLES: Record<ExportedTable, PgTable> = {
  users: schema.users,
  brand_profiles: schema.brandProfiles,
  sources: schema.sources,
  source_versions: schema.sourceVersions,
  captures: schema.captures,
  capture_revisions: schema.captureRevisions,
  ideas: schema.ideas,
  idea_captures: schema.ideaCaptures,
  contents: schema.contents,
  content_versions: schema.contentVersions,
  content_captures: schema.contentCaptures,
  interview_answers: schema.interviewAnswers,
  generation_runs: schema.generationRuns,
  claim_confirmations: schema.claimConfirmations,
  variants: schema.variants,
  variant_versions: schema.variantVersions,
  variant_assets: schema.variantAssets,
  claims: schema.claims,
  claim_sources: schema.claimSources,
  usage_ledger: schema.usageLedger,
  assets: schema.assets,
  transcription_jobs: schema.transcriptionJobs,
  transcripts: schema.transcripts,
  channel_accounts: schema.channelAccounts,
  distribution_plans: schema.distributionPlans,
  distribution_items: schema.distributionItems,
  approvals: schema.approvals,
  jobs: schema.jobs,
  job_events: schema.jobEvents,
  execute_commands: schema.executeCommands,
  audit_events: schema.auditEvents,
};

/** 행의 owner 를 돌려주는 SQL 식(owner_id 가 없는 하위 표는 부모에서 가져온다). */
export function ownerExpr(name: ExportedTable): SQL {
  switch (name) {
    case 'users':
      return sql`"users"."id"`;
    case 'source_versions':
      return sql`(select s.owner_id from sources s where s.id = "source_versions"."source_id")`;
    case 'content_versions':
      return sql`(select c.owner_id from contents c where c.id = "content_versions"."content_id")`;
    default:
      return sql`${sql.identifier(name)}."owner_id"`;
  }
}

/** 묶음에 넣는 열(owner_id 제외). users 는 id 만(식별자는 따로 가려서 넣는다). */
export function bundleColumns(name: ExportedTable): PgColumn[] {
  const cols = Object.values(getTableColumns(BUNDLE_TABLES[name])) as PgColumn[];
  if (name === 'users') return cols.filter((c) => c.name === 'id');
  // FIX-T08 round 2: 파일 삭제 의도(assets.pending_delete_key)는 운영 상태 — 묶음에 넣지 않고 복원 행은 null(다른 파일 삭제를 지시하지 못하게).
  return cols.filter((c) => c.name !== 'owner_id' && !(name === 'assets' && ['pending_delete_key', 'pending_delete_attempts', 'pending_delete_next_at'].includes(c.name)));
}

function selectExpr(name: ExportedTable, c: PgColumn): SQL {
  const ref = sql`${sql.identifier(name)}.${sql.identifier(c.name)}`;
  const type = c.getSQLType();
  if (type.startsWith('timestamp')) return sql`to_char(${ref} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  if (type === 'bigint') return sql`${ref}::float8`;
  return ref;
}

export interface OwnedRow {
  owner: string | null;
  row: Record<string, unknown>;
}

/** where 조건에 맞는 행을 묶음 형식으로 읽는다(id 오름차순). */
export async function selectBundleRows(db: DbOrTx, name: ExportedTable, where: SQL): Promise<OwnedRow[]> {
  const cols = bundleColumns(name);
  const exprs = cols.map((c) => sql`${selectExpr(name, c)} as ${sql.identifier(c.name)}`);
  if (name === 'users') exprs.push(sql`"users"."allowed_identity" as "__identity"`);
  exprs.push(sql`${ownerExpr(name)} as "__owner"`);
  const res = await db.execute(
    sql`select ${sql.join(exprs, sql`, `)} from ${sql.identifier(name)} where ${where} order by ${sql.identifier(name)}."id"`,
  );
  const rows = (res as unknown as { rows: Record<string, unknown>[] }).rows;
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of cols) out[c.name] = r[c.name] ?? null;
    if (name === 'users') out.identity_masked = maskIdentity(String(r.__identity));
    return { owner: (r.__owner as string | null) ?? null, row: out };
  });
}

export const ownerScope = (name: ExportedTable, ownerId: string): SQL => sql`${ownerExpr(name)} = ${ownerId}::uuid`;

export const idIn = (name: ExportedTable, ids: readonly string[]): SQL =>
  sql`${sql.identifier(name)}."id" = any(${sql.param([...ids])}::uuid[])`;

/** JSON 값 → INSERT 값 SQL(열 타입으로 명시 cast). */
export function valueSql(c: PgColumn, v: unknown): SQL {
  if (v === null || v === undefined) return sql`null`;
  const type = c.getSQLType();
  const cast = sql.raw(type === 'jsonb' ? 'jsonb' : type);
  const param = type === 'jsonb' ? JSON.stringify(v) : v;
  return sql`${param}::${cast}`;
}

/**
 * 한 행 INSERT(owner_id 는 현재 owner, overrides 로 특정 열 값 대체). 어떤 unique 충돌이든 삽입하지 않고 false.
 * FK 위반은 호출자가 먼저 부모 존재를 확인해 막는다(트랜잭션이 중단되지 않게).
 */
export async function insertBundleRow(
  db: DbOrTx,
  name: ExportedTable,
  row: Record<string, unknown>,
  ownerId: string,
  overrides: Record<string, unknown> = {},
): Promise<boolean> {
  // 묶음에 넣는 열 + owner_id 만 쓴다 — 묶음에서 뺀 운영 열(assets.pending_delete_* 등)은 DB 기본값을 받는다.
  const bundled = new Set(bundleColumns(name).map((c) => c.name));
  const cols = (Object.values(getTableColumns(BUNDLE_TABLES[name])) as PgColumn[]).filter((c) => c.name === 'owner_id' || bundled.has(c.name));
  const names = cols.map((c) => sql.identifier(c.name));
  const values = cols.map((c) => {
    if (c.name === 'owner_id') return sql`${ownerId}::uuid`;
    const v = c.name in overrides ? overrides[c.name] : row[c.name];
    return valueSql(c, v);
  });
  const res = await db.execute(
    sql`insert into ${sql.identifier(name)} (${sql.join(names, sql`, `)}) values (${sql.join(values, sql`, `)}) on conflict do nothing returning "id"`,
  );
  return (res as unknown as { rows: unknown[] }).rows.length === 1;
}
