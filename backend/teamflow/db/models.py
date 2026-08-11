"""데이터베이스 스키마.

docs/06-데이터-모델.md 를 SQLAlchemy 선언적 모델로 옮긴 것.

제안서 10장 스키마에 세 가지를 더했다.
    1. 기여도 재계산 구조 — 점수를 저장하지 않고 이벤트에서 다시 계산
    2. 법적 요구사항 — 3단계 녹음 동의, 오디오 분리 보관
    3. 멀티트랙 — 트랙 = 사람, 화자 라벨 출처 추적
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

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
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, validates

from teamflow.db import vocab
from teamflow.db.vocab import SpeakerSource
from teamflow.github.connection import repo_key

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
    # scrypt 해시. 형식은 `auth/passwords.py` 참조.
    #
    # nullable 인 이유: 인증이 생기기 전에 만들어진 사용자가 있고, 그 사람들은
    # 비밀번호를 설정하기 전까지 **로그인할 수 없어야** 합니다. NULL 을
    # "비밀번호 없음 = 통과" 로 읽으면 그 계정 전부가 무인증으로 열립니다 —
    # `verify_password` 가 None 에서 False 를 돌려주는 이유입니다.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = _now()


class UserSession(Base):
    """로그인 세션 하나.

    JWT 를 쓰지 않는 이유: **로그아웃이 안 되기 때문**입니다. 서명만으로
    검증하는 토큰은 만료 전까지 서버가 취소할 수 없습니다. 회의 녹음에
    접근하는 자격이라 "지금 당장 끊는다" 가 되어야 합니다 — 동의 철회와
    같은 성격입니다(docs/07 P1).

    DB 조회 한 번이 늘지만 이 규모에서는 문제가 되지 않습니다.
    """

    __tablename__ = "user_sessions"

    id: Mapped[int] = _pk()
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    # ⚠️ 토큰 **원문이 아니라 해시**를 저장합니다.
    #
    # 원문을 저장하면 DB 를 한 번 읽은 사람이 그 순간부터 모든 사용자로
    # 로그인할 수 있습니다. 비밀번호를 해싱하면서 세션 토큰을 평문으로
    # 두면 앞의 노력이 무의미해집니다 — 토큰이 곧 그 계정이기 때문입니다.
    #
    # 토큰은 이미 무작위 32바이트라 사전 공격이 불가능하므로 scrypt 가
    # 아니라 sha256 이면 충분합니다(느리게 만들 이유가 없습니다).
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    created_at: Mapped[datetime] = _now()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 로그아웃 시각. 행을 지우지 않는 이유는 감사 때문입니다 — "누가 언제
    # 로그인해 있었는가" 는 기여도 분쟁에서 확인할 거리가 됩니다.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(String(300))

    __table_args__ = (Index("ix_user_sessions_user", "user_id"),)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = _pk()
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    # 팀원을 넣는 방법. `member_ids` 를 요청으로 받던 동안에는 **화면에서
    # 채울 수가 없었습니다** — 사용자는 남의 user_id 를 모릅니다.
    # 이메일 초대를 안 쓴 이유는 `projects/invites.py` 모듈 주석에 있습니다.
    #
    # nullable 인 이유: 이 컬럼이 생기기 전에 만들어진 프로젝트가 있고,
    # 그 프로젝트는 코드를 발급받기 전까지 **참가할 수 없어야** 합니다.
    # 빈 코드를 "아무나 통과" 로 읽으면 안 됩니다.
    invite_code: Mapped[str | None] = mapped_column(String(16), unique=True)
    #: 사람이 적은 표기 그대로. 화면과 링크는 이걸 씁니다.
    github_repo: Mapped[str | None] = mapped_column(String(255))
    # ⚠️ 웹훅이 프로젝트를 찾는 데 쓰는 **대조용** 표기(소문자).
    #
    # `github_repo` 로 직접 찾으면 대소문자가 하나만 달라도 못 찾고,
    # 웹훅은 "연결되지 않은 저장소" 로 조용히 버려집니다. 사유는
    # `teamflow/github/connection.py` 맨 위에 있습니다.
    #
    # unique 인 이유: 두 프로젝트가 같은 저장소를 가리키면 웹훅이 **어느
    # 쪽에 붙을지 정해지지 않습니다.** 응용 코드의 검사만으로는 동시에
    # 들어온 두 요청을 막을 수 없어 DB 제약으로 못 박습니다.
    #
    # 제약이 아니라 유니크 **인덱스**인 이유는 `__table_args__` 에 있습니다.
    github_repo_key: Mapped[str | None] = mapped_column(String(255))
    # ⚠️ **요청 본문으로 받지 않습니다.** 서명이 검증된 배달의
    # `installation.id` 로만 채웁니다. 화면에서 받으면 남의 설치 id 를 적어
    # 서버가 그 설치의 토큰을 발급하게 만들 수 있습니다.
    github_installation_id: Mapped[int | None] = mapped_column(BigInteger)
    # 저장소 이름을 **적어 넣은** 시각. 연결됐다는 뜻이 아닙니다.
    github_connected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # ⚠️ 서명된 배달이 **처음 도착한** 시각. 이게 연결의 유일한 증거입니다.
    #
    # 신뢰도 계산은 이 값을 씁니다(`github_connected_at` 이 아니라).
    # 이름을 적었다는 사실만으로 신뢰도가 오르면, GitHub 데이터가 0건인
    # 프로젝트가 "근거가 충분한 점수" 로 보입니다.
    github_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 백필을 **마지막으로 돌린** 시각. NULL 이면 한 번도 안 돌렸다는 뜻입니다.
    github_backfilled_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    # ⚠️ **이 시각 이후는 GitHub 에 물어봤다**는 뜻입니다.
    #
    # 이 한 칸이 "기여도가 빈 것" 과 "활동이 없던 것" 을 가릅니다.
    # 없으면 화면은 둘을 구분해서 말할 수 없고, 연결 전에 제일 많이
    # 일한 사람이 제일 적게 일한 것으로 보입니다 — 오류는 어디에도
    # 안 납니다.
    github_backfilled_to: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    created_at: Mapped[datetime] = _now()

    # 유니크 **제약**이 아니라 유니크 **인덱스**입니다. SQLite 는
    # `ALTER TABLE ... ADD CONSTRAINT` 를 지원하지 않아 마이그레이션이
    # 인덱스로만 이걸 만들 수 있습니다. 모델도 같은 것으로 맞춰 둡니다 —
    # 다르게 두면 테스트가 만드는 스키마와 배포되는 스키마가 갈라지고,
    # 그건 이 프로젝트가 반복해서 당한 실패 방식입니다.
    __table_args__ = (
        Index("uq_projects_github_repo_key", "github_repo_key", unique=True),
    )

    @validates("github_repo")
    def _keep_the_lookup_key_in_step(self, _field: str, value: str | None) -> str | None:
        """대조용 표기를 **여기서** 맞춥니다.

        저장소를 바꾸는 자리마다 손으로 둘을 같이 쓰게 하면, 언젠가 한쪽을
        빠뜨리고 그 순간부터 웹훅이 조용히 사라집니다. 이 프로젝트에서
        반복해서 나온 실패 방식이라 아예 못 어긋나게 묶어 둡니다.
        """
        cleaned = value.strip() if value else None
        self.github_repo_key = repo_key(cleaned)
        return cleaned or None


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


class GithubUnlinkedDelivery(Base):
    """서명은 맞는데 **어느 프로젝트에도 안 붙은** 배달의 흔적.

    ⚠️ 이 표가 없으면 저장소 이름 오타는 **증거를 남기지 않습니다.**
    웹훅 처리기는 202 를 돌려주고 본문을 버리며, 사람이 볼 수 있는 곳에는
    아무것도 남지 않습니다. 팀은 PR 을 계속 병합하는데 기여도만 비고,
    무엇을 고쳐야 하는지 알 방법이 없습니다.

    **무엇을 남기고 무엇을 안 남기는가** — 저장소 이름과 시각·횟수만
    남깁니다. 본문·작성자·PR 제목은 남기지 않습니다. 어느 프로젝트에도
    안 붙은 배달은 **이 시스템의 자료가 아니고**, 우리는 그걸 보관할
    근거가 없습니다. 진단에 필요한 것은 "이 이름으로 몇 번 왔다" 뿐입니다.

    저장소당 한 행입니다. 계속 쌓이지 않습니다.
    """

    __tablename__ = "github_unlinked_deliveries"

    id: Mapped[int] = _pk()
    #: 대조용 소문자 표기. 이걸로 중복을 막습니다.
    repo_key: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    #: GitHub 이 보낸 정식 표기. 화면이 "이걸로 고치세요" 라고 말할 때 씁니다.
    repo: Mapped[str] = mapped_column(String(255), nullable=False)
    delivery_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    first_seen_at: Mapped[datetime] = _now()
    last_seen_at: Mapped[datetime] = _now()


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


class MeetingStatus(StrEnum):
    """회의가 가질 수 있는 상태 — **여기가 유일한 출처다.**

    ⭐ 화면(`lib/home/next.ts`)은 이 값마다 한국어 라벨과 "다음에 할 일" 을
    가지고 있어야 한다. 어긋나면 홈 화면이 영어 식별자를 그대로 찍거나
    (`describeMeetingStatus` 는 모르는 값을 그대로 돌려준다) 없는 상태를
    설명하는 죽은 가지를 갖게 된다. `Category` 에 같은 그물을 이미 쳐 뒀고,
    여기에도 친다 (`test_repo_integrity.py`).

    ⚠️ **`CONFIRMED` 는 오랫동안 아무도 쓰지 않았다** (결함 84). 화면에는
    "검토 완료" 라벨과 "검토를 마쳤습니다" 가지가 있었지만, 서버가 그 값을
    한 번도 넣지 않아 사람이 후보를 전부 검토해도 회의는 `NEEDS_REVIEW` 로
    남았습니다. 홈 화면은 그 회의를 이렇게 설명했습니다 —

        검토 필요 — 검토할 업무 후보가 없습니다 — 회의에서 업무가 나오지 않았습니다

    업무는 나왔고, 사람이 셋 다 검토한 뒤였습니다.
    """

    #: 녹음 중이거나 아직 전원이 끝나지 않음
    PENDING = "pending"
    #: 전원 종료 → 처리 대기. 이 전이가 중복 큐잉을 막는 자물쇠다
    QUEUED = "queued"
    PROCESSING = "processing"
    #: 후보가 나왔고 사람의 결정을 기다린다
    NEEDS_REVIEW = "needs_review"
    #: 사람이 후보를 **전부** 결정했다
    CONFIRMED = "confirmed"
    FAILED = "failed"


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    title: Mapped[str | None] = mapped_column(String(200))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    duration_sec: Mapped[int | None] = mapped_column(Integer)
    # multitrack | single  — docs/04 의 모드 A / 모드 B
    capture_mode: Mapped[str] = mapped_column(String(20), nullable=False, default="multitrack")
    #: 값의 뜻은 `MeetingStatus` 참조. 그쪽이 유일한 출처다.
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=MeetingStatus.PENDING.value
    )
    # LLM이 만든 회의 요약. 근거는 utterances 에 남아 있고 여기엔 본문만 둔다.
    #
    # 이게 없던 동안 파이프라인은 요약을 만들어 Celery 페이로드에 실어 보낸 뒤
    # **저장하지 않고 버렸다.** 회의록은 이 시스템의 대표 산출물인데 어디에도
    # 남지 않았다. 재생성하려면 회의를 통째로 다시 처리해야 하고, 그건 이미
    # 사람이 검토한 회의에서는 거부된다 — 즉 영구 손실이었다.
    summary: Mapped[str | None] = mapped_column(Text)
    # 다음 회의에서 다룰 안건. LLM 이 만들고 검증까지 통과한 산출물인데
    # **`_serialize` 에 없어서** 파이프라인 밖으로 나온 적이 없었다.
    #
    # 근거 발화가 없는 값이라 `MeetingEvent` 가 아니라 회의에 붙인다 —
    # "다음에 뭘 하기로 했더라" 는 회의 하나의 성질이다.
    next_agenda: Mapped[list | None] = mapped_column(JSONType)
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
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 트랙 간 시간 정렬 보정값
    offset_ms: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sample_rate: Mapped[int | None] = mapped_column(Integer)

    # ── 클라이언트가 보고한 녹음 품질 (docs/04 §2.6) ────────────────
    # 폰이 잠기거나 앱이 전환되면 트랙에 구멍이 뚫린다. 그걸 모르고 쓰면
    # 말을 안 한 사람으로 잡히므로, 클라이언트 판정을 그대로 받아 저장한다.
    #
    # recording | completed | unusable | aborted
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="recording")
    # 0~1. 오디오가 실제로 존재한 시간 비율.
    coverage: Mapped[float | None] = mapped_column(Numeric(4, 3))
    total_gap_ms: Mapped[int | None] = mapped_column(Integer)
    longest_gap_ms: Mapped[int | None] = mapped_column(Integer)
    # 공백 목록 (원인별). buildTimeline 의 gaps 를 그대로 담는다.
    gaps: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    # 브라우저가 AGC·잡음억제를 못 끈 경우 낮아진다 (docs/04 §2.7)
    capture_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3))
    capture_warnings: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
    # 녹음 중단 사유: user | consent_revoked | backpressure | error
    stop_reason: Mapped[str | None] = mapped_column(String(30))

    __table_args__ = (UniqueConstraint("meeting_id", "user_id", name="uq_track_user"),)


class TrackChunk(Base):
    """업로드된 청크 하나의 기록.

    파일 자체는 `audio/chunk_store.py` 가 디스크에 둔다. 여기 남기는 건
    **클라이언트가 찍은 도착 시각**이다. 그게 있어야 공백을 절대 시각으로
    복원할 수 있다 (docs/04 §2.6). 파일시스템에는 그 정보가 없다.
    """

    __tablename__ = "track_chunks"

    id: Mapped[int] = _pk()
    track_id: Mapped[int] = mapped_column(ForeignKey("meeting_tracks.id"), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    # 동기화된 서버 시각 기준 epoch ms. 클라이언트가 계산해서 보낸다.
    client_at_ms: Mapped[int] = mapped_column(BigInteger, nullable=False)
    received_at: Mapped[datetime] = _now()

    __table_args__ = (
        UniqueConstraint("track_id", "seq", name="uq_track_chunk"),
        Index("ix_chunk_track_seq", "track_id", "seq"),
    )


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
    # 값과 뜻은 `db/vocab.py` 한 곳에만 있습니다 — 여기 손으로 적어 두었을
    # 때 `video/speaker.py` 의 enum 과 이미 갈라져 있었습니다(셋이 더 많았고,
    # 그 셋은 이 제약이 거절했습니다).
    speaker_source: Mapped[str] = mapped_column(
        String(20), nullable=False, default=str(SpeakerSource.DIARIZATION)
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
            # ⚠️ 목록을 손으로 적지 않습니다. `vocab.STORED` 가 원본입니다.
            "speaker_source IN ("
            + ",".join(f"'{v}'" for v in vocab.stored_values())
            + ")",
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
    # LLM 이 "이 결정을 뒤집었다" 고 적어 보낸 **원문**.
    #
    # ⚠️ 이 컬럼이 없던 동안 `supersedes` 는 Celery 페이로드까지 실려 오고
    # 저장 단계에서 버려졌습니다 — `supersedes_id` 는 **영원히 NULL** 이었고,
    # 결정 번복 추적은 표만 있고 데이터가 없는 기능이었습니다.
    #
    # id 를 못 찾았을 때 힌트를 지우지 않고 남기는 이유: LLM 에게 넘긴
    # `prior_decisions` 는 우리가 준 원문 목록이라 대개 정확히 일치하지만,
    # 바꿔 쓰면 못 찾습니다. 그때 **추측해서 아무 결정이나 뒤집힌 것으로
    # 표시하면** 회의 기록이 틀려집니다. 사람이 보고 고칠 수 있게 남깁니다.
    supersedes_hint: Mapped[str | None] = mapped_column(Text)
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
    # 확신도를 **깎은 이유**. validation 이 후보마다 만든다.
    #
    # 확신도 0.34 만 보여주면 사람은 무엇을 확인해야 할지 모른다. "담당자
    # 미확정 — 이름이 두 명과 일치" 와 "마감일이 회의일보다 이전" 은 손봐야
    # 할 곳이 전혀 다르다. 검토 화면은 사람이 개입하는 유일한 지점이라,
    # 여기서 이유를 잃으면 사람은 근거 없이 승인하게 된다.
    warnings: Mapped[list] = mapped_column(JSONType, nullable=False, default=list)
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
        #
        # ⚠️ `user_id` 가 **들어가 있어야 합니다.** 없으면 하나의 근거에서
        # 여러 사람의 이벤트가 나올 수 없습니다 — 회의 하나에 참석자가
        # 셋이면 `meeting_attended` 가 **한 명만 기록되고 나머지 둘은
        # IntegrityError 로 조용히 사라집니다.**
        #
        # 웹훅 중복 방어는 그대로입니다. GitHub 이벤트는 행위자가 하나라
        # `user_id` 가 붙어도 같은 행으로 막힙니다.
        UniqueConstraint(
            "source_kind",
            "source_id",
            "event_type",
            "user_id",
            name="uq_contribution_source",
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
            # ⚠️ 목록을 손으로 적지 않습니다 — `vocab.CONSENT_STORED` 가 원본.
            "consent_type IN ("
            + ",".join(f"'{v}'" for v in vocab.consent_values())
            + ")",
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
    # ⚠️ **왜 지웠는가.** `deleted_at` 만으로는 구분할 수 없다.
    #
    #   retention_expired  보존기간 30일이 지나 자동으로 지웠다
    #   user_request       본인이 삭제를 요청했다 (docs/07 P6)
    #
    # 이 구분이 필요한 이유는 기여도 화면에 있다. 원본이 없어진 트랙은
    # 재처리해도 발화가 안 나오는데, 그 상태를 "말을 안 한 사람" 으로
    # 처리하면 측정이 아니라 오답이다 (docs/04 §2.6). 그런데 **왜 없어졌는지에
    # 따라 사람이 할 일이 다르다** — 만료는 정상이고, 삭제 요청은 권리
    # 행사이며, 어느 쪽도 "다음엔 화면을 켜 두자" 로 고칠 수 없다.
    # 녹음이 끊긴 것과는 다른 문구가 나가야 한다.
    deleted_reason: Mapped[str | None] = mapped_column(String(30))
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
    """회의록 · 주간 · 최종 (docs/08 §2).

    ⚠️ **다시 만들면 갈아끼워야지 쌓이면 안 됩니다.** 이 저장소는 그 결함을
    이미 한 번 당했습니다 — 미해결 사안이 재처리마다 한 벌씩 쌓였습니다.
    보고서에서 그러면 "최종 보고서" 가 여러 벌 생기고 어느 것이 진짜인지
    아무도 모릅니다. 그래서 서비스에만 맡기지 않고 **유일 제약으로 데이터
    베이스가 지킵니다** — `scope_key` 가 그것을 위한 열입니다.
    """

    __tablename__ = "reports"

    id: Mapped[int] = _pk()
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id"), nullable=False)
    # 값과 뜻은 `db/vocab.py` 한 곳에만 있습니다 — 아래 CHECK 제약이 거기서
    # 끌어다 씁니다. 예전에는 여기 주석 한 줄(`# weekly | final | ...`)이
    # 전부였고, 주석은 아무것도 막지 않습니다.
    report_type: Mapped[str] = mapped_column(String(20), nullable=False)
    #: 회의록일 때만 채워집니다. 회의가 지워지면 그 회의록도 같이 지워져야
    #: 하므로 내용(JSON)에 id 를 적어 두는 것으로는 부족합니다.
    meeting_id: Mapped[int | None] = mapped_column(ForeignKey("meetings.id"))
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: **무엇 하나에 매여 있는지**를 한 문자열로 적은 것. 유일 제약이 이걸
    #: 씁니다.
    #:
    #: ⚠️ 널을 섞은 유일 제약은 못 씁니다 — 널은 서로 다른 값으로 쳐서
    #: `(project, 'final', NULL, NULL)` 이 몇 번이고 들어갑니다. 그래서
    #: 널이 될 수 있는 열들 대신 **널이 아닌 열 하나**로 모읍니다.
    #:
    #: ⚠️ 값을 손으로 만들지 마십시오. `reports.scope_key()` 하나가
    #: 만듭니다 — 두 곳에서 만들면 한쪽만 고쳐지고, 그 순간 같은 보고서가
    #: 서로 다른 열쇠를 갖게 되어 유일 제약이 **아무것도 안 막습니다.**
    scope_key: Mapped[str] = mapped_column(String(64), nullable=False)
    content: Mapped[dict] = mapped_column(JSONType, nullable=False)
    generated_at: Mapped[datetime] = _now()

    __table_args__ = (
        CheckConstraint(
            # ⚠️ 목록을 손으로 적지 않습니다 — `vocab.ReportType` 이 원본.
            "report_type IN ("
            + ",".join(f"'{v}'" for v in vocab.report_values())
            + ")",
            name="ck_report_type",
        ),
        UniqueConstraint(
            "project_id", "report_type", "scope_key", name="uq_report_scope"
        ),
    )
