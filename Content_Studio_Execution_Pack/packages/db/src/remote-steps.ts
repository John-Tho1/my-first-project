/**
 * T14(결정 D26) 원격 단계 기록(remote_steps) — 두 단계 게시(Threads: 컨테이너 생성 → 게시)의 원격 참조.
 *
 * - 어댑터는 작업 처리기가 넣어 준 창구(RemoteStepsPort)로만 읽고 쓴다. 호출마다 **자기 짧은 트랜잭션** — 원격 호출 동안 DB 잠금을 잡지 않는다.
 * - 같은 (작업, 게시물 순서, 종류)는 한 행: 처음 기록 뒤 remote_id 는 바뀌지 않는다(다른 ID 로 기록하려 하면 409 remote_step_conflict —
 *   "같은 게시물에 컨테이너 두 개" 같은 중복을 막는다). 상태는 created → finished|error, 게시는 published 하나뿐(DB 트리거도 강제).
 * - 로컬 요청 제한(D26)은 이 표에서 센다(새 표 없음): 창 안에서 그 계정으로 게시된(publish·published) 단계 수.
 * - ID 는 모의 ID 만(CHECK remote_id LIKE 'mock%'). 토큰·본문은 넣지 않는다.
 */
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
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
    received_bytes: r.receivedBytes ?? null,
    total_bytes: r.totalBytes ?? null,
    resume_count: r.resumeCount ?? 0,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

/**
 * T15(D27): 업로드 세션 URI 는 원격 업로드 권한이 담긴 값으로 다룬다(docs/02 — 브라우저·로그·AI 입력에 넣지 않는다). 화면·API·감사에는
 * 짧은 표시(`세션 있음`)만 — 모의 값(mock://…)이어도 같은 규칙.
 */
export const SESSION_URI_LABEL = '세션 있음';
export function redactRemoteId(kind: string, remoteId: string): string {
  return kind === 'upload_session' ? SESSION_URI_LABEL : remoteId;
}

/** 화면·API 용(모의 ID 만, 토큰·본문·세션 URI 없음). */
export function remoteStepView(r: RemoteStepRow) {
  const s = remoteStepOf(r);
  return { job_id: r.jobId, ...s, remote_id: redactRemoteId(r.kind, r.remoteId), mock: r.remoteId.startsWith('mock') };
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

const STATUS_RANK: Record<string, number> = { created: 0, uploaded: 1, finished: 1, error: 2, expired: 2, published: 3, processed: 3 };
/** 끝난 상태(DB 트리거도 바꾸지 못하게 한다) */
const FINAL_STATUSES = new Set(['published', 'processed', 'expired', 'error']);

/**
 * 단계 기록(한 트랜잭션). 없으면 넣고(step_index = 그 작업의 다음 번호, intent = 지금 시도의 전송 의도), 있으면 같은 remote_id 일 때만
 * 상태를 앞으로만 바꾼다(created 로 되돌리지 않음, 끝난 상태는 그대로). 다른 remote_id 면 409 remote_step_conflict.
 * T15: received_bytes 는 앞으로만(더 작은 값은 409 remote_step_regress — 원격이 확인한 값만 기록하므로 줄어들면 원격 상태가 이상하다),
 * total_bytes 는 처음 값과 같아야 하고(다르면 409), resumed 면 resume_count + 1.
 */
export async function recordRemoteStep(
  db: Db,
  input: {
    ownerId: string;
    jobId: string;
    itemId: string;
    intentKey: string;
    kind: RemoteStepKind;
    postIndex: number;
    remoteId: string;
    status: RemoteStepStatus;
    now: Date;
    receivedBytes?: number;
    totalBytes?: number;
    resumed?: boolean;
  },
): Promise<RemoteStepRow> {
  return db.transaction(async (tx) => {
    // FIX-T14 round 2(Codex review-FIX-T14 P1): 단계 기록(사용량·남은 단위를 바꾸는 쓰기)은 그 계정의 요청 제한 잠금(cs_rate:<계정>)을 **공유**로 잡는다.
    // 검사(beginSend)는 같은 잠금을 배타로 잡으므로, 검사 도중에는 어떤 단계 기록도 커밋되지 않는다(기록끼리는 서로 막지 않음).
    // 검사가 이미 한 스냅샷으로 읽으므로 이것은 두 번째 방어선이다. 잠금 순서: 이 잠금 → 단계 행(FOR UPDATE) — 검사 쪽은 단계 행을 잠그지 않는다.
    const accRow = await tx
      .select({ accountId: distributionItems.channelAccountId })
      .from(distributionItems)
      .where(and(eq(distributionItems.id, input.itemId), eq(distributionItems.ownerId, input.ownerId)))
      .limit(1);
    if (accRow[0]) await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${`cs_rate:${accRow[0].accountId}`}))`);
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
      if (input.totalBytes !== undefined && row.totalBytes !== null && row.totalBytes !== input.totalBytes) {
        throw new AppError('conflict', 'remote_step_conflict', '같은 업로드 세션의 전체 크기를 바꿀 수 없습니다', { kind: input.kind, post_index: input.postIndex });
      }
      if (input.receivedBytes !== undefined && row.receivedBytes !== null && input.receivedBytes < row.receivedBytes) {
        throw new AppError('conflict', 'remote_step_regress', '업로드 세션의 받은 바이트 수는 줄어들 수 없습니다', { kind: input.kind, post_index: input.postIndex });
      }
      const statusForward =
        row.status !== input.status && !FINAL_STATUSES.has(row.status) && (STATUS_RANK[input.status] ?? 0) >= (STATUS_RANK[row.status] ?? 0);
      const set: Partial<typeof remoteSteps.$inferInsert> = {};
      if (statusForward) set.status = input.status;
      if (input.receivedBytes !== undefined && (row.receivedBytes === null || input.receivedBytes > row.receivedBytes)) set.receivedBytes = input.receivedBytes;
      if (input.totalBytes !== undefined && row.totalBytes === null) set.totalBytes = input.totalBytes;
      if (input.resumed) set.resumeCount = row.resumeCount + 1;
      if (Object.keys(set).length === 0) return row;
      const updated = await tx
        .update(remoteSteps)
        .set({ ...set, updatedAt: input.now })
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
        receivedBytes: input.receivedBytes ?? null,
        totalBytes: input.totalBytes ?? null,
        resumeCount: 0,
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
          receivedBytes: step.received_bytes,
          totalBytes: step.total_bytes,
          resumed: step.resumed,
        }),
      ),
  };
}

/** 이 작업에서 이미 쓴 요청 제한 단위 수(기본 게시 단계 — T15 는 업로드 세션 단계). 요청 제한의 "남은 단위" 계산. */
export async function publishedStepCount(db: DbOrTx, ownerId: string, jobId: string, kinds: readonly RemoteStepKind[] = ['publish']): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(remoteSteps)
    .where(and(eq(remoteSteps.ownerId, ownerId), eq(remoteSteps.jobId, jobId), inArray(remoteSteps.kind, [...kinds])));
  return Number(rows[0]?.n ?? 0);
}

/**
 * 계정의 창 안 사용 단위 수와 가장 오래된 사용 시각(로컬 요청 제한 — 단계 기록에서 파생, 새 표 없음).
 * 기본은 게시 단계(Threads), T15 YouTube 는 업로드 세션 단계(업로드 시작 = 할당량 사용).
 */
export async function recentPublishUsage(
  db: DbOrTx,
  ownerId: string,
  accountId: string,
  since: Date,
  kinds: readonly RemoteStepKind[] = ['publish'],
): Promise<{ used: number; oldestAt: Date | null }> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${remoteSteps.createdAt})` })
    .from(remoteSteps)
    .innerJoin(distributionItems, and(eq(distributionItems.id, remoteSteps.itemId), eq(distributionItems.ownerId, remoteSteps.ownerId)))
    .where(
      and(
        eq(remoteSteps.ownerId, ownerId),
        eq(distributionItems.channelAccountId, accountId),
        inArray(remoteSteps.kind, [...kinds]),
        gt(remoteSteps.createdAt, since),
      ),
    );
  const r = rows[0];
  return { used: Number(r?.n ?? 0), oldestAt: r?.oldest ? new Date(r.oldest) : null };
}

/** FIX-T14 round 2: 요청 제한 스냅샷 안의 진행 중 작업 하나(그 작업의 지금 시도 의도·항목 스냅샷 열·단계). */
export interface RateInflightJob {
  jobId: string;
  intentDetails: Record<string, unknown> | null;
  item: { id: string; payloadJson: Record<string, unknown>; payloadHash: string; visibility: string; requestedResult: string; scheduledAtUtc: Date | null };
  steps: RemoteStep[];
}
export interface AccountRateSnapshot {
  used: number;
  oldestAt: Date | null;
  /** 검사하는 작업 자신의 단계(이번 시도의 새 단위 계산) */
  ownSteps: RemoteStep[];
  inflight: RateInflightJob[];
}

const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
const stepJson = (alias: string) =>
  sql.raw(
    `json_build_object('kind', ${alias}.kind, 'post_index', ${alias}.post_index, 'step_index', ${alias}.step_index, 'remote_id', ${alias}.remote_id, ` +
      `'status', ${alias}.status, 'received_bytes', ${alias}.received_bytes, 'total_bytes', ${alias}.total_bytes, 'resume_count', ${alias}.resume_count, ` +
      `'created_at', ${alias}.created_at, 'updated_at', ${alias}.updated_at)`,
  );
function stepFromJson(r: Record<string, unknown>): RemoteStep {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    kind: r.kind as RemoteStepKind,
    post_index: Number(r.post_index),
    step_index: Number(r.step_index),
    remote_id: String(r.remote_id),
    status: r.status as RemoteStepStatus,
    received_bytes: num(r.received_bytes),
    total_bytes: num(r.total_bytes),
    resume_count: Number(r.resume_count ?? 0),
    created_at: new Date(String(r.created_at)).toISOString(),
    updated_at: new Date(String(r.updated_at)).toISOString(),
  };
}

/**
 * FIX-T14 round 2(Codex review-FIX-T14 P1): 계정의 로컬 요청 제한 판단에 필요한 상태를 **한 SQL 문장**(= READ COMMITTED 에서도 한 스냅샷)으로 읽는다 —
 * 창 안 사용 단위 수·가장 오래된 사용 시각, 검사하는 작업의 단계, 같은 계정에서 진행 중(states)인 다른 작업의 지금 시도 의도·항목·단계.
 * 이전에는 사용량과 진행 중 예약을 서로 다른 문장으로 읽어, 그 사이에 다른 작업이 게시 단계를 기록하고 끝나면(사용량에도 예약에도 안 잡힘)
 * 한도를 넘을 수 있었다. 한 스냅샷에서는 진행 중 작업의 단계 기록이 "예약 → 사용"으로 옮겨 갈 뿐 합계가 줄지 않는다.
 * 호출자는 계정 advisory 잠금(cs_rate:<계정>)을 잡은 **뒤** 부른다(그래야 앞선 검사의 전송 의도가 이 스냅샷에 보인다).
 */
export async function accountRateSnapshot(
  tx: DbOrTx,
  input: { ownerId: string; accountId: string; jobId: string; since: Date; kinds: readonly RemoteStepKind[]; inflightStates: readonly string[] },
): Promise<AccountRateSnapshot> {
  const kinds = sql.join(
    input.kinds.map((k) => sql`${k}`),
    sql`, `,
  );
  const states = sql.join(
    input.inflightStates.map((s) => sql`${s}`),
    sql`, `,
  );
  const res = await tx.execute(sql`
    select
      u.used, u.oldest,
      (select coalesce(json_agg(${stepJson('s')} order by s.step_index), '[]'::json)
         from remote_steps s where s.owner_id = ${input.ownerId}::uuid and s.job_id = ${input.jobId}::uuid) as own_steps,
      (select coalesce(json_agg(json_build_object(
                'job_id', j.id,
                'intent_details', si.sanitized_details,
                'item', json_build_object('id', di.id, 'payload_json', di.payload_json, 'payload_hash', di.payload_hash, 'visibility', di.visibility,
                                          'requested_result', di.requested_result, 'scheduled_at_utc', di.scheduled_at_utc),
                'steps', (select coalesce(json_agg(${stepJson('s2')} order by s2.step_index), '[]'::json)
                            from remote_steps s2 where s2.owner_id = j.owner_id and s2.job_id = j.id)
              ) order by j.id), '[]'::json)
         from jobs j
         join distribution_items di on di.id = j.item_id and di.owner_id = j.owner_id
         left join send_intents si on si.owner_id = j.owner_id and si.job_id = j.id and si.attempt = j.attempt
        where j.owner_id = ${input.ownerId}::uuid and di.channel_account_id = ${input.accountId}::uuid
          and j.state in (${states}) and j.id <> ${input.jobId}::uuid and j.attempt > 0) as inflight
    from (
      select count(*)::int as used, min(rs.created_at) as oldest
        from remote_steps rs
        join distribution_items di on di.id = rs.item_id and di.owner_id = rs.owner_id
       where rs.owner_id = ${input.ownerId}::uuid and di.channel_account_id = ${input.accountId}::uuid
         and rs.kind in (${kinds}) and rs.created_at > ${input.since.toISOString()}::timestamptz
    ) u`);
  const row = (res as unknown as { rows: Array<{ used: number; oldest: string | Date | null; own_steps: unknown; inflight: unknown }> }).rows[0];
  const inflight = parseJson<Array<Record<string, unknown>>>(row?.inflight ?? '[]').map((j): RateInflightJob => {
    const item = j.item as Record<string, unknown>;
    return {
      jobId: String(j.job_id),
      intentDetails: (j.intent_details as Record<string, unknown> | null) ?? null,
      item: {
        id: String(item.id),
        payloadJson: (item.payload_json as Record<string, unknown>) ?? {},
        payloadHash: String(item.payload_hash),
        visibility: String(item.visibility),
        requestedResult: String(item.requested_result),
        scheduledAtUtc: item.scheduled_at_utc ? new Date(String(item.scheduled_at_utc)) : null,
      },
      steps: ((j.steps as Array<Record<string, unknown>>) ?? []).map(stepFromJson),
    };
  });
  return {
    used: Number(row?.used ?? 0),
    oldestAt: row?.oldest ? new Date(row.oldest) : null,
    ownSteps: parseJson<Array<Record<string, unknown>>>(row?.own_steps ?? '[]').map(stepFromJson),
    inflight,
  };
}
