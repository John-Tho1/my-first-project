/**
 * T05 — M1 통과 조건 게이트: "10개 가상 소재 입력→검색→원고 수정→export→빈 DB 복원 후 ID 관계·본문·checksum 일치"(docs/05), A18.
 *
 * DB A = 앱 싱글턴(memory://, route handler 도 이 DB 를 씀). DB B = 별도 memory DB(빈 환경, 다른 owner id).
 * (1) A: seed 10건 + PNG asset + 카드(소재 2건 연결) + 원고(소재에서 시작, 버전 2개 추가) + 소재 메모 수정(수정 2) + "주재원" 검색
 * (2) exportOwner → ZIP  (3) B 미리보기: 빈 환경·충돌 0·모든 파일 검증  (4) B empty_only 커밋 → 표별 행 전체 비교
 * (5) 변조 → manifest_mismatch, B 변화 없음  (6) 비어 있지 않은 B 에 empty_only → 409, add_missing → 새 행만, 덮어쓰기 없음
 * (7) sessions 는 묶음에 없음  (8) 다른 owner 는 A 의 내보내기 다운로드·복원 커밋 불가(404)  (9) 두 번 커밋 → 409
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import {
  appendContentVersion,
  closeDb,
  commitRestore,
  createContentFromCapture,
  createIdea,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  getDb,
  insertAsset,
  ownerScope,
  parseBundleZip,
  schema,
  search,
  seed,
  selectBundleRows,
  updateCapture,
  type Db,
  type DbHandle,
  type ExportResult,
  type RestorePreview,
} from '@cs/db';
import {
  AppError,
  buildBundle,
  buildAssetKey,
  EXPORTED_TABLES,
  loadConfig,
  readZip,
  RESTORED_TABLES,
  searchQuerySchema,
  writeZip,
  type BundleTables,
} from '@cs/domain';
import { LocalStorageAdapter } from '@cs/providers';
import { GET as exportGET } from '../../apps/web/app/api/exports/[id]/route';
import { GET as exportsGET, POST as exportsPOST } from '../../apps/web/app/api/exports/route';
import { POST as commitPOST } from '../../apps/web/app/api/restores/[id]/commit/route';
import { POST as previewPOST } from '../../apps/web/app/api/restores/preview/route';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'owner@example.local';
const X = 'other-export@example.local';
const B_IDENTITY = 'restore-target@example.local';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 9, 8, 7, 6]);

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);

let tmp: string;
let dirs: { storageA: string; storageB: string; exports: string; restores: string };
let dbA: Db;
let handleB: DbHandle;
let dbB: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenX: string;
let fx001: string;
let fx007: string;
let contentId: string;
let assetId: string;
let exported: ExportResult;
let zip: Uint8Array;

const captureIdByKey = async (db: Db, ownerId: string, key: string) =>
  (
    await db
      .select({ id: schema.captures.id })
      .from(schema.captures)
      .where(and(eq(schema.captures.ownerId, ownerId), eq(schema.captures.commandKey, key)))
  )[0]!.id;

async function snapshot(db: Db, ownerId: string) {
  const out: Record<string, unknown[]> = {};
  for (const t of RESTORED_TABLES) out[t] = (await selectBundleRows(db, t, ownerScope(t, ownerId))).map((r) => r.row);
  return out;
}

async function tableCounts(db: Db) {
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries({
    captures: schema.captures,
    contents: schema.contents,
    content_versions: schema.contentVersions,
    assets: schema.assets,
    restore_runs: schema.restoreRuns,
    ideas: schema.ideas,
  })) {
    out[k] = (await db.select({ n: count() }).from(t))[0]!.n;
  }
  return out;
}

async function expectAppError(p: Promise<unknown>, code: string, status?: AppError['kind']) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    if (status) expect((e as AppError).kind).toBe(status);
    return e as AppError;
  }
  throw new Error(`expected ${code}`);
}

const searchIds = async (db: Db, ownerId: string, q: string) =>
  (await search(db, ownerId, searchQuerySchema.parse({ q }))).captures.items.map((i) => i.id);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t05-it-'));
  dirs = {
    storageA: path.join(tmp, 'assets-a'),
    storageB: path.join(tmp, 'assets-b'),
    exports: path.join(tmp, 'exports'),
    restores: path.join(tmp, 'restores'),
  };
  vi.stubEnv('STORAGE_LOCAL_DIR', dirs.storageA);
  vi.stubEnv('EXPORT_LOCAL_DIR', dirs.exports);
  vi.stubEnv('RESTORE_LOCAL_DIR', dirs.restores);
  dbA = (await getDb(loadConfig())).db;

  // (1) 10개 가상 소재 입력
  ownerA = (await seed(dbA, { allowedIdentity: A })).ownerId;
  fx001 = await captureIdByKey(dbA, ownerA, 'fx-001');
  fx007 = await captureIdByKey(dbA, ownerA, 'fx-007');
  const fx002 = await captureIdByKey(dbA, ownerA, 'fx-002');
  // 파일 1개(PNG)
  const storageA = new LocalStorageAdapter(dirs.storageA);
  assetId = randomUUID();
  const key = buildAssetKey(ownerA, assetId);
  await storageA.put(key, PNG);
  await insertAsset(dbA, {
    id: assetId,
    ownerId: ownerA,
    key,
    mime: 'image/png',
    bytes: PNG.byteLength,
    checksum: sha(PNG),
    rightsStatus: 'owned',
    verificationState: 'VERIFIED',
  });
  // 카드(소재 2건 연결)
  await createIdea(dbA, ownerA, { idea: '재고 리스크를 누가 지는가', evidence: '분기 회의 메모', tags: ['영업'], capture_ids: [fx001, fx002] });
  // 원고: 소재에서 시작 + 버전 2개 추가
  const c = await createContentFromCapture(dbA, ownerA, fx007);
  contentId = c.content.id;
  await appendContentVersion(dbA, ownerA, contentId, { baseVersion: 1, body: '주재원 첫 달: 두 번째 버전', note: '구성 정리' });
  await appendContentVersion(dbA, ownerA, contentId, { baseVersion: 2, body: '주재원 첫 달: 세 번째 버전\n\n- 목록\n- ``` 울타리' });
  // 소재 메모 수정(수정 2)
  await updateCapture(dbA, ownerA, fx001, { user_note: '메모 고침(수정 2)' }, 1);

  // 로그인(세션이 DB 에 있어도 묶음에 들어가지 않아야 한다) — 다른 owner X 도 같은 DB 에
  as(A);
  tokenA = await login(A);
  as(X);
  tokenX = await login(X);
  as(A);

  // DB B: 빈 환경(다른 owner id)
  handleB = await createTestDb();
  dbB = handleB.db;
  ownerB = (await ensureOwner(dbB, B_IDENTITY)).id;
});

beforeEach(() => {
  vi.stubEnv('STORAGE_LOCAL_DIR', dirs.storageA);
  vi.stubEnv('EXPORT_LOCAL_DIR', dirs.exports);
  vi.stubEnv('RESTORE_LOCAL_DIR', dirs.restores);
  as(A);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await handleB?.close();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('M1 게이트: 입력 → 검색 → 원고 수정 → export → 빈 DB 복원', () => {
  it('(1) 검색 "주재원" 이 A 에서 fx-007 을 찾는다', async () => {
    expect(await searchIds(dbA, ownerA, '주재원')).toContain(fx007);
  });

  it('(2) exportOwner → 폴더 + ZIP, manifest 합계', async () => {
    exported = await exportOwner(dbA, new LocalStorageAdapter(dirs.storageA), ownerA, { outDir: dirs.exports });
    zip = new Uint8Array(readFileSync(exported.zipPath));
    expect(zip.byteLength).toBe(exported.zipBytes);
    expect(exported.manifest.totals).toMatchObject({ captures: 10, ideas: 1, contents: 1, content_versions: 3, assets: 1, assets_included: 1 });
    expect(exported.manifest.tables.capture_revisions!.rows).toBeGreaterThanOrEqual(1);
    expect(exported.warnings).toEqual([]);
    // 풀어 둔 폴더의 manifest 와 ZIP 안 manifest 가 같다
    const inDir = readFileSync(path.join(exported.dirPath, 'manifest.json'));
    expect(sha(inDir)).toBe(exported.manifestSha256);
  });

  it('(7) sessions·토큰은 묶음에 없다', () => {
    const entries = readZip(zip);
    const paths = entries.map((e) => e.path);
    expect(paths.some((p) => /session/i.test(p))).toBe(false);
    expect(Object.keys(exported.manifest.tables)).not.toContain('sessions');
    expect(exported.manifest.excluded_tables).toEqual(['export_runs', 'restore_runs', 'sessions']);
    const all = Buffer.concat(entries.map((e) => Buffer.from(e.bytes))).toString('utf8');
    expect(all).not.toContain('token_hash');
    expect(all).not.toContain(A); // 식별자 원문 없음(가린 형태만)
    expect(all).toContain('ow***@example.local');
  });

  let preview: RestorePreview;
  let restoreId: string;

  it('(3) 빈 DB B 미리보기: 빈 환경·충돌 0·모든 파일 검증, DB 변화 없음', async () => {
    const before = await tableCounts(dbB);
    const r = await createRestorePreview(dbB, ownerB, zip, { restoresDir: dirs.restores, source: 'upload' });
    preview = r.preview;
    restoreId = r.restoreId;
    expect(preview.can_commit_empty_only).toBe(true);
    expect(preview.conflicts_total).toBe(0);
    expect(preview.files_verified).toBe(exported.manifest.files.length);
    expect(preview.owner_remap).toEqual({ from: ownerA, to: ownerB });
    expect(preview.assets).toEqual({ total: 1, included: 1, missing: 0, verified: 1 });
    for (const t of RESTORED_TABLES) {
      expect(preview.tables[t]).toMatchObject({ new: exported.manifest.tables[t]!.rows, existing_same: 0, existing_different: 0 });
    }
    const after = await tableCounts(dbB);
    expect(after).toEqual({ ...before, restore_runs: before.restore_runs! + 1 });
  });

  it('(4) empty_only 커밋 → 모든 복원 표의 ID·값·관계·본문·checksum 이 A 와 같다(owner 만 B)', async () => {
    const storageB = new LocalStorageAdapter(dirs.storageB);
    const result = await commitRestore(dbB, storageB, ownerB, restoreId, { mode: 'empty_only', confirm: true, restoresDir: dirs.restores });
    expect(result.conflicts_total).toBe(0);
    expect(result.assets_written).toBe(1);
    expect(result.assets_verified).toBe(1);
    for (const t of RESTORED_TABLES) expect(result.restored[t], t).toBe(exported.manifest.tables[t]!.rows);

    const a = await snapshot(dbA, ownerA);
    const b = await snapshot(dbB, ownerB);
    for (const t of RESTORED_TABLES) {
      expect(b[t]!.length, t).toBe(a[t]!.length);
      expect(b[t], t).toEqual(a[t]);
    }
    expect(a.captures).toHaveLength(10);
    expect(a.content_versions).toHaveLength(3);
    // owner 재지정: B 의 모든 소재 owner = ownerB
    const capsB = await dbB.select().from(schema.captures);
    expect(capsB.every((c) => c.ownerId === ownerB)).toBe(true);
    // 본문 바이트 일치, 현재 버전 포인터 일치
    const vA = await dbA.select().from(schema.contentVersions).where(eq(schema.contentVersions.contentId, contentId));
    const vB = await dbB.select().from(schema.contentVersions).where(eq(schema.contentVersions.contentId, contentId));
    for (const v of vA) {
      const other = vB.find((x) => x.id === v.id)!;
      expect(Buffer.from(other.body, 'utf8').equals(Buffer.from(v.body, 'utf8'))).toBe(true);
    }
    const [cA] = await dbA.select().from(schema.contents).where(eq(schema.contents.id, contentId));
    const [cB] = await dbB.select().from(schema.contents).where(eq(schema.contents.id, contentId));
    expect(cB!.currentVersionId).toBe(cA!.currentVersionId);
    expect(vB.find((v) => v.id === cB!.currentVersionId)!.version).toBe(3);
    // 관계: 카드↔소재 2건, 원고↔소재(fx-007)
    const ic = await dbB.select().from(schema.ideaCaptures);
    expect(ic.map((r) => r.captureId).sort()).toEqual(a.idea_captures!.map((r) => (r as { capture_id: string }).capture_id).sort());
    const cc = await dbB.select().from(schema.contentCaptures);
    expect(cc.map((r) => r.captureId)).toEqual([fx007]);
    // asset: DB checksum = 저장소 파일 sha256 = 원본
    const [asB] = await dbB.select().from(schema.assets).where(eq(schema.assets.id, assetId));
    expect(asB!.ownerId).toBe(ownerB);
    expect(asB!.checksum).toBe(sha(PNG));
    expect(sha((await storageB.get(asB!.key))!)).toBe(asB!.checksum);
    // 검색: B 에서도 같은 소재 ID
    expect(await searchIds(dbB, ownerB, '주재원')).toContain(fx007);
    // 복원 감사 기록은 합계만
    const audit = await dbB.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'restore.commit'));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.sanitizedDetails)).not.toMatch(/주재원|raw_text/);
  });

  it('(4b) 복원한 B 를 다시 내보내면 users·audit_events 외 모든 표 sha256 이 같다', async () => {
    const again = await exportOwner(dbB, new LocalStorageAdapter(dirs.storageB), ownerB, { outDir: dirs.exports });
    for (const t of EXPORTED_TABLES) {
      if (t === 'users' || t === 'audit_events') continue;
      expect(again.manifest.tables[t]!.sha256, t).toBe(exported.manifest.tables[t]!.sha256);
    }
  });

  it('(9) 같은 미리보기를 두 번 커밋 → 409 already_committed', async () => {
    await expectAppError(
      commitRestore(dbB, new LocalStorageAdapter(dirs.storageB), ownerB, restoreId, { mode: 'add_missing', confirm: true, restoresDir: dirs.restores }),
      'already_committed',
      'conflict',
    );
  });

  it('(5) data/captures.json 한 바이트 변조 → manifest_mismatch, B 변화 없음', async () => {
    const entries = readZip(zip).map((e) => {
      if (e.path !== 'data/captures.json') return e;
      const bytes = new Uint8Array(e.bytes);
      bytes[20] = bytes[20]! ^ 0x01;
      return { path: e.path, bytes };
    });
    const tampered = writeZip(entries);
    const before = { counts: await tableCounts(dbB), snap: await snapshot(dbB, ownerB) };
    const err = await expectAppError(createRestorePreview(dbB, ownerB, tampered, { restoresDir: dirs.restores, source: 'upload' }), 'manifest_mismatch');
    expect(err.extra).toEqual({ paths: ['data/captures.json'] });
    expect(await tableCounts(dbB)).toEqual(before.counts);
    expect(await snapshot(dbB, ownerB)).toEqual(before.snap);
  });

  it('(6) 비어 있지 않은 B: empty_only → 409, add_missing → 새 행만 추가·다른 행은 충돌로 남고 덮어쓰지 않음', async () => {
    // 같은 묶음: 전부 동일 → 충돌 0 이지만 빈 환경이 아님
    const same = await createRestorePreview(dbB, ownerB, zip, { restoresDir: dirs.restores, source: 'upload' });
    expect(same.preview.can_commit_empty_only).toBe(false);
    expect(same.preview.conflicts_total).toBe(0);
    expect(same.preview.tables.captures).toMatchObject({ new: 0, existing_same: 10, existing_different: 0 });
    await expectAppError(
      commitRestore(dbB, new LocalStorageAdapter(dirs.storageB), ownerB, same.restoreId, { mode: 'empty_only', confirm: true, restoresDir: dirs.restores }),
      'restore_target_not_empty',
      'conflict',
    );

    // 묶음 쪽에 새 소재 1건 추가 + 기존 소재 1건의 메모를 바꾼 묶음
    const parsed = await parseBundleZip(zip);
    const t = structuredClone(parsed.tables) as BundleTables;
    const newId = randomUUID();
    const base = t.captures.find((c) => c.id === fx001)!;
    t.captures.push({ ...base, id: newId, command_key: 'restore-new-1', raw_text: '복원 때 새로 들어온 소재', content_hash: null });
    const changed = t.captures.find((c) => c.id === fx007)!;
    changed.user_note = '묶음 쪽에서 바뀐 메모';
    const bundle = buildBundle({
      exportId: randomUUID(),
      exportedAt: new Date().toISOString(),
      appVersion: parsed.manifest.app_version,
      migrations: parsed.manifest.schema_migrations,
      owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
      tables: t,
      assetBytes: new Map(parsed.assetBytes),
    });
    const modified = writeZip(bundle.entries);
    const beforeFx007 = (await dbB.select().from(schema.captures).where(eq(schema.captures.id, fx007)))[0]!;

    const p = await createRestorePreview(dbB, ownerB, modified, { restoresDir: dirs.restores, source: 'upload' });
    expect(p.preview.tables.captures).toMatchObject({ in_bundle: 11, new: 1, existing_same: 9, existing_different: 1 });
    expect(p.preview.conflicts).toEqual([{ table: 'captures', id: fx007, reason: 'different' }]);
    const r = await commitRestore(dbB, new LocalStorageAdapter(dirs.storageB), ownerB, p.restoreId, {
      mode: 'add_missing',
      confirm: true,
      restoresDir: dirs.restores,
    });
    expect(Object.values(r.restored).reduce((n, v) => n + v, 0)).toBe(1);
    expect(r.restored.captures).toBe(1);
    expect(r.conflicts).toEqual([{ table: 'captures', id: fx007, reason: 'different' }]);
    const afterFx007 = (await dbB.select().from(schema.captures).where(eq(schema.captures.id, fx007)))[0]!;
    expect(afterFx007).toEqual(beforeFx007); // 덮어쓰지 않음
    const inserted = (await dbB.select().from(schema.captures).where(eq(schema.captures.id, newId)))[0]!;
    expect(inserted).toMatchObject({ ownerId: ownerB, rawText: '복원 때 새로 들어온 소재' });
  });

  it('(7b) add_missing: 부모가 "different" 인 기존 소재에는 새 관계를 붙이지 않는다(dependency 충돌)', async () => {
    const parsed = await parseBundleZip(zip);
    const t = structuredClone(parsed.tables) as BundleTables;
    expect(t.ideas.length).toBeGreaterThan(0);
    expect(t.idea_captures.length).toBeGreaterThan(0);
    // 묶음 쪽 fx007 은 내용이 달라져 'different' 가 되고, 새 카드가 fx007(다른 부모)과 fx001(같은 부모)을 각각 참조한다
    t.captures.find((c) => c.id === fx007)!.user_note = '또 바뀐 메모';
    const ideaId = randomUUID();
    t.ideas.push({ ...t.ideas[0]!, id: ideaId, idea: '복원 때 새로 들어온 카드' });
    const relBad = randomUUID();
    const relOk = randomUUID();
    t.idea_captures.push({ ...t.idea_captures[0]!, id: relBad, idea_id: ideaId, capture_id: fx007 });
    t.idea_captures.push({ ...t.idea_captures[0]!, id: relOk, idea_id: ideaId, capture_id: fx001 });
    const bundle = buildBundle({
      exportId: randomUUID(),
      exportedAt: new Date().toISOString(),
      appVersion: parsed.manifest.app_version,
      migrations: parsed.manifest.schema_migrations,
      owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
      tables: t,
      assetBytes: new Map(parsed.assetBytes),
    });
    const p = await createRestorePreview(dbB, ownerB, writeZip(bundle.entries), { restoresDir: dirs.restores, source: 'upload' });
    expect(p.preview.tables.ideas).toMatchObject({ new: 1, existing_different: 0 });
    expect(p.preview.tables.idea_captures).toMatchObject({ new: 1, existing_different: 1 });
    expect(p.preview.conflicts).toEqual(
      expect.arrayContaining([
        { table: 'captures', id: fx007, reason: 'different' },
        { table: 'idea_captures', id: relBad, reason: 'dependency' },
      ]),
    );
    expect(p.preview.conflicts_total).toBe(2);
    const r = await commitRestore(dbB, new LocalStorageAdapter(dirs.storageB), ownerB, p.restoreId, {
      mode: 'add_missing',
      confirm: true,
      restoresDir: dirs.restores,
    });
    expect(r.restored.ideas).toBe(1);
    expect(r.restored.idea_captures).toBe(1);
    const rels = await dbB.select().from(schema.ideaCaptures).where(eq(schema.ideaCaptures.ideaId, ideaId));
    expect(rels.map((x) => x.captureId)).toEqual([fx001]); // fx007 로의 관계는 만들어지지 않음
  });

  it('(7c) 같은 (owner, version) 의 브랜드 프로필이 다른 ID 로 이미 있으면 내용이 같아도 version_exists 충돌(ID 보존)', async () => {
    const parsed = await parseBundleZip(zip);
    const bp = parsed.tables.brand_profiles[0]!;
    const fresh = await createTestDb(); // 빈 DB + 브랜드 프로필만 다른 ID 로 존재
    const dbC = fresh.db;
    const c = await ensureOwner(dbC, 'seeded-target@example.local');
    await dbC.insert(schema.brandProfiles).values({
      ownerId: c.id,
      version: bp.version,
      penName: bp.pen_name,
      audience: bp.audience,
      pillars: [...bp.pillars],
      styleRules: [...bp.style_rules],
    });
    const p = await createRestorePreview(dbC, c.id, zip, { restoresDir: dirs.restores, source: 'upload' });
    expect(p.preview.tables.brand_profiles).toMatchObject({ in_bundle: 1, new: 0, existing_same: 0, existing_different: 1 });
    expect(p.preview.conflicts).toEqual([{ table: 'brand_profiles', id: bp.id, reason: 'version_exists' }]);
    expect(p.preview.target.empty).toBe(true); // 브랜드 프로필은 범위 계산에 세지 않지만
    expect(p.preview.can_commit_empty_only).toBe(false); // 충돌이 있으므로 empty_only 는 불가
    const kept = await dbC.select().from(schema.brandProfiles).where(eq(schema.brandProfiles.ownerId, c.id));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.id).not.toBe(bp.id);
    await fresh.close();
  });
});

describe('(8) API: owner 범위·CSRF·confirm', () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let apiExportId: string;
  let apiRestoreId: string;

  it('POST /api/exports → 201, 목록에 보임. Origin 없음 → 403', async () => {
    const res = await exportsPOST(jsonPost('/api/exports', {}, cookieHeader(tokenA)));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ download_url: `/api/exports/${body.export_id}`, totals: expect.objectContaining({ captures: 10 }) });
    expect(body.zip_bytes).toBeGreaterThan(0);
    apiExportId = body.export_id;
    const list = await (await exportsGET(new Request(`${BASE}/api/exports`, { headers: cookieHeader(tokenA) }), undefined)).json();
    expect(list.items.map((i: { export_id: string }) => i.export_id)).toContain(apiExportId);
    as(X);
    const listX = await (await exportsGET(new Request(`${BASE}/api/exports`, { headers: cookieHeader(tokenX) }), undefined)).json();
    expect(listX.items).toEqual([]);
    as(A);
    const noOrigin = await exportsPOST(
      new Request(`${BASE}/api/exports`, { method: 'POST', headers: { accept: 'application/json', ...cookieHeader(tokenA) } }),
    );
    expect(noOrigin.status).toBe(403);
    expect((await exportsPOST(jsonPost('/api/exports', {}))).status).toBe(401);
  });

  it('GET /api/exports/{id}: owner → 200 application/zip, 다른 owner·없는 ID → 404', async () => {
    const res = await exportGET(new Request(`${BASE}/api/exports/${apiExportId}`, { headers: cookieHeader(tokenA) }), ctx(apiExportId));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="content-studio-export-\d{8}-\d{4}-msk\.zip"$/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(bytes.byteLength);
    expect(readZip(bytes)[0]!.path).toBe('manifest.json');

    as(X);
    const other = await exportGET(new Request(`${BASE}/api/exports/${apiExportId}`, { headers: cookieHeader(tokenX) }), ctx(apiExportId));
    expect(other.status).toBe(404);
    as(A);
    const missing = randomUUID();
    expect((await exportGET(new Request(`${BASE}/api/exports/${missing}`, { headers: cookieHeader(tokenA) }), ctx(missing))).status).toBe(404);
    expect((await exportGET(new Request(`${BASE}/api/exports/x`, { headers: cookieHeader(tokenA) }), ctx('x'))).status).toBe(404);
  });

  it('POST /api/restores/preview {export_id}: owner → 200(동일 데이터라 충돌 0, 빈 환경 아님), 다른 owner → 404', async () => {
    const res = await previewPOST(jsonPost('/api/restores/preview', { export_id: apiExportId }, cookieHeader(tokenA)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preview).toMatchObject({ can_commit_empty_only: false, conflicts_total: 0 });
    apiRestoreId = body.restore_id;
    as(X);
    const other = await previewPOST(jsonPost('/api/restores/preview', { export_id: apiExportId }, cookieHeader(tokenX)));
    expect(other.status).toBe(404);
  });

  it('multipart 업로드 미리보기: 변조 ZIP → 400 manifest_mismatch(경로), 정상 → 200', async () => {
    const upload = (bytes: Uint8Array, token: string) => {
      const form = new FormData();
      form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], 'export.zip', { type: 'application/zip' }));
      return new Request(`${BASE}/api/restores/preview`, {
        method: 'POST',
        headers: { accept: 'application/json', origin: BASE, ...cookieHeader(token) },
        body: form,
      });
    };
    const entries = readZip(zip).map((e) =>
      e.path === 'data/content_versions.json' ? { path: e.path, bytes: new Uint8Array([...e.bytes.slice(0, -1), 0x20]) } : e,
    );
    const bad = await previewPOST(upload(writeZip(entries), tokenA));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'manifest_mismatch', paths: ['data/content_versions.json'] });
    as(X);
    const ok = await previewPOST(upload(zip, tokenX));
    expect(ok.status).toBe(200);
    expect((await ok.json()).preview.owner_remap.from).toBe(ownerA);
  });

  it('POST /api/restores/{id}/commit: 다른 owner → 404, confirm 없음 → 400, 커밋 → 200, 두 번째 → 409', async () => {
    const commit = (id: string, body: unknown, token: string) =>
      commitPOST(jsonPost(`/api/restores/${id}/commit`, body, cookieHeader(token)), ctx(id));
    as(X);
    expect((await commit(apiRestoreId, { mode: 'add_missing', confirm: true }, tokenX)).status).toBe(404);
    as(A);
    const noConfirm = await commit(apiRestoreId, { mode: 'add_missing' }, tokenA);
    expect(noConfirm.status).toBe(400);
    expect((await noConfirm.json()).error).toBe('confirm_required');
    expect((await commit(apiRestoreId, { mode: 'add_missing', confirm: 'yes' }, tokenA)).status).toBe(400);
    expect((await commit(apiRestoreId, { mode: 'overwrite', confirm: true }, tokenA)).status).toBe(400);
    const emptyOnly = await commit(apiRestoreId, { mode: 'empty_only', confirm: true }, tokenA);
    expect(emptyOnly.status).toBe(409);
    expect((await emptyOnly.json()).error).toBe('restore_target_not_empty');
    const ok = await commit(apiRestoreId, { mode: 'add_missing', confirm: true }, tokenA);
    expect(ok.status).toBe(200);
    const result = await ok.json();
    expect(Object.values(result.restored as Record<string, number>).every((n) => n === 0)).toBe(true);
    expect(result.conflicts_total).toBe(0);
    const again = await commit(apiRestoreId, { mode: 'add_missing', confirm: true }, tokenA);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('already_committed');
  });
});
