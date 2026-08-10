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


# ══════════════════════════════════════════════════════════════
# 두 언어에 걸친 어휘 — 서버가 만드는 값마다 화면에 사람 말이 있는가
# ══════════════════════════════════════════════════════════════
#
# ⭐ **이 저장소가 반복해 당한 부류입니다.**
#
#   · 기여도 화면 표에는 서버가 만들지 않는 `review`·`design`·`planning`
#     이 있었고, 서버가 실제로 보내는 `schedule`·`peer` 가 없었습니다.
#     `describeCategory` 는 모르는 값을 **그대로 돌려주므로** 예외도 콘솔
#     경고도 없이 한글 화면에 영어 식별자가 찍혔습니다 —
#     "schedule, peer 활동은 이번 계산에서 빠졌습니다."
#   · 회의 상태 `confirmed` 는 화면에 라벨도 가지도 있었는데 **서버가 그
#     값을 한 번도 안 넣었습니다** (결함 84). 사람이 후보를 전부 검토해도
#     홈 화면은 "회의에서 업무가 나오지 않았습니다" 라고 말했습니다.
#
# 두 번 당하고 두 번 손으로 테스트를 썼습니다. 세 번째부터는 표로 둡니다 —
# 나머지 어휘 넷(업무 상태·역할·공백 이유)은 지금 맞지만, **맞게 유지해
# 주는 것이 아무것도 없었습니다.**
#
# ⚠️ 두 방향을 다 봅니다. 서버에만 있으면 화면에 **영어 식별자**가 찍히고,
# 화면에만 있으면 **아무도 못 타는 죽은 가지**입니다.


def _screen_vocabularies():
    """(이름, 서버 값들, 화면 파일, 화면 표 이름)."""
    from teamflow.audio.assembly import GapReason
    from teamflow.contribution.events import Category
    from teamflow.contribution.profiles import Role
    from teamflow.db.models import MeetingStatus
    from teamflow.meeting.approval import ApprovalError
    from teamflow.services import task_service

    return [
        (
            "기여 카테고리",
            {c.value for c in Category},
            "frontend/src/lib/contribution/view.ts",
            "CATEGORY_LABEL",
        ),
        (
            "회의 상태",
            {s.value for s in MeetingStatus},
            "frontend/src/lib/home/next.ts",
            "MEETING_STATUS_LABEL",
        ),
        (
            "업무 상태",
            set(task_service.STATUSES),
            "frontend/src/lib/kanban/board.ts",
            "STATUS_LABEL",
        ),
        (
            "역할",
            {r.value for r in Role},
            "frontend/src/lib/contribution/view.ts",
            "ROLE_NAMES",
        ),
        (
            "공백 이유",
            {r.value for r in GapReason},
            "frontend/src/lib/track/diagram.ts",
            "REASON_TEXT",
        ),
        # 승인이 막힌 이유. 서버가 `failures` 로 코드만 내보내고 화면이
        # 옮긴다. 화면이 스스로도 판정하는 코드가 일곱이라 **다 있는 줄
        # 알기 쉬운데**, 서버만 내는 둘(`unknown_candidate`·`no_reviewer`)
        # 이 빠져 있었다 — 목록이 낡은 채로 승인을 누르면 사람이
        # `#999 unknown_candidate` 를 읽었다.
        (
            "승인이 막힌 이유",
            {e.value for e in ApprovalError},
            "frontend/src/lib/review/candidates.ts",
            "BLOCKER_TEXT",
        ),
    ]


def test_every_value_the_server_sends_has_a_korean_word_on_the_screen():
    """⭐ 서버 어휘와 화면 어휘가 **양쪽 다** 맞아야 한다."""
    import re

    problems: list[str] = []
    for name, expected, rel, table in _screen_vocabularies():
        source = (REPO_ROOT / rel).read_text()
        # 키 타입이 `string` 이 아니라 좁은 유니온(`Record<BlockerCode, …>`)
        # 인 표도 있다. 이름만 보고 찾으면 표가 바뀔 때 조용히 못 찾는다.
        block = re.search(
            rf"{table}: Record<[^,>]+, string> = \{{(.*?)\}};", source, re.DOTALL
        )
        if block is None:
            problems.append(f"{name}: {rel} 에서 {table} 을 못 찾았습니다")
            continue
        labelled = set(re.findall(r"^\s*(\w+):", block.group(1), re.MULTILINE))
        missing = sorted(expected - labelled)
        dead = sorted(labelled - expected)
        if missing:
            problems.append(f"{name}: 서버에만 있음(화면에 영어로 찍힙니다) {missing}")
        if dead:
            problems.append(f"{name}: 화면에만 있음(죽은 라벨입니다) {dead}")

    assert problems == [], "두 언어에 걸친 어휘가 어긋났습니다:\n" + "\n".join(
        f"  {p}" for p in problems
    )


def test_the_vocabulary_table_itself_is_not_stale():
    """표가 낡으면 **아무것도 안 보면서 통과**한다.

    파일이 사라지거나 이름이 바뀌면 위 테스트가 &#34;못 찾았습니다&#34; 로
    실패하지만, 값 집합이 비어 버리는 경우는 조용히 지나갑니다.
    """
    for name, expected, rel, _table in _screen_vocabularies():
        assert expected, f"{name}: 서버 값이 하나도 없습니다 — 표가 낡았습니다"
        assert (REPO_ROOT / rel).exists(), f"{name}: {rel} 이 없습니다"


def test_the_screens_have_a_next_step_for_every_meeting_status():
    """회의 상태는 라벨만으로 부족하다 — **다음에 할 일**도 있어야 한다.

    라벨만 있고 가지가 없으면 `nextStepFor` 가 `default` 로 떨어져
    "알 수 없는 상태입니다" 가 뜹니다.
    """
    import re

    from teamflow.db.models import MeetingStatus

    source = (REPO_ROOT / "frontend" / "src" / "lib" / "home" / "next.ts").read_text()
    cases = set(re.findall(r"case '([a-z_]+)':", source))
    missing = sorted({s.value for s in MeetingStatus} - cases)
    assert missing == [], f"`nextStepFor` 에 가지가 없는 상태입니다: {missing}"


def test_every_meeting_status_has_someone_who_writes_it():
    """⭐ **아무도 안 쓰는 상태를 두지 않는다** (결함 84 의 뿌리).

    `confirmed` 는 모델 주석에도, 화면 라벨에도, 승인 화면의 빈 상태
    문구에도 있었는데 **넣는 코드가 0곳**이었습니다. 이 저장소의 대표
    실패 방식(`EventType` 생산자 가드·결함 63·75·83)이 회의 상태에서
    반복된 것입니다.

    `ast` 로 **`… .status = 값`** 대입과 컬럼 기본값을 모읍니다.
    글자를 찾는 대신 코드 모양을 보므로, 상수로 빼도 안 깨집니다.
    """
    import ast

    from teamflow.db.models import MeetingStatus

    written: set[str] = {MeetingStatus.PENDING.value}  # 컬럼 기본값
    for path in (REPO_ROOT / "backend" / "teamflow").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign):
                continue
            for target in node.targets:
                if not (isinstance(target, ast.Attribute) and target.attr == "status"):
                    continue
                value = node.value
                # `meeting.status = "confirmed"`
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    written.add(value.value)
                # `meeting.status = MeetingStatus.CONFIRMED.value`
                elif isinstance(value, ast.Attribute) and value.attr == "value":
                    inner = value.value
                    if isinstance(inner, ast.Attribute):
                        member = getattr(MeetingStatus, inner.attr, None)
                        if member is not None:
                            written.add(member.value)

    orphans = sorted({s.value for s in MeetingStatus} - written)
    assert orphans == [], (
        "넣는 코드가 없는 회의 상태입니다 — 화면이 그 상태를 설명하고 있어도 "
        f"영원히 안 뜹니다: {orphans}"
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


def test_the_seed_makes_a_project_the_api_could_have_made():
    """⭐ **시드가 제품이 만들 수 없는 상태를 만들지 않는다** (결함 91).

    시연 프로젝트만 `invite_code` 가 NULL 이었습니다. 화면은 정직하게
    `(없음)` 을 띄우고 복사 버튼을 잠갔지만(결함 71), 그 결과 **시연에서
    팀원을 초대할 방법이 없었습니다** — 첫 화면이 &#34;시작하는 두 가지
    방법&#34; 인데 그중 하나가 막힌 채였고, 그 상태로 화면을 재고
    캡처해 왔습니다.

    칸 이름을 손으로 적지 않고 **두 파일에서 읽어 비교합니다.** 나중에
    프로젝트에 칸이 하나 늘면 시드도 같이 걸립니다.
    """
    import ast

    def project_kwargs(path: Path) -> set[str]:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", "")
            if name != "Project":
                continue
            return {kw.arg for kw in node.keywords if kw.arg}
        return set()

    api = project_kwargs(REPO_ROOT / "backend" / "teamflow" / "api" / "main.py")
    seed = project_kwargs(REPO_ROOT / "scripts" / "seed_demo.py")
    assert api, "api/main.py 에서 Project(...) 를 못 찾았습니다"
    assert seed, "seed_demo.py 에서 Project(...) 를 못 찾았습니다"

    missing = sorted(api - seed)
    assert missing == [], (
        "시드가 API 와 다른 모양의 프로젝트를 만듭니다 — 시연에서만 비는 칸입니다: "
        f"{missing}"
    )


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

    # 시드의 구멍 표만 본다.
    block = re.search(r"track_gaps: [^=]*= \[(.*?)\n        \]", seed, re.S)
    assert block, "seed_demo 에서 track_gaps 표를 못 찾았습니다"

    # ⚠️ **항목마다** 봅니다. 합집합으로 보면 둘 중 하나만 틀렸을 때
    # 통과합니다 — 실제로 그렇게 짰다가 되돌림 검증에서 안 잡혔습니다.
    entries = re.findall(r"\{([^}]*)\}", block.group(1), re.S)
    assert entries, "gap 항목을 못 찾았습니다"

    # `durationMs` 는 시드가 **계산해서** 채웁니다 (결함 99). 계산하는 줄이
    # 있는지 따로 보고, 리터럴에서는 빼고 봅니다 — 손으로 적으면 다시
    # 커버리지와 갈라집니다.
    assert 'gap["durationMs"] = int(gap["endMs"]) - int(gap["startMs"])' in seed, (
        "시드가 `durationMs` 를 계산하지 않습니다 — 손으로 적으면 갈라집니다"
    )
    literal_keys = keys - {"durationMs"}

    problems = []
    for i, entry in enumerate(entries):
        entry_keys = set(re.findall(r'"([a-zA-Z_]+)":', entry))
        missing = literal_keys - entry_keys
        if missing:
            problems.append(f"{i}번째 항목에 {sorted(missing)} 없음 (쓴 것: {sorted(entry_keys)})")

    assert not problems, "시드가 운영과 다른 키를 씁니다:\n  " + "\n  ".join(problems)


# ══════════════════════════════════════════════════════════════
# 서버와 화면에 **같은 숫자가 두 벌** 있는 것
# ══════════════════════════════════════════════════════════════

#: 두 쪽이 반드시 같아야 하는 상수. `(뜻, 백엔드 파일, 백엔드 이름, 프런트 이름)`.
#:
#: 프런트 파일은 전부 `frontend/src/lib/recording/timeline.ts` 입니다 —
#: 늘면 튜플에 파일을 더하세요.
PAIRED_CONSTANTS = [
    (
        "이보다 짧은 공백은 보고하지 않는다",
        "backend/teamflow/audio/assembly.py",
        "MIN_REPORTED_GAP_MS",
        "MIN_REPORTED_GAP_MS",
    ),
    (
        "이만큼까지의 지연은 정상 지터로 본다",
        "backend/teamflow/audio/assembly.py",
        "STALL_TOLERANCE_MS",
        "DEFAULT_STALL_TOLERANCE_MS",
    ),
    (
        "이 아래면 트랙을 쓰지 않는다",
        "backend/teamflow/services/recording_service.py",
        "MIN_USABLE_COVERAGE",
        "MIN_USABLE_COVERAGE",
    ),
]

FRONT_CONSTANTS = "frontend/src/lib/recording/timeline.ts"


def _number_after(source: str, name: str) -> str | None:
    """`NAME = 123` 또는 `const NAME = 123;` 에서 숫자만."""
    import re

    hit = re.search(rf"\b{name}\s*(?::\s*[\w<>\[\]]+)?\s*=\s*([0-9][0-9_.]*)", source)
    return hit.group(1).replace("_", "") if hit else None


def test_the_same_number_on_both_sides_really_is_the_same():
    """⭐ 서버와 화면에 두 벌로 있는 숫자가 **정말 같은가** (결함 100).

    세 상수가 양쪽에 각각 적혀 있고, 주석이 스스로 그렇다고 말합니다.

        # (프런트 timeline.ts 의 stallToleranceMs 와 같은 값)
        STALL_TOLERANCE_MS = 300

    **그런데 아무것도 그것을 지키지 않았습니다.** 주석은 아무도 안 읽고
    아무것도 못 막습니다 — 이 저장소가 `GapReason` 에서 이미 배운 것입니다.

    갈라지면 조용히 어긋납니다.

    · `STALL_TOLERANCE_MS` — 화면은 공백으로 세고 서버는 안 셉니다.
      그러면 커버리지는 낮은데 **구멍은 하나도 안 그려집니다.**
      결함 99 에서 본 바로 그 그림이 이번엔 운영에서 납니다
    · `MIN_USABLE_COVERAGE` — 녹음 화면은 &#34;쓸 만합니다&#34; 라고 하고 서버는
      `unusable` 로 저장합니다. 사람은 어느 쪽을 믿을지 모릅니다
    · `MIN_REPORTED_GAP_MS` — 짧은 공백을 한쪽만 세어 총합과 목록이
      갈라집니다

    셋 다 **오류 없이** 숫자만 어긋납니다. 이 저장소의 대표 실패 방식입니다.
    """
    front = (REPO_ROOT / FRONT_CONSTANTS).read_text()

    problems = []
    for meaning, rel, back_name, front_name in PAIRED_CONSTANTS:
        back = (REPO_ROOT / rel).read_text()
        back_value = _number_after(back, back_name)
        front_value = _number_after(front, front_name)
        if back_value is None:
            problems.append(f"{rel} 에서 {back_name} 을 못 찾았습니다")
            continue
        if front_value is None:
            problems.append(f"{FRONT_CONSTANTS} 에서 {front_name} 을 못 찾았습니다")
            continue
        if float(back_value) != float(front_value):
            problems.append(
                f"{meaning}: {back_name}={back_value} 인데 {front_name}={front_value} 입니다"
            )

    assert not problems, "서버와 화면의 숫자가 갈라졌습니다:\n  " + "\n  ".join(problems)


def test_the_paired_constant_table_is_not_stale():
    """표가 낡지 않았는가 — 주석이 &#34;같은 값&#34; 이라고 말하면 표에 있어야 한다.

    ⚠️ 이 검사가 없으면 다음 사람이 상수를 하나 더 만들면서 같은 주석을
    달고, 그건 아무도 안 지킵니다. 표를 늘리는 것이 규칙이 되게 합니다.
    """
    import re

    declared = []
    for rel in {rel for _, rel, _, _ in PAIRED_CONSTANTS} | {
        "backend/teamflow/audio/assembly.py",
        "backend/teamflow/services/recording_service.py",
    }:
        source = (REPO_ROOT / rel).read_text()
        # `… 와 같은 값…` 주석 **바로 뒤**에 오는 상수 이름
        for hit in re.finditer(
            r"#[^\n]*(?:와|과) 같은 값[^\n]*\n([A-Z_][A-Z0-9_]*)\s*=", source
        ):
            declared.append((rel, hit.group(1)))

    known = {(rel, name) for _, rel, name, _ in PAIRED_CONSTANTS}
    missing = [f"{rel} 의 {name}" for rel, name in declared if (rel, name) not in known]
    assert not missing, (
        "주석이 '같은 값' 이라고 말하는데 표에 없습니다 — "
        "`PAIRED_CONSTANTS` 에 넣으세요:\n  " + "\n  ".join(missing)
    )
    assert declared, "'같은 값' 주석을 하나도 못 찾았습니다 — 이 검사가 헛돌고 있습니다"


def test_every_pipeline_stage_has_words_a_person_can_read():
    """⭐ 파이프라인 단계마다 **사람의 말**이 있는가 (결함 106).

    어휘 표 여섯 개는 &#34;서버 값 → 화면 파일의 표&#34; 모양이라 이 짝을 못
    담았습니다. `STAGE_TEXT` 는 **서버 안에서** 옮기기 때문입니다. 그래서
    아무도 안 봤고, 양방향으로 어긋나 있었습니다.

        옮길 말이 없는 단계   done · failed · validate  → 전부 "처리 중"
        죽은 라벨            diarize · persist         → 파이프라인에 없음

    실패한 회의가 이렇게 보였습니다.

        처리 중 · 0% — KeyError: 'samples'

    **"처리 중"** 이라고 하니 팀은 기다리기만 하고 다시 녹음하지 않습니다.
    그 회의의 기여는 전원에게 영영 빕니다. 게다가 한글 화면에 파이썬 예외
    원문이 붙습니다 — 결함 78·86 이 고친 바로 그 부류입니다.

    ⚠️ `failed` 만 일부러 뺍니다. 실패는 진행 **단계**가 아니라 **결과**라,
    `describe` 가 회의 상태를 먼저 보고 답합니다.
    """
    from teamflow.pipeline.meeting_pipeline import Stage
    from teamflow.services.progress_service import STAGE_TEXT

    stages = {v for k, v in vars(Stage).items() if not k.startswith("_")}
    assert stages, "Stage 값을 못 읽었습니다"

    #: 진행 단계가 아니라 결과라 화면 표에 없는 것. 근거 없이 늘리지 마세요.
    NOT_A_STAGE = {
        "failed": "실패는 결과다 — `describe` 가 회의 상태를 먼저 보고 답한다",
    }

    missing = sorted(stages - set(STAGE_TEXT) - set(NOT_A_STAGE))
    assert not missing, (
        f"이 단계들에 사람의 말이 없습니다: {missing} — "
        '`STAGE_TEXT.get(stage, "처리 중")` 이 우리 용어를 "처리 중" 으로 뭉갭니다'
    )

    dead = sorted(set(STAGE_TEXT) - stages)
    assert not dead, f"파이프라인에 없는 단계가 표에 있습니다: {dead} — 지우세요"

    stale = sorted(set(NOT_A_STAGE) - stages)
    assert not stale, f"이제 없는 단계입니다: {stale} — 면제 목록에서 빼세요"


def test_the_pipeline_does_not_put_a_python_exception_on_the_screen():
    """⭐ 실패 진행률에 **예외 원문을 싣지 않는다** (결함 106).

    `reporter.report(...)` 가 남기는 값은 로비 화면으로 **그대로 나갑니다.**
    한글 화면에 `KeyError: 'samples'` 가 뜨면 사람은 아무것도 못 얻고,
    우리도 못 얻습니다(스택이 없으니). 원문은 `logger.exception` 이
    스택까지 남깁니다.
    """
    import re

    source = (
        REPO_ROOT / "backend" / "teamflow" / "pipeline" / "meeting_pipeline.py"
    ).read_text()

    offenders = [
        line.strip()
        for line in source.splitlines()
        if re.search(r"reporter\.report\([^)]*\bstr\(\s*exc\b", line)
        or re.search(r"reporter\.report\([^)]*\bexc\b[^)]*\)", line)
    ]
    assert not offenders, (
        "진행률에 예외 원문을 실었습니다 — 화면으로 그대로 나갑니다:\n  "
        + "\n  ".join(offenders)
    )


def test_the_reprocessing_cleanup_names_every_table_it_rewrites():
    """⭐ 재처리 정리 목록에 **빠진 표가 없는가** (결함 113).

    `persist_results_task` 는 회의를 다시 처리할 때 앞판의 결과를 지우고
    새로 씁니다. 그 정리 목록에 셋만 있었습니다 —
    `Utterance`·`MeetingTaskCandidate`·`Decision`. **미해결 사안이
    들어가는 `MeetingEvent` 는 없었습니다.** 그래서 재처리할 때마다 같은
    사안이 한 벌씩 더 쌓였습니다.

    ⚠️ **결함 111 전에는 아무도 못 봤습니다** — 그 표를 읽는 화면이
    0곳이었기 때문입니다. 화면에 올리자 중복이 그대로 보이게 됐습니다.
    **안 보이던 것이 안 틀렸던 것은 아닙니다.**

    이 검사는 &#34;그 태스크가 만드는 표&#34; 와 &#34;지우는 표&#34; 를 맞춰 봅니다.
    새 표에 회의 결과를 쓰기 시작하면서 정리를 안 하면 여기서 걸립니다.
    """
    import ast

    source = (
        REPO_ROOT / "backend" / "teamflow" / "tasks" / "meeting_tasks.py"
    ).read_text()
    tree = ast.parse(source)

    # `m.Xxx(...)` 로 **만드는** 표
    created = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "m"
        and node.func.attr[:1].isupper()
    }

    # `for model in (m.A, m.B, …)` 로 **지우는** 표
    cleaned: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.For) or not isinstance(node.iter, ast.Tuple):
            continue
        for element in node.iter.elts:
            if (
                isinstance(element, ast.Attribute)
                and isinstance(element.value, ast.Name)
                and element.value.id == "m"
            ):
                cleaned.add(element.attr)

    assert cleaned, "정리 목록을 못 찾았습니다 — 이 검사가 헛돌고 있습니다"

    # 회의마다 새로 만드는 것이 아닌 표. 근거를 적는다.
    exempt = {
        "MeetingTrack": "녹음이 만든다. 재처리는 트랙을 다시 만들지 않는다",
        "ContributionEventRow": (
            "`forget_meeting_events` 가 **발화를 지우기 전에** 따로 지운다 — "
            "발화가 사라진 뒤에는 어느 이벤트가 이 회의 것이었는지 알 방법이 없다"
        ),
        "AuditLog": "무슨 일이 있었는가의 기록이다. 재처리로 지우면 안 된다",
    }

    missing = sorted(created - cleaned - set(exempt))
    assert not missing, (
        "재처리가 만드는데 정리 목록에 없습니다 — 다시 돌 때마다 쌓입니다:\n  "
        + "\n  ".join(missing)
    )


def test_every_column_a_person_must_fill_has_a_route_that_fills_it():
    """⭐ 사람이 채워야 하는 칸에 **채울 길이 있는가** (결함 112).

    `Member.github_login` 은 기여도의 GitHub 다리 전체가 서 있는 칸입니다.

        웹훅 actor_login  ──(이 칸)──▶  user_id  ──▶  기여 이벤트

    읽는 곳은 넷이었습니다 — 이벤트 배분·백필·업무↔PR·연결 진단.
    **쓰는 곳은 시드와 테스트뿐이었습니다.** 실제로 배포하면 이 칸은
    영원히 NULL 이고, 그러면 아무의 PR 도 주인을 못 찾습니다.

    ⚠️ 연결 진단은 이미 &#34;GitHub 계정을 연결하지 않은 팀원이 있습니다&#34;
    라고 **경고하고 있었습니다.** 할 일을 알려 주면서 그 일을 할 자리를
    안 주는 것은, 결함 105 에서 고친 것(할 수 없는 일을 안 했다고 깎기)의
    거울입니다.

    ⚠️ **시드는 쓰는 곳으로 세지 않습니다.** 시드가 채우면 시연은 돌고
    운영은 안 돕니다 — 결함 91 에서 겪은 그대로입니다.
    """
    import ast

    # (모델 속성, 왜 사람이 채워야 하는가)
    needs_a_person = {
        "github_login": "이게 없으면 그 사람의 PR 이 주인을 못 찾는다",
    }

    api = REPO_ROOT / "backend" / "teamflow" / "api"
    services = REPO_ROOT / "backend" / "teamflow" / "services"

    writers: dict[str, list[str]] = {name: [] for name in needs_a_person}
    for root in (api, services):
        for path in sorted(root.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                # `x.github_login = ...` 만 쓰기로 센다. 비교(`==`)는 읽기다.
                if not isinstance(node, ast.Assign):
                    continue
                for target in node.targets:
                    if isinstance(target, ast.Attribute) and target.attr in needs_a_person:
                        writers[target.attr].append(
                            f"{path.relative_to(REPO_ROOT)}:{node.lineno}"
                        )

    orphans = [
        f"{name} — {why} (쓰는 라우트가 0곳)"
        for name, why in needs_a_person.items()
        if not writers[name]
    ]
    assert not orphans, (
        "사람이 채워야 하는 칸인데 제품에 채울 자리가 없습니다:\n  " + "\n  ".join(orphans)
    )


def test_every_table_the_pipeline_writes_has_something_that_reads_it():
    """⭐ 파이프라인이 채우는 표마다 **읽는 코드가 있는가** (결함 110·111).

    이 저장소의 대표 실패 방식입니다 — 맞는 값을 만들어 저장까지 해
    놓고 아무도 안 읽는 것. 오류도 안 나고 테스트도 통과합니다.

    `meeting_events` 가 그랬습니다. 파이프라인이 미해결 사안을
    `unanswered_question` 행으로 넣는데, **저장소 전체에서 그 표를 읽는
    코드가 하나도 없었습니다.** 회의에서 답이 안 난 것이 DB 에만 쌓이고
    사람은 영영 못 봤습니다.

    ⚠️ **&#34;쓰는 곳&#34; 과 &#34;읽는 곳&#34; 을 구분해 셉니다.** `m.MeetingEvent(...)`
    처럼 **생성자로 부르는 것은 쓰기**입니다. 그것까지 세면 쓰기만 있는
    표가 &#34;쓰이고 있다&#34; 로 보입니다 — 결함 97 에서 겪은 것과 같은
    함정입니다(죽은 것이 죽은 것을 부르면 둘 다 살아 보인다).
    """
    import ast

    # 파이프라인이 채우고 사람이 봐야 하는 표. 내부 살림용 표(감사 로그·
    # 잠금 등)는 화면이 없어도 되므로 대상이 아니다.
    watched = {
        "MeetingEvent": "회의에서 답이 안 난 것 · 비효율 구간",
        "Decision": "회의 결정",
        "MeetingTaskCandidate": "업무 후보",
    }

    reads: dict[str, list[str]] = {name: [] for name in watched}
    root = REPO_ROOT / "backend" / "teamflow"

    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        # 생성자 호출(`m.MeetingEvent(...)`)의 위치를 먼저 모아 둔다 —
        # 그 자리는 쓰기지 읽기가 아니다.
        writes = {
            (node.lineno, node.col_offset)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in watched
        }
        for node in ast.walk(tree):
            if not isinstance(node, ast.Attribute) or node.attr not in watched:
                continue
            if (node.lineno, node.col_offset) in writes:
                continue
            reads[node.attr].append(f"{path.relative_to(REPO_ROOT)}:{node.lineno}")

    orphans = [
        f"{name}({why}) — 쓰기만 있고 읽는 곳이 0곳"
        for name, why in watched.items()
        if not reads[name]
    ]
    assert not orphans, (
        "파이프라인이 채우는데 아무도 안 읽는 표가 있습니다 — 사람이 영영 못 봅니다:\n  "
        + "\n  ".join(orphans)
    )


def test_the_defect_log_does_not_claim_a_stale_count():
    """⭐ 결함 기록이 스스로 말하는 건수가 **실제와 맞는가**.

    `docs/17` 첫 줄은 &#34;결함 일흔다섯&#34; 처럼 건수를 말합니다. 그 숫자는
    결함이 하나 늘 때마다 낡습니다 — 실제로 **결함 92번에서 멈춰
    있었습니다.** 그동안 열세 개가 더 늘었는데 문서는 계속 &#34;쉰아홉&#34;
    이라고 말했습니다.

    README 표 건수(`test_the_readme_table_count_is_not_stale`)와 같은
    부류입니다. 사람이 세어서 적는 숫자는 반드시 낡습니다.

    ⚠️ 한글 수사(&#34;일흔다섯&#34;)는 기계가 세기 어려우므로 **숫자도 같이**
    적게 했습니다. 이 검사는 그 숫자를 봅니다.
    """
    import re

    doc = (REPO_ROOT / "docs" / "17-결함-기록.md").read_text()

    header = re.search(
        r"\*\*(\d+)건\*\*\s*·\s*(\d+)~(\d+)번\s*·\s*(\d+)번은 비어 있습니다", doc
    )
    assert header, (
        "docs/17 첫 줄에서 '**N건** · A~B번 · C번은 비어 있습니다' 를 못 찾았습니다"
    )
    claimed, low, high, gap = (int(g) for g in header.groups())

    found: set[int] = set()
    for run in re.finditer(r"결함\s+([\d~·,\s]+)", doc):
        for part in re.split(r"[·,\s]+", run.group(1).strip()):
            if "~" in part:
                a, _, b = part.partition("~")
                if a.isdigit() and b.isdigit():
                    found.update(range(int(a), int(b) + 1))
            elif part.isdigit():
                found.add(int(part))

    ours = {n for n in found if low <= n <= high}
    holes = sorted(set(range(low, high + 1)) - ours)

    assert holes == [gap], (
        f"문서가 {gap}번만 비었다고 하는데 실제로 빈 번호는 {holes} 입니다"
    )
    assert len(ours) == claimed, (
        f"문서는 {claimed}건이라고 하는데 실제로 적힌 결함은 {len(ours)}건입니다 "
        f"({low}~{high})"
    )
    assert max(ours) == high, f"가장 큰 결함 번호는 {max(ours)} 인데 머리말은 {high} 입니다"


def test_the_team_calendar_is_the_same_on_both_sides():
    """⭐ 서버와 화면이 **같은 달력**을 쓰는가 (결함 109).

    서버는 결함 107 을 고치면서 `settings.project_timezone` 이라는 하나의
    달력을 정했습니다. 그런데 칸반 화면은 `Date#getFullYear()` — 즉
    **보는 사람의 시간대**로 마감 준수를 그리고 있었습니다.

        완료 2026-09-04T16:00:00Z, 마감 2026-09-04
        서울에서 보면  09-05 → 지연
        뉴욕에서 보면  09-04 → 제때
        서버는        09-05 → 지연

    같은 업무가 **누가 보느냐에 따라** 달라졌습니다. 시연을 어느
    노트북에서 하든 같은 답이 나와야 합니다.

    시간대는 숫자가 아니라 문자열이라 `PAIRED_CONSTANTS` 표에 담기지
    않습니다. 그래서 짝을 여기서 따로 봅니다.
    """
    import re

    back = (REPO_ROOT / "backend" / "teamflow" / "config.py").read_text()
    front = (REPO_ROOT / "frontend" / "src" / "lib" / "time" / "calendar.ts").read_text()

    back_hit = re.search(r"project_timezone:\s*str\s*=\s*['\"]([^'\"]+)['\"]", back)
    front_hit = re.search(r"TEAM_TIMEZONE\s*=\s*['\"]([^'\"]+)['\"]", front)

    assert back_hit, "config.py 에서 project_timezone 기본값을 못 찾았습니다"
    assert front_hit, "calendar.ts 에서 TEAM_TIMEZONE 을 못 찾았습니다"
    assert back_hit.group(1) == front_hit.group(1), (
        f"팀 달력이 갈라졌습니다: 서버 {back_hit.group(1)!r} vs "
        f"화면 {front_hit.group(1)!r}"
    )


def test_the_screens_read_the_calendar_from_one_place():
    """⭐ 화면이 날짜를 **손으로 짜 맞추지** 않는가 (결함 109).

    되돌리기 쉬운 결함입니다. `getFullYear()/getMonth()/getDate()` 를
    이어 붙이면 그 자리에서는 잘 돌아가 보이고, 시간대가 다른 사람이
    볼 때만 틀립니다. 이 저장소에는 그 조각이 **세 벌** 있었습니다 —
    `board.ts` 의 `localDateOf`, `demo/kanban.ts` 와 `demo/review.ts` 의
    `todayIso`. 셋 다 같은 실수를 따로 하고 있었습니다.

    이제 `lib/time/calendar.ts` 한 곳만 달력을 압니다.
    """
    import re

    allowed = {"src/lib/time/calendar.ts"}
    root = REPO_ROOT / "frontend" / "src"

    offenders = []
    for path in sorted(root.rglob("*.ts")):
        rel = path.relative_to(REPO_ROOT / "frontend").as_posix()
        if rel in allowed or rel.endswith(".test.ts"):
            continue
        source = path.read_text()
        for number, line in enumerate(source.splitlines(), 1):
            if re.search(r"\.getMonth\(\)|\.getDate\(\)|\.getFullYear\(\)", line):
                offenders.append(f"{rel}:{number}  {line.strip()}")

    assert not offenders, (
        "화면이 날짜를 손으로 짜 맞추고 있습니다 — 보는 사람의 달력이 됩니다.\n"
        "`lib/time/calendar.ts` 의 `teamDateOf`/`todayInTeamCalendar` 를 쓰세요:\n  "
        + "\n  ".join(offenders)
    )


def test_no_instant_is_turned_into_a_calendar_day_by_hand():
    """⭐ 순간을 날짜로 바꿀 때는 **팀 달력**을 거친다 (결함 107·108).

    이 저장소는 시각을 전부 UTC 로 저장합니다. 그래서 `.date()` 는
    **UTC 달력일**입니다. 한국(UTC+9)에서는 밤 9시 이후가 통째로 하루
    앞으로 밀립니다 — 그리고 UTC 는 KST 보다 항상 뒤이므로 이 오차는
    무작위가 아니라 **한쪽으로만** 기웁니다.

    같은 결함을 두 곳에서 따로 찾았습니다.

    * 107 — `completed_at.date()` 로 마감 준수를 판정. 마감 당일 밤에
      끝낸 업무가 하루 늦어도 "제때" 였습니다.
    * 108 — `started_at.date()` 를 마감 표현의 기준일로 사용. 새벽에
      시작한 회의에서 **"다음 주 월요일" 이 회의 당일**이 됐습니다.

    두 번째를 찾고 나서 `teamflow/clock.py` 로 모았습니다. 이 가드는
    세 번째를 막습니다.

    ⚠️ **마감일(`deadline`)은 여기 넣지 않습니다.** 그건 순간이 아니라
    달력 날짜이고, 이 저장소는 그것을 UTC 자정으로 저장합니다
    (`approval_service` 의 `datetime.combine(..., tzinfo=UTC)`).
    UTC 자정을 `.date()` 로 되읽는 것은 정확한 역변환이라 옳습니다.
    """
    import ast

    # 진짜 '순간' 인 열들. 달력 날짜인 `deadline` 은 일부러 뺐다.
    instants = {"completed_at", "occurred_at", "merged_at", "started_at", "created_at"}

    # ⚠️ 글자로 찾으면 **이 결함을 설명하는 주석과 docstring 이 먼저
    # 걸립니다.** `clock.py` 는 `completed_at.date()` 가 왜 틀렸는지를
    # 적어 두려고 그 모양을 그대로 쓰고 있습니다. 그래서 구문으로 찾습니다.
    offenders = []
    for path in sorted((REPO_ROOT / "backend" / "teamflow").rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or node.args or node.keywords:
                continue
            called = node.func
            if not isinstance(called, ast.Attribute) or called.attr != "date":
                continue
            owner = called.value
            name = (
                owner.attr
                if isinstance(owner, ast.Attribute)
                else owner.id
                if isinstance(owner, ast.Name)
                else ""
            )
            if name in instants:
                rel = path.relative_to(REPO_ROOT)
                offenders.append(f"{rel}:{node.lineno}  {name}.date()")

    assert not offenders, (
        "순간을 `.date()` 로 잘랐습니다 — UTC 달력일이라 한국에서 하루가\n"
        "어긋납니다. `teamflow.clock.local_date()` 를 쓰세요:\n  "
        + "\n  ".join(offenders)
    )


def test_the_seed_track_numbers_agree_with_the_production_formula():
    """⭐ 시드의 커버리지·총 공백·구멍 목록이 **서로 맞는가** (결함 99).

    운영은 셋을 **하나의 원천**에서 뽑습니다. `audio/assembly.py` 가

        coverage    = 1 - total_gap_ms / duration_ms
        total_gap_ms = 구멍 길이의 합

    이라, 이 셋이 어긋난 트랙은 **API 가 만들 수 없습니다.** 그런데 시드는
    셋을 각각 손으로 적고 있었고, 이렇게 갈라져 있었습니다.

        이하늘  커버리지 98%  ·  총 공백 0        ·  구멍 0개
        박지원  커버리지 42%  ·  총 공백 23.2분   ·  구멍 합 15분

    화면에서는 이하늘이 100% 인 김민수와 **똑같이 꽉 찬 막대**로 보였고,
    박지원은 빗금이 37.5% 인데 &#34;42% 커버리지&#34;(= 58% 빔)라고 말했습니다.
    이 저장소의 시그니처가 &#34;구멍이 **언제** 생겼는지&#34; 인데, 시연 자료가
    바로 그 질문에 답하지 못하고 있었습니다.

    ⚠️ 그래서 시드는 **구멍만 적고 나머지는 계산**해야 합니다. 여기서는
    그 계산이 실제로 있는지, 그리고 구멍 자체가 말이 되는지를 봅니다.
    """
    import ast
    import re
    from itertools import pairwise

    seed_path = REPO_ROOT / "scripts" / "seed_demo.py"
    seed = seed_path.read_text()

    # ── ① 손으로 적은 숫자가 없는가 ──────────────────────────
    #
    # `coverages = [1.0, 0.98, 0.42]` 처럼 적으면 구멍과 갈라집니다.
    tree = ast.parse(seed)
    literal_assignments = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        if not any(n in {"coverages", "totals"} for n in names):
            continue
        if isinstance(node.value, ast.List) and all(
            isinstance(e, ast.Constant) for e in node.value.elts
        ):
            literal_assignments.append(names[0])
    assert not literal_assignments, (
        f"{literal_assignments} 를 손으로 적었습니다 — 구멍에서 계산하세요 (결함 99)"
    )

    # 트랙에 넣는 값도 계산된 이름이어야 합니다.
    for field in ("coverage", "total_gap_ms"):
        hand = re.findall(rf"{field}=([0-9][0-9_.]*)", seed)
        assert not hand, f"{field} 에 숫자를 직접 적었습니다: {hand}"

    # ── ② 구멍 자체가 말이 되는가 ────────────────────────────
    block = re.search(r"track_gaps: [^=]*= (\[.*?\n        \])", seed, re.S)
    assert block, "track_gaps 표를 못 찾았습니다"
    tracks = ast.literal_eval(block.group(1))

    meeting_ms = re.search(r"MEETING_MS = ([0-9 *_]+)", seed)
    assert meeting_ms, "MEETING_MS 를 못 찾았습니다"
    # `40 * 60 * 1000` 같은 상수식입니다. 곱셈만 직접 풉니다 —
    # `eval` 은 시드가 바뀌면 무엇이든 실행하게 되므로 쓰지 않습니다.
    duration = 1
    for part in meeting_ms.group(1).split("*"):
        duration *= int(part.strip().replace("_", ""))

    problems = []
    for i, gaps in enumerate(tracks):
        spans = sorted((g["startMs"], g["endMs"]) for g in gaps)
        for start, end in spans:
            if end <= start:
                problems.append(f"{i}번 트랙: 끝이 시작보다 앞입니다 ({start}~{end})")
            if start < 0 or end > duration:
                problems.append(f"{i}번 트랙: 회의({duration}ms) 밖입니다 ({start}~{end})")
        for (s1, e1), (s2, _e2) in pairwise(spans):
            if s2 < e1:
                problems.append(f"{i}번 트랙: 구멍이 겹칩니다 ({s1}~{e1} · {s2}~)")
        total = sum(g["endMs"] - g["startMs"] for g in gaps)
        if total > duration:
            problems.append(f"{i}번 트랙: 구멍 합({total})이 회의보다 깁니다")

    assert not problems, "시드의 구멍이 말이 안 됩니다:\n  " + "\n  ".join(problems)

    # ── ③ 시연 의도가 남아 있는가 ────────────────────────────
    #
    # 트랙 하나는 **못 쓸 만큼** 끊겨 있어야 합니다. 그래야 &#34;측정 불가&#34;
    # 표시가 화면에 나오고, 이 프로젝트가 지키려는 구분(측정 불가 ≠ 0점)을
    # 시연에서 보여줄 수 있습니다.
    service = (
        REPO_ROOT / "backend" / "teamflow" / "services" / "recording_service.py"
    ).read_text()
    threshold = re.search(r"MIN_USABLE_COVERAGE = ([0-9.]+)", service)
    assert threshold, "MIN_USABLE_COVERAGE 를 못 찾았습니다"
    limit = float(threshold.group(1))

    coverages = [
        1 - sum(g["endMs"] - g["startMs"] for g in gaps) / duration for gaps in tracks
    ]
    assert any(c < limit for c in coverages), (
        f"시드에 못 쓸 트랙이 없습니다 (커버리지 {[round(c, 3) for c in coverages]}, "
        f"기준 {limit}) — '측정 불가' 화면을 시연할 수 없습니다"
    )
    assert any(c >= limit for c in coverages), "시드에 쓸 만한 트랙이 없습니다"
    assert any((1 - c) > 0 for c in coverages if c >= limit), (
        "쓸 만한데 **조금 끊긴** 트랙이 없습니다 — 작은 구멍이 그려지는지 볼 수 없습니다"
    )


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


def test_nothing_claims_the_audio_is_encrypted_while_it_is_plaintext():
    """⭐ 하다 만 암호화는 **안 한 것보다 나쁘다** — 없는 보호를 믿게 만든다.

    `audio_encryption_key_id` 라는 이름 때문에 P4(별도 암호화 키)가
    충족된 것처럼 읽혔습니다. 실제로는 그 값을 `audio_assets` 에 복사만
    하고 암·복호를 하는 코드가 없습니다. 오디오는 평문입니다.

    그래서 **둘 중 하나여야** 합니다.
      · 정말 암호화한다 → 청크를 쓰고 읽는 경로에 암·복호가 있다
      · 아직 아니다     → 설정·문서가 그렇게 말한다

    이 테스트는 **둘이 어긋나는 것**을 잡습니다. 나중에 암호화를 붙이면
    첫 번째 가지로 넘어가고, 이 테스트는 그때 자연스럽게 통과합니다.
    """
    store = (REPO_ROOT / "backend" / "teamflow" / "audio" / "chunk_store.py").read_text()

    # 실제로 암·복호를 하는가? 라이브러리 호출로 판단한다 — 주석의 단어가
    # 아니라 코드를 본다.
    encrypts = any(
        marker in store
        for marker in ("Fernet", "AESGCM", "encrypt(", "cryptography", "nacl")
    )
    if encrypts:
        return  # 첫 번째 가지. 이 테스트가 할 일은 없다.

    config = (REPO_ROOT / "backend" / "teamflow" / "config.py").read_text()
    docs = (REPO_ROOT / "docs" / "07-법적-윤리-요구사항.md").read_text()

    assert "평문" in config, (
        "오디오를 암호화하지 않는데 `config.py` 가 그 사실을 말하지 않습니다. "
        "`audio_encryption_key_id` 는 이름만으로 암호화를 암시합니다."
    )
    assert "평문" in docs, (
        "`docs/07` 의 P4 가 아직 충족되지 않았다는 사실이 문서에 없습니다. "
        "체크리스트가 사실과 다르면 감사에서 그대로 통과합니다."
    )


def test_no_error_message_leaks_an_internal_state_name():
    """⭐ 사람에게 보여주는 문장에 **내부 이름**을 넣지 않는다 (결함 78).

    녹음 화면이 이렇게 말하고 있었습니다.

        트랙에 참가하지 못했습니다: 이미 종료된 트랙입니다 (status=completed)

    `status=completed` 는 우리 DB 의 값입니다. 사람에게는 아무 뜻이 없고,
    괄호 안의 영어를 보면 **앱이 고장 났다**고 읽습니다. 결함 73(본문 JSON이
    그대로)·76(`은(는)`)과 같은 부류입니다 — 화면에 나가는 글자가 사람의
    말이 아닌 것.

    ⚠️ **예외를 좁게 둡니다.** 로그와 개발자용 메시지는 대상이 아닙니다.
    여기서 보는 것은 `HTTPException` 의 `detail` 로 흘러가는 예외 문구,
    즉 `ConsentError`·`TrackError` 처럼 **화면이 그대로 받아 적는** 것들입니다.
    """
    import re

    services = REPO_ROOT / "backend" / "teamflow" / "services"
    # 화면까지 흘러가는 예외들. `api/main.py` 가 이들을 `detail` 로 바꾼다.
    raised = re.compile(r"raise\s+(ConsentError|TrackError|ValueError)\((.*?)\)", re.S)
    # 내부 이름이 새는 모양: `status=`, `state=`, `phase=` 같은 key=value
    leak = re.compile(r"\b(status|state|phase|kind|type)\s*=\s*\{")

    offenders: list[str] = []
    for path in sorted(services.glob("*.py")):
        source = path.read_text(encoding="utf-8")
        for match in raised.finditer(source):
            body = match.group(2)
            if leak.search(body):
                line = source[: match.start()].count("\n") + 1
                offenders.append(f"{path.name}:{line} {body.strip()[:60]}")

    assert offenders == [], (
        "화면에 나가는 문구에 내부 상태 이름이 들어 있습니다: "
        + " | ".join(offenders)
        + ". `describe_track_state` 처럼 사람 말로 옮기는 자리를 두세요."
    )


def test_screen_text_does_not_space_korean_particles():
    """⭐ 화면에 나가는 문구에서 **조사를 앞말에 붙여** 쓴다 (결함 79).

    칸반 카드에 이렇게 적혀 있었습니다.

        PR 에 TASK 번호가 적혀 있습니다

    한국어에서 조사는 앞말에 붙습니다 — `PR에` 입니다. 띄우면 조사가
    다음 낱말처럼 보입니다. 결함 76 에서 프런트를 고쳤는데, 그때 백엔드
    스캔은 **보간(`{…}`)만** 봐서 이런 **글자 그대로**의 문구를 놓쳤습니다.

    ⚠️ **대상을 좁게 잡습니다.** 이 저장소의 주석·로그·docstring 은
    `seq 는 0 이상` 처럼 **코드 이름 뒤에 조사를 띄우는** 문서 관례를
    씁니다. 그건 화면에 안 나오므로 여기서 볼 대상이 아닙니다.
    화면 문구를 만드는 것이 존재 이유인 모듈만 봅니다.

    ⚠️ **이 가드는 처음에 두 군데를 놓쳤습니다** (결함 80 에서 넓혔습니다).

      · 앞말을 `[A-Za-z0-9)]` 로만 봐서 **닫는 따옴표 뒤**를 못 잡았습니다 —
        `‘지난 활동 가져오기’ 를 누르면` 이 이 파일 안에서 통과하고
        있었습니다. 가드가 있는 파일 안에서도 빠져나간 것입니다.
      · `api/main.py` 를 안 봤습니다. `HTTPException` 의 `detail` 은
        **그대로 화면에 뜹니다** — 초대 코드 형식 오류가 그랬습니다.
    """
    import ast
    import re

    SCREEN_TEXT_MODULES = [
        # 연결 진단 — 상태·근거·다음 할 일을 그대로 화면에 띄운다
        REPO_ROOT / "backend" / "teamflow" / "github" / "connection.py",
        # "왜 이 PR 이 이 업무에 붙었는가" — 카드에 그대로 나간다
        REPO_ROOT / "backend" / "teamflow" / "github" / "linking.py",
        # `HTTPException(detail=…)` 은 화면이 그대로 읽어 사람에게 보여준다
        REPO_ROOT / "backend" / "teamflow" / "api" / "main.py",
        # 트랙 상태 문장 (결함 78)
        REPO_ROOT / "backend" / "teamflow" / "services" / "recording_service.py",
    ]

    # ⚠️ **면제에는 근거를 적습니다.** 화면에 뜨긴 하지만 사람의 조작으로는
    # 닿을 수 없는 자리가 있습니다. "그냥 예외" 로 두면 다음에 진짜 화면
    # 문구가 여기 섞입니다.
    CLIENT_BUG_ONLY = {
        "main.py «q 는»": (
            "`seq 는 0 이상이어야 합니다` — 사람이 seq 를 입력하는 화면이 없다. "
            "녹음 클라이언트가 음수를 보낼 때만 닿고, 그때는 필드 이름이 보여야 고친다."
        ),
    }

    # 앞말이 무엇이든 조사인 것. 띄우면 틀린다.
    sure = ["은", "는", "을", "를", "과", "와", "의", "에서", "으로", "부터", "까지"]
    # ⚠️ 이쪽은 **앞말이 한글이 아닐 때만** 본다. `이`·`가`·`로`·`도`·`만` 은
    # 관형사·의존명사일 수도 있어서(`이 화면`, `3년 만에`) 한글 뒤에서는
    # 글자만 보고 가를 수 없다. 가를 수 있는 자리만 본다.
    maybe = ["이", "가", "로", "도", "만", "에", "에게"]
    before_any = r"[가-힣A-Za-z0-9%)\]”’\"']"
    before_code = r"[A-Za-z0-9%)\]”’\"']"
    tail = r"(?=[\s.,·—…!?)\"']|$)"
    def _alts(words: list[str]) -> str:
        return "|".join(sorted(words, key=len, reverse=True))

    patterns = [
        re.compile(before_any + " (" + _alts(sure) + ")" + tail),
        re.compile(before_code + " (" + _alts(maybe) + ")" + tail),
    ]
    hangul = re.compile(r"[가-힣]")

    # ⚠️ **줄 단위로 보면 안 됩니다.** 처음에는 `"logger." in line` 으로
    # 로그를 걸렀는데, 인자가 다음 줄에 있는 로그 호출이 그물을 빠져나가
    # 멀쩡한 로그 두 줄을 결함으로 신고했습니다. 파이썬 코드는 파이썬에게
    # 물어봅니다 — `ast` 로 **문자열이 어디에 쓰이는지** 를 봅니다.
    def _logged(tree: ast.AST) -> set[int]:
        """`logger.*(...)` 안에 들어간 문자열들의 id."""
        out: set[int] = set()
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if not (isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name)):
                continue
            if func.value.id not in {"logger", "log", "logging"}:
                continue
            for inner in ast.walk(node):
                if isinstance(inner, ast.Constant) and isinstance(inner.value, str):
                    out.add(id(inner))
        return out

    def _docstrings(tree: ast.AST) -> set[int]:
        """docstring 은 사람이 읽는 문서이지 화면 문구가 아니다."""
        out: set[int] = set()
        for node in ast.walk(tree):
            holders = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
            if not isinstance(node, holders):
                continue
            body = getattr(node, "body", [])
            if not body:
                continue
            first = body[0]
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                out.add(id(first.value))
        return out

    offenders: list[str] = []
    for path in SCREEN_TEXT_MODULES:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        skip = _logged(tree) | _docstrings(tree)
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
                continue
            if id(node) in skip:
                continue
            text = node.value
            if not hangul.search(text):
                continue
            for spaced in patterns:
                hit = spaced.search(text)
                if hit is None:
                    continue
                key = f"{path.name} «{hit.group(0)}»"
                if key in CLIENT_BUG_ONLY:
                    continue
                offenders.append(f"{path.name}:{node.lineno} «{hit.group(0)}»")
                break

    assert offenders == [], (
        "화면 문구에서 조사를 띄어 썼습니다: "
        + " | ".join(offenders)
        + ". 조사는 앞말에 붙여 쓰세요 (`PR에`, `App이`)."
    )




# ══════════════════════════════════════════════════════════════
# 정리 잡 — 부르는 곳이 있는가 (결함 116)
# ══════════════════════════════════════════════════════════════

#: 호출자가 없어도 되는 정리 함수와 **그 근거**.
#:
#: ⚠️ 근거 없이 이름만 추가하지 마십시오. 이 표는 "왜 안 불려도 되는가"
#: 를 코드 안에 들고 있으라고 있는 것입니다 — 그냥 통과시키려고 이름을
#: 적으면 가드가 아니라 장식이 됩니다.
CLEANUP_WITHOUT_A_CALLER = {
    "revoke_all_for_user": (
        "사고 대응용입니다. 비밀번호를 바꿨거나 기기를 잃었을 때 파이썬 셸에서 "
        "한 줄로 모든 세션을 끊습니다. 화면이 없는 것이 의도이고, 함수 자신의 "
        "독스트링이 그렇게 적어 뒀습니다 — 사고가 났을 때부터 코드를 짜는 것과 "
        "다릅니다."
    ),
}


def _cleanup_functions() -> dict[str, str]:
    """`teamflow/jobs/`·`teamflow/services/` 안의 `purge_*`·`revoke_*` 정의."""
    import ast

    found: dict[str, str] = {}
    for folder in ("jobs", "services"):
        for path in sorted((REPO_ROOT / "backend" / "teamflow" / folder).glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                    continue
                if not node.name.startswith(("purge_", "revoke_")):
                    continue
                found[node.name] = f"{folder}/{path.name}:{node.lineno}"
    return found


def _call_counts(names: set[str]) -> dict[str, int]:
    """teamflow 안에서 그 이름을 **부르는** 곳의 수. 정의는 안 셉니다."""
    import ast

    counts = dict.fromkeys(names, 0)
    for path in sorted((REPO_ROOT / "backend" / "teamflow").rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            called = (
                func.id
                if isinstance(func, ast.Name)
                else func.attr
                if isinstance(func, ast.Attribute)
                else None
            )
            if called in counts:
                counts[called] += 1
    return counts


def test_every_cleanup_function_has_something_that_calls_it():
    """⭐ **지우는 코드는 안 불려도 조용합니다** (결함 116).

    `auth_service.purge_expired` 는 만료된 `user_sessions` 행을 지우면서
    독스트링에 **"유지보수 잡에서 부릅니다"** 라고 단언했습니다. 그 잡은
    없었습니다 — `tasks/maintenance.py` 에도 `beat_schedule` 에도 없었고,
    부르는 곳이 **0곳**이었습니다.

    이 부류가 조용한 이유는 두 겹입니다.

      · **안 부르면** 아무 일도 안 일어납니다. 오류도 로그도 없습니다.
        디스크가 차거나 보존기간이 지난 데이터가 남거나 — 몇 달 뒤에,
        코드가 아니라 **운영에서** 드러납니다
      · **부르면** 되돌릴 수 없습니다. 지우는 코드라서 그렇습니다

    실제로 이 저장소는 앞의 것을 이미 한 번 겪었습니다. 성문 폐기 태스크가
    선언만 되고 스케줄이 없었습니다 — 문서가 "가장 민감한 데이터" 라고
    분류한 생체인식정보였습니다. 그 교훈이 `beat_schedule` 주석에만 남고
    **검사로는 안 남아** 있었습니다. 이 테스트가 그 자리입니다.
    """
    defined = _cleanup_functions()
    counts = _call_counts(set(defined))

    orphans = [
        f"{name} ({defined[name]})"
        for name, hits in sorted(counts.items())
        if hits == 0 and name not in CLEANUP_WITHOUT_A_CALLER
    ]

    assert orphans == [], (
        "지우는 함수인데 teamflow 안에 부르는 곳이 없습니다: "
        + " | ".join(orphans)
        + ". 배선하거나, 지우거나, `CLEANUP_WITHOUT_A_CALLER` 에 **근거와 함께** "
        "적으십시오. 독스트링에 '잡에서 부릅니다' 라고 적는 것은 배선이 아닙니다."
    )


def test_the_cleanup_allowlist_does_not_name_functions_that_are_gone():
    """면제 표가 낡으면 다음 사람이 "검토된 목록" 으로 읽습니다."""
    defined = _cleanup_functions()
    stale = sorted(set(CLEANUP_WITHOUT_A_CALLER) - set(defined))
    assert stale == [], (
        f"`CLEANUP_WITHOUT_A_CALLER` 에 이제 없는 함수가 있습니다: {stale}. "
        "지우십시오."
    )


def test_every_maintenance_task_is_actually_scheduled():
    """⭐ **선언된 태스크와 도는 태스크는 다릅니다** (결함 116).

    `@app.task` 를 붙이면 태스크가 **등록**될 뿐입니다. 누가 부르지
    않으면 영원히 안 돕니다. 이 저장소는 그걸 한 번 겪었습니다 — 끝난
    프로젝트의 성문을 폐기하는 태스크가 선언돼 있고 독스트링에 "목적 외
    보관이 된다" 라고까지 적혀 있는데 `beat_schedule` 에 없었습니다.

    그때 고치면서 주석은 남겼지만 **검사는 안 남겼습니다.** 다음에 정리
    태스크를 하나 더 만들면 같은 자리에서 같은 방식으로 빠집니다.
    """
    import ast

    tasks_dir = REPO_ROOT / "backend" / "teamflow" / "tasks"
    tree = ast.parse((tasks_dir / "maintenance.py").read_text(encoding="utf-8"))

    declared: dict[str, str] = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        for deco in node.decorator_list:
            if not isinstance(deco, ast.Call):
                continue
            for kw in deco.keywords:
                if kw.arg == "name" and isinstance(kw.value, ast.Constant):
                    declared[str(kw.value.value)] = f"maintenance.py:{node.lineno}"

    assert declared, (
        "`tasks/maintenance.py` 에서 `@app.task(name=...)` 를 하나도 못 찾았습니다. "
        "데코레이터 모양이 바뀌었으면 이 검사도 같이 고치십시오 — 아무것도 못 "
        "찾은 검사는 언제나 통과합니다."
    )

    # `beat_schedule=` 아래의 문자열을 전부 모읍니다. 어느 항목의 어느 키인지는
    # 안 봅니다 — 이름이 거기 **적혀 있기만** 하면 스케줄에 걸린 것입니다.
    app_tree = ast.parse((tasks_dir / "__init__.py").read_text(encoding="utf-8"))
    scheduled: set[str] = set()
    for node in ast.walk(app_tree):
        if isinstance(node, ast.keyword) and node.arg == "beat_schedule":
            scheduled |= {
                sub.value
                for sub in ast.walk(node.value)
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str)
            }

    missing = sorted(
        f"{name} ({where})" for name, where in declared.items() if name not in scheduled
    )
    assert missing == [], (
        "선언만 되고 `beat_schedule` 에 없는 유지보수 태스크가 있습니다: "
        + " | ".join(missing)
        + ". 등록은 실행이 아닙니다 — 스케줄에 넣거나, 왜 수동으로만 도는지 "
        "주석으로 적으십시오."
    )


# ══════════════════════════════════════════════════════════════
# 요청 본문 — 보낸 값을 서버가 읽는가
# ══════════════════════════════════════════════════════════════

#: 핸들러가 직접 안 읽어도 되는 요청 칸과 **그 근거**.
#:
#: 지금은 비어 있습니다. 비어 있는 것이 정상입니다 — 채우게 되면
#: 그때마다 왜 안 읽어도 되는지를 여기 적으십시오.
REQUEST_FIELDS_THE_HANDLER_NEED_NOT_READ: dict[str, str] = {}


def test_every_field_the_screen_sends_is_read_by_the_handler():
    """⭐ **보낸 값을 서버가 안 읽으면 아무 일도 안 일어납니다.**

    응답 쪽은 이미 가드가 있습니다 — 서버가 실어 보낸 칸을 아무 화면도
    안 읽는 경우(결함 93·95·96). **반대 방향은 없었습니다.**

    이쪽이 더 조용합니다. 응답의 안 읽는 칸은 &#34;화면에 뭔가 덜 나온다&#34;
    지만, 요청의 안 읽는 칸은 **사람이 바꿨다고 믿는데 안 바뀐 것**입니다.
    Pydantic 은 모르는 칸을 조용히 무시하고, 200 이 돌아오고, 화면은
    &#34;저장했습니다&#34; 라고 말합니다. 결함 67(동의 ②③ 이 저장만 되고 아무
    효과가 없었다)이 정확히 이 모양이었습니다.

    ⚠️ 이 검사는 **핸들러가 그 인자의 속성으로 읽는지**만 봅니다. 인자를
    통째로 헬퍼에 넘기면(`_apply(payload)`) 그 안은 안 봅니다 — 그런
    핸들러가 생기면 여기서 거짓 신고가 납니다. 그때 검사를 넓히거나
    `REQUEST_FIELDS_THE_HANDLER_NEED_NOT_READ` 에 근거와 함께 적으십시오.
    """
    import ast

    main = REPO_ROOT / "backend" / "teamflow" / "api" / "main.py"
    tree = ast.parse(main.read_text(encoding="utf-8"))

    models: dict[str, list[tuple[str, int]]] = {}
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and any(
            isinstance(b, ast.Name) and b.id == "BaseModel" for b in node.bases
        ):
            models[node.name] = [
                (stmt.target.id, stmt.lineno)
                for stmt in node.body
                if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name)
            ]

    checked = 0
    unread: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            continue
        if not any(
            isinstance(deco, ast.Call)
            and isinstance(deco.func, ast.Attribute)
            and deco.func.attr in {"get", "post", "patch", "put", "delete"}
            for deco in node.decorator_list
        ):
            continue
        for arg in [*node.args.args, *node.args.kwonlyargs]:
            model = arg.annotation.id if isinstance(arg.annotation, ast.Name) else None
            if model not in models:
                continue
            checked += 1
            read = {
                sub.attr
                for sub in ast.walk(node)
                if isinstance(sub, ast.Attribute)
                and isinstance(sub.value, ast.Name)
                and sub.value.id == arg.arg
            }
            unread += [
                f"{model}.{field} → {node.name}() (main.py:{line})"
                for field, line in models[model]
                if field not in read
                and f"{model}.{field}" not in REQUEST_FIELDS_THE_HANDLER_NEED_NOT_READ
            ]

    assert checked >= 15, (
        f"요청 본문 모델을 {checked}개밖에 못 찾았습니다. 라우트나 시그니처 모양이 "
        "바뀌었으면 이 검사도 같이 고치십시오 — 아무것도 못 찾은 검사는 언제나 "
        "통과합니다."
    )
    assert unread == [], (
        "화면이 보낼 수 있는데 핸들러가 읽지 않는 칸이 있습니다: "
        + " | ".join(unread)
        + ". 읽거나, 칸을 없애거나, `REQUEST_FIELDS_THE_HANDLER_NEED_NOT_READ` 에 "
        "근거와 함께 적으십시오. 안 읽는 칸은 200 을 돌려주면서 아무 일도 안 합니다."
    )
