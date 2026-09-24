/**
 * URL 정규화와 SSRF 사전 검사(T03).
 *
 * - normalizeUrl: 저장·중복 판정용. canonical(가져올 때 쓰는 충실한 형태)과 normalized(중복 키)를 만든다.
 * - assertFetchableUrl: 추출(fetch) 전에 반드시 통과해야 하는 순수 검사(A05). DNS 조회를 하지 않는다.
 *   이 검사는 "주소 문자열만으로 명백히 내부인 것"을 거른다. 공개 호스트명이 내부 IP 로 풀리는 경우
 *   (DNS rebinding, 127.0.0.1.nip.io 같은 이름)와 redirect 대상은 실제 수집기(T19)가 fetch 시점에
 *   DNS 해석 결과 IP 와 매 redirect 의 Location 에 이 검사를 다시 적용해야 한다. 현재는 어떤 fetch 도 하지 않는다.
 */
import { InvalidUrlError, UrlNotAllowedError } from './errors';

export const MAX_URL_LENGTH = 2048;

/** 추적용 query 파라미터(소문자 비교). utm_* 는 접두어로 따로 검사한다. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'yclid', 'igshid', 'mc_cid', 'mc_eid']);

function isTrackingParam(rawKey: string): boolean {
  let key: string;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    key = rawKey.toLowerCase();
  }
  return key.startsWith('utm_') || TRACKING_PARAMS.has(key);
}

function paramKey(pair: string): string {
  const i = pair.indexOf('=');
  return i === -1 ? pair : pair.slice(0, i);
}

/** query 문자열을 원래 인코딩 그대로 유지하면서 추적 파라미터만 뺀다. */
function stripTracking(search: string): string[] {
  if (!search || search === '?') return [];
  return search
    .slice(1)
    .split('&')
    .filter((p) => p !== '' && !isTrackingParam(paramKey(p)));
}

function parseHttpUrl(input: string): URL {
  const trimmed = input.trim();
  if (trimmed === '' || trimmed.length > MAX_URL_LENGTH) throw new InvalidUrlError();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new InvalidUrlError();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new InvalidUrlError();
  if (!u.hostname) throw new InvalidUrlError();
  return u;
}

export interface NormalizedUrl {
  /** 가져올 때 쓰는 URL: fragment·추적 파라미터 제거, 나머지 순서·경로는 원래대로. */
  canonical: string;
  /** 중복 판정 키: canonical + query 정렬 + (루트가 아닌) 경로 끝 `/` 제거 + 호스트 끝 `.` 제거. */
  normalized: string;
}

/**
 * http/https 만 허용. WHATWG URL 파서가 scheme·host 소문자화, 기본 포트 제거, IDN → punycode,
 * 숫자형 IPv4(2130706433, 0x7f000001 등) → 점 표기 변환을 해 준다.
 * 사용자 정보(user:pass@)가 들어 있는 URL 은 비밀이 저장될 수 있으므로 거부한다.
 */
export function normalizeUrl(input: string): NormalizedUrl {
  const u = parseHttpUrl(input);
  if (u.username || u.password) {
    throw new InvalidUrlError('사용자 이름·비밀번호가 포함된 URL 은 저장할 수 없습니다');
  }
  u.hash = '';
  const kept = stripTracking(u.search);
  u.search = kept.length ? `?${kept.join('&')}` : '';
  const canonical = u.href;

  const n = new URL(canonical);
  const host = n.hostname.replace(/\.+$/, '');
  if (host && host !== n.hostname) n.hostname = host;
  // 같은 키끼리는 원래 순서를 유지하는 안정 정렬
  const sorted = kept
    .map((p, i) => ({ p, i, k: paramKey(p) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i))
    .map((x) => x.p);
  n.search = sorted.length ? `?${sorted.join('&')}` : '';
  if (n.pathname !== '/' && n.pathname.endsWith('/')) {
    n.pathname = n.pathname.replace(/\/+$/, '') || '/';
  }
  return { canonical, normalized: n.href };
}

// ---- SSRF 사전 검사 ----

/**
 * inet_aton 방식의 느슨한 IPv4 해석(1~4 부분, 10진·8진(0 접두)·16진(0x) 허용).
 * IPv4 로 볼 수 없으면 null. WHATWG 파서가 이미 점 표기로 바꾸지만, 방어적으로 한 번 더 해석한다.
 */
export function parseIPv4Loose(host: string): number | null {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = Number(p);
    else return null;
    if (!Number.isSafeInteger(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  if (nums.some((n) => n > 255)) return null;
  const lastMax = 2 ** (8 * (4 - nums.length)) - 1;
  if (last > lastMax) return null;
  let value = 0;
  nums.forEach((n, i) => {
    value += n * 2 ** (8 * (3 - i));
  });
  return value + last;
}

const ip4 = (a: number, b: number, c: number, d: number) => ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;

/** [시작 주소, prefix 길이] — 내부·예약·특수 목적 대역 */
const BLOCKED_V4: Array<[number, number]> = [
  [ip4(0, 0, 0, 0), 8], // "this network", 0.0.0.0
  [ip4(10, 0, 0, 0), 8], // 사설
  [ip4(100, 64, 0, 0), 10], // CGNAT
  [ip4(127, 0, 0, 0), 8], // loopback
  [ip4(169, 254, 0, 0), 16], // link-local, 169.254.169.254 메타데이터 포함
  [ip4(172, 16, 0, 0), 12], // 사설
  [ip4(192, 0, 0, 0), 24], // IETF 프로토콜 할당
  [ip4(192, 0, 2, 0), 24], // 문서용
  [ip4(192, 88, 99, 0), 24], // 6to4 relay
  [ip4(192, 168, 0, 0), 16], // 사설
  [ip4(198, 18, 0, 0), 15], // 벤치마크
  [ip4(198, 51, 100, 0), 24], // 문서용
  [ip4(203, 0, 113, 0), 24], // 문서용
  [ip4(224, 0, 0, 0), 4], // multicast
  [ip4(240, 0, 0, 0), 4], // 예약 + 255.255.255.255
];

export function isBlockedIPv4(addr: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((addr & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/** IPv6 문자열(대괄호 제외) → 16비트 8개. 해석 불가면 null. 끝부분의 점 표기 IPv4 를 허용한다. */
export function parseIPv6(s: string): number[] | null {
  if (s.includes('%')) return null; // zone id 는 허용하지 않는다
  let tail: number[] = [];
  let body = s;
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = s.slice(lastColon + 1);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return null;
    const o = v4.split('.').map(Number);
    if (o.some((x) => x > 255)) return null;
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    // "…::a.b.c.d" 는 "…::" 를, "…:x:a.b.c.d" 는 "…:x" 를 남긴다
    body = s.slice(0, lastColon + 1);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const want = 8 - tail.length;
  const halves = body.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (x: string): number[] | null => {
    if (x === '') return [];
    const gs = x.split(':');
    const out: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) {
    if (head.length !== want) return null;
    return [...head, ...tail];
  }
  const rest = parseGroups(halves[1]!);
  if (!rest) return null;
  const fill = want - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest, ...tail];
}

export function isBlockedIPv6(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const embedded = ((g6 << 16) >>> 0) + g7;
  const zero = (...xs: number[]) => xs.every((x) => x === 0);
  if (zero(g0, g1, g2, g3, g4, g5, g6) && (g7 === 0 || g7 === 1)) return true; // ::, ::1
  if (zero(g0, g1, g2, g3, g4) && g5 === 0xffff) return isBlockedIPv4(embedded); // ::ffff:a.b.c.d
  if (zero(g0, g1, g2, g3, g4, g5)) return true; // IPv4-compatible(폐기된 형식)
  if (g0 === 0x64 && g1 === 0xff9b) return zero(g2, g3, g4, g5) ? isBlockedIPv4(embedded) : true; // NAT64
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local(폐기)
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7 (fd00::/8 포함, 클라우드 메타데이터 fd00:ec2::254)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 문서용
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo(내부 IPv4 터널)
  if (g0 === 0x2002) return isBlockedIPv4(((g1 << 16) >>> 0) + g2); // 6to4
  if (g0 === 0x0100 && zero(g1, g2, g3)) return true; // discard
  return (g0 & 0xe000) !== 0x2000; // 전역 unicast(2000::/3) 밖은 모두 거부
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.arpa', '.lan'];

function isBlockedHostname(host: string): boolean {
  if (host === 'localhost') return true;
  // 점이 없는 이름(intranet, metadata 등)은 검색 도메인을 통해 내부로 풀릴 수 있어 거부한다.
  if (!host.includes('.')) return true;
  return BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * 추출 전 SSRF 검사(A05). 통과하면 파싱된 URL 을 돌려준다. 순수 함수이며 네트워크·DNS 를 쓰지 않는다.
 * 거부: http(s) 외 scheme, 사용자 정보 포함, localhost·*.localhost·*.local·*.internal(metadata.google.internal 포함)·
 * 점 없는 이름, loopback·사설·link-local·메타데이터(169.254.169.254, fd00::/8)·0.0.0.0·multicast·예약 IP
 * (10진·8진·16진 IPv4, 대괄호 IPv6, ::ffff: 매핑 포함).
 * 주의: fetch 시점(T19)에 DNS 해석 IP 와 redirect 마다 이 검사를 다시 해야 한다.
 */
export function assertFetchableUrl(input: string | URL): URL {
  let u: URL;
  try {
    u = new URL(typeof input === 'string' ? input.trim() : input.href);
  } catch {
    throw new UrlNotAllowedError();
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UrlNotAllowedError();
  if (u.username || u.password) throw new UrlNotAllowedError();
  const host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) throw new UrlNotAllowedError();

  if (host.startsWith('[')) {
    const groups = parseIPv6(host.slice(1, -1));
    if (!groups || isBlockedIPv6(groups)) throw new UrlNotAllowedError();
    return u;
  }
  const v4 = parseIPv4Loose(host);
  if (v4 !== null) {
    if (isBlockedIPv4(v4)) throw new UrlNotAllowedError();
    return u;
  }
  // 숫자와 점만으로 된 이름인데 IPv4 로 해석되지 않으면(범위 초과 등) 의심스러우므로 거부
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) throw new UrlNotAllowedError();
  if (isBlockedHostname(host)) throw new UrlNotAllowedError();
  return u;
}

/** 예외 대신 boolean 이 필요한 곳(UI 표시 등)용. */
export function isFetchableUrl(input: string): boolean {
  try {
    assertFetchableUrl(input);
    return true;
  } catch {
    return false;
  }
}
