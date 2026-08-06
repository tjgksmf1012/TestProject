"""diff 필터 — 조작 저항성의 핵심.

docs/05-기여도-산정-설계.md §2.1

세지 않는 것:
    lock 파일, 자동 생성 코드, vendored 디렉터리, 바이너리·에셋,
    포맷팅만 바뀐 hunk, 내용이 같은 파일 이동/리네임

이걸 안 하면 ``package-lock.json`` 수정 한 번이 기능 구현 하나를 이긴다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from fnmatch import fnmatch

# ── 경로 기반 제외 ────────────────────────────────────────────
# .gitattributes 의 linguist-generated 규칙과 같은 취지.

EXCLUDED_GLOBS: tuple[str, ...] = (
    # lock 파일 — 한 줄 고쳐도 수천 줄이 바뀐다
    "*package-lock.json",
    "*yarn.lock",
    "*pnpm-lock.yaml",
    "*poetry.lock",
    "*Pipfile.lock",
    "*Cargo.lock",
    "*composer.lock",
    "*go.sum",
    "*uv.lock",
    "*.lock",
    # 자동 생성
    "*_pb2.py",
    "*_pb2_grpc.py",
    "*.pb.go",
    "*_generated.*",
    "*.generated.*",
    "*.g.dart",
    "*.freezed.dart",
    "*/migrations/*",
    "*/__generated__/*",
    "*.min.js",
    "*.min.css",
    "*.map",
    # vendored
    "*/node_modules/*",
    "*/vendor/*",
    "*/third_party/*",
    "*/.venv/*",
    "*/site-packages/*",
    "*/dist/*",
    "*/build/*",
    # 바이너리·에셋
    "*.png",
    "*.jpg",
    "*.jpeg",
    "*.gif",
    "*.svg",
    "*.ico",
    "*.webp",
    "*.pdf",
    "*.zip",
    "*.tar.gz",
    "*.woff",
    "*.woff2",
    "*.ttf",
    "*.otf",
    "*.eot",
    "*.mp4",
    "*.mp3",
    "*.wav",
    "*.safetensors",
    "*.gguf",
    "*.bin",
    "*.pt",
    "*.pth",
    "*.onnx",
)

# 테스트 코드는 별도 표시 — 제외가 아니라 가산 대상
TEST_GLOBS: tuple[str, ...] = (
    "*/tests/*",
    "*/test/*",
    "*test_*.py",
    "*_test.py",
    "*_test.go",
    "*.test.ts",
    "*.test.tsx",
    "*.test.js",
    "*.spec.ts",
    "*.spec.tsx",
    "*.spec.js",
)


def is_excluded_path(path: str) -> bool:
    """집계에서 제외할 경로인가."""
    normalized = "/" + path.lstrip("/")
    return any(fnmatch(normalized, glob) or fnmatch(path, glob) for glob in EXCLUDED_GLOBS)


def is_test_path(path: str) -> bool:
    normalized = "/" + path.lstrip("/")
    return any(fnmatch(normalized, glob) or fnmatch(path, glob) for glob in TEST_GLOBS)


# ── 포맷팅 전용 변경 탐지 ─────────────────────────────────────

_WS = re.compile(r"\s+")


def _normalize(line: str) -> str:
    """공백을 전부 제거해 정규화. 들여쓰기·줄바꿈 변경을 무시하기 위함."""
    return _WS.sub("", line)


@dataclass(frozen=True, slots=True)
class PatchLines:
    added: list[str]
    removed: list[str]


def parse_patch(patch: str | None) -> PatchLines:
    """통합 diff에서 추가/삭제 라인을 뽑는다. hunk 헤더와 컨텍스트는 버린다."""
    added: list[str] = []
    removed: list[str] = []
    if not patch:
        return PatchLines(added, removed)
    for raw in patch.splitlines():
        if raw.startswith(("+++", "---", "@@", "diff ", "index ")):
            continue
        if raw.startswith("+"):
            added.append(raw[1:])
        elif raw.startswith("-"):
            removed.append(raw[1:])
    return PatchLines(added, removed)


def is_formatting_only(patch: str | None) -> bool:
    """공백/줄바꿈만 바뀐 변경인가.

    추가된 줄과 삭제된 줄을 공백 제거 후 다중집합으로 비교한다.
    같으면 실질 내용은 그대로이고 포맷만 바뀐 것이다.

    전체 재포맷(prettier, black) 커밋이 기여도로 잡히는 것을 막는다.
    """
    lines = parse_patch(patch)
    if not lines.added and not lines.removed:
        return False
    added = sorted(_normalize(x) for x in lines.added if _normalize(x))
    removed = sorted(_normalize(x) for x in lines.removed if _normalize(x))
    if not added and not removed:
        return False
    return added == removed


def meaningful_lines_in_patch(patch: str | None) -> int:
    """실질 변경 라인 수.

    포맷팅만 바뀐 라인 쌍을 상쇄하고 남은 것만 센다.
    부분 재포맷이 섞인 PR도 실질 변경분만 잡힌다.
    """
    lines = parse_patch(patch)
    added = [_normalize(x) for x in lines.added]
    removed = [_normalize(x) for x in lines.removed]

    # 공백만 있던 줄은 무시
    added = [x for x in added if x]
    removed = [x for x in removed if x]

    # 양쪽에 동일하게 존재하는 정규화 라인은 이동/재포맷으로 보고 상쇄
    removed_pool: dict[str, int] = {}
    for line in removed:
        removed_pool[line] = removed_pool.get(line, 0) + 1

    net_added = 0
    for line in added:
        if removed_pool.get(line, 0) > 0:
            removed_pool[line] -= 1  # 상쇄
        else:
            net_added += 1

    net_removed = sum(removed_pool.values())
    return net_added + net_removed


# ── 파일 단위 집계 ────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class ChangedFile:
    """GitHub PR files API 응답의 필요한 부분만."""

    filename: str
    status: str = "modified"  # added | modified | removed | renamed
    additions: int = 0
    deletions: int = 0
    patch: str | None = None
    previous_filename: str | None = None


@dataclass(frozen=True, slots=True)
class DiffSummary:
    meaningful_lines: int
    weighted_lines: float
    test_lines: int
    excluded_files: int
    counted_files: int
    trivial_files: int

    @property
    def has_tests(self) -> bool:
        return self.test_lines > 0


# 한 PR이 기여도를 독점하지 못하게 하는 상한.
# 초기 스캐폴딩 PR 하나가 전체를 삼키는 것을 막는다.
MAX_LINES_PER_PR = 400

# 파일 하나에서 이 줄 수 이하로 바뀐 것은 '사소한 변경'으로 본다.
# 오타 수정, 상수 하나 변경 등.
TRIVIAL_FILE_LINES = 2

# 사소한 변경에 적용하는 감쇠 계수.
#
# 0으로 하지 않는 이유: 한 줄짜리 중요한 버그 수정이 실제로 존재한다.
# 1로 하지 않는 이유: 오타 PR을 대량 생성하는 조작이 성립한다.
# 값 자체에 실증적 근거는 없다 — 조정 가능한 정책값이다.
TRIVIAL_WEIGHT = 0.25


def summarize_diff(files: list[ChangedFile], *, cap: int = MAX_LINES_PER_PR) -> DiffSummary:
    """PR의 실질 변경량을 요약한다.

    ``meaningful_lines`` 는 화면 표시용 실제 줄 수,
    ``weighted_lines`` 는 점수 계산용으로 사소한 변경을 감쇠시킨 값이다.
    """
    meaningful = 0
    weighted = 0.0
    test_lines = 0
    excluded = 0
    counted = 0
    trivial = 0

    for f in files:
        if is_excluded_path(f.filename):
            excluded += 1
            continue
        # 내용이 그대로인 파일 이동/리네임
        if f.status == "renamed" and not f.patch:
            excluded += 1
            continue
        if is_formatting_only(f.patch):
            excluded += 1
            continue

        # patch 가 없는 경우(대용량 파일 등)는 API 카운트로 대체한다
        lines = (
            meaningful_lines_in_patch(f.patch) if f.patch else f.additions + f.deletions
        )

        if lines <= 0:
            excluded += 1
            continue

        counted += 1
        meaningful += lines
        if lines <= TRIVIAL_FILE_LINES:
            trivial += 1
            weighted += lines * TRIVIAL_WEIGHT
        else:
            weighted += lines
        if is_test_path(f.filename):
            test_lines += lines

    return DiffSummary(
        meaningful_lines=min(meaningful, cap),
        weighted_lines=min(weighted, float(cap)),
        test_lines=min(test_lines, cap),
        excluded_files=excluded,
        counted_files=counted,
        trivial_files=trivial,
    )
