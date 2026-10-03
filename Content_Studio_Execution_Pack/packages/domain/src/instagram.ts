/**
 * T16(제안 결정 D29) Instagram 조건부 연결 — **모의만**. 채널 공통 규칙(잠정 규격·이미지 크기 읽기·캡션 검사)과 공개 미디어 URL 창구.
 *
 * - 규격 숫자는 모두 **잠정값**(docs/03 "Instagram [공식자료·부분 확인] — 상세 scope/API 경로·미디어 제한은 M4 구현 전에 재확인").
 *   공식 문서를 확인하지 못했으므로 사실로 고정하지 않는다(checked_at·api_version null). live 전에 사용자 확인·공식 재확인으로 바꾼다.
 * - 이미지 크기는 파일 앞부분(헤더)만 읽어 형식별(JPEG SOF·PNG IHDR·WebP VP8/VP8L/VP8X)로 해석한다. 디코딩·재생 검증은 하지 않는다(D15 범위와 같음).
 * - 검사는 두 번: 승인 전(approval blocker — `media_spec:<코드>`) + 보내기 직전(어댑터 — 원격 호출 없이 FAILED). 원격(모의)도 다시 거부한다(400).
 * - 공개 미디어 URL: 실제 Instagram API 는 공개적으로 접근 가능한 URL 에서 미디어를 가져간다. 여기에는 **인터페이스와 모의 구현만** 있다
 *   (`mock://public-media/<불투명 값>` — 실제 호스팅 없음, URL 에 파일 내용·asset ID·owner 없음). 실제 설계(이 앱의 짧은 서명 URL / 제3자 호스팅 /
 *   수동)는 live 전에 **사용자 결정**(개인정보 영향).
 */
import type { MediaFile, MediaPort } from './jobs';
import { INSTAGRAM_CAPTION_MAX, INSTAGRAM_MAX_CARDS, cpLength } from './channel';

/** 잠정 Instagram 이미지·캡션 규격(공식 재확인 전). */
export interface InstagramMediaSpec {
  image_mimes: readonly string[];
  max_image_bytes: number;
  /** 가로 ÷ 세로 최소(세로형 한도) */
  min_aspect: number;
  /** 가로 ÷ 세로 최대(가로형 한도) */
  max_aspect: number;
  min_width: number;
  carousel_min_items: number;
  carousel_max_items: number;
  caption_max: number;
  max_hashtags: number;
  max_mentions: number;
  /** 크기를 읽으려고 앞부분을 읽는 최대 바이트(JPEG 는 EXIF 뒤에 SOF 가 온다) */
  header_read_bytes: number;
  checked_at: string | null;
  api_version: string | null;
  source: string;
}

export const INSTAGRAM_PROVISIONAL_MEDIA_SPEC: Readonly<InstagramMediaSpec> = Object.freeze({
  image_mimes: Object.freeze(['image/jpeg']) as readonly string[],
  max_image_bytes: 8 * 1024 * 1024,
  min_aspect: 4 / 5,
  max_aspect: 1.91,
  min_width: 320,
  carousel_min_items: 2,
  carousel_max_items: INSTAGRAM_MAX_CARDS,
  caption_max: INSTAGRAM_CAPTION_MAX,
  max_hashtags: 30,
  max_mentions: 20,
  header_read_bytes: 256 * 1024,
  checked_at: null,
  api_version: null,
  source: 'provisional — JPEG·8MiB·가로세로 4:5~1.91:1·가로 ≥320px·캐러셀 2~10·캡션 2200·해시태그 30·언급 20, 공식 자료 재확인 전(docs/03, D29 제안)',
});

/** 비율 경계 허용 오차(1080×1350 = 0.8 처럼 정확히 경계인 값이 부동소수로 밀리지 않게). */
const ASPECT_EPSILON = 0.005;

// ---- 이미지 크기(헤더만) ----

export interface ImageDimensions {
  format: 'jpeg' | 'png' | 'webp';
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

/** JPEG SOF 표식(크기가 들어 있는 프레임 머리) — DHT(C4)·JPG(C8)·DAC(CC)는 아니다. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * 파일 앞부분에서 가로·세로를 읽는다(순수, 디코딩 없음). 모르는 형식·잘린 헤더·0 크기는 null.
 * JPEG: 표식을 따라가 SOF 의 높이·너비. PNG: IHDR. WebP: VP8(손실)·VP8L(무손실)·VP8X(확장).
 */
export function imageDimensions(head: Uint8Array): ImageDimensions | null {
  const b = head;
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') {
    const width = u32be(b, 16);
    const height = u32be(b, 20);
    return width > 0 && height > 0 ? { format: 'png', width, height } : null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < b.length) {
      if (b[i] !== 0xff) return null;
      // 채움 0xFF 건너뛰기
      while (i < b.length && b[i] === 0xff) i++;
      if (i >= b.length) return null;
      const m = b[i]!;
      i++;
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue; // 길이 없는 표식
      if (m === 0xd9 || m === 0xda) return null; // 이미지 끝·스캔 시작 전에 SOF 가 없었다
      if (i + 1 >= b.length) return null;
      const len = u16be(b, i);
      if (len < 2) return null;
      if (JPEG_SOF.has(m)) {
        // FIX-T16: SOF 머리 길이는 최소 11(정밀도 1 + 높이 2 + 너비 2 + 성분 수 1 + 성분 1개 3 + 길이 2) — 짧거나 잘린 머리는 읽지 않는다.
        if (len < 11 || i + len > b.length) return null;
        const height = u16be(b, i + 3);
        const width = u16be(b, i + 5);
        return width > 0 && height > 0 ? { format: 'jpeg', width, height } : null;
      }
      i += len;
    }
    return null;
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8 ') {
      const width = (b[26]! | (b[27]! << 8)) & 0x3fff;
      const height = (b[28]! | (b[29]! << 8)) & 0x3fff;
      return width > 0 && height > 0 ? { format: 'webp', width, height } : null;
    }
    if (chunk === 'VP8L') {
      const width = 1 + (((b[22]! & 0x3f) << 8) | b[21]!);
      const height = 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6));
      return { format: 'webp', width, height };
    }
    if (chunk === 'VP8X') {
      const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
      const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
      return { format: 'webp', width, height };
    }
  }
  return null;
}

// ---- 캡션 ----

/** 해시태그(#단어) 수 — 문자·숫자·밑줄. */
export function countHashtags(caption: string): number {
  return (caption.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/** 언급(@사용자) 수 — 영문·숫자·밑줄·마침표(잠정 규칙). 이메일 주소(앞이 글자)는 세지 않는다. */
export function countMentions(caption: string): number {
  return (caption.match(/(^|[^\p{L}\p{N}_.])@[A-Za-z0-9_.]+/gu) ?? []).length;
}

/** 캡션 문제(코드만 — `media_spec:` 접두는 호출자가 붙이지 않아도 되게 여기서 붙인다). */
export function instagramCaptionProblems(caption: string, spec: InstagramMediaSpec = INSTAGRAM_PROVISIONAL_MEDIA_SPEC): string[] {
  const out: string[] = [];
  if (cpLength(caption) > spec.caption_max) out.push('media_spec:caption_too_long');
  if (countHashtags(caption) > spec.max_hashtags) out.push('media_spec:too_many_hashtags');
  if (countMentions(caption) > spec.max_mentions) out.push('media_spec:too_many_mentions');
  return out;
}

// ---- 미디어 ----

/** 승인 스냅샷 첨부 하나의 규격 판단 재료(order = 스냅샷 순서 번호). 크기를 읽지 못했으면 width·height null. */
export interface InstagramMediaFacts {
  order: number;
  role: string;
  mime: string;
  bytes: number | null;
  width: number | null;
  height: number | null;
}

/**
 * 미디어 문제(순수). T16 범위: 이미지(단일) + 캐러셀(이미지 2~10). 영상·Reels·썸네일·첨부 역할은 범위 밖(코드로 거부 — 승인한 첨부를 일부만
 * 보내지 않는다). 문제 코드 `media_spec:<코드>[:<order>]`.
 */
export function instagramMediaProblems(media: readonly InstagramMediaFacts[], spec: InstagramMediaSpec = INSTAGRAM_PROVISIONAL_MEDIA_SPEC): string[] {
  const out: string[] = [];
  const images = media.filter((m) => m.role === 'image');
  for (const m of media) {
    if (m.role === 'video') out.push(`media_spec:video_not_supported_t16:${m.order}`);
    else if (m.role !== 'image') out.push(`media_spec:role_not_supported_t16:${m.order}`);
  }
  if (images.length === 0) out.push('media_spec:no_image');
  if (images.length > spec.carousel_max_items) out.push('media_spec:too_many_images');
  for (const m of images) {
    if (!spec.image_mimes.includes(m.mime)) out.push(`media_spec:mime_not_allowed:${m.order}`);
    if (m.bytes !== null && m.bytes > spec.max_image_bytes) out.push(`media_spec:too_large:${m.order}`);
    if (m.width === null || m.height === null) {
      out.push(`media_spec:dimensions_unreadable:${m.order}`);
      continue;
    }
    const aspect = m.width / m.height;
    if (aspect < spec.min_aspect - ASPECT_EPSILON || aspect > spec.max_aspect + ASPECT_EPSILON) out.push(`media_spec:aspect_out_of_range:${m.order}`);
    if (m.width < spec.min_width) out.push(`media_spec:width_too_small:${m.order}`);
  }
  return out;
}

/** 캡션 + 미디어 문제(순서 고정, 중복 없음). */
export function instagramSpecProblems(input: { caption: string; media: readonly InstagramMediaFacts[] }, spec: InstagramMediaSpec = INSTAGRAM_PROVISIONAL_MEDIA_SPEC): string[] {
  return [...new Set([...instagramMediaProblems(input.media, spec), ...instagramCaptionProblems(input.caption, spec)])];
}

/** 승인 스냅샷 첨부(payload.assets 한 칸) */
export interface SnapshotAssetLike {
  id: string;
  checksum: string;
  role: string;
  order: number;
  mime: string;
}

/**
 * 첨부마다 규격 판단 재료를 모은다. 이미지는 MediaPort(VERIFIED·같은 checksum·지워지지 않은 owner 파일만)로 열어 앞부분만 읽는다.
 * 열 수 없으면 `media_spec:media_unavailable:<코드>:<order>`(예: media_not_verified·media_changed·media_reader_unavailable).
 */
export async function instagramMediaFacts(
  port: MediaPort,
  assets: readonly SnapshotAssetLike[],
  spec: InstagramMediaSpec = INSTAGRAM_PROVISIONAL_MEDIA_SPEC,
): Promise<{ facts: InstagramMediaFacts[]; problems: string[]; files: Map<number, MediaFile> }> {
  const facts: InstagramMediaFacts[] = [];
  const problems: string[] = [];
  const files = new Map<number, MediaFile>();
  for (const a of assets) {
    if (a.role !== 'image') {
      facts.push({ order: a.order, role: a.role, mime: a.mime, bytes: null, width: null, height: null });
      continue;
    }
    const opened = await port.open({ id: a.id, checksum: a.checksum, mime: a.mime });
    if (!opened.ok) {
      problems.push(`media_spec:media_unavailable:${opened.code}:${a.order}`);
      facts.push({ order: a.order, role: a.role, mime: a.mime, bytes: null, width: null, height: null });
      continue;
    }
    const f = opened.file;
    files.set(a.order, f);
    let dims: ImageDimensions | null = null;
    if (f.bytes > 0) {
      try {
        dims = imageDimensions(await f.read(0, Math.min(f.bytes, spec.header_read_bytes)));
      } catch {
        dims = null;
      }
    }
    // FIX-T16(Codex 놓친 케이스): 메타데이터 MIME 과 실제 형식(헤더)이 다르면 문제(예: image/jpeg 로 기록된 PNG·WebP). 형식 허용 판단은 둘 중
    // 하나라도 허용 밖이면 허용 밖(실제 형식이 허용 밖이면 실제 형식, 아니면 기록된 MIME 으로 판단).
    const actual = dims ? `image/${dims.format}` : f.mime;
    if (dims && actual !== f.mime) problems.push(`media_spec:mime_mismatch:${a.order}`);
    const judged = spec.image_mimes.includes(actual) ? f.mime : actual;
    facts.push({ order: a.order, role: a.role, mime: judged, bytes: f.bytes, width: dims?.width ?? null, height: dims?.height ?? null });
  }
  return { facts, problems, files };
}

/** 첨부를 열어 규격 전체를 검사한다(승인 전·보내기 직전 공용). 문제 코드 목록(없으면 []). */
export async function instagramSnapshotSpecProblems(
  port: MediaPort,
  input: { caption: string; assets: readonly SnapshotAssetLike[] },
  spec: InstagramMediaSpec = INSTAGRAM_PROVISIONAL_MEDIA_SPEC,
): Promise<string[]> {
  const { facts, problems } = await instagramMediaFacts(port, input.assets, spec);
  // 열지 못한 이미지는 크기 문제(dimensions_unreadable)를 또 내지 않는다 — 원인 하나만.
  const unavailable = new Set(problems.map((p) => Number(p.split(':').at(-1))));
  const judged = instagramSpecProblems({ caption: input.caption, media: facts }, spec).filter((p) => {
    const m = /^media_spec:dimensions_unreadable:(\d+)$/.exec(p);
    return !(m && unavailable.has(Number(m[1])));
  });
  return [...new Set([...problems, ...judged])];
}

/** 화면 문구(문제 코드 → 한국어). 모르는 코드는 원문. */
export function instagramSpecProblemLabel(code: string): string {
  const parts = code.replace(/^media_spec:/, '').split(':');
  const head = parts[0] ?? '';
  const order = /^\d+$/.test(parts.at(-1) ?? '') ? ` (첨부 ${parts.at(-1)})` : '';
  const s = INSTAGRAM_PROVISIONAL_MEDIA_SPEC;
  switch (head) {
    case 'unchecked':
      return 'Instagram 규격을 확인하지 못함(미디어 읽기 창구 없음) — 승인할 수 없습니다';
    case 'no_image':
      return 'Instagram 이미지가 없습니다(이미지 1개 이상)';
    case 'too_many_images':
      return `Instagram 캐러셀은 이미지 ${s.carousel_max_items}개까지(잠정)`;
    case 'video_not_supported_t16':
      return `영상·Reels 는 T16 모의 범위 밖입니다${order}`;
    case 'role_not_supported_t16':
      return `이미지 외 첨부(썸네일·첨부 파일)는 Instagram 으로 보낼 수 없습니다${order}`;
    case 'mime_not_allowed':
      return `Instagram 이미지는 JPEG 만(잠정)${order}`;
    case 'mime_mismatch':
      return `파일 형식(헤더)이 기록된 MIME 과 다릅니다${order}`;
    case 'too_large':
      return `이미지가 ${(s.max_image_bytes / 1024 / 1024).toFixed(0)}MiB 를 넘습니다(잠정)${order}`;
    case 'dimensions_unreadable':
      return `이미지 크기를 읽을 수 없습니다${order}`;
    case 'aspect_out_of_range':
      return `가로세로 비율이 4:5~1.91:1 밖입니다(잠정)${order}`;
    case 'width_too_small':
      return `이미지 가로가 ${s.min_width}px 보다 작습니다(잠정)${order}`;
    case 'caption_too_long':
      return `캡션이 ${s.caption_max}자를 넘습니다(잠정)`;
    case 'too_many_hashtags':
      return `해시태그가 ${s.max_hashtags}개를 넘습니다(잠정)`;
    case 'too_many_mentions':
      return `언급(@)이 ${s.max_mentions}개를 넘습니다(잠정)`;
    case 'media_unavailable':
      return `이미지 파일을 열 수 없습니다(${parts[1] ?? '?'})${order}`;
    default:
      return code;
  }
}

// ---- 공개 미디어 URL(인터페이스 — 모의 구현만 있다) ----

export interface PublicMediaUrl {
  url: string;
  expiresAt: Date;
}

/**
 * 원격 채널(Instagram)이 미디어를 가져갈 URL 을 발급하는 창구. **T16 에는 모의 구현만**(`mock://public-media/<불투명 값>` — 실제 호스팅 없음,
 * 같은 프로세스의 모의 원격만 저장소 창구를 통해 읽는다). URL 은 원격 단계 기록·작업 이력·감사·로그·내보내기에 남기지 않는다(가져갈 권한이 담긴 값).
 * 실제 구현 방식(이 앱의 짧은 서명 URL·제3자 호스팅·수동)은 live 전 사용자 결정.
 */
export interface PublicMediaUrlProvider {
  readonly id: string;
  readonly mock: boolean;
  issue(input: { file: MediaFile; asset: { id: string; checksum: string; mime: string }; now: Date; ttlMs: number }): Promise<PublicMediaUrl>;
  /** 발급한 URL 을 즉시 못 쓰게 한다(멱등). */
  revoke(url: string): Promise<void>;
}

/** 모의 공개 URL 의 수명(잠정 — 실제 원격이 비동기로 가져가는 시간은 live 전 확인). */
export const PUBLIC_MEDIA_URL_TTL_MS = 10 * 60_000;
export const MOCK_PUBLIC_MEDIA_PREFIX = 'mock://public-media/';
