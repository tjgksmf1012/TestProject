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
async function call(path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers ?? {} },
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
  $("gh-state").textContent = detail.github_connected ? "GitHub App 설치 id 가 연결돼 있습니다" : "설치 id 가 없습니다 — 저장소를 연결해도 PR 기여도는 수집되지 않습니다";
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
    if (r.ok) render(await r.json());
  });
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
      const body = await r.json().catch(() => ({}));
      return say("error", body.detail ?? `회의를 열지 못했습니다 (HTTP ${r.status})`);
    }
    const created = await r.json();
    location.href = `/lobby.html?meeting=${created.meeting_id}`;
  });
});
renderNav("project");
void load();
bootApp();
