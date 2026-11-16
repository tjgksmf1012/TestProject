export interface AudioPrefs {
  inputDeviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  micGain: number;
}

export const AUDIO_PREFS_KEY = 'tf_audio_prefs_v1';

function clampMicGain(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(150, Math.max(50, Math.round(value)));
}

export function defaultAudioPrefs(): AudioPrefs {
  return {
    inputDeviceId: 'default',
    echoCancellation: true,
    noiseSuppression: true,
    micGain: 100,
  };
}

export function parseAudioPrefs(raw: string | null): AudioPrefs {
  const base = defaultAudioPrefs();
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      inputDeviceId:
        typeof parsed.inputDeviceId === 'string' && parsed.inputDeviceId.trim()
          ? parsed.inputDeviceId
          : base.inputDeviceId,
      echoCancellation: parsed.echoCancellation !== false,
      noiseSuppression: parsed.noiseSuppression !== false,
      micGain: typeof parsed.micGain === 'number' ? clampMicGain(parsed.micGain) : base.micGain,
    };
  } catch {
    return base;
  }
}

export function scaleMicLevel(samples: ArrayLike<number>, micGain: number): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i] ?? 0;
    sumSq += sample * sample;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  const gain = clampMicGain(micGain) / 100;
  return Math.min(100, Math.max(0, Math.round(rms * 300 * gain)));
}
