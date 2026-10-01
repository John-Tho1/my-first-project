/**
 * T20(결정 D22) 운영 화면·보존 정리 — 순수 함수(시각·크기 계산, 보존 대상 선택). DB·파일·네트워크 없음.
 *
 * 원칙: 숫자는 모두 실제 기록(DB·파일)에서 나온다. 측정할 원천이 없으면 null("측정 없음")이지 "정상"이 아니다.
 * 백업 상태는 "마지막 내보내기가 몇 시간 전인가"와 "복원 훈련 결과"라는 사실만 말한다 — "안전"이라고 하지 않는다(docs/07).
 */

/** 보존 정리가 지울 수 있는 것(정확히 이 셋). DB 표는 job_events 하나뿐이며, 지우기 전에 JSONL 로 내보낸다. */
export const RETENTION_TARGETS = ['job_events', 'package_files', 'export_zips'] as const;
export type RetentionTarget = (typeof RETENTION_TARGETS)[number];

/** 보존 정리가 지울 수 있는 DB 표. */
export const RETENTION_DELETABLE_TABLES = ['job_events'] as const;

/**
 * 보존 정리가 절대 건드리지 않는 표(원문·버전·관계·승인·결과 근거). 단위 테스트가 RETENTION_DELETABLE_TABLES 와 겹치지 않음을 확인한다.
 * (원문 소재·출처·원고 버전은 사용자 자료 — 보존 기간으로 지우지 않는다.)
 */
export const RETENTION_PROTECTED_TABLES = [
  'users',
  'sources',
  'source_versions',
  'captures',
  'capture_revisions',
  'ideas',
  'idea_captures',
  'contents',
  'content_versions',
  'content_captures',
  'assets',
  'transcripts',
  'transcription_jobs',
  'variants',
  'variant_versions',
  'variant_assets',
  'interview_answers',
  'generation_runs',
  'claims',
  'claim_sources',
  'claim_confirmations',
  'usage_ledger',
  'brand_profiles',
  'channel_accounts',
  'distribution_plans',
  'distribution_items',
  'approvals',
  'jobs',
  'execute_commands',
  'send_intents',
  'publications',
  'mock_scenarios',
  'audit_events',
  'export_runs',
  'restore_runs',
  'restore_drills',
] as const;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** 마지막 시각부터 지금까지 시간(소수 1자리). 기록이 없으면 null. 미래 시각(시계 차)은 0. */
export function ageHours(last: Date | null | undefined, now: Date): number | null {
  if (!last) return null;
  const h = Math.max(0, now.getTime() - last.getTime()) / HOUR;
  return Math.round(h * 10) / 10;
}

export type BackupState = 'none' | 'recent' | 'stale';

/** 백업 나이 판정: 기록 없음 → none, maxAgeHours 초과 → stale(경고), 그 밖 → recent(기준 안 — "안전"이 아니다). */
export function backupState(age: number | null, maxAgeHours: number): BackupState {
  if (age === null) return 'none';
  return age > maxAgeHours ? 'stale' : 'recent';
}

/** 날짜 기준 컷오프(now - days). */
export function cutoffDays(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY);
}

/** 최근 keep 개를 남기고 나머지 ID(오래된 것부터 정렬된 입력이 아니어도 된다 — createdAt 내림차순으로 정렬해 자른다). */
export function exportsToPrune<T extends { id: string; createdAt: Date }>(runs: readonly T[], keep: number): T[] {
  const sorted = [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  return sorted.slice(Math.max(0, keep));
}

/** 배포 파일이 보존 기간을 지났는가(수정 시각 < now - days). */
export function packageExpired(mtime: Date, now: Date, days: number): boolean {
  return mtime.getTime() < cutoffDays(now, days).getTime();
}

/** 바이트 표시(1024 단위). 음수·NaN 은 '측정 없음'. */
export function formatByteSize(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '측정 없음';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** 경과 시간 한국어(분·시간·일). null → '측정 없음'. */
export function formatAgeHours(h: number | null): string {
  if (h === null) return '측정 없음';
  if (h < 1) return `${Math.round(h * 60)}분 전`;
  if (h < 48) return `${h.toFixed(1)}시간 전`;
  return `${(h / 24).toFixed(1)}일 전`;
}
