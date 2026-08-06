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
    """회의 참여자들의 동의 현황.

    `total` 은 **프로젝트 구성원 수**다. 동의 행이 있는 사람 수가 아니다.
    아래 `consent_status` 의 설명 참조 — 이 구분이 이 클래스의 전부다.
    """

    total: int
    granted: int
    refused: int

    @property
    def pending(self) -> int:
        """아직 아무 응답도 하지 않은 사람. 거부(refused)와 다르다."""
        return self.total - self.granted - self.refused

    @property
    def all_confirmed(self) -> bool:
        # 아무도 없거나, 거부가 있거나, 아직 답 안 한 사람이 있으면 아니다.
        # 빈 집합에 대한 전칭명제는 참이지만, 여기서는 그게 곧 사고다.
        return self.total > 0 and self.granted == self.total

    def describe(self) -> str:
        if self.total == 0:
            return "이 프로젝트에 구성원이 없습니다"
        if self.refused:
            return f"{self.refused}명이 녹음에 동의하지 않았습니다"
        return f"{self.pending}명이 아직 동의하지 않았습니다"


def consent_status(session: Session, meeting_id: int) -> ConsentStatus:
    """이 회의의 녹음 동의(①단계) 현황.

    ⚠️ **분모는 프로젝트 구성원이다.** 동의 행이 있는 사람이 아니다.

    예전에는 `recording_consents` 행만 셌다. 그러면 3명 팀에서 1명만 동의해도
    total=1, granted=1 이라 **"전원 동의했습니다. 녹음을 시작할 수 있습니다"**
    가 떴다. 법적 게이트가 초록불을 켜 주는데 두 사람은 아무 말도 한 적이
    없는 상태다.

    같은 오류가 두 곳에서 났었다 — 여기와 `join_track`. 뿌리가 같다:
    **응답하지 않은 사람을 분모에서 빼면 침묵이 동의가 된다.**

    ⚠️ 남는 한계 둘. 숨기지 않고 적는다.

    1. 회의에 안 오는 구성원이 있으면 그 사람이 응답할 때까지 녹음을 시작할
       수 없다. 그게 안전한 쪽이다 — 반대로 하면 "출석한 사람만 동의하면 된다"
       가 되는데, 시스템은 누가 출석했는지 모른다.
    2. 앱을 켜지 않고 자리에 앉아 있는 사람은 시스템이 알 수 없다. 소프트웨어가
       해줄 수 있는 게 없고, 화면에서 육안 확인을 요구하는 수밖에 없다.
    """
    meeting = session.get(m.Meeting, meeting_id)
    if meeting is None:
        return ConsentStatus(total=0, granted=0, refused=0)

    member_ids = set(
        session.scalars(
            select(m.Member.user_id).where(m.Member.project_id == meeting.project_id)
        ).all()
    )

    rows = session.scalars(
        select(m.RecordingConsent).where(
            m.RecordingConsent.meeting_id == meeting_id,
            m.RecordingConsent.consent_type == RECORDING_CONSENT,
        )
    ).all()

    # 구성원이 아닌 사람의 동의 행은 세지 않는다. 있어서는 안 되지만
    # (`submit_consent` 가 막는다), 있다고 해서 분자를 부풀리면 안 된다.
    granted = sum(1 for r in rows if r.consented and r.user_id in member_ids)
    refused = sum(1 for r in rows if not r.consented and r.user_id in member_ids)
    return ConsentStatus(total=len(member_ids), granted=granted, refused=refused)


def require_consent(session: Session, meeting_id: int) -> ConsentStatus:
    """회의 **전체**가 동의했는가. 이것만으로는 부족하다 — 아래를 같이 쓴다."""
    status = consent_status(session, meeting_id)
    if not status.all_confirmed:
        raise ConsentError(status.describe())
    return status


def require_own_consent(session: Session, meeting_id: int, user_id: int) -> None:
    """**이 사람 본인**이 동의했는가.

    ⚠️ 전체 동의만 확인하면 구멍이 난다. `consent_status` 는 동의 행이 있는
    사람만 세므로, **동의 행이 아예 없는 사람은 분모에도 안 들어간다.**
    다른 참석자 셋이 동의를 마쳐 놓으면 넷째 사람은 아무 기록 없이 트랙을
    만들고 자기 목소리를 올릴 수 있었다.

    그 오디오는 발화가 되고 기여도 계산에 들어간다. 개인정보보호법이
    요구하는 건 "회의가 동의를 받았다" 가 아니라 **"이 사람이 동의했다"**
    이므로, 법적 방어선이 통째로 없는 상태였다 (docs/07 L1·P1).

    회의 도중 철회하면 그 즉시 여기서 막힌다 — 청크마다 확인하기 때문이다.
    이미 받은 것은 지우지 않는다. 철회는 소급하지 않는다.
    """
    row = session.scalars(
        select(m.RecordingConsent).where(
            m.RecordingConsent.meeting_id == meeting_id,
            m.RecordingConsent.user_id == user_id,
            m.RecordingConsent.consent_type == RECORDING_CONSENT,
        )
    ).one_or_none()

    if row is None:
        raise ConsentError("본인의 녹음 동의 기록이 없습니다")
    if not row.consented:
        raise ConsentError("녹음에 동의하지 않았습니다")


def require_project_member(session: Session, meeting_id: int, user_id: int) -> None:
    """이 회의가 속한 프로젝트의 구성원인가 (docs/07 P7).

    동의는 "내 목소리를 써도 된다" 는 것이고, 이건 "이 회의에 들어올 자격이
    있는가" 다. 둘은 다른 질문이라 따로 확인한다 — 남의 프로젝트 회의에
    동의서를 내고 들어가는 걸 동의 검사만으로는 막을 수 없다.
    """
    meeting = session.get(m.Meeting, meeting_id)
    if meeting is None:
        raise TrackError("회의를 찾을 수 없습니다")

    member = session.scalars(
        select(m.Member).where(
            m.Member.project_id == meeting.project_id,
            m.Member.user_id == user_id,
        )
    ).one_or_none()
    if member is None:
        raise ConsentError("이 프로젝트의 구성원이 아닙니다")


#: 3단계 동의. ②③ 을 거부해도 서비스는 동작해야 한다 (필요 최소 수집 원칙).
CONSENT_TYPES = ("recording", "raw_audio_retention", "voiceprint_storage")


def submit_consent(
    session: Session,
    *,
    meeting_id: int,
    user_id: int,
    consent_type: str,
    consented: bool,
    ip_address: str | None = None,
) -> m.RecordingConsent:
    """동의를 제출하거나 철회한다.

    같은 (회의, 사람, 종류) 는 행 하나다. 다시 제출하면 덮어쓴다 —
    화면을 새로고침해도 동의가 두 번 세어지면 안 된다.

    ## 철회는 소급하지 않는다

    `consented=False` 로 바꾸면 **이후 청크만** 막힌다. 이미 받은 오디오는
    지우지 않는다. 그건 삭제 요청(docs/07 P6)이라는 별도 절차이고, 보존기간
    삭제 잡이 따로 처리한다. 여기서 지워 버리면 이미 승인된 업무의 근거가
    끊어진다.

    ⚠️ 회의가 이미 끝난 뒤의 동의 제출은 막지 않는다. 늦게 낸 동의도
    기록으로서 의미가 있고, 녹음은 어차피 트랙 상태로 막힌다.
    """
    if consent_type not in CONSENT_TYPES:
        raise ValueError(f"알 수 없는 동의 종류입니다: {consent_type}")

    require_project_member(session, meeting_id, user_id)

    row = session.scalars(
        select(m.RecordingConsent).where(
            m.RecordingConsent.meeting_id == meeting_id,
            m.RecordingConsent.user_id == user_id,
            m.RecordingConsent.consent_type == consent_type,
        )
    ).one_or_none()

    if row is None:
        row = m.RecordingConsent(
            meeting_id=meeting_id,
            user_id=user_id,
            consent_type=consent_type,
            consented=consented,
            ip_address=ip_address,
        )
        session.add(row)
    else:
        row.consented = consented
        row.consented_at = datetime.now(UTC)
        if ip_address:
            row.ip_address = ip_address

    session.flush()
    return row


def consent_roster(session: Session, meeting_id: int) -> list[dict]:
    """**프로젝트 구성원 전원**에 대한 동의 현황.

    동의 행이 있는 사람만 보여주면 아무 의미가 없다 — 아직 아무 응답도 하지
    않은 사람이 화면에서 사라지기 때문이다. 그 사람이야말로 기다려야 하는
    대상이다.
    """
    meeting = session.get(m.Meeting, meeting_id)
    if meeting is None:
        raise TrackError("회의를 찾을 수 없습니다")

    members = session.execute(
        select(m.Member.user_id, m.User.name)
        .join(m.User, m.User.id == m.Member.user_id)
        .where(m.Member.project_id == meeting.project_id)
        .order_by(m.Member.user_id)
    ).all()

    rows = session.scalars(
        select(m.RecordingConsent).where(m.RecordingConsent.meeting_id == meeting_id)
    ).all()
    by_user: dict[int, dict[str, bool]] = {}
    for row in rows:
        by_user.setdefault(row.user_id, {})[row.consent_type] = row.consented

    roster = []
    for user_id, name in members:
        answers = by_user.get(user_id, {})
        roster.append(
            {
                "user_id": user_id,
                "name": name,
                # None = 아직 응답 없음. False(거부)와 구분해야 한다 —
                # 화면이 "기다리는 중" 과 "거부함" 을 다르게 말해야 하므로.
                "recording": answers.get("recording"),
                "raw_audio_retention": answers.get("raw_audio_retention"),
                "voiceprint_storage": answers.get("voiceprint_storage"),
            }
        )
    return roster


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

    게이트가 셋이다. 하나라도 빠지면 방어선이 아니다.
        1. 이 프로젝트 구성원인가          (docs/07 P7)
        2. **본인이** 동의했는가            (docs/07 P1) ← 이게 빠져 있었다
        3. 참석자 전원이 동의했는가        (docs/07 L1)
    """
    require_project_member(session, meeting_id, user_id)
    require_own_consent(session, meeting_id, user_id)
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
    # 본인 동의를 먼저 본다 — 혼자 철회한 경우 전체 검사만으로는 막히지 않는다
    # (철회하면 granted 가 줄지만 total 도 그대로라 "아직 동의하지 않았습니다"
    # 로 걸리기는 한다. 그래도 이유가 정확해야 화면이 옳은 말을 한다).
    require_own_consent(session, meeting_id, track.user_id)
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


# ══════════════════════════════════════════════════════════════
# 녹음 종료 → 처리 시작
# ══════════════════════════════════════════════════════════════
#
# 이 연결이 없으면 녹음은 저장되기만 하고 아무 일도 일어나지 않는다.
# 회의 하나는 참여자 수만큼의 트랙으로 이루어지고, **전원이 끝내야** 처리를
# 시작할 수 있다 — 한 명이라도 녹음 중이면 그 사람 발언이 통째로 빠진다.


@dataclass(frozen=True, slots=True)
class FinalizeResult:
    """녹음 종료 판정."""

    ready: bool
    #: 이번 호출이 처리 시작을 **확정한** 경우에만 True.
    #: 동시에 두 명이 종료해도 하나만 True 가 된다.
    should_enqueue: bool
    total_tracks: int
    finished_tracks: int
    reason: str


def try_finalize_meeting(
    session: Session, meeting_id: int, *, force: bool = False
) -> FinalizeResult:
    """전원이 녹음을 끝냈으면 회의를 처리 대기로 옮긴다.

    ## "전원" 은 트랙이 아니라 **동의한 사람** 기준이다

    트랙만 세면, 첫 번째 사람이 종료하는 순간 "트랙이 하나 있고 그게 끝났다"
    가 되어 처리가 시작된다. 나머지가 아직 녹음 중인데도. (실제로 그 버그를
    테스트가 잡았다.)

    동의 기록이 참여자 명단이다 (`consent_status` 와 같은 기준). 동의했는데
    아직 참가하지 않은 사람이 있으면 기다린다.

    ## 멱등하다 — 단, 행 잠금이 있어야 한다

    마지막 두 사람이 동시에 종료해도 `should_enqueue` 는 한 번만 True 다.
    두 번 큐에 들어가면 GPU 잡이 두 번 돌고 발화가 중복 저장된다.

    ⚠️ `pending` → `queued` 전이만으로는 **자물쇠가 되지 않는다.** READ
    COMMITTED 에서 두 트랜잭션이 모두 `status='pending'` 을 읽고, 판정은
    파이썬에서 이미 끝난 뒤에 UPDATE 가 나가기 때문이다. 실측(PostgreSQL 16,
    스레드 2개 + Barrier)에서 `should_enqueue` 가 **[True, True]** 로 나왔다.

    그래서 회의 행을 `FOR UPDATE` 로 잠근다. 두 번째 트랜잭션은 첫 번째가
    커밋할 때까지 `session.get` 에서 막히고, 풀린 뒤에는 `queued` 를 본다.
    SQLite 는 `FOR UPDATE` 를 무시하지만 어차피 커넥션 하나라 경합이 없다.

    회의가 끝나면 팀원 전원이 같은 순간에 "정지"를 누른다. 인원이 늘수록
    마지막 두 명이 겹칠 확률이 오르므로, 이건 이론적 경합이 아니다.

    Args:
        force: 참가하지 않은 사람을 기다리지 않는다. `/finish` 전용 —
            브라우저를 닫은 사람 때문에 회의가 영영 안 끝나는 걸 푼다.
    """
    # with_for_update — 위 독스트링 참조. 이 한 줄이 자물쇠다.
    meeting = session.get(m.Meeting, meeting_id, with_for_update=True)
    if meeting is None:
        raise TrackError("회의를 찾을 수 없습니다")

    tracks = session.scalars(
        select(m.MeetingTrack).where(m.MeetingTrack.meeting_id == meeting_id)
    ).all()
    finished = [t for t in tracks if t.ended_at is not None]

    if not tracks:
        return FinalizeResult(False, False, 0, 0, "트랙이 없습니다")

    if len(finished) < len(tracks):
        waiting = len(tracks) - len(finished)
        return FinalizeResult(
            False, False, len(tracks), len(finished), f"{waiting}명이 아직 녹음 중입니다"
        )

    if not force:
        expected = {
            row.user_id
            for row in session.scalars(
                select(m.RecordingConsent).where(
                    m.RecordingConsent.meeting_id == meeting_id,
                    m.RecordingConsent.consent_type == RECORDING_CONSENT,
                    m.RecordingConsent.consented.is_(True),
                )
            ).all()
        }
        joined = {t.user_id for t in tracks}
        missing = expected - joined
        if missing:
            return FinalizeResult(
                False,
                False,
                len(tracks),
                len(finished),
                f"{len(missing)}명이 아직 참가하지 않았습니다",
            )

    if meeting.status != "pending":
        # 이미 누가 먼저 확정했다. 상태만 알려주고 큐에는 넣지 않는다.
        return FinalizeResult(
            True, False, len(tracks), len(finished), f"이미 처리 중입니다 ({meeting.status})"
        )

    meeting.status = "queued"
    session.flush()
    return FinalizeResult(True, True, len(tracks), len(finished), "전원 녹음 종료")


def force_finish_tracks(
    session: Session, meeting_id: int, *, ended_at: datetime, reason: str = "aborted"
) -> list[int]:
    """아직 녹음 중인 트랙을 강제로 종료한다.

    브라우저를 그냥 닫은 사람이 있으면 그 트랙은 영원히 'recording' 으로 남고,
    회의는 영영 처리되지 않는다. 그 상태를 사람이 풀 수 있어야 한다.

    강제 종료한 트랙은 `status='aborted'` 로 남긴다 — **'completed' 로 두면
    안 된다.** 커버리지를 계산한 적이 없는데 정상 종료로 보이면, 그 사람의
    발언량을 측정한 것처럼 취급된다 (docs/05 §4.1.1).

    Returns:
        강제 종료된 트랙 id 목록.
    """
    live = session.scalars(
        select(m.MeetingTrack).where(
            m.MeetingTrack.meeting_id == meeting_id,
            m.MeetingTrack.ended_at.is_(None),
        )
    ).all()

    for track in live:
        track.ended_at = ended_at
        track.status = "aborted"
        track.stop_reason = reason
    session.flush()
    return [t.id for t in live]
