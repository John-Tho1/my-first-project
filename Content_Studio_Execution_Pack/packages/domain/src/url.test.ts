import { describe, expect, it } from 'vitest';
import { InvalidUrlError, UrlNotAllowedError } from './errors';
import { assertFetchableUrl, isFetchableUrl, normalizeUrl, parseIPv4Loose, parseIPv6 } from './url';

describe('normalizeUrl', () => {
  it('추적 파라미터(utm_*, fbclid, gclid) 제거 + 나머지 정렬', () => {
    const r = normalizeUrl('https://example.com/a?utm_source=x&b=2&fbclid=abc&a=1&gclid=z&UTM_Medium=m');
    expect(r.canonical).toBe('https://example.com/a?b=2&a=1');
    expect(r.normalized).toBe('https://example.com/a?a=1&b=2');
  });
  it('fragment 제거', () => {
    expect(normalizeUrl('https://example.com/a#section').normalized).toBe('https://example.com/a');
    expect(normalizeUrl('https://example.com/a#section').canonical).toBe('https://example.com/a');
  });
  it('루트가 아닌 경로의 끝 / 제거, 루트는 유지', () => {
    expect(normalizeUrl('https://example.com/blog/post/').normalized).toBe('https://example.com/blog/post');
    expect(normalizeUrl('https://example.com/blog/post/').canonical).toBe('https://example.com/blog/post/');
    expect(normalizeUrl('https://example.com').normalized).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com/').normalized).toBe('https://example.com/');
  });
  it('scheme·host 대문자 → 소문자, 경로 대소문자는 유지', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path').normalized).toBe('https://example.com/Path');
  });
  it('기본 포트 제거, 다른 포트는 유지', () => {
    expect(normalizeUrl('http://example.com:80/x').normalized).toBe('http://example.com/x');
    expect(normalizeUrl('https://example.com:443/x').normalized).toBe('https://example.com/x');
    expect(normalizeUrl('https://example.com:8443/x').normalized).toBe('https://example.com:8443/x');
  });
  it('IDN 호스트 → punycode', () => {
    expect(normalizeUrl('https://한국.example/글').normalized).toBe('https://xn--3e0b707e.example/%EA%B8%80');
    expect(normalizeUrl('https://пример.рф/').normalized).toBe('https://xn--e1afmkfd.xn--p1ai/');
  });
  it('호스트 끝의 . 제거(중복 키)', () => {
    expect(normalizeUrl('https://example.com./a').normalized).toBe('https://example.com/a');
  });
  it('추적 파라미터만 있으면 query 가 사라진다', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=x').normalized).toBe('https://example.com/a');
  });
  it('같은 키의 값 순서는 유지(안정 정렬), 원래 인코딩 유지', () => {
    expect(normalizeUrl('https://example.com/?z=1&k=b&k=a&q=%20x').normalized).toBe(
      'https://example.com/?k=b&k=a&q=%20x&z=1',
    );
  });
  it('tracking 만 다른 두 URL 은 같은 normalized', () => {
    const a = normalizeUrl('https://example.com/guides/x/?utm_source=tg#top');
    const b = normalizeUrl('https://EXAMPLE.com/guides/x?fbclid=123');
    expect(a.normalized).toBe(b.normalized);
  });
  it.each(['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', '', 'https://'])(
    '거부: %s',
    (u) => {
      expect(() => normalizeUrl(u)).toThrow(InvalidUrlError);
    },
  );
  it('사용자 정보가 있는 URL 은 거부', () => {
    expect(() => normalizeUrl('https://user:pass@example.com/')).toThrow(InvalidUrlError);
  });
  it('너무 긴 URL 거부', () => {
    expect(() => normalizeUrl(`https://example.com/${'a'.repeat(2100)}`)).toThrow(InvalidUrlError);
  });
});

describe('parseIPv4Loose / parseIPv6', () => {
  it('10진·16진·8진·축약 IPv4', () => {
    const lo = 0x7f000001;
    expect(parseIPv4Loose('127.0.0.1')).toBe(lo);
    expect(parseIPv4Loose('2130706433')).toBe(lo);
    expect(parseIPv4Loose('0x7f000001')).toBe(lo);
    expect(parseIPv4Loose('017700000001')).toBe(lo);
    expect(parseIPv4Loose('127.1')).toBe(lo);
    expect(parseIPv4Loose('0x7f.0.0.1')).toBe(lo);
    expect(parseIPv4Loose('example.com')).toBeNull();
    expect(parseIPv4Loose('256.0.0.1')).toBeNull();
  });
  it('IPv6 확장·IPv4 꼬리', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIPv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x102, 0x304]);
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('fe80::1%eth0')).toBeNull();
  });
});

describe('assertFetchableUrl (A05, DNS 없음)', () => {
  it.each([
    'https://example.com/articles/x',
    'http://example.org:8080/a?b=1',
    'https://sub.example.co.kr/',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
    'https://[::ffff:8.8.8.8]/',
    'https://한국.example/',
  ])('허용: %s', (u) => {
    expect(() => assertFetchableUrl(u)).not.toThrow();
    expect(isFetchableUrl(u)).toBe(true);
  });

  it.each([
    // scheme
    ['ftp://example.com/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['gopher://example.com/', 'scheme'],
    // 이름
    ['http://localhost/x', 'localhost'],
    ['http://LOCALHOST:3000/', 'localhost 대문자'],
    ['http://localhost./', 'localhost 끝 점'],
    ['http://foo.localhost/', '*.localhost'],
    ['http://printer.local/', '*.local'],
    ['http://metadata.google.internal/computeMetadata/v1/', 'GCP 메타데이터'],
    ['http://db.internal/', '*.internal'],
    ['http://router.home.arpa/', 'home.arpa'],
    ['http://intranet/', '점 없는 이름'],
    ['http://metadata/', '점 없는 이름 metadata'],
    // IPv4
    ['http://127.0.0.1:8080/x', 'loopback'],
    ['http://127.1/', 'loopback 축약'],
    ['http://2130706433/', '10진 IPv4'],
    ['http://0x7f000001/', '16진 IPv4'],
    ['http://017700000001/', '8진 IPv4'],
    ['http://0.0.0.0/', '0.0.0.0'],
    ['http://0/', '0'],
    ['http://10.1.2.3/', '10/8'],
    ['http://172.16.0.1/', '172.16/12'],
    ['http://172.31.255.255/', '172.16/12 끝'],
    ['http://192.168.1.1/', '192.168/16'],
    ['http://169.254.169.254/latest/meta-data/', '메타데이터 IP'],
    ['http://169.254.1.1/', 'link-local'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['http://224.0.0.1/', 'multicast'],
    ['http://255.255.255.255/', 'broadcast'],
    ['http://240.0.0.1/', '예약'],
    // IPv6
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::]/', 'IPv6 unspecified'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped loopback'],
    ['http://[::ffff:169.254.169.254]/', 'IPv4-mapped 메타데이터'],
    ['http://[::ffff:7f00:1]/', 'IPv4-mapped 16진'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
    ['http://[fd00:ec2::254]/', 'AWS IPv6 메타데이터(fd00::/8)'],
    ['http://[fc00::1]/', 'unique-local'],
    ['http://[ff02::1]/', 'IPv6 multicast'],
    ['http://[64:ff9b::7f00:1]/', 'NAT64 loopback'],
    ['http://[2002:7f00:1::]/', '6to4 loopback'],
    ['http://[2001:db8::1]/', '문서용'],
    // 사용자 정보
    ['http://user:pw@example.com/', 'userinfo'],
  ])('거부: %s (%s)', (u) => {
    expect(() => assertFetchableUrl(u)).toThrow(UrlNotAllowedError);
    expect(isFetchableUrl(u)).toBe(false);
  });

  it('오류는 400 url_not_allowed + 한국어 문구', () => {
    try {
      assertFetchableUrl('http://127.0.0.1/');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UrlNotAllowedError);
      const err = e as UrlNotAllowedError;
      expect(err.kind).toBe('bad_request');
      expect(err.code).toBe('url_not_allowed');
      expect(err.message).toBe('내부망·로컬 주소는 추출할 수 없습니다');
    }
  });
});
