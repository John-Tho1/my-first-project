/**
 * Codex review-FIX-T19 P2 :560 — 입력이 Node Buffer 여도 원본 바이트(rawBytes)는 입력 메모리와 분리된 복사본이어야 한다.
 */
import { describe, expect, it } from 'vitest';
import { copyBytes, parseFeed, parsePage } from './collector';

const RSS =
  '\uFEFF<?xml version="1.0" encoding="utf-8"?>\r\n<rss version="2.0"><channel><title>t</title>' +
  '<item><guid>a</guid><title>제목</title><link>https://feed.mock.example/a</link><description>본문</description></item>' +
  '</channel></rss>';

describe('Codex review-FIX-T19 P2 — Buffer 입력의 원본 바이트는 복사본', () => {
  it('copyBytes 는 Buffer 에서도 메모리를 공유하지 않는다', () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const c = copyBytes(buf, 1, 3);
    buf[1] = 9;
    expect(Array.from(c)).toEqual([2, 3]);
    expect(c.buffer).not.toBe(buf.buffer);
  });

  it('parsePage(Buffer): 입력을 나중에 바꿔도 rawBytes 는 그대로', () => {
    const html = '\uFEFF<html><head><title>T</title></head><body><p>본문</p></body></html>';
    const buf = Buffer.from(html, 'utf8');
    const before = Buffer.from(buf);
    const page = parsePage(buf, 'https://page.mock.example/a');
    buf.fill(0);
    expect(Buffer.from(page.items[0]!.rawBytes).equals(before)).toBe(true);
  });

  it('parseFeed(Buffer): 항목 원본 바이트가 입력과 분리된다', () => {
    const buf = Buffer.from(RSS, 'utf8');
    const feed = parseFeed(buf, 'https://feed.mock.example/feed.xml');
    const item = feed.items[0]!;
    const snapshot = Buffer.from(item.rawBytes);
    buf.fill(0x20);
    expect(Buffer.from(item.rawBytes).equals(snapshot)).toBe(true);
    expect(Buffer.from(item.rawBytes).toString('utf8')).toContain('<guid>a</guid>');
  });
});
