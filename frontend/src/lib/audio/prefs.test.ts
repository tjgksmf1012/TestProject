import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AUDIO_PREFS_KEY,
  defaultAudioPrefs,
  parseAudioPrefs,
  scaleMicLevel,
} from './prefs.ts';

describe('audio/prefs', () => {
  it('기본 설정과 저장소 키를 제공한다', () => {
    strictEqual(AUDIO_PREFS_KEY, 'tf_audio_prefs_v1');
    deepStrictEqual(defaultAudioPrefs(), {
      inputDeviceId: 'default',
      echoCancellation: true,
      noiseSuppression: true,
      micGain: 100,
    });
  });

  it('손상된 JSON이나 비정상 게인 범위를 안전하게 기본값·경계값으로 복구한다', () => {
    deepStrictEqual(parseAudioPrefs(null), defaultAudioPrefs());
    deepStrictEqual(parseAudioPrefs('{invalid'), defaultAudioPrefs());
    deepStrictEqual(
      parseAudioPrefs(
        JSON.stringify({
          inputDeviceId: 'mic-1',
          echoCancellation: false,
          noiseSuppression: true,
          micGain: 999,
        }),
      ),
      {
        inputDeviceId: 'mic-1',
        echoCancellation: false,
        noiseSuppression: true,
        micGain: 150,
      },
    );
    strictEqual(parseAudioPrefs(JSON.stringify({ micGain: 10 })).micGain, 50);
  });

  it('시간축 샘플 배열과 게인으로 0~100 범위 마이크 입력 레벨을 계산한다', () => {
    strictEqual(scaleMicLevel([], 100), 0);
    strictEqual(scaleMicLevel(new Float32Array([0, 0, 0, 0]), 100), 0);
    strictEqual(scaleMicLevel(new Float32Array([0.1, -0.1, 0.1, -0.1]), 100), 30);
    strictEqual(scaleMicLevel(new Float32Array([1, 1]), 150), 100);
  });
});
