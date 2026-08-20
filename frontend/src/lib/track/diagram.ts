/**
 * 운행도표 — 구멍이 **언제** 생겼는지 그린다.
 *
 * `bar.ts` 의 비율 막대는 "42% 가 비었다" 까지만 말합니다. 여기는
 * **어디가** 비었는지 말합니다. 그 둘의 차이가 이 화면의 값어치입니다.
 *
 *     비율 막대   박지원 42%              → 확인해야 할 것: 그 사람
 *     운행도표    12분~19분이 비었다      → 확인해야 할 것: 그 시각
 *
 * 회의 중이면 지금 폰을 보면 되고, 끝난 뒤면 어느 결정이 그 구간에
 * 있었는지 되짚을 수 있습니다.
 *
 * 근거는 Marey 의 1885년 열차 운행도표입니다 — 시간축 위의 평행선,
 * 그리고 **빈 곳이 정보**라는 발상 (docs/16).
 *
 * ## ⚠️ 여기가 거짓말이 생길 수 있는 지점이다
 *
 * 서버는 구멍을 **트랙 자기 시작 시각 기준**의 밀리초로 줍니다.
 * 그런데 사람마다 녹음을 시작한 시각이 다릅니다. 그대로 그리면
 * 나중에 들어온 사람의 구멍이 **회의 앞쪽**에 찍힙니다.
 *
 * 그래서 회의 전체를 축으로 잡고 각 트랙의 시작 오프셋을 더합니다.
 * 축이 틀리면 "그 결정이 나올 때 이 사람 녹음이 끊겨 있었다" 가
 * 통째로 거짓이 됩니다.
 */

/** 서버의 `gaps[]` 한 줄. 트랙 자기 시작 기준 밀리초. */
export interface Gap {
  reason?: string;
  startMs: number;
  endMs: number;
}

/** 한 사람의 트랙. `startedAt`·`endedAt` 은 ISO 문자열. */
export interface TrackInput {
  userId: number;
  startedAt: string | null;
  endedAt: string | null;
  gaps: readonly Gap[];
}

/** 그릴 한 칸. `left`·`width` 는 회의 전체에 대한 백분율. */
export interface Span {
  left: number;
  width: number;
  reason: string;
}

export interface Diagram {
  /** 회의 전체 길이(ms). 0 이면 그릴 수 없다. */
  durationMs: number;
  /** 사람별 구멍. 키는 userId. */
  gaps: Map<number, Span[]>;
}

const at = (iso: string | null): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * 회의 전체의 시간축을 정한다.
 *
 * 가장 먼저 시작한 트랙부터 가장 늦게 끝난 트랙까지입니다. 회의
 * `started_at` 을 쓰지 않는 이유: 회의를 열어 두고 한참 뒤에 녹음을
 * 시작하는 일이 흔한데, 그러면 축 앞쪽이 통째로 빈 채로 그려지고
 * **모두가 녹음을 안 한 것처럼** 보입니다.
 */
export function meetingWindow(
  tracks: readonly TrackInput[],
): { startMs: number; endMs: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const t of tracks) {
    const s = at(t.startedAt);
    if (s === null) continue;
    starts.push(s);
    // 아직 녹음 중이면 끝을 모릅니다. 그 트랙은 창을 넓히지 않습니다 —
    // "지금" 을 끝으로 잡으면 화면을 볼 때마다 축이 움직입니다.
    const e = at(t.endedAt);
    if (e !== null && e > s) ends.push(e);
  }
  if (starts.length === 0 || ends.length === 0) return null;
  const startMs = Math.min(...starts);
  const endMs = Math.max(...ends);
  return endMs > startMs ? { startMs, endMs } : null;
}

/**
 * 트랙들을 회의 축 위의 백분율로 옮긴다.
 *
 * 창을 못 정하면 **빈 도표**를 돌려줍니다. 축 없이 그리면 위치가
 * 거짓이 되고, 거짓 위치는 안 그리는 것보다 나쁩니다.
 */
export function buildDiagram(tracks: readonly TrackInput[]): Diagram {
  const window = meetingWindow(tracks);
  if (window === null) return { durationMs: 0, gaps: new Map() };

  const total = window.endMs - window.startMs;
  const gaps = new Map<number, Span[]>();

  for (const track of tracks) {
    const trackStart = at(track.startedAt);
    if (trackStart === null) continue;
    // ⚠️ 트랙 자기 기준 → 회의 기준. 이 한 줄이 축을 맞춥니다.
    const offset = trackStart - window.startMs;

    const spans: Span[] = [];
    for (const gap of track.gaps ?? []) {
      const from = offset + gap.startMs;
      const to = offset + gap.endMs;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;

      const left = (Math.max(from, 0) / total) * 100;
      const right = (Math.min(to, total) / total) * 100;
      if (right <= 0 || left >= 100) continue; // 창 밖

      spans.push({
        left,
        // 아주 짧은 구멍도 보여야 합니다 — 1초 끊긴 것과 안 끊긴 것은
        // 다릅니다. 다만 최소 폭을 주면 **길이가 과장**되므로 아주
        // 작게만 줍니다.
        width: Math.max(right - left, 0.4),
        reason: gap.reason ?? 'unknown',
      });
    }
    if (spans.length > 0) gaps.set(track.userId, spans);
  }

  return { durationMs: total, gaps };
}

/**
 * 1분보다 짧은 회의는 **초로** 말한다 (결함 242).
 *
 * 눈금이 분 하나뿐이라, 베타 참가자가 제일 먼저 하는 **30초짜리 시험
 * 녹음**에서 축이 통째로 이랬습니다:
 *
 *     0분  0  0  0  0  0  0분
 *
 * 등간격 거짓말은 아니지만(비율은 맞습니다) 아무것도 안 말합니다.
 * 그리고 「0분」이 여섯 개 서 있으면 사람은 **고장 났다**고 읽습니다.
 */
const SHORT_MEETING_MS = 60_000;

/** 축에 찍을 눈금 문구. 회의 길이에 따라 단위와 간격을 고른다. */
export function axisTicks(durationMs: number, count = 6): string[] {
  if (durationMs <= 0) return [];
  const short = durationMs < SHORT_MEETING_MS;
  const unit = short ? '초' : '분';
  const total = durationMs / (short ? 1_000 : 60_000);
  return Array.from({ length: count + 1 }, (_, i) => {
    const value = Math.round((total * i) / count);
    return i === 0 ? `0${unit}` : i === count ? `${value}${unit}` : String(value);
  });
}

/**
 * 구멍 하나를 사람의 말로. 툴팁에 씁니다.
 *
 * 원인을 그대로 보여주지 않습니다 — `recorder_stalled` 는 우리 용어이고
 * 사람이 할 일을 말해 주지 않습니다 (지시서 §8 시스템 용어 금지).
 */
const REASON_TEXT: Record<string, string> = {
  recorder_stalled: '녹음이 멈춰 있었습니다 — 화면이 꺼졌거나 앱이 내려갔습니다',
  chunk_lost: '조각이 서버에 도착하지 않았습니다',
  track_muted: '마이크가 꺼져 있었습니다',
};

export function describeGap(span: Span, durationMs: number): string {
  // 축과 **같은 단위**로 말합니다 (결함 242). 짧은 회의에서 「0분쯤」은
  // 구멍이 어디인지 하나도 안 알려 줍니다.
  const short = durationMs < SHORT_MEETING_MS;
  const unit = short ? '초' : '분';
  const per = short ? 1_000 : 60_000;
  const from = Math.round(((span.left / 100) * durationMs) / per);
  const to = Math.round((((span.left + span.width) / 100) * durationMs) / per);
  const when = from === to ? `${from}${unit}쯤` : `${from}~${to}${unit}`;
  const why = REASON_TEXT[span.reason] ?? '녹음이 끊겼습니다';
  return `${when} · ${why}`;
}
