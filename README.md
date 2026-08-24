# TeamFlow AI — 연구 저장소

> AI 기반 팀 프로젝트 협업 및 회의 리뷰 통합 플랫폼
> 회의에서 나온 결정을 실제 업무와 코드 활동까지 연결한다.

**현재 상태: 설계 확정 + GPU 없이 검증 가능한 전 구간 구현 완료.**
기여도 엔진, 회의 처리 파이프라인, 녹음 수집(클라이언트·서버), 브라우저
통화(WebRTC), 화면 열여섯 장까지 동작하고 테스트로 고정돼 있습니다.

**남은 것 하나** — 모델 구현(GPU 필요).
회의 → 업무 → GitHub → 기여도 경로는 **끝까지 이어졌습니다.**
지금 순서와 근거는 [`docs/08` §4.1](docs/08-MVP-로드맵.md) 에 있습니다.

> ⚠️ **2026-08-07 방향 전환** — 주력이 **PC 브라우저 + 통화**가 됐습니다
> ([`docs/15`](docs/15-PC-우선-방향.md)). `docs/04` 의 **오디오 설정 두 개가
> 원격에서는 반대**가 됩니다.
>
> ⚠️ **2026-08-13 모바일 제외** — 그때는 "뒤로 미뤘다" 였는데 **범위에서
> 뺐습니다.** 안드로이드 셸은 지웠습니다(`gradlew` 를 커밋한 적이 없어
> 애초에 빌드가 불가능했습니다). 셸은 **PC 웹 + PC 앱(Electron)** 둘입니다.
> 좁은 폭 레이아웃과 44px 손가락 표적은 **남깁니다** — 그건 폰 지원이 아니라
> 창 반쪽·확대 200%·터치 노트북을 위한 것입니다.

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

## 먼저 읽을 것 — 결론 11가지

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
| [00. 이 프로그램은 무엇인가](docs/00-이-프로그램은-무엇인가.md) | **비개발자용 설명** — 무엇을 하는 도구인지, 왜 이렇게 만들었는지 ⭐ **여기부터** |
| [00. 제안서 검토](docs/00-제안서-TeamFlowAI-검토.md) | 「TEAMFLOW AI」 제안서 강점·문제점·수정 목록 |
| [01. 사실검증](docs/01-사실검증-2026-08.md) | 원본 자료의 기술적 주장을 2026-08 기준으로 검증. 정정 13건 |
| [02. 모델 선정과 VRAM 예산](docs/02-모델-선정과-VRAM-예산.md) | 10~16GB VRAM에서 실제로 무엇이 돌아가는가. 티어별 구성 |
| [03. 시스템 아키텍처](docs/03-시스템-아키텍처.md) | FastAPI 단일 백엔드, GPU 배타 락, GitHub App |
| [04. 회의 처리 파이프라인](docs/04-회의-처리-파이프라인.md) | 멀티트랙 녹음, ASR/화자 파이프라인, 출력 스키마. **배치 1(같은 방)/2(각자 PC)로 오디오 설정이 반대** |
| [05. 기여도 산정 설계](docs/05-기여도-산정-설계.md) | 조작 저항성, 역할별 가중치, 출력 형식, 금지사항 |
| [06. 데이터 모델](docs/06-데이터-모델.md) | 제안서 스키마 + 재계산 구조 + 법적 요구사항 반영 |
| [07. 법적·윤리 요구사항](docs/07-법적-윤리-요구사항.md) | 통신비밀보호법 · 개인정보보호법 · 윤리 제약 |
| [08. MVP 로드맵](docs/08-MVP-로드맵.md) | 범위 축소안 + 16주 일정 + **§4.1 방향 전환 이후의 순서** ⭐ 지금 계획 |
| [09. 리스크와 검증 실험](docs/09-리스크와-검증-실험.md) | 지금 당장 돌릴 실험 7개 + 위험 등록부 |
| [10. 열린 질문](docs/10-열린-질문.md) | 결정이 필요한 11가지 |
| [11. 비용 제로 구성](docs/11-비용-제로-구성.md) | 전 구성요소 비용 감사, 함정 4개, 학생 무료 리소스 |
| [12. CCTV 영상 기반 화자판정](docs/12-CCTV-영상-기반-화자판정.md) | 모드 C 법적·기술 검토, 모드 비교, 융합 설계 |
| [13. 화면 구조 (IA)](docs/13-화면-구조.md) | 화면 열여섯 장이 어떻게 이어지는가, 각 화면의 책임, 아직 없는 화면 |
| [15. PC 우선 방향](docs/15-PC-우선-방향.md) | **지금 방향** — 브라우저 통화로 회의, GitHub 최우선, 모바일 제외 |
| [18. 사용설명서](docs/18-사용설명서.md) | **처음 여는 사람용** — 실제 화면 열 개로 따라가는 안내. 되는 것과 안 되는 것 ⭐ |
| [23. 페르소나 QA](docs/23-페르소나-QA.md) | **사람인 척하고 끝까지 써 본 기록** — 여섯 페르소나가 막힌 자리와 고친 것 ⭐ |
| [24. 베타 체험 QA](docs/24-베타-체험-QA.md) | **배포된 것을 처음 받은 사람처럼 눌러 본 기록** — 두 번째부터 안 되던 것들과 브라우저 오류를 로그로 남기기 ⭐ |
| [17. 결함 기록](docs/17-결함-기록.md) | 만들면서 찾은 조용한 결함 **309건** — 재현 방법과 되돌림 확인 |
| [14. 모바일](docs/14-모바일.md) | ⛔ **접힌 방향** — 왜 앱이어야 하는가·안드로이드 셸. `docs/15`·`docs/21` 이 덮었습니다 |
| [16. 디자인 감사 (Stage A)](docs/16-디자인-감사-StageA.md) | 화면을 실제로 렌더해 잰 첫 감사 — 대비·간격·토큰의 근거 |
| [19. 메신저 셸 전환](docs/19-메신저-셸-전환.md) | **디자인 결정 전부** — 셸·브리프 재적용·React 이전. 렌더해 보고 쓴 것 |
| [21. 데스크톱 셸(Electron)](docs/21-데스크톱-셸-Electron.md) | **PC 앱** — 왜 Electron 인가(녹음이 안 끊기게), 인계 자료집의 전제 정정, Phase 0~6 |
| [20. 요구사항 대조](docs/20-요구사항-대조.md) | **「요구사항 정의서」의 요구 ID 를 지금 코드와 하나씩 대조** — 얼마나 만들어졌나에 답하는 곳 ⭐ |
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
| 역할별 가중치 프로파일 | ✅ | `backend/teamflow/contribution/profiles.py` + `PATCH /api/projects/{id}/members/me` + 프로젝트 화면 |
| 신뢰도·조정범위 계산 | ✅ | `backend/teamflow/contribution/confidence.py` |
| **측정 불가 처리 (0점과 구분)** | ✅ | `backend/teamflow/contribution/scoring.py` |
| 기여도 산정 엔진 | ✅ | `backend/teamflow/contribution/scoring.py` |
| DB 스키마 (34개 테이블) | ✅ | `backend/teamflow/db/models.py` |
| **조작 저항성 테스트** | ✅ **11 시나리오 · 24 케이스** | `backend/tests/test_anti_gaming.py` |
| 환경 진단 스크립트 | ✅ | `scripts/check_env.py` |
| LLM 출력 스키마 (guided decoding) | ✅ | `backend/teamflow/meeting/schema.py` |
| 환각 방어 (근거 발화 검증) | ✅ | `backend/teamflow/meeting/validation.py` |
| 담당자·마감일 해석 (한국어) | ✅ | `backend/teamflow/meeting/resolve.py` |
| **회의→후보→승인→칸반 흐름** | ✅ **11주차 게이트** | `backend/teamflow/meeting/approval.py` |
| **FastAPI 앱 + 통합 테스트** | ✅ | `backend/teamflow/api/main.py` |
| **GitHub 웹훅 (HMAC 서명 검증)** | ✅ | `backend/teamflow/github/webhook.py` |
| **GitHub 연결 진단** (배달이 오는지·이름 오타·팀원 계정) | ✅ | `backend/teamflow/github/connection.py` |
| **업무 ↔ PR 연결** (확정/추정 구분·근거 표시) | ✅ | `backend/teamflow/github/linking.py` |
| **발언 유형 분류** (13라벨·규칙 기준선·확신 하한) | ✅ | `backend/teamflow/meeting/utterance_types.py` |
| **회의 발화 → 기여 이벤트** | ✅ | `backend/teamflow/services/meeting_contribution_service.py` |
| **통화 시그널링** (인증·중계 규칙·메시 상한) | 🟡 서버만, 실측 불가 | `backend/teamflow/call/` |
| 기여도 재계산 서비스 | ✅ | `backend/teamflow/services/scoring_service.py` |
| docker-compose (pg/redis/api/worker/llm) | ✅ | `docker-compose.yml` |
| **Dockerfile (api·gpu, ffmpeg 포함)** | ⚠️ 빌드 미검증 | `docker/` |
| **Alembic 마이그레이션** | ✅ 34개 테이블 | `backend/migrations/` |
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
| 청크 → 정렬된 트랙 로더 | ✅ | `backend/teamflow/pipeline/runtime.py` |
| **청크 디코더 (FFmpeg)** | ⚠️ 명령·오류처리만 검증 | `backend/teamflow/audio/decode.py` |
| HTTP 전송기 (시각 헤더·캐시 금지) | ✅ | `frontend/src/lib/recording/browser-adapter.ts` |
| 브라우저 미디어 어댑터 (getUserMedia/MediaRecorder) | ⚠️ 미검증 | 〃 |
| **실기기 녹음 테스트 페이지** (실험 5용) | ✅ | `frontend/src/demo/`, `frontend/public/` |
| 타입 검사 (`tsc --noEmit`, strict) | ✅ | `frontend/tsconfig.json` |
| **업무 후보 승인 화면** | ✅ | `frontend/src/lib/review/`, `frontend/public/review.html` |
| 팀원 명단 API (승인 화면용) | ✅ | `backend/teamflow/api/main.py` |
| **녹음 종료 → 회의 처리 큐잉** | ✅ | `backend/teamflow/tasks/dispatch.py` |
| 녹음 방식별 로더 선택 (모드 A/B) | ✅ | `backend/teamflow/pipeline/runtime.py` |
| **동의 제출·철회 API + 3중 게이트** | ✅ | `backend/teamflow/services/recording_service.py` |
| **프로젝트·회의 생성 API** | ✅ | `backend/teamflow/api/main.py` |
| **시연 데이터 + 가짜 ASR** | ✅ | `scripts/seed_demo.py`, `ASR_BACKEND=fake` |
| 화면·API 한 오리진 (StaticFiles 마운트) | ✅ | `backend/teamflow/api/main.py` |
| **회의 로비 화면** (동의·트랙 상태·강제 종료) | ✅ | `frontend/src/lib/lobby/`, `public/lobby.html` |
| **회의 요약·경고·정렬값 저장** | ✅ | `backend/teamflow/tasks/meeting_tasks.py` |
| **로그 설정** (text/json, 개인정보 차단) | ✅ | `backend/teamflow/logging_config.py` |
| **인증·세션** (scrypt · 세션 쿠키 · 구성원 확인) | ✅ | `backend/teamflow/auth/`, `services/auth_service.py` |
| **기여도 화면** (구간·근거·측정 불가 표시, 순위 없음) | ✅ | `frontend/src/lib/contribution/`, `public/contributions.html` |
| **칸반 화면 + 업무 API** (회의 근거 표시) | ✅ | `frontend/src/lib/kanban/`, `public/kanban.html` |
| **첫 화면** (내 프로젝트·회의·다음 할 일) | ✅ | `frontend/src/lib/home/`, `public/home.html` |
| **화면 간 이동** (막다른 길 없음) | ✅ | `frontend/src/lib/nav/`, [docs/13](docs/13-화면-구조.md) |
| **좁은 폭까지 견디는 판형 + 앱 설치(PWA)** | ✅ | `frontend/public/app.css`·`sw.js` — 폰 지원이 아니라 **창 반쪽·확대 200%·터치 노트북**을 위한 것 |
| **데스크톱 앱** (Electron) | 🟡 **Phase 2·4** — 창이 뜨고, 화면 열여섯 장이 그대로 돌고, 청크가 디스크에 앉고(업로드를 포기해도 소리를 안 잃음), **녹음 중에는 절전을 막고**(화면을 꺼도 녹음이 이어짐), **끊겼다 이어지면 이미 올라간 청크를 건너뜁니다**. 시스템 오디오(Phase 3)와 패키징·서명(Phase 6)은 **아직 없습니다** | `frontend/electron/`, [docs/21](docs/21-데스크톱-셸-Electron.md) |
| ~~안드로이드 셸~~ | ⛔ **접었습니다** — 실기기가 없고 `gradlew` 조차 없어 **빌드 자체가 불가능**했습니다 | [docs/14](docs/14-모바일.md) 머리말 |
| **브라우저 통화로 회의** (WebRTC 메시 5명 · 헤드폰 확인) | ✅ 같은 기기 3인 통화로 확인 / **실제 네트워크는 미검증** | `backend/teamflow/call/`, `frontend/src/lib/call/`, `public/call.html` |
| **PC 화면** (48rem↑ 상단 탭·칸반 3열 가로) | ✅ | `frontend/public/app.css`, [docs/15](docs/15-PC-우선-방향.md) §4.7 |
| **GitHub 백필** (연결 전 활동 + 커버리지 표시) | ✅ 배선·멱등·잘림 처리 / **실제 HTTP 미검증** | `backend/teamflow/github/backfill.py`, [docs/15](docs/15-PC-우선-방향.md) §4.8 |
| 프로젝트 만들기·회의 열기·저장소 연결 **화면** | ✅ | `public/home.html`(만들기·초대코드 참가), `public/project.html`(회의 열기·저장소 연결), `frontend/src/lib/project/setup.ts` |
| **업무 완료 → 기여 이벤트** (마감 준수 포함) | ✅ | `backend/teamflow/services/task_service.py` |
| **보고서** (회의록·주간·최종 · 글자로 내보내기) | ✅ | `backend/teamflow/reports/`, `services/report_service.py`, `public/reports.html` |
| **GitHub 활동 → 기여 이벤트** (App 인증·diff 조회·멱등) | ⚠️ 실측 미검증 | `backend/teamflow/github/client.py`, `services/github_ingest_service.py` |

```bash
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest backend/tests -q      # 개수는 명령이 직접 셉니다
.venv/bin/ruff check backend/ scripts/
python3 scripts/check_env.py                     # 하드웨어 진단

npm --prefix frontend test                       # 설치 불필요 — 개수는 명령이 셉니다
npm --prefix frontend install && npm --prefix frontend run check   # 타입 검사까지
.venv/bin/python scripts/make_icons.py           # 앱 아이콘 (stdlib 만 씀)

TEAMFLOW_SERVER_URL=http://127.0.0.1:8811/home.html \
  npm --prefix frontend run desktop               # 데스크톱 앱 — docs/21

cp .env.example .env                             # 시크릿 채우기
docker compose up -d postgres redis              # 인프라
DATABASE_URL=... .venv/bin/alembic upgrade head   # 스키마 생성

docker compose --profile app --profile llm up -d  # 앱 + LLM
```

### 지금 바로 열어보기 (GPU 없이)

```bash
.venv/bin/python scripts/seed_demo.py            # 시연용 회의 하나 만들기
ASR_BACKEND=fake .venv/bin/uvicorn teamflow.api.main:app --app-dir backend --reload
```

- `http://localhost:8000/home.html` — **여기부터.** 내 프로젝트와 회의, 다음에 할 일
- `http://localhost:8000/lobby.html?meeting=1` — **회의 로비** (동의 → 상태 → 종료)
- `http://localhost:8000/call.html?meeting=1` — **통화** (WebRTC 메시, 5명까지)
- `http://localhost:8000/?meeting=1` — 녹음 화면 (서버 트랙에 참가)
- `http://localhost:8000/` — 녹음 화면 (서버 없이, 실기기 실험 5)
- `http://localhost:8000/review.html?meeting=1` — 업무 후보 승인 화면
- `http://localhost:8000/kanban.html?project=1&meeting=1` — **칸반** (회의 근거가 붙은 업무)
- `http://localhost:8000/contributions.html?project=1&meeting=1` — **기여도**

**주소에 자기가 누구인지 적지 않습니다.** 로그인 화면으로 넘어가고, 그
뒤로는 서버가 세션 쿠키에서 신원을 읽습니다. 시연 계정은 `seed_demo.py` 가
찍어 줍니다 (비밀번호 `teamflow-demo`).

로비부터 여세요. 팀원마다 다른 브라우저(또는 시크릿 창)로 각자 로그인해
동의하면 녹음 버튼이 열립니다. 회의 중에는 **누구의 폰이 끊기고 있는지**가
여기 뜹니다 — 끝난 뒤에 알면 그 발언은 이미 사라진 뒤입니다.

**화면과 API 가 같은 오리진에서 나옵니다.** FastAPI 가 `frontend/public` 을
`/` 에 마운트하므로 터널 하나로 끝나고 CORS 설정이 필요 없습니다 — 폰에서
`getUserMedia()` 를 열려면 페이지와 API 를 둘 다 HTTPS 로 잡아야 하는데,
화면을 별도 서버에 두면 터널이 둘 필요합니다.

승인 화면의 후보 3건은 성격이 일부러 다릅니다 — 바로 승인 가능한 것,
담당자가 안 풀린 것, 확신도 0.34 짜리. **이 화면의 값어치는 "전부 승인"이
아니라 사람이 고쳐야 할 것을 골라내는 데** 있습니다.

> ⚠️ `ASR_BACKEND=fake` 는 오디오를 읽지 않고 대본을 돌려줍니다. 시연·개발
> 전용이며 `/health` 에 그대로 노출되므로 켜져 있으면 바로 보입니다.

> ⚠️ `--profile llm` 을 빼면 회의 처리가 **분석 단계에서 전부 실패합니다.**
> ASR 까지는 돌고 요약·업무추출에서 연결 거부가 납니다.
> `app` 프로필에는 `beat` 도 들어 있습니다 — 이게 없으면 보존기간이 지난
> 원본 오디오가 **영영 삭제되지 않습니다** (법적 요구사항, docs/07 P5).
>
> GPU 가 있으면 `--profile gpu` 를 더합니다. 없어도 `app` 의 워커가 `gpu`
> 큐까지 읽으므로 전 구간이 돕니다 — 다만 ASR·화자분리는 CPU 로 돌아
> 느립니다.

**핵심 흐름이 전 구간 테스트로 검증됩니다.** `test_end_to_end.py` 는 **폰이 HTTP로 올린
청크가 칸반 업무가 될 때까지**를 한 번에 돌립니다 — 가짜로 바꾸는 건 이 환경에 없는 셋
(ffmpeg·ASR·LLM)뿐이고, 동의 게이트·청크 저장·무음 패딩·GCC-PHAT 정렬·주화자 판정·
환각 검증·승인 규칙은 전부 진짜입니다.

> 이 파일이 따로 있는 이유가 있습니다. 구간별 테스트가 전부 통과하는데도
> **아무도 회의 처리를 큐에 넣지 않았고, 잡은 항상 WAV 로더를 썼습니다.**
> 각 구간은 정상이었으니 구간별 테스트로는 원리적으로 못 잡습니다.

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
내용은 웹 검색 결과를 교차 대조한 것이며, **직접 확인이 필요한 항목 14개**를
[09번 문서 §C](docs/09-리스크와-검증-실험.md)에 정리해 두었습니다.
