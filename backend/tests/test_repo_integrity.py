"""저장소 자체의 무결성.

**실제로 일어난 사고를 막기 위한 테스트입니다.**

`.gitignore` 에 회의 오디오를 막으려고 `audio/` 라고만 적어뒀더니, 소스 패키지
`backend/teamflow/audio/` 가 통째로 무시됐습니다. `git add -A` 는 무시된 파일을
**조용히 건너뛰기 때문에** 커밋도 푸시도 성공했고, 로컬에는 파일이 있으니
테스트도 전부 통과했습니다. 새로 clone 한 사람만 `ModuleNotFoundError` 를 봅니다.

임포트 테스트로는 절대 안 잡힙니다 — 로컬 파일시스템에는 파일이 있으니까요.
git 에게 직접 물어봐야 합니다.

검사 대상은 "추적 중인가"가 아니라 **"무시되고 있는가"** 입니다.
아직 `git add` 하지 않은 작업 중인 파일은 정상이고, `git add -A` 가 알아서
집어갑니다. 진짜 사고는 **집어가지 못하는** 경우뿐입니다.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

SOURCE_PATTERNS = (
    "backend/teamflow/**/*.py",
    "backend/tests/**/*.py",
    "backend/migrations/**/*.py",
    "frontend/src/**/*.ts",
    "scripts/**/*.py",
    "docs/**/*.md",
)


def _source_files() -> list[Path]:
    found: set[Path] = set()
    for pattern in SOURCE_PATTERNS:
        for path in REPO_ROOT.glob(pattern):
            if {"__pycache__", "node_modules", ".venv"} & set(path.parts):
                continue
            found.add(path.relative_to(REPO_ROOT))
    return sorted(found)


def _ignored(paths: list[Path]) -> list[str]:
    """이 중 .gitignore 가 무시하는 것들."""
    if not paths:
        return []
    result = subprocess.run(
        ["git", "check-ignore", "--stdin"],
        cwd=REPO_ROOT,
        input="\n".join(str(p) for p in paths),
        capture_output=True,
        text=True,
        check=False,
    )
    # 종료코드 0 = 무시되는 게 있음, 1 = 없음, 그 외 = 오류
    if result.returncode not in (0, 1):
        pytest.skip(f"git check-ignore 를 쓸 수 없습니다: {result.stderr.strip()}")
    return [line for line in result.stdout.splitlines() if line]


def _tracked() -> set[Path]:
    result = subprocess.run(
        ["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    if result.returncode != 0:
        pytest.skip("git ls-files 를 쓸 수 없습니다")
    return {Path(p) for p in result.stdout.splitlines() if p}


def test_no_source_file_is_ignored():
    """⭐ .gitignore 가 소스를 삼키면 여기서 실패한다.

    `audio/` 처럼 저장 디렉터리와 이름이 겹치는 패키지가 또 생길 수 있다.
    무시 규칙은 반드시 `/` 로 시작해 경로를 앵커링해야 한다.
    """
    files = _source_files()
    assert files, "소스 파일을 하나도 못 찾았습니다 — 패턴이 잘못됐습니다"

    swallowed = _ignored(files)
    assert not swallowed, (
        ".gitignore 가 소스 파일을 무시하고 있습니다. `git add -A` 가 조용히 "
        "건너뛰므로 커밋은 성공하지만 clone 하면 파일이 없습니다:\n"
        + "\n".join(f"  {p}" for p in swallowed)
    )


def test_known_source_packages_survive_a_fresh_clone():
    """이미 커밋된 핵심 모듈이 사라지지 않았는지 확인한다.

    무시 규칙이 새로 추가돼도 **이미 추적 중인 파일은 계속 추적**되므로
    조용히 넘어간다. 목록으로 못 박아 둔다.
    """
    required = {
        Path("backend/teamflow/audio/multitrack.py"),
        Path("backend/teamflow/audio/chunk_store.py"),
        Path("backend/teamflow/video/speaker.py"),
        Path("backend/teamflow/pipeline/meeting_pipeline.py"),
        Path("frontend/src/lib/recording/client.ts"),
    }
    # 아직 커밋 전인 파일은 제외한다 — 스테이징되지 않은 작업 중 파일은 정상이다.
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=A"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    known = _tracked() | {Path(p) for p in staged.stdout.splitlines() if p}

    missing = sorted(p for p in required if p not in known and (REPO_ROOT / p).exists())
    assert not missing, (
        "로컬에는 있는데 git 에는 없는 모듈입니다. clone 하면 사라집니다:\n"
        + "\n".join(f"  {p}" for p in missing)
    )


def test_no_audio_file_is_tracked():
    """반대 방향도 지킨다 — 실제 음성이 저장소에 들어가면 안 된다.

    음성은 개인정보이고 생체인식정보로 간주될 수 있다 (docs/07).
    한 번 푸시되면 히스토리에서 지우기 어렵다.
    """
    leaked = sorted(
        p
        for p in _tracked()
        if p.suffix.lower() in {".wav", ".mp3", ".m4a", ".opus", ".webm", ".ogg"}
    )
    assert not leaked, f"음성 파일이 저장소에 있습니다: {leaked}"


def test_no_env_file_is_tracked():
    leaked = sorted(p for p in _tracked() if p.name == ".env")
    assert not leaked, f".env 가 커밋되어 있습니다: {leaked}"


def test_audio_storage_paths_are_still_ignored():
    """소스를 살리느라 진짜 오디오 저장 경로까지 열어버리면 안 된다."""
    must_ignore = ["audio/meeting-1.wav", "uploads/x.webm", "recordings/a.m4a"]
    ignored = set(_ignored([Path(p) for p in must_ignore]))
    for path in must_ignore:
        assert path in ignored, f"{path} 가 무시되지 않습니다 — 음성이 커밋될 수 있습니다"


def test_every_script_the_screens_load_is_in_the_repository():
    """⭐ clone 하고 uvicorn 만 띄우면 화면이 떠야 한다.

    이게 없던 동안 `frontend/public/main.js` 와 `review.js` 가 .gitignore
    에 들어 있었다. README 가 안내하는 대로

        clone → seed_demo.py → uvicorn → http://localhost:8000/review.html

    을 따라가면 **HTML 은 뜨는데 스크립트가 404 라 빈 화면**이었다. 오류도
    안 난다 — 이 저장소에서 반복해서 나오는 "문서가 안내하는 대로 했는데
    동작하지 않는" 부류다.

    프런트에 런타임 의존성이 0개인 게 이 프로젝트의 선택이고, "Node 없이
    연다" 가 시연 경로의 전제다. 그러니 번들을 커밋한다. 소스를 고치면
    `npm run build:demo` 로 다시 만들어 같이 커밋해야 한다.
    """
    import re

    public = REPO_ROOT / "frontend" / "public"
    tracked = _tracked()
    missing = []

    for page in sorted(public.glob("*.html")):
        for src in re.findall(r'<script[^>]+src="([^"]+)"', page.read_text()):
            if src.startswith(("http://", "https://", "//")):
                continue
            target = (public / src.lstrip("./").lstrip("/")).resolve()
            rel = target.relative_to(REPO_ROOT)
            if rel not in tracked:
                missing.append(f"{page.name} → {src}")

    assert not missing, (
        "화면이 부르는 스크립트가 저장소에 없습니다. clone 하면 빈 화면입니다:\n"
        + "\n".join(f"  {m}" for m in missing)
    )


def test_the_screens_have_a_korean_label_for_every_category_the_server_sends():
    """⭐ 기여도 화면의 카테고리 어휘가 서버 `Category` 와 같아야 한다.

    어긋나 있었다. 화면 표에는 서버가 만들지 않는 `review`·`design`·
    `planning` 이 있었고, 서버가 실제로 보내는 `schedule`·`peer` 가
    없었다. `describeCategory` 는 모르는 값을 **그대로 돌려주므로**
    예외도 콘솔 경고도 없이 한글 화면에 영어 식별자가 찍혔다:

        "schedule, peer 활동은 이번 계산에서 빠졌습니다."

    성적으로 이어질 수 있는 화면에서 학생이 자기 점수에서 무엇이
    빠졌는지 읽을 수 없는 상태였다. 프런트 테스트는 그 잘못된 어휘를
    그대로 고정하고 있어서 절대 잡지 못했다 — 두 언어에 걸친 규약은
    한쪽 테스트로 못 잡으므로 여기서 잡는다.
    """
    import re

    from teamflow.contribution.events import Category

    source = (
        REPO_ROOT / "frontend" / "src" / "lib" / "contribution" / "view.ts"
    ).read_text()

    block = re.search(
        r"export const CATEGORY_LABEL: Record<string, string> = \{(.*?)\};",
        source,
        re.DOTALL,
    )
    assert block is not None, "CATEGORY_LABEL 을 찾지 못했습니다"

    labelled = set(re.findall(r"^\s*(\w+):", block.group(1), re.MULTILINE))
    expected = {c.value for c in Category}

    assert labelled == expected, (
        "화면의 카테고리 라벨이 서버 Category 와 다릅니다.\n"
        f"  서버에만 있음(화면에 영어로 찍힙니다): {sorted(expected - labelled)}\n"
        f"  화면에만 있음(죽은 코드입니다):        {sorted(labelled - expected)}"
    )


def test_the_api_image_ships_the_screens():
    """⭐ 컨테이너로 띄웠을 때 화면이 나와야 한다.

    `Dockerfile.api` 가 `frontend/` 를 복사하지 않고 있었다. 그러면
    `_mount_frontend` 가 조용히 마운트를 건너뛰고 **모든 화면이 404**
    가 된다. API 는 멀쩡히 뜨고 `/health` 도 200 이라 컨테이너는
    정상으로 보인다 — 사람이 주소를 열었을 때만 아무것도 안 나온다.

    이 환경에는 Docker 데몬이 없어 이미지를 실제로 빌드해 볼 수 없다.
    그래서 파일에 그 COPY 가 있는지만 본다. 약한 검사지만, 없는 것보다
    낫다 — 없을 때는 아무도 몰랐다.
    """
    dockerfile = (REPO_ROOT / "docker" / "Dockerfile.api").read_text()

    from teamflow.api import main as api_main

    mounted = api_main.FRONTEND_EXPECTED_AT.relative_to(REPO_ROOT)
    # `frontend/public` → 이미지가 이 경로를 만들어야 한다.
    assert str(mounted) == "frontend/public"

    copies = [
        line
        for line in dockerfile.splitlines()
        if line.strip().upper().startswith("COPY") and "frontend" in line
    ]
    assert copies, (
        "Dockerfile.api 가 frontend/ 를 복사하지 않습니다. "
        "컨테이너에서 모든 화면이 404 가 되는데 API 는 정상으로 보입니다."
    )


# ══════════════════════════════════════════════════════════════
# 안드로이드 셸 — 웹과 코틀린이 어긋나면 조용히 아무 일도 안 일어난다
# ══════════════════════════════════════════════════════════════

ANDROID = REPO_ROOT / "android"


def _shell_kotlin(name: str) -> str:
    return (
        ANDROID / "app" / "src" / "main" / "java" / "com" / "teamflow" / "shell" / name
    ).read_text()


def test_the_shell_bridge_name_matches_on_both_sides():
    """⭐ 웹이 찾는 이름과 셸이 심는 이름이 같아야 한다.

    어긋나면 **조용히 "셸이 아니다"** 가 된다. 셸 안인데 설치 안내가
    뜨고, 서비스 워커가 셸 캐시와 겹치고, 무엇보다 녹음 시작을 셸에게
    알리지 못해 **포그라운드 서비스가 안 올라간다** — 화면이 꺼지면
    녹음이 끊긴다. 오류는 하나도 나지 않는다.

    실제로 한 번 어긋나 있었다: 웹은 `TeamFlowShell` 을 봤고 셸은
    `TeamFlowShellBridge` 를 심었다.
    """
    import re

    kotlin = _shell_kotlin("ShellBridge.kt")
    name = re.search(r'const val NAME = "([^"]+)"', kotlin)
    assert name is not None, "ShellBridge.NAME 을 찾지 못했습니다"

    web = (
        REPO_ROOT / "frontend" / "src" / "lib" / "shell" / "bridge.ts"
    ).read_text()
    assert f"win.{name.group(1)}" in web, (
        f"웹이 `{name.group(1)}` 를 찾지 않습니다. 셸이 심는 이름과 다릅니다."
    )


def test_every_bridge_method_the_web_calls_exists_in_the_shell():
    """⭐ 웹이 부르는 브리지 함수가 셸에 전부 있어야 한다.

    없는 함수를 부르면 그 자리에서 예외가 난다. 녹음 시작 직전이면
    **녹음이 아예 시작되지 않는다.**
    """
    import re

    kotlin = _shell_kotlin("ShellBridge.kt")
    exposed = set(re.findall(r"@JavascriptInterface\s+fun (\w+)\(", kotlin))
    assert exposed, "@JavascriptInterface 함수를 하나도 못 찾았습니다"

    web = (REPO_ROOT / "frontend" / "src" / "lib" / "shell" / "bridge.ts").read_text()
    declared = set(
        re.findall(
            r"^\s*(\w+): \(\) =>",
            web[web.index("export interface ShellBridge") : web.index("declare global")],
            re.MULTILINE,
        )
    )
    assert declared, "웹 쪽 ShellBridge 인터페이스를 못 읽었습니다"

    missing = sorted(declared - exposed)
    assert not missing, f"웹이 부르는데 셸에 없는 함수: {missing}"


def test_the_shell_declares_the_permissions_its_code_needs():
    """⭐ 코드가 쓰는 것을 매니페스트가 선언해야 한다.

    안드로이드는 선언되지 않은 권한을 **조용히 거절**한다. 포그라운드
    서비스가 안 올라가면 화면이 꺼졌을 때 녹음이 끊기는데, 그건
    녹음이 끝난 뒤 커버리지를 봐야 알 수 있다 — 그때는 이미 늦었다.
    """
    manifest = (ANDROID / "app" / "src" / "main" / "AndroidManifest.xml").read_text()

    for permission in [
        "android.permission.RECORD_AUDIO",
        "android.permission.INTERNET",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.FOREGROUND_SERVICE_MICROPHONE",
        "android.permission.POST_NOTIFICATIONS",
    ]:
        assert permission in manifest, f"선언되지 않은 권한: {permission}"

    # 서비스가 등록돼 있어야 `startForegroundService` 가 동작한다.
    assert 'android:name=".RecordingService"' in manifest
    assert 'android:foregroundServiceType="microphone"' in manifest


def test_the_shell_refuses_plaintext_http_to_the_outside():
    """⭐ 회의 음성과 세션 쿠키가 평문으로 나가면 안 된다.

    안드로이드는 API 28+ 부터 평문을 기본으로 막지만, 이 앱은 minSdk 24
    라 낮은 기기에서는 기본이 반대다. 명시적으로 막는다.
    """
    config = (
        ANDROID / "app" / "src" / "main" / "res" / "xml" / "network_security_config.xml"
    ).read_text()
    assert '<base-config cleartextTrafficPermitted="false" />' in config

    manifest = (ANDROID / "app" / "src" / "main" / "AndroidManifest.xml").read_text()
    assert "android:networkSecurityConfig=" in manifest, (
        "설정 파일만 있고 매니페스트가 가리키지 않으면 아무 효력이 없습니다"
    )


def test_the_recording_screen_actually_tells_the_shell():
    """⭐ 브리지를 만들어 놓고 부르지 않으면 아무 일도 안 일어난다.

    이 저장소에서 가장 자주 나온 결함이다. 여기서는 그 결과가
    **화면이 꺼지면 녹음이 끊기는 것**이고, 오류는 안 난다.
    """
    screen = (REPO_ROOT / "frontend" / "src" / "demo" / "main.ts").read_text()
    assert "tellShellRecordingStarted(window)" in screen
    assert "tellShellRecordingStopped(window)" in screen


def test_the_seed_writes_gaps_in_the_same_shape_production_does():
    """⭐ **시연 데이터가 운영과 다른 모양이면 시연에서만 안 나옵니다.**

    운영은 `recording_service._finalize` 에서 이렇게 씁니다.

        {"reason": ..., "startMs": ..., "endMs": ..., "durationMs": ...}

    시드는 `start_ms`(스네이크)였습니다. 화면이 `startMs` 를 읽으면
    `undefined` 가 나오고, 그 구멍은 **조용히 안 그려집니다.** 오류도
    안 납니다 — 시연에서 "왜 아무것도 안 보이지" 만 남습니다.

    이 저장소가 반복해서 당한 부류의 거울상입니다: 보통은 시연 데이터가
    손으로 채워져 결함을 가렸는데, 여기서는 시연 데이터가 운영과 달라
    **멀쩡한 코드가 안 도는 것처럼** 보였습니다.
    """
    import re

    seed = (REPO_ROOT / "scripts" / "seed_demo.py").read_text()
    service = (
        REPO_ROOT / "backend" / "teamflow" / "services" / "recording_service.py"
    ).read_text()

    # 운영이 쓰는 키를 코드에서 **읽어 옵니다** — 손으로 적으면 한쪽만 바뀝니다.
    written = re.search(
        r'server_gaps = \[\s*\{([^}]*)\}', service, re.S
    )
    assert written, "recording_service 에서 gap 을 쓰는 곳을 못 찾았습니다"
    keys = set(re.findall(r'"([a-zA-Z_]+)":', written.group(1)))
    assert keys, "gap 키를 못 읽었습니다"

    # 시드의 gaps= 블록만 본다.
    block = re.search(r"gaps=\[\]\s*if usable\s*else \[(.*?)\n                    \],", seed, re.S)
    assert block, "seed_demo 에서 gaps 블록을 못 찾았습니다"

    # ⚠️ **항목마다** 봅니다. 합집합으로 보면 둘 중 하나만 틀렸을 때
    # 통과합니다 — 실제로 그렇게 짰다가 되돌림 검증에서 안 잡혔습니다.
    entries = re.findall(r"\{([^}]*)\}", block.group(1), re.S)
    assert entries, "gap 항목을 못 찾았습니다"

    problems = []
    for i, entry in enumerate(entries):
        entry_keys = set(re.findall(r'"([a-zA-Z_]+)":', entry))
        missing = keys - entry_keys
        if missing:
            problems.append(f"{i}번째 항목에 {sorted(missing)} 없음 (쓴 것: {sorted(entry_keys)})")

    assert not problems, "시드가 운영과 다른 키를 씁니다:\n  " + "\n  ".join(problems)


# ══════════════════════════════════════════════════════════════
# 만들어 놓고 아무도 안 만드는 이벤트 종류
# ══════════════════════════════════════════════════════════════

# 생산자가 **없는 것이 맞는** 종류. 기능 자체가 아직 없습니다.
#
# ⚠️ 이 셋은 `DEADLINE_CHANGED` 와 다릅니다. `score_team` 은 **팀 전체가 0인
# 카테고리를 가중치 재정규화에서 빼므로**(scoring.py 의 `skipped`), 이벤트가
# 하나도 없는 카테고리는 조용한 0점이 되지 않습니다 — 기획자의 문서 30% 는
# 사라지는 게 아니라 남은 카테고리로 재분배됩니다. 반면 무결성 플래그에는
# 그런 안전장치가 없어서, 세는 이벤트가 안 만들어지면 **영원히 안 뜹니다.**
#
# 여기에 새 이름을 넣을 때는 그 종류가 없어도 조용히 틀린 값이 나오지
# 않는다는 근거를 함께 적을 것.
NO_PRODUCER_YET = {
    "BLOCKER_RESOLVED": (
        "블로커 표시 기능이 없다. TASK 는 task_completed 로 활성이라 카테고리가 죽지 않는다"
    ),
    "DOCUMENT_REVISED": "문서 연동이 없다. 팀 전체가 0이면 DOCUMENT 가 재정규화에서 빠진다",
    "PEER_RATING": "동료 평가 화면이 없다. 위와 같은 이유로 PEER 가 빠진다",
}

# 읽기만 하는 파일. 여기서 이름이 나온다고 생산자가 있는 게 아니다.
CONSUMERS_ONLY = (
    "backend/teamflow/contribution/scoring.py",
    "backend/teamflow/contribution/events.py",
)


def _event_type_names() -> list[str]:
    """`EventType` **클래스 몸통** 안의 멤버 이름만.

    ⚠️ 파일 전체를 훑으면 안 됩니다. 같은 파일의 `Category` 와 `SourceKind`
    가 생김새가 똑같아서 `CODE`·`GITHUB_EVENT` 까지 딸려 옵니다 — 처음에
    그렇게 짰다가 멀쩡한 이름 여덟 개를 고아로 신고했습니다.
    """
    import re

    src = (REPO_ROOT / "backend" / "teamflow" / "contribution" / "events.py").read_text()
    body = re.search(r"^class EventType\b.*?(?=^class |\Z)", src, re.M | re.S)
    assert body, "EventType 클래스를 못 찾았습니다"
    return re.findall(r"^    ([A-Z][A-Z_0-9]*) = \"", body.group(0), re.M)


def test_every_event_type_has_something_that_creates_it():
    """⭐ 세는 코드만 있고 만드는 코드가 없으면 그 기능은 **죽어 있다.**

    `DEADLINE_CHANGED` 가 그랬습니다. `scoring._detect_integrity_flags` 가
    이 이벤트를 세어 `frequent_deadline_change` 플래그를 띄우는데, 만드는
    곳이 **0곳**이라 `docs/09` 가 "구현된 무결성 플래그" 라고 적어 둔 그
    플래그가 한 번도 뜰 수 없었습니다. 마감일 변경은 `task_deadline_changes`
    표에 꼬박꼬박 남고 있었으니 더 안 보였습니다.

    같은 부류를 이 저장소는 반복해 겪었습니다 — `renderNav`(결함 47),
    `extract_task_refs`(결함 12), 진행률 읽기(감사 #8). 그래서 존재가 아니라
    **만드는 곳**을 셉니다.
    """
    names = _event_type_names()
    # 여덟 발언 + 나머지. 한 자릿수로 떨어지면 정규식이 끊긴 것이다.
    assert len(names) >= 15, f"EventType 을 못 읽었습니다: {names}"

    sources = [
        path
        for path in (REPO_ROOT / "backend" / "teamflow").rglob("*.py")
        if path.relative_to(REPO_ROOT).as_posix() not in CONSUMERS_ONLY
    ]
    blob = "\n".join(p.read_text() for p in sources)

    # 발언 여덟 종은 라벨에서 **만들어집니다** — `EventType.UTT_SOCIAL` 이라고
    # 적힌 곳이 없습니다. 그래서 글자가 아니라 **동작**을 봅니다.
    #
    # ⚠️ 처음에는 `'EventType(f"utt_{label}")' in blob` 으로 짰습니다.
    # `EventType("utt_" + label)` 로 바꾸기만 해도 실패하는, 형태에만
    # 민감한 가드였습니다. 그런 가드는 사람이 느슨하게 만들고, 느슨해진
    # 가드는 진짜를 놓칩니다.
    from teamflow.contribution.events import EventType
    from teamflow.services import meeting_contribution_service as mcs

    orphans = []
    for name in names:
        if name in NO_PRODUCER_YET:
            continue
        if name.startswith("UTT_"):
            label = name[len("UTT_") :].lower()
            try:
                made = mcs._event_type_for(label)
            # 무엇이 터지든 배선이 끊긴 것이다 — 종류를 좁히면 새 실패 방식을 놓친다.
            except Exception as exc:
                orphans.append(f"{name} (라벨 {label!r} → {exc!r})")
                continue
            if made is not EventType[name]:
                orphans.append(f"{name} (라벨 {label!r} 이 {made} 를 만듭니다)")
            continue
        if f"EventType.{name}" not in blob:
            orphans.append(name)

    assert not orphans, (
        "세기만 하고 만드는 곳이 없는 이벤트 종류입니다. 배선하거나, "
        "없어도 조용히 틀린 값이 안 나오는 근거를 적고 NO_PRODUCER_YET 에 "
        f"넣으세요:\n  {orphans}"
    )


def test_the_allowlist_does_not_name_types_that_are_gone():
    """면제 목록이 실제 이름을 가리키는지. 오타면 면제가 조용히 넓어진다."""
    unknown = sorted(set(NO_PRODUCER_YET) - set(_event_type_names()))
    assert not unknown, f"EventType 에 없는 이름이 면제돼 있습니다: {unknown}"


def test_the_readme_table_count_is_not_stale():
    """⭐ README 가 "26개 테이블" 이라고 적어 둔 동안 실제로는 28개였다.

    숫자는 조용히 낡습니다. 테이블을 하나 더하면서 README 를 같이 고칠
    사람은 없습니다 — 아무 데서도 오류가 안 나니까요. 그래서 셉니다.

    ⚠️ 테스트 통과 개수는 **일부러 안 셉니다.** 커밋마다 바뀌는 값이라
    가드를 달면 관계없는 작업이 계속 빨개지고, 그러면 사람이 가드를
    느슨하게 만듭니다. 대신 README 에 `(2026-08)` 을 붙여 **스냅샷임을
    드러냈습니다** — 낡은 스냅샷은 거짓말이 아닙니다.
    """
    import re

    from teamflow.db.models import Base

    actual = len(Base.metadata.tables)
    readme = (REPO_ROOT / "README.md").read_text()

    claims = {int(n) for n in re.findall(r"(\d+)개 테이블", readme)}
    assert claims, "README 에서 테이블 수 주장을 못 찾았습니다"

    wrong = sorted(n for n in claims if n != actual)
    assert not wrong, (
        f"README 가 테이블을 {wrong} 개라고 적었는데 실제는 {actual} 개입니다. "
        "models.py 를 고쳤으면 README 도 같이 고치세요."
    )
