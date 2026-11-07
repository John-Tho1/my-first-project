/**
 * FIX1-FULLREV2(G2, 결정 D40-1 — docs/03 "동일 본문 재게시는 경고 후 새 승인"): 다른 계획의 같은 글이 이미 게시됨·결과 불명·진행 중이라는 경고.
 * 배포 계획 화면(항목 카드·선택 승인·실행)과 배포 계획 만들기(채널 초안 줄)가 함께 쓴다. 문구는 lib/distribution.ts(duplicateStateLabel·duplicateWarningTail —
 * duplicateWarningLine 과 같은 글자)이고 이 컴포넌트는 그리기만 한다. 계획 이름은 그 계획 화면 링크. 경고가 없으면 아무것도 그리지 않는다.
 * 안전 표시라 <details> 로 접지 않는다. 판정·강제는 서버(승인·실행 때 다시 조회 — 실제 계정 항목은 확인값 필요).
 */
import { duplicatePlanName, duplicateStateLabel, duplicateWarningTail, type DuplicatePublishLike, type DuplicateWarningStage } from './distribution';

export function DuplicatePublishWarning({
  dups,
  stage,
  heading,
}: {
  /** 화면 시험의 가짜 상세에는 없을 수 있다(없으면 경고 없음) */
  dups: readonly DuplicatePublishLike[] | undefined;
  stage: DuplicateWarningStage;
  /** 줄 앞 머리(예: 채널·계정 이름) */
  heading?: string;
}) {
  const list = dups ?? [];
  if (list.length === 0) return null;
  const live = list.some((d) => !d.mock);
  return (
    <div className="notice" role={live ? 'alert' : 'note'} data-duplicate-publish={stage}>
      <p>
        {live ? <span className="tag warn">중복 게시 주의</span> : <span className="tag mock">MOCK</span>}
        {heading ? ` ${heading}` : ''}
      </p>
      <ul className="list">
        {list.map((d) => (
          <li key={`${d.planId}:${d.itemId}`}>
            이 글은 <a href={`/distribute/${d.planId}`}>{`계획 ${duplicatePlanName(d)}`}</a>
            {`${stage === 'plan' && d.accountDisplayName ? `(계정 ${d.accountDisplayName})` : ''} 에서 ${duplicateStateLabel(d)} — ${duplicateWarningTail(stage, d.mock)}`}
          </li>
        ))}
      </ul>
    </div>
  );
}
