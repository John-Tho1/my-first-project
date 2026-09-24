import { createSession, ensureOwner, recordAudit } from '@cs/db';
import {
  AppError,
  assertLoginAvailable,
  assertSameOrigin,
  BadRequestError,
  buildSessionCookie,
  CsrfError,
  DevLoginNotAllowedError,
  generateSessionToken,
  hashSessionToken,
  hashUserAgent,
  identityMatches,
  LoginDeniedError,
  loginInputSchema,
  OidcNotConfiguredError,
  sessionTtlMs,
} from '@cs/domain';
import { errorResponse, json, readBodyCapped, seeOther, wantsHtml } from '../../../../lib/api';
import { getAppDb, getConfig } from '../../../../lib/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_LOGIN_BODY = 8 * 1024;

async function parseIdentity(request: Request): Promise<string> {
  const bytes = await readBodyCapped(request, MAX_LOGIN_BODY);
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  let raw: unknown;
  try {
    if (type.startsWith('application/json')) {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } else if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
      const form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
      raw = { identity: form.get('identity') };
    } else {
      throw new BadRequestError();
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new BadRequestError();
  }
  const parsed = loginInputSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestError();
  return parsed.data.identity.trim();
}

/** 폼 제출 실패 시 /login?error=<코드>. 페이지는 코드별 고정 문구만 보여 준다(입력값을 되돌려 보여 주지 않음). */
function loginErrorCode(e: unknown): string {
  if (e instanceof LoginDeniedError) return 'denied';
  if (e instanceof OidcNotConfiguredError) return 'unavailable';
  if (e instanceof DevLoginNotAllowedError) return 'not_allowed';
  if (e instanceof CsrfError) return 'csrf';
  if (e instanceof AppError) return 'invalid';
  return 'server';
}

/**
 * POST /api/auth/login — AUTH_MODE=dev(D3): 허용 식별자 1개와 일치하면 세션을 만든다. 비밀번호 없음, localhost 전용.
 * 응답: JSON 클라이언트는 200 {ok, expires_at} / 401 / 403 / 503, 브라우저 폼은 303(/ 또는 /login?error=…).
 * GET 등 다른 메서드는 정의하지 않는다(Next 가 405).
 */
export async function POST(request: Request): Promise<Response> {
  const html = wantsHtml(request);
  try {
    const config = getConfig();
    assertSameOrigin(request, config);
    const { db } = await getAppDb(config);

    try {
      assertLoginAvailable(config);
    } catch (e) {
      if (e instanceof AppError) await recordAudit(db, denied(e.code));
      throw e;
    }

    let identity: string;
    try {
      identity = await parseIdentity(request);
    } catch (e) {
      await recordAudit(db, denied('invalid_request'));
      throw e;
    }
    if (!identityMatches(identity, config.AUTH_ALLOWED_IDENTITY)) {
      // 어떤 식별자가 허용되는지·입력값이 무엇이었는지는 기록·응답하지 않는다.
      await recordAudit(db, denied('identity_mismatch'));
      throw new LoginDeniedError();
    }

    const owner = await ensureOwner(db, config.AUTH_ALLOWED_IDENTITY);
    const now = new Date();
    const token = generateSessionToken();
    const session = await createSession(db, {
      ownerId: owner.id,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(now.getTime() + sessionTtlMs(config)),
      userAgentHash: hashUserAgent(request.headers.get('user-agent')),
      now,
    });
    await recordAudit(db, {
      ownerId: owner.id,
      action: 'auth.login',
      entity: 'session',
      entityId: session.id,
      details: { mode: config.AUTH_MODE },
      at: now,
    });

    const headers = { 'set-cookie': buildSessionCookie(token, config) };
    if (html) return seeOther('/', headers);
    return json({ ok: true, expires_at: session.expiresAt.toISOString() }, { headers });
  } catch (e) {
    if (html) return seeOther(`/login?error=${loginErrorCode(e)}`);
    return errorResponse(e, request);
  }
}

function denied(reason: string) {
  return { ownerId: null, action: 'auth.login_denied' as const, entity: 'session', details: { reason } };
}
