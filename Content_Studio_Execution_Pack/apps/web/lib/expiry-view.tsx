/**
 * EXPIRY-1(결정 D39): 홈·설정 상단의 만료 알림(실제 Threads 연결·로컬 인증서). 알림이 없으면 아무것도 그리지 않는다.
 * 문구·순서·경계는 @cs/domain expiryNotices(순수 함수) — 이 컴포넌트는 그리기만 한다. 만료됨은 role="alert", 곧 만료는 role="status".
 */
import Link from 'next/link';
import { EXPIRY_LEVEL_LABEL, type ExpiryNotice } from '@cs/domain';

export function ExpiryNoticeList({ notices }: { notices: readonly ExpiryNotice[] }) {
  if (!notices.length) return null;
  return (
    <section className="expiry-notices" aria-label="만료 알림">
      {notices.map((n, i) => (
        <p key={`${n.kind}-${n.accountId ?? ''}-${i}`} className="notice" role={n.level === 'expired' ? 'alert' : 'status'} data-expiry-kind={n.kind} data-expiry-level={n.level}>
          <span className={n.level === 'expired' ? 'tag danger' : 'tag warn'}>{EXPIRY_LEVEL_LABEL[n.level]}</span> <Link href={n.href}>{n.text}</Link>
        </p>
      ))}
    </section>
  );
}
