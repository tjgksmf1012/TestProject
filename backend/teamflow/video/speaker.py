"""영상 기반 화자 판정과 오디오·영상 융합.

docs/12-CCTV-영상-기반-화자판정.md

CCTV(또는 노트북 웹캠)는 마이크를 대체하지 않는다. **화자 분리를 대체한다.**
Active Speaker Detection 이 "이 순간 입을 움직이는 얼굴이 누구인가"를 알려주고,
등록된 얼굴과 매칭해 팀원에 귀속시킨다.

핵심 설계 원칙 — **두 신호가 어긋나면 판정하지 않는다.**
오디오와 영상은 독립적인 증거다. 일치하면 확신이 올라가고,
불일치하면 그건 정보다. 억지로 하나를 고르면 잘못된 기여도가 되고,
그건 팀 갈등이 된다 (docs/05 §5).

⚠️ 실제 ASD 모델(Light-ASD) 연동은 GPU와 모델이 없어 아직 없습니다.
인터페이스와 융합 로직만 확정했습니다 — 융합은 순수 계산이라 전부 검증됩니다.

⚠️⚠️ **그래서 이 파일의 결과는 아직 저장되지 않습니다.** `fuse()` 가 내는
`fused`·`conflict`·`video_asd` 는 `utterances.speaker_source` 의 CHECK 제약이
거절합니다 — 값을 만들어 낼 앞단(얼굴 검출·ASD)이 없으니 저장 통로를 미리
열어 두지 않는 것입니다. 열려면 `db/vocab.py` 의 `NOT_STORED_YET` 를 먼저
읽으십시오. 거기에 **같이 정해야 하는 것**이 적혀 있습니다 — `conflict`
("사람이 봐야 한다")를 사람이 볼 화면이 어디인가.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

import numpy as np

# ⚠️ **여기서 정의하지 않습니다.** `SpeakerSource` 는 `utterances` 열의
#    어휘라서 DB 쪽(`db/vocab.py`)이 원본입니다. 이 파일이 갖고 있던 동안
#    설명이 "utterances.speaker_source 에 저장된다" 였는데, 그중 셋
#    (`video_asd`·`fused`·`conflict`)은 **CHECK 제약이 거절했습니다.**
#    같은 목록이 두 곳에 있으면 반드시 갈라집니다.
from teamflow.db.vocab import SpeakerSource

__all__ = ["SpeakerSource"]  # 이 모듈을 통해 쓰던 코드가 계속 돌게 둡니다


# ══════════════════════════════════════════════════════════════
# 1. 인터페이스
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class FaceTrack:
    """영상에서 추적된 얼굴 하나."""

    face_track_id: int
    first_frame: int
    last_frame: int
    # 등록된 팀원과 매칭된 결과. 확신이 없으면 None.
    user_id: int | None = None
    match_score: float = 0.0
    match_reason: str = ""


class FaceDetector(Protocol):
    """프레임에서 얼굴을 찾아 추적한다.

    실제 구현은 RetinaFace/SCRFD + ByteTrack 등.
    """

    def detect_and_track(self, video_path: str) -> list[FaceTrack]: ...


class ActiveSpeakerDetector(Protocol):
    """얼굴 트랙별 프레임 단위 발화 점수.

    실제 구현 1순위: Light-ASD (CVPR 2023, AVA mAP 94.06%, 오픈소스).
    ⚠️ AVA는 영화 데이터라 실환경에서 떨어진다 (UniTalk, Interspeech 2026).
    자체 회의 영상으로 실측하기 전까지 94%를 인용하지 말 것.
    """

    def score(
        self, video_path: str, face_tracks: list[FaceTrack], audio: np.ndarray
    ) -> dict[int, np.ndarray]:
        """Returns: face_track_id → (n_frames,) 발화 확률 0~1"""
        ...


class FaceEmbedder(Protocol):
    """얼굴 임베딩. ⚠️ 생체인식정보다 — voiceprints 와 같은 취급."""

    def embed(self, video_path: str, face_track: FaceTrack) -> np.ndarray: ...


# ══════════════════════════════════════════════════════════════
# 2. 얼굴 ↔ 팀원 매칭
# ══════════════════════════════════════════════════════════════
#
# 성문 매칭(resolve.resolve_assignee)과 같은 원칙:
#   임계값 미달이면 매칭하지 않고, 모호하면 포기한다.
#   억지로 이름을 붙이면 잘못된 기여도가 된다.

FACE_MATCH_THRESHOLD = 0.55
FACE_MATCH_MARGIN = 0.08


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


@dataclass(frozen=True, slots=True)
class EnrolledFace:
    user_id: int
    embedding: np.ndarray


def match_face(
    embedding: np.ndarray,
    enrolled: list[EnrolledFace],
    *,
    threshold: float = FACE_MATCH_THRESHOLD,
    margin: float = FACE_MATCH_MARGIN,
) -> tuple[int | None, float, str]:
    """얼굴 임베딩을 등록된 팀원과 매칭한다.

    Returns: ``(user_id, score, reason)``. 확신이 없으면 user_id 는 None.
    """
    if not enrolled:
        return None, 0.0, "등록된 얼굴이 없습니다"

    scored = sorted(
        ((cosine_similarity(embedding, e.embedding), e) for e in enrolled),
        key=lambda x: -x[0],
    )
    best_score, best = scored[0]

    if best_score < threshold:
        return None, best_score, f"임계값 미달 (최고 유사도 {best_score:.2f})"

    if len(scored) >= 2 and best_score - scored[1][0] < margin:
        return (
            None,
            best_score,
            f"모호함: {best.user_id}/{scored[1][1].user_id} 양쪽과 유사",
        )

    return best.user_id, best_score, f"유사 일치 ({best_score:.2f})"


# ══════════════════════════════════════════════════════════════
# 3. 오디오 · 영상 융합
# ══════════════════════════════════════════════════════════════

# ASD 점수가 이 값을 넘어야 "말하고 있다"로 본다.
ASD_SPEAKING_THRESHOLD = 0.5

# 1등과 2등 얼굴의 ASD 점수 차가 이보다 작으면 영상만으로는 판정 불가.
ASD_MARGIN = 0.15


class FrameLabel:
    SILENCE = -2
    UNKNOWN = -1


@dataclass
class FusedFrames:
    """프레임별 융합 결과."""

    speaker: np.ndarray  # (n_frames,) user_id 또는 FrameLabel
    source: list[str]  # (n_frames,) SpeakerSource
    confidence: np.ndarray  # (n_frames,) 0~1
    conflicts: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=bool))

    @property
    def n_frames(self) -> int:
        return self.speaker.shape[0]

    def agreement_rate(self) -> float:
        """**둘 다 의견을 낸 프레임 중** 일치한 비율.

        낮으면 카메라 배치나 마이크 위치에 문제가 있다는 신호다.
        운영 지표로 노출한다.

        ⚠️ 분모를 "판정된 프레임"으로 잡으면 안 된다. 불일치 프레임은
        판정 보류(UNKNOWN)라서 분모에서 빠지고, 결과가 항상 1.0 이 된다.
        (테스트로 잡힌 실제 오류)
        """
        fused = sum(1 for s in self.source if s == SpeakerSource.FUSED)
        conflict = sum(1 for s in self.source if s == SpeakerSource.CONFLICT)
        both = fused + conflict
        return fused / both if both else 0.0

    def conflict_rate(self) -> float:
        return float(self.conflicts.mean()) if self.n_frames else 0.0


def video_only_speaker(
    asd_scores: dict[int, np.ndarray],
    face_to_user: dict[int, int | None],
    *,
    threshold: float = ASD_SPEAKING_THRESHOLD,
    margin: float = ASD_MARGIN,
) -> tuple[np.ndarray, np.ndarray]:
    """영상만으로 프레임별 화자를 정한다.

    Returns: ``(speaker, confidence)``.
    매칭되지 않은 얼굴(user_id=None)은 UNKNOWN 으로 둔다 —
    누군지 모르는 사람의 발화를 팀원에게 귀속시키면 안 된다.
    """
    if not asd_scores:
        return np.zeros(0, dtype=np.int64), np.zeros(0)

    n_frames = min(len(v) for v in asd_scores.values())
    face_ids = sorted(asd_scores)
    matrix = np.stack([asd_scores[f][:n_frames] for f in face_ids])

    speaker = np.full(n_frames, FrameLabel.SILENCE, dtype=np.int64)
    confidence = np.zeros(n_frames)

    top_index = np.argmax(matrix, axis=0)
    top_score = matrix[top_index, np.arange(n_frames)]

    if len(face_ids) >= 2:
        partitioned = np.sort(matrix, axis=0)
        second_score = partitioned[-2]
    else:
        second_score = np.zeros(n_frames)

    speaking = top_score >= threshold
    clear = speaking & ((top_score - second_score) >= margin)
    contested = speaking & ~clear

    for i in np.flatnonzero(clear):
        user_id = face_to_user.get(face_ids[top_index[i]])
        speaker[i] = user_id if user_id is not None else FrameLabel.UNKNOWN
        confidence[i] = float(top_score[i])

    # 두 얼굴이 비슷하게 말하는 것으로 나오면 영상만으로는 못 정한다
    speaker[contested] = FrameLabel.UNKNOWN
    confidence[contested] = 0.0

    return speaker, confidence


def fuse(
    audio_speaker: np.ndarray,
    audio_confidence: np.ndarray,
    video_speaker: np.ndarray,
    video_confidence: np.ndarray,
) -> FusedFrames:
    """오디오와 영상 판정을 합친다.

    규칙:
        둘 다 있고 일치      → FUSED, 확신도 상승
        둘 다 있고 불일치    → CONFLICT, 판정 보류 (사람 검토)
        오디오만             → TRACK/DIARIZATION 유지
        영상만               → VIDEO_ASD
        둘 다 없음           → SILENCE

    **불일치를 억지로 해소하지 않는 게 핵심이다.**
    한쪽을 우선하도록 정하면 그 우선순위가 틀린 회의에서 조용히 오답이 쌓인다.
    보류하고 표시하면 사람이 고칠 수 있다.
    """
    n = min(len(audio_speaker), len(video_speaker))
    speaker = np.full(n, FrameLabel.SILENCE, dtype=np.int64)
    confidence = np.zeros(n)
    conflicts = np.zeros(n, dtype=bool)
    source: list[str] = [SpeakerSource.DIARIZATION] * n

    for i in range(n):
        a = int(audio_speaker[i])
        v = int(video_speaker[i])
        a_ok = a >= 0
        v_ok = v >= 0

        if a_ok and v_ok:
            if a == v:
                speaker[i] = a
                # 독립적인 두 증거가 일치 — 확신도를 올린다.
                # 곱이 아니라 여집합의 곱으로 결합해야 1을 넘지 않는다.
                ac = float(audio_confidence[i])
                vc = float(video_confidence[i])
                confidence[i] = 1.0 - (1.0 - ac) * (1.0 - vc)
                source[i] = SpeakerSource.FUSED
            else:
                # 어긋났다. 판정하지 않는다.
                speaker[i] = FrameLabel.UNKNOWN
                confidence[i] = 0.0
                conflicts[i] = True
                source[i] = SpeakerSource.CONFLICT
        elif a_ok:
            speaker[i] = a
            confidence[i] = float(audio_confidence[i])
            source[i] = SpeakerSource.TRACK
        elif v_ok:
            speaker[i] = v
            confidence[i] = float(video_confidence[i])
            source[i] = SpeakerSource.VIDEO_ASD
        # 둘 다 없으면 SILENCE 유지

    return FusedFrames(
        speaker=speaker, source=source, confidence=confidence, conflicts=conflicts
    )


def from_multitrack(
    primary: np.ndarray, *, track_to_user: dict[int, int], base_confidence: float = 1.0
) -> tuple[np.ndarray, np.ndarray]:
    """멀티트랙 주화자 판정을 융합 입력 형식으로 바꾼다.

    트랙 인덱스를 user_id 로 치환한다. 멀티트랙은 트랙이 곧 사람이라
    확신도가 1.0 이다 (docs/04 §2).
    """
    speaker = np.full(len(primary), FrameLabel.SILENCE, dtype=np.int64)
    confidence = np.zeros(len(primary))
    for i, track_index in enumerate(primary):
        if track_index >= 0:
            user_id = track_to_user.get(int(track_index))
            if user_id is not None:
                speaker[i] = user_id
                confidence[i] = base_confidence
            else:
                speaker[i] = FrameLabel.UNKNOWN
    return speaker, confidence
