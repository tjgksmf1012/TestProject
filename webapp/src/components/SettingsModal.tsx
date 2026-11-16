import * as Dialog from '@radix-ui/react-dialog';
import * as Select from '@radix-ui/react-select';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { appRailHref } from '@lib/nav/rail.ts';
import { describeLogoutFailure, logoutOutcome } from '@lib/auth/session.ts';
import { apiFailureText, ApiError } from '../api/client.ts';
import {
  useAccountSecurityMutations,
  useDeleteVoiceprint,
  useLogout,
  useMe,
  useSettingsMutations,
  useVoiceprint,
} from '../api/hooks.ts';
import { Problem } from './Problem.tsx';

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

export interface AudioPrefs {
  inputDeviceId: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  micGain: number;
}

const PREFS_KEY = 'tf_audio_prefs_v1';

function defaultAudioPrefs(): AudioPrefs {
  return {
    inputDeviceId: 'default',
    echoCancellation: true,
    noiseSuppression: true,
    micGain: 100,
  };
}

function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return defaultAudioPrefs();
    const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      inputDeviceId: typeof parsed.inputDeviceId === 'string' ? parsed.inputDeviceId : 'default',
      echoCancellation: parsed.echoCancellation !== false,
      noiseSuppression: parsed.noiseSuppression !== false,
      micGain: typeof parsed.micGain === 'number' ? Math.min(150, Math.max(50, parsed.micGain)) : 100,
    };
  } catch {
    return defaultAudioPrefs();
  }
}

function saveAudioPrefs(prefs: AudioPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore storage quota failures */
  }
}

/** 원래 선택 API를 유지하며 키보드와 초점 처리는 Radix가 담당합니다. */
export function DiscordSelect({
  id,
  value,
  options,
  icon,
  onChange,
  compact = false,
  warn = false,
  ariaLabel,
  variant = 'surface',
}: {
  id?: string;
  value: string;
  options: SelectOption[];
  icon?: ReactNode;
  onChange: (value: string) => void;
  compact?: boolean;
  warn?: boolean;
  ariaLabel?: string;
  variant?: 'surface' | 'dark';
}) {
  // 빈 문자열도 '전체 담당자'처럼 실제 선택지입니다. Radix의 미선택 값과 구분합니다.
  const encoded = (entry: string) => `option:${entry}`;
  const isDark = variant === 'dark';
  const contentStyle = isDark
    ? {
        zIndex: 300,
        background: '#111214',
        color: '#f2f3f5',
        border: '1px solid rgba(255, 255, 255, 0.16)',
        padding: 8,
      }
    : {
        zIndex: 300,
        background: 'var(--c-surface)',
        color: 'var(--c-ink)',
        border: '1px solid var(--c-line)',
        padding: 8,
      };
  return (
    <Select.Root value={encoded(value)} onValueChange={(next) => onChange(next.slice(7))}>
      <Select.Trigger
        id={id}
        aria-label={ariaLabel}
        className={`${isDark ? 'dc-cselect__trigger' : 'input'} ${compact ? (isDark ? 'dc-cselect--compact' : 'input--compact') : ''}`}
        data-warn={warn || undefined}
      >
        {icon && <span className={isDark ? 'dc-cselect__icon' : undefined}>{icon}</span>}
        <span className={isDark ? 'dc-cselect__label' : undefined}>
          <Select.Value placeholder="선택하세요" />
        </span>
        <Select.Icon> ▾</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="picker__content" position="popper" style={contentStyle}>
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={encoded(option.value)}
                className={isDark ? 'dc-cselect__opt' : 'btn btn--ghost'}
                style={{ display: 'flex', minHeight: 44, alignItems: 'center', gap: 8 }}
              >
                <div className={isDark ? 'dc-cselect__opt-text' : undefined}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  {option.sublabel && isDark && (
                    <span className="dc-cselect__opt-sub">{option.sublabel}</span>
                  )}
                </div>
                <Select.ItemIndicator> ✓</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

const SETTINGS_TABS = ['voice', 'account', 'display'] as const;

export function SettingsModal({
  open,
  initialTab = 'voice',
  projectId,
  onClose,
}: {
  open: boolean;
  initialTab?: 'voice' | 'account' | 'display';
  projectId?: number;
  onClose: () => void;
}) {
  const { data: me } = useMe();
  const { updatePassword } = useAccountSecurityMutations();
  const { saveProfile } = useSettingsMutations(projectId);
  const logoutMutation = useLogout();
  const [tab, setTab] = useState<'voice' | 'account' | 'display'>(initialTab);
  const voiceprint = useVoiceprint(projectId, open && tab === 'voice');
  const deleteVoiceprint = useDeleteVoiceprint(projectId);

  const [prefs, setPrefs] = useState<AudioPrefs>(() => loadAudioPrefs());
  const [name, setName] = useState('');
  const [editingPw, setEditingPw] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  );

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const frameRef = useRef(0);
  const generationRef = useRef(0);
  const openerRef = useRef<HTMLElement | null>(null);

  const stopMicCheck = useCallback(() => {
    generationRef.current++;
    cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    setTesting(false);
    setLevel(0);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setMics(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== ''));
      setSpeakers(all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== ''));
      setCams(all.filter((d) => d.kind === 'videoinput' && d.deviceId !== ''));
    } catch {
      /* ignore device enumeration failures */
    }
  }, []);

  useEffect(() => {
    if (!open) {
      stopMicCheck();
      setCurrentPassword('');
      setNewPassword('');
      setEditingPw(false);
      return;
    }
    setTab(initialTab);
    setNote(null);
    setError(null);
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    void refreshDevices();
    const md = navigator.mediaDevices;
    md?.addEventListener?.('devicechange', refreshDevices);
    return () => {
      md?.removeEventListener?.('devicechange', refreshDevices);
      stopMicCheck();
    };
  }, [open, initialTab, refreshDevices, stopMicCheck]);

  useEffect(() => {
    if (open && me?.name !== undefined) {
      setName(me.name);
    }
  }, [open, me?.name]);

  useEffect(
    () => () => {
      generationRef.current++;
      cancelAnimationFrame(frameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      void contextRef.current?.close().catch(() => undefined);
    },
    [],
  );

  const updatePref = <K extends keyof AudioPrefs>(key: K, val: AudioPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: val };
      saveAudioPrefs(next);
      return next;
    });
  };

  const probeDevicesWithPermission = async () => {
    setError(null);
    setNote(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('이 브라우저에서는 오디오 장치에 접근할 수 없습니다.');
      return;
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      media.getTracks().forEach((t) => t.stop());
      await refreshDevices();
      setNote('연결된 오디오 장치 목록을 새로 확인했습니다.');
    } catch {
      await refreshDevices();
      setError('마이크를 찾지 못했거나 브라우저 마이크 권한이 차단되어 있습니다.');
    }
  };

  const toggleMicCheck = async () => {
    if (testing) {
      stopMicCheck();
      return;
    }
    stopMicCheck();
    setError(null);
    setNote(null);
    const ticket = generationRef.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      const audioConstraint: MediaTrackConstraints | boolean =
        prefs.inputDeviceId !== 'default'
          ? {
              deviceId: { exact: prefs.inputDeviceId },
              echoCancellation: prefs.echoCancellation,
              noiseSuppression: prefs.noiseSuppression,
            }
          : {
              echoCancellation: prefs.echoCancellation,
              noiseSuppression: prefs.noiseSuppression,
            };
      const media = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
      if (ticket !== generationRef.current) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = media;
      const audio = new AudioContext();
      contextRef.current = audio;
      await audio.resume();
      if (ticket !== generationRef.current) return;
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(media).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const draw = () => {
        if (ticket !== generationRef.current) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, s) => sum + s * s, 0) / samples.length);
        const scaled = Math.min(100, Math.round(rms * 300 * (prefs.micGain / 100)));
        setLevel(scaled);
        frameRef.current = requestAnimationFrame(draw);
      };
      setTesting(true);
      draw();
      await refreshDevices();
    } catch {
      if (ticket !== generationRef.current) return;
      stopMicCheck();
      setError('마이크를 열지 못했습니다. 장치 연결과 브라우저의 마이크 권한을 확인해 주세요.');
    }
  };

  const applyTheme = (next: 'light' | 'dark') => {
    document.documentElement.dataset.theme = next;
    setTheme(next);
    setError(null);
    try {
      window.localStorage.setItem('tf_theme', next);
      setNote(`${next === 'dark' ? '어두운' : '밝은'} 화면 테마로 전환했습니다.`);
    } catch {
      setError('이번 창에는 적용했지만 테마 설정을 브라우저에 저장하지 못했습니다.');
    }
  };

  const handleLogout = () => {
    setError(null);
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        window.location.href = '/app/login';
      },
      onError: (err) => {
        const status = err instanceof ApiError ? (err.status === 0 ? null : err.status) : null;
        if (logoutOutcome(status) === 'done') {
          window.location.href = '/app/login';
          return;
        }
        setError(describeLogoutFailure(status));
      },
    });
  };

  const micOptions: SelectOption[] = [
    { value: 'default', label: '시스템 기본 마이크' },
    ...mics
      .filter((d) => d.deviceId !== 'default')
      .map((d, idx) => ({
        value: d.deviceId,
        label: d.label || `마이크 입력 장치 #${idx + 1}`,
      })),
  ];

  const selectedMicValue = micOptions.some((o) => o.value === prefs.inputDeviceId)
    ? prefs.inputDeviceId
    : 'default';

  const activeBars = Math.round((level / 100) * 42);
  const tabTitle =
    tab === 'voice' ? '마이크 및 오디오' : tab === 'account' ? '계정 · 보안' : '화면 테마';

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dc-overlay dc-overlay--portal" />
        <Dialog.Content
          className="dc-modal dc-modal--portal"
          onOpenAutoFocus={() => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            stopMicCheck();
            if (openerRef.current?.isConnected) openerRef.current.focus();
          }}
        >
          <aside className="dc-sidebar">
            <div className="dc-user-card">
              {me?.avatar ? (
                <img src={me.avatar} alt="" className="dc-avatar dc-avatar--img" />
              ) : (
                <div className="dc-avatar">{(me?.name ?? '나').slice(0, 1)}</div>
              )}
              <div className="dc-user-meta">
                <div className="dc-user-name">{me?.name ?? '사용자'}</div>
                <div className="dc-user-sub">{me?.email ?? '로그인됨'}</div>
              </div>
            </div>

            <div className="dc-nav-group">환경 설정</div>
            <div role="tablist" aria-label="설정 종류" className="dc-tablist">
              {SETTINGS_TABS.map((key, index) => (
                <button
                  key={key}
                  id={`settings-tab-${key}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === key}
                  aria-controls={`settings-panel-${key}`}
                  tabIndex={tab === key ? 0 : -1}
                  className={`dc-nav-btn ${tab === key ? 'dc-nav-btn--active' : ''}`}
                  onClick={() => {
                    stopMicCheck();
                    setTab(key);
                    setError(null);
                    setNote(null);
                  }}
                  onKeyDown={(event) => {
                    if (
                      !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                        event.key,
                      )
                    ) {
                      return;
                    }
                    event.preventDefault();
                    stopMicCheck();
                    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : 2;
                    const next =
                      event.key === 'Home'
                        ? SETTINGS_TABS[0]
                        : event.key === 'End'
                          ? SETTINGS_TABS[2]
                          : SETTINGS_TABS[(index + step) % 3]!;
                    setTab(next);
                    setError(null);
                    setNote(null);
                    document.getElementById(`settings-tab-${next}`)?.focus();
                  }}
                >
                  {key === 'voice' ? '마이크' : key === 'account' ? '계정' : '화면'}
                </button>
              ))}
            </div>

            {projectId !== undefined && (
              <>
                <div className="dc-nav-group">프로젝트</div>
                <Link
                  to={appRailHref('project', projectId)}
                  className="dc-nav-btn"
                  style={{ textDecoration: 'none' }}
                  onClick={onClose}
                >
                  역할·GitHub 상세 설정 →
                </Link>
              </>
            )}
          </aside>

          <div className="dc-main">
            <header className="dc-header">
              <div>
                <Dialog.Title className="dc-header-title">환경 설정</Dialog.Title>
                <Dialog.Description className="dc-header-sub">
                  {tabTitle} — 실제 동작하는 장치 점검과 계정 설정만 제공합니다.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="dc-close-btn" aria-label="설정 닫기">
                  <svg className="dc-ic" viewBox="0 0 24 24" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </Dialog.Close>
            </header>

            <div className="dc-content">
              <section
                id={`settings-panel-${tab}`}
                role="tabpanel"
                aria-labelledby={`settings-tab-${tab}`}
              >
                {tab === 'voice' && (
                  <>
                    <div className="dc-sec-head-row">
                      <h2 className="dc-sec-title" style={{ marginBottom: 0 }}>
                        마이크 점검
                      </h2>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <span className={`dc-badge ${mics.length > 0 ? 'dc-badge--ok' : ''}`}>
                          {mics.length > 0 ? `마이크 ${mics.length}개` : '마이크 미확인'}
                        </span>
                        <span className={`dc-badge ${cams.length > 0 ? 'dc-badge--ok' : ''}`}>
                          {cams.length > 0 ? `카메라 ${cams.length}개` : '카메라 미확인'}
                        </span>
                        {speakers.length > 0 && (
                          <span className="dc-badge">스피커 {speakers.length}개</span>
                        )}
                      </div>
                    </div>

                    <p className="dc-r-sub" style={{ marginBottom: '14px' }}>
                      점검 음성은 서버로 보내지 않습니다. 회의 녹음 장치는 음성 회의실의 녹음 탭에서
                      확인하세요.
                    </p>

                    <div className="dc-grid-2">
                      <div>
                        <label className="dc-label" htmlFor="dc-mic-select">
                          점검할 마이크
                        </label>
                        <DiscordSelect
                          id="dc-mic-select"
                          ariaLabel="점검할 마이크"
                          variant="dark"
                          value={selectedMicValue}
                          options={micOptions}
                          warn={mics.length === 0}
                          onChange={(val) => {
                            stopMicCheck();
                            updatePref('inputDeviceId', val);
                          }}
                        />
                      </div>

                      <div>
                        <div className="dc-label">감지된 장치 새로고침</div>
                        <button
                          type="button"
                          className="dc-btn dc-btn--ghost"
                          style={{ width: '100%', height: '40px' }}
                          onClick={() => void probeDevicesWithPermission()}
                        >
                          장치 다시 확인
                        </button>
                      </div>
                    </div>

                    <div className="dc-mic-test">
                      <button
                        type="button"
                        className={`dc-btn ${testing ? 'dc-btn--green' : 'dc-btn--blurple'}`}
                        onClick={() => {
                          if (testing) stopMicCheck();
                          else void toggleMicCheck();
                        }}
                      >
                        {testing ? '마이크 점검 종료' : '마이크 점검 시작'}
                      </button>

                      <div className="dc-meter" aria-hidden="true">
                        {Array.from({ length: 42 }).map((_, idx) => (
                          <span
                            key={idx}
                            className={`dc-meter-bar ${testing && idx < activeBars ? 'dc-meter-bar--on' : ''}`}
                          />
                        ))}
                      </div>
                    </div>

                    {testing && (
                      <p role="status" className="dc-note-ok" style={{ marginTop: 0, marginBottom: '12px' }}>
                        입력 음량 {level}%{' '}
                        <meter
                          min={0}
                          max={100}
                          value={level}
                          aria-label="입력 음량"
                          style={{ verticalAlign: 'middle', marginLeft: '6px' }}
                        />
                      </p>
                    )}

                    <div className="dc-hr" />

                    <div className="dc-label">점검 오디오 옵션 (이 브라우저에 저장되는 로컬 설정)</div>
                    <div className="dc-toggle-row">
                      <div>
                        <div className="dc-r-title">브라우저 잡음 억제</div>
                        <div className="dc-r-sub">마이크 점검 시 브라우저 WebAudio 잡음 억제를 켭니다</div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="브라우저 잡음 억제"
                        aria-checked={prefs.noiseSuppression}
                        className={`dc-switch ${prefs.noiseSuppression ? 'dc-switch--on' : ''}`}
                        onClick={() => {
                          stopMicCheck();
                          updatePref('noiseSuppression', !prefs.noiseSuppression);
                        }}
                      />
                    </div>
                    <div className="dc-toggle-row">
                      <div>
                        <div className="dc-r-title">브라우저 에코 억제</div>
                        <div className="dc-r-sub">스피커 소리가 마이크로 되돌아가는 울림을 줄입니다</div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label="브라우저 에코 억제"
                        aria-checked={prefs.echoCancellation}
                        className={`dc-switch ${prefs.echoCancellation ? 'dc-switch--on' : ''}`}
                        onClick={() => {
                          stopMicCheck();
                          updatePref('echoCancellation', !prefs.echoCancellation);
                        }}
                      />
                    </div>

                    <div className="dc-hr" />

                    <div className="dc-voiceid-card">
                      <div className="dc-voiceid-hdr">
                        <div className="dc-voiceid-title">
                          <div>
                            <div className="dc-r-title">발언자 구분 안내</div>
                            <div className="dc-r-sub">
                              각자의 녹음 트랙으로 발언자를 구분합니다. 성문 자동 매칭과 목소리
                              보정은 아직 지원하지 않습니다.
                            </div>
                          </div>
                        </div>
                        <span className="dc-badge">트랙 기준</span>
                      </div>

                      {voiceprint.isError && (
                        <div className="dc-problem">
                          <Problem>이전 성문 저장 상태를 확인하지 못했습니다.</Problem>
                        </div>
                      )}

                      {voiceprint.data?.has_stored_data && (
                        <div className="dc-voiceid-foot">
                          <span className="dc-r-sub">
                            이 프로젝트에 예전에 저장된 성문 데이터가 남아 있습니다.
                          </span>
                          <button
                            type="button"
                            className="dc-btn dc-btn--danger"
                            disabled={deleteVoiceprint.isPending}
                            onClick={async () => {
                              if (!window.confirm('이 프로젝트에 예전에 저장한 내 성문만 삭제할까요?')) {
                                return;
                              }
                              setError(null);
                              setNote(null);
                              try {
                                await deleteVoiceprint.mutateAsync();
                                setNote('저장된 성문을 삭제했습니다.');
                              } catch (value) {
                                setError(apiFailureText(value));
                              }
                            }}
                          >
                            이전에 저장한 내 성문 삭제
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                )}

                {tab === 'account' && (
                  <>
                    <h2 className="dc-sec-title">계정 및 보안</h2>

                    <div className="dc-acct-row">
                      <div>
                        <div className="dc-r-title">이메일 계정</div>
                        <div className="dc-r-sub">{me?.email ?? '로그인 정보 없음'}</div>
                      </div>
                      <span className="dc-badge dc-badge--ok">인증 세션</span>
                    </div>

                    <form
                      className="dc-pw-box"
                      onSubmit={async (event) => {
                        event.preventDefault();
                        setError(null);
                        setNote(null);
                        const trimmed = name.trim();
                        if (!trimmed || trimmed.length > 80) {
                          setError('이름은 1~80자로 적어 주세요.');
                          return;
                        }
                        try {
                          await saveProfile.mutateAsync({ name: trimmed });
                          setNote('이름을 저장했습니다.');
                        } catch (value) {
                          setError(apiFailureText(value));
                        }
                      }}
                    >
                      <label className="dc-label" htmlFor="settings-profile-name">
                        표시 이름
                      </label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          id="settings-profile-name"
                          className="dc-input"
                          value={name}
                          maxLength={80}
                          required
                          onChange={(event) => setName(event.target.value)}
                          autoComplete="name"
                        />
                        <button
                          type="submit"
                          className="dc-btn dc-btn--blurple"
                          disabled={saveProfile.isPending}
                        >
                          이름 저장
                        </button>
                      </div>
                    </form>

                    <div className="dc-acct-row">
                      <div>
                        <div className="dc-r-title">비밀번호 변경</div>
                        <div className="dc-r-sub">
                          이메일과 비밀번호로 가입한 계정에서 사용할 수 있습니다 (Google 전용 계정은
                          비밀번호가 없습니다).
                        </div>
                      </div>
                      <button
                        type="button"
                        className="dc-btn dc-btn--ghost"
                        onClick={() => {
                          setEditingPw((prev) => !prev);
                          setError(null);
                        }}
                      >
                        {editingPw ? '취소' : '수정'}
                      </button>
                    </div>

                    {editingPw && (
                      <form
                        className="dc-pw-box"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          setError(null);
                          setNote(null);
                          if (newPassword.length < 8) {
                            setError('새 비밀번호는 8자 이상이어야 합니다.');
                            return;
                          }
                          try {
                            await updatePassword.mutateAsync({
                              current_password: currentPassword,
                              new_password: newPassword,
                            });
                            setCurrentPassword('');
                            setNewPassword('');
                            setEditingPw(false);
                            setNote('비밀번호를 변경했습니다.');
                          } catch (value) {
                            setError(apiFailureText(value));
                          }
                        }}
                      >
                        <label className="dc-label" htmlFor="settings-current-pw">
                          현재 비밀번호
                        </label>
                        <input
                          id="settings-current-pw"
                          type="password"
                          className="dc-input"
                          required
                          value={currentPassword}
                          onChange={(event) => setCurrentPassword(event.target.value)}
                          autoComplete="current-password"
                        />
                        <label className="dc-label" htmlFor="settings-new-pw">
                          새 비밀번호 (8자 이상)
                        </label>
                        <input
                          id="settings-new-pw"
                          type="password"
                          className="dc-input"
                          required
                          value={newPassword}
                          onChange={(event) => setNewPassword(event.target.value)}
                          autoComplete="new-password"
                        />
                        <div>
                          <button
                            type="submit"
                            className="dc-btn dc-btn--blurple"
                            disabled={updatePassword.isPending}
                          >
                            비밀번호 변경
                          </button>
                        </div>
                      </form>
                    )}

                    <div className="dc-acct-row">
                      <div>
                        <div className="dc-r-title">소셜 로그인 및 GitHub 기여도 연결</div>
                        <div className="dc-r-sub">
                          Google 로그인은 로그인 화면에서 공식 OAuth 2.0으로 이용합니다. 이메일 인증
                          발송은 아직 지원하지 않으며, GitHub 아이디는 프로젝트 설정에서 등록합니다.
                        </div>
                      </div>
                      {projectId !== undefined && (
                        <Link
                          to={`/project/${projectId}/settings/github`}
                          className="dc-btn dc-btn--ghost"
                          style={{ textDecoration: 'none' }}
                          onClick={onClose}
                        >
                          GitHub 설정
                        </Link>
                      )}
                    </div>

                    <div className="dc-acct-row" style={{ borderBottom: 'none' }}>
                      <div>
                        <div className="dc-r-title">로그아웃</div>
                        <div className="dc-r-sub">현재 기기의 인증 세션을 종료합니다</div>
                      </div>
                      <button
                        type="button"
                        className="dc-btn dc-btn--danger"
                        disabled={logoutMutation.isPending}
                        onClick={handleLogout}
                      >
                        로그아웃
                      </button>
                    </div>
                  </>
                )}

                {tab === 'display' && (
                  <>
                    <h2 className="dc-sec-title">화면 테마</h2>
                    <p className="dc-r-sub" style={{ marginBottom: '14px' }}>
                      상단 툴바의 테마 버튼과 설정이 같은 상태를 공유합니다.
                    </p>
                    <div className="dc-radio-list" role="radiogroup" aria-label="화면 테마 선택">
                      {(
                        [
                          {
                            key: 'light',
                            title: '밝은 화면',
                            sub: '명확한 문서 대비의 기본 라이트 모드입니다.',
                          },
                          {
                            key: 'dark',
                            title: '어두운 화면',
                            sub: '야간 작업에 맞춘 다크 슬레이트 모드입니다.',
                          },
                        ] as const
                      ).map((opt) => {
                        const checked = theme === opt.key;
                        return (
                          <button
                            key={opt.key}
                            type="button"
                            role="radio"
                            aria-checked={checked}
                            className={`dc-radio-card ${checked ? 'dc-radio-card--checked' : ''}`}
                            onClick={() => applyTheme(opt.key)}
                          >
                            <span className={`dc-radio-dot ${checked ? 'dc-radio-dot--on' : ''}`} />
                            <div className="dc-radio-body">
                              <div className="dc-r-title">{opt.title}</div>
                              <div className="dc-r-sub">{opt.sub}</div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}

                {error && (
                  <div className="dc-problem" style={{ marginTop: '12px' }}>
                    <Problem>{error}</Problem>
                  </div>
                )}
                {note && (
                  <p role="status" className="dc-note-ok">
                    {note}
                  </p>
                )}
              </section>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
