/**
 * EXPIRY-1(결정 D39): 만료 알림 순수 함수 — 실제 Threads 연결만, 14일 경계(정확히 14일 = 경고, 0 이하 = 만료), 로컬 인증서, 순서, 모스크바 시각 문구.
 */
import { describe, expect, it } from 'vitest';
import {
  accountExpiryNotice,
  DEV_CERT_RENEW_COMMAND,
  devCertExpiryNotice,
  EXPIRY_ACCOUNTS_HREF,
  EXPIRY_SECTION_HREF,
  EXPIRY_WARN_WINDOW_MS,
  expiryLevel,
  expiryNotices,
  isLiveThreadsCredential,
  THREADS_CONNECTION_EXPIRED_TEXT,
  type ExpiryAccountInput,
} from './expiry';
import { credentialHealth } from './oauth';
import { formatMsk } from './time';

const NOW = new Date('2026-11-28T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const live = (o: Partial<ExpiryAccountInput> = {}): ExpiryAccountInput => ({
  account_id: 'acc-live',
  kind: 'live',
  mock: false,
  platform: 'threads',
  expires_at: at(3 * DAY).toISOString(),
  revoked_at: null,
  ...o,
});
const mock = (o: Partial<ExpiryAccountInput> = {}): ExpiryAccountInput => ({
  account_id: 'acc-mock',
  kind: 'mock',
  mock: true,
  platform: 'threads',
  expires_at: at(1 * DAY).toISOString(),
  revoked_at: null,
  ...o,
});
const run = (accounts: ExpiryAccountInput[], devCert: { validTo: Date } | null = null, now = NOW) => expiryNotices({ accounts, devCert, now });

describe('expiryLevel — 경계', () => {
  it('14일 창 상수는 정확히 14×24시간', () => {
    expect(EXPIRY_WARN_WINDOW_MS).toBe(14 * DAY);
  });
  it.each<[string, number, 'warn' | 'expired' | null]>([
    ['15일 남음 → 없음', 15 * DAY, null],
    ['14일 + 1ms → 없음', 14 * DAY + 1, null],
    ['정확히 14일 → warn', 14 * DAY, 'warn'],
    ['14일 − 1ms → warn', 14 * DAY - 1, 'warn'],
    ['1일 → warn', 1 * DAY, 'warn'],
    ['1ms → warn', 1, 'warn'],
    ['정확히 0(만료 시각 그 순간) → expired', 0, 'expired'],
    ['1ms 지남 → expired', -1, 'expired'],
    ['30일 지남 → expired', -30 * DAY, 'expired'],
  ])('%s', (_name, remaining, want) => {
    expect(expiryLevel(at(remaining), NOW)).toBe(want);
  });
});

describe('expiryNotices — Threads 연결(실제만)', () => {
  it('계정 없음·인증서 없음 → 빈 목록', () => {
    expect(run([])).toEqual([]);
  });

  it('모의(MOCK) 계정은 만료가 1일·지났어도 무시', () => {
    expect(run([mock(), mock({ account_id: 'm2', expires_at: at(-DAY).toISOString() })])).toEqual([]);
    // kind 가 mock 이면 mock 표시가 빠져 있어도 무시, mock 표시가 true 면 kind 가 live 여도 무시
    expect(run([mock({ mock: undefined }), live({ mock: true, expires_at: at(DAY).toISOString() })])).toEqual([]);
  });

  it('실제 Threads 가 아니면(다른 채널) 무시', () => {
    expect(run([live({ platform: 'youtube', expires_at: at(DAY).toISOString() })])).toEqual([]);
  });

  it('연결 정보 없음(만료 null)·연결 해제(revoked)·날짜가 아님 → 무시', () => {
    expect(run([live({ expires_at: null }), live({ revoked_at: at(-DAY).toISOString(), expires_at: at(DAY).toISOString() }), live({ expires_at: 'not-a-date' })])).toEqual([]);
    expect(isLiveThreadsCredential(live({ expires_at: null }))).toBe(false);
    expect(isLiveThreadsCredential(live())).toBe(true);
  });

  // FIX1-EXPIRY1(D39 검토 P2 expiry.ts:83): 연결 해제 진행 중(credential 'revoking' — revoked_at 은 아직 null)도 "다시 연결" 경고 대상이 아니다.
  // 화면 입력(db accountHealthView)의 status 는 credentialHealth 결과라 'revoking' 이 'revoked'(reason 'revoking')로 온다.
  it('연결 해제 진행 중(status revoked·reason revoking, revoked_at null) → 1일·만료됨이어도 무시', () => {
    const h = credentialHealth({
      account: { kind: 'live', credentialState: 'linked' },
      credential: { status: 'revoking', expiresAt: at(DAY), scopes: ['threads_basic', 'threads_content_publish'], revokedAt: null, lastErrorCode: null },
      requiredScopes: ['threads_basic', 'threads_content_publish'],
      now: NOW,
    });
    expect(h).toMatchObject({ status: 'revoked', reason: 'revoking', usable: false });
    const revoking = live({ status: h.status, revoked_at: null, expires_at: at(DAY).toISOString() });
    expect(isLiveThreadsCredential(revoking)).toBe(false);
    expect(accountExpiryNotice(revoking, NOW)).toBeNull();
    expect(accountExpiryNotice(live({ status: 'revoked', expires_at: at(0).toISOString() }), NOW)).toBeNull();
    expect(accountExpiryNotice(live({ status: 'revoked', expires_at: at(-DAY).toISOString() }), NOW)).toBeNull();
    // 연결 정보 행의 원래 상태 이름(revoking)을 그대로 넘겨도 같다
    expect(accountExpiryNotice(live({ status: 'revoking', expires_at: at(DAY).toISOString() }), NOW)).toBeNull();
    expect(run([revoking, live({ account_id: 'b', status: 'revoking', expires_at: at(-DAY).toISOString() })])).toEqual([]);
  });

  // FIX2-EXPIRY1(검토 #8 expiry.ts:97): 정리 대기 행(oauth_pending_tokens)이 함께 있으면 credentialHealth 는 해제 진행 중보다 정리 대기를 먼저 보고한다
  // (status 'error', reason pending_<kind>) — 화면 status 만 보면 해제 중임을 놓친다. 연결 정보 행의 원래 상태(credential_status)로도 뺀다.
  it('연결 해제 진행 중 + 정리 대기 행(credentialHealth 가 error·pending_cleanup_revoke 로 보고) → 원래 상태 revoking 으로 무시, 정리 대기만 있는 error 는 그대로 알림', () => {
    const cred = (status: string) => ({ status, expiresAt: at(DAY), scopes: ['threads_basic', 'threads_content_publish'], revokedAt: null, lastErrorCode: null });
    const base = { account: { kind: 'live', credentialState: 'linked' }, requiredScopes: ['threads_basic', 'threads_content_publish'], now: NOW } as const;
    for (const pendingKind of ['cleanup_revoke', 'refresh_unknown', 'verify_current'] as const) {
      const h = credentialHealth({ ...base, credential: cred('revoking'), pendingKind });
      expect(h).toMatchObject({ status: 'error', reason: `pending_${pendingKind}`, usable: false });
      for (const expires of [at(DAY), at(0), at(-DAY)]) {
        const a = live({ status: h.status, credential_status: 'revoking', revoked_at: null, expires_at: expires.toISOString() });
        expect(isLiveThreadsCredential(a), pendingKind).toBe(false);
        expect(accountExpiryNotice(a, NOW), pendingKind).toBeNull();
      }
    }
    expect(run([live({ status: 'error', credential_status: 'revoking', expires_at: at(DAY).toISOString() })])).toEqual([]);
    expect(accountExpiryNotice(live({ status: 'error', credential_status: 'revoked', expires_at: at(DAY).toISOString() }), NOW)).toBeNull();
    // 정리 대기만 있는(연결 정보는 active) error 는 다시 연결로 새 만료가 생기므로 계속 알린다(검토 Q1 답 — 콜백은 revoking 만 막는다)
    const pendingOnly = credentialHealth({ ...base, credential: cred('active'), pendingKind: 'cleanup_revoke' });
    expect(pendingOnly.status).toBe('error');
    expect(accountExpiryNotice(live({ status: pendingOnly.status, credential_status: 'active', expires_at: at(DAY).toISOString() }), NOW)?.level).toBe('warn');
    expect(accountExpiryNotice(live({ status: 'error', credential_status: 'error', expires_at: at(-DAY).toISOString() }), NOW)?.level).toBe('expired');
    expect(accountExpiryNotice(live({ status: 'connected', credential_status: null, expires_at: at(DAY).toISOString() }), NOW)?.level).toBe('warn');
  });

  it('연결 해제가 아닌 다른 실행 불가 상태(error·needs_reconnect·expired)와 상태 미지정은 그대로 알린다 — 다시 연결로 풀리는 상태', () => {
    for (const status of [undefined, 'connected', 'expiring_soon', 'error', 'needs_reconnect', 'expired']) {
      expect(accountExpiryNotice(live({ status, expires_at: at(DAY).toISOString() }), NOW)?.level).toBe('warn');
      expect(accountExpiryNotice(live({ status, expires_at: at(-1).toISOString() }), NOW)?.level).toBe('expired');
      expect(accountExpiryNotice(live({ status, expires_at: at(14 * DAY + 1).toISOString() }), NOW)).toBeNull();
    }
  });

  it('실제 15일 남음 → 없음, 14일 + 1ms → 없음', () => {
    expect(run([live({ expires_at: at(15 * DAY).toISOString() })])).toEqual([]);
    expect(run([live({ expires_at: at(14 * DAY + 1).toISOString() })])).toEqual([]);
  });

  it('정확히 14일 → warn, 문구에 모스크바 시각(formatMsk)과 다시 연결 안내, href = 설정 배포 계정 연결', () => {
    const exp = new Date('2026-12-12T12:00:00.000Z'); // NOW + 14일
    expect(exp.getTime() - NOW.getTime()).toBe(14 * DAY);
    const [n, ...rest] = run([live({ expires_at: exp.toISOString() })]);
    expect(rest).toEqual([]);
    expect(n).toEqual({
      kind: 'threads_connection',
      level: 'warn',
      text: 'Threads 연결이 2026-12-12 15:00 (MSK)에 만료됩니다 — 설정에서 다시 연결하세요',
      href: EXPIRY_ACCOUNTS_HREF,
      expiresAt: exp,
      accountId: 'acc-live',
    });
    expect(EXPIRY_ACCOUNTS_HREF).toBe('/settings#accounts');
  });

  it('문구의 날짜는 UTC 가 아니라 모스크바 날짜(UTC 22:30 → 다음 날 01:30 MSK)', () => {
    const exp = new Date('2026-12-04T22:30:00.000Z');
    const [n] = run([live({ expires_at: exp.toISOString() })]);
    expect(n!.text).toBe('Threads 연결이 2026-12-05 01:30 (MSK)에 만료됩니다 — 설정에서 다시 연결하세요');
    expect(n!.text).toContain(formatMsk(exp));
  });

  it('1일 → warn, Date 입력도 받는다', () => {
    const [n] = run([live({ expires_at: at(DAY) })]);
    expect(n).toMatchObject({ kind: 'threads_connection', level: 'warn' });
  });

  it('정확히 0·지남 → expired, 고정 문구(실제 게시가 되지 않음)', () => {
    for (const ms of [0, -1, -10 * DAY]) {
      const [n, ...rest] = run([live({ expires_at: at(ms).toISOString() })]);
      expect(rest).toEqual([]);
      expect(n).toMatchObject({ kind: 'threads_connection', level: 'expired', text: THREADS_CONNECTION_EXPIRED_TEXT, href: EXPIRY_ACCOUNTS_HREF });
    }
    expect(THREADS_CONNECTION_EXPIRED_TEXT).toBe('Threads 연결이 만료되었습니다 — 다시 연결 전에는 실제 게시가 되지 않습니다');
  });

  it('accountExpiryNotice(설정 표의 만료 칸 옆)도 같은 규칙 — 모의는 null', () => {
    expect(accountExpiryNotice(live({ expires_at: at(14 * DAY).toISOString() }), NOW)?.level).toBe('warn');
    expect(accountExpiryNotice(live({ expires_at: at(14 * DAY + 1).toISOString() }), NOW)).toBeNull();
    expect(accountExpiryNotice(live({ expires_at: at(0).toISOString() }), NOW)?.level).toBe('expired');
    expect(accountExpiryNotice(mock({ expires_at: at(0).toISOString() }), NOW)).toBeNull();
  });
});

describe('expiryNotices — 로컬 인증서', () => {
  it('정보 없음(null·undefined) → 없음, 20일 남음 → 없음, 날짜가 아님 → 없음', () => {
    expect(run([], null)).toEqual([]);
    expect(expiryNotices({ accounts: [], devCert: undefined, now: NOW })).toEqual([]);
    expect(run([], { validTo: at(20 * DAY) })).toEqual([]);
    expect(run([], { validTo: new Date(Number.NaN) })).toEqual([]);
  });

  it('정확히 14일 → warn, 문구에 모스크바 시각과 갱신 명령, href = 설정 만료 관리', () => {
    const validTo = new Date('2026-12-12T09:00:00.000Z');
    expect(validTo.getTime() - new Date('2026-11-28T09:00:00.000Z').getTime()).toBe(14 * DAY);
    const [n, ...rest] = run([], { validTo }, new Date('2026-11-28T09:00:00.000Z'));
    expect(rest).toEqual([]);
    expect(n).toEqual({
      kind: 'dev_cert',
      level: 'warn',
      text: '로컬 인증서가 2026-12-12 12:00 (MSK)에 만료됩니다 — scripts/dev-cert.sh renew',
      href: EXPIRY_SECTION_HREF,
      expiresAt: validTo,
    });
    expect(DEV_CERT_RENEW_COMMAND).toBe('scripts/dev-cert.sh renew');
    expect(EXPIRY_SECTION_HREF).toBe('/settings#expiry');
  });

  it('14일 + 1ms → 없음, 1일 → warn, 0·지남 → expired(만료 시각·갱신 명령)', () => {
    expect(devCertExpiryNotice({ validTo: at(14 * DAY + 1) }, NOW)).toBeNull();
    expect(devCertExpiryNotice({ validTo: at(DAY) }, NOW)?.level).toBe('warn');
    for (const ms of [0, -DAY]) {
      const n = devCertExpiryNotice({ validTo: at(ms) }, NOW)!;
      expect(n.level).toBe('expired');
      expect(n.text).toBe(`로컬 인증서가 ${formatMsk(at(ms))}에 만료되었습니다 — scripts/dev-cert.sh renew`);
      expect(n.href).toBe(EXPIRY_SECTION_HREF);
    }
  });
});

describe('expiryNotices — 여러 알림 순서', () => {
  it('만료됨 먼저 → 곧 만료, 같은 단계 안에서는 만료 시각이 이른 것부터; 모의·먼 만료는 빠진다', () => {
    const notices = run(
      [
        live({ account_id: 'a-warn-10d', expires_at: at(10 * DAY).toISOString() }),
        live({ account_id: 'b-expired-1d', expires_at: at(-1 * DAY).toISOString() }),
        mock({ account_id: 'm-ignored', expires_at: at(-5 * DAY).toISOString() }),
        live({ account_id: 'c-warn-3d', expires_at: at(3 * DAY).toISOString() }),
        live({ account_id: 'd-far-60d', expires_at: at(60 * DAY).toISOString() }),
      ],
      { validTo: at(-2 * DAY) },
    );
    expect(notices.map((n) => [n.kind, n.level, n.accountId ?? null])).toEqual([
      ['dev_cert', 'expired', null],
      ['threads_connection', 'expired', 'b-expired-1d'],
      ['threads_connection', 'warn', 'c-warn-3d'],
      ['threads_connection', 'warn', 'a-warn-10d'],
    ]);
  });

  it('같은 단계·같은 만료 시각이면 Threads 연결 → 로컬 인증서', () => {
    const t = at(5 * DAY);
    const notices = run([live({ expires_at: t.toISOString() })], { validTo: t });
    expect(notices.map((n) => n.kind)).toEqual(['threads_connection', 'dev_cert']);
  });

  it('입력 배열을 바꾸지 않는다', () => {
    const accounts = [live({ expires_at: at(2 * DAY).toISOString() }), live({ expires_at: at(1 * DAY).toISOString() })];
    const copy = JSON.parse(JSON.stringify(accounts));
    run(accounts);
    expect(accounts).toEqual(copy);
  });
});
