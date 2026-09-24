/** 화면 표시용 한국어 라벨(서버 컴포넌트 공용). */
export const INPUT_TYPE_LABEL: Record<string, string> = {
  text: '텍스트',
  url: 'URL',
  file: '파일',
  voice: '음성',
};

export const RISK_LABEL: Record<string, string> = {
  none: '위험 표시 없음',
  needs_check: '확인 필요',
};

/** 원문 미리보기: 앞 n자(코드 포인트 기준) + 말줄임 */
export function preview(text: string, n = 120): string {
  const chars = Array.from(text);
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : text;
}
