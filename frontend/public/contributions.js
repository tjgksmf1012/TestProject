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
function uncertaintySpans(members) {
  const points = members.map((m) => Math.abs(clamp(m.range_high, 0, 100) - clamp(m.range_low, 0, 100)));
  const widest = Math.max(0, ...points);
  return members.map((member, i) => ({
    userId: member.user_id,
    points: points[i] ?? 0,
    ratio: widest === 0 ? 0 : Math.round((points[i] ?? 0) / widest * 100)
  }));
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
function adjustmentsToRestore(finals) {
  const out = /* @__PURE__ */ new Map();
  for (const f of finals) {
    if (sameValue(f.final_value, f.system_value)) continue;
    out.set(f.user_id, { final_value: f.final_value, reason: f.reason ?? "" });
  }
  return out;
}
var BLIND_CONFIRM = "지금 저장된 확정을 불러오지 못했습니다 — 이대로 확정하면 이전에 조정한 값이 지워질 수 있습니다. 새로고침한 뒤 다시 해 주세요.";
function person(id, names) {
  const name = names.get(id) ?? `#${id}`;
  return `${name}님`;
}
function confirmers(finals, names) {
  const ids = [...new Set(finals.map((f) => f.adjusted_by))];
  return ids.filter((id) => id !== null).map((id) => person(id, names));
}
var percent = (value) => `${value.toFixed(1)}%`;
function describeFinals(finals, names) {
  if (finals.length === 0) return "아직 아무도 확정하지 않았습니다.";
  const first = finals[0];
  if (first === void 0) return "아직 아무도 확정하지 않았습니다.";
  const when = new Date(first.confirmed_at).toLocaleString("ko-KR");
  const who = confirmers(finals, names).join(", ");
  const did = who === "" ? "확정했습니다(누가 눌렀는지는 기록에 없습니다)" : `${withJosa(who, "이가")} 확정했습니다`;
  const adjusted = finals.filter((f) => !sameValue(f.final_value, f.system_value));
  if (adjusted.length === 0) {
    return `${when}에 ${did} — 시스템 값 그대로입니다.`;
  }
  const details = adjusted.map((f) => {
    const reason = f.reason?.trim() ?? "";
    const why = reason === "" ? "이유가 남아 있지 않습니다" : reason;
    const target = person(f.user_id, names);
    return `${target} ${percent(f.final_value)}(시스템 ${percent(f.system_value)}, 이유: ${why})`;
  });
  return `${when}에 ${did} — ${details.join(" · ")}`;
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
function tryGet(url) {
  return trySend(() => fetch(url, { credentials: "same-origin", cache: "no-store" }));
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
function scoreCards(count = 3) {
  const one = `<div class="read"><div class="read-who">${bar(72, "title")}</div><div class="read-val">${bar(88, "line")}</div><div class="read-unc">${bar(100, "track")}</div><div class="read-why">${bar(90, "line")}${bar(64, "line")}</div></div>`;
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
function channelLabel(meeting) {
  const title = (meeting.title ?? "").trim();
  return title === "" ? `회의 ${meeting.meeting_id}` : title;
}
function channelHref(meetingId, projectId2) {
  const base = `/lobby.html?meeting=${meetingId}`;
  return projectId2 != null && projectId2 > 0 ? `${base}&project=${projectId2}` : base;
}
function meetingChannels(meetings, context = {}) {
  const { projectId: projectId2, currentMeetingId } = context;
  return meetings.map((meeting) => ({
    meetingId: meeting.meeting_id,
    label: channelLabel(meeting),
    href: channelHref(meeting.meeting_id, projectId2),
    state: channelState(meeting.status),
    stateLabel: describeMeetingStatus(meeting.status),
    current: currentMeetingId != null && currentMeetingId === meeting.meeting_id,
    pending: meeting.pending_candidates > 0 ? meeting.pending_candidates : null
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
function panelMembers(members) {
  return members.map((member) => {
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
function unmeasurableNote(members) {
  const count = members.filter((m) => m.state === "unmeasurable").length;
  if (count === 0) return null;
  return `${count}명은 GitHub 아이디가 없어 코드 활동이 기여도에 안 들어갑니다 — 설정에서 각자 연결합니다`;
}
function emptyMembersNote() {
  return "팀원을 불러오지 못했습니다";
}

// src/lib/nav/rail.ts
var STAYS = /* @__PURE__ */ new Set(["kanban", "contributions", "project"]);
function railHref(screen, projectId2) {
  const target = STAYS.has(screen) ? screen : "kanban";
  return `/${target}.html?project=${projectId2}`;
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

// src/demo/nav.ts
function renderNav(current) {
  const context = contextFromSearch(current, location.search);
  paint(context);
  const tabHost = document.getElementById("tabs");
  if (tabHost) void fillChannels(tabHost, context);
}
function paint(context, shell = {}) {
  const tabHost = document.getElementById("tabs");
  if (tabHost) {
    const chan = tabHost.querySelector(".chan") ?? document.createElement("div");
    chan.className = "chan";
    const name = shellHeading(shell.projectTitle);
    const heading = `<p class="chan-project" title="${escapeHtml(name)}">${escapeHtml(name)}</p>`;
    tabHost.innerHTML = navTabs(context).map((tab) => {
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
    paintRail(context, shell.projects ?? []);
  }
  const host = document.getElementById("nav");
  if (!host) return;
  const links = navLinks(context).map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`).join("");
  const notes = missingLinks(context).map((note) => `<span class="miss">${escapeHtml(note)}</span>`).join("");
  host.innerHTML = links + notes;
}
function paintRail(context, projects) {
  const existing = document.querySelector(".rail");
  if (!railIsWorthIt(projects)) {
    existing?.remove();
    document.body.classList.remove("has-rail");
    return;
  }
  const rail = existing instanceof HTMLElement ? existing : document.createElement("nav");
  rail.className = "rail";
  rail.setAttribute("aria-label", "프로젝트");
  rail.innerHTML = railItems(projects, context.current, context.projectId).map((item) => {
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
async function fillChannels(tabHost, context) {
  const apiBase2 = safeApiBase(new URLSearchParams(location.search).get("api"), location.origin);
  const projectId2 = await resolveProjectId(apiBase2, context);
  if (projectId2 === null) return;
  const projects = await fetchProjects(apiBase2);
  const title = projects.find((p) => p.project_id === projectId2)?.title ?? null;
  if (context.projectId !== projectId2 || title !== null) {
    paint({ ...context, projectId: projectId2 }, { projectTitle: title, projects });
  }
  await Promise.all([
    listChannels(tabHost, apiBase2, { ...context, projectId: projectId2 }),
    fillPanel(apiBase2, projectId2)
  ]);
}
async function fillPanel(apiBase2, projectId2) {
  const host = document.querySelector(".ctx");
  if (!(host instanceof HTMLElement)) return;
  const wide = window.matchMedia(PANEL_WIDTH);
  if (!wide.matches) {
    wide.addEventListener("change", () => void fillPanel(apiBase2, projectId2), { once: true });
    return;
  }
  const response = await tryGet(`${apiBase2}/api/projects/${projectId2}/members`);
  if (response === null || !response.ok) return;
  const members = panelMembers(await response.json());
  if (members.length === 0) {
    host.innerHTML = `<p class="ctx-note">${escapeHtml(emptyMembersNote())}</p>`;
    return;
  }
  const rows = members.map((row) => {
    const roles = row.roles === null ? "" : `<p class="ctx-roles">${escapeHtml(row.roles)}</p>`;
    const why = row.note === null ? "" : ` title="${escapeHtml(row.note)}"`;
    return `<div class="ctx-row" aria-label="${escapeHtml(row.ariaLabel)}"><p class="ctx-name"><span class="ctx-dot" data-state="${escapeHtml(row.state)}"${why}></span>${escapeHtml(row.name)}</p>` + roles + `</div>`;
  }).join("");
  const note = unmeasurableNote(members);
  host.innerHTML = `<p class="ctx-head">${escapeHtml(panelHeading(members.length))}</p>` + rows + (note === null ? "" : `<p class="ctx-note">${escapeHtml(note)}</p>`);
}
async function fetchProjects(apiBase2) {
  const response = await tryGet(`${apiBase2}/api/projects`);
  if (response === null || !response.ok) return [];
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}
async function listChannels(tabHost, apiBase2, context) {
  const wide = window.matchMedia(SHELL_WIDTH);
  if (!wide.matches) {
    wide.addEventListener("change", () => void listChannels(tabHost, apiBase2, context), {
      once: true
    });
    return;
  }
  const host = tabHost.querySelector(".chan");
  if (!(host instanceof HTMLElement)) return;
  const projectId2 = context.projectId;
  const response = await tryGet(`${apiBase2}/api/projects/${projectId2}/meetings`);
  if (response === null) {
    host.innerHTML = `<p class="chan-head">회의</p><p class="chan-none">목록을 불러오지 못했습니다 — 연결을 확인해 주세요</p>`;
    return;
  }
  if (!response.ok) return;
  const meetings = await response.json();
  const channels = meetingChannels(meetings, {
    projectId: projectId2,
    currentMeetingId: context.meetingId
  });
  host.innerHTML = `<p class="chan-head">회의</p>` + (channels.length === 0 ? `<p class="chan-none">${escapeHtml(emptyChannelsNote())}</p>` : renderChannels(channels));
}
async function resolveProjectId(apiBase2, context) {
  if (context.projectId != null && context.projectId > 0) return context.projectId;
  if (context.meetingId == null || context.meetingId <= 0) return null;
  const response = await tryGet(`${apiBase2}/api/meetings/${context.meetingId}`);
  if (response === null || !response.ok) return null;
  const meeting = await response.json();
  return typeof meeting.project_id === "number" ? meeting.project_id : null;
}
function renderChannels(channels) {
  const shown = channels.slice(0, CHANNEL_LIMIT);
  const rows = shown.map((channel) => {
    const current = channel.current ? ' aria-current="page"' : "";
    const count = channel.pending === null ? "" : `<span class="chan-count">${escapeHtml(String(channel.pending))}</span>`;
    return `<a class="chan-row" href="${escapeHtml(channel.href)}"${current} aria-label="${escapeHtml(channelAriaLabel(channel))}"><span class="chan-dot" data-state="${escapeHtml(channel.state)}"></span><span class="chan-name">${escapeHtml(channel.label)}</span>` + count + `</a>`;
  }).join("");
  const hidden = channels.length - shown.length;
  const more = hidden === 0 ? "" : `<p class="chan-none">그 밖에 ${escapeHtml(String(hidden))}개 — 홈에서 전부 봅니다</p>`;
  return rows + more;
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
var finalsKnown = false;
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
var get = (path) => tryGet(`${apiBase}${path}`);
function withEmphasis(text) {
  return escapeHtml(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function memberRow(member, uncertainty) {
  const notes = readBeforeTheNumber(member);
  const flags = integrityNotes(member);
  const noEvidence = hasNoEvidence(member);
  const categories = categoriesForDisplay(member).map((c) => {
    const share = Math.round(c.team_share * 100);
    return `<li><span class="cat">${escapeHtml(describeCategory(c.category))}</span><span class="catbar"><i style="width:${share}%"></i></span><span class="catnum">${c.event_count}건</span></li>`;
  }).join("");
  const width = uncertainty?.ratio ?? 0;
  const spread = uncertainty === void 0 || uncertainty.points === 0 ? '<p class="unc-none">구간이 없습니다 — 이 값은 확정적입니다</p>' : `<div class="unc-bar"><i style="width:${width}%"></i></div><p class="unc-note">모르는 폭 ${Math.round(uncertainty.points)}%p</p>`;
  return `
<div class="read">
  <div class="read-who">
    <span class="who">${escapeHtml(nameOf(member.user_id, people))}</span>
    <span class="role">${escapeHtml(roleOf(member, people))}</span>
  </div>

  <div class="read-val">
    <p class="range">${escapeHtml(describeRange(member))}</p>
    <p class="conf">신뢰도 ${escapeHtml(member.confidence_label)}</p>
  </div>

  <div class="read-unc">${spread}</div>

  <div class="read-why">
    ${noEvidence ? '<p class="empty">이 사람의 활동이 아직 하나도 연결되지 않았습니다 — 0 이라는 뜻이 아니라 <strong>연결이 없다</strong>는 뜻입니다.</p>' : ""}
    ${// ⚠️ **첫 줄만 보이고 나머지는 접습니다** (docs/19 §18).
  //
  // `readBeforeTheNumber` 는 측정 불가를 **맨 앞**에 놓습니다 — 이
  // 숫자를 얼마나 믿을지 정하는 가장 큰 요인이라 그렇게 정렬해
  // 뒀습니다. 그 판단을 여기서 그대로 씁니다: 맨 앞 하나는 늘 보이고,
  // 나머지 신뢰도 사유는 접힌 곳에 있습니다.
  //
  // 예전에는 셋이 다 깔려서 사람 셋이면 아홉 줄이었고, 그 아홉 줄이
  // 전부 비슷하게 생겨서 **정작 다른 한 줄(측정 불가)이 묻혔습니다.**
  notes.length ? `<ul class="notes"><li>${withEmphasis(notes[0] ?? "")}</li></ul>` : ""}
    ${categories ? `<ul class="cats">${categories}</ul>` : ""}
    ${moreHtml(notes.slice(1), flags)}
  </div>
</div>`;
}
function moreHtml(rest, flags) {
  if (rest.length === 0 && flags.length === 0) return "";
  const body = (rest.length ? `<ul class="notes">${rest.map((n) => `<li>${withEmphasis(n)}</li>`).join("")}</ul>` : "") + (flags.length ? `<ul class="flags">${flags.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul><p class="flagnote">표시만 합니다 — 이 신호로 점수를 깎지 않습니다. 판단은 팀이 합니다.</p>` : "");
  const label = flags.length ? "신뢰도 사유와 표시" : "신뢰도 사유";
  return `<details class="more"><summary>${label}</summary><div class="more-body">${body}</div></details>`;
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
  const shown = orderForDisplay(score.members, people);
  const spans = new Map(uncertaintySpans(shown).map((s) => [s.userId, s]));
  $("members").innerHTML = shown.map((ms) => memberRow(ms, spans.get(ms.user_id))).join("");
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
function restoreAdjustments(finals) {
  const saved = adjustmentsToRestore(finals);
  for (const row of $("finals").querySelectorAll(".final-row")) {
    const mine = saved.get(Number(row.dataset["user"]));
    const val = row.querySelector(".val");
    const reason = row.querySelector(".reason");
    if (val) val.value = mine === void 0 ? "" : String(mine.final_value);
    if (reason) reason.value = mine?.reason ?? "";
  }
}
async function loadFinals() {
  const response = await get(`/api/projects/${projectId}/contributions/final`);
  if (response === null || !response.ok) {
    $("final-state").textContent = "";
    finalsKnown = false;
    return;
  }
  const body = await response.json();
  const names = new Map(people.map((p) => [p.user_id, p.name]));
  $("final-state").textContent = describeFinals(body.finals, names);
  restoreAdjustments(body.finals);
  finalsKnown = true;
}
async function confirm() {
  if (!finalsKnown) {
    showNote($("final-message"), BLIND_CONFIRM);
    return;
  }
  const drafts = draftsFromScreen();
  const problems = problemsWith(drafts, systemValues);
  if (problems.length > 0) {
    showNote($("final-message"), problems.join(" · "));
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
    showNote($("final-message"), unreachableText("확정하지 못했습니다"));
    return;
  }
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    showNote(
      $("final-message"),
      typeof body?.detail === "string" ? body.detail : describeHttpStatus(response.status) ?? "확정하지 못했습니다"
    );
    return;
  }
  showNote($("final-message"), "확정했습니다.", "plain");
  await loadFinals();
}
async function fetchAll() {
  const [scoreRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/contributions`),
    get(`/api/projects/${projectId}/members`)
  ]);
  if (scoreRes === null) return { kind: "unreachable" };
  if (isSessionExpired(scoreRes.status)) return { kind: "expired" };
  if (!scoreRes.ok) return { kind: "failed", status: scoreRes.status };
  if (memberRes?.ok) people = await memberRes.json();
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
  if (result.kind === "unreachable") {
    $("members").innerHTML = failureHtml({
      what: unreachableText("기여도를 불러오지 못했습니다."),
      retry: true
    });
    $("members").querySelector(".retry")?.addEventListener("click", () => {
      void load();
    });
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
  if (me === null) {
    await load();
    return;
  }
  if (!me.ok) {
    goToLogin();
    return;
  }
  $("who").textContent = `${(await me.json()).name} 님이 보고 있습니다`;
  await load();
}
$("confirm").addEventListener("click", () => {
  void whilePressed($("confirm"), confirm);
});
void start();
renderNav("contributions");
bootApp();
