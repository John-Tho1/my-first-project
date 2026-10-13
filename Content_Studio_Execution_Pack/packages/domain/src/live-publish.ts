/**
 * LIVE-P1(결정 D38 1단계): 실제 Threads 텍스트 게시의 공급자 중립이 아닌 고정 부분 — 순수 값·함수만(네트워크 없음).
 *
 * 공식 문서(2026-10-13 열람 — 출처는 .handoffs/LIVEP1_IMPLEMENTATION_HANDOFF.md):
 * - 텍스트 게시 = 컨테이너 생성(POST /{threads-user-id}/threads, media_type=TEXT, text) → 게시(POST /{threads-user-id}/threads_publish, creation_id).
 * - 글자 수 500(“Text posts are limited to 500 characters”), 이모지는 UTF-8 바이트 수로 센다.
 * - 게시 한도 24시간 이동 창 250 게시물(threads_publishing_limit 의 quota_total·quota_duration 예시와 같음).
 * - 미디어 객체 필드에 공개 범위(visibility·audience)가 없다 → 원격 공개 범위는 'unknown'(“Threads 계정 공개 설정을 따름”).
 *
 * 이 파일은 그 규칙을 서버·화면·시험이 같이 쓰게 한 곳에 둔다. 토큰·URL 은 여기 없다.
 */
import { AppError, GuardError } from './errors';

/** 실제 Threads 게시 어댑터 식별자(전송 의도 sanitized_details.adapter_id). */
export const LIVE_THREADS_ADAPTER_ID = 'live_threads' as const;

/** 공식 글자 수 한도(문서 확인 2026-10-13). */
export const THREADS_LIVE_TEXT_MAX = 500;

/**
 * 이모지로 보는 코드 포인트(Threads 는 이모지를 UTF-8 바이트 수로 센다). 확인할 수 없는 경계(조합 문자 등)는 더 크게 세는 쪽(보수적)으로 둔다:
 * Extended_Pictographic · 이모지 변형 선택자(U+FE0E·FE0F) · ZWJ(U+200D) · 키캡(U+20E3) · 지역 표시 문자(국기) · 피부색 수정자 · 태그 문자.
 */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
function emojiLike(cp: string): boolean {
  const c = cp.codePointAt(0) ?? 0;
  return (
    PICTOGRAPHIC.test(cp) ||
    c === 0xfe0e ||
    c === 0xfe0f ||
    c === 0x200d ||
    c === 0x20e3 ||
    (c >= 0x1f1e6 && c <= 0x1f1ff) ||
    (c >= 0x1f3fb && c <= 0x1f3ff) ||
    (c >= 0xe0020 && c <= 0xe007f)
  );
}
const utf8Bytes = (cp: string): number => new TextEncoder().encode(cp).length;

/**
 * Threads 글자 수(보수적 추정): 이모지 계열 코드 포인트는 UTF-8 바이트 수, 그 밖은 1. 한국어·영문은 글자당 1.
 * 실제 Threads 의 세는 방법(문자소 단위 여부)은 문서에 자세히 없어 확인하지 못했다 — 우리 계산이 더 크게 세도록 한다(초과 게시 시도 방지).
 */
export function threadsTextUnits(text: string): number {
  let n = 0;
  for (const cp of text) n += emojiLike(cp) ? utf8Bytes(cp) : 1;
  return n;
}

/** publication.external_id 접두(실제 결과) — DB CHECK(0044)와 같은 규칙 'threads:<숫자 ID>'. */
export const LIVE_THREADS_EXTERNAL_PREFIX = 'threads:';
/** Threads 원격 ID(사용자·컨테이너·미디어): 숫자 문자열 1~30자리(프로필 /me 의 id 와 같은 규칙 — 2^53 을 넘을 수 있어 문자열로만 다룬다). */
export const isThreadsNumericId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,30}$/.test(v);
export const liveThreadsExternalId = (mediaId: string): string => `${LIVE_THREADS_EXTERNAL_PREFIX}${mediaId}`;
export const LIVE_THREADS_EXTERNAL_ID_RE = /^threads:\d{1,30}$/;

/**
 * remote_steps.remote_id(실제 Threads) — DB CHECK(0044)와 같은 형식. 종류별 접두로 나눠 전역 unique(remote_id)가 종류끼리 부딪히지 않게 한다.
 * - container: 'threads:ct:<컨테이너 ID>'
 * - publish_attempt: 'threads:pa:<컨테이너 ID>' — threads_publish 를 부르기 **직전**에 남기는 표식. 컨테이너마다 하나뿐(unique) → 같은 컨테이너로
 *   두 번 게시를 시도할 수 없다(DB 가 보장). 결과를 모르는 게시 시도 뒤에는 이 표식 때문에 자동으로 다시 게시하지 않는다.
 * - publish: 'threads:post:<미디어 ID>'
 */
export const liveThreadsStepId = {
  container: (id: string) => `threads:ct:${id}`,
  publishAttempt: (containerId: string) => `threads:pa:${containerId}`,
  publish: (id: string) => `threads:post:${id}`,
} as const;
export const LIVE_THREADS_STEP_ID_RE = /^threads:(ct|pa|post):\d{1,30}$/;
/** 'threads:ct:123' → '123'(형식이 아니면 null) */
export function liveThreadsStepRaw(remoteId: string): string | null {
  const m = /^threads:(?:ct|pa|post):(\d{1,30})$/.exec(remoteId);
  return m ? m[1]! : null;
}

/** 공식 permalink 호스트(https 만, 포트·사용자 정보 없음). 형식이 맞지 않는 값은 저장하지 않는다(꾸며낸 URL 금지). */
export const THREADS_PERMALINK_HOSTS: ReadonlySet<string> = new Set(['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net']);
export function isAllowedThreadsPermalink(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 500) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && THREADS_PERMALINK_HOSTS.has(u.hostname) && !u.port && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** 화면 문구: 실제 Threads 게시물의 공개 범위(API 가 게시물별 공개 범위를 주지 않는다 — 문서 확인 2026-10-13). */
export const LIVE_THREADS_VISIBILITY_TEXT = 'Threads 계정 공개 설정을 따름';

/** 실제 게시 실행 안내(실행 명령 결과·감사). */
export const LIVE_EXECUTE_NOTICE = '실제 게시 — 작업 처리기가 승인된 내용 그대로 실제 Threads 계정에 게시합니다(되돌리기 없음).';

/** 실제 게시 준비 조건이 모자람(이름만 — 값 없음). 503. */
export class LivePublishNotReadyError extends GuardError {
  readonly missing: string[];
  constructor(missing: string[]) {
    super('LIVE_PUBLISH_NOT_READY', `실제 게시 조건이 갖춰지지 않았습니다(외부로 아무것도 보내지 않음): ${missing.join(', ')}`);
    this.missing = missing;
  }
}

/** 같은 승인 기록으로 허용한 실제 게시 수(PUBLISH_LIVE_MAX_POSTS)를 다 씀. 429. */
export class LivePublishLimitError extends AppError {
  constructor(extra: { limit: number; used: number }) {
    super(
      'too_many_requests',
      'live_publish_limit',
      '승인된 실제 게시 수(PUBLISH_LIVE_MAX_POSTS)를 모두 써서 게시하지 않았습니다. 새 승인 기록 뒤에만 다시 게시할 수 있습니다.',
      extra,
    );
  }
}
