/**
 * 프로젝트 설정 — 초대 코드·GitHub 연결·역할·회의 열기·내 녹음 지우기.
 * **React 로 옮긴 여섯 번째 화면** (docs/19 §24).
 *
 * ⚠️ 판단은 전부 `lib/project/setup.ts`·`lib/github/health.ts`·
 * `lib/contribution/roles.ts`·`lib/privacy/deletion.ts` 에 있고 테스트가
 * 붙어 있습니다. 여기는 그리기만 합니다.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  codeToCopy,
  formatCode,
  githubLoginStatus,
  nextStepAfterCreate,
  NO_CODE,
  normalizeRepo,
  repoProblem,
  titleProblem,
} from '../lib/project/setup.ts';
import {
  cannotTellApartNote,
  labelInList,
  tellsApartInList,
} from '../lib/people/labels.ts';
import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { copySucceeded, copyText, describeCopy } from '../lib/ui/copy.ts';
import {
  describeHealth,
  describeHealthFailure,
  type GithubHealth,
  type HealthView,
} from '../lib/github/health.ts';
import {
  describeRoles,
  problemWith,
  ROLE_OPTIONS,
  sumOf,
  toPayload as rolesToPayload,
} from '../lib/contribution/roles.ts';
import { detailText } from '../lib/http/detail.ts';
import { trySend, unreachableText } from '../lib/http/send.ts';
import {
  confirmPrompt,
  describeOutcome,
  describeRequestFailure,
  whatGetsDeleted,
  whatHappensToMyScore,
  whatRemains,
  type RevokeResult,
} from '../lib/privacy/deletion.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as skeletonRows } from '../lib/ui/skeleton.ts';
import { NoteLine, type Note } from './parts.tsx';
import {
  LOAD_NOTE,
  NOTHING_FOUND,
  overdueText,
  progressText,
  PROGRESS_NOTE,
  RULES_NOTE,
  signalViews,
  srcView,
  taskHref,
  type Analytics,
} from '../lib/analytics/view.ts';
import {
  allQuiet,
  notMeasurableText,
  QUIET_TEXT,
  TRENDS_NOTE,
  trendLine,
} from '../lib/analytics/trends.ts';
import { presenceDot, presenceLabel, worthShowing } from '../lib/project/presence.ts';
import {
  roleChoicesFor,
  manageBlockedBecause,
  canRemove,
  LEAVE_CONFIRM,
  leaveBlockedBecause,
  roleLabel,
} from '../lib/project/roles.ts';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';
import { plainText } from '../lib/ui/plain.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '0');

interface Detail {
  project_id: number;
  title: string;
  github_repo: string | null;
  github_connected: boolean;
  invite_code: string;
  member_count: number;
}

// `Note`·`NoteLine` 은 `parts.tsx` 에 있습니다 — 로비와 **두 벌**이었습니다.

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

/**
 * `Content-Type` 을 붙이되 **겹치지 않게.**
 *
 * ⚠️ 자바스크립트 객체 키는 대소문자를 구분하고 **HTTP 헤더는 안 합니다.**
 * 호출부가 `content-type`(소문자)을 주면 두 키가 둘 다 살아남아
 * `Content-Type: application/json, application/json` 이 나가고, FastAPI 는
 * 그걸 JSON 으로 안 보고 422 를 줍니다 — 화면에는 그냥 "실패" 로만 보입니다.
 */
function withJsonType(given: HeadersInit | undefined): Headers {
  const headers = new Headers(given);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return headers;
}

// ⚠️ **닿지 못하면 `null`** (결함 102). 맨 `fetch` 는 읽기가 끊기면 던지고,
// 그 뒤가 `void load…()` 면 거부가 아무 데도 안 걸려 화면이 조용히 빕니다.
async function call(path: string, init?: RequestInit): Promise<Response | null> {
  const response = await trySend(() =>
    fetch(`${apiBase}${path}`, {
      ...init,
      headers: withJsonType(init?.headers),
      credentials: 'same-origin',
      cache: 'no-store',
    }),
  );
  if (response !== null && isSessionExpired(response.status)) goToLogin();
  return response;
}

/** 이름을 남깁니다 — 부르는 쪽이 "바꾸는 요청" 임을 읽습니다. */
const send = (path: string, init?: RequestInit): Promise<Response | null> => call(path, init);

/** 문구 속 `` `백틱` `` 만 `<code>` 로. 문구 자체는 서버·lib 이 정합니다. */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/g).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))}
    </>
  );
}

/** 마크다운 강조만 굵게. */
function Emphasized({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/\*\*([^*]+)\*\*/g)
        .map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : part))}
    </>
  );
}

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

/**
 * 프로젝트가 지금 어떤 상태인가 (정의서 §18 · 제안서 §4.5).
 *
 * > **제출 직전이 아니라 진행 중에 문제를 발견한다.**
 *
 * ## ⚠️ 이 구역은 사람을 평가하지 않습니다
 *
 * 부하 목록이 사람별 숫자를 냅니다. 그래서 리더보드로 오해되기 제일 쉬운
 * 자리이고, 셋으로 막습니다.
 *
 * 1. **이름 순** — 서버가 그렇게 내려보내고 화면은 다시 정렬하지 않습니다
 * 2. **막대 없음** — 값을 같은 축에 늘어놓으면 그게 곧 순위표입니다
 * 3. **"기여도가 아닙니다" 를 화면이 말합니다** — 안 적으면 성적으로 읽힙니다
 */
function ProjectHealth({ data }: { data: Analytics | null }) {
  if (data === null) return null;

  const views = signalViews(data.signals);
  const late = overdueText(data.progress);

  return (
    // ⚠️ `pstate` 는 스타일용이 아니라 **셀 자리**입니다. 이 이름이 없을
    //    때 검사 스크립트가 `.health`(=GitHub 연결 진단)를 대신 집어서,
    //    남의 칸을 재 놓고 "막대 없음·빨강 없음" 이라고 적을 뻔했습니다.
    //    ⚠️ `health` 로 짓지 마십시오 — 그 이름은 이미 임자가 있습니다.
    <section className="panel pstate">
      <h2>프로젝트 상태</h2>
      <p className="sub">{RULES_NOTE}</p>

      <p className="prog">{progressText(data.progress)}</p>
      {/* ⚠️ 검토 중인 것이 왜 안 들어가는지 안 적으면 "버그" 로 읽힙니다. */}
      <p className="sub">{PROGRESS_NOTE}</p>
      {late !== null && <p className="prog-late">{late}</p>}

      <h3 className="sub-head">지금 맡고 있는 일</h3>
      {/* ⚠️ 이 한 줄이 빠지면 사람은 이 숫자를 성적으로 읽습니다. */}
      <p className="sub">{plainText(LOAD_NOTE)}</p>
      <ul className="loads">
        {data.load.map((row) => (
          <li key={row.user_id ?? 'none'} className={row.user_id === null ? 'lnone' : undefined}>
            <span className="lname">{row.name}</span>
            <span className="lnum tabular-nums">{row.open_tasks}</span>
          </li>
        ))}
      </ul>

      <h3 className="sub-head">눈에 띈 것</h3>
      {views.length === 0 ? (
        <p className="sub">{NOTHING_FOUND}</p>
      ) : (
        <ul className="rlist">
          {views.map((view) => {
            const src = srcView(view.taskIds);
            return (
            <li key={view.kind}>
              <p className="rname">{view.title}</p>
              {view.reason !== null && <p className="rwhy">{view.reason}</p>}
              {/* ⚠️ **누를 수 있어야 합니다.** 맨 위에서 "근거를 눌러 직접
                  보세요" 라고 해 놓고 글자만 있던 적이 있습니다.
                  ⚠️ 그리고 **손가락으로** 누를 수 있어야 합니다 — 링크로
                  바꾼 첫 판은 폰에서 13px 짜리였습니다. */}
              {view.taskIds.length > 0 && (
                <div className="rsrc">
                  <span className="rsrc-label">근거 업무</span>
                  {src.shown.map((id) => (
                    <a key={id} href={taskHref(projectId, id)}>
                      #{id}
                    </a>
                  ))}
                  {/* ⚠️ 자른 것을 **말합니다.** 조용히 자르면 화면이
                      "이게 전부" 로 읽힙니다. */}
                  {src.more > 0 && <span className="rsrc-label">외 {src.more}건</span>}
                </div>
              )}
            </li>
            );
          })}
        </ul>
      )}

      {/* ⭐ 회의 개선 추세 (`REVIEW-006`).
          ⚠️ 막대·점 없음 — 값은 글자로 (불변식 1). 회의별 값은 서버가
          아예 안 줍니다 — 회의를 짚는 순간 회의 순위표가 됩니다. */}
      <h3 className="sub-head">회의에서 눈에 띈 것의 추세</h3>
      <p className="sub">{TRENDS_NOTE}</p>
      {!data.meeting_trends.measurable ? (
        // ⚠️ 흙빛 — 회의가 아직 적은 것은 잘못이 아니라 사실입니다.
        <p className="tnote">{notMeasurableText(data.meeting_trends)}</p>
      ) : allQuiet(data.meeting_trends.kinds) ? (
        <p className="sub">{QUIET_TEXT}</p>
      ) : (
        <ul className="trends">
          {data.meeting_trends.kinds.map((kind) => (
            <li key={kind.kind}>{trendLine(kind)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface TeamMember {
  user_id: number;
  name?: string;
  role_shares?: Record<string, number>;
  github_login?: string | null;
  project_role?: string;
  presence?: string;
  /** 자기소개 (`USER-004`) — 홈의 「내 정보」 에서 적습니다. */
  bio?: string | null;
  /** 프로필 이미지 (`USER-004`) — 데이터 URI 그대로. */
  avatar?: string | null;
}

function ProjectSettings() {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [repo, setRepo] = useState('');
  const [meetingTitle, setMeetingTitle] = useState('');
  const [copyNote, setCopyNote] = useState<Note | null>(null);
  const [copyLabel, setCopyLabel] = useState('코드 복사');
  const [health, setHealth] = useState<HealthView | null>(null);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [myId, setMyId] = useState<number | null>(null);
  const [teamNote, setTeamNote] = useState<Note | null>(null);
  const [slow, setSlow] = useState(false);
  const [backfill, setBackfill] = useState<Note | null>(null);
  const [roles, setRoles] = useState<Record<string, number>>({});
  const [roleMessage, setRoleMessage] = useState<Note | null>(null);
  const [ghLogin, setGhLogin] = useState('');
  const [ghLoginMessage, setGhLoginMessage] = useState<Note | null>(null);
  const [deleteResult, setDeleteResult] = useState<Note | null>(null);
  // 성공하면 되돌릴 수 없으므로 다시 누를 이유가 없습니다.
  const [deleteDone, setDeleteDone] = useState(false);
  // 누르는 동안 잠급니다 (결함 89). 회의도 초대 코드도 **누른 만큼 생깁니다.**
  const [busy, setBusy] = useState(false);

  const applyDetail = (next: Detail): void => {
    setDetail(next);
    setTitle(next.title);
    setRepo(next.github_repo ?? '');
  };

  const loadHealth = useCallback(async (): Promise<void> => {
    // ⚠️ 예전에는 HTML 에 "연결 상태를 확인하는 중…" 을 심어 뒀습니다.
    // 이 요청은 거의 언제나 200ms 안에 끝나므로, 그 문구는 화면을 열
    // 때마다 **한 번 깜빡이기만** 했습니다 (지시서 §4.7).
    const response = await whileLoading(
      call(`/api/projects/${projectId}/github`),
      () => setSlow(true),
      () => setSlow(false),
    );
    // ⚠️ 여기서 조용히 넘어가면 진단 구역이 비고, **빈 구역은 사람 눈에
    // "문제 없음" 으로 보입니다.** 못 물어봤다는 것과 괜찮다는 것은 다릅니다.
    if (response === null) return setHealth(describeHealthFailure(0));
    if (!response.ok) return setHealth(describeHealthFailure(response.status));
    setHealth(describeHealth((await response.json()) as GithubHealth, new Date()));
  }, []);

  const loadRoles = useCallback(async (): Promise<void> => {
    const response = await call(`/api/projects/${projectId}/members`);
    if (response === null || !response.ok) return;
    const members = (await response.json()) as TeamMember[];
    const meRes = await call('/api/auth/me');
    if (meRes === null || !meRes.ok) return;
    const me = (await meRes.json()) as { user_id: number };
    const mine = members.find((entry) => entry.user_id === me.user_id);
    // ⚠️ 명단과 "나" 를 같이 들고 있어야 합니다. 누구를 바꿀 수 있는지는
    //    **내 등급과 상대 등급을 같이 봐야** 정해집니다.
    setTeam(members);
    setMyId(me.user_id);
    setRoles(mine?.role_shares ?? {});
    setRoleMessage({ text: `지금 ${describeRoles(mine?.role_shares)}`, tone: 'plain' });
    // ⚠️ **저장한 것이 화면으로 돌아와야 합니다.** 안 돌아오면 사람은 매번
    // 다시 적고, 이미 이어 놓았다는 사실을 못 봅니다 (결함 94·97 과 같은 부류).
    setGhLogin(mine?.github_login ?? '');
    setGhLoginMessage({ text: githubLoginStatus(mine?.github_login ?? null), tone: 'plain' });
  }, []);

  /** 남의 권한을 바꾼다. ⚠️ 서버가 거절하면 **이유를 그대로 보여 줍니다.** */
  const changeRole = async (userId: number, role: string): Promise<void> => {
    const response = await send(
      `/api/projects/${projectId}/members/${userId}/role`,
      { method: 'PATCH', body: JSON.stringify({ project_role: role }) },
    );
    if (response === null) {
      setTeamNote({ text: unreachableText('권한을 바꾸지 못했습니다'), tone: 'bad' });
      return;
    }
    if (!response.ok) {
      setTeamNote({ text: await detailText(response, '권한을 바꾸지 못했습니다'), tone: 'bad' });
      return;
    }
    setTeamNote({ text: '권한을 바꿨습니다.', tone: 'plain' });
    await loadRoles();
  };

  const removeMember = async (userId: number, name: string): Promise<void> => {
    // ⚠️ 되돌릴 수 없으므로 먼저 묻습니다.
    if (!confirm(`${name} 님을 팀에서 내보냅니다. 맡은 업무와 회의 기록은 남습니다.`)) {
      return;
    }
    const response = await send(`/api/projects/${projectId}/members/${userId}`, {
      method: 'DELETE',
    });
    if (response === null) {
      setTeamNote({ text: unreachableText('내보내지 못했습니다'), tone: 'bad' });
      return;
    }
    if (!response.ok) {
      setTeamNote({ text: await detailText(response, '내보내지 못했습니다'), tone: 'bad' });
      return;
    }
    setTeamNote({ text: `${name} 님이 팀에서 빠졌습니다.`, tone: 'plain' });
    await loadRoles();
  };

  const leave = async (): Promise<void> => {
    if (!confirm(LEAVE_CONFIRM)) return;
    const response = await send(`/api/projects/${projectId}/members/me/leave`, {
      method: 'POST',
    });
    if (response === null) {
      setTeamNote({ text: unreachableText('나가지 못했습니다'), tone: 'bad' });
      return;
    }
    if (!response.ok) {
      setTeamNote({ text: await detailText(response, '나가지 못했습니다'), tone: 'bad' });
      return;
    }
    // 나간 프로젝트는 더 볼 수 없습니다. 빈 화면에 남겨 두면 오류로 읽힙니다.
    location.href = '/home.html';
  };

  const load = useCallback(async (): Promise<void> => {
    const response = await call(`/api/projects/${projectId}`);
    if (response === null) {
      // 빈 화면은 "설정할 게 없다" 로 읽힙니다 (결함 102).
      setError(unreachableText('프로젝트를 불러오지 못했습니다'));
      return;
    }
    if (!response.ok) {
      setError(
        response.status === 403
          ? '이 프로젝트의 구성원만 볼 수 있습니다.'
          : `불러오지 못했습니다 (HTTP ${response.status})`,
      );
      return;
    }
    applyDetail((await response.json()) as Detail);
  }, []);

  const loadAnalytics = useCallback(async (): Promise<void> => {
    // ⚠️ 이것 하나가 실패해도 설정 화면 전체를 못 쓰게 만들지 않습니다 —
    //    역할·GitHub 설정은 프로젝트 상태 없이도 고칠 수 있습니다.
    //    `ok` 일 때만 그리고, 아니면 구역 자체가 안 나옵니다.
    const response = await call(`/api/projects/${projectId}/analytics`);
    if (response === null || !response.ok) return;
    setAnalytics((await response.json()) as Analytics);
  }, []);

  useEffect(() => {
    void load();
    void loadHealth();
    void loadRoles();
    void loadAnalytics();
  }, [load, loadHealth, loadRoles, loadAnalytics]);

  /** 잠그고 → 하고 → 푼다. 여덟 자리가 같은 모양이라 한 곳에 둡니다. */
  const guarded = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await run();
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = (): void => {
    const problem = titleProblem(title);
    if (problem) {
      setError(problem);
      return;
    }
    void guarded(async () => {
      const r = await send(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: title.trim() }),
      });
      if (r === null) return setError(unreachableText('이름을 바꾸지 못했습니다'));
      setError(
        r.ok ? '' : detailText(await r.json().catch(() => null), `이름을 바꾸지 못했습니다 (HTTP ${r.status})`),
      );
      if (r.ok) applyDetail((await r.json()) as Detail);
    });
  };

  const saveRepo = (): void => {
    const problem = repoProblem(repo);
    if (problem) {
      setError(problem);
      return;
    }
    // 주소를 붙여넣었으면 고쳐서 보내고, 고친 결과를 칸에도 되돌려 줍니다 —
    // 무엇이 저장됐는지 보이지 않으면 다음에 또 주소를 넣습니다.
    const clean = normalizeRepo(repo);
    setRepo(clean);
    void guarded(async () => {
      const r = await send(`/api/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify({ github_repo: clean }),
      });
      if (r === null) return setError(unreachableText('저장하지 못했습니다'));
      if (r.status === 409) {
        return setError('다른 프로젝트가 이미 이 저장소를 쓰고 있습니다.');
      }
      setError(
        r.ok ? '' : detailText(await r.json().catch(() => null), `저장하지 못했습니다 (HTTP ${r.status})`),
      );
      if (!r.ok) return;
      applyDetail((await r.json()) as Detail);
      // 저장소를 바꿨으면 진단도 다시 봐야 합니다. 안 그러면 앞 저장소의
      // 상태가 남아 **방금 잘못 적은 이름이 정상으로 보입니다.**
      await loadHealth();
    });
  };

  const rotate = (): void => {
    const ok = window.confirm(
      '초대 코드를 새로 만듭니다.\n지금 코드는 그 즉시 통하지 않습니다. 계속할까요?',
    );
    if (!ok) return;
    // ⚠️ 실패하면 화면이 그대로라 사람은 코드가 바뀐 줄 알고
    // **옛 코드를 다시 나눠 줍니다.**
    void guarded(async () => {
      const r = await send(`/api/projects/${projectId}/invite/rotate`, { method: 'POST' });
      if (r === null) return setError(unreachableText('코드를 새로 만들지 못했습니다'));
      if (!r.ok) {
        /* ⛔ 예전에는 `(HTTP ${r.status})` 였습니다 (결함 316). 소유자가
           아닌 사람이 누르면 서버가 「이 작업을 할 권한이 없습니다」라고
           **정확히** 말하는데 화면은 「HTTP 403」을 내보냈습니다. */
        const body = (await r.json().catch(() => null)) as unknown;
        return setError(detailText(body, `코드를 새로 만들지 못했습니다 (HTTP ${r.status})`));
      }
      setError('');
      applyDetail((await r.json()) as Detail);
    });
  };

  const copy = (): void => {
    // 표시용 문자열이 아니라 **데이터**에서 만듭니다 (결함 71).
    const text = codeToCopy(detail?.invite_code || null);
    if (text === null) return;
    // ⚠️ **안 됐을 때 그렇다고 말합니다** (결함 81). 폰에서 `http://` 로
    // 열면 `navigator.clipboard` 가 아예 없습니다 — 예전에는 조용히 죽었고,
    // 사람은 클립보드에 남아 있던 **다른 글**을 카톡으로 보냈습니다.
    void copyText(text, navigator.clipboard).then((outcome) => {
      if (copySucceeded(outcome)) {
        setCopyNote(null);
        setCopyLabel(describeCopy(outcome, '코드'));
        setTimeout(() => setCopyLabel('코드 복사'), 1500);
        return;
      }
      // 실패 이유는 버튼이 아니라 아래 줄에 적습니다 — 버튼 글자를 길게
      // 만들면 옆의 "코드 새로 만들기" 와 겹칩니다 (결함 77).
      setCopyNote({ text: describeCopy(outcome, '코드'), tone: 'bad' });
    });
  };

  const openMeeting = (): void => {
    // ⚠️ 회의도 **누른 만큼 생깁니다.** 두 번 누르면 빈 회의가 하나 남고,
    // 팀원이 어느 쪽에 들어갈지 갈립니다 (결함 89).
    void guarded(async () => {
      const r = await send(`/api/projects/${projectId}/meetings`, {
        method: 'POST',
        body: JSON.stringify({ title: meetingTitle.trim() || null }),
      });
      if (r === null) return setError(unreachableText('회의를 열지 못했습니다'));
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as unknown;
        return setError(detailText(body, `회의를 열지 못했습니다 (HTTP ${r.status})`));
      }
      const created = (await r.json()) as { meeting_id: number };
      location.href = `/lobby.html?meeting=${created.meeting_id}`;
    });
  };

  const startBackfill = (): void => {
    void guarded(async () => {
      // ⚠️ 진행·실패·성공이 **한 자리**에 옵니다 (결함 98).
      setBackfill({ text: '가져오는 중…', tone: 'plain' });
      // ⚠️ `headers` 를 다시 주지 않습니다 — `call()` 이 이미 넣습니다.
      const r = await send(`/api/projects/${projectId}/github/backfill`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (r === null) {
        return setBackfill({ text: unreachableText('가져오지 못했습니다'), tone: 'bad' });
      }
      if (!r.ok) {
        // 409 는 "왜 안 되는지" 를 서버가 문장으로 줍니다 — 그대로 보여 줍니다.
        const body = (await r.json().catch(() => null)) as unknown;
        return setBackfill({
          text: detailText(body, `가져오지 못했습니다 (HTTP ${r.status})`),
          tone: 'bad',
        });
      }
      // ⚠️ **"완료" 라고 말하지 않습니다.** 서버는 큐에 넣었을 뿐이고 워커가
      // 실제로 가져오는 데는 시간이 걸립니다. 완료라고 하면 사람은 바로
      // 기여도를 보러 가서 "안 늘었네" 라고 읽습니다.
      setBackfill({
        text:
          '가져오기를 시작했습니다. PR 수에 따라 몇 분 걸립니다 — ' +
          '잠시 뒤 이 화면을 새로고침하면 반영된 범위가 바뀝니다.',
        tone: 'plain',
      });
    });
  };

  const saveRoles = (): void => {
    const problem = problemWith(roles);
    if (problem !== null) {
      setRoleMessage({ text: problem, tone: 'bad' });
      return;
    }
    void guarded(async () => {
      const r = await send(`/api/projects/${projectId}/members/me`, {
        method: 'PATCH',
        body: JSON.stringify({ role_shares: rolesToPayload(roles) }),
      });
      if (r === null) {
        return setRoleMessage({ text: unreachableText('역할을 저장하지 못했습니다'), tone: 'bad' });
      }
      const body = (await r.json()) as { role_shares?: Record<string, number> };
      if (!r.ok) {
        return setRoleMessage({
          text: detailText(body, '역할을 저장하지 못했습니다'),
          tone: 'bad',
        });
      }
      setRoleMessage({ text: `저장했습니다 — ${describeRoles(body.role_shares)}`, tone: 'plain' });
    });
  };

  const saveGithubLogin = (): void => {
    void guarded(async () => {
      const r = await send(`/api/projects/${projectId}/members/me/github`, {
        method: 'PATCH',
        body: JSON.stringify({ github_login: ghLogin }),
      });
      if (r === null) {
        return setGhLoginMessage({
          text: unreachableText('GitHub 계정을 저장하지 못했습니다'),
          tone: 'bad',
        });
      }
      const body = (await r.json()) as { github_login?: string | null };
      if (!r.ok) {
        // 409(이미 쓰는 사람 있음)와 400(형식) 둘 다 서버 문장이 그대로
        // 사람에게 쓸 만합니다.
        return setGhLoginMessage({
          text: detailText(body, 'GitHub 계정을 저장하지 못했습니다'),
          tone: 'bad',
        });
      }
      // 서버가 정리한 값을 되받아 씁니다 — 주소를 붙여 넣었으면 아이디만 남습니다.
      setGhLogin(body.github_login ?? '');
      setGhLoginMessage({ text: githubLoginStatus(body.github_login ?? null), tone: 'plain' });
      // 연결 진단의 "연결하지 않은 팀원" 경고가 방금 바뀌었을 수 있습니다.
      await loadHealth();
    });
  };

  const deleteMine = (): void => {
    if (!window.confirm(confirmPrompt())) return;
    void guarded(async () => {
      setDeleteResult({ text: '지우는 중…', tone: 'plain' });
      const r = await send(`/api/projects/${projectId}/me/data`, { method: 'POST' });
      if (r === null) {
        return setDeleteResult({ text: describeRequestFailure(0), tone: 'bad' });
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as unknown;
        return setDeleteResult({
          text: describeRequestFailure(r.status, detailText(body, '') || undefined),
          tone: 'bad',
        });
      }
      const outcome = describeOutcome((await r.json()) as RevokeResult);
      setDeleteResult({ text: outcome.text, tone: outcome.needsRetry ? 'bad' : 'plain' });
      // 다시 시도해야 하면 버튼을 살려 둡니다. 성공했으면 되돌릴 수 없으므로
      // 다시 누를 이유가 없습니다.
      setDeleteDone(!outcome.needsRetry);
    });
  };

  const inviteCode = detail?.invite_code || null;
  const roleTotal = sumOf(roles);

  /* ⚠️ `?? null` 이 아니라 **`undefined` 를 살립니다** (결함 254). 명단이
     아직 안 왔을 때 `null` 로 뭉개면 소유자에게도 「관리자에게 요청하세요」
     라고 말합니다. `manageBlockedBecause` 가 그 둘을 갈라 씁니다. */
  const myRole = team.length === 0 ? undefined : team.find((e) => e.user_id === myId)?.project_role;
  /* ⛔ **레거시 설정 화면은 관리 권한을 한 번도 안 봤습니다** (결함 316).
     소유자가 아닌 사람에게 「코드 새로 만들기」·「이름 저장」·「저장소
     연결」이 **열린 채로** 그려졌고, 누르면 403 이 오고 화면은
     「HTTP 403」이라고 적었습니다. SPA 는 셋 다 `manageBlockedBecause`
     를 거칩니다 — 그 함수의 주석이 예로 드는 것이 바로 이 단추입니다.
     301·308·309·313 에 이어 레거시만 갈라진 다섯 번째입니다. */
  const rotateBlocked = manageBlockedBecause(myRole, '초대 코드 새로 만들기');
  const titleBlocked = manageBlockedBecause(myRole, '프로젝트 이름 바꾸기');
  const repoBlocked = manageBlockedBecause(myRole, '저장소 연결');
  const leaveWhy = leaveBlockedBecause(
    myRole,
    team.map((entry) => entry.project_role ?? 'member'),
  );

  return (
    <>
      <header className="head">
        <h1 id="title-heading">{detail?.title ?? '프로젝트'}</h1>
        <p className="lede">
          역할과 GitHub 계정은 기여도 계산에 그대로 들어갑니다. 회의를 여는 곳도 여기입니다.
        </p>
      </header>

      <p className="meta-line" id="members">
        {detail === null ? '' : `팀원 ${detail.member_count}명`}
      </p>

      <ProjectHealth data={analytics} />

      {/* ⭐ 팀원과 권한 (`PROJECT-003`·`PROJECT-004`).

          ⚠️ 여기 버튼을 숨기는 것은 **보안이 아닙니다.** 진짜 문은
          서버입니다. 여기서 하는 일은 못 하는 버튼을 안 보여 주는
          것뿐입니다 — 눌렀더니 403 이 뜨는 화면은 "고장" 으로 읽힙니다.

          ⚠️ **줄을 세우지 않습니다.** 서버가 주는 순서 그대로 씁니다.
          권한 순으로 정렬하면 맨 위가 "제일 높은 사람" 이 되고, 그건
          이 화면이 만들면 안 되는 그림입니다. */}
      {team.length > 0 && (
        <section className="panel team">
          <h2>팀원</h2>
          <p className="sub">
            권한은 무엇을 바꿀 수 있는가입니다. 기여도 가중치(위의 내 역할)와는 다릅니다.
          </p>
          <ul className="mlist">
            {team.map((person) => {
              const isMe = person.user_id === myId;
              // 고를 것이 하나도 없으면 안 그립니다 (결함 362) — 판단은 `@lib`.
              const options = roleChoicesFor(myRole, person.project_role, { isMe });
              const canEdit = options.length > 0;
              return (
                <li key={person.user_id}>
                  {/* 프로필 이미지 (`USER-004`). 없으면 아무것도 안 그립니다 —
                      안 올린 것은 잘못이 아니라서 빈 동그라미로 세지 않습니다. */}
                  {typeof person.avatar === 'string' && person.avatar !== '' && (
                    <img className="mface" src={person.avatar} alt="" />
                  )}
                  <span className="mname">
                    {/* ⭐ 지금 붙어 있는가 (`USER-005`).
                        ⚠️ **오프라인은 안 그립니다** — 팀 대부분이 그
                        상태라 다 그리면 목록이 회색 점으로 덮이고,
                        "누가 없는지" 를 한눈에 세게 만듭니다.
                        ⚠️ 색으로만 말하지 않습니다. 점만 찍으면 색을 못
                        보는 사람에게는 아무 표시도 없는 것입니다. */}
                    {worthShowing(person.presence) && (
                      <span className={`pdot ${presenceDot(person.presence)}`} aria-hidden="true" />
                    )}
                    {/* ⭐ **같은 이름이 둘이면 손잡이를 붙입니다** (결함 345).
                        바로 옆이 「내보내기」 — 되돌릴 수 없는 단추입니다.
                        판단은 `@lib/people/labels.ts`. */}
                    {labelInList(person, team)}
                    {worthShowing(person.presence) && (
                      <span className="pstat">{presenceLabel(person.presence)}</span>
                    )}
                    {isMe && <span className="mme">나</span>}
                  </span>
                  {canEdit ? (
                    <select
                      className="mrole"
                      value={person.project_role ?? 'member'}
                      onChange={(e) => void changeRole(person.user_id, e.target.value)}
                      aria-label={`${labelInList(person, team)} 권한`}
                    >
                      {/* ⚠️ 지금 값이 목록에 없을 수 있습니다(내가 줄 수 없는
                          등급). 빼면 select 가 엉뚱한 값을 보여 줍니다. */}
                      {!options.includes((person.project_role ?? 'member') as never) && (
                        <option value={person.project_role ?? 'member'}>
                          {roleLabel(person.project_role)}
                        </option>
                      )}
                      {options.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="mrole-flat">{roleLabel(person.project_role)}</span>
                  )}
                  {canRemove(myRole, person.project_role, { isMe }) && (
                    <button
                      className="mout"
                      onClick={() =>
                        void removeMember(person.user_id, labelInList(person, team))
                      }
                    >
                      내보내기
                    </button>
                  )}
                  {/* ⚠️ 이름표를 붙여도 두 줄이 똑같은 경우 (둘 다 GitHub
                      미연결). 「구분됩니다」인 척하면 사람이 되돌릴 수 없는
                      단추를 찍습니다 — 막지는 않고 사실만 적습니다. */}
                  {!tellsApartInList(person, team) && (
                    <span className="mbio">{cannotTellApartNote()}</span>
                  )}
                  {/* 자기소개 (`USER-004`) — 적을 수 있는데 아무도 못 보면
                      "할 일을 알려 주고 자리를 안 줌" 입니다. 여기가 그 자리. */}
                  {typeof person.bio === 'string' && person.bio !== '' && (
                    <span className="mbio">{person.bio}</span>
                  )}
                </li>
              );
            })}
          </ul>

          <NoteLine note={teamNote} />

          {/* ⭐ 나가기 (`PROJECT-006`).
              ⚠️ 막힐 때 **버튼을 지우지 않고 이유를 말합니다.** 없어진
              버튼은 "이 화면은 나갈 수 없다" 가 아니라 "고장" 으로
              읽힙니다. */}
          <h3 className="sub-head">이 프로젝트에서 나가기</h3>
          {leaveWhy === null ? (
            <button className="leave" onClick={() => void leave()}>
              나가기
            </button>
          ) : (
            <p className="sub">{leaveWhy}</p>
          )}
        </section>
      )}

      {/* ⭐ 역할. 이 값이 기여도 **가중치**를 정합니다 — 바꿀 자리가 없던
          동안 전원이 개발자로 계산돼, 문서만 쓴 사람이 이유 없이 낮게
          나왔고 오류는 안 났습니다. */}
      <section className="panel">
        <h2>내 역할</h2>
        <p className="sub">기여도 가중치가 여기서 정해집니다. 겸직이면 둘 이상에 나눠 적으세요.</p>
        <div id="roles" className="roles">
          {ROLE_OPTIONS.map((opt) => (
            <label key={opt.key}>
              <span>{opt.label}</span>
              <input
                type="number"
                className="rshare"
                data-role={opt.key}
                step="0.1"
                min="0"
                max="1"
                aria-label={`${opt.label} 비중`}
                value={roles[opt.key] ?? 0}
                onChange={(e) =>
                  setRoles((prev) => ({
                    ...prev,
                    // 빈 칸은 0 으로 칩니다 — 역할에서는 "안 적었다" 가 곧
                    // "이 역할은 아니다" 입니다. (확정 화면의 빈 칸과 다릅니다.)
                    [opt.key]: e.target.value.trim() === '' ? 0 : Number(e.target.value),
                  }))
                }
              />
              <span className="hint">{opt.hint}</span>
            </label>
          ))}
        </div>
        <p className={Math.abs(roleTotal - 1) > 1e-6 ? 'rolesum bad' : 'rolesum'} id="role-sum">
          합계 {roleTotal}
        </p>
        <button id="save-roles" type="button" disabled={busy} onClick={saveRoles}>
          역할 저장
        </button>
        <NoteLine note={roleMessage} className="rolestatus" id="role-message" />
        <p className="note">
          <strong>내 역할만 바꿉니다.</strong> 역할은 가중치를 바꾸고 가중치는 점수를 바꿉니다 —
          남이 내 역할을 바꿀 수 있으면 그건 남의 점수를 바꾸는 일입니다. 바꾼 사실은 기록에
          남습니다.
        </p>
      </section>

      {/* ⚠️ 이 칸이 비어 있으면 **그 사람의 PR 이 주인을 못 찾습니다**
          (결함 112). 읽는 곳은 넷인데 값을 넣는 자리가 저장소에 0곳이었고,
          연결 진단은 "연결하지 않은 팀원이 있습니다" 라고 경고하면서
          연결할 곳을 안 줬습니다. */}
      <section className="panel">
        <h2>내 GitHub 계정</h2>
        <p className="sub">
          이 아이디로 올린 PR·리뷰가 내 기여도로 들어옵니다. 안 적으면 활동이 주인을 못 찾습니다.
        </p>
        <label className="row">
          <input
            id="gh-login"
            type="text"
            placeholder="minsu-dev"
            autoComplete="off"
            spellCheck={false}
            value={ghLogin}
            onChange={(e) => setGhLogin(e.target.value)}
          />
        </label>
        <button id="save-gh-login" type="button" disabled={busy} onClick={saveGithubLogin}>
          계정 저장
        </button>
        <NoteLine note={ghLoginMessage} className="rolestatus" id="gh-login-message" />
        <p className="note">
          <strong>내 계정만 바꿉니다.</strong> 한 프로젝트에서 같은 아이디를 둘이 쓸 수 없습니다 —
          남의 아이디를 적으면 그 사람의 PR이 내 기여가 되기 때문입니다. 바꾼 사실은 기록에
          남습니다.
        </p>
      </section>

      <section className="panel">
        <h2>팀원 초대</h2>
        {/* ⚠️ **없는 것을 코드처럼 보이게 두지 않습니다.** `#code` 는 초대
            코드용 조판(굵은 고정폭)인데, `(없음)` 까지 그렇게 그리면 그것도
            코드로 읽힙니다 — 결함 71 이 고친 오해를 조판이 거들게 됩니다. */}
        <p id="code" className={inviteCode === null ? 'none' : undefined}>
          {inviteCode === null ? NO_CODE : formatCode(inviteCode)}
        </p>
        <div className="row">
          {/* ⚠️ 코드가 없으면 **누를 수 없게** 합니다. 예전에는 눌리는 채로
              두고 화면 글자를 복사했는데, 클립보드에 `(없음)` 이 들어가고
              버튼은 "복사됨" 이라고 말했습니다. 그걸 받은 사람은 참가 칸에
              `(없음)` 을 넣고 "코드가 없습니다" 를 보고 **자기를 의심합니다.** */}
          <button
            id="copy"
            type="button"
            disabled={inviteCode === null}
            title={inviteCode === null ? '초대 코드가 없습니다 — 새로 만들어 주세요' : ''}
            onClick={copy}
          >
            {copyLabel}
          </button>
          {/* ⚠️ 막는 것은 `disabled` 가 아니라 `aria-disabled` 입니다
              (결함 234) — 초점을 받고, **사유를 말합니다**(결함 239). */}
          <button
            id="rotate"
            type="button"
            disabled={busy}
            aria-disabled={rotateBlocked !== null}
            aria-describedby={rotateBlocked !== null ? 'rotate-why' : undefined}
            onClick={() => {
              if (rotateBlocked !== null) return;
              rotate();
            }}
          >
            코드 새로 만들기
          </button>
          {rotateBlocked !== null && (
            /* ⚠️ 가리키기만 하고 안 그리면 낭독기가 빈 곳을 가리킵니다 —
               결함 239 가 잡은 그 모양입니다. */
            <p className="status" id="rotate-why">
              {rotateBlocked}
            </p>
          )}
        </div>
        <NoteLine note={copyNote} className="status" id="copy-note" />
        <p id="next">{detail === null ? '' : nextStepAfterCreate(detail.member_count)}</p>
      </section>

      <section className="panel">
        <h2>회의 열기</h2>
        <label>
          회의 제목 (선택)
          <input
            id="meeting-title"
            type="text"
            placeholder="1주차 정기회의"
            value={meetingTitle}
            onChange={(e) => setMeetingTitle(e.target.value)}
          />
        </label>
        <button
          id="open-meeting"
          className="primary"
          type="button"
          disabled={busy}
          onClick={openMeeting}
        >
          회의를 열고 로비로
        </button>
      </section>

      <section className="panel">
        <h2>설정</h2>
        <label>
          프로젝트 이름
          <input id="title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <button
          id="save-title"
          type="button"
          disabled={busy}
          aria-disabled={titleBlocked !== null}
          aria-describedby={titleBlocked !== null ? 'title-why' : undefined}
          onClick={() => {
            if (titleBlocked !== null) return;
            saveTitle();
          }}
        >
          이름 저장
        </button>
        {titleBlocked !== null && (
          <p className="status" id="title-why">
            {titleBlocked}
          </p>
        )}

        <label style={{ marginTop: '1rem' }}>
          GitHub 저장소
          <input
            id="repo"
            type="text"
            placeholder="owner/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
          />
        </label>
        <button
          id="save-repo"
          type="button"
          disabled={busy}
          aria-disabled={repoBlocked !== null}
          aria-describedby={repoBlocked !== null ? 'repo-why' : undefined}
          onClick={() => {
            if (repoBlocked !== null) return;
            saveRepo();
          }}
        >
          저장소 연결
        </button>
        {repoBlocked !== null && (
          <p className="status" id="repo-why">
            {repoBlocked}
          </p>
        )}

        {/* ⚠️ 이 구역이 없던 동안, 저장소 이름을 잘못 적으면 **아무 오류도
            나지 않고 기여도만 비었습니다.** 사람은 그걸 "활동을 안 했다" 로
            읽습니다. 그래서 상태만이 아니라 **왜 그렇게 봤는지**와
            **지금 할 일**을 같이 보여줍니다. */}
        <div id="gh-health" className={health === null ? 'health' : `health ${health.tone}`}>
          {health === null ? (
            // 200ms 전에는 **아무것도 안 그립니다.**
            slow && (
              <p
                id="gh-headline"
                className="health-headline"
                aria-busy="true"
                dangerouslySetInnerHTML={{ __html: skeletonRows(1) }}
              />
            )
          ) : (
            <>
              <p id="gh-headline" className="health-headline">
                <WithCode text={health.headline} />
              </p>
              <p id="gh-detail" className="health-detail">
                <WithCode text={health.detail} />
              </p>
              {health.nextStep !== null && health.nextStep !== '' && (
                <p id="gh-next" className="health-next">
                  <WithCode text={health.nextStep} />
                </p>
              )}
              <ul id="gh-warnings" className="plain health-warnings">
                {health.warnings.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              {health.activity !== '' && (
                <p id="gh-activity" className="health-activity">
                  {health.activity}
                </p>
              )}
            </>
          )}
        </div>

        {/* 연결 **전**의 PR 을 가져옵니다. 웹훅은 연결한 순간부터 오므로,
            그 전에 제일 많이 일한 사람이 제일 적게 일한 것으로 보입니다.
            "이 수치는 언제부터의 활동인가" — 범위를 안 밝힌 숫자는
            **전부를 센 것처럼** 읽힙니다. */}
        {health !== null && health.coverage !== '' && (
          <p id="gh-coverage" className="sub">
            {health.coverage}
          </p>
        )}
        {/* ⚠️ 배달이 0건일 때는 안 보입니다. 연결도 안 됐는데 "가져오기" 를
            누르면 아무 일이 없고, 사람은 그게 고장인 줄 압니다. */}
        {health !== null && health.canBackfill && (
          <button id="gh-backfill" type="button" disabled={busy} onClick={startBackfill}>
            지난 활동 가져오기
          </button>
        )}
        <NoteLine note={backfill} className="sub" id="gh-backfill-status" />
      </section>

      {/* ⚠️ 이건 **법적 권리**입니다. 위험한 관리자 동작이 아닙니다. 마찰을
          넣지 않되, 되돌릴 수 없다는 것과 기여도에 무슨 일이 일어나는지를
          누르기 **전에** 말합니다 (docs/07 P6). */}
      <section className="panel danger">
        <h2>내 녹음 지우기</h2>
        <p className="sub">
          이 프로젝트에 남아 있는 <strong>내 목소리</strong>를 지웁니다. 개인정보 삭제
          요청권(개인정보보호법 제36조)입니다.
        </p>

        <p className="label">지워지는 것</p>
        <ul id="del-gone" className="plain">
          {whatGetsDeleted().map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>

        <p className="label">남는 것</p>
        <ul id="del-kept" className="plain">
          {whatRemains().map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>

        <p className="label">기여도는 어떻게 되나요</p>
        <p id="del-score" className="sub">
          <Emphasized text={whatHappensToMyScore()} />
        </p>

        <button
          id="del-run"
          type="button"
          className="btn-block danger-btn"
          disabled={busy || deleteDone}
          onClick={deleteMine}
        >
          내 녹음과 성문 지우기
        </button>
        <NoteLine note={deleteResult} id="del-result" />
      </section>

      {error !== '' && <p id="error">{error}</p>}

      <p className="note">
        초대 코드는 <strong>메신저로 돌아다니므로 샙니다.</strong> 팀이 다 모이면 새로 만들어
        두는 게 좋습니다 — 지금 코드는 그 즉시 통하지 않습니다.
        <br />
        <br />
        저장소는 <code>owner/repo</code> 형식입니다. 주소를 붙여넣어도 고쳐서 저장합니다 — 웹훅이{' '}
        <code>repository.full_name</code>으로 프로젝트를 찾기 때문에, 형식이 틀리면{' '}
        <strong>오류 없이 기여도만 비어 있게</strong> 됩니다.
      </p>
    </>
  );
}

const host = document.getElementById('app');
if (host === null) throw new Error('요소 없음: app');
createRoot(host).render(<ProjectSettings />);

renderNav('project');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
