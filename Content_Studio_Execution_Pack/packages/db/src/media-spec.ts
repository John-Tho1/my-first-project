/**
 * T15(D27) 미디어 창구 + T16(제안 결정 D29) Instagram 잠정 규격 검사(승인 전 — approval blocker).
 *
 * - mediaPortFor: 승인 스냅샷의 첨부(id·checksum·mime)와 같은 owner 의 **VERIFIED·지워지지 않은** asset 만 연다(짧은 조회 하나 + 저장소 범위 읽기).
 *   T15 에서 jobs.ts 에 있던 것을 그대로 옮겼다(작업 처리기·승인·계획 화면이 같은 창구를 쓴다 — jobs.ts 는 다시 내보낸다).
 * - instagramApprovalSpecProblems: Instagram 모의 연결 계정(adapterIdFor = mock_instagram) 항목만 규격을 본다. 파일은 앞부분(헤더)만 읽는다.
 *   읽기 창구가 없으면 `media_spec:unchecked`(fail closed — 확인하지 못한 규격으로 승인하지 않는다). DB 트랜잭션 **밖**에서 부른다(파일 읽기).
 *   seed Instagram 계정(연결 없음 → mock_generic)은 M3 동작 그대로(검사 없음).
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  adapterIdFor,
  instagramSnapshotSpecProblems,
  isUuid,
  type CanonicalPayload,
  type MediaPort,
  type MediaReader,
} from '@cs/domain';
import type { DbOrTx } from './queries';
import { assets, channelAccounts, distributionItems } from './schema';

export function mediaPortFor(db: DbOrTx, ownerId: string, reader: MediaReader | undefined): MediaPort {
  return {
    open: async (want) => {
      if (!reader) return { ok: false, code: 'media_reader_unavailable' };
      if (!isUuid(want.id)) return { ok: false, code: 'media_not_found' };
      const rows = await db
        .select({ key: assets.key, mime: assets.mime, bytes: assets.bytes, checksum: assets.checksum, state: assets.verificationState, deletedAt: assets.deletedAt })
        .from(assets)
        .where(and(eq(assets.id, want.id), eq(assets.ownerId, ownerId)))
        .limit(1);
      const a = rows[0];
      if (!a) return { ok: false, code: 'media_not_found' };
      if (a.deletedAt) return { ok: false, code: 'media_deleted' };
      if (a.state !== 'VERIFIED') return { ok: false, code: 'media_not_verified' };
      if (a.checksum !== want.checksum || a.mime !== want.mime) return { ok: false, code: 'media_changed' };
      const key = a.key;
      const size = Number(a.bytes);
      return {
        ok: true,
        file: {
          bytes: size,
          mime: a.mime,
          checksum: a.checksum,
          read: async (start: number, end: number) => {
            if (!(start >= 0 && end > start && end <= size)) throw new RangeError('media read out of range');
            const out = await reader.readRange(key, start, end);
            if (out.byteLength !== end - start) throw new Error('media short read');
            return out;
          },
        },
      };
    },
  };
}

/** 승인 스냅샷 하나의 Instagram 잠정 규격 문제(`media_spec:<코드>` — 없으면 []). */
export async function instagramPayloadSpecProblems(db: DbOrTx, ownerId: string, payload: CanonicalPayload, reader: MediaReader | undefined): Promise<string[]> {
  if (!reader) return ['media_spec:unchecked'];
  const caption = typeof payload.text?.caption === 'string' ? payload.text.caption : '';
  const list = Array.isArray(payload.assets) ? payload.assets : [];
  return instagramSnapshotSpecProblems(mediaPortFor(db, ownerId, reader), { caption, assets: list });
}

/**
 * 항목들 중 Instagram 모의 연결 계정 항목의 규격 문제(항목 ID → 문제 목록, 문제 없는 항목은 빠진다). 트랜잭션 밖에서 부른다.
 * 항목의 payload 는 불변 스냅샷이고, 계정이 그 사이 바뀌면 snapshotProblems(account_changed)가 따로 막는다.
 */
export async function instagramSpecProblemsForItems(db: DbOrTx, ownerId: string, itemIds: readonly string[], reader: MediaReader | undefined): Promise<Map<string, string[]>> {
  return (await instagramSpecCheckForItems(db, ownerId, itemIds, reader)).problems;
}

/**
 * FIX-T16(Codex Q5): 검사 결과 + **검사한 것**(`항목 ID:payload hash` — Instagram 모의 연결 계정으로 판단해 규격을 본 항목). 승인 트랜잭션은
 * 이것으로 "검사 통과"와 "검사 대상에서 빠짐"을 구분한다(instagramUncheckedInTx).
 */
export async function instagramSpecCheckForItems(
  db: DbOrTx,
  ownerId: string,
  itemIds: readonly string[],
  reader: MediaReader | undefined,
): Promise<{ problems: Map<string, string[]>; checked: Set<string> }> {
  const problems = new Map<string, string[]>();
  const checked = new Set<string>();
  const ids = itemIds.filter((id) => isUuid(id));
  if (ids.length === 0) return { problems, checked };
  const rows = await db
    .select({
      id: distributionItems.id,
      payload: distributionItems.payloadJson,
      payloadHash: distributionItems.payloadHash,
      kind: channelAccounts.kind,
      platform: channelAccounts.platform,
      credentialState: channelAccounts.credentialState,
    })
    .from(distributionItems)
    .innerJoin(channelAccounts, and(eq(channelAccounts.id, distributionItems.channelAccountId), eq(channelAccounts.ownerId, distributionItems.ownerId)))
    .where(and(eq(distributionItems.ownerId, ownerId), inArray(distributionItems.id, [...ids])));
  for (const r of rows) {
    if (adapterIdFor({ kind: r.kind === 'mock' ? 'mock' : 'live', platform: r.platform, credential_state: r.credentialState }) !== 'mock_instagram') continue;
    const p = await instagramPayloadSpecProblems(db, ownerId, r.payload as unknown as CanonicalPayload, reader);
    checked.add(`${r.id}:${r.payloadHash}`);
    if (p.length) problems.set(r.id, p);
  }
  return { problems, checked };
}

/**
 * FIX-T16(Codex 놓친 케이스): 승인 트랜잭션 안(계정 FOR SHARE 잠금 뒤)에서 부른다. 지금 계정 상태로 Instagram 모의 연결(mock_instagram)인데
 * 트랜잭션 밖 검사가 그 항목·payload hash 를 보지 않았으면(그 사이 연결·hash 가 바뀜) `media_spec:unchecked`(fail closed).
 */
export async function instagramUncheckedInTx(
  tx: DbOrTx,
  ownerId: string,
  items: ReadonlyArray<{ id: string; channelAccountId: string; payloadHash: string }>,
  checked: ReadonlySet<string>,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const accIds = [...new Set(items.map((i) => i.channelAccountId))].filter((id) => isUuid(id));
  if (accIds.length === 0) return out;
  const accs = await tx
    .select({ id: channelAccounts.id, kind: channelAccounts.kind, platform: channelAccounts.platform, credentialState: channelAccounts.credentialState })
    .from(channelAccounts)
    .where(and(eq(channelAccounts.ownerId, ownerId), inArray(channelAccounts.id, accIds)));
  const byId = new Map(accs.map((a) => [a.id, a]));
  for (const it of items) {
    const a = byId.get(it.channelAccountId);
    if (!a) continue;
    if (adapterIdFor({ kind: a.kind === 'mock' ? 'mock' : 'live', platform: a.platform, credential_state: a.credentialState }) !== 'mock_instagram') continue;
    if (!checked.has(`${it.id}:${it.payloadHash}`)) out.set(it.id, ['media_spec:unchecked']);
  }
  return out;
}
