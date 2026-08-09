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

// src/lib/project/setup.ts
var CODE_LENGTH = 8;
var CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
function normalizeCode(raw) {
  return raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}
function formatCode(raw) {
  const clean = normalizeCode(raw);
  return clean.length === CODE_LENGTH ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}
function codeProblem(raw) {
  const clean = normalizeCode(raw);
  if (clean.length === 0) return "초대 코드를 입력하세요";
  if (clean.length !== CODE_LENGTH) {
    return `초대 코드는 ${CODE_LENGTH}자입니다 (지금 ${clean.length}자)`;
  }
  const bad = [...clean].filter((ch) => !CODE_ALPHABET.includes(ch));
  if (bad.length > 0) {
    return `코드에 쓰지 않는 글자가 있습니다: ${[...new Set(bad)].join(", ")} — 0·O·1·I·L은 쓰지 않습니다`;
  }
  return null;
}
function titleProblem(raw) {
  const title = raw.trim();
  if (title.length === 0) return "프로젝트 이름을 입력하세요";
  if (title.length > 200) return "이름이 너무 깁니다 (200자까지)";
  return null;
}
var REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
function normalizeRepo(raw) {
  let value = raw.trim();
  if (value === "") return "";
  value = value.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  value = value.replace(/^git@github\.com:/i, "");
  value = value.replace(/\.git$/i, "");
  value = value.replace(/\/+$/, "");
  return value;
}
function repoProblem(raw) {
  const value = normalizeRepo(raw);
  if (value === "") return null;
  if (!REPO.test(value)) {
    return "저장소는 `owner/repo` 형식이어야 합니다";
  }
  return null;
}
function nextStepAfterCreate(memberCount) {
  if (memberCount <= 1) {
    return "아직 혼자입니다. 아래 초대 코드를 팀원에게 알려 주세요 — 다 모인 뒤에 회의를 여는 게 좋습니다.";
  }
  return "팀원이 모였습니다. 회의를 열면 로비에서 동의를 받고 녹음을 시작할 수 있습니다.";
}
var NO_CODE = "(없음)";
function codeToCopy(inviteCode2) {
  const raw = (inviteCode2 ?? "").trim();
  if (codeProblem(raw) !== null) return null;
  return formatCode(raw);
}
function githubLoginStatus(login) {
  const value = (login ?? "").trim();
  if (value === "") {
    return "아직 연결하지 않았습니다 — 이 상태로는 내 PR이 기여도에 들어가지 않습니다.";
  }
  return `지금 ${withJosa(value, "으로로")} 이어져 있습니다.`;
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

// src/lib/github/health.ts
var TONES = /* @__PURE__ */ new Set(["ok", "warn", "bad"]);
function describeLastDelivery(iso, now) {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1e3);
  if (seconds < 60) return "방금";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 전`;
  return `${Math.floor(seconds / 86400)}일 전`;
}
function describeActivity(health, now) {
  if (health.delivery_count <= 0) return "";
  const when = describeLastDelivery(health.last_delivery_at, now);
  const count = `배달 ${health.delivery_count}건`;
  return when ? `${count} · 마지막 ${when}` : count;
}
function describeHealth(health, now) {
  return {
    headline: health.headline,
    detail: health.detail,
    // 서버가 모르는 값을 보내면 **좋은 쪽으로 넘기지 않습니다.** 연결이
    // 정상이라고 잘못 말하는 것이 모른다고 말하는 것보다 나쁩니다.
    tone: TONES.has(health.severity) ? health.severity : "warn",
    nextStep: health.next_step,
    warnings: health.warnings ?? [],
    activity: describeActivity(health, now),
    coverage: health.coverage ?? "",
    canBackfill: health.delivery_count > 0 && !health.backfilled_at
  };
}
function describeHealthFailure(status) {
  if (status === 403) {
    return {
      headline: "이 프로젝트의 구성원만 볼 수 있습니다",
      detail: "연결 상태에는 저장소 이름이 들어 있어 팀 밖에는 보여주지 않습니다.",
      tone: "warn",
      nextStep: null,
      warnings: [],
      activity: "",
      coverage: "",
      canBackfill: false
    };
  }
  if (status === 0) {
    return {
      headline: "연결 상태를 확인하지 못했습니다",
      detail: "서버에 닿지 못했습니다. 인터넷 연결을 확인하세요.",
      tone: "warn",
      nextStep: "잠시 뒤 새로고침하세요.",
      warnings: [],
      activity: "",
      coverage: "",
      canBackfill: false
    };
  }
  return {
    headline: "연결 상태를 확인하지 못했습니다",
    detail: `서버가 ${withJosa(`HTTP ${status}`, "으로로")} 답했습니다. 연결이 정상이라는 뜻은 아닙니다.`,
    tone: "warn",
    nextStep: "잠시 뒤 새로고침하세요.",
    warnings: [],
    activity: "",
    coverage: "",
    canBackfill: false
  };
}

// src/lib/contribution/roles.ts
var ROLE_OPTIONS = [
  { key: "developer", label: "개발", hint: "코드 35% · 업무 30%" },
  { key: "planner", label: "기획", hint: "문서 30% · 업무 30% · 코드 0%" },
  { key: "designer", label: "디자인", hint: "문서 35% · 업무 30% · 코드 0%" }
];
function sumOf(shares) {
  const total = Object.values(shares).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return Math.round(total * 1e6) / 1e6;
}
function problemWith(shares) {
  if (Object.values(shares).some((v) => !Number.isFinite(v))) {
    return "숫자가 아닌 값이 있습니다";
  }
  if (Object.values(shares).some((v) => v < 0)) {
    return "역할 비중은 음수일 수 없습니다";
  }
  const total = sumOf(shares);
  if (total === 0) return "역할을 하나 이상 골라야 합니다";
  if (Math.abs(total - 1) > 1e-6) {
    return `합이 1 이어야 합니다 (지금 ${total})`;
  }
  return null;
}
function toPayload(shares) {
  const out = {};
  for (const [key, value] of Object.entries(shares)) {
    if (value > 0) out[key] = value;
  }
  return out;
}
function describeRoles(shares) {
  const entries = Object.entries(shares ?? {}).filter(([, v]) => v > 0);
  if (entries.length === 0) return "역할이 정해지지 않았습니다.";
  const label = (key) => ROLE_OPTIONS.find((o) => o.key === key)?.label ?? key;
  if (entries.length === 1) return `${label(entries[0]?.[0] ?? "")} 100%`;
  return entries.sort((a, b) => b[1] - a[1]).map(([key, value]) => `${label(key)} ${Math.round(value * 100)}%`).join(" · ");
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

// src/lib/privacy/deletion.ts
function whatGetsDeleted() {
  return [
    "내 목소리가 녹음된 원본 파일 (이 프로젝트의 모든 회의)",
    "내 성문 — 목소리로 나를 알아보는 데 쓰는 데이터"
  ];
}
function whatRemains() {
  return [
    "회의록의 발화 텍스트 — 다른 참석자의 회의록이기도 합니다",
    "칸반 업무와 GitHub 활동 기록 — 음성이 아니라 작업 기록입니다"
  ];
}
function whatHappensToMyScore() {
  return "아직 처리되지 않은 회의는 발언량을 잴 수 없게 되어 내 회의 기여가 **측정 불가**로 표시됩니다. 0점이 되는 것은 아니고, 나머지 활동으로 기여도를 계산합니다. 이미 회의록이 만들어진 회의는 그 텍스트가 남아 있어 그대로 계산됩니다.";
}
function confirmPrompt() {
  return "내 녹음 원본과 성문을 지웁니다.\n\n되돌릴 수 없습니다. 회의록의 발화 텍스트는 남습니다.\n\n계속할까요?";
}
function describeFreed(bytes) {
  if (bytes <= 0) return "없음";
  if (bytes < 1024) return `${bytes}바이트`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function describeOutcome(result) {
  const failedCount = Object.keys(result.failed ?? {}).length;
  if (failedCount > 0) {
    return {
      text: `${failedCount}건을 지우지 못했습니다. 남아 있는 것은 그대로입니다 — 다시 시도해 주세요. 계속 실패하면 팀에 알려 주세요.`,
      needsRetry: true,
      deletedSomething: result.deleted_assets > 0
    };
  }
  if (result.deleted_assets === 0 && result.revoked_voiceprints === 0) {
    return {
      text: "지울 녹음이 없습니다. 이 프로젝트에 남아 있던 내 음성 자료가 없습니다.",
      needsRetry: false,
      deletedSomething: false
    };
  }
  const parts = [];
  if (result.deleted_assets > 0) parts.push(`녹음 원본 ${result.deleted_assets}건`);
  if (result.revoked_voiceprints > 0) {
    parts.push(`성문 ${result.revoked_voiceprints}건`);
  }
  return {
    text: (
      // ⚠️ `…을` 을 글자로 붙이지 않는다. 지금은 목록이 늘 `…건` 으로
      // 끝나 맞지만, 단위를 바꾸는 순간 조용히 틀린 조사가 된다 (결함 88).
      `${withJosa(parts.join("과 "), "을를")} 지웠습니다 (${describeFreed(result.freed_bytes)} 확보). 되돌릴 수 없습니다.`
    ),
    needsRetry: false,
    deletedSomething: true
  };
}
function describeRequestFailure(status, detail) {
  if (status === 401) return "로그인이 풀렸습니다. 다시 로그인한 뒤 시도하세요.";
  if (status === 403) return "이 프로젝트의 구성원만 요청할 수 있습니다.";
  if (status === 0) return "서버에 연결하지 못했습니다. 아무것도 지워지지 않았습니다.";
  return (detail || `요청이 실패했습니다 (HTTP ${status})`) + ". 아무것도 지워지지 않았을 수 있습니다 — 다시 확인해 주세요.";
}

// src/lib/ui/failure.ts
function showNote(slot, text, tone = "bad") {
  slot.textContent = text;
  slot.hidden = text === "";
  slot.classList.toggle("bad", text !== "" && tone === "bad");
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
var wrap = (inner) => `<div class="sk-wrap" aria-hidden="true">${inner}</div>`;
var ROW_WIDTHS = [86, 64, 74, 58, 80];
function rows(count = 3) {
  const list = Array.from(
    { length: Math.max(1, count) },
    (_, i) => `<div class="sk-line">${bar(ROW_WIDTHS[i % ROW_WIDTHS.length] ?? 70, "line")}</div>`
  ).join("");
  return wrap(list);
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

// src/demo/project.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var projectId = Number(params.get("project") ?? "0");
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
var input = (id) => $(id);
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
function withJsonType(given) {
  const headers = new Headers(given);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return headers;
}
async function call(path, init) {
  const response = await trySend(
    () => fetch(`${apiBase}${path}`, {
      ...init,
      headers: withJsonType(init?.headers),
      credentials: "same-origin",
      cache: "no-store"
    })
  );
  if (response !== null && isSessionExpired(response.status)) goToLogin();
  return response;
}
var send = (path, init) => call(path, init);
function say(id, text) {
  $(id).textContent = text;
  $(id).hidden = text === "";
}
var inviteCode = null;
function render(detail) {
  $("title-heading").textContent = detail.title;
  input("title").value = detail.title;
  input("repo").value = detail.github_repo ?? "";
  inviteCode = detail.invite_code || null;
  $("code").textContent = inviteCode ? formatCode(inviteCode) : NO_CODE;
  $("code").classList.toggle("none", inviteCode === null);
  const button = $("copy");
  button.disabled = inviteCode === null;
  button.title = inviteCode === null ? "초대 코드가 없습니다 — 새로 만들어 주세요" : "";
  $("members").textContent = `팀원 ${detail.member_count}명`;
  say("next", nextStepAfterCreate(detail.member_count));
}
function withCode(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}
function renderHealth(view) {
  $("gh-health").className = `health ${view.tone}`;
  $("gh-headline").innerHTML = withCode(view.headline);
  $("gh-detail").innerHTML = withCode(view.detail);
  $("gh-next").innerHTML = view.nextStep ? withCode(view.nextStep) : "";
  $("gh-next").hidden = !view.nextStep;
  $("gh-warnings").innerHTML = view.warnings.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  $("gh-activity").textContent = view.activity;
  $("gh-activity").hidden = view.activity === "";
  $("gh-coverage").textContent = view.coverage;
  $("gh-coverage").hidden = view.coverage === "";
  $("gh-backfill").hidden = !view.canBackfill;
}
async function startBackfill() {
  const button = $("gh-backfill");
  const status = $("gh-backfill-status");
  button.disabled = true;
  showNote(status, "가져오는 중…", "plain");
  const response = await send(`/api/projects/${projectId}/github/backfill`, {
    method: "POST",
    body: JSON.stringify({})
  });
  if (response === null) {
    button.disabled = false;
    showNote(status, unreachableText("가져오지 못했습니다"));
    return;
  }
  if (!response.ok) {
    button.disabled = false;
    const body = await response.json().catch(() => null);
    showNote(
      status,
      detailText(body, `가져오지 못했습니다 (HTTP ${response.status})`)
    );
    return;
  }
  showNote(
    status,
    "가져오기를 시작했습니다. PR 수에 따라 몇 분 걸립니다 — 잠시 뒤 이 화면을 새로고침하면 반영된 범위가 바뀝니다.",
    "plain"
  );
}
function renderRoles(shares) {
  $("roles").innerHTML = ROLE_OPTIONS.map(
    (opt) => `<label>
      <span>${escapeHtml(opt.label)}</span>
      <input type="number" class="rshare" data-role="${opt.key}" step="0.1" min="0" max="1"
        value="${shares[opt.key] ?? 0}" aria-label="${escapeHtml(opt.label)} 비중" />
      <span class="hint">${escapeHtml(opt.hint)}</span>
    </label>`
  ).join("");
  for (const input2 of $("roles").querySelectorAll(".rshare")) {
    input2.addEventListener("input", showRoleSum);
  }
  showRoleSum();
}
function rolesFromScreen() {
  const out = {};
  for (const input2 of $("roles").querySelectorAll(".rshare")) {
    const raw = input2.value.trim();
    out[input2.dataset["role"] ?? ""] = raw === "" ? 0 : Number(raw);
  }
  return out;
}
function showRoleSum() {
  const total = sumOf(rolesFromScreen());
  const bad = Math.abs(total - 1) > 1e-6;
  $("role-sum").textContent = `합계 ${total}`;
  $("role-sum").classList.toggle("bad", bad);
}
async function loadRoles() {
  const response = await call(`/api/projects/${projectId}/members`);
  if (response === null || !response.ok) return;
  const members = await response.json();
  const meRes = await call("/api/auth/me");
  if (meRes === null || !meRes.ok) return;
  const me = await meRes.json();
  const mine = members.find((entry) => entry.user_id === me.user_id);
  renderRoles(mine?.role_shares ?? {});
  showNote($("role-message"), `지금 ${describeRoles(mine?.role_shares)}`, "plain");
  $("gh-login").value = mine?.github_login ?? "";
  showNote($("gh-login-message"), githubLoginStatus(mine?.github_login ?? null), "plain");
}
async function saveRoles() {
  const shares = rolesFromScreen();
  const problem = problemWith(shares);
  if (problem !== null) {
    showNote($("role-message"), problem);
    return;
  }
  const response = await send(`/api/projects/${projectId}/members/me`, {
    method: "PATCH",
    body: JSON.stringify({ role_shares: toPayload(shares) })
  });
  if (response === null) {
    showNote($("role-message"), unreachableText("역할을 저장하지 못했습니다"));
    return;
  }
  const body = await response.json();
  if (!response.ok) {
    showNote($("role-message"), detailText(body, "역할을 저장하지 못했습니다"));
    return;
  }
  showNote($("role-message"), `저장했습니다 — ${describeRoles(body.role_shares)}`, "plain");
}
async function saveGithubLogin() {
  const typed = $("gh-login").value;
  const response = await send(`/api/projects/${projectId}/members/me/github`, {
    method: "PATCH",
    body: JSON.stringify({ github_login: typed })
  });
  if (response === null) {
    showNote($("gh-login-message"), unreachableText("GitHub 계정을 저장하지 못했습니다"));
    return;
  }
  const body = await response.json();
  if (!response.ok) {
    showNote($("gh-login-message"), detailText(body, "GitHub 계정을 저장하지 못했습니다"));
    return;
  }
  $("gh-login").value = body.github_login ?? "";
  showNote($("gh-login-message"), githubLoginStatus(body.github_login ?? null), "plain");
  void loadHealth();
}
async function loadHealth() {
  const response = await whileLoading(
    call(`/api/projects/${projectId}/github`),
    () => showSkeleton($("gh-headline"), rows(1)),
    () => clearSkeleton($("gh-headline"))
  );
  if (response === null) return renderHealth(describeHealthFailure(0));
  if (!response.ok) return renderHealth(describeHealthFailure(response.status));
  renderHealth(describeHealth(await response.json(), /* @__PURE__ */ new Date()));
}
async function load() {
  const response = await call(`/api/projects/${projectId}`);
  if (response === null) {
    say("error", unreachableText("프로젝트를 불러오지 못했습니다"));
    return;
  }
  if (!response.ok) {
    say(
      "error",
      response.status === 403 ? "이 프로젝트의 구성원만 볼 수 있습니다." : `불러오지 못했습니다 (HTTP ${response.status})`
    );
    return;
  }
  render(await response.json());
}
$("save-title").addEventListener("click", () => {
  const problem = titleProblem(input("title").value);
  if (problem) return say("error", problem);
  void whilePressed($("save-title"), async () => {
    const r = await send(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: input("title").value.trim() })
    });
    if (r === null) return say("error", unreachableText("이름을 바꾸지 못했습니다"));
    say("error", r.ok ? "" : `이름을 바꾸지 못했습니다 (HTTP ${r.status})`);
    if (r.ok) render(await r.json());
  });
});
$("save-repo").addEventListener("click", () => {
  const raw = input("repo").value;
  const problem = repoProblem(raw);
  if (problem) return say("error", problem);
  const repo = normalizeRepo(raw);
  input("repo").value = repo;
  void whilePressed($("save-repo"), async () => {
    const r = await send(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ github_repo: repo })
    });
    if (r === null) return say("error", unreachableText("저장하지 못했습니다"));
    if (r.status === 409) return say("error", "다른 프로젝트가 이미 이 저장소를 쓰고 있습니다.");
    say("error", r.ok ? "" : `저장하지 못했습니다 (HTTP ${r.status})`);
    if (!r.ok) return;
    render(await r.json());
    void loadHealth();
  });
});
$("gh-backfill").addEventListener("click", () => {
  void startBackfill();
});
$("rotate").addEventListener("click", () => {
  const ok = confirm(
    "초대 코드를 새로 만듭니다.\n지금 코드는 그 즉시 통하지 않습니다. 계속할까요?"
  );
  if (!ok) return;
  void whilePressed($("rotate"), async () => {
    const r = await send(`/api/projects/${projectId}/invite/rotate`, { method: "POST" });
    if (r === null) return say("error", unreachableText("코드를 새로 만들지 못했습니다"));
    if (!r.ok) return say("error", `코드를 새로 만들지 못했습니다 (HTTP ${r.status})`);
    say("error", "");
    render(await r.json());
  });
});
$("copy").addEventListener("click", () => {
  const text = codeToCopy(inviteCode);
  if (text === null) return;
  void copyText(text, navigator.clipboard).then((outcome) => {
    if (copySucceeded(outcome)) {
      showNote($("copy-note"), "");
      $("copy").textContent = describeCopy(outcome, "코드");
      setTimeout(() => $("copy").textContent = "코드 복사", 1500);
      return;
    }
    showNote($("copy-note"), describeCopy(outcome, "코드"));
  });
});
$("open-meeting").addEventListener("click", () => {
  const title = input("meeting-title").value.trim();
  void whilePressed($("open-meeting"), async () => {
    const r = await send(`/api/projects/${projectId}/meetings`, {
      method: "POST",
      body: JSON.stringify({ title: title || null })
    });
    if (r === null) return say("error", unreachableText("회의를 열지 못했습니다"));
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      return say(
        "error",
        detailText(body, `회의를 열지 못했습니다 (HTTP ${r.status})`)
      );
    }
    const created = await r.json();
    location.href = `/lobby.html?meeting=${created.meeting_id}`;
  });
});
function bullets(id, lines) {
  $(id).innerHTML = lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
}
bullets("del-gone", whatGetsDeleted());
bullets("del-kept", whatRemains());
$("del-score").innerHTML = escapeHtml(whatHappensToMyScore()).replace(
  /\*\*([^*]+)\*\*/g,
  "<strong>$1</strong>"
);
$("del-run").addEventListener("click", () => {
  if (!confirm(confirmPrompt())) return;
  const button = $("del-run");
  button.disabled = true;
  $("del-result").className = "";
  say("del-result", "지우는 중…");
  void send(`/api/projects/${projectId}/me/data`, { method: "POST" }).then(async (response) => {
    if (response === null) {
      $("del-result").className = "bad";
      say("del-result", describeRequestFailure(0));
      button.disabled = false;
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      $("del-result").className = "bad";
      say(
        "del-result",
        describeRequestFailure(response.status, detailText(body, "") || void 0)
      );
      button.disabled = false;
      return;
    }
    const outcome = describeOutcome(await response.json());
    $("del-result").className = outcome.needsRetry ? "bad" : "";
    say("del-result", outcome.text);
    button.disabled = !outcome.needsRetry;
  });
});
renderNav("project");
$("save-gh-login").addEventListener("click", () => {
  void whilePressed($("save-gh-login"), saveGithubLogin);
});
$("save-roles").addEventListener("click", () => {
  void whilePressed($("save-roles"), saveRoles);
});
void load();
void loadHealth();
void loadRoles();
bootApp();
