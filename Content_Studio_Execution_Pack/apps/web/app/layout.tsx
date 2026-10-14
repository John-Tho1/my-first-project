import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SiteNav } from './site-nav';

export const metadata: Metadata = {
  title: 'Content Studio',
  description: '개인 콘텐츠 수집·작성·아카이브 (비공개)',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {/* UI-CLEAN: 묶음 내비게이션(링크만 — 로그인 확인은 각 화면이 한다). 로그인 화면에서는 숨긴다. */}
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
