/**
 * M1 테이블(docs/04 "M1은 users/brand_profiles/captures/sources/ideas/contents/content_versions/assets부터").
 * - 모든 시각은 timestamptz(UTC 저장). 표시는 MSK(@cs/domain formatMsk).
 * - owner 참조는 DB FK 로도 강제한다. 하위 테이블(source_versions, content_versions)은 부모의 owner 를 따른다.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().defaultRandom();

export const inputTypeEnum = pgEnum('capture_input_type', ['text', 'url', 'file', 'voice']);

export const users = pgTable('users', {
  id: id(),
  allowedIdentity: text('allowed_identity').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const brandProfiles = pgTable(
  'brand_profiles',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    penName: text('pen_name').notNull(),
    audience: text('audience').notNull(),
    pillars: jsonb('pillars').$type<string[]>().notNull(),
    styleRules: jsonb('style_rules').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** T06: 말투 — 'formal'(존댓말) | 'casual'(평어). 0005 이전 행은 기본값 formal. */
    tone: text('tone').notNull().default('formal'),
    /** T06: 피하고 싶은 표현 */
    avoidPhrases: jsonb('avoid_phrases').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** T06: CTA 원칙 */
    ctaRules: jsonb('cta_rules').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** T06: 사용자가 직접 제공한 작성 예문(말투 참고용 — 예문 속 사건을 새 글 사실로 옮기지 않는다) */
    sampleTexts: jsonb('sample_texts').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    unique('brand_profiles_owner_version_uq').on(t.ownerId, t.version),
    // T06: generation_runs 가 "같은 owner 의 브랜드 프로필" 만 참조하도록 복합 FK 대상.
    unique('brand_profiles_id_owner_uq').on(t.id, t.ownerId),
    check('brand_profiles_tone_chk', sql`${t.tone} in ('formal', 'casual')`),
  ],
);

export const sources = pgTable(
  'sources',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    canonicalUrl: text('canonical_url'),
    externalProvider: text('external_provider'),
    externalId: text('external_id'),
    externalRevision: text('external_revision'),
    checkedAt: ts('checked_at'),
    contentHash: text('content_hash'),
    rightsStatus: text('rights_status').notNull().default('unknown'),
    /** T03: 중복 판정 키(@cs/domain normalizeUrl().normalized). URL 이 아닌 source 는 null. */
    normalizedUrl: text('normalized_url'),
  },
  (t) => [
    // (id, owner_id) 복합 unique: captures 가 "같은 owner 의 source" 만 참조하도록 복합 FK 대상.
    unique('sources_id_owner_uq').on(t.id, t.ownerId),
    // T03: owner 안에서 같은 정규화 URL 의 source 는 하나(부분 unique — null 은 제외).
    uniqueIndex('sources_owner_normalized_url_uq')
      .on(t.ownerId, t.normalizedUrl)
      .where(sql`${t.normalizedUrl} is not null`),
  ],
);

/**
 * 원문 추출 시도·결과. T03: 추출이 차단되면(A05 내부 주소, 수집 비활성) extraction_state='blocked' 행만 남기고
 * 가져온 내용이 없으므로 raw_hash 는 null 이다(0002 에서 nullable 로 변경).
 */
export const sourceVersions = pgTable('source_versions', {
  id: id(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id, { onDelete: 'restrict' }),
  rawHash: text('raw_hash'),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
  excerpt: text('excerpt'),
  extractionState: text('extraction_state').notNull().default('pending'),
});

/**
 * 수집 원문. raw_text 는 불변(T03): 어떤 UPDATE 도 raw_text 를 바꾸지 않는다(query 계층에서 강제).
 * 수정 가능한 필드(user_note, title, risk)는 revision 으로 낙관적 잠금을 하고, 매 수정은 capture_revisions 에 남긴다.
 * content_hash: 정확 중복 판정용(@cs/domain contentHash). 0002 이전 행이 있을 수 있어 nullable 이며,
 * 모든 insert 경로(createCapture, seed)는 값을 넣고 seed 는 null 인 기존 행을 채운다. 중복 조회는 null 을 무시한다.
 */
export const captures = pgTable(
  'captures',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    rawText: text('raw_text').notNull(),
    inputType: inputTypeEnum('input_type').notNull(),
    sourceId: uuid('source_id'),
    receivedAt: ts('received_at').notNull().defaultNow(),
    risk: text('risk').notNull().default('none'),
    userNote: text('user_note'),
    commandKey: text('command_key').notNull(),
    title: text('title'),
    revision: integer('revision').notNull().default(1),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    contentHash: text('content_hash'),
    /** T08: 음성 전사에서 만든 소재면 그 전사 버전(transcripts.id). 같은 owner 의 전사만(복합 FK). */
    captureTranscriptId: uuid('capture_transcript_id'),
  },
  (t) => [
    unique('captures_owner_command_key_uq').on(t.ownerId, t.commandKey),
    // capture_revisions 가 "같은 owner 의 capture" 만 참조하도록 복합 FK 대상.
    unique('captures_id_owner_uq').on(t.id, t.ownerId),
    index('captures_owner_content_hash_idx').on(t.ownerId, t.contentHash),
    index('captures_owner_received_idx').on(t.ownerId, t.receivedAt.desc(), t.id.desc()),
    // T04 검색: pg_trgm GIN — ILIKE '%…%'(한국어 부분 문자열 포함)를 색인으로 가속한다.
    index('captures_raw_text_trgm_idx').using('gin', t.rawText.op('gin_trgm_ops')),
    foreignKey({
      name: 'captures_source_same_owner_fk',
      columns: [t.sourceId, t.ownerId],
      foreignColumns: [sources.id, sources.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'captures_transcript_same_owner_fk',
      columns: [t.captureTranscriptId, t.ownerId],
      foreignColumns: [transcripts.id, transcripts.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * capture 수정 이력(T03). revision 마다 한 행, 수정 가능한 필드의 그 시점 값을 담는다. raw_text 는 captures 에만 있다.
 * 생성 시 revision 1 을 남기고, 수정 성공 시 새 revision 을 남긴다(0002 이전 행은 첫 수정 때 직전 값을 먼저 보존).
 */
export const captureRevisions = pgTable(
  'capture_revisions',
  {
    id: id(),
    captureId: uuid('capture_id').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    userNote: text('user_note'),
    risk: text('risk').notNull(),
    title: text('title'),
    changedAt: ts('changed_at').notNull().defaultNow(),
    /** 'owner'(사용자 수정) | 'system'(0002 이전 행의 직전 값 보존) */
    changedBy: text('changed_by').notNull(),
  },
  (t) => [
    unique('capture_revisions_capture_revision_uq').on(t.captureId, t.revision),
    foreignKey({
      name: 'capture_revisions_capture_same_owner_fk',
      columns: [t.captureId, t.ownerId],
      foreignColumns: [captures.id, captures.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 콘텐츠 카드(T04): Idea / Audience / Evidence / Risk / Next Decision.
 * 수정은 revision 낙관적 잠금(stale → 409). 출처 소재 연결은 idea_captures(복합 FK) — 0003 에서 jsonb source_capture_ids 를 없앴다.
 */
export const ideas = pgTable(
  'ideas',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    idea: text('idea').notNull(),
    audience: text('audience'),
    evidence: text('evidence'),
    nextQuestion: text('next_question'),
    nextDecision: text('next_decision'),
    risk: text('risk').notNull().default('none'),
    lifecycle: text('lifecycle').notNull().default('candidate'),
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    revision: integer('revision').notNull().default(1),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('ideas_id_owner_uq').on(t.id, t.ownerId),
    index('ideas_owner_updated_idx').on(t.ownerId, t.updatedAt.desc(), t.id.desc()),
    index('ideas_idea_trgm_idx').using('gin', t.idea.op('gin_trgm_ops')),
  ],
);

/**
 * 원고(T04). 본문은 content_versions(불변)에만 있고, current_version_id 가 현재 버전을 가리킨다.
 * revision 은 메타데이터(제목·연재·독자·태그·상태) 수정용 낙관적 잠금 — 본문 버전과 별개다.
 * lifecycle: draft|review|ready|archived(CHECK). "게시됨" 같은 단일 published 플래그는 두지 않는다(docs/04, 배포는 M3 별도 테이블).
 */
export const contents = pgTable(
  'contents',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    ideaId: uuid('idea_id'),
    series: text('series'),
    title: text('title').notNull(),
    audience: text('audience'),
    tags: jsonb('tags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    revision: integer('revision').notNull().default(1),
    /** content_versions.id — 순환 FK 를 피하려고 애플리케이션 계층에서 검증한다(M1 T04). */
    currentVersionId: uuid('current_version_id'),
    lifecycle: text('lifecycle').notNull().default('draft'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // content_captures 가 "같은 owner 의 content" 만 참조하도록 복합 FK 대상.
    unique('contents_id_owner_uq').on(t.id, t.ownerId),
    // 같은 owner 의 idea 만 연결(복합 FK). idea_id 가 null 이면 검사하지 않는다(MATCH SIMPLE).
    foreignKey({
      name: 'contents_idea_same_owner_fk',
      columns: [t.ideaId, t.ownerId],
      foreignColumns: [ideas.id, ideas.ownerId],
    }).onDelete('restrict'),
    check('contents_lifecycle_chk', sql`${t.lifecycle} in ('draft', 'review', 'ready', 'archived')`),
    index('contents_owner_updated_idx').on(t.ownerId, t.updatedAt.desc(), t.id.desc()),
    index('contents_title_trgm_idx').using('gin', t.title.op('gin_trgm_ops')),
  ],
);

/**
 * 불변(immutable) 버전. 수정은 새 version 행으로만 한다.
 * DB 트리거 content_versions_immutable(0003)이 UPDATE·DELETE 를 예외로 막는다.
 */
export const contentVersions = pgTable(
  'content_versions',
  {
    id: id(),
    contentId: uuid('content_id')
      .notNull()
      .references(() => contents.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    body: text('body').notNull(),
    createdBy: text('created_by').notNull(),
    aiRunId: uuid('ai_run_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** T04: 저장 메모(선택). 버전과 함께 불변. */
    note: text('note'),
  },
  (t) => [
    unique('content_versions_content_version_uq').on(t.contentId, t.version),
    index('content_versions_body_trgm_idx').using('gin', t.body.op('gin_trgm_ops')),
  ],
);

/**
 * 채널별 파생본(T09, 결정 D14). 원고 하나에 채널마다 하나(unique(content_id, channel)).
 * lifecycle 은 draft | review 만(APPROVED 는 M3). stale 은 저장하지 않고 "현재 버전의 content_version_id ≠ 원고의 현재 버전"으로 파생한다.
 * current_version_id 는 variant_versions.id — 순환 FK 를 피하려고 앱에서 검증한다(contents 와 같은 방식).
 */
export const variants = pgTable(
  'variants',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    contentId: uuid('content_id').notNull(),
    channel: text('channel').notNull(),
    currentVersionId: uuid('current_version_id'),
    lifecycle: text('lifecycle').notNull().default('draft'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('variants_content_channel_uq').on(t.contentId, t.channel),
    unique('variants_id_owner_uq').on(t.id, t.ownerId),
    check('variants_channel_chk', sql`${t.channel} in ('threads', 'instagram', 'youtube', 'blog')`),
    check('variants_lifecycle_chk', sql`${t.lifecycle} in ('draft', 'review')`),
    foreignKey({
      name: 'variants_content_same_owner_fk',
      columns: [t.contentId, t.ownerId],
      foreignColumns: [contents.id, contents.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 파생본 버전(T09, 불변 — 추가 전용 트리거). content_version_id = 이 버전을 만든 원고 버전(stale 판정 기준).
 * metadata_json = 채널별 필드(@cs/domain channel.ts). created_by 'owner' | 'ai:mock'(AI 제안은 채택 전까지 현재 버전이 아니다).
 */
export const variantVersions = pgTable(
  'variant_versions',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    variantId: uuid('variant_id').notNull(),
    version: integer('version').notNull(),
    contentVersionId: uuid('content_version_id')
      .notNull()
      .references(() => contentVersions.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().notNull(),
    createdBy: text('created_by').notNull(),
    aiRunId: uuid('ai_run_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('variant_versions_variant_version_uq').on(t.variantId, t.version),
    unique('variant_versions_id_owner_uq').on(t.id, t.ownerId),
    check('variant_versions_created_by_chk', sql`${t.createdBy} = 'owner' or ${t.createdBy} like 'ai:%'`),
    check('variant_versions_version_chk', sql`${t.version} >= 1`),
    foreignKey({
      name: 'variant_versions_variant_same_owner_fk',
      columns: [t.variantId, t.ownerId],
      foreignColumns: [variants.id, variants.ownerId],
    }).onDelete('restrict'),
  ],
);

/** 원고 ↔ 원문(수집) 관계(T04). 같은 owner 끼리만(두 복합 FK). role: 'origin'(원고의 출처 소재). */
export const contentCaptures = pgTable(
  'content_captures',
  {
    id: id(),
    contentId: uuid('content_id').notNull(),
    captureId: uuid('capture_id').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role').notNull().default('origin'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('content_captures_content_capture_uq').on(t.contentId, t.captureId),
    index('content_captures_capture_idx').on(t.captureId),
    foreignKey({
      name: 'content_captures_content_same_owner_fk',
      columns: [t.contentId, t.ownerId],
      foreignColumns: [contents.id, contents.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'content_captures_capture_same_owner_fk',
      columns: [t.captureId, t.ownerId],
      foreignColumns: [captures.id, captures.ownerId],
    }).onDelete('restrict'),
  ],
);

/** 카드 ↔ 원문(수집) 관계(T04). 같은 owner 끼리만(두 복합 FK). */
export const ideaCaptures = pgTable(
  'idea_captures',
  {
    id: id(),
    ideaId: uuid('idea_id').notNull(),
    captureId: uuid('capture_id').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    role: text('role').notNull().default('origin'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('idea_captures_idea_capture_uq').on(t.ideaId, t.captureId),
    index('idea_captures_capture_idx').on(t.captureId),
    foreignKey({
      name: 'idea_captures_idea_same_owner_fk',
      columns: [t.ideaId, t.ownerId],
      foreignColumns: [ideas.id, ideas.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'idea_captures_capture_same_owner_fk',
      columns: [t.captureId, t.ownerId],
      foreignColumns: [captures.id, captures.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 인터뷰 답변(T06, 결정 D12). 불변: 행은 추가만 한다(트리거 interview_answers_immutable). 다시 답하면 새 행,
 * 같은 question_key 의 가장 최근 행이 "현재 답변"이다. 답변은 사용자만 입력한다(AI 가 채우지 않음).
 */
export const interviewAnswers = pgTable(
  'interview_answers',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    contentId: uuid('content_id').notNull(),
    questionKey: text('question_key').notNull(),
    /** FIX-T06(P2): 원고 안 저장 순번(원고 잠금 안에서 최대+1). 질문별 최신 판정은 created_at 이 아니라 이 값으로 한다. */
    seq: integer('seq').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    // generation_runs 입력 확인 시 "같은 owner·같은 원고의 답변" 조회용
    index('interview_answers_content_idx').on(t.contentId, t.questionKey, t.createdAt.desc()),
    check('interview_answers_question_key_chk', sql`${t.questionKey} in ('situation', 'judgment', 'takeaway')`),
    unique('interview_answers_content_seq_uq').on(t.contentId, t.seq),
    foreignKey({
      name: 'interview_answers_content_same_owner_fk',
      columns: [t.contentId, t.ownerId],
      foreignColumns: [contents.id, contents.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * AI 작성 보조 실행 기록(T06). 입력 버전(현재 본문 버전·브랜드 프로필 버전·답변 ID)을 고정해 남긴다.
 * status: running → succeeded | failed. 성공하면 output_ref = 제안 버전(content_versions, created_by='ai:mock', 현재 버전 아님).
 * output_json = { claims, followup_questions, warnings, proposed_tags, result_type }(모델 출력 — 승인·출처 증거 아님).
 */
export const generationRuns = pgTable(
  'generation_runs',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    contentId: uuid('content_id').notNull(),
    mode: text('mode').notNull(),
    inputVersionId: uuid('input_version_id')
      .notNull()
      .references(() => contentVersions.id, { onDelete: 'restrict' }),
    brandProfileId: uuid('brand_profile_id').notNull(),
    inputVersionRefs: jsonb('input_version_refs').$type<Record<string, unknown>>().notNull(),
    promptVersion: text('prompt_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(),
    outputRef: uuid('output_ref').references(() => contentVersions.id, { onDelete: 'restrict' }),
    outputJson: jsonb('output_json').$type<Record<string, unknown>>(),
    /** T09: 채널 초안 run 의 대상 파생본(mode='variant' 일 때만). */
    variantId: uuid('variant_id'),
    /**
     * FIX-T09(P1, 0011): 제안의 처리 상태 — 'proposed'(채택·무시 전) | 'adopted' | 'dismissed'. 버전 번호 선후가 아니라 이 값으로
     * 미채택 제안을 찾는다(뒤에 수정·첨부 변경이 있어도 제안이 사라지지 않게).
     */
    proposalStatus: text('proposal_status').notNull().default('proposed'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    unique('generation_runs_id_owner_uq').on(t.id, t.ownerId),
    index('generation_runs_content_idx').on(t.contentId, t.createdAt.desc()),
    // T09: 'variant' = 채널 초안 AI 제안(variant_id 필수). 결과는 variant_versions(created_by='ai:mock', ai_run_id)이고 output_ref 는 null.
    check('generation_runs_mode_chk', sql`${t.mode} in ('outline', 'draft', 'revise', 'variant')`),
    check('generation_runs_proposal_status_chk', sql`${t.proposalStatus} in ('proposed', 'adopted', 'dismissed')`),
    check('generation_runs_variant_chk', sql`(${t.mode} = 'variant') = (${t.variantId} is not null)`),
    foreignKey({
      name: 'generation_runs_variant_same_owner_fk',
      columns: [t.variantId, t.ownerId],
      foreignColumns: [variants.id, variants.ownerId],
    }).onDelete('restrict'),
    check('generation_runs_status_chk', sql`${t.status} in ('running', 'succeeded', 'failed')`),
    foreignKey({
      name: 'generation_runs_content_same_owner_fk',
      columns: [t.contentId, t.ownerId],
      foreignColumns: [contents.id, contents.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'generation_runs_brand_same_owner_fk',
      columns: [t.brandProfileId, t.ownerId],
      foreignColumns: [brandProfiles.id, brandProfiles.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 경험 claim 확인(T06, A03). 사용자가 "이 1인칭 경험은 사실"이라고 확인한 기록 — AI 가 만들지 않는다.
 * 불변(트리거 claim_confirmations_immutable). (run_id, claim_index) unique.
 */
export const claimConfirmations = pgTable(
  'claim_confirmations',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').notNull(),
    claimIndex: integer('claim_index').notNull(),
    /**
     * FIX-T06(P1): 'confirmed' = 사용자가 실제 경험이라고 확인, 'removed' = 사용자가 그 문장을 본문에서 뺐거나 고쳤다고 표시.
     * 둘 다 사용자 주장이며 AI 가 만들지 않는다. A03 게이트는 둘 다 "해결됨"으로 본다.
     */
    resolution: text('resolution').notNull().default('confirmed'),
    /**
     * FIX-T06 round 2: 해결을 기록할 때의 현재 본문 버전(0007). 'removed' 는 이 버전에 claim 문장이 없음을 서버가 확인한 뒤에만 저장되고,
     * 이후에도 "현재 본문에 없을 때만" 해결로 본다(다시 넣으면 다시 미해결). 0007 이전 행은 null.
     */
    bodyVersionId: uuid('body_version_id').references(() => contentVersions.id, { onDelete: 'restrict' }),
    confirmedAt: ts('confirmed_at').notNull().defaultNow(),
  },
  (t) => [
    // 0007: claim 하나에 해결 방식별 한 행(확인·제외가 각각 한 번씩 가능 — 제외 후 다시 넣은 문장을 나중에 확인할 수 있게).
    unique('claim_confirmations_run_claim_resolution_uq').on(t.runId, t.claimIndex, t.resolution),
    check('claim_confirmations_claim_index_chk', sql`${t.claimIndex} >= 0`),
    check('claim_confirmations_resolution_chk', sql`${t.resolution} in ('confirmed', 'removed')`),
    foreignKey({
      name: 'claim_confirmations_run_same_owner_fk',
      columns: [t.runId, t.ownerId],
      foreignColumns: [generationRuns.id, generationRuns.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 주장(claim)과 근거(T07, 결정 D13). AI 제안 버전(content_versions)마다 출력 claim 을 한 행씩 남긴다(불변, 추가 전용 트리거).
 * - evidence_grade: 저장 시점 판정 'none' | 'source'(허용 목록 안 출처가 있음). 'user_confirmed' 는 저장하지 않고
 *   claim_confirmations(resolution='confirmed')에서 화면·API 가 파생한다(claims 는 불변).
 * - needs_check: 경험 claim, 근거 없는 사실 claim, 허용 목록 밖 출처를 버린 claim.
 * - 모델이 만든(허용 목록에 없는) 출처는 claim_sources 에 저장하지 않는다.
 */
export const claims = pgTable(
  'claims',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    contentVersionId: uuid('content_version_id')
      .notNull()
      .references(() => contentVersions.id, { onDelete: 'restrict' }),
    runId: uuid('run_id').notNull(),
    /** T09: 채널 초안 run 의 claim 이면 그 제안 variant_version(content_version_id 는 파생 기준 원고 버전). */
    variantVersionId: uuid('variant_version_id').references(() => variantVersions.id, { onDelete: 'restrict' }),
    claimIndex: integer('claim_index').notNull(),
    statement: text('statement').notNull(),
    kind: text('kind').notNull(),
    evidenceGrade: text('evidence_grade').notNull(),
    personalExperienceConfirmed: boolean('personal_experience_confirmed').notNull().default(false),
    needsCheck: boolean('needs_check').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('claims_id_owner_uq').on(t.id, t.ownerId),
    // T09: 한 원고 버전에서 여러 run(원고 제안·채널 초안)이 나올 수 있어 run 기준으로 바꿨다.
    unique('claims_run_index_uq').on(t.runId, t.claimIndex),
    // FIX-T07(P1): 'user_confirmed' 는 저장하지 않는다 — claim_confirmations(confirmed)에서만 파생(0010 에서 기존 값은 'none' 으로).
    check('claims_evidence_grade_chk', sql`${t.evidenceGrade} in ('none', 'source')`),
    check('claims_kind_chk', sql`${t.kind} in ('fact', 'opinion', 'experience')`),
    foreignKey({
      name: 'claims_run_same_owner_fk',
      columns: [t.runId, t.ownerId],
      foreignColumns: [generationRuns.id, generationRuns.ownerId],
    }).onDelete('restrict'),
  ],
);

/** claim ↔ 허용된 source_version(T07). locator = 출처 위치(URL 등, 사용자 소재에서 온 값). 불변. */
export const claimSources = pgTable(
  'claim_sources',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    claimId: uuid('claim_id').notNull(),
    sourceVersionId: uuid('source_version_id')
      .notNull()
      .references(() => sourceVersions.id, { onDelete: 'restrict' }),
    locator: text('locator'),
    supportNote: text('support_note'),
  },
  (t) => [
    unique('claim_sources_claim_source_uq').on(t.claimId, t.sourceVersionId),
    foreignKey({
      name: 'claim_sources_claim_same_owner_fk',
      columns: [t.claimId, t.ownerId],
      foreignColumns: [claims.id, claims.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * AI 비용 원장(T07, A15). T08: 음성 전사 job 도 같은 원장을 쓴다 — 행마다 run_id 또는 transcription_job_id 중 정확히 하나.
 * run 마다 한 행: 호출 전 reserved(예약액) → 호출 후 settled(실제액).
 * 실패한 호출도 settled + actual = reserved + failed=true 로 남긴다(docs/02: 실패 재시도도 예약량에 반영). released 는 예약 취소(현재 경로 없음).
 * 금액은 numeric(18,6) 문자열. pricing_snapshot 에는 단가 값만(키·비밀 없음).
 */
export const usageLedger = pgTable(
  'usage_ledger',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    runId: uuid('run_id'),
    /** T08: 음성 전사 job(모의 포함). run_id 와 둘 중 하나만. */
    transcriptionJobId: uuid('transcription_job_id'),
    /** T08: 예약·확정에 쓴 음성 길이(초). 전사 원장만. */
    audioSeconds: integer('audio_seconds'),
    reservedAmount: numeric('reserved_amount', { precision: 18, scale: 6 }).notNull(),
    actualAmount: numeric('actual_amount', { precision: 18, scale: 6 }),
    currency: text('currency').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    pricingSnapshot: jsonb('pricing_snapshot').$type<Record<string, unknown>>().notNull(),
    state: text('state').notNull(),
    failed: boolean('failed').notNull().default(false),
    /** FIX-T07(P1, 0010): 실제액이 예약액을 넘은 만큼(숨기거나 자르지 않는다). 넘지 않았으면 0. */
    overageAmount: numeric('overage_amount', { precision: 18, scale: 6 }).notNull().default('0'),
    /** 실제액 > 예약액 이었으면 true */
    overBudget: boolean('over_budget').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    settledAt: ts('settled_at'),
  },
  (t) => [
    unique('usage_ledger_run_uq').on(t.runId),
    unique('usage_ledger_transcription_job_uq').on(t.transcriptionJobId),
    check('usage_ledger_subject_chk', sql`num_nonnulls(${t.runId}, ${t.transcriptionJobId}) = 1`),
    check('usage_ledger_state_chk', sql`${t.state} in ('reserved', 'settled', 'released')`),
    index('usage_ledger_owner_created_idx').on(t.ownerId, t.createdAt),
    foreignKey({
      name: 'usage_ledger_run_same_owner_fk',
      columns: [t.runId, t.ownerId],
      foreignColumns: [generationRuns.id, generationRuns.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'usage_ledger_transcription_job_same_owner_fk',
      columns: [t.transcriptionJobId, t.ownerId],
      foreignColumns: [transcriptionJobs.id, transcriptionJobs.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 파일 메타데이터. 파일 바이트는 StorageAdapter(개발: local-file)에 두고 DB 에는 key·checksum 만 저장한다.
 * (owner_id, checksum) unique: 같은 owner 의 동일 파일은 한 행만(T02: 중복 업로드는 기존 asset 반환).
 */
export const assets = pgTable(
  'assets',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    key: text('key').notNull().unique(),
    mime: text('mime').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    checksum: text('checksum').notNull(),
    rightsStatus: text('rights_status').notNull().default('unknown'),
    verificationState: text('verification_state').notNull().default('pending'),
    /**
     * T08(D15): VERIFIED 가 실제로 확인한 범위. 'signature_size_checksum' = 앞부분 형식 서명·크기·sha256(디코딩·재생 가능 여부는 확인 안 함).
     */
    verificationScope: text('verification_scope').notNull().default('signature_size_checksum'),
    /** T08: 원음 보존을 끈 전사 뒤 파일을 지운 시각. 행(메타데이터)은 남고 다운로드는 410. */
    deletedAt: ts('deleted_at'),
    /**
     * FIX-T08 round 2(0013): 지울 파일의 저장 key(삭제 의도). 원음 삭제·재업로드 복구가 먼저 이 값을 커밋하고, 커밋 뒤 파일을 지운 다음 비운다.
     * 파일 삭제가 실패하거나 프로세스가 죽으면 값이 남고 worker(assets.cleanup)가 다시 시도한다. 현재 key 와 같은 파일은 지우지 않는다.
     * 운영 상태이므로 내보내기 묶음에 넣지 않는다(복원한 행은 항상 null — 묶음이 다른 파일 삭제를 지시하지 못하게).
     */
    pendingDeleteKey: text('pending_delete_key'),
    /**
     * FIX-T08 round 3(0014): 정리 실패 횟수와 다음 재시도 시각(지수 backoff, 최대 6시간). 성공하면 비운다. 운영 상태 — 묶음에 넣지 않음.
     * round 4(0015): 의도를 만들 때 next_at = 만든 시각(NULL 아님) — 새 의도와 재시도가 한 시간축으로 줄을 선다.
     */
    pendingDeleteAttempts: integer('pending_delete_attempts').notNull().default(0),
    pendingDeleteNextAt: ts('pending_delete_next_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('assets_owner_checksum_uq').on(t.ownerId, t.checksum),
    // T09: variant_assets 가 "같은 owner 의 파일" 만 참조하도록 복합 FK 대상.
    unique('assets_id_owner_uq').on(t.id, t.ownerId),
  ],
);

/**
 * 채널 초안 버전의 첨부 파일(T09). 버전과 함께 불변(추가 전용 트리거). 순서(position)는 버전 안에서 unique.
 * role: image | video | thumbnail | attachment — 역할과 파일 형식이 맞는지는 앱이 검사한다(image/thumbnail 은 image/*, video 는 video/*).
 */
export const variantAssets = pgTable(
  'variant_assets',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    variantVersionId: uuid('variant_version_id').notNull(),
    assetId: uuid('asset_id').notNull(),
    position: integer('position').notNull(),
    role: text('role').notNull(),
  },
  (t) => [
    unique('variant_assets_version_position_uq').on(t.variantVersionId, t.position),
    check('variant_assets_role_chk', sql`${t.role} in ('image', 'video', 'thumbnail', 'attachment')`),
    check('variant_assets_position_chk', sql`${t.position} >= 1`),
    foreignKey({
      name: 'variant_assets_version_same_owner_fk',
      columns: [t.variantVersionId, t.ownerId],
      foreignColumns: [variantVersions.id, variantVersions.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'variant_assets_asset_same_owner_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assets.id, assets.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 감사 기록. owner_id 는 인증 전 이벤트(예: auth.login_denied — 아직 owner 가 확인되지 않음)에 한해 null(T02).
 * owner 범위 조회는 owner_id 로 필터하므로 null 행은 어떤 owner 의 목록에도 나타나지 않는다.
 */
export const auditEvents = pgTable('audit_events', {
  id: id(),
  ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'restrict' }),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  versionOrHash: text('version_or_hash'),
  at: ts('at').notNull().defaultNow(),
  sanitizedDetails: jsonb('sanitized_details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
});

/**
 * 로그인 세션(T02, 결정 D3). 토큰 원문은 쿠키에만 있고 DB 에는 sha256 hex(token_hash)만 저장한다.
 * 유효 조건: expires_at > now AND revoked_at IS NULL.
 * 주의(T05): export/restore 대상에서 제외한다 — 세션은 인증 비밀과 같은 등급이며 이식 대상이 아니다.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    revokedAt: ts('revoked_at'),
    userAgentHash: text('user_agent_hash'),
  },
  (t) => [index('sessions_owner_idx').on(t.ownerId)],
);

/**
 * 내보내기 실행 기록(T05). path 는 워크스페이스 루트 기준 상대 경로(루트 밖이면 파일 이름만) — 비밀·절대 경로를 넣지 않는다.
 * 주의: export/restore 대상에서 제외한다(@cs/domain EXCLUDED_TABLES) — 환경마다 다른 운영 기록이다.
 */
export const exportRuns = pgTable(
  'export_runs',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    formatVersion: integer('format_version').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    zipBytes: bigint('zip_bytes', { mode: 'number' }).notNull(),
    path: text('path').notNull(),
    status: text('status').notNull(),
    totals: jsonb('totals').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    check('export_runs_status_chk', sql`${t.status} in ('completed', 'failed')`),
    index('export_runs_owner_created_idx').on(t.ownerId, t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * 복원 실행 기록(T05). preview 는 미리보기 결과(표별 건수·경고), result 는 커밋 결과(표별 건수). 올린 ZIP 은 data/restores/<id>.zip.
 * status: previewed → committed | rejected(커밋 시 재검증 실패) | failed(커밋 중 오류). 커밋은 한 번만.
 * 주의: export/restore 대상에서 제외한다(@cs/domain EXCLUDED_TABLES).
 */
export const restoreRuns = pgTable(
  'restore_runs',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    source: text('source').notNull(),
    manifestSha256: text('manifest_sha256').notNull(),
    preview: jsonb('preview').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull(),
    committedAt: ts('committed_at'),
    mode: text('mode'),
    result: jsonb('result').$type<Record<string, unknown>>(),
  },
  (t) => [
    check('restore_runs_source_chk', sql`${t.source} in ('upload', 'export_run')`),
    check('restore_runs_status_chk', sql`${t.status} in ('previewed', 'committed', 'rejected', 'failed')`),
    check('restore_runs_mode_chk', sql`${t.mode} is null or ${t.mode} in ('empty_only', 'add_missing')`),
    index('restore_runs_owner_created_idx').on(t.ownerId, t.createdAt.desc(), t.id.desc()),
  ],
);

/**
 * 업로드 세션(T08, A14). 큰 음성·영상 파일을 조각으로 받는다. 조각 파일은 STORAGE_LOCAL_DIR/uploads/<owner>/<session>/<index>.
 * state: open → completed(조립·검사 중) → verified(asset 생성) | rejected(검사 실패, 조각 삭제) / open → aborted | expired(24시간, worker 가 조각 삭제).
 * 주의: export/restore 대상에서 제외한다 — 전송 중 임시 상태이며 조각 파일은 묶음에 넣지 않는다.
 */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    declaredMime: text('declared_mime').notNull(),
    declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),
    receivedBytes: bigint('received_bytes', { mode: 'number' }).notNull().default(0),
    chunkSize: integer('chunk_size').notNull(),
    checksumExpected: text('checksum_expected'),
    checksumActual: text('checksum_actual'),
    state: text('state').notNull().default('open'),
    /** rejected 이유(코드): size_mismatch | unsupported_signature | mime_mismatch | checksum_mismatch | assembly_failed */
    rejectReason: text('reject_reason'),
    assetId: uuid('asset_id'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('upload_sessions_id_owner_uq').on(t.id, t.ownerId),
    check('upload_sessions_kind_chk', sql`${t.kind} in ('audio', 'video')`),
    check('upload_sessions_state_chk', sql`${t.state} in ('open', 'completed', 'verified', 'rejected', 'aborted', 'expired')`),
    check('upload_sessions_bytes_chk', sql`${t.declaredBytes} > 0 and ${t.receivedBytes} >= 0`),
    check('upload_sessions_chunk_size_chk', sql`${t.chunkSize} between 4194304 and 8388608`),
    index('upload_sessions_owner_created_idx').on(t.ownerId, t.createdAt.desc()),
    index('upload_sessions_state_expires_idx').on(t.state, t.expiresAt),
    foreignKey({
      name: 'upload_sessions_asset_same_owner_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assets.id, assets.ownerId],
    }).onDelete('restrict'),
  ],
);

/** 받은 조각(T08). 같은 번호를 같은 sha256 으로 다시 보내면 그대로(멱등), 다른 sha256 이면 409. export 제외. */
export const uploadChunks = pgTable(
  'upload_chunks',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sessionId: uuid('session_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('upload_chunks_session_index_uq').on(t.sessionId, t.chunkIndex),
    check('upload_chunks_index_chk', sql`${t.chunkIndex} >= 0 and ${t.bytes} > 0`),
    foreignKey({
      name: 'upload_chunks_session_same_owner_fk',
      columns: [t.sessionId, t.ownerId],
      foreignColumns: [uploadSessions.id, uploadSessions.ownerId],
    }).onDelete('cascade'),
  ],
);

/**
 * 음성 전사 job(T08, 결정 D9). queued → running(진행률 25·50·75) → succeeded(100, transcripts v1) | failed / queued·running → canceled.
 * provider 는 T08 에서 항상 'mock'. transcript_version_id 는 이 job 이 만든 첫 전사(v1) — transcripts 와 서로 참조하므로 DB FK 대신
 * 앱·묶음 검사로 강제한다(같은 job·같은 owner).
 * 같은 asset 에 진행 중(queued·running) job 은 하나만(부분 unique 색인).
 */
export const transcriptionJobs = pgTable(
  'transcription_jobs',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assetId: uuid('asset_id').notNull(),
    state: text('state').notNull().default('queued'),
    provider: text('provider').notNull().default('mock'),
    model: text('model').notNull(),
    progress: integer('progress').notNull().default(0),
    transcriptVersionId: uuid('transcript_version_id'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    /** false 면 전사 성공 뒤 원본 파일을 지운다(assets.deleted_at). */
    keepOriginal: boolean('keep_original').notNull().default(true),
    /** 예약에 쓴 음성 길이(초) */
    audioSeconds: integer('audio_seconds').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    unique('transcription_jobs_id_owner_uq').on(t.id, t.ownerId),
    check('transcription_jobs_state_chk', sql`${t.state} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`),
    check('transcription_jobs_progress_chk', sql`${t.progress} between 0 and 100`),
    check('transcription_jobs_audio_seconds_chk', sql`${t.audioSeconds} > 0`),
    index('transcription_jobs_owner_asset_idx').on(t.ownerId, t.assetId, t.createdAt.desc()),
    index('transcription_jobs_state_idx').on(t.state, t.createdAt),
    uniqueIndex('transcription_jobs_active_asset_uq').on(t.assetId).where(sql`${t.state} in ('queued', 'running')`),
    foreignKey({
      name: 'transcription_jobs_asset_same_owner_fk',
      columns: [t.assetId, t.ownerId],
      foreignColumns: [assets.id, assets.ownerId],
    }).onDelete('restrict'),
  ],
);

/**
 * 전사 본문 버전(T08). 불변(추가 전용 트리거). v1 = 전사기 결과(created_by 'mock'), 이후 = 사용자 수정(created_by 'owner').
 * segments = [{start_ms, end_ms, text}] (사용자 수정 버전은 []).
 */
export const transcripts = pgTable(
  'transcripts',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    jobId: uuid('job_id').notNull(),
    version: integer('version').notNull(),
    text: text('text').notNull(),
    segments: jsonb('segments').$type<Array<{ start_ms: number; end_ms: number; text: string }>>().notNull().default(sql`'[]'::jsonb`),
    createdBy: text('created_by').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('transcripts_job_version_uq').on(t.jobId, t.version),
    unique('transcripts_id_owner_uq').on(t.id, t.ownerId),
    check('transcripts_created_by_chk', sql`${t.createdBy} in ('mock', 'owner')`),
    check('transcripts_version_chk', sql`${t.version} >= 1`),
    foreignKey({
      name: 'transcripts_job_same_owner_fk',
      columns: [t.jobId, t.ownerId],
      foreignColumns: [transcriptionJobs.id, transcriptionJobs.ownerId],
    }).onDelete('restrict'),
  ],
);
