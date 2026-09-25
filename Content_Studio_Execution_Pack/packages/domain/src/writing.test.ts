import { describe, expect, it } from 'vitest';
import { buildBundle, parseBundle, stableStringify, type BundleTables } from './bundle';
import {
  assistInputVersion,
  assistMaterial,
  assistRequestSchema,
  blocksToList,
  bodyContainsClaim,
  brandProfileCreateSchema,
  buildAssistPrompt,
  claimNeedsConfirmation,
  interviewAnswersSchema,
  isClaimResolved,
  linesToList,
  PROMPT_VERSION,
  sanitizeLlmOutput,
  hasFreeTextCitation,
  citationLabel,
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
      claims: [],
      claim_sources: [],
      usage_ledger: [],
      variants: [],
      variant_versions: [],
      variant_assets: [],
      assets: [],
      transcription_jobs: [],
      transcripts: [],
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
          variant_id: null,
          // 채택 이력과 맞춘다(FIX-T09 round 2 검사)
          proposal_status: adoptedRun ? ('adopted' as const) : ('proposed' as const),
        },
      ],
      claim_confirmations: [],
      claims: [],
      claim_sources: [],
      usage_ledger: [],
      variants: [],
      variant_versions: [],
      variant_assets: [],
      assets: [],
      transcription_jobs: [],
      transcripts: [],
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

describe('FIX-T06 round 2: 본문 포함 검사와 제외 해결', () => {
  const claim = '제가 직접 현지 법인을 설득했습니다.';

  it('bodyContainsClaim: 공백·문장부호·대소문자·전각 차이는 무시', () => {
    expect(bodyContainsClaim(`앞 문장.\n${claim}\n뒤`, claim)).toBe(true);
    expect(bodyContainsClaim('제가   직접\n현지 법인을, 설득했습니다!!', claim)).toBe(true);
    expect(bodyContainsClaim('I SAID: "Hello, World"', 'i said hello world')).toBe(true);
    expect(bodyContainsClaim('ＡＢＣ１２３', 'abc 123')).toBe(true);
  });

  it('bodyContainsClaim: 퍼지 일치가 아니다 — 한 글자만 달라도, 일부만 있어도 "없음"', () => {
    expect(bodyContainsClaim('제가 직접 현지 법인을 설득했어요.', claim)).toBe(false);
    expect(bodyContainsClaim('제가 직접 현지 법인을', claim)).toBe(false);
    expect(bodyContainsClaim('', claim)).toBe(false);
  });

  it('bodyContainsClaim: 문장부호뿐인 claim 은 비교할 수 없으므로 "있음"(제외 불가)', () => {
    expect(bodyContainsClaim('아무 본문', '...!?')).toBe(true);
  });

  it('isClaimResolved: confirmed 는 영구, removed 는 현재 본문에 없을 때만, 본문을 모르면 미해결', () => {
    const removed = [{ runId: 'r', claimIndex: 0, resolution: 'removed' }];
    const confirmed = [{ runId: 'r', claimIndex: 0, resolution: 'confirmed' }];
    expect(isClaimResolved('r', 0, claim, confirmed, claim)).toBe(true);
    expect(isClaimResolved('r', 0, claim, [{ runId: 'r', claimIndex: 0 }], claim)).toBe(true); // 0006 이전 행 = confirmed
    expect(isClaimResolved('r', 0, claim, removed, '뺀 본문')).toBe(true);
    expect(isClaimResolved('r', 0, claim, removed, `다시 넣음 ${claim}`)).toBe(false);
    expect(isClaimResolved('r', 0, claim, removed, undefined)).toBe(false);
    expect(isClaimResolved('r', 1, claim, removed, '뺀 본문')).toBe(false);
    expect(isClaimResolved('r', 0, claim, [...removed, ...confirmed], `다시 넣음 ${claim}`)).toBe(true);
  });

  it('unconfirmedExperienceClaims: 제외한 문장을 다시 넣으면 다시 미해결', () => {
    const runs = [{ runId: 'r', adopted: true, claims: [{ text: claim, kind: 'experience', needs_user_confirmation: true }] }];
    const removed = [{ runId: 'r', claimIndex: 0, resolution: 'removed' }];
    expect(unconfirmedExperienceClaims(runs, removed, '뺀 본문')).toEqual([]);
    expect(unconfirmedExperienceClaims(runs, removed, claim)).toEqual([{ run_id: 'r', claim_index: 0, text: claim }]);
  });
});

describe('FIX-T07: 출력 정제·user_confirmed 복원 거부', () => {
  const FAKE = 'https://fake.example/report-2026';
  it('버린 출처가 글(본문·경고·질문·태그·claim 문장)에 있으면 출력 전체 실패(round 4), 목록에만 있으면 버리고 개수·경고', () => {
    const base = { result_type: 'draft' as const, input_version: 'v', proposed_tags: [] as string[], followup_questions: [] as string[], warnings: [] as string[] };
    const claims = [{ text: '시장 규모', kind: 'fact' as const, source_refs: [FAKE, 'ok-id-1'], needs_user_confirmation: false }];
    for (const where of ['proposed_text', 'warnings', 'followup_questions', 'proposed_tags', 'claim'] as const) {
      const o = { ...base, proposed_text: '본문', claims: claims.map((c) => ({ ...c })) } as Parameters<typeof sanitizeLlmOutput>[0] & { proposed_text: string };
      const mut = o as unknown as Record<string, unknown>;
      if (where === 'proposed_text') mut.proposed_text = `근거는 ${FAKE} 입니다`;
      else if (where === 'claim') (mut.claims as Array<{ text: string }>)[0]!.text = `시장 규모(${FAKE})`;
      else mut[where] = [`참고 ${FAKE}`];
      expect(() => sanitizeLlmOutput(o, ['ok-id-1']), where).toThrow(expect.objectContaining({ code: 'unverifiable_citation' }));
    }
    const { output, droppedTotal } = sanitizeLlmOutput({ ...base, proposed_text: '본문[1]', claims }, ['ok-id-1']);
    expect(droppedTotal).toBe(1);
    expect(JSON.stringify(output)).not.toMatch(/fake\.example/i);
    expect(output.proposed_text).toBe('본문[1]');
    expect(output.claims[0]).toMatchObject({ source_refs: ['ok-id-1'], dropped_source_refs: 1, needs_check: true, evidence_grade: 'source' });
    expect(output.warnings.at(-1)).toBe('출처 미확인: 허용 목록에 없는 출처 1건을 버렸습니다');
  });

  it('묶음의 claims.evidence_grade=user_confirmed 는 거부(확인은 claim_confirmations 에서만 파생)', () => {
    const OWNER = '11111111-1111-4111-8111-111111111111';
    const CT = '33333333-3333-4333-8333-333333333333';
    const CV = '44444444-4444-4444-8444-444444444444';
    const BP = '22222222-2222-4222-8222-222222222222';
    const RN = '55555555-5555-4555-8555-555555555555';
    const CL = '66666666-6666-4666-8666-666666666666';
    const TS = '2026-09-01T06:10:00.123456Z';
    const tables = {
      users: [{ id: OWNER, identity_masked: 'ow***@example.local' }],
      brand_profiles: [{ id: BP, version: 1, pen_name: 'p', audience: 'a', pillars: ['x'], style_rules: [], created_at: TS }],
      sources: [],
      source_versions: [],
      captures: [],
      capture_revisions: [],
      ideas: [],
      idea_captures: [],
      contents: [{ id: CT, idea_id: null, series: null, title: 't', audience: null, tags: [], revision: 1, current_version_id: CV, lifecycle: 'draft', created_at: TS, updated_at: TS }],
      content_versions: [{ id: CV, content_id: CT, version: 1, body: 'b', created_by: 'owner', ai_run_id: null, created_at: TS, note: null }],
      content_captures: [],
      variants: [],
      variant_versions: [],
      interview_answers: [],
      generation_runs: [
        { id: RN, content_id: CT, mode: 'draft', input_version_id: CV, brand_profile_id: BP, input_version_refs: {}, prompt_version: 'v', provider: 'mock', model: 'mock', status: 'succeeded', output_ref: CV, output_json: { claims: [] }, error: null, created_at: TS, finished_at: TS, variant_id: null },
      ],
      claim_confirmations: [],
      claims: [
        { id: CL, content_version_id: CV, run_id: RN, claim_index: 0, statement: 's', kind: 'experience', evidence_grade: 'user_confirmed', personal_experience_confirmed: true, needs_check: false, created_at: TS, variant_version_id: null },
      ],
      claim_sources: [],
      usage_ledger: [],
      assets: [],
      variant_assets: [],
      transcription_jobs: [],
      transcripts: [],
      audit_events: [],
    } as unknown as BundleTables;
    const b = buildBundle({
      exportId: '77777777-7777-4777-8777-777777777777',
      exportedAt: '2026-09-24T12:00:00.000Z',
      appVersion: '0.1.0',
      migrations: ['0000_a'],
      owner: { id: OWNER, identityMasked: 'ow***@example.local' },
      tables,
      assetBytes: new Map(),
    });
    expect(() => parseBundle(b.entries, { migrations: ['0000_a'] })).toThrow(expect.objectContaining({ code: 'invalid_rows' }));
  });
});

describe('FIX-T09: 묶음의 파생본 AI 참조는 같은 파생본의 variant run', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const BP = '22222222-2222-4222-8222-222222222222';
  const CT = '33333333-3333-4333-8333-333333333333';
  const CV = '44444444-4444-4444-8444-444444444444';
  const VT = '55555555-5555-4555-8555-55555555555a';
  const VB = '55555555-5555-4555-8555-55555555555b';
  const VTV = '66666666-6666-4666-8666-66666666666a';
  const VBV = '66666666-6666-4666-8666-66666666666b';
  const RT = '77777777-7777-4777-8777-77777777777a';
  const RB = '77777777-7777-4777-8777-77777777777b';
  const TS = '2026-09-01T06:10:00.123456Z';
  const run = (id: string, variant: string) => ({
    id, content_id: CT, mode: 'variant', input_version_id: CV, brand_profile_id: BP, input_version_refs: {}, prompt_version: 'v', provider: 'mock', model: 'mock',
    status: 'succeeded', output_ref: null, output_json: { claims: [] }, error: null, created_at: TS, finished_at: TS, variant_id: variant, proposal_status: 'proposed',
  });
  const vv = (id: string, variant: string, runId: string) => ({ id, variant_id: variant, version: 1, content_version_id: CV, body: 'b', metadata_json: {}, created_by: 'ai:mock', ai_run_id: runId, created_at: TS });
  function build(threadsRun: string) {
    const tables = {
      users: [{ id: OWNER, identity_masked: 'ow***@example.local' }],
      brand_profiles: [{ id: BP, version: 1, pen_name: 'p', audience: 'a', pillars: ['x'], style_rules: [], created_at: TS }],
      sources: [], source_versions: [], captures: [], capture_revisions: [], ideas: [], idea_captures: [],
      contents: [{ id: CT, idea_id: null, series: null, title: 't', audience: null, tags: [], revision: 1, current_version_id: CV, lifecycle: 'draft', created_at: TS, updated_at: TS }],
      content_versions: [{ id: CV, content_id: CT, version: 1, body: 'b', created_by: 'owner', ai_run_id: null, created_at: TS, note: null }],
      content_captures: [],
      variants: [
        { id: VT, content_id: CT, channel: 'threads', current_version_id: null, lifecycle: 'draft', created_at: TS, updated_at: TS },
        { id: VB, content_id: CT, channel: 'blog', current_version_id: null, lifecycle: 'draft', created_at: TS, updated_at: TS },
      ],
      variant_versions: [vv(VTV, VT, threadsRun), vv(VBV, VB, RB)],
      interview_answers: [],
      generation_runs: [run(RT, VT), run(RB, VB)],
      claim_confirmations: [], claims: [], claim_sources: [], usage_ledger: [], assets: [], variant_assets: [], transcription_jobs: [], transcripts: [], audit_events: [],
    } as unknown as BundleTables;
    return buildBundle({
      exportId: '88888888-8888-4888-8888-888888888888', exportedAt: '2026-09-24T12:00:00.000Z', appVersion: '0.1.0', migrations: ['0000_a'],
      owner: { id: OWNER, identityMasked: 'ow***@example.local' }, tables, assetBytes: new Map(),
    }).entries;
  }
  it('정상 연결은 통과, Threads 버전이 같은 원고의 Blog run 을 가리키면 integrity 거부', () => {
    expect(() => parseBundle(build(RT), { migrations: ['0000_a'] })).not.toThrow();
    expect(() => parseBundle(build(RB), { migrations: ['0000_a'] })).toThrow(
      expect.objectContaining({ code: 'integrity', extra: { problems: expect.arrayContaining(['variant_versions.ai_run_id → generation_runs(같은 파생본의 variant run)']) } }),
    );
  });
});

describe('FIX-T07 round 2: 출처 정제 범위(source_refs 에 기대지 않음)', () => {
  const base = { result_type: 'draft' as const, input_version: 'v', proposed_tags: [] as string[], followup_questions: [] as string[], warnings: [] as string[] };

  it('재현 1: source_refs [1] + 본문 [1], 허용 출처 없음 → unverifiable_citation(출력 전체 거부)', () => {
    expect(() =>
      sanitizeLlmOutput({ ...base, proposed_text: '보고서[1]에 따르면 시장이 컸다.', claims: [{ text: '시장이 컸다.', kind: 'fact', source_refs: ['[1]'], needs_user_confirmation: false }] }, []),
    ).toThrow(expect.objectContaining({ code: 'unverifiable_citation' }));
  });

  it('[n] 은 허용 출처 수 안이면 그대로(프롬프트 번호), 밖이면 거부 — source_refs 의 [n] 표기는 버리되 글의 [n] 은 막지 않는다', () => {
    const allowed = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];
    const ok = sanitizeLlmOutput({ ...base, proposed_text: '보고서[1]에 따르면', claims: [{ text: 't', kind: 'fact', source_refs: ['[1]'], needs_user_confirmation: false }] }, allowed);
    expect(ok.output.proposed_text).toBe('보고서[1]에 따르면');
    expect(() => sanitizeLlmOutput({ ...base, proposed_text: '보고서[2]', claims: [] }, allowed)).toThrow(expect.objectContaining({ code: 'unverifiable_citation' }));
  });

  it('재현 2: 가짜 URL·www·[출처: 가짜] 가 본문·경고·질문·claim 어디에 있어도(source_refs 비어도) 출력 전체 실패', () => {
    for (const t of ['자세한 내용은 https://fake.example/x?y=1 참고', 'www.other-fake.example 참고', '[출처: 가짜 보고서]']) {
      expect(() => sanitizeLlmOutput({ ...base, proposed_text: t, claims: [] }, []), t).toThrow(expect.objectContaining({ code: 'unverifiable_citation' }));
      expect(() => sanitizeLlmOutput({ ...base, proposed_text: '본문', warnings: [t], claims: [] }, []), t).toThrow(expect.objectContaining({ code: 'unverifiable_citation' }));
    }
  });

  it('허용 locator 와 같은 URL 이라도 자유문으로 쓰면 실패(구조화 인용 [n]·source_refs 만 허용)', () => {
    expect(() => sanitizeLlmOutput({ ...base, proposed_text: '출처: https://example.com/report', claims: [] }, ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])).toThrow(
      expect.objectContaining({ code: 'unverifiable_citation' }),
    );
  });
});

describe('FIX-T09 round 2: proposal_status 채움·모순 검사', () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const BP = '22222222-2222-4222-8222-222222222222';
  const CT = '33333333-3333-4333-8333-333333333333';
  const CV1 = '44444444-4444-4444-8444-444444444441';
  const CV2 = '44444444-4444-4444-8444-444444444442';
  const CV3 = '44444444-4444-4444-8444-444444444443';
  const R1 = '77777777-7777-4777-8777-777777777771';
  const TS = '2026-09-01T06:10:00.123456Z';
  function build(opts: { adopted: boolean; status?: 'proposed' | 'adopted' | 'dismissed' }) {
    const versions = [
      { id: CV1, content_id: CT, version: 1, body: 'b', created_by: 'owner', ai_run_id: null, created_at: TS, note: null },
      { id: CV2, content_id: CT, version: 2, body: 'p', created_by: 'ai:mock', ai_run_id: R1, created_at: TS, note: null },
      ...(opts.adopted ? [{ id: CV3, content_id: CT, version: 3, body: 'p', created_by: 'owner', ai_run_id: R1, created_at: TS, note: null }] : []),
    ];
    const r: Record<string, unknown> = {
      id: R1, content_id: CT, mode: 'draft', input_version_id: CV1, brand_profile_id: BP, input_version_refs: {}, prompt_version: 'v', provider: 'mock', model: 'mock',
      status: 'succeeded', output_ref: CV2, output_json: { claims: [] }, error: null, created_at: TS, finished_at: TS, variant_id: null,
    };
    if (opts.status) r.proposal_status = opts.status;
    const tables = {
      users: [{ id: OWNER, identity_masked: 'ow***@example.local' }],
      brand_profiles: [{ id: BP, version: 1, pen_name: 'p', audience: 'a', pillars: ['x'], style_rules: [], created_at: TS }],
      sources: [], source_versions: [], captures: [], capture_revisions: [], ideas: [], idea_captures: [],
      contents: [{ id: CT, idea_id: null, series: null, title: 't', audience: null, tags: [], revision: 1, current_version_id: opts.adopted ? CV3 : CV1, lifecycle: 'draft', created_at: TS, updated_at: TS }],
      content_versions: versions,
      content_captures: [], variants: [], variant_versions: [], interview_answers: [],
      generation_runs: [r],
      claim_confirmations: [], claims: [], claim_sources: [], usage_ledger: [], assets: [], variant_assets: [], transcription_jobs: [], transcripts: [], audit_events: [],
    } as unknown as BundleTables;
    return buildBundle({
      exportId: '88888888-8888-4888-8888-888888888888', exportedAt: '2026-09-24T12:00:00.000Z', appVersion: '0.1.0', migrations: ['0000_a'],
      owner: { id: OWNER, identityMasked: 'ow***@example.local' }, tables, assetBytes: new Map(),
    }).entries;
  }
  const status = (e: ReturnType<typeof build>) => parseBundle(e, { migrations: ['0000_a'] }).tables.generation_runs[0]!.proposal_status;

  it('0011 이전 묶음(상태 없음): 채택 버전이 있으면 adopted, 없으면 proposed', () => {
    expect(status(build({ adopted: true }))).toBe('adopted');
    expect(status(build({ adopted: false }))).toBe('proposed');
  });
  it('명시한 상태가 채택 이력과 모순이면 integrity 거부', () => {
    expect(() => status(build({ adopted: true, status: 'proposed' }))).toThrow(expect.objectContaining({ code: 'integrity' }));
    expect(() => status(build({ adopted: true, status: 'dismissed' }))).toThrow(expect.objectContaining({ code: 'integrity' }));
    expect(() => status(build({ adopted: false, status: 'adopted' }))).toThrow(expect.objectContaining({ code: 'integrity' }));
    expect(status(build({ adopted: false, status: 'dismissed' }))).toBe('dismissed');
    expect(status(build({ adopted: true, status: 'adopted' }))).toBe('adopted');
  });
});

describe('FIX-T07 round 4: 구조화 인용만 — 자유문 출처 표기는 탐지해 출력 전체 실패(fail-closed)', () => {
  const base = { result_type: 'draft' as const, input_version: 'v', proposed_tags: [] as string[], followup_questions: [] as string[], warnings: [] as string[], claims: [] };
  const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const one = [ID];
  const run = (text: string, allowed: readonly string[] = one) => sanitizeLlmOutput({ ...base, proposed_text: text }, allowed);
  const fails = (text: string, allowed: readonly string[] = one) =>
    expect(() => run(text, allowed), text).toThrow(expect.objectContaining({ code: 'unverifiable_citation' }));

  it('라운드 2–3 우회 문자열은 모두 실패(허용 출처가 있어도)', () => {
    for (const t of [
      `근거 https://fake.example/${ID} 입니다`,
      'example.com?doc=x 참고',
      'example.com:8443/report 참고',
      'https://example.com/report(other)',
      '출처:fake.example',
      '출처：fake.example',
      '//fake.example/report 참고',
      'fake．example 참고',
      'fake｡example 참고',
      'fabricated.example/report',
      'fabricated.example 입니다',
      '(fake.example)',
      'ＷＷＷ．ｆａｋｅ．ｅｘａｍｐｌｅ',
      'HTTPS://FAKE.EXAMPLE',
      '가공연구소.한국 이 아닌 가공연구소.com 에서',
    ]) {
      fails(t);
      fails(t, []);
    }
  });

  it('버린 자유문 참조(가공연구소 2025 보고서)가 본문·claim·경고·질문에 남으면 실패', () => {
    const claims = [{ text: '시장이 컸다', kind: 'fact' as const, source_refs: ['가공연구소 2025 보고서'], needs_user_confirmation: false }];
    expect(() => sanitizeLlmOutput({ ...base, proposed_text: '가공연구소 2025 보고서에 따르면 시장이 컸다.', claims }, [])).toThrow(
      expect.objectContaining({ code: 'unverifiable_citation' }),
    );
    expect(() =>
      sanitizeLlmOutput({ ...base, proposed_text: '시장이 컸다.', claims: [{ ...claims[0]!, text: '가공연구소  2025 보고서 기준' }] }, []),
    ).not.toThrow(); // 공백이 다르면 다른 문구(정확한 문구만 탐지 — 한계, D13)
    expect(() => sanitizeLlmOutput({ ...base, proposed_text: '시장이 컸다.', followup_questions: ['가공연구소 2025 보고서를 볼까요?'], claims }, [])).toThrow(
      expect.objectContaining({ code: 'unverifiable_citation' }),
    );
    // 글에 없으면 버리고 개수만
    const ok = sanitizeLlmOutput({ ...base, proposed_text: '시장이 컸다.', claims }, []);
    expect(ok.droppedTotal).toBe(1);
    expect(ok.output.claims[0]).toMatchObject({ source_refs: [], dropped_source_refs: 1, needs_check: true });
  });

  it('[1]·[10] 은 범위 안이면 통과, 범위 밖은 실패', () => {
    const ten = Array.from({ length: 10 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`);
    expect(run('보고서[1]', ten).output.proposed_text).toBe('보고서[1]');
    const ok = sanitizeLlmOutput({ ...base, proposed_text: '보고서[10]', claims: [{ text: 't[10]', kind: 'fact', source_refs: ['[10]', ten[9]!], needs_user_confirmation: false }] }, ten);
    expect(ok.output.claims[0]).toMatchObject({ text: 't[10]', source_refs: [ten[9]], dropped_source_refs: 1 });
    fails('보고서[11]', ten);
    fails('보고서[99]', ten);
    fails('보고서[0]', ten);
    fails('보고서[１]', []); // 전각 숫자도 NFKC 뒤 번호 규칙
  });

  it('오탐 없음: README.md · 3.14 · 이메일 · 한국어 문장 · 파일 이름', () => {
    for (const t of [
      'README.md 를 보세요',
      'CHANGELOG.md 와 AGENTS.md',
      '원주율은 3.14 이고 v24.21.0 을 씁니다',
      '메일 owner@example.local 로 보내 주세요',
      '해외 영업에서 가장 중요한 것은 신뢰입니다. 다음 분기에 다시 확인합니다.',
      'budget.ts 와 report.pdf, data.csv, photo.jpeg 파일',
      '1.5배 늘었다. 끝.',
    ]) {
      expect(run(t, []).output.proposed_text, t).toBe(t);
    }
  });

  it('알려진 보수성: 파일처럼 보여도 경로·포트가 붙으면 호스트, 소문자 .md 는 도메인으로 본다', () => {
    fails('notes.md/report');
    fails('report.pdf:8080/x');
    fails('fake.md 참고');
    fails('React.Component 를 씁니다'); // 단어.영문 은 실패할 수 있다(D13 FIX round 4)
  });

  it('hasFreeTextCitation 는 탐지만 한다(허용 판단 없음)', () => {
    expect(hasFreeTextCitation('https://example.com')).toBe(true);
    expect(hasFreeTextCitation('a//b 가 아니라 //host')).toBe(true);
    expect(hasFreeTextCitation('주석 // 설명')).toBe(false);
    expect(hasFreeTextCitation('평범한 문장')).toBe(false);
  });

  it('서버 인용 표시: 허용 id 정렬 순서로 [출처 n]', () => {
    const ids = ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', ID];
    expect(citationLabel(ids, ID)).toBe('[출처 1]');
    expect(citationLabel(ids, 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC')).toBe('[출처 2]');
    expect(citationLabel(ids, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd')).toBeNull();
  });
});
