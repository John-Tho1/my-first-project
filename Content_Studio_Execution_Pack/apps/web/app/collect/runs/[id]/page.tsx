import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getCollectorRun, getCollectorSource, listCollectedItems } from '@cs/db';
import {
  COLLECTED_DECISION_LABEL,
  COLLECTED_OUTCOME_LABEL,
  COLLECTED_REASON_LABEL,
  COLLECTOR_RUN_STATUS_LABEL,
  formatMsk,
  type CollectedDecision,
  type CollectedOutcome,
  type CollectedReason,
  type CollectorRunStatus,
} from '@cs/domain';
import { getSession } from '../../../../lib/auth';
import { COLLECT_ERROR_TEXT, runErrorText } from '../../../../lib/collector';
import { getAppDb, getConfig } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/** 수집 미리보기(T19): 새·중복·건너뜀 판정, 새 항목만 체크해서 소재로 저장. 기본 선택 없음(자동 저장 없음). */
export default async function CollectRunPage({
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
  const { db } = await getAppDb(getConfig());
  const run = await getCollectorRun(db, session.ownerId, id.toLowerCase());
  if (!run) notFound();
  const source = await getCollectorSource(db, session.ownerId, run.sourceId);
  const items = await listCollectedItems(db, session.ownerId, run.id);
  const open = run.status === 'preview';
  const err = str(q.error) ? (COLLECT_ERROR_TEXT[str(q.error)!] ?? COLLECT_ERROR_TEXT.server) : undefined;

  return (
    <main className="container">
      <p className="now">
        <Link href="/collect">← 수집</Link>
      </p>
      <h2 className="screen-title">수집 미리보기 — {source?.label ?? source?.host ?? '소스'}</h2>
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      <p className="notice" role="note">
        MOCK — 모의 수집기가 고정 자료에서 읽은 결과입니다(실제 웹 요청 없음). 아직 소재는 만들어지지 않았습니다. 저장할 새 항목을 고르세요.
      </p>
      <section className="card archive">
        <p className="meta">
          <span className="tag warn">MOCK</span>
          <span>{formatMsk(run.createdAt)}</span>
          <span>{run.trigger === 'manual' ? '수동 실행' : '주기 실행'}</span>
          <span>{COLLECTOR_RUN_STATUS_LABEL[run.status as CollectorRunStatus] ?? run.status}</span>
        </p>
        {run.errorCode ? <p className="note">{runErrorText(run.errorCode)}</p> : null}
        {run.status !== 'failed' && run.status !== 'blocked' ? (
          <p className="note">
            새 {run.counts.new ?? 0} · 중복 {run.counts.duplicate ?? 0} · 건너뜀 {run.counts.skipped ?? 0}
            {run.result ? ` — 저장 ${run.result.accepted ?? 0} · 그사이 중복 ${run.result.skipped_duplicate ?? 0} · 내용 바뀜 ${run.result.failed_changed ?? 0}` : ''}
          </p>
        ) : null}
      </section>

      {items.length ? (
        <form className="form" method="post" action={`/api/collector/runs/${run.id}/accept`}>
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">저장</th>
                  <th scope="col">글</th>
                  <th scope="col">판정</th>
                  <th scope="col">결과</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      {open && i.decision === 'new' ? (
                        <input type="checkbox" name="item" value={i.id} aria-label={`${i.title ?? '제목 없음'} 저장`} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <strong>{i.title ?? '(제목 없음)'}</strong>
                      {i.publishedText ? <span className="muted-text"> · {i.publishedText}</span> : null}
                      <br />
                      <span className="note">{i.excerpt}</span>
                      {i.link ? (
                        <>
                          <br />
                          <span className="hash">{i.link}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <span className={i.decision === 'new' ? 'tag warn' : 'tag'}>{COLLECTED_DECISION_LABEL[i.decision as CollectedDecision] ?? i.decision}</span>{' '}
                      {COLLECTED_REASON_LABEL[i.reason as CollectedReason] ?? i.reason}
                    </td>
                    <td>
                      {i.outcome ? COLLECTED_OUTCOME_LABEL[i.outcome as CollectedOutcome] ?? i.outcome : '—'}
                      {i.captureId ? (
                        <>
                          {' · '}
                          <Link href={`/captures/${i.captureId}`}>소재 보기</Link>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open ? <button type="submit">고른 항목을 소재로 저장</button> : null}
        </form>
      ) : (
        <p className="empty-text">항목이 없습니다.</p>
      )}
      {open ? (
        <form className="form inline" method="post" action={`/api/collector/runs/${run.id}/discard`}>
          <button type="submit">이 미리보기 버리기</button>
        </form>
      ) : null}
    </main>
  );
}
