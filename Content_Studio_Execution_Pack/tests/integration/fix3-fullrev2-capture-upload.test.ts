/**
 * FIX3-FULLREV2 capture-upload 묶음 — route handler 를 직접 호출한다(외부 fetch 0).
 * - G27: 목록의 '정확 중복 있음'(has_exact_duplicate)이 상세 findExactDuplicates 와 같은 규칙(원문 해시 또는 정규화 URL)이다.
 *   가져오기 '새 버전'·수집 '고쳐진 글'로 같은 출처에 붙은 소재는 정확 중복이 아니다.
 * - G28: 빠른 수집 폼(urlencoded) 본문 상한이 한국어 원문 20,000자를 덮는다. 글자 수 상한은 zod 가 그대로, 터무니없이 큰 본문은 413.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, getDb, schema, seed, type Db } from '@cs/db';
import { loadConfig, MAX_RAW_TEXT } from '@cs/domain';
import { MOCK_FEEDS, mockCollectorForTest, OVERSEAS_SALES_RSS } from '@cs/providers';
import { GET as captureGET } from '../../apps/web/app/api/captures/[id]/route';
import { GET as listGET, POST as capturesPOST } from '../../apps/web/app/api/captures/route';
import { POST as acceptPOST } from '../../apps/web/app/api/collector/runs/[id]/accept/route';
import { POST as runPOST } from '../../apps/web/app/api/collector/sources/[id]/run/route';
import { POST as settingsPOST } from '../../apps/web/app/api/collector/sources/[id]/settings/route';
import { POST as sourcesPOST } from '../../apps/web/app/api/collector/sources/route';
import { POST as commitPOST } from '../../apps/web/app/api/imports/[id]/commit/route';
import { POST as previewPOST } from '../../apps/web/app/api/imports/preview/route';
import { MAX_CAPTURE_BODY } from '../../apps/web/lib/captures';
import { NOTION_IDS, notionExport } from '../helpers/import-zip';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'fix3-fr2-capture@example.local';

let db: Db;
let ownerA: string;
let tokenA: string;
let tmp: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix3-fr2-cu-'));
  vi.stubEnv('IMPORT_LOCAL_DIR', path.join(tmp, 'imports'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  as(A);
  tokenA = await login(A);
});
beforeEach(() => {
  as(A);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  vi.stubEnv('COLLECTOR_MODE', 'disabled');
  mockCollectorForTest().resetForTest();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

/** GET /api/captures 전체(여러 쪽)를 읽어 id → has_exact_duplicate. */
async function listFlags(): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  let cursor: string | null = null;
  for (;;) {
    const url = `${BASE}/api/captures?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await listGET(new Request(url, { headers: cookieHeader(tokenA) }), ctx(''));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; has_exact_duplicate: boolean }>; next_cursor: string | null };
    for (const i of body.items) out.set(i.id, i.has_exact_duplicate);
    if (!body.next_cursor) return out;
    cursor = body.next_cursor;
  }
}

/** 상세 GET 의 정확 중복 목록. */
async function detailExact(id: string): Promise<Array<{ id: string; reason: string }>> {
  const res = await captureGET(new Request(`${BASE}/api/captures/${id}`, { headers: cookieHeader(tokenA) }), ctx(id));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { duplicates: { exact: Array<{ id: string; reason: string }> } };
  return body.duplicates.exact;
}

function upload(bytes: Uint8Array): Request {
  const form = new FormData();
  form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], 'notion-export.zip', { type: 'application/zip' }));
  form.set('source_kind', 'notion_export');
  return new Request(`${BASE}/api/imports/preview`, { method: 'POST', headers: { accept: 'application/json', origin: BASE, ...cookieHeader(tokenA) }, body: form });
}

describe('FIX3-FULLREV2(G27) — 목록 정확 중복 표시 = 상세 규칙', () => {
  it('가져오기 "새 버전"으로 같은 출처에 소재 2개 → 목록 플래그 false(상세도 정확 중복 없음)', async () => {
    const first = (await (await previewPOST(upload(notionExport()))).json()) as { import_id: string; items: Array<{ id: string; external_id: string }> };
    const p1 = first.items.find((i) => i.external_id === `notion:${NOTION_IDS.page1}`)!;
    const c1 = await (await commitPOST(jsonPost(`/api/imports/${first.import_id}/commit`, { item_ids: [p1.id] }, cookieHeader(tokenA)), ctx(first.import_id))).json();
    const cap1 = c1.items.find((i: { external_id: string }) => i.external_id === `notion:${NOTION_IDS.page1}`).target_capture_id as string;

    const changed = notionExport({ page1: '# 현지 파트너 첫 미팅\n\n외부에서 고친 내용(합성, G27).\n' });
    const second = (await (await previewPOST(upload(changed))).json()) as { import_id: string; items: Array<{ id: string; external_id: string; decision: string }> };
    const q1 = second.items.find((i) => i.external_id === `notion:${NOTION_IDS.page1}`)!;
    expect(q1.decision).toBe('conflict');
    const c2 = await (await commitPOST(jsonPost(`/api/imports/${second.import_id}/commit`, { version_ids: [q1.id] }, cookieHeader(tokenA)), ctx(second.import_id))).json();
    const item2 = c2.items.find((i: { external_id: string }) => i.external_id === `notion:${NOTION_IDS.page1}`);
    expect(item2.outcome).toBe('versioned');
    const cap2 = item2.target_capture_id as string;

    const [r1] = await db.select().from(schema.captures).where(eq(schema.captures.id, cap1));
    const [r2] = await db.select().from(schema.captures).where(eq(schema.captures.id, cap2));
    expect(r2!.sourceId).toBe(r1!.sourceId); // 같은 출처
    expect(r2!.contentHash).not.toBe(r1!.contentHash);

    const flags = await listFlags();
    expect(flags.get(cap1)).toBe(false);
    expect(flags.get(cap2)).toBe(false);
    expect(await detailExact(cap1)).toEqual([]);
    expect(await detailExact(cap2)).toEqual([]);
  });

  it('수집 "고쳐진 글"(updated)로 같은 출처에 소재 2개 → 목록 플래그 false', async () => {
    vi.stubEnv('COLLECTOR_MODE', 'mock');
    const added = await sourcesPOST(jsonPost('/api/collector/sources', { kind: 'rss', url: MOCK_FEEDS.overseasSales }, cookieHeader(tokenA)));
    expect(added.status).toBe(201);
    const src = ((await added.json()) as { source: { id: string } }).source;
    expect((await settingsPOST(jsonPost(`/api/collector/sources/${src.id}/settings`, { enabled: true }, cookieHeader(tokenA)), ctx(src.id))).status).toBe(200);
    type RunBody = { run: { run_id: string }; items: Array<{ id: string; guid: string | null; decision: string; reason: string; capture_id: string | null }> };
    const runOnce = async () => {
      const res = await runPOST(jsonPost(`/api/collector/sources/${src.id}/run`, {}, cookieHeader(tokenA)), ctx(src.id));
      expect(res.status).toBe(200);
      return (await res.json()) as RunBody;
    };
    const accept = async (r: RunBody, guid: string) => {
      const it = r.items.find((i) => i.guid === guid && i.decision === 'new')!;
      const out = (await (await acceptPOST(jsonPost(`/api/collector/runs/${r.run.run_id}/accept`, { item_ids: [it.id] }, cookieHeader(tokenA)), ctx(r.run.run_id))).json()) as RunBody;
      return out.items.find((i) => i.id === it.id)!.capture_id!;
    };
    const capOld = await accept(await runOnce(), 'os-001');
    mockCollectorForTest().setFixtureForTest(MOCK_FEEDS.overseasSales, {
      kind: 'ok',
      contentType: 'application/rss+xml',
      body: OVERSEAS_SALES_RSS.replace('먼저 묻는다.', '먼저 묻고 계약 조건도 본다(G27).'),
    });
    const r2 = await runOnce();
    const u = r2.items.find((i) => i.guid === 'os-001' && i.decision === 'new')!;
    expect(u.reason).toBe('updated');
    const capNew = await accept(r2, 'os-001');
    const [a] = await db.select().from(schema.captures).where(eq(schema.captures.id, capOld));
    const [b] = await db.select().from(schema.captures).where(eq(schema.captures.id, capNew));
    expect(b!.sourceId).toBe(a!.sourceId);
    const flags = await listFlags();
    expect(flags.get(capOld)).toBe(false);
    expect(flags.get(capNew)).toBe(false);
  });

  it('진짜 정확 중복(같은 원문·같은 정규화 URL)은 그대로 목록 true, 상세와 같음', async () => {
    const make = async (body: Record<string, unknown>) => {
      const res = await capturesPOST(jsonPost('/api/captures', { ...body, command_key: crypto.randomUUID() }, cookieHeader(tokenA)));
      expect(res.status).toBe(201);
      return ((await res.json()) as { capture: { id: string } }).capture.id;
    };
    const t1 = await make({ input_type: 'text', raw_text: 'G27 같은 원문(합성)' });
    const t2 = await make({ input_type: 'text', raw_text: 'G27 같은 원문(합성)' });
    const u1 = await make({ input_type: 'url', url: 'https://example.com/g27-article?utm_source=a' });
    const u2 = await make({ input_type: 'url', url: 'https://EXAMPLE.com/g27-article', raw_text: '내 말은 다름' });
    const lone = await make({ input_type: 'text', raw_text: 'G27 혼자인 원문(합성)' });
    const flags = await listFlags();
    for (const id of [t1, t2, u1, u2]) expect(flags.get(id), id).toBe(true);
    expect(flags.get(lone)).toBe(false);
    expect((await detailExact(u1)).map((d) => [d.id, d.reason])).toContainEqual([u2, 'url']);
    expect((await detailExact(t1)).map((d) => d.id)).toContain(t2);
    // 다른 owner 의 같은 원문은 중복이 아니다(owner 조건 유지) — 같은 owner 안에서만 판정
    const owners = await db.select({ o: schema.captures.ownerId }).from(schema.captures).where(and(eq(schema.captures.id, t1)));
    expect(owners[0]!.o).toBe(ownerA);
  });
});

describe('FIX3-FULLREV2(G28) — 빠른 수집 폼 본문 상한', () => {
  const formPost = (fields: Record<string, string>) =>
    capturesPOST(
      new Request(`${BASE}/api/captures`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
        body: new URLSearchParams(fields).toString(),
      }),
    );

  it('한국어 원문 20,000자(+ 메모 2,000자·제목 200자) 폼 제출 → 303 saved=1, 그대로 저장', async () => {
    const raw = '가'.repeat(MAX_RAW_TEXT);
    const fields = { raw_text: raw, url: '', user_note: '나'.repeat(2000), title: '다'.repeat(200), command_key: crypto.randomUUID() };
    expect(new URLSearchParams(fields).toString().length).toBeGreaterThan(128 * 1024); // 예전 상한을 넘는 크기
    const res = await formPost(fields);
    expect(res.status).toBe(303);
    const loc = res.headers.get('location')!;
    expect(loc).toMatch(/^\/captures\/[0-9a-f-]{36}\?saved=1$/);
    const id = loc.split('/')[2]!.split('?')[0]!;
    const [row] = await db.select().from(schema.captures).where(eq(schema.captures.id, id));
    expect(row!.rawText).toBe(raw);
    expect(row!.userNote).toBe('나'.repeat(2000));
  });

  it('20,001자는 본문 상한 안이지만 글자 수 검사(zod)로 거부 → /?capture_error=invalid, 저장 0', async () => {
    const k = crypto.randomUUID();
    const res = await formPost({ raw_text: '가'.repeat(MAX_RAW_TEXT + 1), url: '', command_key: k });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/?capture_error=invalid');
    expect(await db.select().from(schema.captures).where(and(eq(schema.captures.ownerId, ownerA), eq(schema.captures.commandKey, k)))).toHaveLength(0);
  });

  it('상한을 넘는 터무니없이 큰 본문 → JSON 413 payload_too_large, 폼은 too_large', async () => {
    const huge = 'a'.repeat(MAX_CAPTURE_BODY + 1);
    const res = await capturesPOST(jsonPost('/api/captures', { input_type: 'text', raw_text: huge, command_key: crypto.randomUUID() }, cookieHeader(tokenA)));
    expect(res.status).toBe(413);
    const form = await formPost({ raw_text: huge, url: '', command_key: crypto.randomUUID() });
    expect(form.headers.get('location')).toBe('/?capture_error=too_large');
    expect(MAX_CAPTURE_BODY).toBeLessThan(1024 * 1024); // 상한 자체는 여전히 작다(약 300KiB)
  });
});
