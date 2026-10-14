/**
 * UI-CLEAN: 묶음 내비게이션(대항목 → 소항목)과 현재 위치(breadcrumb) 판정 — 순수 함수만(React·DB 없음).
 * 화면(app/site-nav.tsx, lib/breadcrumbs.tsx)은 이 판정만 그린다. 시험: lib/nav.test.ts.
 */
import { preview } from './labels';

export interface NavItem {
  label: string;
  href: string;
  /** 이 소항목이 활성인 경로 접두사(빈 배열 = 활성 표시 안 함, 예: 설정 화면의 한 구역으로 가는 바로가기) */
  prefixes: readonly string[];
}

export interface NavGroup {
  key: 'today' | 'collect' | 'write' | 'distribute' | 'manage' | 'search';
  label: string;
  href: string;
  /** 소항목이 없는 대항목의 활성 경로 접두사('/' 는 정확히 일치할 때만) */
  prefixes: readonly string[];
  items: readonly NavItem[];
  /** 윗줄 오른쪽 끝에 둔다(검색) */
  end?: boolean;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { key: 'today', label: '오늘', href: '/', prefixes: ['/'], items: [] },
  {
    key: 'collect',
    label: '모으기',
    href: '/captures',
    prefixes: [],
    items: [
      { label: '소재함', href: '/captures', prefixes: ['/captures'] },
      { label: '음성 메모', href: '/record', prefixes: ['/record'] },
      { label: '가져오기', href: '/imports', prefixes: ['/imports'] },
      { label: '자동 수집', href: '/collect', prefixes: ['/collect'] },
    ],
  },
  {
    key: 'write',
    label: '쓰기',
    href: '/contents',
    prefixes: [],
    items: [
      // 배포 계획 만들기(/distribute/new)는 원고에서 시작하므로 쓰기 › 원고(가장 긴 접두사가 이긴다)
      { label: '원고', href: '/contents', prefixes: ['/contents', '/distribute/new'] },
      { label: '카드', href: '/ideas', prefixes: ['/ideas'] },
    ],
  },
  {
    key: 'distribute',
    label: '배포',
    href: '/distribute',
    prefixes: [],
    items: [
      { label: '배포함', href: '/distribute', prefixes: ['/distribute'] },
      { label: '배포 계정', href: '/settings#accounts', prefixes: [] },
    ],
  },
  {
    key: 'manage',
    label: '관리',
    href: '/settings',
    prefixes: [],
    items: [
      { label: '설정', href: '/settings', prefixes: ['/settings'] },
      { label: '브랜드 프로필', href: '/brand', prefixes: ['/brand'] },
      { label: '운영', href: '/ops', prefixes: ['/ops'] },
    ],
  },
  { key: 'search', label: '검색', href: '/search', prefixes: ['/search'], items: [], end: true },
];

/** 내비게이션을 숨기는 화면(로그인 전) */
const HIDDEN_PREFIXES = ['/login'];

/** 경로 접두사 일치: 같거나 '접두사/…'. '/' 는 정확히 '/' 일 때만(모든 경로와 겹치지 않게). */
export function matchesPrefix(path: string, prefix: string): boolean {
  if (prefix === '/') return path === '/';
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** 쿼리·해시를 떼고 끝의 '/' 를 없앤다(루트 제외). 빈 값은 '/'. */
export function normalizePath(pathname: string | null | undefined): string {
  let p = (pathname ?? '/').split(/[?#]/)[0] ?? '/';
  if (!p.startsWith('/')) p = `/${p}`;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

export interface NavState {
  /** 내비게이션을 그리지 않는다(/login) */
  hidden: boolean;
  /** 활성 대항목(없으면 null — 모르는 경로) */
  group: NavGroup['key'] | null;
  /** 활성 소항목의 href(대항목에 소항목이 없거나 모르는 경로면 null) */
  item: string | null;
}

/** 현재 경로의 활성 대항목·소항목. 가장 긴 접두사가 이긴다(/distribute/new → 쓰기 › 원고). */
export function navState(pathname: string | null | undefined): NavState {
  const path = normalizePath(pathname);
  if (HIDDEN_PREFIXES.some((p) => matchesPrefix(path, p))) return { hidden: true, group: null, item: null };
  let best: { len: number; group: NavGroup['key']; item: string | null } | null = null;
  for (const g of NAV_GROUPS) {
    for (const p of g.prefixes) {
      if (matchesPrefix(path, p) && (!best || p.length > best.len)) best = { len: p.length, group: g.key, item: null };
    }
    for (const it of g.items) {
      for (const p of it.prefixes) {
        if (matchesPrefix(path, p) && (!best || p.length > best.len)) best = { len: p.length, group: g.key, item: it.href };
      }
    }
  }
  return best ? { hidden: false, group: best.group, item: best.item } : { hidden: false, group: null, item: null };
}

// ── 현재 위치(breadcrumb) ──

export interface Crumb {
  label: string;
  /** 없으면 링크가 아니다(대항목 이름, 마지막 = 현재 화면) */
  href?: string;
}

/** 화면 제목 조각: 앞 40자 + 말줄임, 비었으면 "(제목 없음)". */
export const CRUMB_TITLE_MAX = 40;
export const CRUMB_UNTITLED = '(제목 없음)';
export function crumbTitle(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t ? preview(t, CRUMB_TITLE_MAX) : CRUMB_UNTITLED;
}

/** 각 화면이 이미 읽은 데이터만으로 만드는 위치 정보(추가 조회 없음). */
export type CrumbTarget =
  | { page: 'today' }
  | { page: 'captures' }
  | { page: 'capture'; title: string | null; rawText: string }
  | { page: 'record' }
  | { page: 'imports' }
  /** label = 원본 종류 + 미리보기 시각(화면이 formatMsk 로 만든 문자열) */
  | { page: 'import'; label: string }
  | { page: 'collect' }
  | { page: 'collect-run'; label: string | null; host: string | null }
  | { page: 'contents' }
  | { page: 'content'; id: string; title: string }
  | { page: 'content-version'; id: string; title: string; version: number }
  | { page: 'content-diff'; id: string; title: string; from: number; to: number }
  | { page: 'ideas' }
  | { page: 'idea'; idea: string }
  | { page: 'distribute-new'; contentId: string; title: string }
  | { page: 'distribute' }
  | { page: 'plan'; targetSummary: string | null }
  | { page: 'settings' }
  | { page: 'restore' }
  | { page: 'brand' }
  | { page: 'ops' }
  | { page: 'search' };

const COLLECT: Crumb = { label: '모으기' };
const WRITE: Crumb = { label: '쓰기' };
const DISTRIBUTE: Crumb = { label: '배포' };
const MANAGE: Crumb = { label: '관리' };

/** 마지막 조각은 링크를 떼어 현재 화면으로 만든다. */
function trail(...crumbs: Crumb[]): Crumb[] {
  return crumbs.map((c, i) => (i === crumbs.length - 1 ? { label: c.label } : c));
}

/** 화면별 위치(대항목 › 소항목 › 제목…). 오늘(/)은 위치 표시 없음(빈 배열). */
export function crumbsFor(t: CrumbTarget): Crumb[] {
  switch (t.page) {
    case 'today':
      return [];
    case 'captures':
      return trail(COLLECT, { label: '소재함' });
    case 'capture':
      return trail(COLLECT, { label: '소재함', href: '/captures' }, { label: crumbTitle(t.title?.trim() ? t.title : t.rawText) });
    case 'record':
      return trail(COLLECT, { label: '음성 메모' });
    case 'imports':
      return trail(COLLECT, { label: '가져오기' });
    case 'import':
      return trail(COLLECT, { label: '가져오기', href: '/imports' }, { label: crumbTitle(t.label) });
    case 'collect':
      return trail(COLLECT, { label: '자동 수집' });
    case 'collect-run':
      return trail(COLLECT, { label: '자동 수집', href: '/collect' }, { label: crumbTitle(t.label?.trim() ? t.label : t.host) });
    case 'contents':
      return trail(WRITE, { label: '원고' });
    case 'content':
      return trail(WRITE, { label: '원고', href: '/contents' }, { label: crumbTitle(t.title) });
    case 'content-version':
      return trail(WRITE, { label: '원고', href: '/contents' }, { label: crumbTitle(t.title), href: `/contents/${t.id}` }, { label: `버전 ${t.version}` });
    case 'content-diff':
      return trail(
        WRITE,
        { label: '원고', href: '/contents' },
        { label: crumbTitle(t.title), href: `/contents/${t.id}` },
        { label: `버전 비교 ${t.from}→${t.to}` },
      );
    case 'ideas':
      return trail(WRITE, { label: '카드' });
    case 'idea':
      return trail(WRITE, { label: '카드', href: '/ideas' }, { label: crumbTitle(t.idea) });
    case 'distribute-new':
      return trail(
        WRITE,
        { label: '원고', href: '/contents' },
        { label: crumbTitle(t.title), href: `/contents/${t.contentId}#variants` },
        { label: '배포 계획 만들기' },
      );
    case 'distribute':
      return trail(DISTRIBUTE, { label: '배포함' });
    case 'plan':
      return trail(DISTRIBUTE, { label: '배포함', href: '/distribute' }, { label: t.targetSummary?.trim() ? crumbTitle(t.targetSummary) : '이름 없음' });
    case 'settings':
      return trail(MANAGE, { label: '설정' });
    case 'restore':
      return trail(MANAGE, { label: '설정', href: '/settings' }, { label: '복원 미리보기' });
    case 'brand':
      return trail(MANAGE, { label: '브랜드 프로필' });
    case 'ops':
      return trail(MANAGE, { label: '운영' });
    case 'search':
      return trail({ label: '검색' });
  }
}
