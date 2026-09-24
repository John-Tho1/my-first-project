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
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  ASSIST_RESULT_TYPE,
  assistInputVersion,
  assistMaterial,
  BadRequestError,
  BrandVersionConflictError,
  buildAssistPrompt,
  claimNeedsConfirmation,
  interviewQuestion,
  INTERVIEW_KEYS,
  isUuid,
  llmStructuredOutputSchema,
  LlmFailedError,
  MAX_PROPOSAL_BODY,
  NotFoundError,
  PROMPT_VERSION,
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
import { claimsOf, listUnconfirmedExperienceClaims } from './claims-gate';
import { getContentRow, insertCurrentVersion, lockContentForWrite, nextVersionNumber, type ContentRow, type ContentVersionRow } from './contents';
import { recordAudit, type DbOrTx } from './queries';
import { brandProfiles, claimConfirmations, contentVersions, generationRuns, interviewAnswers } from './schema';

export type BrandProfileRow = typeof brandProfiles.$inferSelect;
export type InterviewAnswerRow = typeof interviewAnswers.$inferSelect;
export type GenerationRunRow = typeof generationRuns.$inferSelect;
export type ClaimConfirmationRow = typeof claimConfirmations.$inferSelect;

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
    const current = await getCurrentBrandProfile(tx, ownerId);
    const currentVersion = current?.version ?? 0;
    const { base_version, ...fields } = input;
    const conflict = () =>
      new BrandVersionConflictError({ current: current ? brandProfileView(current) : null, yours: { base_version, ...fields } });
    if (base_version !== currentVersion) throw conflict();
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
    if (!row) throw conflict();
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
    .orderBy(desc(interviewAnswers.createdAt), desc(interviewAnswers.id));
}

/** 질문 키별 가장 최근 답변(질문 순서대로, 답이 없는 키는 빠짐). */
export function latestAnswers(rows: readonly InterviewAnswerRow[]): InterviewAnswerRow[] {
  const byKey = new Map<string, InterviewAnswerRow>();
  for (const r of rows) {
    const prev = byKey.get(r.questionKey);
    if (!prev || r.createdAt > prev.createdAt || (r.createdAt.getTime() === prev.createdAt.getTime() && r.id > prev.id)) {
      byKey.set(r.questionKey, r);
    }
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
    const current = latestAnswers(await listInterviewAnswers(tx, ownerId, content.id));
    const inserted: InterviewAnswerRow[] = [];
    for (const key of INTERVIEW_KEYS) {
      const raw = input.answers[key];
      if (raw === undefined) continue;
      const answer = raw.trim();
      if (answer === '') continue;
      if (current.find((c) => c.questionKey === key)?.answer === answer) continue;
      const rows = await tx
        .insert(interviewAnswers)
        .values({ ownerId, contentId: content.id, questionKey: key, question: interviewQuestion(key), answer, createdAt: now })
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
  generate(input: {
    task: LlmStructuredOutput['result_type'];
    inputVersion: string;
    text: string;
    prompt?: string;
  }): Promise<LlmStructuredOutput>;
}

export interface AssistInput {
  mode: AssistMode;
  baseVersion: number;
  brandProfileVersion: number;
  answerIds: readonly string[];
}

export interface AssistResult {
  run: GenerationRunRow;
  proposal: ContentVersionRow;
  current: ContentVersionRow;
  output: LlmStructuredOutput;
}

interface PreparedAssist {
  run: GenerationRunRow;
  inputVersion: string;
  material: string;
  prompt: string;
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

    const answerIds = answers.map((a) => a.id).sort();
    const inputVersion = assistInputVersion({ contentVersionId: current.id, brandProfileVersion: brand.version, answerIds });
    const promptAnswers = answers.map(promptAnswer);
    const prompt = buildAssistPrompt({
      mode: input.mode,
      inputVersion,
      brand: promptBrand(brand),
      answers: promptAnswers,
      title: content.title,
      body: current.body,
    });
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
          input_version: inputVersion,
        },
        promptVersion: PROMPT_VERSION,
        provider: llm.name,
        model: llm.mode === 'mock' ? 'mock' : llm.name,
        status: 'running',
        createdAt: now,
      })
      .returning();
    return { run: inserted[0]!, inputVersion, material: assistMaterial(promptAnswers, current.body), prompt };
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

  let output: LlmStructuredOutput;
  try {
    const raw = await llm.generate({
      task: ASSIST_RESULT_TYPE[input.mode],
      inputVersion: prep.inputVersion,
      text: prep.material,
      prompt: prep.prompt,
    });
    output = llmStructuredOutputSchema.parse(raw);
    if (output.input_version !== prep.inputVersion) throw new AppError('bad_request', 'input_version_mismatch', '입력 버전이 다른 응답');
    if (output.proposed_text.length > MAX_PROPOSAL_BODY) throw new AppError('bad_request', 'proposal_too_large', '제안이 너무 깁니다');
  } catch (e) {
    const finished = new Date(Math.max(Date.now(), now.getTime()));
    await db.transaction(async (tx) => {
      await tx
        .update(generationRuns)
        .set({ status: 'failed', error: failureCode(e), finishedAt: finished })
        .where(and(eq(generationRuns.id, runId), eq(generationRuns.ownerId, ownerId), eq(generationRuns.status, 'running')));
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
  return db.transaction(async (tx) => {
    const { content, current } = await lockContentForWrite(tx, ownerId, contentId);
    const inserted = await tx
      .insert(contentVersions)
      .values({
        contentId: content.id,
        version: await nextVersionNumber(tx, content.id),
        body: output.proposed_text,
        createdBy: `ai:${llm.mode}`,
        aiRunId: runId,
        note: `AI 제안(${llm.mode === 'mock' ? '모의' : llm.name}) · ${input.mode}`,
        createdAt: finished,
      })
      .returning();
    const proposal = inserted[0]!;
    const outputJson = {
      result_type: output.result_type,
      input_version: output.input_version,
      proposed_tags: output.proposed_tags,
      claims: output.claims,
      followup_questions: output.followup_questions,
      warnings: output.warnings,
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
        claims: output.claims.length,
        experience_claims: output.claims.filter((c) => c.kind === 'experience').length,
      },
      at: finished,
    });
    return { run: updated[0], proposal, current, output };
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
    .where(and(eq(generationRuns.ownerId, ownerId), eq(generationRuns.contentId, contentId)))
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
 * 사용자가 "이 1인칭 경험은 사실"이라고 확인한다. 성공한 run 의 claim 중 확인이 필요한 것만(아니면 400).
 * 이미 확인한 index 는 그대로 둔다(중복 행 없음). AI 는 이 경로를 호출하지 않는다 — 사용자 요청만.
 */
export async function confirmClaims(
  db: Db,
  ownerId: string,
  contentId: string,
  runId: string,
  claimIndexes: readonly number[],
  now: Date = new Date(),
): Promise<{ confirmed: number[]; unconfirmed: UnconfirmedClaim[] }> {
  if (!isUuid(contentId)) throw new NotFoundError(CONTENT_NOT_FOUND);
  return db.transaction(async (tx) => {
    const content = await getContentRow(tx, ownerId, contentId);
    if (!content) throw new NotFoundError(CONTENT_NOT_FOUND);
    const run = await getGenerationRun(tx, ownerId, content.id, runId.toLowerCase());
    if (!run || run.status !== 'succeeded') throw new NotFoundError(RUN_NOT_FOUND);
    const claims = claimsOf(run.outputJson);
    const idx = [...new Set(claimIndexes)].sort((a, b) => a - b);
    for (const i of idx) {
      const c = claims[i];
      if (!c || !claimNeedsConfirmation(c)) throw new BadRequestError('확인이 필요한 경험 주장이 아닙니다');
    }
    const inserted = await tx
      .insert(claimConfirmations)
      .values(idx.map((claimIndex) => ({ ownerId, runId: run.id, claimIndex, confirmedAt: now })))
      .onConflictDoNothing({ target: [claimConfirmations.runId, claimConfirmations.claimIndex] })
      .returning({ claimIndex: claimConfirmations.claimIndex });
    if (inserted.length > 0) {
      await recordAudit(tx, {
        ownerId,
        action: 'content.claim_confirm',
        entity: 'content',
        entityId: content.id,
        versionOrHash: run.id,
        details: { count: inserted.length, indexes: inserted.map((r) => r.claimIndex).join(',') },
        at: now,
      });
    }
    return { confirmed: idx, unconfirmed: await listUnconfirmedExperienceClaims(tx, ownerId, content.id) };
  });
}

/** 작성실 화면용 묶음: 현재 브랜드, 최신 답변, 최근 run(+채택 여부·확인), 미확인 경험 claim. */
export async function getWritingState(db: DbOrTx, ownerId: string, contentId: string) {
  const brand = await getCurrentBrandProfile(db, ownerId);
  const answers = latestAnswers(await listInterviewAnswers(db, ownerId, contentId));
  const runs = await listGenerationRuns(db, ownerId, contentId, 10);
  const runIds = runs.map((r) => r.id);
  const adopted = await adoptedRunIds(db, contentId, runIds);
  const confirmations = await listClaimConfirmations(db, ownerId, runIds);
  const unconfirmed = await listUnconfirmedExperienceClaims(db, ownerId, contentId);
  return { brand, answers, runs, adopted, confirmations, unconfirmed };
}
