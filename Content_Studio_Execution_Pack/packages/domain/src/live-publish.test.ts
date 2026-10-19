/**
 * LIVEP1-DIAG: 실제 Threads 오류 진단 — 허용 목록 필드·형식만 남는지(문구·URL·토큰·긴 문자열은 버림). 순수 함수 시험(네트워크 없음).
 */
import { describe, expect, it } from 'vitest';
import {
  LIVE_PUBLISH_DAILY_WINDOW_MS,
  LIVE_PUBLISH_PAUSED_MESSAGE,
  LIVE_PUBLISH_RESUME_CONFIRM_TEXT,
  livePublishDailyLimitMessage,
  livePublishDailyLockName,
  livePublishDailyUsageText,
  LivePublishResumeConfirmError,
  livePublishStatusLine,
  livePublishSwitchLabel,
  sanitizeThreadsDiag,
  threadsDiagFromBody,
} from './live-publish';

const TOKEN = 'FAKE_diag_token_LIVEP1DIAG_tttttttttttttttt';
const MSG = `Application does not have permission for this action ${TOKEN} https://graph.threads.net/v1.0/x?access_token=${TOKEN}`;

describe('threadsDiagFromBody — Graph 오류 본문에서 허용 목록만', () => {
  it('중첩 error 객체: http·code·subcode·type(…Exception)·is_transient·fbtrace 만, message·error_user_msg·error_user_title 은 버림', () => {
    const d = threadsDiagFromBody('create', 403, {
      error: { message: MSG, type: 'OAuthException', code: 10, error_subcode: 2207051, is_transient: false, error_user_title: TOKEN, error_user_msg: MSG, fbtrace_id: 'AbC_12-x' },
    });
    expect(d).toEqual({ op: 'create', http_status: 403, code: 10, error_subcode: 2207051, error_type: 'OAuthException', is_transient: false, fbtrace_id: 'AbC_12-x' });
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    expect(JSON.stringify(d)).not.toContain('permission');
  });
  it('평면(Threads) 형식·문자열 숫자 코드도 읽는다', () => {
    expect(threadsDiagFromBody('publish', 400, { error_type: 'THApiException', code: '100', error_message: MSG })).toEqual({ op: 'publish', http_status: 400, code: 100, error_type: 'THApiException' });
  });
  it.each<[string, Record<string, unknown>]>([
    ['type 이 …Exception 형식 아님(문장)', { type: `OAuth ${TOKEN} Exception` }],
    ['type 이 너무 김', { type: `${'A'.repeat(41)}Exception` }],
    ['type 에 숫자·기호', { type: 'Bad1Exception' }],
    ['fbtrace 에 허용 밖 문자', { fbtrace_id: 'abc def/..' }],
    ['fbtrace 너무 김', { fbtrace_id: 'a'.repeat(65) }],
    ['code 음수·소수·너무 큼·문장', { code: -1, error_subcode: 1.5 }],
    ['is_transient 문자열', { is_transient: 'true' }],
  ])('%s → 그 필드는 버림', (_, err) => {
    const d = threadsDiagFromBody('status', 500, { error: err });
    expect(d).toEqual({ op: 'status', http_status: 500 });
  });
  it('본문이 없거나 이상해도 http 상태만(응답이 있으면), 아무것도 없으면 null', () => {
    expect(threadsDiagFromBody('read', 502, null)).toEqual({ op: 'read', http_status: 502 });
    expect(threadsDiagFromBody('read', null, 'not json')).toBeNull();
  });
});

describe('sanitizeThreadsDiag — 쓰기 직전 한 번 더', () => {
  it('모르는 키·문구 키는 버리고, op 만 있으면 null', () => {
    expect(sanitizeThreadsDiag({ op: 'list', http_status: 429, message: MSG, url: 'https://x', token: TOKEN, body: '{}' })).toEqual({ op: 'list', http_status: 429 });
    expect(sanitizeThreadsDiag({ op: 'list' })).toBeNull();
    expect(sanitizeThreadsDiag({ op: 'hack', transport: 'timeout' })).toEqual({ transport: 'timeout' });
    expect(sanitizeThreadsDiag({ http_status: 99 })).toBeNull();
    expect(sanitizeThreadsDiag('x')).toBeNull();
    expect(sanitizeThreadsDiag([1])).toBeNull();
  });
});

describe('LIVE-P2(D39): 최근 24시간 상한·즉시 중지 문구', () => {
  it('상한 문구: 상한 건수와 다시 보낼 수 있는 시각(모스크바)을 말한다', () => {
    // 2026-10-20 09:00 UTC = 12:00 MSK
    expect(livePublishDailyLimitMessage(3, new Date('2026-10-20T09:00:00Z'))).toBe(
      "최근 24시간 실제 게시 상한(3건)을 다 써서 게시하지 않았습니다. 2026-10-20 12:00 (MSK) 이후 '재시도'로 다시 보낼 수 있습니다.",
    );
    expect(livePublishDailyLimitMessage(1, '2026-10-19T21:30:00.000Z')).toContain('2026-10-20 00:30 (MSK) 이후');
    // 시각을 모르거나 읽을 수 없으면 꾸며내지 않는다
    for (const v of [null, undefined, '', 'not-a-date']) expect(livePublishDailyLimitMessage(3, v)).toContain('잠시 뒤 이후');
  });
  it('중지 문구·재개 확인 문구·창·잠금 이름', () => {
    expect(LIVE_PUBLISH_PAUSED_MESSAGE).toContain('일시 중지');
    expect(LIVE_PUBLISH_PAUSED_MESSAGE).toContain("'재시도'");
    expect(LIVE_PUBLISH_RESUME_CONFIRM_TEXT).toBe('재개');
    const e = new LivePublishResumeConfirmError();
    expect({ kind: e.kind, code: e.code }).toEqual({ kind: 'bad_request', code: 'live_resume_confirm_required' });
    expect(LIVE_PUBLISH_DAILY_WINDOW_MS).toBe(86_400_000);
    expect(livePublishDailyLockName('00000000-0000-4000-8000-000000000001')).toBe('cs_live_publish_daily:00000000-0000-4000-8000-000000000001');
  });
  it('설정 화면 상태: 꺼짐(PUBLISH_MODE) > 꺼짐(준비 안 됨) > 일시 중지됨 > 켜짐', () => {
    expect(livePublishSwitchLabel({ publishEnabled: false, ready: false, paused: true })).toBe('꺼짐(PUBLISH_MODE)');
    expect(livePublishSwitchLabel({ publishEnabled: true, ready: false, paused: false })).toBe('꺼짐(실제 게시 준비 안 됨)');
    expect(livePublishSwitchLabel({ publishEnabled: true, ready: true, paused: true })).toBe('일시 중지됨');
    expect(livePublishSwitchLabel({ publishEnabled: true, ready: true, paused: false })).toBe('켜짐');
  });
  it('사용 문구·홈/계획 한 줄', () => {
    expect(livePublishDailyUsageText(2, 3)).toBe('최근 24시간 2/3');
    expect(livePublishDailyUsageText(4, null)).toBe('최근 24시간 4건(일일 상한 없음)');
    expect(livePublishDailyUsageText(0, undefined)).toBe('최근 24시간 0건(일일 상한 없음)');
    const on = { publishEnabled: true, ready: true };
    expect(livePublishStatusLine({ ...on, paused: false, used: 1, limit: 3 })).toBe('실제 게시: 최근 24시간 1/3');
    expect(livePublishStatusLine({ ...on, paused: true, used: 1, limit: 3 })).toBe('실제 게시 일시 중지됨 — 재개 전에는 게시하지 않음(최근 24시간 1/3)');
    expect(livePublishStatusLine({ publishEnabled: false, ready: false, paused: false, used: 0, limit: 3 })).toBe('실제 게시: 최근 24시간 0/3 · 꺼짐(실제로 게시하지 않음)');
    expect(livePublishStatusLine({ publishEnabled: true, ready: false, paused: false, used: 0, limit: null })).toBe('실제 게시: 최근 24시간 0건(일일 상한 없음) · 꺼짐(실제로 게시하지 않음)');
  });
});
