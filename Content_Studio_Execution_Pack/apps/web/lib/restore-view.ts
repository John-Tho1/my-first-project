/**
 * FIX2-T13(Codex review-FIX-T13 Q11): 복원 미리보기·결과 화면의 "다시 연결 필요" 안내 문구. 플랫폼·표시 이름만 쓴다(계정 ID·비밀 없음).
 * 옛 미리보기 기록(reconnect_required_labels 없음)은 개수만 보여 준다.
 */
import { CHANNEL_LABEL, type Channel } from '@cs/domain';

export interface ReconnectSource {
  reconnect_required_accounts?: string[] | null;
  reconnect_required_labels?: Array<{ platform: string; display_name: string; existing: boolean }> | null;
}

export interface ReconnectNotice {
  title: string;
  lines: string[];
}

export function reconnectNotice(src: ReconnectSource | null | undefined, committed: boolean): ReconnectNotice | null {
  const ids = src?.reconnect_required_accounts ?? [];
  const labels = src?.reconnect_required_labels ?? null;
  if (!ids.length && !labels?.length) return null;
  const verb = committed ? '되었습니다' : '됩니다';
  const title = `배포 계정 ${labels?.length ?? ids.length}개가 복원 후 "다시 연결 필요"가 ${verb}. 다시 연결하기 전까지 이 계정으로는 배포를 실행하지 않습니다.`;
  if (!labels) return { title, lines: [] };
  const lines = labels.map((l) => {
    const platform = CHANNEL_LABEL[l.platform as Channel] ?? l.platform;
    return `${l.display_name} · ${platform} — ${l.existing ? '이미 있던 계정(이번 복원으로 실행 차단)' : '새로 들어오는 계정(연결 정보는 내보내기에 없음)'}`;
  });
  return { title, lines };
}

/**
 * FIX1-FULLREV3(H3): 복원 미리보기·결과의 invalidated_approvals 한 줄(옛 기록에는 partial_job_ids·in_flight 칸이 없다 → []·false).
 * FIX1-FULLREV3(H3 후속): leased_partial_job_ids 도 같다(없으면 []).
 */
export interface InvalidatedApprovalEntry {
  reasons: string[];
  partial_job_ids?: string[] | null;
  leased_partial_job_ids?: string[] | null;
  in_flight?: boolean | null;
}

export interface InvalidationNotice {
  testid: string;
  text: string;
}

/**
 * FIX2-FULLREV2(G19·G9 fixup) + FIX1-FULLREV3(H3): 복원으로 무효가 된(될) 이 환경의 기존 승인 안내.
 * 무효가 된 승인을 셋으로 나눈다(일반 승인 철회 경로의 revocationNotice 와 같은 구분):
 * - 실행 전으로: 대기 작업은 보류(BLOCKED), 항목은 PLANNED — 다시 계획·승인.
 * - 부분 게시(partial_job_ids 있음): 이미 일부가 게시됐거나 게시 시도 표식이 있어 남은 게시물을 보내지 않고 UNKNOWN — 실행 전으로 돌아가지 않는다.
 * - 보내기 직전 부분 게시(leased_partial_job_ids 있음, FIX1-FULLREV3(H3 후속)): lease 된(보내기 전) 작업에 이미 게시된 단계·게시 시도 표식이 있어
 *   항목을 실행 전으로 두지 않는다 — 그 작업의 다음 전송은 다시 보내지 않고 결과 불명(UNKNOWN)으로 정해진다.
 * - 진행 중(in_flight, FIX1-FULLREV3(H2)): 작업·항목 상태 그대로, 다음 전송이 보내지 않고 멈춘다.
 * 모두 "실행 전으로"일 때(옛 기록 포함)는 지금까지와 같은 문구 그대로다.
 */
export function restoreInvalidationNotices(entries: readonly InvalidatedApprovalEntry[] | null | undefined, committed: boolean): InvalidationNotice[] {
  const list = entries ?? [];
  const kindOf = (e: InvalidatedApprovalEntry) =>
    (e.partial_job_ids ?? []).length > 0 ? 'partial' : (e.leased_partial_job_ids ?? []).length > 0 ? 'leased_partial' : e.in_flight ? 'in_flight' : 'planned';
  const split = (reason: string) => {
    const of = list.filter((e) => e.reasons.includes(reason));
    return { total: of.length, planned: of.filter((e) => kindOf(e) === 'planned').length };
  };
  const out: InvalidationNotice[] = [];
  const brand = split('brand_changed');
  if (brand.total) {
    const head = committed
      ? `복원으로 브랜드 프로필 새 버전이 들어와, 이 환경에 있던 승인 ${brand.total}건을 무효로 했습니다`
      : `복원하면 브랜드 프로필 새 버전이 들어와, 이 환경에 있는 승인 ${brand.total}건이 무효가 됩니다`;
    const tail =
      brand.planned === brand.total
        ? committed
          ? '(대기 중이던 실행은 보류, 항목은 실행 전으로). 배포 계획에서 새 브랜드로 다시 계획·승인하세요.'
          : '(대기 중인 실행은 보류, 항목은 실행 전으로).'
        : brand.planned
          ? committed
            ? `. 그중 ${brand.planned}건은 대기 중이던 실행을 보류하고 항목을 실행 전으로 돌렸습니다 — 배포 계획에서 새 브랜드로 다시 계획·승인하세요.`
            : `. 그중 ${brand.planned}건은 대기 중인 실행을 보류하고 항목을 실행 전으로 돌립니다.`
          : '.';
    out.push({ testid: 'restore-brand-invalidated', text: head + tail });
  }
  const risk = split('risk_needs_check');
  if (risk.total) {
    const head = committed
      ? `복원으로 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 ${risk.total}건을 무효로 했습니다`
      : `복원하면 이 환경의 원고에 위험 표시 '확인 필요' 소재가 연결되어, 그 원고의 승인 ${risk.total}건이 무효가 됩니다`;
    const tail =
      risk.planned === risk.total
        ? committed
          ? "(대기 중이던 실행은 보류, 항목은 실행 전으로). 소재의 '확인 필요'를 해제한 뒤 다시 승인하세요."
          : '(대기 중인 실행은 보류, 항목은 실행 전으로).'
        : risk.planned
          ? committed
            ? `. 그중 ${risk.planned}건은 대기 중이던 실행을 보류하고 항목을 실행 전으로 돌렸습니다 — 소재의 '확인 필요'를 해제한 뒤 다시 승인하세요.`
            : `. 그중 ${risk.planned}건은 대기 중인 실행을 보류하고 항목을 실행 전으로 돌립니다.`
          : '.';
    out.push({ testid: 'restore-risk-invalidated', text: head + tail });
  }
  const partial = list.filter((e) => kindOf(e) === 'partial').length;
  if (partial) {
    out.push({
      testid: 'restore-partial-unknown',
      text: committed
        ? `무효가 된 승인 중 ${partial}건은 이미 일부가 게시됐거나 게시 시도가 있었던 작업이라, 남은 게시물을 보내지 않고 결과 불명(UNKNOWN)으로 두었습니다 — 실행 전으로 되돌리지 않으므로 다시 승인·실행으로 처음부터 다시 보내지 않습니다(게시된 부분은 원격에 남음). Threads 등 게시 채널에서 직접 확인한 뒤 배포 계획에서 결과를 기록하세요.`
        : `무효가 될 승인 중 ${partial}건은 이미 일부가 게시됐거나 게시 시도가 있었던 작업이라, 남은 게시물을 보내지 않고 결과 불명(UNKNOWN)으로 둡니다 — 실행 전으로 되돌리지 않으므로 다시 승인·실행으로 처음부터 다시 보내지 않습니다(게시된 부분은 원격에 남음). 복원 뒤 Threads 등 게시 채널에서 직접 확인하세요.`,
    });
  }
  // FIX1-FULLREV3(H3 후속): lease 된(보내기 전) 부분 게시 작업 — 지금 UNKNOWN 은 아니지만 다음 전송이 보내지 않고 UNKNOWN 으로 정한다(다시 보내지 않음).
  const leasedPartial = list.filter((e) => kindOf(e) === 'leased_partial').length;
  if (leasedPartial) {
    out.push({
      testid: 'restore-leased-partial',
      text: committed
        ? `무효가 된 승인 중 ${leasedPartial}건은 보내기 직전이던 작업에 이미 일부가 게시됐거나 게시 시도가 있어, 항목을 실행 전으로 되돌리지 않았습니다 — 그 작업의 다음 전송은 남은 게시물을 다시 보내지 않고 결과 불명(UNKNOWN)으로 정해집니다(게시된 부분은 원격에 남음). Threads 등 게시 채널에서 직접 확인한 뒤 배포 계획에서 결과를 기록하세요.`
        : `무효가 될 승인 중 ${leasedPartial}건은 보내기 직전인 작업에 이미 일부가 게시됐거나 게시 시도가 있어, 항목을 실행 전으로 되돌리지 않습니다 — 그 작업의 다음 전송은 남은 게시물을 다시 보내지 않고 결과 불명(UNKNOWN)으로 정해집니다(게시된 부분은 원격에 남음). 복원 뒤 Threads 등 게시 채널에서 직접 확인하세요.`,
    });
  }
  const inFlight = list.filter((e) => kindOf(e) === 'in_flight').length;
  if (inFlight) {
    out.push({
      testid: 'restore-inflight-invalidated',
      text: committed
        ? `무효가 된 승인 중 ${inFlight}건은 전송 중이던 항목이라 지금 시도는 결과를 그대로 기록합니다 — 다음 전송(재개·재시도)은 보내지 않고 멈추며(게시된 것이 없으면 실행 전으로, 일부 게시됐으면 결과 불명(UNKNOWN)), 다시 보내려면 다시 승인해야 합니다.`
        : `무효가 될 승인 중 ${inFlight}건은 전송 중인 항목이라 지금 시도는 결과를 그대로 기록하고, 다음 전송(재개·재시도)은 보내지 않고 멈춥니다(다시 승인 필요).`,
    });
  }
  return out;
}
