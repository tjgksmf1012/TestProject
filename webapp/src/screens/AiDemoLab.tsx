import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { Problem } from '../components/Problem.tsx';
import { apiFailureText } from '../api/client.ts';
import { useDemoAnalyzeMutation, useDemoVoiceMatchMutation } from '../api/hooks.ts';

export default function AiDemoLab() {
  const params = useParams();
  const pid = params['projectId'] ? Number(params['projectId']) : undefined;
  const analyze = useDemoAnalyzeMutation();
  const compare = useDemoVoiceMatchMutation();
  const [script, setScript] = useState('팀원 가: 금요일까지 로그인 화면을 구현하겠습니다.\n팀원 나: 이메일 로그인을 사용하기로 결정했습니다.');
  const [sampleA, setA] = useState<number[] | null>(null);
  const [sampleB, setB] = useState<number[] | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0);
  const media = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const clear = () => {
    generation.current++;
    if (interval.current !== null) clearInterval(interval.current);
    if (timeout.current !== null) clearTimeout(timeout.current);
    media.current?.getTracks().forEach((track) => track.stop()); media.current = null;
    void audio.current?.close().catch(() => {}); audio.current = null;
  };
  useEffect(() => clear, []);
  const capture = async (target: 'A' | 'B') => {
    clear(); setError(null); setRecording(target); compare.reset();
    if (target === 'A') setA(null); else setB(null);
    const ticket = generation.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (ticket !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      media.current = stream;
      const context = new AudioContext(); audio.current = context; await context.resume();
      if (ticket !== generation.current) return;
      const analyser = context.createAnalyser(); analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      const sums = new Array<number>(192).fill(0); let count = 0;
      interval.current = setInterval(() => {
        analyser.getByteFrequencyData(bins); count++;
        for (let i = 0; i < sums.length; i++) sums[i]! += (bins[Math.floor(i * bins.length / 192)] ?? 0) / 255;
        setVolume(Math.round(bins.reduce((sum, value) => sum + value, 0) / bins.length / 255 * 100));
      }, 100);
      timeout.current = setTimeout(() => {
        if (ticket !== generation.current) return;
        const values = sums.map((sum) => sum / Math.max(1, count));
        clear(); setRecording(null); setVolume(0);
        if (!values.some((value) => value > 0)) { setError('입력된 소리가 없습니다. 마이크를 확인해 주세요'); return; }
        if (target === 'A') setA(values); else setB(values);
      }, 3500);
    } catch {
      if (ticket !== generation.current) return;
      clear(); setRecording(null); setVolume(0);
      setError('마이크를 열지 못했습니다. 장치 연결과 마이크 권한을 확인해 주세요. 샘플은 생성하지 않았습니다.');
    }
  };
  return <AppShell title="AI 데모 랩" projectId={pid}>
    <div className="pane__body demo-lab">
      <h1 className="sec__title">음향과 업무 추출 원리 체험</h1>
      <p className="notice">이 페이지는 주파수 벡터 계산과 키워드 규칙 예시입니다. ASR·성문 모델·LLM을 실행하거나 실제 업무를 등록하지 않습니다.</p>
      <section className="card demo-lab__section" aria-labelledby="demo-audio-title">
        <h2 id="demo-audio-title" className="sec__title">마이크 주파수 벡터 비교</h2>
        <p>3.5초간 입력한 소리를 192개 주파수 값으로 묶습니다. 성문 임베딩이 아니며 같은 사람인지 판단할 수 없습니다. 소리와 벡터는 프로젝트에 저장하지 않습니다.</p>
        <div className="meeting-room__actions">
          <button className="btn btn--secondary" disabled={recording !== null} onClick={() => void capture('A')}>샘플 A 녹음{sampleA ? ' · 준비됨' : ''}</button>
          <button className="btn btn--secondary" disabled={recording !== null} onClick={() => void capture('B')}>샘플 B 녹음{sampleB ? ' · 준비됨' : ''}</button>
          {recording && <button className="btn btn--ghost" onClick={() => { clear(); setRecording(null); setVolume(0); }}>녹음 취소</button>}
        </div>
        {recording && <p role="status">샘플 {recording} 입력 중 · 음량 {volume}%</p>}
        <button className="btn btn--primary" disabled={!sampleA || !sampleB || compare.isPending || recording !== null} onClick={async () => {
          if (!sampleA || !sampleB) return; setError(null);
          try { await compare.mutateAsync({ sample_a: sampleA, sample_b: sampleB, speaker_names: ['샘플 A', '샘플 B'] }); } catch (value) { setError(apiFailureText(value)); }
        }}>{compare.isPending ? '계산 중…' : '벡터 유사도 계산'}</button>
        {compare.data && <p role="status">{compare.data.dimension}개 값의 코사인 유사도 {compare.data.similarity.toFixed(3)} · {compare.data.speaker_verdict}</p>}
      </section>
      <section className="card demo-lab__section" aria-labelledby="demo-rules-title">
        <h2 id="demo-rules-title" className="sec__title">키워드 규칙으로 업무 예시 찾기</h2>
        <form onSubmit={async (event) => {
          event.preventDefault(); setError(null);
          const lines = script.split('\n').map((line) => line.trim()).filter(Boolean);
          if (!lines.length || lines.length > 100 || lines.some((line) => !line.includes(':'))) {
            setError('발언자: 내용 형식으로 1~100줄을 입력해 주세요'); return;
          }
          try { await analyze.mutateAsync({ script: lines.map((line, index) => {
            const colon = line.indexOf(':');
            return { speaker: line.slice(0, colon).trim(), text: line.slice(colon + 1).trim(), start_sec: index * 5, end_sec: (index + 1) * 5 };
          }) }); } catch (value) { setError(apiFailureText(value)); }
        }}>
          <label className="field" htmlFor="demo-script">발언자와 발언 내용</label>
          <textarea id="demo-script" className="input" rows={6} maxLength={20000} value={script} onChange={(event) => { setScript(event.target.value); analyze.reset(); }} />
          <button className="btn btn--primary" disabled={analyze.isPending}>{analyze.isPending ? '예시를 찾는 중…' : '규칙 예시 실행'}</button>
        </form>
        {analyze.data && <div aria-live="polite">
          <p>{analyze.data.diarization_summary}</p>
          <h3>결정 키워드가 있는 발언</h3>
          {analyze.data.decisions.length ? <ul>{analyze.data.decisions.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>결정 키워드가 있는 발언이 없습니다.</p>}
          <h3>업무 키워드가 있는 발언</h3>
          {analyze.data.tasks.length ? <ul>{analyze.data.tasks.map((task, index) => <li key={index}><strong>{task.title}</strong><p>{task.evidence_text}</p></li>)}</ul> : <p>업무 키워드가 있는 발언이 없습니다.</p>}
          <p className="muted">정해진 낱말을 찾은 예시입니다. 실제 모델의 정확도나 신뢰도가 아니며 칸반과 기여도에 반영하지 않습니다.</p>
        </div>}
      </section>
      {error && <Problem>{error}</Problem>}
      <p>실제 회의 전사와 업무 추출은 로그인 후 프로젝트에서 회의를 열고 녹음·처리·검토 순서로 진행합니다.</p>
      <Link className="btn btn--secondary" to="/">프로젝트로 이동</Link>
    </div>
  </AppShell>;
}
