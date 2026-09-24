import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getContentDetail, getContentVersion, getLedgerForRun, getWritingState, listClaimsForRun } from '@cs/db';
import {
  allowedLifecycleOptions,
  contentLifecycleSchema,
  formatMsk,
  formatMskInline,
  MAX_CONTENT_BODY,
  MAX_CONTENT_TITLE,
  MAX_VERSION_NOTE,
} from '@cs/domain';
import { getSession } from '../../../lib/auth';
import { FORM_ERROR_TEXT, LIFECYCLE_LABEL } from '../../../lib/contents';
import { normalizeRunParam, selectRun, versionAuthorLabel, WRITING_ERROR_TEXT } from '../../../lib/writing';
import { WritingPanel, type ProposalView } from './writing-panel';
import { preview } from '../../../lib/labels';
import { getAppDb, getConfig } from '../../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

/**
 * 작성실: 현재 본문 편집(저장 = 새 불변 버전, base_version 으로 충돌 검사), 버전 목록·비교, 메타데이터, 원문(수집)·파생.
 * 오래된 base_version 저장은 API 가 409 비교 화면(현재/내 본문 + diff + 재저장 폼)을 돌려준다.
 */
export default async function ContentPage({
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
  const d = await getContentDetail(db, session.ownerId, id.toLowerCase());
  if (!d) notFound();
  const { content: c, current, versions } = d;
  const lc = contentLifecycleSchema.safeParse(c.lifecycle);
  const options = lc.success ? allowedLifecycleOptions(lc.data) : [];
  const err = str(q.error) ? (FORM_ERROR_TEXT[str(q.error)!] ?? WRITING_ERROR_TEXT[str(q.error)!] ?? FORM_ERROR_TEXT.server) : undefined;
  // 조회와 선택에 같은 정규화 값(소문자 UUID 또는 'none')을 쓴다(FIX-T06 round 2).
  const runParam = normalizeRunParam(str(q.run));
  const w = await getWritingState(db, session.ownerId, c.id, runParam !== 'none' ? runParam : undefined);
  const selectedRun = selectRun(w.runs, runParam);
  // T07: 선택한 run 의 저장된 claim(출처·근거 등급)과 비용 원장
  const claimViews = selectedRun ? await listClaimsForRun(db, session.ownerId, selectedRun.id) : [];
  const ledger = selectedRun ? await getLedgerForRun(db, session.ownerId, selectedRun.id) : null;
  let proposal: ProposalView | null = null;
  if (selectedRun?.status === 'succeeded' && selectedRun.outputRef) {
    const summary = versions.find((v) => v.id === selectedRun.outputRef);
    const pv = summary ? await getContentVersion(db, session.ownerId, c.id, summary.version) : null;
    if (pv) proposal = { id: pv.version.id, version: pv.version.version, body: pv.version.body };
  }
  const savedVersion = Number(str(q.saved_version));
  const savedRow = Number.isInteger(savedVersion) ? versions.find((v) => v.version === savedVersion) : undefined;
  const prev = current.version > 1 ? current.version - 1 : null;

  return (
    <main className="container">
      <p className="now">
        <Link href="/contents">← 아카이브</Link>
      </p>
      <h2 className="screen-title">작성실 · {c.title}</h2>
      {str(q.saved) === '1' ? (
        <p className="saved" role="status">
          {`서버에 저장됨 ✓ (버전 1, ${formatMskInline(c.createdAt)})`}
        </p>
      ) : null}
      {savedRow ? (
        <p className="saved" role="status">
          {`서버에 저장됨 ✓ (버전 ${savedRow.version}, ${formatMskInline(savedRow.createdAt)})`}
        </p>
      ) : null}
      {str(q.meta_updated) === String(c.revision) ? (
        <p className="saved" role="status">
          {`정보 저장됨 ✓ (수정 ${c.revision}, ${formatMskInline(c.updatedAt)})`}
        </p>
      ) : null}
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      {w.unconfirmed.length > 0 ? (
        <p className="notice" role="alert">
          {`채택한 AI 제안에 확인하지 않은 1인칭 경험 주장이 ${w.unconfirmed.length}개 있습니다. 확인하기 전에는 "준비됨"으로 바꿀 수 없습니다.`}{' '}
          <a href="#assist">확인하러 가기</a>
        </p>
      ) : null}
      <p className="meta">
        <span className="tag">{LIFECYCLE_LABEL[c.lifecycle] ?? c.lifecycle}</span>
        {c.series ? <span>연재: {c.series}</span> : null}
        {c.tags.map((t) => (
          <span key={t} className="tag">
            #{t}
          </span>
        ))}
        <span>현재 버전 {current.version}</span>
        <span>최근 수정 {formatMsk(c.updatedAt)}</span>
      </p>
      <p className="note">배포(게시) 상태는 여기서 관리하지 않습니다. 채널별 배포 기록은 M3 배포함에서 따로 보여 줍니다.</p>

      <div className="cols">
        <section className="card archive" aria-labelledby="editor-title">
          <h3 id="editor-title">본문 (버전 {current.version} 기준)</h3>
          <form className="form" method="post" action={`/api/contents/${c.id}/versions`}>
            <input type="hidden" name="base_version" value={current.version} />
            <label htmlFor="body">본문</label>
            <textarea
              id="body"
              name="body"
              className="editor"
              rows={20}
              maxLength={MAX_CONTENT_BODY}
              defaultValue={current.body}
            />
            <label htmlFor="note">저장 메모(선택)</label>
            <input id="note" name="note" type="text" maxLength={MAX_VERSION_NOTE} />
            <button type="submit">새 버전으로 저장</button>
          </form>
          <p className="note">
            저장하면 이전 버전은 그대로 두고 새 버전을 추가합니다. 그 사이 다른 곳에서 저장했다면 두 본문을 나란히 비교하는 화면으로 갑니다.
          </p>
        </section>

        <div>
          <section className="card archive" aria-labelledby="origin-title">
            <h3 id="origin-title">원문(수집)</h3>
            {d.captures.length ? (
              <ul className="list">
                {d.captures.map((cap) => (
                  <li key={cap.id} className="capture">
                    <pre className="raw-text">{preview(cap.rawText, 400)}</pre>
                    <p className="meta">
                      <Link href={`/captures/${cap.id}`}>소재 보기</Link>
                      <time dateTime={cap.receivedAt.toISOString()}>{formatMsk(cap.receivedAt)}</time>
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-text">연결된 소재가 없습니다.</p>
            )}
            {d.idea ? (
              <p className="note">
                카드: <Link href={`/ideas/${d.idea.id}`}>{preview(d.idea.idea, 60)}</Link>
              </p>
            ) : null}
            <p className="note">파생본: M2에서 채널별 초안 추가</p>
          </section>

          <WritingPanel
            contentId={c.id}
            title={c.title}
            current={{ id: current.id, version: current.version, body: current.body }}
            state={w}
            selectedRun={selectedRun ?? null}
            claimViews={claimViews}
            ledger={ledger}
            proposal={proposal}
            answeredCount={Number.isInteger(Number(str(q.answered))) && str(q.answered) !== undefined ? Number(str(q.answered)) : null}
            confirmedCount={str(q.confirmed) !== undefined ? Number(str(q.confirmed)) : null}
          />

          <section className="card archive" aria-labelledby="versions-title">
            <h3 id="versions-title">버전</h3>
            <ul className="list">
              {versions.map((v) => (
                <li key={v.id} className="capture">
                  <p className="meta">
                    <Link href={`/contents/${c.id}/versions/${v.version}`}>버전 {v.version}</Link>
                    {v.version === current.version ? <span className="tag">현재</span> : null}
                    {v.createdBy.startsWith('ai:') || v.aiRunId ? (
                      <span className={v.createdBy.startsWith('ai:') ? 'tag warn' : 'tag'}>{versionAuthorLabel(v.createdBy, v.aiRunId)}</span>
                    ) : null}
                    <time dateTime={v.createdAt.toISOString()}>{formatMsk(v.createdAt)}</time>
                    <span>{formatBytes(v.bytes)}</span>
                    {v.version > 1 ? (
                      <Link href={`/contents/${c.id}/diff?from=${v.version - 1}&to=${v.version}`}>이전과 비교</Link>
                    ) : null}
                  </p>
                  {v.note ? <p className="note">메모: {v.note}</p> : null}
                </li>
              ))}
            </ul>
            {prev ? (
              <p className="pager">
                <Link href={`/contents/${c.id}/diff?from=1&to=${current.version}`}>처음(버전 1)과 현재 비교</Link>
              </p>
            ) : null}
          </section>

          <section className="card archive" aria-labelledby="meta-title">
            <h3 id="meta-title">원고 정보</h3>
            <form className="form" method="post" action={`/api/contents/${c.id}`}>
              <input type="hidden" name="_method" value="PATCH" />
              <input type="hidden" name="expected_revision" value={c.revision} />
              <label htmlFor="title">제목</label>
              <input id="title" name="title" type="text" maxLength={MAX_CONTENT_TITLE} required defaultValue={c.title} />
              <label htmlFor="series">연재</label>
              <input id="series" name="series" type="text" maxLength={100} defaultValue={c.series ?? ''} />
              <label htmlFor="audience">독자</label>
              <input id="audience" name="audience" type="text" maxLength={500} defaultValue={c.audience ?? ''} />
              <label htmlFor="tags">태그(쉼표로 구분)</label>
              <input id="tags" name="tags" type="text" defaultValue={c.tags.join(', ')} />
              <label htmlFor="lifecycle">상태</label>
              <select id="lifecycle" name="lifecycle" defaultValue={c.lifecycle}>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o === c.lifecycle ? `${LIFECYCLE_LABEL[o]} (현재)` : `→ ${LIFECYCLE_LABEL[o]}`}
                  </option>
                ))}
              </select>
              <button type="submit">정보 저장</button>
            </form>
            <p className="note">상태는 초안 → 검토 중 → 준비됨 → 보관 순서로 바꾸며, 한 단계씩 되돌릴 수 있습니다.</p>
          </section>
        </div>
      </div>
    </main>
  );
}
