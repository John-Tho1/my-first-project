/**
 * UI-CLEAN: 현재 위치(대항목 › 소항목 › 제목) — 서버 컴포넌트, 스크립트 없음. 판정은 lib/nav.ts crumbsFor.
 * 대항목 이름은 링크가 아니고(분류 이름), 마지막 조각은 현재 화면(aria-current="page", 링크 아님).
 */
import Link from 'next/link';
import { crumbsFor, type CrumbTarget } from './nav';

export function Breadcrumbs({ at }: { at: CrumbTarget }) {
  const crumbs = crumbsFor(at);
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="현재 위치" className="crumbs">
      <ol>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${i}-${c.label}`}>
              {last ? (
                <span aria-current="page">{c.label}</span>
              ) : c.href ? (
                <Link href={c.href}>{c.label}</Link>
              ) : (
                <span>{c.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
