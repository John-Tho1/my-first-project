import { describe, expect, it } from 'vitest';
import {
  approveSchema,
  buildCanonicalPayload,
  canItemTransition,
  canonicalJson,
  canVariantTransition,
  computePlanStatus,
  executeSchema,
  InvalidScheduleError,
  payloadHash,
  planCreateSchema,
  revokeSchema,
  scheduleFromMsk,
  ScheduleInPastError,
  zonedWallTimeToUtc,
  type CanonicalPayloadInput,
} from './distribution';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const H = 'a'.repeat(64);

describe('canonicalJson / payloadHash', () => {
  it('키 순서와 무관하게 같은 문자열·hash', () => {
    const a = { b: 1, a: { d: [1, 2], c: 'x' } };
    const b = { a: { c: 'x', d: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });
  it('문자열은 NFC 로 정규화(분해형 한글 = 완성형)', () => {
    const composed = '한글';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    expect(canonicalJson({ t: decomposed })).toBe(canonicalJson({ t: composed }));
    expect(payloadHash({ t: decomposed })).toBe(payloadHash({ t: composed }));
  });
  it('배열 순서는 의미가 있다(다른 hash)', () => {
    expect(payloadHash({ a: [1, 2] })).not.toBe(payloadHash({ a: [2, 1] }));
  });
  it('undefined 는 빠지고 null 은 남는다', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(payloadHash({ a: undefined, b: null })).toBe(payloadHash({ b: null }));
    expect(payloadHash({ b: null })).not.toBe(payloadHash({}));
  });
  it('hash 는 실행마다 같다(고정 값)', () => {
    expect(payloadHash({ x: 1 })).toBe('5041bf1f713df204784353e82f6a4a535931cb64f1f4b4a5aeaffcb720918b22');
    expect(payloadHash({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
  it('유한하지 않은 숫자는 거부', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
  });
});

describe('buildCanonicalPayload', () => {
  const base: CanonicalPayloadInput = {
    contentVersionId: U1,
    variantVersionId: U2,
    brandProfileVersionId: null,
    channelAccountId: U1,
    providerAccountId: 'mock:threads:x',
    channel: 'threads',
    body: '첫 글\n\n둘째 글',
    metadata: { text: '첫 글', thread_parts: ['첫 글', '둘째 글'] },
    assets: [
      { id: U2, checksum: 'c2', role: 'image', position: 2, mime: 'image/png' },
      { id: U1, checksum: 'c1', role: 'image', position: 1, mime: 'image/png' },
    ],
    visibility: 'private',
    scheduledAtUtc: new Date('2026-10-01T09:00:00.000Z'),
    timezone: 'Europe/Moscow',
  };
  it('docs/03 필드만, 첨부는 position 순, provider_metadata 빈 객체, snapshot_version 1', () => {
    const p = buildCanonicalPayload(base);
    expect(Object.keys(p).sort()).toEqual(
      [
        'assets',
        'brand_profile_version_id',
        'channel',
        'channel_account_id',
        'content_version_id',
        'provider_account_id',
        'provider_metadata',
        'scheduled_at_utc',
        'snapshot_version',
        'text',
        'timezone',
        'variant_version_id',
        'visibility',
      ].sort(),
    );
    expect(p.assets.map((a) => a.order)).toEqual([1, 2]);
    expect(p.text).toMatchObject({ posts: ['첫 글', '둘째 글'] });
    expect(p.text.rendered).toContain('둘째 글');
    expect(p.scheduled_at_utc).toBe('2026-10-01T09:00:00.000Z');
    expect(p.provider_metadata).toEqual({});
    expect(p.snapshot_version).toBe(1);
  });
  it('본문·첨부 순서·공개 범위·일정·계정이 바뀌면 hash 가 바뀐다', () => {
    const h = payloadHash(buildCanonicalPayload(base));
    expect(payloadHash(buildCanonicalPayload({ ...base }))).toBe(h);
    expect(payloadHash(buildCanonicalPayload({ ...base, metadata: { text: '첫 글!', thread_parts: ['첫 글!', '둘째 글'] } }))).not.toBe(h);
    expect(payloadHash(buildCanonicalPayload({ ...base, assets: [{ ...base.assets[0]!, position: 3 }, base.assets[1]!] }))).not.toBe(h);
    expect(payloadHash(buildCanonicalPayload({ ...base, visibility: 'public' }))).not.toBe(h);
    expect(payloadHash(buildCanonicalPayload({ ...base, scheduledAtUtc: null }))).not.toBe(h);
    expect(payloadHash(buildCanonicalPayload({ ...base, providerAccountId: 'mock:threads:y' }))).not.toBe(h);
  });
  it('채널별 나가는 글 필드', () => {
    expect(buildCanonicalPayload({ ...base, channel: 'youtube', metadata: { title: 'T', description: 'D', script: 'S', tags: ['a'] } }).text).toMatchObject({
      title: 'T',
      description: 'D',
      tags: ['a'],
    });
    expect(buildCanonicalPayload({ ...base, channel: 'instagram', metadata: { caption: 'C', cards: [{ index: 1, text: 'k' }] } }).text).toMatchObject({
      caption: 'C',
      cards: [{ index: 1, text: 'k' }],
    });
    expect(buildCanonicalPayload({ ...base, channel: 'blog', metadata: { title: 'B', markdown: 'M' } }).text).toMatchObject({ title: 'B', markdown: 'M' });
  });
});

describe('scheduleFromMsk (A13)', () => {
  const now = new Date('2026-09-25T09:00:00.000Z');
  it('2026-10-01 12:00 MSK → 2026-10-01T09:00:00.000Z', () => {
    expect(scheduleFromMsk('2026-10-01', '12:00', now).toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });
  it('Intl 오프셋 계산은 일반적이다(다른 시간대도 맞음)', () => {
    expect(zonedWallTimeToUtc(2026, 1, 15, 12, 0, 'Europe/Berlin')!.toISOString()).toBe('2026-01-15T11:00:00.000Z');
    expect(zonedWallTimeToUtc(2026, 7, 15, 12, 0, 'Europe/Berlin')!.toISOString()).toBe('2026-07-15T10:00:00.000Z');
    // DST 틈(존재하지 않는 시각)은 null
    expect(zonedWallTimeToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin')).toBeNull();
  });
  it('과거·1분 이내 → ScheduleInPastError(400)', () => {
    expect(() => scheduleFromMsk('2026-09-25', '11:59', now)).toThrow(ScheduleInPastError);
    expect(() => scheduleFromMsk('2026-09-25', '12:00', now)).toThrow(ScheduleInPastError); // = now
    expect(() => scheduleFromMsk('2026-09-25', '12:01', now)).toThrow(ScheduleInPastError); // now + 1분
    expect(scheduleFromMsk('2026-09-25', '12:02', now).toISOString()).toBe('2026-09-25T09:02:00.000Z');
    try {
      scheduleFromMsk('2020-01-01', '00:00', now);
    } catch (e) {
      expect((e as ScheduleInPastError).kind).toBe('bad_request');
      expect((e as ScheduleInPastError).code).toBe('schedule_in_past');
    }
  });
  it('형식 오류·없는 날짜 → InvalidScheduleError(400)', () => {
    for (const [d, t] of [
      ['2026-13-01', '10:00'],
      ['2026-02-30', '10:00'],
      ['2026-10-01', '24:00'],
      ['2026/10/01', '10:00'],
      ['2026-10-01', '10:0'],
      ['', ''],
    ] as const) {
      expect(() => scheduleFromMsk(d, t, now), `${d} ${t}`).toThrow(InvalidScheduleError);
    }
  });
});

describe('입력 스키마', () => {
  it('planCreateSchema: approved·approval·approved_by_ai 같은 플래그는 버린다', () => {
    const r = planCreateSchema.parse({
      items: [{ variant_id: U1, channel_account_id: U2, approved: true, approval: { id: 'x' } }],
      approved: true,
      approved_by_ai: true,
      approval: true,
    });
    expect(r).toEqual({ items: [{ variant_id: U1, channel_account_id: U2 }] });
    expect(JSON.stringify(r)).not.toContain('approv');
  });
  it('planCreateSchema: 항목 1~20, UUID, 대문자 ID 는 소문자로', () => {
    expect(planCreateSchema.safeParse({ items: [] }).success).toBe(false);
    expect(planCreateSchema.safeParse({ items: [{ variant_id: 'x', channel_account_id: U2 }] }).success).toBe(false);
    expect(planCreateSchema.safeParse({ items: Array.from({ length: 21 }, () => ({ variant_id: U1, channel_account_id: U2 })) }).success).toBe(false);
    expect(planCreateSchema.parse({ items: [{ variant_id: U1.toUpperCase(), channel_account_id: U2 }] }).items[0]!.variant_id).toBe(U1);
  });
  it('approveSchema: confirm=true 필수, 항목마다 hash 필수, 모르는 키는 버림', () => {
    const ok = { item_ids: [U1], expected_hashes: { [U1]: H }, confirm: true, purpose: 'mock_publish', approved_by_ai: true };
    const parsed = approveSchema.parse(ok);
    expect(parsed).toEqual({ item_ids: [U1], expected_hashes: { [U1]: H }, confirm: true, purpose: 'mock_publish' });
    expect(approveSchema.safeParse({ ...ok, confirm: false }).success).toBe(false);
    expect(approveSchema.safeParse({ ...ok, confirm: 'true' }).success).toBe(false);
    expect(approveSchema.safeParse({ ...ok, confirm: undefined }).success).toBe(false);
    expect(approveSchema.safeParse({ ...ok, expected_hashes: {} }).success).toBe(false);
    expect(approveSchema.safeParse({ ...ok, expected_hashes: { [U1]: 'nothex' } }).success).toBe(false);
    expect(approveSchema.safeParse({ ...ok, item_ids: [U1, U1] }).success).toBe(false);
    expect(approveSchema.safeParse({ ...ok, purpose: undefined }).success).toBe(false);
    // 선택하지 않은 항목의 hash(추가 키)는 무시
    expect(approveSchema.safeParse({ ...ok, expected_hashes: { [U1]: H, [U2]: H } }).success).toBe(true);
  });
  it('executeSchema: command_key 8~64 [A-Za-z0-9_-]', () => {
    expect(executeSchema.safeParse({ command_key: 'abcd1234' }).success).toBe(true);
    expect(executeSchema.safeParse({ command_key: 'short' }).success).toBe(false);
    expect(executeSchema.safeParse({ command_key: 'a'.repeat(65) }).success).toBe(false);
    expect(executeSchema.safeParse({ command_key: 'abcd 1234' }).success).toBe(false);
    expect(executeSchema.safeParse({ command_key: 'abcd1234', item_ids: [] }).success).toBe(false);
  });
  it('revokeSchema: reason ≤ 200', () => {
    expect(revokeSchema.safeParse({}).success).toBe(true);
    expect(revokeSchema.safeParse({ reason: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('상태 규칙', () => {
  it('파생본: approved 는 승인으로만, 철회 → review, 새 버전 → draft, 사용자는 draft↔review', () => {
    expect(canVariantTransition('review', 'approved', 'approval')).toBe(true);
    expect(canVariantTransition('draft', 'approved', 'approval')).toBe(false);
    expect(canVariantTransition('review', 'approved', 'user')).toBe(false);
    expect(canVariantTransition('approved', 'review', 'revoke')).toBe(true);
    expect(canVariantTransition('approved', 'draft', 'new_version')).toBe(true);
    expect(canVariantTransition('approved', 'review', 'user')).toBe(false);
    expect(canVariantTransition('draft', 'review', 'user')).toBe(true);
  });
  it('항목: T10 전이는 PLANNED→QUEUED·BLOCKED, QUEUED→PLANNED 뿐', () => {
    expect(canItemTransition('PLANNED', 'QUEUED')).toBe(true);
    expect(canItemTransition('QUEUED', 'PLANNED')).toBe(true);
    expect(canItemTransition('QUEUED', 'CONFIRMED')).toBe(false);
    expect(canItemTransition('CONFIRMED', 'QUEUED')).toBe(false);
  });
  it('computePlanStatus', () => {
    const P = (activeApproval: boolean) => ({ status: 'PLANNED', activeApproval });
    expect(computePlanStatus([])).toBe('draft');
    expect(computePlanStatus([P(false), P(false)])).toBe('draft');
    expect(computePlanStatus([P(true), P(false)])).toBe('partially_approved');
    expect(computePlanStatus([P(true), P(true)])).toBe('approved');
    expect(computePlanStatus([{ status: 'QUEUED', activeApproval: true }, P(false)])).toBe('executing');
    expect(computePlanStatus([{ status: 'CONFIRMED', activeApproval: true }])).toBe('completed');
    expect(computePlanStatus([{ status: 'CONFIRMED', activeApproval: true }, { status: 'FAILED', activeApproval: true }])).toBe('partial');
  });
});
