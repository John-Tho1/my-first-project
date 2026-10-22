/**
 * FIX1-FULLREV(F3): 업로드 신고 형식 정규화(normalizeMediaMime). 브라우저 File.type 의 별칭·매개변수·대소문자·빈 형식(확장자 추정)을
 * 정본으로 바꾸고, 허용 목록 밖은 null. 서명 판정(sniffMedia·mediaMatches)은 이 함수와 무관하게 그대로다(upload.test.ts).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_MEDIA_MIME, MEDIA_EXT, normalizeMediaMime } from './media-mime';
import * as viaUpload from './upload';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('normalizeMediaMime — 신고 형식 → 정본(FIX1-FULLREV F3)', () => {
  it('정본은 그대로', () => {
    for (const m of ALLOWED_MEDIA_MIME) expect(normalizeMediaMime(m), m).toBe(m);
  });

  it('브라우저·OS 별칭을 정본으로 바꾼다', () => {
    const cases: Array<[string, string]> = [
      ['audio/x-m4a', 'audio/mp4'],
      ['audio/m4a', 'audio/mp4'],
      ['audio/x-wav', 'audio/wav'],
      ['audio/wave', 'audio/wav'],
      ['audio/vnd.wave', 'audio/wav'],
      ['audio/mp3', 'audio/mpeg'],
      ['audio/x-mp3', 'audio/mpeg'],
      ['audio/x-mpeg', 'audio/mpeg'],
      ['video/x-m4v', 'video/mp4'],
    ];
    for (const [alias, canonical] of cases) expect(normalizeMediaMime(alias), alias).toBe(canonical);
  });

  it('대소문자·앞뒤 공백·매개변수(;codecs=…)를 정리한다', () => {
    expect(normalizeMediaMime('Audio/MPEG')).toBe('audio/mpeg');
    expect(normalizeMediaMime('  VIDEO/QuickTime  ')).toBe('video/quicktime');
    expect(normalizeMediaMime('audio/mp4;codecs=mp4a.40.2')).toBe('audio/mp4');
    expect(normalizeMediaMime('audio/webm; codecs="opus"')).toBe('audio/webm');
    expect(normalizeMediaMime('Audio/X-M4A; codecs="mp4a.40.2"')).toBe('audio/mp4');
    expect(normalizeMediaMime(' AUDIO/WAVE ; codec=1')).toBe('audio/wav');
    expect(normalizeMediaMime('video/webm;codecs=vp8,opus')).toBe('video/webm');
  });

  it('형식이 비어 있거나 application/octet-stream 이면 확장자(MEDIA_EXT 역방향)로 추정한다', () => {
    const cases: Array<[string, string]> = [
      ['memo.m4a', 'audio/mp4'],
      ['voice.MP3', 'audio/mpeg'],
      ['take.wav', 'audio/wav'],
      ['rec.weba', 'audio/webm'],
      ['clip.webm', 'video/webm'],
      ['clip.mp4', 'video/mp4'],
      ['IMG_0001.MOV', 'video/quicktime'],
      ['my.voice.memo.m4a', 'audio/mp4'],
      ['  spaced.m4a  ', 'audio/mp4'],
    ];
    for (const [name, canonical] of cases) {
      expect(normalizeMediaMime('', name), `'' ${name}`).toBe(canonical);
      expect(normalizeMediaMime('   ', name), `blank ${name}`).toBe(canonical);
      expect(normalizeMediaMime(undefined, name), `undefined ${name}`).toBe(canonical);
      expect(normalizeMediaMime(null, name), `null ${name}`).toBe(canonical);
      expect(normalizeMediaMime('application/octet-stream', name), `octet ${name}`).toBe(canonical);
      expect(normalizeMediaMime('Application/Octet-Stream; x=1', name), `octet params ${name}`).toBe(canonical);
    }
    // 모든 MEDIA_EXT 확장자가 자기 정본으로 돌아온다
    for (const m of ALLOWED_MEDIA_MIME) expect(normalizeMediaMime('', `f.${MEDIA_EXT[m]}`), m).toBe(m);
  });

  it('빈 형식인데 확장자가 없거나 목록 밖이면 null', () => {
    for (const name of [undefined, null, '', 'noext', 'mp3', 'file.', 'a.aac', 'a.ogg', 'a.flac', 'a.mkv', 'a.txt', 'a.png', 'a.mp3.exe']) {
      expect(normalizeMediaMime('', name), String(name)).toBeNull();
      expect(normalizeMediaMime('application/octet-stream', name), `octet ${String(name)}`).toBeNull();
    }
  });

  it('허용 목록 밖의 신고 형식은 null — 확장자로 덮어쓰지 않는다', () => {
    const disallowed = [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'text/plain',
      'audio/aac',
      'audio/x-aac',
      'audio/ogg',
      'audio/flac',
      'audio/x-flac',
      'audio/mp4a-latm',
      'video/x-matroska',
      'video/ogg',
      'video/x-msvideo',
      'audio/*',
      'audio',
      'x-m4a',
      'audio/x-m4a2',
      'audio/x-m4a-extra',
      'audio /mp4',
    ];
    for (const t of disallowed) {
      expect(normalizeMediaMime(t), t).toBeNull();
      expect(normalizeMediaMime(t, 'x.mp3'), `${t} + x.mp3`).toBeNull();
      expect(normalizeMediaMime(t, 'x.m4a'), `${t} + x.m4a`).toBeNull();
    }
  });

  it('Object.prototype 이름으로 형식·확장자를 만들 수 없다', () => {
    for (const t of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(normalizeMediaMime(t), t).toBeNull();
      expect(normalizeMediaMime('', `x.${t}`), `ext ${t}`).toBeNull();
    }
  });

  it('결과는 항상 허용 목록 안의 정본이거나 null', () => {
    const inputs = ['audio/x-m4a', 'audio/mp3', 'AUDIO/WAVE;x=y', '', 'application/octet-stream', 'image/png', 'video/x-m4v'];
    for (const t of inputs) {
      for (const name of ['a.m4a', 'a.mov', 'a.bin', undefined]) {
        const r = normalizeMediaMime(t, name);
        if (r !== null) expect(ALLOWED_MEDIA_MIME as readonly string[], `${t} ${String(name)}`).toContain(r);
      }
    }
  });

  it('./upload(→ @cs/domain) 와 같은 함수·목록을 다시 내보낸다', () => {
    expect(viaUpload.normalizeMediaMime).toBe(normalizeMediaMime);
    expect(viaUpload.ALLOWED_MEDIA_MIME).toBe(ALLOWED_MEDIA_MIME);
    expect(viaUpload.MEDIA_EXT).toBe(MEDIA_EXT);
  });

  it('브라우저에서 쓸 수 있게 의존성이 없고(@cs/domain/media-mime), package.json 에 그 경로가 있다', () => {
    const src = readFileSync(path.join(here, 'media-mime.ts'), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/from\s+['"]/);
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports['./media-mime']).toBe('./src/media-mime.ts');
  });
});
