/**
 * FIX4-LIVEL1H2(4차 Claude 독립 검토 — Codex 아님): `pnpm ledger:resolve` 본체(runLedgerResolveCli).
 * 인계 LIVEL1 수동 해결 절차 4~6 의 손으로 쓴 SQL(FIX2·FIX3)을 대신한다 — 규칙은 복원 검사와 같은 함수(resolutionProblem·usageLedgerRowProblems).
 * FIX3 의 문서-SQL 시험(live-llm.test.ts)이 다루던 잘못 채운 경우·정정·고칠 수 없는 모양·bundle:check 미해결 수를 이 CLI 로 옮겨 같은 단언(행 그대로·다른 행 그대로)
 * 이상으로 다시 본다. DB 는 메모리 PGlite(시험 전용)와 임시 폴더의 파일 DB 뿐 — 실제 ./data·.env.local 을 열지 않는다. 가짜 fetch(Claude 어댑터) — 네트워크 0.
 * FIX5-LIVEL1H2(5차 Claude 독립 검토 — Codex 아님): 확인 지문(--expect)·이미 올바른 행(already_valid)·by/reason 이스케이프 표시·셸 위험 문자(text_shell_unsafe)·
 * DB 폴더 없음·1단계 내보내기 범위(owner_not_exported)·원자성(시험이 만든 plpgsql 트리거)·UPDATE 값 조건(큰 수)·실패할 수 있는 비밀 누출 단언.
 * 모든 CLI 호출은 실제 모양의 비밀(ANTHROPIC_API_KEY·SECRETS_MASTER_KEY·OIDC_CLIENT_SECRET)을 env 로 넘기고, 출력에 그 값이 없는지 매번 본다.
 * FIX6-LIVEL1H2(6차 Claude 독립 검토 — Codex 아님): 문서 명령 앞붙임 없음(`MSYS_NO_PATHCONV` 제거)·셸 문자 `& | < > ^`·`/` 로 시작하는 값 거부·기본 무시 문자 이스케이프
 * (명시한 코드 포인트 목록)·정정·--overwrite-valid·반쯤 끝난 행의 셸/인코딩 거부·`updated 1` 뒤 exit 1(커밋 뒤 확인·DB 닫기 실패)·1단계 기준값(--list 수)·
 * `overwrite_not_needed`·정정 전 settled_amount·resolved_at 표시와 감사.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, count, eq, sql } from 'drizzle-orm';
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
  LEDGER_RESOLVE_USAGE,
  ledgerResolutionFingerprint,
  openDb,
  parseLedgerResolveArgs,
  runAssist,
  runLedgerResolveCli,
  schema,
  selectBundleRows,
  type Db,
  type DbHandle,
  type LedgerResolveCliDeps,
} from '@cs/db';
import { budgetPolicy, isValidOidcClientSecret, loadConfig, readSecretKeyring, sha256Hex, stableStringify, toMicro, fromMicro, type LedgerBundleRow } from '@cs/domain';
import { ClaudeLlmProvider, LocalStorageAdapter, MockLlmProvider } from '@cs/providers';

const APP = fileURLToPath(new URL('../../', import.meta.url));
const TSX_CLI = path.join(APP, 'node_modules/tsx/dist/cli.mjs');
const RESOLVE_SCRIPT = path.join(APP, 'packages/db/scripts/ledger-resolve.ts');
const CHECK_SCRIPT = path.join(APP, 'packages/db/scripts/bundle-check.ts');
const DOC = path.join(APP, 'docs/handoffs/LIVEL1_IMPLEMENTATION_HANDOFF.md');

const KEY = 'sk-ant-FAKE-ledger-resolve-sentinel-3e1f';
/** FIX5(5차 검토 #7): CLI 가 실제로 받는 비밀 — 형식도 앱이 받는 그대로(마스터 키 = base64 32바이트, OIDC 시크릿 = 공백 없는 1~1024자) */
const MASTER_KEY = Buffer.from('ledger-resolve-master-key-32byte', 'utf8').toString('base64');
const OIDC_SECRET = 'oidc-client-secret-FAKE-ledger-resolve-5d1';
const SECRET_ENV = { ANTHROPIC_API_KEY: KEY, SECRETS_MASTER_KEY: MASTER_KEY, OIDC_CLIENT_SECRET: OIDC_SECRET } as const;
const SECRET_VALUES = [KEY, 'sk-ant', MASTER_KEY, 'ledger-resolve-master-key', OIDC_SECRET];
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
const REASON_SENTINEL = 'reason-sentinel-9c2';
/** 미리보기가 없는(거부되는) 채움의 --confirm 에 붙이는 지문 — 계획 거부가 지문 비교보다 먼저 나와야 한다 */
const DUMMY_FP = '0000000000000000';
const CONFIRM_HEADER = '원장 수동 해결 — 적용(--confirm)';
const PREVIEW_HEADER = '원장 수동 해결 — 미리보기(원장 행·감사 기록은 바꾸지 않음)';

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
/**
 * 시험 도우미: argv 의 --owner 가 이 DB 의 owner 면 그 owner 를 1단계 내보내기 owner(AUTH_ALLOWED_IDENTITY)로 둔다 — 인계 절차가 그 owner 로 1~7단계를
 * 하는 것과 같다. 범위 밖 owner(owner_not_exported)는 env 로 AUTH_ALLOWED_IDENTITY 를 따로 넘겨 시험한다.
 */
async function exportedIdentityFor(argv: readonly string[]): Promise<string | undefined> {
  const i = argv.findIndex((a) => a === '--owner' || a.startsWith('--owner='));
  if (i === -1) return undefined;
  const v = argv[i]!.startsWith('--owner=') ? argv[i]!.slice('--owner='.length) : argv[i + 1];
  if (v === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return undefined;
  const [u] = await db.select({ identity: schema.users.allowedIdentity }).from(schema.users).where(eq(schema.users.id, v.toLowerCase()));
  return u?.identity;
}
type CliResult = { code: number; out: string; err: string };
/**
 * FIX5(5차 검토 #7): 모든 호출에서 — 비밀 값은 출력(stdout·stderr)에 없다. by·reason 표지(BY·REASON_SENTINEL)는 stderr 에 절대 없고, --list 에 절대 없으며,
 * stdout 에서는 계획이 통과한 미리보기·적용 칸의 `resolved_by:`·`reason:` 줄에만 있다. 0 이 아닌 종료에서는 적용 칸을 출력하기 전에 거부된 경우(모든 거부·
 * 사용법·지문·범위·폴더) stdout 에도 없다 — 적용 칸을 출력한 뒤 트랜잭션이 실패한 경우(changed·verify·트리거)만 그 두 줄에 남는다.
 */
function assertNoLeak(r: CliResult, label: string, isList: boolean) {
  const text = `${r.out}\n${r.err}`;
  for (const v of SECRET_VALUES) expect(text.includes(v), `비밀 ${v.slice(0, 12)}… 가 출력에 있음 — ${label}`).toBe(false);
  for (const s of [BY, REASON_SENTINEL]) {
    expect(r.err.includes(s), `${s} 가 stderr 에 — ${label}`).toBe(false);
    const lines = r.out.split('\n').filter((l) => l.includes(s));
    if (isList || (r.code !== 0 && !r.out.startsWith(CONFIRM_HEADER))) expect(lines, `${s} 가 stdout 에 — ${label}`).toEqual([]);
    else for (const l of lines) expect(l.startsWith('resolved_by: ') || l.startsWith('reason: '), `${s} 는 resolved_by:·reason: 줄에만 — ${label}`).toBe(true);
  }
}
async function cli(argv: readonly string[], extra: Partial<LedgerResolveCliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let opened = 0;
  const identity = await exportedIdentityFor(argv);
  const code = await runLedgerResolveCli({
    argv,
    env: { DATABASE_URL: 'memory://', ...(identity ? { AUTH_ALLOWED_IDENTITY: identity } : {}), ...extra.env, ...SECRET_ENV },
    openDb: async (c) => {
      opened++;
      return (extra.openDb ?? shared)(c);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: extra.now ?? (() => NOW),
    ...(extra.beforeApply ? { beforeApply: extra.beforeApply } : {}),
  });
  const r = { code, out: out.join('\n'), err: err.join('\n'), opened };
  assertNoLeak(r, argv.join(' ').slice(0, 120), argv.includes('--list'));
  return r;
}
const fpOf = (out: string) => {
  const m = /^확인 지문: ([0-9a-f]{16})$/m.exec(out);
  expect(m, '미리보기에 확인 지문 줄').not.toBeNull();
  return m![1]!;
};
/** 인계 6단계 그대로: ① 미리보기 → ② 같은 명령 + 그 마지막 줄의 `--expect <지문> --confirm`. 미리보기가 거부되면 가짜 지문(같은 거부가 먼저 나와야 함). */
async function apply(argv: readonly string[], extra: Partial<LedgerResolveCliDeps> = {}) {
  const preview = await cli(argv, { ...extra, beforeApply: undefined });
  const fp = preview.code === 0 ? fpOf(preview.out) : DUMMY_FP;
  if (preview.code === 0) expect(preview.out.split('\n').at(-1)).toBe(`미리보기만 했습니다. 적용하려면 같은 명령 끝에 --expect ${fp} --confirm 을 붙입니다.`);
  const r = await cli([...argv, '--expect', fp, '--confirm'], extra);
  return { ...r, preview, fp };
}
/** 확인 지문을 CLI 와 따로 계산(공식 고정: v·owner·ledger·mode·correct·overwriteValid·지금 행(묶음 형식)·받은 입력 — resolved_at 없음) */
async function expectedFp(f: Fill, mode: 'resolve' | 'correct', flags: { correct?: boolean; overwriteValid?: boolean } = {}) {
  const [row] = await selectBundleRows(db, 'usage_ledger', sql`"usage_ledger"."id" = ${f.ledger}::uuid`);
  const current = row!.row;
  return sha256Hex(
    stableStringify({
      v: 1,
      owner: f.owner,
      ledger: f.ledger,
      mode,
      correct: flags.correct ?? false,
      overwriteValid: flags.overwriteValid ?? false,
      current,
      args: { source: f.source, actual: f.actual, settled: f.settled, by: f.by, reason: f.reason },
    }),
  ).slice(0, 16);
}
/** 대상 행의 DB 원문(jsonb·numeric 의 text 그대로 — JS 변환 없이) */
async function rawRow(id: string) {
  const res = await db.execute(
    sql`select pricing_snapshot::text as snap, actual_amount::text as actual, overage_amount::text as overage, over_budget as over, state from usage_ledger where id = ${id}::uuid`,
  );
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0]!;
}
const RESOLUTION_KEYS_SORTED = ['original_reported', 'original_usage_source', 'reason', 'resolved_at', 'resolved_by', 'settled_amount'];
/** JS String.prototype.trim() 이 지우는 BMP 문자 전부(서로게이트 제외) — 25개. 하나로 이어 붙이면 검사 집합에서 하나만 빠져도 드러난다. */
const TRIM_WS = Array.from({ length: 0x10000 }, (_, c) => String.fromCharCode(c))
  .filter((ch) => (ch < '\uD800' || ch > '\uDFFF') && ch.trim() === '')
  .join('');
/**
 * FIX6(6차 검토 #2): 미리보기·적용 칸이 반드시 \u 로 적어야 하는 코드 포인트 — 구현의 정규식을 베끼지 않은 **명시 목록**. 기본 무시 문자(한글 채움 U+3164·U+115F·
 * U+1160·U+FFA0, 결합 자소 결합자 U+034F, 변이 선택자 U+FE00·U+FE0F·U+E0100, 크메르 U+17B4, 몽골 변이 선택자 U+180B·U+180F)·폭 없는 공백·양방향 제어·
 * ESC·C1(CSI U+009B·NEL U+0085)·줄/문단 구분자·NBSP·전각 공백·SHY·BOM·BMP 밖 태그·사용자 영역.
 */
const MUST_ESCAPE = [
  0x3164, 0x115f, 0x1160, 0xffa0, 0x034f, 0xfe00, 0xfe0f, 0xe0100, 0x17b4, 0x180b, 0x180f, 0x200b, 0x202e, 0x2066, 0x001b, 0x009b, 0x0085, 0x2028, 0x2029, 0x00a0,
  0x3000, 0x00ad, 0xfeff, 0xe0041, 0xf0000,
];
/** 표시 형식(BMP 는 \uXXXX 소문자 4자리, BMP 밖은 \u{…}) */
const escOf = (cp: number) => (cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`);
/**
 * FIX6(6차 검토 #4): 제품 코드에 훅을 더하지 않고 "커밋 뒤" 를 재현하는 db 감싸개 — 적용 트랜잭션(transaction())이 커밋돼 끝난 뒤에만 afterCommit 을 부르고,
 * failSelects 이면 그 뒤의 select(커밋 뒤 차단 판정 다시 보기)를 실패시킨다. 트랜잭션이 되돌려지면(throw) 아무것도 하지 않는다.
 */
function dbAfterCommit(base: Db, afterCommit: (d: Db) => Promise<void>, failSelects: boolean): Db {
  let committed = false;
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'transaction') {
        return async (...args: unknown[]) => {
          const r: unknown = await (target.transaction as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          committed = true;
          await afterCommit(target);
          return r;
        };
      }
      if (prop === 'select' && failSelects && committed) {
        return () => {
          throw new TypeError('fix6-after-commit-select');
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const FULL = (): string[] => ['--owner', randomUUID(), '--ledger', randomUUID(), '--source', 'provider', '--actual', '1.000000', '--settled', '1.000000', '--by', 'x', '--reason', 'y'];
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
    // FIX5(5차 검토 #1·Q3): --confirm 은 미리보기의 --expect 지문과 함께만, --overwrite-valid 는 --correct 와 함께만
    ['--confirm 만(--expect 없음 — FIX4 에서는 적용됐다)', [...FULL(), '--confirm']],
    ['--correct --confirm(--expect 없음)', [...FULL(), '--correct', '--confirm']],
    ['--expect 만(--confirm 없음)', [...FULL(), '--expect', 'abcdef0123456789']],
    ['--expect 15자리', [...FULL(), '--expect', 'a'.repeat(15), '--confirm']],
    ['--expect 17자리', [...FULL(), '--expect', 'a'.repeat(17), '--confirm']],
    ['--expect 16진수 아님', [...FULL(), '--expect', 'g'.repeat(16), '--confirm']],
    ['--expect 빈 값', [...FULL(), '--expect=', '--confirm']],
    ['--expect 두 번', [...FULL(), '--expect', 'a'.repeat(16), '--expect', 'a'.repeat(16), '--confirm']],
    ['--overwrite-valid 만(--correct 없음)', [...FULL(), '--overwrite-valid']],
    ['--overwrite-valid 에 값', [...FULL(), '--correct', '--overwrite-valid=yes']],
    ['--list 와 --expect', ['--list', '--expect', 'a'.repeat(16)]],
    ['--list 와 --overwrite-valid', ['--list', '--overwrite-valid']],
  ])('%s → exit 2, 사용법 출력, DB 열지 않음', async (_l, argv) => {
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.opened).toBe(0);
    expect(r.err).toContain('사용법');
    expect(r.out).toBe('');
  });

  it('FIX5(5차 검토 #7): 시험이 CLI 에 넘기는 비밀은 앱이 받는 형식 그대로다(마스터 키 = base64 32바이트, OIDC 시크릿 형식) — 누출 단언이 실제 모양의 값을 본다', () => {
    expect(readSecretKeyring({ SECRETS_MASTER_KEY: MASTER_KEY, SECRETS_KEY_VERSION: '1' }).ok).toBe(true);
    expect(isValidOidcClientSecret(OIDC_SECRET)).toBe(true);
    expect(Object.keys(SECRET_ENV).sort()).toEqual(['ANTHROPIC_API_KEY', 'OIDC_CLIENT_SECRET', 'SECRETS_MASTER_KEY']);
  });

  it('FIX6(6차 검토 #5·#1): 사용법의 명령 줄은 앞붙임 없이 corepack pnpm ledger:resolve 로 시작하고(MSYS_NO_PATHCONV 없음), 쓰지 않을 문자에 & | < > ^ 와 / 로 시작을 적는다', () => {
    expect(LEDGER_RESOLVE_USAGE).not.toContain('MSYS_NO_PATHCONV');
    const cmdLines = LEDGER_RESOLVE_USAGE.split('\n').filter((l) => l.includes('ledger:resolve'));
    expect(cmdLines).toHaveLength(2);
    for (const l of cmdLines) expect(l.startsWith('  corepack pnpm ledger:resolve --'), l).toBe(true);
    expect(LEDGER_RESOLVE_USAGE).toContain('" % \\ & | < > ^ 와 줄바꿈을 쓰지 않고 / 로 시작하지 않으며');
  });

  it('--이름=값·대문자 uuid(소문자로)·앞의 -- 를 받는다', () => {
    const id = randomUUID();
    const p = parseLedgerResolveArgs(['--', `--owner=${id.toUpperCase()}`, '--ledger', id, '--source=none', '--actual=0.100000', '--settled', '0.100000', '--by=--x', '--reason=', '--correct']);
    expect(p).toEqual({
      ok: true,
      args: { kind: 'resolve', owner: id, ledger: id, source: 'none', actual: '0.100000', settled: '0.100000', by: '--x', reason: '', correct: true, overwriteValid: false, confirm: false, expect: null },
    });
    // FIX5: --expect 는 대소문자 무관 → 소문자, --overwrite-valid 는 --correct 와 함께
    const q = parseLedgerResolveArgs([...argvOf(fillFor(id, id)), '--correct', '--overwrite-valid', '--expect=ABCDEF0123456789', '--confirm']);
    expect(q).toMatchObject({ ok: true, args: { correct: true, overwriteValid: true, confirm: true, expect: 'abcdef0123456789' } });
  });
});

describe('FIX4-LIVEL1H2 — 새 해결: 미리보기는 쓰지 않고, --confirm 은 정확히 1행·감사 1건, 묶음은 bundle:check·복원 미리보기 통과', () => {
  it('미리보기 → 적용(--expect 지문) → 다시 실행은 --correct 요구, 같은 owner 의 다른 미해결 행·다른 owner 그대로, by·reason 은 미리보기·적용 칸에만(이스케이프), 보고값·승인·키 없음', async () => {
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
      expect(pv.out.split('\n')[0]).toBe(PREVIEW_HEADER);
      expect(pv.out).toContain(`대상: usage_ledger ${A} · owner ${owner}`);
      expect(pv.out).toContain('usage_source: provider_unstorable → provider');
      expect(pv.out).toContain(`actual_amount: ${rowA.reservedAmount} → 9.950000`);
      expect(pv.out).toContain(`overage_amount: ${rowA.overageAmount} → ${fromMicro(toMicro('9.950000') - toMicro(rowA.reservedAmount))} · over_budget: false → true`);
      expect(pv.out).toContain('settled_amount: 9.950000');
      expect(pv.out).toContain(`resolved_by ${BY.length}자 · reason ${REASON.length}자`);
      // FIX5(5차 검토 #4·#5·Q1): 받은 by·reason 을 그대로(JSON 이스케이프) 보여 준다 — 쓰기 전에 셸이 바꾼 글을 볼 수 있게
      const pvLines = pv.out.split('\n');
      expect(pvLines).toContain(`resolved_by: ${JSON.stringify(BY)}`);
      expect(pvLines).toContain(`reason: ${JSON.stringify(REASON)}`);
      expect(pv.out).toContain('계속 막힘(이 owner 에 provider_unstorable 1행이 남음');
      expect(pv.out).not.toContain('updated');
      // FIX5(5차 검토 #1·Q2): 확인 지문 — 공식(따로 계산)과 같고, resolved_at(실행 시각)과 무관하며, 마지막 줄이 붙일 꼬리를 그대로 알려 준다
      const fp = fpOf(pv.out);
      expect(fp).toBe(await expectedFp(fillFor(A, owner), 'resolve'));
      expect(pvLines.at(-1)).toBe(`미리보기만 했습니다. 적용하려면 같은 명령 끝에 --expect ${fp} --confirm 을 붙입니다.`);
      expect(fpOf((await cli(argvOf(fillFor(A, owner)), { now: () => new Date('2027-01-01T00:00:00.000Z') })).out)).toBe(fp);
      expect(await ownerLedger(owner)).toEqual(before);
      expect(await resolveAudits()).toBe(audits0);

      // 적용(② = 같은 명령 + --expect <지문> --confirm)
      const ok = await cli(argvOf(fillFor(A, owner), '--expect', fp, '--confirm'));
      expect(ok.code, ok.err).toBe(0);
      const okLines = ok.out.split('\n');
      expect(okLines[0]).toBe(CONFIRM_HEADER);
      expect(okLines).toContain(`확인 지문: ${fp}`);
      expect(okLines).toContain('updated 1');
      expect(ok.out).toContain('이 owner 의 새 live 호출: 계속 막힘(이 owner 에 provider_unstorable 1행이 남음');
      // FIX4 의 "by·reason 값은 출력하지 않음" → FIX5: 미리보기·적용 칸의 두 줄에 정확히 한 번씩(이스케이프), stderr·다른 줄에는 없음(cli() 가 매번 확인)
      for (const r of [pv, ok]) {
        const lines = r.out.split('\n');
        expect(lines.filter((l) => l.includes(BY))).toEqual([`resolved_by: ${JSON.stringify(BY)}`]);
        expect(lines.filter((l) => l.includes(REASON_SENTINEL))).toEqual([`reason: ${JSON.stringify(REASON)}`]);
        // FIX6(FIX5 Q3): 새 해결의 칸은 그대로 — settled_amount 는 새 값 한 줄뿐, 정정 전 값·resolved_at 줄 없음(그 줄은 정정에만)
        expect(lines.filter((l) => /^(settled_amount|resolved_at):/.test(l))).toEqual(['settled_amount: 9.950000']);
        expect(r.err).toBe('');
        const text = r.out + r.err;
        for (const v of [String(snapA0.reported_cost), String(snapA0.reported_tokens_in), APPROVAL, KEY, 'sk-ant', 'input_per_1k', '0.004000']) {
          expect(text.includes(v), v).toBe(false);
        }
      }
      // --list 에는 by·reason 이 나오지 않는다(cli() 의 단언 + 직접)
      const lst = await cli(['--list', '--owner', owner]);
      expect(lst.code, lst.err).toBe(0);
      expect(lst.out).toContain(`usage_ledger ${A}`);
      for (const v of [BY, REASON_SENTINEL, '운영자']) expect(lst.out.includes(v), v).toBe(false);
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

      // 같은 명령 다시(이미 해결 — 같은 지문으로) → --correct 요구(지문 비교보다 먼저), 그대로
      const again = await cli(argvOf(fillFor(A, owner), '--expect', fp, '--confirm'));
      expect(again.code).toBe(1);
      expect(again.err).toContain('거부(needs_correct)');
      expect(again.out).toBe('');
      expect(await ownerLedger(owner)).toEqual(after);
      const mid = await exportZip(db, owner, tmp, 'mid');
      expect(await checkBundleZip(mid)).toMatchObject({ ok: true, unresolved_live_usage: 1 });

      // B: none(예약액 유지 — actual = settled = 예약액) → 모두 해결, 차단 해제
      const reservedB = before.find((r) => r.id === B)!.reservedAmount;
      const okB = await apply(argvOf({ ...fillFor(B, owner), source: 'none', actual: reservedB, settled: reservedB }));
      expect(okB.code, okB.err).toBe(0);
      expect(okB.out).toContain('이 owner 의 새 live 호출: 열림');
      const rB = await rowOf(db, B);
      expect([(rB.pricingSnapshot as Snap).usage_source, rB.actualAmount, toMicro(rB.overageAmount), rB.overBudget]).toEqual(['none', reservedB, 0n, false]);
      // 5차 검토 #9(옮기면서 빠진 단언): B 를 해결해도 이미 해결한 형제 A 와 다른 owner 는 그대로
      expect((await ownerLedger(owner)).find((r) => r.id === A)).toEqual(after.find((r) => r.id === A));
      expect(await ownerLedger(other.owner)).toEqual(otherBefore);
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
        const r = await apply(argvOf({ ...fillFor(ledgerId, owner), ...over }));
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
    // 운영자가 맞는 값으로 미리보기(지문) → 값을 잘못 고쳐 같은 지문으로 --confirm: 지문 비교보다 계획 거부(그 코드)가 먼저
    const goodPv = await cli(argvOf(good));
    expect(goodPv.code, goodPv.err).toBe(0);
    const goodFp = fpOf(goodPv.out);
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
      // FIX5(5차 검토 #4·#5): 셸 문자는 받지 않는다(복원 검사는 받지만 이 명령이 거부). FIX6(6차 검토 #1): 거부는 문자가 **도착했을 때만** 본다 —
      // 아래는 그 문자가 그대로 도착한 경우(in-process)이고, 셸이 확장·삭제한 경우(문자가 도착하지 않음)는 시험하지 않는다(표시 줄로 확인 — 인계 6단계)
      ['resolved_by 큰따옴표', { by: 'op "kim"' }, 'text_shell_unsafe'],
      ['resolved_by 퍼센트(%USERNAME%)', { by: '%USERNAME%' }, 'text_shell_unsafe'],
      ['resolved_by 역슬래시', { by: 'CORP\\op' }, 'text_shell_unsafe'],
      ['reason 큰따옴표', { reason: '콘솔 "확인"' }, 'text_shell_unsafe'],
      ['reason 퍼센트(%PATH% 글자 그대로 도착 — 확장은 시험하지 않음)', { reason: '콘솔 확인 %PATH%' }, 'text_shell_unsafe'],
      ['reason 퍼센트 하나(9.95% 할인)', { reason: '실제 청구 9.95% 할인' }, 'text_shell_unsafe'],
      ['reason 역슬래시(경로)', { reason: 'C:\\logs\\x.txt 확인' }, 'text_shell_unsafe'],
      // FIX6(6차 검토 #1): cmd.exe 연산자 & | < > ^ (Windows [미확인] — 따옴표 밖이면 프로그램이 시작하기 전에 동작)
      ['resolved_by 앰퍼샌드(&)', { by: 'kim & lee' }, 'text_shell_unsafe'],
      ['resolved_by 파이프(|)', { by: 'ops|kim' }, 'text_shell_unsafe'],
      ['reason 작다(<)', { reason: '청구 < 10 USD' }, 'text_shell_unsafe'],
      ['reason 크다(>)', { reason: '청구 > 9 USD' }, 'text_shell_unsafe'],
      ['reason 캐럿(^)', { reason: '2^31 토큰 넘음' }, 'text_shell_unsafe'],
      // FIX6(6차 검토 #5): / 로 시작하는 값(Git Bash 의 MSYS 가 POSIX 경로로 보고 바꾸는 모양 — 앞붙임 MSYS_NO_PATHCONV 대신 거부)
      ['resolved_by / 로 시작', { by: '/c/op' }, 'text_shell_unsafe'],
      ['resolved_by // 로 시작', { by: '//op' }, 'text_shell_unsafe'],
      ['reason / 로 시작', { reason: '/var/log 확인' }, 'text_shell_unsafe'],
      ['reason / 하나', { reason: '/' }, 'text_shell_unsafe'],
    ];
    for (const [label, over, code] of wrong) {
      for (const flags of [[], ['--expect', goodFp, '--confirm']]) {
        const r = await cli(argvOf({ ...good, ...over }, ...flags));
        expect(r.code, `${label} ${flags.join(' ')}`).toBe(1);
        expect(r.err, label).toContain(`거부(${code})`);
        expect(r.err, label).toContain('아무것도 바꾸지 않았습니다');
        expect(r.out, label).toBe(''); // FIX6: 계획 거부는 stdout 에 아무것도 내지 않는다(FIX5 까지는 'updated' 없음만)
        expect(await ownerLedger(owner), label).toEqual(before);
        expect(await ownerLedger(other.owner), label).toEqual(otherBefore);
      }
    }
    // FIX6 대조: / 가 처음이 아니면 받고, Git Bash 가 바꾼 뒤의 모양(C:/…)은 거부가 볼 수 없어 받는다 — 받은 그대로 표시(그 변형은 표시 줄로 본다, 인계 6단계).
    // 미리보기만(아무것도 안 바뀜)
    for (const over of [{ by: 'ops/kim', reason: '콘솔/청구 확인 (1/2)' }, { reason: 'C:/Program Files/Git/var/log 확인' }] as Array<Partial<Fill>>) {
      const r = await cli(argvOf({ ...good, ...over }));
      expect(r.code, `${JSON.stringify(over)}: ${r.err}`).toBe(0);
      const lines = r.out.split('\n');
      expect(lines).toContain(`resolved_by: ${JSON.stringify(over.by ?? BY)}`);
      expect(lines).toContain(`reason: ${JSON.stringify(over.reason ?? REASON)}`);
      expect(await ownerLedger(owner)).toEqual(before);
    }
    // 대상 찾기: 없는 id·다른 owner 의 id → 0행, exit 1
    for (const [label, over] of [
      ['없는 ledger id', { ledger: randomUUID() }],
      ['대상 id 는 맞지만 다른 owner id', { owner: other.owner }],
      ['다른 owner 의 원장 id', { ledger: otherBefore[0]!.id }],
    ] as const) {
      const r = await cli(argvOf({ ...good, ...over }, '--expect', goodFp, '--confirm'));
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain('대상 행이 없습니다');
      expect(r.err, label).toContain('(0행)');
      expect(await ownerLedger(owner), label).toEqual(before);
      expect(await ownerLedger(other.owner), label).toEqual(otherBefore);
    }
    // 아직 해결되지 않은 행에 --correct → 거부
    const nc = await cli(argvOf(good, '--correct', '--expect', goodFp, '--confirm'));
    expect([nc.code, nc.err.includes('거부(not_resolved_yet)')]).toEqual([1, true]);
    // 행 상태 조건: settled 가 아닌 행은 고르지 않는다(시험 준비로만 잠깐 바꿨다가 되돌림)
    await db.update(schema.usageLedger).set({ state: 'reserved' }).where(eq(schema.usageLedger.id, A));
    const st = await cli(argvOf(good, '--expect', goodFp, '--confirm'));
    expect([st.code, st.err.includes('거부(state)')]).toEqual([1, true]);
    await db.update(schema.usageLedger).set({ state: 'settled' }).where(eq(schema.usageLedger.id, A));
    expect(await ownerLedger(owner)).toEqual(before);
    expect(await resolveAudits()).toBe(audits0);
    expect(await hasUnresolvedLiveUsage(db, owner)).toBe(true);
    // 대조: 같은 행에 맞게 채우면(처음 미리보기의 지문 그대로) 1행 — 위 거부는 바꾼 값 때문이다
    const ok = await cli(argvOf(good, '--expect', goodFp, '--confirm'));
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out.split('\n')).toContain('updated 1');
  });
});

describe('FIX4-LIVEL1H2 — 정정(--correct): resolution 이 이미 있는 행(FIX3 이전 문·H2 이전 손 작업). original_* 그대로', () => {
  it('깨진 해결 6변형 → --correct 없이는 거부, --overwrite-valid 는 거부(overwrite_not_needed), 잘못 채우면 거부(셸·인코딩 포함), 맞게 채우면 1행·original_reported 그대로·묶음 통과. 미리보기·적용 칸과 감사는 정정 전 settled_amount·resolved_at 을 형식 검사 뒤에만', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-corr-'));
    try {
      const HAND_AT = '2026-10-10T12:00:00.000Z'; // handResolve 의 resolved_at
      // [이름, 깨뜨리기, 예약액 유지, FIX6: 정정 전 [settled_amount, resolved_at] 표시(형식 밖이면 값을 되풀이하지 않음)]
      const variants: Array<[string, (s: Snap) => void, boolean, [string, string]]> = [
        ['settled_amount "9.95"(FIX3 이전 문에 잘못 채움)', (s) => void (s.resolution.settled_amount = '9.95'), false, ['(형식 밖 값)', HAND_AT]],
        ['resolved_at +00:00·빈 resolved_by(H2 이전 손 작업)', (s) => void Object.assign(s.resolution, { resolved_at: '2026-10-10T12:00:00+00:00', resolved_by: ' ' }), false, ['9.950000', '(형식 밖 값)']],
        ['usage_source providers(FIX3 이전 문 — 차단은 풀렸지만 복원 거부)', (s) => void (s.usage_source = 'providers'), false, ['9.950000', HAND_AT]],
        ['재정산 누락(actual = 예약액, settled 9.95)', () => undefined, true, ['9.950000', HAND_AT]],
        ['반쯤 끝남(provider_unstorable 그대로 + resolution, 최상위 reported_* 는 이미 옮김)', (s) => void (s.usage_source = 'provider_unstorable'), false, ['9.950000', HAND_AT]],
        // FIX6(FIX5 Q3): 키가 없거나 문자열이 아닌 옛 값 — (없음)·(형식 밖 값)
        [
          'settled_amount 키 없음·resolved_at 숫자(H2 이전 손 작업)',
          (s) => {
            delete s.resolution.settled_amount;
            s.resolution.resolved_at = 1760097600000;
          },
          false,
          ['(없음)', '(형식 밖 값)'],
        ],
      ];
      for (const [i, [label, mutate, keepReserved, [settledBefore, resolvedAtBefore]]] of variants.entries()) {
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
        // --correct 없이는 거부(이미 해결 기록이 있는 행을 실수로 덮지 않게 — 4차 검토 #4) — 미리보기도 --confirm 도
        for (const flags of [[], ['--expect', DUMMY_FP, '--confirm']]) {
          const nc = await cli(argvOf(good, ...flags));
          expect([nc.code, nc.err.includes('거부(needs_correct)')], `${label} ${flags.join(' ')}`).toEqual([1, true]);
        }
        expect(await ownerLedger(owner), label).toEqual(broken);
        // 이 행은 복원 검사에서 거부되므로 --overwrite-valid 없이 정정한다(already_valid 아님) — 미리보기의 지문
        const pv = await cli(argvOf(good, '--correct'));
        expect(pv.code, `${label}: ${pv.err}`).toBe(0);
        const corrFp = fpOf(pv.out);
        expect(corrFp, label).toBe(await expectedFp(good, 'correct', { correct: true }));
        // FIX6(FIX5 Q3): 정정이 바꾸는 것 — settled_amount·resolved_at 의 전 → 후(전 값은 복원 형식일 때만). 형식 밖 원문·정정 전 by/reason 은 나오지 않는다
        const beforeLines = [`settled_amount: ${settledBefore} → 9.950000`, `resolved_at: ${resolvedAtBefore} → (실행 시각)`];
        expect(pv.out.split('\n').filter((l) => /^(settled_amount|resolved_at):/.test(l)), label).toEqual(beforeLines);
        for (const v of ['+00:00', '1760097600000', '"9.95"', '시험: 손 작업', 'operator']) expect(pv.out.includes(v), `${label}: ${v}`).toBe(false);
        // FIX6(FIX5 Q2): 이 행은 복원 검사에서 거부되므로 --overwrite-valid 는 거부 — 미리보기도 --confirm 도(지문 비교보다 먼저), stdout 비어 있음, 행 그대로
        for (const flags of [['--correct', '--overwrite-valid'], ['--correct', '--overwrite-valid', '--expect', corrFp, '--confirm']]) {
          const ov = await cli(argvOf(good, ...flags));
          expect([ov.code, ov.err.includes('거부(overwrite_not_needed)'), ov.err.includes('--overwrite-valid 를 빼고 --correct 만으로'), ov.out], `${label} ${flags.join(' ')}`).toEqual([
            1,
            true,
            true,
            '',
          ]);
        }
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
          // FIX6(6차 검토 #3): 셸·인코딩 거부는 정정에서도(새 해결 표와 같은 대표 + 6차의 & · / 로 시작)
          [{ reason: '실제 청구 9.95% 할인' }, 'text_shell_unsafe'],
          [{ by: 'CORP\\op' }, 'text_shell_unsafe'],
          [{ reason: '콘솔 "확인"' }, 'text_shell_unsafe'],
          [{ by: 'kim & lee' }, 'text_shell_unsafe'],
          [{ reason: '/var/log 확인' }, 'text_shell_unsafe'],
          [{ by: 'a\u0000b' }, 'text_encoding'],
          [{ reason: 'x\uD800y' }, 'text_encoding'],
        ];
        for (const [over, code] of wrongCorr) {
          const r = await cli(argvOf({ ...good, ...over }, '--correct', '--expect', corrFp, '--confirm'));
          const l = `${label} ${JSON.stringify(over).slice(0, 80)}`;
          expect([r.code, r.err.includes(`거부(${code})`), r.err.includes('아무것도 바꾸지 않았습니다')], l).toEqual([1, true, true]);
          expect(r.out, l).toBe(''); // FIX6: 계획 거부는 stdout 에 아무것도 내지 않는다
          expect(await ownerLedger(owner), label).toEqual(broken);
        }
        // 없는 owner(1단계 내보내기 owner 가 아님 — FIX5 #6, FIX4 에서는 "대상 행이 없습니다") · 없는 원장 id
        const noOwner = await cli(argvOf({ ...good, owner: randomUUID() }, '--correct', '--expect', corrFp, '--confirm'));
        expect([noOwner.code, noOwner.err.includes('거부(owner_not_exported)')], label).toEqual([1, true]);
        const noLedger = await cli(argvOf({ ...good, ledger: randomUUID() }, '--correct', '--expect', corrFp, '--confirm'));
        expect([noLedger.code, noLedger.err.includes('대상 행이 없습니다')], label).toEqual([1, true]);
        await db.update(schema.usageLedger).set({ state: 'reserved' }).where(eq(schema.usageLedger.id, ledgerId));
        const st = await cli(argvOf(good, '--correct', '--expect', corrFp, '--confirm'));
        expect([st.code, st.err.includes('거부(state)')], label).toEqual([1, true]);
        await db.update(schema.usageLedger).set({ state: 'settled' }).where(eq(schema.usageLedger.id, ledgerId));
        expect(await ownerLedger(owner), label).toEqual(broken);
        // 미리보기는 지금 행이 거부 상태임을 보여 준다
        expect(pv.out).toContain('방식: 정정(--correct)');
        expect(pv.out).toContain('지금 행의 복원 검사: 거부(이 정정의 대상)');
        expect(await ownerLedger(owner), label).toEqual(broken);
        // 맞게 채우면(처음 미리보기의 지문) 정확히 1행 — 바뀌는 것은 resolution 네 키·usage_source·금액 열뿐, original_* 그대로
        const audits0 = await resolveAudits();
        const done = await cli(argvOf(good, '--correct', '--expect', corrFp, '--confirm'));
        expect(done.code, `${label}: ${done.err}`).toBe(0);
        expect(done.out.split('\n')).toContain('updated 1');
        expect(done.out.split('\n').filter((l) => /^(settled_amount|resolved_at):/.test(l)), label).toEqual(beforeLines); // 적용 칸도 같은 전 → 후
        // FIX6(FIX5 Q3): 감사 전체(FIX5 까지는 정정의 감사를 toMatchObject 로만 봄) — 정정 전 settled_amount·resolved_at 은 형식 검사 뒤, by/reason 은 길이만
        expect(await resolveAudits(), label).toBe(audits0 + 1);
        const brokenRow = broken.find((r) => r.id === ledgerId)!;
        const [audit] = await db
          .select()
          .from(schema.auditEvents)
          .where(and(eq(schema.auditEvents.action, 'usage_ledger.manual_resolve'), eq(schema.auditEvents.entityId, ledgerId)));
        expect(audit!.sanitizedDetails, label).toEqual({
          mode: 'correct',
          half_finished: false,
          current_row_valid: false,
          usage_source_before: snap.usage_source,
          usage_source_after: 'provider',
          reserved_amount: brokenRow.reservedAmount,
          actual_amount_before: brokenRow.actualAmount,
          actual_amount_after: '9.950000',
          settled_amount: '9.950000',
          settled_amount_before: settledBefore,
          resolved_at_before: resolvedAtBefore,
          resolved_by_length: BY.length,
          reason_length: REASON.length,
          live_blocked_after: false,
        });
        for (const v of ['+00:00', '1760097600000', '시험: 손 작업', 'operator', 'sentinel']) expect(JSON.stringify(audit).includes(v), `${label}: 감사에 ${v}`).toBe(false);
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

  it('4차 검토 #4·5차 Q3: 올바른 형제 행 — --list 가 어느 행이 거부되는지 보여 주고, 올바른 행은 --correct 만으로는 못 고치며(already_valid — 미리보기도) --overwrite-valid 를 붙일 때만 경고와 함께 고친다. 지정한 행만 바뀐다', async () => {
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
      // FIX4 는 둘 다 "정정만(--correct)" → FIX5: 이미 통과하는 행은 --overwrite-valid 가 필요하다고 표시
      expect(lineOf(A)).toMatch(/해결 기록 있음\(복원 검사 통과\) → 정정만\(--correct --overwrite-valid — 이미 복원 검사 통과\)$/);
      expect(lineOf(B)).toMatch(/해결 기록 있음\(복원 검사 거부\) → 정정만\(--correct\)$/);
      const before = await ownerLedger(owner);
      const audits0 = await resolveAudits();
      // 운영자가 A 를 잘못 고름 + B 의 값으로 채움: --correct 없이는 거부
      const wrongPick = { ...fillFor(A, owner), actual: '120.500000', settled: '120.500000' };
      const nc = await cli(argvOf(wrongPick, '--expect', DUMMY_FP, '--confirm'));
      expect([nc.code, nc.err.includes('거부(needs_correct)'), nc.err.includes('--list')]).toEqual([1, true, true]);
      // FIX4 는 --correct 미리보기 exit 0(경고만) → FIX5(5차 Q3): --correct 만으로는 미리보기도 --confirm 도 거부(already_valid), A 그대로
      for (const flags of [['--correct'], ['--correct', '--expect', DUMMY_FP, '--confirm']]) {
        const av = await cli(argvOf(wrongPick, ...flags));
        expect([av.code, av.err.includes('거부(already_valid)'), av.err.includes('--overwrite-valid'), av.err.includes('--list')], flags.join(' ')).toEqual([1, true, true, true]);
        expect(av.out, flags.join(' ')).toBe('');
      }
      expect(await ownerLedger(owner)).toEqual(before);
      // --overwrite-valid 를 붙이면 미리보기가 "이미 올바른 기록을 덮어쓴다" 고 경고하고 지문을 준다(아직 아무것도 바뀌지 않음)
      const pvA = await cli(argvOf(wrongPick, '--correct', '--overwrite-valid'));
      expect(pvA.code, pvA.err).toBe(0);
      expect(pvA.out).toContain('지금 행의 복원 검사: 통과 — 이미 올바른 해결 기록을 덮어쓴다(--overwrite-valid)');
      // FIX6(FIX5 Q3): 무엇을 덮어쓰는지 — 올바른 행이라 정정 전 값이 그대로 보인다(정정 전 by/reason 은 안 보임)
      expect(pvA.out.split('\n').filter((l) => /^(settled_amount|resolved_at):/.test(l))).toEqual(['settled_amount: 9.950000 → 120.500000', 'resolved_at: 2026-10-10T12:00:00.000Z → (실행 시각)']);
      for (const v of ['시험: 손 작업', 'operator']) expect(pvA.out.includes(v), v).toBe(false);
      expect(fpOf(pvA.out)).toBe(await expectedFp(wrongPick, 'correct', { correct: true, overwriteValid: true }));
      expect(await ownerLedger(owner)).toEqual(before);
      // FIX6(6차 검토 #3): --correct --overwrite-valid(사유를 새로 적는 경로)에서도 셸·인코딩 거부 — 미리보기·--confirm 모두, stdout 비어 있음, A 그대로
      for (const [over, code] of [
        [{ reason: '정정: 사유 100% 고쳐 씀' }, 'text_shell_unsafe'],
        [{ reason: '/정정 사유' }, 'text_shell_unsafe'],
        [{ by: 'ops^kim' }, 'text_shell_unsafe'],
        [{ reason: 'x\uDC00y' }, 'text_encoding'],
      ] as Array<[Partial<Fill>, string]>) {
        for (const flags of [['--correct', '--overwrite-valid'], ['--correct', '--overwrite-valid', '--expect', fpOf(pvA.out), '--confirm']]) {
          const r = await cli(argvOf({ ...wrongPick, ...over }, ...flags));
          expect([r.code, r.err.includes(`거부(${code})`), r.out], `${JSON.stringify(over)} ${flags.join(' ')}`).toEqual([1, true, '']);
        }
      }
      expect(await ownerLedger(owner)).toEqual(before);
      // 올바른 대상(B)을 정정(--overwrite-valid 없이) → B 만 바뀐다
      const fillB = { ...fillFor(B, owner), actual: '120.500000', settled: '120.500000' };
      const pvB = await cli(argvOf(fillB, '--correct'));
      expect(pvB.code, pvB.err).toBe(0);
      expect(pvB.out).toContain('지금 행의 복원 검사: 거부(이 정정의 대상)');
      // FIX6(FIX5 Q3): B 의 정정 전 settled_amount('120.5')는 형식 밖이라 값을 되풀이하지 않는다
      expect(pvB.out.split('\n').filter((l) => /^(settled_amount|resolved_at):/.test(l))).toEqual(['settled_amount: (형식 밖 값) → 120.500000', 'resolved_at: 2026-10-10T12:00:00.000Z → (실행 시각)']);
      // FIX5 는 "B 의 미리보기 지문에 --overwrite-valid 를 더한 --confirm → expect_mismatch"(유효하지 않은 행의 --overwrite-valid 허용) →
      // FIX6(FIX5 Q2): 유효하지 않은 행의 --overwrite-valid 는 미리보기·--confirm 모두 계획에서 거부(overwrite_not_needed — 지문 비교보다 먼저, stdout 비어 있음)
      for (const flags of [['--correct', '--overwrite-valid'], ['--correct', '--overwrite-valid', '--expect', fpOf(pvB.out), '--confirm']]) {
        const mixed = await cli(argvOf(fillB, ...flags));
        expect([mixed.code, mixed.err.includes('거부(overwrite_not_needed)'), mixed.out], flags.join(' ')).toEqual([1, true, '']);
      }
      // 지문이 --overwrite-valid 를 담는 것은 함수로 직접(같은 행·입력에서 플래그만 다르면 다른 지문, 플래그 없는 쪽이 B 의 미리보기 지문)
      const [rowB] = await selectBundleRows(db, 'usage_ledger', sql`"usage_ledger"."id" = ${B}::uuid`);
      const fpInput = {
        owner,
        ledger: B,
        mode: 'correct' as const,
        correct: true,
        current: rowB!.row as LedgerBundleRow,
        args: { source: fillB.source, actual: fillB.actual, settled: fillB.settled, by: fillB.by, reason: fillB.reason },
      };
      expect(ledgerResolutionFingerprint({ ...fpInput, overwriteValid: false })).toBe(fpOf(pvB.out));
      expect(ledgerResolutionFingerprint({ ...fpInput, overwriteValid: true })).not.toBe(fpOf(pvB.out));
      expect(await ownerLedger(owner)).toEqual(before);
      const ok = await cli(argvOf(fillB, '--correct', '--expect', fpOf(pvB.out), '--confirm'));
      expect(ok.code, ok.err).toBe(0);
      const after = await ownerLedger(owner);
      expect(after.find((r) => r.id === A)).toEqual(before.find((r) => r.id === A));
      expect(await checkBundleZip(await exportZip(db, owner, tmp, 'y'))).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      // 일부러 올바른 A 를 고쳐 쓰기(사유 고쳐 쓰기) — --correct --overwrite-valid 로만, 감사에 current_row_valid true
      const rowA0 = before.find((r) => r.id === A)!;
      const rewrite = await apply(argvOf({ ...fillFor(A, owner), reason: '정정: 사유 고쳐 씀' }, '--correct', '--overwrite-valid'));
      expect(rewrite.code, rewrite.err).toBe(0);
      expect(((await rowOf(db, A)).pricingSnapshot as Snap).resolution).toMatchObject({ reason: '정정: 사유 고쳐 씀', resolved_by: BY });
      const [auditA] = await db
        .select()
        .from(schema.auditEvents)
        .where(and(eq(schema.auditEvents.action, 'usage_ledger.manual_resolve'), eq(schema.auditEvents.entityId, A)));
      // FIX5 는 toMatchObject({ mode, current_row_valid }) → FIX6: 감사 전체(정정 전 settled_amount·resolved_at 포함, by/reason 은 길이만)
      expect(auditA!.sanitizedDetails).toEqual({
        mode: 'correct',
        half_finished: false,
        current_row_valid: true,
        usage_source_before: 'provider',
        usage_source_after: 'provider',
        reserved_amount: rowA0.reservedAmount,
        actual_amount_before: '9.950000',
        actual_amount_after: '9.950000',
        settled_amount: '9.950000',
        settled_amount_before: '9.950000',
        resolved_at_before: '2026-10-10T12:00:00.000Z',
        resolved_by_length: BY.length,
        reason_length: '정정: 사유 고쳐 씀'.length,
        live_blocked_after: false,
      });
      expect(JSON.stringify(auditA)).not.toContain('시험: 손 작업');
      expect(JSON.stringify(auditA)).not.toContain('sentinel');
      expect(await resolveAudits()).toBe(audits0 + 2);
      expect(await checkBundleZip(await exportZip(db, owner, tmp, 'z'))).toMatchObject({ ok: true, unresolved_live_usage: 0 });
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
        // FIX6(6차 검토 #6): 이렇게 백업 묶음의 bundle:check 가 integrity 로 거부될 때 1단계가 대신 적는 기준값 — --list 둘째 줄의 수(해결 뒤 묶음은 0 = 1 − 1)
        expect(list.out.split('\n')[1], label).toBe(`owner ${owner} · 후보 1행 · 아직 provider_unstorable 1행(0 이면 새 live 호출이 열려 있음)`);
        const before = await ownerLedger(owner);
        const wc = await cli(argvOf(fillFor(ledgerId, owner), '--correct', '--expect', DUMMY_FP, '--confirm'));
        expect([wc.code, wc.err.includes('거부(not_resolved_yet)')], label).toEqual([1, true]);
        // FIX6: --correct --overwrite-valid 도 not_resolved_yet(새 해결 행 — overwrite_not_needed 보다 분류가 먼저)
        const wo = await cli(argvOf(fillFor(ledgerId, owner), '--correct', '--overwrite-valid'));
        expect([wo.code, wo.err.includes('거부(not_resolved_yet)'), wo.out], label).toEqual([1, true, '']);
        // FIX6(6차 검토 #3): 반쯤 끝난 행에서도 셸·인코딩 거부 — 미리보기·--confirm 모두 exit 1, stdout 비어 있음, 행 그대로
        const halfPv = await cli(argvOf(fillFor(ledgerId, owner)));
        expect(halfPv.code, `${label}: ${halfPv.err}`).toBe(0);
        for (const [over, code] of [
          [{ reason: '콘솔 확인 %PATH%' }, 'text_shell_unsafe'],
          [{ by: 'kim<lee>' }, 'text_shell_unsafe'],
          [{ by: '/op' }, 'text_shell_unsafe'],
          [{ reason: 'a\u0000b' }, 'text_encoding'],
        ] as Array<[Partial<Fill>, string]>) {
          for (const flags of [[], ['--expect', fpOf(halfPv.out), '--confirm']]) {
            const r = await cli(argvOf({ ...fillFor(ledgerId, owner), ...over }, ...flags));
            expect([r.code, r.err.includes(`거부(${code})`), r.err.includes('아무것도 바꾸지 않았습니다'), r.out], `${label} ${JSON.stringify(over)} ${flags.join(' ')}`).toEqual([1, true, true, '']);
          }
        }
        expect(await ownerLedger(owner)).toEqual(before);
        const ok = await apply(argvOf(fillFor(ledgerId, owner)));
        expect(ok.preview.out, label).toContain('반쯤 끝난 해결 기록(provider_unstorable + resolution)을 최상위 원래 보고값으로 다시 만든다');
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
        for (const flags of [[], ['--expect', DUMMY_FP, '--confirm'], ['--correct', '--expect', DUMMY_FP, '--confirm']]) {
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
      for (const flags of [['--expect', DUMMY_FP, '--confirm'], ['--correct', '--expect', DUMMY_FP, '--confirm'], [], ['--correct', '--overwrite-valid']]) {
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
      const r = await cli(argvOf(fillFor(id, owner), '--expect', DUMMY_FP, '--confirm'));
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
      const r = await apply(argvOf(fillFor(ledgerId, owner)), {
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
    const ok = await apply(argvOf(fillFor(ledgerId, owner)), { beforeApply: async () => undefined });
    expect(ok.code, ok.err).toBe(0);
  });

  it('5차 검토 #3(원자성): UPDATE·쓴 행 확인·감사 기록은 함께 커밋되거나 함께 되돌려진다 — 시험이 만든 plpgsql 트리거로 (a) UPDATE 가 다른 값을 쓰면 거부(verify), (b) 감사 기록 삽입이 실패하면 일반 오류. 둘 다 DB 원문·감사 수 그대로, 트리거를 지우면 적용(대조)', async () => {
    const { owner, ledgerId } = await unstorableRun(db, 'fix5-lr-atomic@example.local');
    expect(ledgerId).toMatch(/^[0-9a-f-]{36}$/); // 트리거 본문에 넣는 값(DB 가 만든 uuid)
    const raw0 = await rawRow(ledgerId);
    const audits0 = await resolveAudits();
    const unchanged = async (label: string) => {
      expect(await rawRow(ledgerId), label).toEqual(raw0);
      expect(await resolveAudits(), label).toBe(audits0);
      expect(await hasUnresolvedLiveUsage(db, owner), label).toBe(true);
    };
    // (a) BEFORE UPDATE: 대상 행에 쓰는 스냅숏을 바꾼다 → 쓴 행 확인(트랜잭션 안)이 잡고 되돌린다
    await db.execute(
      sql.raw(`create function fix5_test_alter_snapshot() returns trigger language plpgsql as $$
        begin
          if new.id = '${ledgerId}'::uuid then new.pricing_snapshot := new.pricing_snapshot || '{"fix5_trigger": true}'::jsonb; end if;
          return new;
        end $$`),
    );
    await db.execute(sql.raw('create trigger fix5_test_alter_snapshot before update on usage_ledger for each row execute function fix5_test_alter_snapshot()'));
    try {
      const r = await apply(argvOf(fillFor(ledgerId, owner)));
      expect(r.preview.code, r.preview.err).toBe(0);
      expect(r.code).toBe(1);
      expect(r.err).toContain('거부(verify)');
      expect(r.out).not.toContain('updated');
      await unchanged('(a) verify');
    } finally {
      await db.execute(sql.raw('drop trigger if exists fix5_test_alter_snapshot on usage_ledger'));
      await db.execute(sql.raw('drop function if exists fix5_test_alter_snapshot()'));
    }
    // (b) BEFORE INSERT on audit_events: 이 행의 감사 기록 삽입을 실패시킨다 → UPDATE 도 되돌려진다(오류 본문은 출력하지 않음)
    await db.execute(
      sql.raw(`create function fix5_test_fail_audit() returns trigger language plpgsql as $$
        begin
          if new.action = 'usage_ledger.manual_resolve' and new.entity_id = '${ledgerId}'::uuid then
            raise exception 'fix5-audit-trigger-message %', '${BY}';
          end if;
          return new;
        end $$`),
    );
    await db.execute(sql.raw('create trigger fix5_test_fail_audit before insert on audit_events for each row execute function fix5_test_fail_audit()'));
    try {
      const r = await apply(argvOf(fillFor(ledgerId, owner)));
      expect(r.preview.code, r.preview.err).toBe(0);
      expect(r.code).toBe(1);
      expect(r.err).toContain('원장 수동 해결을 마치지 못했습니다(오류 종류: ');
      expect(r.err).toContain('아무것도 바꾸지 않았습니다');
      expect(r.err).not.toContain('fix5-audit-trigger-message');
      expect(r.err).not.toContain('커밋');
      expect(r.out).not.toContain('updated');
      await unchanged('(b) audit');
    } finally {
      await db.execute(sql.raw('drop trigger if exists fix5_test_fail_audit on audit_events'));
      await db.execute(sql.raw('drop function if exists fix5_test_fail_audit()'));
    }
    // 대조: 트리거가 없으면 같은 명령이 1행·감사 1건
    const ok = await apply(argvOf(fillFor(ledgerId, owner)));
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out.split('\n')).toContain('updated 1');
    expect((await rawRow(ledgerId)).snap).not.toBe(raw0.snap);
    expect(String((await rawRow(ledgerId)).snap)).not.toContain('fix5_trigger');
    expect(await resolveAudits()).toBe(audits0 + 1);
  });

  it('5차 검토 #8: UPDATE 의 값 조건 — 스냅숏에 JS 가 정확히 담지 못하는 수(12345678901234567890)가 있으면 미리보기·지문은 통과해도 적용은 거부(changed), 감사 없음, DB 원문 그대로', async () => {
    const { owner, ledgerId } = await unstorableRun(db, 'fix5-lr-bignum@example.local');
    await db.execute(sql`update usage_ledger set pricing_snapshot = pricing_snapshot || '{"x":12345678901234567890}'::jsonb where id = ${ledgerId}::uuid`);
    const raw0 = await rawRow(ledgerId);
    expect(String(raw0.snap)).toContain('"x": 12345678901234567890');
    expect(Number('12345678901234567890').toString()).not.toBe('12345678901234567890'); // JS 숫자로는 정확히 담지 못한다(전제)
    const audits0 = await resolveAudits();
    const r = await apply(argvOf(fillFor(ledgerId, owner)));
    expect(r.preview.code, r.preview.err).toBe(0);
    expect(r.code).toBe(1);
    expect(r.err).toContain('거부(changed)');
    expect(r.out).not.toContain('updated');
    expect(await rawRow(ledgerId)).toEqual(raw0);
    expect(await resolveAudits()).toBe(audits0);
    expect(await hasUnresolvedLiveUsage(db, owner)).toBe(true);
  });

  it('6차 검토 #4: 커밋 뒤 실패 = "updated 1" 뒤 exit 1 — (a) 적용 뒤 DB 닫기 실패 (b) 커밋 뒤 확인 실패(차단 판정이 다름·다시 읽기 실패). stderr 는 커밋이 끝났다고 말하고 "아무것도 바꾸지 않았습니다" 는 없다. 행은 해결됨·감사 +1', async () => {
    // (a) 적용(--confirm)은 커밋됐고 그 뒤 close() 가 던진다
    const a = await unstorableRun(db, 'fix6-lr-close@example.local');
    const pvA = await cli(argvOf(fillFor(a.ledgerId, a.owner)));
    expect(pvA.code, pvA.err).toBe(0);
    const auditsA = await resolveAudits();
    const closeFail = await cli(argvOf(fillFor(a.ledgerId, a.owner), '--expect', fpOf(pvA.out), '--confirm'), {
      openDb: async () => ({
        ...h,
        close: async () => {
          throw new TypeError(`x ${KEY}`);
        },
      }),
    });
    expect(closeFail.code).toBe(1);
    expect(closeFail.out.split('\n')).toEqual(expect.arrayContaining([CONFIRM_HEADER, 'updated 1']));
    expect(closeFail.err).toBe('DB 를 닫지 못했습니다(오류 종류: TypeError).');
    expect(closeFail.err).not.toContain('아무것도 바꾸지 않았습니다');
    expect(((await rowOf(db, a.ledgerId)).pricingSnapshot as Snap).resolution).toMatchObject({ resolved_by: BY, reason: REASON, resolved_at: NOW.toISOString() });
    expect(await hasUnresolvedLiveUsage(db, a.owner)).toBe(false);
    expect(await resolveAudits()).toBe(auditsA + 1);
    // (b) 커밋 뒤 확인(hasUnresolvedLiveUsage)이 실패 — 제품 훅 없이 db 감싸개로(transaction() 이 끝난 뒤에만 동작)
    const postCommitCases: Array<[string, (plain: string) => Db, string]> = [
      [
        '차단 판정이 커밋 직후 값과 다름(커밋 뒤 같은 owner 의 다른 행이 provider_unstorable 이 됨)',
        (plain: string) =>
          dbAfterCommit(
            db,
            async (d) => {
              const p = await rowOf(d, plain);
              await setSnap(d, plain, { ...p.pricingSnapshot, usage_source: 'provider_unstorable' });
            },
            false,
          ),
        'Error',
      ],
      ['커밋 뒤 다시 읽기(select) 실패', () => dbAfterCommit(db, async () => undefined, true), 'TypeError'],
    ];
    for (const [label, makeDb, errName] of postCommitCases) {
      const owner = await freshOwner(db, `fix6-lr-postcommit-${randomUUID()}@example.local`);
      const plain = await liveRun(db, owner, json(200, message())); // 보통 provider 행(먼저 — 미해결 행이 있으면 live 호출이 막힌다)
      const ledgerId = await liveRun(db, owner, json(200, message({ usage: OVER_INT })));
      const pv = await cli(argvOf(fillFor(ledgerId, owner)));
      expect(pv.code, `${label}: ${pv.err}`).toBe(0);
      const audits0 = await resolveAudits();
      const wrapped = makeDb(plain);
      const r = await cli(argvOf(fillFor(ledgerId, owner), '--expect', fpOf(pv.out), '--confirm'), { openDb: async () => ({ ...h, db: wrapped, close: async () => undefined }) });
      expect(r.code, label).toBe(1);
      expect(r.out.split('\n'), label).toEqual(expect.arrayContaining([CONFIRM_HEADER, 'updated 1', '이 owner 의 새 live 호출: 열림(이 owner 의 provider_unstorable 0행)']));
      expect(r.err, label).toBe(`적용(커밋)은 끝났지만 그 뒤 확인을 마치지 못했습니다(오류 종류: ${errName}). --list 로 결과를 확인하세요.`);
      expect(r.err, label).not.toContain('아무것도 바꾸지 않았습니다');
      expect(r.err, label).not.toContain('fix6-after-commit-select');
      const row = await rowOf(db, ledgerId);
      expect((row.pricingSnapshot as Snap).usage_source, label).toBe('provider');
      expect((row.pricingSnapshot as Snap).resolution, label).toMatchObject({ resolved_by: BY, reason: REASON, resolved_at: NOW.toISOString() });
      expect(await resolveAudits(), label).toBe(audits0 + 1);
    }
  });

  it('DB 잠금(dev 서버가 열고 있음) → 잠금 안내 exit 1 / 예상하지 못한 오류는 종류·코드만 / DB 닫기 실패 exit 1', async () => {
    const locked = await cli(['--list'], {
      openDb: async () => {
        throw new DbLockedError(999999);
      },
    });
    expect(locked.code).toBe(1);
    expect(locked.err).toContain('PGlite 데이터 디렉터리를 다른 프로세스(PID 999999)가 사용 중입니다');
    const boom = await cli(argvOf(fillFor(randomUUID(), randomUUID()), '--expect', DUMMY_FP, '--confirm'), {
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

describe('FIX5-LIVEL1H2 — 5차 검토 #1·Q2: 확인 지문(--expect)이 ② 를 ① 에 묶는다', () => {
  it('① 과 ② 사이에 입력(source·actual·settled·by·reason·ledger)이나 행(스냅숏·금액)이 바뀌면 거부(expect_mismatch) — 트랜잭션 전(beforeApply 안 불림)·아무것도 안 바뀜·by/reason 출력 없음. 원래 행·입력이면 같은 지문(대문자도)으로 적용', async () => {
    const { owner, ledgerId: A } = await unstorableRun(db, 'fix5-lr-fp@example.local');
    const B = await addUnstorable(db, owner);
    const base = fillFor(A, owner);
    const pv = await cli(argvOf(base));
    expect(pv.code, pv.err).toBe(0);
    const fp = fpOf(pv.out);
    const before = await ownerLedger(owner);
    const audits0 = await resolveAudits();
    const rowA0 = before.find((r) => r.id === A)!;
    let hookCalls = 0;
    const hook = { beforeApply: async () => void hookCalls++ };
    const refusedUnchanged = async (r: CliResult, label: string) => {
      expect(r.code, label).toBe(1);
      expect(r.err, label).toContain('거부(expect_mismatch)');
      expect(r.err, label).toContain('미리보기(--confirm 없이)부터 다시 실행');
      expect(r.err, label).not.toContain(fp);
      expect(r.out, label).toBe(''); // 적용 칸(by·reason 포함)을 출력하기 전에 거부
      expect(hookCalls, label).toBe(0); // 트랜잭션(과 그 앞의 시험 훅)에 가기 전
      expect(await resolveAudits(), label).toBe(audits0);
    };
    const variants: Array<[string, Partial<Fill>, string | null]> = [
      ['actual·settled', { actual: '9.960000', settled: '9.960000' }, null],
      ['settled 만(5단계 상한 모양)', { settled: '19.950000' }, null],
      ['source none(예약액)', { source: 'none', actual: rowA0.reservedAmount, settled: rowA0.reservedAmount }, null],
      ['by 끝 공백', { by: `${BY} ` }, `resolved_by: "${BY} "`],
      ['by 의 - 하나가 NBSP', { by: BY.replace('-', '\u{a0}') }, `resolved_by: "${BY.replace('-', '\\u00a0')}"`],
      ['reason 끝 폭 없는 공백', { reason: `${REASON}\u{200b}` }, `reason: ${JSON.stringify(REASON).slice(0, -1)}\\u200b"`],
      ['reason NFD(같은 글자로 보임)', { reason: REASON.normalize('NFD') }, null],
      ['다른 원장(B)', { ledger: B }, null],
    ];
    for (const [label, over, shown] of variants) {
      const f = { ...base, ...over };
      const vp = await cli(argvOf(f));
      expect(vp.code, `${label}: ${vp.err}`).toBe(0);
      expect(fpOf(vp.out), label).not.toBe(fp);
      if (shown) expect(vp.out.split('\n'), label).toContain(shown);
      await refusedUnchanged(await cli(argvOf(f, '--expect', fp, '--confirm'), hook), label);
      expect(await ownerLedger(owner), label).toEqual(before);
    }
    // 행이 바뀜(① 과 ② 사이에 다른 작업 — 스냅숏·금액): 같은 입력·같은 지문이어도 거부, 바뀐 행 그대로
    for (const [label, change] of [
      ['스냅숏', () => setSnap(db, A, { ...rowA0.pricingSnapshot, note: 'between-runs' })],
      ['actual_amount', () => db.update(schema.usageLedger).set({ actualAmount: '0.200000' }).where(eq(schema.usageLedger.id, A))],
    ] as const) {
      await change();
      const changed = await ownerLedger(owner);
      await refusedUnchanged(await cli(argvOf(base, '--expect', fp, '--confirm'), hook), label);
      expect(await ownerLedger(owner), label).toEqual(changed);
      await db
        .update(schema.usageLedger)
        .set({ pricingSnapshot: rowA0.pricingSnapshot, actualAmount: rowA0.actualAmount })
        .where(eq(schema.usageLedger.id, A)); // 원래 행으로(시험 준비)
      expect(await ownerLedger(owner), label).toEqual(before);
    }
    // 원래 행·원래 입력: 처음 미리보기의 지문(대문자로 적어도)으로 적용 — 적용 칸에 같은 지문
    const ok = await cli(argvOf(base, '--expect', fp.toUpperCase(), '--confirm'), hook);
    expect(ok.code, ok.err).toBe(0);
    expect(hookCalls).toBe(1);
    expect(ok.out.split('\n')).toEqual(expect.arrayContaining([CONFIRM_HEADER, `확인 지문: ${fp}`, 'updated 1']));
    expect(await resolveAudits()).toBe(audits0 + 1);
    expect((await ownerLedger(owner)).find((r) => r.id === B)).toEqual(before.find((r) => r.id === B));
  });
});

describe('FIX5-LIVEL1H2 — 5차 검토 #4·#5·Q1: --by·--reason 을 받은 그대로(이스케이프) 보여 주고 그대로 저장한다', () => {
  it('보이지 않는 문자·제어 문자·줄 구분자·BMP 밖 형식/사용자 문자는 \\u 로, 보이는 글자·U+0020 은 그대로 — 미리보기·적용 칸이 같고, 저장 값은 받은 값 그대로, 감사·--list 에는 없음', async () => {
    const { owner, ledgerId } = await unstorableRun(db, 'fix5-lr-escape@example.local');
    const by = 'op\u{a0}kim\u{200b}\u{202e}';
    const reason = 'line1\nline2\ttab\u{2028}sep\u0085nel \u{3000}wide\u{e0041}tag\u{f0000}pua \u{1f600} 끝';
    const r = await apply(argvOf({ ...fillFor(ledgerId, owner), by, reason }));
    expect(r.code, r.err).toBe(0);
    for (const out of [r.preview.out, r.out]) {
      const lines = out.split('\n');
      expect(lines).toContain('resolved_by: "op\\u00a0kim\\u200b\\u202e"');
      expect(lines).toContain('reason: "line1\\nline2\\ttab\\u2028sep\\u0085nel \\u3000wide\\u{e0041}tag\\u{f0000}pua \u{1f600} 끝"');
      expect(lines.some((l) => l.startsWith(`resolved_by ${by.length}자 · reason ${reason.length}자(UTF-16 길이`))).toBe(true);
      // FIX5 는 구현과 같은 정규식(INVISIBLE)으로 봤다 → FIX6(6차 검토 #2): 구현을 베끼지 않은 기준 둘 — (1) 명시 목록의 문자와 탭·CR 은 어느 줄에도 글자 그대로 없고,
      // (2) 두 값 줄은 ASCII 보이는 글자(U+0020–U+007E)와 받은 값의 보이는 글자(😀·끝)로만 이뤄진다(그 밖의 보이지 않는 문자가 하나라도 남으면 실패)
      for (const l of lines) for (const cp of [0x09, 0x0d, ...MUST_ESCAPE]) expect(l.includes(String.fromCodePoint(cp)), `U+${cp.toString(16)} 글자 그대로: ${JSON.stringify(l)}`).toBe(false);
      for (const l of lines.filter((x) => x.startsWith('resolved_by: ') || x.startsWith('reason: '))) {
        expect([...l].filter((ch) => !(ch >= ' ' && ch <= '~') && ch !== '\u{1f600}' && ch !== '끝'), JSON.stringify(l)).toEqual([]);
      }
    }
    const res = ((await rowOf(db, ledgerId)).pricingSnapshot as Snap).resolution;
    expect([res.resolved_by, res.reason]).toEqual([by, reason]); // 표시는 이스케이프, 저장은 받은 그대로
    const [audit] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.entityId, ledgerId));
    expect(audit!.sanitizedDetails).toMatchObject({ resolved_by_length: by.length, reason_length: reason.length });
    for (const v of ['kim', 'line1', 'wide']) expect(JSON.stringify(audit), v).not.toContain(v);
    const lst = await cli(['--list', '--owner', owner]);
    for (const v of ['kim', 'line1', 'wide']) expect(lst.out + lst.err, v).not.toContain(v);
  });

  it('6차 검토 #2: 명시한 코드 포인트 목록(한글 채움·변이 선택자 같은 기본 무시 문자 포함)은 하나하나 by·reason 모두에서 \\u 로, U+0020·보통 한글·이모지는 글자 그대로. 채움 문자만인 by 도 공백처럼 보이지 않는다', async () => {
    const { owner, ledgerId } = await unstorableRun(db, 'fix6-lr-escape-list@example.local');
    const before = await ownerLedger(owner);
    const VISIBLE = '콘솔 확인 가나다 \u{1f600} 끝';
    for (const cp of MUST_ESCAPE) {
      const ch = String.fromCodePoint(cp);
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      const r = await cli(argvOf({ ...fillFor(ledgerId, owner), by: `op${ch}kim`, reason: `${VISIBLE}${ch}${VISIBLE}` }));
      expect(r.code, `${label}: ${r.err}`).toBe(0);
      const lines = r.out.split('\n');
      expect(lines, label).toContain(`resolved_by: "op${escOf(cp)}kim"`);
      expect(lines, label).toContain(`reason: "${VISIBLE}${escOf(cp)}${VISIBLE}"`); // 공백·한글·이모지는 그대로
      expect(r.out.includes(ch), `${label} 가 글자 그대로 출력됨`).toBe(false);
    }
    // FIX2-CODEX(U3, 사용자 결정 2026-10-23 — 이전: 한글 채움 문자만인 by 는 JS trim() 이 지우지 않아 받고 \u3164 로 표시): 채움 문자만인 by 는 이제
    // 거부(text_blank — stdout 없음). 보이는 글자와 섞인 채움 문자는 지금처럼 받고, 표시는 공백처럼 보이지 않고 \u3164 로
    const filler = await cli(argvOf({ ...fillFor(ledgerId, owner), by: '\u3164\u3164' }));
    expect(filler.code).toBe(1);
    expect(filler.err).toContain('거부(text_blank)');
    expect(filler.out).toBe('');
    const mixedFiller = await cli(argvOf({ ...fillFor(ledgerId, owner), by: '\u3164\u3164op' }));
    expect(mixedFiller.code, mixedFiller.err).toBe(0);
    expect(mixedFiller.out.split('\n')).toContain('resolved_by: "\\u3164\\u3164op"');
    expect(await ownerLedger(owner)).toEqual(before); // 미리보기·거부만 — 아무것도 바뀌지 않음
  });
});

describe('FIX2-CODEX(U3 — Codex review-FIX6-D39 Q4): 공백·기본 무시 문자만으로 된 --by·--reason 거부(text_blank) — CLI 만, 복원 검사는 그대로', () => {
  /**
   * 구현의 정규식을 베끼지 않은 **명시 목록**(코드 포인트는 \u 이스케이프로만): 한글 채움 U+3164·U+115F·U+1160·U+FFA0, 폭 없는 공백·비결합자·결합자 U+200B·U+200C·U+200D,
   * 단어 잇기 U+2060, 결합 자소 결합자 U+034F, 변이 선택자 U+FE0F·U+E0100, 몽골 모음 구분자 U+180E, SHY U+00AD, 태그 U+E0041, 그리고 JS trim() 은 남기지만
   * 유니코드 공백인 NEL U+0085 — 그리고 이것들과 공백(스페이스·탭·줄바꿈·전각 공백·NBSP·BOM)을 섞은 값.
   */
  const BLANK: Array<[string, string]> = [
    ['U+3164 한글 채움', '\u3164'],
    ['U+3164 두 개', '\u3164\u3164'],
    ['U+115F 한글 초성 채움', '\u115F'],
    ['U+1160 한글 중성 채움', '\u1160'],
    ['U+FFA0 반각 한글 채움', '\uFFA0'],
    ['U+200B 폭 없는 공백', '\u200B'],
    ['U+200B·U+200C·U+200D', '\u200B\u200C\u200D'],
    ['U+2060 단어 잇기', '\u2060'],
    ['U+034F 결합 자소 결합자', '\u034F'],
    ['U+FE0F 변이 선택자', '\uFE0F'],
    ['U+E0100 변이 선택자(BMP 밖)', '\u{E0100}'],
    ['U+180E 몽골 모음 구분자', '\u180E'],
    ['U+00AD SHY', '\u00AD'],
    ['U+E0041 태그', '\u{E0041}'],
    ['U+0085 NEL(JS trim() 이 남김)', '\u0085'],
    ['스페이스 + U+3164 + 스페이스', ' \u3164 '],
    ['탭 + U+200B + 줄바꿈', '\t\u200B\n'],
    ['전각 공백 + U+3164 + NBSP', '\u3000\u3164\u00A0'],
    ['BOM + U+200B(BOM 은 trim() 이 지우고 U+200B 가 남음)', '\uFEFF\u200B'],
    ['NEL + U+3164', '\u0085\u3164'],
  ];

  it('사용법이 보이는 글자로 적으라고 알린다(공백·보이지 않는 문자만인 값은 받지 않음) — 명령 줄은 그대로 2개', () => {
    expect(LEDGER_RESOLVE_USAGE).toContain('(--by·--reason 은 보이는 글자로 적는다 — 공백·보이지 않는 문자(한글 채움 문자 등)만으로 된 값은 받지 않는다)');
    expect(LEDGER_RESOLVE_USAGE.split('\n').filter((l) => l.includes('ledger:resolve'))).toHaveLength(2);
  });

  it('공백·기본 무시 문자만인 --by·--reason → 거부(text_blank), 미리보기·--confirm·정정(--correct --overwrite-valid) 모두 exit 1·stdout 없음·행 그대로·감사 없음', async () => {
    const { owner, ledgerId } = await unstorableRun(db, 'fix2-codex-u3-blank@example.local');
    const corrId = await addUnstorable(db, owner);
    await handResolve(corrId); // 이미 복원 검사를 통과하는 해결 행(정정 — --correct --overwrite-valid)
    const before = await ownerLedger(owner);
    const audits0 = await resolveAudits();
    for (const [label, v] of BLANK) {
      for (const field of ['by', 'reason'] as const) {
        for (const [target, flags] of [
          [ledgerId, []],
          [ledgerId, ['--expect', DUMMY_FP, '--confirm']],
          [corrId, ['--correct', '--overwrite-valid']],
          [corrId, ['--correct', '--overwrite-valid', '--expect', DUMMY_FP, '--confirm']],
        ] as Array<[string, string[]]>) {
          const r = await cli(argvOf({ ...fillFor(target, owner), [field]: v }, ...flags));
          const at = `${label} ${field} ${flags.join(' ')}`;
          expect(r.code, at).toBe(1);
          expect(r.err, at).toContain('거부(text_blank)');
          expect(r.err, at).toContain('아무것도 바꾸지 않았습니다');
          expect(r.out, at).toBe('');
        }
      }
    }
    expect(await ownerLedger(owner)).toEqual(before);
    expect(await resolveAudits()).toBe(audits0);
    expect(await hasUnresolvedLiveUsage(db, owner)).toBe(true);
  });

  it('경계·순서: JS trim() 으로 빈 값은 지금처럼 resolution:resolved_by·reason, NUL·서로게이트(text_encoding)·셸 문자(text_shell_unsafe)·--actual 형식이 먼저, 보이는 글자와 섞이면 받는다', async () => {
    const { owner, ledgerId } = await unstorableRun(db, 'fix2-codex-u3-order@example.local');
    const before = await ownerLedger(owner);
    const good = fillFor(ledgerId, owner);
    for (const [over, code] of [
      [{ by: '' }, 'resolution:resolved_by'],
      [{ by: '\uFEFF\u3000 \t' }, 'resolution:resolved_by'],
      [{ reason: '\u2028\u00A0' }, 'resolution:reason'],
      [{ by: '\u3164', reason: 'x\uD800y' }, 'text_encoding'],
      [{ by: 'a\u0000b', reason: '\u200B' }, 'text_encoding'],
      [{ by: '\u3164', reason: '실제 청구 9.95% 할인' }, 'text_shell_unsafe'],
      [{ by: '/\u3164' }, 'text_shell_unsafe'],
      [{ by: '\u3164', actual: '9.95' }, 'actual_format'],
      [{ by: 'op', reason: '\u3164' }, 'text_blank'],
    ] as Array<[Partial<Fill>, string]>) {
      const r = await cli(argvOf({ ...good, ...over }));
      expect([r.code, r.err.includes(`거부(${code})`), r.out], JSON.stringify(over)).toEqual([1, true, '']);
    }
    expect(await ownerLedger(owner)).toEqual(before);
    // 섞인 값: 보이는 글자가 하나라도 있으면 지금처럼 받는다(표시는 이스케이프, 지문 공식 그대로) → 적용 1행, 저장은 받은 그대로
    const mixed: Fill = { ...good, by: '\u3164op\u200B', reason: `\u200B${REASON}\u3164` };
    const fp0 = await expectedFp(mixed, 'resolve'); // 적용 전 행으로(지문 공식 그대로)
    const r = await apply(argvOf(mixed));
    expect(r.preview.code, r.preview.err).toBe(0);
    expect(r.preview.out.split('\n')).toContain('resolved_by: "\\u3164op\\u200b"');
    expect(r.preview.out.split('\n')).toContain(`reason: "\\u200b${JSON.stringify(REASON).slice(1, -1)}\\u3164"`);
    expect(r.fp).toBe(fp0);
    expect(r.code, r.err).toBe(0);
    expect(r.out.split('\n')).toContain('updated 1');
    const res = ((await rowOf(db, ledgerId)).pricingSnapshot as Snap).resolution;
    expect([res.resolved_by, res.reason]).toEqual([mixed.by, mixed.reason]);
  });

  it('복원 검사(묶음 검증기)는 그대로: 이미 저장된 채움 문자만인 resolved_by·reason 행은 bundle:check·복원 미리보기를 통과하고 --list 도 "복원 검사 통과" — 그 행의 정정도 보이는 글자만 받는다', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix2-codex-u3-'));
    try {
      const { owner, ledgerId } = await unstorableRun(db, 'fix2-codex-u3-stored@example.local');
      await handResolve(ledgerId);
      const snap = (await rowOf(db, ledgerId)).pricingSnapshot as Snap;
      // 이 변경 전(또는 손 작업)에 저장된 모양: resolved_by·reason 이 기본 무시 문자만
      await setSnap(db, ledgerId, { ...snap, resolution: { ...snap.resolution, resolved_by: '\u3164\u3164', reason: '\u200B\u2060' } });
      const zip = await exportZip(db, owner, tmp, 'u3');
      expect(await checkBundleZip(zip)).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      const h2 = await createTestDb();
      try {
        const target = (await ensureOwner(h2.db, 'restore-fix2-codex-u3@example.local')).id;
        const pv = await createRestorePreview(h2.db, target, zip, { restoresDir: path.join(tmp, 'restores'), source: 'upload' });
        expect(pv.preview.tables.usage_ledger).toMatchObject({ in_bundle: 1, new: 1, existing_different: 0 });
      } finally {
        await h2.close();
      }
      const lst = await cli(['--list', '--owner', owner]);
      expect(lst.code, lst.err).toBe(0);
      expect(lst.out).toContain('해결 기록 있음(복원 검사 통과)');
      expect(lst.out).toContain('정정만(--correct --overwrite-valid — 이미 복원 검사 통과)');
      // 그 행을 정정할 때: 채움 문자만은 거부, 보이는 글자는 받는다(정정 미리보기 — 아무것도 바뀌지 않음)
      const before = await ownerLedger(owner);
      const blank = await cli(argvOf({ ...fillFor(ledgerId, owner), by: '\u3164\u3164' }, '--correct', '--overwrite-valid'));
      expect([blank.code, blank.err.includes('거부(text_blank)'), blank.out]).toEqual([1, true, '']);
      const ok = await cli(argvOf(fillFor(ledgerId, owner), '--correct', '--overwrite-valid'));
      expect(ok.code, ok.err).toBe(0);
      expect(ok.out).toContain('지금 행의 복원 검사: 통과');
      expect(await ownerLedger(owner)).toEqual(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('FIX5-LIVEL1H2 — 5차 검토 #6: 1단계 내보내기(AUTH_ALLOWED_IDENTITY) 범위 밖 owner 는 고치지 않는다', () => {
  it('--owner 가 AUTH_ALLOWED_IDENTITY 의 owner 가 아니거나 그 owner 가 DB 에 없으면 미리보기·--confirm·정정 모두 거부(owner_not_exported, 행 찾기보다 먼저), 아무것도 안 바뀜. 그 owner 로 AUTH_ALLOWED_IDENTITY 를 붙이면 같은 지문으로 적용', async () => {
    const x = await unstorableRun(db, 'fix5-lr-scope-x@example.local');
    const y = await unstorableRun(db, 'fix5-lr-scope-y@example.local');
    const fill = fillFor(x.ledgerId, x.owner);
    const pvX = await cli(argvOf(fill), { env: { AUTH_ALLOWED_IDENTITY: 'fix5-lr-scope-x@example.local' } });
    expect(pvX.code, pvX.err).toBe(0);
    const fpX = fpOf(pvX.out);
    const beforeX = await ownerLedger(x.owner);
    const beforeY = await ownerLedger(y.owner);
    const audits0 = await resolveAudits();
    for (const [label, identity, msg] of [
      ['다른 owner(y)가 내보내기 owner', 'fix5-lr-scope-y@example.local', '--owner 가 1단계 내보내기 대상(AUTH_ALLOWED_IDENTITY 의 owner)이 아닙니다'],
      ['내보내기 owner 가 이 DB 에 없음', 'fix5-lr-nobody@example.local', '허용 사용자(AUTH_ALLOWED_IDENTITY)의 owner 가 이 DB 에 없어'],
    ] as const) {
      for (const argv of [argvOf(fill), argvOf(fill, '--expect', fpX, '--confirm'), argvOf(fill, '--correct'), argvOf({ ...fill, ledger: randomUUID() })]) {
        const r = await cli(argv, { env: { AUTH_ALLOWED_IDENTITY: identity } });
        const l = `${label} ${argv.slice(-2).join(' ')}`;
        expect(r.code, l).toBe(1);
        expect(r.err, l).toContain('거부(owner_not_exported)');
        expect(r.err, l).toContain(msg);
        expect(r.err, l).toContain('1~7단계의 모든 명령 앞에 AUTH_ALLOWED_IDENTITY=<그 owner 의 로그인 identity> 를 붙여');
        expect(r.err, l).toContain('아무것도 바꾸지 않았습니다');
        expect(r.out, l).toBe('');
        expect(r.err, l).not.toContain(identity);
      }
    }
    expect(await ownerLedger(x.owner)).toEqual(beforeX);
    expect(await ownerLedger(y.owner)).toEqual(beforeY);
    expect(await resolveAudits()).toBe(audits0);
    const ok = await cli(argvOf(fill, '--expect', fpX, '--confirm'), { env: { AUTH_ALLOWED_IDENTITY: 'fix5-lr-scope-x@example.local' } });
    expect(ok.code, ok.err).toBe(0);
    expect(await ownerLedger(y.owner)).toEqual(beforeY);
  });
});

describe('FIX5-LIVEL1H2 — 5차 검토 #2: DB 폴더가 없으면 열지 않는다(새 PGlite 클러스터·migration 없음)', () => {
  it('없는 절대 경로 DATABASE_URL → --list·미리보기·--confirm 모두 exit 1, openDb 를 부르지 않음, 폴더를 만들지 않음. 폴더가 있으면 연다(대조)', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix5-lr-nodir-'));
    try {
      const missing = path.join(tmp, 'no-such-db');
      const f = fillFor(randomUUID(), randomUUID());
      for (const argv of [['--list'], ['--list', '--owner', f.owner], argvOf(f), argvOf(f, '--expect', DUMMY_FP, '--confirm')]) {
        const r = await cli(argv, { env: { DATABASE_URL: missing } });
        expect([r.code, r.opened, r.err, r.out], argv[0]).toEqual([1, 0, 'DB 폴더가 없습니다(DATABASE_URL 확인) — 아무것도 만들지 않았습니다.', '']);
        expect(existsSync(missing), argv[0]).toBe(false);
      }
      expect(readdirSync(tmp)).toEqual([]);
      // 대조: 폴더가 있으면 openDb 를 부른다(여기서는 주입한 메모리 DB — 폴더 검사는 있는지만 본다)
      mkdirSync(missing);
      const r = await cli(['--list', '--owner', f.owner], { env: { DATABASE_URL: missing } });
      expect([r.code, r.opened]).toEqual([1, 1]);
      expect(r.err).toContain('가 이 DB 에 없습니다');
      expect(readdirSync(missing)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
    // FIX4 "읽기 전용 — 아무것도 바꾸지 않음" → FIX5(5차 검토 #2): 원장 행·감사 기록은 바꾸지 않고, 여는 것은 1단계 export 와 같다(migration)
    expect(lines[0]).toBe('원장 수동 해결 대상 목록(원장 행·감사 기록은 바꾸지 않음 — DB 를 열 때 밀린 migration 은 1단계 export 와 똑같이 적용)');
    expect(lines[1]).toBe(`owner ${owner} · 후보 3행 · 아직 provider_unstorable 2행(0 이면 새 live 호출이 열려 있음)`);
    expect(r.out).not.toContain('범위 밖');
    const lineOf = (id: string) => lines.find((l) => l.includes(`usage_ledger ${id}`))!;
    expect(lineOf(U)).toContain(`보고값 tokens_in ${s.reported_tokens_in} · tokens_out ${s.reported_tokens_out} · cost ${s.reported_cost}`);
    expect(lineOf(U)).toMatch(/status succeeded · error -\).*usage_source provider_unstorable.*→ 새 해결\(--correct 없이\)$/);
    expect(lineOf(failedU)).toMatch(/failed true · run \S+\(status failed · error llm_refusal\)/);
    expect(lineOf(R)).toMatch(/usage_source provider · 해결 기록 있음\(복원 검사 통과\) → 정정만\(--correct --overwrite-valid — 이미 복원 검사 통과\)$/);
    // FIX5 의 `해결: MSYS_NO_PATHCONV=1 corepack …` → FIX6(6차 검토 #5): 앞붙임 없이 corepack 으로 시작(그 앞붙임은 Git Bash 의 corepack shim 을 깰 수 있음 [추정])
    expect(lines.at(-1)).toContain(`해결: corepack pnpm ledger:resolve --owner ${owner} --ledger <위 id>`);
    expect(r.out).not.toContain('MSYS_NO_PATHCONV');
    expect(lines.at(-1)).toContain('--expect <확인 지문> --confirm');
    for (const v of [APPROVAL, KEY, 'sk-ant', '시험: 손 작업', 'operator']) expect(r.out.includes(v), v).toBe(false);
    expect(await ownerLedger(owner)).toEqual(before);
    expect(await resolveAudits()).toBe(audits0);
    // 같은 결과를 --owner 로
    expect((await cli(['--list', '--owner', owner])).out).toBe(r.out);
    // FIX5(5차 검토 #6): 1단계 내보내기 owner 가 아닌 owner 를 --list --owner 로 보면 — 보여 주되 범위 밖이라고, 다루는 방법과 함께
    const outside = await cli(['--list', '--owner', owner], { env: { AUTH_ALLOWED_IDENTITY: 'fix4-lr-wrong@example.local' } });
    expect(outside.code, outside.err).toBe(0);
    const oLines = outside.out.split('\n');
    expect(oLines.slice(0, 2)).toEqual(lines.slice(0, 2));
    expect(oLines[2]).toMatch(/^범위 밖: 이 owner 는 1단계 내보내기 대상\(AUTH_ALLOWED_IDENTITY 의 owner\)이 아닙니다 — 해결 명령은 거부\(owner_not_exported\)\. /);
    expect(oLines[2]).toContain('1~7단계의 모든 명령 앞에 AUTH_ALLOWED_IDENTITY=<그 owner 의 로그인 identity> 를 붙여');
    expect(oLines.slice(3, -1)).toEqual(lines.slice(2, -1));
    expect(oLines.at(-1)).toContain(`해결: AUTH_ALLOWED_IDENTITY=<그 owner 의 로그인 identity> corepack pnpm ledger:resolve --owner ${owner}`);
    expect(outside.out).not.toContain('MSYS_NO_PATHCONV');
    for (const v of ['fix4-lr-wrong@example.local', identity]) expect(outside.out + outside.err, v).not.toContain(v);
    expect(await ownerLedger(owner)).toEqual(before);
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
      // FIX6(6차 검토 #6): 1단계가 묶음 검사 대신 적을 수 있는 기준값(--list 둘째 줄의 수)은 bundle:check 의 수와 같다 — 세지 않을 행(보통·실패 none·estimate·이전 행)도 같게 건너뜀
      const listLine2 = async () => (await cli(['--list', '--owner', owner])).out.split('\n')[1];
      expect(await listLine2()).toBe(`owner ${owner} · 후보 2행 · 아직 provider_unstorable 2행(0 이면 새 live 호출이 열려 있음)`);
      expect((await apply(argvOf(fillFor(U1, owner)))).code).toBe(0);
      const mid = await exportZip(db, owner, tmp, 'mid');
      expect(await checkBundleZip(mid)).toMatchObject({ ok: true, rows: { usage_ledger: 6 }, unresolved_live_usage: 1 });
      expect(await listLine2()).toBe(`owner ${owner} · 후보 2행 · 아직 provider_unstorable 1행(0 이면 새 live 호출이 열려 있음)`);
      const reserved2 = (await rowOf(db, U2)).reservedAmount;
      expect((await apply(argvOf({ ...fillFor(U2, owner), source: 'none', actual: reserved2, settled: reserved2 }))).code).toBe(0);
      const fin = await exportZip(db, owner, tmp, 'final');
      expect(await checkBundleZip(fin)).toMatchObject({ ok: true, rows: { usage_ledger: 6 }, unresolved_live_usage: 0 });
      expect(await listLine2()).toBe(`owner ${owner} · 후보 2행 · 아직 provider_unstorable 0행(0 이면 새 live 호출이 열려 있음)`);
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
      .filter((l) => /^(\S+=\S* )*corepack pnpm ledger:resolve --owner/.test(l));
    expect(lines, '문서에 해결 명령 틀이 정확히 한 줄').toHaveLength(1);
    // FIX5 는 "앞에 정확히 MSYS_NO_PATHCONV=1 하나" → FIX6(6차 검토 #5): 앞붙임 없이 corepack pnpm ledger:resolve 로 시작하고 MSYS_NO_PATHCONV 가 없다
    // (위 필터는 앞붙임이 있는 줄도 찾으므로, 앞붙임이 다시 생기면 여기서 실패한다)
    expect(lines[0]).not.toContain('MSYS_NO_PATHCONV');
    expect(lines[0]!.startsWith('corepack pnpm ledger:resolve --owner ')).toBe(true);
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

  it('문서: 손 SQL 블록이 없고, 해결 명령 틀(미리보기 → 같은 명령 + --expect <확인 지문> --confirm, 정정은 + --correct, 이미 올바른 행은 + --overwrite-valid)이 실제 CLI 로 그대로 동작한다. README·package.json 도 같은 명령', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-doc-'));
    try {
      const doc = docText();
      expect(doc).not.toMatch(/```sql\n[ \t]*-- LIVEL1 수동 해결/); // FIX2·FIX3 의 손 SQL 블록은 다시 생기지 않는다
      expect(doc).not.toMatch(/\bupdate usage_ledger\b/i);
      expect(doc).toContain('corepack pnpm ledger:resolve --list');
      // FIX5: 각 단계가 말해야 하는 것(5차 검토 #1·#2·#4·#5·#6 과 검토자 답의 문서 공백)
      const step = (prefix: string) => {
        const found = doc.split('\n').filter((l) => l.startsWith(prefix));
        expect(found, `문서 줄 ${prefix}`).toHaveLength(1);
        return found[0]!;
      };
      const expectAll = (text: string, label: string, parts: string[]) => {
        for (const t of parts) expect(text, `${label}: ${t}`).toContain(t);
      };
      expectAll(step('1. **멈춤·백업**'), '1단계', ['`AUTH_ALLOWED_IDENTITY`)의 owner 하나뿐', 'AUTH_ALLOWED_IDENTITY=<그 owner 의 로그인 identity>', 'corepack pnpm bundle:check', '`unresolved_live_usage`', '적어 둔다']);
      // FIX6(6차 검토 #6): 옛 행 때문에 백업 묶음의 bundle:check 가 integrity 로 거부되면 --list 둘째 줄의 수를 기준값으로(7-③ 이 그 값과 비교)
      expectAll(step('1. **멈춤·백업**'), '1단계 옛 행', [
        'exit 1·`"error":"integrity"`',
        '`반쯤 끝난 기록을 다시 만듦` 이나 `복원 검사 거부`',
        '다시 내보내거나 지우지 않는다',
        '2단계 `--list` 의 둘째 줄 `아직 provider_unstorable N행` 의 N 을 적어 둔다',
        '7-③ 이 이 값과 비교한다',
      ]);
      expectAll(step('   ③ '), '7-③', [
        '1단계에서 적어 둔 값(백업 묶음의 `unresolved_live_usage`, 그 묶음이 integrity 로 거부됐으면 대신 적은 2단계 `--list` 의 `아직 provider_unstorable N행`)',
        '6단계 전에 `usage_source provider_unstorable` 이던 행',
        'integrity 로 거부되는 것도 정상',
      ]);
      // FIX6(6차 검토 #5): 문서·README 어디에도 MSYS_NO_PATHCONV 앞붙임 명령이 없다(설명 문장은 "붙이지 않는다" 로만)
      expect(doc).not.toMatch(/MSYS_NO_PATHCONV=1\s+(corepack\s+)?pnpm/);
      expect(doc.split('\n').filter((l) => l.includes('MSYS_NO_PATHCONV')).every((l) => l.includes('붙이지 않는다') || l.includes('없앴다'))).toBe(true);
      // FIX6(6차 검토 #1·#5): 4단계 표 — --by·--reason 의 쓰지 못하는 문자(표 칸 안의 | 는 \| 로)
      expectAll(step('   | `--by` |'), '4단계 --by', ['`"`', '`%`', '`\\`', '`&`·`\\|`·`<`·`>`·`^`', '`/` 로 시작할 수 없다', '`text_shell_unsafe`', '`text_blank`']);
      expectAll(step('   | `--reason` |'), '4단계 --reason', ['`&`·`\\|`·`<`·`>`·`^`', '`/` 로 시작하는 값']);
      const s2 = step('2. **확인');
      expectAll(s2, '2단계', ['원장 행·감사 기록은 바꾸지 않는다', 'migration', '범위 밖:', '거부(owner_not_exported)', 'AUTH_ALLOWED_IDENTITY=<그 owner 의 로그인 identity>', 'DB 폴더가 없습니다(DATABASE_URL 확인) — 아무것도 만들지 않았습니다.', '정정만(--correct --overwrite-valid — 이미 복원 검사 통과)']);
      expect(s2).not.toContain('아무것도 쓰지 않는다');
      expectAll(step('6. **미리보기'), '6단계', ['셸을 두 번 지난다', 'cmd.exe [미확인']);
      // FIX5 는 "두 번째 셸이 바꾸는 문자를 명령이 막는다"·"앞의 MSYS_NO_PATHCONV=1" → FIX6(6차 검토 #1·#5): 거부는 도착한 문자만 보는 일관성 규칙,
      // Linux·macOS 는 그대로 도착, Windows cmd.exe·Git Bash 변환은 표시 줄로만, 앞붙임은 붙이지 않는다([추정] shim)
      const shellBullets = doc.split('\n').filter((l) => /^ {3}- (큰따옴표|명령 앞에|그래도)/.test(l));
      expect(shellBullets).toHaveLength(3);
      expectAll(shellBullets.join('\n'), '6단계 셸', [
        '거부(text_shell_unsafe)',
        '`&`·`|`·`<`·`>`·`^`',
        '값을 `/` 로 시작하지 않는다',
        '일관성 규칙',
        '**도착했을 때만**',
        'Linux·macOS 에서는 고정한 pnpm 12.6.0',
        'cmd.exe [미확인]',
        '`%VAR%` 확장',
        '**프로그램이 시작하기 전에**',
        '`--reason=\'/var/log 확인\'` 은 `C:/…/var/log 확인` 으로 도착해 거부되지 않는다',
        '명령 앞에 `MSYS_NO_PATHCONV=1` 을 붙이지 않는다',
        '[추정]',
        'sh shim',
        '`resolved_by:`·`reason:` 줄이 뜻한 글과 같은지',
      ]);
      expect(shellBullets.join('\n')).not.toContain('로 막는다');
      expect(shellBullets.join('\n')).not.toContain('`%VAR%` 를 환경변수 값으로 바꾼다');
      expectAll(step('   - **① 미리보기'), '6-①', ['`resolved_by: "…"`·`reason: "…"`', '`확인 지문: <16자리 16진수>`', '--expect <확인 지문> --confirm']);
      // FIX6(FIX5 Q3·6차 검토 #2): 정정의 전 → 후(형식 검사)·기본 무시 문자 이스케이프
      expectAll(step('   - **① 미리보기'), '6-① FIX6', ['`settled_amount: 전 → 후`', '`resolved_at: 전 → (실행 시각)`', '`(형식 밖 값)`', '`(없음)`', '정정 전 `resolved_by`·`reason` 은 보여 주지 않는다', 'U+3164']);
      expect(step('   - **① 미리보기')).not.toContain('값은 출력하지 않음'); // FIX4 의 길이만 보여 주던 문구
      expectAll(step('   - **② 적용'), '6-②', ['` --expect <확인 지문> --confirm`', '`거부(expect_mismatch)`', '트랜잭션을 열기 전에', '`updated 1` 뒤에 exit 1', '`거부(needs_correct)`', '모두 되돌린다', '`settled_amount_before`·`resolved_at_before`']);
      expect(step('   - **② 적용')).not.toContain('미리보기 때와 같은지'); // FIX4 의 사실과 다르던 문구(같은 실행 안에서만 비교)
      expectAll(step('   - **이미 `resolution`'), '6-정정', ['`거부(already_valid)`', '`--correct --overwrite-valid`', '`거부(overwrite_not_needed)`', '이전 `resolved_by`·`reason` 은 1단계 백업 묶음에만 남고']);
      expectAll(step('   - 입력 거부 코드'), '6-코드', ['`text_shell_unsafe`', '`"`·`%`·`\\`·`&`·`|`·`<`·`>`·`^` 또는 `/` 로 시작', '`already_valid`', '`overwrite_not_needed`', '`owner_not_exported`', '`expect_mismatch`', '`text_blank`']);
      expectAll(step('   ④ '), '7-④', ['성공은 exit 0', '`"ok":true`']);
      const tpl = docCommand();
      const { owner, ledgerId } = await unstorableRun(db, 'fix4-lr-doc@example.local');
      const values = { OWNER_ID: owner, LEDGER_ID: ledgerId, USAGE_SOURCE: 'provider', ACTUAL: '9.950000', SETTLED: '9.950000', RESOLVED_BY: 'operator', REASON: '콘솔 확인 — 실제 청구 9.95 USD' };
      const argv = fillDoc(tpl, values);
      const before = await ownerLedger(owner);
      const pv = await cli(argv);
      expect(pv.code, pv.err).toBe(0);
      expect(pv.out.split('\n')).toContain(`reason: ${JSON.stringify(values.REASON)}`);
      expect(await ownerLedger(owner)).toEqual(before);
      const fp = fpOf(pv.out);
      const ok = await cli([...argv, '--expect', fp, '--confirm']);
      expect(ok.code, ok.err).toBe(0);
      expect((await rowOf(db, ledgerId)).pricingSnapshot).toMatchObject({ usage_source: 'provider', resolution: { reason: values.REASON, resolved_by: 'operator' } });
      expect(await checkBundleZip(await exportZip(db, owner, tmp, 'doc'))).toMatchObject({ ok: true, unresolved_live_usage: 0 });
      // 이미 올바른 행의 사유 고쳐 쓰기: FIX4 는 --correct --confirm 만으로 적용 → FIX5 는 --correct 만으로는 미리보기부터 거부(already_valid),
      // --correct --overwrite-valid 미리보기 → 그 지문으로 적용
      const corrArgv = fillDoc(tpl, { ...values, REASON: '정정: 콘솔 재확인' });
      const refused = await cli([...corrArgv, '--correct']);
      expect([refused.code, refused.err.includes('거부(already_valid)')]).toEqual([1, true]);
      const corr = await apply([...corrArgv, '--correct', '--overwrite-valid']);
      expect(corr.code, corr.err).toBe(0);
      expect(((await rowOf(db, ledgerId)).pricingSnapshot as Snap).resolution.reason).toBe('정정: 콘솔 재확인');
      const readme = readFileSync(path.join(APP, 'README_KO.md'), 'utf8');
      expect(readme).toContain('pnpm ledger:resolve');
      const readmeLine = readme.split('\n').find((l) => l.includes('pnpm ledger:resolve --owner'))!;
      // FIX5 는 README 줄에 'MSYS_NO_PATHCONV=1' 이 있어야 했다 → FIX6(6차 검토 #5): README 어디에도 없고, 명령은 `pnpm ledger:resolve --owner` 로 시작
      for (const t of ['--expect <확인 지문> --confirm', '--correct [--overwrite-valid]', '`pnpm ledger:resolve --owner <id>', '`overwrite_not_needed`', '`&`·`\\|`·`<`·`>`·`^` 와 `/` 로 시작하는 값 불가']) {
        expect(readmeLine, t).toContain(t);
      }
      expect(readme).not.toContain('MSYS_NO_PATHCONV');
      expect(readmeLine).not.toContain('[--confirm]');
      const pkg = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      expect(pkg.scripts['ledger:resolve']).toBe('tsx packages/db/scripts/ledger-resolve.ts');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('실제 스크립트: 사용법 exit 2(DB 폴더 만들지 않음) · DB 폴더가 없으면 --list·미리보기 exit 1(만들지 않음, 상대 경로는 워크스페이스 루트 기준) · 다른 프로세스가 연 DB → 잠금 안내 exit 1 · 파일 DB 에서 미리보기 exit 0(무변경) → --expect 없는 --confirm exit 2 → --expect <지문> --confirm exit 0 "updated 1" · 비밀 env 는 출력에 없음', async () => {
    const ws = mkdtempSync(path.join(tmpdir(), 'cs-fix4-lr-ws-'));
    try {
      // 임시 작업 폴더 = 워크스페이스 루트(.env.local 없음) — 실제 ./data·.env.local 을 읽지 않는다
      writeFileSync(path.join(ws, 'pnpm-workspace.yaml'), 'packages: []\n');
      cpSync(path.join(APP, 'packages/db/drizzle'), path.join(ws, 'packages/db/drizzle'), { recursive: true });
      const dbDir = path.join(ws, 'data', 'pglite-ledger');
      const identity = 'fix4-lr-script@example.local';
      // 1단계 내보내기 owner = 이 시험의 owner(FIX5 #6). 실제 모양의 비밀을 env 로 넘긴다(FIX5 #7) — 시험 프로세스의 값이 아니라 이 값들
      const env = (extra: Record<string, string>) => ({ ...process.env, AUTH_ALLOWED_IDENTITY: identity, ...SECRET_ENV, ...extra });
      const runIn = (cwd: string, databaseUrl: string, args: string[]) => {
        const r = spawnSync(process.execPath, [TSX_CLI, RESOLVE_SCRIPT, ...args], { cwd, encoding: 'utf8', timeout: 180_000, env: env({ DATABASE_URL: databaseUrl }) });
        assertNoLeak({ code: r.status ?? -1, out: r.stdout, err: r.stderr }, `script ${args.join(' ').slice(0, 80)}`, args.includes('--list'));
        return r;
      };
      const run = (args: string[]) => runIn(ws, dbDir, args);
      const usage = run([]);
      expect(usage.status, usage.stderr).toBe(2);
      expect(usage.stderr).toContain('사용법');
      expect(existsSync(dbDir)).toBe(false);
      // FIX5(5차 검토 #2): 폴더가 없는 DATABASE_URL(절대 경로)로 --list·미리보기·적용 → exit 1, 그 폴더(와 위 data/)를 만들지 않는다
      const fakeOwner = randomUUID();
      const missingArgs = argvOf({ ...fillFor(randomUUID(), fakeOwner) });
      for (const args of [['--list'], ['--list', '--owner', fakeOwner], missingArgs, [...missingArgs, '--expect', DUMMY_FP, '--confirm']]) {
        const r = run(args);
        expect(r.status, `${args[0]}: ${r.stderr}`).toBe(1);
        expect(r.stderr.trim()).toBe('DB 폴더가 없습니다(DATABASE_URL 확인) — 아무것도 만들지 않았습니다.');
        expect(r.stdout).toBe('');
        expect(existsSync(path.join(ws, 'data')), args[0]).toBe(false);
      }
      // 상대 경로는 cwd 가 아니라 워크스페이스 루트 기준(createDb 와 같은 pgliteDataDir): cwd 아래에는 그 이름의 폴더가 있어도 루트 아래에 없으면 거부
      const sub = path.join(ws, 'sub');
      mkdirSync(path.join(sub, 'data', 'rel-db'), { recursive: true });
      const rel = runIn(sub, './data/rel-db', ['--list']);
      expect(rel.status, rel.stderr).toBe(1);
      expect(rel.stderr).toContain('DB 폴더가 없습니다(DATABASE_URL 확인)');
      expect([existsSync(path.join(ws, 'data')), readdirSync(path.join(sub, 'data', 'rel-db'))]).toEqual([false, []]);
      rmSync(sub, { recursive: true, force: true });
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
      expect(pv.stdout).toContain(PREVIEW_HEADER);
      expect(pv.stdout.split('\n')).toContain(`resolved_by: ${JSON.stringify(BY)}`);
      const fp = fpOf(pv.stdout);
      const check1 = await openDb({ DB_DRIVER: 'pglite', DATABASE_URL: dbDir });
      try {
        expect(await hasUnresolvedLiveUsage(check1.db, owner)).toBe(true);
      } finally {
        await check1.close();
      }
      // FIX4 에서는 적용됐던 --expect 없는 --confirm → 사용법 오류 exit 2(DB 를 열지 않음)
      const bare = run([...args, '--confirm']);
      expect(bare.status, bare.stderr).toBe(2);
      expect(bare.stderr).toContain('--confirm 에는 --expect <확인 지문> 이 필요합니다');
      const ok = run([...args, '--expect', fp, '--confirm']);
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
