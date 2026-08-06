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
function safeRedirect(next2, fallback = "/lobby.html") {
  if (!next2) return fallback;
  if (!next2.startsWith("/")) return fallback;
  if (next2.startsWith("//")) return fallback;
  if (next2.startsWith("/\\")) return fallback;
  return next2;
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

// src/demo/login.ts
var params = new URLSearchParams(location.search);
var apiBase = params.get("api") ?? "";
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
    const response = await fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // 쿠키를 받으려면 필요하다. 같은 오리진이면 기본값도 same-origin 이지만,
      // 개발 중에 ?api= 로 다른 주소를 붙였을 때 조용히 로그인이 안 되는 걸
      // 막는다.
      credentials: "same-origin"
    });
    if (!response.ok) {
      const detail = await response.json().then((b) => b.detail).catch(() => void 0);
      showMessage(describeAuthFailure(response.status, detail));
      return;
    }
    location.href = next;
  } catch (err) {
    showMessage(`연결하지 못했습니다: ${String(err)}`);
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
});
render();
