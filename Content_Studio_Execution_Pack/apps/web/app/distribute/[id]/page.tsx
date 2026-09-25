import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getPlanDetail, type PlanItemDetail } from '@cs/db';
import { CHANNEL_LABEL, formatMsk, type CanonicalPayload, type Channel } from '@cs/domain';
import { getSession } from '../../../lib/auth';
import {
  blockInfoOf,
  DISTRIBUTE_ERROR_TEXT,
  ITEM_STATUS_LABEL,
  itemHeadline,
  jobStatusText,
  MOCK_SCENARIO_OPTIONS,
  PLAN_STATUS_LABEL,
  problemLabel,
  RESULT_KIND_LABEL,
  revocationCountParam,
  revocationNotice,
  VISIBILITY_LABEL,
} from '../../../lib/distribution';
import { getAppDb, getConfig } from '../../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown) => (typeof v === 'string' ? v : '');

/** 채널에서 실제로 나갈 글(스냅샷의 text). */
function OutgoingText({ channel, text }: { channel: string; text: CanonicalPayload['text'] }) {
  switch (channel) {
    case 'threads':
      return (
        <ol>
          {arr(text.posts).map((p, i) => (
            <li key={i}>
              <pre className="raw-text">{s(p)}</pre>
            </li>
          ))}
        </ol>
      );
    case 'instagram':
      return (
        <>
          <p className="note">캡션</p>
          <pre className="raw-text">{s(text.caption)}</pre>
          <p className="note">카드</p>
          <ol>
            {arr(text.cards).map((c, i) => (
              <li key={i}>{s((c as { text?: unknown }).text)}</li>
            ))}
          </ol>
        </>
      );
    case 'youtube':
      return (
        <>
          <p>
            <strong>제목:</strong> {s(text.title)}
          </p>
          <p className="note">설명</p>
          <pre className="raw-text">{s(text.description)}</pre>
          <p className="note">태그: {arr(text.tags).map(s).join(', ') || '(없음)'}</p>
        </>
      );
    default:
      return (
        <>
          <p>
            <strong>제목:</strong> {s(text.title)}
          </p>
          <pre className="raw-text">{s(text.markdown)}</pre>
        </>
      );
  }
}

const FINISHED = ['CONFIRMED', 'CANCELED', 'FAILED'];

/** FIX-T12(P2): 표준 코드(승인 철회·무효 판단)와 상세 사유를 나눠 쓴다 — lib blockInfoOf. */
function blockInfoOfItem(x: PlanItemDetail) {
  return blockInfoOf(x.events, x.jobs.at(-1) ?? null);
}

/** T12: 개발용 모의 시나리오 선택(모의 계정·끝나지 않은 항목만). 승인 스냅샷 밖 — hash·승인 상태가 바뀌지 않는다. */
function ScenarioForm({ x }: { x: PlanItemDetail }) {
  if (x.account?.kind !== 'mock' || FINISHED.includes(x.item.status)) return null;
  const current = x.mockScenario?.scenario ?? '';
  return (
    <form className="form inline" method="post" action={`/api/distribution-items/${x.item.id}/mock-scenario`} aria-label="모의 시나리오">
      <input type="hidden" name="plan_id" value={x.item.planId} />
      <label>
        모의 시나리오 <span className="note">개발용 · 모의 결과 선택 (실제 채널 없음)</span>{' '}
        <select name="scenario" defaultValue={current || 'success'}>
          {MOCK_SCENARIO_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        지연(ms) <input type="number" name="delay_ms" min={0} max={5000} step={100} defaultValue={x.mockScenario?.delayMs ?? 0} />
      </label>
      <button type="submit">모의 시나리오 저장</button>
      <span className="note">{current ? `현재: ${current}` : '현재: 기본값(success)'}</span>
    </form>
  );
}

function ItemCard({ x, approvable }: { x: PlanItemDetail; approvable: boolean }) {
  const p = x.payload;
  const channel = x.variant?.channel ?? p.channel;
  const scheduled = x.item.scheduledAtUtc;
  const latest = x.jobs.at(-1) ?? null;
  const latestPub = latest ? (x.publications.find((q) => q.jobId === latest.id) ?? x.publications.at(-1) ?? null) : (x.publications.at(-1) ?? null);
  const block = blockInfoOfItem(x);
  const headline = itemHeadline({
    status: x.item.status,
    channel,
    job: latest,
    pub: latestPub,
    blockReason: block.code,
    blockDetail: block.detail,
    activeApproval: x.activeApproval !== null,
    needsNewPlan: x.problems.length > 0,
  });
  const retryable = x.item.status === 'BLOCKED' && latest?.state === 'BLOCKED' && x.activeApproval !== null;
  return (
    <section className="card archive" aria-label={`${CHANNEL_LABEL[channel as Channel] ?? channel} 항목`}>
      <h3>
        {CHANNEL_LABEL[channel as Channel] ?? channel} — {x.account?.displayName ?? '(계정 없음)'}{' '}
        {x.account?.kind === 'mock' ? <span className="tag warn">MOCK</span> : null}
      </h3>
      <p className="status-line" role="status">
        <strong>{headline}</strong>
        {x.item.status === 'CONFIRMED' ? (
          <>
            {' '}
            <span className="tag warn">MOCK</span> <strong>실제 발행 실적 아님</strong>
          </>
        ) : null}
      </p>
      <p className="meta">
        <span className="tag">{ITEM_STATUS_LABEL[x.item.status] ?? x.item.status}</span>
        {x.item.restoredNeedsReview ? <span className="tag warn">복원됨 — 자동 실행·재시도 안 함, 결과 확인 필요</span> : null}
        <span>공개 범위: {VISIBILITY_LABEL[x.item.visibility] ?? x.item.visibility}</span>
        <span>
          일정: {scheduled ? `${formatMsk(scheduled)} (UTC ${scheduled.toISOString()})` : '즉시(실행 후 대기열)'}
        </span>
        <span>요청 결과: {x.item.requestedResult === 'mock_publish' ? 'MOCK 실행(실제 게시 아님)' : x.item.requestedResult}</span>
        {x.activeApproval ? <span className="tag">승인됨</span> : null}
      </p>
      {x.problems.length ? (
        <p className="notice" role="alert">
          스냅샷이 지금과 다릅니다 — 승인·실행할 수 없습니다(새 계획 필요): {x.problems.map(problemLabel).join(', ')}
        </p>
      ) : null}
      <h4>나갈 내용</h4>
      <OutgoingText channel={channel} text={p.text} />
      <h4>미디어</h4>
      {p.assets.length ? (
        <ul className="list">
          {p.assets.map((a) => (
            <li key={a.id} className="hash">
              {a.order}. {a.role} · {a.id.slice(0, 8)} · {a.mime} · sha256 {a.checksum.slice(0, 12)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-text">첨부 없음</p>
      )}
      <p className="hash">payload hash: {x.item.payloadHash.slice(0, 16)}…</p>
      {approvable ? (
        <label className="choice">
          <input type="checkbox" name={`item_${x.item.id}`} form="approve-form" />이 항목 승인(선택)
        </label>
      ) : null}
      {x.approvals.length ? (
        <>
          <h4>승인 기록</h4>
          <ul className="list">
            {x.approvals.map((a) => (
              <li key={a.id}>
                {formatMsk(a.approvedAt)} 승인 · hash {a.payloadHash.slice(0, 12)}…{' '}
                {a.revokedAt ? (
                  <span className="tag warn">
                    철회됨 {formatMsk(a.revokedAt)} · {a.revokeReason}
                  </span>
                ) : (
                  <form className="form inline" method="post" action={`/api/approvals/${a.id}/revoke`}>
                    <input type="hidden" name="plan_id" value={x.item.planId} />
                    <input type="text" name="reason" maxLength={200} placeholder="철회 이유(선택)" aria-label="철회 이유" />
                    <button type="submit">철회</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {x.jobs.length ? (
        <>
          <h4>작업(MOCK — 모의 어댑터)</h4>
          <ul className="list">
            {x.jobs.map((j) => {
              const pub = x.publications.find((p) => p.jobId === j.id) ?? null;
              const reason = block.code;
              return (
                <li key={j.id} className="hash">
                  <strong>{jobStatusText(j, pub, reason)}</strong> · 시도 {j.attempt}/{j.maxAttempts}
                  {j.state === 'QUEUED' ? ` · 예정 ${formatMsk(j.nextRunAt)}` : ''}
                  {j.cancelRequestedAt && j.state === 'CONFIRMED' ? ' · 취소 불가(이미 전송됨)' : ''} · <a href={`/api/jobs/${j.id}`}>작업 JSON</a>
                </li>
              );
            })}
          </ul>
          <div className="actions">
            {['QUEUED', 'RETRY_WAIT', 'BLOCKED', 'SENDING', 'REMOTE_PROCESSING', 'RECONCILING', 'CANCEL_REQUESTED'].includes(x.jobs.at(-1)?.state ?? '') &&
            x.item.status !== 'PLANNED' ? (
              <form className="form inline" method="post" action={`/api/distribution-items/${x.item.id}/cancel`}>
                <input type="hidden" name="plan_id" value={x.item.planId} />
                <button type="submit">취소</button>
              </form>
            ) : null}
            {retryable ? (
              <form className="form inline" method="post" action={`/api/distribution-items/${x.item.id}/retry`}>
                <input type="hidden" name="plan_id" value={x.item.planId} />
                <button type="submit">재시도</button>
              </form>
            ) : null}
            {['RECONCILING', 'UNKNOWN', 'REMOTE_PROCESSING'].includes(x.jobs.at(-1)?.state ?? '') ? (
              <form className="form inline" method="post" action={`/api/distribution-items/${x.item.id}/reconcile`}>
                <input type="hidden" name="plan_id" value={x.item.planId} />
                <button type="submit">재확인(조회만 — 다시 보내지 않음)</button>
              </form>
            ) : null}
          </div>
          <p className="note">취소는 아직 보내지 않은 작업만 바로 확정됩니다. 전송 중이면 &quot;취소 확인 중&quot;으로 남고, 원격이 이미 받았으면 취소할 수 없습니다.</p>
          {retryable ? <p className="note">재시도는 보류된 같은 작업을 다시 대기열에 넣습니다(승인·내용이 그대로일 때만, 새 시도·새 전송 의도). 성공한 다른 채널은 다시 보내지 않습니다.</p> : null}
        </>
      ) : null}
      <ScenarioForm x={x} />
      {x.publications.length ? (
        <>
          <h4>원격 결과</h4>
          <ul className="list">
            {x.publications.map((p) => (
              <li key={p.id}>
                {p.isMock ? <span className="tag warn">MOCK</span> : null} {RESULT_KIND_LABEL[p.resultKind] ?? p.resultKind} · 원격 공개 범위 {p.remoteVisibility} · 확인{' '}
                {p.verification} · <span className="hash">{p.externalId}</span>
                {p.permalink ? <span className="hash"> · {p.permalink}</span> : null}
                {p.isMock ? <strong> — 실제 발행 실적 아님</strong> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {x.events.length ? (
        <details>
          <summary>작업 이력(최근 {x.events.length}개)</summary>
          <ol className="list">
            {x.events.map((e) => {
              const d = e.sanitizedDetails as Record<string, unknown>;
              return (
                <li key={e.id} className="hash">
                  #{e.eventSeq} {formatMsk(e.at)} · {e.stateBefore ?? '—'} → {e.stateAfter} · {String(d.event ?? '')}
                  {d.reason ? ` · ${String(d.reason)}` : ''}
                  {d.error_code ? ` · ${String(d.error_code)}` : ''}
                  {typeof d.attempt === 'number' ? ` · 시도 ${d.attempt}` : ''}
                </li>
              );
            })}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

/**
 * 배포 계획 상세(T10): 항목마다 "정확히 무엇이 나가는지"(계정·채널·글·미디어 checksum·공개 범위·일정·hash)를 보여 주고,
 * 항목별 체크(기본 해제) + "내용을 확인했습니다" + 선택 승인, 승인 철회, 지금 실행(MOCK — 대기열만).
 */
export default async function PlanPage({
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
  const d = await getPlanDetail(db, session.ownerId, id.toLowerCase());
  if (!d) notFound();
  const approvable = d.items.filter((x) => x.item.status === 'PLANNED' && !x.activeApproval && x.problems.length === 0);
  const executable = d.items.some((x) => x.item.status === 'PLANNED' && x.activeApproval);
  const purpose = approvable[0]?.item.requestedResult ?? 'mock_publish';
  const err = str(q.error) ? (DISTRIBUTE_ERROR_TEXT[str(q.error)!] ?? DISTRIBUTE_ERROR_TEXT.server) : undefined;
  const approved = Number(str(q.approved) ?? 0);
  const executed = str(q.executed);

  return (
    <main className="container">
      <h2 className="screen-title">배포 계획 — {d.plan.targetSummary || '이름 없음'}</h2>
      <p className="meta">
        <span className="tag warn">MOCK</span>
        <span className="tag">{PLAN_STATUS_LABEL[d.plan.status] ?? d.plan.status}</span>
        <time dateTime={d.plan.createdAt.toISOString()}>만든 시각 {formatMsk(d.plan.createdAt)}</time>
        <Link href="/distribute">배포함</Link>
      </p>
      <p className="notice" role="note">
        MOCK — 모의 계정입니다. 승인·실행해도 실제 채널로 아무것도 보내지 않습니다. 실행하면 작업 대기열(QUEUED)에 들어가고, 작업 처리기가 모의 어댑터로
        처리합니다. 확인된 결과도 MOCK 이며 실제 발행 실적이 아닙니다.
      </p>
      {q.created === '1' ? (
        <p className="saved" role="status">
          배포 계획을 만들었습니다(MOCK — 아직 승인 전). 아래 내용을 확인한 뒤 승인할 항목을 고르세요.
        </p>
      ) : null}
      {approved > 0 ? (
        <p className="saved" role="status">
          {approved}개 항목을 승인했습니다(MOCK 계정 — 실제 게시 아님).
        </p>
      ) : null}
      {executed ? (
        <p className="saved" role="status">
          MOCK 실행: {executed}개 항목을 작업 대기열에 넣었습니다{q.replay === '1' ? '(같은 실행 요청 — 기존 결과)' : ''}. 실제 게시 아님 — 아래 &quot;작업 처리 실행(모의 1회)&quot;을 누르거나 작업 처리기가 처리합니다.
        </p>
      ) : null}
      {q.revoked === '1' ? (
        <p className="saved" role="status">
          {revocationNotice(revocationCountParam(q.revoked_blocked), revocationCountParam(q.revoked_cancel))}
        </p>
      ) : null}
      {str(q.ticked) !== undefined ? (
        <p className="saved" role="status">
          작업 처리기(모의)를 한 번 실행했습니다: 작업 {Number(str(q.ticked) ?? 0)}개 처리. 외부로 아무것도 보내지 않았습니다(MOCK).
        </p>
      ) : null}
      {q.canceled === '1' ? (
        <p className="saved" role="status">
          취소했습니다(아직 보내지 않은 작업).
        </p>
      ) : null}
      {q.cancel_requested === '1' ? (
        <p className="notice" role="status">
          취소 확인 중 — 이미 전송 단계에 들어간 작업입니다. 원격 결과를 확인한 뒤 취소됨 또는 &quot;취소 불가(이미 전송됨)&quot;으로 표시됩니다.
        </p>
      ) : null}
      {q.retried === '1' ? (
        <p className="saved" role="status">
          보류된 작업을 다시 대기열에 넣었습니다(MOCK — 새 시도). &quot;작업 처리 실행(모의 1회)&quot;을 누르면 처리합니다.
        </p>
      ) : null}
      {q.scenario_saved === '1' ? (
        <p className="saved" role="status">
          모의 시나리오를 저장했습니다(개발용 · 실제 채널 없음). 승인·배포 내용(hash)은 바뀌지 않습니다.
        </p>
      ) : null}
      {str(q.reconciled) ? (
        <p className="saved" role="status">
          재확인(조회만): {q.reconciled === 'found' ? '원격에서 결과를 찾았습니다(MOCK — 실제 발행 실적 아님).' : '원격에서 결과를 찾지 못했습니다. 상태는 그대로이며 다시 보내지 않았습니다.'}
        </p>
      ) : null}
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}

      {d.items.map((x) => (
        <ItemCard key={x.item.id} x={x} approvable={approvable.some((a) => a.item.id === x.item.id)} />
      ))}

      <section className="card archive" aria-labelledby="approve-title">
        <h3 id="approve-title">선택 승인</h3>
        {approvable.length ? (
          <form id="approve-form" className="form" method="post" action={`/api/distribution-plans/${d.plan.id}/approve`}>
            {approvable.map((x) => (
              <input key={x.item.id} type="hidden" name={`hash_${x.item.id}`} value={x.item.payloadHash} />
            ))}
            <input type="hidden" name="purpose" value={purpose} />
            <p className="note">위 항목 카드에서 승인할 항목을 직접 고르세요(기본 선택 없음). 고른 항목의 위 내용 그대로(hash)만 승인됩니다.</p>
            <label className="choice">
              <input type="checkbox" name="confirm" value="yes" />
              내용을 확인했습니다
            </label>
            <button type="submit">선택 승인</button>
          </form>
        ) : (
          <p className="empty-text">승인할 수 있는 항목이 없습니다.</p>
        )}
      </section>

      <section className="card archive" aria-labelledby="execute-title">
        <h3 id="execute-title">실행(MOCK)</h3>
        <form className="form inline" method="post" action={`/api/distribution-plans/${d.plan.id}/execute`}>
          <input type="hidden" name="command_key" value={randomUUID()} />
          <button type="submit" disabled={!executable}>
            지금 실행(MOCK — 대기열에 넣기)
          </button>
        </form>
        <p className="note">승인된 항목만 대기열에 들어갑니다. 두 번 눌러도 작업은 하나만 생깁니다.</p>
        <form className="form inline" method="post" action="/api/worker/tick">
          <input type="hidden" name="plan_id" value={d.plan.id} />
          <input type="hidden" name="max_jobs" value="5" />
          <button type="submit">작업 처리 실행(모의 1회)</button>
        </form>
        <p className="note">작업 처리기를 한 번 돌립니다(내 작업 최대 5개, 모의 어댑터 — 외부 호출 없음). 재시도 대기 작업은 다음 시각이 되어야 처리됩니다.</p>
      </section>
    </main>
  );
}
