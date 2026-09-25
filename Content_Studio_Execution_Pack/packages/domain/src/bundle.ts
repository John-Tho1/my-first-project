/**
 * 내보내기 묶음(bundle) 형식 `content-studio-export` v1(T05, 결정 D6) — 순수 함수(DB·파일 시스템 없음).
 *
 * 묶음 안의 파일
 * - manifest.json            형식·버전·migration·owner(가린 식별자)·표별 행 수와 sha256·모든 파일의 sha256·asset 목록
 * - data/<table>.json        표마다 행 배열(id 오름차순). 시각은 UTC ISO(마이크로초), jsonb 는 그대로.
 *                            **owner_id 열은 넣지 않는다**: 묶음은 owner 한 명의 데이터이고 owner 는 manifest.owner 에 있다.
 *                            그래서 다른 owner(다른 id)로 복원한 뒤 다시 내보내도 표 sha256 이 같다.
 * - markdown/contents|captures|ideas/<id>.md   사람이 읽는 사본(복원에는 쓰지 않음)
 * - assets/<asset id>.<ext>  파일 바이트
 * - README.md                묶음 설명(한국어)
 *
 * 제외: sessions(인증 비밀 등급), export_runs·restore_runs(운영 기록), upload_sessions·upload_chunks(T08 전송 중 임시 상태). OAuth·API key 는 DB 에 없고 앞으로 생겨도 제외 목록에 넣는다.
 * 새 표가 생기면 EXPORTED_TABLES 나 EXCLUDED_TABLES 중 하나에 넣어야 한다(@cs/db 단위 테스트가 schema.ts 와 대조).
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CONTENT_LIFECYCLES } from './content';
import { MOCK_EXTERNAL_PREFIX, payloadHash } from './distribution';
import { AppError } from './errors';
import { extensionForMime, isValidStorageKey } from './media';
import { formatMsk } from './time';
import type { ZipEntry } from './zip';

export const BUNDLE_FORMAT = 'content-studio-export' as const;
export const BUNDLE_FORMAT_VERSION = 1 as const;

/** 복원 순서(FK 순서)와 같다. users·audit_events 는 내보내기만 하고 복원하지 않는다. */
export const EXPORTED_TABLES = [
  'users',
  'brand_profiles',
  'sources',
  'source_versions',
  // T08: captures.capture_transcript_id → transcripts → transcription_jobs → assets 이므로 셋 모두 captures 보다 먼저.
  'assets',
  'transcription_jobs',
  'transcripts',
  'captures',
  'capture_revisions',
  'ideas',
  'idea_captures',
  'contents',
  'content_versions',
  'content_captures',
  // T09: variants 는 generation_runs(variant_id) 보다, variant_versions 는 claims(variant_version_id) 보다 먼저.
  'variants',
  'variant_versions',
  'interview_answers',
  'generation_runs',
  'claim_confirmations',
  'claims',
  'claim_sources',
  'usage_ledger',
  'variant_assets',
  // T10(0016, 결정 D17): 계정(모의)·계획·불변 항목 스냅샷·승인은 복원한다. 작업·작업 이력·실행 명령은 내보내기만(복원 안 함).
  'channel_accounts',
  'distribution_plans',
  'distribution_items',
  'approvals',
  'jobs',
  'job_events',
  'execute_commands',
  // T11(0017, 결정 D18): 전송 의도·원격 결과는 내보내기만 — 복원한 환경은 원격을 다시 확인해야지 기록을 믿고 이어 가지 않는다.
  'send_intents',
  'publications',
  // T12(0018, 결정 D19): 항목별 모의 시나리오(개발·시험용) — 내보내기만. 복원 환경의 모의 결과를 미리 정해 두지 않는다.
  'mock_scenarios',
  'audit_events',
] as const;
export type ExportedTable = (typeof EXPORTED_TABLES)[number];

/**
 * 나중 migration 에서 생긴 표(T06~). 그 migration 이전에 만든 묶음에는 표 파일이 없으므로 빈 표로 읽는다
 * (묶음의 schema_migrations 에 그 태그가 없을 때만 — 있으면 표 파일이 반드시 있어야 한다).
 */
export const TABLE_INTRODUCED_IN: Partial<Record<ExportedTable, string>> = {
  interview_answers: '0005_t06_writing',
  generation_runs: '0005_t06_writing',
  claim_confirmations: '0005_t06_writing',
  claims: '0008_t07_budget_claims',
  claim_sources: '0008_t07_budget_claims',
  usage_ledger: '0008_t07_budget_claims',
  variants: '0009_t09_variants',
  variant_versions: '0009_t09_variants',
  variant_assets: '0009_t09_variants',
  transcription_jobs: '0012_t08_uploads_transcription',
  transcripts: '0012_t08_uploads_transcription',
  channel_accounts: '0016_t10_distribution',
  distribution_plans: '0016_t10_distribution',
  distribution_items: '0016_t10_distribution',
  approvals: '0016_t10_distribution',
  jobs: '0016_t10_distribution',
  job_events: '0016_t10_distribution',
  execute_commands: '0016_t10_distribution',
  send_intents: '0017_t11_jobs',
  publications: '0017_t11_jobs',
  mock_scenarios: '0018_t12_mock_scenarios',
};

export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  sessions: '로그인 세션 — 인증 비밀과 같은 등급이며 다른 환경으로 옮기지 않는다',
  export_runs: '내보내기 실행 기록(운영 기록, 환경마다 다름)',
  restore_runs: '복원 실행 기록(운영 기록, 환경마다 다름)',
  upload_sessions: '업로드 세션(T08) — 전송 중 임시 상태. 완료된 파일은 assets 로 내보낸다',
  upload_chunks: '업로드 조각(T08) — 전송 중 임시 파일 목록. 조각 바이트는 묶음에 넣지 않는다',
};

/**
 * users·audit_events 는 내보내기만. T10(D17): jobs·job_events·execute_commands 도 내보내기만 — 복원 환경에서 작업을 다시 돌리지 않는다
 * (진행 중이던 항목은 BLOCKED 로 들여온다, 맹목 재전송 금지). T11(D18): send_intents·publications 도 내보내기만 — 원격 결과는 복원 환경에서
 * 다시 확인할 사실이지 믿고 이어 갈 기록이 아니다. T12(D19): mock_scenarios(개발용 모의 결과 선택)도 내보내기만.
 */
export const NON_RESTORED_TABLES = ['users', 'audit_events', 'jobs', 'job_events', 'execute_commands', 'send_intents', 'publications', 'mock_scenarios'] as const satisfies readonly ExportedTable[];
export const RESTORED_TABLES = EXPORTED_TABLES.filter((t) => !(NON_RESTORED_TABLES as readonly string[]).includes(t)) as Exclude<
  ExportedTable,
  (typeof NON_RESTORED_TABLES)[number]
>[];
export type RestoredTable = (typeof RESTORED_TABLES)[number];

// ---- 결정적 직렬화·해시 ----

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** 키 정렬 + 2칸 들여쓰기 + 끝 줄바꿈. 같은 값은 항상 같은 바이트가 된다. */
export function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

// ---- 행 스키마(내보내는 열만, 모르는 열은 거부) ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const uuid = z.string().regex(UUID_RE);
const ts = z.string().regex(TS_RE);
const str = z.string();
const nstr = z.string().nullable();
const int = z.int();
const strArr = z.array(z.string());
/** numeric(18,6) 문자열(T07 원장 금액). */
const amount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);

export const ROW_SCHEMAS = {
  users: z.strictObject({ id: uuid, identity_masked: str }),
  brand_profiles: z.strictObject({
    id: uuid,
    version: int,
    pen_name: str,
    audience: str,
    pillars: strArr,
    style_rules: strArr,
    created_at: ts,
    // T06(0005) 열: 이전 묶음에는 없으므로 DB 기본값과 같은 값으로 채운다.
    tone: z.enum(['formal', 'casual']).default('formal'),
    avoid_phrases: strArr.default([]),
    cta_rules: strArr.default([]),
    sample_texts: strArr.default([]),
  }),
  sources: z.strictObject({
    id: uuid,
    kind: str,
    canonical_url: nstr,
    external_provider: nstr,
    external_id: nstr,
    external_revision: nstr,
    checked_at: ts.nullable(),
    content_hash: nstr,
    rights_status: str,
    normalized_url: nstr,
  }),
  source_versions: z.strictObject({
    id: uuid,
    source_id: uuid,
    raw_hash: nstr,
    fetched_at: ts,
    excerpt: nstr,
    extraction_state: str,
  }),
  captures: z.strictObject({
    id: uuid,
    raw_text: str,
    input_type: z.enum(['text', 'url', 'file', 'voice']),
    source_id: uuid.nullable(),
    received_at: ts,
    risk: str,
    user_note: nstr,
    command_key: str,
    title: nstr,
    revision: int,
    updated_at: ts,
    content_hash: nstr,
    // 0012 열. 이전 묶음에는 없으므로 null.
    capture_transcript_id: uuid.nullable().default(null),
  }),
  capture_revisions: z.strictObject({
    id: uuid,
    capture_id: uuid,
    revision: int,
    user_note: nstr,
    risk: str,
    title: nstr,
    changed_at: ts,
    changed_by: str,
  }),
  ideas: z.strictObject({
    id: uuid,
    idea: str,
    audience: nstr,
    evidence: nstr,
    next_question: nstr,
    next_decision: nstr,
    risk: str,
    lifecycle: str,
    tags: strArr,
    revision: int,
    created_at: ts,
    updated_at: ts,
  }),
  idea_captures: z.strictObject({ id: uuid, idea_id: uuid, capture_id: uuid, role: str, created_at: ts }),
  contents: z.strictObject({
    id: uuid,
    idea_id: uuid.nullable(),
    series: nstr,
    title: str,
    audience: nstr,
    tags: strArr,
    revision: int,
    current_version_id: uuid.nullable(),
    lifecycle: z.enum(CONTENT_LIFECYCLES),
    created_at: ts,
    updated_at: ts,
  }),
  content_versions: z.strictObject({
    id: uuid,
    content_id: uuid,
    version: int.min(1),
    body: str,
    created_by: str,
    ai_run_id: uuid.nullable(),
    created_at: ts,
    note: nstr,
  }),
  content_captures: z.strictObject({ id: uuid, content_id: uuid, capture_id: uuid, role: str, created_at: ts }),
  interview_answers: z.strictObject({
    id: uuid,
    content_id: uuid,
    question_key: z.enum(['situation', 'judgment', 'takeaway']),
    question: str,
    answer: str,
    created_at: ts,
    // 0006 열. 0005 묶음에는 없으므로 parseBundle 이 원고별 (created_at, id) 순서로 채운다(migration 0006 의 채움과 같은 규칙).
    seq: int.min(1).optional(),
  }),
  generation_runs: z.strictObject({
    id: uuid,
    content_id: uuid,
    mode: z.enum(['outline', 'draft', 'revise', 'variant']),
    input_version_id: uuid,
    brand_profile_id: uuid,
    input_version_refs: z.record(z.string(), z.unknown()),
    prompt_version: str,
    provider: str,
    model: str,
    status: z.enum(['running', 'succeeded', 'failed']),
    output_ref: uuid.nullable(),
    output_json: z.record(z.string(), z.unknown()).nullable(),
    error: nstr,
    created_at: ts,
    finished_at: ts.nullable(),
    // 0009 열(채널 초안 run). 이전 묶음에는 없으므로 null.
    variant_id: uuid.nullable().default(null),
    // 0011 열. 이전 묶음에는 없으므로 'proposed'(채택 여부는 버전 행으로 따로 남아 있다).
    // FIX-T09 round 2: 없으면 parseBundle 이 채택 이력(ai_run_id 를 가진 사용자 버전)으로 채운다(fillProposalStatus).
    proposal_status: z.enum(['proposed', 'adopted', 'dismissed']).optional(),
  }),
  claim_confirmations: z.strictObject({
    id: uuid,
    run_id: uuid,
    claim_index: int.min(0),
    confirmed_at: ts,
    // 0006 열. 이전 묶음은 확인만 있었으므로 'confirmed'.
    resolution: z.enum(['confirmed', 'removed']).default('confirmed'),
    // 0007 열. 이전 묶음에는 없으므로 null(게이트는 'removed' 를 현재 본문으로 다시 검사한다).
    body_version_id: uuid.nullable().default(null),
  }),
  // T09(0009)
  variants: z.strictObject({
    id: uuid,
    content_id: uuid,
    channel: z.enum(['threads', 'instagram', 'youtube', 'blog']),
    current_version_id: uuid.nullable(),
    // T10(0016): 'approved' 추가(복원 사후 검사가 활성 승인이 없으면 review/draft 로 낮춘다).
    lifecycle: z.enum(['draft', 'review', 'approved']),
    created_at: ts,
    updated_at: ts,
  }),
  variant_versions: z.strictObject({
    id: uuid,
    variant_id: uuid,
    version: int.min(1),
    content_version_id: uuid,
    body: str,
    metadata_json: z.record(z.string(), z.unknown()),
    created_by: str,
    ai_run_id: uuid.nullable(),
    created_at: ts,
  }),
  variant_assets: z.strictObject({
    id: uuid,
    variant_version_id: uuid,
    asset_id: uuid,
    position: int.min(1),
    role: z.enum(['image', 'video', 'thumbnail', 'attachment']),
  }),
  // T07(0008)
  claims: z.strictObject({
    id: uuid,
    content_version_id: uuid,
    run_id: uuid,
    claim_index: int.min(0),
    statement: str,
    kind: z.enum(['fact', 'opinion', 'experience']),
    // FIX-T07(P1): 'user_confirmed' 는 저장·복원하지 않는다(claim_confirmations 에서만 파생) — 묶음에 있으면 거부.
    evidence_grade: z.enum(['none', 'source']),
    personal_experience_confirmed: z.boolean(),
    needs_check: z.boolean(),
    // 0009 열. 이전 묶음에는 없으므로 null.
    variant_version_id: uuid.nullable().default(null),
    created_at: ts,
  }),
  claim_sources: z.strictObject({ id: uuid, claim_id: uuid, source_version_id: uuid, locator: nstr, support_note: nstr }),
  usage_ledger: z.strictObject({
    id: uuid,
    // 0012: 전사 원장은 run_id 가 null 이고 transcription_job_id 가 있다(둘 중 정확히 하나 — checkIntegrity).
    run_id: uuid.nullable(),
    transcription_job_id: uuid.nullable().default(null),
    audio_seconds: int.min(0).nullable().default(null),
    reserved_amount: amount,
    actual_amount: amount.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    tokens_in: int.min(0).nullable(),
    tokens_out: int.min(0).nullable(),
    pricing_snapshot: z.record(z.string(), z.unknown()),
    state: z.enum(['reserved', 'settled', 'released']),
    failed: z.boolean(),
    // 0010 열. 이전 묶음에는 없으므로 초과 없음.
    overage_amount: amount.default('0.000000'),
    over_budget: z.boolean().default(false),
    created_at: ts,
    settled_at: ts.nullable(),
  }),
  assets: z.strictObject({
    id: uuid,
    key: str.refine(isValidStorageKey, '저장 키 형식이 올바르지 않습니다'),
    mime: str,
    bytes: int.min(0),
    checksum: z.string().regex(/^[0-9a-f]{64}$/),
    rights_status: str,
    verification_state: str,
    // 0012 열. 이전 묶음은 DB 기본값과 같은 값.
    verification_scope: str.default('signature_size_checksum'),
    deleted_at: ts.nullable().default(null),
    created_at: ts,
  }),
  // T08(0012)
  transcription_jobs: z.strictObject({
    id: uuid,
    asset_id: uuid,
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
    provider: str,
    model: str,
    progress: int.min(0).max(100),
    transcript_version_id: uuid.nullable(),
    error: nstr,
    attempts: int.min(0),
    keep_original: z.boolean(),
    audio_seconds: int.min(1),
    created_at: ts,
    started_at: ts.nullable(),
    finished_at: ts.nullable(),
  }),
  transcripts: z.strictObject({
    id: uuid,
    job_id: uuid,
    version: int.min(1),
    text: str,
    segments: z.array(z.strictObject({ start_ms: int.min(0), end_ms: int.min(0), text: str })),
    created_by: z.enum(['mock', 'owner']),
    created_at: ts,
  }),
  // T10(0016)
  channel_accounts: z.strictObject({
    id: uuid,
    platform: z.enum(['threads', 'instagram', 'youtube', 'blog']),
    kind: z.enum(['mock', 'live']),
    external_account_id: str.min(1).max(200),
    display_name: str.max(200),
    state: z.enum(['mock_ready', 'connected', 'disconnected', 'revoked']),
    capability_snapshot: z.record(z.string(), z.unknown()),
    created_at: ts,
  }),
  distribution_plans: z.strictObject({
    id: uuid,
    target_summary: str,
    status: z.enum(['draft', 'partially_approved', 'approved', 'executing', 'partial', 'completed', 'canceled', 'failed']),
    revision: int.min(1),
    created_at: ts,
    updated_at: ts,
  }),
  distribution_items: z.strictObject({
    id: uuid,
    plan_id: uuid,
    channel_account_id: uuid,
    variant_id: uuid,
    variant_version_id: uuid,
    content_version_id: uuid,
    brand_profile_id: uuid.nullable(),
    brand_profile_version: int.min(1).nullable(),
    payload_json: z.record(z.string(), z.unknown()),
    payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
    requested_result: z.enum(['mock_publish', 'upload_private', 'public_publish']),
    visibility: z.enum(['private', 'unlisted', 'public']),
    scheduled_at_utc: ts.nullable(),
    schedule_timezone: z.literal('Europe/Moscow'),
    status: z.enum([
      'PLANNED',
      'QUEUED',
      'SENDING',
      'REMOTE_PROCESSING',
      'CONFIRMED',
      'RETRY_WAIT',
      'BLOCKED',
      'RECONCILING',
      'UNKNOWN',
      'CANCEL_REQUESTED',
      'CANCELED',
      'FAILED',
      'PARTIAL',
    ]),
    created_at: ts,
    updated_at: ts,
  }),
  approvals: z.strictObject({
    id: uuid,
    distribution_item_id: uuid,
    payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
    purpose: z.enum(['mock_publish', 'upload_private', 'public_publish']),
    approval_version: int.min(1),
    approved_at: ts,
    revoked_at: ts.nullable(),
    revoke_reason: nstr,
    created_at: ts,
  }),
  jobs: z.strictObject({
    id: uuid,
    kind: z.enum(['publish']),
    item_id: uuid.nullable(),
    payload_ref: str,
    // T11(0017): DONE 은 CONFIRMED 로 이름을 바꿨다(T10 은 DONE 을 쓰지 않았다 — 이전 묶음 호환으로만 받는다).
    state: z.enum(['QUEUED', 'LEASED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'BLOCKED', 'RECONCILING', 'UNKNOWN', 'CANCEL_REQUESTED', 'CANCELED', 'CONFIRMED', 'FAILED', 'DONE']),
    attempt: int.min(0),
    lease_owner: nstr,
    lease_until: ts.nullable(),
    next_run_at: ts,
    idempotency_key: str,
    created_at: ts,
    updated_at: ts,
    // 0017 열. 이전 묶음에는 없으므로 기본값.
    heartbeat_at: ts.nullable().default(null),
    last_error_code: nstr.default(null),
    last_retry_class: z.enum(['transient_no_side_effect', 'transient_unknown_side_effect', 'permanent', 'auth']).nullable().default(null),
    max_attempts: int.min(1).max(20).default(5),
    reconcile_count: int.min(0).default(0),
    cancel_requested_at: ts.nullable().default(null),
    done_at: ts.nullable().default(null),
  }),
  job_events: z.strictObject({
    id: uuid,
    job_id: uuid,
    event_seq: int.min(1),
    state_before: nstr,
    state_after: str,
    at: ts,
    sanitized_details: z.record(z.string(), z.unknown()),
  }),
  execute_commands: z.strictObject({
    id: uuid,
    plan_id: uuid,
    command_key: str,
    created_at: ts,
    result_json: z.record(z.string(), z.unknown()),
  }),
  // T11(0017)
  send_intents: z.strictObject({
    id: uuid,
    job_id: uuid,
    attempt: int.min(1),
    intent_key: str,
    created_at: ts,
    submitted_at: ts.nullable(),
    outcome: z.enum(['pending', 'accepted', 'rejected', 'ambiguous']),
    provider_request_id: nstr,
    remote_external_id: nstr,
    sanitized_details: z.record(z.string(), z.unknown()),
  }),
  publications: z.strictObject({
    id: uuid,
    item_id: uuid,
    job_id: uuid,
    external_id: str,
    permalink: nstr,
    result_kind: z.enum(['UPLOADED_PRIVATE', 'SCHEDULED_REMOTE', 'PUBLISHED', 'MANUAL_REPORTED']),
    remote_visibility: z.enum(['private', 'unlisted', 'public', 'unknown']),
    verification: z.enum(['MOCK', 'VERIFIED', 'UNVERIFIED', 'MANUAL_REPORTED']),
    is_mock: z.boolean(),
    verified_at: ts.nullable(),
    created_at: ts,
  }),
  // T12(0018)
  mock_scenarios: z.strictObject({
    id: uuid,
    distribution_item_id: uuid,
    scenario: str,
    delay_ms: int.min(0),
    created_at: ts,
    updated_at: ts,
  }),
  audit_events: z.strictObject({
    id: uuid,
    action: str,
    entity: str,
    entity_id: uuid.nullable(),
    version_or_hash: nstr,
    at: ts,
    sanitized_details: z.record(z.string(), z.unknown()),
  }),
} as const satisfies Record<ExportedTable, z.ZodType>;

export type BundleRow<T extends ExportedTable> = z.infer<(typeof ROW_SCHEMAS)[T]>;
export type BundleTables = { [T in ExportedTable]: BundleRow<T>[] };

// ---- manifest ----

const fileEntrySchema = z.strictObject({ path: str, bytes: int.min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const assetEntrySchema = z.strictObject({
  id: uuid,
  key: str,
  mime: str,
  bytes: int.min(0),
  checksum: z.string().regex(/^[0-9a-f]{64}$/),
  path: str,
  missing: z.boolean().optional(),
});
const warningSchema = z.strictObject({ code: str, asset_id: uuid.optional(), message: str });

export const manifestSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  format_version: z.literal(BUNDLE_FORMAT_VERSION),
  export_id: uuid,
  app_version: str,
  schema_migrations: z.array(str),
  exported_at: ts,
  timezone_display: z.literal('Europe/Moscow'),
  owner: z.strictObject({ id: uuid, identity_masked: str }),
  tables: z.record(str, z.strictObject({ rows: int.min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  files: z.array(fileEntrySchema),
  assets: z.array(assetEntrySchema),
  totals: z.record(str, int.min(0)),
  warnings: z.array(warningSchema),
  excluded_tables: z.array(str),
});
export type BundleManifest = z.infer<typeof manifestSchema>;
export type BundleWarning = z.infer<typeof warningSchema>;

// ---- 오류 ----

export type BundleErrorCode =
  | 'invalid_bundle'
  | 'unsupported_version'
  | 'schema_incompatible'
  | 'manifest_mismatch'
  | 'invalid_rows'
  | 'integrity';

/** 묶음 검증 실패(400). extra 에는 문제 경로·표 이름만 넣는다(행 내용은 넣지 않음). */
export class BundleError extends AppError {
  constructor(code: BundleErrorCode, message: string, extra?: Record<string, unknown>) {
    super('bad_request', code, message, extra);
  }
}

// ---- Markdown ----

function fence(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 원문을 그대로(한 글자도 바꾸지 않고) 담는 fenced block. 원문 안의 ``` 보다 긴 울타리를 쓴다. */
export function fencedVerbatim(text: string, info = 'text'): string {
  const f = fence(text);
  return `${f}${info}\n${text}\n${f}`;
}

const when = (iso: string) => `${formatMsk(iso)} / ${iso} (UTC)`;
const header = (fields: Record<string, unknown>) =>
  `---\n${Object.entries(fields)
    .map(([k, v]) => `${k}: ${JSON.stringify(v ?? null)}`)
    .join('\n')}\n---\n`;

export function renderContentMarkdown(
  content: BundleRow<'contents'>,
  versions: readonly BundleRow<'content_versions'>[],
  originCaptureIds: readonly string[],
): string {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const current = sorted.find((v) => v.id === content.current_version_id) ?? sorted.at(-1);
  const out: string[] = [
    header({
      id: content.id,
      title: content.title,
      series: content.series,
      audience: content.audience,
      tags: content.tags,
      lifecycle: content.lifecycle,
      revision: content.revision,
      idea_id: content.idea_id,
      created: when(content.created_at),
      updated: when(content.updated_at),
      origin_capture_ids: originCaptureIds,
    }),
    `# ${content.title}\n`,
    current ? `## 현재 본문 (v${current.version})\n\n${current.body}\n` : '## 현재 본문\n\n(버전 없음)\n',
    '## 버전 이력\n',
  ];
  for (const v of sorted) out.push(`- v${v.version} · ${when(v.created_at)} · 작성: ${v.created_by}${v.note ? ` · 메모: ${v.note}` : ''}`);
  out.push('');
  for (const v of sorted) out.push(`### v${v.version}\n\n${v.body}\n`);
  return `${out.join('\n')}\n`;
}

export function renderCaptureMarkdown(
  capture: BundleRow<'captures'>,
  revisions: readonly BundleRow<'capture_revisions'>[],
  source: BundleRow<'sources'> | null,
): string {
  const out: string[] = [
    header({
      id: capture.id,
      title: capture.title,
      input_type: capture.input_type,
      risk: capture.risk,
      command_key: capture.command_key,
      revision: capture.revision,
      received: when(capture.received_at),
      updated: when(capture.updated_at),
      source_url: source?.canonical_url ?? null,
      content_hash: capture.content_hash,
    }),
    `# 소재 ${capture.title ?? capture.id}\n`,
    '## 원문 (수정 불가, 그대로 보존)\n',
    fencedVerbatim(capture.raw_text),
    '',
    `## 메모\n\n${capture.user_note ?? '(없음)'}\n`,
    '## 수정 이력\n',
  ];
  const revs = [...revisions].sort((a, b) => a.revision - b.revision);
  if (revs.length === 0) out.push('(없음)');
  for (const r of revs) {
    out.push(`- 수정 ${r.revision} · ${when(r.changed_at)} · ${r.changed_by} · 위험: ${r.risk} · 제목: ${r.title ?? '(없음)'} · 메모: ${r.user_note ?? '(없음)'}`);
  }
  return `${out.join('\n')}\n`;
}

export function renderIdeaMarkdown(idea: BundleRow<'ideas'>, captureIds: readonly string[]): string {
  const out: string[] = [
    header({
      id: idea.id,
      lifecycle: idea.lifecycle,
      risk: idea.risk,
      tags: idea.tags,
      revision: idea.revision,
      created: when(idea.created_at),
      updated: when(idea.updated_at),
      capture_ids: captureIds,
    }),
    `# 카드\n`,
    `## Idea\n\n${idea.idea}\n`,
    `## Audience\n\n${idea.audience ?? '(없음)'}\n`,
    `## Evidence\n\n${idea.evidence ?? '(없음)'}\n`,
    `## Risk\n\n${idea.risk}\n`,
    `## Next Question\n\n${idea.next_question ?? '(없음)'}\n`,
    `## Next Decision\n\n${idea.next_decision ?? '(없음)'}\n`,
  ];
  return `${out.join('\n')}\n`;
}

export function bundleReadme(m: Pick<BundleManifest, 'export_id' | 'exported_at' | 'format_version' | 'app_version'>): string {
  return `# Content Studio 내보내기 파일

- 형식: ${BUNDLE_FORMAT} v${m.format_version} (앱 ${m.app_version})
- 내보내기 ID: ${m.export_id}
- 만든 시각: ${formatMsk(m.exported_at)} / ${m.exported_at} (UTC)

## 들어 있는 것
- \`manifest.json\`: 모든 파일의 크기·sha256, 표별 행 수·sha256, 파일(asset) 목록, 적용된 DB migration.
- \`data/<표>.json\`: 소재·수정 이력·출처·카드·원고·원고 버전(본문 전체)·원문 관계·파일 메타데이터·감사 기록.
  owner_id 열은 없습니다. 이 파일은 owner 한 명의 데이터이며 복원하면 복원하는 사용자의 것이 됩니다.
- \`markdown/\`: 사람이 읽기 위한 사본(원고 버전 이력, 소재 원문 그대로). 복원에는 쓰지 않습니다.
- \`assets/\`: 첨부 파일 바이트. 파일 이름은 asset ID 입니다.

## 들어 있지 않은 것
- 로그인 세션, 인증 토큰, OAuth·API key 등 인증 비밀은 넣지 않습니다.
- 허용 사용자 식별자는 가린 형태(예: ow***@example.local)로만 들어 있습니다.
- 개인 원문이 들어 있으므로 이 파일을 안전한 곳에 보관하세요. 이 파일 자체는 암호화되어 있지 않습니다.

## 복원 방법
1. Content Studio 의 설정 → 복원에서 이 ZIP 을 올리면 "복원 미리보기"가 나옵니다(아직 아무것도 바뀌지 않음).
   모든 파일의 sha256 을 manifest 와 대조하고, 표별로 새로 추가·동일·충돌 건수를 보여 줍니다.
2. 방식을 고르고 "내용을 확인했습니다"를 체크한 뒤 복원합니다.
   - 빈 환경에만 복원: 소재·카드·원고·파일이 하나도 없을 때만 실행됩니다.
   - 없는 항목만 추가: 없는 ID 만 넣고, 이미 있는 항목은 덮어쓰지 않습니다(다르면 충돌로 표시).
3. CLI: \`pnpm restore:preview <zip>\` → \`pnpm restore:commit <zip> --mode empty_only --confirm\`

복원 결과는 표별 건수와 파일 checksum 확인 결과로만 판단하세요. 이 파일이 있다는 것만으로 복원이 보장되지는 않습니다.
`;
}

// ---- 묶음 만들기 ----

export interface BuildBundleInput {
  exportId: string;
  exportedAt: string;
  appVersion: string;
  migrations: readonly string[];
  owner: { id: string; identityMasked: string };
  tables: BundleTables;
  /** asset id → 바이트. null 이면 저장소에 파일이 없음(missing). */
  assetBytes: ReadonlyMap<string, Uint8Array | null>;
}

export interface BuiltBundle {
  manifest: BundleManifest;
  manifestBytes: Uint8Array;
  /** manifest.json 을 첫 항목으로 한 ZIP 항목 전체 */
  entries: ZipEntry[];
}

export const assetBundlePath = (a: { id: string; mime: string }) => `assets/${a.id}.${extensionForMime(a.mime)}`;

const byId = <T extends { id: string }>(rows: readonly T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

export function buildBundle(input: BuildBundleInput): BuiltBundle {
  const files: ZipEntry[] = [];
  const tables: BundleManifest['tables'] = {};
  const t = input.tables;

  const manifestBase = {
    export_id: input.exportId,
    exported_at: input.exportedAt,
    format_version: BUNDLE_FORMAT_VERSION,
    app_version: input.appVersion,
  } as const;
  files.push({ path: 'README.md', bytes: utf8(bundleReadme(manifestBase)) });

  for (const name of EXPORTED_TABLES) {
    const rows = byId(t[name] as { id: string }[]);
    const bytes = utf8(stableStringify(rows));
    tables[name] = { rows: rows.length, sha256: sha256Hex(bytes) };
    files.push({ path: `data/${name}.json`, bytes });
  }

  // Markdown 사본
  const versionsByContent = groupBy(t.content_versions, (v) => v.content_id);
  const capturesByContent = groupBy(t.content_captures, (c) => c.content_id);
  const capturesByIdea = groupBy(t.idea_captures, (c) => c.idea_id);
  const revisionsByCapture = groupBy(t.capture_revisions, (r) => r.capture_id);
  const sourceById = new Map(t.sources.map((s) => [s.id, s]));
  for (const c of byId(t.contents)) {
    const origin = (capturesByContent.get(c.id) ?? []).map((x) => x.capture_id).sort();
    files.push({ path: `markdown/contents/${c.id}.md`, bytes: utf8(renderContentMarkdown(c, versionsByContent.get(c.id) ?? [], origin)) });
  }
  for (const c of byId(t.captures)) {
    const src = c.source_id ? (sourceById.get(c.source_id) ?? null) : null;
    files.push({ path: `markdown/captures/${c.id}.md`, bytes: utf8(renderCaptureMarkdown(c, revisionsByCapture.get(c.id) ?? [], src)) });
  }
  for (const i of byId(t.ideas)) {
    const ids = (capturesByIdea.get(i.id) ?? []).map((x) => x.capture_id).sort();
    files.push({ path: `markdown/ideas/${i.id}.md`, bytes: utf8(renderIdeaMarkdown(i, ids)) });
  }

  // 파일(asset)
  const assets: BundleManifest['assets'] = [];
  const warnings: BundleWarning[] = [];
  let assetBytesTotal = 0;
  for (const a of byId(t.assets)) {
    const p = assetBundlePath(a);
    const bytes = input.assetBytes.get(a.id) ?? null;
    const entry = { id: a.id, key: a.key, mime: a.mime, bytes: a.bytes, checksum: a.checksum, path: p };
    if (a.deleted_at !== null) {
      // T08: 원음 보존을 끈 전사 뒤 의도적으로 지운 파일 — 메타데이터만(누락 경고와 구분).
      assets.push({ ...entry, missing: true });
      warnings.push({ code: 'asset_deleted', asset_id: a.id, message: '원본을 지운 파일(원음 보존 안 함)이라 메타데이터만 내보냈습니다' });
      continue;
    }
    if (!bytes) {
      assets.push({ ...entry, missing: true });
      warnings.push({ code: 'asset_missing', asset_id: a.id, message: '저장소에 파일이 없어 메타데이터만 내보냈습니다' });
      continue;
    }
    if (sha256Hex(bytes) !== a.checksum) {
      assets.push({ ...entry, missing: true });
      warnings.push({ code: 'asset_checksum_mismatch', asset_id: a.id, message: '저장소 파일의 checksum 이 기록과 달라 파일을 넣지 않았습니다' });
      continue;
    }
    assets.push(entry);
    assetBytesTotal += bytes.byteLength;
    files.push({ path: p, bytes });
  }

  const restoredRows = RESTORED_TABLES.reduce((n, name) => n + t[name].length, 0);
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    ...manifestBase,
    schema_migrations: [...input.migrations],
    timezone_display: 'Europe/Moscow',
    owner: { id: input.owner.id, identity_masked: input.owner.identityMasked },
    tables,
    files: files.map((f) => ({ path: f.path, bytes: f.bytes.byteLength, sha256: sha256Hex(f.bytes) })),
    assets,
    totals: {
      restorable_rows: restoredRows,
      captures: t.captures.length,
      ideas: t.ideas.length,
      contents: t.contents.length,
      content_versions: t.content_versions.length,
      assets: t.assets.length,
      assets_included: assets.filter((a) => !a.missing).length,
      asset_bytes: assetBytesTotal,
      files: files.length + 1,
    },
    warnings,
    excluded_tables: Object.keys(EXCLUDED_TABLES).sort(),
  };
  const manifestBytes = utf8(stableStringify(manifest));
  return { manifest, manifestBytes, entries: [{ path: 'manifest.json', bytes: manifestBytes }, ...files] };
}

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

// ---- 묶음 읽기·검증 ----

export interface ParsedBundle {
  manifest: BundleManifest;
  manifestSha256: string;
  tables: BundleTables;
  /** asset id → 바이트(missing 이 아닌 것만) */
  assetBytes: Map<string, Uint8Array>;
  /** manifest.json 을 뺀 파일 경로(정렬) */
  files: string[];
}

export interface ParseBundleOptions {
  /** 현재 앱의 migration journal 태그(순서대로). 묶음의 목록은 이것의 접두어이거나 같아야 한다. */
  migrations: readonly string[];
}

const MAX_BUNDLE_FILES = 60_000;

/**
 * ZIP 항목 → 검증된 묶음. 하나라도 어긋나면 BundleError(DB·저장소는 건드리지 않는다).
 * 순서: manifest 형식·버전 → migration 호환 → 모든 파일 sha256 대조 → 행 스키마 → owner → 참조 무결성 → asset checksum.
 */
export function parseBundle(entries: readonly ZipEntry[], opts: ParseBundleOptions): ParsedBundle {
  if (entries.length > MAX_BUNDLE_FILES) throw new BundleError('invalid_bundle', '파일이 너무 많은 묶음입니다');
  const byPath = new Map(entries.map((e) => [e.path, e.bytes]));
  const manifestBytes = byPath.get('manifest.json');
  if (!manifestBytes) throw new BundleError('invalid_bundle', 'manifest.json 이 없습니다. Content Studio 내보내기 파일이 아닙니다.');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch {
    throw new BundleError('invalid_bundle', 'manifest.json 을 읽을 수 없습니다');
  }
  const head = raw as { format?: unknown; format_version?: unknown } | null;
  if (!head || typeof head !== 'object' || head.format !== BUNDLE_FORMAT) {
    throw new BundleError('invalid_bundle', 'Content Studio 내보내기 형식이 아닙니다');
  }
  if (head.format_version !== BUNDLE_FORMAT_VERSION) {
    throw new BundleError('unsupported_version', `지원하지 않는 형식 버전입니다(지원: v${BUNDLE_FORMAT_VERSION})`, {
      format_version: typeof head.format_version === 'number' ? head.format_version : null,
    });
  }
  const parsedManifest = manifestSchema.safeParse(raw);
  if (!parsedManifest.success) {
    throw new BundleError('invalid_bundle', 'manifest.json 형식이 올바르지 않습니다', {
      fields: parsedManifest.error.issues.slice(0, 10).map((i) => i.path.map(String).join('.')),
    });
  }
  const manifest = parsedManifest.data;

  // migration 호환: 묶음이 더 새로운(또는 다른) DB 구조에서 만들어졌으면 거부.
  const cur = opts.migrations;
  const bm = manifest.schema_migrations;
  if (bm.length > cur.length || bm.some((tag, i) => cur[i] !== tag)) {
    throw new BundleError('schema_incompatible', '이 앱보다 새롭거나 다른 DB 구조에서 만든 묶음이라 복원할 수 없습니다', {
      bundle_migrations: bm,
      current_migrations: [...cur],
    });
  }

  // 모든 파일 sha256 대조(manifest 자신 제외). 목록에 없는 파일·없는 파일·다른 파일 모두 경로로 보고.
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const mismatched: string[] = [];
  if (listed.size !== manifest.files.length) mismatched.push('manifest.json');
  for (const [p, bytes] of byPath) {
    if (p === 'manifest.json') continue;
    const f = listed.get(p);
    if (!f || f.bytes !== bytes.byteLength || f.sha256 !== sha256Hex(bytes)) mismatched.push(p);
  }
  for (const p of listed.keys()) if (!byPath.has(p)) mismatched.push(p);
  if (mismatched.length) {
    throw new BundleError('manifest_mismatch', '묶음의 파일이 manifest 의 checksum 과 일치하지 않습니다(변조 또는 손상)', {
      paths: [...new Set(mismatched)].sort(),
    });
  }

  // 표: 모든 내보내기 표가 있어야 하고, manifest 의 표 해시·행 수와 같아야 한다.
  const tableNames = Object.keys(manifest.tables);
  const unknownTables = tableNames.filter((n) => !(EXPORTED_TABLES as readonly string[]).includes(n));
  if (unknownTables.length) throw new BundleError('invalid_rows', '알 수 없는 표가 들어 있습니다', { tables: unknownTables });
  const tables = {} as BundleTables;
  for (const name of EXPORTED_TABLES) {
    const p = `data/${name}.json`;
    const bytes = byPath.get(p);
    const meta = manifest.tables[name];
    const since = TABLE_INTRODUCED_IN[name];
    if (!bytes && !meta && since !== undefined && !bm.includes(since)) {
      // 이 표가 생기기 전의 묶음(예: M1 내보내기) — 빈 표로 읽는다.
      (tables as Record<string, unknown[]>)[name] = [];
      continue;
    }
    if (!bytes || !meta) throw new BundleError('invalid_rows', '필요한 표 파일이 없습니다', { tables: [name] });
    if (meta.sha256 !== sha256Hex(bytes)) throw new BundleError('manifest_mismatch', '표 파일이 manifest 와 다릅니다', { paths: [p] });
    let rowsRaw: unknown;
    try {
      rowsRaw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new BundleError('invalid_rows', '표 파일을 읽을 수 없습니다', { tables: [name] });
    }
    if (!Array.isArray(rowsRaw) || rowsRaw.length !== meta.rows) {
      throw new BundleError('invalid_rows', '표 행 수가 manifest 와 다릅니다', { tables: [name] });
    }
    const schema = ROW_SCHEMAS[name];
    const rows: unknown[] = [];
    for (let i = 0; i < rowsRaw.length; i++) {
      const r = schema.safeParse(rowsRaw[i]);
      if (!r.success) {
        throw new BundleError('invalid_rows', '표의 행 형식이 올바르지 않습니다(모르는 열 또는 잘못된 값)', {
          tables: [name],
          row_index: i,
          fields: r.error.issues.slice(0, 5).map((x) => (x.code === 'unrecognized_keys' ? x.keys.join(',') : x.path.map(String).join('.'))),
        });
      }
      rows.push(r.data);
    }
    (tables as Record<string, unknown[]>)[name] = rows;
  }

  // owner: users 는 정확히 한 행, manifest.owner.id 와 같아야 한다.
  if (tables.users.length !== 1 || tables.users[0]!.id !== manifest.owner.id) {
    throw new BundleError('integrity', '묶음의 owner 정보가 올바르지 않습니다', { tables: ['users'] });
  }

  fillAnswerSeq(tables.interview_answers);
  fillProposalStatus(tables);
  checkIntegrity(tables);

  // asset: manifest 목록 = assets 표, 파일 바이트 checksum = assets.checksum
  const assetBytes = new Map<string, Uint8Array>();
  const listedAssets = new Map(manifest.assets.map((a) => [a.id, a]));
  const badAssets: string[] = [];
  if (listedAssets.size !== tables.assets.length) badAssets.push('manifest.assets');
  for (const a of tables.assets) {
    const m = listedAssets.get(a.id);
    if (!m || m.key !== a.key || m.checksum !== a.checksum || m.bytes !== a.bytes || m.mime !== a.mime || m.path !== assetBundlePath(a)) {
      badAssets.push(`asset:${a.id}`);
      continue;
    }
    if (m.missing) {
      if (byPath.has(m.path)) badAssets.push(m.path);
      continue;
    }
    const bytes = byPath.get(m.path);
    if (!bytes || bytes.byteLength !== a.bytes || sha256Hex(bytes) !== a.checksum) {
      badAssets.push(m.path);
      continue;
    }
    assetBytes.set(a.id, bytes);
  }
  if (badAssets.length) {
    throw new BundleError('manifest_mismatch', '파일(asset)의 checksum 이나 목록이 manifest 와 다릅니다', { paths: badAssets.sort() });
  }

  return {
    manifest,
    manifestSha256: sha256Hex(manifestBytes),
    tables,
    assetBytes,
    files: [...byPath.keys()].filter((p) => p !== 'manifest.json').sort(),
  };
}

/** 0006 이전 묶음의 interview_answers.seq 를 원고별 (created_at, id) 순서로 1..n 채운다. 이미 있으면 그대로 둔다. */
/** run id → 그 run 을 ai_run_id 로 가진 사용자 버전(원고·파생본)이 있는가 */
function adoptedRunIds(t: Pick<BundleTables, 'content_versions' | 'variant_versions'>): Set<string> {
  const out = new Set<string>();
  for (const v of t.content_versions) if (v.created_by === 'owner' && v.ai_run_id) out.add(v.ai_run_id);
  for (const v of t.variant_versions) if (v.created_by === 'owner' && v.ai_run_id) out.add(v.ai_run_id);
  return out;
}

/**
 * FIX-T09 round 2(P1): 0011 이전 묶음에는 proposal_status 가 없다 — 채택 이력으로 채운다('adopted' | 'proposed').
 * migration 0011 의 채움과 같은 규칙. 이미 있으면 그대로 두고, 모순은 checkIntegrity 가 거부한다.
 */
export function fillProposalStatus(t: Pick<BundleTables, 'content_versions' | 'variant_versions' | 'generation_runs'>): void {
  const adopted = adoptedRunIds(t);
  for (const r of t.generation_runs) {
    if (r.proposal_status === undefined) (r as { proposal_status?: string }).proposal_status = adopted.has(r.id) ? 'adopted' : 'proposed';
  }
}

export function fillAnswerSeq(rows: Array<{ id: string; content_id: string; created_at: string; seq?: number | undefined }>): void {
  if (rows.every((r) => r.seq !== undefined)) return;
  const sorted = [...rows].sort((a, b) =>
    a.content_id !== b.content_id
      ? a.content_id < b.content_id ? -1 : 1
      : a.created_at !== b.created_at
        ? a.created_at < b.created_at ? -1 : 1
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const next = new Map<string, number>();
  for (const r of sorted) {
    const n = (next.get(r.content_id) ?? 0) + 1;
    next.set(r.content_id, n);
    if (r.seq === undefined) r.seq = n;
  }
}

/** 묶음 안 참조 무결성: PK 중복 없음, 모든 FK 대상이 묶음 안에 있음, 현재 버전은 그 원고의 버전. */
export function checkIntegrity(t: BundleTables): void {
  const problems: string[] = [];
  const ids = {} as Record<ExportedTable, Set<string>>;
  for (const name of EXPORTED_TABLES) {
    const set = new Set<string>();
    for (const r of t[name] as { id: string }[]) {
      if (set.has(r.id)) problems.push(`${name}.id 중복`);
      set.add(r.id);
    }
    ids[name] = set;
  }
  const need = (table: string, col: string, v: string | null, target: ExportedTable) => {
    if (v !== null && !ids[target].has(v)) problems.push(`${table}.${col} → ${target}`);
  };
  for (const r of t.source_versions) need('source_versions', 'source_id', r.source_id, 'sources');
  for (const r of t.captures) need('captures', 'source_id', r.source_id, 'sources');
  for (const r of t.capture_revisions) need('capture_revisions', 'capture_id', r.capture_id, 'captures');
  for (const r of t.idea_captures) {
    need('idea_captures', 'idea_id', r.idea_id, 'ideas');
    need('idea_captures', 'capture_id', r.capture_id, 'captures');
  }
  const versionContent = new Map(t.content_versions.map((v) => [v.id, v.content_id]));
  const runContent = new Map(t.generation_runs.map((r) => [r.id, r.content_id]));
  for (const r of t.contents) {
    need('contents', 'idea_id', r.idea_id, 'ideas');
    if (r.current_version_id !== null && versionContent.get(r.current_version_id) !== r.id) {
      problems.push('contents.current_version_id → content_versions(같은 원고)');
    }
  }
  for (const r of t.content_versions) {
    need('content_versions', 'content_id', r.content_id, 'contents');
    need('content_versions', 'ai_run_id', r.ai_run_id, 'generation_runs');
    // FIX-T06(P0): AI 제안·채택 버전은 같은 원고의 run 만 가리킨다(다른 원고의 run 이면 A03 게이트가 그 claim 을 보지 못함).
    if (r.ai_run_id !== null && runContent.has(r.ai_run_id) && runContent.get(r.ai_run_id) !== r.content_id) {
      problems.push('content_versions.ai_run_id → generation_runs(같은 원고)');
    }
  }
  for (const r of t.interview_answers) need('interview_answers', 'content_id', r.content_id, 'contents');
  for (const r of t.generation_runs) {
    need('generation_runs', 'content_id', r.content_id, 'contents');
    need('generation_runs', 'brand_profile_id', r.brand_profile_id, 'brand_profiles');
    need('generation_runs', 'input_version_id', r.input_version_id, 'content_versions');
    need('generation_runs', 'output_ref', r.output_ref, 'content_versions');
    if (versionContent.get(r.input_version_id) !== r.content_id) problems.push('generation_runs.input_version_id → content_versions(같은 원고)');
    if (r.output_ref !== null && versionContent.get(r.output_ref) !== r.content_id) {
      problems.push('generation_runs.output_ref → content_versions(같은 원고)');
    }
  }
  for (const r of t.claim_confirmations) {
    need('claim_confirmations', 'run_id', r.run_id, 'generation_runs');
    need('claim_confirmations', 'body_version_id', r.body_version_id, 'content_versions');
    if (r.body_version_id !== null && runContent.has(r.run_id) && versionContent.get(r.body_version_id) !== runContent.get(r.run_id)) {
      problems.push('claim_confirmations.body_version_id → content_versions(run 과 같은 원고)');
    }
  }
  // T07: claim 은 같은 원고의 run·버전에, 출처는 묶음 안 source_version 에, 원장은 run 에 붙는다.
  for (const r of t.claims) {
    need('claims', 'content_version_id', r.content_version_id, 'content_versions');
    need('claims', 'run_id', r.run_id, 'generation_runs');
    if (runContent.has(r.run_id) && versionContent.get(r.content_version_id) !== runContent.get(r.run_id)) {
      problems.push('claims.content_version_id → content_versions(run 과 같은 원고)');
    }
  }
  for (const r of t.claim_sources) {
    need('claim_sources', 'claim_id', r.claim_id, 'claims');
    need('claim_sources', 'source_version_id', r.source_version_id, 'source_versions');
  }
  for (const r of t.usage_ledger) {
    need('usage_ledger', 'run_id', r.run_id, 'generation_runs');
    need('usage_ledger', 'transcription_job_id', r.transcription_job_id, 'transcription_jobs');
    if ((r.run_id === null) === (r.transcription_job_id === null)) problems.push('usage_ledger: run_id·transcription_job_id 중 정확히 하나');
  }
  // T08: job 은 묶음 안 파일, 전사 버전은 그 job 의 것(버전 번호 unique), job 의 첫 전사는 같은 job 의 버전, 소재의 전사는 묶음 안.
  const transcriptJob = new Map(t.transcripts.map((x) => [x.id, x.job_id]));
  const jobVersions = new Set<string>();
  for (const r of t.transcription_jobs) need('transcription_jobs', 'asset_id', r.asset_id, 'assets');
  for (const r of t.transcripts) {
    need('transcripts', 'job_id', r.job_id, 'transcription_jobs');
    const k = `${r.job_id}#${r.version}`;
    if (jobVersions.has(k)) problems.push('transcripts: (job_id, version) 중복');
    jobVersions.add(k);
  }
  for (const r of t.transcription_jobs) {
    if (r.transcript_version_id !== null && transcriptJob.get(r.transcript_version_id) !== r.id) {
      problems.push('transcription_jobs.transcript_version_id → transcripts(같은 job)');
    }
    if (r.state === 'succeeded' && r.transcript_version_id === null) problems.push('transcription_jobs: succeeded 인데 전사 없음');
  }
  for (const r of t.captures) need('captures', 'capture_transcript_id', r.capture_transcript_id, 'transcripts');
  // T09: 파생본은 같은 원고, 버전은 그 파생본·그 원고의 원고 버전, 현재 버전은 그 파생본의 버전, 첨부는 묶음 안 파일.
  const variantContent = new Map(t.variants.map((v) => [v.id, v.content_id]));
  const vvVariant = new Map(t.variant_versions.map((v) => [v.id, v.variant_id]));
  for (const r of t.variants) {
    need('variants', 'content_id', r.content_id, 'contents');
    if (r.current_version_id !== null && vvVariant.get(r.current_version_id) !== r.id) {
      problems.push('variants.current_version_id → variant_versions(같은 파생본)');
    }
  }
  for (const r of t.variant_versions) {
    need('variant_versions', 'variant_id', r.variant_id, 'variants');
    need('variant_versions', 'content_version_id', r.content_version_id, 'content_versions');
    need('variant_versions', 'ai_run_id', r.ai_run_id, 'generation_runs');
    const vc = variantContent.get(r.variant_id);
    if (vc !== undefined && versionContent.get(r.content_version_id) !== vc) problems.push('variant_versions.content_version_id → content_versions(같은 원고)');
    if (r.ai_run_id !== null && runContent.has(r.ai_run_id) && runContent.get(r.ai_run_id) !== vc) {
      problems.push('variant_versions.ai_run_id → generation_runs(같은 원고)');
    }
  }
  for (const r of t.generation_runs) {
    need('generation_runs', 'variant_id', r.variant_id, 'variants');
    if (r.variant_id !== null && variantContent.get(r.variant_id) !== undefined && variantContent.get(r.variant_id) !== r.content_id) {
      problems.push('generation_runs.variant_id → variants(같은 원고)');
    }
  }
  for (const r of t.claims) need('claims', 'variant_version_id', r.variant_version_id, 'variant_versions');
  // FIX-T09 round 2(P1): 제안 상태와 채택 이력이 맞아야 한다 — 'adopted' 인데 채택 버전이 없거나, 채택 버전이 있는데 'adopted' 가 아니면 거부.
  {
    const adopted = adoptedRunIds(t);
    for (const r of t.generation_runs) {
      if (r.proposal_status === undefined) continue;
      if (r.proposal_status === 'adopted' && !adopted.has(r.id)) problems.push('generation_runs.proposal_status=adopted → 채택 버전 없음');
      if (r.proposal_status !== 'adopted' && adopted.has(r.id)) problems.push('generation_runs.proposal_status ≠ adopted → 채택 버전 있음');
    }
  }
  // FIX-T09(P1): AI 참조는 같은 파생본·같은 run 이어야 한다(같은 원고의 다른 채널 run 으로 바꿔치기한 묶음 거부).
  const runById = new Map(t.generation_runs.map((r) => [r.id, r]));
  const vvById = new Map(t.variant_versions.map((v) => [v.id, v]));
  for (const v of t.variant_versions) {
    if (v.ai_run_id === null) {
      if (v.created_by.startsWith('ai:')) problems.push('variant_versions.ai_run_id 누락(AI 제안 버전)');
      continue;
    }
    const run = runById.get(v.ai_run_id);
    if (run && (run.mode !== 'variant' || run.variant_id !== v.variant_id)) problems.push('variant_versions.ai_run_id → generation_runs(같은 파생본의 variant run)');
  }
  for (const v of t.content_versions) {
    const run = v.ai_run_id !== null ? runById.get(v.ai_run_id) : undefined;
    if (run && run.mode === 'variant') problems.push('content_versions.ai_run_id → generation_runs(원고 run)');
  }
  for (const c of t.claims) {
    const run = runById.get(c.run_id);
    if (!run) continue;
    if (c.variant_version_id !== null) {
      const vv = vvById.get(c.variant_version_id);
      if (run.mode !== 'variant' || (vv && (vv.ai_run_id !== c.run_id || vv.variant_id !== run.variant_id)) || c.content_version_id !== run.input_version_id) {
        problems.push('claims.variant_version_id → 그 run 의 파생본 제안 버전');
      }
    } else if (run.mode === 'variant' || (run.output_ref !== null && c.content_version_id !== run.output_ref)) {
      problems.push('claims.content_version_id → 그 run 의 원고 제안 버전');
    }
  }
  for (const r of t.variant_assets) {
    need('variant_assets', 'variant_version_id', r.variant_version_id, 'variant_versions');
    need('variant_assets', 'asset_id', r.asset_id, 'assets');
  }
  for (const r of t.content_captures) {
    need('content_captures', 'content_id', r.content_id, 'contents');
    need('content_captures', 'capture_id', r.capture_id, 'captures');
  }
  checkDistributionIntegrity(t, need, problems);
  if (problems.length) {
    throw new BundleError('integrity', '묶음 안의 관계(ID 참조)가 맞지 않습니다', { problems: [...new Set(problems)].slice(0, 20) });
  }
}

/**
 * T10(D17): 배포 표의 묶음 안 관계. 항목 스냅샷은 불변이므로 payload_hash = sha256(canonical(payload_json)) 이고
 * payload 의 ID 들이 항목 열과 같아야 한다(변조된 스냅샷을 복원하지 않는다). 승인 hash·목적은 항목과 같고, 항목마다 활성 승인은 최대 1개.
 */
function checkDistributionIntegrity(
  t: BundleTables,
  need: (table: string, col: string, v: string | null, target: ExportedTable) => void,
  problems: string[],
): void {
  const vvById = new Map(t.variant_versions.map((v) => [v.id, v]));
  const variantById = new Map(t.variants.map((v) => [v.id, v]));
  const accountById = new Map(t.channel_accounts.map((a) => [a.id, a]));
  const brandById = new Map(t.brand_profiles.map((b) => [b.id, b]));
  const itemById = new Map(t.distribution_items.map((i) => [i.id, i]));
  for (const a of t.channel_accounts) {
    if ((a.kind === 'mock') !== a.external_account_id.startsWith(MOCK_EXTERNAL_PREFIX)) problems.push('channel_accounts: mock 계정은 mock: 접두어');
    if (a.state === 'mock_ready' && a.kind !== 'mock') problems.push('channel_accounts: mock_ready 는 mock 계정만');
  }
  for (const i of t.distribution_items) {
    need('distribution_items', 'plan_id', i.plan_id, 'distribution_plans');
    need('distribution_items', 'channel_account_id', i.channel_account_id, 'channel_accounts');
    need('distribution_items', 'variant_id', i.variant_id, 'variants');
    need('distribution_items', 'variant_version_id', i.variant_version_id, 'variant_versions');
    need('distribution_items', 'content_version_id', i.content_version_id, 'content_versions');
    need('distribution_items', 'brand_profile_id', i.brand_profile_id, 'brand_profiles');
    const vv = vvById.get(i.variant_version_id);
    if (vv && (vv.variant_id !== i.variant_id || vv.content_version_id !== i.content_version_id)) {
      problems.push('distribution_items.variant_version_id → 같은 파생본·원고 버전');
    }
    const acc = accountById.get(i.channel_account_id);
    const variant = variantById.get(i.variant_id);
    if (acc && variant && acc.platform !== variant.channel) problems.push('distribution_items: 계정 플랫폼 ≠ 파생본 채널');
    const brand = i.brand_profile_id ? brandById.get(i.brand_profile_id) : undefined;
    if ((i.brand_profile_id === null) !== (i.brand_profile_version === null) || (brand && brand.version !== i.brand_profile_version)) {
      problems.push('distribution_items.brand_profile_version → brand_profiles');
    }
    let hash: string | null;
    try {
      hash = payloadHash(i.payload_json);
    } catch {
      hash = null;
    }
    const p = i.payload_json;
    if (
      hash !== i.payload_hash ||
      p.variant_version_id !== i.variant_version_id ||
      p.content_version_id !== i.content_version_id ||
      p.channel_account_id !== i.channel_account_id ||
      p.visibility !== i.visibility ||
      p.scheduled_at_utc !== (i.scheduled_at_utc === null ? null : new Date(i.scheduled_at_utc).toISOString()) ||
      (acc && p.provider_account_id !== acc.external_account_id)
    ) {
      problems.push('distribution_items.payload_hash → payload_json(불변 스냅샷)');
    }
  }
  const activeByItem = new Map<string, number>();
  for (const a of t.approvals) {
    need('approvals', 'distribution_item_id', a.distribution_item_id, 'distribution_items');
    const item = itemById.get(a.distribution_item_id);
    if (item && (item.payload_hash !== a.payload_hash || item.requested_result !== a.purpose)) problems.push('approvals.payload_hash·purpose → distribution_items');
    if ((a.revoked_at === null) !== (a.revoke_reason === null)) problems.push('approvals: revoked_at·revoke_reason 은 함께');
    if (a.revoked_at === null) activeByItem.set(a.distribution_item_id, (activeByItem.get(a.distribution_item_id) ?? 0) + 1);
  }
  if ([...activeByItem.values()].some((n) => n > 1)) problems.push('approvals: 항목마다 활성 승인은 1개');
  for (const j of t.jobs) need('jobs', 'item_id', j.item_id, 'distribution_items');
  for (const e of t.job_events) need('job_events', 'job_id', e.job_id, 'jobs');
  for (const c of t.execute_commands) need('execute_commands', 'plan_id', c.plan_id, 'distribution_plans');
  for (const i of t.send_intents) {
    need('send_intents', 'job_id', i.job_id, 'jobs');
    if (i.intent_key !== `${i.job_id}:${i.attempt}`) problems.push('send_intents.intent_key = <job_id>:<attempt>');
  }
  for (const p of t.publications) {
    need('publications', 'item_id', p.item_id, 'distribution_items');
    need('publications', 'job_id', p.job_id, 'jobs');
    if (p.is_mock !== (p.verification === 'MOCK')) problems.push('publications: is_mock = (verification = MOCK)');
    if (p.is_mock && (!p.external_id.startsWith(MOCK_EXTERNAL_PREFIX) || (p.permalink !== null && !p.permalink.startsWith('mock://')))) {
      problems.push('publications: 모의 결과는 mock: 외부 ID·mock:// 링크');
    }
  }
  for (const m of t.mock_scenarios) need('mock_scenarios', 'distribution_item_id', m.distribution_item_id, 'distribution_items');
}

/** owner 를 뺀 행 비교용 해시(같은 ID 의 기존 행과 내용이 같은지). */
export function rowHash(row: Record<string, unknown>): string {
  return sha256Hex(stableStringify(row));
}
