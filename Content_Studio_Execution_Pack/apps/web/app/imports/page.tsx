import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listImportRuns } from '@cs/db';
import { formatMsk, IMPORT_KIND_LABEL, type ImportSourceKind } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { formatBytes } from '../../lib/backup';
import { IMPORT_ERROR_TEXT, IMPORT_STATUS_LABEL } from '../../lib/imports';
import { getAppDb, getConfig } from '../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);


/**
 * 가져오기(T18, D32 제안): Notion·Drive 내보내기 ZIP 을 올려 미리보기 → 고른 항목만 앱 안 사본(소재)으로.
 * 외부 서비스에 연결하지 않는다. 커넥터(직접 연결)는 준비 중 — IMPORT_CONNECTOR_MODE=mock 일 때만 모의 자료로 시험.
 */
export default async function ImportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getSession();
  if (!session) redirect('/login');
  const q = await searchParams;
  const config = getConfig();
  const { db } = await getAppDb(config);
  const runs = await listImportRuns(db, session.ownerId, 30);
  const err = str(q.error) ? (IMPORT_ERROR_TEXT[str(q.error)!] ?? IMPORT_ERROR_TEXT.server) : undefined;
  const mock = config.IMPORT_CONNECTOR_MODE === 'mock';

  return (
    <main className="container">
      <h2 className="screen-title">가져오기 — Notion·Drive 선택 가져오기</h2>
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      <p className="notice" role="note">
        원본 파일은 그대로, 이 앱 안에 사본을 만듭니다. Notion·Drive 의 원본은 읽기만 하며 수정·삭제·이동하지 않습니다.
      </p>

      <section className="card archive" aria-labelledby="upload-title">
        <h3 id="upload-title">내보내기 파일 올리기</h3>
        <p className="note">
          Notion: 페이지 메뉴 → 내보내기 → &quot;Markdown &amp; CSV&quot; 로 받은 ZIP. Drive: 폴더 → 다운로드로 받은 ZIP(.md·.txt·.html 문서).
          최대 50MB. 텍스트(.md·.txt·.html·.csv)만 가져오고, 이미지·첨부는 목록에만 보입니다(이번 단계에서는 가져오지 않음).
        </p>
        <p className="note">올리면 먼저 미리보기를 만듭니다. 이 단계에서는 소재가 만들어지지 않습니다 — 항목을 골라 확정할 때만 만듭니다.</p>
        <form className="form" method="post" action="/api/imports/preview" encType="multipart/form-data">
          <label htmlFor="import-file">내보내기 ZIP 파일</label>
          <input id="import-file" name="file" type="file" accept=".zip,application/zip" required />
          <label htmlFor="import-kind">원본 종류</label>
          <select id="import-kind" name="source_kind" defaultValue="auto">
            <option value="auto">자동 판별(Notion 페이지 ID 가 있으면 Notion)</option>
            <option value="notion_export">Notion 내보내기</option>
            <option value="drive_export">Drive 다운로드</option>
          </select>
          <button type="submit">가져오기 미리보기 만들기</button>
        </form>
      </section>

      <section className="card archive" aria-labelledby="connector-title">
        <h3 id="connector-title">직접 연결(커넥터)</h3>
        <p className="meta">
          <span className="tag warn">준비 중(모의)</span>
        </p>
        <p className="note">
          Notion·Drive 계정에 직접 연결해 가져오는 기능은 아직 없습니다. 다른 앱에서 연결한 Notion·Drive 권한은 이 앱의 자격 증명이 아니며,
          실제 연결은 읽기 범위·자격 증명 보관을 따로 승인한 뒤에 만듭니다.
        </p>
        {mock ? (
          <form className="form inline" method="post" action="/api/imports/preview">
            <input type="hidden" name="source" value="mock_connector" />
            <button type="submit">모의 커넥터로 미리보기(MOCK — 합성 예시 자료)</button>
          </form>
        ) : (
          <p className="empty-text">커넥터 꺼짐(IMPORT_CONNECTOR_MODE=disabled).</p>
        )}
      </section>

      <section className="card archive" aria-labelledby="history-title">
        <h3 id="history-title">가져오기 기록</h3>
        {runs.length ? (
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">만든 시각</th>
                  <th scope="col">원본</th>
                  <th scope="col">상태</th>
                  <th scope="col">미리보기 판정</th>
                  <th scope="col">결과</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/imports/${r.id}`}>{formatMsk(r.createdAt)}</Link>
                    </td>
                    <td>
                      {IMPORT_KIND_LABEL[r.sourceKind as ImportSourceKind] ?? r.sourceKind}
                      {r.fileName ? ` · ${r.fileName}` : ''}
                      {r.fileBytes !== null ? ` · ${formatBytes(r.fileBytes)}` : ''}
                    </td>
                    <td>{IMPORT_STATUS_LABEL[r.status] ?? r.status}</td>
                    <td>
                      새 {r.counts.new ?? 0} · 동일 {r.counts.identical ?? 0} · 충돌 {r.counts.conflict ?? 0} · 건너뜀 {r.counts.skipped ?? 0}
                    </td>
                    <td>
                      {r.result
                        ? `가져옴 ${r.result.imported ?? 0} · 새 버전 ${r.result.versioned ?? 0} · 동일 건너뜀 ${r.result.skipped_identical ?? 0}`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-text">아직 가져오기 기록이 없습니다.</p>
        )}
      </section>
    </main>
  );
}
