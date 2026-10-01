import Link from 'next/link';
import { redirect } from 'next/navigation';
import { opsSnapshot, planRetention, type DirUsage } from '@cs/db';
import {
  CHANNEL_LABEL,
  describeModes,
  formatAgeHours,
  formatByteSize,
  formatMsk,
  liveLlmReadiness,
  sttLiveReadiness,
  type Channel,
} from '@cs/domain';
import { getSession } from '../../lib/auth';
import { exportsDir } from '../../lib/backup';
import { OPS_ERROR_TEXT } from '../../lib/ops';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

function Usage({ label, u }: { label: string; u: DirUsage | null }) {
  return (
    <li>
      {label}:{' '}
      {u === null
        ? '측정 없음(메모리 DB — 파일이 없음)'
        : !u.present
          ? `측정 없음(폴더 없음${u.errors ? ' 또는 읽을 수 없음' : ''})`
          : u.status === 'unavailable'
            ? '측정 불가(폴더를 읽지 못함)'
            : `${formatByteSize(u.bytes)} · 파일 ${u.files}개${
                u.status === 'partial' ? ` — 하한값(일부 측정 실패${u.errors ? ` ${u.errors}건` : ''}${u.truncated ? ', 항목이 많아 세다가 멈춤' : ''})` : ''
              }`}
    </li>
  );
}

/**
 * 운영(T20, 결정 D22) — owner 전용, 읽기 전용(버튼 둘: 복원 훈련 실행, 보존 정리 적용). 모든 숫자는 DB 행·파일에서 센다.
 * 판정 배지("정상"·"안전")는 만들지 않는다. 원천이 없으면 "측정 없음". 외부 알림(이메일·메시지)은 없다 — 이 화면이 알림이다.
 */
export default async function OpsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const q = await searchParams;
  const config = getConfig();
  const { db } = await getAppDb(config);
  const now = new Date();
  const s = await opsSnapshot(db, session.ownerId, config, now);
  const plan = await planRetention(db, session.ownerId, config, exportsDir(config), now);
  const err = str(q.error) ? (OPS_ERROR_TEXT[str(q.error)!] ?? OPS_ERROR_TEXT.server) : undefined;
  const live = liveLlmReadiness(config);
  const sttLive = sttLiveReadiness(config);
  const drill = s.backup.lastDrill;
  const drillMismatches = (drill?.mismatchJson ?? []) as Array<{ kind?: string; table?: string; sample_ids?: string[]; columns?: string[] }>;
  const more = (l: { total: number; items: unknown[]; truncated: boolean }) => (l.truncated ? ` (전체 ${l.total}개 중 ${l.items.length}개 표시)` : '');
  const states = Object.entries(s.jobs.byState);
  const planEmpty = plan.jobEvents.events === 0 && plan.packages.length === 0 && plan.exports.length === 0;

  return (
    <main className="container">
      <h2 className="screen-title">운영</h2>
      <p className="note">
        측정 시각 {formatMsk(s.measuredAt)}. 숫자는 모두 이 앱의 DB 기록과 파일에서 센 값입니다. 기록이 없으면 &quot;측정 없음&quot;으로 표시하며, 외부
        알림(이메일·메시지)은 보내지 않습니다.
      </p>
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}

      <section className="card archive" id="backup" aria-labelledby="backup-title">
        <h3 id="backup-title">백업·복원 훈련</h3>
        {s.backup.lastExport ? (
          <p className={s.backup.state === 'stale' ? 'notice' : 'meta'} role={s.backup.state === 'stale' ? 'alert' : undefined}>
            마지막 내보내기: {formatMsk(s.backup.lastExport.at)} ({formatAgeHours(s.backup.lastExport.ageHours)}) · {formatByteSize(s.backup.lastExport.zipBytes)}
            {s.backup.state === 'stale'
              ? ` — 경고: 기준 ${s.backup.maxAgeHours}시간보다 오래되었습니다. 설정에서 새로 내보내세요.`
              : ` — 기준 ${s.backup.maxAgeHours}시간 이내`}
          </p>
        ) : (
          <p className="notice" role="alert">
            내보내기 기록이 없습니다 — 백업 나이를 잴 수 없습니다. 설정에서 내보내기를 만드세요.
          </p>
        )}
        {drill ? (
          <>
            <p className={drill.result === 'pass' ? 'meta' : 'notice'} role={drill.result === 'pass' ? undefined : 'alert'}>
              마지막 복원 훈련: {formatMsk(drill.startedAt)} · 결과 {drill.result === 'pass' ? 'PASS(빈 메모리 DB 복원이 원본 묶음 — 복원 규칙 적용 — 과 일치)' : `FAIL${drill.errorCode ? `(${drill.errorCode})` : ''}`} · 표{' '}
              {drill.tablesCompared}개 · 행 {drill.rowsCompared}개 · 파일 {drill.assetsCompared}개 · 실행 {drill.trigger === 'cli' ? 'CLI' : drill.trigger === 'api' ? '화면' : drill.trigger}
            </p>
            {drillMismatches.length ? (
              <ul className="list">
                {drillMismatches.slice(0, 20).map((m, i) => (
                  <li key={i}>
                    {m.kind}
                    {m.table ? ` · ${m.table}` : ''}
                    {m.columns?.length ? ` · 열 ${m.columns.join(', ')}` : ''}
                    {m.sample_ids?.length ? ` · ${m.sample_ids.join(', ')}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
            {str(q.drill) === drill.id ? (
              <p className="saved" role="status">
                방금 실행한 복원 훈련 결과입니다.
              </p>
            ) : null}
          </>
        ) : (
          <p className="notice">복원 훈련 기록이 없습니다 — 복원이 되는지 아직 확인하지 않았습니다.</p>
        )}
        <form className="form inline" method="post" action="/api/ops/restore-drill">
          <button type="submit">복원 훈련 실행(임시 내보내기 → 빈 메모리 DB 에 복원 → 비교)</button>
        </form>
        <p className="note">
          훈련용 묶음은 내보내기 기록에 남지 않고 끝나면 지웁니다(백업으로 세지 않음). 운영 DB 는 읽기만 합니다. 서버를 끈 상태에서는{' '}
          <code>pnpm drill:restore</code> 로도 실행할 수 있습니다. <Link href="/settings">설정 — 내보내기·복원</Link>
        </p>
      </section>

      <section className="card archive" aria-labelledby="jobs-title">
        <h3 id="jobs-title">배포 작업(MOCK)</h3>
        {states.length ? (
          <p className="meta">
            {states.map(([k, n]) => (
              <span key={k} className="tag">
                {k} {n}
              </span>
            ))}
          </p>
        ) : (
          <p className="empty-text">배포 작업 기록이 없습니다.</p>
        )}
        <ul className="list">
          <li>처리할 때가 지난 대기(QUEUED) 중 가장 오래 기다린 작업: {s.jobs.oldestQueuedHours === null ? '없음' : formatAgeHours(s.jobs.oldestQueuedHours)}</li>
          <li>재시도 대기(RETRY_WAIT) 다음 시각: {s.jobs.nextRetryAt ? formatMsk(s.jobs.nextRetryAt) : '없음'}</li>
          <li>
            지난 7일 실패(거부·결과 불명) 3회 이상 항목: {s.jobs.repeatedFailures.total}개{more(s.jobs.repeatedFailures)}
            {s.jobs.repeatedFailures.items.length ? (
              <ul>
                {s.jobs.repeatedFailures.items.map((f) => (
                  <li key={f.itemId}>
                    {f.planId ? <Link href={`/distribute/${f.planId}`}>{f.itemId.slice(0, 8)}</Link> : f.itemId.slice(0, 8)} · {f.failures}회
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        </ul>
        <h4>
          확인이 필요한 작업(RECONCILING·UNKNOWN·BLOCKED) {s.jobs.attention.total}개{more(s.jobs.attention)}
        </h4>
        {s.jobs.attention.items.length ? (
          <ul className="list">
            {s.jobs.attention.items.map((j) => (
              <li key={j.jobId}>
                {j.planId ? <Link href={`/distribute/${j.planId}`}>{j.state}</Link> : j.state}
                {j.channel ? ` · ${CHANNEL_LABEL[j.channel as Channel] ?? j.channel}` : ''}
                {j.lastErrorCode ? ` · ${j.lastErrorCode}` : ''} · 마지막 변경 {formatMsk(j.updatedAt)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">없음</p>
        )}
        <h4>
          확인 필요 계획 {s.jobs.attentionPlans.total}개{more(s.jobs.attentionPlans)}
        </h4>
        {s.jobs.attentionPlans.items.length ? (
          <ul className="list">
            {s.jobs.attentionPlans.items.map((p) => (
              <li key={p.id}>
                <Link href={`/distribute/${p.id}`}>{p.targetSummary || '배포 계획'}</Link> · {formatMsk(p.updatedAt)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">없음</p>
        )}
        <p className="meta">
          <span>
            전송 의도(결과 대기): {s.intents.pending}개{s.intents.oldestPendingAt ? ` · 가장 오래된 것 ${formatMsk(s.intents.oldestPendingAt)}` : ''}
          </span>
          <span>
            파일 삭제 대기: {s.pendingDeletes.count}개{s.pendingDeletes.oldestAt ? ` · 가장 오래된 것 ${formatMsk(s.pendingDeletes.oldestAt)}` : ''}
          </span>
        </p>
      </section>

      <section className="card archive" aria-labelledby="disk-title">
        <h3 id="disk-title">용량</h3>
        <p className="note">측정 시각 {formatMsk(s.disk.measuredAt)}(60초 동안 같은 측정값을 씁니다).</p>
        <ul className="list">
          <Usage label="DB 데이터 폴더" u={s.disk.db} />
          <Usage label="파일 저장소(업로드 조각 제외)" u={s.disk.assets} />
          <Usage label="업로드 조각" u={s.disk.uploads} />
          <Usage label="내보내기 ZIP·폴더" u={s.disk.exports} />
          <Usage label="배포 파일(수동 게시용)" u={s.disk.packages} />
          <Usage label="보존 정리 보관 파일(JSONL)" u={s.disk.retention} />
        </ul>
        <p className="meta">
          <span>만료된 업로드 세션 {s.uploads.expiredSessions}개</span>
          <span>만료 시각이 지났지만 아직 정리 전 {s.uploads.openPastExpiry}개</span>
        </p>
      </section>

      <section className="card archive" aria-labelledby="cost-title">
        <h3 id="cost-title">비용(이번 달, MSK)</h3>
        <p className="meta">
          월 상한: {s.cost.monthlyLimit ? `${s.cost.monthlyLimit} ${s.cost.currency}` : '미설정'} · 예약 초과 실행 {s.cost.overBudgetRuns}건
        </p>
        {s.cost.byCurrency.length ? (
          <ul className="list">
            {s.cost.byCurrency.map((u) => (
              <li key={u.currency}>
                {u.currency}: 사용 {u.used} · 초과액 {u.overage} · 실행 {u.runs}건{u.pending ? ` · 확정 전 ${u.pending}건` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">이번 달 사용 기록이 없습니다.</p>
        )}
      </section>

      <section className="card archive" aria-labelledby="modes-title">
        <h3 id="modes-title">모드</h3>
        <p className="meta">
          {describeModes(config).map((b) => (
            <span key={b.key} className={b.live ? 'tag warn' : 'tag'}>
              {b.label}
            </span>
          ))}
          <span className="tag">음성 전사: {config.STT_MODE === 'mock' ? '모의' : '실제'}</span>
          <span className="tag">작업 처리기: {config.WORKER_MODE}</span>
        </p>
        <p className="note">AI live 준비 안 됨: {live.missing.length ? live.missing.join(', ') : '없음'}</p>
        <p className="note">음성 전사 live 준비 안 됨: {sttLive.missing.length ? sttLive.missing.join(', ') : '없음'}</p>
      </section>

      <section className="card archive" id="retention" aria-labelledby="retention-title">
        <h3 id="retention-title">보존 정리</h3>
        <p className="note">
          정책: 끝난 배포 작업의 이력 {plan.policy.jobEventsDays}일(지우기 전 JSONL 로 보관) · 배포 파일 {plan.policy.packagesDays}일 · 내보내기 ZIP 최근{' '}
          {plan.policy.exportsKeep}개 · 업로드 세션 24시간(기존 자동 정리). 원문 소재·출처·원고 버전은 지우지 않습니다. 실행 방식:{' '}
          {config.RETENTION_SWEEP_MODE === 'auto' ? '자동(작업 처리기가 한 시간에 한 번)' : '수동(아래에서 확인 후 적용)'}.
        </p>
        {q.retention === 'applied' ? (
          <p className="saved" role="status">
            보존 정리를 적용했습니다. 아래 &quot;마지막 정리&quot;가 저장된 결과입니다.
          </p>
        ) : null}
        <p className="meta">
          마지막 정리:{' '}
          {s.lastRetention
            ? `${formatMsk(s.lastRetention.at)} · 이력 ${String(s.lastRetention.details.job_events_deleted ?? 0)}행 · 배포 파일 ${String(s.lastRetention.details.packages_deleted ?? 0)}개 · 내보내기 ${String(s.lastRetention.details.exports_deleted ?? 0)}개`
            : '기록 없음'}
        </p>
        <h4>지금 적용하면 지울 것(미리보기 — 아직 아무것도 지우지 않음)</h4>
        <ul className="list">
          <li>
            끝난 작업 이력: 작업 {plan.jobEvents.jobs}개 · 이력 {plan.jobEvents.events}행(마지막 이력이 {formatMsk(plan.cutoffs.jobEvents)} 이전)
          </li>
          <li>
            배포 파일: {plan.packages.length}개 · {formatByteSize(plan.packages.reduce((a, b) => a + b.bytes, 0))}
          </li>
          <li>
            내보내기 ZIP(최근 {plan.policy.exportsKeep}개 밖): {plan.exports.length}개 · {formatByteSize(plan.exports.reduce((a, b) => a + b.zipBytes, 0))}
            {plan.exports.length ? ` (가장 최근 것 ${formatMsk(plan.exports[0]!.createdAt)})` : ''} — 정상 백업 ZIP {plan.exportsExisting}개 기준, 가장 최근 1개는 항상 남김
          </li>
          {plan.exportsMissingFile.length ? (
            <li>
              파일 없음 기록(ZIP 이 없거나 손상 — 세지도 지우지도 않음): {plan.exportsMissingFile.length}개 · 가장 최근 것{' '}
              {formatMsk(plan.exportsMissingFile[0]!.createdAt)}
            </li>
          ) : null}
        </ul>
        {planEmpty ? (
          <p className="empty-text">지울 것이 없습니다.</p>
        ) : (
          <form className="form" method="post" action="/api/ops/retention">
            <label className="choice">
              <input type="checkbox" name="confirm" value="yes" />위 목록을 지워도 됩니다(이력은 먼저 JSONL 로 보관)
            </label>
            <button type="submit">보존 정리 적용</button>
          </form>
        )}
      </section>
    </main>
  );
}
