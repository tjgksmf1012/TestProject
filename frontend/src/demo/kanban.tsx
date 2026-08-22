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

import { useCallback, useEffect, useState, type DragEvent } from 'react';
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
  emptyBoard,
  unknownOriginNote,
} from '../lib/kanban/board.ts';
import { canDropOn, draggedTaskId, dragPayload, TASK_DRAG_TYPE } from '../lib/kanban/dnd.ts';
import { assigneeText, splitNote, toggled } from '../lib/kanban/assignees.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { deleteTaskConfirm } from '../lib/project/roles.ts';
import { withJosa } from '../lib/text/josa.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { detailText } from '../lib/http/detail.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { board as boardSkeleton } from '../lib/ui/skeleton.ts';
import { todayInTeamCalendar } from '../lib/time/calendar.ts';
import { Byline, RawHtml } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';
import { meetingLabel } from '../lib/ui/naming.ts';

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

/**
 * 실패한 응답을 **사람이 읽을 한 줄**로 (결함 301).
 *
 * ⛔ 예전에는 `` `지우지 못했습니다 (${describeHttpStatus(response.status)})` ``
 * 였습니다. `describeHttpStatus` 는 **400·409·422 에 아무 말도 없어서**
 * `null` 을 돌려주고, 그 글자가 그대로 화면에 나갑니다 —
 * 「지우지 못했습니다 (null)」. 서버는 그때 「이 프로젝트의 팀원이 아닌
 * 사람은 담당자로 지정할 수 없습니다」처럼 정확히 말하고 있습니다.
 *
 * ⚠️ 이 모양은 **재현하지 못했습니다** — 화면의 담당자 칸이 팀원만
 * 보여 주기 때문입니다. 그래도 `null` 을 글자로 내보내는 것은 고쳤습니다.
 */
async function failureText(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  return detailText(body, describeHttpStatus(response.status) ?? fallback);
}

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

interface Loaded {
  tasks: Task[];
  statuses: string[];
  members: Member[];
  /**
   * 담당자로 남아 있지만 지금은 팀원이 아닌 사람들 (서버의 `former_assignees`).
   *
   * ⛔ 이게 없어서 나간 사람이 맡았던 카드가 「**사용자 #3**」으로 떴습니다
   * (결함 308). `/members` 는 **지금 구성원**뿐이라 나간 사람이 없습니다.
   *
   * ⚠️ `members` 에 섞지 **않습니다.** 그 목록은 담당자를 **고르는** 자리
   * (`AssigneePicker`)에도 쓰여서, 섞으면 떠난 사람에게 새 일을 맡길 수
   * 있게 됩니다. **이름을 부르는 것과 고르는 것은 다른 일입니다.**
   */
  former: Member[];
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
          /* ⛔ 예전에는 「손으로 만든 업무입니다」였습니다 (결함 317) —
             313 이 고친 곳의 **셋째 자리**이고, 이 제품에 그 길은
             없습니다. 모르는 것은 모른다고 적습니다. */
          <p>{unknownOriginNote()}</p>
        ) : (
          <p>
            {meetingLabel(task.origin.meeting_title, task.origin.meeting_id)}에서 나온 업무입니다 · 근거 발화{' '}
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

/**
 * 담당자를 바꾸는 자리 (`TASK-006`).
 *
 * ## ⚠️ 이 자리가 없어서 요구가 반쪽이었습니다
 *
 * 담당자는 **회의 업무 후보를 승인할 때 한 번** 정해지고 그 뒤로는 바꿀
 * 방법이 없었습니다. 사람이 빠지거나 일을 넘겨받아도 칸반은 옛 이름을
 * 계속 말했고, 기여 이벤트는 계속 그 사람 앞으로 갔습니다.
 *
 * ## ⚠️ 접어 둡니다
 *
 * 카드마다 이름 목록을 펼쳐 두면 보드가 체크박스 밭이 됩니다. 매일
 * 하는 일은 카드를 옮기는 것이지 담당자를 바꾸는 것이 아닙니다.
 */
function AssigneePicker({
  task,
  members,
  moving,
  onAssign,
}: {
  task: Task;
  members: Member[];
  moving: boolean;
  onAssign: (userIds: number[]) => void;
}) {
  if (members.length === 0) return null;
  return (
    <details className="whoedit">
      <summary>담당자 바꾸기</summary>
      <div className="whoedit-body">
        {members.map((member) => (
          <label key={member.user_id}>
            <input
              type="checkbox"
              checked={task.assignee_ids.includes(member.user_id)}
              disabled={moving}
              /* ⚠️ 넣고 빼는 계산은 `lib/kanban/assignees.ts` 가 합니다.
                 여기서 배열을 주무르면 같은 판단이 두 벌이 됩니다. */
              onChange={() => onAssign(toggled(task.assignee_ids, member.user_id))}
            />
            {member.name}
          </label>
        ))}
      </div>
    </details>
  );
}

function Card({
  task,
  today,
  statuses,
  members,
  /* ⚠️ **이름을 부르는 명단**입니다 — 나간 담당자까지 포함합니다 (결함 308).
     담당자를 **고르는** 명단(`members`)과 일부러 다릅니다. */
  naming,
  moving,
  beingDragged,
  onMove,
  onDelete,
  onAssign,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  today: string;
  statuses: string[];
  members: Member[];
  naming: Member[];
  moving: boolean;
  beingDragged: boolean;
  onMove: (to: string) => void;
  onDelete: () => void;
  onAssign: (userIds: number[]) => void;
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}) {
  const warnings = taskWarnings(task, today);
  const split = splitNote(task.assignee_ids);

  return (
    <article
      className={beingDragged ? 'task dragging' : 'task'}
      data-id={task.id}
      /* ⭐ 끌기 (`TASK-005`) — **버튼에 더하는** 마우스 지름길입니다.
         HTML5 DnD 라 터치에서는 아예 안 돌고, 키보드·낭독기에게는 처음부터
         없는 기능입니다. 그 사람들의 길이 아래 `.move` 버튼이므로 버튼을
         지우면 안 됩니다 — 가드가 짝을 잽니다. */
      draggable={!moving}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}>
      <p className="title">{task.title}</p>
      <p className="meta">
        {assigneeText(task.assignee_ids, naming)}
        {task.deadline ? ` · 마감 ${task.deadline}` : ''}
      </p>

      {/* ⭐ **나눠 셌다는 사실을 카드가 말합니다** (`TASK-006`).
          안 적으면 사람은 같이 한 업무 때문에 자기 기여도가 낮게 나온
          이유를 모릅니다 — 결과만 주고 이유를 안 주는 것이고, 이 저장소의
          대표 실패 ③ 과 같은 모양입니다.

          ⚠️ 흙빛(`--gap`)입니다. 빨강이 아닙니다 — 같이 맡은 것은 잘못이
          아니라 그냥 사실입니다. */}
      {split !== null && <p className="shared">{split}</p>}

      <AssigneePicker task={task} members={members} moving={moving} onAssign={onAssign} />

      {/* ⭐ 이 프로젝트의 주장이 화면에서 보이는 지점. 이게 없으면 이
          화면은 그냥 할 일 목록입니다.

          ⚠️ **손으로 만든 업무는 아무 말도 안 합니다** (docs/19 §18).
          그건 기본값이라 대부분의 카드에 붙었고, 회의 표시를 눈에 안
          띄게 만들었습니다. 없는 것이 곧 "손으로 만든 것" 입니다. */}
      {task.origin && (
        <p className="origin">
          <span className="ico" dangerouslySetInnerHTML={{ __html: iconSvg('meeting') }} />
          {meetingLabel(task.origin.meeting_title, task.origin.meeting_id)}
          <span className="ev">근거 {task.origin.evidence_utterance_ids.length}</span>
        </p>
      )}

      <PullList task={task} />

      {/* 못 재는 자리 — **형태로** 말합니다. 전문은 접힌 곳에.
          ⚠️ 못 잰다는 말은 경고가 아닙니다 — 담당자가 없는 업무는 잘못된
          것이 아니라 **누구 기여인지 알 수 없는** 것이라 흙빛입니다. */}
      {warnings.length > 0 && <p className="gapmark">기여도에 반영 안 됨</p>}

      <div className="moves">
        {/* ⭐ 지우기 (`TASK-003`).

            ⚠️ **팀원도 지웁니다.** 관리자만 지울 수 있으면 사람들은
            지우는 대신 완료 칸으로 밀어 넣고, 그러면 진행률이 거짓이
            되어 기여도와 보고서로 흘러갑니다.

            ⚠️ 빨강이 아닙니다. 이 저장소에서 빨강은 "네가 뭘 잘못했다"
            이고, 카드를 지우는 것은 잘못이 아닙니다. */}
        <button className="drop" disabled={moving} onClick={() => onDelete()}>
          지우기
        </button>
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
  /**
   * 지금 끌고 있는 카드 (`TASK-005`).
   *
   * ⚠️ `dragover` 에서는 `dataTransfer` 의 **값을 못 읽습니다**(브라우저가
   * drop 전에는 형식 이름만 보여 줍니다). 어느 열을 밝힐지는 이 상태로
   * 판단하고, 값은 drop 에서 읽어 **다시 검증**합니다 — drop 은 다른 창의
   * 끌기로도 일어날 수 있습니다.
   */
  const [dragTask, setDragTask] = useState<Task | null>(null);
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
    const payload = (await boardRes.json()) as {
      statuses: string[];
      tasks: Task[];
      former_assignees?: Member[];
    };
    setScreen({
      k: 'ok',
      data: {
        tasks: payload.tasks,
        statuses: payload.statuses,
        members: memberRes?.ok ? ((await memberRes.json()) as Member[]) : [],
        former: payload.former_assignees ?? [],
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

  // ⭐ `?task=N` 으로 들어오면 **그 카드까지 데려다 줍니다.**
  //
  // 프로젝트 상태 화면의 근거 링크(`analytics/view.ts::taskHref`)가 여기로
  // 옵니다. 이게 없으면 근거를 눌러도 판만 열리고, 열두 장 중 어느 것인지
  // 사람이 다시 찾아야 합니다 — 링크가 있는데 도착을 안 시키는 것은 링크가
  // 없는 것과 거의 같습니다.
  //
  // ⚠️ 숫자인지 먼저 봅니다. 주소창에서 온 글자를 그대로 선택자에 넣으면
  //    남이 판을 열어 놓고 아무 선택자나 던질 수 있습니다.
  useEffect(() => {
    if (screen.k !== 'ok') return;
    const wanted = params.get('task');
    if (wanted === null || !/^\d+$/.test(wanted)) return;
    const card = document.querySelector(`.task[data-id="${wanted}"]`);
    if (card === null) return;
    card.classList.add('found');
    card.scrollIntoView({ block: 'center' });
  }, [screen]);

  /**
   * 업무를 지운다 (`TASK-003`).
   *
   * ⚠️ **먼저 묻습니다.** 되돌릴 방법을 화면이 안 줍니다.
   * ⚠️ 문구는 `lib/project/roles.ts` 가 만듭니다 — 조사(`을/를`)를
   *    받침 보고 골라야 하고, 그건 판단이라 화면에 두면 안 됩니다.
   */
  const drop = async (task: Task): Promise<void> => {
    if (!confirm(deleteTaskConfirm(task.title))) return;
    setMoving(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}/api/projects/${projectId}/tasks/${task.id}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        }),
      );
      if (response === null) {
        setError(unreachableText('지우지 못했습니다'));
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        setError(await failureText(response, '지우지 못했습니다'));
        return;
      }
      setError('');
      await load();
    } finally {
      setMoving(false);
    }
  };

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
        setError(
          detailText(
            await response.json().catch(() => null),
            `옮기지 못했습니다 (HTTP ${response.status})`,
          ),
        );
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

  /**
   * 담당자를 바꾼다 (`TASK-006`).
   *
   * ⚠️ **더하기·빼기가 아니라 통째로 보냅니다.** 서버가 받은 목록으로
   * 바꿉니다 — 차이를 화면에서 계산하면 그 계산이 두 곳으로 갈라집니다.
   *
   * ⚠️ 응답으로 온 카드만 갈아 끼웁니다. 판 전체를 다시 받으면 스크롤이
   * 튀고, 방금 연 서랍이 닫힙니다.
   */
  const assign = async (taskId: number, userIds: number[]): Promise<void> => {
    setMoving(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}/api/projects/${projectId}/tasks/${taskId}/assignees`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_ids: userIds }),
          credentials: 'same-origin',
        }),
      );
      if (response === null) {
        setError(unreachableText('담당자를 바꾸지 못했습니다'));
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        setError(await failureText(response, '담당자를 바꾸지 못했습니다'));
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
        {/* ⛔ 예전에는 「회의에서 승인된 업무와 **직접 만든 업무**가…」였습니다
            (결함 313). 빈 상자만 고치고 **여기를 놓칠 뻔했습니다** — 이 줄은
            비어 있지 않을 때도 늘 보이니 더 자주 읽힙니다. 같은 화면에서
            같은 모양을 몇 곳이나 쓰는지 세고 고칩니다(실패 ②). */}
        <p className="lede">회의에서 승인된 업무가 단계별로 놓입니다.</p>
        {me !== null && <Byline name={me.name} avatar={me.avatar} what="보는 중" />}
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

  const { tasks, statuses, members, former } = screen.data;
  /* 이름을 부를 때만 나간 담당자를 더합니다 — 고르는 자리(`AssigneePicker`)
     에는 안 넣습니다 (결함 308). */
  const naming = [...members, ...former];
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
            /* ⛔ 예전 문구는 「… **직접 만들 수도 있습니다**」였습니다
               (결함 313). 이 제품에 그 길은 **일부러** 없습니다 — 업무를
               만드는 코드는 `approval_service.py` 한 곳이고 그 옆에
               「승인 없이 tasks 에 쓰는 경로는 없다 — 그게 불변식이다」라고
               적혀 있습니다. 화면의 컨트롤 열셋을 세어 봐도 만드는 것은
               없었습니다. SPA 는 처음부터 맞게 적고 있었고, 이제 **한 벌**
               입니다. */
            html={emptyHtml({
              ...emptyBoard(),
              action: { label: '회의 열기', href: `/project.html?project=${projectId}` },
            })}
          />
        </div>
      ) : (
        <div id="board" className="board">
          {toColumns(tasks, statuses).map((column) => (
            <section
              /* ⭐ 놓을 수 있는 열만 밝힙니다 — 허용 범위는 버튼과 같은
                 `nextStatuses` 에서 옵니다(`canDropOn` 이 위임). */
              className={
                dragTask !== null && canDropOn(dragTask, column.status, statuses)
                  ? 'col dropok'
                  : 'col'
              }
              key={column.label}
              onDragOver={(e) => {
                if (moving || dragTask === null) return;
                if (!canDropOn(dragTask, column.status, statuses)) return;
                // 기본값이 「못 놓음」 입니다 — 허용할 때만 풉니다.
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                e.preventDefault();
                const id = draggedTaskId(e.dataTransfer.getData(TASK_DRAG_TYPE));
                setDragTask(null);
                if (moving || id === null) return;
                // ⚠️ 상태에 든 카드가 아니라 **건너온 id 로 다시** 찾고
                //    다시 판정합니다. drop 은 아무나 일으킬 수 있습니다.
                const dropped = tasks.find((t) => t.id === id);
                if (dropped === undefined) return;
                if (!canDropOn(dropped, column.status, statuses)) return;
                void move(dropped.id, column.status);
              }}
            >
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
                    naming={naming}
                    moving={moving}
                    beingDragged={dragTask !== null && dragTask.id === task.id}
                    onMove={(to) => void move(task.id, to)}
                    onDelete={() => void drop(task)}
                    onAssign={(userIds) => void assign(task.id, userIds)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TASK_DRAG_TYPE, dragPayload(task.id));
                      e.dataTransfer.effectAllowed = 'move';
                      setDragTask(task);
                    }}
                    onDragEnd={() => setDragTask(null)}
                  />
                ))
              )}
            </section>
          ))}
        </div>
      )}

      {/* 옮기기가 실패했을 때만 글이 찹니다. `role="status"` 라 낭독기도
          듣습니다 — 비었을 때는 공용 CSS 가 여백을 걷습니다. */}
      <p id="result" role="status">{error}</p>
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
