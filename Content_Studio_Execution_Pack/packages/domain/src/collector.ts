/**
 * T19(제안 결정 D33) 허용 소스 수집 — 순수 함수(네트워크·DNS·DB 없음).
 *
 * 1) URL 정책(A05): 앞으로의 실제 수집기(live fetcher)가 **요청 전·DNS 해석 뒤·redirect 마다** 다시 적용할 검사.
 *    https 만, 사용자 정보·기본 아닌 포트 거부, IP 리터럴(10진·8진·16진 IPv4, IPv6 포함) 전부 거부, localhost·*.local·*.internal·점 없는 이름·
 *    와일드카드 DNS(nip.io 등) 거부, 허용 목록(owner 가 등록한 소스의 호스트)과 정확히 일치해야 통과. 해석된 주소는 사설·link-local·메타데이터 대역이면 거부.
 *    이 작업에는 실제 수집기가 없다 — 모의 수집기(@cs/providers)가 같은 검사를 거쳐 고정 자료만 돌려준다.
 * 2) RSS/Atom 파서: 크기 상한(1MiB), DTD·ENTITY 선언 거부(엔티티 확장 없음 — 기본 5개와 숫자 참조만 해석), 깊이·노드 상한,
 *    한 번 앞으로만 훑는 선형 토크나이저(`stats.steps` 는 입력 길이의 상수 배 이하 — 시험이 확인).
 * 3) 중복 판정: 외부 키(guid 또는 정규화 링크) + 내용 checksum. 이전에 **받아들인** 수집 항목, 기존 소재의 URL, 같은 피드 안 반복을 본다.
 * 수집한 글 속 지시문("이 글을 즉시 발행하라" 등)은 자료일 뿐이다(A04) — 이 모듈은 텍스트를 해석해 어떤 동작도 하지 않는다.
 */
import { createHash } from 'node:crypto';
import { contentHash } from './capture';
import type { AppConfig } from './config';
import { AppError } from './errors';
import { htmlToText } from './imports';
import { isBlockedHostname, isBlockedIPv4, isBlockedIPv6, MAX_URL_LENGTH, normalizeUrl, parseIPv4Loose, parseIPv6, isFetchableUrl } from './url';

export const COLLECTOR_SOURCE_KINDS = ['rss', 'atom', 'url'] as const;
export type CollectorSourceKind = (typeof COLLECTOR_SOURCE_KINDS)[number];
export const COLLECTOR_SCHEDULES = ['off', 'daily', 'weekly'] as const;
export type CollectorSchedule = (typeof COLLECTOR_SCHEDULES)[number];
export const COLLECTOR_RUN_TRIGGERS = ['manual', 'scheduled'] as const;
export type CollectorRunTrigger = (typeof COLLECTOR_RUN_TRIGGERS)[number];
export const COLLECTOR_RUN_STATUSES = ['preview', 'accepted', 'discarded', 'failed', 'blocked'] as const;
export type CollectorRunStatus = (typeof COLLECTOR_RUN_STATUSES)[number];
export const COLLECTED_DECISIONS = ['new', 'duplicate', 'skipped'] as const;
export type CollectedDecision = (typeof COLLECTED_DECISIONS)[number];
export const COLLECTED_REASONS = [
  // new
  'new',
  'updated',
  // duplicate
  'same_item',
  'existing_capture',
  'in_feed',
  // skipped
  'no_id',
  'blocked_link',
  'empty',
  'too_long',
  'limit',
] as const;
export type CollectedReason = (typeof COLLECTED_REASONS)[number];
export const COLLECTED_OUTCOMES = ['accepted', 'not_selected', 'skipped_duplicate', 'failed_changed'] as const;
export type CollectedOutcome = (typeof COLLECTED_OUTCOMES)[number];

/** 피드·페이지 응답 상한(바이트). 넘으면 읽지 않고 실패(feed_too_large). */
export const COLLECTOR_FEED_MAX_BYTES = 1024 * 1024;
/** 한 실행에서 판정하는 항목 수 상한(넘는 항목은 skipped/limit). */
export const COLLECTOR_MAX_ITEMS = 100;
export const COLLECTOR_MAX_DEPTH = 32;
export const COLLECTOR_MAX_NODES = 50_000;
export const COLLECTOR_MAX_REDIRECTS = 3;
/** 소재 원문 상한(T18 과 같은 20,000자). 넘는 항목은 skipped/too_long. */
export const COLLECTOR_ITEM_MAX_TEXT = 20_000;
/** 미리보기에 보이는 발췌(원장에 남김). */
export const COLLECTOR_EXCERPT_CHARS = 200;
/** 앞으로의 실제 수집기가 지켜야 할 요청 조건(이 작업에서는 쓰지 않는다 — 문서화된 계약). */
export const COLLECTOR_FETCH_LIMITS = {
  maxBytes: COLLECTOR_FEED_MAX_BYTES,
  timeoutMs: 10_000,
  maxRedirects: COLLECTOR_MAX_REDIRECTS,
  contentTypes: ['application/rss+xml', 'application/atom+xml', 'application/xml', 'text/xml', 'text/html'],
} as const;

// ---- URL 정책(A05) ----

export type CollectorUrlBlockReason =
  | 'invalid'
  | 'too_long'
  | 'scheme'
  | 'credentials'
  | 'port'
  | 'ip_literal'
  | 'blocked_host'
  | 'not_allowlisted'
  | 'private_address'
  | 'redirect_invalid'
  | 'too_many_redirects';

export type CollectorUrlCheck = { ok: true; url: URL; host: string } | { ok: false; reason: CollectorUrlBlockReason };

/** 와일드카드 DNS(어떤 IP 든 이름으로 만들어 줌) — 이름만 보고 막는다(실제 방어는 해석 IP 검사). */
const WILDCARD_DNS_SUFFIXES = ['nip.io', 'sslip.io', 'xip.io', 'localtest.me', 'lvh.me', 'traefik.me'];

/** 호스트 정규화: 소문자, 끝의 점 제거. */
export function normalizeCollectorHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/**
 * 수집 URL 정책. allowlist 가 주어지면 호스트가 그 목록과 정확히 같아야 한다(하위 도메인 자동 허용 없음).
 * 순수 함수 — DNS 를 보지 않는다. 해석된 IP 는 checkResolvedAddresses 로 따로 검사해야 한다.
 */
export function checkCollectorUrl(input: string, allowlist?: readonly string[] | null): CollectorUrlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: 'too_long' };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (u.username || u.password) return { ok: false, reason: 'credentials' };
  // WHATWG 파서는 https 기본 포트(443)를 '' 로 바꾼다. 그 밖의 포트는 내부 서비스 탐색에 쓰일 수 있어 거부.
  if (u.port !== '') return { ok: false, reason: 'port' };
  const host = normalizeCollectorHost(u.hostname);
  if (!host) return { ok: false, reason: 'invalid' };
  // IP 리터럴은 공개 주소라도 받지 않는다(허용 목록은 이름으로만). 10진·8진·16진 IPv4 는 WHATWG 가 점 표기로 바꾸지만 한 번 더 본다.
  if (host.startsWith('[') || host.includes(':')) return { ok: false, reason: 'ip_literal' };
  if (parseIPv4Loose(host) !== null || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return { ok: false, reason: 'ip_literal' };
  const lastLabel = host.slice(host.lastIndexOf('.') + 1);
  if (/^[0-9]+$/.test(lastLabel) || /^0x[0-9a-f]*$/i.test(lastLabel)) return { ok: false, reason: 'ip_literal' };
  if (isBlockedHostname(host)) return { ok: false, reason: 'blocked_host' };
  if (WILDCARD_DNS_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return { ok: false, reason: 'blocked_host' };
  if (allowlist) {
    const allowed = new Set(allowlist.map(normalizeCollectorHost));
    if (!allowed.has(host)) return { ok: false, reason: 'not_allowlisted' };
  }
  return { ok: true, url: u, host };
}

/**
 * DNS 해석 결과 검사(앞으로의 실제 수집기가 연결 직전에 호출 — DNS rebinding 대응: 검사한 주소로만 연결해야 한다).
 * 하나라도 사설·loopback·link-local·메타데이터(169.254.169.254, fd00::/8)·예약 대역이거나 해석할 수 없으면 거부. 빈 목록도 거부.
 */
export function checkResolvedAddresses(addresses: readonly string[]): { ok: true } | { ok: false; reason: 'private_address' } {
  if (!addresses.length) return { ok: false, reason: 'private_address' };
  for (const raw of addresses) {
    const a = raw.trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (a.includes(':')) {
      const g = parseIPv6(a);
      if (!g || isBlockedIPv6(g)) return { ok: false, reason: 'private_address' };
      continue;
    }
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(a)) return { ok: false, reason: 'private_address' };
    const v = parseIPv4Loose(a);
    if (v === null || isBlockedIPv4(v)) return { ok: false, reason: 'private_address' };
  }
  return { ok: true };
}

/**
 * redirect 재검사 훅: Location 을 현재 URL 기준으로 풀고 같은 정책·허용 목록을 다시 적용한다.
 * hop 은 지금까지 따라간 redirect 수(0부터). COLLECTOR_MAX_REDIRECTS 이상이면 거부.
 */
export function checkRedirect(fromUrl: string, location: string | null, allowlist: readonly string[], hop: number): CollectorUrlCheck {
  if (hop >= COLLECTOR_MAX_REDIRECTS) return { ok: false, reason: 'too_many_redirects' };
  if (!location || !location.trim()) return { ok: false, reason: 'redirect_invalid' };
  let target: URL;
  try {
    target = new URL(location.trim(), fromUrl);
  } catch {
    return { ok: false, reason: 'redirect_invalid' };
  }
  return checkCollectorUrl(target.href, allowlist);
}

export class CollectorUrlBlockedError extends AppError {
  readonly reason: CollectorUrlBlockReason;
  constructor(reason: CollectorUrlBlockReason) {
    super('bad_request', 'collector_url_blocked', `허용되지 않는 수집 주소입니다(${COLLECTOR_BLOCK_LABEL[reason]}). 아무 요청도 보내지 않았습니다.`, { reason });
    this.reason = reason;
  }
}

/** 수집기 응답 오류(모의 포함). run 에 error_code 로 남는다. */
export type CollectorFetchErrorCode = 'blocked' | 'not_found' | 'too_large' | 'failed';
export class CollectorFetchError extends Error {
  constructor(
    readonly code: CollectorFetchErrorCode,
    readonly reason: CollectorUrlBlockReason | null = null,
  ) {
    super(`collector_fetch_${code}`);
    this.name = 'CollectorFetchError';
  }
}

export interface CollectorFetchRequest {
  url: string;
  /** 허용 호스트(owner 가 등록한 소스들의 호스트). redirect 대상도 이 안이어야 한다. */
  allowlist: readonly string[];
  maxBytes: number;
}

export interface CollectorFetchResponse {
  finalUrl: string;
  /** 따라간 redirect 대상(순서대로) */
  redirects: string[];
  contentType: string;
  bytes: Uint8Array;
}

/**
 * 수집 어댑터. 이 작업에는 모의 구현만 있다(@cs/providers MockCollectorAdapter — 메모리 고정 자료, 네트워크 0).
 * 구현은 요청 전 checkCollectorUrl, redirect 마다 checkRedirect, (실제 구현이면) 연결 전 checkResolvedAddresses 를 반드시 적용한다.
 */
export interface CollectorAdapter {
  readonly mode: 'mock';
  fetchFeed(req: CollectorFetchRequest): Promise<CollectorFetchResponse>;
  fetchPage(req: CollectorFetchRequest): Promise<CollectorFetchResponse>;
}

// ---- 모드·준비 상태 ----

export interface CollectorReadiness {
  mode: 'disabled' | 'mock' | 'live';
  canRun: boolean;
  /** 빠진 전제 조건(값 없음, 한국어) */
  missing: string[];
  message: string;
}

/**
 * COLLECTOR_MODE: disabled(기본) → 실행 불가. mock → 모의 수집기만(고정 자료, 실제 웹 요청 없음).
 * enabled(실제 수집 요청 — T03 의 추출 경로와 같은 값) → 실제 수집기가 없고 승인 범위도 없어 항상 준비 안 됨(요청 0).
 */
export function collectorReadiness(config: Pick<AppConfig, 'COLLECTOR_MODE'>): CollectorReadiness {
  if (config.COLLECTOR_MODE === 'mock') {
    return { mode: 'mock', canRun: true, missing: [], message: '모의 수집기 — 고정된 합성 자료만 읽습니다. 실제 웹 요청은 보내지 않습니다.' };
  }
  if (config.COLLECTOR_MODE === 'enabled') {
    return {
      mode: 'live',
      canRun: false,
      missing: ['실제 수집기(live fetcher) 미구현', '실제 수집 승인 범위(D33 — 허용 소스·주기·요청 상한)'],
      message: '실제 수집은 준비되지 않았습니다. 아무 요청도 보내지 않습니다.',
    };
  }
  return { mode: 'disabled', canRun: false, missing: [], message: '수집이 꺼져 있습니다(기본). COLLECTOR_MODE=mock 으로 모의 수집을 시험할 수 있습니다.' };
}

export class CollectorNotReadyError extends AppError {
  constructor(r: CollectorReadiness) {
    super(
      'service_unavailable',
      r.mode === 'live' ? 'collector_live_not_ready' : 'collector_disabled',
      r.message,
      r.missing.length ? { missing: r.missing } : undefined,
    );
  }
}

export function assertCollectorRunnable(config: Pick<AppConfig, 'COLLECTOR_MODE'>): void {
  const r = collectorReadiness(config);
  if (!r.canRun) throw new CollectorNotReadyError(r);
}

/** 주기 실행 기한. off 는 null. */
export function scheduleIntervalMs(s: CollectorSchedule): number | null {
  if (s === 'daily') return 24 * 3600_000;
  if (s === 'weekly') return 7 * 24 * 3600_000;
  return null;
}

export function isScheduleDue(s: CollectorSchedule, lastRunAt: Date | null, now: Date): boolean {
  const ms = scheduleIntervalMs(s);
  if (ms === null) return false;
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= ms;
}

// ---- XML(RSS/Atom) 파서 ----

export type FeedParseCode = 'feed_malformed' | 'feed_dtd_not_allowed' | 'feed_too_large' | 'feed_not_feed' | 'feed_not_utf8';

export class FeedParseError extends AppError {
  constructor(readonly parseCode: FeedParseCode) {
    super('bad_request', parseCode, FEED_PARSE_LABEL[parseCode]);
  }
}

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** 원문에서 이 요소가 차지하는 구간 [start, end) — 원본 조각 보존용 */
  start: number;
  end: number;
}
export type XmlNode = XmlElement | string;

export interface XmlScanStats {
  /** 살펴본 글자 수(+ 상수). 입력 길이의 상수 배 이하여야 한다. */
  steps: number;
}

/**
 * 기본 엔티티 5개. Map 이라 Object.prototype 의 이름(`&toString;`·`&__proto__;`·`&constructor;`·`&valueOf;`)을 엔티티로 오인하지 않는다
 * (Codex review-T19 P2 — 예전 `name in {…}` 는 프로토타입 속성을 통과시켰다).
 */
const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** 기본 엔티티 5개와 숫자 문자 참조만 푼다. 그 밖(&nbsp; 등 선언이 필요한 이름)은 글자 그대로 둔다 — 확장 없음. 선형. */
export function decodeXmlEntities(s: string, st?: XmlScanStats): string {
  let amp = s.indexOf('&');
  if (amp < 0) {
    if (st) st.steps += s.length;
    return s;
  }
  let out = '';
  let pos = 0;
  while (amp >= 0) {
    out += s.slice(pos, amp);
    // 이름은 최대 10자까지만 본다(그 이상은 엔티티로 보지 않음). 앞으로 11글자 안에서만 ';' 를 찾는다 — 전체 재탐색 없음(선형).
    let semi = -1;
    for (let j = amp + 1; j < s.length && j <= amp + 11; j++) {
      if (s[j] === ';') {
        semi = j;
        break;
      }
    }
    if (semi < 0) {
      out += '&';
      pos = amp + 1;
    } else {
      const name = s.slice(amp + 1, semi);
      let rep: string | null = null;
      const predefined = PREDEFINED.get(name);
      if (predefined !== undefined) rep = predefined;
      else if (/^#[0-9]{1,7}$/.test(name) || /^#x[0-9a-fA-F]{1,6}$/.test(name)) {
        const cp = name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) rep = String.fromCodePoint(cp);
      }
      if (rep === null) {
        out += '&';
        pos = amp + 1;
      } else {
        out += rep;
        pos = semi + 1;
      }
    }
    amp = s.indexOf('&', pos);
  }
  out += s.slice(pos);
  if (st) st.steps += s.length + 1;
  return out;
}

const isNameStart = (c: string) => /[A-Za-z_:]/.test(c) || c.charCodeAt(0) >= 0x80;
const isNameChar = (c: string) => /[A-Za-z0-9_:.-]/.test(c) || c.charCodeAt(0) >= 0x80;
const isWs = (c: string | undefined) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

/**
 * 최소 XML 파서. 한 번 앞으로만 훑는다(각 indexOf 는 현재 위치부터, 찾은 곳까지 소비). DTD·ENTITY·그 밖의 `<!` 선언은 거부.
 * 처리 명령(<?…?>)·주석은 건너뛰고 CDATA 는 글자로. 루트 하나, 깊이 ≤ 32, 요소 ≤ 50,000. 잘못된 문서는 FeedParseError(feed_malformed).
 */
export function parseXml(xml: string, stats?: XmlScanStats): XmlElement {
  const st: XmlScanStats = { steps: 0 };
  try {
    return parseXmlScan(xml, st);
  } finally {
    // 거부(예외)된 입력도 그때까지 살펴본 단계 수를 남긴다(Codex review-T19 답 2 — 예전에는 정상 반환 때만 더했다).
    if (stats) stats.steps += st.steps;
  }
}

function parseXmlScan(xml: string, st: XmlScanStats): XmlElement {
  const n = xml.length;
  if (n > COLLECTOR_FEED_MAX_BYTES) throw new FeedParseError('feed_too_large');
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let nodes = 0;
  let i = 0;
  const bad = (): never => {
    throw new FeedParseError('feed_malformed');
  };
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const raw = xml.slice(i, textEnd);
      st.steps += raw.length;
      const top = stack[stack.length - 1];
      if (top) {
        if (raw.includes(']]>')) bad();
        top.children.push(decodeXmlEntities(raw, st));
      } else if (raw.trim() !== '') bad();
    }
    if (lt < 0) break;
    i = lt;
    st.steps++;
    if (xml.startsWith('<?', i)) {
      const e = xml.indexOf('?>', i + 2);
      if (e < 0) bad();
      st.steps += e + 2 - i;
      i = e + 2;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const e = xml.indexOf('-->', i + 4);
      if (e < 0) bad();
      st.steps += e + 3 - i;
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const e = xml.indexOf(']]>', i + 9);
      if (e < 0) bad();
      const top = stack[stack.length - 1];
      if (!top) bad();
      top!.children.push(xml.slice(i + 9, e));
      st.steps += e + 3 - i;
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<!', i)) {
      // <!DOCTYPE …>, <!ENTITY …>, <!ELEMENT …> 등 — 엔티티 확장·외부 참조(XXE)·billion laughs 를 원천 차단.
      throw new FeedParseError('feed_dtd_not_allowed');
    }
    if (xml.startsWith('</', i)) {
      let k = i + 2;
      const nameStart = k;
      while (k < n && isNameChar(xml[k]!)) k++;
      const name = xml.slice(nameStart, k);
      while (k < n && isWs(xml[k])) k++;
      st.steps += k - i + 1;
      if (xml[k] !== '>') bad();
      const top = stack.pop();
      if (!top || top.name !== name) bad();
      top!.end = k + 1;
      i = k + 1;
      continue;
    }
    // 시작 태그
    let k = i + 1;
    if (k >= n || !isNameStart(xml[k]!)) bad();
    const nameStart = k;
    while (k < n && isNameChar(xml[k]!)) k++;
    // 속성 사전은 프로토타입 없는 객체 — `toString`·`__proto__` 같은 속성 이름을 "이미 있음"으로 오판하지 않고, __proto__ 도 일반 키로 저장된다.
    const el: XmlElement = { name: xml.slice(nameStart, k), attrs: Object.create(null) as Record<string, string>, children: [], start: i, end: -1 };
    let selfClosing = false;
    for (;;) {
      while (k < n && isWs(xml[k])) k++;
      if (k >= n) bad();
      const c = xml[k]!;
      if (c === '>') {
        k++;
        break;
      }
      if (c === '/') {
        if (xml[k + 1] !== '>') bad();
        selfClosing = true;
        k += 2;
        break;
      }
      if (!isNameStart(c)) bad();
      const an = k;
      while (k < n && isNameChar(xml[k]!)) k++;
      const attrName = xml.slice(an, k);
      while (k < n && isWs(xml[k])) k++;
      if (xml[k] !== '=') bad();
      k++;
      while (k < n && isWs(xml[k])) k++;
      const q = xml[k];
      if (q !== '"' && q !== "'") bad();
      const close = xml.indexOf(q!, k + 1);
      if (close < 0) bad();
      const value = xml.slice(k + 1, close);
      if (value.includes('<')) bad();
      if (Object.hasOwn(el.attrs, attrName)) bad();
      el.attrs[attrName] = decodeXmlEntities(value, st);
      k = close + 1;
    }
    st.steps += k - i;
    nodes++;
    if (nodes > COLLECTOR_MAX_NODES) bad();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (root) bad();
    else root = el;
    if (selfClosing) el.end = k;
    else {
      stack.push(el);
      if (stack.length > COLLECTOR_MAX_DEPTH) bad();
    }
    i = k;
  }
  if (stack.length || !root) bad();
  return root!;
}

const localName = (name: string) => name.slice(name.indexOf(':') + 1);
const childElements = (el: XmlElement) => el.children.filter((c): c is XmlElement => typeof c !== 'string');
const child = (el: XmlElement, name: string) => childElements(el).find((c) => c.name === name) ?? null;
const childLocal = (el: XmlElement, name: string) => childElements(el).filter((c) => localName(c.name) === name);

/** 요소 아래 모든 글자(자손 포함). 반복문 — 재귀 깊이 문제 없음. 총 비용은 자손 수에 비례. */
export function xmlText(el: XmlElement): string {
  const out: string[] = [];
  const stack: XmlNode[] = [...el.children].reverse();
  while (stack.length) {
    const nd = stack.pop()!;
    if (typeof nd === 'string') out.push(nd);
    else for (let j = nd.children.length - 1; j >= 0; j--) stack.push(nd.children[j]!);
  }
  return out.join('');
}

export interface FeedItem {
  guid: string | null;
  link: string | null;
  title: string | null;
  /** 원문에 적힌 게시 시각 문자열(최대 100자) */
  publishedText: string | null;
  publishedAt: Date | null;
  /** 소재 원문으로 쓸 텍스트(HTML 은 추출 텍스트 — 파생 값). */
  text: string;
  /**
   * 원본 바이트(피드: 응답 바이트 중 <item>…</item>/<entry>…</entry> 구간, 페이지: 응답 바이트 전체 — BOM·CRLF 포함).
   * 받아들일 때 이 바이트를 그대로 보존한다(원본 sha256·크기·base64 모두 이 값). 디코딩·재인코딩한 문자열이 아니다(Codex review-T19 P0).
   */
  rawBytes: Uint8Array;
  rawFormat: 'txt' | 'html';
  /** 링크가 원문에서 상대 주소였는지(최종 URL 기준으로 풀었음 — 수집 쪽이 정책·허용 목록을 다시 적용한다). */
  linkRelative: boolean;
}

export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'page';
  title: string | null;
  items: FeedItem[];
}

/**
 * UTF-8(fatal) 디코딩. ignoreBOM: BOM 도 글자(U+FEFF)로 남겨 문자열 위치와 바이트 위치가 1:1 로 대응하게 한다(원본 구간을 바이트로 자를 때 필요).
 * 텍스트 추출에서는 호출 쪽이 BOM 을 따로 뺀다.
 */
function decodeUtf8(bytes: Uint8Array): string {
  if (bytes.byteLength > COLLECTOR_FEED_MAX_BYTES) throw new FeedParseError('feed_too_large');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FeedParseError('feed_not_utf8');
  }
}

/**
 * 문자열 구간 [start, end) 에 해당하는 원본 바이트를 잘라 준다(복사본). s 는 bytes 를 손실 없이(fatal, ignoreBOM) 디코딩한 값이어야 한다.
 * 구간은 앞에서 뒤로 차례로 요청된다고 가정하고 위치를 이어서 센다(전체 선형). 뒤로 돌아가면 처음부터 다시 센다.
 */
/**
 * Codex review-FIX-T19 P2 :560 — Buffer.prototype.slice 는 같은 메모리를 공유하는 view 를 돌려준다(Uint8Array.prototype.slice 는 복사).
 * 원본 바이트는 입력 버퍼와 분리돼야 하므로, 입력이 Buffer 여도 항상 새 메모리로 복사한다.
 */
export function copyBytes(bytes: Uint8Array, start = 0, end = bytes.byteLength): Uint8Array {
  return Uint8Array.prototype.slice.call(bytes, start, end) as Uint8Array;
}

function byteSlicer(s: string, bytes: Uint8Array) {
  let charPos = 0;
  let bytePos = 0;
  return (start: number, end: number): Uint8Array => {
    if (start < charPos) {
      charPos = 0;
      bytePos = 0;
    }
    bytePos += Buffer.byteLength(s.slice(charPos, start), 'utf8');
    charPos = start;
    const len = Buffer.byteLength(s.slice(start, end), 'utf8');
    return copyBytes(bytes, bytePos, bytePos + len);
  };
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

const clip = (s: string | null, max: number) => (s === null ? null : Array.from(s).slice(0, max).join(''));
const clean = (s: string | null | undefined) => {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t ? t : null;
};

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** 링크 해석. relative = 원문이 절대 URL 이 아니었음(`/x`, `//host/x`, `x` 등 — 기준 URL 로 풀었음). */
function resolveLink(href: string | null, base: string): { link: string | null; relative: boolean } {
  if (!href) return { link: null, relative: false };
  const h = href.trim();
  let relative = false;
  try {
    new URL(h);
  } catch {
    relative = true;
  }
  try {
    return { link: new URL(h, base).href, relative };
  } catch {
    return { link: null, relative: false };
  }
}

/** Atom 텍스트 구성(RFC 4287 §3.1): type 없음·'text' → 글자 그대로, 'html' → HTML 에서 텍스트, 'xhtml' → 원문 XHTML 조각에서 텍스트. */
function atomText(el: XmlElement, xml: string): string {
  const t = (el.attrs.type ?? 'text').trim().toLowerCase();
  if (t === 'xhtml') {
    // 안쪽 XHTML(보통 <div> 하나)만 넘긴다 — 바깥 <title>/<content> 태그가 HTML 의 title 등으로 해석되지 않게.
    const els = childElements(el);
    return els.length ? htmlText(xml.slice(els[0]!.start, els[els.length - 1]!.end)) : xmlText(el);
  }
  if (t === 'html' || t === 'text/html') return htmlText(xmlText(el));
  return xmlText(el);
}

const htmlText = (s: string) => {
  if (s.length > COLLECTOR_FEED_MAX_BYTES) throw new FeedParseError('feed_too_large');
  return htmlToText(s).text.trim();
};

/** RSS 2.0·RSS 1.0(rdf)·Atom 피드 → 항목 목록. baseUrl 은 상대 링크 해석용(최종 URL). */
export function parseFeed(bytes: Uint8Array, baseUrl: string, stats?: XmlScanStats): ParsedFeed {
  // BOM 을 글자로 남긴 채 해석한다(앞 공백으로 취급) — 요소 위치가 응답 바이트 위치와 바로 대응한다.
  const xml = decodeUtf8(bytes);
  const root = parseXml(xml, stats);
  const rootLocal = localName(root.name);
  const sliceBytes = byteSlicer(xml, bytes);
  if (root.name === 'rss' || rootLocal === 'RDF') {
    const channel = child(root, 'channel');
    const itemEls = root.name === 'rss' ? (channel ? childElements(channel).filter((c) => c.name === 'item') : []) : childLocal(root, 'item');
    const titleEl = channel ? child(channel, 'title') : null;
    const items = itemEls.map((it): FeedItem => {
      const get = (name: string) => {
        const e = child(it, name);
        return e ? xmlText(e) : null;
      };
      const body = get('content:encoded') ?? get('description') ?? '';
      const published = clean(get('pubDate') ?? get('dc:date'));
      const { link, relative } = resolveLink(clean(get('link')), baseUrl);
      return {
        guid: clean(get('guid')),
        link,
        title: clip(clean(get('title') !== null ? htmlText(get('title')!) : null), 200),
        publishedText: clip(published, 100),
        publishedAt: parseDate(published),
        text: htmlText(body),
        rawBytes: sliceBytes(it.start, it.end),
        rawFormat: 'txt',
        linkRelative: relative,
      };
    });
    return { kind: 'rss', title: clip(clean(titleEl ? xmlText(titleEl) : null), 200), items };
  }
  if (rootLocal === 'feed') {
    const entries = childLocal(root, 'entry');
    const items = entries.map((en): FeedItem => {
      const first = (name: string) => childLocal(en, name)[0] ?? null;
      const links = childLocal(en, 'link');
      const alt = links.find((l) => !l.attrs.rel || l.attrs.rel === 'alternate') ?? null;
      const contentEl = first('content') ?? first('summary');
      // Atom 기본 type 은 text(RFC 4287) — 예전에는 type 이 없으면 HTML 로 보았다(Codex review-T19 놓친 케이스).
      const body = contentEl ? atomText(contentEl, xml) : '';
      const titleEl = first('title');
      const published = clean(first('published') ? xmlText(first('published')!) : first('updated') ? xmlText(first('updated')!) : null);
      const idEl = first('id');
      const { link, relative } = resolveLink(alt?.attrs.href ?? null, baseUrl);
      return {
        guid: clean(idEl ? xmlText(idEl) : null),
        link,
        title: clip(clean(titleEl ? atomText(titleEl, xml) : null), 200),
        publishedText: clip(published, 100),
        publishedAt: parseDate(published),
        text: body.trim(),
        rawBytes: sliceBytes(en.start, en.end),
        rawFormat: 'txt',
        linkRelative: relative,
      };
    });
    const t = childLocal(root, 'title')[0];
    return { kind: 'atom', title: clip(clean(t ? xmlText(t) : null), 200), items };
  }
  throw new FeedParseError('feed_not_feed');
}

/**
 * 선택 URL(페이지 하나) → 항목 하나. 링크 = 그 URL(최종 URL 아님 — 등록한 주소가 외부 키).
 * 원본은 응답 바이트 전체 그대로(BOM·CRLF·charset 선언과 무관하게 바이트 보존). 텍스트는 별도로 UTF-8(fatal) 디코딩 + BOM 제거 뒤 추출한다 —
 * UTF-8 이 아닌 바이트(예: 실제 windows-1251 인코딩)는 텍스트를 만들 수 없어 feed_not_utf8 로 거부(저장 0).
 */
export function parsePage(bytes: Uint8Array, pageUrl: string): ParsedFeed {
  const html = stripBom(decodeUtf8(bytes));
  const { text, title } = htmlToText(html);
  return {
    kind: 'page',
    title: clip(clean(title), 200),
    items: [
      {
        guid: null,
        link: pageUrl,
        title: clip(clean(title), 200),
        publishedText: null,
        publishedAt: null,
        text: text.trim(),
        rawBytes: copyBytes(bytes),
        rawFormat: 'html',
        linkRelative: false,
      },
    ],
  };
}

// ---- 판정 ----

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

export interface CollectedCandidate {
  position: number;
  /** guid:<guid> 또는 link:<정규화 링크>(길면 h:<sha256>). 둘 다 없으면 null */
  externalKey: string | null;
  guid: string | null;
  link: string | null;
  linkNormalized: string | null;
  title: string | null;
  excerpt: string;
  publishedText: string | null;
  publishedAt: Date | null;
  /** 내용 checksum(제목 + 본문, 정규화) — 같은 키의 "고쳐진 글" 판정 */
  contentChecksum: string;
  /** 원본 바이트 sha256 = 출처 버전 raw_hash = source_version_originals.sha256 */
  rawSha256: string;
  byteSize: number;
  text: string;
  /** 원본 바이트 그대로(FeedItem.rawBytes) */
  rawBytes: Uint8Array;
  rawFormat: 'txt' | 'html';
  /** 링크가 원문에서 상대 주소였는지(수집 쪽이 정책·허용 목록 재검사) */
  linkRelative: boolean;
  blockedLink: boolean;
}

const keyOf = (prefix: string, v: string) => (v.length > 500 ? `h:${sha256Hex(`${prefix}:${v}`)}` : `${prefix}:${v}`);

export function toCandidate(item: FeedItem, position: number): CollectedCandidate {
  let linkNormalized: string | null = null;
  let link: string | null = item.link;
  let blockedLink = false;
  if (link) {
    try {
      linkNormalized = normalizeUrl(link).normalized;
      blockedLink = !isFetchableUrl(link);
    } catch {
      link = null;
    }
  }
  const externalKey = item.guid ? keyOf('guid', item.guid) : linkNormalized ? keyOf('link', linkNormalized) : null;
  const body = `${item.title ?? ''}\n${item.text}`;
  return {
    position,
    externalKey,
    guid: clip(item.guid, 500),
    link: link ? clip(link, 2048) : null,
    linkNormalized,
    title: item.title,
    excerpt: Array.from(item.text.replace(/\s+/g, ' ').trim()).slice(0, COLLECTOR_EXCERPT_CHARS).join(''),
    publishedText: item.publishedText,
    publishedAt: item.publishedAt,
    contentChecksum: contentHash(body),
    rawSha256: createHash('sha256').update(item.rawBytes).digest('hex'),
    byteSize: item.rawBytes.byteLength,
    text: item.text,
    rawBytes: item.rawBytes,
    rawFormat: item.rawFormat,
    linkRelative: item.linkRelative && link !== null,
    blockedLink,
  };
}

/**
 * 원문이 상대 주소였던 링크는 응답의 최종 URL(redirect 뒤) 기준으로 풀었다. 그 결과는 수집 주소와 같은 정책(https·IP 리터럴·내부 이름 거부)과
 * owner 허용 목록(호스트 정확 일치)을 다시 통과해야 한다 — 통과하지 못하면 blockedLink(판정 skipped/blocked_link, 받아들이기 failed_changed).
 * 절대 주소 링크는 예전대로 isFetchableUrl(내부 주소 거부)만 본다(다른 사이트 글을 가리키는 피드가 흔하다 — 링크는 조회하지 않고 출처 표시용).
 * (Codex review-T19 P1 :396)
 */
export function applyLinkPolicy(cands: readonly CollectedCandidate[], allowlist: readonly string[]): CollectedCandidate[] {
  return cands.map((c) => {
    if (!c.linkRelative || !c.link || c.blockedLink) return c;
    return checkCollectorUrl(c.link, allowlist).ok ? c : { ...c, blockedLink: true };
  });
}

export interface DedupeContext {
  /** 이 소스에서 이전에 받아들인 항목: 외부 키 → 내용 checksum 들 */
  accepted: ReadonlyMap<string, ReadonlySet<string>>;
  /** owner 의 기존 소재 URL(sources.normalized_url)과 받아들인 수집 항목 링크(정규화) */
  knownUrls: ReadonlySet<string>;
}

export interface CollectedDecisionResult {
  decision: CollectedDecision;
  reason: CollectedReason;
}

/** 소재 원문(받아들일 때 만드는 값): 제목 + 빈 줄 + 본문. 링크는 출처에 따로 남는다. */
export function collectedCaptureText(c: Pick<CollectedCandidate, 'title' | 'text'>): string {
  const t = c.title ? `${c.title}\n\n` : '';
  return `${t}${c.text}`.trim();
}

/** 순서대로 판정(같은 피드 안 반복은 첫 번째만 후보). 결정적. */
export function decideCollected(cands: readonly CollectedCandidate[], ctx: DedupeContext): CollectedDecisionResult[] {
  const seen = new Set<string>();
  return cands.map((c, idx): CollectedDecisionResult => {
    if (idx >= COLLECTOR_MAX_ITEMS) return { decision: 'skipped', reason: 'limit' };
    if (!c.externalKey) return { decision: 'skipped', reason: 'no_id' };
    if (seen.has(c.externalKey)) return { decision: 'duplicate', reason: 'in_feed' };
    seen.add(c.externalKey);
    if (c.blockedLink) return { decision: 'skipped', reason: 'blocked_link' };
    const capText = collectedCaptureText(c);
    if (!capText) return { decision: 'skipped', reason: 'empty' };
    if (capText.length > COLLECTOR_ITEM_MAX_TEXT) return { decision: 'skipped', reason: 'too_long' };
    const prev = ctx.accepted.get(c.externalKey);
    if (prev && prev.has(c.contentChecksum)) return { decision: 'duplicate', reason: 'same_item' };
    if (!prev && c.linkNormalized && ctx.knownUrls.has(c.linkNormalized)) return { decision: 'duplicate', reason: 'existing_capture' };
    if (prev) return { decision: 'new', reason: 'updated' };
    return { decision: 'new', reason: 'new' };
  });
}

// ---- 화면 문구 ----

export const COLLECTOR_KIND_LABEL: Record<CollectorSourceKind, string> = { rss: 'RSS', atom: 'Atom', url: '선택 URL(페이지)' };
export const COLLECTOR_SCHEDULE_LABEL: Record<CollectorSchedule, string> = { off: '주기 꺼짐(수동만)', daily: '매일', weekly: '매주' };
export const COLLECTOR_RUN_STATUS_LABEL: Record<CollectorRunStatus, string> = {
  preview: '미리보기(아직 소재 없음)',
  accepted: '고른 항목 소재로 저장',
  discarded: '버림',
  failed: '실패',
  blocked: '차단(주소 정책)',
};
export const COLLECTED_DECISION_LABEL: Record<CollectedDecision, string> = { new: '새 항목', duplicate: '중복', skipped: '건너뜀' };
export const COLLECTED_REASON_LABEL: Record<CollectedReason, string> = {
  new: '처음 보는 글',
  updated: '받아들인 적 있는 글의 바뀐 내용',
  same_item: '이미 받아들인 글과 같음',
  existing_capture: '같은 URL 의 소재가 이미 있음',
  in_feed: '같은 피드 안에서 반복',
  no_id: 'guid·링크가 없음',
  blocked_link: '링크가 내부·허용되지 않는 주소',
  empty: '본문 없음',
  too_long: '본문이 20,000자를 넘음',
  limit: '한 번에 100개까지만',
};
export const COLLECTED_OUTCOME_LABEL: Record<CollectedOutcome, string> = {
  accepted: '소재로 저장함',
  not_selected: '고르지 않음',
  skipped_duplicate: '그사이 중복이 되어 건너뜀',
  failed_changed: '다시 읽은 내용이 달라 저장하지 않음',
};
export const COLLECTOR_BLOCK_LABEL: Record<CollectorUrlBlockReason, string> = {
  invalid: '주소 형식 오류',
  too_long: '주소가 너무 김',
  scheme: 'https 만 허용',
  credentials: '사용자 정보가 든 주소',
  port: '기본 포트(443) 외 포트',
  ip_literal: 'IP 주소 직접 입력',
  blocked_host: '내부·로컬 호스트 이름',
  not_allowlisted: '허용 목록에 없는 호스트',
  private_address: '내부·사설·메타데이터 주소로 해석됨',
  redirect_invalid: '잘못된 redirect',
  too_many_redirects: 'redirect 가 너무 많음',
};
export const FEED_PARSE_LABEL: Record<FeedParseCode, string> = {
  feed_malformed: '피드 XML 형식이 올바르지 않습니다',
  feed_dtd_not_allowed: '피드에 DTD·ENTITY 선언이 있어 읽지 않았습니다(엔티티 확장 금지)',
  feed_too_large: '응답이 1MB 상한을 넘어 읽지 않았습니다',
  feed_not_feed: 'RSS·Atom 피드가 아닙니다',
  feed_not_utf8: 'UTF-8 이 아닌 응답입니다',
};
export const COLLECTOR_ERROR_LABEL: Record<string, string> = {
  ...FEED_PARSE_LABEL,
  blocked: '주소 정책으로 차단 — 요청을 보내지 않았습니다',
  not_found: '모의 자료에 없는 주소입니다(모의 수집기는 고정 자료만 읽음)',
  too_large: '응답이 1MB 상한을 넘었습니다',
  failed: '가져오지 못했습니다',
};
