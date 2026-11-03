"""새 검사 폴더에서만 실제 ASR/LLM과 HTTP 업무 승인 흐름을 실행합니다.

합성 한국어 음성 두 파일을 --audio에 지정합니다. 기존 DB나 오디오는 쓰지 않습니다.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import wave
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--audio", type=Path, nargs=2, required=True)
    parser.add_argument("--llm-model", default="Qwen/Qwen2.5-3B-Instruct")
    args = parser.parse_args()
    root = args.workspace.resolve()
    root.mkdir(parents=True, exist_ok=False)
    os.environ.update(
        DATABASE_URL=f"sqlite:///{(root / 'verification.db').as_posix()}",
        AUDIO_STORAGE_ROOT=str(root / "audio"), DEBUG="false",
        ASR_BACKEND="qwen3", LLM_BACKEND="transformers", LLM_MODEL=args.llm_model,
        LOCAL_PROCESSING="false", PYTHONUTF8="1",
    )
    import numpy as np
    import soundfile as sf
    import torch
    import torchaudio.functional as audio_functions
    from fastapi.testclient import TestClient
    from sqlalchemy import select

    from teamflow.api.main import app
    from teamflow.db import models as m
    from teamflow.db.session import get_engine, session_scope
    from teamflow.tasks import dispatch
    from teamflow.tasks.meeting_tasks import process_meeting_sync

    m.Base.metadata.create_all(get_engine())
    enqueued = []
    dispatch.enqueue_meeting_processing = enqueued.append
    names = ["김민수", "이하늘"]
    base = datetime(2026, 11, 2, 1, 0, tzinfo=UTC)
    with TestClient(app) as owner, TestClient(app) as teammate:
        clients = [owner, teammate]
        for index, client in enumerate(clients):
            response = client.post("/api/auth/signup", json={
                "name": names[index], "email": f"synthetic-{index}@example.test",
                "password": "synthetic-test-password",
            })
            assert response.status_code == 201, response.text
        response = owner.post("/api/projects", json={"title": "실제 AI 합성 음성 검증"})
        assert response.status_code == 201, response.text
        project = response.json()
        pid = project["project_id"]
        response = teammate.post("/api/projects/join", json={"invite_code": project["invite_code"]})
        assert response.status_code == 200, response.text
        response = owner.post(f"/api/projects/{pid}/meetings", json={"title": "실제 모델 검증"})
        assert response.status_code == 201, response.text
        mid = response.json()["meeting_id"]
        # 회의일을 고정해 '다음 주 화요일'과 '가장 가까운 화요일'을 구별합니다.
        with session_scope() as session:
            session.get(m.Meeting, mid).started_at = base
        for client in clients:
            for kind in ("recording", "raw_audio_retention"):
                response = client.post(f"/api/meetings/{mid}/consent", json={
                    "consent_type": kind, "consented": True,
                })
                assert response.status_code == 200, response.text
        offset = 0.0
        for index, (client, path) in enumerate(zip(clients, args.audio, strict=True)):
            samples, sample_rate = sf.read(path, dtype="float32")
            if samples.ndim > 1:
                samples = samples.mean(axis=1)
            samples = audio_functions.resample(torch.from_numpy(samples), sample_rate, 16000).numpy()
            started = base + timedelta(seconds=offset)
            ended = started + timedelta(seconds=len(samples) / 16000)
            joined = client.post(f"/api/meetings/{mid}/tracks", json={
                "started_at": started.isoformat(), "device_label": f"합성 트랙 {index + 1}",
                "sample_rate": 16000,
            })
            assert joined.status_code == 201, joined.text
            tid = joined.json()["track_id"]
            for seq, start in enumerate(range(0, len(samples), 80000)):
                part = samples[start:start + 80000]
                payload = io.BytesIO()
                with wave.open(payload, "wb") as wav:
                    wav.setnchannels(1)
                    wav.setsampwidth(2)
                    wav.setframerate(16000)
                    wav.writeframes((np.clip(part, -1, 1) * 32767).astype("<i2").tobytes())
                response = client.put(f"/api/meetings/{mid}/tracks/{tid}/chunks/{seq}",
                    content=payload.getvalue(), headers={"X-Client-At-Ms": str(int(
                        (started + timedelta(seconds=(start + len(part)) / 16000)).timestamp() * 1000
                    ))})
                assert response.status_code == 200, response.text
            response = client.post(f"/api/meetings/{mid}/tracks/{tid}/complete", json={
                "ended_at": ended.isoformat(), "coverage": 1.0, "total_gap_ms": 0,
                "timeslice_ms": 5000,
            })
            assert response.status_code == 200, response.text
            offset += len(samples) / 16000 + 0.2
        assert enqueued == [mid], enqueued
        print("실제 API 업로드 완료, 실제 ASR/LLM 처리 시작", flush=True)
        processed = process_meeting_sync(mid)
        print("처리 결과", processed, flush=True)
        candidates = owner.get(f"/api/meetings/{mid}/candidates").json()
        assert len(candidates) == 2, candidates
        expected = {"로그인 API 구현": ("2026-11-06", 1),
                    "회원가입 화면 구현": ("2026-11-10", 2)}
        for title, (deadline, assignee) in expected.items():
            found = [candidate for candidate in candidates
                     if "".join(title.split()) == "".join(candidate["title"].split())]
            assert len(found) == 1, candidates
            assert (found[0]["deadline"], found[0]["assignee_id"]) == (deadline, assignee)
        assert all(candidate["evidence_utterance_ids"] for candidate in candidates), candidates
        with session_scope() as session:
            assert session.scalars(select(m.Task)).all() == []
            assert session.get(m.Meeting, mid).status == "needs_review"
            transcript = " ".join(session.scalars(select(m.Utterance.text)).all())
            for phrase in ("김민수", "이하늘", "로그인 API 구현", "회원가입 화면 구현", "다음 주 화요일"):
                assert phrase.replace(" ", "") in transcript.replace(" ", ""), transcript
        response = owner.post(f"/api/meetings/{mid}/candidates/review", json={
            "items": [{"candidate_id": candidate["id"], "approve": True}
                      for candidate in candidates],
        })
        assert response.status_code == 200, response.text
        board = owner.get(f"/api/projects/{pid}/tasks").json()
        scores = owner.get(f"/api/projects/{pid}/contributions")
        assert scores.status_code == 200, scores.text
        with session_scope() as session:
            tasks = session.scalars(select(m.Task).where(m.Task.project_id == pid)).all()
            assert len(tasks) == len(candidates)
            assert all(task.origin_candidate_id for task in tasks)
        result = {"real_models": True, "project_id": pid, "meeting_id": mid,
                  "candidates": candidates, "board": board, "contributions": scores.json()}
        (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2),
                                           encoding="utf-8")
        print(f"PASS: 실제 음성 → 후보 {len(candidates)}건 → 승인 → 칸반 → 기여도", flush=True)


if __name__ == "__main__":
    main()
