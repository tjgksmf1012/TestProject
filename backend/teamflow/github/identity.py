"""GitHub 계정 이름을 사람에게 잇는다 (결함 112).

## 이 칸이 왜 비어 있었나

`Member.github_login` 은 **기여도의 GitHub 다리 전체가 서 있는 칸**입니다.

    웹훅 actor_login  ──(이 칸)──▶  user_id  ──▶  기여 이벤트

읽는 곳은 넷입니다 — 이벤트 배분(`github_ingest_service.member_logins`),
백필, 업무↔PR 잇기, 연결 진단. 그런데 **이 칸에 값을 넣는 코드가
저장소에 0곳**이었습니다. 시드와 테스트만 직접 써 넣고 있었습니다.

즉 실제로 배포하면 이 칸은 **영원히 NULL** 이고, 그러면

* `member_logins` 가 빈 표가 되어 **아무의 PR 도 주인을 못 찾습니다**
* 기여도 화면은 그 사람을 &#34;활동 없음&#34; 으로 그립니다
* 오류는 안 납니다

연결 진단은 이미 &#34;GitHub 계정을 연결하지 않은 팀원이 있습니다&#34; 라고
경고하고 있었습니다. **그런데 연결할 자리가 없었습니다.** 사람에게
할 일을 알려 주고 그 일을 할 방법을 안 주는 것은, 결함 105 에서 고친
것(할 수 없는 일을 안 했다고 깎기)의 거울입니다.

## 왜 정규화가 필요한가

GitHub 로그인은 대소문자를 **보존하지만 비교는 무시**합니다.
`MinSu` 로 적어 두고 웹훅이 `minsu` 로 오면 못 찾습니다 —
`member_logins` 가 키를 소문자로 만드는 것도 같은 이유입니다.
"""

from __future__ import annotations

import re

#: GitHub 사용자명 규칙. 영숫자와 하이픈, 39자 이하, 하이픈으로 시작/끝
#: 불가, 하이픈 연속 불가. (GitHub 가입 화면이 강제하는 규칙과 같다.)
_LOGIN = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$")

MAX_LENGTH = 39


def clean_github_login(raw: str | None) -> str | None:
    """적어 넣은 GitHub 아이디를 저장할 모양으로.

    빈 값(또는 공백뿐)은 **연결 해제**로 보고 `None` 을 돌려줍니다 —
    잘못 적었을 때 지울 방법이 있어야 합니다.

    Raises:
        ValueError: GitHub 이 만들 수 없는 이름일 때. 사람이 읽을 문장을
            담습니다 — 그대로 화면에 나갑니다.
    """
    if raw is None:
        return None
    value = raw.strip()
    if value == "":
        return None

    # 주소를 통째로 붙여 넣는 것은 흔한 일이라 받아 준다.
    # `https://github.com/minsu` · `github.com/minsu` · `@minsu`
    value = re.sub(r"^(?:https?://)?(?:www\.)?github\.com/", "", value)
    value = value.removeprefix("@").rstrip("/")

    if len(value) > MAX_LENGTH:
        raise ValueError(f"GitHub 아이디는 {MAX_LENGTH}자를 넘을 수 없습니다")
    if not _LOGIN.match(value):
        raise ValueError(
            "GitHub 아이디는 영문·숫자와 하이픈만 쓸 수 있고, "
            "하이픈으로 시작하거나 끝날 수 없습니다"
        )
    return value


def same_login(a: str | None, b: str | None) -> bool:
    """두 아이디가 GitHub 기준으로 같은 사람인가.

    ⚠️ 대소문자를 무시합니다. 이걸 `==` 로 비교하면 `MinSu` 와 `minsu` 가
    **다른 사람**이 되어, 한 팀에서 둘 다 등록될 수 있습니다.
    """
    if a is None or b is None:
        return False
    return a.lower() == b.lower()
