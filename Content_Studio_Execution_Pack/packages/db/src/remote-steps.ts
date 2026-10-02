/**
 * T14(결정 D26) 원격 단계 기록(remote_steps) — 두 단계 게시(Threads: 컨테이너 생성 → 게시)의 원격 참조.
 *
 * - 어댑터는 작업 처리기가 넣어 준 창구(RemoteStepsPort)로만 읽고 쓴다. 호출마다 **자기 짧은 트랜잭션** — 원격 호출 동안 DB 잠금을 잡지 않는다.
 * - 같은 (작업, 게시물 순서, 종류)는 한 행: 처음 기록 뒤 remote_id 는 바뀌지 않는다(다른 ID 로 기록하려 하면 409 remote_step_conflict —
 *   "같은 게시물에 컨테이너 두 개" 같은 중복을 막는다). 상태는 created → finished|error, 게시는 published 하나뿐(DB 트리거도 강제).
 * - 로컬 요청 제한(D26)은 이 표에서 센다(새 표 없음): 창 안에서 그 계정으로 게시된(publish·published) 단계 수.
 * - ID 는 모의 ID 만(CHECK remote_id LIKE 'mock%'). 토큰·본문은 넣지 않는다.
 */
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { AppError, type RemoteStep, type RemoteStepKind, type RemoteStepStatus, type RemoteStepsPort } from '@cs/domain';
import type { Db } from './client';
import type { DbOrTx } from './queries';
import { distributionItems, remoteSteps, sendIntents } from './schema';

export type RemoteStepRow = typeof remoteSteps.$inferSelect;

export function remoteStepOf(r: RemoteStepRow): RemoteStep {
  return {
    kind: r.kind as RemoteStepKind,
    post_index: r.postIndex,
    step_index: r.stepIndex,
    remote_id: r.remoteId,
    status: r.status as RemoteStepStatus,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/** 화면·API 용(모의 ID 만, 토큰·본문 없음). */
export function remoteStepView(r: RemoteStepRow) {
  return { job_id: r.jobId, ...remoteStepOf(r), mock: r.remoteId.startsWith('mock') };
}

export async function listRemoteSteps(db: DbOrTx, ownerId: string, jobId: string): Promise<RemoteStepRow[]> {
  return db
    .select()
    .from(remoteSteps)
    .where(and(eq(remoteSteps.ownerId, ownerId), eq(remoteSteps.jobId, jobId)))
    .orderBy(asc(remoteSteps.stepIndex));
}

export async function listRemoteStepsForItems(db: DbOrTx, ownerId: string, itemIds: readonly string[]): Promise<RemoteStepRow[]> {
  if (itemIds.length === 0) return [];
  return db
    .select()
    .from(remoteSteps)
    .where(and(eq(remoteSteps.ownerId, ownerId), inArray(remoteSteps.itemId, [...itemIds])))
    .orderBy(asc(remoteSteps.jobId), asc(remoteSteps.stepIndex));
}

const STATUS_RANK: Record<string, number> = { created: 0, finished: 1, error: 2, published: 3 };

/**
 * 단계 기록(한 트랜잭션). 없으면 넣고(step_index = 그 작업의 다음 번호, intent = 지금 시도의 전송 의도), 있으면 같은 remote_id 일 때만
 * 상태를 앞으로만 바꾼다(created 로 되돌리지 않음, published 는 그대로). 다른 remote_id 면 409 remote_step_conflict.
 */
export async function recordRemoteStep(
  db: Db,
  input: { ownerId: string; jobId: string; itemId: string; intentKey: string; kind: RemoteStepKind; postIndex: number; remoteId: string; status: RemoteStepStatus; now: Date },
): Promise<RemoteStepRow> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(remoteSteps)
      .where(and(eq(remoteSteps.ownerId, input.ownerId), eq(remoteSteps.jobId, input.jobId), eq(remoteSteps.postIndex, input.postIndex), eq(remoteSteps.kind, input.kind)))
      .for('update')
      .limit(1);
    const row = existing[0];
    if (row) {
      if (row.remoteId !== input.remoteId) {
        throw new AppError('conflict', 'remote_step_conflict', '같은 게시물 단계에 다른 원격 ID 를 기록할 수 없습니다', { kind: input.kind, post_index: input.postIndex });
      }
      if (row.status === input.status || (STATUS_RANK[input.status] ?? 0) < (STATUS_RANK[row.status] ?? 0) || row.status === 'published') return row;
      const updated = await tx
        .update(remoteSteps)
        .set({ status: input.status, updatedAt: input.now })
        .where(and(eq(remoteSteps.id, row.id), eq(remoteSteps.ownerId, input.ownerId)))
        .returning();
      return updated[0]!;
    }
    const intent = await tx
      .select({ id: sendIntents.id })
      .from(sendIntents)
      .where(and(eq(sendIntents.ownerId, input.ownerId), eq(sendIntents.jobId, input.jobId), eq(sendIntents.intentKey, input.intentKey)))
      .limit(1);
    if (!intent[0]) throw new AppError('conflict', 'remote_step_no_intent', '전송 의도 없이 원격 단계를 기록할 수 없습니다');
    const next = await tx
      .select({ n: sql<number>`coalesce(max(${remoteSteps.stepIndex}) + 1, 0)::int` })
      .from(remoteSteps)
      .where(eq(remoteSteps.jobId, input.jobId));
    const inserted = await tx
      .insert(remoteSteps)
      .values({
        ownerId: input.ownerId,
        jobId: input.jobId,
        intentId: intent[0].id,
        itemId: input.itemId,
        stepIndex: Number(next[0]?.n ?? 0),
        kind: input.kind,
        postIndex: input.postIndex,
        remoteId: input.remoteId,
        status: input.status,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    return inserted[0]!;
  });
}

/** 작업 하나의 단계 창구(어댑터용). */
export function remoteStepsPort(db: Db, input: { ownerId: string; jobId: string; itemId: string; intentKey: string; clock: () => Date }): RemoteStepsPort {
  return {
    list: async () => (await listRemoteSteps(db, input.ownerId, input.jobId)).map(remoteStepOf),
    record: async (step) =>
      remoteStepOf(
        await recordRemoteStep(db, {
          ownerId: input.ownerId,
          jobId: input.jobId,
          itemId: input.itemId,
          intentKey: input.intentKey,
          kind: step.kind,
          postIndex: step.post_index,
          remoteId: step.remote_id,
          status: step.status,
          now: input.clock(),
        }),
      ),
  };
}

/** 이 작업에서 이미 게시된 게시물 수(요청 제한의 "남은 단위" 계산). */
export async function publishedStepCount(db: DbOrTx, ownerId: string, jobId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(remoteSteps)
    .where(and(eq(remoteSteps.ownerId, ownerId), eq(remoteSteps.jobId, jobId), eq(remoteSteps.kind, 'publish')));
  return Number(rows[0]?.n ?? 0);
}

/** 계정의 창 안 게시 수와 가장 오래된 게시 시각(로컬 요청 제한 — 단계 기록에서 파생, 새 표 없음). */
export async function recentPublishUsage(db: DbOrTx, ownerId: string, accountId: string, since: Date): Promise<{ used: number; oldestAt: Date | null }> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${remoteSteps.createdAt})` })
    .from(remoteSteps)
    .innerJoin(distributionItems, and(eq(distributionItems.id, remoteSteps.itemId), eq(distributionItems.ownerId, remoteSteps.ownerId)))
    .where(
      and(
        eq(remoteSteps.ownerId, ownerId),
        eq(distributionItems.channelAccountId, accountId),
        eq(remoteSteps.kind, 'publish'),
        gte(remoteSteps.createdAt, since),
      ),
    );
  const r = rows[0];
  return { used: Number(r?.n ?? 0), oldestAt: r?.oldest ? new Date(r.oldest) : null };
}
