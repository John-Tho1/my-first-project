import Link from 'next/link';
import { redirect } from 'next/navigation';
import { acceptedCountsBySource, listCollectorRuns, listCollectorSources } from '@cs/db';
import {
  collectorReadiness,
  COLLECTOR_KIND_LABEL,
  COLLECTOR_RUN_STATUS_LABEL,
  COLLECTOR_SCHEDULE_LABEL,
  formatMsk,
  type CollectorRunStatus,
  type CollectorSchedule,
  type CollectorSourceKind,
} from '@cs/domain';
import { getSession } from '../../lib/auth';
import { COLLECT_ERROR_TEXT, runErrorText } from '../../lib/collector';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * 수집(T19, D33 제안): 허용한 RSS·Atom·선택 URL 만. 기본 꺼짐·주기 꺼짐. 이 단계에는 모의 수집기만 있다(실제 웹 요청 없음).
 * 실행은 미리보기만 만들고, 사용자가 고른 항목만 소재로 저장한다.
 */
export default async function CollectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const q = await searchParams;
  const config = getConfig();
  const { db } = await getAppDb(config);
  const sources = await listCollectorSources(db, session.ownerId);
  const runs = await listCollectorRuns(db, session.ownerId, 30);
  const accepted = await acceptedCountsBySource(db, session.ownerId);
  const readiness = collectorReadiness(config);
  const err = str(q.error) ? (COLLECT_ERROR_TEXT[str(q.error)!] ?? COLLECT_ERROR_TEXT.server) : undefined;
  const sourceName = new Map(sources.map((s) => [s.id, s.label ?? s.host]));

  return (
    <main className="container">
      <h2 className="screen-title">수집 — 허용한 소스만</h2>
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      <p className="notice" role="note">
        기본 꺼짐 · 모의 수집기 · 실제 웹 요청 없음. 등록한 RSS·Atom 피드와 선택 URL 만 읽고, 수집한 글은 미리보기로만 보여 줍니다 — 고른 항목만 소재로
        저장합니다. 수집한 글 속 지시(예: &quot;즉시 발행하라&quot;)는 자료일 뿐이며 게시·배포로 이어지지 않습니다.
      </p>
      <section className="card archive" aria-labelledby="mode-title">
        <h3 id="mode-title">수집 상태</h3>
        <p className="meta">
          <span className={readiness.mode === 'mock' ? 'tag warn' : 'tag'}>
            {readiness.mode === 'mock' ? 'MOCK — 모의 수집기' : readiness.mode === 'live' ? '실제 수집 — 준비 안 됨' : '꺼짐(기본)'}
          </span>
          <span className="tag">주기 실행: {config.COLLECTOR_SCHEDULER === 'on' && readiness.mode === 'mock' ? '켜짐(미리보기만)' : '꺼짐'}</span>
        </p>
        <p className="note">{readiness.message}</p>
        {readiness.missing.length ? <p className="note">준비 안 됨: {readiness.missing.join(' · ')}</p> : null}
        <p className="note">
          주기 설정은 저장만 됩니다. 주기 실행은 COLLECTOR_SCHEDULER=on 이고 모의 모드일 때만 돌며, 그때도 미리보기만 만들고 소재는 만들지 않습니다.
        </p>
      </section>

      <section className="card archive" aria-labelledby="add-title">
        <h3 id="add-title">소스 추가(허용 목록)</h3>
        <p className="note">https 주소만. 내부·로컬 주소, IP 주소 직접 입력, 443 외 포트는 거부합니다. 추가해도 꺼진 상태로 저장되며 요청은 보내지 않습니다.</p>
        <form className="form" method="post" action="/api/collector/sources">
          <label htmlFor="src-kind">종류</label>
          <select id="src-kind" name="kind" defaultValue="rss">
            <option value="rss">RSS 피드</option>
            <option value="atom">Atom 피드</option>
            <option value="url">선택 URL(페이지 하나)</option>
          </select>
          <label htmlFor="src-url">주소</label>
          <input id="src-url" name="url" type="url" required placeholder="https://overseas-sales.mock.example/feed.xml" />
          <label htmlFor="src-label">이름(선택)</label>
          <input id="src-label" name="label" type="text" maxLength={100} />
          <button type="submit">소스 추가(꺼진 상태로)</button>
        </form>
      </section>

      <section className="card archive" aria-labelledby="sources-title">
        <h3 id="sources-title">소스</h3>
        {sources.length ? (
          <ul className="list">
            {sources.map((s) => (
              <li key={s.id} className="capture">
                <p className="capture-text">
                  {s.label ?? s.host} <span className="tag">{COLLECTOR_KIND_LABEL[s.kind as CollectorSourceKind] ?? s.kind}</span>
                  <span className={s.enabled ? 'tag warn' : 'tag'}>{s.enabled ? '켜짐' : '꺼짐'}</span>
                  <span className="tag">{COLLECTOR_SCHEDULE_LABEL[s.schedule as CollectorSchedule] ?? s.schedule}</span>
                </p>
                <p className="meta">
                  <span className="hash">{s.url}</span>
                  {s.lastRunAt ? <span>마지막 실행 {formatMsk(s.lastRunAt)}</span> : <span>실행한 적 없음</span>}
                  <span>저장한 소재 {accepted.get(s.id) ?? 0}건</span>
                </p>
                <div className="actions">
                  <form className="form inline" method="post" action={`/api/collector/sources/${s.id}/settings`}>
                    <input type="hidden" name="enabled" value={s.enabled ? 'off' : 'on'} />
                    <button type="submit">{s.enabled ? '끄기' : '켜기'}</button>
                  </form>
                  <form className="form inline" method="post" action={`/api/collector/sources/${s.id}/settings`}>
                    <label htmlFor={`sch-${s.id}`}>주기</label>
                    <select id={`sch-${s.id}`} name="schedule" defaultValue={s.schedule}>
                      <option value="off">꺼짐(수동만)</option>
                      <option value="daily">매일</option>
                      <option value="weekly">매주</option>
                    </select>
                    <button type="submit">주기 저장</button>
                  </form>
                  <form className="form inline" method="post" action={`/api/collector/sources/${s.id}/run`}>
                    <button type="submit" disabled={!readiness.canRun || !s.enabled}>
                      지금 수집(모의)
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">등록한 소스가 없습니다.</p>
        )}
      </section>

      <section className="card archive" aria-labelledby="runs-title">
        <h3 id="runs-title">실행 기록</h3>
        {runs.length ? (
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">시각</th>
                  <th scope="col">소스</th>
                  <th scope="col">방식</th>
                  <th scope="col">상태</th>
                  <th scope="col">판정</th>
                  <th scope="col">결과</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/collect/runs/${r.id}`}>{formatMsk(r.createdAt)}</Link>
                    </td>
                    <td>{sourceName.get(r.sourceId) ?? '—'}</td>
                    <td>{r.trigger === 'manual' ? '수동' : '주기'} · MOCK</td>
                    <td>
                      {COLLECTOR_RUN_STATUS_LABEL[r.status as CollectorRunStatus] ?? r.status}
                      {r.errorCode ? ` — ${runErrorText(r.errorCode)}` : ''}
                    </td>
                    <td>
                      새 {r.counts.new ?? 0} · 중복 {r.counts.duplicate ?? 0} · 건너뜀 {r.counts.skipped ?? 0}
                    </td>
                    <td>{r.result ? `저장 ${r.result.accepted ?? 0} · 바뀜 ${r.result.failed_changed ?? 0}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">아직 실행 기록이 없습니다.</p>
        )}
      </section>
    </main>
  );
}
