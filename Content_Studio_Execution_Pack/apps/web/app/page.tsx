import { findOwner, listCaptures } from '@cs/db';
import { describeModes, formatMsk } from '@cs/domain';
import { getAppDb, getConfig } from '../lib/server';

export const dynamic = 'force-dynamic';

const INPUT_TYPE_LABEL: Record<string, string> = {
  text: '텍스트',
  url: 'URL',
  file: '파일',
  voice: '음성',
};
const RISK_LABEL: Record<string, string> = {
  none: '위험 표시 없음',
  needs_check: '확인 필요',
};

type CaptureRow = Awaited<ReturnType<typeof listCaptures>>[number];

function CaptureItem({ c }: { c: CaptureRow }) {
  return (
    <li className="capture">
      <p className="capture-text">{c.rawText}</p>
      <p className="meta">
        <span className="tag">{INPUT_TYPE_LABEL[c.inputType] ?? c.inputType}</span>
        <span className={c.risk === 'needs_check' ? 'tag warn' : 'tag'}>{RISK_LABEL[c.risk] ?? c.risk}</span>
        <time dateTime={c.receivedAt.toISOString()}>{formatMsk(c.receivedAt)}</time>
      </p>
      {c.userNote ? <p className="note">메모: {c.userNote}</p> : null}
    </li>
  );
}

export default async function TodayPage() {
  const config = getConfig();
  const badges = describeModes(config);
  const handle = await getAppDb(config);
  const owner = await findOwner(handle.db, config.AUTH_ALLOWED_IDENTITY);
  const captures = owner ? await listCaptures(handle.db, owner.id) : [];
  const recommended = captures.slice(0, 2);
  const needsCheck = captures.filter((c) => c.risk === 'needs_check');
  const publishLabel = badges.find((b) => b.key === 'publish')?.label ?? '게시: 비활성';

  return (
    <main className="container">
      <header className="header">
        <h1>Content Studio</h1>
        <p className="now">현재 시각: {formatMsk(new Date())}</p>
        <ul className="badges" aria-label="현재 모드">
          {badges.map((b) => (
            <li key={b.key} className={b.live ? 'badge live' : 'badge'}>
              {b.label}
            </li>
          ))}
        </ul>
      </header>

      <h2 className="screen-title">오늘</h2>

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
          <p className="empty-text">아직 초안이 없습니다</p>
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
        <h3>소재함 (가상 데이터 {captures.length}건)</h3>
        {captures.length ? (
          <ul className="list">
            {captures.map((c) => (
              <CaptureItem key={c.id} c={c} />
            ))}
          </ul>
        ) : (
          <p className="empty-text">
            <code>pnpm db:seed</code> 를 실행하세요
          </p>
        )}
      </section>
    </main>
  );
}
