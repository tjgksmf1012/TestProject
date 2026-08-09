// src/lib/lobby/room.ts
var MIN_USABLE_COVERAGE = 0.8;
var WARN_GAP_MS = 3e4;
function consentStateOf(entry) {
  if (entry.recording === null || entry.recording === void 0) return "pending";
  return entry.recording ? "granted" : "refused";
}
function describeConsent(state) {
  switch (state) {
    case "granted":
      return "동의함";
    case "refused":
      return "거부함";
    case "pending":
      return "응답 대기 중";
  }
}
function summarizeConsent(roster2) {
  const pendingNames = [];
  const refusedNames = [];
  let granted = 0;
  for (const entry of roster2) {
    switch (consentStateOf(entry)) {
      case "granted":
        granted += 1;
        break;
      case "refused":
        refusedNames.push(entry.name);
        break;
      case "pending":
        pendingNames.push(entry.name);
        break;
    }
  }
  return {
    total: roster2.length,
    granted,
    refused: refusedNames.length,
    pending: pendingNames.length,
    pendingNames,
    refusedNames
  };
}
function startBlockers(roster2) {
  if (roster2.length === 0) {
    return ["이 프로젝트에 팀원이 없습니다"];
  }
  const summary = summarizeConsent(roster2);
  const blockers = [];
  if (summary.refused > 0) {
    blockers.push(`${summary.refusedNames.join(", ")} 님이 녹음을 거부했습니다`);
  }
  if (summary.pending > 0) {
    blockers.push(`${summary.pendingNames.join(", ")} 님이 아직 응답하지 않았습니다`);
  }
  return blockers;
}
function canStart(roster2) {
  return startBlockers(roster2).length === 0;
}
function verdictOf(track) {
  if (track === void 0) return "not_joined";
  const coverage = track.coverage;
  if (track.status === "recording") {
    if (coverage !== null && coverage < MIN_USABLE_COVERAGE) return "broken";
    if ((track.total_gap_ms ?? 0) >= WARN_GAP_MS) return "at_risk";
    if (isSilentTooLong(track)) return "at_risk";
    return "healthy";
  }
  if (track.status === "completed") return "finished";
  return "broken";
}
function isSilentTooLong(track) {
  const silent = track.silent_ms;
  if (silent === null || silent === void 0) return false;
  return silent >= WARN_GAP_MS;
}
function describeAtRisk(track) {
  const silentMs = track?.silent_ms;
  if (silentMs !== null && silentMs !== void 0) {
    const seconds = Math.round(silentMs / 1e3);
    const howLong = seconds >= 60 ? `${Math.round(seconds / 60)}분째` : `${seconds}초째`;
    return (track?.chunk_count ?? 0) === 0 ? `${howLong} 녹음이 한 조각도 안 왔습니다 — 그 폰에서 녹음을 시작했는지 확인해 주세요` : `${howLong} 녹음이 안 올라옵니다 — 폰 화면을 켜 주세요`;
  }
  const gapSeconds = Math.round((track?.total_gap_ms ?? 0) / 1e3);
  return `녹음이 끊기고 있습니다 (공백 ${gapSeconds}초) — 폰 화면을 켜 주세요`;
}
function messageFor(verdict, track) {
  const coverage = track?.coverage;
  const percent = coverage === null || coverage === void 0 ? null : Math.round(coverage * 100);
  switch (verdict) {
    case "not_joined":
      return "아직 참가하지 않았습니다";
    case "healthy":
      return "녹음 중";
    case "at_risk":
      return describeAtRisk(track);
    case "broken":
      return percent === null ? "녹음을 쓸 수 없습니다 — 이 사람의 발언량은 측정할 수 없습니다" : `커버리지 ${percent}% — 이 사람의 발언량은 측정할 수 없습니다`;
    case "finished":
      return percent === null ? "녹음 종료" : `녹음 종료 (커버리지 ${percent}%)`;
  }
}
function memberStatuses(roster2, tracks2) {
  const byUser = /* @__PURE__ */ new Map();
  for (const track of tracks2) byUser.set(track.user_id, track);
  return roster2.map((entry) => {
    const track = byUser.get(entry.user_id);
    const verdict = verdictOf(track);
    return {
      userId: entry.user_id,
      name: entry.name,
      consent: consentStateOf(entry),
      verdict,
      coverage: track?.coverage ?? null,
      message: messageFor(verdict, track)
    };
  });
}
function roomStatus(statuses) {
  const recording = statuses.filter(
    (s) => s.verdict === "healthy" || s.verdict === "at_risk"
  ).length;
  const notJoined = statuses.filter(
    (s) => s.verdict === "not_joined" && s.consent === "granted"
  ).length;
  const broken = statuses.filter((s) => s.verdict === "broken").length;
  const anyJoined = statuses.some((s) => s.verdict !== "not_joined");
  let message;
  if (!anyJoined) {
    message = "아직 아무도 참가하지 않았습니다";
  } else if (recording > 0) {
    message = `${recording}명이 녹음 중입니다`;
  } else if (notJoined > 0) {
    message = `${notJoined}명이 참가하지 않아 회의가 끝나지 않습니다 — 강제 종료할 수 있습니다`;
  } else {
    message = "전원 종료했습니다. 회의 처리가 시작됩니다";
  }
  return {
    recording,
    notJoined,
    broken,
    // 녹음 중인 사람이 없는데 참가 안 한 사람이 남아 있으면 사람이 풀어야 한다.
    needsForceFinish: anyJoined && recording === 0 && notJoined > 0,
    message
  };
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
function logoutOutcome(status) {
  if (status === null) return "still-signed-in";
  if (status === 401) return "done";
  if (status >= 200 && status < 300) return "done";
  return "still-signed-in";
}
function describeLogoutFailure(status) {
  const why = status === null ? "서버에 연결하지 못했습니다" : `서버가 처리하지 못했습니다 (HTTP ${status})`;
  return `로그아웃하지 못했습니다 — ${why}. 이 기기에 로그인 상태가 그대로 남아 있으니 다시 눌러 주세요.`;
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

// src/lib/track/diagram.ts
var at = (iso) => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};
function meetingWindow(tracks2) {
  const starts = [];
  const ends = [];
  for (const t of tracks2) {
    const s = at(t.startedAt);
    if (s === null) continue;
    starts.push(s);
    const e = at(t.endedAt);
    if (e !== null && e > s) ends.push(e);
  }
  if (starts.length === 0 || ends.length === 0) return null;
  const startMs = Math.min(...starts);
  const endMs = Math.max(...ends);
  return endMs > startMs ? { startMs, endMs } : null;
}
function buildDiagram(tracks2) {
  const window2 = meetingWindow(tracks2);
  if (window2 === null) return { durationMs: 0, gaps: /* @__PURE__ */ new Map() };
  const total = window2.endMs - window2.startMs;
  const gaps = /* @__PURE__ */ new Map();
  for (const track of tracks2) {
    const trackStart = at(track.startedAt);
    if (trackStart === null) continue;
    const offset = trackStart - window2.startMs;
    const spans = [];
    for (const gap of track.gaps ?? []) {
      const from = offset + gap.startMs;
      const to = offset + gap.endMs;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
      const left = Math.max(from, 0) / total * 100;
      const right = Math.min(to, total) / total * 100;
      if (right <= 0 || left >= 100) continue;
      spans.push({
        left,
        // 아주 짧은 구멍도 보여야 합니다 — 1초 끊긴 것과 안 끊긴 것은
        // 다릅니다. 다만 최소 폭을 주면 **길이가 과장**되므로 아주
        // 작게만 줍니다.
        width: Math.max(right - left, 0.4),
        reason: gap.reason ?? "unknown"
      });
    }
    if (spans.length > 0) gaps.set(track.userId, spans);
  }
  return { durationMs: total, gaps };
}
function axisTicks(durationMs, count = 6) {
  if (durationMs <= 0) return [];
  const totalMin = durationMs / 6e4;
  return Array.from({ length: count + 1 }, (_, i) => {
    const minute = Math.round(totalMin * i / count);
    return i === 0 ? "0분" : i === count ? `${minute}분` : String(minute);
  });
}
var REASON_TEXT = {
  recorder_stalled: "녹음이 멈춰 있었습니다 — 화면이 꺼졌거나 앱이 내려갔습니다",
  chunk_lost: "조각이 서버에 도착하지 않았습니다",
  track_muted: "마이크가 꺼져 있었습니다"
};
function describeGap(span, durationMs) {
  const fromMin = Math.round(span.left / 100 * durationMs / 6e4);
  const toMin = Math.round((span.left + span.width) / 100 * durationMs / 6e4);
  const when = fromMin === toMin ? `${fromMin}분쯤` : `${fromMin}~${toMin}분`;
  const why = REASON_TEXT[span.reason] ?? "녹음이 끊겼습니다";
  return `${when} · ${why}`;
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
function describeUnexpected() {
  return "알 수 없는 오류가 생겼습니다 — 새로고침해도 같으면 알려 주세요.";
}

// src/lib/ui/failure.ts
function describeHttpStatus(status) {
  if (status === 401) return "로그인이 풀렸습니다.";
  if (status === 403) return "이 프로젝트의 구성원만 볼 수 있습니다.";
  if (status === 404) return "찾을 수 없습니다 — 주소가 바뀌었거나 지워졌습니다.";
  if (status === 429) return "요청이 너무 잦습니다. 잠시 뒤에 다시 해 보세요.";
  if (status >= 500) return "서버 쪽 문제입니다. 팀이 고칠 수 있는 것이 아닙니다.";
  return null;
}
function failureHtml(failure) {
  const code = failure.code === void 0 || failure.code === "" ? "" : `<p class="code">오류 코드 ${escapeHtml(String(failure.code))}</p>`;
  const help = failure.help ? `<p class="why">${escapeHtml(failure.help)}</p>` : "";
  const retry = failure.retry ? '<button type="button" class="retry">다시 불러오기</button>' : "";
  return `<div class="failure-state" role="alert"><p class="what">${escapeHtml(failure.what)}</p>` + help + retry + code + "</div>";
}

// src/lib/ui/pending.ts
var LOADING_DELAY_MS = 200;
var browserTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => {
    clearTimeout(id);
  }
};
async function whileLoading(work, show, hide, timers = browserTimers, delayMs = LOADING_DELAY_MS) {
  let shown = false;
  const timer = timers.set(() => {
    shown = true;
    show();
  }, delayMs);
  try {
    return await work;
  } finally {
    timers.clear(timer);
    if (shown) hide();
  }
}
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

// src/lib/ui/skeleton.ts
var bar = (width, kind = "") => `<span class="sk${kind ? ` sk-${kind}` : ""}" style="width:${width}%"></span>`;
var ROW_WIDTHS = [86, 64, 74, 58, 80];
function rowItems(count = 3) {
  return Array.from(
    { length: Math.max(1, count) },
    (_, i) => `<li class="sk-line" aria-hidden="true">${bar(ROW_WIDTHS[i % ROW_WIDTHS.length] ?? 70, "line")}</li>`
  ).join("");
}
function showSkeleton(element, html) {
  element.setAttribute("aria-busy", "true");
  element.innerHTML = html;
}
function clearSkeleton(element) {
  element.removeAttribute("aria-busy");
  if (element.innerHTML.includes('class="sk')) element.innerHTML = "";
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
  const tabHost = document.getElementById("tabs");
  if (tabHost) {
    tabHost.innerHTML = navTabs(context).map((tab) => {
      const href = tab.enabled ? ` href="${escapeHtml(tab.href)}"` : "";
      const disabled = tab.enabled ? "" : ' aria-disabled="true"';
      const marked = tab.current ? ' aria-current="page"' : "";
      const title = tab.blockedReason ? ` title="${escapeHtml(tab.blockedReason)}"` : "";
      return `<a${href}${disabled}${marked}${title}><span class="ico">${iconSvg(tab.icon)}</span><span>${escapeHtml(tab.label)}</span></a>`;
    }).join("");
  }
  const host = document.getElementById("nav");
  if (!host) return;
  const links = navLinks(context).map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
  const notes = missingLinks(context).map((note) => `<span class="miss">${escapeHtml(note)}</span>`).join("");
  host.innerHTML = links + notes;
}

// src/demo/logout.ts
function wireLogout({ button, note, apiBase: apiBase2, next = "/login.html" }) {
  button.addEventListener("click", () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    note.hidden = true;
    void trySend(
      () => fetch(`${apiBase2}/api/auth/logout`, {
        method: "POST",
        credentials: "same-origin"
      })
    ).then((response) => response === null ? null : response.status).then((status) => {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (logoutOutcome(status) === "done") {
        location.href = next;
        return;
      }
      note.textContent = describeLogoutFailure(status);
      note.hidden = false;
    });
  });
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

// src/demo/lobby.ts
var params = new URLSearchParams(location.search);
var meetingId = Number(params.get("meeting") ?? "1");
var apiBase = safeApiBase(params.get("api"), location.origin);
var meId = 0;
var projectId = 0;
var POLL_MS = 3e3;
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
var checked = (id) => {
  const el = document.getElementById(id);
  return el instanceof HTMLInputElement ? el.checked : false;
};
var roster = [];
var progressLine = "";
var tracks = [];
var consentMessage = "";
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
var HttpError = class extends Error {
  // ⚠️ 생성자 매개변수 속성(`constructor(readonly status)`)은 못 씁니다 —
  // `erasableSyntaxOnly` 가 막습니다. 이 저장소는 타입을 **지우기만** 하고
  // 변환하지 않는 실행 방식이라, 코드를 만들어 내는 문법은 전부 금지입니다.
  status;
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
};
async function getJson(path) {
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    credentials: "same-origin"
  });
  if (isSessionExpired(response.status)) {
    goToLogin();
    throw new Error("로그인이 필요합니다");
  }
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}
async function refresh() {
  const first = roster.length === 0;
  try {
    const [consent, trackBody] = await whileLoading(
      Promise.all([
        getJson(`/api/meetings/${meetingId}/consent`),
        getJson(`/api/meetings/${meetingId}/tracks`)
      ]),
      () => {
        if (first) showSkeleton($("roster"), rowItems(3));
      },
      () => {
        if (first) clearSkeleton($("roster"));
      }
    );
    roster = consent.roster;
    consentMessage = consent.message;
    tracks = trackBody.tracks;
    progressLine = await getJson(`/api/meetings/${meetingId}/progress`).then((body) => String(body.message ?? "")).catch(() => "");
    render();
  } catch (err) {
    $("sub").textContent = "불러오지 못했습니다";
    if (first) {
      clearSkeleton($("roster"));
      const box = $("blockers");
      box.hidden = false;
      box.innerHTML = failureHtml({
        what: "참가자 상태를 불러오지 못했습니다.",
        help: err instanceof HttpError ? describeHttpStatus(err.status) ?? void 0 : "연결이 끊겼거나 서버에 닿지 못했습니다.",
        code: err instanceof HttpError ? err.message : void 0,
        retry: true
      });
      box.querySelector(".retry")?.addEventListener("click", () => {
        void refresh();
      });
    }
  }
}
async function postConsent(consentType, consented) {
  return trySend(
    () => fetch(`${apiBase}/api/meetings/${meetingId}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `user_id` 를 보내지 않는다. **동의는 본인만 한다** — 서버가 세션에서
      // 읽으므로 남을 대신해 동의해 줄 방법이 없다.
      body: JSON.stringify({ consent_type: consentType, consented }),
      credentials: "same-origin"
    })
  );
}
async function submitConsent(consented) {
  consentNote("");
  try {
    const response = await postConsent("recording", consented);
    if (response === null) {
      consentNote(unreachableText("동의를 제출하지 못했습니다"));
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      consentNote(detailText(body, "동의를 제출하지 못했습니다"));
      return;
    }
    if (consented) {
      const extras = [
        ["raw_audio_retention", checked("keep-audio")],
        ["voiceprint_storage", checked("keep-voiceprint")]
      ];
      for (const [type, value] of extras) {
        const extra = await postConsent(type, value);
        if (extra === null || !extra.ok) {
          consentNote(
            "녹음 동의는 접수됐지만 아래 두 항목을 저장하지 못했습니다. 다시 눌러 주세요."
          );
          return;
        }
      }
    }
    roster = body.roster;
    consentMessage = body.message;
    render();
  } catch (err) {
    console.error(err);
    consentNote(describeUnexpected());
  }
}
function consentNote(text) {
  $("consent-note").textContent = text;
  $("consent-note").hidden = text === "";
}
function roomNote(text) {
  $("room-note").textContent = text;
  $("room-note").hidden = text === "";
}
async function forceFinish() {
  const ok = confirm(
    "참가하지 않은 사람을 기다리지 않고 회의를 끝냅니다.\n그 사람의 발언은 기록되지 않습니다. 계속할까요?"
  );
  if (!ok) return;
  roomNote("");
  try {
    const response = await trySend(
      () => fetch(`${apiBase}/api/meetings/${meetingId}/finish`, {
        method: "POST",
        credentials: "same-origin"
      })
    );
    if (response === null) {
      roomNote(unreachableText("회의를 끝내지 못했습니다"));
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      roomNote(detailText(body, `회의를 끝내지 못했습니다 (HTTP ${response.status})`));
      return;
    }
    roomNote(body?.message ?? "");
    await refresh();
  } catch (err) {
    console.error(err);
    roomNote(describeUnexpected());
  }
}
function renderRoster() {
  $("roster").innerHTML = roster.map((entry) => {
    const state = consentStateOf(entry);
    const mine = entry.user_id === meId ? " (나)" : "";
    return `<li><span class="name">${escapeHtml(entry.name)}${mine}</span><span class="state ${state}">${describeConsent(state)}</span></li>`;
  }).join("");
  const blockers = startBlockers(roster);
  const box = $("blockers");
  box.hidden = blockers.length === 0;
  box.innerHTML = blockers.map((b) => `<p>${escapeHtml(b)}</p>`).join("");
  $("consent-message").textContent = consentMessage;
}
function renderMembers(statuses) {
  const diagram = buildDiagram(
    tracks.map((t) => ({
      userId: t.user_id,
      startedAt: t.started_at ?? null,
      endedAt: t.ended_at ?? null,
      gaps: t.gaps ?? []
    }))
  );
  const ticks = axisTicks(diagram.durationMs);
  $("axis").innerHTML = ticks.length ? `<span></span><span class="marks">${ticks.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</span>` : "";
  $("axis").hidden = ticks.length === 0;
  $("members").innerHTML = statuses.map((s) => {
    const spans = diagram.durationMs > 0 ? diagram.gaps.get(s.userId) ?? [] : null;
    const bar2 = spans === null ? "" : `<span class="tl">${spans.map(
      (g) => `<i style="left:${g.left}%;width:${g.width}%" title="${escapeHtml(
        describeGap(g, diagram.durationMs)
      )}"></i>`
    ).join("")}</span>`;
    return `<li class="${s.verdict}"><span class="name">${escapeHtml(s.name)}</span><span class="state">${escapeHtml(s.message)}</span>${bar2}</li>`;
  }).join("");
}
function render() {
  const statuses = memberStatuses(roster, tracks);
  const room = roomStatus(statuses);
  renderRoster();
  renderMembers(statuses);
  $("sub").textContent = `회의 ${meetingId} · 팀원 ${roster.length}명`;
  $("room-message").textContent = room.message;
  $("progress").textContent = progressLine;
  const record = $("record");
  record.disabled = !canStart(roster);
  record.textContent = record.disabled ? "전원 동의 후 시작할 수 있습니다" : "녹음 화면으로";
  const call = $("call");
  call.disabled = record.disabled;
  call.textContent = call.disabled ? "통화도 전원 동의 후에" : "통화로 회의하기";
  const iAgreed = roster.some((e) => e.user_id === meId && consentStateOf(e) === "granted");
  $("agree").classList.toggle("primary", !iAgreed);
  $("finish").hidden = !room.needsForceFinish;
  $("review").hidden = room.recording > 0 || room.notJoined > 0 || tracks.length === 0;
}
$("agree").addEventListener("click", () => {
  void whilePressed($("agree"), () => submitConsent(true));
});
$("refuse").addEventListener("click", () => {
  void whilePressed($("refuse"), () => submitConsent(false));
});
$("finish").addEventListener("click", () => {
  void whilePressed($("finish"), forceFinish);
});
$("record").addEventListener("click", () => {
  location.href = `/index.html?meeting=${meetingId}`;
});
$("call").addEventListener("click", () => {
  location.href = `/call.html?meeting=${meetingId}`;
});
$("review").addEventListener("click", () => {
  location.href = `/review.html?meeting=${meetingId}`;
});
$("kanban").addEventListener("click", () => {
  location.href = `/kanban.html?project=${projectId}&meeting=${meetingId}`;
});
$("contrib").addEventListener("click", () => {
  location.href = `/contributions.html?project=${projectId}&meeting=${meetingId}`;
});
wireLogout({ button: $("logout"), note: $("logout-note"), apiBase });
async function start() {
  const response = await fetch(`${apiBase}/api/auth/me`, { credentials: "same-origin" });
  if (!response.ok) {
    goToLogin();
    return;
  }
  const me = await response.json();
  meId = me.user_id;
  $("who").textContent = `${me.name} 님으로 로그인했습니다`;
  const meeting = await getJson(`/api/meetings/${meetingId}`);
  projectId = meeting.project_id;
  await refresh();
  setInterval(() => void refresh(), POLL_MS);
}
void start();
renderNav("lobby");
bootApp();
