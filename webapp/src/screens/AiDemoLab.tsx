import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Problem } from '../components/Problem.tsx';
import { apiFailureText } from '../api/client.ts';
import { useDemoAnalyzeMutation, useDemoVoiceMatchMutation, useMe } from '../api/hooks.ts';
import { DEMO_SCRIPT_PRESETS, parseDemoScript, similarityPercent } from '@lib/audio/demo.ts';

export default function AiDemoLab() {
  const params = useParams();
  const pid = params['projectId'] ? Number(params['projectId']) : undefined;
  const me = useMe();
  const analyze = useDemoAnalyzeMutation();
  const compare = useDemoVoiceMatchMutation();

  const [script, setScript] = useState(
    '팀원 가: 금요일까지 로그인 화면을 구현하겠습니다.\n팀원 나: 이메일 로그인을 사용하기로 결정했습니다.',
  );
  const [sampleA, setA] = useState<number[] | null>(null);
  const [sampleB, setB] = useState<number[] | null>(null);
  const [recording, setRecording] = useState<'A' | 'B' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const generationRef = useRef(0);

  const clearIdleWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(148, 155, 164, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }, []);

  const clear = useCallback(() => {
    generationRef.current++;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    mediaRef.current = null;
    void audioRef.current?.close().catch(() => undefined);
    audioRef.current = null;
    clearIdleWaveform();
  }, [clearIdleWaveform]);

  useEffect(() => {
    clearIdleWaveform();
    return clear;
  }, [clear, clearIdleWaveform]);

  const startWaveform = (analyser: AnalyserNode, ticket: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const draw = () => {
      if (ticket !== generationRef.current) return;
      animFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#4e5ae0';
      ctx.beginPath();
      const sliceWidth = canvas.width / dataArray.length;
      let x = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = (dataArray[i] ?? 128) / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    };
    draw();
  };

  const capture = async (target: 'A' | 'B') => {
    clear();
    setError(null);
    setRecording(target);
    compare.reset();
    if (target === 'A') setA(null);
    else setB(null);
    const ticket = generationRef.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (ticket !== generationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaRef.current = stream;
      const context = new AudioContext();
      audioRef.current = context;
      await context.resume();
      if (ticket !== generationRef.current) return;

      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      startWaveform(analyser, ticket);

      const bins = new Uint8Array(analyser.frequencyBinCount);
      const sums = new Array<number>(192).fill(0);
      let count = 0;
      intervalRef.current = setInterval(() => {
        analyser.getByteFrequencyData(bins);
        count++;
        for (let i = 0; i < sums.length; i++) {
          sums[i]! += (bins[Math.floor((i * bins.length) / 192)] ?? 0) / 255;
        }
        setVolume(
          Math.round((bins.reduce((sum, value) => sum + value, 0) / bins.length / 255) * 100),
        );
      }, 100);

      timeoutRef.current = setTimeout(() => {
        if (ticket !== generationRef.current) return;
        const values = sums.map((sum) => Number((sum / Math.max(1, count)).toFixed(4)));
        clear();
        setRecording(null);
        setVolume(0);
        if (!values.some((value) => value > 0)) {
          setError('입력된 소리가 없습니다. 마이크를 확인해 주세요');
          return;
        }
        if (target === 'A') setA(values);
        else setB(values);
      }, 3500);
    } catch {
      if (ticket !== generationRef.current) return;
      clear();
      setRecording(null);
      setVolume(0);
      setError('마이크를 열지 못했습니다. 장치 연결과 마이크 권한을 확인해 주세요. 샘플은 생성하지 않았습니다.');
    }
  };

  const similarityPct = similarityPercent(compare.data?.similarity);

  const labBody = (
    <div className="pane__body demo-lab">
        <div className="demo-lab__hero">
          <div>
            <h1 className="sec__title">음향과 업무 추출 원리 체험</h1>
            <p className="notice demo-lab__notice">
              이 페이지는 브라우저 주파수 벡터 비교와 문장 키워드 규칙을 체험하는 샌드박스입니다.
              실제 ASR·화자 성문 모델·LLM을 실행하거나 프로젝트 업무·기여도에 저장하지 않습니다.
            </p>
          </div>
          <Link className="btn btn--secondary" to={me.data ? '/' : '/login'}>
            {me.data ? '프로젝트로 이동' : '로그인하기'}
          </Link>
        </div>

        {error && <Problem>{error}</Problem>}

        <div className="demo-lab__grid">
          <section className="card demo-lab__section" aria-labelledby="demo-audio-title">
            <div className="demo-lab__head">
              <h2 id="demo-audio-title" className="sec__title">
                마이크 주파수 벡터 비교
              </h2>
              <span className="pill">192-bin FFT</span>
            </div>
            <p className="t13 muted">
              3.5초간 입력한 소리를 192개 주파수 평균값으로 묶어 코사인 유사도를 계산합니다. 실제
              성문 임베딩이 아니며 동일 인물 여부를 판정하지 않습니다.
            </p>

            <div className="demo-lab__wave">
              <canvas
                ref={canvasRef}
                width={520}
                height={88}
                aria-label="실시간 마이크 파형"
                className="demo-lab__canvas"
              />
              {recording && (
                <p role="status" className="t12 num demo-lab__wave-status">
                  샘플 {recording} 입력 중 · 음량 {volume}%
                </p>
              )}
            </div>

            <div className="meeting-room__actions">
              <button
                type="button"
                className="btn btn--secondary"
                disabled={recording !== null}
                onClick={() => void capture('A')}
              >
                샘플 A 녹음{sampleA ? ' · 준비됨' : ''}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={recording !== null}
                onClick={() => void capture('B')}
              >
                샘플 B 녹음{sampleB ? ' · 준비됨' : ''}
              </button>
              {recording && (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    clear();
                    setRecording(null);
                    setVolume(0);
                  }}
                >
                  녹음 취소
                </button>
              )}
            </div>

            <div>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!sampleA || !sampleB || compare.isPending || recording !== null}
                onClick={async () => {
                  if (!sampleA || !sampleB) return;
                  setError(null);
                  try {
                    await compare.mutateAsync({
                      sample_a: sampleA,
                      sample_b: sampleB,
                      speaker_names: ['샘플 A', '샘플 B'],
                    });
                  } catch (value) {
                    setError(apiFailureText(value));
                  }
                }}
              >
                {compare.isPending ? '계산 중…' : '벡터 유사도 계산'}
              </button>
            </div>

            {compare.data && (
              <div className="demo-lab__result" role="status">
                <div className="demo-lab__meter-wrap">
                  <span className="t12 muted">코사인 유사도 ([-1, 1])</span>
                  <strong className="num">{compare.data.similarity.toFixed(3)}</strong>
                </div>
                <div className="demo-lab__bar" aria-hidden="true">
                  <span className="demo-lab__bar-fill" style={{ width: `${similarityPct}%` }} />
                </div>
                <p className="t13 demo-lab__copy-reset">
                  {compare.data.dimension}개 값 비교 · {compare.data.speaker_verdict}
                </p>
              </div>
            )}
          </section>

          <section className="card demo-lab__section" aria-labelledby="demo-rules-title">
            <div className="demo-lab__head">
              <h2 id="demo-rules-title" className="sec__title">
                키워드 규칙으로 업무 예시 찾기
              </h2>
              <span className="pill">규칙 샌드박스</span>
            </div>
            <p className="t13 muted">
              ‘결정·하기로·확정’ 및 ‘까지·구현·작성·검토’ 같은 낱말 패턴으로 문장을 골라내는 예시를
              확인합니다.
            </p>

            <div className="meeting-room__actions">
              {DEMO_SCRIPT_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setScript(preset.script);
                    setError(null);
                    analyze.reset();
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setError(null);
                const parsed = parseDemoScript(script);
                if (!parsed.ok) {
                  setError(parsed.message);
                  return;
                }
                try {
                  await analyze.mutateAsync({ script: parsed.lines });
                } catch (value) {
                  setError(apiFailureText(value));
                }
              }}
            >
              <label className="field" htmlFor="demo-script">
                발언자와 발언 내용
              </label>
              <textarea
                id="demo-script"
                className="textarea"
                rows={6}
                maxLength={20000}
                value={script}
                onChange={(event) => {
                  setScript(event.target.value);
                  analyze.reset();
                }}
              />
              <div>
                <button type="submit" className="btn btn--primary" disabled={analyze.isPending}>
                  {analyze.isPending ? '예시를 찾는 중…' : '규칙 예시 실행'}
                </button>
              </div>
            </form>

            {analyze.data && (
              <div className="demo-lab__result" aria-live="polite">
                <p className="t13 demo-lab__copy-reset">
                  {analyze.data.diarization_summary}
                </p>
                <div>
                  <h3 className="demo-lab__subhead">결정 키워드가 있는 발언</h3>
                  {analyze.data.decisions.length ? (
                    <ul className="demo-lab__list">
                      {analyze.data.decisions.map((text, index) => (
                        <li key={index}>{text}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="t13 muted">결정 키워드가 있는 발언이 없습니다.</p>
                  )}
                </div>
                <div>
                  <h3 className="demo-lab__subhead">업무 키워드가 있는 발언</h3>
                  {analyze.data.tasks.length ? (
                    <ul className="demo-lab__list">
                      {analyze.data.tasks.map((task, index) => (
                        <li key={index}>
                          <strong>{task.title}</strong>
                          <p className="t12 muted demo-lab__ev-text">
                            {task.evidence_text}
                          </p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="t13 muted">업무 키워드가 있는 발언이 없습니다.</p>
                  )}
                </div>
                <p className="t12 muted demo-lab__copy-reset">
                  정해진 낱말을 찾은 예시입니다. 실제 모델의 정확도나 신뢰도가 아니며 칸반과 기여도에
                  반영하지 않습니다.
                </p>
              </div>
            )}
          </section>
        </div>

        <section className="demo-lab__arch" aria-labelledby="demo-arch-title">
          <h2 id="demo-arch-title" className="sec__title">
            실제 회의 처리 파이프라인과 4대 기여도 불변식
          </h2>
          <div className="demo-lab__cards">
            <article className="card demo-lab__card">
              <h3>1. 개별 트랙 기반 화자 분리</h3>
              <p className="t13 muted">
                참여자가 각자 동의하고 녹음한 트랙을 기준으로 발언자를 연결하며, 겹친 소리나
                누출음 구간만 보정합니다.
              </p>
            </article>
            <article className="card demo-lab__card">
              <h3>2. 실제 전사와 근거 확인</h3>
              <p className="t13 muted">
                실제 회의에서는 Qwen3-ASR 전사와 LLM 분석으로 후보를 추출하고 원본 발화 타임스탬프를
                함께 남깁니다.
              </p>
            </article>
            <article className="card demo-lab__card">
              <h3>3. 사람 승인 관문</h3>
              <p className="t13 muted">
                AI가 뽑은 초안은 곧바로 업무가 되지 않습니다. 팀원이 근거·담당자·마감을 확인하고
                승인해야 칸반에 등록됩니다.
              </p>
            </article>
            <article className="card demo-lab__card">
              <h3>4. 기여도 4대 불변식</h3>
              <p className="t13 muted">
                순위표·단일 점수를 금지하고, 측정 불가는 0점이 아니라 흙빛 결측으로 표시하며, 최종
                확정은 팀 합의와 사유 기록으로 남깁니다.
              </p>
            </article>
          </div>
          <p className="t13 muted demo-lab__arch-foot">
            실제 회의 전사와 업무 추출은 로그인 후 프로젝트에서 회의를 열고 녹음·처리·검토 순서로
            진행합니다.
          </p>
        </section>
      </div>
  );

  if (me.data) {
    return (
      <AppShell title="AI 데모 랩" projectId={pid}>
        {labBody}
      </AppShell>
    );
  }
  return (
    <main className="pane" style={{ minHeight: '100vh', background: 'var(--c-paper)' }}>
      <header className="appbar" style={{ justifyContent: 'space-between' }}>
        <strong className="t14">TeamFlow · AI 데모 랩</strong>
        <Link className="btn btn--primary btn--sm" to="/login">
          로그인 · 시작하기
        </Link>
      </header>
      {labBody}
    </main>
  );
}
