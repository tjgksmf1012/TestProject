// src/lib/project/setup.ts
var CODE_LENGTH = 8;
function normalizeCode(raw) {
  return raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}
function formatCode(raw) {
  const clean = normalizeCode(raw);
  return clean.length === CODE_LENGTH ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
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
    detail: `서버가 HTTP ${status} 로 답했습니다. 연결이 정상이라는 뜻은 아닙니다.`,
    tone: "warn",
    nextStep: "잠시 뒤 새로고침하세요.",
    warnings: [],
    activity: "",
    coverage: "",
    canBackfill: false
  };
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
    text: `${parts.join("과 ")}을 지웠습니다 (${describeFreed(result.freed_bytes)} 확보). 되돌릴 수 없습니다.`,
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
  home: "🏠",
  kanban: "📋",
  contributions: "📊",
  project: "⚙️"
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
      icon: TAB_ICON[screen] ?? "•",
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
      return `<a${href}${disabled}${marked}${title}><span class="ico" aria-hidden="true">${escapeHtml(tab.icon)}</span><span>${escapeHtml(tab.label)}</span></a>`;
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
      return '아이폰에서는 공유 버튼(⬆️) → "홈 화면에 추가" 를 누르면 앱처럼 쓸 수 있습니다.';
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
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: withJsonType(init?.headers),
    credentials: "same-origin",
    cache: "no-store"
  });
  if (isSessionExpired(response.status)) goToLogin();
  return response;
}
function say(id, text) {
  $(id).textContent = text;
  $(id).hidden = text === "";
}
function render(detail) {
  $("title-heading").textContent = detail.title;
  input("title").value = detail.title;
  input("repo").value = detail.github_repo ?? "";
  $("code").textContent = detail.invite_code ? formatCode(detail.invite_code) : "(없음)";
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
  status.hidden = false;
  status.textContent = "가져오는 중…";
  let response;
  try {
    response = await call(`/api/projects/${projectId}/github/backfill`, {
      method: "POST",
      body: JSON.stringify({})
    });
  } catch {
    button.disabled = false;
    status.textContent = "서버에 닿지 못했습니다. 잠시 뒤 다시 누르세요.";
    return;
  }
  if (!response.ok) {
    button.disabled = false;
    const body = await response.json().catch(() => null);
    status.textContent = detailText(
      body,
      `가져오지 못했습니다 (HTTP ${response.status})`
    );
    return;
  }
  status.textContent = "가져오기를 시작했습니다. PR 수에 따라 몇 분 걸립니다 — 잠시 뒤 이 화면을 새로고침하면 반영된 범위가 바뀝니다.";
}
async function loadHealth() {
  let response;
  try {
    response = await call(`/api/projects/${projectId}/github`);
  } catch {
    return renderHealth(describeHealthFailure(0));
  }
  if (!response.ok) return renderHealth(describeHealthFailure(response.status));
  renderHealth(describeHealth(await response.json(), /* @__PURE__ */ new Date()));
}
async function load() {
  const response = await call(`/api/projects/${projectId}`);
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
  void call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ title: input("title").value.trim() })
  }).then(async (r) => {
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
  void call(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify({ github_repo: repo })
  }).then(async (r) => {
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
  void call(`/api/projects/${projectId}/invite/rotate`, { method: "POST" }).then(
    async (r) => {
      if (r.ok) render(await r.json());
    }
  );
});
$("copy").addEventListener("click", () => {
  void navigator.clipboard.writeText($("code").textContent ?? "").then(() => {
    $("copy").textContent = "복사됨";
    setTimeout(() => $("copy").textContent = "코드 복사", 1500);
  });
});
$("open-meeting").addEventListener("click", () => {
  const title = input("meeting-title").value.trim();
  void call(`/api/projects/${projectId}/meetings`, {
    method: "POST",
    body: JSON.stringify({ title: title || null })
  }).then(async (r) => {
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
  void call(`/api/projects/${projectId}/me/data`, { method: "POST" }).then(async (response) => {
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
  }).catch(() => {
    $("del-result").className = "bad";
    say("del-result", describeRequestFailure(0));
    button.disabled = false;
  });
});
renderNav("project");
void load();
void loadHealth();
bootApp();
