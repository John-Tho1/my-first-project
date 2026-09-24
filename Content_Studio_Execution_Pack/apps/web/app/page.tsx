import { randomUUID } from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { latestDraft, listAssets, listCaptures, listCapturesPage } from '@cs/db';
import { describeModes, formatMsk, maskIdentity, MAX_RAW_TEXT, MAX_TITLE, MAX_UPLOAD_BYTES, MAX_USER_NOTE } from '@cs/domain';
import { getSession } from '../lib/auth';
import { LIFECYCLE_LABEL } from '../lib/contents';
import { INPUT_TYPE_LABEL, preview, RISK_LABEL } from '../lib/labels';
import { getAppDb, getConfig } from '../lib/server';

export const dynamic = 'force-dynamic';

type CaptureRow = Awaited<ReturnType<typeof listCaptures>>[number];

/** ?upload= / ?upload_error= 코드별 고정 문구(쿼리 값을 그대로 출력하지 않는다). */
const UPLOAD_TEXT: Record<string, string> = {
  ok: '파일을 저장했습니다.',
  duplicate: '같은 파일이 이미 있어 기존 파일을 사용합니다.',
};
const UPLOAD_ERROR_TEXT: Record<string, string> = {
  too_large: `파일이 너무 큽니다. 최대 ${MAX_UPLOAD_BYTES / 1024 / 1024}MB 까지 올릴 수 있습니다.`,
  unsupported: '지원하지 않는 파일 형식이거나 확장자와 내용이 다릅니다. PNG·JPEG·WebP·PDF·텍스트만 올릴 수 있습니다.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다.',
  invalid: '파일을 선택한 뒤 다시 시도하세요.',
  server: '서버 오류가 발생했습니다.',
};
/** ?capture_error= 코드별 고정 문구(빠른 수집 실패). 입력값을 되돌려 보여 주지 않는다. */
const CAPTURE_ERROR_TEXT: Record<string, string> = {
  invalid: '저장하지 못했습니다. 원문(또는 URL)을 입력했는지 확인하세요.',
  invalid_url: '저장하지 못했습니다. http:// 또는 https:// 로 시작하는 올바른 URL 을 입력하세요.',
  too_large: '저장하지 못했습니다. 내용이 너무 깁니다.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  server: '서버 오류로 저장하지 못했습니다. 잠시 후 다시 시도하세요.',
};
const RIGHTS_LABEL: Record<string, string> = {
  unknown: '권리 미확인',
  owned: '직접 제작',
  licensed: '사용 허락',
  public_domain: '공공 영역',
};
const VERIFICATION_LABEL: Record<string, string> = {
  VERIFIED: '서버 확인됨(형식 서명·크기·checksum)',
  pending: '검증 대기',
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function CaptureItem({ c }: { c: CaptureRow }) {
  return (
    <li className="capture">
      <p className="capture-text">
        <Link href={`/captures/${c.id}`}>{c.title ?? preview(c.rawText)}</Link>
      </p>
      <p className="meta">
        <span className="tag">{INPUT_TYPE_LABEL[c.inputType] ?? c.inputType}</span>
        <span className={c.risk === 'needs_check' ? 'tag warn' : 'tag'}>{RISK_LABEL[c.risk] ?? c.risk}</span>
        <time dateTime={c.receivedAt.toISOString()}>{formatMsk(c.receivedAt)}</time>
      </p>
      {c.userNote ? <p className="note">메모: {c.userNote}</p> : null}
    </li>
  );
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const config = getConfig();
  const badges = describeModes(config);
  const handle = await getAppDb(config);
  // 로그인한 owner 의 데이터만 조회한다(query 계층에서도 owner_id 로 제한).
  const captures = await listCaptures(handle.db, session.ownerId);
  const assets = await listAssets(handle.db, session.ownerId);
  const params = await searchParams;
  const uploadMsg = typeof params.upload === 'string' ? UPLOAD_TEXT[params.upload] : undefined;
  const uploadErr = typeof params.upload_error === 'string' ? (UPLOAD_ERROR_TEXT[params.upload_error] ?? UPLOAD_ERROR_TEXT.server) : undefined;
  const captureErr =
    typeof params.capture_error === 'string'
      ? (CAPTURE_ERROR_TEXT[params.capture_error] ?? CAPTURE_ERROR_TEXT.server)
      : undefined;
  const recent = await listCapturesPage(handle.db, session.ownerId, { limit: 10 });
  const draft = await latestDraft(handle.db, session.ownerId);
  // 폼을 그릴 때마다 새 command_key: 같은 폼의 중복 제출(더블클릭·새로고침 재전송)은 한 건으로 저장된다.
  const commandKey = randomUUID();
  const recommended = captures.slice(0, 2);
  const needsCheck = captures.filter((c) => c.risk === 'needs_check');
  const publishLabel = badges.find((b) => b.key === 'publish')?.label ?? '게시: 비활성';

  return (
    <main className="container">
      <header className="header">
        <h1>Content Studio</h1>
        <p className="now">현재 시각: {formatMsk(new Date())}</p>
        <div className="session-bar">
          <span>로그인: {maskIdentity(session.identity)}</span>
          <span>세션 만료: {formatMsk(session.expiresAt)}</span>
          <form method="post" action="/api/auth/logout">
            <button type="submit" className="link-button">
              로그아웃
            </button>
          </form>
        </div>
        <ul className="badges" aria-label="현재 모드">
          {badges.map((b) => (
            <li key={b.key} className={b.live ? 'badge live' : 'badge'}>
              {b.label}
            </li>
          ))}
        </ul>
      </header>

      <h2 className="screen-title">오늘</h2>

      <section className="card archive" aria-labelledby="quick-capture-title">
        <h3 id="quick-capture-title">빠른 수집</h3>
        {captureErr ? (
          <p className="notice" role="alert">
            {captureErr}
          </p>
        ) : null}
        <form className="form" method="post" action="/api/captures">
          <input type="hidden" name="command_key" value={commandKey} />
          <label htmlFor="raw_text">원문</label>
          <textarea id="raw_text" name="raw_text" rows={4} maxLength={MAX_RAW_TEXT} placeholder="한 문장이면 충분합니다" />
          <label htmlFor="url">URL(선택)</label>
          <input id="url" name="url" type="url" inputMode="url" placeholder="https://" maxLength={2048} />
          <label htmlFor="user_note">메모(왜 저장했는지)</label>
          <input id="user_note" name="user_note" type="text" maxLength={MAX_USER_NOTE} />
          <label htmlFor="title">제목(선택)</label>
          <input id="title" name="title" type="text" maxLength={MAX_TITLE} />
          <button type="submit">서버에 저장</button>
        </form>
        <p className="note">
          URL 을 넣으면 URL 수집으로 저장합니다(원문 추출은 M5 전까지 하지 않음). 저장 결과는 서버 확인 후 다음 화면에 표시됩니다.
        </p>
        <p className="note">이 화면은 서버 저장만 표시합니다. 기기 임시 저장(오프라인)은 아직 지원하지 않습니다.</p>
      </section>

      {captures.length === 0 ? (
        <section className="card empty">
          <p>
            저장된 소재가 없습니다. 개발 서버를 끈 뒤 <code>pnpm db:seed</code> 를 실행하세요.
          </p>
        </section>
      ) : null}

      <div className="grid">
        <section className="card">
          <h3>이어 쓸 초안</h3>
          {draft ? (
            <>
              <p className="capture-text">
                <Link href={`/contents/${draft.id}`}>{draft.title}</Link>
              </p>
              <p className="meta">
                <span className="tag">{LIFECYCLE_LABEL[draft.lifecycle] ?? draft.lifecycle}</span>
                <time dateTime={draft.updatedAt.toISOString()}>최근 수정 {formatMsk(draft.updatedAt)}</time>
              </p>
            </>
          ) : (
            <p className="empty-text">아직 초안이 없습니다</p>
          )}
        </section>

        <section className="card">
          <h3>추천 소재</h3>
          {recommended.length ? (
            <ul className="list">
              {recommended.map((c) => (
                <CaptureItem key={c.id} c={c} />
              ))}
            </ul>
          ) : (
            <p className="empty-text">추천할 소재가 없습니다</p>
          )}
        </section>

        <section className="card">
          <h3>확인 필요</h3>
          {needsCheck.length ? (
            <ul className="list">
              {needsCheck.map((c) => (
                <CaptureItem key={c.id} c={c} />
              ))}
            </ul>
          ) : (
            <p className="empty-text">확인이 필요한 항목이 없습니다</p>
          )}
        </section>

        <section className="card">
          <h3>최근 배포</h3>
          <p className="empty-text">배포 기능은 M3에서 활성화됩니다 · 현재 {publishLabel}</p>
        </section>
      </div>

      <section className="card archive">
        <h3>소재함 (최근 {recent.items.length}건)</h3>
        {recent.items.length ? (
          <>
            <ul className="list">
              {recent.items.map((i) => (
                <CaptureItem key={i.capture.id} c={i.capture} />
              ))}
            </ul>
            <p className="pager">
              <Link href="/captures">소재함 전체 보기</Link>
            </p>
          </>
        ) : (
          <p className="empty-text">
            <code>pnpm db:seed</code> 를 실행하세요
          </p>
        )}
      </section>

      <section className="card archive" aria-labelledby="files-title">
        <h3 id="files-title">파일</h3>
        {uploadMsg ? <p className="note">{uploadMsg}</p> : null}
        {uploadErr ? (
          <p className="notice" role="alert">
            {uploadErr}
          </p>
        ) : null}
        <form className="form inline" method="post" action="/api/assets/uploads" encType="multipart/form-data">
          <input name="file" type="file" required accept=".png,.jpg,.jpeg,.webp,.pdf,.txt,.md" />
          <select name="rights_status" defaultValue="unknown" aria-label="권리 상태">
            <option value="unknown">권리 미확인</option>
            <option value="owned">직접 제작</option>
            <option value="licensed">사용 허락</option>
            <option value="public_domain">공공 영역</option>
          </select>
          <button type="submit">올리기</button>
        </form>
        <p className="note">PNG·JPEG·WebP·PDF·텍스트(UTF-8), 최대 10MB. 형식은 파일 내용으로 확인합니다.</p>
        {assets.length ? (
          <ul className="list">
            {assets.map((a) => (
              <li key={a.id} className="capture">
                <p className="meta">
                  <a href={`/api/assets/${a.id}`}>{a.id.slice(0, 8)}… 내려받기</a>
                  <span className="tag">{a.mime}</span>
                  <span>{formatBytes(a.bytes)}</span>
                  <span className="tag">{VERIFICATION_LABEL[a.verificationState] ?? a.verificationState}</span>
                  <span className={a.rightsStatus === 'unknown' ? 'tag warn' : 'tag'}>
                    {RIGHTS_LABEL[a.rightsStatus] ?? a.rightsStatus}
                  </span>
                  <time dateTime={a.createdAt.toISOString()}>{formatMsk(a.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">올린 파일이 없습니다</p>
        )}
      </section>
    </main>
  );
}
