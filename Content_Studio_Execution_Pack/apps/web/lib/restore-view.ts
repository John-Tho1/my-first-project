/**
 * FIX2-T13(Codex review-FIX-T13 Q11): 복원 미리보기·결과 화면의 "다시 연결 필요" 안내 문구. 플랫폼·표시 이름만 쓴다(계정 ID·비밀 없음).
 * 옛 미리보기 기록(reconnect_required_labels 없음)은 개수만 보여 준다.
 */
import { CHANNEL_LABEL, type Channel } from '@cs/domain';

export interface ReconnectSource {
  reconnect_required_accounts?: string[] | null;
  reconnect_required_labels?: Array<{ platform: string; display_name: string; existing: boolean }> | null;
}

export interface ReconnectNotice {
  title: string;
  lines: string[];
}

export function reconnectNotice(src: ReconnectSource | null | undefined, committed: boolean): ReconnectNotice | null {
  const ids = src?.reconnect_required_accounts ?? [];
  const labels = src?.reconnect_required_labels ?? null;
  if (!ids.length && !labels?.length) return null;
  const verb = committed ? '되었습니다' : '됩니다';
  const title = `배포 계정 ${labels?.length ?? ids.length}개가 복원 후 "다시 연결 필요"가 ${verb}. 다시 연결하기 전까지 이 계정으로는 배포를 실행하지 않습니다.`;
  if (!labels) return { title, lines: [] };
  const lines = labels.map((l) => {
    const platform = CHANNEL_LABEL[l.platform as Channel] ?? l.platform;
    return `${l.display_name} · ${platform} — ${l.existing ? '이미 있던 계정(이번 복원으로 실행 차단)' : '새로 들어오는 계정(연결 정보는 내보내기에 없음)'}`;
  });
  return { title, lines };
}
