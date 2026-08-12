"""열의 허용값이 **여러 곳에서 갈라지지 않는가.**

두 열을 봅니다.

* `utterances.speaker_source` — 실제로 갈라져 있었습니다 (아래).
* `recording_consents.consent_type` — 아직 안 갈라졌습니다. 같은 모양으로
  세 곳(서비스 상수 · CHECK 제약 · 마이그레이션)에 적혀 있었고, **갈라진
  뒤에 옮기면 그 사이에 무슨 일이 있었는지 아무도 모릅니다.** 이쪽이
  갈라지면 법적 요구가 갈라집니다 — 서비스가 받아 준 동의를 데이터베이스가
  거절하면 사람은 "동의했다" 고 알고 있는데 기록이 없습니다.

---

`speaker_source` 어휘가 **다섯 곳에서 갈라지지 않는가.**

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

_QUOTED = re.compile(r"'([a-z_]+)'")


def _values_in(sql: str, column: str) -> set[str]:
    """`<column> IN ('a','b')` 안의 값들."""
    match = re.search(rf"{column}\s+IN\s*\(([^)]*)\)", sql)
    assert match is not None, f"`{column} IN (...)` 를 못 찾았습니다:\n{sql}"
    return set(_QUOTED.findall(match.group(1)))


def _model_constraint(table, name: str, column: str) -> set[str]:
    checks = [
        c
        for c in table.constraints
        if isinstance(c, CheckConstraint) and c.name == name
    ]
    assert len(checks) == 1, f"`{name}` 가 하나가 아닙니다"
    return _values_in(str(checks[0].sqltext), column)


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
    declared = _model_constraint(
        m.Utterance.__table__, "ck_speaker_source", "speaker_source"
    )
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


def _newest_migration_values(constraint: str, column: str) -> tuple[Path, set[str]]:
    """제약을 **마지막으로** 선언한 마이그레이션과 그 값들."""
    newest: Path | None = None
    for path in _migration_chain():
        if constraint in path.read_text(encoding="utf-8"):
            newest = path
    assert newest is not None, f"`{constraint}` 를 만드는 마이그레이션이 없습니다"
    return newest, _values_in(newest.read_text(encoding="utf-8"), column)


def test_the_migration_that_actually_runs_matches_the_vocabulary():
    """⚠️ **실제 데이터베이스를 만드는 것은 마이그레이션입니다.**

    모델만 고치면 테스트(SQLite 를 모델에서 만듦)는 통과하는데 프로덕션은
    옛 제약을 그대로 들고 있습니다. 값을 늘리면 **새 마이그레이션이 필요**
    하다는 것을 여기서 알려 줍니다.
    """
    newest, declared = _newest_migration_values("ck_speaker_source", "speaker_source")
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


# ══════════════════════════════════════════════════════════════
# 4. recording_consents.consent_type — 아직 안 갈라진 쪽
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 위 `speaker_source` 와 **같은 모양**이라 여기 같이 둡니다. 갈라진 것을
#    고치는 것보다 안 갈라지게 두는 쪽이 싸고, 이 열은 갈라지면 법적 요구가
#    갈라집니다 (docs/07 P3).


def test_the_consent_service_and_the_database_accept_the_same_things():
    """서비스가 받아 주는 값 == 데이터베이스가 받아 주는 값.

    ⚠️ 한쪽만 넓으면 둘 중 하나입니다 — 서비스가 통과시킨 동의를 DB 가
    거절하거나(사람은 동의했다고 아는데 기록이 없음), 검증 없이 아무 값이나
    들어가거나. 둘 다 "동의를 받았다" 는 말을 못 믿게 만듭니다.
    """
    from teamflow.services import recording_service

    service_side = set(recording_service.CONSENT_TYPES)
    db_side = _model_constraint(
        m.RecordingConsent.__table__, "ck_consent_type", "consent_type"
    )
    vocab_side = {str(c) for c in vocab.CONSENT_STORED}

    assert service_side == vocab_side, (
        f"서비스 {sorted(service_side)} 가 vocab {sorted(vocab_side)} 와 다릅니다"
    )
    assert db_side == vocab_side, (
        f"CHECK 제약 {sorted(db_side)} 가 vocab {sorted(vocab_side)} 와 다릅니다"
    )


def test_the_consent_migration_matches_too():
    """배포된 데이터베이스도 같은 셋을 받는가."""
    newest, declared = _newest_migration_values("ck_consent_type", "consent_type")
    expected = {str(c) for c in vocab.CONSENT_STORED}
    assert declared == expected, (
        f"`{newest.name}` 의 제약은 {sorted(declared)} 인데 vocab 은 "
        f"{sorted(expected)} 입니다 — 새 마이그레이션이 필요합니다."
    )


def test_only_the_recording_consent_is_required():
    """⚠️ **②③ 은 거부해도 서비스가 돌아야 합니다** (docs/07 P3).

    필요 최소 수집 원칙입니다. 거부를 못 하게 만들면 그건 동의가 아니라
    통보입니다. 필수 목록이 늘어나면 여기서 터집니다 — 그건 제품이 아니라
    **법적 성격이 바뀌는** 변경이라 조용히 지나가면 안 됩니다.
    """
    assert set(vocab.CONSENT_REQUIRED) == {vocab.ConsentType.RECORDING}
    optional = vocab.CONSENT_STORED - vocab.CONSENT_REQUIRED
    assert optional == {
        vocab.ConsentType.RAW_AUDIO_RETENTION,
        vocab.ConsentType.VOICEPRINT_STORAGE,
    }


# ══════════════════════════════════════════════════════════════
# 5. reports.report_type — 주석 한 줄이 전부였던 쪽
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 이 열은 위 둘보다 **한 발 더 간 상태**였습니다. `speaker_source` 는
#    적어도 CHECK 제약이 있었고(값이 갈라졌을 뿐), 이쪽은 허용값이 주석
#    한 줄로만 있었습니다:
#
#        # weekly | final | meeting_minutes
#
#    주석은 아무것도 막지 않습니다. 그리고 그 표에는 **쓰는 코드가 0곳**
#    이었으므로 아무도 알아차릴 일이 없었습니다 — 대표 실패 ①("만들어 놓고
#    아무도 안 부름")이 스키마에 남아 있던 자리입니다.


def test_every_report_type_says_what_it_is_tied_to():
    """**새 종류를 넣으면 "무엇 하나에 매이는가" 를 반드시 정하게** 합니다.

    ⚠️ 이게 곧 다시 만들 때 무엇을 갈아끼우는지입니다. 안 정하면 재생성이
    갈아끼우기가 아니라 **쌓기**가 됩니다 — 이 저장소는 그 결함을 이미 한 번
    당했습니다(미해결 사안이 재처리마다 한 벌씩 쌓였습니다).
    """
    missing = set(vocab.ReportType) - set(vocab.REPORT_SCOPE)
    assert not missing, (
        "무엇에 매이는지 안 적힌 보고서 종류입니다 — `db/vocab.py` 의 "
        f"REPORT_SCOPE 에 넣으십시오: {sorted(missing)}"
    )
    extra = set(vocab.REPORT_SCOPE) - set(vocab.ReportType)
    assert not extra, f"없는 종류에 자리를 준 것: {sorted(extra)}"


def test_a_report_that_carries_contribution_numbers_is_declared_as_such():
    """사람별 기여도 수치가 들어가는 보고서는 **그렇다고 적혀 있어야** 합니다.

    ⚠️ 보고서는 **앱 밖으로 나가는 문서**입니다. 복사돼서 제출물·메일·발표
    자료가 됩니다. 화면이라면 CSS 가드와 렌더 검사가 막아 주지만 **글자가
    되어 나간 뒤에는 아무 가드도 안 닿습니다.** 그래서 어느 종류가 그 수치를
    이고 다니는지를 여기 한 번 적고, 생성기 쪽 테스트가 그 종류에 대해
    순위 금지·구간·측정 불가 표시를 다시 잽니다.
    """
    unknown = vocab.CARRIES_CONTRIBUTION - set(vocab.ReportType)
    assert not unknown, f"없는 종류입니다: {sorted(unknown)}"

    # 회의록은 **일부러** 빠져 있습니다. 사람별 발언 수를 넣으면 그 순간
    # 순위표가 됩니다 — "많이 말한 사람" 은 기여가 아니라 발언량입니다.
    assert vocab.ReportType.MEETING_MINUTES not in vocab.CARRIES_CONTRIBUTION
    assert vocab.ReportType.WEEKLY in vocab.CARRIES_CONTRIBUTION
    assert vocab.ReportType.FINAL in vocab.CARRIES_CONTRIBUTION


def test_the_report_model_constraint_is_built_from_the_vocabulary():
    """모델의 CHECK 제약 == `ReportType` 전부."""
    declared = _model_constraint(m.Report.__table__, "ck_report_type", "report_type")
    expected = {str(r) for r in vocab.ReportType}
    assert declared == expected, (
        f"모델 제약 {sorted(declared)} 가 vocab {sorted(expected)} 와 다릅니다"
    )


def test_the_report_migration_matches_too():
    """배포된 데이터베이스도 같은 셋을 받는가.

    ⚠️ 마이그레이션 파일은 값을 **박아** 둡니다. 거기서 `vocab` 을 import 해
    문자열을 만들면 vocab 을 고칠 때 파일 글자도 같이 움직여 이 검사가 항상
    통과합니다 — 정작 이미 적용된 데이터베이스는 옛 제약을 그대로 들고 있는데.
    """
    newest, declared = _newest_migration_values("ck_report_type", "report_type")
    expected = {str(r) for r in vocab.ReportType}
    assert declared == expected, (
        f"`{newest.name}` 의 제약은 {sorted(declared)} 인데 vocab 은 "
        f"{sorted(expected)} 입니다 — 새 마이그레이션이 필요합니다."
    )


def test_regenerating_a_report_cannot_stack():
    """유일 제약이 **데이터베이스 쪽에** 있는가.

    서비스가 "있으면 갈아끼운다" 를 지키는 것만으로는 부족합니다. 다른 경로가
    하나 생기는 순간(배치 작업·재처리·수동 스크립트) 갈라지고, 쌓이기 시작해도
    **오류가 안 납니다** — 그냥 최종 보고서가 두 벌이 됩니다.
    """
    from sqlalchemy import UniqueConstraint

    uniques = [
        c
        for c in m.Report.__table__.constraints
        if isinstance(c, UniqueConstraint) and c.name == "uq_report_scope"
    ]
    assert uniques, "`uq_report_scope` 가 없습니다 — 재생성이 쌓입니다"
    columns = [c.name for c in uniques[0].columns]
    assert columns == ["project_id", "report_type", "scope_key"], columns

    # ⚠️ 널이 섞이면 유일 제약은 아무것도 안 막습니다 — 널은 서로 다른 값으로
    #    쳐서 같은 행이 몇 번이고 들어갑니다. 그래서 `scope_key` 는 NOT NULL.
    assert m.Report.__table__.c.scope_key.nullable is False, (
        "`scope_key` 가 널을 받으면 유일 제약이 최종 보고서를 못 막습니다"
    )


# ══════════════════════════════════════════════════════════════
# 6. meeting_events.event_type — 주석뿐이었고, **넷은 만들지도 않던** 쪽
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 같은 결함의 **세 번째 사례**입니다. `speaker_source` 는 값이 갈라져
#    있었고, `report_type` 은 주석 한 줄이 전부였으며, 이 열은 **둘 다**
#    였습니다 — 제약이 없고, 주석이 선언한 다섯 중 넷은 만드는 코드가
#    0곳입니다.
#
#    그 넷이 요구사항 정의서 §12 의 AI-REVIEW-001·003·004·006 이라,
#    이 주석이 **요구가 이미 구현된 것처럼** 보이게 만들고 있었습니다.


def test_every_event_type_says_whether_anything_produces_it():
    """새 값을 넣으면 **탐지기가 있는지 없는지 반드시 적게** 합니다.

    안 적으면 그 값은 어느 쪽도 아닌 채로 떠 있게 되고, 그게 바로
    `repeated_discussion` 을 비롯한 넷이 오래 있던 상태입니다.
    """
    everything = set(vocab.MeetingEventType)
    classified = vocab.EVENT_PRODUCED | vocab.EVENT_NOT_PRODUCED_YET

    missing = everything - classified
    assert not missing, (
        "탐지기가 있는지 안 적힌 이벤트 종류입니다 — `db/vocab.py` 의 "
        f"EVENT_PRODUCED 나 EVENT_NOT_PRODUCED_YET 에 넣으십시오: {sorted(missing)}"
    )
    both = vocab.EVENT_PRODUCED & vocab.EVENT_NOT_PRODUCED_YET
    assert not both, f"양쪽에 다 들어 있습니다: {sorted(both)}"


def test_what_we_claim_to_produce_is_actually_produced():
    """⭐ **"만들어진다" 고 적은 값은 진짜 만드는 코드가 있어야 합니다.**

    이게 이 파일에서 제일 중요한 검사입니다. 반대 방향(만든다고 적었는데
    코드가 없음)이 바로 이 저장소의 대표 실패 ① 이고, 그 상태가 오래
    들키지 않았던 이유는 **아무도 대조해 보지 않았기** 때문입니다.
    """
    produced_in_code: set[str] = set()
    for path in (REPO_ROOT / "backend" / "teamflow").rglob("*.py"):
        if path.name == "vocab.py":
            continue
        text = path.read_text(encoding="utf-8")
        for value in vocab.MeetingEventType:
            if f'"{value}"' in text or f"'{value}'" in text:
                produced_in_code.add(str(value))

    claimed = {str(v) for v in vocab.EVENT_PRODUCED}
    missing = claimed - produced_in_code
    assert not missing, (
        f"만들어진다고 적혀 있는데 코드에 없습니다: {sorted(missing)} — "
        "탐지기를 지웠다면 EVENT_NOT_PRODUCED_YET 으로 옮기십시오"
    )

    surprise = produced_in_code - claimed
    assert not surprise, (
        f"탐지기가 생겼는데 아직 EVENT_NOT_PRODUCED_YET 에 있습니다: {sorted(surprise)} — "
        "`db/vocab.py` 에서 EVENT_PRODUCED 로 옮기십시오. 옮기지 않으면 "
        "`docs/20` 대조표가 계속 '미구현' 이라고 말합니다"
    )


def test_the_meeting_event_model_constraint_is_built_from_the_vocabulary():
    declared = _model_constraint(
        m.MeetingEvent.__table__, "ck_meeting_event_type", "event_type"
    )
    expected = {str(e) for e in vocab.MeetingEventType}
    assert declared == expected, (
        f"모델 제약 {sorted(declared)} 가 vocab {sorted(expected)} 와 다릅니다"
    )


def test_the_meeting_event_migration_matches_too():
    newest, declared = _newest_migration_values("ck_meeting_event_type", "event_type")
    expected = {str(e) for e in vocab.MeetingEventType}
    assert declared == expected, (
        f"`{newest.name}` 의 제약은 {sorted(declared)} 인데 vocab 은 "
        f"{sorted(expected)} 입니다 — 새 마이그레이션이 필요합니다."
    )
