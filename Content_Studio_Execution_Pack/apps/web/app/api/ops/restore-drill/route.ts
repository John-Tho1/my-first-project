import { runRestoreDrill } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../lib/api';
import { drillView, opsFormFailure } from '../../../../lib/ops';
import { getConfig, getStorage } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/ops/restore-drill — 복원 훈련(T20, A18). 로그인한 owner 를 임시로 내보내 **버리는 메모리 DB + 빈 임시 저장소**에
 * empty_only 로 복원하고 표·파일·검색을 비교한다(운영 DB 는 읽기만, 훈련 기록 restore_drills 한 줄 추가). 본문은 읽지 않는다.
 * 200 { drill_id, result: pass|fail, tables, mismatches, … }(불일치도 200 — 결과가 fail). 폼은 303 → /ops?drill=<id>#backup.
 * 훈련 묶음은 export_runs 에 남지 않는다(백업으로 세지 않음). 외부 호출 없음. CSRF(같은 출처) 검사.
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const r = await runRestoreDrill(owner.db, getStorage(config), owner.ownerId, { trigger: 'api' });
    if (html) return seeOther(`/ops?drill=${r.drillId}#backup`);
    return json(drillView(r));
  } catch (e) {
    if (html) return opsFormFailure(e, request, 'drill_failed');
    return errorResponse(e, request);
  }
}
