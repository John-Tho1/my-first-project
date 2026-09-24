import { describe, expect, it } from 'vitest';
import { buildBundle, parseBundle, stableStringify, type BundleTables } from './bundle';
import {
  assistInputVersion,
  assistMaterial,
  assistRequestSchema,
  blocksToList,
  brandProfileCreateSchema,
  buildAssistPrompt,
  claimNeedsConfirmation,
  interviewAnswersSchema,
  linesToList,
  PROMPT_VERSION,
  unconfirmedExperienceClaims,
  type AssistPromptInput,
} from './writing';

const brand = {
  version: 2,
  penName: '가상 필명',
  audience: '해외영업 실무자',
  pillars: ['해외영업', 'AI 활용'],
  styleRules: ['짧은 문장'],
  tone: 'formal',
  avoidPhrases: ['혁신적인'],
  ctaRules: ['질문으로 끝내기'],
  sampleTexts: ['예문 하나.\n둘째 줄.'],
};
const A1 = { id: 'b-1', questionKey: 'judgment', question: '판단?', answer: '제가 먼저 연락했습니다.' };
const A2 = { id: 'a-2', questionKey: 'situation', question: '상황?', answer: '분기 회의 직후였습니다.' };

function input(over: Partial<AssistPromptInput> = {}): AssistPromptInput {
  return {
    mode: 'draft',
    inputVersion: 'cv:x;bp:2;ans:a-2,b-1',
    brand,
    answers: [A1, A2],
    title: '가상 원고',
    body: '본문 첫 줄\n둘째 줄',
    ...over,
  };
}

describe('buildAssistPrompt(결정적)', () => {
  it('같은 입력 → 같은 문자열, 답변 순서와 무관', () => {
    const a = buildAssistPrompt(input());
    expect(buildAssistPrompt(input())).toBe(a);
    expect(buildAssistPrompt(input({ answers: [A2, A1] }))).toBe(a);
  });

  it('브랜드·답변(질문 순서)·본문·지시문·프롬프트 버전을 담는다', () => {
    const p = buildAssistPrompt(input());
    expect(p).toContain(PROMPT_VERSION);
    expect(p).toContain('입력 버전: cv:x;bp:2;ans:a-2,b-1');
    expect(p).toContain('필명: 가상 필명');
    expect(p).toContain('말투: 존댓말');
    expect(p).toContain('- 혁신적인');
    expect(p).toContain('[예문 1]\n예문 하나.\n둘째 줄.');
    expect(p.indexOf('분기 회의 직후였습니다.')).toBeLessThan(p.indexOf('제가 먼저 연락했습니다.')); // situation → judgment
    expect(p).toContain('본문 첫 줄\n둘째 줄');
    expect(p).toContain('없는 경험·사례·수치·인용·출처를 만들지 마세요');
  });

  it('모드·본문·브랜드 버전이 바뀌면 프롬프트도 바뀐다', () => {
    const a = buildAssistPrompt(input());
    expect(buildAssistPrompt(input({ mode: 'outline' }))).not.toBe(a);
    expect(buildAssistPrompt(input({ body: '다른 본문' }))).not.toBe(a);
    expect(buildAssistPrompt(input({ brand: { ...brand, version: 3 } }))).not.toBe(a);
  });

  it('환경변수 값(비밀)을 넣지 않는다', () => {
    const p = buildAssistPrompt(input());
    for (const v of Object.values(process.env)) if (v && v.length >= 12) expect(p.includes(v)).toBe(false);
  });

  it('assistMaterial: 답변(질문 순서) → 본문, assistInputVersion: 답변 id 정렬', () => {
    expect(assistMaterial([A1, A2], '본문')).toBe('분기 회의 직후였습니다.\n제가 먼저 연락했습니다.\n본문');
    expect(assistInputVersion({ contentVersionId: 'v', brandProfileVersion: 1, answerIds: ['b', 'a'] })).toBe('cv:v;bp:1;ans:a,b');
  });
});

describe('A03 게이트 unconfirmedExperienceClaims', () => {
  const exp = { text: '제가 직접 협상했습니다.', kind: 'experience', needs_user_confirmation: true };
  const op = { text: '의견입니다.', kind: 'opinion', needs_user_confirmation: false };

  it('채택하지 않은 run 의 경험 claim 은 막지 않는다', () => {
    expect(unconfirmedExperienceClaims([{ runId: 'r1', adopted: false, claims: [exp] }], [])).toEqual([]);
  });

  it('채택한 run 의 미확인 경험 claim 만 돌려준다(의견 제외)', () => {
    expect(unconfirmedExperienceClaims([{ runId: 'r1', adopted: true, claims: [op, exp] }], [])).toEqual([
      { run_id: 'r1', claim_index: 1, text: exp.text },
    ]);
  });

  it('확인하면 비고, 다른 run 의 확인은 인정하지 않는다', () => {
    const runs = [{ runId: 'r1', adopted: true, claims: [exp] }];
    expect(unconfirmedExperienceClaims(runs, [{ runId: 'r1', claimIndex: 0 }])).toEqual([]);
    expect(unconfirmedExperienceClaims(runs, [{ runId: 'r2', claimIndex: 0 }])).toHaveLength(1);
  });

  it('이전에 채택한 run 은 뒤의 run 으로 가려지지 않는다', () => {
    const runs = [
      { runId: 'r1', adopted: true, claims: [exp] },
      { runId: 'r2', adopted: true, claims: [op] },
    ];
    expect(unconfirmedExperienceClaims(runs, [])).toEqual([{ run_id: 'r1', claim_index: 0, text: exp.text }]);
  });

  it('kind 가 experience 이거나 needs_user_confirmation 이면 확인 대상', () => {
    expect(claimNeedsConfirmation(exp)).toBe(true);
    expect(claimNeedsConfirmation(op)).toBe(false);
    expect(claimNeedsConfirmation({ text: 'x', kind: 'fact', needs_user_confirmation: true })).toBe(true);
  });
});

describe('입력 스키마', () => {
  it('brandProfileCreateSchema: 기본값·말투 제한·모르는 칸 거부', () => {
    const r = brandProfileCreateSchema.parse({ base_version: 1, pen_name: 'p', audience: 'a', pillars: ['x'] });
    expect(r).toMatchObject({ tone: 'formal', style_rules: [], avoid_phrases: [], cta_rules: [], sample_texts: [] });
    expect(brandProfileCreateSchema.safeParse({ base_version: 1, pen_name: 'p', audience: 'a', pillars: ['x'], tone: 'rude' }).success).toBe(false);
    expect(brandProfileCreateSchema.safeParse({ base_version: 1, pen_name: 'p', audience: 'a', pillars: [] }).success).toBe(false);
    expect(brandProfileCreateSchema.safeParse({ base_version: 1, pen_name: 'p', audience: 'a', pillars: ['x'], owner_id: 'y' }).success).toBe(false);
  });

  it('interviewAnswersSchema: 정해진 3개 키만', () => {
    expect(interviewAnswersSchema.safeParse({ answers: { situation: 'a' } }).success).toBe(true);
    expect(interviewAnswersSchema.safeParse({ answers: { extra: 'a' } }).success).toBe(false);
  });

  it('assistRequestSchema: 모드 3개, 기본 answer_ids []', () => {
    expect(assistRequestSchema.parse({ mode: 'outline', base_version: 1, brand_profile_version: 1 }).answer_ids).toEqual([]);
    expect(assistRequestSchema.safeParse({ mode: 'publish', base_version: 1, brand_profile_version: 1 }).success).toBe(false);
  });

  it('linesToList·blocksToList', () => {
    expect(linesToList(' a \r\n\r\nb\n')).toEqual(['a', 'b']);
    expect(blocksToList('첫 예문\n둘째 줄\n\n---\n\n다음 예문')).toEqual(['첫 예문\n둘째 줄', '다음 예문']);
  });
});

describe('묶음 호환: 0005 이전 묶음', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const BP = '22222222-2222-4222-8222-222222222222';
  const TS = '2026-09-01T06:10:00.123456Z';
  const old = ['0000_t01_m1_core', '0001_t02_sessions', '0002_t03_captures', '0003_t04_contents', '0004_t05_exports'];
  const current = [...old, '0005_t06_writing'];

  function oldBundle(opts: { dropTableFiles: boolean; migrations: string[] }) {
    const tables = {
      users: [{ id: OWNER, identity_masked: 'ow***@example.local' }],
      brand_profiles: [{ id: BP, version: 1, pen_name: 'p', audience: 'a', pillars: ['x'], style_rules: [], created_at: TS }],
      sources: [],
      source_versions: [],
      captures: [],
      capture_revisions: [],
      ideas: [],
      idea_captures: [],
      contents: [],
      content_versions: [],
      content_captures: [],
      interview_answers: [],
      generation_runs: [],
      claim_confirmations: [],
      assets: [],
      audit_events: [],
    } as unknown as BundleTables;
    const b = buildBundle({
      exportId: '77777777-7777-4777-8777-777777777777',
      exportedAt: '2026-09-24T12:00:00.000Z',
      appVersion: '0.1.0',
      migrations: opts.migrations,
      owner: { id: OWNER, identityMasked: 'ow***@example.local' },
      tables,
      assetBytes: new Map(),
    });
    if (!opts.dropTableFiles) return b.entries;
    const drop = new Set(['data/interview_answers.json', 'data/generation_runs.json', 'data/claim_confirmations.json']);
    const manifest = structuredClone(b.manifest);
    for (const t of ['interview_answers', 'generation_runs', 'claim_confirmations']) delete manifest.tables[t];
    manifest.files = manifest.files.filter((f) => !drop.has(f.path));
    const bytes = new Uint8Array(Buffer.from(stableStringify(manifest), 'utf8'));
    return [{ path: 'manifest.json', bytes }, ...b.entries.slice(1).filter((e) => !drop.has(e.path))];
  }

  it('새 표 파일이 없는 M1 묶음은 빈 표로 읽고, 브랜드 프로필 새 열은 DB 기본값으로 채운다', () => {
    const p = parseBundle(oldBundle({ dropTableFiles: true, migrations: old }), { migrations: current });
    expect(p.tables.interview_answers).toEqual([]);
    expect(p.tables.generation_runs).toEqual([]);
    expect(p.tables.claim_confirmations).toEqual([]);
    expect(p.tables.brand_profiles[0]).toMatchObject({ tone: 'formal', avoid_phrases: [], cta_rules: [], sample_texts: [] });
  });

  it('0005 이후 묶음에서 새 표 파일이 빠지면 거부한다', () => {
    expect(() => parseBundle(oldBundle({ dropTableFiles: true, migrations: current }), { migrations: current })).toThrow(
      expect.objectContaining({ code: 'invalid_rows' }),
    );
  });
});

describe('FIX-T06 묶음 무결성: ai_run_id·답변 seq', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const BP = '22222222-2222-4222-8222-222222222222';
  const CA = '33333333-3333-4333-8333-33333333333a';
  const CB = '33333333-3333-4333-8333-33333333333b';
  const VA = '44444444-4444-4444-8444-44444444444a';
  const VB = '44444444-4444-4444-8444-44444444444b';
  const VA2 = '44444444-4444-4444-8444-4444444444a2';
  const RB = '55555555-5555-4555-8555-55555555555b';
  const TS = '2026-09-01T06:10:00.123456Z';
  const content = (id: string, v: string) => ({
    id,
    idea_id: null,
    series: null,
    title: 't',
    audience: null,
    tags: [],
    revision: 1,
    current_version_id: v,
    lifecycle: 'draft' as const,
    created_at: TS,
    updated_at: TS,
  });
  const version = (id: string, contentId: string, n: number, aiRunId: string | null) => ({
    id,
    content_id: contentId,
    version: n,
    body: 'b',
    created_by: 'owner',
    ai_run_id: aiRunId,
    created_at: TS,
    note: null,
  });
  function tables(adoptedRun: string | null, answers: BundleTables['interview_answers'] = []): BundleTables {
    return {
      users: [{ id: OWNER, identity_masked: 'ow***@example.local' }],
      brand_profiles: [
        { id: BP, version: 1, pen_name: 'p', audience: 'a', pillars: ['x'], style_rules: [], created_at: TS, tone: 'formal', avoid_phrases: [], cta_rules: [], sample_texts: [] },
      ],
      sources: [],
      source_versions: [],
      captures: [],
      capture_revisions: [],
      ideas: [],
      idea_captures: [],
      contents: [content(CA, VA2), content(CB, VB)],
      content_versions: [version(VA, CA, 1, null), version(VA2, CA, 2, adoptedRun), version(VB, CB, 1, null)],
      content_captures: [],
      interview_answers: answers,
      generation_runs: [
        {
          id: RB,
          content_id: CB,
          mode: 'draft',
          input_version_id: VB,
          brand_profile_id: BP,
          input_version_refs: {},
          prompt_version: 'v',
          provider: 'mock',
          model: 'mock',
          status: 'succeeded',
          output_ref: VB,
          output_json: { claims: [] },
          error: null,
          created_at: TS,
          finished_at: TS,
        },
      ],
      claim_confirmations: [],
      assets: [],
      audit_events: [],
    };
  }
  const build = (t: BundleTables) =>
    buildBundle({
      exportId: '77777777-7777-4777-8777-777777777777',
      exportedAt: '2026-09-24T12:00:00.000Z',
      appVersion: '0.1.0',
      migrations: ['0000_a'],
      owner: { id: OWNER, identityMasked: 'ow***@example.local' },
      tables: t,
      assetBytes: new Map(),
    }).entries;

  it('다른 원고의 run 을 가리키는 ai_run_id → integrity 로 거부', () => {
    expect(() => parseBundle(build(tables(RB)), { migrations: ['0000_a'] })).toThrow(
      expect.objectContaining({ code: 'integrity', extra: { problems: ['content_versions.ai_run_id → generation_runs(같은 원고)'] } }),
    );
    expect(() => parseBundle(build(tables(null)), { migrations: ['0000_a'] })).not.toThrow();
  });

  it('seq 가 없는 0005 묶음의 답변은 원고별 (created_at, id) 순서로 1..n', () => {
    const a = (id: string, at: string) => ({ id, content_id: CA, question_key: 'situation' as const, question: 'q', answer: id, created_at: at });
    const rows = [
      a('66666666-6666-4666-8666-666666666662', TS),
      a('66666666-6666-4666-8666-666666666661', TS),
      a('66666666-6666-4666-8666-666666666660', '2026-09-02T00:00:00.000000Z'),
    ];
    const p = parseBundle(build(tables(null, rows)), { migrations: ['0000_a'] });
    const seqOf = Object.fromEntries(p.tables.interview_answers.map((r) => [r.id.slice(-1), r.seq]));
    expect(seqOf).toEqual({ '1': 1, '2': 2, '0': 3 });
  });
});
