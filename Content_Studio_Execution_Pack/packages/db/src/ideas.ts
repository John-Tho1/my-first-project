/**
 * 콘텐츠 카드(ideas) 쿼리(T04). 모든 함수는 ownerId 를 WHERE 에 넣는다(A01).
 * - 수정은 `UPDATE … WHERE id AND owner_id AND revision = expected` 한 문장(낙관적 잠금). 0행이면 409 또는 404.
 * - 소재 연결(idea_captures)은 먼저 owner 범위로 확인(없으면 404)하고, 확인을 건너뛰어도 복합 FK 가 다른 owner 의 capture 를 막는다.
 */
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { ConflictError, isUuid, NotFoundError, type IdeaCreateInput, type IdeaPatchInput } from '@cs/domain';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import { captures, contentCaptures, contents, ideaCaptures, ideas } from './schema';

export type IdeaRow = typeof ideas.$inferSelect;
type CaptureRowT = typeof captures.$inferSelect;
type ContentRowT = typeof contents.$inferSelect;

const emptyToNull = (v: string | null | undefined) => (v === undefined || v === null || v.trim() === '' ? null : v);

/** keyset cursor 재료: DB 의 마이크로초 시각 문자열(JS Date 로 바꾸면 밀리초로 잘려 누락·중복이 생김). */
export const microsText = (col: PgColumn) =>
  sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface TimeCursor {
  at: string;
  id: string;
}

export const keysetBefore = (tsCol: PgColumn, idCol: PgColumn, c: TimeCursor | null | undefined): SQL | undefined =>
  c ? sql`(${tsCol}, ${idCol}) < (${c.at}::timestamptz, ${c.id}::uuid)` : undefined;

/**
 * capture ID 들이 모두 이 owner 의 것인지 확인한다. 하나라도 없거나(다른 owner 포함) 형식이 틀리면 NotFoundError(404).
 * 중복 ID 는 하나로 본다. 반환: 중복 제거된 ID(입력 순서).
 */
export async function assertCapturesOwned(db: DbOrTx, ownerId: string, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  if (unique.length === 0) return [];
  if (!unique.every(isUuid)) throw new NotFoundError('소재를 찾을 수 없습니다');
  const rows = await db
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.ownerId, ownerId), inArray(captures.id, unique)));
  if (rows.length !== unique.length) throw new NotFoundError('소재를 찾을 수 없습니다');
  return unique;
}

/** 연결 행 삽입(이미 있으면 무시). owner 확인은 호출자가 먼저 한다 — 건너뛰어도 복합 FK 가 막는다. */
export async function linkIdeaCaptures(db: DbOrTx, ownerId: string, ideaId: string, captureIds: readonly string[]) {
  if (captureIds.length === 0) return;
  await db
    .insert(ideaCaptures)
    .values(captureIds.map((captureId) => ({ ideaId, captureId, ownerId, role: 'origin' })))
    .onConflictDoNothing({ target: [ideaCaptures.ideaId, ideaCaptures.captureId] });
}

export async function createIdea(db: Db, ownerId: string, input: IdeaCreateInput, now: Date = new Date()): Promise<IdeaRow> {
  return db.transaction(async (tx) => {
    const captureIds = await assertCapturesOwned(tx, ownerId, input.capture_ids ?? []);
    const rows = await tx
      .insert(ideas)
      .values({
        ownerId,
        idea: input.idea,
        audience: emptyToNull(input.audience),
        evidence: emptyToNull(input.evidence),
        nextQuestion: emptyToNull(input.next_question),
        nextDecision: emptyToNull(input.next_decision),
        risk: input.risk ?? 'none',
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const idea = rows[0];
    if (!idea) throw new Error('카드 생성에 실패했습니다');
    await linkIdeaCaptures(tx, ownerId, idea.id, captureIds);
    await recordAudit(tx, {
      ownerId,
      action: 'idea.create',
      entity: 'idea',
      entityId: idea.id,
      versionOrHash: String(idea.revision),
      details: { captures: captureIds.length, tags: idea.tags.length },
      at: now,
    });
    return idea;
  });
}

export async function getIdeaRow(db: DbOrTx, ownerId: string, id: string): Promise<IdeaRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(ideas)
    .where(and(eq(ideas.id, id), eq(ideas.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listIdeaCaptures(db: DbOrTx, ownerId: string, ideaId: string): Promise<CaptureRowT[]> {
  const rows = await db
    .select({ capture: captures })
    .from(ideaCaptures)
    .innerJoin(captures, and(eq(captures.id, ideaCaptures.captureId), eq(captures.ownerId, ideaCaptures.ownerId)))
    .where(and(eq(ideaCaptures.ideaId, ideaId), eq(ideaCaptures.ownerId, ownerId)))
    .orderBy(desc(captures.receivedAt), desc(captures.id));
  return rows.map((r) => r.capture);
}

export interface IdeaDetail {
  idea: IdeaRow;
  captures: CaptureRowT[];
  contents: ContentRowT[];
}

/** 카드 + 연결 소재 + 이 카드에서 시작한 원고. 다른 owner·없는 ID 면 null. */
export async function getIdea(db: DbOrTx, ownerId: string, id: string): Promise<IdeaDetail | null> {
  const idea = await getIdeaRow(db, ownerId, id);
  if (!idea) return null;
  const linked = await listIdeaCaptures(db, ownerId, idea.id);
  const derived = await db
    .select()
    .from(contents)
    .where(and(eq(contents.ownerId, ownerId), eq(contents.ideaId, idea.id)))
    .orderBy(desc(contents.updatedAt), desc(contents.id));
  return { idea, captures: linked, contents: derived };
}

export function ideaCurrentView(i: IdeaRow) {
  return {
    revision: i.revision,
    idea: i.idea,
    audience: i.audience,
    evidence: i.evidence,
    risk: i.risk,
    next_question: i.nextQuestion,
    next_decision: i.nextDecision,
    tags: i.tags,
    updated_at: i.updatedAt.toISOString(),
  };
}

export type IdeaPatch = Omit<IdeaPatchInput, 'expected_revision'>;

/**
 * 낙관적 잠금 수정. capture_ids 를 주면 연결 집합을 그 목록으로 바꾼다(다른 owner 의 capture → 404).
 * revision 불일치 → ConflictError(409) { current, yours }.
 */
export async function updateIdea(
  db: Db,
  ownerId: string,
  id: string,
  patch: IdeaPatch,
  expectedRevision: number,
  now: Date = new Date(),
): Promise<IdeaRow> {
  if (!isUuid(id)) throw new NotFoundError('카드를 찾을 수 없습니다');
  return db.transaction(async (tx) => {
    const captureIds = patch.capture_ids ? await assertCapturesOwned(tx, ownerId, patch.capture_ids) : null;
    const set: PgUpdateSetSource<typeof ideas> = { revision: sql`${ideas.revision} + 1`, updatedAt: now };
    if (patch.idea !== undefined) set.idea = patch.idea;
    if (patch.audience !== undefined) set.audience = emptyToNull(patch.audience);
    if (patch.evidence !== undefined) set.evidence = emptyToNull(patch.evidence);
    if (patch.next_question !== undefined) set.nextQuestion = emptyToNull(patch.next_question);
    if (patch.next_decision !== undefined) set.nextDecision = emptyToNull(patch.next_decision);
    if (patch.risk !== undefined) set.risk = patch.risk;
    if (patch.tags !== undefined) set.tags = patch.tags;
    const rows = await tx
      .update(ideas)
      .set(set)
      .where(and(eq(ideas.id, id), eq(ideas.ownerId, ownerId), eq(ideas.revision, expectedRevision)))
      .returning();
    const updated = rows[0];
    if (!updated) {
      const current = await getIdeaRow(tx, ownerId, id);
      if (!current) throw new NotFoundError('카드를 찾을 수 없습니다');
      throw new ConflictError({ current: ideaCurrentView(current), yours: { expected_revision: expectedRevision, ...patch } });
    }
    if (captureIds) {
      await tx
        .delete(ideaCaptures)
        .where(
          and(
            eq(ideaCaptures.ideaId, id),
            eq(ideaCaptures.ownerId, ownerId),
            captureIds.length ? sql`${ideaCaptures.captureId} <> all(${sql.param(captureIds)}::uuid[])` : undefined,
          ),
        );
      await linkIdeaCaptures(tx, ownerId, id, captureIds);
    }
    await recordAudit(tx, {
      ownerId,
      action: 'idea.update',
      entity: 'idea',
      entityId: id,
      versionOrHash: String(updated.revision),
      details: {
        revision: updated.revision,
        fields: Object.keys(patch)
          .filter((k) => patch[k as keyof IdeaPatch] !== undefined)
          .sort()
          .join(','),
      },
      at: now,
    });
    return updated;
  });
}

export interface IdeaPage {
  items: IdeaRow[];
  next: TimeCursor | null;
}

/** (updated_at desc, id desc) keyset pagination. */
export async function listIdeas(
  db: DbOrTx,
  ownerId: string,
  opts: { cursor?: TimeCursor | null; limit?: number } = {},
): Promise<IdeaPage> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const rows = await db
    .select({ idea: ideas, at: microsText(ideas.updatedAt) })
    .from(ideas)
    .where(and(eq(ideas.ownerId, ownerId), keysetBefore(ideas.updatedAt, ideas.id, opts.cursor)))
    .orderBy(desc(ideas.updatedAt), desc(ideas.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => r.idea),
    next: rows.length > limit && last ? { at: last.at, id: last.idea.id } : null,
  };
}

/** 소재에서 파생된 카드·원고(소재 상세의 "이 소재에서 나온 것"). */
export async function listCaptureDerivations(db: DbOrTx, ownerId: string, captureId: string) {
  if (!isUuid(captureId)) return { ideas: [] as IdeaRow[], contents: [] as ContentRowT[] };
  const ideaRows = await db
    .select({ idea: ideas })
    .from(ideaCaptures)
    .innerJoin(ideas, and(eq(ideas.id, ideaCaptures.ideaId), eq(ideas.ownerId, ideaCaptures.ownerId)))
    .where(and(eq(ideaCaptures.captureId, captureId), eq(ideaCaptures.ownerId, ownerId)))
    .orderBy(desc(ideas.updatedAt), desc(ideas.id));
  const contentRows = await db
    .select({ content: contents })
    .from(contentCaptures)
    .innerJoin(contents, and(eq(contents.id, contentCaptures.contentId), eq(contents.ownerId, contentCaptures.ownerId)))
    .where(and(eq(contentCaptures.captureId, captureId), eq(contentCaptures.ownerId, ownerId)))
    .orderBy(desc(contents.updatedAt), desc(contents.id));
  const contentList = contentRows.map((r) => r.content);
  return { ideas: ideaRows.map((r) => r.idea), contents: contentList };
}
