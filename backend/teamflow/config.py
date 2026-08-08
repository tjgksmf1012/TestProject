"""설정.

시크릿은 전부 환경 변수로 받는다. 기본값을 두지 않는다 —
개발용 기본 시크릿은 그대로 배포되기 마련이다.

docs/03-시스템-아키텍처.md §6 시크릿 체크리스트
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    environment: str = "development"
    debug: bool = False

    # ── 인프라 ────────────────────────────────────────────
    database_url: str = "postgresql+psycopg://teamflow:teamflow@localhost:5432/teamflow"
    redis_url: str = "redis://localhost:6379/0"

    # ── 오디오 저장 ───────────────────────────────────────
    # 개인정보보호법상 생체인식정보는 다른 개인정보와 분리 보관해야 한다.
    # DB와 다른 볼륨, 다른 암호화 키, 다른 접근 권한.
    # docs/07-법적-윤리-요구사항.md P4
    audio_storage_root: Path = Path("/var/teamflow/audio")

    # ⚠️ **이 값은 암호화를 켜지 않습니다.** 지금 오디오는 평문으로 저장됩니다.
    #
    # P4 는 "별도 볼륨 + 별도 키" 를 요구하는데, 지금 된 것은 **볼륨 분리
    # 절반**뿐입니다. 이 필드는 `audio_assets.encryption_key_id` 에 그대로
    # 복사돼 "어느 키로 썼는가" 를 나중에 추적하려고 만든 자리이고, 실제로
    # 암·복호를 하는 코드는 저장소에 없습니다.
    #
    # 이름만 보고 "암호화돼 있구나" 로 읽히면 안 되므로 여기 적어 둡니다.
    # 하다 만 암호화는 안 한 것보다 나쁩니다 — 없는 보호를 믿게 만듭니다.
    #
    # 왜 지금 안 했나: 봉투 암호화는 키 보관·회전·기존 파일 이관까지
    # 같이 정해야 하고, 그걸 대충 하면(예: 환경변수에 원문 키 하나)
    # 감사에서 "암호화했다" 고 적을 근거가 되면서 실제 보호는 없습니다.
    # 직접 만들 영역도 아닙니다. `docs/07` §2.2 P4 에 남은 것으로 적어 뒀습니다.
    audio_encryption_key_id: str = "dev-only"

    # 보존기간. 만료 시 원본 오디오만 지우고 전사 텍스트는 남긴다.
    # docs/07 §2.4
    raw_audio_retention_days: int = 30
    segment_audio_retention_days: int = 30
    transcript_retention_days: int = 365

    # ── GitHub App ────────────────────────────────────────
    # OAuth App이 아니라 GitHub App을 쓴다. docs/03 §4.1
    github_app_id: str | None = None
    github_private_key: str | None = None
    # 웹훅 서명 검증용. 없으면 누구나 가짜 이벤트를 주입할 수 있다.
    github_webhook_secret: str | None = None

    # ── AI ────────────────────────────────────────────────
    hf_token: str | None = None  # pyannote community-1은 gated

    # llm_backend: vllm | llamacpp | fake
    # RAM 32GB 환경에서는 llamacpp(CPU)가 1순위. docs/02 §5 전략 C
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
