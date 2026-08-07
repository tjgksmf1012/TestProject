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

// src/lib/call/mesh.ts
function shouldInitiate(me2, other) {
  return me2 < other;
}
function planPeers(roster2, me2, open) {
  const wanted = new Map(
    roster2.filter((p) => p.user_id !== me2).map((p) => [p.user_id, p])
  );
  const actions = [];
  for (const [userId, peer] of [...wanted].sort((a, b) => a[0] - b[0])) {
    if (!open.has(userId)) {
      actions.push({
        type: "open",
        user_id: userId,
        name: peer.name,
        initiate: shouldInitiate(me2, userId)
      });
    }
  }
  for (const userId of [...open].sort((a, b) => a - b)) {
    if (!wanted.has(userId)) actions.push({ type: "close", user_id: userId });
  }
  return actions;
}
var STATE_TEXT = {
  new: { label: "연결 준비 중", tone: "warn" },
  connecting: { label: "연결 중…", tone: "warn" },
  connected: { label: "연결됨", tone: "ok" },
  // ⚠️ `disconnected` 는 **끊긴 게 아닙니다.** 네트워크가 잠깐 흔들리면
  // 여기 왔다가 스스로 돌아옵니다. "끊겼습니다" 라고 하면 사람이 통화를
  // 다시 걸고, 그러면 진짜로 끊깁니다.
  disconnected: { label: "신호가 불안정합니다", tone: "warn" },
  failed: { label: "연결 실패 — 네트워크가 막고 있을 수 있습니다", tone: "bad" },
  closed: { label: "나갔습니다", tone: "bad" }
};
function describePeer(peer, state) {
  const text = STATE_TEXT[state] ?? STATE_TEXT.new;
  return {
    user_id: peer.user_id,
    name: peer.name,
    state,
    headphones: peer.headphones,
    label: text.label,
    tone: text.tone
  };
}
function describeCall(peers2) {
  if (peers2.length === 0) return "혼자 있습니다. 다른 팀원이 들어오면 자동으로 연결됩니다.";
  const connected = peers2.filter((p) => p.state === "connected").length;
  if (connected === peers2.length) return `${peers2.length}명과 통화 중입니다.`;
  return `${peers2.length}명 중 ${connected}명 연결됨 — 나머지는 연결 중입니다.`;
}
function callWarnings(serverWarnings2, peers2, micReady2) {
  const problems = [...serverWarnings2];
  if (!micReady2) {
    problems.push(
      "마이크가 켜지지 않았습니다 — 이 상태로는 내 발언이 하나도 기록되지 않습니다."
    );
  }
  const failed = peers2.filter((p) => p.state === "failed");
  if (failed.length) {
    const names = failed.map((p) => p.name).join(", ");
    problems.push(
      `${names} 와 연결하지 못했습니다. 그 사람에게는 내 목소리가 가지 않습니다.`
    );
  }
  return problems;
}
var CALL_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false
};
function captureProblems(settings) {
  const problems = [];
  if (settings.autoGainControl === true) {
    problems.push(
      "자동 게인을 끄지 못했습니다 — 이 트랙의 발언량이 부풀려질 수 있습니다."
    );
  }
  if (settings.echoCancellation === false) {
    problems.push(
      "에코 제거를 켜지 못했습니다 — 스피커로 들으면 남의 목소리가 내 트랙에 섞입니다."
    );
  }
  return problems;
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

// src/demo/call.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var meetingId = Number(params.get("meeting") ?? "0");
var headphones = params.get("headphones") !== "no";
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
var me = 0;
var roster = [];
var serverWarnings = [];
var micReady = false;
var socket = null;
var localStream = null;
var peers = /* @__PURE__ */ new Map();
var states = /* @__PURE__ */ new Map();
var RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};
function goToLogin() {
  location.href = loginUrlFor(location.pathname + location.search);
}
function say(text, bad = false) {
  $("status").textContent = text;
  $("status").className = bad ? "bad" : "";
}
function render() {
  const views = roster.filter((p) => p.user_id !== me).map((p) => describePeer(p, states.get(p.user_id) ?? "new"));
  $("summary").textContent = describeCall(views);
  const mine = roster.find((p) => p.user_id === me);
  const rows = [
    mine ? `<li><span class="face me">${escapeHtml(mine.name.slice(0, 1))}</span>
           <span class="who"><span class="name">${escapeHtml(mine.name)} (나)</span>
           <span class="state ok">이 기기에서 녹음됩니다</span></span>
           ${mine.headphones ? "" : '<span class="badge">헤드폰 없음</span>'}</li>` : "",
    ...views.map(
      (p) => `<li><span class="face">${escapeHtml(p.name.slice(0, 1))}</span>
        <span class="who"><span class="name">${escapeHtml(p.name)}</span>
        <span class="state ${p.tone}">${escapeHtml(p.label)}</span></span>
        ${p.headphones ? "" : '<span class="badge">헤드폰 없음</span>'}</li>`
    )
  ];
  $("peers").innerHTML = rows.join("");
  const problems = callWarnings(serverWarnings, views, micReady);
  $("warnings").innerHTML = problems.map((w) => `<li>${escapeHtml(w.replace(/\*\*/g, ""))}</li>`).join("");
}
async function openMic() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      // ⚠️ 같은 방에서 쓰던 설정과 두 개가 반대다 (docs/15 §2.2).
      audio: { ...CALL_AUDIO_CONSTRAINTS }
    });
  } catch {
    micReady = false;
    $("mic").textContent = "마이크를 열지 못했습니다. 브라우저 권한을 확인하세요.";
    render();
    return;
  }
  micReady = true;
  const track = localStream.getAudioTracks()[0];
  const settings = track?.getSettings() ?? {};
  const problems = captureProblems(settings);
  $("mic").textContent = problems.length ? problems.join(" ") : "마이크가 켜졌습니다 (에코 제거 켬 · 자동 게인 끔).";
  meterFrom(localStream);
  render();
}
function meterFrom(stream) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  context.createMediaStreamSource(stream).connect(analyser);
  const buffer = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    analyser.getByteTimeDomainData(buffer);
    let peak = 0;
    for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128));
    $("level").style.width = `${Math.min(100, peak / 128 * 240)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}
function send(body) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
}
function connectionFor(userId, initiate) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers.set(String(userId), pc);
  states.set(userId, "connecting");
  for (const track of localStream?.getAudioTracks() ?? []) {
    pc.addTrack(track, localStream);
  }
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      send({ kind: "ice", to: userId, payload: JSON.stringify(event.candidate) });
    }
  };
  pc.onconnectionstatechange = () => {
    states.set(userId, pc.connectionState);
    render();
  };
  pc.ontrack = (event) => {
    const audio = new Audio();
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    audio.autoplay = true;
    void audio.play().catch(() => void 0);
  };
  if (initiate) {
    void (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ kind: "offer", to: userId, payload: JSON.stringify(offer) });
    })();
  }
  return pc;
}
function applyRoster(next) {
  roster = next.peers;
  serverWarnings = next.warnings ?? [];
  const open = new Set([...peers.keys()].map(Number));
  for (const action of planPeers(roster, me, open)) {
    if (action.type === "open") {
      connectionFor(action.user_id, action.initiate);
    } else {
      peers.get(String(action.user_id))?.close();
      peers.delete(String(action.user_id));
      states.delete(action.user_id);
    }
  }
  render();
}
async function onSignal(body) {
  const from = Number(body.from);
  const pc = peers.get(String(from)) ?? connectionFor(from, false);
  const payload = JSON.parse(String(body.payload));
  if (body.kind === "offer") {
    await pc.setRemoteDescription(payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ kind: "answer", to: from, payload: JSON.stringify(answer) });
  } else if (body.kind === "answer") {
    await pc.setRemoteDescription(payload);
  } else if (body.kind === "ice") {
    await pc.addIceCandidate(payload).catch(() => void 0);
  }
}
function openSocket() {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const base = apiBase || `${scheme}://${location.host}`;
  const wsBase = base.replace(/^http/, "ws");
  socket = new WebSocket(
    `${wsBase}/api/meetings/${meetingId}/call?headphones=${headphones ? "yes" : "no"}`
  );
  socket.onmessage = (event) => {
    const body = JSON.parse(event.data);
    if (body.kind === "roster") return applyRoster(body);
    if (body.kind === "rejected") return say(String(body.reason ?? "통화에 들어가지 못했습니다"), true);
    if (body.kind === "refused") return say(String(body.reason ?? ""), true);
    void onSignal(body);
  };
  socket.onclose = () => {
    $("summary").textContent = "통화가 끊겼습니다.";
    say("연결이 닫혔습니다. 새로고침하면 다시 붙습니다.", true);
  };
}
$("record").addEventListener("click", () => {
  location.href = `/index.html?meeting=${meetingId}`;
});
$("leave").addEventListener("click", () => {
  socket?.close();
  for (const pc of peers.values()) pc.close();
  for (const track of localStream?.getAudioTracks() ?? []) track.stop();
  location.href = `/lobby.html?meeting=${meetingId}`;
});
async function start() {
  const response = await fetch(`${apiBase}/api/auth/me`, {
    credentials: "same-origin",
    cache: "no-store"
  });
  if (isSessionExpired(response.status) || !response.ok) {
    goToLogin();
    return;
  }
  const who = await response.json();
  me = who.user_id;
  $("sub").textContent = `${who.name} 님으로 참여 중`;
  await openMic();
  openSocket();
}
void start();
renderNav("lobby");
bootApp();
