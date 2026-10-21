/**
 * 조회·쓰기 헬퍼. owner 제한(A01)은 route 뿐 아니라 이 query 계층에서도 강제한다:
 * captures/assets 등 owner 소유 데이터를 다루는 함수는 모두 ownerId 를 받아 WHERE 에 넣는다.
 * 다른 owner 의 ID 를 넘기면 "없음(null)" 으로 응답한다(존재 여부를 구분해 드러내지 않음).
 */
import { and, asc, count, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { isUuid, LoginSequenceExhaustedError } from '@cs/domain';
import type { Db } from './client';
import { assets, auditEvents, captures, sessions, users } from './schema';

export async function findOwner(db: DbOrTx, allowedIdentity: string) {
  const rows = await db.select().from(users).where(eq(users.allowedIdentity, allowedIdentity)).limit(1);
  return rows[0] ?? null;
}

/** 허용 식별자의 users 행을 보장한다(seed 와 같은 방식: 없으면 만들고, 있으면 그대로). */
export async function ensureOwner(db: DbOrTx, allowedIdentity: string) {
  await db.insert(users).values({ allowedIdentity }).onConflictDoNothing();
  const owner = await findOwner(db, allowedIdentity);
  if (!owner) throw new Error('owner 생성에 실패했습니다');
  return owner;
}

/** ownerId 를 생략하면 전체 집계(health 용 — 개수만, 내용 없음). */
export async function countCaptures(db: Db, ownerId?: string): Promise<number> {
  const q = db.select({ n: count() }).from(captures);
  const rows = ownerId ? await q.where(eq(captures.ownerId, ownerId)) : await q;
  return rows[0]?.n ?? 0;
}

/** 소유자 범위로만 조회한다(owner 제한은 query 에서도 적용). */
export async function listCaptures(db: Db, ownerId: string, limit = 50) {
  return db
    .select()
    .from(captures)
    .where(eq(captures.ownerId, ownerId))
    .orderBy(asc(captures.receivedAt), asc(captures.commandKey))
    .limit(limit);
}

/** 다른 owner 의 capture 이거나 형식이 잘못된 ID 면 null. */
export async function getCaptureById(db: Db, ownerId: string, id: string) {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, id), eq(captures.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---- assets ----

export type AssetRow = typeof assets.$inferSelect;

export async function listAssets(db: Db, ownerId: string, limit = 50) {
  return db
    .select()
    .from(assets)
    .where(eq(assets.ownerId, ownerId))
    .orderBy(desc(assets.createdAt), asc(assets.id))
    .limit(limit);
}

export async function getAssetById(db: Db, ownerId: string, id: string): Promise<AssetRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * asset 행을 트랜잭션 안에서 잠근다(SELECT … FOR UPDATE). 같은 asset 의 파일 복구처럼 "확인 → 저장 → 감사" 를
 * 한 요청만 수행하게 직렬화할 때 쓴다. 트랜잭션 밖에서 호출하면 잠금이 즉시 풀리므로 반드시 tx 로 호출한다.
 */
export async function lockAssetRow(tx: DbOrTx, ownerId: string, id: string): Promise<AssetRow | null> {
  const rows = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.ownerId, ownerId)))
    .for('update');
  return rows[0] ?? null;
}

export async function findAssetByChecksum(db: Db, ownerId: string, checksum: string): Promise<AssetRow | null> {
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.ownerId, ownerId), eq(assets.checksum, checksum)))
    .limit(1);
  return rows[0] ?? null;
}

export interface NewAsset {
  id: string;
  ownerId: string;
  key: string;
  mime: string;
  bytes: number;
  checksum: string;
  rightsStatus: string;
  verificationState: string;
}

/** (owner_id, checksum) 충돌이면 null(동시 중복 업로드) — 호출자가 기존 asset 을 다시 조회한다. */
export async function insertAsset(db: Db, a: NewAsset): Promise<AssetRow | null> {
  const rows = await db
    .insert(assets)
    .values(a)
    .onConflictDoNothing({ target: [assets.ownerId, assets.checksum] })
    .returning();
  return rows[0] ?? null;
}

// ---- sessions ----

export interface NewSession {
  ownerId: string;
  tokenHash: string;
  expiresAt: Date;
  userAgentHash: string | null;
  now: Date;
}

export async function createSession(db: DbOrTx, s: NewSession) {
  const rows = await db
    .insert(sessions)
    .values({
      ownerId: s.ownerId,
      tokenHash: s.tokenHash,
      createdAt: s.now,
      lastSeenAt: s.now,
      expiresAt: s.expiresAt,
      userAgentHash: s.userAgentHash,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('세션 생성에 실패했습니다');
  return row;
}

/**
 * token_hash 로 "유효한" 세션만 찾는다: expires_at > now AND revoked_at IS NULL.
 * owner 의 허용 식별자도 함께 반환해 호출자가 현재 allowlist 와 대조하게 한다.
 */
export async function findActiveSession(db: Db, tokenHash: string, now: Date) {
  const rows = await db
    .select({
      sessionId: sessions.id,
      ownerId: sessions.ownerId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      identity: users.allowedIdentity,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now), isNull(sessions.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function touchSession(db: Db, sessionId: string, now: Date): Promise<void> {
  await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
}

/** 아직 폐기되지 않은 세션만 폐기한다. 폐기했으면 true. */
export async function revokeSession(db: Db, ownerId: string, sessionId: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.id, sessionId), eq(sessions.ownerId, ownerId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

// ---- audit ----

/** db 또는 transaction 안의 tx — 같은 쿼리 헬퍼를 둘 다에서 쓴다. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface AuditInput {
  /** 인증 전 이벤트(auth.login_denied)만 null */
  ownerId: string | null;
  action:
    | 'auth.login'
    | 'auth.logout'
    | 'auth.login_denied'
    | 'asset.upload'
    | 'asset.download'
    | 'asset.missing'
    | 'asset.restore'
    | 'capture.create'
    | 'capture.update'
    | 'capture.extract_blocked'
    | 'idea.create'
    | 'idea.update'
    | 'content.create'
    | 'content.update'
    | 'content.version_append'
    | 'brand.version_create'
    | 'interview.answer'
    | 'content.assist'
    | 'content.adopt_ai'
    | 'content.claim_confirm'
    | 'variant.version_create'
    | 'variant.assist'
    | 'variant.adopt_ai'
    | 'variant.assets'
    | 'variant.lifecycle'
    | 'content.proposal_dismiss'
    | 'package.create'
    | 'package.download'
    | 'export.create'
    | 'export.download'
    | 'restore.preview'
    | 'restore.commit'
    | 'upload.session_create'
    | 'upload.complete'
    | 'upload.reject'
    | 'upload.abort'
    | 'upload.expire'
    | 'asset.delete_original'
    | 'asset.delete_original_skipped'
    | 'asset.cleanup'
    | 'transcription.request'
    | 'transcription.cancel'
    | 'transcription.succeeded'
    | 'transcription.failed'
    | 'transcript.version_create'
    | 'transcript.to_capture'
    // T10 배포 계획·승인·실행
    | 'channel_account.state'
    // LIVE-T1(D31): 실제 Threads 계정 행(연결 전) 생성 — 외부 호출 없음
    | 'channel_account.live_created'
    | 'channel_account.live_publish_target'
    // LIVE-P2(D39): 실제 게시 즉시 중지·재개(누가 = owner, 언제 = at 만 — 사유 문구·식별자 없음)
    | 'live_publish_paused'
    | 'live_publish_resumed'
    | 'plan.create'
    | 'plan.execute'
    | 'approval.grant'
    | 'approval.refused'
    | 'approval.revoke'
    | 'approval.invalidate'
    | 'item.cancel'
    | 'item.reconcile'
    | 'item.retry'
    // LIVEP1-USERCONFIRM: 결과 불명 실제 게시를 사용자가 "Threads에서 확인함"으로 기록(외부 호출 없음)
    | 'item.user_confirm'
    | 'item.mock_scenario'
    | 'worker.tick'
    | 'restore_drill.run'
    // FIX4-LIVEL1H2: 운영자 CLI(pnpm ledger:resolve --confirm)의 provider_unstorable 수동 해결·정정(방식·출처·금액·차단 여부만 — resolved_by·reason·보고값 없음)
    | 'usage_ledger.manual_resolve'
    | 'retention.sweep'
    | 'retention.files'
    // T13 계정 연결(OAuth) — details 에 토큰·code·state·verifier·암호문을 넣지 않는다(코드 값만)
    | 'oauth.connect_start'
    | 'oauth.callback_rejected'
    | 'oauth.connected'
    | 'oauth.refreshed'
    | 'oauth.refresh_failed'
    | 'oauth.refresh_refused'
    | 'oauth.refresh_discarded'
    | 'oauth.pending_reconciled'
    | 'oauth.pending_record_failed'
    | 'oauth.cleanup_revoke_failed'
    | 'oauth.cleanup_revoke_unknown'
    | 'oauth.checked'
    | 'oauth.revoked'
    | 'oauth.key_rotated'
    // T18(D32 제안): 가져오기 원장(건수만 — 파일 이름·경로·본문 없음)
    | 'import.preview'
    | 'import.commit'
    | 'import.cancel'
    // T19(D33 제안): 수집 소스·실행·받아들이기·재추천 닫기(건수·호스트만 — 제목·본문 없음)
    | 'collector.source.create'
    | 'collector.source.settings'
    | 'collector.run'
    | 'collector.discard'
    | 'collector.accept'
    | 'recommendation.dismiss';
  entity: string;
  entityId?: string | null;
  versionOrHash?: string | null;
  /** 정제된 값만(식별자·토큰·경로·환경변수 값 금지) */
  details?: Record<string, string | number | boolean | null>;
  at?: Date;
}

export async function recordAudit(db: DbOrTx, e: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    ownerId: e.ownerId,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId ?? null,
    versionOrHash: e.versionOrHash ?? null,
    sanitizedDetails: e.details ?? {},
    ...(e.at ? { at: e.at } : {}),
  });
}

/**
 * T21-P1a: 로그인 시도 횟수 제한용 — 시간 창(windowStart < at <= now) 안의 실패한 로그인 수(전역, owner·식별자·IP 무관).
 * 실패 = `auth.login_denied` 중 details.reason 이 reasons 에 든 것. 창 안에 성공 로그인(`auth.login`)이 있으면 마지막 성공 **이후**의 실패만 센다.
 *
 * FIX2-T21P1A(P2): 마지막 성공 찾기와 실패 세기를 **SQL 한 문장**(상관 하위 질의)으로 한다 — Postgres·PGlite 모두 한 문장은 한 스냅숏을
 * 보므로, 잠금 밖 조기 검사에서도 "성공 전 상태의 마지막 성공 + 성공 뒤 상태의 실패" 처럼 섞인 값이 나오지 않는다. 그래서 조기 검사의 429 는
 * 그 시점 상태에 대해 잠금 안 판정과 같은 결론이다(그 시점에 이미 상한 이상이었음).
 *
 * 순서 규칙(FIX-T21P1A P2): "이후" 는 로그인 순번(version_or_hash 의 10진 숫자, withLoginAttemptLock 이 잠금 안에서 붙임)으로 정한다.
 * - 성공·실패 둘 다 순번이 있으면 순번이 큰 실패만 센다(같은 ms 여도 기록 순서대로).
 * - 어느 한쪽이라도 순번이 없으면(이 변경 전 기록·직접 넣은 행) 시각이 성공보다 **엄격히** 뒤인 실패만 센다 — 같은 ms 면 성공 우선(세지 않음).
 * - 마지막 성공 = 창 안 성공 중 (시각, 순번) 이 가장 큰 행.
 * 알려진 한계(보수적으로 받아들인 규칙, FIX2 문서화):
 * - 복원(add_missing)으로 다른 이력의 성공 행(순번·시각 보존)이 섞이면, 그 성공이 창 안이고 순번이 지금 실패들보다 크면 그 실패들을 세지
 *   않는다(제한이 그 창 동안 느슨해짐). 창 15분이 지나면 사라진다. 다음 순번은 섞인 이력까지 포함한 최대 + 1 이라 이후 기록은 다시 앞선다.
 *   (실패 행은 owner 가 없어 내보내기·복원 대상이 아니다.)
 * - 시계가 뒤로 가면 창은 시각(at <= now)으로 자르므로, 지금보다 미래 시각이 된 기록(성공·실패 모두)은 시계가 따라잡을 때까지 무시된다 —
 *   그동안은 창이 비워진 것처럼 느슨해진다(되돌린 폭 이하). 순번과 시각의 순서가 어긋나도 마지막 성공은 (시각, 순번) 최대로 고른다.
 */
export async function countRecentLoginFailures(
  db: DbOrTx,
  opts: { now: Date; windowMs: number; reasons: readonly string[] },
): Promise<number> {
  if (opts.reasons.length === 0) return 0;
  const nowIso = opts.now.toISOString();
  const startIso = new Date(opts.now.getTime() - opts.windowMs).toISOString();
  const lastOk = sql`(select lo.at as ok_at, ${seqOf(sql.raw('lo.version_or_hash'))} as ok_seq
      from ${auditEvents} lo
      where lo.action = 'auth.login' and lo.at > ${startIso}::timestamptz and lo.at <= ${nowIso}::timestamptz
      order by lo.at desc, ok_seq desc nulls last
      limit 1)`;
  const afterLastOk = sql`coalesce((select case when l.ok_seq is not null and ${loginSeqExpr} is not null
        then ${loginSeqExpr} > l.ok_seq else ${auditEvents.at} > l.ok_at end
      from ${lastOk} l), true)`;
  const [row] = await db
    .select({ n: count() })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, 'auth.login_denied'),
        sql`${auditEvents.at} > ${startIso}::timestamptz`,
        sql`${auditEvents.at} <= ${nowIso}::timestamptz`,
        inArray(sql<string>`${auditEvents.sanitizedDetails}->>'reason'`, [...opts.reasons]),
        afterLastOk,
      ),
    );
  return row?.n ?? 0;
}

/**
 * 로그인 순번: version_or_hash 가 10진 숫자(1~30자리)일 때만 numeric, 아니면 null.
 * FIX2-T21P1A: 15자리 제한(16자리부터 순번이 아닌 것으로 읽힘)과 JS Number 정밀도(2^53) 문제를 없애려고 numeric·문자열로 다룬다.
 */
/** 순번으로 읽는 범위(SQL·JS 같은 규칙). */
const LOGIN_SEQ_PATTERN = '^[0-9]{1,30}$';
const LOGIN_SEQ_RE = new RegExp(LOGIN_SEQ_PATTERN);
const seqOf = (col: SQL) => sql`(case when ${col} ~ ${LOGIN_SEQ_PATTERN} then ${col}::numeric end)`;
const loginSeqExpr = seqOf(sql`${auditEvents.versionOrHash}`);

/** 전역 로그인 판정 잠금 키(제한이 전역이므로 키도 하나). */
export const LOGIN_ATTEMPT_LOCK_KEY = 'cs.auth.login';

export interface LoginAttemptContext {
  /** 잠금을 얻은 뒤의 시각 — 판정·기록 시각(본문이 늦게 와도 창이 밀리지 않게). */
  now: Date;
  /** now 기준 창 안 실패 수(잠금 안 재계산). */
  failures: number;
  /** 이번 시도의 기록에 붙일 로그인 순번(기존 최대 + 1, 10진 문자열). auth 기록의 versionOrHash 로 그대로 넣는다. */
  seq: string;
}

/**
 * FIX-T21P1A(P1): 로그인 시도의 "재검사 → 판정 → 성공·실패 기록" 을 한 트랜잭션·전역 advisory 잠금 안에서 직렬화한다.
 * fn 이 던지면 기록(세션 포함)도 함께 되돌려진다 — 기록을 남겨야 하는 거부(401·400)는 fn 이 값으로 돌려주고 호출 측이 잠금 밖에서 던진다.
 * PGlite 는 연결 하나에서 트랜잭션을 이미 하나씩만 실행한다. Postgres 에서는 이 잠금이 연결·프로세스 사이를 직렬화하도록 설계했지만
 * Postgres 드라이버가 아직 없어(G2) 여러 연결에서의 동작은 검증하지 않았다.
 */
export async function withLoginAttemptLock<T>(
  db: Db,
  opts: { windowMs: number; reasons: readonly string[] },
  fn: (tx: DbOrTx, ctx: LoginAttemptContext) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOGIN_ATTEMPT_LOCK_KEY}))`);
    const now = new Date();
    const failures = await countRecentLoginFailures(tx, { now, windowMs: opts.windowMs, reasons: opts.reasons });
    const [m] = await tx
      .select({ next: sql<string>`(coalesce(max(${loginSeqExpr}), 0) + 1)::text` })
      .from(auditEvents)
      .where(inArray(auditEvents.action, ['auth.login', 'auth.login_denied']));
    const seq = m?.next ?? '1';
    // FIX3-T21P1A: 다음 순번이 seqOf 가 읽는 범위(1~30자리)를 넘으면 쓰지 않고 거부한다 — 읽을 수 없는 순번을 쓰면 순서·횟수 계산에서
    // 빠져(같은 순번 반복) 제한이 풀린다. 던지면 트랜잭션이 되돌려져 세션·감사 행이 남지 않는다. 복원 행의 범위 밖 순번은 seqOf 가 null 로 본다.
    if (!LOGIN_SEQ_RE.test(seq)) throw new LoginSequenceExhaustedError();
    return fn(tx, { now, failures, seq });
  });
}
