/**
 * T21-P1b: OIDC 로그인 요청(auth_oidc_states) 저장·소비. 로그인 전 단계라 owner 가 없다.
 *
 * - 시작: 만료·사용된 행을 지우고, 진행 중인 행이 상한(OIDC_MAX_PENDING_STATES) 이상이면 가장 오래된 것부터 지운 뒤 넣는다
 *   (FIX-T21P1B: 전용 트랜잭션 advisory 잠금 OIDC_STATE_LOCK_KEY 아래에서 — 여러 연결이어도 상한을 지키도록. Postgres 다중 연결은 미검증, G2)
 *   (인증 없는 시작 경로가 표를 끝없이 키우지 못하게). PKCE verifier·nonce 는 봉인해 둔다(AAD = 이 행 ID + 용도 oidc_login_state).
 * - 소비(callback): state 해시로 행을 잠그고(for update) 한 번만 쓰이게 한다.
 *   · 없음 → unknown. · 브라우저 결합 해시가 다르면 → browser_mismatch(행은 **그대로** — state 를 본 다른 브라우저가 주인의 진행 중 요청을 태우지 못하게, T13 oauth_states 와 같은 규칙).
 *   · 이미 사용 → used. · 그 밖에는 used_at 을 기록하고(결과와 무관하게 1회용) 만료 → expired, 설정 지문이 다르면 → settings_changed, 아니면 ok.
 * - 값(state·결합 쿠키·verifier·nonce 원문)은 이 표에도 감사에도 남지 않는다(해시·봉인만).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  hashOAuthState,
  hashOidcBrowserBinding,
  identityMatches,
  OIDC_MAX_PENDING_STATES,
  OIDC_STATE_TTL_MS,
  openSecret,
  sealSecret,
  type SecretAad,
  type SecretKeyring,
} from '@cs/domain';
import type { Db } from './client';
import { authOidcStates } from './schema';

/** 봉인해 두는 값(callback 에서 라이브러리 검사에 넘긴다). */
export interface OidcPendingSecrets {
  codeVerifier: string;
  nonce: string;
}

/** FIX-T21P1B(P2 :54): 로그인 요청 생성(정리·개수·오래된 것 삭제·삽입)을 직렬화하는 트랜잭션 advisory 잠금 키. */
export const OIDC_STATE_LOCK_KEY = 'cs.auth.oidc_state';

const aad = (id: string): SecretAad => ({ ownerId: '', channelAccountId: '', purpose: 'oidc_login_state', scopeId: id });

export async function createOidcLoginState(
  db: Db,
  input: {
    state: string;
    browserToken: string;
    secrets: OidcPendingSecrets;
    settingsHash: string;
    keyring: SecretKeyring;
    now?: Date;
    maxPending?: number;
  },
): Promise<{ id: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const maxPending = input.maxPending ?? OIDC_MAX_PENDING_STATES;
  const id = randomUUID();
  const sealed = sealSecret(input.keyring, JSON.stringify({ v: input.secrets.codeVerifier, n: input.secrets.nonce }), aad(id));
  const expiresAt = new Date(now.getTime() + OIDC_STATE_TTL_MS);
  await db.transaction(async (tx) => {
    // FIX-T21P1B(P2): 정리·개수·삭제·삽입 전체를 직렬화 — Postgres READ COMMITTED 에서 99개일 때 두 생성이 함께 넣어 101개가 되지 않게
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${OIDC_STATE_LOCK_KEY}))`);
    await tx.delete(authOidcStates).where(or(lte(authOidcStates.expiresAt, now), isNotNull(authOidcStates.usedAt)));
    const [c] = await tx
      .select({ n: count() })
      .from(authOidcStates)
      .where(and(isNull(authOidcStates.usedAt), gt(authOidcStates.expiresAt, now)));
    const over = (c?.n ?? 0) - (maxPending - 1);
    if (over > 0) {
      const oldest = await tx.select({ id: authOidcStates.id }).from(authOidcStates).orderBy(asc(authOidcStates.createdAt), asc(authOidcStates.id)).limit(over);
      if (oldest.length) await tx.delete(authOidcStates).where(inArray(authOidcStates.id, oldest.map((r) => r.id)));
    }
    await tx.insert(authOidcStates).values({
      id,
      stateHash: hashOAuthState(input.state),
      browserHash: hashOidcBrowserBinding(input.browserToken),
      encryptedPayload: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      settingsHash: input.settingsHash,
      expiresAt,
      createdAt: now,
    });
  });
  return { id, expiresAt };
}

export type OidcStateConsumeResult =
  | { status: 'ok'; id: string; secrets: OidcPendingSecrets }
  | { status: 'unknown' | 'browser_mismatch' | 'used' | 'expired' | 'settings_changed' | 'unreadable' };

/**
 * callback 의 state 소비(위 머리 주석의 규칙). browserToken = 요청의 결합 쿠키 값(없으면 null → browser_mismatch).
 * 봉인을 열지 못하면(키 교체 등) unreadable — 이미 사용 처리됨.
 */
export async function consumeOidcLoginState(
  db: Db,
  input: { state: string; browserToken: string | null; settingsHash: string; keyring: SecretKeyring; now?: Date },
): Promise<OidcStateConsumeResult> {
  const now = input.now ?? new Date();
  const row = await db.transaction(async (tx) => {
    const rows = await tx.select().from(authOidcStates).where(eq(authOidcStates.stateHash, hashOAuthState(input.state))).for('update').limit(1);
    const r = rows[0];
    if (!r) return { status: 'unknown' as const };
    if (input.browserToken === null || !identityMatches(hashOidcBrowserBinding(input.browserToken), r.browserHash)) return { status: 'browser_mismatch' as const };
    if (r.usedAt) return { status: 'used' as const };
    await tx.update(authOidcStates).set({ usedAt: now }).where(eq(authOidcStates.id, r.id));
    if (r.expiresAt.getTime() <= now.getTime()) return { status: 'expired' as const };
    if (r.settingsHash !== input.settingsHash) return { status: 'settings_changed' as const };
    return { status: 'row' as const, row: r };
  });
  if (row.status !== 'row') return row;
  try {
    const parsed = JSON.parse(openSecret(input.keyring, row.row.encryptedPayload, row.row.keyVersion, aad(row.row.id))) as { v?: unknown; n?: unknown };
    if (typeof parsed.v !== 'string' || typeof parsed.n !== 'string') return { status: 'unreadable' };
    return { status: 'ok', id: row.row.id, secrets: { codeVerifier: parsed.v, nonce: parsed.n } };
  } catch {
    return { status: 'unreadable' };
  }
}
