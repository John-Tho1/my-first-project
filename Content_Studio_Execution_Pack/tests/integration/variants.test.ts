/**
 * T09(결정 D14): 채널 초안(variants) — 결정적 초안·AI 초안(모의, 비현재·원장·claim)·채택·수정 409·stale(파생)·미디어 완성·A03·
 * 배포 파일 ZIP(수동 게시용, 승인·게시 아님)·owner 범위·export → 빈 DB 복원. 외부 호출·게시 없음.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  adoptProposal,
  appendContentVersion,
  closeDb,
  commitRestore,
  confirmClaims,
  createContent,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  getDb,
  insertAsset,
  listPackages,
  parseBundleZip,
  setVariantAssets,
  ownerScope,
  runAssist,
  saveInterviewAnswers,
  schema,
  seed,
  selectBundleRows,
  type Db,
} from '@cs/db';
import { buildAssetKey, buildBundle, loadConfig, readZip, RESTORED_TABLES, writeZip, type BundleTables } from '@cs/domain';
import { LocalStorageAdapter, MOCK_WARNING, MockLlmProvider } from '@cs/providers';
import { POST as dismissContentPOST } from '../../apps/web/app/api/contents/[id]/assist/[runId]/dismiss/route';
import { POST as confirmPOST } from '../../apps/web/app/api/contents/[id]/claims/confirm/route';
import { POST as packagePOST } from '../../apps/web/app/api/contents/[id]/package/route';
import { GET as variantsGET, POST as variantsPOST } from '../../apps/web/app/api/contents/[id]/variants/route';
import { GET as packageGET } from '../../apps/web/app/api/packages/[id]/route';
import { POST as adoptPOST } from '../../apps/web/app/api/variants/[id]/adopt/[versionId]/route';
import { POST as assetsPOST } from '../../apps/web/app/api/variants/[id]/assets/route';
import { POST as lifecyclePOST } from '../../apps/web/app/api/variants/[id]/lifecycle/route';
import { POST as dismissVariantPOST } from '../../apps/web/app/api/variants/[id]/proposals/[runId]/dismiss/route';
import { POST as versionsPOST } from '../../apps/web/app/api/variants/[id]/versions/route';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'variants-other@example.local';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let tmp: string;
let pngA: string;
let videoA: string;
let pngB: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = <T>(h: (r: Request, c: T) => Promise<Response>, p: string, body: unknown, c: T, token = tokenA) =>
  h(jsonPost(p, body, cookieHeader(token)), c);
const createVariant = (contentId: string, body: unknown, token = tokenA) => post(variantsPOST, `/api/contents/${contentId}/variants`, body, ctx(contentId), token);
const edit = (vid: string, body: unknown, token = tokenA) => post(versionsPOST, `/api/variants/${vid}/versions`, body, ctx(vid), token);
const attach = (vid: string, body: unknown, token = tokenA) => post(assetsPOST, `/api/variants/${vid}/assets`, body, ctx(vid), token);
const lifecycle = (vid: string, body: unknown, token = tokenA) => post(lifecyclePOST, `/api/variants/${vid}/lifecycle`, body, ctx(vid), token);
const adopt = (vid: string, versionId: string, body: unknown, token = tokenA) =>
  post(adoptPOST, `/api/variants/${vid}/adopt/${versionId}`, body, { params: Promise.resolve({ id: vid, versionId }) }, token);

const BODY = '# 주재원 첫 달\n\n대리점과 첫 회의를 했다.\n\n재고 리스크를 먼저 합의했다.';

async function newContent(ownerId = ownerA, body = BODY) {
  return (await createContent(db, ownerId, { title: '채널 초안 원고', body })).content.id;
}
async function coreVersion(contentId: string) {
  const [c] = await db.select().from(schema.contents).where(eq(schema.contents.id, contentId));
  const [v] = await db.select().from(schema.contentVersions).where(eq(schema.contentVersions.id, c!.currentVersionId!));
  return v!;
}
async function putAsset(ownerId: string, bytes: Uint8Array, mime: string) {
  const id = randomUUID();
  const key = buildAssetKey(ownerId, id);
  await new LocalStorageAdapter(path.join(tmp, 'assets')).put(key, bytes);
  await insertAsset(db, { id, ownerId, key, mime, bytes: bytes.byteLength, checksum: sha(bytes), rightsStatus: 'owned', verificationState: 'VERIFIED' });
  return id;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t09-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  ownerB = (await seed(db, { allowedIdentity: B })).ownerId;
  pngA = await putAsset(ownerA, PNG, 'image/png');
  // 영상 업로드는 아직 없다 — 앞으로의 영상 파일을 흉내 내려고 DB 에 직접 넣는다(형식 검사만 확인).
  videoA = await putAsset(ownerA, new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 9, 9]), 'video/mp4');
  pngB = await putAsset(ownerB, new Uint8Array([...PNG, 9]), 'image/png');
  as(A);
  tokenA = await login(A);
  as(B);
  tokenB = await login(B);
  as(A);
});
beforeEach(() => {
  as(A);
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
  await closeDb();
});

describe('초안 만들기(결정적)·수정·stale', () => {
  it('네 채널 초안: 채널 모양 메타데이터, draft, stale=false', async () => {
    const id = await newContent();
    for (const channel of ['threads', 'instagram', 'youtube', 'blog']) {
      const res = await createVariant(id, { channel, mode: 'draft', base_version: 1 });
      expect(res.status, channel).toBe(201);
      const body = await res.json();
      expect(body.variant).toMatchObject({ channel, lifecycle: 'draft', stale: false });
      expect(body.version).toMatchObject({ version: 1, created_by: 'owner', content_version_id: (await coreVersion(id)).id });
    }
    const list = await (await variantsGET(new Request(`${BASE}/api/contents/${id}/variants`, { headers: cookieHeader(tokenA) }), ctx(id))).json();
    const by = Object.fromEntries(list.items.map((v: { channel: string }) => [v.channel, v]));
    expect(by.threads.current_version.metadata).toEqual({ text: '# 주재원 첫 달', thread_parts: ['# 주재원 첫 달', '대리점과 첫 회의를 했다.', '재고 리스크를 먼저 합의했다.'] });
    expect(by.instagram.current_version.metadata.cards).toHaveLength(3);
    expect(by.youtube.current_version.metadata.title).toBe('주재원 첫 달');
    expect(by.blog.current_version.metadata).toEqual({ title: '주재원 첫 달', markdown: BODY });
    expect(by.instagram.media).toEqual({ complete: false, missing: ['image(이미지 1개 이상)'] });
    // variant_versions 는 불변
    await expect(db.execute(sql`update variant_versions set body = 'x'`)).rejects.toThrow();
  });

  it('원고 base_version 이 현재가 아니면 409 stale_base, 아무것도 만들지 않음', async () => {
    const id = await newContent();
    const res = await createVariant(id, { channel: 'blog', mode: 'draft', base_version: 2 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('stale_base');
    expect((await db.select({ n: count() }).from(schema.variants).where(eq(schema.variants.contentId, id)))[0]!.n).toBe(0);
  });

  it('수정: 오래된 base → 409, 채널 형식 위반 → 400, 정상 → 새 현재 버전(draft)', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'threads', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    expect((await edit(v, { base_version: 0, body: 'x', metadata: { text: 'x', thread_parts: ['x'] } })).status).toBe(409);
    const bad = await edit(v, { base_version: 1, body: 'x', metadata: { text: 'a'.repeat(501), thread_parts: [] } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_metadata');
    const ok = await edit(v, { base_version: 1, body: '고친 글', metadata: { text: '고친 글', thread_parts: ['고친 글'] } });
    expect(ok.status).toBe(201);
    expect((await ok.json()).variant).toMatchObject({ lifecycle: 'draft', current_version: { version: 2, body: '고친 글' } });
  });

  it('원고 수정 → stale=true → 검토 409 stale_variant → 현재 원문으로 다시 초안 → stale=false → 검토 가능', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'threads', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    await appendContentVersion(db, ownerA, id, { baseVersion: 1, body: `${BODY}\n\n추가 문단.` });
    let list = await (await variantsGET(new Request(`${BASE}/api/contents/${id}/variants`, { headers: cookieHeader(tokenA) }), ctx(id))).json();
    expect(list.items[0].stale).toBe(true);
    const blocked = await lifecycle(v, { lifecycle: 'review', base_version: 1 });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe('stale_variant');
    // 사용자 수정만으로는 stale 이 풀리지 않는다
    await edit(v, { base_version: 1, body: 'x', metadata: { text: 'x', thread_parts: ['x'] } });
    list = await (await variantsGET(new Request(`${BASE}/api/contents/${id}/variants`, { headers: cookieHeader(tokenA) }), ctx(id))).json();
    expect(list.items[0].stale).toBe(true);
    const redraft = await createVariant(id, { channel: 'threads', mode: 'draft', base_version: 2 });
    expect(redraft.status).toBe(201);
    expect((await redraft.json()).variant).toMatchObject({ stale: false, current_version: { version: 3 } });
    const ok = await lifecycle(v, { lifecycle: 'review', base_version: 3 });
    expect(ok.status).toBe(200);
    expect((await ok.json()).lifecycle).toBe('review');
    // 원고가 다시 바뀌어도 review 상태는 그대로 두되 stale 로 보인다(자동 재생성 없음)
    await appendContentVersion(db, ownerA, id, { baseVersion: 2, body: '또 바뀜' });
    list = await (await variantsGET(new Request(`${BASE}/api/contents/${id}/variants`, { headers: cookieHeader(tokenA) }), ctx(id))).json();
    expect(list.items[0]).toMatchObject({ lifecycle: 'review', stale: true, current_version: { version: 3 } });
  });
});

describe('AI 초안(모의)·채택', () => {
  it('ai_draft → 현재가 아닌 ai:mock 버전 + run(mode=variant) + 원장 확정 + claims(variant_version_id), MOCK_WARNING', async () => {
    const id = await newContent();
    const res = await createVariant(id, { channel: 'blog', mode: 'ai_draft', base_version: 1 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mock_warning).toBe(MOCK_WARNING);
    expect(body.proposal).toMatchObject({ version: 1, created_by: 'ai:mock', ai_run_id: body.run.id });
    expect(body.variant.current_version_id).toBeNull();
    expect(body.run).toMatchObject({ mode: 'variant', status: 'succeeded', output_ref: null, prompt_version: 't09-variant-v1' });
    expect(body.usage).toMatchObject({ state: 'settled', reserved_amount: '0.000000' });
    const claims = await db.select().from(schema.claims).where(eq(schema.claims.runId, body.run.id));
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((c) => c.variantVersionId === body.proposal.id && c.contentVersionId === body.run.input_version_refs.content_version_id)).toBe(true);
    // 원고 작성 보조 목록에는 채널 초안 run 이 나오지 않는다
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.id, body.run.id));
    expect(run!.variantId).toBe(body.variant.id);

    // 채택: 오래된 base → 409, 정상 → 새 사용자 버전(ai_run_id 유지)이 현재
    expect((await adopt(body.variant.id, body.proposal.id, { base_version: 1 })).status).toBe(409);
    const ok = await adopt(body.variant.id, body.proposal.id, { base_version: 0 });
    expect(ok.status).toBe(201);
    expect((await ok.json()).version).toMatchObject({ version: 2, created_by: 'owner', ai_run_id: body.run.id, body: body.proposal.body });
  });

  it('원고가 바뀐 뒤의 오래된 AI 초안은 채택할 수 없다(409 stale_base)', async () => {
    const id = await newContent();
    const body = await (await createVariant(id, { channel: 'blog', mode: 'ai_draft', base_version: 1 })).json();
    await appendContentVersion(db, ownerA, id, { baseVersion: 1, body: '바뀐 원고' });
    const res = await adopt(body.variant.id, body.proposal.id, { base_version: 0 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('stale_base');
  });

  it('AI 실패 주입 → 502, run failed·원장 실패 확정, 버전 없음', async () => {
    const id = await newContent();
    vi.stubEnv('LLM_MOCK_FAIL_NEXT', '1');
    try {
      expect((await createVariant(id, { channel: 'threads', mode: 'ai_draft', base_version: 1 })).status).toBe(502);
    } finally {
      vi.stubEnv('LLM_MOCK_FAIL_NEXT', '');
    }
    const [v] = await db.select().from(schema.variants).where(eq(schema.variants.contentId, id));
    expect((await db.select({ n: count() }).from(schema.variantVersions).where(eq(schema.variantVersions.variantId, v!.id)))[0]!.n).toBe(0);
    const [run] = await db.select().from(schema.generationRuns).where(eq(schema.generationRuns.variantId, v!.id));
    expect(run!.status).toBe('failed');
    const [l] = await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.runId, run!.id));
    expect(l).toMatchObject({ state: 'settled', failed: true });
  });
});

describe('미디어 완성 여부·owner 범위', () => {
  it('instagram: 이미지 없으면 409 media_incomplete, PNG 를 이미지로 붙이면 검토 가능', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'instagram', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    const res = await lifecycle(v, { lifecycle: 'review', base_version: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'media_incomplete', missing: ['image(이미지 1개 이상)'] });
    const a = await attach(v, { base_version: 1, assets: [{ asset_id: pngA, position: 1, role: 'image' }] });
    expect(a.status).toBe(201);
    expect((await a.json()).version.version).toBe(2);
    expect((await lifecycle(v, { lifecycle: 'review', base_version: 2 })).status).toBe(200);
    // 첨부 변경·수정은 draft 로 되돌리고 첨부는 새 버전으로 이어진다
    const e = await edit(v, { base_version: 2, body: '캡션', metadata: { caption: '캡션', cards: [] } });
    expect((await e.json()).variant).toMatchObject({ lifecycle: 'draft', media: { complete: true }, assets: [{ position: 1, role: 'image', asset_id: pngA }] });
  });

  it('youtube: 이미지를 영상 역할로 → 400 asset_role_mismatch, 영상 파일(video/*) → 검토 가능', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'youtube', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    const bad = await attach(v, { base_version: 1, assets: [{ asset_id: pngA, position: 1, role: 'video' }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('asset_role_mismatch');
    expect((await lifecycle(v, { lifecycle: 'review', base_version: 1 })).status).toBe(409);
    await attach(v, { base_version: 1, assets: [{ asset_id: videoA, position: 1, role: 'video' }, { asset_id: pngA, position: 2, role: 'thumbnail' }] });
    expect((await lifecycle(v, { lifecycle: 'review', base_version: 2 })).status).toBe(200);
  });

  it('다른 owner 의 파일 → 404, 다른 owner 의 파생본·원고 → 404, 순서 중복 → 400', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'instagram', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    expect((await attach(v, { base_version: 1, assets: [{ asset_id: pngB, position: 1, role: 'image' }] })).status).toBe(404);
    expect(
      (await attach(v, { base_version: 1, assets: [{ asset_id: pngA, position: 1, role: 'image' }, { asset_id: pngA, position: 1, role: 'image' }] })).status,
    ).toBe(400);
    as(B);
    expect((await attach(v, { base_version: 1, assets: [{ asset_id: pngB, position: 1, role: 'image' }] }, tokenB)).status).toBe(404);
    expect((await edit(v, { base_version: 1, body: 'x', metadata: { caption: 'x', cards: [] } }, tokenB)).status).toBe(404);
    expect((await lifecycle(v, { lifecycle: 'review', base_version: 1 }, tokenB)).status).toBe(404);
    expect((await createVariant(id, { channel: 'blog', mode: 'draft', base_version: 1 }, tokenB)).status).toBe(404);
    as(A);
    // DB 복합 FK 도 다른 owner 의 파일을 막는다
    const [cur] = await db.select().from(schema.variants).where(eq(schema.variants.id, v));
    await expect(
      db.insert(schema.variantAssets).values({ ownerId: ownerA, variantVersionId: cur!.currentVersionId!, assetId: pngB, position: 9, role: 'image' }),
    ).rejects.toThrow();
  });
});

describe('A03 — 채널 초안 검토', () => {
  it('원고에 채택한 미확인 경험 claim 이 있으면 파생본 검토 409, 확인하면 가능', async () => {
    const id = await newContent();
    const saved = await saveInterviewAnswers(db, ownerA, id, { answers: { judgment: '제가 직접 가격 조건을 제안했습니다.' } });
    const r = await runAssist(db, ownerA, id, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [saved.current[0]!.id] }, new MockLlmProvider());
    await adoptProposal(db, ownerA, id, r.run.id, 1);
    const core = await coreVersion(id);
    const v = (await (await createVariant(id, { channel: 'blog', mode: 'draft', base_version: core.version })).json()).variant.id as string;
    const res = await lifecycle(v, { lifecycle: 'review', base_version: 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('unconfirmed_experience_claims');
    const idx = r.claims.map((c, i) => (c.kind === 'experience' ? i : -1)).filter((i) => i >= 0);
    await confirmClaims(db, ownerA, id, r.run.id, idx, 'confirmed');
    expect((await lifecycle(v, { lifecycle: 'review', base_version: 1 })).status).toBe(200);
  });
});

describe('배포 파일(수동 게시용)', () => {
  it('ZIP: 채널별 본문·메타데이터·첨부(sha256 일치)·manifest(승인 아님·게시 비활성·mock·stale), 다른 owner 404', async () => {
    const id = await newContent();
    const noVariants = await post(packagePOST, `/api/contents/${id}/package`, {}, ctx(id));
    expect(noVariants.status).toBe(409);
    expect((await noVariants.json()).error).toBe('no_variants');

    const ig = (await (await createVariant(id, { channel: 'instagram', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    await attach(ig, { base_version: 1, assets: [{ asset_id: pngA, position: 1, role: 'image' }] });
    await createVariant(id, { channel: 'blog', mode: 'draft', base_version: 1 });
    await appendContentVersion(db, ownerA, id, { baseVersion: 1, body: '바뀐 원고' }); // 둘 다 stale

    const res = await post(packagePOST, `/api/contents/${id}/package`, {}, ctx(id));
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out.notice).toContain('자동 게시 아님');
    const dl = await packageGET(new Request(`${BASE}${out.download_url}`, { headers: cookieHeader(tokenA) }), ctx(out.package_id));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/zip');
    const entries = readZip(new Uint8Array(await dl.arrayBuffer()));
    const byPath = new Map(entries.map((e) => [e.path, e.bytes]));
    const manifest = JSON.parse(Buffer.from(byPath.get('manifest.json')!).toString('utf8'));
    expect(manifest).toMatchObject({ is_approval: false, is_publication: false, publish_mode: 'disabled', mock: true, core_version: { version: 2 } });
    expect(manifest.variants.map((v: { channel: string; stale: boolean }) => [v.channel, v.stale])).toEqual([
      ['blog', true],
      ['instagram', true],
    ]);
    expect(manifest.variants.find((v: { channel: string }) => v.channel === 'instagram').media).toEqual({ complete: true, missing: [] });
    for (const f of manifest.files as Array<{ path: string; sha256: string }>) expect(sha(byPath.get(f.path)!), f.path).toBe(f.sha256);
    expect(Buffer.from(byPath.get('blog/body.md')!).toString('utf8')).toBe(BODY);
    const assetsJson = JSON.parse(Buffer.from(byPath.get('instagram/assets.json')!).toString('utf8'));
    expect(assetsJson).toEqual([expect.objectContaining({ position: 1, role: 'image', sha256: sha(PNG), missing: false })]);
    expect(sha(byPath.get(assetsJson[0].path)!)).toBe(sha(PNG));

    as(B);
    expect((await packageGET(new Request(`${BASE}${out.download_url}`, { headers: cookieHeader(tokenB) }), ctx(out.package_id))).status).toBe(404);
    expect((await post(packagePOST, `/api/contents/${id}/package`, {}, ctx(id), tokenB)).status).toBe(404);
    as(A);
    expect((await packageGET(new Request(`${BASE}/api/packages/not-a-uuid`, { headers: cookieHeader(tokenA) }), ctx('not-a-uuid'))).status).toBe(404);
    // 저장 위치는 EXPORT_LOCAL_DIR/packages/<owner>/<content>/<id>.zip(FIX-T09 P2: 원고별 폴더)
    expect(readFileSync(path.join(tmp, 'exports', 'packages', ownerA, id, `${out.package_id}.zip`)).byteLength).toBe(out.zip_bytes);
  });
});

describe('export → 빈 DB 복원: variants·variant_versions·variant_assets 왕복', () => {
  it('모든 복원 표가 ID·값 그대로, 파생본 현재 버전 포인터 유지', async () => {
    const storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
    const exported = await exportOwner(db, storage, ownerA, { outDir: path.join(tmp, 'bundle-exports') });
    expect(exported.manifest.tables.variants!.rows).toBeGreaterThan(0);
    expect(exported.manifest.tables.variant_assets!.rows).toBeGreaterThan(0);
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-t09@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.conflicts_total).toBe(0);
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, p.restoreId, {
        mode: 'empty_only',
        confirm: true,
        restoresDir,
      });
      expect(r.conflicts_total).toBe(0);
      // FIX-T09(P1): review 조건을 못 채우는 파생본(여기서는 원고가 바뀐 뒤 stale 인 threads 초안)은 draft 로 낮아지고 결과에 남는다.
      const downgraded = new Set(r.downgraded_variants.map((d) => d.variant_id));
      expect(r.downgraded_variants.length).toBeGreaterThan(0);
      expect(r.downgraded_variants.every((d) => d.reasons.length > 0)).toBe(true);
      expect(p.preview.downgraded_variants).toEqual(r.downgraded_variants);
      for (const t of RESTORED_TABLES) {
        const a = (await selectBundleRows(db, t, ownerScope(t, ownerA))).map((x) => x.row);
        const b = (await selectBundleRows(h.db, t, ownerScope(t, target))).map((x) => x.row);
        const expected = t === 'variants' ? a.map((row) => (downgraded.has(row.id as string) ? { ...row, lifecycle: 'draft' } : row)) : a;
        expect(b, t).toEqual(expected);
      }
      const vs = await h.db.select().from(schema.variants).where(and(eq(schema.variants.ownerId, target)));
      expect(vs.some((v) => v.currentVersionId !== null)).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('FIX-T09(Codex review-T09)', () => {
  const EXP = '제가 직접 대리점 대표를 설득했습니다.';
  const EXP_BODY = `${EXP}\n\n두 번째 문단입니다.`;
  const confirmVariant = (contentId: string, body: unknown) =>
    confirmPOST(jsonPost(`/api/contents/${contentId}/claims/confirm`, body, cookieHeader(tokenA)), ctx(contentId));

  it('P0: 경험 문장을 본문(캡션)에서만 빼고 카드에 남기면 removed 409·검토 409, 카드에서도 빼면 둘 다 통과', async () => {
    const id = await newContent(ownerA, EXP_BODY);
    const ai = await (await createVariant(id, { channel: 'instagram', mode: 'ai_draft', base_version: 1 })).json();
    const v = ai.variant.id as string;
    expect((await adopt(v, ai.proposal.id, { base_version: 0 })).status).toBe(201);
    expect((await attach(v, { base_version: 2, assets: [{ asset_id: pngA, position: 1, role: 'image' }] })).status).toBe(201); // v3
    const cur = (await (await variantsGET(new Request(`${BASE}/api/contents/${id}/variants`, { headers: cookieHeader(tokenA) }), ctx(id))).json()).items[0];
    expect(cur.current_version.body).toContain(EXP);
    const expIdx = (ai.claims as Array<{ kind: string }>).map((c, i) => (c.kind === 'experience' ? i : -1)).filter((i) => i >= 0);
    expect(expIdx.length).toBeGreaterThan(0);
    const blocked0 = await lifecycle(v, { lifecycle: 'review', base_version: 3 });
    expect((await blocked0.json()).error).toBe('unconfirmed_experience_claims');

    // 본문(=캡션)에서만 빼고 카드에는 남긴다
    const e1 = await edit(v, { base_version: 3, body: '경험 문장을 뺀 캡션', metadata: { caption: '경험 문장을 뺀 캡션', cards: [{ index: 1, text: EXP }] } });
    expect(e1.status).toBe(201);
    const r1 = await confirmVariant(id, { run_id: ai.run.id, claim_indexes: expIdx, resolution: 'removed' });
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toBe('claim_still_in_body');
    const b1 = await lifecycle(v, { lifecycle: 'review', base_version: 4 });
    expect(b1.status).toBe(409);
    expect((await b1.json()).error).toBe('unconfirmed_experience_claims');

    // 카드에서도 빼면 제외가 되고 검토로 갈 수 있다
    expect((await edit(v, { base_version: 4, body: '경험 문장을 뺀 캡션', metadata: { caption: '경험 문장을 뺀 캡션', cards: [{ index: 1, text: '다른 카드' }] } })).status).toBe(201);
    expect((await confirmVariant(id, { run_id: ai.run.id, claim_indexes: expIdx, resolution: 'removed' })).status).toBe(200);
    expect((await lifecycle(v, { lifecycle: 'review', base_version: 5 })).status).toBe(200);

    // 배포 파일의 output.txt = 검사한 글(본문 + 메타데이터)
    const pk = await (await post(packagePOST, `/api/contents/${id}/package`, {}, ctx(id))).json();
    const entries = readZip(new Uint8Array(await (await packageGET(new Request(`${BASE}${pk.download_url}`, { headers: cookieHeader(tokenA) }), ctx(pk.package_id))).arrayBuffer()));
    const out = Buffer.from(entries.find((e) => e.path === 'instagram/output.txt')!.bytes).toString('utf8');
    expect(out).toBe('경험 문장을 뺀 캡션\n경험 문장을 뺀 캡션\n다른 카드');
    expect(out).not.toContain(EXP);
  });

  it('P0: 본문과 중복 칸(blog markdown 등)이 다르면 400 metadata_body_mismatch', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'blog', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    const res = await edit(v, { base_version: 1, body: '새 본문', metadata: { title: 't', markdown: `새 본문\n\n${EXP}` } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('metadata_body_mismatch');
    expect((await edit(v, { base_version: 1, body: '새 본문', metadata: { title: 't', markdown: '새 본문' } })).status).toBe(201);
  });

  it('P1: 미채택 AI 제안은 뒤의 수정·첨부 후에도 보이고 채택 가능, 무시하면 사라지고 무시한 제안 채택 → 409', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'threads', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    const ai = await (await createVariant(id, { channel: 'threads', mode: 'ai_draft', base_version: 1 })).json();
    expect(ai.proposal.version).toBe(2);
    await edit(v, { base_version: 1, body: '사용자 수정', metadata: { text: '사용자 수정', thread_parts: ['사용자 수정'] } }); // v3
    const list = async () => (await (await variantsGET(new Request(`${BASE}/api/contents/${id}/variants`, { headers: cookieHeader(tokenA) }), ctx(id))).json()).items[0];
    expect((await list()).proposal?.id).toBe(ai.proposal.id);
    // 두 번째 제안을 만들고 무시 → 첫 제안이 다시 보인다(가장 최근 미처리 제안)
    const ai2 = await (await createVariant(id, { channel: 'threads', mode: 'ai_draft', base_version: 1 })).json();
    expect((await list()).proposal?.id).toBe(ai2.proposal.id);
    const dis = await dismissVariantPOST(
      jsonPost(`/api/variants/${v}/proposals/${ai2.run.id}/dismiss`, {}, cookieHeader(tokenA)),
      { params: Promise.resolve({ id: v, runId: ai2.run.id }) },
    );
    expect(dis.status).toBe(200);
    expect((await list()).proposal?.id).toBe(ai.proposal.id);
    expect((await adopt(v, ai2.proposal.id, { base_version: 3 })).status).toBe(409);
    // 첫 제안은 수정 뒤에도 채택 가능 → 채택하면 목록에서 빠지고 다시 채택 → 409
    expect((await adopt(v, ai.proposal.id, { base_version: 3 })).status).toBe(201);
    expect((await list()).proposal).toBeNull();
    expect((await adopt(v, ai.proposal.id, { base_version: 4 })).status).toBe(409);
    // 다른 owner 는 무시할 수 없다
    as(B);
    const other = await dismissVariantPOST(
      jsonPost(`/api/variants/${v}/proposals/${ai.run.id}/dismiss`, {}, cookieHeader(tokenB)),
      { params: Promise.resolve({ id: v, runId: ai.run.id }) },
    );
    expect(other.status).toBe(404);
    as(A);
  });

  it('P1: 원고 AI 제안도 무시하면 채택 불가(409), 이미 무시 → 409', async () => {
    const id = await newContent();
    const r = await runAssist(db, ownerA, id, { mode: 'draft', baseVersion: 1, brandProfileVersion: 1, answerIds: [] }, new MockLlmProvider());
    const dis = (token = tokenA) =>
      dismissContentPOST(jsonPost(`/api/contents/${id}/assist/${r.run.id}/dismiss`, {}, cookieHeader(token)), { params: Promise.resolve({ id, runId: r.run.id }) });
    expect((await dis()).status).toBe(200);
    expect((await dis()).status).toBe(409);
    let code = '';
    try {
      await adoptProposal(db, ownerA, id, r.run.id, 1);
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
    }
    expect(code).toBe('run_not_adoptable');
  });

  it('P1: 묶음의 Threads 버전 ai_run_id 를 같은 원고의 Blog run 으로 바꾸면 복원 미리보기 거부', async () => {
    const id = await newContent();
    const t = await (await createVariant(id, { channel: 'threads', mode: 'ai_draft', base_version: 1 })).json();
    const b = await (await createVariant(id, { channel: 'blog', mode: 'ai_draft', base_version: 1 })).json();
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'swap-exports') });
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const tables = structuredClone(parsed.tables) as BundleTables;
    tables.variant_versions.find((v) => v.id === t.proposal.id)!.ai_run_id = b.run.id;
    const zip = writeZip(
      buildBundle({
        exportId: randomUUID(),
        exportedAt: new Date().toISOString(),
        appVersion: parsed.manifest.app_version,
        migrations: parsed.manifest.schema_migrations,
        owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
        tables,
        assetBytes: new Map(parsed.assetBytes),
      }).entries,
    );
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'swap-t09@example.local')).id;
      await expect(createRestorePreview(h.db, target, zip, { restoresDir: path.join(tmp, 'swap-restores'), source: 'upload' })).rejects.toMatchObject({
        code: 'integrity',
      });
    } finally {
      await h.close();
    }
  });

  it('P1: 첨부 없는 review Instagram 파생본을 복원하면 draft 로 낮추고 이유를 남긴다', async () => {
    const cid = await newContent();
    const iv = (await (await createVariant(cid, { channel: 'instagram', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    await attach(iv, { base_version: 1, assets: [{ asset_id: pngA, position: 1, role: 'image' }] });
    expect((await lifecycle(iv, { lifecycle: 'review', base_version: 2 })).status).toBe(200);
    const exported = await exportOwner(db, new LocalStorageAdapter(path.join(tmp, 'assets')), ownerA, { outDir: path.join(tmp, 'dg-exports') });
    const parsed = await parseBundleZip(new Uint8Array(readFileSync(exported.zipPath)));
    const tables = structuredClone(parsed.tables) as BundleTables;
    const reviewIg = tables.variants.find((v) => v.id === iv && v.lifecycle === 'review');
    expect(reviewIg).toBeDefined();
    tables.variant_assets = [];
    const zip = writeZip(
      buildBundle({
        exportId: randomUUID(),
        exportedAt: new Date().toISOString(),
        appVersion: parsed.manifest.app_version,
        migrations: parsed.manifest.schema_migrations,
        owner: { id: parsed.manifest.owner.id, identityMasked: parsed.manifest.owner.identity_masked },
        tables,
        assetBytes: new Map(parsed.assetBytes),
      }).entries,
    );
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'downgrade-t09@example.local')).id;
      const restoresDir = path.join(tmp, 'dg-restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-dg')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      const d = r.downgraded_variants.find((x) => x.variant_id === reviewIg!.id);
      expect(d).toMatchObject({ channel: 'instagram', reasons: expect.arrayContaining(['media_incomplete:image(이미지 1개 이상)']) });
      const [row] = await h.db.select().from(schema.variants).where(eq(schema.variants.id, reviewIg!.id));
      expect(row!.lifecycle).toBe('draft');
      expect(p.preview.downgraded_variants.map((x) => x.variant_id)).toContain(reviewIg!.id);
    } finally {
      await h.close();
    }
  });

  it('P2: 폼 첨부도 개수 20·순서 50 상한(DB 함수도 검사)', async () => {
    const id = await newContent();
    const v = (await (await createVariant(id, { channel: 'blog', mode: 'draft', base_version: 1 })).json()).variant.id as string;
    const formAttach = () =>
      assetsPOST(
        new Request(`${BASE}/api/variants/${v}/assets`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
          body: new URLSearchParams({ asset_id: pngA, role: 'attachment' }).toString(),
        }),
        ctx(v),
      );
    // position 50 에 하나를 두면 폼 덧붙이기(51)는 거부
    expect((await attach(v, { base_version: 1, assets: [{ asset_id: pngA, position: 50, role: 'attachment' }] })).status).toBe(201);
    const over = await formAttach();
    expect(over.status).toBe(303);
    expect(over.headers.get('location')).toBe(`/contents/${id}?error=invalid`);
    // 20개까지는 되고 21번째는 거부
    await attach(v, { base_version: 2, assets: Array.from({ length: 19 }, (_, i) => ({ asset_id: pngA, position: i + 1, role: 'attachment' as const })) });
    expect((await formAttach()).headers.get('location')).toMatch(/variant_saved=blog/); // 20번째
    const r21 = await formAttach();
    expect(r21.headers.get('location')).toBe(`/contents/${id}?error=invalid`);
    await expect(
      setVariantAssets(db, ownerA, v, { baseVersion: 4, assets: Array.from({ length: 21 }, (_, i) => ({ assetId: pngA, position: i + 1, role: 'attachment' as const })) }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('P2: 작성실 배포 파일 목록은 그 원고의 것만', async () => {
    const a = await newContent();
    const b = await newContent();
    await createVariant(a, { channel: 'blog', mode: 'draft', base_version: 1 });
    await createVariant(b, { channel: 'blog', mode: 'draft', base_version: 1 });
    const pa = await (await post(packagePOST, `/api/contents/${a}/package`, {}, ctx(a))).json();
    const pb = await (await post(packagePOST, `/api/contents/${b}/package`, {}, ctx(b))).json();
    const listA = await listPackages(path.join(tmp, 'exports'), ownerA, a);
    expect(listA.map((p) => p.id)).toEqual([pa.package_id]);
    expect((await listPackages(path.join(tmp, 'exports'), ownerA, b)).map((p) => p.id)).toEqual([pb.package_id]);
    // 다른 원고의 배포 파일도 owner 는 id 로 내려받을 수 있다(owner 범위)
    expect((await packageGET(new Request(`${BASE}/api/packages/${pb.package_id}`, { headers: cookieHeader(tokenA) }), ctx(pb.package_id))).status).toBe(200);
  });
});
