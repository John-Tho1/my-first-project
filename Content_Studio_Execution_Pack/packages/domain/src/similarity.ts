/**
 * 주제 유사도(T03, 결정 D4): 문자 bigram 집합의 Jaccard 계수.
 * 한국어는 띄어쓰기·조사 차이가 커서 단어 단위보다 음절 bigram 이 근사 중복을 더 잘 잡는다.
 * 외부 라이브러리·임베딩·AI 호출 없이 서버에서 결정적으로 계산한다.
 * 결과는 "병합 후보" 표시용일 뿐이며 자동 삭제·병합에 쓰지 않는다(docs/01 §2).
 */

export const DEFAULT_SIMILARITY_THRESHOLD = 0.45;

/**
 * NFC → 소문자 → URL 제거 → 공백·문장부호·기호 제거.
 * URL 은 주제가 아니므로 뺀다(같은 도메인이라는 이유만으로 유사 후보가 되지 않게). URL 중복은 정규화 URL 로 따로 판정한다.
 */
export function normalizeForSimilarity(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/gu, ' ')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function bigrams(text: string): Set<string> {
  const chars = Array.from(normalizeForSimilarity(text));
  const out = new Set<string>();
  if (chars.length === 1) out.add(chars[0]!);
  for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i]! + chars[i + 1]!);
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 0..1. 어느 한쪽이 (정규화 후) 비어 있으면 0. */
export function similarity(a: string, b: string): number {
  return jaccard(bigrams(a), bigrams(b));
}

export interface SimilarityCandidate {
  id: string;
  text: string;
}

export interface SimilarMatch {
  id: string;
  /** 소수 셋째 자리까지(표시용) */
  score: number;
}

/** threshold 이상인 후보를 점수 내림차순(동점은 id 순)으로 돌려준다. */
export function findSimilar(
  candidates: readonly SimilarityCandidate[],
  text: string,
  threshold = DEFAULT_SIMILARITY_THRESHOLD,
): SimilarMatch[] {
  const target = bigrams(text);
  const out: SimilarMatch[] = [];
  for (const c of candidates) {
    const s = jaccard(target, bigrams(c.text));
    if (s >= threshold) out.push({ id: c.id, score: Math.round(s * 1000) / 1000 });
  }
  return out.sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}
