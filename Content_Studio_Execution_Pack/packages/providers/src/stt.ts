/**
 * T08 음성 전사 provider(결정 D9·D15). **네트워크 접근 없음.**
 * - MockTranscriber: 파일 checksum 으로 정해지는 한국어 자리표시 문장(같은 파일 → 같은 결과). 음성을 해석하지 않는다.
 * - LiveTranscriber: 공급자 중립 경계. 승인 기록·공급자·모델·가격이 모두 있어도 T08 에는 어댑터가 없어 항상 거부한다.
 */
import { createHash } from 'node:crypto';
import { LiveSttNotConfiguredError, MOCK_TRANSCRIPT_WARNING, sttLiveReadiness, type AppConfig, type TranscriptSegment } from '@cs/domain';

export interface TranscribeInput {
  assetId: string;
  checksum: string;
  mime: string;
  /** 예약에 쓴 음성 길이(초) */
  audioSeconds: number;
}

export interface TranscribeOutput {
  text: string;
  segments: TranscriptSegment[];
  /** 실제 처리한 음성 길이(초) — 비용 확정 근거 */
  audioSeconds: number;
  warnings: string[];
}

export interface Transcriber {
  readonly name: string;
  readonly mode: 'mock' | 'live';
  readonly model: string;
  transcribe(input: TranscribeInput): Promise<TranscribeOutput>;
}

export class MockTranscriberFailure extends Error {
  constructor() {
    super('모의 전사 실패(주입)');
    this.name = 'MockTranscriberFailure';
  }
}

const PHRASES = [
  '해외 거래처와 첫 미팅을 준비하며 확인한 점을 정리합니다.',
  '현지 파트너와 일정 조율에서 배운 점이 있습니다.',
  '견적 협상 전에 내부 승인 절차를 먼저 확인했습니다.',
  'AI 도구로 회의록 초안을 만든 뒤 직접 고쳤습니다.',
  '주재원 생활에서 가장 오래 걸린 일은 신뢰를 쌓는 일이었습니다.',
  '영업 보고서는 숫자보다 다음 행동을 먼저 적었습니다.',
];

export const MOCK_STT_MODEL = 'mock-stt-v1';

/** 결정적 모의 전사기. 같은 checksum·길이 → 같은 결과. */
export class MockTranscriber implements Transcriber {
  readonly name = 'mock';
  readonly mode = 'mock' as const;
  readonly model = MOCK_STT_MODEL;
  private readonly fail: boolean;

  constructor(opts: { fail?: boolean } = {}) {
    this.fail = opts.fail === true;
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    if (this.fail) throw new MockTranscriberFailure();
    const hash = createHash('sha256').update(`stt\u0000${input.checksum}`).digest();
    const count = 2 + (hash[0]! % 3);
    const totalMs = Math.max(1, input.audioSeconds) * 1000;
    const step = Math.floor(totalMs / count);
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < count; i++) {
      const phrase = PHRASES[hash[i + 1]! % PHRASES.length]!;
      segments.push({ start_ms: i * step, end_ms: i === count - 1 ? totalMs : (i + 1) * step, text: `[모의 전사 ${i + 1}] ${phrase}` });
    }
    return {
      text: segments.map((s) => s.text).join('\n'),
      segments,
      audioSeconds: input.audioSeconds,
      warnings: [MOCK_TRANSCRIPT_WARNING],
    };
  }
}

/** T08 live 경계 — HTTP 호출이 없다. 어떤 설정으로도 전사하지 않는다. */
export class LiveTranscriber implements Transcriber {
  readonly name: string;
  readonly mode = 'live' as const;
  readonly model: string;
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
    this.name = config.STT_PROVIDER ?? 'live';
    this.model = config.STT_MODEL ?? 'unknown';
  }

  assertReady(): void {
    throw new LiveSttNotConfiguredError(sttLiveReadiness(this.config).missing);
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    void input;
    throw new LiveSttNotConfiguredError(sttLiveReadiness(this.config).missing);
  }
}
