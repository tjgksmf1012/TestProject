"""기여도 산정 엔진.

docs/05-기여도-산정-설계.md

    점수 = f(불변 이벤트 로그, 가중치 버전, 역할)

순수 함수다. 같은 입력이면 항상 같은 출력이고, 저장된 상태를 읽지 않는다.
그래서 가중치를 바꾸면 전 기간을 재계산할 수 있고, 과거 점수가 오염되지 않는다.

절대 하지 않는 것 (docs/05 §5):
    - 무임승차자 판정
    - 팀원 간 순위·리더보드
    - 근거 없는 점수
    - 시스템이 최종 점수를 확정
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field

from teamflow.contribution import sharing
from teamflow.contribution.confidence import (
    ConfidenceBreakdown,
    CoverageStats,
    adjustment_range,
    compute_confidence,
)
from teamflow.contribution.events import Category, ContributionEvent, EventType, deduplicate
from teamflow.contribution.profiles import ScoringProfile

ALGO_VERSION = "scoring-v1"


def _saturate(magnitude: float, scale: float) -> float:
    """포화 함수. 0에서 1로 수렴한다.

    선형이 아니라 체감하게 만드는 게 핵심이다.
    양을 10배 늘려도 점수는 2배가 안 되므로, 물량 공세로 점수를 올릴 수 없다.
    """
    if magnitude <= 0:
        return 0.0
    return 1.0 - math.exp(-magnitude / scale)


def event_points(event: ContributionEvent) -> float:
    """이벤트 하나의 점수.

    발언 시간·커밋 수처럼 조작이 쉬운 양적 지표는 여기 들어오지 않는다.
    들어오는 것은 이미 정규화 단계에서 걸러진 것뿐이다.
    """
    et = event.event_type
    meta = event.metadata

    # ── code ──────────────────────────────────────────
    if et is EventType.PR_MERGED:
        # ⚠️ 여기에 고정 기본점(flat base)을 두면 안 된다.
        #
        # 초기 설계는 `8.0 + 22.0 * saturate(...)` 였는데, 조작 저항성
        # 테스트에서 오타 PR 30개(각 8점)가 실제 기능 구현 1개를 이겼다.
        # 커밋 단위 조작 문제를 PR 단위로 옮겨놓은 것에 불과했다.
        #
        # 이벤트 '개수'에 비례하는 보상은 무엇이든 개수 늘리기로 뚫린다.
        # 점수는 개수가 아니라 **실질 분량**만 따라가야 한다.
        weighted = float(meta.get("weighted_lines", event.magnitude))
        points = 30.0 * _saturate(weighted, scale=150.0)
        if meta.get("reviewed"):
            points *= 1.25  # 남이 리뷰한 코드에 가중
        if meta.get("has_tests"):
            points *= 1.15
        return points

    if et is EventType.REVIEW_GIVEN:
        return 3.0 + 5.0 * _saturate(event.magnitude, scale=3.0)

    if et is EventType.ISSUE_RESOLVED:
        return 2.0

    # ── task ──────────────────────────────────────────
    if et is EventType.TASK_COMPLETED:
        difficulty = float(meta.get("difficulty", 1))
        # ⭐ **여럿이 맡은 업무는 나눠 갖습니다** (`TASK-006`).
        #
        # 안 나누면 업무 하나에 이름을 다섯 얹는 것으로 팀 합계가 다섯
        # 배가 됩니다 — 아무도 더 일하지 않았는데. 왜 이 몫이 담당자 수가
        # 아니라 **완료 이벤트 수**에서 나오는지는 `sharing.py` 에 있습니다.
        #
        # `share` 는 저장된 값이 아닙니다. `scoring_service.load_events` 가
        # 읽을 때마다 이벤트 로그에서 다시 셉니다. 혼자 맡은 업무에는 키가
        # 아예 없고, 그때 1.0 입니다.
        share = float(meta.get("share", sharing.TASK_TOTAL))
        return 10.0 * max(1.0, min(3.0, difficulty)) * max(0.0, min(1.0, share))

    if et is EventType.BLOCKER_RESOLVED:
        return 5.0

    # ── meeting ───────────────────────────────────────
    if et is EventType.MEETING_ATTENDED:
        return 3.0

    if et is EventType.UTT_DECISION:
        return 5.0

    if et is EventType.UTT_COMMITMENT:
        # 약속만 하고 안 지키면 거의 점수가 없다.
        # 실제로 완료된 업무와 연결되었을 때만 제값을 준다.
        return 6.0 if meta.get("fulfilled") else 1.5

    if et is EventType.UTT_ANSWER:
        return 3.0

    if et is EventType.UTT_PROPOSAL:
        return 5.0 if meta.get("led_to_decision") else 2.0

    if et is EventType.UTT_QUESTION:
        return 1.0

    # ⭐ **찬반·보완은 값이 같습니다.** 요구사항 정의서 §10 이 동의·반대·
    # 보완을 따로 세라고 해서 라벨을 갈랐지만, 가른 것은 **세기 위해서**지
    # 값을 매기기 위해서가 아닙니다.
    #
    # 반대에 더 주면 어깃장이 이득이 되고, 동의에 더 주면 반대가 손해가
    # 됩니다. 둘 다 회의를 망가뜨리고, 어느 쪽이 더 값진가는 **시스템이
    # 정할 일이 아닙니다** (`AGENTS.md` 불변식 4 — 시스템은 판정하지 않음).
    # 팀이 다르게 보면 가중치를 조정하고 그 이유를 남깁니다.
    #
    # ⚠️ 이 넷을 서로 다른 값으로 바꾸려는 사람에게: `test_scoring.py` 의
    # `test_taking_a_side_costs_nothing` 이 막습니다. 그 검사를 지우기
    # 전에 위 문단을 먼저 읽으십시오.
    if et in (
        EventType.UTT_AGREEMENT,
        EventType.UTT_OBJECTION,
        EventType.UTT_REFINEMENT,
        EventType.UTT_OPINION,
    ):
        return 1.0

    # 요청·확인은 남의 일을 만드는 말입니다. 질문과 같은 값을 줍니다 —
    # 더 주면 **일을 시키는 것이 하는 것보다 남는 장사**가 됩니다.
    if et in (EventType.UTT_REQUEST, EventType.UTT_CONFIRMATION):
        return 1.0

    # 맞장구·농담·잡담·미완성 발언은 0점.
    # "네", "맞아요"를 반복해도 기여도가 오르지 않는다.
    if et in (EventType.UTT_SOCIAL, EventType.UTT_OTHER):
        return 0.0

    # ── document ──────────────────────────────────────
    if et is EventType.DOCUMENT_REVISED:
        # 수정 '횟수'가 아니라 실질 변경량. 횟수는 조작이 너무 쉽다.
        return 2.0 + 8.0 * _saturate(event.magnitude, scale=200.0)

    # ── schedule / peer ───────────────────────────────
    # 이 둘은 이벤트 합산이 아니라 별도 집계식을 쓴다 (_schedule_raw, _peer_raw)
    if et in (
        EventType.DEADLINE_MET,
        EventType.DEADLINE_MISSED,
        EventType.DEADLINE_CHANGED,
        EventType.PEER_RATING,
    ):
        return 0.0

    return 0.0


# 일정 준수에서 만점을 받으려면 최소 이만큼의 마감이 있어야 한다.
# 마감 1건만 지킨 사람이 20건 지킨 사람과 같아지는 것을 막는다.
_SCHEDULE_VOLUME_FLOOR = 5


def _schedule_raw(events: list[ContributionEvent]) -> float:
    """일정 준수는 비율 기반. 단순 합산이 아니다."""
    met = sum(1 for e in events if e.event_type is EventType.DEADLINE_MET)
    missed = sum(1 for e in events if e.event_type is EventType.DEADLINE_MISSED)
    total = met + missed
    if total == 0:
        return 0.0
    ratio = met / total
    volume = min(1.0, total / _SCHEDULE_VOLUME_FLOOR)
    return 10.0 * ratio * volume


def _peer_raw(events: list[ContributionEvent]) -> float:
    """동료평가는 **중앙값**. 평균은 극단값 하나에 흔들린다."""
    ratings = [e.magnitude for e in events if e.event_type is EventType.PEER_RATING]
    if not ratings:
        return 0.0
    return statistics.median(ratings) * 2.0  # 1~5 척도 → 2~10


# 카테고리별 점수 천장.
#
# raw = S * (1 - exp(-points/S)) 는 points << S 구간에서 거의 선형이고,
# points >> S 에서 S 로 수렴한다. 즉 정상 범위에서는 실제 차이가 그대로 보이고,
# 비상식적 물량에서만 천장에 걸린다.
#
# 이게 없으면 "이벤트를 아주 많이 만들기"라는 조작이 항상 성립한다.
_CATEGORY_CEILING: dict[Category, float] = {
    Category.CODE: 200.0,
    Category.TASK: 150.0,
    Category.MEETING: 120.0,
    Category.DOCUMENT: 100.0,
}


def _apply_ceiling(category: Category, points: float) -> float:
    ceiling = _CATEGORY_CEILING.get(category)
    if ceiling is None or points <= 0:
        return max(0.0, points)
    return ceiling * _saturate(points, scale=ceiling)


@dataclass(frozen=True, slots=True)
class CategoryScore:
    category: Category
    raw: float
    team_share: float  # 팀 내 이 카테고리 점유율 0~1
    weight: float  # 이 멤버 역할의 가중치 (재정규화 후)
    evidence_ids: list[int] = field(default_factory=list)
    event_count: int = 0


@dataclass(frozen=True, slots=True)
class IntegrityFlag:
    """조작 가능성 신호. 점수를 깎지 않고 **표시만** 한다.

    시스템이 사람을 판정하지 않는다는 원칙(docs/05 §5)을 지키면서도,
    보는 사람이 맥락을 알 수 있게 한다.
    """

    code: str
    message: str
    detail: dict[str, float | int | str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MeasurementGap:
    """이 사람의 이 영역은 **측정하지 못했다**는 표시.

    0점과는 완전히 다르다. 폰이 잠겨 녹음이 끊긴 사람을 "말을 안 한 사람"으로
    처리하면 그건 측정이 아니라 오답이다 (docs/04 §2.6).

    측정하지 못한 영역은 그 사람의 점수 계산에서 **빼고 나머지로 재정규화**한다.
    즉 "회의 기여도가 0" 이 아니라 "회의 기여도는 나머지 활동과 같은 수준이라고
    가정" 하는 것이다. 근거 없는 벌점보다 근거 없는 평균이 낫다 —
    그리고 그 가정을 여기에 표시해서 사람이 고칠 수 있게 한다.
    """

    category: Category
    reason: str
    detail: dict[str, float | int | str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MemberScore:
    user_id: int
    role: str
    share: float  # 최종 기여도 % (팀 합계 100)
    range_low: float
    range_high: float
    confidence: ConfidenceBreakdown
    categories: dict[Category, CategoryScore]
    integrity_flags: list[IntegrityFlag] = field(default_factory=list)
    measurement_gaps: list[MeasurementGap] = field(default_factory=list)

    @property
    def evidence_ids(self) -> list[int]:
        """이 점수를 구성한 모든 근거 이벤트 ID."""
        out: list[int] = []
        for cs in self.categories.values():
            out.extend(cs.evidence_ids)
        return out


@dataclass(frozen=True, slots=True)
class TeamScoreResult:
    algo_version: str
    members: dict[int, MemberScore]
    skipped_categories: list[Category] = field(default_factory=list)

    def ranked_ids(self) -> list[int]:
        """⚠️ 내부 검증·테스트 전용.

        **UI에 순위를 노출하지 말 것** (docs/05 §5, docs/07 E2).
        같은 데이터라도 순위로 보이는 순간 서비스의 성격이 바뀐다.
        """
        return sorted(self.members, key=lambda uid: -self.members[uid].share)


def _member_raw_by_category(
    events: list[ContributionEvent],
) -> tuple[dict[Category, float], dict[Category, list[int]], dict[Category, int]]:
    raw: dict[Category, float] = dict.fromkeys(Category, 0.0)
    evidence: dict[Category, list[int]] = {c: [] for c in Category}
    counts: dict[Category, int] = dict.fromkeys(Category, 0)

    by_category: dict[Category, list[ContributionEvent]] = {c: [] for c in Category}
    for ev in events:
        by_category[ev.category].append(ev)

    for category, evs in by_category.items():
        if category is Category.SCHEDULE:
            raw[category] = _schedule_raw(evs)
        elif category is Category.PEER:
            raw[category] = _peer_raw(evs)
        else:
            raw[category] = _apply_ceiling(category, sum(event_points(e) for e in evs))

        # 점수가 0인 이벤트도 근거로는 남긴다 — "왜 0점인가"를 설명해야 하므로
        evidence[category] = [e.source_id for e in evs]
        counts[category] = len(evs)

    return raw, evidence, counts


def _detect_integrity_flags(events: list[ContributionEvent]) -> list[IntegrityFlag]:
    flags: list[IntegrityFlag] = []

    changes = sum(1 for e in events if e.event_type is EventType.DEADLINE_CHANGED)
    deadlines = sum(
        1
        for e in events
        if e.event_type in (EventType.DEADLINE_MET, EventType.DEADLINE_MISSED)
    )
    if changes >= 3 and changes > deadlines * 0.5:
        flags.append(
            IntegrityFlag(
                code="frequent_deadline_change",
                message="마감일 변경이 잦습니다. 일정 준수율 해석에 주의가 필요합니다.",
                detail={"changes": changes, "deadlines": deadlines},
            )
        )

    utterances = [e for e in events if e.event_type.value.startswith("utt_")]
    if len(utterances) >= 20:
        social = sum(1 for e in utterances if e.event_type is EventType.UTT_SOCIAL)
        if social / len(utterances) >= 0.7:
            flags.append(
                IntegrityFlag(
                    code="mostly_social_utterances",
                    message="발언 대부분이 맞장구·잡담으로 분류되었습니다.",
                    detail={"social": social, "total": len(utterances)},
                )
            )

    prs = [e for e in events if e.event_type is EventType.PR_MERGED]
    if len(prs) >= 3:
        unreviewed = sum(1 for e in prs if not e.metadata.get("reviewed"))
        if unreviewed == len(prs):
            flags.append(
                IntegrityFlag(
                    code="no_external_review",
                    message="병합된 PR이 모두 외부 리뷰 없이 처리되었습니다.",
                    detail={"prs": len(prs)},
                )
            )

    # 사소한 변경만 담긴 PR을 대량 생성하는 조작.
    #
    # 카테고리 천장과 사소변경 감쇠로 수백 건까지는 억제되지만,
    # 물량이 극단으로 가면 결국 뚫린다 (backend/tests/test_anti_gaming.py 참조).
    # 순수 정량 지표로는 원리적으로 막을 수 없으므로 **탐지해서 표시**한다.
    if len(prs) >= 10:
        trivial_prs = sum(1 for e in prs if float(e.metadata.get("weighted_lines", 0)) < 5.0)
        if trivial_prs / len(prs) >= 0.8:
            flags.append(
                IntegrityFlag(
                    code="trivial_pr_spam",
                    message="병합된 PR 대부분이 사소한 변경만 담고 있습니다.",
                    detail={"trivial_prs": trivial_prs, "total_prs": len(prs)},
                )
            )

    return flags


def score_team(
    events_by_user: dict[int, list[ContributionEvent]],
    profiles: dict[int, ScoringProfile],
    coverage: CoverageStats,
    unmeasurable: dict[int, list[MeasurementGap]] | None = None,
) -> TeamScoreResult:
    """팀 전체 기여도를 산정한다.

    Args:
        events_by_user: 멤버별 기여 이벤트. 중복은 내부에서 제거된다.
        profiles: 멤버별 역할 가중치 프로파일.
        coverage: 신뢰도 계산용 데이터 커버리지 (프로젝트 전체 공통).
        unmeasurable: 멤버별로 **측정하지 못한** 영역. 그 영역은 해당 멤버의
            가중치 재정규화에서 제외된다 — 0점을 주는 것과 다르다.
            예: 녹음이 끊긴 트랙 → 그 사람의 MEETING 은 측정 불가.

    Returns:
        멤버별 점유율·신뢰도·조정범위·근거를 담은 결과.
    """
    gaps: dict[int, list[MeasurementGap]] = unmeasurable or {}
    users = sorted(events_by_user)
    clean: dict[int, list[ContributionEvent]] = {
        uid: deduplicate(events_by_user[uid]) for uid in users
    }

    raws: dict[int, dict[Category, float]] = {}
    evidences: dict[int, dict[Category, list[int]]] = {}
    counts: dict[int, dict[Category, int]] = {}
    for uid in users:
        raws[uid], evidences[uid], counts[uid] = _member_raw_by_category(clean[uid])

    # 팀 전체가 0인 카테고리는 계산에서 제외하고 가중치를 재정규화한다.
    # (문서 활동이 아예 없는 팀에서 모두가 문서 0점을 받아 왜곡되는 것을 막는다)
    team_totals: dict[Category, float] = {
        c: sum(raws[uid][c] for uid in users) for c in Category
    }
    active = [c for c in Category if team_totals[c] > 0]
    skipped = [c for c in Category if team_totals[c] <= 0]

    confidence = compute_confidence(coverage)

    weighted: dict[int, float] = {}
    category_scores: dict[int, dict[Category, CategoryScore]] = {}

    for uid in users:
        profile = profiles[uid]
        # 측정하지 못한 영역은 이 사람의 계산에서 뺀다. 남기면 0점이 되고,
        # 0점은 "안 했다"는 뜻이 되어버린다 — 우리가 아는 건 "모른다" 뿐이다.
        unmeasured = {g.category for g in gaps.get(uid, [])}
        scored_categories = [c for c in active if c not in unmeasured]

        # 전부 측정 불가면 뺄 수 없다. 그때는 원래대로 두고 표시만 한다 —
        # 아무 카테고리도 없으면 점수 자체를 만들 수 없기 때문이다.
        if not scored_categories:
            scored_categories = active

        # 이 멤버의 가중치를 측정 가능한 카테고리에 대해서만 재정규화
        active_weight_total = sum(profile.weight(c) for c in scored_categories)
        member_categories: dict[Category, CategoryScore] = {}
        total = 0.0

        for category in scored_categories:
            base_weight = profile.weight(category)
            norm_weight = base_weight / active_weight_total if active_weight_total > 0 else 0.0
            share = raws[uid][category] / team_totals[category]
            total += norm_weight * share
            member_categories[category] = CategoryScore(
                category=category,
                raw=raws[uid][category],
                team_share=share,
                weight=norm_weight,
                evidence_ids=evidences[uid][category],
                event_count=counts[uid][category],
            )

        weighted[uid] = total
        category_scores[uid] = member_categories

    grand_total = sum(weighted.values())

    members: dict[int, MemberScore] = {}
    for uid in users:
        share_pct = (weighted[uid] / grand_total * 100.0) if grand_total > 0 else 0.0
        low, high = adjustment_range(share_pct, confidence.value)
        members[uid] = MemberScore(
            user_id=uid,
            role=profiles[uid].role.value,
            share=share_pct,
            range_low=low,
            range_high=high,
            confidence=confidence,
            categories=category_scores[uid],
            integrity_flags=_detect_integrity_flags(clean[uid]),
            measurement_gaps=list(gaps.get(uid, [])),
        )

    return TeamScoreResult(
        algo_version=ALGO_VERSION,
        members=members,
        skipped_categories=skipped,
    )
