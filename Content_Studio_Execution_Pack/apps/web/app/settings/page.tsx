import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listAccountHealth, listExportRuns, listRestoreRuns, livePublishOverview, monthlyUsage } from '@cs/db';
import {
  accountExpiryNotice,
  budgetPolicy,
  CHANNEL_LABEL,
  devCertExpiryNotice,
  EXPIRY_ACCOUNT_TAG_TEXT,
  EXPIRY_LEVEL_LABEL,
  expiryNotices,
  formatLiveAvailableAt,
  formatMsk,
  fromMicro,
  isLiveThreadsCredential,
  LIVE_PUBLISH_RESUME_CONFIRM_TEXT,
  LIVE_SETTLEMENT_POLICY_TEXT,
  liveLlmReadiness,
  livePublishDailyUsageText,
  livePublishSwitchLabel,
  sttBudgetPolicy,
  sttLiveReadiness,
  type Channel,
} from '@cs/domain';
import { getSession } from '../../lib/auth';
import { Breadcrumbs } from '../../lib/breadcrumbs';
import { BACKUP_ERROR_TEXT, formatBytes } from '../../lib/backup';
import { readDevCertExpiry } from '../../lib/dev-cert';
import { ExpiryNoticeList } from '../../lib/expiry-view';
import { LIVE_PUBLISH_DONE_TEXT, LIVE_PUBLISH_ERROR_TEXT } from '../../lib/live-publish';
import { ACCOUNT_ERROR_TEXT, oauthReadinessView } from '../../lib/oauth';
import { oidcReadinessView } from '../../lib/oidc';
import { revokeNotice } from '../../lib/revoke-view';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

const RESTORE_STATUS_LABEL: Record<string, string> = {
  previewed: '미리보기만(아직 복원 안 함)',
  committed: '복원 완료',
  rejected: '거부됨(파일 재검증 실패)',
  failed: '실패',
};

/**
 * 설정 → 내보내기·복원(T05). 문구 규칙: "안전"·"백업 완료"라고 쓰지 않는다 — 파일이 만들어졌다는 사실(sha256)과
 * 실제 복원 결과(표별 건수)만 보여 준다(docs/07).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const q = await searchParams;
  const config = getConfig();
  const { db } = await getAppDb(config);
  const usage = await monthlyUsage(db, session.ownerId);
  const policy = budgetPolicy(config);
  const live = liveLlmReadiness(config, process.env);
  const stt = sttBudgetPolicy(config);
  const sttLive = sttLiveReadiness(config);
  const exports = await listExportRuns(db, session.ownerId, 20);
  const restores = await listRestoreRuns(db, session.ownerId, 10);
  const exported = str(q.exported) ? exports.find((e) => e.id === str(q.exported)) : undefined;
  const err = str(q.error) ? (BACKUP_ERROR_TEXT[str(q.error)!] ?? BACKUP_ERROR_TEXT.server) : undefined;
  // T13: 계정 연결 상태(토큰·암호문 없음 — 상태·만료·scope 이름만)
  const accounts = await listAccountHealth(db, session.ownerId);
  const oauth = oauthReadinessView(config);
  // T21-P1b: 로그인(인증) 방식·OIDC 준비 상태 — 설정 이름만(값 없음)
  const authView = oidcReadinessView(config);
  const accountErr = str(q.account_error) ? (ACCOUNT_ERROR_TEXT[str(q.account_error)!] ?? ACCOUNT_ERROR_TEXT.server) : undefined;
  // M4UI FIX1: 연결 해제 결과는 revokeNotice — 끝나지 않은 해제(revoke=incomplete&revoke_code=허용 코드)는 경고로, "해제했습니다"라고 하지 않는다
  const revokeMsg = revokeNotice({ revoked: str(q.revoked), revoke: str(q.revoke), code: str(q.revoke_code) });
  const accountDone = q.live_target === 'on'
    ? '실제 게시 계정으로 사용합니다. 이제 이 계정을 배포 계획에 고를 수 있습니다 — 실제 게시는 승인한 글만, 실제 게시 조건이 모두 있을 때만 일어납니다.'
    : q.live_target === 'off'
      ? '실제 게시 계정 사용을 멈췄습니다(이 계정의 활성 승인은 철회됨).'
      : q.connected === 'live'
    ? '실제 Threads 계정을 연결했습니다(연결·프로필 조회만 — 실제 게시 계정으로 쓰려면 "실제 게시 계정으로 사용"을 누르세요).'
    : q.connected
      ? '계정을 연결했습니다(MOCK).'
      : q.live_account
        ? '실제 Threads 계정 행을 만들었습니다(연결 전). 준비 상태가 모두 갖춰지면 "실제 연결"을 누르세요.'
        : q.refreshed ? '연결 정보를 갱신했습니다.' : q.checked ? '연결을 확인했습니다.' : revokeMsg && !revokeMsg.warn ? revokeMsg.text : undefined;
  const accountWarn = revokeMsg?.warn ? revokeMsg.text : undefined;
  // LIVE-P2(D39): 실제 게시 즉시 중지 스위치·최근 24시간 사용(표시용 — 판정은 전송 직전 서버)
  const liveDailyLimit = config.PUBLISH_LIVE_DAILY_MAX ?? null;
  // FIX-LIVEP2(A): 상한을 넘겨 쓰는 중(상한을 줄임 등)이면 "다음 게시 가능"은 상한 아래로 내려가는 시각(상한을 넘겨 준다), 표시는 분 단위 올림
  const liveCtl = await livePublishOverview(db, session.ownerId, new Date(), liveDailyLimit);
  const liveSwitch = livePublishSwitchLabel({ publishEnabled: config.PUBLISH_MODE === 'enabled', ready: oauth.livePublish.ready, paused: liveCtl.paused });
  const liveDone = str(q.live_publish) ? LIVE_PUBLISH_DONE_TEXT[str(q.live_publish)!] : undefined;
  const liveErr = str(q.live_error) ? (LIVE_PUBLISH_ERROR_TEXT[str(q.live_error)!] ?? LIVE_PUBLISH_ERROR_TEXT.server) : undefined;
  // EXPIRY-1(D39): 실제 Threads 연결·로컬 인증서(개발 모드만 읽음) 만료 14일 전부터 경고. 다시 연결은 아래 배포 계정 연결의 기존 연결 흐름(토큰 갱신 API 호출 없음 — D31).
  const now = new Date();
  const devCert = readDevCertExpiry();
  const expiry = expiryNotices({ accounts, devCert, now });
  const devCertNotice = devCertExpiryNotice(devCert, now);
  const liveThreadsCreds = accounts.filter(isLiveThreadsCredential);

  return (
    <main className="container">
      <Breadcrumbs at={{ page: 'settings' }} />
      <h2 className="screen-title">설정</h2>
      <ExpiryNoticeList notices={expiry} />
      {exported ? (
        <p className="saved" role="status">
          내보내기 파일 생성됨 (sha256 <span className="hash">{exported.manifestSha256.slice(0, 16)}…</span>, {formatBytes(exported.zipBytes)},{' '}
          {formatMsk(exported.createdAt)}) — 복원이 되는지는 아래 &quot;복원 미리보기&quot;로 확인하세요.
        </p>
      ) : null}
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}

      <section className="card archive" aria-labelledby="auth-title">
        <h3 id="auth-title">로그인(인증)</h3>
        <dl className="group-list">
          <div className="row">
            <dt>방식</dt>
            <dd>
              <span className="tag">{authView.mode === 'oidc' ? 'OpenID Connect(OIDC)' : '개발용(localhost 전용, 비밀번호 없음)'}</span>
            </dd>
          </div>
        </dl>
        <p className="notice" role="note">
          {authView.ready ? 'OIDC 로그인 준비됨.' : `OIDC 로그인 준비 안 됨: ${authView.missing.join(', ')}`}
        </p>
        <p className="note">IdP·클라이언트 ID·시크릿·허용 계정 값은 이 화면에 보이지 않습니다(설정 이름만).</p>
      </section>

      <section className="card archive" aria-labelledby="ai-title">
        <h3 id="ai-title">AI 모드·비용</h3>
        <dl className="group-list">
          <div className="row">
            <dt>AI</dt>
            <dd>
              <span className={config.LLM_MODE === 'live' ? 'tag live' : 'tag'}>{config.LLM_MODE === 'mock' ? '모의(실제 호출 없음)' : '실제(live)'}</span>
            </dd>
          </div>
          <div className="row">
            <dt>월 상한</dt>
            <dd>
              {policy.monthlyLimitMicro !== null ? `${fromMicro(policy.monthlyLimitMicro)} ${policy.currency}` : '미설정'}(설정 통화 {policy.currency})
            </dd>
          </div>
          <div className="row">
            <dt>가격</dt>
            <dd>{policy.pricing ? '가격 설정됨' : '가격 미설정(모의는 0 으로 기록, 실제 호출 차단)'}</dd>
          </div>
        </dl>
        {usage.byCurrency.length ? (
          <ul className="list">
            {usage.byCurrency.map((u) => (
              <li key={u.currency}>
                <span className={u.currency === policy.currency ? undefined : 'tag warn'}>
                  이번 달(MSK) 사용: {u.used} {u.currency}
                </span>
                {` · 실행 ${u.runs}건`}
                {u.pending > 0 ? ` · 확정 전 ${u.pending}건` : ''}
                {u.overBudgetRuns > 0 ? ` · 예약 초과 ${u.overBudgetRuns}건(초과액 ${u.overage} ${u.currency})` : ''}
                {u.currency !== policy.currency ? ' — 설정 통화와 달라 이번 달에는 AI 호출이 거부됩니다' : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">이번 달 AI 사용 기록이 없습니다.</p>
        )}
        <p className="notice" role="note">
          {live.ready
            ? `실제 AI(Claude) 준비됨 — 작성 보조 요청마다 실제 호출·과금이 일어납니다(1회 출력 상한 ${policy.liveMaxOutputTokens ?? '-'} 토큰${policy.liveMaxRuns !== undefined ? `, 승인당 호출 ${policy.liveMaxRuns}회` : ''}). ${LIVE_SETTLEMENT_POLICY_TEXT}`
            : `live 준비 안 됨: ${live.missing.join(', ')}`}
        </p>
        <details className="more">
          <summary>자세히</summary>
          <p>실제 AI 호출은 사용자의 별도 승인 뒤에만 연결합니다(결정 D7·D13·D34). 설정 값·키는 이 화면에 보이지 않습니다.</p>
        </details>
        <dl className="group-list">
          <div className="row">
            <dt>음성 전사</dt>
            <dd>
              <span className={config.STT_MODE === 'live' ? 'tag live' : 'tag'}>{config.STT_MODE === 'mock' ? '모의(실제 음성 인식 없음)' : '실제(live)'}</span>
            </dd>
          </div>
          <div className="row">
            <dt>1분 가격</dt>
            <dd>{stt.pricing ? `1분 가격 설정됨(${stt.currency})` : '1분 가격 미설정(모의는 0 으로 기록)'}</dd>
          </div>
          <div className="row">
            <dt>예산</dt>
            <dd>예산 통화·상한은 AI 와 같은 원장을 씁니다</dd>
          </div>
        </dl>
        <p className="notice" role="note">
          음성 전사 live 준비 안 됨: {sttLive.missing.join(', ')}
        </p>
      </section>

      <section className="card archive" id="live-publish" aria-labelledby="live-publish-title">
        <h3 id="live-publish-title">실제 게시</h3>
        {liveDone ? (
          <p className="saved" role="status">
            {liveDone}
          </p>
        ) : null}
        {liveErr ? (
          <p className="notice" role="alert">
            {liveErr}
          </p>
        ) : null}
        <dl className="group-list">
          <div className="row">
            <dt>상태</dt>
            <dd>
              <span className={liveCtl.paused ? 'tag warn' : liveSwitch === '켜짐' ? 'tag live' : 'tag'}>{liveSwitch}</span>
              {liveCtl.paused && liveSwitch !== '일시 중지됨' ? ' · 일시 중지됨' : ''}
            </dd>
          </div>
          <div className="row">
            <dt>사용</dt>
            <dd>
              {livePublishDailyUsageText(liveCtl.used, liveDailyLimit)}
              {liveDailyLimit !== null && liveCtl.used >= liveDailyLimit && liveCtl.availableAt ? ` — 다음 게시 가능 ${formatLiveAvailableAt(liveCtl.availableAt)}` : ''}
            </dd>
          </div>
          {liveCtl.changedAt ? (
            <div className="row">
              <dt>스위치 변경</dt>
              <dd>{formatMsk(liveCtl.changedAt)}</dd>
            </div>
          ) : null}
        </dl>
        {liveCtl.paused ? (
          <form className="form" method="post" action="/api/live-publish/resume">
            <label htmlFor="live-resume-confirm">
              재개하려면 &apos;{LIVE_PUBLISH_RESUME_CONFIRM_TEXT}&apos;를 입력하세요(보류된 항목은 재개 뒤 &apos;재시도&apos;를 눌러야 다시 보냅니다)
            </label>
            <input id="live-resume-confirm" name="confirm_text" type="text" required maxLength={10} autoComplete="off" />
            <button type="submit">실제 게시 재개</button>
          </form>
        ) : (
          <form className="form inline" method="post" action="/api/live-publish/pause">
            <button type="submit">실제 게시 일시 중지</button>
          </form>
        )}
        <p className="note">
          일시 중지는 서버 재시작 없이 바로 적용됩니다 — 실제 게시는 전송 직전에 확인해 보내지 않고 보류합니다(모의 전송은 그대로). 완전히 끄려면 PUBLISH_MODE=disabled.
        </p>
      </section>

      <section className="card archive" id="expiry" aria-labelledby="expiry-title">
        <h3 id="expiry-title">만료 관리</h3>
        <dl className="group-list">
          {liveThreadsCreds.length ? (
            liveThreadsCreds.map((a) => {
              const exp = accountExpiryNotice(a, now);
              return (
                <div className="row" key={a.account_id}>
                  <dt>Threads 연결</dt>
                  <dd>
                    {a.display_name} · {formatMsk(new Date(a.expires_at!))}
                    {exp ? (
                      <>
                        {' '}
                        <span className={exp.level === 'expired' ? 'tag danger' : 'tag warn'}>{EXPIRY_LEVEL_LABEL[exp.level]}</span>
                      </>
                    ) : null}
                  </dd>
                </div>
              );
            })
          ) : (
            <div className="row">
              <dt>Threads 연결</dt>
              <dd>실제 연결 없음</dd>
            </div>
          )}
          <div className="row">
            <dt>로컬 인증서</dt>
            <dd>
              {process.env.NODE_ENV === 'production'
                ? '운영 빌드 — 확인하지 않음'
                : devCert
                  ? formatMsk(devCert.validTo)
                  : '확인 안 됨(파일 없음 또는 읽을 수 없음 — 개발 모드만 확인)'}
              {devCertNotice ? (
                <>
                  {' '}
                  <span className={devCertNotice.level === 'expired' ? 'tag danger' : 'tag warn'}>{EXPIRY_LEVEL_LABEL[devCertNotice.level]}</span>
                </>
              ) : null}
            </dd>
          </div>
        </dl>
        <p className="note">
          만료 14일 전부터 홈·설정 맨 위에 경고합니다. 실제 Threads 연결은 자동 갱신하지 않습니다 — 만료 전에 아래 배포 계정 연결의 &quot;다시 연결(실제 Threads)&quot;로
          다시 연결하세요(기존 연결 흐름, 토큰 갱신 API 호출 없음).
        </p>
        <p className="note">
          로컬 인증서(개발 모드): 앱 루트에서 <code>bash scripts/dev-cert.sh check</code> · <code>bash scripts/dev-cert.sh renew</code>(로컬 openssl 만, 외부 호출 없음). 갱신
          뒤 dev 서버를 다시 시작하고 브라우저의 인증서 경고를 다시 수락하세요.
        </p>
      </section>

      <section className="card archive" id="accounts" aria-labelledby="accounts-title">
        <h3 id="accounts-title">배포 계정 연결</h3>
        {accountDone ? (
          <p className="saved" role="status">
            {accountDone}
          </p>
        ) : null}
        {accountWarn ? (
          <p className="notice" role="alert">
            {accountWarn}
          </p>
        ) : null}
        {accountErr ? (
          <p className="notice" role="alert">
            {accountErr}
          </p>
        ) : null}
        <p className="note">
          모의 연결은 실제 게시에 쓰이지 않습니다. 실제 게시는 &quot;실제 게시 계정으로 사용&quot;한 Threads 계정의 승인 글만 합니다.
        </p>
        <details className="more">
          <summary>자세히</summary>
          <p>
            모의(MOCK) 계정은 Threads·YouTube·Instagram 을 연결할 수 있습니다(YouTube 는 Google 형 모의 OAuth — scope 이름은 자리 표시 `youtube.upload(mock)`, Instagram 은
            Meta 형 모의 OAuth — 자리 표시 `instagram_basic(mock)`·`instagram_content_publish(mock)`, 공식 이름은 live 전 재확인, 모의 사용자는 비즈니스·크리에이터 계정으로
            가정). 모의 연결은 앱 안에서만 동작하며 실제 Threads·Google·Instagram 계정 연결이 아닙니다. YouTube 모의 연결의 만료는 refresh token 기준이며 1시간짜리
            access token 은 보내기 전에 자동 갱신합니다. 연결 정보(토큰)는 서버에서 암호화해 저장하며 이 화면·내보내기·로그에는 나오지 않습니다. 내보내기 파일을
            복원하면 연결했던 계정은 &quot;다시 연결 필요&quot;가 됩니다.
          </p>
          <p>
            실제 Threads 계정(D31): 연결(인증 창 → 코드 교환 → 장기 토큰)과 프로필 조회를 합니다. 자동 갱신은 하지 않습니다. 실제 게시(D38)는 &quot;실제 게시 계정으로
            사용&quot;을 누른 계정만 배포 계획에 고를 수 있고, 승인한 텍스트 글 1개를 실제 게시 조건(아래 &quot;실제 게시 준비&quot;)이 모두 있을 때만 게시합니다.
            게시물의 공개 범위는 Threads 계정 공개 설정을 따릅니다. Threads 에는 토큰 철회 API 가 없어 &quot;연결 해제&quot;는 이 앱의 연결 정보만 지웁니다 — Threads 쪽
            권한까지 지우려면 Threads 앱 설정의 앱·웹사이트 권한 메뉴에서 이 앱을 삭제하세요(메뉴 이름은 Threads 앱 버전에 따라 다를 수 있음).
          </p>
        </details>
        <dl className="group-list">
          <div className="row">
            <dt>서버 암호화 키</dt>
            <dd>
              <span className={oauth.secrets.configured ? 'tag' : 'tag warn'}>
                {oauth.secrets.configured ? `설정됨(키 버전 ${oauth.secrets.currentVersion}${oauth.secrets.hasPrevious ? ', 이전 키 있음' : ''})` : '설정 안 됨'}
              </span>
            </dd>
          </div>
          <div className="row">
            <dt>redirect URI</dt>
            <dd className="hash">{oauth.redirectUri}</dd>
          </div>
        </dl>
        {!oauth.secrets.configured ? (
          <p className="notice" role="note">
            계정 연결 불가: {oauth.secrets.problems.join(', ')} — .env.local 에 SECRETS_MASTER_KEY·SECRETS_KEY_VERSION 을 넣고 서버를 다시 시작하세요(다른 기능은 그대로).
          </p>
        ) : null}
        {oauth.live.ready ? (
          <p className="meta">
            <span className="tag live">실제 Threads 연결 준비됨</span>
            <span>(연결·프로필 조회만 — D31. 요청 권한 threads_basic, threads_content_publish)</span>
          </p>
        ) : (
          <p className="notice" role="note">
            실제 Threads 연결 준비 안 됨: {oauth.live.missing.join(', ')}
          </p>
        )}
        {oauth.livePublish.ready ? (
          <p className="notice" role="note">
            <span className="tag live">실제 게시 준비됨</span> 실제 게시 계정으로 사용 중인 Threads 계정의 승인된 항목은 실행하면 <strong>실제로 게시</strong>됩니다(텍스트만, 승인
            기록당 게시 수 상한 안에서, 되돌리기 없음).
            {liveCtl.paused ? <strong> 지금은 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않습니다.</strong> : null}
          </p>
        ) : (
          <p className="notice" role="note">
            실제 게시 준비 안 됨(실제로 게시하지 않음): {oauth.livePublish.missing.join(', ')}
          </p>
        )}
        <form className="form inline" method="post" action="/api/channel-accounts">
          <input type="hidden" name="platform" value="threads" />
          <input type="hidden" name="kind" value="live" />
          <button type="submit" className="link-button">
            실제 Threads 계정 추가(연결 전 행 — 외부 호출 없음)
          </button>
        </form>
        {accounts.length ? (
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">계정</th>
                  <th scope="col">연결 상태</th>
                  <th scope="col">만료</th>
                  <th scope="col">권한(scope)</th>
                  <th scope="col">마지막 확인</th>
                  <th scope="col">동작</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => {
                  const connectable = a.mock && (a.platform === 'threads' || a.platform === 'youtube' || a.platform === 'instagram');
                  // LIVE-T1(D31): 실제 Threads 계정 — 준비 상태가 모두 갖춰졌을 때만 실제 연결(아니면 빠진 이름만 보인다)
                  const liveThreads = !a.mock && a.platform === 'threads';
                  const hasCredential = a.connected_at !== null && a.revoked_at === null;
                  // EXPIRY-1(D39): 실제 Threads 연결 정보의 만료 14일 이내·만료 표시(다시 연결은 이 행의 기존 연결 버튼)
                  const exp = accountExpiryNotice(a, now);
                  return (
                    <tr key={a.account_id}>
                      <td>
                        {a.mock ? <span className="tag mock">MOCK</span> : <span className="tag live">실제 계정</span>} {a.display_name} ·{' '}
                        {CHANNEL_LABEL[a.platform as Channel] ?? a.platform}
                        {!a.mock ? (a.live_publish_target ? ' · 실제 게시 계정으로 사용 중(D38)' : ' · 실제 게시 계정 아님(게시 안 함)') : ''}
                      </td>
                      <td>
                        <span className={a.usable_for_execution ? 'tag' : 'tag warn'}>{a.status_label}</span>
                        {a.status === 'not_connected' && a.mock ? ' (모의 배포는 연결 없이 가능 — 결과는 항상 MOCK)' : ''}
                        {a.reason && a.status !== 'connected' ? ` · ${a.reason}` : ''}
                        {a.last_error_code ? ` · 오류 ${a.last_error_code}` : ''}
                        {a.credential_required && !a.usable_for_execution ? ' · 이 계정 배포 실행 차단' : ''}
                      </td>
                      <td>
                        {a.expires_at ? formatMsk(new Date(a.expires_at)) : '—'}
                        {exp ? (
                          <>
                            {' '}
                            <span className={exp.level === 'expired' ? 'tag danger' : 'tag warn'}>{EXPIRY_ACCOUNT_TAG_TEXT[exp.level]}</span>
                          </>
                        ) : null}
                      </td>
                      <td>
                        {a.scopes_required.length ? `필요 ${a.scopes_required.join(', ')}` : '—'}
                        {a.scopes_granted.length ? ` · 허락 ${a.scopes_granted.join(', ')}` : ''}
                        {a.missing_scopes.length ? ` · 부족 ${a.missing_scopes.join(', ')}` : ''}
                      </td>
                      <td>{a.last_checked_at ? formatMsk(new Date(a.last_checked_at)) : '—'}</td>
                      <td>
                        {connectable ? (
                          <form method="post" action={`/api/channel-accounts/${a.account_id}/connect`}>
                            <button type="submit" className="link-button" disabled={!oauth.secrets.configured}>
                              {a.connected_at ? '다시 연결(모의)' : '연결(모의)'}
                            </button>
                          </form>
                        ) : liveThreads ? (
                          oauth.live.ready && oauth.secrets.configured ? (
                            <form method="post" action={`/api/channel-accounts/${a.account_id}/connect`}>
                              <button type="submit" className="link-button">
                                {a.connected_at ? '다시 연결(실제 Threads)' : '실제 연결(Threads 인증 창)'}
                              </button>
                            </form>
                          ) : (
                            <span className="muted-text">실제 연결 준비 안 됨: {oauth.live.missing.join(', ')}</span>
                          )
                        ) : (
                          <span className="muted-text">연결 미지원(Threads·YouTube·Instagram 모의, 실제 Threads 만)</span>
                        )}
                        {hasCredential ? (
                          <>
                            {a.mock ? (
                              <form method="post" action={`/api/channel-accounts/${a.account_id}/refresh`}>
                                <button type="submit" className="link-button">
                                  지금 갱신
                                </button>
                              </form>
                            ) : null}
                            <form method="post" action={`/api/channel-accounts/${a.account_id}/check`}>
                              <button type="submit" className="link-button">
                                {a.mock ? '연결 확인' : '연결 확인(프로필 조회)'}
                              </button>
                            </form>
                            <form method="post" action={`/api/channel-accounts/${a.account_id}/revoke`}>
                              <button type="submit" className="link-button">
                                {a.mock ? '연결 해제' : '연결 해제(로컬 삭제 — Threads 철회 API 없음)'}
                              </button>
                            </form>
                          </>
                        ) : null}
                        {/* LIVE-P1(D38): 실제 Threads 계정 — 실제 게시 계정으로 사용(connected)/사용 중지(disconnected). 외부 호출 없음. */}
                        {liveThreads && !a.live_unbound ? (
                          <form method="post" action={`/api/channel-accounts/${a.account_id}/publish-target`}>
                            <input type="hidden" name="enabled" value={a.live_publish_target ? 'false' : 'true'} />
                            <button type="submit" className="link-button" disabled={!a.live_publish_target && !a.usable_for_execution}>
                              {a.live_publish_target ? '실제 게시 계정 사용 중지' : '실제 게시 계정으로 사용'}
                            </button>
                          </form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">배포 계정이 없습니다. `pnpm db:seed` 를 실행하면 모의 계정이 만들어집니다.</p>
        )}
      </section>

      <section className="card archive" aria-labelledby="export-title">
        <h3 id="export-title">내보내기</h3>
        <p className="note">개인 원문이 들어 있으니 파일을 보관할 곳을 직접 정하세요.</p>
        <details className="more">
          <summary>자세히</summary>
          <p>
            소재·수정 이력·출처·카드·원고(모든 버전)·원문 관계·첨부 파일을 Markdown + JSON + 파일 + checksum manifest 로 묶은 ZIP 을 만듭니다. 로그인 세션·인증
            비밀은 넣지 않습니다. 백업 나이·복원 훈련 결과·보존 정리는 <Link href="/ops">운영</Link> 화면에서 봅니다.
          </p>
        </details>
        <form className="form inline" method="post" action="/api/exports">
          <button type="submit">지금 내보내기</button>
        </form>
        {exports.length ? (
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">만든 시각</th>
                  <th scope="col" className="num">크기</th>
                  <th scope="col">내용</th>
                  <th scope="col">manifest sha256</th>
                  <th scope="col">파일</th>
                </tr>
              </thead>
              <tbody>
                {exports.map((e) => (
                  <tr key={e.id}>
                    <td>{formatMsk(e.createdAt)}</td>
                    <td className="num">{formatBytes(e.zipBytes)}</td>
                    <td>
                      소재 {e.totals.captures ?? 0} · 카드 {e.totals.ideas ?? 0} · 원고 {e.totals.contents ?? 0} (버전{' '}
                      {e.totals.content_versions ?? 0}) · 파일 {e.totals.assets_included ?? 0}/{e.totals.assets ?? 0}
                    </td>
                    <td className="hash">{e.manifestSha256.slice(0, 16)}…</td>
                    <td>
                      <a href={`/api/exports/${e.id}`}>다운로드</a>
                      <form method="post" action="/api/restores/preview">
                        <input type="hidden" name="export_id" value={e.id} />
                        <button type="submit" className="link-button">
                          이 파일로 복원 미리보기
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">아직 내보낸 파일이 없습니다.</p>
        )}
      </section>

      <section className="card archive" aria-labelledby="restore-title">
        <h3 id="restore-title">복원</h3>
        <p className="note">미리보기 단계에서는 데이터가 바뀌지 않습니다.</p>
        <details className="more">
          <summary>자세히</summary>
          <p>
            내보내기 ZIP(최대 256MB)을 올리면 먼저 &quot;복원 미리보기&quot;를 만듭니다. 모든 파일의 sha256 을 manifest 와 대조하고, 표별로 새로 추가·동일·충돌 건수를
            보여 줍니다.
          </p>
        </details>
        <form className="form" method="post" action="/api/restores/preview" encType="multipart/form-data">
          <label htmlFor="restore-file">내보내기 ZIP 파일</label>
          <input id="restore-file" name="file" type="file" accept=".zip,application/zip" required />
          <button type="submit">복원 미리보기 만들기</button>
        </form>
        {restores.length ? (
          <ul className="list archive">
            {restores.map((r) => (
              <li key={r.id} className="capture">
                <p className="capture-text">
                  <Link href={`/settings/restores/${r.id}`}>{formatMsk(r.createdAt)} 미리보기</Link>
                </p>
                <p className="meta">
                  <span className={r.status === 'committed' ? 'tag' : 'tag warn'}>{RESTORE_STATUS_LABEL[r.status] ?? r.status}</span>
                  <span>{r.source === 'export_run' ? '내 내보내기 파일' : '올린 파일'}</span>
                  {r.committedAt ? <span>복원 시각: {formatMsk(r.committedAt)}</span> : null}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}
