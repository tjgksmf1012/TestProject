import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  useConsent, useLobbyMutations, useMe, useMeetings, useSettingsMutations,
} from '../api/hooks.ts';
import { apiFailureText } from '../api/client.ts';
import { meetingLabel } from '@lib/ui/naming.ts';
import { Problem } from './Problem.tsx';

type Launch = { projectId: number; minimized: boolean; opener: HTMLElement | null } | null;
let launch: Launch = null;
const listeners = new Set<() => void>();
const publish = (next: Launch) => { launch = next; listeners.forEach((notify) => notify()); };
const subscribe = (notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; };

/** 현재 프로젝트를 명시해야 회의 창을 열 수 있습니다. */
export function triggerInstantCall(projectId: number | undefined): void {
  if (projectId !== undefined && Number.isSafeInteger(projectId) && projectId > 0) {
    publish(launch ? { ...launch, minimized: false } : {
      projectId, minimized: false,
      opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    });
  }
}

/** 라우터 바깥에 한 번만 마운트해 화면 이동으로 장치가 끊기지 않게 합니다. */
export function CallStageModal() {
  const state = useSyncExternalStore(subscribe, () => launch);
  const { data: me } = useMe();
  useEffect(() => { if (me === null) publish(null); }, [me]);
  if (!state || !me) return null;
  return <MeetingRoom key={state.projectId} state={state} userId={me.user_id} />;
}

function MeetingRoom({ state, userId }: { state: NonNullable<Launch>; userId: number }) {
  const [meetingId, setMeetingId] = useState<number>();
  const [started, setStarted] = useState(false);
  const [tab, setTab] = useState<'call' | 'record' | 'chat'>('call');
  const [problem, setProblem] = useState<string | null>(null);
  const meetings = useMeetings(state.projectId);
  const { openMeeting } = useSettingsMutations(state.projectId);
  const consent = useConsent(meetingId, 3000);
  const mutations = useLobbyMutations(meetingId);
  const mine = consent.data?.roster.find((row) => row.user_id === userId);
  const chosen = meetings.data?.find((meeting) => meeting.meeting_id === meetingId);
  const title = meetingId === undefined ? '회의실 준비' : meetingLabel(chosen?.title, meetingId);
  useEffect(() => {
    if (!state.minimized) document.getElementById('meeting-room-title')?.focus();
  }, [state.minimized]);
  const close = () => {
    if (started && !window.confirm('통화와 녹음 화면을 닫습니다. 녹음 중이라면 먼저 녹음 탭에서 종료해 주세요. 닫을까요?')) return;
    publish(null);
    if (state.opener?.isConnected) state.opener.focus();
  };
  const chooseNew = async () => {
    setProblem(null);
    try { setMeetingId((await openMeeting.mutateAsync()).meeting_id); }
    catch (error) { setProblem(apiFailureText(error)); }
  };
  const giveConsent = async (consent_type: string, consented: boolean) => {
    setProblem(null);
    try { await mutations.consent.mutateAsync({ consent_type, consented }); }
    catch (error) { setProblem(apiFailureText(error)); }
  };

  return <>
    {state.minimized && <aside className="meeting-mini" aria-label="열려 있는 회의 창">
      <span>{title} · 통화와 녹음 화면이 열려 있습니다</span>
      <button className="btn btn--secondary" onClick={() => publish({ ...state, minimized: false })}>회의 창 다시 열기</button>
    </aside>}
    <Dialog.Root modal={false} open={!state.minimized} onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal forceMount>
        <Dialog.Content forceMount className="dialog meeting-room" hidden={state.minimized}
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => { event.preventDefault(); if (state.opener?.isConnected) state.opener.focus(); }}>
          <header className="meeting-room__header">
            <Dialog.Title id="meeting-room-title" tabIndex={-1} className="sec__title">{title}</Dialog.Title>
            <div className="meeting-room__actions">
              {started && <button className="btn btn--ghost" onClick={() => {
                publish({ ...state, minimized: true });
                requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.meeting-mini button')?.focus());
              }}>작게 두기</button>}
              <button className="btn btn--ghost" onClick={close}>닫기</button>
            </div>
          </header>
          <Dialog.Description className="muted">
            음성 통화와 녹음은 별도입니다. 전원이 동의한 뒤 녹음 탭에서 시작하세요.
            채팅은 프로젝트 대화이며 기여도에 자동으로 포함하지 않습니다.
          </Dialog.Description>
          {problem && <Problem>{problem}</Problem>}
          {!started ? <div className="meeting-room__setup">
            {meetingId === undefined ? <>
              <button className="btn btn--primary" disabled={openMeeting.isPending} onClick={() => void chooseNew()}>
                {openMeeting.isPending ? '회의를 여는 중…' : '새 회의 열기'}
              </button>
              {meetings.isPending && <p role="status">회의를 불러오는 중입니다</p>}
              {meetings.isError && <Problem>회의를 불러오지 못했습니다. <button className="btn btn--ghost" onClick={() => void meetings.refetch()}>다시 불러오기</button></Problem>}
              <ul className="meeting-room__list">
                {(meetings.data ?? []).filter((meeting) => meeting.status === 'pending' && meeting.started_at !== null).map((meeting) =>
                  <li key={meeting.meeting_id}><button className="btn btn--secondary" onClick={() => { setProblem(null); setMeetingId(meeting.meeting_id); }}>
                    {meetingLabel(meeting.title, meeting.meeting_id)} · 준비 중인 회의 참가
                  </button></li>,
                )}
              </ul>
            </> : <>
              <a href={`/app/meeting/${meetingId}/lobby`} className="btn btn--ghost" target="_blank" rel="noopener noreferrer">회의 로비에서 동의 현황 보기</a>
              {consent.isError && <Problem>동의 현황을 불러오지 못했습니다. <button className="btn btn--ghost" onClick={() => void consent.refetch()}>다시 불러오기</button></Problem>}
              {consent.isPending && <p role="status">동의 현황을 확인하는 중입니다</p>}
              {mine && <fieldset className="meeting-room__consents">
                <legend>내 동의</legend>
                <label><input type="checkbox" checked={mine.recording === true} disabled={mutations.consent.isPending}
                  onChange={(event) => void giveConsent('recording', event.target.checked)} />회의 녹음과 전사에 동의합니다</label>
                <label><input type="checkbox" checked={mine.raw_audio_retention === true} disabled={mutations.consent.isPending}
                  onChange={(event) => void giveConsent('raw_audio_retention', event.target.checked)} />전사 후 원본 음성 보관에 동의합니다 (선택)</label>
              </fieldset>}
              <p id="room-consent-help" role="status">{consent.data?.message ?? '본인의 동의만 변경할 수 있습니다'}</p>
              <button className="btn btn--primary" aria-disabled={!consent.data?.all_confirmed} aria-describedby="room-consent-help"
                onClick={() => {
                  if (!consent.data?.all_confirmed) { setProblem('전원의 녹음 동의를 먼저 확인해 주세요'); return; }
                  setProblem(null); setStarted(true);
                }}>통화와 녹음 화면 열기</button>
            </>}
          </div> : <>
            <div className="meeting-room__tabs" role="tablist" aria-label="회의 도구">
              {(['call', 'record', 'chat'] as const).map((key, index, keys) => <button key={key} id={`room-tab-${key}`} role="tab"
                className={`btn ${tab === key ? 'btn--primary' : 'btn--ghost'}`} aria-selected={tab === key}
                aria-controls={`room-panel-${key}`} tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)} onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault();
                  const next = event.key === 'Home' ? keys[0]! : event.key === 'End' ? keys[2]! : keys[(index + (event.key === 'ArrowRight' ? 1 : 2)) % 3]!;
                  setTab(next); document.getElementById(`room-tab-${next}`)?.focus();
                }}>{key === 'call' ? '음성 통화' : key === 'record' ? '녹음 시작·종료' : '프로젝트 채팅'}</button>)}
            </div>
            {(['call', 'record', 'chat'] as const).map((key) => <section key={key} id={`room-panel-${key}`} role="tabpanel"
              aria-labelledby={`room-tab-${key}`} hidden={tab !== key} className="meeting-room__panel">
              <iframe title={key === 'call' ? '실제 음성 통화' : key === 'record' ? '개별 트랙 녹음' : '프로젝트 채팅'}
                src={key === 'chat' ? `/chat.html?project=${state.projectId}&embedded=1` : `/${key === 'call' ? 'call' : 'index'}.html?meeting=${meetingId}&embedded=1`}
                allow="microphone; autoplay" />
            </section>)}
          </>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}
