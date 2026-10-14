/**
 * UI-CLEAN: 글 줄이기("자세히" <details> 로 접기)가 안전 표시를 숨기지 않았는지 — 바뀐 화면 소스에서 <details>…</details> 블록을 모두 지운 뒤에도
 * 안전 표시(실제 게시·MOCK·실제 발행 실적 아님·공개 범위·확인 상태·결과 불명 안내·확인 후보·Threads 오류 코드·준비 안 됨·AI 출처·개인 원문 등)가 남아 있어야 한다.
 * 소스 문자열 시험이다(렌더 아님) — 각 표시는 조건부로만 그려지므로, 여기서는 "접힌 곳으로 옮겨지지 않았음"만 본다.
 */
import { readFileSync } from 'node:fs';
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

const MOCK_TAG = '<span className="tag warn">MOCK</span>';

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
    '공개 범위: {live ? `${LIVE_THREADS_VISIBILITY_TEXT}(승인 값 public)`',
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
    '<span className="tag warn">실제 게시 — 실제 계정</span>',
    '<span className="tag warn">실제 게시 승인</span>',
    "'작업 처리 실행(1회 — 실제 게시 항목은 실제로 게시)'",
    '실제 Instagram 으로 아무것도 보내지 않았고 실제 발행 실적이 아닙니다.',
    '실제 Threads 로 아무것도 보내지 않았고 실제 발행 실적이 아닙니다.',
    '결과를 모르면 자동으로 다시 게시하지 않고 결과 불명(UNKNOWN)으로 남깁니다.',
    // 승인 경계
    '스냅샷이 지금과 다릅니다 — 승인·실행할 수 없습니다(새 계획 필요)',
    '복원됨 — 자동 실행·재시도 안 함, 결과 확인 필요',
    '내용을 확인했습니다',
    '재확인(조회만 — 다시 보내지 않음)',
  ],
  'distribute/new/page.tsx': [
    '<strong>실제로 게시</strong>',
    '계획 생성만으로는 승인·게시되지',
    'MOCK — 계획을 만들어도 승인·게시되지 않습니다.',
    '{LIVE_PLAN_ACCOUNT_NOTE}',
    `${MOCK_TAG} 모의 연결 Instagram 계정: MOCK 게시뿐이고 공개 범위는 공개(public)만 됩니다`,
    '배포 조건을 채우지 못했습니다',
    "'배포 계획 만들기(승인 전 — 아직 게시하지 않음)'",
  ],
  'distribute/page.tsx': [MOCK_TAG, '<strong>실제로 게시</strong>', 'MOCK(실제 발행 실적 아님)입니다.', '그 결과와 원격 ID 는 MOCK(실제 발행 실적 아님)입니다.'],
  'settings/page.tsx': [
    '실제 게시 준비 안 됨(실제로 게시하지 않음): {oauth.livePublish.missing.join',
    '<span className="tag warn">실제 게시 준비됨</span>',
    '실제 Threads 연결 준비 안 됨: {oauth.live.missing.join',
    '`live 준비 안 됨: ${live.missing.join',
    '음성 전사 live 준비 안 됨: {sttLive.missing.join',
    'OIDC 로그인 준비 안 됨: ${authView.missing.join',
    '계정 연결 불가: {oauth.secrets.problems.join',
    '개인 원문이 들어 있으니 파일을 보관할 곳을 직접 정하세요.',
    '미리보기 단계에서는 데이터가 바뀌지 않습니다.',
    '모의 연결은 실제 게시에 쓰이지 않습니다.',
    "<span className=\"tag warn\">MOCK</span> : <span className=\"tag warn\">실제 계정</span>",
    'id="accounts"',
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
  'page.tsx': [MOCK_TAG, "b.live ? 'badge live' : 'badge'"],
  'ops/page.tsx': [
    'AI live 준비 안 됨: {live.missing',
    '음성 전사 live 준비 안 됨: {sttLive.missing',
    '실제 Threads 연결 준비 안 됨:',
    '실제 게시 준비 안 됨: {oauth.livePublish.missing.join',
    '{LIVE_SETTLEMENT_POLICY_TEXT}',
    '원문 소재·출처·원고 버전은 지우지 않습니다.',
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
