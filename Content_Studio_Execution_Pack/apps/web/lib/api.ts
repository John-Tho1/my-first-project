/**
 * API 공통 처리(서버 전용).
 * - 도메인 오류(AppError.kind) → HTTP 상태 변환. 알 수 없는 오류는 500 + 일반 문구.
 * - 응답 본문에 stack trace·환경변수 값·경로를 넣지 않는다. 서버 로그에도 오류 이름만 남긴다.
 * - 401 이고 요청에 세션 쿠키가 있었다면 쿠키를 지운다(만료·폐기 세션 = 로그아웃 상태).
 */
import {
  AppError,
  buildClearedSessionCookie,
  GuardError,
  PayloadTooLargeError,
  readCookie,
  SESSION_COOKIE_NAME,
  type AppConfig,
  type AppErrorKind,
} from '@cs/domain';
import { getConfig } from './server';

const STATUS: Record<AppErrorKind, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  not_implemented: 501,
  service_unavailable: 503,
  llm_failed: 502,
};

export function statusForError(e: AppError): number {
  return STATUS[e.kind];
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function json(body: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'no-store');
  return Response.json(body, { status: init.status ?? 200, headers });
}

/** 상대 경로 Location 으로 303 See Other(폼 POST 이후 GET 으로 이동). */
export function seeOther(location: string, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set('location', location);
  h.set('cache-control', 'no-store');
  return new Response(null, { status: 303, headers: h });
}

/** 브라우저 폼 제출(HTML 을 기대)이면 true → 리다이렉트 응답. 그 외(JSON 클라이언트·curl)는 JSON. */
export function wantsHtml(request: Request): boolean {
  return (request.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

function safeConfig(): AppConfig | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}

export function errorResponse(e: unknown, request: Request): Response {
  if (e instanceof AppError) {
    const status = statusForError(e);
    const headers = new Headers(NO_STORE);
    if (status === 401 && readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME) !== null) {
      const config = safeConfig();
      if (config) headers.append('set-cookie', buildClearedSessionCookie(config));
    }
    // extra(예: 409 의 current/yours)는 error/message 를 덮어쓰지 못하게 먼저 펼친다.
    return Response.json({ ...(e.extra ?? {}), error: e.code, message: e.message }, { status, headers });
  }
  if (e instanceof GuardError) {
    // T06: 외부 효과 가드(fail-closed — 실제 AI·게시·수집). 503 + 가드 코드. 설정 값은 넣지 않는다.
    return Response.json({ error: e.code.toLowerCase(), message: e.message }, { status: 503, headers: NO_STORE });
  }
  console.error(`[api] 처리하지 못한 오류:${e instanceof Error ? e.name : typeof e}`);
  return Response.json(
    { error: 'internal', message: '서버 오류가 발생했습니다' },
    { status: 500, headers: NO_STORE },
  );
}

type Handler<C> = (request: Request, ctx: C) => Promise<Response>;

export function apiHandler<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (request, ctx) => {
    try {
      return await fn(request, ctx);
    } catch (e) {
      return errorResponse(e, request);
    }
  };
}

/**
 * 요청 본문을 최대 limit 바이트까지만 읽는다. Content-Length 가 limit 을 넘거나
 * 실제로 읽은 양이 넘으면 PayloadTooLargeError(413). 전체를 메모리에 올리기 전에 끊는다.
 */
export async function readBodyCapped(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new PayloadTooLargeError();
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
