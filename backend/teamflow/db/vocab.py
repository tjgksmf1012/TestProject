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

from enum import IntEnum, StrEnum


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

#: `STORED` 중에서 **프로덕션 코드가 실제로 쓰는** 값.
#:
#: ⚠️ 이 파일의 머리말이 「만들어진다고 적은 값에 진짜 만드는 코드가
#: 있는가」를 재려고 생겼는데, 정작 **이 칸에는 그 검사가 없었습니다**
#: (결함 340). 옆 칸인 `MeetingEventType` 에는
#: `EVENT_PRODUCED`/`EVENT_NOT_PRODUCED_YET` 과 그것을 대조하는 검사가
#: 있습니다 — 같은 표의 옆 칸은 따로 재야 합니다.
#:
#: 세어 보니 `STORED` 는 넷을 주장하는데 `speaker_source=` 로 쓰는 자리는
#: **`track` 하나뿐**이었습니다.
WRITTEN: frozenset[SpeakerSource] = frozenset({SpeakerSource.TRACK})

#: 저장은 **할 수 있는데** 지금 쓰는 코드가 없는 값과 **그 이유**.
#:
#: ⚠️ `NOT_STORED_YET` 과 다릅니다. 저쪽은 **DB 가 거절하는** 값이고,
#: 이쪽은 DB 가 받아 주는데 **아무도 안 쓰는** 값입니다. 둘을 한 집합에
#: 뭉치면 "왜 안 나오는가" 의 답이 달라집니다.
#:
#: · `voiceprint` — `Voiceprint(` 를 만드는 프로덕션 코드가 0곳입니다.
#:   멀티트랙이면 성문이 필요 없기 때문이고, 그런데도 **동의는 먼저**
#:   받습니다 (`docs/07` P3·§2.3, `docs/17` 의 닫은 결정).
#: · `manual` — 사람이 화자를 지정하는 자리가 **서버 갈래 0곳 · 화면
#:   0곳**입니다. `docs/07` §2.3 이 "③ 거부 → 수동 매핑. **멀티트랙
#:   모드면 애초에 불필요**" 라고 적어 둔 그 이유입니다.
#: · `diarization` — 단일 트랙·혼합 녹음 경로가 없어 나올 자리가 없습니다.
#:
#: ⚠️ **여기 있는 값에도 화면은 제 가지를 가집니다** (`review/evidence.ts`).
#: 경로가 열리는 날 화면부터 만들지 않아도 되게 해 둔 것이지, "이미 되는
#: 기능" 이라는 뜻이 아닙니다.
NOT_WRITTEN_YET: frozenset[SpeakerSource] = frozenset(
    {
        SpeakerSource.VOICEPRINT,
        SpeakerSource.MANUAL,
        SpeakerSource.DIARIZATION,
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
    #: AI-REVIEW-008 동시 발언이 바탕보다 늘어난 구간.
    #:
    #: ⚠️ 겹침 자체는 진작 탐지하고 있었습니다(`multitrack.is_overlap`).
    #: 없던 것은 **"늘었다" 는 판정**입니다 — 회의 내내 조금씩 겹치는 것은
    #: 정상적인 대화이고, 특정 구간에서 갑자기 늘어난 것이 볼 만한 신호입니다.
    OVERLAP_SURGE = "overlap_surge"


#: 지금 **실제로 만들어지는** 값.
#:
#: · `unanswered_question` — LLM 경로 (`tasks/meeting_tasks.py`)
#: · 나머지 넷 — 규칙 기준선 (`services/inefficiency_service.py`)
#:
#: ⚠️ 넷이 오랫동안 **어휘에만 있고 만드는 코드가 0곳**이었습니다
#: (결함 122). 주석은 다섯을 선언하는데 실제로는 하나만 나왔고, 읽는
#: 사람은 탐지기가 다섯 개 있다고 믿게 됩니다.
EVENT_PRODUCED: frozenset[MeetingEventType] = frozenset(MeetingEventType)

#: 아직 **탐지기가 없는** 값과 그 사실.
#:
#: ⚠️ 이 집합이 비어 있지 않다는 것 자체가 "요구사항 §12 가 아직 다 안
#: 됐다" 는 뜻입니다. `docs/20` 의 대조표가 이 집합을 그대로 읽습니다 —
#: 문서에 숫자를 손으로 적어 두면 구현이 늘어도 문서는 그대로 낡습니다.
#:
#: ⚠️ 여기 있는 값을 화면이 **미리 다루는 척하면 안 됩니다.** 안 나오는
#: 값에 라벨을 붙여 두면 "이미 되는 기능" 으로 읽힙니다.
#:
#: ⚠️ **지금은 비어 있습니다.** 그렇다고 §12 가 다 된 것은 아닙니다 —
#: `AI-REVIEW-002`(장시간 미결정)·`007`(발언 편중)·`009`(핵심 구간)은
#: 애초에 `meeting_events` 로 표현하는 것이 아닙니다. `docs/20` §12 를
#: 보십시오. 이 집합은 "어휘에 있는데 안 나오는 값" 만 셉니다.
EVENT_NOT_PRODUCED_YET: frozenset[MeetingEventType] = frozenset()


def event_values() -> tuple[str, ...]:
    """CHECK 제약에 쓸 문자열들.

    ⚠️ **`EVENT_PRODUCED` 가 아니라 전부**입니다. `speaker_source` 와 다른
    점인데, 저쪽은 못 만드는 값을 DB 가 거절해야 앞단이 없다는 사실이
    드러나지만 이쪽은 탐지기가 붙는 즉시 값이 들어옵니다 — 그때 마이그
    레이션을 또 하게 만들 이유가 없습니다. 대신 "아직 안 나온다" 는 사실은
    위 두 집합과 테스트가 지킵니다.
    """
    return tuple(sorted(str(e) for e in MeetingEventType))


# ══════════════════════════════════════════════════════════════
# channels.kind — 채널의 종류 (요구사항 정의서 §6)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **둘 다 실제로 만들어집니다.** `speaker_source` 처럼 "아직 못 만드는
#    값" 을 미리 열어 두지 않았고, `meeting_events` 처럼 주석으로만 선언
#    하지도 않았습니다 — 두 종류 다 화면에서 만들 수 있고 목록에 뜹니다.


class ChannelKind(StrEnum):
    """텍스트 채널인가 음성 채널인가 (요구사항 정의서 CHANNEL-001·002).

    ⚠️ **음성 채널은 회의를 대신하지 않습니다.** 음성 채널은 *방 이름*
    이고(`주간회의`·`개발회의`), 회의는 그 방에서 **열리는 사건**입니다.
    `meetings.channel_id` 가 그 둘을 잇습니다. 방과 사건을 한 표에 뭉치면
    "지난 주간회의" 를 가리킬 방법이 없어집니다.
    """

    TEXT = "text"  # #일반 · #공지 — 메시지가 쌓이는 곳
    VOICE = "voice"  # 주간회의 · 개발회의 — 회의가 열리는 방


#: `channels.kind` 가 받는 값 전부. 둘 다 만들 수 있습니다.
CHANNEL_STORED: frozenset[ChannelKind] = frozenset(ChannelKind)

#: 메시지를 담을 수 있는 종류.
#:
#: ⚠️ 음성 채널에 메시지를 쓰게 두면 "회의 중 채팅" 이 생기는데, 그건
#: 정의서에 없는 기능입니다. 없는 것을 조용히 만들지 않습니다 — 필요해지면
#: 그때 여기에 넣고 화면도 같이 만듭니다.
CHANNEL_CARRIES_MESSAGES: frozenset[ChannelKind] = frozenset({ChannelKind.TEXT})


def channel_values() -> tuple[str, ...]:
    return tuple(sorted(str(c) for c in ChannelKind))


# ══════════════════════════════════════════════════════════════
# message_reactions.mark — 메시지에 다는 반응 (요구사항 정의서 CHAT-004)
# ══════════════════════════════════════════════════════════════
#
# ## ⚠️ 정의서는 "이모지 반응" 이라고 적었는데 왜 이름인가
#
# 두 가지 이유가 있고, 둘 다 이 저장소가 **이미 겪은 것**입니다.
#
# ① **색 이모지는 화면에 못 나갑니다.** `guards.test.ts` 가 막습니다 —
#    기기마다 다른 그림이 나오고, 색이 박혀 있어 어두운 모드를 안 따라
#    가고, 베이스라인이 서체에 딸려 있어 세로 정렬이 틀어집니다. 칸반
#    카드의 `🗣` 를 SVG 로 바꾼 것이 그 규칙이 생긴 자리입니다.
#
# ② **아무 이모지나 받으면 그건 조롱 통로입니다.** 이 제품은 성적에 쓰일
#    수 있는 기여도를 다루고(`docs/07`), 반응은 **남이 쓴 글 위에** 붙습니다.
#    자유 입력이면 `💩` 을 막을 방법이 없고, 지금 이 저장소에는 신고도
#    차단도 없습니다. 없는 것을 전제로 통로부터 열지 않습니다.
#
# 그래서 **정해진 넷**만 있고, 넷 다 중립이거나 긍정입니다.
# ⚠️ **부정 반응을 넣지 마십시오.** 하나 생기는 순간 그것이 몰매의 도구가
#    됩니다 — 반대는 말로 적게 두는 편이 낫습니다.


class ReactionMark(StrEnum):
    """반응 하나. 값은 **이름**이고, 그림은 화면이 SVG 로 그립니다."""

    OK = "ok"  # 확인했어요
    AGREE = "agree"  # 동의해요
    QUESTION = "question"  # 궁금해요
    THANKS = "thanks"  # 고마워요


#: `message_reactions.mark` 가 받는 값 전부.
REACTION_STORED: frozenset[ReactionMark] = frozenset(ReactionMark)

#: 이름 → 사람 말. 화면과 낭독기가 같이 씁니다.
#:
#: ⚠️ 화면에 두 번째 표를 만들지 마십시오. 하나만 고쳐지면 낭독기가 읽는
#: 말과 눈에 보이는 말이 갈라집니다.
REACTION_LABEL: dict[ReactionMark, str] = {
    ReactionMark.OK: "확인했어요",
    ReactionMark.AGREE: "동의해요",
    ReactionMark.QUESTION: "궁금해요",
    ReactionMark.THANKS: "고마워요",
}


def reaction_values() -> tuple[str, ...]:
    return tuple(sorted(str(r) for r in ReactionMark))


# ══════════════════════════════════════════════════════════════
# github_events.event_type — 저장되는 GitHub 사건 (요구사항 정의서 §17)
# ══════════════════════════════════════════════════════════════
#
# ## ⚠️ 커밋(push)이 여기 **없는 것은 빠뜨린 게 아니라 결정**입니다
#
# 커밋은 쪼개기가 너무 쉬워서 지표로 쓸 수 없습니다 (`docs/05` §2.1 —
# 오타 PR 30건이 실제 구현 1건을 이겼던 그 구멍의 커밋판입니다). 코드
# 기여는 **병합된 PR 단위**로만 셉니다(`contribution/events.py` 의
# COMMIT 부재와 같은 결정). 그래서 웹훅도 push 를 받지 않고, 조회
# 화면도 커밋 목록을 만들지 않으며 — **그 이유를 화면이 말합니다.**
#
# ⚠️ 이 값들은 웹훅(`github/webhook.py`)과 백필이 **쓰고**, 업무 연결
# (`task_link_service`)·조회 피드가 **읽습니다.** 예전에는 다섯 곳에
# 문자열로 흩어져 있었습니다 — 한 곳만 바꾸면 나머지가 조용히 어긋나는
# 자리라 여기로 모았습니다.


class GithubEventKind(StrEnum):
    """`github_events.event_type` 이 받는 값 전부."""

    PR_MERGED = "pull_request.merged"
    PR_REVIEW = "pull_request.review"
    ISSUE_CLOSED = "issues.closed"


#: 종류 → 사람 말. 서버가 라벨을 만들어 내려보냅니다 — 화면에 두 번째
#: 표를 만들지 마십시오 (`activity` 의 `label` 과 같은 방식).
GITHUB_EVENT_LABEL: dict[GithubEventKind, str] = {
    GithubEventKind.PR_MERGED: "PR 병합",
    GithubEventKind.PR_REVIEW: "PR 리뷰",
    GithubEventKind.ISSUE_CLOSED: "이슈 닫힘",
}


# ══════════════════════════════════════════════════════════════
# notifications.kind — 알림의 종류 (요구사항 정의서 §19)
# ══════════════════════════════════════════════════════════════
#
# ## ⚠️ 여섯 중 넷만 **저장**됩니다
#
# 정의서의 여섯을 두 종류로 갈랐습니다.
#
#     저장한다  MENTION · ASSIGNED · MEETING_SOON · GITHUB
#               → **일어난 사건**입니다. 그 순간이 아니면 다시 알 수 없습니다
#
#     안 한다   DUE_SOON · OVERDUE
#               → **지금 상태에서 나옵니다.** 행으로 쌓으면 마감일을 미뤘을 때
#                 "곧 마감" 이 남고, 끝냈을 때 "지연" 이 남습니다
#
# 아래 두 집합이 그 경계이고, `test_column_vocabularies.py` 가 "저장한다고
# 적은 값에 진짜 저장하는 코드가 있는지" 를 소스에서 셉니다.
#
# ⚠️ **어느 값에 만드는 코드가 없는지는 여기 글로 적지 마십시오.**
#    아래 `NOTIFICATION_NOT_PRODUCED_YET` 집합 하나만 보십시오 — 집합은
#    테스트가 지키고, 글은 아무것도 안 막습니다.
#
#    실제로 갈라져 있었습니다 (결함 341). 여기에는 "`GITHUB` 은 아직
#    만드는 코드가 0곳입니다. 웹훅에서 부를 자리를 아직 안 잡았습니다"
#    라고 적혀 있었는데, **서른여덟 줄 아래**의 집합 주석은 같은 값에 대해
#    "`task_link_service._tell_the_assignee` 가 만듭니다" 라고 했습니다.
#    맞는 쪽은 아래이고 — 웹훅 엔드포인트(`api/main.py` 의
#    `link_pull_request`)가 그 경로를 부릅니다.
#
#    이 파일은 "같은 값이 여러 곳에 따로 적혀 갈라지는 것" 을 막으려고
#    생겼는데, **자기 자신이 그 방식으로 갈라져 있었습니다.**


class NotificationKind(StrEnum):
    """알림 하나의 종류."""

    MENTION = "mention"  # NOTIFICATION-001 채팅에서 불렸다
    ASSIGNED = "assigned"  # NOTIFICATION-002 업무를 맡았다
    DUE_SOON = "due_soon"  # NOTIFICATION-003 곧 마감 — **파생**
    OVERDUE = "overdue"  # NOTIFICATION-004 지났다 — **파생**
    MEETING_SOON = "meeting_soon"  # NOTIFICATION-005 곧 회의
    GITHUB = "github"  # NOTIFICATION-006 PR 상태가 바뀌었다


#: `notifications.kind` 가 받는 값. **파생 둘은 빠집니다** — 저장 안 합니다.
NOTIFICATION_STORED: frozenset[NotificationKind] = frozenset(
    {
        NotificationKind.MENTION,
        NotificationKind.ASSIGNED,
        NotificationKind.MEETING_SOON,
        NotificationKind.GITHUB,
    }
)

#: 저장하지 않고 **읽을 때 만드는** 것. 표에 들어가면 안 됩니다.
NOTIFICATION_DERIVED: frozenset[NotificationKind] = frozenset(
    {NotificationKind.DUE_SOON, NotificationKind.OVERDUE}
)

#: 저장은 하는데 **아직 만드는 코드가 없는** 것.
#:
#: ⚠️ `MEETING_SOON` 이 여기 있을 뻔했습니다 — 읽는 코드(`_text_for`)만
#: 만들어 놓고 만드는 코드를 안 붙였습니다. 이 저장소의 대표 실패 ①
#: 이고, 검사가 아니라 눈으로 grep 해서 알았습니다. 지금은
#: `announce_upcoming_meetings` 가 만듭니다.
#:
#: ⚠️ **지금은 비어 있습니다.** `GITHUB` 이 마지막이었고,
#: `task_link_service._tell_the_assignee` 가 만듭니다 — PR 과 업무가
#: 실제로 이어지는 순간이 붙일 자리였습니다.
#:
#: ⚠️ 비었다고 이 집합을 **지우지 마십시오.** 다음에 어휘를 늘릴 때
#: "만드는 코드를 아직 안 붙였다" 를 적을 자리가 여기입니다. 적을 자리가
#: 없으면 사람은 그냥 안 적고, 그게 결함 122 가 생긴 방식입니다.
NOTIFICATION_NOT_PRODUCED_YET: frozenset[NotificationKind] = frozenset()


def notification_values() -> tuple[str, ...]:
    """CHECK 제약에 들어갈 값. **저장하는 것만.**"""
    return tuple(sorted(str(k) for k in NOTIFICATION_STORED))


# ══════════════════════════════════════════════════════════════
# tasks.status — 칸반 열 (요구사항 정의서 TASK-004)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **같은 결함의 네 번째 사례입니다.** 이 열에는 CHECK 제약이 **아예
#    없었고**, 허용값은 `services/task_service.py` 의 튜플 하나뿐이었습니다.
#
#        STATUSES = ("todo", "in_progress", "done")   # ← 여기가 전부
#        status: Mapped[str] = mapped_column(String(20), ...)  # 제약 없음
#
#    `String(20)` 이라 `"Done"` 도 `"완료"` 도 `"todo "`(뒤 공백)도
#    들어갑니다. 서비스를 안 거치는 경로가 하나라도 생기면 그 순간
#    칸반에 **어느 열에도 안 속하는 카드**가 생기고, 화면에서는 그냥
#    사라진 것처럼 보입니다.
#
# ⚠️ **순서가 곧 칸반 열 순서입니다.** 선언 순서를 바꾸면 화면이 바뀝니다.


class TaskStatus(StrEnum):
    """업무가 지금 어느 열에 있는가.

    ⚠️ `REVIEW` 는 정의서 `TASK-004` 가 요구하는 넷째 열입니다. 이것이
    없던 동안 "다 만들었는데 아직 아무도 안 본" 일이 `in_progress` 와
    `done` 어느 쪽에도 정확히 안 맞았습니다 — `done` 에 두면 검토를
    건너뛴 것이 완료로 보이고, `in_progress` 에 두면 만든 사람이 아직
    붙잡고 있는 것처럼 보입니다.
    """

    TODO = "todo"  # 할 일
    IN_PROGRESS = "in_progress"  # 하는 중
    REVIEW = "review"  # 검토 중 — 만든 사람 손을 떠났고 아직 확인 전
    DONE = "done"  # 완료


#: `tasks.status` 가 받는 값 전부. **선언 순서 = 칸반 열 순서.**
TASK_STATUSES: tuple[TaskStatus, ...] = tuple(TaskStatus)

#: 끝난 것으로 세는 상태.
#:
#: ⚠️ `REVIEW` 는 여기 없습니다. 검토 중인 일을 완료로 세면 진행률이
#: 실제보다 높게 나오고, 그 숫자로 "우리 팀은 80% 했다" 를 말하게 됩니다.
#: 아직 아무도 안 본 것은 안 끝난 것입니다.
TASK_FINISHED: frozenset[TaskStatus] = frozenset({TaskStatus.DONE})

#: 사람이 읽을 이름.
#:
#: ⚠️ **화면의 `lib/kanban/board.ts` 의 `STATUS_LABEL` 과 짝입니다.**
#: 두 벌이지만 런타임이 달라 어쩔 수 없고, 대신
#: `test_repo_integrity.py` 의 교차 검사가 값이 갈라지면 터집니다.
#: 처음 적을 때 여기는 `하는 중`, 화면은 `진행 중` 으로 이미 갈려
#: 있었습니다 — 화면 쪽 말로 맞췄습니다.
TASK_STATUS_LABEL: dict[TaskStatus, str] = {
    TaskStatus.TODO: "할 일",
    TaskStatus.IN_PROGRESS: "진행 중",
    TaskStatus.REVIEW: "검토 중",
    TaskStatus.DONE: "완료",
}


def task_status_values() -> tuple[str, ...]:
    """CHECK 제약에 쓸 문자열들. 순서를 고정해 마이그레이션 diff 를 안정시킵니다."""
    return tuple(sorted(str(s) for s in TaskStatus))


# ══════════════════════════════════════════════════════════════
# tasks.priority — 우선순위 (요구사항 정의서 §15 `TASK-007`)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **칸만 있고 아무도 안 읽고 있었습니다.** `tasks.priority` 는 정수
# 열로 진작 있었고 검색 API 는 이 값으로 거르기까지 했는데, 사람이 값을
# **정할 자리도 볼 자리도 없었습니다** — 있지도 않은 값으로 거를 수 있는
# 필터였습니다. 이 저장소의 실패 ①(만들어 놓고 아무도 안 부름)과
# ③(할 일을 알려 주고 그 일을 할 자리를 안 줌)이 겹친 자리입니다.
#
# ⛔ **기여도에 절대 연결하지 마십시오.** 우선순위가 점수에 닿는 순간
# 드롭다운 하나가 점수 발행기가 됩니다. 이건 "무엇부터 볼까" 를 정하는
# 값이지 "누가 잘했나" 가 아닙니다.
#
# 숫자를 그대로 쓰는 이유: 이미 `int` 열이고 정렬이 필요한 값입니다.
# 문자열로 바꾸려면 마이그레이션이 필요하고, 얻는 게 없습니다.


class TaskPriority(IntEnum):
    """무엇부터 볼 것인가. **작을수록 급합니다.**

    ⚠️ 방향을 헷갈리면 정렬이 조용히 뒤집힙니다. `URGENT = 0` 이고
    `sorted()` 가 급한 것을 앞에 놓습니다 — 이름과 숫자를 같이 읽으세요.
    """

    URGENT = 0  # 긴급
    HIGH = 1  # 높음
    NORMAL = 2  # 보통 — `tasks.priority` 의 기본값
    LOW = 3  # 낮음


#: `tasks.priority` 가 받는 값 전부. **선언 순서 = 급한 순서.**
TASK_PRIORITIES: tuple[TaskPriority, ...] = tuple(TaskPriority)

#: 값을 안 정했을 때. DB 열의 `default=2` 와 **같아야 합니다.**
TASK_PRIORITY_DEFAULT: TaskPriority = TaskPriority.NORMAL

#: 사람이 읽을 이름.
#:
#: ⚠️ **화면의 `lib/kanban/priority.ts` 와 짝입니다** — `TASK_STATUS_LABEL`
#: 과 같은 사정이고, `test_repo_integrity.py` 의 교차 검사가 갈라지면
#: 터집니다.
TASK_PRIORITY_LABEL: dict[TaskPriority, str] = {
    TaskPriority.URGENT: "긴급",
    TaskPriority.HIGH: "높음",
    TaskPriority.NORMAL: "보통",
    TaskPriority.LOW: "낮음",
}


def task_priority_values() -> tuple[int, ...]:
    """CHECK 제약에 쓸 정수들. 순서를 고정해 마이그레이션 diff 를 안정시킵니다."""
    return tuple(sorted(int(p) for p in TaskPriority))


# ══════════════════════════════════════════════════════════════
# utterances.utterance_type — 발언 유형 (요구사항 정의서 §10)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **같은 결함의 다섯 번째 사례입니다.** 이 열도 CHECK 제약이 **아예
#    없었고**, 허용값은 `meeting/utterance_types.py` 의 `LABELS` 튜플
#    하나뿐이었습니다. `speaker_source`(118) · `report_type`(119) ·
#    `meeting_events`(122) · `tasks.status`(132) 에 이어 다섯 번째입니다.
#
# ⚠️ **요구 열 개와 라벨 여덟 개가 1:1 이 아니었습니다.** 동의·반대·보완이
#    전부 `opinion` 하나로 뭉개져 있어서 `REVIEW-005`("동의 수 · 반대 의견
#    수")를 **셀 수가 없었습니다.** 화면부터 만들었으면 0 이 뜨거나 빈 칸이
#    생겼을 것입니다.


class UtteranceType(StrEnum):
    """이 발언이 무엇을 하고 있는가.

    ⚠️ **라벨은 "무엇을 말했나" 이지 "얼마나 기여했나" 가 아닙니다.**
    점수는 `contribution/scoring.py` 가 따로 정하고, 화면은 라벨로 세고
    점수는 점수대로 씁니다. 둘을 한 축에 묶으면 "동의는 몇 점짜리인가"
    같은 질문에 **시스템이 답하게** 됩니다.
    """

    QUESTION = "question"  # AI-SPEECH-001 질문
    PROPOSAL = "proposal"  # AI-SPEECH-002 제안
    ANSWER = "answer"  # AI-SPEECH-003 정보 제공·응답
    AGREEMENT = "agreement"  # AI-SPEECH-004 동의
    OBJECTION = "objection"  # AI-SPEECH-005 반대 의견
    REFINEMENT = "refinement"  # AI-SPEECH-006 보완 의견
    DECISION = "decision"  # AI-SPEECH-007 결정
    REQUEST = "request"  # AI-SPEECH-008 업무 요청
    COMMITMENT = "commitment"  # AI-SPEECH-009 일정 약속
    CONFIRMATION = "confirmation"  # AI-SPEECH-010 확인 요청
    OPINION = "opinion"  # 어느 쪽도 아닌 의견 — 아래 설명
    SOCIAL = "social"  # 맞장구·잡담 → 0점
    OTHER = "other"  # 모르는 것 → 0점


#: `utterances.utterance_type` 이 받는 값 전부.
UTTERANCE_STORED: frozenset[UtteranceType] = frozenset(UtteranceType)

#: 기여도에 **값을 더하지 않는** 라벨.
#:
#: ⚠️ 여기 떨어져도 발언은 회의록에 그대로 남습니다. 0점은 "말을 안 했다"
#: 가 아니라 "이 발언은 점수 계산에 넣지 않는다" 입니다 — 불변식 3
#: (측정 불가 ≠ 0점)과 헷갈리면 안 되는 자리입니다.
UTTERANCE_ZERO_SCORE: frozenset[UtteranceType] = frozenset(
    {UtteranceType.SOCIAL, UtteranceType.OTHER}
)

#: 찬반·보완 — `REVIEW-005` 가 세는 것.
#:
#: ⚠️ `OPINION` 은 여기 **없습니다.** 어느 쪽도 아닌 의견이라 "동의 수" 에도
#: "반대 수" 에도 넣을 수 없습니다. 넣으면 둘 다 부풀고, 어느 쪽에 넣을지
#: 고르는 순간 **시스템이 사람의 입장을 정하는** 것이 됩니다.
UTTERANCE_STANCE: frozenset[UtteranceType] = frozenset(
    {UtteranceType.AGREEMENT, UtteranceType.OBJECTION, UtteranceType.REFINEMENT}
)

#: 사람이 읽을 이름.
#:
#: ⚠️ **화면의 `lib/review/labels.ts` 와 짝입니다.** 두 벌이지만 런타임이
#: 달라 어쩔 수 없고, `test_repo_integrity.py` 의 교차 검사가 갈라지면
#: 터집니다 (`TASK_STATUS_LABEL` 과 같은 방식).
UTTERANCE_LABEL: dict[UtteranceType, str] = {
    UtteranceType.QUESTION: "질문",
    UtteranceType.PROPOSAL: "제안",
    UtteranceType.ANSWER: "정보 제공",
    UtteranceType.AGREEMENT: "동의",
    UtteranceType.OBJECTION: "반대 의견",
    UtteranceType.REFINEMENT: "보완 의견",
    UtteranceType.DECISION: "결정",
    UtteranceType.REQUEST: "업무 요청",
    UtteranceType.COMMITMENT: "일정 약속",
    UtteranceType.CONFIRMATION: "확인 요청",
    UtteranceType.OPINION: "의견",
    UtteranceType.SOCIAL: "맞장구",
    UtteranceType.OTHER: "기타",
}


def utterance_type_values() -> tuple[str, ...]:
    """CHECK 제약에 쓸 문자열들. 순서를 고정해 마이그레이션 diff 를 안정시킵니다."""
    return tuple(sorted(str(t) for t in UTTERANCE_STORED))


# ══════════════════════════════════════════════════════════════
# members.project_role — 프로젝트 안에서의 권한 (요구사항 정의서 §5)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **`role_shares` 와 헷갈리지 마십시오.** 그 칸은 `{"developer": 0.7,
#    "planner": 0.3}` 처럼 **기여도 가중치**를 담습니다. 권한이 아닙니다.
#    `docs/20` 이 그 혼동을 이미 한 번 적어 뒀습니다 — "`Member.role_shares`
#    는 기여도 가중치지 권한이 아닙니다".
#
#    둘을 한 칸에 담으면 **기획자 비중을 0.3 으로 바꾼 것이 권한 변경이
#    됩니다.** 완전히 다른 것이라 칸을 따로 둡니다.
#
# ⚠️ **제약 없는 열 여섯 번째가 되지 않게** 처음부터 CHECK 를 답니다
#    (`speaker_source` 118 · `report_type` 119 · `meeting_events` 122 ·
#    `tasks.status` 132 · `utterance_type` 이 앞의 다섯입니다).


class ProjectRole(StrEnum):
    """프로젝트 안에서 무엇을 할 수 있는가.

    ⚠️ **선언 순서 = 권한 크기 순**입니다. `ROLE_RANK` 가 이 순서를
    씁니다 — 값을 사이에 끼워 넣으면 조용히 위계가 바뀝니다.

    ## ⛔ 등급마다 「무엇을 할 수 있다」를 여기 글로 적지 마십시오 (결함 351)

    예전에는 값 옆에 이렇게 적혀 있었고, **둘 다 거짓이었습니다**:

        OWNER  … 넘겨줄 수는 있어도 스스로 사라질 수 없음
        ADMIN  … 프로젝트를 지우지는 못함

    - **소유권은 넘길 수 없습니다.** `change_member_role` 이
      `ROLE_RANK[wanted] >= ROLE_RANK[actor]` 를 403 으로 막고, 소유자가
      가장 높으므로 `owner` 를 주는 길은 **누구에게도** 없습니다. 실제로
      눌러 보면 「자기보다 높거나 같은 권한은 줄 수 없습니다」입니다.
      `owner` 를 쓰는 자리는 **프로젝트를 만들 때 한 곳**뿐입니다.
    - **프로젝트는 아무도 못 지웁니다.** `DELETE /api/projects/{id}` 가
      없어서 405 입니다. 즉 그 문장은 관리자를 소유자와 **갈라 주지
      않습니다** — 없는 능력으로 가른 것입니다.

    할 수 있는 일의 원본은 **`projects/permissions.py` 의 `_ALLOWED`
    하나**입니다. 여기서 다시 말하면 두 벌이 되고, 결함 341 이 이 파일
    **자신**에서 겪은 그것이 되풀이됩니다 — 주석은 아무것도 안 막습니다.
    """

    OWNER = "owner"  # 프로젝트를 만든 사람
    ADMIN = "admin"  # 팀원·설정을 다루는 사람
    MEMBER = "member"  # 자기 일을 하는 사람


#: `members.project_role` 이 받는 값 전부.
PROJECT_ROLES: tuple[ProjectRole, ...] = tuple(ProjectRole)

#: 새로 합류하는 사람의 기본값. **`member` 입니다** — 초대 코드만 알면
#: 들어올 수 있으므로, 기본이 그보다 크면 코드가 새는 순간 팀이 열립니다.
DEFAULT_PROJECT_ROLE: ProjectRole = ProjectRole.MEMBER

#: 클수록 권한이 큽니다. **비교는 이 표로만** 하십시오 — 문자열 비교
#: (`"admin" < "member"`)는 알파벳 순이라 뜻이 정반대가 됩니다.
ROLE_RANK: dict[ProjectRole, int] = {
    role: len(PROJECT_ROLES) - at for at, role in enumerate(PROJECT_ROLES)
}

#: 사람이 읽을 이름.
#:
#: ⚠️ **화면의 `lib/project/roles.ts` 와 짝입니다** (`TASK_STATUS_LABEL`
#: 과 같은 방식). 갈라지면 `test_repo_integrity.py` 가 터집니다.
PROJECT_ROLE_LABEL: dict[ProjectRole, str] = {
    ProjectRole.OWNER: "소유자",
    ProjectRole.ADMIN: "관리자",
    ProjectRole.MEMBER: "팀원",
}


def project_role_values() -> tuple[str, ...]:
    """CHECK 제약에 쓸 문자열들. 순서를 고정해 마이그레이션 diff 를 안정시킵니다."""
    return tuple(sorted(str(r) for r in PROJECT_ROLES))


# ══════════════════════════════════════════════════════════════
# 사용자 상태 표시 (요구사항 정의서 §4 `USER-005`)
# ══════════════════════════════════════════════════════════════
#
# ⚠️ **이 값은 표에 없습니다.** 어디에도 저장하지 않고 읽을 때마다
#    계산합니다. 상태를 행으로 쌓으면 그건 곧 **출퇴근 기록**이 되고,
#    이 제품에서 제일 만들면 안 되는 물건입니다 — 기여도는 "무엇을
#    했는가" 로 재기로 했는데 옆에 "언제 앉아 있었는가" 표가 생기면
#    사람은 그걸 같이 봅니다.
#
#    `calendar_events`·알림·위험 신호를 안 만든 것과 같은 판단이고,
#    여기서는 이유가 하나 더 있습니다. **감시입니다.**


class PresenceStatus(StrEnum):
    """지금 이 사람이 붙어 있는가.

    ⚠️ **과거를 말하지 않습니다.** `마지막 접속 3일 전` 같은 값은 두지
    않습니다 — 그건 상태가 아니라 **근태 기록**입니다. 지금 안 붙어
    있으면 그냥 `offline` 입니다.
    """

    ONLINE = "online"  # 방금까지 쓰고 있었음
    AWAY = "away"  # 로그인은 살아 있는데 한동안 조용함
    OFFLINE = "offline"  # 세션이 없거나 오래됨
    IN_MEETING = "in_meeting"  # 녹음 중인 회의에 트랙이 열려 있음


PRESENCE_STATUSES: tuple[PresenceStatus, ...] = tuple(PresenceStatus)

#: 사람이 읽을 이름.
#:
#: ⚠️ **화면의 `lib/project/presence.ts` 와 짝입니다.**
#: `test_repo_integrity.py` 의 교차 검사가 갈라지면 터집니다.
PRESENCE_LABEL: dict[PresenceStatus, str] = {
    PresenceStatus.ONLINE: "접속 중",
    PresenceStatus.AWAY: "자리 비움",
    PresenceStatus.OFFLINE: "오프라인",
    PresenceStatus.IN_MEETING: "회의 중",
}
