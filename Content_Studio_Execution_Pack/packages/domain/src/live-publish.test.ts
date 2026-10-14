/**
 * LIVEP1-DIAG: 실제 Threads 오류 진단 — 허용 목록 필드·형식만 남는지(문구·URL·토큰·긴 문자열은 버림). 순수 함수 시험(네트워크 없음).
 */
import { describe, expect, it } from 'vitest';
import { sanitizeThreadsDiag, threadsDiagFromBody } from './live-publish';

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
