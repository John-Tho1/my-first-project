import { createUploadSession, uploadSessionView } from '@cs/db';
import { assertSameOrigin, planUpload, uploadSessionCreateSchema } from '@cs/domain';
import { apiHandler, json } from '../../../../lib/api';
import { readRequestFields, validationError } from '../../../../lib/body';
import { getConfig } from '../../../../lib/server';
import { requireOwner } from '../../../../lib/session';
import { MAX_SMALL_JSON } from '../../../../lib/stt';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/uploads/sessions — 음성·영상 업로드 세션(T08, A14). body { kind: audio|video, mime, bytes, sha256?, chunk_size? }.
 * 형식 밖 415, 한도(음성 200MB·영상 2GB) 초과 413, chunk_size 4–8MiB 밖 400. 201 { session } (chunk_size·chunk_count·expires_at 포함).
 */
export const POST = apiHandler(async (request) => {
  const config = getConfig();
  assertSameOrigin(request, config);
  const owner = await requireOwner(request);
  const body = await readRequestFields(request, MAX_SMALL_JSON);
  const parsed = uploadSessionCreateSchema.safeParse(body.data);
  if (!parsed.success) throw validationError(parsed.error);
  const plan = planUpload(parsed.data);
  const s = await createUploadSession(owner.db, owner.ownerId, plan);
  return json({ session: uploadSessionView(s, []) }, { status: 201 });
});
