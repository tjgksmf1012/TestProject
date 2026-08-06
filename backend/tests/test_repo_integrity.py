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
