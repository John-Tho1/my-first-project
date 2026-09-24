import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getContentVersion } from '@cs/db';
import { diffLines, formatMsk } from '@cs/domain';
import { getSession } from '../../../../lib/auth';
import { DiffView } from '../../../../lib/diff-view';
import { getAppDb, getConfig } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

const VERSION_RE = /^[1-9][0-9]{0,8}$/;

/** 두 버전 비교(from → to). */
export default async function DiffPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const { id } = await params;
  const q = await searchParams;
  const from = typeof q.from === 'string' && VERSION_RE.test(q.from) ? Number(q.from) : null;
  const to = typeof q.to === 'string' && VERSION_RE.test(q.to) ? Number(q.to) : null;
  if (from === null || to === null) notFound();
  const { db } = await getAppDb(getConfig());
  const a = await getContentVersion(db, session.ownerId, id.toLowerCase(), from);
  const b = a ? await getContentVersion(db, session.ownerId, id.toLowerCase(), to) : null;
  if (!a || !b) notFound();
  return (
    <main className="container">
      <p className="now">
        <Link href={`/contents/${a.content.id}`}>← 작성실</Link>
      </p>
      <h2 className="screen-title">
        {a.content.title} · 버전 {from} → {to}
      </h2>
      <p className="meta">
        <span>
          버전 {from}: {formatMsk(a.version.createdAt)}
        </span>
        <span>
          버전 {to}: {formatMsk(b.version.createdAt)}
        </span>
      </p>
      <section className="card archive">
        <DiffView lines={diffLines(a.version.body, b.version.body)} label={`버전 ${from} 과 ${to} 의 차이`} />
        <p className="note">− 는 버전 {from} 에만 있는 줄, + 는 버전 {to} 에만 있는 줄입니다.</p>
      </section>
    </main>
  );
}
