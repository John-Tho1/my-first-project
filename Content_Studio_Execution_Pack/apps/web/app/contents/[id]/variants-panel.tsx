/**
 * 작성실 T09 영역(서버 컴포넌트, 스크립트 없음): 채널 초안(Threads·Instagram·YouTube·블로그).
 * 초안 만들기 / AI 초안(모의) / 편집 / 미디어 붙이기 / 검토로 / 배포 파일 만들기 — 모두 plain HTML 폼.
 * 게시는 없다(PUBLISH_MODE=disabled). 배포 파일은 수동 게시용이며 승인이 아니다.
 * T10: 검토 중 초안 → "배포 계획 만들기"(배포함, MOCK), 승인됨 초안 → 계획 링크. 승인됨은 배포함에서 철회해야 상태를 바꿀 수 있다.
 */
import type { AssetRow, VariantState } from '@cs/db';
import { CHANNEL_LABEL, CHANNELS, formatMsk, VARIANT_BODY_MAX, VARIANT_ROLES, type Channel } from '@cs/domain';
import { MOCK_WARNING } from '@cs/providers';
import { preview } from '../../../lib/labels';

const LIFECYCLE: Record<string, string> = { draft: '초안', review: '검토 중', approved: '승인됨' };
const ROLE_LABEL: Record<string, string> = { image: '이미지', video: '영상', thumbnail: '썸네일', attachment: '첨부' };

export function VariantsPanel({
  contentId,
  coreVersion,
  states,
  assets,
  packages,
  savedChannel,
  newPackageId,
  contentTitle,
  planByVariant,
}: {
  contentId: string;
  coreVersion: number;
  states: VariantState[];
  assets: AssetRow[];
  packages: Array<{ id: string; bytes: number; createdAt: Date }>;
  savedChannel: string | null;
  newPackageId: string | null;
  contentTitle: string;
  /** T10: 파생본 id → 가장 최근 배포 계획 id */
  planByVariant: Map<string, string>;
}) {
  const byChannel = new Map(states.map((s) => [s.variant.channel, s]));
  return (
    <section className="card archive" id="variants" aria-labelledby="variants-title">
      <h3 id="variants-title">채널 초안</h3>
      <p className="note">
        원고(버전 {coreVersion})에서 채널별 초안을 만듭니다. 원고가 바뀌면 초안에 &quot;원문이 바뀜 — 재검토 필요&quot;가 표시되고, AI 가 자동으로 다시 만들지
        않습니다. 게시는 하지 않습니다(자동 게시 없음).
      </p>
      {savedChannel ? (
        <p className="saved" role="status">
          {`${CHANNEL_LABEL[savedChannel as Channel] ?? savedChannel} 초안 저장됨 ✓`}
        </p>
      ) : null}
      {CHANNELS.map((ch) => {
        const s = byChannel.get(ch);
        const cur = s?.current ?? null;
        return (
          <div key={ch} className="capture">
            <h4>{CHANNEL_LABEL[ch]}</h4>
            {s && cur ? (
              <>
                <p className="meta">
                  <span className="tag">{LIFECYCLE[s.variant.lifecycle] ?? s.variant.lifecycle}</span>
                  <span>버전 {cur.version}</span>
                  {cur.createdBy === 'owner' && cur.aiRunId ? <span className="tag">AI 제안 채택</span> : null}
                  {s.stale ? <span className="tag warn">원문이 바뀜 — 재검토 필요</span> : null}
                  <span className={s.media.complete ? 'tag' : 'tag warn'}>
                    {s.media.complete ? '미디어 준비됨' : `미디어 부족: ${s.media.missing.join(', ')}`}
                  </span>
                  <time dateTime={cur.createdAt.toISOString()}>{formatMsk(cur.createdAt)}</time>
                </p>
                <pre className="raw-text">{preview(cur.body, 600)}</pre>
                {s.assets.length ? (
                  <p className="meta">
                    {s.assets.map((a) => (
                      <span key={a.position}>
                        {a.position}. {ROLE_LABEL[a.role] ?? a.role} · {a.mime}
                      </span>
                    ))}
                  </p>
                ) : null}
                {s.unresolvedClaims.length ? (
                  <p className="notice" role="alert">
                    이 초안의 AI 제안에 확인하지 않은 1인칭 경험 주장이 {s.unresolvedClaims.length}개 있습니다: {s.unresolvedClaims.map((c) => c.text).join(' / ')}
                  </p>
                ) : null}
                <details>
                  <summary>편집</summary>
                  <form className="form" method="post" action={`/api/variants/${s.variant.id}/versions`}>
                    <input type="hidden" name="base_version" value={cur.version} />
                    <label htmlFor={`vb-${ch}`}>본문</label>
                    <textarea id={`vb-${ch}`} name="body" rows={8} maxLength={VARIANT_BODY_MAX} defaultValue={cur.body} />
                    <label htmlFor={`vm-${ch}`}>채널 형식(JSON)</label>
                    <textarea id={`vm-${ch}`} name="metadata" rows={8} defaultValue={JSON.stringify(cur.metadataJson, null, 2)} />
                    <button type="submit">새 버전으로 저장</button>
                  </form>
                </details>
                <details>
                  <summary>미디어 붙이기</summary>
                  {assets.length ? (
                    <form className="form inline" method="post" action={`/api/variants/${s.variant.id}/assets`}>
                      <label htmlFor={`va-${ch}`}>파일</label>
                      <select id={`va-${ch}`} name="asset_id">
                        {assets.map((a) => (
                          <option key={a.id} value={a.id}>
                            {`${a.mime} · ${a.bytes} B · ${a.checksum.slice(0, 8)}`}
                          </option>
                        ))}
                      </select>
                      <label htmlFor={`vr-${ch}`}>역할</label>
                      <select id={`vr-${ch}`} name="role" defaultValue={ch === 'youtube' ? 'video' : 'image'}>
                        {VARIANT_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                      <button type="submit">붙이기(새 버전)</button>
                    </form>
                  ) : (
                    <p className="empty-text">올린 파일이 없습니다. 소재함에서 파일을 먼저 올리세요.</p>
                  )}
                  <p className="note">완성 영상 업로드는 아직 지원하지 않습니다(이미지·PDF·텍스트만). YouTube 는 영상이 붙기 전까지 검토로 보낼 수 없습니다.</p>
                </details>
                {s.variant.lifecycle === 'approved' ? (
                  <p className="note">
                    <span className="tag">승인됨</span> 배포 승인이 있는 초안입니다(MOCK). 수정·첨부 변경은 승인을 무효로 합니다.{' '}
                    {planByVariant.get(s.variant.id) ? <a href={`/distribute/${planByVariant.get(s.variant.id)}`}>배포 계획 보기</a> : null}
                  </p>
                ) : (
                  <form className="form inline" method="post" action={`/api/variants/${s.variant.id}/lifecycle`}>
                    <input type="hidden" name="base_version" value={cur.version} />
                    <input type="hidden" name="lifecycle" value={s.variant.lifecycle === 'review' ? 'draft' : 'review'} />
                    <button type="submit">{s.variant.lifecycle === 'review' ? '초안으로 되돌리기' : '검토로'}</button>
                  </form>
                )}
                {s.variant.lifecycle === 'review' ? (
                  <p className="note">
                    <a href={`/distribute/new?content_id=${contentId}`}>배포 계획 만들기</a> (MOCK — 계획 뒤에 채널별 내용을 확인하고 직접 승인)
                    {planByVariant.get(s.variant.id) ? (
                      <>
                        {' · '}
                        <a href={`/distribute/${planByVariant.get(s.variant.id)}`}>최근 배포 계획</a>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="empty-text">아직 초안이 없습니다.</p>
            )}
            {s?.proposal ? (
              <div className="assist-run">
                <p className="notice" role="note">
                  {MOCK_WARNING} — AI 초안(모의, 버전 {s.proposal.version})은 채택하기 전까지 현재 초안이 아닙니다.
                </p>
                <pre className="raw-text">{preview(s.proposal.body, 400)}</pre>
                <form className="form inline" method="post" action={`/api/variants/${s.variant.id}/adopt/${s.proposal.id}`}>
                  <input type="hidden" name="base_version" value={cur?.version ?? 0} />
                  <button type="submit">AI 초안 채택(새 버전)</button>
                </form>
                {s.proposal.aiRunId ? (
                  <form className="form inline" method="post" action={`/api/variants/${s.variant.id}/proposals/${s.proposal.aiRunId}/dismiss`}>
                    <button type="submit">무시(목록에서 빼기)</button>
                  </form>
                ) : null}
              </div>
            ) : null}
            <form className="form inline" method="post" action={`/api/contents/${contentId}/variants`}>
              <input type="hidden" name="channel" value={ch} />
              <input type="hidden" name="base_version" value={coreVersion} />
              <input type="hidden" name="mode" value="draft" />
              <button type="submit">{s?.stale ? '현재 원문으로 다시 초안' : cur ? '원문에서 다시 초안' : '초안 만들기'}</button>
            </form>
            <form className="form inline" method="post" action={`/api/contents/${contentId}/variants`}>
              <input type="hidden" name="channel" value={ch} />
              <input type="hidden" name="base_version" value={coreVersion} />
              <input type="hidden" name="mode" value="ai_draft" />
              <button type="submit">AI 초안(모의)</button>
            </form>
          </div>
        );
      })}
      <h4>배포 파일 — {contentTitle}</h4>
      <p className="notice" role="note">
        배포 파일(수동 게시용). 자동 게시 아님 — 파일을 받는 것은 승인이나 게시가 아닙니다.
      </p>
      {newPackageId ? (
        <p className="saved" role="status">
          배포 파일 생성됨 ✓ <a href={`/api/packages/${newPackageId}`}>내려받기</a>
        </p>
      ) : null}
      <form className="form inline" method="post" action={`/api/contents/${contentId}/package`}>
        <button type="submit">배포 파일 만들기(ZIP)</button>
      </form>
      {packages.length ? (
        <ul className="list">
          {packages.map((p) => (
            <li key={p.id}>
              <a href={`/api/packages/${p.id}`}>{formatMsk(p.createdAt)}</a> · {p.bytes} B
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
