import { exportOwner, listExportRuns } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { apiHandler, errorResponse, json, seeOther, wantsHtml } from '../../../lib/api';
import { backupFormFailure, exportRunView, exportsDir } from '../../../lib/backup';
import { getConfig, getStorage } from '../../../lib/server';
import { requireOwner } from '../../../lib/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/exports — 로그인한 owner 의 데이터를 묶음(ZIP)으로 만든다(CSRF 검사). 본문은 읽지 않는다.
 * 201 { export_id, zip_bytes, manifest_sha256, totals, warnings, download_url }. 폼은 303 → /settings?exported=<id>.
 * 세션·인증 비밀은 넣지 않는다(@cs/domain EXCLUDED_TABLES).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const r = await exportOwner(owner.db, getStorage(config), owner.ownerId, { outDir: exportsDir(config) });
    if (html) return seeOther(`/settings?exported=${r.exportId}`);
    return json(
      {
        export_id: r.exportId,
        zip_bytes: r.zipBytes,
        manifest_sha256: r.manifestSha256,
        totals: r.manifest.totals,
        tables: r.manifest.tables,
        warnings: r.warnings,
        download_url: `/api/exports/${r.exportId}`,
      },
      { status: 201 },
    );
  } catch (e) {
    if (html) return backupFormFailure(e, request, '/settings', '/settings');
    return errorResponse(e, request);
  }
}

/** GET /api/exports — 최근 내보내기 20건(owner 범위). */
export const GET = apiHandler(async (request) => {
  const owner = await requireOwner(request);
  const rows = await listExportRuns(owner.db, owner.ownerId, 20);
  return json({ items: rows.map(exportRunView) });
});
