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
function nextStepFor(meeting) {
  const id = meeting.meeting_id;
  switch (meeting.status) {
    case "pending":
      return {
        href: `/lobby.html?meeting=${id}`,
        label: "회의 로비로",
        reason: "동의를 받고 녹음을 시작합니다",
        actionable: true
      };
    case "queued":
    case "processing":
      return {
        href: "",
        label: "",
        reason: "처리 중입니다 — 끝나면 검토할 업무 후보가 나옵니다",
        actionable: false
      };
    case "needs_review":
      if (meeting.pending_candidates === 0) {
        return {
          href: `/kanban.html?meeting=${id}`,
          label: "칸반 보기",
          reason: "검토할 업무 후보가 없습니다 — 회의에서 업무가 나오지 않았습니다",
          actionable: false
        };
      }
      return {
        href: `/review.html?meeting=${id}`,
        label: `업무 후보 ${meeting.pending_candidates}건 검토`,
        reason: "승인해야 칸반에 등록됩니다 — AI 가 만든 업무는 사람을 거칩니다",
        actionable: true
      };
    case "confirmed":
      return {
        href: `/kanban.html?meeting=${id}`,
        label: "칸반 보기",
        reason: "검토를 마쳤습니다",
        actionable: false
      };
    case "failed":
      return {
        href: `/lobby.html?meeting=${id}`,
        label: "트랙 상태 보기",
        reason: "처리에 실패했습니다 — 트랙이 온전한지 확인하세요",
        actionable: true
      };
    default:
      return {
        href: `/lobby.html?meeting=${id}`,
        label: "회의 열기",
        reason: `알 수 없는 상태입니다: ${meeting.status}`,
        actionable: false
      };
  }
}
function describeProject(project) {
  if (project.meeting_count === 0) {
    return `팀원 ${project.member_count}명 · 아직 회의가 없습니다`;
  }
  if (project.needs_review > 0) {
    return `팀원 ${project.member_count}명 · 회의 ${project.meeting_count}개 · 검토할 회의 ${project.needs_review}개`;
  }
  return `팀원 ${project.member_count}명 · 회의 ${project.meeting_count}개`;
}
function orderProjects(projects) {
  return [...projects].sort((a, b) => {
    if ((b.needs_review > 0 ? 1 : 0) !== (a.needs_review > 0 ? 1 : 0)) {
      return b.needs_review > 0 ? 1 : -1;
    }
    return a.project_id - b.project_id;
  });
}
function emptyProjectsMessage() {
  return "속한 프로젝트가 없습니다. 아래에서 새로 만들거나, 팀원에게 받은 초대 코드로 참가하세요.";
}
function formatMeetingTime(iso, locale = "ko-KR") {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleString(locale, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
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
    return `코드에 쓰지 않는 글자가 있습니다: ${[...new Set(bad)].join(", ")} — 0·O·1·I·L 은 쓰지 않습니다`;
  }
  return null;
}
function titleProblem(raw) {
  const title = raw.trim();
  if (title.length === 0) return "프로젝트 이름을 입력하세요";
  if (title.length > 200) return "이름이 너무 깁니다 (200자까지)";
  return null;
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
function projectCards(count = 2) {
  const one = '<section class="card">' + bar(52, "title") + bar(78, "line") + `<div class="sk-row">${bar(22, "btn")}${bar(22, "btn")}${bar(22, "btn")}</div></section>`;
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
      return '아이폰에서는 화면 아래 가운데의 공유 버튼(상자에서 위로 나가는 화살표) → "홈 화면에 추가" 를 누르면 앱처럼 쓸 수 있습니다.';
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

// src/demo/home.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
var get = (path) => fetch(`${apiBase}${path}`, { credentials: "same-origin", cache: "no-store" });
function meetingHtml(meeting) {
  const step = nextStepFor(meeting);
  return `
<li class="meeting${step.actionable ? " todo" : ""}">
  <div class="head">
    <span class="name">${escapeHtml(meeting.title ?? "제목 없는 회의")}</span>
    <span class="when">${escapeHtml(formatMeetingTime(meeting.started_at))}</span>
  </div>
  <p class="status">${escapeHtml(describeMeetingStatus(meeting.status))}
     — ${escapeHtml(step.reason)}</p>
  ${step.href ? `<a class="btn btn-block${step.actionable ? " btn-primary" : ""}"
             href="${escapeHtml(step.href)}">${escapeHtml(step.label)}</a>` : ""}
</li>`;
}
function projectHtml(project, meetings) {
  const links = `<a class="btn" href="/kanban.html?project=${project.project_id}">칸반</a><a class="btn" href="/contributions.html?project=${project.project_id}">기여도</a><a class="btn" href="/project.html?project=${project.project_id}">설정</a>`;
  return `
<section class="card project">
  <h2>${escapeHtml(project.title)}</h2>
  <p class="sub">${escapeHtml(describeProject(project))}</p>
  <div class="links">${links}</div>
  ${meetings.length ? `<ul class="meetings">${meetings.map(meetingHtml).join("")}</ul>` : '<p class="empty">회의를 열면 여기에 나옵니다.</p>'}
</section>`;
}
async function fetchAll() {
  const response = await get("/api/projects");
  if (isSessionExpired(response.status)) return { kind: "expired" };
  if (!response.ok) return { kind: "failed", status: response.status };
  const projects = orderProjects(await response.json());
  if (projects.length === 0) {
    return {
      kind: "ok",
      hasProjects: false,
      html: `<p class="empty">${escapeHtml(emptyProjectsMessage())}</p>`
    };
  }
  const meetings = await Promise.all(
    projects.map(
      (p) => get(`/api/projects/${p.project_id}/meetings`).then(
        (r) => r.ok ? r.json() : []
      )
    )
  );
  return {
    kind: "ok",
    hasProjects: true,
    html: projects.map((p, i) => projectHtml(p, meetings[i] ?? [])).join("")
  };
}
async function load() {
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($("projects"), projectCards()),
    () => clearSkeleton($("projects"))
  );
  if (result.kind === "expired") {
    goToLogin();
    return;
  }
  if (result.kind === "failed") {
    $("projects").innerHTML = failureHtml({
      what: "프로젝트 목록을 불러오지 못했습니다.",
      help: describeHttpStatus(result.status) ?? void 0,
      code: `HTTP ${result.status}`,
      retry: true
    });
    $("projects").querySelector(".retry")?.addEventListener("click", () => {
      void load();
    });
    return;
  }
  $("projects").innerHTML = result.html;
  $("create").classList.toggle("primary", !result.hasProjects);
}
var input = (id) => $(id);
function say(text) {
  $("start-error").textContent = text;
  $("start-error").hidden = text === "";
}
$("create").addEventListener("click", () => {
  const raw = input("new-title").value;
  const problem = titleProblem(raw);
  if (problem) return say(problem);
  say("");
  void fetch(`${apiBase}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ title: raw.trim() })
  }).then(async (response) => {
    if (!response.ok) {
      if (isSessionExpired(response.status)) return goToLogin();
      const body = await response.json().catch(() => null);
      return say(detailText(body, `만들지 못했습니다 (HTTP ${response.status})`));
    }
    const created = await response.json();
    location.href = `/project.html?project=${created.project_id}`;
  });
});
$("join").addEventListener("click", () => {
  const raw = input("code").value;
  const problem = codeProblem(raw);
  if (problem) return say(problem);
  say("");
  void fetch(`${apiBase}/api/projects/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ invite_code: normalizeCode(raw) })
  }).then(async (response) => {
    if (!response.ok) {
      if (isSessionExpired(response.status)) return goToLogin();
      const body = await response.json().catch(() => null);
      return say(detailText(body, `참가하지 못했습니다 (HTTP ${response.status})`));
    }
    const joined = await response.json();
    location.href = `/project.html?project=${joined.project_id}`;
  });
});
input("code").addEventListener("blur", () => {
  const clean = normalizeCode(input("code").value);
  if (clean.length === CODE_LENGTH) input("code").value = formatCode(clean);
});
$("logout").addEventListener("click", () => {
  void fetch(`${apiBase}/api/auth/logout`, {
    method: "POST",
    credentials: "same-origin"
  }).then(() => {
    location.href = "/login.html";
  });
});
async function start() {
  const me = await get("/api/auth/me");
  if (!me.ok) {
    goToLogin();
    return;
  }
  $("who").textContent = `${(await me.json()).name} 님`;
  await load();
}
void start();
renderNav("home");
bootApp();
