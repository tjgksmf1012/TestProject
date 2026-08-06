// src/lib/lobby/room.ts
var MIN_USABLE_COVERAGE = 0.8;
var WARN_GAP_MS = 3e4;
function consentStateOf(entry) {
  if (entry.recording === null || entry.recording === void 0) return "pending";
  return entry.recording ? "granted" : "refused";
}
function describeConsent(state) {
  switch (state) {
    case "granted":
      return "동의함";
    case "refused":
      return "거부함";
    case "pending":
      return "응답 대기 중";
  }
}
function summarizeConsent(roster2) {
  const pendingNames = [];
  const refusedNames = [];
  let granted = 0;
  for (const entry of roster2) {
    switch (consentStateOf(entry)) {
      case "granted":
        granted += 1;
        break;
      case "refused":
        refusedNames.push(entry.name);
        break;
      case "pending":
        pendingNames.push(entry.name);
        break;
    }
  }
  return {
    total: roster2.length,
    granted,
    refused: refusedNames.length,
    pending: pendingNames.length,
    pendingNames,
    refusedNames
  };
}
function startBlockers(roster2) {
  if (roster2.length === 0) {
    return ["이 프로젝트에 팀원이 없습니다"];
  }
  const summary = summarizeConsent(roster2);
  const blockers = [];
  if (summary.refused > 0) {
    blockers.push(`${summary.refusedNames.join(", ")} 님이 녹음을 거부했습니다`);
  }
  if (summary.pending > 0) {
    blockers.push(`${summary.pendingNames.join(", ")} 님이 아직 응답하지 않았습니다`);
  }
  return blockers;
}
function canStart(roster2) {
  return startBlockers(roster2).length === 0;
}
function verdictOf(track) {
  if (track === void 0) return "not_joined";
  const coverage = track.coverage;
  if (track.status === "recording") {
    if (coverage !== null && coverage < MIN_USABLE_COVERAGE) return "broken";
    if ((track.total_gap_ms ?? 0) >= WARN_GAP_MS) return "at_risk";
    return "healthy";
  }
  if (track.status === "completed") return "finished";
  return "broken";
}
function messageFor(verdict, track) {
  const coverage = track?.coverage;
  const percent = coverage === null || coverage === void 0 ? null : Math.round(coverage * 100);
  switch (verdict) {
    case "not_joined":
      return "아직 참가하지 않았습니다";
    case "healthy":
      return "녹음 중";
    case "at_risk":
      return `녹음이 끊기고 있습니다 (공백 ${Math.round((track?.total_gap_ms ?? 0) / 1e3)}초) — 폰 화면을 켜 주세요`;
    case "broken":
      return percent === null ? "녹음을 쓸 수 없습니다 — 이 사람의 발언량은 측정할 수 없습니다" : `커버리지 ${percent}% — 이 사람의 발언량은 측정할 수 없습니다`;
    case "finished":
      return percent === null ? "녹음 종료" : `녹음 종료 (커버리지 ${percent}%)`;
  }
}
function memberStatuses(roster2, tracks2) {
  const byUser = /* @__PURE__ */ new Map();
  for (const track of tracks2) byUser.set(track.user_id, track);
  return roster2.map((entry) => {
    const track = byUser.get(entry.user_id);
    const verdict = verdictOf(track);
    return {
      userId: entry.user_id,
      name: entry.name,
      consent: consentStateOf(entry),
      verdict,
      coverage: track?.coverage ?? null,
      message: messageFor(verdict, track)
    };
  });
}
function roomStatus(statuses) {
  const recording = statuses.filter(
    (s) => s.verdict === "healthy" || s.verdict === "at_risk"
  ).length;
  const notJoined = statuses.filter(
    (s) => s.verdict === "not_joined" && s.consent === "granted"
  ).length;
  const broken = statuses.filter((s) => s.verdict === "broken").length;
  const anyJoined = statuses.some((s) => s.verdict !== "not_joined");
  let message;
  if (!anyJoined) {
    message = "아직 아무도 참가하지 않았습니다";
  } else if (recording > 0) {
    message = `${recording}명이 녹음 중입니다`;
  } else if (notJoined > 0) {
    message = `${notJoined}명이 참가하지 않아 회의가 끝나지 않습니다 — 강제 종료할 수 있습니다`;
  } else {
    message = "전원 종료했습니다. 회의 처리가 시작됩니다";
  }
  return {
    recording,
    notJoined,
    broken,
    // 녹음 중인 사람이 없는데 참가 안 한 사람이 남아 있으면 사람이 풀어야 한다.
    needsForceFinish: anyJoined && recording === 0 && notJoined > 0,
    message
  };
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

// src/demo/lobby.ts
var params = new URLSearchParams(location.search);
var meetingId = Number(params.get("meeting") ?? "1");
var apiBase = params.get("api") ?? "";
var meId = 0;
var POLL_MS = 3e3;
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
var roster = [];
var tracks = [];
var consentMessage = "";
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
async function getJson(path) {
  const response = await fetch(`${apiBase}${path}`, {
    cache: "no-store",
    credentials: "same-origin"
  });
  if (isSessionExpired(response.status)) {
    goToLogin();
    throw new Error("로그인이 필요합니다");
  }
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
async function refresh() {
  try {
    const [consent, trackBody] = await Promise.all([
      getJson(`/api/meetings/${meetingId}/consent`),
      getJson(`/api/meetings/${meetingId}/tracks`)
    ]);
    roster = consent.roster;
    consentMessage = consent.message;
    tracks = trackBody.tracks;
    render();
  } catch (err) {
    $("sub").textContent = `불러오지 못했습니다: ${String(err)}`;
  }
}
async function submitConsent(consented) {
  try {
    const response = await fetch(`${apiBase}/api/meetings/${meetingId}/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `user_id` 를 보내지 않는다. **동의는 본인만 한다** — 서버가 세션에서
      // 읽으므로 남을 대신해 동의해 줄 방법이 없다.
      body: JSON.stringify({ consent_type: "recording", consented }),
      credentials: "same-origin"
    });
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    const body = await response.json();
    if (!response.ok) {
      $("consent-message").textContent = body.detail ?? "동의를 제출하지 못했습니다";
      return;
    }
    roster = body.roster;
    consentMessage = body.message;
    render();
  } catch (err) {
    $("consent-message").textContent = `전송 실패: ${String(err)}`;
  }
}
async function forceFinish() {
  const ok = confirm(
    "참가하지 않은 사람을 기다리지 않고 회의를 끝냅니다.\n그 사람의 발언은 기록되지 않습니다. 계속할까요?"
  );
  if (!ok) return;
  try {
    const response = await fetch(`${apiBase}/api/meetings/${meetingId}/finish`, {
      method: "POST",
      credentials: "same-origin"
    });
    const body = await response.json();
    $("room-message").textContent = body.message ?? "";
    await refresh();
  } catch (err) {
    $("room-message").textContent = `강제 종료 실패: ${String(err)}`;
  }
}
function renderRoster() {
  $("roster").innerHTML = roster.map((entry) => {
    const state = consentStateOf(entry);
    const mine = entry.user_id === meId ? " (나)" : "";
    return `<li><span class="name">${escapeHtml(entry.name)}${mine}</span><span class="state ${state}">${describeConsent(state)}</span></li>`;
  }).join("");
  const blockers = startBlockers(roster);
  const box = $("blockers");
  box.hidden = blockers.length === 0;
  box.innerHTML = blockers.map((b) => `<p>${escapeHtml(b)}</p>`).join("");
  $("consent-message").textContent = consentMessage;
}
function renderMembers(statuses) {
  $("members").innerHTML = statuses.map(
    (s) => `<li class="${s.verdict}"><span class="name">${escapeHtml(s.name)}</span><span class="state">${escapeHtml(s.message)}</span></li>`
  ).join("");
}
function render() {
  const statuses = memberStatuses(roster, tracks);
  const room = roomStatus(statuses);
  renderRoster();
  renderMembers(statuses);
  $("sub").textContent = `회의 ${meetingId} · 팀원 ${roster.length}명`;
  $("room-message").textContent = room.message;
  const record = $("record");
  record.disabled = !canStart(roster);
  record.textContent = record.disabled ? "전원 동의 후 시작할 수 있습니다" : "녹음 화면으로";
  $("finish").hidden = !room.needsForceFinish;
  $("review").hidden = room.recording > 0 || room.notJoined > 0 || tracks.length === 0;
}
$("agree").addEventListener("click", () => void submitConsent(true));
$("refuse").addEventListener("click", () => void submitConsent(false));
$("finish").addEventListener("click", () => void forceFinish());
$("record").addEventListener("click", () => {
  location.href = `/index.html?meeting=${meetingId}`;
});
$("review").addEventListener("click", () => {
  location.href = `/review.html?meeting=${meetingId}`;
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
  const response = await fetch(`${apiBase}/api/auth/me`, { credentials: "same-origin" });
  if (!response.ok) {
    goToLogin();
    return;
  }
  const me = await response.json();
  meId = me.user_id;
  $("who").textContent = `${me.name} 님으로 로그인했습니다`;
  await refresh();
  setInterval(() => void refresh(), POLL_MS);
}
void start();
