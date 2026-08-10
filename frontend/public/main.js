// src/lib/recording/capture.ts
var PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
  // Safari (AAC)
  "audio/mpeg"
];
function pickMimeType(isSupported) {
  for (const type of PREFERRED_MIME_TYPES) {
    if (isSupported(type)) return type;
  }
  return null;
}
var MULTITRACK_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
  sampleRate: 16e3
};
var RECOMMENDED_BITS_PER_SECOND = 32e3;
var DEFAULT_TIMESLICE_MS = 5e3;
function checkAppliedSettings(settings) {
  const warnings = [];
  if (settings.autoGainControl) {
    warnings.push({
      setting: "autoGainControl",
      severity: "critical",
      message: "자동 게인 조절이 꺼지지 않았습니다. 조용한 트랙이 증폭되어 말하지 않은 사람이 말한 것으로 잡힐 수 있습니다"
    });
  }
  if (settings.noiseSuppression) {
    warnings.push({
      setting: "noiseSuppression",
      severity: "critical",
      message: "잡음 억제가 꺼지지 않았습니다. 트랙 간 정렬(GCC-PHAT)은 새어 들어온 옆사람 목소리로 맞추는데, 그게 지워지면 정렬이 실패합니다"
    });
  }
  if (settings.echoCancellation) {
    warnings.push({
      setting: "echoCancellation",
      severity: "warning",
      message: "에코 제거가 꺼지지 않았습니다. 대면 회의에는 기준 신호가 없어 예측하기 어렵게 동작합니다"
    });
  }
  if (settings.sampleRate !== void 0 && settings.sampleRate < 16e3) {
    warnings.push({
      setting: "sampleRate",
      severity: "critical",
      message: `샘플레이트가 ${settings.sampleRate}Hz 입니다. 음성 인식에는 16kHz 이상이 필요합니다`
    });
  }
  if (settings.channelCount !== void 0 && settings.channelCount > 1) {
    warnings.push({
      setting: "channelCount",
      severity: "info",
      message: `${settings.channelCount}채널로 녹음됩니다. 서버에서 모노로 합칩니다`
    });
  }
  return warnings;
}
function captureConfidence(warnings) {
  const penalty = warnings.reduce((acc, w) => {
    if (w.severity === "critical") return acc + 0.3;
    if (w.severity === "warning") return acc + 0.1;
    return acc;
  }, 0);
  return Math.max(0.2, 1 - penalty);
}

// src/lib/recording/browser-adapter.ts
var BrowserMediaAdapter = class {
  isSecureContext() {
    return typeof window !== "undefined" && window.isSecureContext;
  }
  async requestMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: MULTITRACK_AUDIO_CONSTRAINTS,
      video: false
    });
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error("오디오 트랙을 찾을 수 없습니다");
    return new BrowserAudioTrack(stream, track);
  }
  createRecorder(track) {
    if (!(track instanceof BrowserAudioTrack)) {
      throw new TypeError("BrowserMediaAdapter 는 BrowserAudioTrack 만 받습니다");
    }
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(track.stream, {
      ...mimeType ? { mimeType } : {},
      audioBitsPerSecond: RECOMMENDED_BITS_PER_SECOND
    });
    return new BrowserRecorder(recorder);
  }
};
var BrowserAudioTrack = class {
  stream;
  #track;
  constructor(stream, track) {
    this.stream = stream;
    this.#track = track;
  }
  getSettings() {
    return this.#track.getSettings();
  }
  onMuteChange(listener) {
    this.#track.addEventListener("mute", () => listener(true));
    this.#track.addEventListener("unmute", () => listener(false));
  }
  stop() {
    for (const t of this.stream.getTracks()) t.stop();
  }
};
var BrowserRecorder = class {
  #recorder;
  constructor(recorder) {
    this.#recorder = recorder;
  }
  start(timesliceMs) {
    this.#recorder.start(timesliceMs);
  }
  stop() {
    if (this.#recorder.state !== "inactive") this.#recorder.stop();
  }
  onData(listener) {
    this.#recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size === 0) return;
      listener({ byteLength: event.data.size, payload: event.data });
    });
  }
  onError(listener) {
    this.#recorder.addEventListener("error", (event) => {
      const detail = event.error;
      listener(detail instanceof Error ? detail : new Error("녹음 중 오류가 발생했습니다"));
    });
  }
};
var HttpSyncTransport = class {
  #baseUrl;
  constructor(baseUrl = "") {
    this.#baseUrl = baseUrl;
  }
  async probe() {
    const response = await fetch(`${this.#baseUrl}/api/time`, { cache: "no-store" });
    if (!response.ok) throw new Error(`시각 동기화 실패 (HTTP ${response.status})`);
    return await response.json();
  }
};
var HttpUploadTransport = class {
  #trackUrl;
  #headers;
  constructor(trackUrl2, headers = {}) {
    this.#trackUrl = trackUrl2;
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
  retarget(trackUrl2) {
    this.#trackUrl = trackUrl2;
  }
  async send(chunk) {
    const response = await fetch(`${this.#trackUrl}/chunks/${chunk.seq}`, {
      method: "PUT",
      // PUT 이라서 같은 seq 를 두 번 올려도 덮어쓴다
      headers: {
        "Content-Type": "application/octet-stream",
        // 서버가 요구한다. 이게 없으면 400 이다 — 공백을 절대 시각으로
        // 복원할 근거가 사라지기 때문이다 (backend api/main.py put_chunk).
        "X-Client-At-Ms": String(chunk.atMs),
        ...this.#headers
      },
      body: chunk.payload,
      // 청크 업로드는 인증이 필요하다 — 서버가 **이 트랙이 내 트랙인가**를
      // 확인한다. 같은 오리진이면 기본값도 same-origin 이지만, 개발 중에
      // 다른 주소를 붙였을 때 조용히 401 이 나는 걸 막는다.
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error(`업로드 실패 (HTTP ${response.status})`);
  }
};
async function keepScreenAwake() {
  const anyNavigator = navigator;
  if (!anyNavigator.wakeLock) {
    return { release: () => {
    } };
  }
  let sentinel = null;
  const acquire = async () => {
    try {
      sentinel = await anyNavigator.wakeLock.request("screen");
    } catch {
      sentinel = null;
    }
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") void acquire();
  };
  await acquire();
  document.addEventListener("visibilitychange", onVisible);
  return {
    release: () => {
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release();
    }
  };
}

// src/lib/recording/clock.ts
var SYNC_TOLERANCE_MS = 250;
var BEST_K = 3;
function estimateClock(samples) {
  const usable = samples.filter(isPlausible);
  if (usable.length === 0) {
    throw new Error("시각 동기화 표본이 없습니다 (전부 무효)");
  }
  const scored = usable.map((s) => ({
    offsetMs: (s.t1 - s.t0 + (s.t2 - s.t3)) / 2,
    roundTripMs: s.t3 - s.t0 - (s.t2 - s.t1),
    anchorMs: (s.t0 + s.t3) / 2
  })).sort((a, b) => a.roundTripMs - b.roundTripMs);
  const best = scored[0];
  const top = scored.slice(0, Math.min(BEST_K, scored.length));
  const offsets = top.map((s) => s.offsetMs);
  return {
    offsetMs: best.offsetMs,
    roundTripMs: best.roundTripMs,
    maxErrorMs: best.roundTripMs / 2,
    anchorMs: best.anchorMs,
    spreadMs: Math.max(...offsets) - Math.min(...offsets),
    sampleCount: usable.length
  };
}
function isPlausible(s) {
  const total = s.t3 - s.t0;
  const serverSide = s.t2 - s.t1;
  return Number.isFinite(s.t0) && Number.isFinite(s.t1) && Number.isFinite(s.t2) && Number.isFinite(s.t3) && total >= 0 && serverSide >= 0 && total - serverSide >= 0;
}
function checkSync(estimate, { toleranceMs = SYNC_TOLERANCE_MS } = {}) {
  if (estimate.maxErrorMs > toleranceMs) {
    return {
      ok: false,
      reason: `시각 오차 상한 ${estimate.maxErrorMs.toFixed(0)}ms가 허용치 ${toleranceMs}ms를 넘습니다 (네트워크가 느립니다)`
    };
  }
  if (estimate.spreadMs > toleranceMs) {
    return {
      ok: false,
      reason: `측정이 불안정합니다 (표본 간 편차 ${estimate.spreadMs.toFixed(0)}ms). 다시 시도해 주세요`
    };
  }
  return { ok: true, reason: `오차 상한 ±${estimate.maxErrorMs.toFixed(0)}ms` };
}
var ClockTracker = class {
  #monotonic;
  #estimates = [];
  constructor(monotonic) {
    this.#monotonic = monotonic;
  }
  /** 새 추정을 반영한다. anchor 순으로 정렬 상태를 유지한다. */
  push(estimate) {
    this.#estimates.push(estimate);
    this.#estimates.sort((a, b) => a.anchorMs - b.anchorMs);
  }
  get estimates() {
    return this.#estimates;
  }
  get synced() {
    return this.#estimates.length > 0;
  }
  /**
   * 인접한 두 측정 사이의 드리프트(ppm). 측정이 2개 미만이면 null.
   * |값| 이 200ppm 을 넘으면 시계가 아니라 측정이 잘못됐다고 보는 게 맞다.
   */
  driftPpm() {
    if (this.#estimates.length < 2) return null;
    const first = this.#estimates[0];
    const last = this.#estimates[this.#estimates.length - 1];
    const span = last.anchorMs - first.anchorMs;
    if (span <= 0) return null;
    return (last.offsetMs - first.offsetMs) / span * 1e6;
  }
  /** 단조 시각을 서버 epoch 시각으로 바꾼다. */
  toServerTime(monotonicMs) {
    return monotonicMs + this.#offsetAt(monotonicMs);
  }
  /** 지금 시각을 서버 epoch 기준으로. */
  now() {
    return this.toServerTime(this.#monotonic());
  }
  #offsetAt(monotonicMs) {
    const es = this.#estimates;
    if (es.length === 0) {
      throw new Error("시각 동기화 전입니다 — toServerTime 을 부를 수 없습니다");
    }
    if (es.length === 1 || monotonicMs <= es[0].anchorMs) {
      return es[0].offsetMs;
    }
    const last = es[es.length - 1];
    if (monotonicMs >= last.anchorMs) return last.offsetMs;
    for (let i = 1; i < es.length; i += 1) {
      const lo = es[i - 1];
      const hi = es[i];
      if (monotonicMs <= hi.anchorMs) {
        const t = (monotonicMs - lo.anchorMs) / (hi.anchorMs - lo.anchorMs);
        return lo.offsetMs + t * (hi.offsetMs - lo.offsetMs);
      }
    }
    return last.offsetMs;
  }
};

// src/lib/recording/session.ts
function initialState() {
  return {
    phase: "idle",
    secureContext: false,
    permission: "unknown",
    consent: "pending",
    clock: "unsynced",
    startedAtMs: null,
    endedAtMs: null,
    chunks: [],
    mutedIntervals: [],
    muteStartedAtMs: null,
    interruptions: 0,
    lostSeqs: [],
    stopReason: null,
    error: null
  };
}
function blockers(state) {
  const reasons = [];
  if (!state.secureContext) {
    reasons.push("HTTPS 연결이 필요합니다 (마이크는 보안 연결에서만 열립니다)");
  }
  if (state.permission === "denied") {
    reasons.push("마이크 권한이 거부됐습니다. 브라우저 설정에서 허용해 주세요");
  } else if (state.permission !== "granted") {
    reasons.push("마이크 권한을 아직 허용하지 않았습니다");
  }
  switch (state.consent) {
    case "refused":
      reasons.push("참여자가 녹음에 동의하지 않았습니다");
      break;
    case "self_granted":
      reasons.push("아직 동의하지 않은 참여자가 있습니다");
      break;
    case "pending":
      reasons.push("녹음 동의가 필요합니다");
      break;
    case "all_confirmed":
      break;
  }
  if (state.clock === "unsynced") {
    reasons.push("서버와 시각을 맞추는 중입니다");
  } else if (state.clock === "poor") {
    reasons.push("네트워크가 느려 시각 오차가 큽니다. 트랙 정렬이 실패할 수 있습니다");
  }
  return reasons;
}
function canStart(state) {
  return blockers(state).length === 0;
}
function reduce(state, event) {
  switch (event.type) {
    // 값이 그대로면 **같은 객체를 돌려준다.** 새 객체를 만들면 화면이
    // 아무 이유 없이 다시 그려지고, "바뀌었을 때만 알린다"가 성립하지 않는다.
    case "SECURE_CONTEXT":
      if (state.secureContext === event.secure) return state;
      return settle({ ...state, secureContext: event.secure });
    case "PERMISSION":
      if (state.permission === event.state) return state;
      return settle({ ...state, permission: event.state });
    case "CONSENT": {
      if (state.consent === event.state) return state;
      const next = settle({ ...state, consent: event.state });
      if (isLive(state.phase) && event.state === "refused") {
        return { ...next, phase: "stopping", stopReason: "consent_revoked" };
      }
      return next;
    }
    case "CLOCK":
      if (state.clock === event.state) return state;
      return settle({ ...state, clock: event.state });
    case "START": {
      if (state.phase !== "ready") return state;
      if (!canStart(state)) return state;
      return { ...state, phase: "recording", startedAtMs: event.atMs };
    }
    case "CHUNK": {
      if (!isLive(state.phase)) return state;
      if (state.chunks.some((c) => c.seq === event.chunk.seq)) return state;
      return { ...state, chunks: [...state.chunks, event.chunk] };
    }
    case "VISIBILITY": {
      if (!isLive(state.phase)) return state;
      if (event.hidden) {
        return { ...state, phase: "interrupted", interruptions: state.interruptions + 1 };
      }
      return { ...state, phase: "recording" };
    }
    case "TRACK_MUTE": {
      if (!isLive(state.phase)) return state;
      if (event.muted) {
        if (state.muteStartedAtMs !== null) return state;
        return { ...state, muteStartedAtMs: event.atMs };
      }
      if (state.muteStartedAtMs === null) return state;
      return {
        ...state,
        muteStartedAtMs: null,
        mutedIntervals: [
          ...state.mutedIntervals,
          { startMs: state.muteStartedAtMs, endMs: event.atMs }
        ]
      };
    }
    case "BACKPRESSURE": {
      if (!event.active || !isLive(state.phase)) return state;
      return { ...state, phase: "stopping", stopReason: "backpressure" };
    }
    case "STOP": {
      if (state.phase === "stopping") {
        return { ...state, endedAtMs: state.endedAtMs ?? event.atMs };
      }
      if (!isLive(state.phase)) return state;
      return {
        ...state,
        phase: "stopping",
        endedAtMs: event.atMs,
        stopReason: event.reason ?? "user",
        // 정지 시점에 mute 가 진행 중이었으면 거기서 끊어 닫는다
        ...closeOpenMute(state, event.atMs)
      };
    }
    case "UPLOAD_DONE": {
      if (state.phase !== "stopping") return state;
      return { ...state, phase: "completed", lostSeqs: [...event.lostSeqs] };
    }
    case "ERROR":
      return { ...state, phase: "failed", error: event.message, stopReason: "error" };
  }
}
function isLive(phase) {
  return phase === "recording" || phase === "interrupted";
}
function closeOpenMute(state, atMs) {
  if (state.muteStartedAtMs === null) {
    return { mutedIntervals: state.mutedIntervals, muteStartedAtMs: null };
  }
  return {
    mutedIntervals: [...state.mutedIntervals, { startMs: state.muteStartedAtMs, endMs: atMs }],
    muteStartedAtMs: null
  };
}
function settle(state) {
  if (state.phase !== "idle" && state.phase !== "ready") return state;
  return { ...state, phase: canStart(state) ? "ready" : "idle" };
}
function toTimelineInput(state) {
  if (state.startedAtMs === null || state.endedAtMs === null) {
    throw new Error("녹음이 시작·종료되지 않은 세션입니다");
  }
  return {
    chunks: state.chunks,
    startedAtMs: state.startedAtMs,
    endedAtMs: state.endedAtMs,
    mutedIntervals: state.mutedIntervals,
    lostSeqs: state.lostSeqs
  };
}

// src/lib/text/josa.ts
var PAIRS = {
  은는: ["은", "는"],
  이가: ["이", "가"],
  을를: ["을", "를"],
  과와: ["과", "와"],
  으로로: ["으로", "로"]
};
var DIGIT_HAS_FINAL = {
  "0": true,
  // 영
  "1": true,
  // 일
  "2": false,
  // 이
  "3": true,
  // 삼
  "4": false,
  // 사
  "5": false,
  // 오
  "6": true,
  // 육
  "7": true,
  // 칠
  "8": true,
  // 팔
  "9": false
  // 구
};
var LETTER_HAS_FINAL = {
  a: false,
  // 에이
  b: false,
  // 비
  c: false,
  // 씨
  d: false,
  // 디
  e: false,
  // 이
  f: true,
  // 에프
  g: false,
  // 지
  h: false,
  // 에이치
  i: false,
  // 아이
  j: false,
  // 제이
  k: false,
  // 케이
  l: true,
  // 엘
  m: true,
  // 엠
  n: true,
  // 엔
  o: false,
  // 오
  p: false,
  // 피
  q: false,
  // 큐
  r: true,
  // 알
  s: true,
  // 에스
  t: false,
  // 티
  u: false,
  // 유
  v: false,
  // 브이
  w: false,
  // 더블유
  x: true,
  // 엑스
  y: false,
  // 와이
  z: false
  // 지
};
function hasFinalConsonant(word) {
  const trimmed = word.trim();
  if (trimmed === "") return null;
  const last = trimmed[trimmed.length - 1];
  const code = last.codePointAt(0) ?? 0;
  if (code >= 44032 && code <= 55203) {
    return (code - 44032) % 28 !== 0;
  }
  if (last in DIGIT_HAS_FINAL) return DIGIT_HAS_FINAL[last];
  const lower = last.toLowerCase();
  if (lower in LETTER_HAS_FINAL) return LETTER_HAS_FINAL[lower];
  return null;
}
function josa(word, pair) {
  const [withFinal, withoutFinal] = PAIRS[pair];
  return hasFinalConsonant(word) === true ? withFinal : withoutFinal;
}
function withJosa(word, pair) {
  return `${word}${josa(word, pair)}`;
}

// src/lib/recording/timeline.ts
var DEFAULT_STALL_TOLERANCE_MS = 300;
var MIN_REPORTED_GAP_MS = 100;
function buildTimeline(chunks, options) {
  const {
    timesliceMs,
    startedAtMs,
    endedAtMs,
    lostSeqs = [],
    mutedIntervals = [],
    stallToleranceMs = DEFAULT_STALL_TOLERANCE_MS
  } = options;
  if (timesliceMs <= 0) throw new Error("timesliceMs 는 양수여야 합니다");
  if (endedAtMs < startedAtMs) throw new Error("종료 시각이 시작 시각보다 빠릅니다");
  const durationMs = endedAtMs - startedAtMs;
  const ordered = [...chunks].sort((a, b) => a.seq - b.seq);
  const lost = new Set(lostSeqs);
  const gaps = [];
  let prevAt = startedAtMs;
  let prevSeq = -1;
  for (const chunk of ordered) {
    const delta = chunk.atMs - prevAt;
    const stall = delta - timesliceMs;
    if (stall > stallToleranceMs) {
      pushGap(gaps, {
        startMs: prevAt,
        endMs: chunk.atMs - timesliceMs,
        reason: "recorder_stalled",
        afterSeq: prevSeq
      });
    }
    prevAt = chunk.atMs;
    prevSeq = chunk.seq;
  }
  if (endedAtMs - prevAt > stallToleranceMs) {
    pushGap(gaps, {
      startMs: prevAt,
      endMs: endedAtMs,
      reason: "recorder_stalled",
      afterSeq: prevSeq
    });
  }
  for (const chunk of ordered) {
    if (!lost.has(chunk.seq)) continue;
    pushGap(gaps, {
      startMs: Math.max(startedAtMs, chunk.atMs - timesliceMs),
      endMs: chunk.atMs,
      reason: "chunk_lost",
      afterSeq: chunk.seq - 1
    });
  }
  for (const muted of mutedIntervals) {
    pushGap(gaps, {
      startMs: Math.max(startedAtMs, muted.startMs),
      endMs: Math.min(endedAtMs, muted.endMs),
      reason: "track_muted",
      afterSeq: lastSeqBefore(ordered, muted.startMs)
    });
  }
  gaps.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const union = mergeIntervals(gaps);
  const totalGapMs = union.reduce((acc, g) => acc + (g.endMs - g.startMs), 0);
  const longestGapMs = gaps.reduce((acc, g) => Math.max(acc, g.durationMs), 0);
  return {
    startedAtMs,
    endedAtMs,
    durationMs,
    segments: segmentsFrom(ordered, union, startedAtMs, endedAtMs),
    gaps,
    totalGapMs,
    longestGapMs,
    coverage: durationMs > 0 ? Math.max(0, 1 - totalGapMs / durationMs) : 0,
    alignmentSafe: gaps.length === 0
  };
}
function pushGap(gaps, gap) {
  const durationMs = gap.endMs - gap.startMs;
  if (durationMs < MIN_REPORTED_GAP_MS) return;
  gaps.push({ ...gap, durationMs });
}
function lastSeqBefore(chunks, atMs) {
  let seq = -1;
  for (const chunk of chunks) {
    if (chunk.atMs > atMs) break;
    seq = chunk.seq;
  }
  return seq;
}
function mergeIntervals(intervals) {
  const sorted = [...intervals].filter((i) => i.endMs > i.startMs).sort((a, b) => a.startMs - b.startMs);
  const merged = [];
  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last && current.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, current.endMs);
    } else {
      merged.push({ startMs: current.startMs, endMs: current.endMs });
    }
  }
  return merged;
}
function segmentsFrom(chunks, gapUnion, startedAtMs, endedAtMs) {
  const segments = [];
  let cursor = startedAtMs;
  const close = (endMs) => {
    if (endMs <= cursor) return;
    segments.push({
      startMs: cursor,
      endMs,
      durationMs: endMs - cursor,
      fromSeq: firstSeqIn(chunks, cursor, endMs),
      toSeq: lastSeqIn(chunks, cursor, endMs)
    });
  };
  for (const gap of gapUnion) {
    close(Math.min(gap.startMs, endedAtMs));
    cursor = Math.max(cursor, gap.endMs);
  }
  close(endedAtMs);
  return segments;
}
function firstSeqIn(chunks, startMs, endMs) {
  for (const chunk of chunks) {
    if (chunk.atMs > startMs && chunk.atMs <= endMs) return chunk.seq;
  }
  return -1;
}
function lastSeqIn(chunks, startMs, endMs) {
  let seq = -1;
  for (const chunk of chunks) {
    if (chunk.atMs > startMs && chunk.atMs <= endMs) seq = chunk.seq;
  }
  return seq;
}
var REASON_LABEL = {
  recorder_stalled: "녹음 중단 (화면 잠금이나 앱 전환)",
  track_muted: "마이크 음소거",
  chunk_lost: "업로드 실패"
};
function describeTimeline(timeline) {
  if (timeline.gaps.length === 0) {
    return `녹음이 끊김 없이 완료됐습니다 (${formatDuration(timeline.durationMs)})`;
  }
  const reasons = new Set(timeline.gaps.map((g) => REASON_LABEL[g.reason]));
  return `${withJosa(formatDuration(timeline.totalGapMs), "이가")} 비었습니다 (${[...reasons].join(", ")}). 가장 긴 공백 ${formatDuration(timeline.longestGapMs)}, 커버리지 ${(timeline.coverage * 100).toFixed(1)}%`;
}
function formatDuration(ms) {
  const total = Math.round(ms / 1e3);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}
var MIN_USABLE_COVERAGE = 0.8;
function judgeTrack(timeline, { minCoverage = MIN_USABLE_COVERAGE } = {}) {
  if (timeline.coverage >= 1) {
    return { usable: true, confidence: 1, reason: "공백 없음" };
  }
  if (timeline.coverage < minCoverage) {
    return {
      usable: false,
      confidence: 0,
      reason: `커버리지 ${(timeline.coverage * 100).toFixed(0)}% — 이 트랙으로는 발화량을 판단할 수 없습니다. 사람이 확인해야 합니다`
    };
  }
  return {
    usable: true,
    confidence: timeline.coverage,
    reason: `공백 ${formatDuration(timeline.totalGapMs)} 만큼 신뢰도를 낮춥니다`
  };
}

// src/lib/recording/upload-queue.ts
var DEFAULTS = {
  concurrency: 2,
  maxAttempts: 6,
  baseDelayMs: 500,
  maxDelayMs: 3e4,
  maxPendingBytes: 64 * 1024 * 1024
};
function backoffDelay(attempt, { baseDelayMs = DEFAULTS.baseDelayMs, maxDelayMs = DEFAULTS.maxDelayMs, random = Math.random }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + 0.5 * random()));
}
var UploadQueue = class {
  #transport;
  #options;
  #pending = [];
  #processing = /* @__PURE__ */ new Set();
  #acked = /* @__PURE__ */ new Set();
  #failures = /* @__PURE__ */ new Map();
  #pendingBytes = 0;
  #totalAttempts = 0;
  #closed = false;
  #waiters = [];
  #workers = null;
  constructor(transport, options = {}) {
    this.#transport = transport;
    this.#options = {
      concurrency: options.concurrency ?? DEFAULTS.concurrency,
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? DEFAULTS.baseDelayMs,
      maxDelayMs: options.maxDelayMs ?? DEFAULTS.maxDelayMs,
      maxPendingBytes: options.maxPendingBytes ?? DEFAULTS.maxPendingBytes,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: options.random ?? Math.random,
      onAck: options.onAck,
      onGiveUp: options.onGiveUp,
      onRetry: options.onRetry
    };
  }
  get status() {
    return {
      pendingCount: this.#pending.length + this.#processing.size,
      pendingBytes: this.#pendingBytes,
      backpressure: this.#pendingBytes > this.#options.maxPendingBytes
    };
  }
  /**
   * 청크를 큐에 넣는다. **절대 거절하지 않는다.**
   *
   * 거절해서 버리는 대신 backpressure 를 켠다. 호출자(세션 상태 머신)가
   * 녹음을 멈추면 새 청크가 안 들어오고, 큐는 결국 빠진다.
   */
  enqueue(chunk) {
    if (this.#acked.has(chunk.seq) || this.#failures.has(chunk.seq)) return this.status;
    this.#pending.push({ chunk, attempts: 0 });
    this.#pendingBytes += chunk.byteLength;
    this.#notify();
    return this.status;
  }
  /**
   * 재연결 후 서버가 "이미 가진 seq" 를 알려줬을 때 호출한다.
   * 중복 업로드를 막는다 — 모바일 데이터를 아끼는 게 아니라, 재연결마다
   * 처음부터 다시 올리면 영영 못 따라잡기 때문이다.
   */
  resumeWith(serverHasSeqs) {
    const has = new Set(serverHasSeqs);
    this.#pending = this.#pending.filter((item) => {
      if (!has.has(item.chunk.seq)) return true;
      this.#pendingBytes -= item.chunk.byteLength;
      this.#acked.add(item.chunk.seq);
      return false;
    });
    for (const seq of has) this.#acked.add(seq);
  }
  start() {
    if (this.#workers) return;
    this.#workers = Array.from({ length: this.#options.concurrency }, () => this.#worker());
  }
  /** 더 이상 청크가 없다고 알리고, 남은 걸 전부 처리할 때까지 기다린다. */
  async finish() {
    this.start();
    this.#closed = true;
    this.#notify();
    await Promise.all(this.#workers);
    return {
      acked: [...this.#acked].sort((a, b) => a - b),
      lost: [...this.#failures.keys()].sort((a, b) => a - b),
      failures: new Map(this.#failures),
      totalAttempts: this.#totalAttempts
    };
  }
  async #worker() {
    for (; ; ) {
      const item = this.#pending.shift();
      if (item === void 0) {
        if (this.#closed && this.#processing.size === 0) return;
        if (this.#closed && this.#processing.size > 0) {
          await this.#waitForWork();
          continue;
        }
        await this.#waitForWork();
        continue;
      }
      await this.#attempt(item);
    }
  }
  async #attempt(item) {
    const { seq } = item.chunk;
    this.#processing.add(seq);
    try {
      item.attempts += 1;
      this.#totalAttempts += 1;
      await this.#transport.send(item.chunk);
      this.#acked.add(seq);
      this.#pendingBytes -= item.chunk.byteLength;
      this.#options.onAck?.(seq);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (item.attempts >= this.#options.maxAttempts) {
        this.#failures.set(seq, reason);
        this.#pendingBytes -= item.chunk.byteLength;
        this.#options.onGiveUp?.(seq, reason);
      } else {
        const delayMs = backoffDelay(item.attempts, this.#options);
        this.#options.onRetry?.(seq, item.attempts, delayMs);
        await this.#options.sleep(delayMs);
        this.#pending.push(item);
      }
    } finally {
      this.#processing.delete(seq);
      this.#notify();
    }
  }
  #waitForWork() {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  #notify() {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
};

// src/lib/recording/client.ts
var RecordingClient = class {
  #options;
  #timesliceMs;
  #clock;
  #queue;
  #state = initialState();
  #track = null;
  #recorder = null;
  #nextSeq = 0;
  #warnings = [];
  constructor(options) {
    this.#options = options;
    this.#timesliceMs = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
    this.#clock = new ClockTracker(options.monotonic);
    this.#queue = new UploadQueue(options.upload, options.uploadOptions);
    this.#state = reduce(this.#state, {
      type: "SECURE_CONTEXT",
      secure: options.media.isSecureContext()
    });
  }
  get state() {
    return this.#state;
  }
  get warnings() {
    return this.#warnings;
  }
  /**
   * 참여자 동의 상태는 서버가 판단한다. 클라이언트는 전달만 한다.
   *
   * 녹음 중에 철회가 들어오면 **그 자리에서 마이크를 끈다.** 상태만 바꾸고
   * 레코더를 살려두면 동의 없이 녹음이 계속된다 — 통신비밀보호법 문제다.
   */
  setConsent(state) {
    this.#dispatch({ type: "CONSENT", state });
    if (this.#state.stopReason === "consent_revoked" && this.#state.endedAtMs === null) {
      this.#halt();
    }
  }
  /** 탭 가시성 변화. iOS 에서는 이게 오디오 중단 신호일 수 있다. */
  setHidden(hidden) {
    this.#dispatch({ type: "VISIBILITY", hidden });
  }
  /**
   * 서버와 시각을 맞춘다.
   *
   * 녹음 시작 전에 한 번, 그리고 회의 중 5분마다 다시 부르는 걸 권장한다.
   * 기기 시계가 흐르기 때문이다 (clock.ts 의 드리프트 설명 참고).
   * 타이머는 여기 두지 않는다 — 화면 쪽에서 걸어야 테스트가 깨끗하다.
   */
  async syncClock() {
    const samples = [];
    const count = this.#options.syncSamples ?? 5;
    for (let i = 0; i < count; i += 1) {
      const t0 = this.#options.monotonic();
      const { t1, t2 } = await this.#options.sync.probe();
      samples.push({ t0, t1, t2, t3: this.#options.monotonic() });
    }
    try {
      const estimate = estimateClock(samples);
      this.#clock.push(estimate);
      this.#dispatch({ type: "CLOCK", state: checkSync(estimate).ok ? "ok" : "poor" });
    } catch {
      this.#dispatch({ type: "CLOCK", state: "unsynced" });
    }
  }
  /** 마이크 권한을 얻고, 실제로 적용된 설정을 확인한다. */
  async requestMicrophone() {
    try {
      const track = await this.#options.media.requestMicrophone();
      this.#track = track;
      this.#warnings = checkAppliedSettings(track.getSettings());
      track.onMuteChange((muted) => {
        if (!this.#clock.synced) return;
        this.#dispatch({ type: "TRACK_MUTE", muted, atMs: this.#clock.now() });
      });
      this.#dispatch({ type: "PERMISSION", state: "granted" });
    } catch {
      this.#dispatch({ type: "PERMISSION", state: "denied" });
    }
  }
  /**
   * 녹음을 시작한다.
   *
   * 사전 조건이 하나라도 안 맞으면 아무 일도 일어나지 않는다.
   * 판단은 전부 `session.blockers` 가 한다 — 여기 조건문을 복제하지 않는다.
   */
  start() {
    if (this.#state.phase !== "ready" || !this.#track) return false;
    const recorder = this.#options.media.createRecorder(this.#track);
    this.#recorder = recorder;
    recorder.onData((data) => this.#onData(data));
    recorder.onError((error) => this.#dispatch({ type: "ERROR", message: error.message }));
    this.#queue.start();
    const started = this.#dispatch({ type: "START", atMs: this.#clock.now() });
    recorder.start(this.#timesliceMs);
    return started.phase === "recording";
  }
  /**
   * 정지하고, 남은 청크를 전부 올린 뒤, 트랙 판정까지 만들어 돌려준다.
   *
   * @throws 녹음을 시작한 적이 없으면
   */
  async stop() {
    if (this.#state.startedAtMs === null) {
      throw new Error("녹음을 시작한 적이 없습니다");
    }
    this.#halt();
    const result = await this.#queue.finish();
    this.#dispatch({ type: "UPLOAD_DONE", lostSeqs: result.lost });
    const timeline = buildTimeline(this.#state.chunks, {
      ...toTimelineInput(this.#state),
      timesliceMs: this.#timesliceMs
    });
    return {
      state: this.#state,
      timeline,
      verdict: judgeTrack(timeline),
      captureConfidence: captureConfidence(this.#warnings),
      warnings: [...this.#warnings],
      timesliceMs: this.#timesliceMs
    };
  }
  #onData(data) {
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    const chunk = { seq, atMs: this.#clock.now(), byteLength: data.byteLength };
    this.#dispatch({ type: "CHUNK", chunk });
    const status = this.#queue.enqueue({
      seq,
      atMs: chunk.atMs,
      byteLength: data.byteLength,
      payload: data.payload
    });
    if (status.backpressure) {
      this.#dispatch({ type: "BACKPRESSURE", active: true });
      this.#halt();
    }
  }
  /** 마이크를 끄고 종료 시각을 찍는다. 여러 경로에서 불려도 한 번만 먹는다. */
  #halt() {
    this.#recorder?.stop();
    this.#track?.stop();
    this.#dispatch({ type: "STOP", atMs: this.#clock.now() });
  }
  /** 이벤트를 적용하고 **새 상태를 돌려준다.** 호출자가 다시 읽지 않게 하려는 것이다. */
  #dispatch(event) {
    const next = reduce(this.#state, event);
    if (next === this.#state) return next;
    this.#state = next;
    this.#options.onStateChange?.(next);
    return next;
  }
};

// src/lib/recording/complete.ts
function isoOf(serverTimeMs) {
  return new Date(serverTimeMs).toISOString();
}
function gapOf(gap) {
  return {
    reason: gap.reason,
    start_ms: gap.startMs,
    end_ms: gap.endMs,
    duration_ms: gap.durationMs,
    after_seq: gap.afterSeq
  };
}
function completeBody(input) {
  const { timeline } = input;
  return {
    ended_at: isoOf(timeline.endedAtMs),
    // 서버가 0~1 을 요구한다. 계산 오차로 1 을 아주 조금 넘으면 422 가
    // 나는데, 그 422 는 "녹음이 끝나지 않는다" 로 보인다.
    coverage: Math.min(1, Math.max(0, timeline.coverage)),
    total_gap_ms: Math.max(0, Math.round(timeline.totalGapMs)),
    longest_gap_ms: Math.max(0, Math.round(timeline.longestGapMs)),
    gaps: timeline.gaps.map(gapOf),
    capture_confidence: Math.min(1, Math.max(0, input.captureConfidence)),
    capture_warnings: input.warnings.map((w) => ({
      setting: w.setting,
      severity: w.severity,
      message: w.message
    })),
    stop_reason: input.stopReason ?? null,
    timeslice_ms: input.timesliceMs
  };
}
function describeCompletion(result) {
  const percent = `${(result.coverage * 100).toFixed(1)}%`;
  if (result.meeting_queued) {
    return `녹음을 마쳤습니다 (서버 기준 커버리지 ${percent}). 전원이 끝나 회의 처리를 시작합니다.`;
  }
  if (result.meeting_status) {
    return `녹음을 마쳤습니다 (서버 기준 커버리지 ${percent}). ${result.meeting_status}`;
  }
  return `녹음을 마쳤습니다 (서버 기준 커버리지 ${percent}).`;
}
function describeCompletionFailure(status, detail) {
  const suffix = "다시 시도를 눌러 주세요 — 끝내지 않으면 회의 처리가 시작되지 않습니다.";
  if (status === 401) return "로그인이 풀렸습니다. 다시 로그인한 뒤 종료해야 합니다.";
  if (status === 404) return `이 트랙을 찾을 수 없습니다. ${suffix}`;
  if (status === 409) return detail || `이미 끝난 트랙입니다. ${suffix}`;
  if (status === 0) return `서버에 연결하지 못했습니다. ${suffix}`;
  return `${detail || `종료하지 못했습니다 (HTTP ${status})`}. ${suffix}`;
}

// src/lib/shell/bridge.ts
function shellBridge(win) {
  const bridge = win.TeamFlowShellBridge;
  if (!bridge) return null;
  for (const name of ["isShell", "version", "startRecording", "stopRecording"]) {
    if (typeof bridge[name] !== "function") return null;
  }
  return bridge;
}
function isInShell(win) {
  return shellBridge(win) !== null;
}
function tellShellRecordingStarted(win) {
  const bridge = shellBridge(win);
  if (!bridge) return false;
  try {
    bridge.startRecording();
    return true;
  } catch (error) {
    console.warn("[shell] 녹음 시작을 알리지 못했습니다", error);
    return false;
  }
}
function tellShellRecordingStopped(win) {
  const bridge = shellBridge(win);
  if (!bridge) return false;
  try {
    bridge.stopRecording();
    return true;
  } catch (error) {
    console.warn("[shell] 녹음 종료를 알리지 못했습니다", error);
    return false;
  }
}
function recordingSafety(win, standalone) {
  if (isInShell(win)) return "shell";
  if (standalone) return "installed-pwa";
  return "browser-tab";
}
function describeRecordingSafety(safety) {
  switch (safety) {
    case "shell":
      return "화면을 꺼도 녹음이 이어집니다. 앱을 완전히 닫지만 마세요.";
    case "installed-pwa":
      return "화면을 켜 두세요. 앱으로 설치돼 있어 꺼짐 방지가 동작하지만, 화면이 잠기면 녹음이 끊길 수 있습니다.";
    case "browser-tab":
      return "브라우저 탭입니다 — 화면을 켜 두고 다른 앱으로 넘어가지 마세요. 홈 화면에 추가하면 더 안전합니다.";
  }
}
function isRiskyForRecording(safety) {
  return safety !== "shell";
}

// src/lib/auth/session.ts
function loginUrlFor(pathWithQuery) {
  return `/login.html?next=${encodeURIComponent(pathWithQuery)}`;
}
var LOCAL_HOSTS = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
function safeApiBase(raw, pageOrigin) {
  if (!raw) return "";
  if (raw.startsWith("/")) {
    if (raw.startsWith("//") || raw.startsWith("/\\")) return "";
    return raw.replace(/\/+$/, "");
  }
  let target;
  let page;
  try {
    target = new URL(raw);
    page = new URL(pageOrigin);
  } catch {
    return "";
  }
  if (target.origin === page.origin) return target.origin + target.pathname.replace(/\/+$/, "");
  if (!LOCAL_HOSTS.has(page.hostname)) return "";
  if (!LOCAL_HOSTS.has(target.hostname)) return "";
  if (target.protocol !== "http:" && target.protocol !== "https:") return "";
  return target.origin + target.pathname.replace(/\/+$/, "");
}
function isSessionExpired(status) {
  return status === 401;
}

// src/lib/http/detail.ts
function isValidationList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "object" && item !== null);
}
function fieldOf(items) {
  for (const item of items) {
    if (!Array.isArray(item.loc)) continue;
    const named = item.loc.filter(
      (part) => typeof part === "string" && part !== "body"
    );
    if (named.length > 0) return named[named.length - 1];
  }
  return "";
}
function detailText(body, fallback) {
  if (typeof body !== "object" || body === null) return fallback;
  const detail = body.detail;
  if (typeof detail === "string" && detail.trim() !== "") return detail;
  if (isValidationList(detail)) {
    const field = fieldOf(detail);
    const where = field ? ` (${field})` : "";
    return `보낸 값이 올바르지 않습니다${where} — 화면 문제입니다. 새로고침해도 같으면 알려 주세요.`;
  }
  return fallback;
}

// src/lib/http/send.ts
async function trySend(request) {
  try {
    return await request();
  } catch {
    return null;
  }
}
function unreachableText(what) {
  return `${what} — 서버에 닿지 못했습니다. 연결을 확인하고 다시 시도해 주세요.`;
}
function tryGet(url) {
  return trySend(() => fetch(url, { credentials: "same-origin", cache: "no-store" }));
}

// src/lib/html.ts
var ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);
}

// src/lib/ui/failure.ts
function showNote(slot, text, tone = "bad") {
  slot.textContent = text;
  slot.hidden = text === "";
  slot.classList.toggle("bad", text !== "" && tone === "bad");
}

// src/lib/ui/pending.ts
async function whilePressed(button, run) {
  const was = button.disabled;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    return await run();
  } finally {
    button.disabled = was;
    button.removeAttribute("aria-busy");
  }
}

// src/lib/ui/copy.ts
async function copyText(text, clipboard) {
  if (clipboard === void 0 || clipboard === null) return "unavailable";
  if (typeof clipboard.writeText !== "function") return "unavailable";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "refused";
  }
}
function describeCopy(outcome, what) {
  if (outcome === "copied") return "복사됨";
  const how = `${withJosa(what, "을를")} 길게 눌러 직접 복사하세요`;
  if (outcome === "unavailable") {
    return `이 주소에서는 브라우저가 복사를 막습니다 — ${how}`;
  }
  return `복사하지 못했습니다 — ${how}`;
}
function copySucceeded(outcome) {
  return outcome === "copied";
}

// src/lib/nav/links.ts
var LABEL = {
  home: "홈",
  lobby: "회의 로비",
  record: "녹음",
  review: "업무 후보 검토",
  kanban: "칸반",
  contributions: "기여도",
  project: "설정"
};
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
function navLinks(context) {
  const project = positive(context.projectId);
  const meeting = positive(context.meetingId);
  const links = [{ screen: "home", label: LABEL.home, href: "/home.html" }];
  if (meeting !== null) {
    links.push({
      screen: "lobby",
      label: LABEL.lobby,
      href: `/lobby.html?meeting=${meeting}`
    });
    links.push({
      screen: "review",
      label: LABEL.review,
      href: `/review.html?meeting=${meeting}`
    });
  }
  if (project !== null) {
    const suffix = meeting !== null ? `&meeting=${meeting}` : "";
    links.push({
      screen: "kanban",
      label: LABEL.kanban,
      href: `/kanban.html?project=${project}${suffix}`
    });
    links.push({
      screen: "contributions",
      label: LABEL.contributions,
      href: `/contributions.html?project=${project}${suffix}`
    });
    links.push({
      screen: "project",
      label: LABEL.project,
      href: `/project.html?project=${project}`
    });
  }
  return links.filter((link) => link.screen !== context.current);
}
function missingLinks(context) {
  const notes = [];
  if (positive(context.meetingId) === null && context.current !== "home") {
    notes.push("회의를 지정하지 않아 로비·검토 화면으로 갈 수 없습니다");
  }
  if (positive(context.projectId) === null && context.current !== "home") {
    notes.push("프로젝트를 지정하지 않아 칸반·기여도·설정 화면으로 갈 수 없습니다");
  }
  return notes;
}
var TAB_ICON = {
  home: "home",
  kanban: "board",
  // ⭐ 이 제품의 시그니처가 아이콘이 된 것 — 시간축 위의 평행 트랙.
  contributions: "track",
  project: "sliders"
};
var TAB_ORDER = ["home", "kanban", "contributions", "project"];
function navTabs(context) {
  const project = positive(context.projectId);
  const meeting = positive(context.meetingId);
  const suffix = meeting !== null ? `&meeting=${meeting}` : "";
  return TAB_ORDER.map((screen) => {
    const needsProject = screen !== "home";
    const enabled = !needsProject || project !== null;
    let href = "/home.html";
    if (screen === "kanban") href = `/kanban.html?project=${project}${suffix}`;
    if (screen === "contributions") {
      href = `/contributions.html?project=${project}${suffix}`;
    }
    if (screen === "project") href = `/project.html?project=${project}`;
    return {
      screen,
      label: LABEL[screen],
      icon: TAB_ICON[screen] ?? "sliders",
      // 못 가는 탭에 주소를 주면 눌렸을 때 `?project=null` 로 간다.
      href: enabled ? href : "",
      current: context.current === screen,
      enabled,
      blockedReason: enabled ? null : "프로젝트를 고르면 열립니다 — 홈에서 프로젝트를 누르세요"
    };
  });
}
function contextFromSearch(current, search) {
  const params2 = new URLSearchParams(search);
  const read = (key) => {
    const raw = params2.get(key);
    if (raw === null) return null;
    return positive(Number(raw));
  };
  return { current, projectId: read("project"), meetingId: read("meeting") };
}

// src/lib/home/next.ts
var MEETING_STATUS_LABEL = {
  pending: "녹음 전 · 녹음 중",
  queued: "처리 대기",
  processing: "처리 중",
  needs_review: "검토 필요",
  confirmed: "검토 완료",
  failed: "처리 실패"
};
function describeMeetingStatus(status) {
  return MEETING_STATUS_LABEL[status] ?? status;
}

// src/lib/nav/channels.ts
var STATE = {
  pending: "open",
  queued: "working",
  processing: "working",
  needs_review: "todo",
  confirmed: "done",
  failed: "failed"
};
function channelState(status) {
  return STATE[status] ?? "working";
}
function channelLabel(meeting) {
  const title = (meeting.title ?? "").trim();
  return title === "" ? `회의 ${meeting.meeting_id}` : title;
}
function channelHref(meetingId2, projectId) {
  const base = `/lobby.html?meeting=${meetingId2}`;
  return projectId != null && projectId > 0 ? `${base}&project=${projectId}` : base;
}
function meetingChannels(meetings, context = {}) {
  const { projectId, currentMeetingId } = context;
  return meetings.map((meeting) => ({
    meetingId: meeting.meeting_id,
    label: channelLabel(meeting),
    href: channelHref(meeting.meeting_id, projectId),
    state: channelState(meeting.status),
    stateLabel: describeMeetingStatus(meeting.status),
    current: currentMeetingId != null && currentMeetingId === meeting.meeting_id,
    pending: meeting.pending_candidates > 0 ? meeting.pending_candidates : null
  }));
}
function emptyChannelsNote() {
  return "아직 연 회의가 없습니다 — 설정에서 엽니다";
}
function shellHeading(projectTitle) {
  const title = (projectTitle ?? "").trim();
  return title === "" ? "TeamFlow" : title;
}
function channelAriaLabel(channel) {
  const parts = [channel.label, channel.stateLabel];
  if (channel.pending !== null) parts.push(`업무 후보 ${channel.pending}건 검토 대기`);
  return parts.join(", ");
}

// src/lib/nav/icons.ts
var PATHS = {
  // 지붕(3,11)-(12,3)-(21,11) + 몸통 x 5.5~18.5, y 9.5~20
  home: '<path d="M3 11l9-8 9 8"/><path d="M5.5 9.5V20h13V9.5"/>',
  // 보드 3~21 × 4~20, 세로 칸막이 x=9·15 — 열 셋이 칸반의 전부다
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  // ⭐ 이 제품의 시그니처가 아이콘이 된 것 — 시간축 위의 평행 트랙.
  // 가운데 줄은 **끊겨 있습니다.** 그 구멍이 이 화면의 값어치입니다.
  track: '<path d="M4 6h13"/><path d="M4 12h5M12 12h6"/><path d="M4 18h10"/>',
  // 말풍선 — 칸반 카드의 "회의에서 나온 업무" 표시.
  // ⚠️ 예전에는 `🗣` 였습니다. 그 자리는 **이 제품의 대표 주장이 카드에
  // 보이는 곳**이라, 기기마다 다른 그림이 나오면 안 됩니다.
  meeting: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 16v4l4-4"/>',
  // 슬라이더 — 손잡이가 있어 트랙 아이콘과 헷갈리지 않는다
  sliders: '<path d="M4 8h16M4 16h16"/><circle cx="14" cy="8" r="2.5"/><circle cx="9" cy="16" r="2.5"/>'
};
function iconSvg(name) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + PATHS[name] + "</svg>";
}

// src/demo/nav.ts
function renderNav(current) {
  const context = contextFromSearch(current, location.search);
  paint(context);
  const tabHost = document.getElementById("tabs");
  if (tabHost) void fillChannels(tabHost, context);
}
function paint(context, projectTitle = null) {
  const tabHost = document.getElementById("tabs");
  if (tabHost) {
    const chan = tabHost.querySelector(".chan") ?? document.createElement("div");
    chan.className = "chan";
    const heading = `<p class="chan-project" title="${escapeHtml(shellHeading(projectTitle))}">${escapeHtml(shellHeading(projectTitle))}</p>`;
    tabHost.innerHTML = navTabs(context).map((tab) => {
      const href = tab.enabled ? ` href="${escapeHtml(tab.href)}"` : "";
      const disabled = tab.enabled ? "" : ' aria-disabled="true"';
      const marked = tab.current ? ' aria-current="page"' : "";
      const title = tab.blockedReason ? ` title="${escapeHtml(tab.blockedReason)}"` : "";
      return `<a${href}${disabled}${marked}${title}><span class="ico">${iconSvg(tab.icon)}</span><span>${escapeHtml(tab.label)}</span></a>`;
    }).join("");
    tabHost.insertAdjacentHTML("afterbegin", heading);
    tabHost.append(chan);
  }
  const host = document.getElementById("nav");
  if (!host) return;
  const links = navLinks(context).map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
  const notes = missingLinks(context).map((note) => `<span class="miss">${escapeHtml(note)}</span>`).join("");
  host.innerHTML = links + notes;
}
var SHELL_WIDTH = "(min-width: 90rem)";
var CHANNEL_LIMIT = 20;
async function fillChannels(tabHost, context) {
  const apiBase2 = safeApiBase(new URLSearchParams(location.search).get("api"), location.origin);
  const projectId = await resolveProjectId(apiBase2, context);
  if (projectId === null) return;
  const title = await resolveProjectTitle(apiBase2, projectId);
  if (context.projectId !== projectId || title !== null) {
    paint({ ...context, projectId }, title);
  }
  await listChannels(tabHost, apiBase2, { ...context, projectId });
}
async function resolveProjectTitle(apiBase2, projectId) {
  const response = await tryGet(`${apiBase2}/api/projects`);
  if (response === null || !response.ok) return null;
  const projects = await response.json();
  const mine = projects.find((p) => p.project_id === projectId);
  return typeof mine?.title === "string" ? mine.title : null;
}
async function listChannels(tabHost, apiBase2, context) {
  const wide = window.matchMedia(SHELL_WIDTH);
  if (!wide.matches) {
    wide.addEventListener("change", () => void listChannels(tabHost, apiBase2, context), {
      once: true
    });
    return;
  }
  const host = tabHost.querySelector(".chan");
  if (!(host instanceof HTMLElement)) return;
  const projectId = context.projectId;
  const response = await tryGet(`${apiBase2}/api/projects/${projectId}/meetings`);
  if (response === null) {
    host.innerHTML = `<p class="chan-head">회의</p><p class="chan-none">목록을 불러오지 못했습니다 — 연결을 확인해 주세요</p>`;
    return;
  }
  if (!response.ok) return;
  const meetings = await response.json();
  const channels = meetingChannels(meetings, {
    projectId,
    currentMeetingId: context.meetingId
  });
  host.innerHTML = `<p class="chan-head">회의</p>` + (channels.length === 0 ? `<p class="chan-none">${escapeHtml(emptyChannelsNote())}</p>` : renderChannels(channels));
}
async function resolveProjectId(apiBase2, context) {
  if (context.projectId != null && context.projectId > 0) return context.projectId;
  if (context.meetingId == null || context.meetingId <= 0) return null;
  const response = await tryGet(`${apiBase2}/api/meetings/${context.meetingId}`);
  if (response === null || !response.ok) return null;
  const meeting = await response.json();
  return typeof meeting.project_id === "number" ? meeting.project_id : null;
}
function renderChannels(channels) {
  const shown = channels.slice(0, CHANNEL_LIMIT);
  const rows = shown.map((channel) => {
    const current = channel.current ? ' aria-current="page"' : "";
    const count = channel.pending === null ? "" : `<span class="chan-count">${escapeHtml(String(channel.pending))}</span>`;
    return `<a class="chan-row" href="${escapeHtml(channel.href)}"${current} aria-label="${escapeHtml(channelAriaLabel(channel))}"><span class="chan-dot" data-state="${escapeHtml(channel.state)}"></span><span class="chan-name">${escapeHtml(channel.label)}</span>` + count + `</a>`;
  }).join("");
  const hidden = channels.length - shown.length;
  const more = hidden === 0 ? "" : `<p class="chan-none">그 밖에 ${escapeHtml(String(hidden))}개 — 홈에서 전부 봅니다</p>`;
  return rows + more;
}

// src/lib/pwa/install.ts
function isIOS(userAgent) {
  if (/iPhone|iPod/.test(userAgent)) return true;
  if (/iPad/.test(userAgent)) return true;
  return false;
}
function installState(env) {
  if (env.inShell) return "in-shell";
  if (env.standalone || env.iosStandalone) return "installed";
  if (env.hasPrompt) return "promptable";
  if (isIOS(env.userAgent)) return "manual-ios";
  return "unavailable";
}
function describeInstall(state) {
  switch (state) {
    case "promptable":
      return "앱으로 설치하면 주소창 없이 전체 화면으로 열리고, 홈 화면에서 바로 들어옵니다.";
    case "manual-ios":
      return '아이폰에서는 화면 아래 가운데의 공유 버튼(상자에서 위로 나가는 화살표) → "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있습니다.';
    case "installed":
      return "";
    case "in-shell":
      return "";
    case "unavailable":
      return "";
  }
}
function whyInstall() {
  return "설치하면 녹음 중에 화면이 꺼지는 것을 더 잘 막습니다 — 브라우저 탭에서는 화면 꺼짐 방지가 잘 듣지 않습니다.";
}

// src/demo/pwa.ts
var deferredPrompt = null;
function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    console.info("[pwa] 이 브라우저는 서비스 워커를 지원하지 않습니다");
    return;
  }
  if (isInShell(window)) return;
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
    console.warn(
      "[pwa] 서비스 워커를 등록하지 못했습니다 — 오프라인 화면이 뜨지 않습니다.",
      "https:// 또는 localhost 에서만 등록됩니다.",
      error
    );
  });
}
function renderInstallHint() {
  const host = document.getElementById("install");
  if (!host) return;
  const state = installState({
    userAgent: navigator.userAgent,
    standalone: matchMedia("(display-mode: standalone)").matches,
    iosStandalone: navigator.standalone === true,
    hasPrompt: deferredPrompt !== null,
    inShell: isInShell(window)
  });
  const text = describeInstall(state);
  host.textContent = text;
  host.hidden = text === "";
  const card = document.getElementById("install-card");
  if (card) card.hidden = text === "";
  const why = document.getElementById("install-why");
  if (why) why.textContent = text === "" ? "" : whyInstall();
  const button = document.getElementById("install-now");
  if (!button) return;
  button.hidden = state !== "promptable";
  button.onclick = () => {
    void deferredPrompt?.prompt();
    deferredPrompt = null;
    button.hidden = true;
  };
}
addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
  renderInstallHint();
});
function bootApp() {
  registerServiceWorker();
  renderInstallHint();
}

// src/demo/main.ts
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소를 찾을 수 없습니다: ${id}`);
  return el;
};
var LocalSyncTransport = class {
  async probe() {
    const now = Date.now();
    return { t1: now, t2: now };
  }
};
var LocalUploadTransport = class {
  totalBytes = 0;
  count = 0;
  async send(chunk) {
    this.totalBytes += chunk.byteLength;
    this.count += 1;
  }
};
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var meetingId = params.get("meeting");
var trackUrl = params.get("track");
var localUpload = new LocalUploadTransport();
var httpUpload = new HttpUploadTransport("");
var client = new RecordingClient({
  monotonic: () => performance.now(),
  media: new BrowserMediaAdapter(),
  sync: apiBase || meetingId ? new HttpSyncTransport(apiBase) : new LocalSyncTransport(),
  upload: {
    async send(chunk) {
      if (!trackUrl) return localUpload.send(chunk);
      return httpUpload.send(chunk);
    }
  },
  timesliceMs: 5e3,
  onStateChange: () => render()
});
var wakeLock = null;
var resyncTimer = null;
var elapsedTimer = null;
var summary = null;
var lastRow = null;
function render() {
  const state = client.state;
  $("phase").textContent = PHASE_LABEL[state.phase] ?? state.phase;
  $("phase").dataset.phase = state.phase;
  $("chunks").textContent = String(state.chunks.length);
  $("interruptions").textContent = String(state.interruptions);
  $("uploaded").textContent = trackUrl ? "서버로 전송" : `${(localUpload.totalBytes / 1024).toFixed(0)} KB (로컬)`;
  const blockers2 = blockers(state);
  $("blockers").innerHTML = blockers2.length ? blockers2.map((b) => `<li>${escapeHtml(b)}</li>`).join("") : '<li class="ok">준비됐습니다</li>';
  $("start").disabled = state.phase !== "ready";
  $("stop").disabled = !(state.phase === "recording" || state.phase === "interrupted");
  const safety = recordingSafety(window, matchMedia("(display-mode: standalone)").matches);
  $("safety").textContent = describeRecordingSafety(safety);
  $("safety").className = isRiskyForRecording(safety) ? "banner" : "banner ok-banner";
  const warnings = client.warnings;
  $("warnings").innerHTML = warnings.length ? warnings.map((w) => `<li class="${w.severity}">${escapeHtml(w.message)}</li>`).join("") : '<li class="ok">캡처 설정이 요청대로 적용됐습니다</li>';
}
var PHASE_LABEL = {
  idle: "준비 중",
  ready: "시작 가능",
  recording: "녹음 중",
  interrupted: "화면이 가려짐",
  stopping: "마무리 중",
  completed: "완료",
  failed: "오류"
};
$("consent").addEventListener("click", () => {
  client.setConsent("all_confirmed");
});
async function joinMeeting(id) {
  const me = await tryGet(`${apiBase}/api/auth/me`);
  if (me === null) {
    showNote($("join-note"), unreachableText("회의에 들어가지 못했습니다"));
    return;
  }
  if (!me.ok) {
    location.href = loginUrlFor(location.pathname + location.search);
    return;
  }
  $("who").textContent = `${(await me.json()).name} 님의 트랙으로 녹음합니다`;
  showNote($("join-note"), "");
  const response = await trySend(
    () => fetch(`${apiBase}/api/meetings/${id}/tracks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        started_at: (/* @__PURE__ */ new Date()).toISOString(),
        device_label: navigator.userAgent.slice(0, 100)
      }),
      credentials: "same-origin"
    })
  );
  if (response === null) {
    showNote($("join-note"), unreachableText("트랙에 참가하지 못했습니다"));
    return;
  }
  if (isSessionExpired(response.status)) {
    location.href = loginUrlFor(location.pathname + location.search);
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    showNote(
      $("join-note"),
      `트랙에 참가하지 못했습니다: ${detailText(body, `HTTP ${response.status}`)}`
    );
    return;
  }
  const track = await response.json();
  trackUrl = `${apiBase}/api/meetings/${id}/tracks/${track.track_id}`;
  httpUpload.retarget(trackUrl);
  render();
}
if (meetingId) void joinMeeting(meetingId);
$("permission").addEventListener("click", async () => {
  await client.requestMicrophone();
  await client.syncClock();
  render();
});
$("start").addEventListener("click", async () => {
  if ($("wakelock").checked) {
    wakeLock = await keepScreenAwake();
  }
  if (!client.start()) {
    alert("시작할 수 없습니다. 위 목록을 확인하세요.");
    return;
  }
  tellShellRecordingStarted(window);
  resyncTimer = setInterval(() => void client.syncClock(), 5 * 6e4);
  const startedAt = Date.now();
  elapsedTimer = setInterval(() => {
    const sec = Math.floor((Date.now() - startedAt) / 1e3);
    $("elapsed").textContent = `${Math.floor(sec / 60)}분 ${sec % 60}초`;
  }, 1e3);
});
async function tellServerWeAreDone(result) {
  if (!trackUrl) return;
  showNote($("finish-state"), "녹음 종료를 서버에 알리는 중…", "plain");
  $("finish-retry").hidden = true;
  const body = completeBody({
    timeline: result.timeline,
    verdict: result.verdict,
    captureConfidence: result.captureConfidence,
    warnings: result.warnings,
    timesliceMs: result.timesliceMs
  });
  const response = await trySend(
    () => fetch(`${trackUrl}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    })
  );
  if (response === null) {
    showNote($("finish-state"), describeCompletionFailure(0));
    $("finish-retry").hidden = false;
    return;
  }
  if (!response.ok) {
    const body2 = await response.json().catch(() => null);
    showNote(
      $("finish-state"),
      describeCompletionFailure(response.status, detailText(body2, ""))
    );
    if (isSessionExpired(response.status)) {
      location.href = loginUrlFor(location.pathname + location.search);
      return;
    }
    $("finish-retry").hidden = false;
    return;
  }
  const done = await response.json();
  showNote($("finish-state"), describeCompletion(done), "plain");
  $("finish-retry").hidden = true;
  if (meetingId) {
    $("finish-next").hidden = false;
    $("finish-next").href = `/lobby.html?meeting=${meetingId}`;
  }
}
$("stop").addEventListener("click", async () => {
  if (resyncTimer) clearInterval(resyncTimer);
  if (elapsedTimer) clearInterval(elapsedTimer);
  wakeLock?.release();
  wakeLock = null;
  summary = await client.stop();
  tellShellRecordingStopped(window);
  showResult(summary);
  await tellServerWeAreDone(summary);
});
$("finish-retry").addEventListener("click", () => {
  const done = summary;
  if (done) {
    void whilePressed(
      $("finish-retry"),
      () => tellServerWeAreDone(done)
    );
  }
});
document.addEventListener("visibilitychange", () => {
  client.setHidden(document.visibilityState === "hidden");
});
function showResult(result) {
  $("result").hidden = false;
  $("verdict").textContent = describeTimeline(result.timeline);
  $("verdict").className = result.verdict.usable ? "ok" : "bad";
  $("coverage").textContent = `${(result.timeline.coverage * 100).toFixed(1)}%`;
  $("totalgap").textContent = `${(result.timeline.totalGapMs / 1e3).toFixed(1)}초`;
  $("longestgap").textContent = `${(result.timeline.longestGapMs / 1e3).toFixed(1)}초`;
  $("usable").textContent = result.verdict.usable ? "사용 가능" : "사용 불가";
  $("gaps").innerHTML = result.timeline.gaps.length ? result.timeline.gaps.map(
    (g) => `<li><code>${g.reason}</code> ${(g.durationMs / 1e3).toFixed(1)}초 (${((g.startMs - result.timeline.startedAtMs) / 1e3).toFixed(0)}초 지점)</li>`
  ).join("") : '<li class="ok">공백 없음</li>';
  lastRow = `| ${navigator.userAgent.slice(0, 40)} | ${$("wakelock").checked ? "있음" : "없음"} | ${(result.timeline.coverage * 100).toFixed(1)}% | ${(result.timeline.longestGapMs / 1e3).toFixed(1)}초 | ${[...new Set(result.timeline.gaps.map((g) => g.reason))].join(", ") || "-"} |`;
  $("row").textContent = lastRow;
}
$("copy").addEventListener("click", () => {
  if (lastRow === null) return;
  void copyText(lastRow, navigator.clipboard).then((outcome) => {
    if (copySucceeded(outcome)) {
      showNote($("copy-note"), "");
      $("copy").textContent = describeCopy(outcome, "한 줄");
      setTimeout(() => $("copy").textContent = "표에 붙일 한 줄 복사", 1500);
      return;
    }
    showNote($("copy-note"), describeCopy(outcome, "한 줄"));
  });
});
render();
renderNav("record");
bootApp();
