/**
 * LIVEP1-USERCONFIRM(D38 후속): 결과 불명 실제 Threads 게시를 사용자가 "Threads에서 확인함"으로 기록한다.
 *
 * - 외부 호출·재게시 없음: 어댑터·레지스트리·fetch 를 쓰지 않는다. 전송 의도(send_intents)도 만들지 않는다 → 게시 수 상한(D38) 사용 수 그대로.
 * - 한 트랜잭션(전역 잠금 순서: 원고 → 파생본 → 계획 → 항목 → 작업 → 결과): 항목·가장 최근 작업을 FOR UPDATE 로 잡은 뒤 사실을 다시 모아
 *   @cs/domain userConfirmProblem 으로 판정 → 결과(publications, verification USER_CONFIRMED·confirmed_by 'owner'·confirmed_at) +
 *   작업 UNKNOWN/RECONCILING → CONFIRMED(user_confirmed 이력) + 항목 상태 + 계획 상태 재계산 + 감사(item.user_confirm).
 * - 동시 두 번 제출: 항목 행 잠금으로 직렬화 — 늦은 쪽은 결과가 이미 있어 409(user_confirm_already_published). 결과 INSERT 는 (항목, 외부 ID)
 *   unique 와 ON CONFLICT DO NOTHING 으로 한 번 더 막는다.
 * - 작업 처리기의 조회(RECONCILING lease)와 겹치면: 작업이 CONFIRMED(끝난 상태 — lease 해제)로 바뀌므로 처리기의 적용은 lease_lost 로 버려진다.
 * - FIX1-FULLREV2(G6): 후보 외부 ID 가 같은 owner 의 다른 항목 결과·다른 작업 게시 기록으로 이미 있으면 409(user_confirm_candidate_claimed) — 글 하나를 두 항목의
 *   게시로 기록하지 않는다. 같은 후보를 두 항목에서 동시에 확인하면 후보 ID 단위 advisory 잠금(항목·작업 잠금 뒤 — 전역 잠금 순서의 마지막)이 직렬화해
 *   늦은 쪽이 앞선 쪽의 결과를 보고 409.
 */
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import {
  isUuid,
  LIVE_THREADS_EXTERNAL_ID_RE,
  LIVE_THREADS_EXTERNAL_PREFIX,
  liveThreadsStepId,
  NotFoundError,
  UserConfirmError,
  userConfirmCandidateFromEvents,
  userConfirmProblem,
  type UserConfirmInput,
} from '@cs/domain';
import { lockItemsInOrder, recomputePlanStatus, syncItemStatus, transitionJob } from './approval-invalidation';
import type { Db } from './client';
import { publishedStepCount } from './remote-steps';
import { recordAudit, type DbOrTx } from './queries';
import { channelAccounts, jobEvents, jobs, publications, remoteSteps } from './schema';

const ITEM_NOT_FOUND = '배포 항목을 찾을 수 없습니다';

export interface UserConfirmOutcome {
  item_id: string;
  job_id: string;
  state_before: string;
  state: 'CONFIRMED';
  publication_id: string;
  external_id: string;
  permalink: string;
  verification: 'USER_CONFIRMED';
  confirmed_by: 'owner';
  confirmed_at: string;
  mode: 'LIVE';
  message: string;
}

/**
 * 작업의 **가장 최근 재확인 이력**(details.reconcile 이 문자열인 사건, event_seq 최대) 하나 — 없으면 null. 사용자 확인 route(userConfirmItem)와
 * 배포 계획 화면(getPlanDetail → 카드의 후보·버튼)이 같은 조회를 쓴다. FIX-LIVEP1-USERCONFIRM(Codex P2): 화면 이력(최근 10개)에 기대지 않는다.
 */
export async function latestReconcileEvent(tx: DbOrTx, ownerId: string, jobId: string): Promise<{ eventSeq: number; sanitizedDetails: Record<string, unknown> } | null> {
  const rows = await tx
    .select({ eventSeq: jobEvents.eventSeq, sanitizedDetails: jobEvents.sanitizedDetails })
    .from(jobEvents)
    .where(and(eq(jobEvents.ownerId, ownerId), eq(jobEvents.jobId, jobId), sql`jsonb_typeof(${jobEvents.sanitizedDetails}->'reconcile') = 'string'`))
    .orderBy(desc(jobEvents.eventSeq))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * FIX1-FULLREV2(G6): 실제 Threads 외부 ID(threads:<숫자>)가 같은 owner 의 **다른 항목**에 이미 기록돼 있는가 — 그 항목의 결과(publications) 또는 그 항목 작업의
 * 게시 기록(remote_steps publish 'threads:post:<숫자>' — 게시 직후·결과 기록 전에도 있다). 사용자 확인(userConfirmItem — 잠금 안)·계획 화면(getPlanDetail → 카드 버튼)·
 * 작업 처리기의 확인 후보 기록(applyReconcile — 이미 다른 항목의 글이면 후보로 남기지 않음)이 같은 판정을 쓴다. 형식이 틀린 ID 는 false(후보가 되지 못한다).
 */
export async function liveExternalIdClaimedElsewhere(tx: DbOrTx, ownerId: string, externalId: string, itemId: string): Promise<boolean> {
  if (!LIVE_THREADS_EXTERNAL_ID_RE.test(externalId)) return false;
  const pub = await tx
    .select({ id: publications.id })
    .from(publications)
    .where(and(eq(publications.ownerId, ownerId), eq(publications.externalId, externalId), ne(publications.itemId, itemId)))
    .limit(1);
  if (pub.length > 0) return true;
  const step = await tx
    .select({ id: remoteSteps.id })
    .from(remoteSteps)
    .where(
      and(
        eq(remoteSteps.ownerId, ownerId),
        eq(remoteSteps.kind, 'publish'),
        eq(remoteSteps.remoteId, liveThreadsStepId.publish(externalId.slice(LIVE_THREADS_EXTERNAL_PREFIX.length))),
        ne(remoteSteps.itemId, itemId),
      ),
    )
    .limit(1);
  return step.length > 0;
}

export async function userConfirmItem(db: Db, ownerId: string, itemId: string, input: UserConfirmInput, now: Date = new Date()): Promise<UserConfirmOutcome> {
  if (!isUuid(itemId)) throw new NotFoundError(ITEM_NOT_FOUND);
  return db.transaction(async (tx) => {
    const [item] = await lockItemsInOrder(tx, ownerId, [itemId]);
    if (!item) throw new NotFoundError(ITEM_NOT_FOUND);
    const accRows = await tx
      .select({ kind: channelAccounts.kind, platform: channelAccounts.platform })
      .from(channelAccounts)
      .where(and(eq(channelAccounts.id, item.channelAccountId), eq(channelAccounts.ownerId, ownerId)))
      .limit(1);
    const jobRows = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.ownerId, ownerId), eq(jobs.itemId, item.id)))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(1)
      .for('update');
    const job = jobRows[0] ?? null;
    const pubCount = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(publications)
      .where(and(eq(publications.ownerId, ownerId), eq(publications.itemId, item.id)));
    // 가장 최근 재확인 이력(details.reconcile 이 문자열) 하나 — 후보 판정은 도메인 함수(화면과 같은 규칙)
    const latestReconcile = job ? await latestReconcileEvent(tx, ownerId, job.id) : null;
    const candidate = userConfirmCandidateFromEvents(latestReconcile ? [latestReconcile] : []);
    // FIX1-FULLREV2(G6): 같은 후보를 두 항목에서 동시에 확인하는 경우를 직렬화(잠금 순서의 마지막 — 이 뒤로는 이미 잠근 행만 바꾼다) → 다른 항목 결과 확인
    if (candidate) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs_user_confirm:${ownerId}:${candidate.external_id}`}))`);
    const candidateClaimed = candidate ? await liveExternalIdClaimedElsewhere(tx, ownerId, candidate.external_id, item.id) : false;
    const problem = userConfirmProblem(
      {
        account: accRows[0] ?? null,
        jobState: job?.state ?? null,
        restored: !!job?.restoredNeedsReview,
        publishAttempts: job ? await publishedStepCount(tx, ownerId, job.id, ['publish_attempt']) : 0,
        publishSteps: job ? await publishedStepCount(tx, ownerId, job.id, ['publish']) : 0,
        publications: Number(pubCount[0]?.n ?? 0),
        candidate,
        candidateClaimed,
      },
      input.candidate_external_id,
    );
    if (problem || !job || !candidate) throw new UserConfirmError(problem ?? 'user_confirm_no_candidate', job ? { state: job.state } : undefined);

    const inserted = await tx
      .insert(publications)
      .values({
        ownerId,
        itemId: item.id,
        jobId: job.id,
        externalId: candidate.external_id,
        permalink: candidate.permalink,
        resultKind: 'PUBLISHED',
        // 공개 범위 필드가 API 에 없다(LIVE-P1) — 사용자가 본 글이어도 원격 공개 범위는 확인한 값이 아니다
        remoteVisibility: 'unknown',
        verification: 'USER_CONFIRMED',
        isMock: false,
        verifiedAt: null,
        confirmedBy: 'owner',
        confirmedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: publications.id });
    const publicationId = inserted[0]?.id;
    if (!publicationId) throw new UserConfirmError('user_confirm_already_published', { state: job.state });

    const to = await transitionJob(
      tx,
      ownerId,
      job,
      'user_confirmed',
      {
        attempt: job.attempt,
        source: 'user',
        confirmed_by: 'owner',
        external_id: candidate.external_id,
        permalink: candidate.permalink,
        verification: 'USER_CONFIRMED',
        publication_id: publicationId,
      },
      now,
    );
    await syncItemStatus(tx, ownerId, item.id, to, now);
    await recomputePlanStatus(tx, ownerId, item.planId, now);
    await recordAudit(tx, {
      ownerId,
      action: 'item.user_confirm',
      entity: 'distribution_item',
      entityId: item.id,
      details: { job_id: job.id, from: job.state, to, external_id: candidate.external_id, verification: 'USER_CONFIRMED', mode: 'LIVE' },
      at: now,
    });
    return {
      item_id: item.id,
      job_id: job.id,
      state_before: job.state,
      state: 'CONFIRMED' as const,
      publication_id: publicationId,
      external_id: candidate.external_id,
      permalink: candidate.permalink,
      verification: 'USER_CONFIRMED' as const,
      confirmed_by: 'owner' as const,
      confirmed_at: now.toISOString(),
      mode: 'LIVE' as const,
      message: 'Threads에서 확인함으로 기록했습니다(사용자 확인 — 앱이 검증한 것은 아님). 다시 게시하지 않았습니다.',
    };
  });
}
