import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '../components/AppShell.tsx';
import { TrackRibbon, type RibbonSegment } from '../components/TrackRibbon.tsx';
import { Disclosure } from '../components/Disclosure.tsx';
import { Why } from '../components/Why.tsx';
import { Conditions, describeConditions, type Condition } from '../components/Conditions.tsx';
import {
  useConsent,
  useLobbyMutations,
  useMe,
  useMeeting,
  useMeetingProgress,
  useReprocess,
  useTracks,
} from '../api/hooks.ts';
import {
  captureAlerts,
  lobbyPhase,
  memberStatuses,
  roomStatus,
  savedExtraConsents,
  startBlockers,
  verdictView,
  whyConsentBlocked,
  type TrackHealth,
  REPROCESS_CONFIRM,
} from '@lib/lobby/room.ts';
import { axisTicks, buildDiagram, describeGap, meetingWindow, type TrackInput } from '@lib/track/diagram.ts';
import {
  describeRecordingSafety,
  isRiskyForRecording,
  recordingSafety,
} from '@lib/platform/recording.ts';
import { Problem } from '../components/Problem.tsx';
import { describeMeetingStatus } from '@lib/home/next.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';
import { ApiError } from '../api/client.ts';

// 회의 로비 — 시그니처가 사는 곳 (지시서 기타-6 §로비).
//
// 참가한 사람에게는 트랙 리본 LG. ⚠️ **아직 참가 안 한 사람에게는 축을
// 그리지 않습니다** (v2 F3) — 예전에는 빈 상태에도 축과 눈금을 그렸고
// "여기에 곧 기록이 쌓인다" 는 뜻이라고 적어 두었지만, 셋 다 대기 중이면
// 빈 회색 막대 셋이 화면의 무게중심을 차지했습니다. 잴 게 없으면 안
// 그리고, 그 자리는 「시작 전 확인」 이 씁니다 (v2 F5).

const EMPTY_TICKS = ['0분', '7', '13', '20', '27', '33', '40분'];

export default function Lobby() {
  const params = useParams();
  const meetingId = Number(params['meetingId']);
  const meeting = useMeeting(meetingId);
  const consent = useConsent(meetingId, 5000);
  const tracks = useTracks(meetingId, 5000);
  const { data: me } = useMe();
  const m = useLobbyMutations(meetingId);

  /* ⛔ 명단도 같습니다 (결함 255). 아직 안 온 동안 화면은 「참가자 상태
     0명」과 「아직 아무도 참가하지 않았습니다」를 **단언**했습니다 —
     아무것도 모르는 채로요. 세는 것과 말하는 것은 명단이 온 뒤에. */
  const rosterKnown = consent.data !== undefined;
  const roster = consent.data?.roster ?? [];
  /* ⛔ **`?? []` 가 「못 받음」을 「아무도 참가 안 함」으로 접었습니다**
     (결함 255). `/tracks` 를 500 으로 막고 이미 녹음이 끝난 회의를 열면
     커버리지 100·98·42% 인 세 사람이 나란히 「미참가」로 섰고, 화면
     어디에도 못 받았다는 말이 없었습니다. 아직 안 온 동안도 같습니다 —
     `null` 을 넘겨 「모른다」고 말하게 합니다. */
  const trackList: TrackHealth[] | null = tracks.data ? tracks.data.tracks : null;
  const statuses = memberStatuses(roster, trackList);
  const room = roomStatus(statuses, rosterKnown);
  const blockers = startBlockers(roster);

  // 끝난 트랙이 있으면 실제 시간축 위에 구멍까지 그립니다.
  const inputs: TrackInput[] = useMemo(
    () =>
      (trackList ?? []).map((t) => ({
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
  // ⚠️ **이 화면은 오래도록 회의 상태를 안 봤습니다** (결함 214). 다섯
  //    상태에서 화면이 글자까지 같았고, 검토까지 끝난 회의에서도
  //    「녹음 화면으로」가 멀쩡히 눌렸습니다. 판단은 `@lib` 에 있습니다.
  /* ⚠️ **못 받았는데 「아직 아무도 참가하지 않았습니다」 라고 했습니다**
     (결함 224). 새로 가입한 사람이 남의 회의 주소를 열면 서버는 403 인데,
     화면은 참가자 0명짜리 빈 로비를 그렸습니다 — 「아무도 아직 안 들어온
     회의」 와 구별이 안 됩니다. 설정·기여도는 결함 211 에서 고쳤고,
     여기가 빠져 있었습니다. */
  const loadError = meeting.error ?? consent.error;
  const cannotLoad =
    loadError == null
      ? null
      : describeLoadFailure('회의', loadError instanceof ApiError ? loadError.status : null);

  const phase = lobbyPhase(meeting.data?.status);
  // 「다시 처리할 수 있는가」는 **서버가** 정합니다 (결함 231).
  const progress = useMeetingProgress(meetingId);
  const reprocess = useReprocess(meetingId);
  const canGoRecord = phase.canStart && startConditions.every((c) => c.met);

  // 지금 이 창이 녹음을 끝까지 붙잡을 수 있는가. 판단은 `@lib` 에 있습니다.
  const safety = recordingSafety(window, window.matchMedia('(display-mode: standalone)').matches);
  const risky = isRiskyForRecording(safety);
  // 한 명이라도 참가했으면 레인 칸을 유지합니다 — 참가한 사람과 아직인
  // 사람이 섞여 있을 때 축이 서로 어긋나면 시간을 견줄 수 없습니다.
  const anyJoined = statuses.some((s) => s.verdict !== 'not_joined');

  /** 동의 단추를 지금 못 누르는 까닭 (결함 239). 판단은 `@lib`. */
  const consentBlocked = whyConsentBlocked({
    sending: m.consent.isPending,
    alreadyAgreed: iAgreed,
  });

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
      /* ⚠️ **머리줄이 아래 설명과 반대되는 말을 하고 있었습니다** (결함 214).
         실패한 회의에서 「아직 아무도 참가하지 않았습니다」 — 「아직」 은
         곧 들어온다는 뜻인데, 그 회의는 이미 끝났습니다. 방 상태는 녹음
         국면에서만 소식이고, 끝난 뒤에는 **회의가 어느 상태인가**가
         소식입니다. 낱말은 홈의 상태 칩과 같은 곳(`describeMeetingStatus`)
         에서 옵니다 — 두 화면이 갈라지지 않게. */
      meta={
        /* ⚠️ 못 받았으면 방 상태를 말하지 않습니다 (결함 224) — 「아직
           아무도 참가하지 않았습니다」 는 볼 권한이 없는 사람에게 거짓입니다. */
        cannotLoad !== null
          ? ''
          : phase.canStart
            ? room.message
            : describeMeetingStatus(meeting.data?.status ?? '')
      }
      actions={
        <div className="appbar__actions">
          {cannotLoad !== null ? null : (
          <>
          {/* ⚠️ **막았으면 갈 곳을 줍니다.** 예전에는 `needs_review` 만
              보고 「업무 후보 검토」를 그렸고, 검토가 끝난 회의(`confirmed`)
              에서는 나가는 문이 「통화 열기」뿐이었습니다. 어디로 보낼지는
              `lobbyPhase` 가 정합니다 — 화면은 그리기만 합니다. */}
          {phase.go !== null && (
            <Link
              className="btn btn--primary"
              to={
                phase.go.screen === 'review'
                  ? `/meeting/${meetingId}/review`
                  : `/project/${meeting.data?.project_id ?? ''}/kanban`
              }
            >
              {phase.go.label}
            </Link>
          )}
          {/* ⚠️ **실패해도 아무 말도 안 했습니다** (결함 218). 500 을 받아도
              화면 글자가 한 글자도 안 바뀌었고, 사람은 회의가 종료된 줄
              알고 떠납니다. 그 회의는 영영 처리되지 않습니다 — 강제 종료가
              있는 이유가 바로 그것을 푸는 것인데요. */}
          {m.finish.isError && (
            <Problem>
              {describeActionFailure(
                '회의 강제 종료',
                m.finish.error instanceof ApiError ? m.finish.error.status : null,
              )}
            </Problem>
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
          {phase.canStart && startConditions.some((c) => !c.met) && (
            <span className="conds-slot">
              <Conditions items={startConditions} id="start-conds" />
              {blockers.length > 0 && <Why about="녹음 시작 조건" lines={blockers} />}
            </span>
          )}
          <a
            className={`btn btn--primary${!canGoRecord ? ' btn--unmet btn--disabled-link' : ''}`}
            href={canGoRecord ? `/index.html?meeting=${meetingId}` : undefined}
            aria-disabled={!canGoRecord}
            /* ⚠️ **`href` 없는 `<a>` 는 초점을 못 받습니다** (결함 219).
               막혔을 때 `href` 를 안 주므로, 탭을 60번 눌러도 이 버튼에
               닿지 않았습니다 — 즉 `aria-describedby` 가 가리키는 사유를
               **낭독기가 영영 못 읽습니다.** 이 저장소가 "비활성 버튼은
               `aria-disabled` 라 초점도 받는다" 고 적어 둔 그 약속이
               여기서만 거짓이었습니다. 초점은 직접 줍니다. */
            tabIndex={0}
            /* 막힌 이유가 둘입니다 — 아직 동의가 안 찼거나(조건 칩),
               이미 끝난 회의이거나(국면 설명). 가리키는 곳이 다릅니다. */
            aria-describedby={
              canGoRecord ? undefined : phase.canStart ? 'start-conds' : 'phase-note'
            }
            title={
              !canGoRecord
                ? (phase.note ?? describeConditions(startConditions))
                : undefined
            }
          >
            녹음 화면으로
          </a>
          </>
          )}
        </div>
      }
    >
      <div className="panes">
        {cannotLoad !== null ? (
          <section className="pane">
            <div className="pane__body">
              <div className="empty">{cannotLoad}</div>
            </div>
          </section>
        ) : (
        <>
        <section className="pane" aria-label="참가자 상태">
          <div className="pane__head">
            <h2 className="pane__title">참가자 상태</h2>
            <span className="pane__count">{rosterKnown ? `${roster.length}명` : '—'}</span>
          </div>
          <div className="pane__body">
            {/* ⚠️ **홈이 한 말이 여기서 사라지고 있었습니다** (결함 214).
                홈은 "처리에 실패했습니다 — 트랙이 온전한지 확인하세요"
                라고 보내는데, 도착한 화면에는 「실패」라는 낱말이 **한 번도**
                안 나왔습니다. 대신 「시작 전 확인」과 「녹음 화면으로」가
                떠 있어, 이미 지나간 일을 준비하라고 말하고 있었습니다.

                `id` 는 막힌 「녹음 화면으로」가 `aria-describedby` 로
                가리킵니다 — 눈으로 보는 사람과 낭독기가 같은 문장을
                받습니다. */}
            {phase.note !== null && (
              <p className="phase-note" id="phase-note">
                {phase.note}
              </p>
            )}
            {/* ⛔ **여기가 막다른 길이었습니다** (결함 231).
                화면은 「처리에 실패했습니다. 아래 트랙이 온전한지
                확인하세요」 라고 시켜 놓고, 확인한 사람에게 **누를 것을
                안 줬습니다.** 서버에는 `/reprocess` 가 있고 `progress` 가
                `can_reprocess: true` 라고 답하는데 SPA 로비는 그걸 한 번도
                안 물어봤습니다 — 레거시 로비(`lobby.html`)에는 있었고
                화면을 옮기면서 **버튼만 남겨졌습니다.**

                ⚠️ 언제 다시 처리할 수 있는지는 **서버가 정합니다.**
                화면이 `status` 로 스스로 정하면 규칙이 두 곳에 생깁니다. */}
            {progress.data?.can_reprocess === true && (
              <p className="phase-act">
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={reprocess.isPending}
                  onClick={() => {
                    // ⚠️ 되돌릴 수 없습니다 — 묻고 나서 합니다. 문구는
                    //    `@lib` 한 곳에 있습니다(레거시와 같은 말).
                    if (!window.confirm(REPROCESS_CONFIRM)) return;
                    reprocess.mutate();
                  }}
                >
                  {reprocess.isPending ? '다시 처리하는 중…' : '다시 처리하기'}
                </button>
                <Problem>
                  {reprocess.isError
                    ? describeActionFailure(
                        '다시 처리',
                        reprocess.error instanceof ApiError ? reprocess.error.status : null,
                      )
                    : reprocess.isSuccess
                      ? (reprocess.data?.message ?? '')
                      : null}
                </Problem>
              </p>
            )}
            {/* ⛔ **눈금이 사람마다 한 벌씩 있었습니다** (결함 261). 셋이면
                같은 자(`0분 7 13 20 27 33 40분`)가 세 번 그려집니다 — 같은
                회의의 같은 시간축인데요. 값이 아니라 **잉크만** 세 배였고,
                이 화면에서 제일 반복되는 글자였습니다. 축은 위에 **한 벌**만
                두고, 줄에는 막대만 그립니다.
                ⚠️ 같은 격자(`.lrow`)를 써야 축과 막대가 어긋나지 않습니다. */}
            {anyJoined && (
              <div className="lrow lrow--axis" aria-hidden="true">
                <span />
                <div className="ribbon-axis">
                  {ticks.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
                <span />
              </div>
            )}
            {statuses.map((status) => {
              const track = trackList?.find((t) => t.user_id === status.userId);
              const gapSpans = diagram.gaps.get(status.userId) ?? [];
              // 모르는 것은 「참가했다」가 아닙니다 (결함 255).
              const joined = status.verdict !== 'not_joined' && status.verdict !== 'unknown';
              // 같은 판정이라도 **국면이 바뀌면 뜻이 달라집니다** — 끝난
              // 회의의 「대기」는 「미참가」입니다 (결함 214).
              const view = verdictView(status, phase.canStart);
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
                        label={`${status.name} — ${status.message}`}
                      />
                    )}
                  </div>
                  {/* 상태는 **한 낱말**, 문장은 `?` 안에.
                      예전에는 사람마다 같은 문장(`아직 참가하지 않았습니다`)이
                      그대로 붙어 셋이면 세 번 반복됐고, 끊긴 트랙의 진짜
                      경고가 그 반복 속에 묻혔습니다. */}
                  <span className="lrow__status">
                    <span className="lrow__word">{view.word}</span>
                    <Why
                      about={`${status.name} — 트랙 상태`}
                      lines={[
                        view.message,
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
            {phase.canStart && room.recording === 0 && roster.length > 0 && (
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
              {/* ⚠️ `disabled` 가 아니라 `aria-disabled` 입니다 (결함 234).
                  이미 동의한 사람의 버튼이 `disabled` 면 **Tab 이 건너뛰어**
                  「동의했습니다」라는 그 말 자체에 닿지 못합니다. 눌러도
                  다시 안 보냅니다.
                  ⛔ 그런데 **왜 막혔는지는 말하지 않았습니다** (결함 239) —
                  `aria-describedby` 가 없었습니다. 동의 한 번은 요청 셋이라
                  느린 연결에서는 십수 초 동안 눌러도 안 먹는데 화면이 조용
                  했습니다. 판단은 `@lib` 의 `whyConsentBlocked`. */}
              <button
                type="button"
                className={`btn btn--primary${consentBlocked !== null ? ' btn--unmet' : ''}`}
                aria-disabled={consentBlocked !== null}
                aria-describedby={consentBlocked !== null ? 'consent-why' : undefined}
                onClick={() => {
                  if (consentBlocked !== null) return;
                  void submitConsent(true);
                }}
              >
                {iAgreed ? '동의했습니다' : '동의합니다'}
              </button>
              {/* 되돌리는 쪽도 보내는 동안은 막힙니다 — 같은 사유를 가리킵니다. */}
              <button
                type="button"
                className={`btn btn--ghost${m.consent.isPending ? ' btn--unmet' : ''}`}
                aria-disabled={m.consent.isPending}
                aria-describedby={m.consent.isPending ? 'consent-why' : undefined}
                onClick={() => {
                  if (m.consent.isPending) return;
                  void submitConsent(false);
                }}
              >
                거부합니다
              </button>
            </div>
            {/* 눈으로 보는 사람과 낭독기가 **같은 문장**을 받습니다. */}
            {consentBlocked !== null && (
              <p className="t13 phase-note" id="consent-why">
                {consentBlocked}
              </p>
            )}
            {m.consent.isError && (
              <Problem>동의를 남기지 못했습니다 — 잠시 뒤 다시 해 보세요.</Problem>
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
        </>
        )}
      </div>
    </AppShell>
  );
}
