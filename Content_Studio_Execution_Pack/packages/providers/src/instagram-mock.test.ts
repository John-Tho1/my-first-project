/**
 * T16(D29 제안) Instagram 모의 시뮬레이터·공개 미디어 URL(모의)·어댑터·Meta 형 모의 OAuth 단위 시험. 네트워크 없음(fetch 를 막고 0회 확인).
 * 이미지는 헤더만 맞는 합성 JPEG(디코딩 가능한 그림 아님). 토큰은 시험이 만든 모의 문자열.
 */
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adapterIdFor,
  codeChallengeS256,
  INSTAGRAM_PROVISIONAL_MEDIA_SPEC,
  MOCK_PUBLIC_MEDIA_PREFIX,
  newCodeVerifier,
  OAuthProviderError,
  scenarioApplies,
  type AdapterContext,
  type MediaPort,
  type MockScenarioValue,
  type PublishSnapshot,
  type RemoteStep,
  type RemoteStepsPort,
} from '@cs/domain';
import {
  classifyInstagramError,
  INSTAGRAM_ERROR_KINDS,
  InstagramMockApi,
  InstagramMockApiError,
  InstagramMockChannelAdapter,
  MockChannelAdapter,
  MockChannelAdapterRegistry,
  MockInstagramOAuthProvider,
  MockOAuthStore,
  mockInstagramTokenCheck,
  MockPublicMediaUrlProvider,
  MockThreadsOAuthProvider,
  verifiedImageFiles,
  type InstagramErrorKind,
} from './index';

const USER = 'mock:instagram:user-1';
const TOKEN = 'mockig_at_TEST_TOKEN_SHOULD_NEVER_LEAK_0123456789';
const tokenCheck = (t: string, u: string) => t === TOKEN && u === USER;

/** 합성 JPEG(SOI + APP0 + SOF0 + SOS + 채움 + EOI) */
function jpeg(width: number, height: number, totalBytes = 4096): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const out = new Uint8Array(totalBytes);
  out.set([...head, ...sof, ...sos], 0);
  for (let i = head.length + sof.length + sos.length; i < out.length - 2; i++) out[i] = (i * 31 + width) % 250;
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** 메모리 파일 창구(작업 처리기의 MediaPort 와 같은 계약 — 없는 ID 는 media_not_verified). */
function memMedia(): MediaPort & { files: Map<string, Uint8Array>; reads: Array<[number, number]> } {
  const files = new Map<string, Uint8Array>();
  const reads: Array<[number, number]> = [];
  return {
    files,
    reads,
    open: async (a) => {
      const b = files.get(a.id);
      if (!b) return { ok: false, code: 'media_not_verified' };
      if (sha(b) !== a.checksum) return { ok: false, code: 'media_changed' };
      return { ok: true, file: { bytes: b.byteLength, mime: a.mime, checksum: a.checksum, read: async (s, e) => (reads.push([s, e]), b.slice(s, e)) } };
    },
  };
}

function snapshotOf(images: Uint8Array[], over: Partial<PublishSnapshot> = {}, caption = '해외 영업 첫 분기 #sales'): PublishSnapshot {
  const assets = images.map((b, i) => ({ id: `00000000-0000-4000-8000-00000000000${i + 1}`, checksum: sha(b), role: 'image', order: i + 1, mime: 'image/jpeg' }));
  return {
    item_id: '00000000-0000-4000-8000-0000000000aa',
    channel: 'instagram',
    account: { id: 'acc-1', kind: 'mock', platform: 'instagram', external_account_id: USER, credential_state: 'linked' },
    payload: { channel: 'instagram', text: { rendered: caption, caption, cards: [] }, assets },
    payload_hash: 'h'.repeat(64),
    visibility: 'public',
    requested_result: 'mock_publish',
    scheduled_at_utc: null,
    ...over,
  };
}

function memSteps(): RemoteStepsPort & { rows: RemoteStep[] } {
  const rows: RemoteStep[] = [];
  const rank: Record<string, number> = { created: 0, finished: 1, error: 2, published: 3 };
  return {
    rows,
    list: async () => rows.map((r) => ({ ...r })),
    record: async (s) => {
      const ex = rows.find((r) => r.kind === s.kind && r.post_index === s.post_index);
      const now = new Date().toISOString();
      if (ex) {
        if (ex.remote_id !== s.remote_id) throw new Error('remote_step_conflict');
        if (ex.status !== 'error' && (rank[s.status] ?? 0) > (rank[ex.status] ?? 0)) ex.status = s.status;
        return { ...ex };
      }
      const r: RemoteStep = { kind: s.kind, post_index: s.post_index, remote_id: s.remote_id, status: s.status, received_bytes: null, total_bytes: null, resume_count: 0, step_index: rows.length, created_at: now, updated_at: now };
      rows.push(r);
      return { ...r };
    },
  };
}

let n = 0;
function ctxOf(steps: RemoteStepsPort, media: MediaPort, over: Partial<AdapterContext> = {}): AdapterContext {
  return {
    intentKey: `job-${++n}:1`,
    attempt: 1,
    jobId: 'job',
    itemId: 'item',
    now: new Date(),
    signal: new AbortController().signal,
    heartbeat: async () => undefined,
    steps,
    media,
    credential: { accessToken: async () => ({ ok: true, token: TOKEN }) },
    ...over,
  };
}
const scen = (scenario: MockScenarioValue) => ({ mockScenario: { scenario, delay_ms: 0 } });
const ref = { platform: 'instagram', intent_key: 'job:1', external_id: null, provider_request_id: null };

function setup(images: Uint8Array[]) {
  const publicMedia = new MockPublicMediaUrlProvider();
  const api = new InstagramMockApi({ tokenCheck, publicMedia });
  const adapter = new InstagramMockChannelAdapter({ api });
  const media = memMedia();
  const snap = snapshotOf(images);
  for (const [i, b] of images.entries()) media.files.set((snap.payload.assets as Array<{ id: string }>)[i]!.id, b);
  return { api, adapter, media, snap, publicMedia, steps: memSteps() };
}
async function send(a: InstagramMockChannelAdapter, snap: PublishSnapshot, ctx: AdapterContext) {
  return a.submit(await a.prepare(snap, ctx), ctx);
}

let fetchCalls = 0;
beforeEach(() => {
  fetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    fetchCalls++;
    throw new Error('network forbidden');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(fetchCalls).toBe(0);
});

describe('MockPublicMediaUrlProvider(모의 공개 URL)', () => {
  it('mock://public-media/<불투명 값> — 파일 내용·asset ID·checksum 없음, 철회·만료 뒤 읽을 수 없음', async () => {
    const p = new MockPublicMediaUrlProvider();
    const bytes = jpeg(1080, 1080);
    const file = { bytes: bytes.byteLength, mime: 'image/jpeg', checksum: sha(bytes), read: async (s: number, e: number) => bytes.slice(s, e) };
    const now = new Date();
    const asset = { id: '00000000-0000-4000-8000-000000000001', checksum: sha(bytes), mime: 'image/jpeg' };
    const u = await p.issue({ file, asset, now, ttlMs: 60_000 });
    expect(u.url.startsWith(MOCK_PUBLIC_MEDIA_PREFIX)).toBe(true);
    expect(u.url).toMatch(/^mock:\/\/public-media\/[A-Za-z0-9_-]{24}$/);
    expect(u.url).not.toContain(asset.id);
    expect(u.url).not.toContain(asset.checksum.slice(0, 16));
    expect(p.resolve(u.url, now)?.checksum).toBe(asset.checksum);
    expect(p.resolve(u.url, new Date(now.getTime() + 61_000))).toBeNull();
    const v = await p.issue({ file, asset, now, ttlMs: 60_000 });
    await p.revoke(v.url);
    expect(p.resolve(v.url, now)).toBeNull();
    expect(p.resolve('https://example.com/a.jpg', now)).toBeNull();
    expect(p.activeCount(now)).toBe(0);
  });
});

describe('InstagramMockApi(시뮬레이터)', () => {
  it('이미지 컨테이너 → FINISHED → 게시 → PUBLISHED, 모의 ID·mock:// 링크, 같은 컨테이너 두 번째 게시 거절, 받은 이미지 sha256 기록', async () => {
    const { api, publicMedia } = setup([]);
    const b = jpeg(1080, 1080);
    const file = { bytes: b.byteLength, mime: 'image/jpeg', checksum: sha(b), read: async (s: number, e: number) => b.slice(s, e) };
    const url = (await publicMedia.issue({ file, asset: { id: 'x', checksum: sha(b), mime: 'image/jpeg' }, now: new Date(), ttlMs: 60_000 })).url;
    const c = await api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: url, caption: '첫 게시' }, { finishAfterPolls: 1 });
    expect(c.id).toMatch(/^mockig_ct_[0-9a-f-]{36}$/);
    expect(c.status).toBe('IN_PROGRESS');
    expect(() => api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN })).toThrow(/container_not_ready/);
    expect(api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN }).status).toBe('IN_PROGRESS');
    expect(api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN }).status).toBe('FINISHED');
    const m = api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN });
    expect(m.id).toMatch(/^mockig_m_[0-9a-f-]{36}$/);
    expect(api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN }).status).toBe('PUBLISHED');
    expect(api.getMedia({ id: m.id, userId: USER, accessToken: TOKEN }).permalink).toBe(`mock://instagram/p/${m.id}`);
    expect(() => api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN })).toThrow(/container_already_published/);
    expect(api.publishCount.get(c.id)).toBe(1);
    expect(api.mediaOf(USER)[0]!.imageSha256).toEqual([sha(b)]);
  });

  it('원격 규격 재검사: 비율 밖·작은 가로·JPEG 아님 → 400 invalid_image_spec, 모르는·철회된 URL → image_fetch_failed, 토큰 거절 → 401', async () => {
    const { api, publicMedia } = setup([]);
    const issue = async (b: Uint8Array) =>
      (await publicMedia.issue({ file: { bytes: b.byteLength, mime: 'image/jpeg', checksum: sha(b), read: async (s, e) => b.slice(s, e) }, asset: { id: 'x', checksum: sha(b), mime: 'image/jpeg' }, now: new Date(), ttlMs: 60_000 })).url;
    await expect(api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: await issue(jpeg(1080, 1920)), caption: '' })).rejects.toThrow(/invalid_image_spec/);
    await expect(api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: await issue(jpeg(200, 200)), caption: '' })).rejects.toThrow(/invalid_image_spec/);
    const pngLike = new Uint8Array(64);
    pngLike.set([0x89, 0x50, 0x4e, 0x47]);
    await expect(api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: await issue(pngLike), caption: '' })).rejects.toThrow(/invalid_image_spec/);
    const u = await issue(jpeg(1080, 1080));
    await publicMedia.revoke(u);
    await expect(api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: u, caption: '' })).rejects.toThrow(/image_fetch_failed/);
    await expect(api.createImageContainer({ userId: USER, accessToken: 'mockig_at_wrong', imageUrl: await issue(jpeg(1080, 1080)), caption: '' })).rejects.toMatchObject({ kind: 'auth_invalid_token', httpStatus: 401 });
    expect(api.containerIds(USER)).toHaveLength(0);
  });

  it('캐러셀: 자식(캡션 없음)은 FINISHED 여야, 다른 부모에 다시 쓸 수 없음, 2~10개, 자식은 직접 게시 불가', async () => {
    const { api, publicMedia } = setup([]);
    const child = async () => {
      const b = jpeg(1080, 1350);
      const url = (await publicMedia.issue({ file: { bytes: b.byteLength, mime: 'image/jpeg', checksum: sha(b), read: async (s, e) => b.slice(s, e) }, asset: { id: 'x', checksum: sha(b), mime: 'image/jpeg' }, now: new Date(), ttlMs: 60_000 })).url;
      return api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: url, isCarouselItem: true });
    };
    const a = await child();
    const b = await child();
    expect(() => api.publish({ userId: USER, creationId: a.id, accessToken: TOKEN })).toThrow(/carousel_item_not_publishable/);
    expect(() => api.createCarouselContainer({ userId: USER, accessToken: TOKEN, children: [a.id], caption: 'x' })).toThrow(/invalid_children/);
    const parent = api.createCarouselContainer({ userId: USER, accessToken: TOKEN, children: [a.id, b.id], caption: '캐러셀' });
    expect(() => api.createCarouselContainer({ userId: USER, accessToken: TOKEN, children: [a.id, b.id], caption: '두 번째' })).toThrow(/invalid_children/);
    const m = api.publish({ userId: USER, creationId: parent.id, accessToken: TOKEN });
    expect(api.mediaOf(USER).find((x) => x.id === m.id)).toMatchObject({ mediaType: 'CAROUSEL_ALBUM' });
    expect(api.mediaOf(USER).find((x) => x.id === m.id)!.imageSha256).toHaveLength(2);
  });

  it('게시 예산(429 + retry-after), 장애 주입(applied = 원격은 끝냄), reset 은 기록을 잊는다(재시작 흉내)', async () => {
    const { api, publicMedia } = setup([]);
    const b = jpeg(1080, 1080);
    const url = (await publicMedia.issue({ file: { bytes: b.byteLength, mime: 'image/jpeg', checksum: sha(b), read: async (s, e) => b.slice(s, e) }, asset: { id: 'x', checksum: sha(b), mime: 'image/jpeg' }, now: new Date(), ttlMs: 60_000 })).url;
    const c = await api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: url, caption: 'x' });
    api.setRateBudget(USER, 0, 7);
    expect(() => api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN })).toThrow(expect.objectContaining({ kind: 'rate_limited', opts: expect.objectContaining({ retryAfterSec: 7 }) }));
    api.clearRateBudget(USER);
    api.injectFault({ op: 'publish', kind: 'timeout', applied: true });
    expect(() => api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN })).toThrow(/timeout/);
    expect(api.findPublishedByContainer({ creationId: c.id, userId: USER, accessToken: TOKEN })).not.toBeNull();
    api.reset();
    expect(() => api.getContainer({ id: c.id, userId: USER, accessToken: TOKEN })).toThrow(/container_not_found/);
  });

  it('오류 분류 표(docs/03): 401 auth, 403·400 permanent, 429 일시(Retry-After), 쓰기 5xx → 조회(FIX-T16: 부작용 표시와 무관), 읽기 5xx → 재시도, 시간 초과 → 결과 불명', () => {
    const want: Record<InstagramErrorKind, string> = {
      auth_invalid_token: 'rejected/auth',
      permission_denied: 'rejected/permanent',
      invalid_parameter: 'rejected/permanent',
      not_found: 'ambiguous/transient_unknown_side_effect',
      rate_limited: 'rejected/transient_no_side_effect',
      server_error: 'ambiguous/transient_unknown_side_effect',
      timeout: 'ambiguous/transient_unknown_side_effect',
    };
    for (const k of INSTAGRAM_ERROR_KINDS) {
      const r = classifyInstagramError(new InstagramMockApiError(k), 'publish');
      expect(`${r.status}/${r.retry_class}`).toBe(want[k]);
    }
    expect(classifyInstagramError(new InstagramMockApiError('server_error', { sideEffect: 'unknown' }), 'publish').retry_class).toBe('transient_unknown_side_effect');
    expect(classifyInstagramError(new InstagramMockApiError('server_error', { sideEffect: 'unknown' }), 'getContainer').retry_class).toBe('transient_no_side_effect');
    expect(classifyInstagramError(new InstagramMockApiError('invalid_parameter', { code: 'invalid_image_spec' }), 'createImageContainer')).toMatchObject({ retry_class: 'permanent', error_code: 'invalid_image_spec' });
    expect(classifyInstagramError(new InstagramMockApiError('invalid_parameter', { code: 'container_already_published' }), 'publish').status).toBe('ambiguous');
    expect(classifyInstagramError(new InstagramMockApiError('rate_limited', { retryAfterSec: 9 }), 'publish').retry_after_sec).toBe(9);
  });
});

describe('InstagramMockChannelAdapter', () => {
  it('선택 규칙: 모의 + instagram + 연결함 → mock_instagram, seed(연결 없음) → mock_generic, live → 없음; 시나리오는 instagram_* 만', () => {
    expect(adapterIdFor({ kind: 'mock', platform: 'instagram', credential_state: 'linked' })).toBe('mock_instagram');
    expect(adapterIdFor({ kind: 'mock', platform: 'instagram', credential_state: 'needs_reconnect' })).toBe('mock_instagram');
    expect(adapterIdFor({ kind: 'mock', platform: 'instagram', credential_state: 'none' })).toBe('mock_generic');
    expect(adapterIdFor({ kind: 'live', platform: 'instagram', credential_state: 'linked' })).toBeNull();
    const reg = new MockChannelAdapterRegistry(new MockChannelAdapter({ readEnv: false }), undefined, undefined, new InstagramMockChannelAdapter({ api: new InstagramMockApi({ tokenCheck }) }));
    expect(reg.getAdapterFor({ kind: 'mock', platform: 'instagram', credential_state: 'linked' })).toBe(reg.instagram);
    expect(reg.getAdapterFor({ kind: 'mock', platform: 'instagram', credential_state: 'none' })).toBe(reg.mock);
    expect(reg.getAdapterById('mock_instagram')).toBe(reg.instagram);
    expect(scenarioApplies('mock_instagram', 'instagram_container_slow')).toBe(true);
    expect(scenarioApplies('mock_instagram', 'threads_success')).toBe(false);
    expect(scenarioApplies('mock_generic', 'instagram_success')).toBe(false);
  });

  it('validate(스냅샷만): mock_publish 만, 공개 범위 public 만, 이미지 역할·개수·JPEG·캡션', () => {
    const a = new InstagramMockChannelAdapter({ api: new InstagramMockApi({ tokenCheck }) });
    const one = jpeg(1080, 1080);
    expect(a.validate(snapshotOf([one]))).toEqual({ ok: true });
    expect(a.validate(snapshotOf([one, one]))).toEqual({ ok: true });
    expect(a.validate(snapshotOf([one], { requested_result: 'upload_private' }))).toEqual({ ok: false, error_code: 'mock_only' });
    expect(a.validate(snapshotOf([one], { visibility: 'private' }))).toEqual({ ok: false, error_code: 'instagram_visibility_public_only' });
    expect(a.validate(snapshotOf([]))).toEqual({ ok: false, error_code: 'invalid_media_spec:no_image' });
    expect(a.validate(snapshotOf(Array.from({ length: 11 }, () => one)))).toEqual({ ok: false, error_code: 'invalid_media_spec:too_many_images' });
    expect(a.validate(snapshotOf([one], {}, '가'.repeat(INSTAGRAM_PROVISIONAL_MEDIA_SPEC.caption_max + 1)))).toEqual({ ok: false, error_code: 'invalid_media_spec:caption_too_long' });
    const withVideo = snapshotOf([one]);
    (withVideo.payload.assets as unknown[]).push({ id: 'v', checksum: 'c'.repeat(64), role: 'video', order: 2, mime: 'video/mp4' });
    expect(a.validate(withVideo)).toEqual({ ok: false, error_code: 'invalid_media_spec:video_not_supported_t16:2' });
    const png = snapshotOf([one]);
    (png.payload.assets as Array<{ mime: string }>)[0]!.mime = 'image/png';
    expect(a.validate(png)).toEqual({ ok: false, error_code: 'invalid_media_spec:mime_not_allowed:1' });
  });

  it('단일 이미지 성공: 컨테이너(post 0) → 게시, PUBLISHED/public MOCK, 공개 URL 은 결과·단계에 없고 바로 철회(활성 0), 받은 이미지 = 승인 파일', async () => {
    const img = jpeg(1080, 1350, 64 * 1024);
    const s = setup([img]);
    const r = await send(s.adapter, s.snap, ctxOf(s.steps, s.media));
    expect(r).toMatchObject({ status: 'accepted', result_kind: 'PUBLISHED', remote_visibility: 'public' });
    expect(r.external_id).toMatch(/^mock:instagram:mockig_m_/);
    expect(r.permalink).toMatch(/^mock:\/\/instagram\/p\/mockig_m_/);
    expect(s.steps.rows.map((x) => `${x.kind}:${x.post_index}:${x.status}`)).toEqual(['ig_container:0:finished', 'ig_publish:0:published']);
    expect(s.publicMedia.stats.issued).toBe(1);
    expect(s.publicMedia.activeCount()).toBe(0);
    const all = inspect({ r, rows: s.steps.rows }, { depth: Infinity });
    expect(all).not.toContain(MOCK_PUBLIC_MEDIA_PREFIX);
    expect(all).not.toContain(TOKEN);
    expect(s.api.mediaOf(USER)[0]!.imageSha256).toEqual([sha(img)]);
    expect(s.adapter.rateUnitsRemaining(s.snap, s.steps.rows)).toBe(0);
    expect(s.adapter.rateUnitsRemaining(s.snap, [])).toBe(1);
  });

  it('캐러셀 3장: 자식 post 1..3 → 부모 post 0 → 게시 1번, 미디어 1개(CAROUSEL_ALBUM), 순서대로 같은 파일', async () => {
    const imgs = [jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100), jpeg(1080, 566, 3200)];
    const s = setup(imgs);
    const r = await send(s.adapter, s.snap, ctxOf(s.steps, s.media));
    expect(r.status).toBe('accepted');
    expect(s.steps.rows.map((x) => `${x.kind}:${x.post_index}`)).toEqual(['ig_container:1', 'ig_container:2', 'ig_container:3', 'ig_parent_request:0', 'ig_container:0', 'ig_publish:0']);
    const m = s.api.mediaOf(USER);
    expect(m).toHaveLength(1);
    expect(m[0]!.mediaType).toBe('CAROUSEL_ALBUM');
    expect(m[0]!.imageSha256).toEqual(imgs.map(sha));
    expect(s.publicMedia.stats.issued).toBe(3);
    expect(s.publicMedia.activeCount()).toBe(0);
  });

  it('보내기 직전 규격 재검사: 파일 비율이 잠정 범위 밖이면 원격 호출 0·FAILED(permanent), 파일이 바뀌면 media_unavailable', async () => {
    const s = setup([jpeg(1080, 1920)]);
    const r = await send(s.adapter, s.snap, ctxOf(s.steps, s.media));
    expect(r).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'invalid_media_spec:aspect_out_of_range:1' });
    expect(s.api.calls.createImageContainer).toBe(0);
    expect(s.publicMedia.stats.issued).toBe(0);
    const t = setup([jpeg(1080, 1080)]);
    t.media.files.set((t.snap.payload.assets as Array<{ id: string }>)[0]!.id, jpeg(1080, 1080, 5000));
    const r2 = await send(t.adapter, t.snap, ctxOf(t.steps, t.media));
    expect(r2.error_code).toBe('invalid_media_spec:media_unavailable:media_changed:1');
    expect(t.api.calls.createImageContainer).toBe(0);
  });

  it('원격 규격 거부(instagram_invalid_spec_remote) → 400 permanent, 컨테이너 없음, URL 철회', async () => {
    const s = setup([jpeg(1080, 1080)]);
    const r = await send(s.adapter, s.snap, ctxOf(s.steps, s.media, scen('instagram_invalid_spec_remote')));
    expect(r).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'invalid_image_spec' });
    expect(s.steps.rows).toHaveLength(0);
    expect(s.publicMedia.activeCount()).toBe(0);
  });

  it('A08: 게시 응답 유실(원격은 게시) → ambiguous → 조회가 같은 컨테이너의 미디어를 찾아 found, 다시 게시 0', async () => {
    const s = setup([jpeg(1080, 1080)]);
    const ctx = ctxOf(s.steps, s.media, scen('instagram_publish_timeout_sent'));
    const r = await send(s.adapter, s.snap, ctx);
    expect(r).toMatchObject({ status: 'ambiguous', error_code: 'timeout' });
    expect(s.steps.rows.map((x) => x.kind)).toEqual(['ig_container']);
    const rec = await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap });
    expect(rec).toMatchObject({ status: 'found', result_kind: 'PUBLISHED', remote_visibility: 'public' });
    expect(s.steps.rows.map((x) => x.kind)).toEqual(['ig_container', 'ig_publish']);
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('게시 시간 초과(원격 게시 안 됨) → 조회 resumable → 다음 시도가 같은 컨테이너로 게시(컨테이너 1개·미디어 1개)', async () => {
    const s = setup([jpeg(1080, 1080)]);
    const ctx = ctxOf(s.steps, s.media, scen('instagram_publish_timeout_not_sent'));
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'container_not_published' });
    const r = await send(s.adapter, s.snap, { ...ctx, attempt: 2 });
    expect(r.status).toBe('accepted');
    expect(s.api.containerIds(USER)).toHaveLength(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('컨테이너 처리 지연 → processing(새 컨테이너 없음) → 조회 processing·resumable → 이어서 게시; 캐러셀 자식 지연도 같은 규칙', async () => {
    const s = setup([jpeg(1080, 1080)]);
    const ctx = ctxOf(s.steps, s.media, scen('instagram_container_slow'));
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'processing', error_code: 'container_in_progress' });
    const rec = await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap });
    expect(['processing', 'resumable']).toContain(rec.status);
    let last = rec;
    for (let i = 0; i < 3 && last.status === 'processing'; i++) last = await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap });
    expect(last.status).toBe('resumable');
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.containerIds(USER)).toHaveLength(1);
  });

  it('401(첫 컨테이너) → auth, 403 → permanent, 컨테이너 오류(ERROR) → 단계 error + permanent, 429 게시 → 일시(Retry-After) 뒤 같은 컨테이너', async () => {
    const a = setup([jpeg(1080, 1080)]);
    expect(await send(a.adapter, a.snap, ctxOf(a.steps, a.media, scen('instagram_token_invalid')))).toMatchObject({ status: 'rejected', retry_class: 'auth' });
    expect(a.steps.rows).toHaveLength(0);
    const b = setup([jpeg(1080, 1080)]);
    expect(await send(b.adapter, b.snap, ctxOf(b.steps, b.media, scen('instagram_permission_denied')))).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'permission_denied' });
    const c = setup([jpeg(1080, 1080), jpeg(1080, 1080)]);
    expect(await send(c.adapter, c.snap, ctxOf(c.steps, c.media, scen('instagram_container_error')))).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'container_error' });
    expect(c.steps.rows.find((x) => x.kind === 'ig_container' && x.post_index === 0)?.status).toBe('error');
    const d = setup([jpeg(1080, 1080)]);
    const ctx = ctxOf(d.steps, d.media, scen('instagram_rate_limited'));
    expect(await send(d.adapter, d.snap, ctx)).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect', retry_after_sec: 5 });
    expect((await send(d.adapter, d.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(d.api.containerIds(USER)).toHaveLength(1);
  });

  it('조회 판정: 단계 없음 → not_found, 원격이 기록을 잃음(재시작) → unknown(맹목 재게시 없음), 만료 컨테이너 → unknown, 연결 정보 없음 → unknown', async () => {
    const s = setup([jpeg(1080, 1080)]);
    const ctx = ctxOf(s.steps, s.media, { snapshot: s.snap });
    expect(await s.adapter.reconcile(ref, ctx)).toMatchObject({ status: 'not_found' });
    await send(s.adapter, s.snap, ctxOf(s.steps, s.media, scen('instagram_publish_timeout_not_sent')));
    s.api.expireContainer(s.steps.rows[0]!.remote_id);
    expect(await s.adapter.reconcile(ref, ctx)).toMatchObject({ status: 'unknown', error_code: 'container_expired' });
    s.api.reset();
    expect(await s.adapter.reconcile(ref, ctx)).toMatchObject({ status: 'unknown' });
    expect(await s.adapter.reconcile(ref, { ...ctx, credential: { accessToken: async () => ({ ok: false, code: 'credential_revoked' }) } })).toMatchObject({ status: 'unknown', error_code: 'credential_revoked' });
    expect(await s.adapter.cancel(ref, ctx)).toMatchObject({ status: 'unsupported' });
  });

  it('토큰 없음·미디어 창구 없음 → 원격 호출 없이 거절', async () => {
    const s = setup([jpeg(1080, 1080)]);
    expect(await send(s.adapter, s.snap, ctxOf(s.steps, s.media, { credential: { accessToken: async () => ({ ok: false, code: 'credential_expired' }) } }))).toMatchObject({ status: 'rejected', retry_class: 'auth', error_code: 'credential_expired' });
    expect(await send(s.adapter, s.snap, ctxOf(s.steps, s.media, { media: undefined }))).toMatchObject({ status: 'rejected', error_code: 'media_reader_unavailable' });
    expect(s.api.calls.createImageContainer).toBe(0);
  });
});

describe('FIX-T16(Codex review-T16)', () => {
  /** 실제 DB 창구(mediaPortFor)처럼 **메타데이터만** 비교하는 창구 — 바이트는 해시하지 않는다(memMedia 는 해시해서 차이를 가렸다). */
  function metaOnlyMedia(images: Uint8Array[], snap: PublishSnapshot): MediaPort & { files: Map<string, Uint8Array>; reads: number } {
    const files = new Map<string, Uint8Array>();
    const ids = (snap.payload.assets as Array<{ id: string; checksum: string }>).map((a) => a);
    for (const [i, b] of images.entries()) files.set(ids[i]!.id, b);
    const port = {
      files,
      reads: 0,
      open: async (a: { id: string; checksum: string; mime: string }) => {
        const want = ids.find((x) => x.id === a.id);
        if (!want || want.checksum !== a.checksum) return { ok: false as const, code: 'media_changed' };
        const size = files.get(a.id)!.byteLength;
        return {
          ok: true as const,
          file: {
            bytes: size,
            mime: a.mime,
            checksum: a.checksum,
            read: async (s: number, e: number) => {
              port.reads++;
              return files.get(a.id)!.slice(s, e);
            },
          },
        };
      },
    };
    return port;
  }
  /** 같은 길이·같은 규격의 다른 JPEG(바이트만 다름) */
  const tamper = (b: Uint8Array) => {
    const t = Uint8Array.from(b);
    t[t.length - 10] = (t[t.length - 10]! + 1) % 250;
    return t;
  };

  it('[P0] 단일 이미지: 저장소 바이트만 바뀜(메타데이터 checksum 그대로) → asset_checksum_mismatch:1 FAILED, 원격 호출·URL 발급 0', async () => {
    const img = jpeg(1080, 1080);
    const s = setup([img]);
    const media = metaOnlyMedia([tamper(img)], s.snap);
    const r = await send(s.adapter, s.snap, ctxOf(s.steps, media));
    expect(r).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'asset_checksum_mismatch:1' });
    expect(Object.values(s.api.calls).reduce((x, y) => x + y, 0)).toBe(0);
    expect(s.publicMedia.stats.issued).toBe(0);
    expect(s.steps.rows).toHaveLength(0);
  });

  it('[P0] 캐러셀 3장 중 2번째만 바뀜 → asset_checksum_mismatch:2, 자식 컨테이너도 0(하나라도 다르면 아무것도 만들지 않는다)', async () => {
    const imgs = [jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100), jpeg(1080, 566, 3200)];
    const s = setup(imgs);
    const media = metaOnlyMedia([imgs[0]!, tamper(imgs[1]!), imgs[2]!], s.snap);
    const r = await send(s.adapter, s.snap, ctxOf(s.steps, media));
    expect(r).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'asset_checksum_mismatch:2' });
    expect(s.api.calls.createImageContainer).toBe(0);
    expect(s.api.containerIds(USER)).toHaveLength(0);
    expect(s.publicMedia.stats.issued).toBe(0);
  });

  it('[P0] 확인 뒤 저장소가 바뀌어도 원격이 받는 바이트 = 확인한(승인) 바이트(공개 URL 창구에는 메모리 사본만)', async () => {
    const img = jpeg(1080, 1080);
    const s = setup([img]);
    const media = metaOnlyMedia([img], s.snap);
    const id = (s.snap.payload.assets as Array<{ id: string }>)[0]!.id;
    const base = media.open;
    // 확인(전체 읽기 — 규격 머리 읽기 다음 두 번째 읽기)이 끝난 직후 저장소 바이트를 바꾼다
    media.open = async (a) => {
      const o = await base(a);
      if (!o.ok) return o;
      const read = o.file.read;
      return {
        ok: true,
        file: {
          ...o.file,
          read: async (st: number, e: number) => {
            const out = await read(st, e);
            if (media.reads >= 2) media.files.set(id, tamper(img));
            return out;
          },
        },
      };
    };
    const r = await send(s.adapter, s.snap, ctxOf(s.steps, media));
    expect(r.status).toBe('accepted');
    expect(media.files.get(id)).not.toEqual(img);
    expect(s.api.mediaOf(USER)[0]!.imageSha256).toEqual([sha(img)]);
  });

  it('[P0] 장애 주입: applied + sideEffect none 은 거부, applied 5xx 는 오류에 sideEffect unknown', async () => {
    const { api, publicMedia } = setup([]);
    expect(() => api.injectFault({ op: 'publish', kind: 'server_error', applied: true, sideEffect: 'none' })).toThrow(/sideEffect none/);
    const b = jpeg(1080, 1080);
    const url = (
      await publicMedia.issue({
        file: { bytes: b.byteLength, mime: 'image/jpeg', checksum: sha(b), read: async (st, e) => b.slice(st, e) },
        asset: { id: 'x', checksum: sha(b), mime: 'image/jpeg' },
        now: new Date(),
        ttlMs: 60_000,
      })
    ).url;
    const c = await api.createImageContainer({ userId: USER, accessToken: TOKEN, imageUrl: url, caption: 'x' });
    api.injectFault({ op: 'publish', kind: 'server_error', applied: true });
    let err: unknown;
    try {
      api.publish({ userId: USER, creationId: c.id, accessToken: TOKEN });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InstagramMockApiError);
    expect((err as InstagramMockApiError).sideEffect).toBe('unknown');
    expect(api.findPublishedByContainer({ creationId: c.id, userId: USER, accessToken: TOKEN })).not.toBeNull();
  });

  it('[P0] 쓰기 5xx 는 부작용 표시와 무관하게 ambiguous(조회), 읽기 5xx 만 재시도', () => {
    for (const op of ['createImageContainer', 'createCarouselContainer', 'publish'] as const) {
      for (const sideEffect of [undefined, 'none', 'unknown'] as const) {
        expect(classifyInstagramError(new InstagramMockApiError('server_error', { sideEffect }), op)).toMatchObject({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect' });
      }
    }
    for (const op of ['getContainer', 'getMedia', 'findPublishedByContainer', 'findCarouselByChildren'] as const) {
      expect(classifyInstagramError(new InstagramMockApiError('server_error'), op).retry_class).toBe('transient_no_side_effect');
    }
  });

  it('[P0] 게시 5xx(원격은 게시함) → ambiguous → 조회 found, 게시 호출 1·미디어 1', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.injectFault({ op: 'publish', kind: 'server_error', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'ambiguous', error_code: 'server_error_side_effect_unknown' });
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'found', result_kind: 'PUBLISHED' });
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
    // 조회 뒤 다시 보내도(재개) 게시하지 않는다
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.publish).toBe(1);
  });

  it('[P0] 게시 5xx(적용 안 됨) → ambiguous → 조회 resumable → 같은 컨테이너로 게시(컨테이너 1·미디어 1)', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.injectFault({ op: 'publish', kind: 'server_error' });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'container_not_published' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.containerIds(USER)).toHaveLength(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('[P0] 컨테이너 생성 5xx(원격은 만듦, 기록 없음) → ambiguous → 조회 not_found → 새 컨테이너로 게시 1번, 기록 없는 컨테이너는 게시되지 않음', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.injectFault({ op: 'createImageContainer', kind: 'server_error', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'ambiguous', error_code: 'server_error_side_effect_unknown' });
    expect(s.steps.rows).toHaveLength(0);
    const orphan = s.api.containerIds(USER);
    expect(orphan).toHaveLength(1);
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'not_found' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
    expect(s.api.mediaOf(USER)[0]!.containerId).not.toBe(orphan[0]);
    expect(s.publicMedia.unrevokedCount()).toBe(0);
  });

  it('[P1] 캐러셀 부모 생성 응답 유실(원격은 만듦) → 요청 표식 → 조회가 자식으로 부모를 찾아 기록 → 같은 부모로 게시(부모 생성 1·게시 1)', async () => {
    const imgs = [jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)];
    const s = setup(imgs);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'ambiguous', error_code: 'timeout' });
    expect(s.steps.rows.map((x) => `${x.kind}:${x.post_index}`)).toEqual(['ig_container:1', 'ig_container:2', 'ig_parent_request:0']);
    expect(s.steps.rows.find((x) => x.kind === 'ig_parent_request')!.remote_id).toMatch(/^mockig_req_[0-9a-f-]{36}$/);
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'container_not_published' });
    expect(s.steps.rows.find((x) => x.kind === 'ig_container' && x.post_index === 0)).toBeTruthy();
    const r = await send(s.adapter, s.snap, { ...ctx, attempt: 2 });
    expect(r.status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
    expect(s.api.mediaOf(USER)[0]!.imageSha256).toEqual(imgs.map(sha));
  });

  it('[P1] 부모 응답 유실 뒤 조회 없이 바로 재시도해도 표식 → 찾기 → 두 번째 부모 없음(쓰인 자식 재사용 오류 없음)', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(s.api.containerIds(USER)).toHaveLength(3);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('[P1] 부모 생성 시간 초과(원격 안 만듦) → 조회 찾기 null → resumable(부모부터) → 부모 1개·게시 1', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: false });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'carousel_parent_not_created' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(2);
    expect(s.api.containerIds(USER)).toHaveLength(3);
    expect(s.steps.rows.filter((x) => x.kind === 'ig_parent_request')).toHaveLength(1);
  });

  it('[P1] 부모 생성 직후 단계 기록 실패(DB) → submit 예외 → 조회가 부모를 찾아 기록 → 게시 1', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    const real = s.steps.record;
    let failOnce = true;
    s.steps.record = async (st) => {
      if (failOnce && st.kind === 'ig_container' && st.post_index === 0) {
        failOnce = false;
        throw new Error('db down');
      }
      return real(st);
    };
    const ctx = ctxOf(s.steps, s.media);
    await expect(send(s.adapter, s.snap, ctx)).rejects.toThrow(/db down/);
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'container_not_published' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('[P1] 부모 응답 유실 뒤 원격이 기록을 잃음(재시작) → 조회 unknown(parent_lookup_…), 재시도도 새 부모를 만들지 않음', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    await send(s.adapter, s.snap, ctx);
    s.api.reset();
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'unknown', error_code: 'parent_lookup_container_not_found' });
    expect(await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).toMatchObject({ status: 'ambiguous' });
    expect(s.api.calls.createCarouselContainer).toBe(0);
    expect(s.api.calls.publish).toBe(0);
  });

  it('[Q6] 공개 범위는 원격 응답 값(모의 계정 private → remote_visibility private, 고정 public 아님)', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.setAccountVisibility(USER, 'private');
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'accepted', remote_visibility: 'private' });
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'found', remote_visibility: 'private' });
  });

  it('게시 뒤 파일이 바뀌어도 이미 게시된 작업의 재확인은 FAILED 로 덮지 않는다(게시 단계 먼저)', async () => {
    const img = jpeg(1080, 1080);
    const s = setup([img]);
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('accepted');
    const media = metaOnlyMedia([tamper(img)], s.snap);
    expect((await send(s.adapter, s.snap, { ...ctx, media, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.publish).toBe(1);
  });

  // ---- FIX round 2(Codex review-FIX-T16) ----

  const WRITES = ['createImageContainer', 'createCarouselContainer', 'publish'] as const;
  const READS = ['getContainer', 'getMedia', 'findPublishedByContainer', 'findCarouselByChildren'] as const;

  it('[R2-P0] 쓰기 오류의 sideEffect unknown 은 429·400·401·403·404·5xx 모두 ambiguous(조회) — 분류 분기보다 먼저', () => {
    for (const op of WRITES) {
      for (const k of INSTAGRAM_ERROR_KINDS) {
        expect(classifyInstagramError(new InstagramMockApiError(k, { sideEffect: 'unknown', retryAfterSec: 5 }), op)).toMatchObject({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect' });
      }
      expect(classifyInstagramError(new InstagramMockApiError('rate_limited', { sideEffect: 'unknown' }), op).error_code).toBe('rate_limited_side_effect_unknown');
      expect(classifyInstagramError(new InstagramMockApiError('invalid_parameter', { code: 'invalid_image_spec', sideEffect: 'unknown' }), op).error_code).toBe('invalid_image_spec_side_effect_unknown');
      // 부작용 없음이 증명된 오류(받아들이기 전 거절)만 기존 분류: 429 → 기다린 뒤 재시도, 400·403 → 영구, 401 → 재연결
      expect(classifyInstagramError(new InstagramMockApiError('rate_limited', { sideEffect: 'none', retryAfterSec: 5 }), op)).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect', retry_after_sec: 5 });
      expect(classifyInstagramError(new InstagramMockApiError('permission_denied', { sideEffect: 'none' }), op).retry_class).toBe('permanent');
      expect(classifyInstagramError(new InstagramMockApiError('auth_invalid_token'), op).retry_class).toBe('auth');
    }
    // 읽기는 부작용이 없다 — 429 는 그대로 재시도
    for (const op of READS) expect(classifyInstagramError(new InstagramMockApiError('rate_limited', { sideEffect: 'unknown' }), op).retry_class).toBe('transient_no_side_effect');
  });

  it('[R2-P0] 시뮬레이터: applied 429·400·401·403 는 동작을 끝내고 sideEffect unknown, 적용 안 된 429 는 none(게시 없음)', async () => {
    for (const kind of ['rate_limited', 'invalid_parameter', 'auth_invalid_token', 'permission_denied'] as const) {
      const s = setup([jpeg(1080, 1080)]);
      const ctx = ctxOf(s.steps, s.media);
      s.api.injectFault({ op: 'publish', kind, applied: true, userId: USER });
      const r = await send(s.adapter, s.snap, ctx);
      expect(r).toMatchObject({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect' });
      expect(s.api.mediaOf(USER)).toHaveLength(1);
    }
  });

  it('[R2-P0] 게시 applied 429(원격은 게시) → ambiguous(재시도 아님) → 조회 found → 다시 보내도 게시 0 — 게시 정확히 1', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.injectFault({ op: 'publish', kind: 'rate_limited', applied: true, retryAfterSec: 5 });
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'rate_limited_side_effect_unknown' });
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'found', result_kind: 'PUBLISHED' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('[R2-P0] 게시 applied 429 뒤 조회 없이 바로 재시도해도 기록한 컨테이너의 게시를 먼저 찾는다 — 두 번째 게시 호출 0', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.injectFault({ op: 'publish', kind: 'rate_limited', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.publish).toBe(1);
    expect(s.steps.rows.map((x) => `${x.kind}:${x.post_index}`)).toEqual(['ig_container:0', 'ig_publish:0']);
  });

  it('[R2-P0] 컨테이너 생성 applied 429(원격은 만듦, 기록 없음) → ambiguous → 조회 not_found → 새 컨테이너로 게시 1번(기록 없는 컨테이너는 게시 안 됨)', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.injectFault({ op: 'createImageContainer', kind: 'rate_limited', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'ambiguous', error_code: 'rate_limited_side_effect_unknown' });
    const orphan = s.api.containerIds(USER);
    expect(orphan).toHaveLength(1);
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'not_found' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
    expect(s.api.mediaOf(USER)[0]!.containerId).not.toBe(orphan[0]);
    expect(s.publicMedia.unrevokedCount()).toBe(0);
  });

  it('[R2-P0] 캐러셀 부모 생성 applied 429 → ambiguous → 표식으로 부모를 찾아 같은 부모로 게시(부모 생성 1·게시 1)', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'rate_limited', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'ambiguous', error_code: 'rate_limited_side_effect_unknown' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('[R2-P0] 적용 안 된 429(게시 안 됨) → rejected/transient_no_side_effect(Retry-After) → 기다린 뒤 같은 컨테이너로 게시(컨테이너 1·미디어 1)', async () => {
    const s = setup([jpeg(1080, 1080)]);
    s.api.injectFault({ op: 'publish', kind: 'rate_limited', retryAfterSec: 5 });
    const ctx = ctxOf(s.steps, s.media);
    expect(await send(s.adapter, s.snap, ctx)).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'rate_limited', retry_after_sec: 5 });
    expect(s.api.mediaOf(USER)).toHaveLength(0);
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.publish).toBe(2);
    expect(s.api.containerIds(USER)).toHaveLength(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  /** FIX1 이전 버전의 기록 모양을 만든다 — 부모 요청 표식(ig_parent_request)을 쓰지 않는 단계 창구. 돌려준 함수로 원래대로. */
  function asPreFix1(steps: RemoteStepsPort & { rows: RemoteStep[] }): () => void {
    const real = steps.record;
    steps.record = async (st) => {
      if (st.kind === 'ig_parent_request') {
        const now = new Date().toISOString();
        return { kind: st.kind, post_index: st.post_index, remote_id: st.remote_id, status: st.status, received_bytes: null, total_bytes: null, resume_count: 0, step_index: -1, created_at: now, updated_at: now };
      }
      return real(st);
    };
    return () => {
      steps.record = real;
    };
  }
  const shape = (rows: RemoteStep[]) => rows.map((x) => `${x.kind}:${x.post_index}`);
  const parents = (api: InstagramMockApi) => api.containerIds(USER).filter((id) => api.containerOf(id)!.type === 'CAROUSEL');

  it('[R2-P1] FIX1 이전 작업(자식만 기록·표식 없음), 원격 부모 있음 → 조회가 자식으로 부모를 찾아 기록 → 같은 부모로 게시(부모 1·게시 1)', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    const restore = asPreFix1(s.steps);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    restore();
    expect(shape(s.steps.rows)).toEqual(['ig_container:1', 'ig_container:2']);
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'container_not_published' });
    expect(s.steps.rows.find((x) => x.kind === 'ig_container' && x.post_index === 0)!.remote_id).toBe(parents(s.api)[0]);
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(parents(s.api)).toHaveLength(1);
    expect(s.api.calls.publish).toBe(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('[R2-P1] FIX1 이전 작업, 조회 없이 바로 재시도 → 표식이 없어도 찾기 먼저 → 두 번째 부모·invalid_children 없음', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    const restore = asPreFix1(s.steps);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    restore();
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(parents(s.api)).toHaveLength(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
  });

  it('[R2-P1] FIX1 이전 작업, 원격 부모 없음 → 찾기 null(확실) → 조회 resumable → 부모 1번 생성·게시 1', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    const restore = asPreFix1(s.steps);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: false });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    restore();
    expect(parents(s.api)).toHaveLength(0);
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'carousel_parent_not_created' });
    expect((await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).status).toBe('accepted');
    expect(parents(s.api)).toHaveLength(1);
    expect(s.api.mediaOf(USER)).toHaveLength(1);
    // 새 코드가 만들 때는 표식을 먼저 남긴다
    expect(shape(s.steps.rows)).toEqual(['ig_container:1', 'ig_container:2', 'ig_parent_request:0', 'ig_container:0', 'ig_publish:0']);
  });

  it('[R2-P1] FIX1 이전 작업, 찾기 불가(시간 초과·인증 오류·원격 기록 유실) → 조회 UNKNOWN, submit ambiguous, 새 부모 0', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    const restore = asPreFix1(s.steps);
    s.api.injectFault({ op: 'createCarouselContainer', kind: 'timeout', applied: true });
    const ctx = ctxOf(s.steps, s.media);
    expect((await send(s.adapter, s.snap, ctx)).status).toBe('ambiguous');
    restore();
    s.api.injectFault({ op: 'findCarouselByChildren', kind: 'timeout' });
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'unknown', error_code: 'parent_lookup_timeout' });
    s.api.injectFault({ op: 'findCarouselByChildren', kind: 'auth_invalid_token' });
    expect(await send(s.adapter, s.snap, { ...ctx, attempt: 2 })).toMatchObject({ status: 'ambiguous', error_code: 'parent_lookup_auth_invalid_token' });
    s.api.injectFault({ op: 'findCarouselByChildren', kind: 'server_error' });
    expect(await send(s.adapter, s.snap, { ...ctx, attempt: 3 })).toMatchObject({ status: 'ambiguous', error_code: 'parent_lookup_server_error' });
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(parents(s.api)).toHaveLength(1);
    expect(s.api.calls.publish).toBe(0);
    s.api.reset();
    expect(await s.adapter.reconcile(ref, { ...ctx, snapshot: s.snap })).toMatchObject({ status: 'unknown', error_code: 'parent_lookup_container_not_found' });
    expect(await send(s.adapter, s.snap, { ...ctx, attempt: 4 })).toMatchObject({ status: 'ambiguous' });
    expect(s.api.calls.createCarouselContainer).toBe(0);
    expect(s.api.calls.publish).toBe(0);
  });

  it('[R2] 표식 기록 직후 중단(부모 요청 전) → 조회 찾기 null → resumable → 부모 1번·게시 1(같은 표식)', async () => {
    const s = setup([jpeg(1080, 1080, 3000), jpeg(1080, 1350, 3100)]);
    const ac = new AbortController();
    const real = s.steps.record;
    s.steps.record = async (st) => {
      const out = await real(st);
      if (st.kind === 'ig_parent_request') ac.abort();
      return out;
    };
    const ctx = ctxOf(s.steps, s.media, { signal: ac.signal });
    await expect(send(s.adapter, s.snap, ctx)).rejects.toThrow(/aborted/);
    s.steps.record = real;
    expect(s.api.calls.createCarouselContainer).toBe(0);
    const marker = s.steps.rows.find((x) => x.kind === 'ig_parent_request')!.remote_id;
    const ctx2 = { ...ctx, signal: new AbortController().signal };
    expect(await s.adapter.reconcile(ref, { ...ctx2, snapshot: s.snap })).toMatchObject({ status: 'resumable', error_code: 'carousel_parent_not_created' });
    expect((await send(s.adapter, s.snap, { ...ctx2, attempt: 2 })).status).toBe('accepted');
    expect(s.api.calls.createCarouselContainer).toBe(1);
    expect(s.steps.rows.filter((x) => x.kind === 'ig_parent_request').map((x) => x.remote_id)).toEqual([marker]);
  });

  it('[R2] 게시 성공 → 게시 단계 기록 실패 → 파일이 바뀌거나 사라져도 재시도·조회는 원격 게시를 찾아 accepted/found(FAILED 로 덮지 않음, 게시 1)', async () => {
    const img = jpeg(1080, 1080);
    const s = setup([img]);
    const real = s.steps.record;
    s.steps.record = async (st) => {
      if (st.kind === 'ig_publish') throw new Error('db down');
      return real(st);
    };
    const ctx = ctxOf(s.steps, s.media);
    await expect(send(s.adapter, s.snap, ctx)).rejects.toThrow(/db down/);
    s.steps.record = real;
    expect(s.api.mediaOf(USER)).toHaveLength(1);
    // 바뀐 파일(같은 길이·메타데이터) → 재시도
    const tampered = metaOnlyMedia([tamper(img)], s.snap);
    expect(await send(s.adapter, s.snap, { ...ctx, media: tampered, attempt: 2 })).toMatchObject({ status: 'accepted', result_kind: 'PUBLISHED' });
    expect(s.steps.rows.map((x) => x.kind)).toEqual(['ig_container', 'ig_publish']);
    expect(s.api.calls.publish).toBe(1);
    // 사라진 파일 → 조회도 found
    const gone: MediaPort = { open: async () => ({ ok: false, code: 'media_missing' }) } as unknown as MediaPort;
    expect(await s.adapter.reconcile(ref, { ...ctx, media: gone, snapshot: s.snap })).toMatchObject({ status: 'found' });
  });

  it('[R2] 게시 단계 기록 실패 뒤 파일이 사라지고 게시 찾기도 실패 → ambiguous(파일 문제 FAILED 아님)', async () => {
    const img = jpeg(1080, 1080);
    const s = setup([img]);
    const real = s.steps.record;
    s.steps.record = async (st) => {
      if (st.kind === 'ig_publish') throw new Error('db down');
      return real(st);
    };
    const ctx = ctxOf(s.steps, s.media);
    await expect(send(s.adapter, s.snap, ctx)).rejects.toThrow(/db down/);
    s.steps.record = real;
    s.api.injectFault({ op: 'findPublishedByContainer', kind: 'server_error' });
    const gone: MediaPort = { open: async () => ({ ok: false, code: 'media_missing' }) } as unknown as MediaPort;
    expect(await send(s.adapter, s.snap, { ...ctx, media: gone, attempt: 2 })).toMatchObject({ status: 'ambiguous', error_code: 'find_server_error' });
    expect(s.api.calls.publish).toBe(1);
  });

  it('[R2] verifiedImageFiles: 파일 전체 읽기 예외 → asset_read_failed, 짧은 반환 → asset_read_failed, 크기 0 → asset_unavailable', async () => {
    const img = jpeg(1080, 1080);
    const a = { id: 'a1', checksum: sha(img), role: 'image', order: 1, mime: 'image/jpeg' };
    const file = (read: (s: number, e: number) => Promise<Uint8Array>, bytes = img.byteLength) => new Map([[1, { bytes, mime: 'image/jpeg', checksum: sha(img), read }]]);
    expect(await verifiedImageFiles([a], file(async () => Promise.reject(new Error('io'))))).toEqual({ ok: false, error_code: 'asset_read_failed:1' });
    expect(await verifiedImageFiles([a], file(async (st, e) => img.slice(st, e - 1)))).toEqual({ ok: false, error_code: 'asset_read_failed:1' });
    expect(await verifiedImageFiles([a], file(async (st, e) => img.slice(st, e), 0))).toEqual({ ok: false, error_code: 'asset_unavailable:1' });
    expect(await verifiedImageFiles([a], new Map())).toEqual({ ok: false, error_code: 'asset_unavailable:1' });
    expect((await verifiedImageFiles([a], file(async (st, e) => img.slice(st, e)))).ok).toBe(true);
  });
});

describe('MockInstagramOAuthProvider(Meta 형)', () => {
  const REDIRECT = 'http://localhost:3000/api/oauth/callback';
  it('PKCE S256 + 자리 표시 scope, 장기 토큰(refresh token 없음) 갱신은 이전 토큰 무효, 철회, 다른 모의 공급자 토큰은 모름', async () => {
    const store = new MockOAuthStore();
    const p = new MockInstagramOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
    const verifier = newCodeVerifier();
    const url = new URL(p.buildAuthorizeUrl({ state: 's1', codeChallenge: codeChallengeS256(verifier), redirectUri: REDIRECT, scopes: p.requiredScopes(), loginHint: USER }));
    expect(url.pathname).toBe('/api/oauth/mock-instagram/authorize');
    expect(url.searchParams.get('scope')).toBe('instagram_basic(mock),instagram_content_publish(mock)');
    const q = (k: string) => url.searchParams.get(k);
    const a = p.authorize({ client_id: q('client_id'), redirect_uri: q('redirect_uri'), response_type: q('response_type'), scope: q('scope'), state: q('state'), code_challenge: q('code_challenge'), code_challenge_method: q('code_challenge_method'), login_hint: q('login_hint') }, new Date());
    expect(a.ok).toBe(true);
    const code = new URL((a as { redirect: string }).redirect).searchParams.get('code')!;
    await expect(p.exchangeCode({ code, codeVerifier: newCodeVerifier(), redirectUri: REDIRECT, now: new Date() })).rejects.toThrow(OAuthProviderError);
    const b = p.authorize({ client_id: q('client_id'), redirect_uri: q('redirect_uri'), response_type: 'code', scope: q('scope'), state: 's2', code_challenge: q('code_challenge'), code_challenge_method: 'S256', login_hint: USER }, new Date());
    const code2 = new URL((b as { redirect: string }).redirect).searchParams.get('code')!;
    const t = await p.exchangeCode({ code: code2, codeVerifier: verifier, redirectUri: REDIRECT, now: new Date() });
    expect(t.accessToken.startsWith('mockig_at_')).toBe(true);
    expect(t.refreshToken).toBeNull();
    expect(mockInstagramTokenCheck(store)(t.accessToken, USER, new Date())).toBe(true);
    expect(await p.accountInfo({ accessToken: t.accessToken, now: new Date() })).toEqual({ externalAccountId: USER, displayName: 'MOCK Instagram 비즈니스 계정' });
    const t2 = await p.refresh({ tokens: { accessToken: t.accessToken, refreshToken: null }, now: new Date() });
    expect(mockInstagramTokenCheck(store)(t.accessToken, USER, new Date())).toBe(false);
    expect(mockInstagramTokenCheck(store)(t2.accessToken, USER, new Date())).toBe(true);
    // Threads 모의 공급자는 Instagram 토큰을 모른다(반대도 마찬가지)
    const thr = new MockThreadsOAuthProvider({ registeredRedirectUri: REDIRECT, appBaseUrl: 'http://localhost:3000', store });
    await expect(thr.accountInfo({ accessToken: t2.accessToken, now: new Date() })).rejects.toMatchObject({ code: 'invalid_token' });
    await p.revoke({ tokens: { accessToken: t2.accessToken, refreshToken: null }, now: new Date() });
    expect(mockInstagramTokenCheck(store)(t2.accessToken, USER, new Date())).toBe(false);
    expect(p.authorize({ client_id: q('client_id'), redirect_uri: q('redirect_uri'), response_type: 'code', scope: 'instagram_manage_everything', state: 's3', code_challenge: q('code_challenge'), code_challenge_method: 'S256', login_hint: USER }, new Date())).toEqual({ ok: false, error: 'scope_not_allowed' });
  });
});
