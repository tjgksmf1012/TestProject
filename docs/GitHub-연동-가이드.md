# GitHub 연동 및 Anti-Gaming(조작 저항성) 가이드

TeamFlow AI의 기여도 3대 축 중 하나인 **코드(GitHub)** 연동 방식과
**Anti-Gaming(조작 저항성)** 방어 메커니즘을 설명합니다.

---

## 1. 핵심 철학 및 불변식

1. **커밋(Commit)은 세지 않습니다.**
   - 커밋 1개를 30개로 쪼개는 것은 너무 쉽기 때문에 기여도 이벤트 타입 자체에 커밋이 존재하지 않습니다.
   - **병합(Merge)된 PR만** 기여 이벤트가 됩니다.
2. **단순 개수(Count)로 점수를 매기지 않습니다.**
   - PR마다 고정 기본점을 주면 오타 PR 30개가 실제 기능 구현을 앞서는 역전 현상이 발생합니다.
   - 점수는 개수가 아니라 **실질 변경 분량(meaningful diff lines)**에 비례합니다.
3. **자동 생성 파일과 포맷팅은 배제합니다.**
   - `package-lock.json`, `yarn.lock`, `poetry.lock`, 바이너리/에셋, `black`/`prettier` 전체 포맷팅은 기여 줄 수에서 100% 제외(0점)됩니다.
4. **시스템은 판정하지 않고 맥락을 표시합니다.**
   - 극단적인 물량 공세(수백 건의 오타 수정)는 정량 신호만으로 가치 판정을 내리지 않고, **무결성 플래그(`trivial_pr_spam`, `no_external_review`)**를 부착하여 팀원들과 교수가 진실을 알 수 있게 합니다.

---

## 2. 실제 GitHub 저장소 웹훅(Webhook) 연동

실제 GitHub Repository의 활동을 TeamFlow AI에 실시간으로 수신하려면 다음과 같이 설정합니다.

### ① Webhook Secret 설정
`.env` 파일에 안전한 시크릿 키를 지정합니다:
```bash
GITHUB_WEBHOOK_SECRET=your-secure-webhook-secret-string-here
```
> ⚠️ **보안 원칙**: TeamFlow AI는 모든 수신 웹훅에 대해 `X-Hub-Signature-256` HMAC 서명을 엄격히 검증합니다. 시크릿이 없거나 일치하지 않으면 `401 Unauthorized`로 차단되어 가짜 기여도 조작 주입을 원천 방어합니다.

### ② GitHub 저장소에서 Webhook 등록
1. GitHub 리포지토리 ➔ **Settings** ➔ **Webhooks** ➔ **Add webhook** 이동
2. **Payload URL**:
   - 로컬 테스트 시 (Cloudflare Tunnel 또는 smee.io 사용):
     ```bash
     # Cloudflare Tunnel 무료 터널링 (docs/11 비용 제로 구성)
     cloudflared tunnel --url http://localhost:8811
     # 생성된 https://xxx.trycloudflare.com/api/github/webhook 등록
     ```
   - 서버 배포 시: `https://your-domain.com/api/github/webhook`
3. **Content type**: `application/json`
4. **Secret**: `.env`에 설정한 `GITHUB_WEBHOOK_SECRET` 입력
5. **Which events would you like to trigger this webhook?**:
   - **Let me select individual events** 선택 후 아래 항목 체크:
     - [x] **Pull requests**
     - [x] **Pull request reviews**
     - [x] **Pull request review comments**
     - [x] **Issues**

---

## 3. PR ↔ 칸반 업무(Task) 자동 연결

PR 제목이나 설명 본문에 업무 번호를 적으면 칸반 업무 카드의 **수행 근거(Evidence)**로 자동 연결됩니다:

- **명시적 태스크 마커**: `TASK-12`, `task-12`, `TF-12`, `[TASK-12]`
- **이슈 닫기 마커**: `Closes #12`, `Fixes #12`, `Resolves #12`
- **브랜치명 연결**: `feat/12-login`, `12-auth`

연결된 PR이 병합되면 칸반 보드(`/app/project/1/kanban`)의 해당 업무 카드에 GitHub PR 링크와 머지 배지가 자동으로 표출됩니다.

---

## 4. Anti-Gaming 11대 조작 저항성 시나리오

백엔드 엔진(`test_anti_gaming.py`)은 `docs/09` 실험 4에 정의된 11대 조작 저항성 테스트 24개를 상시 검증하고 있습니다:

| 조작 시나리오 | 시스템의 방어 동작 |
|---|---|
| **1. 커밋 1개를 30개로 쪼개기** | 커밋 단위 이벤트가 없으므로 점수 변화 **없음 (동일)** |
| **2. 오타 수정 PR 대량 생성** | 사소 변경 감쇠(`TRIVIAL_WEIGHT=0.25`) 및 카테고리 천장 적용 ➔ 실제 구현 대비 10% 미만으로 극단적 억제 + `trivial_pr_spam` 경고 플래그 |
| **3. `package-lock.json` 등 lockfile 수정** | `is_excluded_path`에 의해 3000줄을 고쳐도 기여 점수 **0점** |
| **4. 코드 전체 재포맷 (`prettier`/`black`)** | `is_formatting_only`가 공백/줄바꿈 변경을 상쇄하여 기여 점수 **0점** |
| **5. 외부 리뷰 없는 셀프 머지** | 리뷰 가중(1.25배) 박탈 + `no_external_review` 무결성 플래그 부착 |
| **6. 초기 스캐폴딩 5000줄 커밋 1개** | PR당 상한(`MAX_LINES_PER_PR=400`)과 포화 함수에 의해 기여도 독점 차단 |
| **7. 회의에서 맞장구("네", "맞아요")만 반복** | 잡담(`UTT_SOCIAL`)으로 분류되어 회의 점수 **0점** + `mostly_social_utterances` 플래그 |
| **8. 회의에서 혼자 오래 떠들기** | 발언 시간은 점수 산정에 반영되지 않음 (**점수 안 오름**) |
| **9. 마감일 계속 미루기** | 준수율은 유지되나 `frequent_deadline_change` 무결성 플래그 자동 부착 |
| **10. 웹훅 재전송 / 백필 중복 수신** | `delivery_id` 및 4단 유니크 키(`source_kind, source_id, event_type, user_id`)로 중복 점수 팽창 방어 |
| **11. 약속만 하고 안 지키기** | 약속 발화 후 실제 완료 업무로 이어지지 않으면 가산점 박탈 (1.5점 vs 6.0점) |

---

## 5. 원클릭 실기 시연 방법

인터넷 연결이나 실제 GitHub App 등록 없이도, 로컬에서 이 모든 조작 방어를 1초 만에 눈으로 확인할 수 있습니다:

```bash
# Windows 원클릭 실행
run_github_demo.bat

# 또는 직접 명령어 실행
.venv\Scripts\python -X utf8 scripts/run_github_demo.py --reset
```

실행 후 브라우저에서 `http://127.0.0.1:8811/app/project/1/contributions` 에 접속하여:
1. **기여 사슬(Chain)**의 `코드 N건` 링크 확인
2. **기여 구간 및 모름 폭** 실시간 반영 확인
3. 카드 우측 상단의 `?` (Why 팝오버)를 클릭하여 **무결성 경고(`trivial_pr_spam`, `no_external_review`)** 확인
