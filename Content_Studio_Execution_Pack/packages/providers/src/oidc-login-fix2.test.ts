/**
 * FIX2-T21P1B(Codex review-FIX-T21P1B): OidcLoginClient 회귀 — 가짜 IdP 만(실제 네트워크 0).
 * P2 oidc-login.ts:318 — 시간 제한 뒤에 헤더가 도착한 응답(signal 무시 fetch)의 끝나지 않는 본문을 즉시 취소하고 unavailable.
 * 놓친 경우: iat +30초 통과·+31초 거부(경계), 비유한 숫자 클레임(1e400 → JSON.parse 결과 Infinity).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OidcClientSettings } from '@cs/domain';
import { createFakeIdp, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, FAKE_ISSUER, type FakeIdp } from '../../../tests/helpers/fake-oidc-idp';
import { OidcLoginClient, OidcLoginFailure } from './oidc-login';

const REDIRECT = 'http://localhost:3000/api/auth/oidc/callback';
const SETTINGS: OidcClientSettings = { issuer: FAKE_ISSUER, clientId: FAKE_CLIENT_ID, clientSecret: FAKE_CLIENT_SECRET, redirectUri: REDIRECT, scopes: ['openid', 'email'] };
const USER = { sub: 'sub-123', email: 'owner@example.local', email_verified: true };

afterEach(() => {
  vi.useRealTimers();
});

async function begin(idp: FakeIdp, client: OidcLoginClient) {
  const req = await client.createAuthorizationRequest();
  const params = new URL(idp.authorize(req.url, USER)).searchParams;
  return () => client.completeAuthorization({ callbackParams: params, expectedState: req.state, expectedNonce: req.nonce, codeVerifier: req.codeVerifier });
}

async function failureOf(p: Promise<unknown>): Promise<OidcLoginFailure> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(OidcLoginFailure);
    return e as OidcLoginFailure;
  }
  throw new Error('expected failure');
}

describe('P2 :318 — 시간 제한 뒤 도착한 응답의 본문 취소', () => {
  for (const path of ['/token', '/jwks']) {
    it(`${path}: signal 무시 fetch 가 시간 제한(200ms) 뒤 헤더를 주고 본문은 끝나지 않음 → unavailable, 늦은 본문은 곧 취소된다`, async () => {
      const idp = createFakeIdp();
      let cancelled = false;
      let delivered = false;
      const fetchFn: FakeIdp['fetch'] = async (input, init) => {
        if (new URL(String(input)).pathname !== path) return idp.fetch(input, init);
        await new Promise((r) => setTimeout(r, 500)); // signal 무시 — 시간 제한 뒤에야 헤더
        delivered = true;
        const body = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new TextEncoder().encode('{"x":'));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const client = new OidcLoginClient(SETTINGS, { fetch: fetchFn, timeoutMs: 200 });
      const f = await failureOf((await begin(idp, client))());
      expect(f.kind).toBe('unavailable');
      // 늦게 도착한 응답이 오면 곧바로 본문을 취소한다(무기한 읽지 않음)
      for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 20));
      expect(delivered).toBe(true);
      expect(cancelled).toBe(true);
    }, 15_000);
  }

  it('본문 취소가 끝나지 않아도(cancel 이 영원히 대기) 실패는 시간 제한 안에 돌아온다', async () => {
    const idp = createFakeIdp();
    const fetchFn: FakeIdp['fetch'] = async (input, init) => {
      if (new URL(String(input)).pathname !== '/token') return idp.fetch(input, init);
      const body = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('{"x":'));
        },
        cancel() {
          return new Promise<void>(() => {}); // 취소 완료가 오지 않음
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = new OidcLoginClient(SETTINGS, { fetch: fetchFn, timeoutMs: 200 });
    const started = Date.now();
    expect((await failureOf((await begin(idp, client))())).kind).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(3000);
  }, 15_000);
});

describe('놓친 경우 — iat 경계·비유한 숫자', () => {
  /** 시계를 고정(라이브러리·우리 검사·가짜 IdP 가 같은 Date.now 를 본다) */
  function freeze(): number {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = Math.floor(Date.now() / 1000) * 1000 + 500;
    vi.setSystemTime(t);
    return Math.floor(t / 1000);
  }

  it('iat = 지금 + 30초 → 통과(허용 오차 안)', async () => {
    const now = freeze();
    const idp = createFakeIdp();
    const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
    const run = await begin(idp, client);
    idp.behavior.claims = { iat: now + 30 };
    expect((await run()).sub).toBe('sub-123');
  });

  it('iat = 지금 + 31초 → invalid', async () => {
    const now = freeze();
    const idp = createFakeIdp();
    const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
    const run = await begin(idp, client);
    idp.behavior.claims = { iat: now + 31 };
    expect((await failureOf(run())).kind).toBe('invalid');
  });

  it.each([
    ['exp = 1e400(Infinity)', /"exp":\d+/, '"exp":1e400'],
    ['iat = 1e400(Infinity)', /"iat":\d+/, '"iat":1e400'],
    ['iat = -1e400(-Infinity)', /"iat":\d+/, '"iat":-1e400'],
  ] as const)('%s → invalid(유한한 숫자만)', async (_n, re, to) => {
    const idp = createFakeIdp();
    const client = new OidcLoginClient(SETTINGS, { fetch: idp.fetch });
    const run = await begin(idp, client);
    idp.behavior.payloadJson = (json) => {
      expect(json).toMatch(re);
      return json.replace(re, to);
    };
    expect((await failureOf(run())).kind).toBe('invalid');
  });
});
