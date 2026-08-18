import { useState } from 'react';
import { useParams } from 'react-router-dom';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { AppShell } from '../components/AppShell.tsx';
import { Chain } from '../components/Chain.tsx';
import { Why } from '../components/Why.tsx';
import { useMembers, useTaskMutations, useTasks } from '../api/hooks.ts';
import {
  isOverdue,
  moveDirection,
  nextStatuses,
  statusPatch,
  summarize,
  taskWarnings,
  toColumns,
  describeStatus,
  describeLinkState,
  type Task,
} from '@lib/kanban/board.ts';
import { canDropOn, dragPayload, draggedTaskId, TASK_DRAG_TYPE } from '@lib/kanban/dnd.ts';
import { assigneeText, toggled, type Person } from '@lib/kanban/assignees.ts';
import { deleteTaskConfirm } from '@lib/project/roles.ts';
import { todayInTeamCalendar } from '@lib/time/calendar.ts';
import { withJosa } from '@lib/text/josa.ts';

// 칸반 — 카드에서 버튼을 걷어내고 드래그 + ⋯ 메뉴 + 숫자 키로 (지시서 기타-6 §칸반).
//
// 회의 출처 칩은 인디고("근거 있음")이고 검토 화면으로 이어집니다 —
// 근거 번호만 주고 볼 자리를 안 주는 것이 이 저장소의 대표 실패 ③입니다.

function Card({
  task,
  statuses,
  people,
  onMove,
  onToggleAssignee,
  onDelete,
}: {
  task: Task;
  statuses: string[];
  people: Person[];
  onMove: (task: Task, to: string) => void;
  onToggleAssignee: (task: Task, userId: number) => void;
  onDelete: (task: Task) => void;
}) {
  const today = todayInTeamCalendar();
  const warnings = taskWarnings(task, today);
  const overdue = isOverdue(task, today);
  const others = nextStatuses(task, statuses);

  // 카드 포커스 후 1~4 키 — 접근성 경로. 버튼을 상시 펼치지 않는 대신입니다.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > statuses.length) return;
    const to = statuses[n - 1];
    if (to !== undefined && canDropOn(task, to, statuses)) {
      e.preventDefault();
      onMove(task, to);
    }
  };

  return (
    <article
      className="kcard"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_DRAG_TYPE, dragPayload(task.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onKeyDown={onKeyDown}
      aria-label={`${task.title} — ${describeStatus(task.status)}. 1~${statuses.length} 키로 이동`}
    >
      <div className="kcard__top">
        <span className="kcard__title">{task.title}</span>
        <Menu.Root>
          <Menu.Trigger asChild>
            <button type="button" className="kcard__menu-btn" aria-label={`${task.title} 메뉴`}>
              ⋯
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="menu" align="end">
              {others.map((to) => (
                <Menu.Item
                  key={to}
                  className="menu__item"
                  onSelect={() => onMove(task, to)}
                >
                  {moveDirection(task.status, to, statuses) === 'forward' ? '→' : '←'}{' '}
                  {withJosa(describeStatus(to), '으로로')}
                  <span className="menu__kbd">{statuses.indexOf(to) + 1}</span>
                </Menu.Item>
              ))}
              <div className="menu__sep" />
              {people.map((person) => (
                <Menu.Item
                  key={person.user_id}
                  className="menu__item"
                  onSelect={() => onToggleAssignee(task, person.user_id)}
                >
                  {task.assignee_ids.includes(person.user_id) ? '✓ ' : ''}
                  {person.name}
                </Menu.Item>
              ))}
              <div className="menu__sep" />
              <Menu.Item
                className="menu__item menu__item--danger"
                onSelect={() => onDelete(task)}
              >
                지우기
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      <div className="kcard__meta">
        <span>{assigneeText(task.assignee_ids, people)}</span>
        {task.deadline !== null && (
          <span className="num">
            {task.deadline}
            {overdue && <span className="kcard__late">지남</span>}
          </span>
        )}
        {/* 표식은 사람이 PR 에 적어야 하는 값입니다 — 설명 대신 값만 둡니다.
            무엇에 쓰는지는 열 머리말에서 **한 번** 말합니다. */}
        <span className="kcard__marker num">{task.marker}</span>
        <Why about={task.title} lines={warnings} />
      </div>
      {/* 회의 → 이 업무 → PR. **빈 고리가 "아직 안 이어졌다" 를 말합니다** —
          카드마다 반복하던 안내 문장(26자 × 카드 수)이 이걸로 사라집니다. */}
      <Chain
        links={[
          {
            label: '근거',
            value:
              task.origin === null
                ? null
                : String(task.origin.evidence_utterance_ids.length),
            ...(task.origin !== null
              ? {
                  to: `/meeting/${task.origin.meeting_id}/review`,
                  hint: `${task.origin.meeting_title ?? '회의'}에서 나온 업무입니다 — 근거 발화 보기`,
                }
              : { hint: '사람이 손으로 만든 업무입니다 — 회의 근거가 없습니다' }),
          },
          {
            label: 'PR',
            value: (task.github ?? []).length === 0 ? null : String(task.github.length),
            hint: describeLinkState(task),
          },
        ]}
      />
    </article>
  );
}

export default function Kanban() {
  const params = useParams();
  const projectId = Number(params['projectId']);
  const board = useTasks(projectId);
  const membersQuery = useMembers(projectId);
  const { patchTask, setAssignees, deleteTask } = useTaskMutations(projectId);
  const [overCol, setOverCol] = useState<string | null>(null);

  const statuses = board.data?.statuses ?? [];
  const tasks = board.data?.tasks ?? [];
  const people: Person[] = (membersQuery.data ?? []).map((m) => ({
    user_id: m.user_id,
    name: m.name,
  }));
  const columns = toColumns(tasks, statuses);
  const s = summarize(tasks, todayInTeamCalendar());

  const move = (task: Task, to: string) => {
    patchTask.mutate({ taskId: task.id, patch: statusPatch(to) });
  };
  const toggleAssignee = (task: Task, userId: number) => {
    setAssignees.mutate({ taskId: task.id, userIds: toggled(task.assignee_ids, userId) });
  };
  const remove = (task: Task) => {
    if (window.confirm(deleteTaskConfirm(task.title))) deleteTask.mutate(task.id);
  };

  return (
    <AppShell
      title="칸반"
      meta={
        <>
          회의에서 {s.fromMeetings} · PR 연결 {s.withPulls} · 지연 {s.overdue}
          {/* ⭐ 표식 규칙은 **여기서 한 번만** 말합니다. 예전에는 카드마다
              같은 안내를 적어 넉 장이면 네 번(106자) 반복됐고, 늘 있는
              글자는 배경이 되어 아무도 안 읽었습니다. */}
          <Why
            about="PR 자동 연결"
            lines={[
              'PR 제목이나 본문에 카드의 업무 표식(TASK-n)을 적으면 그 PR이 이 업무에 자동으로 붙습니다.',
              '표식 없이 병합된 PR은 제목이 비슷하면 추정으로 붙고, 카드에 "추정" 으로 표시됩니다.',
            ]}
          />
        </>
      }
    >
      <div className="board">
        {board.isSuccess && tasks.length === 0 && (
          <div className="empty" style={{ alignSelf: 'flex-start', flex: 1 }}>
            아직 업무가 없습니다 — 회의 검토에서 후보를 승인하면 여기 올라옵니다.
          </div>
        )}
        {tasks.length > 0 &&
          columns.map((column) => (
            <section
              key={column.status}
              className={`col${overCol === column.status ? ' col--over' : ''}`}
              aria-label={`${column.label} ${column.tasks.length}건`}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(TASK_DRAG_TYPE)) {
                  e.preventDefault();
                  setOverCol(column.status);
                }
              }}
              onDragLeave={() => setOverCol(null)}
              onDrop={(e) => {
                setOverCol(null);
                const id = draggedTaskId(e.dataTransfer.getData(TASK_DRAG_TYPE));
                const task = tasks.find((t) => t.id === id);
                if (task && canDropOn(task, column.status, statuses)) {
                  move(task, column.status);
                }
              }}
            >
              <div className="col__head">
                {column.label} <span className="col__count">{column.tasks.length}</span>
              </div>
              <div className="col__body">
                {column.tasks.map((task) => (
                  <Card
                    key={task.id}
                    task={task}
                    statuses={statuses}
                    people={people}
                    onMove={move}
                    onToggleAssignee={toggleAssignee}
                    onDelete={remove}
                  />
                ))}
              </div>
            </section>
          ))}
      </div>
      {(patchTask.isError || setAssignees.isError || deleteTask.isError) && (
        <p className="disabled-reason" role="alert" style={{ padding: '0 var(--sp-6) var(--sp-4)' }}>
          바꾸지 못했습니다 — 새로고침한 뒤 다시 해 보세요.
        </p>
      )}
    </AppShell>
  );
}
