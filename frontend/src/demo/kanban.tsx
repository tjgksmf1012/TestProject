/**
 * 칸반 보드 — **React 로 옮긴 두 번째 화면** (docs/19 §24).
 *
 * 이 화면이 이 저장소의 대표 주장이 끝까지 도는지를 보여 주는 자리입니다 —
 * 회의에서 나온 결정이 사람의 승인을 거쳐 업무가 되고, 그 업무가 PR 로
 * 끝났는가.
 *
 * ## ⚠️ 옮기면서 지킨 것
 *
 * **판단은 하나도 여기로 오지 않았습니다.** `lib/kanban/board.ts` 의
 * `toColumns`·`nextStatuses`·`moveDirection`·`taskWarnings`·`summarize`·
 * `statusPatch`·`sortLinks`·`describe*` 를 그대로 부릅니다. 화면 코드에는
 * 자동 테스트가 없으므로, 판단이 이리로 새는 만큼이 검증 밖으로 나갑니다.
 *
 * CSS 클래스 이름도 그대로입니다 — 브리프대로 맞춰 놓은 판형을 스택을
 * 옮기면서 다시 흔들 이유가 없습니다.
 *
 * ## 옮기면서 사라진 것 하나
 *
 * `escapeHtml` 을 안 부릅니다. 업무 제목은 LLM 이 발화에서 만든 문자열이라
 * 태그처럼 생긴 말이 그대로 들어올 수 있는데, JSX 는 텍스트를 **언제나**
 * 이스케이프합니다. 손으로 부르는 것보다 안전합니다 — 빠뜨릴 자리가 없어서.
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  describeLinkState,
  describePull,
  describeStatus,
  moveDirection,
  nextStatuses,
  sortLinks,
  statusPatch,
  summarize,
  taskWarnings,
  toColumns,
  type Task,
} from '../lib/kanban/board.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { withJosa } from '../lib/text/josa.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { board as boardSkeleton } from '../lib/ui/skeleton.ts';
import { todayInTeamCalendar } from '../lib/time/calendar.ts';
import { Byline, RawHtml } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

interface Member {
  user_id: number;
  name: string;
}

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 **비밀번호와 회의 음성이 어디로
// 가는지**를 링크 하나로 바꿀 수 있다. safeApiBase 가 진짜 도메인에서는
// 무시하고, 로컬 화면에서 로컬 서버일 때만 통과시킨다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

// ⚠️ **읽기도 `tryGet` 을 거칩니다** (결함 102) — 칸반 판이 텅 빈 채로 남았습니다.
const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

interface Loaded {
  tasks: Task[];
  statuses: string[];
  members: Member[];
}

type Screen =
  | { k: 'loading' }
  | { k: 'unreachable' }
  | { k: 'failed'; status: number }
  | { k: 'ok'; data: Loaded };

// ══════════════════════════════════════════════════════════════
// 조각들
// ══════════════════════════════════════════════════════════════

/**
 * 카드의 접힌 서랍 — **지운 것이 아니라 접은 것** (docs/19 §18).
 *
 * 여기 들어가는 문장은 전부 예전에 카드에 항상 떠 있던 것입니다.
 * DOM 에 그대로 남으므로 낭독기도 브라우저 검색도 닿습니다. `hidden` 이
 * 아니라 `<details>` 인 이유가 그것입니다 — `hidden` 은 낭독기에서도
 * 사라져서 지운 것과 같습니다.
 */
function Drawer({ task, warnings }: { task: Task; warnings: readonly string[] }) {
  const links = task.github ?? [];
  return (
    <details className="more">
      <summary>자세히</summary>
      <div className="more-body">
        {task.origin === null || task.origin === undefined ? (
          <p>손으로 만든 업무입니다 — 회의에서 나온 것이 아닙니다.</p>
        ) : (
          <p>
            {task.origin.meeting_title ?? '회의'}에서 나온 업무입니다 · 근거 발화{' '}
            {task.origin.evidence_utterance_ids.length}건
          </p>
        )}
        {/* 카드 표면에서는 색으로만 말한 것(확정/추정)을 여기서는 글로 남깁니다. */}
        <p>{describeLinkState(task)}</p>
        {links.map((link, i) => (
          <p key={i}>
            {describePull(link)} — {link.why}
          </p>
        ))}
        {warnings.map((w, i) => (
          <p key={i}>{w}</p>
        ))}
      </div>
    </details>
  );
}

/**
 * 이 업무가 어느 PR 로 끝났는가 — 대표 주장의 마지막 칸.
 *
 * ⚠️ 안 붙었을 때 **카드 표면에는 아무것도 안 그립니다.** 문장이 카드마다
 * 똑같아서 보드 전체가 같은 안내로 덮였습니다. 침묵하는 것이 아니라
 * `Drawer` 가 접어서 들고 있습니다.
 *
 * ⚠️ 근거(`why`)를 **줄로 깔지 않습니다.** 확정과 추정은 이미 **색**이
 * 말하고 있어서(초록/호박) 문장은 같은 말을 두 번 하는 것이었습니다.
 */
function PullList({ task }: { task: Task }) {
  const links = sortLinks(task.github ?? []);
  if (links.length === 0) return null;
  return (
    <ul className="gh-list">
      {links.map((link, i) => (
        <li key={i} className={link.confirmed ? 'sure' : 'guess'} title={link.why}>
          {describePull(link)}
        </li>
      ))}
    </ul>
  );
}

function Card({
  task,
  today,
  statuses,
  members,
  moving,
  onMove,
}: {
  task: Task;
  today: string;
  statuses: string[];
  members: Member[];
  moving: boolean;
  onMove: (to: string) => void;
}) {
  const warnings = taskWarnings(task, today);
  const who =
    task.assignee_id === null
      ? '담당자 없음'
      : (members.find((m) => m.user_id === task.assignee_id)?.name ??
        `사용자 #${task.assignee_id}`);

  return (
    <article className="task" data-id={task.id}>
      <p className="title">{task.title}</p>
      <p className="meta">
        {who}
        {task.deadline ? ` · 마감 ${task.deadline}` : ''}
      </p>

      {/* ⭐ 이 프로젝트의 주장이 화면에서 보이는 지점. 이게 없으면 이
          화면은 그냥 할 일 목록입니다.

          ⚠️ **손으로 만든 업무는 아무 말도 안 합니다** (docs/19 §18).
          그건 기본값이라 대부분의 카드에 붙었고, 회의 표시를 눈에 안
          띄게 만들었습니다. 없는 것이 곧 "손으로 만든 것" 입니다. */}
      {task.origin && (
        <p className="origin">
          <span className="ico" dangerouslySetInnerHTML={{ __html: iconSvg('meeting') }} />
          {task.origin.meeting_title ?? '회의'}
          <span className="ev">근거 {task.origin.evidence_utterance_ids.length}</span>
        </p>
      )}

      <PullList task={task} />

      {/* 못 재는 자리 — **형태로** 말합니다. 전문은 접힌 곳에.
          ⚠️ 못 잰다는 말은 경고가 아닙니다 — 담당자가 없는 업무는 잘못된
          것이 아니라 **누구 기여인지 알 수 없는** 것이라 흙빛입니다. */}
      {warnings.length > 0 && <p className="gapmark">기여도에 반영 안 됨</p>}

      <div className="moves">
        {nextStatuses(task, statuses).map((s) => (
          <button
            key={s}
            className="move"
            data-to={s}
            /* ⭐ `data-dir` 이 버튼 위계를 만듭니다 (브리프 §14). 앞으로
               보내는 것이 주된 행동이고 되돌리기는 실수를 무를 때만
               씁니다 — 예전에는 둘이 카드 폭을 반씩 채웠습니다. */
            data-dir={moveDirection(task.status, s, statuses)}
            disabled={moving}
            onClick={() => onMove(s)}
          >
            {/* ⚠️ `…로` 를 글자로 붙이면 안 됩니다. `진행 중` 은 받침이
                있어 `진행 중으로` 이고, 붙여 놓은 동안 버튼에 **"진행
                중로"** 가 떴습니다. */}
            {withJosa(describeStatus(s), '으로로')}
          </button>
        ))}
      </div>

      <Drawer task={task} warnings={warnings} />
    </article>
  );
}

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

function Kanban() {
  const [screen, setScreen] = useState<Screen>({ k: 'loading' });
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  // 옮기는 동안 잠급니다. 두 번 눌러 두 칸 건너뛰는 것을 막습니다.
  const [moving, setMoving] = useState(false);
  // 스켈레톤을 **켤 때만** 켜지는 깃발.
  const [slow, setSlow] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    // ⭐ 명단은 **프로젝트** 단위로 받습니다. 예전에는 회의 단위 명단만
    // 있어서 `?project=N` 만으로 이 화면을 열면 모든 이름이 `사용자 #3`
    // 으로 떴습니다.
    //
    // 열 수는 서버가 주는 상태 목록이 정하는데 받기 전에는 모릅니다.
    // 셋으로 그립니다 — 틀려도 도착하는 순간 제 수로 맞춰집니다.
    const [boardRes, memberRes] = await whileLoading(
      Promise.all([
        get(`/api/projects/${projectId}/tasks`),
        get(`/api/projects/${projectId}/members`),
      ]),
      () => setSlow(true),
      () => setSlow(false),
    );

    if (boardRes === null) {
      setScreen({ k: 'unreachable' });
      return;
    }
    if (isSessionExpired(boardRes.status)) {
      goToLogin();
      return;
    }
    if (!boardRes.ok) {
      setScreen({ k: 'failed', status: boardRes.status });
      return;
    }
    const payload = (await boardRes.json()) as { statuses: string[]; tasks: Task[] };
    setScreen({
      k: 'ok',
      data: {
        tasks: payload.tasks,
        statuses: payload.statuses,
        members: memberRes?.ok ? ((await memberRes.json()) as Member[]) : [],
      },
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
        setMe((await response.json()) as Me);
      }
      await load();
    })();
  }, [load]);

  const move = async (taskId: number, to: string): Promise<void> => {
    setMoving(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}/api/projects/${projectId}/tasks/${taskId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          // ⚠️ `statusPatch` 를 씁니다. 손으로 객체를 만들면서
          // `deadline: null` 을 넣으면 서버가 마감일을 지웁니다.
          body: JSON.stringify(statusPatch(to)),
          credentials: 'same-origin',
        }),
      );
      if (response === null) {
        setError(unreachableText('옮기지 못했습니다'));
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        setError(`옮기지 못했습니다 (HTTP ${response.status})`);
        return;
      }
      const updated = (await response.json()) as Task;
      setError('');
      setScreen((prev) =>
        prev.k !== 'ok'
          ? prev
          : {
              ...prev,
              data: {
                ...prev.data,
                tasks: prev.data.tasks.map((t) => (t.id === updated.id ? updated : t)),
              },
            },
      );
    } finally {
      setMoving(false);
    }
  };

  const header = (
    <>
      <header className="head">
        <h1>칸반</h1>
        <p className="lede">회의에서 승인된 업무와 직접 만든 업무가 단계별로 놓입니다.</p>
        {me !== null && <Byline name={me.name} what="보는 중" />}
      </header>
    </>
  );

  const footer = (
    <details className="more">
      <summary>이 화면을 읽는 법</summary>
      <div className="more-body">
        <p>
          말풍선 표시가 붙은 업무는 <strong>회의에서 나온 결정</strong>이 사람의 승인을 거쳐
          여기까지 온 것입니다. 근거 발화까지 거슬러 올라갈 수 있습니다 — 그게 이 프로젝트가
          하려는 일입니다.
        </p>
        <p>
          업무를 <strong>완료</strong>로 옮기면 그 시점에 기여 이벤트가 만들어지고 기여도 화면에
          반영됩니다. 마감일이 있으면 지켰는지도 같이 기록됩니다. 담당자가 없는 업무는 누구의
          기여인지 알 수 없어 반영되지 않습니다.
        </p>
      </div>
    </details>
  );

  if (screen.k !== 'ok') {
    return (
      <>
        {header}
        {screen.k === 'loading' ? (
          // 200ms 전에는 **아무것도 안 그립니다.**
          slow && (
            <div
              id="board"
              className="board"
              aria-busy="true"
              dangerouslySetInnerHTML={{ __html: boardSkeleton(3) }}
            />
          )
        ) : (
          // ⚠️ 보드 자리에 씁니다. 화면 맨 아래에 한 줄만 남기면 **보드는
          // 텅 빈 채**로 있고 사람은 업무가 없는 줄 압니다 — 실패와 0건이
          // 같은 모양이 됩니다.
          <RawHtml
            html={
              screen.k === 'unreachable'
                ? failureHtml({
                    what: unreachableText('업무를 불러오지 못했습니다.'),
                    retry: true,
                  })
                : failureHtml({
                    what: '업무를 불러오지 못했습니다.',
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
        {footer}
      </>
    );
  }

  const { tasks, statuses, members } = screen.data;
  const today = todayInTeamCalendar();
  const summary = summarize(tasks, today);

  return (
    <>
      {header}

      {/* ⭐ 대표 주장 한 줄 — 회의에서 나와서 PR 로 끝났는가.
          ⚠️ `전체`·`완료` 를 뺐습니다 (브리프 §17). 바로 아래 **열 머리가
          이미 세고 있습니다** — 같은 수를 두 번 적으면 사람은 둘이 다른
          것인 줄 알고 대조합니다. */}
      <p className="flow" id="counts">
        <span>
          회의에서 나온 업무<b>{summary.fromMeetings}</b>
        </span>
        <span>
          PR로 이어진 업무<b>{summary.withPulls}</b>
        </span>
        <span className="late">
          지연<b>{summary.overdue}</b>
        </span>
      </p>

      {/* ⚠️ 업무가 하나도 없으면 **열만 세 개** 서고 전부 "비어 있음"
          입니다. 그 화면은 아무것도 안 알려 주면서 고장처럼 보입니다 —
          "없는 것을 빈 것으로 답한다" 그대로입니다. */}
      {summary.total === 0 ? (
        <div id="board" className="board">
          <RawHtml
            html={emptyHtml({
              what: '여기에는 팀의 업무 카드가 단계별로 놓입니다.',
              why: '아직 등록된 업무가 하나도 없습니다 — 고장이 아닙니다.',
              how: '회의를 열어 녹음하면 AI가 업무 후보를 뽑고, 승인한 것이 여기로 옵니다. 직접 만들 수도 있습니다.',
              action: { label: '회의 열기', href: `/project.html?project=${projectId}` },
            })}
          />
        </div>
      ) : (
        <div id="board" className="board">
          {toColumns(tasks, statuses).map((column) => (
            <section className="col" key={column.label}>
              <h2>
                {column.label} <span className="n">{column.tasks.length}</span>
              </h2>
              {column.tasks.length === 0 ? (
                <p className="empty">비어 있음</p>
              ) : (
                column.tasks.map((task) => (
                  <Card
                    key={task.id}
                    task={task}
                    today={today}
                    statuses={statuses}
                    members={members}
                    moving={moving}
                    onMove={(to) => void move(task.id, to)}
                  />
                ))
              )}
            </section>
          ))}
        </div>
      )}

      <p id="result">{error}</p>
      {footer}
    </>
  );
}

const host = document.getElementById('app');
if (host === null) throw new Error('요소 없음: app');
createRoot(host).render(<Kanban />);

renderNav('kanban');

// 서비스 워커 등록 + 설치 안내. 안 부르면 sw.js 는 그냥 놓인 파일이다.
bootApp();
