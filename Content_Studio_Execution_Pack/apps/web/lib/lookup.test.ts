/**
 * 쿼리 값으로 고정 문구 표를 찾는 곳(?error= 등)은 ownText 로만 찾는다 — `__proto__`·`constructor` 같은 값이 Object.prototype 의 속성을
 * 꺼내 문자열이 아닌 값을 렌더하지(화면 깨짐) 않게.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownText } from './lookup';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'app');

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) return pages(p);
    return /\.tsx?$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

describe('ownText — 자기 키일 때만 문구', () => {
  const T: Record<string, string> = { denied: '거부', server: '서버 오류' };
  it('있는 키 → 문구, 없는 키·null·undefined → undefined', () => {
    expect(ownText(T, 'denied')).toBe('거부');
    expect(ownText(T, 'nope')).toBeUndefined();
    expect(ownText(T, null)).toBeUndefined();
    expect(ownText(T, undefined)).toBeUndefined();
  });
  it('__proto__·constructor·toString·hasOwnProperty·valueOf → undefined(프로토타입 속성을 꺼내지 않음)', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
      expect(ownText(T, k)).toBeUndefined();
      // 대조: 그냥 대괄호로 찾으면 문자열이 아닌 값이 나온다(고친 결함)
      expect(typeof (T as Record<string, unknown>)[k]).not.toBe('string');
    }
  });
});

describe('화면: 쿼리 값으로 문구 표를 대괄호로 찾지 않는다(ownText 만)', () => {
  it('app/** 에 `TABLE[q.x]`·`TABLE[str(q.x)!]`·`TABLE[params.x]` 꼴이 없다', () => {
    const offenders: string[] = [];
    for (const f of pages(appDir)) {
      const s = readFileSync(f, 'utf8');
      const m = s.match(/\b[A-Z][A-Z_]{3,}\[(?:str\()?(?:q|params|sp)\.[a-zA-Z_]+\)?!?\]/g);
      if (m) offenders.push(`${path.relative(appDir, f)}: ${m.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('바꾼 화면들은 ownText 를 쓴다(대표: 로그인·원고·브랜드·설정·홈)', () => {
    const read = (p: string) => readFileSync(path.join(appDir, p), 'utf8');
    expect(read('login/page.tsx')).toContain('ownText(ERROR_TEXT, code) ?? ERROR_TEXT.denied');
    expect(read('contents/[id]/page.tsx')).toContain('ownText(FORM_ERROR_TEXT, str(q.error)!) ?? ownText(WRITING_ERROR_TEXT, str(q.error)!)');
    expect(read('brand/page.tsx')).toContain('ownText(WRITING_ERROR_TEXT, str(q.error)!) ?? WRITING_ERROR_TEXT.server');
    expect(read('settings/page.tsx')).toContain('ownText(ACCOUNT_ERROR_TEXT, str(q.account_error)!)');
    expect(read('page.tsx')).toContain('ownText(UPLOAD_TEXT, params.upload)');
  });
});
