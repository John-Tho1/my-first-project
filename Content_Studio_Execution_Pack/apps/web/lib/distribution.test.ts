/**
 * FIX-T12(P2, Codex review-T12 lib/distribution.ts:269) · FIX-T11(P2): 보류 이유는 구조화된 코드로 판단하고 상세 사유는 따로 보인다,
 * 스냅샷이 바뀌어 다시 승인할 수 없으면 새 계획 안내, 승인 철회 안내는 저장된 작업 결과 수만 말한다.
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_BLOCK_REASONS,
  bannersFromState,
  blockDetailLabel,
  blockInfoOf,
  itemHeadline,
  planFormDefaults,
  planFormEcho,
  reconciledNotice,
  reconciledParam,
  revocationCountParam,
  revocationNotice,
} from './distribution';

const job = (state: string, lastErrorCode: string | null) => ({ state, attempt: 1, maxAttempts: 5, nextRunAt: new Date('2030-01-01T00:00:00Z'), lastErrorCode });
const ev = (details: Record<string, unknown>) => [
  { stateAfter: 'BLOCKED', sanitizedDetails: details },
  { stateAfter: 'QUEUED', sanitizedDetails: { event: 'execute' } },
];

describe('blockInfoOf — 표준 코드와 상세 사유 분리', () => {
  it('RETRY_WAIT 첨부 변경 무효화: 이벤트 event=approval_invalidated·reason=invalidated:assets_changed → code 는 승인 코드, detail 은 상세', () => {
    const b = blockInfoOf(ev({ event: 'approval_invalidated', reason: 'invalidated:assets_changed', transition: 'blocked' }), job('BLOCKED', 'approval_invalidated'));
    expect(b).toEqual({ code: 'approval_invalidated', detail: 'invalidated:assets_changed' });
    // 수정 전(blockReasonOf)은 reason 을 먼저 돌려줘 'invalidated:assets_changed' 가 승인 코드를 가렸다
    const headline = itemHeadline({ status: 'PLANNED', channel: 'threads', job: job('BLOCKED', 'approval_invalidated'), pub: null, blockReason: b.code, blockDetail: b.detail });
    expect(headline).toBe('승인 없음 (첨부 파일이 바뀜) — 다시 승인 후 실행');
  });
  it('사용자 철회: reason=user → detail 사용자 철회', () => {
    const b = blockInfoOf(ev({ event: 'approval_revoked', reason: 'user: 날짜 변경' }), job('BLOCKED', 'approval_revoked'));
    expect(b.code).toBe('approval_revoked');
    expect(blockDetailLabel(b.detail)).toBe('사용자 철회: 날짜 변경');
  });
  it('전송 전 재검사(event=blocked, reason=approval_missing)·401 보류(reason=auth)는 예전과 같은 코드', () => {
    expect(blockInfoOf(ev({ event: 'blocked', reason: 'approval_missing' }), job('BLOCKED', 'approval_missing'))).toEqual({ code: 'approval_missing', detail: null });
    expect(blockInfoOf(ev({ event: 'blocked', reason: 'auth' }), job('BLOCKED', 'mock_401_unauthorized')).code).toBe('auth');
    expect(blockInfoOf([], null)).toEqual({ code: null, detail: null });
  });
});

describe('itemHeadline — 승인 문제·새 계획 안내', () => {
  it('401 보류 뒤 편집으로 승인 무효(항목 PLANNED, 작업 BLOCKED, 활성 승인 없음, 스냅샷 변경) → 새 계획 만들기', () => {
    const b = blockInfoOf(ev({ event: 'blocked', reason: 'auth' }), job('BLOCKED', 'mock_401_unauthorized'));
    const h = itemHeadline({
      status: 'PLANNED',
      channel: 'blog',
      job: job('BLOCKED', 'mock_401_unauthorized'),
      pub: null,
      blockReason: b.code,
      blockDetail: null,
      activeApproval: false,
      needsNewPlan: true,
    });
    expect(h).toContain('승인 무효');
    expect(h).toContain('새 계획 만들기');
  });
  it('작업 없는 PLANNED·활성 승인 있는 PLANNED 는 계획됨', () => {
    expect(itemHeadline({ status: 'PLANNED', channel: 'threads', job: null, pub: null, blockReason: null, activeApproval: false })).toBe('계획됨(실행 전)');
    expect(itemHeadline({ status: 'PLANNED', channel: 'threads', job: job('BLOCKED', 'auth'), pub: null, blockReason: 'auth', activeApproval: true })).toBe('계획됨(실행 전)');
  });
});

describe('revocationNotice — 저장된 작업 결과만 말한다', () => {
  it('보류·취소 확인 중·작업 없음·수 없음', () => {
    expect(revocationNotice(1, 0)).toContain('보류(BLOCKED) — 다음 전송이 차단');
    const c = revocationNotice(0, 1);
    expect(c).toContain('취소 확인 중');
    expect(c).not.toContain('보류');
    expect(revocationNotice(0, 0)).toContain('대기 중이던 작업은 없었습니다');
    expect(revocationNotice(null, null)).toBe('승인을 철회했습니다(MOCK).');
  });
});

describe('FIX round 2 (Codex review-FIX-T11T12) P2', () => {
  it('철회 리다이렉트 파라미터를 페이지와 같은 파싱(revocationCountParam)으로: revoked_blocked=0&revoked_cancel=1 → 취소 확인 중', () => {
    const q = new URL('http://localhost:3000/distribute/p?revoked=1&revoked_blocked=0&revoked_cancel=1').searchParams;
    const blocked = revocationCountParam(q.get('revoked_blocked') ?? undefined);
    const cancel = revocationCountParam(q.get('revoked_cancel') ?? undefined);
    expect([blocked, cancel]).toEqual([0, 1]);
    expect(revocationNotice(blocked, cancel)).toContain('취소 확인 중');
    for (const bad of [undefined, '', 'x', '-1', '1.5', '1234', ['1']]) expect(revocationCountParam(bad as string | string[] | undefined), String(bad)).toBeNull();
    expect(revocationCountParam(' 12 ')).toBe(12);
  });

  it('활성 승인이 있으면(다시 승인함) 과거 보류 사유와 관계없이 "승인 없음"이라고 하지 않는다 — activeApproval × 승인 관련 코드 행렬', () => {
    for (const code of [...APPROVAL_BLOCK_REASONS]) {
      for (const active of [true, false]) {
        const h = itemHeadline({ status: 'PLANNED', channel: 'threads', job: job('BLOCKED', code), pub: null, blockReason: code, blockDetail: null, activeApproval: active });
        if (active) expect(h, code).toBe('계획됨(실행 전)');
        else expect(h, code).toBe('승인 없음 — 다시 승인 후 실행');
      }
    }
  });
});

describe('M3 화면 FIX D8 — 재확인 결과 4종(조회 미지원·불명을 "찾지 못함"으로 뭉개지 않음)', () => {
  it('reconciledParam: 원격 조회 상태 → 리다이렉트 값', () => {
    expect(reconciledParam('found')).toBe('found');
    expect(reconciledParam('not_found')).toBe('not_found');
    expect(reconciledParam('unsupported')).toBe('unsupported');
    expect(reconciledParam('unknown')).toBe('unknown');
    expect(reconciledParam('processing')).toBe('unknown');
    expect(reconciledParam('뭔가 다른 값')).toBe('unknown');
  });
  it('reconciledNotice: 네 문구, 옛 값(found·not_found) 유지, 쓰레기 값·배열·없음 → null', () => {
    expect(reconciledNotice('found')).toBe('원격에서 결과를 찾았습니다(MOCK — 실제 발행 실적 아님).');
    expect(reconciledNotice('not_found')).toBe('원격에서 결과를 찾지 못했습니다. 상태는 그대로이며 다시 보내지 않았습니다.');
    expect(reconciledNotice('unsupported')).toBe('이 채널은 원격 조회를 지원하지 않아 확인하지 못했습니다. 원격에 없다는 뜻이 아닙니다. 다시 보내지 않았습니다.');
    expect(reconciledNotice('unknown')).toBe('원격 상태를 확인하지 못했습니다(진행 중이거나 기록이 없음). 없다는 뜻이 아닙니다. 다시 보내지 않았습니다.');
    for (const bad of ['', 'FOUND', 'toString', '__proto__', 'constructor', '<script>', ' found']) expect(reconciledNotice(bad), bad).toBeNull();
    expect(reconciledNotice(['found', 'not_found'])).toBeNull();
    expect(reconciledNotice(undefined)).toBeNull();
    expect(reconciledNotice('stale')).toMatch(/적용하지 않았습니다/);
  });
});

describe('M3 화면 FIX D5 — 성공 배너는 저장된 상태로(bannersFromState)', () => {
  const it_ = (status: string, approved: boolean, jobs: string[]) => ({ item: { status }, activeApproval: approved ? { id: 'a' } : null, jobs: jobs.map((state) => ({ state })) });
  const fake = { approved: '1', executed: '1', canceled: '1', cancel_requested: '1', retried: '1', replay: '1' };

  it('미승인·작업 0건 계획에 가짜 쿼리 → 주장 배너 없음', () => {
    expect(bannersFromState(fake, { items: [it_('PLANNED', false, []), it_('PLANNED', false, [])] })).toEqual({
      approved: null,
      executed: null,
      canceled: false,
      cancelRequested: false,
      retried: false,
    });
    expect(bannersFromState(fake, { items: [] }).approved).toBeNull();
  });

  it('실제 상태 → 수는 상태에서(쿼리 숫자 무시)', () => {
    const d = { items: [it_('PLANNED', true, []), it_('QUEUED', true, ['QUEUED']), it_('PLANNED', false, [])] };
    expect(bannersFromState({ approved: '99' }, d).approved).toBe(2);
    expect(bannersFromState({ executed: '99', replay: '1' }, d).executed).toEqual({ items: 1, jobs: 1, replay: true });
    expect(bannersFromState({ executed: '0' }, d).executed).toEqual({ items: 1, jobs: 1, replay: false });
    // Codex review-FIX-M3screen P2: 첫 실행의 QUEUED 는 재시도가 아니다
    expect(bannersFromState({ retried: '1' }, d).retried).toBe(false);
    // 쿼리가 없으면 상태가 있어도 배너 없음
    expect(bannersFromState({}, d)).toEqual({ approved: null, executed: null, canceled: false, cancelRequested: false, retried: false });
  });

  it('취소·취소 확인 중은 실제 CANCELED·CANCEL_REQUESTED 가 있을 때만, 재시도는 QUEUED 작업이 있을 때만', () => {
    const canceled = { items: [it_('CANCELED', true, ['CANCELED'])] };
    expect(bannersFromState({ canceled: '1' }, canceled).canceled).toBe(true);
    expect(bannersFromState({ cancel_requested: '1' }, { items: [it_('CANCEL_REQUESTED', true, ['CANCEL_REQUESTED'])] }).cancelRequested).toBe(true);
    const confirmed = { items: [it_('CONFIRMED', true, ['CONFIRMED'])] };
    expect(bannersFromState({ canceled: '1', cancel_requested: '1', retried: '1' }, confirmed)).toMatchObject({ canceled: false, cancelRequested: false, retried: false });
    // 처리기가 이미 가져간 재시도(QUEUED 아님) → 재시도 배너 없음
    expect(bannersFromState({ retried: '1' }, { items: [it_('SENDING', true, ['BLOCKED', 'SENDING'])] }).retried).toBe(false);
    // 쿼리 값은 정확히 '1' 이어야 한다
    expect(bannersFromState({ canceled: 'yes' }, canceled).canceled).toBe(false);
  });
});

describe('화면 확인 D10 — planFormEcho·planFormDefaults', () => {
  const V = '11111111-2222-4333-8444-555555555555';
  const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  it('형식이 맞는 값만 왕복하고 체크 안 한 파생본은 use 에 없다', () => {
    const W = '99999999-2222-4333-8444-555555555555';
    const qs = planFormEcho({
      content_id: 'x',
      [`use_${V}`]: 'on',
      [`account_${V}`]: A,
      [`visibility_${V}`]: 'public',
      [`date_${V}`]: '2030-01-02',
      [`time_${V}`]: '09:30',
      [`account_${W}`]: A,
      [`visibility_${W}`]: 'everyone',
      [`date_${W}`]: '2030/01/02',
      [`time_${W}`]: '9:30',
      'use_not-a-uuid': 'on',
      target_summary: '  이름  ',
    });
    expect(qs.startsWith('&')).toBe(true);
    const d = planFormDefaults(Object.fromEntries(new URLSearchParams(qs.slice(1)).entries()));
    expect([...d.use]).toEqual([V]);
    expect(d.account).toEqual({ [V]: A, [W]: A });
    expect(d.visibility).toEqual({ [V]: 'public' });
    expect(d.date).toEqual({ [V]: '2030-01-02' });
    expect(d.time).toEqual({ [V]: '09:30' });
    expect(d.name).toBe('이름');
    expect(planFormEcho({ content_id: 'x' })).toBe('');
  });
  it('쿼리를 직접 고쳐도 형식이 틀린 값·배열은 버린다, 이름은 200자', () => {
    const d = planFormDefaults({ e_use: `${V},bad`, [`e_vis_${V}`]: 'x', [`e_acc_${V}`]: ['a', 'b'], 'e_date_bad': '2030-01-01', e_name: '가'.repeat(300) });
    expect([...d.use]).toEqual([V]);
    expect(d.visibility).toEqual({});
    expect(d.account).toEqual({});
    expect(d.date).toEqual({});
    expect(Array.from(d.name)).toHaveLength(200);
  });
});

describe('Codex review-FIX-M3screen — 취소 두 배너 분리·재시도 배너는 기록된 재시도로', () => {
  const ev = (details: Record<string, unknown>) => ({ sanitizedDetails: details });
  const row = (status: string, jobs: string[], events: Array<{ sanitizedDetails: unknown }> = []) => ({ item: { status }, activeApproval: { id: 'a' }, jobs: jobs.map((state) => ({ state })), events });
  it('P1: CANCEL_REQUESTED 만 있는 계획에 ?canceled=1 → 취소됨 배너 없음, 취소 확인 중 배너는 그 상태일 때만', () => {
    const requested = { items: [row('CANCEL_REQUESTED', ['CANCEL_REQUESTED'])] };
    expect(bannersFromState({ canceled: '1' }, requested)).toMatchObject({ canceled: false, cancelRequested: false });
    expect(bannersFromState({ cancel_requested: '1' }, requested)).toMatchObject({ canceled: false, cancelRequested: true });
  });
  it('P1: CANCELED 만 있는 계획에 ?cancel_requested=1 → 취소 확인 중 배너 없음', () => {
    const canceled = { items: [row('CANCELED', ['CANCELED'])] };
    expect(bannersFromState({ cancel_requested: '1' }, canceled)).toMatchObject({ canceled: false, cancelRequested: false });
    expect(bannersFromState({ canceled: '1' }, canceled)).toMatchObject({ canceled: true, cancelRequested: false });
  });
  it('P2: 첫 실행으로 QUEUED 인 계획에 ?retried=1 → 재시도 배너 없음, 사용자 재시도(unblock·user_retry) 뒤 QUEUED 면 표시', () => {
    const firstRun = { items: [row('QUEUED', ['QUEUED'], [ev({ event: 'execute', transition: 'execute' })])] };
    expect(bannersFromState({ retried: '1' }, firstRun).retried).toBe(false);
    expect(bannersFromState({ retried: '1' }, { items: [row('QUEUED', ['QUEUED'])] }).retried).toBe(false);
    const retried = { items: [row('QUEUED', ['QUEUED'], [ev({ event: 'unblock', transition: 'unblock', cause: 'user_retry' }), ev({ event: 'blocked', transition: 'blocked' })])] };
    expect(bannersFromState({ retried: '1' }, retried).retried).toBe(true);
    // unblock 이지만 사용자 재시도가 아닌 경우(다른 원인)·이미 처리기가 가져간 경우는 아님
    expect(bannersFromState({ retried: '1' }, { items: [row('QUEUED', ['QUEUED'], [ev({ event: 'unblock', transition: 'unblock', cause: 'other' })])] }).retried).toBe(false);
    expect(bannersFromState({ retried: '1' }, { items: [row('SENDING', ['SENDING'], [ev({ event: 'unblock', transition: 'unblock', cause: 'user_retry' })])] }).retried).toBe(false);
    // 쿼리 없으면 상태가 맞아도 없음
    expect(bannersFromState({}, retried).retried).toBe(false);
  });
});
