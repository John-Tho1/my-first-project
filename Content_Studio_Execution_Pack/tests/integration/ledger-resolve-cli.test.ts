/**
 * FIX4-LIVEL1H2(4차 Claude 독립 검토 — Codex 아님): `pnpm ledger:resolve` 본체(runLedgerResolveCli).
 * 인계 LIVEL1 수동 해결 절차 4~6 의 손으로 쓴 SQL(FIX2·FIX3)을 대신한다 — 규칙은 복원 검사와 같은 함수(resolutionProblem·usageLedgerRowProblems).
 * FIX3 의 문서-SQL 시험(live-llm.test.ts)이 다루던 잘못 채운 경우·정정·고칠 수 없는 모양·bundle:check 미해결 수를 이 CLI 로 옮겨 같은 단언(행 그대로·다른 행 그대로)
 * 이상으로 다시 본다. DB 는 메모리 PGlite(시험 전용)와 임시 폴더의 파일 DB 뿐 — 실제 ./data·.env.local 을 열지 않는다. 가짜 fetch(Claude 어댑터) — 네트워크 0.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq } from 'drizzle-orm';
import {
  checkBundleZip,
  createContent,
  createDb,
  createRestorePreview,
  createTestDb,
  DbLockedError,
  ensureOwner,
  exportOwner,
  hasUnresolvedLiveUsage,
  openDb,
  parseLedgerResolveArgs,
  runAssist,
  runLedgerResolveCli,
  schema,
  type Db,
  type DbHandle,
  type LedgerResolveCliDeps,
} from '@cs/db';
import { budgetPolicy, loadConfig, toMicro, fromMicro } from '@cs/domain';
import { ClaudeLlmProvider, LocalStorageAdapter, MockLlmProvider } from '@cs/providers';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const TSX_CLI = path.join(APP, 'node_modules/tsx/dist/cli.mjs');
const RESOLVE_SCRIPT = path.join(APP, 'packages/db/scripts/ledger-resolve.ts');
const CHECK_SCRIPT = path.join(APP, 'packages/db/scripts/bundle-check.ts');
const DOC = path.join(APP, 'docs/handoffs/LIVEL1_IMPLEMENTATION_HANDOFF.md');

const KEY = 'sk-ant-FAKE-ledger-resolve-sentinel-3e1f';
const MODEL = 'claude-opus-5-5';
const APPROVAL = 'D34-ledger-resolve-approval-ref';
const LIVE = {
  LLM_MODE: 'live',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: MODEL,
  LLM_PRICE_INPUT_PER_1K: '0.004',
  LLM_PRICE_OUTPUT_PER_1K: '0.02',
  LLM_BUDGET_MONTHLY_LIMIT: '10',
  LLM_BUDGET_PER_RUN_MAX: '0.5',
  LLM_LIVE_APPROVAL_REF: APPROVAL,
} as const;
const policy = () => budgetPolicy(loadConfig({ ...LIVE }));
const draft = (budget = policy()) => ({ mode: 'draft' as const, baseVersion: 1, brandProfileVersion: 1, answerIds: [], budget });
const OVER_INT = { input_tokens: 2_147_483_648, output_tokens: 7 };
const NOW = new Date('2026-10-21T09:15:00.123Z');
const BY = 'op-sentinel-by-7f3';
const REASON = "reason-sentinel-9c2 콘솔 확인 — 운영자's 판단, 실제 청구 9.95 USD";

const modelOut = {
  proposed_text: '첫 미팅 전에 상대 회사의 최근 발표 자료를 읽어 두면 대화가 빨라집니다.',
  proposed_tags: ['해외영업'],
  claims: [{ text: '사전 조사가 대화를 빠르게 한다.', kind: 'opinion', source_refs: [], needs_user_confirmation: false }],
  followup_questions: [],
  warnings: [],
};
const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_01FAKEledger',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: JSON.stringify(modelOut) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  stop_details: null,
  usage: { input_tokens: 1500, output_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
});
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_011FAKEledger' } });
function fakeFetch(...responses: Array<() => Response>) {
  return (async () => {
    const r = responses.shift();
    if (!r) throw new Error('fake fetch: 준비된 응답 없음');
    return r();
  }) as unknown as typeof fetch;
}
const claude = (f: typeof fetch) => new ClaudeLlmProvider({ apiKey: KEY, model: MODEL, fetch: f });

let h: DbHandle;
let db: Db;
beforeAll(async () => {
  h = await createTestDb();
  db = h.db;
});
afterAll(async () => {
  await h.close();
});

// ---- 준비(db 를 인자로 — 임시 파일 DB 에도 같은 준비를 쓴다) ----
type Snap = Record<string, unknown> & { resolution: Record<string, unknown> };
async function freshOwner(dbX: Db, identity: string) {
  const owner = (await ensureOwner(dbX, identity)).id;
  await dbX.insert(schema.brandProfiles).values({ ownerId: owner, version: 1, penName: 'p', audience: 'a', pillars: ['x'] });
  return owner;
}
/** live 실행 한 번(가짜 fetch). 원장 id 를 돌려준다. */
async function liveRun(dbX: Db, owner: string, response: () => Response) {
  const c = await createContent(dbX, owner, { title: 'L', body: '본문.' });
  await runAssist(dbX, owner, c.content.id, draft(), claude(fakeFetch(response))).catch(() => undefined); // 실패 응답도 원장은 남는다
  const [run] = await dbX.select().from(schema.generationRuns).where(eq(schema.generationRuns.contentId, c.content.id));
  const [ledger] = await dbX.select().from(schema.usageLedger).where(eq(schema.usageLedger.runId, run!.id));
  return ledger!.id;
}
/** 모의 실행(usage_source estimate) */
async function mockRun(dbX: Db, owner: string) {
  const c = await createContent(dbX, owner, { title: 'M', body: '모의 본문.' });
  return (await runAssist(dbX, owner, c.content.id, { ...draft(), budget: undefined }, new MockLlmProvider())).ledger.id;
}
async function unstorableRun(dbX: Db, identity: string) {
  const owner = await freshOwner(dbX, identity);
  const ledgerId = await liveRun(dbX, owner, json(200, message({ usage: OVER_INT })));
  return { owner, ledgerId };
}
const rowOf = async (dbX: Db, id: string) => (await dbX.select().from(schema.usageLedger).where(eq(schema.usageLedger.id, id)))[0]!;
const setSnap = (dbX: Db, id: string, s: Record<string, unknown>) => dbX.update(schema.usageLedger).set({ pricingSnapshot: s }).where(eq(schema.usageLedger.id, id));
/** 같은 owner 에 provider_unstorable 원장을 하나 더(앞의 미해결 행들은 잠깐 출처를 바꿔 차단을 비켜 간 뒤 그대로 되돌린다). */
async function addUnstorable(dbX: Db, owner: string, response = json(200, message({ usage: OVER_INT }))) {
  const blocking = (await dbX.select().from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, owner))).filter(
    (r) => (r.pricingSnapshot as { usage_source?: string }).usage_source === 'provider_unstorable',
  );
  for (const r of blocking) await setSnap(dbX, r.id, { ...r.pricingSnapshot, usage_source: 'provider' });
  const id = await liveRun(dbX, owner, response);
  for (const r of blocking) await setSnap(dbX, r.id, r.pricingSnapshot);
  return id;
}
const ownerLedger = (owner: string) => db.select().from(schema.usageLedger).where(eq(schema.usageLedger.ownerId, owner)).orderBy(schema.usageLedger.id);
const resolveAudits = async () => (await db.select({ n: count() }).from(schema.auditEvents).where(eq(schema.auditEvents.action, 'usage_ledger.manual_resolve')))[0]!.n;
async function exportZip(dbX: Db, owner: string, tmp: string, tag: string) {
  const exported = await exportOwner(dbX, new LocalStorageAdapter(path.join(tmp, `assets-${tag}`)), owner, { outDir: path.join(tmp, `exports-${tag}`) });
  return new Uint8Array(readFileSync(exported.zipPath));
}
/** H1 시험과 같은 모양의 올바른 해결(손 작업) — 정정 시험의 출발점. */
async function handResolve(id: string, settled = '9.950000') {
  const r0 = await rowOf(db, id);
  const { reported_tokens_in, reported_tokens_out, reported_cost, ...rest } = r0.pricingSnapshot;
  const original = { reported_tokens_in, reported_tokens_out, reported_cost };
  const reserved = toMicro(r0.reservedAmount);
  const s = toMicro(settled);
  await db
    .update(schema.usageLedger)
    .set({
      pricingSnapshot: {
        ...rest,
        usage_source: 'provider',
        resolution: { resolved_at: '2026-10-10T12:00:00.000Z', resolved_by: 'operator', reason: '시험: 손 작업', settled_amount: settled, original_usage_source: 'provider_unstorable', original_reported: original },
      },
      actualAmount: settled,
      overageAmount: fromMicro(s > reserved ? s - reserved : 0n),
      overBudget: s > reserved,
    })
    .where(eq(schema.usageLedger.id, id));
  return { original };
}

// ---- CLI 호출 ----
type Fill = { owner: string; ledger: string; source: string; actual: string; settled: string; by: string; reason: string };
const fillFor = (ledger: string, owner: string): Fill => ({ owner, ledger, source: 'provider', actual: '9.950000', settled: '9.950000', by: BY, reason: REASON });
const argvOf = (f: Fill, ...flags: string[]) => [
  '--owner',
  f.owner,
  '--ledger',
  f.ledger,
  `--source=${f.source}`,
  `--actual=${f.actual}`,
  `--settled=${f.settled}`,
  `--by=${f.by}`,
  `--reason=${f.reason}`,
  ...flags,
];
const shared = async (): Promise<DbHandle> => ({ ...h, close: async () => undefined });
async function cli(argv: readonly string[], extra: Partial<LedgerResolveCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let opened = 0;
  const code = await runLedgerResolveCli({
    argv,
    env: { DATABASE_URL: 'memory://' },
    openDb: async (c) => {
      opened++;
      return (extra.openDb ?? shared)(c);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => NOW,
    ...(extra.beforeApply ? { beforeApply: extra.beforeApply } : {}),
    ...(extra.env ? { env: extra.env } : {}),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), opened };
}
const RESOLUTION_KEYS_SORTED = ['original_reported', 'original_usage_source', 'reason', 'resolved_at', 'resolved_by', 'settled_amount'];
/** JS String.prototype.trim() 이 지우는 BMP 문자 전부(서로게이트 제외) — 25개. 하나로 이어 붙이면 검사 집합에서 하나만 빠져도 드러난다. */
const TRIM_WS = Array.from({ length: 0x10000 }, (_, c) => String.fromCharCode(c))
  .filter((ch) => (ch < '\uD800' || ch > '\uDFFF') && ch.trim() === '')
  .join('');

describe('FIX4-LIVEL1H2 — ledger:resolve 인자(사용법 오류는 exit 2, DB 를 열지 않음)', () => {
  it.each<[string, string[]]>([
    ['인자 없음', []],
    ['--reason 빠짐', ['--owner', randomUUID(), '--ledger', randomUUID(), '--source', 'provider', '--actual', '1.000000', '--settled', '1.000000', '--by', 'x']],
    ['--owner 두 번', ['--owner', randomUUID(), '--owner', randomUUID(), '--list']],
    ['모르는 옵션', ['--list', '--force']],
    ['위치 인자', ['--list', 'x']],
    ['불리언에 값', ['--list', '--confirm=yes']],
    ['uuid 아님', ['--owner', 'abc', '--ledger', randomUUID(), '--source', 'provider', '--actual', '1.000000', '--settled', '1.000000', '--by', 'x', '--reason', 'y']],
    ['--list 와 해결 옵션', ['--list', '--ledger', randomUUID()]],
    ['값 자리에 다음 옵션(--by --confirm)', ['--owner', randomUUID(), '--ledger', randomUUID(), '--source', 'provider', '--actual', '1.000000', '--settled', '1.000000', '--reason', 'y', '--by', '--confirm']],
  ])('%s → exit 2, 사용법 출력, DB 열지 않음', async (_l, argv) => {
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.opened).toBe(0);
    expect(r.err).toContain('사용법');
    expect(r.out).toBe('');
  });

  it('--이름=값·대문자 uuid(소문자로)·앞의 -- 를 받는다', () => {
    const id = randomUUID();
    const p = parseLedgerResolveArgs(['--', `--owner=${id.toUpperCase()}`, '--ledger', id, '--source=none', '--actual=0.100000', '--settled', '0.100000', '--by=--x', '--reason=', '--correct']);
    expect(p).toEqual({ ok: true, args: { kind: 'resolve', owner: id, ledger: id, source: 'none', actual: '0.100000', settled: '0.100000', by: '--x', reason: '', correct: true, confirm: false } });
  });
});

describe('FIX4-LIVEL1H2 — 새 해결: 미리보기는 쓰지 않고, --confirm 은 정확히 1행·감사 1건, 묶음은 bundle:check·복원 미리보기 통과', () => {
  it('미리보기 → 적용 → 다시 실행은 --correct 요구, 같은 owner 의 다른 미해결 행·다른 owner 그대로, 출력에 값 없음', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-ok-'));
    try {
      const { owner, ledgerId: A } = await unstorableRun(db, 'fix4-lr-ok@example.local');
      const B = await addUnstorable(db, owner);
      const other = await unstorableRun(db, 'fix4-lr-ok-other@example.local');
      const otherBefore = await ownerLedger(other.owner);
      const backup = await exportZip(db, owner, tmp, 'backup');
      expect(await checkBundleZip(backup)).toMatchObject({ ok: true, unresolved_live_usage: 2 });
      const before = await ownerLedger(owner);
      const rowA = before.find((r) => r.id === A)!;
      const snapA0 = rowA.pricingSnapshot;
      expect(snapA0).toMatchObject({ usage_source: 'provider_unstorable', approval_ref: APPROVAL });
      const audits0 = await resolveAudits();

      // 미리보기: exit 0, 아무것도 바뀌지 않음
      const pv = await cli(argvOf(fillFor(A, owner)));
      expect(pv.code, pv.err).toBe(0);
      expect(pv.out).toContain('미리보기(아무것도 바꾸지 않음)');
      expect(pv.out).toContain(`대상: usage_ledger ${A} · owner ${owner}`);
      expect(pv.out).toContain('usage_source: provider_unstorable → provider');
      expect(pv.out).toContain(`actual_amount: ${rowA.reservedAmount} → 9.950000`);
      expect(pv.out).toContain(`overage_amount: ${rowA.overageAmount} → ${fromMicro(toMicro('9.950000') - toMicro(rowA.reservedAmount))} · over_budget: false → true`);
      expect(pv.out).toContain('settled_amount: 9.950000');
      expect(pv.out).toContain(`resolved_by ${BY.length}자 · reason ${REASON.length}자`);
      expect(pv.out).toContain('계속 막힘(이 owner 에 provider_unstorable 1행이 남음');
      expect(pv.out).not.toContain('updated');
      expect(await ownerLedger(owner)).toEqual(before);
      expect(await resolveAudits()).toBe(audits0);

      // 적용
      const ok = await cli(argvOf(fillFor(A, owner), '--confirm'));
      expect(ok.code, ok.err).toBe(0);
      expect(ok.out.split('\n')).toContain('updated 1');
      expect(ok.out).toContain('이 owner 의 새 live 호출: 계속 막힘(이 owner 에 provider_unstorable 1행이 남음');
      for (const r of [pv, ok]) {
        const text = r.out + r.err;
        for (const v of [String(snapA0.reported_cost), String(snapA0.reported_tokens_in), BY, 'reason-sentinel', APPROVAL, KEY, 'sk-ant', 'input_per_1k', '0.004000']) {
          expect(text.includes(v), v).toBe(false);
        }
      }
      const after = await ownerLedger(owner);
      expect(after.find((r) => r.id === B)).toEqual(before.find((r) => r.id === B));
      expect(await ownerLedger(other.owner)).toEqual(otherBefore);
      const rA = after.find((r) => r.id === A)!;
      const sA = rA.pricingSnapshot as Snap;
      expect(Object.keys(sA.resolution).sort()).toEqual(RESOLUTION_KEYS_SORTED);
      expect(sA.resolution).toEqual({
        resolved_at: NOW.toISOString(),
        resolved_by: BY,
        reason: REASON,
        settled_amount: '9.950000',
        original_usage_source: 'provider_unstorable',
        original_reported: { reported_tokens_in: snapA0.reported_tokens_in, reported_tokens_out: snapA0.reported_tokens_out, reported_cost: snapA0.reported_cost },
      });
      const { usage_source: _u, resolution: _r, ...restA } = sA;
      const { usage_source: _u0, reported_tokens_in: _a, reported_tokens_out: _b, reported_cost: _c, ...restA0 } = snapA0;
      void [_u, _r, _u0, _a, _b, _c];
      expect(restA).toEqual(restA0); // 스냅숏의 다른 키(approval_ref·가격 등) 그대로
      expect(sA.usage_source).toBe('provider');
      expect([rA.actualAmount, rA.overBudget, toMicro(rA.overageAmount)]).toEqual(['9.950000', true, toMicro('9.950000') - toMicro(rowA.reservedAmount)]);
      expect([rA.state, rA.failed, rA.tokensIn, rA.tokensOut, rA.settledAt, rA.createdAt, rA.reservedAmount]).toEqual([
        rowA.state,
        rowA.failed,
        rowA.tokensIn,
        rowA.tokensOut,
        rowA.settledAt,
        rowA.createdAt,
        rowA.reservedAmount,
      ]);
      // 감사 1건(값 없는 요약)
      expect(await resolveAudits()).toBe(audits0 + 1);
      const [audit] = await db
        .select()
        .from(schema.auditEvents)
        .where(and(eq(schema.auditEvents.action, 'usage_ledger.manual_resolve'), eq(schema.auditEvents.entityId, A)));
      expect(audit).toMatchObject({ ownerId: owner, entity: 'usage_ledger' });
      expect(audit!.sanitizedDetails).toEqual({
        mode: 'resolve',
        half_finished: false,
        current_row_valid: null,
        usage_source_before: 'provider_unstorable',
        usage_source_after: 'provider',
        reserved_amount: rowA.reservedAmount,
        actual_amount_before: rowA.actualAmount,
        actual_amount_after: '9.950000',
        settled_amount: '9.950000',
        resolved_by_length: BY.length,
        reason_length: REASON.length,
        live_blocked_after: true,
      });
      expect(JSON.stringify(audit)).not.toContain('sentinel');
      expect(await hasUnresolvedLiveUsage(db, owner)).toBe(true); // B 가 남아 있다

      // 같은 명령 다시(이미 해결) → --correct 요구, 그대로
      const again = await cli(argvOf(fillFor(A, owner), '--confirm'));
      expect(again.code).toBe(1);
      expect(again.err).toContain('거부(needs_correct)');
      expect(await ownerLedger(owner)).toEqual(after);
      const mid = await exportZip(db, owner, tmp, 'mid');
      expect(await checkBundleZip(mid)).toMatchObject({ ok: true, unresolved_live_usage: 1 });

      // B: none(예약액 유지 — actual = settled = 예약액) → 모두 해결, 차단 해제
      const reservedB = before.find((r) => r.id === B)!.reservedAmount;
      const okB = await cli(argvOf({ ...fillFor(B, owner), source: 'none', actual: reservedB, settled: reservedB }, '--confirm'));
      expect(okB.code, okB.err).toBe(0);
      expect(okB.out).toContain('이 owner 의 새 live 호출: 열림');
      const rB = await rowOf(db, B);
      expect([(rB.pricingSnapshot as Snap).usage_source, rB.actualAmount, toMicro(rB.overageAmount), rB.overBudget]).toEqual(['none', reservedB, 0n, false]);
      expect(await hasUnresolvedLiveUsage(db, owner)).toBe(false);
      const fin = await exportZip(db, owner, tmp, 'final');
      expect(await checkBundleZip(fin)).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      const t = await createTestDb();
      try {
        const target = (await ensureOwner(t.db, 'restore-fix4-lr-ok@example.local')).id;
        const pvr = await createRestorePreview(t.db, target, fin, { restoresDir: path.join(tmp, 'restores'), source: 'upload' });
        expect(pvr.preview.tables.usage_ledger).toMatchObject({ in_bundle: 2, new: 2 });
      } finally {
        await t.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('경계 길이(resolved_by UTF-16 200 = 이모지 100, reason 앞뒤 공백 포함 4000)·5단계 상한(settled > actual > 예약)·열 최대값 + 40자리 실제 청구 → 1행, 묶음 통과', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-edge-'));
    try {
      const cases: Array<[string, Partial<Fill>]> = [
        ['경계 길이', { by: '😀'.repeat(100), reason: ' ' + 'r'.repeat(3998) + ' ' }],
        ['5단계 상한(월 한도 10)', { actual: '10.000000', settled: '25.000000' }],
        ['열 최대값 + 40자리 청구', { actual: '999999999999.999999', settled: '1' + '0'.repeat(39) + '.000000' }],
      ];
      for (const [i, [label, over]] of cases.entries()) {
        const { owner, ledgerId } = await unstorableRun(db, `fix4-lr-edge-${i}@example.local`);
        const r = await cli(argvOf({ ...fillFor(ledgerId, owner), ...over }, '--confirm'));
        expect(r.code, `${label}: ${r.err}`).toBe(0);
        const row = await rowOf(db, ledgerId);
        expect(row.actualAmount, label).toBe(over.actual ?? '9.950000');
        expect((row.pricingSnapshot as Snap).resolution, label).toMatchObject({ settled_amount: over.settled ?? '9.950000', resolved_by: over.by ?? BY });
        expect(await checkBundleZip(await exportZip(db, owner, tmp, `e${i}`)), label).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('FIX4-LIVEL1H2 — 검증기가 거부하는 채움은 모두 exit 1, 행·다른 행·감사 그대로(FIX3 의 잘못 채운 32종 + 4차 검토 #1·#10)', () => {
  it('잘못 채움 표(미리보기·--confirm 모두)', async () => {
    const { owner, ledgerId: A } = await unstorableRun(db, 'fix4-lr-wrong@example.local');
    await addUnstorable(db, owner);
    const other = await unstorableRun(db, 'fix4-lr-wrong-other@example.local');
    const otherBefore = await ownerLedger(other.owner);
    const before = await ownerLedger(owner);
    const reservedA = before.find((r) => r.id === A)!.reservedAmount;
    expect(toMicro(reservedA) < toMicro('9.950000')).toBe(true);
    expect(TRIM_WS).toHaveLength(25);
    const audits0 = await resolveAudits();
    const good = fillFor(A, owner);
    const wrong: Array<[string, Partial<Fill>, string]> = [
      ['settled 소수 2자리', { settled: '9.95' }, 'resolution:settled_amount'],
      ['settled 앞자리 0', { settled: '09.950000' }, 'resolution:settled_amount'],
      ['settled 소수 7자리', { settled: '9.9500000' }, 'resolution:settled_amount'],
      ['settled 숫자 아님', { settled: 'abc' }, 'resolution:settled_amount'],
      ['settled 빈 값', { settled: '' }, 'resolution:settled_amount'],
      ['settled 41자리', { actual: '999999999999.999999', settled: '1' + '0'.repeat(40) + '.000000' }, 'resolution:settled_amount'],
      // 4차 검토 #1(a)(c): 소수점이 빠지거나 지수 형식 — 손 SQL 이 문자열 처리에 따라 1행이 되던 채움
      ['settled 소수점 빠짐(99500000, actual 9.950000)', { settled: '99500000' }, 'resolution:settled_amount'],
      ['settled 소수점 빠짐(9950000)', { settled: '9950000' }, 'resolution:settled_amount'],
      ['settled 지수(1e000005, actual 100000.000000)', { settled: '1e000005', actual: '100000.000000' }, 'resolution:settled_amount'],
      ['settled 지수(9.95e0)', { settled: '9.95e0' }, 'resolution:settled_amount'],
      // #1(b): actual 과 settled 모두 소수점 빠짐 — 검증기만으로는 같은 값이라 통과하므로 CLI 의 actual 형식 규칙이 막는다
      ['actual = settled 소수점 빠짐(19950000)', { actual: '19950000', settled: '19950000' }, 'actual_format'],
      ['actual 소수점 빠짐 + settled 정규형(같은 값)', { actual: '9950000', settled: '9950000.000000' }, 'actual_format'],
      ['actual 지수', { actual: '1e5', settled: '100000.000000' }, 'actual_format'],
      ['actual 소수 2자리', { actual: '9.95' }, 'actual_format'],
      ['actual 음수', { actual: '-9.950000' }, 'actual_format'],
      ['actual 앞자리 0', { actual: '09.950000' }, 'actual_format'],
      ['actual 쉼표', { actual: '9,950000' }, 'actual_format'],
      ['actual 앞 공백', { actual: ' 9.950000' }, 'actual_format'],
      ['actual 정수부 13자리(열 범위 밖)', { actual: '1234567890123.000000', settled: '1234567890123.000000' }, 'actual_format'],
      ['settled < actual', { settled: '9.590000' }, 'resolution:settled_vs_actual'],
      ['settled ≠ actual 이고 상한 아님(actual = 예약액 — 재정산 누락)', { actual: reservedA }, 'resolution:settled_vs_actual'],
      ['출처 providers', { source: 'providers' }, 'resolution:usage_source'],
      ['출처 Provider', { source: 'Provider' }, 'resolution:usage_source'],
      ['출처 estimate', { source: 'estimate' }, 'resolution:usage_source'],
      ['출처 provider_unstorable', { source: 'provider_unstorable' }, 'resolution:usage_source'],
      ['출처 빈 값', { source: '' }, 'resolution:usage_source'],
      ['출처 estimate(actual = settled = 예약액)', { source: 'estimate', actual: reservedA, settled: reservedA }, 'resolution:usage_source'],
      ['출처 provider_unstorable(actual = settled = 예약액)', { source: 'provider_unstorable', actual: reservedA, settled: reservedA }, 'resolution:usage_source'],
      ['출처 providers(actual = settled = 예약액)', { source: 'providers', actual: reservedA, settled: reservedA }, 'resolution:usage_source'],
      ['none 인데 actual = settled ≠ 예약액', { source: 'none' }, 'none_actual'],
      ['none 인데 actual = 예약액, settled 만 큼', { source: 'none', actual: reservedA }, 'resolution:settled_vs_actual'],
      ['resolved_by 빈 값', { by: '' }, 'resolution:resolved_by'],
      ['resolved_by 공백', { by: '   ' }, 'resolution:resolved_by'],
      ['resolved_by 탭·줄바꿈', { by: '\t\n\r\v\f' }, 'resolution:resolved_by'],
      ['resolved_by 전각 공백·BOM·NBSP·줄 구분자', { by: '\u3000\uFEFF\u00A0\u2028\u2029\u202F' }, 'resolution:resolved_by'],
      ['resolved_by JS trim() 집합 전체(25자)', { by: TRIM_WS }, 'resolution:resolved_by'],
      ['resolved_by 201자', { by: 'o'.repeat(201) }, 'resolution:resolved_by'],
      ['resolved_by UTF-16 202(이모지 101개)', { by: '😀'.repeat(101) }, 'resolution:resolved_by'],
      ['reason 빈 값', { reason: '' }, 'resolution:reason'],
      ['reason 공백·줄바꿈', { reason: ' \n \u2028 \t' }, 'resolution:reason'],
      ['reason JS trim() 집합 전체(25자)', { reason: TRIM_WS }, 'resolution:reason'],
      ['reason 4001자', { reason: 'r'.repeat(4001) }, 'resolution:reason'],
      ['reason UTF-16 4002(이모지 2001개)', { reason: '😀'.repeat(2001) }, 'resolution:reason'],
      ['resolved_by NUL', { by: 'a\u0000b' }, 'text_encoding'],
      ['reason 짝 없는 서로게이트', { reason: 'x\uD800y' }, 'text_encoding'],
    ];
    for (const [label, over, code] of wrong) {
      for (const flags of [[], ['--confirm']]) {
        const r = await cli(argvOf({ ...good, ...over }, ...flags));
        expect(r.code, `${label} ${flags.join(' ')}`).toBe(1);
        expect(r.err, label).toContain(`거부(${code})`);
        expect(r.err, label).toContain('아무것도 바꾸지 않았습니다');
        expect(r.out, label).not.toContain('updated');
        expect(await ownerLedger(owner), label).toEqual(before);
        expect(await ownerLedger(other.owner), label).toEqual(otherBefore);
      }
    }
    // 대상 찾기: 없는 id·다른 owner 의 id → 0행, exit 1
    for (const [label, over] of [
      ['없는 ledger id', { ledger: randomUUID() }],
      ['대상 id 는 맞지만 다른 owner id', { owner: other.owner }],
      ['다른 owner 의 원장 id', { ledger: otherBefore[0]!.id }],
    ] as const) {
      const r = await cli(argvOf({ ...good, ...over }, '--confirm'));
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain('대상 행이 없습니다');
      expect(r.err, label).toContain('(0행)');
      expect(await ownerLedger(owner), label).toEqual(before);
      expect(await ownerLedger(other.owner), label).toEqual(otherBefore);
    }
    // 아직 해결되지 않은 행에 --correct → 거부
    const nc = await cli(argvOf(good, '--correct', '--confirm'));
    expect([nc.code, nc.err.includes('거부(not_resolved_yet)')]).toEqual([1, true]);
    // 행 상태 조건: settled 가 아닌 행은 고르지 않는다(시험 준비로만 잠깐 바꿨다가 되돌림)
    await db.update(schema.usageLedger).set({ state: 'reserved' }).where(eq(schema.usageLedger.id, A));
    const st = await cli(argvOf(good, '--confirm'));
    expect([st.code, st.err.includes('거부(state)')]).toEqual([1, true]);
    await db.update(schema.usageLedger).set({ state: 'settled' }).where(eq(schema.usageLedger.id, A));
    expect(await ownerLedger(owner)).toEqual(before);
    expect(await resolveAudits()).toBe(audits0);
    expect(await hasUnresolvedLiveUsage(db, owner)).toBe(true);
    // 대조: 같은 행에 맞게 채우면 1행(위 거부는 바꾼 값 때문이다)
    const ok = await cli(argvOf(good, '--confirm'));
    expect(ok.code, ok.err).toBe(0);
  });
});

describe('FIX4-LIVEL1H2 — 정정(--correct): resolution 이 이미 있는 행(FIX3 이전 문·H2 이전 손 작업). original_* 그대로', () => {
  it('깨진 해결 5변형 → --correct 없이는 거부, 잘못 채우면 거부, 맞게 채우면 1행·original_reported 그대로·묶음 통과', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-corr-'));
    try {
      const variants: Array<[string, (s: Snap) => void, boolean]> = [
        ['settled_amount "9.95"(FIX3 이전 문에 잘못 채움)', (s) => void (s.resolution.settled_amount = '9.95'), false],
        ['resolved_at +00:00·빈 resolved_by(H2 이전 손 작업)', (s) => void Object.assign(s.resolution, { resolved_at: '2026-10-10T12:00:00+00:00', resolved_by: ' ' }), false],
        ['usage_source providers(FIX3 이전 문 — 차단은 풀렸지만 복원 거부)', (s) => void (s.usage_source = 'providers'), false],
        ['재정산 누락(actual = 예약액, settled 9.95)', () => undefined, true],
        ['반쯤 끝남(provider_unstorable 그대로 + resolution, 최상위 reported_* 는 이미 옮김)', (s) => void (s.usage_source = 'provider_unstorable'), false],
      ];
      for (const [i, [label, mutate, keepReserved]] of variants.entries()) {
        const { owner, ledgerId } = await unstorableRun(db, `fix4-lr-corr-${i}@example.local`);
        const { original } = await handResolve(ledgerId);
        const r0 = await rowOf(db, ledgerId);
        const snap = structuredClone(r0.pricingSnapshot) as Snap;
        mutate(snap);
        await db
          .update(schema.usageLedger)
          .set({ pricingSnapshot: snap, ...(keepReserved ? { actualAmount: r0.reservedAmount, overageAmount: '0', overBudget: false } : {}) })
          .where(eq(schema.usageLedger.id, ledgerId));
        expect(await checkBundleZip(await exportZip(db, owner, tmp, `bad-${i}`)), label).toMatchObject({ ok: false, error: 'integrity' });
        const broken = await ownerLedger(owner);
        const good = fillFor(ledgerId, owner);
        // --correct 없이는 거부(이미 해결 기록이 있는 행을 실수로 덮지 않게 — 4차 검토 #4)
        const nc = await cli(argvOf(good, '--confirm'));
        expect([nc.code, nc.err.includes('거부(needs_correct)')], label).toEqual([1, true]);
        expect(await ownerLedger(owner), label).toEqual(broken);
        // 잘못 채움(4~6 표의 대표 + 정정 문이 시험하지 않던 길이·none·state — 4차 검토 #8·#10)
        const wrongCorr: Array<[Partial<Fill>, string]> = [
          [{ settled: '9.95' }, 'resolution:settled_amount'],
          [{ settled: '99500000' }, 'resolution:settled_amount'],
          [{ actual: '19950000', settled: '19950000' }, 'actual_format'],
          [{ by: ' ' }, 'resolution:resolved_by'],
          [{ by: TRIM_WS }, 'resolution:resolved_by'],
          [{ by: 'o'.repeat(201) }, 'resolution:resolved_by'],
          [{ by: '😀'.repeat(101) }, 'resolution:resolved_by'],
          [{ reason: '' }, 'resolution:reason'],
          [{ reason: TRIM_WS }, 'resolution:reason'],
          [{ reason: 'r'.repeat(4001) }, 'resolution:reason'],
          [{ reason: '😀'.repeat(2001) }, 'resolution:reason'],
          [{ source: 'providers' }, 'resolution:usage_source'],
          [{ source: 'estimate', actual: r0.reservedAmount, settled: r0.reservedAmount }, 'resolution:usage_source'],
          [{ source: 'none' }, 'none_actual'],
          [{ actual: r0.reservedAmount }, 'resolution:settled_vs_actual'],
        ];
        for (const [over, code] of wrongCorr) {
          const r = await cli(argvOf({ ...good, ...over }, '--correct', '--confirm'));
          expect([r.code, r.err.includes(`거부(${code})`)], `${label} ${JSON.stringify(over).slice(0, 80)}`).toEqual([1, true]);
          expect(await ownerLedger(owner), label).toEqual(broken);
        }
        for (const over of [{ owner: randomUUID() }, { ledger: randomUUID() }]) {
          const r = await cli(argvOf({ ...good, ...over }, '--correct', '--confirm'));
          expect([r.code, r.err.includes('대상 행이 없습니다')], label).toEqual([1, true]);
        }
        await db.update(schema.usageLedger).set({ state: 'reserved' }).where(eq(schema.usageLedger.id, ledgerId));
        const st = await cli(argvOf(good, '--correct', '--confirm'));
        expect([st.code, st.err.includes('거부(state)')], label).toEqual([1, true]);
        await db.update(schema.usageLedger).set({ state: 'settled' }).where(eq(schema.usageLedger.id, ledgerId));
        expect(await ownerLedger(owner), label).toEqual(broken);
        // 미리보기는 지금 행이 거부 상태임을 보여 준다
        const pv = await cli(argvOf(good, '--correct'));
        expect(pv.code, pv.err).toBe(0);
        expect(pv.out).toContain('방식: 정정(--correct)');
        expect(pv.out).toContain('지금 행의 복원 검사: 거부(이 정정의 대상)');
        expect(await ownerLedger(owner), label).toEqual(broken);
        // 맞게 채우면 정확히 1행 — 바뀌는 것은 resolution 네 키·usage_source·금액 열뿐, original_* 그대로
        const done = await cli(argvOf(good, '--correct', '--confirm'));
        expect(done.code, `${label}: ${done.err}`).toBe(0);
        expect(done.out.split('\n')).toContain('updated 1');
        const r1 = await rowOf(db, ledgerId);
        const s1 = r1.pricingSnapshot as Snap;
        expect(Object.keys(s1.resolution).sort(), label).toEqual(RESOLUTION_KEYS_SORTED);
        expect(s1.resolution.original_reported, label).toEqual(original);
        expect(JSON.stringify(s1.resolution.original_reported)).toBe(JSON.stringify(snap.resolution.original_reported)); // 키 순서까지(jsonb 정규화 그대로)
        expect(s1.resolution.original_usage_source).toBe('provider_unstorable');
        expect(s1.resolution).toMatchObject({ resolved_by: BY, settled_amount: '9.950000', reason: REASON, resolved_at: NOW.toISOString() });
        expect(s1.usage_source).toBe('provider');
        const strip = ({ usage_source: _u, resolution: _r, ...rest }: Snap) => {
          void _u;
          void _r;
          return rest;
        };
        expect(strip(s1), label).toEqual(strip(snap)); // 스냅숏의 다른 키 그대로(reported_* 다시 생기지 않음)
        expect(Object.keys(s1).filter((k) => k.startsWith('reported_'))).toEqual([]);
        expect([r1.actualAmount, r1.overBudget, toMicro(r1.overageAmount)]).toEqual(['9.950000', true, toMicro('9.950000') - toMicro(r1.reservedAmount)]);
        expect([r1.state, r1.tokensIn, r1.tokensOut, r1.settledAt]).toEqual([r0.state, r0.tokensIn, r0.tokensOut, r0.settledAt]);
        expect(await hasUnresolvedLiveUsage(db, owner)).toBe(false);
        expect(await checkBundleZip(await exportZip(db, owner, tmp, `fixed-${i}`)), label).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('4차 검토 #4: 올바른 형제 행 — --list 가 어느 행이 거부되는지 보여 주고, 올바른 행은 --correct 없이는 못 고치며 미리보기가 "이미 올바른 행"이라고 경고한다. 지정한 행만 바뀐다', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-sib-'));
    try {
      const { owner, ledgerId: A } = await unstorableRun(db, 'fix4-lr-sibling@example.local');
      const B = await addUnstorable(db, owner);
      await handResolve(A); // A: 예전에 올바르게 해결
      await handResolve(B);
      const sB = structuredClone((await rowOf(db, B)).pricingSnapshot) as Snap;
      sB.resolution.settled_amount = '120.5'; // B: FIX2 시대 문으로 잘못 채움
      await setSnap(db, B, sB);
      expect(await checkBundleZip(await exportZip(db, owner, tmp, 'x'))).toMatchObject({ ok: false, error: 'integrity' });
      const list = await cli(['--list', '--owner', owner]);
      expect(list.code, list.err).toBe(0);
      const lineOf = (id: string) => list.out.split('\n').find((l) => l.includes(`usage_ledger ${id}`))!;
      expect(lineOf(A)).toContain('해결 기록 있음(복원 검사 통과) → 정정만(--correct)');
      expect(lineOf(B)).toContain('해결 기록 있음(복원 검사 거부) → 정정만(--correct)');
      const before = await ownerLedger(owner);
      // 운영자가 A 를 잘못 고름 + B 의 값으로 채움: --correct 없이는 거부
      const wrongPick = { ...fillFor(A, owner), actual: '120.500000', settled: '120.500000' };
      const nc = await cli(argvOf(wrongPick, '--confirm'));
      expect([nc.code, nc.err.includes('거부(needs_correct)'), nc.err.includes('--list')]).toEqual([1, true, true]);
      const pv = await cli(argvOf(wrongPick, '--correct'));
      expect(pv.code).toBe(0);
      expect(pv.out).toContain('지금 행의 복원 검사: 통과 — 이미 올바른 해결 기록이다');
      expect(await ownerLedger(owner)).toEqual(before);
      // 올바른 대상(B)을 정정 → B 만 바뀐다
      const ok = await cli(argvOf({ ...fillFor(B, owner), actual: '120.500000', settled: '120.500000' }, '--correct', '--confirm'));
      expect(ok.code, ok.err).toBe(0);
      const after = await ownerLedger(owner);
      expect(after.find((r) => r.id === A)).toEqual(before.find((r) => r.id === A));
      expect(await checkBundleZip(await exportZip(db, owner, tmp, 'y'))).toMatchObject({ ok: true, unresolved_live_usage: 0 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('FIX4-LIVEL1H2 — 4차 검토 #6: 반쯤 끝난 H2 이전 행(provider_unstorable + resolution + 최상위 reported_*)', () => {
  it('최상위 원래 보고값으로 새 해결(--correct 아님) → 1행·original_reported = 원래 최상위 값·묶음 통과. 버리면 안 되는 키·값이 있으면 거부', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-half-'));
    try {
      const partials: Array<[string, (top: Record<string, unknown>) => Record<string, unknown>]> = [
        ['H2 이전 4·5단계만(키 5개)', () => ({ resolved_at: '2026-10-01T00:00:00+00:00', resolved_by: 'op', reason: '4단계만', settled_amount: '9.95', original_usage_source: 'provider_unstorable' })],
        ['키 6개(옮긴 값이 최상위와 같음)', (top) => ({ resolved_at: '2026-10-01T00:00:00Z', resolved_by: 'op', reason: 'x', settled_amount: '9.950000', original_usage_source: 'provider_unstorable', original_reported: top })],
        ['빈 resolution', () => ({})],
      ];
      for (const [i, [label, partial]] of partials.entries()) {
        const { owner, ledgerId } = await unstorableRun(db, `fix4-lr-half-${i}@example.local`);
        const s0 = (await rowOf(db, ledgerId)).pricingSnapshot;
        const top = { reported_tokens_in: s0.reported_tokens_in, reported_tokens_out: s0.reported_tokens_out, reported_cost: s0.reported_cost };
        await setSnap(db, ledgerId, { ...s0, resolution: partial(top) });
        expect(await checkBundleZip(await exportZip(db, owner, tmp, `h${i}`)), label).toMatchObject({ ok: false, error: 'integrity', problems: ['usage_ledger.pricing_snapshot.resolution 형식'] });
        const list = await cli(['--list', '--owner', owner]);
        expect(list.out, label).toContain('→ 새 해결(--correct 없이 — 반쯤 끝난 기록을 다시 만듦)');
        const before = await ownerLedger(owner);
        const wc = await cli(argvOf(fillFor(ledgerId, owner), '--correct', '--confirm'));
        expect([wc.code, wc.err.includes('거부(not_resolved_yet)')], label).toEqual([1, true]);
        expect(await ownerLedger(owner)).toEqual(before);
        const pv = await cli(argvOf(fillFor(ledgerId, owner)));
        expect(pv.out, label).toContain('반쯤 끝난 해결 기록(provider_unstorable + resolution)을 최상위 원래 보고값으로 다시 만든다');
        const ok = await cli(argvOf(fillFor(ledgerId, owner), '--confirm'));
        expect(ok.code, `${label}: ${ok.err}`).toBe(0);
        const s1 = (await rowOf(db, ledgerId)).pricingSnapshot as Snap;
        expect(s1.resolution.original_reported, label).toEqual(top);
        expect(s1.resolution).toMatchObject({ resolved_by: BY, reason: REASON, resolved_at: NOW.toISOString(), settled_amount: '9.950000', original_usage_source: 'provider_unstorable' });
        expect(Object.keys(s1).filter((k) => k.startsWith('reported_'))).toEqual([]);
        const [audit] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, ledgerId));
        expect(audit!.sanitizedDetails).toMatchObject({ mode: 'resolve', half_finished: true });
        expect(await checkBundleZip(await exportZip(db, owner, tmp, `hf${i}`)), label).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      }
      // 옮길 수 없는 반쯤 끝난 모양 → 거부, 그대로
      const unsafe: Array<[string, (top: Record<string, unknown>) => unknown]> = [
        ['모르는 키(console_ref)', () => ({ resolved_by: 'op', console_ref: 'console-2026-10' })],
        ['최상위와 다른 original_reported', (top) => ({ original_reported: { ...top, reported_cost: '1.000000' } })],
        ['original_usage_source 가 provider', () => ({ original_usage_source: 'provider' })],
        ['resolution 이 문자열', () => 'resolved'],
        ['resolution 이 배열', () => []],
      ];
      const u = await unstorableRun(db, 'fix4-lr-half-unsafe@example.local');
      const base = (await rowOf(db, u.ledgerId)).pricingSnapshot;
      const top = { reported_tokens_in: base.reported_tokens_in, reported_tokens_out: base.reported_tokens_out, reported_cost: base.reported_cost };
      for (const [label, partial] of unsafe) {
        await setSnap(db, u.ledgerId, { ...base, resolution: partial(top) });
        const before = await ownerLedger(u.owner);
        for (const flags of [['--confirm'], ['--correct', '--confirm']]) {
          const r = await cli(argvOf(fillFor(u.ledgerId, u.owner), ...flags));
          expect([r.code, r.err.includes('거부(partial_resolution_unsafe)')], `${label} ${flags.join(' ')}`).toEqual([1, true]);
        }
        expect(await ownerLedger(u.owner), label).toEqual(before);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('FIX4-LIVEL1H2 — 고칠 수 없는 모양·대상 아님(값을 지어내지 않는다 — 4차 검토 #3 의 최상위 보고값 형식 포함)', () => {
  it('정정할 수 없는 resolution 9형태·최상위 보고값이 틀린 provider_unstorable·일반 행 → --correct 유무와 무관하게 exit 1, 그대로', async () => {
    const u = await unstorableRun(db, 'fix4-lr-unfixable@example.local');
    const pristine = structuredClone((await rowOf(db, u.ledgerId)).pricingSnapshot);
    await handResolve(u.ledgerId);
    const base = structuredClone((await rowOf(db, u.ledgerId)).pricingSnapshot) as Snap;
    const shapes: Array<[string, () => Record<string, unknown>, string]> = [
      ['resolution 에 다른 키(console_ref)', () => ({ ...base, resolution: { ...base.resolution, console_ref: 'c' } }), 'resolution_unfixable'],
      ['original_reported 없음(H2 이전 키 5개 예시)', () => ({ ...base, resolution: { ...base.resolution, original_reported: undefined } }), 'resolution_unfixable'],
      ['original_reported 키 하나 없음', () => ({ ...base, resolution: { ...base.resolution, original_reported: { ...(base.resolution.original_reported as object), reported_cost: undefined } } }), 'resolution_unfixable'],
      ['original_reported 비용이 숫자', () => ({ ...base, resolution: { ...base.resolution, original_reported: { ...(base.resolution.original_reported as object), reported_cost: 42.5 } } }), 'resolution_unfixable'],
      ['original_reported 토큰이 형식 밖', () => ({ ...base, resolution: { ...base.resolution, original_reported: { ...(base.resolution.original_reported as object), reported_tokens_in: '01' } } }), 'resolution_unfixable'],
      ['original_reported 에 다른 키', () => ({ ...base, resolution: { ...base.resolution, original_reported: { ...(base.resolution.original_reported as object), note: 'x' } } }), 'resolution_unfixable'],
      ['original_usage_source 다름', () => ({ ...base, resolution: { ...base.resolution, original_usage_source: 'provider' } }), 'resolution_unfixable'],
      ['최상위 reported_* 가 남음(옮기지 않고 복사)', () => ({ ...base, ...(base.resolution.original_reported as object) }), 'reported_misplaced'],
      ['resolution 이 객체가 아님', () => ({ ...base, resolution: 'resolved' }), 'resolution_unfixable'],
      // provider_unstorable 인데 최상위 보고값이 FIX4 형식이 아님 → original_reported 를 만들 수 없음
      ['provider_unstorable · reported_tokens_in "01"', () => ({ ...pristine, reported_tokens_in: '01' }), 'reported_invalid'],
      ['provider_unstorable · reported_cost 숫자 42.5', () => ({ ...pristine, reported_cost: 42.5 }), 'reported_invalid'],
      ['provider_unstorable · reported_cost "1.5"', () => ({ ...pristine, reported_cost: '1.5' }), 'reported_invalid'],
      ['provider_unstorable · reported_cost 없음', () => ({ ...pristine, reported_cost: undefined }), 'reported_invalid'],
      ['provider_unstorable · reported_tokens_out JSON null', () => ({ ...pristine, reported_tokens_out: null }), 'reported_invalid'],
      ['provider_unstorable · 보고값 모두 없음', () => ({ ...pristine, reported_tokens_in: undefined, reported_tokens_out: undefined, reported_cost: undefined }), 'reported_invalid'],
    ];
    for (const [label, make, code] of shapes) {
      await setSnap(db, u.ledgerId, JSON.parse(JSON.stringify(make())) as Record<string, unknown>); // undefined 키는 빠진다
      const before = await ownerLedger(u.owner);
      for (const flags of [['--confirm'], ['--correct', '--confirm'], []]) {
        const r = await cli(argvOf(fillFor(u.ledgerId, u.owner), ...flags));
        expect([r.code, r.err.includes(`거부(${code})`)], `${label} ${flags.join(' ')}: ${r.err}`).toEqual([1, true]);
      }
      expect(await ownerLedger(u.owner), label).toEqual(before);
    }
    // 대상 아님: 보통 provider 행·모의 estimate 행
    const owner = await freshOwner(db, 'fix4-lr-not-target@example.local');
    const plain = await liveRun(db, owner, json(200, message()));
    const mock = await mockRun(db, owner);
    for (const id of [plain, mock]) {
      const before = await ownerLedger(owner);
      const r = await cli(argvOf(fillFor(id, owner), '--confirm'));
      expect([r.code, r.err.includes('거부(not_target)')]).toEqual([1, true]);
      expect(await ownerLedger(owner)).toEqual(before);
    }
  });
});

describe('FIX4-LIVEL1H2 — 적용 트랜잭션의 compare-and-swap·DB 잠금·오류 출력', () => {
  it('미리보기 계산 뒤 행이 바뀌면(스냅숏·금액) 중단 — 바뀐 값 그대로, 감사 없음. 바뀌지 않으면 그대로 적용(대조)', async () => {
    for (const [label, change] of [
      ['스냅숏이 바뀜(다른 작업이 먼저 해결)', async (id: string) => setSnap(db, id, { ...(await rowOf(db, id)).pricingSnapshot, note: 'changed' })],
      ['actual_amount 가 바뀜', async (id: string) => db.update(schema.usageLedger).set({ actualAmount: '0.200000' }).where(eq(schema.usageLedger.id, id))],
      ['over_budget 이 바뀜', async (id: string) => db.update(schema.usageLedger).set({ overBudget: true }).where(eq(schema.usageLedger.id, id))],
      // UPDATE 의 값 조건(스냅숏·금액)에 없는 열 — 다시 읽은 행 전체 비교만이 잡는다
      ['settled_at 이 바뀜(값 조건 밖 열)', async (id: string) => db.update(schema.usageLedger).set({ settledAt: new Date('2026-01-01T00:00:00.000Z') }).where(eq(schema.usageLedger.id, id))],
    ] as const) {
      const { owner, ledgerId } = await unstorableRun(db, `fix4-lr-cas-${randomUUID()}@example.local`);
      const audits0 = await resolveAudits();
      let changed: Awaited<ReturnType<typeof ownerLedger>> = [];
      const r = await cli(argvOf(fillFor(ledgerId, owner), '--confirm'), {
        beforeApply: async () => {
          await change(ledgerId);
          changed = await ownerLedger(owner);
        },
      });
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain('거부(changed)');
      expect(r.out, label).not.toContain('updated');
      expect(await ownerLedger(owner), label).toEqual(changed);
      expect(await resolveAudits(), label).toBe(audits0);
    }
    const { owner, ledgerId } = await unstorableRun(db, 'fix4-lr-cas-control@example.local');
    const ok = await cli(argvOf(fillFor(ledgerId, owner), '--confirm'), { beforeApply: async () => undefined });
    expect(ok.code, ok.err).toBe(0);
  });

  it('DB 잠금(dev 서버가 열고 있음) → 잠금 안내 exit 1 / 예상하지 못한 오류는 종류·코드만 / DB 닫기 실패 exit 1', async () => {
    const locked = await cli(['--list'], {
      openDb: async () => {
        throw new DbLockedError(999999);
      },
    });
    expect(locked.code).toBe(1);
    expect(locked.err).toContain('PGlite 데이터 디렉터리를 다른 프로세스(PID 999999)가 사용 중입니다');
    const boom = await cli(argvOf(fillFor(randomUUID(), randomUUID()), '--confirm'), {
      openDb: async () => {
        throw Object.assign(new Error(`connection failed ${KEY} ${BY}`), { code: '28P01' });
      },
    });
    expect(boom.code).toBe(1);
    expect(boom.err).toContain('오류 종류: Error(28P01)');
    for (const v of [KEY, BY, 'connection failed']) expect(boom.err.includes(v), v).toBe(false);
    const closeFail = await cli(['--list', '--owner', randomUUID()], {
      openDb: async () => ({
        ...h,
        close: async () => {
          throw new TypeError(`x ${KEY}`);
        },
      }),
    });
    expect(closeFail.code).toBe(1);
    expect(closeFail.err).toContain('DB 를 닫지 못했습니다(오류 종류: TypeError)');
    expect(closeFail.err).not.toContain(KEY);
  });
});

describe('FIX4-LIVEL1H2 — --list(읽기 전용, 절차 2): 후보 행·처리 방식·보고값', () => {
  it('provider_unstorable·해결 기록 행만, 처리 방식, 보고값(절차 3 비교용)·run 상태 — 승인 기록·키 없음, 아무것도 쓰지 않음. --owner 없으면 AUTH_ALLOWED_IDENTITY', async () => {
    const identity = 'fix4-lr-list@example.local';
    const { owner, ledgerId: U } = await unstorableRun(db, identity);
    const failedU = await addUnstorable(db, owner, json(200, message({ stop_reason: 'refusal', usage: OVER_INT })));
    const R = await addUnstorable(db, owner);
    await handResolve(R);
    const s = (await rowOf(db, U)).pricingSnapshot;
    const before = await ownerLedger(owner);
    const audits0 = await resolveAudits();
    const r = await cli(['--list'], { env: { DATABASE_URL: 'memory://', AUTH_ALLOWED_IDENTITY: identity } });
    expect(r.code, r.err).toBe(0);
    const lines = r.out.split('\n');
    expect(lines[0]).toBe('원장 수동 해결 대상 목록(읽기 전용 — 아무것도 바꾸지 않음)');
    expect(lines[1]).toBe(`owner ${owner} · 후보 3행 · 아직 provider_unstorable 2행(0 이면 새 live 호출이 열려 있음)`);
    const lineOf = (id: string) => lines.find((l) => l.includes(`usage_ledger ${id}`))!;
    expect(lineOf(U)).toContain(`보고값 tokens_in ${s.reported_tokens_in} · tokens_out ${s.reported_tokens_out} · cost ${s.reported_cost}`);
    expect(lineOf(U)).toMatch(/status succeeded · error -\).*usage_source provider_unstorable.*→ 새 해결\(--correct 없이\)$/);
    expect(lineOf(failedU)).toMatch(/failed true · run \S+\(status failed · error llm_refusal\)/);
    expect(lineOf(R)).toContain('usage_source provider · 해결 기록 있음(복원 검사 통과) → 정정만(--correct)');
    expect(lines.at(-1)).toContain(`corepack pnpm ledger:resolve --owner ${owner} --ledger <위 id>`);
    for (const v of [APPROVAL, KEY, 'sk-ant', '시험: 손 작업', 'operator']) expect(r.out.includes(v), v).toBe(false);
    expect(await ownerLedger(owner)).toEqual(before);
    expect(await resolveAudits()).toBe(audits0);
    // 같은 결과를 --owner 로
    expect((await cli(['--list', '--owner', owner])).out).toBe(r.out);
    // 없는 owner·허용 사용자 없음 → exit 1
    const none = await cli(['--list', '--owner', randomUUID()]);
    expect([none.code, none.err.includes('가 이 DB 에 없습니다')]).toEqual([1, true]);
    const noIdentity = await cli(['--list'], { env: { DATABASE_URL: 'memory://', AUTH_ALLOWED_IDENTITY: 'nobody-here@example.local' } });
    expect([noIdentity.code, noIdentity.err.includes('AUTH_ALLOWED_IDENTITY')]).toEqual([1, true]);
  });
});

describe('FIX4-LIVEL1H2 — 4차 검토 #7: bundle:check 미해결 수는 세지 말아야 할 행을 건너뛴다', () => {
  it('보통 provider·none(실패)·모의 estimate·usage_source 없는 이전 행·해결한 provider/none 행은 세지 않고, provider_unstorable 은 성공·실패(failed=true) 모두 센다 — 2 → 1 → 0, 스크립트 출력도 같은 수·값 없음', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-count-'));
    try {
      const owner = await freshOwner(db, 'fix4-lr-count@example.local');
      const plain = await liveRun(db, owner, json(200, message()));
      const noneFail = await liveRun(db, owner, json(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }));
      const estimate = await mockRun(db, owner);
      const legacy = await mockRun(db, owner);
      const { usage_source: _drop, ...legacySnap } = (await rowOf(db, legacy)).pricingSnapshot;
      void _drop;
      await setSnap(db, legacy, legacySnap);
      const U1 = await addUnstorable(db, owner);
      const U2 = await addUnstorable(db, owner, json(200, message({ stop_reason: 'refusal', usage: OVER_INT })));
      const kinds = Object.fromEntries((await ownerLedger(owner)).map((r) => [r.id, [(r.pricingSnapshot as { usage_source?: string }).usage_source ?? '(없음)', r.failed]]));
      expect([kinds[plain], kinds[noneFail], kinds[estimate], kinds[legacy], kinds[U1], kinds[U2]]).toEqual([
        ['provider', false],
        ['none', true],
        ['estimate', false],
        ['(없음)', false],
        ['provider_unstorable', false],
        ['provider_unstorable', true],
      ]);
      const backup = await exportZip(db, owner, tmp, 'backup');
      expect(await checkBundleZip(backup)).toMatchObject({ ok: true, rows: { usage_ledger: 6 }, unresolved_live_usage: 2 });
      expect((await cli(argvOf(fillFor(U1, owner), '--confirm'))).code).toBe(0);
      const mid = await exportZip(db, owner, tmp, 'mid');
      expect(await checkBundleZip(mid)).toMatchObject({ ok: true, rows: { usage_ledger: 6 }, unresolved_live_usage: 1 });
      const reserved2 = (await rowOf(db, U2)).reservedAmount;
      expect((await cli(argvOf({ ...fillFor(U2, owner), source: 'none', actual: reserved2, settled: reserved2 }, '--confirm'))).code).toBe(0);
      const fin = await exportZip(db, owner, tmp, 'final');
      expect(await checkBundleZip(fin)).toMatchObject({ ok: true, rows: { usage_ledger: 6 }, unresolved_live_usage: 0 });
      expect(await hasUnresolvedLiveUsage(db, owner)).toBe(false);
      const s1 = (await rowOf(db, U1)).pricingSnapshot as Snap;
      // 스크립트(pnpm bundle:check): stdout JSON 한 줄 + stderr 정보 줄(수만), exit 0, DB 폴더 만들지 않음, 값·id 없음
      const noDb = path.join(tmp, 'must-not-exist-pglite');
      for (const [tag, bytes, n] of [['backup', backup, 2], ['mid', mid, 1], ['final', fin, 0]] as const) {
        const file = path.join(tmp, `${tag}.zip`);
        writeFileSync(file, bytes);
        const r = spawnSync(process.execPath, [TSX_CLI, CHECK_SCRIPT, file], { cwd: APP, encoding: 'utf8', timeout: 120_000, env: { ...process.env, DATABASE_URL: noDb } });
        expect(r.status, r.stderr).toBe(0);
        const lines = r.stdout.trim().split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0]!)).toMatchObject({ action: 'bundle.check', ok: true, unresolved_live_usage: n });
        expect(r.stderr).toContain(`[bundle:check] 정보: 아직 해결되지 않은 live 사용량(usage_ledger.pricing_snapshot.usage_source=provider_unstorable) ${n}행`);
        for (const v of [String((s1.resolution.original_reported as Record<string, unknown>).reported_cost), '2147483648', U1, U2, owner, BY]) expect(r.stdout + r.stderr, tag).not.toContain(v);
      }
      expect(existsSync(noDb)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('FIX4-LIVEL1H2 — 인계 문서의 명령 그대로·실제 스크립트(임시 작업 폴더)', () => {
  const docText = () => readFileSync(DOC, 'utf8');
  /** 작은따옴표 묶음과 낱말만(문서 명령은 이 둘만 쓴다) */
  const words = (line: string) => [...line.matchAll(/'([^']*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]!));
  const docCommand = () => {
    const lines = docText()
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('corepack pnpm ledger:resolve --owner'));
    expect(lines, '문서에 해결 명령 틀이 정확히 한 줄').toHaveLength(1);
    const w = words(lines[0]!);
    expect(w.slice(0, 3)).toEqual(['corepack', 'pnpm', 'ledger:resolve']);
    return w.slice(3);
  };
  const fillDoc = (tpl: string[], v: Record<string, string>) =>
    tpl.map((t) => {
      let out = t;
      for (const [k, val] of Object.entries(v)) out = out.split(`<${k}>`).join(val);
      expect(out, '모든 자리표시를 채웠다').not.toMatch(/<[A-Z_]+>/);
      return out;
    });

  it('문서: 손 SQL 블록이 없고, 해결 명령 틀(미리보기 → 같은 명령 + --confirm, 정정은 + --correct)이 실제 CLI 로 그대로 동작한다. README·package.json 도 같은 명령', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-doc-'));
    try {
      const doc = docText();
      expect(doc).not.toMatch(/```sql\n[ \t]*-- LIVEL1 수동 해결/); // FIX2·FIX3 의 손 SQL 블록은 다시 생기지 않는다
      expect(doc).not.toMatch(/\bupdate usage_ledger\b/i);
      expect(doc).toContain('corepack pnpm ledger:resolve --list');
      const tpl = docCommand();
      const { owner, ledgerId } = await unstorableRun(db, 'fix4-lr-doc@example.local');
      const values = { OWNER_ID: owner, LEDGER_ID: ledgerId, USAGE_SOURCE: 'provider', ACTUAL: '9.950000', SETTLED: '9.950000', RESOLVED_BY: 'operator', REASON: '콘솔 확인 — 실제 청구 9.95 USD' };
      const argv = fillDoc(tpl, values);
      const before = await ownerLedger(owner);
      const pv = await cli(argv);
      expect(pv.code, pv.err).toBe(0);
      expect(await ownerLedger(owner)).toEqual(before);
      const ok = await cli([...argv, '--confirm']);
      expect(ok.code, ok.err).toBe(0);
      expect((await rowOf(db, ledgerId)).pricingSnapshot).toMatchObject({ usage_source: 'provider', resolution: { reason: values.REASON, resolved_by: 'operator' } });
      expect(await checkBundleZip(await exportZip(db, owner, tmp, 'doc'))).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      const corr = await cli([...fillDoc(tpl, { ...values, REASON: '정정: 콘솔 재확인' }), '--correct', '--confirm']);
      expect(corr.code, corr.err).toBe(0);
      expect(((await rowOf(db, ledgerId)).pricingSnapshot as Snap).resolution.reason).toBe('정정: 콘솔 재확인');
      const readme = readFileSync(path.join(APP, 'README_KO.md'), 'utf8');
      expect(readme).toContain('pnpm ledger:resolve');
      const pkg = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      expect(pkg.scripts['ledger:resolve']).toBe('tsx packages/db/scripts/ledger-resolve.ts');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('실제 스크립트: 사용법 exit 2(DB 폴더 만들지 않음) · 다른 프로세스가 연 DB → 잠금 안내 exit 1 · 파일 DB 에서 미리보기 exit 0(무변경) → --confirm exit 0 "updated 1"', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-ws-'));
    try {
      // 임시 작업 폴더 = 워크스페이스 루트(.env.local 없음) — 실제 ./data·.env.local 을 읽지 않는다
      writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), 'packages: []\n');
      cpSync(path.join(APP, 'packages/db/drizzle'), path.join(ws, 'packages/db/drizzle'), { recursive: true });
      const dbDir = path.join(ws, 'data', 'pglite-ledger');
      const env = (extra: Record<string, string>) => {
        const e: Record<string, string | undefined> = { ...process.env, ...extra };
        delete e.AUTH_ALLOWED_IDENTITY;
        return e;
      };
      const run = (args: string[]) =>
        spawnSync(process.execPath, [TSX_CLI, RESOLVE_SCRIPT, ...args], { cwd: ws, encoding: 'utf8', timeout: 180_000, env: env({ DATABASE_URL: dbDir }) });
      const usage = run([]);
      expect(usage.status, usage.stderr).toBe(2);
      expect(usage.stderr).toContain('사용법');
      expect(existsSync(dbDir)).toBe(false);
      // 준비: 임시 파일 DB 에 미해결 행 하나(이 시험 프로세스가 열었다 닫는다)
      const fileDb = await openDb({ DB_DRIVER: 'pglite', DATABASE_URL: dbDir });
      let owner: string;
      let ledgerId: string;
      try {
        ({ owner, ledgerId } = await unstorableRun(fileDb.db, 'fix4-lr-script@example.local'));
      } finally {
        await fileDb.close();
      }
      // 다른 프로세스(이 시험 프로세스)가 같은 폴더를 열고 있으면 잠금 안내
      const holder = createDb({ driver: 'pglite', url: dbDir });
      try {
        const lockedRun = run(['--list', '--owner', owner]);
        expect(lockedRun.status).toBe(1);
        expect(lockedRun.stderr).toContain(`PGlite 데이터 디렉터리를 다른 프로세스(PID ${process.pid})가 사용 중입니다`);
      } finally {
        await holder.close();
      }
      const args = argvOf({ ...fillFor(ledgerId, owner), reason: '콘솔 확인 — 스크립트' });
      const pv = run(args);
      expect(pv.status, pv.stderr).toBe(0);
      expect(pv.stdout).toContain('미리보기(아무것도 바꾸지 않음)');
      const check1 = await openDb({ DB_DRIVER: 'pglite', DATABASE_URL: dbDir });
      try {
        expect(await hasUnresolvedLiveUsage(check1.db, owner)).toBe(true);
      } finally {
        await check1.close();
      }
      const ok = run([...args, '--confirm']);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout.split('\n')).toContain('updated 1');
      const check2 = await openDb({ DB_DRIVER: 'pglite', DATABASE_URL: dbDir });
      try {
        expect(await hasUnresolvedLiveUsage(check2.db, owner)).toBe(false);
        expect(((await rowOf(check2.db, ledgerId)).pricingSnapshot as Snap).resolution.reason).toBe('콘솔 확인 — 스크립트');
      } finally {
        await check2.close();
      }
      expect(readdirSync(ws).sort()).toEqual(['data', 'packages', 'pnpm-workspace.yaml']);
      expect(readdirSync(path.join(ws, 'data'))).toEqual(['pglite-ledger']);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 300_000);
});
