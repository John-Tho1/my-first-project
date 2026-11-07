/** FIX2-T13(Codex Q11): 복원 화면의 "다시 연결 필요" 안내 — 이름·플랫폼만, ID 없음. */
import { describe, expect, it } from 'vitest';
import { reconnectNotice, restoreInvalidationNotices } from './restore-view';

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

describe('FIX1-FULLREV3(H3): restoreInvalidationNotices — 부분 게시(UNKNOWN)·진행 중 항목을 "실행 전으로"와 나눈다', () => {
  it('옛 기록(partial_job_ids·in_flight 칸 없음)·없음: 지금까지 문구 그대로, 부분 게시 안내 없음', () => {
    expect(restoreInvalidationNotices(undefined, true)).toEqual([]);
    expect(restoreInvalidationNotices([], false)).toEqual([]);
    const old = [{ reasons: ['brand_changed'] }, { reasons: ['risk_needs_check'] }, { reasons: ['brand_changed'], partial_job_ids: [] }];
    expect(restoreInvalidationNotices(old, true)).toEqual([
      {
        testid: 'restore-brand-invalidated',
        text: '복원으로 브랜드 프로필 새 버전이 들어와, 이 환경에 있던 승인 2건을 무효로 했습니다(대기 중이던 실행은 보류, 항목은 실행 전으로). 배포 계획에서 새 브랜드로 다시 계획·승인하세요.',
      },
      {
        testid: 'restore-risk-invalidated',
        text: "복원으로 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 1건을 무효로 했습니다(대기 중이던 실행은 보류, 항목은 실행 전으로). 소재의 '확인 필요'를 해제한 뒤 다시 승인하세요.",
      },
    ]);
    expect(restoreInvalidationNotices(old, false).map((n) => n.text)).toEqual([
      '복원하면 브랜드 프로필 새 버전이 들어와, 이 환경에 있는 승인 2건이 무효가 됩니다(대기 중인 실행은 보류, 항목은 실행 전으로).',
      "복원하면 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 1건이 무효가 됩니다(대기 중인 실행은 보류, 항목은 실행 전으로).",
    ]);
  });
  it('모두 부분 게시면 "실행 전으로"라고 하지 않고 UNKNOWN 안내만(다시 게시하지 않음·직접 확인)', () => {
    const n = restoreInvalidationNotices([{ reasons: ['brand_changed'], partial_job_ids: ['j1'] }], true);
    expect(n.map((x) => x.testid)).toEqual(['restore-brand-invalidated', 'restore-partial-unknown']);
    expect(n[0]!.text).toBe('복원으로 브랜드 프로필 새 버전이 들어와, 이 환경에 있던 승인 1건을 무효로 했습니다.');
    expect(n[0]!.text).not.toContain('실행 전으로');
    expect(n[1]!.text).toContain('1건은 이미 일부가 게시됐거나');
    expect(n[1]!.text).toContain('결과 불명(UNKNOWN)');
    expect(n[1]!.text).toContain('처음부터 다시 보내지 않습니다');
    expect(n[1]!.text).toContain('직접 확인');
  });
  it('섞이면 "실행 전으로"는 나머지 수만, 부분 게시·진행 중은 따로(두 사유의 부분 게시는 합쳐 센다)', () => {
    const n = restoreInvalidationNotices(
      [
        { reasons: ['risk_needs_check'], partial_job_ids: ['j1'], in_flight: false },
        { reasons: ['risk_needs_check'], partial_job_ids: [], in_flight: true },
        { reasons: ['risk_needs_check'], partial_job_ids: [], in_flight: false },
        { reasons: ['brand_changed'], partial_job_ids: ['j2', 'j3'] },
      ],
      false,
    );
    expect(n.map((x) => x.testid)).toEqual(['restore-brand-invalidated', 'restore-risk-invalidated', 'restore-partial-unknown', 'restore-inflight-invalidated']);
    expect(n[1]!.text).toBe("복원하면 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 3건이 무효가 됩니다. 그중 1건은 대기 중인 실행을 보류하고 항목을 실행 전으로 돌립니다.");
    expect(n[2]!.text).toContain('무효가 될 승인 중 2건은');
    expect(n[3]!.text).toContain('무효가 될 승인 중 1건은 전송 중인 항목이라');
  });  it('FIX1-FULLREV3(H3 후속): 보내기 직전(LEASED) 부분 게시 작업은 "실행 전으로"로 세지 않고 따로 — 다음 전송이 다시 보내지 않고 UNKNOWN 으로 정함', () => {
    const n = restoreInvalidationNotices(
      [
        { reasons: ['brand_changed'], partial_job_ids: [], leased_partial_job_ids: ['j1'], in_flight: false },
        { reasons: ['brand_changed'], partial_job_ids: [], leased_partial_job_ids: [], in_flight: false },
      ],
      true,
    );
    expect(n.map((x) => x.testid)).toEqual(['restore-brand-invalidated', 'restore-leased-partial']);
    expect(n[0]!.text).toBe(
      '복원으로 브랜드 프로필 새 버전이 들어와, 이 환경에 있던 승인 2건을 무효로 했습니다. 그중 1건은 대기 중이던 실행을 보류하고 항목을 실행 전으로 돌렸습니다 — 배포 계획에서 새 브랜드로 다시 계획·승인하세요.',
    );
    expect(n[1]!.text).toContain('무효가 된 승인 중 1건은 보내기 직전이던 작업에 이미 일부가 게시됐거나 게시 시도가 있어, 항목을 실행 전으로 되돌리지 않았습니다');
    expect(n[1]!.text).toContain('다시 보내지 않고 결과 불명(UNKNOWN)으로 정해집니다');
    expect(n[1]!.text).not.toContain('두었습니다');
    // 미리보기 문구
    const pv = restoreInvalidationNotices([{ reasons: ['risk_needs_check'], leased_partial_job_ids: ['j1'] }], false);
    expect(pv.map((x) => x.testid)).toEqual(['restore-risk-invalidated', 'restore-leased-partial']);
    expect(pv[0]!.text).not.toContain('실행 전으로');
    expect(pv[1]!.text).toContain('무효가 될 승인 중 1건은 보내기 직전인 작업에');
  });
  it('FIX2-FULLREV3(K2): 이전 복원 확인 표시로 보류 그대로 둔 항목(restored_review)은 "실행 전으로"로 세지 않고 따로 — 게시물이 없을 때만 새 계획(FIX5-FULLREV T2 조건부 문구)', () => {
    const n = restoreInvalidationNotices(
      [
        { reasons: ['brand_changed'], partial_job_ids: [], leased_partial_job_ids: [], in_flight: false, restored_review: true },
        { reasons: ['brand_changed'], partial_job_ids: [], leased_partial_job_ids: [], in_flight: false, restored_review: false },
      ],
      true,
    );
    expect(n.map((x) => x.testid)).toEqual(['restore-brand-invalidated', 'restore-restored-review']);
    expect(n[0]!.text).toBe(
      '복원으로 브랜드 프로필 새 버전이 들어와, 이 환경에 있던 승인 2건을 무효로 했습니다. 그중 1건은 대기 중이던 실행을 보류하고 항목을 실행 전으로 돌렸습니다 — 배포 계획에서 새 브랜드로 다시 계획·승인하세요.',
    );
    expect(n[1]!.text).toBe(
      '무효가 된 승인 중 1건은 이전 복원에서 확인이 필요한 보류 항목이라 실행 전으로 돌리지 않았습니다(그대로 보류 — 다시 승인할 수 없음). 채널에서 이 계정의 최근 게시물을 직접 확인하세요 — 있으면 그대로 두고, 직접 확인해 게시물이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 내용이 두 번 올라갈 수 있습니다).',
    );
    // 모두 restored_review 면 사유 문구에 "실행 전으로"가 없다
    const only = restoreInvalidationNotices([{ reasons: ['risk_needs_check'], restored_review: true }], false);
    expect(only.map((x) => x.testid)).toEqual(['restore-risk-invalidated', 'restore-restored-review']);
    expect(only[0]!.text).toBe("복원하면 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 1건이 무효가 됩니다.");
    expect(only[1]!.text).toBe(
      '무효가 될 승인 중 1건은 이전 복원에서 확인이 필요한 보류 항목이라 실행 전으로 돌리지 않습니다(그대로 보류 — 다시 승인할 수 없음). 복원 뒤 채널에서 이 계정의 최근 게시물을 직접 확인하세요 — 있으면 그대로 두고, 직접 확인해 게시물이 없을 때만 새 배포 계획으로 다시 승인하세요(확인하지 않고 새 계획을 만들면 같은 내용이 두 번 올라갈 수 있습니다).',
    );
    // 옛 기록(restored_review 칸 없음)·null 은 false — 지금까지 문구 그대로(안내 추가 없음)
    expect(restoreInvalidationNotices([{ reasons: ['brand_changed'], restored_review: null }], true).map((x) => x.testid)).toEqual(['restore-brand-invalidated']);
  });
});
