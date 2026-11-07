import { getContentRow, interviewAnswerView, latestAnswers, listInterviewAnswers, saveInterviewAnswers } from '@cs/db';
import { assertSameOrigin, INTERVIEW_QUESTIONS, interviewAnswersSchema, NotFoundError } from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { readRequestFields, validationError } from '../../../../../lib/body';
import { getConfig } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { formToAnswers, MAX_WRITING_REQUEST, writingFormFailure } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/contents/{id}/answers — { questions, current(질문별 최신), history(최신 먼저) }. 다른 owner → 404. */
export const GET = apiHandler<Ctx>(async (request, ctx) => {
  const owner = await requireOwner(request);
  const { id } = await ctx.params;
  const content = await getContentRow(owner.db, owner.ownerId, id.toLowerCase());
  if (!content) throw new NotFoundError('원고를 찾을 수 없습니다');
  const history = await listInterviewAnswers(owner.db, owner.ownerId, content.id);
  return json({
    questions: INTERVIEW_QUESTIONS,
    current: latestAnswers(history).map(interviewAnswerView),
    history: history.map(interviewAnswerView),
  });
});

/**
 * POST /api/contents/{id}/answers — { answers: { situation?, judgment?, takeaway? } }. 비어 있지 않고 바뀐 답만 새 행(append).
 * 201 { inserted, current }. 폼: 303 → /contents/{id}?answered=<n>. 답변은 사용자 입력만 받는다(AI 가 채우는 경로 없음).
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    assertSameOrigin(request, getConfig());
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_WRITING_REQUEST);
    const parsed = interviewAnswersSchema.safeParse(body.kind === 'form' ? formToAnswers(body.data) : body.data);
    if (!parsed.success) throw validationError(parsed.error);
    const r = await saveInterviewAnswers(owner.db, owner.ownerId, id.toLowerCase(), parsed.data);
    if (html) return seeOther(`/contents/${id.toLowerCase()}?answered=${r.inserted.length}#interview`);
    return json({ inserted: r.inserted.map(interviewAnswerView), current: r.current.map(interviewAnswerView) }, { status: 201 });
  } catch (e) {
    if (html) return writingFormFailure(e, request, `/contents/${encodeURIComponent(id)}`, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
