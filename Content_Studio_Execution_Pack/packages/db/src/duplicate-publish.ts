/**
 * FIX1-FULLREV2(G2, 결정 D40-1 — docs/03 "동일 본문을 새 plan으로 의도적으로 재게시하는 경우 경고 후 새 사용자 승인"):
 * 같은 owner 의 **다른** 계획에 같은 글 항목이 이미 게시됐거나(결과 기록 — USER_CONFIRMED 포함), 결과 불명이거나, 진행 중인지 찾는다.
 *
 * - 같은 글 = 같은 채널 초안 버전(variant_version_id) + 같은 계정(channel_account_id), 또는 같은 payload_hash.
 *   payload 에는 채널 초안 버전·계정 ID 가 들어 있어 hash 가 같으면 두 값도 같다 — 두 조건을 모두 보는 것은 방어선이다.
 * - 세는 상태·결과는 @cs/domain duplicatePublishKindOf 한 곳(PLANNED·CANCELED·FAILED 는 세지 않음 — 그 함수 머리 주석).
 * - 읽기 전용. 호출자의 트랜잭션(승인·실행)에서 부르면 그 트랜잭션이 잡은 잠금 아래에서 판정한다. 승인·실행의 확인값 강제는 distribution.ts.
 * - 다른 owner 의 계획·항목은 WHERE owner_id 로 보지 않는다(A01).
 */
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { duplicatePublishKindOf, type DuplicatePublishKind } from '@cs/domain';
import type { DbOrTx } from './queries';
import { channelAccounts, distributionItems, distributionPlans, publications } from './schema';

/** 다른 계획에서 찾은 같은 글 항목 하나(화면·JSON 용 — 본문·비밀 없음). */
export interface DuplicatePublish {
  /** 다른 계획의 항목 */
  itemId: string;
  planId: string;
  planSummary: string;
  planCreatedAt: Date;
  /** 그 항목의 지금 상태 */
  status: string;
  kind: DuplicatePublishKind;
  accountId: string;
  accountDisplayName: string | null;
  /** 'mock' | 'live' (계정 행이 없으면 null) */
  accountKind: string | null;
  /** 모의 기록(모의 계정 또는 MOCK 결과) — 화면은 "실제 게시"라고 하지 않는다 */
  mock: boolean;
  /** 가장 최근 결과 기록의 확인 방식(USER_CONFIRMED·VERIFIED·MOCK …, 없으면 null) */
  verification: string | null;
  /** 같은 채널 초안 버전 + 같은 계정이면 version_account, hash 만 같으면 payload_hash */
  match: 'version_account' | 'payload_hash';
}

interface DuplicateProbe {
  key: string;
  /** 이 계획의 항목은 제외(새 계획 화면은 null — 모든 계획) */
  planId: string | null;
  variantVersionId: string;
  /** null = 계정 무관(새 계획 화면: 아직 계정을 고르지 않았다) */
  channelAccountId: string | null;
  payloadHash: string | null;
}

async function duplicatesForProbes(db: DbOrTx, ownerId: string, probes: readonly DuplicateProbe[]): Promise<Map<string, DuplicatePublish[]>> {
  const out = new Map<string, DuplicatePublish[]>(probes.map((p) => [p.key, []]));
  if (probes.length === 0) return out;
  const versionIds = [...new Set(probes.map((p) => p.variantVersionId))];
  const hashes = [...new Set(probes.flatMap((p) => (p.payloadHash ? [p.payloadHash] : [])))];
  const rows = await db
    .select({
      id: distributionItems.id,
      planId: distributionItems.planId,
      variantVersionId: distributionItems.variantVersionId,
      channelAccountId: distributionItems.channelAccountId,
      payloadHash: distributionItems.payloadHash,
      status: distributionItems.status,
      planSummary: distributionPlans.targetSummary,
      planCreatedAt: distributionPlans.createdAt,
      accountDisplayName: channelAccounts.displayName,
      accountKind: channelAccounts.kind,
    })
    .from(distributionItems)
    .innerJoin(distributionPlans, and(eq(distributionPlans.id, distributionItems.planId), eq(distributionPlans.ownerId, distributionItems.ownerId)))
    .leftJoin(channelAccounts, and(eq(channelAccounts.id, distributionItems.channelAccountId), eq(channelAccounts.ownerId, distributionItems.ownerId)))
    .where(
      and(
        eq(distributionItems.ownerId, ownerId),
        hashes.length ? or(inArray(distributionItems.variantVersionId, versionIds), inArray(distributionItems.payloadHash, hashes)) : inArray(distributionItems.variantVersionId, versionIds),
      ),
    )
    .orderBy(desc(distributionItems.createdAt), desc(distributionItems.id));
  if (rows.length === 0) return out;
  const pubs = await db
    .select({ itemId: publications.itemId, verification: publications.verification, isMock: publications.isMock })
    .from(publications)
    .where(
      and(
        eq(publications.ownerId, ownerId),
        inArray(
          publications.itemId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(desc(publications.createdAt), desc(publications.id));
  const latestPub = new Map<string, { verification: string; isMock: boolean }>();
  for (const p of pubs) if (!latestPub.has(p.itemId)) latestPub.set(p.itemId, { verification: p.verification, isMock: p.isMock });
  for (const r of rows) {
    const pub = latestPub.get(r.id) ?? null;
    const kind = duplicatePublishKindOf(r.status, pub !== null);
    if (!kind) continue;
    for (const p of probes) {
      if (p.planId !== null && r.planId === p.planId) continue;
      const versionAccount = r.variantVersionId === p.variantVersionId && (p.channelAccountId === null || r.channelAccountId === p.channelAccountId);
      const sameHash = p.payloadHash !== null && r.payloadHash === p.payloadHash;
      if (!versionAccount && !sameHash) continue;
      out.get(p.key)!.push({
        itemId: r.id,
        planId: r.planId,
        planSummary: r.planSummary,
        planCreatedAt: r.planCreatedAt,
        status: r.status,
        kind,
        accountId: r.channelAccountId,
        accountDisplayName: r.accountDisplayName,
        accountKind: r.accountKind,
        mock: r.accountKind === 'mock' || pub?.isMock === true,
        verification: pub?.verification ?? null,
        match: versionAccount ? 'version_account' : 'payload_hash',
      });
    }
  }
  return out;
}

/** 이 항목들과 같은 글인 **다른 계획**의 항목(이미 게시됨·결과 불명·진행 중) — 항목 ID → 목록(새 것부터, 없으면 []). */
export async function duplicatePublishesForItems(
  db: DbOrTx,
  ownerId: string,
  items: ReadonlyArray<{ id: string; planId: string; variantVersionId: string; channelAccountId: string; payloadHash: string }>,
): Promise<Map<string, DuplicatePublish[]>> {
  return duplicatesForProbes(
    db,
    ownerId,
    items.map((i) => ({ key: i.id, planId: i.planId, variantVersionId: i.variantVersionId, channelAccountId: i.channelAccountId, payloadHash: i.payloadHash })),
  );
}

/**
 * 새 계획 화면(/distribute/new)용: 채널 초안 버전마다 그 버전을 쓴 계획 항목(계정 무관 — 아직 계정을 고르지 않았다) 중 이미 게시됨·결과 불명·진행 중인 것.
 * 버전 ID → 목록(없으면 []). 같은 계정을 고르면 그 항목과 같은 글(같은 hash)이 된다.
 */
export async function duplicatePublishesForVariantVersions(db: DbOrTx, ownerId: string, variantVersionIds: readonly string[]): Promise<Map<string, DuplicatePublish[]>> {
  return duplicatesForProbes(
    db,
    ownerId,
    [...new Set(variantVersionIds)].map((v) => ({ key: v, planId: null, variantVersionId: v, channelAccountId: null, payloadHash: null })),
  );
}

/** 응답 모양(snake_case — 이 owner 의 계획·항목 ID·상태만, 본문·비밀 없음). */
export function duplicatePublishView(d: DuplicatePublish) {
  return {
    item_id: d.itemId,
    plan_id: d.planId,
    plan_summary: d.planSummary,
    plan_created_at: d.planCreatedAt.toISOString(),
    status: d.status,
    kind: d.kind,
    account_id: d.accountId,
    account_display_name: d.accountDisplayName,
    account_kind: d.accountKind,
    mock: d.mock,
    verification: d.verification,
    match: d.match,
  };
}
