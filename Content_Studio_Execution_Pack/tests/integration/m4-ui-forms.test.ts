/**
 * M4UI(G1·G2): 배포 화면 폼 공백 — HTML 폼(application/x-www-form-urlencoded, accept text/html)으로 route 를 직접 호출한다.
 * G1: 요청 결과가 섞인 계획(모의 연결 YouTube upload_private/public_publish + Threads seed mock_publish)을 승인 폼 한 번으로 항목별 목적 승인,
 *     항목 목적을 고치면 서버가 purpose_mismatch 로 거부(승인 0개).
 * G2: 계획 만들기 폼의 요청 결과·예약 공개(모스크바 → UTC) → 계획 항목의 requested_result·provider_metadata.publish_at, 잘못된 조합은 서버가 거부하고
 *     한국어 오류 코드로 돌아온다(DISTRIBUTE_ERROR_TEXT 에 문구가 있음).
 * 모의 어댑터·모의 OAuth 만 — 네트워크 호출 없음(fetch 0). 실행(execute)은 하지 않는다.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { closeDb, createContent, createVariantDraft, getDb, schema, seed, setVariantAssets, setVariantLifecycle, type Db } from '@cs/db';
import { loadConfig, MIB, providerMetadataOf, type CanonicalPayload } from '@cs/domain';
import { POST as connectPOST } from '../../apps/web/app/api/channel-accounts/[id]/connect/route';
import { GET as callbackGET } from '../../apps/web/app/api/oauth/callback/route';
import { GET as googleAuthorizeGET } from '../../apps/web/app/api/oauth/mock-google/authorize/route';
import { POST as approvePOST } from '../../apps/web/app/api/distribution-plans/[id]/approve/route';
import { POST as plansPOST } from '../../apps/web/app/api/distribution-plans/route';
import { POST as sessionsPOST } from '../../apps/web/app/api/uploads/sessions/route';
import { PUT as chunkPUT } from '../../apps/web/app/api/uploads/sessions/[id]/chunks/[index]/route';
import { POST as completePOST } from '../../apps/web/app/api/uploads/sessions/[id]/complete/route';
import { DISTRIBUTE_ERROR_TEXT, planFormDefaults } from '../../apps/web/lib/distribution';
import { BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
/** 지금부터 60일 뒤(UTC 날짜). 09:30 MSK = 06:30Z 같은 날. */
const FUTURE_DAY = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);

let db: Db;
let owner: string;
let token: string;
let tmp: string;
let fetchCalls = 0;
let ytAccount: string;
let thrSeedAccount: string;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (p: string, body: unknown = {}) => jsonPost(p, body, cookieHeader(token));
const form = (p: string, fields: Record<string, string>) =>
  new Request(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html,application/xhtml+xml', ...ORIGIN_HEADERS, ...cookieHeader(token) },
    body: new URLSearchParams(fields).toString(),
  });

/** 합성 "영상"(MP4 ftyp 서명 + 결정적 바이트 — 실제 영상 아님) */
let videoSeed = 7;
function syntheticVideo(bytes = 96 * 1024): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  let x = (++videoSeed * 2654435761) >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  out.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  return out;
}

async function uploadVideo(): Promise<string> {
  const file = syntheticVideo();
  const s = await sessionsPOST(post('/api/uploads/sessions', { kind: 'video', mime: 'video/mp4', bytes: file.byteLength, chunk_size: 4 * MIB }), undefined as never);
  expect(s.status, await s.clone().text()).toBe(201);
  const id = ((await s.json()) as { session: { id: string } }).session.id;
  const put = await chunkPUT(
    new Request(`${BASE}/api/uploads/sessions/${id}/chunks/0`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/octet-stream', ...ORIGIN_HEADERS, ...cookieHeader(token) },
      body: file,
    }),
    { params: Promise.resolve({ id, index: '0' }) },
  );
  expect(put.status).toBe(201);
  const done = await completePOST(new Request(`${BASE}/api/uploads/sessions/${id}/complete`, { method: 'POST', headers: { accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) } }), ctx(id));
  expect(done.status, await done.clone().text()).toBe(200);
  return ((await done.json()) as { asset: { id: string } }).asset.id;
}

/** 모의 Google 형 OAuth 로 연결한 YouTube 모의 계정(credential_state=linked → mock_youtube). */
async function linkedYouTubeAccount(): Promise<string> {
  const [row] = await db
    .insert(schema.channelAccounts)
    .values({ ownerId: owner, platform: 'youtube', kind: 'mock', externalAccountId: `mock:youtube:${randomUUID()}`, displayName: 'MOCK youtube M4UI', state: 'mock_ready' })
    .returning();
  const c = await connectPOST(post(`/api/channel-accounts/${row!.id}/connect`), ctx(row!.id));
  expect(c.status, await c.clone().text()).toBe(200);
  const { authorize_url } = (await c.json()) as { authorize_url: string };
  const a = await googleAuthorizeGET(new Request(authorize_url, { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(a.status, await a.clone().text()).toBe(303);
  const cb = await callbackGET(new Request(a.headers.get('location')!, { headers: { accept: 'application/json', ...cookieHeader(token) } }));
  expect(cb.status, await cb.clone().text()).toBe(200);
  return row!.id;
}

async function youtubeVariant(): Promise<{ contentId: string; variantId: string }> {
  const assetId = await uploadVideo();
  const { content } = await createContent(db, owner, { title: 'M4UI youtube', body: '해외 영업 첫 분기 회고(합성 영상)\n대리점과 재고 기준을 먼저 합의한 이야기.' });
  const { variant } = await createVariantDraft(db, owner, content.id, { channel: 'youtube', baseVersion: 1 });
  await setVariantAssets(db, owner, variant.id, { baseVersion: 1, assets: [{ assetId, position: 1, role: 'video' }] });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 2 });
  return { contentId: content.id, variantId: variant.id };
}

async function threadsVariant(contentId?: string): Promise<{ contentId: string; variantId: string }> {
  const cid = contentId ?? (await createContent(db, owner, { title: 'M4UI threads', body: '해외 영업 첫 달, 대리점 재고 기준부터 합의했다.' })).content.id;
  const { variant } = await createVariantDraft(db, owner, cid, { channel: 'threads', baseVersion: 1 });
  await setVariantLifecycle(db, owner, variant.id, { lifecycle: 'review', baseVersion: 1 });
  return { contentId: cid, variantId: variant.id };
}

const itemsOfPlan = (planId: string) => db.select().from(schema.distributionItems).where(eq(schema.distributionItems.planId, planId));
const approvalsOf = (itemId: string) => db.select().from(schema.approvals).where(eq(schema.approvals.distributionItemId, itemId));

/** 303 Location 에서 계획 id(성공) 또는 error 코드(실패). */
function where(res: Response): { path: string; params: URLSearchParams } {
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get('location')!, BASE);
  return { path: loc.pathname, params: loc.searchParams };
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-m4ui-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', path.join(tmp, 'assets'));
  vi.stubEnv('EXPORT_LOCAL_DIR', path.join(tmp, 'exports'));
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  vi.stubEnv('SECRETS_MASTER_KEY', KEY);
  vi.stubEnv('SECRETS_KEY_VERSION', '1');
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('M4UI 시험: 네트워크 호출 금지');
  });
  db = (await getDb(loadConfig())).db;
  owner = (await seed(db, { allowedIdentity: A })).ownerId;
  token = await login(A);
  ytAccount = await linkedYouTubeAccount();
  thrSeedAccount = (
    await db
      .select()
      .from(schema.channelAccounts)
      .where(and(eq(schema.channelAccounts.ownerId, owner), eq(schema.channelAccounts.platform, 'threads'), eq(schema.channelAccounts.credentialState, 'none')))
  )[0]!.id;
});
afterAll(async () => {
  expect(fetchCalls).toBe(0);
  await closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

describe('G2 — 계획 만들기 폼: 요청 결과·예약 공개', () => {
  it('예약 공개(모스크바 09:30) + 비공개 → public_publish, publish_at = 06:30Z; Threads seed 는 MOCK 실행; 한 폼에서 계획 생성', async () => {
    const y = await youtubeVariant();
    const t = await threadsVariant(y.contentId);
    const res = await plansPOST(
      form('/api/distribution-plans', {
        content_id: y.contentId,
        [`use_${y.variantId}`]: 'on',
        [`account_${y.variantId}`]: ytAccount,
        [`visibility_${y.variantId}`]: 'private',
        [`result_${y.variantId}`]: 'scheduled_publish',
        [`publish_date_${y.variantId}`]: FUTURE_DAY,
        [`publish_time_${y.variantId}`]: '09:30',
        [`use_${t.variantId}`]: 'on',
        [`account_${t.variantId}`]: thrSeedAccount,
        [`visibility_${t.variantId}`]: 'private',
        target_summary: 'M4UI 예약 공개',
      }),
    );
    const w = where(res);
    expect(w.params.get('error')).toBeNull();
    expect(w.params.get('created')).toBe('1');
    const planId = w.path.split('/').at(-1)!;
    const items = await itemsOfPlan(planId);
    const yi = items.find((i) => i.variantId === y.variantId)!;
    const ti = items.find((i) => i.variantId === t.variantId)!;
    expect(yi.requestedResult).toBe('public_publish');
    expect(yi.visibility).toBe('private');
    expect(providerMetadataOf(yi.payloadJson as unknown as CanonicalPayload).publish_at).toBe(`${FUTURE_DAY}T06:30:00.000Z`);
    expect(ti.requestedResult).toBe('mock_publish');
    expect(providerMetadataOf(ti.payloadJson as unknown as CanonicalPayload).publish_at).toBeUndefined();
    // 계획만 — 승인은 만들지 않는다
    expect(await approvalsOf(yi.id)).toHaveLength(0);
  });

  it('공개 게시(public) → public_publish(publish_at 없음), 비공개 업로드 → upload_private, 계정 기본값(빈 값) → upload_private', async () => {
    for (const [choice, vis, expected] of [
      ['public_publish', 'public', 'public_publish'],
      ['upload_private', 'private', 'upload_private'],
      ['', 'private', 'upload_private'],
    ] as const) {
      const y = await youtubeVariant();
      const res = await plansPOST(
        form('/api/distribution-plans', {
          content_id: y.contentId,
          [`use_${y.variantId}`]: 'on',
          [`account_${y.variantId}`]: ytAccount,
          [`visibility_${y.variantId}`]: vis,
          [`result_${y.variantId}`]: choice,
        }),
      );
      const w = where(res);
      expect(w.params.get('error'), choice).toBeNull();
      const [item] = await itemsOfPlan(w.path.split('/').at(-1)!);
      expect(item!.requestedResult).toBe(expected);
      expect(item!.visibility).toBe(vis);
      expect(providerMetadataOf(item!.payloadJson as unknown as CanonicalPayload).publish_at).toBeUndefined();
    }
  });

  // M4UI FIX1(Codex review-M4UI P1 :161): 예약 공개 날짜·시각을 넣은 뒤 다른 요청 결과로 바꾸면 남은 값은 요청에 실리지 않는다
  it('FIX1: 남은 예약 공개 날짜·시각 + 공개 게시(public) → 즉시 공개 계획(publish_at 없음); 공개 게시(private) → visibility_mismatch(예약 공개로 바뀌지 않음); 비공개 업로드·계정 기본값 → publish_at 없음', async () => {
    const leftover = (vid: string) => ({ [`publish_date_${vid}`]: FUTURE_DAY, [`publish_time_${vid}`]: '09:30' });
    for (const [choice, vis, expected] of [
      ['public_publish', 'public', 'public_publish'],
      ['public_publish', 'unlisted', 'public_publish'],
      ['upload_private', 'private', 'upload_private'],
      ['', 'private', 'upload_private'],
    ] as const) {
      const y = await youtubeVariant();
      const res = await plansPOST(
        form('/api/distribution-plans', {
          content_id: y.contentId,
          [`use_${y.variantId}`]: 'on',
          [`account_${y.variantId}`]: ytAccount,
          [`visibility_${y.variantId}`]: vis,
          [`result_${y.variantId}`]: choice,
          ...leftover(y.variantId),
        }),
      );
      const w = where(res);
      expect(w.params.get('error'), `${choice}/${vis}`).toBeNull();
      const [item] = await itemsOfPlan(w.path.split('/').at(-1)!);
      expect(item!.requestedResult).toBe(expected);
      expect(item!.visibility).toBe(vis);
      expect(item!.scheduledAtUtc).toBeNull();
      expect(providerMetadataOf(item!.payloadJson as unknown as CanonicalPayload).publish_at, `${choice}/${vis}`).toBeUndefined();
      expect(await approvalsOf(item!.id)).toHaveLength(0);
    }
    // 공개 게시 + private + 남은 날짜·시각: 예전에는 예약 공개와 같은 요청이 됐다 — 이제 publish_at 이 없어 서버가 거부(계획 없음)
    const y = await youtubeVariant();
    const before = (await db.select().from(schema.distributionItems)).length;
    const res = await plansPOST(
      form('/api/distribution-plans', {
        content_id: y.contentId,
        [`use_${y.variantId}`]: 'on',
        [`account_${y.variantId}`]: ytAccount,
        [`visibility_${y.variantId}`]: 'private',
        [`result_${y.variantId}`]: 'public_publish',
        ...leftover(y.variantId),
      }),
    );
    expect(where(res).params.get('error')).toBe('visibility_mismatch');
    expect((await db.select().from(schema.distributionItems)).length).toBe(before);
    // Threads seed(MOCK 실행만)에 남은 예약 공개 값 → 버리고 MOCK 실행 계획
    const t = await threadsVariant();
    const tr = await plansPOST(
      form('/api/distribution-plans', { content_id: t.contentId, [`use_${t.variantId}`]: 'on', [`account_${t.variantId}`]: thrSeedAccount, [`visibility_${t.variantId}`]: 'private', ...leftover(t.variantId) }),
    );
    const tw = where(tr);
    expect(tw.params.get('error')).toBeNull();
    const [ti] = await itemsOfPlan(tw.path.split('/').at(-1)!);
    expect(ti!.requestedResult).toBe('mock_publish');
    expect(providerMetadataOf(ti!.payloadJson as unknown as CanonicalPayload).publish_at).toBeUndefined();
  });

  it('FIX1: 서버는 JSON API 로 들어온 예약 공개 시각도 그대로 판정 — 비공개 업로드 + publish_at, Threads + publish_at, public + publish_at 거부', async () => {
    const y = await youtubeVariant();
    const t = await threadsVariant();
    const before = (await db.select().from(schema.distributionItems)).length;
    const pa = { date: FUTURE_DAY, time: '09:30' };
    for (const [content, item, code] of [
      [y.contentId, { variant_id: y.variantId, channel_account_id: ytAccount, requested_result: 'upload_private', visibility: 'private', publish_at: pa }, 'publish_at_requires_public_publish'],
      [y.contentId, { variant_id: y.variantId, channel_account_id: ytAccount, requested_result: 'public_publish', visibility: 'public', publish_at: pa }, 'publish_at_requires_private'],
      [t.contentId, { variant_id: t.variantId, channel_account_id: thrSeedAccount, visibility: 'private', publish_at: pa }, 'publish_at_not_supported'],
    ] as const) {
      const res = await plansPOST(post('/api/distribution-plans', { content_id: content, items: [item] }));
      expect(res.status, code).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(code);
    }
    expect((await db.select().from(schema.distributionItems)).length).toBe(before);
  });

  it('FIX1(놓친 케이스): 예약 공개 시각 = 실행 예약 시각·더 이름 → publish_at_before_send, MSK 자정 → 전날 21:00Z, 없는 날짜·24:00 → invalid_schedule', async () => {
    const y = await youtubeVariant();
    const base = {
      content_id: y.contentId,
      [`use_${y.variantId}`]: 'on',
      [`account_${y.variantId}`]: ytAccount,
      [`visibility_${y.variantId}`]: 'private',
      [`result_${y.variantId}`]: 'scheduled_publish',
    };
    const before = (await db.select().from(schema.distributionItems)).length;
    for (const [fields, code] of [
      [{ [`date_${y.variantId}`]: FUTURE_DAY, [`time_${y.variantId}`]: '09:30', [`publish_date_${y.variantId}`]: FUTURE_DAY, [`publish_time_${y.variantId}`]: '09:30' }, 'publish_at_before_send'],
      [{ [`date_${y.variantId}`]: FUTURE_DAY, [`time_${y.variantId}`]: '10:00', [`publish_date_${y.variantId}`]: FUTURE_DAY, [`publish_time_${y.variantId}`]: '09:30' }, 'publish_at_before_send'],
      [{ [`publish_date_${y.variantId}`]: '2030-02-30', [`publish_time_${y.variantId}`]: '09:30' }, 'invalid_schedule'],
      [{ [`publish_date_${y.variantId}`]: FUTURE_DAY, [`publish_time_${y.variantId}`]: '24:00' }, 'invalid_schedule'],
    ] as const) {
      const w = where(await plansPOST(form('/api/distribution-plans', { ...base, ...fields })));
      expect(w.path).toBe('/distribute/new');
      expect(w.params.get('error'), JSON.stringify(fields)).toBe(code);
    }
    expect((await db.select().from(schema.distributionItems)).length).toBe(before);
    // MSK 00:30 → UTC 전날 21:30
    const w = where(await plansPOST(form('/api/distribution-plans', { ...base, [`publish_date_${y.variantId}`]: FUTURE_DAY, [`publish_time_${y.variantId}`]: '00:30' })));
    expect(w.params.get('error')).toBeNull();
    const [item] = await itemsOfPlan(w.path.split('/').at(-1)!);
    const prev = new Date(Date.parse(`${FUTURE_DAY}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    expect(providerMetadataOf(item!.payloadJson as unknown as CanonicalPayload).publish_at).toBe(`${prev}T21:30:00.000Z`);
  });

  it('잘못된 조합은 서버가 거부 → 같은 화면 + 한국어 오류 코드, 입력값(요청 결과·예약 공개)은 되살림, 계획은 만들어지지 않음', async () => {
    const y = await youtubeVariant();
    const t = await threadsVariant();
    const before = (await db.select().from(schema.distributionItems)).length;
    const cases: Array<{ name: string; fields: Record<string, string>; code: string }> = [
      {
        name: '예약 공개 + 공개 범위 public',
        fields: { [`visibility_${y.variantId}`]: 'public', [`result_${y.variantId}`]: 'scheduled_publish', [`publish_date_${y.variantId}`]: FUTURE_DAY, [`publish_time_${y.variantId}`]: '09:30' },
        code: 'publish_at_requires_private',
      },
      { name: '예약 공개인데 날짜·시각 없음', fields: { [`visibility_${y.variantId}`]: 'private', [`result_${y.variantId}`]: 'scheduled_publish' }, code: 'invalid_schedule' },
      {
        name: '예약 공개 시각이 과거',
        fields: { [`visibility_${y.variantId}`]: 'private', [`result_${y.variantId}`]: 'scheduled_publish', [`publish_date_${y.variantId}`]: '2020-01-01', [`publish_time_${y.variantId}`]: '09:30' },
        code: 'schedule_in_past',
      },
      { name: '비공개 업로드 + public', fields: { [`visibility_${y.variantId}`]: 'public', [`result_${y.variantId}`]: 'upload_private' }, code: 'visibility_mismatch' },
      { name: '공개 게시 + private(예약 공개 없음)', fields: { [`visibility_${y.variantId}`]: 'private', [`result_${y.variantId}`]: 'public_publish' }, code: 'visibility_mismatch' },
      { name: '모의 연결 YouTube 에 MOCK 실행', fields: { [`visibility_${y.variantId}`]: 'private', [`result_${y.variantId}`]: 'mock_publish' }, code: 'requested_result_not_supported' },
      { name: '모르는 요청 결과 값', fields: { [`visibility_${y.variantId}`]: 'private', [`result_${y.variantId}`]: 'go_live' }, code: 'invalid' },
    ];
    for (const c of cases) {
      const res = await plansPOST(
        form('/api/distribution-plans', { content_id: y.contentId, [`use_${y.variantId}`]: 'on', [`account_${y.variantId}`]: ytAccount, ...c.fields }),
      );
      const w = where(res);
      expect(w.path, c.name).toBe('/distribute/new');
      expect(w.params.get('error'), c.name).toBe(c.code);
      expect(DISTRIBUTE_ERROR_TEXT[c.code], c.name).toMatch(/[가-힣]/u);
    }
    // Threads seed(연결 없음) 계정에 비공개 업로드·예약 공개 → 거부(MOCK 실행만)
    for (const [fields, code] of [
      [{ [`result_${t.variantId}`]: 'upload_private' }, 'mock_only'],
      [{ [`result_${t.variantId}`]: 'scheduled_publish', [`publish_date_${t.variantId}`]: FUTURE_DAY, [`publish_time_${t.variantId}`]: '09:30' }, 'mock_only'],
      // M4UI FIX1: 예약 공개를 고르지 않고 남긴 날짜·시각은 폼이 버린다 → 위 FIX1 시험(MOCK 실행 계획). 서버 판정(publish_at_not_supported)은 JSON 시험으로.
    ] as const) {
      const res = await plansPOST(
        form('/api/distribution-plans', { content_id: t.contentId, [`use_${t.variantId}`]: 'on', [`account_${t.variantId}`]: thrSeedAccount, [`visibility_${t.variantId}`]: 'private', ...fields }),
      );
      expect(where(res).params.get('error')).toBe(code);
    }
    // 입력값 되살리기(요청 결과·예약 공개 날짜·시각)
    const res = await plansPOST(
      form('/api/distribution-plans', {
        content_id: y.contentId,
        [`use_${y.variantId}`]: 'on',
        [`account_${y.variantId}`]: ytAccount,
        [`visibility_${y.variantId}`]: 'public',
        [`result_${y.variantId}`]: 'scheduled_publish',
        [`publish_date_${y.variantId}`]: FUTURE_DAY,
        [`publish_time_${y.variantId}`]: '09:30',
      }),
    );
    const d = planFormDefaults(Object.fromEntries(where(res).params.entries()));
    expect(d.result[y.variantId]).toBe('scheduled_publish');
    expect(d.publishDate[y.variantId]).toBe(FUTURE_DAY);
    expect(d.publishTime[y.variantId]).toBe('09:30');
    expect((await db.select().from(schema.distributionItems)).length).toBe(before);
  });
});

describe('G1 — 승인 폼: 목적이 섞인 계획을 한 번에, 항목별 목적', () => {
  async function mixedPlan() {
    const y = await youtubeVariant();
    const t = await threadsVariant(y.contentId);
    const res = await plansPOST(
      post('/api/distribution-plans', {
        items: [
          { variant_id: y.variantId, channel_account_id: ytAccount, requested_result: 'upload_private', visibility: 'private' },
          { variant_id: t.variantId, channel_account_id: thrSeedAccount },
        ],
      }),
    );
    expect(res.status, await res.clone().text()).toBe(201);
    const body = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; variant_id: string; payload_hash: string; requested_result: string }> };
    return { planId: body.plan.id, yi: body.items.find((i) => i.variant_id === y.variantId)!, ti: body.items.find((i) => i.variant_id === t.variantId)! };
  }
  /** /distribute/{id} 승인 폼이 보내는 필드(숨은 hash_·purpose_ 는 승인 가능한 모든 항목, 체크한 항목만 item_). */
  const approveFields = (items: Array<{ id: string; payload_hash: string; requested_result: string }>, checked: string[], override: Record<string, string> = {}) => ({
    ...Object.fromEntries(items.map((i) => [`hash_${i.id}`, i.payload_hash])),
    ...Object.fromEntries(items.map((i) => [`purpose_${i.id}`, i.requested_result])),
    ...Object.fromEntries(checked.map((id) => [`item_${id}`, 'on'])),
    confirm: 'yes',
    ...override,
  });

  it('YouTube upload_private + Threads mock_publish 를 폼 한 번으로 승인 → 두 항목 모두 각자 목적으로 승인', async () => {
    const { planId, yi, ti } = await mixedPlan();
    expect([yi.requested_result, ti.requested_result]).toEqual(['upload_private', 'mock_publish']);
    const res = await approvePOST(form(`/api/distribution-plans/${planId}/approve`, approveFields([yi, ti], [yi.id, ti.id])), ctx(planId));
    const w = where(res);
    expect(w.params.get('error')).toBeNull();
    expect(w.params.get('approved')).toBe('2');
    const [ya] = await approvalsOf(yi.id);
    const [ta] = await approvalsOf(ti.id);
    expect(ya).toMatchObject({ purpose: 'upload_private', payloadHash: yi.payload_hash, revokedAt: null });
    expect(ta).toMatchObject({ purpose: 'mock_publish', payloadHash: ti.payload_hash, revokedAt: null });
  });

  it('항목 목적을 고친 폼(YouTube 항목 purpose_=mock_publish·public_publish) → purpose_mismatch, 어느 항목도 승인되지 않음', async () => {
    const { planId, yi, ti } = await mixedPlan();
    for (const bad of ['mock_publish', 'public_publish']) {
      const res = await approvePOST(form(`/api/distribution-plans/${planId}/approve`, approveFields([yi, ti], [yi.id, ti.id], { [`purpose_${yi.id}`]: bad })), ctx(planId));
      expect(where(res).params.get('error')).toBe('purpose_mismatch');
    }
    // 예전 단일 purpose 폼(섞인 계획)도 거부
    const single = { ...approveFields([yi, ti], [yi.id, ti.id]), purpose: 'mock_publish' };
    for (const k of Object.keys(single)) if (k.startsWith('purpose_')) delete (single as Record<string, string>)[k];
    expect(where(await approvePOST(form(`/api/distribution-plans/${planId}/approve`, single), ctx(planId))).params.get('error')).toBe('purpose_mismatch');
    // purpose 와 purposes 가 서로 다르면 스키마가 거부(invalid)
    const both = approveFields([yi, ti], [yi.id], { purpose: 'mock_publish' });
    expect(where(await approvePOST(form(`/api/distribution-plans/${planId}/approve`, both), ctx(planId))).params.get('error')).toBe('invalid');
    // 고른 항목의 목적이 빠지면 거부(invalid)
    const missing = approveFields([yi, ti], [yi.id, ti.id]);
    delete (missing as Record<string, string>)[`purpose_${ti.id}`];
    expect(where(await approvePOST(form(`/api/distribution-plans/${planId}/approve`, missing), ctx(planId))).params.get('error')).toBe('invalid');
    // 확인 체크·hash 는 그대로 엄격하다
    const noConfirm = approveFields([yi, ti], [yi.id, ti.id]);
    delete (noConfirm as Record<string, string>).confirm;
    expect(where(await approvePOST(form(`/api/distribution-plans/${planId}/approve`, noConfirm), ctx(planId))).params.get('error')).toBe('confirm_required');
    const badHash = approveFields([yi, ti], [yi.id, ti.id], { [`hash_${ti.id}`]: 'a'.repeat(64) });
    expect(where(await approvePOST(form(`/api/distribution-plans/${planId}/approve`, badHash), ctx(planId))).params.get('error')).toBe('hash_mismatch');
    expect(await approvalsOf(yi.id)).toHaveLength(0);
    expect(await approvalsOf(ti.id)).toHaveLength(0);
    // 이어서 올바른 폼은 통과(앞의 거부가 상태를 바꾸지 않았음)
    expect(where(await approvePOST(form(`/api/distribution-plans/${planId}/approve`, approveFields([yi, ti], [yi.id, ti.id])), ctx(planId))).params.get('approved')).toBe('2');
  });

  it('공개 게시(public_publish) + MOCK 실행 혼합도 한 번에, 한 항목만 골라도 그 항목 목적으로만 승인', async () => {
    const y = await youtubeVariant();
    const t = await threadsVariant(y.contentId);
    const res = await plansPOST(
      post('/api/distribution-plans', {
        items: [
          { variant_id: y.variantId, channel_account_id: ytAccount, requested_result: 'public_publish', visibility: 'unlisted' },
          { variant_id: t.variantId, channel_account_id: thrSeedAccount },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { plan: { id: string }; items: Array<{ id: string; variant_id: string; payload_hash: string; requested_result: string }> };
    const yi = body.items.find((i) => i.variant_id === y.variantId)!;
    const ti = body.items.find((i) => i.variant_id === t.variantId)!;
    let w = where(await approvePOST(form(`/api/distribution-plans/${body.plan.id}/approve`, approveFields([yi, ti], [yi.id])), ctx(body.plan.id)));
    expect(w.params.get('approved')).toBe('1');
    expect((await approvalsOf(yi.id))[0]!.purpose).toBe('public_publish');
    expect(await approvalsOf(ti.id)).toHaveLength(0);
    w = where(await approvePOST(form(`/api/distribution-plans/${body.plan.id}/approve`, approveFields([ti], [ti.id])), ctx(body.plan.id)));
    expect(w.params.get('approved')).toBe('1');
    expect((await approvalsOf(ti.id))[0]!.purpose).toBe('mock_publish');
  });
});
