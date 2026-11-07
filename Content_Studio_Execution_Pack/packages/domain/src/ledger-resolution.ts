/**
 * FIX4-LIVEL1H2(4차 Claude 검토): provider_unstorable 수동 해결(인계 LIVEL1 절차 4~6)을 **손으로 쓴 SQL 대신** 운영자 CLI(`pnpm ledger:resolve`)로 한다.
 * 이 파일은 순수 함수(DB 없음)다: 원장 한 행(묶음 형식 — 내보내기가 쓰는 그대로)을 분류하고, 입력으로 새 행을 만들고,
 * **복원 검사와 같은 함수**(bundle.ts `resolutionProblem`·`usageLedgerRowProblems`·`ROW_SCHEMAS.usage_ledger`)로 그 행을 검사한다.
 * 규칙을 SQL 이나 CLI 로 옮겨 적지 않는다 — 검증기가 유일한 기준이다. CLI 에만 있는 더 엄격한 규칙(아래 LEDGER_RESOLUTION_MESSAGES)은
 * `actual_format`·`none_actual`, DB 가 담을 수 없는 문자 `text_encoding`, 그리고 FIX5(5차 Claude 검토)의 `already_valid`(이미 복원 검사를 통과하는 행의
 * 정정은 `overwriteValid` 가 있어야 함)·`text_shell_unsafe`(--by·--reason 의 셸 문자 — 아래 LEDGER_SHELL_UNSAFE_TEXT_RE), FIX6(6차 Claude 검토 FIX5 Q2)의
 * `overwrite_not_needed`(복원 검사에서 거부되는 행에 `overwriteValid` — 그 플래그는 이미 통과하는 행에만), FIX2-CODEX(U3, Codex review-FIX6-D39 Q4)의
 * `text_blank`(--by·--reason 이 공백·기본 무시 문자만 — 아래 isLedgerBlankText)뿐이다.
 *
 * 분류(classifyLedgerRow):
 * - resolve: state settled · usage_source provider_unstorable · 최상위 reported_* 세 개가 FIX4 형식. resolution 이 이미 붙은 "반쯤 끝난" H2 이전 행도
 *   (그 resolution 이 옮길 수 없는 키·값을 갖지 않으면) 최상위 원래 보고값으로 다시 만든다(4차 검토 #6).
 * - correct: 최상위 reported_* 없음 · resolution 객체의 나머지(바꿀 네 키 외)가 정확히 original_usage_source='provider_unstorable' +
 *   original_reported(키 3개, FIX4 형식). original_* 는 바이트 그대로 두고 네 키·usage_source·금액만 바꾼다. `--correct` 가 있어야 한다(#4).
 *   지금 행이 이미 복원 검사(행 규칙 usageLedgerRowProblems)를 통과하면 `--overwrite-valid` 도 있어야 한다(FIX5 — 5차 검토 Q3, 거부 코드 `already_valid`).
 *   거꾸로 통과하지 않는 행(정정 대상)에 `--overwrite-valid` 를 붙이면 거부한다(FIX6 — FIX5 Q2, `overwrite_not_needed`): 그 플래그는 "이 행은 이미 통과한다"는
 *   행마다의 주장이어서, 습관처럼 붙여 둔 명령이 다른(올바른) 행에서 `already_valid` 를 끄지 못하게 한다.
 * - refuse: 그 밖의 모든 모양(값을 지어내야 하거나 옮길 수 없는 키가 있음) — 아무것도 바꾸지 않는다.
 */
import { fromMicro, toMicro } from './budget';
import {
  isReportedCost,
  isReportedTokens,
  ORIGINAL_REPORTED_KEYS,
  RESOLUTION_KEYS,
  resolutionProblem,
  ROW_SCHEMAS,
  stableStringify,
  usageLedgerRowProblems,
  type BundleRow,
  type ResolutionProblem,
} from './bundle';

export type LedgerBundleRow = BundleRow<'usage_ledger'>;

/** 분류에서 거부하는 모양 */
export type LedgerRowRefusal = 'state' | 'reported_invalid' | 'reported_misplaced' | 'partial_resolution_unsafe' | 'not_target' | 'resolution_unfixable';

export type LedgerRowClass =
  | { kind: 'resolve'; halfFinished: boolean }
  | { kind: 'correct'; currentRowValid: boolean }
  | { kind: 'refuse'; code: LedgerRowRefusal };

/** 정정에서 바꾸는 resolution 키(나머지 original_* 는 그대로) */
export const CORRECTABLE_RESOLUTION_KEYS = ['resolved_at', 'resolved_by', 'reason', 'settled_amount'] as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const validReportedTriple = (o: Record<string, unknown>) =>
  isReportedTokens(o.reported_tokens_in) && isReportedTokens(o.reported_tokens_out) && isReportedCost(o.reported_cost);

export function classifyLedgerRow(row: LedgerBundleRow): LedgerRowClass {
  if (row.state !== 'settled') return { kind: 'refuse', code: 'state' };
  const snap = row.pricing_snapshot;
  const reportedPresent = ORIGINAL_REPORTED_KEYS.filter((k) => hasOwn(snap, k));
  if (snap.usage_source === 'provider_unstorable' && reportedPresent.length > 0) {
    if (reportedPresent.length !== ORIGINAL_REPORTED_KEYS.length || !validReportedTriple(snap)) return { kind: 'refuse', code: 'reported_invalid' };
    if (!hasOwn(snap, 'resolution')) return { kind: 'resolve', halfFinished: false };
    // 반쯤 끝난 H2 이전 행(4·5 단계만 함): 새 resolution 으로 통째로 바꾼다 — 버려지는 키는 아는 키뿐이어야 하고,
    // 이미 옮겨 둔 값이 있으면 최상위 원래 값과 같아야 한다(어느 쪽이 원본인지 모르면 멈춘다).
    const res = snap.resolution;
    if (!isPlainObject(res)) return { kind: 'refuse', code: 'partial_resolution_unsafe' };
    if (Object.keys(res).some((k) => !(RESOLUTION_KEYS as readonly string[]).includes(k))) return { kind: 'refuse', code: 'partial_resolution_unsafe' };
    if (hasOwn(res, 'original_usage_source') && res.original_usage_source !== 'provider_unstorable') return { kind: 'refuse', code: 'partial_resolution_unsafe' };
    if (hasOwn(res, 'original_reported') && stableStringify(res.original_reported) !== stableStringify(reportedTriple(snap))) {
      return { kind: 'refuse', code: 'partial_resolution_unsafe' };
    }
    return { kind: 'resolve', halfFinished: true };
  }
  if (reportedPresent.length > 0) return { kind: 'refuse', code: 'reported_misplaced' };
  if (!hasOwn(snap, 'resolution')) return { kind: 'refuse', code: snap.usage_source === 'provider_unstorable' ? 'reported_invalid' : 'not_target' };
  const res = snap.resolution;
  if (!isPlainObject(res)) return { kind: 'refuse', code: 'resolution_unfixable' };
  const rest = Object.keys(res).filter((k) => !(CORRECTABLE_RESOLUTION_KEYS as readonly string[]).includes(k)).sort();
  if (stableStringify(rest) !== stableStringify(['original_reported', 'original_usage_source'])) return { kind: 'refuse', code: 'resolution_unfixable' };
  if (res.original_usage_source !== 'provider_unstorable') return { kind: 'refuse', code: 'resolution_unfixable' };
  const orig = res.original_reported;
  if (!isPlainObject(orig) || Object.keys(orig).length !== ORIGINAL_REPORTED_KEYS.length || !ORIGINAL_REPORTED_KEYS.every((k) => hasOwn(orig, k)) || !validReportedTriple(orig)) {
    return { kind: 'refuse', code: 'resolution_unfixable' };
  }
  return { kind: 'correct', currentRowValid: usageLedgerRowProblems(row).length === 0 };
}

function reportedTriple(snap: Record<string, unknown>) {
  return { reported_tokens_in: snap.reported_tokens_in, reported_tokens_out: snap.reported_tokens_out, reported_cost: snap.reported_cost };
}

export interface LedgerResolutionInput {
  /** `--source`(그대로 — provider|none 검사는 검증기가 한다) */
  source: string;
  /** `--actual`: actual_amount 에 들어갈 값 */
  actual: string;
  /** `--settled`: resolution.settled_amount */
  settled: string;
  resolvedBy: string;
  reason: string;
  /** `--correct`: 이미 resolution 이 있는 행의 정정을 허용 */
  correct: boolean;
  /** `--overwrite-valid`: 이미 복원 검사를 통과하는 행(올바른 해결 기록)의 정정을 허용(FIX5 — 없으면 `already_valid`). 통과하지 않는 행에는 거부(FIX6 — `overwrite_not_needed`) */
  overwriteValid: boolean;
  now: Date;
}

export type LedgerResolutionError =
  | LedgerRowRefusal
  | 'needs_correct'
  | 'already_valid'
  | 'overwrite_not_needed'
  | 'not_resolved_yet'
  | 'actual_format'
  | 'text_encoding'
  | 'text_shell_unsafe'
  | 'text_blank'
  | `resolution:${ResolutionProblem}`
  | 'row_integrity'
  | 'row_schema'
  | 'none_actual';

export interface LedgerResolutionPlan {
  mode: 'resolve' | 'correct';
  halfFinished: boolean;
  /** 정정일 때만: 지금 행이 복원 검사를 통과하는가(통과면 이미 올바른 행을 고치는 것 — overwriteValid 일 때만 여기까지 오고, 미리보기가 경고한다) */
  currentRowValid: boolean | null;
  /** 쓸 행(묶음 형식) — 검증기를 통과한 바로 그 값 */
  next: LedgerBundleRow;
}

/** `--actual`: numeric(18,6) 열에 그대로 들어가는 정규 형식만(정수부 0 이거나 앞자리 0 없음·최대 12자리 + 소수 정확히 6자리). CLI 만의 규칙(검증기보다 엄격). */
export const LEDGER_ACTUAL_INPUT_RE = /^(0|[1-9]\d{0,11})\.\d{6}$/;
/** PostgreSQL text/jsonb 가 담을 수 없는 문자(NUL·짝 없는 서로게이트) */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isUnstorableText = (v: string) => v.includes('\u0000') || LONE_SURROGATE_RE.test(v);
/**
 * FIX5(5차 검토 #4·#5)·FIX6(6차 검토 #1·#5): 운영자 명령의 자유 글(--by·--reason)은 셸을 두 번 지난다(Git Bash → pnpm 의 스크립트 셸, Windows 는 cmd.exe).
 * 받지 않는 것: `"`·`%`·`\`, cmd.exe 연산자 `&`·`|`·`<`·`>`·`^`, 그리고 `/` 로 **시작하는** 값(Git Bash(MSYS)가 POSIX 경로처럼 보이는 인자를 Windows 경로로 바꿈).
 * 이 거부는 **일관성 규칙**이다(복원 검사가 아니라 이 명령만의 규칙) — 같은 글이 어느 셸에서나 같게 도착하게 한다. 거부는 이 문자가 프로그램에 **도착했을 때만** 본다:
 * Linux·macOS 에서는 고정한 pnpm 12.6.0 이 이 문자를 바꾸지 않고 넘긴다(6차 검토자가 Linux 에서 확인). Windows cmd.exe [미확인] 에서 실제 `%VAR%` 확장이나
 * `"` 에서의 끊김, Git Bash 의 경로 변환은 프로그램이 시작하기 전에 그 문자를 없애거나 바꾸므로 이 정규식이 아니라 미리보기의 `resolved_by:`·`reason:` 표시에서만 보인다.
 */
export const LEDGER_SHELL_UNSAFE_TEXT_RE = /["%\\&|<>^]|^\//;
/**
 * FIX2-CODEX(U3 — Codex review-FIX6-D39 Q4, 사용자 결정 2026-10-23): 공백(JS trim() 이 지우는 문자·\p{White_Space})과 기본 무시 문자(\p{Default_Ignorable_Code_Point} —
 * 한글 채움 U+3164·U+115F·U+1160·U+FFA0, 폭 없는 공백 U+200B, 단어 잇기 U+2060, 변이 선택자 등)**만으로** 된 --by·--reason 은 받지 않는다(`text_blank` — 운영 기록
 * 품질, 이 명령만의 규칙). 보이는 글자가 하나라도 있으면(섞인 값) 지금처럼 받고 미리보기가 \u 로 보여 준다.
 * JS trim() 으로 이미 빈 값(빈 값·공백만)은 이 검사가 아니라 지금처럼 복원 검사와 같은 `resolution:resolved_by`·`resolution:reason` 으로 거부한다(코드 그대로 —
 * 이 검사는 trim() 이 남기는 문자가 있을 때만). 복원 검사(bundle.ts isValidResolution)는 바꾸지 않는다: 이미 저장된 묶음의 채움 문자만인 값은 그대로 유효하다.
 */
const LEDGER_BLANK_TEXT_RE = /^[\s\p{White_Space}\p{Default_Ignorable_Code_Point}]+$/u;
export const isLedgerBlankText = (v: string): boolean => v.trim() !== '' && LEDGER_BLANK_TEXT_RE.test(v);

export function planLedgerResolution(current: LedgerBundleRow, input: LedgerResolutionInput): { ok: true; plan: LedgerResolutionPlan } | { ok: false; code: LedgerResolutionError } {
  const cls = classifyLedgerRow(current);
  if (cls.kind === 'refuse') return { ok: false, code: cls.code };
  if (cls.kind === 'correct' && !input.correct) return { ok: false, code: 'needs_correct' };
  if (cls.kind === 'correct' && cls.currentRowValid && !input.overwriteValid) return { ok: false, code: 'already_valid' };
  if (cls.kind === 'correct' && !cls.currentRowValid && input.overwriteValid) return { ok: false, code: 'overwrite_not_needed' };
  if (cls.kind === 'resolve' && input.correct) return { ok: false, code: 'not_resolved_yet' };
  if (!LEDGER_ACTUAL_INPUT_RE.test(input.actual)) return { ok: false, code: 'actual_format' };
  if (isUnstorableText(input.resolvedBy) || isUnstorableText(input.reason)) return { ok: false, code: 'text_encoding' };
  if (LEDGER_SHELL_UNSAFE_TEXT_RE.test(input.resolvedBy) || LEDGER_SHELL_UNSAFE_TEXT_RE.test(input.reason)) return { ok: false, code: 'text_shell_unsafe' };
  if (isLedgerBlankText(input.resolvedBy) || isLedgerBlankText(input.reason)) return { ok: false, code: 'text_blank' };

  const snap = structuredClone(current.pricing_snapshot);
  const resolvedAt = input.now.toISOString();
  let nextSnap: Record<string, unknown>;
  if (cls.kind === 'resolve') {
    const { reported_tokens_in, reported_tokens_out, reported_cost, resolution: _partial, ...rest } = snap;
    void _partial; // 반쯤 끝난 기록은 통째로 바꾼다(분류가 버려도 되는 모양만 넘겼다)
    nextSnap = {
      ...rest,
      usage_source: input.source,
      resolution: {
        resolved_at: resolvedAt,
        resolved_by: input.resolvedBy,
        reason: input.reason,
        settled_amount: input.settled,
        original_usage_source: 'provider_unstorable',
        original_reported: { reported_tokens_in, reported_tokens_out, reported_cost },
      },
    };
  } else {
    const res = snap.resolution as Record<string, unknown>;
    nextSnap = {
      ...snap,
      usage_source: input.source,
      resolution: { ...res, resolved_at: resolvedAt, resolved_by: input.resolvedBy, reason: input.reason, settled_amount: input.settled },
    };
  }
  const reserved = toMicro(current.reserved_amount);
  const actual = toMicro(input.actual);
  const next: LedgerBundleRow = {
    ...current,
    pricing_snapshot: nextSnap,
    actual_amount: fromMicro(actual),
    overage_amount: fromMicro(actual > reserved ? actual - reserved : 0n),
    over_budget: actual > reserved,
  };
  // 복원 검사와 같은 함수로 쓸 행 그대로를 검사한다(하나라도 어긋나면 쓰지 않는다)
  const problem = resolutionProblem(next.pricing_snapshot, next);
  if (problem) return { ok: false, code: `resolution:${problem}` };
  if (usageLedgerRowProblems(next).length > 0) return { ok: false, code: 'row_integrity' };
  if (!ROW_SCHEMAS.usage_ledger.safeParse(next).success) return { ok: false, code: 'row_schema' };
  // CLI 만의 규칙(검증기보다 엄격 — 절차 6): none 은 보고값을 믿지 않고 예약액 유지
  if (input.source === 'none' && actual !== reserved) return { ok: false, code: 'none_actual' };
  return { ok: true, plan: { mode: cls.kind, halfFinished: cls.kind === 'resolve' && cls.halfFinished, currentRowValid: cls.kind === 'correct' ? cls.currentRowValid : null, next } };
}

/** 거부 이유(한국어 — 값은 넣지 않는다. 예약액처럼 미리보기에 이미 나오는 금액만 CLI 가 덧붙인다). */
export const LEDGER_RESOLUTION_MESSAGES: Record<LedgerResolutionError, string> = {
  state: '대상 행의 state 가 settled 가 아니라 이 명령으로 다루지 않습니다 — 멈추고 1단계 백업 묶음을 보관한 채 별도 작업으로 다룹니다',
  reported_invalid:
    'provider_unstorable 행인데 최상위 보고값(reported_tokens_in·reported_tokens_out·reported_cost)이 없거나 형식이 틀려 original_reported 를 만들 수 없습니다 — 값을 지어내지 않습니다. 멈추고 1단계 백업 묶음을 보관한 채 별도 작업으로 다룹니다',
  reported_misplaced: 'usage_source 가 provider_unstorable 이 아닌 행에 최상위 reported_* 가 있습니다(옮기지 않고 복사한 모양 등) — 멈추고 1단계 백업 묶음을 보관한 채 별도 작업으로 다룹니다',
  partial_resolution_unsafe:
    '반쯤 끝난 해결 기록(provider_unstorable + resolution)에 버리면 안 되는 키·값이 있습니다(모르는 키, original_usage_source 가 다름, 최상위 보고값과 다른 original_reported) — 멈추고 1단계 백업 묶음을 보관한 채 별도 작업으로 다룹니다',
  not_target: '해결 대상이 아닙니다: provider_unstorable 행도 아니고 수동 해결 기록(resolution)도 없습니다 — --list 로 id 를 다시 확인하세요',
  resolution_unfixable:
    '이미 있는 resolution 을 정정할 수 없는 모양입니다(바꿀 네 키 외에 다른 키, original_reported 없음·키 수·형식이 틀림, original_usage_source 가 provider_unstorable 이 아님, resolution 이 객체가 아님) — 멈추고 1단계 백업 묶음을 보관한 채 별도 작업으로 다룹니다',
  needs_correct:
    '이 행에는 이미 수동 해결 기록(resolution)이 있습니다. 정정하려면 --correct 를 붙입니다(resolved_at·resolved_by·reason·settled_amount·usage_source·금액만 바꾸고 original_usage_source·original_reported 는 그대로). 고치려던 행이 맞는지 --list 로 먼저 확인하세요',
  already_valid:
    '이 행의 해결 기록은 이미 복원 검사를 통과합니다(복원 때문에 고칠 필요가 없는 행) — 고치려던 행이 맞는지 --list 로 다시 확인하세요(7-③ 이 거부한 행은 --list 에 "복원 검사 거부" 로 나옵니다). 올바른 기록을 일부러 바꾸려면(예: 사유 고쳐 쓰기) --correct --overwrite-valid 로 미리보기부터 다시 합니다 — 이전 resolved_by·reason 은 1단계 백업 묶음에만 남습니다(이전 settled_amount·resolved_at 은 미리보기에 보이고 감사 기록에도 남습니다 — 복원 형식일 때만)',
  overwrite_not_needed:
    '--overwrite-valid 는 이미 복원 검사를 통과하는 행(--list 의 "정정만(--correct --overwrite-valid — 이미 복원 검사 통과)")에만 씁니다 — 이 행은 복원 검사에서 거부되는 정정 대상입니다. --overwrite-valid 를 빼고 --correct 만으로 미리보기부터 다시 합니다(고치려던 행이 맞는지 --list 로 확인)',
  not_resolved_yet: '이 행은 아직 해결되지 않은 provider_unstorable 행입니다 — --correct 없이 실행합니다',
  actual_format: '--actual 은 정수부(0 이거나 앞자리 0 없음, 최대 12자리) + "." + 소수 정확히 6자리입니다(예 9.950000 — numeric(18,6) 열에 그대로 들어가는 값)',
  text_encoding: '--by·--reason 에 DB 가 담을 수 없는 문자(NUL·짝 없는 서로게이트)가 있습니다',
  text_shell_unsafe:
    '--by·--reason 에 큰따옴표(")·퍼센트(%)·역슬래시(\\)·&·|·<·>·^ 를 쓸 수 없고 값을 / 로 시작할 수 없습니다 — 같은 명령 글이 어느 셸에서나 같게 도착하게 하는 이 명령만의 규칙입니다' +
    '(명령 글은 셸을 두 번 지납니다: Git Bash, 그다음 pnpm 의 스크립트 셸. Linux·macOS 에서는 고정한 pnpm 이 이 문자를 그대로 넘기지만, Windows cmd.exe [미확인] 의 %VAR% 확장·" 에서의 끊김·& | < > ^ 처리와' +
    ' Git Bash 의 / 경로 변환은 프로그램이 시작하기 전에 글을 바꿀 수 있습니다 — 그런 변형은 이 거부가 아니라 미리보기의 resolved_by:·reason: 줄에서만 보입니다). 다른 말로 바꿔 적습니다',
  text_blank:
    '--by·--reason 이 공백과 보이지 않는 문자(한글 채움 문자 U+3164·폭 없는 공백 U+200B 같은 기본 무시 문자)만으로 되어 있습니다 — 누가·왜 해결했는지 보이는 글자로 적습니다(이 명령만의 규칙 — 복원 검사는 그대로)',
  'resolution:usage_source': '--source 는 provider 또는 none 입니다',
  'resolution:keys': '만든 resolution 의 키가 6개가 아닙니다(내부 오류)',
  'resolution:resolved_at': '만든 resolved_at 이 UTC(Z) 시각 형식이 아닙니다(내부 오류)',
  'resolution:resolved_by': '--by 는 공백만이 아닌 200자 이하입니다(길이는 UTF-16 단위 — 이모지 1개 = 2자, 공백은 JS trim() 이 지우는 문자)',
  'resolution:reason': '--reason 은 공백만이 아닌 4000자 이하입니다(길이는 UTF-16 단위 — 이모지 1개 = 2자, 공백은 JS trim() 이 지우는 문자)',
  'resolution:original_usage_source': '만든 original_usage_source 가 provider_unstorable 이 아닙니다(내부 오류)',
  'resolution:original_reported': '만든 original_reported 가 FIX4 형식이 아닙니다(내부 오류)',
  'resolution:settled_amount': '--settled 는 정수부(0 이거나 앞자리 0 없음, 최대 40자리) + "." + 소수 정확히 6자리입니다(예 9.950000 — 9.95·09.950000·9950000·1e5 는 거부)',
  'resolution:state': '대상 행의 state 가 settled 가 아닙니다',
  'resolution:amount_format': '금액 열 형식이 numeric(18,6) 가 아닙니다(내부 오류)',
  'resolution:settled_vs_actual':
    '--settled 와 --actual 은 같은 금액이어야 합니다. 예외는 5단계 상한뿐: --settled(실제 청구) > --actual 이고 --actual > 예약액(위로 재정산을 실제로 함). --settled < --actual, 또는 --actual 을 예약액 그대로 두고 --settled 만 큰 것은 거부',
  row_integrity: '만든 행이 복원 무결성 검사(usage_ledger 행 규칙)를 통과하지 못했습니다',
  row_schema: '만든 행이 묶음 행 형식(usage_ledger)을 통과하지 못했습니다',
  none_actual: '--source none 이면 --actual·--settled 는 예약액(reserved_amount)과 같아야 합니다(6단계: 보고값을 믿지 않고 예약액 유지)',
};
