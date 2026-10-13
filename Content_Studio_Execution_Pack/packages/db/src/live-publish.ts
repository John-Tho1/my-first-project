/**
 * LIVE-P1(결정 D38 1단계): 실제 게시 승인 기록(PUBLISH_LIVE_APPROVAL_REF)별 게시 수 세기와 "실제 게시 계정으로 사용" 전환.
 *
 * - 게시 수 = 그 승인 기록으로 전송 의도(send_intents — 원격에 닿았을 수 있는 시도)를 하나라도 만든 작업 수. 전송 의도는 지우지 않으므로 줄지 않는다.
 *   같은 작업의 재시도·이어 게시는 새 게시가 아니다(작업당 한 번 센다). 승인 기록은 배포 환경 하나에 하나이므로 owner 와 무관하게 센다(보수적).
 * - 실제 Threads 계정은 연결(D31)만으로는 배포 계획에 쓸 수 없다(state disconnected). 사용자가 설정 화면에서 "실제 게시 계정으로 사용"을 누를 때만
 *   connected 가 된다(묶인 계정 + 쓸 수 있는 연결 정보일 때만). 사용 중지는 disconnected — 그 계정의 활성 승인을 철회한다(A06 account_changed).
 */
import { and, eq, sql } from 'drizzle-orm';
import { AppError, isThreadsNumericId, isUuid, NotFoundError, TERMINAL_JOB_STATES } from '@cs/domain';
import type { Db } from './client';
import { setChannelAccountState } from './distribution';
import { credentialGate } from './oauth';
import { recordAudit, type DbOrTx } from './queries';
import { channelAccounts, distributionItems, jobs, sendIntents } from './schema';

export async function liveApprovalUsage(tx: DbOrTx, ref: string, jobId: string | null): Promise<{ otherJobs: number; thisJobCounted: boolean }> {
  const rows = await tx
    .select({ jobId: sendIntents.jobId })
    .from(sendIntents)
    .where(sql`${sendIntents.sanitizedDetails}->>'live_approval_ref' = ${ref}`)
    .groupBy(sendIntents.jobId);
  const ids = rows.map((r) => r.jobId);
  return { otherJobs: ids.filter((id) => id !== jobId).length, thisJobCounted: jobId !== null && ids.includes(jobId) };
}

/**
 * 실행(executePlan) 때의 앞선 검사용: 실제 계정 항목의 끝나지 않은 작업 중 아직 이 승인 기록으로 보낸 적 없는 작업 수
 * (대기열에 있어 곧 게시 수를 쓸 작업). 권위 있는 검사는 전송 직전(beginSend)이다 — 이것은 사용자에게 먼저 알려 주는 용도.
 */
export async function pendingLiveJobs(tx: DbOrTx, ref: string): Promise<number> {
  const rows = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(distributionItems, and(eq(distributionItems.id, jobs.itemId), eq(distributionItems.ownerId, jobs.ownerId)))
    .innerJoin(channelAccounts, and(eq(channelAccounts.id, distributionItems.channelAccountId), eq(channelAccounts.ownerId, distributionItems.ownerId)))
    .where(
      and(
        eq(channelAccounts.kind, 'live'),
        // 끝난 작업과 결과 불명(UNKNOWN — 자동으로 다시 보내지 않음)은 더 쓰지 않는다
        sql`${jobs.state} <> all(${sql.param([...TERMINAL_JOB_STATES, 'UNKNOWN'])}::text[])`,
        sql`not exists (select 1 from send_intents si where si.job_id = ${jobs.id} and si.sanitized_details->>'live_approval_ref' = ${ref})`,
      ),
    );
  return rows.length;
}

export class LivePublishTargetError extends AppError {
  constructor(code: 'live_target_not_live_threads' | 'live_target_unbound' | 'live_target_credential_unusable', message: string) {
    super('conflict', code, message);
  }
}

/**
 * "실제 게시 계정으로 사용"(enabled=true → connected) / "사용 중지"(false → disconnected). 외부 호출 없음.
 * 사용 조건: 실제(live) Threads 계정 · 프로필 ID 에 묶임(pending: 아님) · 연결 정보가 지금 쓸 수 있음(연결됨·곧 만료).
 * 상태가 바뀌면 setChannelAccountState 가 그 계정의 활성 승인을 철회한다(사용 → 다시 승인 필요가 없는 처음 상태지만, 규칙은 같게).
 */
export async function setLivePublishTarget(db: Db, ownerId: string, accountId: string, enabled: boolean, now: Date = new Date()) {
  if (!isUuid(accountId)) throw new NotFoundError('배포 계정을 찾을 수 없습니다');
  // 사용·사용 중지 모두 실제 Threads 계정만(모의 계정의 상태는 이 경로로 바꾸지 않는다). 사용은 묶임·쓸 수 있는 연결 정보까지 본다.
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(channelAccounts)
      .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.ownerId, ownerId)))
      .for('share')
      .limit(1);
    const acc = rows[0];
    if (!acc) throw new NotFoundError('배포 계정을 찾을 수 없습니다');
    if (acc.kind !== 'live' || acc.platform !== 'threads') {
      throw new LivePublishTargetError('live_target_not_live_threads', '실제 Threads 계정만 실제 게시 계정으로 쓸 수 있습니다');
    }
    if (!enabled) return;
    if (!isThreadsNumericId(acc.externalAccountId)) {
      throw new LivePublishTargetError('live_target_unbound', '아직 Threads 프로필에 연결되지 않은 계정입니다. 먼저 실제 연결을 마치세요');
    }
    const h = (await credentialGate(tx, ownerId, [acc.id], now)).get(acc.id);
    if (!h || !h.usable) {
      throw new LivePublishTargetError('live_target_credential_unusable', '연결 정보를 지금 쓸 수 없습니다(만료·해제·다시 연결 필요). 다시 연결한 뒤 사용하세요');
    }
  });
  // 상태 변경·승인 철회는 계정 FOR UPDATE 아래에서(setChannelAccountState). 그 사이 연결 정보가 바뀌어도 실행·전송 게이트가 다시 막는다.
  const r = await setChannelAccountState(db, ownerId, accountId, enabled ? 'connected' : 'disconnected', now);
  await recordAudit(db, {
    ownerId,
    action: 'channel_account.live_publish_target',
    entity: 'channel_account',
    entityId: accountId,
    details: { enabled, state: r.account.state, revoked_approvals: r.revoked.length },
    at: now,
  });
  return r;
}
