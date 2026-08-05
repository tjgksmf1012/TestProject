"""패키징·배포 설정 무결성.

**실제로 일어난 사고 두 건을 막기 위한 테스트입니다.**

1. `docker-compose.yml` 이 `docker/Dockerfile.api` 를 가리키는데 **그 파일이
   존재한 적이 없었습니다.** `docker compose --profile app up` 이 그냥 실패합니다.
   compose 는 파싱만으로는 아무 불평도 하지 않습니다.

2. `numpy` 가 `ai` 엑스트라에만 있었는데, `api.main` 이 전이적으로
   (recording_service → audio.assembly) 모듈 최상위에서 numpy 를 씁니다.
   기본 설치로는 **API 가 import 조차 되지 않습니다.** 개발 환경에는 numpy 가
   우연히 깔려 있어서 테스트가 전부 통과했습니다.

두 건 다 "테스트는 다 통과하는데 배포하면 안 되는" 종류입니다.
"""

from __future__ import annotations

import ast
import sys
import tomllib
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = REPO_ROOT / "pyproject.toml"
COMPOSE = REPO_ROOT / "docker-compose.yml"
PACKAGE = REPO_ROOT / "backend" / "teamflow"


def _pyproject() -> dict:
    return tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))


def _requirement_names(entries: list[str]) -> set[str]:
    """`"psycopg[binary]>=3.2"` → `psycopg`"""
    names = set()
    for entry in entries:
        name = entry.split("[")[0]
        for sep in (">=", "==", "<=", "~=", ">", "<", "!="):
            name = name.split(sep)[0]
        names.add(name.strip().lower().replace("_", "-"))
    return names


# 파이썬 모듈 이름과 배포 이름이 다른 것들.
_MODULE_TO_DISTRIBUTION = {
    "jwt": "pyjwt",
    "pydantic_settings": "pydantic-settings",
    "pyannote": "pyannote.audio",
    "yaml": "pyyaml",
    "dateutil": "python-dateutil",
}


# ══════════════════════════════════════════════════════════════
# Docker
# ══════════════════════════════════════════════════════════════


def _dockerfiles_referenced_by_compose() -> list[str]:
    """compose 가 참조하는 dockerfile 경로들.

    YAML 파서를 의존성에 더하지 않으려고 직접 훑는다. 형식이 단순해서
    정규식 하나로 충분하고, 이 테스트 때문에 배포 의존성이 늘면 본말전도다.
    """
    import re

    return re.findall(r"^\s*dockerfile:\s*(\S+)\s*$", COMPOSE.read_text("utf-8"), re.MULTILINE)


def test_compose_file_exists():
    assert COMPOSE.exists()


def test_every_referenced_dockerfile_exists():
    """⭐ compose 는 없는 dockerfile 을 가리켜도 파싱 단계에서는 조용하다.

    `docker compose --profile app up` 을 처음 돌리는 순간에야 알게 된다.
    """
    referenced = _dockerfiles_referenced_by_compose()
    assert referenced, "compose 에 build.dockerfile 항목이 없습니다 — 패턴이 바뀌었나요?"

    missing = [p for p in referenced if not (REPO_ROOT / p).is_file()]
    assert not missing, f"compose 가 가리키는 파일이 없습니다: {missing}"


def test_worker_images_install_ffmpeg():
    """⭐ ffmpeg 없이는 청크가 하나도 디코딩되지 않는다.

    `audio/decode.py` 가 `DecoderUnavailable` 로 크게 터지게 해 뒀지만,
    애초에 이미지에 들어 있어야 한다.
    """
    for path in _dockerfiles_referenced_by_compose():
        text = (REPO_ROOT / path).read_text("utf-8")
        assert "ffmpeg" in text, f"{path} 에 ffmpeg 설치가 없습니다"


def test_dockerfiles_copy_the_backend():
    for path in _dockerfiles_referenced_by_compose():
        text = (REPO_ROOT / path).read_text("utf-8")
        assert "backend/" in text, f"{path} 가 backend 를 복사하지 않습니다"


# ══════════════════════════════════════════════════════════════
# 의존성 선언
# ══════════════════════════════════════════════════════════════


def _top_level_imports(path: Path) -> set[str]:
    """**모듈 최상위**에서 import 하는 이름들.

    함수 안에서 지연 import 하는 건 세지 않는다. 그건 엑스트라여도 되고,
    실제로 `pipeline/runtime.py` 가 GPU 모델을 그렇게 다룬다.
    """
    tree = ast.parse(path.read_text("utf-8"), filename=str(path))
    names: set[str] = set()
    for node in tree.body:  # 최상위만 본다
        if isinstance(node, ast.Import):
            names.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_every_runtime_import_is_declared():
    """⭐ 기본 설치만으로 패키지가 import 되어야 한다.

    numpy 가 `ai` 엑스트라에만 있어서 기본 설치로는 API 가 죽는 상태였다.
    개발 환경에 우연히 깔려 있었기 때문에 아무 테스트도 잡지 못했다.
    """
    declared = _requirement_names(_pyproject()["project"]["dependencies"])
    stdlib = sys.stdlib_module_names

    undeclared: dict[str, set[str]] = {}
    for path in sorted(PACKAGE.rglob("*.py")):
        for module in _top_level_imports(path):
            if module in stdlib or module == "teamflow":
                continue
            distribution = _MODULE_TO_DISTRIBUTION.get(module, module).lower()
            if distribution not in declared:
                undeclared.setdefault(distribution, set()).add(
                    str(path.relative_to(REPO_ROOT))
                )

    assert not undeclared, (
        "모듈 최상위에서 쓰는데 기본 의존성에 없습니다. 기본 설치로는 "
        "import 자체가 실패합니다:\n"
        + "\n".join(f"  {dist}: {sorted(files)}" for dist, files in sorted(undeclared.items()))
    )


def test_numpy_is_a_base_dependency_not_an_extra():
    """위 테스트가 잡은 실제 사고를 이름으로도 못 박아 둔다."""
    base = _requirement_names(_pyproject()["project"]["dependencies"])
    extras = _requirement_names(_pyproject()["project"]["optional-dependencies"]["ai"])

    assert "numpy" in base
    assert "numpy" not in extras, "양쪽에 두면 버전이 갈라진다"


def test_ai_extra_is_only_used_lazily():
    """GPU 라이브러리는 **함수 안에서만** import 해야 한다.

    최상위에서 import 하면 CPU 워커와 API 가 torch 없이는 못 뜬다.
    """
    gpu_modules = {"torch", "torchaudio", "transformers", "pyannote", "vllm", "soundfile"}

    offenders: list[str] = []
    for path in sorted(PACKAGE.rglob("*.py")):
        eager = _top_level_imports(path) & gpu_modules
        if eager:
            offenders.append(f"{path.relative_to(REPO_ROOT)}: {sorted(eager)}")

    assert not offenders, (
        "GPU 라이브러리를 최상위에서 import 하고 있습니다:\n" + "\n".join(offenders)
    )


def test_python_version_matches_the_dockerfiles():
    """pyproject 가 3.11+ 인데 이미지가 3.10 이면 빌드 후에야 안다."""
    requires = _pyproject()["project"]["requires-python"]
    assert requires == ">=3.11"

    for path in _dockerfiles_referenced_by_compose():
        text = (REPO_ROOT / path).read_text("utf-8")
        assert "3.11" in text, f"{path} 가 python 3.11 을 쓰지 않습니다"


@pytest.mark.parametrize("extra", ["ai", "dev"])
def test_extras_are_declared(extra: str):
    assert extra in _pyproject()["project"]["optional-dependencies"]
