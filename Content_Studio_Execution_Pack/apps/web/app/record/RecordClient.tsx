'use client';
/**
 * /record 의 브라우저 부분(T08). 서버 값·비밀 없음 — 같은 출처 API 만 부른다.
 * - MediaRecorder 지원 여부만 확인해 안내한다(녹음 기능은 기기 확인 뒤 추가).
 * - 조각 업로드: 세션 생성 → 빠진 조각을 차례로 PUT(진행률) → 완료 → 전사 요청. 세션 ID 는 파일(이름·크기·수정 시각)별로
 *   localStorage 에 두어, 새로고침 뒤 같은 파일을 다시 고르면 GET 으로 받은 위치부터 이어 올린다(A14).
 * - 전사 목록: 진행 중 작업이 있으면 1.5초마다 GET(inline worker 가 그때 한 단계씩 진행).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { resumeDecision, Sha256, startPolling, type ServerSessionLike } from '../../lib/upload-client';

const ALLOWED = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'video/mp4', 'video/webm', 'video/quicktime'];
const STATE_LABEL: Record<string, string> = {
  queued: '대기',
  running: '전사 중',
  succeeded: '완료',
  failed: '실패',
  canceled: '취소됨',
};

interface SessionView {
  id: string;
  state: string;
  chunk_size: number;
  chunk_count: number;
  next_index: number | null;
  progress: number;
  received_bytes: number;
  bytes: number;
}

interface TranscriptView {
  id: string;
  version: number;
  text: string;
  created_by: string;
}

interface JobView {
  id: string;
  asset_id: string;
  state: string;
  progress: number;
  mock: boolean;
  mock_warning: string | null;
  error: string | null;
  keep_original: boolean;
  latest_transcript: TranscriptView | null;
  created_at: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init?.headers ?? {}) } });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body.message === 'string' ? body.message : `요청 실패(${res.status})`);
  return body as T;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** FIX-T08(P1): 이어 올리기 키는 파일 내용(sha256)이다 — 이름·크기·수정 시각이 같아도 내용이 다르면 다른 세션. */
function resumeKey(sha256: string): string {
  return `cs-upload:sha256:${sha256}`;
}

const CHUNK_BYTES = 8 * 1024 * 1024;

const toHex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** 파일 전체 sha256(8MiB 씩 읽어 증분 해시 — 전체를 메모리에 올리지 않음) */
async function fileSha256(file: File, onProgress: (pct: number) => void): Promise<string> {
  const h = new Sha256();
  for (let off = 0; off < file.size; off += CHUNK_BYTES) {
    h.update(new Uint8Array(await file.slice(off, Math.min(file.size, off + CHUNK_BYTES)).arrayBuffer()));
    onProgress(Math.floor((Math.min(file.size, off + CHUNK_BYTES) * 100) / Math.max(1, file.size)));
  }
  return h.hex();
}

/** 이 파일의 index 번째 조각 범위 sha256(WebCrypto — 조각은 8MiB 이하) */
async function chunkSha256(file: File, index: number, chunkSize: number): Promise<string> {
  const part = await file.slice(index * chunkSize, Math.min(file.size, (index + 1) * chunkSize)).arrayBuffer();
  return toHex(await crypto.subtle.digest('SHA-256', part));
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 저장소를 쓸 수 없으면 이어 올리기만 안 된다
  }
}

/** 저장해 둔 세션이 open 이고 **같은 내용의 파일**(전체 sha256·받은 조각별 sha256 일치)이면 그 상태, 아니면 null */
async function resumeSession(id: string | null, file: File, sha256: string): Promise<SessionView | null> {
  if (!id) return null;
  try {
    const r = await call<{ session: SessionView & ServerSessionLike }>(`/api/uploads/sessions/${id}`);
    const d = await resumeDecision(r.session, { size: file.size, sha256 }, (i, size) => chunkSha256(file, i, size));
    return d.resume ? r.session : null;
  } catch {
    return null;
  }
}

const noSubscribe = () => () => undefined;

export default function RecordClient() {
  // 서버 렌더에서는 null(확인 중), 브라우저에서는 MediaRecorder 지원 여부
  const recorder = useSyncExternalStore(
    noSubscribe,
    () => 'MediaRecorder' in window,
    () => null,
  );
  const [file, setFile] = useState<File | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [pollError, setPollError] = useState<string>('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const poller = useRef<{ stop: () => void; poke: () => void } | null>(null);

  // FIX-T08(P1): 폴링 루프 — 실패해도 항상 다음 조회를 예약(2초→10초 backoff), 진행 중이면 1.5초, 없으면 10초. 화면을 떠나면 멈춘다.
  useEffect(() => {
    const p = startPolling(
      async () => {
        try {
          return await call<{ jobs: JobView[] }>('/api/transcription-jobs');
        } catch (e) {
          setPollError(`전사 목록을 불러오지 못했습니다: ${(e as Error).message} — 자동으로 다시 시도합니다.`);
          throw e;
        }
      },
      (r) => {
        setJobs(r.jobs);
        setPollError('');
        return { active: r.jobs.some((j) => j.state === 'queued' || j.state === 'running') };
      },
    );
    poller.current = p;
    return () => {
      p.stop();
      poller.current = null;
    };
  }, []);
  const loadJobs = async () => poller.current?.poke();

  async function upload() {
    if (!file) return;
    setError('');
    const mime = file.type.toLowerCase();
    if (!ALLOWED.includes(mime)) {
      setError('지원하지 않는 음성·영상 형식입니다. MP3·M4A·WAV·WebM·MP4·MOV 파일을 고르세요.');
      return;
    }
    setBusy(true);
    try {
      setStatus('파일 내용을 확인하는 중입니다(sha256)…');
      const sha256 = await fileSha256(file, (pct) => setProgress(pct));
      const key = resumeKey(sha256);
      const resumed = await resumeSession(readStored(key), file, sha256);
      let session: SessionView;
      if (resumed) {
        session = resumed;
        setStatus(`이전 업로드를 이어 올립니다(${resumed.progress}% 받음).`);
      } else {
        const created = await call<{ session: SessionView }>(
          '/api/uploads/sessions',
          jsonInit('POST', { kind: mime.startsWith('audio/') ? 'audio' : 'video', mime, bytes: file.size, sha256, chunk_size: CHUNK_BYTES }),
        );
        session = created.session;
        writeStored(key, session.id);
        setStatus('업로드를 시작했습니다.');
      }
      setProgress(session.progress);
      for (let i = session.next_index; i !== null; i = session.next_index) {
        const part = file.slice(i * session.chunk_size, Math.min(file.size, (i + 1) * session.chunk_size));
        const put: { session: SessionView } = await call<{ session: SessionView }>(`/api/uploads/sessions/${session.id}/chunks/${i}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: part,
        });
        session = put.session;
        setProgress(session.progress);
      }
      setStatus('서버에서 파일을 확인하는 중입니다(형식 서명·크기·checksum).');
      const done = await call<{ asset: { id: string } }>(`/api/uploads/sessions/${session.id}/complete`, { method: 'POST' });
      writeStored(key, null);
      await call(`/api/assets/${done.asset.id}/transcribe`, jsonInit('POST', { keep_original: keepOriginal }));
      setStatus('전사를 요청했습니다(모의). 아래 목록에서 진행률을 확인하세요.');
      setProgress(null);
      await loadJobs();
    } catch (e) {
      setError(`${(e as Error).message} — 같은 파일을 다시 고르면 받은 곳부터 이어 올립니다.`);
    } finally {
      setBusy(false);
    }
  }

  async function saveVersion(job: JobView) {
    const t = job.latest_transcript;
    if (!t) return;
    setError('');
    try {
      await call(`/api/transcripts/${t.id}/versions`, jsonInit('POST', { base_version: t.version, text: drafts[job.id] ?? t.text }));
      setDrafts((d) => {
        const next = { ...d };
        delete next[job.id];
        return next;
      });
      setStatus('수정본을 새 버전으로 저장했습니다.');
      await loadJobs();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toCapture(job: JobView) {
    const t = job.latest_transcript;
    if (!t) return;
    setError('');
    try {
      const r = await call<{ created: boolean; capture: { id: string } }>(`/api/transcripts/${t.id}/to-capture`, { method: 'POST' });
      setStatus(r.created ? `소재로 저장했습니다(v${t.version}).` : '이 버전은 이미 소재로 저장되어 있습니다.');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function cancel(job: JobView) {
    setError('');
    try {
      await call(`/api/transcription-jobs/${job.id}/cancel`, { method: 'POST' });
      await loadJobs();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <section className="card archive" aria-labelledby="rec-title">
        <h3 id="rec-title">녹음</h3>
        {recorder === null ? (
          <p className="note">이 기기의 녹음 지원 여부를 확인하는 중입니다…</p>
        ) : recorder ? (
          <p className="note">이 브라우저는 녹음을 지원하지만, 브라우저 녹음은 기기 확인 뒤 추가합니다 → 지금은 아래 파일 업로드를 쓰세요.</p>
        ) : (
          <p className="notice" role="note">
            이 기기에서는 브라우저 녹음을 지원하지 않습니다 → 파일 업로드
          </p>
        )}
      </section>

      <section className="card archive" aria-labelledby="up-title">
        <h3 id="up-title">파일 업로드 → 전사(모의)</h3>
        <div className="form">
          <label>
            음성·영상 파일
            <input type="file" accept="audio/*,video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
          </label>
          <label>
            <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} disabled={busy} /> 원음 보존(끄면
            전사 성공 뒤 원본 파일을 지웁니다 — 메타데이터는 남음)
          </label>
          <button type="button" onClick={() => void upload()} disabled={!file || busy}>
            {busy ? '올리는 중…' : '올리고 전사 요청'}
          </button>
        </div>
        {progress !== null ? (
          <p>
            업로드 <progress max={100} value={progress} /> {progress}%
          </p>
        ) : null}
        {status ? (
          <p className="saved" role="status">
            {status}
          </p>
        ) : null}
        {error ? (
          <p className="notice" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="jobs-title">
        <h3 id="jobs-title">전사 작업</h3>
        {pollError ? (
          <p className="notice" role="status">
            {pollError}
          </p>
        ) : null}
        {jobs !== null && jobs.length === 0 ? <p className="empty-text">아직 전사 작업이 없습니다.</p> : null}
        <ul className="list">
          {(jobs ?? []).map((j) => (
            <li key={j.id}>
              <p className="meta">
                <span className="tag">{STATE_LABEL[j.state] ?? j.state}</span>
                {j.mock ? <span className="tag warn">{j.mock_warning ?? '모의 전사'}</span> : null}
                <progress max={100} value={j.progress} /> {j.progress}%{!j.keep_original ? ' · 원음 보존 안 함' : ''}
                {j.error ? ` · ${j.error}` : ''}
              </p>
              {j.state === 'queued' || j.state === 'running' ? (
                <button type="button" onClick={() => void cancel(j)}>
                  취소
                </button>
              ) : null}
              {j.latest_transcript ? (
                <div className="form">
                  <label>
                    전사 본문 v{j.latest_transcript.version}({j.latest_transcript.created_by === 'mock' ? '모의 전사' : '내가 수정'})
                    <textarea
                      rows={5}
                      value={drafts[j.id] ?? j.latest_transcript.text}
                      onChange={(e) => setDrafts((d) => ({ ...d, [j.id]: e.target.value }))}
                    />
                  </label>
                  <button type="button" onClick={() => void saveVersion(j)}>
                    수정본 저장(새 버전)
                  </button>{' '}
                  <button type="button" onClick={() => void toCapture(j)}>
                    이 버전을 소재로 보내기
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
