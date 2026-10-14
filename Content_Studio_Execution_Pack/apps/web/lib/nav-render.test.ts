/**
 * UI-CLEAN: 묶음 내비게이션(SiteNav)·현재 위치(Breadcrumbs) 렌더 시험 — react-dom/server 정적 렌더, next/navigation 은 가짜.
 * 활성 대항목·소항목의 aria-current, 아랫줄은 활성 대항목의 소항목만, 로그인 화면 숨김, 마지막 위치 조각은 링크가 아님을 본다.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteNav } from '../app/site-nav';
import { Breadcrumbs } from './breadcrumbs';

const nav = vi.hoisted(() => ({ pathname: '/' as string | null }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const renderNav = (pathname: string | null) => {
  nav.pathname = pathname;
  return renderToStaticMarkup(createElement(SiteNav));
};

/** 링크 하나(href·aria-current·글자) */
function links(html: string): Array<{ href: string; current: string | null; text: string }> {
  return [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map((m) => ({
    href: /href="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
    current: /aria-current="([^"]*)"/.exec(m[1]!)?.[1] ?? null,
    text: m[2]!,
  }));
}

beforeEach(() => {
  nav.pathname = '/';
});

describe('SiteNav', () => {
  it('윗줄 대항목 6개(오늘·모으기·쓰기·배포·관리·검색), 오늘(/)은 aria-current="page", 아랫줄 없음', () => {
    const html = renderNav('/');
    expect(html).toContain('aria-label="주요 화면"');
    const l = links(html);
    expect(l.map((x) => x.text)).toEqual(['오늘', '모으기', '쓰기', '배포', '관리', '검색']);
    expect(l.find((x) => x.text === '오늘')!.current).toBe('page');
    expect(l.filter((x) => x.current !== null)).toHaveLength(1);
    expect(html).not.toContain('site-subnav');
  });

  it('소재 상세(/captures/<id>) → 모으기 활성(묶음), 아랫줄은 모으기 소항목만, 소재함이 현재 화면', () => {
    const l = links(renderNav('/captures/0b3f6a3e-2a4c-4c1e-9f55-6f1d2c3b4a5e'));
    expect(l.find((x) => x.text === '모으기')!.current).toBe('true');
    const sub = l.slice(6);
    expect(sub.map((x) => x.text)).toEqual(['소재함', '음성 메모', '가져오기', '자동 수집']);
    expect(sub.find((x) => x.text === '소재함')).toMatchObject({ href: '/captures', current: 'page' });
    expect(sub.filter((x) => x.current !== null)).toHaveLength(1);
  });

  it('배포 계획 만들기(/distribute/new) → 쓰기 › 원고(배포가 아님)', () => {
    const l = links(renderNav('/distribute/new'));
    expect(l.find((x) => x.text === '쓰기')!.current).toBe('true');
    expect(l.find((x) => x.text === '배포')!.current).toBeNull();
    expect(l.slice(6).map((x) => x.text)).toEqual(['원고', '카드']);
    expect(l.find((x) => x.text === '원고')!.current).toBe('page');
  });

  it('배포 계획 상세 → 배포 › 배포함, "배포 계정"은 설정#accounts 바로가기(활성 아님)', () => {
    const l = links(renderNav('/distribute/0b3f6a3e-2a4c-4c1e-9f55-6f1d2c3b4a5e'));
    expect(l.find((x) => x.text === '배포')!.current).toBe('true');
    expect(l.find((x) => x.text === '배포함')!.current).toBe('page');
    expect(l.find((x) => x.text === '배포 계정')).toMatchObject({ href: '/settings#accounts', current: null });
  });

  it('검색은 오른쪽 끝(end), 활성이면 aria-current="page"', () => {
    const html = renderNav('/search');
    expect(html).toMatch(/<li class="end"><a [^>]*href="\/search"/);
    expect(links(html).find((x) => x.text === '검색')!.current).toBe('page');
    expect(html).not.toContain('site-subnav');
  });

  it('로그인 화면에서는 아무것도 그리지 않는다', () => {
    expect(renderNav('/login')).toBe('');
  });

  it('모르는 경로(/contentsx)는 활성 없음·아랫줄 없음', () => {
    const html = renderNav('/contentsx');
    expect(links(html).every((x) => x.current === null)).toBe(true);
    expect(html).not.toContain('site-subnav');
  });
});

describe('Breadcrumbs', () => {
  it('<nav aria-label="현재 위치" class="crumbs"><ol>, 대항목은 글자만, 중간은 링크, 마지막은 aria-current 이고 링크 아님', () => {
    const html = renderToStaticMarkup(createElement(Breadcrumbs, { at: { page: 'content-version', id: 'abc', title: '원고 제목', version: 2 } }));
    expect(html.startsWith('<nav aria-label="현재 위치" class="crumbs"><ol>')).toBe(true);
    expect(html).toContain('<li><span>쓰기</span></li>');
    expect(links(html)).toEqual([
      { href: '/contents', current: null, text: '원고' },
      { href: '/contents/abc', current: null, text: '원고 제목' },
    ]);
    expect(html).toContain('<span aria-current="page">버전 2</span>');
  });

  it('제목은 화면 문자열로 escape 되고 40자로 자른다', () => {
    const html = renderToStaticMarkup(createElement(Breadcrumbs, { at: { page: 'idea', idea: `<b>${'가'.repeat(50)}` } }));
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('…</span>');
  });

  it('오늘(/)은 위치 표시를 그리지 않는다', () => {
    expect(renderToStaticMarkup(createElement(Breadcrumbs, { at: { page: 'today' } }))).toBe('');
  });
});
