"""GitHub 사건을 **사람 말로** 옮기는 한 곳 (결함 347).

## 왜 따로 있는가

같은 사건을 두 화면이 보여 주는데, 각자 자기 방식으로 옮기고 있었습니다.

    활동 기록   PR 병합 · 박지원          (어휘표 + 팀원 이름)
    찾기        pull_request.merged · jiwon-db   (원본 그대로)

`vocab.py` 는 `GITHUB_EVENT_LABEL` 옆에 이렇게 적어 뒀습니다 —
「종류 → 사람 말. **서버가 라벨을 만들어 내려보냅니다** — 화면에 두 번째
표를 만들지 마십시오」. 그런데 두 번째 표가 아니라 **아예 안 옮기는 곳**이
있었고, 거기로 내부 enum 이 그대로 나갔습니다 (결함 78·86 이 못 박은 것).

## ⚠️ 행위자에는 갈래가 **셋**입니다

`github_feed_service` 의 주석은 둘만 적어 뒀습니다 — 팀원이면 이름,
아니면 로그인 그대로(그 편이 「안 이어졌다」는 사실을 같이 보여 줍니다).

셋째는 **로그인조차 없는 경우**입니다. GitHub 은 계정이 지워지면
`"user": null` 을 보내고, `client.py` 가 `.get("login", "")` 로 빈 글자를
만듭니다. 그러면 화면에 **아무것도 안 그려져** 칸이 통째로 사라집니다 —
빈 칸은 「없음」이 아니라 「고장」으로 읽힙니다.

지어내지 않고 **모른다고 적습니다** (결함 297 의 규칙).
"""

from __future__ import annotations

from teamflow.db import vocab

#: 로그인도 이름도 없을 때. 빈 글자를 내보내면 화면의 칸이 사라집니다.
UNKNOWN_ACTOR = "(누구인지 기록되지 않았습니다)"


def event_label(event_type: str) -> str:
    """`pull_request.merged` → 「PR 병합」.

    ⚠️ **모르는 값은 그대로 돌려줍니다.** 지어내면 틀린 말이 되고, 그대로
    두면 「어휘가 늘었는데 표가 안 늘었다」가 화면에서 보입니다.
    """
    try:
        kind = vocab.GithubEventKind(event_type)
    except ValueError:
        return event_type
    return vocab.GITHUB_EVENT_LABEL.get(kind, event_type)


def actor_name(member_name: str | None, actor_login: str | None) -> str:
    """이 사건을 누가 했는가 — 팀원 이름 → GitHub 로그인 → 모름."""
    name = (member_name or "").strip()
    if name:
        return name
    login = (actor_login or "").strip()
    return login or UNKNOWN_ACTOR
