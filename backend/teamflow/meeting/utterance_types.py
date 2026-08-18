"""발언 유형 분류 — 8개 라벨과 규칙 기반 기준선.

## 왜 이게 필요한가

기여도는 세 곳에서 이벤트를 받습니다. 칸반과 GitHub 은 이었는데
**회의 쪽이 비어 있었습니다** (docs/08 §0).

`scoring.py` 는 `UTT_DECISION`(5.0) · `UTT_COMMITMENT`(1.5/6.0) ·
`UTT_PROPOSAL`(2.0/5.0) 같은 가중치를 정확히 알고 있는데, **그 이벤트를
만드는 코드가 없었습니다.** `Utterance.utterance_type` 컬럼도 저장 단계에서
채워지지 않았습니다. 즉 운영에서 **회의 기여도는 언제나 0**이었고, 하필
회의 분석 시스템에서 회의 쪽 다리입니다.

## 왜 규칙 기반인가 — 그리고 그 한계

계획(docs/08 §9주차)은 KLUE-RoBERTa 파인튜닝입니다. 그건 GPU 가 있어야
하고 이 환경에는 없습니다. 그런데 **분류기가 없는 것과 배선이 없는 것은
다른 문제**입니다 — 분류기가 생겨도 배선이 없으면 여전히 0입니다.

그래서 인터페이스를 확정하고 규칙 기반 기준선을 둡니다. 이건 임시방편이
아니라 **논문의 기준선**이기도 합니다. "우리 모델이 규칙 기반 대비 Macro
F1 을 얼마나 올렸는가" 를 말하려면 어차피 필요합니다.

⚠️ **규칙은 틀립니다.** 그래서 세 가지로 막습니다.

1. **확신이 낮으면 `other`(0점)로 떨어뜨립니다.** 애매한 것을 `decision`
   으로 찍으면 5점이 근거 없이 생깁니다. 모르는 것은 0점이 맞습니다 —
   여기서 0점은 "말을 안 했다" 가 아니라 "이 발언은 점수 계산에 넣지
   않는다" 이고, 발언 자체는 회의록에 그대로 남습니다.
2. **무엇이 분류했는지 기록합니다.** 기여 이벤트 메타데이터와 신뢰도
   계산에 들어갑니다. 규칙으로 매긴 회의는 학습 모델로 매긴 회의보다
   신뢰도가 낮아야 합니다.
3. **근거를 남깁니다.** 어떤 표현 때문에 그 라벨이 됐는지 적어 두면
   사람이 틀린 것을 고칠 수 있습니다.

## 한국어에서 무엇이 신호인가

한국어 회의 발화는 **문말 어미**가 유형을 꽤 잘 드러냅니다.

    ~할까요? ~어때요?        제안
    ~하겠습니다 ~할게요       업무 약속
    그럼 ~로 하죠 ~로 갑시다   결정
    네 맞아요 그러네요        맞장구

영어권 데이터셋의 규칙을 그대로 옮기면 안 되는 이유가 이것입니다 —
한국어는 어순이 아니라 어미가 화행을 표시합니다.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from teamflow.db import vocab
from teamflow.db.vocab import UtteranceType

# ══════════════════════════════════════════════════════════════
# 라벨 — **값은 `db/vocab.py` 에만 있습니다**
# ══════════════════════════════════════════════════════════════
#
# ⚠️ 예전에는 이 파일이 여덟 개를 직접 적고 있었고, 데이터베이스에는
#    제약이 없었습니다. 그러다 보니 두 가지가 어긋났습니다.
#
#    · 요구는 열 개인데 라벨은 여덟 개이고 **1:1 이 아니었습니다** —
#      동의·반대·보완이 전부 `opinion` 하나로 뭉개져 `REVIEW-005`
#      ("동의 수 · 반대 의견 수")를 셀 수가 없었습니다
#    · `String(20)` 이라 오타든 한글이든 다 저장됐습니다
#
#    이제 값은 `vocab.UtteranceType` 한 곳에 있고 CHECK 제약이 그것을
#    그대로 씁니다. 아래 이름들은 **읽기 편하라고 둔 별칭**입니다.

QUESTION = str(UtteranceType.QUESTION)
PROPOSAL = str(UtteranceType.PROPOSAL)
ANSWER = str(UtteranceType.ANSWER)
AGREEMENT = str(UtteranceType.AGREEMENT)
OBJECTION = str(UtteranceType.OBJECTION)
REFINEMENT = str(UtteranceType.REFINEMENT)
DECISION = str(UtteranceType.DECISION)
REQUEST = str(UtteranceType.REQUEST)
COMMITMENT = str(UtteranceType.COMMITMENT)
CONFIRMATION = str(UtteranceType.CONFIRMATION)
OPINION = str(UtteranceType.OPINION)
SOCIAL = str(UtteranceType.SOCIAL)
OTHER = str(UtteranceType.OTHER)

LABELS: tuple[str, ...] = tuple(str(t) for t in UtteranceType)

#: 점수가 0인 라벨. 여기 떨어져도 발언은 회의록에 그대로 남습니다.
ZERO_SCORE = frozenset(str(t) for t in vocab.UTTERANCE_ZERO_SCORE)

#: 찬반·보완 — `REVIEW-005` 가 세는 것.
STANCE = frozenset(str(t) for t in vocab.UTTERANCE_STANCE)

#: 이 값 아래면 `other` 로 떨어뜨립니다. 애매한 것에 5점을 주면 안 됩니다.
MIN_CONFIDENCE = 0.55

#: 분류기 이름. 기여 이벤트와 신뢰도 계산이 이 값을 봅니다.
CLASSIFIER_RULES = "rules"
CLASSIFIER_MODEL = "klue-roberta"


@dataclass(frozen=True, slots=True)
class Classification:
    label: str
    confidence: float
    #: 왜 이 라벨인가. 사람이 틀린 것을 고칠 수 있어야 합니다.
    reason: str
    classifier: str = CLASSIFIER_RULES


# ══════════════════════════════════════════════════════════════
# 규칙
#
# 순서가 곧 우선순위입니다. 위에 있는 것이 더 강한 신호입니다.
# ══════════════════════════════════════════════════════════════

# 결정 — "그럼 ~로 하죠", "~로 갑시다", "~로 확정"
#
# ⚠️ 가장 비싼 라벨(5.0)이므로 가장 좁게 잡습니다. 넓게 잡으면
# "그렇게 하면 좋겠네요"(의견, 1.0) 가 결정(5.0)이 됩니다.
_DECISION = (
    (re.compile(r"(그럼|그러면|그래서)\s*.{0,30}(하죠|합시다|하기로|가죠|갑시다)"), "결정 어미"),
    (re.compile(r"(으로|로)\s*(확정|결정|하겠습니다|합시다|하죠)"), "확정 표현"),
    (re.compile(r"(결정|확정)(했|하겠|합니다|이에요|입니다)"), "결정 명시"),
)

# 업무 약속 — "제가 ~하겠습니다", "~까지 할게요"
#
# 1인칭 + 의지 어미. 담당자나 기한이 붙으면 더 확실합니다.
_COMMITMENT = (
    (re.compile(r"(제가|내가|나는|저는)\s*.{0,40}(하겠|할게|할께|맡을|맡겠)"), "1인칭 의지"),
    (re.compile(r"(까지|안에|내로)\s*.{0,20}(하겠|할게|할께|끝내|완료|드릴)"), "기한 + 의지"),
    (re.compile(r"(하겠습니다|할게요|할께요|맡겠습니다|처리하겠)"), "의지 어미"),
)

# 제안 — "~할까요?", "~하는 게 어때요?", "~하면 어떨까요?"
#
# ⚠️ **제안은 묻고, 의견은 말합니다.** 그래서 의문·청유 어미를 요구합니다.
# 예전에는 `(하면) ... (좋을)` 을 권유로 잡았는데, 그러면
# "그렇게 하면 좋을 것 같아요"(의견, 1.0)가 제안(2.0~5.0)이 됐습니다.
#
# 애매하면 **싼 라벨로 떨어뜨립니다.** 의견을 제안으로 잘못 보면 점수가
# 부풀고, 제안을 의견으로 잘못 보면 점수가 조금 모자랍니다. 이 시스템은
# 성적에 쓰일 수 있는 값을 내므로 부풀리는 쪽이 더 나쁩니다.
_PROPOSAL = (
    (re.compile(r"(어때요|어떨까요|어떻습니까|괜찮을까요|어떠세요)"), "제안 어미"),
    (re.compile(r"(할까요|해볼까요|하시죠|해보죠|합시다\s*[?？])"), "청유 어미"),
)

# 질문 — 물음표이거나 의문 어미
_QUESTION = (
    (re.compile(r"[?？]\s*$"), "물음표"),
    (re.compile(r"(나요|가요|까요|습니까|입니까|인가요|었나요|죠)\s*[?？]"), "의문 어미"),
    (re.compile(r"^(뭐|무엇|어디|언제|누가|누구|why|어떻게|왜)\b"), "의문사"),
)

# 응답·정보 제공 — "~입니다", "~예요" 로 사실을 말하는 것
#
# 의지 어미(`하겠습니다`)와 겹치지만 `_COMMITMENT` 가 먼저 걸러 갑니다.
_ANSWER = (
    (
        re.compile(
            r"(입니다|이에요|예요|였습니다|했습니다|됩니다|합니다|있습니다|없습니다)"
            r"\s*[.。]?\s*$"
        ),
        "서술 어미",
    ),
    (re.compile(r"(확인해\s*보니|찾아보니|알아보니|보니까)"), "확인 결과"),
)

# 업무 요청 (AI-SPEECH-008) — 남에게 **일을 해 달라**고 하는 것
#
# ⚠️ `_QUESTION` 보다 **먼저** 봅니다. "이거 해주실 수 있나요?" 는 물음표가
# 붙지만 묻는 게 아니라 시키는 것입니다.
#
# ⚠️ 내 약속(`_COMMITMENT`)과 방향이 반대입니다. 그쪽은 1인칭이고 이쪽은
# 2인칭이라, `_COMMITMENT` 가 먼저 걸러 가면 안 겹칩니다.
_REQUEST = (
    (re.compile(r"(해\s*주실|해\s*주세|해\s*주시|맡아\s*주|처리해\s*주)"), "요청 어미"),
    (re.compile(r"(부탁\s*(드립니다|드려요|합니다|해요|드릴게))"), "부탁 표현"),
    (re.compile(r"(맡아|담당해|진행해)\s*(주|줄|주실|주세)"), "담당 요청"),
)

# 확인 요청 (AI-SPEECH-010) — 봐 달라 · 맞는지 알려 달라
#
# ⚠️ 업무 요청과 다릅니다. 저쪽은 **일을 만들고** 이쪽은 **이미 있는 것을
# 봐 달라**는 것입니다. 둘을 한 라벨로 묶으면 회의에서 나온 업무 후보를
# 뽑을 때 "확인해 주세요" 가 새 업무가 됩니다.
_CONFIRMATION = (
    (re.compile(r"확인\s*(좀|한번|한\s*번)?\s*(해\s*주|부탁|바랍)"), "확인 부탁"),
    (re.compile(r"(맞나요|맞을까요|맞는지|맞습니까|되나요|될까요)\s*[?？]?"), "확인 질문"),
    (re.compile(r"(한번|한\s*번)\s*(봐\s*주|보시|검토해\s*주)"), "검토 요청"),
)

# ── 찬반·보완 ──────────────────────────────────────────────────
#
# ⚠️ **넷을 가르는 순서가 곧 뜻입니다.** 반대 → 보완 → 동의 → 그 밖의 의견.
#
# "동의합니다. 다만 일정이 빠듯합니다" 는 **보완**입니다 — 동의만 세면
# 단서가 사라지고, 반대로 세면 동의한 사실이 사라집니다.
#
# ⚠️ 넷 다 **점수는 같습니다**(`scoring.py`). 가르는 것은 세기 위해서지
# 값을 매기기 위해서가 아닙니다. 반대에 더 주면 어깃장이 이득이 되고,
# 동의에 더 주면 반대가 손해가 됩니다. 어느 쪽도 시스템이 정할 일이
# 아닙니다 (`AGENTS.md` 불변식 4).

# 반대 (AI-SPEECH-005)
_OBJECTION = (
    (re.compile(r"(반대|동의하기\s*(는\s*)?어렵|동의하지\s*않)"), "반대 명시"),
    # ⚠️ 한국어 회의에서 반대는 대개 **완곡합니다.** "그 일정은 좀 어려울 것
    #    같습니다" 가 반대인데, 처음에 `그건|이건` 을 앞에 요구했더니 안
    #    걸리고 `other`(0점)로 떨어졌습니다 — 반대 의견이 통째로 안 세어지던
    #    것입니다. 완곡한 부정 평가 자체를 신호로 봅니다.
    (
        re.compile(r"(아닌|어려울|힘들|곤란|무리)\s*(것\s*)?(같|입니다|합니다|해요|네요|겠)"),
        "완곡한 반대",
    ),
    (re.compile(r"(우려|문제가\s*있|무리)(됩니다|입니다|가\s*있|예요|어요|습니다)"), "우려 표명"),
)

# 보완 (AI-SPEECH-006) — 받아들이면서 조건·단서를 붙이는 것
_REFINEMENT = (
    # ⚠️ 꼬리를 `합니다|같습니다` 로만 잡았더니 "다만 일정이 빠듯해
    #    **보입니다**" 가 안 걸렸습니다. 진짜 신호는 앞의 단서 접속사이고,
    #    꼬리는 "문장이 끝났는가" 만 봅니다.
    (re.compile(r"(다만|그런데|하지만|대신)\s*.{0,40}(니다|어요|아요|네요|죠|같)"), "단서 표현"),
    (re.compile(r"(덧붙이|추가로|한\s*가지\s*더|보완하면|더하자면)"), "덧붙임"),
)

# 동의 (AI-SPEECH-004)
#
# ⚠️ **맨몸 동의는 여기 안 옵니다** — 아래 `_SOCIAL` 이 먼저 가져갑니다.
_AGREEMENT = (
    (re.compile(r"(동의|찬성|공감)(합니다|해요|이에요|입니다|하는|해서)"), "동의 명시"),
    (re.compile(r"(저도|나도)\s*.{0,15}(같은\s*생각|동의|찬성)"), "동조 의견"),
)

# 어느 쪽도 아닌 의견 (요구에는 없는 잔여 라벨)
#
# ⚠️ 이걸 없애고 `other`(0점) 로 떨어뜨리면 **지금 세어지던 의견이 사라집니다.**
# 요구가 열 개라고 해서 열한 번째를 지우면 안 되는 이유입니다.
_OPINION = (
    (re.compile(r"(제\s*생각|개인적으로|저는\s*.{0,10}(같아요|같습니다))"), "의견 표지"),
    (re.compile(r"(좋을|나을|괜찮을|맞을)\s*것\s*같"), "완곡한 평가"),
    # "~하면 좋겠어요", "~가 맡으면 좋겠습니다" — 남에게 바라는 것도 의견입니다.
    # 내 약속(`_COMMITMENT`)이 아니므로 여기서 잡아야 합니다.
    (re.compile(r"(좋겠어요|좋겠습니다|좋겠네요|좋을\s*듯)"), "바람 표현"),
)

# 맞장구·잡담 — 0점
#
# ⚠️ **이걸 안 걸러 내면 "네" 를 백 번 말한 사람이 기여자가 됩니다.**
#
# ⚠️⚠️ 세 번째 규칙이 결함 141 입니다. `docs/05` §2.2 가 **"단순 동의·
# 맞장구는 0점"** 이라고 정해 뒀는데, `"맞아요."` 는 0점인데 `"동의합니다."`
# 는 1.0 이었습니다 — **같은 뜻인데 격식 있는 쪽이 점수를 받았습니다.**
# 그리고 그게 제일 쉬운 조작 통로였습니다.
#
# 방향을 가리지 않고 **맨몸이면** 잡습니다. `"반대합니다."` 도 0점입니다.
# 동의만 0점으로 두면 반대가 이득이 되고, 그 순간 시스템이 어깃장에
# 값을 매기는 것이 됩니다.
_SOCIAL = (
    (re.compile(r"^(네|넵|예|응|어|아|음|오|와|하하|ㅋㅋ|ㅎㅎ)[.!~\s]*$"), "단독 맞장구"),
    (
        re.compile(r"^(맞아요|맞습니다|그러네요|그렇죠|그쵸|알겠습니다|감사합니다)[.!~\s]*$"),
        "동조 표현",
    ),
    (
        re.compile(
            r"^(저도|나도|전|저는)?\s*"
            r"(동의|찬성|공감|반대)(합니다|해요|이에요|입니다|이요)?\s*[.!~]*$"
        ),
        "맨몸 찬반 — 내용이 없음",
    ),
    (re.compile(r"^(수고|고생|안녕|반가)"), "인사"),
)

#: 이보다 짧으면 내용이 있다고 보기 어렵습니다.
MIN_MEANINGFUL_CHARS = 4


def _match(text: str, rules: tuple[tuple[re.Pattern[str], str], ...]) -> str | None:
    for pattern, why in rules:
        if pattern.search(text):
            return why
    return None


def classify_by_rules(text: str) -> Classification:
    """규칙 기반 기준선.

    ⚠️ 이 함수는 **틀립니다.** 그래서 확신이 낮으면 `other` 로 떨어집니다.
    한국어 화행은 문말 어미가 잘 드러내지만, 반어·인용·농담은 표면형이
    같습니다. 그런 것을 잡으려면 학습 모델이 필요합니다.
    """
    stripped = (text or "").strip()
    if not stripped:
        return Classification(OTHER, 1.0, "빈 발화")

    # 맞장구를 **가장 먼저** 봅니다. "네, 그럼 그렇게 하죠" 같은 것이
    # 아니라 "네." 하나만 있는 경우를 걸러 내는 게 목적이라, 짧은 것부터
    # 확실하게 처리해야 뒤 규칙이 오작동하지 않습니다.
    if (why := _match(stripped, _SOCIAL)) is not None:
        return Classification(SOCIAL, 0.9, why)

    if len(stripped) < MIN_MEANINGFUL_CHARS:
        return Classification(OTHER, 0.8, "너무 짧아 내용을 판단할 수 없음")

    # 비싼 라벨부터. 아래로 갈수록 흔하고 값이 쌉니다.
    #
    # ⚠️ 요청·확인은 `_QUESTION` **앞**에 있어야 합니다. "해주실 수 있나요?"
    #    는 물음표가 붙지만 묻는 게 아닙니다.
    # ⚠️ 찬반 넷의 순서(반대 → 보완 → 동의 → 그 밖)는 위 주석 참고.
    for rules, label, confidence in (
        (_DECISION, DECISION, 0.75),
        (_COMMITMENT, COMMITMENT, 0.75),
        # ⚠️ 확인이 요청보다 **먼저**입니다. "확인 좀 부탁드립니다" 는
        #    `_REQUEST` 의 "부탁 표현" 에도 걸리는데, 그쪽으로 가면 회의에서
        #    업무 후보를 뽑을 때 **"확인해 주세요" 가 새 업무가 됩니다.**
        (_CONFIRMATION, CONFIRMATION, 0.7),
        (_REQUEST, REQUEST, 0.7),
        (_PROPOSAL, PROPOSAL, 0.7),
        (_QUESTION, QUESTION, 0.8),
        (_OBJECTION, OBJECTION, 0.65),
        (_REFINEMENT, REFINEMENT, 0.65),
        (_AGREEMENT, AGREEMENT, 0.65),
        (_OPINION, OPINION, 0.65),
        (_ANSWER, ANSWER, 0.6),
    ):
        if (why := _match(stripped, rules)) is not None:
            return Classification(label, confidence, why)

    # ⚠️ 여기 오면 **모릅니다.** 아무 라벨이나 찍지 않습니다.
    return Classification(OTHER, 0.5, "규칙에 걸리는 표현이 없음")


def apply_floor(result: Classification) -> Classification:
    """확신이 낮으면 `other`(0점)로 떨어뜨린다.

    애매한 발언 하나가 `decision` 으로 찍히면 근거 없는 5점이 생깁니다.
    **모르는 것은 점수를 주지 않는 쪽이 맞습니다** — 발언 자체는 회의록에
    그대로 남으므로 사람이 나중에 고칠 수 있습니다.
    """
    if result.confidence >= MIN_CONFIDENCE or result.label in ZERO_SCORE:
        return result
    return Classification(
        OTHER,
        result.confidence,
        f"확신 부족({result.confidence:.2f}) — 원래 후보는 {result.label}",
        result.classifier,
    )


def classify(text: str) -> Classification:
    """지금 쓰는 분류기. 규칙 기반 기준선 + 확신 하한."""
    return apply_floor(classify_by_rules(text))


def marks_a_decision(result: Classification) -> bool:
    return result.label == DECISION


def is_scored(label: str | None) -> bool:
    """이 라벨이 기여도에 값을 더하는가."""
    return label is not None and label not in ZERO_SCORE
