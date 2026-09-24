import type { Metadata } from 'next';
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
      <body>{children}</body>
    </html>
  );
}
