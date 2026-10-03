/**
 * FIX-T18 round 4 (Codex review-FIX3-T18 P2 :706): textarea·xmp 의 닫는 태그를 직접 소비하는 경로도
 * 일반 블록 닫는 태그처럼 줄을 나눈다 — 뒤의 문단·글자·다른 RAWTEXT 요소와 붙지 않게.
 */
import { describe, expect, it } from 'vitest';
import { htmlToText } from './imports';

describe('FIX-T18 round 4 — textarea·xmp 뒤 블록 줄바꿈', () => {
  const cases: Array<[string, string]> = [
    ['<xmp>A</xmp><p>B</p>', 'A\nB'],
    ['<textarea>A</textarea><p>B</p>', 'A\nB'],
    ['<xmp>A</xmp>B', 'A\nB'],
    ['<textarea>A</textarea>B', 'A\nB'],
    ['<xmp>A</xmp><xmp>B</xmp>', 'A\nB'],
    ['<textarea>A</textarea><xmp>B</xmp>', 'A\nB'],
    ['<xmp>A</xmp><textarea>B</textarea>', 'A\nB'],
    ['<p>앞</p><xmp>A&amp;</xmp><p>뒤</p>', '앞\nA&amp;\n뒤'],
    ['<p>앞</p><textarea>A&amp;</textarea><p>뒤</p>', '앞\nA&\n뒤'],
    ['<XMP>A</XMP ><P>B</P>', 'A\nB'],
  ];
  it.each(cases)('%s → 줄이 나뉜다', (html, expected) => {
    expect(htmlToText(html).text).toBe(expected);
  });

  it('닫히지 않은 xmp·textarea 는 끝까지 글자(줄바꿈 추가 없음, 기존 동작)', () => {
    expect(htmlToText('<xmp>A<p>B').text).toBe('A<p>B');
    expect(htmlToText('<textarea>A<p>B').text).toBe('A<p>B');
  });
});
