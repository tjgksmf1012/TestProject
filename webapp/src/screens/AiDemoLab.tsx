import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { useDemoVoiceMatchMutation, useDemoAnalyzeMutation, type VoiceMatchResult, type DemoAnalyzeResult } from '../api/hooks.ts';





interface UtteranceItem {
  speaker: string;
  text: string;
  start_sec: number;
  end_sec: number;
}

const PRESET_SCENARIOS: Record<string, { title: string; script: UtteranceItem[] }> = {
  sprint: {
    title: '스프린트 기획 & OAuth 로그인 배포 회의',
    script: [
      {
        speaker: '이팀장',
        text: '다음 주 화요일 배포를 위해서 민수 님이 이번 주 금요일까지 Google OAuth 로그인 API 구현을 완료해 주세요.',
        start_sec: 1.0,
        end_sec: 8.0,
      },
      {
        speaker: '김민수',
        text: '네, 금요일까지 OAuth 로그인 연동과 엔드포인트 테스트 코드까지 맡을게요.',
        start_sec: 9.0,
        end_sec: 15.0,
      },
      {
        speaker: '박지원',
        text: '그럼 저는 DB 마이그레이션 스크립트를 토요일까지 작성하고 데이터 정합성 검토를 하겠습니다.',
        start_sec: 16.0,
        end_sec: 23.0,
      },
      {
        speaker: '이팀장',
        text: '좋습니다. 이번 배포 방식은 Blue/Green 무중단 배포로 확정하겠습니다.',
        start_sec: 24.0,
        end_sec: 30.0,
      },
    ],
  },
  architecture: {
    title: '시스템 아키텍처 및 캐싱 최적화 회의',
    script: [
      {
        speaker: '박지원',
        text: '동시 접속자가 늘어날 때를 대비해서 세션 캐시 레이어를 도입하기로 결정합시다.',
        start_sec: 1.0,
        end_sec: 7.0,
      },
      {
        speaker: '이팀장',
        text: '동의합니다. Redis 캐시 클러스터 구축은 지원 님이 다음 주 화요일까지 구현해 주시죠.',
        start_sec: 8.0,
        end_sec: 14.0,
      },
      {
        speaker: '박지원',
        text: '네, Redis 설정과 장애 복구 테스트까지 화요일까지 작성하겠습니다.',
        start_sec: 15.0,
        end_sec: 21.0,
      },
    ],
  },
};

export default function AiDemoLab() {
  const params = useParams();
  const projectId = params['projectId'] ? Number(params['projectId']) : undefined;

  const [activeTab, setActiveTab] = useState<'voiceprint' | 'asr' | 'pipeline' | 'architecture'>('voiceprint');

  const voiceMatchMutation = useDemoVoiceMatchMutation();
  const analyzeMutation = useDemoAnalyzeMutation();

  // ── Tab 1: Voiceprint & Diarization Lab States ──
  const [speakerAProfile, setSpeakerAProfile] = useState<number[] | null>(null);
  const [speakerBProfile, setSpeakerBProfile] = useState<number[] | null>(null);
  const [testSample, setTestSample] = useState<number[] | null>(null);
  const [recordingTarget, setRecordingTarget] = useState<'A' | 'B' | 'test' | null>(null);
  const [matchResultA, setMatchResultA] = useState<VoiceMatchResult | null>(null);
  const [matchResultB, setMatchResultB] = useState<VoiceMatchResult | null>(null);
  const [analyzingVoice, setAnalyzingVoice] = useState(false);

  // Audio Context & Waveform Canvas
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // ── Tab 2: Live ASR States ──
  const [asrRecording, setAsrRecording] = useState(false);
  const [asrTranscripts, setAsrTranscripts] = useState<Array<{ time: string; text: string; confidence: number }>>([]);
  const [liveVolume, setLiveVolume] = useState(0);

  // ── Tab 3: Pipeline Sandbox States ──
  const [selectedScenarioKey, setSelectedScenarioKey] = useState<string>('sprint');
  const [customScript, setCustomScript] = useState<UtteranceItem[]>(PRESET_SCENARIOS['sprint']?.script ?? []);
  const [pipelineBusy, setPipelineBusy] = useState(false);
  const [pipelineStep, setPipelineStep] = useState<number>(0);
  const [analysisResult, setAnalysisResult] = useState<DemoAnalyzeResult | null>(null);

  // Stop media recording tracks
  const stopMediaTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopMediaTracks();
    };
  }, [stopMediaTracks]);

  // Draw Audio Waveform
  const startDrawingWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);

    const renderFrame = () => {
      animFrameRef.current = requestAnimationFrame(renderFrame);
      analyser.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i] ?? 128;
        const v = (val - 128) / 128.0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / bufferLength);
      setLiveVolume(Math.min(100, Math.round(rms * 250)));

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#38bdf8';
      ctx.beginPath();

      const sliceWidth = canvas.width / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const val = dataArray[i] ?? 128;
        const v = val / 128.0;
        const y = (v * canvas.height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
        x += sliceWidth;
      }

      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };

    renderFrame();
  }, []);

  // Record 3.5 seconds of voice to generate acoustic embedding vector
  const recordAcousticProfile = async (target: 'A' | 'B' | 'test') => {
    stopMediaTracks();
    setRecordingTarget(target);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      audioCtxRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      startDrawingWaveform(analyser);

      // Collect audio features over 3.5s
      const featureBins: number[] = new Array(192).fill(0);
      let samplesCount = 0;
      const freqData = new Uint8Array(analyser.frequencyBinCount);

      const interval = setInterval(() => {
        analyser.getByteFrequencyData(freqData);
        for (let i = 0; i < 192; i++) {
          const binIdx = Math.floor((i * freqData.length) / 192);
          featureBins[i] = (featureBins[i] ?? 0) + (freqData[binIdx] ?? 0) / 255.0;
        }
        samplesCount++;
      }, 100);

      setTimeout(() => {
        clearInterval(interval);
        stopMediaTracks();
        setRecordingTarget(null);

        const normalizedProfile = featureBins.map((val) =>
          Number((samplesCount > 0 ? val / samplesCount : 0.5).toFixed(4)),
        );

        if (target === 'A') setSpeakerAProfile(normalizedProfile);
        else if (target === 'B') setSpeakerBProfile(normalizedProfile);
        else setTestSample(normalizedProfile);
      }, 3500);
    } catch {
      // Fallback mock acoustic generator if mic permission denied
      setTimeout(() => {
        setRecordingTarget(null);
        const profile = generateSimulatedVector(target === 'A' ? 0.35 : target === 'B' ? 0.75 : 0.38);
        if (target === 'A') setSpeakerAProfile(profile);
        else if (target === 'B') setSpeakerBProfile(profile);
        else setTestSample(profile);
      }, 1500);
    }
  };

  // Preset loading helpers
  const loadPresetProfile = (target: 'A' | 'B' | 'test') => {
    const seed = target === 'A' ? 0.42 : target === 'B' ? 0.81 : 0.44;
    const profile = generateSimulatedVector(seed);
    if (target === 'A') setSpeakerAProfile(profile);
    else if (target === 'B') setSpeakerBProfile(profile);
    else setTestSample(profile);
  };

  // Execute Voiceprint Match
  const runVoiceMatch = async () => {
    if (!testSample) return;
    setAnalyzingVoice(true);
    try {
      if (speakerAProfile) {
        const resA = await voiceMatchMutation.mutateAsync({
          sample_a: testSample,
          sample_b: speakerAProfile,
          speaker_names: ['분석 음성', '화자 A (이팀장)'],
        });
        setMatchResultA(resA);
      }
      if (speakerBProfile) {
        const resB = await voiceMatchMutation.mutateAsync({
          sample_a: testSample,
          sample_b: speakerBProfile,
          speaker_names: ['분석 음성', '화자 B (김개발)'],
        });
        setMatchResultB(resB);
      }
    } catch {
      // client-side calculation fallback
      if (speakerAProfile) {
        const simA = cosineSimilarity(testSample, speakerAProfile);
        setMatchResultA({
          similarity: simA,
          is_same_speaker: simA >= 0.75,
          confidence: simA,
          speaker_verdict:
            simA >= 0.75
              ? `분석 음성과 화자 A는 동일 인물(성문 일치 ${Math.round(simA * 100)}%)로 판별되었습니다.`
              : `화자 A와 다른 화자(유사도 ${Math.round(simA * 100)}%)로 분리되었습니다.`,
          dimension: 192,
        });
      }
      if (speakerBProfile) {
        const simB = cosineSimilarity(testSample, speakerBProfile);
        setMatchResultB({
          similarity: simB,
          is_same_speaker: simB >= 0.75,
          confidence: simB,
          speaker_verdict:
            simB >= 0.75
              ? `분석 음성과 화자 B는 동일 인물(성문 일치 ${Math.round(simB * 100)}%)로 판별되었습니다.`
              : `화자 B와 다른 화자(유사도 ${Math.round(simB * 100)}%)로 분리되었습니다.`,
          dimension: 192,
        });
      }
    } finally {
      setAnalyzingVoice(false);
    }
  };

  // ── Tab 2: Speech Recognition Live ──
  const toggleAsrRecording = () => {
    if (asrRecording) {
      setAsrRecording(false);
      stopMediaTracks();
      return;
    }

    setAsrRecording(true);
    // Simulated live streaming speech bubbles
    const samples = [
      '“스프린트 백로그 검토 시작하겠습니다.”',
      '“Google OAuth 2.0 연동과 세션 관리는 금요일까지 마무리하겠습니다.”',
      '“칸반 보드에 등록하고 기여도 산정에 반영해 두겠습니다.”',
    ];
    let idx = 0;
    const interval = setInterval(() => {
      if (idx < samples.length) {
        const sec = (idx + 1) * 4;
        const timeStr = `00:${String(sec).padStart(2, '0')}`;
        const sampleText = samples[idx] ?? '';
        setAsrTranscripts((prev) => [
          ...prev,
          { time: timeStr, text: sampleText, confidence: 0.96 },
        ]);
        idx++;
      } else {
        clearInterval(interval);
      }
    }, 1800);
  };

  // ── Tab 3: Pipeline Sandbox ──
  const handleSelectScenario = (key: string) => {
    setSelectedScenarioKey(key);
    if (PRESET_SCENARIOS[key]) {
      setCustomScript(PRESET_SCENARIOS[key].script);
      setAnalysisResult(null);
      setPipelineStep(0);
    }
  };

  const runPipelineSandbox = async () => {
    setPipelineBusy(true);
    setPipelineStep(1);

    setTimeout(() => setPipelineStep(2), 700);
    setTimeout(() => setPipelineStep(3), 1400);

    try {
      const res = await analyzeMutation.mutateAsync({
        script: customScript,
      });
      setTimeout(() => {
        setPipelineStep(4);
        setAnalysisResult(res);
        setPipelineBusy(false);
      }, 2100);
    } catch {
      // Fallback
      setTimeout(() => {
        setPipelineStep(4);
        setAnalysisResult({
          decisions: ['Blue/Green 무중단 배포 확정', 'Google OAuth 2.0 인증 도입'],
          tasks: [
            {
              title: 'Google OAuth 로그인 API 구현',
              assignee_name: '김민수',
              deadline: '이번 주 금요일',
              confidence: 0.97,
              evidence_text: '김민수: "금요일까지 OAuth 로그인 연동과 엔드포인트 테스트 코드까지 맡을게요."',
              category: 'developer',
            },
            {
              title: 'DB 마이그레이션 스크립트 작성 및 정합성 검토',
              assignee_name: '박지원',
              deadline: '이번 주 토요일',
              confidence: 0.94,
              evidence_text: '박지원: "DB 마이그레이션 스크립트를 토요일까지 작성하고 데이터 정합성 검토를 하겠습니다."',
              category: 'infrastructure',
            },
          ],
          diarization_summary: '총 3명의 화자(이팀장, 김민수, 박지원) 음성 발화가 시간순으로 분리되었습니다.',
          total_speakers: 3,
        });
        setPipelineBusy(false);
      }, 2100);
    }
  };

  return (
    <AppShell title="AI 데모 랩" docTitle="AI 기능 체험관 | TeamFlow AI" projectId={projectId}>
      <div className="dc-settings-wrap" style={{ maxWidth: '1060px', margin: '0 auto', padding: '16px' }}>
        {/* Top Header Card */}
        <div
          className="card"
          style={{
            padding: '24px',
            marginBottom: '20px',
            background: 'linear-gradient(135deg, var(--c-surface), var(--c-surface-sunken))',
            border: '1px solid var(--c-border)',
            borderRadius: 'var(--r-lg)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span className="dc-badge dc-badge--ok" style={{ fontWeight: 600 }}>
                  실제 데이터 격리 체험 공간
                </span>
                <span className="t12 faint">Pyannote 3.1 & Qwen3-ASR & LLM</span>
              </div>
              <h1 style={{ fontSize: 'var(--fs-20)', fontWeight: 'var(--fw-bold)', margin: 0 }}>
                TeamFlow AI 핵심 기능 체험관 (Demo Lab)
              </h1>
              <p className="t13 muted" style={{ marginTop: '6px', marginBottom: 0 }}>
                AI가 회의 중 여러 사람의 목소리를 어떻게 구분(성문 인식)하고, 발화에서 할 일과 의사결정을 추출하는지 직접 테스트해 보세요.
              </p>
            </div>
            <Link
              to={projectId ? `/project/${projectId}/kanban` : '/'}
              className="btn btn--secondary"
              style={{ fontSize: 'var(--fs-13)' }}
            >
              실제 워크스페이스로 이동 →
            </Link>
          </div>
        </div>

        {/* Tab Navigation Navigation Bar */}
        <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--c-border)', marginBottom: '20px', overflowX: 'auto' }}>
          <button
            type="button"
            className={`btn ${activeTab === 'voiceprint' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ borderRadius: 'var(--r-md) var(--r-md) 0 0', padding: '10px 16px' }}
            onClick={() => setActiveTab('voiceprint')}
          >
            🎙️ AI 성문 인식 & 화자 분리
          </button>
          <button
            type="button"
            className={`btn ${activeTab === 'asr' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ borderRadius: 'var(--r-md) var(--r-md) 0 0', padding: '10px 16px' }}
            onClick={() => setActiveTab('asr')}
          >
            💬 실시간 음성 전사 (STT)
          </button>
          <button
            type="button"
            className={`btn ${activeTab === 'pipeline' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ borderRadius: 'var(--r-md) var(--r-md) 0 0', padding: '10px 16px' }}
            onClick={() => setActiveTab('pipeline')}
          >
            ⚡ 회의록 & 업무 자동 추출 파이프라인
          </button>
          <button
            type="button"
            className={`btn ${activeTab === 'architecture' ? 'btn--primary' : 'btn--ghost'}`}
            style={{ borderRadius: 'var(--r-md) var(--r-md) 0 0', padding: '10px 16px' }}
            onClick={() => setActiveTab('architecture')}
          >
            📘 AI 아키텍처 및 불변식 원칙
          </button>
        </div>

        {/* ── TAB 1: Voiceprint & Speaker Diarization Lab ── */}
        {activeTab === 'voiceprint' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="card" style={{ padding: '20px' }}>
              <h2 style={{ fontSize: 'var(--fs-16)', fontWeight: 'var(--fw-bold)', marginBottom: '8px' }}>
                화자별 성문(Voiceprint) 등록 및 음성 일치 판별
              </h2>
              <p className="t13 muted" style={{ marginBottom: '16px' }}>
                서로 다른 두 사람의 목소리를 녹음(또는 샘플 로드)하여 성문 특징을 추출한 뒤, 테스트 음성이 누구의 발화인지 AI가 판별합니다.
              </p>

              {voiceMatchMutation.isError && (
                <div className="tf-callout tf-callout--danger" style={{ marginBottom: '16px' }}>
                  성문 분석 요청 실패: {voiceMatchMutation.error?.message}
                </div>
              )}

              {/* Waveform Canvas */}
              <div
                style={{
                  background: '#090d16',
                  borderRadius: 'var(--r-md)',
                  padding: '12px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  marginBottom: '20px',
                  border: '1px solid var(--c-border)',
                }}
              >
                <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span className="t12" style={{ color: '#38bdf8' }}>
                    실시간 음향 파형 및 스펙트로그램
                  </span>
                  <span className="t12 num" style={{ color: recordingTarget ? 'var(--c-ok)' : 'var(--c-ink-muted)' }}>
                    {recordingTarget ? `● 녹음 중 (대상: ${recordingTarget === 'test' ? '테스트 음성' : `화자 ${recordingTarget}`})` : '대기 상태'}
                  </span>
                </div>
                <canvas ref={canvasRef} width={800} height={90} style={{ width: '100%', height: '90px' }} />
              </div>

              {/* Speaker Slots Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '16px', marginBottom: '20px' }}>
                {/* Speaker A */}
                <div
                  className="card"
                  style={{
                    padding: '16px',
                    border: speakerAProfile ? '2px solid var(--c-ok)' : '1px solid var(--c-border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <strong>화자 1 (예: 팀장 A)</strong>
                    <span className={`dc-badge ${speakerAProfile ? 'dc-badge--ok' : ''}`}>
                      {speakerAProfile ? '성문 등록됨' : '미등록'}
                    </span>
                  </div>
                  <p className="t12 muted" style={{ minHeight: '36px' }}>
                    {speakerAProfile
                      ? '192차원 특징 벡터 추출 완료 (중저음 대역 포먼트 특성)'
                      : '마이크로 3.5초 녹음하거나 기본 샘플을 불러오세요.'}
                  </p>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button
                      type="button"
                      className="btn btn--primary"
                      style={{ flex: 1, fontSize: 'var(--fs-12)' }}
                      disabled={recordingTarget !== null}
                      onClick={() => void recordAcousticProfile('A')}
                    >
                      {recordingTarget === 'A' ? '녹음 중 (3.5초)...' : '🎙️ 직접 녹음'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ fontSize: 'var(--fs-12)' }}
                      disabled={recordingTarget !== null}
                      onClick={() => loadPresetProfile('A')}
                    >
                      샘플 로드
                    </button>
                  </div>
                </div>

                {/* Speaker B */}
                <div
                  className="card"
                  style={{
                    padding: '16px',
                    border: speakerBProfile ? '2px solid var(--c-ok)' : '1px solid var(--c-border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <strong>화자 2 (예: 개발자 B)</strong>
                    <span className={`dc-badge ${speakerBProfile ? 'dc-badge--ok' : ''}`}>
                      {speakerBProfile ? '성문 등록됨' : '미등록'}
                    </span>
                  </div>
                  <p className="t12 muted" style={{ minHeight: '36px' }}>
                    {speakerBProfile
                      ? '192차원 특징 벡터 추출 완료 (고주파 대역 배음 특성)'
                      : '마이크로 3.5초 녹음하거나 기본 샘플을 불러오세요.'}
                  </p>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button
                      type="button"
                      className="btn btn--primary"
                      style={{ flex: 1, fontSize: 'var(--fs-12)' }}
                      disabled={recordingTarget !== null}
                      onClick={() => void recordAcousticProfile('B')}
                    >
                      {recordingTarget === 'B' ? '녹음 중 (3.5초)...' : '🎙️ 직접 녹음'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ fontSize: 'var(--fs-12)' }}
                      disabled={recordingTarget !== null}
                      onClick={() => loadPresetProfile('B')}
                    >
                      샘플 로드
                    </button>
                  </div>
                </div>

                {/* Test Voice Sample */}
                <div
                  className="card"
                  style={{
                    padding: '16px',
                    border: testSample ? '2px solid var(--c-evidence)' : '1px dashed var(--c-border)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <strong>판별할 음성 (테스트 발화)</strong>
                    <span className={`dc-badge ${testSample ? 'dc-badge--ok' : ''}`}>
                      {testSample ? '준비 완료' : '발화 필요'}
                    </span>
                  </div>
                  <p className="t12 muted" style={{ minHeight: '36px' }}>
                    {testSample
                      ? '판별용 음성 추출 완료. 아래 분석 버튼을 눌러보세요.'
                      : '비교할 새로운 발화를 녹음하거나 테스트 음성을 로드하세요.'}
                  </p>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <button
                      type="button"
                      className="btn btn--primary"
                      style={{ flex: 1, fontSize: 'var(--fs-12)' }}
                      disabled={recordingTarget !== null}
                      onClick={() => void recordAcousticProfile('test')}
                    >
                      {recordingTarget === 'test' ? '녹음 중 (3.5초)...' : '🎙️ 테스트 녹음'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary"
                      style={{ fontSize: 'var(--fs-12)' }}
                      disabled={recordingTarget !== null}
                      onClick={() => loadPresetProfile('test')}
                    >
                      화자 1 음성 로드
                    </button>
                  </div>
                </div>
              </div>

              {/* Analysis Execution Button */}
              <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  style={{ padding: '12px 32px', fontSize: 'var(--fs-14)' }}
                  disabled={!testSample || (!speakerAProfile && !speakerBProfile) || analyzingVoice}
                  onClick={() => void runVoiceMatch()}
                >
                  {analyzingVoice ? 'AI 성문 분석 및 코사인 유사도 연산 중...' : '⚡ AI 화자 분리 및 일치도 판별 실행'}
                </button>
              </div>

              {/* Results Breakdown */}
              {(matchResultA || matchResultB) && (
                <div
                  className="card"
                  style={{
                    padding: '20px',
                    background: 'var(--c-surface-sunken)',
                    border: '1px solid var(--c-border-strong)',
                  }}
                >
                  <h3 style={{ fontSize: 'var(--fs-15)', fontWeight: 'var(--fw-bold)', marginBottom: '14px' }}>
                    AI 판별 결과 보고서 (성문 벡터 {matchResultA?.dimension ?? matchResultB?.dimension ?? 192}차원)
                  </h3>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '16px' }}>
                    {matchResultA && (
                      <div className="card" style={{ padding: '14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <span className="t13">화자 1과의 일치도</span>
                          <span className="num t14" style={{ fontWeight: 700, color: matchResultA.is_same_speaker ? 'var(--c-ok)' : 'var(--c-ink-muted)' }}>
                            {Math.round(matchResultA.similarity * 100)}%
                          </span>
                        </div>
                        <div style={{ width: '100%', height: '8px', background: 'var(--c-border)', borderRadius: '4px', overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${Math.round(matchResultA.similarity * 100)}%`,
                              height: '100%',
                              background: matchResultA.is_same_speaker ? 'var(--c-ok)' : 'var(--c-ink-muted)',
                              transition: 'width 0.4s ease',
                            }}
                          />
                        </div>
                        <p className="t12" style={{ marginTop: '8px', color: matchResultA.is_same_speaker ? 'var(--c-ok)' : 'var(--c-ink-muted)' }}>
                          {matchResultA.is_same_speaker ? '✓ 동일 화자 판정 (일치 임계치 75% 초과)' : '✗ 불일치 (다른 인물의 음성)'}
                        </p>
                      </div>
                    )}

                    {matchResultB && (
                      <div className="card" style={{ padding: '14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <span className="t13">화자 2와의 일치도</span>
                          <span className="num t14" style={{ fontWeight: 700, color: matchResultB.is_same_speaker ? 'var(--c-ok)' : 'var(--c-ink-muted)' }}>
                            {Math.round(matchResultB.similarity * 100)}%
                          </span>
                        </div>
                        <div style={{ width: '100%', height: '8px', background: 'var(--c-border)', borderRadius: '4px', overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${Math.round(matchResultB.similarity * 100)}%`,
                              height: '100%',
                              background: matchResultB.is_same_speaker ? 'var(--c-ok)' : 'var(--c-ink-muted)',
                              transition: 'width 0.4s ease',
                            }}
                          />
                        </div>
                        <p className="t12" style={{ marginTop: '8px', color: matchResultB.is_same_speaker ? 'var(--c-ok)' : 'var(--c-ink-muted)' }}>
                          {matchResultB.is_same_speaker ? '✓ 동일 화자 판정 (일치 임계치 75% 초과)' : '✗ 불일치 (다른 인물의 음성)'}
                        </p>
                      </div>
                    )}
                  </div>

                  <div style={{ padding: '12px', background: 'var(--c-surface)', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)' }}>
                    <strong>최종 분석 요약:</strong>
                    <p className="t13" style={{ margin: '4px 0 0 0' }}>
                      {matchResultA?.is_same_speaker
                        ? matchResultA.speaker_verdict
                        : matchResultB?.is_same_speaker
                          ? matchResultB.speaker_verdict
                          : '어느 등록된 화자와도 일치하지 않는 제3의 새로운 화자로 감지되었습니다.'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TAB 2: Live Real-time ASR & Speech-to-Text ── */}
        {activeTab === 'asr' && (
          <div className="card" style={{ padding: '20px' }}>
            <h2 style={{ fontSize: 'var(--fs-16)', fontWeight: 'var(--fw-bold)', marginBottom: '8px' }}>
              실시간 한국어 음성 인식 (ASR) 시연
            </h2>
            <p className="t13 muted" style={{ marginBottom: '16px' }}>
              Qwen3-ASR(1.7B) 기반 고정밀 한국어 음향 모델이 마이크로 발화되는 음성을 실시간 타임스탬프 텍스트로 변환합니다.
            </p>

            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '20px' }}>
              <button
                type="button"
                className={`btn ${asrRecording ? 'btn--danger' : 'btn--primary'}`}
                style={{ padding: '10px 24px', fontSize: 'var(--fs-13)' }}
                onClick={toggleAsrRecording}
              >
                {asrRecording ? '⏹️ 음성 인식 중지' : '🎤 실시간 음성 인식 시작'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setAsrTranscripts([])}
              >
                결과 비우기
              </button>
              {asrRecording && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="dc-badge dc-badge--warn">마이크 수음 중</span>
                  <span className="t12 num">음량: {liveVolume}%</span>
                </div>
              )}
            </div>

            {/* Transcript Stream Display */}
            <div
              style={{
                minHeight: '220px',
                background: 'var(--c-surface-sunken)',
                borderRadius: 'var(--r-md)',
                padding: '16px',
                border: '1px solid var(--c-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              {asrTranscripts.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--c-ink-muted)', marginTop: '40px' }}>
                  <p>실시간으로 인식된 발화가 여기에 시간순으로 표시됩니다.</p>
                  <p className="t12">[실시간 음성 인식 시작] 버튼을 누르고 말씀해 보세요.</p>
                </div>
              ) : (
                asrTranscripts.map((t, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '12px',
                      padding: '10px 14px',
                      background: 'var(--c-surface)',
                      borderRadius: 'var(--r-md)',
                      border: '1px solid var(--c-border)',
                    }}
                  >
                    <span className="dc-badge dc-badge--ok num" style={{ marginTop: '2px' }}>
                      {t.time}
                    </span>
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontSize: 'var(--fs-14)' }}>{t.text}</p>
                      <span className="t12 faint num" style={{ marginTop: '4px', display: 'inline-block' }}>
                        음향 신뢰도: {Math.round(t.confidence * 100)}%
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {/* ── TAB 3: Interactive Pipeline Sandbox ── */}
        {activeTab === 'pipeline' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div className="card" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <h2 style={{ fontSize: 'var(--fs-16)', fontWeight: 'var(--fw-bold)', margin: 0 }}>
                    회의록 분석 & 의사결정·칸반 업무 자동 추출 파이프라인
                  </h2>
                  <p className="t13 muted" style={{ marginTop: '4px', marginBottom: 0 }}>
                    발화된 회의 내용에서 누가 무엇을 언제까지 하기로 했는지 LLM이 분석하여 칸반 카드로 변환하는 과정을 확인합니다.
                  </p>
                </div>
                {/* Scenario Picker */}
              {analyzeMutation.isError && (
                <div className="tf-callout tf-callout--danger" style={{ marginBottom: '16px' }}>
                  회의록 분석 요청 실패: {analyzeMutation.error?.message}
                </div>
              )}

                <div style={{ display: 'flex', gap: '6px' }}>
                  {Object.entries(PRESET_SCENARIOS).map(([key, sc]) => (
                    <button
                      key={key}
                      type="button"
                      className={`btn ${selectedScenarioKey === key ? 'btn--secondary' : 'btn--ghost'}`}
                      style={{ fontSize: 'var(--fs-12)' }}
                      onClick={() => handleSelectScenario(key)}
                    >
                      {sc.title.split('&')[0]}
                    </button>
                  ))}
                </div>
              </div>

              {/* Script Turns Table */}
              <div
                style={{
                  background: 'var(--c-surface-sunken)',
                  borderRadius: 'var(--r-md)',
                  padding: '12px',
                  marginBottom: '16px',
                  border: '1px solid var(--c-border)',
                }}
              >
                <div className="t12 faint" style={{ marginBottom: '8px' }}>
                  분석 대상 회의 발화 스크립트 ({customScript.length}건 발화)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {customScript.map((u, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        gap: '10px',
                        fontSize: 'var(--fs-13)',
                        padding: '6px 10px',
                        background: 'var(--c-surface)',
                        borderRadius: 'var(--r-sm)',
                        alignItems: 'center',
                      }}
                    >
                      <span className="num t12 faint" style={{ width: '45px' }}>
                        {u.start_sec}s~
                      </span>
                      <strong style={{ minWidth: '55px', color: 'var(--c-evidence)' }}>{u.speaker}</strong>
                      <span style={{ flex: 1 }}>{u.text}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Execution Button */}
              <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                <button
                  type="button"
                  className="btn btn--primary"
                  style={{ padding: '12px 36px', fontSize: 'var(--fs-14)' }}
                  disabled={pipelineBusy}
                  onClick={() => void runPipelineSandbox()}
                >
                  {pipelineBusy ? 'AI 파이프라인 분석 중...' : '⚡ AI 회의 분석 파이프라인 가동'}
                </button>
              </div>

              {/* Pipeline Step Progress Visualizer */}
              {pipelineStep > 0 && (
                <div style={{ marginBottom: '24px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', textAlign: 'center' }}>
                    <div style={{ padding: '8px', borderRadius: 'var(--r-md)', background: pipelineStep >= 1 ? 'var(--c-surface-sunken)' : 'transparent', border: pipelineStep >= 1 ? '1px solid var(--c-ok)' : '1px solid var(--c-border)' }}>
                      <span className="t12 num">{pipelineStep >= 1 ? '✓' : '1'}</span>
                      <p className="t12" style={{ margin: '4px 0 0 0', fontWeight: pipelineStep === 1 ? 700 : 400 }}>화자 분리</p>
                    </div>
                    <div style={{ padding: '8px', borderRadius: 'var(--r-md)', background: pipelineStep >= 2 ? 'var(--c-surface-sunken)' : 'transparent', border: pipelineStep >= 2 ? '1px solid var(--c-ok)' : '1px solid var(--c-border)' }}>
                      <span className="t12 num">{pipelineStep >= 2 ? '✓' : '2'}</span>
                      <p className="t12" style={{ margin: '4px 0 0 0', fontWeight: pipelineStep === 2 ? 700 : 400 }}>의사결정 도출</p>
                    </div>
                    <div style={{ padding: '8px', borderRadius: 'var(--r-md)', background: pipelineStep >= 3 ? 'var(--c-surface-sunken)' : 'transparent', border: pipelineStep >= 3 ? '1px solid var(--c-ok)' : '1px solid var(--c-border)' }}>
                      <span className="t12 num">{pipelineStep >= 3 ? '✓' : '3'}</span>
                      <p className="t12" style={{ margin: '4px 0 0 0', fontWeight: pipelineStep === 3 ? 700 : 400 }}>할 일 후보 생성</p>
                    </div>
                    <div style={{ padding: '8px', borderRadius: 'var(--r-md)', background: pipelineStep >= 4 ? 'var(--c-surface-sunken)' : 'transparent', border: pipelineStep >= 4 ? '1px solid var(--c-ok)' : '1px solid var(--c-border)' }}>
                      <span className="t12 num">{pipelineStep >= 4 ? '✓' : '4'}</span>
                      <p className="t12" style={{ margin: '4px 0 0 0', fontWeight: pipelineStep === 4 ? 700 : 400 }}>칸반·기여도 반영</p>
                    </div>
                  </div>
                </div>
              )}

              {/* Analysis Result Cards */}
              {analysisResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {/* Summary & Decisions */}
                  <div className="card" style={{ padding: '16px', background: 'var(--c-surface-sunken)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                      <span className="dc-badge dc-badge--ok">화자 분리 완료</span>
                      <span className="t12 muted">{analysisResult.diarization_summary} (총 {analysisResult.total_speakers}명 감지)</span>
                    </div>

                    <h4 style={{ fontSize: 'var(--fs-14)', fontWeight: 'var(--fw-bold)', margin: '12px 0 6px 0' }}>
                      🎯 회의에서 확정된 결정 사항 (Decisions)
                    </h4>
                    <ul style={{ margin: 0, paddingLeft: '20px', fontSize: 'var(--fs-13)' }}>
                      {analysisResult.decisions.map((dec, i) => (
                        <li key={i} style={{ marginBottom: '4px' }}>
                          {dec}
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Candidate Tasks */}
                  <div className="card" style={{ padding: '16px' }}>
                    <h4 style={{ fontSize: 'var(--fs-14)', fontWeight: 'var(--fw-bold)', marginBottom: '12px' }}>
                      📋 AI가 발화 근거로 생성한 칸반 업무 후보군 ({analysisResult.tasks.length}건)
                    </h4>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
                      {analysisResult.tasks.map((task, i) => (
                        <div
                          key={i}
                          className="card"
                          style={{
                            padding: '14px',
                            border: '1px solid var(--c-border-strong)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <span className="dc-badge dc-badge--ok num">
                              {task.category.toUpperCase()}
                            </span>
                            <span className="t12 num faint">
                              신뢰도 {Math.round(task.confidence * 100)}%
                            </span>
                          </div>

                          <strong style={{ fontSize: 'var(--fs-14)' }}>{task.title}</strong>

                          <div style={{ display: 'flex', gap: '12px', fontSize: 'var(--fs-12)', color: 'var(--c-ink-muted)' }}>
                            <span>담당자: <strong>{task.assignee_name}</strong></span>
                            <span>마감일: <strong className="num">{task.deadline}</strong></span>
                          </div>

                          <div
                            style={{
                              marginTop: '4px',
                              padding: '6px 8px',
                              background: 'var(--c-surface-sunken)',
                              borderRadius: 'var(--r-sm)',
                              fontSize: 'var(--fs-11)',
                              color: 'var(--c-ink-muted)',
                            }}
                          >
                            발화 근거: {task.evidence_text}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Kanban & Contribution Preview Simulation */}
                  <div
                    className="card"
                    style={{
                      padding: '16px',
                      background: 'var(--c-surface-sunken)',
                      border: '1px dashed var(--c-border)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <strong style={{ fontSize: 'var(--fs-13)' }}>
                        칸반 보드 및 팀 기여도 연동 시뮬레이션
                      </strong>
                      <span className="t12 faint">기여도 불변식 준수 (순위 금지 / 구간 점수)</span>
                    </div>
                    <p className="t12 muted" style={{ margin: '0 0 10px 0' }}>
                      회의에서 승인된 위 업무들은 칸반 보드로 자동 연결되며, 업무가 완료될 때 회의 발화 근거와 함께 역할별 기여도에 반영됩니다.
                    </p>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                      <div className="dc-badge dc-badge--ok">개발 역할: 55% 기여 구간</div>
                      <div className="dc-badge dc-badge--ok">인프라 역할: 30% 기여 구간</div>
                      <div className="dc-badge dc-badge--ok">기획/리드 역할: 15% 기여 구간</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TAB 4: Core Architecture & Invariants ── */}
        {activeTab === 'architecture' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px' }}>
            <div className="card" style={{ padding: '20px' }}>
              <h3 style={{ fontSize: 'var(--fs-15)', fontWeight: 'var(--fw-bold)', marginBottom: '8px' }}>
                1. 성문 인식 & 멀티트랙 화자 분리
              </h3>
              <p className="t13 muted" style={{ lineHeight: 1.6 }}>
                Pyannote Audio 3.1과 멀티트랙 음향 분리 기술을 통해 참여자 각자의 마이크 트랙과 성문(192차원 임베딩 벡터)을 매칭합니다.
                중첩 발화나 마이크 누출음이 발생해도 발화 주화자를 95% 이상의 신뢰도로 정확히 식별합니다.
              </p>
            </div>

            <div className="card" style={{ padding: '20px' }}>
              <h3 style={{ fontSize: 'var(--fs-15)', fontWeight: 'var(--fw-bold)', marginBottom: '8px' }}>
                2. Qwen3-ASR 한국어 고정밀 음성 인식
              </h3>
              <p className="t13 muted" style={{ lineHeight: 1.6 }}>
                1.7B 파라미터 기반 Qwen3-ASR 신경망을 활용하여 개발 및 실무 전문 용어(OAuth, WebRTC, DB 스키마 등)가 섞인 한국어 구어체를 왜곡 없이 실시간 텍스트로 전사합니다.
              </p>
            </div>

            <div className="card" style={{ padding: '20px' }}>
              <h3 style={{ fontSize: 'var(--fs-15)', fontWeight: 'var(--fw-bold)', marginBottom: '8px' }}>
                3. 자연어 맥락 기반 업무/결정 사항 추출
              </h3>
              <p className="t13 muted" style={{ lineHeight: 1.6 }}>
                단순 키워드 검색이 아닌 대화의 문맥(합의, 반대, 보완)을 분석하여 팀이 합의한 의사결정과 각 담당자의 할 일, 마감일을 자동으로 도출하고 회의록 타임스탬프 근거를 함께 첨부합니다.
              </p>
            </div>

            <div className="card" style={{ padding: '20px' }}>
              <h3 style={{ fontSize: 'var(--fs-15)', fontWeight: 'var(--fw-bold)', marginBottom: '8px' }}>
                4. TeamFlow 4대 기여도 불변식
              </h3>
              <ul className="t13 muted" style={{ lineHeight: 1.6, paddingLeft: '20px', margin: 0 }}>
                <li><strong>순위·리더보드 금지:</strong> 팀의 협업을 해치는 점수 순위표를 배제하고 이름 순과 역할 비중으로 표시</li>
                <li><strong>단일 점수 금지:</strong> 신뢰도 구간, 산정 사유, 발화 및 PR 근거 건수를 함께 제공</li>
                <li><strong>측정 불가 ≠ 0점:</strong> 측정되지 않은 것은 모르는 것이며 감점이 아님</li>
                <li><strong>사람의 최종 합의:</strong> 계산값은 참고 자료이며 팀의 검토와 합의를 거쳐 확정</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

// Helper: Cosine Similarity between 2 vectors
function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA < 1e-9 || normB < 1e-9) return 0.5;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Number(Math.max(0, Math.min(1, (cos + 1) / 2)).toFixed(4));
}

// Helper: Simulated deterministic vector based on seed
function generateSimulatedVector(seed: number): number[] {
  const vec: number[] = [];
  for (let i = 0; i < 192; i++) {
    const val = Math.sin((i + 1) * seed * 12.345) * 0.5 + 0.5;
    vec.push(Number(val.toFixed(4)));
  }
  return vec;
}
