"""영상 기반 화자 판정과 오디오·영상 융합 테스트.

docs/12-CCTV-영상-기반-화자판정.md

실제 ASD 모델 없이 융합 로직을 검증한다. 융합은 순수 계산이라
GPU도 카메라도 없이 전부 확인할 수 있다.
"""

from __future__ import annotations

import numpy as np
import pytest

from teamflow.video.speaker import (
    EnrolledFace,
    FrameLabel,
    SpeakerSource,
    cosine_similarity,
    from_multitrack,
    fuse,
    match_face,
    video_only_speaker,
)

RNG = np.random.default_rng(20260901)


def unit(vector: np.ndarray) -> np.ndarray:
    return vector / np.linalg.norm(vector)


def face_embedding(seed: int, dim: int = 512) -> np.ndarray:
    return unit(np.random.default_rng(seed).standard_normal(dim))


def perturb(embedding: np.ndarray, noise: float, seed: int = 0) -> np.ndarray:
    """같은 사람의 다른 각도·조명 얼굴을 흉내낸다.

    ⚠️ 고차원에서는 성분별 잡음이 급격히 커진다. 512차원에 성분당 0.2를
    더하면 잡음 노름이 0.2*sqrt(512) ≈ 4.5 가 되어 원본을 삼킨다.
    `noise` 가 결과 코사인 거리에 대응하도록 차원으로 정규화한다.
    """
    rng = np.random.default_rng(seed)
    scaled = noise / np.sqrt(len(embedding))
    return unit(embedding + rng.standard_normal(len(embedding)) * scaled)


# ══════════════════════════════════════════════════════════════
# 1. 얼굴 매칭
# ══════════════════════════════════════════════════════════════


def test_same_face_matches():
    base = face_embedding(1)
    enrolled = [EnrolledFace(user_id=1, embedding=base)]
    user_id, score, _ = match_face(perturb(base, 0.2, seed=9), enrolled)
    assert user_id == 1
    assert score > 0.55


def test_different_face_does_not_match():
    enrolled = [EnrolledFace(user_id=1, embedding=face_embedding(1))]
    user_id, _, reason = match_face(face_embedding(999), enrolled)
    assert user_id is None
    assert "임계값 미달" in reason


def test_ambiguous_face_is_refused():
    """두 팀원과 비슷하면 포기한다. 억지로 붙이면 잘못된 기여도가 된다."""
    base = face_embedding(1)
    enrolled = [
        EnrolledFace(user_id=1, embedding=base),
        EnrolledFace(user_id=2, embedding=perturb(base, 0.05, seed=3)),
    ]
    user_id, _, reason = match_face(perturb(base, 0.1, seed=7), enrolled)
    assert user_id is None
    assert "모호" in reason


def test_no_enrolled_faces():
    user_id, score, reason = match_face(face_embedding(1), [])
    assert user_id is None
    assert score == 0.0
    assert "등록된 얼굴이 없" in reason


def test_cosine_similarity_bounds():
    a = face_embedding(1)
    assert cosine_similarity(a, a) == pytest.approx(1.0)
    assert cosine_similarity(a, -a) == pytest.approx(-1.0)
    assert cosine_similarity(a, np.zeros_like(a)) == 0.0


# ══════════════════════════════════════════════════════════════
# 2. 영상 단독 판정
# ══════════════════════════════════════════════════════════════


def test_video_picks_the_speaking_face():
    asd = {
        10: np.array([0.9, 0.9, 0.1, 0.1]),
        11: np.array([0.1, 0.1, 0.9, 0.9]),
    }
    speaker, confidence = video_only_speaker(asd, {10: 1, 11: 2})
    assert list(speaker) == [1, 1, 2, 2]
    assert (confidence > 0.8).all()


def test_video_reports_silence_when_nobody_speaks():
    asd = {10: np.array([0.1, 0.05]), 11: np.array([0.2, 0.1])}
    speaker, _ = video_only_speaker(asd, {10: 1, 11: 2})
    assert list(speaker) == [FrameLabel.SILENCE, FrameLabel.SILENCE]


def test_video_refuses_when_two_faces_score_alike():
    """둘 다 입을 움직이는 것으로 나오면 영상만으로는 못 정한다."""
    asd = {10: np.array([0.8]), 11: np.array([0.78])}
    speaker, confidence = video_only_speaker(asd, {10: 1, 11: 2})
    assert speaker[0] == FrameLabel.UNKNOWN
    assert confidence[0] == 0.0


def test_unmatched_face_is_not_attributed_to_a_member():
    """⚠️ 누군지 모르는 얼굴의 발화를 팀원에게 귀속시키면 안 된다.

    카페에서 옆 테이블 사람이 화면에 잡힐 수 있다.
    """
    asd = {10: np.array([0.95]), 11: np.array([0.05])}
    speaker, _ = video_only_speaker(asd, {10: None, 11: 2})
    assert speaker[0] == FrameLabel.UNKNOWN


def test_video_handles_single_face():
    asd = {10: np.array([0.9, 0.2])}
    speaker, _ = video_only_speaker(asd, {10: 1})
    assert list(speaker) == [1, FrameLabel.SILENCE]


def test_video_handles_empty_input():
    speaker, confidence = video_only_speaker({}, {})
    assert speaker.size == 0
    assert confidence.size == 0


# ══════════════════════════════════════════════════════════════
# 3. 융합 — 핵심
# ══════════════════════════════════════════════════════════════


def test_agreement_raises_confidence():
    """독립적인 두 증거가 일치하면 확신도가 올라간다."""
    audio_s = np.array([1])
    audio_c = np.array([0.7])
    video_s = np.array([1])
    video_c = np.array([0.7])

    result = fuse(audio_s, audio_c, video_s, video_c)
    assert result.speaker[0] == 1
    assert result.source[0] == SpeakerSource.FUSED
    assert result.confidence[0] > 0.7
    assert result.confidence[0] <= 1.0


def test_fused_confidence_never_exceeds_one():
    result = fuse(np.array([1]), np.array([1.0]), np.array([1]), np.array([1.0]))
    assert result.confidence[0] == pytest.approx(1.0)


def test_disagreement_is_not_resolved_by_guessing():
    """⭐ 핵심 원칙 — 어긋나면 판정하지 않는다.

    한쪽을 우선하도록 정하면 그 우선순위가 틀린 회의에서
    조용히 오답이 쌓인다. 보류하고 표시해야 사람이 고친다.
    """
    result = fuse(
        np.array([1]), np.array([0.9]), np.array([2]), np.array([0.9])
    )
    assert result.speaker[0] == FrameLabel.UNKNOWN
    assert result.source[0] == SpeakerSource.CONFLICT
    assert result.confidence[0] == 0.0
    assert result.conflicts[0]


def test_audio_only_falls_back_to_audio():
    """카메라 밖으로 나간 사람은 오디오로 잡는다."""
    result = fuse(
        np.array([1]),
        np.array([0.95]),
        np.array([FrameLabel.SILENCE]),
        np.array([0.0]),
    )
    assert result.speaker[0] == 1
    assert result.source[0] == SpeakerSource.TRACK
    assert result.confidence[0] == pytest.approx(0.95)


def test_video_only_falls_back_to_video():
    """앱을 안 켠 사람은 영상으로 잡는다."""
    result = fuse(
        np.array([FrameLabel.SILENCE]),
        np.array([0.0]),
        np.array([2]),
        np.array([0.88]),
    )
    assert result.speaker[0] == 2
    assert result.source[0] == SpeakerSource.VIDEO_ASD


def test_both_silent_stays_silent():
    result = fuse(
        np.array([FrameLabel.SILENCE]),
        np.array([0.0]),
        np.array([FrameLabel.SILENCE]),
        np.array([0.0]),
    )
    assert result.speaker[0] == FrameLabel.SILENCE


def test_fuse_handles_length_mismatch():
    """오디오와 영상의 프레임 수가 다를 수 있다. 짧은 쪽에 맞춘다."""
    result = fuse(
        np.array([1, 1, 1]), np.array([0.9, 0.9, 0.9]), np.array([1]), np.array([0.9])
    )
    assert result.n_frames == 1


def test_agreement_rate_is_reported():
    """일치율이 낮으면 카메라 배치나 마이크 위치에 문제가 있다는 신호다."""
    audio_s = np.array([1, 1, 2, 2])
    audio_c = np.full(4, 0.9)
    video_s = np.array([1, 1, 1, 2])  # 3번째가 어긋남
    video_c = np.full(4, 0.9)

    result = fuse(audio_s, audio_c, video_s, video_c)
    assert result.conflict_rate() == pytest.approx(0.25)
    assert 0.0 < result.agreement_rate() < 1.0


def test_perfect_agreement_rate():
    audio_s = np.array([1, 2])
    video_s = np.array([1, 2])
    conf = np.full(2, 0.9)
    result = fuse(audio_s, conf, video_s, conf)
    assert result.agreement_rate() == pytest.approx(1.0)
    assert result.conflict_rate() == 0.0


# ══════════════════════════════════════════════════════════════
# 4. 멀티트랙 → 융합 입력 변환
# ══════════════════════════════════════════════════════════════


def test_multitrack_maps_track_index_to_user():
    primary = np.array([0, 0, 1, FrameLabel.SILENCE])
    speaker, confidence = from_multitrack(primary, track_to_user={0: 11, 1: 22})
    assert list(speaker) == [11, 11, 22, FrameLabel.SILENCE]
    # 멀티트랙은 트랙이 곧 사람이라 확신도 1.0
    assert confidence[0] == 1.0


def test_multitrack_unknown_track_is_unknown():
    primary = np.array([5])
    speaker, _ = from_multitrack(primary, track_to_user={0: 11})
    assert speaker[0] == FrameLabel.UNKNOWN


# ══════════════════════════════════════════════════════════════
# 5. 실사용 시나리오
# ══════════════════════════════════════════════════════════════


def test_scenario_multitrack_plus_video_agree():
    """모드 A + C 융합. 둘 다 정상이면 확신도가 최고가 된다."""
    primary = np.array([0, 0, 1, 1, FrameLabel.SILENCE])
    audio_s, audio_c = from_multitrack(primary, track_to_user={0: 1, 1: 2})

    asd = {
        10: np.array([0.92, 0.90, 0.05, 0.04, 0.02]),
        11: np.array([0.03, 0.05, 0.91, 0.93, 0.03]),
    }
    video_s, video_c = video_only_speaker(asd, {10: 1, 11: 2})

    result = fuse(audio_s, audio_c, video_s, video_c)

    assert list(result.speaker[:4]) == [1, 1, 2, 2]
    assert all(s == SpeakerSource.FUSED for s in result.source[:4])
    assert result.conflict_rate() == 0.0


def test_scenario_member_forgot_to_open_the_app():
    """멀티트랙의 진짜 리스크 — 앱을 안 켠 사람.

    docs/10 Q3 에서 UX 마찰을 진짜 리스크로 꼽았다.
    영상이 이걸 메운다.
    """
    # 2번 팀원이 앱을 안 켜서 오디오에 트랙이 없다
    primary = np.array([0, 0, FrameLabel.SILENCE, FrameLabel.SILENCE])
    audio_s, audio_c = from_multitrack(primary, track_to_user={0: 1})

    asd = {
        10: np.array([0.9, 0.9, 0.05, 0.03]),
        11: np.array([0.04, 0.06, 0.88, 0.91]),  # 2번은 영상에만 잡힌다
    }
    video_s, video_c = video_only_speaker(asd, {10: 1, 11: 2})

    result = fuse(audio_s, audio_c, video_s, video_c)

    assert list(result.speaker) == [1, 1, 2, 2]
    assert result.source[0] == SpeakerSource.FUSED
    assert result.source[2] == SpeakerSource.VIDEO_ASD  # 영상이 메웠다


def test_scenario_member_walked_out_of_frame():
    """화면 밖으로 나간 사람은 오디오가 메운다."""
    primary = np.array([0, 0, 1, 1])
    audio_s, audio_c = from_multitrack(primary, track_to_user={0: 1, 1: 2})

    # 2번이 화면 밖 — ASD 점수가 없다
    asd = {10: np.array([0.9, 0.9, 0.05, 0.03])}
    video_s, video_c = video_only_speaker(asd, {10: 1})

    result = fuse(audio_s, audio_c, video_s, video_c)
    assert list(result.speaker) == [1, 1, 2, 2]
    assert result.source[2] == SpeakerSource.TRACK


def test_scenario_stranger_in_frame_is_not_attributed():
    """카페에서 옆 테이블 사람이 화면에 잡히는 경우."""
    primary = np.array([FrameLabel.SILENCE, FrameLabel.SILENCE])
    audio_s, audio_c = from_multitrack(primary, track_to_user={0: 1})

    asd = {99: np.array([0.95, 0.93])}  # 등록되지 않은 얼굴
    video_s, video_c = video_only_speaker(asd, {99: None})

    result = fuse(audio_s, audio_c, video_s, video_c)
    # 팀원 누구에게도 귀속되지 않는다
    assert not (result.speaker > 0).any()


def test_scenario_conflict_is_surfaced_not_hidden():
    """오디오는 A, 영상은 B — 이건 정보다. 숨기지 않는다."""
    primary = np.array([0, 0, 0])
    audio_s, audio_c = from_multitrack(primary, track_to_user={0: 1})

    asd = {11: np.array([0.9, 0.9, 0.9])}
    video_s, video_c = video_only_speaker(asd, {11: 2})

    result = fuse(audio_s, audio_c, video_s, video_c)
    assert result.conflict_rate() == 1.0
    assert all(s == SpeakerSource.CONFLICT for s in result.source)
    # 아무도 화자로 확정되지 않았다
    assert not (result.speaker >= 0).any()
