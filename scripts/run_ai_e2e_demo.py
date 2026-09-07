#!/usr/bin/env python3
"""실기기 AI 파이프라인(Qwen3-ASR 1.7B + Qwen2.5-LLM) E2E 회의 처리 시연 스크립트.

실제 한국어 음성 데이터를 입력받아:
1. Qwen3-ASR (Qwen/Qwen3-ASR-1.7B-hf)를 통해 음성 전사(STT)를 수행하고
2. Qwen2.5-LLM (Qwen/Qwen2.5-1.5B-Instruct)을 통해
   회의록 요약, 안건, 결정사항 및 업무 후보를 추출하며
3. 결과를 demo.db 에 영구 적재하여 모던 SPA 웹 UI에서 즉시 검토/승인/칸반 연동할 수 있도록 합니다.

사용법:
    .venv\Scripts\python -X utf8 scripts/run_ai_e2e_demo.py
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path

# HF symlink 경고 억제
os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"

# backend 모듈 경로 추가
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import numpy as np
import soundfile as sf
import torch
from sqlalchemy import func, select

from teamflow.audio.chunk_store import ChunkStore
from teamflow.config import get_settings
from teamflow.db import models as m
from teamflow.db.session import session_scope
from teamflow.meeting.llm import TransformersLLMClient
from teamflow.meeting.resolve import TeamMemberName
from teamflow.pipeline.asr import Qwen3Transcriber
from teamflow.pipeline.meeting_pipeline import (
    LoadedTrack,
    NullProgress,
    PipelineResult,
    process_meeting,
)


class MultiAudioLoader:
    def __init__(self, tracks: list[tuple[int, int, np.ndarray, int]]):
        self.tracks = tracks

    def load(self, meeting_id: int) -> list[LoadedTrack]:
        return [
            LoadedTrack(
                track_id=track_id,
                user_id=user_id,
                samples=samples,
                sample_rate=sample_rate,
                started_at_offset_sec=0.0,
                coverage=1.0,
                usable=True,
            )
            for track_id, user_id, samples, sample_rate in self.tracks
        ]


class LLMAnalyzerAdapter:
    def __init__(self, client: TransformersLLMClient):
        self.client = client

    def analyze(self, utterances, *, prior_decisions=None, open_tasks=None):
        from teamflow.meeting.schema import format_transcript

        transcript = format_transcript(utterances)
        print("\n=== [LLM 입력용 발화 전사본] ===")
        print(transcript.strip())
        return self.client.analyze_meeting(
            transcript,
            prior_decisions=prior_decisions,
            open_tasks=open_tasks,
        )


def _parse_deadline(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = date.fromisoformat(value)
    except (ValueError, TypeError):
        return None
    return datetime.combine(parsed, time.min, tzinfo=UTC)


def _span(session, utterance_ids: list[int]) -> tuple[int, int]:
    if not utterance_ids:
        return (0, 0)
    row = session.execute(
        select(func.min(m.Utterance.start_ms), func.max(m.Utterance.end_ms)).where(
            m.Utterance.id.in_(utterance_ids)
        )
    ).one()
    return (int(row[0] or 0), int(row[1] or 0))


def ensure_test_audio(audio_path: Path) -> None:
    if audio_path.exists():
        return
    import subprocess
    print(f"[*] 오디오 파일이 없어 Windows 음성 합성기로 자동 생성합니다: {audio_path.name}")
    ps_script = (
        'Add-Type -AssemblyName System.Speech;'
        '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer;'
        f'$synth.SetOutputToWaveFile("{audio_path.as_posix()}");'
        '$synth.Speak("안녕하세요 로그인 API는 이번 주 금요일까지 개발하기로 하겠습니다");'
        '$synth.Dispose()'
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps_script], check=True)
    print(f"[*] 오디오 파일 생성 완료: {audio_path.name}")


def run_e2e_demo():
    print("=" * 60)
    print("TeamFlow AI — 실기기 E2E 회의 분석 시연 러너")
    if torch.cuda.is_available():
        print(f"디바이스: {torch.cuda.get_device_name(0)} (CUDA 활성화)")
    else:
        print("디바이스: CPU")
    print("=" * 60)

    settings = get_settings()
    chunk_store = ChunkStore(root=settings.audio_storage_root)

    # 1. DB 준비 및 사용자/프로젝트 확보
    with session_scope() as session:
        project = session.scalars(select(m.Project).order_by(m.Project.id)).first()
        if not project:
            print("[오류] 등록된 프로젝트가 없습니다.")
            print("       'python scripts/seed_demo.py'를 먼저 실행하세요.")
            return

        minsu = session.scalars(select(m.User).where(m.User.email == "minsu@example.com")).first()
        haneul = session.scalars(select(m.User).where(m.User.email == "haneul@example.com")).first()
        if not minsu or not haneul:
            print("[오류] 시연용 계정(minsu, haneul)을 찾을 수 없습니다.")
            print("       'python scripts/seed_demo.py'를 먼저 실행하세요.")
            return

        now = datetime.now(UTC)
        demo_meeting = session.scalars(
            select(m.Meeting).where(
                m.Meeting.project_id == project.id,
                m.Meeting.title == "실기기 AI 분석 시연 회의 (2주차)",
            )
        ).first()

        if not demo_meeting:
            demo_meeting = m.Meeting(
                project_id=project.id,
                title="실기기 AI 분석 시연 회의 (2주차)",
                status="recording",
                capture_mode="multitrack",
                started_by=minsu.id,
                started_at=now - timedelta(minutes=15),
            )
            session.add(demo_meeting)
            session.flush()

        meeting_id = demo_meeting.id

        # 트랙 2개 등록 (김민수: 1, 이하늘: 2)
        t1 = session.scalars(
            select(m.MeetingTrack).where(
                m.MeetingTrack.meeting_id == meeting_id,
                m.MeetingTrack.user_id == minsu.id,
            )
        ).first()
        if not t1:
            t1 = m.MeetingTrack(
                meeting_id=meeting_id,
                user_id=minsu.id,
                device_label="Minsu Mic (RTX Audio)",
                status="completed",
                started_at=now - timedelta(minutes=15),
                ended_at=now - timedelta(minutes=5),
            )
            session.add(t1)
            session.flush()

        t2 = session.scalars(
            select(m.MeetingTrack).where(
                m.MeetingTrack.meeting_id == meeting_id,
                m.MeetingTrack.user_id == haneul.id,
            )
        ).first()
        if not t2:
            t2 = m.MeetingTrack(
                meeting_id=meeting_id,
                user_id=haneul.id,
                device_label="Haneul Headset",
                status="completed",
                started_at=now - timedelta(minutes=15),
                ended_at=now - timedelta(minutes=5),
            )
            session.add(t2)
            session.flush()

        track1_id = t1.id
        track2_id = t2.id

    print(f"\n[1/4] 회의 생성 및 트랙 등록 완료: 회의 #{meeting_id} ('{demo_meeting.title}')")
    print(f"      - 트랙 1: #{track1_id} (발화자: 김민수)")
    print(f"      - 트랙 2: #{track2_id} (발화자: 이하늘)")

    # 2. 오디오 데이터 준비 및 청크 보관소 기록
    audio_path = Path("test_speech.wav").resolve()
    ensure_test_audio(audio_path)

    raw_data = audio_path.read_bytes()
    chunk_store.write(meeting_id, track1_id, 0, raw_data)
    chunk_store.write(meeting_id, track2_id, 0, raw_data)
    print(f"[2/4] 오디오 청크 보관소 기록 완료: {chunk_store.track_dir(meeting_id, track1_id)}")

    samples, sample_rate = sf.read(str(audio_path))
    if samples.ndim > 1:
        samples = samples.mean(axis=1)

    track1_samples = samples
    track2_samples = np.roll(samples, int(sample_rate * 2.0))

    loader = MultiAudioLoader([
        (track1_id, minsu.id, track1_samples, sample_rate),
        (track2_id, haneul.id, track2_samples, sample_rate),
    ])

    # 3. 실기기 AI 모델 로드 및 회의 분석 파이프라인 가동
    print("\n[3/4] 실기기 AI 파이프라인 로드 및 회의 분석 시작...")
    print("      - ASR: Qwen/Qwen3-ASR-1.7B-hf (GPU FP16)")
    print("      - LLM: Qwen/Qwen2.5-1.5B-Instruct (GPU FP16)")

    transcriber = Qwen3Transcriber(model_id="Qwen/Qwen3-ASR-1.7B-hf")
    llm_client = TransformersLLMClient(model_id="Qwen/Qwen2.5-1.5B-Instruct")
    analyzer = LLMAnalyzerAdapter(llm_client)

    members = [
        TeamMemberName(user_id=minsu.id, name=minsu.name),
        TeamMemberName(user_id=haneul.id, name=haneul.name),
    ]

    meeting_date = date.today()

    result: PipelineResult = process_meeting(
        meeting_id=meeting_id,
        loader=loader,
        transcriber=transcriber,
        analyzer=analyzer,
        members=members,
        meeting_date=meeting_date,
        progress=NullProgress(),
    )

    if not result.ok or not result.validation:
        print(f"\n[실패] 파이프라인 실행 중 오류가 발생했습니다: {result.error}")
        return

    # 4. DB에 결과 영구 적재
    print("\n[4/4] AI 분석 결과 DB 영구 적재 중...")
    val = result.validation
    with session_scope() as session:
        m_row = session.get(m.Meeting, meeting_id)
        if not m_row:
            return

        # 기존 발화 및 후보 초기화 (재실행 보장)
        for model in (m.Utterance, m.MeetingTaskCandidate, m.Decision, m.MeetingEvent):
            for row in session.scalars(select(model).where(model.meeting_id == meeting_id)).all():
                session.delete(row)
        session.flush()

        # 발화 등록
        utterance_ids: list[int] = []
        for seg in result.segments:
            u = m.Utterance(
                meeting_id=meeting_id,
                speaker_id=seg.user_id,
                track_id=seg.track_id,
                start_ms=seg.start_ms,
                end_ms=seg.end_ms,
                text=seg.text,
                speaker_source=seg.speaker_source,
                speaker_confidence=seg.confidence,
                is_overlap=seg.is_overlap,
            )
            session.add(u)
            session.flush()
            utterance_ids.append(u.id)

        # 회의 요약 및 상태 업데이트
        m_row.summary = val.summary
        m_row.next_agenda = list(val.next_agenda)
        m_row.duration_sec = 600
        m_row.status = "needs_review"  # 사람이 검토할 수 있도록 전환

        # 업무 후보 등록
        for c in val.candidates:
            matched_evidence = [
                utterance_ids[idx] for idx in c.evidence_utterance_ids if idx < len(utterance_ids)
            ]
            if not matched_evidence and utterance_ids:
                matched_evidence = [utterance_ids[0]]

            deadline_str = c.deadline.value.isoformat() if c.deadline.value else None
            deadline_dt = _parse_deadline(deadline_str)
            cand = m.MeetingTaskCandidate(
                meeting_id=meeting_id,
                title=c.title,
                assignee_hint=c.assignee_hint,
                assignee_id=c.assignee.user_id,
                deadline=deadline_dt,
                confidence=round(float(c.overall_confidence), 3),
                evidence_utterance_ids=matched_evidence,
                warnings=list(c.warnings),
                review_status="pending",
            )
            session.add(cand)

        # 결정 사항 등록
        for content, evidence, supersedes in val.decisions:
            matched_evidence = [
                utterance_ids[idx] for idx in evidence if idx < len(utterance_ids)
            ]
            dec = m.Decision(
                project_id=project.id,
                meeting_id=meeting_id,
                content=content,
                evidence_utterance_ids=matched_evidence,
                supersedes_id=supersedes,
            )
            session.add(dec)

        # 미해결 사안 등록
        for content, evidence in val.unresolved_issues:
            matched_evidence = [
                utterance_ids[idx] for idx in evidence if idx < len(utterance_ids)
            ]
            start_ms, end_ms = _span(session, matched_evidence)
            ev = m.MeetingEvent(
                meeting_id=meeting_id,
                event_type="unresolved_issue",
                severity="info",
                start_ms=start_ms,
                end_ms=end_ms,
                evidence_utterance_ids=matched_evidence,
                detail={"content": content},
            )
            session.add(ev)

        # 5. 발화 유형 분류, 기여 이벤트 발행 및 비효율 관찰 탐지 (회의 기여도 다리 연결)
        from teamflow.services.meeting_contribution_service import (
            forget_meeting_events,
            record_meeting,
        )

        forget_meeting_events(session, meeting_id)
        contrib_info = record_meeting(session, m_row)

        # 6. 회의록 및 최종 보고서 자동 갱신
        from teamflow.db.vocab import ReportType
        from teamflow.services.report_service import generate_minutes, generate_period

        minutes_report = generate_minutes(session, meeting_id)
        final_report = generate_period(session, project.id, ReportType.FINAL)

        session.commit()

    print("\n" + "=" * 60)
    print("🎉 실기기 AI 회의 분석 및 DB 적재가 성공적으로 완료되었습니다!")
    print("=" * 60)
    print(f"• 회의 ID: #{meeting_id}")
    print(f"• 회의 제목: {demo_meeting.title}")
    print("• 상태: needs_review (사람 검토 대기 중)")
    print(f"• 회의 요약:\n  {val.summary}")
    print("\n• 발화 유형 분류 및 기여도 이벤트 연동:")
    print(f"  - 발화 기여 이벤트: {contrib_info['utterance_events']}건")
    print(f"  - 참석 이벤트: {contrib_info['attendance']}명")
    print(f"  - 발화 유형 분포: {contrib_info['labels']}")
    print(f"\n• 추출된 업무 후보 ({len(val.candidates)}건):")
    for c in val.candidates:
        assignee_str = (
            c.assignee.matched_name or f"미지정 (힌트: {c.assignee_hint or ''})"
        )
        print(f"  - [{c.title}] 담당: {assignee_str}, 마감: {c.deadline.value}")
    print(f"\n• 결정사항 ({len(val.decisions)}건):")
    for content, _, _ in val.decisions:
        print(f"  - {content}")

    print("\n• 보고서 자동 생성 완료:")
    print(f"  - 회의록: #{minutes_report.id} ({minutes_report.content.get('title')})")
    print(f"  - 최종 보고서: #{final_report.id} ({final_report.content.get('title')})")

    if torch.cuda.is_available():
        peak_gb = torch.cuda.max_memory_allocated() / (1024**3)
        print(f"\n• 피크 VRAM: {peak_gb:.2f} GB (RTX 4090 예산 24GB 내)")

    print("\n👉 브라우저에서 바로 확인하기:")
    print(f"   검토 화면: http://127.0.0.1:8811/app/meeting/{meeting_id}/review")
    print("   홈 화면  : http://127.0.0.1:8811/app/")
    print(f"   보고서   : http://127.0.0.1:8811/reports.html?project={project.id}")
    print("=" * 60)


if __name__ == "__main__":
    run_e2e_demo()
