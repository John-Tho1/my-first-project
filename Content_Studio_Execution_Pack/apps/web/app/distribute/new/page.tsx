import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getContentRow, listChannelAccounts, reviewVariantsOfContent, variantReviewBlockers, accountReady } from '@cs/db';
import { CHANNEL_LABEL, isUuid, VISIBILITIES, type Channel } from '@cs/domain';
import { getSession } from '../../../lib/auth';
import { DISTRIBUTE_ERROR_TEXT, VISIBILITY_LABEL } from '../../../lib/distribution';
import { getAppDb, getConfig } from '../../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/**
 * 배포 계획 만들기: 이 원고의 검토 중(review·승인됨) 채널 초안 × 그 플랫폼의 모의 계정. 기본 선택 없음(docs/03 "기본 전체 선택 금지").
 * 예약은 모스크바 시각(날짜·시각)으로 받고 서버가 UTC 로 저장한다. 비우면 즉시(승인·실행 뒤 대기열).
 */
export default async function NewPlanPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const q = await searchParams;
  const contentId = (str(q.content_id) ?? '').toLowerCase();
  if (!isUuid(contentId)) notFound();
  const { db } = await getAppDb(getConfig());
  const content = await getContentRow(db, session.ownerId, contentId);
  if (!content) notFound();
  const vs = await reviewVariantsOfContent(db, session.ownerId, content.id);
  const accounts = (await listChannelAccounts(db, session.ownerId)).filter(accountReady);
  const rows = [];
  for (const v of vs) rows.push({ v, blockers: await variantReviewBlockers(db, session.ownerId, v.id), accounts: accounts.filter((a) => a.platform === v.channel) });
  const err = str(q.error) ? (DISTRIBUTE_ERROR_TEXT[str(q.error)!] ?? DISTRIBUTE_ERROR_TEXT.server) : undefined;

  return (
    <main className="container">
      <h2 className="screen-title">배포 계획 만들기 — {content.title}</h2>
      <p className="notice" role="note">
        MOCK — 모의 계정으로만 계획합니다. 계획을 만들어도 승인·게시되지 않습니다. 다음 화면에서 채널별로 나갈 내용을 확인하고 직접 승인해야 합니다.
      </p>
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      <p>
        <Link href={`/contents/${content.id}#variants`}>← 원고로 돌아가기</Link>
      </p>
      {rows.length === 0 ? (
        <p className="empty-text">검토 중인 채널 초안이 없습니다. 원고 화면에서 채널 초안을 &quot;검토로&quot; 보내세요.</p>
      ) : (
        <form className="form" method="post" action="/api/distribution-plans">
          <input type="hidden" name="content_id" value={content.id} />
          {rows.map(({ v, blockers, accounts: accs }) => (
            <fieldset key={v.id} className="card archive">
              <legend>{CHANNEL_LABEL[v.channel as Channel] ?? v.channel}</legend>
              {blockers.length ? <p className="notice">배포 조건을 채우지 못했습니다: {blockers.join(', ')}</p> : null}
              {accs.length === 0 ? (
                <p className="empty-text">이 플랫폼의 준비된 모의 계정이 없습니다.</p>
              ) : (
                <>
                  <label className="choice">
                    <input type="checkbox" name={`use_${v.id}`} disabled={blockers.length > 0} />
                    이 채널 초안을 계획에 넣기
                  </label>
                  <label htmlFor={`acc-${v.id}`}>계정</label>
                  <select id={`acc-${v.id}`} name={`account_${v.id}`}>
                    {accs.map((a) => (
                      <option key={a.id} value={a.id}>
                        {`${a.displayName}${a.kind === 'mock' ? ' (MOCK)' : ''}`}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`vis-${v.id}`}>공개 범위</label>
                  <select id={`vis-${v.id}`} name={`visibility_${v.id}`} defaultValue="private">
                    {VISIBILITIES.map((x) => (
                      <option key={x} value={x}>
                        {VISIBILITY_LABEL[x]}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`date-${v.id}`}>예약 날짜(모스크바, 선택)</label>
                  <input id={`date-${v.id}`} type="date" name={`date_${v.id}`} />
                  <label htmlFor={`time-${v.id}`}>예약 시각(모스크바, HH:mm, 선택)</label>
                  <input id={`time-${v.id}`} type="text" name={`time_${v.id}`} placeholder="예: 12:00" pattern="[0-2][0-9]:[0-5][0-9]" maxLength={5} />
                </>
              )}
            </fieldset>
          ))}
          <label htmlFor="target_summary">계획 이름(선택)</label>
          <input id="target_summary" type="text" name="target_summary" maxLength={200} />
          <button type="submit">배포 계획 만들기(MOCK — 승인 전)</button>
        </form>
      )}
    </main>
  );
}
