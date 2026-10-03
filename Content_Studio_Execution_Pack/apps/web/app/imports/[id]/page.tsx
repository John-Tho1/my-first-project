import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getImportRun, listBackfillableImportItemIds, listImportItems, type ImportItemRow } from '@cs/db';
import {
  formatMsk,
  IMPORT_DECISION_LABEL,
  IMPORT_KIND_LABEL,
  IMPORT_OUTCOME_LABEL,
  IMPORT_SKIP_LABEL,
  type ImportDecision,
  type ImportOutcome,
  type ImportSkipReason,
  type ImportSourceKind,
} from '@cs/domain';
import { getSession } from '../../../lib/auth';
import { formatBytes } from '../../../lib/backup';
import { IMPORT_ERROR_TEXT, IMPORT_STATUS_LABEL } from '../../../lib/imports';
import { getAppDb, getConfig } from '../../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

const chipClass = (d: string) => (d === 'conflict' ? 'tag warn' : 'tag');

function groupByFolder(items: readonly ImportItemRow[]): Array<[string, ImportItemRow[]]> {
  const m = new Map<string, ImportItemRow[]>();
  for (const i of items) m.set(i.folder, [...(m.get(i.folder) ?? []), i]);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** 가져오기 미리보기 → (항목 선택) → 확정 결과. 확정 전에는 소재가 만들어지지 않는다. */
export default async function ImportRunPage({
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
  const run = await getImportRun(db, session.ownerId, id.toLowerCase());
  if (!run) notFound();
  const items = await listImportItems(db, session.ownerId, run.id);
  const preview0 = run.status === 'preview';
  // FIX-T18 round 2(P1): 원본 파일이 빠진(0039 이전에 가져온) 동일 항목 — "원본 보충" 을 고를 수 있다.
  const backfillable = preview0 ? await listBackfillableImportItemIds(db, session.ownerId, items) : new Set<string>();
  const err = str(q.error) ? (IMPORT_ERROR_TEXT[str(q.error)!] ?? IMPORT_ERROR_TEXT.server) : undefined;
  const preview = preview0;
  const groups = groupByFolder(items);
  const c = run.counts;

  return (
    <main className="container">
      <p className="now">
        <Link href="/imports">← 가져오기</Link>
      </p>
      <h2 className="screen-title">{preview ? '가져오기 미리보기' : `가져오기 — ${IMPORT_STATUS_LABEL[run.status] ?? run.status}`}</h2>
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      <p className="notice" role="note">
        원본 파일은 그대로, 이 앱 안에 사본을 만듭니다. 이미 있는 소재의 원문은 바꾸지 않습니다 — 내용이 달라진 항목(충돌)은 직접 &quot;새 버전으로 추가&quot;를 고를 때만
        새 소재로 추가합니다.
      </p>

      <section className="card archive" aria-labelledby="run-title">
        <h3 id="run-title">원본 정보</h3>
        <ul className="list">
          <li>
            원본: {IMPORT_KIND_LABEL[run.sourceKind as ImportSourceKind] ?? run.sourceKind}
            {run.sourceKind === 'mock_connector' ? ' (MOCK — 합성 예시 자료, 외부 연결 없음)' : ''}
          </li>
          {run.fileName ? <li>파일: {run.fileName}</li> : null}
          {run.fileBytes !== null ? <li>크기: {formatBytes(run.fileBytes)}</li> : null}
          {run.fileChecksum ? (
            <li>
              sha256: <span className="hash">{run.fileChecksum}</span>
            </li>
          ) : null}
          <li>미리보기: {formatMsk(run.createdAt)}</li>
          <li>
            판정: 새 항목 {c.new ?? 0} · 이미 가져옴(동일) {c.identical ?? 0} · 충돌 {c.conflict ?? 0} · 건너뜀 {c.skipped ?? 0}(그중 첨부·이미지 {c.attachments ?? 0})
          </li>
          {run.committedAt ? <li>확정: {formatMsk(run.committedAt)}</li> : null}
          {run.canceledAt ? <li>취소: {formatMsk(run.canceledAt)}</li> : null}
        </ul>
        {run.result ? (
          <p className="saved" role="status">
            가져옴(새 소재) {run.result.imported ?? 0} · 새 버전으로 추가 {run.result.versioned ?? 0} · 동일 건너뜀 {run.result.skipped_identical ?? 0} · 선택 안 함{' '}
            {run.result.skipped_unselected ?? 0} · 충돌 건너뜀 {run.result.skipped_conflict ?? 0} · 지원 안 함 {run.result.skipped_unsupported ?? 0} · 바뀜{' '}
            {run.result.failed_changed ?? 0}
            {run.result.original_backfilled ? ` · 원본 보충 ${run.result.original_backfilled}` : ''}
          </p>
        ) : null}
      </section>

      <section className="card archive" aria-labelledby="items-title">
        <h3 id="items-title">항목</h3>
        {preview ? (
          <p className="note">
            가져올 항목을 고르세요. 새 항목은 기본으로 선택되어 있습니다. 폴더 체크는 그 폴더(하위 폴더 포함)의 새 항목을 모두 고릅니다.
            동일한 항목은 다시 가져오지 않습니다.
            {backfillable.size
              ? ` 이전에 가져와 원본 파일이 빠진 동일 항목 ${backfillable.size}개는 "원본 보충" 을 고르면 올린 파일(같은 sha256)로 원본만 채웁니다 — 소재는 그대로입니다.`
              : ''}
          </p>
        ) : null}
        <form className="form" method="post" action={`/api/imports/${run.id}/commit`}>
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  {preview ? <th scope="col">선택</th> : null}
                  <th scope="col">제목·원래 경로</th>
                  <th scope="col">판정</th>
                  <th scope="col" className="num">크기</th>
                  <th scope="col">{preview ? '원본 생성 표시' : '결과'}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map(([folder, list]) => (
                  <FolderRows key={folder || '(root)'} folder={folder} list={list} preview={preview} backfillable={backfillable} />
                ))}
              </tbody>
            </table>
          </div>
          {preview ? <button type="submit">선택한 항목 가져오기(앱 안에 사본 만들기)</button> : null}
        </form>
        {preview ? (
          <form className="form inline" method="post" action={`/api/imports/${run.id}/cancel`}>
            <button type="submit" className="link-button">
              이 미리보기 취소(아무것도 가져오지 않음)
            </button>
          </form>
        ) : null}
      </section>
    </main>
  );
}

function FolderRows({
  folder,
  list,
  preview,
  backfillable,
}: {
  folder: string;
  list: ImportItemRow[];
  preview: boolean;
  backfillable: ReadonlySet<string>;
}) {
  const hasNew = list.some((i) => i.decision === 'new');
  return (
    <>
      <tr>
        <th scope="rowgroup" colSpan={preview ? 5 : 4}>
          {preview && hasNew ? (
            <label>
              <input type="checkbox" name="folder" value={folder} /> 폴더 전체: {folder || '(맨 위)'}
            </label>
          ) : (
            <>폴더: {folder || '(맨 위)'}</>
          )}
        </th>
      </tr>
      {list.map((i) => (
        <tr key={i.id}>
          {preview ? (
            <td>
              {i.decision === 'new' ? (
                <input type="checkbox" name="item" value={i.id} defaultChecked aria-label={`가져오기: ${i.title ?? i.externalPath}`} />
              ) : i.decision === 'conflict' ? (
                <label>
                  <input type="checkbox" name="version" value={i.id} /> 새 버전으로 추가
                </label>
              ) : i.decision === 'identical' && backfillable.has(i.id) ? (
                <label>
                  <input type="checkbox" name="backfill" value={i.id} /> 원본 보충
                </label>
              ) : (
                '—'
              )}
            </td>
          ) : null}
          <td>
            {i.title ?? '(제목 없음)'}
            <br />
            <span className="hash">{i.externalPath}</span>
          </td>
          <td>
            <span className={chipClass(i.decision)}>{IMPORT_DECISION_LABEL[i.decision as ImportDecision] ?? i.decision}</span>
            {i.skipReason ? ` ${IMPORT_SKIP_LABEL[i.skipReason as ImportSkipReason] ?? i.skipReason}` : ''}
          </td>
          <td className="num">{formatBytes(i.byteSize)}</td>
          <td>
            {preview ? (
              (i.externalCreatedText ?? '—')
            ) : (
              <>
                {i.outcome ? (IMPORT_OUTCOME_LABEL[i.outcome as ImportOutcome] ?? i.outcome) : '—'}
                {i.targetCaptureId ? (
                  <>
                    {' '}
                    <Link href={`/captures/${i.targetCaptureId}`}>소재 보기</Link>
                  </>
                ) : null}
              </>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}
