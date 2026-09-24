/**
 * 작성실 T06 영역(서버 컴포넌트, 스크립트 없음): 인터뷰 질문 3개 · AI 작성 보조(모의) · 제안 diff·채택/무시 · 경험 claim 확인 · 프롬프트 복사용 보기.
 * 모든 쓰기는 plain HTML 폼 POST → API(303 리다이렉트). AI 는 답변·확인을 채우지 않는다 — 사용자가 누른 폼만 저장된다.
 */
import Link from 'next/link';
import type { GenerationRunRow, getWritingState } from '@cs/db';
import { claimsOf } from '@cs/db';
import {
  ASSIST_MODE_LABEL,
  ASSIST_MODES,
  assistInputVersion,
  BRAND_TONE_LABEL,
  buildAssistPrompt,
  claimNeedsConfirmation,
  diffLines,
  formatMsk,
  INTERVIEW_QUESTIONS,
  MAX_ANSWER,
  type BrandTone,
} from '@cs/domain';
import { MOCK_WARNING } from '@cs/providers';
import { DiffView } from '../../../lib/diff-view';

export interface ProposalView {
  id: string;
  version: number;
  body: string;
}

type WritingState = Awaited<ReturnType<typeof getWritingState>>;

const RUN_STATUS_LABEL: Record<string, string> = { running: '진행 중(끝나지 않음)', succeeded: '제안 생성됨', failed: '실패' };
const KIND_LABEL: Record<string, string> = { experience: '1인칭 경험', opinion: '의견', fact: '사실 주장' };

function outputList(run: GenerationRunRow, key: 'followup_questions' | 'warnings'): string[] {
  const v = run.outputJson?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function WritingPanel({
  contentId,
  title,
  current,
  state,
  selectedRun,
  proposal,
  answeredCount,
  confirmedCount,
}: {
  contentId: string;
  title: string;
  current: { id: string; version: number; body: string };
  state: WritingState;
  selectedRun: GenerationRunRow | null;
  proposal: ProposalView | null;
  answeredCount: number | null;
  confirmedCount: number | null;
}) {
  const { brand, answers } = state;
  const answerByKey = new Map(answers.map((a) => [a.questionKey, a]));
  const answerIds = answers.map((a) => a.id).sort();
  const confirmedSet = new Set(state.confirmations.map((c) => `${c.runId}#${c.claimIndex}`));
  const prompt = brand
    ? buildAssistPrompt({
        mode: 'draft',
        inputVersion: assistInputVersion({ contentVersionId: current.id, brandProfileVersion: brand.version, answerIds }),
        brand: {
          version: brand.version,
          penName: brand.penName,
          audience: brand.audience,
          pillars: brand.pillars,
          styleRules: brand.styleRules,
          tone: brand.tone,
          avoidPhrases: brand.avoidPhrases,
          ctaRules: brand.ctaRules,
          sampleTexts: brand.sampleTexts,
        },
        answers: answers.map((a) => ({ id: a.id, questionKey: a.questionKey, question: a.question, answer: a.answer })),
        title,
        body: current.body,
      })
    : null;

  const run = selectedRun;
  const claims = run ? claimsOf(run.outputJson) : [];
  const adopted = run ? state.adopted.has(run.id) : false;
  const canAdopt = run?.status === 'succeeded' && proposal !== null && run.inputVersionId === current.id && !adopted;

  return (
    <>
      <section className="card archive" id="interview" aria-labelledby="interview-title">
        <h3 id="interview-title">인터뷰 질문 (3개)</h3>
        {answeredCount !== null ? (
          <p className="saved" role="status">
            {answeredCount > 0 ? `답변 저장됨 ✓ (${answeredCount}개)` : '바뀐 답변이 없어 새로 저장하지 않았습니다.'}
          </p>
        ) : null}
        <p className="note">답변은 직접 씁니다. AI 는 답변을 채우거나 가상 경험을 보태지 않습니다. 다시 답하면 이전 답은 기록으로 남습니다.</p>
        <form className="form" method="post" action={`/api/contents/${contentId}/answers`}>
          {INTERVIEW_QUESTIONS.map((q) => (
            <div key={q.key}>
              <label htmlFor={`answer_${q.key}`}>{q.question}</label>
              <textarea
                id={`answer_${q.key}`}
                name={`answer_${q.key}`}
                rows={3}
                maxLength={MAX_ANSWER}
                defaultValue={answerByKey.get(q.key)?.answer ?? ''}
              />
            </div>
          ))}
          <button type="submit">답변 저장</button>
        </form>
      </section>

      <section className="card archive" id="assist" aria-labelledby="assist-title">
        <h3 id="assist-title">AI 작성 보조</h3>
        <p className="notice" role="note">
          {MOCK_WARNING} — 지금은 모의 AI 만 동작합니다(결정 D7). 제안은 현재 본문을 바꾸지 않고 &quot;AI 제안&quot; 버전으로만 저장됩니다.
        </p>
        {brand ? (
          <p className="meta">
            <span>
              Brand Profile 버전 {brand.version} · {brand.penName} · {BRAND_TONE_LABEL[brand.tone as BrandTone] ?? brand.tone}
            </span>
            <Link href="/brand">Brand Profile 편집</Link>
          </p>
        ) : (
          <p className="empty-text">
            Brand Profile 이 없습니다. <Link href="/brand">먼저 저장</Link>하면 AI 작성 보조를 쓸 수 있습니다.
          </p>
        )}
        {brand ? (
          <form className="form inline" method="post" action={`/api/contents/${contentId}/assist`}>
            <input type="hidden" name="base_version" value={current.version} />
            <input type="hidden" name="brand_profile_version" value={brand.version} />
            <input type="hidden" name="answer_ids" value={answerIds.join(',')} />
            <label htmlFor="assist_mode">모드</label>
            <select id="assist_mode" name="mode" defaultValue="outline">
              {ASSIST_MODES.map((m) => (
                <option key={m} value={m}>
                  {ASSIST_MODE_LABEL[m]}
                </option>
              ))}
            </select>
            <button type="submit">모의 제안 만들기 (버전 {current.version} 기준)</button>
          </form>
        ) : null}
        <p className="note">입력은 현재 본문(버전 {current.version})·Brand Profile·저장된 답변 {answers.length}개로 고정됩니다.</p>

        {run ? (
          <div className="assist-run">
            <p className="meta">
              <span className={run.status === 'failed' ? 'tag warn' : 'tag'}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
              <span>
                {ASSIST_MODE_LABEL[run.mode as keyof typeof ASSIST_MODE_LABEL] ?? run.mode} · {run.provider}
              </span>
              <time dateTime={run.createdAt.toISOString()}>{formatMsk(run.createdAt)}</time>
              {adopted ? <span className="tag">채택함</span> : null}
            </p>
            {run.status === 'failed' ? <p className="note">제안을 만들지 못했습니다. 본문은 바뀌지 않았습니다.</p> : null}
            {run.status === 'running' ? <p className="note">끝나지 않은 실행입니다. 결과를 기다리지 말고 다시 요청하세요.</p> : null}
            {run.provider === 'mock' && run.status === 'succeeded' ? (
              <p className="notice" role="note">
                {MOCK_WARNING}
              </p>
            ) : null}
            {outputList(run, 'warnings')
              .filter((x) => x !== MOCK_WARNING)
              .map((x) => (
                <p key={x} className="note">
                  경고: {x}
                </p>
              ))}
            {proposal ? (
              <>
                <h4>
                  제안(<Link href={`/contents/${contentId}/versions/${proposal.version}`}>버전 {proposal.version}</Link>, AI 제안(모의)) — 현재 본문(버전{' '}
                  {current.version}) 과 비교
                </h4>
                <DiffView lines={diffLines(current.body, proposal.body)} label="현재 본문 → AI 제안 차이" />
                {canAdopt ? (
                  <form className="form inline" method="post" action={`/api/contents/${contentId}/assist/${run.id}/adopt`}>
                    <input type="hidden" name="base_version" value={current.version} />
                    <button type="submit">제안 채택(새 버전으로 저장)</button>{' '}
                    <Link href={`/contents/${contentId}?run=none`}>무시</Link>
                  </form>
                ) : (
                  <p className="note">
                    {adopted
                      ? '이 제안은 채택되었습니다.'
                      : '이 제안은 지금 본문이 아닌 이전 버전을 기준으로 만들어져 채택할 수 없습니다. 새로 요청하세요.'}
                  </p>
                )}
              </>
            ) : null}
            {claims.length > 0 ? (
              <>
                <h4>제안 속 주장</h4>
                {confirmedCount !== null ? (
                  <p className="saved" role="status">
                    확인 저장됨 ✓
                  </p>
                ) : null}
                <ul className="list">
                  {claims.map((cl, i) => {
                    const needs = claimNeedsConfirmation(cl);
                    const done = confirmedSet.has(`${run.id}#${i}`);
                    return (
                      <li key={i} className="capture">
                        <p className="meta">
                          <span className={needs && !done ? 'tag warn' : 'tag'}>{KIND_LABEL[cl.kind] ?? cl.kind}</span>
                          {needs ? <span>{done ? '사용자 확인됨' : '미확인 — 사실인지 확인 필요'}</span> : null}
                        </p>
                        <p>{cl.text}</p>
                        {needs && !done ? (
                          <form className="form inline" method="post" action={`/api/contents/${contentId}/claims/confirm`}>
                            <input type="hidden" name="run_id" value={run.id} />
                            <input type="hidden" name="claim_indexes" value={String(i)} />
                            <button type="submit">내가 실제로 겪은 일이 맞습니다(확인)</button>
                          </form>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <p className="note">사실이 아니면 확인하지 말고 본문에서 그 문장을 고치세요. 확인은 &quot;준비됨&quot; 전환 조건입니다.</p>
              </>
            ) : null}
            {outputList(run, 'followup_questions').length > 0 ? (
              <>
                <h4>더 알려 주면 좋은 것</h4>
                <ul>
                  {outputList(run, 'followup_questions').map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
        {state.runs.length > 1 ? (
          <p className="pager">
            최근 실행:{' '}
            {state.runs.map((r) => (
              <Link key={r.id} href={`/contents/${contentId}?run=${r.id}#assist`}>
                {`${formatMsk(r.createdAt)} ${RUN_STATUS_LABEL[r.status] ?? r.status}`}{' '}
              </Link>
            ))}
          </p>
        ) : null}

        <details>
          <summary>프롬프트 복사용 보기</summary>
          {prompt ? (
            <>
              <p className="note">
                모의·실제 AI 가 받는 프롬프트 그대로입니다(개요 대신 &quot;초안&quot; 모드 기준). 다른 AI 도구에 직접 붙여 넣어 쓸 수 있습니다. 결과를 이 앱으로
                다시 가져오는 기능은 아직 없습니다.
              </p>
              <pre className="raw-text">{prompt}</pre>
            </>
          ) : (
            <p className="empty-text">Brand Profile 을 저장하면 프롬프트가 보입니다.</p>
          )}
        </details>
      </section>
    </>
  );
}
