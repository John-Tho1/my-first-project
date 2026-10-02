/**
 * FIX-T12(P2, Codex review-T12 lib/distribution.ts:269) · FIX-T11(P2): 보류 이유는 구조화된 코드로 판단하고 상세 사유는 따로 보인다,
 * 스냅샷이 바뀌어 다시 승인할 수 없으면 새 계획 안내, 승인 철회 안내는 저장된 작업 결과 수만 말한다.
 */
import { describe, expect, it } from 'vitest';
import {
  accountHealthLine,
  APPROVAL_BLOCK_REASONS,
  bannersFromState,
  blockDetailLabel,
  blockInfoOf,
  DISTRIBUTE_ERROR_TEXT,
  formToApprove,
  formToPlanCreate,
  itemHeadline,
  jobStatusText,
  mockScenarioOptionsFor,
  planAccountLabel,
  planFormDefaults,
  planFormEcho,
  planResultSelect,
  reconciledNotice,
  REQUESTED_RESULT_LABEL,
  RESULT_CHOICE_LABEL,
  resultChoicesFor,
  reconciledParam,
  remoteStepLine,
  revocationCountParam,
  revocationNotice,
  stepsPanelView,
  publishAtView,
  YOUTUBE_MOCK_DISCLAIMER,
  youtubeSessionNote,
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

describe('M4UI(G1·G2) — 승인 폼 항목별 목적, 계획 폼 요청 결과·예약 공개', () => {
  const V = '11111111-2222-4333-8444-555555555555';
  const I1 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const I2 = 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  it('formToApprove: purpose_<id> → purposes(체크 안 한 항목도 담기지만 item_ids 만 승인 대상), 단일 purpose 는 있을 때만', () => {
    const r = formToApprove({ [`item_${I1}`]: 'on', [`hash_${I1}`]: 'h1', [`hash_${I2}`]: 'h2', [`purpose_${I1}`]: 'upload_private', [`purpose_${I2}`]: 'mock_publish', confirm: 'yes' });
    expect(r).toEqual({ item_ids: [I1], expected_hashes: { [I1]: 'h1', [I2]: 'h2' }, confirm: true, purposes: { [I1]: 'upload_private', [I2]: 'mock_publish' } });
    expect(formToApprove({ [`item_${I1}`]: 'on', purpose: 'mock_publish' })).toEqual({ item_ids: [I1], expected_hashes: {}, confirm: false, purpose: 'mock_publish' });
  });
  it('formToPlanCreate: 예약 공개 = public_publish + publish_at, 빈 값 = 계정 기본값, 예약 공개 날짜가 비어도 넘겨 서버가 거부', () => {
    const base = { [`use_${V}`]: 'on', [`account_${V}`]: I1, [`visibility_${V}`]: 'private' };
    const item = (f: Record<string, string>) => formToPlanCreate({ ...base, ...f }).items[0]!;
    expect(item({ [`result_${V}`]: 'scheduled_publish', [`publish_date_${V}`]: '2030-01-02', [`publish_time_${V}`]: '09:30' })).toMatchObject({
      requested_result: 'public_publish',
      publish_at: { date: '2030-01-02', time: '09:30' },
      schedule: undefined,
    });
    expect(item({ [`result_${V}`]: 'scheduled_publish' }).publish_at).toEqual({ date: '', time: '' });
    expect(item({ [`result_${V}`]: '' })).toMatchObject({ requested_result: undefined, publish_at: undefined });
    expect(item({})).toMatchObject({ requested_result: undefined, publish_at: undefined });
    expect(item({ [`result_${V}`]: 'upload_private', [`publish_date_${V}`]: '2030-01-02' })).toMatchObject({ requested_result: 'upload_private', publish_at: { date: '2030-01-02', time: '' } });
    // 모르는 값은 그대로 넘겨 스키마가 거부
    expect(item({ [`result_${V}`]: 'go_live' }).requested_result).toBe('go_live');
  });
  it('resultChoicesFor·planResultSelect·planAccountLabel: D27 — 모의 연결 YouTube 만 비공개 업로드·공개 게시·예약 공개, seed·Threads 는 MOCK 실행만', () => {
    const ytLinked = { kind: 'mock', platform: 'youtube', credentialState: 'linked', displayName: 'YT' };
    const ytSeed = { kind: 'mock', platform: 'youtube', credentialState: 'none', displayName: 'YT seed' };
    const thrLinked = { kind: 'mock', platform: 'threads', credentialState: 'linked', displayName: 'TH' };
    expect(resultChoicesFor(ytLinked)).toEqual(['upload_private', 'public_publish', 'scheduled_publish']);
    expect(resultChoicesFor(ytSeed)).toEqual(['mock_publish']);
    expect(resultChoicesFor(thrLinked)).toEqual(['mock_publish']);
    expect(resultChoicesFor({ ...ytLinked, credentialState: 'needs_reconnect' })).toEqual(['upload_private', 'public_publish', 'scheduled_publish']);
    expect(planResultSelect([thrLinked])).toEqual({ fixed: true, accountDefault: false, choices: ['mock_publish'], scheduledAllowed: false });
    expect(planResultSelect([ytLinked])).toEqual({ fixed: false, accountDefault: false, choices: ['upload_private', 'public_publish', 'scheduled_publish'], scheduledAllowed: true });
    expect(planResultSelect([ytSeed, ytLinked])).toEqual({
      fixed: false,
      accountDefault: true,
      choices: ['upload_private', 'public_publish', 'scheduled_publish', 'mock_publish'],
      scheduledAllowed: true,
    });
    expect(planAccountLabel(ytLinked)).toBe('YT (MOCK) · 모의 연결 — 비공개 업로드·공개 게시·예약 공개');
    expect(planAccountLabel(thrLinked)).toBe('TH (MOCK) · MOCK 실행만');
    for (const l of Object.values(RESULT_CHOICE_LABEL)) expect(l).toContain('MOCK');
  });
  it('planFormEcho·planFormDefaults: 요청 결과·예약 공개 날짜·시각 왕복(목록 밖 값·형식 틀린 값은 버림)', () => {
    const W = '99999999-2222-4333-8444-555555555555';
    const qs = planFormEcho({
      [`use_${V}`]: 'on',
      [`result_${V}`]: 'scheduled_publish',
      [`publish_date_${V}`]: '2030-01-02',
      [`publish_time_${V}`]: '18:00',
      [`result_${W}`]: 'go_live',
      [`publish_date_${W}`]: '2030/01/02',
      [`publish_time_${W}`]: '6pm',
    });
    const d = planFormDefaults(Object.fromEntries(new URLSearchParams(qs.slice(1)).entries()));
    expect(d.result).toEqual({ [V]: 'scheduled_publish' });
    expect(d.publishDate).toEqual({ [V]: '2030-01-02' });
    expect(d.publishTime).toEqual({ [V]: '18:00' });
    // 기존 예약(date_·time_)과 섞이지 않는다
    expect(d.date).toEqual({});
    expect(d.time).toEqual({});
  });
  it('오류 문구: 요청 결과·예약 공개 규칙 코드는 모두 한국어 문구가 있다', () => {
    for (const c of [
      'requested_result_not_supported',
      'requested_result_required',
      'visibility_mismatch',
      'publish_at_not_supported',
      'publish_at_requires_public_publish',
      'publish_at_requires_private',
      'publish_at_before_send',
      'purpose_mismatch',
      'mock_only',
      'invalid_schedule',
      'schedule_in_past',
    ]) {
      expect(DISTRIBUTE_ERROR_TEXT[c], c).toMatch(/[가-힣]/u);
    }
    expect(REQUESTED_RESULT_LABEL).toEqual({ mock_publish: 'MOCK 실행', upload_private: '비공개 업로드(MOCK)', public_publish: '공개 게시 계획(MOCK)' });
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

describe('T14(D26) Threads 모의 화면 문구', () => {
  it('요청 제한 대기(로컬·원격 429)는 "요청 제한 — HH:mm MSK 이후 재시도", 다른 재시도 대기는 기존 문구', () => {
    const at = new Date('2030-01-01T09:05:00Z'); // 12:05 MSK
    const w = (code: string | null) => ({ state: 'RETRY_WAIT', attempt: 1, maxAttempts: 5, nextRunAt: at, lastErrorCode: code });
    expect(jobStatusText(w('local_rate_limited'))).toBe('RETRY_WAIT · 요청 제한 — 12:05 MSK 이후 재시도');
    expect(jobStatusText(w('rate_limited'))).toBe('RETRY_WAIT · 요청 제한 — 12:05 MSK 이후 재시도');
    expect(itemHeadline({ status: 'RETRY_WAIT', channel: 'threads', job: w('local_rate_limited'), pub: null, blockReason: null })).toBe('요청 제한 — 12:05 MSK 이후 재시도');
    expect(jobStatusText(w('mock_503_not_sent'))).toBe('RETRY_WAIT · 재시도 대기 (1/5, 다음 12:05 MSK)');
    // FIX-T15: web tick 조각 예산으로 양보한 업로드는 장애·재시도 횟수가 아니라 진행 중
    expect(jobStatusText(w('upload_slice_yield'), null, null, 'youtube')).toBe('RETRY_WAIT · 업로드 진행 중 — 다음 처리에서 같은 세션으로 이어 올림');
    expect(itemHeadline({ status: 'RETRY_WAIT', channel: 'youtube', job: w('upload_slice_yield'), pub: null, blockReason: null })).toBe('비공개 업로드 진행 중 — 다음 처리에서 이어 올림');
  });
  it('401(auth_invalid_token) 보류는 "계정 다시 연결 필요", 재확인 resumable 은 고정 문구(게시하지 않음)', () => {
    const j = { ...job('BLOCKED', 'auth_invalid_token'), lastRetryClass: 'auth' };
    expect(itemHeadline({ status: 'BLOCKED', channel: 'threads', job: j, pub: null, blockReason: null })).toBe('계정 다시 연결 필요');
    expect(reconciledParam('resumable')).toBe('resumable');
    expect(reconciledNotice('resumable')).toMatch(/게시하지 않았습니다/);
  });
  it('단계 한 줄: 게시물 n/m · 상태 · 모의 ID, "게시 완료"라고 하지 않는다', () => {
    expect(remoteStepLine({ kind: 'container', status: 'created', postIndex: 1, remoteId: 'mockthr_ct_x' }, 3)).toBe('게시물 2/3 · 컨테이너 생성됨 · mockthr_ct_x');
    const pub = remoteStepLine({ kind: 'publish', status: 'published', postIndex: 0, remoteId: 'mockthr_post_y' }, 1);
    expect(pub).toBe('게시물 1/1 · 게시됨(MOCK) · mockthr_post_y');
    expect(pub).not.toMatch(/게시 완료/);
  });
  it('시나리오 선택지는 항목 어댑터에 맞는 것만(success 는 둘 다)', () => {
    const thr = mockScenarioOptionsFor('mock_threads').map((o) => o.value);
    const gen = mockScenarioOptionsFor('mock_generic').map((o) => o.value);
    expect(thr).toContain('threads_thread_partial');
    expect(thr).not.toContain('ambiguous_sent');
    expect(gen).not.toContain('threads_success');
    expect(thr).toContain('success');
    expect(gen).toContain('success');
  });
});

describe('stepsPanelView — M4 화면 FIX(S1): 단계 패널은 기록된 어댑터 기준', () => {
  const base = { currentAdapter: 'mock_threads' as const, platform: 'threads', remoteStepKinds: [] as string[] };

  it('T14 이전 전송 의도(adapter_id 없음)는 mock_generic — 지금 연결됨(mock_threads)이어도 "일반 모의 어댑터로 처리됨"', () => {
    const v = stepsPanelView({ ...base, latestIntent: { sanitizedDetails: { mode: 'MOCK' } } });
    expect(v).toMatchObject({ panel: 'threads', adapter: 'mock_generic', source: 'intent' });
    expect(v.note).toBe('일반 모의 어댑터로 처리됨 — Threads 단계 기록 없음(MOCK)');
    expect(v.note).not.toContain('진행');
  });

  it('adapter_id: null 도 mock_generic', () => {
    expect(stepsPanelView({ ...base, latestIntent: { sanitizedDetails: { adapter_id: null } } }).adapter).toBe('mock_generic');
  });

  it('YouTube 계정·일반 모의로 처리된 의도 → YouTube 쪽 같은 안내', () => {
    const v = stepsPanelView({ currentAdapter: 'mock_youtube', platform: 'youtube', remoteStepKinds: [], latestIntent: { sanitizedDetails: {} } });
    expect(v).toMatchObject({ panel: 'youtube', adapter: 'mock_generic' });
    expect(v.note).toBe('일반 모의 어댑터로 처리됨 — YouTube 업로드 단계 기록 없음(MOCK)');
  });

  it('기록된 mock_threads 의도 → Threads 단계 패널(안내 없음), 현재 선택이 mock_generic 이어도', () => {
    const v = stepsPanelView({ ...base, currentAdapter: 'mock_generic', latestIntent: { sanitizedDetails: { adapter_id: 'mock_threads' } } });
    expect(v).toEqual({ panel: 'threads', adapter: 'mock_threads', source: 'intent', note: null });
  });

  it('기록된 mock_youtube 의도 → YouTube 패널', () => {
    const v = stepsPanelView({ currentAdapter: 'mock_generic', platform: 'youtube', remoteStepKinds: [], latestIntent: { sanitizedDetails: { adapter_id: 'mock_youtube' } } });
    expect(v).toEqual({ panel: 'youtube', adapter: 'mock_youtube', source: 'intent', note: null });
  });

  it('전송 의도가 아직 없으면 현재 선택(adapterIdFor) — mock_threads 면 진행 안내가 있는 Threads 패널', () => {
    expect(stepsPanelView({ ...base, latestIntent: null })).toEqual({ panel: 'threads', adapter: 'mock_threads', source: 'current', note: null });
  });

  it('전송 의도 없음 + 현재 선택 mock_generic → 패널 없음', () => {
    expect(stepsPanelView({ ...base, currentAdapter: 'mock_generic', latestIntent: null }).panel).toBeNull();
  });

  it('계정 없음 → 패널 없음(source none)', () => {
    expect(stepsPanelView({ currentAdapter: null, platform: null, remoteStepKinds: [], latestIntent: null })).toEqual({ panel: null, adapter: null, source: 'none', note: null });
  });

  it('원격 단계 기록이 있으면 그 패널(기록이 우선 보인다)', () => {
    const v = stepsPanelView({ ...base, latestIntent: { sanitizedDetails: {} }, remoteStepKinds: ['container'] });
    expect(v).toMatchObject({ panel: 'threads', note: null });
  });

  it('모르는 adapter_id → 확인 불가 안내(진행 안내 아님)', () => {
    const v = stepsPanelView({ ...base, latestIntent: { sanitizedDetails: { adapter_id: 'live_threads' } } });
    expect(v).toMatchObject({ panel: 'threads', adapter: null, source: 'intent' });
    expect(v.note).toBe('전송 의도에 기록된 어댑터를 확인할 수 없음 — Threads 단계 표시 안 함(MOCK)');
  });

  it('일반 채널(blog 등) + 일반 모의 의도 → 패널 없음', () => {
    expect(stepsPanelView({ currentAdapter: 'mock_generic', platform: 'blog', remoteStepKinds: [], latestIntent: { sanitizedDetails: {} } }).panel).toBeNull();
  });
});

describe('accountHealthLine — M4 화면 FIX(S3): 배포 계정 연결 상태(설정 화면과 같은 라벨)', () => {
  const h = (status: Parameters<typeof accountHealthLine>[0]['status'], extra: Partial<Parameters<typeof accountHealthLine>[0]> = {}) =>
    accountHealthLine({ status, usable_for_execution: false, credential_required: true, pending_reconcile: null, mock: true, ...extra });

  it('상태별 한국어 라벨', () => {
    expect(h('not_connected', { usable_for_execution: true, credential_required: false }).label).toBe('연결 정보 없음');
    expect(h('connected', { usable_for_execution: true }).label).toBe('연결됨');
    expect(h('expiring_soon', { usable_for_execution: true }).label).toBe('곧 만료');
    expect(h('expired').label).toBe('만료됨');
    expect(h('revoked').label).toBe('연결 해제됨');
    expect(h('needs_reconnect').label).toBe('다시 연결 필요');
    expect(h('error').label).toBe('오류');
  });

  it('정리 대기가 있으면 "정리 대기 차단" + 배포 실행 차단', () => {
    const r = h('error', { pending_reconcile: 'cleanup_revoke' });
    expect(r.label).toBe('정리 대기 차단');
    expect(r.text).toBe('정리 대기 차단 — 배포 실행 차단');
    expect(r.warn).toBe(true);
  });

  it('연결한 적 없는 모의 계정: 실행 가능 안내, 경고 아님', () => {
    const r = h('not_connected', { usable_for_execution: true, credential_required: false });
    expect(r).toEqual({ label: '연결 정보 없음', warn: false, text: '연결 정보 없음 — 모의 배포는 연결 없이 가능(결과는 MOCK)' });
  });

  it('연결됨: 경고·차단 없음', () => {
    expect(h('connected', { usable_for_execution: true })).toEqual({ label: '연결됨', warn: false, text: '연결됨' });
  });

  it('다시 연결 필요·만료됨: 배포 실행 차단', () => {
    expect(h('needs_reconnect').text).toBe('다시 연결 필요 — 배포 실행 차단');
    expect(h('expired').text).toBe('만료됨 — 배포 실행 차단');
  });
});

describe('M4 화면 FIX(S4) — YouTube 업로드 패널: "(세션 있음)" 은 세션이 있을 때만', () => {
  it('세션 없음: 공통 MOCK 안내만, "세션 있음" 문구 없음', () => {
    const t = youtubeSessionNote({ hasSession: false });
    expect(t).toBe(YOUTUBE_MOCK_DISCLAIMER);
    expect(t).not.toContain('세션 있음');
    expect(t).not.toContain('세션 URI');
  });

  it('세션 있음: 세션 URI 미표시 안내(세션 있음) + 공통 MOCK 안내', () => {
    const t = youtubeSessionNote({ hasSession: true });
    expect(t).toContain('세션 URI 는 화면·로그에 표시하지 않습니다(세션 있음)');
    expect(t.endsWith(YOUTUBE_MOCK_DISCLAIMER)).toBe(true);
  });
});

describe('M4 화면 FIX(S5, D27) — 요청한 예약 공개 시각과 원격 결과 구분(publishAtView)', () => {
  const publishAt = '2026-10-04T07:00:00.000Z'; // 10:00 MSK

  it('publish_at 없음: 표시 없음', () => {
    expect(publishAtView({ publishAt: null, resultKind: 'UPLOADED_PRIVATE', isMock: true })).toBeNull();
    expect(publishAtView({ publishAt: undefined, resultKind: null, isMock: true })).toBeNull();
  });

  it('결과 전: 요청만(원격 결과 전), 경고 아님, "적용" 이라고 하지 않음', () => {
    const v = publishAtView({ publishAt, resultKind: null, isMock: true })!;
    expect(v.state).toBe('requested');
    expect(v.warn).toBe(false);
    expect(v.text).toContain('요청한 예약 공개 시각');
    expect(v.text).toContain('2026-10-04 10:00');
    expect(v.text).toContain('원격 결과 전');
    expect(v.text).not.toContain('적용');
  });

  it('SCHEDULED_REMOTE: 원격 적용으로 표시(MOCK 이면 MOCK)', () => {
    const v = publishAtView({ publishAt, resultKind: 'SCHEDULED_REMOTE', isMock: true })!;
    expect(v.state).toBe('applied');
    expect(v.warn).toBe(false);
    expect(v.text).toMatch(/^예약 공개\(원격 publishAt 적용\): .+ \(MOCK\)$/);
    expect(v.text).toContain('2026-10-04 10:00');
    expect(v.text).not.toContain('적용하지 않음');
  });

  it('UPLOADED_PRIVATE(미검증 프로젝트가 비공개 강제·publishAt 버림): 원격이 적용하지 않음 + 경고', () => {
    const v = publishAtView({ publishAt, resultKind: 'UPLOADED_PRIVATE', isMock: true })!;
    expect(v.state).toBe('not_applied');
    expect(v.warn).toBe(true);
    expect(v.text).toContain('요청한 예약 공개 시각');
    expect(v.text).toContain('2026-10-04 10:00');
    expect(v.text).toContain('원격이 적용하지 않음(미검증 프로젝트 등으로 비공개로 강제, MOCK)');
    expect(v.text).not.toContain('원격 publishAt 적용');
  });

  it('PUBLISHED 등 다른 결과: 원격이 적용하지 않음 + 원격 결과 종류', () => {
    const v = publishAtView({ publishAt, resultKind: 'PUBLISHED', isMock: false })!;
    expect(v.state).toBe('not_applied');
    expect(v.text).toContain('원격이 적용하지 않음(원격 결과: 게시)');
    expect(v.text).not.toContain('MOCK');
  });

  it('잘못된 시각: 시각 미확인', () => {
    expect(publishAtView({ publishAt: 'nope', resultKind: null, isMock: true })!.text).toContain('시각 미확인');
  });
});
