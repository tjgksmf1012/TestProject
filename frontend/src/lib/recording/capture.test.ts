import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_TIMESLICE_MS,
  MULTITRACK_AUDIO_CONSTRAINTS,
  RECOMMENDED_BITS_PER_SECOND,
  captureConfidence,
  checkAppliedSettings,
  estimateChunkBytes,
  estimateSessionBytes,
  pickMimeType,
} from './capture.ts';

/** 브라우저별 `MediaRecorder.isTypeSupported` 흉내 */
function supports(...types: string[]): (t: string) => boolean {
  const set = new Set(types);
  return (t) => set.has(t);
}

describe('pickMimeType', () => {
  it('크롬/파이어폭스에서는 Opus 를 고른다', () => {
    const isSupported = supports('audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus');
    assert.equal(pickMimeType(isSupported), 'audio/webm;codecs=opus');
  });

  it('Safari 에서는 audio/mp4 로 떨어진다', () => {
    // Safari 는 Opus 녹음을 지원하지 않는다. 아이폰 팀원을 버릴 수는 없다.
    assert.equal(pickMimeType(supports('audio/mp4')), 'audio/mp4');
  });

  it('webm 컨테이너만 되면 코덱 지정 없이 쓴다', () => {
    assert.equal(pickMimeType(supports('audio/webm')), 'audio/webm');
  });

  it('아무것도 안 되면 null — 브라우저 기본값을 쓰라는 뜻이다', () => {
    assert.equal(pickMimeType(() => false), null);
  });
});

describe('MULTITRACK_AUDIO_CONSTRAINTS', () => {
  it('⭐ 브라우저 오디오 가공을 전부 끈다', () => {
    // 하나라도 켜지면 백엔드의 정렬·주화자 판정이 무너진다.
    assert.equal(MULTITRACK_AUDIO_CONSTRAINTS.echoCancellation, false);
    assert.equal(MULTITRACK_AUDIO_CONSTRAINTS.noiseSuppression, false);
    assert.equal(MULTITRACK_AUDIO_CONSTRAINTS.autoGainControl, false);
  });

  it('ASR 이 요구하는 16kHz 모노를 요청한다', () => {
    assert.equal(MULTITRACK_AUDIO_CONSTRAINTS.sampleRate, 16_000);
    assert.equal(MULTITRACK_AUDIO_CONSTRAINTS.channelCount, 1);
  });
});

describe('checkAppliedSettings', () => {
  it('요청대로 적용됐으면 경고가 없다', () => {
    assert.deepEqual(
      checkAppliedSettings({
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 16_000,
      }),
      [],
    );
  });

  it('⭐ AGC 가 안 꺼지면 critical — 조용한 사람의 기여도가 부풀려진다', () => {
    const warnings = checkAppliedSettings({ autoGainControl: true });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.severity, 'critical');
    assert.match(warnings[0]!.message, /증폭/);
  });

  it('⭐ 잡음 억제가 안 꺼지면 critical — 정렬 근거인 누출이 지워진다', () => {
    const warnings = checkAppliedSettings({ noiseSuppression: true });
    assert.equal(warnings[0]!.severity, 'critical');
    assert.match(warnings[0]!.message, /GCC-PHAT/);
  });

  it('에코 제거는 warning 에 그친다', () => {
    const warnings = checkAppliedSettings({ echoCancellation: true });
    assert.equal(warnings[0]!.severity, 'warning');
  });

  it('16kHz 미만이면 critical', () => {
    const warnings = checkAppliedSettings({ sampleRate: 8_000 });
    assert.equal(warnings[0]!.severity, 'critical');
    assert.match(warnings[0]!.message, /8000Hz/);
  });

  it('48kHz 는 문제없다 — 서버에서 내려 쓴다', () => {
    assert.deepEqual(checkAppliedSettings({ sampleRate: 48_000 }), []);
  });

  it('스테레오는 정보성 안내일 뿐이다', () => {
    const warnings = checkAppliedSettings({ channelCount: 2 });
    assert.equal(warnings[0]!.severity, 'info');
  });

  it('브라우저가 설정을 안 알려주면 아무 경고도 만들지 않는다', () => {
    // 추측으로 경고를 만들면 멀쩡한 트랙의 신뢰도가 깎인다.
    assert.deepEqual(checkAppliedSettings({}), []);
  });

  it('여러 개가 동시에 잡힐 수 있다', () => {
    const warnings = checkAppliedSettings({
      autoGainControl: true,
      noiseSuppression: true,
      echoCancellation: true,
    });
    assert.equal(warnings.length, 3);
  });
});

describe('captureConfidence', () => {
  it('경고가 없으면 1', () => {
    assert.equal(captureConfidence([]), 1);
  });

  it('critical 하나에 0.3 을 깎는다', () => {
    assert.equal(captureConfidence(checkAppliedSettings({ autoGainControl: true })), 0.7);
  });

  it('⭐ 최악이어도 0 이 아니다 — 아이폰 팀원을 배제하지 않는다', () => {
    const worst = captureConfidence(
      checkAppliedSettings({
        autoGainControl: true,
        noiseSuppression: true,
        echoCancellation: true,
        sampleRate: 8_000,
      }),
    );
    assert.equal(worst, 0.2);
    assert.ok(worst > 0, '녹음을 막는 대신 신뢰도만 낮춘다');
  });
});

describe('용량 추정', () => {
  it('1시간 5인 회의는 72MB', () => {
    const bytes = estimateSessionBytes({ durationMs: 3_600_000, trackCount: 5 });
    assert.equal(bytes, 72_000_000);
  });

  it('청크 하나는 20KB — 모바일 회선에서 한 번에 보내기 좋은 크기', () => {
    assert.equal(estimateChunkBytes(), 20_000);
  });

  it('기본값이 서로 맞물린다', () => {
    assert.equal(
      estimateChunkBytes({
        timesliceMs: DEFAULT_TIMESLICE_MS,
        bitsPerSecond: RECOMMENDED_BITS_PER_SECOND,
      }),
      estimateChunkBytes(),
    );
  });

  it('한 학기(주 1회 × 15주 × 5인 × 1시간)도 1GB 남짓이다', () => {
    // docs/11 비용 0원 구성의 근거. 로컬 디스크로 충분하다.
    const semester = estimateSessionBytes({ durationMs: 3_600_000, trackCount: 5 }) * 15;
    assert.equal(semester, 1_080_000_000);
    assert.ok(semester < 2 * 1024 ** 3);
  });
});
