/**
 * EXPIRY-1(결정 D39): 홈·설정 화면 렌더(DB·세션·인증서 읽기는 가짜) — 실제 Threads 연결·로컬 인증서 만료 14일 전부터 맨 위 알림,
 * 설정 → 배포 계정 연결 표의 "만료" 칸 옆 계정별 표시, 설정 "만료 관리" 구역. 모의 계정은 알림 없음. LIVE-P2 "실제 게시" 표시는 그대로.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMsk, THREADS_CONNECTION_EXPIRED_TEXT } from '@cs/domain';
import { accountHealthView, type OAuthCredentialRow } from '@cs/db';

const state = vi.hoisted(() => ({
  accounts: [] as unknown[],
  devCert: null as { validTo: Date } | null,
  /** FIX1-EXPIRY1: 화면이 readDevCertExpiry 에 넘긴 인수(옵션 없음이어야 dev-cert-default.test.ts 의 운영 판정 시험이 그 경로를 덮는다) */
  devCertArgs: [] as unknown[][],
  overview: { hasLiveAccount: false, paused: false, changedAt: null as Date | null, used: 0, availableAt: null as Date | null },
}));

vi.mock('./auth', () => ({ getSession: async () => ({ ownerId: '00000000-0000-4000-8000-000000000001', identity: 'owner@example.local', expiresAt: new Date() }) }));
vi.mock('./server', async () => {
  const { loadConfig } = await import('@cs/domain');
  return { getConfig: () => loadConfig({ NODE_ENV: 'test' }), getAppDb: async () => ({ db: {} }), getStorage: () => ({}) };
});
vi.mock('./dev-cert', () => ({
  readDevCertExpiry: (...args: unknown[]) => {
    state.devCertArgs.push(args);
    return state.devCert;
  },
}));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect');
  },
}));
vi.mock('@cs/db', async (orig) => ({
  ...(await orig<typeof import('@cs/db')>()),
  listAccountHealth: async () => state.accounts,
  livePublishOverview: async () => state.overview,
  // 홈
  listCaptures: async () => [],
  listAssets: async () => [],
  listCapturesPage: async () => ({ items: [], next: null }),
  latestDraft: async () => null,
  listRecentPlans: async () => [],
  // 설정
  monthlyUsage: async () => ({ byCurrency: [] }),
  listExportRuns: async () => [],
  listRestoreRuns: async () => [],
}));

const { default: HomePage } = await import('../app/page');
const { default: SettingsPage } = await import('../app/settings/page');

const DAY = 86_400_000;
const fromNow = (ms: number) => new Date(Date.now() + ms);

function account(o: { id: string; live: boolean; expiresAt: Date | null; name?: string; revoked?: boolean; revoking?: boolean }) {
  return {
    account_id: o.id,
    platform: 'threads',
    kind: o.live ? 'live' : 'mock',
    mock: !o.live,
    display_name: o.name ?? (o.live ? '@tester' : '모의 Threads'),
    credential_state: 'linked',
    // FIX1-EXPIRY1: 연결 해제 진행 중은 accountHealthView 가 status 'revoked'·reason 'revoking'·revoked_at null 로 보낸다(credentialHealth)
    status: o.revoking ? 'revoked' : 'connected',
    status_label: o.revoking ? '연결 해제됨' : '연결됨',
    usable_for_execution: !o.revoking,
    credential_required: true,
    reason: o.revoking ? 'revoking' : null,
    provider: o.live ? 'threads' : 'mock_threads',
    scopes_required: ['threads_basic', 'threads_content_publish'],
    scopes_granted: ['threads_basic', 'threads_content_publish'],
    missing_scopes: [],
    expires_at: o.expiresAt ? o.expiresAt.toISOString() : null,
    connected_at: new Date('2026-10-13T12:41:00Z').toISOString(),
    last_checked_at: null,
    last_refreshed_at: null,
    last_error_code: null,
    revoked_at: o.revoked ? new Date('2026-10-14T00:00:00Z').toISOString() : null,
    key_version: 1,
    pending_reconcile: null,
    pending_count: 0,
    notice: '',
    live_unbound: false,
    account_state: o.live ? 'connected' : 'mock_ready',
    live_publish_target: o.live,
  };
}

const renderHome = async () => renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve({}) }));
const renderSettings = async () => renderToStaticMarkup(await SettingsPage({ searchParams: Promise.resolve({}) }));

/** 맨 위 알림 구역 */
const noticeBlock = (html: string) => {
  const i = html.indexOf('<section class="expiry-notices" aria-label="만료 알림">');
  return i < 0 ? '' : html.slice(i, html.indexOf('</section>', i));
};
const noticeLines = (html: string) => [...noticeBlock(html).matchAll(/<p class="notice"[^>]*>[\s\S]*?<\/p>/g)].map((m) => m[0]);
/** 설정 표에서 계정 이름이 든 행 */
const tableRow = (html: string, name: string) => {
  const table = html.slice(html.indexOf('<table class="compare">'));
  const i = table.indexOf(name);
  expect(i).toBeGreaterThan(-1);
  return table.slice(table.lastIndexOf('<tr>', i), table.indexOf('</tr>', i));
};
const expirySection = (html: string) => {
  const i = html.indexOf('id="expiry"');
  expect(i).toBeGreaterThan(-1);
  return html.slice(i, html.indexOf('</section>', i));
};

beforeEach(() => {
  state.accounts = [];
  state.devCert = null;
  state.devCertArgs = [];
  state.overview = { hasLiveAccount: false, paused: false, changedAt: null, used: 0, availableAt: null };
});

describe('FIX1-EXPIRY1: 화면의 인증서 읽기 호출 꼴', () => {
  it('홈·설정은 readDevCertExpiry() 를 옵션 없이 한 번씩 부른다(운영 판정은 그 기본 경로에서 시험 — dev-cert-default.test.ts)', async () => {
    await renderHome();
    expect(state.devCertArgs).toEqual([[]]);
    state.devCertArgs = [];
    await renderSettings();
    expect(state.devCertArgs).toEqual([[]]);
  });
});

describe('홈 — 맨 위 만료 알림', () => {
  it('실제 Threads 연결 3일 남음 → 헤더 바로 아래·"오늘" 위에 곧 만료 알림(모스크바 시각), 설정 배포 계정 연결로 링크', async () => {
    const exp = fromNow(3 * DAY);
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: exp })];
    const html = await renderHome();
    const lines = noticeLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('role="status"');
    expect(lines[0]).toContain('<span class="tag warn">곧 만료</span>');
    expect(lines[0]).toContain(`<a href="/settings#accounts">Threads 연결이 ${formatMsk(exp)}에 만료됩니다 — 설정에서 다시 연결하세요</a>`);
    expect(lines[0]).toContain('(MSK)');
    const at = html.indexOf('aria-label="만료 알림"');
    expect(at).toBeGreaterThan(html.indexOf('</header>'));
    expect(at).toBeLessThan(html.indexOf('<h2 class="screen-title">오늘</h2>'));
  });

  it('실제 Threads 연결 만료됨 → role="alert"·만료됨 태그·고정 문구', async () => {
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: fromNow(-DAY) })];
    const [line, ...rest] = noticeLines(await renderHome());
    expect(rest).toEqual([]);
    expect(line).toContain('role="alert"');
    expect(line).toContain('<span class="tag danger">만료됨</span>');
    expect(line).toContain(`<a href="/settings#accounts">${THREADS_CONNECTION_EXPIRED_TEXT}</a>`);
  });

  it('모의 계정(1일 남음)·실제 30일 남음·연결 해제한 실제 계정 → 알림 구역 자체가 없다', async () => {
    state.accounts = [
      account({ id: 'mock-1', live: false, expiresAt: fromNow(DAY) }),
      account({ id: 'live-far', live: true, expiresAt: fromNow(30 * DAY), name: '@far' }),
      account({ id: 'live-rev', live: true, expiresAt: fromNow(DAY), name: '@revoked', revoked: true }),
    ];
    const html = await renderHome();
    expect(html).not.toContain('aria-label="만료 알림"');
    expect(html).not.toContain('Threads 연결이');
  });

  it('FIX1-EXPIRY1: 연결 해제 진행 중(revoking, revoked_at 아직 null)인 실제 계정은 1일·만료됨이어도 "다시 연결" 알림이 없다', async () => {
    state.accounts = [
      account({ id: 'live-revoking', live: true, expiresAt: fromNow(DAY), name: '@revoking', revoking: true }),
      account({ id: 'live-revoking-exp', live: true, expiresAt: fromNow(-DAY), name: '@revoking2', revoking: true }),
    ];
    const html = await renderHome();
    expect(html).not.toContain('aria-label="만료 알림"');
    expect(html).not.toContain('Threads 연결이');
  });

  it('로컬 인증서(개발 모드에서 읽은 값) 5일 남음 + 실제 연결 만료 → 만료됨 먼저, 인증서 알림은 설정 만료 관리로 링크', async () => {
    const validTo = fromNow(5 * DAY);
    state.devCert = { validTo };
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: fromNow(-1000) })];
    const lines = noticeLines(await renderHome());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('data-expiry-kind="threads_connection"');
    expect(lines[0]).toContain('data-expiry-level="expired"');
    expect(lines[1]).toContain('data-expiry-kind="dev_cert"');
    expect(lines[1]).toContain(`<a href="/settings#expiry">로컬 인증서가 ${formatMsk(validTo)}에 만료됩니다 — scripts/dev-cert.sh renew</a>`);
  });

  it('LIVE-P2 한 줄(실제 게시: 최근 24시간 n/한도)은 그대로 헤더 안에 있다', async () => {
    state.overview = { hasLiveAccount: true, paused: false, changedAt: null, used: 1, availableAt: null };
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: fromNow(2 * DAY) })];
    const html = await renderHome();
    const header = html.slice(0, html.indexOf('</header>'));
    expect(header).toContain('<a href="/settings#live-publish">실제 게시: 최근 24시간 1건(일일 상한 없음)');
    expect(noticeLines(html)).toHaveLength(1);
  });
});

describe('설정 — 맨 위 알림 · 만료 관리 · 배포 계정 표의 만료 칸', () => {
  it('실제 Threads 3일 남음 → 맨 위 알림 + 표의 만료 칸 옆 "14일 안에 만료" + 만료 관리 행', async () => {
    const exp = fromNow(3 * DAY);
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: exp, name: '@yongho' }), account({ id: 'mock-1', live: false, expiresAt: fromNow(DAY), name: '모의 계정' })];
    const html = await renderSettings();
    const lines = noticeLines(html);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`<a href="/settings#accounts">Threads 연결이 ${formatMsk(exp)}에 만료됩니다 — 설정에서 다시 연결하세요</a>`);
    expect(html.indexOf('aria-label="만료 알림"')).toBeGreaterThan(html.indexOf('<h2 class="screen-title">설정</h2>'));
    expect(html.indexOf('aria-label="만료 알림"')).toBeLessThan(html.indexOf('id="auth-title"'));
    const liveRow = tableRow(html, '@yongho');
    expect(liveRow).toContain(`${formatMsk(exp)} <span class="tag warn">14일 안에 만료 — 다시 연결하세요</span>`);
    const mockRow = tableRow(html, '모의 계정');
    expect(mockRow).not.toContain('14일 안에 만료');
    expect(mockRow).not.toContain('만료됨');
    const sec = expirySection(html);
    expect(sec).toContain('<dt>Threads 연결</dt><dd>@yongho · ' + formatMsk(exp) + ' <span class="tag warn">곧 만료</span></dd>');
    expect(sec).not.toContain('모의 계정');
    expect(sec).toContain('bash scripts/dev-cert.sh renew');
    expect(sec).toContain('토큰 갱신 API 호출 없음');
  });

  it('실제 Threads 만료됨 → 표의 만료 칸 옆 "만료됨 — 다시 연결 필요"(tag danger)', async () => {
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: fromNow(-DAY), name: '@yongho' })];
    const html = await renderSettings();
    expect(tableRow(html, '@yongho')).toContain('<span class="tag danger">만료됨 — 다시 연결 필요</span>');
    expect(noticeLines(html)[0]).toContain(THREADS_CONNECTION_EXPIRED_TEXT);
  });

  it('FIX1-EXPIRY1: 연결 해제 진행 중인 실제 계정 → 맨 위 알림·표의 "다시 연결" 태그·만료 관리 행 없음(상태 칸은 연결 해제됨)', async () => {
    const exp = fromNow(DAY);
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: exp, name: '@yongho', revoking: true })];
    const html = await renderSettings();
    expect(noticeBlock(html)).toBe('');
    const row = tableRow(html, '@yongho');
    expect(row).toContain('연결 해제됨');
    expect(row).toContain(`<td>${formatMsk(exp)}</td>`);
    expect(row).not.toContain('14일 안에 만료');
    expect(row).not.toContain('다시 연결 필요');
    expect(expirySection(html)).toContain('<dt>Threads 연결</dt><dd>실제 연결 없음</dd>');
  });

  // FIX2-EXPIRY1(검토 #8): 화면 입력을 손으로 만들지 않고 실제 accountHealthView(@cs/db — 가짜로 바꾸지 않음)로 만든다. 해제 진행 중(revoking) 연결 정보에
  // 정리 대기 행이 함께 있으면 credentialHealth 는 error(pending_cleanup_revoke)를 보고하지만, 원래 상태로 해제 중임을 알아 "다시 연결" 알림·태그를 내지 않는다.
  it('FIX2-EXPIRY1: 실제 accountHealthView — 해제 진행 중 + 정리 대기(상태 error) 계정은 홈·설정 알림·표 태그 없음, 정리 대기만 있는 active 계정은 알림', async () => {
    const now = new Date();
    const exp = fromNow(DAY);
    const accRow = (id: string, name: string, externalAccountId: string): Parameters<typeof accountHealthView>[0] => ({
      id,
      ownerId: '00000000-0000-4000-8000-000000000001',
      platform: 'threads',
      kind: 'live',
      externalAccountId,
      displayName: name,
      state: 'connected',
      capabilitySnapshot: {},
      createdAt: new Date('2026-10-13T12:00:00Z'),
      credentialState: 'linked',
    });
    const credRow = (accountId: string, status: string): OAuthCredentialRow => ({
      id: `${accountId.slice(0, -4)}cccc`,
      ownerId: '00000000-0000-4000-8000-000000000001',
      channelAccountId: accountId,
      provider: 'threads',
      isMock: false,
      encryptedToken: null,
      keyVersion: 1,
      tokenGeneration: 1,
      revocationEpoch: 0,
      revokeOpId: null,
      revokeResumeAt: null,
      revokeResumeAttempts: 0,
      expiresAt: exp,
      scopes: ['threads_basic', 'threads_content_publish'],
      status,
      connectedAt: new Date('2026-10-13T12:41:00Z'),
      lastCheckedAt: null,
      lastRefreshedAt: null,
      lastErrorCode: status === 'revoking' ? 'revoke_provider_unavailable' : null,
      revokedAt: null,
      createdAt: new Date('2026-10-13T12:41:00Z'),
      updatedAt: new Date('2026-10-13T12:41:00Z'),
    });
    const REV = '55555555-5555-4555-8555-555555555555';
    const ACT = '66666666-6666-4666-8666-666666666666';
    const revoking = accountHealthView(accRow(REV, '@revoking-pending', '17841400000000091'), credRow(REV, 'revoking'), { kind: 'cleanup_revoke', count: 1 }, now);
    expect(revoking).toMatchObject({ status: 'error', reason: 'pending_cleanup_revoke', revoked_at: null, credential_status: 'revoking' });
    state.accounts = [revoking];
    let html = await renderHome();
    expect(html).not.toContain('aria-label="만료 알림"');
    expect(html).not.toContain('Threads 연결이');
    html = await renderSettings();
    expect(noticeBlock(html)).toBe('');
    const row = tableRow(html, '@revoking-pending');
    expect(row).toContain(`<td>${formatMsk(exp)}</td>`);
    expect(row).not.toContain('14일 안에 만료');
    expect(row).not.toContain('다시 연결 필요');
    expect(expirySection(html)).toContain('<dt>Threads 연결</dt><dd>실제 연결 없음</dd>');
    // 대조: 정리 대기만 있는 active 연결 정보(같은 error 상태)는 다시 연결로 풀리므로 그대로 알린다
    const pendingOnly = accountHealthView(accRow(ACT, '@pending-only', '17841400000000092'), credRow(ACT, 'active'), { kind: 'cleanup_revoke', count: 1 }, now);
    expect(pendingOnly).toMatchObject({ status: 'error', credential_status: 'active' });
    state.accounts = [revoking, pendingOnly];
    html = await renderSettings();
    expect(noticeLines(html)).toHaveLength(1);
    expect(noticeLines(html)[0]).toContain(`Threads 연결이 ${formatMsk(exp)}에 만료됩니다 — 설정에서 다시 연결하세요`);
    expect(tableRow(html, '@pending-only')).toContain('<span class="tag warn">14일 안에 만료 — 다시 연결하세요</span>');
    expect(tableRow(html, '@revoking-pending')).not.toContain('14일 안에 만료');
  });

  it('실제 30일 남음 → 표에 날짜만(경고 없음), 알림 없음', async () => {
    const exp = fromNow(30 * DAY);
    state.accounts = [account({ id: 'live-1', live: true, expiresAt: exp, name: '@yongho' })];
    const html = await renderSettings();
    expect(noticeBlock(html)).toBe('');
    const row = tableRow(html, '@yongho');
    expect(row).toContain(`<td>${formatMsk(exp)}</td>`);
    expect(expirySection(html)).toContain(`<dd>@yongho · ${formatMsk(exp)}</dd>`);
  });

  it('로컬 인증서: 읽지 못함 → "확인 안 됨", 5일 남음 → 날짜 + 곧 만료 + 맨 위 알림', async () => {
    let html = await renderSettings();
    expect(expirySection(html)).toContain('<dt>로컬 인증서</dt><dd>확인 안 됨(파일 없음 또는 읽을 수 없음 — 개발 모드만 확인)</dd>');
    expect(expirySection(html)).toContain('<dt>Threads 연결</dt><dd>실제 연결 없음</dd>');
    expect(noticeBlock(html)).toBe('');
    const validTo = fromNow(5 * DAY);
    state.devCert = { validTo };
    html = await renderSettings();
    expect(expirySection(html)).toContain(`<dt>로컬 인증서</dt><dd>${formatMsk(validTo)} <span class="tag warn">곧 만료</span></dd>`);
    expect(noticeLines(html)[0]).toContain('scripts/dev-cert.sh renew');
  });

  it('LIVE-P2 "실제 게시" 구역은 그대로 있다', async () => {
    const html = await renderSettings();
    expect(html).toContain('id="live-publish"');
    expect(html).toContain('action="/api/live-publish/pause"');
  });
});
