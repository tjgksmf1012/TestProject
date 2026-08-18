/**
 * 브라우저 어댑터 — 실제 Web API 를 `client.ts` 의 인터페이스에 끼운다.
 *
 * ⚠️ **이 파일은 이 저장소에서 검증되지 않았습니다.**
 * 브라우저가 없으면 실행할 수 없기 때문입니다. 그래서 여기에는 판단이
 * 들어가지 않습니다 — 시각을 계산하거나, seq 를 매기거나, 공백을 정하거나,
 * 녹음을 막는 규칙은 전부 순수 모듈에 있고 전부 테스트됩니다.
 * 이 파일이 하는 일은 **연결뿐**입니다. 얇게 유지하는 게 규칙입니다.
 *
 * 실기기 확인이 필요한 항목은 docs/09 §C 미검증 목록에 있습니다.
 */

import {
  MULTITRACK_AUDIO_CONSTRAINTS,
  pickMimeType,
  RECOMMENDED_BITS_PER_SECOND,
} from './capture.ts';
import type {
  AudioTrackHandle,
  MediaAdapter,
  RecorderHandle,
  SyncTransport,
} from './client.ts';
import type { AppliedAudioSettings } from './capture.ts';
import type { PendingChunk, UploadTransport } from './upload-queue.ts';

export class BrowserMediaAdapter implements MediaAdapter {
  isSecureContext(): boolean {
    // getUserMedia 는 HTTPS(또는 localhost)에서만 열린다.
    // 무료 HTTPS 는 Cloudflare Tunnel 로 얻는다 (docs/11 §3).
    return typeof window !== 'undefined' && window.isSecureContext;
  }

  async requestMicrophone(): Promise<AudioTrackHandle> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: MULTITRACK_AUDIO_CONSTRAINTS,
      video: false,
    });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('오디오 트랙을 찾을 수 없습니다');
    return new BrowserAudioTrack(stream, track);
  }

  createRecorder(track: AudioTrackHandle): RecorderHandle {
    if (!(track instanceof BrowserAudioTrack)) {
      throw new TypeError('BrowserMediaAdapter 는 BrowserAudioTrack 만 받습니다');
    }
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(track.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: RECOMMENDED_BITS_PER_SECOND,
    });
    return new BrowserRecorder(recorder);
  }
}

class BrowserAudioTrack implements AudioTrackHandle {
  readonly stream: MediaStream;
  #track: MediaStreamTrack;

  constructor(stream: MediaStream, track: MediaStreamTrack) {
    this.stream = stream;
    this.#track = track;
  }

  getSettings(): AppliedAudioSettings {
    return this.#track.getSettings() as AppliedAudioSettings;
  }

  onMuteChange(listener: (muted: boolean) => void): void {
    // iOS 에서 탭이 백그라운드로 가면 여기로 mute 가 들어온다.
    // 이게 timeline.ts 의 track_muted 공백이 된다.
    this.#track.addEventListener('mute', () => listener(true));
    this.#track.addEventListener('unmute', () => listener(false));
  }

  stop(): void {
    for (const t of this.stream.getTracks()) t.stop();
  }
}

class BrowserRecorder implements RecorderHandle {
  #recorder: MediaRecorder;

  constructor(recorder: MediaRecorder) {
    this.#recorder = recorder;
  }

  start(timesliceMs: number): void {
    this.#recorder.start(timesliceMs);
  }

  stop(): Promise<void> {
    // ⚠️ 마지막 조각은 stop() **뒤에** 옵니다 — `dataavailable` 가 먼저
    //    서고 'stop' 이벤트가 그 다음입니다. 그 순서를 약속으로 돌려줘야
    //    호출자가 큐를 닫기 전에 마지막 조각이 앉습니다 (결함 173).
    //    이미 inactive 면(두 번째 halt) 흘러나올 것이 없습니다.
    if (this.#recorder.state === 'inactive') return Promise.resolve();
    return new Promise((resolve) => {
      this.#recorder.addEventListener('stop', () => resolve(), { once: true });
      this.#recorder.stop();
    });
  }

  onData(listener: (data: { byteLength: number; payload: unknown }) => void): void {
    this.#recorder.addEventListener('dataavailable', (event) => {
      // 크기 0 짜리 청크가 올 수 있다. seq 를 낭비하면 타임라인이 어긋난다.
      if (event.data.size === 0) return;
      listener({ byteLength: event.data.size, payload: event.data });
    });
  }

  onError(listener: (error: Error) => void): void {
    this.#recorder.addEventListener('error', (event) => {
      const detail = (event as ErrorEvent).error;
      listener(detail instanceof Error ? detail : new Error('녹음 중 오류가 발생했습니다'));
    });
  }
}

/** `GET /api/time` (backend/teamflow/api/main.py) 를 친다. */
export class HttpSyncTransport implements SyncTransport {
  #baseUrl: string;

  constructor(baseUrl = '') {
    this.#baseUrl = baseUrl;
  }

  async probe(): Promise<{ t1: number; t2: number }> {
    const response = await fetch(`${this.#baseUrl}/api/time`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`시각 동기화 실패 (HTTP ${response.status})`);
    return (await response.json()) as { t1: number; t2: number };
  }
}

/** 청크 하나를 seq 주소로 올린다. 멱등이므로 재시도해도 안전하다. */
export class HttpUploadTransport implements UploadTransport {
  #trackUrl: string;
  #headers: Record<string, string>;

  constructor(trackUrl: string, headers: Record<string, string> = {}) {
    this.#trackUrl = trackUrl;
    this.#headers = headers;
  }

  /**
   * 트랙 주소를 나중에 정한다.
   *
   * 화면이 열릴 때는 아직 트랙이 없다 — 서버에 참가해야 track_id 가 나오고,
   * 그러려면 로그인이 먼저다. 생성자에서만 받으면 화면이 트랙 주소를
   * 스스로 지어내야 하는데, 그건 예전에 `?me=1` 로 신원을 지어내던 것과
   * 같은 종류의 실수다.
   */
  retarget(trackUrl: string): void {
    this.#trackUrl = trackUrl;
  }

  async send(chunk: PendingChunk): Promise<void> {
    const response = await fetch(`${this.#trackUrl}/chunks/${chunk.seq}`, {
      method: 'PUT', // PUT 이라서 같은 seq 를 두 번 올려도 덮어쓴다
      headers: {
        'Content-Type': 'application/octet-stream',
        // 서버가 요구한다. 이게 없으면 400 이다 — 공백을 절대 시각으로
        // 복원할 근거가 사라지기 때문이다 (backend api/main.py put_chunk).
        'X-Client-At-Ms': String(chunk.atMs),
        ...this.#headers,
      },
      body: chunk.payload as Blob,
      // 청크 업로드는 인증이 필요하다 — 서버가 **이 트랙이 내 트랙인가**를
      // 확인한다. 같은 오리진이면 기본값도 same-origin 이지만, 개발 중에
      // 다른 주소를 붙였을 때 조용히 401 이 나는 걸 막는다.
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`업로드 실패 (HTTP ${response.status})`);
  }
}

/**
 * 화면이 꺼지지 않게 잡아둔다.
 *
 * iOS Safari 는 화면이 잠기면 마이크를 정지시킨다. 이걸 막는 유일한 웹 수단이
 * Screen Wake Lock 이다. Safari 는 iOS 16.4 부터 지원하고, 설치형 PWA 에서
 * 제대로 동작한 건 iOS 18.4 부터다.
 *
 * **이건 보험이지 해결책이 아니다.** 사용자가 홈 버튼을 누르면 그대로 끊긴다.
 * 그래서 `timeline.buildTimeline` 의 공백 탐지가 여전히 필요하다.
 * 잠금 해제는 탭이 가려질 때 자동으로 풀리므로 돌아올 때 다시 잡아야 한다.
 */
export async function keepScreenAwake(): Promise<{ release: () => void }> {
  const anyNavigator = navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> };
  };
  if (!anyNavigator.wakeLock) {
    return { release: () => {} };
  }

  let sentinel: { release(): Promise<void> } | null = null;
  const acquire = async (): Promise<void> => {
    try {
      sentinel = await anyNavigator.wakeLock!.request('screen');
    } catch {
      // 배터리 부족 등으로 거절될 수 있다. 녹음을 막을 이유는 아니다.
      sentinel = null;
    }
  };

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void acquire();
  };

  await acquire();
  document.addEventListener('visibilitychange', onVisible);

  return {
    release: () => {
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release();
    },
  };
}
