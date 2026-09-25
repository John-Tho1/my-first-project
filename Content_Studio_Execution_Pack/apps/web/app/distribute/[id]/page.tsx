import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getPlanDetail, type PlanItemDetail } from '@cs/db';
import { CHANNEL_LABEL, formatMsk, type CanonicalPayload, type Channel } from '@cs/domain';
import { getSession } from '../../../lib/auth';
import { DISTRIBUTE_ERROR_TEXT, ITEM_STATUS_LABEL, PLAN_STATUS_LABEL, problemLabel, VISIBILITY_LABEL } from '../../../lib/distribution';
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

function ItemCard({ x, approvable }: { x: PlanItemDetail; approvable: boolean }) {
  const p = x.payload;
  const channel = x.variant?.channel ?? p.channel;
  const scheduled = x.item.scheduledAtUtc;
  return (
    <section className="card archive" aria-label={`${CHANNEL_LABEL[channel as Channel] ?? channel} 항목`}>
      <h3>
        {CHANNEL_LABEL[channel as Channel] ?? channel} — {x.account?.displayName ?? '(계정 없음)'}{' '}
        {x.account?.kind === 'mock' ? <span className="tag warn">MOCK</span> : null}
      </h3>
      <p className="meta">
        <span className="tag">{ITEM_STATUS_LABEL[x.item.status] ?? x.item.status}</span>
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
          <h4>작업</h4>
          <ul className="list">
            {x.jobs.map((j) => (
              <li key={j.id} className="hash">
                {j.state} · MOCK · T11에서 처리 · 예정 {formatMsk(j.nextRunAt)}
              </li>
            ))}
          </ul>
        </>
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
        MOCK — 모의 계정입니다. 승인·실행해도 실제 채널로 아무것도 보내지 않습니다. 실행은 작업 대기열(QUEUED)에 넣기까지이며 처리는 T11 작업 처리기가 합니다.
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
          MOCK 실행: {executed}개 항목을 작업 대기열에 넣었습니다{q.replay === '1' ? '(같은 실행 요청 — 기존 결과)' : ''}. 실제 게시 아님 — T11 작업 처리기가 처리합니다.
        </p>
      ) : null}
      {q.revoked === '1' ? (
        <p className="saved" role="status">
          승인을 철회했습니다(MOCK). 대기 중이던 작업은 보류(BLOCKED)되었습니다.
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
      </section>
    </main>
  );
}
