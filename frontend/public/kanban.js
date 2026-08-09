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

// src/lib/kanban/board.ts
var STATUS_LABEL = {
  todo: "할 일",
  in_progress: "진행 중",
  done: "완료"
};
function describeStatus(status) {
  return STATUS_LABEL[status] ?? status;
}
function toColumns(tasks2, statuses2) {
  const known = new Set(statuses2);
  const columns = statuses2.map((status) => ({
    status,
    label: describeStatus(status),
    tasks: []
  }));
  const strays = [];
  for (const task of tasks2) {
    if (known.has(task.status)) {
      columns.find((c) => c.status === task.status)?.tasks.push(task);
    } else {
      strays.push(task);
    }
  }
  for (const column of columns) column.tasks = sortForBoard(column.tasks);
  if (strays.length > 0) {
    columns.push({ status: "__unknown__", label: "알 수 없는 상태", tasks: strays });
  }
  return columns;
}
function sortForBoard(tasks2) {
  return [...tasks2].sort((a, b) => {
    if (a.deadline !== b.deadline) {
      if (a.deadline === null) return 1;
      if (b.deadline === null) return -1;
      return a.deadline < b.deadline ? -1 : 1;
    }
    return a.id - b.id;
  });
}
function localDateOf(instant) {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
function isOverdue(task, today) {
  if (task.deadline === null) return false;
  if (task.status === "done") {
    if (!task.completed_at) return false;
    const completedOn = localDateOf(task.completed_at);
    if (completedOn === null) return false;
    return completedOn > task.deadline;
  }
  return task.deadline < today;
}
function isDueSoon(task, today, withinDays = 2) {
  if (task.deadline === null || task.status === "done") return false;
  if (task.deadline < today) return false;
  return daysBetween(today, task.deadline) <= withinDays;
}
function daysBetween(from, to) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 864e5);
}
function nextStatuses(task, statuses2) {
  return statuses2.filter((s) => s !== task.status);
}
function taskWarnings(task, today) {
  const warnings = [];
  if (task.assignee_id === null) {
    warnings.push("담당자가 없습니다 — 완료해도 기여도에 반영되지 않습니다");
  }
  if (isOverdue(task, today)) {
    warnings.push(
      task.status === "done" ? `마감일(${task.deadline})보다 늦게 완료했습니다` : `마감일(${task.deadline})이 지났습니다`
    );
  } else if (isDueSoon(task, today)) {
    const days = daysBetween(today, task.deadline ?? today);
    warnings.push(days === 0 ? "오늘이 마감입니다" : `마감이 ${days}일 남았습니다`);
  }
  return warnings;
}
function describePull(link) {
  const where = link.number === null ? link.repo : `${link.repo}#${link.number}`;
  return link.title ? `${where} ${link.title}` : where;
}
function sortLinks(links) {
  return [...links].sort((a, b) => {
    if (a.relevance !== b.relevance) return b.relevance - a.relevance;
    return b.merged_at.localeCompare(a.merged_at);
  });
}
function describeLinkState(task) {
  const links = task.github ?? [];
  if (links.length === 0) {
    return `연결된 PR이 없습니다 — PR 제목이나 본문에 ${withJosa(task.marker, "을를")} 적으면 붙습니다`;
  }
  const sure = links.filter((link) => link.confirmed).length;
  if (sure === links.length) return `PR ${links.length}건`;
  if (sure === 0) return `PR ${links.length}건 (전부 추정 — 확인 필요)`;
  return `PR ${links.length}건 (확정 ${sure} · 추정 ${links.length - sure})`;
}
function summarize(tasks2, today) {
  return {
    total: tasks2.length,
    done: tasks2.filter((t) => t.status === "done").length,
    overdue: tasks2.filter((t) => isOverdue(t, today)).length,
    fromMeetings: tasks2.filter((t) => t.origin !== null).length,
    unassigned: tasks2.filter((t) => t.assignee_id === null).length,
    withPulls: tasks2.filter((t) => (t.github ?? []).length > 0).length
  };
}
function statusPatch(status) {
  return { status };
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
function board(columns = 3, cardsPerColumn = 2) {
  const card = `<div class="card">${bar(72, "line")}${bar(44, "line")}</div>`;
  const column = `<section class="col">${bar(30, "title")}${card.repeat(Math.max(1, cardsPerColumn))}</section>`;
  return wrap(column.repeat(Math.max(1, columns)));
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

// src/demo/kanban.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var projectId = Number(params.get("project") ?? "1");
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
var tasks = [];
var statuses = [];
var members = [];
function todayIso() {
  const now = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
var get = (path) => fetch(`${apiBase}${path}`, { credentials: "same-origin", cache: "no-store" });
function memberName(userId) {
  if (userId === null) return "담당자 없음";
  return members.find((m) => m.user_id === userId)?.name ?? `사용자 #${userId}`;
}
function cardHtml(task, today) {
  const warnings = taskWarnings(task, today);
  const moves = nextStatuses(task, statuses).map(
    (s) => (
      // ⚠️ `…로` 를 글자로 붙이면 안 된다. `진행 중` 은 받침이 있어
      // `진행 중으로` 다 — 붙여 놓은 동안 버튼에 **"진행 중로"** 가 떴다.
      `<button class="move" data-id="${task.id}" data-to="${escapeHtml(s)}">${escapeHtml(withJosa(describeStatus(s), "으로로"))}</button>`
    )
  ).join("");
  return `
<article class="task" data-id="${task.id}">
  <p class="title">${escapeHtml(task.title)}</p>
  <p class="meta">
    ${escapeHtml(memberName(task.assignee_id))}
    ${task.deadline ? ` · 마감 ${escapeHtml(task.deadline)}` : ""}
  </p>
  ${// ⭐ 이 프로젝트의 주장이 화면에서 보이는 지점.
  // 이게 없으면 이 화면은 그냥 할 일 목록이다.
  task.origin ? `<p class="origin">${iconSvg("meeting")} ${escapeHtml(task.origin.meeting_title ?? "회의")}에서 나온 업무
           · 근거 발화 ${task.origin.evidence_utterance_ids.length}건</p>` : '<p class="origin manual">손으로 만든 업무</p>'}
  ${// ⭐ 대표 주장의 마지막 칸 — **이 업무가 어느 PR 로 끝났는가.**
  //
  // `task_github_links` 표는 처음부터 있었지만 잇는 코드가 0곳이라
  // 행이 한 번도 쓰인 적이 없었습니다. 여기가 그게 눈에 보이는 자리입니다.
  githubHtml(task)}
  ${warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
  <div class="moves">${moves}</div>
</article>`;
}
function githubHtml(task) {
  const links = sortLinks(task.github ?? []);
  if (links.length === 0) {
    return `<p class="gh none">${escapeHtml(describeLinkState(task))}</p>`;
  }
  const items = links.map(
    (link) => `<li class="${link.confirmed ? "sure" : "guess"}">${escapeHtml(describePull(link))}<span class="why">${escapeHtml(link.why)}</span></li>`
  ).join("");
  return `<p class="gh">${escapeHtml(describeLinkState(task))}</p><ul class="gh-list">${items}</ul>`;
}
function render() {
  const today = todayIso();
  const summary = summarize(tasks, today);
  $("counts").textContent = `전체 ${summary.total} · 완료 ${summary.done} · 지연 ${summary.overdue} · 회의에서 나온 업무 ${summary.fromMeetings} · PR이 붙은 업무 ${summary.withPulls}`;
  $("unassigned").hidden = summary.unassigned === 0;
  $("unassigned").textContent = `담당자가 없는 업무 ${summary.unassigned}건은 완료해도 기여도에 반영되지 않습니다.`;
  if (summary.total === 0) {
    $("board").innerHTML = emptyHtml({
      what: "여기에는 팀의 업무 카드가 단계별로 놓입니다.",
      why: "아직 등록된 업무가 하나도 없습니다 — 고장이 아닙니다.",
      how: "회의를 열어 녹음하면 AI가 업무 후보를 뽑고, 승인한 것이 여기로 옵니다. 직접 만들 수도 있습니다.",
      action: { label: "회의 열기", href: `/project.html?project=${projectId}` }
    });
    return;
  }
  $("board").innerHTML = toColumns(tasks, statuses).map(
    (column) => `
<section class="col">
  <h2>${escapeHtml(column.label)} <span class="n">${column.tasks.length}</span></h2>
  ${column.tasks.map((t) => cardHtml(t, today)).join("") || '<p class="empty">비어 있음</p>'}
</section>`
  ).join("");
  for (const button of document.querySelectorAll(".move")) {
    button.addEventListener("click", () => {
      void whilePressed(button, () => move(Number(button.dataset.id), button.dataset.to ?? ""));
    });
  }
}
async function move(taskId, to) {
  const response = await trySend(
    () => fetch(`${apiBase}/api/projects/${projectId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // ⚠️ `statusPatch` 를 쓴다. 손으로 객체를 만들면서 `deadline: null` 을
      // 넣으면 서버가 마감일을 지운다.
      body: JSON.stringify(statusPatch(to)),
      credentials: "same-origin"
    })
  );
  if (response === null) {
    $("result").textContent = unreachableText("옮기지 못했습니다");
    return;
  }
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    $("result").textContent = `옮기지 못했습니다 (HTTP ${response.status})`;
    return;
  }
  const updated = await response.json();
  tasks = tasks.map((t) => t.id === updated.id ? updated : t);
  $("result").textContent = "";
  render();
}
async function fetchAll() {
  const [boardRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/tasks`),
    get(`/api/projects/${projectId}/members`)
  ]);
  if (isSessionExpired(boardRes.status)) return { kind: "expired" };
  if (!boardRes.ok) return { kind: "failed", status: boardRes.status };
  const payload = await boardRes.json();
  statuses = payload.statuses;
  tasks = payload.tasks;
  if (memberRes.ok) members = await memberRes.json();
  return { kind: "ok" };
}
async function load() {
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($("board"), board(3)),
    () => clearSkeleton($("board"))
  );
  if (result.kind === "expired") {
    goToLogin();
    return;
  }
  if (result.kind === "failed") {
    $("board").innerHTML = failureHtml({
      what: "업무를 불러오지 못했습니다.",
      help: describeHttpStatus(result.status) ?? void 0,
      code: `HTTP ${result.status}`,
      retry: true
    });
    wireRetry($("board"));
    return;
  }
  render();
}
function wireRetry(container) {
  container.querySelector(".retry")?.addEventListener("click", () => {
    void load();
  });
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
void start();
renderNav("kanban");
bootApp();
