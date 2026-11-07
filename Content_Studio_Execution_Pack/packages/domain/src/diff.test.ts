import { describe, expect, it } from 'vitest';
import { diffLines, diffStats, MAX_DIFF_LINES, splitLines } from './diff';

describe('diffLines', () => {
  it('같은 본문 → 모두 same', () => {
    expect(diffLines('a\nb', 'a\nb')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('빈 본문', () => {
    expect(diffLines('', '')).toEqual([]);
    expect(diffLines('', 'x\ny')).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
    expect(diffLines('x', '')).toEqual([{ type: 'del', text: 'x' }]);
  });

  it('가운데 줄 추가·삭제', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'same', text: 'c' },
      { type: 'add', text: 'd' },
    ]);
  });

  it('한국어 줄 교체', () => {
    const d = diffLines('주재원 첫 달\n본사와 현지 사이\n끝', '주재원 첫 달\n본사와 현지 법인 사이\n끝');
    expect(d).toEqual([
      { type: 'same', text: '주재원 첫 달' },
      { type: 'del', text: '본사와 현지 사이' },
      { type: 'add', text: '본사와 현지 법인 사이' },
      { type: 'same', text: '끝' },
    ]);
    expect(diffStats(d)).toEqual({ added: 1, removed: 1, same: 2 });
  });

  it('CRLF 는 LF 와 같게 본다', () => {
    expect(splitLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
    expect(diffLines('a\r\nb', 'a\nb').every((l) => l.type === 'same')).toBe(true);
  });

  it('LCS 는 최소 편집을 고른다(재배열)', () => {
    const d = diffLines('x\na\nb\nc', 'a\nb\nc\nx');
    expect(diffStats(d)).toEqual({ added: 1, removed: 1, same: 3 });
  });

  it('상한(5000줄) 초과 가운데 구간은 전부 삭제 + 전부 추가', () => {
    const a = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 3 }, (_, i) => `b${i}`).join('\n');
    const d = diffLines(a, b);
    expect(diffStats(d)).toEqual({ added: 3, removed: MAX_DIFF_LINES + 1, same: 0 });
    expect(d[0]!.type).toBe('del');
    expect(d.at(-1)!.type).toBe('add');
  });

  it('긴 공통 앞·뒤는 상한과 무관하게 same', () => {
    const common = Array.from({ length: 6000 }, (_, i) => `c${i}`);
    const d = diffLines([...common, 'old'].join('\n'), [...common, 'new'].join('\n'));
    expect(diffStats(d)).toEqual({ added: 1, removed: 1, same: 6000 });
  });
});
