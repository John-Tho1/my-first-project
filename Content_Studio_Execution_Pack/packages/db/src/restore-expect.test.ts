/**
 * FIX round 3(Codex review-FIX-T20 P2, restore-expect.ts:153): 비교 표식은 일반 JSON 값과 겹치지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { bundleTime, RESTORE_TIME, SameOrRestoreTime, valueMatches } from './restore-expect';

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
  it('SameOrRestoreTime: 원래 값 또는 구간 안 시각', () => {
    const orig = '2026-01-01T00:00:00.000000Z';
    expect(valueMatches(new SameOrRestoreTime(orig), orig, W)).toBe(true);
    expect(valueMatches(new SameOrRestoreTime(orig), '2026-10-02T10:00:01.000Z', W)).toBe(true);
    expect(valueMatches(new SameOrRestoreTime(orig), '2025-01-01T00:00:00.000000Z', W)).toBe(false);
  });
});

describe('FIX round 4 — 판정 시각은 묶음 시각 형식으로 정확히 비교', () => {
  it('bundleTime: 마이크로초 6자리 UTC', () => {
    expect(bundleTime(new Date('2026-10-02T10:00:00.123Z'))).toBe('2026-10-02T10:00:00.123000Z');
    expect(valueMatches(bundleTime(new Date('2026-10-02T10:00:00.123Z')), '2026-10-02T10:00:00.123000Z', W)).toBe(true);
    expect(valueMatches(bundleTime(new Date('2026-10-02T10:00:00.123Z')), '2026-10-02T10:00:00.124000Z', W)).toBe(false);
  });
});
