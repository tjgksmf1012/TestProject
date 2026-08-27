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

import re
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



#: 화면이 **전체 경로로는 안 잡는** 서버 갈래 — 왜인지 같이 적습니다.
#:
#: ⚠️ 이 표는 **두 곳이 읽습니다**: 아래 라우트 가드와,
#: `test_the_requirements_table_does_not_claim_unwired_things` 입니다.
#: 사본을 만들면 「서버만 있다」와 「✅ 다 됐다」가 갈라집니다 — 실제로
#: `docs/20` 의 CHANNEL-005 가 ✅ 인 채로 그렇게 갈라져 있었습니다(결함 377).
SERVER_ONLY_OR_ASSEMBLED: dict[str, str] = {
        "POST /api/github/webhook": "GitHub 이 부릅니다 — 화면이 부르는 갈래가 아닙니다",
    "GET /health": (
        "컨테이너·배포가 살아 있는지 묻는 갈래입니다 — 화면이 부르는 것이 "
        "아닙니다. ⚠️ 오래도록 「불린다」로 잡혀 있었는데, 그건 `/health` 가 "
        "`../lib/github/health.ts` 라는 **import 경로 안**에 걸린 것이었습니다"
        "(결함 379)"
    ),
        "PUT /api/meetings/{meeting_id}/tracks/{track_id}/chunks/{seq}": (
            "`browser-adapter.ts` 가 `${trackUrl}/chunks/${seq}` 로 이어 붙입니다"
        ),
        "GET /api/meetings/{meeting_id}/tracks/{track_id}/chunks": (
            "`demo/main.ts` 가 `${trackUrl}/chunks` 로 이어 붙입니다"
        ),
        "POST /api/meetings/{meeting_id}/tracks/{track_id}/complete": (
            "`demo/main.ts` 가 `${trackUrl}/complete` 로 이어 붙입니다"
        ),
        # ⚠️ 아래 둘은 **진짜로 아무도 안 부릅니다.** 숨기지 않고 적어 둡니다 —
        #    만들어 놓고 화면에 안 이은 것이고(실패 ①), 붙일 때 이 줄을 지웁니다.
        "PATCH /api/channels/{channel_id}": (
            "CHANNEL-003 채널 이름 변경 — 서버만 있고 화면에 아직 안 이었습니다. "
            "자가 헐거워 오래 숨어 있었습니다(결함 378)"
        ),
        "DELETE /api/channels/{channel_id}": (
            "CHANNEL-004 채널 삭제(보관) — 서버만 있고 화면에 아직 안 이었습니다. "
            "자가 헐거워 오래 숨어 있었습니다(결함 378)"
        ),
        "PUT /api/projects/{project_id}/channels/order": (
            "CHANNEL-005 채널 순서 — 서버만 있고 화면에 아직 안 이었습니다"
        ),
        "GET /api/projects/{project_id}/mentions": (
            "내가 불린 **횟수**(`mention_total`) — 서버만 있고 화면에 아직 안 "
            "이었습니다. ⚠️ 예전에 이 줄은 「멘션 자동완성」이라고 적혀 "
            "있었는데 **거짓**입니다: 이 갈래가 돌려주는 것은 후보 목록이 "
            "아니라 숫자 하나라, 이었어도 자동완성은 못 만듭니다(결함 417 "
            "회차에 세다가 찾았습니다). 멘션 자체는 서버가 본문에서 찾아 "
            "내므로 동작하고, 자동완성은 이 저장소에 아예 없습니다"
        ),
    }

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
    from teamflow.db import vocab
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
        # 발언 유형 (정의서 §10). 서버가 `utterance_type` 을 코드로 보내고
        # 화면이 옮깁니다. ⚠️ 동의·반대·보완을 가르면서 다섯이 한꺼번에
        # 늘었는데, 한쪽만 늘리면 검토 화면에 `objection` 이라는 **영어
        # 식별자**가 그대로 찍힙니다.
        (
            "발언 유형",
            {str(t) for t in vocab.UtteranceType},
            "frontend/src/lib/review/labels.ts",
            "TYPE_LABEL",
        ),
        # 프로젝트 권한 (정의서 §5 `PROJECT-004`). 한쪽만 늘리면 팀원
        # 목록에 `admin` 이라는 영어 식별자가 그대로 찍힙니다.
        (
            "프로젝트 권한",
            {str(r) for r in vocab.ProjectRole},
            "frontend/src/lib/project/roles.ts",
            "ROLE_LABEL",
        ),
        # 사용자 상태 (정의서 §4 `USER-005`).
        (
            "사용자 상태",
            {str(s) for s in vocab.PresenceStatus},
            "frontend/src/lib/project/presence.ts",
            "PRESENCE_LABEL",
        ),
        # 업무 우선순위 (정의서 §15 `TASK-007`). ⚠️ 이 칸은 오래 **아무도
        # 안 읽고 있었습니다** — 검색 API 는 거르기까지 했는데 사람이 값을
        # 정할 자리도 볼 자리도 없었습니다. 이제 양쪽에 어휘가 있으니
        # 갈라지지 않게 붙잡습니다. 키가 숫자(0~3)라 다른 표와 다릅니다.
        (
            "업무 우선순위",
            {str(int(p)) for p in vocab.TASK_PRIORITIES},
            "frontend/src/lib/kanban/priority.ts",
            "PRIORITY_LABEL",
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


def _screen_label_pairs() -> list[tuple[str, dict, str, str]]:
    """서버와 화면이 **같은 낱말을 두 벌** 적어 둔 자리.

    ⚠️ 위 `_screen_vocabularies` 는 **키 집합**만 봅니다. 결함 291 이
    그 한계를 이렇게 적어 두고 갔습니다.

    > 짝 검사가 「키 집합」만 보고 있던 것 — 서버 어휘 ↔ 화면 이름표 짝
    > 검사가 넷 있었는데 **키가 같은가**만 봤습니다. … 짝을 잴 때는
    > **양쪽이 같은 글자를 내는가**까지 보십시오

    키만 보면 한쪽이 「반대 의견」, 다른 쪽이 「반대」로 갈라져도 초록입니다.
    같은 발언이 회의록과 화면에서 다른 이름으로 불리는 것이고, 결함 290 이
    회의 시각에서 겪은 것과 같은 모양입니다.

    ⚠️ **여기 넣을 수 있는 것은 서버에도 이름표 표가 있는 것뿐입니다.**
    `REACTION_LABEL`·`GITHUB_EVENT_LABEL` 은 서버가 **글자를 실어 보내서**
    화면에 사본이 없습니다 — 두 벌이 아니므로 갈라질 수 없습니다.
    """
    from teamflow.db import vocab

    return [
        ("발언 유형", vocab.UTTERANCE_LABEL, "frontend/src/lib/review/labels.ts", "TYPE_LABEL"),
        (
            "프로젝트 권한",
            vocab.PROJECT_ROLE_LABEL,
            "frontend/src/lib/project/roles.ts",
            "ROLE_LABEL",
        ),
        (
            "사용자 상태",
            vocab.PRESENCE_LABEL,
            "frontend/src/lib/project/presence.ts",
            "PRESENCE_LABEL",
        ),
        (
            "업무 우선순위",
            vocab.TASK_PRIORITY_LABEL,
            "frontend/src/lib/kanban/priority.ts",
            "PRIORITY_LABEL",
        ),
        ("업무 상태", vocab.TASK_STATUS_LABEL, "frontend/src/lib/kanban/board.ts", "STATUS_LABEL"),
    ]


def test_the_two_copies_of_each_label_say_the_same_word():
    """⭐ 짝을 잴 때는 **양쪽이 같은 글자를 내는가**까지 본다 (결함 291 의 숙제).

    이건 기록된 결정이 아니라 **적어만 두고 간 숙제**입니다 — AGENTS 가
    둘을 가르라고 적어 뒀고, 숙제는 하는 것이 뒤집는 것이 아닙니다.
    """
    import re

    problems: list[str] = []
    pairs = _screen_label_pairs()
    # 안 보고 있는 상태 자체가 실패여야 합니다 (결함 286).
    assert len(pairs) >= 5, f"짝을 {len(pairs)}개밖에 안 재고 있습니다 — 표가 낡았습니다"

    for name, server, rel, table in pairs:
        source = (REPO_ROOT / rel).read_text()
        block = re.search(
            rf"{table}: Record<[^,>]+, string> = \{{(.*?)\}};", source, re.DOTALL
        )
        if block is None:
            problems.append(f"{name}: {rel} 에서 {table} 을 못 찾았습니다")
            continue
        screen = dict(
            re.findall(r"^\s*'?([\w]+)'?:\s*'([^']*)'", block.group(1), re.MULTILINE)
        )
        expected = {str(getattr(k, "value", k)): v for k, v in server.items()}
        assert expected, f"{name}: 서버 이름표가 비었습니다 — 표가 낡았습니다"
        for key in sorted(expected):
            mine = expected[key]
            theirs = screen.get(key)
            if theirs != mine:
                problems.append(f"{name}.{key}: 서버「{mine}」 ≠ 화면「{theirs}」")

    assert problems == [], "같은 값을 두 곳이 다르게 부릅니다:\n" + "\n".join(
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
# 데스크톱 셸 — 만들어 놓고 부르지 않으면 아무 일도 안 일어난다
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 여기 있던 **안드로이드 셸 가드 넷**을 걷어냈습니다. 셸을 접었기
#    때문입니다(`docs/14` 머리말 · `docs/21` §6). 넷이 대조하던 것은
#    코틀린과 TypeScript 사이의 이름이었고, 한쪽이 없어졌으니 대조할
#    것도 없습니다.
#
# ⚠️ **다섯 번째는 남겼습니다.** 그것은 코틀린을 안 읽고 웹 화면만
#    읽습니다 — "만들어 놓고 아무도 안 부름" 을 잡는 자리이고, 그 결함은
#    셸이 무엇이든 그대로 살아 있습니다. 절 이름만 보고 같이 지웠으면
#    웹 쪽 그물을 잃을 뻔했습니다.


def test_the_readme_never_tells_you_to_cd_somewhere_that_is_gone():
    """⭐ README 의 셋업 명령이 **없는 곳**을 가리키면 안 됩니다.

    ⚠️ 실제로 그런 줄이 있었고 **잡는 검사가 하나도 없었습니다.**

        cd android && ./gradlew assembleDebug

    `android/` 가 없어진 뒤에도 이 줄은 그대로 남아 있었을 것이고,
    처음 오는 사람은 제일 먼저 읽는 문서가 시키는 대로 하다가 막힙니다.
    게다가 그 명령은 셸이 있을 때조차 **실행이 불가능**했습니다 —
    `gradlew` 래퍼를 커밋한 적이 없었습니다.

    ⚠️ 명령 전체를 검사하지 않습니다. `cd <경로>` 의 경로만 봅니다 —
    그것이 기계로 확인 가능한 부분이고, 나머지를 재는 척하면 이 검사가
    거짓말을 하게 됩니다.

    ⚠️ **빈 디렉터리는 없는 것으로 봅니다.** 처음에 `exists()` 만 봤다가
    이 검사가 조용히 통과했습니다 — `git rm -r` 이 파일만 지우고 빈
    `android/` 를 남겼고, 빈 껍데기로 `cd` 해 봐야 할 것이 없습니다.
    터질 줄 알고 봤다가 안 터져서 알았습니다.
    """
    import re

    def usable(path: str) -> bool:
        target = REPO_ROOT / path
        if not target.exists():
            return False
        return any(target.iterdir()) if target.is_dir() else True

    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    missing = sorted(
        {
            path
            for path in re.findall(r"cd ([A-Za-z0-9_./-]+)", readme)
            if not usable(path)
        }
    )
    assert not missing, (
        f"README 가 없는 곳으로 데려갑니다: {missing} — 지웠으면 명령도 같이 지우십시오"
    )


def test_the_recording_screen_marks_where_the_shell_hook_goes():
    """⭐ 녹음 시작·멈춤 자리에 **셸에게 알릴 자리**가 표시돼 있는가.

    안드로이드 셸에게 "지금부터 녹음" 이라고 말하던 코드가 있었습니다.
    셸을 접으면서 걷어냈고, 데스크톱 셸은 아직 받을 준비가 안 됐습니다
    (`docs/21` Phase 2 — `powerSaveBlocker`).

    ⚠️ **그 자리가 사라지면 안 됩니다.** 사라지면 Phase 2 를 하는 사람이
    어디에 붙여야 하는지 모릅니다. 이 저장소의 대표 실패 ③ 이 정확히
    그것입니다 — 할 일을 알려 주고 그 일을 할 자리를 안 주는 것.

    ⚠️ 지금은 **호출이 아니라 표시**를 봅니다. 없는 함수를 부르는 척하면
    그게 더 나쁩니다.
    """
    screen = (REPO_ROOT / "frontend" / "src" / "demo" / "main.ts").read_text()
    assert screen.count("Phase 2") >= 2, (
        "녹음 시작·멈춤 자리의 `docs/21` Phase 2 표시가 사라졌습니다 — "
        "데스크톱 셸에게 알릴 자리를 다음 사람이 못 찾습니다"
    )
    assert "powerSaveBlocker" in screen, (
        "무엇을 붙여야 하는지(`powerSaveBlocker`)가 화면 코드에서 사라졌습니다"
    )


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
#: 프런트 값은 `frontend/src/lib/recording/timeline.ts` **한 곳**에만
#: 있어야 합니다. ⚠️ 「한 파일만 읽는다」와 「한 곳에만 있다」는 다릅니다 —
#: 예전에는 앞엣것만 지켰고, `lobby/room.ts` 가 `MIN_USABLE_COVERAGE` 를
#: **따로 들고** 있어도 검사 전부가 초록이었습니다(결함 363). 아래
#: `test_the_paired_numbers_live_in_exactly_one_place` 가 그것을 셉니다.
#: ⚠️ **프런트 파일을 줄마다 적습니다.** 예전에는 `FRONT_CONSTANTS` 하나로
#: 못 박혀 있어서, 표에 넣을 수 있는 것이 `recording/timeline.ts` 의
#: 상수뿐이었습니다. 그래서 **다른 파일에 있는 짝 넷**이 통째로 표 밖에
#: 있었습니다(`CODE_LENGTH`·`MAX_BIO`·`MAX_BODY`·`MIN_PASSWORD_LENGTH`).
PAIRED_CONSTANTS = [
    (
        "이보다 짧은 공백은 보고하지 않는다",
        "backend/teamflow/audio/assembly.py",
        "MIN_REPORTED_GAP_MS",
        "frontend/src/lib/recording/timeline.ts",
        "MIN_REPORTED_GAP_MS",
    ),
    (
        "이만큼까지의 지연은 정상 지터로 본다",
        "backend/teamflow/audio/assembly.py",
        "STALL_TOLERANCE_MS",
        "frontend/src/lib/recording/timeline.ts",
        "DEFAULT_STALL_TOLERANCE_MS",
    ),
    (
        "이 아래면 트랙을 쓰지 않는다",
        "backend/teamflow/services/recording_service.py",
        "MIN_USABLE_COVERAGE",
        "frontend/src/lib/recording/timeline.ts",
        "MIN_USABLE_COVERAGE",
    ),
    (
        "초대 코드 길이 — 갈라지면 멀쩡한 코드를 화면이 거절합니다",
        "backend/teamflow/projects/invites.py",
        "CODE_LENGTH",
        "frontend/src/lib/project/setup.ts",
        "CODE_LENGTH",
    ),
    (
        "자기소개 길이 — 갈라지면 화면은 받아 놓고 서버가 거절합니다",
        "backend/teamflow/users/profile.py",
        "MAX_BIO",
        "frontend/src/lib/profile/edit.ts",
        "MAX_BIO",
    ),
    (
        "메시지 길이 — 갈라지면 두 화면이 서로 다른 숫자를 말합니다",
        "backend/teamflow/services/message_service.py",
        "MAX_BODY",
        "frontend/src/lib/chat/view.ts",
        "MAX_BODY",
    ),
    (
        "비밀번호 최소 길이 — 갈라지면 가입이 화면 통과 후 실패합니다",
        "backend/teamflow/auth/passwords.py",
        "MIN_PASSWORD_LENGTH",
        "frontend/src/lib/auth/session.ts",
        "MIN_PASSWORD_LENGTH",
    ),
]


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
    problems = []
    for meaning, rel, back_name, front_rel, front_name in PAIRED_CONSTANTS:
        back = (REPO_ROOT / rel).read_text()
        front = (REPO_ROOT / front_rel).read_text()
        back_value = _number_after(back, back_name)
        front_value = _number_after(front, front_name)
        if back_value is None:
            problems.append(f"{rel} 에서 {back_name} 을 못 찾았습니다")
            continue
        if front_value is None:
            problems.append(f"{front_rel} 에서 {front_name} 을 못 찾았습니다")
            continue
        if float(back_value) != float(front_value):
            problems.append(
                f"{meaning}: {back_name}={back_value} 인데 {front_name}={front_value} 입니다"
            )

    assert not problems, "서버와 화면의 숫자가 갈라졌습니다:\n  " + "\n  ".join(problems)


def test_the_paired_numbers_live_in_exactly_one_place():
    """⭐ 서버와 짝지은 숫자가 화면 쪽에 **딱 한 벌**만 있는가 (결함 363).

    `test_the_same_number_on_both_sides_really_is_the_same` 은 서버와
    `recording/timeline.ts` 를 맞춥니다. 그 자는 **읽는 파일이 하나**라,
    같은 이름이 `@lib` 의 **다른 파일**에도 있으면 아무것도 못 봅니다.

    실제로 `MIN_USABLE_COVERAGE` 가 세 벌이었습니다 — 서버 ·
    `recording/timeline.ts` · **`lobby/room.ts`**. 로비의 값을 `0.5` 로
    바꾸고 번들까지 다시 만든 뒤 전부 돌렸더니 **pytest 2145 · 프런트
    1969 이 전부 초록**이었습니다. 그 상태에서 로비는 커버리지 0.6 짜리
    트랙을 「쓸 만합니다」라고 하고 서버는 `unusable` 로 저장합니다 —
    앞 검사의 docstring 이 **바로 그 해악**을 적어 두고 있는데, 정작
    그 자리를 안 보고 있었습니다.

    ⚠️ **낱말이 아니라 요구를 잽니다.** 「timeline.ts 를 읽는가」가 아니라
    **「정의가 딱 하나인가」**를 셉니다 — 그래야 다음 사람이 네 번째
    사본을 만들어도 잡힙니다. 다시 내보내는 것(`export { X }`)은 정의가
    아니므로 세지 않습니다.
    """
    import re

    lib = REPO_ROOT / "frontend" / "src" / "lib"
    problems = []
    for _, _, _, front_rel, front_name in PAIRED_CONSTANTS:
        # 정의인 자리만 셉니다 — 다시 내보내는 것(`export { X }`)은 정의가
        # 아닙니다. ⚠️ **`export` 를 요구하면 안 됩니다** — 이 표의 셋 중
        # 둘은 모듈 안에서만 쓰는 `const` 입니다(처음에 그렇게 썼다가
        # 「0곳」이 나왔습니다).
        pattern = re.compile(
            rf"^\s*(?:export\s+)?const\s+{front_name}\b[^=\n]*=\s*[0-9]",
            re.MULTILINE,
        )
        where = [
            str(path.relative_to(REPO_ROOT))
            for path in sorted(lib.rglob("*.ts"))
            if not path.name.endswith(".test.ts")
            and pattern.search(path.read_text(encoding="utf-8"))
        ]
        if len(where) != 1:
            problems.append(
                f"{front_name}: 정의가 {len(where)}곳입니다 — {', '.join(where) or '(0곳)'}"
            )
        elif where[0] != front_rel:
            problems.append(
                f"{front_name}: {where[0]} 에 있습니다 — 표는 {front_rel} 라고 적었습니다"
            )

    assert not problems, (
        "서버와 짝지은 숫자가 화면 쪽에 여러 벌이거나 엉뚱한 곳에 있습니다:\n  "
        + "\n  ".join(problems)
    )


def test_the_paired_constant_table_is_not_stale():
    """⭐ 표가 낡지 않았는가 — **기준으로 전수를 재서** 확인한다.

    ## ⛔ 이 검사가 스스로 경고한 일이 스스로에게 났습니다

    예전 판은 이렇게 적어 두었습니다.

        이 검사가 없으면 다음 사람이 상수를 하나 더 만들면서 같은 주석을
        달고, 그건 아무도 안 지킵니다. 표를 늘리는 것이 규칙이 되게 합니다.

    그런데 그 판은 **파이썬만** 걷고, **하드코딩한 두 파일**만 읽고,
    **「와 같은 값」이라는 한 가지 표현**만 찾았습니다. 그래서 프런트에
    적힌 「서버 … 와 같아야 한다」 다섯 줄이 통째로 눈 밖이었습니다.

        auth/session.ts   MIN_PASSWORD_LENGTH  ← 표에 없었음
        profile/edit.ts   MAX_BIO              ← 표에 없었음
        project/setup.ts  CODE_LENGTH          ← 표에 없었음
        chat/view.ts      MAX_BODY             ← 주석조차 없이 두 벌

    (재 보니 넷 다 값은 **같았습니다** — 갈라진 것이 아니라 **안 보고 있던
    것**입니다. 그래서 결함 번호는 안 붙였습니다.)

    ## 그래서 이제 손으로 고른 목록이 아니라 **기준**을 잽니다

    ⚠️ 결함 329 의 「**손으로 고른 목록을 그 기준으로 전부 재 보십시오**」
    입니다. 기준은 둘입니다.

    1. 서버와 `@lib` **양쪽에 같은 이름의 숫자 상수**가 있으면 표에 있어야
       한다 — 주석이 있든 없든(`MAX_BODY` 가 그랬습니다)
    2. 어느 쪽이든 주석이 **「같아야/같은 값」**이라고 말하면 표에 있어야
       한다 — **파이썬과 타입스크립트 둘 다** 걷습니다
    """
    import re

    def blanked(source: str) -> str:
        return _blanked(source)

    #: ── 기준 ① 양쪽에 같은 이름의 숫자 상수가 있는가 ──────────────
    def numbers(paths, pattern: str) -> dict[str, list[str]]:
        found: dict[str, list[str]] = {}
        for path in paths:
            if ".test." in path.name or "__pycache__" in str(path):
                continue
            for hit in re.finditer(pattern, blanked(path.read_text(encoding="utf-8")), re.M):
                found.setdefault(hit.group(1), []).append(str(path.relative_to(REPO_ROOT)))
        return found

    server = numbers(
        REPO_ROOT.glob("backend/teamflow/**/*.py"),
        r"^([A-Z][A-Z0-9_]{2,})\s*(?::\s*[\w\[\], ]+)?\s*=\s*-?[0-9][0-9_.]*\s*$",
    )
    lib = numbers(
        REPO_ROOT.glob("frontend/src/lib/**/*.ts"),
        r"^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})"
        r"\s*(?::\s*[\w<>\[\]]+)?\s*=\s*-?[0-9][0-9_.]*\s*;",
    )
    assert server and lib, "상수를 한쪽에서도 못 찾았습니다 — 이 검사가 헛돕니다"

    tabled_back = {name for _, _, name, _, _ in PAIRED_CONSTANTS}
    tabled_front = {name for _, _, _, _, name in PAIRED_CONSTANTS}
    on_both = sorted(set(server) & set(lib))
    assert on_both, "양쪽에 같은 이름인 상수를 하나도 못 찾았습니다 — 자가 낡았습니다"

    missing = [
        f"{name}  (서버 {', '.join(server[name])} ↔ @lib {', '.join(lib[name])})"
        for name in on_both
        if name not in tabled_back or name not in tabled_front
    ]

    #: ── 기준 ② 주석이 「같아야/같은 값」이라고 말하는가 ────────────
    #: ⚠️ **두 언어를 다 걷습니다.** 예전 판은 파이썬만 봤습니다.
    CLAIM = re.compile(r"(?:와|과)\s*같(?:아야|은\s*값)")
    claimed: list[str] = []
    for path in [
        *REPO_ROOT.glob("backend/teamflow/**/*.py"),
        *REPO_ROOT.glob("frontend/src/lib/**/*.ts"),
    ]:
        if ".test." in path.name or "__pycache__" in str(path):
            continue
        source = path.read_text(encoding="utf-8")
        for line_no, line in enumerate(source.splitlines(), 1):
            if not CLAIM.search(line):
                continue
            #: 그 주석이 **가리키는 상수 이름**만 셉니다. 이름이 안 적힌
            #: 문장(「규칙은 서버와 같아야 합니다」)은 상수가 아니라 규칙이라
            #: 표의 대상이 아닙니다 — 세면 거짓 양성만 납니다.
            for name in re.findall(r"[A-Z][A-Z0-9_]{2,}", line):
                if name in tabled_back or name in tabled_front:
                    continue
                if name in server or name in lib:
                    rel = path.relative_to(REPO_ROOT)
                    claimed.append(f"{name}  ({rel}:{line_no})")

    problems = sorted(set(missing) | set(claimed))
    assert not problems, (
        "서버와 화면에 같은 숫자가 두 벌 있는데 `PAIRED_CONSTANTS` 에 없습니다.\n"
        "  갈라지면 오류 없이 숫자만 어긋납니다 — 표에 넣으세요:\n  "
        + "\n  ".join(problems)
    )


def test_status_columns_are_compared_against_their_own_vocabulary():
    """⭐ 상태 칸을 **자기 어휘**로만 재는가 (결함 381).

    ## ⛔ 달력이 프로젝트를 **업무의 말**로 쟀습니다

    `calendar_service.collect` 안에서 예순네 줄 차이로 이렇게 있었습니다.

        done = task.status == "done"           ← 업무. 맞습니다
        done = project.status == "done"        ← 프로젝트. **그런 값이 없습니다**

    `"done"` 은 `TaskStatus.DONE` 이고, `projects.status` 의 값이 아닙니다.
    같은 칸을 읽는 다른 자리는 `"finished"` 를 봅니다
    (`tasks/maintenance.py`) — **한 칸에 두 어휘**였고, 쓰는 코드가
    0곳이라 둘 다 영원히 거짓이었습니다.

    ⚠️ **낱말이 아니라 요구를 잽니다.** 「`"done"` 을 쓰지 마라」가 아니라
    **「상태 칸을 날 글자와 비교하지 마라」**입니다 — 그래야 다음 사람이
    `"complete"` 라고 적어도 잡힙니다(결함 295 의 「막는 길을 하나만 막은
    것」).
    """
    import re

    #: 어휘가 있는 상태 칸. `(모델 속성, 어휘 이름)`.
    STATUS_COLUMNS = {
        "project.status": "ProjectStatus",
        "task.status": "TaskStatus",
        "meeting.status": "MeetingStatus",
    }

    offenders: list[str] = []
    for path in sorted(REPO_ROOT.glob("backend/teamflow/**/*.py")):
        if "__pycache__" in str(path):
            continue
        code = _blanked(path.read_text(encoding="utf-8"))
        for attr, vocab_name in STATUS_COLUMNS.items():
            #: `project.status == "…"` · `Project.status == "…"` 둘 다.
            noun = attr.split(".")[0]
            pattern = re.compile(
                rf"\b[A-Za-z_.]*{noun}\.status\s*(?:==|!=)\s*(['\"])([^'\"]*)\1",
                re.IGNORECASE,
            )
            for hit in pattern.finditer(code):
                line = code[: hit.start()].count(chr(10)) + 1
                offenders.append(
                    f"{path.relative_to(REPO_ROOT)}:{line}  {noun}.status == "
                    f"{hit.group(1)}{hit.group(2)}{hit.group(1)}"
                    f"  → `vocab.{vocab_name}` 을 쓰세요"
                )

    assert not offenders, (
        "상태 칸을 **날 글자**와 비교하고 있습니다. 어휘가 아닌 값을 적으면 "
        "오류 없이 영원히 거짓이 됩니다 — 달력이 프로젝트를 업무의 말로 재고 "
        "있었습니다(결함 381):\n  " + "\n  ".join(offenders)
    )


#: 행을 **만드는 코드가 0곳**인 표. `(모델, 왜 비어 있나 · 무엇이 딸려 죽나)`.
#:
#: ⚠️ 이 표는 **손으로 고른 목록이 아닙니다** — 아래 검사가 모델 전수를
#: 세어 이 표와 **똑같은지** 봅니다. 새로 생기면 빨개지고, 채우기
#: 시작해도 빨개집니다(결함 306 의 「예외가 낡는 것도 재라」).
TABLES_NOBODY_FILLS: dict[str, str] = {
    "TaskDependency": (
        "선행/후행 관계를 넣는 라우트·화면·씨앗이 0곳. `blocked_by_late`"
        "(ANALYTICS-005)가 이 표만 보므로 그 신호는 **언제나 `None`** 입니다"
        " — `docs/20` 은 오래도록 ✅ 였습니다 (결함 382)."
    ),
    "PeerReview": (
        "동료평가를 제출하는 길이 0곳. 신뢰도의 `peer_completion` 은 분모가"
        " 0이면 **계산에서 빠지도록** 설계돼 있어(`compute_confidence`) 조용히"
        " 틀리지 않습니다. `docs/20` 에 ✅ 로 주장하는 줄도 없습니다."
    ),
    "ScoringProfileRow": (
        "가중치 프로파일을 행으로 저장하는 길이 0곳 — 지금은 코드의 "
        "`profiles.Role` 이 그 일을 합니다. 주장하는 ✅ 줄이 없습니다."
    ),
    "Voiceprint": (
        "성문을 만드는 코드가 0곳. `docs/07` §2.3 이 「멀티트랙이면 애초에 "
        "불필요」라고 적어 둔 **기록된 결정**입니다 — `db/vocab.py` 도 같은 "
        "말을 합니다."
    ),
}


def test_tables_nobody_fills_are_written_down_and_not_claimed_done():
    """⭐ **행을 만드는 코드가 0곳인 표**를 적어 두고, ✅ 로 주장하지 않는다.

    ## ⛔ 대조표가 ✅ 라고 했는데 입력이 영영 안 들어옵니다 (결함 382)

    `ANALYTICS-005 선행 지연 병목` 이 ✅ 였습니다. 계산은 멀쩡히 있습니다 —
    `find_blocked_by_late(tasks, edges, …)`. 그런데 `edges` 는

        select(m.TaskDependency.predecessor_id, m.TaskDependency.successor_id)

    하나에서만 오고, `TaskDependency(` 를 **만드는 코드가 저장소 전체에
    0곳**입니다(라우트·화면·씨앗 전부). 그래서 `blocked` 는 언제나 비고
    함수는 **언제나 `None`** 입니다.

    결함 377 이 `CHANNEL-005` 에서 겪은 것과 같은 모양인데, 그때는
    「서버는 있고 화면이 없다」였고 이번은 **「입력이 아예 안 들어온다」**
    입니다.

    ⚠️ **손으로 고른 목록이 아니라 기준으로 셉니다** (결함 329). 모델
    전수에서 「만드는 코드가 0곳」인 것을 찾아 위 표와 대조하므로,
    새 표가 생겨도 · 표가 채워지기 시작해도 빨개집니다.
    """
    import re

    models_src = _blanked(
        (REPO_ROOT / "backend" / "teamflow" / "db" / "models.py").read_text(encoding="utf-8")
    )
    classes = re.findall(r"class\s+([A-Z]\w+)\(Base\)", models_src)
    assert len(classes) > 20, f"모델을 {len(classes)}개밖에 못 찾았습니다 — 가드가 헛돕니다"

    sources: list[tuple[str, str]] = []
    for path in [
        *REPO_ROOT.glob("backend/teamflow/**/*.py"),
        *REPO_ROOT.glob("scripts/*.py"),
    ]:
        if "__pycache__" in str(path) or path.name == "models.py":
            continue
        sources.append((str(path), _blanked(path.read_text(encoding="utf-8"))))

    empty = set()
    for name in classes:
        #: `m.Voiceprint(` 도 `Voiceprint(` 도 만드는 것입니다. 선언은
        #: `models.py` 를 아예 빼서 셈에서 제외했습니다.
        rx = re.compile(rf"(?<![A-Za-z_])(?:m\.)?{name}\(")
        if not any(rx.search(code) for _, code in sources):
            empty.add(name)

    written = set(TABLES_NOBODY_FILLS)
    assert empty == written, (
        "「행을 만드는 코드가 0곳인 표」 목록이 실제와 다릅니다.\n"
        f"  새로 생김: {sorted(empty - written) or '없음'}\n"
        f"  이제 채워짐(표에서 빼세요): {sorted(written - empty) or '없음'}"
    )

    #: 그런 표에 기대는 요구는 **✅ 로 주장하면 안 됩니다.**
    doc = (REPO_ROOT / "docs" / "20-요구사항-대조.md").read_text(encoding="utf-8")
    lying = []
    for model, reason in TABLES_NOBODY_FILLS.items():
        for req in re.findall(r"\b([A-Z]{3,}-\d{3})\b", reason):
            for line in doc.splitlines():
                if line.startswith(f"| {req} ") and re.search(r"\|\s*✅\s*\|", line):
                    lying.append(f"{req} — {model} 은 아무도 안 채우는데 ✅ 입니다")
    assert not lying, (
        "입력이 영영 안 들어오는 요구를 `docs/20` 이 ✅ 라고 합니다 "
        "(결함 382):\n  " + "\n  ".join(lying)
    )


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

    ⚠️⚠️ **이 검사가 116번에서 눈을 감고 있었습니다** (결함 139). 세는 방법이
    `&#34;결함 N&#34;` 이라는 **문구**를 찾는 것이었는데, 123번부터 제목 모양이
    `## N. 무엇무엇` 으로 바뀌면서 그 문구가 사라졌습니다. 머리말이
    `34~116번` 이라고 적혀 있으니 범위 밖은 애초에 안 셌고, 그래서 스무
    개가 더 붙는 동안 **통과만 하고 있었습니다.** 요구가 아니라 **찾는
    자리**가 낡은 것이고, `AGENTS.md` 가 경고하는 바로 그 부류입니다.

    ⚠️⚠️⚠️ 그런데 제목 모양만 고쳤더니 **여전히 통과했습니다.** 진짜 원인은
    아래 `above`/`ours` 주석에 있는 셋째였습니다 — 위쪽을 자른 뒤에
    최댓값을 보고 있어서 그 단언이 **언제나 참**이었습니다. 고쳤다고 적어
    둔 뒤에 심어 보고 알았습니다. **자를 고치고 나서도 다시 재야 합니다.**
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
    # 제목 두 모양 — `### ⭐ 결함 120 — …` 과 `## 123. …`
    for head in re.finditer(r"^#{2,4}\s+(?:⭐\s*)?(?:결함\s+)?(\d+)[.\s—]", doc, re.M):
        found.add(int(head.group(1)))
    for run in re.finditer(r"결함\s+([\d~·,\s]+)", doc):
        for part in re.split(r"[·,\s]+", run.group(1).strip()):
            if "~" in part:
                a, _, b = part.partition("~")
                if a.isdigit() and b.isdigit():
                    found.update(range(int(a), int(b) + 1))
            elif part.isdigit():
                found.add(int(part))

    # ⚠️ 위쪽을 **자르지 않습니다.** `n <= high` 로 걸러 놓고 그 안에서
    #    최댓값을 보면 "머리말보다 큰 번호" 는 구조적으로 못 봅니다 —
    #    아래 `max` 단언이 언제나 참이 되어 결함 하나를 더 적어도 조용히
    #    통과합니다. 실제로 그렇게 통과하는 것을 심어서 확인했습니다.
    above = {n for n in found if n >= low}
    ours = {n for n in above if n <= high}
    holes = sorted(set(range(low, high + 1)) - ours)

    assert holes == [gap], (
        f"문서가 {gap}번만 비었다고 하는데 실제로 빈 번호는 {holes} 입니다"
    )
    assert len(ours) == claimed, (
        f"문서는 {claimed}건이라고 하는데 실제로 적힌 결함은 {len(ours)}건입니다 "
        f"({low}~{high})"
    )
    assert max(above) == high, (
        f"가장 큰 결함 번호는 {max(above)} 인데 머리말은 {high} 입니다"
    )


def test_agents_md_names_the_react_screens_that_actually_exist():
    """⭐ `AGENTS.md` 가 세는 React 화면 목록이 **실제와 맞는가**.

    이 목록은 "어느 화면에 어떤 규칙이 걸리는가" 를 정하는 자리라 낡으면
    바로 잘못된 안내가 됩니다. 실제로 **일곱이라고 적힌 채 열셋**이
    되어 있었습니다 — `reports`·`chat`·`calendar`·`notifications`·
    `activity`·`search` 여섯이 그 뒤에 붙었는데 목록은 그대로였습니다.

    `docs/17` 건수·README 표 건수와 같은 부류입니다. **사람이 세어서 적는
    숫자는 반드시 낡습니다.**

    ⚠️ 세는 자리를 `src/demo/*.tsx` **개수**로 잡으면 안 됩니다 —
    `parts.tsx`·`evidence.tsx` 처럼 화면이 아닌 조각이 섞입니다. 화면인지
    아닌지는 **`public/` 에 같은 이름의 `.html` 이 있는가**로 정해집니다.
    """
    import re

    screens = {p.stem for p in (REPO_ROOT / "frontend" / "public").glob("*.html")}
    react = {
        s for s in screens if (REPO_ROOT / "frontend" / "src" / "demo" / f"{s}.tsx").exists()
    }

    agents = (REPO_ROOT / "AGENTS.md").read_text()
    section = agents.partition("### React 로 옮긴 화면")[2].partition("###")[0]
    assert section, "AGENTS.md 에서 'React 로 옮긴 화면' 절을 못 찾았습니다"

    named = set(re.findall(r"`([a-z]+)`", section.partition("React 입니다")[0]))

    assert named == react, (
        f"AGENTS.md 가 적은 React 화면과 실제가 다릅니다. "
        f"안 적힌 것: {sorted(react - named)} · 없는데 적힌 것: {sorted(named - react)}"
    )

    counted = re.search(r"React 입니다 \((\S+?)\)", section)
    assert counted, "'React 입니다 (…)' 에서 개수를 못 찾았습니다"
    KOREAN = {
        7: "일곱", 8: "여덟", 9: "아홉", 10: "열", 11: "열하나", 12: "열둘",
        13: "열셋", 14: "열넷", 15: "열다섯", 16: "열여섯", 17: "열일곱",
    }
    assert counted.group(1) == KOREAN.get(len(react)), (
        f"AGENTS.md 는 '{counted.group(1)}' 이라는데 실제 React 화면은 "
        f"{len(react)}개입니다"
    )


def test_the_requirements_summary_lists_every_section_once():
    """⭐ `docs/20` 의 "한눈에" 표가 **스스로와 안 어긋나는가** (결함 137).

    이 표는 요구 영역마다 한 줄씩 ✅/🟡/❌ 를 답합니다. 그런데 요구를
    하나 채우고 나서 줄을 **고치는 대신 새로 끼워 넣으면** 같은 영역이 두
    줄이 되고, 두 줄이 서로 다른 답을 합니다. 실제로 §21 활동 기록이
    ✅ 와 🟡 로 **동시에** 적혀 있었습니다 — 이 저장소의 대표 실패 ②
    (두 벌이 있으면 한쪽만 고쳐진다)가 표 하나 안에서 일어난 것입니다.

    ⚠️ **번호 순서까지 봅니다.** 끼워 넣기가 잘못된 자리에서 일어나는 것이
    원인이라, 순서가 어긋나는 것 자체가 그 사고의 신호입니다. 실제로 그
    ✅ 줄은 §18 과 §19 사이에 있었습니다.

    그리고 표가 **아래 상세와 같은 영역을 다루는지**도 봅니다. 상세에만
    있고 표에 없으면 "한눈에" 가 한눈에 안 보여 주는 것입니다 — §25
    비기능이 그렇게 빠져 있었습니다.
    """
    import re

    doc = (REPO_ROOT / "docs" / "20-요구사항-대조.md").read_text()

    summary = re.findall(r"^\|\s*§(\d+)\s[^|]*\|[^|]*\|[^|]*\|\s*$", doc, re.MULTILINE)
    listed = [int(n) for n in summary]
    assert listed, "docs/20 에서 '한눈에' 표를 못 찾았습니다"

    duplicates = sorted({n for n in listed if listed.count(n) > 1})
    assert duplicates == [], (
        f"'한눈에' 표에 §{duplicates} 가 두 줄 이상 있습니다 — "
        "줄을 새로 끼우지 말고 있던 줄을 고치십시오"
    )
    assert listed == sorted(listed), (
        f"'한눈에' 표의 번호가 순서대로가 아닙니다: {listed}"
    )

    # 상세는 `### §16 일정 관리 · §19 알림 · §20 검색` 처럼 여럿을 묶습니다.
    detailed: set[int] = set()
    for heading in re.findall(r"^###\s+(.*)$", doc, re.MULTILINE):
        detailed.update(int(n) for n in re.findall(r"§(\d+)", heading))

    missing = sorted(detailed - set(listed))
    assert missing == [], (
        f"§{missing} 는 상세에는 있는데 '한눈에' 표에 없습니다"
    )


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
    # ⚠️ **`.tsx` 도 걷습니다** (결함 334). 예전에는 `*.ts` 만 훑어서
    #    **화면 파일이 통째로 감시 밖**이었습니다 — AGENTS.md 가
    #    「화면 파일을 세는 곳이 `.ts` 로 하드코딩돼 `.tsx` 를 못 본 것」
    #    이라고 적어 둔 그 함정이고, 실제로 레거시 기여도 화면이 그 구멍으로
    #    브라우저 달력을 쓰고 있었습니다. 심어서 확인했습니다: 옛 자로는
    #    `.tsx` 에 심어도 **0건**이었습니다.
    for path in sorted([*root.rglob("*.ts"), *root.rglob("*.tsx")]):
        rel = path.relative_to(REPO_ROOT / "frontend").as_posix()
        if rel in allowed or rel.endswith(".test.ts") or rel.endswith(".test.tsx"):
            continue
        source = path.read_text()
        for number, line in enumerate(source.splitlines(), 1):
            # ⚠️ **낱말이 아니라 요구를 잽니다** (결함 295·334). 예전에는
            #    `getMonth()` 류만 막았는데, 브라우저 달력으로 가는 길은
            #    하나가 아닙니다 — `toLocaleString()` 을 **시간대 없이**
            #    부르면 똑같이 보는 사람의 달력이 됩니다. 실제로 그 길로
            #    두 곳이 새고 있었습니다(`lib/contribution/final.ts` 는
            #    **두 뿌리가 같이 쓰는** 자리였습니다).
            #
            #    `timeZone` 을 명시한 호출은 통과시킵니다 — 그건 팀 달력을
            #    직접 지정한 것이고, `calendar.ts` 자신이 그렇게 합니다.
            by_hand = re.search(r"\.getMonth\(\)|\.getDate\(\)|\.getFullYear\(\)", line)
            loose_locale = (
                re.search(r"\.toLocale(?:Date|Time)?String\(", line)
                and "timeZone" not in line
            )
            if by_hand or loose_locale:
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


# ══════════════════════════════════════════════════════════════
# 문서가 코드보다 뒤처지는 두 자리 (2026-08-10)
# ══════════════════════════════════════════════════════════════


def test_no_document_resurrects_the_call_claim_that_was_already_corrected():
    """⭐ **한 번 정정한 문장을 되살리지 않는다.**

    `docs/15` 에 &#34;실제로 통화해 본 적이 없습니다&#34; 라고 적혀 있었고,
    `1597509` 에서 **과장이 아니라 반대 방향의 오류**로 정정했습니다 —
    같은 기기 안에서는 host 후보로 직접 붙고, 3인 통화를 실제로 확인했습니다.
    `docs/17` 이 그때 이렇게 적어 뒀습니다.

        못 하는 것을 못 한다고 적는 건 정직이지만, **할 수 있는 것을
        못 한다고 적는 건 그냥 틀린 것**이고 그 문장을 믿으면 아무도
        확인을 안 하게 됩니다.

    ⚠️ 그런데 `docs/18` 을 쓰면서 **그 문장을 다시 썼습니다.** 정정 기록이
    저장소 안에 있는데도 그랬습니다. 기록은 사람을 못 막습니다 — 검사가
    막아야 합니다.
    """
    import re

    banned = re.compile(r"실제로 통화해\s*본 적이\s*없|여럿이 실제로 통화해\s*본 적은\s*없")
    offenders: list[str] = []
    for path in [*sorted(REPO_ROOT.glob("docs/*.md")), REPO_ROOT / "README.md"]:
        for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if not banned.search(line):
                continue
            # 정정 **기록** 자체는 그 문장을 인용해야 합니다. 인용은 통과.
            if "정정" in line or "틀렸" in line or "되살" in line or "예전" in line:
                continue
            offenders.append(f"{path.name}:{i}")

    assert offenders == [], (
        "이미 정정된 통화 문장이 되살아났습니다: "
        + " | ".join(offenders)
        + ". 확인된 것은 **같은 기기 안 3인 통화**이고, 확인 못 한 것은 서로 다른 "
        "NAT 뒤·대칭 NAT(TURN)·가정용 업로드에서 5명입니다 (docs/17 §C)."
    )


def test_no_document_makes_the_bundle_a_required_setup_step():
    """⭐ **번들은 일부러 커밋돼 있다.** 만들라고 안내하면 오히려 막힌다.

    `.gitignore` 가 이유를 적어 뒀습니다 — 프런트에 런타임 의존성이 0개이고
    &#34;설치 없이 연다&#34; 가 시연 경로의 전제라, Node 없이도 화면이 떠야 합니다.

    ⚠️ 그런데 `docs/18` 의 설치 절차가 `npm install` 과 `build:demo` 를
    **필수 단계로** 적고 &#34;건너뛰면 빈 화면&#34; 이라고까지 했습니다. 네트워크가
    없는 평가용 PC 에서 그대로 따라 하면 **거기서 멈춥니다.**
    """
    tracked = {p for p in _tracked() if str(p).startswith("frontend/public/") and p.suffix == ".js"}
    if not tracked:
        pytest.skip("번들이 커밋돼 있지 않습니다 — 이 검사의 전제가 사라졌습니다")

    banned = ("건너뛰면 화면이 스크립트를 못 받아", "번들을 만들지 않으면 빈 화면")
    offenders: list[str] = []
    for path in [*sorted(REPO_ROOT.glob("docs/*.md")), REPO_ROOT / "README.md"]:
        text = path.read_text(encoding="utf-8")
        for phrase in banned:
            if phrase in text and "틀렸습니다" not in text:
                offenders.append(f"{path.name} «{phrase}»")

    assert offenders == [], (
        "번들이 커밋돼 있는데 문서가 만들라고 요구합니다: "
        + " | ".join(offenders)
        + ". 소스를 고쳤을 때만 다시 만들면 됩니다."
    )


def test_the_kanban_css_column_count_matches_the_statuses():
    """⭐ 칸반 CSS 의 열 수가 서버의 상태 수와 같은가.

    ## ⚠️ 왜 CSS 에 숫자를 박았는가

    처음에는 `repeat(3, 1fr)` 이었고, `TASK-004` 로 넷째 열이 생기자
    **`완료` 가 아랫줄로 내려가 `할 일` 밑에 붙었습니다.** 칸반은 왼쪽에서
    오른쪽으로 가는 판이라 그 순간 뜻이 통째로 깨집니다.

    `repeat(auto-fit, minmax(...))` 로 바꿔 봤지만 폭에 따라 **셋이 서고
    완료 하나만 떨어지는** 모양이 남았습니다(1024px·900px 에서 실측).
    고아가 생기는 것은 같은 결함입니다.

    그래서 넷/둘/하나로 못 박았고, **그 대신 이 검사를 답니다** — 상태가
    다섯이 되면 여기서 터져서 CSS 를 같이 고치라고 알려 줍니다.
    """
    import re

    from teamflow.services import task_service

    css = (REPO_ROOT / "frontend" / "public" / "kanban.html").read_text(encoding="utf-8")
    widest = re.findall(r"grid-template-columns:\s*repeat\((\d+),", css)
    assert widest, "칸반 CSS 에서 열 수를 못 찾았습니다 — 정규식이 낡았습니다"

    biggest = max(int(n) for n in widest)
    assert biggest == len(task_service.STATUSES), (
        f"CSS 는 열을 최대 {biggest}개로 세우는데 상태는 "
        f"{len(task_service.STATUSES)}개입니다 — `frontend/public/kanban.html` 의 "
        "`#board` 규칙을 고치십시오. 안 고치면 마지막 열이 아랫줄로 떨어져 "
        "`완료` 가 `할 일` 밑에 붙습니다"
    )


def test_every_place_that_reads_tasks_goes_through_live():
    """⭐ 지운 업무를 **한 곳에서만** 걸러 냅니다 (`TASK-003`).

    업무를 읽는 곳이 일곱입니다 — 칸반·달력·검색·알림·위험 신호·회의
    업무 후보·PR 연결. 각자 `deleted_at IS NULL` 을 적게 두면 그중 하나는
    반드시 빠지고, **빠진 곳에서 지운 업무가 되살아납니다.**

    되살아난 자리가 조용한 것이 문제입니다. 오류가 안 나고 달력에만,
    진행률에만 남습니다 — 이 저장소의 대표 실패 ② 가 정확히 이 모양이고,
    그래서 세는 자리를 여기 둡니다.

    ⚠️ **이름이 아니라 쓰임을 셉니다.** `m.Task` 를 질의에 넣는 파일이
    `db/live.py` 를 안 가져오면 잡습니다.
    """
    import re

    root = REPO_ROOT / "backend" / "teamflow"
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        if path.name == "live.py":
            continue
        body = path.read_text(encoding="utf-8")
        # `select(m.Task)` · `select(m.Task, ...)` · `select(m.Task.id)` 처럼
        # **업무 표를 고르는** 질의만 봅니다. `m.TaskGithubLink` 같은 다른
        # 표는 대상이 아닙니다 — `\b` 로 끊습니다.
        if not re.search(r"select\(\s*m\.Task\b(?!\w)", body):
            continue
        if "from teamflow.db import live" in body or "db import live" in body:
            continue
        offenders.append(str(path.relative_to(REPO_ROOT)))

    assert not offenders, (
        f"업무를 읽으면서 `db/live.py` 를 안 거치는 곳: {offenders} — "
        "`live_tasks()`·`live_task_ids()`·`not_deleted()` 중 하나를 쓰십시오. "
        "직접 조건을 적으면 다음 사람이 빠뜨립니다"
    )


def test_every_place_that_asks_who_owns_a_task_goes_through_assignees():
    """⭐ 담당자를 묻는 자리를 **한 곳으로** 모읍니다 (`TASK-006`).

    담당자는 `tasks.assignee_id` 한 칸이었고, 여럿을 받으면서 표가
    됐습니다(`task_assignees`). 그러면서 "이 업무는 누구 것인가" 를 묻는
    코드가 아홉 군데로 흩어질 수 있게 됐습니다 — 칸반·달력·검색·알림·
    PR 연결·위험 신호·승인·기여 이벤트·지켜진 약속.

    각자 `select(TaskAssignee.user_id)` 를 적으면 그중 하나는 다르게
    적히고, **다르게 적힌 곳이 조용히 틀립니다.** 담당자는 기여 이벤트가
    누구에게 가는지를 정하므로, 갈라지면 점수가 갈라집니다.

    `db/live.py` 를 지키는 검사와 같은 판단이고 같은 이유입니다.

    ⚠️ **이름이 아니라 쓰임을 셉니다.** 표를 질의에 넣는 파일이
    `db/assignees.py` 를 안 가져오면 잡습니다.
    """
    import re

    root = REPO_ROOT / "backend" / "teamflow"
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        if path.name == "assignees.py":
            continue
        body = path.read_text(encoding="utf-8")
        if not re.search(r"\bm\.TaskAssignee\b", body):
            continue
        if "from teamflow.db import assignees" in body or "db import assignees" in body:
            continue
        offenders.append(str(path.relative_to(REPO_ROOT)))

    assert not offenders, (
        f"담당자 표를 직접 만지면서 `db/assignees.py` 를 안 거치는 곳: {offenders} — "
        "`of_task()`·`of_tasks()`·`task_ids_of()`·`replace()` 를 쓰십시오"
    )


def test_the_assignee_column_did_not_come_back():
    """⚠️ `tasks.assignee_id` 가 **돌아오면 안 됩니다.**

    "대표 담당자는 칸에, 나머지는 표에" 가 제일 손이 덜 가는 길이고, 그래서
    다음 사람이 반드시 그 유혹을 받습니다. 그건 같은 사실을 두 벌로 두는
    것이고, 담당자는 기여 이벤트가 갈 사람을 정하므로 두 벌이 갈라지면
    **점수가 갈라집니다** (대표 실패 ②).
    """
    from teamflow.db import models as models_mod

    columns = set(models_mod.Task.__table__.columns.keys())
    assert "assignee_id" not in columns, (
        "`tasks.assignee_id` 가 돌아왔습니다 — 담당자는 `task_assignees` 표 "
        "하나에만 있어야 합니다 (`TASK-006`)"
    )
    assert "task_assignees" in models_mod.Base.metadata.tables


def test_the_share_is_never_written_to_a_row():
    """⭐ 나눈 몫을 **저장하면 안 됩니다** (`TASK-006`).

    완료 시점에 `share` 를 메타데이터에 적어 두면, 담당자가 나중에 늘어도
    먼저 있던 사람의 몫이 안 줄어듭니다. 이 저장소가 여덟 번째로 같은
    판단을 하는 자리입니다 — 파생값은 **읽을 때** 만듭니다.

    ⚠️ 읽는 자리(`scoring_service.load_events`)는 예외입니다. 거기가 바로
    "읽을 때 다시 센다" 를 하는 곳입니다.
    """
    import re

    root = REPO_ROOT / "backend" / "teamflow"
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        if path.name in ("scoring_service.py", "sharing.py", "scoring.py"):
            continue
        body = path.read_text(encoding="utf-8")
        # 메타데이터 사전에 `share` 키를 적는 모양만 봅니다.
        if re.search(r"[\"']share[\"']\s*:", body):
            offenders.append(str(path.relative_to(REPO_ROOT)))

    assert not offenders, (
        f"`share` 를 행에 적는 곳이 생겼습니다: {offenders} — 몫은 "
        "`scoring_service.load_events` 가 읽을 때 셉니다"
    )


def test_the_readme_numbers_are_not_stale():
    """⭐ README 가 손으로 적은 개수를 **다시 셉니다.**

    이 저장소는 문서가 사실과 다른 곳을 열세 군데 발견했고, 그중 여럿이
    "처음 적을 때는 맞았는데 코드가 움직인 뒤로 아무도 안 고친" 것입니다.
    README 는 **제일 먼저 읽는 문서**라 틀리면 제일 오래 갑니다.

    ⚠️ 실제로 낡아 있었습니다 — 발언 라벨을 여덟이라고 적어 뒀는데
    열셋이었고, 결함 기록을 `여든하나` 라고 부르는데 백스물다섯이었습니다.

    ⚠️ **여기서 세는 것은 기계로 확인 가능한 것뿐입니다.** "화면이
    예쁜가" 같은 것까지 재는 척하면 이 검사가 거짓말을 하게 됩니다.
    """
    import re

    from teamflow.db import models as models_mod
    from teamflow.db import vocab

    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

    labels = len(vocab.UTTERANCE_LABEL)
    assert f"{labels}라벨" in readme, (
        f"발언 유형이 {labels}개인데 README 가 그렇게 안 적혀 있습니다"
    )

    tables = len(models_mod.Base.metadata.tables)
    assert f"{tables}개 테이블" in readme, (
        f"표가 {tables}개인데 README 가 그렇게 안 적혀 있습니다"
    )

    # `docs/17` 이 스스로 밝힌 건수와 README 가 부르는 이름이 맞는가.
    defects = (REPO_ROOT / "docs" / "17-결함-기록.md").read_text(encoding="utf-8")
    claimed = re.search(r"번호가 붙은 항목 \*\*(\d+)건\*\*", defects)
    assert claimed is not None, "`docs/17` 머리말에서 건수를 못 찾았습니다"
    assert f"결함 **{claimed.group(1)}건**" in readme, (
        f"`docs/17` 은 {claimed.group(1)}건이라는데 README 가 다르게 부릅니다"
    )

    # 얼마나 만들어졌나에 답하는 문서를 README 가 가리키는가.
    assert "docs/20-요구사항-대조.md" in readme, (
        "`docs/20` 이 README 문서 표에 없습니다 — 얼마나 만들어졌나에 "
        "답하는 문서인데 찾을 방법이 없습니다"
    )


# ══════════════════════════════════════════════════════════════════
# 문서가 손으로 센 숫자 — 2026-08-13 전수 조사에서 71건이 나왔습니다
#
# 그중 **다시 낡을 것**만 여기서 잽니다. 한 번 고치고 마는 것은 가드를
# 달 값이 없고, 반대로 화면·테스트 개수처럼 **코드가 움직일 때마다
# 틀려지는 것**은 사람이 절대 못 따라갑니다.
# ══════════════════════════════════════════════════════════════════

_LIVE_DOCS = ("README.md", "AGENTS.md", *(f"docs/{n}" for n in ()))
"""살아 있는 문서 = 지금을 주장하는 문서.

⚠️ 여기에 `docs/14`·`docs/16` 을 넣지 마십시오. 그 둘은 머리말로 **시점을
못 박은 보존 문서**라 옛 값이 맞는 기록입니다. 넣으면 이 저장소가 지키는
원칙("계획을 덮어쓰지 않는다")을 가드가 깨뜨립니다.
"""


def _korean_number(n: int) -> str:
    """세는 수사. 문서가 `열여섯 장` 처럼 한글로 적습니다."""
    words = {
        1: "하나", 2: "둘", 3: "셋", 4: "넷", 5: "다섯", 6: "여섯",
        7: "일곱", 8: "여덟", 9: "아홉", 10: "열", 11: "열하나",
        12: "열둘", 13: "열셋", 14: "열넷", 15: "열다섯", 16: "열여섯",
        17: "열일곱", 18: "열여덟", 19: "열아홉", 20: "스물",
    }
    return words[n]


def test_no_live_document_claims_a_stale_screen_count():
    """⭐ 살아 있는 문서가 **화면 개수**를 틀리게 말하지 않는가.

    이번 전수 조사에서 **가장 많이 낡은 자리**였습니다 — README 두 곳,
    `docs/13` 한 곳, `docs/00` 한 곳, `docs/08` 한 곳이 각각 열·열·열·
    일곱·아홉이라고 적혀 있었고 실제는 열여섯이었습니다.

    ⚠️ 세는 자리는 `public/*.html` 입니다. `src/demo/*.tsx` 를 세면
    `parts.tsx` 같은 조각이 섞입니다.

    ⚠️ **`docs/14`·`docs/16` 은 안 봅니다** — 시점을 못 박은 보존 문서라
    옛 값이 맞습니다.
    """
    import re

    screens = len(list((REPO_ROOT / "frontend" / "public").glob("*.html")))
    want = _korean_number(screens)

    # ⚠️ **표지를 「장」 으로 좁힙니다.** 맨 "화면 N 개" 는 이 저장소에서
    #    세 가지 뜻으로 쓰입니다 — 전체 수 · React 로 옮긴 수 · `docs/18`
    #    이 다루는 수. 셋을 한 자로 재면 맞는 문장을 틀렸다고 잡습니다
    #    (실제로 세 곳을 그렇게 잡았습니다). 이 저장소는 **전체 수를 셀
    #    때만 「장」** 을 씁니다 — "화면 열여섯 장".
    NUM = (
        "하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열"
        "|열하나|열둘|열셋|열넷|열다섯|열여섯|열일곱|열여덟|열아홉|스물"
    )
    pattern = re.compile(rf"화면(?:이)? ({NUM}) 장")

    bad = []
    for name in (
        "README.md",
        "docs/13-화면-구조.md",
        "docs/00-이-프로그램은-무엇인가.md",
        "docs/21-데스크톱-셸-Electron.md",
    ):
        text = (REPO_ROOT / name).read_text(encoding="utf-8")
        for line_no, line in enumerate(text.splitlines(), 1):
            for m in pattern.finditer(line):
                if m.group(1) != want:
                    bad.append(f"{name}:{line_no} — '{m.group(0)}' (실제 {screens})")

    assert not bad, (
        "화면 개수를 틀리게 적은 곳이 있습니다:\n  " + "\n  ".join(bad)
    )


def test_no_live_document_claims_a_stale_test_count():
    """⭐ 문서가 `~.test.ts (N개 테스트)` 라고 적은 N 이 **실제와 맞는가**.

    `docs/13` 두 곳(27↔29) · `docs/15` 두 곳(177↔184, 24↔25) ·
    `docs/19` 한 곳(28↔29)이 같은 병이었습니다. 테스트를 하나 더하면
    문서가 조용히 틀려집니다.

    ⚠️ **면제가 필요합니다.** `docs/14`·`docs/16` 은 머리말로 시점을 못
    박았고, 거기 적힌 옛 실측치는 **맞는 기록**입니다.
    """
    import re

    live = [
        p
        for p in (REPO_ROOT / "docs").glob("*.md")
        if p.name.split("-")[0] not in {"14", "16"}
    ]

    # `frontend/src/lib/call/mesh.ts` (25개 테스트)  /  `links.test.ts` (29)
    ref = re.compile(r"`([^`]*?/)?([a-z-]+)(?:\.test)?\.ts` ?\((\d+)(?:개 테스트)?\)")

    def count_tests(stem: str) -> int | None:
        hits = list((REPO_ROOT / "frontend" / "src").rglob(f"{stem}.test.ts"))
        if len(hits) != 1:
            return None
        return len(re.findall(r"^\s*(?:it|test)\(", hits[0].read_text(encoding="utf-8"), re.M))

    bad = []
    for doc in live:
        for line_no, line in enumerate(doc.read_text(encoding="utf-8").splitlines(), 1):
            for m in ref.finditer(line):
                actual = count_tests(m.group(2))
                if actual is not None and actual != int(m.group(3)):
                    bad.append(
                        f"docs/{doc.name}:{line_no} — {m.group(2)} 를 "
                        f"{m.group(3)}개라는데 {actual}개"
                    )

    assert not bad, "테스트 개수가 낡은 곳:\n  " + "\n  ".join(bad)


def test_no_live_document_says_the_android_shell_is_merely_paused():
    """⭐ 안드로이드 셸을 **지웠는데** 문서가 "보류" 라고 말하지 않는가.

    2026-08-13 에 지웠습니다(`android/` 30파일). 그런데 `docs/08`·`docs/15`
    두 곳·`docs/18`·`docs/17` 다섯 곳이 여전히 "보류"·"셸은 있지만" 으로
    적고 있었습니다. **"멈춘 것" 과 "없는 것" 은 다릅니다** — 보류라고
    읽으면 다음 사람이 되살리려고 시간을 씁니다.

    ⚠️ 셸이 **다시 생기면** 이 검사는 스스로 비활성화됩니다. 그때는
    보류라고 적는 것이 맞기 때문입니다.
    """
    if (REPO_ROOT / "android").exists():
        return  # 셸이 있으면 잴 것이 없습니다

    banned = ("안드로이드 셸은 별도", "안드로이드 셸 | **보류", "안드로이드 셸 | 보류")
    bad = []
    for doc in (REPO_ROOT / "docs").glob("*.md"):
        if doc.name.split("-")[0] in {"14", "16"}:
            continue
        for line_no, line in enumerate(doc.read_text(encoding="utf-8").splitlines(), 1):
            if "안드로이드" not in line:
                continue
            if any(b in line for b in banned):
                bad.append(f"docs/{doc.name}:{line_no} — {line.strip()[:70]}")

    assert not bad, (
        "안드로이드 셸을 지웠는데 보류라고 적은 곳:\n  " + "\n  ".join(bad)
    )


def test_no_live_document_names_a_framework_the_project_does_not_have():
    """⭐ 안 쓰는 프레임워크 이름이 **살아 있는 문서**에 남아 있지 않은가.

    `docs/03` 두 곳·`docs/11` 두 곳이 Next.js 를 쓴다고 적고 있었습니다.
    런타임 의존성은 react·react-dom·@radix-ui/react-dialog 셋뿐이고
    번들은 `build.mts` 의 esbuild 입니다.

    ⚠️ **브랜드 표기(`Next.js`)만 봅니다.** 소문자 `next` 로 잡으면
    `next_agenda`·`next.test.ts`·`?next=` 가 전부 걸립니다 — 실제로 그렇게
    짰다가 아홉 곳을 잘못 잡았습니다. 이 저장소가 적어 둔 그대로입니다:
    **잴 구역에는 그 구역만의 이름을 붙이십시오.**

    ⚠️ 면제: `docs/00-제안서-…-검토.md`(구현 이전 권고안) · `docs/16`
    (측정일이 박힌 감사) · `docs/17`(결함 기록 — 과거 서술) ·
    `docs/20`(정의서가 **요구한 것**과 우리가 쓴 것을 나란히 적는 표).
    """
    import json

    pkg = json.loads((REPO_ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    installed = {*pkg.get("dependencies", {}), *pkg.get("devDependencies", {})}

    # 브랜드 표기 → package.json 이름
    BRANDS = {"Next.js": "next", "Zustand": "zustand", "Recharts": "recharts"}
    missing = {brand for brand, pkg_name in BRANDS.items() if pkg_name not in installed}

    exempt_names = {"00-제안서-TeamFlowAI-검토.md"}
    exempt_prefix = {"16", "17", "20"}

    bad = []
    for doc in (REPO_ROOT / "docs").glob("*.md"):
        if doc.name in exempt_names or doc.name.split("-")[0] in exempt_prefix:
            continue
        for line_no, line in enumerate(doc.read_text(encoding="utf-8").splitlines(), 1):
            for brand in missing:
                # 부재를 말하는 줄은 통과 — "Vite 를 안 씁니다" 같은 것.
                if brand in line and not any(
                    k in line
                    for k in ("안 씁니다", "안 넣", "없습니다", "아닙니다", "쓰지 않", "가 아니라")
                ):
                    bad.append(f"docs/{doc.name}:{line_no} — {line.strip()[:70]}")

    assert not bad, (
        "설치하지 않은 프레임워크를 쓴다고 적은 곳:\n  " + "\n  ".join(bad)
    )


def test_the_defect_log_never_reuses_a_measurement_ordinal():
    """⭐ `docs/17` 의 "n번째 자" 순번이 **겹치지 않는가**.

    이 저장소는 "측정 도구가 틀렸다" 를 따로 세고 있고, 그 순번이 지금
    열일곱까지 왔습니다. 실제로 **"열여섯 번째" 가 두 번** 쓰여 있었습니다
    (결함 163 과 170). 순번이 겹치면 몇 번을 당했는지 셀 수 없게 됩니다.
    """
    import re
    from collections import Counter

    text = (REPO_ROOT / "docs" / "17-결함-기록.md").read_text(encoding="utf-8")
    ordinals = re.findall(r"(열[가-힣]*|스물[가-힣]*) 번째(?:로)? (?:자|당한)", text)
    dupes = [o for o, c in Counter(ordinals).items() if c > 1]

    assert not dupes, f"'n번째 자' 순번이 겹칩니다: {dupes}"

def test_api_times_say_which_calendar_they_are_in():
    """⭐ 응답에 나가는 시각은 **시간대를 글자로 말한다** (결함 246).

    저장은 UTC 인데 **SQLite 는 시간대를 안 돌려줍니다.** 그대로 내보내면
    한 API 안에 규약이 둘이 됩니다:

        "started_at": "2026-09-08T10:00:00"      ← 표시 없음
        "computed_at": "2026-08-21T00:10:07Z"    ← 표시 있음

    표시 없는 쪽을 브라우저는 **자기 시간대**로 읽습니다(JS 사양). 그래서
    서울 사람과 뉴욕 사람이 같은 회의를 다른 순간으로 보고, 자정 근처면
    날짜까지 갈라집니다.

    ⚠️ 이 검사는 **찾는 자리가 낡지 않게** 필드를 세지 않고 `datetime` 이
    남아 있는지를 봅니다 — 새 응답 모델이 생기면 그때 걸립니다.
    """
    import re

    source = (REPO_ROOT / "backend" / "teamflow" / "api" / "main.py").read_text()
    # 주석·문서화 문자열은 걷어냅니다 — 이 결함을 **설명하는 글**이 스스로 걸립니다.
    code = re.sub(r'"""[\s\S]*?"""', " ", source)
    code = re.sub(r"^\s*#.*$", " ", code, flags=re.M)

    raw = [m.group(0) for m in re.finditer(r"^    [a-z_]+: datetime\b", code, re.M)]
    assert not raw, (
        "응답 모델에 맨 `datetime` 이 있습니다 — `UtcDatetime` 을 쓰세요. "
        "시간대 없이 나가면 브라우저가 자기 달력으로 읽습니다:\n  "
        + "\n  ".join(x.strip() for x in raw)
    )
    assert "UtcDatetime" in code, "`UtcDatetime` 이 없습니다 — 검사가 헛돕니다"



# ══════════════════════════════════════════════════════════════
# 회의 상태를 **손으로 적지 않는다** (결함 288)
# ══════════════════════════════════════════════════════════════


def test_no_module_compares_a_meeting_status_that_does_not_exist() -> None:
    """⭐ `meeting.status == "..."` 의 오른쪽은 **실재하는 상태**여야 한다.

    보고서가 `x.status == "done"` 으로 「처리된 회의」를 세고 있었습니다.
    `"done"` 은 **업무** 상태(`vocab.TaskStatus.DONE`)이지 회의 상태가
    아니라서, 이 값은 어느 프로젝트에서든 **언제나 0** 이었습니다.

    그리고 0 은 조용하지 않았습니다 — 그 옆의 설명이 이렇게 나갔습니다.

        6건은 아직 처리 전이라 그 회의의 발언은 기여도에 안 들어갔습니다

    같은 제품의 기여도 화면은 그 사람의 회의 근거를 11건이라고 세고
    있었습니다. **팀이 제출하는 문서가 제품 자신의 데이터와 반대되는 말을
    한 것**이고, 오류도 안 나고 테스트도 통과했습니다.

    `MeetingStatus` 는 스스로 「여기가 유일한 출처다」라고 적어 두고
    있었는데, 그 출처를 **안 보고 글자를 적어도** 아무도 안 막았습니다.
    """
    import re

    from teamflow.db.models import MeetingStatus

    known = {s.value for s in MeetingStatus}
    # 이 저장소가 회의 상태 칸에 실제로 쓰는 예외들 — 뜻이 있는 값입니다.
    allowed = known | {"superseded"}

    bad: list[str] = []
    roots = [REPO_ROOT / "backend" / "teamflow", REPO_ROOT / "backend" / "tests"]
    for root in roots:
      for path in root.rglob("*.py"):
          source = path.read_text(encoding="utf-8")
          # 주석·문서문자열의 「나쁜 예」를 물지 않게 걷어냅니다 (AGENTS.md).
          code = re.sub(r'"""[\s\S]*?"""', "", source)
          code = re.sub(r"^\s*#.*$", "", code, flags=re.M)
          for m2 in re.finditer(
              r'\b(?:meeting|x|row|item)\.status\s*(?:==|!=)\s*"([^"]+)"', code
          ):
              if m2.group(1) not in allowed:
                  bad.append(f"{path.relative_to(REPO_ROOT)}: {m2.group(0)}")
          for m2 in re.finditer(
              r'\b(?:meeting|x|row|item)\.status\s+in\s+\{([^}]*)\}', code
          ):
              for lit in re.findall(r'"([^"]+)"', m2.group(1)):
                  if lit not in allowed:
                      bad.append(f"{path.relative_to(REPO_ROOT)}: {lit}")
          # ⚠️ **검사 데이터가 실기와 다른 값을 만들면** 그 검사는 아무것도
          #    안 잽니다. `m.Meeting(... status="done")` 이 바로 그것이었고,
          #    그래서 보고서의 「처리된 회의」가 언제나 0 인데도 초록이었습니다.
          for m2 in re.finditer(r'm\.Meeting\([^)]*?status=("([^"]+)")', code, re.S):
              if m2.group(2) not in allowed:
                  bad.append(f"{path.relative_to(REPO_ROOT)}: m.Meeting(status={m2.group(1)})")

    assert not bad, (
        "회의 상태로 **없는 값**을 비교합니다 — 그 가지는 영원히 안 탑니다:\n  "
        + "\n  ".join(bad)
    )


def test_every_audit_target_kind_has_a_human_name() -> None:
    """⭐ 감사 기록에 **쓰는 종류**와 **읽는 쪽이 아는 종류**가 짝이어야 한다.

    ## 왜 이 검사가 생겼나

    결함 293 에서 활동 기록의 `target` 에 사람 이름을 붙였습니다. 그런데
    **씨앗 데이터에 있던 넷만** 고쳤습니다. 「업무 후보 승인」을 실제로 눌러
    보니 다섯째가 나왔고, 화면은 이렇게 적었습니다 (결함 297):

        업무 후보 승인   김민수   meeting_task_candidates/1

    그 화면은 스스로 「누가 언제 **무엇을** 바꿨는지」라고 말합니다. 종류를
    하나씩 더하는 것으로는 여섯째가 또 나옵니다 — **짝을 재는 자**를 둡니다.

    ⚠️ 「덮는가」만이 아니라 **「맞는 칸인가」**도 봅니다 (결함 289 의 교훈):
    읽는 쪽이 아는데 아무도 안 쓰는 종류가 있으면 그것도 알려 줍니다.
    """
    import re

    from teamflow.services.activity_service import KNOWN_TARGET_KINDS

    written: dict[str, str] = {}
    for pattern in ("backend/teamflow/**/*.py",):
        for path in sorted(REPO_ROOT.glob(pattern)):
            source = path.read_text(encoding="utf-8")
            # 주석·문서문자열의 「나쁜 예」를 물지 않게 걷어냅니다 (AGENTS.md).
            code = re.sub(r'"""[\s\S]*?"""', "", source)
            code = re.sub(r"^\s*#.*$", "", code, flags=re.M)
            for hit in re.finditer(r'target=f?"(?P<kind>[a-z_]+)[/:]\{', code):
                written.setdefault(hit["kind"], str(path.relative_to(REPO_ROOT)))

    assert written, "감사 기록에 target 을 쓰는 곳을 하나도 못 찾았습니다 — 가드가 헛돕니다"

    unnamed = sorted(k for k in written if k not in KNOWN_TARGET_KINDS)
    assert not unnamed, (
        "감사 기록이 이 종류를 식별자 그대로 내보냅니다 — "
        "`activity_service._target_labels` 에 이름을 붙이세요:\n  "
        + "\n  ".join(f"{kind}  ({written[kind]})" for kind in unnamed)
    )

    stale = sorted(KNOWN_TARGET_KINDS - set(written))
    assert not stale, (
        "읽는 쪽이 아는데 **아무도 안 쓰는** 종류입니다 — 낡은 것이거나 "
        "찾는 자리가 틀린 것입니다:\n  " + "\n  ".join(stale)
    )


def test_leaving_a_project_is_written_down_on_both_ways_out() -> None:
    """⭐ 내보내기와 스스로 나가기 **둘 다** 기록을 남겨야 한다 (결함 328).

    ⚠️ 이 저장소에서 제일 흔한 재발 모양은 **한 갈래만 고치는 것**입니다
    (실패 ② · 결함 298→301). 나가는 문은 둘인데 한쪽만 적으면, 스스로
    나간 사람의 역할 비중은 여전히 소리 없이 사라집니다 (결함 327).
    """
    source = (REPO_ROOT / "backend/teamflow/api/main.py").read_text(encoding="utf-8")

    exits = [
        name
        for name in ("def remove_member(", "def leave_project(")
        if name in source
    ]
    assert len(exits) == 2, f"나가는 문을 둘 다 못 찾았습니다: {exits}"

    for name in exits:
        body = source.split(name, 1)[1].split("\n@app.", 1)[0]
        assert "_remember_departure(" in body, (
            f"{name.strip('def (')} 이 나가는 사람의 역할 비중을 안 적습니다 — "
            "적어 두지 않으면 기여도가 조용히 다시 계산됩니다 (결함 327)"
        )


def test_the_activity_log_never_starts_receiving_meetings_or_chat() -> None:
    """⭐ 활동 화면의 빈 상자가 **주장하는 범위**를 서버가 계속 지켜야 한다.

    ## 왜 이 검사가 생겼나

    결함 304 에서 활동 화면이 「아직 아무도 안 바꿨습니다」라고 단언했습니다.
    같은 순간 그 팀에는 회의 다섯 · 업무 카드 넷 · 세 사람의 기여도 근거가
    있었습니다. 고친 문장은 **이 기록이 무엇을 받는지**를 말합니다.

        이 기록에는 사람이 손으로 내린 결정만 쌓입니다 …
        **회의를 열거나 녹음하거나 이야기 나눈 것은 여기 안 남습니다.**

    그 문장은 서버가 **회의를 열 때 감사 기록을 안 쓴다**는 사실 위에 서
    있습니다. 나중에 누가 `meeting_created` 를 감사 기록에 넣으면 화면은
    조용히 거짓말을 시작합니다 — 오류도 안 나고 아무도 안 봅니다.
    (실패 ② — 같은 사실이 두 곳에 있으면 반드시 갈라집니다.)

    ⚠️ 낱말이 아니라 **요구**를 잽니다: 「회의를 여는 것 · 녹음하는 것 ·
    이야기 나누는 것」이 감사 기록의 갈래에 없어야 합니다. 폐기(`revoked`)·
    삭제(`deleted`)·재처리(`reprocess`)는 **사람이 손으로 내린 결정**이라
    화면이 말하는 범위 안이고, 그래서 예외입니다.
    """
    import re

    forbidden = ("created", "started", "recorded", "uploaded", "sent", "posted", "opened")
    allowed_even_though_matching = {
        # 「손으로 내린 결정」이라 화면이 말하는 범위 안입니다.
        "meeting_reprocess_requested",
    }

    actions: dict[str, str] = {}
    for path in sorted(REPO_ROOT.glob("backend/teamflow/**/*.py")):
        source = path.read_text(encoding="utf-8")
        code = re.sub(r'"""[\s\S]*?"""', "", source)
        code = re.sub(r"^\s*#.*$", "", code, flags=re.M)
        for hit in re.finditer(r'action="(?P<name>[a-z_]+)"', code):
            actions.setdefault(hit["name"], str(path.relative_to(REPO_ROOT)))

    assert actions, "감사 기록에 action 을 쓰는 곳을 하나도 못 찾았습니다 — 가드가 헛돕니다"

    leaked = sorted(
        name
        for name in actions
        if name not in allowed_even_though_matching
        and (
            any(name.endswith(f"_{word}") for word in forbidden)
            or name.startswith(("meeting_created", "message_", "chat_", "channel_"))
        )
    )
    assert not leaked, (
        "활동 화면의 빈 상자가 「회의를 열거나 녹음하거나 이야기 나눈 것은 "
        "여기 안 남습니다」라고 말합니다 (결함 304). 이 갈래가 들어오면 그 "
        "문장이 거짓이 됩니다 — `@lib/activity/empty.ts` 를 같이 고치세요:\n  "
        + "\n  ".join(f"{name}  ({actions[name]})" for name in leaked)
    )


def _blanked(source: str) -> str:
    """주석·docstring 을 **같은 길이의 공백**으로 덮는다 — 지우지 않는다.

    ⚠️ 지우면 뒤의 offset 이 전부 밀려 **줄 번호가 틀립니다.** 처음에는
    지웠다가 23줄, 개행만 맞췄다가 3줄 어긋났습니다. 길이를 보존하면
    원본과 offset 이 **정확히** 같습니다.

    ⚠️ `^\\s*#` 으로 주석을 지우지 마십시오 — `\\s` 가 개행을 먹어 **앞줄까지**
    지웁니다.
    """

    def blank(match: re.Match[str]) -> str:
        return "".join("\n" if ch == "\n" else " " for ch in match.group(0))

    code = re.sub(r'"""[\s\S]*?"""', blank, source)
    return re.sub(r"#[^\n]*", blank, code)


def test_the_activity_log_only_carries_decisions_a_person_made() -> None:
    """⭐ 활동 화면이 주장하는 범위의 **나머지 절반**.

    바로 위 `test_the_activity_log_never_starts_receiving_meetings_or_chat`
    은 그 문장의 **뒷부분**만 잽니다 — 「회의를 열거나 녹음하거나 이야기
    나눈 것은 여기 안 남습니다」. 앞부분은 아무도 안 보고 있었습니다.

        **이 기록에는 사람이 손으로 내린 결정만 쌓입니다** — …

    ⚠️ 결함 328 이 적어 둔 「**같은 표의 옆 칸은 따로 재야 합니다**」입니다.

    ## 지금은 참인데, **두 우연** 위에 서 있습니다

    감사 기록을 쓰는 자리는 열다섯이고, 그중 사람이 없는 것(`actor_id=None`)
    은 셋입니다.

        audio_deleted       project_id=None   ← 프로젝트 목록에 안 뜹니다
        audio_deleted       project_id=None   ←   (질의가 project_id 로 거릅니다)
        voiceprint_revoked  project_id=…      ← **뜹니다.** 다만 갈래가 죽어 있습니다

    `voiceprint_revoked` 는 `Voiceprint` 행이 있어야 나는데, **그것을 만드는
    프로덕션 코드가 0곳**입니다(`db/vocab.py` 가 적어 둔 그대로 — 세어서
    확인했습니다). 그래서 화면 문장은 **오늘은** 참입니다.

    ⚠️ 누가 성문을 만들기 시작하면 그 순간 화면이 조용히 거짓말을 합니다 —
    종료된 프로젝트의 활동 기록에 **사람 없는 줄**이 뜹니다
    (`tasks/maintenance.revoke_finished_project_voiceprints_task` 는 Celery
    정기 작업이라 아무도 안 누릅니다). 그래서 **예외가 낡는 것도 같이
    잽니다**(결함 306 의 방법).
    """
    import re

    #: 사람 없이 써도 되는 갈래 — **왜** 괜찮은지와 **언제까지** 괜찮은지.
    ALLOWED_WITHOUT_ACTOR = {
        "voiceprint_revoked": (
            "종료된 프로젝트의 성문 폐기(docs/07 §2.4). 지금은 `Voiceprint` 를 "
            "만드는 프로덕션 코드가 0곳이라 이 줄이 뜰 수 없습니다."
        ),
    }

    sites: list[tuple[str, str, str, str]] = []
    for path in sorted(REPO_ROOT.glob("backend/teamflow/**/*.py")):
        source = path.read_text(encoding="utf-8")
        code = _blanked(source)
        for hit in re.finditer(r"m\.AuditLog\(", code):
            #: ⚠️ 「다음 `)`」로 자르면 중첩 dict(`before=`·`after=`)에서 틀립니다.
            #: 괄호를 세어 블록을 잡습니다.
            i, depth = hit.end(), 1
            while i < len(code) and depth:
                if code[i] == "(":
                    depth += 1
                elif code[i] == ")":
                    depth -= 1
                i += 1
            block = code[hit.end() : i]
            project = re.search(r"project_id\s*=\s*([^,\n]+)", block)
            actor = re.search(r"actor_id\s*=\s*([^,\n]+)", block)
            action = re.search(r'action\s*=\s*"([a-z_]+)"', block)
            sites.append(
                (
                    action.group(1) if action else "(변수)",
                    (project.group(1).strip() if project else "(없음)"),
                    (actor.group(1).strip() if actor else "(없음)"),
                    f"{path.relative_to(REPO_ROOT)}:{code[: hit.start()].count(chr(10)) + 1}",
                )
            )

    assert len(sites) > 10, (
        f"감사 기록을 쓰는 자리를 {len(sites)}곳밖에 못 찾았습니다 — 가드가 헛돕니다"
    )

    #: 프로젝트 활동 목록에 뜨는 줄(= `project_id` 가 있는 줄) 중 사람이 없는 것.
    actorless = [
        (action, where)
        for action, project, actor, where in sites
        if project != "None" and actor == "None"
    ]
    unexpected = [(a, w) for a, w in actorless if a not in ALLOWED_WITHOUT_ACTOR]
    assert not unexpected, (
        "활동 화면이 「이 기록에는 **사람이 손으로 내린 결정만** 쌓입니다」라고 "
        "말합니다. 사람 없이 쓰는 줄이 프로젝트 목록에 뜨면 그 문장이 거짓이 "
        "됩니다 — `@lib/activity/empty.ts` 를 같이 고치거나, 그 줄을 "
        "`project_id=None` 으로 쓰세요:\n  "
        + "\n  ".join(f"{a}  ({w})" for a, w in unexpected)
    )

    #: ⚠️ **예외가 낡는 것도 잽니다** (결함 306). 성문을 만들기 시작하면
    #: 위 예외의 전제가 깨지므로, 그때는 화면 문장을 같이 정해야 합니다.
    makers = []
    for path in sorted(REPO_ROOT.glob("backend/teamflow/**/*.py")):
        source = path.read_text(encoding="utf-8")
        code = _blanked(source)
        #: ⚠️ **자가 두 번 틀렸습니다.**
        #: ① `class Voiceprint(Base)` 라는 **선언**을 만드는 것으로 셌습니다
        #:    (결함 240 의 부류).
        #: ② 그것을 막으려고 `(?<![A-Za-z_.])` 를 달았더니 이번엔 **`.` 를
        #:    막아** 이 저장소가 실제로 쓰는 `m.Voiceprint(` 를 못 봤습니다 —
        #:    심어도 초록이었습니다. 막을 것은 `class` 뿐입니다.
        for hit in re.finditer(r"(?<![A-Za-z_])Voiceprint\(", code):
            before = code[max(0, hit.start() - 20) : hit.start()]
            if before.rstrip().rstrip(".").endswith("class"):
                continue
            if before.endswith("."):
                #: `m.Voiceprint(` · `models.Voiceprint(` 는 만드는 것입니다.
                pass
            makers.append(
                f"{path.relative_to(REPO_ROOT)}:{code[: hit.start()].count(chr(10)) + 1}"
            )
    assert not makers, (
        "성문을 만드는 코드가 생겼습니다. 그러면 종료된 프로젝트에서 "
        "`voiceprint_revoked` 가 **사람 없이** 활동 기록에 뜹니다 — 활동 화면의 "
        "「사람이 손으로 내린 결정만 쌓입니다」를 같이 정하세요:\n  "
        + "\n  ".join(makers)
    )


def test_the_product_description_does_not_promise_hand_made_tasks() -> None:
    """⛔ **사용자가 읽는 문서**가 없는 길을 약속했습니다 (결함 317).

    `docs/00-이-프로그램은-무엇인가.md` 는 비개발자가 제품을 이해하려고
    읽는 문서입니다. 거기 「손으로 만든 업무는 아무 표시가 없습니다」가
    남아 있었습니다 — 결함 313 이 화면에서 고친 그 거짓말인데, **문서는
    안 봤습니다.**

    ⚠️ 가드가 화면만 걷고 문서를 안 걸으면 이 부류는 영영 안 보입니다.
    """
    doc = (
        REPO_ROOT / "docs" / "00-이-프로그램은-무엇인가.md"
    ).read_text(encoding="utf-8")
    found = re.search(r"[^\n]*(직접|손으로|수동으로)\s*만[든들][^\n]*업무[^\n]*", doc)
    assert found is None, (
        f"제품 소개 문서가 없는 길을 약속합니다 — {found.group(0).strip() if found else ''}"
    )


def test_the_chat_screen_actually_pages_backwards() -> None:
    """⛔ **라우트는 불리는데 인자가 안 불렸습니다** (결함 315).

    `message_service.history` 는 `before_id` 를 받도록 만들어져 있고
    「`before_id` 는 **번호**이지 시각이 아닙니다」라는 근거까지 적혀
    있습니다. 그런데 화면은 그 인자를 **한 번도 안 보냈습니다** — 메시지
    60개짜리 채널에서 처음 열 줄이 제품 안에서 영영 안 보였습니다.

    ⚠️ **결함 306 의 라우트 가드는 이걸 못 잡습니다.** 그 라우트는
    불립니다. 안 불린 것은 **인자**입니다.
    """
    chat = (REPO_ROOT / "frontend" / "src" / "demo" / "chat.tsx").read_text(encoding="utf-8")
    assert "before_id=" in chat, (
        "채팅 화면이 `before_id` 를 안 보냅니다 — 앞쪽 대화에 닿을 길이 없습니다"
    )


def test_the_client_page_size_matches_the_server() -> None:
    """⚠️ **짝입니다.** 어긋나면 단추가 영영 안 뜨거나(클라 > 서버) 0개를
    받고도 계속 뜹니다(클라 < 서버). 낱말이 아니라 **값**을 맞춥니다.
    """
    from teamflow.services import message_service

    view = (
        REPO_ROOT / "frontend" / "src" / "lib" / "chat" / "view.ts"
    ).read_text(encoding="utf-8")
    found = re.search(r"MESSAGE_PAGE\s*=\s*(\d+)", view)
    assert found is not None, "`MESSAGE_PAGE` 를 못 찾았습니다"
    assert int(found.group(1)) == message_service.MAX_PAGE, (
        f"화면 {found.group(1)} ↔ 서버 {message_service.MAX_PAGE} — 한 쪽 크기가 갈라졌습니다"
    )


def test_every_server_route_has_a_caller() -> None:
    """⭐ 서버 갈래마다 **부르는 곳**이 있어야 한다.

    ## 왜 이 검사가 생겼나

    결함 298(일정을 무르는 자리가 없었다)을 고치면서 AGENTS.md 에 이렇게
    적어 뒀습니다 —

    > 서버의 갈래마다 부르는 곳이 있는지 세는 가드가 낱말을 세는 것보다
    > 낫습니다.

    그걸 실제로 세어 봤더니 `POST /api/meetings/{id}/minutes` 가 나왔습니다
    (결함 306). 만들어져 있고 검사도 붙어 있는데 **부르는 곳이 0곳**이었고,
    그 사이 보고서 화면은 사람에게 「회의 로비에서 회의록을 만드세요」라고
    말하고 있었습니다. 로비에 그런 단추가 없었습니다 (실패 ③).

    ## ⚠️ 이 자의 위험 — 주소를 조각으로 만드는 곳

    녹음 클라이언트는 `${trackUrl}/chunks/${seq}` 처럼 **주소를 이어 붙여**
    만듭니다. 전체 경로를 글자로 찾는 자는 그걸 못 보고 「부르는 곳 0곳」
    이라고 답합니다 — 처음 돌렸을 때 실제로 셋이 그렇게 잡혔습니다.
    그래서 예외는 **왜 예외인지**를 같이 적습니다.

    ⚠️ 「덮는가」만이 아니라 **「맞는 칸인가」**도 봅니다 (결함 289):
    예외에 적어 뒀는데 이제는 제대로 불리는 갈래가 있으면 그것도
    알려 줍니다 — 낡은 예외는 다음 사람을 속입니다.

    ## ⛔ 이 자가 **구조적으로 못 보는 것** (결함 352)

    두 뿌리를 **한 자루에 담아** 셉니다. 그래서 「레거시는 부르는데 SPA 는
    안 부른다」가 초록입니다 — 결함 321 이 다른 가드에서 겪은 그것이고,
    실제로 `GET /api/meetings/{id}/utterance-types`(REVIEW-005)와
    `GET /api/meetings/{id}/speaking` 이 그렇게 숨어 있었습니다.

    ⚠️ **뿌리마다 따로 세는 것으로 바꾸면 안 됩니다.** SPA 는 화면이
    아홉이고 레거시는 열셋이라, 채팅·일정·알림·활동·찾기·보고서의
    라우트 스물여덟이 전부 「SPA 가 안 부름」으로 걸립니다 — 그건 결함이
    아니라 설계입니다.

    그래서 **같은 화면이 두 뿌리에 다 있는 자리**만 따로 잽니다:
    `test_both_review_screens_ask_for_the_same_meeting_facts`.
    """
    import re

    EXCUSED = SERVER_ONLY_OR_ASSEMBLED

    routes: list[tuple[str, str, str]] = []
    for path in sorted((REPO_ROOT / "backend" / "teamflow" / "api").rglob("*.py")):
        source = path.read_text(encoding="utf-8")
        prefix = ""
        head = re.search(r"APIRouter\(([^)]*)\)", source, re.S)
        if head:
            got = re.search(r'prefix\s*=\s*"([^"]*)"', head.group(1))
            if got:
                prefix = got.group(1)
        for hit in re.finditer(
            r'@\w+\.(get|post|patch|put|delete)\(\s*"([^"]*)"', source
        ):
            routes.append(
                (hit.group(1).upper(), prefix + hit.group(2), str(path.relative_to(REPO_ROOT)))
            )

    assert len(routes) > 50, f"라우트를 {len(routes)}개밖에 못 찾았습니다 — 가드가 헛돕니다"

    screens: list[str] = []
    for base in ("frontend/src", "webapp/src"):
        for path in (REPO_ROOT / base).rglob("*"):
            if path.suffix in (".ts", ".tsx") and ".test." not in path.name:
                code = path.read_text(encoding="utf-8")
                # 주석의 「예전에는 이렇게 불렀다」를 진짜 호출로 물지 않게 걷습니다.
                code = re.sub(r"/\*[\s\S]*?\*/", "", code)
                code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
                screens.append(code)

    #: 주소 한 조각에 올 수 있는 글자 — `/` 와 따옴표·백틱·공백은 경계입니다.
    SEG = "[^/`'\"\\s]+"

    #: 쓰기 갈래는 화면이 **메서드를 글자로 적어야** 부를 수 있습니다.
    #: `GET` 은 `fetch(url)`·`get(url)`·`<audio src>` 처럼 적는 방식이 여럿이라
    #: 안 봅니다 — 재 보니 `GET` 넷이 전부 그런 자리였고 **거짓 양성만**
    #: 나옵니다(결함 379).
    METHOD_MARK: dict[str, str] = {
        "POST": r"POST|\.post\b",
        "PUT": r"PUT|\.put\b",
        "PATCH": r"PATCH|\.patch\b",
        "DELETE": r"DELETE|\.delete\b",
    }

    #: ⚠️ **`{id}` 자리는 형제 갈래의 「글자 그대로」도 삼킵니다.**
    #:
    #: `/api/projects/{project_id}` 의 자는 그 자리를 아무 글자로 채우므로,
    #: 화면이 형제인 `/api/projects/join` 을 부르는 것만으로 초록이 됩니다.
    #: 지금은 두 자리가 그렇고(`join` · `me`) **둘 다 진짜 호출이 따로
    #: 있어서** 거짓 초록은 0건입니다 — 하지만 진짜 호출이 사라지는 날
    #: 아무도 못 봅니다. 형제의 글자가 채운 hit 는 **증거로 안 셉니다.**
    all_paths = sorted({path for _, path, _ in routes})

    def sibling_literals(route_path: str) -> dict[int, set[str]]:
        """`{id}` 자리마다 「같은 자리에 글자를 박은 형제 갈래」를 모읍니다."""
        parts = route_path.split("/")
        found: dict[int, set[str]] = {}
        for i, seg in enumerate(parts):
            if not seg.startswith("{"):
                continue
            literals = {
                other.split("/")[i]
                for other in all_paths
                if other != route_path
                and len(other.split("/")) == len(parts)
                and other.split("/")[:i] == parts[:i]
                and not other.split("/")[i].startswith("{")
            }
            if literals:
                found[i] = literals
        return found

    def called(route_path: str, method: str = "") -> bool:
        """이 갈래를 부르는 화면이 있는가.

        ⚠️ **자가 두 곳에서 헐거웠습니다** (결함 378):

        1. `{id}` 자리를 그냥 `+` 로 두면 **역추적**이 아래 끝 못 박기를
           무력화합니다 — `${channelId}` 를 `${channelI` 까지 줄여 가며
           맞추다가 `}` 앞에서 성공해 버립니다. **원자 그룹**으로 막습니다.
        2. `search` 만 쓰면 **더 긴 형제 갈래**가 짧은 갈래를 대신
           만족시킵니다. 화면이 `/api/channels/${id}/messages` 를 부르는
           것만으로 `PATCH /api/channels/{channel_id}` 가 「불린다」로
           잡혔고, 채널 이름 변경·삭제는 **화면에 컨트롤이 0개**인 채
           초록이었습니다.

        ⚠️ 끝을 막을 때 「뒤에 아무 글자도 오면 안 된다」로 쓰면 `?q=` 가
        붙는 자리(찾기·달력)를 전부 「안 불린다」로 잡습니다. 막을 것은
        **경로가 더 이어지는 것**뿐입니다.

        ⚠️ 이 자가 **못 보는 것**: `GET` 갈래는 메서드를 **안 봅니다**
        (`METHOD_MARK` 에 없습니다). 같은 주소에 `GET` 과 쓰기 갈래가
        있으면, 화면이 쓰기만 불러도 `GET` 은 초록입니다.

        그런 자리가 **열 곳**이라 하나씩 세어 봤고 — `/api/projects` ·
        `/api/projects/{project_id}`(+`/meetings` `/contributions/final`
        `/reports` `/channels`) · `/api/meetings/{meeting_id}`(+`/consent`
        `/tracks`) · `/api/channels/{channel_id}/messages` — **열 곳 다
        진짜 `GET` 호출이 따로 있었습니다.** 지금은 거짓 초록이 0건입니다.
        """
        pattern = re.sub(r"\\\{[a-z_]+\\\}", lambda _: f"(?>{SEG})", re.escape(route_path))
        #: ⚠️ **앞도 막습니다** (결함 379). 짧은 주소는 **남의 파일 경로
        #: 안**에서 걸립니다 — `GET /health` 가 `../lib/github/health.ts`
        #: 라는 import 경로에 걸려 「불린다」로 잡혔고, 그 갈래를 부르는
        #: 화면은 **0곳**이었습니다.
        rx = re.compile(r"(?<![A-Za-z0-9_.-])" + pattern + r"(?![A-Za-z0-9_/-])")
        mark = METHOD_MARK.get(method)
        siblings = sibling_literals(route_path)
        for code in screens:
            for hit in rx.finditer(code):
                #: 형제 갈래의 **글자 그대로**가 `{id}` 자리를 채운 것은
                #: 이 갈래를 부른 것이 아닙니다 — 증거로 안 셉니다.
                got = hit.group(0).split("/")
                if any(
                    i < len(got) and got[i] in literals
                    for i, literals in siblings.items()
                ):
                    continue
                if mark is None:
                    return True
                #: 주소 **둘레**에서 메서드를 찾습니다 — `sendJson(url, 'PATCH', …)`
                #: 도 `fetch(url, { method: 'DELETE' })` 도 `api.patch(url, …)` 도
                #: 이 창 안에 있습니다.
                around = code[max(0, hit.start() - 200) : hit.end() + 200]
                if re.search(mark, around):
                    return True
        return False

    orphans: list[str] = []
    stale: list[str] = []
    for method, route_path, where in routes:
        key = f"{method} {route_path}"
        if called(route_path, method):
            if key in EXCUSED:
                stale.append(f"{key}  — 예외에 적힌 사유가 낡았습니다: {EXCUSED[key]}")
        elif key not in EXCUSED:
            orphans.append(f"{key}  ({where})")

    assert not orphans, (
        "이 서버 갈래를 **부르는 화면이 하나도 없습니다** — 만들어 놓고 안 이은 것이거나\n"
        "  (실패 ①), 주소를 조각으로 만들어 이 자가 못 본 것입니다. 후자면 위\n"
        "  `EXCUSED` 에 **왜인지** 적으세요:\n  " + "\n  ".join(orphans)
    )
    assert not stale, (
        "이제 제대로 불리는데 예외에 남아 있습니다 — 낡은 예외는 다음 사람을 속입니다:\n  "
        + "\n  ".join(stale)
    )


def test_both_review_screens_ask_for_the_same_meeting_facts() -> None:
    """⭐ **두 검토 화면이 같은 회의 사실을 묻습니다** (결함 352).

    ## 왜 이 검사가 생겼나

    같은 회의(`/review.html?meeting=1` · `/app/meeting/1/review`)를 열고
    네트워크를 나란히 찍었더니, SPA 가 **두 갈래를 아예 안 부르고**
    있었습니다:

        GET /api/meetings/{id}/utterance-types   REVIEW-005 「무슨 말이 오갔나」
        GET /api/meetings/{id}/speaking          AI-AUDIO-005 「누가 얼마나 말했나」

    그 판의 머리 주석은 「통계·요약은 **접고** 전사가 주인공」이었는데,
    요약만 접혀 있고 통계는 **아예 없었습니다.** `docs/20` 은 REVIEW-005 를
    ✅ 로 적으면서 어느 뿌리인지는 안 적었습니다.

    ## ⚠️ 라우트 가드는 이걸 **구조적으로** 못 봅니다

    위 `test_...no_screen_calls_it` 이 두 뿌리를 한 자루에 담아 세기
    때문입니다(결함 321 과 같은 모양). 그렇다고 그 자를 뿌리마다 가르면
    채팅·일정·알림처럼 **SPA 에 아예 없는 화면**의 라우트 스물여덟이 전부
    걸립니다 — 그건 결함이 아니라 설계입니다.

    그래서 **같은 화면이 두 뿌리에 다 있는 자리**만 좁혀서 잽니다.
    """
    import re

    def strip(code: str) -> str:
        code = re.sub(r"/\*[\s\S]*?\*/", "", code)
        return re.sub(r"^\s*//.*$", "", code, flags=re.M)

    #: `/api/meetings/{id}/<여기>` 의 마지막 조각.
    SEGMENT = r"/api/meetings/\$\{[^}]+\}/([a-z-]+)"

    legacy_code = strip(
        (REPO_ROOT / "frontend" / "src" / "demo" / "review.tsx").read_text(encoding="utf-8")
    )
    legacy = set(re.findall(SEGMENT, legacy_code))

    # ⚠️ **SPA 는 `hooks.ts` 를 통째로 세면 안 됩니다.** 거기에는 로비의
    #    갈래(`consent`·`tracks`·`finish`…)도 같이 있어서, 검토 화면이 안
    #    쓰는 것까지 「부른다」로 잡힙니다 — 처음에 그렇게 짰다가 여섯이
    #    거짓으로 잡혔습니다. **검토 화면이 실제로 쓰는 훅**만 따라갑니다.
    screen = strip(
        (REPO_ROOT / "webapp" / "src" / "screens" / "Review.tsx").read_text(encoding="utf-8")
    )
    hooks_code = (REPO_ROOT / "webapp" / "src" / "api" / "hooks.ts").read_text(encoding="utf-8")
    bodies = dict(
        re.findall(
            r"export function (use\w+)\([^)]*\)\s*\{(.*?)\n\}", hooks_code, re.DOTALL
        )
    )
    used = {name for name in bodies if re.search(rf"\b{name}\(", screen)}
    assert used, "검토 화면이 훅을 하나도 안 씁니다 — 이 검사가 낡았습니다"
    spa = {seg for name in used for seg in re.findall(SEGMENT, strip(bodies[name]))}

    assert legacy, "레거시 검토가 회의에 아무것도 안 묻습니다 — 이 검사가 낡았습니다"
    assert spa, "SPA 검토가 회의에 아무것도 안 묻습니다 — 이 검사가 낡았습니다"

    #: 한쪽만 부르는 것 — **왜인지** 적습니다. 지금은 비어 있습니다:
    #: 고치고 나니 다섯 갈래가 정확히 같아졌습니다
    #: (`candidates` · `members` · `speaking` · `timeline` · `utterance-types`).
    #:
    #: ⚠️ **처음에 여기 둘을 지어냈다가 아래 「낡음」 검사에 걸렸습니다.**
    #: `timeline` 은 레거시도 부릅니다 — 다만 「타임라인」 여닫이를 펴야
    #: 부르는 **늦은 호출**이라, 네트워크만 보고 「SPA 만 부른다」로 읽었던
    #: 것입니다. 예외는 **재 보고** 적으십시오.
    EXCUSED_LEGACY_ONLY: dict[str, str] = {}
    EXCUSED_SPA_ONLY: dict[str, str] = {}

    missing = sorted(legacy - spa - set(EXCUSED_LEGACY_ONLY))
    assert missing == [], (
        f"SPA 검토가 안 묻는 갈래: {missing} — 레거시만 그 사실을 그립니다. "
        "`/app` 으로 들어온 사람에게는 그 판이 통째로 없습니다"
    )
    extra = sorted(spa - legacy - set(EXCUSED_SPA_ONLY))
    assert extra == [], f"레거시 검토가 안 묻는 갈래: {extra}"

    # ⚠️ **예외가 낡는 것도 잽니다** (결함 306). 이제 둘 다 부르는데 예외에
    #    남아 있으면 다음 사람이 「아직 안 붙었다」로 읽습니다.
    stale = sorted(
        [name for name in EXCUSED_LEGACY_ONLY if name in spa]
        + [name for name in EXCUSED_SPA_ONLY if name in legacy]
    )
    assert stale == [], f"이제 둘 다 부르는데 예외에 남아 있습니다: {stale}"


def test_both_review_screens_keep_a_draft_through_a_refresh() -> None:
    """⭐ **검토하던 것을 잃는 화면이 있으면 안 됩니다** (결함 333).

    ## 왜 이 검사가 생겼나

    `@lib/review/drafts.ts` 는 결함 217 이 「새로고침 한 번에 전부
    날아갔습니다」를 고치려고 만든 것입니다. 그런데 **SPA 에만
    배선돼 있었습니다.** 브라우저로 재서 확인한 것 —

        레거시: 「업무로 등록」 → 표시 1건 · 나간 요청 0건
                새로고침       → 표시 **0건** · sessionStorage **비어 있음**

    이 저장소가 **네 번째로** 당한 「한쪽 뿌리만 고쳐진」 자리입니다
    (231 · 306 · 320 · 321). 레거시 화면은 라우트가 유지되므로(R8)
    사람이 실제로 그리로 들어옵니다 — 들어온 사람은 몇 분어치 입력을
    말없이 잃습니다.

    ⚠️ **낱말이 아니라 요구를 잽니다**: 두 화면이 `drafts.ts` 의
    세 갈래(되살리기 · 쓰기 · 확정 뒤 비우기)를 다 거치는가.
    하나라도 빠지면 그 화면만 조용히 잃습니다.
    """
    roots = {
        "레거시": REPO_ROOT / "frontend/src/demo/review.tsx",
        "SPA": REPO_ROOT / "webapp/src/screens/Review.tsx",
    }
    needed = {
        "되살리기": "parseDrafts(",
        "쓰기": "serializeDrafts(",
        "확정 뒤 비우기": "removeItem(draftStorageKey(",
    }

    missing: list[str] = []
    for label, path in roots.items():
        assert path.exists(), f"{label} 검토 화면을 못 찾았습니다: {path}"
        source = path.read_text(encoding="utf-8")
        for what, needle in needed.items():
            if needle not in source:
                missing.append(f"{label}: {what} ({needle})")

    assert not missing, (
        "검토 초안을 지키지 않는 화면이 있습니다 — 그 화면으로 들어온 "
        "사람만 새로고침 한 번에 잃습니다:\n  " + "\n  ".join(missing)
    )


def test_meeting_actions_reach_both_roots() -> None:
    """⭐ **두 로비가 같은 회의 단위 동작을 줘야 합니다** (결함 320).

    ## 왜 이 검사가 생겼나

    이 저장소에는 로비가 **둘**입니다 — 레거시 `frontend/src/demo/lobby.tsx`
    와 SPA `webapp/src/screens/Lobby.tsx`. 같은 회의를 그리는데 한쪽에만
    단추가 있으면 **사람이 어느 주소로 들어왔느냐로 할 수 있는 일이
    달라집니다.** 실제로 세 번 났습니다:

    - 결함 231 — 「다시 처리하기」가 레거시에만 (SPA 로비는 `/reprocess` 를
      한 번도 안 물어봤습니다)
    - 결함 306 — 「회의록 만들기」를 부르는 곳이 **0곳**인데, 보고서 화면은
      「회의 로비에서 회의록을 만드세요」라고 말하고 있었습니다
    - 결함 320 — 「이 회의 무르기」를 만들면서 **또** 레거시에만 달 뻔했습니다
      (이번엔 반대 방향입니다)

    ## ⚠️ 왜 결함 306 의 라우트 가드로는 못 잡나

    그 가드는 `frontend/src` 와 `webapp/src` 를 **한 자루에 담아** 셉니다.
    한쪽에서만 불려도 「부르는 곳 있음」이라 초록입니다 — AGENTS.md 가
    결함 286 에 적어 둔 **「가드가 걷는 자리가 한쪽뿐인지 보십시오」**의
    정확히 반대 모양입니다. 그래서 여기서는 **뿌리마다 따로** 셉니다.
    """
    import re

    # 로비가 여는 「회의 단위」 갈래. 값은 그 갈래를 **부르는 모양**입니다 —
    # 레거시는 `fetch(..., {method})`, SPA 는 `api.del`/`api.post` 라
    # 글자가 다릅니다. 그래서 경로로 찾고, DELETE 만 방법을 같이 봅니다.
    ACTIONS = {
        "다시 처리하기 (결함 231)": re.compile(r"/api/meetings/\$\{[^}]+\}/reprocess"),
        "회의록 만들기 (결함 306)": re.compile(r"/api/meetings/\$\{[^}]+\}/minutes"),
        # ⚠️ 회의 자체를 지우는 것이라 **뒤에 아무 조각도 안 붙습니다.**
        #    `/tracks/...` 같은 하위 갈래를 같이 물지 않게 끝을 못 박습니다.
        # ⚠️ **자를 한 번 넓혔습니다.** 처음에는 「DELETE 라고 적고 나서
        #    경로」로만 봤는데, 레거시는 `fetch(\`…\`, { method: 'DELETE' })`
        #    라 **경로가 먼저**입니다 — 제대로 이어 놓은 자리를 거짓으로
        #    잡았습니다(결함 299 가 적어 둔 「자 자체가 좁았다」).
        "이 회의 무르기 (결함 320)": re.compile(
            r"api\.del<[^>]*>\(\s*`[^`]*/api/meetings/\$\{[^}]+\}`"
            r"|/api/meetings/\$\{[^}]+\}`[\s\S]{0,200}?method:\s*'DELETE'"
        ),
    }

    roots = {
        "레거시 frontend/src": REPO_ROOT / "frontend" / "src",
        "SPA webapp/src": REPO_ROOT / "webapp" / "src",
    }

    missing: list[str] = []
    for label, root in roots.items():
        codes: list[str] = []
        for path in root.rglob("*"):
            if path.suffix in (".ts", ".tsx") and ".test." not in path.name:
                code = path.read_text(encoding="utf-8")
                # 주석의 「예전에는 이렇게 불렀다」를 진짜 호출로 물지 않게 걷습니다
                # (결함 238 — 마크업에서 세 번째로 걸린 함정입니다).
                code = re.sub(r"/\*[\s\S]*?\*/", "", code)
                code = re.sub(r"^\s*//.*$", "", code, flags=re.M)
                codes.append(code)
        assert codes, f"{label} 에서 파일을 못 찾았습니다 — 가드가 헛돕니다"
        for action, rx in ACTIONS.items():
            if not any(rx.search(code) for code in codes):
                missing.append(f"{action} — {label} 에서 부르는 곳이 0곳입니다")

    assert not missing, (
        "회의 로비의 동작이 **한쪽 뿌리에만** 있습니다. 같은 회의를 그리는 두\n"
        "  화면인데 들어온 주소로 할 수 있는 일이 갈립니다:\n  " + "\n  ".join(missing)
    )


# ══════════════════════════════════════════════════════════════
# 회의 요약 응답의 칸이 **세 자리에서 같은가** (결함 368)
# ══════════════════════════════════════════════════════════════
#
# 이 응답(`GET /api/projects/{id}/meetings`)의 모양이 세 곳에 적혀 있습니다:
#
#   · 서버   `MeetingSummary` (`api/main.py`)      — 실제로 내보내는 것
#   · `@lib` `Meeting` (`home/next.ts`)            — 판단이 **읽는** 부분집합
#   · SPA    `MeetingSummary` (`api/types.ts`)     — 화면이 받는다고 적은 것
#
# ⚠️ 결함 368 에서 서버에 `utterance_count` 를 더할 때 **SPA 타입에만 안
# 넣을 뻔했습니다.** 값은 JSON 이라 런타임에는 그대로 흘러가고 타입만
# 거짓말을 합니다 — 오류도 안 나고 화면도 멀쩡해서, 다음 사람이 그 칸이
# 없다고 믿고 코드를 씁니다.
#
# 그래서 **낱말이 아니라 짝을 셉니다**: 화면이 받는다고 적은 칸 집합은
# 서버가 내보내는 것과 **같아야** 하고, `@lib` 이 읽는 칸은 그 **안에**
# 있어야 합니다.


def _pydantic_fields(source: str, class_name: str) -> set[str]:
    body = re.search(
        rf"^class {class_name}\(BaseModel\):\n(.*?)(?=\n\n@|\n\nclass |\n\ndef )",
        source,
        re.S | re.M,
    )
    assert body is not None, f"{class_name} 을 못 찾았습니다 — 가드가 낡았습니다"
    text = re.sub(r"^\s*#.*$", "", body.group(1), flags=re.M)
    return set(re.findall(r"^\s{4}(\w+)\s*:", text, flags=re.M))


def _ts_interface_fields(source: str, name: str) -> set[str]:
    body = re.search(rf"(?:interface|type) {name}\b[^{{]*\{{(.*?)\n\}}", source, re.S)
    assert body is not None, f"{name} 을 못 찾았습니다 — 가드가 낡았습니다"
    text = re.sub(r"/\*[\s\S]*?\*/", "", body.group(1))
    text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
    return set(re.findall(r"^\s{2}(\w+)\??\s*:", text, flags=re.M))


def test_meeting_summary_fields_agree_across_the_three_places() -> None:
    server = _pydantic_fields(
        (REPO_ROOT / "backend/teamflow/api/main.py").read_text(encoding="utf-8"),
        "MeetingSummary",
    )
    lib = _ts_interface_fields(
        (REPO_ROOT / "frontend/src/lib/home/next.ts").read_text(encoding="utf-8"),
        "Meeting",
    )
    spa = _ts_interface_fields(
        (REPO_ROOT / "webapp/src/api/types.ts").read_text(encoding="utf-8"),
        "MeetingSummary",
    )

    # 세 자리를 **전부** 봤는지부터 (빈 집합이면 자가 헛돈 것입니다).
    assert len(server) >= 5 and len(lib) >= 5 and len(spa) >= 5, (
        f"칸을 제대로 못 읽었습니다 — 서버 {sorted(server)} · lib {sorted(lib)} · SPA {sorted(spa)}"
    )

    assert spa == server, (
        "화면이 받는다고 적은 칸이 서버와 다릅니다 — 값은 런타임에 흘러가고\n"
        "  타입만 거짓말을 합니다 (결함 368).\n"
        f"  서버에만: {sorted(server - spa)}\n"
        f"  SPA 에만: {sorted(spa - server)}"
    )
    assert lib <= server, (
        "`@lib` 이 서버가 안 보내는 칸을 읽습니다 — 언제나 `undefined` 입니다.\n"
        f"  없는 칸: {sorted(lib - server)}"
    )


def test_the_requirements_table_does_not_claim_unwired_things() -> None:
    """⛔ **「서버만 있다」와 「✅ 다 됐다」가 갈라져 있었습니다** (결함 377).

    라우트 가드의 예외 표는 두 갈래를 **진짜로 아무도 안 부릅니다** 라고
    적어 두고 있습니다 — 「만들어 놓고 화면에 안 이은 것이고(실패 ①),
    붙일 때 이 줄을 지웁니다」. 그런데 같은 저장소의 요구사항 대조표는
    그중 하나를 **✅** 로 적고 있었습니다:

        docs/20  | CHANNEL-005 순서 변경 | ✅ | `reorder_channels` … |
        가드     | "CHANNEL-005 채널 순서 — 서버만 있고 화면에 아직 안 이었습니다"

    ✅ 는 「다 됐다」로 읽힙니다. 대조표를 읽는 사람은 채널 순서를 바꿀 수
    있다고 믿습니다 — 채팅 화면에는 순서를 바꾸는 컨트롤이 **0개**입니다.

    ## 왜 표를 고치고 기능을 안 만드는가

    그 예외는 **근거를 적어 둔 기록**입니다(「붙일 때 이 줄을 지웁니다」).
    없는 기능을 지어내는 대신 **대조표가 사실을 말하게** 합니다 —
    결함 317 이 `docs/00` 에서 한 것과 같습니다.

    ## ⚠️ 이 자가 못 보는 것

    예외 사유에 **요구사항 번호가 적혀 있는 것만** 짝을 잽니다. 번호가
    없는 예외(멘션 자동완성)는 여기서 안 걸립니다 — 그 줄은 대조표에서
    이미 정직하게 적고 있습니다(「서버가 본문에서 뽑습니다」).
    """
    import re

    table = (REPO_ROOT / "docs" / "20-요구사항-대조.md").read_text(encoding="utf-8")

    #: 예외 사유에서 요구사항 번호를 뽑습니다 (`CHANNEL-005` 같은 것).
    claimed: dict[str, str] = {}
    for route, why in SERVER_ONLY_OR_ASSEMBLED.items():
        for req in re.findall(r"\b([A-Z]+-\d{3})\b", why):
            claimed[req] = route

    assert claimed, (
        "예외 사유에서 요구사항 번호를 하나도 못 뽑았습니다 — 이 검사가 낡았습니다"
    )

    offenders: list[str] = []
    for req, route in sorted(claimed.items()):
        rows = [line for line in table.splitlines() if req in line and line.startswith("|")]
        if not rows:
            offenders.append(f"{req}: 대조표에 그 줄이 없습니다 (`{route}`)")
            continue
        for row in rows:
            cells = [c.strip() for c in row.split("|")]
            #: 상태 칸은 두 번째입니다. 순수한 `✅` 는 「다 됐다」로 읽힙니다.
            status = cells[2] if len(cells) > 2 else ""
            if status == "✅":
                offenders.append(
                    f"{req}: 대조표는 ✅ 인데 `{route}` 를 부르는 화면이 0곳입니다"
                )

    assert offenders == [], (
        "요구사항 대조표가 안 이어진 것을 「다 됐다」로 적고 있습니다:\n  "
        + "\n  ".join(offenders)
    )


# ══════════════════════════════════════════════════════════════
# 마감일을 바꾸는 자리 ↔ 그것을 전제로 하는 말 (결함 386)
# ══════════════════════════════════════════════════════════════

#: 서버가 마감일을 바꾸는 갈래. 이 갈래가 돌아야 `DEADLINE_CHANGED` 가 생기고,
#: 그게 있어야 `frequent_deadline_change` 무결성 플래그가 뜰 수 있습니다.
_TASK_PATCH_CALL = re.compile(
    r"""
    (?:                                  # 업무 PATCH 를 부르는 두 모양
        patchTask\s*\(                   #   레거시: 공용 헬퍼
      | api\.patch\s*<[^>]*>\s*\(        #   SPA: 타입 붙은 헬퍼
      | api\.patch\s*\(
    )
    """,
    re.VERBOSE,
)


def _blanked_ts(source: str) -> str:
    """TS/TSX 의 주석을 **길이를 지켜** 지웁니다.

    ⚠️ `_blanked` 는 파이썬 모양(`\"\"\"` · `#`)이라 JS 주석을 못 걷습니다.
    이 저장소의 화면 주석은 「예전에는 이렇게 적었고 왜 바꿨다」를 **옛 문장
    그대로** 인용합니다 — 안 걷으면 자가 **내 고침의 주석**을 위반으로 뭅니다.
    결함 238 이 마크업에서 겪은 그것이고, 실제로 이 검사를 처음 돌렸을 때
    잡힌 것이 방금 고친 `calendar.tsx` 의 주석이었습니다.

    길이를 지키는 이유는 `_blanked` 와 같습니다 — 창을 잘라 보는 자가
    엉뚱한 자리를 가리키지 않게.

    ## ⚠️ 이 자가 못 보는 것 — **문자열 안의 `//`**

    문자열을 안 가리므로 `'http://127.0.0.1:8811/home.html'` 같은 주소를
    **줄 주석으로 먹습니다.** 두 뿌리를 세어 보니 걸리는 줄이 아홉인데
    여덟은 이미 주석 안이라 결과가 같고, 진짜는 하나입니다 —
    `lib/desktop/server.ts` 의 `DEFAULT_SERVER`.

    지금 이 함수를 쓰는 가드 중에 그 줄을 보는 것은 없어서 **고치지
    않았습니다.** 제대로 고치려면 `'`·`"`·백틱과 **정규식 리터럴**까지
    갈라야 하는데(`lib/html.ts` 의 `/[&<>"']/g` 가 정확히 그 함정입니다),
    그 자가 틀리면 이 함수를 쓰는 가드 전부가 조용히 어긋납니다. 잘못
    고치는 것이 안 고치는 것보다 나쁜 자리라 **재서 적어만 둡니다.**

    ⚠️ 방향은 **fail-open** 입니다 — 주석으로 먹힌 코드는 안 보이므로
    가드가 「0건」쪽으로 틀립니다. 새 가드를 이 함수 위에 얹을 때는
    「내가 보려는 것이 문자열 안에 있나」를 먼저 세십시오.
    """

    def blank(match: re.Match[str]) -> str:
        return "".join("\n" if ch == "\n" else " " for ch in match.group(0))

    # `{/* … */}` 는 `/* … */` 가 먼저 먹으므로 블록 → 줄 순서면 충분합니다.
    code = re.sub(r"/\*[\s\S]*?\*/", blank, source)
    return re.sub(r"//[^\n]*", blank, code)


def _screens_that_send_a_deadline() -> dict[str, list[str]]:
    """업무 PATCH 본문에 `deadline` 을 싣는 화면 파일 — **뿌리마다 따로**.

    ⚠️ 라우트를 세는 것과 **인자**를 세는 것은 다릅니다 (결함 315).
    `PATCH /tasks/{id}` 는 옮기기·우선순위가 이미 부르고 있어서 라우트
    census 로는 언제나 초록입니다. 안 불리는 것은 **`deadline` 이라는 칸**
    입니다.
    """
    roots = {
        "레거시 frontend/src": REPO_ROOT / "frontend" / "src",
        "SPA webapp/src": REPO_ROOT / "webapp" / "src",
    }
    found: dict[str, list[str]] = {}
    for name, base in roots.items():
        hits: list[str] = []
        if not base.exists():
            found[name] = hits
            continue
        for path in sorted(base.rglob("*.ts")) + sorted(base.rglob("*.tsx")):
            if ".test." in path.name:
                continue
            code = _blanked_ts(path.read_text(encoding="utf-8"))
            for match in _TASK_PATCH_CALL.finditer(code):
                # 그 호출의 인자 구간만 봅니다 — 파일 어딘가의 `deadline` 은
                # 승인 화면의 후보 초안일 수 있습니다.
                window = code[match.end() : match.end() + 400]
                if re.search(r"\bdeadline\b", window):
                    hits.append(str(path.relative_to(REPO_ROOT)))
                    break
        found[name] = hits
    return found


def test_nothing_promises_a_deadline_editor_that_does_not_exist() -> None:
    """⭐ 화면이 「칸반에서 마감일을 고치면」이라고 하면 그 자리가 있어야 한다.

    일정 화면이 「따로 적어 두는 것이 아니라 그때그때 읽어서 만들기 때문에,
    **칸반에서 마감일을 고치면** 여기가 바로 따라옵니다」라고 적고 있었는데,
    두 뿌리를 세어 보니 업무 PATCH 에 `deadline` 을 싣는 화면이 **0곳**
    이었습니다 (결함 386). 마감일은 후보를 승인할 때 한 번 정해지고 그 뒤로
    바꿀 자리가 없습니다.

    결함 313 의 「화면이 「할 수 있다」고 말하면 그 자리를 세어 보십시오」를
    마감일에 댄 것입니다.
    """
    wired = _screens_that_send_a_deadline()
    can_edit = any(wired.values())

    promises: list[str] = []
    for base in (REPO_ROOT / "frontend" / "src", REPO_ROOT / "webapp" / "src"):
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.tsx")) + sorted(base.rglob("*.ts")):
            if ".test." in path.name:
                continue
            text = _blanked_ts(path.read_text(encoding="utf-8"))
            # ⚠️ 이 자는 처음에 `칸반에서[^.]{0,40}마감일을 (고치|바꾸|수정)`
            # 였습니다. 같은 화면의 빈 상자가 「칸반에서 업무에 마감일을
            # **주세요**」 라고 하고 있었는데 **그 자에 안 걸렸습니다**
            # (결함 389). 자가 좁아서 놓친 것이지 요구가 달랐던 것이
            # 아닙니다 — 결함 299 의 모양입니다.
            #
            # 재는 것은 낱말이 아니라 요구입니다: **칸반이 마감일을 정하는
            # 자리라고 말하는가.** 「고치다·바꾸다·수정하다」 뿐 아니라
            # 「주다·넣다·정하다·달다」 까지 보고, 두 낱말의 **순서도**
            # 뒤집힐 수 있으므로 양방향으로 봅니다.
            #
            # ⚠️ 이 자가 못 보는 것: 칸반을 **다른 이름으로** 부르는 문장
            # (「보드에서 마감일을 주세요」). 화면들이 쓰는 이름은 지금
            # 「칸반」 하나뿐이라 그 이름으로만 잽니다.
            flat = re.sub(r"\s+", " ", text)
            verbs = "고치|바꾸|수정|주|넣|정하|달"
            if re.search(rf"칸반[^.]{{0,40}}마감일[을를]?\s*({verbs})", flat) or re.search(
                rf"마감일[을를]?[^.]{{0,40}}칸반[^.]{{0,20}}({verbs})", flat
            ):
                promises.append(str(path.relative_to(REPO_ROOT)))

    if not can_edit:
        assert promises == [], (
            f"마감일을 고칠 수 있다고 말하는 화면: {promises} — 그런데 업무 PATCH 에 "
            f"deadline 을 싣는 화면은 두 뿌리 다 0곳입니다 (결함 386). "
            "말을 고치거나 자리를 만드세요"
        )


def test_the_integrity_flag_table_says_whether_the_flag_can_fire() -> None:
    """⭐ `docs/09` 의 「구현된 무결성 플래그」와 **실제로 뜰 수 있는가**가 짝이다.

    `frequent_deadline_change` 는 `DEADLINE_CHANGED` 를 셉니다. 그 이벤트는
    `_change_deadline` 만 만들고, 그 함수는 화면이 `deadline` 을 실어 보내야
    돕니다. 보내는 화면이 0곳이면 그 플래그는 **영원히 안 뜹니다** — 표가
    「구현된」이라고만 적으면 읽는 사람은 그 장치가 켜져 있다고 믿습니다.

    ⚠️ **양방향입니다.** 마감일을 고치는 자리를 만들면 이 단서가 낡습니다 —
    그때는 이 검사가 「단서를 지우세요」로 빨개집니다 (결함 297 의 방법).
    """
    doc = (REPO_ROOT / "docs" / "09-리스크와-검증-실험.md").read_text(encoding="utf-8")
    row = [
        line for line in doc.splitlines() if line.startswith("| `frequent_deadline_change`")
    ]
    assert row, "docs/09 에 frequent_deadline_change 줄이 없습니다 — 이 검사가 낡았습니다"

    wired = _screens_that_send_a_deadline()
    can_edit = any(wired.values())
    caveated = "아직 뜰 수 없습니다" in row[0]

    if can_edit:
        assert not caveated, (
            f"마감일을 보내는 화면이 생겼습니다({wired}) — docs/09 의 "
            "「아직 뜰 수 없습니다」 단서가 낡았습니다. 지우세요"
        )
    else:
        assert caveated, (
            "docs/09 가 `frequent_deadline_change` 를 「구현된」 플래그로만 적고 "
            "있습니다. 그 플래그가 세는 이벤트를 만들 길이 화면에 0곳이라 "
            "영원히 뜨지 않습니다 (결함 386)"
        )


# ══════════════════════════════════════════════════════════════
# 사람이 적은 글자가 **마크업으로** 새는가
# ══════════════════════════════════════════════════════════════
#
# 이 저장소에서 제일 무거운 부류입니다. 데스크톱 셸은 **서버가 준 화면을
# 띄우고**(`AGENTS.md` — 「서버의 XSS 가 곧 사용자 PC 의 코드 실행」),
# 레거시 화면 열넷은 문자열로 HTML 을 지어 `innerHTML` 에 넣습니다.
#
# `lib/html.ts` 는 이 위험을 알고 만들어졌습니다 — 그 머리말이 「제목에
# 따옴표가 하나 들어가면 속성이 거기서 끝나고 그 뒤가 마크업으로
# 해석됩니다」라고 적고 실제 사고를 인용합니다. 그런데 **「그래서 지금 전부
# 거치고 있는가」를 세는 자는 없었습니다.**

def _ts_template_literals(source: str) -> list[tuple[int, str]]:
    """TS/TSX 에서 **템플릿 리터럴**만 골라 (줄번호, 본문) 로 돌려줍니다.

    ## ⚠️ 왜 정규식으로 안 하는가 — 처음에 그렇게 했다가 눈을 감았습니다

    처음 자는 `` `[^`]*<[a-zA-Z/][^`]*` `` 였습니다. 백틱을 **앞에서부터
    둘씩 짝지어** 가는데, 주석이나 따옴표 문자열 안에 백틱이 하나라도 있으면
    그 뒤의 짝이 통째로 어긋납니다. 실제로 `call.ts` 에서 그랬습니다 —
    116~119줄의 `<li>` 템플릿이 **아예 안 걸려**, 그 안의 `${'${capture.tone}'}`
    가 자의 눈 밖이었습니다. 「0건」이 그 자리에서만 참이었습니다.

    그래서 문자 하나씩 걸으며 줄 주석 · 블록 주석 · `'`/`"` 문자열 · 템플릿을
    갈라 봅니다. `${'${…}'}` 안에 다시 템플릿이 오는 것도 셉니다.

    ⚠️ **정규식 리터럴은 안 가릅니다** — JS 에서 `/` 가 나눗셈인지 정규식
    시작인지는 앞 토큰을 봐야 압니다. 정규식 안에 백틱을 쓰는 코드가 이
    저장소에 없어서 안 하고, 생기면 이 주석이 단서입니다.
    """
    out: list[tuple[int, str]] = []
    i, n = 0, len(source)
    line = 1
    stack: list[int] = []  # 열린 템플릿의 시작 위치
    depth: list[int] = []  # 그 템플릿 안 `${` 중괄호 깊이
    while i < n:
        ch = source[i]
        if ch == "\n":
            line += 1
            i += 1
            continue
        if not stack and source.startswith("//", i):
            while i < n and source[i] != "\n":
                i += 1
            continue
        if not stack and source.startswith("/*", i):
            end = source.find("*/", i + 2)
            end = n if end == -1 else end + 2
            line += source.count("\n", i, end)
            i = end
            continue
        if (not stack or depth[-1] > 0) and ch in "'\"":
            quote, i = ch, i + 1
            while i < n and source[i] != quote:
                i += 2 if source[i] == "\\" else 1
            i += 1
            continue
        if ch == "\\" and stack:
            i += 2
            continue
        if ch == "`":
            if stack and depth[-1] == 0:
                start = stack.pop()
                depth.pop()
                out.append((source.count("\n", 0, start) + 1, source[start : i + 1]))
            else:
                stack.append(i)
                depth.append(0)
            i += 1
            continue
        if stack and depth[-1] >= 0:
            if source.startswith("${", i):
                depth[-1] += 1
                i += 2
                continue
            if ch == "{" and depth[-1] > 0:
                depth[-1] += 1
            elif ch == "}" and depth[-1] > 0:
                depth[-1] -= 1
        i += 1
    return out


_HTML_TAG = re.compile(r"<[a-zA-Z/]")
_INTERPOLATION = re.compile(r"\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}")
_ESCAPING_CALL = re.compile(r"^\s*(escapeHtml\(|attr\(|iconSvg\(|String\()")
#: `const x = … escapeHtml(…)` — 묶는 자리에서 이스케이프하고 쓰는 자리에서는
#: 변수만 쓰는 모양. `byline.ts` 가 그렇습니다.
_BOUND_TO_ESCAPE = re.compile(
    r"\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;]*?(?:escapeHtml\(|attr\()"
)
_NUMERIC = re.compile(r"^[\w.()\[\]\s+*/%?:'\"-]*\.(toFixed|repeat|length)\b|^\d")
#: 두 갈래가 **둘 다 글자 리터럴**인 삼항 — 조건이 무엇이든 나오는 값은 리터럴.
_LITERAL_TERNARY = re.compile(
    r"""^[^?]*\?\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*:\s*(?:'[^']*'|"[^"]*"|`[^`$]*`)\s*$"""
)

#: 자가 못 가리는 자리 — **왜 안전한지**를 값에 적습니다.
#:
#: ⚠️ 이 표는 **정확해야** 합니다. 낡은 줄이 남아 있으면 다음 사람이
#:    「여기는 봐준 자리」로 읽습니다 (결함 306 의 「예외가 낡는 것도
#:    같이 재십시오」). 아래 검사가 남는 줄을 실패로 잡습니다.
_ESCAPE_EXEMPT: dict[tuple[str, str], str] = {
    ("frontend/src/demo/call.ts", "capture.tone"): (
        "`Tone` 은 'ok'|'warn'|'bad' 유니언 — 값이 전부 `mesh.ts` 의 리터럴"
    ),
    ("frontend/src/demo/call.ts", "p.tone"): "위와 같음",
    ("frontend/src/demo/main.ts", "w.severity"): (
        "'critical'|'warning'|'info' — `recording/capture.ts` 가 리터럴로 만듭니다"
    ),
    ("frontend/src/demo/main.ts", "note?.tone ?? 'gap'"): "위와 같음",
    ("frontend/src/demo/nav.ts", "disabled"): (
        "`const disabled = tab.enabled ? '' : ' role=\"link\" tabindex=\"0\" "
        "aria-disabled=\"true\"'` — 리터럴 둘. ⚠️ 셋을 한 덩어리로 두는 이유는 "
        "언제나 같이 붙기 때문입니다 (결함 413)"
    ),
    ("frontend/src/demo/nav.ts", "marked"): "`marked` 도 리터럴 둘",
    ("frontend/src/demo/nav.ts", "current"): (
        "`const current = … ? ' aria-current=\"page\"' : ''` — 리터럴 둘 (레일·채널 두 곳)"
    ),
    ("frontend/src/lib/ui/skeleton.ts", "width"): "`bar(width: number, …)` — 숫자입니다",
    ("frontend/src/lib/ui/skeleton.ts", "kind ? ` sk-${kind}` : ''"): (
        "`kind` 는 부르는 자리가 전부 리터럴('btn'·'line'·'track'·'title'). "
        "⚠️ 이 줄은 **정규식 자가 못 보던 자리**입니다 — 템플릿 안의 템플릿이라 "
        "백틱 짝이 어긋났습니다. 스캐너로 바꾸고서야 보였습니다"
    ),
    ("frontend/src/lib/ui/skeleton.ts", "inner"): (
        "`wrap(inner: string)` 이 받는 것은 `bar()` 가 만든 **이미 조립된** HTML"
    ),
}


def _unescaped_interpolations() -> list[tuple[str, int, str]]:
    """HTML 을 만드는 템플릿에서 **이스케이프를 안 거친** 자리.

    ⚠️ 이 자가 **못 보는 것** (결함 316 의 「자가 못 보는 것을 같이
    적으십시오」):

    - 값이 **여러 함수를 거쳐** 오는 경우. 한 파일 안의 리터럴만 봅니다
    - `innerHTML` 에 **변수를 통째로** 넣는 경우 (`el.innerHTML = html`)
    - JSX 는 스스로 이스케이프하므로 안 봅니다. `dangerouslySetInnerHTML`
      의 **인자**는 결국 이 자가 보는 템플릿에서 옵니다
    - 서버가 만든 문자열. 서버는 HTML 을 안 만들지만, 만들기 시작하면
      이 자는 조용합니다
    """
    found: list[tuple[str, int, str]] = []
    for base in (REPO_ROOT / "frontend" / "src", REPO_ROOT / "webapp" / "src"):
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.ts")) + sorted(base.rglob("*.tsx")):
            if ".test." in path.name:
                continue
            text = path.read_text(encoding="utf-8")
            safe_vars = set(_BOUND_TO_ESCAPE.findall(_blanked_ts(text)))
            local_fns = set(re.findall(r"\bfunction\s+([A-Za-z_$][\w$]*)", text)) | set(
                re.findall(r"\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(", text)
            )
            for line, body in _ts_template_literals(text):
                if not _HTML_TAG.search(body):
                    continue
                for hit in _INTERPOLATION.finditer(body):
                    expr = hit.group(1).strip()
                    if _ESCAPING_CALL.match(expr) or _NUMERIC.match(expr):
                        continue
                    if _LITERAL_TERNARY.match(expr):
                        continue
                    head = re.match(r"^([A-Za-z_$][\w$]*)", expr)
                    if head and head.group(1) in safe_vars:
                        continue
                    if head and head.group(1) in local_fns and expr.startswith(head.group(1) + "("):
                        continue
                    found.append((str(path.relative_to(REPO_ROOT)), line, expr))
    return found


def test_nothing_puts_unescaped_text_into_markup() -> None:
    """⭐ 사람이 적은 글자가 **마크업으로** 새지 않는다.

    브라우저로도 재 봤습니다 — 프로젝트 이름·자기소개·회의 이름·채널
    이름·채팅 메시지에 `<img src=x onerror=…>"'<b>` 를 제품이 보내는 모양
    그대로 심고 화면 열여섯을 열었을 때 실행 0건 · 심은 요소 0건이었습니다.
    이 검사는 **그 상태가 유지되는지**를 브라우저 없이 봅니다.

    ⚠️ 「글자로 보이는 것」은 정상입니다 — 이스케이프가 됐다는 뜻입니다.
    """
    leaks = [
        (path, line, expr)
        for path, line, expr in _unescaped_interpolations()
        if (path, expr) not in _ESCAPE_EXEMPT
    ]
    assert leaks == [], (
        "HTML 을 만드는 템플릿에 이스케이프를 안 거친 값이 들어갑니다. "
        "사람이 적은 글자면 그대로 마크업이 됩니다 — 데스크톱 셸에서는 "
        f"사용자 PC 의 코드 실행입니다: {leaks}"
    )


def test_the_escape_exemptions_are_all_still_used() -> None:
    """⭐ 예외 표에 **낡은 줄**이 없다.

    자리를 고쳐 이스케이프를 거치게 되면 예외 줄이 남습니다. 남아 있으면
    다음 사람이 「여기는 봐준 자리」로 읽습니다 — 결함 306 이 라우트 예외
    표에서 겪은 그것입니다.
    """
    live = {(path, expr) for path, _, expr in _unescaped_interpolations()}
    stale = sorted(key for key in _ESCAPE_EXEMPT if key not in live)
    assert stale == [], (
        f"예외 표에 이제 안 걸리는 줄이 있습니다 — 지우세요: {stale}"
    )
