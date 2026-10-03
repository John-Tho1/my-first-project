/**
 * LIVE-T1(D31 1단계 — 실제 호출 0): 모든 시험(unit·integration)의 setupFiles. Threads·Meta 호스트
 * (*.threads.com · *.threads.net · *.facebook.com · *.instagram.com · *.fbcdn.net — 대소문자·끝의 점 "graph.threads.net." 정규화)로 가는 요청을
 * **연결·DNS 조회 전에** 거부하고 시도를 기록한다. 파일이 끝날 때(afterAll) 거부된 시도가 하나라도 있으면 그 시험 파일을 실패시킨다.
 *
 * FIX1-LIVET1(Codex review-LIVET1 P2 :37) — 막는 경로(이 프로세스 안, 각각 시험으로 확인: packages/providers/src/no-meta-network.test.ts):
 *  1) globalThis.fetch 래퍼(첫 주소 — 문자열·URL·Request)
 *  2) undici 전역 dispatcher(Node 내장 fetch 가 쓰는 Symbol.for('undici.globalDispatcher.1')) — fetch 의 **리다이렉트 각 단계**도 여기를 지난다.
 *     (이 저장소에는 undici 패키지가 없다 — 설치되면 같은 전역 dispatcher 를 쓰므로 함께 막힌다)
 *  3) node:http·node:https 의 request·get
 *  4) node:net 의 connect·createConnection, node:tls 의 connect(호스트·servername), net.Socket.prototype.connect(모든 TCP·TLS 연결의 마지막 관문 —
 *     http.Agent·ClientRequest 직접 생성도 여기로 온다)
 *  5) node:dns 의 lookup 과 resolve* 전부(resolve·resolve4·resolve6·resolveAny·resolveCname·resolveTxt·resolveMx·resolveSrv·resolveNs … 이 Node 에 있는 것),
 *     dns.promises 의 같은 함수, 그리고 FIX2-LIVET1(Codex review-FIX-LIVET1 P2 :169) **new dns.Resolver()·new dns.promises.Resolver() 의 인스턴스
 *     메서드**(Resolver.prototype 의 resolve* — 하위 클래스 포함). reverse·lookupService 는 IP 를 받으므로 판별하지 않는다.
 *  CJS 내보내기를 바꾼 뒤 syncBuiltinESMExports() 로 ESM 이름 가져오기(import { request } from 'node:https')에도 반영한다.
 * 막지 못하는 것(남은 위험): 자식 프로세스·worker_threads(이 setup 이 돌지 않음), 시험 안에서 vi.stubGlobal('fetch', …)로 바꾼 fetch(fixture —
 * 실제 전송은 2)~4)가 여전히 막는다), 이미 해석한 IP 로의 직접 연결·dns.reverse/lookupService(호스트 이름이 없어 판별 불가), 네이티브 애드온·process.binding.
 * 오류 메시지·기록에는 호스트 이름과 경로 종류만 남긴다(질의 문자열의 시크릿·토큰 없음).
 */
import { afterAll } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);

const BLOCKED = /(^|\.)(threads\.com|threads\.net|facebook\.com|instagram\.com|fbcdn\.net)$/;
const DISPATCHER = Symbol.for('undici.globalDispatcher.1');

export interface GuardState {
  /** 거부한 호스트(정규화) — 시도 순서대로 */
  attempts: string[];
  /** 거부한 경로 종류(attempts 와 같은 순서) — fetch · dispatcher · http.request … */
  via: string[];
  original: typeof fetch;
  /** 설치한 dispatcher 감싸개(afterAll 에서 그대로인지 확인) */
  dispatcher: unknown;
  /** FIX2-LIVET1: Resolver.prototype(콜백·promises)까지 감쌌는지 */
  dnsResolverGuarded?: boolean;
}

const g = globalThis as typeof globalThis & { __csMetaNetworkGuard?: GuardState };

/** 호스트 정규화: 소문자, [IPv6] 괄호 제거, 끝의 점 제거 */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

export function isBlockedHost(host: unknown): string | null {
  if (typeof host !== 'string' || !host) return null;
  const h = normalizeHost(host);
  return BLOCKED.test(h) ? h : null;
}

/** fetch 입력·URL·Request·http 옵션 객체({ hostname | host }) → 막을 호스트 또는 null */
export function blockedMetaHost(input: unknown): string | null {
  if (typeof input === 'string') {
    try {
      return isBlockedHost(new URL(input).hostname);
    } catch {
      return null;
    }
  }
  if (input instanceof URL) return isBlockedHost(input.hostname);
  if (input && typeof input === 'object') {
    const o = input as { url?: unknown; hostname?: unknown; host?: unknown; servername?: unknown };
    if (typeof o.url === 'string') return blockedMetaHost(o.url);
    return isBlockedHost(o.hostname) ?? isBlockedHost(typeof o.host === 'string' ? o.host.replace(/:\d+$/, '') : null) ?? isBlockedHost(o.servername);
  }
  return null;
}

function blockedError(host: string, via: string): Error {
  return new Error(`BLOCKED_EXTERNAL_NETWORK: 시험에서 실제 ${host} 요청 금지(${via} — LIVE-T1/D31, fixture fetch 를 주입하세요)`);
}

if (!g.__csMetaNetworkGuard) {
  const original = globalThis.fetch;
  const state: GuardState = { attempts: [], via: [], original, dispatcher: null };
  g.__csMetaNetworkGuard = state;
  const refuse = (host: string, via: string): Error => {
    state.attempts.push(host);
    state.via.push(via);
    return blockedError(host, via);
  };

  // 1) fetch 래퍼
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const host = blockedMetaHost(input);
    if (host) return Promise.reject(refuse(host, 'fetch'));
    return original(input, init);
  }) as typeof fetch;

  // 2) undici 전역 dispatcher — Node 는 첫 fetch 때 만든다(data: 주소는 네트워크 없이 처리되지만 dispatcher 는 만들어진다)
  await (await original('data:,guard')).text();
  const inner = (globalThis as Record<symbol, unknown>)[DISPATCHER] as { dispatch: (opts: { origin?: unknown }, handler: unknown) => unknown } | undefined;
  if (!inner || typeof inner.dispatch !== 'function') throw new Error('no-meta-network: undici 전역 dispatcher 를 찾지 못했습니다(가드 설치 실패)');
  const wrapped = new Proxy(inner, {
    get(target, key) {
      if (key === 'dispatch') {
        return (opts: { origin?: unknown }, handler: unknown) => {
          let host: string | null;
          try {
            host = isBlockedHost(new URL(String(opts.origin)).hostname);
          } catch {
            host = null;
          }
          if (host) throw refuse(host, 'undici.dispatch');
          return target.dispatch(opts, handler);
        };
      }
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  (globalThis as Record<symbol, unknown>)[DISPATCHER] = wrapped;
  state.dispatcher = wrapped;

  // 3) http·https request·get
  const http = require('node:http') as typeof import('node:http');
  const https = require('node:https') as typeof import('node:https');
  const hostOfRequestArgs = (args: unknown[]): string | null => {
    const [a, b] = args;
    if (b && typeof b === 'object' && typeof b !== 'function') {
      const fromOpts = blockedMetaHost(b);
      if (fromOpts) return fromOpts;
    }
    return blockedMetaHost(a);
  };
  for (const [name, mod] of [['http', http], ['https', https]] as const) {
    for (const fn of ['request', 'get'] as const) {
      const orig = mod[fn] as (...a: unknown[]) => unknown;
      (mod as unknown as Record<string, unknown>)[fn] = function guardedRequest(this: unknown, ...args: unknown[]) {
        const host = hostOfRequestArgs(args);
        if (host) throw refuse(host, `${name}.${fn}`);
        return orig.apply(this, args);
      };
    }
  }

  // 4) net·tls
  const net = require('node:net') as typeof import('node:net');
  const tls = require('node:tls') as typeof import('node:tls');
  const hostOfConnectArgs = (args: unknown[]): string | null => {
    let [a] = args;
    // net.connect 는 정규화한 인자 배열([options, cb])을 socket.connect 에 넘긴다
    if (Array.isArray(a)) a = a[0];
    if (a && typeof a === 'object') return blockedMetaHost(a);
    if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return isBlockedHost(args[1]);
    return null;
  };
  for (const [name, mod, fns] of [
    ['net', net, ['connect', 'createConnection']],
    ['tls', tls, ['connect']],
  ] as const) {
    for (const fn of fns) {
      const orig = (mod as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]!;
      (mod as unknown as Record<string, unknown>)[fn] = function guardedConnect(this: unknown, ...args: unknown[]) {
        const host = hostOfConnectArgs(args);
        if (host) throw refuse(host, `${name}.${fn}`);
        return orig.apply(this, args);
      };
    }
  }
  const socketConnect = net.Socket.prototype.connect as (...a: unknown[]) => unknown;
  net.Socket.prototype.connect = function guardedSocketConnect(this: unknown, ...args: unknown[]) {
    const host = hostOfConnectArgs(args);
    if (host) throw refuse(host, 'net.Socket.connect');
    return socketConnect.apply(this, args);
  } as typeof net.Socket.prototype.connect;

  // 5) dns — FIX2-LIVET1(Codex review-FIX-LIVET1 P2 :169): 모듈 함수(콜백·promises)는 기본 Resolver 에 묶인 사본이라
  // Resolver.prototype 을 바꿔도 반영되지 않는다 → 둘 다 바꾼다. 이름 목록을 고정하지 않고 lookup + resolve* 전부(resolveTxt·resolveMx·resolveSrv·
  // resolveNs·resolveSoa·resolveCaa·resolveNaptr·resolvePtr·resolveTlsa 등, 이 Node 에 있는 것)를 감싼다.
  // reverse·lookupService 는 IP 를 받는다(호스트 이름이 없어 판별 불가 — 남은 위험, IP 직접 연결과 같은 부류).
  const dns = require('node:dns') as typeof import('node:dns');
  const isDnsName = (k: string) => k === 'lookup' || /^resolve/.test(k);
  const wrapCallbackDns = (target: Record<string, unknown>, fn: string, via: string) => {
    const orig = target[fn] as (...a: unknown[]) => unknown;
    target[fn] = function guardedDns(this: unknown, ...args: unknown[]) {
      const host = isBlockedHost(args[0]);
      if (host) throw refuse(host, via);
      return orig.apply(this, args);
    };
  };
  const wrapPromiseDns = (target: Record<string, unknown>, fn: string, via: string) => {
    const orig = target[fn] as (...a: unknown[]) => Promise<unknown>;
    target[fn] = function guardedDnsPromise(this: unknown, ...args: unknown[]) {
      const host = isBlockedHost(args[0]);
      if (host) return Promise.reject(refuse(host, via));
      return orig.apply(this, args);
    };
  };
  const dnsMod = dns as unknown as Record<string, unknown>;
  const dnsPromises = dns.promises as unknown as Record<string, unknown>;
  for (const fn of Object.keys(dnsMod)) if (isDnsName(fn) && typeof dnsMod[fn] === 'function') wrapCallbackDns(dnsMod, fn, `dns.${fn}`);
  for (const fn of Object.keys(dnsPromises)) if (isDnsName(fn) && typeof dnsPromises[fn] === 'function') wrapPromiseDns(dnsPromises, fn, `dns.promises.${fn}`);
  // new dns.Resolver() · new dns.promises.Resolver() 의 인스턴스 메서드(하위 클래스 포함 — 프로토타입 사슬)
  for (const [proto, wrap, via] of [
    [dns.Resolver.prototype, wrapCallbackDns, 'dns.Resolver'],
    [dns.promises.Resolver.prototype, wrapPromiseDns, 'dns.promises.Resolver'],
  ] as const) {
    const p = proto as unknown as Record<string, unknown>;
    for (const fn of Object.getOwnPropertyNames(p)) {
      if (!/^resolve/.test(fn)) continue;
      const d = Object.getOwnPropertyDescriptor(p, fn);
      if (d && typeof d.value === 'function') wrap(p, fn, `${via}.${fn}`);
    }
  }
  state.dnsResolverGuarded = true;
  syncBuiltinESMExports();
}

afterAll(() => {
  const state = g.__csMetaNetworkGuard!;
  const attempts = state.attempts.splice(0);
  const via = state.via.splice(0);
  if ((globalThis as Record<symbol, unknown>)[DISPATCHER] !== state.dispatcher) {
    throw new Error('BLOCKED_EXTERNAL_NETWORK: undici 전역 dispatcher 가 가드 밖으로 바뀌었습니다(setGlobalDispatcher) — 가드를 다시 확인하세요');
  }
  if (attempts.length) {
    throw new Error(
      `BLOCKED_EXTERNAL_NETWORK: 이 시험 파일이 실제 Threads·Meta 호스트로 ${attempts.length}번 요청하려 했습니다(${[...new Set(attempts)].join(', ')} / ${[...new Set(via)].join(', ')})`,
    );
  }
});
