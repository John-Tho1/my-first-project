import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listChannelAccounts, listPlans } from '@cs/db';
import { CHANNEL_LABEL, decodeCaptureCursor, encodeCaptureCursor, formatMsk, type Channel } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { PLAN_STATUS_LABEL } from '../../lib/distribution';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** 배포함(T10): 배포 계획 목록 + 모의 배포 계정. M3 은 모의 배포만 — 실제 채널로 아무것도 보내지 않는다. */
export default async function DistributePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const q = await searchParams;
  const raw = str(q.cursor);
  const c = raw ? decodeCaptureCursor(raw) : null;
  const { db } = await getAppDb(getConfig());
  const [page, accounts] = await Promise.all([
    listPlans(db, session.ownerId, { cursor: c ? { at: c.receivedAt, id: c.id } : null, limit: 20 }),
    listChannelAccounts(db, session.ownerId),
  ]);
  const next = page.next ? `/distribute?cursor=${encodeCaptureCursor(page.next.at, page.next.id)}` : null;

  return (
    <main className="container">
      <h2 className="screen-title">배포함</h2>
      <p className="notice" role="note">
        MOCK — 지금 단계(M3)는 모의 배포만 합니다. 승인·실행해도 실제 채널로 아무것도 보내지 않습니다. 작업 처리기는 모의 어댑터로만 처리하며 결과는 MOCK(실제 발행 실적 아님)입니다.
      </p>
      {q.missing === '1' ? (
        <p className="notice" role="alert">
          배포 계획을 찾을 수 없습니다.
        </p>
      ) : null}

      <section className="card archive" aria-labelledby="plans-title">
        <h3 id="plans-title">배포 계획</h3>
        {page.items.length ? (
          <ul className="list">
            {page.items.map((e) => (
              <li key={e.plan.id} className="capture">
                <p className="capture-text">
                  <Link href={`/distribute/${e.plan.id}`}>{e.plan.targetSummary || '배포 계획'}</Link>
                </p>
                <p className="meta">
                  {e.mock ? <span className="tag warn">MOCK</span> : null}
                  <span className="tag">{PLAN_STATUS_LABEL[e.plan.status] ?? e.plan.status}</span>
                  <span>항목 {e.itemCount}개</span>
                  <span>{e.channels.map((ch) => CHANNEL_LABEL[ch as Channel] ?? ch).join(' · ')}</span>
                  <time dateTime={e.plan.createdAt.toISOString()}>만든 시각 {formatMsk(e.plan.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">배포 계획이 없습니다. 원고 화면의 채널 초안에서 &quot;검토로&quot; 보낸 뒤 &quot;배포 계획 만들기&quot;를 누르세요.</p>
        )}
        <p className="pager">{next ? <Link href={next}>더 보기</Link> : <span className="muted-text">마지막입니다</span>}</p>
      </section>

      <section className="card archive" aria-labelledby="accounts-title">
        <h3 id="accounts-title">배포 계정</h3>
        <p className="note">모의(MOCK) 계정만 있습니다. 실제 계정 연결(OAuth)은 M4(T13) 이후이며, 이 앱에는 인증 비밀이 저장되어 있지 않습니다.</p>
        <ul className="list">
          {accounts.map((a) => (
            <li key={a.id}>
              {a.kind === 'mock' ? <span className="tag warn">MOCK</span> : null} {a.displayName} · {CHANNEL_LABEL[a.platform as Channel] ?? a.platform} · 상태 {a.state}
            </li>
          ))}
        </ul>
        {accounts.length === 0 ? <p className="empty-text">계정이 없습니다. `pnpm db:seed` 를 실행하면 모의 계정이 만들어집니다.</p> : null}
      </section>
    </main>
  );
}
