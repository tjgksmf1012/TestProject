/**
 * 마이크 캡처 설정과 검증.
 *
 * docs/04-회의-처리-파이프라인.md §2
 *
 * ## 브라우저 오디오 처리를 전부 꺼야 하는 이유
 *
 * 보통의 웹 녹음은 `echoCancellation`, `noiseSuppression`, `autoGainControl` 을
 * 켠다. 통화용으로는 맞다. **멀티트랙에서는 정반대다.**
 *
 * 백엔드가 하는 두 가지 일이 전부 "가공되지 않은 신호"를 전제한다:
 *
 *   1. **GCC-PHAT 시간 정렬** — 트랙 간 정렬은 *새어 들어온 옆사람 목소리*로
 *      맞춘다 (`audio/multitrack.estimate_offsets`). 잡음 억제가 그 누출을
 *      지워버리면 정렬할 근거 자체가 사라진다. 켜두면 정렬이 실패한다.
 *
 *   2. **에너지 기반 주화자 판정** — "이 프레임에서 가장 큰 트랙의 주인이
 *      말한 사람"이라는 비교다 (`audio/multitrack.suppress_crosstalk`).
 *      AGC 는 조용한 트랙의 게인을 자동으로 올린다. 듣고만 있던 사람의
 *      트랙이 증폭되면 그 사람이 말한 것으로 잡힌다.
 *
 * AGC 하나 때문에 조용한 팀원의 기여도가 부풀려진다. 그건 버그가 아니라
 * 팀 갈등이다 (docs/05 §5).
 *
 * ## 그런데 끄라고 해도 안 꺼진다
 *
 * `getUserMedia` 의 제약은 **맨값이면 `ideal` 로 취급된다** — min/max/exact 만
 * 강제고 나머지는 요청일 뿐이다. 브라우저는 거절 대신 조용히 무시할 수 있다.
 * 그래서 요청한 뒤 `track.getSettings()` 로 **실제로 꺼졌는지 확인**하고,
 * 안 꺼졌으면 그 사실을 트랙 메타데이터로 서버에 올린다. 백엔드는 그 트랙의
 * 신뢰도를 낮춘다 — 모르고 쓰는 것보다 알고 낮추는 게 낫다.
 *
 * `exact: false` 로 강제하지 않는 이유는, 못 끄는 기기에서 녹음이 아예
 * 시작되지 않기 때문이다. 아이폰을 가진 팀원을 배제하는 것보다 낫다.
 */

/**
 * 코덱 선호 순서.
 *
 * Opus 는 32kbps 에서도 음성이 충분히 살아 ASR 에 문제가 없고, 파일이 작아
 * 모바일 회선으로 올리기 좋다. Safari 는 Opus 녹음을 지원하지 않으므로
 * `audio/mp4`(AAC) 로 떨어진다 — 아이폰 팀원을 버릴 수는 없다.
 */
export const PREFERRED_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4', // Safari (AAC)
  'audio/mpeg',
] as const;

/**
 * 지원되는 첫 번째 형식을 고른다.
 *
 * @param isSupported 보통 `MediaRecorder.isTypeSupported`
 * @returns 형식 문자열. 하나도 안 되면 null — 브라우저 기본값을 쓰라는 뜻이다.
 */
export function pickMimeType(isSupported: (type: string) => boolean): string | null {
  for (const type of PREFERRED_MIME_TYPES) {
    if (isSupported(type)) return type;
  }
  return null;
}

/** 멀티트랙 녹음용 오디오 제약. 브라우저 가공을 전부 요청 해제한다. */
export const MULTITRACK_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 16_000,
} as const;

/**
 * Opus 기준 권장 비트레이트.
 *
 * 음성 전용이면 32kbps 로 충분하다. 1시간 × 5명 = 72MB.
 * 로컬 파일시스템에 보관하므로 (docs/11 §2) 스토리지 비용은 0원이다.
 */
export const RECOMMENDED_BITS_PER_SECOND = 32_000;

/**
 * `MediaRecorder.start(timeslice)` 기본값.
 *
 * 짧게 잡으면 브라우저가 죽어도 잃는 양이 적고, 길게 잡으면 요청 수가 준다.
 * 5초면 청크 하나가 20KB — 모바일 회선에서 한 번에 보내기 좋은 크기다.
 */
export const DEFAULT_TIMESLICE_MS = 5_000;

export type WarningSeverity = 'critical' | 'warning' | 'info';

export interface CaptureWarning {
  setting: string;
  severity: WarningSeverity;
  message: string;
}

/** `track.getSettings()` 가 돌려주는 것 중 우리가 보는 항목만. */
export interface AppliedAudioSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  channelCount?: number;
  sampleRate?: number;
}

/**
 * 요청한 제약이 실제로 적용됐는지 확인한다.
 *
 * 반환된 경고는 트랙 메타데이터로 서버에 올라가고, 백엔드가 해당 트랙의
 * 주화자 판정 신뢰도를 낮추는 근거가 된다. 조용히 넘어가지 않는 게 핵심이다.
 */
export function checkAppliedSettings(settings: AppliedAudioSettings): CaptureWarning[] {
  const warnings: CaptureWarning[] = [];

  if (settings.autoGainControl) {
    warnings.push({
      setting: 'autoGainControl',
      severity: 'critical',
      message:
        '자동 게인 조절이 꺼지지 않았습니다. 조용한 트랙이 증폭되어 ' +
        '말하지 않은 사람이 말한 것으로 잡힐 수 있습니다',
    });
  }

  if (settings.noiseSuppression) {
    warnings.push({
      setting: 'noiseSuppression',
      severity: 'critical',
      message:
        '잡음 억제가 꺼지지 않았습니다. 트랙 간 정렬(GCC-PHAT)은 새어 들어온 ' +
        '옆사람 목소리로 맞추는데, 그게 지워지면 정렬이 실패합니다',
    });
  }

  if (settings.echoCancellation) {
    warnings.push({
      setting: 'echoCancellation',
      severity: 'warning',
      message:
        '에코 제거가 꺼지지 않았습니다. 대면 회의에는 기준 신호가 없어 ' +
        '예측하기 어렵게 동작합니다',
    });
  }

  if (settings.sampleRate !== undefined && settings.sampleRate < 16_000) {
    warnings.push({
      setting: 'sampleRate',
      severity: 'critical',
      message: `샘플레이트가 ${settings.sampleRate}Hz 입니다. 음성 인식에는 16kHz 이상이 필요합니다`,
    });
  }

  if (settings.channelCount !== undefined && settings.channelCount > 1) {
    warnings.push({
      setting: 'channelCount',
      severity: 'info',
      message: `${settings.channelCount}채널로 녹음됩니다. 서버에서 모노로 합칩니다`,
    });
  }

  return warnings;
}

/**
 * 우리가 **보는** 항목과 사람이 읽을 이름.
 *
 * `checkAppliedSettings` 가 이 넷을 봅니다. 목록이 여기 한 벌로 있어야
 * 「무엇을 못 쟀는가」를 셀 수 있습니다.
 */
export const CHECKED_SETTINGS: { key: keyof AppliedAudioSettings; name: string }[] = [
  { key: 'autoGainControl', name: '자동 게인' },
  { key: 'noiseSuppression', name: '잡음 억제' },
  { key: 'echoCancellation', name: '에코 제거' },
  { key: 'sampleRate', name: '샘플레이트' },
];

export interface CaptureNote {
  /** `gap` = 못 잼(흙빛). `ok` = 재 봤고 문제없음(초록). */
  tone: 'ok' | 'gap';
  text: string;
}

/**
 * 캡처 설정에 대해 화면이 **말해도 되는 것**.
 *
 * ## ⛔ 이 함수가 생긴 이유 (결함 249)
 *
 * 녹음 화면의 ③ 칸은 경고 목록이 비면 초록으로 이렇게 적었습니다:
 *
 *     캡처 설정이 요청대로 적용됐습니다
 *
 * 그런데 경고 목록은 `requestMicrophone()` 이 **성공한 뒤에야** 채워집니다.
 * 마이크를 아직 안 눌렀거나 **거부당했으면** 목록은 그냥 빈 채로 남습니다.
 * 재 봤습니다 — `getUserMedia` 를 거부시키고 화면을 열었더니, 아무것도 안
 * 쟀는데 초록 글씨로 「요청대로 적용됐습니다」가 떠 있었습니다.
 *
 * **못 잰 것을 만점으로 읽은 것**입니다 — 불변식 ③ 과 같은 자리입니다.
 * 게다가 이 칸은 녹음의 품질을 사람이 미리 확인하라고 만든 칸이라, 거짓
 * 초록은 「확인했다」는 착각까지 같이 줍니다.
 *
 * ⚠️ 얼굴이 하나 더 있습니다. 브라우저가 `getSettings()` 에서 항목을
 * **빼고 줄 수도** 있습니다(Firefox·Safari 는 항목이 고르지 않습니다).
 * 그러면 `checkAppliedSettings` 는 `undefined` 를 그냥 지나치므로 경고가
 * 0건이고, 화면은 또 초록이 됩니다. **안 온 값은 좋은 값이 아닙니다.**
 */
export function describeCaptureCheck(
  settings: AppliedAudioSettings | null,
  warnings: readonly CaptureWarning[],
): CaptureNote | null {
  // 문제가 있으면 그 목록이 대신 섭니다 — 여기서 겹쳐 말하지 않습니다.
  if (warnings.length > 0) return null;
  if (settings === null) {
    return { tone: 'gap', text: '캡처 설정은 아직 못 쟀습니다 — 마이크를 허용하면 잽니다' };
  }
  const unread = CHECKED_SETTINGS.filter((c) => settings[c.key] === undefined);
  if (unread.length > 0) {
    return {
      tone: 'gap',
      // 조사를 피해 적습니다 — 마지막 항목이 무엇이냐에 따라 은/는 이 갈립니다.
      text: `이 브라우저가 값을 안 준 항목이 있습니다 — ${unread
        .map((c) => c.name)
        .join(' · ')}. 못 잰 것이지 괜찮은 것이 아닙니다`,
    };
  }
  return { tone: 'ok', text: '캡처 설정이 요청대로 적용됐습니다' };
}

/**
 * 이 트랙을 그대로 써도 되는가.
 *
 * critical 이 있어도 **막지는 않는다.** 아이폰에서 AGC 가 안 꺼지는 건 흔한
 * 일이고, 그 사람만 회의에서 빼는 건 말이 안 된다. 대신 신뢰도를 낮춘다.
 */
export function captureConfidence(warnings: readonly CaptureWarning[]): number {
  const penalty = warnings.reduce((acc, w) => {
    if (w.severity === 'critical') return acc + 0.3;
    if (w.severity === 'warning') return acc + 0.1;
    return acc;
  }, 0);
  return Math.max(0.2, 1 - penalty);
}

/** 회의 하나가 차지할 용량(바이트). docs/11 비용 계산의 근거. */
export function estimateSessionBytes({
  durationMs,
  trackCount,
  bitsPerSecond = RECOMMENDED_BITS_PER_SECOND,
}: {
  durationMs: number;
  trackCount: number;
  bitsPerSecond?: number;
}): number {
  return Math.round((durationMs / 1000) * (bitsPerSecond / 8) * trackCount);
}

/** 청크 하나의 예상 크기. 업로드 큐 백프레셔 한도를 잡을 때 쓴다. */
export function estimateChunkBytes({
  timesliceMs = DEFAULT_TIMESLICE_MS,
  bitsPerSecond = RECOMMENDED_BITS_PER_SECOND,
}: { timesliceMs?: number; bitsPerSecond?: number } = {}): number {
  return Math.round((timesliceMs / 1000) * (bitsPerSecond / 8));
}
