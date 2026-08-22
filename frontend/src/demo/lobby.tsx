/**
 * 회의 로비 — **React 로 옮긴 일곱 번째 화면** (docs/19 §24).
 *
 * 동의를 받고, 회의 중에 누구의 트랙이 망가지는지 보여주고, 브라우저를
 * 그냥 닫은 사람 때문에 회의가 안 끝날 때 풀어 줍니다.
 *
 * ⚠️ **판단이 들어가는 것은 전부 `lib/lobby/room.ts`·`lib/track/diagram.ts`
 * 에 있고 테스트로 검증됩니다.** 여기는 그리기만 합니다.
 *
 * 폴링을 쓰는 이유: SSE·WebSocket 을 붙이면 서버에 상태가 생기고, 그건
 * 이 화면 하나 때문에 지불하기엔 비쌉니다. 3초 폴링이면 "폰이 잠겼다" 를
 * 알아채는 데 충분합니다 — 사람이 반응하는 데 어차피 몇 초 걸립니다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { pageTitle } from '../lib/shell/title.ts';
import { meetingLabel } from '../lib/ui/naming.ts';
import { createRoot } from 'react-dom/client';

import {
  canStart,
  captureAlerts,
  consentStateOf,
  describeConsent,
  memberStatuses,
  roomStatus,
  savedExtraConsents,
  startBlockers,
  type RosterEntry,
  type TrackHealth,
  REPROCESS_CONFIRM,
} from '../lib/lobby/room.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { axisTicks, buildDiagram, describeGap } from '../lib/track/diagram.ts';
import { detailText } from '../lib/http/detail.ts';
import { describeUnexpected, trySend, unreachableText } from '../lib/http/send.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rowItems } from '../lib/ui/skeleton.ts';
import { Byline, NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { wireLogout } from './logout.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
const meetingId = Number(params.get('meeting') ?? '1');
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다.
const apiBase = safeApiBase(params.get('api'), location.origin);

const POLL_MS = 3_000;

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

class HttpError extends Error {
  status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/**
 * ⚠️ **던지는 것이 계약입니다.** 부르는 쪽이 `catch` 로 받아 사람에게
 * 씁니다 — `tryGet` 으로 바꾸면 오히려 두 갈래가 됩니다 (결함 98 에서 실측).
 */
async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${apiBase}${path}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (isSessionExpired(response.status)) {
    goToLogin();
    throw new Error('로그인이 필요합니다');
  }
  if (!response.ok) throw new HttpError(response.status);
  return response.json();
}

// `Note`·`NoteLine` 은 `parts.tsx` 에 있습니다 — 프로젝트 화면과 **두 벌**
// 이었고 이미 갈라져 있었습니다(이쪽만 `status` 클래스를 붙였습니다).

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

function Lobby() {
  // 내가 누구인지는 **서버가** 말해 줍니다. 예전에는 `?me=1` 을 읽었는데,
  // 그건 사용자가 자기 신원을 스스로 선언하는 구조였습니다.
  const [me, setMe] = useState<Me | null>(null);
  const [projectId, setProjectId] = useState(0);
  /* ⛔ **회의를 번호로 부르고 있었습니다** (결함 299). 이 화면은 서버가
     주는 `title` 을 받아 놓고 `project_id` 만 꺼내 쓰고 있었습니다 —
     결함 285 가 SPA·서버를 고칠 때 여기만 남았고, 그 가드는 `` `회의
     ${'${id}'}` `` 가 **템플릿 끝에 올 때만** 잡는 자였습니다. */
  const [meetingTitle, setMeetingTitle] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  /* ⚠️ **`null` 은 「아직 못 받음」입니다** (결함 255). 빈 배열로 두면
     명단이 먼저 온 찰나에 전원이 「미참가」로 섭니다. */
  const [tracks, setTracks] = useState<TrackHealth[] | null>(null);
  const [consentMessage, setConsentMessage] = useState('');
  const [progressLine, setProgressLine] = useState('');
  const [canReprocess, setCanReprocess] = useState(false);
  const [sub, setSub] = useState<Note | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [consentNote, setConsentNote] = useState<Note | null>(null);
  const [roomNote, setRoomNote] = useState<Note | null>(null);
  const [reprocessNote, setReprocessNote] = useState<Note | null>(null);
  const [minutesNote, setMinutesNote] = useState<Note | null>(null);
  const [keepAudio, setKeepAudio] = useState(true);
  const [keepVoiceprint, setKeepVoiceprint] = useState(true);
  const [slow, setSlow] = useState(false);
  // 누르는 동안 잠급니다 (결함 89). 동의는 멱등이지만, 두 번 누르면 두
  // 요청이 겹쳐 **나중에 도착한 쪽의 명단**이 화면에 남습니다.
  const [busy, setBusy] = useState(false);

  // ⚠️ 폴링이 3초마다 도는데 그때마다 저장된 ②③ 을 다시 덮으면, 사람이
  // 방금 바꾼 체크가 되돌아갑니다. **한 번만** 적용합니다.
  const extrasApplied = useRef(false);
  // 첫 번째만 스켈레톤을 켭니다. 매번 켜면 살아 있는 참가자 목록이
  // 주기적으로 회색 막대로 바뀝니다 — 로딩 표시가 화면을 망가뜨립니다.
  const loaded = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const first = !loaded.current;
    try {
      const [consent, trackBody] = await whileLoading(
        Promise.all([
          getJson(`/api/meetings/${meetingId}/consent`) as Promise<{
            roster: RosterEntry[];
            message: string;
          }>,
          getJson(`/api/meetings/${meetingId}/tracks`) as Promise<{ tracks: TrackHealth[] }>,
        ]),
        () => {
          if (first) setSlow(true);
        },
        () => {
          if (first) setSlow(false);
        },
      );
      loaded.current = true;
      setLoadFailure(null);
      setRoster(consent.roster);
      setConsentMessage(consent.message);
      setTracks(trackBody.tracks);

      // ⚠️ **진행률은 보조 정보입니다.** 실패해도 로비는 그대로 돌아야
      // 하므로 위 `Promise.all` 에 넣지 않고 따로, 조용히 받습니다.
      //
      // 문구는 **서버가 만든 것을 그대로** 씁니다. 여기서 다시 만들면
      // "0%" 와 "모름" 을 가르는 규칙이 두 곳에 생기고 한쪽만 고쳐집니다.
      const line = await getJson(`/api/meetings/${meetingId}/progress`)
        .then((body) => {
          const payload = body as { message?: string; can_reprocess?: boolean };
          // ⚠️ **판단은 서버가 합니다** (결함 114).
          setCanReprocess(payload.can_reprocess === true);
          return String(payload.message ?? '');
        })
        .catch(() => '');
      setProgressLine(line);
    } catch (error) {
      // ⚠️ **색까지 같이 정합니다** (결함 98). 이 자리는 평소 "회의 1 ·
      // 팀원 3명" 을 말하는 부제라, 실패를 같은 회색으로 쓰면 사람이 그냥
      // 지나칩니다. 첫 로드에는 아래 상자가 같이 뜨지만 **회의 도중 폴링이
      // 끊기면 이 한 줄이 전부**입니다.
      setSub({ text: '불러오지 못했습니다', tone: 'bad' });
      if (first) {
        setSlow(false);
        setLoadFailure(
          failureHtml({
            what: '참가자 상태를 불러오지 못했습니다.',
            ...(error instanceof HttpError && describeHttpStatus(error.status) !== null
              ? { help: describeHttpStatus(error.status) as string }
              : { help: '연결이 끊겼거나 서버에 닿지 못했습니다.' }),
            ...(error instanceof HttpError ? { code: error.message } : {}),
            retry: true,
          }),
        );
      }
    }
  }, []);

  useEffect(() => {
    let timer = 0;
    void (async () => {
      // 화면이 서버에 "나는 누구인가" 를 묻습니다. 이 한 줄이 `?me=1` 을
      // 대체합니다.
      const response = await fetch(`${apiBase}/api/auth/me`, { credentials: 'same-origin' }).catch(
        () => null,
      );
      if (response === null) {
        await refresh();
        return;
      }
      if (!response.ok) {
        goToLogin();
        return;
      }
      setMe((await response.json()) as Me);
      const meeting = (await getJson(`/api/meetings/${meetingId}`).catch(() => null)) as {
        project_id: number;
        title: string | null;
      } | null;
      if (meeting !== null) {
        setProjectId(meeting.project_id);
        setMeetingTitle(meeting.title);
      }
      await refresh();
      timer = setInterval(() => void refresh(), POLL_MS) as unknown as number;
    })();
    return () => clearInterval(timer);
  }, [refresh]);

  /* ⚠️ **탭도 회의 이름을 이고 있어야 합니다** (결함 285 가 적어 둔 피해).
     레거시 화면은 `.html` 의 `<title>` 을 그대로 쓰기 때문에, 이름 없는
     회의 둘을 열면 탭 둘이 「회의 로비 — TeamFlow」로 글자 하나 안 틀리고
     똑같았습니다. 형식은 한 벌(`pageTitle`)에서 옵니다. */
  useEffect(() => {
    document.title = pageTitle(`${meetingLabel(meetingTitle, meetingId)} 로비`);
  }, [meetingTitle, meetingId]);

  const meId = me?.user_id ?? 0;

  // ⭐ 저장된 ②③ 을 화면에 되돌립니다 (결함 94). 서버는 사람마다 답을
  // 실어 보내고 있었는데 읽는 곳이 0곳이라, 거부하고 새로고침하면 체크가
  // 다시 켜져 있었습니다. `null` 은 **아직 답 안 함** — 기본값을 둡니다.
  useEffect(() => {
    if (extrasApplied.current || roster.length === 0 || meId === 0) return;
    const saved = savedExtraConsents(roster, meId);
    if (saved.rawAudio !== null) setKeepAudio(saved.rawAudio);
    if (saved.voiceprint !== null) setKeepVoiceprint(saved.voiceprint);
    extrasApplied.current = true;
  }, [roster, meId]);

  const postConsent = (consentType: string, consented: boolean): Promise<Response | null> =>
    // 서버에 닿지 못하면 `null`. 동의는 **누르면 바뀌는** 요청이라 실패를
    // 화면이 반드시 말해야 합니다 (결함 87).
    trySend(() =>
      fetch(`${apiBase}/api/meetings/${meetingId}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `user_id` 를 보내지 않습니다. **동의는 본인만 합니다** — 서버가
        // 세션에서 읽으므로 남을 대신해 동의해 줄 방법이 없습니다.
        body: JSON.stringify({ consent_type: consentType, consented }),
        credentials: 'same-origin',
      }),
    );

  const submitConsent = (consented: boolean): void => {
    void (async () => {
      setBusy(true);
      setConsentNote(null);
      try {
        const response = await postConsent('recording', consented);
        if (response === null) {
          setConsentNote({ text: unreachableText('동의를 제출하지 못했습니다'), tone: 'bad' });
          return;
        }
        if (isSessionExpired(response.status)) {
          goToLogin();
          return;
        }
        const body = (await response.json()) as { roster: RosterEntry[]; message: string };
        if (!response.ok) {
          setConsentNote({ text: detailText(body, '동의를 제출하지 못했습니다'), tone: 'bad' });
          return;
        }

        // ②③ 을 같이 보냅니다 (docs/07 §2.3).
        //
        // ⚠️ **녹음에 동의했을 때만** 보냅니다. 녹음 자체를 거부한 사람에게
        // "원본은 보관해도 되나요" 를 묻는 건 뜻이 없고, 거부 기록에 딸린
        // 응답이 남으면 나중에 그게 무슨 뜻인지 아무도 모릅니다.
        //
        // ⚠️ 이게 실패해도 녹음 동의는 이미 접수됐습니다. 되돌리지 않고
        // 사람에게 말합니다 — 조용히 넘어가면 화면의 체크박스와 서버의
        // 기록이 어긋난 채로 남습니다.
        if (consented) {
          const extras: [string, boolean][] = [
            ['raw_audio_retention', keepAudio],
            ['voiceprint_storage', keepVoiceprint],
          ];
          for (const [type, value] of extras) {
            const extra = await postConsent(type, value);
            if (extra === null || !extra.ok) {
              setConsentNote({
                text: '녹음 동의는 접수됐지만 아래 두 항목을 저장하지 못했습니다. 다시 눌러 주세요.',
                tone: 'bad',
              });
              return;
            }
          }
        }
        setRoster(body.roster);
        setConsentMessage(body.message);
      } catch (error) {
        // 여기까지 오는 것은 응답을 읽다 깨진 경우뿐입니다 — 보내는 실패는
        // 위에서 `null` 로 끝납니다. 원문은 콘솔에만 남깁니다.
        console.error(error);
        setConsentNote({ text: describeUnexpected(), tone: 'bad' });
      } finally {
        setBusy(false);
      }
    })();
  };

  /**
   * ⚠️ 결과를 **`#room-message` 에 쓰지 않습니다.** 저기는 폴링이 방 상태로
   * 3초마다 덮는 자리라, 실패 문구를 저기 쓰면 조용히 사라집니다 — 재 보니
   * 1.5초에는 있고 3.5초에는 없었습니다 (결함 90).
   */
  const forceFinish = (): void => {
    const ok = window.confirm(
      '참가하지 않은 사람을 기다리지 않고 회의를 끝냅니다.\n' +
        '그 사람의 발언은 기록되지 않습니다. 계속할까요?',
    );
    if (!ok) return;
    void (async () => {
      setBusy(true);
      setRoomNote(null);
      try {
        const response = await trySend(() =>
          fetch(`${apiBase}/api/meetings/${meetingId}/finish`, {
            method: 'POST',
            credentials: 'same-origin',
          }),
        );
        if (response === null) {
          setRoomNote({ text: unreachableText('회의를 끝내지 못했습니다'), tone: 'bad' });
          return;
        }
        if (isSessionExpired(response.status)) {
          goToLogin();
          return;
        }
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        // ⚠️ 예전에는 `body.message ?? ''` 하나였습니다. 500 이 와도
        // `message` 가 없어 빈 문자열이 들어가고, 곧바로 폴링이 원래 문장을
        // 되돌려 놓아 **화면이 누르기 전과 똑같아졌습니다.**
        if (!response.ok) {
          setRoomNote({
            text: detailText(body, `회의를 끝내지 못했습니다 (HTTP ${response.status})`),
            tone: 'bad',
          });
          return;
        }
        // 성공은 실패처럼 안 보이게 — 같은 자리를 쓰되 색은 다르게.
        setRoomNote({ text: body?.message ?? '', tone: 'plain' });
        await refresh();
      } catch (error) {
        console.error(error);
        setRoomNote({ text: describeUnexpected(), tone: 'bad' });
      } finally {
        setBusy(false);
      }
    })();
  };

  /**
   * 실패한 회의를 다시 처리합니다 (결함 114).
   *
   * ⚠️ **되돌릴 수 없는 일이라 먼저 묻습니다.** 다시 처리하면 앞판의
   * 발화·후보·결정이 지워지고 새로 만들어집니다.
   */
  /**
   * 회의록을 만든다 (`POST /api/meetings/{id}/minutes`).
   *
   * ## ⛔ 이 단추가 **없었습니다** (결함 306)
   *
   * 서버 갈래는 처음부터 있었고 검사도 붙어 있었는데 **부르는 곳이
   * 0곳**이었습니다. 그런데 보고서 화면의 빈 상자는 사람에게 이렇게
   * 말하고 있었습니다 —
   *
   *     위의 [최종 보고서 만들기]를 누르거나,
   *     **회의 로비에서 회의록을 만드세요.**
   *
   * 로비에는 그런 단추가 없었습니다. 실패 ③ 그대로입니다: 할 일을 알려
   * 주고 그 일을 할 자리를 안 준 것. (결함 298 과 같은 모양 — 그때는
   * 일정을 **무르는** 자리가 없었습니다.)
   *
   * ⚠️ 회의 상태를 안 가립니다. `reports/minutes.py` 의 `state_of` 가
   * 「아직 처리 전」·「처리 실패」·「처리를 마침」을 문서 안에 적으므로,
   * 녹음 전 회의의 회의록도 **거짓말을 하지 않습니다** (결함 289).
   *
   * ⚠️ 만들고 나면 **볼 자리로 데려갑니다.** 만들어 놓고 어디 있는지
   * 안 알려 주면 이 저장소가 반복해서 낸 실패 ③ 을 또 내는 것입니다.
   */
  const makeMinutes = (): void => {
    void (async () => {
      setBusy(true);
      setMinutesNote(null);
      try {
        const response = await trySend(() =>
          fetch(`${apiBase}/api/meetings/${meetingId}/minutes`, {
            method: 'POST',
            credentials: 'same-origin',
          }),
        );
        if (response === null) {
          setMinutesNote({ text: unreachableText('회의록을 만들지 못했습니다'), tone: 'bad' });
          return;
        }
        if (isSessionExpired(response.status)) {
          goToLogin();
          return;
        }
        if (!response.ok) {
          // 서버가 사람에게 쓴 문장이 일반론보다 언제나 낫습니다 (결함 300).
          const body = (await response.json().catch(() => null)) as unknown;
          setMinutesNote({
            text: detailText(body, `회의록을 만들지 못했습니다 (HTTP ${response.status})`),
            tone: 'bad',
          });
          return;
        }
        if (projectId !== null) {
          location.href = `/reports.html?project=${projectId}`;
          return;
        }
        setMinutesNote({ text: '회의록을 만들었습니다 — 보고서 화면에 있습니다.', tone: 'plain' });
      } finally {
        setBusy(false);
      }
    })();
  };

  const reprocess = (): void => {
    const ok = window.confirm(REPROCESS_CONFIRM);
    if (!ok) return;
    void (async () => {
      setBusy(true);
      setReprocessNote(null);
      try {
        const response = await trySend(() =>
          fetch(`${apiBase}/api/meetings/${meetingId}/reprocess`, {
            method: 'POST',
            credentials: 'same-origin',
          }),
        );
        if (response === null) {
          setReprocessNote({ text: unreachableText('다시 처리하지 못했습니다'), tone: 'bad' });
          return;
        }
        if (isSessionExpired(response.status)) {
          goToLogin();
          return;
        }
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        if (!response.ok) {
          // 409 는 서버 문장이 그대로 사람에게 쓸 만합니다 —
          // "이미 검토한 업무 후보가 1건 있습니다…"
          setReprocessNote({
            text: detailText(body, `다시 처리하지 못했습니다 (HTTP ${response.status})`),
            tone: 'bad',
          });
          return;
        }
        setReprocessNote({ text: body?.message ?? '', tone: 'plain' });
        await refresh();
      } catch (error) {
        console.error(error);
        setReprocessNote({ text: describeUnexpected(), tone: 'bad' });
      } finally {
        setBusy(false);
      }
    })();
  };

  const statuses = memberStatuses(roster, tracks);
  const room = roomStatus(statuses);
  const blockers = startBlockers(roster);

  // ⭐ 운행도표 — 사람마다 한 줄, 구멍이 **제자리에** 찍힙니다. 축은
  // `buildDiagram` 이 정합니다. 트랙마다 녹음 시작 시각이 다르므로
  // 오프셋을 맞추지 않으면 늦게 들어온 사람의 구멍이 회의 앞쪽으로
  // 밀려오고, 그러면 "그 결정이 나올 때 이 사람이 끊겨 있었다" 가
  // 통째로 거짓이 됩니다.
  const diagram = buildDiagram(
    (tracks ?? []).map((t) => ({
      userId: t.user_id,
      startedAt: t.started_at ?? null,
      endedAt: t.ended_at ?? null,
      gaps: t.gaps ?? [],
    })),
  );
  const ticks = axisTicks(diagram.durationMs);

  const startable = canStart(roster);
  // 처리가 끝나야 후보가 생깁니다. 그 전에 눌러도 빈 화면이라 감춥니다.
  const reviewReady = !(room.recording > 0 || room.notJoined > 0 || (tracks?.length ?? 0) === 0);
  // ⚠️ **한 화면에 주 버튼은 하나** (지시서 §8). 내가 아직 동의를 안 했으면
  // "동의합니다" 가 주 동작이고, 하고 나면 주 동작이 넘어갑니다.
  const iAgreed = roster.some((e) => e.user_id === meId && consentStateOf(e) === 'granted');

  return (
    <>
      <header className="head">
        <h1 id="title">회의 로비</h1>
        <p className="lede">
          녹음은 <strong>전원이 동의해야</strong> 시작됩니다. 회의 중에 누구의 트랙이 끊겼는지도
          여기서 봅니다.
        </p>
        {me !== null && <Byline name={me.name} avatar={me.avatar} />}
      </header>

      <p className="meta-line" id="sub">
        {sub !== null && sub.tone === 'bad' ? (
          <span className="bad">{sub.text}</span>
        ) : (
          `${meetingLabel(meetingTitle, meetingId)} · 팀원 ${roster.length}명`
        )}
      </p>

      <section className="panel">
        <h2>동의</h2>
        {/* ⚠️ 실패 상자는 목록 **바로 위**에 둡니다. 부제 한 줄만 바꾸면
            참가자 목록은 텅 빈 채로 남고, 사람은 아무도 안 들어온 줄 압니다. */}
        {loadFailure !== null ? (
          <div id="blockers" className="blockers">
            <RawHtml
              html={loadFailure}
              onRetry={() => {
                setLoadFailure(null);
                void refresh();
              }}
            />
          </div>
        ) : (
          blockers.length > 0 && (
            <div id="blockers" className="blockers">
              {blockers.map((b, i) => (
                <p key={i}>{b}</p>
              ))}
            </div>
          )
        )}

        {/* ⚠️ `#roster` 는 `<ul>` 입니다. `<div>` 를 넣으면 낭독기가 세는
            항목 수가 틀어집니다 — 그래서 `<li>` 판 스켈레톤을 씁니다. */}
        <ul id="roster" {...(slow ? { 'aria-busy': 'true' as const } : {})}>
          {slow ? (
            <RawHtml html={rowItems(3)} />
          ) : (
            roster.map((entry) => {
              const state = consentStateOf(entry);
              return (
                <li key={entry.user_id}>
                  <span className="name">
                    {entry.name}
                    {entry.user_id === meId ? ' (나)' : ''}
                  </span>
                  <span className={`state ${state}`}>{describeConsent(state)}</span>
                </li>
              );
            })
          )}
        </ul>

        <fieldset className="extras">
          <legend>
            <span className="cap">따로 받는 동의</span>
          </legend>
          <label>
            <input
              type="checkbox"
              id="keep-audio"
              checked={keepAudio}
              onChange={(e) => setKeepAudio(e.target.checked)}
            />
            <span>
              원본 음성 파일 보관
              <span className="hint">거부하면 회의록을 만든 뒤 바로 지웁니다</span>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              id="keep-voiceprint"
              checked={keepVoiceprint}
              onChange={(e) => setKeepVoiceprint(e.target.checked)}
            />
            <span>
              목소리 특징 저장
              <span className="hint">거부해도 됩니다 — 트랙별 녹음이라 화자는 이미 확정입니다</span>
            </span>
          </label>
        </fieldset>

        <div className="row" style={{ marginTop: '.75rem' }}>
          <button
            id="agree"
            className={iAgreed ? '' : 'primary'}
            disabled={busy}
            onClick={() => submitConsent(true)}
          >
            동의합니다
          </button>
          <button id="refuse" disabled={busy} onClick={() => submitConsent(false)}>
            거부
          </button>
        </div>
        <p className="status" id="consent-message">
          {consentMessage}
        </p>
        <NoteLine note={consentNote} id="consent-note" />
      </section>

      <section className="panel">
        <h2>참가자 상태</h2>
        {ticks.length > 0 && (
          <p id="axis" className="axis">
            <span />
            <span className="marks">
              {ticks.map((t, i) => (
                <span key={i}>{t}</span>
              ))}
            </span>
          </p>
        )}
        <ul id="members">
          {statuses.map((s) => {
            // 축을 못 정했으면 트랙을 안 그립니다. **거짓 위치는 안 그리는
            // 것보다 나쁩니다.**
            const spans = diagram.durationMs > 0 ? (diagram.gaps.get(s.userId) ?? []) : null;
            // ⭐ 기기가 남긴 경고. **서버가 이미 보내고 있었는데 읽는 곳이
            // 0곳이었습니다** (결함 93). 커버리지가 100% 여도 마이크 설정이
            // 잘못됐으면 그 사람의 자막은 다르게 읽어야 합니다.
            const alerts = captureAlerts(tracks?.find((t) => t.user_id === s.userId));
            return (
              <li key={s.userId} className={s.verdict}>
                <span className="name">{s.name}</span>
                <span className="state">{s.message}</span>
                {spans !== null && (
                  <span className="tl">
                    {spans.map((g, i) => (
                      <i
                        key={i}
                        style={{ left: `${g.left}%`, width: `${g.width}%` }}
                        title={describeGap(g, diagram.durationMs)}
                      />
                    ))}
                  </span>
                )}
                {alerts.length > 0 && (
                  <ul className="warn">
                    {alerts.map((message, i) => (
                      <li key={i}>{message}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        <p className="status" id="room-message">
          {room.message}
        </p>
        <p className="status" id="progress">
          {progressLine}
        </p>
      </section>

      <section className="panel">
        {/* ⭐ **주 행동은 회의 상태를 따라 움직입니다** (브리프 §14).
            녹음이 이미 끝난 회의에서 `녹음 화면으로` 가 청록으로 남아
            있으면, 화면이 가장 크게 가리키는 곳이 **이제 할 일이 아닌
            곳**입니다. 청록은 한 번에 하나만 켭니다. */}
        <div className="act-main">
          <button
            id="record"
            className={reviewReady ? '' : 'primary'}
            disabled={!startable}
            onClick={() => (location.href = `/index.html?meeting=${meetingId}`)}
          >
            {startable ? '녹음 화면으로' : '전원 동의 후 시작할 수 있습니다'}
          </button>
          {/* 통화도 같은 게이트를 지납니다. 통화는 곧 녹음이고, 녹음은
              전원의 동의가 있어야 시작할 수 있습니다 (docs/07 L1). */}
          <button
            id="call"
            disabled={!startable}
            onClick={() => (location.href = `/call.html?meeting=${meetingId}`)}
          >
            {startable ? '통화로 회의하기' : '통화도 전원 동의 후에'}
          </button>
          {canReprocess && (
            <button id="reprocess" disabled={busy} onClick={reprocess}>
              다시 처리하기
            </button>
          )}
          {reviewReady && (
            <button
              id="review"
              className="primary"
              onClick={() => (location.href = `/review.html?meeting=${meetingId}`)}
            >
              업무 후보 검토
            </button>
          )}
        </div>
        <NoteLine note={roomNote} id="room-note" />
        <NoteLine note={reprocessNote} id="reprocess-note" />

        <div className="act-quiet">
          <button
            id="kanban"
            className="linkish"
            onClick={() =>
              (location.href = `/kanban.html?project=${projectId}&meeting=${meetingId}`)
            }
          >
            칸반 보기
          </button>
          <button
            id="contrib"
            className="linkish"
            // 기여도는 프로젝트 단위지만 이름을 붙이려면 회의 단위 명단이 필요합니다.
            onClick={() =>
              (location.href = `/contributions.html?project=${projectId}&meeting=${meetingId}`)
            }
          >
            기여도 보기
          </button>
          {/* ⛔ 이 단추가 없어서 `POST /api/meetings/{id}/minutes` 를 부르는
              곳이 0곳이었습니다 — 그런데 보고서 화면은 「회의 로비에서
              회의록을 만드세요」라고 적고 있었습니다 (결함 306). */}
          <button id="minutes" className="linkish" disabled={busy} onClick={makeMinutes}>
            회의록 만들기
          </button>
          {room.needsForceFinish && (
            <button id="finish" className="linkish danger" disabled={busy} onClick={forceFinish}>
              강제 종료
            </button>
          )}
        </div>
        <NoteLine note={minutesNote} id="minutes-note" />
      </section>
    </>
  );
}

const host = document.getElementById('app');
if (host === null) throw new Error('요소 없음: app');
createRoot(host).render(<Lobby />);

// ⚠️ 로그아웃은 **React 밖의 DOM** 입니다. 화면 여덟이 함께 쓰는 모듈이라
// React 용으로 다시 쓰지 않았습니다 (홈과 같은 이유).
const logout = document.getElementById('logout');
const logoutNote = document.getElementById('logout-note');
if (logout === null || logoutNote === null) throw new Error('요소 없음: logout');
wireLogout({ button: logout as HTMLButtonElement, note: logoutNote, apiBase });

renderNav('lobby');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
