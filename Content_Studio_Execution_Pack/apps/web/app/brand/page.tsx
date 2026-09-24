import Link from 'next/link';
import { redirect } from 'next/navigation';
import { listBrandProfiles } from '@cs/db';
import { BRAND_TONE_LABEL, BRAND_TONES, formatMsk, MAX_BRAND_TEXT, type BrandTone } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { getAppDb, getConfig } from '../../lib/server';
import { WRITING_ERROR_TEXT } from '../../lib/writing';

export const dynamic = 'force-dynamic';

const str = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * Brand Profile(T06, 결정 D12). 저장할 때마다 새 버전을 추가하고 이전 버전은 그대로 둔다.
 * 고용주 문서·다른 프로젝트 메모리를 자동으로 가져오는 기능은 없다 — 모든 칸은 사용자가 직접 쓴다.
 */
export default async function BrandPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect('/login');
  const q = await searchParams;
  const { db } = await getAppDb(getConfig());
  const versions = await listBrandProfiles(db, session.ownerId);
  const current = versions[0] ?? null;
  const saved = str(q.saved);
  const err = str(q.error) ? (WRITING_ERROR_TEXT[str(q.error)!] ?? WRITING_ERROR_TEXT.server) : undefined;

  return (
    <main className="container">
      <p className="now">
        <Link href="/settings">← 설정</Link>
      </p>
      <h2 className="screen-title">Brand Profile</h2>
      {saved && current && String(current.version) === saved ? (
        <p className="saved" role="status">
          {`새 버전 저장됨 ✓ (버전 ${current.version}, ${formatMsk(current.createdAt)})`}
        </p>
      ) : null}
      {err ? (
        <p className="notice" role="alert">
          {err}
        </p>
      ) : null}
      <p className="note">
        저장하면 새 버전이 추가되고 이전 버전은 바뀌지 않습니다. AI 작성 보조는 요청할 때의 버전 번호를 기록합니다. 회사 문서·다른 프로젝트 메모를 자동으로
        가져오지 않습니다 — 공개해도 되는 내용만 직접 쓰세요.
      </p>

      <section className="card archive" aria-labelledby="brand-edit-title">
        <h3 id="brand-edit-title">{current ? `현재 버전 ${current.version} 을 바탕으로 새 버전 저장` : '첫 버전 저장'}</h3>
        <form className="form" method="post" action="/api/brand">
          <input type="hidden" name="base_version" value={current?.version ?? 0} />
          <label htmlFor="pen_name">필명</label>
          <input id="pen_name" name="pen_name" type="text" maxLength={100} required defaultValue={current?.penName ?? ''} />
          <label htmlFor="audience">독자</label>
          <input id="audience" name="audience" type="text" maxLength={MAX_BRAND_TEXT} required defaultValue={current?.audience ?? ''} />
          <label htmlFor="pillars">연재 축(한 줄에 하나, 최대 5개)</label>
          <textarea id="pillars" name="pillars" rows={3} required defaultValue={current?.pillars.join('\n') ?? ''} />
          <label htmlFor="tone">말투</label>
          <select id="tone" name="tone" defaultValue={current?.tone ?? 'formal'}>
            {BRAND_TONES.map((t) => (
              <option key={t} value={t}>
                {BRAND_TONE_LABEL[t]}
              </option>
            ))}
          </select>
          <label htmlFor="style_rules">문체 원칙(한 줄에 하나)</label>
          <textarea id="style_rules" name="style_rules" rows={3} defaultValue={current?.styleRules.join('\n') ?? ''} />
          <label htmlFor="avoid_phrases">피하고 싶은 표현(한 줄에 하나)</label>
          <textarea id="avoid_phrases" name="avoid_phrases" rows={3} defaultValue={current?.avoidPhrases.join('\n') ?? ''} />
          <label htmlFor="cta_rules">CTA 원칙(한 줄에 하나)</label>
          <textarea id="cta_rules" name="cta_rules" rows={3} defaultValue={current?.ctaRules.join('\n') ?? ''} />
          <label htmlFor="sample_texts">직접 쓴 예문(빈 줄로 구분, 최대 5개) — 말투 참고용이며 예문 속 사건은 새 글의 사실로 쓰지 않습니다</label>
          <textarea id="sample_texts" name="sample_texts" rows={8} defaultValue={current?.sampleTexts.join('\n\n') ?? ''} />
          <button type="submit">새 버전으로 저장</button>
        </form>
      </section>

      <section className="card archive" aria-labelledby="brand-versions-title">
        <h3 id="brand-versions-title">버전</h3>
        {versions.length ? (
          <ul className="list">
            {versions.map((v) => (
              <li key={v.id} className="capture">
                <p className="meta">
                  <span>버전 {v.version}</span>
                  {v.id === current?.id ? <span className="tag">현재</span> : null}
                  <time dateTime={v.createdAt.toISOString()}>{formatMsk(v.createdAt)}</time>
                  <span>{BRAND_TONE_LABEL[v.tone as BrandTone] ?? v.tone}</span>
                </p>
                <p className="note">
                  {v.penName} · 독자: {v.audience} · 연재 축: {v.pillars.join(', ')}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-text">아직 Brand Profile 이 없습니다.</p>
        )}
      </section>
    </main>
  );
}
