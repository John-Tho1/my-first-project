/**
 * T19(제안 결정 D33) 아카이브 재추천 — "다시 볼 만한 소재". 순수·결정적(AI 호출 없음).
 *
 * 규칙: 받은 지 30일이 넘은 소재 중, 최근 14일의 수집 항목·원고(초안)와 **서로 다른 핵심어 2개 이상**을 공유하는 것.
 * 이유 줄: 가장 많이 겹치는 최근 자료 하나(동점이면 최신 → ID 순)와 겹치는 단어(최대 4개).
 * 정렬: 겹친 단어 수 내림차순 → 오래된 소재 먼저 → ID. 사용자가 닫은 소재는 다시 나오지 않는다.
 */

export const RECOMMEND_MIN_AGE_DAYS = 30;
export const RECOMMEND_RECENT_DAYS = 14;
export const RECOMMEND_MIN_SHARED = 2;
export const RECOMMEND_LIMIT = 5;
/** 한 글에서 뽑는 핵심어 상한(긴 글 비용 제한) */
export const RECOMMEND_MAX_KEYWORDS = 200;
/** 키워드 추출에 쓰는 앞부분 글자 수 */
export const RECOMMEND_SCAN_CHARS = 4000;

const STOPWORDS = new Set([
  // 영어
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'you', 'your', 'our', 'not', 'but', 'can', 'will',
  'about', 'into', 'what', 'when', 'how', 'why', 'who', 'its', 'their', 'there', 'they', 'them', 'than', 'then', 'also', 'more', 'just', 'http', 'https', 'www', 'com',
  // 한국어(조사 뗀 뒤 남는 흔한 말)
  '그리고', '하지만', '그래서', '그러나', '이번', '오늘', '정말', '우리', '저는', '제가', '이것', '그것', '있다', '없다', '한다', '했다', '하는', '있는', '없는',
  '것이', '것을', '수가', '때문', '경우', '대한', '위한', '통해', '관련', '정도', '이후', '이전', '모든', '같은', '다른', '어떤', '이런', '그런', '다시', '먼저', '즉시',
]);

/** 한글 낱말 끝의 흔한 조사·어미(긴 것부터). 떼고 남은 길이가 2자 이상일 때만 뗀다. */
const SUFFIXES = ['에서는', '으로는', '에게서', '이라는', '라는', '에서', '으로', '에게', '한테', '까지', '부터', '처럼', '보다', '이다', '입니다', '합니다', '했다', '하는', '하고', '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만'];

const HANGUL = /[가-힣]/;

function stem(token: string): string {
  if (!HANGUL.test(token)) return token;
  for (const s of SUFFIXES) {
    if (token.length - s.length >= 2 && token.endsWith(s)) return token.slice(0, -s.length);
  }
  return token;
}

/** 핵심어 집합: 글자·숫자 묶음, 소문자, 2자 이상(영문 3자 이상), 조사 제거, 불용어 제외. 결정적. */
export function extractKeywords(text: string): Set<string> {
  const out = new Set<string>();
  const src = text.slice(0, RECOMMEND_SCAN_CHARS).toLowerCase();
  for (const m of src.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = m[0];
    if (/^\p{N}+$/u.test(raw)) continue;
    const t = stem(raw);
    const isAscii = /^[a-z0-9]+$/.test(t);
    if (t.length < 2 || (isAscii && t.length < 3)) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
    if (out.size >= RECOMMEND_MAX_KEYWORDS) break;
  }
  return out;
}

export interface RecommendCandidate {
  id: string;
  title: string | null;
  text: string;
  receivedAt: Date;
}

export interface RecentSignal {
  kind: 'collected' | 'draft';
  id: string;
  label: string;
  text: string;
  at: Date;
}

export interface Recommendation {
  captureId: string;
  title: string | null;
  receivedAt: Date;
  shared: string[];
  signal: { kind: RecentSignal['kind']; id: string; label: string };
  reason: string;
}

export function recommendArchive(input: {
  candidates: readonly RecommendCandidate[];
  signals: readonly RecentSignal[];
  dismissed: ReadonlySet<string>;
  now: Date;
  limit?: number;
}): Recommendation[] {
  const minAgeMs = RECOMMEND_MIN_AGE_DAYS * 86400_000;
  const recentMs = RECOMMEND_RECENT_DAYS * 86400_000;
  const sigs = input.signals
    .filter((s) => input.now.getTime() - s.at.getTime() <= recentMs && s.at.getTime() <= input.now.getTime())
    .map((s) => ({ s, kw: extractKeywords(`${s.label}\n${s.text}`) }));
  if (!sigs.length) return [];
  const out: Recommendation[] = [];
  for (const c of input.candidates) {
    if (input.dismissed.has(c.id)) continue;
    if (input.now.getTime() - c.receivedAt.getTime() < minAgeMs) continue;
    const kw = extractKeywords(`${c.title ?? ''}\n${c.text}`);
    let best: { s: RecentSignal; shared: string[] } | null = null;
    for (const { s, kw: skw } of sigs) {
      const shared = [...kw].filter((k) => skw.has(k)).sort();
      if (shared.length < RECOMMEND_MIN_SHARED) continue;
      const better =
        !best ||
        shared.length > best.shared.length ||
        (shared.length === best.shared.length && (s.at.getTime() > best.s.at.getTime() || (s.at.getTime() === best.s.at.getTime() && s.id < best.s.id)));
      if (better) best = { s, shared };
    }
    if (!best) continue;
    const words = best.shared.slice(0, 4).join(', ');
    const what = best.s.kind === 'collected' ? '최근 수집한 글' : '최근 작성 중인 원고';
    out.push({
      captureId: c.id,
      title: c.title,
      receivedAt: c.receivedAt,
      shared: best.shared,
      signal: { kind: best.s.kind, id: best.s.id, label: best.s.label },
      reason: `${what} "${Array.from(best.s.label).slice(0, 40).join('')}" 와 겹치는 단어: ${words}`,
    });
  }
  out.sort(
    (a, b) =>
      b.shared.length - a.shared.length || a.receivedAt.getTime() - b.receivedAt.getTime() || (a.captureId < b.captureId ? -1 : a.captureId > b.captureId ? 1 : 0),
  );
  return out.slice(0, input.limit ?? RECOMMEND_LIMIT);
}
