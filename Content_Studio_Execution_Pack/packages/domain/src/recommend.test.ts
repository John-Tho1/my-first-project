import { describe, expect, it } from 'vitest';
import { extractKeywords, recommendArchive, type RecommendCandidate, type RecentSignal } from './recommend';

const now = new Date('2026-10-03T00:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400_000);

describe('핵심어', () => {
  it('조사 제거·불용어·짧은 영문 제외·숫자만 제외, 결정적', () => {
    const k = extractKeywords('딜러와 협상은 재고 회전에서 시작한다. The AI tool and 2026 sales');
    expect([...k].sort()).toEqual(['ai', 'sales', 'tool', '딜러', '시작한다', '재고', '협상', '회전'].filter((x) => x !== 'ai').sort());
    expect([...extractKeywords('딜러와 협상은')]).toEqual([...extractKeywords('딜러와 협상은')]);
  });
});

describe('다시 볼 만한 소재', () => {
  const cands: RecommendCandidate[] = [
    { id: 'c-old-a', title: '딜러 협상 메모', text: '첫 딜러 미팅에서 재고 회전과 협상 순서를 정리', receivedAt: daysAgo(90) },
    { id: 'c-old-b', title: 'AI 보고', text: '보고서 초안 구조', receivedAt: daysAgo(40) },
    { id: 'c-new', title: '딜러 협상 최근', text: '딜러 협상 재고', receivedAt: daysAgo(3) },
    { id: 'c-old-c', title: '여행', text: '휴가 계획', receivedAt: daysAgo(100) },
  ];
  const signals: RecentSignal[] = [
    { kind: 'collected', id: 's1', label: '해외 딜러 첫 미팅에서 확인할 다섯 가지', text: '딜러 협상 전에 재고 회전을 먼저 묻는다', at: daysAgo(1) },
    { kind: 'draft', id: 's2', label: '보고서 초안', text: 'AI 로 보고서 초안 구조 잡기', at: daysAgo(2) },
    { kind: 'collected', id: 's-old', label: '휴가 계획 여행', text: '휴가 계획 여행', at: daysAgo(30) },
  ];

  it('30일 넘은 소재 + 최근 14일 자료와 핵심어 2개 이상 공유 → 이유 줄, 겹침 많은 순', () => {
    const r = recommendArchive({ candidates: cands, signals, dismissed: new Set(), now });
    expect(r.map((x) => x.captureId)).toEqual(['c-old-a', 'c-old-b']);
    expect(r[0]!.signal).toMatchObject({ kind: 'collected', id: 's1' });
    expect(r[0]!.reason).toContain('최근 수집한 글');
    expect(r[0]!.shared).toEqual(expect.arrayContaining(['딜러', '협상', '재고', '회전']));
    expect(r[1]!.reason).toContain('최근 작성 중인 원고');
    // 최근 소재(c-new)는 제외, 14일 지난 자료(s-old)는 신호가 아님 → c-old-c 없음
  });

  it('결정적: 입력 순서를 바꿔도 같은 결과', () => {
    const a = recommendArchive({ candidates: cands, signals, dismissed: new Set(), now });
    const b = recommendArchive({ candidates: [...cands].reverse(), signals: [...signals].reverse(), dismissed: new Set(), now });
    expect(b).toEqual(a);
  });

  it('닫은 소재는 나오지 않는다, 신호가 없으면 빈 목록', () => {
    expect(recommendArchive({ candidates: cands, signals, dismissed: new Set(['c-old-a']), now }).map((x) => x.captureId)).toEqual(['c-old-b']);
    expect(recommendArchive({ candidates: cands, signals: [], dismissed: new Set(), now })).toEqual([]);
  });
});
