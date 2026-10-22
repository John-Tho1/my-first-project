/**
 * FIX1-FULLREV(F3): 업로드 세션의 신고 형식(mime)은 브라우저 별칭(audio/x-m4a 등)·매개변수·대소문자를 정본으로 바꿔 받고 저장한다.
 * 완료 시 서명 판정(sniffMedia·mediaMatches)은 그대로 최종 판정 — 별칭으로 신고해도 내용이 다르면 415 mime_mismatch.
 * 저장된 정본 형식은 다운로드 Content-Type·내보내기 경로·빈 DB 복원 검사를 그대로 통과한다. 외부 호출 없음.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import { closeDb, commitRestore, createRestorePreview, createTestDb, ensureOwner, exportOwner, getDb, schema, seed, type Db } from '@cs/db';
import { loadConfig, MIB } from '@cs/domain';
import { LocalStorageAdapter } from '@cs/providers';
import { GET as assetGET } from '../../apps/web/app/api/assets/[id]/route';
import { POST as sessionsPOST } from '../../apps/web/app/api/uploads/sessions/route';
import { PUT as chunkPUT } from '../../apps/web/app/api/uploads/sessions/[id]/chunks/[index]/route';
import { POST as completePOST } from '../../apps/web/app/api/uploads/sessions/[id]/complete/route';
import { assetGet, BASE, cookieHeader, jsonPost, login, ORIGIN_HEADERS } from './helpers';

const A = 'owner@example.local';
const CHUNK = 4 * MIB;

let db: Db;
let tmp: string;
let storageDir: string;
let ownerA: string;
let tokenA: string;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** 앞부분 서명 + 결정적 채움 바이트(합성 — 실제 음성 아님) */
function media(kind: 'm4a' | 'wav' | 'mp3' | 'mp4', bytes: number, seed = 1): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes);
  let x = seed * 2654435761;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  const head =
    kind === 'm4a'
      ? [0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('M4A '), 0, 0, 0, 0]
      : kind === 'mp4'
        ? [0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('isom'), 0, 0, 2, 0]
        : kind === 'wav'
          ? [...ascii('RIFF'), 36, 0, 0, 0, ...ascii('WAVE'), ...ascii('fmt ')]
          : [...ascii('ID3'), 4, 0, 0, 0, 0, 0, 0];
  out.set(head, 0);
  return out;
}

const createSession = (body: Record<string, unknown>) => sessionsPOST(jsonPost('/api/uploads/sessions', body, cookieHeader(tokenA)), undefined as never);

function putChunk(id: string, index: number, bytes: Uint8Array<ArrayBuffer>) {
  const req = new Request(`${BASE}/api/uploads/sessions/${id}/chunks/${index}`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/octet-stream', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) },
    body: bytes,
  });
  return chunkPUT(req, { params: Promise.resolve({ id, index: String(index) }) });
}

const complete = (id: string) =>
  completePOST(
    new Request(`${BASE}/api/uploads/sessions/${id}/complete`, { method: 'POST', headers: { accept: 'application/json', ...ORIGIN_HEADERS, ...cookieHeader(tokenA) } }),
    { params: Promise.resolve({ id }) },
  );

/** 신고 형식 그대로 세션 생성 → 조각 전부 → 완료 */
async function uploadAs(kind: 'audio' | 'video', mime: string, file: Uint8Array<ArrayBuffer>) {
  const created = await createSession({ kind, mime, bytes: file.byteLength, chunk_size: CHUNK, sha256: sha(file) });
  expect(created.status, mime).toBe(201);
  const session = (await created.json()).session as { id: string; mime: string };
  for (let i = 0; i * CHUNK < file.byteLength; i++) expect((await putChunk(session.id, i, file.slice(i * CHUNK, (i + 1) * CHUNK))).status).toBe(201);
  const res = await complete(session.id);
  return { session, res };
}

const sessionRow = async (id: string) => (await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, id)))[0]!;
const assetCount = async () => (await db.select({ n: count() }).from(schema.assets).where(eq(schema.assets.ownerId, ownerA)))[0]!.n;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'cs-f3-mime-'));
  storageDir = path.join(tmp, 'assets');
  vi.stubEnv('STORAGE_LOCAL_DIR', storageDir);
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  tokenA = await login(A);
});
beforeEach(() => {
  vi.stubEnv('STORAGE_LOCAL_DIR', storageDir);
  vi.stubEnv('AUTH_ALLOWED_IDENTITY', A);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe('FIX1-FULLREV(F3): 브라우저 별칭 형식으로 올린 업로드', () => {
  let m4aAssetId: string;
  const m4a = media('m4a', CHUNK + 777, 3);

  it('audio/x-m4a + 실제 M4A 서명 → 201·완료 200, 세션·asset·감사·다운로드에 정본 audio/mp4 만 남는다', async () => {
    const { session, res } = await uploadAs('audio', 'audio/x-m4a', m4a);
    expect(session.mime).toBe('audio/mp4');
    expect((await sessionRow(session.id)).declaredMime).toBe('audio/mp4');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset).toMatchObject({ mime: 'audio/mp4', bytes: m4a.byteLength, checksum: sha(m4a), verification_state: 'VERIFIED' });
    expect(body.session).toMatchObject({ state: 'verified', asset_id: body.asset.id });
    m4aAssetId = body.asset.id;
    const stored = (await db.select().from(schema.assets).where(eq(schema.assets.id, m4aAssetId)))[0]!;
    expect(stored.mime).toBe('audio/mp4');
    const audit = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, 'upload.session_create'), eq(schema.auditEvents.entityId, session.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.sanitizedDetails).toMatchObject({ kind: 'audio', mime: 'audio/mp4' });
    const dl = await assetGET(...assetGet(m4aAssetId, tokenA));
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('audio/mp4');
    expect(sha(new Uint8Array(await dl.arrayBuffer()))).toBe(sha(m4a));
  });

  it('대소문자·매개변수가 붙은 별칭도 정본으로(Audio/X-WAV; codec=1 → audio/wav, audio/mp3 → audio/mpeg, video/x-m4v → video/mp4)', async () => {
    const wav = await uploadAs('audio', 'Audio/X-WAV; codec=1', media('wav', 5000, 4));
    expect(wav.session.mime).toBe('audio/wav');
    expect(wav.res.status).toBe(200);
    expect((await wav.res.json()).asset.mime).toBe('audio/wav');
    const mp3 = await uploadAs('audio', 'audio/mp3', media('mp3', 5000, 5));
    expect(mp3.session.mime).toBe('audio/mpeg');
    expect(mp3.res.status).toBe(200);
    expect((await mp3.res.json()).asset.mime).toBe('audio/mpeg');
    const m4v = await uploadAs('video', 'video/x-m4v', media('mp4', 5000, 6));
    expect(m4v.session.mime).toBe('video/mp4');
    expect(m4v.res.status).toBe(200);
    expect((await m4v.res.json()).asset.mime).toBe('video/mp4');
  });

  it('서명 판정은 그대로: audio/x-m4a 로 신고한 WAV·MP3 는 415 mime_mismatch(rejected, asset 없음)', async () => {
    const before = await assetCount();
    for (const kind of ['wav', 'mp3'] as const) {
      const f = media(kind, 5000, kind === 'wav' ? 7 : 8);
      const { session, res } = await uploadAs('audio', 'audio/x-m4a', f);
      expect(session.mime).toBe('audio/mp4');
      expect(res.status, kind).toBe(415);
      expect(await res.json()).toMatchObject({ error: 'upload_rejected', reason: 'mime_mismatch' });
      expect(await sessionRow(session.id)).toMatchObject({ state: 'rejected', rejectReason: 'mime_mismatch', assetId: null });
    }
    // audio/x-wav 로 신고한 M4A 도 불일치
    const { res } = await uploadAs('audio', 'audio/x-wav', media('m4a', 5000, 9));
    expect(res.status).toBe(415);
    expect((await res.json()).reason).toBe('mime_mismatch');
    expect(await assetCount()).toBe(before);
  });

  it('목록 밖·빈 형식은 세션 생성에서 그대로 거부(415·400), 종류는 정본 기준(400)', async () => {
    const before = (await db.select({ n: count() }).from(schema.uploadSessions))[0]!.n;
    for (const mime of ['application/octet-stream', 'audio/aac', 'audio/ogg', 'video/x-matroska', 'image/png']) {
      expect((await createSession({ kind: 'audio', mime, bytes: 10, chunk_size: CHUNK })).status, mime).toBe(415);
    }
    expect((await createSession({ kind: 'audio', mime: '', bytes: 10, chunk_size: CHUNK })).status).toBe(400);
    expect((await createSession({ kind: 'video', mime: 'audio/x-m4a', bytes: 10, chunk_size: CHUNK })).status).toBe(400);
    expect((await db.select({ n: count() }).from(schema.uploadSessions))[0]!.n).toBe(before);
  });

  it('저장된 정본 형식은 내보내기(assets/<id>.m4a) → 빈 DB 복원 검사를 그대로 통과한다', async () => {
    const exported = await exportOwner(db, new LocalStorageAdapter(storageDir), ownerA, { outDir: path.join(tmp, 'exports') });
    const entry = exported.manifest.assets.find((a) => a.id === m4aAssetId)!;
    expect(entry).toMatchObject({ mime: 'audio/mp4', path: `assets/${m4aAssetId}.m4a` });
    const zip = new Uint8Array(readFileSync(exported.zipPath));
    const h = await createTestDb();
    try {
      const target = (await ensureOwner(h.db, 'restore-f3@example.local')).id;
      const restoresDir = path.join(tmp, 'restores');
      const p = await createRestorePreview(h.db, target, zip, { restoresDir, source: 'upload' });
      expect(p.preview.conflicts_total).toBe(0);
      const r = await commitRestore(h.db, new LocalStorageAdapter(path.join(tmp, 'assets-b')), target, p.restoreId, { mode: 'empty_only', confirm: true, restoresDir });
      expect(r.conflicts_total).toBe(0);
      const restored = (await h.db.select().from(schema.assets).where(and(eq(schema.assets.ownerId, target), eq(schema.assets.id, m4aAssetId))))[0]!;
      expect(restored).toMatchObject({ mime: 'audio/mp4', checksum: sha(m4a), verificationState: 'VERIFIED' });
    } finally {
      await h.close();
    }
  });
});
