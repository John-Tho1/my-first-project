/**
 * FIX round 3(Codex review-FIX-T20 P2, restore-expect.ts:153): 비교 표식은 일반 JSON 값과 겹치지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { OneOf, RESTORE_TIME, SameOrRestoreTime, valueMatches } from './restore-expect';

const W = { from: new Date('2026-10-02T10:00:00.000Z'), to: new Date('2026-10-02T10:00:02.000Z') };

describe('valueMatches — 표식과 일반 값', () => {
  it('일반 JSON {sameOrRestoreTime: "x"} 는 같은 값과 일치하고, 다른 값과는 불일치', () => {
    expect(valueMatches({ sameOrRestoreTime: 'x' }, { sameOrRestoreTime: 'x' }, W)).toBe(true);
    expect(valueMatches({ sameOrRestoreTime: 'x' }, 'x', W)).toBe(false);
    expect(valueMatches({ original: 1 }, { original: 1 }, W)).toBe(true);
  });
  it('RESTORE_TIME: 복원 호출 구간 안(양 끝 포함)만, 밖·null·미래는 불일치', () => {
    expect(valueMatches(RESTORE_TIME, '2026-10-02T10:00:00.000Z', W)).toBe(true);
    expect(valueMatches(RESTORE_TIME, '2026-10-02T10:00:02.000Z', W)).toBe(true);
    expect(valueMatches(RESTORE_TIME, '2026-10-02T09:59:59.999Z', W)).toBe(false);
    expect(valueMatches(RESTORE_TIME, '2026-10-02T10:00:02.001Z', W)).toBe(false);
    expect(valueMatches(RESTORE_TIME, null, W)).toBe(false);
  });
  it('SameOrRestoreTime: 원래 값 또는 구간 안 시각, OneOf: 선택지 중 하나', () => {
    const orig = '2026-01-01T00:00:00.000000Z';
    expect(valueMatches(new SameOrRestoreTime(orig), orig, W)).toBe(true);
    expect(valueMatches(new SameOrRestoreTime(orig), '2026-10-02T10:00:01.000Z', W)).toBe(true);
    expect(valueMatches(new SameOrRestoreTime(orig), '2025-01-01T00:00:00.000000Z', W)).toBe(false);
    expect(valueMatches(new OneOf([null, 'restore_stale']), null, W)).toBe(true);
    expect(valueMatches(new OneOf([null, 'restore_stale']), 'other', W)).toBe(false);
  });
});
