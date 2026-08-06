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
      `${category} 기여를 **측정하지 못했습니다** — ${gap.reason ?? "사유 미기록"}. 0 으로 계산하지 않고 나머지 활동으로 추정했습니다.`
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
      `${names} 님은 일부 활동을 측정하지 못했습니다. 그 영역은 0 이 아니라 나머지 활동으로 추정한 값입니다.`
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
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
var get = (path) => fetch(`${apiBase}${path}`, { credentials: "same-origin", cache: "no-store" });
function memberCard(member) {
  const bar = rangeBar(member);
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
    <span class="role">${escapeHtml(member.role)}</span>
  </header>

  <p class="range">${escapeHtml(describeRange(member))}</p>
  <div class="track"><i style="left:${bar.left}%;width:${bar.width}%"></i></div>
  <p class="conf">신뢰도 ${escapeHtml(member.confidence_label)}</p>

  ${noEvidence ? '<p class="empty">이 사람의 활동이 아직 하나도 연결되지 않았습니다 — 0 이라는 뜻이 아니라 <strong>연결이 없다</strong>는 뜻입니다.</p>' : ""}

  ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>` : ""}

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
  $("members").innerHTML = orderForDisplay(score.members, people).map(memberCard).join("");
}
async function load() {
  const [scoreRes, memberRes] = await Promise.all([
    get(`/api/projects/${projectId}/contributions`),
    get(`/api/projects/${projectId}/members`)
  ]);
  if (isSessionExpired(scoreRes.status)) {
    goToLogin();
    return;
  }
  if (!scoreRes.ok) {
    $("warnings").hidden = false;
    $("warnings").textContent = scoreRes.status === 403 ? "이 프로젝트의 구성원만 기여도를 볼 수 있습니다." : `기여도를 불러오지 못했습니다 (HTTP ${scoreRes.status})`;
    return;
  }
  if (memberRes.ok) people = await memberRes.json();
  render(await scoreRes.json());
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
renderNav("contributions");
