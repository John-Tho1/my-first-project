/**
 * M1 테이블(docs/04 "M1은 users/brand_profiles/captures/sources/ideas/contents/content_versions/assets부터").
 * - 모든 시각은 timestamptz(UTC 저장). 표시는 MSK(@cs/domain formatMsk).
 * - owner 참조는 DB FK 로도 강제한다. 하위 테이블(source_versions, content_versions)은 부모의 owner 를 따른다.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
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
  },
  // (id, owner_id) 복합 unique: captures 가 "같은 owner 의 source" 만 참조하도록 복합 FK 대상.
  (t) => [unique('sources_id_owner_uq').on(t.id, t.ownerId)],
);

export const sourceVersions = pgTable('source_versions', {
  id: id(),
  sourceId: uuid('source_id')
    .notNull()
    .references(() => sources.id, { onDelete: 'restrict' }),
  rawHash: text('raw_hash').notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
  excerpt: text('excerpt'),
  extractionState: text('extraction_state').notNull().default('pending'),
});

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
  },
  (t) => [
    unique('captures_owner_command_key_uq').on(t.ownerId, t.commandKey),
    foreignKey({
      name: 'captures_source_same_owner_fk',
      columns: [t.sourceId, t.ownerId],
      foreignColumns: [sources.id, sources.ownerId],
    }).onDelete('restrict'),
  ],
);

export const ideas = pgTable(
  'ideas',
  {
  id: id(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  idea: text('idea').notNull(),
  audience: text('audience'),
  nextQuestion: text('next_question'),
  risk: text('risk').notNull().default('none'),
  lifecycle: text('lifecycle').notNull().default('candidate'),
  sourceCaptureIds: jsonb('source_capture_ids').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [unique('ideas_id_owner_uq').on(t.id, t.ownerId)],
);

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
  /** content_versions.id — 순환 FK 를 피하려고 애플리케이션 계층에서 검증한다(M1 T04). */
  currentVersionId: uuid('current_version_id'),
  lifecycle: text('lifecycle').notNull().default('draft'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // 같은 owner 의 idea 만 연결(복합 FK). idea_id 가 null 이면 검사하지 않는다(MATCH SIMPLE).
    foreignKey({
      name: 'contents_idea_same_owner_fk',
      columns: [t.ideaId, t.ownerId],
      foreignColumns: [ideas.id, ideas.ownerId],
    }).onDelete('restrict'),
  ],
);

/** 불변(immutable) 버전. 수정은 새 version 행으로만 한다. */
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
  },
  (t) => [unique('content_versions_content_version_uq').on(t.contentId, t.version)],
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
