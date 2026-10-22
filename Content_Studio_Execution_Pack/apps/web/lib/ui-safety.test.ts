/**
 * UI-CLEAN: 글 줄이기("자세히" <details> 로 접기)가 안전 표시를 숨기지 않았는지 — 바뀐 화면 소스에서 <details>…</details> 블록을 모두 지운 뒤에도
 * 안전 표시(실제 게시·MOCK·실제 발행 실적 아님·공개 범위·확인 상태·결과 불명 안내·확인 후보·Threads 오류 코드·준비 안 됨·AI 출처·개인 원문 등)가 남아 있어야 한다.
 * 소스 문자열 시험이다(렌더 아님) — 각 표시는 조건부로만 그려지므로, 여기서는 "접힌 곳으로 옮겨지지 않았음"만 본다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(`../app/${rel}`, import.meta.url), 'utf8');

/** <details …>…</details> 를 안쪽부터 모두 지운다(중첩 포함). 짝이 맞지 않으면 시험 실패. */
function stripDetails(src: string): string {
  const open = (src.match(/<details\b/g) ?? []).length;
  const close = (src.match(/<\/details>/g) ?? []).length;
  if (open !== close) throw new Error(`<details> 짝이 맞지 않음: 열기 ${open} · 닫기 ${close}`);
  let out = src;
  const inner = /<details\b[^>]*>(?:(?!<details\b)[\s\S])*?<\/details>/;
  while (inner.test(out)) out = out.replace(inner, '');
  return out;
}

const MOCK_TAG = '<span className="tag mock">MOCK</span>';

/** 화면 소스 → 접힌 곳 밖에 남아야 하는 안전 표시 */
const REQUIRED: Record<string, string[]> = {
  'distribute/[id]/page.tsx': [
    // 결과 불명·확인 후보·사용자 확인(LIVEP1-USERCONFIRM)·Threads 오류 코드(LIVEP1-DIAG)
    '{LIVE_UNKNOWN_GUIDANCE}',
    '{LIVE_CANDIDATE_LABEL}',
    '<span className="tag warn">미확인</span>',
    'Threads 에서 직접 보고 판단하세요. 이 앱은 이 글을 게시 결과로 기록하지 않았습니다.',
    '{USER_CONFIRM_BUTTON}',
    '{USER_CONFIRM_WARNING}',
    '{USER_CONFIRMED_NOTICE}',
    'action={`/api/distribution-items/${x.item.id}/user-confirm`}',
    '{diagLine ? (',
    '<span className="hash">{diagLine}</span>',
    // 공개 범위·확인 상태
    '{LIVE_THREADS_VISIBILITY_TEXT}',
    '<dt>공개 범위</dt><dd>{live ? `${LIVE_THREADS_VISIBILITY_TEXT}(승인 값 public)`',
    'liveVerificationLabel(p.verification, p.permalink)',
    'liveVerificationTag(latestPub?.verification)',
    '<span className={pubTag.className}>{pubTag.text}</span>',
    // 실제 게시·MOCK 구분
    '<strong>실제로 게시</strong>',
    '되돌리기 없음',
    '결과를 모르면 자동으로 다시 게시하지 않습니다.',
    '모의 계정 항목은 MOCK 입니다(실제 발행 실적 아님).',
    '확인된 결과도 MOCK 이며 실제 발행 실적이 아닙니다.',
    `${MOCK_TAG} <strong>실제 발행 실적 아님</strong>`,
    '<strong> — 실제 발행 실적 아님</strong>',
    '<span className="tag live">실제 게시 — 실제 계정</span>',
    '<span className="tag live">실제 게시 승인</span>',
    "'작업 처리 실행(1회 — 실제 게시 항목은 실제로 게시)'",
    '실제 Instagram 으로 아무것도 보내지 않았고 실제 발행 실적이 아닙니다.',
    '실제 Threads 로 아무것도 보내지 않았고 실제 발행 실적이 아닙니다.',
    '결과를 모르면 자동으로 다시 게시하지 않고 결과 불명(UNKNOWN)으로 남깁니다.',
    // 승인 경계
    '스냅샷이 지금과 다릅니다 — 승인·실행할 수 없습니다(새 계획 필요)',
    '복원됨 — 자동 실행·재시도 안 함, 결과 확인 필요',
    '내용을 확인했습니다',
    '재확인(조회만 — 다시 보내지 않음)',
    // FIX-UICLEAN(Codex 질문 1 답·coordinator): 실제 게시 보류 조건은 접지 않고 한 줄로 보인다
    '실제 게시 조건(PUBLISH_MODE·게시 승인 기록·게시 수 상한)이 없으면 게시하지 않고 보류합니다.',
    // FIX-UICLEAN: 계획 기록 기준 문구(페이지 수준 계정 상태가 아님)
    'mixedResultSuffix(',
    'planCreatedBanner(hasLive)',
    'retriedBanner(hasLive)',
    // FIX2-UICLEAN: 항목 상태 태그·작업 줄·철회 배너는 그 항목·계획 기록으로
    'itemStatusText(x.item.status, { live: itemIsLive({ accountKind: x.account?.kind, pub: latestPub })',
    'jobStatusTextFor(j, pub, reason, channel, live)',
    // FIX2-FULLREV(Q2): 부분 게시·복원 취소 미확정 UNKNOWN — 상태 태그에 최근 작업의 사유 코드를 넘기고, 스냅샷·실제 게시 결과 불명 안내도 종류별(새 계획을 권하지 않음)
    'const unknownKind = unknownKindOf(x.item.status, latest);',
    'verification: latestPub?.verification ?? null, lastErrorCode: latest?.lastErrorCode ?? null })',
    // FIX2-FULLREV(FX3): 스냅샷 안내는 상태 태그와 같은 기록 기준(itemIsLive)으로 모의·실제 문구를 고른다
    'const recordLive = itemIsLive({ accountKind: x.account?.kind, pub: latestPub });',
    "{SNAPSHOT_PROBLEMS_PREFIX_BY_KIND[unknownKind][recordLive ? 'live' : 'mock']}: {x.problems.map(problemLabel).join",
    '{LIVE_UNKNOWN_GUIDANCE_BY_KIND[unknownKind]}',
    'revocationNoticeFor(',
    // FIX1-FULLREV(F2): 철회 배너는 부분 게시로 UNKNOWN 에 둔 작업 수(revoked_partial)도 넘긴다
    'revocationCountParam(q.revoked_partial)',
    'requestedResultLabel(x.item.requestedResult',
    // LIVE-P2(D39): 실제 게시 최근 24시간 사용·일시 중지 한 줄, 일일 상한 보류의 상한·다시 보낼 시각
    '<strong>{liveLine}</strong>',
    'liveDaily: live ? liveDailyLimitOf(x.events) : null',
  ],
  'distribute/new/page.tsx': [
    '<strong>실제로 게시</strong>',
    '계획 생성만으로는 승인·게시되지',
    'MOCK — 계획을 만들어도 승인·게시되지 않습니다.',
    '{LIVE_PLAN_ACCOUNT_NOTE}',
    `${MOCK_TAG} 모의 연결 Instagram 계정: MOCK 게시뿐이고 공개 범위는 공개(public)만 됩니다`,
    '배포 조건을 채우지 못했습니다',
    "'배포 계획 만들기(승인 전 — 아직 게시하지 않음)'",
    // FIX-LIVEP2(계획 3(b)): 실제 게시 준비 안내 옆 즉시 중지 표시
    'getLivePublishPaused(db, session.ownerId)',
    '<strong>지금은 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않습니다.</strong>',
  ],
  'distribute/page.tsx': [
    MOCK_TAG,
    'accountModeOf(accounts)',
    'planRowTag(e)',
    '실제 게시 대상 미지정',
    '<strong>실제로 게시</strong>',
    'MOCK(실제 발행 실적 아님)',
    '실제/MOCK 표시는 각 계획',
    // FIX-LIVEP2(계획 3(b)): 실제 게시 안내 옆 즉시 중지 표시
    'getLivePublishPaused(db, session.ownerId)',
    '<strong>지금은 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않습니다.</strong>',
  ],
  'settings/page.tsx': [
    '실제 게시 준비 안 됨(실제로 게시하지 않음): {oauth.livePublish.missing.join',
    '<span className="tag live">실제 게시 준비됨</span>',
    '실제 Threads 연결 준비 안 됨: {oauth.live.missing.join',
    '`live 준비 안 됨: ${live.missing.join',
    '음성 전사 live 준비 안 됨: {sttLive.missing.join',
    'OIDC 로그인 준비 안 됨: ${authView.missing.join',
    '계정 연결 불가: {oauth.secrets.problems.join',
    '개인 원문이 들어 있으니 파일을 보관할 곳을 직접 정하세요.',
    '미리보기 단계에서는 데이터가 바뀌지 않습니다.',
    '모의 연결은 실제 게시에 쓰이지 않습니다.',
    "<span className=\"tag mock\">MOCK</span> : <span className=\"tag live\">실제 계정</span>",
    'id="accounts"',
    // LIVE-P2(D39): 실제 게시 즉시 중지 스위치(상태·최근 24시간 사용·중지/재개)·준비 표시의 일시 중지
    'id="live-publish"',
    '{liveSwitch}',
    '{livePublishDailyUsageText(liveCtl.used, liveDailyLimit)}',
    '실제 게시 일시 중지</button>',
    'action="/api/live-publish/pause"',
    'action="/api/live-publish/resume"',
    'name="confirm_text"',
    '{LIVE_PUBLISH_RESUME_CONFIRM_TEXT}',
    '일시 중지는 서버 재시작 없이 바로 적용됩니다',
    '지금은 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않습니다.',
    // EXPIRY-1(D39): 만료 알림(맨 위)·만료 관리 구역·배포 계정 표의 만료 칸 옆 계정별 표시
    '<ExpiryNoticeList notices={expiry} />',
    'id="expiry"',
    '{EXPIRY_ACCOUNT_TAG_TEXT[exp.level]}',
    '실제 Threads 연결은 자동 갱신하지 않습니다',
    '<code>bash scripts/dev-cert.sh renew</code>',
  ],
  'contents/[id]/page.tsx': ['확인하지 않은 1인칭 경험 주장이', '"준비됨"으로 바꿀 수 없습니다'],
  'contents/[id]/writing-panel.tsx': [
    '{MOCK_WARNING}',
    '{modeText.notice}',
    "resultLabel('제안', origin)",
    '&quot;준비됨&quot;으로 바꿀 수 없습니다.',
    "'출처 미검증 · 사용자 확인 필요'",
    "'미확인 — 사실인지 확인 필요'",
    '출처 미확인(허용 목록 밖',
    'failedSettlementLabel(ledger.pricingSnapshot)',
    'unpricedLabel(origin)',
    'AI 는 답변을 채우거나 가상 경험을 보태지 않습니다.',
  ],
  'contents/[id]/variants-panel.tsx': [
    '{MOCK_WARNING}',
    "resultLabel('초안'",
    '확인하지 않은 1인칭 경험 주장이',
    '자동 게시 없음',
    '원문이 바뀜 — 재검토 필요',
    '실제로 게시, 모의 계정은 MOCK',
    "'(MOCK — 승인은 계획 화면에서 직접)'",
    '자동 게시 아님 — 파일을 받는 것은 승인이나 게시가 아닙니다.',
  ],
  'page.tsx': ['planRowTag(e)', "b.live ? 'badge live' : 'badge'", '{liveLine}', '<ExpiryNoticeList notices={expiry} />'],
  'ops/page.tsx': [
    'AI live 준비 안 됨: {live.missing',
    '음성 전사 live 준비 안 됨: {sttLive.missing',
    '실제 Threads 연결 준비 안 됨:',
    '실제 게시 준비 안 됨: {oauth.livePublish.missing.join',
    '{LIVE_SETTLEMENT_POLICY_TEXT}',
    '원문 소재·출처·원고 버전은 지우지 않습니다.',
    'opsAccountsNote(accountModeOf(accounts))',
    'opsJobsTag(s.jobs.byKind)',
    // FIX-LIVEP2(계획 3(b)): 실제 게시 준비 줄의 즉시 중지 표시
    'getLivePublishPaused(db, session.ownerId)',
    "{livePaused ? ' · 실제 게시 일시 중지됨 — 재개 전에는 게시하지 않음' : ''}",
  ],
  'record/page.tsx': ['모의(실제 음성 인식 아님)', 'live 준비 안 됨: {live.missing.join'],
};

describe('UI-CLEAN 안전 표시 — "자세히" 밖에 남아 있다', () => {
  it('stripDetails: 중첩·속성 포함 블록을 지우고, 짝이 안 맞으면 실패', () => {
    expect(stripDetails('a<details className="more"><summary>자세히</summary>b<details>c</details>d</details>e')).toBe('ae');
    expect(stripDetails('x<details open>y</details>z<details>w</details>')).toBe('xz');
    expect(() => stripDetails('<details>a')).toThrow();
  });

  for (const [file, tokens] of Object.entries(REQUIRED)) {
    it(file, () => {
      const visible = stripDetails(read(file));
      const missing = tokens.filter((t) => !visible.includes(t));
      expect(missing).toEqual([]);
    });
  }

  it('"자세히" 블록 안에는 안전 표시 상수를 두지 않는다(접힌 곳에만 있는 경고 금지)', () => {
    const SAFETY = [
      'LIVE_UNKNOWN_GUIDANCE',
      'LIVE_CANDIDATE_LABEL',
      'LIVE_THREADS_VISIBILITY_TEXT',
      'USER_CONFIRM_',
      'MOCK_WARNING',
      'diagLine',
      'liveVerification',
      'livePublish.missing',
      '실제 발행 실적 아님',
      '확인하지 않은 1인칭',
      // LIVE-P2(D39)
      'liveLine',
      'liveSwitch',
      'livePublishDailyUsageText',
      'LIVE_PUBLISH_RESUME_CONFIRM_TEXT',
      // FIX-LIVEP2
      'livePaused',
      // EXPIRY-1(D39)
      'ExpiryNoticeList',
      'EXPIRY_ACCOUNT_TAG_TEXT',
      'EXPIRY_LEVEL_LABEL',
    ];
    for (const file of Object.keys(REQUIRED)) {
      const src = read(file);
      const hidden = [...src.matchAll(/<details\b[\s\S]*?<\/details>/g)].map((m) => m[0]).join('\n');
      const found = SAFETY.filter((t) => hidden.includes(t));
      expect({ file, found }).toEqual({ file, found: [] });
    }
  });

  it('뒤로 가기 링크(←)를 없앴고, 모든 화면(오늘·로그인 제외)이 현재 위치(Breadcrumbs)를 그린다', () => {
    const pages = [
      'captures/page.tsx',
      'captures/[id]/page.tsx',
      'record/page.tsx',
      'imports/page.tsx',
      'imports/[id]/page.tsx',
      'collect/page.tsx',
      'collect/runs/[id]/page.tsx',
      'contents/page.tsx',
      'contents/[id]/page.tsx',
      'contents/[id]/versions/[n]/page.tsx',
      'contents/[id]/diff/page.tsx',
      'ideas/page.tsx',
      'ideas/[id]/page.tsx',
      'distribute/new/page.tsx',
      'distribute/page.tsx',
      'distribute/[id]/page.tsx',
      'settings/page.tsx',
      'settings/restores/[id]/page.tsx',
      'brand/page.tsx',
      'ops/page.tsx',
      'search/page.tsx',
    ];
    for (const p of pages) {
      const src = read(p);
      expect({ p, crumbs: src.includes('<Breadcrumbs at={{') }).toEqual({ p, crumbs: true });
      expect({ p, back: src.includes('←') }).toEqual({ p, back: false });
    }
  });
});

/**
 * FIX-UICLEAN(Codex review-UI-CLEAN P1·P2 + 오래된 MOCK 문구): 지금 계정 상태나 화면 수준 값으로 기록의 실제/MOCK 을 단정하던 고정 문구가 남아 있지 않다.
 * 문구 선택은 lib/record-labels.ts(단위 시험 record-labels.test.ts, 배포함 렌더 시험 distribute-list-render.test.ts)가 한다.
 */
describe('FIX-UICLEAN — 고정 MOCK 단정 문구 없음', () => {
  const FORBIDDEN: Record<string, string[]> = {
    'ops/page.tsx': ['현재 연결은 모두 모의(MOCK)입니다', '배포 작업(MOCK)'],
    'distribute/[id]/page.tsx': [
      '(MOCK — 실제 게시 아님)',
      '배포 계획을 만들었습니다(MOCK',
      '(MOCK — 새 시도)',
      // FIX2-UICLEAN: 항목 상태 태그·작업 줄·철회 배너·요청 결과 이름을 고정 표(모의 문구)로 바로 쓰지 않는다
      'ITEM_STATUS_LABEL[x.item.status]',
      '{jobStatusText(j',
      '{revocationNotice(revocationCountParam',
      'REQUESTED_RESULT_LABEL[r]',
      '.replace(/\\(MOCK',
    ],
    'distribute/page.tsx': ['결과와 원격 ID 는', '모의(MOCK) 계정만 있습니다', 'e.mock ? <span'],
    'page.tsx': ['e.mock ? <span'],
    'contents/[id]/variants-panel.tsx': ["'(MOCK)'}"],
  };
  for (const [file, literals] of Object.entries(FORBIDDEN)) {
    it(file, () => {
      const src = read(file);
      expect(literals.filter((t) => src.includes(t))).toEqual([]);
    });
  }

  it('복원 화면의 현재 위치는 복원 상태(미리보기/완료)를 넘긴다', () => {
    expect(read('settings/restores/[id]/page.tsx')).toContain("page: 'restore', committed: Boolean(committed)");
  });
});

/**
 * DESIGN-A(시스템 다크): 실제 게시 태그는 주황(`tag live`), MOCK 태그는 회색 점선(`tag mock`) — 화면 어디에서도 서로의 클래스를 쓰지 않는다.
 * (색 값과 대비는 design-tokens.test.ts 가 globals.css 로 확인)
 */
describe('DESIGN-A — 실제 게시 태그와 MOCK 태그를 섞지 않는다', () => {
  const appDir = new URL('../app/', import.meta.url);
  const sources = (readdirSync(appDir, { recursive: true }) as string[])
    .filter((p) => p.endsWith('.tsx'))
    .map((p) => p.split('\\').join('/'))
    .map((file) => ({ file, src: readFileSync(new URL(file, appDir), 'utf8') }));

  it('화면 소스를 찾았다(배포 화면 포함)', () => {
    expect(sources.some((s) => s.file === 'distribute/[id]/page.tsx')).toBe(true);
    expect(sources.length).toBeGreaterThan(20);
  });

  it('글자 그대로 MOCK 태그는 모두 tag mock', () => {
    const wrong = sources.flatMap(({ file, src }) =>
      [...src.matchAll(/className="(tag[^"]*)">MOCK</g)].filter((m) => m[1] !== 'tag mock').map((m) => `${file}: ${m[0]}`),
    );
    expect(wrong).toEqual([]);
    expect(sources.filter(({ src }) => src.includes('className="tag mock">MOCK<')).length).toBeGreaterThan(3);
  });

  it('글자 그대로 "실제 …" 태그는 tag live(경고인 "실제 게시 대상 미지정" 만 tag warn), tag live 에 MOCK 문구 없음', () => {
    const wrong = sources.flatMap(({ file, src }) =>
      [...src.matchAll(/className="(tag[^"]*)">(실제[^<]*)</g)]
        .filter((m) => (m[2]!.startsWith('실제 게시 대상 미지정') ? m[1] !== 'tag warn' : m[1] !== 'tag live'))
        .map((m) => `${file}: ${m[0]}`),
    );
    expect(wrong).toEqual([]);
    const liveWithMock = sources.flatMap(({ file, src }) =>
      [...src.matchAll(/className="tag live">([^<]*)</g)].filter((m) => m[1]!.includes('MOCK') || m[1]!.includes('모의')).map((m) => `${file}: ${m[0]}`),
    );
    expect(liveWithMock).toEqual([]);
  });
});
