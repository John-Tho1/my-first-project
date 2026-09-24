/**
 * T09 채널별 파생본(variants) 쿼리(결정 D14). 모든 함수는 ownerId 를 WHERE 에 넣는다(A01) — 다른 owner 의 원고·파생본·파일은 404.
 *
 * 불변식
 * - variant_versions·variant_assets 는 추가만(DB 트리거). 새 버전 번호 = 그 파생본의 최대+1(AI 제안 포함).
 * - 잠금 순서: 원고(lockContentForWrite) → 파생본(FOR UPDATE) → (예약 시) users. 다른 쓰기 경로와 같은 순서라 교착이 없다.
 * - stale 은 저장하지 않는다: 현재 버전의 content_version_id ≠ 원고의 현재 버전.
 * - 사용자 수정·첨부 변경·AI 제안 채택은 새 현재 버전을 만들고 lifecycle 을 draft 로 되돌린다(다시 검토 필요).
 * - AI 초안(모의)은 현재가 아닌 버전(created_by='ai:mock')으로만 저장되고, 채택해야 현재가 된다. 자동 재생성은 없다.
 * - 검토(review)로 가려면: 현재 버전 있음 · stale 아님 · 채널 필수 미디어 완성 · 원고와 이 파생본의 미해결 경험 claim 없음(A03).
 * - 게시·승인·배포 작업은 만들지 않는다(PUBLISH_MODE=disabled, M3 이후).
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AppError,
  assistInputVersion,
  BadRequestError,
  buildAssistPrompt,
  channelDraft,
  CHANNEL_LABEL,
  estimateTokens,
  sanitizeLlmOutput,
  isUuid,
  isVariantStale,
  LlmFailedError,
  llmStructuredOutputSchema,
  MAX_PROPOSAL_BODY,
  MediaIncompleteError,
  mediaCompleteness,
  NotFoundError,
  parseChannelMetadata,
  roleMatchesMime,
  StaleBaseError,
  StaleVariantError,
  unconfirmedExperienceClaims,
  UnconfirmedExperienceClaimsError,
  VariantVersionConflictError,
  type BudgetPolicy,
  type Channel,
  type SanitizedClaim,
  type SanitizedOutput,
  type LlmStructuredOutput,
  type MediaCompleteness,
  type VariantRole,
} from '@cs/domain';
import { insertClaims, insertReservedLedger, reserveOrThrow, settleLedgerFailed, settleLedgerSucceeded, type UsageLedgerRow } from './budget';
import { claimsOf, listUnconfirmedExperienceClaims } from './claims-gate';
import type { Db } from './client';
import { lockContentForWrite, type ContentRow, type ContentVersionRow } from './contents';
import { recordAudit, type DbOrTx } from './queries';
import { assets, claimConfirmations, generationRuns, variantAssets, variants, variantVersions } from './schema';
import { getCurrentBrandProfile, promptBrand, type AssistLlm, type AssistLlmInput, type GenerationRunRow } from './writing';

export type VariantRow = typeof variants.$inferSelect;
export type VariantVersionRow = typeof variantVersions.$inferSelect;
export type VariantAssetRow = typeof variantAssets.$inferSelect;

const VARIANT_NOT_FOUND = '채널 초안을 찾을 수 없습니다';
export const VARIANT_PROMPT_VERSION = 't09-variant-v1';

const MOCK_UNPRICED: BudgetPolicy = { mode: 'mock', currency: 'USD', pricing: null, monthlyLimitMicro: null, perRunMaxMicro: null };

export interface AttachedAsset {
  position: number;
  role: string;
  assetId: string;
  mime: string;
  bytes: number;
  checksum: string;
  key: string;
}

// ---- 조회 ----

async function getVariantRow(db: DbOrTx, ownerId: string, variantId: string): Promise<VariantRow | null> {
  if (!isUuid(variantId)) return null;
  const rows = await db
    .select()
    .from(variants)
    .where(and(eq(variants.id, variantId), eq(variants.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

async function getVersionRow(db: DbOrTx, ownerId: string, versionId: string | null): Promise<VariantVersionRow | null> {
  if (!versionId || !isUuid(versionId)) return null;
  const rows = await db
    .select()
    .from(variantVersions)
    .where(and(eq(variantVersions.id, versionId), eq(variantVersions.ownerId, ownerId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function attachedAssets(db: DbOrTx, ownerId: string, versionId: string): Promise<AttachedAsset[]> {
  const rows = await db
    .select({
      position: variantAssets.position,
      role: variantAssets.role,
      assetId: assets.id,
      mime: assets.mime,
      bytes: assets.bytes,
      checksum: assets.checksum,
      key: assets.key,
    })
    .from(variantAssets)
    .innerJoin(assets, and(eq(assets.id, variantAssets.assetId), eq(assets.ownerId, variantAssets.ownerId)))
    .where(and(eq(variantAssets.variantVersionId, versionId), eq(variantAssets.ownerId, ownerId)))
    .orderBy(asc(variantAssets.position));
  return rows;
}

async function nextVariantVersion(tx: DbOrTx, variantId: string): Promise<number> {
  const rows = await tx
    .select({ max: sql<number>`coalesce(max(${variantVersions.version}), 0)::int` })
    .from(variantVersions)
    .where(eq(variantVersions.variantId, variantId));
  return (rows[0]?.max ?? 0) + 1;
}

interface Locked {
  variant: VariantRow;
  content: ContentRow;
  contentCurrent: ContentVersionRow;
  current: VariantVersionRow | null;
}

/** 원고 → 파생본 순서로 잠근다. 다른 owner·없는 ID → 404. */
async function lockVariant(tx: DbOrTx, ownerId: string, variantId: string): Promise<Locked> {
  const peek = await getVariantRow(tx, ownerId, variantId);
  if (!peek) throw new NotFoundError(VARIANT_NOT_FOUND);
  const { content, current: contentCurrent } = await lockContentForWrite(tx, ownerId, peek.contentId);
  const rows = await tx
    .select()
    .from(variants)
    .where(and(eq(variants.id, peek.id), eq(variants.ownerId, ownerId)))
    .for('update')
    .limit(1);
  const variant = rows[0];
  if (!variant) throw new NotFoundError(VARIANT_NOT_FOUND);
  const current = await getVersionRow(tx, ownerId, variant.currentVersionId);
  return { variant, content, contentCurrent, current };
}

/** 원고 잠금 안에서: 채널 파생본을 가져오거나 만든다(동시 생성은 unique(content_id, channel) 로 하나). */
async function ensureVariant(tx: DbOrTx, ownerId: string, contentId: string, channel: Channel, now: Date): Promise<VariantRow> {
  await tx.insert(variants).values({ ownerId, contentId, channel, lifecycle: 'draft', createdAt: now, updatedAt: now }).onConflictDoNothing({
    target: [variants.contentId, variants.channel],
  });
  const rows = await tx
    .select()
    .from(variants)
    .where(and(eq(variants.contentId, contentId), eq(variants.channel, channel), eq(variants.ownerId, ownerId)))
    .for('update')
    .limit(1);
  const v = rows[0];
  if (!v) throw new NotFoundError(VARIANT_NOT_FOUND);
  return v;
}

const baseOf = (current: VariantVersionRow | null) => current?.version ?? 0;

function assertBase(current: VariantVersionRow | null, baseVersion: number, yours: Record<string, unknown>) {
  if (baseOf(current) !== baseVersion) {
    throw new VariantVersionConflictError({
      current: current ? { version: current.version, body: current.body, metadata: current.metadataJson } : null,
      yours: { base_version: baseVersion, ...yours },
    });
  }
}

/** 새 현재 버전 추가 + 첨부 복사/지정 + lifecycle draft. */
async function insertCurrentVariantVersion(
  tx: DbOrTx,
  ownerId: string,
  variant: VariantRow,
  v: { contentVersionId: string; body: string; metadata: Record<string, unknown>; createdBy: 'owner'; aiRunId: string | null },
  attach: ReadonlyArray<{ assetId: string; position: number; role: string }>,
  now: Date,
): Promise<VariantVersionRow> {
  const inserted = await tx
    .insert(variantVersions)
    .values({
      ownerId,
      variantId: variant.id,
      version: await nextVariantVersion(tx, variant.id),
      contentVersionId: v.contentVersionId,
      body: v.body,
      metadataJson: v.metadata,
      createdBy: v.createdBy,
      aiRunId: v.aiRunId,
      createdAt: now,
    })
    .returning();
  const version = inserted[0]!;
  for (const a of attach) {
    await tx.insert(variantAssets).values({ ownerId, variantVersionId: version.id, assetId: a.assetId, position: a.position, role: a.role });
  }
  const updated = await tx
    .update(variants)
    .set({ currentVersionId: version.id, lifecycle: 'draft', updatedAt: now })
    .where(and(eq(variants.id, variant.id), eq(variants.ownerId, ownerId)))
    .returning();
  if (!updated[0]) throw new Error('채널 초안 갱신에 실패했습니다');
  return version;
}

async function carriedAssets(tx: DbOrTx, ownerId: string, current: VariantVersionRow | null) {
  if (!current) return [];
  return (await attachedAssets(tx, ownerId, current.id)).map((a) => ({ assetId: a.assetId, position: a.position, role: a.role }));
}

// ---- 만들기(결정적 초안) ----

/**
 * 원고의 **현재** 버전에서 채널 초안을 만든다(결정적 변환). base_version ≠ 원고 현재 버전 → 409 stale_base.
 * 파생본이 없으면 만든다. 기존 첨부는 새 버전으로 이어진다.
 */
export async function createVariantDraft(
  db: Db,
  ownerId: string,
  contentId: string,
  input: { channel: Channel; baseVersion: number },
  now: Date = new Date(),
): Promise<{ variant: VariantRow; version: VariantVersionRow }> {
  return db.transaction(async (tx) => {
    const { content, current } = await lockContentForWrite(tx, ownerId, contentId);
    if (input.baseVersion !== current.version) {
      throw new StaleBaseError({
        current: { version: current.version, body: current.body, created_at: current.createdAt.toISOString() },
        yours: { base_version: input.baseVersion },
      });
    }
    const variant = await ensureVariant(tx, ownerId, content.id, input.channel, now);
    const prev = await getVersionRow(tx, ownerId, variant.currentVersionId);
    const d = channelDraft(input.channel, content.title, current.body);
    const version = await insertCurrentVariantVersion(
      tx,
      ownerId,
      variant,
      { contentVersionId: current.id, body: d.body, metadata: d.metadata, createdBy: 'owner', aiRunId: null },
      await carriedAssets(tx, ownerId, prev),
      now,
    );
    await recordAudit(tx, {
      ownerId,
      action: 'variant.version_create',
      entity: 'variant',
      entityId: variant.id,
      versionOrHash: String(version.version),
      details: { channel: input.channel, source: 'draft', content_version: current.version },
      at: now,
    });
    return { variant: (await getVariantRow(tx, ownerId, variant.id))!, version };
  });
}

// ---- AI 초안(모의) ----

export interface VariantAssistResult {
  variant: VariantRow;
  run: GenerationRunRow;
  proposal: VariantVersionRow;
  output: SanitizedOutput;
  claims: SanitizedClaim[];
  ledger: UsageLedgerRow;
}

function variantPrompt(channel: Channel, base: string): string {
  return `${base}\n## 채널\n${CHANNEL_LABEL[channel]}(${channel}) 형식의 초안을 제안하세요. 원고에 없는 경험·수치·출처를 보태지 마세요.\n`;
}

/**
 * 채널 초안 AI 제안(모의). 원고의 현재 버전·현재 Brand Profile 로 입력을 고정하고 예산을 예약한 뒤 호출한다(T07 과 같은 규칙).
 * 결과는 현재가 아닌 variant_version(created_by='ai:mock')이며 채택해야 현재가 된다. 실패하면 run failed·원장 전액 확정·버전 없음.
 */
export async function runVariantAssist(
  db: Db,
  ownerId: string,
  contentId: string,
  input: { channel: Channel; baseVersion: number; budget?: BudgetPolicy },
  llm: AssistLlm,
  now: Date = new Date(),
): Promise<VariantAssistResult> {
  const policy = input.budget ?? MOCK_UNPRICED;
  const prep = await db.transaction(async (tx) => {
    const { content, current } = await lockContentForWrite(tx, ownerId, contentId);
    if (input.baseVersion !== current.version) {
      throw new StaleBaseError({
        current: { version: current.version, body: current.body, created_at: current.createdAt.toISOString() },
        yours: { base_version: input.baseVersion },
      });
    }
    const brand = await getCurrentBrandProfile(tx, ownerId);
    if (!brand) throw new BadRequestError('브랜드 프로필이 없습니다. /brand 에서 먼저 저장하세요.');
    const variant = await ensureVariant(tx, ownerId, content.id, input.channel, now);
    const inputVersion = `${assistInputVersion({ contentVersionId: current.id, brandProfileVersion: brand.version, answerIds: [] })};ch:${input.channel}`;
    const prompt = variantPrompt(
      input.channel,
      buildAssistPrompt({ mode: 'draft', inputVersion, brand: promptBrand(brand), answers: [], title: content.title, body: current.body }),
    );
    const reservation = await reserveOrThrow(tx, ownerId, policy, prompt, now);
    const runs = await tx
      .insert(generationRuns)
      .values({
        ownerId,
        contentId: content.id,
        mode: 'variant',
        variantId: variant.id,
        inputVersionId: current.id,
        brandProfileId: brand.id,
        inputVersionRefs: {
          content_version_id: current.id,
          content_version: current.version,
          brand_profile_id: brand.id,
          brand_profile_version: brand.version,
          answer_ids: [],
          source_version_ids: [],
          channel: input.channel,
          input_version: inputVersion,
        },
        promptVersion: VARIANT_PROMPT_VERSION,
        provider: llm.name,
        model: llm.mode === 'mock' ? 'mock' : llm.name,
        status: 'running',
        createdAt: now,
      })
      .returning();
    const run = runs[0]!;
    const ledger = await insertReservedLedger(tx, ownerId, run.id, policy, reservation, now);
    return { content, current, variant, run, ledger, inputVersion, prompt, reservation };
  });

  const llmInput: AssistLlmInput = {
    task: 'draft',
    inputVersion: prep.inputVersion,
    text: prep.current.body,
    prompt: prep.prompt,
    allowedSourceRefs: [],
    maxOutputTokens: prep.reservation.tokensOutAllowance,
  };
  let output: LlmStructuredOutput;
  try {
    output = llmStructuredOutputSchema.parse(await llm.generate(llmInput));
    if (output.input_version !== prep.inputVersion) throw new AppError('bad_request', 'input_version_mismatch', '입력 버전이 다른 응답');
    if (output.proposed_text.length > MAX_PROPOSAL_BODY) throw new AppError('bad_request', 'proposal_too_large', '제안이 너무 깁니다');
  } catch (e) {
    const finished = new Date(Math.max(Date.now(), now.getTime()));
    const code = e instanceof Error && e.name === 'MockLlmFailure' ? 'mock_injected_failure' : e instanceof AppError ? e.code : 'provider_error';
    await db.transaction(async (tx) => {
      await tx
        .update(generationRuns)
        .set({ status: 'failed', error: code, finishedAt: finished })
        .where(and(eq(generationRuns.id, prep.run.id), eq(generationRuns.ownerId, ownerId), eq(generationRuns.status, 'running')));
      await settleLedgerFailed(tx, ownerId, prep.ledger, finished);
      await recordAudit(tx, {
        ownerId,
        action: 'variant.assist',
        entity: 'variant',
        entityId: prep.variant.id,
        versionOrHash: prep.run.id,
        details: { channel: input.channel, status: 'failed', provider: llm.name, error: code },
        at: finished,
      });
    });
    throw new LlmFailedError();
  }

  const finished = new Date(Math.max(Date.now(), now.getTime()));
  // FIX-T07(P1): 정제한 출력 하나를 제안·output_json·claims·응답에 쓴다(채널 초안에는 허용 출처가 없으므로 모든 참조가 버려진다).
  const { output: clean, droppedTotal } = sanitizeLlmOutput(output, []);
  return db.transaction(async (tx) => {
    const { variant } = await lockVariant(tx, ownerId, prep.variant.id);
    const d = channelDraft(input.channel, prep.content.title, clean.proposed_text);
    const inserted = await tx
      .insert(variantVersions)
      .values({
        ownerId,
        variantId: variant.id,
        version: await nextVariantVersion(tx, variant.id),
        contentVersionId: prep.current.id,
        body: d.body,
        metadataJson: d.metadata,
        createdBy: `ai:${llm.mode}`,
        aiRunId: prep.run.id,
        createdAt: finished,
      })
      .returning();
    const proposal = inserted[0]!;
    await insertClaims(tx, ownerId, prep.run.id, prep.current.id, clean.claims, new Map(), finished, proposal.id);
    const usage = llm.usageOf?.(llmInput, output) ?? { tokensIn: estimateTokens(prep.prompt), tokensOut: estimateTokens(output.proposed_text) };
    const ledger = await settleLedgerSucceeded(tx, ownerId, prep.ledger, policy.pricing, usage, finished);
    const updated = await tx
      .update(generationRuns)
      .set({
        status: 'succeeded',
        outputJson: {
          result_type: clean.result_type,
          input_version: clean.input_version,
          proposed_tags: clean.proposed_tags,
          claims: clean.claims.map((c) => ({
            text: c.text,
            kind: c.kind,
            source_refs: c.source_refs,
            needs_user_confirmation: c.needs_user_confirmation,
            dropped_source_refs: c.dropped_source_refs,
            needs_check: c.needs_check,
          })),
          followup_questions: clean.followup_questions,
          warnings: clean.warnings,
          variant_version_id: proposal.id,
          ...(ledger.overBudget ? { over_budget: true } : {}),
        },
        finishedAt: finished,
      })
      .where(and(eq(generationRuns.id, prep.run.id), eq(generationRuns.ownerId, ownerId), eq(generationRuns.status, 'running')))
      .returning();
    if (!updated[0]) throw new Error('AI 실행 기록 갱신에 실패했습니다');
    await recordAudit(tx, {
      ownerId,
      action: 'variant.assist',
      entity: 'variant',
      entityId: variant.id,
      versionOrHash: prep.run.id,
      details: {
        channel: input.channel,
        status: 'succeeded',
        provider: llm.name,
        proposal_version: proposal.version,
        claims: clean.claims.length,
        dropped_source_refs: droppedTotal,
        over_budget: ledger.overBudget,
      },
      at: finished,
    });
    return { variant, run: updated[0], proposal, output: clean, claims: clean.claims, ledger };
  });
}

// ---- 사용자 수정·채택·첨부 ----

/** 사용자 수정: 새 현재 버전(원래 버전의 원고 버전을 그대로 — 수정만으로 stale 이 풀리지 않는다). 첨부는 이어진다. */
export async function appendVariantVersion(
  db: Db,
  ownerId: string,
  variantId: string,
  input: { baseVersion: number; body: string; metadata: Record<string, unknown> },
  now: Date = new Date(),
): Promise<{ variant: VariantRow; version: VariantVersionRow }> {
  return db.transaction(async (tx) => {
    const { variant, contentCurrent, current } = await lockVariant(tx, ownerId, variantId);
    assertBase(current, input.baseVersion, { body: input.body, metadata: input.metadata });
    const metadata = parseChannelMetadata(variant.channel as Channel, input.metadata);
    const version = await insertCurrentVariantVersion(
      tx,
      ownerId,
      variant,
      // ai_run_id 는 이어받는다: 채택한 AI 제안을 고쳐도 그 제안의 미해결 경험 claim 이 검토 게이트에서 사라지지 않게(A03).
      {
        contentVersionId: current?.contentVersionId ?? contentCurrent.id,
        body: input.body,
        metadata,
        createdBy: 'owner',
        aiRunId: current?.aiRunId ?? null,
      },
      await carriedAssets(tx, ownerId, current),
      now,
    );
    await recordAudit(tx, {
      ownerId,
      action: 'variant.version_create',
      entity: 'variant',
      entityId: variant.id,
      versionOrHash: String(version.version),
      details: { channel: variant.channel, source: 'edit', base_version: input.baseVersion },
      at: now,
    });
    return { variant: (await getVariantRow(tx, ownerId, variant.id))!, version };
  });
}

/**
 * AI 제안 채택: 제안 본문·메타데이터로 새 사용자 버전(ai_run_id 유지)을 현재로. 제안이 원고의 현재 버전에서 나오지 않았으면 409 stale_base.
 */
export async function adoptVariantProposal(
  db: Db,
  ownerId: string,
  variantId: string,
  proposalId: string,
  baseVersion: number,
  now: Date = new Date(),
): Promise<{ variant: VariantRow; version: VariantVersionRow }> {
  return db.transaction(async (tx) => {
    const { variant, contentCurrent, current } = await lockVariant(tx, ownerId, variantId);
    const proposal = await getVersionRow(tx, ownerId, proposalId.toLowerCase());
    if (!proposal || proposal.variantId !== variant.id) throw new NotFoundError('AI 제안을 찾을 수 없습니다');
    if (!proposal.createdBy.startsWith('ai:') || proposal.id === current?.id) {
      throw new AppError('conflict', 'run_not_adoptable', '채택할 수 있는 AI 제안이 아닙니다');
    }
    assertBase(current, baseVersion, { proposal_id: proposal.id });
    if (proposal.contentVersionId !== contentCurrent.id) {
      throw new StaleBaseError({
        current: { version: contentCurrent.version, body: contentCurrent.body, created_at: contentCurrent.createdAt.toISOString() },
        yours: { base_version: baseVersion, proposal_id: proposal.id },
      });
    }
    const version = await insertCurrentVariantVersion(
      tx,
      ownerId,
      variant,
      { contentVersionId: proposal.contentVersionId, body: proposal.body, metadata: proposal.metadataJson, createdBy: 'owner', aiRunId: proposal.aiRunId },
      await carriedAssets(tx, ownerId, current),
      now,
    );
    await recordAudit(tx, {
      ownerId,
      action: 'variant.adopt_ai',
      entity: 'variant',
      entityId: variant.id,
      versionOrHash: String(version.version),
      details: { channel: variant.channel, proposal_version: proposal.version, base_version: baseVersion },
      at: now,
    });
    return { variant: (await getVariantRow(tx, ownerId, variant.id))!, version };
  });
}

/**
 * 첨부 지정: 현재 버전을 본문·메타데이터 그대로 복사한 새 버전에 첨부 목록을 붙인다(목록 전체 교체).
 * 파일은 이 owner 의 것이어야 한다(아니면 404, 복합 FK 도 막는다). 역할·형식 불일치·순서 중복 → 400.
 */
export async function setVariantAssets(
  db: Db,
  ownerId: string,
  variantId: string,
  input: { baseVersion: number; assets: ReadonlyArray<{ assetId: string; position: number; role: VariantRole }> },
  now: Date = new Date(),
): Promise<{ variant: VariantRow; version: VariantVersionRow }> {
  return db.transaction(async (tx) => {
    const { variant, current } = await lockVariant(tx, ownerId, variantId);
    if (!current) throw new AppError('conflict', 'no_current_version', '먼저 채널 초안을 만드세요');
    assertBase(current, input.baseVersion, { assets: input.assets });
    const ids = input.assets.map((a) => a.assetId.toLowerCase());
    if (ids.some((i) => !isUuid(i))) throw new BadRequestError('asset_id 형식이 올바르지 않습니다');
    if (new Set(input.assets.map((a) => a.position)).size !== input.assets.length) throw new BadRequestError('첨부 순서(position)가 겹칩니다');
    const found = ids.length
      ? await tx
          .select({ id: assets.id, mime: assets.mime })
          .from(assets)
          .where(and(eq(assets.ownerId, ownerId), inArray(assets.id, [...new Set(ids)])))
      : [];
    const mimeOf = new Map(found.map((f) => [f.id, f.mime]));
    if (ids.some((i) => !mimeOf.has(i))) throw new NotFoundError('파일을 찾을 수 없습니다');
    input.assets.forEach((a, k) => {
      if (!roleMatchesMime(a.role, mimeOf.get(ids[k]!)!)) {
        throw new AppError('bad_request', 'asset_role_mismatch', `파일 형식이 역할(${a.role})과 맞지 않습니다`);
      }
    });
    const version = await insertCurrentVariantVersion(
      tx,
      ownerId,
      variant,
      { contentVersionId: current.contentVersionId, body: current.body, metadata: current.metadataJson, createdBy: 'owner', aiRunId: current.aiRunId },
      input.assets.map((a, k) => ({ assetId: ids[k]!, position: a.position, role: a.role })),
      now,
    );
    await recordAudit(tx, {
      ownerId,
      action: 'variant.assets',
      entity: 'variant',
      entityId: variant.id,
      versionOrHash: String(version.version),
      details: { channel: variant.channel, count: input.assets.length, roles: input.assets.map((a) => a.role).join(',') },
      at: now,
    });
    return { variant: (await getVariantRow(tx, ownerId, variant.id))!, version };
  });
}

/** 폼용: 현재 첨부 뒤에 한 개를 덧붙인 목록. */
export async function appendedAssetList(db: DbOrTx, ownerId: string, variantId: string, assetId: string, role: VariantRole) {
  const v = await getVariantRow(db, ownerId, variantId);
  if (!v) throw new NotFoundError(VARIANT_NOT_FOUND);
  const current = await getVersionRow(db, ownerId, v.currentVersionId);
  const list = current ? await attachedAssets(db, ownerId, current.id) : [];
  const next = list.reduce((m, a) => Math.max(m, a.position), 0) + 1;
  return {
    baseVersion: current?.version ?? 0,
    assets: [...list.map((a) => ({ assetId: a.assetId, position: a.position, role: a.role as VariantRole })), { assetId, position: next, role }],
  };
}

// ---- 검토 상태·게이트 ----

/** 파생본 현재 버전의 AI run(채택으로 이어진 run)에 미해결 경험 claim 이 있는가 — 판정은 이 파생본의 현재 본문 기준. */
async function unresolvedVariantClaims(tx: DbOrTx, ownerId: string, current: VariantVersionRow) {
  if (!current.aiRunId) return [];
  const runRows = await tx
    .select({ id: generationRuns.id, outputJson: generationRuns.outputJson })
    .from(generationRuns)
    .where(and(eq(generationRuns.id, current.aiRunId), eq(generationRuns.ownerId, ownerId), eq(generationRuns.status, 'succeeded')))
    .limit(1);
  const run = runRows[0];
  if (!run) return [];
  const confirmations = await tx
    .select({ runId: claimConfirmations.runId, claimIndex: claimConfirmations.claimIndex, resolution: claimConfirmations.resolution })
    .from(claimConfirmations)
    .where(and(eq(claimConfirmations.ownerId, ownerId), eq(claimConfirmations.runId, run.id)));
  return unconfirmedExperienceClaims([{ runId: run.id, adopted: true, claims: claimsOf(run.outputJson) }], confirmations, current.body);
}

/**
 * draft ↔ review. review 조건: 현재 버전 있음, stale 아님(409 stale_variant), 채널 필수 미디어(409 media_incomplete),
 * 원고·이 파생본의 미해결 경험 claim 없음(409 unconfirmed_experience_claims, A03). base_version = 현재 파생본 버전.
 */
export async function setVariantLifecycle(
  db: Db,
  ownerId: string,
  variantId: string,
  input: { lifecycle: 'draft' | 'review'; baseVersion: number },
  now: Date = new Date(),
): Promise<VariantRow> {
  return db.transaction(async (tx) => {
    const { variant, content, contentCurrent, current } = await lockVariant(tx, ownerId, variantId);
    if (!current) throw new AppError('conflict', 'no_current_version', '먼저 채널 초안을 만드세요');
    assertBase(current, input.baseVersion, { lifecycle: input.lifecycle });
    if (input.lifecycle === 'review' && variant.lifecycle !== 'review') {
      if (isVariantStale(current.contentVersionId, contentCurrent.id)) throw new StaleVariantError();
      const media = mediaCompleteness(variant.channel as Channel, await attachedAssets(tx, ownerId, current.id));
      if (!media.complete) throw new MediaIncompleteError(media.missing);
      const pending = [...(await listUnconfirmedExperienceClaims(tx, ownerId, content.id)), ...(await unresolvedVariantClaims(tx, ownerId, current))];
      if (pending.length > 0) throw new UnconfirmedExperienceClaimsError(pending);
    }
    const updated = await tx
      .update(variants)
      .set({ lifecycle: input.lifecycle, updatedAt: now })
      .where(and(eq(variants.id, variant.id), eq(variants.ownerId, ownerId)))
      .returning();
    await recordAudit(tx, {
      ownerId,
      action: 'variant.lifecycle',
      entity: 'variant',
      entityId: variant.id,
      versionOrHash: String(current.version),
      details: { channel: variant.channel, from: variant.lifecycle, to: input.lifecycle },
      at: now,
    });
    return updated[0]!;
  });
}

// ---- 화면·API 보기 ----

export interface VariantState {
  variant: VariantRow;
  current: VariantVersionRow | null;
  assets: AttachedAsset[];
  stale: boolean;
  media: MediaCompleteness;
  /** 현재 버전보다 나중의(채택하지 않은) AI 제안 중 가장 최근 */
  proposal: VariantVersionRow | null;
  unresolvedClaims: Array<{ run_id: string; claim_index: number; text: string }>;
}

/** 원고의 채널 파생본 전체(채널 순서). 다른 owner 의 원고면 빈 배열. */
export async function listVariantStates(db: DbOrTx, ownerId: string, contentId: string, contentCurrentVersionId: string): Promise<VariantState[]> {
  if (!isUuid(contentId)) return [];
  const rows = await db
    .select()
    .from(variants)
    .where(and(eq(variants.contentId, contentId), eq(variants.ownerId, ownerId)))
    .orderBy(asc(variants.channel));
  const out: VariantState[] = [];
  for (const variant of rows) {
    const current = await getVersionRow(db, ownerId, variant.currentVersionId);
    const list = current ? await attachedAssets(db, ownerId, current.id) : [];
    const proposals = await db
      .select()
      .from(variantVersions)
      .where(and(eq(variantVersions.variantId, variant.id), eq(variantVersions.ownerId, ownerId), sql`${variantVersions.createdBy} like 'ai:%'`))
      .orderBy(desc(variantVersions.version))
      .limit(1);
    const p = proposals[0] ?? null;
    out.push({
      variant,
      current,
      assets: list,
      stale: current ? isVariantStale(current.contentVersionId, contentCurrentVersionId) : false,
      media: mediaCompleteness(variant.channel as Channel, list),
      proposal: p && (!current || p.version > current.version) ? p : null,
      unresolvedClaims: current ? await unresolvedVariantClaims(db, ownerId, current) : [],
    });
  }
  return out;
}

export async function getVariantState(db: DbOrTx, ownerId: string, variantId: string, contentCurrentVersionId: string) {
  const v = await getVariantRow(db, ownerId, variantId);
  if (!v) return null;
  return (await listVariantStates(db, ownerId, v.contentId, contentCurrentVersionId)).find((s) => s.variant.id === v.id) ?? null;
}

export function variantVersionView(v: VariantVersionRow) {
  return {
    id: v.id,
    variant_id: v.variantId,
    version: v.version,
    content_version_id: v.contentVersionId,
    body: v.body,
    metadata: v.metadataJson,
    created_by: v.createdBy,
    ai_run_id: v.aiRunId,
    created_at: v.createdAt.toISOString(),
  };
}

export function variantStateView(s: VariantState) {
  return {
    id: s.variant.id,
    content_id: s.variant.contentId,
    channel: s.variant.channel,
    lifecycle: s.variant.lifecycle,
    stale: s.stale,
    media: s.media,
    current_version: s.current ? variantVersionView(s.current) : null,
    assets: s.assets.map((a) => ({ position: a.position, role: a.role, asset_id: a.assetId, mime: a.mime, bytes: a.bytes, sha256: a.checksum })),
    proposal: s.proposal ? variantVersionView(s.proposal) : null,
    unresolved_claims: s.unresolvedClaims,
    updated_at: s.variant.updatedAt.toISOString(),
  };
}

/** 원고 id 로 파생본이 속한 원고를 찾는다(라우트에서 현재 원고 버전을 얻을 때). */
export async function variantContentId(db: DbOrTx, ownerId: string, variantId: string): Promise<string | null> {
  return (await getVariantRow(db, ownerId, variantId))?.contentId ?? null;
}
