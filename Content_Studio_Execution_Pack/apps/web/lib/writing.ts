/**
 * T06 작성 지원 — 폼 → API 입력 변환, 응답 모양, 폼 오류 문구(서버 전용). JSON 필드는 snake_case(docs/04).
 */
import { usageLedgerView, type AssistResult } from '@cs/db';
import { aiRunFailureView, AppError, blocksToList, BRAND_TONE_LABEL, BRAND_TONES, BrandVersionConflictError, diffLines, diffStats, isUuid, linesToList, MAX_BRAND_TEXT } from '@cs/domain';
import { MOCK_WARNING } from '@cs/providers';
import { errorResponse, seeOther } from './api';
import { renderBrandConflictHtml } from './contents';

export const MAX_WRITING_REQUEST = 64 * 1024;

/** /brand 폼 → brandProfileCreateSchema 입력. 목록 칸은 한 줄에 하나, 예문은 빈 줄로 구분. */
export function formToBrandCreate(f: Record<string, string>) {
  return {
    base_version: Number(f.base_version),
    pen_name: f.pen_name ?? '',
    audience: f.audience ?? '',
    pillars: linesToList(f.pillars),
    style_rules: linesToList(f.style_rules),
    tone: f.tone === 'casual' ? 'casual' : 'formal',
    avoid_phrases: linesToList(f.avoid_phrases),
    cta_rules: linesToList(f.cta_rules),
    sample_texts: blocksToList(f.sample_texts),
  };
}

/**
 * FIX3-FULLREV2(G31): /brand 폼 저장 충돌 → 409 비교 화면. 현재 서버 값은 e.extra.current(응답 시점에 다시 읽은 최신 버전),
 * 내 입력은 **제출한 폼 원문 그대로**(줄·빈 줄 포함 — 재저장 폼에 그대로 채운다). 재저장 폼의 base_version 은 현재 버전.
 */
export function brandConflictResponse(e: BrandVersionConflictError, form: Record<string, string>): Response {
  const cur = (e.extra?.current ?? null) as {
    version: number;
    pen_name: string;
    audience: string;
    pillars: string[];
    style_rules: string[];
    tone: string;
    avoid_phrases: string[];
    cta_rules: string[];
    sample_texts: string[];
  } | null;
  const lines = (v: string[] | undefined) => (v ?? []).join('\n');
  const tone = (v: string | undefined) => BRAND_TONE_LABEL[v as keyof typeof BRAND_TONE_LABEL] ?? v ?? '';
  const yoursTone = form.tone === 'casual' ? 'casual' : 'formal';
  return renderBrandConflictHtml({
    baseVersion: Number.isInteger(Number(form.base_version)) ? Number(form.base_version) : 0,
    currentVersion: cur?.version ?? 0,
    fields: [
      { name: 'pen_name', label: '필명', current: cur?.pen_name ?? '', yours: form.pen_name ?? '', input: 'text', maxLength: 100 },
      { name: 'audience', label: '독자', current: cur?.audience ?? '', yours: form.audience ?? '', input: 'text', maxLength: MAX_BRAND_TEXT },
      { name: 'pillars', label: '연재 축(한 줄에 하나, 최대 5개)', current: lines(cur?.pillars), yours: form.pillars ?? '', input: 'textarea', rows: 3 },
      {
        name: 'tone',
        label: '말투',
        current: cur ? tone(cur.tone) : '',
        yours: yoursTone,
        yoursText: BRAND_TONE_LABEL[yoursTone],
        input: { options: BRAND_TONES.map((t) => [t, BRAND_TONE_LABEL[t]] as [string, string]) },
      },
      { name: 'style_rules', label: '문체 원칙(한 줄에 하나)', current: lines(cur?.style_rules), yours: form.style_rules ?? '', input: 'textarea', rows: 3 },
      { name: 'avoid_phrases', label: '피하고 싶은 표현(한 줄에 하나)', current: lines(cur?.avoid_phrases), yours: form.avoid_phrases ?? '', input: 'textarea', rows: 3 },
      { name: 'cta_rules', label: 'CTA 원칙(한 줄에 하나)', current: lines(cur?.cta_rules), yours: form.cta_rules ?? '', input: 'textarea', rows: 3 },
      {
        name: 'sample_texts',
        label: '직접 쓴 예문(빈 줄로 구분, 최대 5개)',
        current: (cur?.sample_texts ?? []).join('\n\n'),
        yours: form.sample_texts ?? '',
        input: 'textarea',
        rows: 8,
      },
    ],
  });
}

/** 작성실 인터뷰 폼 → interviewAnswersSchema 입력. */
export function formToAnswers(f: Record<string, string>) {
  const answers: Record<string, string> = {};
  for (const k of ['situation', 'judgment', 'takeaway']) if (f[`answer_${k}`] !== undefined) answers[k] = f[`answer_${k}`]!;
  return { answers };
}

/** 쉼표로 구분한 목록(폼 hidden 칸). */
export const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function formToAssist(f: Record<string, string>) {
  return {
    mode: f.mode ?? '',
    base_version: Number(f.base_version),
    brand_profile_version: Number(f.brand_profile_version),
    answer_ids: csv(f.answer_ids),
    // FIX-T07: 체크박스(sv_<id>=on)가 있으면 그것을, 없으면 쉼표 목록 칸을 쓴다.
    source_version_ids: Object.keys(f).some((k) => k.startsWith('sv_'))
      ? Object.keys(f)
          .filter((k) => k.startsWith('sv_'))
          .map((k) => k.slice(3))
      : csv(f.source_version_ids),
  };
}

export function formToClaimConfirm(f: Record<string, string>) {
  return {
    run_id: f.run_id ?? '',
    claim_indexes: csv(f.claim_indexes).map(Number),
    // FIX-T06 round 2: 제출된 값을 그대로 스키마에 넘긴다(잘못된 값은 400). 칸이 없을 때만 스키마 기본값(confirmed).
    ...(f.resolution !== undefined ? { resolution: f.resolution } : {}),
  };
}

export function assistResponse(r: AssistResult, runView: Record<string, unknown>) {
  const lines = diffLines(r.current.body, r.proposal.body);
  return {
    run: runView,
    proposal_version: { id: r.proposal.id, version: r.proposal.version, body: r.proposal.body, created_by: r.proposal.createdBy },
    current_version: { id: r.current.id, version: r.current.version },
    diff: { stats: diffStats(lines), lines },
    claims: r.claims.map((c) => ({
      text: c.text,
      kind: c.kind,
      source_refs: c.source_refs,
      needs_user_confirmation: c.needs_user_confirmation,
      dropped_source_refs: c.dropped_source_refs,
      evidence_grade: c.evidence_grade,
      needs_check: c.needs_check,
    })),
    usage: usageLedgerView(r.ledger),
    followup_questions: r.output.followup_questions,
    warnings: r.output.warnings,
    mock_warning: r.run.provider === 'mock' ? MOCK_WARNING : null,
  };
}

/** 작성 지원 폼 오류 코드 → 고정 문구(쿼리 값을 그대로 출력하지 않는다). */
export const WRITING_ERROR_TEXT: Record<string, string> = {
  stale: '그 사이 본문이 바뀌었습니다. 최신 본문을 기준으로 다시 시도하세요. (AI 제안은 만들지 않았습니다)',
  llm_failed: 'AI 제안을 만들지 못했습니다. 본문은 바뀌지 않았습니다.',
  llm_blocked: '실제 AI 호출은 허용되지 않은 상태입니다(LLM_MODE). 아무것도 보내지 않았습니다.',
  brand_missing: '브랜드 프로필이 없습니다. 먼저 Brand Profile 을 저장하세요.',
  not_adoptable: '이 제안은 채택할 수 없습니다.',
  budget_exceeded: '이번 달 AI 예산 상한(또는 1회 상한)을 넘게 되어 AI 를 호출하지 않았습니다. 설정에서 사용량을 확인하세요.',
  live_run_limit: '승인된 실제 AI 호출 횟수(LLM_LIVE_MAX_RUNS)를 모두 써서 AI 를 호출하지 않았습니다.',
  live_usage_unresolved: '공급자가 보고한 사용량을 기록하지 못한 실제 AI 호출이 있어 새 실제 호출을 막았습니다(운영자 확인 필요).',
  // FIX3-FULLREV2(G22): 통화 불일치(409)는 동시 저장 충돌(conflict)과 다른 원인 — 그 달(MSK) 내내 AI 호출이 막히므로 설정 화면으로 안내한다.
  budget_currency_mismatch:
    '이번 달 비용 원장에 설정 통화(LLM_BUDGET_CURRENCY)와 다른 통화의 기록이 있어 AI 를 호출하지 않았습니다. 설정 화면에서 통화별 사용량을 확인하세요(본문은 바뀌지 않았습니다).',
  // T09 채널 초안
  media_incomplete: '검토로 보내려면 채널에 필요한 미디어가 더 있어야 합니다(Instagram: 이미지 1개 이상, YouTube: 완성 영상 1개).',
  stale_variant: '원문이 바뀌었습니다. "현재 원문으로 다시 초안"을 만든 뒤 검토로 보내세요.',
  no_variants: '배포 파일을 만들 채널 초안이 없습니다. 먼저 채널 초안을 만드세요.',
  no_current_version: '먼저 채널 초안을 만드세요.',
  // T10
  variant_approved: '승인된 채널 초안입니다. 배포함에서 승인을 철회한 뒤 상태를 바꾸세요.',
  asset_role_mismatch: '파일 형식이 역할과 맞지 않습니다(이미지·썸네일은 이미지 파일, 영상은 영상 파일).',
  invalid_metadata:
    '채널 형식(JSON)의 항목이 규칙에 맞지 않아 저장하지 않았습니다. 카드(번호·300자 이하)·제목(필수, 글자 수)·설명·태그 칸의 이름과 값을 확인하세요(본문은 바뀌지 않았습니다).',
  // M3 화면 FIX(D2): 채널 초안 편집 폼의 구체 오류
  metadata_json: '채널 형식(JSON)을 읽을 수 없어 저장하지 않았습니다. 중괄호 { } 로 감싼 JSON 객체인지(따옴표·쉼표) 확인하세요. 비워 두면 본문만 저장됩니다.',
  metadata_body_mismatch: '본문과 채널 형식의 본문 칸(이어지는 글·캡션·대본·Markdown)이 달라 저장하지 않았습니다. 화면 폼에서는 본문이 기준이니 본문만 고쳐 다시 저장하세요.',
  thread_part_too_long: 'Threads 글은 문단(빈 줄로 구분)마다 500자 이하여야 합니다. 긴 문단을 빈 줄로 나눈 뒤 다시 저장하세요.',
  thread_too_many_parts: 'Threads 이어지는 글은 20개(빈 줄로 구분한 문단 20개)까지입니다. 문단을 합치거나 줄인 뒤 다시 저장하세요.',
  claim_still_in_body: '그 문장이 아직 현재 본문에 있어 "본문에서 뺐음"으로 처리하지 않았습니다. 본문에서 빼거나 고쳐 저장한 뒤 다시 누르세요.',
  unconfirmed_claims: '"준비됨" 원고에는 확인하지 않은 1인칭 경험 주장이 있는 제안을 채택할 수 없습니다. 먼저 주장을 확인하거나 상태를 "검토 중"으로 바꾸세요.',
  conflict: '다른 곳에서 먼저 저장되었습니다. 현재 내용을 확인한 뒤 다시 저장하세요.',
  invalid: '저장하지 못했습니다. 입력값을 확인하세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  too_large: '내용이 너무 깁니다.',
  server: '서버 오류로 처리하지 못했습니다.',
};

/** 폼 오류 코드로 그대로 쓰는 AppError 코드(T09). */
const PASS_THROUGH_CODES = new Set([
  'media_incomplete',
  'stale_variant',
  'no_variants',
  'no_current_version',
  'asset_role_mismatch',
  'invalid_metadata',
  'variant_approved',
  // M3 화면 FIX(D2)
  'metadata_json',
  'metadata_body_mismatch',
  'thread_part_too_long',
  'thread_too_many_parts',
]);

/** 채널 초안 편집 폼의 오류 코드(D2) — 채널 초안 영역 안에서도 다시 보여 준다. */
export const VARIANT_EDIT_ERROR_CODES: ReadonlySet<string> = new Set(['metadata_json', 'metadata_body_mismatch', 'thread_part_too_long', 'thread_too_many_parts', 'invalid_metadata']);

/** 폼 실패 공통(작성 지원): 401 → /login, 404 → notFoundHref, 그 외 → back?error=<code>. */
export function writingFormFailure(e: unknown, request: Request, back: string, notFoundHref: string): Response {
  const res = errorResponse(e, request);
  if (res.status === 401) {
    const headers = new Headers();
    const cookie = res.headers.get('set-cookie');
    if (cookie) headers.set('set-cookie', cookie);
    return seeOther('/login', headers);
  }
  if (res.status === 404) return seeOther(notFoundHref);
  let code = 'server';
  if (res.status === 503) code = 'llm_blocked';
  else if (e instanceof AppError) {
    if (e.code === 'stale_base') code = 'stale';
    else if (e.code === 'llm_failed') code = 'llm_failed';
    else if (e.code === 'run_not_adoptable') code = 'not_adoptable';
    else if (e.code === 'unconfirmed_experience_claims') code = 'unconfirmed_claims';
    else if (e.code === 'claim_still_in_body') code = 'claim_still_in_body';
    else if (e.code === 'budget_exceeded') code = 'budget_exceeded';
    else if (e.code === 'live_run_limit') code = 'live_run_limit';
    else if (e.code === 'live_usage_unresolved') code = 'live_usage_unresolved';
    // FIX3-FULLREV2(G22): kind 가 conflict 라도 일반 'conflict'(다른 곳에서 먼저 저장)로 바꾸지 않는다.
    else if (e.code === 'budget_currency_mismatch') code = 'budget_currency_mismatch';
    else if (PASS_THROUGH_CODES.has(e.code)) code = e.code;
    else if (e.kind === 'conflict') code = 'conflict';
    else if (e.kind === 'csrf') code = 'csrf';
    else if (e.kind === 'payload_too_large') code = 'too_large';
    else code = 'invalid';
  }
  const sep = back.includes('?') ? '&' : '?';
  // FIX3-FULLREV2(G21): AI 실패의 안정 원인 코드(허용 목록에 있을 때만 — 원문 없음)를 함께 넘긴다. 채널 초안 AI 처럼 작성 보조 run 목록에
  // 보이지 않는 실패도 화면 위 안내에서 원인·영구 실패 안내(RunFailureNotice)를 보인다.
  const failure = code === 'llm_failed' && e instanceof AppError ? formFailureCode('llm_failed', e.extra?.failure_code) : null;
  return seeOther(`${back}${sep}error=${code}${failure ? `&failure=${encodeURIComponent(failure)}` : ''}`);
}

/**
 * FIX3-FULLREV2(G21): 폼 리다이렉트의 ?error=llm_failed&failure=<코드> → 화면에 보일 안정 실패 코드. 허용 목록(aiRunFailureView)에 있는
 * 코드만 돌려주고, 그 밖(임의 문자열·원문·error 가 llm_failed 아님)은 null — 쿼리 값을 화면에 그대로 그리지 않는다.
 */
export function formFailureCode(error: unknown, failure: unknown): string | null {
  if (error !== 'llm_failed' || typeof failure !== 'string') return null;
  return aiRunFailureView(failure).code;
}

/** 버전 작성자 표시: AI 제안(모의)과 사용자 문장을 구분한다(docs/01 §4). */
export function versionAuthorLabel(createdBy: string, aiRunId: string | null): string {
  if (createdBy === 'ai:mock') return 'AI 제안(모의)';
  if (createdBy.startsWith('ai:')) return 'AI 제안';
  if (createdBy === 'owner') return aiRunId ? '사용자 저장(AI 제안 채택)' : '사용자 저장';
  return createdBy;
}

/**
 * URL 의 `?run=` 값 정규화(FIX-T06 round 2): 'none' 은 그대로, UUID 는 소문자, 그 밖의 값은 무시(undefined).
 * 조회(getWritingState)와 선택(selectRun)에 같은 값을 쓴다.
 */
export function normalizeRunParam(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v === 'none') return 'none';
  const id = v.trim().toLowerCase();
  return isUuid(id) ? id : undefined;
}

/** 작성실에서 보여 줄 run: 'none' → 없음, 지정한 id 가 목록에 있으면 그것, 아니면 가장 최근. */
export function selectRun<T extends { id: string }>(runs: readonly T[], normalized: string | undefined): T | undefined {
  if (normalized === 'none') return undefined;
  return (normalized ? runs.find((r) => r.id === normalized) : undefined) ?? runs[0];
}
