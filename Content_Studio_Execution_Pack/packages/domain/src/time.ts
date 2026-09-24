/**
 * 시간 규칙: 저장은 UTC(timestamptz), 표시는 Europe/Moscow(MSK).
 * 서버 로컬 시간대에 의존하지 않는다.
 */
export const DISPLAY_TIMEZONE = 'Europe/Moscow' as const;

const mskFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: DISPLAY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `YYYY-MM-DD HH:mm (MSK)` */
export function formatMsk(date: Date | string | number): string {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new RangeError('유효하지 않은 시각입니다');
  const parts = Object.fromEntries(mskFormatter.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (MSK)`;
}
