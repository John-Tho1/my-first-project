/**
 * 쿼리(?error= 등)처럼 사용자가 바꿀 수 있는 값으로 고정 문구 표를 찾을 때 쓴다.
 * 표의 자기 키일 때만 문구를 돌려준다 — `__proto__`·`constructor`·`toString` 같은 값이 Object.prototype 의 속성을 꺼내
 * 문자열이 아닌 값을 렌더하거나(화면 깨짐) 엉뚱한 문구를 보이지 않게 한다. 없으면 undefined(호출부의 `?? 기본 문구` 로 넘어감).
 */
export function ownText(table: Readonly<Record<string, string>>, key: string | null | undefined): string | undefined {
  if (typeof key !== 'string' || !Object.hasOwn(table, key)) return undefined;
  const v = table[key];
  return typeof v === 'string' ? v : undefined;
}
