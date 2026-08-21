/**
 * 첫 화면 — 로그인하면 여기로 옵니다. **React 로 옮긴 세 번째 화면.**
 *
 * ⚠️ 판단은 전부 `lib/home/next.ts`·`lib/project/setup.ts` 에 있습니다.
 * 화면 코드에는 자동 테스트가 없으므로, 판단이 이리로 새는 만큼이
 * 검증 밖으로 나갑니다.
 *
 * ## ⚠️ 화면 전부를 React 가 그리지는 않습니다
 *
 * `#app` 이 맡는 것은 **상태가 있는 것**뿐입니다 — 머리말의 검토자
 * 꼬리표 · 프로젝트 목록 · 시작하기 폼.
 *
 * 설치 안내(`#install-card`)와 로그아웃(`#logout`)은 HTML 에 그대로
 * 둡니다. 그 둘은 `pwa.ts`·`logout.ts` 가 **DOM 을 직접 만져서** 채우고,
 * 그 두 모듈은 화면 여덟이 함께 씁니다. React 용으로 다시 쓰면 같은
 * 판단이 두 벌이 되고, 두 벌이 되면 한쪽만 고쳐집니다 — 이 저장소가
 * 반복해 당한 그것입니다. 옮기지 않은 화면이 아직 다섯입니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  describeMeetingStatus,
  describeProject,
  emptyProjectsMessage,
  describeMeetingWhen,
  nextStepFor,
  orderProjects,
  type Meeting,
  type Project,
} from '../lib/home/next.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import {
  CODE_LENGTH,
  codeProblem,
  formatCode,
  normalizeCode,
  titleProblem,
} from '../lib/project/setup.ts';
import { channelState } from '../lib/nav/channels.ts';
import { detailText } from '../lib/http/detail.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import {
  AVATAR_SIDE,
  bioProblem,
  coverCrop,
  MAX_BIO,
  PHOTO_NOTE,
  photoProblem,
} from '../lib/profile/edit.ts';
import { avatarInitial } from '../lib/ui/byline.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { projectCards } from '../lib/ui/skeleton.ts';
import { Byline, NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { wireLogout } from './logout.ts';
import { bootApp } from './pwa.ts';
import { meetingLabel } from '../lib/ui/naming.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);

// ⚠️ **읽기도 `tryGet` 을 거칩니다** (결함 102) — 맨 `fetch` 는 닿지
// 못하면 던지고, 프로젝트 목록이 텅 빈 채로 남았습니다.
const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

interface WithMeetings {
  project: Project;
  meetings: Meeting[];
}

type Screen =
  | { k: 'loading' }
  | { k: 'unreachable' }
  | { k: 'failed'; status: number }
  | { k: 'ok'; rows: WithMeetings[] };

// ══════════════════════════════════════════════════════════════
// 조각들
// ══════════════════════════════════════════════════════════════

function MeetingRow({ meeting }: { meeting: Meeting }) {
  const step = nextStepFor(meeting);
  return (
    <li className={step.actionable ? 'meeting todo' : 'meeting'}>
      <div className="head">
        <span className="dot" data-state={channelState(meeting.status)} />
        <span className="name">{meetingLabel(meeting.title, meeting.meeting_id)}</span>
        <span className="when">{describeMeetingWhen(meeting)}</span>
        {/* ⚠️ **화면 폭짜리 버튼을 다섯 개 쌓지 않습니다** (docs/19 §20).
            예전에는 회의마다 900px 짜리 초록 덩어리가 깔려서, 화면이
            "무엇을 할 차례인가" 가 아니라 **버튼 밭**이었습니다. 줄
            자체가 이미 어느 회의인지 말하고 있습니다. */}
        {step.href !== null && (
          <a className={step.actionable ? 'btn btn-sm btn-primary' : 'btn btn-sm'} href={step.href}>
            {step.label}
          </a>
        )}
      </div>
      <p className="status">
        {describeMeetingStatus(meeting.status)} — {step.reason}
      </p>
    </li>
  );
}

function ProjectSection({ row }: { row: WithMeetings }) {
  const id = row.project.project_id;
  return (
    <section className="project">
      <h2>{row.project.title}</h2>
      <p className="sub">{describeProject(row.project)}</p>
      {/* ⚠️ **`btn` 을 뗐습니다** (브리프 §17). 같은 세 곳이 왼쪽 열에도,
          폰의 아래 탭바에도 있습니다 — 내비가 **세 벌**이었고 그중 이
          셋만 크고 네모나서 화면에서 가장 먼저 읽혔습니다.

          ⚠️ 지우지는 않습니다. 이 링크에는 **프로젝트가 실려** 있어
          왼쪽 열의 것과 뜻이 조금 다르고, 회의를 여는 곳·초대 코드를
          보는 곳이 `설정` 뿐이라 없어지면 다음 단계로 갈 방법이 없습니다. */}
      <div className="links">
        <a href={`/kanban.html?project=${id}`}>칸반</a>
        <a href={`/contributions.html?project=${id}`}>기여도</a>
        <a href={`/project.html?project=${id}`}>설정</a>
      </div>
      {row.meetings.length === 0 ? (
        <p className="empty">회의를 열면 여기에 나옵니다.</p>
      ) : (
        <ul className="meetings">
          {row.meetings.map((m) => (
            <MeetingRow key={m.meeting_id} meeting={m} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

function Home() {
  const [screen, setScreen] = useState<Screen>({ k: 'loading' });
  const [me, setMe] = useState<Me | null>(null);
  const [slow, setSlow] = useState(false);
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState('');
  // 누르는 동안 잠근다 (결함 89). 이 요청은 **멱등이 아니라** 누른 만큼
  // 프로젝트가 생깁니다.
  const [busy, setBusy] = useState(false);
  // 내 정보 (`USER-004`).
  const [bio, setBio] = useState('');
  const [profileNote, setProfileNote] = useState<Note | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const response = await whileLoading(
      get('/api/projects'),
      () => setSlow(true),
      () => setSlow(false),
    );
    // 닿지 못한 것과 세션이 끊긴 것은 다릅니다 (결함 102).
    if (response === null) {
      setScreen({ k: 'unreachable' });
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setScreen({ k: 'failed', status: response.status });
      return;
    }
    const projects = orderProjects((await response.json()) as Project[]);
    // 프로젝트마다 회의를 받아 옵니다. 한 사람이 속한 프로젝트는 많아야
    // 몇 개라 병렬 요청으로 충분합니다 — 합쳐 주는 엔드포인트를 만들면
    // 그쪽이 또 화면 모양을 알아야 합니다.
    const meetings = await Promise.all(
      projects.map((p) =>
        get(`/api/projects/${p.project_id}/meetings`).then((r) =>
          r?.ok ? (r.json() as Promise<Meeting[]>) : [],
        ),
      ),
    );
    setScreen({
      k: 'ok',
      rows: projects.map((project, i) => ({ project, meetings: meetings[i] ?? [] })),
    });
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await get('/api/auth/me');
      // 닿지 못한 것을 만료로 읽으면 이유도 모른 채 로그아웃당합니다.
      if (response !== null) {
        if (!response.ok) {
          goToLogin();
          return;
        }
        const who = (await response.json()) as Me;
        setMe(who);
        setBio(who.bio ?? '');
      }
      await load();
    })();
  }, [load]);

  /** 만들기·참가가 같은 모양이라 한 곳에 둡니다. */
  const send = async (path: string, body: unknown, whatFailed: string): Promise<void> => {
    setBusy(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        }),
      );
      if (response === null) {
        setProblem(unreachableText(whatFailed));
        return;
      }
      if (!response.ok) {
        if (isSessionExpired(response.status)) {
          goToLogin();
          return;
        }
        const detail = (await response.json().catch(() => null)) as unknown;
        setProblem(detailText(detail, `${whatFailed} (HTTP ${response.status})`));
        return;
      }
      // 만든 직후에는 혼자입니다. 목록으로 돌려보내면 초대 코드를 한 번
      // 더 찾아가야 하므로, 코드가 있는 화면으로 바로 보냅니다.
      // 이미 구성원이어도 성공이고, 그때는 그냥 그 프로젝트로 갑니다.
      const created = (await response.json()) as { project_id: number };
      location.href = `/project.html?project=${created.project_id}`;
    } finally {
      setBusy(false);
    }
  };

  /** 내 정보 저장 (`USER-004`). `""` 는 지움 — 서버와 같은 약속입니다. */
  const patchProfile = async (
    body: { bio?: string; avatar?: string },
    whatFailed: string,
  ): Promise<void> => {
    setSaving(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}/api/auth/me/profile`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        }),
      );
      if (response === null) {
        setProfileNote({ text: unreachableText(whatFailed), tone: 'bad' });
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as unknown;
        setProfileNote({
          text: detailText(detail, `${whatFailed} (HTTP ${response.status})`),
          tone: 'bad',
        });
        return;
      }
      const next = (await response.json()) as Me;
      setMe(next);
      setBio(next.bio ?? '');
      setProfileNote({ text: '저장했습니다', tone: 'plain' });
    } finally {
      setSaving(false);
    }
  };

  /**
   * 고른 사진을 캔버스에 다시 그려 96×96 PNG 로 보냅니다.
   *
   * ⚠️ 원본 파일은 서버로 가지 않습니다 — 재부호화에서 EXIF(찍은 위치)가
   * 떨어져 나갑니다. 판단(형식·상한·가운데 자르기)은 `lib/profile/edit.ts`,
   * 여기는 그리기만.
   */
  const pickPhoto = async (file: File): Promise<void> => {
    const problem = photoProblem(file);
    if (problem !== null) {
      setProfileNote({ text: problem, tone: 'bad' });
      return;
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      setProfileNote({ text: '이미지를 읽을 수 없습니다', tone: 'bad' });
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIDE;
    canvas.height = AVATAR_SIDE;
    const context = canvas.getContext('2d');
    if (context === null) {
      bitmap.close();
      setProfileNote({ text: '이 브라우저에서는 사진을 줄일 수 없습니다', tone: 'bad' });
      return;
    }
    const { sx, sy, size } = coverCrop(bitmap.width, bitmap.height);
    context.drawImage(bitmap, sx, sy, size, size, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
    bitmap.close();
    await patchProfile({ avatar: canvas.toDataURL('image/png') }, '사진을 저장하지 못했습니다');
  };

  const saveBio = (): void => {
    const bad = bioProblem(bio);
    if (bad !== null) {
      setProfileNote({ text: bad, tone: 'bad' });
      return;
    }
    void patchProfile({ bio }, '소개를 저장하지 못했습니다');
  };

  const create = (): void => {
    const bad = titleProblem(title);
    if (bad) {
      setProblem(bad);
      return;
    }
    setProblem('');
    void send('/api/projects', { title: title.trim() }, '만들지 못했습니다');
  };

  const join = (): void => {
    const bad = codeProblem(code);
    if (bad) {
      setProblem(bad);
      return;
    }
    setProblem('');
    void send('/api/projects/join', { invite_code: normalizeCode(code) }, '참가하지 못했습니다');
  };

  // ⚠️ **한 화면에 주 버튼은 하나** (지시서 §8). 프로젝트가 이미 있으면
  // 각 회의 줄의 "다음 할 일" 이 주 동작입니다 — 사람이 홈에 오는 이유가
  // 그것입니다. 그때 "만들기" 까지 청록으로 칠하면 **무엇부터 눌러야
  // 하는지가 사라집니다.** 하나도 없으면 만들기가 유일한 길입니다.
  const noProjects = screen.k === 'ok' && screen.rows.length === 0;

  return (
    <>
      <header className="head">
        <h1>TeamFlow</h1>
        <p className="lede">
          회의는 녹음 → 처리 → 사람이 검토 → 칸반 순서로 갑니다. 각 회의 아래 문구가 지금 어느
          단계인지와 다음에 할 일을 말합니다.
        </p>
        {me !== null && <Byline name={me.name} avatar={me.avatar} />}
      </header>

      <div id="projects" {...(screen.k === 'loading' && slow ? { 'aria-busy': 'true' } : {})}>
        {screen.k === 'loading' ? (
          // 200ms 전에는 **아무것도 안 그립니다.**
          slow && <RawHtml html={projectCards()} />
        ) : screen.k === 'ok' ? (
          screen.rows.length === 0 ? (
            <p className="empty">{emptyProjectsMessage()}</p>
          ) : (
            screen.rows.map((row) => <ProjectSection key={row.project.project_id} row={row} />)
          )
        ) : (
          // 텅 빈 목록은 "프로젝트가 없다" 로 읽힙니다 — 실패와 0건이
          // 같은 모양이 되면 안 됩니다 (결함 102).
          <RawHtml
            html={
              screen.k === 'unreachable'
                ? failureHtml({
                    what: unreachableText('프로젝트를 불러오지 못했습니다.'),
                    retry: true,
                  })
                : failureHtml({
                    what: '프로젝트 목록을 불러오지 못했습니다.',
                    ...(describeHttpStatus(screen.status) !== null
                      ? { help: describeHttpStatus(screen.status) as string }
                      : {}),
                    code: `HTTP ${screen.status}`,
                    retry: true,
                  })
            }
            onRetry={() => {
              setScreen({ k: 'loading' });
              void load();
            }}
          />
        )}
      </div>

      {/* ⭐ 이게 없던 동안 **가입한 첫 사용자는 할 수 있는 일이
          없었습니다.** 첫 화면이 "팀원이 넣어 주기를 기다리세요" 로
          끝났는데, 그 팀원도 같은 화면을 보고 있었습니다. */}
      <section className="start">
        <h2>시작하기</h2>
        <div className="field">
          <p className="hint">만들면 초대 코드가 나옵니다. 그 코드를 팀원에게 알려 주세요.</p>
          <div className="row">
            <input
              id="new-title"
              type="text"
              placeholder="새 프로젝트 이름"
              maxLength={200}
              autoComplete="off"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button
              id="create"
              type="button"
              className={noProjects ? 'primary' : ''}
              disabled={busy}
              onClick={create}
            >
              만들기
            </button>
          </div>
        </div>

        <div className="field">
          <p className="hint">팀원에게 코드를 받았다면 여기에 넣으세요.</p>
          <div className="row">
            <input
              id="code"
              type="text"
              placeholder="초대 코드 (ABCD-EFGH)"
              maxLength={12}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              // 화면이 하이픈을 보여주므로 사람은 하이픈을 칩니다.
              // 치는 대로 끊어 줍니다.
              onBlur={() => {
                const clean = normalizeCode(code);
                if (clean.length === CODE_LENGTH) setCode(formatCode(clean));
              }}
            />
            <button id="join" type="button" disabled={busy} onClick={join}>
              참가
            </button>
          </div>
        </div>

        {problem !== '' && (
          <p id="start-error" className="error">
            {problem}
          </p>
        )}
      </section>

      {/* ⭐ 내 정보 (`USER-004`).
          ⚠️ 적은 것이 어디에 보이는지를 화면이 말합니다 — 말 안 하면
          "이건 누가 보나" 를 모른 채 적거나, 몰래 보인다고 느낍니다. */}
      {me !== null && (
        <section className="me-card">
          <h2>내 정보</h2>
          <p className="hint">여기 적는 것은 각 프로젝트 설정 화면의 팀원 목록에 보입니다.</p>
          <div className="me-photo">
            {typeof me.avatar === 'string' && me.avatar !== '' ? (
              <img className="me-face" src={me.avatar} alt="내 프로필 이미지" />
            ) : (
              <span className="me-face me-face-empty" aria-hidden="true">
                {avatarInitial(me.name)}
              </span>
            )}
            {/* label 이 input 을 감싸서 눌립니다 — file input 의 기본 모양은
                브라우저마다 다르고 44px 를 못 지킵니다. `.btn` 을 그대로
                입어서 버튼 규칙(경계·터치 타깃)이 두 벌이 안 됩니다. */}
            <label className="btn file-btn" {...(saving ? { 'aria-disabled': 'true' } : {})}>
              사진 고르기
              <input
                type="file"
                accept="image/*"
                disabled={saving}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // 같은 파일을 다시 골라도 change 가 나게 비웁니다.
                  e.target.value = '';
                  if (file !== undefined) void pickPhoto(file);
                }}
              />
            </label>
            {typeof me.avatar === 'string' && me.avatar !== '' && (
              <button
                id="drop-photo"
                type="button"
                disabled={saving}
                onClick={() => void patchProfile({ avatar: '' }, '사진을 지우지 못했습니다')}
              >
                사진 지우기
              </button>
            )}
          </div>
          <p className="hint">{PHOTO_NOTE}</p>
          <div className="field">
            <textarea
              id="bio"
              rows={2}
              maxLength={MAX_BIO}
              placeholder="자기소개 — 팀원에게 하는 한두 마디"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
            <div className="row">
              <button id="save-bio" type="button" disabled={saving} onClick={saveBio}>
                소개 저장
              </button>
            </div>
          </div>
          <NoteLine note={profileNote} />
        </section>
      )}
    </>
  );
}

const host = document.getElementById('app');
if (host === null) throw new Error('요소 없음: app');
createRoot(host).render(<Home />);

// ⚠️ 아래 둘은 **React 밖의 DOM** 을 만집니다. 화면 여덟이 함께 쓰는
// 모듈이라 React 용으로 다시 쓰지 않았습니다 — 두 벌이 되면 한쪽만
// 고쳐집니다. 그래서 그 요소들은 `home.html` 에 그대로 있습니다.
const logout = document.getElementById('logout');
const logoutNote = document.getElementById('logout-note');
if (logout === null || logoutNote === null) throw new Error('요소 없음: logout');
wireLogout({ button: logout as HTMLButtonElement, note: logoutNote, apiBase });

// 홈은 프로젝트를 아직 안 고른 상태라 칸반·기여도·설정 탭이 흐리게 나옵니다.
// 그래도 **그려야** 합니다 — 안 그리면 `<nav id="tabs">` 가 빈 채로 남고,
// PC 에서는 그게 아무것도 없는 줄로 화면 위에 그어집니다.
renderNav('home');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
