import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getRestoreRun, type CommitResult, type RestorePreview } from '@cs/db';
import { EXPORTED_TABLES, formatMsk } from '@cs/domain';
import { getSession } from '../../../../lib/auth';
import { BACKUP_ERROR_TEXT } from '../../../../lib/backup';
import { getAppDb, getConfig } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

const TABLE_LABEL: Record<string, string> = {
  users: '사용자(복원 안 함 — 현재 계정으로 대체)',
  brand_profiles: '브랜드 프로필',
  sources: '출처',
  source_versions: '출처 추출 기록',
  captures: '소재',
  capture_revisions: '소재 수정 이력',
  ideas: '카드',
  idea_captures: '카드↔소재 관계',
  contents: '원고',
  content_versions: '원고 버전',
  content_captures: '원고↔소재 관계',
  assets: '파일',
  audit_events: '감사 기록(복원 안 함)',
};

const REASON_LABEL: Record<string, string> = {
  different: '같은 ID, 내용 다름',
  id_in_use: '다른 계정이 쓰는 ID',
  dependency: '연결된 항목이 복원되지 않음',
  unique: '다른 고유 값 충돌',
  version_exists: '같은 버전이 이미 있음(내용 다름)',
  immutable_version: '이미 확정된(지나간) 채널 초안 버전에는 첨부를 보충하지 않음',
  snapshot_referenced: '배포 스냅샷이 쓰는 채널 초안 버전에는 첨부를 보충하지 않음',
};

/** 복원 미리보기 → (확인) → 복원 결과. 결과가 있으면 표별 복원 건수와 파일 checksum 확인 결과를 보여 준다. */
export default async function RestorePage({
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
  const run = await getRestoreRun(db, session.ownerId, id.toLowerCase());
  if (!run) notFound();
  const p = run.preview as unknown as RestorePreview;
  const result = run.result as unknown as CommitResult | null;
  const err = str(q.error) ? (BACKUP_ERROR_TEXT[str(q.error)!] ?? BACKUP_ERROR_TEXT.server) : undefined;
  const committed = run.status === 'committed' && result;

  return (
    <main className="container">
      <p className="now">
        <Link href="/settings">← 설정</Link>
      </p>
      <h2 className="screen-title">{committed ? '복원 완료: 표별 건수' : '복원 미리보기'}</h2>
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      {run.status === 'rejected' || run.status === 'failed' ? (
        <p className="notice" role="alert">
          이 미리보기는 {run.status === 'rejected' ? '파일 재검증에 실패해 거부되었습니다' : '복원 중 오류로 실패했습니다'}. 데이터는 바뀌지 않았습니다.
          파일을 다시 올려 미리보기를 만드세요.
        </p>
      ) : null}

      {committed ? (
        <section className="card archive" aria-labelledby="result-title">
          <h3 id="result-title">복원 결과 ({formatMsk(result.committed_at)})</h3>
          <p className="saved" role="status">
            복원 완료: {Object.values(result.restored).reduce((n, v) => n + v, 0)}행 추가, 동일해서 건너뜀{' '}
            {Object.values(result.skipped_identical).reduce((n, v) => n + v, 0)}행, 충돌(덮어쓰지 않음) {result.conflicts_total}건 · 파일 {result.assets_written}개 기록,
            checksum 확인 {result.assets_verified}개{result.assets_missing ? `, 원본에 없던 파일 ${result.assets_missing}개` : ''}
          </p>
          <div className="table-scroll">
            <table className="compare">
              <thead>
                <tr>
                  <th scope="col">표</th>
                  <th scope="col" className="num">추가</th>
                  <th scope="col" className="num">동일(건너뜀)</th>
                </tr>
              </thead>
              <tbody>
                {Object.keys(result.restored).map((t) => (
                  <tr key={t}>
                    <td>{TABLE_LABEL[t] ?? t}</td>
                    <td className="num">{result.restored[t]}</td>
                    <td className="num">{result.skipped_identical[t] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">방식: {result.mode === 'empty_only' ? '빈 환경에만 복원' : '없는 항목만 추가'}</p>
        </section>
      ) : null}

      <section className="card archive" aria-labelledby="manifest-title">
        <h3 id="manifest-title">파일 정보</h3>
        <ul className="list">
          <li>
            형식: {p.format} v{p.format_version} (앱 {p.app_version})
          </li>
          <li>내보낸 시각: {formatMsk(p.exported_at)}</li>
          <li>
            원래 계정: {p.bundle_owner_identity_masked} → 현재 계정으로 옮김(모든 항목의 소유자를 현재 계정으로 바꾸고 ID 는 그대로 둠)
          </li>
          <li>
            manifest sha256: <span className="hash">{p.manifest_sha256}</span>
          </li>
          <li>checksum 을 대조한 파일: {p.files_verified}개(모두 일치)</li>
          <li>
            파일(asset): {p.assets.total}개 중 {p.assets.included}개 포함, checksum 일치 {p.assets.verified}개
            {p.assets.missing ? `, 내보낼 때 없던 파일 ${p.assets.missing}개` : ''}
          </li>
          <li>DB migration: {p.schema_migrations.join(', ')}</li>
        </ul>
        {p.warnings.length ? (
          <>
            <h3>경고</h3>
            <ul className="list">
              {p.warnings.map((w, i) => (
                <li key={i} className="note">
                  {w.message}
                  {w.asset_id ? ` (파일 ${w.asset_id})` : ''}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section className="card archive" aria-labelledby="tables-title">
        <h3 id="tables-title">표별 미리보기(현재 계정 기준)</h3>
        <div className="table-scroll">
          <table className="compare">
            <thead>
              <tr>
                <th scope="col">표</th>
                <th scope="col" className="num">파일 안</th>
                <th scope="col" className="num">새로 추가</th>
                <th scope="col" className="num">동일</th>
                <th scope="col" className="num">충돌</th>
              </tr>
            </thead>
            <tbody>
              {EXPORTED_TABLES.map((t) => {
                const c = p.tables[t];
                if (!c) return null;
                return (
                  <tr key={t}>
                    <td>{TABLE_LABEL[t] ?? t}</td>
                    <td className="num">{c.in_bundle}</td>
                    <td className="num">{c.restored ? c.new : '—'}</td>
                    <td className="num">{c.restored ? c.existing_same : '—'}</td>
                    <td className="num">{c.restored ? c.existing_different : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {p.conflicts_total ? (
          <>
            <p className="notice">충돌 {p.conflicts_total}건: 기존 항목은 덮어쓰지 않습니다.</p>
            <ul className="list">
              {p.conflicts.slice(0, 50).map((c) => (
                <li key={`${c.table}:${c.id}`} className="note">
                  {TABLE_LABEL[c.table] ?? c.table} {c.id} — {REASON_LABEL[c.reason] ?? c.reason}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p className="note">
          현재 계정 데이터: 소재 {p.target.counts.captures ?? 0} · 카드 {p.target.counts.ideas ?? 0} · 원고 {p.target.counts.contents ?? 0} · 파일{' '}
          {p.target.counts.assets ?? 0} · 출처 {p.target.counts.sources ?? 0}
        </p>
      </section>

      {run.status === 'previewed' ? (
        <section className="card archive" aria-labelledby="commit-title">
          <h3 id="commit-title">복원 실행</h3>
          <form className="form" method="post" action={`/api/restores/${run.id}/commit`}>
            <label className="choice">
              <input type="radio" name="mode" value="empty_only" defaultChecked />
              <span>
                빈 환경에만 복원 — 소재·카드·원고·파일이 하나도 없을 때만 실행
                {p.can_commit_empty_only ? '' : ' (지금은 불가: 이 계정에 데이터가 있거나 충돌이 있음)'}
              </span>
            </label>
            <label className="choice">
              <input type="radio" name="mode" value="add_missing" />
              <span>없는 항목만 추가 — 이미 있는 항목은 건너뛰고, 다른 내용이어도 덮어쓰지 않음</span>
            </label>
            <label className="choice">
              <input type="checkbox" name="confirm" value="yes" required />
              <span>내용을 확인했습니다</span>
            </label>
            <button type="submit">복원</button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
