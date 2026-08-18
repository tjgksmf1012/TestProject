import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { TrackRibbon, type RibbonSegment } from '../components/TrackRibbon.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { useConsent, useLobbyMutations, useMe, useMeeting, useTracks } from '../api/hooks.ts';
import {
  captureAlerts,
  memberStatuses,
  roomStatus,
  savedExtraConsents,
  startBlockers,
  type TrackHealth,
} from '@lib/lobby/room.ts';
import { axisTicks, buildDiagram, describeGap, meetingWindow, type TrackInput } from '@lib/track/diagram.ts';

// 회의 로비 — 시그니처가 사는 곳 (지시서 기타-6 §로비).
//
// 참가자마다 트랙 리본 LG. **빈 상태에도 축과 눈금을 그립니다** —
// 빈 리본은 "여기에 곧 기록이 쌓인다" 고 말합니다.

const EMPTY_TICKS = ['0분', '7', '13', '20', '27', '33', '40분'];

export default function Lobby() {
  const params = useParams();
  const meetingId = Number(params['meetingId']);
  const meeting = useMeeting(meetingId);
  const consent = useConsent(meetingId, 5000);
  const tracks = useTracks(meetingId, 5000);
  const { data: me } = useMe();
  const m = useLobbyMutations(meetingId);

  const roster = consent.data?.roster ?? [];
  const trackList: TrackHealth[] = tracks.data?.tracks ?? [];
  const statuses = memberStatuses(roster, trackList);
  const room = roomStatus(statuses);
  const blockers = startBlockers(roster);

  // 끝난 트랙이 있으면 실제 시간축 위에 구멍까지 그립니다.
  const inputs: TrackInput[] = useMemo(
    () =>
      trackList.map((t) => ({
        userId: t.user_id,
        startedAt: t.started_at ?? null,
        endedAt: t.ended_at ?? null,
        gaps: t.gaps ?? [],
      })),
    [trackList],
  );
  const diagram = useMemo(() => buildDiagram(inputs), [inputs]);
  const window_ = useMemo(() => meetingWindow(inputs), [inputs]);
  const ticks = diagram.durationMs > 0 ? axisTicks(diagram.durationMs) : EMPTY_TICKS;

  const segmentsFor = (userId: number): RibbonSegment[] => {
    if (window_ === null || diagram.durationMs === 0) return [];
    const input = inputs.find((i) => i.userId === userId);
    const startMs = input?.startedAt ? Date.parse(input.startedAt) : NaN;
    const endMs = input?.endedAt ? Date.parse(input.endedAt) : NaN;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
    const total = diagram.durationMs;
    const left = (startMs - window_.startMs) / total;
    const right = (endMs - window_.startMs) / total;
    const segments: RibbonSegment[] = [{ start: left, end: right, kind: 'known' }];
    for (const span of diagram.gaps.get(userId) ?? []) {
      segments.push({ start: span.left / 100, end: (span.left + span.width) / 100, kind: 'unknown' });
    }
    return segments;
  };

  const mine = me !== null && me !== undefined ? roster.find((r) => r.user_id === me.user_id) : undefined;
  const saved = me !== null && me !== undefined ? savedExtraConsents(roster, me.user_id) : { rawAudio: null, voiceprint: null };
  const [rawAudio, setRawAudio] = useState<boolean | null>(null);
  const [voiceprint, setVoiceprint] = useState<boolean | null>(null);
  const rawAudioValue = rawAudio ?? saved.rawAudio ?? true;
  const voiceprintValue = voiceprint ?? saved.voiceprint ?? true;
  const iAgreed = mine !== undefined && mine.recording === true;

  const submitConsent = async (consented: boolean) => {
    // ②③ 을 먼저 남기고 ① 을 마지막에 — 서버는 저장된 값으로 판단합니다.
    if (consented) {
      await m.consent.mutateAsync({ consent_type: 'raw_audio_retention', consented: rawAudioValue });
      await m.consent.mutateAsync({ consent_type: 'voiceprint_storage', consented: voiceprintValue });
    }
    await m.consent.mutateAsync({ consent_type: 'recording', consented });
  };

  const title = meeting.data?.title ?? '회의 준비';

  return (
    <AppShell
      title={title}
      projectId={meeting.data?.project_id}
      meta={room.message}
      actions={
        <div style={{ display: 'flex', gap: 'var(--sp-4)' }}>
          {meeting.data?.status === 'needs_review' && (
            <Link className="btn btn--primary" to={`/meeting/${meetingId}/review`}>
              업무 후보 검토
            </Link>
          )}
          {room.needsForceFinish && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={m.finish.isPending}
              onClick={() => m.finish.mutate()}
            >
              회의 강제 종료
            </button>
          )}
          <a className="btn btn--secondary" href={`/call.html?meeting=${meetingId}`}>
            통화 열기
          </a>
          <span title={blockers.join(' · ') || undefined}>
            <a
              className={`btn btn--primary${!iAgreed || blockers.length > 0 ? ' btn--disabled-link' : ''}`}
              href={iAgreed && blockers.length === 0 ? `/index.html?meeting=${meetingId}` : undefined}
              aria-disabled={!iAgreed || blockers.length > 0}
            >
              녹음 화면으로
            </a>
          </span>
        </div>
      }
    >
      <div className="panes">
        <section className="pane" aria-label="참가자 상태">
          <div className="pane__head">
            <h2 className="pane__title">참가자 상태</h2>
            <span className="pane__count">{roster.length}명</span>
          </div>
          <div className="pane__body">
            {statuses.map((status) => {
              const track = trackList.find((t) => t.user_id === status.userId);
              const gapSpans = diagram.gaps.get(status.userId) ?? [];
              return (
                <div className="lrow" key={status.userId}>
                  <span className="lrow__name">{status.name}</span>
                  <div className="lrow__ribbon">
                    <TrackRibbon
                      size="lg"
                      segments={segmentsFor(status.userId)}
                      ticks={ticks}
                      label={`${status.name} — ${status.message}`}
                    />
                    {gapSpans.length > 0 && (
                      <p className="t12 crow__flags">
                        {gapSpans.map((span) => describeGap(span, diagram.durationMs)).join(' · ')}
                      </p>
                    )}
                    {captureAlerts(track).map((alert) => (
                      <p className="t12 crow__flags" key={alert}>
                        {alert}
                      </p>
                    ))}
                  </div>
                  <span className="lrow__status t12">{status.message}</span>
                </div>
              );
            })}
            {roster.length === 0 && consent.isSuccess && (
              <div className="empty">이 프로젝트에 팀원이 없습니다.</div>
            )}
            {room.recording === 0 && statuses.every((s) => s.verdict === 'not_joined') && roster.length > 0 && (
              <p className="muted t13" style={{ marginTop: 'var(--sp-4)' }}>
                아직 아무도 참가하지 않았습니다
              </p>
            )}
            {blockers.length > 0 && (
              <p className="notice" role="note" style={{ marginTop: 'var(--sp-5)' }}>
                {blockers.join(' · ')}
              </p>
            )}
          </div>
        </section>

        <section className="pane" style={{ flex: '0 1 24rem' }} aria-label="녹음 동의">
          <div className="pane__head">
            <h2 className="pane__title">녹음 동의</h2>
          </div>
          <div className="pane__body">
            <p className="t13" style={{ marginBottom: 'var(--sp-4)' }}>
              {consent.data?.message ?? ''}
            </p>
            <label className="t13" style={{ display: 'flex', gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
              <input
                type="checkbox"
                checked={rawAudioValue}
                onChange={(e) => setRawAudio(e.target.checked)}
              />
              원본 음성 보관 — 검토 화면에서 구간을 다시 들을 수 있습니다
            </label>
            <label className="t13" style={{ display: 'flex', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
              <input
                type="checkbox"
                checked={voiceprintValue}
                onChange={(e) => setVoiceprint(e.target.checked)}
              />
              목소리 특징 저장 — 다음 회의에서 화자를 더 잘 알아봅니다
            </label>
            <div className="sec__row">
              <button
                type="button"
                className="btn btn--primary"
                disabled={m.consent.isPending || iAgreed}
                onClick={() => void submitConsent(true)}
              >
                {iAgreed ? '동의했습니다' : '동의합니다'}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={m.consent.isPending}
                onClick={() => void submitConsent(false)}
              >
                거부합니다
              </button>
            </div>
            {m.consent.isError && (
              <p className="disabled-reason">
                동의를 남기지 못했습니다 — 잠시 뒤 다시 해 보세요.
              </p>
            )}
            <Disclosure summary="무엇에 동의하는 건가요">
              <p>
                녹음 동의는 이 회의의 내 트랙을 만드는 것에 대한 동의입니다. 원본
                보관과 목소리 특징 저장은 따로 선택하며, 설정의 “내 녹음
                지우기”로 언제든 지울 수 있습니다.
              </p>
            </Disclosure>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
