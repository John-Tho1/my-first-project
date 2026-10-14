/**
 * LIVEP1-USERCONFIRM(D38 후속): 결과 불명 실제 Threads 게시의 사용자 확인("Threads에서 확인함") — 순수 판정만(DB·네트워크 없음).
 *
 * 배경: 게시 시도 표식 뒤 결과를 모르면 앱은 본문·시각이 맞는 글을 **확인 후보**(미확인)로만 이력에 남기고 확정하지 않는다(FIX-LIVEP1 P0).
 * 사용자가 후보 링크를 직접 열어 자기 글임을 확인하고 누르면, 그 사실을 **사용자 확인(USER_CONFIRMED)** 으로 기록한다 — 앱이 원격 조회로 검증한
 * VERIFIED 와 다른 값이다. 이 판정·기록은 외부 호출도 재게시도 하지 않는다.
 *
 * 허용 조건(모두, 서버가 항목·작업 잠금 안에서 다시 모은 사실로 판단):
 *  - 항목 계정 = 실제(live) Threads 계정(모의 결과는 사용자 확인이 될 수 없다)
 *  - 항목에 결과(publication)가 아직 없음
 *  - 가장 최근 작업이 UNKNOWN 또는 RECONCILING, 복원한 읽기 전용 이력이 아님
 *  - 그 작업에 게시 시도 표식(publish_attempt)이 있고, 게시 기록(publish — 결정적 미디어 ID)은 없음(있으면 재확인으로 확정)
 *  - 가장 최근 재확인 이력이 형식이 맞는 후보 하나(threads:<숫자> + 공식 Threads 링크)를 남겼고, 요청이 **그 후보 ID 를 그대로** 보냄(낡은 화면 방지)
 */
import { z } from 'zod';
import { AppError } from './errors';
import { isAllowedThreadsPermalink, LIVE_THREADS_EXTERNAL_ID_RE } from './live-publish';

/** 사용자 확인을 받을 수 있는 작업 상태. */
export const USER_CONFIRMABLE_JOB_STATES = ['UNKNOWN', 'RECONCILING'] as const;

/** 거절 코드(모두 409). 순서는 userConfirmProblem 의 검사 순서. */
export const USER_CONFIRM_CODES = [
  'user_confirm_not_live',
  'user_confirm_already_published',
  'user_confirm_not_pending',
  'user_confirm_restored',
  'user_confirm_no_attempt',
  'user_confirm_publish_recorded',
  'user_confirm_no_candidate',
  'user_confirm_candidate_mismatch',
] as const;
export type UserConfirmCode = (typeof USER_CONFIRM_CODES)[number];

/** 화면 경고(버튼 옆). */
export const USER_CONFIRM_WARNING = '후보 링크를 열어 내 글인지 직접 확인한 뒤 누르세요. 앱이 검증한 것은 아닙니다';
/** 화면 버튼 문구. */
export const USER_CONFIRM_BUTTON = 'Threads에서 확인함';
/** 결과 확인 상태 이름(화면 — VERIFIED 의 "확인됨"과 다른 이름·다른 배지 색). */
export const USER_CONFIRMED_LABEL = '사용자 확인';

export interface UserConfirmCandidate {
  external_id: string;
  permalink: string;
}

/**
 * 작업 이력에서 **가장 최근 재확인 이력**(details.reconcile 이 문자열인 사건, event_seq 최대) 하나만 보고 그 후보를 꺼낸다.
 * 그 재확인이 후보를 남기지 않았거나 형식이 틀리면 null(더 앞의 낡은 후보를 꺼내지 않는다). 사용자가 열어 볼 수 있어야 하므로 링크도 필수.
 */
export function userConfirmCandidateFromEvents(events: ReadonlyArray<{ eventSeq: number; sanitizedDetails: Record<string, unknown> }>): UserConfirmCandidate | null {
  let latest: { eventSeq: number; sanitizedDetails: Record<string, unknown> } | null = null;
  for (const e of events) {
    if (typeof (e.sanitizedDetails ?? {}).reconcile !== 'string') continue;
    if (!latest || e.eventSeq > latest.eventSeq) latest = e;
  }
  if (!latest) return null;
  const d = latest.sanitizedDetails;
  const id = d.candidate_external_id;
  const link = d.candidate_permalink;
  if (typeof id !== 'string' || !LIVE_THREADS_EXTERNAL_ID_RE.test(id)) return null;
  if (!isAllowedThreadsPermalink(link)) return null;
  return { external_id: id, permalink: link };
}

/** 서버가 잠금 안에서 모은 사실(화면도 같은 판정으로 버튼을 보인다). */
export interface UserConfirmFacts {
  account: { kind: string; platform: string } | null;
  /** 항목의 가장 최근 작업 상태(없으면 null) */
  jobState: string | null;
  /** 복원한 읽기 전용 작업(restored_needs_review) */
  restored: boolean;
  /** 그 작업의 게시 시도 표식(publish_attempt) 수 */
  publishAttempts: number;
  /** 그 작업의 게시 기록(publish — 결정적 미디어 ID) 수 */
  publishSteps: number;
  /** 항목의 결과(publications) 수 */
  publications: number;
  candidate: UserConfirmCandidate | null;
}

/** 허용이면 null, 아니면 첫 번째로 걸린 거절 코드. requested = 요청이 보낸 후보 외부 ID. */
export function userConfirmProblem(f: UserConfirmFacts, requested: string | null | undefined): UserConfirmCode | null {
  if (!f.account || f.account.kind !== 'live' || f.account.platform !== 'threads') return 'user_confirm_not_live';
  if (f.publications > 0) return 'user_confirm_already_published';
  if (!f.jobState || !(USER_CONFIRMABLE_JOB_STATES as readonly string[]).includes(f.jobState)) return 'user_confirm_not_pending';
  if (f.restored) return 'user_confirm_restored';
  if (f.publishAttempts < 1) return 'user_confirm_no_attempt';
  if (f.publishSteps > 0) return 'user_confirm_publish_recorded';
  if (!f.candidate) return 'user_confirm_no_candidate';
  if (typeof requested !== 'string' || requested !== f.candidate.external_id) return 'user_confirm_candidate_mismatch';
  return null;
}

const USER_CONFIRM_MESSAGE: Record<UserConfirmCode, string> = {
  user_confirm_not_live: '실제 Threads 계정 항목만 "Threads에서 확인함"으로 기록할 수 있습니다(모의 결과는 해당 없음).',
  user_confirm_already_published: '이미 결과가 기록된 항목입니다(다시 기록하지 않음).',
  user_confirm_not_pending: '결과 불명(UNKNOWN)·확인 중(RECONCILING) 항목만 "Threads에서 확인함"으로 기록할 수 있습니다.',
  user_confirm_restored: '복원한 작업(읽기 전용 이력)은 이 환경에서 사용자 확인으로 기록하지 않습니다. 새 배포 계획을 만드세요.',
  user_confirm_no_attempt: '게시를 시도한 기록이 없는 작업입니다(사용자 확인 대상 아님).',
  user_confirm_publish_recorded: '게시 기록(미디어 ID)이 이미 있습니다 — 재확인으로 결과를 확정하세요.',
  user_confirm_no_candidate: '가장 최근 재확인에 확인 후보(링크)가 없습니다. 재확인을 다시 하거나 Threads 에서 직접 확인하세요.',
  user_confirm_candidate_mismatch: '화면의 확인 후보가 지금 기록된 후보와 다릅니다. 새로 고친 뒤 다시 확인하세요.',
};

/** 사용자 확인 거절(409). */
export class UserConfirmError extends AppError {
  constructor(code: UserConfirmCode, details?: Record<string, unknown>) {
    super('conflict', code, USER_CONFIRM_MESSAGE[code], details);
  }
}

/** POST /api/distribution-items/{id}/user-confirm 입력 — 화면이 본 후보 ID 를 그대로 보낸다(형식이 틀리면 400, 다르면 409). */
export const userConfirmSchema = z.object({
  candidate_external_id: z.string().regex(LIVE_THREADS_EXTERNAL_ID_RE, 'candidate_external_id 는 threads:<숫자> 형식입니다'),
});
export type UserConfirmInput = z.infer<typeof userConfirmSchema>;
