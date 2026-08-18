"""GitHub 활동 조회 (요구사항 정의서 §17 GITHUB-003~005 · 008).

## 무엇을 고치는 것인가

`github_events` 는 웹훅·백필로 **쌓이기만 하고 볼 화면이 0곳**이었습니다.
이 제품의 대표 주장(회의 → 업무 → GitHub → 기여 기록)의 마지막 칸이
화면에서 끊겨 있던 것입니다 — 대표 실패 ① 의 표 버전.

## ⚠️ `payload` 는 여기서 **한 칸도 안 나갑니다**

저장된 웹훅 본문에는 저장소 설정과 사람 이메일까지 들어 있습니다.
검색(`search_service.search_github`)이 이미 정한 규칙 그대로입니다 —
제목·참조·행위자·시각만 내보냅니다.

## ⚠️ 사람별 집계를 만들지 않습니다

GITHUB-008(활동 통계)을 여기서 사람별로 세면 그 순간 **커밋 수 순위표**가
됩니다 — 이 저장소의 첫째 불변식 위반이고, 게다가 사람별 집계는 기여도
화면이 근거와 함께 **이미** 담당합니다. 여기 또 만들면 같은 값이 두 벌이
됩니다. 이 모듈의 집계는 **프로젝트 단위 종류별 건수**뿐입니다.

## ⚠️ 커밋 목록이 없는 것은 빠뜨린 게 아닙니다

커밋은 쪼개기가 너무 쉬워서 지표로 쓸 수 없습니다(`docs/05` §2.1).
웹훅부터 push 를 받지 않습니다 — `vocab.GithubEventKind` 머리말 참조.
화면이 이 이유를 사람에게 말합니다.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from teamflow.clock import as_utc
from teamflow.db import models as m
from teamflow.db import vocab

#: 한 번에 내려보내는 최대 줄 수. 화면은 최근 것을 보는 곳이고,
#: 전체 검색은 검색 화면(§20)이 담당합니다.
MAX_ITEMS = 200


@dataclass(frozen=True, slots=True)
class FeedItem:
    id: int
    kind: str
    label: str
    who: str
    repo: str
    ref: str | None
    occurred_at: str


@dataclass(frozen=True, slots=True)
class KindCount:
    kind: str
    label: str
    count: int


def recent(session: Session, project_id: int, limit: int = MAX_ITEMS) -> list[FeedItem]:
    """이 프로젝트의 GitHub 사건. 최근 것부터.

    ⚠️ `who` 는 팀원과 이어졌으면 **팀원 이름**, 아니면 GitHub 로그인
    그대로입니다. 로그인을 숨기면 "팀원 계정이 안 이어졌다" 는 사실이
    같이 숨습니다 — 연결 진단(`github/connection.py`)이 잡는 바로 그
    문제를 화면에서도 볼 수 있어야 합니다.
    """
    rows = session.execute(
        select(m.GithubEvent, m.User.name)
        .outerjoin(m.User, m.User.id == m.GithubEvent.actor_user_id)
        .where(m.GithubEvent.project_id == project_id)
        .order_by(m.GithubEvent.occurred_at.desc(), m.GithubEvent.id.desc())
        .limit(min(limit, MAX_ITEMS))
    ).all()

    items: list[FeedItem] = []
    for event, user_name in rows:
        items.append(
            FeedItem(
                id=event.id,
                kind=event.event_type,
                label=_label(event.event_type),
                who=user_name or event.actor_login,
                repo=event.repo,
                ref=event.ref,
                occurred_at=as_utc(event.occurred_at).isoformat(),
            )
        )
    return items


def counts(session: Session, project_id: int) -> list[KindCount]:
    """종류별 건수. **어휘 선언 순서**로 돌려줍니다.

    ⚠️ 건수 순으로 주지 않습니다 — 정렬해서 주면 부르는 쪽은 그게 뜻있는
    순서라고 믿고 그대로 그리는데, 건수 순 목록이 곧 순위표입니다
    (`meeting/speaking.py` 가 같은 이유로 같은 결정을 했습니다).

    ⚠️ 0건인 종류도 **빼지 않고** 0으로 내려보냅니다. 빼면 화면은 그
    종류가 존재하는지조차 모르게 되고, "이슈 닫힘 0건" 과 "이슈는 안
    세어짐" 은 다른 말입니다 — 측정 불가 ≠ 0 의 반대 방향입니다.
    """
    rows = dict(
        session.execute(
            select(m.GithubEvent.event_type, func.count(m.GithubEvent.id))
            .where(m.GithubEvent.project_id == project_id)
            .group_by(m.GithubEvent.event_type)
        ).all()
    )
    return [
        KindCount(kind=str(kind), label=_label(str(kind)), count=rows.get(str(kind), 0))
        for kind in vocab.GithubEventKind
    ]


def _label(kind: str) -> str:
    """종류 → 사람 말. 모르는 종류는 **값 그대로** — 지어내지 않습니다."""
    try:
        return vocab.GITHUB_EVENT_LABEL[vocab.GithubEventKind(kind)]
    except ValueError:
        return kind
