/**
 * T12(결정 D19) 항목별 모의 결과 시나리오 — 개발·시험 전용(실제 채널 개념이 아니다).
 *
 * - 승인 스냅샷(distribution_items.payload_json)·계정 capability_snapshot 밖의 별도 표(mock_scenarios)에 둔다. 그래서 시나리오를 바꿔도
 *   payload hash·승인 상태가 바뀌지 않는다.
 * - 모의(kind='mock') 계정 항목에만(서버 검사 400 not_mock_account + DB 트리거 mock_scenarios_mock_only). 끝난 항목은 409.
 * - 작업 처리기(jobs.ts)가 모의 계정 항목을 보낼·조회할 때 이 표를 읽어 AdapterContext.mockScenario 로 모의 어댑터에 넘긴다
 *   (없으면 어댑터가 MOCK_CHANNEL_SCENARIO(개발·시험) → success 로 정한다).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  AppError,
  isUuid,
  MOCK_SCENARIO_VALUES,
  NotFoundError,
  NotMockAccountError,
  type MockScenarioInput,
  type MockScenarioSetting,
  type MockScenarioValue,
} from '@cs/domain';
import { lockItemsInOrder } from './approval-invalidation';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { channelAccounts, mockScenarios } from './schema';

export type MockScenarioRow = typeof mockScenarios.$inferSelect;

const FINISHED_ITEM_STATUSES = ['CONFIRMED', 'CANCELED', 'FAILED'];

const asScenario = (v: string): MockScenarioValue | null => ((MOCK_SCENARIO_VALUES as readonly string[]).includes(v) ? (v as MockScenarioValue) : null);

/** 항목의 모의 시나리오(없으면 null). 작업 처리기는 모의 계정 항목에만 부른다. */
export async function mockScenarioFor(db: DbOrTx, ownerId: string, itemId: string): Promise<MockScenarioSetting | null> {
  const rows = await db
    .select()
    .from(mockScenarios)
    .where(and(eq(mockScenarios.ownerId, ownerId), eq(mockScenarios.distributionItemId, itemId)))
    .limit(1);
  const r = rows[0];
  const scenario = r ? asScenario(r.scenario) : null;
  return r && scenario ? { scenario, delay_ms: r.delayMs } : null;
}

export async function mockScenariosForItems(db: DbOrTx, ownerId: string, itemIds: readonly string[]): Promise<Map<string, MockScenarioRow>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(mockScenarios)
    .where(and(eq(mockScenarios.ownerId, ownerId), inArray(mockScenarios.distributionItemId, [...itemIds])));
  return new Map(rows.map((r) => [r.distributionItemId, r]));
}

export function mockScenarioView(r: MockScenarioRow) {
  return {
    item_id: r.distributionItemId,
    scenario: r.scenario,
    delay_ms: r.delayMs,
    updated_at: r.updatedAt.toISOString(),
    notice: '개발용 · 모의 결과 선택 (실제 채널 없음)',
  };
}

/**
 * 항목의 모의 시나리오를 정한다(upsert, 한 트랜잭션, 항목 잠금). 다른 owner 404, 모의 계정이 아니면 400 not_mock_account,
 * 끝난 항목(CONFIRMED·CANCELED·FAILED) 409 item_finished. 승인·payload·항목 상태는 건드리지 않는다.
 */
export async function setMockScenario(db: Db, ownerId: string, itemId: string, input: MockScenarioInput, now: Date = new Date()): Promise<MockScenarioRow> {
  if (!isUuid(itemId)) throw new NotFoundError('배포 항목을 찾을 수 없습니다');
  return db.transaction(async (tx) => {
    const [item] = await lockItemsInOrder(tx, ownerId, [itemId]);
    if (!item) throw new NotFoundError('배포 항목을 찾을 수 없습니다');
    const acc = await tx
      .select({ kind: channelAccounts.kind })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.id, item.channelAccountId), eq(channelAccounts.ownerId, ownerId)))
      .limit(1);
    if (acc[0]?.kind !== 'mock') throw new NotMockAccountError();
    if (FINISHED_ITEM_STATUSES.includes(item.status)) {
      throw new AppError('conflict', 'item_finished', '이미 끝난 항목은 모의 시나리오를 바꿀 수 없습니다', { status: item.status });
    }
    const delayMs = input.delay_ms ?? 0;
    const rows = await tx
      .insert(mockScenarios)
      .values({ ownerId, distributionItemId: item.id, scenario: input.scenario, delayMs, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: mockScenarios.distributionItemId,
        set: { scenario: input.scenario, delayMs, updatedAt: now },
        setWhere: sql`${mockScenarios.ownerId} = ${ownerId}::uuid`,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new NotFoundError('배포 항목을 찾을 수 없습니다');
    await recordAudit(tx, {
      ownerId,
      action: 'item.mock_scenario',
      entity: 'distribution_item',
      entityId: item.id,
      details: { scenario: input.scenario, delay_ms: delayMs, mock: true },
      at: now,
    });
    return row;
  });
}
