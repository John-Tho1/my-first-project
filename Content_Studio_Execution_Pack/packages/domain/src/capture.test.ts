import { describe, expect, it } from 'vitest';
import {
  captureCreateSchema,
  contentHash,
  decodeCaptureCursor,
  encodeCaptureCursor,
  normalizeForHash,
  parseCapturePatch,
  parseIfMatchRevision,
} from './capture';
import { RawTextImmutableError } from './errors';
import { DEFAULT_SIMILARITY_THRESHOLD, findSimilar, normalizeForSimilarity, similarity } from './similarity';

const KEY = 'cmd-0001-abcd';

describe('contentHash', () => {
  it('NFC·공백 정규화 후 같은 해시', () => {
    const nfd = '한국어 메모'.normalize('NFD');
    expect(nfd).not.toBe('한국어 메모');
    expect(contentHash(nfd)).toBe(contentHash('한국어 메모'));
    expect(contentHash('  한국어\n\t메모  ')).toBe(contentHash('한국어 메모'));
    expect(contentHash('a　b')).toBe(contentHash('a b'));
  });
  it('내용이 다르면 다른 해시, sha256 hex 64자', () => {
    expect(contentHash('메모 A')).not.toBe(contentHash('메모 B'));
    expect(contentHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('대소문자는 구분한다(정확 중복만)', () => {
    expect(contentHash('ABC')).not.toBe(contentHash('abc'));
    expect(normalizeForHash(' a  b ')).toBe('a b');
  });
});

describe('similarity (문자 bigram Jaccard)', () => {
  const base = "해외 대리점과 분기 판매계획을 맞출 때, 숫자보다 먼저 '누가 재고 리스크를 지는가'를 합의해야 회의가 짧아진다.";
  const nearDup = '해외 대리점과 분기 판매 계획을 맞출 때는 숫자보다 먼저 누가 재고 리스크를 지는지 합의해야 회의가 짧아진다';
  const unrelated = '겨울이 긴 지역에서는 연말 일정이 한국보다 일찍 닫혀서 현지 팀과 체감 마감일이 어긋난다.';

  it('한국어 근사 중복은 기준 이상', () => {
    expect(similarity(base, nearDup)).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
  });
  it('무관한 한국어 문장은 기준 미만', () => {
    expect(similarity(base, unrelated)).toBeLessThan(DEFAULT_SIMILARITY_THRESHOLD);
  });
  it('동일 문장 1, 빈 문자열 0, 대칭', () => {
    expect(similarity(base, base)).toBe(1);
    expect(similarity('', base)).toBe(0);
    expect(similarity('!!!', '...')).toBe(0);
    expect(similarity(base, nearDup)).toBe(similarity(nearDup, base));
  });
  it('공백·문장부호·대소문자·NFD 무시', () => {
    expect(normalizeForSimilarity('A, b! 한국어'.normalize('NFD'))).toBe('ab한국어');
    expect(similarity('AI 요약 도구', 'ai요약도구!')).toBe(1);
  });
  it('findSimilar: 기준 이상만, 점수 내림차순', () => {
    const r = findSimilar(
      [
        { id: 'c', text: unrelated },
        { id: 'a', text: nearDup },
        { id: 'b', text: base },
      ],
      base,
    );
    expect(r.map((x) => x.id)).toEqual(['b', 'a']);
    expect(r[0]!.score).toBe(1);
    expect(r[1]!.score).toBeGreaterThanOrEqual(0.45);
    expect(r[1]!.score).toBeLessThan(1);
  });
});

describe('captureCreateSchema', () => {
  it('텍스트 수집', () => {
    expect(captureCreateSchema.safeParse({ input_type: 'text', raw_text: '메모', command_key: KEY }).success).toBe(true);
  });
  it('공백만 있는 텍스트는 거부', () => {
    expect(captureCreateSchema.safeParse({ input_type: 'text', raw_text: '  ', command_key: KEY }).success).toBe(false);
  });
  it('텍스트 수집에 url 을 섞으면 거부', () => {
    expect(
      captureCreateSchema.safeParse({ input_type: 'text', raw_text: 'a', url: 'https://example.com', command_key: KEY })
        .success,
    ).toBe(false);
  });
  it('URL 수집: url 필수, raw_text 선택', () => {
    expect(captureCreateSchema.safeParse({ input_type: 'url', url: 'https://example.com/', command_key: KEY }).success).toBe(
      true,
    );
    expect(captureCreateSchema.safeParse({ input_type: 'url', raw_text: '메모', command_key: KEY }).success).toBe(false);
  });
  it('command_key: 필수, 8~64자, [A-Za-z0-9_-]', () => {
    expect(captureCreateSchema.safeParse({ input_type: 'text', raw_text: 'a' }).success).toBe(false);
    for (const bad of ['short', 'x'.repeat(65), 'has space!!', '한글키한글키한글키']) {
      expect(captureCreateSchema.safeParse({ input_type: 'text', raw_text: 'a', command_key: bad }).success).toBe(false);
    }
    expect(
      captureCreateSchema.safeParse({ input_type: 'text', raw_text: 'a', command_key: crypto.randomUUID() }).success,
    ).toBe(true);
  });
  it('길이 상한: raw_text 20000, user_note 2000, title 200', () => {
    const ok = { input_type: 'text', command_key: KEY };
    expect(captureCreateSchema.safeParse({ ...ok, raw_text: 'a'.repeat(20000) }).success).toBe(true);
    expect(captureCreateSchema.safeParse({ ...ok, raw_text: 'a'.repeat(20001) }).success).toBe(false);
    expect(captureCreateSchema.safeParse({ ...ok, raw_text: 'a', user_note: 'n'.repeat(2001) }).success).toBe(false);
    expect(captureCreateSchema.safeParse({ ...ok, raw_text: 'a', title: 't'.repeat(201) }).success).toBe(false);
  });
  it('file/voice 는 T03 수집 API 대상이 아님, 모르는 필드 거부', () => {
    expect(captureCreateSchema.safeParse({ input_type: 'file', raw_text: 'a', command_key: KEY }).success).toBe(false);
    expect(captureCreateSchema.safeParse({ input_type: 'text', raw_text: 'a', command_key: KEY, owner_id: 'x' }).success).toBe(
      false,
    );
  });
});

describe('capturePatchSchema / parseCapturePatch', () => {
  it('raw_text 가 있으면 RawTextImmutableError', () => {
    expect(() => parseCapturePatch({ expected_revision: 1, raw_text: '새 원문' })).toThrow(RawTextImmutableError);
  });
  it('메모·제목·위험만 수정, null 허용', () => {
    expect(parseCapturePatch({ expected_revision: 1, user_note: null, title: '제목', risk: 'needs_check' }).success).toBe(true);
  });
  it('expected_revision 필수·양의 정수, 바꿀 항목 필수', () => {
    expect(parseCapturePatch({ user_note: 'a' }).success).toBe(false);
    expect(parseCapturePatch({ expected_revision: 0, user_note: 'a' }).success).toBe(false);
    expect(parseCapturePatch({ expected_revision: 1.5, user_note: 'a' }).success).toBe(false);
    expect(parseCapturePatch({ expected_revision: 1 }).success).toBe(false);
    expect(parseCapturePatch({ expected_revision: 1, risk: 'high' }).success).toBe(false);
  });
});

describe('parseIfMatchRevision', () => {
  it('"3", 3, W/"3" 허용, 없으면 null, 잘못되면 undefined', () => {
    expect(parseIfMatchRevision('"3"')).toBe(3);
    expect(parseIfMatchRevision('3')).toBe(3);
    expect(parseIfMatchRevision('W/"12"')).toBe(12);
    expect(parseIfMatchRevision(null)).toBeNull();
    expect(parseIfMatchRevision('*')).toBeUndefined();
    expect(parseIfMatchRevision('"0"')).toBeUndefined();
    expect(parseIfMatchRevision('"abc"')).toBeUndefined();
  });
});

describe('capture cursor', () => {
  it('왕복, 변조·임의 문자열은 null', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const c = encodeCaptureCursor('2026-09-24T10:00:00.123456Z', id);
    expect(decodeCaptureCursor(c)).toEqual({ receivedAt: '2026-09-24T10:00:00.123456Z', id });
    expect(decodeCaptureCursor('!!')).toBeNull();
    expect(decodeCaptureCursor(Buffer.from("x|' or 1=1").toString('base64url'))).toBeNull();
  });
});
