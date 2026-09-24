/**
 * 원고(contents)·불변 버전(content_versions) 쿼리(T04). 모든 함수는 ownerId 를 WHERE 에 넣는다(A01).
 *
 * 불변식
 * - 본문은 content_versions 에만 있고, 행은 추가만 한다(DB 트리거 content_versions_immutable 이 UPDATE·DELETE 를 막음).
 * - 본문 저장은 base_version 이 현재 버전과 같을 때만 새 버전(current+1)을 추가한다. 다르면 409 + 현재 본문·제출 본문(A02).
 * - 메타데이터(제목·연재·독자·태그·상태) 수정은 revision 낙관적 잠금. 상태 전이는 도메인 규칙(assertLifecycleTransition).
 * - 원문 관계(content_captures)는 owner 확인 후 삽입, 확인을 건너뛰어도 복합 FK 가 다른 owner 의 capture 를 막는다.
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { PgColumn, PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  assertLifecycleTransition,
  ConflictError,
  draftBodyFromCapture,
  draftBodyFromIdea,
  draftTitleFromCapture,
  draftTitleFromIdea,
  isUuid,
  NotFoundError,
  type ContentLifecycle,
  type ContentMetaPatchInput,
} from '@cs/domain';
import type { Db } from './client';
import { getCaptureById, recordAudit, type DbOrTx } from './queries';
import { assertCapturesOwned, getIdeaRow, keysetBefore, listIdeaCaptures, microsText, type IdeaRow, type TimeCursor } from './ideas';
import { captures, contentCaptures, contents, contentVersions } from './schema';

export type ContentRow = typeof contents.$inferSelect;
export type ContentVersionRow = typeof contentVersions.$inferSelect;
type CaptureRowT = typeof captures.$inferSelect;

const NOT_FOUND = '원고를 찾을 수 없습니다';
const emptyToNull = (v: string | null | undefined) => (v === undefined || v === null || v.trim() === '' ? null : v);

export interface NewContent {
  title: string;
  body: string;
  series?: string | null;
  audience?: string | null;
  tags?: string[];
  ideaId?: string | null;
  captureIds?: string[];
}

export interface CreatedContent {
  content: ContentRow;
  version: ContentVersionRow;
  captureIds: string[];
}

export async function linkContentCaptures(db: DbOrTx, ownerId: string, contentId: string, captureIds: readonly string[]) {
  if (captureIds.length === 0) return;
  await db
    .insert(contentCaptures)
    .values(captureIds.map((captureId) => ({ contentId, captureId, ownerId, role: 'origin' })))
    .onConflictDoNothing({ target: [contentCaptures.contentId, contentCaptures.captureId] });
}

/**
 * 원고 생성(한 트랜잭션): contents → version 1 → current_version_id → 원문 연결 → audit content.create.
 * idea_id·capture_ids 는 owner 범위로 확인(없거나 다른 owner 면 404).
 */
export async function createContent(db: Db, ownerId: string, input: NewContent, now: Date = new Date()): Promise<CreatedContent> {
  return db.transaction(async (tx) => {
    if (input.ideaId) {
      const idea = await getIdeaRow(tx, ownerId, input.ideaId.toLowerCase());
      if (!idea) throw new NotFoundError('카드를 찾을 수 없습니다');
    }
    const captureIds = await assertCapturesOwned(tx, ownerId, input.captureIds ?? []);
    const inserted = await tx
      .insert(contents)
      .values({
        ownerId,
        ideaId: input.ideaId ? input.ideaId.toLowerCase() : null,
        title: input.title,
        series: emptyToNull(input.series),
        audience: emptyToNull(input.audience),
        tags: input.tags ?? [],
        lifecycle: 'draft',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const created = inserted[0];
    if (!created) throw new Error('원고 생성에 실패했습니다');
    const versions = await tx
      .insert(contentVersions)
      .values({ contentId: created.id, version: 1, body: input.body, createdBy: 'owner', createdAt: now })
      .returning();
    const version = versions[0]!;
    const updated = await tx
      .update(contents)
      .set({ currentVersionId: version.id })
      .where(and(eq(contents.id, created.id), eq(contents.ownerId, ownerId)))
      .returning();
    await linkContentCaptures(tx, ownerId, created.id, captureIds);
    await recordAudit(tx, {
      ownerId,
      action: 'content.create',
      entity: 'content',
      entityId: created.id,
      versionOrHash: '1',
      details: { captures: captureIds.length, has_idea: created.ideaId !== null, body_bytes: Buffer.byteLength(input.body, 'utf8') },
      at: now,
    });
    return { content: updated[0]!, version, captureIds };
  });
}

/** 소재에서 원고 시작: 제목 = capture.title 또는 원문 첫 60자, 본문 = `> 원문:` 인용 + 빈 작성 칸. 소재는 origin 으로 연결. */
export async function createContentFromCapture(db: Db, ownerId: string, captureId: string, now: Date = new Date()) {
  const capture = await getCaptureById(db, ownerId, captureId.toLowerCase());
  if (!capture) throw new NotFoundError('소재를 찾을 수 없습니다');
  return createContent(
    db,
    ownerId,
    {
      title: draftTitleFromCapture(capture.title, capture.rawText),
      body: draftBodyFromCapture(capture.rawText),
      captureIds: [capture.id],
    },
    now,
  );
}

/** 카드에서 원고 시작: 카드 항목을 인용한 본문, 카드의 소재를 origin 으로 연결, idea_id 연결. */
export async function createContentFromIdea(db: Db, ownerId: string, ideaId: string, now: Date = new Date()) {
  const idea = await getIdeaRow(db, ownerId, ideaId.toLowerCase());
  if (!idea) throw new NotFoundError('카드를 찾을 수 없습니다');
  const linked = await listIdeaCaptures(db, ownerId, idea.id);
  return createContent(
    db,
    ownerId,
    {
      title: draftTitleFromIdea(idea.idea),
      body: draftBodyFromIdea(idea),
      audience: idea.audience,
      tags: idea.tags,
      ideaId: idea.id,
      captureIds: linked.map((c) => c.id),
    },
    now,
  );
}

export async function getContentRow(db: DbOrTx, ownerId: string, id: string): Promise<ContentRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(contents)
    .where(and(eq(contents.id, id), eq(contents.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

async function getCurrentVersion(db: DbOrTx, content: ContentRow): Promise<ContentVersionRow> {
  if (!content.currentVersionId) throw new Error('현재 버전이 없는 원고입니다');
  const rows = await db
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.id, content.currentVersionId), eq(contentVersions.contentId, content.id)))
    .limit(1);
  const v = rows[0];
  if (!v) throw new Error('현재 버전을 찾을 수 없습니다');
  return v;
}

export interface VersionSummary {
  id: string;
  version: number;
  createdAt: Date;
  createdBy: string;
  bytes: number;
  note: string | null;
}

export async function listContentVersions(db: DbOrTx, contentId: string): Promise<VersionSummary[]> {
  return db
    .select({
      id: contentVersions.id,
      version: contentVersions.version,
      createdAt: contentVersions.createdAt,
      createdBy: contentVersions.createdBy,
      bytes: sql<number>`octet_length(${contentVersions.body})::int`,
      note: contentVersions.note,
    })
    .from(contentVersions)
    .where(eq(contentVersions.contentId, contentId))
    .orderBy(desc(contentVersions.version));
}

export async function listContentCaptures(db: DbOrTx, ownerId: string, contentId: string): Promise<CaptureRowT[]> {
  const rows = await db
    .select({ capture: captures })
    .from(contentCaptures)
    .innerJoin(captures, and(eq(captures.id, contentCaptures.captureId), eq(captures.ownerId, contentCaptures.ownerId)))
    .where(and(eq(contentCaptures.contentId, contentId), eq(contentCaptures.ownerId, ownerId)))
    .orderBy(asc(contentCaptures.createdAt), asc(captures.id));
  return rows.map((r) => r.capture);
}

export interface ContentDetail {
  content: ContentRow;
  current: ContentVersionRow;
  versions: VersionSummary[];
  captures: CaptureRowT[];
  idea: IdeaRow | null;
}

/** 원고 + 현재 버전 본문 + 버전 목록 + 원문(수집) + 카드. 다른 owner·없는 ID 면 null. */
export async function getContentDetail(db: DbOrTx, ownerId: string, id: string): Promise<ContentDetail | null> {
  const content = await getContentRow(db, ownerId, id);
  if (!content) return null;
  const current = await getCurrentVersion(db, content);
  const versions = await listContentVersions(db, content.id);
  const origin = await listContentCaptures(db, ownerId, content.id);
  const idea = content.ideaId ? await getIdeaRow(db, ownerId, content.ideaId) : null;
  return { content, current, versions, captures: origin, idea };
}

/** 특정 버전(불변). 다른 owner 의 원고·없는 버전이면 null. */
export async function getContentVersion(
  db: DbOrTx,
  ownerId: string,
  contentId: string,
  version: number,
): Promise<{ content: ContentRow; version: ContentVersionRow } | null> {
  if (!Number.isInteger(version) || version < 1) return null;
  const content = await getContentRow(db, ownerId, contentId);
  if (!content) return null;
  const rows = await db
    .select()
    .from(contentVersions)
    .where(and(eq(contentVersions.contentId, content.id), eq(contentVersions.version, version)))
    .limit(1);
  return rows[0] ? { content, version: rows[0] } : null;
}

export function contentMetaView(c: ContentRow) {
  return {
    revision: c.revision,
    title: c.title,
    series: c.series,
    audience: c.audience,
    tags: c.tags,
    lifecycle: c.lifecycle,
    updated_at: c.updatedAt.toISOString(),
  };
}

export type ContentMetaPatch = Omit<ContentMetaPatchInput, 'expected_revision'>;

/**
 * 메타데이터 낙관적 잠금 수정. 상태 전이가 허용되지 않으면 400 invalid_transition.
 * revision 불일치 → 409 { current, yours }. 전이 검사는 "현재" 상태 기준(잠금 안에서 읽은 행).
 */
export async function updateContentMeta(
  db: Db,
  ownerId: string,
  id: string,
  patch: ContentMetaPatch,
  expectedRevision: number,
  now: Date = new Date(),
): Promise<ContentRow> {
  if (!isUuid(id)) throw new NotFoundError(NOT_FOUND);
  return db.transaction(async (tx) => {
    const rows0 = await tx
      .select()
      .from(contents)
      .where(and(eq(contents.id, id), eq(contents.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const current = rows0[0];
    if (!current) throw new NotFoundError(NOT_FOUND);
    if (current.revision !== expectedRevision) {
      throw new ConflictError({ current: contentMetaView(current), yours: { expected_revision: expectedRevision, ...patch } });
    }
    if (patch.lifecycle !== undefined) assertLifecycleTransition(current.lifecycle, patch.lifecycle);

    const set: PgUpdateSetSource<typeof contents> = { revision: sql`${contents.revision} + 1`, updatedAt: now };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.series !== undefined) set.series = emptyToNull(patch.series);
    if (patch.audience !== undefined) set.audience = emptyToNull(patch.audience);
    if (patch.tags !== undefined) set.tags = patch.tags;
    if (patch.lifecycle !== undefined) set.lifecycle = patch.lifecycle;
    const rows = await tx
      .update(contents)
      .set(set)
      .where(and(eq(contents.id, id), eq(contents.ownerId, ownerId), eq(contents.revision, expectedRevision)))
      .returning();
    const updated = rows[0];
    if (!updated) {
      const latest = await getContentRow(tx, ownerId, id);
      if (!latest) throw new NotFoundError(NOT_FOUND);
      throw new ConflictError({ current: contentMetaView(latest), yours: { expected_revision: expectedRevision, ...patch } });
    }
    await recordAudit(tx, {
      ownerId,
      action: 'content.update',
      entity: 'content',
      entityId: id,
      versionOrHash: String(updated.revision),
      details: {
        revision: updated.revision,
        fields: Object.keys(patch)
          .filter((k) => patch[k as keyof ContentMetaPatch] !== undefined)
          .sort()
          .join(','),
        lifecycle: updated.lifecycle,
      },
      at: now,
    });
    return updated;
  });
}

export interface AppendVersionInput {
  baseVersion: number;
  body: string;
  note?: string | null;
}

/**
 * 본문 새 버전 추가. baseVersion 이 현재 버전과 다르면 ConflictError(409):
 * { current: { version, body, created_at }, yours: { base_version, body, note } } — 두 본문 모두 돌려줘 잃지 않는다(A02).
 * 같으면 version = current+1 행을 추가하고 contents.current_version_id·updated_at 을 옮긴다. 기존 버전 행은 건드리지 않는다.
 */
export async function appendContentVersion(
  db: Db,
  ownerId: string,
  contentId: string,
  input: AppendVersionInput,
  now: Date = new Date(),
): Promise<{ content: ContentRow; version: ContentVersionRow }> {
  if (!isUuid(contentId)) throw new NotFoundError(NOT_FOUND);
  return db.transaction(async (tx) => {
    const rows0 = await tx
      .select()
      .from(contents)
      .where(and(eq(contents.id, contentId), eq(contents.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const content = rows0[0];
    if (!content) throw new NotFoundError(NOT_FOUND);
    const current = await getCurrentVersion(tx, content);
    if (input.baseVersion !== current.version) {
      throw new ConflictError({
        current: { version: current.version, body: current.body, created_at: current.createdAt.toISOString() },
        yours: { base_version: input.baseVersion, body: input.body, note: input.note ?? null },
      });
    }
    const inserted = await tx
      .insert(contentVersions)
      .values({
        contentId: content.id,
        version: current.version + 1,
        body: input.body,
        createdBy: 'owner',
        note: emptyToNull(input.note),
        createdAt: now,
      })
      .returning();
    const version = inserted[0]!;
    const updated = await tx
      .update(contents)
      .set({ currentVersionId: version.id, updatedAt: now })
      .where(and(eq(contents.id, content.id), eq(contents.ownerId, ownerId), eq(contents.currentVersionId, current.id)))
      .returning();
    if (!updated[0]) throw new Error('현재 버전 갱신에 실패했습니다');
    await recordAudit(tx, {
      ownerId,
      action: 'content.version_append',
      entity: 'content',
      entityId: content.id,
      versionOrHash: String(version.version),
      details: { version: version.version, base_version: input.baseVersion, body_bytes: Buffer.byteLength(input.body, 'utf8') },
      at: now,
    });
    return { content: updated[0], version };
  });
}

export interface ContentListFilters {
  series?: string;
  tag?: string;
  lifecycle?: ContentLifecycle;
  lifecycles?: readonly ContentLifecycle[];
}

export interface ContentPage {
  items: ContentRow[];
  next: TimeCursor | null;
}

/** 아카이브 목록: (updated_at desc, id desc) keyset + 연재·태그·상태 필터. 태그는 대소문자 구분 없이 일치. */
export async function listContents(
  db: DbOrTx,
  ownerId: string,
  opts: ContentListFilters & { cursor?: TimeCursor | null; limit?: number } = {},
): Promise<ContentPage> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
  const rows = await db
    .select({ content: contents, at: microsText(contents.updatedAt) })
    .from(contents)
    .where(
      and(
        eq(contents.ownerId, ownerId),
        opts.series ? eq(contents.series, opts.series) : undefined,
        opts.tag ? tagMatch(contents.tags, opts.tag) : undefined,
        opts.lifecycle ? eq(contents.lifecycle, opts.lifecycle) : undefined,
        opts.lifecycles?.length ? inArray(contents.lifecycle, [...opts.lifecycles]) : undefined,
        keysetBefore(contents.updatedAt, contents.id, opts.cursor),
      ),
    )
    .orderBy(desc(contents.updatedAt), desc(contents.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => r.content),
    next: rows.length > limit && last ? { at: last.at, id: last.content.id } : null,
  };
}

/** jsonb 태그 배열에 tag 가 (대소문자 무시) 있는지. */
export const tagMatch = (col: PgColumn, tag: string) =>
  sql`exists (select 1 from jsonb_array_elements_text(${col}) as t(v) where lower(t.v) = lower(${tag}))`;

/** 연재 select 용: owner 의 서로 다른 series(가나다순). */
export async function listSeries(db: DbOrTx, ownerId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ series: contents.series })
    .from(contents)
    .where(and(eq(contents.ownerId, ownerId), isNotNull(contents.series)))
    .orderBy(asc(contents.series));
  return rows.map((r) => r.series!).filter(Boolean);
}

/** 오늘 화면 "이어 쓸 초안": draft|review 중 최근 수정 1건. */
export async function latestDraft(db: DbOrTx, ownerId: string): Promise<ContentRow | null> {
  const page = await listContents(db, ownerId, { lifecycles: ['draft', 'review'], limit: 1 });
  return page.items[0] ?? null;
}
