/**
 * T20(결정 D22) 운영 화면 공용(서버 전용): 폼 오류 문구·리다이렉트, 훈련·보존 결과의 응답 모양.
 * 화면 문구 규칙: 실제 기록에서 나온 숫자·사실만. "정상"·"안전"·"백업 완료" 같은 판정 배지를 만들지 않는다.
 */
import type { RestoreDrillResult, RetentionPlan, RetentionResult } from '@cs/db';
import { AppError } from '@cs/domain';
import { errorResponse, seeOther } from './api';

export const MAX_OPS_REQUEST = 4 * 1024;

export const OPS_ERROR_TEXT: Record<string, string> = {
  confirm_required: '미리보기를 확인한 뒤 "위 목록을 지워도 됩니다"를 체크해야 보존 정리를 적용합니다. 아무것도 지우지 않았습니다.',
  csrf: '요청 출처를 확인할 수 없어 거부했습니다. 이 화면에서 다시 시도하세요.',
  drill_failed: '복원 훈련을 끝까지 실행하지 못했습니다(기록이 남지 않았을 수 있음). 서버 로그 없이 다시 시도하세요.',
  server: '서버 오류로 처리하지 못했습니다.',
};

export function opsFormFailure(e: unknown, request: Request, code?: string): Response {
  const res = errorResponse(e, request);
  if (res.status === 401) {
    const headers = new Headers();
    const cookie = res.headers.get('set-cookie');
    if (cookie) headers.set('set-cookie', cookie);
    return seeOther('/login', headers);
  }
  let c = code ?? 'server';
  if (e instanceof AppError) {
    if (e.code === 'confirm_required') c = 'confirm_required';
    else if (e.kind === 'csrf') c = 'csrf';
  }
  return seeOther(`/ops?error=${c}`);
}

export function drillView(r: RestoreDrillResult) {
  return {
    drill_id: r.drillId,
    result: r.result,
    started_at: r.startedAt.toISOString(),
    finished_at: r.finishedAt.toISOString(),
    bundle_export_id: r.bundleExportId,
    bundle_sha256: r.bundleSha256,
    tables_compared: r.tablesCompared,
    rows_compared: r.rowsCompared,
    assets_compared: r.assetsCompared,
    search_probe: r.searchProbe,
    empty_tables: r.emptyTables,
    error_code: r.errorCode,
    scope: r.scope,
    tables: r.tables,
    mismatches: r.mismatches,
  };
}

export function retentionPlanView(p: RetentionPlan) {
  return {
    dry_run: true,
    policy: { job_events_days: p.policy.jobEventsDays, packages_days: p.policy.packagesDays, exports_keep: p.policy.exportsKeep },
    cutoffs: { job_events: p.cutoffs.jobEvents.toISOString(), packages: p.cutoffs.packages.toISOString() },
    job_events: { jobs: p.jobEvents.jobs, events: p.jobEvents.events },
    packages: p.packages.map((x) => ({ id: x.id, bytes: x.bytes, modified_at: x.mtime.toISOString() })),
    exports: p.exports.map((x) => ({ export_id: x.id, created_at: x.createdAt.toISOString(), zip_bytes: x.zipBytes })),
    exports_existing: p.exportsExisting,
    exports_missing_file: p.exportsMissingFile.map((x) => ({ export_id: x.id, created_at: x.createdAt.toISOString(), zip_state: x.zipState, dir_present: x.dirPresent })),
  };
}

export function retentionResultView(r: RetentionResult) {
  return {
    dry_run: false,
    sweep_id: r.sweepId,
    already_absent: r.alreadyAbsent,
    exports_aborted: r.exportsAborted,
    outcome: r.outcome,
    job_events: { jobs: r.jobEvents.jobs, deleted: r.jobEvents.deleted, archived: r.jobEvents.archive !== null },
    packages: r.packages,
    exports: r.exports,
  };
}
