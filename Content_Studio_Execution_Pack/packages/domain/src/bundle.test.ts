import { describe, expect, it } from 'vitest';
import {
  buildBundle,
  BundleError,
  EXCLUDED_TABLES,
  EXPORTED_TABLES,
  fencedVerbatim,
  parseBundle,
  renderCaptureMarkdown,
  renderContentMarkdown,
  ROW_SCHEMAS,
  sha256Hex,
  stableStringify,
  type BundleTables,
  type BuildBundleInput,
} from './bundle';
import { readZip, writeZip, type ZipEntry } from './zip';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CAP = '22222222-2222-4222-8222-222222222222';
const CONTENT = '33333333-3333-4333-8333-333333333333';
const V1 = '44444444-4444-4444-8444-444444444441';
const V2 = '44444444-4444-4444-8444-444444444442';
const ASSET = '55555555-5555-4555-8555-555555555555';
const CC = '66666666-6666-4666-8666-666666666666';
const TS = '2026-09-01T06:10:00.123456Z';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const RAW = "주재원 첫 해 메모\n```\n코드 울타리 ``` 포함 · 앞뒤 공백 유지  ";
const MIGRATIONS = ['0000_a', '0001_b'];

function tables(): BundleTables {
  return {
    users: [{ id: OWNER, identity_masked: 'ow***@example.local' }],
    brand_profiles: [],
    sources: [],
    source_versions: [],
    captures: [
      {
        id: CAP,
        raw_text: RAW,
        input_type: 'text',
        source_id: null,
        received_at: TS,
        risk: 'none',
        user_note: '메모',
        command_key: 'fx-1',
        title: null,
        revision: 1,
        updated_at: TS,
        content_hash: 'abc',
      },
    ],
    capture_revisions: [],
    ideas: [],
    idea_captures: [],
    contents: [
      {
        id: CONTENT,
        idea_id: null,
        series: null,
        title: '원고',
        audience: null,
        tags: ['주재원'],
        revision: 1,
        current_version_id: V2,
        lifecycle: 'draft',
        created_at: TS,
        updated_at: TS,
      },
    ],
    content_versions: [
      { id: V1, content_id: CONTENT, version: 1, body: '첫 본문', created_by: 'owner', ai_run_id: null, created_at: TS, note: null },
      { id: V2, content_id: CONTENT, version: 2, body: '둘째 본문', created_by: 'owner', ai_run_id: null, created_at: TS, note: '고침' },
    ],
    content_captures: [{ id: CC, content_id: CONTENT, capture_id: CAP, role: 'origin', created_at: TS }],
    interview_answers: [],
    generation_runs: [],
    claim_confirmations: [],
    assets: [
      {
        id: ASSET,
        key: `assets/${OWNER}/${ASSET}`,
        mime: 'image/png',
        bytes: PNG.byteLength,
        checksum: sha256Hex(PNG),
        rights_status: 'owned',
        verification_state: 'VERIFIED',
        created_at: TS,
      },
    ],
    audit_events: [],
  };
}

function input(over: Partial<BuildBundleInput> = {}): BuildBundleInput {
  return {
    exportId: '77777777-7777-4777-8777-777777777777',
    exportedAt: '2026-09-24T12:00:00.000Z',
    appVersion: '0.1.0',
    migrations: MIGRATIONS,
    owner: { id: OWNER, identityMasked: 'ow***@example.local' },
    tables: tables(),
    assetBytes: new Map([[ASSET, PNG]]),
    ...over,
  };
}

const roundTrip = (entries: ZipEntry[]) => readZip(writeZip(entries));

describe('stableStringify', () => {
  it('키 순서와 무관하게 같은 바이트', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe(stableStringify({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 }));
  });
});

describe('buildBundle', () => {
  it('같은 데이터를 다시 내보내면 표 sha256 이 같다(내보내기 ID·시각이 달라도)', () => {
    const a = buildBundle(input());
    const shuffled = tables();
    shuffled.content_versions.reverse();
    const b = buildBundle(input({ exportId: '88888888-8888-4888-8888-888888888888', exportedAt: '2026-09-25T00:00:00.000Z', tables: shuffled }));
    expect(b.manifest.tables).toEqual(a.manifest.tables);
    expect(a.manifest.files.find((f) => f.path === 'data/captures.json')).toEqual(b.manifest.files.find((f) => f.path === 'data/captures.json'));
  });

  it('manifest 는 모든 파일(자신 제외)의 sha256 을 담고, 세션 같은 제외 표는 없다', () => {
    const b = buildBundle(input());
    const paths = b.entries.map((e) => e.path);
    expect(paths[0]).toBe('manifest.json');
    expect(b.manifest.files.map((f) => f.path).sort()).toEqual(paths.slice(1).sort());
    for (const e of b.entries.slice(1)) expect(b.manifest.files.find((f) => f.path === e.path)!.sha256).toBe(sha256Hex(e.bytes));
    expect(paths.some((p) => /session/i.test(p))).toBe(false);
    expect(Object.keys(b.manifest.tables).sort()).toEqual([...EXPORTED_TABLES].sort());
    expect(b.manifest.excluded_tables).toEqual(expect.arrayContaining(['sessions']));
    expect(paths).toContain(`assets/${ASSET}.png`);
    expect(paths).toContain(`markdown/contents/${CONTENT}.md`);
    expect(paths).toContain(`markdown/captures/${CAP}.md`);
    expect(paths).toContain('README.md');
    // 표 JSON 에 owner_id 없음
    const caps = new TextDecoder().decode(b.entries.find((e) => e.path === 'data/captures.json')!.bytes);
    expect(caps).not.toContain('owner_id');
  });

  it('저장소에 파일이 없으면 missing + 경고, 실패하지 않는다', () => {
    const b = buildBundle(input({ assetBytes: new Map([[ASSET, null]]) }));
    expect(b.manifest.assets[0]).toMatchObject({ id: ASSET, missing: true });
    expect(b.manifest.warnings).toEqual([expect.objectContaining({ code: 'asset_missing', asset_id: ASSET })]);
    expect(b.entries.some((e) => e.path.startsWith('assets/'))).toBe(false);
    // missing 묶음도 검증을 통과한다
    const parsed = parseBundle(roundTrip(b.entries), { migrations: MIGRATIONS });
    expect(parsed.assetBytes.size).toBe(0);
  });
});

describe('Markdown', () => {
  it('소재 원문은 한 글자도 바꾸지 않고 담는다(``` 가 있어도 더 긴 울타리)', () => {
    const md = renderCaptureMarkdown(tables().captures[0]!, [], null);
    expect(md).toContain(RAW);
    expect(fencedVerbatim(RAW)).toMatch(/^````text\n/);
  });

  it('원고: 현재 본문(v2)과 버전 이력 전체 본문', () => {
    const t = tables();
    const md = renderContentMarkdown(t.contents[0]!, t.content_versions, [CAP]);
    expect(md).toContain('## 현재 본문 (v2)\n\n둘째 본문');
    expect(md).toContain('## 버전 이력');
    expect(md).toContain('### v1\n\n첫 본문');
    expect(md).toContain('메모: 고침');
    expect(md).toContain(`origin_capture_ids: ["${CAP}"]`);
    expect(md).toMatch(/\(MSK\)/);
  });
});

describe('ROW_SCHEMAS', () => {
  it('모르는 열(owner_id 포함)은 거부한다', () => {
    const cap = tables().captures[0]!;
    expect(ROW_SCHEMAS.captures.safeParse(cap).success).toBe(true);
    expect(ROW_SCHEMAS.captures.safeParse({ ...cap, owner_id: OWNER }).success).toBe(false);
    expect(ROW_SCHEMAS.captures.safeParse({ ...cap, extra: 1 }).success).toBe(false);
    expect(ROW_SCHEMAS.assets.safeParse({ ...tables().assets[0]!, key: '../x' }).success).toBe(false);
  });

  it('제외 표와 내보내기 표는 겹치지 않는다', () => {
    for (const t of Object.keys(EXCLUDED_TABLES)) expect((EXPORTED_TABLES as readonly string[]).includes(t)).toBe(false);
  });
});

describe('parseBundle', () => {
  const good = () => buildBundle(input()).entries;

  it('정상 묶음: 표·asset 바이트·manifest sha256', () => {
    const p = parseBundle(roundTrip(good()), { migrations: [...MIGRATIONS, '0002_c'] });
    expect(p.tables.captures[0]!.raw_text).toBe(RAW);
    expect(Buffer.from(p.assetBytes.get(ASSET)!).equals(Buffer.from(PNG))).toBe(true);
    expect(p.manifestSha256).toBe(sha256Hex(good()[0]!.bytes));
  });

  it('data/captures.json 한 바이트 변조 → manifest_mismatch(경로 포함)', () => {
    const entries = good().map((e) => {
      if (e.path !== 'data/captures.json') return e;
      const b = new Uint8Array(e.bytes);
      b[10] = b[10]! ^ 0x01;
      return { path: e.path, bytes: b };
    });
    try {
      parseBundle(roundTrip(entries), { migrations: MIGRATIONS });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BundleError);
      expect((e as BundleError).code).toBe('manifest_mismatch');
      expect((e as BundleError).extra).toEqual({ paths: ['data/captures.json'] });
    }
  });

  it('목록에 없는 파일 추가·파일 삭제도 manifest_mismatch', () => {
    const extra = [...good(), { path: 'data/sessions.json', bytes: new Uint8Array([1]) }];
    expect(() => parseBundle(extra, { migrations: MIGRATIONS })).toThrow(expect.objectContaining({ code: 'manifest_mismatch' }));
    const missing = good().filter((e) => !e.path.startsWith('assets/'));
    expect(() => parseBundle(missing, { migrations: MIGRATIONS })).toThrow(expect.objectContaining({ code: 'manifest_mismatch' }));
  });

  it('더 새로운 migration 에서 만든 묶음은 schema_incompatible', () => {
    expect(() => parseBundle(good(), { migrations: ['0000_a'] })).toThrow(expect.objectContaining({ code: 'schema_incompatible' }));
    expect(() => parseBundle(good(), { migrations: ['0000_a', '0001_x'] })).toThrow(expect.objectContaining({ code: 'schema_incompatible' }));
  });

  it('형식 버전이 다르면 unsupported_version, manifest 없으면 invalid_bundle', () => {
    const entries = good();
    const m = JSON.parse(new TextDecoder().decode(entries[0]!.bytes));
    m.format_version = 2;
    const v2 = [{ path: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(m)) }, ...entries.slice(1)];
    expect(() => parseBundle(v2, { migrations: MIGRATIONS })).toThrow(expect.objectContaining({ code: 'unsupported_version' }));
    expect(() => parseBundle(entries.slice(1), { migrations: MIGRATIONS })).toThrow(expect.objectContaining({ code: 'invalid_bundle' }));
  });

  it('manifest 까지 맞춰 고친 묶음이라도 행에 모르는 열이 있으면 invalid_rows, 참조가 끊기면 integrity', () => {
    const withOwner = tables();
    (withOwner.captures[0] as Record<string, unknown>).owner_id = OWNER;
    expect(() => parseBundle(buildBundle(input({ tables: withOwner })).entries, { migrations: MIGRATIONS })).toThrow(
      expect.objectContaining({ code: 'invalid_rows' }),
    );
    const broken = tables();
    broken.content_captures[0]!.capture_id = '99999999-9999-4999-8999-999999999999';
    expect(() => parseBundle(buildBundle(input({ tables: broken })).entries, { migrations: MIGRATIONS })).toThrow(
      expect.objectContaining({ code: 'integrity' }),
    );
    const wrongCurrent = tables();
    wrongCurrent.contents[0]!.current_version_id = '99999999-9999-4999-8999-999999999999';
    expect(() => parseBundle(buildBundle(input({ tables: wrongCurrent })).entries, { migrations: MIGRATIONS })).toThrow(
      expect.objectContaining({ code: 'integrity' }),
    );
  });

  it('asset 바이트를 바꾸고 manifest.files 까지 맞춰도 assets.checksum 과 다르면 거부', () => {
    const other = new Uint8Array([...PNG, 9]);
    const b = buildBundle(input());
    const m = JSON.parse(new TextDecoder().decode(b.manifestBytes));
    const p = `assets/${ASSET}.png`;
    const f = m.files.find((x: { path: string }) => x.path === p);
    f.sha256 = sha256Hex(other);
    f.bytes = other.byteLength;
    const entries = [
      { path: 'manifest.json', bytes: new TextEncoder().encode(stableStringify(m)) },
      ...b.entries.slice(1).map((e) => (e.path === p ? { path: p, bytes: other } : e)),
    ];
    expect(() => parseBundle(entries, { migrations: MIGRATIONS })).toThrow(expect.objectContaining({ code: 'manifest_mismatch' }));
  });
});
