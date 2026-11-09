import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useAccountSecurityMutations, useDeleteVoiceprint, useMe, useSettingsMutations, useVoiceprint } from '../api/hooks.ts';
import { apiFailureText } from '../api/client.ts';
import { Problem } from './Problem.tsx';

export interface SelectOption { value: string; label: string; sublabel?: string }

/** 원래 선택 API를 유지하며 키보드와 초점 처리는 Radix가 담당합니다. */
export function DiscordSelect({ id, value, options, icon, onChange, compact = false, warn = false, ariaLabel }: {
  id?: string; value: string; options: SelectOption[]; icon?: ReactNode;
  onChange: (value: string) => void; compact?: boolean; warn?: boolean; ariaLabel?: string;
}) {
  // 빈 문자열도 '전체 담당자'처럼 실제 선택지입니다. Radix의 미선택 값과 구분합니다.
  const encoded = (entry: string) => `option:${entry}`;
  return <Select.Root value={encoded(value)} onValueChange={(next) => onChange(next.slice(7))}>
    <Select.Trigger id={id} aria-label={ariaLabel} className={`input ${compact ? 'input--compact' : ''}`} data-warn={warn || undefined}>
      {icon}<Select.Value placeholder="선택하세요" /><Select.Icon> ▾</Select.Icon>
    </Select.Trigger>
    <Select.Portal><Select.Content className="picker__content" position="popper" style={{ zIndex: 300, background: 'var(--c-surface)', color: 'var(--c-ink)', border: '1px solid var(--c-line)', padding: 8 }}>
      <Select.Viewport>{options.map((option) => <Select.Item key={option.value} value={encoded(option.value)} className="btn btn--ghost" style={{ display: 'flex', minHeight: 44 }}>
        <Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator> ✓</Select.ItemIndicator>
      </Select.Item>)}</Select.Viewport>
    </Select.Content></Select.Portal>
  </Select.Root>;
}

export function SettingsModal({ open, initialTab = 'voice', projectId, onClose }: {
  open: boolean; initialTab?: 'voice' | 'account' | 'display'; projectId?: number; onClose: () => void;
}) {
  const { data: me } = useMe();
  const { updatePassword } = useAccountSecurityMutations();
  const { saveProfile } = useSettingsMutations(projectId);
  const [tab, setTab] = useState(initialTab);
  const voiceprint = useVoiceprint(projectId, open && tab === 'voice');
  const deleteVoiceprint = useDeleteVoiceprint(projectId);
  const [name, setName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('default');
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [theme, setTheme] = useState(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const stream = useRef<MediaStream | null>(null);
  const context = useRef<AudioContext | null>(null);
  const frame = useRef(0);
  const generation = useRef(0);
  const opener = useRef<HTMLElement | null>(null);
  const stop = useCallback(() => {
    generation.current++;
    cancelAnimationFrame(frame.current);
    stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null;
    void context.current?.close().catch(() => {}); context.current = null;
    setTesting(false); setLevel(0);
  }, []);
  useEffect(() => {
    if (!open) { stop(); setCurrentPassword(''); setNewPassword(''); return; }
    setTab(initialTab); setName(me?.name ?? ''); setNote(null); setError(null);
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    void navigator.mediaDevices?.enumerateDevices().then((all) => setDevices(all.filter((device) => device.kind === 'audioinput'))).catch(() => {});
    return stop;
  }, [open, initialTab, stop]);
  useEffect(() => () => {
    generation.current++; cancelAnimationFrame(frame.current);
    stream.current?.getTracks().forEach((track) => track.stop());
    void context.current?.close().catch(() => {});
  }, []);
  const testMicrophone = async () => {
    stop(); setError(null); setNote(null);
    const ticket = generation.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      const media = await navigator.mediaDevices.getUserMedia({ audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } } });
      if (ticket !== generation.current) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      const audio = new AudioContext(); context.current = audio; await audio.resume();
      if (ticket !== generation.current) return;
      const analyser = audio.createAnalyser(); analyser.fftSize = 512;
      audio.createMediaStreamSource(media).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const draw = () => {
        if (ticket !== generation.current) return;
        analyser.getFloatTimeDomainData(samples);
        setLevel(Math.min(100, Math.round(Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) * 300)));
        frame.current = requestAnimationFrame(draw);
      };
      setTesting(true); draw();
      const all = await navigator.mediaDevices.enumerateDevices();
      if (ticket === generation.current) setDevices(all.filter((device) => device.kind === 'audioinput'));
    } catch {
      if (ticket !== generation.current) return;
      stop(); setError('마이크를 열지 못했습니다. 장치 연결과 브라우저의 마이크 권한을 확인해 주세요');
    }
  };
  const tabs = ['voice', 'account', 'display'] as const;
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-backdrop" />
      <Dialog.Content className="dialog settings-room"
        onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (opener.current?.isConnected) opener.current.focus(); }}>
        <header className="meeting-room__header"><Dialog.Title className="sec__title">환경 설정</Dialog.Title>
          <Dialog.Close asChild><button className="btn btn--ghost">닫기</button></Dialog.Close></header>
        <Dialog.Description className="muted">실제 동작하는 계정 설정과 마이크 점검을 제공합니다.</Dialog.Description>
        <div role="tablist" aria-label="설정 종류" className="meeting-room__tabs">
          {tabs.map((key, index) => <button key={key} id={`settings-tab-${key}`} role="tab" aria-selected={tab === key}
            aria-controls={`settings-panel-${key}`} tabIndex={tab === key ? 0 : -1}
            className={`btn ${tab === key ? 'btn--primary' : 'btn--ghost'}`} onClick={() => { stop(); setTab(key); setError(null); setNote(null); }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault(); stop();
              const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : tabs[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]!;
              setTab(next); document.getElementById(`settings-tab-${next}`)?.focus();
            }}>{key === 'voice' ? '마이크' : key === 'account' ? '계정' : '화면'}</button>)}
        </div>
        <section id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="settings-room__body">
          {tab === 'voice' && <>
            <h2 className="sec__title">마이크 점검</h2>
            <p className="muted">점검 음성은 저장하거나 전송하지 않습니다. 회의 녹음 장치는 녹음 화면에서 확인하세요.</p>
            <label className="field">점검할 마이크<select className="input" value={deviceId} onChange={(event) => { stop(); setDeviceId(event.target.value); }}>
              <option value="default">시스템 기본 마이크</option>
              {devices.filter((device) => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `마이크 ${index + 1}`}</option>)}
            </select></label>
            <button className="btn btn--secondary" onClick={() => { if (testing) stop(); else void testMicrophone(); }}>{testing ? '마이크 점검 종료' : '마이크 점검 시작'}</button>
            {testing && <p role="status">입력 음량 {level}% <meter min={0} max={100} value={level} aria-label="입력 음량" /></p>}
            <h2 className="sec__title">발언자 구분</h2>
            <p>각자의 녹음 트랙으로 발언자를 구분합니다. 성문 자동 매칭과 목소리 보정은 아직 지원하지 않습니다.</p>
            {voiceprint.isError && <Problem>이전 성문 저장 상태를 확인하지 못했습니다.</Problem>}
            {voiceprint.data?.has_stored_data && <button className="btn btn--secondary" disabled={deleteVoiceprint.isPending} onClick={async () => {
              if (!window.confirm('이 프로젝트에 예전에 저장한 내 성문만 삭제할까요?')) return;
              setError(null);
              try { await deleteVoiceprint.mutateAsync(); setNote('저장된 성문을 삭제했습니다'); } catch (value) { setError(apiFailureText(value)); }
            }}>이전에 저장한 내 성문 삭제</button>}
          </>}
          {tab === 'account' && <>
            <p>{me?.email}</p>
            <form onSubmit={async (event) => {
              event.preventDefault(); setError(null); setNote(null);
              try { await saveProfile.mutateAsync({ name }); setNote('이름을 저장했습니다'); } catch (value) { setError(apiFailureText(value)); }
            }}>
              <label className="field">이름<input className="input" value={name} maxLength={80} required onChange={(event) => setName(event.target.value)} autoComplete="name" /></label>
              <button className="btn btn--secondary" disabled={saveProfile.isPending}>이름 저장</button>
            </form>
            <form onSubmit={async (event) => {
              event.preventDefault(); setError(null); setNote(null);
              try {
                await updatePassword.mutateAsync({ current_password: currentPassword, new_password: newPassword });
                setCurrentPassword(''); setNewPassword(''); setNote('비밀번호를 변경했습니다');
              } catch (value) { setError(apiFailureText(value)); }
            }}>
              <h2 className="sec__title">비밀번호 변경</h2>
              <p className="muted">이메일과 비밀번호로 가입한 계정에서 사용할 수 있습니다. Google로만 가입한 계정에는 설정된 비밀번호가 없습니다.</p>
              <label className="field">현재 비밀번호<input className="input" type="password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label>
              <label className="field">새 비밀번호<input className="input" type="password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" /></label>
              <button className="btn btn--secondary" disabled={updatePassword.isPending}>비밀번호 변경</button>
            </form>
            <p className="muted">이메일 인증 발송과 소셜 계정 추가 연결은 아직 지원하지 않습니다. Google 로그인은 로그인 화면에서 이용할 수 있습니다.</p>
          </>}
          {tab === 'display' && <label className="field">화면 테마<select className="input" value={theme} onChange={(event) => {
            const next = event.target.value; document.documentElement.dataset.theme = next; setTheme(next);
            try { localStorage.setItem('tf_theme', next); } catch { setError('이번 창에는 적용했지만 테마 설정을 저장하지 못했습니다'); }
          }}><option value="light">밝은 화면</option><option value="dark">어두운 화면</option></select></label>}
        </section>
        {error && <Problem>{error}</Problem>}{note && <p role="status">{note}</p>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
