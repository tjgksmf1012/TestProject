"""서버가 보내는 칸 중 **화면이 한 번도 안 읽는 것** (결함 414·417 회차의 자).

## 왜 이 자인가

결함 414 는 「화면이 `/api/chat/reactions` 를 **부르기는 하는데** 응답의
집합과 순서를 안 쓴다」였고, 417 은 「`Notice.channel_id` 칸이 있는데
**채우는 곳도 쓰는 곳도 0곳**」이었습니다. 둘 다 **라우트 census 는
초록**입니다(결함 306 의 자는 「부르는가」만 봅니다). 안 보고 있던 것은
**응답의 칸**이었습니다.

그래서 축을 하나 더 둡니다: 응답 모델의 칸마다 **읽는 화면이 있는가**.

## ⚠️ 이 자가 못 보는 것

- **뿌리를 안 가릅니다.** 한쪽 뿌리에서만 읽어도 초록입니다 — SPA 에
  없는 화면이 여섯이라(`docs/22` §R8) 뿌리별로 재면 거짓 양성이
  쏟아집니다. 뿌리 갈림은 결함 321 의 자가 따로 봅니다
- **`{...row}` 로 통째로 넘기는 자리**를 못 봅니다
- **값으로 쓰는 이름**을 못 봅니다 — `'all_confirmed'` 처럼 문자열
  리터럴로 쓰는 것은 `.all_confirmed` 가 아니라 안 걸립니다
- 이름이 흔한 칸은 남의 코드에 걸려 **거짓 초록**이 납니다. 그래서
  「몇 곳인가」는 안 세고 **「0곳인가」만** 봅니다
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MAIN = REPO_ROOT / "backend" / "teamflow" / "api" / "main.py"

#: 화면이 안 읽는 칸과 **왜 괜찮은가**.
#:
#: ⚠️ 결함 306 이 라우트 예외 표에서 적어 둔 그대로입니다 — 「예외를 둘
#: 때는 **왜 예외인가**를 적고, 예외가 낡는 것도 같이 재십시오.」 그리고
#: 그 표에서 **사유 자체가 거짓**이었던 적이 있습니다(결함 417 회차의
#: `/mentions`) — 여기 적을 때는 그 갈래를 **열어 보고** 적으십시오.
UNREAD_FIELDS: dict[str, str] = {
    # ── 재서 확인한 것 ──────────────────────────────────────
    "CategoryOut.raw": (
        "정규화 **전** 값입니다. 화면이 그리면 불변식 ②(단일 점수 금지)를 "
        "어기고, 백분율로 읽으면 2990% 같은 값이 나옵니다"
    ),
    "ConsentOut.all_confirmed": (
        "화면이 `roster` 로 같은 답을 셉니다(`consentStateFrom`). 재 보니 "
        "roster 는 **프로젝트 구성원 전원**(21명)이라 서버의 "
        "`granted == total` 과 같은 답입니다 — 갈라질 수 있는 자리이지 "
        "틀린 것은 아닙니다. ⚠️ `consent_roster` 가 전원을 안 주기 시작하면 "
        "그때 갈라집니다"
    ),
    "FinishMeetingOut.aborted_track_ids": (
        "`message` 가 「N개 트랙을 강제 종료했습니다」로 **개수**를 말합니다. "
        "번호는 사람에게 보여 줄 것이 아닙니다(결함 293)"
    ),
    "JoinOut.already_member": (
        "**기록된 결정** — `demo/home.tsx`: 「이미 구성원이어도 성공이고, "
        "그때는 그냥 그 프로젝트로 갑니다」"
    ),
    "MeetingProgressOut.stage": (
        "서버가 `message` 로 **한 줄을 지어 보냅니다** — 「화면에 그대로 쓸 "
        "한 줄. 서버와 화면이 같은 문장을 씁니다」(모델 주석)"
    ),
    "MeetingProgressOut.percent": "위와 같음",
    "TrackOut.stored_seqs": (
        "재개는 이 값이 아니라 `client.resumeFrom` 이 다른 경로로 합니다. "
        "그 함수가 「새로고침하면 seq 가 0부터 다시 시작하는데 서버가 가진 "
        "0..40 을 건너뛰면 **새로 녹음한 소리 41개를 버립니다**」라며 "
        "**같은 세션에서만** 건너뛰도록 못 박고 있습니다"
    ),
    "UtteranceOut.speaker_id": (
        "화면은 번호가 아니라 **이름**을 그립니다(결함 293·297)"
    ),
    "ChannelOut.position": (
        "CHANNEL-005 채널 순서 — 서버만 있고 화면에 아직 안 이었습니다. "
        "라우트 예외 표(`test_repo_integrity.py`)에도 같은 줄이 있습니다"
    ),
    "MeOut.email": "화면이 이메일을 어디에도 안 그립니다",
    "TaskGithubOut.event_id": (
        "서버가 `github/presenting.py` 로 사람이 읽을 라벨을 만들어 "
        "내려보냅니다(결함 347) — 번호는 화면이 쓸 일이 없습니다"
    ),
    "TaskGithubOut.actor_login": (
        "같음 — 화면에는 로그인이 아니라 **이름**이 갑니다(결함 293·347)"
    ),
    "CategoryOut.evidence_ids": (
        "화면은 범주마다 「N건」만 그립니다. 이 제품에서 「N건」이 원문으로 "
        "이어지는 자리는 **0곳**이라 저 혼자 예외가 아닙니다(관습). "
        "⚠️ 이어 줄지는 **안 쟀습니다** — 붙이려면 결함 337 의 "
        "`EvidenceChip`(「칩은 언제나 원문으로 이어져야 합니다」)을 보십시오"
    ),
    # ── **안 쟀습니다** — 다음 사람이 열어 보고 사유를 채우십시오 ──
    "FinalsOut.run_id": (
        "계산 회차 번호입니다 — 사람에게 번호를 보여 주지 않습니다(결함 293). "
        "화면은 값과 사유를 그립니다"
    ),
    "GithubHealthOut.verified_at": (
        "서버가 `headline`·`detail`·`coverage` **문장**을 지어 보내고 화면은 "
        "그것을 그립니다(결함 300·347 의 방법)"
    ),
    "GithubHealthOut.backfilled_at": "위와 같음 — `coverage` 한 줄이 범위를 말합니다",
    "GithubHealthOut.backfilled_to": "위와 같음",
    "MeetingOut.consent_url": (
        "`f\"/api/meetings/{id}/consent\"` — 화면이 `meeting_id` 로 **같은 주소를 "
        "직접** 만듭니다. 이 칸은 그 사본입니다"
    ),
    "ProjectOut.member_ids": (
        "만든 직후라 언제나 **만든 사람 하나**입니다(`member_ids=[user.id]`). "
        "팀원 목록은 `/members` 로 따로 받습니다. ⚠️ 요청 **본문**의 "
        "`member_ids` 를 믿던 것이 결함이었고(main.py 755줄) 이 칸은 그 모양의 "
        "잔재입니다"
    ),
    "TaskOriginOut.candidate_id": (
        "화면은 회의 이름과 **근거 발화**로 갑니다 — 후보 번호는 안 씁니다. "
        "⚠️ 이 줄을 따라가다 결함 418 이 나왔습니다: 칸반 카드가 근거 발화를 "
        "세어 놓고 볼 문이 없었습니다"
    ),
}


def _blank_py(src: str) -> str:
    out = list(src)
    i = 0
    while i < len(src):
        three = src[i : i + 3]
        if three in ('"""', "'''"):
            end = src.find(three, i + 3)
            end = len(src) if end == -1 else end + 3
            for j in range(i, end):
                if out[j] != "\n":
                    out[j] = " "
            i = end
            continue
        if src[i] == "#":
            end = src.find("\n", i)
            end = len(src) if end == -1 else end
            for j in range(i, end):
                out[j] = " "
            i = end
            continue
        i += 1
    return "".join(out)


def _blank_ts(src: str) -> str:
    out = list(src)
    i = 0
    while i < len(src):
        if src.startswith("/*", i):
            end = src.find("*/", i + 2)
            end = len(src) if end == -1 else end + 2
            for j in range(i, end):
                if out[j] != "\n":
                    out[j] = " "
            i = end
            continue
        if src.startswith("//", i):
            end = src.find("\n", i)
            end = len(src) if end == -1 else end
            for j in range(i, end):
                out[j] = " "
            i = end
            continue
        i += 1
    return "".join(out)


def _screen_code() -> str:
    parts: list[str] = []
    for root in ("frontend/src", "webapp/src"):
        base = REPO_ROOT / root
        for path in sorted(base.rglob("*.ts")) + sorted(base.rglob("*.tsx")):
            if path.name.endswith((".test.ts", ".test.tsx")):
                continue
            parts.append(_blank_ts(path.read_text(encoding="utf-8")))
    return "\n".join(parts)


def _orphans() -> set[str]:
    code = _blank_py(MAIN.read_text(encoding="utf-8"))
    screens = _screen_code()
    found: set[str] = set()
    for match in re.finditer(
        r"^class (\w+Out)\(BaseModel\):\n((?:[ \t]+.*\n|\n)*)", code, re.MULTILINE
    ):
        model, body = match.group(1), match.group(2)
        for field in re.findall(r"^\s{4}(\w+)\s*:", body, re.MULTILINE):
            reads = len(re.findall(rf"\.{field}\b", screens)) + len(
                re.findall(rf"\[['\"]{field}['\"]\]", screens)
            )
            if reads == 0:
                found.add(f"{model}.{field}")
    return found


def test_no_new_response_field_goes_unread() -> None:
    """⭐ 화면이 안 읽는 칸이 **늘지 않는다**.

    새 칸을 더하고 화면에 안 이으면 여기서 잡힙니다 — 결함 417 이 그
    모양이었습니다(칸은 있는데 채우는 곳도 쓰는 곳도 0곳).
    """
    new = sorted(_orphans() - set(UNREAD_FIELDS))
    assert not new, (
        "서버가 보내는데 **화면이 한 번도 안 읽는** 칸이 늘었습니다. "
        "이을 자리가 있으면 잇고, 없으면 `UNREAD_FIELDS` 에 **왜 괜찮은지**를 "
        f"적으십시오: {new}"
    )


def test_the_exception_table_is_not_stale() -> None:
    """⭐ 예외 표에 **낡은 줄**이 없다.

    이었으면 그 줄은 지워야 합니다 — 남아 있으면 다음 사람이 「여기는
    봐준 자리」로 읽습니다(결함 306).
    """
    stale = sorted(set(UNREAD_FIELDS) - _orphans())
    assert not stale, (
        f"이제 화면이 읽는데 예외 표에 남아 있습니다 — 줄을 지우십시오: {stale}"
    )


def test_the_ruler_actually_sees_something() -> None:
    """⚠️ 자가 **읽는 칸도 보고 있는가** — 전부 0곳이면 자가 고장입니다."""
    code = _blank_py(MAIN.read_text(encoding="utf-8"))
    models = re.findall(r"^class (\w+Out)\(BaseModel\):", code, re.MULTILINE)
    assert len(models) >= 30, f"응답 모델을 {len(models)}개밖에 못 찾았습니다"
    assert len(_orphans()) < len(models), "칸이 전부 0곳입니다 — 화면을 안 읽고 있습니다"
