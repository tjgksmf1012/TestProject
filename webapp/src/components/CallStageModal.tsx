import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  useConsent,
  useLobbyMutations,
  useMe,
  useMeetings,
  useSettingsMutations,
  useTracks,
} from '../api/hooks.ts';
import { apiFailureText } from '../api/client.ts';
import { EXTRA_CONSENTS } from '@lib/lobby/room.ts';
import { meetingLabel } from '@lib/ui/naming.ts';
import { Problem } from './Problem.tsx';

type Launch = { projectId: number; minimized: boolean; opener: HTMLElement | null } | null;
let launch: Launch = null;
const listeners = new Set<() => void>();
const publish = (next: Launch) => {
  launch = next;
  listeners.forEach((notify) => notify());
};
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};

/** 현재 프로젝트를 명시해야 회의 창을 열 수 있습니다. */
export function triggerInstantCall(projectId: number | undefined): void {
  if (projectId !== undefined && Number.isSafeInteger(projectId) && projectId > 0) {
    publish(
      launch
        ? { ...launch, minimized: false }
        : {
            projectId,
            minimized: false,
            opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
          },
    );
  }
}

/** 라우터 바깥에 한 번만 마운트해 화면 이동으로 장치가 끊기지 않게 합니다. */
export function CallStageModal() {
  const state = useSyncExternalStore(subscribe, () => launch);
  const { data: me } = useMe();
  useEffect(() => {
    if (me === null) publish(null);
  }, [me]);
  if (!state || !me) return null;
  return <MeetingRoom key={state.projectId} state={state} userName={me.name} userId={me.user_id} />;
}

function consentBadge(recording: boolean | null): { text: string; tone: string } {
  if (recording === true) return { text: '녹음 동의', tone: 'dc-badge dc-badge--ok' };
  if (recording === false) return { text: '거부됨', tone: 'dc-badge dc-badge--live' };
  return { text: '미응답', tone: 'dc-badge' };
}

function MeetingRoom({
  state,
  userId,
  userName,
}: {
  state: NonNullable<Launch>;
  userId: number;
  userName: string;
}) {
  const [meetingId, setMeetingId] = useState<number>();
  const [draftTitle, setDraftTitle] = useState('');
  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState<'call' | 'record' | 'chat'>('call');
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  const meetings = useMeetings(state.projectId);
  const { openMeeting } = useSettingsMutations(state.projectId);
  const consent = useConsent(meetingId, started ? 5000 : 3000);
  const tracks = useTracks(started ? meetingId : undefined, started ? 3000 : undefined);
  const mutations = useLobbyMutations(meetingId);

  const mine = consent.data?.roster.find((row) => row.user_id === userId);
  const myTrack = tracks.data?.tracks.find((row) => row.user_id === userId);
  const chosen = meetings.data?.find((meeting) => meeting.meeting_id === meetingId);
  const title = meetingId === undefined ? '회의실 준비' : meetingLabel(chosen?.title, meetingId);

  useEffect(() => {
    if (!state.minimized) titleRef.current?.focus();
  }, [state.minimized]);

  const close = () => {
    if (
      started &&
      !window.confirm(
        '통화와 녹음 화면을 닫습니다. 녹음 중이라면 먼저 녹음 탭에서 종료해 주세요. 닫을까요?',
      )
    ) {
      return;
    }
    publish(null);
    if (state.opener?.isConnected) state.opener.focus();
  };

  const chooseNew = async () => {
    setProblem(null);
    try {
      const created = await openMeeting.mutateAsync(draftTitle);
      setDraftTitle('');
      setMeetingId(created.meeting_id);
    } catch (error) {
      setProblem(apiFailureText(error));
    }
  };

  const giveConsent = async (consent_type: string, consented: boolean) => {
    setProblem(null);
    try {
      await mutations.consent.mutateAsync({ consent_type, consented });
    } catch (error) {
      setProblem(apiFailureText(error));
    }
  };

  const trackBadge =
    myTrack?.status === 'recording'
      ? { text: `녹음 중 · 청크 ${myTrack.chunk_count}개`, tone: 'dc-rec-pill', recording: true }
      : myTrack?.status === 'completed'
        ? { text: `녹음 완료 · 청크 ${myTrack.chunk_count}개`, tone: 'dc-badge dc-badge--ok', recording: false }
        : { text: '녹음 전 · 녹음 탭에서 시작', tone: 'dc-badge', recording: false };

  const [elapsedSec, setElapsedSec] = useState(0);
  const recStartedMs = myTrack?.started_at ? Date.parse(myTrack.started_at) : NaN;
  useEffect(() => {
    if (!trackBadge.recording) {
      setElapsedSec(0);
      return;
    }
    const baseMs = Number.isFinite(recStartedMs) ? recStartedMs : Date.now();
    const update = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - baseMs) / 1000)));
    };
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, [trackBadge.recording, recStartedMs]);

  const elapsedClock = `${String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`;

  return (
    <>
      {state.minimized && (
        <aside className="meeting-mini dc-pip dc-pip--room" aria-label="열려 있는 회의 창">
          <div className="dc-pip__hdr">
            <span className="dc-pip__live">● {title}</span>
            <span className={trackBadge.tone}>{trackBadge.text}</span>
          </div>
          <div className="dc-pip__body">
            <div className="dc-pip__peers">
              <div className={`dc-avatar dc-avatar--sm ${trackBadge.recording ? 'dc-avatar--speaking' : ''}`}>
                {(userName || '나').slice(0, 1)}
              </div>
              <span className="dc-pip__sub">
                {trackBadge.recording ? (
                  <>
                    개별 트랙 녹음 중 · <span className="num">{elapsedClock}</span>
                  </>
                ) : (
                  trackBadge.text
                )}
              </span>
            </div>
            <div className="dc-pip__actions">
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => publish({ ...state, minimized: false })}
              >
                회의 창 다시 열기
              </button>
              <button
                type="button"
                className="dc-pip__btn dc-pip__btn--danger"
                onClick={close}
                aria-label="회의 창 닫기"
              >
                닫기
              </button>
            </div>
          </div>
        </aside>
      )}

      <Dialog.Root
        modal={false}
        open={!state.minimized}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <Dialog.Portal forceMount>
          <Dialog.Content
            forceMount
            className="dc-call-shell dc-call-shell--portal"
            hidden={state.minimized}
            onInteractOutside={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (state.opener?.isConnected) state.opener.focus();
            }}
          >
            <header className="dc-call-top">
              <div className="dc-call-top__left">
                <Dialog.Title ref={titleRef} tabIndex={-1} className="dc-call-top__title">
                  {title}
                </Dialog.Title>
                {started && (
                  <span className={trackBadge.tone}>
                    {trackBadge.recording && <span className="dc-rec-dot" aria-hidden="true" />}
                    {trackBadge.text}
                  </span>
                )}
              </div>
              <div className="dc-call-top__actions">
                {started && (
                  <button
                    type="button"
                    className="dc-btn dc-btn--ghost"
                    onClick={() => {
                      publish({ ...state, minimized: true });
                      requestAnimationFrame(() =>
                        document.querySelector<HTMLButtonElement>('.meeting-mini button')?.focus(),
                      );
                    }}
                  >
                    작게 두기
                  </button>
                )}
                <button type="button" className="dc-btn dc-btn--danger" onClick={close}>
                  닫기
                </button>
              </div>
            </header>

            <Dialog.Description className="dc-call-desc">
              음성 통화와 녹음은 별도입니다. 전원이 동의한 뒤 녹음 탭에서 시작하세요. 채팅은 프로젝트
              대화이며 기여도에 자동으로 포함하지 않습니다.
            </Dialog.Description>

            {problem && (
              <div className="dc-problem dc-problem--stage">
                <Problem>{problem}</Problem>
              </div>
            )}

            {!started ? (
              <div className="dc-call-setup">
                {meetingId === undefined ? (
                  <div className="dc-setup-grid">
                    <div className="dc-setup-card">
                      <h2 className="dc-sec-title">새 회의 시작 또는 대기 중 회의 참가</h2>
                      <p className="dc-r-sub dc-sub--lead">
                        모든 참여자의 녹음 동의를 확인한 뒤 실시간 음성 통화와 개별 트랙 녹음을
                        엽니다.
                      </p>
                      <label htmlFor="call-meeting-title" className="dc-label">
                        새 회의 이름 (선택)
                      </label>
                      <input
                        id="call-meeting-title"
                        type="text"
                        className="dc-input dc-input--spaced"
                        value={draftTitle}
                        placeholder="예: 스프린트 2 계획 (비우면 자동 이름)"
                        onChange={(event) => setDraftTitle(event.target.value)}
                      />
                      <button
                        type="button"
                        className="dc-btn dc-btn--green"
                        disabled={openMeeting.isPending}
                        onClick={() => void chooseNew()}
                      >
                        {openMeeting.isPending ? '회의를 여는 중…' : '새 회의 열기'}
                      </button>

                      {meetings.isPending && (
                        <p role="status" className="dc-r-sub dc-problem--spaced">
                          회의를 불러오는 중입니다
                        </p>
                      )}
                      {meetings.isError && (
                        <div className="dc-problem dc-problem--spaced">
                          <Problem>
                            회의를 불러오지 못했습니다.{' '}
                            <button
                              type="button"
                              className="dc-btn dc-btn--ghost"
                              onClick={() => void meetings.refetch()}
                            >
                              다시 불러오기
                            </button>
                          </Problem>
                        </div>
                      )}
                    </div>

                    <div className="dc-setup-card">
                      <div className="dc-label">준비 중인 회의</div>
                      <ul className="meeting-room__list">
                        {(meetings.data ?? [])
                          .filter((meeting) => meeting.status === 'pending' && meeting.started_at !== null)
                          .map((meeting) => (
                            <li key={meeting.meeting_id}>
                              <button
                                type="button"
                                className="dc-btn dc-btn--ghost dc-btn--room-item"
                                onClick={() => {
                                  setProblem(null);
                                  setMeetingId(meeting.meeting_id);
                                }}
                              >
                                <span>{meetingLabel(meeting.title, meeting.meeting_id)} · 준비 중인 회의 참가</span>
                                <span>→</span>
                              </button>
                            </li>
                          ))}
                      </ul>
                      {(meetings.data ?? []).filter(
                        (meeting) => meeting.status === 'pending' && meeting.started_at !== null,
                      ).length === 0 && (
                        <p className="dc-r-sub">현재 열려 있는 준비 중 회의가 없습니다. 왼쪽에서 새 회의를 여세요.</p>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="dc-prejoin-body">
                    <div className="dc-setup-card">
                      <div className="dc-sec-head-row">
                        <h2 className="dc-sec-title dc-sec-title--flush">
                          팀원 녹음 동의 현황
                        </h2>
                        <a
                          href={`/app/meeting/${meetingId}/lobby`}
                          className="dc-btn dc-btn--ghost dc-btn--link"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          회의 로비에서 동의 현황 보기
                        </a>
                      </div>

                      {consent.isError && (
                        <div className="dc-problem dc-status--spaced">
                          <Problem>
                            동의 현황을 불러오지 못했습니다.{' '}
                            <button
                              type="button"
                              className="dc-btn dc-btn--ghost"
                              onClick={() => void consent.refetch()}
                            >
                              다시 불러오기
                            </button>
                          </Problem>
                        </div>
                      )}
                      {consent.isPending && (
                        <p role="status" className="dc-r-sub dc-status--spaced">
                          동의 현황을 확인하는 중입니다
                        </p>
                      )}

                      <div className="dc-peer-list dc-peer-list--spaced">
                        {(consent.data?.roster ?? []).map((member) => {
                          const badge = consentBadge(member.recording);
                          return (
                            <div key={member.user_id} className="dc-peer-item">
                              <div className="dc-avatar dc-avatar--sm">
                                {(member.name || '?').slice(0, 1)}
                              </div>
                              <div className="dc-peer-meta">
                                <strong>
                                  {member.name}
                                  {member.user_id === userId ? ' (나)' : ''}
                                </strong>
                                <span>
                                  {member.raw_audio_retention === true
                                    ? '원본 음성 보관 허용'
                                    : '원본 음성 보관 미선택/거부'}
                                </span>
                              </div>
                              <span className={badge.tone}>{badge.text}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="dc-prejoin-roster">
                      <div>
                        <h2 className="dc-sec-title">내 동의 확인</h2>
                        {mine && (
                          <fieldset className="meeting-room__consents dc-consent-box">
                            <legend className="visually-hidden">내 동의</legend>
                            <label className="dc-consent-check">
                              <input
                                type="checkbox"
                                checked={mine.recording === true}
                                disabled={mutations.consent.isPending}
                                onChange={(event) => void giveConsent('recording', event.target.checked)}
                              />
                              <span>회의 녹음과 전사에 동의합니다</span>
                            </label>
                            {EXTRA_CONSENTS.map((item) => {
                              const field =
                                item.key === 'rawAudio' ? 'raw_audio_retention' : 'voiceprint_storage';
                              const checked =
                                item.key === 'rawAudio'
                                  ? mine.raw_audio_retention === true
                                  : mine.voiceprint_storage === true;
                              return (
                                <label key={item.key} className="dc-consent-check dc-consent-check--extra">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={mutations.consent.isPending}
                                    onChange={(event) => void giveConsent(field, event.target.checked)}
                                  />
                                  <span className="dc-consent-copy">
                                    <span>{item.label}</span>
                                    <span className="dc-r-sub">{item.hint}</span>
                                  </span>
                                </label>
                              );
                            })}
                          </fieldset>
                        )}
                        <p id="room-consent-help" role="status" className="dc-r-sub dc-status--spaced">
                          {consent.data?.message ?? '본인의 동의만 변경할 수 있습니다'}
                        </p>
                      </div>

                      <div className="dc-prejoin-actions">
                        <button
                          type="button"
                          className="dc-btn dc-btn--green dc-btn--full-lg"
                          aria-disabled={!consent.data?.all_confirmed}
                          aria-describedby="room-consent-help"
                          onClick={() => {
                            if (!consent.data?.all_confirmed) {
                              setProblem('전원의 녹음 동의를 먼저 확인해 주세요');
                              return;
                            }
                            setProblem(null);
                            setStarted(true);
                          }}
                        >
                          통화와 녹음 화면 열기
                        </button>
                        <button
                          type="button"
                          className="dc-btn dc-btn--ghost dc-btn--full"
                          onClick={() => {
                            setProblem(null);
                            setMeetingId(undefined);
                          }}
                        >
                          다른 회의 선택하기
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="dc-call-stage-wrap">
                <div className="dc-stage-tabs" role="tablist" aria-label="회의 도구">
                  {(['call', 'record', 'chat'] as const).map((key, index, keys) => (
                    <button
                      key={key}
                      id={`room-tab-${key}`}
                      type="button"
                      role="tab"
                      className={`dc-btn ${tab === key ? 'dc-btn--blurple' : 'dc-btn--ghost'}`}
                      aria-selected={tab === key}
                      aria-controls={`room-panel-${key}`}
                      tabIndex={tab === key ? 0 : -1}
                      onClick={() => setTab(key)}
                      onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                        event.preventDefault();
                        const next =
                          event.key === 'Home'
                            ? keys[0]!
                            : event.key === 'End'
                              ? keys[2]!
                              : keys[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]!;
                        setTab(next);
                        document.getElementById(`room-tab-${next}`)?.focus();
                      }}
                    >
                      {key === 'call' ? '음성 통화' : key === 'record' ? '녹음 시작·종료' : '프로젝트 채팅'}
                    </button>
                  ))}
                </div>

                {(['call', 'record', 'chat'] as const).map((key) => (
                  <section
                    key={key}
                    id={`room-panel-${key}`}
                    role="tabpanel"
                    aria-labelledby={`room-tab-${key}`}
                    hidden={tab !== key}
                    className="meeting-room__panel"
                  >
                    <iframe
                      title={
                        key === 'call'
                          ? '실제 음성 통화'
                          : key === 'record'
                            ? '개별 트랙 녹음'
                            : '프로젝트 채팅'
                      }
                      src={
                        key === 'chat'
                          ? `/chat.html?project=${state.projectId}&embedded=1`
                          : `/${key === 'call' ? 'call' : 'index'}.html?meeting=${meetingId}&embedded=1`
                      }
                      allow="microphone; autoplay"
                    />
                  </section>
                ))}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
