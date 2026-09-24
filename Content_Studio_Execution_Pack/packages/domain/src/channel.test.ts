import { describe, expect, it } from 'vitest';
import {
  channelDraft,
  cpLength,
  isVariantStale,
  mediaCompleteness,
  paragraphs,
  renderVariantText,
  variantBodyMismatch,
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
