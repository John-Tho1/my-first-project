/**
 * M1 테이블(docs/04 "M1은 users/brand_profiles/captures/sources/ideas/contents/content_versions/assets부터").
 * - 모든 시각은 timestamptz(UTC 저장). 표시는 MSK(@cs/domain formatMsk).
 * - owner 참조는 DB FK 로도 강제한다. 하위 테이블(source_versions, content_versions)은 부모의 owner 를 따른다.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
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
  },
  (t) => [unique('brand_profiles_owner_version_uq').on(t.ownerId, t.version)],
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
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [unique('assets_owner_checksum_uq').on(t.ownerId, t.checksum)],
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
