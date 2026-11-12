import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type MeetingTextUtterance,
  useCreateMeetingTextUtterance,
  useInstantJoinMeeting,
  useMe,
  useMeetingMembers,
  useMeetingTextUtterances,
  useTaskMutations,
} from '../api/hooks.ts';
import { loadAudioPrefs } from './SettingsModal.tsx';

interface CallStageModalProps {
  open: boolean;
  minimized: boolean;
  projectId: number;
  meetingId?: number;
  onMinimize: (min: boolean) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}



export function CallStageModal({
  open,
  minimized,
  projectId,
  meetingId,
  onMinimize,
  onClose,
  onOpenSettings,
}: CallStageModalProps) {
  const { data: me } = useMe();
  const instantJoinMutation = useInstantJoinMeeting();
  const targetMeetingId = meetingId ?? 1;
  const { data: meetingMembers } = useMeetingMembers(targetMeetingId);
  const otherPeers = (meetingMembers ?? []).filter((m) => m.user_id !== me?.user_id);
  const { data: fetchedUtterances } = useMeetingTextUtterances(targetMeetingId, open);
  const createTextUtteranceMutation = useCreateMeetingTextUtterance(targetMeetingId, projectId);
  const { createTask } = useTaskMutations(projectId);

  // Pre-join lobby vs active call stage (Zoom-style haircheck before entering)
  const [joined, setJoined] = useState<boolean>(false);

  // Hardware availability states (probed from real navigator.mediaDevices)
  const [hasMic, setHasMic] = useState<boolean>(false);
  const [hasCam, setHasCam] = useState<boolean>(false);
  const [hwError, setHwError] = useState<string | null>(null);

  // Media active states
  const [micOn, setMicOn] = useState<boolean>(false);
  const [camOn, setCamOn] = useState<boolean>(false);
  const [screenOn, setScreenOn] = useState<boolean>(false);
  const [recording, setRecording] = useState<boolean>(false);
  const [recSec, setRecSec] = useState<number>(0);
  const [handRaised, setHandRaised] = useState<boolean>(false);
  const [speaking, setSpeaking] = useState<boolean>(false);
  const [statusNote, setNote] = useState<string>('입장 전 장치 점검 중');

  const camVideoRef = useRef<HTMLVideoElement | null>(null);
  const prejoinVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const camStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);

  // Real-time Meeting Chat / Text Utterances (Contributes to Utterances & Kanban Tasks)
  const [chatItems, setChatItems] = useState<MeetingTextUtterance[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const [sendAsTask, setSendAsTask] = useState<boolean>(false);
  const [sendingChat, setSendingChat] = useState<boolean>(false);
  const [taskCreatedMap, setTaskCreatedMap] = useState<Record<number, string>>({});
  const [mobileTab, setMobileTab] = useState<'stage' | 'chat'>('stage');

  useEffect(() => {
    if (fetchedUtterances) {
      setChatItems(fetchedUtterances);
    }
  }, [fetchedUtterances]);

  // Probe actual connected audio/video input hardware
  const probeHardware = useCallback(async (tryRequestAudio = false, tryRequestVideo = false) => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setHasMic(false);
      setHasCam(false);
      setMicOn(false);
      setCamOn(false);
      setRecording(false);
      setSpeaking(false);
      setHwError('이 브라우저에서는 미디어 장치(마이크·카메라)를 사용할 수 없습니다.');
      return;
    }

    try {
      if (tryRequestAudio) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      }
      if (tryRequestVideo) {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
      }
    } catch {
      /* handled below by enumerateDevices */
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== '');
      const videoInputs = devices.filter((d) => d.kind === 'videoinput' && d.deviceId !== '');
      const micAvailable = audioInputs.length > 0;
      const camAvailable = videoInputs.length > 0;

      setHasMic(micAvailable);
      setHasCam(camAvailable);

      if (!micAvailable) {
        setMicOn(false);
        setSpeaking(false);
        setRecording(false);
      } else if (tryRequestAudio) {
        setMicOn(true);
        setRecording(true);
      }

      if (!camAvailable) {
        setCamOn(false);
      }

      if (!micAvailable && !camAvailable) {
        setHwError('연결된 마이크와 카메라가 없습니다. 장치를 연결한 뒤 [다시 확인]을 눌러 주세요.');
      } else if (!micAvailable) {
        setHwError('연결된 마이크가 없습니다. 우측 채팅창으로 대화에 참여할 수 있습니다.');
      } else if (!camAvailable) {
        setHwError('연결된 카메라가 없습니다.');
      } else {
        setHwError(null);
      }
    } catch {
      setHasMic(false);
      setHasCam(false);
      setMicOn(false);
      setCamOn(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void probeHardware(false, false);

    const md = navigator.mediaDevices;
    const onDeviceChange = () => {
      void probeHardware(false, false);
    };
    if (md?.addEventListener) {
      md.addEventListener('devicechange', onDeviceChange);
    }

    return () => {
      if (md?.removeEventListener) {
        md.removeEventListener('devicechange', onDeviceChange);
      }
    };
  }, [open, probeHardware]);

  const enterMeetingRoom = () => {
    if (hasMic && micOn) {
      setRecording(true);
    }
    setJoined(true);
    instantJoinMutation.mutate(targetMeetingId, {
      onSuccess: () => {
        setNote('회의록 자동 기록 중');
      },
      onError: () => {
        setNote('실시간 연결됨');
      },
    });
  };

  // Recording timer
  useEffect(() => {
    if (!open || !joined) return;
    const iv = window.setInterval(() => {
      if (recording && hasMic && micOn) setRecSec((s) => s + 1);
      setSpeaking((prev) => (hasMic && micOn ? !prev || Math.random() > 0.3 : false));
    }, 1000);
    return () => window.clearInterval(iv);
  }, [open, joined, recording, micOn, hasMic]);

  // Cleanup media streams on close
  useEffect(() => {
    if (open) return;
    camStreamRef.current?.getTracks().forEach((t) => t.stop());
    camStreamRef.current = null;
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setCamOn(false);
    setScreenOn(false);
    setJoined(false);
  }, [open]);

  const handleMicToggle = async () => {
    if (!hasMic) {
      await probeHardware(true, false);
      return;
    }
    const next = !micOn;
    setMicOn(next);
    if (next && joined && !recording) {
      setRecording(true);
    }
    if (!next) {
      setSpeaking(false);
    }
  };

  const toggleCamera = async () => {
    if (!hasCam) {
      await probeHardware(false, true);
      return;
    }
    if (camOn) {
      camStreamRef.current?.getTracks().forEach((t) => t.stop());
      camStreamRef.current = null;
      setCamOn(false);
      return;
    }
    try {
      const prefs = loadAudioPrefs();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio:
          hasMic && prefs.inputDeviceId !== 'default'
            ? { deviceId: { ideal: prefs.inputDeviceId } }
            : false,
      });
      camStreamRef.current = stream;
      setCamOn(true);
      setTimeout(() => {
        if (camVideoRef.current) camVideoRef.current.srcObject = stream;
        if (prejoinVideoRef.current) prejoinVideoRef.current.srcObject = stream;
      }, 50);
    } catch {
      setCamOn(false);
      setHasCam(false);
      setHwError('카메라 장치를 찾을 수 없거나 권한이 차단되어 카메라가 잠금 처리되었습니다.');
    }
  };

  const toggleScreenShare = async () => {
    if (screenOn) {
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      setScreenOn(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      screenStreamRef.current = stream;
      setScreenOn(true);
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        setScreenOn(false);
        screenStreamRef.current = null;
      });
      setTimeout(() => {
        if (screenVideoRef.current) {
          screenVideoRef.current.srcObject = stream;
        }
      }, 50);
    } catch {
      setScreenOn(false);
      setNote('화면 공유가 취소되었습니다');
    }
  };

  const handleSendChatUtterance = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || sendingChat) return;
    setSendingChat(true);
    try {
      const created = await createTextUtteranceMutation.mutateAsync({
        text: trimmed,
        create_task: sendAsTask,
      });
      setChatItems((prev) => [...prev, created]);
      if (created.created_task_marker) {
        setTaskCreatedMap((prev) => ({ ...prev, [created.id]: created.created_task_marker! }));
      }
      setChatInput('');
      setSendAsTask(false);
    } catch {
      setNote('채팅 발언 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSendingChat(false);
    }
  };

  const promoteUtteranceToTask = async (item: MeetingTextUtterance) => {
    if (taskCreatedMap[item.id]) return;
    try {
      const res = await createTask.mutateAsync({
        title: item.text.slice(0, 100),
        status: 'todo',
        priority: 2,
        assignee_ids: [item.speaker_id],
      });
      setTaskCreatedMap((prev) => ({ ...prev, [item.id]: res.marker }));
    } catch {
      setNote('칸반 업무 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    }
  };

  const fmtTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  if (!open) return null;

  // Floating PIP Mode (When user navigates to Kanban / Contributions while staying in the call!)
  if (minimized) {
    return (
      <aside className="dc-pip" aria-label="진행 중인 통화 미니 창">
        <div className="dc-pip__hdr">
          <span className="dc-pip__live">● 스프린트-회의실</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              type="button"
              className="dc-pip__btn"
              onClick={() => onMinimize(false)}
              title="전체 스테이지로 펼치기"
            >
              펼치기 ↗
            </button>
            <button
              type="button"
              className="dc-pip__btn dc-pip__btn--danger"
              onClick={onClose}
              title="통화 종료"
            >
              종료
            </button>
          </div>
        </div>
        <div className="dc-pip__body">
          <div className="dc-pip__peers">
            <div className={`dc-avatar dc-avatar--sm ${hasMic && speaking && micOn ? 'dc-avatar--speaking' : ''}`}>
              {(me?.name ?? '나').slice(0, 1)}
            </div>
            <div className="dc-avatar dc-avatar--sm" style={{ background: '#23a55a' }}>
              김
            </div>
            <span className="dc-pip__sub">
              {!hasMic
                ? '채팅·듣기 참여 중'
                : screenOn
                  ? '화면 공유 중'
                  : `음성 연결됨 · ${fmtTime(recSec)}`}
            </span>
          </div>
          {hasMic && recording && micOn ? (
            <span className="dc-rec-pill">REC</span>
          ) : (
            <span className="dc-badge dc-badge--warn">CHAT</span>
          )}
        </div>
      </aside>
    );
  }

  // Stage 1: Zoom / Discord Style Pre-Join Lobby (Check Camera/Mic & Preview Who's In the Room)
  if (!joined) {
    return (
      <div className="dc-call-overlay" role="dialog" aria-modal="true" aria-label="회의 참여 준비">
        <div className="dc-prejoin-card">
          <header className="dc-call-top">
            <div className="dc-call-top__left">
              <span className="dc-call-top__title">스프린트 회의실</span>
              <span className="dc-badge dc-badge--ok">{otherPeers.length + 1}명</span>
            </div>
            <div className="dc-call-top__actions">
              <button type="button" className="dc-btn dc-btn--ghost" onClick={onOpenSettings} title="설정">
                설정
              </button>
              <button type="button" className="dc-close-btn" onClick={onClose} aria-label="닫기">
                <svg className="dc-ic" viewBox="0 0 24 24">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          </header>

          <div className="dc-prejoin-body">
            {/* Left: Camera & Mic Haircheck Preview */}
            <div className="dc-prejoin-preview">
              <div className="dc-prejoin-video">
                {camOn && hasCam ? (
                  <video
                    ref={prejoinVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="dc-video-el"
                  />
                ) : (
                  <div className="dc-prejoin-placeholder">
                    <div className="dc-avatar dc-avatar--lg">{(me?.name ?? '나').slice(0, 1)}</div>
                    <strong>{me?.name ?? '사용자'}</strong>
                    <span>
                      {!hasCam ? '카메라 없음' : '카메라 꺼짐'}
                    </span>
                  </div>
                )}

                <div className="dc-prejoin-controls">
                  <button
                    type="button"
                    className={`dc-dock-btn ${
                      !hasMic ? 'dc-dock-btn--locked' : micOn ? 'dc-dock-btn--on' : 'dc-dock-btn--off'
                    }`}
                    onClick={() => void handleMicToggle()}
                  >
                    {!hasMic ? (
                      <>
                        <span className="dc-dock-warn-dot" aria-hidden="true">!</span>
                        <span>마이크 미연결</span>
                      </>
                    ) : (
                      <span>{micOn ? '마이크 켜짐' : '마이크 꺼짐'}</span>
                    )}
                  </button>

                  <button
                    type="button"
                    className={`dc-dock-btn ${
                      !hasCam ? 'dc-dock-btn--locked' : camOn ? 'dc-dock-btn--on' : ''
                    }`}
                    onClick={() => void toggleCamera()}
                  >
                    {!hasCam ? (
                      <>
                        <span className="dc-dock-warn-dot" aria-hidden="true">!</span>
                        <span>카메라 미연결</span>
                      </>
                    ) : (
                      <span>{camOn ? '카메라 켜짐' : '카메라 꺼짐'}</span>
                    )}
                  </button>

                  <button
                    type="button"
                    className="dc-btn dc-btn--ghost"
                    onClick={() => void probeHardware(false, false)}
                  >
                    다시 확인
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Who is currently in the call + Single Clean Join Button */}
            <div className="dc-prejoin-roster">
              <div>
                <div className="dc-sec-title" style={{ marginBottom: '10px' }}>
                  참여자 ({otherPeers.length + 1})
                </div>

                <div className="dc-peer-list">
                  <div className="dc-peer-item">
                    <div className="dc-avatar dc-avatar--sm">
                      {(me?.name ?? '나').slice(0, 1)}
                    </div>
                    <div className="dc-peer-meta">
                      <strong>{me?.name ?? '나'} (나)</strong>
                      <span>준비 완료</span>
                    </div>
                    <span className="dc-badge dc-badge--ok">온라인</span>
                  </div>
                  {otherPeers.map((peer) => (
                    <div key={peer.user_id} className="dc-peer-item">
                      <div className="dc-avatar dc-avatar--sm">
                        {peer.name.slice(0, 1)}
                      </div>
                      <div className="dc-peer-meta">
                        <strong>{peer.name}</strong>
                        <span>참여 중</span>
                      </div>
                      <span className="dc-badge dc-badge--ok">온라인</span>
                    </div>
                  ))}
                  {otherPeers.length === 0 && (
                    <p style={{ fontSize: 'var(--fs-12)', color: 'var(--c-ink-muted)', marginTop: '8px' }}>
                      아직 다른 팀원이 입장하지 않았습니다. 팀원이 입장하면 실시간으로 표시됩니다.
                    </p>
                  )}
                </div>
              </div>

              <div className="dc-prejoin-actions">
                <button
                  type="button"
                  className="dc-btn dc-btn--green"
                  style={{ width: '100%', height: '44px', fontSize: 'var(--fs-14)' }}
                  onClick={() => enterMeetingRoom()}
                >
                  회의 참여하기
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Stage 2: Active Meeting Stage + Real-Time Chat Utterance & 1-Click Task Creation
  return (
    <div className="dc-call-overlay" role="dialog" aria-modal="true" aria-label="화상 회의실">
      <div className="dc-call-shell">
        {/* Top Stage Bar */}
        <header className="dc-call-top">
          <div className="dc-call-top__left">
            <svg className="dc-ic" style={{ color: '#23a55a' }} viewBox="0 0 24 24">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <span className="dc-call-top__title">스프린트 회의실</span>
            {hasMic && recording && micOn ? (
              <span className="dc-rec-pill">
                <span className="dc-rec-dot" />
                REC {fmtTime(recSec)}
              </span>
            ) : (
              <span className="dc-badge dc-badge--warn">
                {!hasMic ? '마이크 미연결' : '음소거됨'}
              </span>
            )}
            <span className="dc-call-top__note">{statusNote}</span>
          </div>

          <div className="dc-call-top__actions">
            <button
              type="button"
              className="dc-btn dc-btn--ghost"
              onClick={onOpenSettings}
              title="설정"
            >
              설정
            </button>
            <button
              type="button"
              className="dc-btn dc-btn--ghost"
              onClick={() => onMinimize(true)}
              title="화면을 작게 띄워두고 다른 메뉴 이동"
            >
              미니 창 ↘
            </button>
            <button
              type="button"
              className="dc-btn dc-btn--danger"
              onClick={onClose}
            >
              나가기
            </button>
          </div>
        </header>

        {/* Main Stage + Right Live Chat & Utterance-to-Kanban Pipeline */}
        <div className={`dc-call-main ${mobileTab === 'chat' ? 'dc-call-main--show-chat' : 'dc-call-main--show-stage'}`}>
          <div className="dc-call-stage">
            {/* Concise Hardware Alert Banner when no mic/camera is detected */}
            {(!hasMic || !hasCam) && (
              <div className="dc-hw-banner" role="alert">
                <svg className="dc-ic" style={{ color: '#f0b232', flexShrink: 0 }} viewBox="0 0 24 24">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <div className="dc-hw-banner__body">
                  <strong>
                    {!hasMic && !hasCam
                      ? '마이크 및 카메라 미연결'
                      : !hasMic
                        ? '마이크 미연결'
                        : '카메라 미연결'}
                  </strong>
                  <span>{hwError ?? '장치를 연결한 뒤 [다시 확인]을 누르세요.'}</span>
                </div>
                <div className="dc-hw-banner__actions">
                  <button
                    type="button"
                    className="dc-btn dc-btn--ghost"
                    onClick={() => void probeHardware(false, false)}
                  >
                    다시 확인
                  </button>
                  <button
                    type="button"
                    className="dc-btn dc-btn--blurple"
                    onClick={onOpenSettings}
                  >
                    설정
                  </button>
                </div>
              </div>
            )}

            {/* Spotlight Screen Share / Stage Area */}
            <div className="dc-spotlight">
              <div className="dc-spotlight__hdr">
                <span className="dc-badge dc-badge--live">
                  {screenOn ? '화면 공유 중' : '실시간 회의'}
                </span>
              </div>

              {screenOn ? (
                <video
                  ref={screenVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="dc-video-el"
                />
              ) : (
                <div className="dc-spotlight__placeholder">
                  <svg
                    className="dc-ic"
                    style={{ width: '36px', height: '36px' }}
                    viewBox="0 0 24 24"
                  >
                    <rect x="2" y="3" width="20" height="14" rx="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                  <div>[화면 공유]를 눌러 화면을 공유하세요</div>
                </div>
              )}

              <div className="dc-live-caption">
                {chatItems.length > 0 ? (
                  <>
                    <span className="dc-badge dc-badge--ok">
                      {chatItems[chatItems.length - 1]?.utterance_label ?? '대화'}
                    </span>
                    <span>
                      {chatItems[chatItems.length - 1]?.speaker_name}: &ldquo;
                      {chatItems[chatItems.length - 1]?.text}&rdquo;
                    </span>
                  </>
                ) : (
                  <span>대화와 채팅은 회의록에 자동 기록됩니다.</span>
                )}
              </div>
            </div>

            {/* Participant Camera Strip */}
            <div className="dc-cam-strip">
              <div className={`dc-cam-tile ${hasMic && speaking && micOn ? 'dc-cam-tile--speaking' : ''}`}>
                {camOn && hasCam ? (
                  <video
                    ref={camVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className="dc-video-el"
                  />
                ) : (
                  <div className="dc-avatar dc-avatar--lg">{(me?.name ?? '나').slice(0, 1)}</div>
                )}
                <span className="dc-cam-tag">
                  {me?.name ?? '나'} {handRaised ? '✋' : ''}{' '}
                  {!hasMic || !micOn ? '· 음소거' : ''}
                </span>
              </div>

              {otherPeers.map((peer) => (
                <div key={peer.user_id} className="dc-cam-tile">
                  <div className="dc-avatar dc-avatar--lg">
                    {peer.name.slice(0, 1)}
                  </div>
                  <span className="dc-cam-tag">
                    {peer.name} · 참여 중
                  </span>
                </div>
              ))}
              {otherPeers.length === 0 && (
                <div
                  className="dc-cam-tile"
                  style={{
                    background: 'var(--c-surface-sunken)',
                    border: '1px dashed var(--c-border)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    color: 'var(--c-ink-muted)',
                  }}
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                  <span style={{ fontSize: 'var(--fs-12)' }}>다른 팀원의 입장을 기다리는 중입니다</span>
                </div>
              )}
            </div>

            {/* Bottom Call Control Dock */}
            <div className="dc-call-dock">
              <button
                type="button"
                className={`dc-dock-btn ${
                  !hasMic
                    ? 'dc-dock-btn--locked'
                    : micOn
                      ? 'dc-dock-btn--on'
                      : 'dc-dock-btn--off'
                }`}
                onClick={() => void handleMicToggle()}
              >
                {!hasMic ? (
                  <>
                    <span className="dc-dock-warn-dot" aria-hidden="true">!</span>
                    <span>마이크 미연결</span>
                  </>
                ) : (
                  <span>{micOn ? '마이크 켜짐' : '음소거'}</span>
                )}
              </button>

              <button
                type="button"
                className={`dc-dock-btn ${
                  !hasCam ? 'dc-dock-btn--locked' : camOn ? 'dc-dock-btn--on' : ''
                }`}
                onClick={() => void toggleCamera()}
              >
                {!hasCam ? (
                  <>
                    <span className="dc-dock-warn-dot" aria-hidden="true">!</span>
                    <span>카메라 미연결</span>
                  </>
                ) : (
                  <span>{camOn ? '카메라 끄기' : '카메라 켜기'}</span>
                )}
              </button>

              <button
                type="button"
                className={`dc-dock-btn ${screenOn ? 'dc-dock-btn--on' : ''}`}
                onClick={() => void toggleScreenShare()}
              >
                <span>{screenOn ? '공유 중지' : '화면 공유'}</span>
              </button>

              <button
                type="button"
                className={`dc-dock-btn ${handRaised ? 'dc-dock-btn--on' : ''}`}
                onClick={() => setHandRaised(!handRaised)}
              >
                <span>{handRaised ? '손내리기' : '손들기'}</span>
              </button>

              {hasMic && (
                <button
                  type="button"
                  className={`dc-dock-btn ${recording ? 'dc-dock-btn--rec' : ''}`}
                  onClick={() => setRecording(!recording)}
                >
                  <span>{recording ? '기록 일시정지' : '기록 재개'}</span>
                </button>
              )}

              <button
                type="button"
                className={`dc-dock-btn dc-dock-btn--mobile-chat ${mobileTab === 'chat' ? 'dc-dock-btn--on' : ''}`}
                onClick={() => setMobileTab(mobileTab === 'chat' ? 'stage' : 'chat')}
                title="채팅창 열기"
              >
                <svg className="dc-ic" viewBox="0 0 24 24" style={{ width: 15, height: 15 }}>
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span>채팅 {chatItems.length > 0 ? `(${chatItems.length})` : ''}</span>
              </button>
            </div>
          </div>

          {/* Right Drawer: Real-Time Meeting Chat */}
          <aside className="dc-util-drawer" aria-label="회의 채팅">
            <div className="dc-chat-hdr">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <button
                  type="button"
                  className="dc-mobile-back-btn"
                  onClick={() => setMobileTab('stage')}
                  aria-label="화상 무대로 돌아가기"
                  title="화상 무대로 돌아가기"
                >
                  <svg className="dc-ic" viewBox="0 0 24 24" style={{ width: 14, height: 14 }}>
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  <span>무대</span>
                </button>
                <strong>회의 채팅</strong>
              </div>
              <span className="dc-badge dc-badge--ok">{chatItems.length}</span>
            </div>

            <div className="dc-chat-feed">
              {chatItems.length === 0 ? (
                <div className="dc-chat-empty">
                  아직 대화가 없습니다.
                </div>
              ) : (
                chatItems.map((item) => {
                  const taskMarker = item.created_task_marker ?? taskCreatedMap[item.id];
                  return (
                    <div key={item.id} className="dc-chat-msg">
                      <div className="dc-chat-msg__top">
                        <strong>{item.speaker_name}</strong>
                        <span className="dc-badge dc-badge--ok">{item.utterance_label}</span>
                      </div>
                      <p className="dc-chat-msg__body">{item.text}</p>
                      <div className="dc-chat-msg__foot">
                        {taskMarker ? (
                          <span className="dc-badge">✓ {taskMarker} 등록됨</span>
                        ) : (
                          <button
                            type="button"
                            className="dc-chat-task-btn"
                            onClick={() => void promoteUtteranceToTask(item)}
                          >
                            + 할 일로 등록
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="dc-chat-composer">
              <button
                type="button"
                role="checkbox"
                aria-checked={sendAsTask}
                className={`dc-agenda-item ${sendAsTask ? 'dc-agenda-item--active' : ''}`}
                onClick={() => setSendAsTask(!sendAsTask)}
              >
                <span className={`dc-check-box ${sendAsTask ? 'dc-check-box--on' : ''}`}>
                  {sendAsTask && (
                    <svg viewBox="0 0 24 24" aria-hidden="true" width="12" height="12" stroke="currentColor" strokeWidth="3" fill="none">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span>할 일로 등록</span>
              </button>

              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text"
                  className="dc-input"
                  placeholder="메시지 입력..."
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleSendChatUtterance();
                    }
                  }}
                />
                <button
                  type="button"
                  className="dc-btn dc-btn--blurple"
                  disabled={sendingChat}
                  onClick={() => void handleSendChatUtterance()}
                >
                  전송
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
