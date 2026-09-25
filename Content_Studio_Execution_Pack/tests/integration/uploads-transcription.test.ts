/**
 * T08(결정 D9·D15): 조각 업로드 세션(A14 이어 올리기)·완료 검사(VERIFIED = 형식 서명·크기·checksum)·모의 전사 job·비용 원장·
 * 취소·전사 수정 버전·소재로 보내기·원음 삭제(410)·만료 정리·owner 격리·live STT 차단·export → 빈 DB 복원.
 * 외부 호출 없음: 전사기는 MockTranscriber(결정적), live 는 어댑터가 없어 항상 거부.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  closeDb,
  commitRestore,
  completeUploadSession,
  createContent,
  createVariantDraft,
  deleteOriginal,
  expireUploadSessions,
  setVariantAssets,
  type WriteHandle,
  createRestorePreview,
  createTestDb,
  ensureOwner,
  exportOwner,
  getDb,
  ownerScope,
  schema,
  seed,
  selectBundleRows,
  uploadStoreFor,
  type Db,
} from '@cs/db';
import { loadConfig, MIB, MOCK_TRANSCRIPT_WARNING, RESTORED_TABLES } from '@cs/domain';
import { LocalStorageAdapter, MockTranscriber } from '@cs/providers';
import { runWorkerTick } from '@cs/worker';
import { GET as assetGET } from '../../apps/web/app/api/assets/[id]/route';
import { POST as transcribePOST } from '../../apps/web/app/api/assets/[id]/transcribe/route';
import { GET as healthGET } from '../../apps/web/app/api/health/route';
import { GET as jobsGET } from '../../apps/web/app/api/transcription-jobs/route';
import { GET as jobGET } from '../../apps/web/app/api/transcription-jobs/[id]/route';
import { POST as cancelPOST } from '../../apps/web/app/api/transcription-jobs/[id]/cancel/route';
import { GET as transcriptGET } from '../../apps/web/app/api/transcripts/[id]/route';
import { POST as toCapturePOST } from '../../apps/web/app/api/transcripts/[id]/to-capture/route';
import { POST as versionsPOST } from '../../apps/web/app/api/transcripts/[id]/versions/route';
import { POST as sessionsPOST } from '../../apps/web/app/api/uploads/sessions/route';
import { DELETE as sessionDELETE, GET as sessionGET } from '../../apps/web/app/api/uploads/sessions/[id]/route';
import { PUT as chunkPUT } from '../../apps/web/app/api/uploads/sessions/[id]/chunks/[index]/route';
import { POST as completePOST } from '../../apps/web/app/api/uploads/sessions/[id]/complete/route';
import { assetGet, BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const B = 'stt-other@example.local';
const CHUNK = 4 * MIB;

let db: Db;
let storageDir: string;
let tmp: string;
let ownerA: string;
let tokenA: string;
let tokenB: string;

const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** 앞부분 서명 + 결정적 채움 바이트(합성 — 실제 음성 아님) */
function media(kind: 'mp3' | 'mp4' | 'png', bytes: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  let x = seed * 2654435761;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  const head =
    kind === 'mp3'
      ? [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]
      : kind === 'mp4'
        ? [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]
        : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  out.set(head, 0);
  return out;
}

const post = (fn: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>, url: string, id: string, body: unknown, token = tokenA) =>
  fn(jsonPost(url, body, cookieHeader(token)), ctx(id));
const bare = (url: string, token: string, method = 'POST') =>
  new Request(`${BASE}${url}`, { method, headers: { accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(token) } });
const get = (url: string, token = tokenA) => new Request(`${BASE}${url}`, { headers: { accept: 'application/json', ...cookieHeader(token) } });

async function createSession(body: Record<string, unknown>, token = tokenA): Promise<Response> {
  return sessionsPOST(jsonPost('/api/uploads/sessions', body, cookieHeader(token)), undefined as never);
}

function putChunk(id: string, index: number | string, bytes: Uint8Array<ArrayBuffer>, token = tokenA, headers: Record<string, string> = {}) {
  const req = new Request(`${BASE}/api/uploads/sessions/${id}/chunks/${index}`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/octet-stream', ...ORIGIN_HEADERS, ...cookieHeader(token), ...headers },
    body: bytes,
  });
  return chunkPUT(req, { params: Promise.resolve({ id, index: String(index) }) });
}

const complete = (id: string, token = tokenA) => completePOST(bare(`/api/uploads/sessions/${id}/complete`, token), ctx(id));

/** 전체 업로드 → { assetId, sessionId } */
async function uploadAll(file: Uint8Array<ArrayBuffer>, mime = 'audio/mpeg', extra: Record<string, unknown> = {}) {
  const s = await (await createSession({ kind: mime.startsWith('audio/') ? 'audio' : 'video', mime, bytes: file.byteLength, chunk_size: CHUNK, ...extra })).json();
  const id = s.session.id as string;
  for (let i = 0; i * CHUNK < file.byteLength; i++) {
    const r = await putChunk(id, i, file.slice(i * CHUNK, (i + 1) * CHUNK));
    expect(r.status).toBe(201);
  }
  const res = await complete(id);
  return { res, sessionId: id };
}

async function tickJobs(n: number) {
  for (let i = 0; i < n; i++) {
    const r = await jobsGET(get('/api/transcription-jobs'), undefined as never);
    expect(r.status).toBe(200);
  }
}

const ledgerOf = async (jobId: string) => (await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.transcriptionJobId, jobId)))[0]!;
const jobOf = async (jobId: string) => (await db.select().from(schema.transcriptionJobs).where(eq(schema.transcriptionJobs.id, jobId)))[0]!;
const n = async (t: typeof schema.transcriptionJobs | typeof schema.usageLedger | typeof schema.transcripts | typeof schema.uploadSessions) =>
  (await db.select({ n: count() }).from(t))[0]!.n;
const uploadsRoot = () => uploadStoreFor(loadConfig()).root;
const filesUnder = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length : 0);

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-t08-it-'));
  storageDir = path.join(tmp, 'assets');
  vi.stubEnv('STORAGE_LOCAL_DIR', storageDir);
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  await ensureOwner(db, B);
  as(A);
  tokenA = await login(A);
  as(B);
  tokenB = await login(B);
  as(A);
});
beforeEach(() => {
  vi.stubEnv('STORAGE_LOCAL_DIR', storageDir);
  as(A);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('업로드 세션 — 한도·조각·이어 올리기(A14)', () => {
  const file = media('mp3', CHUNK + 1000, 7);
  let sid: string;

  it('세션 한도: 형식 415, 크기 413, 종류·조각 크기 400, 로그인 없음 401', async () => {
    expect((await createSession({ kind: 'audio', mime: 'image/png', bytes: 10 })).status).toBe(415);
    expect((await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: 200 * MIB + 1 })).status).toBe(413);
    expect((await createSession({ kind: 'video', mime: 'video/mp4', bytes: 2048 * MIB + 1 })).status).toBe(413);
    expect((await createSession({ kind: 'audio', mime: 'video/mp4', bytes: 10 })).status).toBe(400);
    expect((await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: 10, chunk_size: MIB })).status).toBe(400);
    expect((await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: 0 })).status).toBe(400);
    const anon = await sessionsPOST(jsonPost('/api/uploads/sessions', { kind: 'audio', mime: 'audio/mpeg', bytes: 10 }), undefined as never);
    expect(anon.status).toBe(401);
    expect(await n(schema.uploadSessions)).toBe(0);
  });

  it('생성 201: 조각 4MiB × 2, 24시간 뒤 만료', async () => {
    const before = Date.now();
    const res = await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: file.byteLength, chunk_size: CHUNK });
    expect(res.status).toBe(201);
    const { session } = await res.json();
    expect(session).toMatchObject({ state: 'open', chunk_size: CHUNK, chunk_count: 2, received_bytes: 0, next_index: 0, progress: 0 });
    const exp = Date.parse(session.expires_at);
    expect(exp - before).toBeGreaterThanOrEqual(24 * 3600_000 - 5000);
    expect(exp - before).toBeLessThanOrEqual(24 * 3600_000 + 5000);
    sid = session.id;
  });

  it('조각: 크기·번호 검사 400, 새 조각 201, 같은 내용 재전송 200(멱등), 다른 내용 409, x-chunk-sha256 불일치 400', async () => {
    expect((await putChunk(sid, 0, file.slice(0, 100))).status).toBe(400);
    expect((await putChunk(sid, 2, file.slice(0, 1000))).status).toBe(400);
    expect((await putChunk(sid, 'x' as never, file.slice(0, 10))).status).toBe(400);
    const bad = await putChunk(sid, 0, file.slice(0, CHUNK), tokenA, { 'x-chunk-sha256': 'f'.repeat(64) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('chunk_checksum_mismatch');
    expect(filesUnder(uploadsRoot())).toBe(0);

    const first = await putChunk(sid, 0, file.slice(0, CHUNK), tokenA, { 'x-chunk-sha256': sha(file.slice(0, CHUNK)) });
    expect(first.status).toBe(201);
    expect((await first.json()).session).toMatchObject({ received_bytes: CHUNK, next_index: 1, missing_indexes: [1] });
    const again = await putChunk(sid, 0, file.slice(0, CHUNK));
    expect(again.status).toBe(200);
    expect((await again.json()).duplicate).toBe(true);
    const other = media('mp3', CHUNK, 99);
    const conflict = await putChunk(sid, 0, other);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe('chunk_mismatch');
    // 받은 바이트는 한 번만 센다
    const s = (await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, sid)))[0]!;
    expect(s.receivedBytes).toBe(CHUNK);
  });

  it('끊긴 뒤 이어 올리기: GET 으로 위치를 받고, 빠진 조각이 있으면 완료는 409(세션 그대로)', async () => {
    const g = await sessionGET(get(`/api/uploads/sessions/${sid}`), ctx(sid));
    expect(g.status).toBe(200);
    const { session } = await g.json();
    expect(session).toMatchObject({ state: 'open', next_index: 1, received_chunks: 1, progress: 99 });
    const early = await complete(sid);
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: 'upload_incomplete', next_index: 1, missing_indexes: [1] });
    expect((await putChunk(sid, session.next_index, file.slice(CHUNK))).status).toBe(201);
  });

  it('완료 → asset VERIFIED(형식 서명·크기·checksum), 조각 삭제, 다운로드 동일 바이트, 재완료는 같은 결과', async () => {
    const res = await complete(sid);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset).toMatchObject({
      mime: 'audio/mpeg',
      bytes: file.byteLength,
      checksum: sha(file),
      verification_state: 'VERIFIED',
      verification_scope: 'signature_size_checksum',
      deleted_at: null,
    });
    expect(body.session).toMatchObject({ state: 'verified', asset_id: body.asset.id });
    expect(filesUnder(uploadsRoot())).toBe(0);
    expect((await db.select().from(schema.uploadChunks).where(eq(schema.uploadChunks.sessionId, sid))).length).toBe(0);
    const dl = await assetGET(...assetGet(body.asset.id, tokenA));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('audio/mpeg');
    expect(sha(new Uint8Array(await dl.arrayBuffer()))).toBe(sha(file));
    const again = await complete(sid);
    expect(again.status).toBe(200);
    expect((await again.json()).asset.id).toBe(body.asset.id);
    const late = await putChunk(sid, 1, file.slice(CHUNK));
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe('upload_not_open');
  });

  it('신고 sha256 이 다르면 rejected + 조각 삭제, asset 없음', async () => {
    const f = media('mp3', 5000, 3);
    const assetsBefore = (await db.select({ n: count() }).from(schema.assets))[0]!.n;
    const { res, sessionId } = await uploadAll(f, 'audio/mpeg', { sha256: 'a'.repeat(64) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'upload_rejected', reason: 'checksum_mismatch' });
    const s = (await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, sessionId)))[0]!;
    expect(s).toMatchObject({ state: 'rejected', rejectReason: 'checksum_mismatch', checksumActual: sha(f), assetId: null });
    expect((await db.select().from(schema.uploadChunks).where(eq(schema.uploadChunks.sessionId, sessionId))).length).toBe(0);
    expect(existsSync(path.join(uploadsRoot(), ownerA, sessionId))).toBe(false);
    expect((await db.select({ n: count() }).from(schema.assets))[0]!.n).toBe(assetsBefore);
    expect((await complete(sessionId)).status).toBe(409);
  });

  it('형식: 신고와 서명이 다르면 415 mime_mismatch, 서명이 음성·영상이 아니면 415 unsupported_signature', async () => {
    const m = await uploadAll(media('mp3', 3000, 4), 'video/mp4');
    expect(m.res.status).toBe(415);
    expect((await m.res.json()).reason).toBe('mime_mismatch');
    const p = await uploadAll(media('png', 3000, 5), 'audio/mpeg');
    expect(p.res.status).toBe(415);
    expect((await p.res.json()).reason).toBe('unsupported_signature');
  });

  it('동시 요청: 같은 조각 두 번 → 201 + 200(한 번만 셈), 동시 완료 → asset 하나', async () => {
    const f = media('mp3', 6000, 51);
    const s = await (await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: f.byteLength, chunk_size: CHUNK })).json();
    const id = s.session.id as string;
    const puts = await Promise.all([putChunk(id, 0, f), putChunk(id, 0, f)]);
    expect(puts.map((r) => r.status).sort()).toEqual([200, 201]);
    expect((await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, id)))[0]!.receivedBytes).toBe(f.byteLength);
    const done = await Promise.all([complete(id), complete(id)]);
    const statuses = done.map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    for (const r of done) if (r.status === 409) expect((await r.json()).error).toBe('upload_in_progress');
    expect((await db.select({ n: count() }).from(schema.assets).where(eq(schema.assets.checksum, sha(f))))[0]!.n).toBe(1);
  });

  it('중단(DELETE): open 만, 조각 삭제', async () => {
    const s = await (await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: 3000, chunk_size: CHUNK })).json();
    expect((await putChunk(s.session.id, 0, media('mp3', 3000, 8))).status).toBe(201);
    const del = await sessionDELETE(bare(`/api/uploads/sessions/${s.session.id}`, tokenA, 'DELETE'), ctx(s.session.id));
    expect(del.status).toBe(200);
    expect((await del.json()).session.state).toBe('aborted');
    expect(existsSync(path.join(uploadsRoot(), ownerA, s.session.id))).toBe(false);
    expect((await sessionDELETE(bare(`/api/uploads/sessions/${s.session.id}`, tokenA, 'DELETE'), ctx(s.session.id))).status).toBe(409);
  });

  it('만료: worker tick(24시간 뒤)이 open 세션을 expired 로 바꾸고 조각을 지운다', async () => {
    const s = await (await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: 3000, chunk_size: CHUNK })).json();
    const id = s.session.id as string;
    expect((await putChunk(id, 0, media('mp3', 3000, 9))).status).toBe(201);
    expect(existsSync(path.join(uploadsRoot(), ownerA, id))).toBe(true);
    const early = await runWorkerTick({ config: loadConfig(), db, now: new Date(Date.now() + 3600_000) });
    expect(early.uploadsExpired).toBe(0);
    const tick = await runWorkerTick({ config: loadConfig(), db, now: new Date(Date.now() + 25 * 3600_000) });
    expect(tick.uploadsExpired).toBeGreaterThanOrEqual(1);
    const row = (await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, id)))[0]!;
    expect(row.state).toBe('expired');
    expect(existsSync(path.join(uploadsRoot(), ownerA, id))).toBe(false);
    expect((await db.select().from(schema.uploadChunks).where(eq(schema.uploadChunks.sessionId, id))).length).toBe(0);
    expect((await putChunk(id, 0, media('mp3', 3000, 9))).status).toBe(409);
  });
});

describe('모의 전사 job — 진행·원장·실패·취소', () => {
  let assetId: string;
  let jobId: string;
  let v1: string;

  beforeAll(async () => {
    const { res } = await uploadAll(media('mp3', 40_000, 21));
    expect(res.status).toBe(200);
    assetId = (await res.json()).asset.id;
  });

  it('음성·영상이 아닌 파일 415, 없는 파일 404', async () => {
    const png = media('png', 100, 1);
    const [img] = await db
      .insert(schema.assets)
      .values({ ownerId: ownerA, key: `assets/${ownerA}/00000000-0000-4000-8000-00000000abcd`, mime: 'image/png', bytes: 100, checksum: sha(png), verificationState: 'VERIFIED' })
      .returning();
    expect((await post(transcribePOST, `/api/assets/${img!.id}/transcribe`, img!.id, {})).status).toBe(415);
    const missing = '00000000-0000-4000-8000-00000000ffff';
    expect((await post(transcribePOST, `/api/assets/${missing}/transcribe`, missing, {})).status).toBe(404);
  });

  it('요청 202(queued) + 원장 reserved(전사 job 연결), 진행 중 중복 요청 409', async () => {
    const res = await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, { duration_seconds: 120 });
    expect(res.status).toBe(202);
    const { job } = await res.json();
    expect(job).toMatchObject({ state: 'queued', progress: 0, provider: 'mock', mock: true, mock_warning: MOCK_TRANSCRIPT_WARNING, audio_seconds: 120, keep_original: true });
    jobId = job.id;
    const ledger = await ledgerOf(jobId);
    expect(ledger).toMatchObject({ state: 'reserved', runId: null, audioSeconds: 120, reservedAmount: '0.000000' });
    const dup = await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, {});
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe('transcription_in_progress');
  });

  it('inline tick 마다 25 → 50 → 75 → succeeded 100, transcript v1(mock), 원장 확정', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      await tickJobs(1);
      seen.push((await jobOf(jobId)).progress);
    }
    expect(seen).toEqual([25, 50, 75, 100]);
    const g = await jobGET(get(`/api/transcription-jobs/${jobId}`), ctx(jobId));
    const { job } = await g.json();
    expect(job).toMatchObject({ state: 'succeeded', progress: 100, attempts: 1 });
    expect(job.latest_transcript).toMatchObject({ version: 1, created_by: 'mock' });
    expect(job.latest_transcript.text).toMatch(/^\[모의 전사 1\] /);
    expect(job.transcript_version_id).toBe(job.latest_transcript.id);
    v1 = job.latest_transcript.id;
    // 결정적: 같은 checksum 이면 같은 문장
    const asset = (await db.select().from(schema.assets).where(eq(schema.assets.id, assetId)))[0]!;
    const expected = await new MockTranscriber().transcribe({ assetId, checksum: asset.checksum, mime: asset.mime, audioSeconds: 120 });
    expect(job.latest_transcript.text).toBe(expected.text);
    expect(await ledgerOf(jobId)).toMatchObject({ state: 'settled', failed: false, actualAmount: '0.000000', audioSeconds: 120 });
    // 끝난 job 은 더 진행하지 않는다
    await tickJobs(2);
    expect((await jobOf(jobId)).progress).toBe(100);
    expect((await db.select().from(schema.transcripts).where(eq(schema.transcripts.jobId, jobId))).length).toBe(1);
  });

  it('가격이 있으면 ⌈초 × 1분 가격 / 60⌉ 로 예약·확정(같은 원장·통화)', async () => {
    vi.stubEnv('STT_PRICE_PER_MINUTE', '0.006');
    try {
      const res = await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, { duration_seconds: 90 });
      expect(res.status).toBe(202);
      const id = (await res.json()).job.id;
      expect(await ledgerOf(id)).toMatchObject({ state: 'reserved', reservedAmount: '0.009000', currency: 'USD' });
      await tickJobs(4);
      expect(await ledgerOf(id)).toMatchObject({ state: 'settled', actualAmount: '0.009000', overBudget: false, failed: false });
      // 월 상한을 넘으면 429 — job·원장이 남지 않는다
      vi.stubEnv('LLM_BUDGET_MONTHLY_LIMIT', '0.010000');
      const jobs = await n(schema.transcriptionJobs);
      const ledgers = await n(schema.usageLedger);
      const over = await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, { duration_seconds: 90 });
      expect(over.status).toBe(429);
      expect(await n(schema.transcriptionJobs)).toBe(jobs);
      expect(await n(schema.usageLedger)).toBe(ledgers);
    } finally {
      vi.stubEnv('STT_PRICE_PER_MINUTE', '');
      vi.stubEnv('LLM_BUDGET_MONTHLY_LIMIT', '');
    }
  });

  it('실패 주입(NODE_ENV=test, STT_MOCK_FAIL_NEXT=1): failed, 원장은 예약액 확정(failed=true), asset 그대로', async () => {
    vi.stubEnv('STT_PRICE_PER_MINUTE', '0.006');
    try {
      const id = (await (await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, { duration_seconds: 60 })).json()).job.id;
      await tickJobs(3);
      vi.stubEnv('STT_MOCK_FAIL_NEXT', '1');
      await tickJobs(1);
      vi.stubEnv('STT_MOCK_FAIL_NEXT', '');
      const job = await jobOf(id);
      expect(job).toMatchObject({ state: 'failed', transcriptVersionId: null, error: '전사 실패(모의 실패 주입)' });
      expect(await ledgerOf(id)).toMatchObject({ state: 'settled', failed: true, reservedAmount: '0.006000', actualAmount: '0.006000' });
      const asset = (await db.select().from(schema.assets).where(eq(schema.assets.id, assetId)))[0]!;
      expect(asset.deletedAt).toBeNull();
      expect((await assetGET(...assetGet(assetId, tokenA))).status).toBe(200);
      expect((await db.select().from(schema.transcripts).where(eq(schema.transcripts.jobId, id))).length).toBe(0);
    } finally {
      vi.stubEnv('STT_PRICE_PER_MINUTE', '');
      vi.stubEnv('STT_MOCK_FAIL_NEXT', '');
    }
  });

  it('취소: queued → 예약 해제(released, 0), running → 예약액 확정(failed), 끝난 job 409, 취소 뒤 tick 은 결과를 쓰지 않는다', async () => {
    vi.stubEnv('STT_PRICE_PER_MINUTE', '0.006');
    try {
      const q = (await (await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, { duration_seconds: 60 })).json()).job.id;
      const c1 = await cancelPOST(bare(`/api/transcription-jobs/${q}/cancel`, tokenA), ctx(q));
      expect(c1.status).toBe(200);
      expect((await c1.json()).job.state).toBe('canceled');
      expect(await ledgerOf(q)).toMatchObject({ state: 'released', actualAmount: '0.000000' });
      expect((await cancelPOST(bare(`/api/transcription-jobs/${q}/cancel`, tokenA), ctx(q))).status).toBe(409);

      const r = (await (await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, { duration_seconds: 60 })).json()).job.id;
      await tickJobs(3); // running 75
      expect((await jobOf(r)).state).toBe('running');
      expect((await cancelPOST(bare(`/api/transcription-jobs/${r}/cancel`, tokenA), ctx(r))).status).toBe(200);
      expect(await ledgerOf(r)).toMatchObject({ state: 'settled', failed: true, actualAmount: '0.006000' });
      await tickJobs(2);
      expect(await jobOf(r)).toMatchObject({ state: 'canceled', progress: 75, transcriptVersionId: null });
      expect((await db.select().from(schema.transcripts).where(eq(schema.transcripts.jobId, r))).length).toBe(0);
      expect((await cancelPOST(bare(`/api/transcription-jobs/${jobId}/cancel`, tokenA), ctx(jobId))).status).toBe(409);
    } finally {
      vi.stubEnv('STT_PRICE_PER_MINUTE', '');
    }
  });

  it('전사 수정: base_version 최신이면 v2(owner), 아니면 409 stale_transcript, v1 은 불변', async () => {
    const res = await post(versionsPOST, `/api/transcripts/${v1}/versions`, v1, { base_version: 1, text: '내가 고친 전사 본문입니다.' });
    expect(res.status).toBe(201);
    const v2 = (await res.json()).transcript;
    expect(v2).toMatchObject({ version: 2, created_by: 'owner', text: '내가 고친 전사 본문입니다.', segments: [] });
    const stale = await post(versionsPOST, `/api/transcripts/${v1}/versions`, v1, { base_version: 1, text: '다른 수정' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'stale_transcript', current_version: 2 });
    expect((await post(versionsPOST, `/api/transcripts/${v1}/versions`, v1, { base_version: 2, text: '   ' })).status).toBe(400);
    const t1 = await (await transcriptGET(get(`/api/transcripts/${v1}`), ctx(v1))).json();
    expect(t1.transcript.version).toBe(1);
    const err = await db.execute(sql`update transcripts set text = 'x' where id = ${v1}::uuid`).then(
      () => null,
      (e: { message?: string; cause?: { message?: string } }) => `${e.message ?? ''} ${e.cause?.message ?? ''}`,
    );
    expect(err).toMatch(/append_only_immutable: transcripts/);
  });

  it('소재로 보내기: 201(원문 = 전사 본문, 메모 "음성 전사(모의)", 전사 연결), 같은 버전 재요청 200', async () => {
    const job = (await (await jobGET(get(`/api/transcription-jobs/${jobId}`), ctx(jobId))).json()).job;
    const v2 = job.latest_transcript;
    expect(v2.version).toBe(2);
    const res = await toCapturePOST(bare(`/api/transcripts/${v2.id}/to-capture`, tokenA), ctx(v2.id));
    expect(res.status).toBe(201);
    const { capture } = await res.json();
    expect(capture).toMatchObject({ raw_text: v2.text, input_type: 'text', user_note: '음성 전사(모의)', capture_transcript_id: v2.id });
    const again = await toCapturePOST(bare(`/api/transcripts/${v2.id}/to-capture`, tokenA), ctx(v2.id));
    expect(again.status).toBe(200);
    expect((await again.json()).capture.id).toBe(capture.id);
    const row = (await db.select().from(schema.captures).where(eq(schema.captures.id, capture.id)))[0]!;
    expect(row.captureTranscriptId).toBe(v2.id);
  });

  it('원음 보존 안 함: 성공 뒤 deleted_at + 파일 삭제, 다운로드 410, 다시 전사 410', async () => {
    const f = media('mp4', 30_000, 31);
    const { res } = await uploadAll(f, 'video/mp4');
    expect(res.status).toBe(200);
    const vid = (await res.json()).asset.id as string;
    const key = `assets/${ownerA}/${vid}`;
    const storage = new LocalStorageAdapter(storageDir);
    expect(await storage.exists(key)).toBe(true);
    const jr = await post(transcribePOST, `/api/assets/${vid}/transcribe`, vid, { keep_original: false });
    expect(jr.status).toBe(202);
    const id = (await jr.json()).job.id;
    await tickJobs(4);
    expect((await jobOf(id)).state).toBe('succeeded');
    const asset = (await db.select().from(schema.assets).where(eq(schema.assets.id, vid)))[0]!;
    expect(asset.deletedAt).not.toBeNull();
    expect(await storage.exists(key)).toBe(false);
    const dl = await assetGET(...assetGet(vid, tokenA));
    expect(dl.status).toBe(410);
    expect((await dl.json()).error).toBe('asset_deleted');
    expect((await post(transcribePOST, `/api/assets/${vid}/transcribe`, vid, {})).status).toBe(410);
    // 전사 본문은 남는다
    expect((await db.select().from(schema.transcripts).where(eq(schema.transcripts.jobId, id))).length).toBe(1);
  });

  it('live STT 차단: 승인 기록·공급자·모델·가격이 있어도 503, job·원장 0, 네트워크 호출 0', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const env = { STT_MODE: 'live', STT_PROVIDER: 'p', STT_MODEL: 'm', STT_PRICE_PER_MINUTE: '0.01', LLM_BUDGET_MONTHLY_LIMIT: '5', STT_LIVE_APPROVAL_REF: 'D99' };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    try {
      const jobs = await n(schema.transcriptionJobs);
      const ledgers = await n(schema.usageLedger);
      const res = await post(transcribePOST, `/api/assets/${assetId}/transcribe`, assetId, {});
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error).toBe('live_stt_not_configured');
      expect(JSON.stringify(body)).not.toContain('D99');
      expect(await n(schema.transcriptionJobs)).toBe(jobs);
      expect(await n(schema.usageLedger)).toBe(ledgers);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      for (const k of Object.keys(env)) vi.stubEnv(k, '');
      fetchSpy.mockRestore();
    }
  });

  it('health: stt 모드·준비 안 됨(이름만)·업로드 임시 영역 사용량', async () => {
    const body = await (await healthGET()).json();
    expect(body.stt).toMatchObject({ mode: 'mock', live_ready: false });
    expect(body.stt.missing).toContain('LIVE_STT_ADAPTER(T08 미구현, 별도 승인 후)');
    expect(body.uploads).toEqual({ sessions: expect.any(Number), files: expect.any(Number), bytes: expect.any(Number) });
  });
});

describe('owner 격리 — 다른 owner 는 모든 경로 404', () => {
  it('세션·조각·완료·중단·전사 요청·job·취소·전사 본문·수정·소재 보내기', async () => {
    as(A);
    const s = await (await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: 3000, chunk_size: CHUNK })).json();
    const sid = s.session.id as string;
    const job = (await db.select().from(schema.transcriptionJobs).where(eq(schema.transcriptionJobs.ownerId, ownerA)).limit(1))[0]!;
    const t = (await db.select().from(schema.transcripts).where(eq(schema.transcripts.ownerId, ownerA)).limit(1))[0]!;
    as(B);
    expect((await sessionGET(get(`/api/uploads/sessions/${sid}`, tokenB), ctx(sid))).status).toBe(404);
    expect((await putChunk(sid, 0, media('mp3', 3000, 1), tokenB)).status).toBe(404);
    expect(existsSync(path.join(uploadsRoot(), ownerA, sid))).toBe(false);
    expect((await complete(sid, tokenB)).status).toBe(404);
    expect((await sessionDELETE(bare(`/api/uploads/sessions/${sid}`, tokenB, 'DELETE'), ctx(sid))).status).toBe(404);
    expect((await post(transcribePOST, `/api/assets/${job.assetId}/transcribe`, job.assetId, {}, tokenB)).status).toBe(404);
    expect((await jobGET(get(`/api/transcription-jobs/${job.id}`, tokenB), ctx(job.id))).status).toBe(404);
    expect((await cancelPOST(bare(`/api/transcription-jobs/${job.id}/cancel`, tokenB), ctx(job.id))).status).toBe(404);
    expect((await transcriptGET(get(`/api/transcripts/${t.id}`, tokenB), ctx(t.id))).status).toBe(404);
    expect((await post(versionsPOST, `/api/transcripts/${t.id}/versions`, t.id, { base_version: 99, text: 'x' }, tokenB)).status).toBe(404);
    expect((await toCapturePOST(bare(`/api/transcripts/${t.id}/to-capture`, tokenB), ctx(t.id))).status).toBe(404);
    const list = await (await jobsGET(get('/api/transcription-jobs', tokenB), undefined as never)).json();
    expect(list.jobs).toEqual([]);
    const filtered = await jobsGET(get(`/api/transcription-jobs?asset_id=${job.assetId}`, tokenB), undefined as never);
    expect((await filtered.json()).jobs).toEqual([]);
    expect((await jobsGET(get('/api/transcription-jobs?asset_id=../x', tokenB), undefined as never)).status).toBe(400);
    as(A);
  });
});

describe('내보내기 → 빈 DB 복원(전사 job·버전·원장·소재 연결)', () => {
  it('upload_sessions·upload_chunks 는 제외, transcription_jobs·transcripts 는 같은 행으로 복원, 지운 원본은 메타데이터만', async () => {
    const storage = new LocalStorageAdapter(storageDir);
    const exported = await exportOwner(db, storage, ownerA, { outDir: path.join(tmp, 'exports') });
    expect(exported.manifest.excluded_tables).toEqual(expect.arrayContaining(['upload_sessions', 'upload_chunks']));
    expect(Object.keys(exported.manifest.tables)).not.toContain('upload_sessions');
    expect(exported.manifest.tables.transcription_jobs!.rows).toBeGreaterThan(0);
    expect(exported.manifest.tables.transcripts!.rows).toBeGreaterThan(0);
    expect(exported.manifest.warnings.map((w) => w.code)).toContain('asset_deleted');
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-t08@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.conflicts_total).toBe(0);
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.conflicts_total).toBe(0);
      expect(r.interrupted_transcriptions).toEqual([]);
      for (const t of RESTORED_TABLES) {
        const a = (await selectBundleRows(db, t, ownerScope(t, ownerA))).map((x) => x.row);
        const b = (await selectBundleRows(h.db, t, ownerScope(t, target))).map((x) => x.row);
        expect(b, t).toEqual(a);
      }
      const linked = await h.db.select().from(schema.captures).where(and(eq(schema.captures.ownerId, target)));
      expect(linked.some((c) => c.captureTranscriptId !== null)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('진행 중이던 전사 job 은 canceled 로 복원하고 예약 원장은 예약액으로 확정한다(복원 환경에서 다시 돌리지 않음)', async () => {
    const { res } = await uploadAll(media('mp3', 20_000, 41));
    const aid = (await res.json()).asset.id as string;
    vi.stubEnv('STT_PRICE_PER_MINUTE', '0.006');
    let jid: string;
    try {
      jid = (await (await post(transcribePOST, `/api/assets/${aid}/transcribe`, aid, { duration_seconds: 60 })).json()).job.id;
    } finally {
      vi.stubEnv('STT_PRICE_PER_MINUTE', '');
    }
    const exported = await exportOwner(db, new LocalStorageAdapter(storageDir), ownerA, { outDir: path.join(tmp, 'exports-q') });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-t08q@example.local')).id;
      const restoresDir = path.join(tmp, 'restores-q');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.interrupted_transcriptions).toEqual([jid]);
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-q')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.interrupted_transcriptions).toEqual([jid]);
      const j = (await h.db.select().from(schema.transcriptionJobs).where(eq(schema.transcriptionJobs.id, jid)))[0]!;
      expect(j.state).toBe('canceled');
      const l = (await h.db.select().from(schema.usageLedger).where(eq(schema.usageLedger.transcriptionJobId, jid)))[0]!;
      expect(l).toMatchObject({ state: 'settled', failed: true, actualAmount: '0.006000' });
    } finally {
      await h.close();
      await cancelPOST(bare(`/api/transcription-jobs/${jid}/cancel`, tokenA), ctx(jid));
    }
  });
});

describe('FIX-T08 round 1(Codex review-T08)', () => {
  const storage = () => new LocalStorageAdapter(storageDir);
  /** 조각을 모두 올린 open 세션(완료 전) */
  async function openSession(file: Uint8Array<ArrayBuffer>, mime = 'audio/mpeg', extra: Record<string, unknown> = {}) {
    const s = await (await createSession({ kind: mime.startsWith('audio/') ? 'audio' : 'video', mime, bytes: file.byteLength, chunk_size: CHUNK, ...extra })).json();
    const id = s.session.id as string;
    for (let i = 0; i * CHUNK < file.byteLength; i++) expect((await putChunk(id, i, file.slice(i * CHUNK, (i + 1) * CHUNK))).status).toBe(201);
    return id;
  }
  const realOpen = (file: string) => open(file, 'w');
  const assetsWith = async (checksum: string) => db.select().from(schema.assets).where(and(eq(schema.assets.ownerId, ownerA), eq(schema.assets.checksum, checksum)));

  it('P0 부분 쓰기: 한 번에 777바이트만 쓰는 핸들이어도 끝까지 반복해 원본과 같은 파일이 된다', async () => {
    const f = media('mp3', CHUNK + 5000, 61);
    const id = await openSession(f);
    let calls = 0;
    const partial = async (file: string): Promise<WriteHandle> => {
      const fh = await realOpen(file);
      return {
        write: (buf, off, len) => {
          calls++;
          return fh.write(buf, off, Math.min(len, 777));
        },
        close: () => fh.close(),
      };
    };
    const r = await completeUploadSession(db, uploadStoreFor(loadConfig()), storage(), ownerA, id, new Date(), { openWrite: partial });
    expect(calls).toBeGreaterThan(Math.floor(f.byteLength / 777));
    expect(r.asset).toMatchObject({ checksum: sha(f), bytes: f.byteLength });
    const bytes = await storage().get(r.asset.key);
    expect(sha(bytes!)).toBe(sha(f));
  });

  it('P0 쓰기 진행 0 → assembly_failed(rejected·asset 없음), 쓴 척만 하는 핸들(크기 불일치)도 거부', async () => {
    const f = media('mp3', 9000, 62);
    const id = await openSession(f);
    const stuck = async (file: string): Promise<WriteHandle> => {
      const fh = await realOpen(file);
      return { write: async () => ({ bytesWritten: 0 }), close: () => fh.close() };
    };
    await expect(completeUploadSession(db, uploadStoreFor(loadConfig()), storage(), ownerA, id, new Date(), { openWrite: stuck })).rejects.toMatchObject({
      code: 'upload_rejected',
      extra: { reason: 'assembly_failed' },
    });
    expect((await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, id)))[0]!.state).toBe('rejected');
    expect(await assetsWith(sha(f))).toHaveLength(0);

    const g = media('mp3', 9000, 63);
    const id2 = await openSession(g);
    const liar = async (file: string): Promise<WriteHandle> => {
      const fh = await realOpen(file);
      return {
        write: async (buf, off, len) => {
          await fh.write(buf, off, Math.max(1, len >> 1)); // 절반만 쓰고
          return { bytesWritten: len }; // 다 썼다고 보고
        },
        close: () => fh.close(),
      };
    };
    await expect(completeUploadSession(db, uploadStoreFor(loadConfig()), storage(), ownerA, id2, new Date(), { openWrite: liar })).rejects.toMatchObject({
      extra: { reason: 'assembly_failed' },
    });
    expect(await assetsWith(sha(g))).toHaveLength(0);
  });

  it('P1 완료 중 만료: 조립 뒤 만료되면 asset 을 만들지 않고 세션은 expired(409 upload_expired), 옮긴 파일 없음', async () => {
    const f = media('mp3', 7000, 64);
    const id = await openSession(f);
    const store = uploadStoreFor(loadConfig());
    const assetsDir = path.join(storageDir, 'assets', ownerA);
    const before = filesUnder(assetsDir);
    await expect(
      completeUploadSession(db, store, storage(), ownerA, id, new Date(), {
        beforeFinish: async () => {
          expect(await expireUploadSessions(db, store, new Date(Date.now() + 25 * 3600_000))).toBeGreaterThanOrEqual(1);
        },
      }),
    ).rejects.toMatchObject({ code: 'upload_expired' });
    const s = (await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, id)))[0]!;
    expect(s).toMatchObject({ state: 'expired', assetId: null });
    expect(await assetsWith(sha(f))).toHaveLength(0);
    expect(filesUnder(assetsDir)).toBe(before);
    expect(existsSync(path.join(uploadsRoot(), ownerA, id))).toBe(false);
  });

  it('P0 원음 삭제 뒤 재업로드는 새 key 로 되살리고, 옛 key 에 대한 늦은 삭제가 새 파일을 지우지 못한다', async () => {
    const f = media('mp4', 12_000, 65);
    const { res } = await uploadAll(f, 'video/mp4');
    const asset = (await res.json()).asset;
    const oldKey = `assets/${ownerA}/${asset.id}`;
    expect(await deleteOriginal(db, storage(), { id: randomUUID(), ownerId: ownerA, assetId: asset.id }, new Date())).toBe(true);
    expect(await storage().exists(oldKey)).toBe(false);
    expect((await assetsWith(sha(f)))[0]!.deletedAt).not.toBeNull();
    // 같은 바이트 재업로드 → 같은 asset, 새 key, deleted_at 해제
    const again = await uploadAll(f, 'video/mp4');
    const body = await again.res.json();
    expect(body).toMatchObject({ duplicate: true, asset: { id: asset.id, deleted_at: null } });
    const row = (await assetsWith(sha(f)))[0]!;
    expect(row.key).not.toBe(oldKey);
    expect(row.deletedAt).toBeNull();
    // 삭제 작업이 옛 key 로 늦게 도착해도 새 파일은 그대로
    await storage().delete(oldKey);
    expect(await storage().exists(row.key)).toBe(true);
    const dl = await assetGET(...assetGet(asset.id, tokenA));
    expect(dl.status).toBe(200);
    expect(sha(new Uint8Array(await dl.arrayBuffer()))).toBe(sha(f));
  });

  it('P0 파일 삭제가 실패하면 deleted_at 도 남지 않는다(한 트랜잭션, DB 와 파일 일치)', async () => {
    const f = media('mp3', 8000, 66);
    const { res } = await uploadAll(f);
    const asset = (await res.json()).asset;
    const failing = { delete: async () => Promise.reject(new Error('EBUSY')) };
    await expect(deleteOriginal(db, failing, { id: randomUUID(), ownerId: ownerA, assetId: asset.id }, new Date())).rejects.toThrow('EBUSY');
    const row = (await assetsWith(sha(f)))[0]!;
    expect(row.deletedAt).toBeNull();
    expect(await storage().exists(row.key)).toBe(true);
  });

  it('P0 첨부 ↔ 삭제: 지운 파일은 첨부 410, 첨부된 파일은 삭제하지 않음(둘 다 asset 행 잠금 아래 재확인)', async () => {
    const vid = media('mp4', 9000, 67);
    const kept = media('mp4', 9000, 68);
    const a1 = (await (await uploadAll(vid, 'video/mp4')).res.json()).asset.id as string;
    const a2 = (await (await uploadAll(kept, 'video/mp4')).res.json()).asset.id as string;
    const contentId = (await createContent(db, ownerA, { title: '첨부 경합', body: '본문.' })).content.id;
    const { variant } = await createVariantDraft(db, ownerA, contentId, { channel: 'youtube', baseVersion: 1 });
    expect(await deleteOriginal(db, storage(), { id: randomUUID(), ownerId: ownerA, assetId: a1 }, new Date())).toBe(true);
    await expect(setVariantAssets(db, ownerA, variant.id, { baseVersion: 1, assets: [{ assetId: a1, position: 1, role: 'video' }] })).rejects.toMatchObject({
      code: 'asset_deleted',
    });
    await setVariantAssets(db, ownerA, variant.id, { baseVersion: 1, assets: [{ assetId: a2, position: 1, role: 'video' }] });
    expect(await deleteOriginal(db, storage(), { id: randomUUID(), ownerId: ownerA, assetId: a2 }, new Date())).toBe(false);
    const row = (await db.select().from(schema.assets).where(eq(schema.assets.id, a2)))[0]!;
    expect(row.deletedAt).toBeNull();
    expect(await storage().exists(row.key)).toBe(true);
    // 동시에 요청해도(잠금으로 직렬화) 첨부된 파일이 지워지거나 지운 파일이 첨부되는 결과는 없다
    const a3 = (await (await uploadAll(media('mp4', 9000, 69), 'video/mp4')).res.json()).asset.id as string;
    const [att, del] = await Promise.allSettled([
      setVariantAssets(db, ownerA, variant.id, { baseVersion: 2, assets: [{ assetId: a3, position: 1, role: 'video' }] }),
      deleteOriginal(db, storage(), { id: randomUUID(), ownerId: ownerA, assetId: a3 }, new Date()),
    ]);
    const r3 = (await db.select().from(schema.assets).where(eq(schema.assets.id, a3)))[0]!;
    const attached = (await db.select().from(schema.variantAssets).where(eq(schema.variantAssets.assetId, a3))).length > 0;
    expect(attached && r3.deletedAt !== null).toBe(false);
    expect(att.status === 'fulfilled' || del.status === 'fulfilled').toBe(true);
  });

  it('P1 이어 올리기 확인용: GET 은 받은 조각별 sha256·신고 checksum·resumable 을 돌려준다, 신고 sha 가 다르면 완료 거부', async () => {
    const f = media('mp3', CHUNK + 100, 70);
    const s = await (await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: f.byteLength, chunk_size: CHUNK, sha256: sha(f) })).json();
    expect(s.session).toMatchObject({ checksum_expected: sha(f), resumable: true, chunks: [] });
    expect((await putChunk(s.session.id, 0, f.slice(0, CHUNK))).status).toBe(201);
    const g = await (await sessionGET(get(`/api/uploads/sessions/${s.session.id}`), ctx(s.session.id))).json();
    expect(g.session.chunks).toEqual([{ index: 0, sha256: sha(f.slice(0, CHUNK)) }]);
    const noSha = await (await createSession({ kind: 'audio', mime: 'audio/mpeg', bytes: 100, chunk_size: CHUNK })).json();
    expect(noSha.session).toMatchObject({ checksum_expected: null, resumable: false });
    // 다른 파일의 뒷조각을 섞으면 신고 sha 와 달라 거부
    expect((await putChunk(s.session.id, 1, media('mp3', 100, 71))).status).toBe(201);
    const r = await complete(s.session.id);
    expect(r.status).toBe(400);
    expect((await r.json()).reason).toBe('checksum_mismatch');
  });
});
