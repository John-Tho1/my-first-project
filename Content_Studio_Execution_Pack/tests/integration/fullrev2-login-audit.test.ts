/**
 * FIX2-FULLREV2(G15): 인증 없는 로그인 요청이 audit_events 를 무제한으로 키우지 못한다.
 * - 설정 때문에 거부되는 식별자 로그인(identity_login_disabled·dev_login_not_allowed): 감사 행 없음, 서버 로그는 사유 이름만 1분 1회.
 * - OIDC 취소(callback?error=…): 24시간 창 안 OIDC_CANCEL_AUDIT_MAX 행까지만 기록, 넘으면 응답은 같고 행은 늘지 않는다. 실패 횟수(429)에 세지 않음.
 * - audit_events(action, at) 색인(migration 0048).
 * 실제 진입점(route) + 가짜 IdP(실제 네트워크 0). 이 파일만의 getDb 싱글턴(memory://).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { count, inArray, sql } from 'drizzle-orm';
import { closeDb, countRecentLoginDenials, countRecentLoginFailures, getDb, recordAudit, schema, seed, type Db } from '@cs/db';
import {
  LOGIN_FAILURE_REASONS,
  LOGIN_FAILURE_WINDOW_MS,
  loadConfig,
  OIDC_CANCEL_AUDIT_MAX,
  OIDC_CANCEL_AUDIT_WINDOW_MS,
} from '@cs/domain';
import * as startRoute from '../../apps/web/app/api/auth/oidc/start/route';
import * as callbackRoute from '../../apps/web/app/api/auth/oidc/callback/route';
import * as loginRoute from '../../apps/web/app/api/auth/login/route';
import { resetAuthDenialLogForTests } from '../../apps/web/lib/auth-log';
import { resetOidcLoginClientForTests } from '../../apps/web/lib/oidc';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp } from '../helpers/fake-oidc-idp';
import { BASE, jsonPost } from './helpers';

const OWNER = 'owner@example.local';
const KEY = randomBytes(32).toString('base64');
const OIDC_ENV: Record<string, string> = {
  AUTH_MODE: 'oidc',
  OIDC_ISSUER_URL: FAKE_ISSUER,
  OIDC_CLIENT_ID: FAKE_CLIENT_ID,
  OIDC_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  OIDC_REDIRECT_URI: `${BASE}/api/auth/oidc/callback`,
  AUTH_ALLOWED_IDENTITY: OWNER,
  SECRETS_MASTER_KEY: KEY,
  SECRETS_KEY_VERSION: '1',
};

let db: Db;
let idp: FakeIdp;
let warns: string[];

beforeAll(async () => {
  db = (await getDb(loadConfig())).db;
  await seed(db, { allowedIdentity: OWNER });
});
afterAll(async () => {
  await closeDb();
});
beforeEach(async () => {
  idp = createFakeIdp();
  vi.stubGlobal('fetch', idp.fetch);
  resetOidcLoginClientForTests();
  resetAuthDenialLogForTests();
  await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.action, ['auth.login', 'auth.login_denied']));
  await db.delete(schema.authOidcStates);
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(a.map(String).join(' '));
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const auditCount = async () => (await db.select({ n: count() }).from(schema.auditEvents))[0]!.n;
const denialsByReason = async (reason: string) =>
  (
    await db
      .select({ n: count() })
      .from(schema.auditEvents)
      .where(sql`${schema.auditEvents.action} = 'auth.login_denied' and ${schema.auditEvents.sanitizedDetails}->>'reason' = ${reason}`)
  )[0]!.n;
const failures = () => countRecentLoginFailures(db, { now: new Date(), windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS });

describe('설정 때문에 거부되는 식별자 로그인 — 감사 행 없음, 로그 1분 1회(이름만)', () => {
  it('AUTH_MODE=oidc: POST /api/auth/login 30회 → 모두 403 identity_login_disabled, audit_events 행 0, 서버 로그 1줄', async () => {
    for (const [k, v] of Object.entries(OIDC_ENV)) vi.stubEnv(k, v);
    const before = await auditCount();
    for (let i = 0; i < 30; i++) {
      const res = await loginRoute.POST(jsonPost('/api/auth/login', { identity: OWNER }));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('identity_login_disabled');
    }
    expect(await auditCount()).toBe(before);
    expect(await failures()).toBe(0);
    const lines = warns.filter((w) => w.includes('login_denied_not_audited'));
    expect(lines).toEqual(['[auth] login_denied_not_audited: identity_login_disabled']);
    expect(warns.join('\n')).not.toContain(OWNER);
  });

  it('dev + APP_BASE_URL=https(비 localhost) → dev_login_not_allowed 반복해도 행 0, 1분이 지나면 로그를 다시 남긴다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.stubEnv('APP_BASE_URL', 'https://example.com');
    const before = await auditCount();
    const post = () =>
      loginRoute.POST(
        new Request('https://example.com/api/auth/login', {
          method: 'POST',
          headers: { origin: 'https://example.com', 'content-type': 'application/json' },
          body: JSON.stringify({ identity: OWNER }),
        }),
      );
    for (let i = 0; i < 5; i++) expect((await post()).status).toBe(403);
    const lines = () => warns.filter((w) => w.includes('login_denied_not_audited: dev_login_not_allowed'));
    expect(lines()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 59_000);
    expect((await post()).status).toBe(403);
    expect(lines()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 2_000);
    expect((await post()).status).toBe(403);
    expect(lines()).toHaveLength(2);
    expect(await auditCount()).toBe(before);
  });
});

describe('OIDC 취소(callback?error=…) — 감사 기록 상한', () => {
  async function cancelOnce(): Promise<Response> {
    const s = await startRoute.GET(new Request(`${BASE}/api/auth/oidc/start`, { headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' } }));
    expect(s.status).toBe(303);
    const flow = /^cs_oidc_flow=([^;]*)/.exec(s.headers.getSetCookie().find((c) => c.startsWith('cs_oidc_flow='))!)![1]!;
    return callbackRoute.GET(new Request(idp.deny(s.headers.get('location')!), { headers: { accept: 'application/json', cookie: `cs_oidc_flow=${flow}` } }));
  }

  it(`취소를 상한(${OIDC_CANCEL_AUDIT_MAX})보다 5번 더 반복 → 응답은 모두 401 oidc_cancelled, oidc_cancelled 행은 상한에서 멈춤, 실패로 세지 않음, 이후 정상 로그인 성공`, async () => {
    for (const [k, v] of Object.entries(OIDC_ENV)) vi.stubEnv(k, v);
    for (let i = 0; i < OIDC_CANCEL_AUDIT_MAX + 5; i++) {
      const res = await cancelOnce();
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('oidc_cancelled');
    }
    expect(await denialsByReason('oidc_cancelled')).toBe(OIDC_CANCEL_AUDIT_MAX);
    expect(await failures()).toBe(0);
    expect(warns.filter((w) => w === '[auth] login_denied_not_audited: oidc_cancelled')).toHaveLength(1);
    // 취소가 owner 로그인을 막지 않는다(429 아님)
    const s = await startRoute.GET(new Request(`${BASE}/api/auth/oidc/start`, { headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' } }));
    const flow = /^cs_oidc_flow=([^;]*)/.exec(s.headers.getSetCookie().find((c) => c.startsWith('cs_oidc_flow='))!)![1]!;
    const ok = await callbackRoute.GET(
      new Request(idp.authorize(s.headers.get('location')!, { sub: 'owner-sub-1', email: OWNER, email_verified: true }), {
        headers: { accept: 'application/json', cookie: `cs_oidc_flow=${flow}` },
      }),
    );
    expect(ok.status).toBe(200);
  });

  it('FIX2-FULLREV2(G15 fixup): 상한을 넘은 취소는 요청마다의 oidc_login_denied 줄을 남기지 않는다 — oidc_cancelled 를 담은 경고는 1분 창마다 1줄 이하', async () => {
    for (const [k, v] of Object.entries(OIDC_ENV)) vi.stubEnv(k, v);
    // 대조: 상한 전 취소는 감사 행 + 요청마다의 경고 줄 1개
    expect((await cancelOnce()).status).toBe(401);
    expect(warns.filter((w) => w.includes('oidc_cancelled'))).toEqual(['[auth] oidc_login_denied: oidc_cancelled/provider_error_param']);
    // 창 안 기록을 상한까지 채운다
    const n = OIDC_CANCEL_AUDIT_MAX - (await denialsByReason('oidc_cancelled'));
    for (let i = 0; i < n; i++) {
      await recordAudit(db, { ownerId: null, action: 'auth.login_denied', entity: 'session', details: { reason: 'oidc_cancelled', check: 'provider_error_param', mode: 'oidc' }, at: new Date() });
    }
    warns.length = 0;
    for (let i = 0; i < 12; i++) {
      const res = await cancelOnce();
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe('oidc_cancelled');
    }
    expect(await denialsByReason('oidc_cancelled')).toBe(OIDC_CANCEL_AUDIT_MAX);
    expect(warns.filter((w) => w.includes('oidc_cancelled'))).toEqual(['[auth] login_denied_not_audited: oidc_cancelled']);
    // 1분이 지나면 다시 1줄(창마다 1줄 이하)
    const later = Date.now() + 61_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    for (let i = 0; i < 3; i++) expect((await cancelOnce()).status).toBe(401);
    expect(warns.filter((w) => w.includes('oidc_cancelled'))).toHaveLength(2);
  });

  it('상한은 24시간 창 기준 — 창 밖(25시간 전) 취소 기록은 세지 않아 다시 기록한다, 다른 사유의 거부는 상한과 무관', async () => {
    for (const [k, v] of Object.entries(OIDC_ENV)) vi.stubEnv(k, v);
    const old = new Date(Date.now() - OIDC_CANCEL_AUDIT_WINDOW_MS - 3_600_000);
    for (let i = 0; i < OIDC_CANCEL_AUDIT_MAX; i++) {
      await recordAudit(db, { ownerId: null, action: 'auth.login_denied', entity: 'session', details: { reason: 'oidc_cancelled', check: 'provider_error_param', mode: 'oidc' }, at: old });
    }
    expect(await countRecentLoginDenials(db, { now: new Date(), windowMs: OIDC_CANCEL_AUDIT_WINDOW_MS, reason: 'oidc_cancelled' })).toBe(0);
    expect((await cancelOnce()).status).toBe(401);
    expect(await denialsByReason('oidc_cancelled')).toBe(OIDC_CANCEL_AUDIT_MAX + 1);
    // 다른 사유(identity mismatch 등) 행은 취소 상한에 들어가지 않는다
    expect(await countRecentLoginDenials(db, { now: new Date(), windowMs: OIDC_CANCEL_AUDIT_WINDOW_MS, reason: 'oidc_identity_mismatch' })).toBe(0);
  });
});

describe('audit_events(action, at) 색인', () => {
  it('색인이 정의대로 있고, 순차 읽기를 끄면 로그인 거부 세기가 그 색인을 읽는다', async () => {
    const idx = (await db.execute(sql`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'audit_events_action_at_idx'`)).rows as Array<{ indexdef: string }>;
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain('USING btree (action, at)');
    const scans = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const n = async () => ((await tx.execute(sql`select pg_stat_get_xact_numscans('audit_events_action_at_idx'::regclass)::int as n`)).rows as Array<{ n: number }>)[0]!.n;
      const a = await n();
      await countRecentLoginDenials(tx, { now: new Date(), windowMs: OIDC_CANCEL_AUDIT_WINDOW_MS, reason: 'oidc_cancelled' });
      await countRecentLoginFailures(tx, { now: new Date(), windowMs: LOGIN_FAILURE_WINDOW_MS, reasons: LOGIN_FAILURE_REASONS });
      return (await n()) - a;
    });
    expect(scans).toBeGreaterThan(0);
  });
});
