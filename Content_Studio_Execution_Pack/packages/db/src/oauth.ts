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
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm';
import {
  AppError,
  codeChallengeS256,
  CREDENTIAL_STATUS_LABEL,
  CREDENTIAL_STATUSES,
  CredentialBusyError,
  CredentialNotFoundError,
  CredentialRefreshFailedError,
  credentialHealth,
  hashOAuthState,
  isUuid,
  isWellFormedOAuthState,
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
import { channelAccounts, oauthCredentials, oauthStates } from './schema';

export type OAuthCredentialRow = typeof oauthCredentials.$inferSelect;
export type OAuthStateRow = typeof oauthStates.$inferSelect;
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

function encodeTokens(t: OAuthTokenSet): string {
  return JSON.stringify({ v: 1, access_token: t.accessToken, refresh_token: t.refreshToken });
}

function decodeTokens(plain: string): StoredOAuthTokens {
  let v: unknown;
  try {
    v = JSON.parse(plain);
  } catch {
    throw new SecretDecryptError('malformed');
  }
  const o = v as { v?: unknown; access_token?: unknown; refresh_token?: unknown };
  if (o.v !== 1 || typeof o.access_token !== 'string' || !(o.refresh_token === null || typeof o.refresh_token === 'string')) {
    throw new SecretDecryptError('malformed');
  }
  return { accessToken: o.access_token, refreshToken: o.refresh_token };
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

export function healthOf(account: AccountRow, cred: OAuthCredentialRow | null, now: Date): CredentialHealth {
  return credentialHealth({
    account: { kind: account.kind, credentialState: account.credentialState },
    credential: cred
      ? { status: cred.status, expiresAt: cred.expiresAt, scopes: cred.scopes, revokedAt: cred.revokedAt, lastErrorCode: cred.lastErrorCode, pendingKind: cred.pendingKind }
      : null,
    requiredScopes: requiredScopesForPlatform(account.platform),
    now,
  });
}

/** 화면·API 응답용 연결 상태. 토큰·암호문은 넣지 않는다. 모의 연결은 MOCK 표시. */
export function accountHealthView(account: AccountRow, cred: OAuthCredentialRow | null, now: Date) {
  const health = healthOf(account, cred, now);
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
    /** FIX3-T13: 정리 대기 종류만(refresh_unknown·cleanup_revoke) — 봉인·작업 ID 는 내보내지 않는다 */
    pending_reconcile: cred?.pendingKind ?? null,
    notice: mock ? 'MOCK — 모의 연결입니다. 실제 Threads 계정 연결이 아니며 실제 게시에 쓰이지 않습니다.' : null,
  };
}
export type AccountHealthView = ReturnType<typeof accountHealthView>;

export async function getAccountHealth(db: DbOrTx, ownerId: string, accountId: string, now: Date = new Date()): Promise<AccountHealthView> {
  const account = await ownedAccount(db, ownerId, accountId);
  return accountHealthView(account, await credentialOf(db, ownerId, account.id), now);
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
  return accounts.map((a) => accountHealthView(a, byAccount.get(a.id) ?? null, now));
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
  for (const a of accounts) out.set(a.id, healthOf(a, byAccount.get(a.id) ?? null, now));
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
      details: { provider: provider.id, mock: provider.mock, scopes: scopes.join(','), pkce: 'S256' },
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

type RemoteRevoke = 'ok' | 'ok_already_revoked' | 'failed' | 'unknown';

/**
 * 공급자에서 토큰을 철회한다(정리용 — 실패해도 던지지 않는다).
 * FIX3-T13: token_revoked·invalid_token(공급자가 모르는 토큰 — 쓸 수 없음) = 이미 철회됨. provider_error(일시·원인 불명) = unknown(철회됐는지 모름).
 * 그 밖의 공급자 거부 = failed(철회되지 않음). failed·unknown 은 정리 대기(cleanup_revoke)로 남겨 다음 확인·tick 이 다시 철회한다.
 */
async function revokeAtProvider(provider: OAuthProvider, tokens: StoredOAuthTokens, now: Date): Promise<{ result: RemoteRevoke; code: string | null }> {
  try {
    await provider.revoke({ tokens, now });
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
    await rejectCallback(db, ownerId, account.id, 'exchange_failed', now, { provider_error: code });
    throw new OAuthFlowError('oauth_exchange_failed', { reason: code });
  }
  // 여기부터 공급자에 유효한 토큰이 있다 — 저장하지 못하면 철회한다.
  const issued: StoredOAuthTokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  const placeholder = { provider: provider.id, isMock: provider.mock };
  // FIX3-T13(놓친 케이스): 정리 철회가 실패·불명이면 받은 토큰을 봉인해 정리 대기(cleanup_revoke)로 남긴다 — 연결 정보 행이 없으면
  // (첫 연결) 해제 상태의 자리 표시 행에. 정리될 때까지 이 계정 실행 차단, 다음 확인·tick 이 다시 철회한다.
  const discard = async (reason: string, extra: Record<string, string | null> = {}) => {
    const cleanup = await revokeAtProvider(provider, issued, now);
    let pendingRecord = 'not_requested';
    if (cleanupFailed(cleanup.result)) {
      const mark = await markAfterIssuance(db, { ownerId, accountId: account.id, generation: null, markStoreFailed: false, pending: { kind: 'cleanup_revoke', tokens: issued }, keyring: input.keyring, placeholder, now });
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
  if (info.externalAccountId !== account.externalAccountId) {
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
      return accountHealthView({ ...acc, credentialState: 'linked' }, fresh, now);
    });
  } catch (e) {
    const outcome = sealedCt ? await tokenStoredOutcome(db, ownerId, account.id, sealedCt, issued.accessToken, input.keyring) : 'not_stored';
    if (outcome === 'stored') return getAccountHealth(db, ownerId, account.id, now);
    if (outcome === 'unknown') {
      // 저장됐을 수도 있으므로 철회하지 않는다(유효한 연결을 깨지 않음). FIX3-T13(Q14): 받은 토큰을 봉인해 정리 대기(refresh_unknown —
      // 살아 있는 행이 아니면 cleanup_revoke)로 남기고 정리될 때까지 차단 — 다음 확인·갱신·tick 이 판정한다(reconcilePendingCredential).
      const mark = await markAfterIssuance(db, { ownerId, accountId: account.id, generation: null, markStoreFailed: false, pending: { kind: 'refresh_unknown', tokens: issued }, keyring: input.keyring, placeholder, now });
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
      const health = healthOf(account, cred, now);
      if (!health.usable) return { ok: false, code: `credential_${health.status}` };
      if (!cred || cred.revokedAt || !cred.encryptedToken || cred.keyVersion === null) return { ok: false, code: 'credential_missing' };
      try {
        const tokens = decodeTokens(openSecret(ring, cred.encryptedToken, cred.keyVersion, tokenAad(input.ownerId, account.id)));
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
  // FIX3-T13: 정리 대기 표시가 있으면 먼저 정리한다 — 정리되지 않으면 갱신하지 않는다(정리 대기는 한 번에 하나).
  if ((await reconcilePendingCredential(db, { ...input, now })) === 'still_pending') throw new CredentialRefreshFailedError('pending_reconcile');
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
  const issued: StoredOAuthTokens = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
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
            pending: failedCleanup ? { kind: 'cleanup_revoke', tokens: issued } : null,
            keyring: input.keyring,
            placeholder: null,
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
      return accountHealthView(account, updated[0]!, now);
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
        pending: { kind: 'refresh_unknown', tokens: issued },
        keyring: input.keyring,
        placeholder: null,
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

// ---- FIX3-T13: 정리 대기(pending reconcile) ----

/**
 * 정리 대기 종류(oauth_credentials.pending_kind):
 * - refresh_unknown: 발급받은 토큰(T2)이 저장됐는지 판정하지 못함(저장 뒤 다시 읽기 실패·열 수 없음). 저장됐을 수 있어 바로 철회하지 않는다.
 * - cleanup_revoke: T2 는 저장되지 않았음(또는 현재 토큰일 수 없음)이 확실한데 공급자 철회가 실패·불명 — 다시 철회해야 한다.
 */
type PendingKind = 'refresh_unknown' | 'cleanup_revoke';
type PendingRecordResult = 'recorded' | 'occupied' | 'seal_failed' | 'no_row' | 'write_failed' | 'not_requested';

interface IssuanceMark {
  /** 읽었던 세대에서 error(refresh_store_failed)를 기록했는가 */
  storeFailedMarked: boolean;
  pending: PendingRecordResult;
  pendingKind: PendingKind | null;
}

const pendingAad = (ownerId: string, accountId: string): SecretAad => ({ ownerId, channelAccountId: accountId, purpose: 'oauth_pending_token' });

const encodePending = (t: StoredOAuthTokens) => JSON.stringify({ v: 1, access_token: t.accessToken, refresh_token: t.refreshToken });

/** 살아 있는 연결 정보(토큰 있음·해제 아님·해제 중 아님) */
const liveCredential = (cred: OAuthCredentialRow | null): cred is OAuthCredentialRow =>
  !!cred && !cred.revokedAt && cred.status !== 'revoking' && cred.encryptedToken !== null && cred.keyVersion !== null;

/**
 * 첫 연결의 정리 대기만 담는 자리 표시 행: 해제 상태(revoked)·암호문 없음·해제 세대 0. 실제 연결 해제는 해제 세대를 1 이상으로 올리므로
 * "revoked + 세대 0" 은 자리 표시뿐이다. 정리가 끝나면 지운다(연결 정보 없음으로 돌아감 — 해제 세대 0 그대로라 연결 요청 판정에 영향 없음).
 */
const isPlaceholder = (cred: OAuthCredentialRow) => cred.revokedAt !== null && cred.revocationEpoch === 0 && cred.encryptedToken === null;

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
 * FIX3-T13(Codex review-FIX2-T13 P1 :690·Q14·놓친 케이스): 발급 뒤 실패를 연결 정보에 남긴다(계정 → 연결 정보 잠금, 한 트랜잭션).
 * - markStoreFailed: 저장되지 않았음이 확인된 갱신 — 읽었던 세대(generation)가 아직 현재이고 살아 있을 때만 status='error'
 *   (refresh_store_failed). 동시에 저장된 새 세대(다시 연결)는 그대로 둔다.
 * - pending: T2 를 현재 키로 봉인(AAD purpose oauth_pending_token)해 정리 대기 표시. refresh_unknown 은 행이 살아 있고 세대가 읽은 값이거나
 *   +1(우리 저장이 커밋됐을 수 있음)일 때만 — 그보다 새 세대·해제 중·해제됨이면 T2 는 현재 토큰일 수 없으므로 cleanup_revoke 로 기록.
 *   행이 없으면(첫 연결) placeholder 가 있을 때 자리 표시 행을 만든다. 이미 다른 정리 대기가 있으면 겹쳐 쓰지 않는다(occupied — 기존 표시가 차단 유지).
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
    pending: { kind: PendingKind; tokens: StoredOAuthTokens } | null;
    keyring: KeyringSource;
    placeholder: { provider: string; isMock: boolean } | null;
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
      const fields = { pendingOpId: randomUUID(), pendingToken: sealed.ciphertext, pendingKeyVersion: sealed.keyVersion, updatedAt: input.now };
      if (!cred) {
        if (!input.placeholder) return { storeFailedMarked, pending: 'no_row', pendingKind: null };
        await tx.insert(oauthCredentials).values({
          ownerId: input.ownerId,
          channelAccountId: input.accountId,
          provider: input.placeholder.provider,
          isMock: input.placeholder.isMock,
          encryptedToken: null,
          keyVersion: null,
          tokenGeneration: 1,
          revocationEpoch: 0,
          status: 'revoked',
          revokedAt: input.now,
          scopes: [],
          connectedAt: input.now,
          createdAt: input.now,
          pendingKind: 'cleanup_revoke',
          ...fields,
        });
        return { storeFailedMarked, pending: 'recorded', pendingKind: 'cleanup_revoke' };
      }
      if (cred.pendingOpId !== null) return { storeFailedMarked, pending: 'occupied', pendingKind: null };
      const couldBeCurrent = liveCredential(cred) && (input.generation === null || cred.tokenGeneration <= input.generation + 1);
      const kind: PendingKind = input.pending.kind === 'refresh_unknown' && couldBeCurrent ? 'refresh_unknown' : 'cleanup_revoke';
      await tx.update(oauthCredentials).set({ ...fields, pendingKind: kind }).where(eq(oauthCredentials.id, cred.id));
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

/**
 * FIX3-T13(Codex review-FIX2-T13 Q14): 정리 대기 처리 — check·refresh 가 먼저 부르고, worker tick(refreshExpiringCredentials)이 표시된 행마다 부른다.
 * 잠금 아래에서 표시(작업 ID)·봉인한 T2(P)·현재 저장 토큰(C)을 읽고, 공급자 호출은 트랜잭션 밖, 되쓰기는 잠금 아래에서 표시가 그대로일 때만.
 *
 * 판정표(행이 해제됨·자리 표시면 종류와 관계없이 cleanup_revoke 로 본다; 해제 진행 중이면 해제가 처리하므로 손대지 않음):
 * | 종류            | 조건                          | 공급자                       | 결과                                                                 |
 * |-----------------|-------------------------------|------------------------------|----------------------------------------------------------------------|
 * | 둘 다           | P 를 열 수 없음(키)           | 없음                         | 표시 유지(still_pending, 차단)                                        |
 * | refresh_unknown | C 를 열 수 없음               | 없음                         | 표시 유지 — 같은지 비교할 수 없다                                       |
 * | refresh_unknown | C == P(저장돼 있었음)         | C 유효성 확인                | P 철회하지 않음, 표시 지움, C 유효 → active / 무효 → error(공급자 코드) |
 * | refresh_unknown | C != P                        | P 철회 + C 유효성 확인        | 철회 성공: 표시 지움, C 유효 → active, 무효 → error(refresh_store_failed — 저장됐다고 증명할 수 없는 P 는 철회했으니 다시 연결) |
 * |                 |                               |                              | 철회 실패·불명: 표시를 cleanup_revoke 로 바꿔 유지, C 상태는 위와 같이 기록 |
 * | cleanup_revoke  | —                             | P 철회                        | 성공: 표시 지움(상태 그대로, 자리 표시 행이면 삭제) / 실패·불명: 유지   |
 * 상태(active·error) 기록은 읽었던 세대가 아직 현재이고 살아 있을 때만 — 그 사이 다시 연결된 새 세대는 건드리지 않는다.
 * C 확인이 일시 오류(provider_error 등)면 상태를 바꾸지 않는다. 철회 실패·불명은 감사 cleanup_revoke_failed / cleanup_revoke_unknown.
 */
export async function reconcilePendingCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date },
): Promise<ReconcileResult> {
  const now = input.now ?? new Date();
  const account = await ownedAccount(db, input.ownerId, input.accountId);
  type Read =
    | null
    | { stuck: string }
    | { opId: string; kind: PendingKind; generation: number; pending: StoredOAuthTokens; current: StoredOAuthTokens | null; currentUnreadable: boolean };
  const read = await db.transaction(async (tx): Promise<Read> => {
    const { cred } = await lockAccountCredential(tx, input.ownerId, account.id);
    if (!cred?.pendingOpId || !cred.pendingToken || cred.pendingKeyVersion === null) return null;
    if (cred.status === 'revoking') return { stuck: 'revoking' };
    const live = liveCredential(cred);
    const kind: PendingKind = live && cred.pendingKind === 'refresh_unknown' ? 'refresh_unknown' : 'cleanup_revoke';
    let ring: SecretKeyring;
    try {
      ring = input.keyring();
    } catch {
      return { stuck: 'no_key' };
    }
    let pending: StoredOAuthTokens;
    try {
      pending = decodeTokens(openSecret(ring, cred.pendingToken, cred.pendingKeyVersion, pendingAad(input.ownerId, account.id)));
    } catch (e) {
      return { stuck: e instanceof SecretDecryptError ? `pending_${e.problem}` : 'pending_unreadable' };
    }
    let current: StoredOAuthTokens | null = null;
    let currentUnreadable = false;
    if (live) {
      try {
        current = decodeTokens(openSecret(ring, cred.encryptedToken!, cred.keyVersion!, tokenAad(input.ownerId, account.id)));
      } catch {
        currentUnreadable = true;
      }
    }
    return { opId: cred.pendingOpId, kind, generation: cred.tokenGeneration, pending, current, currentUnreadable };
  });
  if (!read) return 'none';
  if ('stuck' in read) return 'still_pending';
  if (read.kind === 'refresh_unknown' && (read.currentUnreadable || !read.current)) return 'still_pending';
  let provider: OAuthProvider;
  try {
    provider = input.providerFor(account);
  } catch {
    return 'still_pending';
  }
  const storedIsPending = read.kind === 'refresh_unknown' && read.current!.accessToken === read.pending.accessToken;
  const cleanup = storedIsPending ? null : await revokeAtProvider(provider, read.pending, now);
  // C 유효성(refresh_unknown 만 — 상태 판정이 이 정리의 몫): true 유효, false 무효, null 판단 불가(일시 오류)
  let currentValid: boolean | null = null;
  let currentError: string | null = null;
  if (read.kind === 'refresh_unknown') {
    try {
      const info = await provider.accountInfo({ accessToken: read.current!.accessToken, now });
      currentValid = info.externalAccountId === account.externalAccountId;
      if (!currentValid) currentError = 'account_mismatch';
    } catch (e) {
      const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
      if (providerFailureStatus(code) === 'error') {
        currentValid = false;
        currentError = code;
      }
    }
  }
  await oauthTestHooks.afterReconcileProvider?.();
  const stillPending = cleanup !== null && cleanupFailed(cleanup.result);
  const result = await db.transaction(async (tx): Promise<{ r: ReconcileResult; audited: { status: string | null; deleted: boolean } | null }> => {
    const { cred } = await lockAccountCredential(tx, input.ownerId, account.id);
    // 그 사이 다른 처리(다른 정리·해제)가 이 표시를 끝냈으면 아무것도 쓰지 않는다
    if (!cred || cred.pendingOpId !== read.opId) return { r: 'resolved', audited: null };
    const set: Partial<typeof oauthCredentials.$inferInsert> = { updatedAt: now };
    let status: string | null = null;
    if (read.kind === 'refresh_unknown' && currentValid !== null && sameLiveGeneration(cred, read.generation)) {
      status = currentValid ? 'active' : 'error';
      set.status = status;
      set.lastErrorCode = currentValid ? null : storedIsPending ? currentError : 'refresh_store_failed';
      set.lastCheckedAt = now;
    }
    if (stillPending) {
      // P 는 현재 토큰이 아님이 확인됨 — 다시 철회해야 하는 cleanup_revoke 로 유지(차단 계속)
      await tx.update(oauthCredentials).set({ ...set, pendingKind: 'cleanup_revoke' }).where(eq(oauthCredentials.id, cred.id));
      return { r: 'still_pending', audited: { status, deleted: false } };
    }
    if (isPlaceholder(cred)) {
      await tx.delete(oauthCredentials).where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.pendingOpId, read.opId)));
      return { r: 'resolved', audited: { status, deleted: true } };
    }
    await tx
      .update(oauthCredentials)
      .set({ ...set, pendingOpId: null, pendingKind: null, pendingToken: null, pendingKeyVersion: null })
      .where(eq(oauthCredentials.id, cred.id));
    return { r: 'resolved', audited: { status, deleted: false } };
  });
  if (result.audited) {
    if (cleanup && cleanupFailed(cleanup.result)) {
      await auditCleanupFailure(db, { ownerId: input.ownerId, accountId: account.id, context: `reconcile_${read.kind}`, result: cleanup.result, code: cleanup.code, pendingRecord: 'kept', now });
    }
    await recordAudit(db, {
      ownerId: input.ownerId,
      action: 'oauth.pending_reconciled',
      entity: 'channel_account',
      entityId: account.id,
      details: {
        kind: read.kind,
        result: result.r,
        stored_was_pending: storedIsPending,
        issued_token_revoke: cleanup?.result ?? 'not_needed',
        issued_token_revoke_error: cleanup?.code ?? null,
        current_token_valid: currentValid === null ? 'not_checked' : currentValid ? 'yes' : 'no',
        status: result.audited.status,
        placeholder_removed: result.audited.deleted,
      },
      at: now,
    }).catch(() => undefined);
  }
  return result.r;
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
  if ((await reconcilePendingCredential(db, { ...input, now })) !== 'none') return getAccountHealth(db, input.ownerId, input.accountId, now);
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
    return accountHealthView(account, row, now);
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
}

/**
 * 연결 해제(Codex P1 #3, FIX2 P1) — 해제 작업(revoke_op_id) 단위:
 * 1) 잠금 아래: 이미 해제됐으면 끝. 진행 중인 해제 작업(status='revoking' + revoke_op_id)이 있으면 **그 작업에 합류**(해제 세대 그대로),
 *    없으면 새 작업 ID 를 만들고 해제 세대(revocation_epoch) +1 · status='revoking'. 이 계정의 미사용 연결 요청을 사용 처리, 활성 승인 철회
 *    (account_changed, D25-1), 토큰 복호화.
 * 2) 트랜잭션 밖: 공급자 철회(키가 없거나 읽을 수 없거나 공급자 오류면 그 결과를 그대로 보고).
 * 3) 잠금 아래: 자기 작업이 아직 현재이고 세대가 그대로면 암호문·키 버전 삭제 + revoked_at(작업 ID 는 남김). 그 밖의 판정은 RevokeOutcome.
 * credential_state 는 linked 그대로 — 다시 연결하기 전까지 실행 차단. 다시 연결은 revoke_op_id 를 지우지만 해제 세대는 그대로 둔다.
 */
export async function revokeCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date },
): Promise<RevokeResult> {
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
    if (!cred) throw new CredentialNotFoundError();
    if (cred.revokedAt) return { done: accountHealthView(acc, cred, now) };
    let opId = cred.revokeOpId;
    let epoch = cred.revocationEpoch;
    const joined = cred.status === 'revoking' && opId !== null;
    if (!joined) {
      opId = randomUUID();
      epoch = cred.revocationEpoch + 1;
      await tx
        .update(oauthCredentials)
        .set({ status: 'revoking', revokeOpId: opId, revocationEpoch: epoch, updatedAt: now })
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
    // FIX3-T13: 정리 대기 중인 T2 도 함께 철회한다. 마무리(3단계)에서 이 단계가 본 표시(작업 ID)만 — 철회가 확인됐을 때만 지운다.
    let pendingTokens: StoredOAuthTokens | null = null;
    if (provider && cred.pendingToken && cred.pendingKeyVersion !== null) {
      try {
        pendingTokens = decodeTokens(openSecret(input.keyring(), cred.pendingToken, cred.pendingKeyVersion, pendingAad(input.ownerId, acc.id)));
      } catch {
        pendingTokens = null;
      }
    }
    return { generation: cred.tokenGeneration, tokens, pendingTokens, pendingOpId: cred.pendingOpId, skip, revokedApprovals: revoked.length, credId: cred.id, opId: opId!, epoch, joined };
  });
  if ('done' in marked && marked.done) return { health: marked.done, outcome: 'already_revoked', remoteRevoke: 'already_revoked', revokedApprovals: 0 };
  if ('done' in marked) throw new CredentialNotFoundError();
  await oauthTestHooks.afterRevokeMarked?.();
  let remote: RevokeResult['remoteRevoke'] = marked.skip ?? 'ok';
  let remoteCode: string | null = null;
  let pendingRevoke: RemoteRevoke | 'unreadable' | 'none' = marked.pendingOpId ? 'unreadable' : 'none';
  let pendingRevokeCode: string | null = null;
  if (provider && marked.pendingTokens) {
    const pr = await revokeAtProvider(provider, marked.pendingTokens, now);
    pendingRevoke = pr.result;
    pendingRevokeCode = pr.code;
  }
  // 이 해제가 본 정리 대기를 지워도 되는가(공급자 철회가 확인됨). 아니면 표시를 남긴다 — 해제 뒤 행에서는 cleanup_revoke 로 다시 철회.
  const pendingCleared = pendingRevoke === 'ok' || pendingRevoke === 'ok_already_revoked';
  if (provider && marked.tokens) {
    const r = await revokeAtProvider(provider, marked.tokens, now);
    remote = r.result;
    remoteCode = r.code;
  }
  return db.transaction(async (tx) => {
    const { account: acc, cred } = await lockAccountCredential(tx, input.ownerId, account.id);
    let row = cred;
    let outcome: RevokeOutcome;
    const ownOpCurrent = !!cred && cred.id === marked.credId && cred.revokeOpId === marked.opId;
    if (ownOpCurrent && cred!.revokedAt) {
      outcome = 'completed_by_other';
    } else if (ownOpCurrent && cred!.status === 'revoking' && cred!.tokenGeneration === marked.generation) {
      const updated = await tx
        .update(oauthCredentials)
        .set({
          encryptedToken: null,
          keyVersion: null,
          revokedAt: now,
          status: 'revoked',
          lastErrorCode: remoteCode,
          ...(cred!.pendingOpId !== null && cred!.pendingOpId === marked.pendingOpId
            ? pendingCleared
              ? { pendingOpId: null, pendingKind: null, pendingToken: null, pendingKeyVersion: null }
              : { pendingKind: 'cleanup_revoke' }
            : cred!.pendingOpId !== null
              ? { pendingKind: 'cleanup_revoke' }
              : {}),
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
      },
      at: now,
    });
    if (cleanupFailed(pendingRevoke as RemoteRevoke)) {
      await auditCleanupFailure(tx, { ownerId: input.ownerId, accountId: acc.id, context: 'revoke_pending', result: pendingRevoke as RemoteRevoke, code: pendingRevokeCode, pendingRecord: 'kept', now });
    }
    return { health: accountHealthView(acc, row, now), outcome, remoteRevoke: remote, revokedApprovals: marked.revokedApprovals };
  });
}

/**
 * 만료가 가까운(OAUTH_EXPIRING_SOON_MS 안, 아직 만료 전) 연결 정보를 갱신한다(worker tick). 실패는 기록만 하고 다음 계정으로.
 */
export async function refreshExpiringCredentials(
  db: Db,
  input: { providerFor: ProviderFor; keyring: KeyringSource; now?: Date; ownerId?: string; limit?: number },
): Promise<{ refreshed: number; failed: number; pendingResolved: number; pendingRemaining: number }> {
  const now = input.now ?? new Date();
  // FIX3-T13: 정리 대기 표시가 있는 연결 정보를 먼저 정리한다(만료·상태와 무관 — 해제된 행·자리 표시 행 포함).
  const pendingConds = [isNotNull(oauthCredentials.pendingOpId)];
  if (input.ownerId) pendingConds.push(eq(oauthCredentials.ownerId, input.ownerId));
  const pendingRows = await db
    .select({ ownerId: oauthCredentials.ownerId, accountId: oauthCredentials.channelAccountId })
    .from(oauthCredentials)
    .where(and(...pendingConds))
    .orderBy(asc(oauthCredentials.updatedAt))
    .limit(input.limit ?? 20);
  let pendingResolved = 0;
  let pendingRemaining = 0;
  for (const p of pendingRows) {
    const r = await reconcilePendingCredential(db, { ownerId: p.ownerId, accountId: p.accountId, providerFor: input.providerFor, keyring: input.keyring, now }).catch(
      () => 'still_pending' as const,
    );
    if (r === 'still_pending') pendingRemaining++;
    else pendingResolved++;
  }
  const conds = [
    eq(oauthCredentials.status, 'active'),
    isNull(oauthCredentials.revokedAt),
    isNull(oauthCredentials.pendingOpId),
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
  return { refreshed, failed, pendingResolved, pendingRemaining };
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
  const pendingIds = await db
    .select({ ownerId: oauthCredentials.ownerId, accountId: oauthCredentials.channelAccountId })
    .from(oauthCredentials)
    .where(isNotNull(oauthCredentials.pendingToken))
    .orderBy(asc(oauthCredentials.channelAccountId));
  for (const { ownerId, accountId } of pendingIds) {
    await db.transaction(async (tx) => {
      const { cred } = await lockAccountCredential(tx, ownerId, accountId);
      if (!cred?.pendingToken || cred.pendingKeyVersion === null) return;
      const c = report.pendingTokens;
      c.total++;
      const aad = pendingAad(ownerId, accountId);
      try {
        openSecret(keyring, cred.pendingToken, cred.pendingKeyVersion, aad);
      } catch (e) {
        fail(c, e);
        return;
      }
      if (cred.pendingKeyVersion === keyring.current.version) {
        c.alreadyCurrent++;
        return;
      }
      c.toReseal++;
      if (dryRun) return;
      const r = resealSecret(keyring, cred.pendingToken, cred.pendingKeyVersion, aad)!;
      const u = await tx
        .update(oauthCredentials)
        .set({ pendingToken: r.ciphertext, pendingKeyVersion: r.keyVersion, updatedAt: now })
        .where(and(eq(oauthCredentials.id, cred.id), eq(oauthCredentials.pendingToken, cred.pendingToken)))
        .returning({ id: oauthCredentials.id });
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
