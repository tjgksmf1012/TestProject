"""설정.

시크릿은 전부 환경 변수로 받는다. 기본값을 두지 않는다 —
개발용 기본 시크릿은 그대로 배포되기 마련이다.

docs/03-시스템-아키텍처.md §6 시크릿 체크리스트
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    environment: str = "development"
    debug: bool = False

    # ── 이 팀이 사는 달력 ─────────────────────────────────
    #
    # ⚠️ **날짜 판정은 전부 이 시간대로 합니다** (결함 107).
    #
    # 마감 준수를 `completed_at.date()` 로 판정하고 있었습니다. 그건
    # **UTC 달력일**이라 한국(UTC+9)에서는 사람이 보는 날짜와 다릅니다.
    #
    #     완료 2026-09-04T16:00Z  = KST 09-05 01:00   마감 09-04
    #     칸반   (로컬 달력)  → 09-05 > 09-04  → **늦음**
    #     기여도 (UTC 달력)   → 09-04 <= 09-04 → **제때**
    #
    # 같은 업무를 두 화면이 다르게 말합니다. 화면(`kanban/board.ts`)은
    # 이미 로컬 달력으로 고쳐 놓고 그 이유를 주석에 길게 적어 뒀는데,
    # **서버만 안 고쳐져 있었습니다** — 두 벌이 있으면 한쪽만 고쳐집니다.
    #
    # 오차는 한쪽으로만 납니다: UTC 날짜는 KST 날짜보다 같거나 하루
    # 이르므로 **지연을 과소보고만 합니다.** 늦은 것이 제때로 보이지,
    # 그 반대는 없습니다. 기여도는 성적에 쓰일 수 있는 값입니다.
    #
    # Celery 도 같은 값을 씁니다(`tasks/__init__.py`) — 여기서 읽어 갑니다.
    project_timezone: str = "Asia/Seoul"

    # ── 인프라 ────────────────────────────────────────────
    database_url: str = "postgresql+psycopg://teamflow:teamflow@localhost:5432/teamflow"
    redis_url: str = "redis://localhost:6379/0"
    # Windows 로컬 실행은 별도 직렬 워커가 DB에 남은 큐를 처리합니다.
    local_processing: bool = False

    # ── 오디오 저장 ───────────────────────────────────────
    # 개인정보보호법상 생체인식정보는 다른 개인정보와 분리 보관해야 한다.
    # DB와 다른 볼륨, 다른 암호화 키, 다른 접근 권한.
    # docs/07-법적-윤리-요구사항.md P4
    audio_storage_root: Path = Path("/var/teamflow/audio")

    # key_id는 식별자입니다. 실제 AES-GCM 키는 secret으로부터 파생합니다.
    # 두 값 모두 Settings를 통해 읽어 .env와 프로세스 환경의 동작을 맞춥니다.
    # 키 교체 시 기존 청크를 복호화할 수 있어야 하므로 자동 교체하지 않습니다.
    audio_encryption_key_id: str = "dev-only"
    audio_encryption_secret: str | None = Field(default=None, repr=False)

    # 보존기간. 만료 시 원본 오디오만 지우고 전사 텍스트는 남긴다.
    # docs/07 §2.4
    raw_audio_retention_days: int = 30
    segment_audio_retention_days: int = 30
    transcript_retention_days: int = 365

    # ── GitHub App ────────────────────────────────────────
    # OAuth App이 아니라 GitHub App을 쓴다. docs/03 §4.1
    github_app_id: str | None = None
    github_private_key: str | None = Field(default=None, repr=False)
    # 기존 키 파일을 직접 읽는 경로. 키 본문을 환경 파일에 복사할 필요가 없습니다.
    github_private_key_path: Path | None = None
    # 웹훅 서명 검증용. 없으면 누구나 가짜 이벤트를 주입할 수 있다.
    github_webhook_secret: str | None = Field(default=None, repr=False)

    # ── Google OAuth 2.0 ──────────────────────────────────
    google_client_id: str | None = None
    google_client_secret: str | None = Field(default=None, repr=False)
    google_redirect_uri: str | None = None

    # ── AI ────────────────────────────────────────────────
    hf_token: str | None = Field(default=None, repr=False)  # pyannote community-1은 gated

    # llm_backend: vllm | llamacpp | transformers | fake
    # RAM 32GB 환경에서는 llamacpp(CPU)가 1순위. docs/02 §5 전략 C
    # GPU 24GB(RTX 4090)에서는 transformers(인프로세스 GPU) 또는 vllm 지원
    llm_backend: str = "llamacpp"
    llm_base_url: str = "http://localhost:8080/v1"
    llm_model: str = "local"

    # asr_backend: qwen3 | fake
    #
    # "fake" 는 오디오를 보지 않고 대본을 돌려준다. GPU 도 모델도 없이
    # **업로드부터 칸반 등록까지 전 구간을 실제로 돌려 보기 위한 것**이다
    # (scripts/seed_demo.py). 시연·개발용이며 운영에서 쓰면 안 된다 —
    # `/health` 가 이 값을 그대로 노출하므로 켜져 있으면 바로 보인다.
    asr_backend: str = "qwen3"
    asr_model: str = "Qwen/Qwen3-ASR-1.7B"
    diarization_model: str = "pyannote/speaker-diarization-community-1"

    # GPU 배타 락 TTL(초). 워커가 죽으면 이 시간 뒤 자동 해제된다. docs/03 §2.1
    gpu_lock_ttl: int = 1800

    # ── 기여도 ────────────────────────────────────────────
    scoring_algo_version: str = "scoring-v1"

    # ── WebRTC / 통화 ─────────────────────────────────────
    # 기본값은 구글 공개 STUN (docs/15 §3.2: 비용 0원).
    # 대칭 NAT 또는 폐쇄망 운영 시 TURN 서버(coturn 등)를 JSON 문자열로 설정할 수 있다.
    # 예: '[{"urls": ["stun:..."]}, {"urls": ["turn:..."], "username": "..."}]'
    webrtc_ice_servers: str = '[{"urls": ["stun:stun.l.google.com:19302"]}]'

    def parse_ice_servers(self) -> list[dict[str, object]]:
        import json

        try:
            parsed = json.loads(self.webrtc_ice_servers)
            if isinstance(parsed, list):
                return parsed
        except Exception:
            pass
        return [{"urls": ["stun:stun.l.google.com:19302"]}]

    # ── 로그 ──────────────────────────────────────────────
    # 이 프로젝트의 결함은 대부분 **조용히** 일어난다 — 트랙 하나가 버려지고,
    # 회의가 큐에서 멈추고, 후보가 승인되지 않는다. 예외가 안 나므로 로그가
    # 유일한 흔적인데, 그 로그가 기본 설정으로는 나가지 않았다.
    #
    # log_format: text | json  — 컨테이너 로그 수집기가 붙으면 json.
    log_level: str = "INFO"
    log_format: str = "text"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def require_webhook_secret(self) -> str:
        if not self.github_webhook_secret:
            raise RuntimeError(
                "GITHUB_WEBHOOK_SECRET 가 설정되지 않았습니다. "
                "서명 검증 없이는 웹훅을 받을 수 없습니다."
            )
        return self.github_webhook_secret


@lru_cache
def get_settings() -> Settings:
    return Settings()


TRUSTED_FIELDS = frozenset(
    {
        "environment",
        "debug",
        "llm_backend",
        "asr_backend",
        "asr_model",
        "log_level",
        "log_format",
    }
)


def safe_dump(settings: Settings) -> dict[str, object]:
    """로그·헬스체크에 노출해도 되는 값만 추린다. 시크릿은 절대 넣지 않는다."""
    return {k: getattr(settings, k) for k in sorted(TRUSTED_FIELDS)}
