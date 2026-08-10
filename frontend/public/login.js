// src/lib/http/detail.ts
function isValidationList(value2) {
  return Array.isArray(value2) && value2.length > 0 && value2.every((item) => typeof item === "object" && item !== null);
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

// src/lib/auth/session.ts
var MIN_PASSWORD_LENGTH = 8;
function validateLogin(email, password) {
  const problems = [];
  if (!email.trim()) {
    problems.push({ field: "email", message: "이메일을 입력하세요" });
  } else if (!email.includes("@")) {
    problems.push({ field: "email", message: "이메일 형식이 아닙니다" });
  }
  if (!password) {
    problems.push({ field: "password", message: "비밀번호를 입력하세요" });
  }
  return problems;
}
function validateSignup(name, email, password) {
  const problems = validateLogin(email, password);
  if (!name.trim()) {
    problems.push({ field: "name", message: "이름을 입력하세요" });
  }
  if (password && password.length < MIN_PASSWORD_LENGTH) {
    problems.push({
      field: "password",
      message: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`
    });
  }
  return problems;
}
function safeRedirect(next2, fallback = "/home.html") {
  if (!next2) return fallback;
  if (!next2.startsWith("/")) return fallback;
  if (next2.startsWith("//")) return fallback;
  if (next2.startsWith("/\\")) return fallback;
  return next2;
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
function describeAuthFailure(status, detail) {
  if (status === 401) return detail || "이메일 또는 비밀번호가 올바르지 않습니다";
  if (status === 409) return detail || "이미 가입된 이메일입니다";
  if (status === 400) return detail || "입력을 확인하세요";
  if (status >= 500) return "서버에 문제가 있습니다. 잠시 뒤 다시 시도하세요";
  return detail || `요청이 실패했습니다 (HTTP ${status})`;
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

// src/demo/login.ts
var params = new URLSearchParams(location.search);
var apiBase = safeApiBase(params.get("api"), location.origin);
var next = safeRedirect(params.get("next"));
var $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`요소 없음: ${id}`);
  return el;
};
var value = (id) => $(id).value;
var mode = "login";
function showProblems(problems) {
  $("error").innerHTML = problems.map((p) => `<p>${escapeHtml(p.message)}</p>`).join("");
  $("error").hidden = problems.length === 0;
}
function showMessage(text) {
  $("error").innerHTML = `<p>${escapeHtml(text)}</p>`;
  $("error").hidden = false;
}
function render() {
  const signup = mode === "signup";
  $("name-row").hidden = !signup;
  $("submit").textContent = signup ? "가입하고 시작하기" : "로그인";
  $("toggle").textContent = signup ? "이미 계정이 있습니다 — 로그인" : "처음이신가요? 가입하기";
  $("title").textContent = signup ? "가입" : "로그인";
  $("error").hidden = true;
}
async function submit() {
  const email = value("email");
  const password = value("password");
  const name = value("name");
  const problems = mode === "signup" ? validateSignup(name, email, password) : validateLogin(email, password);
  if (problems.length) {
    showProblems(problems);
    return;
  }
  const button = $("submit");
  button.disabled = true;
  try {
    const path = mode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const body = mode === "signup" ? { name, email, password } : { email, password };
    const response = await trySend(
      () => fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // 쿠키를 받으려면 필요하다. 같은 오리진이면 기본값도 same-origin 이지만,
        // 개발 중에 ?api= 로 다른 주소를 붙였을 때 조용히 로그인이 안 되는 걸
        // 막는다.
        credentials: "same-origin"
      })
    );
    if (response === null) {
      showMessage(unreachableText(mode === "signup" ? "가입하지 못했습니다" : "로그인하지 못했습니다"));
      return;
    }
    if (!response.ok) {
      const body2 = await response.json().catch(() => null);
      const detail = detailText(body2, "") || void 0;
      showMessage(describeAuthFailure(response.status, detail));
      return;
    }
    location.href = next;
  } catch (err) {
    console.error(err);
    showMessage(describeUnexpected());
  } finally {
    button.disabled = false;
  }
}
$("submit").addEventListener("click", () => void submit());
$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  void submit();
});
$("toggle").addEventListener("click", () => {
  mode = mode === "login" ? "signup" : "login";
  render();
});
void fetch(`${apiBase}/api/auth/me`, { credentials: "same-origin" }).then((r) => {
  if (r.ok) location.href = next;
}).catch(() => void 0);
render();
bootApp();
