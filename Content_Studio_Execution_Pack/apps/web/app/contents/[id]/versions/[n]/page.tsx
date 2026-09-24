import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getContentVersion } from '@cs/db';
import { formatMsk } from '@cs/domain';
import { getSession } from '../../../../../lib/auth';
import { getAppDb, getConfig } from '../../../../../lib/server';
import { MOCK_WARNING } from '@cs/providers';
import { versionAuthorLabel } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';

/** 버전 보기(읽기 전용, 불변). */
export default async function VersionPage({ params }: { params: Promise<{ id: string; n: string }> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id, n } = await params;
  if (!/^[1-9][0-9]{0,8}$/.test(n)) notFound();
  const { db } = await getAppDb(getConfig());
  const r = await getContentVersion(db, session.ownerId, id.toLowerCase(), Number(n));
  if (!r) notFound();
  const { content: c, version: v } = r;
  const isCurrent = c.currentVersionId === v.id;
  return (
    <main className="container">
      <p className="now">
        <Link href={`/contents/${c.id}`}>← 작성실</Link>
      </p>
      <h2 className="screen-title">
        {c.title} · 버전 {v.version}
        {isCurrent ? ' (현재)' : ''}
      </h2>
      <p className="meta">
        <time dateTime={v.createdAt.toISOString()}>{formatMsk(v.createdAt)}</time>
        <span className={v.createdBy.startsWith('ai:') ? 'tag warn' : undefined}>{versionAuthorLabel(v.createdBy, v.aiRunId)}</span>
        {v.version > 1 ? <Link href={`/contents/${c.id}/diff?from=${v.version - 1}&to=${v.version}`}>이전 버전과 비교</Link> : null}
      </p>
      {v.note ? <p className="note">메모: {v.note}</p> : null}
      {v.createdBy === 'ai:mock' ? (
        <p className="notice" role="note">
          {MOCK_WARNING} — 이 버전은 AI 제안이며 현재 본문이 아닙니다. 채택은 작성실에서 합니다.
        </p>
      ) : null}
      <section className="card archive" aria-label="본문(읽기 전용)">
        <pre className="raw-text">{v.body || '(빈 본문)'}</pre>
        <p className="note">저장된 버전은 바꿀 수 없습니다. 고치려면 작성실에서 새 버전으로 저장하세요.</p>
      </section>
    </main>
  );
}
