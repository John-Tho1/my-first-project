/**
 * T19(제안 결정 D33) 허용 소스 수집(모의) — 소스(allowlist) 관리 → 수동/주기 실행(미리보기만) → 사용자가 고른 항목만 소재로 → 재추천.
 *
 * 불변식
 * - 실행(run)은 원장(collector_runs·collected_items)과 소스의 마지막 실행 표시만 쓴다. 소재·출처·출처 버전·소재 이력 쓰기 0(자동 수락 없음).
 *   주기 실행도 같다 — 미리보기만 만든다.
 * - 받아들이기는 미리보기를 믿지 않는다: 수집기로 다시 읽어 같은 외부 키의 내용 checksum·원본 sha256 이 같을 때만 소재를 만든다(다르면 failed_changed).
 *   트랜잭션 안에서 owner 단위 advisory lock 뒤 중복을 다시 판정한다(동시 수락·다른 실행과 직렬화).
 * - 받아들인 항목: 출처(sources, external_provider='collector_mock', external_id='<소스 ID>:<외부 키>' — 같은 글이 바뀌면 같은 출처에 새 버전) +
 *   출처 버전(raw_hash = 원본 조각 sha256) + 원본 그대로(source_version_originals, 피드는 <item> XML 조각 'txt', 페이지는 HTML 'html') +
 *   소재(input_type 'text', 원문 = 제목 + 본문 텍스트, command_key collect-<항목 ID>) + 소재 이력 r1 + audit.
 * - 수집한 글 속 지시문(A04)은 자료일 뿐 — 이 모듈은 배포·게시·승인 경로를 호출하지 않는다.
 * - 모든 조회·변경은 owner 조건(A01) + 복합 FK. 원장에는 본문 전체·자격 증명이 없다(발췌 200자만).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import {
  AppError,
  applyLinkPolicy,
  BadRequestError,
  checkCollectorUrl,
  collectedCaptureText,
  COLLECTOR_FEED_MAX_BYTES,
  CollectorFetchError,
  CollectorUrlBlockedError,
  contentHash,
  decideCollected,
  FeedParseError,
  isScheduleDue,
  isUuid,
  normalizeUrl,
  NotFoundError,
  parseFeed,
  parsePage,
  recommendArchive,
  RECOMMEND_MIN_AGE_DAYS,
  RECOMMEND_RECENT_DAYS,
  toCandidate,
  type AppConfig,
  type CollectedCandidate,
  type CollectedOutcome,
  type CollectorAdapter,
  type CollectorRunTrigger,
  type CollectorSchedule,
  type CollectorSourceKind,
  type Recommendation,
} from '@cs/domain';
import type { Db } from './client';
import { recordAudit, type DbOrTx } from './queries';
import {
  captureRevisions,
  captures,
  collectedItems,
  collectorRuns,
  collectorSources,
  contents,
  contentVersions,
  recommendationDismissals,
  sources,
  sourceVersionOriginals,
  sourceVersions,
} from './schema';

export type CollectorSourceRow = typeof collectorSources.$inferSelect;
export type CollectorRunRow = typeof collectorRuns.$inferSelect;
export type CollectedItemRow = typeof collectedItems.$inferSelect;

export const COLLECTOR_PROVIDER = 'collector_mock';
export const COLLECTOR_MAX_SOURCES = 50;

export class CollectorSourceExistsError extends AppError {
  constructor() {
    super('conflict', 'collector_source_exists', '같은 주소의 수집 소스가 이미 있습니다');
  }
}
export class CollectorSourceDisabledError extends AppError {
  constructor() {
    super('conflict', 'collector_source_disabled', '이 소스는 꺼져 있습니다. 먼저 켜야 수집할 수 있습니다(기본 꺼짐).');
  }
}
export class CollectorRunNotOpenError extends AppError {
  constructor(status: string) {
    super('conflict', 'collector_run_not_open', '이 수집 실행은 더 이상 고를 수 없습니다(이미 저장·버림·실패)', { status });
  }
}
export class CollectorRefetchFailedError extends AppError {
  constructor(code: string) {
    super('conflict', 'collector_refetch_failed', '다시 읽기에 실패해 아무것도 저장하지 않았습니다. 다시 수집해 보세요.', { code });
  }
}

// ---- 소스 ----

export interface CreateCollectorSourceInput {
  kind: CollectorSourceKind;
  url: string;
  label: string | null;
}

/** 소스 등록 = 허용 목록에 추가. 주소 정책(https·내부 주소·IP 리터럴 거부)을 먼저 적용. 기본 꺼짐·주기 off. 요청 0. */
export async function createCollectorSource(db: Db, ownerId: string, input: CreateCollectorSourceInput, now: Date = new Date()): Promise<CollectorSourceRow> {
  const check = checkCollectorUrl(input.url);
  if (!check.ok) throw new CollectorUrlBlockedError(check.reason);
  const { canonical, normalized } = normalizeUrl(check.url.href);
  // 개수 확인과 추가를 owner 단위 잠금(받아들이기와 같은 advisory 키) 안에서 한다 — 예전에는 count 뒤 insert 라 동시 등록 두 건이 함께 상한을 넘을 수 있었다.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs.collector:${ownerId}`}))`);
    const count = await tx.select({ n: sql<number>`count(*)::int` }).from(collectorSources).where(eq(collectorSources.ownerId, ownerId));
    if ((count[0]?.n ?? 0) >= COLLECTOR_MAX_SOURCES) throw new AppError('conflict', 'collector_too_many_sources', `수집 소스는 ${COLLECTOR_MAX_SOURCES}개까지입니다`);
    const rows = await tx
      .insert(collectorSources)
      .values({ ownerId, kind: input.kind, url: canonical, normalizedUrl: normalized, host: check.host, label: input.label, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    if (!row) throw new CollectorSourceExistsError();
    await recordAudit(tx, { ownerId, action: 'collector.source.create', entity: 'collector_source', entityId: row.id, details: { kind: row.kind, host: row.host } });
    return row;
  });
}

export async function listCollectorSources(db: DbOrTx, ownerId: string): Promise<CollectorSourceRow[]> {
  return db.select().from(collectorSources).where(eq(collectorSources.ownerId, ownerId)).orderBy(asc(collectorSources.createdAt), asc(collectorSources.id));
}

export async function getCollectorSource(db: DbOrTx, ownerId: string, id: string): Promise<CollectorSourceRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(collectorSources)
    .where(and(eq(collectorSources.id, id), eq(collectorSources.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

/** 켜기/끄기·주기 설정. 주기를 켜도 COLLECTOR_SCHEDULER=on 이 아니면 실행되지 않는다(저장만). */
export async function updateCollectorSourceSettings(
  db: Db,
  ownerId: string,
  id: string,
  patch: { enabled?: boolean; schedule?: CollectorSchedule },
  now: Date = new Date(),
): Promise<CollectorSourceRow> {
  const src = await getCollectorSource(db, ownerId, id.toLowerCase());
  if (!src) throw new NotFoundError('수집 소스를 찾을 수 없습니다');
  const set: Partial<typeof collectorSources.$inferInsert> = { updatedAt: now };
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.schedule !== undefined) set.schedule = patch.schedule;
  const [row] = await db
    .update(collectorSources)
    .set(set)
    .where(and(eq(collectorSources.id, src.id), eq(collectorSources.ownerId, ownerId)))
    .returning();
  await recordAudit(db, {
    ownerId,
    action: 'collector.source.settings',
    entity: 'collector_source',
    entityId: src.id,
    details: { enabled: row!.enabled, schedule: row!.schedule },
  });
  return row!;
}

/** 허용 목록 = owner 가 등록한 모든 소스의 호스트(redirect 대상도 이 안이어야 한다). */
export async function collectorAllowlist(db: DbOrTx, ownerId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ host: collectorSources.host }).from(collectorSources).where(eq(collectorSources.ownerId, ownerId));
  return rows.map((r) => r.host).sort();
}

// ---- 읽기·해석 ----

type FetchOutcome = { ok: true; cands: CollectedCandidate[] } | { ok: false; status: 'failed' | 'blocked'; code: string };

/** 수집기로 읽고(정책은 어댑터가 hop 마다 적용) 해석해 후보 목록. 예외 대신 실패 코드. */
export async function fetchCandidates(adapter: CollectorAdapter, source: Pick<CollectorSourceRow, 'kind' | 'url'>, allowlist: readonly string[]): Promise<FetchOutcome> {
  try {
    const req = { url: source.url, allowlist, maxBytes: COLLECTOR_FEED_MAX_BYTES };
    const res = source.kind === 'url' ? await adapter.fetchPage(req) : await adapter.fetchFeed(req);
    // 상대 링크는 최종 URL(redirect 뒤) 기준으로 풀렸다 — 그 결과에 주소 정책·허용 목록을 다시 적용한다.
    const parsed = source.kind === 'url' ? parsePage(res.bytes, source.url) : parseFeed(res.bytes, res.finalUrl);
    return { ok: true, cands: applyLinkPolicy(parsed.items.map((it, i) => toCandidate(it, i)), allowlist) };
  } catch (e) {
    if (e instanceof CollectorFetchError) {
      return e.code === 'blocked' ? { ok: false, status: 'blocked', code: `blocked:${e.reason ?? 'invalid'}` } : { ok: false, status: 'failed', code: e.code };
    }
    if (e instanceof FeedParseError) return { ok: false, status: 'failed', code: e.parseCode };
    if (e instanceof AppError) return { ok: false, status: 'failed', code: 'failed' };
    throw e;
  }
}

/** 이 소스에서 이전에 받아들인 항목(외부 키 → 내용 checksum) + owner 의 기존 URL(소재 출처·받아들인 수집 링크) 중 후보에 나온 것만. */
async function dedupeContext(db: DbOrTx, ownerId: string, sourceId: string, cands: readonly CollectedCandidate[]) {
  const keys = [...new Set(cands.map((c) => c.externalKey).filter((k): k is string => k !== null))];
  const links = [...new Set(cands.map((c) => c.linkNormalized).filter((k): k is string => k !== null))];
  const accepted = new Map<string, Set<string>>();
  const knownUrls = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const rows = await db
      .select({ key: collectedItems.externalKey, checksum: collectedItems.contentChecksum })
      .from(collectedItems)
      .where(
        and(
          eq(collectedItems.ownerId, ownerId),
          eq(collectedItems.sourceId, sourceId),
          eq(collectedItems.outcome, 'accepted'),
          inArray(collectedItems.externalKey, keys.slice(i, i + 500)),
        ),
      );
    for (const r of rows) {
      const s = accepted.get(r.key!) ?? new Set<string>();
      s.add(r.checksum);
      accepted.set(r.key!, s);
    }
  }
  for (let i = 0; i < links.length; i += 500) {
    const chunk = links.slice(i, i + 500);
    const a = await db
      .select({ u: sources.normalizedUrl })
      .from(sources)
      .where(and(eq(sources.ownerId, ownerId), inArray(sources.normalizedUrl, chunk)));
    for (const r of a) if (r.u) knownUrls.add(r.u);
    const b = await db
      .select({ u: collectedItems.linkNormalized })
      .from(collectedItems)
      .where(and(eq(collectedItems.ownerId, ownerId), eq(collectedItems.outcome, 'accepted'), inArray(collectedItems.linkNormalized, chunk)));
    for (const r of b) if (r.u) knownUrls.add(r.u);
  }
  return { accepted, knownUrls };
}

// ---- 실행(미리보기) ----

export interface RunCollectorOptions {
  trigger: CollectorRunTrigger;
  now?: Date;
}

/**
 * 소스 하나를 수집해 미리보기 실행을 만든다. 소재·출처는 만들지 않는다. 꺼진 소스는 409.
 * 정책 차단·응답/형식 오류도 실행 기록(blocked·failed + error_code)으로 남기고 돌려준다(소스는 그대로 — A05 "메모는 저장").
 */
export async function runCollectorSource(
  db: Db,
  ownerId: string,
  sourceId: string,
  adapter: CollectorAdapter,
  opts: RunCollectorOptions,
): Promise<{ run: CollectorRunRow; items: CollectedItemRow[] }> {
  const now = opts.now ?? new Date();
  const source = await getCollectorSource(db, ownerId, sourceId.toLowerCase());
  if (!source) throw new NotFoundError('수집 소스를 찾을 수 없습니다');
  if (!source.enabled) throw new CollectorSourceDisabledError();
  const allowlist = await collectorAllowlist(db, ownerId);
  const fetched = await fetchCandidates(adapter, source, allowlist);

  return db.transaction(async (tx) => {
    if (!fetched.ok) {
      const [run] = await tx
        .insert(collectorRuns)
        .values({ ownerId, sourceId: source.id, trigger: opts.trigger, mode: adapter.mode, status: fetched.status, errorCode: fetched.code, counts: {}, createdAt: now, closedAt: now })
        .returning();
      await tx
        .update(collectorSources)
        .set({ lastRunAt: now, lastStatus: fetched.status })
        .where(and(eq(collectorSources.id, source.id), eq(collectorSources.ownerId, ownerId)));
      await recordAudit(tx, { ownerId, action: 'collector.run', entity: 'collector_run', entityId: run!.id, details: { trigger: opts.trigger, status: fetched.status, error_code: fetched.code } });
      return { run: run!, items: [] };
    }
    const ctx = await dedupeContext(tx, ownerId, source.id, fetched.cands);
    const decisions = decideCollected(fetched.cands, ctx);
    const counts = { total: decisions.length, new: 0, duplicate: 0, skipped: 0 };
    for (const d of decisions) counts[d.decision]++;
    const [run] = await tx
      .insert(collectorRuns)
      .values({ ownerId, sourceId: source.id, trigger: opts.trigger, mode: adapter.mode, status: 'preview', counts, createdAt: now })
      .returning();
    const rows: CollectedItemRow[] = [];
    const values = fetched.cands.map((c, i) => ({
      ownerId,
      runId: run!.id,
      sourceId: source.id,
      position: c.position,
      externalKey: c.externalKey,
      guid: c.guid,
      link: c.link,
      linkNormalized: c.linkNormalized,
      title: c.title,
      excerpt: c.excerpt,
      publishedText: c.publishedText,
      publishedAt: c.publishedAt,
      contentChecksum: c.contentChecksum,
      rawSha256: c.rawSha256,
      byteSize: c.byteSize,
      decision: decisions[i]!.decision,
      reason: decisions[i]!.reason,
      createdAt: now,
    }));
    for (let i = 0; i < values.length; i += 200) {
      const chunk = values.slice(i, i + 200);
      if (chunk.length) rows.push(...(await tx.insert(collectedItems).values(chunk).returning()));
    }
    await tx
      .update(collectorSources)
      .set({ lastRunAt: now, lastStatus: 'preview' })
      .where(and(eq(collectorSources.id, source.id), eq(collectorSources.ownerId, ownerId)));
    // 제목·링크·본문은 기록하지 않는다(건수만).
    await recordAudit(tx, { ownerId, action: 'collector.run', entity: 'collector_run', entityId: run!.id, details: { trigger: opts.trigger, status: 'preview', ...counts } });
    return { run: run!, items: rows };
  });
}

export async function getCollectorRun(db: DbOrTx, ownerId: string, id: string): Promise<CollectorRunRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db
    .select()
    .from(collectorRuns)
    .where(and(eq(collectorRuns.id, id), eq(collectorRuns.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCollectedItems(db: DbOrTx, ownerId: string, runId: string): Promise<CollectedItemRow[]> {
  if (!isUuid(runId)) return [];
  return db
    .select()
    .from(collectedItems)
    .where(and(eq(collectedItems.runId, runId), eq(collectedItems.ownerId, ownerId)))
    .orderBy(asc(collectedItems.position));
}

export async function listCollectorRuns(db: DbOrTx, ownerId: string, limit = 30): Promise<CollectorRunRow[]> {
  return db
    .select()
    .from(collectorRuns)
    .where(eq(collectorRuns.ownerId, ownerId))
    .orderBy(desc(collectorRuns.createdAt), desc(collectorRuns.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** 미리보기 버리기(원장에 discarded). 소재는 그대로. */
export async function discardCollectorRun(db: Db, ownerId: string, id: string, now: Date = new Date()): Promise<CollectorRunRow> {
  const run = await getCollectorRun(db, ownerId, id.toLowerCase());
  if (!run) throw new NotFoundError('수집 실행을 찾을 수 없습니다');
  const [row] = await db
    .update(collectorRuns)
    .set({ status: 'discarded', closedAt: now })
    .where(and(eq(collectorRuns.id, run.id), eq(collectorRuns.ownerId, ownerId), eq(collectorRuns.status, 'preview')))
    .returning();
  if (!row) throw new CollectorRunNotOpenError(run.status);
  await recordAudit(db, { ownerId, action: 'collector.discard', entity: 'collector_run', entityId: run.id, details: {} });
  return row;
}

// ---- 받아들이기(고른 항목만 소재로) ----

export type CollectorAcceptResult = Record<CollectedOutcome, number> & { selected: number };

export async function acceptCollectedItems(
  db: Db,
  ownerId: string,
  runId: string,
  itemIds: readonly string[],
  adapter: CollectorAdapter,
  now: Date = new Date(),
): Promise<{ run: CollectorRunRow; items: CollectedItemRow[]; result: CollectorAcceptResult }> {
  const run = await getCollectorRun(db, ownerId, runId.toLowerCase());
  if (!run) throw new NotFoundError('수집 실행을 찾을 수 없습니다');
  if (run.status !== 'preview') throw new CollectorRunNotOpenError(run.status);
  const ledger = await listCollectedItems(db, ownerId, run.id);
  const byId = new Map(ledger.map((i) => [i.id, i]));
  const selected = new Set(itemIds.map((x) => x.toLowerCase()));
  if (!selected.size) throw new AppError('bad_request', 'collector_nothing_selected', '저장할 항목을 하나 이상 고르세요');
  for (const id of selected) {
    const it = byId.get(id);
    if (!it) throw new BadRequestError('이 실행에 없는 항목을 골랐습니다');
    if (it.decision !== 'new') throw new AppError('bad_request', 'collector_invalid_selection', '새 항목만 소재로 저장할 수 있습니다(중복·건너뜀 항목은 고를 수 없음)');
  }
  const source = await getCollectorSource(db, ownerId, run.sourceId);
  if (!source) throw new NotFoundError('수집 소스를 찾을 수 없습니다');
  // 미리보기를 믿지 않는다 — 다시 읽는다(정책도 다시 적용).
  const refetched = await fetchCandidates(adapter, source, await collectorAllowlist(db, ownerId));
  if (!refetched.ok) throw new CollectorRefetchFailedError(refetched.code);
  const parsed = new Map<string, CollectedCandidate>();
  for (const c of refetched.cands) if (c.externalKey && !parsed.has(c.externalKey)) parsed.set(c.externalKey, c);

  const result = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(collectorRuns)
      .set({ status: 'accepted', acceptedAt: now, closedAt: now })
      .where(and(eq(collectorRuns.id, run.id), eq(collectorRuns.ownerId, ownerId), eq(collectorRuns.status, 'preview')))
      .returning();
    if (!claimed) throw new CollectorRunNotOpenError('changed');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cs.collector:${ownerId}`}))`);
    const ctx = await dedupeContext(tx, ownerId, source.id, [...parsed.values()]);
    const counts: CollectorAcceptResult = { selected: selected.size, accepted: 0, not_selected: 0, skipped_duplicate: 0, failed_changed: 0 };
    for (const item of ledger) {
      if (item.decision !== 'new') continue;
      let outcome: CollectedOutcome;
      let target: { captureId: string; sourceVersionId: string } | null = null;
      const p = item.externalKey ? parsed.get(item.externalKey) : undefined;
      if (!selected.has(item.id)) outcome = 'not_selected';
      // 다시 읽은 항목이 미리보기와 같아야 한다: 내용 checksum·원본 sha256 에 더해 **해석한 링크**(상대 링크는 최종 URL 기준이라
      // 원본 조각이 같아도 redirect 경로가 바뀌면 달라진다)와 링크 정책 통과 여부까지(Codex review-T19 P1 :396).
      else if (
        !p ||
        p.contentChecksum !== item.contentChecksum ||
        p.rawSha256 !== item.rawSha256 ||
        p.link !== item.link ||
        p.linkNormalized !== item.linkNormalized ||
        p.blockedLink
      )
        outcome = 'failed_changed';
      else {
        const prev = ctx.accepted.get(p.externalKey!);
        if (prev?.has(p.contentChecksum) || (!prev && p.linkNormalized && ctx.knownUrls.has(p.linkNormalized))) outcome = 'skipped_duplicate';
        else {
          outcome = 'accepted';
          target = await createCollectedCapture(tx, ownerId, source.id, run.id, item.id, p, now);
          const s = ctx.accepted.get(p.externalKey!) ?? new Set<string>();
          s.add(p.contentChecksum);
          ctx.accepted.set(p.externalKey!, s);
          if (p.linkNormalized) ctx.knownUrls.add(p.linkNormalized);
        }
      }
      counts[outcome]++;
      await tx
        .update(collectedItems)
        .set({ outcome, captureId: target?.captureId ?? null, sourceVersionId: target?.sourceVersionId ?? null, acceptedAt: target ? now : null })
        .where(and(eq(collectedItems.id, item.id), eq(collectedItems.ownerId, ownerId)));
    }
    const [done] = await tx
      .update(collectorRuns)
      .set({ result: counts })
      .where(and(eq(collectorRuns.id, run.id), eq(collectorRuns.ownerId, ownerId)))
      .returning();
    await recordAudit(tx, { ownerId, action: 'collector.accept', entity: 'collector_run', entityId: run.id, details: { ...counts } });
    return { run: done!, result: counts };
  });
  return { ...result, items: await listCollectedItems(db, ownerId, run.id) };
}

async function createCollectedCapture(
  tx: DbOrTx,
  ownerId: string,
  collectorSourceId: string,
  runId: string,
  itemId: string,
  p: CollectedCandidate,
  now: Date,
): Promise<{ captureId: string; sourceVersionId: string }> {
  const externalId = `${collectorSourceId}:${p.externalKey}`;
  const found = await tx
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.ownerId, ownerId), eq(sources.externalProvider, COLLECTOR_PROVIDER), eq(sources.externalId, externalId)))
    .orderBy(asc(sources.id))
    .limit(1);
  let sourceId = found[0]?.id;
  if (!sourceId) {
    const [src] = await tx
      .insert(sources)
      .values({ ownerId, kind: 'collector', canonicalUrl: p.link, externalProvider: COLLECTOR_PROVIDER, externalId, checkedAt: now, contentHash: p.rawSha256 })
      .returning();
    sourceId = src!.id;
  }
  const [ver] = await tx
    .insert(sourceVersions)
    .values({ sourceId, rawHash: p.rawSha256, fetchedAt: now, excerpt: p.excerpt || null, extractionState: 'collected' })
    .returning();
  // 원본 바이트 그대로(응답 바이트의 구간 — 디코딩·재인코딩 없음, BOM·CRLF 포함) — DB CHECK·트리거가 sha256 = raw_hash, owner 를 다시 확인한다.
  const raw = Buffer.from(p.rawBytes.buffer, p.rawBytes.byteOffset, p.rawBytes.byteLength);
  await tx.insert(sourceVersionOriginals).values({
    sourceVersionId: ver!.id,
    ownerId,
    format: p.rawFormat,
    byteSize: raw.byteLength,
    sha256: p.rawSha256,
    contentBase64: raw.toString('base64'),
  });
  const rawText = collectedCaptureText(p);
  const [cap] = await tx
    .insert(captures)
    .values({
      ownerId,
      rawText,
      inputType: 'text',
      sourceId,
      receivedAt: now,
      title: p.title,
      commandKey: `collect-${itemId}`,
      contentHash: contentHash(rawText),
      updatedAt: now,
    })
    .returning();
  await tx.insert(captureRevisions).values({
    captureId: cap!.id,
    ownerId,
    revision: cap!.revision,
    userNote: null,
    risk: cap!.risk,
    title: cap!.title,
    changedAt: cap!.updatedAt,
    changedBy: 'owner',
  });
  await recordAudit(tx, {
    ownerId,
    action: 'capture.create',
    entity: 'capture',
    entityId: cap!.id,
    versionOrHash: cap!.contentHash,
    details: { input_type: 'text', has_source: true, origin: COLLECTOR_PROVIDER, collector_run_id: runId },
  });
  return { captureId: cap!.id, sourceVersionId: ver!.id };
}

/** 소재 상세 표시용: 이 소재를 만든 수집 항목(있으면). */
export async function getCollectedOriginForCapture(
  db: DbOrTx,
  ownerId: string,
  captureId: string,
): Promise<{ runId: string; sourceLabel: string | null; sourceUrl: string; link: string | null; publishedText: string | null; acceptedAt: Date | null; sourceVersionId: string | null } | null> {
  if (!isUuid(captureId)) return null;
  const rows = await db
    .select({
      runId: collectedItems.runId,
      sourceLabel: collectorSources.label,
      sourceUrl: collectorSources.url,
      link: collectedItems.link,
      publishedText: collectedItems.publishedText,
      acceptedAt: collectedItems.acceptedAt,
      sourceVersionId: collectedItems.sourceVersionId,
    })
    .from(collectedItems)
    .innerJoin(collectorSources, and(eq(collectorSources.id, collectedItems.sourceId), eq(collectorSources.ownerId, collectedItems.ownerId)))
    .where(and(eq(collectedItems.ownerId, ownerId), eq(collectedItems.captureId, captureId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---- 주기 실행(worker) ----

export interface DueRunsResult {
  /** 실행하지 않은 이유(꺼짐) 또는 null */
  skipped: 'scheduler_off' | 'collector_not_mock' | null;
  ran: number;
  previews: number;
  failed: number;
}

/**
 * 주기 수집: COLLECTOR_MODE=mock 이고 COLLECTOR_SCHEDULER=on 일 때만. 켜진 소스 중 주기가 off 가 아니고 기한이 된 것을 최대 max 개
 * 모의 수집해 **미리보기만** 만든다(소재 0 — 사용자가 /collect 에서 골라야 저장).
 */
export async function runDueCollectorSources(
  db: Db,
  config: Pick<AppConfig, 'COLLECTOR_MODE' | 'COLLECTOR_SCHEDULER'>,
  adapter: CollectorAdapter | null,
  now: Date = new Date(),
  max = 3,
): Promise<DueRunsResult> {
  if (config.COLLECTOR_SCHEDULER !== 'on') return { skipped: 'scheduler_off', ran: 0, previews: 0, failed: 0 };
  if (config.COLLECTOR_MODE !== 'mock' || !adapter) return { skipped: 'collector_not_mock', ran: 0, previews: 0, failed: 0 };
  // 기한 판정을 SQL 에서 먼저 한다(Codex review-T19 P1 :552 — 예전에는 50개로 자른 뒤 기한을 봐서, 기한 전 소스 50개가 앞에 있으면
  // 기한이 지난 소스가 매 tick 빠졌다). 기한 = last_run_at + 주기(daily 24h·weekly 7d), 처음(null)은 즉시. 기한이 오래된 순 → id.
  // 간격은 domain scheduleIntervalMs 와 같은 값(시험이 둘을 대조) — isScheduleDue 로 한 번 더 확인한다.
  const nowIso = now.toISOString();
  const dueAt = sql`(${collectorSources.lastRunAt} + case ${collectorSources.schedule} when 'daily' then interval '24 hours' when 'weekly' then interval '168 hours' end)`;
  // Codex review-FIX-T19 P2 :563 — '7 days' 는 timestamptz 에서 세션 시간대의 달력 일로 더해져 서머타임 전환 주에 168시간과 달라진다.
  // domain scheduleIntervalMs(고정 밀리초)와 같게 시간 단위로만 더한다.
  const cands = await db
    .select()
    .from(collectorSources)
    .where(
      and(
        eq(collectorSources.enabled, true),
        inArray(collectorSources.schedule, ['daily', 'weekly']),
        sql`(${collectorSources.lastRunAt} is null or ${dueAt} <= ${nowIso}::timestamptz)`,
      ),
    )
    .orderBy(sql`${dueAt} asc nulls first`, asc(collectorSources.id))
    .limit(Math.max(max, 0));
  const out: DueRunsResult = { skipped: null, ran: 0, previews: 0, failed: 0 };
  for (const s of cands) {
    if (out.ran >= max) break;
    if (!isScheduleDue(s.schedule as CollectorSchedule, s.lastRunAt, now)) continue;
    const { run } = await runCollectorSource(db, s.ownerId, s.id, adapter, { trigger: 'scheduled', now });
    out.ran++;
    if (run.status === 'preview') out.previews++;
    else out.failed++;
  }
  return out;
}

// ---- 재추천 ----

export async function listArchiveRecommendations(db: DbOrTx, ownerId: string, now: Date = new Date(), limit = 5): Promise<Recommendation[]> {
  const old = new Date(now.getTime() - RECOMMEND_MIN_AGE_DAYS * 86400_000);
  const recent = new Date(now.getTime() - RECOMMEND_RECENT_DAYS * 86400_000);
  const dismissedRows = await db.select({ id: recommendationDismissals.captureId }).from(recommendationDismissals).where(eq(recommendationDismissals.ownerId, ownerId));
  const dismissed = new Set(dismissedRows.map((r) => r.id));
  const candWhere = [eq(captures.ownerId, ownerId), lt(captures.receivedAt, old)];
  if (dismissed.size) candWhere.push(notInArray(captures.id, [...dismissed]));
  const cands = await db
    .select({ id: captures.id, title: captures.title, text: sql<string>`left(${captures.rawText}, 4000)`, receivedAt: captures.receivedAt })
    .from(captures)
    .where(and(...candWhere))
    .orderBy(desc(captures.receivedAt), desc(captures.id))
    .limit(300);
  const collected = await db
    .select({ id: collectedItems.id, title: collectedItems.title, excerpt: collectedItems.excerpt, at: collectedItems.createdAt })
    .from(collectedItems)
    .where(and(eq(collectedItems.ownerId, ownerId), gte(collectedItems.createdAt, recent), inArray(collectedItems.decision, ['new', 'duplicate'])))
    .orderBy(desc(collectedItems.createdAt), desc(collectedItems.id))
    .limit(100);
  const drafts = await db
    .select({ id: contents.id, title: contents.title, body: sql<string>`left(${contentVersions.body}, 4000)`, at: contents.updatedAt })
    .from(contents)
    .leftJoin(contentVersions, eq(contentVersions.id, contents.currentVersionId))
    .where(and(eq(contents.ownerId, ownerId), gte(contents.updatedAt, recent), ne(contents.lifecycle, 'archived')))
    .orderBy(desc(contents.updatedAt), desc(contents.id))
    .limit(50);
  return recommendArchive({
    candidates: cands.map((c) => ({ id: c.id, title: c.title, text: c.text ?? '', receivedAt: c.receivedAt })),
    signals: [
      ...collected.map((c) => ({ kind: 'collected' as const, id: c.id, label: c.title ?? c.excerpt, text: c.excerpt, at: c.at })),
      ...drafts.map((d) => ({ kind: 'draft' as const, id: d.id, label: d.title, text: d.body ?? '', at: d.at })),
    ],
    dismissed,
    now,
    limit,
  });
}

/** 재추천 닫기 — 소재는 바뀌지 않는다. 다른 owner 의 소재면 404. 이미 닫았으면 그대로(멱등). */
export async function dismissRecommendation(db: Db, ownerId: string, captureId: string, now: Date = new Date()): Promise<{ dismissed: boolean }> {
  if (!isUuid(captureId.toLowerCase())) throw new NotFoundError('소재를 찾을 수 없습니다');
  const id = captureId.toLowerCase();
  const own = await db.select({ id: captures.id }).from(captures).where(and(eq(captures.id, id), eq(captures.ownerId, ownerId))).limit(1);
  if (!own[0]) throw new NotFoundError('소재를 찾을 수 없습니다');
  const rows = await db.insert(recommendationDismissals).values({ ownerId, captureId: id, dismissedAt: now }).onConflictDoNothing().returning();
  if (rows[0]) await recordAudit(db, { ownerId, action: 'recommendation.dismiss', entity: 'capture', entityId: id, details: {} });
  return { dismissed: true };
}

/** 표시용: 받아들인 수집 항목 수(소스별). */
export async function acceptedCountsBySource(db: DbOrTx, ownerId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ sourceId: collectedItems.sourceId, n: sql<number>`count(*)::int` })
    .from(collectedItems)
    .where(and(eq(collectedItems.ownerId, ownerId), isNotNull(collectedItems.captureId)))
    .groupBy(collectedItems.sourceId);
  return new Map(rows.map((r) => [r.sourceId, r.n]));
}
