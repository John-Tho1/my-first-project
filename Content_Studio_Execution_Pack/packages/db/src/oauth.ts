/**
 * T13(결정 D24) 계정 연결(OAuth)·연결 상태·비밀 보호 — DB 쪽.
 *
 * 불변식
 * - 토큰 평문은 DB 에 없다. oauth_credentials.encrypted_token = AES-256-GCM 봉인(@cs/domain secrets.ts, AAD = owner + 계정 + 'oauth_token').
 *   state 는 SHA-256 만, PKCE verifier 는 봉인(AAD 에 연결 요청 행 ID).
 * - 모든 함수는 ownerId 를 WHERE 에 넣는다(A01): 다른 owner 의 계정·연결 요청은 404 / oauth_state_invalid.
 * - 감사(audit_events.sanitized_details)·오류·응답에는 코드 값·scope 이름·시각·키 버전만. 토큰·code·state·verifier·암호문 없음.
 * - 계정 정체(external_account_id)는 연결로 바뀌지 않는다: 공급자가 돌려준 계정이 다르면 저장하지 않는다(409 oauth_account_mismatch).
 *   그래서 다시 연결·갱신은 승인을 무효로 하지 않는다(승인 스냅샷의 provider_account_id 그대로). 연결 해제(revoke)는 계정 상태 변경으로 보고
 *   그 계정을 쓰는 활성 승인을 철회한다(A06 account_changed — 보수적 선택, 인계 문서 질문).
 * - 실행 차단: 연결 정보가 필요한 계정(live, 또는 credential_state ≠ none)은 credentialHealth.usable 일 때만 실행·전송(executePlan·beginSend·retryItem).
 *   연결한 적 없는 모의 계정은 M3 동작 그대로(결과는 항상 MOCK). 모의 연결 정보도 MOCK 이다 — 실제 연결·실제 게시로 세지 않는다.
 * - 공급자 호출(모의) 중에는 DB 트랜잭션을 열어 두지 않는다.
 * - FIX-T13(Codex review-T13): 모든 연결 정보 변경은 계정 → 연결 정보 순서로 잠근다(lockAccountCredential). 새 토큰을 저장할 때마다
 *   token_generation +1(키 교체는 그대로). 공급자 호출 뒤 되쓰기는 읽었던 세대일 때만 — 아니면 결과를 버리고, 새로 받은 토큰은 공급자에서 철회.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import {
  AppError,
  codeChallengeS256,
  CREDENTIAL_STATUS_LABEL,
  CREDENTIAL_STATUSES,
  CredentialBusyError,
  CredentialNotFoundError,
  CredentialRefreshFailedError,
  LiveRefreshOutOfScopeError,
  credentialHealth,
  hashOAuthState,
  isRevokeUnsupported,
  isUnboundLiveExternalId,
  isUuid,
  isWellFormedOAuthState,
  LIVE_THREADS_PUBLISH_MARKER,
  UNBOUND_LIVE_EXTERNAL_PREFIX,
  newCodeVerifier,
  newOAuthState,
  NotFoundError,
  OAUTH_EXPIRING_SOON_MS,
  OAUTH_STATE_TTL_MS,
  OAuthAccountMismatchError,
  OAuthFlowError,
  OAuthProviderError,
  openSecret,
  requiredScopesForPlatform,
  resealSecret,
  sealSecret,
  SecretDecryptError,
  type CredentialHealth,
  type CredentialStatus,
  type OAuthFlowErrorCode,
  type OAuthProvider,
  type OAuthTokenSet,
  type SecretAad,
  type SealedSecret,
  type SecretKeyring,
  type StoredOAuthTokens,
} from '@cs/domain';
import { invalidateApprovalsForAccount } from './approval-invalidation';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { channelAccounts, oauthCredentials, oauthPendingTokens, oauthStates } from './schema';

export type OAuthCredentialRow = typeof oauthCredentials.$inferSelect;
export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type OAuthPendingRow = typeof oauthPendingTokens.$inferSelect;
type AccountRow = typeof channelAccounts.$inferSelect;

/** 계정 → 공급자(호출자가 정한다: web 은 @cs/providers resolveOAuthProvider). 지원하지 않으면 던진다. */
export type ProviderFor = (account: AccountRow) => OAuthProvider;
/** 키 묶음을 늦게 읽는다(소유 확인 뒤). 설정이 없으면 SecretsNotConfiguredError 를 던진다. */
export type KeyringSource = () => SecretKeyring;

const ACCOUNT_NOT_FOUND = '배포 계정을 찾을 수 없습니다';

const tokenAad = (ownerId: string, accountId: string): SecretAad => ({ ownerId, channelAccountId: accountId, purpose: 'oauth_token' });
const verifierAad = (ownerId: string, accountId: string, stateId: string): SecretAad => ({
  ownerId,
  channelAccountId: accountId,
  purpose: 'pkce_verifier',
  scopeId: stateId,
});

/**
 * 봉인할 평문. T15(D27): Google 형 공급자의 짧은 access token 만료(access_expires_at)는 있을 때만 넣는다 — Threads 토큰의 평문 모양은 그대로.
 */
function encodeTokens(t: OAuthTokenSet | StoredOAuthTokens): string {
  const accessExp = 'accessExpiresAt' in t && t.accessExpiresAt ? (t.accessExpiresAt instanceof Date ? t.accessExpiresAt.toISOString() : t.accessExpiresAt) : null;
  return JSON.stringify({ v: 1, access_token: t.accessToken, refresh_token: t.refreshToken, ...(accessExp ? { access_expires_at: accessExp } : {}) });
}

/** T15: 보내기 전에 갱신할 여유(access token 이 이 시간 안에 만료되면 갱신). */
export const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

function decodeTokens(plain: string): StoredOAuthTokens {
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch {
    throw new SecretDecryptError('malformed');
  }
  const o = v as { v?: unknown; access_token?: unknown; refresh_token?: unknown; access_expires_at?: unknown };
  if (o.v !== 1 || typeof o.access_token !== 'string' || !(o.refresh_token === null || typeof o.refresh_token === 'string')) {
    throw new SecretDecryptError('malformed');
  }
  if (o.access_expires_at !== undefined && (typeof o.access_expires_at !== 'string' || !Number.isFinite(Date.parse(o.access_expires_at)))) {
    throw new SecretDecryptError('malformed');
  }
  return {
    accessToken: o.access_token,
    refreshToken: o.refresh_token,
    ...(typeof o.access_expires_at === 'string' ? { accessExpiresAt: o.access_expires_at } : {}),
  };
}

async function ownedAccount(db: DbOrTx, ownerId: string, accountId: string, lock?: 'update'): Promise<AccountRow> {
  if (!isUuid(accountId)) throw new NotFoundError(ACCOUNT_NOT_FOUND);
  const q = db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.id, accountId.toLowerCase()), eq(channelAccounts.ownerId, ownerId)))
    .limit(1);
  const rows = lock ? await q.for('update') : await q;
  if (!rows[0]) throw new NotFoundError(ACCOUNT_NOT_FOUND);
  return rows[0];
}

async function credentialOf(db: DbOrTx, ownerId: string, accountId: string): Promise<OAuthCredentialRow | null> {
  const rows = await db
    .select()
    .from(oauthCredentials)
    .where(and(eq(oauthCredentials.ownerId, ownerId), eq(oauthCredentials.channelAccountId, accountId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---- 연결 상태 ----

/**
 * FIX4-T13: 정리 대기 종류(oauth_pending_tokens.kind).
 * - refresh_unknown: 발급받은 토큰(P)이 저장됐는지 판정하지 못함 — 저장됐을 수 있어 바로 철회하지 않는다.
 * - cleanup_revoke: P 는 저장되지 않았음(또는 현재 토큰일 수 없음)이 확실한데 공급자 철회가 실패·불명 — 다시 철회해야 한다.
 * - verify_current: P 는 정리됐지만 현재 토큰(C)의 유효성을 확인하지 못함(일시 오류) — 확인될 때까지 차단(Codex review-FIX3-T13 P1 :1037).
 */
export type PendingKind = 'refresh_unknown' | 'cleanup_revoke' | 'verify_current';
/** 화면·health 에 보일 종류(여러 건이면 이 순서로 가장 앞의 것) */
const PENDING_PRIORITY: readonly PendingKind[] = ['refresh_unknown', 'verify_current', 'cleanup_revoke'];
export interface PendingInfo {
  kind: PendingKind;
  count: number;
}

function summarizePending(rows: ReadonlyArray<{ kind: string }>): PendingInfo | null {
  if (!rows.length) return null;
  const kinds = new Set(rows.map((r) => r.kind));
  return { kind: PENDING_PRIORITY.find((k) => kinds.has(k)) ?? 'cleanup_revoke', count: rows.length };
}

/** 계정마다 정리 대기 요약(owner 범위). */
async function pendingByAccount(db: DbOrTx, ownerId: string, accountIds: readonly string[]): Promise<Map<string, PendingInfo>> {
  const out = new Map<string, PendingInfo>();
  if (!accountIds.length) return out;
  const rows = await db
    .select({ accountId: oauthPendingTokens.channelAccountId, kind: oauthPendingTokens.kind })
    .from(oauthPendingTokens)
    .where(and(eq(oauthPendingTokens.ownerId, ownerId), inArray(oauthPendingTokens.channelAccountId, [...accountIds])));
  const grouped = new Map<string, Array<{ kind: string }>>();
  for (const r of rows) grouped.set(r.accountId, [...(grouped.get(r.accountId) ?? []), r]);
  for (const [id, list] of grouped) out.set(id, summarizePending(list)!);
  return out;
}

async function pendingInfoOf(db: DbOrTx, ownerId: string, accountId: string): Promise<PendingInfo | null> {
  return (await pendingByAccount(db, ownerId, [accountId])).get(accountId) ?? null;
}

export function healthOf(account: AccountRow, cred: OAuthCredentialRow | null, pending: PendingInfo | null, now: Date): CredentialHealth {
  return credentialHealth({
    account: { kind: account.kind, credentialState: account.credentialState },
    credential: cred ? { status: cred.status, expiresAt: cred.expiresAt, scopes: cred.scopes, revokedAt: cred.revokedAt, lastErrorCode: cred.lastErrorCode } : null,
    pendingKind: pending?.kind ?? null,
    requiredScopes: requiredScopesForPlatform(account.platform),
    now,
  });
}

/** 화면·API 응답용 연결 상태. 토큰·암호문은 넣지 않는다. 모의 연결은 MOCK 표시. */
export function accountHealthView(account: AccountRow, cred: OAuthCredentialRow | null, pending: PendingInfo | null, now: Date) {
  const health = healthOf(account, cred, pending, now);
  const mock = account.kind === 'mock';
  return {
    account_id: account.id,
    platform: account.platform,
    kind: account.kind,
    mock,
    display_name: account.displayName,
    credential_state: account.credentialState,
    status: health.status,
    status_label: CREDENTIAL_STATUS_LABEL[health.status],
    usable_for_execution: health.usable,
    credential_required: health.required,
    reason: health.reason,
    provider: cred?.provider ?? null,
    scopes_required: [...requiredScopesForPlatform(account.platform)],
    scopes_granted: cred && !cred.revokedAt ? [...cred.scopes] : [],
    missing_scopes: health.missingScopes,
    expires_at: cred?.expiresAt ? cred.expiresAt.toISOString() : null,
    connected_at: cred ? cred.connectedAt.toISOString() : null,
    last_checked_at: cred?.lastCheckedAt ? cred.lastCheckedAt.toISOString() : null,
    last_refreshed_at: cred?.lastRefreshedAt ? cred.lastRefreshedAt.toISOString() : null,
    last_error_code: cred?.lastErrorCode ?? null,
    revoked_at: cred?.revokedAt ? cred.revokedAt.toISOString() : null,
    key_version: cred?.keyVersion ?? null,
    /** FIX3·FIX4-T13: 정리 대기 종류(refresh_unknown·verify_current·cleanup_revoke 중 가장 앞의 것)와 건수만 — 봉인·행 ID 는 내보내지 않는다 */
    pending_reconcile: pending?.kind ?? null,
    pending_count: pending?.count ?? 0,
    notice: mock
      ? 'MOCK — 모의 연결입니다. 실제 Threads 계정 연결이 아니며 실제 게시에 쓰이지 않습니다.'
      : `실제 계정 — 연결·프로필 조회만(D31). 실제 게시는 하지 않습니다(${LIVE_THREADS_PUBLISH_MARKER}).`,
    /** LIVE-T1: 실제 계정이 아직 Threads 프로필 ID 에 묶이지 않음(첫 연결 전) */
    live_unbound: !mock && isUnboundLiveExternalId(account.externalAccountId),
  };
}

/**
 * LIVE-T1(D31 2단계 준비): 실제 Threads 계정 행(연결 전)을 만든다 — owner 범위, 외부 호출 없음. 이미 "연결 전" 실제 Threads 행이 있으면 그 행을 돌려준다(멱등).
 * external_account_id = 'pending:<uuid>'(첫 실제 연결 callback 이 프로필 ID 로 묶는다), state = 'disconnected'(accountReady=false — 배포 계획에 고를 수 없다;
 * 실제 게시는 D31 범위 밖). 연결 정보·토큰은 만들지 않는다.
 */
export async function createLiveThreadsAccount(db: Db, ownerId: string, now: Date = new Date()): Promise<{ account: AccountRow; created: boolean }> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(channelAccounts)
      .where(and(eq(channelAccounts.ownerId, ownerId), eq(channelAccounts.platform, 'threads'), eq(channelAccounts.kind, 'live')))
      .orderBy(asc(channelAccounts.createdAt), asc(channelAccounts.id));
    const unbound = existing.find((a) => isUnboundLiveExternalId(a.externalAccountId));
    if (unbound) return { account: unbound, created: false };
    const [row] = await tx
      .insert(channelAccounts)
      .values({
        ownerId,
        platform: 'threads',
        kind: 'live',
        externalAccountId: `${UNBOUND_LIVE_EXTERNAL_PREFIX}${randomUUID()}`,
        displayName: '실제 Threads 계정(연결 전)',
        state: 'disconnected',
        capabilitySnapshot: { mock: false, external_writes: false, publish: 'out_of_scope_D31', note: '실제 계정 — 연결·프로필 조회만(D31), 게시 안 함' },
        createdAt: now,
      })
      .returning();
    await recordAudit(tx, {
      ownerId,
      action: 'channel_account.live_created',
      entity: 'channel_account',
      entityId: row!.id,
      details: { platform: 'threads', kind: 'live', approval: 'D31', publish: 'out_of_scope' },
      at: now,
    });
    return { account: row!, created: true };
  });
}

/** LIVE-T1: 같은 owner 의 다른 Threads 계정이 이미 그 프로필에 묶여 있음 — 저장하지 않는다 */
export class OAuthAccountDuplicateError extends AppError {
  constructor() {
    super('conflict', 'oauth_account_duplicate', '이 Threads 계정은 이미 다른 배포 계정 행에 연결되어 있습니다. 연결 정보를 저장하지 않았습니다.');
  }
}
export type AccountHealthView = ReturnType<typeof accountHealthView>;

export async function getAccountHealth(db: DbOrTx, ownerId: string, accountId: string, now: Date = new Date()): Promise<AccountHealthView> {
  const account = await ownedAccount(db, ownerId, accountId);
  return accountHealthView(account, await credentialOf(db, ownerId, account.id), await pendingInfoOf(db, ownerId, account.id), now);
}

export async function listAccountHealth(db: DbOrTx, ownerId: string, now: Date = new Date()): Promise<AccountHealthView[]> {
  const accounts = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.ownerId, ownerId))
    .orderBy(asc(channelAccounts.platform), asc(channelAccounts.createdAt), asc(channelAccounts.id));
  const creds = accounts.length
    ? await db
        .select()
        .from(oauthCredentials)
        .where(and(eq(oauthCredentials.ownerId, ownerId), inArray(oauthCredentials.channelAccountId, accounts.map((a) => a.id))))
    : [];
  const byAccount = new Map(creds.map((c) => [c.channelAccountId, c]));
  const pending = await pendingByAccount(db, ownerId, accounts.map((a) => a.id));
  return accounts.map((a) => accountHealthView(a, byAccount.get(a.id) ?? null, pending.get(a.id) ?? null, now));
}

/** /ops 용 상태별 계정 수(owner 범위). */
export async function credentialHealthCounts(db: DbOrTx, ownerId: string, now: Date = new Date()): Promise<Record<CredentialStatus, number>> {
  const out = Object.fromEntries(CREDENTIAL_STATUSES.map((s) => [s, 0])) as Record<CredentialStatus, number>;
  for (const v of await listAccountHealth(db, ownerId, now)) out[v.status]++;
  return out;
}

/**
 * 실행 게이트: 계정마다 연결 상태. executePlan·beginSend·retryItem 이 같은 트랜잭션에서 부른다.
 * 연결 정보가 필요 없는 계정(연결한 적 없는 모의 계정)은 usable=true.
 */
export async function credentialGate(tx: DbOrTx, ownerId: string, accountIds: readonly string[], now: Date): Promise<Map<string, CredentialHealth>> {
  const ids = [...new Set(accountIds)];
  const out = new Map<string, CredentialHealth>();
  if (!ids.length) return out;
  const accounts = await tx
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.ownerId, ownerId), inArray(channelAccounts.id, ids)));
  const creds = await tx
    .select()
    .from(oauthCredentials)
    .where(and(eq(oauthCredentials.ownerId, ownerId), inArray(oauthCredentials.channelAccountId, ids)));
  const byAccount = new Map(creds.map((c) => [c.channelAccountId, c]));
  const pending = await pendingByAccount(tx, ownerId, ids);
  for (const a of accounts) out.set(a.id, healthOf(a, byAccount.get(a.id) ?? null, pending.get(a.id) ?? null, now));
  return out;
}

// ---- 연결 시작 ----

export interface ConnectStart {
  authorizeUrl: string;
  expiresAt: Date;
  provider: string;
  mock: boolean;
  scopes: string[];
}

/**
 * 연결 시작: 계정(owner) 확인 → 공급자 선택(지원·live 준비 확인) → 키 확인 → state·PKCE 를 만들어 연결 요청 행(state 는 hash 만,
 * verifier 는 봉인)을 저장하고 공급자의 authorize URL 을 돌려준다. 요청 scope = 공급자의 최소 scope 만.
 * 만료·사용된 이 owner 의 연결 요청은 여기서 지운다.
 */
export async function startOAuthConnect(
  db: Db,
  input: { ownerId: string; sessionId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; redirectUri: string; now?: Date },
): Promise<ConnectStart> {
  const now = input.now ?? new Date();
  const account = await ownedAccount(db, input.ownerId, input.accountId);
  const provider = input.providerFor(account);
  const keyring = input.keyring();
  const scopes = [...provider.requiredScopes()];
  const state = newOAuthState();
  const verifier = newCodeVerifier();
  const stateId = randomUUID();
  const sealed = sealSecret(keyring, verifier, verifierAad(input.ownerId, account.id, stateId));
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
  await db.transaction(async (tx) => {
    // FIX2-T13: 발급 시점의 해제 세대를 계정 잠금 아래에서 읽어 기록한다(해제 시작과 직렬화).
    const { cred } = await lockAccountCredential(tx, input.ownerId, account.id);
    await tx
      .delete(oauthStates)
      .where(and(eq(oauthStates.ownerId, input.ownerId), or(lte(oauthStates.expiresAt, now), isNotNull(oauthStates.usedAt))));
    await tx.insert(oauthStates).values({
      revocationEpoch: cred?.revocationEpoch ?? 0,
      id: stateId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      channelAccountId: account.id,
      provider: provider.id,
      stateHash: hashOAuthState(state),
      encryptedVerifier: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      redirectUri: input.redirectUri,
      scopes,
      expiresAt,
      createdAt: now,
    });
    await recordAudit(tx, {
      ownerId: input.ownerId,
      action: 'oauth.connect_start',
      entity: 'channel_account',
      entityId: account.id,
      // LIVE-T1: 실제 Threads 는 PKCE 미지원(문서) — challenge 를 보내지 않으므로 'none'(verifier 는 틀 공통으로 봉인해 둔다)
      details: { provider: provider.id, mock: provider.mock, scopes: scopes.join(','), pkce: provider.pkce === false ? 'none' : 'S256' },
      at: now,
    });
  });
  const authorizeUrl = provider.buildAuthorizeUrl({
    state,
    codeChallenge: codeChallengeS256(verifier),
    redirectUri: input.redirectUri,
    scopes,
    loginHint: provider.mock ? account.externalAccountId : undefined,
  });
  return { authorizeUrl, expiresAt, provider: provider.id, mock: provider.mock, scopes };
}


// ---- 잠금·세대 ----

/**
 * 시험 전용 끼어들기 지점(공급자 호출과 되쓰기 사이의 동시 변경을 재현). 운영 코드는 설정하지 않는다.
 * 모두 DB 트랜잭션 밖에서 불린다.
 */
export const oauthTestHooks: {
  afterProviderRefresh?: () => Promise<void>;
  beforeProviderCheck?: () => Promise<void>;
  afterRevokeMarked?: () => Promise<void>;
  beforeCallbackStore?: () => Promise<void>;
  insideCallbackStore?: () => Promise<void>;
  beforeRefreshSeal?: () => Promise<void>;
  insideRefreshStore?: () => Promise<void>;
  afterRefreshStoreCommit?: () => Promise<void>;
  beforeRotateStateUpdate?: () => Promise<void>;
  /** FIX3-T13: 저장 여부 다시 읽기(tokenStoredOutcome) 직전 — 던지면 다시 읽기 실패(판정 불가) */
  beforeStoredOutcomeRead?: () => Promise<void>;
  /** FIX3-T13: 정리 대기 기록 트랜잭션 안 — 던지면 기록 실패 */
  insidePendingRecord?: () => Promise<void>;
  /** FIX3-T13: 정리 대기 처리의 공급자 호출 뒤·되쓰기 전 */
  afterReconcileProvider?: () => Promise<void>;
  /** FIX5-T13: 연결 해제가 철회 확인 안 된 현재 토큰을 정리 대기로 봉인하기 직전 — 던지면 봉인 실패 */
  beforeRevokeCurrentSeal?: () => Promise<void>;
  /** FIX6-T13: 모든 pass 가 낡은 판정으로 끝난 뒤 다음 시도 시각을 미루기 직전(다른 호출이 그 사이 예약을 바꾸는 교차 재현) */
  beforeStaleBump?: () => Promise<void>;
  /** FIX6-T13: 연결 해제 마무리 트랜잭션 안, 감사 기록 뒤(커밋 전) — 던지면 마무리 전체가 되돌려진다(시험 전용 — 트랜잭션 안에서 불린다) */
  insideRevokeFinish?: () => Promise<void>;
  /** FIX7-T13: worker 가 미완료 해제를 훑고 메모리 확인을 마친 뒤·재개 호출 직전(훑은 뒤 해제 완료·다시 연결 교차 재현) */
  beforeRevokeResume?: (c: { ownerId: string; accountId: string }) => Promise<void>;
  /** FIX1-M4DEV1: 모의 다시 채우기 읽기(loadMockCredentialsForRehydration) 직전 — 던지면 일시적 DB·읽기 실패 흉내 */
  beforeMockRehydrationLoad?: () => Promise<void>;
} = {};

interface Locked {
  account: AccountRow;
  cred: OAuthCredentialRow | null;
}

/**
 * FIX-T13(Codex P1·Q3): 연결 정보 변경의 공통 잠금 순서 = channel_accounts 행 FOR UPDATE → oauth_credentials 행 FOR UPDATE.
 * 연결 저장·갱신·확인·해제·키 교체·복호화 실패 기록이 모두 이 순서로 잡는다. 실행 쪽(executePlan·beginSend·retryItem)은 같은 계정을
 * FOR SHARE 로 먼저 잡으므로 차단 상태가 먼저 커밋되면 그 뒤에 읽는다.
 */
async function lockAccountCredential(tx: DbOrTx, ownerId: string, accountId: string): Promise<Locked> {
  const account = await ownedAccount(tx, ownerId, accountId, 'update');
  const rows = await tx
    .select()
    .from(oauthCredentials)
    .where(and(eq(oauthCredentials.ownerId, ownerId), eq(oauthCredentials.channelAccountId, account.id)))
    .for('update')
    .limit(1);
  return { account, cred: rows[0] ?? null };
}

/** 되쓰기 조건: 읽었던 세대 그대로이고 해제(진행 중 포함)되지 않음 */
const sameLiveGeneration = (cred: OAuthCredentialRow | null, generation: number): cred is OAuthCredentialRow =>
  !!cred && cred.tokenGeneration === generation && !cred.revokedAt && cred.status !== 'revoking' && cred.encryptedToken !== null;

type RemoteRevoke = 'ok' | 'ok_already_revoked' | 'failed' | 'unknown' | 'unsupported';

/**
 * 공급자에서 토큰을 철회한다(정리용 — 실패해도 던지지 않는다).
 * FIX3-T13: token_revoked·invalid_token(공급자가 모르는 토큰 — 쓸 수 없음) = 이미 철회됨. provider_error(일시·원인 불명) = unknown(철회됐는지 모름).
 * 그 밖의 공급자 거부 = failed(철회되지 않음). failed·unknown 은 정리 대기(cleanup_revoke)로 남겨 다음 확인·tick 이 다시 철회한다.
 * LIVE-T1(D31): 공급자에 철회 API 가 없으면(실제 Threads) unsupported — 다시 시도해도 바뀌지 않으므로 정리 대기로 남기지 않는다(실패 아님).
 * 로컬 삭제(암호문 삭제·revoked_at·승인 철회)는 T13 규칙 그대로 하고, 감사에 remote_revoke=unsupported 를 남긴다. 토큰은 공급자 쪽에서
 * 만료(장기 토큰 60일)될 때까지 유효할 수 있다 — 사용자가 Threads 앱 설정에서 앱 권한을 지우면 무효가 된다(README·핸드오프).
 */
async function revokeAtProvider(provider: OAuthProvider, tokens: StoredOAuthTokens, now: Date): Promise<{ result: RemoteRevoke; code: string | null }> {
  try {
    const r = await provider.revoke({ tokens, now });
    if (isRevokeUnsupported(r)) return { result: 'unsupported', code: null };
    return { result: 'ok', code: null };
  } catch (e) {
    const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
    if (code === 'token_revoked' || code === 'invalid_token') return { result: 'ok_already_revoked', code };
    return { result: code === 'provider_error' ? 'unknown' : 'failed', code };
  }
}

const cleanupFailed = (r: RemoteRevoke) => r === 'failed' || r === 'unknown';

/** FIX3-T13: 정리 철회 실패·불명 감사(코드 값만). context = 어느 정리였는지. */
async function auditCleanupFailure(
  db: DbOrTx,
  input: { ownerId: string; accountId: string; context: string; result: RemoteRevoke; code: string | null; pendingRecord: string; now: Date },
): Promise<void> {
  await recordAudit(db, {
    ownerId: input.ownerId,
    action: input.result === 'unknown' ? 'oauth.cleanup_revoke_unknown' : 'oauth.cleanup_revoke_failed',
    entity: 'channel_account',
    entityId: input.accountId,
    details: { context: input.context, issued_token_revoke: input.result, issued_token_revoke_error: input.code, pending_record: input.pendingRecord },
    at: input.now,
  }).catch(() => undefined);
}

// ---- callback ----

export interface CallbackInput {
  ownerId: string;
  sessionId: string;
  query: { state?: string; code?: string; error?: string };
  /** 요청 URL 의 origin + path(query 제외) */
  requestTarget: string;
  /** 설정의 redirect URI(정확 일치) */
  redirectUri: string;
  providerFor: ProviderFor;
  keyring: KeyringSource;
  now?: Date;
}

async function rejectCallback(db: DbOrTx, ownerId: string, accountId: string | null, reason: string, now: Date, extra: Record<string, string | null> = {}) {
  await recordAudit(db, {
    ownerId,
    action: 'oauth.callback_rejected',
    entity: 'channel_account',
    entityId: accountId,
    details: { reason, ...extra },
    at: now,
  });
}

/**
 * callback: state 확인(형식 → 이 owner 의 행, 잠금) → **같은 세션인지 먼저**(다른 세션 요청은 소비하지 않음, Codex Q1) → 미사용 →
 * 사용 처리(정상 세션은 결과와 관계없이 한 번만) → 만료·redirect URI·공급자 거부 확인 → verifier 로 code 교환(PKCE) →
 * 공급자의 계정 = 이 계정인지 확인 → 계정·연결 정보 잠금 아래 저장(세대 +1).
 * 교환 뒤 실패(계정 정보·정체 불일치·저장 실패·해제 진행 중·요청 뒤 해제됨)는 받은 토큰을 공급자에서 철회하고 결과를 감사에 남긴다.
 */
export async function completeOAuthCallback(db: Db, input: CallbackInput): Promise<AccountHealthView> {
  const now = input.now ?? new Date();
  const { ownerId } = input;
  const state = input.query.state;
  if (!isWellFormedOAuthState(state)) {
    await rejectCallback(db, ownerId, null, 'oauth_state_invalid', now);
    throw new OAuthFlowError('oauth_state_invalid');
  }
  const checked = await db.transaction(async (tx): Promise<{ fail: OAuthFlowErrorCode; accountId: string | null; consumed: boolean } | { row: OAuthStateRow }> => {
    const rows = await tx
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.stateHash, hashOAuthState(state)), eq(oauthStates.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return { fail: 'oauth_state_invalid', accountId: null, consumed: false };
    if (row.sessionId !== input.sessionId) return { fail: 'oauth_state_invalid', accountId: row.channelAccountId, consumed: false };
    if (row.usedAt) return { fail: 'oauth_state_used', accountId: row.channelAccountId, consumed: false };
    await tx.update(oauthStates).set({ usedAt: now }).where(eq(oauthStates.id, row.id));
    if (row.expiresAt.getTime() <= now.getTime()) return { fail: 'oauth_state_expired', accountId: row.channelAccountId, consumed: true };
    if (input.requestTarget !== row.redirectUri || row.redirectUri !== input.redirectUri) return { fail: 'oauth_redirect_mismatch', accountId: row.channelAccountId, consumed: true };
    if (input.query.error) return { fail: 'oauth_denied', accountId: row.channelAccountId, consumed: true };
    if (!input.query.code) return { fail: 'oauth_bad_request', accountId: row.channelAccountId, consumed: true };
    return { row };
  });
  if ('fail' in checked) {
    await rejectCallback(db, ownerId, checked.accountId, checked.fail, now, { state_consumed: checked.consumed ? 'yes' : 'no' });
    throw new OAuthFlowError(checked.fail);
  }
  const row = checked.row;
  const account = await ownedAccount(db, ownerId, row.channelAccountId);
  const provider = input.providerFor(account);
  if (provider.id !== row.provider) {
    await rejectCallback(db, ownerId, account.id, 'provider_changed', now);
    throw new OAuthFlowError('oauth_state_invalid');
  }
  const keyring = input.keyring();
  let verifier: string;
  try {
    verifier = openSecret(keyring, row.encryptedVerifier, row.keyVersion, verifierAad(ownerId, account.id, row.id));
  } catch (e) {
    await rejectCallback(db, ownerId, account.id, 'verifier_unreadable', now, { problem: e instanceof SecretDecryptError ? e.problem : 'unknown' });
    throw new OAuthFlowError('oauth_exchange_failed', { reason: 'verifier_unreadable' });
  }
  let tokens: OAuthTokenSet;
  try {
    tokens = await provider.exchangeCode({ code: input.query.code!, codeVerifier: verifier, redirectUri: row.redirectUri, now });
  } catch (e) {
    const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
    // LIVE-T1(D31): 실제 공급자의 부가 정보(숫자·열거만). ambiguous = 코드가 소비됐거나 토큰이 발급됐을 수 있지만 받지 못함 —
    // 손에 든 토큰이 없으므로 저장·정리 대기(봉인할 값 없음)·철회(Threads 는 철회 API 없음) 모두 할 수 없다. state 는 이미 사용 처리됐다(다시 연결).
    const d = e instanceof OAuthProviderError ? e.detail : null;
    await rejectCallback(db, ownerId, account.id, 'exchange_failed', now, {
      provider_error: code,
      ...(d ? { provider_reason: d.reason, provider_step: d.step ?? null, outcome_ambiguous: d.ambiguous ? 'yes' : 'no' } : {}),
      // FIX1-LIVET1(Codex review-LIVET1 Q3): 장기 교환 실패 = 단기 토큰은 발급됐다 — "발급 없음"이 아니다. 공급자에 유효하게 남아 있을 수 있고
      // 손에 없으므로(공급자 메모리에서 버림) 철회하지 못했다(Threads 철회 API 도 없음).
      ...(d?.shortTokenIssued ? { short_token_issued: 'yes', short_token_remote_state: 'may_be_valid', short_token_revoke: 'not_possible' } : {}),
    });
    throw new OAuthFlowError('oauth_exchange_failed', { reason: code, ...(d?.ambiguous ? { outcome: 'unknown' } : {}) });
  }
  // 여기부터 공급자에 유효한 토큰이 있다 — 저장하지 못하면 철회한다.
  const issued: StoredOAuthTokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.accessExpiresAt ? tokens.accessExpiresAt.toISOString() : null };
  // FIX3-T13(놓친 케이스) → FIX4-T13(P1 :908): 정리 철회가 실패·불명이면 받은 토큰을 봉인해 정리 대기(cleanup_revoke) **새 행**으로 남긴다 —
  // 같은 계정의 다른 callback 이 남긴 행이 있어도 버리지 않고, 연결 정보 행이 없어도(첫 연결) 그대로. 정리될 때까지 이 계정 실행 차단.
  const discard = async (reason: string, extra: Record<string, string | null> = {}) => {
    const cleanup = await revokeAtProvider(provider, issued, now);
    let pendingRecord = 'not_requested';
    if (cleanupFailed(cleanup.result)) {
      const mark = await markAfterIssuance(db, { ownerId, accountId: account.id, generation: null, markStoreFailed: false, pending: { kind: 'cleanup_revoke', tokens: issued, source: `callback_${reason}` }, keyring: input.keyring, now });
      pendingRecord = mark.pending;
      await auditCleanupFailure(db, { ownerId, accountId: account.id, context: `callback_${reason}`, result: cleanup.result, code: cleanup.code, pendingRecord, now });
    }
    await rejectCallback(db, ownerId, account.id, reason, now, { ...extra, issued_token_revoke: cleanup.result, issued_token_revoke_error: cleanup.code, pending_record: pendingRecord }).catch(() => undefined);
  };
  let info;
  try {
    info = await provider.accountInfo({ accessToken: tokens.accessToken, now });
  } catch (e) {
    const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
    await discard('account_info_failed', { provider_error: code });
    throw new OAuthFlowError('oauth_exchange_failed', { reason: code });
  }
  // LIVE-T1(D31): 연결 전 실제 계정(pending:)은 첫 연결에서 공급자 프로필 ID 로 묶는다(저장 트랜잭션 안에서 다시 확인). 그 밖에는 T13 그대로 — 다르면 거부.
  const bindLive = account.kind === 'live' && isUnboundLiveExternalId(account.externalAccountId);
  if (bindLive && (!info.externalAccountId || isUnboundLiveExternalId(info.externalAccountId) || info.externalAccountId.startsWith('mock:'))) {
    await discard('account_mismatch');
    throw new OAuthAccountMismatchError();
  }
  if (!bindLive && info.externalAccountId !== account.externalAccountId) {
    await discard('account_mismatch');
    throw new OAuthAccountMismatchError();
  }
  // FIX2-T13(Codex P1 :575 같은 유형): 발급 뒤 봉인·저장 전체를 감싼다. 저장되지 않았음이 확인되면 철회, 결과가 불명확하면 다시 읽어 판정.
  let sealedCt: string | null = null;
  try {
    const sealed = sealSecret(keyring, encodeTokens(tokens), tokenAad(ownerId, account.id));
    sealedCt = sealed.ciphertext;
    await oauthTestHooks.beforeCallbackStore?.();
    return await db.transaction(async (tx) => {
      const { account: acc, cred: existing } = await lockAccountCredential(tx, ownerId, account.id);
      if (existing?.status === 'revoking') throw new CredentialBusyError();
      // FIX2-T13(Codex P1 :439): 이 연결 요청을 만든 뒤 연결 해제가 시작됐다면(해제 세대가 바뀜 — 그 뒤 다시 연결됐어도) 저장하지 않는다.
      // 해제 세대는 다시 연결로 초기화되지 않으므로 시각 비교 없이 판정한다.
      if ((existing?.revocationEpoch ?? 0) !== row.revocationEpoch) throw new OAuthFlowError('oauth_state_invalid', { reason: 'revoked_after_request' });
      // LIVE-T1(D31): 잠금 아래에서 계정 정체를 다시 본다. 아직 연결 전(pending:)이면 프로필 ID 로 묶고, 그 사이 묶였으면 같은 ID 일 때만.
      let accountBound = false;
      if (isUnboundLiveExternalId(acc.externalAccountId)) {
        if (acc.kind !== 'live') throw new OAuthAccountMismatchError();
        const dup = await tx
          .select({ id: channelAccounts.id })
          .from(channelAccounts)
          .where(and(eq(channelAccounts.ownerId, ownerId), eq(channelAccounts.platform, acc.platform), eq(channelAccounts.externalAccountId, info.externalAccountId)))
          .limit(1);
        if (dup.length) throw new OAuthAccountDuplicateError();
        await tx
          .update(channelAccounts)
          .set({ externalAccountId: info.externalAccountId, displayName: info.displayName.slice(0, 200) })
          .where(and(eq(channelAccounts.id, acc.id), eq(channelAccounts.ownerId, ownerId)));
        acc.externalAccountId = info.externalAccountId;
        acc.displayName = info.displayName.slice(0, 200);
        accountBound = true;
      } else if (acc.externalAccountId !== info.externalAccountId) {
        throw new OAuthAccountMismatchError();
      }
      const generation = (existing?.tokenGeneration ?? 0) + 1;
      const values = {
        encryptedToken: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        tokenGeneration: generation,
        expiresAt: tokens.expiresAt,
        scopes: [...tokens.scopes],
        status: 'active',
        connectedAt: now,
        lastCheckedAt: now,
        lastRefreshedAt: null,
        lastErrorCode: null,
        revokedAt: null,
        revokeOpId: null,
        revokeResumeAt: null,
        revokeResumeAttempts: 0,
        updatedAt: now,
      };
      if (existing) {
        await tx.update(oauthCredentials).set(values).where(eq(oauthCredentials.id, existing.id));
      } else {
        await tx.insert(oauthCredentials).values({ ownerId, channelAccountId: acc.id, provider: provider.id, isMock: provider.mock, createdAt: now, ...values });
      }
      if (acc.credentialState !== 'linked') {
        await tx.update(channelAccounts).set({ credentialState: 'linked' }).where(and(eq(channelAccounts.id, acc.id), eq(channelAccounts.ownerId, ownerId)));
      }
      await oauthTestHooks.insideCallbackStore?.();
      const required = provider.requiredScopes();
      await recordAudit(tx, {
        ownerId,
        action: 'oauth.connected',
        entity: 'channel_account',
        entityId: acc.id,
        details: {
          provider: provider.id,
          mock: provider.mock,
          reconnect: existing !== null,
          account_bound: accountBound,
          token_generation: generation,
          revocation_epoch: row.revocationEpoch,
          scopes: tokens.scopes.join(','),
          missing_scopes: required.filter((s) => !tokens.scopes.includes(s)).join(','),
          expires_at: tokens.expiresAt.toISOString(),
          key_version: sealed.keyVersion,
        },
        at: now,
      });
      const fresh = (await credentialOf(tx, ownerId, acc.id))!;
      return accountHealthView({ ...acc, credentialState: 'linked' }, fresh, await pendingInfoOf(tx, ownerId, acc.id), now);
    });
  } catch (e) {
    const outcome = sealedCt ? await tokenStoredOutcome(db, ownerId, account.id, sealedCt, issued.accessToken, input.keyring) : 'not_stored';
    if (outcome === 'stored') return getAccountHealth(db, ownerId, account.id, now);
    if (outcome === 'unknown') {
      // 저장됐을 수도 있으므로 철회하지 않는다(유효한 연결을 깨지 않음). FIX3-T13(Q14): 받은 토큰을 봉인해 정리 대기(refresh_unknown —
      // 살아 있는 행이 아니면 cleanup_revoke)로 남기고 정리될 때까지 차단 — 다음 확인·갱신·tick 이 판정한다(reconcilePendingCredential).
      const mark = await markAfterIssuance(db, { ownerId, accountId: account.id, generation: null, markStoreFailed: false, pending: { kind: 'refresh_unknown', tokens: issued, source: 'callback' }, keyring: input.keyring, now });
      if (mark.pending !== 'recorded') await auditPendingRecordFailed(db, { ownerId, accountId: account.id, context: 'callback', result: mark.pending, now });
      await rejectCallback(db, ownerId, account.id, 'store_outcome_unknown', now, { pending_record: mark.pending, pending_kind: mark.pendingKind }).catch(() => undefined);
      throw e;
    }
    await discard('store_failed', { error: e instanceof AppError ? e.code : 'db_error' });
    throw e;
  }
}

/**
 * FIX2-T13: 저장 트랜잭션이 예외로 끝났을 때 이 토큰이 실제로 저장됐는지 계정 잠금 아래에서 다시 읽어 판정한다.
 * 같은 봉인 문자열이거나(그 사이 키 교체가 있으면) 복호화한 access token 이 같으면 stored. 다시 읽기 자체가 실패하면 unknown.
 */
async function tokenStoredOutcome(
  db: Db,
  ownerId: string,
  accountId: string,
  sealedCiphertext: string,
  accessToken: string,
  keyring: KeyringSource,
): Promise<'stored' | 'not_stored' | 'unknown'> {
  try {
    await oauthTestHooks.beforeStoredOutcomeRead?.();
    return await db.transaction(async (tx) => {
      const { cred } = await lockAccountCredential(tx, ownerId, accountId);
      if (!cred?.encryptedToken || cred.keyVersion === null || cred.revokedAt) return 'not_stored' as const;
      if (cred.encryptedToken === sealedCiphertext) return 'stored' as const;
      try {
        const t = decodeTokens(openSecret(keyring(), cred.encryptedToken, cred.keyVersion, tokenAad(ownerId, accountId)));
        return t.accessToken === accessToken ? ('stored' as const) : ('not_stored' as const);
      } catch {
        return 'unknown' as const;
      }
    });
  } catch {
    return 'unknown';
  }
}

// ---- 갱신·확인·해제 ----

interface UseSnapshot {
  account: AccountRow;
  provider: OAuthProvider;
  tokens: StoredOAuthTokens;
  generation: number;
  expiresAt: Date | null;
}

/**
 * 공급자 호출 전 읽기(계정·연결 정보 잠금 아래): 연결 정보 있음·해제 아님·해제 진행 중 아님 → 복호화. 복호화 실패는 같은 잠금 아래에서
 * 오류로 기록하고(세대가 그대로임이 보장됨) 커밋한 뒤 던진다.
 */
async function readForUse(db: Db, ownerId: string, accountId: string, providerFor: ProviderFor, keyring: KeyringSource, now: Date): Promise<UseSnapshot> {
  const account = await ownedAccount(db, ownerId, accountId);
  const provider = providerFor(account);
  const ring = keyring();
  const r = await db.transaction(async (tx): Promise<UseSnapshot | { error: SecretDecryptError } | { busy: true } | { missing: true }> => {
    const { account: acc, cred } = await lockAccountCredential(tx, ownerId, account.id);
    if (!cred || cred.revokedAt || !cred.encryptedToken || cred.keyVersion === null) return { missing: true };
    if (cred.status === 'revoking') return { busy: true };
    try {
      const tokens = decodeTokens(openSecret(ring, cred.encryptedToken, cred.keyVersion, tokenAad(ownerId, acc.id)));
      return { account: acc, provider, tokens, generation: cred.tokenGeneration, expiresAt: cred.expiresAt };
    } catch (e) {
      if (!(e instanceof SecretDecryptError)) throw e;
      await tx
        .update(oauthCredentials)
        .set({ status: 'error', lastErrorCode: `decrypt_${e.problem}`, updatedAt: now })
        .where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.tokenGeneration, cred.tokenGeneration)));
      return { error: e };
    }
  });
  if ('missing' in r) throw new CredentialNotFoundError();
  if ('busy' in r) throw new CredentialBusyError();
  if ('error' in r) throw r.error;
  return r;
}

/**
 * T14(D26): 작업 처리기(서버) 안에서 전송용 접근 토큰을 꺼낸다 — 어댑터 prepare/reconcile 의 ctx.credential 이 부른다.
 * 계정 → 연결 정보 잠금(짧은 트랜잭션) 아래 health 가 usable 일 때만 봉인을 연다. 쓸 수 없으면 코드만 돌려준다:
 * credential_<상태>(만료·해제·정리 대기·다시 연결 필요 …), credential_missing, secrets_not_configured, decrypt_<문제>(이때는 readForUse 와 같은
 * 규칙으로 같은 세대일 때만 error 기록). 토큰은 반환값으로만 나가며 로그·감사·오류에 넣지 않는다.
 */
export async function readAccessTokenForSend(
  db: Db,
  input: { ownerId: string; accountId: string; keyring: KeyringSource; now?: Date },
): Promise<{ ok: true; token: string } | { ok: false; code: string }> {
  const now = input.now ?? new Date();
  let ring: SecretKeyring;
  try {
    ring = input.keyring();
  } catch {
    return { ok: false, code: 'secrets_not_configured' };
  }
  try {
    return await db.transaction(async (tx): Promise<{ ok: true; token: string } | { ok: false; code: string }> => {
      const { account, cred } = await lockAccountCredential(tx, input.ownerId, input.accountId);
      const health = healthOf(account, cred, await pendingInfoOf(tx, input.ownerId, account.id), now);
      if (!health.usable) return { ok: false, code: `credential_${health.status}` };
      if (!cred || cred.revokedAt || !cred.encryptedToken || cred.keyVersion === null) return { ok: false, code: 'credential_missing' };
      try {
        const tokens = decodeTokens(openSecret(ring, cred.encryptedToken, cred.keyVersion, tokenAad(input.ownerId, account.id)));
        // T15(D27): 짧은 access token(Google 형)이 만료(또는 곧 만료)면 토큰을 내주지 않는다 — 호출자가 T13 갱신 경로를 한 번 부른 뒤 다시 읽는다.
        if (tokens.accessExpiresAt && Date.parse(tokens.accessExpiresAt) <= now.getTime() + ACCESS_TOKEN_REFRESH_MARGIN_MS) {
          return { ok: false, code: 'credential_access_token_stale' };
        }
        return { ok: true, token: tokens.accessToken };
      } catch (e) {
        if (!(e instanceof SecretDecryptError)) throw e;
        await tx
          .update(oauthCredentials)
          .set({ status: 'error', lastErrorCode: `decrypt_${e.problem}`, updatedAt: now })
          .where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.tokenGeneration, cred.tokenGeneration)));
        return { ok: false, code: `decrypt_${e.problem}` };
      }
    });
  } catch {
    return { ok: false, code: 'credential_unavailable' };
  }
}

/** M4-DEV1: 다시 채울 수 있는 모의 공급자 ID(실제 공급자 'threads' 는 절대 포함하지 않는다). */
const REHYDRATABLE_MOCK_PROVIDERS = ['mock_threads', 'mock_google', 'mock_instagram'] as const;

/** M4-DEV1: 모의 공급자 메모리 다시 채우기용 스냅샷 한 건(서버 메모리 안에서만 — 기록·감사·응답에 넣지 않는다). */
export interface MockCredentialSnapshot {
  provider: (typeof REHYDRATABLE_MOCK_PROVIDERS)[number];
  externalAccountId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  accessExpiresAt: Date | null;
  scopes: string[];
}

/**
 * FIX2-M4DEV1(Codex review-FIX-M4DEV1 P1 :778): 정리 대기 행 하나가 현재 토큰 C(세대 `generation`)를 무효로 만들었을 수 있는가 — true 면 C 를 다시 등록하지 않는다.
 * - refresh_unknown: base_generation 이 없거나(callback — C 가 그 뒤 무엇인지 모름) C 의 세대 이상이면 true. 같은 세대면 그 갱신이 C 로 새 토큰을 받았다 —
 *   모의 공급자(Threads·Instagram 형 이전 토큰 무효, Google 형 grant 회전)에서 C 는 이미 무효다. 세대가 그 뒤로 넘어갔으면 C 는 그 갱신이 받은 토큰이거나
 *   더 나중에 발급된 토큰이다(그 사이 C 를 무효로 만드는 갱신·해제는 새 세대·error·해제 상태·새 정리 대기 행을 남긴다).
 * - verify_current: base_generation 이 없거나 C 의 세대 이상이면 true(C 의 유효성을 아직 확인하지 못함). 세대가 지난 행은 정리가 확인 없이 지우는 낡은 행.
 * - cleanup_revoke: 봉인을 열어 P 가 C 와 토큰(access·refresh)을 하나라도 공유하면 true, 열 수 없거나 내용이 없으면 true(판정 불가 — 등록 안 함).
 *   P ≠ C 이면 false — P 철회는 P(Google 형은 P 의 grant)만 무효로 하고 C 와 grant 를 공유하지 않는다(모의 발급마다 새 grant).
 * - 그 밖의 종류: true.
 */
function pendingMayInvalidateCurrent(p: OAuthPendingRow, generation: number, current: StoredOAuthTokens, ring: SecretKeyring, ownerId: string, accountId: string): boolean {
  if (p.kind === 'refresh_unknown' || p.kind === 'verify_current') return p.baseGeneration === null || p.baseGeneration >= generation;
  if (p.kind !== 'cleanup_revoke') return true;
  if (!p.sealedToken || p.keyVersion === null) return true;
  let pending: StoredOAuthTokens;
  try {
    pending = decodeTokens(openSecret(ring, p.sealedToken, p.keyVersion, pendingAad(ownerId, accountId)));
  } catch {
    return true;
  }
  const mine = new Set([current.accessToken, current.refreshToken].filter((t): t is string => !!t));
  return [pending.accessToken, pending.refreshToken].some((t) => !!t && mine.has(t));
}

/**
 * M4-DEV1(개발 품질): 개발 서버 재시작 뒤 모의 연결이 끊기지 않도록, 모의 공급자 메모리를 다시 채울 연결 정보를 읽는다(**읽기 전용**).
 * 대상: 해제되지 않은(revoked_at null·status active) 모의 공급자 행(is_mock·provider ∈ mock_*), 계정 kind = mock, 연결 상태가 쓸 수 있음
 * (connected·expiring_soon).
 * FIX1-M4DEV1(Codex review-M4DEV1 P1 :781) → FIX2-M4DEV1(Codex review-FIX-M4DEV1 P1 :778): 정리 대기(oauth_pending_tokens) 중 **현재 토큰(C)을
 * 무효로 만들 수 있는 행**이 하나라도 있는 계정만 제외한다(pendingMayInvalidateCurrent). 그런 C 는 공급자 쪽에서 이미 회전·철회로 무효가 됐을 수 있어
 * 유효로 다시 등록하면 정리 판정이 잘못된 "유효" 근거를 보게 된다 — 제외된 C 는 "알 수 없는 토큰"으로 남고, 정리 판정이 C 를 확인하면 무효(error)로
 * 끝난다(실행 차단 유지, 다시 연결 안내). C 와 무관한 cleanup_revoke(다른 토큰 P 의 철회 의무 — 모의 공급자는 발급마다 별도 grant 라 P 철회가 C 에
 * 닿지 않음)만 있는 계정은 C 를 등록한다 — 재시작 뒤 첫 확인이 P 정리를 마치면 C 가 그대로 쓰인다(다시 연결 없음). 정리 대기 토큰 P 자체는 등록하지 않는다.
 * 봉인을 열 수 없는 행은 건너뛴다 — 상태를 쓰지 않으므로 기존 오류·차단 처리(readForUse·readAccessTokenForSend 의 decrypt_<문제>)가 그대로다.
 * 모든 owner 의 행을 읽는다(프로세스 하나의 모의 공급자 상태). 반환값은 개수와 토큰 — 호출자는 토큰을 모의 공급자 메모리에만 넘긴다.
 */
export async function loadMockCredentialsForRehydration(
  db: DbOrTx,
  input: { keyring: SecretKeyring; now?: Date },
): Promise<{ entries: MockCredentialSnapshot[]; skipped: number }> {
  await oauthTestHooks.beforeMockRehydrationLoad?.();
  const now = input.now ?? new Date();
  const rows = await db
    .select({ cred: oauthCredentials, account: channelAccounts })
    .from(oauthCredentials)
    .innerJoin(channelAccounts, and(eq(channelAccounts.id, oauthCredentials.channelAccountId), eq(channelAccounts.ownerId, oauthCredentials.ownerId)))
    .where(
      and(
        eq(oauthCredentials.isMock, true),
        inArray(oauthCredentials.provider, [...REHYDRATABLE_MOCK_PROVIDERS]),
        eq(oauthCredentials.status, 'active'),
        isNull(oauthCredentials.revokedAt),
        isNotNull(oauthCredentials.encryptedToken),
        eq(channelAccounts.kind, 'mock'),
      ),
    );
  // FIX2-M4DEV1: 정리 대기는 계정 단위로 읽어 행마다 "현재 토큰을 무효로 만들 수 있는가"를 판정한다(pendingMayInvalidateCurrent).
  const pendingByKey = new Map<string, OAuthPendingRow[]>();
  if (rows.length) {
    const pend = await db
      .select()
      .from(oauthPendingTokens)
      .where(inArray(oauthPendingTokens.channelAccountId, [...new Set(rows.map((r) => r.account.id))]));
    for (const p of pend) {
      const k = `${p.ownerId}:${p.channelAccountId}`;
      pendingByKey.set(k, [...(pendingByKey.get(k) ?? []), p]);
    }
  }
  const entries: MockCredentialSnapshot[] = [];
  let skipped = 0;
  for (const { cred, account } of rows) {
    const provider = REHYDRATABLE_MOCK_PROVIDERS.find((p) => p === cred.provider);
    if (!provider || !cred.encryptedToken || cred.keyVersion === null || !cred.expiresAt) {
      skipped++;
      continue;
    }
    if (!healthOf(account, cred, null, now).usable) {
      skipped++;
      continue;
    }
    let tokens: StoredOAuthTokens;
    try {
      tokens = decodeTokens(openSecret(input.keyring, cred.encryptedToken, cred.keyVersion, tokenAad(cred.ownerId, account.id)));
    } catch (e) {
      if (!(e instanceof SecretDecryptError)) throw e;
      skipped++;
      continue;
    }
    // FIX2-M4DEV1: 현재 토큰을 무효로 만들 수 있는 정리 대기가 한 건이라도 있으면 이 계정은 등록하지 않는다(판정 불가도 등록 안 함)
    const pend = pendingByKey.get(`${cred.ownerId}:${account.id}`) ?? [];
    if (pend.some((p) => pendingMayInvalidateCurrent(p, cred.tokenGeneration, tokens, input.keyring, cred.ownerId, account.id))) {
      skipped++;
      continue;
    }
    entries.push({
      provider,
      externalAccountId: account.externalAccountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: cred.expiresAt,
      accessExpiresAt: tokens.accessExpiresAt ? new Date(tokens.accessExpiresAt) : null,
      scopes: [...cred.scopes],
    });
  }
  return { entries, skipped };
}

/** 공급자 오류 → 저장할 상태. 만료는 상태를 바꾸지 않는다(health 가 expired 로 판정). 철회·무효 토큰은 error. */
function providerFailureStatus(code: string): 'active' | 'error' {
  return code === 'token_revoked' || code === 'invalid_token' || code === 'invalid_grant' ? 'error' : 'active';
}

/**
 * 연결 정보 갱신(만료 전). 계정 잠금 아래에서 세대 G 를 읽고, 공급자 호출은 트랜잭션 밖, 되쓰기는 잠금 아래에서 세대가 아직 G 일 때만(G+1 로 저장).
 * 키 교체(재암호화)는 세대를 바꾸지 않으므로 갱신과 충돌하지 않는다(Codex P1 #1).
 * 세대가 바뀌었거나(다른 갱신·다시 연결) 해제(진행 중 포함)됐으면 새 토큰을 저장하지 않고 **공급자에서 바로 철회**한 뒤 결과를 감사에 남기고
 * 409 credential_refresh_failed(credential_changed). 실패 기록도 같은 세대일 때만(옛 결과가 새 연결을 덮지 않음).
 * 다시 연결과 같은 계정이므로 승인은 그대로 둔다(D25-1).
 */
export async function refreshCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date; trigger?: 'manual' | 'auto' },
): Promise<AccountHealthView> {
  const now = input.now ?? new Date();
  const trigger = input.trigger ?? 'manual';
  // FIX1-LIVET1(Codex review-LIVET1 P1 :199·Q4): 서버 공통 갱신 진입점 — 실제(live) 계정의 연결 정보 갱신(th_refresh_token)은 D31 범위 밖.
  // 수동 API(POST …/refresh)·작업 처리기(jobCredentials.refresh)·worker(refreshExpiringCredentials) 어느 경로든 여기서 공급자를 만들거나
  // 부르기 전에 거부한다 — 외부 호출 0, 연결 정보·상태·정리 대기 그대로. 모의 계정은 T13 그대로.
  const target = await ownedAccount(db, input.ownerId, input.accountId);
  if (target.kind !== 'mock') {
    await recordAudit(db, {
      ownerId: input.ownerId,
      action: 'oauth.refresh_refused',
      entity: 'channel_account',
      entityId: target.id,
      details: { reason: 'live_refresh_out_of_scope', kind: target.kind, platform: target.platform, trigger },
      at: now,
    });
    throw new LiveRefreshOutOfScopeError();
  }
  // FIX3-T13: 정리 대기가 있으면 먼저 정리한다 — 하나라도 남으면 갱신하지 않는다(발급을 더 늘리지 않음).
  if ((await reconcilePendingCredential(db, { ...input, now, ignoreBackoff: trigger !== 'auto' })) === 'still_pending') throw new CredentialRefreshFailedError('pending_reconcile');
  const s = await readForUse(db, input.ownerId, input.accountId, input.providerFor, input.keyring, now);
  let tokens: OAuthTokenSet;
  try {
    // 저장된 만료 시각이 지났으면 공급자에 묻지 않는다(Threads 장기 토큰은 만료 뒤 갱신 불가 — 다시 연결)
    if (!s.expiresAt || s.expiresAt.getTime() <= now.getTime()) throw new OAuthProviderError('token_expired');
    tokens = await s.provider.refresh({ tokens: s.tokens, now });
  } catch (e) {
    const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
    await db.transaction(async (tx) => {
      const { cred } = await lockAccountCredential(tx, input.ownerId, s.account.id);
      const current = sameLiveGeneration(cred, s.generation);
      if (current) {
        await tx.update(oauthCredentials).set({ status: providerFailureStatus(code), lastErrorCode: code, updatedAt: now }).where(eq(oauthCredentials.id, cred.id));
      }
      await recordAudit(tx, {
        ownerId: input.ownerId,
        action: 'oauth.refresh_failed',
        entity: 'channel_account',
        entityId: s.account.id,
        details: { provider: s.provider.id, mock: s.provider.mock, error_code: code, trigger, recorded: current, token_generation: s.generation },
        at: now,
      });
    });
    throw new CredentialRefreshFailedError(code);
  }
  await oauthTestHooks.afterProviderRefresh?.();
  // FIX2-T13(Codex P1 :575): 발급(T2) 뒤의 봉인·저장 전체를 감싼다. 예외가 나면 잠금 아래에서 다시 읽어 T2 가 저장됐는지부터 판정.
  // FIX3-T13(Codex review-FIX2-T13 P1 :690·Q14·놓친 케이스): 저장 안 됨이 확인되면 T2 를 철회하고 **읽었던 세대가 아직 현재일 때만** 연결 정보를
  // error(refresh_store_failed)로 — 공급자가 T1 을 이미 무효로 했을 수 있으므로 실행 차단. 판정 불가(refresh_unknown)·정리 철회 실패/불명
  // (cleanup_revoke)는 T2 를 봉인해 정리 대기 표시로 남기고 error(차단) — 다음 확인·갱신·worker tick 이 정리한다(reconcilePendingCredential).
  const issued: StoredOAuthTokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.accessExpiresAt ? tokens.accessExpiresAt.toISOString() : null };
  const afterIssuanceFailure = async (reason: 'store_failed' | 'credential_changed', extra: Record<string, string | number | null> = {}) => {
    const cleanup = await revokeAtProvider(s.provider, issued, now);
    const failedCleanup = cleanupFailed(cleanup.result);
    // 저장 실패(store_failed): 읽었던 세대가 아직 현재일 때만 error(refresh_store_failed) — 공급자가 T1 을 이미 무효로 했을 수 있다.
    // 정리 철회 실패·불명: T2 를 정리 대기(cleanup_revoke)로. 둘 다 계정 → 연결 정보 잠금 아래 한 트랜잭션.
    const mark =
      reason === 'store_failed' || failedCleanup
        ? await markAfterIssuance(db, {
            ownerId: input.ownerId,
            accountId: s.account.id,
            generation: s.generation,
            markStoreFailed: reason === 'store_failed',
            pending: failedCleanup ? { kind: 'cleanup_revoke', tokens: issued, source: `refresh_${reason}` } : null,
            keyring: input.keyring,
            now,
          })
        : null;
    if (failedCleanup) {
      await auditCleanupFailure(db, { ownerId: input.ownerId, accountId: s.account.id, context: `refresh_${reason}`, result: cleanup.result, code: cleanup.code, pendingRecord: mark?.pending ?? 'not_requested', now });
    }
    await recordAudit(db, {
      ownerId: input.ownerId,
      action: 'oauth.refresh_discarded',
      entity: 'channel_account',
      entityId: s.account.id,
      details: {
        provider: s.provider.id,
        mock: s.provider.mock,
        reason,
        token_generation: s.generation,
        issued_token_revoke: cleanup.result,
        issued_token_revoke_error: cleanup.code,
        credential_marked: mark?.storeFailedMarked ? 'refresh_store_failed' : 'not_marked',
        pending_record: mark?.pending ?? 'not_requested',
        trigger,
        ...extra,
      },
      at: now,
    }).catch(() => undefined);
  };
  let sealedCt: string | null = null;
  let stored: AccountHealthView | null;
  try {
    await oauthTestHooks.beforeRefreshSeal?.();
    const sealed = sealSecret(input.keyring(), encodeTokens(tokens), tokenAad(input.ownerId, s.account.id));
    sealedCt = sealed.ciphertext;
    stored = await db.transaction(async (tx) => {
      const { account, cred } = await lockAccountCredential(tx, input.ownerId, s.account.id);
      if (!sameLiveGeneration(cred, s.generation)) return null;
      const generation = s.generation + 1;
      const updated = await tx
        .update(oauthCredentials)
        .set({
          encryptedToken: sealed.ciphertext,
          keyVersion: sealed.keyVersion,
          tokenGeneration: generation,
          expiresAt: tokens.expiresAt,
          scopes: [...tokens.scopes],
          status: 'active',
          lastRefreshedAt: now,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.tokenGeneration, s.generation)))
        .returning();
      await oauthTestHooks.insideRefreshStore?.();
      await recordAudit(tx, {
        ownerId: input.ownerId,
        action: 'oauth.refreshed',
        entity: 'channel_account',
        entityId: account.id,
        details: { provider: s.provider.id, mock: s.provider.mock, expires_at: tokens.expiresAt.toISOString(), key_version: sealed.keyVersion, token_generation: generation, trigger },
        at: now,
      });
      return accountHealthView(account, updated[0]!, await pendingInfoOf(tx, input.ownerId, account.id), now);
    });
    await oauthTestHooks.afterRefreshStoreCommit?.();
  } catch (e) {
    const outcome = sealedCt ? await tokenStoredOutcome(db, input.ownerId, s.account.id, sealedCt, issued.accessToken, input.keyring) : 'not_stored';
    if (outcome === 'stored') return getAccountHealth(db, input.ownerId, s.account.id, now);
    if (outcome === 'unknown') {
      // 저장됐을 수도 있어 철회하지 않는다. FIX3-T13(Q14): T2 를 봉인해 정리 대기(refresh_unknown)로 남긴다(계정 잠금 아래, 세대 확인 —
      // 그 뒤 다른 토큰이 저장됐거나 해제 중·해제됨이면 T2 는 현재 토큰일 수 없으므로 cleanup_revoke). 표시가 있는 동안 실행 차단,
      // 다음 확인·갱신·tick 이 공급자에 물어 정리한다. 기록마저 실패하면 감사 + 가능하면 error(refresh_pending_record_failed)로 차단.
      const mark = await markAfterIssuance(db, {
        ownerId: input.ownerId,
        accountId: s.account.id,
        generation: s.generation,
        markStoreFailed: false,
        pending: { kind: 'refresh_unknown', tokens: issued, source: 'refresh' },
        keyring: input.keyring,
        now,
      });
      if (mark.pending !== 'recorded') await auditPendingRecordFailed(db, { ownerId: input.ownerId, accountId: s.account.id, context: 'refresh', result: mark.pending, now });
      await recordAudit(db, {
        ownerId: input.ownerId,
        action: 'oauth.refresh_failed',
        entity: 'channel_account',
        entityId: s.account.id,
        details: { provider: s.provider.id, mock: s.provider.mock, error_code: 'store_outcome_unknown', pending_record: mark.pending, pending_kind: mark.pendingKind, trigger, token_generation: s.generation },
        at: now,
      }).catch(() => undefined);
      throw new CredentialRefreshFailedError('store_outcome_unknown');
    }
    await afterIssuanceFailure('store_failed', { error: e instanceof AppError ? e.code : 'db_error' });
    throw new CredentialRefreshFailedError('store_failed');
  }
  if (stored) return stored;
  // 다른 변경이 먼저 커밋됨 — 받은 새 토큰은 저장하지 않고 공급자에서 철회한다(새로 저장된 세대는 건드리지 않음).
  await afterIssuanceFailure('credential_changed');
  throw new CredentialRefreshFailedError('credential_changed');
}

// ---- FIX3·FIX4-T13: 정리 대기(oauth_pending_tokens) ----

type PendingRecordResult = 'recorded' | 'seal_failed' | 'write_failed' | 'not_requested';

interface IssuanceMark {
  /** 읽었던 세대에서 error(refresh_store_failed)를 기록했는가 */
  storeFailedMarked: boolean;
  pending: PendingRecordResult;
  pendingKind: PendingKind | null;
}

const pendingAad = (ownerId: string, accountId: string): SecretAad => ({ ownerId, channelAccountId: accountId, purpose: 'oauth_pending_token' });

const encodePending = (t: StoredOAuthTokens) => encodeTokens(t);

/** 살아 있는 연결 정보(토큰 있음·해제 아님·해제 중 아님) */
const liveCredential = (cred: OAuthCredentialRow | null): cred is OAuthCredentialRow =>
  !!cred && !cred.revokedAt && cred.status !== 'revoking' && cred.encryptedToken !== null && cred.keyVersion !== null;

/** FIX4-T13(P2 :1293): 정리 시도 사이 간격 — 시도마다(판정 불가 포함) 다음 시도 시각을 미룬다. 1분부터 두 배, 최대 1시간. */
export const PENDING_BACKOFF_BASE_MS = 60_000;
export const PENDING_BACKOFF_MAX_MS = 3600_000;
export const pendingBackoffMs = (attempts: number) => Math.min(PENDING_BACKOFF_MAX_MS, PENDING_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 16));
/** FIX6-T13(P2 :1356): 두 예약 중 늦은 쪽 — 다음 시도 시각을 앞당기지 않는다 */
const laterOf = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

async function auditPendingRecordFailed(db: DbOrTx, input: { ownerId: string; accountId: string; context: string; result: PendingRecordResult; now: Date }): Promise<void> {
  await recordAudit(db, {
    ownerId: input.ownerId,
    action: 'oauth.pending_record_failed',
    entity: 'channel_account',
    entityId: input.accountId,
    details: { context: input.context, error_code: 'refresh_pending_record_failed', result: input.result },
    at: input.now,
  }).catch(() => undefined);
}

/**
 * FIX3-T13 → FIX4-T13(Codex review-FIX3-T13 P1 :908): 발급 뒤 실패를 남긴다(계정 → 연결 정보 잠금, 한 트랜잭션).
 * - markStoreFailed: 저장되지 않았음이 확인된 갱신 — 읽었던 세대(generation)가 아직 현재이고 살아 있을 때만 status='error'
 *   (refresh_store_failed). 동시에 저장된 새 세대(다시 연결)는 그대로 둔다.
 * - pending: P 를 현재 키로 봉인(AAD purpose oauth_pending_token)해 oauth_pending_tokens 에 **새 행**으로 넣는다 — 이미 다른 정리 대기가
 *   있어도 겹쳐 쓰거나 버리지 않는다(FIX3 의 occupied 제거). 연결 정보 행이 없어도(첫 연결) 그대로 넣는다(자리 표시 행 없음).
 *   refresh_unknown 은 행이 살아 있고 세대가 읽은 값이거나 +1(우리 저장이 커밋됐을 수 있음)일 때만 — 그 밖에는 P 가 현재 토큰일 수 없으므로 cleanup_revoke.
 * - 봉인·기록이 실패하면 가능하면 살아 있는 행을 error(refresh_pending_record_failed)로 — 차단(다음 확인이 실제 유효성으로 다시 판정).
 * 던지지 않는다.
 */
async function markAfterIssuance(
  db: Db,
  input: {
    ownerId: string;
    accountId: string;
    generation: number | null;
    markStoreFailed: boolean;
    pending: { kind: 'refresh_unknown' | 'cleanup_revoke'; tokens: StoredOAuthTokens; source: string } | null;
    keyring: KeyringSource;
    now: Date;
  },
): Promise<IssuanceMark> {
  let sealed: SealedSecret | null = null;
  if (input.pending) {
    try {
      sealed = sealSecret(input.keyring(), encodePending(input.pending.tokens), pendingAad(input.ownerId, input.accountId));
    } catch {
      sealed = null;
    }
  }
  const blockLive = async (tx: DbOrTx, cred: OAuthCredentialRow | null) => {
    if (liveCredential(cred)) {
      await tx.update(oauthCredentials).set({ status: 'error', lastErrorCode: 'refresh_pending_record_failed', updatedAt: input.now }).where(eq(oauthCredentials.id, cred.id));
    }
  };
  try {
    return await db.transaction(async (tx): Promise<IssuanceMark> => {
      const { cred } = await lockAccountCredential(tx, input.ownerId, input.accountId);
      let storeFailedMarked = false;
      if (input.markStoreFailed && input.generation !== null && sameLiveGeneration(cred, input.generation)) {
        await tx
          .update(oauthCredentials)
          .set({ status: 'error', lastErrorCode: 'refresh_store_failed', updatedAt: input.now })
          .where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.tokenGeneration, input.generation)));
        storeFailedMarked = true;
      }
      if (!input.pending) return { storeFailedMarked, pending: 'not_requested', pendingKind: null };
      await oauthTestHooks.insidePendingRecord?.();
      if (!sealed) {
        await blockLive(tx, cred);
        return { storeFailedMarked, pending: 'seal_failed', pendingKind: null };
      }
      const couldBeCurrent = liveCredential(cred) && (input.generation === null || cred.tokenGeneration <= input.generation + 1);
      const kind: PendingKind = input.pending.kind === 'refresh_unknown' && couldBeCurrent ? 'refresh_unknown' : 'cleanup_revoke';
      await tx.insert(oauthPendingTokens).values({
        ownerId: input.ownerId,
        channelAccountId: input.accountId,
        kind,
        sealedToken: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        baseGeneration: kind === 'refresh_unknown' ? input.generation : null,
        source: input.pending.source,
        nextAttemptAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      });
      return { storeFailedMarked, pending: 'recorded', pendingKind: kind };
    });
  } catch {
    if (input.pending) {
      // 기록 트랜잭션이 실패 — 가능하면 차단 상태만이라도(별도 작은 트랜잭션)
      await db
        .transaction(async (tx) => {
          const { cred } = await lockAccountCredential(tx, input.ownerId, input.accountId);
          await blockLive(tx, cred);
        })
        .catch(() => undefined);
    }
    return { storeFailedMarked: false, pending: input.pending ? 'write_failed' : 'not_requested', pendingKind: null };
  }
}

export type ReconcileResult = 'none' | 'resolved' | 'still_pending';

/** FIX4-T13(P1 :1017): 되쓰기 전에 다시 확인하는 연결 정보의 정체(행·세대·해제 세대·상태·해제 여부). 하나라도 바뀌면 판정을 버리고 다시 정리한다. */
const credIdentity = (cred: OAuthCredentialRow | null) =>
  cred ? `${cred.id}|${cred.tokenGeneration}|${cred.revocationEpoch}|${cred.status}|${cred.revokedAt ? 'r' : '-'}|${cred.encryptedToken ? 't' : '-'}` : 'none';

/** 한 번의 정리에서 다시 정리(낡은 판정 폐기)를 몇 번까지 하는가 — 넘으면 still_pending(차단 유지, 다음 확인·tick 이 다시) */
const MAX_RECONCILE_PASSES = 3;

type RowPlan =
  | { row: OAuthPendingRow; action: 'stuck'; problem: string }
  | { row: OAuthPendingRow; action: 'moot' }
  | {
      row: OAuthPendingRow;
      action: 'process';
      /** 판정에 쓴 종류(살아 있지 않은 행의 refresh_unknown 은 cleanup_revoke) */
      kind: PendingKind;
      pending: StoredOAuthTokens | null;
      storedIsPending: boolean;
      cleanup: { result: RemoteRevoke; code: string | null } | null;
    };

/**
 * FIX3-T13 → FIX4-T13(Codex review-FIX3-T13 P1 :1037·:1017·:908·P2 :1293): 한 계정의 정리 대기 전부를 처리한다 — check·refresh 가 먼저 부르고,
 * worker tick(refreshExpiringCredentials)이 다음 시도 시각이 지난 계정마다 부른다.
 * 1) 읽기(계정 → 연결 정보 잠금): 행마다 revision·종류·봉인(P), 연결 정보의 정체와 현재 토큰(C).
 * 2) 공급자 호출(트랜잭션 밖): P 철회, 필요하면 C 확인 한 번.
 * 3) 되쓰기(잠금): 연결 정보의 정체와 읽은 행들의 revision·종류가 **모두 그대로일 때만** 판정을 적용 — 하나라도 바뀌었으면(해제·다시 연결·
 *    다른 정리·해제가 남긴 cleanup_revoke 변환 등) 아무것도 쓰지 않고 현재 상태로 다시 정리한다(MAX_RECONCILE_PASSES 번까지).
 *
 * 판정표(연결 정보가 살아 있지 않으면 refresh_unknown 은 cleanup_revoke 로 본다; 해제 진행 중이면 해제가 처리하므로 시도만 기록):
 * | 종류            | 조건                      | 공급자                 | 결과 |
 * |-----------------|---------------------------|------------------------|------|
 * | 모두            | P·C 를 열 수 없음(키)     | 없음                   | 행 유지(시도 기록·다음 시도 미룸) |
 * | refresh_unknown | C == P(저장돼 있었음)     | C 확인                 | C 유효 → 행 삭제·active / 무효 → 행 삭제·error(공급자 코드) / **판단 불가 → verify_current 로 바꿔 유지(차단)** |
 * | refresh_unknown | C != P                    | P 철회 + C 확인         | P 철회 성공: C 유효 → 삭제·active, 무효 → 삭제·error(refresh_store_failed), **판단 불가 → verify_current** |
 * |                 |                           |                        | P 철회 실패·불명: cleanup_revoke 로 바꿔 유지 + C 판단 불가면 **verify_current 행을 따로 추가**(나중에 P 만 정리돼도 C 확인 의무는 남는다) |
 * | cleanup_revoke  | —                         | P 철회                  | 성공 → 삭제(연결 정보 상태 그대로) / 실패·불명 → 유지 |
 * | verify_current  | C 세대 == base_generation | C 확인                  | 유효 → 삭제·active / 무효 → 삭제·error(on_invalid_code ?? 공급자 코드) / 판단 불가 → 유지 |
 * | verify_current  | 세대 바뀜·해제됨           | 없음                   | 삭제(그 세대는 다시 연결이 새로 확인한 토큰 — 해제면 이미 차단) |
 * 상태(active·error) 기록은 읽었던 세대가 그대로이고 살아 있을 때만. C 확인이 일시 오류(provider_error 등)면 상태를 바꾸지 않고 의무를 남긴다.
 * 행이 하나라도 남으면 still_pending(계정 차단 유지). 연결 정보 행은 지우지 않는다(FIX3 자리 표시 행 없음).
 * FIX5-T13(P2 :1077): 기본은 next_attempt_at <= now 인 행만 처리(worker). 기한 전 행은 열지도·바꾸지도 않지만 남아 있으므로 차단은 유지된다.
 * 사용자 확인·수동 갱신은 ignoreBackoff 로 모든 행을 처리한다. 모든 pass 가 낡은 판정으로 끝나면 다룬 행의 다음 시도 시각만 미룬다.
 */
export async function reconcilePendingCredential(
  db: Db,
  input: {
    ownerId: string;
    accountId: string;
    providerFor: ProviderFor;
    keyring: KeyringSource;
    /** 처리 기준 시각 — 기본은 다음 시도 시각(next_attempt_at)이 이 시각 이하인 행만 처리한다 */
    now?: Date;
    /**
     * FIX5-T13(Codex review-FIX4-T13 P2 :1077): true 면 행별 백오프를 무시하고 모든 행을 처리한다 — 사용자가 직접 누른 확인·갱신만.
     * worker(refreshExpiringCredentials)는 넘기지 않으므로 기한이 지난 행만 처리하고, 기한 전 행은 손대지 않되 계정 차단은 유지한다.
     */
    ignoreBackoff?: boolean;
  },
): Promise<ReconcileResult> {
  const now = input.now ?? new Date();
  const ignoreBackoff = input.ignoreBackoff === true;
  const isDue = (row: OAuthPendingRow) => ignoreBackoff || row.nextAttemptAt.getTime() <= now.getTime();
  const account = await ownedAccount(db, input.ownerId, input.accountId);
  /** 마지막 pass 가 다룬(기한이 지난) 행 — 다시 정리가 모두 낡은 판정으로 끝나면 이 행들의 다음 시도 시각을 미룬다 */
  let lastPassRowIds: string[] = [];
  const bump = (row: OAuthPendingRow, lastResult: string) => ({
    revision: row.revision + 1,
    attempts: row.attempts + 1,
    // FIX6-T13(P2 :1356): 다음 시도 시각은 앞당기지 않는다(사용자 확인이 기한 전 행을 처리해도 이미 미룬 예약 이후로만)
    nextAttemptAt: laterOf(row.nextAttemptAt, new Date(now.getTime() + pendingBackoffMs(row.attempts + 1))),
    lastResult,
    updatedAt: now,
  });
  for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass++) {
    // 1) 읽기
    type Snapshot = {
      identity: string;
      live: boolean;
      generation: number | null;
      current: StoredOAuthTokens | null;
      currentProblem: string | null;
      globalProblem: string | null;
      rows: Array<{ row: OAuthPendingRow; pending: StoredOAuthTokens | null; problem: string | null }>;
    };
    const snap = await db.transaction(async (tx): Promise<Snapshot | 'none' | 'not_due'> => {
      const { cred } = await lockAccountCredential(tx, input.ownerId, account.id);
      const allRows = await tx
        .select()
        .from(oauthPendingTokens)
        .where(and(eq(oauthPendingTokens.ownerId, input.ownerId), eq(oauthPendingTokens.channelAccountId, account.id)))
        .orderBy(asc(oauthPendingTokens.createdAt), asc(oauthPendingTokens.id))
        .for('update');
      if (!allRows.length) return 'none';
      // FIX5-T13(P2 :1077): 기한 전 행은 읽지도(열지도) 처리하지도 않는다 — 남아 있으므로 계정은 계속 차단된다
      const rows = allRows.filter(isDue);
      if (!rows.length) return 'not_due';
      const live = liveCredential(cred);
      let ring: SecretKeyring | null = null;
      let globalProblem: string | null = cred?.status === 'revoking' ? 'revoking' : null;
      try {
        ring = input.keyring();
      } catch {
        globalProblem ??= 'no_key';
      }
      const out: Snapshot = { identity: credIdentity(cred), live, generation: cred?.tokenGeneration ?? null, current: null, currentProblem: null, globalProblem, rows: [] };
      for (const row of rows) {
        let pending: StoredOAuthTokens | null = null;
        let problem: string | null = null;
        if (ring && row.sealedToken && row.keyVersion !== null) {
          try {
            pending = decodeTokens(openSecret(ring, row.sealedToken, row.keyVersion, pendingAad(input.ownerId, account.id)));
          } catch (e) {
            problem = e instanceof SecretDecryptError ? `pending_${e.problem}` : 'pending_unreadable';
          }
        }
        out.rows.push({ row, pending, problem });
      }
      if (live && ring) {
        try {
          out.current = decodeTokens(openSecret(ring, cred.encryptedToken!, cred.keyVersion!, tokenAad(input.ownerId, account.id)));
        } catch {
          out.currentProblem = 'current_unreadable';
        }
      }
      return out;
    });
    if (snap === 'none') return pass === 0 ? 'none' : 'resolved';
    if (snap === 'not_due') return 'still_pending';
    lastPassRowIds = snap.rows.map((r) => r.row.id);

    // 2) 판정·공급자 호출
    let provider: OAuthProvider | null = null;
    let globalProblem = snap.globalProblem;
    if (!globalProblem) {
      try {
        provider = input.providerFor(account);
      } catch {
        globalProblem = 'provider_unavailable';
      }
    }
    const plans: RowPlan[] = [];
    let needVerify = false;
    let invalidCode: string | null = null;
    for (const { row, pending, problem } of snap.rows) {
      if (globalProblem || problem) {
        plans.push({ row, action: 'stuck', problem: globalProblem ?? problem! });
        continue;
      }
      if (row.kind === 'verify_current') {
        if (!snap.live || snap.generation !== row.baseGeneration) {
          plans.push({ row, action: 'moot' });
          continue;
        }
        if (!snap.current) {
          plans.push({ row, action: 'stuck', problem: snap.currentProblem ?? 'current_unreadable' });
          continue;
        }
        needVerify = true;
        if (row.onInvalidCode === 'refresh_store_failed') invalidCode = 'refresh_store_failed';
        else if (row.onInvalidCode && !invalidCode) invalidCode = row.onInvalidCode;
        plans.push({ row, action: 'process', kind: 'verify_current', pending: null, storedIsPending: false, cleanup: null });
        continue;
      }
      const kind: PendingKind = row.kind === 'refresh_unknown' && snap.live ? 'refresh_unknown' : 'cleanup_revoke';
      if (kind === 'refresh_unknown' && !snap.current) {
        plans.push({ row, action: 'stuck', problem: snap.currentProblem ?? 'current_unreadable' });
        continue;
      }
      const storedIsPending = kind === 'refresh_unknown' && snap.current!.accessToken === pending!.accessToken;
      if (kind === 'refresh_unknown') {
        needVerify = true;
        if (!storedIsPending) invalidCode = 'refresh_store_failed';
      }
      plans.push({ row, action: 'process', kind, pending, storedIsPending, cleanup: null });
    }
    for (const p of plans) {
      if (p.action === 'process' && p.pending && !p.storedIsPending) p.cleanup = await revokeAtProvider(provider!, p.pending, now);
    }
    // C 유효성(한 번): true 유효, false 무효, null 판단 불가(일시 오류)
    let currentValid: boolean | null = null;
    let currentError: string | null = null;
    if (needVerify && provider && snap.current) {
      try {
        const info = await provider.accountInfo({ accessToken: snap.current.accessToken, now });
        currentValid = info.externalAccountId === account.externalAccountId;
        if (!currentValid) currentError = 'account_mismatch';
      } catch (e) {
        const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
        if (providerFailureStatus(code) === 'error') {
          currentValid = false;
          currentError = code;
        } else {
          currentError = code;
        }
      }
    }
    await oauthTestHooks.afterReconcileProvider?.();

    // 3) 되쓰기 — 정체·revision 이 모두 그대로일 때만
    type Outcome = { kind: PendingKind; result: 'resolved' | 'kept' | 'verify_pending'; plan: RowPlan };
    const written = await db.transaction(async (tx): Promise<{ stale: true } | { stale: false; outcomes: Outcome[]; status: string | null; remaining: number }> => {
      const { cred } = await lockAccountCredential(tx, input.ownerId, account.id);
      const nowRows = await tx
        .select()
        .from(oauthPendingTokens)
        .where(and(eq(oauthPendingTokens.ownerId, input.ownerId), eq(oauthPendingTokens.channelAccountId, account.id)))
        .for('update');
      const byId = new Map(nowRows.map((r) => [r.id, r]));
      if (credIdentity(cred) !== snap.identity) return { stale: true };
      for (const p of plans) {
        const r = byId.get(p.row.id);
        if (!r || r.revision !== p.row.revision || r.kind !== p.row.kind) return { stale: true };
      }
      let status: string | null = null;
      if (currentValid !== null && snap.generation !== null && sameLiveGeneration(cred, snap.generation)) {
        status = currentValid ? 'active' : 'error';
        await tx
          .update(oauthCredentials)
          .set({ status, lastErrorCode: currentValid ? null : (invalidCode ?? currentError), lastCheckedAt: now, updatedAt: now })
          .where(and(eq(oauthCredentials.id, cred!.id), eq(oauthCredentials.tokenGeneration, snap.generation)));
      }
      const outcomes: Outcome[] = [];
      const del = (id: string) => tx.delete(oauthPendingTokens).where(and(eq(oauthPendingTokens.id, id), eq(oauthPendingTokens.revision, byId.get(id)!.revision)));
      const upd = (id: string, set: Partial<typeof oauthPendingTokens.$inferInsert>) =>
        tx.update(oauthPendingTokens).set(set).where(and(eq(oauthPendingTokens.id, id), eq(oauthPendingTokens.revision, byId.get(id)!.revision)));
      for (const p of plans) {
        if (p.action === 'stuck') {
          await upd(p.row.id, bump(p.row, p.problem));
          outcomes.push({ kind: p.row.kind as PendingKind, result: 'kept', plan: p });
          continue;
        }
        if (p.action === 'moot') {
          await del(p.row.id);
          outcomes.push({ kind: 'verify_current', result: 'resolved', plan: p });
          continue;
        }
        const cDone = currentValid !== null;
        if (p.kind === 'verify_current') {
          if (cDone) {
            await del(p.row.id);
            outcomes.push({ kind: p.kind, result: 'resolved', plan: p });
          } else {
            await upd(p.row.id, bump(p.row, currentError ?? 'current_unverified'));
            outcomes.push({ kind: p.kind, result: 'kept', plan: p });
          }
          continue;
        }
        const pDone = p.storedIsPending || (p.cleanup !== null && !cleanupFailed(p.cleanup.result));
        if (p.kind === 'cleanup_revoke') {
          if (pDone) {
            await del(p.row.id);
            outcomes.push({ kind: p.kind, result: 'resolved', plan: p });
          } else {
            await upd(p.row.id, { ...bump(p.row, p.cleanup?.code ?? p.cleanup?.result ?? 'revoke_failed'), kind: 'cleanup_revoke', baseGeneration: null, onInvalidCode: null });
            outcomes.push({ kind: p.kind, result: 'kept', plan: p });
          }
          continue;
        }
        // refresh_unknown(살아 있는 행): P 정리와 C 확인을 따로 본다
        if (pDone && cDone) {
          await del(p.row.id);
          outcomes.push({ kind: p.kind, result: 'resolved', plan: p });
        } else if (pDone) {
          // P 는 정리됨(저장돼 있었거나 철회됨) — C 확인 의무만 남긴다(봉인 삭제)
          await upd(p.row.id, {
            ...bump(p.row, currentError ?? 'current_unverified'),
            kind: 'verify_current',
            sealedToken: null,
            keyVersion: null,
            baseGeneration: snap.generation,
            onInvalidCode: p.storedIsPending ? null : 'refresh_store_failed',
          });
          outcomes.push({ kind: p.kind, result: 'verify_pending', plan: p });
        } else {
          // P 는 현재 토큰이 아님이 확인됨(C != P) — 다시 철회해야 하는 cleanup_revoke 로 유지
          await upd(p.row.id, { ...bump(p.row, p.cleanup?.code ?? p.cleanup?.result ?? 'revoke_failed'), kind: 'cleanup_revoke', baseGeneration: null, onInvalidCode: null });
          if (!cDone) {
            // C 확인 의무는 별도 행으로 — 나중에 P 철회만 성공해도 C 가 확인될 때까지 차단(Codex P1 :1037 의 cleanup_revoke 경로)
            await tx.insert(oauthPendingTokens).values({
              ownerId: input.ownerId,
              channelAccountId: account.id,
              kind: 'verify_current',
              baseGeneration: snap.generation,
              onInvalidCode: 'refresh_store_failed',
              source: 'reconcile',
              attempts: 1,
              nextAttemptAt: new Date(now.getTime() + pendingBackoffMs(1)),
              lastResult: currentError ?? 'current_unverified',
              createdAt: now,
              updatedAt: now,
            });
          }
          outcomes.push({ kind: p.kind, result: cDone ? 'kept' : 'verify_pending', plan: p });
        }
      }
      const remaining = (
        await tx
          .select({ id: oauthPendingTokens.id })
          .from(oauthPendingTokens)
          .where(and(eq(oauthPendingTokens.ownerId, input.ownerId), eq(oauthPendingTokens.channelAccountId, account.id)))
      ).length;
      return { stale: false, outcomes, status, remaining };
    });
    if (written.stale) continue;
    for (const o of written.outcomes) {
      const p = o.plan;
      const cleanup = p.action === 'process' ? p.cleanup : null;
      if (cleanup && cleanupFailed(cleanup.result)) {
        await auditCleanupFailure(db, { ownerId: input.ownerId, accountId: account.id, context: `reconcile_${o.kind}`, result: cleanup.result, code: cleanup.code, pendingRecord: 'kept', now });
      }
      await recordAudit(db, {
        ownerId: input.ownerId,
        action: 'oauth.pending_reconciled',
        entity: 'channel_account',
        entityId: account.id,
        details: {
          kind: o.kind,
          result: o.result,
          stored_was_pending: p.action === 'process' ? p.storedIsPending : false,
          issued_token_revoke: cleanup?.result ?? 'not_needed',
          issued_token_revoke_error: cleanup?.code ?? null,
          current_token_valid:
            p.action !== 'process' || p.kind === 'cleanup_revoke' ? 'not_checked' : currentValid === null ? 'unknown' : currentValid ? 'yes' : 'no',
          current_check_error: p.action === 'process' && p.kind !== 'cleanup_revoke' ? currentError : null,
          problem: p.action === 'stuck' ? p.problem : null,
          status: written.status,
          remaining: written.remaining,
          pass: pass + 1,
        },
        at: now,
      }).catch(() => undefined);
    }
    return written.remaining > 0 ? 'still_pending' : 'resolved';
  }
  // FIX5-T13(Codex review-FIX4-T13 놓친 케이스): 모든 pass 가 낡은 판정으로 끝남 — 아무 판정도 쓰지 않았지만 시도는 했으므로 마지막 pass 가 다룬 행의
  // 다음 시도 시각을 미룬다(같은 계정이 worker 의 차례를 계속 차지하지 않게). 판정에 쓰는 값(종류·봉인·revision)은 바꾸지 않는다 — 동시에 진행 중인
  // 해제·정리의 revision 비교를 깨지 않는다. 이 기록이 실패해도 차단은 그대로(행이 남아 있음).
  // FIX6-T13(Codex review-FIX5-T13 P2 :1356): 그 사이 다른 호출이 이 행의 예약을 이미 이 계산보다 늦게(또는 같게) 미뤘으면 손대지 않는다 — 다음 시도
  // 시각·시도 수·마지막 결과를 오래된 기준 시각으로 되돌리지 않는다. 미룰 때도 조건부 UPDATE(next_attempt_at < 계산값)로 기존 값보다 앞당기지 않는다.
  if (lastPassRowIds.length) {
    await oauthTestHooks.beforeStaleBump?.();
    await db
      .transaction(async (tx) => {
        await lockAccountCredential(tx, input.ownerId, account.id);
        const rows = await tx
          .select()
          .from(oauthPendingTokens)
          .where(and(eq(oauthPendingTokens.ownerId, input.ownerId), eq(oauthPendingTokens.channelAccountId, account.id), inArray(oauthPendingTokens.id, lastPassRowIds)))
          .for('update');
        for (const r of rows) {
          const next = new Date(now.getTime() + pendingBackoffMs(r.attempts + 1));
          if (r.nextAttemptAt.getTime() >= next.getTime()) continue;
          await tx
            .update(oauthPendingTokens)
            .set({ attempts: r.attempts + 1, nextAttemptAt: next, lastResult: 'reconcile_stale', updatedAt: now })
            .where(and(eq(oauthPendingTokens.id, r.id), lt(oauthPendingTokens.nextAttemptAt, next)));
        }
      })
      .catch(() => undefined);
  }
  return 'still_pending';
}

/**
 * 연결 확인: 공급자에 계정 정보를 묻고(트랜잭션 밖) 잠금 아래에서 세대가 그대로일 때만 결과를 기록한다(Codex P1 #2).
 * 세대가 바뀌었으면 옛 토큰의 결과는 버리고 현재 상태를 돌려준다. 다른 계정이면 error(account_mismatch).
 */
export async function checkCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date },
): Promise<AccountHealthView> {
  const now = input.now ?? new Date();
  // FIX3-T13: 정리 대기 표시가 있으면 먼저 정리하고(판정표는 reconcilePendingCredential) 그 결과를 돌려준다 — 정리되지 않으면(철회 실패·판정 불가)
  // 차단 상태 그대로. 이번 확인은 정리가 한 공급자 확인으로 갈음한다(다시 확인하면 일반 확인).
  if ((await reconcilePendingCredential(db, { ...input, now, ignoreBackoff: true })) !== 'none') return getAccountHealth(db, input.ownerId, input.accountId, now);
  const s = await readForUse(db, input.ownerId, input.accountId, input.providerFor, input.keyring, now);
  let status: 'active' | 'error' = 'active';
  let errorCode: string | null = null;
  await oauthTestHooks.beforeProviderCheck?.();
  try {
    const info = await s.provider.accountInfo({ accessToken: s.tokens.accessToken, now });
    if (info.externalAccountId !== s.account.externalAccountId) {
      status = 'error';
      errorCode = 'account_mismatch';
    }
  } catch (e) {
    errorCode = e instanceof OAuthProviderError ? e.code : 'provider_error';
    status = providerFailureStatus(errorCode);
  }
  return db.transaction(async (tx) => {
    const { account, cred } = await lockAccountCredential(tx, input.ownerId, s.account.id);
    const current = sameLiveGeneration(cred, s.generation);
    let row = cred;
    if (current) {
      const updated = await tx
        .update(oauthCredentials)
        .set({ status, lastErrorCode: errorCode, lastCheckedAt: now, updatedAt: now })
        .where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.tokenGeneration, s.generation)))
        .returning();
      row = updated[0] ?? cred;
    }
    await recordAudit(tx, {
      ownerId: input.ownerId,
      action: 'oauth.checked',
      entity: 'channel_account',
      entityId: account.id,
      details: { provider: s.provider.id, mock: s.provider.mock, result: current ? (errorCode ?? 'ok') : 'discarded_stale', token_generation: s.generation },
      at: now,
    });
    return accountHealthView(account, row, await pendingInfoOf(tx, input.ownerId, account.id), now);
  });
}

/**
 * 연결 해제 결과(FIX2-T13, Codex review-FIX-T13 P1 :737):
 * - revoked: 이 요청이 자기 해제 작업을 마무리했다(암호문 삭제·revoked_at).
 * - already_revoked: 시작할 때 이미 해제돼 있었다(아무것도 하지 않음).
 * - completed_by_other: 같은 해제 작업에 합류한 다른 요청이 먼저 마무리했다(이 요청은 아무것도 지우지 않음).
 * - superseded: 이 요청의 해제 작업은 끝났고 그 뒤 명시적으로 다시 연결(또는 새 해제 작업)됐다 — 새 연결을 건드리지 않는다.
 * - incomplete: 자기 작업이 아직 현재인데 토큰 세대가 바뀌어(정상 경로로는 생기지 않음 — 해제 중에는 갱신·다시 연결이 거부됨) 지우지 않았다.
 *   연결 정보는 revoking 그대로(실행 차단), 다시 해제하면 같은 작업에 합류해 마무리한다.
 */
export type RevokeOutcome = 'revoked' | 'already_revoked' | 'completed_by_other' | 'superseded' | 'incomplete';

export interface RevokeResult {
  health: AccountHealthView;
  outcome: RevokeOutcome;
  remoteRevoke: RemoteRevoke | 'skipped_no_key' | 'skipped_unreadable' | 'skipped_unsupported' | 'already_revoked' | 'incomplete' | 'superseded';
  revokedApprovals: number;
  /**
   * FIX6-T13: outcome 'incomplete' 의 이유(코드 값만) — 현재 토큰을 그대로 둔 채 revoking(차단)으로 남은 경우.
   * revoke_current_no_key(키 없음) · revoke_current_unreadable(키 버전 모름·인증 실패) · revoke_provider_unavailable(공급자 없음) · revoke_current_seal_failed(정리 대기 봉인 실패).
   */
  incompleteCode: RevokeIncompleteCode | null;
}

export type RevokeIncompleteCode = 'revoke_current_no_key' | 'revoke_current_unreadable' | 'revoke_provider_unavailable' | 'revoke_current_seal_failed';
/** FIX6-T13: 미완료 해제를 worker 가 다시 잇기 전 기다리는 시간(진행 중인 해제와 겹치지 않게). FIX7-T13: 해제 1단계가 revoke_resume_at 을 이만큼 뒤로 정한다. */
export const REVOKE_RESUME_AFTER_MS = 60_000;

/**
 * 연결 해제(Codex P1 #3, FIX2 P1) — 해제 작업(revoke_op_id) 단위:
 * 1) 잠금 아래: 이미 해제됐으면 끝. 진행 중인 해제 작업(status='revoking' + revoke_op_id)이 있으면 **그 작업에 합류**(해제 세대 그대로),
 *    없으면 새 작업 ID 를 만들고 해제 세대(revocation_epoch) +1 · status='revoking'. 이 계정의 미사용 연결 요청을 사용 처리, 활성 승인 철회
 *    (account_changed, D25-1), 토큰 복호화.
 * 2) 트랜잭션 밖: 공급자 철회(키가 없거나 읽을 수 없거나 공급자 오류면 그 결과를 그대로 보고).
 * 3) 잠금 아래: 자기 작업이 아직 현재이고 세대가 그대로면 암호문·키 버전 삭제 + revoked_at(작업 ID 는 남김). 그 밖의 판정은 RevokeOutcome.
 * credential_state 는 linked 그대로 — 다시 연결하기 전까지 실행 차단. 다시 연결은 revoke_op_id 를 지우지만 해제 세대는 그대로 둔다.
 * FIX5-T13(Codex review-FIX4-T13 P1 :1524): 3) 에서 현재 토큰의 철회가 확인되지 않았으면(failed·unknown) 같은 트랜잭션에서 그 토큰을 봉인한
 * cleanup_revoke 행을 넣은 뒤에만 암호문을 지운다(같은 토큰을 진 정리 대기 행이 cleanup_revoke 로 남으면 그 행이 대신한다). 봉인할 수 없으면 암호문을
 * 지우지 않고 revoking(차단) 그대로 — outcome incomplete, 다시 해제하면 같은 작업에 합류해 다시 철회한다.
 */
export async function revokeCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date },
): Promise<RevokeResult> {
  const r = await revokeCredentialOp(db, input, null);
  // 사용자 요청(expect 없음)은 판정 전 건너뛰기가 없다
  if (r === 'skipped_changed' || r === 'skipped_busy') throw new CredentialNotFoundError();
  return r;
}

/**
 * FIX7-T13(Codex review-FIX6-T13 P1 :1791): worker 가 훑어 본 미완료 해제 하나를 **그 작업 그대로** 잇는다. 첫 잠금 트랜잭션 안에서 연결 정보가
 * 아직 revoking 이고 해제 작업 ID·토큰 세대·해제 세대가 훑을 때와 같은지 확인하고, 다르면(그 사이 해제가 끝났거나 다시 연결됐거나 새 해제가 시작됨)
 * 공급자 호출·로컬 변경 없이 'skipped_changed' — 새 해제 작업을 만들지 않는다.
 * FIX8-T13(Codex review-FIX7-T13 P2 :1508): 같은 작업이어도 훑은 뒤 재개 예약(revoke_resume_at·시도 수)이 바뀌었거나 지금 기한이 지나지 않았으면
 * (다른 worker 가 이미 재개를 잡았거나 사용자 해제가 합류해 진행 중) 공급자 호출·로컬 변경 없이 'skipped_busy'. 통과하면 같은 잠금 트랜잭션에서
 * revoke_resume_at = now + max(60초, backoff) 로 재개를 잡은 뒤에야 공급자를 부른다 — 두 번째 재개는 바뀐 예약을 보고 건너뛴다.
 */
export interface RevokeResumeExpectation {
  opId: string;
  generation: number;
  epoch: number;
  /** FIX8-T13: 훑을 때 본 revoke_resume_at(0035 이전 행은 null) */
  resumeAt: Date | null;
  /** FIX8-T13: 훑을 때 본 revoke_resume_attempts */
  attempts: number;
}

async function revokeCredentialOp(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date },
  expect: RevokeResumeExpectation | null,
): Promise<RevokeResult | 'skipped_changed' | 'skipped_busy'> {
  const now = input.now ?? new Date();
  const account = await ownedAccount(db, input.ownerId, input.accountId);
  let provider: OAuthProvider | null = null;
  try {
    provider = input.providerFor(account);
  } catch {
    provider = null;
  }
  const marked = await db.transaction(async (tx) => {
    const { account: acc, cred } = await lockAccountCredential(tx, input.ownerId, account.id);
    if (expect) {
      // FIX7-T13: worker 재개 — 훑을 때 본 그 해제 작업이 아직 그대로일 때만(무엇도 쓰기 전에 판정)
      const same =
        !!cred &&
        !cred.revokedAt &&
        cred.status === 'revoking' &&
        cred.revokeOpId === expect.opId &&
        cred.tokenGeneration === expect.generation &&
        cred.revocationEpoch === expect.epoch;
      if (!same) return { changed: true as const };
      // FIX8-T13(Codex review-FIX7-T13 P2 :1508): 같은 작업의 재개 예약도 훑을 때 그대로이고 지금 기한이 지났을 때만 잇는다. 아래 합류 분기가 같은
      // 트랜잭션에서 revoke_resume_at 을 미래로 옮겨(잡기) 커밋하므로, 함께 훑은 다른 worker 는 바뀐 예약을 보고 여기서 건너뛴다.
      const due = cred.revokeResumeAt ?? new Date(cred.updatedAt.getTime() + REVOKE_RESUME_AFTER_MS);
      const leaseSame =
        (cred.revokeResumeAt?.getTime() ?? null) === (expect.resumeAt?.getTime() ?? null) && cred.revokeResumeAttempts === expect.attempts;
      if (!leaseSame || due.getTime() > now.getTime()) return { busy: true as const };
    }
    if (!cred) throw new CredentialNotFoundError();
    if (cred.revokedAt) return { done: accountHealthView(acc, cred, await pendingInfoOf(tx, input.ownerId, acc.id), now) };
    let opId = cred.revokeOpId;
    let epoch = cred.revocationEpoch;
    const joined = cred.status === 'revoking' && opId !== null;
    // FIX7-T13(Codex review-FIX6-T13 P2 :1779·Q2): 진행 중 표시 — worker 는 revoke_resume_at 이 지난 revoking 행만 잇는다. 이 해제가 끝나기 전에
    // 프로세스가 멈추거나 마무리가 되돌려져도(1단계는 커밋됨) 이 시각 뒤 worker 가 같은 작업으로 잇는다. 합류할 때마다 시도 수 +1(지수 backoff).
    if (!joined) {
      opId = randomUUID();
      epoch = cred.revocationEpoch + 1;
      await tx
        .update(oauthCredentials)
        .set({
          status: 'revoking',
          revokeOpId: opId,
          revocationEpoch: epoch,
          revokeResumeAt: new Date(now.getTime() + REVOKE_RESUME_AFTER_MS),
          revokeResumeAttempts: 1,
          updatedAt: now,
        })
        .where(eq(oauthCredentials.id, cred.id));
    } else {
      const attempts = cred.revokeResumeAttempts + 1;
      const next = new Date(now.getTime() + Math.max(REVOKE_RESUME_AFTER_MS, pendingBackoffMs(attempts)));
      await tx
        .update(oauthCredentials)
        .set({ revokeResumeAt: cred.revokeResumeAt ? laterOf(cred.revokeResumeAt, next) : next, revokeResumeAttempts: attempts })
        .where(eq(oauthCredentials.id, cred.id));
    }
    await tx
      .update(oauthStates)
      .set({ usedAt: now })
      .where(and(eq(oauthStates.ownerId, input.ownerId), eq(oauthStates.channelAccountId, acc.id), isNull(oauthStates.usedAt)));
    const revoked = await invalidateApprovalsForAccount(tx, input.ownerId, acc.id, now);
    let tokens: StoredOAuthTokens | null = null;
    let skip: RevokeResult['remoteRevoke'] | null = provider ? null : 'skipped_unsupported';
    if (provider) {
      try {
        const ring = input.keyring();
        tokens = decodeTokens(openSecret(ring, cred.encryptedToken!, cred.keyVersion!, tokenAad(input.ownerId, acc.id)));
      } catch (e) {
        skip = e instanceof SecretDecryptError ? 'skipped_unreadable' : 'skipped_no_key';
      }
    }
    // FIX3-T13 → FIX4-T13: 정리 대기 중인 토큰(P)도 함께 철회한다 — 행마다(봉인이 있는 행만). 마무리(3단계)에서 이 단계가 본 행을 같은 revision 일 때만
    // 바꾼다: 철회 확인 → 삭제, 실패·불명 → cleanup_revoke(다음 정리가 다시 철회). 열 수 없는 행은 그대로 둔다(정리가 키 문제로 기록).
    const pendingRows = await tx
      .select()
      .from(oauthPendingTokens)
      .where(and(eq(oauthPendingTokens.ownerId, input.ownerId), eq(oauthPendingTokens.channelAccountId, acc.id)))
      .orderBy(asc(oauthPendingTokens.createdAt), asc(oauthPendingTokens.id))
      .for('update');
    const pendings: Array<{ id: string; revision: number; kind: string; tokens: StoredOAuthTokens | null }> = [];
    for (const p of pendingRows) {
      let t: StoredOAuthTokens | null = null;
      if (provider && p.sealedToken && p.keyVersion !== null) {
        try {
          t = decodeTokens(openSecret(input.keyring(), p.sealedToken, p.keyVersion, pendingAad(input.ownerId, acc.id)));
        } catch {
          t = null;
        }
      }
      pendings.push({ id: p.id, revision: p.revision, kind: p.kind, tokens: t });
    }
    const hadCiphertext = cred.encryptedToken !== null && cred.keyVersion !== null;
    return { generation: cred.tokenGeneration, tokens, hadCiphertext, pendings, skip, revokedApprovals: revoked.length, credId: cred.id, opId: opId!, epoch, joined };
  });
  if ('changed' in marked) return 'skipped_changed';
  if ('busy' in marked) return 'skipped_busy';
  if ('done' in marked && marked.done) return { health: marked.done, outcome: 'already_revoked', remoteRevoke: 'already_revoked', revokedApprovals: 0, incompleteCode: null };
  if ('done' in marked) throw new CredentialNotFoundError();
  await oauthTestHooks.afterRevokeMarked?.();
  let remote: RevokeResult['remoteRevoke'] = marked.skip ?? 'ok';
  let remoteCode: string | null = null;
  const pendingResults = new Map<string, { result: RemoteRevoke; code: string | null }>();
  for (const p of marked.pendings) {
    if (provider && p.tokens) pendingResults.set(p.id, await revokeAtProvider(provider, p.tokens, now));
  }
  // 감사용 요약: 없음 · 모두 철회 확인 · 하나라도 실패/불명 · 열 수 없는 행 있음
  const withToken = marked.pendings.filter((p) => p.kind !== 'verify_current');
  const results = [...pendingResults.values()];
  const failedPending = results.filter((r) => cleanupFailed(r.result));
  const pendingRevoke: RemoteRevoke | 'unreadable' | 'none' = !withToken.length
    ? 'none'
    : failedPending.length
      ? failedPending.some((r) => r.result === 'failed')
        ? 'failed'
        : 'unknown'
      : results.length < withToken.length
        ? 'unreadable'
        : 'ok';
  const pendingRevokeCode = failedPending[0]?.code ?? null;
  if (provider && marked.tokens) {
    const r = await revokeAtProvider(provider, marked.tokens, now);
    remote = r.result;
    remoteCode = r.code;
  }
  // FIX5-T13(Codex review-FIX4-T13 P1 :1524): 현재 토큰(C)의 철회가 확인되지 않았으면(failed·unknown) 암호문을 지우기 전에 C 를 정리 대기(cleanup_revoke)로
  // 봉인해 남긴다 — verify_current 삭제나 암호문 삭제로 철회 의무가 끝나지 않게. 같은 토큰을 가진 정리 대기 행의 철회가 확인됐으면(C == P) C 도 철회된 것.
  // 봉인이 실패하면 암호문을 지우지 않고 revoking(차단)으로 남긴다(outcome incomplete — 다시 해제하면 같은 작업에 합류해 다시 철회).
  // FIX6-T13(Codex review-FIX5-T13 P1 :1541): 키가 없거나 열 수 없거나 공급자가 없어 C 를 읽지·철회하지 못한 경우(skipped_*)는 철회 확인이 아니다 —
  // 암호문(봉인 그대로)·키 버전을 지우지 않고 revoking(차단)으로 남긴다(outcome incomplete, last_error_code = 이유). 이 암호문이 곧 철회 의무다:
  // 키가 다시 설정되면(키 교체가 다시 봉인해도 같은 토큰) worker 가 같은 해제 작업에 합류해 철회하고 마무리한다(refreshExpiringCredentials).
  const currentUnreadable = marked.hadCiphertext && !marked.tokens;
  const currentRevokeConfirmed =
    !marked.tokens ||
    !cleanupFailed(remote as RemoteRevoke) ||
    marked.pendings.some((p) => p.tokens?.accessToken === marked.tokens!.accessToken && pendingResults.has(p.id) && !cleanupFailed(pendingResults.get(p.id)!.result));
  let sealedCurrent: SealedSecret | null = null;
  if (!currentRevokeConfirmed) {
    try {
      await oauthTestHooks.beforeRevokeCurrentSeal?.();
      sealedCurrent = sealSecret(input.keyring(), encodePending(marked.tokens!), pendingAad(input.ownerId, account.id));
    } catch {
      sealedCurrent = null;
    }
  }
  return db.transaction(async (tx) => {
    const { account: acc, cred } = await lockAccountCredential(tx, input.ownerId, account.id);
    let row = cred;
    let outcome: RevokeOutcome;
    const ownOpCurrent = !!cred && cred.id === marked.credId && cred.revokeOpId === marked.opId;
    const canFinish = ownOpCurrent && !cred!.revokedAt && cred!.status === 'revoking' && cred!.tokenGeneration === marked.generation;
    // FIX4-T13: 1단계에서 본 정리 대기 행만, 같은 revision 일 때만 바꾼다(그 사이 다른 정리가 바꿨으면 손대지 않음).
    // 철회 확인 → 삭제. 실패·불명 → cleanup_revoke(해제가 시작됐으므로 P 는 더는 현재 토큰으로 남지 않는다 — 다시 철회해야 함).
    // FIX5-T13: 실패·불명으로 cleanup_revoke 로 남긴 행 중 C 와 같은 토큰이 있으면 C 의 철회 의무는 그 행이 이미 진다(중복 행을 만들지 않음).
    let currentCoveredByPending = false;
    for (const p of marked.pendings) {
      if (p.kind === 'verify_current') continue;
      const same = and(eq(oauthPendingTokens.id, p.id), eq(oauthPendingTokens.revision, p.revision));
      const r = pendingResults.get(p.id);
      if (r && !cleanupFailed(r.result)) {
        await tx.delete(oauthPendingTokens).where(same);
      } else if (r) {
        const kept = await tx
          .update(oauthPendingTokens)
          .set({ kind: 'cleanup_revoke', baseGeneration: null, onInvalidCode: null, revision: p.revision + 1, lastResult: r.code ?? r.result, updatedAt: now })
          .where(same)
          .returning({ id: oauthPendingTokens.id });
        if (kept.length && marked.tokens && p.tokens?.accessToken === marked.tokens.accessToken) currentCoveredByPending = true;
      }
    }
    let currentRecord: 'not_needed' | 'covered_by_pending' | 'recorded' | 'seal_failed' | 'unreadable_kept' = 'not_needed';
    let incompleteCode: RevokeIncompleteCode | null = null;
    if (ownOpCurrent && cred!.revokedAt) {
      outcome = 'completed_by_other';
    } else if (canFinish && currentUnreadable) {
      // FIX6-T13: C 를 읽지 못함 — 철회도 봉인도 못 했으므로 암호문을 그대로 남기고 revoking(차단). 이유는 last_error_code 에(worker 가 이 표시로 다시 잇는다).
      currentRecord = 'unreadable_kept';
      incompleteCode = marked.skip === 'skipped_no_key' ? 'revoke_current_no_key' : marked.skip === 'skipped_unreadable' ? 'revoke_current_unreadable' : 'revoke_provider_unavailable';
      outcome = 'incomplete';
    } else if (canFinish && !currentRevokeConfirmed && !currentCoveredByPending && !sealedCurrent) {
      // C 를 기록할 수 없음 — 암호문을 남기고 revoking(차단) 그대로
      currentRecord = 'seal_failed';
      incompleteCode = 'revoke_current_seal_failed';
      outcome = 'incomplete';
    } else if (canFinish) {
      if (!currentRevokeConfirmed) {
        if (currentCoveredByPending) {
          currentRecord = 'covered_by_pending';
        } else {
          // 암호문 삭제와 같은 트랜잭션 — 이 INSERT 가 실패하면 삭제도 되돌려진다(암호문·revoking 유지)
          await tx.insert(oauthPendingTokens).values({
            ownerId: input.ownerId,
            channelAccountId: acc.id,
            kind: 'cleanup_revoke',
            sealedToken: sealedCurrent!.ciphertext,
            keyVersion: sealedCurrent!.keyVersion,
            source: 'revoke_current',
            lastResult: remoteCode ?? remote,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          });
          currentRecord = 'recorded';
        }
      }
      const updated = await tx
        .update(oauthCredentials)
        .set({
          encryptedToken: null,
          keyVersion: null,
          revokedAt: now,
          status: 'revoked',
          lastErrorCode: remoteCode,
          revokeResumeAt: null,
          revokeResumeAttempts: 0,
          updatedAt: now,
        })
        .where(and(eq(oauthCredentials.id, cred!.id), eq(oauthCredentials.tokenGeneration, marked.generation), eq(oauthCredentials.revokeOpId, marked.opId)))
        .returning();
      row = updated[0] ?? cred;
      outcome = 'revoked';
    } else if (ownOpCurrent) {
      outcome = 'incomplete';
      remote = 'incomplete';
    } else {
      outcome = 'superseded';
      remote = 'superseded';
    }
    if (incompleteCode) {
      // 암호문·키 버전·revoking·해제 작업 ID 는 그대로 — 이유만 남긴다(같은 작업일 때만)
      await tx
        .update(oauthCredentials)
        .set({ lastErrorCode: incompleteCode, updatedAt: now })
        .where(and(eq(oauthCredentials.id, cred!.id), eq(oauthCredentials.tokenGeneration, marked.generation), eq(oauthCredentials.revokeOpId, marked.opId)));
      row = { ...cred!, lastErrorCode: incompleteCode, updatedAt: now };
    }
    // verify_current 는 이 해제가 연결 정보를 해제 상태로 만들었을 때만 삭제(확인할 현재 토큰이 없어짐). C 의 철회가 확인되지 않았으면
    // 위에서 C 를 cleanup_revoke 로 남겼으므로(또는 같은 토큰의 행이 남았으므로) 의무는 사라지지 않는다.
    if (outcome === 'revoked') {
      for (const p of marked.pendings) {
        if (p.kind === 'verify_current') await tx.delete(oauthPendingTokens).where(and(eq(oauthPendingTokens.id, p.id), eq(oauthPendingTokens.revision, p.revision)));
      }
    }
    await recordAudit(tx, {
      ownerId: input.ownerId,
      action: 'oauth.revoked',
      entity: 'channel_account',
      entityId: acc.id,
      details: {
        provider: cred?.provider ?? null,
        mock: cred?.isMock ?? null,
        outcome,
        joined: marked.joined,
        remote_revoke: remote,
        remote_error: remoteCode,
        revoked_approvals: marked.revokedApprovals,
        token_generation: marked.generation,
        revocation_epoch: marked.epoch,
        pending_token_revoke: pendingRevoke,
        pending_token_revoke_error: pendingRevokeCode,
        pending_tokens: withToken.length,
        pending_tokens_revoked: results.length - failedPending.length,
        current_token_record: currentRecord,
        incomplete_code: incompleteCode,
      },
      at: now,
    });
    for (const f of failedPending) {
      await auditCleanupFailure(tx, { ownerId: input.ownerId, accountId: acc.id, context: 'revoke_pending', result: f.result, code: f.code, pendingRecord: 'kept', now });
    }
    if (currentRecord !== 'not_needed' && currentRecord !== 'unreadable_kept') {
      await auditCleanupFailure(tx, { ownerId: input.ownerId, accountId: acc.id, context: 'revoke_current', result: remote as RemoteRevoke, code: remoteCode, pendingRecord: currentRecord, now });
    }
    await oauthTestHooks.insideRevokeFinish?.();
    return {
      health: accountHealthView(acc, row, await pendingInfoOf(tx, input.ownerId, acc.id), now),
      outcome,
      remoteRevoke: remote,
      revokedApprovals: marked.revokedApprovals,
      incompleteCode,
    };
  });
}

/**
 * 만료가 가까운(OAUTH_EXPIRING_SOON_MS 안, 아직 만료 전) 연결 정보를 갱신한다(worker tick). 실패는 기록만 하고 다음 계정으로.
 */
export async function refreshExpiringCredentials(
  db: Db,
  input: { providerFor: ProviderFor; keyring: KeyringSource; now?: Date; ownerId?: string; limit?: number },
): Promise<{ refreshed: number; failed: number; pendingResolved: number; pendingRemaining: number; revokeResumed: number; revokeWaiting: number; revokeSkippedChanged: number; revokeSkippedBusy: number }> {
  const now = input.now ?? new Date();
  // FIX3-T13: 정리 대기가 있는 계정을 먼저 정리한다(만료·상태와 무관 — 해제된 계정·연결 정보 행이 없는 계정 포함).
  // FIX4-T13(Codex review-FIX3-T13 P2 :1293): 다음 시도 시각(next_attempt_at)이 지난 행이 있는 계정만, 가장 이른 시각 순으로 고른다.
  // 정리는 시도마다(판정 불가 포함) 그 시각을 미루므로 계속 정리할 수 없는 계정이 뒤 계정의 차례를 독점하지 않는다.
  const pendingConds = [lte(oauthPendingTokens.nextAttemptAt, now)];
  if (input.ownerId) pendingConds.push(eq(oauthPendingTokens.ownerId, input.ownerId));
  const firstDue = sql<Date>`min(${oauthPendingTokens.nextAttemptAt})`;
  const pendingRows = await db
    .select({ ownerId: oauthPendingTokens.ownerId, accountId: oauthPendingTokens.channelAccountId, firstDue })
    .from(oauthPendingTokens)
    .where(and(...pendingConds))
    .groupBy(oauthPendingTokens.ownerId, oauthPendingTokens.channelAccountId)
    .orderBy(firstDue, asc(oauthPendingTokens.channelAccountId))
    .limit(input.limit ?? 20);
  let pendingResolved = 0;
  let pendingRemaining = 0;
  for (const p of pendingRows) {
    // FIX5-T13(P2 :1077): ignoreBackoff 없음 — 이 계정에서도 기한이 지난 행만 처리한다
    const r = await reconcilePendingCredential(db, { ownerId: p.ownerId, accountId: p.accountId, providerFor: input.providerFor, keyring: input.keyring, now, ignoreBackoff: false }).catch(
      async () => {
        // 정리 자체가 예외로 끝남 — 그래도 다음 시도 시각은 미룬다(같은 계정이 다음 tick 을 독점하지 않게)
        await db
          .transaction(async (tx) => {
            await lockAccountCredential(tx, p.ownerId, p.accountId);
            await tx
              .update(oauthPendingTokens)
              .set({ attempts: sql`${oauthPendingTokens.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + PENDING_BACKOFF_BASE_MS), lastResult: 'reconcile_error', updatedAt: now })
              .where(and(eq(oauthPendingTokens.ownerId, p.ownerId), eq(oauthPendingTokens.channelAccountId, p.accountId), lte(oauthPendingTokens.nextAttemptAt, now)));
          })
          .catch(() => undefined);
        return 'still_pending' as const;
      },
    );
    if (r === 'still_pending') pendingRemaining++;
    else pendingResolved++;
  }
  // FIX6-T13(Codex review-FIX5-T13 P1 :1541): 미완료 해제(revoking + 암호문 그대로)를 잇는다. 지금 키로 암호문을 열 수 있고 공급자가 있을 때만
  // 같은 해제 작업에 합류한다 — 아직 열 수 없으면 감사·비밀 쓰기 없이 다음 시도 시각만 미룬다.
  // FIX7-T13(Codex review-FIX6-T13):
  // - P2 :1779 — 후보는 revoke_resume_at(없으면 updated_at + REVOKE_RESUME_AFTER_MS)이 지난 행만, 그 시각 순. 열 수 없거나 공급자가 없어 넘긴 행은
  //   revoke_resume_attempts +1 · revoke_resume_at = now + backoff 로 미뤄 뒤 행이 차례를 받는다(정리 대기와 같은 지수 backoff).
  // - Q2 — last_error_code 'revoke_*' 표시를 더는 요구하지 않는다: 1단계 직후 멈춤·마무리 롤백으로 표시 없이 남은 revoking 행도 1단계가 정한
  //   revoke_resume_at 뒤에 잇는다.
  // - P1 :1791 — 재개는 훑을 때 본 해제 작업(작업 ID·토큰 세대·해제 세대)에 묶인다. 그 사이 해제가 끝나고 다시 연결됐거나 새 해제가 시작됐으면
  //   revokeCredentialOp 가 첫 잠금 안에서 확인하고 아무것도 하지 않는다(skipped_changed — 새 연결의 토큰을 철회하지 않는다).
  const resumeDue = sql<Date>`coalesce(${oauthCredentials.revokeResumeAt}, ${oauthCredentials.updatedAt} + make_interval(secs => ${REVOKE_RESUME_AFTER_MS / 1000}))`;
  const revokeConds = [
    eq(oauthCredentials.status, 'revoking'),
    isNull(oauthCredentials.revokedAt),
    isNotNull(oauthCredentials.revokeOpId),
    isNotNull(oauthCredentials.encryptedToken),
    isNotNull(oauthCredentials.keyVersion),
    sql`${resumeDue} <= ${now}`,
  ];
  if (input.ownerId) revokeConds.push(eq(oauthCredentials.ownerId, input.ownerId));
  const stuckRevokes = await db
    .select()
    .from(oauthCredentials)
    .where(and(...revokeConds))
    .orderBy(resumeDue, asc(oauthCredentials.id))
    .limit(input.limit ?? 20);
  let revokeResumed = 0;
  let revokeWaiting = 0;
  let revokeSkippedChanged = 0;
  // FIX8-T13: 같은 작업이지만 훑은 뒤 다른 호출(worker·사용자 해제)이 재개를 잡아 예약이 바뀌었거나 아직 기한 전 — 공급자 호출 없음
  let revokeSkippedBusy = 0;
  // 훑을 때 본 그 작업이 아직 그대로이고 아직 기한이 지난 상태일 때만 미룬다(다른 호출이 정한 더 늦은 예약·새 연결은 건드리지 않음). updated_at·감사 없음.
  const deferResume = async (c: OAuthCredentialRow) => {
    const attempts = c.revokeResumeAttempts + 1;
    await db
      .update(oauthCredentials)
      .set({ revokeResumeAttempts: attempts, revokeResumeAt: new Date(now.getTime() + Math.max(REVOKE_RESUME_AFTER_MS, pendingBackoffMs(attempts))) })
      .where(
        and(
          eq(oauthCredentials.id, c.id),
          eq(oauthCredentials.status, 'revoking'),
          isNull(oauthCredentials.revokedAt),
          eq(oauthCredentials.revokeOpId, c.revokeOpId!),
          eq(oauthCredentials.tokenGeneration, c.tokenGeneration),
          eq(oauthCredentials.revocationEpoch, c.revocationEpoch),
          eq(oauthCredentials.revokeResumeAttempts, c.revokeResumeAttempts),
          sql`${resumeDue} <= ${now}`,
        ),
      )
      .catch(() => undefined);
  };
  for (const c of stuckRevokes) {
    try {
      const ring = input.keyring();
      openSecret(ring, c.encryptedToken!, c.keyVersion!, tokenAad(c.ownerId, c.channelAccountId));
      input.providerFor(await ownedAccount(db, c.ownerId, c.channelAccountId));
    } catch {
      revokeWaiting++;
      await deferResume(c);
      continue;
    }
    await oauthTestHooks.beforeRevokeResume?.({ ownerId: c.ownerId, accountId: c.channelAccountId });
    const r = await revokeCredentialOp(
      db,
      { ownerId: c.ownerId, accountId: c.channelAccountId, providerFor: input.providerFor, keyring: input.keyring, now },
      { opId: c.revokeOpId!, generation: c.tokenGeneration, epoch: c.revocationEpoch, resumeAt: c.revokeResumeAt, attempts: c.revokeResumeAttempts },
    ).catch(() => null);
    if (r === 'skipped_changed') revokeSkippedChanged++;
    else if (r === 'skipped_busy') revokeSkippedBusy++;
    else if (r && (r.outcome === 'revoked' || r.outcome === 'completed_by_other' || r.outcome === 'already_revoked')) revokeResumed++;
    else {
      revokeWaiting++;
      // 예외로 끝남 — 1단계가 커밋됐으면 이미 미뤄졌다(아래는 1단계 전 실패일 때만 적용됨)
      if (!r) await deferResume(c);
    }
  }
  const conds = [
    eq(oauthCredentials.status, 'active'),
    // LIVE-T1(D31): 실제 연결 정보의 자동 갱신(th_refresh_token — 실제 Threads 호출)은 D31 승인 범위(연결·프로필 조회) 밖이라 worker 가 하지 않는다.
    // 모의 연결 정보만 자동 갱신한다. 실제 토큰은 만료(60일) 전 사용자가 다시 연결하거나, 별도 승인 뒤 이 조건을 푼다.
    eq(oauthCredentials.isMock, true),
    isNull(oauthCredentials.revokedAt),
    notExists(db.select({ one: sql`1` }).from(oauthPendingTokens).where(eq(oauthPendingTokens.channelAccountId, oauthCredentials.channelAccountId))),
    gt(oauthCredentials.expiresAt, now),
    lte(oauthCredentials.expiresAt, new Date(now.getTime() + OAUTH_EXPIRING_SOON_MS)),
  ];
  if (input.ownerId) conds.push(eq(oauthCredentials.ownerId, input.ownerId));
  const due = await db
    .select({ ownerId: oauthCredentials.ownerId, accountId: oauthCredentials.channelAccountId })
    .from(oauthCredentials)
    .where(and(...conds))
    .orderBy(asc(oauthCredentials.expiresAt))
    .limit(input.limit ?? 20);
  let refreshed = 0;
  let failed = 0;
  for (const d of due) {
    try {
      await refreshCredential(db, { ownerId: d.ownerId, accountId: d.accountId, providerFor: input.providerFor, keyring: input.keyring, now, trigger: 'auto' });
      refreshed++;
    } catch {
      failed++;
    }
  }
  return { refreshed, failed, pendingResolved, pendingRemaining, revokeResumed, revokeWaiting, revokeSkippedChanged, revokeSkippedBusy };
}

// ---- 키 교체 ----

export interface RotationCounts {
  /** 봉인이 있는 행 수 */
  total: number;
  /** 현재 키 버전이고 열림(무결성 확인됨) */
  alreadyCurrent: number;
  /** 옛 버전이고 열림 — 다시 봉인 대상 */
  toReseal: number;
  /** 실제로 다시 봉인한 수(dry-run 이면 0) */
  resealed: number;
  /** FIX2-T13: 훑은 뒤 갱신 전에 바뀌거나 소비된 행(UPDATE 0행) — 다시 봉인으로 세지 않는다 */
  skippedChanged: number;
  /** 열 수 없음 — 문제 종류별(malformed·version_mismatch·unknown_key_version·auth_failed) */
  failed: Record<string, number>;
}

export interface RotationReport {
  dryRun: boolean;
  keyVersion: number;
  credentials: RotationCounts;
  states: RotationCounts;
  /** FIX3-T13: 정리 대기 중인 봉인(pending_token) */
  pendingTokens: RotationCounts;
}

const emptyCounts = (): RotationCounts => ({ total: 0, alreadyCurrent: 0, toReseal: 0, resealed: 0, skippedChanged: 0, failed: {} });
const failedTotal = (c: RotationCounts) => Object.values(c.failed).reduce((a, b) => a + b, 0);

/**
 * 키 교체(Codex Q6·D25-5): **모든** 봉인(연결 정보·아직 유효한 연결 요청)을 연다 — 현재 버전 행도 검사해 열·봉투 버전 불일치·손상 태그를
 * failed(문제 종류별)로 센다. 옛 버전이고 열리면 현재 키로 다시 봉인한다(dryRun 이면 세기만). 토큰 세대는 바꾸지 않는다.
 * 행마다 계정 → 연결 정보 잠금 아래에서 처리(갱신·해제와 직렬화). 열 수 없는 행은 그대로 둔다. 값·암호문은 결과에 넣지 않는다.
 */
export async function rotateSecretKeys(db: Db, keyring: SecretKeyring, opts: { dryRun?: boolean; now?: Date } = {}): Promise<RotationReport> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const report: RotationReport = { dryRun, keyVersion: keyring.current.version, credentials: emptyCounts(), states: emptyCounts(), pendingTokens: emptyCounts() };
  const fail = (c: RotationCounts, e: unknown) => {
    const code = e instanceof SecretDecryptError ? e.problem : 'error';
    c.failed[code] = (c.failed[code] ?? 0) + 1;
  };
  const credIds = await db
    .select({ ownerId: oauthCredentials.ownerId, accountId: oauthCredentials.channelAccountId })
    .from(oauthCredentials)
    .where(isNotNull(oauthCredentials.encryptedToken))
    .orderBy(asc(oauthCredentials.channelAccountId));
  const touchedOwners = new Set<string>();
  for (const { ownerId, accountId } of credIds) {
    await db.transaction(async (tx) => {
      const { cred } = await lockAccountCredential(tx, ownerId, accountId);
      if (!cred?.encryptedToken || cred.keyVersion === null) return;
      const c = report.credentials;
      c.total++;
      const aad = tokenAad(ownerId, accountId);
      try {
        openSecret(keyring, cred.encryptedToken, cred.keyVersion, aad);
      } catch (e) {
        fail(c, e);
        return;
      }
      if (cred.keyVersion === keyring.current.version) {
        c.alreadyCurrent++;
        return;
      }
      c.toReseal++;
      if (dryRun) return;
      const r = resealSecret(keyring, cred.encryptedToken, cred.keyVersion, aad)!;
      const u = await tx
        .update(oauthCredentials)
        .set({ encryptedToken: r.ciphertext, keyVersion: r.keyVersion, updatedAt: now })
        .where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.tokenGeneration, cred.tokenGeneration), eq(oauthCredentials.encryptedToken, cred.encryptedToken)))
        .returning({ id: oauthCredentials.id });
      if (u.length === 0) {
        c.skippedChanged++;
        return;
      }
      c.resealed++;
      touchedOwners.add(ownerId);
    });
  }
  // FIX3-T13: 정리 대기 봉인도 같은 규칙(계정 잠금 아래, 모두 열어 검사, 옛 버전만 다시 봉인)
  // FIX4-T13: 봉인은 oauth_pending_tokens 행마다. 봉인만 바꾸고 revision 은 그대로(토큰 자체는 같다 — 진행 중인 정리의 판정은 유효).
  const pendingIds = await db
    .select({ id: oauthPendingTokens.id, ownerId: oauthPendingTokens.ownerId, accountId: oauthPendingTokens.channelAccountId })
    .from(oauthPendingTokens)
    .where(isNotNull(oauthPendingTokens.sealedToken))
    .orderBy(asc(oauthPendingTokens.channelAccountId), asc(oauthPendingTokens.id));
  for (const { id: pendingId, ownerId, accountId } of pendingIds) {
    await db.transaction(async (tx) => {
      await lockAccountCredential(tx, ownerId, accountId);
      const p = (await tx.select().from(oauthPendingTokens).where(eq(oauthPendingTokens.id, pendingId)).for('update').limit(1))[0];
      if (!p?.sealedToken || p.keyVersion === null) return;
      const c = report.pendingTokens;
      c.total++;
      const aad = pendingAad(ownerId, accountId);
      try {
        openSecret(keyring, p.sealedToken, p.keyVersion, aad);
      } catch (e) {
        fail(c, e);
        return;
      }
      if (p.keyVersion === keyring.current.version) {
        c.alreadyCurrent++;
        return;
      }
      c.toReseal++;
      if (dryRun) return;
      const r = resealSecret(keyring, p.sealedToken, p.keyVersion, aad)!;
      const u = await tx
        .update(oauthPendingTokens)
        .set({ sealedToken: r.ciphertext, keyVersion: r.keyVersion, updatedAt: now })
        .where(and(eq(oauthPendingTokens.id, p.id), eq(oauthPendingTokens.sealedToken, p.sealedToken)))
        .returning({ id: oauthPendingTokens.id });
      if (u.length === 0) {
        c.skippedChanged++;
        return;
      }
      c.resealed++;
      touchedOwners.add(ownerId);
    });
  }
  const states = await db
    .select()
    .from(oauthStates)
    .where(and(isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, now)))
    .orderBy(asc(oauthStates.id));
  for (const s of states) {
    const c = report.states;
    c.total++;
    const aad = verifierAad(s.ownerId, s.channelAccountId, s.id);
    try {
      openSecret(keyring, s.encryptedVerifier, s.keyVersion, aad);
    } catch (e) {
      fail(c, e);
      continue;
    }
    if (s.keyVersion === keyring.current.version) {
      c.alreadyCurrent++;
      continue;
    }
    c.toReseal++;
    if (dryRun) continue;
    const r = resealSecret(keyring, s.encryptedVerifier, s.keyVersion, aad)!;
    await oauthTestHooks.beforeRotateStateUpdate?.();
    const u = await db
      .update(oauthStates)
      .set({ encryptedVerifier: r.ciphertext, keyVersion: r.keyVersion })
      .where(and(eq(oauthStates.id, s.id), isNull(oauthStates.usedAt), eq(oauthStates.encryptedVerifier, s.encryptedVerifier)))
      .returning({ id: oauthStates.id });
    if (u.length === 0) {
      c.skippedChanged++;
      continue;
    }
    c.resealed++;
    touchedOwners.add(s.ownerId);
  }
  if (!dryRun) {
    const failedOwners = failedTotal(report.credentials) + failedTotal(report.states) + failedTotal(report.pendingTokens) > 0;
    const owners = failedOwners ? new Set([...touchedOwners, ...credIds.map((c) => c.ownerId)]) : touchedOwners;
    for (const ownerId of owners) {
      await recordAudit(db, {
        ownerId,
        action: 'oauth.key_rotated',
        entity: 'secrets',
        details: {
          key_version: keyring.current.version,
          resealed: report.credentials.resealed + report.states.resealed + report.pendingTokens.resealed,
          failed: failedTotal(report.credentials) + failedTotal(report.states) + failedTotal(report.pendingTokens),
        },
        at: now,
      });
    }
  }
  return report;
}

/** `pnpm secrets:rotate` 출력(숫자·문제 종류만 — 키·암호문·토큰 없음). */
export function formatRotationReport(r: RotationReport): string {
  const line = (label: string, c: RotationCounts) => {
    const failed = Object.entries(c.failed)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    return `${label}: 전체 ${c.total} · 현재 키 ${c.alreadyCurrent} · 다시 봉인 대상 ${c.toReseal} · 다시 봉인함 ${c.resealed} · 그 사이 바뀌어 건너뜀 ${c.skippedChanged} · 열 수 없음 ${failedTotal(c)}${failed ? ` (${failed})` : ''}`;
  };
  return [
    r.dryRun ? `미리보기(변경 없음) — 현재 키 버전 ${r.keyVersion}. 적용하려면 --confirm` : `적용함 — 현재 키 버전 ${r.keyVersion}`,
    line('연결 정보', r.credentials),
    line('진행 중 연결 요청', r.states),
    line('정리 대기 봉인', r.pendingTokens),
  ].join('\n');
}
