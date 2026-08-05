"""데이터베이스 스키마.

docs/06-데이터-모델.md 를 SQLAlchemy 선언적 모델로 옮긴 것.

제안서 10장 스키마에 세 가지를 더했다.
    1. 기여도 재계산 구조 — 점수를 저장하지 않고 이벤트에서 다시 계산
    2. 법적 요구사항 — 3단계 녹음 동의, 오디오 분리 보관
    3. 멀티트랙 — 트랙 = 사람, 화자 라벨 출처 추적
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# ── dialect 변형 ──────────────────────────────────────────────
#
# 프로덕션은 PostgreSQL이지만, 테스트는 SQLite 인메모리로 돌린다.
# 개발 환경에 Docker 데몬이 없어도 실제 DB 통합 테스트를 할 수 있어야 하기 때문이다.
#
# with_variant() 를 쓰면 PostgreSQL에서는 JSONB/ARRAY/INET 이 그대로 나가고,
# SQLite에서는 JSON 으로 대체된다. 프로덕션 타입을 낮추지 않으면서 테스트가 가능해진다.

JSONType = JSONB().with_variant(JSON(), "sqlite")
BigIntArray = ARRAY(BigInteger).with_variant(JSON(), "sqlite")
NumericArray = ARRAY(Numeric).with_variant(JSON(), "sqlite")
InetType = INET().with_variant(String(45), "sqlite")

# SQLite는 `INTEGER PRIMARY KEY` 만 autoincrement 한다. BIGINT는 rowid 별칭이
# 되지 않아 NOT NULL 위반이 난다. PostgreSQL에서는 BIGINT를 그대로 쓴다.
PkType = BigInteger().with_variant(Integer, "sqlite")


class Base(DeclarativeBase):
    pass


def _pk() -> Mapped[int]:
    return mapped_column(PkType, primary_key=True, autoincrement=True)


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


# ══════════════════════════════════════════════════════════════
# 1. 핵심 협업 (제안서 10장)
# ══════════════════════════════════════════════════════════════


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = _pk()
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    # 시스템 권한: student | instructor | admin
    role: Mapped[str] = mapped_column(String(20), nullable=False, default="student")
    created_at: Mapped[datetime] = _now()


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = _pk()
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    github_repo: Mapped[str | None] = mapped_column(String(255))
    github_installation_id: Mapped[int | None] = mapped_column(BigInteger)
    # GitHub 연결 시각. 이 이전 기간은 백필로 채우며, 신뢰도 계산에 쓰인다.
    github_connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class Member(Base):
    __tablename__ = "members"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    # 겸직 지원: {"developer": 0.7, "planner": 0.3}
    role_shares: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    skills: Mapped[list | None] = mapped_column(JSONType)
    github_login: Mapped[str | None] = mapped_column(String(100))

    __table_args__ = (UniqueConstraint("project_id", "user_id", name="uq_member"),)


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="todo")
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=2)
    difficulty: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 회의에서 만들어진 업무라면 그 후보를 가리킨다
    origin_candidate_id: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        CheckConstraint("difficulty BETWEEN 1 AND 3", name="ck_task_difficulty"),
    )


class TaskDeadlineChange(Base):
    """마감일 변경 이력.

    마감을 계속 뒤로 미루면 준수율이 올라간다 (docs/05 §2.4).
    점수를 깎지는 않지만 변경 횟수는 반드시 남긴다.
    """

    __tablename__ = "task_deadline_changes"

    id: Mapped[int] = _pk()
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), nullable=False)
    changed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    old_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    new_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str | None] = mapped_column(Text)
    changed_at: Mapped[datetime] = _now()


class TaskDependency(Base):
    __tablename__ = "task_dependencies"

    predecessor_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id"), primary_key=True
    )
    successor_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), primary_key=True)

    __table_args__ = (
        CheckConstraint("predecessor_id <> successor_id", name="ck_no_self_dependency"),
    )


# ══════════════════════════════════════════════════════════════
# 2. GitHub
# ══════════════════════════════════════════════════════════════


class GithubEvent(Base):
    __tablename__ = "github_events"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    # GitHub의 delivery id. 웹훅 재전송과 백필 중복을 막는다.
    delivery_id: Mapped[str | None] = mapped_column(String(100))
    repo: Mapped[str] = mapped_column(String(255), nullable=False)
    event_type: Mapped[str] = mapped_column(String(50), nullable=False)
    actor_login: Mapped[str] = mapped_column(String(100), nullable=False)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    ref: Mapped[str | None] = mapped_column(String(255))
    payload: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    recorded_at: Mapped[datetime] = _now()

    __table_args__ = (
        UniqueConstraint("repo", "event_type", "delivery_id", name="uq_github_delivery"),
        Index("ix_github_events_project_time", "project_id", "occurred_at"),
    )


class TaskGithubLink(Base):
    __tablename__ = "task_github_links"

    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id"), primary_key=True)
    github_event_id: Mapped[int] = mapped_column(
        ForeignKey("github_events.id"), primary_key=True
    )
    # 1.0 = #123 / 브랜치명으로 확정 연결, < 1.0 = 임베딩 유사도 기반 후보
    relevance: Mapped[float] = mapped_column(Numeric(4, 3), nullable=False, default=1.0)
    link_source: Mapped[str] = mapped_column(String(20), nullable=False, default="explicit")
    confirmed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))


# ══════════════════════════════════════════════════════════════
# 3. 회의
# ══════════════════════════════════════════════════════════════


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    duration_sec: Mapped[int | None] = mapped_column(Integer)
    # multitrack | single  — docs/04 의 모드 A / 모드 B
    capture_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="multitrack")
    # pending | processing | needs_review | confirmed | failed
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    # 녹음을 시작한 사람. 통신비밀보호법상 반드시 회의 참석자여야 한다 (docs/07 L1).
    started_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = _now()


class MeetingTrack(Base):
    """멀티트랙 녹음의 트랙 하나. 트랙 = 사람."""

    __tablename__ = "meeting_tracks"

    id: Mapped[int] = _pk()
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    device_label: Mapped[str | None] = mapped_column(String(100))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 트랙 간 시간 정렬 보정값
    offset_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sample_rate: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (UniqueConstraint("meeting_id", "user_id", name="uq_track_user"),)


class Utterance(Base):
    __tablename__ = "utterances"

    id: Mapped[int] = _pk()
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"), nullable=False)
    speaker_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    track_id: Mapped[int | None] = mapped_column(ForeignKey("meeting_tracks.id"))
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)

    # 화자 라벨이 어떻게 정해졌는가. 신뢰도 계산의 핵심 입력.
    #   track       : 멀티트랙 → 확정 (신뢰도 1.0)
    #   voiceprint  : 성문 임베딩 매칭 → 유사도 있음
    #   manual      : 사람이 지정
    #   diarization : SPEAKER_XX 미매핑 → 불확실
    speaker_source: Mapped[str] = mapped_column(
        String(20), nullable=False, default="diarization"
    )
    speaker_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3))
    is_overlap: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # docs/10 Q9 확정 8개 라벨
    utterance_type: Mapped[str | None] = mapped_column(String(20))
    type_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3))

    # 반복 논의 탐지용. 실제 컬럼 타입은 pgvector 의 vector(768).
    # Alembic 마이그레이션에서 `CREATE EXTENSION vector` 후 ALTER 로 교체한다.
    embedding: Mapped[list | None] = mapped_column(NumericArray)

    __table_args__ = (
        CheckConstraint("end_ms >= start_ms", name="ck_utterance_span"),
        CheckConstraint(
            "speaker_source IN ('track','voiceprint','manual','diarization')",
            name="ck_speaker_source",
        ),
        Index("ix_utterances_meeting_time", "meeting_id", "start_ms"),
    )


class Decision(Base):
    __tablename__ = "decisions"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    # active | superseded | withdrawn
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    # 이 결정이 뒤집은 이전 결정 (제안서 5장의 결정 번복 추적)
    supersedes_id: Mapped[int | None] = mapped_column(ForeignKey("decisions.id"))
    evidence_utterance_ids: Mapped[list | None] = mapped_column(BigIntArray)
    confirmed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = _now()


class MeetingTaskCandidate(Base):
    """AI가 추출한 업무 **후보**.

    승인 전에는 절대 tasks 로 넘어가지 않는다 (docs/03 §3).
    음성 인식 오류로 엉뚱한 사람에게 업무가 배정되는 것을 막는 안전장치다.
    """

    __tablename__ = "meeting_task_candidates"

    id: Mapped[int] = _pk()
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    # 전사에 등장한 이름 그대로. user_id 매핑은 서버가 별도로 한다.
    assignee_hint: Mapped[str | None] = mapped_column(String(100))
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    confidence: Mapped[float] = mapped_column(Numeric(4, 3), nullable=False)
    # LLM 출력의 근거. 존재하지 않는 ID를 참조하면 서버가 후보를 버린다.
    evidence_utterance_ids: Mapped[list] = mapped_column(
        BigIntArray, nullable=False
    )
    # pending | approved | rejected
    review_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_task_id: Mapped[int | None] = mapped_column(ForeignKey("tasks.id"))
    created_at: Mapped[datetime] = _now()


class MeetingEvent(Base):
    """비효율 구간 등 회의 분석 결과 (제안서 6.5)."""

    __tablename__ = "meeting_events"

    id: Mapped[int] = _pk()
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"), nullable=False)
    # repeated_discussion | unanswered_question | incomplete_task |
    # topic_drift | decision_conflict
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)
    severity: Mapped[str] = mapped_column(String(10), nullable=False, default="info")
    start_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    end_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    evidence_utterance_ids: Mapped[list] = mapped_column(
        BigIntArray, nullable=False
    )
    detail: Mapped[dict] = mapped_column(JSONType, nullable=False, default=dict)


# ══════════════════════════════════════════════════════════════
# 4. 기여도 — 저장하지 않고 재계산하는 구조 (docs/06 §2)
# ══════════════════════════════════════════════════════════════


class ContributionEventRow(Base):
    """불변 기여 이벤트. INSERT 만. UPDATE/DELETE 없음.

    정정이 필요하면 상쇄 이벤트를 추가한다.
    """

    __tablename__ = "contribution_events"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)

    # 실제 발생 시각. 백필한 과거 이벤트를 올바른 기간에 귀속시키기 위해
    # 수집 시각(recorded_at)과 분리한다.
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    recorded_at: Mapped[datetime] = _now()

    category: Mapped[str] = mapped_column(String(20), nullable=False)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)

    source_kind: Mapped[str] = mapped_column(String(20), nullable=False)
    source_id: Mapped[int] = mapped_column(BigInteger, nullable=False)

    magnitude: Mapped[float | None] = mapped_column(Numeric(12, 3))
    event_metadata: Mapped[dict] = mapped_column(
        "metadata", JSONType, nullable=False, default=dict
    )

    __table_args__ = (
        # 웹훅 재전송·백필 중복 방어. 이게 없으면 점수가 부풀려진다.
        UniqueConstraint(
            "source_kind", "source_id", "event_type", name="uq_contribution_source"
        ),
        Index("ix_contrib_project_user_time", "project_id", "user_id", "occurred_at"),
    )


class ScoringProfileRow(Base):
    """가중치 버전. 덮어쓰지 않고 새 행을 만든다."""

    __tablename__ = "scoring_profiles"

    id: Mapped[int] = _pk()
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"))
    project_role: Mapped[str] = mapped_column(String(20), nullable=False)
    weights: Mapped[dict] = mapped_column(JSONType, nullable=False)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = _now()
    note: Mapped[str | None] = mapped_column(Text)


class ScoreRun(Base):
    """계산 실행 기록. 어떤 가중치·어떤 산식 버전으로 계산했는지."""

    __tablename__ = "score_runs"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    profile_id: Mapped[int | None] = mapped_column(ForeignKey("scoring_profiles.id"))
    algo_version: Mapped[str] = mapped_column(String(40), nullable=False)
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    computed_at: Mapped[datetime] = _now()


class ScoreResult(Base):
    __tablename__ = "score_results"

    run_id: Mapped[int] = mapped_column(
        ForeignKey("score_runs.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    category: Mapped[str] = mapped_column(String(20), primary_key=True)
    raw_value: Mapped[float] = mapped_column(Numeric(12, 4), nullable=False)
    weighted: Mapped[float] = mapped_column(Numeric(12, 6), nullable=False)
    confidence: Mapped[float] = mapped_column(Numeric(4, 3), nullable=False)
    range_low: Mapped[float | None] = mapped_column(Numeric(6, 3))
    range_high: Mapped[float | None] = mapped_column(Numeric(6, 3))
    # 화면의 모든 숫자가 원본 이벤트로 역추적된다 (docs/07 E5)
    evidence_ids: Mapped[list] = mapped_column(BigIntArray, nullable=False)


class FinalContribution(Base):
    """시스템 제안값과 사람이 확정한 값을 분리한다.

    "AI가 점수를 정하지 않는다"는 원칙이 데이터로 표현되는 지점.
    """

    __tablename__ = "final_contributions"

    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("score_runs.id"), nullable=False)
    system_value: Mapped[float] = mapped_column(Numeric(6, 3), nullable=False)
    final_value: Mapped[float] = mapped_column(Numeric(6, 3), nullable=False)
    adjusted_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # 조정 범위를 벗어나면 필수
    reason: Mapped[str | None] = mapped_column(Text)
    confirmed_at: Mapped[datetime] = _now()


class PeerReview(Base):
    """동료평가. CATME 5개 카테고리 구조 참조 (문항은 자체 설계).

    ⚠️ CATME 서비스 자체는 유료다. 가입하지 말 것 (docs/11 §1).
    """

    __tablename__ = "peer_reviews"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    reviewer_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    reviewee_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    # {"team_contribution": 4, "interaction": 5, "keeping_on_track": 3,
    #  "expecting_quality": 4, "knowledge_skills": 4}
    ratings: Mapped[dict] = mapped_column(JSONType, nullable=False)
    comment: Mapped[str | None] = mapped_column(Text)
    submitted_at: Mapped[datetime] = _now()

    __table_args__ = (
        UniqueConstraint(
            "project_id", "reviewer_id", "reviewee_id", name="uq_peer_review"
        ),
        CheckConstraint("reviewer_id <> reviewee_id", name="ck_no_self_review"),
    )


# ══════════════════════════════════════════════════════════════
# 5. 법적 요구사항 (docs/07)
# ══════════════════════════════════════════════════════════════


class RecordingConsent(Base):
    """녹음 동의. 3단계로 분리한다.

    개인정보보호법상 **생체인식정보 원본 보관**은 별도 동의 사안이다.
    "회의를 녹음해도 되는가"와 "당신의 성문을 저장해도 되는가"는 다른 질문이다.

    ②③을 거부해도 서비스는 동작해야 한다 (필요 최소 수집 원칙).
    """

    __tablename__ = "recording_consents"

    id: Mapped[int] = _pk()
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    consented: Mapped[bool] = mapped_column(Boolean, nullable=False)
    # recording | raw_audio_retention | voiceprint_storage
    consent_type: Mapped[str] = mapped_column(String(30), nullable=False)
    consented_at: Mapped[datetime] = _now()
    ip_address: Mapped[str | None] = mapped_column(InetType)

    __table_args__ = (
        UniqueConstraint(
            "meeting_id", "user_id", "consent_type", name="uq_consent"
        ),
        CheckConstraint(
            "consent_type IN ('recording','raw_audio_retention','voiceprint_storage')",
            name="ck_consent_type",
        ),
    )


class AudioAsset(Base):
    """오디오 자산. 다른 개인정보와 **분리 보관**한다.

    별도 디렉터리(볼륨) + 별도 암호화 키 + 별도 접근 권한.
    제안서 9장은 MinIO를 썼으나 2026-04 아카이브되어 로컬 파일시스템을 쓴다 (docs/11 §2).
    storage_key 의 해석만 "객체 키 → 파일 경로"로 바뀌므로 나중에 이전 가능하다.
    """

    __tablename__ = "audio_assets"

    id: Mapped[int] = _pk()
    meeting_id: Mapped[int] = mapped_column(ForeignKey("meetings.id"), nullable=False)
    track_id: Mapped[int | None] = mapped_column(ForeignKey("meeting_tracks.id"))
    storage_key: Mapped[str] = mapped_column(String(500), nullable=False)
    encryption_key_id: Mapped[str] = mapped_column(String(100), nullable=False)
    # raw | segment | voiceprint_sample
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    bytes: Mapped[int | None] = mapped_column(BigInteger)
    # 만료 시 원본만 삭제하고 전사 텍스트는 남기는 것이 기본 정책
    retention_until: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()

    __table_args__ = (
        Index("ix_audio_retention", "retention_until", "deleted_at"),
    )


class Voiceprint(Base):
    """성문 임베딩 — 가장 민감한 데이터.

    ⚠️ 멀티트랙 모드(docs/04)를 쓰면 이 테이블 자체가 불필요하다.
    법적 리스크를 줄이는 또 하나의 이유다.
    """

    __tablename__ = "voiceprints"

    id: Mapped[int] = _pk()
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    # 프로젝트 범위로 한정. 프로젝트가 끝나면 폐기한다.
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    # ECAPA-TDNN 192차원. 실제 컬럼은 pgvector 의 vector(192).
    embedding: Mapped[list] = mapped_column(NumericArray, nullable=False)
    sample_asset_id: Mapped[int | None] = mapped_column(ForeignKey("audio_assets.id"))
    created_at: Mapped[datetime] = _now()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("user_id", "project_id", name="uq_voiceprint_scope"),
    )


class AuditLog(Base):
    """감사 로그.

    "팀장이 내 점수를 몰래 내렸다"는 분쟁이 실제로 생길 수 있다.
    """

    __tablename__ = "audit_logs"

    id: Mapped[int] = _pk()
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id"))
    actor_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    # score_adjusted | consent_revoked | audio_deleted | weights_changed |
    # candidate_approved | member_removed
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    target: Mapped[str] = mapped_column(String(100), nullable=False)
    before: Mapped[dict | None] = mapped_column(JSONType)
    after: Mapped[dict | None] = mapped_column(JSONType)
    at: Mapped[datetime] = _now()

    __table_args__ = (Index("ix_audit_project_time", "project_id", "at"),)


class Report(Base):
    __tablename__ = "reports"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    # weekly | final | meeting_minutes
    report_type: Mapped[str] = mapped_column(String(20), nullable=False)
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content: Mapped[dict] = mapped_column(JSONType, nullable=False)
    generated_at: Mapped[datetime] = _now()
