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
