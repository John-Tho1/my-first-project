import { commitRestore, RESTORE_MODES, type RestoreMode } from '@cs/db';
import { AppError, assertSameOrigin, BadRequestError } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { backupFormFailure, restoresDir } from '../../../../../lib/backup';
import { readRequestFields } from '../../../../../lib/body';
import { getConfig, getStorage } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/restores/{id}/commit — JSON { mode: 'empty_only'|'add_missing', confirm: true } (폼: mode, confirm=yes).
 * confirm 이 없으면 400 confirm_required. 다른 owner·없는 ID → 404. 이미 커밋 → 409 already_committed.
 * empty_only 인데 데이터가 있으면 409 restore_target_not_empty. 성공 200 { restored, skipped_identical, conflicts, assets_written, assets_verified }.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  const back = `/settings/restores/${encodeURIComponent(id)}`;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const body = await readRequestFields(request, 4 * 1024);
    const data = (body.data ?? {}) as Record<string, unknown>;
    if (typeof data !== 'object' || Array.isArray(data)) throw new BadRequestError();
    const mode = data.mode;
    if (typeof mode !== 'string' || !RESTORE_MODES.includes(mode as RestoreMode)) {
      throw new BadRequestError('mode 는 empty_only 또는 add_missing 입니다');
    }
    const confirmed = body.kind === 'json' ? data.confirm === true : data.confirm === 'yes';
    if (!confirmed) throw new AppError('bad_request', 'confirm_required', '내용을 확인했다는 표시(confirm: true)가 필요합니다');
    const result = await commitRestore(owner.db, getStorage(config), owner.ownerId, id, {
      mode: mode as RestoreMode,
      confirm: true,
      restoresDir: restoresDir(config),
    });
    if (html) return seeOther(back);
    return json(result);
  } catch (e) {
    if (html) return backupFormFailure(e, request, back, '/settings?error=invalid');
    return errorResponse(e, request);
  }
}
