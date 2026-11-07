/**
 * FIX3-FULLREV2(G23·G25): /record 화면 판단 함수 + RecordClient 연결 확인(소스 검사 — upload-client.test.ts 와 같은 방식).
 * 실제 라우트와 맞춘 흐름 시험은 tests/integration/uploads-transcription.test.ts 의 'FIX3-FULLREV2(G23·G25)' 절.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assetGoneMessage,
  canRebaseDraft,
  draftSaveBody,
  draftStatus,
  editDraft,
  pendingTranscribeSettled,
  rebaseDraft,
  STALE_TRANSCRIPT_NOTICE,
  storedSessionAction,
  TRANSCRIBE_RETRY_LABEL,
  transcribeFailureAction,
  transcribeOriginalNote,
  transcribeSettledMessage,
  uploadFailureMessage,
  withConflict,
} from './record-client';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = () => readFileSync(path.join(here, '..', 'app', 'record', 'RecordClient.tsx'), 'utf8');

describe('G23 전사 수정 초안 — base 는 편집을 시작한 버전', () => {
  const v1 = { version: 1, text: '처음 본문' };
  const v2 = { version: 2, text: '다른 탭 본문' };

  it('첫 입력에서 base 를 잡고, 이후 입력·폴링(최신 v2)에도 base 는 그대로 — 저장 본문은 base_version 1', () => {
    let d = editDraft(undefined, v1, '처음 본문 수정');
    d = editDraft(d, v2, '처음 본문 수정 계속'); // 폴링으로 최신이 바뀐 뒤 입력해도
    expect(d).toEqual({ base: 1, text: '처음 본문 수정 계속', conflict: null });
    expect(draftSaveBody(d, v2)).toEqual({ base_version: 1, text: '처음 본문 수정 계속' });
    expect(draftSaveBody(undefined, v2)).toEqual({ base_version: 2, text: '다른 탭 본문' });
  });

  it('초안이 있는 동안 최신 버전이 바뀌면 경고 + 최신 본문, 같으면 경고 없음, 초안 없으면 경고 없음', () => {
    const d = editDraft(undefined, v1, 'x');
    expect(draftStatus(d, v1)).toEqual({ stale: false });
    expect(draftStatus(undefined, v2)).toEqual({ stale: false });
    const st = draftStatus(d, v2);
    expect(st).toMatchObject({ stale: true, latestVersion: 2, latestText: '다른 탭 본문' });
    expect(st.stale && st.notice).toContain(STALE_TRANSCRIPT_NOTICE);
    expect(STALE_TRANSCRIPT_NOTICE).toBe('다른 곳에서 새 버전이 저장됨');
  });

  it('409 로 알게 된 버전이 폴링보다 새것이면 그 버전으로 경고(본문을 못 불러왔으면 null), 초안 본문은 그대로', () => {
    const d = editDraft(undefined, v1, '내 초안');
    const c = withConflict(d, { version: 3, text: null });
    expect(c.text).toBe('내 초안');
    expect(draftStatus(c, v1)).toMatchObject({ stale: true, latestVersion: 3, latestText: null });
    const c2 = withConflict(c, { version: 3, text: 'v3 본문' });
    expect(draftStatus(c2, v1)).toMatchObject({ stale: true, latestVersion: 3, latestText: 'v3 본문' });
    // 더 옛 정보로 덮지 않는다
    expect(withConflict(c2, { version: 2, text: 'v2' })).toBe(c2);
    // 폴링이 따라잡으면 폴링 본문
    expect(draftStatus(withConflict(d, { version: 2, text: null }), v2)).toMatchObject({ latestVersion: 2, latestText: '다른 탭 본문' });
  });

  it('비교 뒤 최신 기준으로 옮기면 경고가 사라지고 저장 base 는 최신', () => {
    const d = withConflict(editDraft(undefined, v1, '내 초안'), { version: 2, text: '다른 탭 본문' });
    const r = rebaseDraft(d, 2);
    expect(draftStatus(r, v2)).toEqual({ stale: false });
    expect(draftSaveBody(r, v2)).toEqual({ base_version: 2, text: '내 초안' });
  });

  it('RecordClient 연결: 저장은 draftSaveBody(초안 base), 입력은 editDraft, 경고는 draftStatus, 409 는 withConflict', () => {
    const s = src();
    expect(s).toMatch(/draftSaveBody\(draft, t\)/);
    expect(s).not.toMatch(/base_version: t\.version/);
    expect(s).toMatch(/editDraft\(d\[j\.id\], latest, text\)/);
    expect(s).toMatch(/draftStatus\(draft, latest\)/);
    expect(s).toMatch(/e\.code === 'stale_transcript'/);
    expect(s).toMatch(/withConflict\(/);
    expect(s).toMatch(/Record<string, TranscriptDraft>/);
  });
});

describe('G25 업로드 성공 + 전사 요청 실패', () => {
  it('저장된 세션: verified+asset → 전사만, open+같은 내용 → 이어 올리기, 그 밖 → 새 세션', () => {
    expect(storedSessionAction({ state: 'verified', asset_id: 'a1' }, false)).toEqual({ kind: 'transcribe_only', assetId: 'a1' });
    expect(storedSessionAction({ state: 'verified', asset_id: null }, false)).toEqual({ kind: 'new' });
    expect(storedSessionAction({ state: 'open', asset_id: null }, true)).toEqual({ kind: 'resume' });
    expect(storedSessionAction({ state: 'open', asset_id: null }, false)).toEqual({ kind: 'new' });
    expect(storedSessionAction({ state: 'completed', asset_id: null }, true)).toEqual({ kind: 'new' });
    expect(storedSessionAction(null, true)).toEqual({ kind: 'new' });
  });

  it('안내 문구: 업로드 단계 실패는 이어 올리기, 전사 요청 실패는 "업로드는 끝났습니다" + 전사만 다시 요청', () => {
    expect(uploadFailureMessage('upload', '네트워크 오류')).toBe('네트워크 오류 — 같은 파일을 다시 고르면 받은 곳부터 이어 올립니다.');
    const t = uploadFailureMessage('transcribe', '예산 초과');
    expect(t).toContain('파일 업로드는 끝났습니다');
    expect(t).toContain('전사 요청만 실패했습니다: 예산 초과');
    expect(t).toContain(TRANSCRIBE_RETRY_LABEL);
    expect(t).not.toContain('받은 곳부터 이어 올립니다');
    expect(TRANSCRIBE_RETRY_LABEL).toBe('전사만 다시 요청');
  });

  it('RecordClient 연결: 이어 올리기 키는 전사 요청 성공 뒤에만 지우고, 실패는 단계별 안내 + 다시 요청 버튼', () => {
    const s = src();
    const removes = s.match(/writeStored\(key, null\)/g) ?? [];
    expect(removes).toHaveLength(1);
    const transcribeCall = s.indexOf('await call(`/api/assets/${assetId}/transcribe`');
    expect(transcribeCall).toBeGreaterThan(0);
    expect(s.indexOf('writeStored(key, null)')).toBeGreaterThan(transcribeCall);
    // 완료 직후에 키를 지우지 않는다
    expect(s).not.toMatch(/\/complete`, \{ method: 'POST' \}\);\s*writeStored\(key, null\)/);
    expect(s).toMatch(/stage = 'transcribe';\s*await requestTranscription\(done\.asset\.id, key\)/);
    expect(s).toMatch(/uploadFailureMessage\(stage,/);
    expect(s).toMatch(/storedSessionAction\(/);
    expect(s).toMatch(/kind === 'transcribe_only'/);
    expect(s).toMatch(/\{TRANSCRIBE_RETRY_LABEL\}/);
    expect(s).not.toMatch(/— 같은 파일을 다시 고르면 받은 곳부터 이어 올립니다\.`\);/);
  });
});

describe('FIX3-FULLREV2 fixup(G25 보강) — 전사 대상 파일이 사라짐 → 키 지우고 새로 올림', () => {
  it('404·410·asset_deleted·asset_not_verified → reupload, 그 밖 → retry', () => {
    expect(transcribeFailureAction(404, 'not_found')).toBe('reupload');
    expect(transcribeFailureAction(410, 'asset_deleted')).toBe('reupload');
    expect(transcribeFailureAction(409, 'asset_not_verified')).toBe('reupload');
    // FIX3-FULLREV2(G25 재검토): 이미 진행 중은 'already'(다시 요청하지 않고 키를 거둠) — 아래 별도 시험
    expect(transcribeFailureAction(409, 'transcription_in_progress')).toBe('already');
    expect(transcribeFailureAction(409, 'asset_in_use')).toBe('retry');
    expect(transcribeFailureAction(429, 'budget_exceeded')).toBe('retry');
    expect(transcribeFailureAction(500, 'internal')).toBe('retry');
    expect(assetGoneMessage('원본 삭제됨')).toContain('같은 파일을 다시 고르면 새로 올립니다');
    expect(assetGoneMessage('원본 삭제됨')).not.toContain(TRANSCRIBE_RETRY_LABEL);
  });

  it('RecordClient 연결: 실패 분류 → 키 삭제(성공과 같은 한 곳) + pendingTranscribe 비움 → transcribe_only 는 새 세션으로, 재요청은 다시 올리라고 안내', () => {
    const s = src();
    const fn = s.slice(s.indexOf('async function requestTranscription('), s.indexOf('async function retryTranscription('));
    expect(fn).toMatch(/transcribeFailureAction\(e\.status, e\.code\) : 'retry';\s*if \(action === 'retry'\) throw e;/);
    // 키 삭제·pendingTranscribe 비움이 판정(retry 만 다시 던짐) 뒤, AssetGoneError 던지기 앞
    const iClassify = fn.indexOf("if (action === 'retry') throw e;");
    const iRemove = fn.indexOf('writeStored(key, null)');
    const iClear = fn.indexOf('setPendingTranscribe(null)');
    const iThrow = fn.indexOf('if (gone) throw new AssetGoneError(');
    expect(iClassify).toBeGreaterThan(0);
    expect(iRemove).toBeGreaterThan(iClassify);
    expect(iClear).toBeGreaterThan(iRemove);
    expect(iThrow).toBeGreaterThan(iClear);
    // transcribe_only 실패(파일 없음) → 업로드 단계로 내려가 새 세션 생성
    expect(s).toMatch(/if \(!\(e instanceof AssetGoneError\)\) throw e;[\s\S]{0,200}stage = 'upload';/);
    expect(s.indexOf("if (!(e instanceof AssetGoneError)) throw e;")).toBeLessThan(s.indexOf("'/api/uploads/sessions',"));
    // 두 catch 모두 파일 없음 안내
    expect(s.match(/e instanceof AssetGoneError \? assetGoneMessage\(e\.message\)/g) ?? []).toHaveLength(2);
  });
});

describe('FIX3-FULLREV2 fixup(G23 보강) — 최신 본문을 못 불러왔으면 "비교했음" 버튼 숨김', () => {
  it('canRebaseDraft: stale + latestText 있음 → true, latestText null → false, stale 아님 → false', () => {
    const d = editDraft(undefined, { version: 1, text: 'a' }, 'b');
    expect(canRebaseDraft(draftStatus(d, { version: 2, text: '최신' }))).toBe(true);
    const unknown = withConflict(d, { version: 3, text: null });
    const st = draftStatus(unknown, { version: 2, text: '폴링 v2' });
    expect(st).toMatchObject({ stale: true, latestVersion: 3, latestText: null });
    expect(canRebaseDraft(st)).toBe(false);
    expect(canRebaseDraft(draftStatus(d, { version: 1, text: 'a' }))).toBe(false);
    expect(canRebaseDraft({ stale: false })).toBe(false);
  });

  it('RecordClient 연결: 버튼은 canRebaseDraft(st) 안에서만 그린다', () => {
    const s = src();
    const iGuard = s.indexOf('{canRebaseDraft(st) ? (');
    const iButton = s.indexOf('비교했음 — 내 초안을 최신 기준으로');
    expect(iGuard).toBeGreaterThan(0);
    expect(iButton).toBeGreaterThan(iGuard);
    expect(s.slice(iGuard, iButton)).not.toContain(') : null}');
    expect(s.match(/비교했음 — 내 초안을 최신 기준으로/g) ?? []).toHaveLength(1);
  });
});

describe('FIX3-FULLREV2(G25 재검토) — 이미 진행 중(409 transcription_in_progress)은 다시 요청하지 않음', () => {
  it("transcribeFailureAction: 409 transcription_in_progress → 'already', 다른 409 → retry", () => {
    expect(transcribeFailureAction(409, 'transcription_in_progress')).toBe('already');
    expect(transcribeFailureAction(409, 'asset_in_use')).toBe('retry');
    expect(transcribeFailureAction(500, 'transcription_in_progress')).toBe('retry');
  });

  it('RecordClient: already 는 던지지 않고 키·pendingTranscribe 를 거두고 진행 중 안내(새 요청 없음)', () => {
    const s = src();
    const fn = s.slice(s.indexOf('async function requestTranscription('), s.indexOf('async function retryTranscription('));
    expect(fn).toMatch(/else already = true;/);
    const iAlready = fn.indexOf('else already = true;');
    expect(fn.indexOf('writeStored(key, null)')).toBeGreaterThan(iAlready);
    expect(fn.indexOf('setPendingTranscribe(null)')).toBeGreaterThan(iAlready);
    expect(fn).toContain('이 파일의 전사 작업이 이미 진행 중입니다 — 다시 요청하지 않았습니다.');
    // 요청 호출은 한 번뿐(이미 진행 중이면 다시 부르지 않음)
    expect(fn.match(/\/transcribe`/g) ?? []).toHaveLength(1);
  });
});

describe('FIX1-FULLREV3(H6) — 응답을 잃은 전사 요청: 폴링 목록에 그 asset 의 작업이 보이면 재시도 버튼·키를 거둔다', () => {
  const pending = { assetId: 'a-1', key: 'cs-upload:sha256:x' };
  const job = (asset_id: string, state: string) => ({ id: `${asset_id}-${state}`, asset_id, state });

  it('pendingTranscribeSettled: 같은 asset 의 queued·running·succeeded → 그 작업, failed·canceled·다른 asset·pending 없음 → null', () => {
    for (const st of ['queued', 'running', 'succeeded']) expect(pendingTranscribeSettled(pending, [job('b', 'running'), job('a-1', st)])).toEqual(job('a-1', st));
    expect(pendingTranscribeSettled(pending, [job('a-1', 'failed'), job('a-1', 'canceled'), job('b', 'succeeded')])).toBeNull();
    expect(pendingTranscribeSettled(pending, [])).toBeNull();
    expect(pendingTranscribeSettled(null, [job('a-1', 'succeeded')])).toBeNull();
    // 실패 작업 뒤 새 작업이 들어가 있으면 그 새 작업
    expect(pendingTranscribeSettled(pending, [job('a-1', 'queued'), job('a-1', 'failed')])).toEqual(job('a-1', 'queued'));
  });

  it('transcribeSettledMessage: 성공 → 이미 끝남(새 비용 예약 없음), 진행 중 → 이미 들어감. 재시도 버튼 문구는 없다', () => {
    expect(transcribeSettledMessage('succeeded')).toContain('이미 끝났습니다');
    expect(transcribeSettledMessage('succeeded')).toContain('새 비용 예약 없음');
    expect(transcribeSettledMessage('running')).toContain('이미 서버에 들어가 있습니다');
    for (const st of ['succeeded', 'queued']) expect(transcribeSettledMessage(st)).not.toContain(TRANSCRIBE_RETRY_LABEL);
  });

  it('RecordClient 연결: 폴링 결과에서 pendingTranscribeSettled → 키 삭제·pendingTranscribe 비움·안내, 요청 중(busy)에는 판정 안 함', () => {
    const s = src();
    const start = s.indexOf('setJobs(r.jobs);');
    const end = s.indexOf('return { active:', start);
    expect(start).toBeGreaterThan(0);
    const cb = s.slice(start, end);
    expect(cb).toContain('pending && !busyRef.current ? pendingTranscribeSettled(pending, r.jobs) : null');
    const iCheck = cb.indexOf('if (pending && settled) {');
    expect(iCheck).toBeGreaterThan(0);
    expect(cb.indexOf('writeStored(pending.key, null)')).toBeGreaterThan(iCheck);
    expect(cb.indexOf('setPendingTranscribe(null)')).toBeGreaterThan(iCheck);
    expect(cb.indexOf('setStatus(transcribeSettledMessage(settled.state))')).toBeGreaterThan(iCheck);
    // 폴링 콜백이 지금 값을 보도록 ref 를 맞춘다
    expect(s).toMatch(/pendingRef\.current = pendingTranscribe;\s*busyRef\.current = busy;/);
    // 재시도 버튼은 pendingTranscribe 가 있을 때만
    expect(s).toContain('{pendingTranscribe && !busy ? (');
  });

  it('RecordClient: 서버의 200 existing 은 새 요청이 아니라고 안내하고, 화면은 force 를 보내지 않는다', () => {
    const s = src();
    const fn = s.slice(s.indexOf('async function requestTranscription('), s.indexOf('async function retryTranscription('));
    expect(fn).toContain("if (r.existing === true) existing = r.job?.state ?? 'succeeded';");
    expect(fn).toContain('transcribeSettledMessage(existing)');
    expect(fn).toContain("jsonInit('POST', { keep_original: keepOriginal })");
    expect(s).not.toMatch(/force\s*:/);
  });
  it('FIX1-FULLREV3(H6 후속): 원음 보존을 끈 요청은 원음 보존 작업으로 거두지 않는다(재시도가 원본 처리 결과를 돌려받게), keep_original=false 작업이면 거둔다', () => {
    const j = (state: string, keep_original: boolean) => ({ id: `${state}-${keep_original}`, asset_id: 'a-1', state, keep_original });
    expect(pendingTranscribeSettled({ assetId: 'a-1', keepOriginal: false }, [j('succeeded', true)])).toBeNull();
    expect(pendingTranscribeSettled({ assetId: 'a-1', keepOriginal: false }, [j('succeeded', true), j('running', false)])).toEqual(j('running', false));
    expect(pendingTranscribeSettled({ assetId: 'a-1', keepOriginal: true }, [j('succeeded', true)])).toEqual(j('succeeded', true));
    expect(pendingTranscribeSettled({ assetId: 'a-1' }, [j('succeeded', true)])).toEqual(j('succeeded', true));
  });

  it('FIX1-FULLREV3(H6 후속): transcribeOriginalNote — 지움·첨부라 못 지움·정리 대기·해당 없음', () => {
    expect(transcribeOriginalNote({ original_deleted: true })).toBe(' 원음 보존을 끈 요청이라 원본 파일을 지웠습니다(전사 본문은 남음, 다운로드는 410).');
    expect(transcribeOriginalNote({ original_deleted: false, original_kept_reason: 'asset_in_use' })).toContain('채널 초안에 첨부된 파일이라');
    expect(transcribeOriginalNote({ original_deleted: false, original_kept_reason: 'cleanup_pending' })).toContain('앞선 원본 정리가 아직 끝나지 않았습니다');
    for (const r of [null, undefined, {}]) expect(transcribeOriginalNote(r)).toBe('');
  });

  it('FIX1-FULLREV3(H6 후속) RecordClient: 기존 작업 응답의 원본 처리 결과를 안내에 붙이고, 대기 요청에 원음 보존 값을 기억한다', () => {
    const s = src();
    const fn = s.slice(s.indexOf('async function requestTranscription('), s.indexOf('async function retryTranscription('));
    expect(fn).toContain('setPendingTranscribe({ assetId, key, keepOriginal });');
    expect(fn).toContain('if (r.existing === true) original = r;');
    expect(fn).toContain('transcribeSettledMessage(existing) + transcribeOriginalNote(original)');
  });
});
