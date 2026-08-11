"""`speaker_source` 어휘가 **다섯 곳에서 갈라지지 않는가.**

이 열은 "누가 말했는지를 얼마나 믿을 수 있는가" 를 담습니다. 신뢰도의
입력이고, 신뢰도는 사람의 기여를 말하는 숫자에 곱해집니다. 여기가 어긋나면
조용히 틀린 기여도가 나옵니다.

허용값 목록이 **다섯 군데**에 따로 적혀 있었고 이미 갈라져 있었습니다:

    video/speaker.py   enum 일곱 개 — 설명은 "utterances 에 저장된다"
    db/models.py       CHECK 제약 네 개 — 나머지 셋을 거절
    migrations/…       CHECK 제약 네 개 — **실제로 도는 것**
    scoring_service    ("track","manual")
    meeting_pipeline   ("track","manual")  ← 같은 판단의 두 번째 벌

`fuse()` 는 `fused`·`conflict`·`video_asd` 를 만들어 내는데 데이터베이스가
그걸 거절합니다. 융합 로직에는 테스트가 다 붙어 있는데 결과를 저장할 수가
없었고, enum 의 설명은 저장된다고 말하고 있었습니다.

지금은 `db/vocab.py` 한 곳이 원본이고, 이 파일이 나머지 넷을 거기에
묶어 둡니다.
"""

from __future__ import annotations

import re
from pathlib import Path

from sqlalchemy import CheckConstraint

from teamflow.db import models as m
from teamflow.db import vocab
from teamflow.db.vocab import SpeakerSource

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = REPO_ROOT / "backend" / "migrations" / "versions"
EVIDENCE_TS = REPO_ROOT / "frontend" / "src" / "lib" / "review" / "evidence.ts"

# `IN ('a','b')` 안의 값들.
_IN_LIST = re.compile(r"speaker_source\s+IN\s*\(([^)]*)\)")
_QUOTED = re.compile(r"'([a-z_]+)'")


def _values_in(sql: str) -> set[str]:
    match = _IN_LIST.search(sql)
    assert match is not None, f"`speaker_source IN (...)` 를 못 찾았습니다:\n{sql}"
    return set(_QUOTED.findall(match.group(1)))


# ══════════════════════════════════════════════════════════════
# 1. 분류가 빠짐없고 겹치지 않는가
# ══════════════════════════════════════════════════════════════


def test_every_value_is_either_stored_or_explicitly_not_yet():
    """새 값을 만들면 **저장되는지 아닌지 반드시 적게** 합니다.

    안 적으면 그 값은 어느 쪽도 아닌 채로 코드에 떠 있게 되고, 그게 바로
    `fused`·`conflict`·`video_asd` 가 몇 달 동안 있던 상태입니다.
    """
    everything = set(SpeakerSource)
    classified = vocab.STORED | vocab.NOT_STORED_YET

    unclassified = everything - classified
    assert not unclassified, (
        "저장되는 값인지 아닌지 안 적힌 것이 있습니다 — `db/vocab.py` 의 "
        f"STORED 나 NOT_STORED_YET 에 넣으십시오: {sorted(unclassified)}"
    )
    both = vocab.STORED & vocab.NOT_STORED_YET
    assert not both, f"양쪽에 다 들어 있습니다: {sorted(both)}"
    assert classified == everything


def test_certain_and_uncertain_cover_exactly_what_can_be_stored():
    """**저장 가능한 값은 전부 "확정인가" 가 정해져 있어야 합니다.**

    조용히 불확실 쪽으로 떨어지면 신뢰도가 왜 내려갔는지 아무도 모릅니다.
    반대로 조용히 확정으로 세면 **추정이 사실이 됩니다** — 이 제품에서
    제일 하면 안 되는 것입니다.
    """
    covered = vocab.CERTAIN | vocab.UNCERTAIN
    missing = vocab.STORED - covered
    assert not missing, (
        "저장은 되는데 확정인지 아닌지 안 정한 값입니다 — `db/vocab.py` 의 "
        f"CERTAIN 이나 UNCERTAIN 에 넣으십시오: {sorted(missing)}"
    )
    extra = covered - vocab.STORED
    assert not extra, (
        "저장도 못 하는 값을 확정/불확실로 세고 있습니다: " f"{sorted(extra)}"
    )
    both = vocab.CERTAIN & vocab.UNCERTAIN
    assert not both, f"확정이면서 불확실입니다: {sorted(both)}"


def test_a_guess_is_never_counted_as_certain():
    """`voiceprint` 는 **확정이 아닙니다.**

    유사도가 아무리 높아도 추정입니다. 추정을 확정으로 세면 신뢰도가 실제보다
    높게 나오고, 그 숫자로 사람의 기여를 말하게 됩니다 (docs/05 §5).
    """
    assert SpeakerSource.VOICEPRINT not in vocab.CERTAIN
    assert SpeakerSource.DIARIZATION not in vocab.CERTAIN
    assert SpeakerSource.TRACK in vocab.CERTAIN
    assert SpeakerSource.MANUAL in vocab.CERTAIN


# ══════════════════════════════════════════════════════════════
# 2. 스키마가 어휘를 따라오는가
# ══════════════════════════════════════════════════════════════


def test_the_model_constraint_is_built_from_the_vocabulary():
    """모델의 CHECK 제약 == `STORED`."""
    checks = [
        c
        for c in m.Utterance.__table__.constraints
        if isinstance(c, CheckConstraint) and c.name == "ck_speaker_source"
    ]
    assert len(checks) == 1, "`ck_speaker_source` 가 하나가 아닙니다"

    declared = _values_in(str(checks[0].sqltext))
    expected = {str(v) for v in vocab.STORED}
    assert declared == expected, (
        f"모델 제약 {sorted(declared)} 가 vocab.STORED {sorted(expected)} 와 다릅니다"
    )


def _migration_chain() -> list[Path]:
    """`down_revision` 을 따라 처음 → 마지막 순서로 늘어놓는다."""
    by_revision: dict[str, tuple[Path, str | None]] = {}
    for path in MIGRATIONS.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        rev = re.search(r"^revision:?\s*(?::\s*str\s*)?=\s*['\"]([^'\"]+)", text, re.M)
        down = re.search(
            r"^down_revision[^=]*=\s*(?:['\"]([^'\"]+)['\"]|None)", text, re.M
        )
        assert rev is not None, f"{path.name} 에서 revision 을 못 읽었습니다"
        by_revision[rev.group(1)] = (path, down.group(1) if down else None)

    assert by_revision, "마이그레이션을 하나도 못 찾았습니다 — 경로가 틀렸습니다"

    parents = {down for _, down in by_revision.values() if down}
    heads = [r for r in by_revision if r not in parents]
    assert len(heads) == 1, f"head 가 하나가 아닙니다: {heads}"

    order: list[Path] = []
    cursor: str | None = heads[0]
    while cursor is not None:
        path, down = by_revision[cursor]
        order.append(path)
        cursor = down
    order.reverse()
    return order


def test_the_migration_that_actually_runs_matches_the_vocabulary():
    """⚠️ **실제 데이터베이스를 만드는 것은 마이그레이션입니다.**

    모델만 고치면 테스트(SQLite 를 모델에서 만듦)는 통과하는데 프로덕션은
    옛 제약을 그대로 들고 있습니다. 값을 늘리면 **새 마이그레이션이 필요**
    하다는 것을 여기서 알려 줍니다.
    """
    newest: Path | None = None
    for path in _migration_chain():
        if "ck_speaker_source" in path.read_text(encoding="utf-8"):
            newest = path

    assert newest is not None, "`ck_speaker_source` 를 만드는 마이그레이션이 없습니다"

    declared = _values_in(newest.read_text(encoding="utf-8"))
    expected = {str(v) for v in vocab.STORED}
    assert declared == expected, (
        f"`{newest.name}` 의 제약은 {sorted(declared)} 인데 vocab.STORED 는 "
        f"{sorted(expected)} 입니다. 값을 늘렸다면 **새 마이그레이션**이 필요합니다 "
        "— 모델만 고치면 배포된 데이터베이스는 계속 거절합니다."
    )


# ══════════════════════════════════════════════════════════════
# 3. 화면이 저장 가능한 값을 전부 아는가
# ══════════════════════════════════════════════════════════════


def test_the_screen_has_a_branch_for_every_value_it_can_receive():
    """`speakerNote` 가 **저장 가능한 값마다 제 가지를 갖는가.**

    ⚠️ 안 그러면 새 값이 catch-all 로 떨어져 "화자를 확정하지 못했습니다" 가
    나옵니다. `fused`(오디오·영상이 **일치**)에 그 문구가 붙으면 뜻이
    정반대가 됩니다 — 안전망이 답인 척하는 자리입니다.
    """
    source = EVIDENCE_TS.read_text(encoding="utf-8")
    body = source.split("export function speakerNote", 1)
    assert len(body) == 2, "`speakerNote` 를 못 찾았습니다 — 검사가 낡았습니다"
    body_text = body[1].split("\nexport ", 1)[0]

    missing = [
        str(v)
        for v in sorted(vocab.STORED)
        if f"source === '{v}'" not in body_text
    ]
    assert not missing, (
        f"`{EVIDENCE_TS.relative_to(REPO_ROOT)}` 의 speakerNote 에 가지가 없는 "
        f"값입니다: {missing}. catch-all 로 떨어지면 뜻이 틀릴 수 있습니다."
    )


def test_values_we_cannot_store_are_not_pretended_to_be_handled():
    """아직 저장 못 하는 값에 **화면 가지를 미리 만들지 않습니다.**

    만들어 두면 "이미 되는 것" 으로 읽히고, 그게 이 저장소의 대표 실패
    ①(만들어 놓고 아무도 안 부름)입니다. 통로를 열 때 같이 만드십시오.
    """
    body_text = EVIDENCE_TS.read_text(encoding="utf-8")
    premature = [
        str(v) for v in sorted(vocab.NOT_STORED_YET) if f"source === '{v}'" in body_text
    ]
    assert not premature, (
        "아직 서버가 저장할 수 없는 값인데 화면이 이미 다루는 척합니다: "
        f"{premature}. `db/vocab.py` 의 STORED 로 옮기고 마이그레이션을 "
        "더한 뒤에 화면을 고치십시오."
    )
