"""diff 필터 단위 테스트."""

from __future__ import annotations

import pytest

from teamflow.contribution.diff_filter import (
    ChangedFile,
    is_excluded_path,
    is_formatting_only,
    is_test_path,
    meaningful_lines_in_patch,
    parse_patch,
    summarize_diff,
)


@pytest.mark.parametrize(
    "path",
    [
        "package-lock.json",
        "frontend/package-lock.json",
        "backend/poetry.lock",
        "Cargo.lock",
        "go.sum",
        "api/proto/service_pb2.py",
        "pkg/api/types.pb.go",
        "src/models_generated.ts",
        "alembic/migrations/0001_init.py",
        "node_modules/react/index.js",
        "vendor/github.com/pkg/errors/errors.go",
        "assets/logo.png",
        "docs/spec.pdf",
        "models/qwen3-asr.safetensors",
        "static/app.min.js",
    ],
)
def test_excluded_paths(path: str):
    assert is_excluded_path(path)


@pytest.mark.parametrize(
    "path",
    [
        "src/auth/login.py",
        "backend/teamflow/scoring.py",
        "frontend/app/page.tsx",
        "README.md",
        "docs/설계.md",
        "Dockerfile",
    ],
)
def test_included_paths(path: str):
    assert not is_excluded_path(path)


@pytest.mark.parametrize(
    "path",
    [
        "backend/tests/test_scoring.py",
        "src/utils_test.go",
        "frontend/app/page.test.tsx",
        "src/api.spec.ts",
    ],
)
def test_test_paths_recognized(path: str):
    assert is_test_path(path)


def test_parse_patch_ignores_headers_and_context():
    patch = (
        "diff --git a/x.py b/x.py\n"
        "index abc..def 100644\n"
        "--- a/x.py\n"
        "+++ b/x.py\n"
        "@@ -1,3 +1,3 @@\n"
        " unchanged = 1\n"
        "-old = 2\n"
        "+new = 2\n"
    )
    lines = parse_patch(patch)
    assert lines.added == ["new = 2"]
    assert lines.removed == ["old = 2"]


def test_parse_patch_handles_none():
    lines = parse_patch(None)
    assert lines.added == []
    assert lines.removed == []


def test_indentation_change_is_formatting_only():
    patch = "@@ -1,2 +1,2 @@\n-  a = 1\n-  b = 2\n+    a = 1\n+    b = 2\n"
    assert is_formatting_only(patch)


def test_line_reorder_is_formatting_only():
    """줄 순서만 바뀐 것도 실질 변경이 아니다."""
    patch = "@@ -1,2 +1,2 @@\n-a = 1\n-b = 2\n+b = 2\n+a = 1\n"
    assert is_formatting_only(patch)


def test_real_change_is_not_formatting_only():
    patch = "@@ -1,1 +1,1 @@\n-a = 1\n+a = 2\n"
    assert not is_formatting_only(patch)


def test_empty_patch_is_not_formatting_only():
    assert not is_formatting_only("")
    assert not is_formatting_only(None)


def test_meaningful_lines_cancels_reformatted_pairs():
    """재포맷된 줄은 상쇄되고 실질 변경만 남는다."""
    patch = (
        "@@ -1,3 +1,3 @@\n"
        "-  keep = 1\n"  # 들여쓰기만 변경 → 상쇄
        "-  changed = 2\n"
        "+    keep = 1\n"
        "+    changed = 99\n"  # 실제 변경
    )
    # keep 은 상쇄, changed=2 삭제 + changed=99 추가 → 2줄
    assert meaningful_lines_in_patch(patch) == 2


def test_pure_addition_counts_all_lines():
    patch = "@@ -0,0 +1,3 @@\n+a = 1\n+b = 2\n+c = 3\n"
    assert meaningful_lines_in_patch(patch) == 3


def test_whitespace_only_lines_ignored():
    patch = "@@ -0,0 +1,3 @@\n+\n+   \n+real = 1\n"
    assert meaningful_lines_in_patch(patch) == 1


def test_summarize_excludes_lockfile_but_keeps_source():
    files = [
        ChangedFile(
            filename="package-lock.json",
            additions=3000,
            patch="@@ -1,1 +1,2 @@\n+  \"x\": \"1\",\n",
        ),
        ChangedFile(
            filename="src/app.py",
            status="added",
            additions=3,
            patch="@@ -0,0 +1,3 @@\n+a = 1\n+b = 2\n+c = 3\n",
        ),
    ]
    summary = summarize_diff(files)
    assert summary.meaningful_lines == 3
    assert summary.excluded_files == 1
    assert summary.counted_files == 1


def test_summarize_applies_cap():
    huge = "@@ -0,0 +1,5000 @@\n" + "\n".join(f"+line{i} = {i}" for i in range(5000))
    summary = summarize_diff([ChangedFile(filename="src/big.py", patch=huge)])
    assert summary.meaningful_lines == 400  # MAX_LINES_PER_PR


def test_summarize_discounts_trivial_files():
    """1~2줄만 바뀐 파일은 감쇠된 가중치로 계산된다."""
    trivial = ChangedFile(
        filename="README.md",
        patch="@@ -1,1 +1,1 @@\n-typo\n+fixed\n",
    )
    summary = summarize_diff([trivial])
    assert summary.meaningful_lines == 2
    assert summary.weighted_lines == pytest.approx(0.5)  # 2 * 0.25
    assert summary.trivial_files == 1


def test_summarize_does_not_discount_substantial_files():
    patch = "@@ -0,0 +1,50 @@\n" + "\n".join(f"+x{i} = {i}" for i in range(50))
    summary = summarize_diff([ChangedFile(filename="src/a.py", patch=patch)])
    assert summary.weighted_lines == pytest.approx(float(summary.meaningful_lines))
    assert summary.trivial_files == 0


def test_renamed_without_patch_is_excluded():
    files = [
        ChangedFile(
            filename="src/new_name.py",
            status="renamed",
            previous_filename="src/old_name.py",
        )
    ]
    summary = summarize_diff(files)
    assert summary.meaningful_lines == 0
    assert summary.excluded_files == 1


def test_test_lines_tracked_separately():
    files = [
        ChangedFile(
            filename="src/a.py",
            patch="@@ -0,0 +1,10 @@\n" + "\n".join(f"+a{i}=1" for i in range(10)),
        ),
        ChangedFile(
            filename="tests/test_a.py",
            patch="@@ -0,0 +1,20 @@\n" + "\n".join(f"+assert a{i}" for i in range(20)),
        ),
    ]
    summary = summarize_diff(files)
    assert summary.meaningful_lines == 30
    assert summary.test_lines == 20
    assert summary.has_tests
