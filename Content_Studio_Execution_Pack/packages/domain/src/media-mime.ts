/**
 * T08 음성·영상 업로드 형식 — 의존성 없는 순수 모듈(node:* · zod 없음).
 * 서버(`planUpload`)와 브라우저(/record, `@cs/domain/media-mime`)가 같은 목록·같은 정규화를 쓴다.
 *
 * FIX1-FULLREV(F3): 브라우저가 알려 주는 `File.type` 은 정본과 다를 수 있다(Chrome·Safari 는 .m4a 를 `audio/x-m4a` 로,
 * 일부 OS·브라우저는 WAV 를 `audio/x-wav`·`audio/wave`, MP3 를 `audio/mp3` 로 알려 주고, 확장자를 모르면 빈 문자열).
 * `normalizeMediaMime` 은 대소문자·앞뒤 공백·매개변수(`;codecs=…`)를 정리하고 별칭을 정본으로 바꾸며, 형식이 비어 있거나
 * `application/octet-stream` 이면 파일 확장자(MEDIA_EXT 의 역방향)로 추정한다. 허용 목록 밖이면 null.
 * 이것은 **신고 형식**을 정리할 뿐이다 — 완료 시 서버의 서명 판정(`sniffMedia`·`mediaMatches`)이 그대로 최종 판정이며,
 * 신고와 내용이 다르면(예: `audio/x-m4a` 로 신고한 WAV) 여전히 415 mime_mismatch 로 거부된다.
 */

export const ALLOWED_MEDIA_MIME = [
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/webm',
  'video/mp4',
  'video/webm',
  'video/quicktime',
] as const;
export type MediaMime = (typeof ALLOWED_MEDIA_MIME)[number];

export const MEDIA_EXT: Record<MediaMime, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export const isMediaMime = (m: string): m is MediaMime => (ALLOWED_MEDIA_MIME as readonly string[]).includes(m);

/** 브라우저·OS 가 쓰는 별칭 → 정본. Map 이라 `constructor`·`__proto__` 같은 이름이 Object.prototype 으로 새지 않는다. */
const MEDIA_MIME_ALIASES: ReadonlyMap<string, MediaMime> = new Map<string, MediaMime>([
  ['audio/x-m4a', 'audio/mp4'],
  ['audio/m4a', 'audio/mp4'],
  ['audio/x-wav', 'audio/wav'],
  ['audio/wave', 'audio/wav'],
  ['audio/vnd.wave', 'audio/wav'],
  ['audio/mp3', 'audio/mpeg'],
  ['audio/x-mp3', 'audio/mpeg'],
  ['audio/x-mpeg', 'audio/mpeg'],
  ['video/x-m4v', 'video/mp4'],
]);

/** 확장자 → 정본(MEDIA_EXT 의 역방향: mp3·m4a·wav·weba·webm·mp4·mov) */
const EXT_TO_MEDIA_MIME: ReadonlyMap<string, MediaMime> = new Map(
  (Object.entries(MEDIA_EXT) as [MediaMime, string][]).map(([mime, ext]) => [ext, mime] as const),
);

/** 파일 이름의 마지막 확장자로 형식을 추정한다. 확장자가 없거나 목록 밖이면 null. */
function mediaMimeForFileName(fileName: string | null | undefined): MediaMime | null {
  const name = (fileName ?? '').trim();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_MEDIA_MIME.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/**
 * 신고된 형식(브라우저 `File.type` 또는 API 의 mime) → 허용 목록의 정본 형식. 받을 수 없으면 null.
 * - 대소문자·앞뒤 공백·매개변수(`audio/mp4; codecs=mp4a.40.2`)를 정리한다.
 * - 별칭(audio/x-m4a·audio/m4a → audio/mp4, audio/x-wav·audio/wave·audio/vnd.wave → audio/wav,
 *   audio/mp3·audio/x-mp3·audio/x-mpeg → audio/mpeg, video/x-m4v → video/mp4)을 정본으로 바꾼다.
 * - 형식이 비어 있거나 `application/octet-stream` 일 때만 fileName 의 확장자로 추정한다.
 *   다른 형식을 신고했다면(예: image/png 인 x.mp3) 확장자로 덮어쓰지 않고 null.
 */
export function normalizeMediaMime(type: string | null | undefined, fileName?: string | null): MediaMime | null {
  const raw = (type ?? '').trim();
  const essence = raw.split(';', 1)[0]!.trim().toLowerCase();
  if (isMediaMime(essence)) return essence;
  const alias = MEDIA_MIME_ALIASES.get(essence);
  if (alias) return alias;
  if (raw === '' || essence === 'application/octet-stream') return mediaMimeForFileName(fileName);
  return null;
}
