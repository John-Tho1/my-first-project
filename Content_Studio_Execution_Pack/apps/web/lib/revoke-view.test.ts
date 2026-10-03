import { describe, expect, it } from 'vitest';
import { REVOKE_DONE_TEXT, REVOKE_INCOMPLETE_CODES, REVOKE_INCOMPLETE_TEXT, revokeNotice, revokeRedirectPath } from './revoke-view';

const paramsOf = (path: string) => new URL(`http://localhost:3000${path}`).searchParams;

describe('M4UI FIX1 — 연결 해제 HTML 폼 결과(revokeRedirectPath·revokeNotice)', () => {
  it('끝난 해제(revoked·already_revoked·completed_by_other) → ?revoked=1, "해제했습니다"', () => {
    for (const o of ['revoked', 'already_revoked', 'completed_by_other']) {
      const p = revokeRedirectPath(o, null);
      expect(p).toBe('/settings?revoked=1#accounts');
      const n = revokeNotice({ revoked: paramsOf(p).get('revoked') ?? undefined });
      expect(n).toEqual({ text: REVOKE_DONE_TEXT, warn: false });
    }
  });

  it('incomplete + 허용 코드 4종 → ?revoke=incomplete&revoke_code=<코드>, 경고 문구(끝나지 않음·차단 유지·다음 일), "해제했습니다" 없음', () => {
    for (const code of REVOKE_INCOMPLETE_CODES) {
      const p = revokeRedirectPath('incomplete', code);
      expect(p).toBe(`/settings?revoke=incomplete&revoke_code=${code}#accounts`);
      const q = paramsOf(p);
      expect(q.get('revoked')).toBeNull();
      const n = revokeNotice({ revoke: q.get('revoke') ?? undefined, code: q.get('revoke_code') ?? undefined })!;
      expect(n.warn).toBe(true);
      expect(n.text).toBe(REVOKE_INCOMPLETE_TEXT[code]);
      expect(n.text).toContain('연결 해제가 끝나지 않았습니다');
      expect(n.text).toContain('배포 실행이 계속 차단됩니다');
      expect(n.text).toContain('원인이 해결되고 재개 조건이 갖춰지면');
      expect(n.text).toContain('해제가 끝날 때까지 이 계정의 배포 실행은 차단됩니다');
      expect(n.text).not.toMatch(/마무리합니다|마무리하며|자동으로 완료/);
      expect(n.text).not.toContain('연결을 해제했습니다');
    }
    expect(REVOKE_INCOMPLETE_TEXT.revoke_current_no_key).toContain('키를 설정하면');
    expect(REVOKE_INCOMPLETE_TEXT.revoke_current_unreadable).toContain('이전 키 버전');
  });

  it('incomplete + 코드 없음·허용 목록 밖 값 → 코드 없이 리다이렉트, 일반 미완료 문구(원문 값을 싣지 않음)', () => {
    expect(revokeRedirectPath('incomplete', null)).toBe('/settings?revoke=incomplete#accounts');
    const evil = 'revoke_x&revoked=1<script>';
    const p = revokeRedirectPath('incomplete', evil);
    expect(p).toBe('/settings?revoke=incomplete#accounts');
    expect(p).not.toContain('script');
    // 화면도 모르는 코드는 일반 문구
    const n = revokeNotice({ revoke: 'incomplete', code: evil })!;
    expect(n).toEqual({ text: REVOKE_INCOMPLETE_TEXT.unknown, warn: true });
    expect(n.text).not.toContain(evil);
  });

  it('incomplete 는 revoked=1 이 함께 와도 경고가 우선', () => {
    expect(revokeNotice({ revoked: '1', revoke: 'incomplete', code: 'revoke_current_no_key' })!.warn).toBe(true);
  });

  it('superseded → ?revoke=superseded, 경고(새 연결은 건드리지 않음)', () => {
    const p = revokeRedirectPath('superseded', null);
    expect(p).toBe('/settings?revoke=superseded#accounts');
    const n = revokeNotice({ revoke: 'superseded' })!;
    expect(n.warn).toBe(true);
    expect(n.text).toContain('건드리지 않았습니다');
  });

  it('해당 없음 → undefined, 모르는 revoke 값 → undefined', () => {
    expect(revokeNotice({})).toBeUndefined();
    expect(revokeNotice({ revoke: 'whatever' })).toBeUndefined();
  });
});
