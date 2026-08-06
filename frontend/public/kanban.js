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
function isOverdue(task, today) {
  if (task.deadline === null) return false;
  if (task.status === "done") {
    if (!task.completed_at) return false;
    return task.completed_at.slice(0, 10) > task.deadline;
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
function summarize(tasks2, today) {
  return {
    total: tasks2.length,
    done: tasks2.filter((t) => t.status === "done").length,
    overdue: tasks2.filter((t) => isOverdue(t, today)).length,
    fromMeetings: tasks2.filter((t) => t.origin !== null).length,
    unassigned: tasks2.filter((t) => t.assignee_id === null).length
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
  const host = document.getElementById("nav");
  if (!host) return;
  const context = contextFromSearch(current, location.search);
  const links = navLinks(context).map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
  const notes = missingLinks(context).map((note) => `<span class="miss">${escapeHtml(note)}</span>`).join("");
  host.innerHTML = links + notes;
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
    (s) => `<button class="move" data-id="${task.id}" data-to="${escapeHtml(s)}">${escapeHtml(describeStatus(s))}로</button>`
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
  task.origin ? `<p class="origin">🗣 ${escapeHtml(task.origin.meeting_title ?? "회의")}에서 나온 업무
           · 근거 발화 ${task.origin.evidence_utterance_ids.length}건</p>` : '<p class="origin manual">손으로 만든 업무</p>'}
  ${warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : ""}
  <div class="moves">${moves}</div>
</article>`;
}
function render() {
  const today = todayIso();
  const summary = summarize(tasks, today);
  $("counts").textContent = `전체 ${summary.total} · 완료 ${summary.done} · 지연 ${summary.overdue} · 회의에서 나온 업무 ${summary.fromMeetings}`;
  $("unassigned").hidden = summary.unassigned === 0;
  $("unassigned").textContent = `담당자가 없는 업무 ${summary.unassigned}건은 완료해도 기여도에 반영되지 않습니다.`;
  $("board").innerHTML = toColumns(tasks, statuses).map(
    (column) => `
<section class="col">
  <h2>${escapeHtml(column.label)} <span class="n">${column.tasks.length}</span></h2>
  ${column.tasks.map((t) => cardHtml(t, today)).join("") || '<p class="empty">비어 있음</p>'}
</section>`
  ).join("");
  for (const button of document.querySelectorAll(".move")) {
    button.addEventListener("click", () => {
      void move(Number(button.dataset.id), button.dataset.to ?? "");
    });
  }
}
async function move(taskId, to) {
  const response = await fetch(`${apiBase}/api/projects/${projectId}/tasks/${taskId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    // ⚠️ `statusPatch` 를 쓴다. 손으로 객체를 만들면서 `deadline: null` 을
    // 넣으면 서버가 마감일을 지운다.
    body: JSON.stringify(statusPatch(to)),
    credentials: "same-origin"
  });
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
async function load() {
  const [boardRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/tasks`),
    get(`/api/projects/${projectId}/members`)
  ]);
  if (isSessionExpired(boardRes.status)) {
    goToLogin();
    return;
  }
  if (!boardRes.ok) {
    $("result").textContent = boardRes.status === 403 ? "이 프로젝트의 구성원만 볼 수 있습니다." : `불러오지 못했습니다 (HTTP ${boardRes.status})`;
    return;
  }
  const board = await boardRes.json();
  statuses = board.statuses;
  tasks = board.tasks;
  if (memberRes.ok) members = await memberRes.json();
  render();
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
