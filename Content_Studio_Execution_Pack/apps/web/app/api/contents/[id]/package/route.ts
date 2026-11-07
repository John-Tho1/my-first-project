import { buildVariantPackage, PACKAGE_NOTICE } from '@cs/db';
import { assertSameOrigin } from '@cs/domain';
import { errorResponse, json, seeOther, wantsHtml } from '../../../../../lib/api';
import { exportsDir } from '../../../../../lib/backup';
import { getConfig, getStorage } from '../../../../../lib/server';
import { requireOwner } from '../../../../../lib/session';
import { writingFormFailure } from '../../../../../lib/writing';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/contents/{id}/package — 채널 초안(현재 버전)의 배포 파일 ZIP(수동 게시용). **승인·게시가 아니다.**
 * 201 { package_id, zip_bytes, manifest_sha256, manifest, download_url, notice }. 채널 초안이 없으면 409 no_variants. 본문은 읽지 않는다.
 */
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  const html = wantsHtml(request);
  const { id } = await ctx.params;
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const owner = await requireOwner(request);
    const r = await buildVariantPackage(owner.db, getStorage(config), owner.ownerId, id, {
      exportsDir: exportsDir(config),
      llmMode: config.LLM_MODE,
      publishMode: config.PUBLISH_MODE,
    });
    if (html) return seeOther(`/contents/${id.toLowerCase()}?package=${r.packageId}#variants`);
    return json(
      {
        package_id: r.packageId,
        zip_bytes: r.zipBytes,
        manifest_sha256: r.manifestSha256,
        manifest: r.manifest,
        warnings: r.warnings,
        download_url: `/api/packages/${r.packageId}`,
        notice: PACKAGE_NOTICE,
      },
      { status: 201 },
    );
  } catch (e) {
    if (html) return writingFormFailure(e, request, `/contents/${encodeURIComponent(id)}`, '/contents?missing=1');
    return errorResponse(e, request);
  }
}
