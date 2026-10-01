import { applyRetention, planRetention } from '@cs/db';
import { AppError, assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { exportsDir } from '../../../../lib/backup';
import { readRequestFields } from '../../../../lib/body';
import { MAX_OPS_REQUEST, opsFormFailure, retentionPlanView, retentionResultView } from '../../../../lib/ops';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/ops/retention — 보존 정리(T20). 로그인한 owner 범위만.
 * - { dry_run: true } → 200 미리보기(무엇을 지울지, 아무것도 바꾸지 않음)
 * - { confirm: "yes" } → 적용: 끝난 작업의 오래된 이력은 JSONL 로 내보낸 뒤 삭제, 오래된 배포 파일 ZIP 삭제, 최근 N 개 밖의 내보내기 ZIP 삭제.
 *   confirm 이 정확히 "yes" 가 아니면 400 confirm_required(아무것도 지우지 않음).
 * 원문 소재·출처·원고 버전 등은 대상이 아니다. 폼은 303 → /ops?retention=applied#retention. CSRF(같은 출처) 검사.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, MAX_OPS_REQUEST);
    const data = (body.data ?? {}) as Record<string, unknown>;
    const dir = exportsDir(config);
    if (data.dry_run === true || data.dry_run === 'yes') {
      const plan = await planRetention(owner.db, owner.ownerId, config, dir);
      if (html) return seeOther('/ops#retention');
      return json(retentionPlanView(plan));
    }
    if (data.confirm !== 'yes') throw new AppError('bad_request', 'confirm_required', '보존 정리는 미리보기를 확인한 뒤 confirm=yes 로만 적용합니다');
    const r = await applyRetention(owner.db, owner.ownerId, config, dir, { confirm: true, trigger: html ? 'ui' : 'api' });
    if (html) return seeOther('/ops?retention=applied#retention');
    return json(retentionResultView(r));
  } catch (e) {
    if (html) return opsFormFailure(e, request);
    return errorResponse(e, request);
  }
}
