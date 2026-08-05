# TeamFlow AI — 연구 저장소

> AI 기반 팀 프로젝트 협업 및 회의 리뷰 통합 플랫폼
> 회의에서 나온 결정을 실제 업무와 코드 활동까지 연결한다.

**현재 상태: 설계 확정 + GPU 없이 검증 가능한 전 구간 구현 완료.**
기여도 엔진, 회의 처리 파이프라인, 녹음 수집(클라이언트·서버)까지 동작하고
테스트로 고정돼 있습니다. 남은 것은 **모델 구현(GPU 필요)** 과 **화면**입니다.
이 저장소는 "무엇을 어떻게 만들 것인가"를 검증·기록하고, 검증된 것부터 코드로 옮기는 곳입니다.

---

## 무엇을 만드는가

대학생 팀 프로젝트에서 **회의 → 업무 → 코드 활동**을 자동으로 연결하고,
그 연결을 근거로 팀원별 기여도와 프로젝트 위험을 **설명 가능한 형태로** 보여주는 웹 플랫폼.

```
회의 녹음 → 화자별 회의록 → "민수가 금요일까지 로그인 API 구현" 업무 추출
        → 사람이 승인 → 칸반 등록 → 관련 PR 병합 → 업무 카드에 수행 근거 연결
        → 기여도 화면에 근거와 함께 반영
```

**핵심 제약**: 외부 생성형 AI API를 쓰지 않습니다. 오픈 웨이트 모델을 자체 인프라에서 서빙합니다.
(API를 안 쓰는 것과 생성형 AI를 안 쓰는 것은 다릅니다 — 이 구분이 프로젝트의 포지셔닝입니다.)

---

## 먼저 읽을 것 — 결론 10가지

1. **방향 자체는 타당합니다.** LLM을 처음부터 학습시키는 건 비추천이고,
   오픈 웨이트 모델 + 규칙 기반 계산 조합이 맞습니다.

2. **ASR 기본값은 Whisper가 아니라 `Qwen3-ASR-1.7B`입니다.**
   Apache 2.0, Whisper-large-v3 상회, 타임스탬프 내장, 공식 vLLM 툴킷 제공.
   Whisper는 한국어 CER 11.13%(KsponSpeech Eval-Other)로 열세입니다.

3. **EXAONE 4.0은 NC(비상업) 라이선스입니다.** 졸업작품·연구·교육은 명시적 허용,
   **창업·유료화는 불가.** 상업화 가능성을 남기려면 Qwen3(Apache 2.0)를 쓰세요.
   → 이게 [Q2](docs/10-열린-질문.md)에서 가장 먼저 정해야 할 것입니다.

4. **10~16GB 어느 쪽이든 ASR + 화자분리 + LLM을 동시에 못 올립니다.**
   튜닝 문제가 아니라 아키텍처 문제입니다. 순차 적재 + GPU 배타 락이 필수입니다.

5. **화자 분리 정확도에 서비스를 걸지 마세요.**
   DER 17~20%가 그대로 기여도 오차가 됩니다.
   → **팀원별 개별 기기 멀티트랙 녹음**이 이 프로젝트에서 가장 가치 있는 설계 결정입니다.
   가장 어려운 AI 문제를 엔지니어링 문제로 치환합니다.

6. **개발 머신은 중급 GPU 10~16GB + RAM 32GB입니다.**
   원본 대화의 "RTX 5080" 전제는 사실이 아니었고, 오히려 다행입니다 — Ampere/Ada 세대는
   PyTorch stable이 그냥 동작합니다. 그리고 **RAM 32GB 덕에 LLM을 CPU로 내리는 게 1순위 전략**이
   되어 VRAM 압박이 사라집니다. 하드웨어 진단: `python3 scripts/check_env.py`

7. **JSON 출력은 프롬프트가 아니라 디코딩으로 강제하세요.**
   vLLM + xgrammar guided decoding이면 스키마 이탈이 원리적으로 불가능합니다.
   이 결정 하나로 소형 모델의 실용성이 달라집니다.

8. **기여도 점수를 저장하지 말고 재계산하세요.**
   `점수 = f(불변 이벤트 로그, 가중치 버전, 역할)`.
   그래야 "왜 이 점수인가"에 답할 수 있고, 가중치를 바꿔도 과거가 오염되지 않습니다.

9. **단일 점수를 띄우지 마세요.** 구간 추정 + 신뢰도 + 근거 링크 + 사람의 최종 확정.
   그리고 **순위·리더보드는 만들지 마세요.**

10. **범위가 과다합니다.** 제안서 12장이 "직접 학습은 1~2개"라고 스스로 정했는데
    나머지 장이 이를 지키지 않습니다. **직접 학습 1개(발언 유형 분류)로 줄이세요.**

11. **전체를 0원으로 만들 수 있습니다.** 실제 반복 비용은 전기료뿐입니다.
    다만 함정이 4개 있습니다 — CATME는 유료, MinIO는 아카이브됨,
    멀티트랙 녹음에는 HTTPS가 필수(무료 해결책 있음), 모바일 앱은 만들지 말 것.
    → [11번 문서](docs/11-비용-제로-구성.md)

---

## 문서

| 문서 | 내용 |
|---|---|
| [00. 제안서 검토](docs/00-제안서-TeamFlowAI-검토.md) | 「TEAMFLOW AI」 제안서 강점·문제점·수정 목록 ⭐ **여기부터** |
| [01. 사실검증](docs/01-사실검증-2026-08.md) | 원본 자료의 기술적 주장을 2026-08 기준으로 검증. 정정 13건 |
| [02. 모델 선정과 VRAM 예산](docs/02-모델-선정과-VRAM-예산.md) | 10~16GB VRAM에서 실제로 무엇이 돌아가는가. 티어별 구성 |
| [03. 시스템 아키텍처](docs/03-시스템-아키텍처.md) | FastAPI 단일 백엔드, GPU 배타 락, GitHub App |
| [04. 회의 처리 파이프라인](docs/04-회의-처리-파이프라인.md) | 멀티트랙 녹음, ASR/화자 파이프라인, 출력 스키마 |
| [05. 기여도 산정 설계](docs/05-기여도-산정-설계.md) | 조작 저항성, 역할별 가중치, 출력 형식, 금지사항 |
| [06. 데이터 모델](docs/06-데이터-모델.md) | 제안서 스키마 + 재계산 구조 + 법적 요구사항 반영 |
| [07. 법적·윤리 요구사항](docs/07-법적-윤리-요구사항.md) | 통신비밀보호법 · 개인정보보호법 · 윤리 제약 |
| [08. MVP 로드맵](docs/08-MVP-로드맵.md) | 범위 축소안 + 조정된 16주 일정 |
| [09. 리스크와 검증 실험](docs/09-리스크와-검증-실험.md) | 지금 당장 돌릴 실험 5개 + 위험 등록부 |
| [10. 열린 질문](docs/10-열린-질문.md) | 결정이 필요한 10가지 |
| [11. 비용 제로 구성](docs/11-비용-제로-구성.md) | 전 구성요소 비용 감사, 함정 4개, 학생 무료 리소스 |
| [12. CCTV 영상 기반 화자판정](docs/12-CCTV-영상-기반-화자판정.md) | 모드 C 법적·기술 검토, 모드 비교, 융합 설계 |
| [원본 자료](docs/원본자료/) | ChatGPT 대화 전문, 제안서 텍스트 추출본 |

---

## 구현 현황

결정(Q1~Q10)은 [10번 문서](docs/10-열린-질문.md) 하단에 확정 기록해 두었습니다.
GPU 없이 **완전히 검증 가능한 부분**부터 코드로 옮기고 있습니다.

| 영역 | 상태 | 위치 |
|---|---|---|
| 기여도 이벤트 모델 | ✅ | `backend/teamflow/contribution/events.py` |
| diff 필터 (조작 저항성 핵심) | ✅ | `backend/teamflow/contribution/diff_filter.py` |
| GitHub 이벤트 정규화 | ✅ | `backend/teamflow/contribution/github_ingest.py` |
| 역할별 가중치 프로파일 | ✅ | `backend/teamflow/contribution/profiles.py` |
| 신뢰도·조정범위 계산 | ✅ | `backend/teamflow/contribution/confidence.py` |
| 기여도 산정 엔진 | ✅ | `backend/teamflow/contribution/scoring.py` |
| DB 스키마 (26개 테이블) | ✅ | `backend/teamflow/db/models.py` |
| **조작 저항성 테스트** | ✅ **24 시나리오** | `backend/tests/test_anti_gaming.py` |
| 환경 진단 스크립트 | ✅ | `scripts/check_env.py` |
| LLM 출력 스키마 (guided decoding) | ✅ | `backend/teamflow/meeting/schema.py` |
| 환각 방어 (근거 발화 검증) | ✅ | `backend/teamflow/meeting/validation.py` |
| 담당자·마감일 해석 (한국어) | ✅ | `backend/teamflow/meeting/resolve.py` |
| **회의→후보→승인→칸반 흐름** | ✅ **11주차 게이트** | `backend/teamflow/meeting/approval.py` |
| **FastAPI 앱 + 통합 테스트** | ✅ | `backend/teamflow/api/main.py` |
| **GitHub 웹훅 (HMAC 서명 검증)** | ✅ | `backend/teamflow/github/webhook.py` |
| 기여도 재계산 서비스 | ✅ | `backend/teamflow/services/scoring_service.py` |
| docker-compose (pg/redis/api/worker/llm) | ✅ | `docker-compose.yml` |
| **Alembic 마이그레이션** | ✅ 26개 테이블 | `backend/migrations/` |
| GPU 배타 락 (TTL·소유권 검증) | ✅ | `backend/teamflow/jobs/gpu_lock.py` |
| **보존기간 삭제 잡** (법적 요구사항) | ✅ | `backend/teamflow/jobs/retention.py` |
| **멀티트랙 정렬 (GCC-PHAT)** | ✅ | `backend/teamflow/audio/multitrack.py` |
| **누출 제거 · 주화자 판정 · 동시발언** | ✅ | 〃 |
| **오디오·영상 융합 화자 판정** | ✅ | `backend/teamflow/video/speaker.py` |
| 얼굴 ↔ 팀원 매칭 (임계값·모호성 처리) | ✅ | 〃 |
| Active Speaker Detection 모델 | ⬜ | 인터페이스 확정, Light-ASD 연동 예정 |
| **회의 처리 파이프라인 오케스트레이션** | ✅ | `backend/teamflow/pipeline/` |
| **Celery 앱 · 태스크 · beat 스케줄** | ✅ | `backend/teamflow/tasks/` |
| 오디오 로더 (WAV, 경로 탈출 차단) | ✅ | `backend/teamflow/pipeline/runtime.py` |
| LLM 클라이언트 (vLLM / llama.cpp) | ⚠️ 미검증 | `backend/teamflow/meeting/llm.py` |
| ASR·화자분리 **모델 구현** | ⬜ | 인터페이스 확정, 실제 GPU 머신에서 |
| **서버 시각 동기화 (NTP 방식)** | ✅ | `frontend/src/lib/recording/clock.ts` + `GET /api/time` |
| **트랙 공백 탐지 · 커버리지 판정** | ✅ | `frontend/src/lib/recording/timeline.ts` |
| **청크 업로드 큐 (재시도·재개·백프레셔)** | ✅ | `frontend/src/lib/recording/upload-queue.ts` |
| **녹음 세션 상태 머신 (동의 게이트)** | ✅ | `frontend/src/lib/recording/session.ts` |
| 캡처 제약 검증 (AGC·잡음억제 해제 확인) | ✅ | `frontend/src/lib/recording/capture.ts` |
| 녹음 클라이언트 조립 | ✅ | `frontend/src/lib/recording/client.ts` |
| **청크 업로드 API** (멱등 PUT · 재개 · 동의 게이트) | ✅ | `backend/teamflow/api/main.py` |
| 청크 파일 저장 (원자적 쓰기 · 경로 고정) | ✅ | `backend/teamflow/audio/chunk_store.py` |
| 트랙 품질 기록 (커버리지·공백·캡처 경고) | ✅ | `backend/teamflow/services/recording_service.py` |
| **트랙 재조립 — 공백 무음 패딩** | ✅ | `backend/teamflow/audio/assembly.py` |
| HTTP 전송기 (시각 헤더·캐시 금지) | ✅ | `frontend/src/lib/recording/browser-adapter.ts` |
| 브라우저 미디어 어댑터 (getUserMedia/MediaRecorder) | ⚠️ 미검증 | 〃 |
| Next.js 화면 (녹음 UI · 승인 UI) | ⬜ | |

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest backend/tests/ -q     # 441 passed
.venv/bin/ruff check backend/ scripts/
python3 scripts/check_env.py                     # 하드웨어 진단

cd frontend && npm test                          # 160 passed, 의존성 0개

cp .env.example .env                             # 시크릿 채우기
docker compose up -d postgres redis              # 인프라
DATABASE_URL=... .venv/bin/alembic upgrade head   # 스키마 생성
```

**핵심 흐름이 전 구간 테스트로 검증됩니다.** GPU가 없어도 LLM 호출부만 페이크로 바꾸면
`전사 → 분석 → 업무 후보 → 검증 → 담당자·마감일 해석 → 승인 → 칸반 등록`이 통째로 돌아갑니다.
(`test_meeting_pipeline.py::test_end_to_end_transcript_to_kanban`)

> 🔍 **구현하면서 설계 결함을 하나 잡았습니다.** 초기 산식은 병합 PR마다 고정 8점을 줬는데,
> 조작 저항성 테스트에서 **오타 PR 30개(250점)가 실제 기능 구현 1개(44점)를 이겼습니다.**
> 커밋 단위 조작 문제를 PR 단위로 옮겨놨을 뿐이었습니다.
> 고정 기본점 제거 + 사소변경 감쇠 + 카테고리 천장으로 수정했고, 200건까지 억제됩니다.
> 500건 이상은 물량이 이기지만 이건 원리적으로 못 막는 영역이라 **탐지해서 표시**합니다.
> 전말: [09번 문서 실험 4](docs/09-리스크와-검증-실험.md)

## 다음에 할 일

문서를 더 쓰는 것보다 **[실험](docs/09-리스크와-검증-실험.md)을 돌리는 게 낫습니다.**
결과에 따라 설계가 바뀌는 것들입니다.

| 순서 | 실험 | 소요 | 이걸로 결정되는 것 |
|---|---|---|---|
| 0 | 환경 구축 + VRAM 실측 | 2~5일 | 모델 배치 전략 (순차/상주/CPU 이관) |
| 1 | 한국어 ASR 비교 (Qwen3-ASR vs Whisper) | 3~4일 | ASR 모델 확정 + 발표 슬라이드 |
| 2 | **멀티트랙 vs 단일 마이크** | 1주 | 파이프라인 전체 구조 ⭐ |
| 3 | 소형 LLM + guided decoding 실용성 | 4~5일 | LLM 크기·모델 확정 |
| 4 | 조작 저항성 테스트 | 2~3일 | 기여도 산식 검증 + 발표 자료 |

병행해서 **[열린 질문 Q1·Q2·Q7](docs/10-열린-질문.md)** 을 먼저 결정하세요.
백엔드 스택, 최종 목적지(→ LLM 라이선스), 팀 규모는 다른 모든 결정의 전제입니다.

---

## 원본 자료

이 연구는 두 개의 입력에서 출발했습니다.

1. **ChatGPT 대화** — 아이디어 발상 및 초기 기술 검토 ([전문](docs/원본자료/chatgpt-대화.md))
2. **TEAMFLOW AI 제안서** — 다른 팀원이 작성한 19장 구성 제안서 ([텍스트 추출본](docs/원본자료/제안서-TeamFlowAI.md))

둘 다 검증 대상이며, [00번](docs/00-제안서-TeamFlowAI-검토.md)과
[01번](docs/01-사실검증-2026-08.md) 문서가 그 결과입니다.

---

## 검증 한계

이 연구를 수행한 세션의 네트워크 정책이 `huggingface.co`, `arxiv.org`, `pyannote.ai`,
`gt-kim.github.io`, `chatgpt.com` 등에 대한 직접 페이지 열람을 차단했습니다.
내용은 웹 검색 결과를 교차 대조한 것이며, **직접 확인이 필요한 항목 10개**를
[09번 문서 §C](docs/09-리스크와-검증-실험.md)에 정리해 두었습니다.
