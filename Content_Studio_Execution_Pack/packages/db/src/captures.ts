/**
 * 수집(capture) 쿼리(T03). 모든 함수는 ownerId 를 받아 WHERE 에 넣는다(A01).
 *
 * 불변식
 * - raw_text 는 insert 때만 쓴다. updateCapture 는 user_note/title/risk 만 바꾼다(A02 "원문 손실 없음").
 * - 수정은 `UPDATE … WHERE id AND owner_id AND revision = expected` 한 문장(낙관적 잠금). 0행이면 409 또는 404.
 * - command_key 멱등: 같은 (owner, command_key) 는 한 행. 재요청은 기존 행을 created:false 로 돌려주고
 *   source upsert·revision·audit 같은 부수 효과를 다시 만들지 않는다.
 */
import { and, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import {
  ConflictError,
  contentHash,
  findSimilar,
  isUuid,
  normalizeUrl,
  NotFoundError,
  type CaptureCreateInput,
  type Risk,
  type SimilarMatch,
} from '@cs/domain';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { captureRevisions, captures, sources, sourceVersions } from './schema';

export type CaptureRow = typeof captures.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type CaptureRevisionRow = typeof captureRevisions.$inferSelect;
export type SourceVersionRow = typeof sourceVersions.$inferSelect;

export interface CreateCaptureResult {
  capture: CaptureRow;
  source: SourceRow | null;
  created: boolean;
}

/** 트랜잭션 안에서 command_key 충돌을 만나면 되돌리기 위한 내부 신호. */
class IdempotentReplay extends Error {}

async function findByCommandKey(db: DbOrTx, ownerId: string, commandKey: string): Promise<CaptureRow | null> {
  const rows = await db
    .select()
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), eq(captures.commandKey, commandKey)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSourceById(db: DbOrTx, ownerId: string, id: string | null): Promise<SourceRow | null> {
  if (!id) return null;
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, id), eq(sources.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/** (owner, normalized_url) 로 url source 를 하나만 만든다. 이미 있으면 그 행. */
export async function upsertUrlSource(
  db: DbOrTx,
  ownerId: string,
  url: { canonical: string; normalized: string },
): Promise<SourceRow> {
  await db
    .insert(sources)
    .values({ ownerId, kind: 'url', canonicalUrl: url.canonical, normalizedUrl: url.normalized })
    .onConflictDoNothing({
      target: [sources.ownerId, sources.normalizedUrl],
      where: sql`${sources.normalizedUrl} is not null`,
    });
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.ownerId, ownerId), eq(sources.normalizedUrl, url.normalized)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('source upsert 실패');
  return row;
}

/**
 * URL 수집의 원문: 사용자가 입력한 URL 문자열 그대로(+ 줄바꿈 + 사용자가 쓴 말). seed 와 같은 형식.
 * 텍스트 수집의 원문: 입력 그대로(앞뒤 공백도 보존). 해시·유사도만 정규화한다.
 */
export function buildRawText(input: CaptureCreateInput): string {
  if (input.input_type === 'url') {
    const url = input.url!.trim();
    return input.raw_text && input.raw_text.trim() !== '' ? `${url}\n${input.raw_text}` : url;
  }
  return input.raw_text!;
}

const emptyToNull = (v: string | null | undefined) => (v === undefined || v === null || v === '' ? null : v);

/**
 * 수집 저장. URL 이면 normalizeUrl 로 검사(InvalidUrlError 400)하고 source 를 upsert 해 연결한다.
 * 내부망 URL 도 저장은 한다(A05: 추출만 막고 메모는 보존). audit capture.create 는 같은 트랜잭션에 남긴다.
 */
export async function createCapture(db: Db, ownerId: string, input: CaptureCreateInput): Promise<CreateCaptureResult> {
  const url = input.input_type === 'url' ? normalizeUrl(input.url!) : null;
  const replay = async (): Promise<CreateCaptureResult | null> => {
    const existing = await findByCommandKey(db, ownerId, input.command_key);
    if (!existing) return null;
    return { capture: existing, source: await getSourceById(db, ownerId, existing.sourceId), created: false };
  };

  const early = await replay();
  if (early) return early;

  const rawText = buildRawText(input);
  const hash = contentHash(rawText);
  try {
    return await db.transaction(async (tx) => {
      const source = url ? await upsertUrlSource(tx, ownerId, url) : null;
      const rows = await tx
        .insert(captures)
        .values({
          ownerId,
          rawText,
          inputType: input.input_type,
          sourceId: source?.id ?? null,
          userNote: emptyToNull(input.user_note),
          title: emptyToNull(input.title),
          commandKey: input.command_key,
          contentHash: hash,
        })
        .onConflictDoNothing({ target: [captures.ownerId, captures.commandKey] })
        .returning();
      const capture = rows[0];
      if (!capture) throw new IdempotentReplay(); // 동시에 같은 command_key 가 먼저 저장됨 → 이 트랜잭션은 되돌린다
      await tx.insert(captureRevisions).values({
        captureId: capture.id,
        ownerId,
        revision: capture.revision,
        userNote: capture.userNote,
        risk: capture.risk,
        title: capture.title,
        changedAt: capture.updatedAt,
        changedBy: 'owner',
      });
      await recordAudit(tx, {
        ownerId,
        action: 'capture.create',
        entity: 'capture',
        entityId: capture.id,
        versionOrHash: hash,
        // URL·원문·메모는 기록하지 않는다(비공개 raw URL 을 로그에 남기지 않음, docs/02).
        details: { input_type: capture.inputType, has_source: source !== null },
      });
      return { capture, source, created: true };
    });
  } catch (e) {
    if (e instanceof IdempotentReplay) {
      const r = await replay();
      if (r) return r;
    }
    throw e;
  }
}

export interface CapturePatch {
  user_note?: string | null;
  title?: string | null;
  risk?: Risk;
}

export function captureCurrentView(c: CaptureRow) {
  return {
    revision: c.revision,
    user_note: c.userNote,
    title: c.title,
    risk: c.risk,
    updated_at: c.updatedAt.toISOString(),
  };
}

/**
 * 낙관적 잠금 수정. 성공하면 새 revision 을 capture_revisions 에 남기고 audit capture.update.
 * - 다른 owner·없는 ID → NotFoundError(404)
 * - revision 불일치 → ConflictError(409) { current, yours } — 서버 값과 제출 값을 모두 돌려준다.
 */
export async function updateCapture(
  db: Db,
  ownerId: string,
  id: string,
  patch: CapturePatch,
  expectedRevision: number,
  now: Date = new Date(),
): Promise<CaptureRow> {
  if (!isUuid(id)) throw new NotFoundError();
  return db.transaction(async (tx) => {
    // 0002 이전(또는 seed) 행은 revision 1 이력이 없을 수 있다 → 덮어쓰기 전 값을 먼저 보존(이미 있으면 무시).
    await tx.execute(sql`
      insert into capture_revisions (capture_id, owner_id, revision, user_note, risk, title, changed_at, changed_by)
      select id, owner_id, revision, user_note, risk, title, updated_at, 'system'
        from captures
       where id = ${id} and owner_id = ${ownerId} and revision = ${expectedRevision}
      on conflict (capture_id, revision) do nothing`);

    const set: PgUpdateSetSource<typeof captures> = {
      revision: sql`${captures.revision} + 1`,
      updatedAt: now,
    };
    if (patch.user_note !== undefined) set.userNote = emptyToNull(patch.user_note);
    if (patch.title !== undefined) set.title = emptyToNull(patch.title);
    if (patch.risk !== undefined) set.risk = patch.risk;

    const rows = await tx
      .update(captures)
      .set(set)
      .where(and(eq(captures.id, id), eq(captures.ownerId, ownerId), eq(captures.revision, expectedRevision)))
      .returning();
    const updated = rows[0];
    if (!updated) {
      const current = await getCaptureRow(tx, ownerId, id);
      if (!current) throw new NotFoundError();
      throw new ConflictError({
        current: captureCurrentView(current),
        yours: { expected_revision: expectedRevision, ...patch },
      });
    }
    await tx.insert(captureRevisions).values({
      captureId: updated.id,
      ownerId,
      revision: updated.revision,
      userNote: updated.userNote,
      risk: updated.risk,
      title: updated.title,
      changedAt: now,
      changedBy: 'owner',
    });
    await recordAudit(tx, {
      ownerId,
      action: 'capture.update',
      entity: 'capture',
      entityId: updated.id,
      versionOrHash: String(updated.revision),
      details: {
        revision: updated.revision,
        fields: Object.keys(patch)
          .filter((k) => patch[k as keyof CapturePatch] !== undefined)
          .sort()
          .join(','),
      },
      at: now,
    });
    return updated;
  });
}

async function getCaptureRow(db: DbOrTx, ownerId: string, id: string): Promise<CaptureRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(captures)
    .where(and(eq(captures.id, id), eq(captures.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---- 중복 후보 ----

export interface ExactDuplicate {
  id: string;
  reason: 'url' | 'content';
}

/** 정확 중복: 같은 정규화 URL(source) 또는 같은 content_hash. 한 capture 는 한 번만(url 우선). null 은 무시. */
export async function findExactDuplicates(
  db: DbOrTx,
  ownerId: string,
  keys: { contentHash: string | null; normalizedUrl: string | null },
  excludeId?: string,
  limit = 50,
): Promise<ExactDuplicate[]> {
  const out: ExactDuplicate[] = [];
  const seen = new Set<string>();
  if (excludeId) seen.add(excludeId);
  if (keys.normalizedUrl) {
    const rows = await db
      .select({ id: captures.id })
      .from(captures)
      .innerJoin(sources, and(eq(sources.id, captures.sourceId), eq(sources.ownerId, captures.ownerId)))
      .where(
        and(
          eq(captures.ownerId, ownerId),
          eq(sources.normalizedUrl, keys.normalizedUrl),
          excludeId ? ne(captures.id, excludeId) : undefined,
        ),
      )
      .orderBy(desc(captures.receivedAt), desc(captures.id))
      .limit(limit);
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, reason: 'url' });
    }
  }
  if (keys.contentHash) {
    const rows = await db
      .select({ id: captures.id })
      .from(captures)
      .where(
        and(
          eq(captures.ownerId, ownerId),
          eq(captures.contentHash, keys.contentHash),
          excludeId ? ne(captures.id, excludeId) : undefined,
        ),
      )
      .orderBy(desc(captures.receivedAt), desc(captures.id))
      .limit(limit);
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, reason: 'content' });
    }
  }
  return out;
}

export async function listRecentCapturesForSimilarity(
  db: DbOrTx,
  ownerId: string,
  limit = 200,
  excludeId?: string,
): Promise<Array<{ id: string; rawText: string }>> {
  return db
    .select({ id: captures.id, rawText: captures.rawText })
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), excludeId ? ne(captures.id, excludeId) : undefined))
    .orderBy(desc(captures.receivedAt), desc(captures.id))
    .limit(limit);
}

export interface CaptureDuplicates {
  exact: ExactDuplicate[];
  similar: SimilarMatch[];
}

/** 정확 중복 + (정확 중복이 아닌) 유사 후보(최근 200건, 상위 10건). 자동 병합·삭제하지 않는다. */
export async function computeDuplicates(
  db: DbOrTx,
  ownerId: string,
  capture: CaptureRow,
  source: SourceRow | null,
): Promise<CaptureDuplicates> {
  const exact = await findExactDuplicates(
    db,
    ownerId,
    { contentHash: capture.contentHash, normalizedUrl: source?.normalizedUrl ?? null },
    capture.id,
  );
  const exactIds = new Set(exact.map((d) => d.id));
  const recent = await listRecentCapturesForSimilarity(db, ownerId, 200, capture.id);
  const similar = findSimilar(
    recent.filter((r) => !exactIds.has(r.id)).map((r) => ({ id: r.id, text: r.rawText })),
    capture.rawText,
  ).slice(0, 10);
  return { exact, similar };
}

/** 주어진 capture 중 정확 중복(같은 content_hash 또는 같은 source)이 하나라도 있는 ID. 목록의 "중복" 표시용. */
export async function exactDuplicateIds(db: DbOrTx, ownerId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: captures.id })
    .from(captures)
    .where(
      and(
        eq(captures.ownerId, ownerId),
        inArray(captures.id, ids),
        sql`exists (
          select 1 from captures d
           where d.owner_id = ${ownerId}
             and d.id <> "captures"."id"
             and ((d.content_hash is not null and d.content_hash = "captures"."content_hash")
               or (d.source_id is not null and d.source_id = "captures"."source_id")))`,
      ),
    );
  return new Set(rows.map((r) => r.id));
}

// ---- 목록(cursor) ----

export interface CaptureListItem {
  capture: CaptureRow;
  sourceUrl: string | null;
}

export interface CapturePage {
  items: CaptureListItem[];
  /** 다음 페이지 cursor 재료(received_at 마이크로초 ISO, id). 마지막 페이지면 null. */
  next: { receivedAt: string; id: string } | null;
}

/**
 * (received_at desc, id desc) 순서의 keyset pagination.
 * cursor 의 시각은 JS Date(밀리초)로 바꾸지 않고 DB 의 마이크로초 문자열을 그대로 써서 누락·중복을 막는다.
 */
export async function listCapturesPage(
  db: DbOrTx,
  ownerId: string,
  opts: { cursor?: { receivedAt: string; id: string } | null; limit?: number } = {},
): Promise<CapturePage> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const c = opts.cursor ?? null;
  const rows = await db
    .select({
      capture: captures,
      sourceUrl: sources.canonicalUrl,
      receivedAtText: sql<string>`to_char(${captures.receivedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(captures)
    .leftJoin(sources, and(eq(sources.id, captures.sourceId), eq(sources.ownerId, captures.ownerId)))
    .where(
      and(
        eq(captures.ownerId, ownerId),
        c ? sql`(${captures.receivedAt}, ${captures.id}) < (${c.receivedAt}::timestamptz, ${c.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(captures.receivedAt), desc(captures.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ capture: r.capture, sourceUrl: r.sourceUrl })),
    next: rows.length > limit && last ? { receivedAt: last.receivedAtText, id: last.capture.id } : null,
  };
}

// ---- 상세 ----

export interface CaptureDetail {
  capture: CaptureRow;
  source: SourceRow | null;
  revisions: CaptureRevisionRow[];
  extractions: SourceVersionRow[];
}

export async function getCaptureDetail(db: DbOrTx, ownerId: string, id: string): Promise<CaptureDetail | null> {
  const capture = await getCaptureRow(db, ownerId, id);
  if (!capture) return null;
  const source = await getSourceById(db, ownerId, capture.sourceId);
  const revisions = await db
    .select()
    .from(captureRevisions)
    .where(and(eq(captureRevisions.captureId, capture.id), eq(captureRevisions.ownerId, ownerId)))
    .orderBy(desc(captureRevisions.revision));
  const extractions = source
    ? await db
        .select()
        .from(sourceVersions)
        .where(eq(sourceVersions.sourceId, source.id))
        .orderBy(desc(sourceVersions.fetchedAt), desc(sourceVersions.id))
        .limit(20)
    : [];
  return { capture, source, revisions, extractions };
}

// ---- 추출 차단 기록 ----

export type ExtractBlockReason = 'url_not_allowed' | 'collector_disabled' | 'collector_not_implemented';

/**
 * 추출이 차단되었음을 남긴다: source_versions(extraction_state='blocked', raw_hash=null) + audit(사유만).
 * 외부 호출 없음. capture 와 source 는 바꾸지 않는다.
 */
export async function recordExtractBlocked(
  db: Db,
  ownerId: string,
  capture: CaptureRow,
  source: SourceRow | null,
  reason: ExtractBlockReason,
): Promise<SourceVersionRow | null> {
  return db.transaction(async (tx) => {
    let version: SourceVersionRow | null = null;
    if (source && source.ownerId === ownerId) {
      const rows = await tx
        .insert(sourceVersions)
        .values({ sourceId: source.id, rawHash: null, extractionState: 'blocked' })
        .returning();
      version = rows[0] ?? null;
    }
    await recordAudit(tx, {
      ownerId,
      action: 'capture.extract_blocked',
      entity: 'capture',
      entityId: capture.id,
      details: { reason },
    });
    return version;
  });
}

/** seed·마이그레이션 보조: content_hash 가 비어 있는 owner 의 capture 를 채운다. 채운 행 수. */
export async function backfillContentHashes(db: DbOrTx, ownerId: string): Promise<number> {
  const rows = await db
    .select({ id: captures.id, rawText: captures.rawText })
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), sql`${captures.contentHash} is null`));
  for (const r of rows) {
    await db
      .update(captures)
      .set({ contentHash: contentHash(r.rawText) })
      .where(and(eq(captures.id, r.id), eq(captures.ownerId, ownerId)));
  }
  return rows.length;
}

/** 목록 요약용: owner 의 source 수(테스트·health 보조). */
export async function countUrlSources(db: DbOrTx, ownerId: string): Promise<number> {
  const rows = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.ownerId, ownerId), isNotNull(sources.normalizedUrl)));
  return rows.length;
}

/** 여러 ID 의 capture 를 owner 범위로 가져온다(중복 후보 표시용). 없는 ID·다른 owner ID 는 빠진다. */
export async function getCapturesByIds(db: DbOrTx, ownerId: string, ids: string[]): Promise<Map<string, CaptureRow>> {
  const valid = ids.filter(isUuid);
  if (valid.length === 0) return new Map();
  const rows = await db
    .select()
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), inArray(captures.id, valid)));
  return new Map(rows.map((r) => [r.id, r]));
}
