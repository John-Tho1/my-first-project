'use client';

/**
 * UI-CLEAN: 묶음 내비게이션 — 윗줄 대항목(오늘·모으기·쓰기·배포·관리 … 검색), 아랫줄은 활성 대항목의 소항목만(호버 메뉴 없음).
 * 활성 판정은 lib/nav.ts navState(순수 함수). 로그인 화면에서는 그리지 않는다.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_GROUPS, navState } from '../lib/nav';

export function SiteNav() {
  const state = navState(usePathname());
  if (state.hidden) return null;
  const active = NAV_GROUPS.find((g) => g.key === state.group) ?? null;
  return (
    <nav className="site-nav" aria-label="주요 화면">
      <ul className="site-nav-groups">
        {NAV_GROUPS.map((g) => {
          const on = g.key === state.group;
          // 소항목이 없는 대항목(오늘·검색)은 그 자체가 현재 화면, 소항목이 있으면 "현재 묶음"
          const current = on ? (g.items.length === 0 ? 'page' : 'true') : undefined;
          return (
            <li key={g.key} className={g.end ? 'end' : undefined}>
              <Link href={g.href} aria-current={current} className={on ? 'active' : undefined}>
                {g.label}
              </Link>
            </li>
          );
        })}
      </ul>
      {active && active.items.length ? (
        <ul className="site-subnav" aria-label={`${active.label} 하위 화면`}>
          {active.items.map((it) => {
            const on = it.href === state.item;
            return (
              <li key={it.href}>
                <Link href={it.href} aria-current={on ? 'page' : undefined} className={on ? 'active' : undefined}>
                  {it.label}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </nav>
  );
}
