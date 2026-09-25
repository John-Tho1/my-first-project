import { redirect } from 'next/navigation';
import { ALLOWED_MEDIA_MIME, sttLiveReadiness } from '@cs/domain';
import { getSession } from '../../lib/auth';
import { getConfig } from '../../lib/server';
import RecordClient from './RecordClient';

export const dynamic = 'force-dynamic';

/**
 * 음성 전사(T08, 결정 D9). 전사는 모의(실제 음성 인식 아님). 파일 업로드 → 조각 업로드(끊기면 같은 세션으로 이어 올림) →
 * 서버 확인(형식 서명·크기·checksum) → 전사 요청 → 진행률 → 전사 본문 수정·소재로 보내기.
 * 브라우저 녹음은 기기 확인 뒤 추가한다(docs/01) — 이 화면은 지원 여부만 알려 주고 파일 업로드로 안내한다.
 */
export default async function RecordPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  const config = getConfig();
  const live = sttLiveReadiness(config);
  return (
    <main className="container">
      <h2 className="screen-title">음성 전사</h2>
      <p className="notice" role="note">
        전사: {config.STT_MODE === 'mock' ? '모의(실제 음성 인식 아님 — 자리표시 문장)' : '실제(live) — 준비 안 됨, 요청이 거부됩니다'}. 외부 전사 공급자 연결은 별도 승인
        뒤에만 합니다(결정 D9). live 준비 안 됨: {live.missing.join(', ')}
      </p>
      <p className="note">
        올릴 수 있는 형식: {ALLOWED_MEDIA_MIME.join(', ')} · 음성 최대 200MB, 영상 최대 2GB · 조각 8MiB · 업로드 세션은 24시간 뒤 만료됩니다.
        서버 확인(VERIFIED)은 형식 서명·크기·checksum 만 확인하며 재생 가능 여부는 확인하지 않습니다.
      </p>
      <RecordClient />
    </main>
  );
}
