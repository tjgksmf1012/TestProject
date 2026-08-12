"""비효율 회의 탐지 (요구사항 정의서 §12).

## ⚠️ 이 파일이 생긴 이유

`meeting_events.event_type` 의 다섯 값 중 **넷은 만드는 코드가 0곳**
이었습니다 (결함 122). 어휘에는 있고, DB 제약도 받아 주고, 화면도 자리를
비워 두고 있었는데 **아무것도 그 값을 만들지 않았습니다.** 이 저장소의
대표 실패 ① 입니다.

## ⚠️ GPU 도 외부 API 도 없이 무엇을 할 수 있는가

계획(`docs/08` §9주차)은 문장 임베딩입니다. 이 환경에는 GPU 가 없고 외부
생성형 API 도 못 씁니다. 그래서 **어휘 겹침(lexical overlap)** 으로
기준선을 만듭니다.

이건 임시방편이 아니라 **논문의 기준선**이기도 합니다 — "임베딩이 어휘
겹침 대비 얼마나 나은가" 를 말하려면 어차피 필요합니다.
`utterance_types.classify_by_rules` 와 같은 자리입니다.

⚠️ **그래서 틀립니다.** 세 가지로 막습니다.

1. **좁게 잡습니다.** 놓치는 쪽이 없는 것을 만들어 내는 쪽보다 낫습니다 —
   "이 회의는 비효율적이었다" 는 **사람에 대한 판정으로 읽힙니다.**
2. **근거를 답니다.** 어느 발화 때문에 걸렸는지 없으면 반박할 수 없습니다.
3. **판정하지 않습니다.** `severity` 는 전부 `info` 입니다. 점수에도
   안 들어갑니다 — `detect_integrity_flags` 와 달리 이건 **회의**에 대한
   관찰이지 사람에 대한 것이 아닙니다.

## ⚠️ 한국어에서 낱말을 어떻게 자르는가

형태소 분석기가 없습니다(설치 못 합니다). 그래서 **조사만 떼어 냅니다.**
`"로그인은"` → `"로그인"`, `"인증으로"` → `"인증"`.

⚠️ `\\w` 로 자르면 안 됩니다 — 이 저장소가 한 번 당한 함정이고
(`AGENTS.md`), 한글이 `\\w` 에 안 걸리는 정규식 구현이 있습니다. 한글
음절 범위를 직접 씁니다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# ══════════════════════════════════════════════════════════════
# 낱말 자르기
# ══════════════════════════════════════════════════════════════

#: 한글 음절 + 영숫자. ⚠️ `\w` 를 쓰지 않습니다.
_TOKEN = re.compile(r"[가-힣]+|[A-Za-z][A-Za-z0-9_-]*")

#: 떼어 낼 조사. **긴 것부터** 봅니다 — `"으로"` 를 `"로"` 로 먼저 떼면
#: `"인증으"` 가 남습니다.
_PARTICLES = (
    "에서는", "에서도", "으로는", "에게는", "까지는",
    "에서", "에게", "한테", "으로", "라고", "이라고", "부터", "까지",
    "처럼", "보다", "만큼", "밖에", "조차", "마저", "이나", "나마",
    "은", "는", "이", "가", "을", "를", "에", "의", "와", "과",
    "도", "만", "로", "랑", "께",
    # ⚠️ `"야"` 를 넣으면 안 됩니다. 호격 조사(`"철수야"`)로는 드물게 쓰이고,
    #    대신 `"정해야"` 를 `"정해"` 로 잘라 **동사 어간을 화제로** 만듭니다.
    #    실제로 시연 화면의 주제 이탈 근거에 `"정해"` 가 떠 있었습니다.
)

#: 뜻이 없는 낱말. 겹침을 재는 데 방해만 됩니다.
#:
#: ⚠️ 회의에서 **아무 회의에나 나오는 말**입니다. 이걸 안 빼면 모든 구간이
#: 서로 겹쳐 보이고 반복 논의가 회의마다 뜹니다.
_STOPWORDS = frozenset(
    {
        "그거", "저거", "이거", "그건", "이건", "저건", "그럼", "그러면",
        "우리", "저희", "지금", "일단", "그냥", "좀더", "조금", "다시",
        "그리고", "그런데", "하지만", "그래서", "근데", "아니", "네요",
        "생각", "얘기", "이야기", "부분", "경우", "정도", "때문", "라는",
        "가지", "하나", "이번", "다음", "이제", "아까", "여기", "거기",
        "회의", "오늘", "내일", "어제", "이번주", "다음주",
        # ⚠️ 접속사·부사. 이게 본줄기에 섞이면 **주제 이탈이 안 잡힙니다** —
        #    시연 회의에서 `말고` 하나가 점심 얘기를 본줄기로 만들었습니다.
        "말고", "아니면", "잠깐", "이미", "그대로", "같이",
        "먼저", "나중", "혹시", "아마", "역시", "차라리",
    }
)

#: 서술어 꼬리. 이걸로 끝나면 **화제가 아니라 말투**입니다.
#:
#: ⚠️ 안 걸러 내면 `"좋겠습니다"`·`"할까요"`·`"합시다"` 가 낱말로 세어집니다.
#: 그 말들은 아무 회의에나 나오므로 겹침을 재는 데 방해만 되고, 근거로
#: 적어 두면 `"이 구간이 반복인 이유: 합시다"` 같은 것이 화면에 뜹니다.
#:
#: ⚠️ **명사를 지우면 안 됩니다.** `"설계자"`·`"기획자"` 처럼 명사도
#: 이 꼬리로 끝날 수 있어서, 여러 글자짜리 어미만 봅니다.
_PREDICATE_TAILS = (
    "습니다", "십니다", "겠어요", "인데요", "는데요", "을까요", "ㄹ까요",
    "합시다", "봅시다", "하시죠", "하겠다", "하려고", "해야죠",
    "니다", "세요", "에요", "예요", "어요", "아요", "해요", "하죠",
    "까요", "네요", "데요", "겠다", "한다", "된다", "았다", "었다",
    "하자", "이죠", "군요", "구나",
    # 의문·추측 꼬리. `"어때요"`·`"않았나요"` 가 화제로 세어지고 있었습니다.
    "어때요", "어떨까요", "않나요", "았나요", "었나요", "나요",
    "하지", "되지", "을지", "는지", "던가요",
    "해야", "야죠", "야겠", "잖아요", "거든요",
)

#: 이보다 짧으면 낱말로 안 봅니다. 한 글자는 조사를 뗀 찌꺼기일 때가 많습니다.
MIN_WORD = 2


def _is_predicate(token: str) -> bool:
    """말투인가. ⚠️ 줄기를 남기지 않고 **통째로 버립니다** (`"합시다"`)."""
    return any(token.endswith(tail) for tail in _PREDICATE_TAILS)


def _strip_particle(token: str) -> str:
    """조사를 **한 번만** 뗀다.

    ⚠️ 반복해서 떼면 `"인증"` → `"인"` 처럼 뜻이 사라집니다. 남는 글자가
    `MIN_WORD` 보다 짧아지면 아예 안 뗍니다.
    """
    for particle in _PARTICLES:
        if token.endswith(particle) and len(token) - len(particle) >= MIN_WORD:
            return token[: -len(particle)]
    return token


def content_words(text: str) -> set[str]:
    """뜻을 담은 낱말들. 겹침을 재는 단위입니다.

    ⚠️ 영어는 소문자로 맞춥니다 — `JWT` 와 `jwt` 가 다른 낱말이면 같은
    논의가 안 겹쳐 보입니다.
    """
    words: set[str] = set()
    for raw in _TOKEN.findall(text or ""):
        if raw.isascii():
            token = raw.lower()
        else:
            if _is_predicate(raw):
                continue
            token = _strip_particle(raw)
        if len(token) >= MIN_WORD and token not in _STOPWORDS:
            words.add(token)
    return words


# ══════════════════════════════════════════════════════════════
# 입력
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Said:
    """탐지기가 보는 발화 한 줄. **DB 를 모릅니다.**"""

    id: int
    start_ms: int
    end_ms: int
    text: str
    #: `utterance_types` 의 라벨. 아직 분류 전이면 `None`.
    label: str | None = None
    speaker_id: int | None = None


@dataclass(frozen=True, slots=True)
class Finding:
    """찾아낸 구간 하나. `meeting_events` 한 행이 됩니다."""

    event_type: str
    start_ms: int
    end_ms: int
    evidence: list[int]
    detail: dict
    #: ⚠️ 언제나 `info` 입니다. 아래 `SEVERITY` 주석을 보십시오.
    severity: str = "info"


#: ⚠️ **전부 `info` 입니다.** `warning` 이나 `error` 를 붙이고 싶어지면
#: 먼저 이걸 읽으십시오 — 이 값들은 규칙 기반 추정이고, 회의를 빨갛게
#: 칠하는 순간 **팀에 대한 판정**으로 읽힙니다. 등급을 매기는 것은
#: 사람이 합니다 (`AGENTS.md` 불변식 4).
SEVERITY = "info"


# ══════════════════════════════════════════════════════════════
# 구간 나누기
# ══════════════════════════════════════════════════════════════

#: 한 덩어리로 볼 최대 길이. 회의는 대개 몇 분 단위로 화제가 바뀝니다.
PASSAGE_MS = 3 * 60 * 1000


@dataclass(frozen=True, slots=True)
class Passage:
    said: list[Said]
    words: set[str] = field(default_factory=set)

    @property
    def start_ms(self) -> int:
        return self.said[0].start_ms

    @property
    def end_ms(self) -> int:
        return max(s.end_ms for s in self.said)

    @property
    def ids(self) -> list[int]:
        return [s.id for s in self.said]


def passages(said: list[Said], *, span_ms: int = PASSAGE_MS) -> list[Passage]:
    """시간 순 발화를 **몇 분짜리 덩어리**로 자른다.

    ⚠️ 발화 하나씩 비교하지 않습니다. 한 문장은 너무 짧아서 우연히 겹치고,
    우연한 겹침이 "반복 논의" 로 나가면 그 화면은 아무도 안 믿게 됩니다.
    """
    ordered = sorted(said, key=lambda s: (s.start_ms, s.id))
    out: list[Passage] = []
    bucket: list[Said] = []
    anchor = 0

    for one in ordered:
        if bucket and one.start_ms - anchor >= span_ms:
            out.append(Passage(bucket, _words_of(bucket)))
            bucket = []
        if not bucket:
            anchor = one.start_ms
        bucket.append(one)

    if bucket:
        out.append(Passage(bucket, _words_of(bucket)))
    return out


def _words_of(said: list[Said]) -> set[str]:
    words: set[str] = set()
    for one in said:
        words |= content_words(one.text)
    return words


def _overlap(a: set[str], b: set[str]) -> tuple[int, float]:
    """겹친 낱말 수와 **포함률**.

    ⚠️ 자카드가 아닙니다. 자카드는 **크기가 다른 두 덩어리에서 틀린
    자**입니다 — 시연 회의에서 31낱말 덩어리와 7낱말 덩어리가 다섯 낱말을
    공유하는데(짧은 쪽의 71%가 같은 얘기) 자카드는 0.15 밖에 안 나왔습니다.
    회의는 원래 처음에 길게 얘기하고 나중에 짧게 되짚으므로, 자카드로
    재면 **되짚는 것을 영영 못 잡습니다.**

    포함률 = 겹친 수 / 짧은 쪽 크기. "짧은 쪽이 얼마나 같은 얘기인가".

    ⚠️ 작은 덩어리는 포함률이 쉽게 1.0 이 됩니다. 그래서 겹친 **개수**
    하한(`REPEAT_MIN_SHARED`)을 같이 봅니다.
    """
    if not a or not b:
        return 0, 0.0
    shared = a & b
    return len(shared), len(shared) / min(len(a), len(b))


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-001 반복 논의
# ══════════════════════════════════════════════════════════════

#: 떨어진 두 덩어리가 이만큼 벌어져 있어야 "다시" 입니다.
#: 붙어 있는 덩어리가 겹치는 것은 **한 얘기를 이어서 하는 것**입니다.
REPEAT_GAP_MS = 5 * 60 * 1000

#: 낱말이 이만큼은 겹쳐야 같은 화제로 봅니다.
REPEAT_MIN_SHARED = 3

#: 그리고 **포함률**도 봅니다. 낱말이 많은 긴 구간은 우연히도 셋쯤 겹칩니다.
REPEAT_MIN_CONTAINED = 0.35

#: 한 회의에서 이 이상은 안 냅니다. 스무 개가 나오면 그건 목록이지 지적이
#: 아니고, 사람은 목록을 안 읽습니다.
MAX_FINDINGS = 5


def find_repeated_discussion(said: list[Said]) -> list[Finding]:
    """같은 화제가 **한참 뒤에 다시** 나온 구간 (AI-REVIEW-001).

    ⚠️ **붙어 있는 덩어리는 안 셉니다.** 회의는 원래 한 화제를 몇 분씩
    이어서 합니다. 그걸 반복이라고 하면 모든 회의가 걸립니다.

    ⚠️ 겹친 **개수와 비율을 둘 다** 봅니다. 개수만 보면 긴 구간이 우연히
    걸리고, 비율만 보면 짧은 구간 둘이 낱말 하나로 걸립니다.
    """
    blocks = passages(said)
    found: list[tuple[float, Finding]] = []

    for i, first in enumerate(blocks):
        for second in blocks[i + 2 :]:  # ⚠️ `+2` — 바로 옆은 건너뜁니다
            if second.start_ms - first.end_ms < REPEAT_GAP_MS:
                continue
            shared, contained = _overlap(first.words, second.words)
            if shared < REPEAT_MIN_SHARED or contained < REPEAT_MIN_CONTAINED:
                continue
            found.append(
                (
                    contained,
                    Finding(
                        event_type="repeated_discussion",
                        start_ms=first.start_ms,
                        end_ms=second.end_ms,
                        evidence=first.ids + second.ids,
                        detail={
                            # ⚠️ **무엇이 겹쳤는지 적습니다.** 안 적으면
                            # "왜 이게 반복이냐" 에 답할 수 없고, 답할 수
                            # 없는 지적은 그냥 잔소리입니다.
                            "shared_words": sorted(first.words & second.words),
                            "apart_ms": second.start_ms - first.end_ms,
                        },
                        severity=SEVERITY,
                    ),
                )
            )

    found.sort(key=lambda pair: -pair[0])
    return [finding for _, finding in found[:MAX_FINDINGS]]


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-003 주제 이탈
# ══════════════════════════════════════════════════════════════

#: 회의 전체에서 **두 덩어리 이상**에 나오는 낱말이 그 회의의 본줄기입니다.
CORE_MIN_PASSAGES = 2

#: 본줄기와 이만큼밖에 안 겹치면 샌 것으로 봅니다.
DRIFT_MAX_ON_TOPIC = 0.1

#: 이보다 짧게 새는 것은 그냥 곁말입니다.
DRIFT_MIN_MS = 60 * 1000


def find_topic_drift(said: list[Said]) -> list[Finding]:
    """회의의 본줄기에서 **잠깐 샜다가 돌아온** 구간 (AI-REVIEW-003).

    ⚠️ **양옆이 본줄기여야 합니다.** 마지막 덩어리가 안 겹치는 것은 새로
    시작한 화제일 뿐 이탈이 아닙니다 — 회의 끝에 다음 안건을 얘기하는 것을
    "주제 이탈" 이라고 부르면 안 됩니다.

    ⚠️ 본줄기를 **안건이 아니라 회의 자신**에서 뽑습니다. 안건 목록은
    회의가 끝나야 나오는 산출물이고(`next_agenda`), 그걸 기준으로 삼으면
    회의 중에 정한 화제가 전부 이탈로 잡힙니다.
    """
    blocks = passages(said)
    if len(blocks) < 3:
        # 덩어리가 셋 미만이면 "양옆" 이 성립하지 않습니다.
        return []

    seen: dict[str, int] = {}
    for block in blocks:
        for word in block.words:
            seen[word] = seen.get(word, 0) + 1
    core = {word for word, n in seen.items() if n >= CORE_MIN_PASSAGES}
    if not core:
        return []

    def on_topic(block: Passage) -> float:
        if not block.words:
            return 1.0  # 낱말이 없으면 샜다고 말할 근거가 없습니다.
        return len(block.words & core) / len(block.words)

    found: list[Finding] = []
    for index in range(1, len(blocks) - 1):
        block = blocks[index]
        if block.end_ms - block.start_ms < DRIFT_MIN_MS:
            continue
        if on_topic(block) > DRIFT_MAX_ON_TOPIC:
            continue
        # 양옆이 본줄기 위에 있어야 "샜다가 돌아온" 것입니다.
        if on_topic(blocks[index - 1]) <= DRIFT_MAX_ON_TOPIC:
            continue
        if on_topic(blocks[index + 1]) <= DRIFT_MAX_ON_TOPIC:
            continue
        found.append(
            Finding(
                event_type="topic_drift",
                start_ms=block.start_ms,
                end_ms=block.end_ms,
                evidence=block.ids,
                detail={
                    "off_topic_words": sorted(block.words - core),
                    "on_topic_ratio": round(on_topic(block), 3),
                },
                severity=SEVERITY,
            )
        )
    return found[:MAX_FINDINGS]


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-004 미완성 업무
# ══════════════════════════════════════════════════════════════


def find_incomplete_tasks(
    said: list[Said], *, candidate_evidence: set[int]
) -> list[Finding]:
    """누군가 **하겠다고 했는데 업무 후보로 안 이어진** 약속 (AI-REVIEW-004).

    ## ⚠️ 담당자·마감일이 비었는지는 **여기서 안 봅니다**

    그건 `meeting/resolve.py` 가 풀고 승인 화면이 막습니다. 같은 판단을
    여기서 또 하면 두 벌이 되고, 두 벌이 있으면 반드시 갈라집니다
    (이 저장소의 대표 실패 ②).

    여기서 보는 것은 **그 앞 단계**입니다 — 회의에서 약속이 나왔는데
    후보 목록에 그 발화가 아예 안 들어간 경우. 후보가 안 만들어졌으면
    승인 화면에는 카드가 없고, **막을 것도 없습니다.** 조용히 사라지는
    쪽이라 이게 더 위험합니다.
    """
    orphans = [
        one
        for one in said
        if one.label == "commitment" and one.id not in candidate_evidence
    ]
    if not orphans:
        return []

    return [
        Finding(
            event_type="incomplete_task",
            start_ms=min(o.start_ms for o in orphans),
            end_ms=max(o.end_ms for o in orphans),
            evidence=[o.id for o in orphans],
            detail={
                "count": len(orphans),
                # ⚠️ 원문을 **안 베낍니다.** 근거 번호로 가리키면 발화를
                # 고쳤을 때 따라옵니다 — 베끼면 옛말이 남습니다.
                "why": "약속은 있는데 업무 후보로 이어지지 않았습니다",
            },
            severity=SEVERITY,
        )
    ]


# ══════════════════════════════════════════════════════════════
# AI-REVIEW-006 결정 번복
# ══════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Decided:
    """결정 한 줄. 역시 DB 를 모릅니다."""

    id: int
    content: str
    #: 이 결정이 뒤집은 결정. `meeting_tasks` 가 LLM 힌트로 채웁니다.
    supersedes_id: int | None = None
    #: 근거 발화. 구간을 잡는 데 씁니다.
    evidence: list[int] = field(default_factory=list)
    start_ms: int = 0
    end_ms: int = 0


#: 결정 둘이 같은 것을 다룬다고 볼 겹침.
#:
#: ⚠️ 반복 논의보다 **높게** 잡습니다. 결정문은 짧아서 우연히 겹치기 쉽고,
#: "이 결정이 저 결정을 뒤집었다" 는 틀렸을 때 제일 시끄러운 지적입니다.
CONFLICT_MIN_CONTAINED = 0.5
CONFLICT_MIN_SHARED = 2


def find_decision_conflicts(decisions: list[Decided]) -> list[Finding]:
    """앞 결정을 뒤집은 결정 (AI-REVIEW-006).

    ## 두 갈래로 찾습니다

    1. **`supersedes_id` 가 이미 채워진 것.** LLM 이 번복 힌트를 주면
       `meeting_tasks` 가 이 칸을 채웁니다. 그런데 **읽는 곳이 0곳**이라
       채워도 아무 데도 안 나왔습니다 (`docs/20` — "칸은 있는데 늘 NULL"
       이라고 적혀 있었지만, 진짜 문제는 채워져도 안 보이는 것이었습니다).
    2. **어휘가 크게 겹치는 결정 둘.** LLM 이 못 잡았거나 안 돌았을 때의
       기준선입니다.

    ⚠️ 같은 결정을 두 갈래가 다 잡으면 **한 번만** 냅니다.
    """
    found: list[Finding] = []
    reported: set[tuple[int, int]] = set()

    def add(earlier: Decided, later: Decided, how: str, detail: dict) -> None:
        key = (earlier.id, later.id)
        if key in reported:
            return
        reported.add(key)
        evidence = list(dict.fromkeys(earlier.evidence + later.evidence))
        found.append(
            Finding(
                event_type="decision_conflict",
                start_ms=min(earlier.start_ms, later.start_ms),
                end_ms=max(earlier.end_ms, later.end_ms),
                evidence=evidence,
                detail={
                    "how": how,
                    "superseded_decision_id": earlier.id,
                    # ⚠️ **결정 번호를 꼭 답니다.** 결정에 근거 발화가 안
                    # 붙어 있으면 `evidence` 가 빈 채로 나가고, 그러면
                    # 화면에 "결정이 번복됐습니다" 만 뜨고 **어느 결정인지
                    # 볼 방법이 없습니다.** 가드가 이걸 잡았습니다.
                    "decision_ids": [earlier.id, later.id],
                    **detail,
                },
                severity=SEVERITY,
            )
        )

    by_id = {d.id: d for d in decisions}

    # ① 이미 이어져 있는 것
    for later in decisions:
        earlier = by_id.get(later.supersedes_id) if later.supersedes_id else None
        if earlier is not None:
            add(earlier, later, "supersedes", {})

    # ② 어휘 겹침 기준선
    ordered = sorted(decisions, key=lambda d: (d.start_ms, d.id))
    for i, earlier in enumerate(ordered):
        for later in ordered[i + 1 :]:
            shared, contained = _overlap(
                content_words(earlier.content), content_words(later.content)
            )
            if shared < CONFLICT_MIN_SHARED or contained < CONFLICT_MIN_CONTAINED:
                continue
            add(
                earlier,
                later,
                "wording",
                {"shared_words": sorted(
                    content_words(earlier.content) & content_words(later.content)
                )},
            )

    return found[:MAX_FINDINGS]
