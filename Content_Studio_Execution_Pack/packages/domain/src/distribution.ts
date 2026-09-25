/**
 * T10 배포 계획·승인 스냅샷·실행 명령(결정 D17) — 순수 함수. DB·네트워크·게시 없음.
 *
 * - 승인 대상은 "canonical publish payload"(docs/03 승인 스냅샷)이다. 서버가 canonical JSON → SHA-256 을 만들고,
 *   승인 요청은 화면에 보인 hash(expected_hashes)가 저장된 hash 와 같을 때만 받는다.
 * - canonical JSON: 키를 재귀적으로 정렬, 공백 없음, 문자열 NFC 정규화, 숫자는 JSON 그대로, null 유지, undefined 는 뺀다. 배열 순서는 의미가 있다.
 * - 예약은 Europe/Moscow 벽시계 시각으로 받고 UTC 로 저장한다(A13). 지금 + 1분 이하(과거 포함)는 거부한다.
 * - 클라이언트·LLM 이 보낸 approved/approval 같은 플래그는 스키마가 버린다(모르는 키 strip) — 승인은 approveItems 만 만든다.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CHANNELS, renderVariantText, type Channel } from './channel';
import { AppError } from './errors';
import { planStatusFrom } from './jobs';
import { isUuid } from './media';

// ---- 상태·열거 ----

export const ACCOUNT_KINDS = ['mock', 'live'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const ACCOUNT_STATES = ['mock_ready', 'connected', 'disconnected', 'revoked'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

export const PLAN_STATUSES = ['draft', 'partially_approved', 'approved', 'executing', 'partial', 'attention', 'completed', 'canceled', 'failed'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const ITEM_STATUSES = [
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
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** 작업이 진행 중인(외부 전송이 일어날 수 있는) 항목 상태 — 복원 때 작업(jobs)은 들여오지 않으므로 restoredItemStatus 로 바꾸고 restored_needs_review 를 켠다. */
export const IN_FLIGHT_ITEM_STATUSES: readonly ItemStatus[] = ['QUEUED', 'SENDING', 'REMOTE_PROCESSING', 'RETRY_WAIT', 'RECONCILING', 'UNKNOWN', 'CANCEL_REQUESTED'];
/**
 * FIX-T10(P0, Codex review-T10 restore.ts:267): 복원 때 원격 결과를 정할 수 없는 항목 상태 — 전송이 시작됐거나(SENDING·REMOTE_PROCESSING·
 * RECONCILING·CANCEL_REQUESTED) 이미 결과 불명(UNKNOWN). 이들은 UNKNOWN 으로 들여온다("reconcile or remain UNKNOWN" — BLOCKED·FAILED 로 바꾸지 않는다).
 * 아직 보내지 않은 대기(QUEUED·RETRY_WAIT)만 BLOCKED 로 들여온다(보내지 않았음이 확실한 보류).
 */
export const RESTORE_AS_UNKNOWN_ITEM_STATUSES: readonly ItemStatus[] = ['SENDING', 'REMOTE_PROCESSING', 'RECONCILING', 'UNKNOWN', 'CANCEL_REQUESTED'];

/** 복원할 항목 상태: 진행 중이 아니면 null(그대로), 결과를 정할 수 없으면 UNKNOWN, 보내기 전 대기면 BLOCKED. */
export function restoredItemStatus(status: string): 'UNKNOWN' | 'BLOCKED' | null {
  if (!(IN_FLIGHT_ITEM_STATUSES as readonly string[]).includes(status)) return null;
  return (RESTORE_AS_UNKNOWN_ITEM_STATUSES as readonly string[]).includes(status) ? 'UNKNOWN' : 'BLOCKED';
}

// 작업 상태(JOB_STATES)·전이 표는 jobs.ts(T11, D18).

export const REQUESTED_RESULTS = ['mock_publish', 'upload_private', 'public_publish'] as const;
export type RequestedResult = (typeof REQUESTED_RESULTS)[number];
export const VISIBILITIES = ['private', 'unlisted', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const SCHEDULE_TIMEZONE = 'Europe/Moscow' as const;
export const SNAPSHOT_VERSION = 1 as const;
export const MAX_PLAN_ITEMS = 20;
export const MOCK_EXTERNAL_PREFIX = 'mock:';
export const MOCK_EXECUTE_NOTICE = 'MOCK — 실제 게시 아님. 작업 처리기(모의 어댑터)가 처리하며 외부로 아무것도 보내지 않습니다.';

/**
 * T10 이 직접 일으키는 항목 상태 전이(세부 전이는 T11/T12 가 이 표에 더한다).
 * PLANNED → QUEUED(실행), QUEUED → PLANNED(시작 전 승인 철회·무효 — 작업은 BLOCKED), PLANNED → BLOCKED(예약).
 */
export const ITEM_TRANSITIONS_T10: Readonly<Partial<Record<ItemStatus, readonly ItemStatus[]>>> = {
  PLANNED: ['QUEUED', 'BLOCKED'],
  QUEUED: ['PLANNED'],
};

export function canItemTransition(from: string, to: ItemStatus): boolean {
  return (ITEM_TRANSITIONS_T10[from as ItemStatus] ?? []).includes(to);
}

// ---- 파생본 상태(D17: approved 추가) ----

export const VARIANT_LIFECYCLES = ['draft', 'review', 'approved'] as const;
export type VariantLifecycle = (typeof VARIANT_LIFECYCLES)[number];
/** 누가 바꾸는가: 사용자(draft↔review) / 승인(review→approved, 서버 approveItems 만) / 철회(approved→review) / 새 버전·원고 변경(→draft). */
export type VariantLifecycleCause = 'user' | 'approval' | 'revoke' | 'new_version';

const VARIANT_TRANSITIONS: Record<VariantLifecycleCause, ReadonlyArray<[VariantLifecycle, VariantLifecycle]>> = {
  user: [
    ['draft', 'review'],
    ['review', 'draft'],
  ],
  approval: [['review', 'approved']],
  revoke: [['approved', 'review']],
  new_version: [
    ['draft', 'draft'],
    ['review', 'draft'],
    ['approved', 'draft'],
  ],
};

export function canVariantTransition(from: string, to: VariantLifecycle, cause: VariantLifecycleCause): boolean {
  if (from === to && cause !== 'approval') return true;
  return VARIANT_TRANSITIONS[cause].some(([a, b]) => a === from && b === to);
}

export class VariantApprovedError extends AppError {
  constructor() {
    super('conflict', 'variant_approved', '승인된 채널 초안입니다. 배포함에서 승인을 철회한 뒤 상태를 바꾸세요(수정·첨부 변경은 승인을 무효로 합니다).');
  }
}

// ---- canonical JSON·hash ----

/** FIX-T10(P2): NFC 정규화 뒤 같아지는 키가 둘 이상이면 한 필드가 조용히 사라지므로 hash 계산을 거부한다. */
export class CanonicalKeyCollisionError extends AppError {
  constructor(key: string) {
    super('bad_request', 'canonical_key_collision', 'NFC 정규화 뒤 같은 키가 둘 이상 있어 canonical JSON 을 만들 수 없습니다', { key });
  }
}

function canon(v: unknown): unknown {
  if (typeof v === 'string') return v.normalize('NFC');
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canon(x)));
  if (v !== null && typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    const o = v as Record<string, unknown>;
    // FIX-T10(P2): 키를 먼저 NFC 로 정규화하고, 정규화 뒤 중복이면 거부, 그 다음 정규화한 키로 정렬한다.
    // 결과는 프로토타입 없는 객체 — '__proto__' 도 일반 키로 남는다(대입이 프로토타입을 바꾸지 않음).
    const entries: Array<[string, unknown]> = [];
    const seen = new Set<string>();
    for (const k of Object.keys(o)) {
      if (o[k] === undefined) continue;
      const nk = k.normalize('NFC');
      if (seen.has(nk)) throw new CanonicalKeyCollisionError(nk);
      seen.add(nk);
      entries.push([nk, o[k]]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, x] of entries) out[k] = canon(x);
    return out;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('canonical JSON 에 넣을 수 없는 숫자입니다');
  if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') throw new TypeError('canonical JSON 에 넣을 수 없는 값입니다');
  return v;
}

/** 키 정렬(재귀) · 공백 없음 · 문자열 NFC · null 유지 · undefined 제외. 같은 값은 항상 같은 문자열. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canon(value));
}

/** SHA-256 hex(canonical JSON 의 UTF-8 바이트). */
export function payloadHash(canonical: unknown): string {
  return createHash('sha256').update(canonicalJson(canonical), 'utf8').digest('hex');
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// ---- canonical publish payload ----

export interface SnapshotAsset {
  id: string;
  checksum: string;
  role: string;
  /** variant_assets.position */
  position: number;
  mime: string;
}

export interface CanonicalPayloadInput {
  contentVersionId: string;
  variantVersionId: string;
  brandProfileVersionId: string | null;
  channelAccountId: string;
  providerAccountId: string;
  channel: Channel;
  body: string;
  metadata: Record<string, unknown>;
  assets: readonly SnapshotAsset[];
  visibility: Visibility;
  scheduledAtUtc: Date | null;
  timezone: string;
}

export interface CanonicalPayload {
  content_version_id: string;
  variant_version_id: string;
  brand_profile_version_id: string | null;
  channel_account_id: string;
  provider_account_id: string;
  channel: Channel;
  text: Record<string, unknown> & { rendered: string };
  assets: Array<{ id: string; checksum: string; role: string; order: number; mime: string }>;
  visibility: Visibility;
  scheduled_at_utc: string | null;
  timezone: string;
  provider_metadata: Record<string, unknown>;
  snapshot_version: typeof SNAPSHOT_VERSION;
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const ss = (v: unknown) => (Array.isArray(v) ? v.map(s) : []);

/** 채널에서 실제로 나가는 글(채널별 필드 + renderVariantText 결과). */
export function channelOutgoingText(channel: Channel, body: string, metadata: Record<string, unknown>): CanonicalPayload['text'] {
  const rendered = renderVariantText(channel, body, metadata);
  switch (channel) {
    case 'threads': {
      const parts = ss(metadata.thread_parts);
      return { rendered, posts: parts.length ? parts : [s(metadata.text) || body] };
    }
    case 'instagram':
      return {
        rendered,
        caption: s(metadata.caption),
        cards: Array.isArray(metadata.cards) ? metadata.cards.map((c) => ({ index: Number((c as { index?: unknown }).index) || 0, text: s((c as { text?: unknown }).text) })) : [],
      };
    case 'youtube':
      return { rendered, title: s(metadata.title), description: s(metadata.description), tags: ss(metadata.tags) };
    case 'blog':
      return { rendered, title: s(metadata.title), markdown: s(metadata.markdown) };
  }
}

/** docs/03 "승인 스냅샷"의 필드만 담은 payload. 첨부는 position 순. provider_metadata 는 M3 에서 빈 객체. */
export function buildCanonicalPayload(input: CanonicalPayloadInput): CanonicalPayload {
  const assets = [...input.assets]
    .sort((a, b) => a.position - b.position)
    .map((a) => ({ id: a.id, checksum: a.checksum, role: a.role, order: a.position, mime: a.mime }));
  return {
    content_version_id: input.contentVersionId,
    variant_version_id: input.variantVersionId,
    brand_profile_version_id: input.brandProfileVersionId,
    channel_account_id: input.channelAccountId,
    provider_account_id: input.providerAccountId,
    channel: input.channel,
    text: channelOutgoingText(input.channel, input.body, input.metadata),
    assets,
    visibility: input.visibility,
    scheduled_at_utc: input.scheduledAtUtc ? input.scheduledAtUtc.toISOString() : null,
    timezone: input.timezone,
    provider_metadata: {},
    snapshot_version: SNAPSHOT_VERSION,
  };
}

/**
 * FIX-T10(P1, Codex review-T10 bundle.ts:424): 저장·복원된 payload_json 의 구조(buildCanonicalPayload 출력 모양 그대로)를 엄격하게 검사한다.
 * hash 는 맞지만 text·assets 가 빠진(또는 모르는 키가 더해진) 스냅샷은 상세 화면·어댑터를 깨뜨리고 항목이 불변이라 고칠 수도 없으므로
 * 묶음 복원에서 승인 유무와 관계없이 모든 항목을 이 스키마로 검사한다. 채널마다 text 필드가 다르다(channelOutgoingText).
 */
const payloadUuid = z.string().refine((v) => isUuid(v), 'uuid');
const payloadAssetSchema = z.strictObject({
  id: payloadUuid,
  checksum: z.string().regex(SHA256_HEX_RE),
  role: z.enum(['image', 'video', 'thumbnail', 'attachment']),
  order: z.int().min(1),
  mime: z.string().min(1),
});
const payloadTextSchemas = {
  threads: z.strictObject({ rendered: z.string(), posts: z.array(z.string()) }),
  instagram: z.strictObject({ rendered: z.string(), caption: z.string(), cards: z.array(z.strictObject({ index: z.int().min(0), text: z.string() })) }),
  youtube: z.strictObject({ rendered: z.string(), title: z.string(), description: z.string(), tags: z.array(z.string()) }),
  blog: z.strictObject({ rendered: z.string(), title: z.string(), markdown: z.string() }),
} as const satisfies Record<Channel, z.ZodType>;
const payloadBase = {
  content_version_id: payloadUuid,
  variant_version_id: payloadUuid,
  brand_profile_version_id: payloadUuid.nullable(),
  channel_account_id: payloadUuid,
  provider_account_id: z.string().min(1),
  assets: z.array(payloadAssetSchema),
  visibility: z.enum(VISIBILITIES),
  scheduled_at_utc: z.iso.datetime().nullable(),
  timezone: z.literal(SCHEDULE_TIMEZONE),
  provider_metadata: z.strictObject({}),
  snapshot_version: z.literal(SNAPSHOT_VERSION),
};
export const canonicalPayloadSchema = z
  .discriminatedUnion('channel', [
    z.strictObject({ ...payloadBase, channel: z.literal('threads'), text: payloadTextSchemas.threads }),
    z.strictObject({ ...payloadBase, channel: z.literal('instagram'), text: payloadTextSchemas.instagram }),
    z.strictObject({ ...payloadBase, channel: z.literal('youtube'), text: payloadTextSchemas.youtube }),
    z.strictObject({ ...payloadBase, channel: z.literal('blog'), text: payloadTextSchemas.blog }),
  ])
  .superRefine((p, ctx) => {
    // 첨부는 position 순(order 오름차순, 중복 없음) — buildCanonicalPayload 가 만드는 순서
    for (let i = 1; i < p.assets.length; i++) {
      if (p.assets[i]!.order <= p.assets[i - 1]!.order) ctx.addIssue({ code: 'custom', path: ['assets', i, 'order'], message: 'assets 는 order 오름차순·중복 없음' });
    }
  });

/** payload_json 이 canonical payload 모양인지(아니면 문제 경로 목록, 맞으면 빈 배열). */
export function canonicalPayloadProblems(payload: unknown): string[] {
  const r = canonicalPayloadSchema.safeParse(payload);
  if (r.success) return [];
  return [...new Set(r.error.issues.map((i) => i.path.map(String).join('.') || '(root)'))].slice(0, 5);
}

// ---- 예약(MSK → UTC, A13) ----

export class ScheduleInPastError extends AppError {
  constructor() {
    super('bad_request', 'schedule_in_past', '예약 시각이 지났거나 너무 가깝습니다(지금부터 1분 뒤 이후만). 과거 예약은 즉시 공개와 같아 거부합니다.');
  }
}

export class InvalidScheduleError extends AppError {
  constructor() {
    super('bad_request', 'invalid_schedule', '예약 날짜(YYYY-MM-DD)·시각(HH:mm, 모스크바 시각)을 확인하세요');
  }
}

const tzFormatters = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(tz: string): Intl.DateTimeFormat {
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    tzFormatters.set(tz, f);
  }
  return f;
}

/** 그 순간(UTC ms)의 tz 벽시계 시각을 UTC 로 읽은 값 − 실제 UTC = tz 오프셋(ms). */
function tzOffsetMs(utcMs: number, tz: string): number {
  const p = Object.fromEntries(tzFormatter(tz).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** tz 벽시계 시각(y-m-d h:mi) → UTC Date. 없는 시각(DST 틈)·잘못된 날짜는 null. */
export function zonedWallTimeToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz);
  // 되돌려 읽어 같은 벽시계인지 확인(2월 30일·DST 틈 거부)
  const p = Object.fromEntries(tzFormatter(tz).formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
  if (Number(p.year) !== y || Number(p.month) !== mo || Number(p.day) !== d || Number(p.hour) !== h || Number(p.minute) !== mi) return null;
  return new Date(utc);
}

export const SCHEDULE_MIN_LEAD_MS = 60_000;

/**
 * `YYYY-MM-DD` + `HH:mm`(Europe/Moscow 벽시계) → UTC. 형식 오류 → 400 invalid_schedule, now + 1분 이하 → 400 schedule_in_past.
 */
export function scheduleFromMsk(dateStr: string, timeStr: string, now: Date = new Date()): Date {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  const tm = /^(\d{2}):(\d{2})$/.exec(timeStr.trim());
  if (!dm || !tm) throw new InvalidScheduleError();
  const [y, mo, d, h, mi] = [Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || y < 2000 || y > 2999) throw new InvalidScheduleError();
  const utc = zonedWallTimeToUtc(y, mo, d, h, mi, SCHEDULE_TIMEZONE);
  if (!utc) throw new InvalidScheduleError();
  if (utc.getTime() <= now.getTime() + SCHEDULE_MIN_LEAD_MS) throw new ScheduleInPastError();
  return utc;
}

// ---- 입력 계약 ----

const uuidStr = z
  .string()
  .transform((v) => v.toLowerCase())
  .refine(isUuid, 'ID 형식이 올바르지 않습니다');

/**
 * POST /api/distribution-plans. 모르는 키(approved·approval·approved_by_ai 등)는 버린다(strip) — 어떤 플래그도 승인을 만들지 않는다.
 */
export const planCreateSchema = z.object({
  items: z
    .array(
      z.object({
        variant_id: uuidStr,
        channel_account_id: uuidStr,
        requested_result: z.enum(REQUESTED_RESULTS).optional(),
        visibility: z.enum(VISIBILITIES).optional(),
        schedule: z.object({ date: z.string().max(20), time: z.string().max(10) }).nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_PLAN_ITEMS),
  target_summary: z.string().max(200).optional(),
});
export type PlanCreateInput = z.infer<typeof planCreateSchema>;

/** POST /api/distribution-plans/{id}/approve. confirm 은 true 만, 고른 항목마다 예상 hash 필수. 모르는 키는 버린다. */
export const approveSchema = z
  .object({
    item_ids: z.array(uuidStr).min(1).max(MAX_PLAN_ITEMS),
    expected_hashes: z.record(z.string(), z.string()),
    confirm: z.literal(true, { error: '내용을 확인했다는 표시(confirm)가 필요합니다' }),
    purpose: z.enum(REQUESTED_RESULTS),
  })
  .superRefine((v, ctx) => {
    if (new Set(v.item_ids).size !== v.item_ids.length) ctx.addIssue({ code: 'custom', message: '같은 항목을 두 번 고를 수 없습니다', path: ['item_ids'] });
    const hashes = new Map(Object.entries(v.expected_hashes).map(([k, h]) => [k.toLowerCase(), h]));
    for (const id of v.item_ids) {
      const h = hashes.get(id);
      if (h === undefined || !SHA256_HEX_RE.test(h)) {
        ctx.addIssue({ code: 'custom', message: '고른 항목마다 화면에 보인 payload hash(expected_hashes)가 필요합니다', path: ['expected_hashes'] });
        break;
      }
    }
  })
  .transform((v) => ({
    ...v,
    expected_hashes: Object.fromEntries(Object.entries(v.expected_hashes).map(([k, h]) => [k.toLowerCase(), h])) as Record<string, string>,
  }));
export type ApproveInput = z.infer<typeof approveSchema>;

export const COMMAND_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const executeSchema = z.object({
  command_key: z.string().regex(COMMAND_KEY_RE, 'command_key 는 영문·숫자·_·- 8~64자입니다'),
  item_ids: z.array(uuidStr).min(1).max(MAX_PLAN_ITEMS).optional(),
});
export type ExecuteInput = z.infer<typeof executeSchema>;

export const revokeSchema = z.object({ reason: z.string().max(200).optional() });

// ---- 계획 상태(파생) ----

/**
 * 항목 상태·활성 승인에서 계획 상태를 계산한다(저장값은 이것으로만 갱신). 규칙은 jobs.ts planStatusFrom 하나(T11 D18) —
 * T10 의 계획 재계산과 T11 작업 처리기가 같은 함수를 쓴다.
 */
export function computePlanStatus(items: ReadonlyArray<{ status: string; activeApproval: boolean }>): PlanStatus {
  return planStatusFrom(items);
}

// ---- 오류 ----

export class HashMismatchError extends AppError {
  constructor(itemIds: string[]) {
    super('conflict', 'hash_mismatch', '화면에서 본 내용과 서버의 배포 내용(payload hash)이 다릅니다. 새로 고친 뒤 다시 확인하세요.', { item_ids: itemIds });
  }
}

export class SnapshotStaleError extends AppError {
  constructor(items: Array<{ item_id: string; reasons: string[] }>) {
    super('conflict', 'snapshot_stale', '승인 이후(또는 계획 이후) 본문·미디어·계정·원고·일정이 바뀌었습니다. 새 배포 계획을 만들어 다시 승인하세요.', { items });
  }
}

export class ApprovalRequiredForExecuteError extends AppError {
  constructor(itemIds: string[]) {
    super('forbidden', 'approval_required', '서버에 저장된 유효한 승인이 없는 항목이 있어 실행하지 않았습니다(아무것도 대기열에 넣지 않음).', { item_ids: itemIds });
  }
}

export class AlreadyExecutedError extends AppError {
  constructor() {
    super('conflict', 'already_executed', '이미 실행한 항목입니다(다른 실행 요청이 먼저 처리됨). 중복 작업을 만들지 않았습니다.');
  }
}

export class ChannelMismatchError extends AppError {
  constructor() {
    super('bad_request', 'channel_mismatch', '채널 초안의 채널과 계정의 플랫폼이 다릅니다');
  }
}

export class AccountNotReadyError extends AppError {
  constructor() {
    super('conflict', 'account_not_ready', '배포 계정이 준비된 상태가 아닙니다');
  }
}

export const isChannel = (v: string): v is Channel => (CHANNELS as readonly string[]).includes(v);
