import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getContentRow, listChannelAccounts, reviewVariantsOfContent, variantReviewBlockers, accountReady } from '@cs/db';
import { adapterIdFor, CHANNEL_LABEL, isUuid, VISIBILITIES, type Channel } from '@cs/domain';
import { getSession } from '../../../lib/auth';
import {
  DISTRIBUTE_ERROR_TEXT,
  planAccountLabel,
  planFormDefaults,
  planResultSelect,
  RESULT_CHOICE_LABEL,
  VISIBILITY_LABEL,
  type PlanFormDefaults,
  type PlanResultSelect,
} from '../../../lib/distribution';
import { getAppDb, getConfig } from '../../../lib/server';

export const dynamic = 'force-dynamic';

/**
 * M4UI(G2, D27): 요청 결과(비공개 업로드·공개 게시·예약 공개 · MOCK 실행)와 예약 공개(모스크바 날짜·시각 → 서버가 UTC 로 저장).
 * 이 채널 초안의 계정들이 고를 수 있는 결과만 보인다(Threads·seed 모의 계정만이면 "MOCK 실행" 고정 문구). 판정은 서버(createPlan)가 한다.
 */
/**
 * FIX-T16(Codex 놓친 케이스): 공개 범위 기본값은 **처음 선택되는 계정**(이전 입력의 계정 또는 첫 계정) 기준 — Instagram 모의 연결 계정이면 public,
 * 아니면 private. 다른 계정에 Instagram 모의 연결이 있다고 해서 seed 계정의 기본값을 public 으로 바꾸지 않는다. 계정을 바꾸면 서버 규칙이 다시 판정한다.
 */
function defaultVisibilityFor(a: { kind: string; platform: string; credentialState: string } | undefined): 'public' | 'private' {
  if (!a) return 'private';
  return adapterIdFor({ kind: a.kind === 'mock' ? 'mock' : 'live', platform: a.platform, credential_state: a.credentialState }) === 'mock_instagram' ? 'public' : 'private';
}

function ResultFields({ vid, sel, prev }: { vid: string; sel: PlanResultSelect; prev: PlanFormDefaults }) {
  if (sel.fixed) {
    return (
      <p className="meta">
        요청 결과: <strong>{RESULT_CHOICE_LABEL.mock_publish}</strong> <span className="tag warn">MOCK</span>
      </p>
    );
  }
  const prevChoice = prev.result[vid];
  const def = prevChoice !== undefined && (prevChoice === '' || sel.choices.includes(prevChoice as never)) ? prevChoice : sel.accountDefault ? '' : sel.choices[0];
  return (
    <>
      <label htmlFor={`res-${vid}`}>요청 결과(MOCK — 실제 채널로 보내지 않음)</label>
      <select id={`res-${vid}`} name={`result_${vid}`} defaultValue={def}>
        {sel.accountDefault ? <option value="">계정 기본값(모의 연결 YouTube = 비공개 업로드, 그 밖 = MOCK 실행)</option> : null}
        {sel.choices.map((c) => (
          <option key={c} value={c}>
            {RESULT_CHOICE_LABEL[c]}
          </option>
        ))}
      </select>
      <p className="note">
        비공개 업로드 = 공개 범위 비공개(private). 공개 게시 = 공개 범위 공개·일부 공개. 예약 공개 = 공개 범위 비공개(private)로 두고 아래 예약 공개 시각을 넣습니다.
        {sel.accountDefault ? ' 계정 이름 옆에 그 계정이 고를 수 있는 결과가 있습니다(맞지 않으면 서버가 거부합니다).' : ''}
      </p>
      {sel.scheduledAllowed ? (
        <>
          <label htmlFor={`pdate-${vid}`}>예약 공개 날짜(모스크바, 예약 공개일 때만 — 다른 요청 결과면 보내지 않음)</label>
          <input id={`pdate-${vid}`} type="date" name={`publish_date_${vid}`} defaultValue={prev.publishDate[vid] ?? ''} />
          <label htmlFor={`ptime-${vid}`}>예약 공개 시각(모스크바, HH:mm, 예약 공개일 때만 — 다른 요청 결과면 보내지 않음)</label>
          <input
            id={`ptime-${vid}`}
            type="text"
            name={`publish_time_${vid}`}
            placeholder="예: 18:00"
            defaultValue={prev.publishTime[vid] ?? ''}
            pattern="[0-2][0-9]:[0-5][0-9]"
            maxLength={5}
          />
          <p className="note">예약 공개 시각은 모스크바 시각으로 받아 서버가 UTC 로 저장합니다(원격 publishAt — MOCK). 실행 예약이 있으면 그보다 뒤여야 합니다.</p>
        </>
      ) : null}
    </>
  );
}

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
  // 화면 확인 D10: 오류로 돌아온 경우에만 입력값을 되살린다(오류 없이 연 화면은 기본 선택 없음 — docs/03).
  const prev = err ? planFormDefaults(q) : planFormDefaults({});

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
                    <input type="checkbox" name={`use_${v.id}`} disabled={blockers.length > 0} defaultChecked={blockers.length === 0 && prev.use.has(v.id)} />
                    이 채널 초안을 계획에 넣기
                  </label>
                  <label htmlFor={`acc-${v.id}`}>계정</label>
                  <select id={`acc-${v.id}`} name={`account_${v.id}`} defaultValue={accs.some((a) => a.id === prev.account[v.id]) ? prev.account[v.id] : undefined}>
                    {accs.map((a) => (
                      <option key={a.id} value={a.id}>
                        {planAccountLabel(a)}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`vis-${v.id}`}>공개 범위</label>
                  <select
                    id={`vis-${v.id}`}
                    name={`visibility_${v.id}`}
                    defaultValue={prev.visibility[v.id] ?? defaultVisibilityFor(accs.find((a) => a.id === prev.account[v.id]) ?? accs[0])}
                  >
                    {VISIBILITIES.map((x) => (
                      <option key={x} value={x}>
                        {VISIBILITY_LABEL[x]}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`date-${v.id}`}>실행 예약 날짜(모스크바, 선택 — 비우면 즉시)</label>
                  <input id={`date-${v.id}`} type="date" name={`date_${v.id}`} defaultValue={prev.date[v.id] ?? ''} />
                  <label htmlFor={`time-${v.id}`}>실행 예약 시각(모스크바, HH:mm, 선택)</label>
                  <input id={`time-${v.id}`} type="text" name={`time_${v.id}`} placeholder="예: 12:00" defaultValue={prev.time[v.id] ?? ''} pattern="[0-2][0-9]:[0-5][0-9]" maxLength={5} />
                  {v.channel === 'instagram' && accs.some((a) => adapterIdFor({ kind: a.kind === 'mock' ? 'mock' : 'live', platform: a.platform, credential_state: a.credentialState }) === 'mock_instagram') ? (
                    <p className="note">
                      <span className="tag warn">MOCK</span> 모의 연결 Instagram 계정: 결과는 MOCK 게시뿐이고 공개 범위는 공개(public)만 됩니다(비공개·예약 결과 없음). 이미지는 잠정
                      규격(JPEG·8MiB 이하·가로세로 4:5~1.91:1·가로 320px 이상, 캐러셀 2~10장)을 승인 전에 검사합니다 — 공식 규격 재확인 전 값.
                    </p>
                  ) : null}
                  <ResultFields vid={v.id} sel={planResultSelect(accs)} prev={prev} />
                </>
              )}
            </fieldset>
          ))}
          <label htmlFor="target_summary">계획 이름(선택)</label>
          <input id="target_summary" type="text" name="target_summary" maxLength={200} defaultValue={prev.name} />
          <button type="submit">배포 계획 만들기(MOCK — 승인 전)</button>
        </form>
      )}
    </main>
  );
}
