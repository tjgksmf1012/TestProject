"""보존기간 만료 처리 — 법적 요구사항.

docs/07-법적-윤리-요구사항.md P5, P6

개인정보보호법상 음성은 생체인식정보로 간주될 수 있고, 원본을 보관하려면
별도 동의가 필요하다. 보존기간이 지나면 지워야 한다.

**핵심 정책: 원본 오디오만 지우고 전사 텍스트는 남긴다.**
    - 전사는 회의록·기여도 근거로 계속 필요하다
    - 원본 음성은 전사 검증이 끝나면 쓸 일이 없다
    - 목소리 자체가 가장 민감한 데이터다

"자막 클릭 시 음성 재생"(제안서 6.1)과 충돌하는데, 전체 원본 대신
**발화 단위 짧은 구간만** 따로 보관해서 해결한다. 용량도 줄고 노출도 줄어든다.

이 잡은 매일 1회 도는 것을 상정한다.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from teamflow.db import models as m
from teamflow.db import vocab

logger = logging.getLogger(__name__)


@dataclass
class PurgeReport:
    deleted_assets: list[int] = field(default_factory=list)
    freed_bytes: int = 0
    missing_files: list[int] = field(default_factory=list)
    failed: dict[int, str] = field(default_factory=dict)
    revoked_voiceprints: list[int] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failed

    def summary(self) -> str:
        return (
            f"오디오 {len(self.deleted_assets)}건 삭제 "
            f"({self.freed_bytes / 1024 / 1024:.1f}MB 확보), "
            f"성문 {len(self.revoked_voiceprints)}건 폐기, "
            f"실패 {len(self.failed)}건"
        )


#: `audio_assets.deleted_reason` 에 들어가는 값.
#:
#: 화면이 이걸 보고 다른 문구를 냅니다 — 만료는 정상이고 삭제 요청은 권리
#: 행사인데, 둘 다 "녹음이 끊겼습니다" 로 나가면 팀이 엉뚱한 대응을 합니다.
REASON_RETENTION_EXPIRED = "retention_expired"
REASON_USER_REQUEST = "user_request"
#: ② `raw_audio_retention` 을 **명시적으로 거부**한 사람의 원본.
#: 보존기간이 남았는지와 무관하게 전사가 끝나면 바로 지운다.
REASON_CONSENT_REFUSED = "consent_refused"


def _safe_remove(root: Path, storage_key: str) -> tuple[bool, int, str | None]:
    """저장 루트 밖의 경로는 건드리지 않는다.

    `storage_key` 가 DB에서 오므로 `../../etc/passwd` 같은 값이 들어올 수 있다.
    삭제 잡에서 경로 탈출은 곧 임의 파일 삭제다.

    **파일과 디렉터리를 둘 다 받는다.** 멀티트랙 녹음의 원본은 트랙 하나가
    청크 파일 수백 개이고, 보존 정책의 단위는 청크가 아니라 "원본 오디오"
    (docs/07 §2.4)이므로 `audio_assets` 한 행이 **트랙 디렉터리 하나**를
    가리킨다. 파일만 지울 줄 알면 그 행은 영원히 안 지워지는데, 잡은
    "이미 없음" 으로 읽고 **매일 성공한다.**

    디렉터리는 한 겹만 지운다 — 청크 디렉터리에는 하위 디렉터리가 없다.
    재귀 삭제(`rmtree`)를 쓰지 않는 이유는, `storage_key` 가 잘못됐을 때
    지우는 범위가 걷잡을 수 없어지기 때문이다.
    """
    try:
        target = (root / storage_key).resolve()
        root_resolved = root.resolve()
        if not target.is_relative_to(root_resolved):
            return False, 0, f"저장 루트 밖의 경로: {storage_key}"
        # 루트 자체를 가리키면 거부한다. `storage_key=""` 나 `"."` 이면
        # 저장소 전체가 대상이 된다.
        if target == root_resolved:
            return False, 0, f"저장 루트 자체는 지울 수 없습니다: {storage_key}"
        if not target.exists():
            return False, 0, None  # 이미 없음 — 실패는 아니다

        if target.is_dir():
            freed = 0
            for path in sorted(target.iterdir()):
                if path.is_dir():
                    return False, 0, f"하위 디렉터리가 있습니다: {path.name}"
            for path in sorted(target.iterdir()):
                freed += path.stat().st_size
                path.unlink()
            target.rmdir()
            return True, freed, None

        size = target.stat().st_size
        target.unlink()
        return True, size, None
    except OSError as exc:
        return False, 0, str(exc)


def purge_expired_audio(
    session: Session,
    *,
    storage_root: Path,
    now: datetime | None = None,
    dry_run: bool = False,
) -> PurgeReport:
    """보존기간이 지난 오디오 원본을 삭제한다.

    DB 레코드는 남기고 `deleted_at` 만 찍는다 — 삭제 이력 자체가 감사 대상이다.
    """
    now = now or datetime.now(UTC)
    report = PurgeReport()

    expired = session.scalars(
        select(m.AudioAsset).where(
            m.AudioAsset.retention_until <= now,
            m.AudioAsset.deleted_at.is_(None),
        )
    ).all()

    for asset in expired:
        if dry_run:
            report.deleted_assets.append(asset.id)
            report.freed_bytes += asset.bytes or 0
            continue

        removed, size, error = _safe_remove(storage_root, asset.storage_key)
        if error:
            report.failed[asset.id] = error
            logger.error("오디오 삭제 실패 asset=%s: %s", asset.id, error)
            continue

        if not removed:
            report.missing_files.append(asset.id)

        # 파일이 이미 없어도 레코드는 삭제 처리한다.
        # 그래야 다음 실행에서 다시 시도하지 않는다.
        asset.deleted_at = now
        asset.deleted_reason = REASON_RETENTION_EXPIRED
        report.deleted_assets.append(asset.id)
        report.freed_bytes += size or (asset.bytes or 0)

        session.add(
            m.AuditLog(
                project_id=None,
                actor_id=None,  # 시스템 작업
                action="audio_deleted",
                target=f"audio_assets/{asset.id}",
                before={"storage_key": asset.storage_key, "kind": asset.kind},
                after={"deleted_at": now.isoformat(), "reason": "retention_expired"},
                at=now,
            )
        )

    if not dry_run:
        session.flush()
    return report


def purge_unconsented_audio(
    session: Session,
    *,
    meeting_id: int,
    storage_root: Path,
    now: datetime | None = None,
    dry_run: bool = False,
) -> PurgeReport:
    """② 원본 보관을 **거부한 사람**의 녹음을 전사 직후 지운다.

    `docs/07` §2.3 이 이렇게 적어 뒀습니다.

        ② 거부 → 전사 완료 후 원본 즉시 삭제. 텍스트만 남김.

    ⚠️ 저장만 되고 **아무 효과가 없었습니다.** 거부한 사람의 원본이 동의한
    사람과 똑같이 30일 남았습니다. DB 에는 '거부' 로, 로비 화면에도 '거부'
    로 표시되면서 실제 처리는 동의한 것과 같았습니다 — **동의 기록 자체가
    사실과 다른 상태**이고, 감사·분쟁에서 가장 나쁜 형태입니다.

    ⚠️ **명시적 거부일 때만** 지웁니다. 아직 아무 답도 안 한 사람은
    거부한 것이 아닙니다 — 그 사람 것까지 지우면 그건 데이터 손실이고,
    되돌릴 방법이 없습니다. 여기서는 `측정 불가 ≠ 거부` 입니다.

    ⚠️ **전사가 끝난 뒤에** 부르세요. 그전에 지우면 회의록이 안 나옵니다.
    """
    now = now or datetime.now(UTC)
    report = PurgeReport()

    refused_users = select(m.RecordingConsent.user_id).where(
        m.RecordingConsent.meeting_id == meeting_id,
        m.RecordingConsent.consent_type == vocab.ConsentType.RAW_AUDIO_RETENTION,
        m.RecordingConsent.consented.is_(False),
    )
    refused_tracks = select(m.MeetingTrack.id).where(
        m.MeetingTrack.meeting_id == meeting_id,
        m.MeetingTrack.user_id.in_(refused_users),
    )
    assets = session.scalars(
        select(m.AudioAsset).where(
            m.AudioAsset.kind == "raw",
            m.AudioAsset.deleted_at.is_(None),
            m.AudioAsset.track_id.in_(refused_tracks),
        )
    ).all()

    for asset in assets:
        if dry_run:
            report.deleted_assets.append(asset.id)
            report.freed_bytes += asset.bytes or 0
            continue

        removed, size, error = _safe_remove(storage_root, asset.storage_key)
        if error:
            report.failed[asset.id] = error
            logger.error("동의 거부 오디오 삭제 실패 asset=%s: %s", asset.id, error)
            continue

        if not removed:
            report.missing_files.append(asset.id)

        asset.deleted_at = now
        asset.deleted_reason = REASON_CONSENT_REFUSED
        report.deleted_assets.append(asset.id)
        report.freed_bytes += size or (asset.bytes or 0)

        session.add(
            m.AuditLog(
                project_id=None,
                actor_id=None,  # 시스템 작업
                action="audio_deleted",
                target=f"audio_assets/{asset.id}",
                before={"storage_key": asset.storage_key, "kind": asset.kind},
                after={"deleted_at": now.isoformat(), "reason": REASON_CONSENT_REFUSED},
                at=now,
            )
        )

    if not dry_run:
        session.flush()
    if report.deleted_assets:
        logger.info(
            "meeting=%s 원본 보관 거부 %d건 삭제 (%.1fMB)",
            meeting_id,
            len(report.deleted_assets),
            report.freed_bytes / 1_048_576,
        )
    return report


def revoke_project_voiceprints(
    session: Session, project_id: int, *, now: datetime | None = None
) -> PurgeReport:
    """프로젝트가 끝나면 성문을 폐기한다.

    성문은 프로젝트 범위로 한정된 데이터다 (docs/07 §2.4).
    프로젝트가 끝났는데 남아 있으면 목적 외 보관이 된다.
    """
    now = now or datetime.now(UTC)
    report = PurgeReport()

    prints = session.scalars(
        select(m.Voiceprint).where(
            m.Voiceprint.project_id == project_id,
            m.Voiceprint.revoked_at.is_(None),
        )
    ).all()

    for vp in prints:
        vp.revoked_at = now
        # 임베딩 자체를 비운다. revoked 플래그만으로는 데이터가 남는다.
        vp.embedding = []
        report.revoked_voiceprints.append(vp.id)
        session.add(
            m.AuditLog(
                project_id=project_id,
                actor_id=None,
                action="voiceprint_revoked",
                target=f"voiceprints/{vp.id}",
                before={"user_id": vp.user_id},
                after={"revoked_at": now.isoformat(), "reason": "project_ended"},
                at=now,
            )
        )

    session.flush()
    return report


def revoke_user_data(
    session: Session,
    *,
    user_id: int,
    project_id: int,
    storage_root: Path,
    now: datetime | None = None,
) -> PurgeReport:
    """개인 삭제 요청 처리 (docs/07 P6).

    해당 사용자의 트랙 오디오와 성문을 지운다.
    전사 텍스트는 다른 참석자의 회의록이기도 하므로 남긴다 —
    발화 텍스트에서 화자 연결만 끊는 것은 별도 정책이다.
    """
    now = now or datetime.now(UTC)
    report = PurgeReport()

    # ⚠️ **이 프로젝트의 트랙만** 지웁니다 (결함 101).
    #
    # 예전에는 `MeetingTrack.user_id == user_id` 만 걸었습니다. `project_id`
    # 를 인자로 **받아 놓고 오디오 조회에는 안 쓴** 것입니다 — 바로 아래
    # 성문은 `project_id` 로 좁히고 있었는데 한쪽만 좁혔습니다.
    #
    # 그래서 A 프로젝트 설정에서 "내 녹음 원본과 성문을 지웁니다" 를 누르면
    # **B 팀·C 팀의 내 녹음 원본까지** 지워졌습니다. 되돌릴 수 없고, 그
    # 팀들은 통보도 못 받고, 감사 로그는 A 프로젝트에만 남습니다. 아직
    # 전사 전인 회의였다면 그 팀의 **회의록 자체가 안 만들어집니다.**
    #
    # 화면은 사람에게 이렇게 약속합니다 (`lib/privacy/deletion.ts`).
    #
    #     내 녹음 원본과 성문을 지웁니다.
    #     되돌릴 수 없습니다. 회의록의 발화 텍스트는 남습니다.
    #
    # 그 약속은 **이 프로젝트 안에서** 한 것입니다. 동의한 범위를 넘는
    # 삭제는 되돌릴 수 없으므로, 넓게 지우는 쪽으로 기울면 안 됩니다.
    track_ids = session.scalars(
        select(m.MeetingTrack.id)
        .join(m.Meeting, m.Meeting.id == m.MeetingTrack.meeting_id)
        .where(
            m.MeetingTrack.user_id == user_id,
            m.Meeting.project_id == project_id,
        )
    ).all()

    if track_ids:
        assets = session.scalars(
            select(m.AudioAsset).where(
                m.AudioAsset.track_id.in_(track_ids),
                m.AudioAsset.deleted_at.is_(None),
            )
        ).all()
        for asset in assets:
            removed, size, error = _safe_remove(storage_root, asset.storage_key)
            if error:
                report.failed[asset.id] = error
                continue
            if not removed:
                report.missing_files.append(asset.id)
            asset.deleted_at = now
            asset.deleted_reason = REASON_USER_REQUEST
            report.deleted_assets.append(asset.id)
            report.freed_bytes += size or (asset.bytes or 0)

    vp_report = revoke_project_voiceprints_for_user(session, user_id, project_id, now=now)
    report.revoked_voiceprints = vp_report.revoked_voiceprints

    session.add(
        m.AuditLog(
            project_id=project_id,
            actor_id=user_id,
            action="user_data_revoked",
            target=f"users/{user_id}",
            before={},
            after={
                "deleted_assets": len(report.deleted_assets),
                "revoked_voiceprints": len(report.revoked_voiceprints),
                "at": now.isoformat(),
            },
            at=now,
        )
    )
    session.flush()
    return report


def revoke_project_voiceprints_for_user(
    session: Session, user_id: int, project_id: int, *, now: datetime
) -> PurgeReport:
    report = PurgeReport()
    prints = session.scalars(
        select(m.Voiceprint).where(
            m.Voiceprint.user_id == user_id,
            m.Voiceprint.project_id == project_id,
            m.Voiceprint.revoked_at.is_(None),
        )
    ).all()
    for vp in prints:
        vp.revoked_at = now
        vp.embedding = []
        report.revoked_voiceprints.append(vp.id)
    return report
