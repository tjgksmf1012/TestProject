# 녹음 클라이언트

멀티트랙 녹음의 클라이언트 쪽 로직입니다. 팀원 각자가 자기 폰으로 자기 트랙을
녹음하고, 서버가 그 트랙들을 정렬해 "누가 언제 말했는가"를 확정합니다
([docs/04 §2](../docs/04-회의-처리-파이프라인.md)).

## 실행

```bash
cd frontend
npm test          # 778개, 설치 없이 바로 돌아갑니다
```

**테스트는 의존성 0개입니다.** Node 22.18+ 가 TypeScript 를 그대로 실행하고
(`--experimental-strip-types` 가 기본 활성), 테스트 러너도 내장이라
`npm install` 없이 돌아갑니다 ([docs/11](../docs/11-비용-제로-구성.md)).

타입 검사와 데모 페이지 빌드에만 개발 의존성 3개(약 34MB)가 필요합니다.

```bash
npm install       # typescript, esbuild, @types/node
npm run check     # 타입 검사 + 테스트
```

> ⚠️ Node 의 타입 스트리핑은 **타입을 검사하지 않고 지우기만 합니다.**
> `npm run typecheck` 를 따로 돌려야 실제로 검사됩니다. 실제로 이걸 처음
> 붙였을 때 `client.ts` 에서 항상 거짓인 비교를 하나 잡았습니다.

## 실기기 녹음 테스트 페이지 (docs/09 실험 5)

**모드 A(멀티트랙)의 성립 여부를 결정하는 실험**입니다. 폰이 회의 끝까지
녹음을 유지하는지 확인합니다.

```bash
npm install && npm run build:demo
```

그다음 **백엔드를 띄웁니다.** FastAPI 가 `public/` 을 `/` 에 마운트하므로
터널 하나로 끝납니다 — 화면을 별도 서버에 두면 API 와 오리진이 달라져
CORS 설정과 터널 둘이 필요합니다.

```bash
cd .. && ASR_BACKEND=fake .venv/bin/uvicorn teamflow.api.main:app --app-dir backend
cloudflared tunnel --url http://localhost:8000  # → https 주소 (무료)
```

`npm run serve` 로 정적 서버만 띄울 수도 있지만, 그건 서버 없이 도는
녹음 화면(`/`)만 볼 때 얘기입니다. 승인 화면은 API 가 필요합니다.

폰에서 그 https 주소를 열면 됩니다. **서버 없이도 동작합니다** — 시각
동기화와 업로드를 로컬에서 흉내 내므로 폰만 있으면 커버리지와 공백 원인을
바로 볼 수 있습니다. 결과는 docs/09 실험 5 표에 붙여 넣을 한 줄로 나옵니다.

백엔드에 붙이려면 `?api=https://…&track=https://…/tracks/1` 을 붙이세요.

대신 제약이 하나 있습니다 — **지울 수 있는 문법만** 씁니다.
`enum`, `namespace`, 생성자 파라미터 프로퍼티(`constructor(private x)`)는
런타임에 거부됩니다. `tsconfig.json` 의 `erasableSyntaxOnly` 로 못 박아 뒀습니다.

## 구조

```
[브라우저 API]   browser-adapter.ts    ← 얇음. 여기서 검증 불가
       │
       ▼
[조립]           client.ts             ← 어댑터를 주입받음. 전부 검증됨
       │
       ├── clock.ts         서버 시각 동기화 (NTP 방식)
       ├── capture.ts       코덱 선택, 오디오 제약 검증
       ├── session.ts       상태 머신 — 법적 게이트가 여기 있음
       ├── upload-queue.ts  청크 업로드·재시도·재개·백프레셔
       └── timeline.ts      공백 탐지, 트랙 사용 가능 판정
```

브라우저 API 는 전부 주입합니다. `getUserMedia`, `MediaRecorder`,
`performance.now`, `fetch` 중 어느 것도 로직 모듈에서 직접 부르지 않습니다.
백엔드 `pipeline/steps.py` 의 Protocol 방식과 같습니다.

## 이 코드가 풀고 있는 문제 세 가지

### 1. 기기마다 시계가 다르다

각 폰이 서로 다른 시각에 녹음을 시작합니다. 최종 정렬은 백엔드가 신호에서
직접 구하지만(GCC-PHAT), 그 탐색창이 **±500ms** 입니다
(`audio/multitrack.MAX_PLAUSIBLE_TAU`). 그 안에 들여보내는 게 클라이언트 몫입니다.

- 서버 `GET /api/time` 으로 왕복을 여러 번 재고, **지연이 가장 짧은 표본**을 씁니다.
- 오차 **상한**을 같이 계산해서, 250ms 를 넘으면 녹음을 시작하지 않습니다.
- `Date.now()` 가 아니라 `performance.now()` 로 잽니다. 벽시계는 회의 도중
  NTP 보정으로 껑충 뜁니다.
- 기기 크리스털은 ±50ppm 정도 흐릅니다 — 1시간이면 180ms 입니다. 그래서
  회의 중에도 5분마다 다시 재고, 측정 사이는 선형 보간합니다.

### 2. iOS 는 화면이 잠기면 마이크를 끈다

WebKit 의 제약입니다. Screen Wake Lock(iOS 16.4+)으로 완화할 수 있지만
사용자가 홈 버튼을 누르면 그만입니다. **막을 수 없으니 정확히 알아내는 쪽으로**
설계했습니다.

위험한 건 30초를 잃는 게 아니라 **모르고 잃는 것**입니다. 청크를 그냥
이어붙이면 그 뒤 전체가 30초 앞당겨지고, 트랙 정렬이 깨지고, 에너지 비교로
뽑는 주화자가 전부 틀리고, 결국 엉뚱한 사람의 기여도가 됩니다.

그래서 청크마다 **동기화된 절대 시각**을 붙이고, 공백을 세 경로로 찾습니다.

| 원인 | 어떻게 보이는가 | 어떻게 잡는가 |
|---|---|---|
| `recorder_stalled` | 청크가 아예 안 온다 | 청크 간격 vs timeslice |
| `track_muted` | 청크는 오는데 무음이다 | 트랙 `mute`/`unmute` 이벤트 |
| `chunk_lost` | 만들어졌는데 서버에 없다 | 업로드 큐가 포기한 seq |

커버리지가 80% 아래인 트랙은 **버리고 사람에게 알립니다.** 폰이 잠긴 사람을
"말을 안 한 사람"으로 처리하면 그건 그냥 오답입니다.

### 3. 브라우저 오디오 가공이 백엔드를 망가뜨린다

`echoCancellation`, `noiseSuppression`, `autoGainControl` 을 전부 끕니다.
통화용 기본값이 여기서는 정확히 반대로 작용합니다.

- **잡음 억제** — 트랙 정렬은 *새어 들어온 옆사람 목소리*로 맞춥니다.
  그걸 지우면 정렬할 근거가 사라집니다.
- **자동 게인** — 조용한 트랙을 증폭합니다. 듣고만 있던 팀원이 말한 것으로
  잡히고, 기여도가 부풀려집니다.

그런데 `getUserMedia` 의 맨값 제약은 `ideal` 로 취급됩니다 — 브라우저가 조용히
무시할 수 있습니다. 그래서 요청한 뒤 `track.getSettings()` 로 확인하고,
안 꺼졌으면 그 사실을 서버로 올려 **해당 트랙의 신뢰도를 낮춥니다.**
`exact: false` 로 강제하지 않는 이유는 못 끄는 기기에서 녹음이 아예 시작되지
않기 때문입니다. 아이폰 쓰는 팀원을 배제하는 것보다 낫습니다.

## 검증된 것과 안 된 것

| | 상태 |
|---|---|
| clock / timeline / upload-queue / session / capture / client | ✅ 160개 테스트 |
| review/candidates (승인 규칙·페이로드) | ✅ 38개 테스트 |
| html (속성 자리 이스케이프) | ✅ 12개 테스트 |
| lobby/room (동의 판정·트랙 건강도·종료 가능 여부) | ✅ 25개 테스트 |
| browser-adapter.ts — HTTP 전송기 | ✅ fetch 를 갈아끼워 검증 |
| browser-adapter.ts — 미디어 어댑터 | ⚠️ 문법 로딩만 확인. 실기기 확인 필요 |
| iOS Safari 실제 중단 동작 | ⚠️ 문헌 근거만. 실측 필요 |
| 타입 검사 (`tsc --noEmit`, strict) | ✅ 통과 |
| 실기기 테스트 페이지 (`src/demo/`) | ⚠️ 화면 코드라 자동 테스트 없음 |
| 승인 화면 (`public/review.html`) | ⚠️ 화면 코드라 자동 테스트 없음 |
| 회의 로비 (`public/lobby.html`) | ⚠️ 화면 코드라 자동 테스트 없음. API 계약은 백엔드에서 대조 |
| 화면·API 한 오리진 (FastAPI 가 `public/` 을 `/` 에 마운트) | ✅ 백엔드 테스트로 고정 |

실기기에서 확인해야 하는 항목은 [docs/09 §C](../docs/09-리스크와-검증-실험.md)에
있습니다.

## 서버 쪽 계약

| 엔드포인트 | 용도 |
|---|---|
| `GET /api/time` | `{t1, t2}` — 받은 시각과 보낸 시각. 왕복에서 서버 처리 시간을 빼기 위해 둘 다 필요합니다. 캐시 금지. |
| `POST /api/meetings/{id}/tracks` | 트랙 참가. 멱등이라 새로고침해도 같은 트랙입니다. **전원 동의 전에는 403.** |
| `PUT …/tracks/{tid}/chunks/{seq}` | 청크 하나. PUT 이라 재시도가 안전합니다. `X-Client-At-Ms` 헤더 필수. |
| `GET …/tracks/{tid}/chunks` | 서버가 가진 seq 목록. `UploadQueue.resumeWith()` 에 그대로 넣습니다. |
| `POST …/tracks/{tid}/complete` | 종료 요약(커버리지·공백·캡처 경고). 서버가 실제 청크 수와 대조합니다. |
| `GET /api/meetings/{id}/candidates` | 업무 후보. 확신도 낮은 것부터. |
| `GET /api/meetings/{id}/members` | 팀원 명단. 담당자를 **고르게** 하려면 필요합니다. |
| `POST …/candidates/review` | 승인·거절 제출. 실패는 **코드**로 오고 화면이 문구로 옮깁니다. |
| `POST /api/meetings/{id}/finish` | 강제 종료. 브라우저를 그냥 닫은 사람이 있으면 회의가 영영 처리되지 않습니다. |

`complete` 응답의 `meeting_queued` 가 true 면 전원이 끝나 회의 처리가
시작된 것입니다. false 면 `meeting_status` 에 누구를 기다리는지 들어 있습니다.

동의 검사는 클라이언트와 서버 **양쪽**에 있습니다. 클라이언트 검사는 UX 이고,
서버 검사는 법적 방어선입니다 — 요청은 curl 로도 보낼 수 있습니다.
