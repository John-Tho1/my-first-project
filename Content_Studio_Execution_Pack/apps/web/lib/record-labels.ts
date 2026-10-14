/**
 * FIX-UICLEAN(Codex review-UI-CLEAN P1): 화면 안내의 실제/MOCK 문구를 실제 상태에서 고른다(순수 함수 — React·DB 없음).
 * - 계정 상태(지금): 모의 계정만 / 실제 계정은 있으나 실제 게시 대상 미지정 / 실제 게시 대상 있음 / 계정 없음 — 셋을 섞지 않는다.
 * - 결과·작업의 실제/MOCK 표시는 페이지 수준 계정 상태가 아니라 그 기록(항목 계정 kind·publications.is_mock — DB 트리거로 서로 같음)에서 고른다.
 *   그래서 지금 계정 상태만으로 "결과가 모두 MOCK" 이라고 말하지 않는다.
 */
import { ITEM_STATUS_LABEL, jobStatusText, REQUESTED_RESULT_LABEL } from './distribution';

export type AccountMode = 'none' | 'mock_only' | 'live_no_target' | 'live_target';

/** 지금 계정 상태(listAccountHealth 의 mock·live_publish_target). */
export function accountModeOf(accounts: ReadonlyArray<{ mock: boolean; live_publish_target?: boolean }>): AccountMode {
  if (accounts.length === 0) return 'none';
  if (accounts.some((a) => !a.mock && a.live_publish_target === true)) return 'live_target';
  if (accounts.some((a) => !a.mock)) return 'live_no_target';
  return 'mock_only';
}

/** 배포함·운영 공통: 계정 상태 태그(실제 게시 대상 미지정 등). */
export const ACCOUNT_MODE_TAG: Record<AccountMode, string> = {
  none: '배포 계정 없음',
  mock_only: 'MOCK',
  live_no_target: '실제 게시 대상 미지정',
  live_target: '실제 게시 계정 있음',
};

/** 운영 화면 「배포 계정 연결」 아래 한 줄(지금 계정 상태 — 결과 기록은 말하지 않음). */
export function opsAccountsNote(mode: AccountMode): string {
  switch (mode) {
    case 'none':
      return '배포 계정이 없습니다.';
    case 'mock_only':
      return '현재 연결은 모두 모의(MOCK)입니다.';
    case 'live_no_target':
      return '실제 계정이 있지만 실제 게시 대상 미지정입니다("실제 게시 계정으로 사용" 중인 계정 없음 — 지금은 실제로 게시하지 않음).';
    case 'live_target':
      return '"실제 게시 계정으로 사용" 중인 실제 계정이 있습니다 — 그 계정의 승인된 항목은 실행하면 실제로 게시됩니다.';
  }
}

/** 작업 기록의 계정 종류별 개수(항목 계정 kind 기준). */
export interface JobKindCounts {
  mock: number;
  live: number;
}

/** 운영 화면 「배포 작업」 제목 옆 태그 — 작업 기록 기준(지금 계정 상태 아님). 작업이 없으면 태그 없음. */
export function opsJobsTag(byKind: JobKindCounts): { text: string; warn: boolean } | null {
  if (byKind.live > 0) return { text: `실제 게시 작업 ${byKind.live}개 포함`, warn: true };
  if (byKind.mock > 0) return { text: 'MOCK', warn: true };
  return null;
}

/** 배포함·홈 목록 한 줄의 태그 — 그 계획 항목들의 계정 kind 기록(PlanListEntry.mock = 모든 항목이 모의 계정). */
export function planRowTag(entry: { mock: boolean; itemCount: number }): { text: string; className: string } | null {
  if (entry.itemCount === 0) return null;
  return entry.mock ? { text: 'MOCK', className: 'tag warn' } : { text: '실제 게시 포함', className: 'tag warn' };
}

/**
 * 계획 상세 「선택 승인」 — 요청 결과가 섞인 계획의 안내 끝말. 고를 수 있는 항목의 계정 kind 기록으로:
 * 모두 모의면 "(MOCK — 실제 게시 아님)", 실제 계정 항목이 있으면 그 항목은 실제 게시라고 밝힌다.
 */
export function mixedResultSuffix(items: ReadonlyArray<{ live: boolean }>): string {
  const live = items.filter((x) => x.live).length;
  if (live === 0) return '(MOCK — 실제 게시 아님)';
  if (live === items.length) return '(실제 계정 항목 — 승인·실행하면 실제로 게시)';
  return '(실제 계정 항목은 승인·실행하면 실제로 게시, 모의 계정 항목은 MOCK — 실제 게시 아님)';
}

/** 계획 상세 배너: 계획을 만든 직후(?created=1) — 이 계획의 항목 기록 기준. */
export function planCreatedBanner(hasLive: boolean): string {
  return hasLive
    ? '배포 계획을 만들었습니다(아직 승인 전 — 게시하지 않음). 실제 계정 항목은 승인·실행하면 실제로 게시됩니다. 아래 내용을 확인한 뒤 승인할 항목을 고르세요.'
    : '배포 계획을 만들었습니다(MOCK — 아직 승인 전). 아래 내용을 확인한 뒤 승인할 항목을 고르세요.';
}

/** 계획 상세 배너: 보류 작업 재시도(?retried=…) — 이 계획의 항목 기록 기준. */
export function retriedBanner(hasLive: boolean): string {
  return hasLive
    ? '보류된 작업을 다시 대기열에 넣었습니다(새 시도). "작업 처리 실행(1회 — 실제 게시 항목은 실제로 게시)"을 누르면 처리합니다 — 실제 계정 항목은 실제 게시 조건이 모두 있을 때만 실제로 게시됩니다.'
    : '보류된 작업을 다시 대기열에 넣었습니다(MOCK — 새 시도). "작업 처리 실행(모의 1회)"을 누르면 처리합니다.';
}

/**
 * 계획 상태 문구(PLAN_STATUS_LABEL — 모의 기준 꼬리표 "(MOCK…)" 포함)를 그 계획 기록에 맞춘다: 모든 항목이 모의 계정이면 그대로,
 * 실제 계정 항목이 있으면 MOCK 꼬리표만 뗀다(나머지 뜻은 유지). lib/distribution.ts 의 문구 자체는 바꾸지 않는다.
 */
export function planStatusText(label: string, mock: boolean): string {
  if (mock) return label;
  return label
    .replace('(MOCK — 실제 발행 아님)', '')
    .replace('(MOCK)', '')
    .replace('(MOCK — ', '(')
    .trim();
}

// ---- FIX2-UICLEAN(브라우저 확인): 항목·작업 상태 문구도 그 항목 기록으로 ----

/** 실제 항목인가: 결과 기록(publications.is_mock)이 있으면 그것, 없으면 항목 계정 kind(둘은 DB 트리거 publications_kind_guard 로 같은 값). */
export function itemIsLive(x: { accountKind: string | null | undefined; pub: { isMock: boolean } | null | undefined }): boolean {
  if (x.pub) return !x.pub.isMock;
  return x.accountKind === 'live';
}

const LIVE_VERIFICATION_SHORT: Record<string, string> = { VERIFIED: '앱 확인(VERIFIED)', USER_CONFIRMED: '사용자 확인' };

/**
 * 항목 상태 태그. 실제 항목의 CONFIRMED 만 "CONFIRMED · 실제 게시 완료 · {앱 확인(VERIFIED) | 사용자 확인 | 확인 전}" 으로 바꾸고,
 * 모의 항목·다른 상태는 ITEM_STATUS_LABEL 그대로(모의 CONFIRMED = "CONFIRMED · MOCK 확인(실제 발행 아님)").
 */
export function itemStatusText(status: string, rec: { live: boolean; verification?: string | null }): string {
  if (status === 'CONFIRMED' && rec.live) return `CONFIRMED · 실제 게시 완료 · ${LIVE_VERIFICATION_SHORT[rec.verification ?? ''] ?? '확인 전'}`;
  return ITEM_STATUS_LABEL[status] ?? status;
}

/**
 * 작업 한 줄. jobStatusText 는 결과 기록이 없는 CONFIRMED 를 "MOCK 결과 확인" 으로 쓴다 — 실제 항목이면 그 대신 실제 게시라고만 말한다.
 * 결과 기록이 있으면 그 기록(is_mock)대로 jobStatusText 그대로.
 */
export function jobStatusTextFor(job: Parameters<typeof jobStatusText>[0], pub: Parameters<typeof jobStatusText>[1], reason: string | null | undefined, channel: string | undefined, live: boolean): string {
  if (live && job.state === 'CONFIRMED' && !pub) return 'CONFIRMED · 실제 게시(이 작업의 결과 기록 없음 — 항목 상태·원격 결과에서 확인)';
  return jobStatusText(job, pub, reason, channel);
}

/** 승인 화면의 요청 결과 이름 — 실제 계정 항목은 실제 게시(public_publish), 모의는 REQUESTED_RESULT_LABEL 그대로. */
export function requestedResultLabel(requested: string, live: boolean): string {
  if (live) return '실제 게시(public_publish)';
  return REQUESTED_RESULT_LABEL[requested] ?? requested;
}

/** 승인 철회 배너 — 실제 계정 항목이 있는 계획이면 첫 문장의 "(MOCK)" 만 뗀다(나머지 그대로). */
export function revocationNoticeFor(text: string, hasLive: boolean): string {
  return hasLive ? text.replace('승인을 철회했습니다(MOCK).', '승인을 철회했습니다.') : text;
}
