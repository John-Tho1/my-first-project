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
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import {
  codeChallengeS256,
  CREDENTIAL_STATUS_LABEL,
  CREDENTIAL_STATUSES,
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
      ? { status: cred.status, expiresAt: cred.expiresAt, scopes: cred.scopes, revokedAt: cred.revokedAt, lastErrorCode: cred.lastErrorCode }
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
    await tx
      .delete(oauthStates)
      .where(and(eq(oauthStates.ownerId, input.ownerId), or(lte(oauthStates.expiresAt, now), isNotNull(oauthStates.usedAt))));
    await tx.insert(oauthStates).values({
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
 * callback: state 확인(형식 → 이 owner 의 행 → 사용 여부) 뒤 **먼저 사용 처리**(한 번만) → 세션·만료·redirect URI·공급자 거부 확인 →
 * verifier 로 code 교환(PKCE) → 공급자의 계정 = 이 계정인지 확인 → 봉인 저장 + credential_state='linked'.
 * 실패해도 state 는 다시 쓸 수 없다. 오류 응답·감사에는 코드만.
 */
export async function completeOAuthCallback(db: Db, input: CallbackInput): Promise<AccountHealthView> {
  const now = input.now ?? new Date();
  const { ownerId } = input;
  const state = input.query.state;
  if (!isWellFormedOAuthState(state)) {
    await rejectCallback(db, ownerId, null, 'oauth_state_invalid', now);
    throw new OAuthFlowError('oauth_state_invalid');
  }
  const checked = await db.transaction(async (tx): Promise<{ fail: OAuthFlowErrorCode; accountId: string | null } | { row: OAuthStateRow }> => {
    const rows = await tx
      .select()
      .from(oauthStates)
      .where(and(eq(oauthStates.stateHash, hashOAuthState(state)), eq(oauthStates.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const row = rows[0];
    if (!row) return { fail: 'oauth_state_invalid', accountId: null };
    if (row.usedAt) return { fail: 'oauth_state_used', accountId: row.channelAccountId };
    await tx.update(oauthStates).set({ usedAt: now }).where(eq(oauthStates.id, row.id));
    if (row.sessionId !== input.sessionId) return { fail: 'oauth_state_invalid', accountId: row.channelAccountId };
    if (row.expiresAt.getTime() <= now.getTime()) return { fail: 'oauth_state_expired', accountId: row.channelAccountId };
    if (input.requestTarget !== row.redirectUri || row.redirectUri !== input.redirectUri) return { fail: 'oauth_redirect_mismatch', accountId: row.channelAccountId };
    if (input.query.error) return { fail: 'oauth_denied', accountId: row.channelAccountId };
    if (!input.query.code) return { fail: 'oauth_bad_request', accountId: row.channelAccountId };
    return { row };
  });
  if ('fail' in checked) {
    await rejectCallback(db, ownerId, checked.accountId, checked.fail, now);
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
  let info;
  try {
    info = await provider.accountInfo({ accessToken: tokens.accessToken, now });
  } catch (e) {
    const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
    await rejectCallback(db, ownerId, account.id, 'account_info_failed', now, { provider_error: code });
    throw new OAuthFlowError('oauth_exchange_failed', { reason: code });
  }
  if (info.externalAccountId !== account.externalAccountId) {
    // 정체가 다른 계정 — 저장하지 않고 받은 토큰은 공급자에서 바로 철회(실패해도 저장하지 않음)
    await provider.revoke({ tokens: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }, now }).catch(() => undefined);
    await rejectCallback(db, ownerId, account.id, 'account_mismatch', now);
    throw new OAuthAccountMismatchError();
  }
  const sealed = sealSecret(keyring, encodeTokens(tokens), tokenAad(ownerId, account.id));
  return db.transaction(async (tx) => {
    const acc = await ownedAccount(tx, ownerId, account.id, 'update');
    const existing = await credentialOf(tx, ownerId, acc.id);
    const values = {
      encryptedToken: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      expiresAt: tokens.expiresAt,
      scopes: [...tokens.scopes],
      status: 'active',
      connectedAt: now,
      lastCheckedAt: now,
      lastRefreshedAt: null,
      lastErrorCode: null,
      revokedAt: null,
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
}

// ---- 갱신·확인·해제 ----

interface Opened {
  account: AccountRow;
  cred: OAuthCredentialRow;
  provider: OAuthProvider;
  tokens: StoredOAuthTokens;
}

async function openCredential(db: Db, ownerId: string, accountId: string, providerFor: ProviderFor, keyring: KeyringSource, now: Date): Promise<Opened> {
  const account = await ownedAccount(db, ownerId, accountId);
  const cred = await credentialOf(db, ownerId, account.id);
  if (!cred || cred.revokedAt || !cred.encryptedToken || cred.keyVersion === null) throw new CredentialNotFoundError();
  const provider = providerFor(account);
  const ring = keyring();
  try {
    const tokens = decodeTokens(openSecret(ring, cred.encryptedToken, cred.keyVersion, tokenAad(ownerId, account.id)));
    return { account, cred, provider, tokens };
  } catch (e) {
    if (e instanceof SecretDecryptError) {
      await db
        .update(oauthCredentials)
        .set({ status: 'error', lastErrorCode: `decrypt_${e.problem}`, updatedAt: now })
        .where(and(eq(oauthCredentials.id, cred.id), isNull(oauthCredentials.revokedAt)));
    }
    throw e;
  }
}

/** 공급자 오류 → 저장할 상태. 만료는 상태를 바꾸지 않는다(health 가 expired 로 판정). 철회·무효 토큰은 error. */
function providerFailureStatus(code: string): 'active' | 'error' {
  return code === 'token_revoked' || code === 'invalid_token' || code === 'invalid_grant' ? 'error' : 'active';
}

/**
 * 연결 정보 갱신(만료 전). 성공 → 새 토큰 봉인(현재 키 버전) + 만료 시각. 실패 → 오류 코드 기록 후 409 credential_refresh_failed.
 * 다시 연결과 같은 계정이므로 승인은 그대로 둔다.
 */
export async function refreshCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date; trigger?: 'manual' | 'auto' },
): Promise<AccountHealthView> {
  const now = input.now ?? new Date();
  const o = await openCredential(db, input.ownerId, input.accountId, input.providerFor, input.keyring, now);
  let tokens: OAuthTokenSet;
  try {
    // 저장된 만료 시각이 지났으면 공급자에 묻지 않는다(Threads 장기 토큰은 만료 뒤 갱신 불가 — 다시 연결)
    if (!o.cred.expiresAt || o.cred.expiresAt.getTime() <= now.getTime()) throw new OAuthProviderError('token_expired');
    tokens = await o.provider.refresh({ tokens: o.tokens, now });
  } catch (e) {
    const code = e instanceof OAuthProviderError ? e.code : 'provider_error';
    await db.transaction(async (tx) => {
      await tx
        .update(oauthCredentials)
        .set({ status: providerFailureStatus(code), lastErrorCode: code, updatedAt: now })
        .where(and(eq(oauthCredentials.id, o.cred.id), eq(oauthCredentials.encryptedToken, o.cred.encryptedToken!)));
      await recordAudit(tx, {
        ownerId: input.ownerId,
        action: 'oauth.refresh_failed',
        entity: 'channel_account',
        entityId: o.account.id,
        details: { provider: o.provider.id, mock: o.provider.mock, error_code: code, trigger: input.trigger ?? 'manual' },
        at: now,
      });
    });
    throw new CredentialRefreshFailedError(code);
  }
  const sealed = sealSecret(input.keyring(), encodeTokens(tokens), tokenAad(input.ownerId, o.account.id));
  return db.transaction(async (tx) => {
    // 그 사이 다시 연결·해제됐으면(암호문이 바뀜) 덮어쓰지 않는다.
    const updated = await tx
      .update(oauthCredentials)
      .set({
        encryptedToken: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        expiresAt: tokens.expiresAt,
        scopes: [...tokens.scopes],
        status: 'active',
        lastRefreshedAt: now,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(and(eq(oauthCredentials.id, o.cred.id), eq(oauthCredentials.encryptedToken, o.cred.encryptedToken!)))
      .returning();
    if (!updated[0]) throw new CredentialRefreshFailedError('credential_changed');
    await recordAudit(tx, {
      ownerId: input.ownerId,
      action: 'oauth.refreshed',
      entity: 'channel_account',
      entityId: o.account.id,
      details: { provider: o.provider.id, mock: o.provider.mock, expires_at: tokens.expiresAt.toISOString(), key_version: sealed.keyVersion, trigger: input.trigger ?? 'manual' },
      at: now,
    });
    return accountHealthView(o.account, updated[0], now);
  });
}

/** 연결 확인: 공급자에 계정 정보를 물어 last_checked_at 을 남긴다. 다른 계정이면 error(account_mismatch). */
export async function checkCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date },
): Promise<AccountHealthView> {
  const now = input.now ?? new Date();
  const o = await openCredential(db, input.ownerId, input.accountId, input.providerFor, input.keyring, now);
  let status: 'active' | 'error' = o.cred.status === 'error' ? 'error' : 'active';
  let errorCode: string | null = null;
  try {
    const info = await o.provider.accountInfo({ accessToken: o.tokens.accessToken, now });
    if (info.externalAccountId !== o.account.externalAccountId) {
      status = 'error';
      errorCode = 'account_mismatch';
    } else {
      status = 'active';
    }
  } catch (e) {
    errorCode = e instanceof OAuthProviderError ? e.code : 'provider_error';
    if (providerFailureStatus(errorCode) === 'error') status = 'error';
  }
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(oauthCredentials)
      .set({ status, lastErrorCode: errorCode, lastCheckedAt: now, updatedAt: now })
      .where(and(eq(oauthCredentials.id, o.cred.id), isNull(oauthCredentials.revokedAt)))
      .returning();
    await recordAudit(tx, {
      ownerId: input.ownerId,
      action: 'oauth.checked',
      entity: 'channel_account',
      entityId: o.account.id,
      details: { provider: o.provider.id, mock: o.provider.mock, result: errorCode ?? 'ok' },
      at: now,
    });
    return accountHealthView(o.account, updated[0] ?? (await credentialOf(tx, input.ownerId, o.account.id)), now);
  });
}

export interface RevokeResult {
  health: AccountHealthView;
  remoteRevoke: 'ok' | 'failed' | 'skipped_no_key' | 'skipped_unreadable' | 'skipped_unsupported' | 'already_revoked';
  revokedApprovals: number;
}

/**
 * 연결 해제: 공급자 철회(가능하면 — 키가 없거나 읽을 수 없거나 공급자 오류여도 로컬 삭제는 한다) → 암호문·키 버전 삭제, revoked_at·status='revoked'.
 * credential_state 는 linked 그대로 — 다시 연결하기 전까지 이 계정 실행은 차단된다. 같은 트랜잭션에서 그 계정을 쓰는 활성 승인을 철회(account_changed).
 */
export async function revokeCredential(
  db: Db,
  input: { ownerId: string; accountId: string; providerFor: ProviderFor; keyring: KeyringSource; now?: Date },
): Promise<RevokeResult> {
  const now = input.now ?? new Date();
  const account = await ownedAccount(db, input.ownerId, input.accountId);
  const cred = await credentialOf(db, input.ownerId, account.id);
  if (!cred) throw new CredentialNotFoundError();
  if (cred.revokedAt) return { health: accountHealthView(account, cred, now), remoteRevoke: 'already_revoked', revokedApprovals: 0 };
  let remote: RevokeResult['remoteRevoke'] = 'ok';
  let remoteCode: string | null = null;
  let provider: OAuthProvider | null = null;
  try {
    provider = input.providerFor(account);
  } catch {
    remote = 'skipped_unsupported';
  }
  if (provider) {
    let tokens: StoredOAuthTokens | null = null;
    try {
      const ring = input.keyring();
      tokens = decodeTokens(openSecret(ring, cred.encryptedToken!, cred.keyVersion!, tokenAad(input.ownerId, account.id)));
    } catch (e) {
      remote = e instanceof SecretDecryptError ? 'skipped_unreadable' : 'skipped_no_key';
    }
    if (tokens) {
      try {
        await provider.revoke({ tokens, now });
      } catch (e) {
        remote = 'failed';
        remoteCode = e instanceof OAuthProviderError ? e.code : 'provider_error';
      }
    }
  }
  return db.transaction(async (tx) => {
    const acc = await ownedAccount(tx, input.ownerId, account.id, 'update');
    const updated = await tx
      .update(oauthCredentials)
      .set({ encryptedToken: null, keyVersion: null, revokedAt: now, status: 'revoked', lastErrorCode: remoteCode, updatedAt: now })
      .where(and(eq(oauthCredentials.id, cred.id), isNull(oauthCredentials.revokedAt)))
      .returning();
    const row = updated[0] ?? (await credentialOf(tx, input.ownerId, acc.id))!;
    const revoked = updated[0] ? await invalidateApprovalsForAccount(tx, input.ownerId, acc.id, now) : [];
    await recordAudit(tx, {
      ownerId: input.ownerId,
      action: 'oauth.revoked',
      entity: 'channel_account',
      entityId: acc.id,
      details: { provider: cred.provider, mock: cred.isMock, remote_revoke: remote, remote_error: remoteCode, revoked_approvals: revoked.length },
      at: now,
    });
    return { health: accountHealthView(acc, row, now), remoteRevoke: remote, revokedApprovals: revoked.length };
  });
}

/**
 * 만료가 가까운(OAUTH_EXPIRING_SOON_MS 안, 아직 만료 전) 연결 정보를 갱신한다(worker tick). 실패는 기록만 하고 다음 계정으로.
 */
export async function refreshExpiringCredentials(
  db: Db,
  input: { providerFor: ProviderFor; keyring: KeyringSource; now?: Date; ownerId?: string; limit?: number },
): Promise<{ refreshed: number; failed: number }> {
  const now = input.now ?? new Date();
  const conds = [
    eq(oauthCredentials.status, 'active'),
    isNull(oauthCredentials.revokedAt),
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
  return { refreshed, failed };
}

/**
 * 키 교체: 현재 키 버전이 아닌 봉인(연결 정보·아직 유효한 연결 요청)을 이전 키로 열어 현재 키로 다시 봉인한다.
 * 이전 키가 없어 열 수 없는 행은 failed 로 세고 그대로 둔다(그 계정은 다시 연결 필요 — health 에서 decrypt 오류로 보임).
 */
export async function rotateSecretKeys(db: Db, keyring: SecretKeyring, now: Date = new Date()): Promise<{ resealed: number; failed: number }> {
  let resealed = 0;
  let failed = 0;
  const creds = await db
    .select()
    .from(oauthCredentials)
    .where(and(isNotNull(oauthCredentials.encryptedToken), ne(oauthCredentials.keyVersion, keyring.current.version)));
  for (const c of creds) {
    try {
      const r = resealSecret(keyring, c.encryptedToken!, c.keyVersion!, tokenAad(c.ownerId, c.channelAccountId));
      if (!r) continue;
      const u = await db
        .update(oauthCredentials)
        .set({ encryptedToken: r.ciphertext, keyVersion: r.keyVersion, updatedAt: now })
        .where(and(eq(oauthCredentials.id, c.id), eq(oauthCredentials.encryptedToken, c.encryptedToken!)))
        .returning({ id: oauthCredentials.id });
      if (u.length) resealed++;
    } catch {
      failed++;
    }
  }
  const states = await db
    .select()
    .from(oauthStates)
    .where(and(isNull(oauthStates.usedAt), gt(oauthStates.expiresAt, now), ne(oauthStates.keyVersion, keyring.current.version)));
  for (const s of states) {
    try {
      const r = resealSecret(keyring, s.encryptedVerifier, s.keyVersion, verifierAad(s.ownerId, s.channelAccountId, s.id));
      if (!r) continue;
      await db.update(oauthStates).set({ encryptedVerifier: r.ciphertext, keyVersion: r.keyVersion }).where(eq(oauthStates.id, s.id));
      resealed++;
    } catch {
      failed++;
    }
  }
  if (resealed || failed) {
    const owners = new Set([...creds.map((c) => c.ownerId), ...states.map((s) => s.ownerId)]);
    for (const ownerId of owners) {
      await recordAudit(db, {
        ownerId,
        action: 'oauth.key_rotated',
        entity: 'secrets',
        details: { key_version: keyring.current.version, resealed, failed },
        at: now,
      });
    }
  }
  return { resealed, failed };
}
