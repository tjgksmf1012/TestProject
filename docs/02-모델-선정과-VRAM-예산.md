# 02. 모델 선정과 VRAM 예산

**대상 하드웨어: 중급 GPU 10~16GB VRAM + RAM 32GB 이상**

> 📌 **2026-08-05 정정.** 이 문서는 원래 RTX 5080 16GB(Blackwell) 기준으로 작성됐으나,
> 실제 개발 머신이 다른 것으로 확인되어 다시 썼습니다.
> 원본 ChatGPT 대화의 "네 PC가 RTX 5080 16GB이므로"라는 전제는 무효입니다.
>
> **결과적으로는 더 나은 상황입니다.** Blackwell(sm_120)이 아니면 PyTorch stable이
> 그냥 동작하고, `libnvptxcompiler.so` 누락 같은 함정도 없습니다. 0주차 리스크가 크게 줍니다.

정확한 카드 모델에 의존하지 않도록 **탐지 스크립트**를 만들어 뒀습니다:

```bash
python3 scripts/check_env.py
```

실제 VRAM·RAM·아키텍처를 읽어 아래 티어 중 하나를 추천합니다.

---

## 1. 핵심 제약은 그대로입니다

**ASR + 화자분리 + LLM을 동시에 올릴 수 없습니다.** 10~16GB 어느 쪽이든 마찬가지입니다.
이건 튜닝이 아니라 아키텍처로 풀어야 합니다.

다만 **RAM 32GB**라는 조건이 새로 생겨서, 원래보다 훨씬 나은 선택지가 열립니다 → §4

---

## 2. 환경 구축

### 2.1 좋은 소식 — Blackwell 함정이 사라졌습니다

원래 문서의 경고였던 것들:

| 원래 위험 | 현재 |
|---|---|
| PyTorch 2.7.0+ / cu128 휠 **필수** | ✅ 해당 없음. stable 아무 버전이나 동작 |
| `libnvptxcompiler.so` 누락으로 PTX JIT 파손 | ✅ 해당 없음 |
| vLLM·FlashAttention 소스 빌드 실패 | ✅ 해당 없음. 사전빌드 휠 정상 |
| "0주차에 며칠 날릴 수 있음" | 🟢 하루 안에 끝날 가능성이 높음 |

Ampere(RTX 30xx) / Ada(RTX 40xx) 세대는 생태계 지원이 가장 성숙한 구간입니다.

```bash
# CUDA 12.x 계열이면 됩니다. 특정 인덱스를 강제할 필요 없음.
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
python -c "import torch; print(torch.__version__, torch.cuda.get_device_capability())"
```

### 2.2 세대별로 하나만 확인

| 아키텍처 | compute cap. | FP8 | 영향 |
|---|---|---|---|
| Turing (RTX 20xx) | sm_75 | ❌ | KV 캐시 INT8 양자화 사용 |
| **Ampere (RTX 30xx)** | sm_80/86 | ❌ | 위와 같음 |
| **Ada (RTX 40xx)** | sm_89 | ✅ | FP8 KV 캐시 사용 가능 → 컨텍스트 여유 |
| Blackwell (RTX 50xx) | sm_120 | ✅ | cu128 휠 필수 (해당 없음) |

FP8을 못 쓰면 KV 캐시를 INT8로 양자화하면 됩니다. 실용상 차이는 크지 않습니다.
`scripts/check_env.py` 가 자동으로 판정해 알려줍니다.

### 2.3 0주차 체크리스트

```bash
python3 scripts/check_env.py     # 전체 진단
```

- [ ] `torch.cuda.is_available()` 이 True
- [ ] `transformers` ≥ 5.13 (Qwen3-ASR 네이티브 지원)
- [ ] `pyannote.audio` ≥ 4.0 + `HF_TOKEN` (community-1은 gated)
- [ ] vLLM 사전빌드 휠 설치 성공
- [ ] `ffmpeg` 설치
- [ ] `cloudflared` 로 HTTPS 터널 → **폰 2대에서 마이크 권한 팝업 확인**

마지막 항목이 멀티트랙 설계의 전제조건입니다. → [`11-비용-제로-구성.md`](11-비용-제로-구성.md) §3

---

## 3. VRAM 예산

⚠️ 아래는 **추정치**입니다. 파라미터 수 × 정밀도 계산값이고, 실제로는 활성화 메모리·단편화·
프레임워크 오버헤드로 20~40% 더 듭니다. `scripts/check_env.py` 실행 후 직접 측정해 갱신하세요.

| 컴포넌트 | 모델 | 정밀도 | 실사용 추정 |
|---|---|---|---|
| ASR | `Qwen3-ASR-1.7B` | FP16 | **5~6 GB** |
| ASR (경량) | `Qwen3-ASR-0.6B` | FP16 | **2~3 GB** |
| 화자 분리 | pyannote `community-1` | FP32 | **1~2 GB** |
| 화자 임베딩 | ECAPA-TDNN | FP32 | **< 1 GB** |
| LLM | `EXAONE-4.0-1.2B` | 4bit | **1.5~2 GB** |
| LLM | `Qwen3-8B`급 | 4bit(AWQ) | **6~7 GB + KV** |
| LLM | `Qwen3-14B`급 | 4bit | **9~10 GB + KV** |

### 3.1 진짜 병목은 KV 캐시입니다

**회의록은 깁니다.** 1시간 회의 = 한국어 기준 대략 9,000~15,000 토큰.
프롬프트 + 전사 + 출력까지 하면 컨텍스트를 넉넉히 잡아야 하는데, KV 캐시는 컨텍스트 길이에
**선형 비례**합니다.

```
KV 캐시 ≈ layers × 2(K,V) × kv_heads × head_dim × 2바이트 × seq_len
```

8B급(36층, GQA 8 kv-heads, head_dim 128) 기준 토큰당 약 144KB:

| 컨텍스트 | KV 캐시 | 가중치(4bit) 포함 |
|---|---|---|
| 8K | ~1.2 GB | ~8 GB |
| 16K | ~2.4 GB | ~9 GB |
| 32K | ~4.7 GB | ~11 GB |

**10~12GB 카드에서 8B + 32K는 사실상 GPU를 통째로 씁니다.**

완화 수단:
- **컨텍스트를 실제 필요한 만큼만.** `--max-model-len` 기본값은 대부분 과합니다.
- **회의를 10분 청크로 분할** → 계층적 요약. 컨텍스트 요구가 크게 줄어듭니다.
- KV 캐시 양자화 (Ada는 FP8, Ampere는 INT8) → 절반 절감.

---

## 4. 티어별 구성

`scripts/check_env.py` 가 자동 판정하는 기준과 동일합니다.

### 티어 2 — 10~13GB (RTX 3060 12GB, 4070 등)

```
ASR       Qwen3-ASR-1.7B  FP16        ~6GB
화자분리  pyannote community-1        ~2GB
LLM       Qwen3 8B 4bit, 컨텍스트 16K ~9GB
전략      순차 적재 (동시 적재 불가)
```

### 티어 3 — 14~16GB (RTX 4060 Ti 16GB, 4080 등)

```
ASR       Qwen3-ASR-1.7B  FP16        ~6GB
화자분리  pyannote community-1        ~2GB
LLM       Qwen3 8~14B 4bit, 32K       ~11GB
전략      순차 적재. ASR+화자분리 상주도 가능
```

어느 쪽이든 **순차 적재가 기본**입니다.

---

## 5. 배치 전략

### ⭐ 전략 C — LLM을 CPU로 (RAM 32GB면 이게 최선)

**RAM 32GB가 있으므로 이 전략이 1순위입니다.**

```
GPU:  ASR + 화자분리        (~8GB)     ← 상주 가능
CPU:  LLM (llama.cpp Q4)    (RAM 사용)  ← 32GB면 8B급도 여유
```

- ✅ GPU 압박이 사라집니다. 10GB 카드여도 편안합니다.
- ✅ ASR·화자분리를 상주시킬 수 있어 모델 로딩 오버헤드가 사라집니다.
- ✅ GPU와 CPU가 **병렬로** 일할 수 있습니다 — 다음 회의 전사하면서 이전 회의 요약.
- ❌ LLM 생성 속도가 느립니다. 8B Q4 CPU면 초당 5~15 토큰 수준.

**속도가 문제가 안 되는 이유**: 이건 **배치 작업**입니다. 사용자는 회의 끝나고 녹음을 올린 뒤
"분석 중" 화면을 봅니다. 1시간 회의를 10분 걸려 처리해도 아무도 불만이 없습니다.
회의록 JSON 출력은 길어야 2,000 토큰이라 CPU에서도 2~5분이면 끝납니다.

### 전략 A — 순차 적재 (폴백)

```
GPU 락 획득 → 화자분리 로드/실행/언로드
            → ASR 로드/실행/언로드
            → LLM 로드/실행/언로드 → GPU 락 해제
```

- ✅ VRAM 확실히 들어감. 각 단계가 최고 품질 모델 사용 가능.
- ❌ 매 잡마다 모델 로딩 (10~60초씩). 동시 잡 1개.

> 구현 주의: `del model` 만으로는 VRAM이 안 돌아옵니다. `gc.collect()` +
> `torch.cuda.empty_cache()` 를 같이 불러도 단편화가 남습니다.
> **단계별 서브프로세스**가 가장 확실합니다 — 프로세스가 죽으면 OS가 전부 회수합니다.

### 전략 B — 전부 상주 (소형 조합)

```
Qwen3-ASR-0.6B (2.5GB) + pyannote (1.5GB) + EXAONE-4.0-1.2B 4bit (2GB) ≈ 6GB
```
실시간·스트리밍으로 확장할 때 필요해집니다. MVP에는 불필요합니다.

---

## 6. 모델 선정

### 6.1 ASR: `Qwen3-ASR-1.7B` (1순위)

| 근거 | 내용 |
|---|---|
| 성능 | 오픈소스 SOTA, Whisper-large-v3 상회 |
| 라이선스 | **Apache 2.0** — 상업화 걸림돌 없음 |
| 기능 | 타임스탬프 내장, 긴 오디오, 52개 언어 자동 식별 |
| 서빙 | 공식 툴킷이 vLLM 배치/비동기/스트리밍 지원 |
| 통합 | Transformers v5.13.0+ 네이티브 |

**폴백**: VRAM이 빠듯하면 `Qwen3-ASR-0.6B`.
**비교군**: `whisper-large-v3` (한국어 CER 11.13% @ KsponSpeech Eval-Other).
둘 다 돌려 CER 비교하면 발표 슬라이드 한 장이 나옵니다.

> ⚠️ 한국어는 **CER**로 평가합니다. WER 아닙니다. 교착어라 어절 단위 오류율이 과장됩니다.

### 6.2 화자 분리: pyannote.audio 4.0 + `community-1`

- 현존 최고 오픈소스. **CC-BY-4.0** → 서비스 크레딧에 귀속 표시 **필수**.
- HuggingFace gated → `HF_TOKEN` 필요. 배포 파이프라인에 주입 경로를 미리 만드세요.
- ❌ pyannoteAI **Precision-2**는 28% 더 정확하고 화자 식별까지 되지만 **상용 API**입니다.
  "외부 API 미사용"이라는 이 프로젝트의 존재 이유와 정면충돌합니다.

> 💡 **멀티트랙 녹음**([`04`](04-회의-처리-파이프라인.md))을 채택하면 화자 분리의 중요도가
> 크게 떨어집니다. VRAM 압박이 큰 티어일수록 멀티트랙의 가치가 커집니다.

### 6.3 LLM

| 목적 | 추천 | 라이선스 |
|---|---|---|
| 졸업작품 / 연구 / 교육 | `EXAONE-4.0-32B` (한국어 최강) | NC — 교육 목적 **명시 허용** |
| **상업화 여지를 남김** | **`Qwen3` 계열** | **Apache 2.0** ← 확정 |
| 10~16GB 로컬 | `Qwen3-8B` 4bit / `EXAONE-4.0-1.2B` | 각각 위와 동일 |

[`10-열린-질문.md`](10-열린-질문.md) Q2에서 **Qwen3(Apache 2.0)로 확정**했습니다.
EXAONE은 한국어 성능 비교군으로만 씁니다.

**태스크 특성**: 이 프로젝트의 LLM 작업은 "한국어 회의록 → 구조화 JSON"입니다.
창의적 글쓰기가 아니라 **지시 따르기 + 스키마 준수 + 정보 추출**이고, Qwen3가 강한 영역입니다.

### 6.4 출력 형식은 디코딩으로 강제

```python
from pydantic import BaseModel

class MeetingAnalysis(BaseModel):
    summary: str
    decisions: list[Decision]
    tasks: list[TaskCandidate]
    unresolved_issues: list[str]

schema = MeetingAnalysis.model_json_schema()
# vLLM: guided_json=schema, guided_decoding_backend="xgrammar"
```

xgrammar가 2026년 권장 백엔드입니다. **같은 스키마를 반복 사용할 때 캐싱 이득이 크고,
이 프로젝트는 항상 같은 스키마를 씁니다.** 스키마 이탈이 원리적으로 불가능해집니다.

> LLM을 CPU(llama.cpp)로 내리는 경우에도 GBNF 문법으로 같은 효과를 얻을 수 있습니다.
> `llama.cpp` 는 JSON Schema → GBNF 변환 도구를 제공합니다.

---

## 7. LoRA 파인튜닝

**하드웨어는 문제가 아닙니다.** QLoRA는 7B에 최소 8GB, 10~16GB면 충분합니다.
Unsloth는 표준 QLoRA 대비 2배 빠르고 VRAM 70% 절감.

**문제는 데이터입니다.** 회의 녹취 + 정답 라벨을 수백 건 만들려면 수백 회분의 수작업
라벨링이 필요합니다. 졸업작품 기간에 불가능합니다.

→ **재정의**: 20~30건에 정답 라벨을 붙여 **평가 데이터셋**으로 쓰세요.
학습이 아니라 모델·프롬프트 비교 측정용입니다.

**직접 학습은 발언 유형 분류(KLUE-RoBERTa) 1개로 확정**했습니다
([`10-열린-질문.md`](10-열린-질문.md) Q4). 이건 문장 단위 라벨링이라 비용이 낮고,
**VRAM도 거의 안 듭니다** (인코더 모델은 작습니다).
여차하면 Kaggle 무료 GPU(주 30시간)에서도 됩니다.

---

## 8. 최종 권고

```
전략:      C (LLM을 CPU로) — RAM 32GB 활용     ※ 폴백: A (순차 적재)
ASR:       Qwen3-ASR-1.7B (GPU)         [Apache 2.0]
화자분리:  pyannote community-1 (GPU)   [CC-BY-4.0, 귀속 표시 필수]
화자식별:  ECAPA-TDNN + 코사인 유사도    [Apache 2.0]  ※ 멀티트랙이면 불필요
LLM:       Qwen3 8B 4bit (CPU, llama.cpp)  [Apache 2.0]
구조출력:  guided decoding (vLLM xgrammar / llama.cpp GBNF)
학습:      KLUE-RoBERTa 발언 유형 분류 1개
```

**가장 중요한 결정은 여전히 모델이 아닙니다.**
멀티트랙 녹음([`04`](04-회의-처리-파이프라인.md))을 채택하면 화자 분리·화자 식별의
중요도가 떨어지고, GPU 예산도 함께 여유로워집니다.
