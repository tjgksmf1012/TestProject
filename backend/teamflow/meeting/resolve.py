"""담당자·마감일 해석.

LLM은 전사에 나온 표현을 **그대로** 넘긴다 ("민수님", "금요일까지").
실제 user_id 와 날짜로 바꾸는 것은 서버의 일이다.

LLM에게 날짜 계산을 시키지 않는 이유:
    1. 회의일을 모르면 "금요일"을 해석할 수 없는데, 프롬프트에 넣어도 자주 틀린다
    2. 계산은 결정적(deterministic)이어야 한다. 같은 입력에 같은 날짜가 나와야 한다
    3. 실패했을 때 이유를 설명할 수 있어야 한다

두 해석기 모두 **확신이 없으면 None을 반환한다.** 억지로 맞히지 않는다.
잘못 배정된 업무는 잘못된 기여도로 이어지고, 그건 팀 갈등이 된다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, timedelta
from difflib import SequenceMatcher

# ══════════════════════════════════════════════════════════════
# 담당자 해석
# ══════════════════════════════════════════════════════════════

# 두 글자 성씨. 이름 부분을 잘라낼 때 필요하다.
COMPOUND_SURNAMES = frozenset(
    {
        "남궁", "황보", "제갈", "사공", "선우", "서문", "독고",
        "동방", "망절", "무본", "부여", "소봉", "장곡", "강전",
    }
)

# 존칭·조사. 전사에서 이름 뒤에 붙어 나온다.
_HONORIFIC_SUFFIX = re.compile(
    r"(님|씨|군|양|선배|후배|형|누나|언니|오빠|쌤|선생님)?"
    r"(께서|에게|한테|보고|이랑|랑|하고|와|과|가|이|은|는|을|를|도|만|야|아)?$"
)

# 담당자가 아니라 역할·직책을 가리키는 표현. 이름으로 해석하면 안 된다.
_ROLE_WORDS = frozenset(
    {
        "담당자", "담당", "개발자", "기획자", "디자이너", "팀장", "조장", "팀원",
        "백엔드", "프론트", "프론트엔드", "프런트엔드", "서버", "클라이언트",
        "다같이", "다 같이", "모두", "전원", "우리", "저희", "각자", "누군가", "아무나",
    }
)

# 이 값 미만이면 매칭하지 않는다.
NAME_MATCH_THRESHOLD = 0.65
# 1등과 2등의 점수 차가 이보다 작으면 모호한 것으로 보고 포기한다.
NAME_MATCH_MARGIN = 0.08


@dataclass(frozen=True, slots=True)
class TeamMemberName:
    user_id: int
    name: str
    aliases: tuple[str, ...] = ()

    @property
    def given_name(self) -> str:
        """성을 뺀 이름. 회의에서는 '민수'처럼 이름만 부르는 경우가 많다."""
        if len(self.name) >= 4 and self.name[:2] in COMPOUND_SURNAMES:
            return self.name[2:]
        if len(self.name) >= 3:
            return self.name[1:]
        return self.name

    def candidates(self) -> tuple[str, ...]:
        out = {self.name, self.given_name, *self.aliases}
        return tuple(x for x in out if x)


@dataclass(frozen=True, slots=True)
class AssigneeMatch:
    user_id: int | None
    matched_name: str | None
    score: float
    reason: str


def normalize_name_hint(hint: str) -> str:
    """존칭·조사를 떼고 이름만 남긴다.

    '민수님이' → '민수',  '김민수 씨한테' → '김민수'
    """
    cleaned = hint.strip().replace(" ", "")
    # 존칭·조사를 반복해서 벗긴다 ('민수님이' 처럼 겹치는 경우)
    for _ in range(3):
        stripped = _HONORIFIC_SUFFIX.sub("", cleaned)
        if stripped == cleaned or not stripped:
            break
        cleaned = stripped
    return cleaned


def resolve_assignee(hint: str | None, members: list[TeamMemberName]) -> AssigneeMatch:
    """전사에 나온 이름을 팀원 user_id 로 매핑한다.

    ASR은 한국어 이름을 자주 틀린다 ('김민수' → '김민서'). 그래서 퍼지 매칭을 쓰되,
    **모호하면 포기한다** — 잘못 배정하느니 사람이 지정하게 하는 게 낫다.
    """
    if not hint or not hint.strip():
        return AssigneeMatch(None, None, 0.0, "담당자가 언급되지 않음")

    cleaned = normalize_name_hint(hint)
    if not cleaned:
        return AssigneeMatch(None, None, 0.0, f"이름을 추출할 수 없음: {hint!r}")

    if cleaned in _ROLE_WORDS or hint.strip() in _ROLE_WORDS:
        return AssigneeMatch(None, None, 0.0, f"역할 표현이지 이름이 아님: {hint!r}")

    # 1) 정확히 일치
    for member in members:
        if cleaned in member.candidates():
            return AssigneeMatch(member.user_id, member.name, 1.0, "정확히 일치")

    # 2) 퍼지 매칭. 후보 문자열 중 가장 높은 점수를 그 멤버의 점수로 쓴다.
    scored: list[tuple[float, TeamMemberName, str]] = []
    for member in members:
        best = max(
            ((SequenceMatcher(None, cleaned, c).ratio(), c) for c in member.candidates()),
            default=(0.0, ""),
        )
        scored.append((best[0], member, best[1]))
    scored.sort(key=lambda x: -x[0])

    if not scored or scored[0][0] < NAME_MATCH_THRESHOLD:
        best = scored[0][0] if scored else 0.0
        return AssigneeMatch(
            None, None, best, f"일치하는 팀원 없음: {cleaned!r} (최고 유사도 {best:.2f})"
        )

    # 3) 1등과 2등이 비슷하면 모호한 것으로 보고 포기
    if len(scored) >= 2 and scored[0][0] - scored[1][0] < NAME_MATCH_MARGIN:
        return AssigneeMatch(
            None,
            None,
            scored[0][0],
            f"모호함: {cleaned!r} 가 {scored[0][1].name}/{scored[1][1].name} 양쪽과 유사",
        )

    score, member, matched = scored[0]
    return AssigneeMatch(
        member.user_id, member.name, score, f"유사 일치 {matched!r} ({score:.2f})"
    )


# ══════════════════════════════════════════════════════════════
# 마감일 해석
# ══════════════════════════════════════════════════════════════

WEEKDAYS: dict[str, int] = {
    "월": 0, "화": 1, "수": 2, "목": 3, "금": 4, "토": 5, "일": 6,
}

_THIS_WEEK = r"(?:이번\s*주|이번주|금주|이주)"
_NEXT_WEEK = r"(?:다음\s*주|다음주|담주|차주|낼주)"


@dataclass(frozen=True, slots=True)
class DeadlineMatch:
    value: date | None
    confidence: float
    reason: str


def _next_weekday(base: date, target: int, *, allow_today: bool = False) -> date:
    """base 이후 가장 가까운 target 요일. 기본적으로 base 당일은 제외한다."""
    delta = (target - base.weekday()) % 7
    if delta == 0 and not allow_today:
        delta = 7
    return base + timedelta(days=delta)


def _weekday_of_week(base: date, target: int, *, weeks_ahead: int) -> date:
    """base가 속한 주(월요일 시작)에서 weeks_ahead 주 뒤의 target 요일."""
    monday = base - timedelta(days=base.weekday())
    return monday + timedelta(days=weeks_ahead * 7 + target)


def _end_of_month(d: date) -> date:
    if d.month == 12:
        return date(d.year, 12, 31)
    return date(d.year, d.month + 1, 1) - timedelta(days=1)


def resolve_deadline(hint: str | None, meeting_date: date) -> DeadlineMatch:
    """한국어 마감 표현을 회의일 기준 실제 날짜로 바꾼다.

    Args:
        hint: '금요일까지', '다음 주 월요일', '8월 8일', '내일' 등 전사 표현
        meeting_date: 기준일 (회의가 열린 날)

    확신이 없으면 ``value=None`` 을 돌려주고 이유를 남긴다.
    """
    if not hint or not hint.strip():
        return DeadlineMatch(None, 0.0, "마감일이 언급되지 않음")

    text = hint.strip().replace(" ", "")

    # ── 절대 날짜: 8월 8일, 8/8, 2026-08-08 ──────────────────
    m = re.search(r"(\d{4})[-./](\d{1,2})[-./](\d{1,2})", text)
    if m:
        y, mo, d = (int(g) for g in m.groups())
        try:
            return DeadlineMatch(date(y, mo, d), 1.0, "절대 날짜")
        except ValueError:
            return DeadlineMatch(None, 0.0, f"잘못된 날짜: {hint!r}")

    m = re.search(r"(\d{1,2})월\s*(\d{1,2})일", text)
    if m:
        mo, d = int(m.group(1)), int(m.group(2))
        year = meeting_date.year
        try:
            result = date(year, mo, d)
        except ValueError:
            return DeadlineMatch(None, 0.0, f"잘못된 날짜: {hint!r}")
        # 이미 지난 달이면 내년으로 (12월 회의에서 "1월 5일")
        if result < meeting_date - timedelta(days=180):
            result = date(year + 1, mo, d)
        return DeadlineMatch(result, 1.0, "절대 날짜(월일)")

    # ── 상대 표현 ────────────────────────────────────────────
    for word, days, conf in (
        ("오늘", 0, 1.0),
        ("내일", 1, 1.0),
        ("모레", 2, 1.0),
        ("낼모레", 2, 0.9),
        ("글피", 3, 0.9),
    ):
        if word in text:
            return DeadlineMatch(meeting_date + timedelta(days=days), conf, f"상대일 {word}")

    # ── 기간 ─────────────────────────────────────────────────
    #
    # ⚠️ 반드시 '일자만' 패턴보다 **앞에** 와야 한다.
    #    '3일 안에'  = 3일 이내 (기간)
    #    '3일까지'   = 이번 달 3일 (날짜)
    #    뒤에 두면 '3일 안에'가 '3일자'로 잘못 해석된다. (테스트로 잡힌 실제 버그)
    _WITHIN = r"(?:안에|이내|내에|내로|내|뒤|후)"

    if re.search(r"일주일\s*" + _WITHIN, text):
        return DeadlineMatch(meeting_date + timedelta(days=7), 0.9, "일주일 이내")
    m = re.search(r"(\d+)일\s*" + _WITHIN, text)
    if m:
        return DeadlineMatch(
            meeting_date + timedelta(days=int(m.group(1))), 0.9, "N일 이내"
        )
    m = re.search(r"(\d+)주\s*" + _WITHIN, text)
    if m:
        return DeadlineMatch(
            meeting_date + timedelta(weeks=int(m.group(1))), 0.9, "N주 이내"
        )

    # ── 일자만: "8일까지". 이번 달 기준, 이미 지났으면 다음 달 ──
    m = re.fullmatch(r"(\d{1,2})일(?:까지|에)?", text)
    if m:
        d = int(m.group(1))
        try:
            result = date(meeting_date.year, meeting_date.month, d)
        except ValueError:
            return DeadlineMatch(None, 0.0, f"잘못된 날짜: {hint!r}")
        if result < meeting_date:
            nxt = _end_of_month(meeting_date) + timedelta(days=1)
            try:
                result = date(nxt.year, nxt.month, d)
            except ValueError:
                return DeadlineMatch(None, 0.3, f"다음 달에 {d}일이 없음")
        return DeadlineMatch(result, 0.85, "일자만 언급 — 이번/다음 달로 추정")

    # ── 주 + 요일 ────────────────────────────────────────────
    weekday_pattern = r"([월화수목금토일])(?:요일)?"

    m = re.search(_NEXT_WEEK + r"\s*" + weekday_pattern, text)
    if m:
        target = WEEKDAYS[m.group(1)]
        return DeadlineMatch(
            _weekday_of_week(meeting_date, target, weeks_ahead=1), 0.95, "다음 주 요일"
        )

    m = re.search(_THIS_WEEK + r"\s*" + weekday_pattern, text)
    if m:
        target = WEEKDAYS[m.group(1)]
        result = _weekday_of_week(meeting_date, target, weeks_ahead=0)
        if result < meeting_date:
            # 이번 주인데 이미 지났다 — 발언자가 다음 주를 의도했을 가능성
            return DeadlineMatch(
                result + timedelta(days=7), 0.5, "이번 주 해당 요일이 이미 지나 다음 주로 해석"
            )
        return DeadlineMatch(result, 0.95, "이번 주 요일")

    # ── 주 단위 ──────────────────────────────────────────────
    if re.search(_NEXT_WEEK + r"(?:까지|말|말까지)?$", text) or re.search(
        _NEXT_WEEK + r"까지", text
    ):
        return DeadlineMatch(
            _weekday_of_week(meeting_date, 6, weeks_ahead=1), 0.8, "다음 주까지(일요일)"
        )
    if re.search(_THIS_WEEK + r"(?:까지|말|말까지)", text):
        return DeadlineMatch(
            _weekday_of_week(meeting_date, 6, weeks_ahead=0), 0.85, "이번 주까지(일요일)"
        )

    # ── 월 단위 ──────────────────────────────────────────────
    if re.search(r"(?:이번\s*달|이번달|금월|월말)\s*(?:말)?(?:까지)?", text):
        return DeadlineMatch(_end_of_month(meeting_date), 0.85, "이번 달 말")
    if re.search(r"(?:다음\s*달|다음달|담달|차월)", text):
        nxt = _end_of_month(meeting_date) + timedelta(days=1)
        return DeadlineMatch(_end_of_month(nxt), 0.7, "다음 달 말")

    # ── 요일만 ───────────────────────────────────────────────
    # '금요일까지' — 회의일 이후 가장 가까운 금요일.
    m = re.search(weekday_pattern + r"(?:까지|에|날)?", text)
    if m:
        target = WEEKDAYS[m.group(1)]
        return DeadlineMatch(
            _next_weekday(meeting_date, target), 0.8, "요일만 언급 — 다음 해당 요일로 해석"
        )

    return DeadlineMatch(None, 0.0, f"해석할 수 없는 표현: {hint!r}")
