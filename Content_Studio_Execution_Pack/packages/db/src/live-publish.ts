/**
 * LIVE-P1(결정 D38 1단계): 실제 게시 승인 기록(PUBLISH_LIVE_APPROVAL_REF)별 게시 수 세기와 "실제 게시 계정으로 사용" 전환.
 *
 * - 게시 수 = 그 승인 기록으로 전송 의도(send_intents — 원격에 닿았을 수 있는 시도)를 하나라도 만든 작업 수. 전송 의도는 지우지 않으므로 줄지 않는다.
 *   같은 작업의 재시도·이어 게시는 새 게시가 아니다(작업당 한 번 센다). 승인 기록은 배포 환경 하나에 하나이므로 owner 와 무관하게 센다(보수적).
 * - 실제 Threads 계정은 연결(D31)만으로는 배포 계획에 쓸 수 없다(state disconnected). 사용자가 설정 화면에서 "실제 게시 계정으로 사용"을 누를 때만
 *   connected 가 된다(묶인 계정 + 쓸 수 있는 연결 정보일 때만). 사용 중지는 disconnected — 그 계정의 활성 승인을 철회한다(A06 account_changed).
 */
import { and, eq, gt, max, sql } from 'drizzle-orm';
import {
  AppError,
  isThreadsNumericId,
  isUuid,
  LIVE_PUBLISH_DAILY_WINDOW_MS,
  livePublishDailyLockName,
  NotFoundError,
  TERMINAL_JOB_STATES,
} from '@cs/domain';
import type { Db } from './client';
import { setChannelAccountStateTx } from './distribution';
import { credentialGate, LIVE_ACCOUNT_SNAPSHOT_CONNECT_ONLY } from './oauth';
import { recordAudit, type DbOrTx } from './queries';
import { channelAccounts, distributionItems, jobs, livePublishControls, sendIntents } from './schema';

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

/** LIVEP1-DIAG: "실제 게시 계정으로 사용" 중인 실제 Threads 계정의 capability_snapshot(표시용 — 게이트 아님) */
export const LIVE_ACCOUNT_SNAPSHOT_PUBLISH_TARGET: Readonly<Record<string, unknown>> = Object.freeze({
  mock: false,
  external_writes: true,
  publish: 'live_text_D38',
  note: '실제 계정 — 실제 게시 계정으로 사용 중(D38): 승인한 Threads 텍스트 글 1개를 실제 게시 조건(PUBLISH_MODE·게시 승인 기록·게시 수 상한)이 모두 있을 때만 게시',
});

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
  // FIX-LIVEP1(Codex 답 5): 확인과 상태 변경을 **한 트랜잭션**에서 — 계정을 먼저 FOR UPDATE 로 잠가(연결 해제·갱신·확인도 같은 계정을 FOR UPDATE 로 잡는다)
  // 그 사이 연결 정보가 철회돼 "해제된 연결 정보 + connected" 가 남지 않게 한다.
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(channelAccounts)
      .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const acc = rows[0];
    if (!acc) throw new NotFoundError('배포 계정을 찾을 수 없습니다');
    if (acc.kind !== 'live' || acc.platform !== 'threads') {
      throw new LivePublishTargetError('live_target_not_live_threads', '실제 Threads 계정만 실제 게시 계정으로 쓸 수 있습니다');
    }
    if (enabled && !isThreadsNumericId(acc.externalAccountId)) {
      throw new LivePublishTargetError('live_target_unbound', '아직 Threads 프로필에 연결되지 않은 계정입니다. 먼저 실제 연결을 마치세요');
    }
    if (enabled) {
      const h = (await credentialGate(tx, ownerId, [acc.id], now)).get(acc.id);
      if (!h || !h.usable) {
        throw new LivePublishTargetError('live_target_credential_unusable', '연결 정보를 지금 쓸 수 없습니다(만료·해제·다시 연결 필요). 다시 연결한 뒤 사용하세요');
      }
    }
    const r = await setChannelAccountStateTx(tx, ownerId, accountId, enabled ? 'connected' : 'disconnected', now);
    // LIVEP1-DIAG: 표시용 capability_snapshot 을 지금 상태에 맞춘다(사용 = D38 실제 텍스트 게시, 중지 = D31 연결만). 게이트는 이 값을 읽지 않는다
    // (실행·전송 게이트 = PUBLISH_MODE·승인 기록·게시 수 상한·계정 state·연결 정보·승인 hash).
    const snapshot = enabled ? { ...LIVE_ACCOUNT_SNAPSHOT_PUBLISH_TARGET } : { ...LIVE_ACCOUNT_SNAPSHOT_CONNECT_ONLY };
    const [withSnapshot] = await tx
      .update(channelAccounts)
      .set({ capabilitySnapshot: snapshot })
      .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.ownerId, ownerId)))
      .returning();
    r.account = withSnapshot ?? r.account;
    await recordAudit(tx, {
      ownerId,
      action: 'channel_account.live_publish_target',
      entity: 'channel_account',
      entityId: accountId,
      details: { enabled, state: r.account.state, revoked_approvals: r.revoked.length },
      at: now,
    });
    return r;
  });
}

// ---- LIVE-P2(결정 D39): 최근 24시간 실제 게시 상한 · 즉시 중지 스위치 ----

export interface LivePublishDailyUsage {
  /** 창 안에 실제 전송 의도가 있는 **다른** 작업 수(jobId 가 null 이면 모든 작업 수 — 화면 표시용) */
  used: number;
  /** 이 작업이 창 안에 이미 실제 전송 의도를 가짐(재시도·이어 보내기 — 새 게시가 아님) */
  thisJobCounted: boolean;
  /**
   * 다음에 자리가 나는 시각: 센 작업마다의 **가장 최근** 실제 전송 의도 시각 중 가장 이른 것 + 24시간. 그 시각이 되면 창은 `created_at > now − 24h`
   * 이므로 그 작업이 빠진다(재시도한 작업은 마지막 의도 기준이라 첫 의도 + 24h 보다 늦을 수 있음). 센 작업이 없으면 null.
   */
  availableAt: Date | null;
}

/**
 * 최근 24시간(`created_at > now − 24h`) 안에 이 owner 의 실제 게시 전송 의도(sanitized_details.live_approval_ref 가 있는 행 — 승인 기록 값과 무관)를
 * 만든 서로 다른 작업 수. 위쪽 끝은 두지 않는다(시계가 앞선 의도도 센다 — 보수적). 권위 있는 판정은 beginSend 가 owner 별 일일 잠금 아래에서 부른다.
 */
export async function livePublishDailyUsage(tx: DbOrTx, ownerId: string, jobId: string | null, now: Date): Promise<LivePublishDailyUsage> {
  const since = new Date(now.getTime() - LIVE_PUBLISH_DAILY_WINDOW_MS);
  const rows = await tx
    .select({ jobId: sendIntents.jobId, lastAt: max(sendIntents.createdAt) })
    .from(sendIntents)
    .where(and(eq(sendIntents.ownerId, ownerId), sql`${sendIntents.sanitizedDetails}->>'live_approval_ref' is not null`, gt(sendIntents.createdAt, since)))
    .groupBy(sendIntents.jobId);
  const others = rows.filter((r) => r.jobId !== jobId);
  let earliest: number | null = null;
  for (const r of others) {
    const t = r.lastAt instanceof Date ? r.lastAt.getTime() : r.lastAt ? new Date(r.lastAt).getTime() : NaN;
    if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
  }
  return {
    used: others.length,
    thisJobCounted: jobId !== null && rows.some((r) => r.jobId === jobId),
    availableAt: earliest === null ? null : new Date(earliest + LIVE_PUBLISH_DAILY_WINDOW_MS),
  };
}

export interface LivePublishControlView {
  paused: boolean;
  changedAt: Date | null;
}

/**
 * 즉시 중지 스위치 읽기. 행이 없으면 중지 아님. lock=true 면 FOR SHARE(beginSend 는 owner 별 일일 잠금 아래에서 읽는다 — setLivePublishPaused 도 같은
 * 잠금을 먼저 잡으므로 중지가 커밋된 뒤 시작하는 전송 판정은 반드시 중지를 본다).
 */
export async function getLivePublishPaused(tx: DbOrTx, ownerId: string, opts: { lock?: boolean } = {}): Promise<LivePublishControlView> {
  const q = tx
    .select({ paused: livePublishControls.paused, changedAt: livePublishControls.changedAt })
    .from(livePublishControls)
    .where(eq(livePublishControls.ownerId, ownerId))
    .limit(1);
  const rows = opts.lock ? await q.for('share') : await q;
  const r = rows[0];
  return r ? { paused: r.paused, changedAt: r.changedAt } : { paused: false, changedAt: null };
}

/**
 * 즉시 중지(paused=true) / 재개(false). 로그인한 소유자만(route 가 세션·같은 출처를 본다). 외부 호출 없음.
 * owner 별 일일 잠금(cs_live_publish_daily:<owner>)을 **먼저** 잡는다 — 다른 잠금은 잡지 않으므로 beginSend(…→ 승인 기록 잠금 → 이 잠금)와 순서가 엇갈리지
 * 않는다. 이미 그 상태면 바꾸지 않고 감사도 남기지 않는다(changed=false). 감사: live_publish_paused / live_publish_resumed(누가 = owner, 언제 = at 만).
 * 중지는 이미 게시 시도 표식을 지난 작업(결과 불명·조회)을 바꾸지 않는다 — 막는 곳은 전송 직전(beginSend)뿐이다.
 */
export async function setLivePublishPaused(db: Db, ownerId: string, paused: boolean, now: Date = new Date()): Promise<{ paused: boolean; changed: boolean; changedAt: Date }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${livePublishDailyLockName(ownerId)}))`);
    const cur = await tx.select().from(livePublishControls).where(eq(livePublishControls.ownerId, ownerId)).for('update').limit(1);
    const before = cur[0];
    if (before && before.paused === paused) return { paused, changed: false, changedAt: before.changedAt };
    if (!before && !paused) return { paused: false, changed: false, changedAt: now };
    await tx
      .insert(livePublishControls)
      .values({ ownerId, paused, changedAt: now, changedBy: 'owner' })
      .onConflictDoUpdate({ target: livePublishControls.ownerId, set: { paused, changedAt: now, changedBy: 'owner' } });
    await recordAudit(tx, {
      ownerId,
      action: paused ? 'live_publish_paused' : 'live_publish_resumed',
      entity: 'live_publish_controls',
      entityId: ownerId,
      details: { by: 'owner' },
      at: now,
    });
    return { paused, changed: true, changedAt: now };
  });
}

/** 화면용 요약(홈·배포 계획·설정): 실제 계정이 있는지, 중지 여부, 최근 24시간 실제 게시 작업 수. 잠금 없음(표시용 — 판정은 beginSend). */
export async function livePublishOverview(
  db: DbOrTx,
  ownerId: string,
  now: Date = new Date(),
): Promise<{ hasLiveAccount: boolean; paused: boolean; changedAt: Date | null; used: number; availableAt: Date | null }> {
  const live = await db
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.ownerId, ownerId), eq(channelAccounts.kind, 'live')))
    .limit(1);
  const control = await getLivePublishPaused(db, ownerId);
  const usage = await livePublishDailyUsage(db, ownerId, null, now);
  return { hasLiveAccount: live.length > 0, paused: control.paused, changedAt: control.changedAt, used: usage.used, availableAt: usage.availableAt };
}
