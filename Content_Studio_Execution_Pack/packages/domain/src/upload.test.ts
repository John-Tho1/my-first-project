import { describe, expect, it } from 'vitest';
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from './errors';
import { contentTypeForMime, extensionForMime, sniffMime } from './media';
import {
  chunkCount,
  DEFAULT_CHUNK_BYTES,
  expectedChunkBytes,
  MAX_MEDIA_BYTES,
  mediaMatches,
  MIB,
  missingChunks,
  planUpload,
  sniffMedia,
  uploadProgress,
} from './upload';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const pad = (head: number[], n = 64) => new Uint8Array([...head, ...new Array(Math.max(0, n - head.length)).fill(0)]);

const FIXTURES = {
  mp3Id3: pad([...ascii('ID3'), 4, 0, 0, 0, 0, 0, 0]),
  mp3Frame: pad([0xff, 0xfb, 0x90, 0x64]),
  wav: pad([...ascii('RIFF'), 36, 0, 0, 0, ...ascii('WAVE'), ...ascii('fmt ')]),
  mp4: pad([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('isom'), 0, 0, 2, 0]),
  m4a: pad([0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('M4A '), 0, 0, 0, 0]),
  mov: pad([0, 0, 0, 0x14, ...ascii('ftyp'), ...ascii('qt  '), 0, 0, 0, 0]),
  webm: pad([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii('webm')]),
  matroska: pad([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x88, ...ascii('matroska')]),
  png: pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: pad([...ascii('RIFF'), 36, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 ')]),
  pdf: pad(ascii('%PDF-1.7')),
  jpeg: pad([0xff, 0xd8, 0xff, 0xe0]),
  adts: pad([0xff, 0xf1, 0x50, 0x80]),
  text: new TextEncoder().encode('ID3 가 아닌 평범한 텍스트입니다. 음성 파일이 아닙니다............................'),
};

describe('조각 계획(T08)', () => {
  it('개수·조각 크기: 마지막 조각만 짧다', () => {
    const size = 4 * MIB;
    expect(chunkCount(1, size)).toBe(1);
    expect(chunkCount(size, size)).toBe(1);
    expect(chunkCount(size + 1, size)).toBe(2);
    expect(expectedChunkBytes(size + 1000, size, 0)).toBe(size);
    expect(expectedChunkBytes(size + 1000, size, 1)).toBe(1000);
    expect(expectedChunkBytes(size * 2, size, 1)).toBe(size);
    expect(expectedChunkBytes(size + 1000, size, 2)).toBeNull();
    expect(expectedChunkBytes(size + 1000, size, -1)).toBeNull();
    expect(expectedChunkBytes(size + 1000, size, 0.5)).toBeNull();
    expect(chunkCount(0, size)).toBe(0);
  });

  it('2GiB 영상 = 기본 8MiB 조각 256개, 합계가 정확하다', () => {
    const bytes = MAX_MEDIA_BYTES.video;
    const n = chunkCount(bytes, DEFAULT_CHUNK_BYTES);
    expect(n).toBe(256);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += expectedChunkBytes(bytes, DEFAULT_CHUNK_BYTES, i)!;
    expect(sum).toBe(bytes);
  });

  it('빠진 조각·다음 번호·진행률', () => {
    expect(missingChunks(5, [0, 1, 3])).toEqual({ next: 2, missing: [2, 4] });
    expect(missingChunks(3, [2, 1, 0])).toEqual({ next: null, missing: [] });
    expect(missingChunks(100, [], 3).missing).toEqual([0, 1, 2]);
    expect(uploadProgress(0, 10)).toBe(0);
    expect(uploadProgress(9, 10)).toBe(90);
    expect(uploadProgress(10, 10)).toBe(100);
  });

  it('세션 입력 검사: 형식 415 · 한도 413 · 조각 크기/종류 400', () => {
    expect(planUpload({ kind: 'audio', mime: 'Audio/MPEG', bytes: 10 })).toMatchObject({ mime: 'audio/mpeg', chunkSize: DEFAULT_CHUNK_BYTES, chunks: 1 });
    expect(() => planUpload({ kind: 'audio', mime: 'image/png', bytes: 10 })).toThrow(UnsupportedMediaTypeError);
    expect(() => planUpload({ kind: 'audio', mime: 'video/mp4', bytes: 10 })).toThrow(BadRequestError);
    expect(() => planUpload({ kind: 'audio', mime: 'audio/wav', bytes: MAX_MEDIA_BYTES.audio + 1 })).toThrow(PayloadTooLargeError);
    expect(planUpload({ kind: 'audio', mime: 'audio/wav', bytes: MAX_MEDIA_BYTES.audio }).chunks).toBe(25);
    expect(() => planUpload({ kind: 'video', mime: 'video/webm', bytes: MAX_MEDIA_BYTES.video + 1 })).toThrow(PayloadTooLargeError);
    expect(() => planUpload({ kind: 'video', mime: 'video/webm', bytes: 10, chunk_size: 4 * MIB - 1 })).toThrow(BadRequestError);
    expect(() => planUpload({ kind: 'video', mime: 'video/webm', bytes: 10, chunk_size: 8 * MIB + 1 })).toThrow(BadRequestError);
    expect(planUpload({ kind: 'video', mime: 'video/webm', bytes: 10, sha256: 'A'.repeat(64) }).sha256).toBe('a'.repeat(64));
  });
});

describe('음성·영상 형식 서명(T08)', () => {
  it('허용 형식을 앞부분 바이트로 판정한다', () => {
    expect(sniffMedia(FIXTURES.mp3Id3)).toBe('mp3');
    expect(sniffMedia(FIXTURES.mp3Frame)).toBe('mp3');
    expect(sniffMedia(FIXTURES.wav)).toBe('wav');
    expect(sniffMedia(FIXTURES.mp4)).toBe('mp4');
    expect(sniffMedia(FIXTURES.m4a)).toBe('m4a');
    expect(sniffMedia(FIXTURES.mov)).toBe('mov');
    expect(sniffMedia(FIXTURES.webm)).toBe('webm');
  });

  it('다른 형식·비슷하게 생긴 파일은 거부(null)', () => {
    for (const k of ['png', 'webp', 'pdf', 'jpeg', 'adts', 'text', 'matroska'] as const) expect(sniffMedia(FIXTURES[k]), k).toBeNull();
    expect(sniffMedia(new Uint8Array(0))).toBeNull();
    expect(sniffMedia(FIXTURES.mp4.subarray(0, 8))).toBeNull(); // 너무 짧음
    // ftyp 앞 box 크기가 8 미만이면 거부
    const bad = FIXTURES.mp4.slice();
    bad[3] = 4;
    expect(sniffMedia(bad)).toBeNull();
    // ID3 버전이 이상하면 거부
    const id3 = FIXTURES.mp3Id3.slice();
    id3[3] = 9;
    expect(sniffMedia(id3)).toBeNull();
  });

  it('신고 형식과 서명이 맞아야 한다(mp4 계열·webm 은 음성/영상 둘 다, mov·m4a 는 하나만)', () => {
    expect(mediaMatches('audio/mpeg', 'mp3')).toBe(true);
    expect(mediaMatches('video/mp4', 'mp3')).toBe(false);
    expect(mediaMatches('audio/mp4', 'mp4')).toBe(true);
    expect(mediaMatches('video/mp4', 'mp4')).toBe(true);
    expect(mediaMatches('video/mp4', 'm4a')).toBe(false);
    expect(mediaMatches('video/mp4', 'mov')).toBe(false);
    expect(mediaMatches('video/quicktime', 'mov')).toBe(true);
    expect(mediaMatches('audio/webm', 'webm')).toBe(true);
    expect(mediaMatches('audio/wav', null)).toBe(false);
  });

  it('작은 업로드(T02)의 sniffMime 은 음성·영상을 받지 않는다(업로드 세션으로만)', () => {
    expect(sniffMime(FIXTURES.mp4)).toBeNull();
    expect(sniffMime(FIXTURES.wav)).toBeNull();
  });

  it('다운로드 형식·확장자', () => {
    expect(extensionForMime('audio/mpeg')).toBe('mp3');
    expect(extensionForMime('video/quicktime')).toBe('mov');
    expect(contentTypeForMime('audio/wav')).toBe('audio/wav');
    expect(contentTypeForMime('audio/x-unknown')).toBe('application/octet-stream');
  });
});
