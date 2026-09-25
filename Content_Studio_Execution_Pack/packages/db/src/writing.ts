/**
 * T06 작성 지원 쿼리(결정 D12): Brand Profile 버전, 인터뷰 답변, AI 작성 보조(assist)·채택·경험 claim 확인.
 * 모든 함수는 ownerId 를 WHERE 에 넣는다(A01) — 다른 owner 의 원고·run·답변은 "없음"(404)으로 응답한다.
 *
 * 불변식
 * - brand_profiles: 새 버전은 append(최대+1). 기존 버전 UPDATE 없음. base_version 이 현재와 다르면 409.
 * - interview_answers·claim_confirmations: 추가만(DB 트리거). 답변·확인은 사용자 입력만 — AI 결과로 만들지 않는다.
 * - assist: 입력 버전(현재 본문 버전·브랜드 버전·답변 ID)을 고정해 run 을 남기고, 성공하면 제안을 **현재가 아닌**
 *   새 버전(created_by='ai:mock', ai_run_id)으로 저장한다. contents.current_version_id 는 바꾸지 않는다(원문 보존).
 *   실패하면 run=failed, 버전 없음, 본문 그대로.
 * - 채택: 제안 본문으로 새 사용자 버전(created_by='owner', ai_run_id=run)을 만들고 현재 버전으로 옮긴다.
 *   run 의 입력 버전이 현재 버전이 아니면(그 사이 본문이 바뀜·이미 채택) 409 stale_base.
 */
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  ASSIST_RESULT_TYPE,
  assistInputVersion,
  assistMaterial,
  BadRequestError,
  BrandVersionConflictError,
  bodyContainsClaim,
  buildAssistPrompt,
  ClaimStillInBodyError,
  claimNeedsConfirmation,
  interviewQuestion,
  INTERVIEW_KEYS,
  isUuid,
  llmStructuredOutputSchema,
  LlmFailedError,
  MAX_PROPOSAL_BODY,
  NotFoundError,
  promptVersionFor,
  estimateTokens,
  sanitizeLlmOutput,
  renderVariantText,
  type Channel,
  type BudgetPolicy,
  type SanitizedClaim,
  type SanitizedOutput,
  type Reservation,
  AppError,
  StaleBaseError,
  UnconfirmedExperienceClaimsError,
  type AssistMode,
  type BrandProfileCreateInput,
  type InterviewAnswersInput,
  type LlmStructuredOutput,
  type PromptAnswer,
  type PromptBrand,
  type UnconfirmedClaim,
} from '@cs/domain';
import type { Db } from './client';
import {
  allowedSourceVersions,
  insertClaims,
  insertReservedLedger,
  reserveOrThrow,
  settleLedgerFailed,
  settleLedgerSucceeded,
  type UsageLedgerRow,
} from './budget';
import { claimsOf, listUnconfirmedExperienceClaims } from './claims-gate';
import { insertCurrentVersion, lockContentForWrite, nextVersionNumber, type ContentRow, type ContentVersionRow } from './contents';
import { recordAudit, type DbOrTx } from './queries';
import {
  brandProfiles,
  claimConfirmations,
  contentVersions,
  generationRuns,
  interviewAnswers,
  users,
  variants,
  variantVersions,
} from './schema';

/**
 * T09: 파생본의 현재 버전에서 실제로 나가는 글 전체(owner 범위). 없으면 undefined.
 * FIX-T09(P0): 본문만이 아니라 채널 메타데이터(캡션·카드·Markdown·설명·태그 등)까지 합친 renderVariantText.
 */
export async function variantCurrentBody(tx: DbOrTx, ownerId: string, variantId: string): Promise<string | undefined> {
  const rows = await tx
    .select({ body: variantVersions.body, metadata: variantVersions.metadataJson, channel: variants.channel })
    .from(variants)
    .innerJoin(variantVersions, and(eq(variantVersions.id, variants.currentVersionId), eq(variantVersions.variantId, variants.id)))
    .where(and(eq(variants.id, variantId), eq(variants.ownerId, ownerId)))
    .limit(1);
  const r = rows[0];
  return r ? renderVariantText(r.channel as Channel, r.body, r.metadata) : undefined;
}

export type BrandProfileRow = typeof brandProfiles.$inferSelect;
export type InterviewAnswerRow = typeof interviewAnswers.$inferSelect;
export type GenerationRunRow = typeof generationRuns.$inferSelect;
export type ClaimConfirmationRow = typeof claimConfirmations.$inferSelect;
export type ClaimResolution = 'confirmed' | 'removed';

const CONTENT_NOT_FOUND = '원고를 찾을 수 없습니다';
const RUN_NOT_FOUND = 'AI 제안 기록을 찾을 수 없습니다';

// ---- Brand Profile ----

export async function listBrandProfiles(db: DbOrTx, ownerId: string): Promise<BrandProfileRow[]> {
  return db.select().from(brandProfiles).where(eq(brandProfiles.ownerId, ownerId)).orderBy(desc(brandProfiles.version));
}

/** 현재 = 최대 버전. 없으면 null. */
export async function getCurrentBrandProfile(db: DbOrTx, ownerId: string): Promise<BrandProfileRow | null> {
  const rows = await db
    .select()
    .from(brandProfiles)
    .where(eq(brandProfiles.ownerId, ownerId))
    .orderBy(desc(brandProfiles.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function getBrandProfileByVersion(db: DbOrTx, ownerId: string, version: number): Promise<BrandProfileRow | null> {
  if (!Number.isInteger(version) || version < 1) return null;
  const rows = await db
    .select()
    .from(brandProfiles)
    .where(and(eq(brandProfiles.ownerId, ownerId), eq(brandProfiles.version, version)))
    .limit(1);
  return rows[0] ?? null;
}

export function brandProfileView(b: BrandProfileRow) {
  return {
    id: b.id,
    version: b.version,
    pen_name: b.penName,
    audience: b.audience,
    pillars: b.pillars,
    style_rules: b.styleRules,
    tone: b.tone,
    avoid_phrases: b.avoidPhrases,
    cta_rules: b.ctaRules,
    sample_texts: b.sampleTexts,
    created_at: b.createdAt.toISOString(),
  };
}

/**
 * 새 버전 추가(append). base_version = 현재 최대 버전(없으면 0)이어야 한다. 다르면 409 { current, yours }.
 * 동시 저장은 (owner_id, version) unique 로 하나만 성공하고 나머지는 409.
 */
export async function createBrandProfileVersion(
  db: Db,
  ownerId: string,
  input: BrandProfileCreateInput,
  now: Date = new Date(),
): Promise<BrandProfileRow> {
  return db.transaction(async (tx) => {
    // FIX-T06(P2): owner 행을 잠가 "현재 버전 읽기 → 번호 할당"을 직렬화한다(프로필이 아직 없을 때도 잠글 대상이 있음).
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update');
    const current = await getCurrentBrandProfile(tx, ownerId);
    const currentVersion = current?.version ?? 0;
    const { base_version, ...fields } = input;
    // 409 본문의 current 는 항상 응답 시점에 다시 읽은 최신 버전이다.
    const conflict = async () => {
      const latest = await getCurrentBrandProfile(tx, ownerId);
      return new BrandVersionConflictError({ current: latest ? brandProfileView(latest) : null, yours: { base_version, ...fields } });
    };
    if (base_version !== currentVersion) throw await conflict();
    const inserted = await tx
      .insert(brandProfiles)
      .values({
        ownerId,
        version: currentVersion + 1,
        penName: fields.pen_name,
        audience: fields.audience,
        pillars: fields.pillars,
        styleRules: fields.style_rules,
        tone: fields.tone,
        avoidPhrases: fields.avoid_phrases,
        ctaRules: fields.cta_rules,
        sampleTexts: fields.sample_texts,
        createdAt: now,
      })
      .onConflictDoNothing({ target: [brandProfiles.ownerId, brandProfiles.version] })
      .returning();
    const row = inserted[0];
    if (!row) throw await conflict();
    await recordAudit(tx, {
      ownerId,
      action: 'brand.version_create',
      entity: 'brand_profile',
      entityId: row.id,
      versionOrHash: String(row.version),
      details: {
        version: row.version,
        base_version,
        pillars: row.pillars.length,
        sample_texts: row.sampleTexts.length,
        tone: row.tone,
      },
      at: now,
    });
    return row;
  });
}

// ---- 인터뷰 답변 ----

/** 원고의 모든 답변(최신 먼저). 원고가 다른 owner 것이면 빈 배열. */
export async function listInterviewAnswers(db: DbOrTx, ownerId: string, contentId: string): Promise<InterviewAnswerRow[]> {
  if (!isUuid(contentId)) return [];
  return db
    .select()
    .from(interviewAnswers)
    .where(and(eq(interviewAnswers.ownerId, ownerId), eq(interviewAnswers.contentId, contentId)))
    .orderBy(desc(interviewAnswers.seq));
}

/** 질문 키별 가장 최근 답변(질문 순서대로, 답이 없는 키는 빠짐). 최신 = 원고 안 저장 순번(seq)이 가장 큰 행(FIX-T06 P2). */
export function latestAnswers(rows: readonly InterviewAnswerRow[]): InterviewAnswerRow[] {
  const byKey = new Map<string, InterviewAnswerRow>();
  for (const r of rows) {
    const prev = byKey.get(r.questionKey);
    if (!prev || r.seq > prev.seq) byKey.set(r.questionKey, r);
  }
  return INTERVIEW_KEYS.map((k) => byKey.get(k)).filter((r): r is InterviewAnswerRow => r !== undefined);
}

export function interviewAnswerView(a: InterviewAnswerRow) {
  return {
    id: a.id,
    content_id: a.contentId,
    question_key: a.questionKey,
    question: a.question,
    answer: a.answer,
    seq: a.seq,
    created_at: a.createdAt.toISOString(),
  };
}

/**
 * 답변 저장(append). 비어 있지 않고 현재 답변과 다른 키만 새 행을 만든다. 다른 owner 의 원고 → 404.
 * 원고 행을 잠가(FOR UPDATE) 같은 원고의 동시 저장을 직렬화한다.
 */
export async function saveInterviewAnswers(
  db: Db,
  ownerId: string,
  contentId: string,
  input: InterviewAnswersInput,
  now: Date = new Date(),
): Promise<{ inserted: InterviewAnswerRow[]; current: InterviewAnswerRow[] }> {
  if (!isUuid(contentId)) throw new NotFoundError(CONTENT_NOT_FOUND);
  return db.transaction(async (tx) => {
    const { content } = await lockContentForWrite(tx, ownerId, contentId);
    const history = await listInterviewAnswers(tx, ownerId, content.id);
    const current = latestAnswers(history);
    // 원고 잠금 안에서 순번을 정한다(최대+1). 시각이 같아도 저장 순서가 최신 판정을 결정한다.
    let seq = history.reduce((m, r) => Math.max(m, r.seq), 0);
    const inserted: InterviewAnswerRow[] = [];
    for (const key of INTERVIEW_KEYS) {
      const raw = input.answers[key];
      if (raw === undefined) continue;
      const answer = raw.trim();
      if (answer === '') continue;
      if (current.find((c) => c.questionKey === key)?.answer === answer) continue;
      const rows = await tx
        .insert(interviewAnswers)
        .values({ ownerId, contentId: content.id, questionKey: key, question: interviewQuestion(key), answer, seq: ++seq, createdAt: now })
        .returning();
      inserted.push(rows[0]!);
    }
    if (inserted.length > 0) {
      await recordAudit(tx, {
        ownerId,
        action: 'interview.answer',
        entity: 'content',
        entityId: content.id,
        details: { keys: inserted.map((r) => r.questionKey).join(','), count: inserted.length },
        at: now,
      });
    }
    return { inserted, current: latestAnswers(await listInterviewAnswers(tx, ownerId, content.id)) };
  });
}

// ---- 프롬프트 입력 ----

export function promptBrand(b: BrandProfileRow): PromptBrand {
  return {
    version: b.version,
    penName: b.penName,
    audience: b.audience,
    pillars: b.pillars,
    styleRules: b.styleRules,
    tone: b.tone,
    avoidPhrases: b.avoidPhrases,
    ctaRules: b.ctaRules,
    sampleTexts: b.sampleTexts,
  };
}

export const promptAnswer = (a: InterviewAnswerRow): PromptAnswer => ({
  id: a.id,
  questionKey: a.questionKey,
  question: a.question,
  answer: a.answer,
});

// ---- assist ----

/** provider 추상(@cs/providers LlmProvider 와 구조적으로 호환). DB 패키지는 provider 구현을 모른다. */
export interface AssistLlm {
  readonly name: string;
  readonly mode: 'mock' | 'live';
  generate(input: AssistLlmInput): Promise<LlmStructuredOutput>;
  /** T07: 실제 사용량(토큰). 없으면 글자/3 추정(D13). */
  usageOf?(input: AssistLlmInput, output: LlmStructuredOutput): { tokensIn: number; tokensOut: number };
}

export interface AssistLlmInput {
  task: LlmStructuredOutput['result_type'];
  inputVersion: string;
  text: string;
  prompt?: string;
  /** T07: 허용된 source_version id. claim.source_refs 는 이 안에서만 채택된다(밖은 저장 전에 버림). */
  allowedSourceRefs?: string[];
  /** FIX-T07: 출력 토큰 상한 = 예약의 출력 여유분(최대 비용 예약의 근거). */
  maxOutputTokens?: number;
}

/** 가격 없는 모의 정책(예약 0, 한도 검사 없음) — 호출자가 정책을 넘기지 않을 때. */
const MOCK_UNPRICED: BudgetPolicy = { mode: 'mock', currency: 'USD', pricing: null, monthlyLimitMicro: null, perRunMaxMicro: null };

export interface AssistInput {
  mode: AssistMode;
  baseVersion: number;
  brandProfileVersion: number;
  answerIds: readonly string[];
  /** T07: 근거로 허용할 source_version id(이 원고에 연결된 소재의 출처만, 아니면 404). */
  sourceVersionIds?: readonly string[];
  /** T07: 예산 정책(@cs/domain budgetPolicy(config)). 생략하면 가격 없는 모의. */
  budget?: BudgetPolicy;
}

export interface AssistResult {
  run: GenerationRunRow;
  proposal: ContentVersionRow;
  current: ContentVersionRow;
  /** FIX-T07: 정제한 출력(버린 출처 원문 없음) */
  output: SanitizedOutput;
  /** T07: 정제한 claim(저장된 claims·output_json 과 같은 내용) */
  claims: SanitizedClaim[];
  ledger: UsageLedgerRow;
}

interface PreparedAssist {
  run: GenerationRunRow;
  inputVersion: string;
  material: string;
  prompt: string;
  sourceIds: string[];
  locators: Map<string, string | null>;
  ledger: UsageLedgerRow;
  reservation: Reservation;
  policy: BudgetPolicy;
}

/**
 * assist 입력 검증 + run(running) 기록(한 트랜잭션, 원고 잠금).
 * - base_version ≠ 현재 버전 → 409 stale_base(run·버전 없음)
 * - 브랜드 프로필 버전이 이 owner 에 없음 → 400
 * - 답변 ID 형식 오류 → 400, 이 owner·이 원고의 답변이 아님 → 404
 */
async function prepareAssist(db: Db, ownerId: string, contentId: string, input: AssistInput, llm: AssistLlm, now: Date): Promise<PreparedAssist> {
  return db.transaction(async (tx) => {
    const { content, current } = await lockContentForWrite(tx, ownerId, contentId);
    if (input.baseVersion !== current.version) {
      throw new StaleBaseError({
        current: { version: current.version, body: current.body, created_at: current.createdAt.toISOString() },
        yours: { base_version: input.baseVersion },
      });
    }
    const brand = await getBrandProfileByVersion(tx, ownerId, input.brandProfileVersion);
    if (!brand) throw new BadRequestError('브랜드 프로필 버전을 찾을 수 없습니다. /brand 에서 먼저 저장하세요.');
    const ids = [...new Set(input.answerIds.map((s) => s.toLowerCase()))];
    if (ids.some((s) => !isUuid(s))) throw new BadRequestError('answer_ids 형식이 올바르지 않습니다');
    const answers = ids.length
      ? await tx
          .select()
          .from(interviewAnswers)
          .where(and(eq(interviewAnswers.ownerId, ownerId), eq(interviewAnswers.contentId, content.id), inArray(interviewAnswers.id, ids)))
          .orderBy(asc(interviewAnswers.id))
      : [];
    if (answers.length !== ids.length) throw new NotFoundError('인터뷰 답변을 찾을 수 없습니다');

    // T07: 근거로 허용할 source_version — 이 원고에 연결된 소재의 출처만(형식 오류 400, 목록 밖 404).
    const svIds = [...new Set((input.sourceVersionIds ?? []).map((s) => s.toLowerCase()))];
    if (svIds.some((s) => !isUuid(s))) throw new BadRequestError('source_version_ids 형식이 올바르지 않습니다');
    const allowed = svIds.length ? await allowedSourceVersions(tx, ownerId, content.id) : [];
    const allowedById = new Map(allowed.map((a) => [a.id, a]));
    if (svIds.some((s) => !allowedById.has(s))) throw new NotFoundError('이 원고의 출처를 찾을 수 없습니다');
    const sourceIds = [...svIds].sort();
    const chosen = sourceIds.map((s) => allowedById.get(s)!);

    const answerIds = answers.map((a) => a.id).sort();
    const inputVersion = assistInputVersion({
      contentVersionId: current.id,
      brandProfileVersion: brand.version,
      answerIds,
      sourceVersionIds: sourceIds,
    });
    const promptAnswers = answers.map(promptAnswer);
    const prompt = buildAssistPrompt({
      mode: input.mode,
      inputVersion,
      brand: promptBrand(brand),
      answers: promptAnswers,
      title: content.title,
      body: current.body,
      sources: chosen.map((c) => ({ id: c.id, locator: c.locator, excerpt: c.excerpt })),
    });

    // T07(A15): 호출 전 예약. owner 행을 잠그고(동시 예약 직렬화) 이번 달 사용액 + 예약액이 상한을 넘으면 429 — run·원장·버전 없음.
    const policy = input.budget ?? MOCK_UNPRICED;
    const reservation = await reserveOrThrow(tx, ownerId, policy, prompt, now);

    const inserted = await tx
      .insert(generationRuns)
      .values({
        ownerId,
        contentId: content.id,
        mode: input.mode,
        inputVersionId: current.id,
        brandProfileId: brand.id,
        inputVersionRefs: {
          content_version_id: current.id,
          content_version: current.version,
          brand_profile_id: brand.id,
          brand_profile_version: brand.version,
          answer_ids: answerIds,
          source_version_ids: sourceIds,
          input_version: inputVersion,
        },
        promptVersion: promptVersionFor(sourceIds.length),
        provider: llm.name,
        model: llm.mode === 'mock' ? 'mock' : llm.name,
        status: 'running',
        createdAt: now,
      })
      .returning();
    const run = inserted[0]!;
    const ledger = await insertReservedLedger(tx, ownerId, run.id, policy, reservation, now);
    return {
      run,
      inputVersion,
      material: assistMaterial(promptAnswers, current.body),
      prompt,
      sourceIds,
      locators: new Map(chosen.map((c) => [c.id, c.locator])),
      ledger,
      reservation,
      policy,
    };
  });
}

/** 실패 사유(짧은 코드만 — 모델 출력·입력·예외 메시지 원문을 저장하지 않는다). */
function failureCode(e: unknown): string {
  if (e instanceof Error && e.name === 'MockLlmFailure') return 'mock_injected_failure';
  if (e instanceof Error && e.name === 'ZodError') return 'invalid_output';
  if (e instanceof AppError) return e.code;
  return 'provider_error';
}

/**
 * AI 작성 보조. run 기록 → provider 호출(트랜잭션 밖) → 성공: 제안 버전(현재 아님) + run succeeded / 실패: run failed.
 * 어느 경우에도 contents.current_version_id 와 기존 버전은 바뀌지 않는다.
 */
export async function runAssist(
  db: Db,
  ownerId: string,
  contentId: string,
  input: AssistInput,
  llm: AssistLlm,
  now: Date = new Date(),
): Promise<AssistResult> {
  if (!isUuid(contentId)) throw new NotFoundError(CONTENT_NOT_FOUND);
  const prep = await prepareAssist(db, ownerId, contentId, input, llm, now);
  const runId = prep.run.id;

  const llmInput: AssistLlmInput = {
    task: ASSIST_RESULT_TYPE[input.mode],
    inputVersion: prep.inputVersion,
    text: prep.material,
    prompt: prep.prompt,
    allowedSourceRefs: prep.sourceIds,
    maxOutputTokens: prep.reservation.tokensOutAllowance,
  };
  let output: LlmStructuredOutput;
  let sanitized: ReturnType<typeof sanitizeLlmOutput>;
  try {
    const raw = await llm.generate(llmInput);
    output = llmStructuredOutputSchema.parse(raw);
    if (output.input_version !== prep.inputVersion) throw new AppError('bad_request', 'input_version_mismatch', '입력 버전이 다른 응답');
    if (output.proposed_text.length > MAX_PROPOSAL_BODY) throw new AppError('bad_request', 'proposal_too_large', '제안이 너무 깁니다');
    // FIX-T07 round 4: 구조화 인용만 — 글에 자유문 출처(URL·도메인·버린 참조)나 범위 밖 [n] 이 있으면 unverifiable_citation(제안 없음, 본문 그대로).
    sanitized = sanitizeLlmOutput(output, prep.sourceIds);
  } catch (e) {
    const finished = new Date(Math.max(Date.now(), now.getTime()));
    await db.transaction(async (tx) => {
      await tx
        .update(generationRuns)
        .set({ status: 'failed', error: failureCode(e), finishedAt: finished })
        .where(and(eq(generationRuns.id, runId), eq(generationRuns.ownerId, ownerId), eq(generationRuns.status, 'running')));
      // T07: 실패한 호출도 비용이 났을 수 있으므로 예약액 전체를 실제액으로 확정한다(docs/02: 실패 재시도도 예약량에 반영).
      await settleLedgerFailed(tx, ownerId, prep.ledger, finished);
      await recordAudit(tx, {
        ownerId,
        action: 'content.assist',
        entity: 'content',
        entityId: contentId,
        versionOrHash: runId,
        details: { mode: input.mode, status: 'failed', provider: llm.name, error: failureCode(e) },
        at: finished,
      });
    });
    throw new LlmFailedError();
  }

  const finished = new Date(Math.max(Date.now(), now.getTime()));
  // FIX-T07(P1): 정제한 출력 하나를 제안 본문·output_json·claims 행·응답에 똑같이 쓴다(버린 출처 원문이 어디에도 남지 않게).
  const { output: clean, droppedTotal } = sanitized;
  return db.transaction(async (tx) => {
    const { content, current } = await lockContentForWrite(tx, ownerId, contentId);
    const inserted = await tx
      .insert(contentVersions)
      .values({
        contentId: content.id,
        version: await nextVersionNumber(tx, content.id),
        body: clean.proposed_text,
        createdBy: `ai:${llm.mode}`,
        aiRunId: runId,
        note: `AI 제안(${llm.mode === 'mock' ? '모의' : llm.name}) · ${input.mode}`,
        createdAt: finished,
      })
      .returning();
    const proposal = inserted[0]!;
    await insertClaims(tx, ownerId, runId, proposal.id, clean.claims, prep.locators, finished);
    // T07: 실제 사용량으로 확정(모의는 결정적 추정). 예약을 넘으면 초과액을 기록한다(FIX-T07).
    const usage = llm.usageOf?.(llmInput, output) ?? { tokensIn: estimateTokens(prep.prompt), tokensOut: estimateTokens(output.proposed_text) };
    const settled = await settleLedgerSucceeded(tx, ownerId, prep.ledger, prep.policy.pricing, usage, finished);
    const outputJson = {
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
      ...(settled.overBudget ? { over_budget: true } : {}),
    };
    const updated = await tx
      .update(generationRuns)
      .set({ status: 'succeeded', outputRef: proposal.id, outputJson, finishedAt: finished })
      .where(and(eq(generationRuns.id, runId), eq(generationRuns.ownerId, ownerId), eq(generationRuns.status, 'running')))
      .returning();
    if (!updated[0]) throw new Error('AI 실행 기록 갱신에 실패했습니다');
    await recordAudit(tx, {
      ownerId,
      action: 'content.assist',
      entity: 'content',
      entityId: content.id,
      versionOrHash: runId,
      details: {
        mode: input.mode,
        status: 'succeeded',
        provider: llm.name,
        proposal_version: proposal.version,
        claims: clean.claims.length,
        experience_claims: clean.claims.filter((c) => c.kind === 'experience').length,
        dropped_source_refs: droppedTotal,
        actual_amount: settled.actualAmount,
        over_budget: settled.overBudget,
      },
      at: finished,
    });
    return { run: updated[0], proposal, current, output: clean, claims: clean.claims, ledger: settled };
  });
}

// ---- run 조회 ----

export async function getGenerationRun(db: DbOrTx, ownerId: string, contentId: string, runId: string): Promise<GenerationRunRow | null> {
  if (!isUuid(runId) || !isUuid(contentId)) return null;
  const rows = await db
    .select()
    .from(generationRuns)
    .where(and(eq(generationRuns.id, runId), eq(generationRuns.ownerId, ownerId), eq(generationRuns.contentId, contentId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listGenerationRuns(db: DbOrTx, ownerId: string, contentId: string, limit = 10): Promise<GenerationRunRow[]> {
  if (!isUuid(contentId)) return [];
  return db
    .select()
    .from(generationRuns)
    // T09: 채널 초안 run(mode='variant')은 원고 작성 보조 목록에 넣지 않는다(채널 초안 카드에서 따로 보인다).
    .where(and(eq(generationRuns.ownerId, ownerId), eq(generationRuns.contentId, contentId), ne(generationRuns.mode, 'variant')))
    .orderBy(desc(generationRuns.createdAt), desc(generationRuns.id))
    .limit(limit);
}

export async function listClaimConfirmations(db: DbOrTx, ownerId: string, runIds: readonly string[]): Promise<ClaimConfirmationRow[]> {
  if (runIds.length === 0) return [];
  return db
    .select()
    .from(claimConfirmations)
    .where(and(eq(claimConfirmations.ownerId, ownerId), inArray(claimConfirmations.runId, [...runIds])))
    .orderBy(asc(claimConfirmations.runId), asc(claimConfirmations.claimIndex));
}

/** 채택된 run id 집합(그 run 을 ai_run_id 로 가진 사용자 버전이 있음). */
export async function adoptedRunIds(db: DbOrTx, contentId: string, runIds: readonly string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ runId: contentVersions.aiRunId })
    .from(contentVersions)
    .where(and(eq(contentVersions.contentId, contentId), eq(contentVersions.createdBy, 'owner'), inArray(contentVersions.aiRunId, [...runIds])));
  return new Set(rows.map((r) => r.runId!).filter(Boolean));
}

export function generationRunView(r: GenerationRunRow) {
  return {
    id: r.id,
    content_id: r.contentId,
    mode: r.mode,
    status: r.status,
    provider: r.provider,
    model: r.model,
    prompt_version: r.promptVersion,
    input_version_refs: r.inputVersionRefs,
    output_ref: r.outputRef,
    output: r.outputJson,
    error: r.error,
    created_at: r.createdAt.toISOString(),
    finished_at: r.finishedAt ? r.finishedAt.toISOString() : null,
  };
}

// ---- 채택 ----

/**
 * AI 제안 채택: 제안 본문으로 새 사용자 버전(created_by='owner', ai_run_id=run)을 만들고 현재 버전으로 옮긴다.
 * - run 이 이 owner·이 원고의 것이 아니면 404, 성공한 run 이 아니면 409 run_not_adoptable
 * - base_version ≠ 현재 버전, 또는 run 의 입력 버전 ≠ 현재 버전(그 사이 본문이 바뀜·이미 채택) → 409 stale_base
 * - 원고가 이미 `ready` 인데 채택하면 미확인 경험 claim 이 남게 되는 경우 → 409 unconfirmed_experience_claims(A03 우회 방지)
 */
export async function adoptProposal(
  db: Db,
  ownerId: string,
  contentId: string,
  runId: string,
  baseVersion: number,
  now: Date = new Date(),
): Promise<{ content: ContentRow; version: ContentVersionRow; run: GenerationRunRow }> {
  if (!isUuid(contentId)) throw new NotFoundError(CONTENT_NOT_FOUND);
  return db.transaction(async (tx) => {
    const { content, current } = await lockContentForWrite(tx, ownerId, contentId);
    const run = await getGenerationRun(tx, ownerId, content.id, runId.toLowerCase());
    if (!run) throw new NotFoundError(RUN_NOT_FOUND);
    if (run.status !== 'succeeded' || !run.outputRef) {
      throw new AppError('conflict', 'run_not_adoptable', '성공한 AI 제안만 채택할 수 있습니다');
    }
    if (baseVersion !== current.version || run.inputVersionId !== current.id) {
      throw new StaleBaseError({
        current: { version: current.version, body: current.body, created_at: current.createdAt.toISOString() },
        yours: { base_version: baseVersion, run_id: run.id },
      });
    }
    // FIX-T09(P1): 무시한 제안은 채택할 수 없다(proposal_status). 재채택은 위의 stale_base 가 먼저 막는다.
    if (run.proposalStatus !== 'proposed') throw new AppError('conflict', 'run_not_adoptable', '이미 채택했거나 무시한 AI 제안입니다');
    const proposalRows = await tx
      .select()
      .from(contentVersions)
      .where(and(eq(contentVersions.id, run.outputRef), eq(contentVersions.contentId, content.id), eq(contentVersions.aiRunId, run.id)))
      .limit(1);
    const proposal = proposalRows[0];
    if (!proposal) throw new NotFoundError(RUN_NOT_FOUND);
    const r = await insertCurrentVersion(
      tx,
      ownerId,
      content,
      current,
      { body: proposal.body, note: `AI 제안 채택(버전 ${proposal.version})`, aiRunId: run.id },
      now,
    );
    // A03: 이미 `ready` 인 원고에 미확인 경험 claim 이 있는 제안을 채택하면 게이트를 우회하게 된다 → 거부(트랜잭션 전체 rollback).
    // 먼저 확인(POST /claims/confirm — 채택 전에도 가능)한 뒤 채택하거나, 상태를 `review` 로 되돌린 뒤 채택한다.
    if (content.lifecycle === 'ready') {
      const pending = await listUnconfirmedExperienceClaims(tx, ownerId, content.id);
      if (pending.length > 0) throw new UnconfirmedExperienceClaimsError(pending);
    }
    await tx
      .update(generationRuns)
      .set({ proposalStatus: 'adopted' })
      .where(and(eq(generationRuns.id, run.id), eq(generationRuns.ownerId, ownerId)));
    const unconfirmed = claimsOf(run.outputJson).filter(claimNeedsConfirmation).length;
    await recordAudit(tx, {
      ownerId,
      action: 'content.adopt_ai',
      entity: 'content',
      entityId: content.id,
      versionOrHash: String(r.version.version),
      details: { version: r.version.version, base_version: baseVersion, proposal_version: proposal.version, needs_confirmation: unconfirmed },
      at: now,
    });
    return { ...r, run };
  });
}

// ---- 경험 claim 확인(A03) ----

/**
 * 사용자가 경험 claim 을 해결한다(A03). resolution:
 * - 'confirmed': "내 실제 경험이 맞다"
 * - 'removed'  : "그 문장을 본문에서 뺐거나 고쳤다"(FIX-T06 P1 — 거짓 확인 없이 검토를 끝낼 수 있게). 서버는 본문을 대조하지 않는다.
 * 둘 다 사용자 주장이며 AI 는 이 경로를 호출하지 않는다. 성공한 run 의 확인 필요 claim 만(아니면 400).
 * - FIX round 2: 'removed' 는 원고 잠금 안에서 현재 본문에 그 문장이 없을 때만 저장(있으면 409 claim_still_in_body, 행 없음),
 *   body_version_id = 그때의 현재 버전. 게이트는 이후에도 현재 본문을 다시 검사한다(다시 넣으면 다시 미해결).
 * 같은 (run, index, resolution) 은 한 행(중복 없음). 확인과 제외는 각각 한 번씩 기록할 수 있다.
 */
export async function confirmClaims(
  db: Db,
  ownerId: string,
  contentId: string,
  runId: string,
  claimIndexes: readonly number[],
  resolution: ClaimResolution = 'confirmed',
  now: Date = new Date(),
): Promise<{ confirmed: number[]; unconfirmed: UnconfirmedClaim[] }> {
  if (!isUuid(contentId)) throw new NotFoundError(CONTENT_NOT_FOUND);
  return db.transaction(async (tx) => {
    // FIX-T06 round 2: 원고 잠금 안에서 현재 본문을 읽어 'removed' 를 그 본문 버전에 묶는다(본문 저장·채택과 직렬화).
    const { content, current } = await lockContentForWrite(tx, ownerId, contentId);
    const run = await getGenerationRun(tx, ownerId, content.id, runId.toLowerCase());
    if (!run || run.status !== 'succeeded') throw new NotFoundError(RUN_NOT_FOUND);
    const claims = claimsOf(run.outputJson);
    const idx = [...new Set(claimIndexes)].sort((a, b) => a - b);
    for (const i of idx) {
      const c = claims[i];
      if (!c || !claimNeedsConfirmation(c)) throw new BadRequestError('확인이 필요한 경험 주장이 아닙니다');
    }
    if (resolution === 'removed') {
      // T09: 채널 초안 run 의 claim 은 그 파생본의 현재 본문에서 빠졌는지 본다(원고 본문이 아니라).
      const body = run.variantId ? await variantCurrentBody(tx, ownerId, run.variantId) : current.body;
      const still = idx.filter((i) => body === undefined || bodyContainsClaim(body, claims[i]!.text));
      if (still.length > 0) throw new ClaimStillInBodyError(still);
    }
    const inserted = await tx
      .insert(claimConfirmations)
      .values(idx.map((claimIndex) => ({ ownerId, runId: run.id, claimIndex, resolution, bodyVersionId: current.id, confirmedAt: now })))
      .onConflictDoNothing({ target: [claimConfirmations.runId, claimConfirmations.claimIndex, claimConfirmations.resolution] })
      .returning({ claimIndex: claimConfirmations.claimIndex });
    if (inserted.length > 0) {
      await recordAudit(tx, {
        ownerId,
        action: 'content.claim_confirm',
        entity: 'content',
        entityId: content.id,
        versionOrHash: run.id,
        details: { count: inserted.length, indexes: inserted.map((r) => r.claimIndex).join(','), resolution, body_version: current.version },
        at: now,
      });
    }
    return { confirmed: idx, unconfirmed: await listUnconfirmedExperienceClaims(tx, ownerId, content.id) };
  });
}

/** 작성실 화면용 묶음: 현재 브랜드, 최신 답변, 최근 run(+채택 여부·확인), 미확인 경험 claim. */
export async function getWritingState(db: DbOrTx, ownerId: string, contentId: string, selectedRunId?: string) {
  const brand = await getCurrentBrandProfile(db, ownerId);
  const answers = latestAnswers(await listInterviewAnswers(db, ownerId, contentId));
  const unconfirmed = await listUnconfirmedExperienceClaims(db, ownerId, contentId);
  // FIX-T06(P1): 최근 10개 + 미해결 경험 claim 이 남은 run(최근 목록 밖이어도) + URL 로 지정한 run(owner·원고 범위 직접 조회).
  const recent = await listGenerationRuns(db, ownerId, contentId, 10);
  const runs = [...recent];
  const have = new Set(recent.map((r) => r.id));
  const extraIds = [...new Set(unconfirmed.map((u) => u.run_id))];
  if (selectedRunId && isUuid(selectedRunId.toLowerCase())) extraIds.push(selectedRunId.toLowerCase());
  for (const id of extraIds) {
    if (have.has(id)) continue;
    const r = await getGenerationRun(db, ownerId, contentId, id);
    if (r) {
      runs.push(r);
      have.add(r.id);
    }
  }
  const runIds = runs.map((r) => r.id);
  const adopted = await adoptedRunIds(db, contentId, runIds);
  const confirmations = await listClaimConfirmations(db, ownerId, runIds);
  // T07: 이 원고 소재의 출처(assist 근거 후보)
  const allowedSources = await allowedSourceVersions(db, ownerId, contentId);
  return { brand, answers, runs, adopted, confirmations, unconfirmed, allowedSources };
}
