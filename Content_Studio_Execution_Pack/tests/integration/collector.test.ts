/**
 * T19(제안 결정 D33) 허용 소스 수집(모의)·재추천 — route handler 를 직접 호출한다(실제 웹 요청 0: fetch spy).
 * 기본 꺼짐·live 준비 안 됨·주소 정책(A05)·미리보기 무쓰기·일부만 받아들이기·중복/고쳐진 글·다시 읽기 불일치·A04·owner 격리(A01)·
 * 주기 실행 기본 꺼짐(켜도 미리보기만)·재추천 결정성·닫기·내보내기/복원 훈련.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { closeDb, getDb, runDueCollectorSources, runRestoreDrill, schema, seed, type Db } from '@cs/db';
import { contentHash, loadConfig, sha256Bytes } from '@cs/domain';
import { DisabledPublisher, LocalStorageAdapter, MOCK_FEEDS, mockCollectorForTest, OVERSEAS_SALES_RSS } from '@cs/providers';
import { runWorkerTick } from '@cs/worker';
import { POST as capturesPOST } from '../../apps/web/app/api/captures/route';
import { GET as originalGET } from '../../apps/web/app/api/imports/originals/[versionId]/route';
import { POST as acceptPOST } from '../../apps/web/app/api/collector/runs/[id]/accept/route';
import { POST as discardPOST } from '../../apps/web/app/api/collector/runs/[id]/discard/route';
import { GET as runGET } from '../../apps/web/app/api/collector/runs/[id]/route';
import { POST as runPOST } from '../../apps/web/app/api/collector/sources/[id]/run/route';
import { POST as settingsPOST } from '../../apps/web/app/api/collector/sources/[id]/settings/route';
import { GET as sourcesGET, POST as sourcesPOST } from '../../apps/web/app/api/collector/sources/route';
import { POST as dismissPOST } from '../../apps/web/app/api/recommendations/[captureId]/dismiss/route';
import { GET as recsGET } from '../../apps/web/app/api/recommendations/route';
import { BASE, cookieHeader, jsonPost, login } from './helpers';

const A = 'collector@example.local';
const B = 'collector-other@example.local';

let db: Db;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;
let tmp: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const n = async (table: PgTable, where?: SQL) => Number((await db.select({ n: count() }).from(table).where(where))[0]!.n);

interface SourceView {
  id: string;
  kind: string;
  url: string;
  host: string;
  enabled: boolean;
  schedule: string;
}
interface ItemView {
  id: string;
  external_key: string | null;
  guid: string | null;
  title: string | null;
  excerpt: string;
  decision: string;
  reason: string;
  outcome: string | null;
  capture_id: string | null;
  source_version_id: string | null;
  content_checksum: string;
  raw_sha256: string;
}
interface RunBody {
  run: { run_id: string; status: string; error_code: string | null; counts: Record<string, number>; trigger: string; mode: string };
  items: ItemView[];
  result?: Record<string, number>;
}

async function writeCounts(ownerId: string) {
  return {
    captures: await n(schema.captures, eq(schema.captures.ownerId, ownerId)),
    sources: await n(schema.sources, eq(schema.sources.ownerId, ownerId)),
    originals: await n(schema.sourceVersionOriginals, eq(schema.sourceVersionOriginals.ownerId, ownerId)),
    capture_revisions: await n(schema.captureRevisions, eq(schema.captureRevisions.ownerId, ownerId)),
    distribution_items: await n(schema.distributionItems, eq(schema.distributionItems.ownerId, ownerId)),
    jobs: await n(schema.jobs, eq(schema.jobs.ownerId, ownerId)),
  };
}

async function addSource(kind: string, url: string, token = tokenA, label?: string): Promise<Response> {
  return sourcesPOST(jsonPost('/api/collector/sources', { kind, url, ...(label ? { label } : {}) }, cookieHeader(token)));
}
async function addSourceOk(kind: string, url: string, token = tokenA): Promise<SourceView> {
  const res = await addSource(kind, url, token);
  expect(res.status).toBe(201);
  return ((await res.json()) as { source: SourceView }).source;
}
const settings = (id: string, body: unknown, token = tokenA) => settingsPOST(jsonPost(`/api/collector/sources/${id}/settings`, body, cookieHeader(token)), ctx(id));
const run = (id: string, token = tokenA) => runPOST(jsonPost(`/api/collector/sources/${id}/run`, {}, cookieHeader(token)), ctx(id));
async function runOk(id: string, token = tokenA): Promise<RunBody> {
  const res = await run(id, token);
  expect(res.status).toBe(200);
  return (await res.json()) as RunBody;
}
const accept = (runId: string, ids: string[], token = tokenA) => acceptPOST(jsonPost(`/api/collector/runs/${runId}/accept`, { item_ids: ids }, cookieHeader(token)), ctx(runId));
const byGuid = (items: ItemView[], guid: string) => items.find((i) => i.guid === guid)!;

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-collector-'));
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  as(A);
  tokenA = await login(A);
  as(B);
  tokenB = await login(B);
  ownerB = (await db.select().from(schema.users).where(eq(schema.users.allowedIdentity, B)))[0]!.id;
  as(A);
});
beforeEach(() => {
  as(A);
  vi.stubEnv('COLLECTOR_MODE', 'mock');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  // 수집기는 외부에 아무 요청도 하지 않는다(모의 고정 자료만).
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
  vi.stubEnv('COLLECTOR_MODE', 'disabled');
  vi.stubEnv('COLLECTOR_SCHEDULER', '');
  mockCollectorForTest().resetForTest();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('기본 꺼짐·실제 수집 준비 안 됨', () => {
  it('소스 추가는 어떤 모드에서도 요청 없이 저장 — 꺼진 상태·주기 off', async () => {
    vi.stubEnv('COLLECTOR_MODE', 'disabled');
    const s = await addSourceOk('rss', MOCK_FEEDS.overseasSales);
    expect(s).toMatchObject({ enabled: false, schedule: 'off', host: 'overseas-sales.mock.example', kind: 'rss' });
    const list = (await (await sourcesGET(new Request(`${BASE}/api/collector/sources`, { headers: cookieHeader(tokenA) }), ctx(''))).json()) as {
      readiness: { mode: string; can_run: boolean; scheduler: string };
      sources: SourceView[];
    };
    expect(list.readiness).toMatchObject({ mode: 'disabled', can_run: false, scheduler: 'off' });
    expect(list.sources.map((x) => x.id)).toContain(s.id);
  });

  it('COLLECTOR_MODE=disabled → 503 collector_disabled, enabled(실제) → 503 collector_live_not_ready(빠진 조건), 실행 기록 0', async () => {
    const [s] = await db.select().from(schema.collectorSources).where(and(eq(schema.collectorSources.ownerId, ownerA), eq(schema.collectorSources.url, MOCK_FEEDS.overseasSales)));
    await settings(s!.id, { enabled: true });
    const before = await n(schema.collectorRuns, eq(schema.collectorRuns.ownerId, ownerA));
    vi.stubEnv('COLLECTOR_MODE', 'disabled');
    const r1 = await run(s!.id);
    expect(r1.status).toBe(503);
    expect((await r1.json()).error).toBe('collector_disabled');
    vi.stubEnv('COLLECTOR_MODE', 'enabled');
    const r2 = await run(s!.id);
    expect(r2.status).toBe(503);
    const b2 = await r2.json();
    expect(b2.error).toBe('collector_live_not_ready');
    expect(b2.missing.length).toBeGreaterThan(0);
    expect(await n(schema.collectorRuns, eq(schema.collectorRuns.ownerId, ownerA))).toBe(before);
    await settings(s!.id, { enabled: false });
  });

  it('주소 정책: http·IP 리터럴(메타데이터·10진)·localhost·기본 아닌 포트 → 400 collector_url_blocked, 저장 0. 같은 주소 두 번 → 409', async () => {
    const before = await n(schema.collectorSources, eq(schema.collectorSources.ownerId, ownerA));
    for (const [url, reason] of [
      ['http://overseas-sales.mock.example/feed.xml', 'scheme'],
      ['https://169.254.169.254/latest/meta-data/', 'ip_literal'],
      ['https://2130706433/feed', 'ip_literal'],
      ['https://[::1]/feed', 'ip_literal'],
      ['https://localhost/feed.xml', 'blocked_host'],
      ['https://metadata.google.internal/', 'blocked_host'],
      ['https://overseas-sales.mock.example:8080/feed.xml', 'port'],
    ] as const) {
      const res = await addSource('rss', url);
      expect(res.status, url).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'collector_url_blocked', reason });
    }
    expect(await n(schema.collectorSources, eq(schema.collectorSources.ownerId, ownerA))).toBe(before);
    const dup = await addSource('rss', 'https://OVERSEAS-SALES.mock.example/feed.xml?utm_source=x');
    expect(dup.status).toBe(409);
    expect((await addSource('ftp', MOCK_FEEDS.overseasSales)).status).toBe(400);
  });

  it('로그인 없음 401, Origin 없음 403', async () => {
    const noAuth = new Request(`${BASE}/api/collector/sources`, { method: 'POST', headers: { origin: BASE, 'content-type': 'application/json', accept: 'application/json' }, body: '{}' });
    expect((await sourcesPOST(noAuth)).status).toBe(401);
    const noOrigin = new Request(`${BASE}/api/collector/sources`, { method: 'POST', headers: { ...cookieHeader(tokenA), 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ kind: 'rss', url: MOCK_FEEDS.aiAtWork }) });
    expect((await sourcesPOST(noOrigin)).status).toBe(403);
  });
});

let feedSource: SourceView;
let firstRun: RunBody;

describe('수동 실행(모의) → 미리보기 → 고른 항목만 소재로', () => {
  it('꺼진 소스는 409 collector_source_disabled', async () => {
    const [s] = await db.select().from(schema.collectorSources).where(and(eq(schema.collectorSources.ownerId, ownerA), eq(schema.collectorSources.url, MOCK_FEEDS.overseasSales)));
    feedSource = { id: s!.id } as SourceView;
    const res = await run(feedSource.id);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('collector_source_disabled');
  });

  it('미리보기: 새 3·중복 1(같은 피드 반복)·건너뜀 2(내부 링크·키 없음), 소재·출처·원본·이력·배포 쓰기 0, 원장에는 발췌만', async () => {
    expect((await settings(feedSource.id, { enabled: true })).status).toBe(200);
    const before = await writeCounts(ownerA);
    firstRun = await runOk(feedSource.id);
    expect(firstRun.run).toMatchObject({ status: 'preview', trigger: 'manual', mode: 'mock', error_code: null });
    expect(firstRun.run.counts).toEqual({ total: 6, new: 3, duplicate: 1, skipped: 2 });
    expect(firstRun.items.map((i) => [i.guid, i.decision, i.reason])).toEqual([
      ['os-001', 'new', 'new'],
      ['os-002', 'new', 'new'],
      ['os-003', 'new', 'new'],
      ['os-001', 'duplicate', 'in_feed'],
      ['os-005', 'skipped', 'blocked_link'],
      [null, 'skipped', 'no_id'],
    ]);
    expect(await writeCounts(ownerA)).toEqual(before);
    for (const i of firstRun.items) expect(i.excerpt.length).toBeLessThanOrEqual(200);
    const [src] = await db.select().from(schema.collectorSources).where(eq(schema.collectorSources.id, feedSource.id));
    expect(src!.lastStatus).toBe('preview');
    expect(src!.lastRunAt).not.toBeNull();
  });

  it('선택 검증: 빈 선택 400, 중복·건너뜀 항목 400, 다른 실행·없는 ID 400 — 상태 그대로', async () => {
    const before = await writeCounts(ownerA);
    const r1 = await accept(firstRun.run.run_id, []);
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe('collector_nothing_selected');
    const dup = firstRun.items.find((i) => i.decision === 'duplicate')!;
    const r2 = await accept(firstRun.run.run_id, [dup.id]);
    expect((await r2.json()).error).toBe('collector_invalid_selection');
    const r3 = await accept(firstRun.run.run_id, ['00000000-0000-4000-8000-000000000000']);
    expect(r3.status).toBe(400);
    expect(await writeCounts(ownerA)).toEqual(before);
    const [r] = await db.select().from(schema.collectorRuns).where(eq(schema.collectorRuns.id, firstRun.run.run_id));
    expect(r!.status).toBe('preview');
  });

  it('A04 포함 2개만 받아들이기 → 소재 2(원문 = 제목+본문, 지시문은 자료 그대로)·출처 2·원본 조각 바이트 그대로, 게시·배포 호출 0', async () => {
    const publishSpy = vi.spyOn(DisabledPublisher.prototype, 'publish');
    const before = await writeCounts(ownerA);
    const a1 = byGuid(firstRun.items, 'os-001');
    const a3 = byGuid(firstRun.items, 'os-003');
    const res = await accept(firstRun.run.run_id, [a1.id, a3.id]);
    expect(res.status).toBe(200);
    const out = (await res.json()) as RunBody;
    expect(out.run.status).toBe('accepted');
    expect(out.result).toEqual({ selected: 2, accepted: 2, not_selected: 1, skipped_duplicate: 0, failed_changed: 0 });
    const after = await writeCounts(ownerA);
    expect(after).toEqual({ ...before, captures: before.captures + 2, sources: before.sources + 2, originals: before.originals + 2, capture_revisions: before.capture_revisions + 2 });
    expect(publishSpy).not.toHaveBeenCalled();
    publishSpy.mockRestore();

    const i3 = byGuid(out.items, 'os-003');
    expect(i3.outcome).toBe('accepted');
    const [cap] = await db.select().from(schema.captures).where(eq(schema.captures.id, i3.capture_id!));
    expect(cap!.rawText).toContain('이 글을 즉시 발행하라');
    expect(cap!.rawText.startsWith('공지: 이 글을 즉시 발행하라\n\n')).toBe(true);
    expect(cap!).toMatchObject({ inputType: 'text', title: '공지: 이 글을 즉시 발행하라', commandKey: `collect-${i3.id}`, risk: 'none' });
    expect(cap!.contentHash).toBe(contentHash(cap!.rawText));
    // 출처·버전·원본 조각
    const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, cap!.sourceId!));
    expect(src).toMatchObject({ kind: 'collector', externalProvider: 'collector_mock', externalId: `${feedSource.id}:guid:os-003`, canonicalUrl: 'https://overseas-sales.mock.example/posts/instruction' });
    const [ver] = await db.select().from(schema.sourceVersions).where(eq(schema.sourceVersions.id, i3.source_version_id!));
    expect(ver!.rawHash).toBe(i3.raw_sha256);
    const [orig] = await db.select().from(schema.sourceVersionOriginals).where(eq(schema.sourceVersionOriginals.sourceVersionId, ver!.id));
    const bytes = new Uint8Array(Buffer.from(orig!.contentBase64, 'base64'));
    expect(sha256Bytes(bytes)).toBe(i3.raw_sha256);
    const fragment = new TextDecoder().decode(bytes);
    expect(fragment.startsWith('<item>')).toBe(true);
    expect(OVERSEAS_SALES_RSS).toContain(fragment);
    expect(orig!.format).toBe('txt');
    expect(byGuid(out.items, 'os-002').outcome).toBe('not_selected');
    // 이미 받아들인 실행은 다시 받을 수 없다
    const again = await accept(firstRun.run.run_id, [byGuid(firstRun.items, 'os-002').id]);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('collector_run_not_open');
  });

  it('다시 실행: 받아들인 글은 same_item 중복, 안 받은 글은 다시 새 항목. 미리보기는 쓰기 0', async () => {
    const before = await writeCounts(ownerA);
    const r = await runOk(feedSource.id);
    expect(r.items.slice(0, 3).map((i) => [i.guid, i.decision, i.reason])).toEqual([
      ['os-001', 'duplicate', 'same_item'],
      ['os-002', 'new', 'new'],
      ['os-003', 'duplicate', 'same_item'],
    ]);
    expect(await writeCounts(ownerA)).toEqual(before);
    // 이 미리보기는 버린다
    const d = await discardPOST(jsonPost(`/api/collector/runs/${r.run.run_id}/discard`, {}, cookieHeader(tokenA)), ctx(r.run.run_id));
    expect(d.status).toBe(200);
    expect((await accept(r.run.run_id, [byGuid(r.items, 'os-002').id])).status).toBe(409);
  });

  it('고쳐진 글(같은 guid·다른 내용) → updated 새 항목 → 받아들이면 같은 출처에 새 버전 + 새 소재, 기존 소재 그대로', async () => {
    const changed = OVERSEAS_SALES_RSS.replace('먼저 묻는다.', '먼저 묻고 계약 조건도 본다.');
    expect(changed).not.toBe(OVERSEAS_SALES_RSS);
    mockCollectorForTest().setFixtureForTest(MOCK_FEEDS.overseasSales, { kind: 'ok', contentType: 'application/rss+xml', body: changed });
    const r = await runOk(feedSource.id);
    const u = byGuid(r.items, 'os-001');
    expect([u.decision, u.reason]).toEqual(['new', 'updated']);
    const [oldItem] = await db
      .select()
      .from(schema.collectedItems)
      .where(and(eq(schema.collectedItems.ownerId, ownerA), eq(schema.collectedItems.externalKey, 'guid:os-001'), eq(schema.collectedItems.outcome, 'accepted')));
    const [oldCap] = await db.select().from(schema.captures).where(eq(schema.captures.id, oldItem!.captureId!));
    const out = (await (await accept(r.run.run_id, [u.id])).json()) as RunBody;
    expect(out.result!.accepted).toBe(1);
    const nu = byGuid(out.items, 'os-001');
    const [newCap] = await db.select().from(schema.captures).where(eq(schema.captures.id, nu.capture_id!));
    expect(newCap!.sourceId).toBe(oldCap!.sourceId);
    expect(newCap!.rawText).toContain('계약 조건도 본다');
    const [oldCapAfter] = await db.select().from(schema.captures).where(eq(schema.captures.id, oldCap!.id));
    expect(oldCapAfter).toEqual(oldCap);
    expect(await n(schema.sourceVersions, eq(schema.sourceVersions.sourceId, oldCap!.sourceId!))).toBe(2);
  });

  it('미리보기 뒤 원본이 바뀌면 그 항목은 failed_changed — 소재를 만들지 않는다', async () => {
    const r = await runOk(feedSource.id);
    const i2 = byGuid(r.items, 'os-002');
    expect(i2.decision).toBe('new');
    mockCollectorForTest().setFixtureForTest(MOCK_FEEDS.overseasSales, {
      kind: 'ok',
      contentType: 'application/rss+xml',
      body: OVERSEAS_SALES_RSS.replace('다음 행동', '다른 행동'),
    });
    const before = await writeCounts(ownerA);
    const out = (await (await accept(r.run.run_id, [i2.id])).json()) as RunBody;
    expect(out.result).toMatchObject({ accepted: 0, failed_changed: 1 });
    expect(byGuid(out.items, 'os-002')).toMatchObject({ outcome: 'failed_changed', capture_id: null });
    expect(await writeCounts(ownerA)).toEqual(before);
  });

  it('기존 소재의 URL 과 같은 링크 → existing_capture 중복(Atom, 상대 링크 해석)', async () => {
    const cap = await capturesPOST(
      jsonPost('/api/captures', { input_type: 'url', url: 'https://ai-at-work.mock.example/posts/prompt-notes?utm_source=mail', command_key: 'collector-existing-url-1' }, cookieHeader(tokenA)),
    );
    expect(cap.status).toBe(201);
    const s = await addSourceOk('atom', MOCK_FEEDS.aiAtWork);
    await settings(s.id, { enabled: true });
    const r = await runOk(s.id);
    expect(r.items.map((i) => [i.guid, i.decision, i.reason])).toEqual([
      ['urn:mock:ai-at-work:1', 'new', 'new'],
      ['urn:mock:ai-at-work:2', 'duplicate', 'existing_capture'],
    ]);
    // 선택 URL(페이지) 소스는 항목 하나, 원본은 HTML 그대로
    const p = await addSourceOk('url', MOCK_FEEDS.expatPage);
    await settings(p.id, { enabled: true });
    const pr = await runOk(p.id);
    expect(pr.items).toHaveLength(1);
    expect(pr.items[0]).toMatchObject({ decision: 'new', title: '해외 주재 첫해 회고' }) // h1 이 제목(title 태그보다 우선 — T18 htmlToText 규칙);
    const out = (await (await accept(pr.run.run_id, [pr.items[0]!.id])).json()) as RunBody;
    const [orig] = await db.select().from(schema.sourceVersionOriginals).where(eq(schema.sourceVersionOriginals.sourceVersionId, out.items[0]!.source_version_id!));
    expect(orig!.format).toBe('html');
    const [c] = await db.select().from(schema.captures).where(eq(schema.captures.id, out.items[0]!.capture_id!));
    expect(c!.rawText).not.toContain('alert');
  });
});

describe('A05 — 실행 중 정책 차단·형식 오류는 기록만, 소스는 그대로', () => {
  it('redirect → 메타데이터·localhost·허용 목록 밖, 사설 주소로 풀리는 이름 → blocked; 깨진 XML·DTD·1MB 초과 → failed. 항목·소재 0', async () => {
    const cases: Array<[string, string, string]> = [
      [MOCK_FEEDS.redirectToMetadata, 'blocked', 'blocked:scheme'],
      [MOCK_FEEDS.redirectToLocalhost, 'blocked', 'blocked:blocked_host'],
      [MOCK_FEEDS.redirectOffList, 'blocked', 'blocked:not_allowlisted'],
      [MOCK_FEEDS.rebind, 'blocked', 'blocked:private_address'],
      [MOCK_FEEDS.malformed, 'failed', 'feed_malformed'],
      [MOCK_FEEDS.dtd, 'failed', 'feed_dtd_not_allowed'],
      [MOCK_FEEDS.oversized, 'failed', 'too_large'],
      ['https://overseas-sales.mock.example/missing.xml', 'failed', 'not_found'],
    ];
    const before = await writeCounts(ownerA);
    for (const [url, status, code] of cases) {
      const s = await addSourceOk('rss', url);
      await settings(s.id, { enabled: true });
      const r = await runOk(s.id);
      expect(r.run, url).toMatchObject({ status, error_code: code });
      expect(r.items).toEqual([]);
      const [src] = await db.select().from(schema.collectorSources).where(eq(schema.collectorSources.id, s.id));
      expect(src!.lastStatus).toBe(status);
    }
    expect(await writeCounts(ownerA)).toEqual(before);
    // 메타데이터·localhost 주소는 "요청" 목록에도 없다
    expect(mockCollectorForTest().requested.some((u) => u.includes('169.254.169.254') || u.startsWith('https://localhost'))).toBe(false);
  });

  it('같은 호스트 안 redirect 는 따라가 미리보기', async () => {
    const s = await addSourceOk('rss', MOCK_FEEDS.redirectSameHost);
    await settings(s.id, { enabled: true });
    const r = await runOk(s.id);
    expect(r.run.status).toBe('preview');
    expect(r.items.map((i) => i.guid)).toEqual(['moved-1']);
  });
});

describe('owner 격리(A01)', () => {
  it('B 는 A 의 소스·실행을 보거나 실행·설정·받아들이기·버리기 못한다(404), 같은 주소를 B 가 따로 등록 가능', async () => {
    as(B);
    const runGetB = await runGET(new Request(`${BASE}/api/collector/runs/${firstRun.run.run_id}`, { headers: cookieHeader(tokenB) }), ctx(firstRun.run.run_id));
    expect(runGetB.status).toBe(404);
    expect((await run(feedSource.id, tokenB)).status).toBe(404);
    expect((await settings(feedSource.id, { enabled: false }, tokenB)).status).toBe(404);
    expect((await accept(firstRun.run.run_id, [firstRun.items[1]!.id], tokenB)).status).toBe(404);
    expect((await discardPOST(jsonPost(`/api/collector/runs/${firstRun.run.run_id}/discard`, {}, cookieHeader(tokenB)), ctx(firstRun.run.run_id))).status).toBe(404);
    const list = (await (await sourcesGET(new Request(`${BASE}/api/collector/sources`, { headers: cookieHeader(tokenB) }), ctx(''))).json()) as { sources: SourceView[] };
    expect(list.sources).toEqual([]);
    const sb = await addSourceOk('rss', MOCK_FEEDS.overseasSales, tokenB);
    await settings(sb.id, { enabled: true }, tokenB);
    const rb = await runOk(sb.id, tokenB);
    // B 에게는 A 가 받아들인 글이 중복이 아니다(owner 별)
    expect(rb.items.slice(0, 3).map((i) => i.decision)).toEqual(['new', 'new', 'new']);
    expect(await n(schema.captures, eq(schema.captures.ownerId, ownerB))).toBe(0);
  });
});

describe('주기 실행 — 기본 꺼짐, 켜도 미리보기만', () => {
  it('주기 daily 로 저장해도 COLLECTOR_SCHEDULER 기본 off → worker tick 은 건너뜀(scheduler_off), 실행 0', async () => {
    await settings(feedSource.id, { schedule: 'daily' });
    const before = await n(schema.collectorRuns);
    const tick = await runWorkerTick({ config: loadConfig(), db, collector: mockCollectorForTest() });
    expect(tick.collector).toEqual({ skipped: 'scheduler_off', ran: 0, previews: 0, failed: 0 });
    expect(await n(schema.collectorRuns)).toBe(before);
  });

  it('COLLECTOR_SCHEDULER=on 이어도 COLLECTOR_MODE 가 mock 이 아니면 건너뜀', async () => {
    vi.stubEnv('COLLECTOR_SCHEDULER', 'on');
    vi.stubEnv('COLLECTOR_MODE', 'disabled');
    expect(await runDueCollectorSources(db, loadConfig(), null)).toMatchObject({ skipped: 'collector_not_mock', ran: 0 });
    vi.stubEnv('COLLECTOR_MODE', 'enabled');
    expect(await runDueCollectorSources(db, loadConfig(), mockCollectorForTest())).toMatchObject({ skipped: 'collector_not_mock', ran: 0 });
  });

  it('on + mock: 기한이 된 켜진 소스만 주기 실행 → 미리보기만(소재 0), 다음 기한 전에는 다시 안 돎', async () => {
    vi.stubEnv('COLLECTOR_SCHEDULER', 'on');
    const now = new Date(Date.now() + 2 * 86400_000);
    const before = await writeCounts(ownerA);
    const r = await runDueCollectorSources(db, loadConfig(), mockCollectorForTest(), now, 10);
    expect(r.skipped).toBeNull();
    expect(r.ran).toBeGreaterThanOrEqual(1);
    const [latest] = await db
      .select()
      .from(schema.collectorRuns)
      .where(eq(schema.collectorRuns.sourceId, feedSource.id))
      .orderBy(schema.collectorRuns.createdAt);
    expect(latest).toBeDefined();
    const scheduled = await db.select().from(schema.collectorRuns).where(and(eq(schema.collectorRuns.sourceId, feedSource.id), eq(schema.collectorRuns.trigger, 'scheduled')));
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.status).toBe('preview');
    expect(await writeCounts(ownerA)).toEqual(before);
    const again = await runDueCollectorSources(db, loadConfig(), mockCollectorForTest(), new Date(now.getTime() + 3600_000), 10);
    expect(again.ran).toBe(0);
    await settings(feedSource.id, { schedule: 'off' });
  });
});

describe('다시 볼 만한 소재(재추천)', () => {
  let oldId: string;
  it('30일 넘은 소재가 최근 수집 글과 핵심어를 공유하면 이유와 함께 추천 — 결정적', async () => {
    const old = new Date(Date.now() - 60 * 86400_000);
    const raw = '딜러 협상 전에 재고 회전을 확인했던 메모(합성)';
    const [cap] = await db
      .insert(schema.captures)
      .values({ ownerId: ownerA, rawText: raw, inputType: 'text', receivedAt: old, updatedAt: old, title: '옛 딜러 메모', commandKey: 'collector-old-capture-1', contentHash: contentHash(raw) })
      .returning();
    oldId = cap!.id;
    const get = async (token = tokenA) =>
      (await (await recsGET(new Request(`${BASE}/api/recommendations`, { headers: cookieHeader(token) }), ctx(''))).json()) as {
        recommendations: Array<{ capture_id: string; reason: string; shared: string[]; signal: { kind: string } }>;
      };
    const r1 = await get();
    const mine = r1.recommendations.find((r) => r.capture_id === oldId);
    expect(mine).toBeDefined();
    expect(mine!.signal.kind).toBe('collected');
    expect(mine!.reason).toContain('최근 수집한 글');
    expect(mine!.shared).toEqual(expect.arrayContaining(['딜러', '협상']));
    expect(await get()).toEqual(r1);
    // 최근(30일 이내) 소재는 추천하지 않는다
    expect(r1.recommendations.every((r) => r.capture_id !== byGuid(firstRun.items, 'os-001').capture_id)).toBe(true);
    // B 에게는 보이지 않는다
    as(B);
    expect((await get(tokenB)).recommendations).toEqual([]);
  });

  it('닫기 → 목록에서 빠짐(멱등), 소재 그대로, 다른 owner 404', async () => {
    const [before] = await db.select().from(schema.captures).where(eq(schema.captures.id, oldId));
    const d = (token: string) => dismissPOST(jsonPost(`/api/recommendations/${oldId}/dismiss`, {}, cookieHeader(token)), { params: Promise.resolve({ captureId: oldId }) });
    expect((await d(tokenA)).status).toBe(200);
    expect((await d(tokenA)).status).toBe(200);
    expect(await n(schema.recommendationDismissals, eq(schema.recommendationDismissals.ownerId, ownerA))).toBe(1);
    const r = (await (await recsGET(new Request(`${BASE}/api/recommendations`, { headers: cookieHeader(tokenA) }), ctx(''))).json()) as { recommendations: Array<{ capture_id: string }> };
    expect(r.recommendations.some((x) => x.capture_id === oldId)).toBe(false);
    const [after] = await db.select().from(schema.captures).where(eq(schema.captures.id, oldId));
    expect(after).toEqual(before);
    as(B);
    expect((await d(tokenB)).status).toBe(404);
  });
});

describe('FIX-T19 round 1 (Codex review-T19)', () => {
  const BOM = [0xef, 0xbb, 0xbf];
  const te = new TextEncoder();
  const u8 = (...parts: Array<number[] | Uint8Array>) => {
    const arrs = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
    const out = new Uint8Array(arrs.reduce((k, a) => k + a.byteLength, 0));
    let o = 0;
    for (const a of arrs) {
      out.set(a, o);
      o += a.byteLength;
    }
    return out;
  };
  const rssDoc = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>FIX 피드</title>\n${items}\n</channel></rss>\n`;
  async function pgError(p: Promise<unknown>): Promise<string | null> {
    try {
      await p;
      return null;
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      return `${err.message ?? ''} ${err.cause?.message ?? ''}`;
    }
  }

  it('[P0] BOM·CRLF·windows-1251 선언 페이지: 저장 원본·내려받기 바이트 = 응답 바이트 그대로(BOM 포함), sha256·크기·raw_hash 일치', async () => {
    const url = 'https://bom-page.mock.example/notes';
    const page = u8(
      BOM,
      te.encode('<!doctype html>\r\n<html><head><meta charset="windows-1251"><title>BOM 페이지</title></head>\r\n<body><h1>BOM 페이지</h1><p>해외 영업 메모\r\n둘째 줄</p></body></html>\r\n'),
    );
    mockCollectorForTest().setFixtureForTest(url, { kind: 'ok', contentType: 'text/html', body: page });
    const s = await addSourceOk('url', url);
    await settings(s.id, { enabled: true });
    const r = await runOk(s.id);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ decision: 'new', raw_sha256: sha256Bytes(page) });
    const out = (await (await accept(r.run.run_id, [r.items[0]!.id])).json()) as RunBody;
    expect(out.result!.accepted).toBe(1);
    const verId = out.items[0]!.source_version_id!;
    const [orig] = await db.select().from(schema.sourceVersionOriginals).where(eq(schema.sourceVersionOriginals.sourceVersionId, verId));
    const stored = new Uint8Array(Buffer.from(orig!.contentBase64, 'base64'));
    expect(Buffer.compare(Buffer.from(stored), Buffer.from(page))).toBe(0);
    expect([...stored.subarray(0, 3)]).toEqual(BOM);
    expect(orig).toMatchObject({ format: 'html', byteSize: page.byteLength, sha256: sha256Bytes(page) });
    const [ver] = await db.select().from(schema.sourceVersions).where(eq(schema.sourceVersions.id, verId));
    expect(ver!.rawHash).toBe(sha256Bytes(page));
    const [item] = await db.select().from(schema.collectedItems).where(eq(schema.collectedItems.id, out.items[0]!.id));
    expect(item!.byteSize).toBe(page.byteLength);
    // 내려받기 경로도 같은 바이트
    const dl = await originalGET(new Request(`${BASE}/api/imports/originals/${verId}`, { headers: cookieHeader(tokenA) }), { params: Promise.resolve({ versionId: verId }) });
    expect(dl.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await dl.arrayBuffer()), Buffer.from(page))).toBe(0);
    expect(dl.headers.get('x-content-sha256')).toBe(sha256Bytes(page));
    // 소재 원문(파생 값)에는 BOM 이 없다
    const [cap] = await db.select().from(schema.captures).where(eq(schema.captures.id, out.items[0]!.capture_id!));
    expect(cap!.rawText.charCodeAt(0)).not.toBe(0xfeff);
    expect(cap!.rawText).toContain('해외 영업 메모');
  });

  it('[P0] BOM·CRLF 피드: 받아들인 <item> 원본 = 응답 바이트의 그 구간 그대로. 실제 windows-1251 바이트 페이지는 failed(feed_not_utf8)·쓰기 0', async () => {
    const url = 'https://bom-feed.mock.example/feed.xml';
    const body = u8(
      BOM,
      te.encode('<?xml version="1.0" encoding="UTF-8"?>\r\n<rss version="2.0"><channel><title>BOM 피드</title>\r\n<item><guid>bom-1</guid><title>딜러 협상 메모</title>\r\n<description>줄1\r\n줄2 — 해외 영업</description></item>\r\n</channel></rss>\r\n'),
    );
    mockCollectorForTest().setFixtureForTest(url, { kind: 'ok', contentType: 'application/rss+xml', body });
    const s = await addSourceOk('rss', url);
    await settings(s.id, { enabled: true });
    const r = await runOk(s.id);
    const it0 = byGuid(r.items, 'bom-1');
    const buf = Buffer.from(body);
    const start = buf.indexOf('<item>');
    const end = buf.indexOf('</item>') + '</item>'.length;
    const expected = body.subarray(start, end);
    expect(it0.raw_sha256).toBe(sha256Bytes(expected));
    const out = (await (await accept(r.run.run_id, [it0.id])).json()) as RunBody;
    expect(out.result!.accepted).toBe(1);
    const [orig] = await db
      .select()
      .from(schema.sourceVersionOriginals)
      .where(eq(schema.sourceVersionOriginals.sourceVersionId, byGuid(out.items, 'bom-1').source_version_id!));
    expect(Buffer.compare(Buffer.from(orig!.contentBase64, 'base64'), Buffer.from(expected))).toBe(0);
    expect(orig!.byteSize).toBe(expected.byteLength);

    const cpUrl = 'https://cp1251.mock.example/page';
    mockCollectorForTest().setFixtureForTest(cpUrl, {
      kind: 'ok',
      contentType: 'text/html',
      body: u8(te.encode('<html><body><p>'), [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], te.encode('</p></body></html>')),
    });
    const cp = await addSourceOk('url', cpUrl);
    await settings(cp.id, { enabled: true });
    const before = await writeCounts(ownerA);
    const cr = await runOk(cp.id);
    expect(cr.run).toMatchObject({ status: 'failed', error_code: 'feed_not_utf8' });
    expect(cr.items).toHaveLength(0);
    expect(await writeCounts(ownerA)).toEqual(before);
  });

  it('[P1] 받아들일 때 redirect 기준 경로만 바뀌어 상대 링크의 해석 결과가 달라지면 failed_changed(원본 조각·checksum 은 같아도) — 소재 0', async () => {
    const url = 'https://relink.mock.example/feed.xml';
    const feed = rssDoc('<item><guid>rl-1</guid><title>상대 링크 글</title><link>post/1</link><description>해외 영업 본문</description></item>');
    const ad = mockCollectorForTest();
    ad.setFixtureForTest(url, { kind: 'redirect', location: '/old/feed.xml' });
    ad.setFixtureForTest('https://relink.mock.example/old/feed.xml', { kind: 'ok', contentType: 'application/rss+xml', body: feed });
    ad.setFixtureForTest('https://relink.mock.example/new/feed.xml', { kind: 'ok', contentType: 'application/rss+xml', body: feed });
    const s = await addSourceOk('rss', url);
    await settings(s.id, { enabled: true });
    const r = await runOk(s.id);
    const it0 = byGuid(r.items, 'rl-1');
    expect(it0.decision).toBe('new');
    const [ledger] = await db.select().from(schema.collectedItems).where(eq(schema.collectedItems.id, it0.id));
    expect(ledger!.link).toBe('https://relink.mock.example/old/post/1');
    ad.setFixtureForTest(url, { kind: 'redirect', location: '/new/feed.xml' });
    const before = await writeCounts(ownerA);
    const out = (await (await accept(r.run.run_id, [it0.id])).json()) as RunBody;
    expect(out.result).toMatchObject({ accepted: 0, failed_changed: 1 });
    expect(byGuid(out.items, 'rl-1')).toMatchObject({ outcome: 'failed_changed', capture_id: null, raw_sha256: it0.raw_sha256, content_checksum: it0.content_checksum });
    expect(await writeCounts(ownerA)).toEqual(before);
  });

  it('[P1] 상대 링크가 허용 목록 밖으로 풀리면(//다른호스트) 미리보기에서 blocked_link — 고를 수 없고 그 주소는 요청하지 않는다', async () => {
    const url = 'https://relink2.mock.example/feed.xml';
    mockCollectorForTest().setFixtureForTest(url, {
      kind: 'ok',
      contentType: 'application/rss+xml',
      body: rssDoc(
        '<item><guid>pr-1</guid><title>프로토콜 상대</title><link>//evil.mock.example/x</link><description>본문</description></item>' +
          '<item><guid>pr-2</guid><title>같은 호스트 상대</title><link>/ok/1</link><description>본문</description></item>',
      ),
    });
    const s = await addSourceOk('rss', url);
    await settings(s.id, { enabled: true });
    const r = await runOk(s.id);
    expect(r.items.map((i) => [i.guid, i.decision, i.reason])).toEqual([
      ['pr-1', 'skipped', 'blocked_link'],
      ['pr-2', 'new', 'new'],
    ]);
    const bad = await accept(r.run.run_id, [byGuid(r.items, 'pr-1').id]);
    expect(bad.status).toBe(400);
    expect(mockCollectorForTest().requested).not.toContain('https://evil.mock.example/x');
  });

  it('[P1] 0042: outcome 이 accepted 가 아닌데(NULL 포함) 소재·버전·시각이 채워진 행, accepted 인데 빈 행은 INSERT·UPDATE 모두 CHECK 로 거부', async () => {
    const [acc] = await db
      .select()
      .from(schema.collectedItems)
      .where(and(eq(schema.collectedItems.ownerId, ownerA), eq(schema.collectedItems.outcome, 'accepted')))
      .limit(1);
    expect(acc).toBeDefined();
    const [maxPos] = await db
      .select({ p: sql<number>`max(${schema.collectedItems.position})::int` })
      .from(schema.collectedItems)
      .where(eq(schema.collectedItems.runId, acc!.runId));
    const { id: _id, ...rest } = acc!;
    const base: typeof schema.collectedItems.$inferInsert = { ...rest, position: maxPos!.p + 1, createdAt: new Date() };
    const ins = (over: Partial<typeof schema.collectedItems.$inferInsert>) => db.insert(schema.collectedItems).values({ ...base, ...over });
    expect(await pgError(ins({ outcome: null }))).toMatch(/collected_items_accepted_chk/);
    expect(await pgError(ins({ outcome: null, captureId: null, sourceVersionId: null }))).toMatch(/collected_items_accepted_chk/);
    expect(await pgError(ins({ outcome: 'not_selected' }))).toMatch(/collected_items_accepted_chk/);
    expect(await pgError(ins({ outcome: 'accepted', acceptedAt: null }))).toMatch(/collected_items_accepted_chk/);
    expect(await pgError(ins({ outcome: 'accepted', captureId: null }))).toMatch(/collected_items_accepted_chk/);
    // UPDATE 로도 못 만든다
    expect(await pgError(db.execute(sql`update collected_items set outcome = null where id = ${acc!.id}`))).toMatch(/collected_items_accepted_chk/);
    // 정상 형태(NULL 결과·연결 없음)는 들어간다 — 확인 후 지운다(시험 행)
    const okRows = await ins({ outcome: null, captureId: null, sourceVersionId: null, acceptedAt: null }).returning();
    expect(okRows).toHaveLength(1);
    await db.delete(schema.collectedItems).where(eq(schema.collectedItems.id, okRows[0]!.id));
    const [still] = await db.select().from(schema.collectedItems).where(eq(schema.collectedItems.id, acc!.id));
    expect(still).toEqual(acc);
  });

  it('[P1] 주기 실행: 기한 전 weekly 소스 55개(다른 owner)가 앞에 있어도 기한이 지난 daily 소스는 SQL 기한 판정으로 실행, 24h 경계 정확', async () => {
    vi.stubEnv('COLLECTOR_SCHEDULER', 'on');
    const now = new Date(Date.now() + 30 * 86400_000);
    // 다른 owner(B)에 weekly 55개: 이틀 전 실행(기한 전) — 예전 코드는 last_run_at 오래된 순 50개만 보고 모두 건너뛰었다.
    const weekly = Array.from({ length: 55 }, (_, i) => ({
      ownerId: ownerB,
      kind: 'rss',
      url: `https://weekly-${i}.mock.example/feed.xml`,
      normalizedUrl: `https://weekly-${i}.mock.example/feed.xml`,
      host: `weekly-${i}.mock.example`,
      enabled: true,
      schedule: 'weekly',
      lastRunAt: new Date(now.getTime() - 2 * 86400_000),
    }));
    const dailyAt = new Date(now.getTime() - 25 * 3600_000);
    try {
      const inserted = await db.insert(schema.collectorSources).values(weekly).returning({ id: schema.collectorSources.id });
      const [daily] = await db
        .insert(schema.collectorSources)
        .values({ ownerId: ownerB, kind: 'rss', url: MOCK_FEEDS.overseasSales, normalizedUrl: MOCK_FEEDS.overseasSales, host: 'overseas-sales.mock.example', enabled: true, schedule: 'daily', lastRunAt: dailyAt })
        .onConflictDoUpdate({ target: [schema.collectorSources.ownerId, schema.collectorSources.normalizedUrl], set: { enabled: true, schedule: 'daily', lastRunAt: dailyAt } })
        .returning();
      // 24시간 경계: 하루 전 + 1초는 아직 기한 전
      const [edge] = await db
        .insert(schema.collectorSources)
        .values({
          ownerId: ownerB,
          kind: 'rss',
          url: 'https://edge.mock.example/feed.xml',
          normalizedUrl: 'https://edge.mock.example/feed.xml',
          host: 'edge.mock.example',
          enabled: true,
          schedule: 'daily',
          lastRunAt: new Date(now.getTime() - 24 * 3600_000 + 1000),
        })
        .returning();
      const r = await runDueCollectorSources(db, loadConfig(), mockCollectorForTest(), now, 3);
      expect(r.skipped).toBeNull();
      const runs = await db
        .select()
        .from(schema.collectorRuns)
        .where(and(eq(schema.collectorRuns.sourceId, daily!.id), eq(schema.collectorRuns.trigger, 'scheduled')));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('preview');
      expect(await n(schema.collectorRuns, eq(schema.collectorRuns.sourceId, edge!.id))).toBe(0);
      for (const w of inserted) expect(await n(schema.collectorRuns, eq(schema.collectorRuns.sourceId, w.id))).toBe(0);
      // 1초 뒤에는 경계 소스도 기한(>= 24h) — edge 는 모의 자료에 없는 주소라 failed 실행으로 남는다(요청 목록에만)
      await runDueCollectorSources(db, loadConfig(), mockCollectorForTest(), new Date(now.getTime() + 1000), 3);
      expect(await n(schema.collectorRuns, eq(schema.collectorRuns.sourceId, edge!.id))).toBe(1);
    } finally {
      await db.update(schema.collectorSources).set({ enabled: false, schedule: 'off' }).where(eq(schema.collectorSources.ownerId, ownerB));
    }
  });
});

describe('내보내기·복원(수집 표 포함)', () => {
  it('복원 훈련 PASS — 소스·실행·항목·닫기 행이 같은 ID 로, 소스는 꺼진 채(enabled=false)로 복원', async () => {
    // 켜진 소스가 하나 이상 있어야 "꺼진 채 복원" 규칙이 실제로 적용된다
    expect(await n(schema.collectorSources, and(eq(schema.collectorSources.ownerId, ownerA), eq(schema.collectorSources.enabled, true)))).toBeGreaterThan(0);
    const storage = new LocalStorageAdapter(path.join(tmp, 'assets'));
    const r = await runRestoreDrill(db, storage, ownerA, { trigger: 'test', tmpRoot: tmp });
    expect(r.mismatches).toEqual([]);
    expect(r.result).toBe('pass');
    for (const t of ['collector_sources', 'collector_runs', 'collected_items', 'recommendation_dismissals']) {
      const row = r.tables.find((x) => x.table === t)!;
      expect(row, t).toMatchObject({ ids: 'same' });
      expect(row.actual_rows, t).toBe(row.expected_rows);
      expect(row.expected_rows, t).toBeGreaterThan(0);
    }
  }, 120_000);
});
