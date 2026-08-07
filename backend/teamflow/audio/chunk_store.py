"""녹음 청크 파일 저장.

docs/03-시스템-아키텍처.md §3, docs/07-법적-윤리-요구사항.md P4

폰이 5초마다 청크 하나를 올린다. 회의가 끝나면 이어 붙여 트랙 원본이 된다.

## 설계 규칙

**경로에 사용자 입력이 들어가지 않는다.**
`meeting_id`, `track_id`, `seq` 세 정수로만 경로를 만든다. 파일명이나
`storage_key` 를 받아서 쓰면 `../` 하나로 임의 파일을 덮어쓸 수 있다.
(`jobs/retention.py` 에서 같은 문제를 이미 한 번 다뤘다.)

**쓰기는 원자적으로 한다.**
업로드 도중 연결이 끊기면 반쪽짜리 파일이 남는다. 서버는 그걸 정상 청크로
알고, 나중에 이어 붙이면 그 자리에서 오디오가 깨진다. 임시 파일에 다 쓰고
`os.replace` 로 바꾼다 — 같은 파일시스템 안에서는 원자적이다.

**같은 seq 를 다시 받으면 덮어쓴다.**
업로드 큐가 재시도하면 같은 청크가 두 번 올 수 있다. PUT 이라 멱등이어야
하고, 덮어쓰기가 곧 멱등이다.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

# 청크 하나의 상한. Opus 32kbps × 5초 ≈ 20KB 이므로 2MB 면 충분히 넉넉하다.
# 상한이 없으면 디스크가 찰 때까지 아무나 밀어넣을 수 있다.
MAX_CHUNK_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class ChunkStore:
    """청크 파일의 위치를 정하고 읽고 쓴다."""

    root: Path

    def track_dir(self, meeting_id: int, track_id: int) -> Path:
        # int 로 강제한다. 문자열이 들어오면 여기서 터지는 게 맞다.
        return self.root / "meetings" / str(int(meeting_id)) / "tracks" / str(int(track_id))

    def storage_key(self, meeting_id: int, track_id: int) -> str:
        """`audio_assets.storage_key` 에 넣을 값. 루트 기준 상대 경로.

        보존기간 삭제(`jobs/retention.py`)가 이 문자열로 지울 대상을
        찾습니다. 절대 경로를 넣으면 루트가 바뀌었을 때 **엉뚱한 곳을
        지우거나 아무것도 못 지웁니다** — 둘 다 조용합니다.

        트랙 하나가 한 자산입니다. 청크 파일 하나하나를 등록하면 1시간
        회의 한 트랙에 720행이 생기는데, 보존 정책의 단위는 청크가 아니라
        "원본 오디오" 입니다 (docs/07 §2.4).
        """
        return f"meetings/{int(meeting_id)}/tracks/{int(track_id)}"

    def delete_track(self, meeting_id: int, track_id: int) -> int:
        """트랙의 청크를 전부 지운다. 지운 바이트를 돌려준다.

        보존기간이 지난 원본을 실제로 없애는 유일한 경로입니다. 이게
        없어서 `ChunkStore` 에는 **삭제 메서드 자체가 없었고**, 결국
        음성이 무기한 남았습니다.

        디렉터리가 없어도 오류가 아닙니다 — 이미 지워진 것뿐입니다.
        """
        directory = self.track_dir(meeting_id, track_id)
        if not directory.is_dir():
            return 0

        freed = 0
        for path in sorted(directory.iterdir()):
            if path.is_file():
                freed += path.stat().st_size
                path.unlink()
        # 빈 디렉터리를 남기지 않는다. 남기면 다음 실행에서 "있다" 로
        # 보이고, 사람이 저장소를 들여다볼 때 아직 있는 줄 안다.
        directory.rmdir()
        return freed

    def chunk_path(self, meeting_id: int, track_id: int, seq: int) -> Path:
        if seq < 0:
            raise ValueError("seq 는 0 이상이어야 합니다")
        # 6자리 0채움 — 파일명 정렬이 곧 seq 정렬이 된다
        return self.track_dir(meeting_id, track_id) / f"{int(seq):06d}.chunk"

    def write(self, meeting_id: int, track_id: int, seq: int, data: bytes) -> Path:
        """청크를 원자적으로 쓴다. 같은 seq 면 덮어쓴다."""
        if len(data) == 0:
            raise ValueError("빈 청크는 저장하지 않습니다")
        if len(data) > MAX_CHUNK_BYTES:
            raise ValueError(f"청크가 너무 큽니다 ({len(data)} > {MAX_CHUNK_BYTES})")

        path = self.chunk_path(meeting_id, track_id, seq)
        path.parent.mkdir(parents=True, exist_ok=True)

        # 임시 이름에 pid 를 넣어 동시 업로드가 서로를 밟지 않게 한다
        tmp = path.with_suffix(f".part.{os.getpid()}")
        tmp.write_bytes(data)
        os.replace(tmp, path)
        return path

    def stored_seqs(self, meeting_id: int, track_id: int) -> list[int]:
        """디스크에 실제로 있는 seq 목록.

        DB 가 아니라 **파일시스템**을 본다. DB 커밋과 파일 쓰기 사이에서
        죽으면 둘이 어긋나는데, 이때 없는 파일을 "가지고 있다"고 답하면
        클라이언트가 다시 올릴 기회를 잃는다. 재개 판단은 실물 기준이어야 한다.
        """
        directory = self.track_dir(meeting_id, track_id)
        if not directory.is_dir():
            return []
        seqs = []
        for entry in directory.glob("*.chunk"):
            try:
                seqs.append(int(entry.stem))
            except ValueError:
                continue
        return sorted(seqs)

    def read(self, meeting_id: int, track_id: int, seq: int) -> bytes:
        return self.chunk_path(meeting_id, track_id, seq).read_bytes()

    def total_bytes(self, meeting_id: int, track_id: int) -> int:
        directory = self.track_dir(meeting_id, track_id)
        if not directory.is_dir():
            return 0
        return sum(p.stat().st_size for p in directory.glob("*.chunk"))

    def concatenate(self, meeting_id: int, track_id: int, target: Path) -> int:
        """청크를 seq 순서로 이어 붙인다.

        ⚠️ **이건 공백을 메우지 않는다.** 중간에 빠진 seq 가 있으면 그 자리가
        그냥 사라지고 뒤가 앞당겨진다. 무음 패딩은 타임라인 정보가 있어야
        가능하므로 상위 계층에서 처리한다 (docs/04 §2.6).
        여기서는 **빠진 seq 를 그대로 돌려주는 것**까지만 한다.
        """
        target.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        tmp = target.with_suffix(f".part.{os.getpid()}")
        with tmp.open("wb") as out:
            for seq in self.stored_seqs(meeting_id, track_id):
                out.write(self.read(meeting_id, track_id, seq))
                written += 1
        os.replace(tmp, target)
        return written


def missing_seqs(stored: list[int], expected_count: int) -> list[int]:
    """0..expected_count-1 중 없는 seq. 타임라인 공백 계산의 입력이다."""
    have = set(stored)
    return [seq for seq in range(expected_count) if seq not in have]
