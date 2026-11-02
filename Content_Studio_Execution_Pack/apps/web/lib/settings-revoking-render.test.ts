/**
 * FIX2-FULLREV2(G14): 설정 → 배포 계정 연결 표 — 연결 해제가 끝나지 않은(revoking) 계정에는 "다시 연결" 버튼(connect 폼) 대신 "연결 해제 미완료" 안내.
 * 연결 시작 route 가 revoking 을 409 credential_busy 로 거부하므로, 누르면 실패할 버튼을 보이지 않는다. 실제 accountHealthView 결과로 렌더한다
 * (DB·세션은 가짜, 설정은 실제 loadConfig — live 준비가 모두 갖춰진 경우도 본다).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@cs/domain';
import { accountHealthView, type OAuthCredentialRow } from '@cs/db';

const state = vi.hoisted(() => ({ accounts: [] as unknown[], config: null as unknown }));

vi.mock('./auth', () => ({ getSession: async () => ({ ownerId: '00000000-0000-4000-8000-000000000001', identity: 'owner@example.local', expiresAt: new Date() }) }));
vi.mock('./server', () => ({ getConfig: () => state.config, getAppDb: async () => ({ db: {} }), getStorage: () => ({}) }));
vi.mock('./dev-cert', () => ({ readDevCertExpiry: () => null }));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('redirect');
  },
}));
vi.mock('@cs/db', async (orig) => ({
  ...(await orig<typeof import('@cs/db')>()),
  listAccountHealth: async () => state.accounts,
  livePublishOverview: async () => ({ hasLiveAccount: false, paused: false, changedAt: null, used: 0, availableAt: null }),
  getLivePublishPaused: async () => ({ paused: false, changedAt: null }),
  monthlyUsage: async () => ({ byCurrency: [] }),
  listExportRuns: async () => [],
  listRestoreRuns: async () => [],
}));

const { default: SettingsPage } = await import('../app/settings/page');

const OWNER = '00000000-0000-4000-8000-000000000001';
const REDIRECT = 'http://localhost:3000/api/oauth/callback';
const LIVE_ENV = {
  NODE_ENV: 'test',
  OAUTH_MODE: 'live',
  THREADS_APP_ID: '000000000000001',
  THREADS_APP_SECRET: 'FAKE_app_secret_G14_render_only',
  OAUTH_REDIRECT_URI: REDIRECT,
  OAUTH_LIVE_APPROVAL_REF: 'D31',
  SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SECRETS_KEY_VERSION: '1',
};

const accRow = (id: string, name: string, live: boolean): Parameters<typeof accountHealthView>[0] => ({
  id,
  ownerId: OWNER,
  platform: 'threads',
  kind: live ? 'live' : 'mock',
  externalAccountId: live ? `178414000000${id.slice(0, 5).replace(/\D/g, '0')}` : `mock:threads:${id}`,
  displayName: name,
  state: live ? 'disconnected' : 'mock_ready',
  capabilitySnapshot: {},
  createdAt: new Date('2026-10-13T12:00:00Z'),
  credentialState: 'linked',
});
const credRow = (accountId: string, live: boolean, status: string): OAuthCredentialRow => ({
  id: `${accountId.slice(0, -4)}cccc`,
  ownerId: OWNER,
  channelAccountId: accountId,
  provider: live ? 'threads' : 'mock_threads',
  isMock: !live,
  encryptedToken: 'sealed',
  keyVersion: 1,
  tokenGeneration: 1,
  revocationEpoch: status === 'revoking' ? 1 : 0,
  revokeOpId: status === 'revoking' ? '77777777-7777-4777-8777-777777777777' : null,
  revokeResumeAt: null,
  revokeResumeAttempts: status === 'revoking' ? 1 : 0,
  expiresAt: new Date(Date.now() + 30 * 86_400_000),
  scopes: ['threads_basic', 'threads_content_publish'],
  status,
  connectedAt: new Date('2026-10-13T12:41:00Z'),
  lastCheckedAt: null,
  lastRefreshedAt: null,
  lastErrorCode: status === 'revoking' ? 'revoke_current_unreadable' : null,
  revokedAt: null,
  createdAt: new Date('2026-10-13T12:41:00Z'),
  updatedAt: new Date('2026-10-13T12:41:00Z'),
});

const view = (id: string, name: string, live: boolean, status: string) => accountHealthView(accRow(id, name, live), credRow(id, live, status), null, new Date());
const renderSettings = async () => renderToStaticMarkup(await SettingsPage({ searchParams: Promise.resolve({}) }));
const tableRow = (html: string, name: string) => {
  const table = html.slice(html.indexOf('<table class="compare">'));
  const i = table.indexOf(name);
  expect(i).toBeGreaterThan(-1);
  return table.slice(table.lastIndexOf('<tr>', i), table.indexOf('</tr>', i));
};

const LIVE_REV = '11111111-1111-4111-8111-111111111111';
const LIVE_ACT = '22222222-2222-4222-8222-222222222222';
const MOCK_REV = '33333333-3333-4333-8333-333333333333';
const MOCK_ACT = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  for (const [k, v] of Object.entries(LIVE_ENV)) vi.stubEnv(k, v);
  state.config = loadConfig(process.env);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('FIX2-FULLREV2(G14) — 해제 미완료 계정은 다시 연결 버튼 대신 안내', () => {
  it('live 준비가 갖춰져도 revoking 실제·모의 계정 행: "연결 해제 미완료" 안내, connect 폼·다시 연결 버튼 없음, 연결 해제 버튼은 남음. 대조: active 계정은 다시 연결 버튼', async () => {
    state.accounts = [
      view(LIVE_REV, '@live-revoking', true, 'revoking'),
      view(LIVE_ACT, '@live-active', true, 'active'),
      view(MOCK_REV, '모의 해제중', false, 'revoking'),
      view(MOCK_ACT, '모의 연결됨', false, 'active'),
    ];
    const html = await renderSettings();
    // 전제: 실제 연결 준비가 끝난 화면(준비 안 됨이면 원래 버튼이 없으므로 시험이 의미 없다)
    expect(html).not.toContain('실제 연결 준비 안 됨');
    for (const [id, name] of [
      [LIVE_REV, '@live-revoking'],
      [MOCK_REV, '모의 해제중'],
    ] as const) {
      const row = tableRow(html, name);
      expect(row).toContain('연결 해제 미완료');
      expect(row).not.toContain(`/api/channel-accounts/${id}/connect`);
      expect(row).not.toContain('다시 연결(실제 Threads)');
      expect(row).not.toContain('다시 연결(모의)');
      expect(row).toContain(`/api/channel-accounts/${id}/revoke`);
    }
    const liveActive = tableRow(html, '@live-active');
    expect(liveActive).toContain(`/api/channel-accounts/${LIVE_ACT}/connect`);
    expect(liveActive).toContain('다시 연결(실제 Threads)');
    expect(liveActive).not.toContain('연결 해제 미완료');
    const mockActive = tableRow(html, '모의 연결됨');
    expect(mockActive).toContain(`/api/channel-accounts/${MOCK_ACT}/connect`);
    expect(mockActive).toContain('다시 연결(모의)');
    expect(mockActive).not.toContain('연결 해제 미완료');
  });
});
