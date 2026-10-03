/**
 * FIX1-LIVET1(Codex review-LIVET1 P2 :37): setupFiles 네트워크 가드(tests/setup/no-meta-network.ts)가 막는 경로를 하나씩 확인한다.
 * 모든 시도는 연결·DNS 조회 **전에** 거부되어야 한다(실제 Meta 로 나가는 바이트 0). 허용 경로 확인은 127.0.0.1 로컬 서버만 쓴다.
 * 의도한 시도이므로 마지막에 기록을 비운다(비우지 않으면 setupFiles 의 afterAll 이 이 파일을 실패시킨다 — 그 동작 자체는 핸드오프의 임시 probe 로 확인).
 */
import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https, { request as httpsRequestNamed } from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Guard {
  attempts: string[];
  via: string[];
  original: typeof fetch;
}
const guard = () => (globalThis as typeof globalThis & { __csMetaNetworkGuard?: Guard }).__csMetaNetworkGuard!;
const BLOCKED = /BLOCKED_EXTERNAL_NETWORK/;

/** 동기 throw 또는 'error' 이벤트 — 둘 중 어느 쪽이든 가드 오류여야 한다 */
async function blockedSyncOrEvent(make: () => { on: (ev: 'error', cb: (e: Error) => void) => unknown; destroy?: () => void }): Promise<string> {
  let obj: ReturnType<typeof make>;
  try {
    obj = make();
  } catch (e) {
    return (e as Error).message;
  }
  return new Promise<string>((resolve) => {
    obj.on('error', (e) => resolve(e.message));
    setTimeout(() => resolve('no error within 2s'), 2000);
  }).finally(() => obj.destroy?.());
}

let server: http.Server;
let local: string;
beforeAll(async () => {
  // 로컬 서버: /redirect → Meta 주소로 302, 그 밖 → 200 ok
  server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://graph.threads.net/v1.0/me?access_token=FAKE_never_sent' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Meta 호스트 차단 — 경로별', () => {
  it('설치됨', () => {
    expect(guard()).toBeDefined();
    guard().attempts.length = 0;
    guard().via.length = 0;
  });

  it('fetch: 문자열·URL·Request, 대문자·끝의 점·하위 도메인도 정규화해 막는다', async () => {
    await expect(fetch('https://GRAPH.THREADS.NET./v1.0/me')).rejects.toThrow(BLOCKED);
    await expect(fetch(new URL('https://graph.threads.com/oauth/access_token'))).rejects.toThrow(BLOCKED);
    await expect(fetch(new Request('https://www.facebook.com/'))).rejects.toThrow(BLOCKED);
    await expect(fetch('https://scontent.xx.fbcdn.net/x')).rejects.toThrow(BLOCKED);
    await expect(fetch('https://i.instagram.com/')).rejects.toThrow(BLOCKED);
    expect(guard().attempts.slice(-5)).toEqual(['graph.threads.net', 'graph.threads.com', 'www.facebook.com', 'scontent.xx.fbcdn.net', 'i.instagram.com']);
  });

  it('fetch 리다이렉트: 허용 주소(로컬) → Meta 로 302 는 다음 단계(undici dispatcher)에서 막힌다', async () => {
    const before = guard().attempts.length;
    const e = await fetch(`${local}/redirect`).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect(String((e as Error & { cause?: Error }).cause?.message ?? (e as Error).message)).toMatch(BLOCKED);
    expect(guard().attempts.slice(before)).toEqual(['graph.threads.net']);
    expect(guard().via.slice(before)).toEqual(['undici.dispatch']);
  });

  it('가드 설치 전 fetch 참조(original)로 직접 보내도 undici dispatcher 에서 막힌다', async () => {
    const e = (await guard()
      .original('https://graph.threads.net/refresh_access_token')
      .then(() => new Error('not blocked'))
      .catch((x: unknown) => x)) as Error & { cause?: Error };
    expect(String(e.cause?.message ?? e.message)).toMatch(BLOCKED);
    expect(guard().via.at(-1)).toBe('undici.dispatch');
  });

  it('허용 호스트(로컬)는 그대로 통과한다 — fetch·http.get', async () => {
    expect(await (await fetch(`${local}/ok`)).text()).toBe('ok');
    const body = await new Promise<string>((resolve, reject) => {
      http.get(`${local}/ok`, (res) => {
        let s = '';
        res.on('data', (c: Buffer) => (s += c.toString()));
        res.on('end', () => resolve(s));
      }).on('error', reject);
    });
    expect(body).toBe('ok');
  });

  it('node:http·node:https request·get(문자열·옵션 객체·ESM 이름 가져오기)', () => {
    expect(() => http.request('http://graph.threads.net/')).toThrow(BLOCKED);
    expect(() => http.get({ hostname: 'www.facebook.com', path: '/' })).toThrow(BLOCKED);
    expect(() => https.request({ host: 'graph.threads.com:443', path: '/oauth/access_token', method: 'POST' })).toThrow(BLOCKED);
    expect(() => https.get(new URL('https://graph.threads.net./me'))).toThrow(BLOCKED);
    expect(() => httpsRequestNamed('https://threads.com/oauth/authorize')).toThrow(BLOCKED);
    expect(guard().via.slice(-5)).toEqual(['http.request', 'http.get', 'https.request', 'https.get', 'https.request']);
  });

  it('http.ClientRequest 직접 생성·사용자 Agent 도 연결 단계(net)에서 막힌다', async () => {
    const msg = await blockedSyncOrEvent(() => new http.ClientRequest({ host: 'graph.threads.net', port: 80, path: '/', agent: new http.Agent() }));
    expect(msg).toMatch(BLOCKED);
    const msg2 = await blockedSyncOrEvent(() => new http.ClientRequest({ host: 'graph.threads.com', port: 443, path: '/', createConnection: (o) => tls.connect({ ...(o as tls.ConnectionOptions), servername: 'graph.threads.com' }) }));
    expect(msg2).toMatch(BLOCKED);
  });

  it('node:net·node:tls connect·createConnection·Socket.connect', async () => {
    expect(() => net.connect(443, 'graph.threads.net')).toThrow(BLOCKED);
    expect(() => net.createConnection({ host: 'GRAPH.THREADS.NET.', port: 443 })).toThrow(BLOCKED);
    expect(() => tls.connect({ host: 'graph.threads.com', port: 443 })).toThrow(BLOCKED);
    expect(() => tls.connect({ host: '127.0.0.1', port: 1, servername: 'graph.threads.net' })).toThrow(BLOCKED);
    const s = new net.Socket();
    expect(() => s.connect(443, 'edge-chat.facebook.com')).toThrow(BLOCKED);
    s.destroy();
    expect(guard().via.slice(-5)).toEqual(['net.connect', 'net.createConnection', 'tls.connect', 'tls.connect', 'net.Socket.connect']);
  });

  it('node:dns lookup·resolve·promises', async () => {
    expect(() => dns.lookup('graph.threads.net', () => undefined)).toThrow(BLOCKED);
    expect(() => dns.resolve4('graph.threads.com', () => undefined)).toThrow(BLOCKED);
    expect(() => dns.resolve('www.instagram.com', () => undefined)).toThrow(BLOCKED);
    await expect(dns.promises.lookup('graph.threads.net.')).rejects.toThrow(BLOCKED);
    await expect(dns.promises.resolve6('threads.net')).rejects.toThrow(BLOCKED);
    expect(guard().via.slice(-5)).toEqual(['dns.lookup', 'dns.resolve4', 'dns.resolve', 'dns.promises.lookup', 'dns.promises.resolve6']);
  });

  // FIX2-LIVET1(Codex review-FIX-LIVET1 P2 :169): Resolver 인스턴스 메서드는 모듈 함수와 별개 — 프로토타입까지 감쌌는지.
  // 막히지 않아도 질의가 밖으로 나가지 않게 서버를 닫힌 로컬 포트(127.0.0.1:9)로 둔다.
  it('node:dns Resolver 인스턴스(콜백·promises, 하위 클래스)와 resolveTxt·resolveMx 등 나머지 조회 함수', async () => {
    const r = new dns.Resolver({ timeout: 50, tries: 1 });
    r.setServers(['127.0.0.1:9']);
    expect(() => r.resolve4('graph.threads.net', () => undefined)).toThrow(BLOCKED);
    expect(() => r.resolveTxt('GRAPH.THREADS.COM.', () => undefined)).toThrow(BLOCKED);
    expect(() => r.resolve('www.facebook.com', 'A', () => undefined)).toThrow(BLOCKED);
    const pr = new dns.promises.Resolver({ timeout: 50, tries: 1 });
    pr.setServers(['127.0.0.1:9']);
    await expect(pr.resolve4('graph.threads.net')).rejects.toThrow(BLOCKED);
    await expect(pr.resolveTxt('threads.net')).rejects.toThrow(BLOCKED);
    await expect(pr.resolveAny('i.instagram.com')).rejects.toThrow(BLOCKED);
    class SubResolver extends dns.promises.Resolver {}
    const sub = new SubResolver({ timeout: 50, tries: 1 });
    sub.setServers(['127.0.0.1:9']);
    await expect(sub.resolveSrv('_x._tcp.graph.threads.net')).rejects.toThrow(BLOCKED);
    expect(() => dns.resolveTxt('graph.threads.net', () => undefined)).toThrow(BLOCKED);
    expect(() => dns.resolveMx('facebook.com', () => undefined)).toThrow(BLOCKED);
    await expect(dns.promises.resolveNs('threads.com')).rejects.toThrow(BLOCKED);
    expect(guard().via.slice(-10)).toEqual([
      'dns.Resolver.resolve4',
      'dns.Resolver.resolveTxt',
      'dns.Resolver.resolve',
      'dns.promises.Resolver.resolve4',
      'dns.promises.Resolver.resolveTxt',
      'dns.promises.Resolver.resolveAny',
      'dns.promises.Resolver.resolveSrv',
      'dns.resolveTxt',
      'dns.resolveMx',
      'dns.promises.resolveNs',
    ]);
  });

  it('Resolver 인스턴스: 허용 이름(.invalid)은 가드를 지나 원래 조회 함수로 간다(닫힌 로컬 서버 → 연결 거부, 기록 없음)', async () => {
    const before = guard().attempts.length;
    const pr = new dns.promises.Resolver({ timeout: 50, tries: 1 });
    pr.setServers(['127.0.0.1:9']);
    const msg = await pr.resolve4('allowed.guard-test.invalid').then(() => 'resolved', (e: Error) => e.message);
    expect(msg).not.toMatch(BLOCKED);
    expect(guard().attempts.length).toBe(before);
  });

  it('node:http2 connect 는 tls 연결 단계에서 막힌다(별도 http2 패치 불필요)', async () => {
    const msg = await blockedSyncOrEvent(() => http2.connect('https://graph.threads.net'));
    expect(msg).toMatch(BLOCKED);
    expect(guard().via.at(-1)).toBe('tls.connect');
  });

  it('비슷하지만 다른 호스트(notthreads.net 류)는 막지 않는다 — 판정만(실제 요청 없음)', () => {
    const before = guard().attempts.length;
    // 판정은 연결 전이므로 로컬 주소로 보내되 servername 만 비슷한 이름으로: 막히면 안 된다
    const sock = tls.connect({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, servername: 'notthreads.net.example' });
    sock.on('error', () => undefined);
    sock.destroy();
    expect(guard().attempts.length).toBe(before);
  });

  it('기록을 비운다(의도한 시도)', () => {
    expect(guard().attempts.length).toBeGreaterThanOrEqual(35);
    guard().attempts.length = 0;
    guard().via.length = 0;
  });
});
