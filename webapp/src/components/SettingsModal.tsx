import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import {
  useAccountSecurityMutations,
  useEnrollVoiceprint,
  useLogout,
  useMe,
  useVoiceprint,
  type VoiceprintStatus,
} from '../api/hooks.ts';

export interface AudioPrefs {
  inputDeviceId: string;
  outputDeviceId: string;
  micVolume: number;
  speakerVolume: number;
  inputProfile: 'isolation' | 'studio' | 'custom';
  sensitivity: number;
  noiseSuppressionMode: 'ai' | 'standard' | 'off';
  echoCancellation: boolean;
  autoGainControl: boolean;
}

const PREFS_KEY = 'tf_discord_audio_prefs_v1';

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      return { ...defaultAudioPrefs(), ...(JSON.parse(raw) as Partial<AudioPrefs>) };
    }
  } catch {
    /* ignore */
  }
  return defaultAudioPrefs();
}

export function saveAudioPrefs(prefs: AudioPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

function defaultAudioPrefs(): AudioPrefs {
  return {
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    micVolume: 92,
    speakerVolume: 80,
    inputProfile: 'isolation',
    sensitivity: 42,
    noiseSuppressionMode: 'ai',
    echoCancellation: true,
    autoGainControl: true,
  };
}

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

/**
 * 네이티브 OS `<select>` 팝업 대신 Discord × Linear 스타일 커스텀 팝오버 셀렉트박스.
 * 긴 장치 이름 말줄임, 체크 표시(✓), 다크/라이트 테마 대응, 외부 클릭 닫기를 지원합니다.
 */
export function DiscordSelect({
  id,
  value,
  options,
  icon,
  onChange,
  compact = false,
  warn = false,
  ariaLabel,
}: {
  id?: string;
  value: string;
  options: SelectOption[];
  icon?: ReactNode;
  onChange: (next: string) => void;
  compact?: boolean;
  warn?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = options.find((o) => o.value === value) ?? options[0];

  return (
    <div
      ref={wrapRef}
      className={`dc-cselect ${compact ? 'dc-cselect--compact' : ''} ${open ? 'dc-cselect--open' : ''} ${warn ? 'dc-cselect--warn' : ''}`}
    >
      <button
        id={id}
        type="button"
        className="dc-cselect__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((p) => !p)}
      >
        {icon && <span className="dc-cselect__icon">{icon}</span>}
        <span className="dc-cselect__label">{active?.label ?? '선택'}</span>
        <svg className="dc-cselect__chev" viewBox="0 0 24 24" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="dc-cselect__menu" role="listbox">
          {options.map((opt) => {
            const isSelected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`dc-cselect__opt ${isSelected ? 'dc-cselect__opt--selected' : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <div className="dc-cselect__opt-text">
                  <span className="dc-cselect__opt-main">{opt.label}</span>
                  {opt.sublabel && <span className="dc-cselect__opt-sub">{opt.sublabel}</span>}
                </div>
                {isSelected && (
                  <svg className="dc-cselect__check" viewBox="0 0 24 24" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SettingsModalProps {
  open: boolean;
  initialTab?: 'voice' | 'account' | 'display';
  projectId?: number;
  onClose: () => void;
}

export function SettingsModal({
  open,
  initialTab = 'voice',
  projectId = 1,
  onClose,
}: SettingsModalProps) {
  const { data: me } = useMe();
  const { data: fetchedVp } = useVoiceprint(projectId, open);
  const enrollVoiceMutation = useEnrollVoiceprint(projectId);
  const logoutMutation = useLogout();
  const { sendEmailCode, verifyEmailCode, connectOAuth, updatePassword } =
    useAccountSecurityMutations();

  const [tab, setTab] = useState<'voice' | 'account' | 'display'>(initialTab);
  const [prefs, setPrefs] = useState<AudioPrefs>(() => loadAudioPrefs());
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [micTestError, setMicTestError] = useState<string | null>(null);

  // Mic test state
  const [testingMic, setTestingMic] = useState(false);
  const [meterLevel, setMeterLevel] = useState(0);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  // Voice ID state
  const [vp, setVp] = useState<VoiceprintStatus | null>(null);
  const [vpBusy, setVpBusy] = useState(false);
  const [vpStep, setVpStep] = useState(0);
  const [vpNote, setNote] = useState<string | null>(null);

  // Account & Security state
  const [editingPw, setEditingPw] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [acctNote, setMessage] = useState<string | null>(null);
  const [otpSentCode, setOtpSentCode] = useState<string | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);

  // OAuth linking state in Account tab
  const [linkingProvider, setLinkingProvider] = useState<'google' | 'github' | null>(null);
  const [oauthEmailInput, setOauthEmailInput] = useState('');
  const [oauthHandleInput, setOauthHandleInput] = useState('');
  const [linkedGithub, setLinkedGithub] = useState<string | null>(null);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab, open]);

  useEffect(() => {
    if (fetchedVp) {
      setVp(fetchedVp);
      setVpStep(fetchedVp.steps_completed);
    }
  }, [fetchedVp]);

  const refreshDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const realMics = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== '');
      const realSpeakers = list.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '');
      const realCams = list.filter((d) => d.kind === 'videoinput' && d.deviceId !== '');
      setMics(realMics);
      setSpeakers(realSpeakers);
      setCams(realCams);
      if (realMics.length > 0) {
        setMicTestError(null);
      }
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    if (!open) {
      stopMicTest();
      return;
    }
    void refreshDevices();
    const md = navigator.mediaDevices;
    if (md?.addEventListener) {
      md.addEventListener('devicechange', refreshDevices);
      return () => md.removeEventListener('devicechange', refreshDevices);
    }
    return undefined;
  }, [open, projectId]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const updatePref = <K extends keyof AudioPrefs>(key: K, val: AudioPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: val };
      saveAudioPrefs(next);
      return next;
    });
  };

  const stopMicTest = () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
    }
    audioCtxRef.current = null;
    setTestingMic(false);
    setMeterLevel(0);
  };

  const probeMicHardware = async () => {
    setMicTestError(null);
    await refreshDevices();
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicTestError('이 브라우저 환경에서는 오디오 입력 장치에 접근할 수 없습니다.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      await refreshDevices();
      setMicTestError(null);
    } catch {
      await refreshDevices();
      setMicTestError(
        '컴퓨터에 연결된 마이크 장치를 찾을 수 없거나 마이크 권한이 차단되어 있습니다.',
      );
    }
  };

  const toggleMicTest = async () => {
    if (testingMic) {
      stopMicTest();
      return;
    }
    setMicTestError(null);
    if (mics.length === 0) {
      setMicTestError(
        '연결된 마이크(입력 장치)를 찾을 수 없습니다. 마이크나 헤드셋을 연결한 뒤 다시 시도해 주세요.',
      );
      return;
    }
    setTestingMic(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:
            prefs.inputDeviceId !== 'default' && prefs.inputDeviceId !== 'none'
              ? { ideal: prefs.inputDeviceId }
              : undefined,
          echoCancellation: prefs.echoCancellation,
          noiseSuppression: prefs.noiseSuppressionMode !== 'off',
          autoGainControl: prefs.autoGainControl,
        },
      });
      streamRef.current = stream;
      void refreshDevices();
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] ?? 0;
        const avg = sum / buf.length;
        const scaled = Math.min(
          42,
          Math.max(0, Math.round((avg / 140) * 42 * (prefs.micVolume / 100))),
        );
        setMeterLevel(scaled);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      stopMicTest();
      setMicTestError(
        '마이크 장치를 열 수 없습니다. 연결 상태를 확인하거나 브라우저 마이크 권한을 허용해 주세요.',
      );
    }
  };

  const sampleSpectralFeatures = async (): Promise<number[] | null> => {
    if (mics.length === 0) return null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      src.connect(analyser);
      await new Promise((r) => setTimeout(r, 350));
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
      return Array.from(data.slice(0, 24)).map((v) => Number((v / 255).toFixed(4)));
    } catch {
      return null;
    }
  };

  const enrollVoiceStep = async (nextStep: number, calibrateOnly: boolean) => {
    setVpBusy(true);
    setNote(null);
    try {
      const features = await sampleSpectralFeatures();
      if (features === null) {
        setNote('마이크가 연결되어 있지 않아 목소리를 녹음할 수 없습니다. 마이크를 먼저 연결해 주세요.');
        setVpBusy(false);
        return;
      }
      const res = await enrollVoiceMutation.mutateAsync({
        step: nextStep,
        features,
        calibrate_only: calibrateOnly,
      });
      setVp(res);
      setVpStep(res.steps_completed);
      setNote(res.message);
    } catch (e) {
      setNote(e instanceof ApiError ? e.detail : '목소리 등록에 실패했습니다');
    } finally {
      setVpBusy(false);
    }
  };

  const handleSendOtp = async () => {
    if (!me?.email) return;
    setSendingOtp(true);
    setMessage(null);
    try {
      const out = await sendEmailCode.mutateAsync(me.email);
      setOtpSentCode(out.demo_code);
      setOtpInput(out.demo_code);
      setMessage(out.message);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.detail : '인증 코드 발송 실패');
    } finally {
      setSendingOtp(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (!me?.email || otpInput.trim().length !== 6) return;
    setSendingOtp(true);
    try {
      const out = await verifyEmailCode.mutateAsync({
        email: me.email,
        code: otpInput.trim(),
      });
      setOtpVerified(out.verified);
      setOtpSentCode(null);
      setMessage(out.message);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.detail : '인증 코드가 일치하지 않습니다');
    } finally {
      setSendingOtp(false);
    }
  };

  const openOAuthLinker = (provider: 'google' | 'github') => {
    setLinkingProvider(provider);
    setOauthEmailInput(me?.email ?? '');
    setOauthHandleInput(linkedGithub ?? (me?.email ? me.email.split('@')[0] ?? '' : ''));
  };

  const handleOAuthConnect = async (provider: 'google' | 'github') => {
    setSendingOtp(true);
    const email = oauthEmailInput.trim() || me?.email;
    const handle = oauthHandleInput.trim();
    const name = provider === 'github' && handle ? handle : me?.name;
    try {
      await connectOAuth.mutateAsync({ provider, email, name });
      if (provider === 'github') setLinkedGithub(handle || name || 'connected');
      setLinkingProvider(null);
      setMessage(`${provider === 'google' ? 'Google' : 'GitHub'} 계정 연동이 완료되었습니다`);
    } catch {
      setMessage('소셜 계정 연결에 실패했습니다');
    } finally {
      setSendingOtp(false);
    }
  };

  const handleSavePassword = async () => {
    if (!currentPassword || !newPassword) return;
    setSendingOtp(true);
    setMessage(null);
    try {
      await updatePassword.mutateAsync({
        current_password: currentPassword,
        new_password: newPassword,
      });
      setEditingPw(false);
      setCurrentPassword('');
      setNewPassword('');
      setMessage('비밀번호가 변경되었습니다');
    } catch (e) {
      setMessage(e instanceof ApiError ? e.detail : '비밀번호 변경에 실패했습니다');
    } finally {
      setSendingOtp(false);
    }
  };

  if (!open) return null;

  const hasMic = mics.length > 0;
  const hasCam = cams.length > 0;

  // 실제 브라우저가 감지한 오디오 입력 장치만 표시 (가짜 장치 생성 금지!)
  const micOptions: SelectOption[] = hasMic
    ? mics.map((d, idx) => ({
        value: d.deviceId,
        label:
          d.deviceId === 'default'
            ? d.label || 'Default (시스템 기본 마이크)'
            : d.label || `마이크 입력 장치 #${idx + 1}`,
      }))
    : [
        {
          value: 'none',
          label: '입력 장치 없음',
          sublabel: '연결된 마이크를 찾을 수 없습니다',
        },
      ];

  // 실제 브라우저가 감지한 오디오 출력 장치만 표시
  const speakerOptions: SelectOption[] =
    speakers.length > 0
      ? speakers.map((d, idx) => ({
          value: d.deviceId,
          label:
            d.deviceId === 'default'
              ? d.label || 'Default (시스템 기본 스피커)'
              : d.label || `출력 장치 #${idx + 1}`,
        }))
      : [
          {
            value: 'default',
            label: 'Default (시스템 기본 스피커)',
            sublabel: '운영체제 기본 출력 장치',
          },
        ];

  const noiseOptions: SelectOption[] = [
    { value: 'ai', label: 'AI 소음 제거 (Krisp 급 권장)', sublabel: '키보드 타건음·배경 소음 실시간 차단' },
    { value: 'standard', label: '표준 WebRTC 소음 억제', sublabel: '가벼운 주변 소음 억제' },
    { value: 'off', label: '끄기 (원음 그대로 전달)', sublabel: '조용한 스튜디오 환경용' },
  ];

  const selectedMicValue = hasMic
    ? micOptions.some((o) => o.value === prefs.inputDeviceId)
      ? prefs.inputDeviceId
      : (micOptions[0]?.value ?? 'default')
    : 'none';

  const selectedSpeakerValue = speakerOptions.some((o) => o.value === prefs.outputDeviceId)
    ? prefs.outputDeviceId
    : (speakerOptions[0]?.value ?? 'default');

  return (
    <div className="dc-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dc-modal" role="dialog" aria-modal="true" aria-label="환경 설정">
        {/* Left Navigation Sidebar */}
        <aside className="dc-sidebar">
          <div className="dc-user-card">
            <div className="dc-avatar">{(me?.name ?? '나').slice(0, 1)}</div>
            <div className="dc-user-meta">
              <div className="dc-user-name">{me?.name ?? '사용자'}</div>
              <div className="dc-user-sub">{me?.email ?? '로그인됨'}</div>
            </div>
          </div>

          <div className="dc-nav-group">사용자 설정</div>
          <button
            type="button"
            className={`dc-nav-btn ${tab === 'account' ? 'dc-nav-btn--active' : ''}`}
            onClick={() => setTab('account')}
          >
            <svg className="dc-ic" viewBox="0 0 24 24">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            계정 · 보안
          </button>

          <div className="dc-nav-group">앱 설정</div>
          <button
            type="button"
            className={`dc-nav-btn ${tab === 'voice' ? 'dc-nav-btn--active' : ''}`}
            onClick={() => setTab('voice')}
          >
            <svg className="dc-ic" viewBox="0 0 24 24">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
            음성 및 비디오
          </button>
        </aside>

        {/* Right Main Content */}
        <div className="dc-main">
          <header className="dc-header">
            <span className="dc-header-title">
              {tab === 'voice' ? '음성 및 비디오' : '계정 및 보안'}
            </span>
            <button type="button" className="dc-close-btn" onClick={onClose} aria-label="설정 닫기">
              <svg className="dc-ic" viewBox="0 0 24 24">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </header>

          <div className="dc-content">
            {tab === 'voice' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                  <h2 className="dc-sec-title" style={{ marginBottom: 0 }}>음성 장치</h2>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span className={`dc-badge ${hasMic ? 'dc-badge--ok' : 'dc-badge--warn'}`}>
                      {hasMic ? `마이크 ${mics.length}개 연결됨` : '마이크 미연결'}
                    </span>
                    <span className={`dc-badge ${hasCam ? 'dc-badge--ok' : 'dc-badge--warn'}`}>
                      {hasCam ? `카메라 ${cams.length}개 연결됨` : '카메라 미연결'}
                    </span>
                  </div>
                </div>

                {/* Mic & Speaker Custom Discord Dropdowns */}
                <div className="dc-grid-2">
                  <div>
                    <label className="dc-label" htmlFor="dc-mic-select">
                      마이크 (입력 장치)
                    </label>
                    <DiscordSelect
                      id="dc-mic-select"
                      value={selectedMicValue}
                      options={micOptions}
                      warn={!hasMic}
                      onChange={(val) => updatePref('inputDeviceId', val)}
                      icon={
                        hasMic ? (
                          <svg className="dc-ic" viewBox="0 0 24 24">
                            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          </svg>
                        ) : (
                          <svg className="dc-ic" style={{ color: '#f0b232' }} viewBox="0 0 24 24">
                            <line x1="2" y1="2" x2="22" y2="22" />
                            <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                            <path d="M5 10v2a7 7 0 0 0 12 5" />
                            <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                          </svg>
                        )
                      }
                    />
                  </div>

                  <div>
                    <label className="dc-label" htmlFor="dc-spk-select">
                      스피커 (출력 장치)
                    </label>
                    <DiscordSelect
                      id="dc-spk-select"
                      value={selectedSpeakerValue}
                      options={speakerOptions}
                      onChange={(val) => updatePref('outputDeviceId', val)}
                      icon={
                        <svg className="dc-ic" viewBox="0 0 24 24">
                          <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                          <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
                        </svg>
                      }
                    />
                  </div>
                </div>

                {/* Volume Sliders */}
                <div className="dc-grid-2">
                  <div>
                    <label className="dc-label" htmlFor="dc-mic-vol">
                      마이크 음량 ({prefs.micVolume}%)
                    </label>
                    <input
                      id="dc-mic-vol"
                      type="range"
                      className="dc-range"
                      min={0}
                      max={100}
                      disabled={!hasMic}
                      value={prefs.micVolume}
                      onChange={(e) => updatePref('micVolume', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="dc-label" htmlFor="dc-spk-vol">
                      스피커 음량 ({prefs.speakerVolume}%)
                    </label>
                    <input
                      id="dc-spk-vol"
                      type="range"
                      className="dc-range"
                      min={0}
                      max={100}
                      value={prefs.speakerVolume}
                      onChange={(e) => updatePref('speakerVolume', Number(e.target.value))}
                    />
                  </div>
                </div>

                {/* Mic Test & 42-bar Level Meter */}
                <div className="dc-mic-test">
                  <button
                    type="button"
                    className={`dc-btn ${!hasMic ? 'dc-btn--ghost' : testingMic ? 'dc-btn--green' : 'dc-btn--blurple'}`}
                    onClick={() => void toggleMicTest()}
                  >
                    {!hasMic ? '마이크 없음' : testingMic ? '테스트 중지' : '마이크 테스트'}
                  </button>
                  <div className="dc-meter" aria-label="마이크 입력 레벨 미터">
                    {Array.from({ length: 42 }).map((_, idx) => (
                      <span
                        key={idx}
                        className={`dc-meter-bar ${testingMic && idx < meterLevel ? 'dc-meter-bar--on' : ''}`}
                      />
                    ))}
                  </div>
                </div>

                {/* Discord-style Hardware Warning Banner when no mic is connected */}
                {(!hasMic || micTestError) && (
                  <div className="dc-hw-warn" role="alert">
                    <svg className="dc-ic" style={{ color: '#f0b232', marginTop: '1px' }} viewBox="0 0 24 24">
                      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <div className="dc-hw-warn__text">
                      <strong>
                        {micTestError ?? '사용할 수 있는 녹음 장치(마이크)가 없어요.'}
                      </strong>
                      <span>
                        입력 감도를 확인하거나 회의에서 음성으로 발언하려면 마이크나 헤드셋을 PC에 연결한 뒤 [장치 다시 확인]을 눌러 주세요.
                      </span>
                    </div>
                    <button
                      type="button"
                      className="dc-btn dc-btn--ghost"
                      onClick={() => void probeMicHardware()}
                    >
                      장치 다시 확인
                    </button>
                  </div>
                )}

                <div className="dc-hr" />

                {/* Custom Discord Radio Cards for Input Profile */}
                <div className="dc-label">입력 프로필</div>
                <div className="dc-radio-list" role="radiogroup" aria-label="입력 프로필">
                  {(
                    [
                      {
                        key: 'isolation',
                        title: '음성 격리',
                        sub: '목소리만 선명하게 전달하고 주변 소음은 AI가 제거합니다',
                      },
                      {
                        key: 'studio',
                        title: '스튜디오',
                        sub: '순수 오디오: 프로세싱 없이 원음 그대로 마이크 열기',
                      },
                      {
                        key: 'custom',
                        title: '사용자 지정',
                        sub: '고급 모드: 감도와 소음 억제를 직접 제어합니다',
                      },
                    ] as const
                  ).map((item) => {
                    const checked = prefs.inputProfile === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        className={`dc-radio-card ${checked ? 'dc-radio-card--checked' : ''}`}
                        onClick={() => updatePref('inputProfile', item.key)}
                      >
                        <span className={`dc-radio-dot ${checked ? 'dc-radio-dot--on' : ''}`} />
                        <div className="dc-radio-body">
                          <div className="dc-r-title">{item.title}</div>
                          <div className="dc-r-sub">{item.sub}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Input Sensitivity */}
                <label className="dc-label" htmlFor="dc-sens-range">
                  입력 감도 ({prefs.sensitivity}dB)
                </label>
                <input
                  id="dc-sens-range"
                  type="range"
                  className="dc-range dc-range--green"
                  min={0}
                  max={100}
                  value={prefs.sensitivity}
                  onChange={(e) => updatePref('sensitivity', Number(e.target.value))}
                />

                {/* Noise Suppression & Echo Cancellation */}
                <div className="dc-toggle-row">
                  <div>
                    <div className="dc-r-title">잡음 제거</div>
                    <div className="dc-r-sub">마이크의 배경 소음을 억제합니다</div>
                  </div>
                  <div style={{ width: '240px' }}>
                    <DiscordSelect
                      compact
                      value={prefs.noiseSuppressionMode}
                      options={noiseOptions}
                      onChange={(val) =>
                        updatePref('noiseSuppressionMode', val as AudioPrefs['noiseSuppressionMode'])
                      }
                    />
                  </div>
                </div>

                <div className="dc-toggle-row">
                  <div className="dc-r-title">에코 억제</div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={prefs.echoCancellation}
                    className={`dc-switch ${prefs.echoCancellation ? 'dc-switch--on' : ''}`}
                    onClick={() => updatePref('echoCancellation', !prefs.echoCancellation)}
                  />
                </div>

                <div className="dc-hr" />

                {/* Voice ID (Speaker Biometrics) Cleanly Integrated */}
                <div className="dc-voiceid-card">
                  <div className="dc-voiceid-hdr">
                    <div className="dc-voiceid-title">
                      <svg className="dc-ic" viewBox="0 0 24 24">
                        <path d="M2 10v3" />
                        <path d="M6 6v11" />
                        <path d="M10 3v18" />
                        <path d="M14 8v7" />
                        <path d="M18 5v13" />
                        <path d="M22 10v3" />
                      </svg>
                      <div>
                        <div className="dc-r-title">내 목소리 등록</div>
                        <div className="dc-r-sub">
                          내 목소리를 미리 등록해 두면 회의에서 누가 말했는지 자동으로 구분합니다
                        </div>
                      </div>
                    </div>
                    <span className={`dc-badge ${vp?.enrolled ? 'dc-badge--ok' : ''}`}>
                      {vp?.enrolled ? '등록 완료' : '미등록'}
                    </span>
                  </div>

                  <div className="dc-voiceid-steps">
                    {[
                      { step: 1, label: '1. 평소 대화 톤' },
                      { step: 2, label: '2. 발표·강조 톤' },
                      { step: 3, label: '3. 낮은·잠긴 톤' },
                    ].map((s) => {
                      const done = vpStep >= s.step;
                      return (
                        <button
                          key={s.step}
                          type="button"
                          disabled={vpBusy}
                          className={`dc-step-btn ${done ? 'dc-step-btn--done' : ''}`}
                          onClick={() => void enrollVoiceStep(s.step, false)}
                        >
                          <span>{s.label}</span>
                          <span>{done ? '✓' : hasMic ? '녹음' : '마이크 필요'}</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="dc-voiceid-foot">
                    <span className="dc-r-sub">
                      감기나 목잠김으로 목소리가 달라진 날에는 다시 맞추기를 눌러 주세요
                    </span>
                    <button
                      type="button"
                      disabled={vpBusy}
                      className="dc-btn dc-btn--ghost"
                      onClick={() => void enrollVoiceStep(3, true)}
                    >
                      목소리 다시 맞추기
                    </button>
                  </div>
                  {vpNote && <p className="dc-note-ok">{vpNote}</p>}
                </div>
              </>
            )}

            {tab === 'account' && (
              <>
                <h2 className="dc-sec-title">비밀번호 및 보안</h2>

                <div className="dc-acct-row">
                  <div>
                    <div className="dc-r-title">비밀번호</div>
                    <div className="dc-r-sub">계정 로그인 비밀번호를 변경합니다</div>
                  </div>
                  <button
                    type="button"
                    className="dc-btn dc-btn--ghost"
                    onClick={() => setEditingPw(!editingPw)}
                  >
                    {editingPw ? '취소' : '수정'}
                  </button>
                </div>

                {editingPw && (
                  <div className="dc-pw-box">
                    <input
                      type="password"
                      className="dc-input"
                      placeholder="현재 비밀번호"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                    />
                    <input
                      type="password"
                      className="dc-input"
                      placeholder="새 비밀번호 (8자 이상)"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={sendingOtp}
                      className="dc-btn dc-btn--blurple"
                      onClick={() => void handleSavePassword()}
                    >
                      비밀번호 저장
                    </button>
                  </div>
                )}

                <div className="dc-acct-row">
                  <div>
                    <div className="dc-r-title">이메일 본인 인증</div>
                    <div className="dc-r-sub">{me?.email ?? '이메일 미등록'}</div>
                  </div>
                  {otpVerified ? (
                    <span className="dc-badge dc-badge--ok">인증됨 ✓</span>
                  ) : (
                    <button
                      type="button"
                      disabled={sendingOtp}
                      className="dc-btn dc-btn--blurple"
                      onClick={() => void handleSendOtp()}
                    >
                      인증번호 발송
                    </button>
                  )}
                </div>

                {otpSentCode !== null && !otpVerified && (
                  <div className="dc-pw-box">
                    <input
                      type="text"
                      maxLength={6}
                      className="dc-input num"
                      placeholder="6자리 코드 입력"
                      value={otpInput}
                      onChange={(e) => setOtpInput(e.target.value)}
                    />
                    <button
                      type="button"
                      disabled={sendingOtp}
                      className="dc-btn dc-btn--blurple"
                      onClick={() => void handleVerifyOtp()}
                    >
                      인증 확인
                    </button>
                  </div>
                )}

                <div className="dc-acct-row">
                  <div>
                    <div className="dc-r-title">연결된 소셜 계정 (Google · GitHub)</div>
                    <div className="dc-r-sub">
                      Google ({me?.email ?? '미연결'}) · GitHub (
                      {linkedGithub ? `@${linkedGithub}` : '연결 가능'})
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      disabled={sendingOtp}
                      className="dc-btn dc-btn--ghost"
                      onClick={() => openOAuthLinker('google')}
                    >
                      Google 계정 변경/연동
                    </button>
                    <button
                      type="button"
                      disabled={sendingOtp}
                      className="dc-btn dc-btn--ghost"
                      onClick={() => openOAuthLinker('github')}
                    >
                      GitHub 계정 변경/연동
                    </button>
                  </div>
                </div>

                {linkingProvider !== null && (
                  <div className="dc-pw-box">
                    <div className="dc-r-title">
                      {linkingProvider === 'google'
                        ? '연동할 Google 계정 이메일 입력'
                        : '연동할 GitHub 아이디(@username) 및 이메일 입력'}
                    </div>
                    <input
                      type="email"
                      className="dc-input"
                      placeholder="예: myaccount@gmail.com"
                      value={oauthEmailInput}
                      onChange={(e) => setOauthEmailInput(e.target.value)}
                    />
                    {linkingProvider === 'github' && (
                      <input
                        type="text"
                        className="dc-input"
                        placeholder="GitHub 아이디 (예: octocat)"
                        value={oauthHandleInput}
                        onChange={(e) => setOauthHandleInput(e.target.value)}
                      />
                    )}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        type="button"
                        disabled={sendingOtp}
                        className="dc-btn dc-btn--blurple"
                        onClick={() => void handleOAuthConnect(linkingProvider)}
                      >
                        계정 연결 저장
                      </button>
                      <button
                        type="button"
                        className="dc-btn dc-btn--ghost"
                        onClick={() => setLinkingProvider(null)}
                      >
                        취소
                      </button>
                    </div>
                  </div>
                )}

                {acctNote && <p className="dc-note-ok">{acctNote}</p>}

                <div className="dc-acct-row" style={{ marginTop: '24px', borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '16px' }}>
                  <div>
                    <div className="dc-r-title">로그아웃</div>
                    <div className="dc-r-sub">현재 기기에서 계정을 로그아웃합니다</div>
                  </div>
                  <button
                    type="button"
                    className="dc-btn dc-btn--danger"
                    onClick={() => {
                      logoutMutation.mutate(undefined, {
                        onSuccess: () => {
                          window.location.href = '/app/login';
                        },
                        onError: (e) => {
                          setMessage(e instanceof ApiError ? e.detail : '로그아웃 실패');
                        },
                      });
                    }}
                  >
                    로그아웃
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
