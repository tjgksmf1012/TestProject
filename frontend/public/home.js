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
  return "속한 프로젝트가 없습니다. 팀원 중 한 명이 프로젝트를 만들고 당신을 넣어야 합니다 — 만든 사람은 자동으로 구성원이 됩니다.";
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

// src/demo/home.ts
var params = new URLSearchParams(location.search);
var apiBase = params.get("api") ?? "";
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
  ${step.href ? `<a class="go${step.actionable ? " primary" : ""}" href="${escapeHtml(step.href)}">
           ${escapeHtml(step.label)}</a>` : ""}
</li>`;
}
function projectHtml(project, meetings) {
  const links = `<a href="/kanban.html?project=${project.project_id}">칸반</a><a href="/contributions.html?project=${project.project_id}">기여도</a>`;
  return `
<section class="project">
  <h2>${escapeHtml(project.title)}</h2>
  <p class="sub">${escapeHtml(describeProject(project))}</p>
  <div class="links">${links}</div>
  ${meetings.length ? `<ul class="meetings">${meetings.map(meetingHtml).join("")}</ul>` : '<p class="empty">회의를 열면 여기에 나옵니다.</p>'}
</section>`;
}
async function load() {
  const response = await get("/api/projects");
  if (isSessionExpired(response.status)) {
    goToLogin();
    return;
  }
  if (!response.ok) {
    $("projects").textContent = `불러오지 못했습니다 (HTTP ${response.status})`;
    return;
  }
  const projects = orderProjects(await response.json());
  if (projects.length === 0) {
    $("projects").innerHTML = `<p class="empty">${escapeHtml(emptyProjectsMessage())}</p>`;
    return;
  }
  const meetings = await Promise.all(
    projects.map(
      (p) => get(`/api/projects/${p.project_id}/meetings`).then(
        (r) => r.ok ? r.json() : []
      )
    )
  );
  $("projects").innerHTML = projects.map((project, index) => projectHtml(project, meetings[index] ?? [])).join("");
}
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
