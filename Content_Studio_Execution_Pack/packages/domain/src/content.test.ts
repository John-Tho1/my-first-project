import { describe, expect, it } from 'vitest';
import {
  allowedLifecycleOptions,
  assertLifecycleTransition,
  canTransition,
  contentBodyUpdateSchema,
  contentCreateSchema,
  contentMetaPatchSchema,
  draftBodyFromCapture,
  draftTitleFromCapture,
  ideaCreateSchema,
  ideaPatchSchema,
  likePattern,
  makeSnippet,
  normalizeTags,
  parseSearchParams,
  searchTerms,
} from './content';

const U = '11111111-2222-4333-8444-555555555555';

describe('lifecycle 전이', () => {
  it('허용: draft→review→ready→archived, archived→draft, review→draft, ready→review, 같은 상태', () => {
    for (const [a, b] of [
      ['draft', 'review'],
      ['review', 'ready'],
      ['ready', 'archived'],
      ['archived', 'draft'],
      ['review', 'draft'],
      ['ready', 'review'],
      ['draft', 'draft'],
    ] as const) {
      expect(canTransition(a, b), `${a}→${b}`).toBe(true);
      expect(() => assertLifecycleTransition(a, b)).not.toThrow();
    }
  });

  it('거부: draft→ready, draft→archived, review→archived, archived→review, ready→draft, 알 수 없는 현재 상태', () => {
    for (const [a, b] of [
      ['draft', 'ready'],
      ['draft', 'archived'],
      ['review', 'archived'],
      ['archived', 'review'],
      ['ready', 'draft'],
    ] as const) {
      expect(canTransition(a, b), `${a}→${b}`).toBe(false);
      expect(() => assertLifecycleTransition(a, b)).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
    }
    expect(() => assertLifecycleTransition('published', 'draft')).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
  });

  it('화면 선택지는 현재 상태 + 허용 전이', () => {
    expect(allowedLifecycleOptions('ready')).toEqual(['ready', 'archived', 'review']);
  });
});

describe('스키마', () => {
  it('ideaCreateSchema: 필수 idea, 태그 정규화, published 같은 알 수 없는 키 거부', () => {
    const ok = ideaCreateSchema.parse({ idea: ' 카드 ', tags: [' AI ', 'ai', '영업'], capture_ids: [U] });
    expect(ok.idea).toBe('카드');
    expect(ok.tags).toEqual(['AI', '영업']);
    expect(ideaCreateSchema.safeParse({ idea: '' }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ idea: 'x'.repeat(501) }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ idea: 'x', capture_ids: ['not-uuid'] }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ idea: 'x', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ idea: 'x', tags: ['가'.repeat(31)] }).success).toBe(false);
    expect(ideaCreateSchema.safeParse({ idea: 'x', published: true }).success).toBe(false);
  });

  it('ideaPatchSchema: expected_revision 필수, 바꿀 항목 필요', () => {
    expect(ideaPatchSchema.safeParse({ expected_revision: 1, evidence: null }).success).toBe(true);
    expect(ideaPatchSchema.safeParse({ expected_revision: 1 }).success).toBe(false);
    expect(ideaPatchSchema.safeParse({ idea: 'x' }).success).toBe(false);
  });

  it('contentCreateSchema: 제목 1..200, 본문 0..100000', () => {
    expect(contentCreateSchema.safeParse({ title: 't', body: '' }).success).toBe(true);
    expect(contentCreateSchema.safeParse({ title: ' ', body: '' }).success).toBe(false);
    expect(contentCreateSchema.safeParse({ title: 't', body: 'x'.repeat(100_001) }).success).toBe(false);
    expect(contentCreateSchema.safeParse({ title: 't', body: 'b', lifecycle: 'published' }).success).toBe(false);
  });

  it('contentMetaPatchSchema: published 거부, 항목 없으면 거부', () => {
    expect(contentMetaPatchSchema.safeParse({ expected_revision: 1, lifecycle: 'review' }).success).toBe(true);
    expect(contentMetaPatchSchema.safeParse({ expected_revision: 1, lifecycle: 'published' }).success).toBe(false);
    expect(contentMetaPatchSchema.safeParse({ expected_revision: 1 }).success).toBe(false);
    expect(contentMetaPatchSchema.safeParse({ expected_revision: 1, body: 'x' }).success).toBe(false);
  });

  it('contentBodyUpdateSchema: base_version ≥1 정수', () => {
    expect(contentBodyUpdateSchema.safeParse({ base_version: 1, body: '' }).success).toBe(true);
    expect(contentBodyUpdateSchema.safeParse({ base_version: 0, body: 'x' }).success).toBe(false);
    expect(contentBodyUpdateSchema.safeParse({ base_version: 1.5, body: 'x' }).success).toBe(false);
    expect(contentBodyUpdateSchema.safeParse({ body: 'x' }).success).toBe(false);
  });

  it('searchQuerySchema: 기본값·빈 값 무시·cursor 는 type 지정 시만·기간 순서', () => {
    const ok = parseSearchParams(new URLSearchParams('q=주재원&series=&limit=5'));
    expect(ok.success && ok.data).toMatchObject({ q: '주재원', type: 'all', limit: 5 });
    expect(ok.success && 'series' in ok.data).toBe(false);
    expect(parseSearchParams(new URLSearchParams('cursor=abc')).success).toBe(false);
    expect(parseSearchParams(new URLSearchParams('type=captures&cursor=abc')).success).toBe(true);
    expect(parseSearchParams(new URLSearchParams('from=2026-09-10&to=2026-09-01')).success).toBe(false);
    expect(parseSearchParams(new URLSearchParams('lifecycle=published')).success).toBe(false);
    expect(parseSearchParams(new URLSearchParams('limit=51')).success).toBe(false);
    expect(parseSearchParams(new URLSearchParams('unknown=1')).success).toBe(false);
  });
});

describe('검색 보조', () => {
  it('searchTerms: 공백 분리·중복 제거·최대 8개', () => {
    expect(searchTerms('  재고   리스 재고 ')).toEqual(['재고', '리스']);
    expect(searchTerms(undefined)).toEqual([]);
    expect(searchTerms(Array.from({ length: 10 }, (_, i) => `t${i}`).join(' '))).toHaveLength(8);
  });

  it('likePattern: %, _, \\ escape', () => {
    expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });

  it('makeSnippet: 첫 일치 주변 ±60자, 대소문자 무시, 없으면 앞부분', () => {
    const text = `${'가'.repeat(100)}주재원${'나'.repeat(100)}`;
    const s = makeSnippet(text, ['주재원']);
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('주재원');
    expect(Array.from(s.replace(/…/g, '')).length).toBe(123);
    expect(makeSnippet('Hello AI world', ['ai'])).toBe('Hello AI world');
    expect(makeSnippet('짧은 글', ['없음'])).toBe('짧은 글');
  });

  it('normalizeTags: NFC·공백·대소문자 중복 제거', () => {
    expect(normalizeTags(['  a  b ', 'A B', '', '한글'])).toEqual(['a b', '한글']);
  });
});

describe('초안 템플릿', () => {
  it('원문 인용 블록 + 빈 작성 칸', () => {
    expect(draftBodyFromCapture('첫 줄\n둘째 줄')).toBe('> 원문:\n> 첫 줄\n> 둘째 줄\n\n## 초안\n\n');
  });
  it('제목: capture.title 우선, 없으면 원문 첫 60자', () => {
    expect(draftTitleFromCapture('제목', '원문')).toBe('제목');
    expect(draftTitleFromCapture(null, '가'.repeat(70))).toBe(`${'가'.repeat(60)}…`);
    expect(draftTitleFromCapture(null, '짧은\n원문')).toBe('짧은 원문');
  });
});
