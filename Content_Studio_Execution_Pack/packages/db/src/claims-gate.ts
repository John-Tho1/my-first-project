/**
 * A03 게이트 조회(T06, 결정 D12). 원고의 "채택한" AI 제안들에서 사용자가 확인하지 않은 1인칭 경험 claim 을 찾는다.
 * - 채택 = 그 run 을 ai_run_id 로 가진 사용자 버전(created_by='owner')이 있음(adoptProposal 이 만든다, 불변 행).
 * - 마지막 run 만 보지 않는다: 이전에 채택한 제안의 경험 claim 이 뒤의 run 으로 가려지지 않게 모든 채택 run 을 본다.
 * - 판정 자체는 @cs/domain unconfirmedExperienceClaims(순수 함수).
 * contents.ts(상태 전이)와 writing.ts 가 함께 쓰므로 schema 외 다른 모듈을 import 하지 않는다(순환 방지).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { unconfirmedExperienceClaims, type GateClaim, type UnconfirmedClaim } from '@cs/domain';
import type { DbOrTx } from './queries';
import { claimConfirmations, contentVersions, generationRuns } from './schema';

export function claimsOf(outputJson: Record<string, unknown> | null): GateClaim[] {
  const claims = outputJson?.claims;
  if (!Array.isArray(claims)) return [];
  return claims.map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    return {
      text: typeof o.text === 'string' ? o.text : '',
      kind: typeof o.kind === 'string' ? o.kind : 'unknown',
      needs_user_confirmation: o.needs_user_confirmation !== false,
    };
  });
}

export async function listUnconfirmedExperienceClaims(tx: DbOrTx, ownerId: string, contentId: string): Promise<UnconfirmedClaim[]> {
  const runs = await tx
    .select({ id: generationRuns.id, outputJson: generationRuns.outputJson })
    .from(generationRuns)
    .where(and(eq(generationRuns.ownerId, ownerId), eq(generationRuns.contentId, contentId), eq(generationRuns.status, 'succeeded')));
  if (runs.length === 0) return [];
  const runIds = runs.map((r) => r.id);
  const adoptedRows = await tx
    .selectDistinct({ runId: contentVersions.aiRunId })
    .from(contentVersions)
    .where(
      and(eq(contentVersions.contentId, contentId), eq(contentVersions.createdBy, 'owner'), inArray(contentVersions.aiRunId, runIds)),
    );
  const adopted = new Set(adoptedRows.map((r) => r.runId));
  if (adopted.size === 0) return [];
  const confirmations = await tx
    .select({ runId: claimConfirmations.runId, claimIndex: claimConfirmations.claimIndex })
    .from(claimConfirmations)
    .where(and(eq(claimConfirmations.ownerId, ownerId), inArray(claimConfirmations.runId, runIds)));
  return unconfirmedExperienceClaims(
    runs.map((r) => ({ runId: r.id, adopted: adopted.has(r.id), claims: claimsOf(r.outputJson) })),
    confirmations,
  );
}
