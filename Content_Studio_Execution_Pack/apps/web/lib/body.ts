/**
 * 요청 본문 읽기(서버 전용): JSON 또는 브라우저 폼(urlencoded/multipart)을 상한 안에서 읽어 필드 객체로 만든다.
 * 폼의 파일 필드는 무시한다(수집 폼은 텍스트만 받는다).
 */
import { AppError, BadRequestError } from '@cs/domain';
import { readBodyCapped } from './api';

export type RequestFields =
  | { kind: 'json'; data: unknown }
  | { kind: 'form'; data: Record<string, string> };

export async function readRequestFields(request: Request, limit: number): Promise<RequestFields> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  const bytes = await readBodyCapped(request, limit);
  try {
    if (type.startsWith('application/json')) {
      return { kind: 'json', data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
    }
    if (type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')) {
      const form = await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type')! } }).formData();
      const data: Record<string, string> = {};
      for (const [k, v] of form.entries()) if (typeof v === 'string') data[k] = v;
      return { kind: 'form', data };
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new BadRequestError();
  }
  throw new BadRequestError('application/json 또는 폼 형식으로 보내야 합니다');
}

/** zod 오류 → 400. 직접 쓴 한국어 메시지(custom issue)가 있으면 그것을, 아니면 일반 문구를 쓴다. 입력값은 넣지 않는다. */
interface IssueLike {
  code: string;
  message: string;
  path: ReadonlyArray<PropertyKey>;
}

export function validationError(error: { issues: ReadonlyArray<IssueLike> }): BadRequestError {
  const custom = error.issues.find((i) => i.code === 'custom' && /[가-힣]/.test(i.message));
  const field = error.issues[0]?.path.map(String).join('.') ?? '';
  return new BadRequestError(custom?.message ?? (field ? `입력값을 확인하세요: ${field}` : '입력값을 확인하세요'));
}

/** 폼의 빈 문자열은 "입력 안 함"으로 본다. */
export const blankToUndefined = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v);
