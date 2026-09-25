/**
 * 작성실의 AI 제안 버튼 판정(순수 — DB·렌더 없음). FIX-T09 round 2(P2):
 * 무시(dismiss)는 채택 가능 여부와 따로 — 성공한 'proposed' 제안이면 원고 기준 버전이 달라져도(채택 불가) 무시할 수 있다.
 */
export interface ProposalRunLike {
  status: string;
  proposalStatus: string;
  inputVersionId: string;
}

export function proposalActions(
  run: ProposalRunLike | null,
  opts: { hasProposal: boolean; currentVersionId: string; adopted: boolean },
): { canAdopt: boolean; canDismiss: boolean } {
  if (!run || run.status !== 'succeeded' || run.proposalStatus !== 'proposed') return { canAdopt: false, canDismiss: false };
  return {
    canAdopt: opts.hasProposal && run.inputVersionId === opts.currentVersionId && !opts.adopted,
    canDismiss: true,
  };
}
