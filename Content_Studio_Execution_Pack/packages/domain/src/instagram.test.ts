/**
 * T16(D29 제안) Instagram 잠정 규격 — 이미지 크기(헤더만)·캡션·미디어 문제 코드·파일 창구 검사(순수, 네트워크 없음).
 */
import { describe, expect, it } from 'vitest';
import {
  countHashtags,
  countMentions,
  imageDimensions,
  INSTAGRAM_PROVISIONAL_MEDIA_SPEC,
  instagramCaptionProblems,
  instagramMediaProblems,
  instagramSnapshotSpecProblems,
  instagramSpecProblemLabel,
  type InstagramMediaFacts,
} from './instagram';
import type { MediaPort } from './jobs';

/** 합성 JPEG(SOI + APP0 + SOF0(가로·세로) + SOS + 채움 + EOI) — 디코딩 가능한 그림이 아니라 헤더만 맞는 바이트. */
export function syntheticJpeg(width: number, height: number, totalBytes = 2048): Uint8Array {
  const head = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];
  const fixed = head.length + sof.length + sos.length + 2;
  const out = new Uint8Array(Math.max(totalBytes, fixed));
  out.set([...head, ...sof, ...sos], 0);
  for (let i = head.length + sof.length + sos.length; i < out.length - 2; i++) out[i] = (i * 31) % 250;
  out.set([0xff, 0xd9], out.length - 2);
  return out;
}

function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255], 24);
  return b;
}

const fact = (o: Partial<InstagramMediaFacts> & { order: number }): InstagramMediaFacts => ({ role: 'image', mime: 'image/jpeg', bytes: 4096, width: 1080, height: 1080, ...o });

describe('imageDimensions(헤더만)', () => {
  it('JPEG SOF·PNG IHDR·WebP VP8X 의 가로·세로를 읽는다', () => {
    expect(imageDimensions(syntheticJpeg(1080, 1350))).toEqual({ format: 'jpeg', width: 1080, height: 1350 });
    expect(imageDimensions(png(640, 480))).toEqual({ format: 'png', width: 640, height: 480 });
    expect(imageDimensions(webpVp8x(1200, 628))).toEqual({ format: 'webp', width: 1200, height: 628 });
  });
  it('잘린 헤더·SOF 없는 JPEG·모르는 형식·0 크기는 null(추측하지 않는다)', () => {
    expect(imageDimensions(syntheticJpeg(1080, 1080).subarray(0, 24))).toBeNull();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toBeNull();
    expect(imageDimensions(new TextEncoder().encode('GIF89a........................'))).toBeNull();
    expect(imageDimensions(syntheticJpeg(0, 100))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});

describe('캡션(잠정 한도)', () => {
  it('해시태그·언급 수(이메일 주소는 언급이 아님)', () => {
    expect(countHashtags('#해외영업 첫 분기 #sales_ops, 그리고 #3')).toBe(3);
    expect(countHashtags('가격#표 아님')).toBe(0);
    expect(countMentions('@john.doe 와 @team_kr — me@example.com 은 아님')).toBe(2);
  });
  it('길이·해시태그·언급 초과 → media_spec 코드', () => {
    const s = INSTAGRAM_PROVISIONAL_MEDIA_SPEC;
    expect(instagramCaptionProblems('짧은 캡션')).toEqual([]);
    expect(instagramCaptionProblems('가'.repeat(s.caption_max + 1))).toEqual(['media_spec:caption_too_long']);
    expect(instagramCaptionProblems('가'.repeat(s.caption_max))).toEqual([]);
    expect(instagramCaptionProblems(Array.from({ length: s.max_hashtags + 1 }, (_, i) => `#t${i}`).join(' '))).toEqual(['media_spec:too_many_hashtags']);
    expect(instagramCaptionProblems(Array.from({ length: s.max_hashtags }, (_, i) => `#t${i}`).join(' '))).toEqual([]);
    expect(instagramCaptionProblems(Array.from({ length: s.max_mentions + 1 }, (_, i) => `@u${i}`).join(' '))).toEqual(['media_spec:too_many_mentions']);
  });
  it('잠정 규격은 확인일·API 버전 없이 provisional 로 표시된다(사실로 고정하지 않음)', () => {
    expect(INSTAGRAM_PROVISIONAL_MEDIA_SPEC.checked_at).toBeNull();
    expect(INSTAGRAM_PROVISIONAL_MEDIA_SPEC.api_version).toBeNull();
    expect(INSTAGRAM_PROVISIONAL_MEDIA_SPEC.source).toMatch(/^provisional/);
  });
});

describe('instagramMediaProblems(이미지·캐러셀 범위)', () => {
  it('정상: 1:1·4:5(경계)·1.91:1(경계) JPEG, 캐러셀 2~10', () => {
    expect(instagramMediaProblems([fact({ order: 1 })])).toEqual([]);
    expect(instagramMediaProblems([fact({ order: 1, width: 1080, height: 1350 }), fact({ order: 2, width: 1080, height: 566 })])).toEqual([]);
    expect(instagramMediaProblems(Array.from({ length: 10 }, (_, i) => fact({ order: i + 1 })))).toEqual([]);
  });
  it('표: 형식·크기·비율·가로·개수·역할·크기 못 읽음', () => {
    const s = INSTAGRAM_PROVISIONAL_MEDIA_SPEC;
    const table: Array<[InstagramMediaFacts[], string[]]> = [
      [[fact({ order: 1, mime: 'image/png' })], ['media_spec:mime_not_allowed:1']],
      [[fact({ order: 1, bytes: s.max_image_bytes + 1 })], ['media_spec:too_large:1']],
      [[fact({ order: 1, width: 1080, height: 1920 })], ['media_spec:aspect_out_of_range:1']],
      [[fact({ order: 1, width: 2000, height: 1000 })], ['media_spec:aspect_out_of_range:1']],
      [[fact({ order: 1, width: 300, height: 300 })], ['media_spec:width_too_small:1']],
      [[fact({ order: 1, width: null, height: null })], ['media_spec:dimensions_unreadable:1']],
      [[], ['media_spec:no_image']],
      [Array.from({ length: 11 }, (_, i) => fact({ order: i + 1 })), ['media_spec:too_many_images']],
      [[fact({ order: 1 }), fact({ order: 2, role: 'video', mime: 'video/mp4' })], ['media_spec:video_not_supported_t16:2']],
      [[fact({ order: 1 }), fact({ order: 2, role: 'thumbnail' })], ['media_spec:role_not_supported_t16:2']],
    ];
    for (const [media, want] of table) expect(instagramMediaProblems(media)).toEqual(want);
  });
  it('문구: 코드마다 한국어(첨부 순서 포함), 모르는 코드는 원문', () => {
    expect(instagramSpecProblemLabel('media_spec:aspect_out_of_range:2')).toMatch(/4:5~1\.91:1.*첨부 2/);
    expect(instagramSpecProblemLabel('media_spec:unchecked')).toMatch(/확인하지 못함/);
    expect(instagramSpecProblemLabel('media_spec:something_new')).toBe('media_spec:something_new');
  });
});

describe('instagramSnapshotSpecProblems(파일 창구 — 앞부분만 읽음)', () => {
  const files = new Map<string, Uint8Array>();
  const reads: Array<[number, number]> = [];
  const port: MediaPort = {
    open: async (a) => {
      const b = files.get(a.id);
      if (!b) return { ok: false, code: 'media_not_verified' };
      return {
        ok: true,
        file: {
          bytes: b.byteLength,
          mime: a.mime,
          checksum: a.checksum,
          read: async (s, e) => {
            reads.push([s, e]);
            return b.subarray(s, e);
          },
        },
      };
    },
  };
  const asset = (id: string, order: number) => ({ id, checksum: 'c'.repeat(64), role: 'image', order, mime: 'image/jpeg' });
  it('정상 파일은 문제 없음, 읽기는 header_read_bytes 이하', async () => {
    files.set('a', syntheticJpeg(1080, 1080, 400 * 1024));
    reads.length = 0;
    expect(await instagramSnapshotSpecProblems(port, { caption: '캡션', assets: [asset('a', 1)] })).toEqual([]);
    expect(reads.every(([s, e]) => e - s <= INSTAGRAM_PROVISIONAL_MEDIA_SPEC.header_read_bytes)).toBe(true);
  });
  it('비율 밖 파일·열 수 없는 파일(원인 하나만 — 크기 못 읽음을 겹쳐 내지 않음)', async () => {
    files.set('tall', syntheticJpeg(1080, 1920));
    expect(await instagramSnapshotSpecProblems(port, { caption: '', assets: [asset('tall', 1)] })).toEqual(['media_spec:aspect_out_of_range:1']);
    expect(await instagramSnapshotSpecProblems(port, { caption: '', assets: [asset('missing', 3)] })).toEqual(['media_spec:media_unavailable:media_not_verified:3']);
  });
  it('FIX-T16: image/jpeg 로 기록됐지만 실제 PNG·WebP 헤더 → mime_mismatch + (실제 형식 기준) mime_not_allowed', async () => {
    files.set('png', png(1080, 1080));
    expect(await instagramSnapshotSpecProblems(port, { caption: '', assets: [asset('png', 1)] })).toEqual(['media_spec:mime_mismatch:1', 'media_spec:mime_not_allowed:1']);
    files.set('webp', webpVp8x(1080, 1080));
    expect(await instagramSnapshotSpecProblems(port, { caption: '', assets: [asset('webp', 2)] })).toEqual(['media_spec:mime_mismatch:2', 'media_spec:mime_not_allowed:2']);
    expect(instagramSpecProblemLabel('media_spec:mime_mismatch:2')).toContain('MIME');
  });
});

describe('FIX-T16: JPEG SOF 머리 길이', () => {
  it('SOF 길이가 11 미만이거나 머리가 잘렸으면 null(크기를 추측하지 않는다)', () => {
    const ok = syntheticJpeg(1080, 1080);
    expect(imageDimensions(ok)).toEqual({ format: 'jpeg', width: 1080, height: 1080 });
    const short = Uint8Array.from(ok);
    // SOF0 표식은 APP0(20바이트) 뒤 — 길이 두 바이트를 5 로
    expect(short[20]).toBe(0xff);
    expect(short[21]).toBe(0xc0);
    short[22] = 0x00;
    short[23] = 0x05;
    expect(imageDimensions(short)).toBeNull();
    expect(imageDimensions(ok.subarray(0, 30))).toBeNull();
  });
});
