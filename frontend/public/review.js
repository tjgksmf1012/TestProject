// src/lib/review/candidates.ts
function emptyDraft() {
  return { decision: "pending" };
}
var BLOCKER_TEXT = {
  missing_assignee: "담당자를 지정해야 승인할 수 있습니다",
  missing_deadline: "마감일을 지정해야 승인할 수 있습니다",
  deadline_in_past: "마감일이 과거입니다",
  unknown_assignee: "담당자가 이 프로젝트의 팀원이 아닙니다",
  already_approved: "이미 승인된 후보입니다",
  already_rejected: "이미 거절된 후보입니다",
  no_evidence: "근거 발화가 없습니다 — 회의에 없던 내용일 수 있습니다"
};
function describeBlocker(code) {
  return BLOCKER_TEXT[code] ?? code;
}
function effectiveTitle(candidate, draft) {
  return draft.titleOverride?.trim() || candidate.title;
}
function effectiveAssignee(candidate, draft) {
  return draft.assigneeOverride !== void 0 ? draft.assigneeOverride : candidate.assignee_id;
}
function effectiveDeadline(candidate, draft) {
  return draft.deadlineOverride !== void 0 ? draft.deadlineOverride : candidate.deadline;
}
function approvalBlockers(candidate, draft, context2) {
  const blockers = [];
  const add = (code) => {
    blockers.push({ code, message: BLOCKER_TEXT[code] });
  };
  if (candidate.review_status === "approved") add("already_approved");
  if (candidate.review_status === "rejected") add("already_rejected");
  if (candidate.evidence_utterance_ids.length === 0) add("no_evidence");
  const assignee = effectiveAssignee(candidate, draft);
  if (assignee === null) {
    add("missing_assignee");
  } else if (!context2.memberIds.includes(assignee)) {
    add("unknown_assignee");
  }
  const deadline = effectiveDeadline(candidate, draft);
  if (deadline === null || deadline === "") {
    add("missing_deadline");
  } else if (isBeforeIsoDate(deadline, context2.today)) {
    add("deadline_in_past");
  }
  return blockers;
}
function attentionReasons(candidate) {
  const reasons = [...candidate.warnings ?? []];
  if (reasons.length === 0 && candidate.confidence < LOW_CONFIDENCE) {
    reasons.push(
      `AI 확신도가 낮습니다 (${Math.round(candidate.confidence * 100)}%) — 근거 발화를 확인하세요`
    );
  }
  return reasons;
}
function isBeforeIsoDate(a, b) {
  return a < b;
}
function canApprove(candidate, draft, context2) {
  return approvalBlockers(candidate, draft, context2).length === 0;
}
function buildReviewPayload(candidates2, drafts2, context2) {
  const items = [];
  for (const candidate of candidates2) {
    const draft = drafts2.get(candidate.id) ?? emptyDraft();
    if (draft.decision === "pending") continue;
    if (draft.decision === "approve") {
      const blockers = approvalBlockers(candidate, draft, context2);
      if (blockers.length > 0) {
        throw new Error(
          `후보 ${candidate.id} 를 승인할 수 없습니다: ${blockers.map((b) => b.message).join(", ")}`
        );
      }
    }
    const item = {
      candidate_id: candidate.id,
      approve: draft.decision === "approve"
    };
    const title = effectiveTitle(candidate, draft);
    if (title !== candidate.title) item.title_override = title;
    const assignee = effectiveAssignee(candidate, draft);
    if (assignee !== null && assignee !== candidate.assignee_id) {
      item.assignee_override = assignee;
    }
    const deadline = effectiveDeadline(candidate, draft);
    if (deadline !== null && deadline !== candidate.deadline) {
      item.deadline_override = deadline;
    }
    const note = draft.note?.trim();
    if (note) item.note = note;
    items.push(item);
  }
  if (items.length === 0) {
    throw new Error("결정한 후보가 없습니다");
  }
  return { items };
}
function sortForReview(candidates2) {
  return [...candidates2].sort((a, b) => a.confidence - b.confidence || a.id - b.id);
}
var LOW_CONFIDENCE = 0.7;
function summarize(candidates2, drafts2, context2) {
  let pending = 0;
  let approving = 0;
  let rejecting = 0;
  let blocked = 0;
  let needsAttention = 0;
  for (const candidate of candidates2) {
    const draft = drafts2.get(candidate.id) ?? emptyDraft();
    if (draft.decision === "approve") {
      approving += 1;
      if (!canApprove(candidate, draft, context2)) blocked += 1;
    } else if (draft.decision === "reject") {
      rejecting += 1;
    } else {
      pending += 1;
      if (candidate.confidence < LOW_CONFIDENCE) needsAttention += 1;
    }
  }
  return {
    total: candidates2.length,
    pending,
    approving,
    rejecting,
    blocked,
    needsAttention
  };
}
function canSubmit(summary) {
  return summary.blocked === 0 && summary.approving + summary.rejecting > 0;
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
function attr(value) {
  return `"${escapeHtml(String(value))}"`;
}

// src/lib/ui/empty.ts
function emptyHtml(state) {
  const action = state.action ? `<a class="btn btn-primary" href="${escapeHtml(state.action.href)}">${escapeHtml(state.action.label)}</a>` : "";
  return `<div class="empty-state"><p class="what">${escapeHtml(state.what)}</p><p class="why">${escapeHtml(state.why)}</p><p class="how">${escapeHtml(state.how)}</p>` + action + "</div>";
}

// src/lib/ui/failure.ts
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
function navLinks(context2) {
  const project = positive(context2.projectId);
  const meeting2 = positive(context2.meetingId);
  const links = [{ screen: "home", label: LABEL.home, href: "/home.html" }];
  if (meeting2 !== null) {
    links.push({
      screen: "lobby",
      label: LABEL.lobby,
      href: `/lobby.html?meeting=${meeting2}`
    });
    links.push({
      screen: "review",
      label: LABEL.review,
      href: `/review.html?meeting=${meeting2}`
    });
  }
  if (project !== null) {
    const suffix = meeting2 !== null ? `&meeting=${meeting2}` : "";
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
  return links.filter((link) => link.screen !== context2.current);
}
function missingLinks(context2) {
  const notes = [];
  if (positive(context2.meetingId) === null && context2.current !== "home") {
    notes.push("회의를 지정하지 않아 로비·검토 화면으로 갈 수 없습니다");
  }
  if (positive(context2.projectId) === null && context2.current !== "home") {
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
function navTabs(context2) {
  const project = positive(context2.projectId);
  const meeting2 = positive(context2.meetingId);
  const suffix = meeting2 !== null ? `&meeting=${meeting2}` : "";
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
      current: context2.current === screen,
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
  const context2 = contextFromSearch(current, location.search);
  const tabHost = document.getElementById("tabs");
  if (tabHost) {
    tabHost.innerHTML = navTabs(context2).map((tab) => {
      const href = tab.enabled ? ` href="${escapeHtml(tab.href)}"` : "";
      const disabled = tab.enabled ? "" : ' aria-disabled="true"';
      const marked = tab.current ? ' aria-current="page"' : "";
      const title = tab.blockedReason ? ` title="${escapeHtml(tab.blockedReason)}"` : "";
      return `<a${href}${disabled}${marked}${title}><span class="ico">${iconSvg(tab.icon)}</span><span>${escapeHtml(tab.label)}</span></a>`;
    }).join("");
  }
  const host = document.getElementById("nav");
  if (!host) return;
  const links = navLinks(context2).map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
  const notes = missingLinks(context2).map((note) => `<span class="miss">${escapeHtml(note)}</span>`).join("");
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

// src/demo/review.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var meetingId = Number(params.get("meeting") ?? "1");
var drafts = /* @__PURE__ */ new Map();
var candidates = [];
var members = [];
var meeting = null;
var context = { memberIds: [], today: todayIso() };
function todayIso() {
  const now = /* @__PURE__ */ new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
function memberName(userId) {
  return members.find((m) => m.user_id === userId)?.name ?? `알 수 없는 사용자 #${userId}`;
}
function draftOf(id) {
  return drafts.get(id) ?? emptyDraft();
}
function update(id, patch) {
  drafts.set(id, { ...draftOf(id), ...patch });
  render();
}
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
var get = (path) => fetch(`${apiBase}${path}`, { credentials: "same-origin" });
async function fetchAll() {
  const [candidateRes, memberRes, meetingRes] = await Promise.all([
    get(`/api/meetings/${meetingId}/candidates`),
    get(`/api/meetings/${meetingId}/members`),
    get(`/api/meetings/${meetingId}`)
  ]);
  if ([candidateRes, memberRes, meetingRes].some((r) => isSessionExpired(r.status))) {
    return "expired";
  }
  if (!candidateRes.ok) throw new Error(`후보 조회 실패 (HTTP ${candidateRes.status})`);
  if (!memberRes.ok) throw new Error(`팀원 조회 실패 (HTTP ${memberRes.status})`);
  if (!meetingRes.ok) throw new Error(`회의 조회 실패 (HTTP ${meetingRes.status})`);
  candidates = sortForReview(await candidateRes.json());
  members = await memberRes.json();
  meeting = await meetingRes.json();
  context = { memberIds: members.map((m) => m.user_id), today: todayIso() };
  return "ok";
}
async function load() {
  const result = await whileLoading(
    fetchAll(),
    () => showSkeleton($("list"), rows(3)),
    () => clearSkeleton($("list"))
  );
  if (result === "expired") {
    goToLogin();
    return;
  }
  render();
}
function render() {
  const summary = summarize(candidates, drafts, context);
  const text = meeting?.summary ?? "";
  $("meeting-summary").hidden = text === "";
  $("meeting-summary").textContent = text;
  $("counts").textContent = `전체 ${summary.total} · 승인 ${summary.approving} · 거절 ${summary.rejecting} · 미결정 ${summary.pending}`;
  $("attention").hidden = summary.needsAttention === 0;
  $("attention").textContent = `확신도가 낮은 후보 ${summary.needsAttention}건이 아직 결정되지 않았습니다. 근거 발화를 확인하세요.`;
  $("blocked").hidden = summary.blocked === 0;
  $("blocked").textContent = `승인하려는 후보 ${summary.blocked}건에 빠진 정보가 있습니다.`;
  $("submit").disabled = !canSubmit(summary);
  if (candidates.length === 0) {
    $("list").innerHTML = emptyHtml(emptyReviewState());
    return;
  }
  $("list").innerHTML = candidates.map(cardHtml).join("");
  wireCards();
}
function emptyReviewState() {
  const status = meeting?.status ?? "";
  const what = "여기에는 회의에서 뽑은 업무 후보가 나옵니다.";
  if (status === "queued" || status === "processing") {
    return {
      what,
      why: "녹음을 아직 처리하는 중입니다.",
      how: "끝나면 여기에 후보가 나옵니다. 잠시 뒤에 새로고침하세요."
    };
  }
  if (status === "failed") {
    return {
      what,
      why: "녹음 처리에 실패해서 후보를 만들지 못했습니다.",
      how: "로비에서 트랙이 온전한지 확인하세요 — 끊긴 구간이 많으면 처리가 실패합니다.",
      action: { label: "트랙 상태 보기", href: `/lobby.html?meeting=${meetingId}` }
    };
  }
  if (status === "confirmed") {
    return {
      what,
      why: "이 회의의 후보는 모두 검토를 마쳤습니다.",
      how: "승인한 업무는 칸반에 있습니다.",
      action: { label: "칸반 보기", href: `/kanban.html?meeting=${meetingId}` }
    };
  }
  return {
    what,
    why: "처리는 끝났는데 업무로 뽑을 만한 발언이 없었습니다 — 고장이 아닙니다.",
    how: "회의에서 누가·무엇을·언제까지 하기로 했는지 말하면 그 발언이 후보가 됩니다.",
    action: { label: "칸반 보기", href: `/kanban.html?meeting=${meetingId}` }
  };
}
function cardHtml(candidate) {
  const draft = draftOf(candidate.id);
  const blockers = approvalBlockers(candidate, draft, context);
  const reasons = attentionReasons(candidate);
  const decided = candidate.review_status !== "pending";
  const low = candidate.confidence < LOW_CONFIDENCE;
  const assignee = effectiveAssignee(candidate, draft);
  const known = members.some((m) => m.user_id === assignee);
  const options = [
    `<option value=""${assignee === null ? " selected" : ""}>담당자 미지정</option>`,
    // 팀에서 빠졌거나 잘못 들어온 담당자도 반드시 보여준다.
    // 명단에 없다고 조용히 "미지정" 으로 그리면, 사람은 비어 있는 줄 알고
    // 그냥 승인해 버린다 — 서버가 unknown_assignee 로 막긴 하지만 이유를
    // 화면에서 먼저 알아야 고칠 수 있다.
    ...assignee !== null && !known ? [`<option value="${assignee}" selected>${escapeHtml(memberName(assignee))}</option>`] : [],
    ...members.map((m) => {
      const selected = assignee === m.user_id ? " selected" : "";
      return `<option value="${m.user_id}"${selected}>${escapeHtml(m.name)}</option>`;
    })
  ].join("");
  return `
<article class="card" data-id="${candidate.id}" data-decision="${draft.decision}">
  <header>
    <input class="title" type="text" value=${attr(effectiveTitle(candidate, draft))}
           ${decided ? "disabled" : ""} />
    <span class="conf ${low ? "low" : ""}">확신도 ${(candidate.confidence * 100).toFixed(0)}%</span>
  </header>

  <div class="row">
    <label>담당자 <select class="assignee" ${decided ? "disabled" : ""}>${options}</select></label>
    <label>마감일 <input class="deadline" type="date"
           value="${effectiveDeadline(candidate, draft) ?? ""}" ${decided ? "disabled" : ""} /></label>
  </div>

  ${// 회의에서 부른 이름을 명단에서 못 찾았을 때만 보여준다. 이미 풀린
  // 담당자 옆에 원문을 또 띄우면 읽을 게 늘 뿐이다.
  candidate.assignee_hint && assignee === null ? `<p class="hint">회의에서는 <strong>${escapeHtml(candidate.assignee_hint)}</strong>
           라고 했습니다 — 명단에서 찾지 못했습니다</p>` : ""}

  <p class="evidence">
    근거 발화 ${candidate.evidence_utterance_ids.length}건
    ${candidate.evidence_utterance_ids.length ? `<code>#${candidate.evidence_utterance_ids.join(", #")}</code>` : '<strong class="bad">— 회의에 없던 내용일 수 있습니다</strong>'}
  </p>

  ${// 서버가 무엇을 확신하지 못했는가. 사람이 화면에서 고쳐도 남는다 —
  // blockers 와 달리 이건 판정이 아니라 기록이다.
  reasons.length ? `<ul class="warnings">${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : ""}

  ${blockers.length ? `<ul class="blockers">${blockers.map((b) => `<li>${escapeHtml(b.message)}</li>`).join("")}</ul>` : ""}

  ${decided ? `<p class="done">이미 ${candidate.review_status === "approved" ? "승인" : "거절"}된 후보입니다</p>` : `<div class="actions">
           <button class="approve${draft.decision === "approve" ? " on" : ""}"
                   ${blockers.length ? "disabled" : ""}>승인</button>
           <button class="reject${draft.decision === "reject" ? " on" : ""}">거절</button>
           <button class="clear">보류</button>
         </div>
         <input class="note" type="text" placeholder="메모 (선택) — 왜 이렇게 결정했는지"
                value=${attr(draft.note ?? "")} />`}
</article>`;
}
function wireCards() {
  for (const card of document.querySelectorAll(".card")) {
    const id = Number(card.dataset.id);
    const on = (sel, ev, fn) => {
      const el = card.querySelector(sel);
      el?.addEventListener(ev, () => fn(el));
    };
    on(".title", "change", (el) => update(id, { titleOverride: el.value }));
    on(
      ".assignee",
      "change",
      (el) => update(id, { assigneeOverride: el.value === "" ? null : Number(el.value) })
    );
    on(
      ".deadline",
      "change",
      (el) => update(id, { deadlineOverride: el.value === "" ? null : el.value })
    );
    on(".note", "change", (el) => update(id, { note: el.value }));
    const decide = (decision) => () => update(id, { decision });
    card.querySelector(".approve")?.addEventListener("click", decide("approve"));
    card.querySelector(".reject")?.addEventListener("click", decide("reject"));
    card.querySelector(".clear")?.addEventListener("click", decide("pending"));
  }
}
$("submit").addEventListener("click", async () => {
  let payload;
  try {
    payload = buildReviewPayload(candidates, drafts, context);
  } catch (error) {
    alert(error instanceof Error ? error.message : String(error));
    return;
  }
  const response = await fetch(`${apiBase}/api/meetings/${meetingId}/candidates/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "same-origin"
  });
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    $("result").textContent = `제출 실패 (HTTP ${response.status})`;
    $("result").className = "bad";
    return;
  }
  const result = await response.json();
  const failed = Object.entries(result.failures);
  $("result").className = failed.length ? "bad" : "ok";
  $("result").textContent = failed.length ? `${result.approved_count}건 승인, ${failed.length}건 실패: ` + failed.map(([id, codes]) => `#${id} ${codes.map(describeBlocker).join("/")}`).join(" · ") : `${result.approved_count}건이 칸반에 등록됐습니다 (task ${result.approved_task_ids.join(", ")})`;
  drafts.clear();
  await load();
});
async function start() {
  const response = await get("/api/auth/me");
  if (!response.ok) {
    goToLogin();
    return;
  }
  const me = await response.json();
  $("who").textContent = `${me.name} 님이 검토하고 있습니다`;
  await load();
}
start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  $("list").innerHTML = failureHtml({
    what: "업무 후보를 불러오지 못했습니다.",
    help: message,
    retry: true
  });
  $("list").querySelector(".retry")?.addEventListener("click", () => {
    void load();
  });
});
renderNav("review");
bootApp();
