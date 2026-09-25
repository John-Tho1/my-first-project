/**
 * T06 작성 지원 — 폼 → API 입력 변환, 응답 모양, 폼 오류 문구(서버 전용). JSON 필드는 snake_case(docs/04).
 */
import { usageLedgerView, type AssistResult } from '@cs/db';
import { AppError, blocksToList, diffLines, diffStats, isUuid, linesToList } from '@cs/domain';
import { MOCK_WARNING } from '@cs/providers';
import { errorResponse, seeOther } from './api';

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
  // T09 채널 초안
  media_incomplete: '검토로 보내려면 채널에 필요한 미디어가 더 있어야 합니다(Instagram: 이미지 1개 이상, YouTube: 완성 영상 1개).',
  stale_variant: '원문이 바뀌었습니다. "현재 원문으로 다시 초안"을 만든 뒤 검토로 보내세요.',
  no_variants: '배포 파일을 만들 채널 초안이 없습니다. 먼저 채널 초안을 만드세요.',
  no_current_version: '먼저 채널 초안을 만드세요.',
  // T10
  variant_approved: '승인된 채널 초안입니다. 배포함에서 승인을 철회한 뒤 상태를 바꾸세요.',
  asset_role_mismatch: '파일 형식이 역할과 맞지 않습니다(이미지·썸네일은 이미지 파일, 영상은 영상 파일).',
  invalid_metadata: '채널 형식(글자 수 등)이 맞지 않아 저장하지 않았습니다.',
  claim_still_in_body: '그 문장이 아직 현재 본문에 있어 "본문에서 뺐음"으로 처리하지 않았습니다. 본문에서 빼거나 고쳐 저장한 뒤 다시 누르세요.',
  unconfirmed_claims: '"준비됨" 원고에는 확인하지 않은 1인칭 경험 주장이 있는 제안을 채택할 수 없습니다. 먼저 주장을 확인하거나 상태를 "검토 중"으로 바꾸세요.',
  conflict: '다른 곳에서 먼저 저장되었습니다. 현재 내용을 확인한 뒤 다시 저장하세요.',
  invalid: '저장하지 못했습니다. 입력값을 확인하세요.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  too_large: '내용이 너무 깁니다.',
  server: '서버 오류로 처리하지 못했습니다.',
};

/** 폼 오류 코드로 그대로 쓰는 AppError 코드(T09). */
const PASS_THROUGH_CODES = new Set(['media_incomplete', 'stale_variant', 'no_variants', 'no_current_version', 'asset_role_mismatch', 'invalid_metadata', 'variant_approved']);

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
    else if (PASS_THROUGH_CODES.has(e.code)) code = e.code;
    else if (e.kind === 'conflict') code = 'conflict';
    else if (e.kind === 'csrf') code = 'csrf';
    else if (e.kind === 'payload_too_large') code = 'too_large';
    else code = 'invalid';
  }
  const sep = back.includes('?') ? '&' : '?';
  return seeOther(`${back}${sep}error=${code}`);
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
