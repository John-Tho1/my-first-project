/**
 * LIVE-P1(D38 1단계): 실제 Threads 텍스트 게시 어댑터 — 주입한 fixture fetch 만(네트워크 없음). 전역 fetch 는 막고 0회를 확인한다.
 * 응답 모양은 공식 문서 예시(컨테이너·게시 { id }, 컨테이너 상태 { status, id }, 미디어 { id, permalink, text, timestamp }, 목록 { data, paging })를 따른다.
 * 토큰·ID 는 모두 가짜(FAKE_…·숫자).
 */
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adapterIdFor,
  classifyOutcome,
  LeaseLostError,
  LiveChannelNotConfiguredError,
  LivePublishNotReadyError,
  liveThreadsStepId,
  loadConfig,
  threadsTextUnits,
  THREADS_LIVE_TEXT_MAX,
  type AdapterContext,
  type PublishSnapshot,
  type RemoteStep,
  type RemoteStepsPort,
} from '@cs/domain';
import { createChannelAdapterRegistry, LiveCapableAdapterRegistry, MockChannelAdapter, MockChannelAdapterRegistry } from './channel-adapter';
import {
  classifyLivePublishError,
  LiveThreadsApiError,
  LiveThreadsPublishAdapter,
  MAX_RESPONSE_BYTES,
  normalizeThreadsText,
  parseThreadsTimestamp,
  THREADS_GRAPH_BASE,
} from './threads-live-publish';

const USER_ID = '17841400000000001';
const CT = '18000000000000101';
const MEDIA = '18000000000000202';
const TOKEN = 'FAKE_live_publish_token_LIVEP1_tttttttttttttttt';
const SECRET_MSG = 'Invalid OAuth access token FAKE_live_publish_token_LIVEP1_tttttttttttttttt https://graph.threads.net/v1.0/x?access_token=FAKE';
const TEXT = '실제 게시 시험 글입니다. 해외 영업 메모 하나.';
const PERMALINK = `https://www.threads.com/@tester/post/ABC123`;
const NOW = new Date('2026-10-13T12:00:00Z');
const READY = () => ({ ready: true, missing: [] as string[] });

const snapshot = (over: Partial<PublishSnapshot> = {}, posts: string[] = [TEXT], payloadOver: Record<string, unknown> = {}): PublishSnapshot => ({
  item_id: '00000000-0000-4000-8000-000000000001',
  channel: 'threads',
  account: { id: 'acc-live', kind: 'live', platform: 'threads', external_account_id: USER_ID, credential_state: 'linked' },
  payload: { channel: 'threads', provider_account_id: USER_ID, text: { rendered: posts.join('\n\n'), posts }, assets: [], ...payloadOver },
  payload_hash: 'h'.repeat(64),
  visibility: 'public',
  requested_result: 'public_publish',
  scheduled_at_utc: null,
  ...over,
});

/** 메모리 단계 기록(작업 처리기의 remote_steps 창구와 같은 규칙: (종류, 순서) 당 한 행, remote_id 불변·전역 unique, 상태는 앞으로만). */
function memSteps(opts: { failKind?: string } = {}): RemoteStepsPort & { rows: RemoteStep[] } {
  const rows: RemoteStep[] = [];
  const rank: Record<string, number> = { created: 0, finished: 1, error: 2, published: 3 };
  return {
    rows,
    list: async () => rows.map((r) => ({ ...r })),
    record: async (s) => {
      if (opts.failKind === s.kind) throw new Error('db down');
      const ex = rows.find((r) => r.kind === s.kind && r.post_index === s.post_index);
      if (ex && s.createOnly) throw Object.assign(new Error('remote_step_exists'), { code: 'remote_step_exists' });
      const now = NOW.toISOString(); // 작업 처리기의 시계(clock)와 같은 시각
      if (ex) {
        if (ex.remote_id !== s.remote_id) throw new Error('remote_step_conflict');
        if ((rank[s.status] ?? 0) > (rank[ex.status] ?? 0) && ex.status !== 'error') ex.status = s.status;
        return { ...ex };
      }
      if (rows.some((r) => r.remote_id === s.remote_id)) throw new Error('remote_id unique');
      const r: RemoteStep = {
        kind: s.kind,
        post_index: s.post_index,
        remote_id: s.remote_id,
        status: s.status,
        received_bytes: null,
        total_bytes: null,
        resume_count: 0,
        step_index: rows.length,
        created_at: now,
        updated_at: now,
      };
      rows.push(r);
      return { ...r };
    },
  };
}

function ctxOf(steps: RemoteStepsPort, over: Partial<AdapterContext> = {}): AdapterContext {
  return {
    intentKey: 'job-1:1',
    attempt: 1,
    jobId: 'job-1',
    itemId: 'item-1',
    now: NOW,
    signal: new AbortController().signal,
    heartbeat: async () => undefined,
    steps,
    credential: { accessToken: async () => ({ ok: true, token: TOKEN }) },
    snapshot: snapshot(),
    ...over,
  };
}

interface Seen {
  method: string;
  url: URL;
  body: URLSearchParams;
  redirect: string | undefined;
  hasSignal: boolean;
}
type Reply = Response | (() => Response) | Error;
const ok = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const timeoutErr = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

/** 경로별 고정 응답. 키 = 'METHOD /path'(질의 제외). 등록하지 않은 요청은 시험 실패. */
function fixtureFetch(routes: Record<string, Reply | Reply[]>) {
  const seen: Seen[] = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    seen.push({
      method: init?.method ?? 'GET',
      url,
      body: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
      redirect: init?.redirect,
      hasSignal: !!init?.signal,
    });
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    const q = queues.get(key);
    if (!q || !q.length) throw new Error(`fixture 없음: ${key}`);
    const r = q.length > 1 ? q.shift()! : q[0]!;
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r;
  });
  return { fetch, seen };
}

const P = {
  create: `POST /v1.0/${USER_ID}/threads`,
  publish: `POST /v1.0/${USER_ID}/threads_publish`,
  status: `GET /v1.0/${CT}`,
  read: `GET /v1.0/${MEDIA}`,
  list: `GET /v1.0/${USER_ID}/threads`,
};

const happyRoutes = (): Record<string, Reply | Reply[]> => ({
  [P.create]: ok({ id: CT }),
  [P.status]: ok({ status: 'FINISHED', id: CT }),
  [P.publish]: ok({ id: MEDIA }),
  [P.read]: ok({ id: MEDIA, permalink: PERMALINK, text: TEXT, timestamp: '2026-10-13T12:00:05+0000', media_type: 'TEXT_POST' }),
});

const adapterWith = (routes: Record<string, Reply | Reply[]>, over: { gate?: () => { ready: boolean; missing: string[] }; pollBudget?: number } = {}) => {
  const f = fixtureFetch(routes);
  const a = new LiveThreadsPublishAdapter({ gate: over.gate ?? READY, fetch: f.fetch, pollBudget: over.pollBudget ?? 2, pollIntervalMs: 0 });
  return { a, ...f };
};

let globalFetchCalls = 0;
beforeEach(() => {
  globalFetchCalls = 0;
  vi.stubGlobal('fetch', async () => {
    globalFetchCalls++;
    throw new Error('network forbidden');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(globalFetchCalls).toBe(0);
});

describe('글자 수(threadsTextUnits — 공식: 500자, 이모지 = UTF-8 바이트)', () => {
  it('한국어·영문은 글자당 1, 이모지는 UTF-8 바이트 수(보수적)', () => {
    expect(threadsTextUnits('가나다abc')).toBe(6);
    expect(threadsTextUnits('😀')).toBe(4);
    expect(threadsTextUnits('👍🏽')).toBe(8); // 엄지 4 + 피부색 4
    expect(threadsTextUnits('❤️')).toBe(3 + 3); // U+2764(Extended_Pictographic, 3바이트) + 변형 선택자(3바이트)
    expect(threadsTextUnits('가'.repeat(500))).toBe(THREADS_LIVE_TEXT_MAX);
  });
});

describe('validate(실제 Threads 텍스트만)', () => {
  const a = new LiveThreadsPublishAdapter({ gate: READY });
  it.each<[string, PublishSnapshot, string]>([
    ['모의 계정', snapshot({ account: { id: 'm', kind: 'mock', platform: 'threads', external_account_id: 'mock:threads:x', credential_state: 'linked' } }), 'not_live_account'],
    ['다른 채널', snapshot({ channel: 'youtube' }), 'channel_not_supported'],
    ['묶이지 않은 계정', snapshot({ account: { id: 'a', kind: 'live', platform: 'threads', external_account_id: 'pending:abc', credential_state: 'linked' } }), 'account_not_bound'],
    ['승인 스냅샷의 계정과 다름', snapshot({}, [TEXT], { provider_account_id: '17841400000000999' }), 'account_mismatch'],
    ['mock_publish', snapshot({ requested_result: 'mock_publish' }), 'requested_result_not_supported'],
    ['upload_private', snapshot({ requested_result: 'upload_private' }), 'requested_result_not_supported'],
    ['비공개', snapshot({ visibility: 'private' }), 'visibility_not_supported'],
    ['첨부', snapshot({}, [TEXT], { assets: [{ id: 'x' }] }), 'media_not_supported_live'],
    ['이어지는 글', snapshot({}, ['하나', '둘']), 'thread_not_supported_live'],
    ['빈 글', snapshot({}, ['   ']), 'text_empty'],
    ['501자', snapshot({}, ['가'.repeat(501)]), 'text_too_long'],
    ['이모지로 500 초과', snapshot({}, ['가'.repeat(497) + '😀']), 'text_too_long'],
  ])('%s → %s', (_, snap, code) => {
    expect(a.validate(snap)).toEqual({ ok: false, error_code: code });
  });
  it('정상(500자 정확히) → ok, capabilities: 실제(mock=false)·텍스트 1개·공식 한도(확인일 2026-10-13)', () => {
    expect(a.validate(snapshot({}, ['가'.repeat(500)]))).toEqual({ ok: true });
    const caps = a.capabilities(snapshot().account);
    expect(caps).toMatchObject({ mock: false, read: true, cancel: false, adapter: 'live_threads', media: false });
    expect(caps.text).toMatchObject({ max_post_chars: 500, max_posts: 1, checked_at: '2026-10-13', api_version: 'v1.0' });
    expect(caps.rate_limit).toMatchObject({ max_units: 250, window_sec: 86400, checked_at: '2026-10-13' });
  });
});

describe('submit 성공: 컨테이너 → 상태 FINISHED → 게시 시도 표식 → 게시 → 읽기 확인', () => {
  it('요청 모양(POST 는 form 본문에 토큰, GET 은 질의, 호스트 graph.threads.net, redirect error), 단계 순서, VERIFIED 결과', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const steps = memSteps();
    const c = ctxOf(steps);
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toEqual({
      status: 'accepted',
      result_kind: 'PUBLISHED',
      remote_visibility: 'unknown',
      external_id: `threads:${MEDIA}`,
      permalink: PERMALINK,
      verified: true,
    });
    expect(classifyOutcome(r).event).toBe('confirmed');
    expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([P.create, P.status, P.publish, P.read]);
    for (const s of seen) {
      expect(s.url.origin).toBe('https://graph.threads.net');
      expect(s.redirect).toBe('error');
      expect(s.hasSignal).toBe(true);
    }
    // 컨테이너: media_type=TEXT·text·토큰(본문), URL 질의에 토큰 없음. auto_publish_text·reply_to_id 를 보내지 않는다.
    expect(Object.fromEntries(seen[0]!.body)).toEqual({ media_type: 'TEXT', text: TEXT, access_token: TOKEN });
    expect(seen[0]!.url.search).toBe('');
    expect(Object.fromEntries(seen[2]!.body)).toEqual({ creation_id: CT, access_token: TOKEN });
    expect(seen[2]!.url.search).toBe('');
    expect(seen[1]!.url.searchParams.get('fields')).toBe('status,error_message');
    expect(seen[3]!.url.searchParams.get('fields')).toBe('id,permalink,text,timestamp,media_type');
    expect(steps.rows.map((s) => `${s.kind}:${s.status}:${s.remote_id}`)).toEqual([
      `container:finished:threads:ct:${CT}`,
      `publish_attempt:created:threads:pa:${CT}`,
      `publish:published:threads:post:${MEDIA}`,
    ]);
    expect(THREADS_GRAPH_BASE).toBe('https://graph.threads.net/v1.0');
  });

  it('이미 게시 기록이 있으면 다시 게시하지 않고 읽기만(재시도·재개)', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const steps = memSteps();
    await steps.record({ kind: 'container', post_index: 0, remote_id: liveThreadsStepId.container(CT), status: 'finished' });
    await steps.record({ kind: 'publish_attempt', post_index: 0, remote_id: liveThreadsStepId.publishAttempt(CT), status: 'created' });
    await steps.record({ kind: 'publish', post_index: 0, remote_id: liveThreadsStepId.publish(MEDIA), status: 'published' });
    const c = ctxOf(steps);
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toMatchObject({ status: 'accepted', external_id: `threads:${MEDIA}`, verified: true });
    expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([P.read]);
  });

  it('읽기 실패 → 게시는 사실(accepted)이지만 미검증·링크 없음 / 허용 밖 링크는 버림', async () => {
    const r1 = adapterWith({ ...happyRoutes(), [P.read]: ok({ error: { message: SECRET_MSG, code: 2, type: 'OAuthException' } }, 500) });
    const s1 = memSteps();
    const c1 = ctxOf(s1);
    expect(await r1.a.submit(await r1.a.prepare(snapshot(), c1), c1)).toEqual({
      status: 'accepted',
      result_kind: 'PUBLISHED',
      remote_visibility: 'unknown',
      external_id: `threads:${MEDIA}`,
      verified: false,
      error_code: 'readback_failed',
      provider_diag: { op: 'read', http_status: 500, code: 2, error_type: 'OAuthException' }, // LIVEP1-DIAG: 허용 목록 진단(문구 없음)
    });
    const r2 = adapterWith({ ...happyRoutes(), [P.read]: ok({ id: MEDIA, permalink: 'https://evil.example/post/1', text: TEXT }) });
    const s2 = memSteps();
    const c2 = ctxOf(s2);
    const out = await r2.a.submit(await r2.a.prepare(snapshot(), c2), c2);
    expect(out.permalink).toBeUndefined();
    expect(out.verified).toBe(false);
    const r3 = adapterWith({ ...happyRoutes(), [P.read]: ok({ id: MEDIA, permalink: PERMALINK, text: '다른 글' }) });
    const s3 = memSteps();
    const c3 = ctxOf(s3);
    expect((await r3.a.submit(await r3.a.prepare(snapshot(), c3), c3)).verified).toBe(false);
  });
});

describe('컨테이너 생성 실패(게시물 없음 — 게시 시도 없음)', () => {
  it.each<[string, Reply, Record<string, unknown>]>([
    ['400 코드 100(형식)', ok({ error: { message: SECRET_MSG, type: 'OAuthException', code: 100 } }, 400), { status: 'rejected', retry_class: 'permanent', error_code: 'container_invalid_parameter' }],
    ['401/190(토큰 무효)', ok({ error: { message: SECRET_MSG, type: 'OAuthException', code: 190 } }, 401), { status: 'rejected', retry_class: 'auth', error_code: 'container_auth_invalid_token' }],
    ['403 코드 10(권한)', ok({ error: { message: SECRET_MSG, code: 10 } }, 403), { status: 'rejected', retry_class: 'permanent', error_code: 'container_permission_denied' }],
    ['429(Retry-After 120)', ok({ error: { message: SECRET_MSG, code: 4 } }, 429, { 'retry-after': '120' }), { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'container_rate_limited', retry_after_sec: 120 }],
    ['503', ok({ error: { message: SECRET_MSG, code: 2 } }, 503), { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'container_server_error' }],
    ['시간 초과', timeoutErr(), { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'container_timeout' }],
    ['전송 실패(리다이렉트 거부 포함)', new TypeError('fetch failed: redirect mode is set to error'), { status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'container_network' }],
    ['302 응답', () => new Response('', { status: 302, headers: { location: 'https://evil.example/' } }), { status: 'rejected', retry_class: 'transient_no_side_effect' }],
    ['2xx 인데 id 없음', ok({ foo: 1 }), { status: 'rejected', retry_class: 'transient_no_side_effect' }],
    ['400 모르는 코드', ok({ error: { message: SECRET_MSG, code: 99999 } }, 400), { status: 'rejected', retry_class: 'permanent', error_code: 'container_rejected' }],
  ])('%s', async (_, reply, expected) => {
    const { a, seen } = adapterWith({ [P.create]: reply });
    const steps = memSteps();
    const c = ctxOf(steps);
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toMatchObject(expected);
    expect(steps.rows).toEqual([]);
    expect(seen.every((s) => s.url.pathname !== `/v1.0/${USER_ID}/threads_publish`)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain('graph.threads.net');
  });
});

describe('컨테이너 상태', () => {
  it('IN_PROGRESS(조회 예산 넘음) → processing, 조회 → FINISHED·게시 시도 없음 → resumable, 다음 시도는 같은 컨테이너로 게시(새 컨테이너 없음)', async () => {
    const { a, seen } = adapterWith({
      ...happyRoutes(),
      [P.status]: [ok({ status: 'IN_PROGRESS', id: CT }), ok({ status: 'IN_PROGRESS', id: CT }), ok({ status: 'FINISHED', id: CT })],
    });
    const steps = memSteps();
    const c = ctxOf(steps);
    const r1 = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r1).toEqual({ status: 'processing', error_code: 'container_in_progress' });
    expect(steps.rows.map((s) => `${s.kind}:${s.status}`)).toEqual(['container:created']);
    const rc = await a.reconcile({ platform: 'threads', intent_key: 'job-1:1', external_id: null, provider_request_id: null }, c);
    expect(rc).toEqual({ status: 'resumable', published_parts: 0, error_code: 'container_not_published' });
    const r2 = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r2).toMatchObject({ status: 'accepted', external_id: `threads:${MEDIA}` });
    expect(seen.filter((s) => `${s.method} ${s.url.pathname}` === P.create)).toHaveLength(1);
    expect(seen.filter((s) => `${s.method} ${s.url.pathname}` === P.publish)).toHaveLength(1);
  });

  it('ERROR·EXPIRED(게시 시도 전) → 확정 실패(게시물 없음), 단계 error, 조회도 failed(새 컨테이너 없음)', async () => {
    for (const st of ['ERROR', 'EXPIRED'] as const) {
      const { a, seen } = adapterWith({ [P.create]: ok({ id: CT }), [P.status]: ok({ status: st, id: CT, error_message: 'UNKNOWN' }) });
      const steps = memSteps();
      const c = ctxOf(steps);
      const r = await a.submit(await a.prepare(snapshot(), c), c);
      expect(r).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: st === 'ERROR' ? 'container_error' : 'container_expired' });
      expect(steps.rows.map((s) => `${s.kind}:${s.status}`)).toEqual(['container:error']);
      expect(await a.reconcile({ platform: 'threads', intent_key: 'k', external_id: null, provider_request_id: null }, c)).toEqual({ status: 'failed', error_code: 'container_error' });
      expect(seen.some((s) => s.url.pathname.endsWith('threads_publish'))).toBe(false);
    }
  });

  it('상태 읽기 실패 → 조회로(ambiguous, 게시 시도 없음), 401 → auth', async () => {
    const r1 = adapterWith({ [P.create]: ok({ id: CT }), [P.status]: timeoutErr() });
    const s1 = memSteps();
    const c1 = ctxOf(s1);
    expect(await r1.a.submit(await r1.a.prepare(snapshot(), c1), c1)).toMatchObject({ status: 'ambiguous', error_code: 'container_status_unreadable' });
    expect(s1.rows.map((s) => s.kind)).toEqual(['container']);
    const r2 = adapterWith({ [P.create]: ok({ id: CT }), [P.status]: ok({ error: { code: 190, message: SECRET_MSG } }, 401) });
    const s2 = memSteps();
    const c2 = ctxOf(s2);
    expect(await r2.a.submit(await r2.a.prepare(snapshot(), c2), c2)).toMatchObject({ status: 'rejected', retry_class: 'auth' });
  });
});

describe('게시(threads_publish) 중·뒤 결과 불명 — 다시 게시하지 않고 목록 대조', () => {
  const listBody = (items: Array<Record<string, unknown>>) => ok({ data: items, paging: { cursors: { before: 'a', after: 'b' } } });

  it.each<[string, Reply, string]>([
    ['시간 초과', timeoutErr(), 'publish_timeout'],
    ['전송 실패', new TypeError('fetch failed'), 'publish_network'],
    ['503', ok({ error: { code: 2, message: SECRET_MSG } }, 503), 'publish_server_error'],
    ['429(쓰기 — 처리 여부 모름)', ok({ error: { code: 4, message: SECRET_MSG } }, 429), 'publish_rate_limited'],
    ['2xx 인데 id 없음', ok({ success: true }), 'publish_unknown_error'],
    ['400 모르는 코드', ok({ error: { code: 12345, message: SECRET_MSG } }, 400), 'publish_unknown_error'],
  ])('%s → ambiguous(transient_unknown_side_effect), 게시 시도 표식만 남음', async (_, reply, code) => {
    const { a } = adapterWith({ ...happyRoutes(), [P.publish]: reply });
    const steps = memSteps();
    const c = ctxOf(steps);
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    // LIVEP1-DIAG: 진단(provider_diag)은 따로 확인하고 나머지는 정확히 같아야 한다
    const { provider_diag: diag, ...rest } = r;
    expect(rest).toEqual({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: code });
    expect(diag === undefined || diag.op === 'publish').toBe(true); // 2xx 인데 id 없음은 상태를 모르는 응답이라 진단 없음
    expect(classifyOutcome(r).event).toBe('ambiguous');
    expect(steps.rows.map((s) => `${s.kind}:${s.status}`)).toEqual(['container:finished', 'publish_attempt:created']);
  });

  it('확정 거절: 400 코드 100 → permanent, 190 → auth(표식은 남아 이 컨테이너로는 다시 게시하지 않음)', async () => {
    const r1 = adapterWith({ ...happyRoutes(), [P.publish]: ok({ error: { code: 100, message: SECRET_MSG } }, 400) });
    const s1 = memSteps();
    const c1 = ctxOf(s1);
    expect(await r1.a.submit(await r1.a.prepare(snapshot(), c1), c1)).toMatchObject({ status: 'rejected', retry_class: 'permanent', error_code: 'publish_invalid_parameter' });
    const r2 = adapterWith({ ...happyRoutes(), [P.publish]: ok({ error: { code: 190, message: SECRET_MSG } }, 400) });
    const s2 = memSteps();
    const c2 = ctxOf(s2);
    expect(await r2.a.submit(await r2.a.prepare(snapshot(), c2), c2)).toMatchObject({ status: 'rejected', retry_class: 'auth' });
    // 재시도(새 시도)가 와도 게시하지 않는다
    const before = r2.seen.length;
    expect(await r2.a.submit(await r2.a.prepare(snapshot(), c2), c2)).toEqual({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'publish_attempt_unresolved' });
    expect(r2.seen.length).toBe(before);
  });

  it('게시 시도 표식이 있으면 submit 은 원격 호출 0(재게시 없음)', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const steps = memSteps();
    await steps.record({ kind: 'container', post_index: 0, remote_id: liveThreadsStepId.container(CT), status: 'finished' });
    await steps.record({ kind: 'publish_attempt', post_index: 0, remote_id: liveThreadsStepId.publishAttempt(CT), status: 'created' });
    const c = ctxOf(steps);
    expect(await a.submit(await a.prepare(snapshot(), c), c)).toEqual({ status: 'ambiguous', retry_class: 'transient_unknown_side_effect', error_code: 'publish_attempt_unresolved' });
    expect(seen).toHaveLength(0);
  });

  // FIX-LIVEP1(Codex P0 :504): 본문·시각만 맞는 글은 이 작업의 게시물이라는 증거가 아니다 — 게시 단계·외부 ID·VERIFIED 를 절대 만들지 않고
  // UNKNOWN 을 유지한다. 목록이 끝까지 왔고 정확히 하나일 때만 "확인 후보"(미확인)로 돌려준다.
  const noProof = (rc: Record<string, unknown>, steps: { rows: RemoteStep[] }) => {
    expect(rc.status).toBe('unknown');
    expect(rc).not.toHaveProperty('external_id');
    expect(rc).not.toHaveProperty('verified');
    expect(rc).not.toHaveProperty('permalink');
    expect(steps.rows.some((s) => s.kind === 'publish')).toBe(false);
  };
  const reconcileAfterTimeout = async (items: Array<Record<string, unknown>>) => {
    const fx = adapterWith({ ...happyRoutes(), [P.publish]: timeoutErr(), [P.list]: listBody(items) });
    const steps = memSteps();
    const c = ctxOf(steps);
    await fx.a.submit(await fx.a.prepare(snapshot(), c), c);
    const rc = await fx.a.reconcile({ platform: 'threads', intent_key: 'job-1:1', external_id: null, provider_request_id: null }, ctxOf(steps, { now: new Date(NOW.getTime() + 60_000) }));
    return { rc: rc as unknown as Record<string, unknown>, steps, seen: fx.seen };
  };

  it('조회: 시도 뒤 같은 본문 정확히 1개(목록 끝까지) → unknown + 확인 후보만(게시 단계·결과·VERIFIED 없음, 재게시 없음)', async () => {
    const { rc, steps, seen } = await reconcileAfterTimeout([
      { id: '18000000000000999', text: '다른 글', timestamp: '2026-10-13T12:00:01+0000', permalink: PERMALINK },
      { id: MEDIA, text: `  ${TEXT}\r\n`, timestamp: '2026-10-13T12:00:03+0000', permalink: PERMALINK },
    ]);
    noProof(rc, steps);
    expect(rc).toEqual({ status: 'unknown', error_code: 'publish_unconfirmed_candidate', candidate: { external_id: `threads:${MEDIA}`, permalink: PERMALINK } });
    const listReq = seen.find((s) => s.method === 'GET' && s.url.pathname === `/v1.0/${USER_ID}/threads`)!;
    expect(listReq.url.searchParams.get('fields')).toBe('id,permalink,text,timestamp,media_type');
    expect(listReq.url.searchParams.get('limit')).toBe('25');
    expect(seen.filter((s) => s.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });

  it('Codex 재현: 시도 5분 전에 손으로 올린 같은 글 하나만 있음 → 확정 아님(후보도 아님 — 시도 전 글)', async () => {
    const { rc, steps } = await reconcileAfterTimeout([{ id: '18000000000000555', text: TEXT, timestamp: '2026-10-13T11:55:00+0000', permalink: PERMALINK }]);
    noProof(rc, steps);
    expect(rc).toEqual({ status: 'unknown', error_code: 'publish_unconfirmed_no_candidate' });
  });

  it('Codex 재현: 첫 25개 안에 하나 + 다음 쪽이 있을 수 있음(받은 수 = limit) → 후보 하나라고 말하지 않음', async () => {
    const filler = Array.from({ length: 24 }, (_, k) => ({ id: `180000000001${String(k).padStart(5, '0')}`, text: `다른 글 ${k}`, timestamp: '2026-10-13T12:00:01+0000' }));
    const { rc, steps } = await reconcileAfterTimeout([{ id: MEDIA, text: TEXT, timestamp: '2026-10-13T12:00:03+0000', permalink: PERMALINK }, ...filler]);
    noProof(rc, steps);
    expect(rc).toEqual({ status: 'unknown', error_code: 'publish_unconfirmed_list_incomplete' });
  });

  // FIX2-LIVEP1(Codex P2 :536): 후보 창은 게시 시도 표식 시각(created_at = NOW) ±2분에 고정 — 재확인이 늦어져도 넓어지지 않는다.
  const reconcileLate = async (body: Record<string, unknown>, nowOffsetMs: number) => {
    const fx = adapterWith({ ...happyRoutes(), [P.publish]: timeoutErr(), [P.list]: ok(body) });
    const steps = memSteps();
    const c = ctxOf(steps);
    await fx.a.submit(await fx.a.prepare(snapshot(), c), c);
    expect(steps.rows.find((s) => s.kind === 'publish_attempt')!.created_at).toBe(NOW.toISOString());
    const rc = await fx.a.reconcile({ platform: 'threads', intent_key: 'job-1:1', external_id: null, provider_request_id: null }, ctxOf(steps, { now: new Date(NOW.getTime() + nowOffsetMs) }));
    return { rc: rc as unknown as Record<string, unknown>, steps };
  };
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString().replace('Z', '+0000');
  const one = (ts: string) => ({ data: [{ id: MEDIA, text: TEXT, timestamp: ts, permalink: PERMALINK }] });
  const MIN2 = 2 * 60_000;

  it('Codex 재현(FIX2): 60분 뒤 재확인, 같은 글이 시도 +50분에 올라옴 → 후보 아님(창이 재확인 시각으로 넓어지지 않음)', async () => {
    const { rc, steps } = await reconcileLate(one(at(50 * 60_000)), 60 * 60_000);
    noProof(rc, steps);
    expect(rc).toEqual({ status: 'unknown', error_code: 'publish_unconfirmed_no_candidate' });
  });

  it.each<[string, number, boolean]>([
    ['정확히 시도 +2분(경계 포함)', MIN2, true],
    ['정확히 시도 −2분(경계 포함)', -MIN2, true],
    ['시도 +2분 +1ms(밖)', MIN2 + 1, false],
    ['시도 −2분 −1ms(밖)', -MIN2 - 1, false],
  ])('후보 창 경계(60분 뒤 재확인): %s → 후보 %s', async (_, offset, isCandidate) => {
    const { rc, steps } = await reconcileLate(one(at(offset)), 60 * 60_000);
    noProof(rc, steps);
    expect(rc).toEqual(
      isCandidate
        ? { status: 'unknown', error_code: 'publish_unconfirmed_candidate', candidate: { external_id: `threads:${MEDIA}`, permalink: PERMALINK } }
        : { status: 'unknown', error_code: 'publish_unconfirmed_no_candidate' },
    );
  });

  it('Codex 놓친 케이스(FIX2): 받은 수 < limit 이어도 paging.next 가 있으면 목록 불완전 → 후보 없음', async () => {
    const { rc, steps } = await reconcileLate({ ...one(at(1000)), paging: { cursors: { before: 'a', after: 'b' }, next: 'https://graph.threads.net/v1.0/x/threads?after=b' } }, 60_000);
    noProof(rc, steps);
    expect(rc).toEqual({ status: 'unknown', error_code: 'publish_unconfirmed_list_incomplete' });
    // next 없이 cursors 만 있으면(문서 예시 모양) 받은 수 < limit 이면 완전한 목록으로 본다
    const ok2 = await reconcileLate({ ...one(at(1000)), paging: { cursors: { before: 'a', after: 'b' } } }, 60_000);
    expect(ok2.rc.error_code).toBe('publish_unconfirmed_candidate');
  });

  it.each<[string, Array<Record<string, unknown>>, string]>([
    ['맞는 글 없음', [{ id: '18000000000000999', text: '다른 글', timestamp: '2026-10-13T12:00:01+0000' }], 'publish_unconfirmed_no_candidate'],
    [
      '같은 본문 2개(구분 불가)',
      [
        { id: '18000000000000901', text: TEXT, timestamp: '2026-10-13T12:00:01+0000' },
        { id: '18000000000000902', text: TEXT, timestamp: '2026-10-13T12:00:02+0000' },
      ],
      'publish_unconfirmed_candidates_ambiguous',
    ],
    ['시각이 창 밖(오래됨)', [{ id: '18000000000000901', text: TEXT, timestamp: '2026-10-01T00:00:00+0000' }], 'publish_unconfirmed_no_candidate'],
    ['시각 형식 이상', [{ id: '18000000000000901', text: TEXT, timestamp: 'yesterday' }], 'publish_unconfirmed_no_candidate'],
  ])('조회: %s → unknown(%s) — 재게시 없음', async (_, items, code) => {
    const { a, seen } = adapterWith({ ...happyRoutes(), [P.publish]: timeoutErr(), [P.list]: listBody(items) });
    const steps = memSteps();
    const c = ctxOf(steps);
    await a.submit(await a.prepare(snapshot(), c), c);
    const rc = await a.reconcile({ platform: 'threads', intent_key: 'job-1:1', external_id: null, provider_request_id: null }, ctxOf(steps, { now: new Date(NOW.getTime() + 60_000) }));
    expect(rc).toEqual({ status: 'unknown', error_code: code });
    expect(steps.rows.some((s) => s.kind === 'publish')).toBe(false);
    expect(seen.filter((s) => s.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });

  it('조회: 목록 읽기 실패 → unknown, 단계 없음 → not_found(게시물 없음 확실), 게이트 닫힘 → 네트워크 없이 unknown', async () => {
    const { a, seen } = adapterWith({ ...happyRoutes(), [P.publish]: timeoutErr(), [P.list]: timeoutErr() });
    const steps = memSteps();
    const c = ctxOf(steps);
    await a.submit(await a.prepare(snapshot(), c), c);
    expect(await a.reconcile({ platform: 'threads', intent_key: 'k', external_id: null, provider_request_id: null }, c)).toEqual({ status: 'unknown', error_code: 'list_unreadable', provider_diag: { op: 'list', transport: 'timeout' } });
    expect(await a.reconcile({ platform: 'threads', intent_key: 'k', external_id: null, provider_request_id: null }, ctxOf(memSteps()))).toEqual({ status: 'not_found', error_code: 'no_remote_steps' });
    const closed = new LiveThreadsPublishAdapter({ gate: () => ({ ready: false, missing: ['PUBLISH_LIVE_APPROVAL_REF'] }), fetch: vi.fn() });
    const n = seen.length;
    expect(await closed.reconcile({ platform: 'threads', intent_key: 'k', external_id: null, provider_request_id: null }, c)).toEqual({ status: 'unknown', error_code: 'live_publish_not_ready' });
    expect(seen.length).toBe(n);
  });

  it('게시 성공 뒤 게시 기록 실패(DB) → 예외(작업 처리기 = 결과 불명) — 다음 submit 은 재게시 없음', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const steps = memSteps({ failKind: 'publish' });
    const c = ctxOf(steps);
    await expect(a.submit(await a.prepare(snapshot(), c), c)).rejects.toThrow('db down');
    const again = await a.submit(await a.prepare(snapshot(), c), c);
    expect(again).toMatchObject({ status: 'ambiguous', error_code: 'publish_attempt_unresolved' });
    expect(seen.filter((s) => s.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
  });

  it('게시 시도 표식 기록 실패 → 게시하지 않는다(예외 — 조회가 컨테이너 FINISHED·표식 없음 → resumable)', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const steps = memSteps({ failKind: 'publish_attempt' });
    const c = ctxOf(steps);
    await expect(a.submit(await a.prepare(snapshot(), c), c)).rejects.toThrow('db down');
    expect(seen.some((s) => s.url.pathname.endsWith('threads_publish'))).toBe(false);
  });
});

describe('게이트·연결 정보·lease', () => {
  it('실제 게시 환경 조건이 없으면 submit 은 원격 호출 0, auth(live_publish_not_ready — BLOCKED)', async () => {
    const { a, seen } = adapterWith(happyRoutes(), { gate: () => ({ ready: false, missing: ['PUBLISH_MODE=enabled'] }) });
    const c = ctxOf(memSteps());
    expect(await a.submit(await a.prepare(snapshot(), c), c)).toEqual({ status: 'rejected', retry_class: 'auth', error_code: 'live_publish_not_ready' });
    expect(seen).toHaveLength(0);
  });
  it('연결 정보를 쓸 수 없으면 원격 호출 0, auth(코드만)', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const c = ctxOf(memSteps(), { credential: { accessToken: async () => ({ ok: false, code: 'credential_expired' }) } });
    expect(await a.submit(await a.prepare(snapshot(), c), c)).toEqual({ status: 'rejected', retry_class: 'auth', error_code: 'credential_expired' });
    expect(seen).toHaveLength(0);
  });
  it('lease 를 잃으면(heartbeat 실패) 컨테이너도 만들지 않는다', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const c = ctxOf(memSteps(), {
      heartbeat: async () => {
        throw new LeaseLostError();
      },
    });
    await expect(a.submit(await a.prepare(snapshot(), c), c)).rejects.toBeInstanceOf(LeaseLostError);
    expect(seen).toHaveLength(0);
  });
  it('rateUnits: 게시 시도 표식이 있으면 새 단위 0', () => {
    const a = new LiveThreadsPublishAdapter({ gate: READY });
    expect(a.rateUnits(snapshot())).toBe(1);
    expect(a.rateUnitsRemaining(snapshot(), [])).toBe(1);
    expect(a.rateUnitsRemaining(snapshot(), [{ kind: 'publish_attempt' } as RemoteStep])).toBe(0);
    expect(a.rateStepKinds).toEqual(['publish_attempt']);
  });
});

describe('비밀 위생: 토큰·URL·공급자 문구가 결과·오류·로그에 없다', () => {
  it('실패 응답 본문·전송 오류 메시지에 토큰을 넣어도 결과·예외·console 에 없다', async () => {
    const logs: string[] = [];
    const spies = (['log', 'error', 'warn', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...args) => void logs.push(args.map(String).join(' '))));
    const outs: unknown[] = [];
    for (const reply of [
      ok({ error: { message: SECRET_MSG, code: 190 } }, 401),
      ok({ error: { message: SECRET_MSG, code: 2 } }, 503),
      new TypeError(SECRET_MSG),
      Object.assign(new Error(SECRET_MSG), { name: 'TimeoutError', cause: new Error(SECRET_MSG) }),
    ] as Reply[]) {
      for (const route of [P.create, P.publish]) {
        const { a } = adapterWith({ ...happyRoutes(), [route]: reply });
        const c = ctxOf(memSteps());
        const p = await a.prepare(snapshot(), c);
        outs.push(p, await a.submit(p, c));
        outs.push(await a.reconcile({ platform: 'threads', intent_key: 'k', external_id: null, provider_request_id: null }, c).catch((e) => e));
      }
    }
    const e = new LiveThreadsApiError({ op: 'publish', httpStatus: 500, reason: 'http_500' });
    outs.push(e, classifyLivePublishError(e, 'publish'), new LiveThreadsPublishAdapter({ gate: READY }));
    spies.forEach((s) => s.mockRestore());
    const dump = outs.map((o) => `${JSON.stringify(o)} ${inspect(o, { showHidden: true, depth: 6 })} ${o instanceof Error ? `${o.message} ${o.stack}` : ''}`).join('\n');
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain('Invalid OAuth access token');
    expect(dump).not.toContain('access_token=');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});

describe('FIX-LIVEP1: 동시 실행·큰 응답', () => {
  it('같은 작업의 submit 두 개가 겹쳐도 threads_publish 는 한 번(게시 시도 표식 createOnly — 늦은 쪽은 결과 불명, 재게시 없음)', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const steps = memSteps();
    const c1 = ctxOf(steps);
    const c2 = ctxOf(steps, { intentKey: 'job-1:2', attempt: 2 });
    const [r1, r2] = await Promise.all([a.prepare(snapshot(), c1).then((p) => a.submit(p, c1)), a.prepare(snapshot(), c2).then((p) => a.submit(p, c2))]);
    expect(seen.filter((s) => s.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
    expect([r1.status, r2.status].sort()).toEqual(['accepted', 'ambiguous']);
    expect([r1, r2].find((r) => r.status === 'ambiguous')).toMatchObject({ error_code: expect.stringMatching(/^publish_attempt_(exists|unresolved)$/) });
  });

  it('스트리밍 응답이 상한(512 KiB)을 넘으면 읽는 도중 취소(reader.cancel) — 전부 읽지 않음, 컨테이너 생성은 부작용 없는 실패', async () => {
    let pulled = 0;
    let canceled = false;
    const big = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(ctl) {
            pulled++;
            ctl.enqueue(new Uint8Array(64 * 1024).fill(32));
            if (pulled > 1000) ctl.close();
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const { a } = adapterWith({ [P.create]: big });
    const steps = memSteps();
    const c = ctxOf(steps);
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect' });
    expect(canceled).toBe(true);
    expect(pulled).toBeLessThan(20);
    expect(steps.rows).toEqual([]);
    // content-length 가 상한보다 크면 읽지 않고 거부
    const declared = adapterWith({ [P.create]: () => new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } }) });
    const c2 = ctxOf(memSteps());
    expect(await declared.a.submit(await declared.a.prepare(snapshot(), c2), c2)).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect' });
  });
});

describe('FIX2-LIVEP1: 응답 크기 경계·조각 경계의 UTF-8', () => {
  const sized = (n: number) => {
    // 정확히 n 바이트인 JSON({ id, pad }) — 컨테이너 생성 응답
    const head = `{"id":"${CT}","pad":"`;
    const tail = '"}';
    return head + 'x'.repeat(n - head.length - tail.length) + tail;
  };
  const chunked = (bytes: Uint8Array, size: number) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(ctl) {
          for (let i = 0; i < bytes.length; i += size) ctl.enqueue(bytes.slice(i, i + size));
          ctl.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  it('정확히 512 KiB 응답은 받는다, 1바이트 넘으면 거부(조각으로 와도)', async () => {
    const exact = new TextEncoder().encode(sized(MAX_RESPONSE_BYTES));
    expect(exact.length).toBe(512 * 1024);
    const a1 = adapterWith({ ...happyRoutes(), [P.create]: () => chunked(exact, 64 * 1024) });
    const s1 = memSteps();
    const c1 = ctxOf(s1);
    expect(await a1.a.submit(await a1.a.prepare(snapshot(), c1), c1)).toMatchObject({ status: 'accepted', external_id: `threads:${MEDIA}` });
    const over = new TextEncoder().encode(sized(MAX_RESPONSE_BYTES + 1));
    const a2 = adapterWith({ ...happyRoutes(), [P.create]: () => chunked(over, 64 * 1024) });
    const s2 = memSteps();
    const c2 = ctxOf(s2);
    expect(await a2.a.submit(await a2.a.prepare(snapshot(), c2), c2)).toMatchObject({ status: 'rejected', retry_class: 'transient_no_side_effect' });
    expect(s2.rows).toEqual([]);
  });
  it('한국어(3바이트) 문자가 조각 경계에서 잘려 와도 그대로 읽는다(읽기 확인 VERIFIED)', async () => {
    const body = new TextEncoder().encode(JSON.stringify({ id: MEDIA, permalink: PERMALINK, text: TEXT, timestamp: '2026-10-13T12:00:05+0000' }));
    const { a } = adapterWith({ ...happyRoutes(), [P.read]: () => chunked(body, 7) }); // 7바이트 조각 — 3바이트 문자가 여러 번 잘린다
    const c = ctxOf(memSteps());
    expect(await a.submit(await a.prepare(snapshot(), c), c)).toMatchObject({ status: 'accepted', verified: true, permalink: PERMALINK });
  });
});

describe('LIVEP1-DIAG: 실패 진단(허용 목록 숫자·짧은 열거만)', () => {
  const graphErr = (status: number, extra: Record<string, unknown> = {}) =>
    ok({ error: { message: SECRET_MSG, type: 'OAuthException', code: 10, error_subcode: 2207051, is_transient: false, fbtrace_id: 'AbC_123-x', error_user_title: TOKEN, error_user_msg: SECRET_MSG, ...extra } }, status);
  const noSecret = (x: unknown) => {
    const s = JSON.stringify(x) + inspect(x, { depth: 6 });
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain('Invalid OAuth access token');
    expect(s).not.toContain('graph.threads.net');
  };
  it('컨테이너 생성 403(D38 2단계와 같은 판정) → 결과에 진단 — 문구·사용자 문구·토큰은 없음', async () => {
    const { a } = adapterWith({ [P.create]: graphErr(403) });
    const c = ctxOf(memSteps());
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toEqual({
      status: 'rejected',
      retry_class: 'permanent',
      error_code: 'container_permission_denied',
      provider_diag: { op: 'create', http_status: 403, code: 10, error_subcode: 2207051, error_type: 'OAuthException', is_transient: false, fbtrace_id: 'AbC_123-x' },
    });
    noSecret(r);
  });
  it('형식 밖 type·fbtrace 는 버림, 응답 없음(시간 초과)은 transport 만', async () => {
    const r1 = adapterWith({ [P.create]: graphErr(400, { code: 100, type: `Bad type ${TOKEN}`, fbtrace_id: 'has space' }) });
    const c1 = ctxOf(memSteps());
    expect((await r1.a.submit(await r1.a.prepare(snapshot(), c1), c1)).provider_diag).toEqual({ op: 'create', http_status: 400, code: 100, error_subcode: 2207051, is_transient: false });
    const r2 = adapterWith({ [P.create]: timeoutErr() });
    const c2 = ctxOf(memSteps());
    expect((await r2.a.submit(await r2.a.prepare(snapshot(), c2), c2)).provider_diag).toEqual({ op: 'create', transport: 'timeout' });
  });
  it('게시·상태·읽기·목록 실패에도 단계별 진단', async () => {
    const pub = adapterWith({ ...happyRoutes(), [P.publish]: graphErr(500, { code: 2, is_transient: true }) });
    const c1 = ctxOf(memSteps());
    const r1 = await pub.a.submit(await pub.a.prepare(snapshot(), c1), c1);
    expect(r1).toMatchObject({ status: 'ambiguous', provider_diag: { op: 'publish', http_status: 500, code: 2, is_transient: true } });
    const st = adapterWith({ [P.create]: ok({ id: CT }), [P.status]: graphErr(503, { code: 1 }) });
    const c2 = ctxOf(memSteps());
    expect((await st.a.submit(await st.a.prepare(snapshot(), c2), c2)).provider_diag).toMatchObject({ op: 'status', http_status: 503, code: 1 });
    const rd = adapterWith({ ...happyRoutes(), [P.read]: graphErr(404, { code: 100 }) });
    const c3 = ctxOf(memSteps());
    const r3 = await rd.a.submit(await rd.a.prepare(snapshot(), c3), c3);
    expect(r3).toMatchObject({ status: 'accepted', error_code: 'readback_failed', provider_diag: { op: 'read', http_status: 404, code: 100 } });
    const ls = adapterWith({ ...happyRoutes(), [P.publish]: timeoutErr(), [P.list]: graphErr(403) });
    const steps = memSteps();
    const c4 = ctxOf(steps);
    await ls.a.submit(await ls.a.prepare(snapshot(), c4), c4);
    const rc = await ls.a.reconcile({ platform: 'threads', intent_key: 'k', external_id: null, provider_request_id: null }, c4);
    expect(rc).toMatchObject({ status: 'unknown', error_code: 'list_unreadable', provider_diag: { op: 'list', http_status: 403, code: 10 } });
    for (const x of [r1, r3, rc]) noSecret(x);
  });
});

describe('LIVEP1-TIMEOUT: 게시 시도 표식 전 남은 시간 확인', () => {
  it('남은 시간이 게시 호출 시간 제한 + 여유보다 적으면 표식 전에 멈춘다(보내지 않음 — 부작용 없는 일시 오류, threads_publish 0번)', async () => {
    const { a, seen } = adapterWith(happyRoutes());
    const steps = memSteps();
    const c = ctxOf(steps, { deadline: Date.now() + 5_000 }); // 호출당 10초 + 여유 2초보다 적음
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toEqual({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'publish_budget_insufficient' });
    expect(classifyOutcome(r).event).toBe('transient_failure');
    expect(seen.some((s) => s.url.pathname.endsWith('threads_publish'))).toBe(false);
    expect(steps.rows.map((s) => `${s.kind}:${s.status}`)).toEqual(['container:finished']); // 표식 없음 — 다음 시도가 같은 컨테이너로 게시
    // 다음 시도(시간 충분) — 같은 컨테이너로 게시(새 컨테이너 없음)
    const c2 = ctxOf(steps, { deadline: Date.now() + 60_000, intentKey: 'job-1:2', attempt: 2 });
    expect(await a.submit(await a.prepare(snapshot(), c2), c2)).toMatchObject({ status: 'accepted', external_id: `threads:${MEDIA}` });
    expect(seen.filter((s) => s.url.pathname === `/v1.0/${USER_ID}/threads` && s.method === 'POST')).toHaveLength(1);
  });
  it('남은 시간이 충분하거나 마감이 없으면 그대로 게시', async () => {
    for (const deadline of [Date.now() + 60_000, undefined]) {
      const { a, seen } = adapterWith(happyRoutes());
      const c = ctxOf(memSteps(), deadline === undefined ? {} : { deadline });
      expect(await a.submit(await a.prepare(snapshot(), c), c)).toMatchObject({ status: 'accepted' });
      expect(seen.filter((s) => s.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
    }
  });
});

// FIX-LIVEP1-TIMEOUT(Codex review-LIVEP1-TIMEOUT P1 :455): 남은 시간 검사 뒤의 lease 확인(heartbeat)·표식 저장이 게시 호출 몫의 시간을 먹으면
// 게시 뒤 마감 → 결과 불명이 다시 생길 수 있었다. heartbeat 뒤 표식 직전에 다시 보고(게시 호출 + 표식 저장 몫 + 여유), 표식 저장은 몫 안에서만 기다린다.
describe('FIX-LIVEP1-TIMEOUT: lease 확인·표식 저장 지연이 게시 호출 몫을 먹지 않게', () => {
  const PUB_MS = 300; // 시험용 게시 호출 시간 제한(실제 10초)
  const MARKER_MS = 200; // 시험용 표식 저장 몫(실제 LIVE_PUBLISH_MARKER_ALLOWANCE_MS)
  const finishedSteps = () => {
    const s = memSteps();
    s.rows.push({ kind: 'container', post_index: 0, remote_id: liveThreadsStepId.container(CT), status: 'finished', received_bytes: null, total_bytes: null, resume_count: 0, step_index: 0, created_at: NOW.toISOString(), updated_at: NOW.toISOString() });
    return s;
  };
  const adapter = (extra: Record<string, unknown> = {}) => {
    const f = fixtureFetch(happyRoutes());
    const a = new LiveThreadsPublishAdapter({ gate: READY, fetch: f.fetch, pollBudget: 2, pollIntervalMs: 0, timeoutMs: PUB_MS, markerAllowanceMs: MARKER_MS, ...extra } as ConstructorParameters<typeof LiveThreadsPublishAdapter>[0]);
    return { a, ...f };
  };
  const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const publishes = (seen: Seen[]) => seen.filter((s) => s.url.pathname.endsWith('threads_publish')).length;
  // 남은 시간 2800ms: 옛 검사(게시 300 + 여유 2000 = 2300)도 새 검사(300 + 표식 200 + 여유 2000 = 2500)도 처음엔 통과한다.
  const DEADLINE_AHEAD = 2800;

  it('heartbeat(표식 전 lease 확인)가 600ms 걸려 남은 시간이 게시 호출 + 표식 몫 + 여유보다 적어지면 표식 전에 멈춘다 → 다음 시도는 같은 컨테이너로 게시', async () => {
    const { a, seen } = adapter();
    const steps = finishedSteps();
    const c = ctxOf(steps, { deadline: Date.now() + DEADLINE_AHEAD, heartbeat: () => sleepMs(600) });
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toEqual({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'publish_budget_insufficient' });
    expect(classifyOutcome(r).event).toBe('transient_failure');
    expect(publishes(seen)).toBe(0);
    expect(steps.rows.map((s) => `${s.kind}:${s.status}`)).toEqual(['container:finished']); // 표식 없음
    const c2 = ctxOf(steps, { deadline: Date.now() + 60_000, intentKey: 'job-1:2', attempt: 2 });
    expect(await a.submit(await a.prepare(snapshot(), c2), c2)).toMatchObject({ status: 'accepted', external_id: `threads:${MEDIA}` });
    expect(publishes(seen)).toBe(1);
    expect(seen.filter((s) => s.method === 'POST' && s.url.pathname === `/v1.0/${USER_ID}/threads`)).toHaveLength(0); // 새 컨테이너 없음
  });

  it('표식 저장이 몫(200ms)을 넘겨 600ms 뒤에야 끝나면 게시하지 않는다(publish_marker_slow) — 늦게 저장된 표식은 다음 시도를 조회로 돌린다(재게시 없음)', async () => {
    const { a, seen } = adapter();
    const steps = finishedSteps();
    const record = steps.record;
    let markerDone = false;
    const slow: RemoteStepsPort = {
      list: steps.list,
      record: async (s) => {
        if (s.kind === 'publish_attempt') {
          await sleepMs(600);
          const row = await record(s);
          markerDone = true;
          return row;
        }
        return record(s);
      },
    };
    const c = ctxOf(slow, { deadline: Date.now() + DEADLINE_AHEAD });
    const r = await a.submit(await a.prepare(snapshot(), c), c);
    expect(r).toEqual({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'publish_marker_slow' });
    expect(publishes(seen)).toBe(0);
    await sleepMs(700);
    expect(markerDone).toBe(true);
    expect(publishes(seen)).toBe(0); // 표식이 늦게 저장돼도 이 실행은 게시하지 않았다
    // 다음 시도: 표식이 있으므로 같은 컨테이너로 다시 게시하지 않는다(조회·사용자 확인 — 좁힌 보장)
    const c2 = ctxOf(steps, { deadline: Date.now() + 60_000, intentKey: 'job-1:2', attempt: 2 });
    expect(await a.submit(await a.prepare(snapshot(), c2), c2)).toMatchObject({ status: 'ambiguous', error_code: 'publish_attempt_unresolved' });
    expect(publishes(seen)).toBe(0);
  });

  it('표식 저장이 끝나지 않으면(멈춤) 몫이 지나 게시 없이 돌아온다 — 마감까지 기다리지 않음(결과 불명 아님)', async () => {
    const { a, seen } = adapter();
    const steps = finishedSteps();
    const hang: RemoteStepsPort = { list: steps.list, record: (s) => (s.kind === 'publish_attempt' ? new Promise(() => undefined) : steps.record(s)) };
    const c = ctxOf(hang, { deadline: Date.now() + DEADLINE_AHEAD });
    const started = Date.now();
    const r = await Promise.race([a.submit(await a.prepare(snapshot(), c), c), sleepMs(DEADLINE_AHEAD + 500).then(() => 'still_waiting' as const)]);
    expect(r).toEqual({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'publish_marker_slow' });
    expect(Date.now() - started).toBeLessThan(DEADLINE_AHEAD - PUB_MS);
    expect(publishes(seen)).toBe(0);
    expect(steps.rows.map((s) => s.kind)).toEqual(['container']);
  });

  it('표식 저장이 몫 안(50ms)에 끝나면 그대로 게시(표식이 저장된 뒤에만 게시 요청)', async () => {
    const { a, seen } = adapter();
    const steps = finishedSteps();
    let markerAtPublish = false;
    const f = fixtureFetch({
      ...happyRoutes(),
      [P.publish]: () => {
        markerAtPublish = steps.rows.some((s) => s.kind === 'publish_attempt');
        return new Response(JSON.stringify({ id: MEDIA }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const a2 = new LiveThreadsPublishAdapter({ gate: READY, fetch: f.fetch, pollIntervalMs: 0, timeoutMs: PUB_MS, markerAllowanceMs: MARKER_MS } as ConstructorParameters<typeof LiveThreadsPublishAdapter>[0]);
    const quick: RemoteStepsPort = { list: steps.list, record: async (s) => (s.kind === 'publish_attempt' ? (await sleepMs(50), steps.record(s)) : steps.record(s)) };
    const c = ctxOf(quick, { deadline: Date.now() + DEADLINE_AHEAD });
    expect(await a2.submit(await a2.prepare(snapshot(), c), c)).toMatchObject({ status: 'accepted' });
    expect(markerAtPublish).toBe(true);
    expect(f.seen.filter((s) => s.url.pathname.endsWith('threads_publish'))).toHaveLength(1);
    expect(publishes(seen)).toBe(0); // 첫 adapter 는 쓰지 않음
    void a;
  });

  it('표식 저장 실패(예외)는 게시하지 않는다(기존 규칙 그대로 — 예외)', async () => {
    const { a, seen } = adapter();
    const steps = finishedSteps();
    const failing: RemoteStepsPort = { list: steps.list, record: (s) => (s.kind === 'publish_attempt' ? Promise.reject(new Error('db down')) : steps.record(s)) };
    const c = ctxOf(failing, { deadline: Date.now() + DEADLINE_AHEAD });
    await expect(a.submit(await a.prepare(snapshot(), c), c)).rejects.toThrow('db down');
    expect(publishes(seen)).toBe(0);
  });

  it('경계(시계 주입): 남은 시간 = 게시 호출 + 표식 몫 + 여유 정확히 → 게시, 1ms 모자라면 멈춤 · heartbeat 가 시계를 1ms 넘게 밀면 표식 전에 멈춤', async () => {
    const need = PUB_MS + MARKER_MS + 2_000;
    for (const [ahead, hbMs, expectPub] of [
      [need, 0, true],
      [need - 1, 0, false],
      [need + 5, 5, true],
      [need + 5, 6, false],
    ] as const) {
      let t = 1_000_000;
      const { a, seen } = adapter({ nowMs: () => t });
      const c = ctxOf(finishedSteps(), {
        deadline: t + ahead,
        heartbeat: async () => {
          t += hbMs;
        },
      });
      const r = await a.submit(await a.prepare(snapshot(), c), c);
      expect(publishes(seen), `${ahead}/${hbMs}`).toBe(expectPub ? 1 : 0);
      if (!expectPub) expect(r).toEqual({ status: 'rejected', retry_class: 'transient_no_side_effect', error_code: 'publish_budget_insufficient' });
    }
  });
});

describe('보조 함수', () => {
  it('Threads 시각(+0000) 읽기, 본문 정규화', () => {
    expect(parseThreadsTimestamp('2023-10-17T05:42:03+0000')).toBe(Date.parse('2023-10-17T05:42:03Z'));
    expect(parseThreadsTimestamp('2023-10-17T05:42:03+03:00')).toBe(Date.parse('2023-10-17T02:42:03Z'));
    expect(parseThreadsTimestamp('2023-10-17')).toBeNull();
    expect(normalizeThreadsText(' a\r\nb ')).toBe('a\nb');
  });
});

describe('레지스트리(LiveCapableAdapterRegistry — 선택 규칙 adapterIdFor 한 곳)', () => {
  const liveThreads = { kind: 'live' as const, platform: 'threads', credential_state: 'linked' };
  it('실제 Threads(연결함) → 실제 게시 환경 조건이 있을 때만 실제 어댑터, 없으면 LivePublishNotReadyError(빠진 이름)', () => {
    expect(adapterIdFor(liveThreads)).toBe('live_threads');
    const closed = createChannelAdapterRegistry(loadConfig({}));
    expect(() => closed.getAdapterFor(liveThreads)).toThrow(LivePublishNotReadyError);
    try {
      closed.getAdapterFor(liveThreads);
    } catch (e) {
      expect((e as LivePublishNotReadyError).missing).toEqual(['PUBLISH_MODE=enabled', 'PUBLISH_LIVE_APPROVAL_REF', 'PUBLISH_LIVE_MAX_POSTS']);
    }
    for (const env of [
      { PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'D38-2' },
      { PUBLISH_MODE: 'enabled', PUBLISH_LIVE_MAX_POSTS: '1' },
      { PUBLISH_LIVE_APPROVAL_REF: 'D38-2', PUBLISH_LIVE_MAX_POSTS: '1' },
    ]) {
      expect(() => createChannelAdapterRegistry(loadConfig(env)).getAdapterFor(liveThreads)).toThrow(LivePublishNotReadyError);
    }
    const open = createChannelAdapterRegistry(loadConfig({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'D38-2', PUBLISH_LIVE_MAX_POSTS: '1' }));
    expect(open.getAdapterFor(liveThreads)).toBeInstanceOf(LiveThreadsPublishAdapter);
    expect(open.getAdapterById('live_threads')).toBeInstanceOf(LiveThreadsPublishAdapter);
  });
  it('연결 전 Threads·YouTube·Instagram 실제 계정 → LiveChannelNotConfiguredError, 모의 계정은 모의 레지스트리 그대로', () => {
    const open = createChannelAdapterRegistry(loadConfig({ PUBLISH_MODE: 'enabled', PUBLISH_LIVE_APPROVAL_REF: 'D38-2', PUBLISH_LIVE_MAX_POSTS: '1' }));
    expect(() => open.getAdapterFor({ kind: 'live', platform: 'threads', credential_state: 'none' })).toThrow(LiveChannelNotConfiguredError);
    expect(() => open.getAdapterFor({ kind: 'live', platform: 'youtube', credential_state: 'linked' })).toThrow(LiveChannelNotConfiguredError);
    expect(() => open.getAdapterFor({ kind: 'live', platform: 'instagram', credential_state: 'linked' })).toThrow(LiveChannelNotConfiguredError);
    const mockReg = new MockChannelAdapterRegistry(new MockChannelAdapter());
    const reg = new LiveCapableAdapterRegistry(mockReg, new LiveThreadsPublishAdapter({ gate: READY }), READY);
    expect(reg.getAdapterFor({ kind: 'mock', platform: 'threads', credential_state: 'linked' })).toBe(mockReg.threads);
    expect(reg.getAdapterFor({ kind: 'mock', platform: 'blog', credential_state: 'none' })).toBe(mockReg.mock);
    expect(reg.getAdapterById('mock_generic')).toBe(mockReg.mock);
    // 모의 레지스트리만으로는 실제 계정 어댑터가 없다(기존 동작)
    expect(() => mockReg.getAdapterFor(liveThreads)).toThrow(LiveChannelNotConfiguredError);
    expect(mockReg.getAdapterById('live_threads')).toBeNull();
  });
});
