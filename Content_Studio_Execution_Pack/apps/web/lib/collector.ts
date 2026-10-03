/**
 * T19(제안 결정 D33) 수집 공용(서버 전용): 요청 본문 읽기·응답 모양·폼 오류 문구·어댑터.
 * 실제 웹 요청은 없다 — COLLECTOR_MODE=mock 일 때 모의 수집기(@cs/providers, 메모리 고정 자료)만.
 */
import type { CollectedItemRow, CollectorRunRow, CollectorSourceRow } from '@cs/db';
import {
  AppError,
  assertCollectorRunnable,
  BadRequestError,
  COLLECTOR_BLOCK_LABEL,
  COLLECTOR_ERROR_LABEL,
  COLLECTOR_SCHEDULES,
  COLLECTOR_SOURCE_KINDS,
  isUuid,
  type AppConfig,
  type CollectorAdapter,
  type CollectorSchedule,
  type CollectorSourceKind,
  type CollectorUrlBlockReason,
} from '@cs/domain';
import { createCollectorAdapter } from '@cs/providers';
import { errorResponse, readBodyCapped, seeOther } from './api';

const MAX_BODY = 64 * 1024;

/** JSON 또는 폼(application/x-www-form-urlencoded) 본문 → 이름별 값 목록. */
export async function readFormOrJson(request: Request): Promise<{ get(name: string): unknown; getAll(name: string): string[] }> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  const bytes = await readBodyCapped(request, MAX_BODY);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestError();
  }
  if (type.startsWith('application/json')) {
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new BadRequestError();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BadRequestError();
    const o = data as Record<string, unknown>;
    return {
      get: (n) => o[n],
      getAll: (n) => {
        const v = o[n];
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new BadRequestError(`${n} 는 문자열 배열이어야 합니다`);
        return v as string[];
      },
    };
  }
  if (type.startsWith('application/x-www-form-urlencoded') || type === '') {
    const form = new URLSearchParams(text);
    return { get: (n) => form.get(n) ?? undefined, getAll: (n) => form.getAll(n) };
  }
  throw new AppError('unsupported_media_type', 'unsupported_media_type', 'application/json 또는 폼 형식으로 보내야 합니다');
}

export function parseSourceInput(f: { get(name: string): unknown }): { kind: CollectorSourceKind; url: string; label: string | null } {
  const kind = f.get('kind');
  const url = f.get('url');
  const label = f.get('label');
  if (typeof kind !== 'string' || !(COLLECTOR_SOURCE_KINDS as readonly string[]).includes(kind)) throw new BadRequestError('종류는 rss·atom·url 중 하나입니다');
  if (typeof url !== 'string' || !url.trim()) throw new BadRequestError('주소를 입력하세요');
  if (label !== undefined && label !== null && typeof label !== 'string') throw new BadRequestError();
  const l = typeof label === 'string' ? Array.from(label.trim()).slice(0, 100).join('') : '';
  return { kind: kind as CollectorSourceKind, url: url.trim(), label: l || null };
}

/** 설정 변경: enabled(true/false·'on'/'off'), schedule(off|daily|weekly). 둘 다 없으면 400. */
export function parseSettingsInput(f: { get(name: string): unknown }): { enabled?: boolean; schedule?: CollectorSchedule } {
  const out: { enabled?: boolean; schedule?: CollectorSchedule } = {};
  const e = f.get('enabled');
  if (e !== undefined && e !== null) {
    if (e === true || e === 'on' || e === 'true') out.enabled = true;
    else if (e === false || e === 'off' || e === 'false') out.enabled = false;
    else throw new BadRequestError('enabled 값이 올바르지 않습니다');
  }
  const s = f.get('schedule');
  if (s !== undefined && s !== null) {
    if (typeof s !== 'string' || !(COLLECTOR_SCHEDULES as readonly string[]).includes(s)) throw new BadRequestError('주기는 off·daily·weekly 중 하나입니다');
    out.schedule = s as CollectorSchedule;
  }
  if (out.enabled === undefined && out.schedule === undefined) throw new BadRequestError('바꿀 설정이 없습니다');
  return out;
}

export function parseItemIds(f: { getAll(name: string): string[] }, json: boolean): string[] {
  const raw = json ? f.getAll('item_ids') : f.getAll('item');
  if (raw.length > 500) throw new BadRequestError();
  return raw.map((x) => {
    const v = x.toLowerCase();
    if (!isUuid(v)) throw new BadRequestError('항목 ID 형식이 올바르지 않습니다');
    return v;
  });
}

/** 실행 가능한 모드인지 확인(disabled → 503 collector_disabled, enabled(live) → 503 collector_live_not_ready) 후 모의 어댑터. */
export function runnableCollector(config: AppConfig): CollectorAdapter {
  assertCollectorRunnable(config);
  const a = createCollectorAdapter(config);
  if (!a) throw new AppError('service_unavailable', 'collector_disabled', '수집기가 없습니다');
  return a;
}

export function sourceView(s: CollectorSourceRow) {
  return {
    id: s.id,
    kind: s.kind,
    url: s.url,
    host: s.host,
    label: s.label,
    enabled: s.enabled,
    schedule: s.schedule,
    last_run_at: s.lastRunAt ? s.lastRunAt.toISOString() : null,
    last_status: s.lastStatus,
    created_at: s.createdAt.toISOString(),
  };
}

export function runView(r: CollectorRunRow) {
  return {
    run_id: r.id,
    source_id: r.sourceId,
    trigger: r.trigger,
    mode: r.mode,
    status: r.status,
    error_code: r.errorCode,
    counts: r.counts,
    result: r.result,
    created_at: r.createdAt.toISOString(),
    accepted_at: r.acceptedAt ? r.acceptedAt.toISOString() : null,
  };
}

export function itemView(i: CollectedItemRow) {
  return {
    id: i.id,
    position: i.position,
    external_key: i.externalKey,
    guid: i.guid,
    link: i.link,
    title: i.title,
    excerpt: i.excerpt,
    published_text: i.publishedText,
    content_checksum: i.contentChecksum,
    raw_sha256: i.rawSha256,
    decision: i.decision,
    reason: i.reason,
    outcome: i.outcome,
    capture_id: i.captureId,
    source_version_id: i.sourceVersionId,
  };
}

/** 실행 오류 코드 → 화면 문구(blocked:<이유> 포함). */
export function runErrorText(code: string | null): string | null {
  if (!code) return null;
  if (code.startsWith('blocked:')) {
    const reason = code.slice('blocked:'.length) as CollectorUrlBlockReason;
    return `주소 정책으로 차단 — ${COLLECTOR_BLOCK_LABEL[reason] ?? reason}. 요청을 보내지 않았습니다.`;
  }
  return COLLECTOR_ERROR_LABEL[code] ?? '가져오지 못했습니다';
}

export const COLLECT_ERROR_TEXT: Record<string, string> = {
  collector_disabled: '수집이 꺼져 있습니다(기본). COLLECTOR_MODE=mock 일 때만 모의 수집을 실행할 수 있습니다.',
  collector_live_not_ready: '실제 수집은 준비되지 않았습니다(실제 수집기 없음·승인 범위 없음). 아무 요청도 보내지 않았습니다.',
  collector_url_blocked: '허용되지 않는 주소입니다(https 만, 내부·IP 주소·기본 아닌 포트 불가). 저장하지 않았습니다.',
  collector_source_exists: '같은 주소의 소스가 이미 있습니다.',
  collector_too_many_sources: '수집 소스는 50개까지입니다.',
  collector_source_disabled: '이 소스는 꺼져 있습니다. 먼저 켜세요.',
  collector_nothing_selected: '저장할 항목을 하나 이상 고르세요. 아무것도 바꾸지 않았습니다.',
  collector_invalid_selection: '새 항목만 소재로 저장할 수 있습니다. 아무것도 바꾸지 않았습니다.',
  collector_run_not_open: '이 실행은 이미 저장했거나 버렸습니다.',
  collector_refetch_failed: '다시 읽기에 실패해 아무것도 저장하지 않았습니다. 다시 수집해 보세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  invalid: '요청을 처리하지 못했습니다. 입력을 확인하세요.',
  server: '서버 오류가 발생했습니다.',
};

export function collectErrorCode(e: unknown): string {
  if (e instanceof AppError) {
    if (e.code in COLLECT_ERROR_TEXT) return e.code;
    if (e.kind === 'csrf') return 'csrf';
    return 'invalid';
  }
  return 'server';
}

/** 폼 실패: 401 → /login, 404 → notFoundHref, 그 외 → back?error=<code>(쿼리 값은 고정 코드만). */
export function collectFormFailure(e: unknown, request: Request, back: string, notFoundHref: string): Response {
  const res = errorResponse(e, request);
  if (res.status === 401) {
    const headers = new Headers();
    const cookie = res.headers.get('set-cookie');
    if (cookie) headers.set('set-cookie', cookie);
    return seeOther('/login', headers);
  }
  if (res.status === 404) return seeOther(notFoundHref);
  const sep = back.includes('?') ? '&' : '?';
  return seeOther(`${back}${sep}error=${collectErrorCode(e)}`);
}
