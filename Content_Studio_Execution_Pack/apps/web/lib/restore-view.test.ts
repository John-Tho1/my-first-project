/** FIX2-T13(Codex Q11): 복원 화면의 "다시 연결 필요" 안내 — 이름·플랫폼만, ID 없음. */
import { describe, expect, it } from 'vitest';
import { reconnectNotice } from './restore-view';

const ID = '11111111-1111-4111-8111-111111111111';

describe('reconnectNotice', () => {
  it('없으면 null', () => {
    expect(reconnectNotice({ reconnect_required_accounts: [], reconnect_required_labels: [] }, false)).toBeNull();
    expect(reconnectNotice(null, false)).toBeNull();
  });
  it('미리보기: 기존 계정·새 계정을 한국어로, 계정 ID 는 넣지 않는다', () => {
    const n = reconnectNotice(
      {
        reconnect_required_accounts: [ID, '22222222-2222-4222-8222-222222222222'],
        reconnect_required_labels: [
          { platform: 'threads', display_name: 'MOCK Threads 계정', existing: true },
          { platform: 'instagram', display_name: 'MOCK Instagram 계정', existing: false },
        ],
      },
      false,
    )!;
    expect(n.title).toContain('2개');
    expect(n.title).toContain('됩니다');
    expect(n.lines[0]).toBe('MOCK Threads 계정 · Threads — 이미 있던 계정(이번 복원으로 실행 차단)');
    expect(n.lines[1]).toContain('Instagram');
    expect(JSON.stringify(n)).not.toContain(ID);
  });
  it('결과 화면은 "되었습니다", 옛 기록(이름 없음)은 개수만', () => {
    const n = reconnectNotice({ reconnect_required_accounts: [ID] }, true)!;
    expect(n.title).toContain('1개');
    expect(n.title).toContain('되었습니다');
    expect(n.lines).toEqual([]);
  });
});
