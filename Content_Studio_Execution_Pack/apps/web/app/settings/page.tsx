import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listExportRuns, listRestoreRuns } from '@cs/db';
import { formatMsk } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { BACKUP_ERROR_TEXT, formatBytes } from '../../lib/backup';
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
  const { db } = await getAppDb(getConfig());
  const exports = await listExportRuns(db, session.ownerId, 20);
  const restores = await listRestoreRuns(db, session.ownerId, 10);
  const exported = str(q.exported) ? exports.find((e) => e.id === str(q.exported)) : undefined;
  const err = str(q.error) ? (BACKUP_ERROR_TEXT[str(q.error)!] ?? BACKUP_ERROR_TEXT.server) : undefined;

  return (
    <main className="container">
      <h2 className="screen-title">설정</h2>
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

      <section className="card archive" aria-labelledby="brand-title">
        <h3 id="brand-title">Brand Profile</h3>
        <p className="note">필명·독자·연재 축·말투·피할 표현·CTA 원칙·직접 쓴 예문. 저장할 때마다 새 버전이 추가됩니다.</p>
        <p>
          <Link href="/brand">Brand Profile 보기·새 버전 저장</Link>
        </p>
      </section>

      <section className="card archive" aria-labelledby="export-title">
        <h3 id="export-title">내보내기</h3>
        <p className="note">
          소재·수정 이력·출처·카드·원고(모든 버전)·원문 관계·첨부 파일을 Markdown + JSON + 파일 + checksum manifest 로 묶은 ZIP 을 만듭니다.
          로그인 세션·인증 비밀은 넣지 않습니다. 개인 원문이 들어 있으니 파일을 보관할 곳을 직접 정하세요.
        </p>
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
        <p className="note">
          내보내기 ZIP(최대 256MB)을 올리면 먼저 &quot;복원 미리보기&quot;를 만듭니다. 이 단계에서는 데이터가 바뀌지 않습니다.
          모든 파일의 sha256 을 manifest 와 대조하고, 표별로 새로 추가·동일·충돌 건수를 보여 줍니다.
        </p>
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
