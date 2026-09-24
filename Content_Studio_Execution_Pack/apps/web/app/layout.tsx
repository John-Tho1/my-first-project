import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Content Studio',
  description: '개인 콘텐츠 수집·작성·아카이브 (비공개)',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {/* 정적 링크만(로그인 확인은 각 화면이 한다). 로그인 화면에서도 보이지만 누르면 /login 으로 돌아온다. */}
        <nav className="site-nav" aria-label="주요 화면">
          <Link href="/">오늘</Link>
          <Link href="/captures">소재함</Link>
          <Link href="/ideas">카드</Link>
          <Link href="/contents">아카이브</Link>
          <Link href="/search">검색</Link>
          <Link href="/brand">브랜드</Link>
          <Link href="/settings">설정</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
