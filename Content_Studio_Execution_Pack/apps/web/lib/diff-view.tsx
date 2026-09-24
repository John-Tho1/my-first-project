/** 줄 단위 diff 표시(서버 컴포넌트). 색만으로 구분하지 않도록 +/− 기호와 취소선을 함께 쓴다. */
import { diffStats, type DiffLine } from '@cs/domain';

export function DiffView({ lines, label }: { lines: readonly DiffLine[]; label: string }) {
  const s = diffStats(lines);
  return (
    <>
      <p className="meta">
        <span className="tag">추가 {s.added}줄</span>
        <span className="tag warn">삭제 {s.removed}줄</span>
        <span>같음 {s.same}줄</span>
      </p>
      <div className="diff" role="region" aria-label={label}>
        {lines.length === 0 ? <span className="diff-line">(두 본문 모두 비어 있음)</span> : null}
        {lines.map((l, i) => (
          <span key={i} className={l.type === 'same' ? 'diff-line' : `diff-line ${l.type}`}>
            {l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}
            {l.text}
          </span>
        ))}
      </div>
    </>
  );
}
