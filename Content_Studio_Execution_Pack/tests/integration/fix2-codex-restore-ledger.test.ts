/**
 * FIX2-CODEX(U1 — Codex review-LIVEL1H2 Q5, 사용자 결정 2026-10-23 "다 권고 사항으로 진행해줘"): 복원 미리보기가 복원 뒤 이 owner 의 AI 비용 원장이
 * 묶음의 비용 이력보다 빠지는 경우를 경고한다(`ledger_history_incomplete`, 건수만 — 금액·ID 없음). 복원은 막지 않는다.
 * 실제로 일어나는 경우만 본다:
 *  - "없는 항목만 추가"에서 묶음의 원장 행이 의존성(원고가 대상에서 바뀌어 run 이 빠짐)·다른 계정이 쓰는 ID 로 들어가지 않음
 *  - 복원 뒤 원장 행이 없는 AI 실행(원장 도입(0008) 전 실행 — 원본에서 원장 행을 지워 흉내)·전사 작업(검증기가 받는 묶음에서 원장만 뺌)
 * FIX2-CODEX(U1 fixup — 독립 검토 P2): 같은 ID 원장이 이미 이 계정에 있어 내용만 다른 경우(different — 내보낸 뒤 정산·취소·ledger:resolve,
 * 복원 커밋이 전사 예약을 확정한 행)와 같은 실행의 원장이 다른 ID 로 이미 이 계정에 있는 경우(unique)는 그 행이 남아 월 합계에 들어가므로 세지 않는다
 * (표 미리보기의 충돌 목록에는 그대로 나온다). 이전에는 이 경우도 "들어가지 않음 … 적게 잡힐 수 있음"으로 경고했다.
 * 표 선택(일부 표만 복원) 경로는 없다(묶음은 언제나 모든 표 — usage_ledger 도 복원 대상) — 시험하지 않는다.
 * 완전한 묶음은 경고가 없고, 기존 경고(asset_missing·ledger_currency_mismatch)는 그대로다. 모의 LLM·모의 전사만 — 외부 호출 없음.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import {
  appendContentVersion,
  closeDb,
  commitRestore,
  createContent,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  getDb,
  monthlyUsage,
  parseBundleZip,
  requestTranscription,
  runAssist,
  schema,
  type Db,
  type RestorePreview,
} from '@cs/db';
import { buildAssetKey, buildBundle, loadConfig, sha256Hex, sttBudgetPolicy, writeZip, type BundleTables, type ParsedBundle } from '@cs/domain';
import { LocalStorageAdapter, MockLlmProvider } from '@cs/providers';
import { POST as exportsPOST } from '../../apps/web/app/api/exports/route';
import { POST as previewPOST } from '../../apps/web/app/api/restores/preview/route';
import { cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';

let db: Db;
let tmp: string;
let storageDir: string;

/** 경고 문구(명세 그대로 — 구현을 부르지 않는다) */
const HEAD = 'AI 비용 이력이 완전하지 않습니다: ';
const TAIL = '. 복원은 되지만, 이 계정의 월 비용 이력과 예산 합계가 실제 사용보다 적게 잡힐 수 있습니다.';
const notRestored = (n: number) => `"없는 항목만 추가"로 복원해도 묶음의 비용 원장 ${n}건은 들어가지 않습니다(충돌·의존성 — 기존 행은 덮어쓰지 않음)`;
const leftWithout = (subjects: string) => `복원 뒤에도 비용 원장이 없는 ${subjects}이 남습니다`;
const historyWarning = (...parts: string[]) => ({ code: 'ledger_history_incomplete', message: `${HEAD}${parts.join('. ')}${TAIL}` });
const historyOf = (p: RestorePreview) => p.warnings.filter((w) => w.code === 'ledger_history_incomplete');

const storage = () => new LocalStorageAdapter(storageDir);
const draft = { mode: 'draft' as const, baseVersion: 1, brandProfileVersion: 1, answerIds: [] };

async function freshOwner(identity: string) {
  const owner = (await ensureOwner(db, identity)).id;
  await db.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
  return owner;
}

/** owner 의 원고 1개 + 모의 AI 실행 n개(실행마다 원장 1행) */
async function withRuns(owner: string, n: number) {
  const c = await createContent(db, owner, { title: `U1 ${randomUUID().slice(0, 6)}`, body: '본문.' });
  const runs = [];
  for (let i = 0; i < n; i++) runs.push(await runAssist(db, owner, c.content.id, draft, new MockLlmProvider()));
  return { contentId: c.content.id, runs };
}

async function exportZip(owner: string, tag: string) {
  const exported = await exportOwner(db, storage(), owner, { outDir: path.join(tmp, `exports-${tag}`) });
  return new Uint8Array(readFileSync(exported.zipPath));
}

/** 검증된 묶음의 표를 고친 뒤 buildBundle(manifest 해시 다시 계산) → zip(복원 검증기가 받는 묶음) */
function rebuiltZip(parsed: ParsedBundle, mutate: (t: BundleTables) => void) {
  const t = structuredClone(parsed.tables) as BundleTables;
  mutate(t);
  const bundle = buildBundle({
    exportId: randomUUID(),
    exportedAt: new Date().toISOString(),
    appVersion: parsed.manifest.app_version,
    migrations: parsed.manifest.schema_migrations,
    owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
    tables: t,
    assetBytes: new Map(parsed.assetBytes),
  });
  return writeZip(bundle.entries);
}

type Handle = Awaited<ReturnType<typeof createTestDb>>;
async function withTarget(tag: string, fn: (h: Handle, target: string, restoresDir: string) => Promise<void>) {
  const h = await createTestDb();
  try {
    const target = (await ensureOwner(h.db, `restore-fix2-codex-${tag}@example.local`)).id;
    await fn(h, target, path.join(tmp, `restores-${tag}`));
  } finally {
    await h.close();
  }
}
const preview = (h: Handle, target: string, zip: Uint8Array, restoresDir: string, budgetCurrency?: string) =>
  createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload', budgetCurrency });
const commit = (h: Handle, target: string, restoreId: string, restoresDir: string, mode: 'empty_only' | 'add_missing') =>
  commitRestore(h.db, new LocalStorageAdapter(path.join(restoresDir, 'assets')), target, restoreId, { mode, confirm: true, restoresDir });
const ledgerCount = async (h: Handle, owner: string) => (await h.db.select({ n: count() }).from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, owner)))[0]!.n;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix2-codex-u1-'));
  storageDir = path.join(tmp, 'assets');
  vi.stubEnv('STORAGE_LOCAL_DIR', storageDir);
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports-api'));
  vi.stubEnv('RESTORE_LOCAL_DIR', path.join(tmp, 'restores-api'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('FIX2-CODEX(U1): 복원 미리보기 — 비용 원장 누락 경고(건수만, 복원은 막지 않음)', () => {
  it('완전한 묶음 → 경고 없음: 빈 대상(empty_only 가능), 커밋 뒤 같은 묶음을 다시 미리보기(모두 동일)해도 없음', async () => {
    const owner = await freshOwner('fix2-codex-u1-full@example.local');
    await withRuns(owner, 2);
    const zip = await exportZip(owner, 'full');
    await withTarget('full', async (h, target, restoresDir) => {
      const p = await preview(h, target, zip, restoresDir);
      expect(p.preview.warnings).toEqual([]);
      expect(p.preview.tables.usage_ledger).toMatchObject({ in_bundle: 2, new: 2, existing_different: 0 });
      expect(p.preview.can_commit_empty_only).toBe(true);
      await commit(h, target, p.restoreId, restoresDir, 'empty_only');
      expect(await ledgerCount(h, target)).toBe(2);
      const again = await preview(h, target, zip, restoresDir);
      expect(again.preview.tables.usage_ledger).toMatchObject({ in_bundle: 2, new: 0, existing_same: 2, existing_different: 0 });
      expect(again.preview.warnings).toEqual([]);
    });
  });

  it('add_missing · 같은 ID 원장이 대상에서 달라짐(different) → 그 행은 이 계정에 남아 월 합계에 들어가므로 비용 이력 경고 없음(충돌 목록에는 나옴), "없는 항목만 추가" 커밋은 그대로 되고 대상 원장은 덮어쓰지 않는다', async () => {
    const owner = await freshOwner('fix2-codex-u1-diff@example.local');
    const { runs } = await withRuns(owner, 2);
    const zip = await exportZip(owner, 'diff');
    await withTarget('diff', async (h, target, restoresDir) => {
      const first = await preview(h, target, zip, restoresDir);
      await commit(h, target, first.restoreId, restoresDir, 'empty_only');
      const usedBefore = (await monthlyUsage(h.db, target)).byCurrency;
      // 대상에서 원장 한 행이 바뀐다(묶음과 내용이 다름)
      const changed = runs[0]!.ledger.id;
      await h.db.update(schema.usageLedger).set({ failed: true }).where(and(eq(schema.usageLedger.id, changed), eq(schema.usageLedger.ownerId, target)));
      const p = await preview(h, target, zip, restoresDir);
      expect(p.preview.conflicts).toEqual([{ table: 'usage_ledger', id: changed, reason: 'different' }]);
      expect(p.preview.tables.usage_ledger).toMatchObject({ in_bundle: 2, new: 0, existing_same: 1, existing_different: 1 });
      // FIX2-CODEX(U1 fixup — 이전: notRestored(1) 경고): 같은 ID 원장이 이 계정에 있고 월 합계가 그 행을 더한다 → "들어가지 않음·적게 잡힘"이 아니다
      expect(historyOf(p.preview)).toEqual([]);
      expect(p.preview.warnings).toEqual([]);
      // 막지 않는다: 지금처럼 add_missing 커밋은 된다(충돌로 보고, 덮어쓰지 않음)
      expect(p.preview.can_commit_add_missing).toBe(true);
      const res = await commit(h, target, p.restoreId, restoresDir, 'add_missing');
      expect(res.conflicts).toEqual([{ table: 'usage_ledger', id: changed, reason: 'different' }]);
      const [row] = await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, changed));
      expect(row!.failed).toBe(true);
      expect(await ledgerCount(h, target)).toBe(2);
      // 바뀐 행도 이 계정의 이번 달 사용액에 그대로 들어간다(금액·건수 그대로 — 적게 잡히지 않음)
      expect((await monthlyUsage(h.db, target)).byCurrency).toEqual(usedBefore);
      expect(usedBefore.reduce((n, u) => n + u.runs, 0)).toBe(2);
    });
  });

  it('앱이 만든 경우(검토 시나리오): 전사 작업이 대기 중일 때 내보낸 ZIP 을 커밋(복원이 그 예약 원장을 예약액으로 확정) → 같은 ZIP 다시 미리보기는 원장 different 지만 비용 이력 경고 없음', async () => {
    const owner = await freshOwner('fix2-codex-u1-settle@example.local');
    await withRuns(owner, 1);
    const audio = new TextEncoder().encode(`fix2-codex-u1 settle audio ${randomUUID()}`);
    const assetId = randomUUID();
    const key = buildAssetKey(owner, assetId);
    await storage().put(key, audio);
    await db.insert(schema.assets).values({ id: assetId, ownerId: owner, key, mime: 'audio/mpeg', bytes: audio.byteLength, checksum: sha256Hex(audio), verificationState: 'VERIFIED' });
    const job = await requestTranscription(db, owner, assetId, { keepOriginal: true, policy: sttBudgetPolicy(loadConfig()), model: 'mock', durationSeconds: 30 });
    const zip = await exportZip(owner, 'settle');
    const parsed = await parseBundleZip(zip);
    const sttLedger = parsed.tables.usage_ledger.filter((l) => l.transcription_job_id === job.id);
    expect(sttLedger.map((l) => l.state)).toEqual(['reserved']);
    await withTarget('settle', async (h, target, restoresDir) => {
      const first = await preview(h, target, zip, restoresDir);
      expect(first.preview.warnings).toEqual([]);
      const done = await commit(h, target, first.restoreId, restoresDir, 'empty_only');
      expect(done.interrupted_transcriptions).toEqual([job.id]);
      const [settled] = await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, sttLedger[0]!.id));
      expect([settled!.ownerId, settled!.state, settled!.failed, settled!.actualAmount]).toEqual([target, 'settled', true, settled!.reservedAmount]);
      const again = await preview(h, target, zip, restoresDir);
      expect(again.preview.conflicts.filter((c) => c.table === 'usage_ledger')).toEqual([{ table: 'usage_ledger', id: settled!.id, reason: 'different' }]);
      expect(historyOf(again.preview)).toEqual([]);
      expect(again.preview.warnings).toEqual([]);
      // 그 원장은 이 계정의 이번 달 사용액에 들어간다(실행 1 + 전사 1 = 원장 2행)
      expect((await monthlyUsage(h.db, target)).byCurrency.reduce((n, u) => n + u.runs, 0)).toBe(2);
    });
  });

  it('다른 계정이 쓰는 ID(id_in_use): 같은 묶음을 이 DB 의 다른 계정에 먼저 복원 → 대상에는 원장이 하나도 남지 않으므로 2건 경고(건수만 — ID·금액 없음)', async () => {
    const owner = await freshOwner('fix2-codex-u1-inuse@example.local');
    const { runs } = await withRuns(owner, 2);
    const zip = await exportZip(owner, 'inuse');
    await withTarget('inuse', async (h, target, restoresDir) => {
      const other = (await ensureOwner(h.db, 'restore-fix2-codex-inuse-other@example.local')).id;
      const first = await preview(h, other, zip, restoresDir);
      await commit(h, other, first.restoreId, restoresDir, 'empty_only');
      const p = await preview(h, target, zip, restoresDir);
      const ledgerConflicts = p.preview.conflicts.filter((c) => c.table === 'usage_ledger');
      expect(ledgerConflicts.map((c) => c.reason)).toEqual(['id_in_use', 'id_in_use']);
      expect(ledgerConflicts.map((c) => c.id).sort()).toEqual(runs.map((r) => r.ledger.id).sort());
      expect(historyOf(p.preview)).toEqual([historyWarning(notRestored(2))]);
      expect(p.preview.warnings).toEqual([historyWarning(notRestored(2))]);
      // 건수만 — 원장·run·owner ID 와 금액 모양이 없다
      const msg = historyOf(p.preview)[0]!.message;
      for (const v of [...runs.flatMap((r) => [r.ledger.id, r.run.id]), owner, target, other]) expect(msg).not.toContain(v);
      expect(msg).not.toMatch(/\d+\.\d+/);
      expect(p.preview.can_commit_add_missing).toBe(true);
      await commit(h, target, p.restoreId, restoresDir, 'add_missing');
      expect([await ledgerCount(h, target), await ledgerCount(h, other)]).toEqual([0, 2]);
    });
  });

  it('같은 실행의 원장이 다른 ID 로 이미 이 계정에 있음(unique — 원장 ID 만 바꾼 묶음) → 그 실행의 비용은 기존 행으로 월 합계에 들어가므로 경고 없음(충돌 목록에는 나옴)', async () => {
    const owner = await freshOwner('fix2-codex-u1-unique@example.local');
    const { runs } = await withRuns(owner, 2);
    const zip = await exportZip(owner, 'unique');
    const parsed = await parseBundleZip(zip);
    const swapped = randomUUID();
    const swappedZip = rebuiltZip(parsed, (t) => {
      t.usage_ledger = t.usage_ledger.map((l) => (l.id === runs[0]!.ledger.id ? { ...l, id: swapped } : l));
    });
    await withTarget('unique', async (h, target, restoresDir) => {
      const first = await preview(h, target, zip, restoresDir);
      await commit(h, target, first.restoreId, restoresDir, 'empty_only');
      const p = await preview(h, target, swappedZip, restoresDir);
      expect(p.preview.conflicts).toEqual([{ table: 'usage_ledger', id: swapped, reason: 'unique' }]);
      expect(p.preview.tables.usage_ledger).toMatchObject({ in_bundle: 2, new: 0, existing_same: 1, existing_different: 1 });
      expect(p.preview.warnings).toEqual([]);
      // 그 실행의 원장(원래 ID)은 이 계정에 있다
      const [kept] = await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.runId, runs[0]!.run.id));
      expect([kept!.id, kept!.ownerId]).toEqual([runs[0]!.ledger.id, target]);
    });
  });

  it('add_missing · 대상에서 원고를 고쳐 묶음의 새 run 2개·원장 2행이 의존성으로 빠짐 → 2건 경고(빠진 run 은 대상에 없으므로 "원장 없는 실행"은 아님)', async () => {
    const owner = await freshOwner('fix2-codex-u1-dep@example.local');
    const { contentId } = await withRuns(owner, 1);
    const zip1 = await exportZip(owner, 'dep-1');
    await withTarget('dep', async (h, target, restoresDir) => {
      const first = await preview(h, target, zip1, restoresDir);
      await commit(h, target, first.restoreId, restoresDir, 'empty_only');
      await appendContentVersion(h.db, target, contentId, { baseVersion: 1, body: '대상에서 고침' });
      const r2 = await runAssist(db, owner, contentId, draft, new MockLlmProvider());
      const r3 = await runAssist(db, owner, contentId, draft, new MockLlmProvider());
      const zip2 = await exportZip(owner, 'dep-2');
      const p = await preview(h, target, zip2, restoresDir);
      expect(p.preview.conflicts).toEqual(
        expect.arrayContaining([
          { table: 'contents', id: contentId, reason: 'different' },
          { table: 'generation_runs', id: r2.run.id, reason: 'dependency' },
          { table: 'generation_runs', id: r3.run.id, reason: 'dependency' },
          { table: 'usage_ledger', id: r2.ledger.id, reason: 'dependency' },
          { table: 'usage_ledger', id: r3.ledger.id, reason: 'dependency' },
        ]),
      );
      expect(p.preview.tables.usage_ledger).toMatchObject({ in_bundle: 3, existing_same: 1, existing_different: 2 });
      expect(p.preview.warnings).toEqual([historyWarning(notRestored(2))]);
      const res = await commit(h, target, p.restoreId, restoresDir, 'add_missing');
      expect(res.restored.usage_ledger).toBe(0);
      expect(await ledgerCount(h, target)).toBe(1); // 원본은 3행 — 미리보기가 말한 2행이 빠졌다
    });
  });

  it('원장 없는 AI 실행(원장 도입 전 실행 — 원본에서 원장 행을 지워 흉내)이 든 묶음 → 빈 대상에도 1건 경고, empty_only 커밋은 그대로 된다', async () => {
    const owner = await freshOwner('fix2-codex-u1-legacy@example.local');
    const { runs } = await withRuns(owner, 2);
    await db.delete(schema.usageLedger).where(eq(schema.usageLedger.id, runs[0]!.ledger.id));
    const zip = await exportZip(owner, 'legacy');
    const parsed = await parseBundleZip(zip);
    expect([parsed.tables.generation_runs.length, parsed.tables.usage_ledger.length]).toEqual([2, 1]);
    await withTarget('legacy', async (h, target, restoresDir) => {
      const p = await preview(h, target, zip, restoresDir);
      expect(p.preview.conflicts_total).toBe(0);
      expect(p.preview.warnings).toEqual([historyWarning(leftWithout('AI 실행 1건'))]);
      expect(p.preview.can_commit_empty_only).toBe(true);
      const res = await commit(h, target, p.restoreId, restoresDir, 'empty_only');
      expect([res.restored.generation_runs, res.restored.usage_ledger]).toEqual([2, 1]);
    });
  });

  it('검증기가 받는 묶음에서 run 원장 1행·전사 작업 원장 1행을 뺌 → "AI 실행 1건·전사 작업 1건" 경고(원장 충돌 없음)', async () => {
    const owner = await freshOwner('fix2-codex-u1-stt@example.local');
    const { runs } = await withRuns(owner, 2);
    const audio = new TextEncoder().encode(`fix2-codex-u1 audio ${randomUUID()}`);
    const assetId = randomUUID();
    const key = buildAssetKey(owner, assetId);
    await storage().put(key, audio);
    await db.insert(schema.assets).values({ id: assetId, ownerId: owner, key, mime: 'audio/mpeg', bytes: audio.byteLength, checksum: sha256Hex(audio), verificationState: 'VERIFIED' });
    const job = await requestTranscription(db, owner, assetId, { keepOriginal: true, policy: sttBudgetPolicy(loadConfig()), model: 'mock', durationSeconds: 30 });
    const parsed = await parseBundleZip(await exportZip(owner, 'stt'));
    expect(parsed.manifest.warnings).toEqual([]);
    expect(parsed.tables.usage_ledger.filter((l) => l.transcription_job_id === job.id)).toHaveLength(1);
    const zip = rebuiltZip(parsed, (t) => {
      t.usage_ledger = t.usage_ledger.filter((l) => l.transcription_job_id !== job.id && l.run_id !== runs[1]!.run.id);
    });
    await withTarget('stt', async (h, target, restoresDir) => {
      const p = await preview(h, target, zip, restoresDir);
      expect(p.preview.conflicts_total).toBe(0);
      expect(p.preview.warnings).toEqual([historyWarning(leftWithout('AI 실행 1건·전사 작업 1건'))]);
      // 대조: 고치지 않은 같은 원본 묶음은 경고 없음
      const full = await preview(h, target, rebuiltZip(parsed, () => undefined), restoresDir);
      expect(full.preview.warnings).toEqual([]);
    });
  });

  it('둘 다: 원장 없는 실행이 든 묶음을 복원한 뒤 대상에서 원장 한 행이 바뀌고(different — 세지 않음) 원고를 고쳐 새 run 원장 1행이 의존성으로 빠짐 → 한 경고에 두 건수(의존성 1 · 원장 없는 실행 1)', async () => {
    const owner = await freshOwner('fix2-codex-u1-both@example.local');
    const { contentId, runs } = await withRuns(owner, 2);
    await db.delete(schema.usageLedger).where(eq(schema.usageLedger.id, runs[0]!.ledger.id));
    const zip = await exportZip(owner, 'both');
    await withTarget('both', async (h, target, restoresDir) => {
      const first = await preview(h, target, zip, restoresDir);
      await commit(h, target, first.restoreId, restoresDir, 'empty_only');
      await h.db.update(schema.usageLedger).set({ failed: true }).where(eq(schema.usageLedger.id, runs[1]!.ledger.id));
      // FIX2-CODEX(U1 fixup — 이전: 같은 묶음에 notRestored(1) + 원장 없는 실행 1): 바뀐 원장(different)은 이 계정에 남으므로 원장 없는 실행만 남는다
      const same = await preview(h, target, zip, restoresDir);
      expect(same.preview.conflicts).toEqual([{ table: 'usage_ledger', id: runs[1]!.ledger.id, reason: 'different' }]);
      expect(same.preview.warnings).toEqual([historyWarning(leftWithout('AI 실행 1건'))]);
      // 대상에서 원고를 고친 뒤 원본에서 새 실행 → 새 묶음의 그 run·원장은 의존성으로 빠진다(진짜로 이 계정에 남지 않는 원장)
      await appendContentVersion(h.db, target, contentId, { baseVersion: 1, body: '대상에서 고침' });
      const r2 = await runAssist(db, owner, contentId, draft, new MockLlmProvider());
      const zip2 = await exportZip(owner, 'both-2');
      const p = await preview(h, target, zip2, restoresDir);
      const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
      expect(p.preview.conflicts.filter((c) => c.table === 'usage_ledger').sort(byId)).toEqual(
        [
          { table: 'usage_ledger', id: runs[1]!.ledger.id, reason: 'different' },
          { table: 'usage_ledger', id: r2.ledger.id, reason: 'dependency' },
        ].sort(byId),
      );
      expect(p.preview.tables.usage_ledger).toMatchObject({ in_bundle: 2, new: 0, existing_same: 0, existing_different: 2 });
      expect(p.preview.warnings).toEqual([historyWarning(notRestored(1), leftWithout('AI 실행 1건'))]);
    });
  });

  it('기존 경고는 그대로: manifest(asset_missing) → 통화(ledger_currency_mismatch) 다음에 새 경고 — 완전한 묶음은 기존 두 경고만', async () => {
    const owner = await freshOwner('fix2-codex-u1-existing@example.local');
    const { runs } = await withRuns(owner, 2);
    const missingId = randomUUID();
    // 저장소에 바이트가 없는 파일(내보내기가 asset_missing 경고를 남긴다)
    await db.insert(schema.assets).values({
      id: missingId,
      ownerId: owner,
      key: buildAssetKey(owner, missingId),
      mime: 'image/png',
      bytes: 4,
      checksum: sha256Hex(new Uint8Array([1, 2, 3, 4])),
      verificationState: 'VERIFIED',
    });
    const fullZip = await exportZip(owner, 'existing-full');
    await db.delete(schema.usageLedger).where(eq(schema.usageLedger.id, runs[0]!.ledger.id));
    const gapZip = await exportZip(owner, 'existing-gap');
    const assetMissing = { code: 'asset_missing', asset_id: missingId, message: '저장소에 파일이 없어 메타데이터만 내보냈습니다' };
    const currency = {
      code: 'ledger_currency_mismatch',
      message: '묶음의 AI 비용 원장 통화(USD)가 설정 통화(RUB)와 다릅니다. 복원은 되지만, 같은 달에는 AI 호출이 통화 불일치로 거부됩니다.',
    };
    await withTarget('existing', async (h, target, restoresDir) => {
      expect((await preview(h, target, fullZip, restoresDir, 'RUB')).preview.warnings).toEqual([assetMissing, currency]);
      expect((await preview(h, target, fullZip, restoresDir, 'USD')).preview.warnings).toEqual([assetMissing]);
      expect((await preview(h, target, gapZip, restoresDir, 'RUB')).preview.warnings).toEqual([assetMissing, currency, historyWarning(leftWithout('AI 실행 1건'))]);
      expect((await preview(h, target, gapZip, restoresDir)).preview.warnings).toEqual([assetMissing, historyWarning(leftWithout('AI 실행 1건'))]);
    });
  });

  it('화면·API 경로: POST /api/restores/preview(export_id) 의 JSON preview.warnings 에 같은 경고(설정 화면 미리보기는 warnings 의 message 를 그대로 보여 준다) — 같은 환경 "이 파일로 복원 미리보기"에서 내보낸 뒤 바뀐 원장(different)은 세지 않는다', async () => {
    const owner = await freshOwner(A);
    const { runs } = await withRuns(owner, 2);
    // 원장 도입 전 실행처럼: 내보내기 전에 한 실행의 원장을 지운다(그 실행은 복원 뒤에도 원장이 없다)
    await db.delete(schema.usageLedger).where(eq(schema.usageLedger.id, runs[0]!.ledger.id));
    const token = await login(A);
    const ex = await exportsPOST(jsonPost('/api/exports', {}, cookieHeader(token)));
    expect(ex.status).toBe(201);
    const exportId = ((await ex.json()) as { export_id: string }).export_id;
    // 내보낸 뒤 이 환경에서 원장이 바뀐다 → 같은 환경 미리보기에서 그 행은 different 충돌(이 계정에 그대로 남아 월 합계에 들어감)
    await db.update(schema.usageLedger).set({ failed: true }).where(eq(schema.usageLedger.id, runs[1]!.ledger.id));
    const res = await previewPOST(jsonPost('/api/restores/preview', { export_id: exportId }, cookieHeader(token)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preview: RestorePreview };
    expect(body.preview.tables.usage_ledger).toMatchObject({ in_bundle: 1, existing_different: 1 });
    expect(body.preview.conflicts).toEqual([{ table: 'usage_ledger', id: runs[1]!.ledger.id, reason: 'different' }]);
    // FIX2-CODEX(U1 fixup — 이전: 바뀐 원장 하나로 notRestored(1)): 원장 없는 실행만 경고한다
    expect(historyOf(body.preview)).toEqual([historyWarning(leftWithout('AI 실행 1건'))]);
  });
});
