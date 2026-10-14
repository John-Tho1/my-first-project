/**
 * UI-CLEAN: 묶음 내비게이션 활성 판정(navState)·현재 위치(crumbsFor) — 순수 함수 시험.
 * 모든 화면(app 의 page.tsx)이 정확히 한 대항목에 들어가는지, 접두사 경계(/contentsx)·오늘(정확히 /)·예외(/distribute/new)·로그인 숨김을 본다.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CRUMB_UNTITLED, crumbsFor, crumbTitle, matchesPrefix, NAV_GROUPS, navState, normalizePath, type NavGroup } from './nav';

const APP_DIR = fileURLToPath(new URL('../app', import.meta.url));
const ID = '0b3f6a3e-2a4c-4c1e-9f55-6f1d2c3b4a5e';

/** app 아래 page.tsx 를 모두 찾아 경로 패턴(/contents/[id] …)으로 */
function pageRoutes(dir = APP_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'api') continue;
      out.push(...pageRoutes(p));
    } else if (name === 'page.tsx') {
      const rel = relative(APP_DIR, dir).split(sep).join('/');
      out.push(rel ? `/${rel}` : '/');
    }
  }
  return out.sort();
}

/** 화면 패턴 → 예시 경로 · 기대 대항목 · 기대 소항목 */
const EXPECTED: Record<string, { path: string; group: NavGroup['key'] | null; item: string | null; hidden?: boolean }> = {
  '/': { path: '/', group: 'today', item: null },
  '/captures': { path: '/captures', group: 'collect', item: '/captures' },
  '/captures/[id]': { path: `/captures/${ID}`, group: 'collect', item: '/captures' },
  '/record': { path: '/record', group: 'collect', item: '/record' },
  '/imports': { path: '/imports', group: 'collect', item: '/imports' },
  '/imports/[id]': { path: `/imports/${ID}`, group: 'collect', item: '/imports' },
  '/collect': { path: '/collect', group: 'collect', item: '/collect' },
  '/collect/runs/[id]': { path: `/collect/runs/${ID}`, group: 'collect', item: '/collect' },
  '/contents': { path: '/contents', group: 'write', item: '/contents' },
  '/contents/[id]': { path: `/contents/${ID}`, group: 'write', item: '/contents' },
  '/contents/[id]/versions/[n]': { path: `/contents/${ID}/versions/3`, group: 'write', item: '/contents' },
  '/contents/[id]/diff': { path: `/contents/${ID}/diff`, group: 'write', item: '/contents' },
  '/ideas': { path: '/ideas', group: 'write', item: '/ideas' },
  '/ideas/[id]': { path: `/ideas/${ID}`, group: 'write', item: '/ideas' },
  '/distribute/new': { path: '/distribute/new', group: 'write', item: '/contents' },
  '/distribute': { path: '/distribute', group: 'distribute', item: '/distribute' },
  '/distribute/[id]': { path: `/distribute/${ID}`, group: 'distribute', item: '/distribute' },
  '/settings': { path: '/settings', group: 'manage', item: '/settings' },
  '/settings/restores/[id]': { path: `/settings/restores/${ID}`, group: 'manage', item: '/settings' },
  '/brand': { path: '/brand', group: 'manage', item: '/brand' },
  '/ops': { path: '/ops', group: 'manage', item: '/ops' },
  '/search': { path: '/search', group: 'search', item: null },
  '/login': { path: '/login', group: null, item: null, hidden: true },
};

describe('navState — 모든 화면이 정확히 한 대항목', () => {
  it('app 의 page.tsx 목록과 기대표가 같다(새 화면이 생기면 이 표에 넣어야 한다)', () => {
    expect(pageRoutes()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [route, e] of Object.entries(EXPECTED)) {
    it(`${route} → ${e.hidden ? '숨김' : `${e.group} › ${e.item ?? '-'}`}`, () => {
      const s = navState(e.path);
      expect(s).toEqual({ hidden: e.hidden === true, group: e.group, item: e.item });
      if (!e.hidden) {
        // 정확히 한 대항목: 활성 소항목은 그 대항목 안에 있어야 한다
        const groups = NAV_GROUPS.filter((g) => g.key === s.group);
        expect(groups).toHaveLength(1);
        if (s.item) expect(groups[0]!.items.some((it) => it.href === s.item)).toBe(true);
      }
    });
  }

  it('접두사 경계: /contentsx·/opsx·/searching 은 어느 대항목도 아니다', () => {
    for (const p of ['/contentsx', '/contentsx/1', '/opsx', '/searching', '/distributes', '/loginx']) {
      expect(navState(p)).toEqual({ hidden: false, group: null, item: null });
    }
  });

  it('오늘은 정확히 / 일 때만(다른 모르는 경로를 오늘로 표시하지 않음)', () => {
    expect(navState('/').group).toBe('today');
    expect(navState('/unknown').group).toBeNull();
    expect(matchesPrefix('/x', '/')).toBe(false);
    expect(matchesPrefix('/', '/')).toBe(true);
  });

  it('가장 긴 접두사가 이긴다: /distribute/new(쓰기 › 원고) vs /distribute/<id>(배포 › 배포함)', () => {
    expect(navState('/distribute/new')).toMatchObject({ group: 'write', item: '/contents' });
    expect(navState('/distribute/new/')).toMatchObject({ group: 'write', item: '/contents' });
    expect(navState('/distribute/newer')).toMatchObject({ group: 'distribute', item: '/distribute' });
  });

  it('배포 계정(/settings#accounts)은 바로가기 — 어떤 경로에서도 활성이 아니다', () => {
    const accounts = NAV_GROUPS.find((g) => g.key === 'distribute')!.items.find((i) => i.href === '/settings#accounts')!;
    expect(accounts.prefixes).toEqual([]);
    for (const e of Object.values(EXPECTED)) expect(navState(e.path).item).not.toBe('/settings#accounts');
  });

  it('로그인 화면은 내비게이션을 숨긴다(/login, /login/…, 끝 / · 쿼리 포함)', () => {
    for (const p of ['/login', '/login/', '/login?error=denied', '/login/x']) expect(navState(p).hidden).toBe(true);
  });

  it('경로 정규화: 쿼리·해시·끝 / 를 떼고, 빈 값은 /', () => {
    expect(normalizePath('/captures/?cursor=1#x')).toBe('/captures');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath(null)).toBe('/');
    expect(normalizePath('ideas')).toBe('/ideas');
    expect(navState('/ideas?missing=1').item).toBe('/ideas');
  });

  it('대항목 순서와 이름(사용자 요청: 오늘·모으기·쓰기·배포·관리 + 오른쪽 검색)', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['오늘', '모으기', '쓰기', '배포', '관리', '검색']);
    expect(NAV_GROUPS.filter((g) => g.end).map((g) => g.key)).toEqual(['search']);
    expect(NAV_GROUPS.find((g) => g.key === 'collect')!.items.map((i) => i.label)).toEqual(['소재함', '음성 메모', '가져오기', '자동 수집']);
    expect(NAV_GROUPS.find((g) => g.key === 'write')!.items.map((i) => i.label)).toEqual(['원고', '카드']);
    expect(NAV_GROUPS.find((g) => g.key === 'distribute')!.items.map((i) => i.label)).toEqual(['배포함', '배포 계정']);
    expect(NAV_GROUPS.find((g) => g.key === 'manage')!.items.map((i) => i.label)).toEqual(['설정', '브랜드 프로필', '운영']);
  });
});

describe('crumbsFor — 화면별 현재 위치', () => {
  const labels = (t: Parameters<typeof crumbsFor>[0]) => crumbsFor(t).map((c) => c.label);
  const hrefs = (t: Parameters<typeof crumbsFor>[0]) => crumbsFor(t).map((c) => c.href ?? null);

  it('오늘은 위치 표시 없음', () => {
    expect(crumbsFor({ page: 'today' })).toEqual([]);
  });

  it('목록 화면: 대항목(링크 아님) › 현재 화면(링크 아님)', () => {
    const cases: Array<[Parameters<typeof crumbsFor>[0], string[]]> = [
      [{ page: 'captures' }, ['모으기', '소재함']],
      [{ page: 'record' }, ['모으기', '음성 메모']],
      [{ page: 'imports' }, ['모으기', '가져오기']],
      [{ page: 'collect' }, ['모으기', '자동 수집']],
      [{ page: 'contents' }, ['쓰기', '원고']],
      [{ page: 'ideas' }, ['쓰기', '카드']],
      [{ page: 'distribute' }, ['배포', '배포함']],
      [{ page: 'settings' }, ['관리', '설정']],
      [{ page: 'brand' }, ['관리', '브랜드 프로필']],
      [{ page: 'ops' }, ['관리', '운영']],
      [{ page: 'search' }, ['검색']],
    ];
    for (const [t, want] of cases) {
      expect(labels(t)).toEqual(want);
      expect(hrefs(t).every((h) => h === null)).toBe(true);
    }
  });

  it('상세 화면: 소항목은 목록으로 가는 링크, 마지막은 제목(링크 아님)', () => {
    expect(crumbsFor({ page: 'capture', title: '주재원 첫 주', rawText: '원문' })).toEqual([
      { label: '모으기' },
      { label: '소재함', href: '/captures' },
      { label: '주재원 첫 주' },
    ]);
    expect(labels({ page: 'capture', title: null, rawText: '제목 없는 소재 원문' })).toEqual(['모으기', '소재함', '제목 없는 소재 원문']);
    expect(labels({ page: 'capture', title: '  ', rawText: '공백 제목이면 원문' })[2]).toBe('공백 제목이면 원문');
    expect(crumbsFor({ page: 'import', label: 'Notion ZIP 2026-10-14 09:00 MSK' })).toEqual([
      { label: '모으기' },
      { label: '가져오기', href: '/imports' },
      { label: 'Notion ZIP 2026-10-14 09:00 MSK' },
    ]);
    expect(labels({ page: 'collect-run', label: '사내 블로그 RSS', host: 'blog.example' })).toEqual(['모으기', '자동 수집', '사내 블로그 RSS']);
    expect(labels({ page: 'collect-run', label: null, host: 'blog.example' })[2]).toBe('blog.example');
    expect(labels({ page: 'collect-run', label: null, host: null })[2]).toBe(CRUMB_UNTITLED);
    expect(crumbsFor({ page: 'content', id: ID, title: '원고 제목' })).toEqual([{ label: '쓰기' }, { label: '원고', href: '/contents' }, { label: '원고 제목' }]);
    expect(crumbsFor({ page: 'content-version', id: ID, title: '원고 제목', version: 4 })).toEqual([
      { label: '쓰기' },
      { label: '원고', href: '/contents' },
      { label: '원고 제목', href: `/contents/${ID}` },
      { label: '버전 4' },
    ]);
    expect(crumbsFor({ page: 'content-diff', id: ID, title: '원고 제목', from: 1, to: 3 }).at(-1)).toEqual({ label: '버전 비교 1→3' });
    expect(crumbsFor({ page: 'content-diff', id: ID, title: '원고 제목', from: 1, to: 3 })[2]).toEqual({ label: '원고 제목', href: `/contents/${ID}` });
    expect(crumbsFor({ page: 'idea', idea: '카드 문구' })).toEqual([{ label: '쓰기' }, { label: '카드', href: '/ideas' }, { label: '카드 문구' }]);
    expect(crumbsFor({ page: 'distribute-new', contentId: ID, title: '원고 제목' })).toEqual([
      { label: '쓰기' },
      { label: '원고', href: '/contents' },
      { label: '원고 제목', href: `/contents/${ID}#variants` },
      { label: '배포 계획 만들기' },
    ]);
    expect(crumbsFor({ page: 'plan', targetSummary: '10월 Threads' })).toEqual([{ label: '배포' }, { label: '배포함', href: '/distribute' }, { label: '10월 Threads' }]);
    expect(labels({ page: 'plan', targetSummary: '' })[2]).toBe('이름 없음');
    expect(labels({ page: 'plan', targetSummary: null })[2]).toBe('이름 없음');
    // FIX-UICLEAN(Codex P2): 복원 상태에 따라 마지막 조각이 다르다(미리보기 / 완료)
    expect(crumbsFor({ page: 'restore', committed: false })).toEqual([{ label: '관리' }, { label: '설정', href: '/settings' }, { label: '복원 미리보기' }]);
    expect(crumbsFor({ page: 'restore', committed: true })).toEqual([{ label: '관리' }, { label: '설정', href: '/settings' }, { label: '복원 완료' }]);
  });

  it('제목은 40자(코드 포인트)로 자르고 말줄임, 공백 정리, 비었으면 "(제목 없음)"', () => {
    const long = '가'.repeat(41);
    expect(crumbTitle(long)).toBe(`${'가'.repeat(40)}…`);
    expect(crumbTitle('가'.repeat(40))).toBe('가'.repeat(40));
    expect(crumbTitle('😀'.repeat(45))).toBe(`${'😀'.repeat(40)}…`);
    expect(crumbTitle('여러 줄\n\n  제목')).toBe('여러 줄 제목');
    expect(crumbTitle('')).toBe(CRUMB_UNTITLED);
    expect(crumbTitle('   ')).toBe(CRUMB_UNTITLED);
    expect(crumbTitle(null)).toBe(CRUMB_UNTITLED);
    expect(labels({ page: 'content', id: ID, title: long })[2]).toBe(`${'가'.repeat(40)}…`);
    expect(labels({ page: 'content', id: ID, title: '' })[2]).toBe(CRUMB_UNTITLED);
    expect(labels({ page: 'idea', idea: '' })[2]).toBe(CRUMB_UNTITLED);
    expect(labels({ page: 'capture', title: null, rawText: '' })[2]).toBe(CRUMB_UNTITLED);
    expect(labels({ page: 'plan', targetSummary: long })[2]).toBe(`${'가'.repeat(40)}…`);
  });

  it('모든 위치의 마지막 조각은 링크가 아니다', () => {
    const all: Array<Parameters<typeof crumbsFor>[0]> = [
      { page: 'captures' },
      { page: 'capture', title: 't', rawText: 'r' },
      { page: 'record' },
      { page: 'imports' },
      { page: 'import', label: 'l' },
      { page: 'collect' },
      { page: 'collect-run', label: 'l', host: 'h' },
      { page: 'contents' },
      { page: 'content', id: ID, title: 't' },
      { page: 'content-version', id: ID, title: 't', version: 2 },
      { page: 'content-diff', id: ID, title: 't', from: 1, to: 2 },
      { page: 'ideas' },
      { page: 'idea', idea: 'i' },
      { page: 'distribute-new', contentId: ID, title: 't' },
      { page: 'distribute' },
      { page: 'plan', targetSummary: 's' },
      { page: 'settings' },
      { page: 'restore', committed: false },
      { page: 'restore', committed: true },
      { page: 'brand' },
      { page: 'ops' },
      { page: 'search' },
    ];
    for (const t of all) {
      const c = crumbsFor(t);
      expect(c.length).toBeGreaterThan(0);
      expect(c.at(-1)!.href).toBeUndefined();
    }
  });
});
