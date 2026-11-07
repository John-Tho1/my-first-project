import { describe, expect, it } from 'vitest';
import { formatMsk } from './time';

describe('formatMsk', () => {
  it('UTC 순간을 MSK(UTC+3)로 표시한다', () => {
    expect(formatMsk(new Date('2026-09-24T09:05:00Z'))).toBe('2026-09-24 12:05 (MSK)');
  });
  it('날짜 경계를 넘는 경우', () => {
    expect(formatMsk('2026-12-31T22:30:00Z')).toBe('2027-01-01 01:30 (MSK)');
  });
  it('자정은 00 으로 표시한다(24 아님)', () => {
    expect(formatMsk('2026-03-01T21:00:00Z')).toBe('2026-03-02 00:00 (MSK)');
  });
  it('유효하지 않은 시각은 거부', () => {
    expect(() => formatMsk('not-a-date')).toThrow(RangeError);
  });
});
