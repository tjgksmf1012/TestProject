"""열이 받을 수 있는 값 — **한 곳에서만 정합니다.**

⚠️ 이 파일이 생긴 이유: `speaker_source` 의 허용값이 **네 곳에 따로**
적혀 있었고, 이미 갈라져 있었습니다.

    video/speaker.py  SpeakerSource 에 일곱 개  (docstring: "utterances 에 저장된다")
    db/models.py      CHECK 제약에 네 개       (video 셋을 거부합니다)
    scoring_service   ("track", "manual")      확정으로 셈
    meeting_pipeline  ("track", "manual")      같은 판단을 다시 적음

즉 `fuse()` 가 만들어 내는 `fused`·`conflict`·`video_asd` 는 **데이터베이스가
거절합니다.** 융합 로직은 테스트까지 다 붙어 있는데 그 결과를 저장할 수가
없었고, 그런데도 enum 의 설명은 "저장된다" 고 말하고 있었습니다.

이 저장소의 대표 실패 둘이 겹친 자리입니다 — **두 벌이 있으면 한쪽만
고쳐진다** · **만들어 놓고 아무도 안 부름**. 그래서 값을 여기 한 번만 적고,
제약도 집계도 전부 여기서 끌어다 씁니다. 새 값을 넣으면 `STORED` 와
`CERTAIN`/`UNCERTAIN` 양쪽에서 자리를 정하기 전까지 테스트가 터집니다.

⚠️ **의존성이 없어야 합니다.** `db/models.py` 와 `video/speaker.py` 가 둘 다
여기를 가리키므로, 여기서 뭔가를 import 하면 순환이 생깁니다.
"""

from __future__ import annotations

from enum import StrEnum


class SpeakerSource(StrEnum):
    """화자 라벨이 **어떻게** 정해졌는가.

    ⚠️ 전부 저장되는 것은 아닙니다 — 아래 `STORED` 를 보십시오. 이 구분이
    없던 동안 enum 의 설명은 일곱 개가 다 저장된다고 말했고, 그중 셋은
    데이터베이스가 거절했습니다.
    """

    TRACK = "track"  # 멀티트랙 → 트랙이 곧 사람이라 확정
    VOICEPRINT = "voiceprint"  # 성문 임베딩 매칭 → 유사도가 붙는다
    MANUAL = "manual"  # 사람이 지정
    DIARIZATION = "diarization"  # SPEAKER_XX 미매핑 → 누구인지 모른다
    VIDEO_ASD = "video_asd"  # 영상 단독 (docs/12)
    FUSED = "fused"  # 오디오 + 영상 일치
    CONFLICT = "conflict"  # 오디오 ≠ 영상 → 사람이 봐야 한다


#: 지금 `utterances.speaker_source` 에 **실제로 들어갈 수 있는** 값.
#: `db/models.py` 의 CHECK 제약이 이걸 그대로 씁니다.
STORED: frozenset[SpeakerSource] = frozenset(
    {
        SpeakerSource.TRACK,
        SpeakerSource.VOICEPRINT,
        SpeakerSource.MANUAL,
        SpeakerSource.DIARIZATION,
    }
)

#: 아직 저장 못 하는 값과 **그 이유**.
#:
#: ⚠️ 셋 다 영상 경로에서 나옵니다. `video/speaker.py` 의 융합 로직은 다
#: 만들어져 있고 순수 계산이라 테스트도 붙어 있지만, **그 앞단(Light-ASD
#: 모델·얼굴 검출)이 GPU 가 없어 아직 없습니다.** 앞단이 없으니 이 값을
#: 만들어 낼 프로덕션 경로가 없고, 없는 값을 받는 제약을 미리 열어 두면
#: "된다" 고 읽힙니다.
#:
#: ⚠️ 열 때 같이 정해야 하는 것: `conflict` 를 사람이 **어디서** 보는가.
#: "사람이 봐야 한다" 는 값을 저장만 하고 볼 화면이 없으면, 이 저장소가
#: 반복해 당한 실패 ③("할 일을 알려 주고 그 일을 할 자리를 안 줌")입니다.
NOT_STORED_YET: frozenset[SpeakerSource] = frozenset(
    {
        SpeakerSource.VIDEO_ASD,
        SpeakerSource.FUSED,
        SpeakerSource.CONFLICT,
    }
)

#: 화자가 **확정된** 것으로 세는 값. 신뢰도의 입력입니다 (docs/06 §4).
#:
#: ⚠️ `voiceprint` 는 여기 없습니다. 유사도가 아무리 높아도 추정입니다 —
#: 추정을 확정으로 세면 신뢰도가 실제보다 높게 나오고, 그 숫자로 사람의
#: 기여를 말하게 됩니다.
CERTAIN: frozenset[SpeakerSource] = frozenset(
    {
        SpeakerSource.TRACK,
        SpeakerSource.MANUAL,
    }
)

#: 저장은 되지만 **확정이 아닌** 값.
#:
#: `CERTAIN` 과 이것이 합쳐 `STORED` 를 덮어야 합니다 — 테스트가 봅니다.
#: 새 값을 저장 가능하게 만드는 사람이 "이건 확정인가" 를 **반드시 한 번
#: 정하게** 하려는 것입니다. 조용히 불확실 쪽으로 떨어지면, 신뢰도가 왜
#: 내려갔는지 아무도 모릅니다.
UNCERTAIN: frozenset[SpeakerSource] = frozenset(
    {
        SpeakerSource.VOICEPRINT,
        SpeakerSource.DIARIZATION,
    }
)


def stored_values() -> tuple[str, ...]:
    """CHECK 제약에 쓸 문자열들. 순서를 고정해 마이그레이션 diff 를 안정시킵니다."""
    return tuple(sorted(str(s) for s in STORED))


def certain_values() -> tuple[str, ...]:
    """`IN (...)` 에 넣을 확정 값들."""
    return tuple(sorted(str(s) for s in CERTAIN))


# ══════════════════════════════════════════════════════════════
# recording_consents.consent_type — 3단계 동의 (docs/07)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 여기 있는 이유는 **아직 안 갈라졌기 때문**입니다. `speaker_source` 와
#    똑같은 모양으로 세 곳에 따로 적혀 있었고(서비스 상수 · CHECK 제약 ·
#    마이그레이션), 지금은 셋이 일치합니다. 갈라진 뒤에 옮기면 그 사이에
#    무슨 일이 있었는지를 아무도 모릅니다.
#
# ⚠️ 이 열이 갈라지면 **법적 요구가 갈라집니다.** 서비스가 받아 준 동의를
#    데이터베이스가 거절하면 사람은 "동의했다" 고 알고 있는데 기록이 없고,
#    반대로 제약만 넓으면 검증 없이 아무 값이나 들어갑니다.


class ConsentType(StrEnum):
    """무엇에 대한 동의인가 (docs/07 P3).

    ⚠️ ②③ 을 **거부해도 서비스는 돌아야 합니다** — 필요 최소 수집 원칙입니다.
    거부를 못 하게 만들면 그건 동의가 아니라 통보입니다.
    """

    RECORDING = "recording"  # ① 녹음 자체. 이것만 필수
    RAW_AUDIO_RETENTION = "raw_audio_retention"  # ② 원본 오디오 보관
    VOICEPRINT_STORAGE = "voiceprint_storage"  # ③ 목소리 특징 저장


#: `recording_consents.consent_type` 이 받는 값 전부.
#:
#: `speaker_source` 와 달리 **전부 저장 가능합니다** — 세 단계가 다 화면에
#: 있고 로비가 실제로 셋 다 보냅니다. "아직 아닌 것" 이 없으니 나누지
#: 않습니다. 나눌 것이 없는데 빈 집합을 만들어 두면 그것도 거짓말입니다.
CONSENT_STORED: frozenset[ConsentType] = frozenset(ConsentType)

#: 없으면 **녹음을 시작할 수 없는** 동의. 나머지 둘은 거부해도 됩니다.
CONSENT_REQUIRED: frozenset[ConsentType] = frozenset({ConsentType.RECORDING})


def consent_values() -> tuple[str, ...]:
    return tuple(sorted(str(c) for c in CONSENT_STORED))


# ══════════════════════════════════════════════════════════════
# reports.report_type — 보고서 종류
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 이 열은 `speaker_source` 보다 **한 발 더 간 상태**였습니다. 저쪽은
#    적어도 CHECK 제약이 있었고(값이 갈라졌을 뿐), 이쪽은 허용값이
#    **주석 한 줄로만** 있었습니다:
#
#        # weekly | final | meeting_minutes
#        report_type: Mapped[str] = mapped_column(String(20), nullable=False)
#
#    주석은 아무것도 막지 않습니다. `String(20)` 이라 `"weekly "`(뒤 공백)도
#    `"Weekly"` 도 `"주간"` 도 들어갑니다. 그리고 그 표에는 쓰는 코드가
#    **0곳**이었으므로, 아무도 그 사실을 알아차릴 일이 없었습니다.


class ReportType(StrEnum):
    """무엇을 담은 보고서인가 (docs/08 §2 "반드시 구현").

    ⚠️ 새 종류를 넣으면 아래 `REPORT_SCOPE` 와 `CARRIES_CONTRIBUTION`
    양쪽에서 자리를 정하기 전까지 테스트가 터집니다. 둘 다 **조용히
    기본값으로 떨어지면 안 되는** 판단이기 때문입니다 — 아래를 보십시오.
    """

    MEETING_MINUTES = "meeting_minutes"  # 회의 하나의 기록
    WEEKLY = "weekly"  # 한 주 동안 일어난 일
    FINAL = "final"  # 프로젝트 전체 — 제출물이 되는 것


class ReportScope(StrEnum):
    """이 보고서가 **무엇 하나에** 매이는가.

    ⚠️ 이게 곧 **다시 만들 때 무엇을 갈아끼우는지**입니다. 안 정하면 재생성이
    갈아끼우기가 아니라 **쌓기**가 됩니다 — 이 저장소는 그 결함을 이미 한 번
    당했습니다(미해결 사안이 재처리마다 한 벌씩 쌓였습니다). 보고서에서
    그러면 "최종 보고서" 가 여러 벌 생기고, 어느 것이 진짜인지 아무도
    모릅니다.
    """

    MEETING = "meeting"  # 회의 하나당 하나
    PERIOD = "period"  # 프로젝트 × 기간당 하나
    PROJECT = "project"  # 프로젝트당 하나


#: 종류 → 무엇에 매이는가. **빠짐없이** 적혀 있어야 합니다.
REPORT_SCOPE: dict[ReportType, ReportScope] = {
    ReportType.MEETING_MINUTES: ReportScope.MEETING,
    ReportType.WEEKLY: ReportScope.PERIOD,
    ReportType.FINAL: ReportScope.PROJECT,
}

#: 사람별 **기여도 수치**가 들어가는 보고서.
#:
#: ⚠️ 여기가 이 제품에서 불변식이 가장 위험한 자리입니다. 보고서는 **앱
#: 밖으로 나가는 문서**입니다 — 복사돼서 제출물·메일·발표 자료가 됩니다.
#: 화면이라면 CSS 가드와 렌더 검사가 막아 주지만, **글자가 되어 나간 뒤에는
#: 아무 가드도 안 닿습니다.** 그래서 순위 금지·구간·측정 불가 표시를
#: 화면이 아니라 **생성기 자체**에 박고, 여기 적힌 종류에 대해서만이 아니라
#: 여기 적혔다는 사실 자체를 테스트가 검사합니다.
#:
#: ⚠️ `meeting_minutes` 는 **일부러 빠져 있습니다.** 회의록에 사람별 발언
#: 수를 넣으면 그 순간 순위표가 됩니다 — "많이 말한 사람" 은 기여가 아니라
#: 발언량이고, 그걸 회의마다 나란히 적으면 팀이 그걸로 서로를 봅니다.
#: 회의록은 **무슨 일이 있었나**를 적지 **누가 얼마나** 를 적지 않습니다.
CARRIES_CONTRIBUTION: frozenset[ReportType] = frozenset(
    {
        ReportType.WEEKLY,
        ReportType.FINAL,
    }
)


def report_values() -> tuple[str, ...]:
    """CHECK 제약에 쓸 문자열들. 순서를 고정해 마이그레이션 diff 를 안정시킵니다."""
    return tuple(sorted(str(r) for r in ReportType))


# ══════════════════════════════════════════════════════════════
# meeting_events.event_type — 회의 분석이 찾아낸 것
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **같은 결함의 세 번째 사례입니다.** `speaker_source` 는 값이 갈라져
#    있었고, `report_type` 은 주석 한 줄뿐이었으며, 이 열은 **둘 다**
#    입니다 — 주석이 다섯 값을 선언하는데 CHECK 제약은 없고, 그중
#    **실제로 만들어지는 것은 하나**뿐입니다.
#
#        # repeated_discussion | unanswered_question | incomplete_task |
#        # topic_drift | decision_conflict
#
#    나머지 넷을 만드는 프로덕션 코드가 0곳입니다. 그런데 주석은 다섯을
#    다 말하고 있으니, 읽는 사람은 "탐지기가 다섯 개 있다" 고 믿습니다.
#    요구사항 정의서 §12(AI-REVIEW-001·003·004·006)가 그 넷이고, 그래서
#    이 표의 주석이 **요구가 이미 구현된 것처럼** 보이게 만들고 있었습니다.


class MeetingEventType(StrEnum):
    """회의에서 찾아낸 문제 구간 (요구사항 정의서 §12).

    ⚠️ 새 값을 넣으면 아래 `EVENT_PRODUCED` / `EVENT_NOT_PRODUCED_YET`
    양쪽에서 자리를 정하기 전까지 테스트가 터집니다.
    """

    REPEATED_DISCUSSION = "repeated_discussion"  # AI-REVIEW-001 반복 논의
    UNANSWERED_QUESTION = "unanswered_question"  # AI-REVIEW-005 미응답 질문
    INCOMPLETE_TASK = "incomplete_task"  # AI-REVIEW-004 미완성 업무
    TOPIC_DRIFT = "topic_drift"  # AI-REVIEW-003 주제 이탈
    DECISION_CONFLICT = "decision_conflict"  # AI-REVIEW-006 결정 번복


#: 지금 **실제로 만들어지는** 값. 만드는 곳은 `tasks/meeting_tasks.py`.
EVENT_PRODUCED: frozenset[MeetingEventType] = frozenset(
    {MeetingEventType.UNANSWERED_QUESTION}
)

#: 아직 **탐지기가 없는** 값과 그 사실.
#:
#: ⚠️ 이 집합이 비어 있지 않다는 것 자체가 "요구사항 §12 가 아직 다 안
#: 됐다" 는 뜻입니다. `docs/20` 의 대조표가 이 집합을 그대로 읽습니다 —
#: 문서에 숫자를 손으로 적어 두면 구현이 늘어도 문서는 그대로 낡습니다.
#:
#: ⚠️ 여기 있는 값을 화면이 **미리 다루는 척하면 안 됩니다.** 안 나오는
#: 값에 라벨을 붙여 두면 "이미 되는 기능" 으로 읽힙니다.
EVENT_NOT_PRODUCED_YET: frozenset[MeetingEventType] = frozenset(
    {
        MeetingEventType.REPEATED_DISCUSSION,
        MeetingEventType.INCOMPLETE_TASK,
        MeetingEventType.TOPIC_DRIFT,
        MeetingEventType.DECISION_CONFLICT,
    }
)


def event_values() -> tuple[str, ...]:
    """CHECK 제약에 쓸 문자열들.

    ⚠️ **`EVENT_PRODUCED` 가 아니라 전부**입니다. `speaker_source` 와 다른
    점인데, 저쪽은 못 만드는 값을 DB 가 거절해야 앞단이 없다는 사실이
    드러나지만 이쪽은 탐지기가 붙는 즉시 값이 들어옵니다 — 그때 마이그
    레이션을 또 하게 만들 이유가 없습니다. 대신 "아직 안 나온다" 는 사실은
    위 두 집합과 테스트가 지킵니다.
    """
    return tuple(sorted(str(e) for e in MeetingEventType))
