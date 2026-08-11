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
  no_evidence: "근거 발화가 없습니다 — 회의에 없던 내용일 수 있습니다",
  // 아래 둘은 화면이 만들지 않는다. 서버만 낸다.
  //
  // 서버 문구는 "이 회의에 없는 후보입니다" 인데, 그것만 읽으면 사람은
  // 무엇을 해야 할지 모른다. 이 코드가 나오는 경우는 하나뿐이다 —
  // 화면이 들고 있는 목록이 서버보다 낡았다. 그래서 할 일을 같이 적는다.
  unknown_candidate: "이 회의에 없는 후보입니다 — 목록이 오래됐습니다. 새로 고쳐 주세요",
  no_reviewer: "로그인 정보가 확인되지 않았습니다 — 다시 로그인해 주세요"
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
          `${withJosa(`후보 ${candidate.id}`, "을를")} 승인할 수 없습니다: ${blockers.map((b) => b.message).join(", ")}`
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
function reviewLane(candidate, draft) {
  if (candidate.review_status === "approved") return "approve";
  if (candidate.review_status === "rejected") return "reject";
  return draft.decision;
}
function laneCounts(candidates2, drafts2) {
  const counts = { all: candidates2.length, pending: 0, approve: 0, reject: 0 };
  for (const candidate of candidates2) {
    counts[reviewLane(candidate, drafts2.get(candidate.id) ?? emptyDraft())] += 1;
  }
  return counts;
}
var EMPTY_FIELD = {
  missing_assignee: "담당자",
  missing_deadline: "마감일"
};
function blockerLine(blockers) {
  const empty = [];
  const hard = [];
  for (const blocker of blockers) {
    const field = EMPTY_FIELD[blocker.code];
    if (field === void 0) hard.push(blocker.message);
    else empty.push(field);
  }
  const need = empty.length === 0 ? "" : `${[...empty.slice(0, -1), withJosa(empty[empty.length - 1], "을를")].join(" · ")} 지정해야 등록할 수 있습니다`;
  if (hard.length === 0) {
    return empty.length === 0 ? { tone: "none", text: "" } : { tone: "missing", text: need };
  }
  return { tone: "error", text: need === "" ? hard.join(" · ") : `${hard.join(" · ")} · ${need}` };
}
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
function describeSubmitResult(approvedCount, taskIds) {
  if (approvedCount === 0) {
    return "검토를 반영했습니다 — 칸반에 등록된 업무는 없습니다";
  }
  const numbers = taskIds.filter((id) => Number.isFinite(id));
  return numbers.length === 0 ? `${approvedCount}건이 칸반에 등록됐습니다` : `${approvedCount}건이 칸반에 등록됐습니다 (task ${numbers.join(", ")})`;
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
  sliders: '<path d="M4 8h16M4 16h16"/><circle cx="14" cy="8" r="2.5"/><circle cx="9" cy="16" r="2.5"/>',
  // 사람 — 담당자 칸. 머리 하나 + 어깨선.
  // 비어 있을 때는 이 동그라미가 곧 "아직 아무도 없다" 입니다.
  person: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-5.5 7-5.5s7 1.9 7 5.5"/>',
  // 달력 — 마감일 칸. 고리 둘 + 머리줄.
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17"/><path d="M8 3v4M16 3v4"/>'
};
function iconSvg(name) {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + PATHS[name] + "</svg>";
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
function tryGet(url) {
  return trySend(() => fetch(url, { credentials: "same-origin", cache: "no-store" }));
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

// src/lib/review/minutes.ts
function atText(startMs) {
  if (!Number.isFinite(startMs) || startMs <= 0) return null;
  const total = Math.floor(startMs / 1e3);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}
function describeIssue(issue) {
  return {
    content: issue.content.trim(),
    at: atText(issue.start_ms),
    evidenceCount: (issue.evidence_utterance_ids ?? []).length
  };
}
function issueViews(issues) {
  return issues.map(describeIssue).filter((v) => v.content !== "");
}
function agendaItems(agenda) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const raw of agenda) {
    const item = raw.trim();
    if (item === "" || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}
function hasExtraMinutes(minutes) {
  return agendaItems(minutes.next_agenda).length > 0 || issueViews(minutes.unresolved_issues).length > 0;
}

// src/lib/time/calendar.ts
var TEAM_TIMEZONE = "Asia/Seoul";
var FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TEAM_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
function isoFrom(at) {
  const parts = new Map(FORMATTER.formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}
function todayInTeamCalendar(now = /* @__PURE__ */ new Date()) {
  return isoFrom(now);
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
function channelLabel(meeting2) {
  const title = (meeting2.title ?? "").trim();
  return title === "" ? `회의 ${meeting2.meeting_id}` : title;
}
function channelHref(meetingId2, projectId) {
  const base = `/lobby.html?meeting=${meetingId2}`;
  return projectId != null && projectId > 0 ? `${base}&project=${projectId}` : base;
}
function meetingChannels(meetings, context2 = {}) {
  const { projectId, currentMeetingId } = context2;
  return meetings.map((meeting2) => ({
    meetingId: meeting2.meeting_id,
    label: channelLabel(meeting2),
    href: channelHref(meeting2.meeting_id, projectId),
    state: channelState(meeting2.status),
    stateLabel: describeMeetingStatus(meeting2.status),
    current: currentMeetingId != null && currentMeetingId === meeting2.meeting_id,
    pending: meeting2.pending_candidates > 0 ? meeting2.pending_candidates : null
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

// src/lib/contribution/roles.ts
var ROLE_OPTIONS = [
  { key: "developer", label: "개발", hint: "코드 35% · 업무 30%" },
  { key: "planner", label: "기획", hint: "문서 30% · 업무 30% · 코드 0%" },
  { key: "designer", label: "디자인", hint: "문서 35% · 업무 30% · 코드 0%" }
];
function roleSummary(shares) {
  const entries = Object.entries(shares ?? {}).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;
  const label = (key) => ROLE_OPTIONS.find((o) => o.key === key)?.label ?? key;
  if (entries.length === 1) return `${label(entries[0]?.[0] ?? "")} 100%`;
  return entries.sort((a, b) => b[1] - a[1]).map(([key, value]) => `${label(key)} ${Math.round(value * 100)}%`).join(" · ");
}

// src/lib/nav/panel.ts
var UNMEASURABLE = "GitHub 아이디를 아직 연결하지 않아 코드 활동을 못 잽니다";
function measureState(githubLogin) {
  return (githubLogin ?? "").trim() === "" ? "unmeasurable" : "measured";
}
function panelMembers(members2) {
  return members2.map((member) => {
    const roles = roleSummary(member.role_shares);
    const state = measureState(member.github_login);
    const note = state === "unmeasurable" ? UNMEASURABLE : null;
    const spoken = [member.name];
    if (roles !== null) spoken.push(roles);
    if (note !== null) spoken.push(note);
    return {
      userId: member.user_id,
      name: member.name,
      roles,
      state,
      note,
      ariaLabel: spoken.join(", ")
    };
  });
}
function panelHeading(count) {
  return `팀원 ${count}명`;
}
function unmeasurableNote(members2) {
  const count = members2.filter((m) => m.state === "unmeasurable").length;
  if (count === 0) return null;
  return `${count}명은 GitHub 아이디가 없어 코드 활동이 기여도에 안 들어갑니다 — 설정에서 각자 연결합니다`;
}
function emptyMembersNote() {
  return "팀원을 불러오지 못했습니다";
}

// src/lib/nav/rail.ts
var STAYS = /* @__PURE__ */ new Set(["kanban", "contributions", "project"]);
function railHref(screen, projectId) {
  const target = STAYS.has(screen) ? screen : "kanban";
  return `/${target}.html?project=${projectId}`;
}
function railInitial(title) {
  const trimmed = (title ?? "").trim();
  return Array.from(trimmed)[0] ?? "?";
}
function railIsWorthIt(projects) {
  return projects.length >= 2;
}
function railItems(projects, screen, currentProjectId) {
  return [...projects].sort((a, b) => a.project_id - b.project_id).map((project) => ({
    projectId: project.project_id,
    initial: railInitial(project.title),
    label: project.title,
    href: railHref(screen, project.project_id),
    current: currentProjectId != null && currentProjectId === project.project_id,
    needsReview: project.needs_review > 0
  }));
}
function railAriaLabel(item) {
  const parts = [item.label];
  if (item.needsReview) parts.push("검토할 회의가 있습니다");
  if (item.current) parts.push("지금 보는 프로젝트");
  return parts.join(", ");
}

// src/demo/nav.ts
function renderNav(current) {
  const context2 = contextFromSearch(current, location.search);
  paint(context2);
  const tabHost = document.getElementById("tabs");
  if (tabHost) void fillChannels(tabHost, context2);
}
function paint(context2, shell = {}) {
  const tabHost = document.getElementById("tabs");
  if (tabHost) {
    const chan = tabHost.querySelector(".chan") ?? document.createElement("div");
    chan.className = "chan";
    const name = shellHeading(shell.projectTitle);
    const heading = `<p class="chan-project" title="${escapeHtml(name)}">${escapeHtml(name)}</p>`;
    tabHost.innerHTML = navTabs(context2).map((tab) => {
      const href = tab.enabled ? ` href="${escapeHtml(tab.href)}"` : "";
      const disabled = tab.enabled ? "" : ' aria-disabled="true"';
      const marked = tab.current ? ' aria-current="page"' : "";
      const title = tab.blockedReason ? ` title="${escapeHtml(tab.blockedReason)}"` : "";
      return `<a${href}${disabled}${marked}${title}><span class="ico">${iconSvg(tab.icon)}</span><span>${escapeHtml(tab.label)}</span></a>`;
    }).join("");
    tabHost.insertAdjacentHTML("afterbegin", heading);
    tabHost.append(chan);
    if (document.querySelector(".ctx") === null) {
      const panel = document.createElement("aside");
      panel.className = "ctx";
      document.body.append(panel);
    }
    paintRail(context2, shell.projects ?? []);
  }
  const host = document.getElementById("nav");
  if (!host) return;
  const links = navLinks(context2).map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
  const notes = missingLinks(context2).map((note) => `<span class="miss">${escapeHtml(note)}</span>`).join("");
  host.innerHTML = links + notes;
}
function paintRail(context2, projects) {
  const existing = document.querySelector(".rail");
  if (!railIsWorthIt(projects)) {
    existing?.remove();
    document.body.classList.remove("has-rail");
    return;
  }
  const rail = existing instanceof HTMLElement ? existing : document.createElement("nav");
  rail.className = "rail";
  rail.setAttribute("aria-label", "프로젝트");
  rail.innerHTML = railItems(projects, context2.current, context2.projectId).map((item) => {
    const current = item.current ? ' aria-current="page"' : "";
    const dot = item.needsReview ? `<span class="rail-dot"></span>` : "";
    return `<a class="rail-item" href="${escapeHtml(item.href)}"${current} title="${escapeHtml(item.label)}" aria-label="${escapeHtml(railAriaLabel(item))}"><span class="rail-face" aria-hidden="true">${escapeHtml(item.initial)}</span>` + dot + `</a>`;
  }).join("");
  if (existing === null) document.body.prepend(rail);
  document.body.classList.add("has-rail");
}
var SHELL_WIDTH = "(min-width: 90rem)";
var PANEL_WIDTH = "(min-width: 100rem)";
var CHANNEL_LIMIT = 20;
async function fillChannels(tabHost, context2) {
  const apiBase2 = safeApiBase(new URLSearchParams(location.search).get("api"), location.origin);
  const projectId = await resolveProjectId(apiBase2, context2);
  if (projectId === null) return;
  const projects = await fetchProjects(apiBase2);
  const title = projects.find((p) => p.project_id === projectId)?.title ?? null;
  if (context2.projectId !== projectId || title !== null) {
    paint({ ...context2, projectId }, { projectTitle: title, projects });
  }
  await Promise.all([
    listChannels(tabHost, apiBase2, { ...context2, projectId }),
    fillPanel(apiBase2, projectId)
  ]);
}
async function fillPanel(apiBase2, projectId) {
  const host = document.querySelector(".ctx");
  if (!(host instanceof HTMLElement)) return;
  const wide = window.matchMedia(PANEL_WIDTH);
  if (!wide.matches) {
    wide.addEventListener("change", () => void fillPanel(apiBase2, projectId), { once: true });
    return;
  }
  const response = await tryGet(`${apiBase2}/api/projects/${projectId}/members`);
  if (response === null || !response.ok) return;
  const members2 = panelMembers(await response.json());
  if (members2.length === 0) {
    host.innerHTML = `<p class="ctx-note">${escapeHtml(emptyMembersNote())}</p>`;
    return;
  }
  const rows2 = members2.map((row) => {
    const roles = row.roles === null ? "" : `<p class="ctx-roles">${escapeHtml(row.roles)}</p>`;
    const why = row.note === null ? "" : ` title="${escapeHtml(row.note)}"`;
    return `<div class="ctx-row" aria-label="${escapeHtml(row.ariaLabel)}"><p class="ctx-name"><span class="ctx-dot" data-state="${escapeHtml(row.state)}"${why}></span>${escapeHtml(row.name)}</p>` + roles + `</div>`;
  }).join("");
  const note = unmeasurableNote(members2);
  host.innerHTML = `<p class="ctx-head">${escapeHtml(panelHeading(members2.length))}</p>` + rows2 + (note === null ? "" : `<p class="ctx-note">${escapeHtml(note)}</p>`);
}
async function fetchProjects(apiBase2) {
  const response = await tryGet(`${apiBase2}/api/projects`);
  if (response === null || !response.ok) return [];
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}
async function listChannels(tabHost, apiBase2, context2) {
  const wide = window.matchMedia(SHELL_WIDTH);
  if (!wide.matches) {
    wide.addEventListener("change", () => void listChannels(tabHost, apiBase2, context2), {
      once: true
    });
    return;
  }
  const host = tabHost.querySelector(".chan");
  if (!(host instanceof HTMLElement)) return;
  const projectId = context2.projectId;
  const response = await tryGet(`${apiBase2}/api/projects/${projectId}/meetings`);
  if (response === null) {
    host.innerHTML = `<p class="chan-head">회의</p><p class="chan-none">목록을 불러오지 못했습니다 — 연결을 확인해 주세요</p>`;
    return;
  }
  if (!response.ok) return;
  const meetings = await response.json();
  const channels = meetingChannels(meetings, {
    projectId,
    currentMeetingId: context2.meetingId
  });
  host.innerHTML = `<p class="chan-head">회의</p>` + (channels.length === 0 ? `<p class="chan-none">${escapeHtml(emptyChannelsNote())}</p>` : renderChannels(channels));
}
async function resolveProjectId(apiBase2, context2) {
  if (context2.projectId != null && context2.projectId > 0) return context2.projectId;
  if (context2.meetingId == null || context2.meetingId <= 0) return null;
  const response = await tryGet(`${apiBase2}/api/meetings/${context2.meetingId}`);
  if (response === null || !response.ok) return null;
  const meeting2 = await response.json();
  return typeof meeting2.project_id === "number" ? meeting2.project_id : null;
}
function renderChannels(channels) {
  const shown = channels.slice(0, CHANNEL_LIMIT);
  const rows2 = shown.map((channel) => {
    const current = channel.current ? ' aria-current="page"' : "";
    const count = channel.pending === null ? "" : `<span class="chan-count">${escapeHtml(String(channel.pending))}</span>`;
    return `<a class="chan-row" href="${escapeHtml(channel.href)}"${current} aria-label="${escapeHtml(channelAriaLabel(channel))}"><span class="chan-dot" data-state="${escapeHtml(channel.state)}"></span><span class="chan-name">${escapeHtml(channel.label)}</span>` + count + `</a>`;
  }).join("");
  const hidden = channels.length - shown.length;
  const more = hidden === 0 ? "" : `<p class="chan-none">그 밖에 ${escapeHtml(String(hidden))}개 — 홈에서 전부 봅니다</p>`;
  return rows2 + more;
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

// src/demo/review.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var meetingId = Number(params.get("meeting") ?? "1");
var drafts = /* @__PURE__ */ new Map();
var candidates = [];
var members = [];
var meeting = null;
var context = { memberIds: [], today: todayInTeamCalendar() };
var lane = "all";
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
var get = (path) => tryGet(`${apiBase}${path}`);
async function fetchAll() {
  const [candidateRes, memberRes, meetingRes] = await Promise.all([
    get(`/api/meetings/${meetingId}/candidates`),
    get(`/api/meetings/${meetingId}/members`),
    get(`/api/meetings/${meetingId}`)
  ]);
  if (candidateRes === null || memberRes === null || meetingRes === null) {
    return "unreachable";
  }
  if ([candidateRes, memberRes, meetingRes].some((r) => isSessionExpired(r.status))) {
    return "expired";
  }
  if (!candidateRes.ok) throw new Error(`후보 조회 실패 (HTTP ${candidateRes.status})`);
  if (!memberRes.ok) throw new Error(`팀원 조회 실패 (HTTP ${memberRes.status})`);
  if (!meetingRes.ok) throw new Error(`회의 조회 실패 (HTTP ${meetingRes.status})`);
  candidates = sortForReview(await candidateRes.json());
  members = await memberRes.json();
  meeting = await meetingRes.json();
  context = { memberIds: members.map((m) => m.user_id), today: todayInTeamCalendar() };
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
  if (result === "unreachable") {
    $("list").innerHTML = failureHtml({
      what: unreachableText("업무 후보를 불러오지 못했습니다."),
      retry: true
    });
    $("list").querySelector(".retry")?.addEventListener("click", () => {
      void load();
    });
    return;
  }
  render();
}
function renderMinutes() {
  const agenda = agendaItems(meeting?.next_agenda ?? []);
  const issues = issueViews(meeting?.unresolved_issues ?? []);
  $("agenda-block").hidden = agenda.length === 0;
  $("agenda").innerHTML = agenda.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  $("issues-block").hidden = issues.length === 0;
  $("issues").innerHTML = issues.map((view) => {
    const at = view.at === null ? "" : `<span class="at">${escapeHtml(view.at)}</span>`;
    const why = view.evidenceCount === 0 ? '<span class="why none">근거 발화 없음</span>' : `<span class="why">근거 발화 ${view.evidenceCount}건</span>`;
    return `<li>${at}<span class="what">${escapeHtml(view.content)}</span>${why}</li>`;
  }).join("");
  const extra = hasExtraMinutes({
    next_agenda: meeting?.next_agenda ?? [],
    unresolved_issues: meeting?.unresolved_issues ?? []
  });
  return { agenda: agenda.length, issues: issues.length, any: extra };
}
function briefLine(counts) {
  const parts = [];
  if ((meeting?.summary ?? "") !== "") parts.push("회의 요약");
  if (counts.agenda > 0) parts.push(`다음 안건 ${counts.agenda}`);
  if (counts.issues > 0) parts.push(`답 안 난 것 ${counts.issues}`);
  return parts.join(" · ");
}
function laneTabs(counts) {
  const tabs = [
    ["all", "전체"],
    ["pending", "검토 필요"],
    ["approve", "등록"],
    ["reject", "거절"]
  ];
  return tabs.map(
    ([key, label]) => `<button type="button" role="tab" data-lane="${key}" aria-selected="${key === lane}">${label}<span class="n">${counts[key]}</span></button>`
  ).join("");
}
function render() {
  const summary = summarize(candidates, drafts, context);
  const text = meeting?.summary ?? "";
  $("meeting-summary").hidden = text === "";
  $("meeting-summary").textContent = text;
  const counts = renderMinutes();
  $("brief").hidden = !counts.any && text === "";
  $("brief-line").textContent = briefLine(counts);
  $("submit").disabled = !canSubmit(summary);
  $("result").textContent = summary.blocked > 0 ? `${summary.blocked}건에 빠진 정보가 있어 제출할 수 없습니다` : "";
  if (candidates.length === 0) {
    $("lanes").innerHTML = "";
    $("lane-empty").hidden = true;
    $("list").innerHTML = emptyHtml(emptyReviewState());
    return;
  }
  $("lanes").innerHTML = laneTabs(laneCounts(candidates, drafts));
  wireLanes();
  const shown = candidates.filter(
    (candidate) => lane === "all" || reviewLane(candidate, draftOf(candidate.id)) === lane
  );
  $("lane-empty").hidden = shown.length > 0;
  $("lane-empty").textContent = "이 상태인 후보가 없습니다";
  $("list").innerHTML = shown.map(cardHtml).join("");
  wireCards();
}
function wireLanes() {
  for (const tab of $("lanes").querySelectorAll("button[data-lane]")) {
    tab.addEventListener("click", () => {
      lane = tab.dataset.lane;
      render();
    });
  }
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
  const deadline = effectiveDeadline(candidate, draft) ?? "";
  const check = blockerLine(blockers);
  const evidence = candidate.evidence_utterance_ids;
  return `
<article class="cand" data-id="${candidate.id}" data-decision="${draft.decision}"
         data-done="${decided ? "1" : "0"}">
  <div class="cand-top">
    <input class="title" type="text" value=${attr(effectiveTitle(candidate, draft))}
           aria-label="업무 제목" ${decided ? "disabled" : ""} />
    <span class="badge ${low ? "low" : ""}"
          title="AI 확신도">${(candidate.confidence * 100).toFixed(0)}%</span>
  </div>

  <div class="fields">
    <label class="field sel" data-empty="${assignee === null ? "1" : "0"}">
      <span class="ico">${iconSvg("person")}</span>
      <span class="visually-hidden">담당자</span>
      <select class="assignee" ${decided ? "disabled" : ""}>${options}</select>
    </label>
    <label class="field" data-empty="${deadline === "" ? "1" : "0"}">
      <span class="ico">${iconSvg("calendar")}</span>
      <span class="visually-hidden">마감일</span>
      <input class="deadline" type="date" value="${deadline}" ${decided ? "disabled" : ""} />
    </label>
    <span class="src${evidence.length === 0 ? " none" : ""}">${evidence.length === 0 ? "근거 없음" : `근거 #${evidence.join(", #")}`}</span>
  </div>

  ${// 회의에서 부른 이름을 명단에서 못 찾았을 때만 보여준다. 이미 풀린
  // 담당자 옆에 원문을 또 띄우면 읽을 게 늘 뿐이다.
  candidate.assignee_hint && assignee === null ? `<p class="hint">회의에서는 <strong>${escapeHtml(candidate.assignee_hint)}</strong>
           라고 했습니다 — 명단에서 찾지 못했습니다</p>` : ""}

  ${// ⭐ 막는 이유는 **한 줄**입니다 (브리프 §13). 안 채운 칸은 흙빛,
  // 실제로 잘못된 것만 빨강 — `blockerLine` 이 가릅니다.
  check.tone === "none" ? "" : `<p class="check" data-tone="${check.tone}">${escapeHtml(check.text)}</p>`}

  ${// 서버가 무엇을 확신하지 못했는가. 사람이 화면에서 고쳐도 남는다 —
  // blockers 와 달리 이건 판정이 아니라 기록이다.
  //
  // ⚠️ **통째로 접습니다.** 승인을 막는 것이 아니므로 위의 한 줄보다
  // 조용해야 합니다. 접어도 **한 번의 클릭 안에** 있습니다.
  reasons.length ? `<details class="why-not"><summary>확신하지 못한 이유 ${reasons.length}건</summary><ul>${reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul></details>` : ""}

  ${decided ? `<p class="done">이미 ${candidate.review_status === "approved" ? "등록" : "거절"}된 후보입니다</p>` : `<div class="acts">
           <button class="approve${draft.decision === "approve" ? " on" : ""}"
                   ${blockers.length ? "disabled" : ""}>업무로 등록</button>
           <button class="clear${draft.decision === "pending" ? " on" : ""}">나중에 검토</button>
           <button class="reject${draft.decision === "reject" ? " on" : ""}">거절</button>
         </div>
         <input class="memo" type="text" placeholder="메모 (선택) — 왜 이렇게 결정했는지"
                aria-label="메모" value=${attr(draft.note ?? "")} />`}
</article>`;
}
function wireCards() {
  for (const card of document.querySelectorAll(".cand")) {
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
    on(".memo", "change", (el) => update(id, { note: el.value }));
    const decide = (decision) => () => update(id, { decision });
    card.querySelector(".approve")?.addEventListener("click", decide("approve"));
    card.querySelector(".reject")?.addEventListener("click", decide("reject"));
    card.querySelector(".clear")?.addEventListener("click", decide("pending"));
  }
}
$("submit").addEventListener("click", () => {
  void whilePressed($("submit"), async () => {
    let payload;
    try {
      payload = buildReviewPayload(candidates, drafts, context);
    } catch (error) {
      alert(error instanceof Error ? error.message : String(error));
      return;
    }
    const response = await trySend(
      () => fetch(`${apiBase}/api/meetings/${meetingId}/candidates/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin"
      })
    );
    if (response === null) {
      $("result").textContent = unreachableText("제출하지 못했습니다");
      $("result").className = "bad";
      return;
    }
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
    $("result").textContent = failed.length ? `${result.approved_count}건 승인, ${failed.length}건 실패: ` + failed.map(([id, codes]) => `#${id} ${codes.map(describeBlocker).join("/")}`).join(" · ") : describeSubmitResult(result.approved_count, result.approved_task_ids);
    drafts.clear();
    await load();
  });
});
async function start() {
  const response = await get("/api/auth/me");
  if (response === null) {
    await load();
    return;
  }
  if (!response.ok) {
    goToLogin();
    return;
  }
  const me = await response.json();
  const initial = Array.from(me.name)[0] ?? "?";
  $("who").innerHTML = `<span class="avatar" aria-hidden="true">${escapeHtml(initial)}</span>${escapeHtml(me.name)} · 검토 중`;
  $("who").hidden = false;
  await load();
}
start().catch((error) => {
  console.error("업무 후보 조회 실패", error);
  $("list").innerHTML = failureHtml({
    what: "업무 후보를 불러오지 못했습니다.",
    help: describeUnexpected(),
    retry: true
  });
  $("list").querySelector(".retry")?.addEventListener("click", () => {
    void load();
  });
});
renderNav("review");
bootApp();
