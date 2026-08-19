import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { TrackRibbon, type RibbonSegment } from '../components/TrackRibbon.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { Why } from '../components/Why.tsx';
import { Conditions, describeConditions, type Condition } from '../components/Conditions.tsx';
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
import {
  describeRecordingSafety,
  isRiskyForRecording,
  recordingSafety,
} from '@lib/platform/recording.ts';

// 회의 로비 — 시그니처가 사는 곳 (지시서 기타-6 §로비).
//
// 참가한 사람에게는 트랙 리본 LG. ⚠️ **아직 참가 안 한 사람에게는 축을
// 그리지 않습니다** (v2 F3) — 예전에는 빈 상태에도 축과 눈금을 그렸고
// "여기에 곧 기록이 쌓인다" 는 뜻이라고 적어 두었지만, 셋 다 대기 중이면
// 빈 회색 막대 셋이 화면의 무게중심을 차지했습니다. 잴 게 없으면 안
// 그리고, 그 자리는 「시작 전 확인」 이 씁니다 (v2 F5).

const EMPTY_TICKS = ['0분', '7', '13', '20', '27', '33', '40분'];

/** 상태를 한 낱말로. 문장은 `Why` 안에서 원문 그대로 나옵니다. */
const VERDICT_WORD: Record<string, string> = {
  not_joined: '대기',
  healthy: '녹음 중',
  at_risk: '끊김',
  broken: '못 씀',
  finished: '종료',
};

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

  // 녹음 화면으로 넘어가는 두 관문. 문장이 아니라 **칩**으로 버튼 옆에 섭니다.
  const startConditions: Condition[] = [
    { label: '내 동의', met: iAgreed },
    { label: '전원 동의', met: blockers.length === 0 },
  ];
  const canGoRecord = startConditions.every((c) => c.met);

  // 지금 이 창이 녹음을 끝까지 붙잡을 수 있는가. 판단은 `@lib` 에 있습니다.
  const safety = recordingSafety(window, window.matchMedia('(display-mode: standalone)').matches);
  const risky = isRiskyForRecording(safety);
  // 한 명이라도 참가했으면 레인 칸을 유지합니다 — 참가한 사람과 아직인
  // 사람이 섞여 있을 때 축이 서로 어긋나면 시간을 견줄 수 없습니다.
  const anyJoined = statuses.some((s) => s.verdict !== 'not_joined');

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
        <div className="appbar__actions">
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
          {/* 못 넘어가는 이유는 **버튼 옆에** 둡니다 (GOV.UK 권고).
              예전에는 이 사유가 왼쪽 판 한가운데 문장으로 앉아 있었고,
              헤더가 이미 같은 말을 하고 있어 한 화면에서 방 상태를 **네 번**
              말했습니다 — 그중 둘은 글자까지 같았습니다. */}
          {startConditions.some((c) => !c.met) && (
            <span className="conds-slot">
              <Conditions items={startConditions} id="start-conds" />
              {blockers.length > 0 && <Why about="녹음 시작 조건" lines={blockers} />}
            </span>
          )}
          <a
            className={`btn btn--primary${!canGoRecord ? ' btn--unmet btn--disabled-link' : ''}`}
            href={canGoRecord ? `/index.html?meeting=${meetingId}` : undefined}
            aria-disabled={!canGoRecord}
            aria-describedby={!canGoRecord ? 'start-conds' : undefined}
            title={!canGoRecord ? describeConditions(startConditions) : undefined}
          >
            녹음 화면으로
          </a>
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
              const joined = status.verdict !== 'not_joined';
              return (
                <div className={`lrow${anyJoined ? '' : ' lrow--nolane'}`} key={status.userId}>
                  <span className="lrow__name">{status.name}</span>
                  {/* ⚠️ **아직 참가 안 한 사람에게는 축을 그리지 않습니다**
                      (v2 F3). 셋 다 대기 중이면 빈 회색 막대가 셋 서 있었고,
                      레인이 "아는 것 / 모르는 것" 을 말하는 문법인데 잴 게
                      없을 때 막대를 그리면 그 문법이 무너집니다. 이 사람이
                      어떤 상태인지는 오른쪽 낱말이 말합니다. */}
                  <div className="lrow__ribbon">
                    {joined && (
                      <TrackRibbon
                        size="lg"
                        segments={segmentsFor(status.userId)}
                        ticks={ticks}
                        label={`${status.name} — ${status.message}`}
                      />
                    )}
                  </div>
                  {/* 상태는 **한 낱말**, 문장은 `?` 안에.
                      예전에는 사람마다 같은 문장(`아직 참가하지 않았습니다`)이
                      그대로 붙어 셋이면 세 번 반복됐고, 끊긴 트랙의 진짜
                      경고가 그 반복 속에 묻혔습니다. */}
                  <span className="lrow__status">
                    <span className="lrow__word">{VERDICT_WORD[status.verdict]}</span>
                    <Why
                      about={`${status.name} — 트랙 상태`}
                      lines={[
                        status.message,
                        ...gapSpans.map((span) => describeGap(span, diagram.durationMs)),
                        ...captureAlerts(track),
                      ]}
                    />
                  </span>
                </div>
              );
            })}
            {roster.length === 0 && consent.isSuccess && (
              <div className="empty">이 프로젝트에 팀원이 없습니다.</div>
            )}
            {/* ⚠️ "아직 아무도 참가하지 않았습니다" 를 여기 또 적지 않습니다 —
                헤더 meta 가 `room.message` 로 **같은 문장을 글자까지 똑같이**
                말하고 있었습니다. 동의 사유도 여기 있었지만, 그 사유가 막는
                것은 헤더의 버튼이므로 사유도 버튼 옆으로 옮겼습니다. */}

            {/* 시작 전 확인 (v2 F5) — F3 로 빈 막대를 걷어내고 남은 자리.
                채우려고 만든 글이 아닙니다: 이 제품에서 **녹음이 한 번
                끊기면 그 구간은 영영 못 잽니다.** 브라우저 탭은 창을 내리면
                녹음을 끊고, 그래서 이 저장소에 데스크톱 셸이 있습니다
                (docs/21). 그 사실을 확인할 자리가 여기 말고 없었습니다.
                두 줄 다 **이미 있는 판단**에서 옵니다 — 새 문구가 아닙니다. */}
            {room.recording === 0 && roster.length > 0 && (
              <div className="preflight">
                <h3 className="preflight__title">시작 전 확인</h3>
                <ul className="preflight__list">
                  <li className={`preflight__item${blockers.length === 0 ? ' preflight__item--met' : ''}`}>
                    <span aria-hidden="true">{blockers.length === 0 ? '●' : '○'}</span>
                    <span className="preflight__label">전원 동의</span>
                    {blockers.length > 0 && <Why about="아직 동의하지 않은 사람" lines={blockers} />}
                  </li>
                  <li className={`preflight__item${risky ? '' : ' preflight__item--met'}`}>
                    <span aria-hidden="true">{risky ? '○' : '●'}</span>
                    <span className="preflight__label">녹음이 안 끊기는 환경</span>
                    <Why about="지금 이 창" lines={[describeRecordingSafety(safety)]} />
                  </li>
                </ul>
              </div>
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
