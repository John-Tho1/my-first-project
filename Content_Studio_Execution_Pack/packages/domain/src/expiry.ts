/**
 * EXPIRY-1(결정 D39): 만료 관리 알림 — 실제 Threads 연결(장기 토큰)과 로컬 개발용 HTTPS 인증서의 만료 14일 전부터 경고(순수 함수, 외부 호출 없음).
 * - 실제(live) Threads 연결 정보만 센다. 모의(MOCK) 계정·연결 정보 없는 계정·연결 해제(revoked)한 계정은 무시한다.
 *   FIX1-EXPIRY1: "연결 해제"는 끝난 것(revoked_at 있음)과 진행 중인 것(연결 정보 상태 revoking — 화면 입력 status 는 credentialHealth 가
 *   'revoked'(reason revoking)로 바꿔 줌, revoked_at 은 아직 null)을 모두 뜻한다. 진행 중이면 콜백 저장이 CredentialBusyError 로 막혀
 *   "다시 연결" 안내가 틀리므로 둘 다 뺀다. 그 밖의 실행 불가 상태(error·needs_reconnect·expired)는 다시 연결하면 풀리므로 그대로 알린다.
 * - 다시 연결은 기존 연결 흐름(설정 → 배포 계정 연결 → "다시 연결(실제 Threads)")뿐 — 토큰 갱신 API 호출은 추가하지 않는다(D31 범위 밖).
 * - 로컬 인증서 정보는 서버 전용 읽기 함수(apps/web/lib/dev-cert.ts — 개발 모드에서만 파일을 읽음)가 넘긴다. 없으면 알림 없음.
 *
 * 경계(정확히): remaining = expiresAt − now(ms).
 *   remaining ≤ 0                         → 'expired'(만료 시각 그 순간부터 만료 — credentialHealth 의 `expiresAt <= now` 와 같은 규칙)
 *   0 < remaining ≤ EXPIRY_WARN_WINDOW_MS  → 'warn'(정확히 14일 남은 순간 포함)
 *   remaining > EXPIRY_WARN_WINDOW_MS      → 알림 없음(14일 + 1ms 는 아직 경고하지 않음)
 */
import { formatMsk } from './time';

/** 경고를 시작하는 창 — 만료 14일 전(ms). */
export const EXPIRY_WARN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type ExpiryNoticeKind = 'threads_connection' | 'dev_cert';
export type ExpiryLevel = 'warn' | 'expired';

export interface ExpiryNotice {
  kind: ExpiryNoticeKind;
  level: ExpiryLevel;
  text: string;
  /** 해결할 곳: Threads 연결 → 설정의 배포 계정 연결(기존 "다시 연결"), 로컬 인증서 → 설정의 만료 관리(갱신 명령 안내) */
  href: string;
  /** 정렬·<time> 표시용 */
  expiresAt: Date;
  /** Threads 연결 알림만: 어느 배포 계정 행인지(화면 key) */
  accountId?: string;
}

/** 화면의 연결 상태(db accountHealthView)에서 이 함수가 읽는 필드만 — 토큰·암호문 없음. */
export interface ExpiryAccountInput {
  account_id?: string;
  kind: string;
  mock?: boolean;
  platform: string;
  expires_at: string | Date | null;
  revoked_at?: string | Date | null;
  /** 연결 상태(accountHealthView.status = credentialHealth 결과, 또는 연결 정보 행의 원래 상태). 'revoked'·'revoking' 이면 알림 대상이 아니다. */
  status?: string | null;
}

/** 연결 해제(끝남·진행 중)를 뜻하는 상태 이름 — credentialHealth 는 revoking 도 'revoked' 로 보고한다. */
const REVOKE_STATUSES: ReadonlySet<string> = new Set(['revoked', 'revoking']);

export interface DevCertExpiryInput {
  validTo: Date;
}

/** 설정의 배포 계정 연결 구역(실제 Threads "다시 연결" 버튼이 있는 곳 — 기존 연결 흐름). */
export const EXPIRY_ACCOUNTS_HREF = '/settings#accounts';
/** 설정의 만료 관리 구역(로컬 인증서 갱신 명령 안내). */
export const EXPIRY_SECTION_HREF = '/settings#expiry';
/** 로컬 인증서 갱신 명령(앱 루트에서, Git Bash). */
export const DEV_CERT_RENEW_COMMAND = 'scripts/dev-cert.sh renew';

/** 알림 앞 태그 글자 */
export const EXPIRY_LEVEL_LABEL: Record<ExpiryLevel, string> = { warn: '곧 만료', expired: '만료됨' };
/** 설정 → 배포 계정 연결 표의 "만료" 칸 옆 태그 글자 */
export const EXPIRY_ACCOUNT_TAG_TEXT: Record<ExpiryLevel, string> = {
  warn: '14일 안에 만료 — 다시 연결하세요',
  expired: '만료됨 — 다시 연결 필요',
};

export const threadsConnectionWarnText = (expiresAt: Date): string => `Threads 연결이 ${formatMsk(expiresAt)}에 만료됩니다 — 설정에서 다시 연결하세요`;
export const THREADS_CONNECTION_EXPIRED_TEXT = 'Threads 연결이 만료되었습니다 — 다시 연결 전에는 실제 게시가 되지 않습니다';
export const devCertWarnText = (validTo: Date): string => `로컬 인증서가 ${formatMsk(validTo)}에 만료됩니다 — ${DEV_CERT_RENEW_COMMAND}`;
/** 계획(LIVEP2_EXPIRY_PLAN Task B)에 만료 뒤 문구가 없어 경고 문구와 같은 꼴로 정했다. */
export const devCertExpiredText = (validTo: Date): string => `로컬 인증서가 ${formatMsk(validTo)}에 만료되었습니다 — ${DEV_CERT_RENEW_COMMAND}`;

const toDate = (v: string | Date | null | undefined): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** 위 경계 규칙. 알림이 없으면 null. */
export function expiryLevel(expiresAt: Date, now: Date): ExpiryLevel | null {
  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining <= 0) return 'expired';
  if (remaining <= EXPIRY_WARN_WINDOW_MS) return 'warn';
  return null;
}

/** 알림 대상인 계정인가: 실제(live) Threads 계정 + 연결 정보(만료 시각)가 있고 연결 해제하지 않음(끝남·진행 중 모두 아님). */
export function isLiveThreadsCredential(a: ExpiryAccountInput): boolean {
  return (
    a.kind === 'live' &&
    a.mock !== true &&
    a.platform === 'threads' &&
    toDate(a.expires_at) !== null &&
    toDate(a.revoked_at ?? null) === null &&
    !(a.status != null && REVOKE_STATUSES.has(a.status))
  );
}

/** 계정 한 행의 만료 알림(설정 표의 "만료" 칸 옆 표시에도 쓴다). 대상이 아니거나 14일보다 많이 남았으면 null. */
export function accountExpiryNotice(a: ExpiryAccountInput, now: Date): ExpiryNotice | null {
  if (!isLiveThreadsCredential(a)) return null;
  const expiresAt = toDate(a.expires_at)!;
  const level = expiryLevel(expiresAt, now);
  if (!level) return null;
  return {
    kind: 'threads_connection',
    level,
    text: level === 'expired' ? THREADS_CONNECTION_EXPIRED_TEXT : threadsConnectionWarnText(expiresAt),
    href: EXPIRY_ACCOUNTS_HREF,
    expiresAt,
    ...(a.account_id ? { accountId: a.account_id } : {}),
  };
}

/** 로컬 인증서 알림. 정보가 없거나(파일 없음·운영 빌드·읽기 실패) 14일보다 많이 남았으면 null. */
export function devCertExpiryNotice(devCert: DevCertExpiryInput | null | undefined, now: Date): ExpiryNotice | null {
  const validTo = devCert ? toDate(devCert.validTo) : null;
  if (!validTo) return null;
  const level = expiryLevel(validTo, now);
  if (!level) return null;
  return { kind: 'dev_cert', level, text: level === 'expired' ? devCertExpiredText(validTo) : devCertWarnText(validTo), href: EXPIRY_SECTION_HREF, expiresAt: validTo };
}

const LEVEL_ORDER: Record<ExpiryLevel, number> = { expired: 0, warn: 1 };
const KIND_ORDER: Record<ExpiryNoticeKind, number> = { threads_connection: 0, dev_cert: 1 };

/**
 * 홈·설정 상단의 만료 알림 목록. 순서: 만료됨(expired) → 곧 만료(warn), 같은 단계 안에서는 만료 시각이 이른 것부터,
 * 시각까지 같으면 Threads 연결 → 로컬 인증서(그다음은 입력 순서 — 안정 정렬).
 */
export function expiryNotices(input: { accounts: readonly ExpiryAccountInput[]; devCert: DevCertExpiryInput | null | undefined; now: Date }): ExpiryNotice[] {
  const out: ExpiryNotice[] = [];
  for (const a of input.accounts) {
    const n = accountExpiryNotice(a, input.now);
    if (n) out.push(n);
  }
  const cert = devCertExpiryNotice(input.devCert, input.now);
  if (cert) out.push(cert);
  return out
    .map((n, i) => ({ n, i }))
    .sort(
      (x, y) =>
        LEVEL_ORDER[x.n.level] - LEVEL_ORDER[y.n.level] ||
        x.n.expiresAt.getTime() - y.n.expiresAt.getTime() ||
        KIND_ORDER[x.n.kind] - KIND_ORDER[y.n.kind] ||
        x.i - y.i,
    )
    .map((x) => x.n);
}
