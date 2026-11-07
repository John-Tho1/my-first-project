/**
 * T19(D33 제안) 모의 수집 어댑터: 네트워크 0, hop 마다 정책(redirect·해석 IP·크기), 모드별 생성.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectorFetchError, COLLECTOR_FEED_MAX_BYTES, loadConfig, parseFeed } from '@cs/domain';
import { createCollectorAdapter, MOCK_FEEDS, MockCollectorAdapter } from './collector-mock';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore();
});

const host = (u: string) => new URL(u).hostname;
async function blocked(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    expect(e).toBeInstanceOf(CollectorFetchError);
    const err = e as CollectorFetchError;
    return err.reason ? `${err.code}:${err.reason}` : err.code;
  }
}

describe('MockCollectorAdapter', () => {
  it('허용 목록 안의 고정 자료를 돌려준다(실제 요청 0)', async () => {
    const a = new MockCollectorAdapter();
    const res = await a.fetchFeed({ url: MOCK_FEEDS.overseasSales, allowlist: [host(MOCK_FEEDS.overseasSales)], maxBytes: COLLECTOR_FEED_MAX_BYTES });
    expect(res.finalUrl).toBe(MOCK_FEEDS.overseasSales);
    expect(parseFeed(res.bytes, res.finalUrl).items.length).toBe(6);
    expect(a.requested).toEqual([MOCK_FEEDS.overseasSales]);
  });

  it('A05: 메타데이터·localhost 로 가는 redirect 는 차단되고 그 대상은 "요청"하지 않는다', async () => {
    const a = new MockCollectorAdapter();
    const allow = ['redirect.mock.example'];
    expect(await blocked(a.fetchFeed({ url: MOCK_FEEDS.redirectToMetadata, allowlist: allow, maxBytes: COLLECTOR_FEED_MAX_BYTES }))).toBe('blocked:scheme');
    expect(await blocked(a.fetchFeed({ url: MOCK_FEEDS.redirectToLocalhost, allowlist: allow, maxBytes: COLLECTOR_FEED_MAX_BYTES }))).toBe('blocked:blocked_host');
    expect(a.requested).toEqual([MOCK_FEEDS.redirectToMetadata, MOCK_FEEDS.redirectToLocalhost]);
    expect(a.requested.some((u) => u.includes('169.254') || u.includes('localhost/'))).toBe(false);
  });

  it('같은 호스트 redirect 는 따라가고, 허용 목록 밖 호스트로의 redirect 는 차단', async () => {
    const a = new MockCollectorAdapter();
    const ok = await a.fetchFeed({ url: MOCK_FEEDS.redirectSameHost, allowlist: ['moved.mock.example'], maxBytes: COLLECTOR_FEED_MAX_BYTES });
    expect(ok.finalUrl).toBe('https://moved.mock.example/new-feed.xml');
    expect(ok.redirects).toEqual(['https://moved.mock.example/new-feed.xml']);
    expect(await blocked(a.fetchFeed({ url: MOCK_FEEDS.redirectOffList, allowlist: ['moved.mock.example'], maxBytes: COLLECTOR_FEED_MAX_BYTES }))).toBe('blocked:not_allowlisted');
  });

  it('redirect 반복은 3번까지', async () => {
    const a = new MockCollectorAdapter();
    for (let i = 0; i < 5; i++) a.setFixtureForTest(`https://loop.mock.example/${i}`, { kind: 'redirect', location: `/${i + 1}` });
    expect(await blocked(a.fetchFeed({ url: 'https://loop.mock.example/0', allowlist: ['loop.mock.example'], maxBytes: COLLECTOR_FEED_MAX_BYTES }))).toBe('blocked:too_many_redirects');
  });

  it('이름은 공개처럼 보여도 사설 주소로 풀리면 차단(DNS rebinding 훅)', async () => {
    const a = new MockCollectorAdapter();
    expect(await blocked(a.fetchFeed({ url: MOCK_FEEDS.rebind, allowlist: ['rebind.mock.example'], maxBytes: COLLECTOR_FEED_MAX_BYTES }))).toBe('blocked:private_address');
    expect(a.requested).toEqual([]);
  });

  it('요청 전 정책: 허용 목록 밖·http·IP 리터럴은 요청 없이 차단, 크기 초과 too_large, 없는 주소 not_found', async () => {
    const a = new MockCollectorAdapter();
    expect(await blocked(a.fetchFeed({ url: MOCK_FEEDS.overseasSales, allowlist: ['other.mock.example'], maxBytes: COLLECTOR_FEED_MAX_BYTES }))).toBe('blocked:not_allowlisted');
    expect(await blocked(a.fetchFeed({ url: 'http://overseas-sales.mock.example/feed.xml', allowlist: ['overseas-sales.mock.example'], maxBytes: 10 }))).toBe('blocked:scheme');
    expect(await blocked(a.fetchFeed({ url: 'https://169.254.169.254/', allowlist: ['169.254.169.254'], maxBytes: 10 }))).toBe('blocked:ip_literal');
    expect(await blocked(a.fetchFeed({ url: MOCK_FEEDS.oversized, allowlist: ['huge.mock.example'], maxBytes: COLLECTOR_FEED_MAX_BYTES }))).toBe('too_large');
    expect(await blocked(a.fetchFeed({ url: 'https://overseas-sales.mock.example/none', allowlist: ['overseas-sales.mock.example'], maxBytes: 10 }))).toBe('not_found');
    expect(a.requested).toEqual([MOCK_FEEDS.oversized, 'https://overseas-sales.mock.example/none']);
  });

  it('모드: disabled·enabled(실제) → 어댑터 없음, mock → 모의 싱글턴', () => {
    expect(createCollectorAdapter(loadConfig({}))).toBeNull();
    expect(createCollectorAdapter(loadConfig({ COLLECTOR_MODE: 'enabled' }))).toBeNull();
    const m = createCollectorAdapter(loadConfig({ COLLECTOR_MODE: 'mock' }));
    expect(m?.mode).toBe('mock');
    expect(createCollectorAdapter(loadConfig({ COLLECTOR_MODE: 'mock' }))).toBe(m);
  });
});
