/**
 * FIX1-FULLREV2(G3): 복원 PARENTS 에 generation_runs.variant_id → variants, claims.variant_version_id → variant_versions 가 빠져
 * "없는 항목만 추가(add_missing)" 대상에서 미리보기·커밋이 원시 FK 오류(API 500)로 끝나던 결함의 회귀 시험.
 * 결정 D6: 부모가 복원되지 않은 행은 '충돌(dependency)'로 보고만 하고 나머지 복원은 진행한다.
 *  1) 대상 B 에 같은 파생본 V 가 있는데 원본 A 에서 V 에 AI 채널 초안 제안을 받아 채택(V 가 'different') → 그 run·claim·제안 버전은 dependency
 *  2) 대상 B 가 같은 원고에 Threads 파생본을 따로 만들어 A 의 V1 이 unique 충돌 → V1 의 run·claim 은 dependency
 *  3) 대상 B 가 같은(동일) 파생본에 자기 AI 제안(버전 2)을 먼저 받아 A 의 제안 버전 2 가 unique → run 은 들어가고 그 claim 만 dependency
 *     (claims.variant_version_id 항목이 직접 필요한 경우)
 *  4) 경우 1 을 실제 route(POST /api/restores/preview·/commit)로 — 200(이전 500)
 *  5) 가드: DB 카탈로그의 모든 FK(같은 owner 복합 FK 포함)가 RESTORE_PARENTS 에 있거나, 표를 다 넣은 뒤 따로 확인하는 순환 참조 목록에 있다
 *     (새 FK 를 PARENTS 에 넣지 않으면 실패한다).
 * 모의 LLM 만 — 외부 호출 없음. 저장소는 임시 폴더만(./data 를 건드리지 않음).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  adoptVariantProposal,
  bundleColumns,
  closeDb,
  commitRestore,
  createContent,
  createRestorePreview,
  createTestDb,
  createVariantDraft,
  ensureOwner,
  exportOwner,
  getDb,
  parseBundleZip,
  RESTORE_PARENTS,
  runVariantAssist,
  schema,
  seed,
  type Db,
  type RestoreConflict,
  type RestorePreview,
} from '@cs/db';
import { loadConfig, RESTORED_TABLES } from '@cs/domain';
import { LocalStorageAdapter, MockLlmProvider } from '@cs/providers';
import { POST as commitPOST } from '../../apps/web/app/api/restores/[id]/commit/route';
import { POST as previewPOST } from '../../apps/web/app/api/restores/preview/route';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const IDENT = 'owner@example.local';
const BODY = '나는 대리점과 재고 기준을 먼저 합의했다. 가격표는 마지막에 확정했다.';

let tmp: string;
let db: Db; // route 시험의 대상(B) — 앱 전역 DB(memory://)

type Handle = Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fr2-g3-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets-api'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports-api'));
  vi.stubEnv('RESTORE_LOCAL_DIR', path.join(tmp, 'restores-api'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', IDENT);
  db = (await getDb(loadConfig())).db;
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

async function exportZip(source: Db, owner: string, tag: string): Promise<Uint8Array> {
  const ex = await exportOwner(source, new LocalStorageAdapter(path.join(tmp, `assets-src-${tag}`)), owner, { outDir: path.join(tmp, `exports-${tag}`) });
  return new Uint8Array(readFileSync(ex.zipPath));
}
const restoresDir = (tag: string) => path.join(tmp, `restores-${tag}`);
const preview = (target: Db, owner: string, zip: Uint8Array, tag: string) =>
  createRestorePreview(target, owner, zip, { restoresDir: restoresDir(tag), source: 'upload' });
const commit = (target: Db, owner: string, restoreId: string, tag: string, mode: 'empty_only' | 'add_missing') =>
  commitRestore(target, new LocalStorageAdapter(path.join(tmp, `assets-dst-${tag}`)), owner, restoreId, { mode, confirm: true, restoresDir: restoresDir(tag) });

async function withSource(tag: string, fn: (a: Handle, owner: string) => Promise<void>) {
  const a = await createTestDb();
  try {
    const { ownerId } = await seed(a.db, { allowedIdentity: `fr2-g3-src-${tag}@example.local` });
    await fn(a, ownerId);
  } finally {
    await a.close();
  }
}

/** 경우 1 의 원본 준비: 원고 C + Threads 파생본 V → 묶음1. 그 뒤 V 에 AI 제안 → 채택 → 묶음2. */
async function adoptedAfterExport(a: Handle, owner: string, tag: string) {
  const { content } = await createContent(a.db, owner, { title: `G3 ${tag}`, body: BODY });
  const { variant } = await createVariantDraft(a.db, owner, content.id, { channel: 'threads', baseVersion: 1 });
  const zip1 = await exportZip(a.db, owner, `${tag}-1`);
  const assist = await runVariantAssist(a.db, owner, content.id, { channel: 'threads', baseVersion: 1 }, new MockLlmProvider());
  expect(assist.claims.length).toBeGreaterThan(0); // 본문 문장마다 claim(모의 LLM)
  await adoptVariantProposal(a.db, owner, variant.id, assist.proposal.id, 1);
  const zip2 = await exportZip(a.db, owner, `${tag}-2`);
  const parsed = await parseBundleZip(zip2);
  const runId = assist.run.id;
  const claimIds = parsed.tables.claims.filter((c) => c.run_id === runId).map((c) => c.id);
  expect(claimIds.length).toBeGreaterThan(0);
  expect(parsed.tables.claims.filter((c) => c.run_id === runId).every((c) => c.variant_version_id === assist.proposal.id)).toBe(true);
  expect(parsed.tables.generation_runs.find((r) => r.id === runId)?.variant_id).toBe(variant.id);
  const versionIds = parsed.tables.variant_versions.filter((v) => v.variant_id === variant.id && v.version > 1).map((v) => v.id);
  expect(versionIds).toContain(assist.proposal.id);
  return { contentId: content.id, variantId: variant.id, runId, claimIds, versionIds, zip1, zip2 };
}

function expectDependencies(conflicts: readonly RestoreConflict[], s: { variantId: string; runId: string; claimIds: string[]; versionIds: string[] }, variantReason: RestoreConflict['reason']) {
  expect(conflicts).toContainEqual({ table: 'variants', id: s.variantId, reason: variantReason });
  expect(conflicts).toContainEqual({ table: 'generation_runs', id: s.runId, reason: 'dependency' });
  for (const id of s.claimIds) expect(conflicts).toContainEqual({ table: 'claims', id, reason: 'dependency' });
  for (const id of s.versionIds) expect(conflicts).toContainEqual({ table: 'variant_versions', id, reason: 'dependency' });
}

const runCount = async (target: Db, owner: string, runId: string) =>
  (await target.select({ n: count() }).from(schema.generationRuns).where(and(eq(schema.generationRuns.ownerId, owner), eq(schema.generationRuns.id, runId))))[0]!.n;
const claimCount = async (target: Db, owner: string) => (await target.select({ n: count() }).from(schema.claims).where(eq(schema.claims.ownerId, owner)))[0]!.n;
const variantRow = async (target: Db, id: string) => (await target.select().from(schema.variants).where(eq(schema.variants.id, id)))[0]!;

describe('FIX1-FULLREV2(G3): add_missing — 파생본 AI 실행·claim 의 부모가 빠지면 dependency 충돌(원시 FK 오류 아님)', () => {
  it('경우 1: 대상의 같은 파생본이 묶음과 다름(원본에서 AI 제안 채택) → run·claim·제안/채택 버전은 dependency, 미리보기·커밋 성공', async () => {
    await withSource('c1', async (a, src) => {
      const s = await adoptedAfterExport(a, src, 'c1');
      const b = await createTestDb();
      try {
        const target = (await ensureOwner(b.db, 'fr2-g3-dst-c1@example.local')).id;
        const p1 = await preview(b.db, target, s.zip1, 'c1');
        await commit(b.db, target, p1.restoreId, 'c1', 'empty_only');
        const before = await variantRow(b.db, s.variantId);
        const claimsBefore = await claimCount(b.db, target);

        // 수정 전: claims_variant_version_id_variant_versions_id_fk 위반으로 createRestorePreview 가 던졌다(→ API 500)
        const p2 = await preview(b.db, target, s.zip2, 'c1');
        expectDependencies(p2.preview.conflicts, s, 'different');
        expect(p2.preview.tables.generation_runs).toMatchObject({ new: 0 });
        expect(p2.preview.tables.claims).toMatchObject({ new: 0 });
        expect(p2.preview.can_commit_add_missing).toBe(true);

        const r = await commit(b.db, target, p2.restoreId, 'c1', 'add_missing');
        expect(r.mode).toBe('add_missing');
        expectDependencies(r.conflicts, s, 'different');
        // 기존(다른) 파생본 밑에 run·claim 을 붙이지 않았고, 그 파생본은 그대로
        expect(await runCount(b.db, target, s.runId)).toBe(0);
        expect(await claimCount(b.db, target)).toBe(claimsBefore);
        expect(await variantRow(b.db, s.variantId)).toEqual(before);
      } finally {
        await b.close();
      }
    });
  });

  it('경우 2: 대상이 같은 원고에 Threads 파생본을 따로 만들어 묶음의 V1 이 unique 충돌 → V1 의 run·claim·버전은 dependency, 미리보기·커밋 성공', async () => {
    await withSource('c2', async (a, src) => {
      const { content } = await createContent(a.db, src, { title: 'G3 c2', body: BODY });
      const zip1 = await exportZip(a.db, src, 'c2-1');
      const b = await createTestDb();
      try {
        const target = (await ensureOwner(b.db, 'fr2-g3-dst-c2@example.local')).id;
        const p1 = await preview(b.db, target, zip1, 'c2');
        await commit(b.db, target, p1.restoreId, 'c2', 'empty_only');
        const { variant: own } = await createVariantDraft(b.db, target, content.id, { channel: 'threads', baseVersion: 1 });
        const ownBefore = await variantRow(b.db, own.id);

        const { variant: v1 } = await createVariantDraft(a.db, src, content.id, { channel: 'threads', baseVersion: 1 });
        const assist = await runVariantAssist(a.db, src, content.id, { channel: 'threads', baseVersion: 1 }, new MockLlmProvider());
        const zip2 = await exportZip(a.db, src, 'c2-2');
        const parsed = await parseBundleZip(zip2);
        const s = {
          variantId: v1.id,
          runId: assist.run.id,
          claimIds: parsed.tables.claims.filter((c) => c.run_id === assist.run.id).map((c) => c.id),
          versionIds: parsed.tables.variant_versions.filter((v) => v.variant_id === v1.id).map((v) => v.id),
        };
        expect(s.claimIds.length).toBeGreaterThan(0);

        // 수정 전: generation_runs_variant_same_owner_fk 위반으로 던졌다
        const p2 = await preview(b.db, target, zip2, 'c2');
        expectDependencies(p2.preview.conflicts, s, 'unique');
        expect(p2.preview.can_commit_add_missing).toBe(true);
        const r = await commit(b.db, target, p2.restoreId, 'c2', 'add_missing');
        expectDependencies(r.conflicts, s, 'unique');
        expect(await runCount(b.db, target, s.runId)).toBe(0);
        expect(await variantRow(b.db, own.id)).toEqual(ownBefore);
        expect((await b.db.select({ n: count() }).from(schema.variants).where(eq(schema.variants.id, v1.id)))[0]!.n).toBe(0);
      } finally {
        await b.close();
      }
    });
  });

  it('경우 3: 대상이 같은 파생본(동일)에 자기 AI 제안(버전 2)을 먼저 받음 → 묶음의 제안 버전 2 는 unique, run 은 들어가고 그 claim 만 dependency', async () => {
    await withSource('c3', async (a, src) => {
      const { content } = await createContent(a.db, src, { title: 'G3 c3', body: BODY });
      const { variant } = await createVariantDraft(a.db, src, content.id, { channel: 'threads', baseVersion: 1 });
      const zip1 = await exportZip(a.db, src, 'c3-1');
      const b = await createTestDb();
      try {
        const target = (await ensureOwner(b.db, 'fr2-g3-dst-c3@example.local')).id;
        const p1 = await preview(b.db, target, zip1, 'c3');
        await commit(b.db, target, p1.restoreId, 'c3', 'empty_only');
        const mine = await runVariantAssist(b.db, target, content.id, { channel: 'threads', baseVersion: 1 }, new MockLlmProvider());
        const claimsBefore = await claimCount(b.db, target);

        const assist = await runVariantAssist(a.db, src, content.id, { channel: 'threads', baseVersion: 1 }, new MockLlmProvider());
        expect(assist.proposal.version).toBe(mine.proposal.version);
        const zip2 = await exportZip(a.db, src, 'c3-2');
        const parsed = await parseBundleZip(zip2);
        const claimIds = parsed.tables.claims.filter((c) => c.run_id === assist.run.id).map((c) => c.id);
        expect(claimIds.length).toBeGreaterThan(0);

        // 수정 전: run 은 들어가고(파생본·원고·입력 버전이 모두 동일) claim 에서 claims_variant_version_id_variant_versions_id_fk 위반
        const p2 = await preview(b.db, target, zip2, 'c3');
        const conflicts = p2.preview.conflicts;
        expect(conflicts).toContainEqual({ table: 'variant_versions', id: assist.proposal.id, reason: 'unique' });
        expect(conflicts.some((c) => c.table === 'generation_runs' && c.id === assist.run.id)).toBe(false);
        expect(conflicts.some((c) => c.table === 'variants' && c.id === variant.id)).toBe(false);
        for (const id of claimIds) expect(conflicts).toContainEqual({ table: 'claims', id, reason: 'dependency' });
        const r = await commit(b.db, target, p2.restoreId, 'c3', 'add_missing');
        for (const id of claimIds) expect(r.conflicts).toContainEqual({ table: 'claims', id, reason: 'dependency' });
        expect(await runCount(b.db, target, assist.run.id)).toBe(1);
        expect(await claimCount(b.db, target)).toBe(claimsBefore);
      } finally {
        await b.close();
      }
    });
  });

  it('경우 1 을 route 로: POST /api/restores/preview(application/zip) 200 + dependency 충돌, POST /api/restores/{id}/commit(add_missing) 200 — 이전에는 500', async () => {
    const target = (await ensureOwner(db, IDENT)).id;
    const token = await login(IDENT);
    await withSource('api', async (a, src) => {
      const s = await adoptedAfterExport(a, src, 'api');
      const p1 = await createRestorePreview(db, target, s.zip1, { restoresDir: path.join(tmp, 'restores-api'), source: 'upload' });
      await commitRestore(db, new LocalStorageAdapter(path.join(tmp, 'assets-api')), target, p1.restoreId, {
        mode: 'empty_only',
        confirm: true,
        restoresDir: path.join(tmp, 'restores-api'),
      });

      const res = await previewPOST(
        new Request(`${BASE}/api/restores/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/zip', accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) },
          body: s.zip2 as Uint8Array<ArrayBuffer>,
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { restore_id: string; preview: RestorePreview };
      expectDependencies(body.preview.conflicts, s, 'different');

      const c = await commitPOST(jsonPost(`/api/restores/${body.restore_id}/commit`, { mode: 'add_missing', confirm: true }, cookieHeader(token)), {
        params: Promise.resolve({ id: body.restore_id }),
      });
      expect(c.status).toBe(200);
      expectDependencies(((await c.json()) as { conflicts: RestoreConflict[] }).conflicts, s, 'different');
      expect(await runCount(db, target, s.runId)).toBe(0);
    });
  });
});

/**
 * FK 가 아니라 applyBundle 이 모든 표를 넣은 뒤 따로 확인하는 순환 참조(PARENTS 에 넣으면 부모 표가 뒤라 언제나 dependency 가 된다):
 * 원고·파생본 현재 버전 연결, AI 채택 버전의 run(orphanOf), 전사 작업의 첫 전사. 지금은 DB FK 가 아니다 — FK 가 생기면 이 목록이 그것을 받는다.
 */
const POST_CHECKED: Record<string, string> = {
  'contents.current_version_id': 'content_versions',
  'variants.current_version_id': 'variant_versions',
  'content_versions.ai_run_id': 'generation_runs',
  'variant_versions.ai_run_id': 'generation_runs',
  'transcription_jobs.transcript_version_id': 'transcripts',
};

interface CatalogFk {
  conname: string;
  child: string;
  parent: string;
  cols: string[];
  pcols: string[];
}

describe('FIX1-FULLREV2(G3) 가드: 복원 표의 모든 FK = RESTORE_PARENTS(+ 사후 검사 목록)', () => {
  let fks: CatalogFk[];
  beforeAll(async () => {
    const h = await createTestDb();
    try {
      const r = await h.db.execute(sql`
        select c.conname, cl.relname as child, pcl.relname as parent,
          (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols,
          (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as pcols
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_class pcl on pcl.oid = c.confrelid
        join pg_namespace n on n.oid = cl.relnamespace
        where c.contype = 'f' and n.nspname = 'public'
        order by 2, 1`);
      fks = (r as unknown as { rows: CatalogFk[] }).rows;
    } finally {
      await h.close();
    }
  }, 120_000);

  const restored = new Set<string>(RESTORED_TABLES);
  /** 복원 표의 FK 를 'child.col → parent' 로(owner_id → users 는 제외, 같은 owner 복합 FK 는 owner_id 를 뺀 열). */
  const restoredRefs = () => {
    const out = new Map<string, string>();
    for (const fk of fks.filter((f) => restored.has(f.child))) {
      if (fk.parent === 'users' && fk.cols.length === 1 && fk.cols[0] === 'owner_id') continue;
      const sameOwner = fk.cols.length === 2 && fk.cols[1] === 'owner_id' && fk.pcols.length === 2 && fk.pcols[0] === 'id' && fk.pcols[1] === 'owner_id';
      const single = fk.cols.length === 1 && fk.pcols.length === 1 && fk.pcols[0] === 'id';
      expect(sameOwner || single, `${fk.conname}: (열, owner_id) → (id, owner_id) 또는 열 → id 모양이어야 한다`).toBe(true);
      expect(restored.has(fk.parent), `${fk.conname}: 부모 ${fk.parent} 가 복원 표가 아니다 — applyBundle 이 그 행을 넣을 수 없다`).toBe(true);
      out.set(`${fk.child}.${fk.cols[0]}`, fk.parent);
    }
    return out;
  };

  it('카탈로그를 읽었다(같은 owner 복합 FK 포함)', () => {
    expect(fks.some((f) => f.conname === 'generation_runs_variant_same_owner_fk' && f.cols.join() === 'variant_id,owner_id')).toBe(true);
    expect(fks.some((f) => f.conname === 'claims_variant_version_id_variant_versions_id_fk' && f.cols.join() === 'variant_version_id')).toBe(true);
  });

  it('복원 표의 모든 FK 가 RESTORE_PARENTS(같은 부모 표) 또는 사후 검사 목록에 있다 — 새 FK 를 PARENTS 에 넣지 않으면 실패', () => {
    const missing: string[] = [];
    for (const [ref, parent] of restoredRefs()) {
      const [child, col] = ref.split('.') as [keyof typeof RESTORE_PARENTS, string];
      const inParents = (RESTORE_PARENTS[child] ?? []).some((p) => p.col === col && p.table === parent);
      if (!inParents && POST_CHECKED[ref] !== parent) missing.push(`${ref} → ${parent}`);
    }
    expect(missing).toEqual([]);
  });

  it('RESTORE_PARENTS 의 모든 항목은 실제 FK 이고, 그 열이 묶음에 있으며, 부모 표가 복원 순서에서 먼저 온다(avail 이 채워져 있음)', () => {
    const refs = restoredRefs();
    const order = RESTORED_TABLES as readonly string[];
    for (const [child, parents] of Object.entries(RESTORE_PARENTS)) {
      const cols = bundleColumns(child as (typeof RESTORED_TABLES)[number]).map((c) => c.name);
      for (const p of parents ?? []) {
        const ref = `${child}.${p.col}`;
        expect(refs.get(ref), `${ref} 는 DB FK 가 아니거나 부모 표가 다르다`).toBe(p.table);
        expect(cols, ref).toContain(p.col);
        expect(order.indexOf(p.table), `${ref}: 부모 ${p.table} 가 ${child} 보다 먼저 복원되어야 한다`).toBeLessThan(order.indexOf(child));
      }
    }
  });

  it('사후 검사 목록의 열은 묶음에 있고 PARENTS 에는 없다(순환 — PARENTS 로 두면 언제나 dependency)', () => {
    const order = RESTORED_TABLES as readonly string[];
    for (const [ref, parent] of Object.entries(POST_CHECKED)) {
      const [child, col] = ref.split('.') as [(typeof RESTORED_TABLES)[number], string];
      expect(bundleColumns(child).map((c) => c.name), ref).toContain(col);
      expect((RESTORE_PARENTS[child] ?? []).some((p) => p.col === col), ref).toBe(false);
      expect(order).toContain(parent);
    }
  });
});
