/**
 * T02 파일 접근 제어 + A01(다른 계정 ID 로 데이터/파일 접근 거부).
 * 두 번째 사용자(other@example.local)를 만들어 query 계층과 route 계층 모두에서 교차 접근이 막히는지 확인한다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  closeDb,
  getAssetById,
  getCaptureById,
  getDb,
  listAssets,
  listCaptures,
  schema,
  seed,
  type Db,
} from '@cs/db';
import { InvalidStorageKeyError, loadConfig, MAX_UPLOAD_BYTES } from '@cs/domain';
import { LocalStorageAdapter } from '@cs/providers';
import { GET as assetGET } from '../../apps/web/app/api/assets/[id]/route';
import { POST as uploadPOST } from '../../apps/web/app/api/assets/uploads/route';
import { assetGet, BASE, cookieHeader, login } from './helpers';

const A = 'owner@example.local';
const B = 'other@example.local';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);

let db: Db;
let storageDir: string;
let ownerA: string;
let ownerB: string;
let tokenA: string;
let tokenB: string;

/** 요청 시점의 AUTH_ALLOWED_IDENTITY 로 사용자를 전환한다(단일 사용자 allowlist). */
const as = (identity: string) => vi.stubEnv('AUTH_ALLOWED_IDENTITY', identity);

function upload(
  token: string | null,
  file: { bytes: Uint8Array; name: string; type?: string },
  extra: Record<string, string> = {},
  headers: Record<string, string> = { origin: BASE },
): Request {
  const form = new FormData();
  form.set('file', new File([file.bytes as Uint8Array<ArrayBuffer>], file.name, { type: file.type ?? '' }));
  for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return new Request(`${BASE}/api/assets/uploads`, {
    method: 'POST',
    headers: { accept: 'application/json', ...(token ? cookieHeader(token) : {}), ...headers },
    body: form,
  });
}

/**
 * multipart 본문을 바이트로 직접 만든다(FormData 원본 아님).
 * Node 24 의 undici 는 FormData 로 만든 Request 본문을 서버가 중간에 cancel 하면(413 경로)
 * 닫힌 스트림에 enqueue 를 시도해 미처리 거부(ERR_INVALID_STATE)를 낸다. 실제 서버의 요청 본문은 소켓 바이트
 * 스트림이므로 그 경로와 같은 바이트 원본으로 413 을 검증한다.
 */
function rawMultipartUpload(token: string, file: { bytes: Uint8Array; name: string }): Request {
  const boundary = 'cs-it-boundary';
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}
Content-Disposition: form-data; name="file"; filename="${file.name}"
Content-Type: application/octet-stream

`,
  );
  const tail = enc.encode(`
--${boundary}--
`);
  const body = new Uint8Array(head.byteLength + file.bytes.byteLength + tail.byteLength);
  body.set(head, 0);
  body.set(file.bytes, head.byteLength);
  body.set(tail, head.byteLength + file.bytes.byteLength);
  return new Request(`${BASE}/api/assets/uploads`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      origin: BASE,
      ...cookieHeader(token),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
}

const filesOnDisk = () => {
  try {
    return readdirSync(storageDir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
  } catch {
    return 0;
  }
};

beforeAll(async () => {
  storageDir = mkdtempSync(path.join(tmpdir(), 'cs-assets-it-'));
  vi.stubEnv('STORAGE_LOCAL_DIR', storageDir);
  db = (await getDb(loadConfig())).db;
  ownerA = (await seed(db, { allowedIdentity: A })).ownerId;
  // 사용자 B: 자기 capture 1건
  const [b] = await db.insert(schema.users).values({ allowedIdentity: B }).returning();
  ownerB = b!.id;
  await db.insert(schema.captures).values({ ownerId: ownerB, rawText: 'B 의 메모', inputType: 'text', commandKey: 'b-1' });
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
  rmSync(storageDir, { recursive: true, force: true });
});

describe('POST /api/assets/uploads', () => {
  let pngId: string;

  it('PNG(magic bytes) → 201 VERIFIED, checksum, 파일은 assets/<ownerId>/<id> 에 저장', async () => {
    const res = await uploadPOST(upload(tokenA, { bytes: PNG, name: 'pic.png', type: 'image/png' }, { rights_status: 'owned' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const checksum = createHash('sha256').update(PNG).digest('hex');
    expect(body).toMatchObject({ mime: 'image/png', bytes: PNG.byteLength, checksum, verification_state: 'VERIFIED', rights_status: 'owned' });
    expect(body.duplicate).toBeUndefined();
    pngId = body.id;
    const row = await getAssetById(db, ownerA, pngId);
    expect(row!.key).toBe(`assets/${ownerA}/${pngId}`);
    expect(Array.from((await new LocalStorageAdapter(storageDir).get(row!.key))!)).toEqual(Array.from(PNG));
    const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'asset.upload'));
    expect(audit.at(-1)).toMatchObject({ ownerId: ownerA, entityId: pngId, versionOrHash: checksum });
  });

  it('같은 owner·같은 checksum → 200 duplicate:true, 파일·행 추가 없음', async () => {
    const files = filesOnDisk();
    const res = await uploadPOST(upload(tokenA, { bytes: PNG, name: 'again.png' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: pngId, duplicate: true });
    expect(filesOnDisk()).toBe(files);
    expect(await db.select().from(schema.assets).where(eq(schema.assets.ownerId, ownerA))).toHaveLength(1);
  });

  it('.png 확장자 + 텍스트 내용 → 415 (한국어 메시지)', async () => {
    const res = await uploadPOST(upload(tokenA, { bytes: new TextEncoder().encode('not an image'), name: 'fake.png', type: 'image/png' }));
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe('unsupported_media_type');
    expect(body.message).toMatch(/확장자와 실제 내용/);
  });

  it('판정 불가(실행 파일 바이트)·허용 밖 확장자 → 415', async () => {
    expect((await uploadPOST(upload(tokenA, { bytes: new Uint8Array([0x4d, 0x5a, 0x90, 0, 3]), name: 'x.exe' }))).status).toBe(415);
    expect((await uploadPOST(upload(tokenA, { bytes: new TextEncoder().encode('<svg/>'), name: 'x.svg' }))).status).toBe(415);
  });

  it('텍스트·Markdown 은 text/plain 으로 저장', async () => {
    const res = await uploadPOST(upload(tokenA, { bytes: new TextEncoder().encode('# 메모\n본문'), name: 'note.md', type: 'text/markdown' }));
    expect(res.status).toBe(201);
    expect((await res.json()).mime).toBe('text/plain');
  });

  it('11MB → 413, 파일 저장 없음', async () => {
    const files = filesOnDisk();
    const big = new Uint8Array(11 * 1024 * 1024);
    big.set(PNG);
    const req = rawMultipartUpload(tokenA, { bytes: big, name: 'big.png' });
    expect(req.headers.get('content-length')).toBeNull(); // 선언 길이 없이 스트리밍 상한에서 끊기는 경로
    const res = await uploadPOST(req);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('payload_too_large');
    expect(filesOnDisk()).toBe(files);
  });

  it('정확히 10MB 제한 경계: 선언된 Content-Length 가 크면 본문을 읽기 전에 413', async () => {
    const req = new Request(`${BASE}/api/assets/uploads`, {
      method: 'POST',
      headers: { origin: BASE, ...cookieHeader(tokenA), 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(MAX_UPLOAD_BYTES * 2) },
      body: 'x',
    });
    expect((await uploadPOST(req)).status).toBe(413);
  });

  it('로그인 없음 → 401, Origin 없음 → 403, 잘못된 rights_status·file 없음 → 400', async () => {
    expect((await uploadPOST(upload(null, { bytes: PNG, name: 'a.png' }))).status).toBe(401);
    expect((await uploadPOST(upload(tokenA, { bytes: PNG, name: 'a.png' }, {}, {}))).status).toBe(403);
    expect((await uploadPOST(upload(tokenA, { bytes: PNG, name: 'a.png' }, {}, { origin: 'http://evil.example' }))).status).toBe(403);
    expect((await uploadPOST(upload(tokenA, { bytes: PNG, name: 'a.png' }, { rights_status: 'stolen' }))).status).toBe(400);
    const empty = new FormData();
    empty.set('note', 'x');
    const res = await uploadPOST(
      new Request(`${BASE}/api/assets/uploads`, { method: 'POST', headers: { origin: BASE, ...cookieHeader(tokenA) }, body: empty }),
    );
    expect(res.status).toBe(400);
  });

  it('브라우저 폼 업로드 → 303 /?upload=ok, 실패 → 303 /?upload_error=unsupported', async () => {
    const ok = await uploadPOST(
      upload(tokenA, { bytes: new TextEncoder().encode('form upload'), name: 'f.txt' }, {}, { origin: BASE, accept: 'text/html' }),
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/?upload=ok');
    const bad = await uploadPOST(
      upload(tokenA, { bytes: new TextEncoder().encode('nope'), name: 'f.png' }, {}, { origin: BASE, accept: 'text/html' }),
    );
    expect(bad.headers.get('location')).toBe('/?upload_error=unsupported');
  });

  describe('GET /api/assets/{id}', () => {
    it('owner 본인 → 200, 올바른 헤더, 바이트 일치, 감사 기록', async () => {
      const res = await assetGET(...assetGet(pngId, tokenA));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${pngId}.png"`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
      const audit = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, 'asset.download'));
      expect(audit.at(-1)).toMatchObject({ ownerId: ownerA, entityId: pngId });
    });

    it('로그인 없음 → 401, 형식이 잘못된 ID·경로 조작 → 404', async () => {
      expect((await assetGET(...assetGet(pngId))).status).toBe(401);
      expect((await assetGET(...assetGet('../../etc/passwd', tokenA))).status).toBe(404);
      expect((await assetGET(...assetGet('not-a-uuid', tokenA))).status).toBe(404);
      expect((await assetGET(...assetGet(randomUUID(), tokenA))).status).toBe(404);
    });

    it('디스크에서 파일이 사라짐 → 404 + asset.missing 감사 기록', async () => {
      const res = await uploadPOST(upload(tokenA, { bytes: new TextEncoder().encode('will vanish'), name: 'v.txt' }));
      const { id } = await res.json();
      const row = await getAssetById(db, ownerA, id);
      await new LocalStorageAdapter(storageDir).delete(row!.key);
      const dl = await assetGET(...assetGet(id, tokenA));
      expect(dl.status).toBe(404);
      const missing = await db
        .select()
        .from(schema.auditEvents)
        .where(and(eq(schema.auditEvents.action, 'asset.missing'), eq(schema.auditEvents.entityId, id)));
      expect(missing).toHaveLength(1);
    });
  });
});

describe('A01: 다른 계정의 capture/asset ID 로 접근 거부', () => {
  let assetA: string;
  let assetB: string;

  beforeAll(async () => {
    vi.stubEnv('STORAGE_LOCAL_DIR', storageDir);
    as(A);
    const ra = await uploadPOST(upload(tokenA, { bytes: new TextEncoder().encode('A 의 비공개 파일'), name: 'a.txt' }));
    assetA = (await ra.json()).id;
    as(B);
    const rb = await uploadPOST(upload(tokenB, { bytes: new TextEncoder().encode('B 의 파일'), name: 'b.txt' }));
    expect(rb.status).toBe(201);
    assetB = (await rb.json()).id;
  });

  it('query 계층: B 는 A 의 capture·asset 을 ID 로 조회할 수 없다(null), 목록에도 없다', async () => {
    const capsA = await listCaptures(db, ownerA);
    const capA = capsA[0]!;
    expect(await getCaptureById(db, ownerA, capA.id)).not.toBeNull();
    expect(await getCaptureById(db, ownerB, capA.id)).toBeNull();
    expect(await getAssetById(db, ownerB, assetA)).toBeNull();
    expect(await getAssetById(db, ownerA, assetB)).toBeNull();
    expect(await getAssetById(db, ownerA, assetA)).not.toBeNull();
    const capsB = await listCaptures(db, ownerB);
    expect(capsB.map((c) => c.rawText)).toEqual(['B 의 메모']);
    expect(capsA.every((c) => c.ownerId === ownerA)).toBe(true);
    expect((await listAssets(db, ownerB)).map((a) => a.id)).toEqual([assetB]);
    expect((await listAssets(db, ownerA)).map((a) => a.id)).not.toContain(assetB);
  });

  it('route 계층: B 로 A 의 asset 다운로드 → 404(403 아님), A 로 B 의 asset → 404', async () => {
    as(B);
    const res = await assetGET(...assetGet(assetA, tokenB));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', message: '파일을 찾을 수 없습니다' });
    expect((await assetGET(...assetGet(assetB, tokenB))).status).toBe(200);
    as(A);
    expect((await assetGET(...assetGet(assetB, tokenA))).status).toBe(404);
    expect((await assetGET(...assetGet(assetA, tokenA))).status).toBe(200);
  });

  it('같은 내용을 B 가 올리면 B 소유의 별도 asset(A 의 asset 을 duplicate 로 돌려주지 않음)', async () => {
    as(B);
    const res = await uploadPOST(upload(tokenB, { bytes: new TextEncoder().encode('A 의 비공개 파일'), name: 'copy.txt' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe(assetA);
    expect(body.duplicate).toBeUndefined();
    expect((await getAssetById(db, ownerB, body.id))!.key).toBe(`assets/${ownerB}/${body.id}`);
  });

  it('storage adapter 는 owner 를 모르지만 경로 조작 키는 거부한다', async () => {
    const s = new LocalStorageAdapter(storageDir);
    const rowA = await getAssetById(db, ownerA, assetA);
    await expect(s.get(`assets/${ownerB}/../${rowA!.key.slice('assets/'.length)}`)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(s.get(`assets/${ownerB}/../../${path.basename(storageDir)}`)).rejects.toBeInstanceOf(InvalidStorageKeyError);
  });
});
