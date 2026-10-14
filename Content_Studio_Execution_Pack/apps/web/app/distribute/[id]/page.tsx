import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getPlanDetail, type PlanItemDetail } from '@cs/db';
import {
  adapterIdFor,
  CHANNEL_LABEL,
  formatMsk,
  LIVE_THREADS_VISIBILITY_TEXT,
  providerMetadataOf,
  USER_CONFIRM_BUTTON,
  USER_CONFIRM_WARNING,
  type AdapterId,
  type CanonicalPayload,
  type Channel,
} from '@cs/domain';
import { getSession } from '../../../lib/auth';
import {
  bannersFromState,
  blockInfoOf,
  DISTRIBUTE_ERROR_TEXT,
  instagramProgressLine,
  instagramStepLine,
  ITEM_STATUS_LABEL,
  itemHeadline,
  jobStatusText,
  LIVE_CANDIDATE_LABEL,
  LIVE_UNKNOWN_GUIDANCE,
  latestThreadsDiag,
  liveCandidateForCard,
  liveItemHeadline,
  liveStepLine,
  liveVerificationLabel,
  liveVerificationTag,
  mockScenarioOptionsFor,
  PLAN_STATUS_LABEL,
  problemLabel,
  publishAtView,
  reconciledNotice,
  remoteStepLine,
  REQUESTED_RESULT_LABEL,
  RESULT_KIND_LABEL,
  revocationCountParam,
  revocationNotice,
  stepsPanelView,
  USER_CONFIRMED_NOTICE,
  userConfirmCandidateForCard,
  VISIBILITY_LABEL,
  YOUTUBE_STEP_LABEL,
  youtubeProgressLine,
  youtubeSessionNote,
} from '../../../lib/distribution';
import { getAppDb, getConfig, getStorage } from '../../../lib/server';

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

/** T14(D26): 항목의 어댑터(선택 규칙 @cs/domain adapterIdFor 한 곳). */
function adapterOf(x: PlanItemDetail): AdapterId | null {
  if (!x.account) return null;
  return adapterIdFor({ kind: x.account.kind === 'mock' ? 'mock' : 'live', platform: x.account.platform, credential_state: x.account.credentialState });
}

/**
 * M4 화면 FIX(S1): 단계 패널은 가장 최근 전송 의도에 기록된 어댑터로 고른다(lib stepsPanelView — 전송 의도가 없을 때만 현재 선택).
 * 일반 모의 어댑터로 처리된 항목은 "진행 예정" 대신 "일반 모의 어댑터로 처리됨" 한 줄.
 */
function StepsPanel({ x }: { x: PlanItemDetail }) {
  const v = stepsPanelView({
    currentAdapter: adapterOf(x),
    latestIntent: x.latestIntent,
    platform: x.account?.platform ?? null,
    remoteStepKinds: x.remoteSteps.map((r) => r.kind),
  });
  if (!v.panel) return null;
  if (v.panel === 'live_threads') return <LiveThreadsSteps x={x} />;
  if (v.note) {
    return (
      <>
        <h4>{v.panel === 'threads' ? 'Threads 단계' : v.panel === 'instagram' ? 'Instagram 단계' : 'YouTube 업로드'}(MOCK)</h4>
        <p className="empty-text">
          <span className="tag warn">MOCK</span> {v.note}
        </p>
      </>
    );
  }
  if (v.panel === 'instagram') return <InstagramSteps x={x} />;
  return v.panel === 'threads' ? <ThreadsSteps x={x} /> : <YouTubeSteps x={x} />;
}

/**
 * T16(D29 제안): Instagram 모의 단계(컨테이너 n/m 준비 · 게시 · 모의 링크)와 T13 연결 상태 한 줄. 공개 미디어 URL 은 단계·화면에 없다
 * (모의 원격이 컨테이너를 만들 때만 쓰고 바로 철회). 컨테이너·미디어 ID 는 모의 ID(mockig_…)만.
 */
function InstagramSteps({ x }: { x: PlanItemDetail }) {
  const images = x.payload.assets.filter((a) => a.role === 'image').length;
  const latest = x.jobs.at(-1) ?? null;
  const steps = latest ? x.remoteSteps.filter((r) => r.jobId === latest.id) : [];
  const containers = steps.filter((r) => r.kind === 'ig_container');
  const published = steps.some((r) => r.kind === 'ig_publish');
  const pub = latest ? (x.publications.find((p) => p.jobId === latest.id) ?? null) : null;
  return (
    <>
      <h4>Instagram 단계(MOCK — 모의 Instagram, 모의 ID)</h4>
      {x.connection ? (
        <p className="meta" role="status">
          <span className="tag warn">MOCK</span> 계정 연결(모의): <strong>{x.connection.status_label}</strong>
          {x.connection.usable_for_execution ? '' : ' — 실행 차단(설정 → 배포 계정 연결에서 다시 연결)'}
        </p>
      ) : null}
      <p className="status-line" role="status">
        {images > 1 ? `캐러셀 이미지 ${images}개` : '이미지 1개'} ·{' '}
        {instagramProgressLine({
          images,
          finished: containers.filter((r) => r.status === 'finished').length,
          created: containers.length,
          published,
        })}
      </p>
      {steps.length ? (
        <ol className="list">
          {[...steps]
            .sort((a, b) => a.stepIndex - b.stepIndex)
            .map((st) => (
              <li key={st.id} className="hash">
                {instagramStepLine({ kind: st.kind, status: st.status, postIndex: st.postIndex, remoteId: st.remoteId }, images)}
              </li>
            ))}
        </ol>
      ) : (
        <p className="empty-text">
          아직 원격 단계 없음({images > 1 ? '캐러셀: 이미지 컨테이너 → 부모 컨테이너 → 게시' : '이미지 컨테이너 → 게시'} 순서로 진행, 보내기 직전에 이미지 규격(잠정)을 다시 확인)
        </p>
      )}
      {pub?.permalink ? <p className="note">모의 링크: {pub.permalink} (실제 Instagram 주소가 아님)</p> : null}
      <p className="note">
        컨테이너·미디어 ID 는 모의 ID 입니다(mockig_…). 이미지는 모의 공개 URL(mock://public-media/…)로만 모의 원격에 전달되고 바로 철회됩니다 — 실제로 공개된
        파일은 없습니다. 실제 Instagram 으로 아무것도 보내지 않았고 실제 발행 실적이 아닙니다.
      </p>
    </>
  );
}

/**
 * LIVE-P1(D38): 실제 Threads 게시 단계(컨테이너 → 게시 시도 → 게시, 실제 ID)와 연결 상태 한 줄. MOCK 문구·모의 ID 안내를 쓰지 않는다.
 * 게시 시도 표식이 있으면 이 컨테이너로는 다시 게시하지 않는다(결과 불명이면 조회만).
 */
function LiveThreadsSteps({ x }: { x: PlanItemDetail }) {
  const latest = x.jobs.at(-1) ?? null;
  const steps = latest ? x.remoteSteps.filter((r) => r.jobId === latest.id) : [];
  return (
    <>
      <h4>
        Threads 실제 게시 단계 <span className="tag warn">실제 게시</span>
      </h4>
      {x.connection ? (
        <p className="meta" role="status">
          계정 연결(실제): <strong>{x.connection.status_label}</strong>
          {x.connection.usable_for_execution ? '' : ' — 실행 차단(설정 → 배포 계정 연결에서 다시 연결)'}
        </p>
      ) : null}
      {steps.length ? (
        <ol className="list">
          {[...steps]
            .sort((a, b) => a.stepIndex - b.stepIndex)
            .map((st) => (
              <li key={st.id} className="hash">
                {liveStepLine({ kind: st.kind, status: st.status, remoteId: st.remoteId })}
              </li>
            ))}
        </ol>
      ) : (
        <p className="empty-text">아직 원격 단계 없음(실행하면 컨테이너 생성 → 준비 확인 → 게시 순서로 진행, 텍스트 1개)</p>
      )}
      <p className="note">
        실제 Threads ID 입니다. 공개 범위: {LIVE_THREADS_VISIBILITY_TEXT}. 결과를 모르는 게시 시도는 자동으로 다시 게시하지 않고 결과 불명(UNKNOWN)으로 남깁니다 — 최근 글
        목록에서 같은 본문이 보여도 확인이 아니라 &quot;확인 후보(미확인)&quot;로만 보이니 Threads 에서 직접 확인하세요.
      </p>
    </>
  );
}

/** T14: Threads 모의 단계(게시물 n/m · 컨테이너 생성됨/게시됨/오류 · 모의 ID)와 T13 연결 상태 한 줄. */
function ThreadsSteps({ x }: { x: PlanItemDetail }) {
  const total = Array.isArray(x.payload.text.posts) ? x.payload.text.posts.length : 0;
  const latest = x.jobs.at(-1) ?? null;
  const steps = latest ? x.remoteSteps.filter((r) => r.jobId === latest.id) : [];
  return (
    <>
      <h4>Threads 단계(MOCK — 모의 Threads, 모의 ID)</h4>
      {x.connection ? (
        <p className="meta" role="status">
          <span className="tag warn">MOCK</span> 계정 연결(모의): <strong>{x.connection.status_label}</strong>
          {x.connection.usable_for_execution ? '' : ' — 실행 차단(설정 → 배포 계정 연결에서 다시 연결)'}
        </p>
      ) : null}
      {steps.length ? (
        <ol className="list">
          {steps.map((st) => (
            <li key={st.id} className="hash">
              {remoteStepLine({ kind: st.kind, status: st.status, postIndex: st.postIndex, remoteId: st.remoteId }, total)}
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-text">아직 원격 단계 없음(게시물 {total}개 — 컨테이너 생성 → 게시 순서로 진행)</p>
      )}
      <p className="note">컨테이너·게시 ID 는 모의 ID 입니다(mockthr_…). 실제 Threads 로 아무것도 보내지 않았고 실제 발행 실적이 아닙니다.</p>
    </>
  );
}

/**
 * T15(D27): YouTube 모의 재개 업로드 진행(업로드 n% (x/y MB) · 세션 재개 n회)·처리 상태와 T13 연결 상태 한 줄.
 * 세션 URI 는 화면에 내지 않는다(`세션 있음`) — 영상 ID 는 모의 ID(mockyt_v_…)만.
 */
function YouTubeSteps({ x }: { x: PlanItemDetail }) {
  const latest = x.jobs.at(-1) ?? null;
  const steps = latest ? x.remoteSteps.filter((r) => r.jobId === latest.id) : [];
  const sessions = steps.filter((r) => r.kind === 'upload_session').sort((a, b) => a.postIndex - b.postIndex);
  const current = sessions.at(-1) ?? null;
  const video = steps.find((r) => r.kind === 'video') ?? null;
  const resumes = sessions.reduce((n, r) => n + r.resumeCount, 0);
  const requested = x.item.visibility;
  const pub = latest ? (x.publications.find((p) => p.jobId === latest.id) ?? null) : null;
  return (
    <>
      <h4>YouTube 업로드(MOCK — 모의 YouTube, 모의 ID)</h4>
      {x.connection ? (
        <p className="meta" role="status">
          <span className="tag warn">MOCK</span> 계정 연결(모의): <strong>{x.connection.status_label}</strong>
          {x.connection.usable_for_execution ? '' : ' — 실행 차단(설정 → 배포 계정 연결에서 다시 연결)'}
        </p>
      ) : null}
      {current ? (
        <p className="status-line" role="status">
          {youtubeProgressLine({ received: current.receivedBytes, total: current.totalBytes, resumes, sessions: sessions.length })}
        </p>
      ) : (
        <p className="empty-text">아직 업로드 세션 없음(실행하면 VERIFIED 영상 파일을 조각으로 올립니다)</p>
      )}
      {steps.length ? (
        <ol className="list">
          {steps.map((st) => (
            <li key={st.id} className="hash">
              {YOUTUBE_STEP_LABEL[`${st.kind}:${st.status}`] ?? `${st.kind} ${st.status}`}
              {st.kind === 'video' ? ` · ${st.remoteId}` : ''}
            </li>
          ))}
        </ol>
      ) : null}
      {video && video.status === 'uploaded' ? <p className="note">처리 중 — 처리가 끝나야 결과(비공개 업로드·원격 예약·공개)를 확인합니다. 업로드 성공은 공개 게시 성공이 아닙니다.</p> : null}
      {pub ? (
        <p className="note">
          요청한 공개 범위: {VISIBILITY_LABEL[requested] ?? requested} · 원격이 보고한 공개 범위: {pub.remoteVisibility}
          {requested !== 'private' && pub.remoteVisibility === 'private' ? ' — 미검증 프로젝트 등으로 비공개로 제한됨(공개 성공 아님)' : ''}
        </p>
      ) : null}
      {/* M4 화면 FIX(S4): "(세션 있음)" 은 upload_session 단계가 있을 때만 */}
      <p className="note">{youtubeSessionNote({ hasSession: sessions.length > 0 })}</p>
    </>
  );
}

/** T12: 개발용 모의 시나리오 선택(모의 계정·끝나지 않은 항목만). 승인 스냅샷 밖 — hash·승인 상태가 바뀌지 않는다. */
function ScenarioForm({ x }: { x: PlanItemDetail }) {
  if (x.account?.kind !== 'mock' || FINISHED.includes(x.item.status)) return null;
  const options = mockScenarioOptionsFor(adapterOf(x) ?? 'mock_generic');
  const current = x.mockScenario?.scenario ?? '';
  return (
    <form className="form inline" method="post" action={`/api/distribution-items/${x.item.id}/mock-scenario`} aria-label="모의 시나리오">
      <input type="hidden" name="plan_id" value={x.item.planId} />
      <label>
        모의 시나리오 <span className="note">개발용 · 모의 결과 선택 (실제 채널 없음)</span>{' '}
        <select name="scenario" defaultValue={current || 'success'}>
          {options.map((o) => (
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
  // LIVE-P1(D38): 실제 계정 항목 — 실제 게시 문구(MOCK 문구와 섞지 않음)
  const live = x.account?.kind === 'live';
  const headlineInput = {
    status: x.item.status,
    channel,
    job: latest,
    pub: latestPub,
    blockReason: block.code,
    blockDetail: block.detail,
    activeApproval: x.activeApproval !== null,
    needsNewPlan: x.problems.length > 0,
    publishAt: providerMetadataOf(p).publish_at ?? null,
    cancelTooLate: !!latest?.cancelRequestedAt && latest.state === 'CONFIRMED',
  };
  // FIX-LIVEP1(Codex P0): 결과 불명 실제 게시의 확인 후보(미확인) — 결과로 쓰지 않고 안내만
  // FIX-LIVEP1-USERCONFIRM(Codex P2): 후보는 화면 이력(최근 10개)이 아니라 서버(user-confirm route)와 같은 조회의 가장 최근 재확인 이력에서
  const candidate = live && ['UNKNOWN', 'RECONCILING'].includes(x.item.status) ? liveCandidateForCard(x) : null;
  // LIVEP1-USERCONFIRM: "Threads에서 확인함" — 서버와 같은 판정으로 버튼을 보일 후보(모의 항목은 항상 null)
  const confirmable = live && candidate ? userConfirmCandidateForCard(x) : null;
  const pubTag = live ? liveVerificationTag(latestPub?.verification) : null;
  // LIVEP1-DIAG: 실제 Threads 오류 진단(허용 목록 숫자만) — 판정 코드만으로는 원인을 알 수 없을 때
  const diagLine = live ? latestThreadsDiag(x.events) : null;
  const headline = live ? liveItemHeadline({ ...headlineInput, verification: latestPub?.verification ?? null }) : itemHeadline(headlineInput);
  // M4 화면 FIX(S5): 요청한 예약 공개 시각과 원격이 보고한 결과(D27)를 구분
  // M4UI FIX1: PUBLISHED 는 기록 시각(created_at)이 예약 시각 전일 때만 "적용하지 않음" — 그 밖은 중립 문구
  const publishAt = publishAtView({
    publishAt: providerMetadataOf(p).publish_at ?? null,
    resultKind: latestPub?.resultKind ?? null,
    isMock: latestPub?.isMock ?? x.account?.kind === 'mock',
    recordedAt: latestPub?.createdAt ?? null,
  });
  const retryable = x.item.status === 'BLOCKED' && latest?.state === 'BLOCKED' && x.activeApproval !== null;
  return (
    <section className="card archive" aria-label={`${CHANNEL_LABEL[channel as Channel] ?? channel} 항목`}>
      <h3>
        {CHANNEL_LABEL[channel as Channel] ?? channel} — {x.account?.displayName ?? '(계정 없음)'}{' '}
        {x.account?.kind === 'mock' ? <span className="tag warn">MOCK</span> : null}
        {live ? <span className="tag warn">실제 게시 — 실제 계정</span> : null}
      </h3>
      {live ? (
        <p className="notice" role="note">
          실제 게시 항목: 승인하고 실행하면 이 내용 그대로 실제 Threads 계정 <strong>{x.account?.displayName}</strong> 에 게시됩니다(되돌리기 없음). 공개 범위:{' '}
          {LIVE_THREADS_VISIBILITY_TEXT}.
        </p>
      ) : null}
      <p className="status-line" role="status">
        <strong>{headline}</strong>
        {x.item.status === 'CONFIRMED' && !live ? (
          <>
            {' '}
            <span className="tag warn">MOCK</span> <strong>실제 발행 실적 아님</strong>
          </>
        ) : null}
        {x.item.status === 'CONFIRMED' && live && pubTag ? (
          <>
            {' '}
            <span className={pubTag.className}>{pubTag.text}</span>
          </>
        ) : null}
        {x.item.status === 'CONFIRMED' && live && latestPub?.permalink ? (
          <>
            {' '}
            <a href={latestPub.permalink} rel="noopener noreferrer" target="_blank">
              Threads 에서 보기
            </a>
          </>
        ) : null}
      </p>
      <p className="meta">
        <span className="tag">{ITEM_STATUS_LABEL[x.item.status] ?? x.item.status}</span>
        {x.item.restoredNeedsReview ? <span className="tag warn">복원됨 — 자동 실행·재시도 안 함, 결과 확인 필요</span> : null}
        <span>공개 범위: {live ? `${LIVE_THREADS_VISIBILITY_TEXT}(승인 값 public)` : (VISIBILITY_LABEL[x.item.visibility] ?? x.item.visibility)}</span>
        <span>
          일정: {scheduled ? `${formatMsk(scheduled)} (UTC ${scheduled.toISOString()})` : '즉시(실행 후 대기열)'}
        </span>
        <span>
          요청 결과:{' '}
          {live
            ? '실제 게시(public_publish — Threads 텍스트 1개)'
            : x.item.requestedResult === 'mock_publish'
            ? 'MOCK 실행(실제 게시 아님)'
            : x.item.requestedResult === 'upload_private'
              ? `비공개 업로드(upload_private${x.account?.kind === 'mock' ? ' — MOCK' : ''})`
              : `공개 게시 계획(public_publish${x.account?.kind === 'mock' ? ' — MOCK' : ''})`}
        </span>
        {publishAt ? <span className={publishAt.warn ? 'tag warn' : undefined}>{publishAt.text}</span> : null}
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
          <input type="checkbox" name={`item_${x.item.id}`} form="approve-form" />
          {live ? '이 항목 승인(선택) — 실제 Threads 게시 승인' : '이 항목 승인(선택)'}
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
          <h4>{live ? '작업(실제 게시 — 실제 Threads 어댑터)' : '작업(MOCK — 모의 어댑터)'}</h4>
          {live && x.item.status === 'UNKNOWN' ? (
            <p className="notice" role="alert">
              {LIVE_UNKNOWN_GUIDANCE}
            </p>
          ) : null}
          {diagLine ? (
            <p className="meta" role="status">
              <span className="hash">{diagLine}</span> <span className="note">(Threads 가 돌려준 숫자만 — 문구·토큰은 저장하지 않음)</span>
            </p>
          ) : null}
          {live && candidate ? (
            <p className="notice" role="note">
              <span className="tag warn">미확인</span> {LIVE_CANDIDATE_LABEL}: <span className="hash">{candidate.externalId}</span>
              {candidate.permalink ? (
                <>
                  {' '}
                  ·{' '}
                  <a href={candidate.permalink} rel="noopener noreferrer" target="_blank">
                    {candidate.permalink}
                  </a>
                </>
              ) : null}{' '}
              — Threads 에서 직접 보고 판단하세요. 이 앱은 이 글을 게시 결과로 기록하지 않았습니다.
            </p>
          ) : null}
          {live && candidate && confirmable && confirmable.external_id === candidate.externalId ? (
            <form className="form inline" method="post" action={`/api/distribution-items/${x.item.id}/user-confirm`}>
              <input type="hidden" name="plan_id" value={x.item.planId} />
              <input type="hidden" name="candidate_external_id" value={confirmable.external_id} />
              <button type="submit">{USER_CONFIRM_BUTTON}</button>
              <span className="note" role="note">
                {USER_CONFIRM_WARNING} (기록만 합니다 — 다시 게시하지 않음)
              </span>
            </form>
          ) : null}
          <ul className="list">
            {x.jobs.map((j) => {
              const pub = x.publications.find((p) => p.jobId === j.id) ?? null;
              const reason = block.code;
              return (
                <li key={j.id} className="hash">
                  <strong>{jobStatusText(j, pub, reason, channel)}</strong> · 시도 {j.attempt}/{j.maxAttempts}
                  {j.state === 'QUEUED' ? ` · 예정 ${formatMsk(j.nextRunAt)}` : ''}
                  {j.cancelRequestedAt && j.state === 'CONFIRMED' ? (channel === 'youtube' ? ' · 취소 불가 — 업로드됨, 삭제는 별도 동작(범위 밖)' : ' · 취소 불가(이미 전송됨)') : ''} ·{' '}
                  <a href={`/api/jobs/${j.id}`}>작업 JSON</a>
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
      <StepsPanel x={x} />
      <ScenarioForm x={x} />
      {x.publications.length ? (
        <>
          <h4>원격 결과</h4>
          <ul className="list">
            {x.publications.map((p) =>
              p.isMock ? (
                <li key={p.id}>
                  <span className="tag warn">MOCK</span> {RESULT_KIND_LABEL[p.resultKind] ?? p.resultKind} · 원격 공개 범위 {p.remoteVisibility} · 확인 {p.verification} ·{' '}
                  <span className="hash">{p.externalId}</span>
                  {p.permalink ? <span className="hash"> · {p.permalink}</span> : null}
                  <strong> — 실제 발행 실적 아님</strong>
                </li>
              ) : (
                <li key={p.id}>
                  <span className="tag warn">실제 게시</span>{' '}
                  {liveVerificationTag(p.verification) ? (
                    <>
                      <span className={liveVerificationTag(p.verification)!.className}>{liveVerificationTag(p.verification)!.text}</span>{' '}
                    </>
                  ) : null}
                  실제 Threads 게시물 · 공개 범위 {LIVE_THREADS_VISIBILITY_TEXT} · 확인: {liveVerificationLabel(p.verification, p.permalink)}
                  {p.verification === 'USER_CONFIRMED' && p.confirmedAt ? ` (${formatMsk(p.confirmedAt)} 사용자 기록)` : ''} ·{' '}
                  <span className="hash">{p.externalId}</span>
                  {p.permalink ? (
                    <>
                      {' '}
                      ·{' '}
                      <a href={p.permalink} rel="noopener noreferrer" target="_blank">
                        {p.permalink}
                      </a>
                    </>
                  ) : null}
                </li>
              ),
            )}
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
  // T16(D29 제안): Instagram 모의 연결 항목의 잠정 규격 문제를 승인 전에 보인다(저장소 범위 읽기 창구).
  const d = await getPlanDetail(db, session.ownerId, id.toLowerCase(), undefined, { media: getStorage() });
  if (!d) notFound();
  const approvable = d.items.filter((x) => x.item.status === 'PLANNED' && !x.activeApproval && x.problems.length === 0);
  const executable = d.items.some((x) => x.item.status === 'PLANNED' && x.activeApproval);
  const err = str(q.error) ? (DISTRIBUTE_ERROR_TEXT[str(q.error)!] ?? DISTRIBUTE_ERROR_TEXT.server) : undefined;
  // M3 화면 FIX(D5): 승인·실행·취소·재시도 배너는 저장된 상태가 뒷받침할 때만, 수는 상태에서 센다(쿼리만으로 주장하지 않음).
  const banners = bannersFromState(q, d);
  // LIVE-P1(D38): 실제 계정 항목이 있는 계획 — 실제 게시 안내(모의 항목은 그대로 MOCK)
  const hasLive = d.items.some((x) => x.account?.kind === 'live');
  const hasMock = d.items.some((x) => x.account?.kind !== 'live');
  const reconciledRaw = reconciledNotice(q.reconciled);
  const reconciled =
    hasLive && q.reconciled === 'found' ? '원격에서 결과를 찾았습니다. 실제 게시 항목의 확인 상태는 아래 항목 카드에서 보세요(모의 항목은 MOCK).' : reconciledRaw;

  return (
    <main className="container">
      <h2 className="screen-title">배포 계획 — {d.plan.targetSummary || '이름 없음'}</h2>
      <p className="meta">
        {hasMock ? <span className="tag warn">MOCK</span> : null}
        {hasLive ? <span className="tag warn">실제 게시 포함</span> : null}
        <span className="tag">{hasLive ? (PLAN_STATUS_LABEL[d.plan.status] ?? d.plan.status).replace(/\(MOCK[^)]*\)/, '') : (PLAN_STATUS_LABEL[d.plan.status] ?? d.plan.status)}</span>
        <time dateTime={d.plan.createdAt.toISOString()}>만든 시각 {formatMsk(d.plan.createdAt)}</time>
        <Link href="/distribute">배포함</Link>
      </p>
      {hasLive ? (
        <p className="notice" role="alert">
          실제 게시 — 이 계획에는 실제 Threads 계정 항목이 있습니다. 그 항목을 승인하고 실행하면 작업 처리기가 승인된 내용 그대로 <strong>실제로 게시</strong>합니다(텍스트 1개,
          되돌리기 없음). 실제 게시 조건(PUBLISH_MODE·게시 승인 기록·게시 수 상한)이 없으면 게시하지 않고 보류합니다. 결과를 모르면 자동으로 다시 게시하지 않습니다.
          {hasMock ? ' 모의 계정 항목은 MOCK 입니다(실제 발행 실적 아님).' : ''}
        </p>
      ) : (
        <p className="notice" role="note">
          MOCK — 모의 계정입니다. 승인·실행해도 실제 채널로 아무것도 보내지 않습니다. 실행하면 작업 대기열(QUEUED)에 들어가고, 작업 처리기가 모의 어댑터로
          처리합니다. 확인된 결과도 MOCK 이며 실제 발행 실적이 아닙니다.
        </p>
      )}
      {q.created === '1' ? (
        <p className="saved" role="status">
          배포 계획을 만들었습니다(MOCK — 아직 승인 전). 아래 내용을 확인한 뒤 승인할 항목을 고르세요.
        </p>
      ) : null}
      {banners.approved !== null ? (
        <p className="saved" role="status">
          {hasLive
            ? `승인됨: 이 계획에서 지금 승인된 항목 ${banners.approved}개(실제 게시 항목은 실행하면 실제로 게시됩니다).`
            : `승인됨: 이 계획에서 지금 승인된 항목 ${banners.approved}개(MOCK 계정 — 실제 게시 아님).`}
        </p>
      ) : null}
      {banners.executed ? (
        <p className="saved" role="status">
          {hasLive
            ? `실행: 작업이 만들어진 항목 ${banners.executed.items}개(작업 ${banners.executed.jobs}개)${banners.executed.replay ? '(같은 실행 요청 — 기존 결과)' : ''}. 실제 게시 항목은 작업 처리기가 처리할 때 실제로 게시됩니다.`
            : `MOCK 실행: 작업이 만들어진 항목 ${banners.executed.items}개(작업 ${banners.executed.jobs}개)${banners.executed.replay ? '(같은 실행 요청 — 기존 결과)' : ''}. 실제 게시 아님 — 아래 "작업 처리 실행(모의 1회)"을 누르거나 작업 처리기가 처리합니다.`}
        </p>
      ) : null}
      {q.revoked === '1' ? (
        <p className="saved" role="status">
          {revocationNotice(revocationCountParam(q.revoked_blocked), revocationCountParam(q.revoked_cancel))}
        </p>
      ) : null}
      {str(q.ticked) !== undefined ? (
        <p className="saved" role="status">
          {hasLive
            ? `작업 처리기를 한 번 실행했습니다: 작업 ${Number(str(q.ticked) ?? 0)}개 처리. 실제 게시 항목은 조건이 모두 있을 때만 실제로 보냈습니다 — 아래 항목 상태를 확인하세요.`
            : `작업 처리기(모의)를 한 번 실행했습니다: 작업 ${Number(str(q.ticked) ?? 0)}개 처리. 외부로 아무것도 보내지 않았습니다(MOCK).`}
        </p>
      ) : null}
      {banners.canceled ? (
        <p className="saved" role="status">
          취소했습니다(아직 보내지 않은 작업).
        </p>
      ) : null}
      {banners.cancelRequested ? (
        <p className="notice" role="status">
          취소 확인 중 — 이미 전송 단계에 들어간 작업입니다. 원격 결과를 확인한 뒤 취소됨 또는 &quot;취소 불가(이미 전송됨)&quot;으로 표시됩니다.
        </p>
      ) : null}
      {banners.retried ? (
        <p className="saved" role="status">
          보류된 작업을 다시 대기열에 넣었습니다(MOCK — 새 시도). &quot;작업 처리 실행(모의 1회)&quot;을 누르면 처리합니다.
        </p>
      ) : null}
      {/* LIVEP1-USERCONFIRM: 배너는 저장된 사용자 확인 결과가 있을 때만(쿼리만으로 주장하지 않음) */}
      {q.user_confirmed === '1' && d.items.some((x) => x.publications.some((p) => !p.isMock && p.verification === 'USER_CONFIRMED')) ? (
        <p className="saved" role="status">
          {USER_CONFIRMED_NOTICE}
        </p>
      ) : null}
      {q.scenario_saved === '1' ? (
        <p className="saved" role="status">
          모의 시나리오를 저장했습니다(개발용 · 실제 채널 없음). 승인·배포 내용(hash)은 바뀌지 않습니다.
        </p>
      ) : null}
      {reconciled ? (
        <p className={q.reconciled === 'found' ? 'saved' : 'notice'} role="status">
          재확인(조회만): {reconciled}
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
            {/* M4UI(G1): 항목마다 화면에 보인 그 항목의 요청 결과로 승인한다(목적이 섞인 계획도 한 번에). 서버가 항목의 requested_result 와 다시 대조한다. */}
            {approvable.map((x) => (
              <input key={`p-${x.item.id}`} type="hidden" name={`purpose_${x.item.id}`} value={x.item.requestedResult} />
            ))}
            <p className="note">위 항목 카드에서 승인할 항목을 직접 고르세요(기본 선택 없음). 고른 항목의 위 내용 그대로(hash)만 승인됩니다.</p>
            {approvable.some((x) => x.account?.kind === 'live') ? (
              <p className="notice" role="alert">
                <span className="tag warn">실제 게시 승인</span> 실제 Threads 계정 항목을 승인하면, 실행 뒤 그 내용 그대로 실제 계정에 게시됩니다(계정·본문·공개 범위{' '}
                {LIVE_THREADS_VISIBILITY_TEXT}). 승인 뒤 내용·계정이 바뀌면 승인은 무효가 됩니다.
              </p>
            ) : null}
            {new Set(approvable.map((x) => x.item.requestedResult)).size > 1 ? (
              <p className="note">
                이 계획에는 요청 결과가 다른 항목이 섞여 있습니다. 고른 항목은 각자 카드에 보인 요청 결과(
                {[...new Set(approvable.map((x) => x.item.requestedResult))].map((r) => REQUESTED_RESULT_LABEL[r] ?? r).join(' · ')})로 승인됩니다(MOCK — 실제 게시 아님).
              </p>
            ) : null}
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
        <h3 id="execute-title">{hasLive ? '실행(실제 게시 포함)' : '실행(MOCK)'}</h3>
        <form className="form inline" method="post" action={`/api/distribution-plans/${d.plan.id}/execute`}>
          <input type="hidden" name="command_key" value={randomUUID()} />
          <button type="submit" disabled={!executable}>
            {hasLive ? '지금 실행(대기열에 넣기 — 실제 게시 항목 포함)' : '지금 실행(MOCK — 대기열에 넣기)'}
          </button>
        </form>
        <p className="note">승인된 항목만 대기열에 들어갑니다. 두 번 눌러도 작업은 하나만 생깁니다.</p>
        <form className="form inline" method="post" action="/api/worker/tick">
          <input type="hidden" name="plan_id" value={d.plan.id} />
          <input type="hidden" name="max_jobs" value="5" />
          <button type="submit">{hasLive ? '작업 처리 실행(1회 — 실제 게시 항목은 실제로 게시)' : '작업 처리 실행(모의 1회)'}</button>
        </form>
        <p className="note">
          {hasLive
            ? '작업 처리기를 한 번 돌립니다(이 계획의 작업만, 최대 5개). 실제 게시 항목은 실제 게시 조건이 모두 있을 때만 실제 Threads 로 보내고, 모의 항목은 모의 어댑터로 처리합니다. 재시도 대기 작업은 다음 시각이 되어야 처리됩니다.'
            : '작업 처리기를 한 번 돌립니다(이 계획의 작업만, 최대 5개 — 이 계획은 모의 항목뿐이라 외부 호출 없음. 다른 계획의 작업은 처리하지 않음). 재시도 대기 작업은 다음 시각이 되어야 처리됩니다.'}
        </p>
      </section>
    </main>
  );
}
