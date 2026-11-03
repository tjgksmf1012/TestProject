import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as Menu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { AppShell } from '../components/AppShell.tsx';
import { DiscordSelect } from '../components/SettingsModal.tsx';
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
  countText,
  describeLinkState,
  describePull,
  sortLinks,
  type Task,
  emptyBoardLine,
  unknownOriginNote,
} from '@lib/kanban/board.ts';
import { canDropOn, dragPayload, draggedTaskId, TASK_DRAG_TYPE } from '@lib/kanban/dnd.ts';
import { labelInList } from '@lib/people/labels.ts';
import {
  describePriority,
  priorityChoices,
  priorityTone,
  showsBadge,
} from '@lib/kanban/priority.ts';
import { assigneeText, toggled, type Person } from '@lib/kanban/assignees.ts';
import { deleteTaskConfirm } from '@lib/project/roles.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';
import { ApiError } from '../api/client.ts';

/** 실패에서 상태 코드만 꺼냅니다. `null` 은 **서버에 못 닿은 것**입니다. */
function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

/** 서버가 사람에게 쓴 문장. 409 에서는 이것이 일반론보다 낫습니다 (결함 300). */
function detailOf(error: unknown): string | null {
  return error instanceof ApiError ? error.detail : null;
}
import { todayInTeamCalendar } from '@lib/time/calendar.ts';
import { withJosa } from '@lib/text/josa.ts';
import { Problem } from '../components/Problem.tsx';
import { meetingLabel } from '@lib/ui/naming.ts';

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
  onPriority,
  onEdit,
  onDelete,
  onPreviewEvidence,
}: {
  task: Task;
  statuses: string[];
  people: Person[];
  onMove: (task: Task, to: string) => void;
  onToggleAssignee: (task: Task, userId: number) => void;
  onPriority: (task: Task, priority: number) => void;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onPreviewEvidence?: (task: Task) => void;
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
        <span className="kcard__marker num">{task.marker}</span>
        {showsBadge(task.priority) && (
          <span className={`kprio kprio--${priorityTone(task.priority)}`}>
            {describePriority(task.priority)}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <Why about={task.title} lines={warnings} />
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
                  {labelInList(person, people)}
                </Menu.Item>
              ))}
              <div className="menu__sep" />
              {priorityChoices(task.priority).map((choice) => (
                <Menu.Item
                  key={choice.value}
                  className="menu__item"
                  onSelect={() => onPriority(task, choice.value)}
                >
                  {choice.current ? '✓ ' : ''}
                  {choice.label}
                </Menu.Item>
              ))}
              <div className="menu__sep" />
              <Menu.Item
                className="menu__item"
                onSelect={() => onEdit(task)}
              >
                ✏️ 제목·마감 수정
              </Menu.Item>
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
      <div className="kcard__title">{task.title}</div>
      <div className="kcard__meta">
        <span className="kcard__assignee">
          <span className="kcard__avatar" aria-hidden="true">
            {assigneeText(task.assignee_ids, people).slice(0, 1)}
          </span>
          <span>{assigneeText(task.assignee_ids, people)}</span>
        </span>
        {(task.start_date != null || task.deadline !== null) && (
          <span className="kcard__date num">
            {task.start_date != null && task.deadline !== null
              ? `${task.start_date} ~ ${task.deadline}`
              : task.deadline ?? `시작 ${task.start_date}`}
            {overdue && <span className="kcard__late">지남</span>}
          </span>
        )}
        {(task.blocked_by ?? []).length > 0 && (
          <span className="num" title={`선행 업무: ${(task.blocked_by ?? []).map((id) => `#${id}`).join(', ')}`}>
            선행 {(task.blocked_by ?? []).length}건
          </span>
        )}
      </div>
      <div className="kcard__foot">
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
                    hint: `${meetingLabel(task.origin.meeting_title, task.origin.meeting_id)}에서 나온 업무입니다 — 근거 발화 보기`,
                  }
                : { hint: unknownOriginNote() }),
            },
            {
              label: 'PR',
              value: (task.github ?? []).length === 0 ? null : String(task.github.length),
              hint: describeLinkState(task),
            },
          ]}
        />
        {task.origin !== null && onPreviewEvidence && (
          <button
            type="button"
            style={{
              background: 'var(--c-surface-sunken)',
              border: '1px solid var(--c-line)',
              borderRadius: 'var(--r-sm)',
              padding: '2px 6px',
              fontSize: '11px',
              color: 'var(--c-ink-muted)',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
            }}
            title="페이지 이동 없이 회의 맥락 미리보기"
            onClick={(e) => {
              e.stopPropagation();
              onPreviewEvidence(task);
            }}
          >
            🔍 미리보기
          </button>
        )}
        {(task.github ?? []).length > 0 && (
          <Why
            about={`${task.title}에 붙은 PR`}
            countsAs="건"
            lines={sortLinks(task.github).map(
              (link) =>
                `${link.confirmed ? '확정' : '추정'} · ${describePull(link)}` +
                (link.why ? ` — ${link.why}` : ''),
            )}
          />
        )}
      </div>
    </article>
  );
}

export default function Kanban() {
  const params = useParams();
  const projectId = Number(params['projectId']);
  const board = useTasks(projectId);
  /* 못 불러왔으면 **무슨 일이 있었는지** 말합니다. 문구는 한 벌
     (`describeLoadFailure`)에서 옵니다 — 화면마다 지으면 갈라집니다. */
  const cannotLoad =
    board.error == null
      ? null
      : describeLoadFailure('칸반', board.error instanceof ApiError ? board.error.status : null);
  const membersQuery = useMembers(projectId);
  const { createTask, patchTask, setAssignees, deleteTask } = useTaskMutations(projectId);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [selectedAssignee, setSelectedAssignee] = useState<number | null>(null);

  // 새 업무 만들기 모달
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState(1);
  const [newStartDate, setNewStartDate] = useState('');
  const [newDeadline, setNewDeadline] = useState('');
  const [newAssignees, setNewAssignees] = useState<number[]>([]);

  // 업무 수정 모달
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [previewEvidenceTask, setPreviewEvidenceTask] = useState<Task | null>(null);
  const [editStartDate, setEditStartDate] = useState('');
  const [editDeadline, setEditDeadline] = useState('');
  const [editBlockedBy, setEditBlockedBy] = useState<number[]>([]);

  const statuses = board.data?.statuses ?? [];
  const tasks = board.data?.tasks ?? [];
  // ⚠️ **아직 못 받은 것과 정말 0 인 것은 다릅니다.** 위의 `?? []` 때문에
  //    불러오는 중에도 못 받았을 때도 빈 배열이 되고, 그대로 세면 머리말이
  //    `회의에서 0 · PR 연결 0 · 지연 0` 이라고 **단언**합니다 — 바로 아래
  //    사슬은 "빈 칸을 0 으로 그리지 않습니다" 라고 적어 두고 `—` 를
  //    그리는데 머리말이 반대로 말하고 있었습니다(불변식 셋째).
  const known = board.data !== undefined;
  const currentPeople: Person[] = (membersQuery.data ?? []).map((m) => ({
    user_id: m.user_id,
    name: m.name,
  }));
  const formerPeople: Person[] = (board.data?.former_assignees ?? []).map((f) => ({
    user_id: f.user_id,
    name: f.name,
  }));
  const people: Person[] = [
    ...currentPeople,
    ...formerPeople.filter((f) => !currentPeople.some((c) => c.user_id === f.user_id)),
  ];
  const filteredTasks = selectedAssignee !== null
    ? tasks.filter((t) => t.assignee_ids.includes(selectedAssignee))
    : tasks;
  const columns = toColumns(filteredTasks, statuses);
  const s = summarize(tasks, todayInTeamCalendar());

  /* 어느 일이 실패했는지에 따라 **할 말이 다릅니다** — 담당자를 못 바꾼
     것과 업무를 못 지운 것은 다른 사실입니다. 판단·문구는 `@lib`. */
  const failed =
    createTask.error != null
      ? {
          what: '새 업무 만들기',
          status: statusOf(createTask.error),
          detail: detailOf(createTask.error),
        }
      : patchTask.error != null
        ? {
            what: '업무 바꾸기',
            status: statusOf(patchTask.error),
            detail: detailOf(patchTask.error),
          }
        : setAssignees.error != null
          ? {
              what: '담당자 바꾸기',
              status: statusOf(setAssignees.error),
              detail: detailOf(setAssignees.error),
            }
          : deleteTask.error != null
            ? {
                what: '업무 지우기',
                status: statusOf(deleteTask.error),
                detail: detailOf(deleteTask.error),
              }
            : null;

  const move = (task: Task, to: string) => {
    patchTask.mutate({ taskId: task.id, patch: statusPatch(to) });
  };
  const toggleAssignee = (task: Task, userId: number) => {
    setAssignees.mutate({ taskId: task.id, userIds: toggled(task.assignee_ids, userId) });
  };
  const setPriority = (task: Task, priority: number) => {
    patchTask.mutate({ taskId: task.id, patch: { priority } });
  };
  const remove = (task: Task) => {
    if (window.confirm(deleteTaskConfirm(task.title))) deleteTask.mutate(task.id);
  };
  const startEdit = (task: Task) => {
    setEditingTask(task);
    setEditTitle(task.title);
    setEditStartDate(task.start_date ?? '');
    setEditDeadline(task.deadline ?? '');
    setEditBlockedBy(task.blocked_by ?? []);
  };

  const [activeMobileCol, setActiveMobileCol] = useState<string>('todo');

  const handleCreateTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    createTask.mutate(
      {
        title: newTitle.trim(),
        priority: newPriority,
        start_date: newStartDate ? newStartDate : null,
        deadline: newDeadline ? newDeadline : null,
        assignee_ids: newAssignees,
      },
      {
        onSuccess: () => {
          setShowCreateModal(false);
          setNewTitle('');
          setNewPriority(1);
          setNewStartDate('');
          setNewDeadline('');
          setNewAssignees([]);
        },
      }
    );
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask || !editTitle.trim()) return;
    patchTask.mutate(
      {
        taskId: editingTask.id,
        patch: {
          title: editTitle.trim(),
          start_date: editStartDate ? editStartDate : null,
          deadline: editDeadline ? editDeadline : null,
          blocked_by: editBlockedBy,
        },
      },
      {
        onSuccess: () => setEditingTask(null),
      }
    );
  };

  return (
    <AppShell
      title="칸반"
      actions={
        <div className="kboard-actions">
          <div style={{ minWidth: '154px' }}>
            <DiscordSelect
              compact
              ariaLabel="담당자별 필터"
              value={selectedAssignee !== null ? String(selectedAssignee) : ''}
              onChange={(val) => setSelectedAssignee(val ? Number(val) : null)}
              options={[
                { value: '', label: `전체 담당자 (${tasks.length})` },
                ...people.map((p) => {
                  const count = tasks.filter((t) => t.assignee_ids.includes(p.user_id)).length;
                  return {
                    value: String(p.user_id),
                    label: `${p.name} (${count})`,
                  };
                }),
              ]}
            />
          </div>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => setShowCreateModal(true)}
          >
            + 새 업무
          </button>
        </div>
      }
      meta={
        <span className="meta-chips">
          <span className="meta-chip">
            회의 출처 <strong>{countText(known ? s.fromMeetings : null)}</strong>
          </span>
          <span className="meta-chip">
            PR 연결 <strong>{countText(known ? s.withPulls : null)}</strong>
          </span>
          <span className="meta-chip">
            지연 <strong>{countText(known ? s.overdue : null)}</strong>
          </span>
          {/* ⭐ 표식 규칙은 **여기서 한 번만** 말합니다. */}
          <Why
            about="PR 자동 연결"
            lines={[
              'PR 제목이나 본문에 카드의 업무 표식(TASK-n)을 적으면 그 PR이 이 업무에 자동으로 붙습니다.',
              '표식 없이 병합된 PR은 제목이 비슷하면 추정으로 붙고, 카드에 "추정" 으로 표시됩니다.',
            ]}
          />
        </span>
      }
    >
      {cannotLoad === null && tasks.length > 0 && (
        <div className="mobile-col-pills" role="tablist" aria-label="칸반 열 선택">
          {columns.map((c) => (
            <button
              key={c.status}
              type="button"
              role="tab"
              aria-selected={activeMobileCol === c.status}
              className={`mobile-col-pill ${activeMobileCol === c.status ? 'mobile-col-pill--active' : ''}`}
              onClick={() => {
                setActiveMobileCol(c.status);
                const el = document.getElementById(`col-${c.status}`);
                el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
              }}
            >
              <span className="col__dot" data-status={c.status} aria-hidden="true" />
              <span>{c.label}</span>
              <span className="mobile-col-pill__count">{c.tasks.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="board">
        {/* ⚠️ **못 받았는데 빈 칸반을 그리고 있었습니다** (결함 224). 새로
            가입한 사람이 남의 프로젝트 주소를 열면 서버는 403 을 주는데,
            화면은 아무 말 없이 텅 빈 판을 보여 줬습니다 — 「업무가 없는
            팀」 과 구별이 안 됩니다. 설정·기여도는 결함 211 에서 이미
            고쳤고, 여기가 빠져 있었습니다. */}
        {cannotLoad !== null && (
          <div className="empty" style={{ alignSelf: 'flex-start', flex: 1 }}>
            {cannotLoad}
          </div>
        )}
        {cannotLoad === null && board.isSuccess && tasks.length === 0 && (
          <div className="empty" style={{ alignSelf: 'flex-start', flex: 1 }}>
            {/* ⭐ 문장은 `@lib` 한 벌입니다 (결함 313). 레거시가 여기와
                갈라져 「직접 만들 수도 있습니다」라고 말하고 있었습니다. */}
            {emptyBoardLine()}
          </div>
        )}
        {cannotLoad === null &&
          tasks.length > 0 &&
          columns.map((column) => (
            <section
              key={column.status}
              id={`col-${column.status}`}
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
                <span className="col__head-left">
                  <span className="col__dot" data-status={column.status} aria-hidden="true" />
                  <span>{column.label}</span>
                  <span className="col__count">{column.tasks.length}</span>
                </span>
                <button
                  type="button"
                  className="col__add-btn"
                  onClick={() => setShowCreateModal(true)}
                  title={`${column.label}에 새 업무 추가`}
                  aria-label={`${column.label}에 새 업무 추가`}
                >
                  +
                </button>
              </div>
              <div className="col__body">
                {column.tasks.length === 0 ? (
                  <div className="col__empty-drop">
                    카드를 끌어다 놓으세요
                  </div>
                ) : (
                  column.tasks.map((task) => (
                    <Card
                      key={task.id}
                      task={task}
                      statuses={statuses}
                      people={people}
                      onMove={move}
                      onToggleAssignee={toggleAssignee}
                      onPriority={setPriority}
                      onEdit={startEdit}
                      onDelete={remove}
                      onPreviewEvidence={setPreviewEvidenceTask}
                    />
                  ))
                )}
              </div>
            </section>
          ))}
      </div>
      {/* ⛔ **여기만 문구를 따로 짓고 있었습니다** (결함 283).
          무슨 일이 있었든 「바꾸지 못했습니다 — 새로고침한 뒤 다시 해
          보세요」 한 줄이었습니다. `load.ts` 가 그 문구 바로 옆에
          적어 둔 경고가 이것입니다 —

            "다시 시도하세요" 를 아무 데나 붙이지 않습니다. 다시 눌러도
            안 되는 실패(권한·충돌·잘못된 요청)에 그렇게 쓰면, 사람은
            되지 않는 것을 반복하다 제품을 불신하게 됩니다.

          재현했습니다: A 가 카드를 지운 뒤 B 가 그 카드를 옮기면 서버가
          **404** 를 주는데, 화면은 「새로고침한 뒤 다시 해 보세요」라고만
          했습니다. 누가 지웠다는 말은 어디에도 없습니다. 공용 어휘는
          그 자리에서 「대상이 없습니다 — 정하는 사이에 지워졌을 수
          있습니다」라고 말합니다. 화면 넷 중 셋은 진작 그 어휘를 쓰고
          있었고 칸반만 빠져 있었습니다 (실패 ②). */}
      {failed !== null && (
        <div style={{ padding: '0 var(--sp-6) var(--sp-4)' }}>
          <Problem>{describeActionFailure(failed.what, failed.status, failed.detail)}</Problem>
        </div>
      )}

      <Dialog.Root open={showCreateModal} onOpenChange={setShowCreateModal}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-backdrop" />
          <Dialog.Content className="dialog" aria-label="새 업무 추가">
            <Dialog.Title className="sec__title" style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>
              새 업무 추가
            </Dialog.Title>
            <form onSubmit={handleCreateTask} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <span>제목 (필수)</span>
                <input
                  type="text"
                  required
                  className="input"
                  style={{
                    padding: '6px 8px',
                    border: '1px solid var(--c-line)',
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--c-surface)',
                    color: 'var(--c-ink)',
                  }}
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="할 일을 입력하세요"
                />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <span>우선순위</span>
                <DiscordSelect
                  compact
                  ariaLabel="우선순위"
                  value={String(newPriority)}
                  onChange={(val) => setNewPriority(Number(val))}
                  options={[
                    { value: '0', label: '긴급' },
                    { value: '1', label: '보통' },
                    { value: '2', label: '낮음' },
                  ]}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <span>담당자 (복수 선택 가능)</span>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px',
                    padding: '6px 8px',
                    border: '1px solid var(--c-line)',
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--c-surface)',
                  }}
                >
                  {people.map((p) => {
                    const checked = newAssignees.includes(p.user_id);
                    return (
                      <label
                        key={p.user_id}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setNewAssignees((prev) => toggled(prev, p.user_id))}
                        />
                        <span>{labelInList(p, people)}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', flex: 1 }}>
                  <span>시작일</span>
                  <input
                    type="date"
                    className="input"
                    style={{
                      padding: '6px 8px',
                      border: '1px solid var(--c-line)',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--c-surface)',
                      color: 'var(--c-ink)',
                    }}
                    value={newStartDate}
                    onChange={(e) => setNewStartDate(e.target.value)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', flex: 1 }}>
                  <span>마감일</span>
                  <input
                    type="date"
                    className="input"
                    style={{
                      padding: '6px 8px',
                      border: '1px solid var(--c-line)',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--c-surface)',
                      color: 'var(--c-ink)',
                    }}
                    value={newDeadline}
                    onChange={(e) => setNewDeadline(e.target.value)}
                  />
                </label>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                  >
                    취소
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  className="btn btn--primary btn--sm"
                  disabled={createTask.isPending}
                >
                  {createTask.isPending ? '생성 중…' : '만들기'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* 회의 근거 인라인 미리보기 모달 */}
      <Dialog.Root open={previewEvidenceTask !== null} onOpenChange={(open) => { if (!open) setPreviewEvidenceTask(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-backdrop" />
          <Dialog.Content className="dialog" aria-label="회의 근거 미리보기">
            <Dialog.Title className="sec__title" style={{ margin: '0 0 14px', fontSize: '16px', fontWeight: 600 }}>
              📌 회의 근거 및 맥락 미리보기
            </Dialog.Title>
            {previewEvidenceTask && previewEvidenceTask.origin && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ background: 'var(--c-surface-sunken)', padding: '12px', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)' }}>
                  <span className="t12 faint">업무명</span>
                  <p style={{ margin: '4px 0 0 0', fontWeight: 600, fontSize: '14px' }}>
                    {previewEvidenceTask.title}
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="t12 faint">출처 회의</span>
                    <span className="dc-badge dc-badge--ok">승인된 정식 업무</span>
                  </div>
                  <strong style={{ fontSize: '14px' }}>
                    {meetingLabel(previewEvidenceTask.origin.meeting_title, previewEvidenceTask.origin.meeting_id)}
                  </strong>
                  <span className="t12 muted">
                    연계 발화 번호: {previewEvidenceTask.origin.evidence_utterance_ids.map((id) => `#${id}`).join(', ')} ({previewEvidenceTask.origin.evidence_utterance_ids.length}건 근거)
                  </span>
                </div>

                <div style={{ background: 'var(--c-surface)', padding: '12px', borderRadius: 'var(--r-md)', border: '1px solid var(--c-border)' }}>
                  <span className="t12" style={{ color: 'var(--c-evidence)', fontWeight: 600 }}>
                    💡 근거 사슬(Provenance Chain) 안내
                  </span>
                  <p className="t12 muted" style={{ margin: '6px 0 0 0', lineHeight: 1.5 }}>
                    이 업무는 회의 대화록에서 도출되어 검토자가 승인한 정식 태스크입니다.
                    수정이나 상태 이동은 보드에서 즉시 가능하며, 기여도 산출 시 증빙 데이터로 보호됩니다.
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
                  <Link
                    to={`/meeting/${previewEvidenceTask.origin.meeting_id}/review`}
                    className="btn btn--secondary btn--sm"
                    onClick={() => setPreviewEvidenceTask(null)}
                  >
                    전체 회의록 & 음성 재생 보기 →
                  </Link>
                  <Dialog.Close asChild>
                    <button type="button" className="btn btn--primary btn--sm">
                      닫기
                    </button>
                  </Dialog.Close>
                </div>
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={editingTask !== null} onOpenChange={(open) => { if (!open) setEditingTask(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-backdrop" />
          <Dialog.Content className="dialog" aria-label="업무 수정">
            <Dialog.Title className="sec__title" style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600 }}>
              업무 수정
            </Dialog.Title>
            <form onSubmit={handleSaveEdit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                <span>제목</span>
                <input
                  type="text"
                  required
                  className="input"
                  style={{
                    padding: '6px 8px',
                    border: '1px solid var(--c-line)',
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--c-surface)',
                    color: 'var(--c-ink)',
                  }}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', flex: 1 }}>
                  <span>시작일</span>
                  <input
                    type="date"
                    className="input"
                    style={{
                      padding: '6px 8px',
                      border: '1px solid var(--c-line)',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--c-surface)',
                      color: 'var(--c-ink)',
                    }}
                    value={editStartDate}
                    onChange={(e) => setEditStartDate(e.target.value)}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', flex: 1 }}>
                  <span>마감일</span>
                  <input
                    type="date"
                    className="input"
                    style={{
                      padding: '6px 8px',
                      border: '1px solid var(--c-line)',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--c-surface)',
                      color: 'var(--c-ink)',
                    }}
                    value={editDeadline}
                    onChange={(e) => setEditDeadline(e.target.value)}
                  />
                </label>
              </div>
              {tasks.filter((t) => t.id !== editingTask?.id).length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' }}>
                  <span>선행 업무 (이 업무보다 먼저 끝나야 하는 일)</span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                      maxHeight: '120px',
                      overflowY: 'auto',
                      padding: '6px 8px',
                      border: '1px solid var(--c-line)',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--c-surface)',
                    }}
                  >
                    {tasks
                      .filter((t) => t.id !== editingTask?.id)
                      .map((t) => {
                        const checked = editBlockedBy.includes(t.id);
                        return (
                          <label
                            key={t.id}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setEditBlockedBy((prev) => toggled(prev, t.id))}
                            />
                            <span>
                              #{t.id} {t.title}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '8px' }}>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                  >
                    취소
                  </button>
                </Dialog.Close>
                <button
                  type="submit"
                  className="btn btn--primary btn--sm"
                  disabled={patchTask.isPending}
                >
                  {patchTask.isPending ? '저장 중…' : '저장'}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </AppShell>
  );
}
