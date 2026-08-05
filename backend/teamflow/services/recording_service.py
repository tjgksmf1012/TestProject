"""녹음 트랙 수집 서비스.

docs/04-회의-처리-파이프라인.md §2, docs/07-법적-윤리-요구사항.md §1

프런트 `frontend/src/lib/recording/` 의 서버 쪽 짝이다.

```
[폰]  RecordingClient
        │  ① 트랙 참가        POST   /api/meetings/{id}/tracks
        │  ② 5초마다 청크     PUT    …/tracks/{tid}/chunks/{seq}
        │  ③ 끊겼다 붙으면    GET    …/tracks/{tid}/chunks     → 가진 seq 목록
        │  ④ 녹음 종료        POST   …/tracks/{tid}/complete
        ▼
[서버]  chunk_store(파일)  +  track_chunks(시각)
```

## 동의 검사를 서버에서 다시 하는 이유

클라이언트 상태 머신(`session.ts`)이 이미 막고 있다. 그래도 서버가 또 막는다.
클라이언트 검사는 **UX** 이고 서버 검사는 **법적 방어선**이기 때문이다.
브라우저는 사용자 손에 있고, 요청은 curl 로도 보낼 수 있다.
제3자 녹음은 형사처벌 대상이라 (통신비밀보호법) 이건 양보할 수 없다.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.audio import assembly
from teamflow.audio.chunk_store import ChunkStore
from teamflow.db import models as m

RECORDING_CONSENT = "recording"


class ConsentError(Exception):
    """동의가 확인되지 않아 수집을 거부한다."""


class TrackError(Exception):
    """트랙 상태가 맞지 않는다."""


@dataclass(frozen=True, slots=True)
class ConsentStatus:
    """회의 참여자들의 동의 현황."""

    total: int
    granted: int
    refused: int

    @property
    def all_confirmed(self) -> bool:
        # 아무도 응답하지 않았으면 "전원 동의"가 아니다.
        # 빈 집합에 대한 전칭명제는 참이지만, 여기서는 그게 곧 사고다.
        return self.total > 0 and self.granted == self.total

    def describe(self) -> str:
        if self.total == 0:
            return "녹음 동의 기록이 없습니다"
        if self.refused:
            return f"{self.refused}명이 녹음에 동의하지 않았습니다"
        return f"{self.total - self.granted}명이 아직 동의하지 않았습니다"


def consent_status(session: Session, meeting_id: int) -> ConsentStatus:
    """이 회의의 녹음 동의(①단계) 현황.

    참여자 집합은 `recording_consents` 에 행이 있는 사람들이다. 회의방에
    들어온 순간 행이 만들어진다.

    ⚠️ **한계**: 앱을 켜지 않고 자리에 앉아 있는 사람은 시스템이 알 수 없다.
    그 사람에 대해서는 소프트웨어가 해줄 수 있는 게 없고, 화면에서 "참석자
    전원이 동의했는지" 육안 확인을 요구하는 수밖에 없다. 숨기지 말고 그렇게 적는다.
    """
    rows = session.scalars(
        select(m.RecordingConsent).where(
            m.RecordingConsent.meeting_id == meeting_id,
            m.RecordingConsent.consent_type == RECORDING_CONSENT,
        )
    ).all()
    granted = sum(1 for r in rows if r.consented)
    return ConsentStatus(total=len(rows), granted=granted, refused=len(rows) - granted)


def require_consent(session: Session, meeting_id: int) -> ConsentStatus:
    status = consent_status(session, meeting_id)
    if not status.all_confirmed:
        raise ConsentError(status.describe())
    return status


def join_track(
    session: Session,
    *,
    meeting_id: int,
    user_id: int,
    started_at: datetime,
    device_label: str | None = None,
    sample_rate: int | None = None,
) -> m.MeetingTrack:
    """트랙을 만들거나 기존 것을 돌려준다.

    멱등이다. 회의 도중 브라우저를 새로고침해도 같은 트랙으로 이어붙는다 —
    새 트랙이 생기면 그 사람이 두 명으로 세어진다.
    """
    require_consent(session, meeting_id)

    track = session.scalars(
        select(m.MeetingTrack).where(
            m.MeetingTrack.meeting_id == meeting_id,
            m.MeetingTrack.user_id == user_id,
        )
    ).one_or_none()

    if track is not None:
        if track.status != "recording":
            raise TrackError(f"이미 종료된 트랙입니다 (status={track.status})")
        return track

    track = m.MeetingTrack(
        meeting_id=meeting_id,
        user_id=user_id,
        device_label=device_label,
        started_at=started_at,
        sample_rate=sample_rate,
        status="recording",
        gaps=[],
        capture_warnings=[],
    )
    session.add(track)
    session.flush()
    return track


def _load_track(session: Session, meeting_id: int, track_id: int) -> m.MeetingTrack:
    track = session.get(m.MeetingTrack, track_id)
    if track is None or track.meeting_id != meeting_id:
        raise TrackError("트랙을 찾을 수 없습니다")
    return track


def store_chunk(
    session: Session,
    store: ChunkStore,
    *,
    meeting_id: int,
    track_id: int,
    seq: int,
    client_at_ms: int,
    data: bytes,
) -> m.TrackChunk:
    """청크 하나를 저장한다. 같은 seq 를 다시 받으면 덮어쓴다 (멱등).

    **파일을 먼저 쓰고 DB 행을 넣는다.** 순서가 중요하다.
    DB 를 먼저 쓰면 파일 쓰기가 실패했을 때 "가지고 있다"고 답하게 되고,
    클라이언트는 다시 올릴 기회를 잃는다. 반대 순서면 최악의 경우 고아
    파일이 남을 뿐인데, 그건 재개 조회가 파일시스템을 보므로 스스로 복구된다.
    """
    track = _load_track(session, meeting_id, track_id)
    if track.status != "recording":
        raise TrackError(f"녹음이 끝난 트랙입니다 (status={track.status})")

    # 매 청크마다 확인한다. 회의 도중에 철회할 수 있기 때문이다.
    require_consent(session, meeting_id)

    store.write(meeting_id, track_id, seq, data)

    chunk = session.scalars(
        select(m.TrackChunk).where(
            m.TrackChunk.track_id == track_id, m.TrackChunk.seq == seq
        )
    ).one_or_none()

    if chunk is None:
        chunk = m.TrackChunk(
            track_id=track_id, seq=seq, bytes=len(data), client_at_ms=client_at_ms
        )
        session.add(chunk)
        session.flush()
    else:
        chunk.bytes = len(data)
        chunk.client_at_ms = client_at_ms

    return chunk


def stored_seqs(store: ChunkStore, *, meeting_id: int, track_id: int) -> list[int]:
    """재개용. 서버가 실제로 **파일로** 가지고 있는 seq 목록."""
    return store.stored_seqs(meeting_id, track_id)


@dataclass(frozen=True, slots=True)
class TrackSummary:
    """클라이언트가 녹음을 마치며 보고하는 품질 정보.

    `frontend/…/client.ts` 의 `RecordingSummary` 와 짝이다.
    """

    ended_at: datetime
    coverage: float
    total_gap_ms: int
    longest_gap_ms: int
    gaps: list[dict]
    capture_confidence: float
    capture_warnings: list[dict]
    stop_reason: str | None = None
    #: `MediaRecorder.start(timeslice)` 값. 서버가 배치를 다시 계산할 때 쓴다.
    timeslice_ms: int = 5_000


def _epoch_ms(value: datetime) -> int:
    """DB 에서 온 datetime 을 epoch ms 로. SQLite 는 naive 로 돌려준다."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return int(value.timestamp() * 1000)


def build_plan(session: Session, track: m.MeetingTrack, *, timeslice_ms: int) -> assembly.TrackPlan:
    """서버가 **실제로 받은** 청크로 배치 계획을 세운다.

    클라이언트 보고와 별개로 계산한다. 오디오를 실제로 배치하는 건 서버이므로
    배치의 근거도 서버가 가진 사실이어야 한다 (`audio/assembly.py` 참고).
    """
    rows = session.scalars(
        select(m.TrackChunk).where(m.TrackChunk.track_id == track.id)
    ).all()
    return assembly.plan_track(
        [assembly.ChunkRecord(seq=r.seq, client_at_ms=r.client_at_ms) for r in rows],
        timeslice_ms=timeslice_ms,
        started_at_ms=_epoch_ms(track.started_at),
        ended_at_ms=_epoch_ms(track.ended_at or track.started_at),
    )


# 이 아래면 트랙을 쓰지 않는다. frontend timeline.ts 의 MIN_USABLE_COVERAGE 와 같은 값.
MIN_USABLE_COVERAGE = 0.8


def complete_track(
    session: Session,
    store: ChunkStore,
    *,
    meeting_id: int,
    track_id: int,
    summary: TrackSummary,
) -> m.MeetingTrack:
    """녹음 종료를 기록한다.

    클라이언트가 보고한 커버리지를 **그대로 믿지 않는다.** 서버가 실제로 받은
    청크로 배치를 다시 계산해 더 나쁜 쪽을 택한다. 클라이언트는 자기가 *만든*
    청크를 기준으로 계산하는데, 그중 일부는 업로드에 실패해 서버에 없다.

    저장되는 공백 목록은 **서버 계산 + 클라이언트만 아는 것**의 합집합이다.
    `track_muted`(청크는 오는데 내용이 무음)는 서버가 알 방법이 없으므로
    클라이언트 보고를 그대로 받는다.
    """
    track = _load_track(session, meeting_id, track_id)
    track.ended_at = summary.ended_at

    plan = build_plan(session, track, timeslice_ms=summary.timeslice_ms)

    # 파일이 실제로 있는지도 본다. DB 행은 있는데 파일이 없으면 그건 공백이다.
    on_disk = set(store.stored_seqs(meeting_id, track_id))
    placed = {p.seq for p in plan.placements}
    orphaned = placed - on_disk

    coverage = min(float(summary.coverage), plan.coverage)
    if placed:
        coverage = min(coverage, (len(placed) - len(orphaned)) / len(placed))

    server_gaps = [
        {"reason": g.reason, "startMs": g.start_ms, "endMs": g.end_ms, "durationMs": g.duration_ms}
        for g in plan.gaps
    ]
    # 서버가 볼 수 없는 원인만 클라이언트에서 가져온다
    client_only = [g for g in summary.gaps if g.get("reason") == "track_muted"]

    track.coverage = round(coverage, 3)
    track.total_gap_ms = max(summary.total_gap_ms, plan.total_gap_ms)
    track.longest_gap_ms = max(summary.longest_gap_ms, plan.longest_gap_ms)
    track.gaps = server_gaps + client_only
    track.capture_confidence = round(float(summary.capture_confidence), 3)
    track.capture_warnings = summary.capture_warnings
    track.stop_reason = summary.stop_reason
    track.status = "completed" if coverage >= MIN_USABLE_COVERAGE else "unusable"
    session.flush()
    return track


def track_health(session: Session, meeting_id: int) -> list[dict]:
    """회의의 트랙별 상태. 승인 화면에서 "이 트랙은 못 씁니다"를 띄우는 근거."""
    tracks = session.scalars(
        select(m.MeetingTrack)
        .where(m.MeetingTrack.meeting_id == meeting_id)
        .order_by(m.MeetingTrack.id)
    ).all()
    return [
        {
            "track_id": t.id,
            "user_id": t.user_id,
            "status": t.status,
            "coverage": float(t.coverage) if t.coverage is not None else None,
            "total_gap_ms": t.total_gap_ms,
            "capture_confidence": (
                float(t.capture_confidence) if t.capture_confidence is not None else None
            ),
            "warnings": t.capture_warnings,
            "stop_reason": t.stop_reason,
        }
        for t in tracks
    ]


def now_utc() -> datetime:
    return datetime.now(UTC)
