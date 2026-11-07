import { describe, expect, it } from 'vitest';
import {
  channelDraft,
  cpLength,
  isVariantStale,
  mediaCompleteness,
  paragraphs,
  renderVariantText,
  variantBodyMismatch,
  deriveBodyFields,
  withoutDraftScaffold,
  editableMetadata,
  normalizeNewlines,
  THREADS_MAX_PARTS,
  parseChannelMetadata,
  roleMatchesMime,
  splitByLength,
  THREADS_MAX,
  YOUTUBE_TITLE_MAX,
} from './channel';

describe('채널 초안 변환(결정적)', () => {
  const body = '# 주재원 첫 달\n\n첫 문단입니다.\n\n둘째 문단입니다.';

  it('같은 입력 → 같은 결과', () => {
    expect(channelDraft('threads', 't', body)).toEqual(channelDraft('threads', 't', body));
  });

  it('threads: 문단별 글, 각 ≤500자(코드 포인트), 긴 문단은 잘라 이어짐', () => {
    const long = '가'.repeat(1200);
    const d = channelDraft('threads', '제목', `짧은 문단\n\n${long}`);
    const parts = d.metadata.thread_parts as string[];
    expect(parts[0]).toBe('짧은 문단');
    expect(parts.slice(1).join('')).toBe(long);
    expect(parts.every((p) => cpLength(p) <= THREADS_MAX)).toBe(true);
    expect(d.metadata.text).toBe(parts[0]);
    expect(d.body).toBe(parts.join('\n\n'));
  });

  it('threads: 이모지(서로게이트 쌍)를 반으로 자르지 않는다', () => {
    const emoji = '😀'.repeat(600);
    const parts = splitByLength(emoji, THREADS_MAX);
    expect(parts.map(cpLength)).toEqual([500, 100]);
    expect(parts.join('')).toBe(emoji);
    expect(emoji.length).toBe(1200); // UTF-16 길이로 자르면 깨진다
  });

  it('threads: 빈 본문이면 제목 한 줄', () => {
    expect(channelDraft('threads', '제목만', '').metadata).toEqual({ text: '제목만', thread_parts: ['제목만'] });
  });

  it('instagram: 첫 문단 캡션 + 문단별 카드(최대 10)', () => {
    const many = Array.from({ length: 12 }, (_, i) => `문단 ${i + 1}`).join('\n\n');
    const d = channelDraft('instagram', 't', many);
    expect(d.metadata.caption).toBe('문단 1');
    expect((d.metadata.cards as unknown[]).length).toBe(10);
    expect((d.metadata.cards as Array<{ index: number }>)[9]!.index).toBe(10);
  });

  it('youtube: 첫 줄(# 제거) 제목 ≤100, 나머지 설명, 원고 전체 대본', () => {
    const d = channelDraft('youtube', 't', body);
    expect(d.metadata).toMatchObject({ title: '주재원 첫 달', script: body, tags: [] });
    expect(d.metadata.description).toBe('첫 문단입니다.\n\n둘째 문단입니다.');
    const longTitle = channelDraft('youtube', 't', `${'제'.repeat(150)}\n본문`).metadata.title as string;
    expect(cpLength(longTitle)).toBe(YOUTUBE_TITLE_MAX);
    expect(longTitle.endsWith('…')).toBe(true);
  });

  it('blog: 첫 줄 제목 + 원고 Markdown 그대로', () => {
    expect(channelDraft('blog', 't', body).metadata).toEqual({ title: '주재원 첫 달', markdown: body });
  });

  it('변환 결과는 각 채널 메타데이터 스키마를 통과한다', () => {
    for (const ch of ['threads', 'instagram', 'youtube', 'blog'] as const) {
      const d = channelDraft(ch, '제목', `${body}\n\n${'x'.repeat(3000)}`);
      expect(() => parseChannelMetadata(ch, d.metadata), ch).not.toThrow();
    }
  });

  it('메타데이터 검증: 한도 초과·모르는 칸 거부', () => {
    expect(() => parseChannelMetadata('threads', { text: 'a'.repeat(501), thread_parts: [] })).toThrow(/500자/);
    expect(() => parseChannelMetadata('youtube', { title: '', description: '', script: '', tags: [] })).toThrow();
    expect(() => parseChannelMetadata('blog', { title: 't', markdown: 'm', extra: 1 })).toThrow();
  });

  it('paragraphs: CRLF·여러 빈 줄', () => {
    expect(paragraphs('a\r\n\r\n\r\nb\n  \nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('stale 판정(파생 값)', () => {
  it('버전의 원고 버전 ≠ 원고의 현재 버전이면 stale', () => {
    expect(isVariantStale('v1', 'v1')).toBe(false);
    expect(isVariantStale('v1', 'v2')).toBe(true);
    expect(isVariantStale(null, 'v2')).toBe(false);
    expect(isVariantStale('v1', null)).toBe(true);
  });
});

describe('미디어 완성 여부', () => {
  const img = { role: 'image', mime: 'image/png' };
  const vid = { role: 'video', mime: 'video/mp4' };
  it.each([
    ['threads', [], true],
    ['blog', [], true],
    ['instagram', [], false],
    ['instagram', [img], true],
    ['instagram', [{ role: 'image', mime: 'application/pdf' }], false],
    ['instagram', [{ role: 'attachment', mime: 'image/png' }], false],
    ['youtube', [], false],
    ['youtube', [{ role: 'thumbnail', mime: 'image/png' }], false],
    ['youtube', [vid], true],
    ['youtube', [vid, { role: 'thumbnail', mime: 'image/png' }], true],
    ['youtube', [vid, vid], false],
    ['youtube', [{ role: 'video', mime: 'image/png' }], false],
  ] as const)('%s %j → complete=%s', (ch, items, complete) => {
    expect(mediaCompleteness(ch, items).complete).toBe(complete);
  });

  it('부족한 항목을 이름으로 알려 준다', () => {
    expect(mediaCompleteness('instagram', []).missing).toEqual(['image(이미지 1개 이상)']);
    expect(mediaCompleteness('youtube', []).missing).toEqual(['video(완성 영상 1개)']);
  });

  it('역할과 파일 형식', () => {
    expect(roleMatchesMime('image', 'image/webp')).toBe(true);
    expect(roleMatchesMime('thumbnail', 'application/pdf')).toBe(false);
    expect(roleMatchesMime('video', 'image/png')).toBe(false);
    expect(roleMatchesMime('attachment', 'application/pdf')).toBe(true);
  });
});

describe('FIX-T09: 나가는 글 전체·본문 중복 칸 일치', () => {
  it('renderVariantText 는 채널의 모든 사용자 노출 글을 담는다', () => {
    expect(renderVariantText('threads', 'b', { text: 't', thread_parts: ['p1', 'p2'] })).toBe('b\nt\np1\np2');
    expect(renderVariantText('instagram', 'b', { caption: 'c', cards: [{ index: 1, text: '카드' }] })).toBe('b\nc\n카드');
    expect(renderVariantText('youtube', 'b', { title: 'T', description: 'D', script: 'S', tags: ['x', 'y'] })).toBe('b\nT\nD\nS\nx\ny');
    expect(renderVariantText('blog', 'b', { title: 'T', markdown: 'M' })).toBe('b\nT\nM');
  });
  it('variantBodyMismatch: 본문과 중복 칸이 다르면 true', () => {
    expect(variantBodyMismatch('blog', 'x', { title: 't', markdown: 'x' })).toBe(false);
    expect(variantBodyMismatch('blog', 'x', { title: 't', markdown: 'y' })).toBe(true);
    expect(variantBodyMismatch('instagram', 'c', { caption: 'c', cards: [{ index: 1, text: '다른 글' }] })).toBe(false);
    expect(variantBodyMismatch('instagram', 'c', { caption: 'd', cards: [] })).toBe(true);
    expect(variantBodyMismatch('youtube', 's', { title: 't', description: '', script: 'z', tags: [] })).toBe(true);
    expect(variantBodyMismatch('threads', 'a\n\nb', { text: 'a', thread_parts: ['a', 'b'] })).toBe(false);
    expect(variantBodyMismatch('threads', 'a\n\nb', { text: 'b', thread_parts: ['a', 'b'] })).toBe(true);
    for (const ch of ['threads', 'instagram', 'youtube', 'blog'] as const) {
      const d = channelDraft(ch, 't', '첫 문단\n\n둘째 문단');
      expect(variantBodyMismatch(ch, d.body, d.metadata), ch).toBe(false);
    }
  });
});

describe('M3 화면 FIX D1·D2: 줄바꿈 표기 무시·본문 기준 파생', () => {
  it('D1: 브라우저 폼의 \\r\\n 본문은 네 채널 모두 LF 중복 칸과 같다고 본다', () => {
    expect(variantBodyMismatch('threads', '첫 글\r\n\r\n둘째 글', { text: '첫 글', thread_parts: ['첫 글', '둘째 글'] })).toBe(false);
    expect(variantBodyMismatch('instagram', '캡션 1\r\n\r\n캡션 2', { caption: '캡션 1\n\n캡션 2', cards: [] })).toBe(false);
    expect(variantBodyMismatch('youtube', '대본\r\n둘째 줄', { title: 't', description: '', script: '대본\n둘째 줄', tags: [] })).toBe(false);
    expect(variantBodyMismatch('blog', '# 제목\r\n\r\n본문', { title: '제목', markdown: '# 제목\n\n본문' })).toBe(false);
    // 반대 방향(중복 칸이 CRLF, 본문 LF)과 단독 \r 도 같다
    expect(variantBodyMismatch('blog', '# 제목\n\n본문', { title: '제목', markdown: '# 제목\r\n\r\n본문' })).toBe(false);
    expect(variantBodyMismatch('instagram', 'a\rb', { caption: 'a\nb', cards: [] })).toBe(false);
    // 내용이 다르면 여전히 불일치
    expect(variantBodyMismatch('threads', '첫 글\r\n\r\n둘째 글', { text: '첫 글', thread_parts: ['첫 글', '다른 글'] })).toBe(true);
    expect(variantBodyMismatch('blog', '# 제목\r\n\r\n본문', { title: '제목', markdown: '# 제목\n\n다른 본문' })).toBe(true);
    expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('D2: deriveBodyFields — 본문이 기준, 나머지 칸은 사용자 값 그대로, 결과는 불일치 없음·스키마 통과', () => {
    const t = deriveBodyFields('threads', '  첫 글 \r\n\r\n\r\n둘째 글\r\n \r\n셋째\r\n', { text: '옛 글', thread_parts: ['옛 글'] });
    expect(t).toEqual({ body: '첫 글\n\n둘째 글\n\n셋째', metadata: { text: '첫 글', thread_parts: ['첫 글', '둘째 글', '셋째'] } });
    const i = deriveBodyFields('instagram', '새 캡션\r\n둘째 줄', { cards: [{ index: 1, text: '카드' }] });
    expect(i).toEqual({ body: '새 캡션\n둘째 줄', metadata: { caption: '새 캡션\n둘째 줄', cards: [{ index: 1, text: '카드' }] } });
    const y = deriveBodyFields('youtube', '대본', { title: '제목', description: '설명', script: '옛 대본', tags: ['a'] });
    expect(y.metadata).toEqual({ title: '제목', description: '설명', script: '대본', tags: ['a'] });
    const b = deriveBodyFields('blog', '# 글\r\n\r\n본문', { title: '글' });
    expect(b.metadata).toEqual({ title: '글', markdown: '# 글\n\n본문' });
    for (const [ch, d] of [['threads', t], ['instagram', i], ['youtube', y], ['blog', b]] as const) {
      expect(variantBodyMismatch(ch, d.body, d.metadata), ch).toBe(false);
      expect(() => parseChannelMetadata(ch, d.metadata), ch).not.toThrow();
    }
    // 빈 본문(threads): 문단 없음 → 빈 목록
    expect(deriveBodyFields('threads', ' \r\n ', {})).toEqual({ body: '', metadata: { text: '', thread_parts: [] } });
  });

  it('D2: threads 문단이 500자를 넘거나 20개를 넘으면 자르지 않고 거부(구체 코드)', () => {
    expect(() => deriveBodyFields('threads', `짧은 글\r\n\r\n${'가'.repeat(THREADS_MAX + 1)}`, {})).toThrow(
      expect.objectContaining({ code: 'thread_part_too_long', extra: { part: 2, max: THREADS_MAX } }),
    );
    expect(() => deriveBodyFields('threads', '가'.repeat(THREADS_MAX), {})).not.toThrow();
    const many = Array.from({ length: THREADS_MAX_PARTS + 1 }, (_, k) => `글 ${k}`).join('\n\n');
    expect(() => deriveBodyFields('threads', many, {})).toThrow(expect.objectContaining({ code: 'thread_too_many_parts' }));
  });

  it('D2: editableMetadata 는 본문에서 만들어지는 칸만 뺀다', () => {
    expect(editableMetadata('threads', { text: 'a', thread_parts: ['a'] })).toEqual({});
    expect(editableMetadata('instagram', { caption: 'c', cards: [{ index: 1, text: 'x' }] })).toEqual({ cards: [{ index: 1, text: 'x' }] });
    expect(editableMetadata('youtube', { title: 'T', description: 'D', script: 'S', tags: [] })).toEqual({ title: 'T', description: 'D', tags: [] });
    expect(editableMetadata('blog', { title: 'T', markdown: 'M' })).toEqual({ title: 'T' });
  });
});

describe('화면 확인 D11: 원고 스캐폴드("> 카드:" 인용 블록·"## 초안")는 제목·캡션에 쓰지 않는다', () => {
  const SCAFFOLD = '> 카드: 주재원으로 첫 달\n> 독자: 해외 영업 실무자\n\n## 초안\n\n주재원 첫 달의 교훈\n\n대리점과 재고 기준을 먼저 합의했다.';
  it('withoutDraftScaffold: 인용 블록 전체와 바로 뒤 "## 초안" 만 건너뛴다', () => {
    expect(withoutDraftScaffold(SCAFFOLD)).toBe('\n주재원 첫 달의 교훈\n\n대리점과 재고 기준을 먼저 합의했다.');
    expect(withoutDraftScaffold('> 원문:\r\n> 메모\r\n\r\n## 초안\r\n\r\n본문')).toBe('\n본문');
    // 스캐폴드가 아닌 인용·제목은 그대로
    expect(withoutDraftScaffold('> 인용문\n\n본문')).toBe('> 인용문\n\n본문');
    expect(withoutDraftScaffold('# 제목\n\n본문')).toBe('# 제목\n\n본문');
    expect(withoutDraftScaffold('본문\n\n## 초안')).toBe('본문\n\n## 초안');
  });
  it('youtube·blog 제목, instagram 캡션은 스캐폴드 다음 줄에서, 대본·Markdown 은 원고 그대로', () => {
    const yt = channelDraft('youtube', '원고 제목', SCAFFOLD);
    expect(yt.metadata.title).toBe('주재원 첫 달의 교훈');
    expect(yt.metadata.description).toBe('대리점과 재고 기준을 먼저 합의했다.');
    expect(yt.metadata.script).toBe(SCAFFOLD);
    expect(yt.body).toBe(SCAFFOLD);
    const bl = channelDraft('blog', '원고 제목', SCAFFOLD);
    expect(bl.metadata).toEqual({ title: '주재원 첫 달의 교훈', markdown: SCAFFOLD });
    const ig = channelDraft('instagram', '원고 제목', SCAFFOLD);
    expect(ig.metadata.caption).toBe('주재원 첫 달의 교훈');
    expect(ig.body).toBe('주재원 첫 달의 교훈');
    for (const d of [yt, bl, ig]) expect(String(d.metadata.title ?? d.metadata.caption)).not.toMatch(/카드:|초안/);
    // 스캐폴드만 있고 본문이 비면 원고 제목으로
    expect(channelDraft('blog', '원고 제목', '> 카드: 아이디어\n\n## 초안\n\n').metadata.title).toBe('원고 제목');
    // 스캐폴드 없는 원고는 예전과 같다
    expect(channelDraft('youtube', 't', '# 주재원 첫 달\n\n본문').metadata.title).toBe('주재원 첫 달');
  });
});

describe('Codex review-FIX-M3p3 P2: 스캐폴드 인용 블록이 없으면 "초안" 제목도 건드리지 않는다', () => {
  it('스캐폴드 없는 원고의 # 초안·## 초안 제목 → youtube·blog·instagram 이 예전처럼 그 제목·첫 문단을 쓴다', () => {
    for (const h of ['# 초안', '## 초안']) {
      const body = `${h}\n\n본문 첫 문단\n\n둘째 문단`;
      expect(withoutDraftScaffold(body), h).toBe(body);
      expect(channelDraft('youtube', '기본 제목', body).metadata.title, h).toBe('초안');
      expect(channelDraft('blog', '기본 제목', body).metadata.title, h).toBe('초안');
      expect(channelDraft('instagram', '기본 제목', body).metadata.caption, h).toBe(h);
    }
    // 앞의 빈 줄도 그대로(줄바꿈만 LF)
    expect(withoutDraftScaffold('\r\n# 초안\r\n본문')).toBe('\n# 초안\n본문');
  });
  it('스캐폴드 + ## 초안 은 여전히 둘 다 건너뛴다, 스캐폴드 뒤의 다른 제목(# 초안)은 남긴다', () => {
    const scaffold = '> 카드: 아이디어\n> 독자: 실무자\n\n## 초안\n\n진짜 첫 줄\n\n둘째';
    expect(channelDraft('youtube', '기본 제목', scaffold).metadata.title).toBe('진짜 첫 줄');
    expect(channelDraft('blog', '기본 제목', scaffold).metadata.title).toBe('진짜 첫 줄');
    expect(channelDraft('instagram', '기본 제목', scaffold).metadata.caption).toBe('진짜 첫 줄');
    expect(withoutDraftScaffold('> 카드: 아이디어\n\n# 초안\n\n본문')).toBe('# 초안\n\n본문');
  });
});
