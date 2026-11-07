/**
 * /record 화면(RecordClient)의 순수 판단 함수 — 브라우저·서버 값 없이 시험한다.
 * - FIX3-FULLREV2(G23): 전사 수정 초안은 편집을 시작한 버전(base)을 함께 기억한다. 저장은 그 base 를 base_version 으로 보낸다
 *   (폴링으로 바뀐 최신 번호를 보내면 서버의 stale_transcript 잠금이 무력화된다).
 * - FIX3-FULLREV2(G25): 업로드는 끝났는데 전사 요청만 실패한 경우를 구분한다. 이어 올리기 키는 전사 요청이 성공한 뒤에만 지우고,
 *   저장된 세션이 이미 verified(asset 있음)면 다시 올리지 않고 전사만 요청한다.
 * - FIX1-FULLREV3(H6): 폴링 목록에 그 asset 의 진행 중·성공 작업이 보이면 '전사만 다시 요청'을 거둔다(pendingTranscribeSettled).
 */

export interface LatestTranscript {
  version: number;
  text: string;
}

/** 전사 수정 초안. conflict 는 저장 시 409 stale_transcript 로 알게 된 최신 버전(본문을 못 불러왔으면 text=null). */
export interface TranscriptDraft {
  base: number;
  text: string;
  conflict: { version: number; text: string | null } | null;
}

export const STALE_TRANSCRIPT_NOTICE = '다른 곳에서 새 버전이 저장됨';

/** 입력이 바뀔 때: 첫 입력이면 지금 보이는 최신 버전을 base 로 잡고, 이미 초안이 있으면 base 는 그대로 둔다. */
export function editDraft(prev: TranscriptDraft | undefined, latest: LatestTranscript, text: string): TranscriptDraft {
  return prev ? { ...prev, text } : { base: latest.version, text, conflict: null };
}

/** 저장 요청 본문 — 초안이 있으면 초안의 base(편집을 시작한 버전), 없으면 지금 최신. */
export function draftSaveBody(draft: TranscriptDraft | undefined, latest: LatestTranscript): { base_version: number; text: string } {
  return draft ? { base_version: draft.base, text: draft.text } : { base_version: latest.version, text: latest.text };
}

/** 409 stale_transcript 를 받은 뒤: 알게 된 최신 버전(과 본문)을 초안에 붙인다. 초안 본문은 그대로 둔다(잃지 않음). */
export function withConflict(draft: TranscriptDraft, latest: { version: number; text: string | null }): TranscriptDraft {
  const cur = draft.conflict;
  if (cur && cur.version > latest.version) return draft;
  if (cur && cur.version === latest.version && latest.text === null) return draft;
  return { ...draft, conflict: { version: latest.version, text: latest.text } };
}

/** 최신 본문을 확인한 뒤 '내 초안을 최신 기준으로' — base 를 최신으로 옮긴다(다음 저장은 내 초안이 최신 위의 새 버전). */
export function rebaseDraft(draft: TranscriptDraft, latestVersion: number): TranscriptDraft {
  return { base: latestVersion, text: draft.text, conflict: null };
}

export type DraftStatus =
  | { stale: false }
  | { stale: true; latestVersion: number; latestText: string | null; notice: string };

/** 초안이 있는 동안 최신 버전이 초안의 base 와 다르면 경고와 최신 본문(초안과 함께 보여 줄 것). */
export function draftStatus(draft: TranscriptDraft | undefined, latest: LatestTranscript): DraftStatus {
  if (!draft) return { stale: false };
  let version = latest.version;
  let text: string | null = latest.text;
  const c = draft.conflict;
  if (c && c.version >= latest.version) {
    // 409 로 알게 된 버전이 폴링 결과보다 새것이면 그 본문(못 불러왔으면 null), 같으면 어느 쪽이든 있는 본문
    version = c.version;
    text = c.text ?? (c.version === latest.version ? latest.text : null);
  }
  if (version === draft.base) return { stale: false };
  return {
    stale: true,
    latestVersion: version,
    latestText: text,
    notice: `${STALE_TRANSCRIPT_NOTICE}(v${version}). 내 초안은 v${draft.base} 기준입니다 — 아래 최신 본문과 비교한 뒤, 최신 본문으로 다시 시작하거나 내 초안을 최신 기준으로 저장하세요.`,
  };
}

// ---- G25: 업로드 · 전사 요청 단계 ----

export type StoredSessionAction = { kind: 'transcribe_only'; assetId: string } | { kind: 'resume' } | { kind: 'new' };

/**
 * 저장해 둔 이어 올리기 세션으로 할 일. verified + asset 이면 파일은 이미 서버에 있다 → 전사만 다시 요청.
 * open 이고 같은 내용(resumeDecision 통과)이면 이어 올리기, 그 밖은 새 세션.
 */
export function storedSessionAction(session: { state: string; asset_id: string | null } | null, resumable: boolean): StoredSessionAction {
  if (!session) return { kind: 'new' };
  if (session.state === 'verified' && session.asset_id) return { kind: 'transcribe_only', assetId: session.asset_id };
  if (session.state === 'open' && resumable) return { kind: 'resume' };
  return { kind: 'new' };
}

export type UploadStage = 'upload' | 'transcribe';

export const TRANSCRIBE_RETRY_LABEL = '전사만 다시 요청';

/** 실패 안내 — 업로드 단계 실패와 '업로드는 끝났고 전사 요청만 실패'를 구분한다. */
export function uploadFailureMessage(stage: UploadStage, message: string): string {
  if (stage === 'transcribe') {
    return `파일 업로드는 끝났습니다(서버에 저장됨). 전사 요청만 실패했습니다: ${message} — 파일을 다시 올리지 않아도 됩니다. 원인을 고친 뒤 '${TRANSCRIBE_RETRY_LABEL}'을 누르세요(같은 파일을 다시 골라도 전사만 요청합니다).`;
  }
  return `${message} — 같은 파일을 다시 고르면 받은 곳부터 이어 올립니다.`;
}

/**
 * FIX3-FULLREV2(G25 보강): 전사 요청 실패 중 '서버에 올린 파일이 더는 쓸 수 없음' — 같은 asset 에 다시 요청해도 소용없다.
 * 404(없음·다른 owner)·410 asset_deleted(원본 삭제됨)·409 asset_not_verified(확인 안 됨) → 저장해 둔 이어 올리기 키를 지우고
 * 새로 올려야 한다('reupload'). 그 밖(예산 429·asset_in_use·transcription_in_progress·네트워크 등)은 같은 asset 으로 다시 요청('retry').
 */
export function transcribeFailureAction(status: number, code: string | null): 'reupload' | 'retry' | 'already' {
  // FIX3-FULLREV2(G25 재검토): 같은 파일의 전사 작업이 이미 진행 중(409 transcription_in_progress — 예: 요청은 서버에 들어갔는데 응답을 잃음)이면
  // 다시 요청하지 않는다 — 요청이 이미 들어간 것으로 보고 키·'전사만 다시 요청'을 거둔다(작업이 끝난 뒤 눌러 같은 asset 에 작업·비용이 하나 더 생기지 않게).
  if (status === 409 && code === 'transcription_in_progress') return 'already';
  if (status === 404 || status === 410) return 'reupload';
  if (code === 'not_found' || code === 'asset_deleted' || code === 'asset_not_verified') return 'reupload';
  return 'retry';
}

/**
 * FIX1-FULLREV3(H6): 전사 요청이 서버에 커밋됐는데 응답을 잃으면(fetch 오류·커밋 뒤 5xx) '전사만 다시 요청'이 남는다. 폴링한 작업 목록에
 * 그 asset 의 진행 중(queued·running) 또는 성공(succeeded) 작업이 보이면 요청이 이미 들어간 것으로 본다 — 그 작업을 돌려준다(없으면 null).
 * 실패·취소 작업만 있으면 null(다시 요청이 맞다). 서버도 같은 asset 에 성공 전사가 있으면 force 없는 요청에 그 작업을 돌려준다(이중 예약 없음).
 * 작업 목록은 최근 50개뿐이라 그 밖의 오래된 작업은 보지 못한다 — 그때는 서버 쪽 멱등 처리가 막는다.
 */
export function pendingTranscribeSettled<J extends { asset_id: string; state: string; keep_original?: boolean }>(
  pending: { assetId: string; keepOriginal?: boolean } | null,
  jobs: readonly J[],
): J | null {
  if (!pending) return null;
  return (
    jobs.find(
      (j) =>
        j.asset_id === pending.assetId &&
        (j.state === 'queued' || j.state === 'running' || j.state === 'succeeded') &&
        // FIX1-FULLREV3(H6 후속): 원음 보존을 끈 요청이었는데 목록의 작업은 원음 보존 작업이면(그 요청은 기존 성공 작업을 만났을 수 있다 — 서버가 원본을
        // 지웠는지·첨부라 못 지웠는지는 그 응답에만 있다) 거두지 않는다. '전사만 다시 요청'은 새 작업·예약 없이 원본 처리 결과를 돌려받는다.
        (pending.keepOriginal !== false || j.keep_original === false),
    ) ?? null
  );
}

/** FIX1-FULLREV3(H6 후속): 서버가 기존 성공 작업을 돌려줄 때의 원본 처리 결과(keep_original=false 요청에서 원본이 아직 있었을 때만 온다). */
export interface TranscribeOriginalOutcome {
  original_deleted?: boolean;
  original_kept_reason?: string;
}

/** FIX1-FULLREV3(H6 후속): 위 결과의 안내 문구(앞에 공백 포함). 해당 없으면 빈 문자열 — 원본이 어떻게 됐는지 화면이 그대로 말한다. */
export function transcribeOriginalNote(r: TranscribeOriginalOutcome | null | undefined): string {
  if (!r || typeof r.original_deleted !== 'boolean') return '';
  if (r.original_deleted) return ' 원음 보존을 끈 요청이라 원본 파일을 지웠습니다(전사 본문은 남음, 다운로드는 410).';
  if (r.original_kept_reason === 'asset_in_use') {
    return ' 원본 파일은 지우지 않았습니다 — 채널 초안에 첨부된 파일이라 원음 보존 끄기를 적용할 수 없습니다. 첨부를 뺀 뒤 다시 요청하세요.';
  }
  return ' 원본 파일은 지우지 않았습니다 — 앞선 원본 정리가 아직 끝나지 않았습니다. 잠시 뒤 다시 요청하세요.';
}

/** FIX1-FULLREV3(H6): 위 판정으로 '전사만 다시 요청'을 거둘 때 · 서버가 기존 성공 작업을 돌려줬을 때의 안내. */
export function transcribeSettledMessage(state: string): string {
  return state === 'succeeded'
    ? '이 파일의 전사는 이미 끝났습니다 — 다시 요청하지 않았습니다(새 비용 예약 없음). 아래 목록에서 결과를 확인하세요.'
    : '이 파일의 전사 요청은 이미 서버에 들어가 있습니다 — 다시 요청하지 않았습니다. 아래 목록에서 진행률을 확인하세요.';
}

/** 'reupload' 안내 — 전사만 다시 요청하지 말고 파일을 새로 올리게 한다. */
export function assetGoneMessage(message: string): string {
  return `서버에 올린 파일을 더는 전사할 수 없습니다: ${message} — 저장해 둔 업로드 기록을 지웠습니다. 같은 파일을 다시 고르면 새로 올립니다.`;
}

/**
 * FIX3-FULLREV2(G23 보강): '비교했음 — 내 초안을 최신 기준으로' 버튼을 보일지. 최신 본문(latestText)을 아직 못 불러왔으면(null) 비교할 수
 * 없으므로 숨긴다 — 보지 못한 최신 본문 위에 내 초안을 덮어쓰는 저장을 막는다. '최신 본문으로 다시 시작'은 그대로 둔다.
 */
export function canRebaseDraft(status: DraftStatus): boolean {
  return status.stale && status.latestText !== null;
}
