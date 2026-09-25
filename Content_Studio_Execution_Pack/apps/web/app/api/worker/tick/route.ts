import { newWorkerId, recordAudit, runJobsTick } from '@cs/db';
import { assertSameOrigin, isUuid, tickSchema } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { readRequestFields, validationError } from '../../../../lib/body';
import { distributeFormFailure, MAX_DISTRIBUTION_REQUEST } from '../../../../lib/distribution';
import { getChannelAdapters, getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/worker/tick — { max_jobs?(1~20, 기본 5), worker_id? } → 200 { worker_id, recovered, leased, results }.
 * 로그인한 owner 의 배포 작업만 한 번 처리한다(lease 만료 복구 → lease → 모의 어댑터 전송·조회). 화면의 "작업 처리 실행(모의 1회)".
 * 외부 호출 없음(모의 어댑터만). CSRF(같은 출처) 검사.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  let back = '/distribute';
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_DISTRIBUTION_REQUEST);
    if (body.kind === 'form' && body.data.plan_id && isUuid(body.data.plan_id)) back = `/distribute/${body.data.plan_id.toLowerCase()}`;
    const input = body.kind === 'form' ? { max_jobs: body.data.max_jobs || undefined } : body.data;
    const parsed = tickSchema.safeParse(input);
    if (!parsed.success) throw validationError(parsed.error);
    const workerId = parsed.data.worker_id ? `api-${parsed.data.worker_id}`.slice(0, 40) : newWorkerId('api');
    const r = await runJobsTick(owner.db, getChannelAdapters(), {
      workerId,
      config,
      ownerId: owner.ownerId,
      maxJobs: parsed.data.max_jobs ?? 5,
      submitTimeoutMs: config.JOB_SUBMIT_TIMEOUT_MS,
    });
    await recordAudit(owner.db, {
      ownerId: owner.ownerId,
      action: 'worker.tick',
      entity: 'worker',
      details: { leased: r.leased, recovered: r.recovered, mode: 'MOCK' },
    });
    if (html) return seeOther(`${back}?ticked=${r.leased}`);
    return json({ ...r, mode: 'MOCK' });
  } catch (e) {
    if (html) return distributeFormFailure(e, request, back);
    return errorResponse(e, request);
  }
}
