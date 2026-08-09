// src/lib/contribution/view.ts
var CATEGORY_LABEL = {
  task: "업무",
  code: "코드",
  meeting: "회의",
  document: "문서",
  schedule: "일정 준수",
  peer: "동료 평가"
};
function describeCategory(category) {
  return CATEGORY_LABEL[category] ?? category;
}
function orderForDisplay(members, people2) {
  const name = (m) => nameOf(m.user_id, people2);
  return [...members].sort((a, b) => {
    const byName = name(a).localeCompare(name(b), "ko");
    return byName !== 0 ? byName : a.user_id - b.user_id;
  });
}
function nameOf(userId, people2) {
  return people2.find((p) => p.user_id === userId)?.name ?? `사용자 #${userId}`;
}
function describeRange(member) {
  const low = Math.round(member.range_low);
  const high = Math.round(member.range_high);
  if (low === high) return `${low}%`;
  return `${low}~${high}%`;
}
function rangeBar(member) {
  const low = clamp(member.range_low, 0, 100);
  const high = clamp(member.range_high, 0, 100);
  const left = Math.min(low, high);
  return { left, width: Math.max(Math.abs(high - low), 1) };
}
function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}
function readBeforeTheNumber(member) {
  const lines = [];
  for (const gap of member.measurement_gaps ?? []) {
    const category = gap.category ? describeCategory(gap.category) : "일부 활동";
    lines.push(
      `${category} 기여를 **측정하지 못했습니다** — ${gap.reason ?? "사유 미기록"}. 0으로 계산하지 않고 나머지 활동으로 추정했습니다.`
    );
  }
  lines.push(...member.confidence_reasons);
  return lines;
}
function integrityNotes(member) {
  return member.integrity_flags.map((f) => f.message ?? f.code ?? "").filter((text) => text !== "");
}
function teamWarnings(score, people2) {
  const warnings = [];
  if (score.members.length === 0) {
    return ["아직 기여도를 계산할 활동 기록이 없습니다."];
  }
  const unmeasured = score.members.filter((m) => (m.measurement_gaps ?? []).length > 0);
  if (unmeasured.length > 0) {
    const names = unmeasured.map((m) => nameOf(m.user_id, people2)).join(", ");
    warnings.push(
      `${names} 님은 일부 활동을 측정하지 못했습니다. 그 영역은 0이 아니라 나머지 활동으로 추정한 값입니다.`
    );
  }
  const shaky = score.members.filter((m) => m.confidence < LOW_CONFIDENCE);
  if (shaky.length === score.members.length) {
    warnings.push(
      "팀 전원의 신뢰도가 낮습니다. 이 수치로 서로를 비교하지 마세요 — 연결되지 않은 데이터가 무엇인지 먼저 확인해야 합니다."
    );
  }
  if (score.skipped_categories.length > 0) {
    const skipped = score.skipped_categories.map(describeCategory).join(", ");
    warnings.push(`${skipped} 활동은 이번 계산에서 빠졌습니다.`);
  }
  return warnings;
}
var LOW_CONFIDENCE = 0.6;
function categoriesForDisplay(member) {
  return [...member.categories].sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.category.localeCompare(b.category);
  });
}
function hasNoEvidence(member) {
  return member.categories.every((c) => c.event_count === 0);
}
var ROLE_NAMES = {
  developer: "개발",
  planner: "기획",
  designer: "디자인"
};
function roleLabel(key) {
  return ROLE_NAMES[key] ?? key;
}
function roleOf(member, people2) {
  const shares = people2.find((p) => p.user_id === member.user_id)?.role_shares;
  const named = Object.entries(shares ?? {}).filter(([, v]) => v > 0);
  if (named.length === 0) return roleLabel(member.role);
  if (named.length === 1) return roleLabel(named[0]?.[0] ?? member.role);
  return named.sort((a, b) => b[1] - a[1]).map(([key, value]) => `${roleLabel(key)} ${Math.round(value * 100)}%`).join(" · ");
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

// src/lib/contribution/final.ts
function sameValue(a, b) {
  return Math.abs(a - b) < 1e-9;
}
function problemsWith(drafts, systemValues2) {
  const problems = [];
  for (const draft of drafts) {
    if (draft.final_value === null) continue;
    if (Number.isNaN(draft.final_value)) {
      problems.push(`숫자가 아닌 값이 있습니다 (${draft.user_id})`);
      continue;
    }
    const system = systemValues2.get(draft.user_id);
    if (system === void 0) continue;
    if (!sameValue(draft.final_value, system) && !draft.reason.trim()) {
      problems.push("시스템 값과 다르게 확정하려면 이유를 적어야 합니다");
    }
  }
  return [...new Set(problems)];
}
function toPayload(drafts, systemValues2) {
  return drafts.map((draft) => {
    const system = systemValues2.get(draft.user_id);
    const untouched = draft.final_value === null || system !== void 0 && sameValue(draft.final_value, system);
    if (untouched) return { user_id: draft.user_id };
    return {
      user_id: draft.user_id,
      final_value: draft.final_value,
      reason: draft.reason.trim() || void 0
    };
  });
}
function describeFinals(finals, names) {
  if (finals.length === 0) return "아직 아무도 확정하지 않았습니다.";
  const first = finals[0];
  if (first === void 0) return "아직 아무도 확정하지 않았습니다.";
  const when = new Date(first.confirmed_at).toLocaleString("ko-KR");
  const adjusted = finals.filter((f) => !sameValue(f.final_value, f.system_value));
  if (adjusted.length === 0) {
    return `${when}에 시스템 값 그대로 확정했습니다.`;
  }
  const who = adjusted.map((f) => names.get(f.user_id) ?? `#${f.user_id}`).join(", ");
  return `${when}에 확정했습니다 — ${withJosa(who, "은는")} 시스템 값과 다르게 정했습니다.`;
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

// src/lib/ui/empty.ts
function emptyHtml(state) {
  const action = state.action ? `<a class="btn btn-primary" href="${escapeHtml(state.action.href)}">${escapeHtml(state.action.label)}</a>` : "";
  return `<div class="empty-state"><p class="what">${escapeHtml(state.what)}</p><p class="why">${escapeHtml(state.why)}</p><p class="how">${escapeHtml(state.how)}</p>` + action + "</div>";
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

// src/lib/ui/skeleton.ts
var bar = (width, kind = "") => `<span class="sk${kind ? ` sk-${kind}` : ""}" style="width:${width}%"></span>`;
var wrap = (inner) => `<div class="sk-wrap" aria-hidden="true">${inner}</div>`;
function scoreCards(count = 3) {
  const one = '<article class="card">' + bar(40, "title") + bar(64, "line") + bar(100, "track") + bar(34, "line") + "</article>";
  return wrap(one.repeat(Math.max(1, count)));
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

// src/demo/contributions.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var projectId = Number(params.get("project") ?? "1");
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
var people = [];
var systemValues = /* @__PURE__ */ new Map();
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
var get = (path) => fetch(`${apiBase}${path}`, { credentials: "same-origin", cache: "no-store" });
function withEmphasis(text) {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function memberCard(member) {
  const bar2 = rangeBar(member);
  const notes = readBeforeTheNumber(member);
  const flags = integrityNotes(member);
  const noEvidence = hasNoEvidence(member);
  const categories = categoriesForDisplay(member).map((c) => {
    const share = Math.round(c.team_share * 100);
    return `<li><span class="cat">${escapeHtml(describeCategory(c.category))}</span><span class="catbar"><i style="width:${share}%"></i></span><span class="catnum">${c.event_count}건</span></li>`;
  }).join("");
  return `
<article class="card">
  <header>
    <span class="who">${escapeHtml(nameOf(member.user_id, people))}</span>
    <span class="role">${escapeHtml(roleOf(member, people))}</span>
  </header>

  <p class="range">${escapeHtml(describeRange(member))}</p>
  <div class="rangebar"><i style="left:${bar2.left}%;width:${bar2.width}%"></i></div>
  <p class="conf">신뢰도 ${escapeHtml(member.confidence_label)}</p>

  ${noEvidence ? '<p class="empty">이 사람의 활동이 아직 하나도 연결되지 않았습니다 — 0 이라는 뜻이 아니라 <strong>연결이 없다</strong>는 뜻입니다.</p>' : ""}

  ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${withEmphasis(n)}</li>`).join("")}</ul>` : ""}

  ${categories ? `<ul class="cats">${categories}</ul>` : ""}

  ${flags.length ? `<ul class="flags">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>
         <p class="flagnote">표시만 합니다 — 이 신호로 점수를 깎지 않습니다.
            판단은 팀이 합니다.</p>` : ""}
</article>`;
}
function render(score) {
  const warnings = teamWarnings(score, people);
  $("warnings").hidden = warnings.length === 0;
  $("warnings").innerHTML = warnings.map((w) => `<p>${escapeHtml(w)}</p>`).join("");
  $("notice").textContent = score.notice;
  $("meta").textContent = `${score.algo_version} · ${new Date(
    score.computed_at
  ).toLocaleString("ko-KR")} 기준`;
  if (score.members.length === 0) {
    $("members").innerHTML = emptyHtml({
      what: "여기에는 팀원별 기여 구간과 그 근거가 나옵니다.",
      why: "아직 이을 활동이 하나도 없습니다 — 아무도 안 했다는 뜻이 아닙니다.",
      how: "회의를 녹음하거나 GitHub 저장소를 연결하면 활동이 여기로 이어집니다.",
      action: { label: "프로젝트 설정", href: `/project.html?project=${projectId}` }
    });
    return;
  }
  $("members").innerHTML = orderForDisplay(score.members, people).map(memberCard).join("");
  systemValues = new Map(score.members.map((ms) => [ms.user_id, Number(ms.share.toFixed(3))]));
  renderFinalRows(score);
}
function renderFinalRows(score) {
  const rows = orderForDisplay(score.members, people);
  $("finals").innerHTML = rows.map((ms) => {
    const name = escapeHtml(nameOf(ms.user_id, people));
    const system = (systemValues.get(ms.user_id) ?? 0).toFixed(1);
    return `<div class="final-row" data-user="${ms.user_id}">
        <span class="who">${name}</span>
        <span class="sys">시스템 ${system}%</span>
        <label>확정 <input type="number" class="val" step="0.1" min="0" max="100"
          placeholder="${system}" aria-label="${name} 확정값" /></label>
        <span class="why"><input type="text" class="reason"
          placeholder="시스템 값과 다르게 정했다면 이유" aria-label="${name} 조정 이유" /></span>
      </div>`;
  }).join("");
}
function draftsFromScreen() {
  return [...$("finals").querySelectorAll(".final-row")].map((row) => {
    const raw = row.querySelector(".val")?.value.trim() ?? "";
    return {
      user_id: Number(row.dataset["user"]),
      // 빈 칸은 **0 이 아니라 "안 건드렸다"** 다. Number('') 가 0 이라
      // 여기서 안 가르면 아무것도 안 적은 사람이 0점으로 확정된다.
      final_value: raw === "" ? null : Number(raw),
      reason: row.querySelector(".reason")?.value ?? ""
    };
  });
}
async function loadFinals() {
  const response = await get(`/api/projects/${projectId}/contributions/final`);
  if (!response.ok) {
    $("final-state").textContent = "";
    return;
  }
  const body = await response.json();
  const names = new Map(people.map((p) => [p.user_id, p.name]));
  $("final-state").textContent = describeFinals(body.finals, names);
}
async function confirm() {
  const drafts = draftsFromScreen();
  const problems = problemsWith(drafts, systemValues);
  if (problems.length > 0) {
    $("final-message").textContent = problems.join(" · ");
    return;
  }
  const response = await trySend(
    () => fetch(`${apiBase}/api/projects/${projectId}/contributions/final`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ finals: toPayload(drafts, systemValues) }),
      credentials: "same-origin"
    })
  );
  if (response === null) {
    $("final-message").textContent = unreachableText("확정하지 못했습니다");
    return;
  }
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    const body = await response.json();
    $("final-message").textContent = typeof body.detail === "string" ? body.detail : "확정하지 못했습니다";
    return;
  }
  $("final-message").textContent = "확정했습니다.";
  await loadFinals();
}
async function fetchAll() {
  const [scoreRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/contributions`),
    get(`/api/projects/${projectId}/members`)
  ]);
  if (isSessionExpired(scoreRes.status)) return { kind: "expired" };
  if (!scoreRes.ok) return { kind: "failed", status: scoreRes.status };
  if (memberRes.ok) people = await memberRes.json();
  return { kind: "ok", score: await scoreRes.json() };
}
async function load() {
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($("members"), scoreCards()),
    () => clearSkeleton($("members"))
  );
  if (result.kind === "expired") {
    goToLogin();
    return;
  }
  if (result.kind === "failed") {
    $("members").innerHTML = failureHtml({
      what: "기여도를 불러오지 못했습니다.",
      help: describeHttpStatus(result.status) ?? void 0,
      code: `HTTP ${result.status}`,
      retry: true
    });
    $("members").querySelector(".retry")?.addEventListener("click", () => {
      void load();
    });
    return;
  }
  render(result.score);
  await loadFinals();
}
async function start() {
  const me = await get("/api/auth/me");
  if (!me.ok) {
    goToLogin();
    return;
  }
  $("who").textContent = `${(await me.json()).name} 님이 보고 있습니다`;
  await load();
}
$("confirm").addEventListener("click", () => void confirm());
void start();
renderNav("contributions");
bootApp();
