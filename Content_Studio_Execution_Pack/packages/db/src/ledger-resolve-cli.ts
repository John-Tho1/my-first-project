/**
 * `pnpm ledger:resolve` 의 본체(FIX4-LIVEL1H2 — 4차 Claude 검토). 스크립트(packages/db/scripts/ledger-resolve.ts)는 이것을 부르기만 한다 — 시험 가능하게.
 * provider_unstorable 수동 해결(인계 LIVEL1 절차 4~6)을 손으로 쓴 SQL 대신 이 명령으로 한다. 규칙은 복원 검사와 같은 함수(@cs/domain
 * ledger-resolution.ts → bundle.ts resolutionProblem·usageLedgerRowProblems)에서만 온다.
 *
 * - `--list [--owner <id>]`: 읽기 전용 — 그 owner 의 provider_unstorable·해결 기록 있는 원장 행과 처리 방식(새 해결 / 정정만 / 고칠 수 없음).
 *   절차 2·3 에 필요한 보고값(토큰·비용)과 run 상태·오류 코드도 보여 준다. --owner 가 없으면 AUTH_ALLOWED_IDENTITY 의 owner.
 * - `--owner <id> --ledger <id> --source provider|none --actual <금액> --settled <금액> --by <누가> --reason <사유> [--correct] [--confirm]`:
 *   기본은 미리보기(아무것도 쓰지 않음). 그 owner 의 그 id 한 행을 찾아(없으면 exit 1) 분류하고, 쓸 행을 만들어 검증기로 검사한 뒤
 *   (틀리면 exit 1) 미리보기를 출력한다. `--confirm` 이면 한 트랜잭션에서 행을 잠그고 다시 읽어 미리보기 때와 같은지 비교하고(다르면 중단),
 *   같은 값을 조건으로 건 UPDATE 가 정확히 1행일 때만, 쓴 행을 다시 읽어 계획한 행과 같고 검사를 통과하는지 본 뒤 감사 기록과 함께 커밋한다.
 *   `updated 1` 을 출력한다. 이미 resolution 이 있는 행은 `--correct` 가 있어야 한다(original_usage_source·original_reported 는 그대로).
 * - 출력: 미리보기 칸(id·usage_source 전후·금액·live 차단 여부·by/reason 길이)만. resolved_by·reason 값, 보고값(--list 제외), 다른 스냅숏 값,
 *   DB 오류 메시지 본문은 쓰지 않는다(오류는 secrets-cli 와 같은 describeErrorSafely).
 * - 종료 코드: 0 성공(미리보기·적용·목록) · 1 거부(대상 없음·형식·검사·모양·경쟁)·DB 잠금(dev 서버가 열고 있음)·예상하지 못한 오류·DB 닫기 실패 · 2 사용법.
 */
import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import {
  classifyLedgerRow,
  isReportedCost,
  isReportedTokens,
  LEDGER_RESOLUTION_MESSAGES,
  loadConfig,
  planLedgerResolution,
  stableStringify,
  usageLedgerRowProblems,
  type AppConfig,
  type LedgerBundleRow,
  type LedgerResolutionPlan,
} from '@cs/domain';
import { selectBundleRows } from './bundle-tables';
import { hasUnresolvedLiveUsage } from './budget';
import type { Db, DbHandle } from './client';
import { DbLockedError } from './lock';
import { findOwner, recordAudit, type DbOrTx } from './queries';
import { generationRuns, usageLedger, users } from './schema';
import { describeErrorSafely } from './secrets-cli';

export interface LedgerResolveCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  openDb: (config: AppConfig) => Promise<DbHandle>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** resolved_at 시각(시험용 주입). 없으면 지금. */
  now?: () => Date;
  /** 시험 전용: 미리보기를 계산한 뒤, 적용 트랜잭션을 열기 전에 부른다(그 사이 행이 바뀌는 경쟁 재현). */
  beforeApply?: (db: Db) => Promise<void>;
}

export const LEDGER_RESOLVE_USAGE = [
  '사용법(서버를 끈 상태 — PGlite 단일 연결):',
  '  corepack pnpm ledger:resolve --list [--owner <owner id>]',
  "  corepack pnpm ledger:resolve --owner <owner id> --ledger <ledger id> --source provider|none --actual <금액> --settled <금액> --by '<누가>' --reason '<사유>' [--correct] [--confirm]",
  '  (기본은 미리보기 — 아무것도 바꾸지 않는다. 적용은 같은 명령 끝에 --confirm. 이미 resolution 이 있는 행의 정정은 --correct)',
].join('\n');

const VALUE_FLAGS = ['owner', 'ledger', 'source', 'actual', 'settled', 'by', 'reason'] as const;
const BOOL_FLAGS = ['confirm', 'correct', 'list'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
type BoolFlag = (typeof BOOL_FLAGS)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 출력해도 되는 옵션 이름 모양(그 밖은 값이 섞였을 수 있어 되풀이하지 않는다) */
const SAFE_FLAG_NAME = /^[a-z][a-z-]{0,23}$/;

export type LedgerResolveArgs =
  | { kind: 'list'; owner: string | null }
  | {
      kind: 'resolve';
      owner: string;
      ledger: string;
      source: string;
      actual: string;
      settled: string;
      by: string;
      reason: string;
      correct: boolean;
      confirm: boolean;
    };

/** 인자 해석. 값은 `--이름 값` 또는 `--이름=값`(값이 --로 시작하면 = 형식만). 같은 옵션 두 번·모르는 옵션·위치 인자는 사용법 오류. */
export function parseLedgerResolveArgs(argv: readonly string[]): { ok: true; args: LedgerResolveArgs } | { ok: false; message: string } {
  const values = new Map<ValueFlag, string>();
  const bools = new Set<BoolFlag>();
  const list = argv[0] === '--' ? argv.slice(1) : argv; // `pnpm ledger:resolve -- …` 도 받는다
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    if (!a.startsWith('--') || a === '--') return { ok: false, message: '알 수 없는 인자입니다(옵션은 --이름 값 형식).' };
    const eqAt = a.indexOf('=');
    const name = eqAt === -1 ? a.slice(2) : a.slice(2, eqAt);
    if ((BOOL_FLAGS as readonly string[]).includes(name)) {
      if (eqAt !== -1) return { ok: false, message: `--${name} 은 값을 받지 않습니다.` };
      if (bools.has(name as BoolFlag)) return { ok: false, message: `--${name} 이 두 번 있습니다.` };
      bools.add(name as BoolFlag);
    } else if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      let v: string | undefined;
      if (eqAt !== -1) v = a.slice(eqAt + 1);
      else {
        v = list[i + 1];
        if (v === undefined || v.startsWith('--')) return { ok: false, message: `--${name} 의 값이 없습니다(값이 --로 시작하면 --${name}=값 으로 씁니다).` };
        i++;
      }
      if (values.has(name as ValueFlag)) return { ok: false, message: `--${name} 이 두 번 있습니다.` };
      values.set(name as ValueFlag, v);
    } else {
      return { ok: false, message: SAFE_FLAG_NAME.test(name) ? `알 수 없는 옵션: --${name}` : '알 수 없는 옵션입니다.' };
    }
  }
  const uuidOf = (k: 'owner' | 'ledger') => {
    const v = values.get(k);
    return v !== undefined && UUID_RE.test(v) ? v.toLowerCase() : null;
  };
  if (bools.has('list')) {
    const extra = [...values.keys()].filter((k) => k !== 'owner').map((k) => `--${k}`).concat([...bools].filter((b) => b !== 'list').map((b) => `--${b}`));
    if (extra.length > 0) return { ok: false, message: `--list 와 함께 쓸 수 있는 것은 --owner 뿐입니다(${extra.join(', ')}).` };
    if (values.has('owner') && !uuidOf('owner')) return { ok: false, message: '--owner 는 uuid 입니다.' };
    return { ok: true, args: { kind: 'list', owner: uuidOf('owner') } };
  }
  const missing = VALUE_FLAGS.filter((k) => !values.has(k));
  if (missing.length > 0) return { ok: false, message: `빠진 옵션: ${missing.map((k) => `--${k}`).join(', ')}` };
  const owner = uuidOf('owner');
  const ledger = uuidOf('ledger');
  if (!owner || !ledger) return { ok: false, message: '--owner·--ledger 는 uuid 입니다(--list 로 확인).' };
  return {
    ok: true,
    args: {
      kind: 'resolve',
      owner,
      ledger,
      source: values.get('source')!,
      actual: values.get('actual')!,
      settled: values.get('settled')!,
      by: values.get('by')!,
      reason: values.get('reason')!,
      correct: bools.has('correct'),
      confirm: bools.has('confirm'),
    },
  };
}

/** 묶음 형식(내보내기와 같은 열·같은 변환)으로 owner 의 원장 행을 읽는다. */
async function readLedgerRows(db: DbOrTx, where: SQL): Promise<LedgerBundleRow[]> {
  return (await selectBundleRows(db, 'usage_ledger', where)).map((r) => r.row as LedgerBundleRow);
}
const targetWhere = (owner: string, ledger: string) => sql`"usage_ledger"."id" = ${ledger}::uuid and "usage_ledger"."owner_id" = ${owner}::uuid`;

async function unresolvedCount(db: DbOrTx, owner: string, exceptId?: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(usageLedger)
    .where(
      and(
        eq(usageLedger.ownerId, owner),
        sql`${usageLedger.pricingSnapshot} ->> 'usage_source' = 'provider_unstorable'`,
        ...(exceptId ? [ne(usageLedger.id, exceptId)] : []),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** 출력용 usage_source(정해진 모양이 아니면 값을 되풀이하지 않는다) */
const showSource = (snap: Record<string, unknown>) =>
  !Object.prototype.hasOwnProperty.call(snap, 'usage_source')
    ? '(없음 — 이전 행)'
    : typeof snap.usage_source === 'string' && /^[a-z_]{1,32}$/.test(snap.usage_source)
      ? snap.usage_source
      : '(형식 밖 값)';
const showAmount = (v: string | null) => (v === null ? '(없음)' : v);
const blockedLine = (n: number) =>
  n === 0 ? '열림(이 owner 의 provider_unstorable 0행)' : `계속 막힘(이 owner 에 provider_unstorable ${n}행이 남음 — 행마다 이 명령으로 해결)`;

class LedgerChangedError extends Error {}
class LedgerVerifyError extends Error {}

export async function runLedgerResolveCli(deps: LedgerResolveCliDeps): Promise<number> {
  const parsed = parseLedgerResolveArgs(deps.argv);
  if (!parsed.ok) {
    deps.err(parsed.message);
    deps.err(LEDGER_RESOLVE_USAGE);
    return 2;
  }
  let handle: DbHandle | null = null;
  let code: number;
  const state = { committed: false };
  try {
    const config = loadConfig(deps.env);
    handle = await deps.openDb(config);
    code = parsed.args.kind === 'list' ? await runList(handle.db, parsed.args.owner, config, deps) : await runResolve(handle.db, parsed.args, deps, state);
  } catch (e) {
    if (e instanceof DbLockedError) deps.err(e.message);
    else if (state.committed) deps.err(`적용(커밋)은 끝났지만 그 뒤 확인을 마치지 못했습니다(오류 종류: ${describeErrorSafely(e)}). --list 로 결과를 확인하세요.`);
    else deps.err(`원장 수동 해결을 마치지 못했습니다(오류 종류: ${describeErrorSafely(e)}). 아무것도 바꾸지 않았습니다.`);
    code = 1;
  }
  if (handle) {
    try {
      await handle.close();
    } catch (e) {
      deps.err(`DB 를 닫지 못했습니다(오류 종류: ${describeErrorSafely(e)}).`);
      code = 1;
    }
  }
  return code;
}

function previewLines(a: Extract<LedgerResolveArgs, { kind: 'resolve' }>, current: LedgerBundleRow, plan: LedgerResolutionPlan, remainingOthers: number): string[] {
  const next = plan.next;
  const lines = [
    `대상: usage_ledger ${a.ledger} · owner ${a.owner}`,
    plan.mode === 'resolve'
      ? plan.halfFinished
        ? '방식: 새 해결 — 반쯤 끝난 해결 기록(provider_unstorable + resolution)을 최상위 원래 보고값으로 다시 만든다'
        : '방식: 새 해결(provider_unstorable → 해결 기록 6키, 최상위 reported_* 는 resolution.original_reported 로 옮김)'
      : '방식: 정정(--correct) — resolved_at·resolved_by·reason·settled_amount·usage_source·금액만 바꾸고 original_usage_source·original_reported 는 그대로',
  ];
  if (plan.mode === 'correct') {
    lines.push(
      plan.currentRowValid
        ? '지금 행의 복원 검사: 통과 — 이미 올바른 해결 기록이다. 고치려던 행이 맞는지 --list 로 다시 확인한 뒤에만 --confirm'
        : '지금 행의 복원 검사: 거부(이 정정의 대상)',
    );
  }
  lines.push(
    `usage_source: ${showSource(current.pricing_snapshot)} → ${showSource(next.pricing_snapshot)}`,
    `reserved_amount: ${current.reserved_amount}`,
    `actual_amount: ${showAmount(current.actual_amount)} → ${showAmount(next.actual_amount)}`,
    `overage_amount: ${current.overage_amount} → ${next.overage_amount} · over_budget: ${current.over_budget} → ${next.over_budget}`,
    `settled_amount: ${a.settled}`,
    `resolved_by ${a.by.length}자 · reason ${a.reason.length}자(UTF-16 길이 — 값은 출력하지 않음)`,
    `적용 뒤 이 owner 의 새 live 호출: ${blockedLine(remainingOthers)}`,
  );
  return lines;
}

async function runResolve(db: Db, a: Extract<LedgerResolveArgs, { kind: 'resolve' }>, deps: LedgerResolveCliDeps, state: { committed: boolean }): Promise<number> {
  const rows = await readLedgerRows(db, targetWhere(a.owner, a.ledger));
  if (rows.length !== 1) {
    deps.err(`대상 행이 없습니다: owner ${a.owner} 의 usage_ledger ${a.ledger}(${rows.length}행) — 아무것도 바꾸지 않았습니다. id 는 --list 로 확인합니다.`);
    return 1;
  }
  const current = rows[0]!;
  const now = (deps.now ?? (() => new Date()))();
  const planned = planLedgerResolution(current, { source: a.source, actual: a.actual, settled: a.settled, resolvedBy: a.by, reason: a.reason, correct: a.correct, now });
  if (!planned.ok) {
    const extra = planned.code === 'none_actual' ? ` (예약액 ${current.reserved_amount})` : '';
    deps.err(`거부(${planned.code}): ${LEDGER_RESOLUTION_MESSAGES[planned.code]}${extra} — 아무것도 바꾸지 않았습니다.`);
    return 1;
  }
  const plan = planned.plan;
  const remaining = await unresolvedCount(db, a.owner, a.ledger);
  deps.out(a.confirm ? '원장 수동 해결 — 적용(--confirm)' : '원장 수동 해결 — 미리보기(아무것도 바꾸지 않음)');
  for (const l of previewLines(a, current, plan, remaining)) deps.out(l);
  if (!a.confirm) {
    deps.out('미리보기만 했습니다. 적용하려면 같은 명령 끝에 --confirm 을 붙입니다.');
    return 0;
  }
  await deps.beforeApply?.(db);
  const next = plan.next;
  let after: { unresolved: number };
  try {
    after = await db.transaction(async (tx) => {
      // 행 잠금 → 다시 읽기: 미리보기를 계산한 행과 한 글자라도 다르면 중단(compare-and-swap)
      await tx.select({ id: usageLedger.id }).from(usageLedger).where(and(eq(usageLedger.id, a.ledger), eq(usageLedger.ownerId, a.owner))).for('update');
      const again = await readLedgerRows(tx, targetWhere(a.owner, a.ledger));
      if (again.length !== 1 || stableStringify(again[0]) !== stableStringify(current)) throw new LedgerChangedError();
      const updated = await tx
        .update(usageLedger)
        .set({ pricingSnapshot: next.pricing_snapshot, actualAmount: next.actual_amount, overageAmount: next.overage_amount, overBudget: next.over_budget })
        .where(
          and(
            eq(usageLedger.id, a.ledger),
            eq(usageLedger.ownerId, a.owner),
            eq(usageLedger.state, current.state),
            // 같은 값일 때만(읽은 JS 값이 DB 값과 정확히 같다는 확인도 된다 — 정밀도가 깎인 숫자가 있으면 0행)
            sql`${usageLedger.pricingSnapshot} = ${JSON.stringify(current.pricing_snapshot)}::jsonb`,
            sql`${usageLedger.actualAmount} is not distinct from ${current.actual_amount}::numeric`,
            sql`${usageLedger.overageAmount} = ${current.overage_amount}::numeric`,
            eq(usageLedger.overBudget, current.over_budget),
          ),
        )
        .returning({ id: usageLedger.id });
      if (updated.length !== 1) throw new LedgerChangedError();
      // 쓴 행을 내보내기 형식으로 다시 읽어 계획한 행과 같고 복원 검사를 통과하는지 — 아니면 되돌린다
      const written = await readLedgerRows(tx, targetWhere(a.owner, a.ledger));
      if (written.length !== 1 || stableStringify(written[0]) !== stableStringify(next) || usageLedgerRowProblems(written[0]!).length > 0) throw new LedgerVerifyError();
      const unresolved = await unresolvedCount(tx, a.owner);
      await recordAudit(tx, {
        ownerId: a.owner,
        action: 'usage_ledger.manual_resolve',
        entity: 'usage_ledger',
        entityId: a.ledger,
        details: {
          mode: plan.mode,
          half_finished: plan.halfFinished,
          current_row_valid: plan.currentRowValid,
          usage_source_before: showSource(current.pricing_snapshot),
          usage_source_after: showSource(next.pricing_snapshot),
          reserved_amount: current.reserved_amount,
          actual_amount_before: current.actual_amount,
          actual_amount_after: next.actual_amount,
          settled_amount: a.settled,
          resolved_by_length: a.by.length,
          reason_length: a.reason.length,
          live_blocked_after: unresolved > 0,
        },
      });
      return { unresolved };
    });
  } catch (e) {
    if (e instanceof LedgerChangedError) {
      deps.err('거부(changed): 미리보기를 계산한 뒤 행이 바뀌었습니다(또는 스냅숏에 JS 로 정확히 옮길 수 없는 값이 있음) — 아무것도 바꾸지 않았습니다. 미리보기부터 다시 실행하세요.');
      return 1;
    }
    if (e instanceof LedgerVerifyError) {
      deps.err('거부(verify): 쓴 행이 계획한 행과 다르거나 복원 검사를 통과하지 않아 되돌렸습니다 — 아무것도 바꾸지 않았습니다.');
      return 1;
    }
    throw e;
  }
  state.committed = true;
  deps.out('updated 1');
  deps.out(`이 owner 의 새 live 호출: ${blockedLine(after.unresolved)}`);
  // 커밋 뒤 확인(같은 판정 함수 — 실제 차단 여부)
  const blocked = await hasUnresolvedLiveUsage(db, a.owner);
  if (blocked !== after.unresolved > 0) throw new Error('live 차단 판정이 커밋 직후 값과 다릅니다');
  return 0;
}

/** --list: 읽기 전용. 그 owner 의 provider_unstorable·resolution·reported_* 가 있는 원장 행과 처리 방식. */
async function runList(db: Db, ownerArg: string | null, config: AppConfig, deps: LedgerResolveCliDeps): Promise<number> {
  let owner = ownerArg;
  if (owner === null) {
    const o = await findOwner(db, config.AUTH_ALLOWED_IDENTITY);
    if (!o) {
      deps.err('허용 사용자(AUTH_ALLOWED_IDENTITY)의 owner 가 이 DB 에 없습니다 — --owner 로 지정하거나 DATABASE_URL 을 확인하세요.');
      return 1;
    }
    owner = o.id;
  } else if ((await db.select({ id: users.id }).from(users).where(eq(users.id, owner))).length === 0) {
    deps.err(`owner ${owner} 가 이 DB 에 없습니다.`);
    return 1;
  }
  const rows = (
    await readLedgerRows(
      db,
      sql`"usage_ledger"."owner_id" = ${owner}::uuid and (("usage_ledger"."pricing_snapshot" ->> 'usage_source') = 'provider_unstorable'
        or ("usage_ledger"."pricing_snapshot" -> 'resolution') is not null or ("usage_ledger"."pricing_snapshot" -> 'reported_tokens_in') is not null
        or ("usage_ledger"."pricing_snapshot" -> 'reported_tokens_out') is not null or ("usage_ledger"."pricing_snapshot" -> 'reported_cost') is not null)`,
    )
  ).sort((x, y) => (x.created_at === y.created_at ? (x.id < y.id ? -1 : 1) : x.created_at < y.created_at ? -1 : 1));
  const runIds = rows.map((r) => r.run_id).filter((v): v is string => v !== null);
  const runs = runIds.length
    ? await db
        .select({ id: generationRuns.id, status: generationRuns.status, error: generationRuns.error })
        .from(generationRuns)
        .where(and(eq(generationRuns.ownerId, owner), inArray(generationRuns.id, runIds)))
        .orderBy(asc(generationRuns.id))
    : [];
  const runOf = new Map(runs.map((r) => [r.id, r]));
  const code = (v: string | null) => (v === null ? '-' : /^[a-z0-9_]{1,64}$/.test(v) ? v : '(형식 밖)');
  const unresolved = await unresolvedCount(db, owner);
  deps.out('원장 수동 해결 대상 목록(읽기 전용 — 아무것도 바꾸지 않음)');
  deps.out(`owner ${owner} · 후보 ${rows.length}행 · 아직 provider_unstorable ${unresolved}행(0 이면 새 live 호출이 열려 있음)`);
  for (const r of rows) {
    const snap = r.pricing_snapshot;
    const run = r.run_id ? runOf.get(r.run_id) : undefined;
    const subject = r.run_id ? `run ${r.run_id}(status ${run ? code(run.status) : '?'} · error ${run ? code(run.error) : '?'})` : `transcription_job ${r.transcription_job_id}`;
    const parts = [
      `- usage_ledger ${r.id}`,
      `만든 시각 ${r.created_at}`,
      `state ${r.state}`,
      `failed ${r.failed}`,
      subject,
      `reserved ${r.reserved_amount}`,
      `actual ${showAmount(r.actual_amount)}`,
      `usage_source ${showSource(snap)}`,
    ];
    if (['reported_tokens_in', 'reported_tokens_out', 'reported_cost'].some((k) => Object.prototype.hasOwnProperty.call(snap, k))) {
      parts.push(
        `보고값 tokens_in ${isReportedTokens(snap.reported_tokens_in) ? String(snap.reported_tokens_in) : '(형식 밖)'}` +
          ` · tokens_out ${isReportedTokens(snap.reported_tokens_out) ? String(snap.reported_tokens_out) : '(형식 밖)'}` +
          ` · cost ${isReportedCost(snap.reported_cost) ? String(snap.reported_cost) : '(형식 밖)'}`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(snap, 'resolution')) parts.push(`해결 기록 있음(복원 검사 ${usageLedgerRowProblems(r).length === 0 ? '통과' : '거부'})`);
    const cls = classifyLedgerRow(r);
    const action =
      cls.kind === 'resolve'
        ? cls.halfFinished
          ? '새 해결(--correct 없이 — 반쯤 끝난 기록을 다시 만듦)'
          : '새 해결(--correct 없이)'
        : cls.kind === 'correct'
          ? '정정만(--correct)'
          : `이 명령으로 고칠 수 없음(${cls.code})`;
    deps.out(`${parts.join(' · ')} → ${action}`);
  }
  if (rows.length > 0) {
    deps.out(`해결: corepack pnpm ledger:resolve --owner ${owner} --ledger <위 id> --source provider|none --actual <금액> --settled <금액> --by '<누가>' --reason '<사유>'(미리보기 → 같은 명령 + --confirm)`);
  }
  return 0;
}
