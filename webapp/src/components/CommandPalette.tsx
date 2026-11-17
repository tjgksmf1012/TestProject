import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { appRailHref } from '@lib/nav/rail.ts';
import { appSecondaryHref } from '@lib/nav/links.ts';
import {
  appHrefForHit,
  blockedReason,
  canSearch,
  describeKind,
  excerpt,
  groupByKind,
  mayHaveMore,
} from '@lib/search/view.ts';
import {
  useChatMessageSearch,
  useProjectSearch,
  useUnreadNotifications,
} from '../api/hooks.ts';

interface CommandPaletteProps {
  open: boolean;
  projectId?: number;
  onClose: () => void;
  onOpenCall: () => void;
  onOpenSettings: (tab: 'voice' | 'account' | 'display') => void;
}

interface PaletteItem {
  id: string;
  category: string;
  label: string;
  detail?: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/** `Ctrl+K` 전역 빠른 이동·실행 및 프로젝트 통합 검색 팔레트. */
export function CommandPalette({
  open,
  projectId,
  onClose,
  onOpenCall,
  onOpenSettings,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const suppressRestoreRef = useRef(false);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const { data: unread } = useUnreadNotifications(projectId);
  const unreadCount = unread?.unread_count ?? 0;

  useEffect(() => {
    if (!open) {
      setQuery('');
      setDebouncedQuery('');
      setActiveIndex(0);
      return;
    }
    suppressRestoreRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 180);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  const searchQuery = useProjectSearch(projectId, debouncedQuery);
  const chatSearchQuery = useChatMessageSearch(projectId, debouncedQuery);
  const hits = useMemo(
    () => (searchQuery.data ?? []).filter((h) => h.kind !== 'github'),
    [searchQuery.data],
  );
  const chatHits = useMemo(() => chatSearchQuery.data ?? [], [chatSearchQuery.data]);

  const commands = useMemo<PaletteItem[]>(() => {
    const closeAnd = (fn: () => void, suppressRestore = true) => {
      suppressRestoreRef.current = suppressRestore;
      onClose();
      fn();
    };

    const projectCommands: PaletteItem[] =
      projectId !== undefined
        ? [
            {
              id: 'call',
              category: '회의',
              label: '음성 회의실 열기',
              detail: '개별 동의 확인 후 통화·녹음 화면을 엽니다',
              hint: '모달',
              run: () => closeAnd(onOpenCall),
            },
            {
              id: 'kanban',
              category: '업무',
              label: '칸반 보드',
              detail: '업무 상태와 회의 근거를 확인합니다',
              run: () => closeAnd(() => navigate(appRailHref('kanban', projectId))),
            },
            {
              id: 'contributions',
              category: '기여도',
              label: '기여도 분석 및 팀 합의 확정',
              detail: '기여 구간·신뢰도·조정 사유를 확인합니다',
              run: () => closeAnd(() => navigate(appRailHref('contributions', projectId))),
            },
            {
              id: 'project-settings',
              category: '설정',
              label: '프로젝트 설정 (역할·내 정보·팀원)',
              run: () => closeAnd(() => navigate(appRailHref('project', projectId))),
            },
            {
              id: 'notifications',
              category: '알림',
              label: unreadCount > 0 ? `알림 함 (미확인 ${unreadCount}건)` : '알림 함',
              detail: '미확인 멘션·배정·마감 알림을 확인하고 읽음 처리합니다',
              run: () =>
                closeAnd(() => navigate(appSecondaryHref('notifications', projectId))),
            },
            {
              id: 'chat',
              category: '채팅',
              label: '프로젝트 채팅',
              detail: '채널별 실시간 팀 대화, @멘션, 메시지에서 바로 칸반 업무 등록',
              run: () =>
                closeAnd(() => navigate(appSecondaryHref('chat', projectId))),
            },
            {
              id: 'reports',
              category: '보고서',
              label: '회의록 · 제출용 기여도 보고서',
              detail: '회의록·주간·최종 보고서 조회, 마크다운(.md) 저장 및 인쇄/PDF 내보내기',
              run: () =>
                closeAnd(() => navigate(appSecondaryHref('reports', projectId))),
            },
          ]
        : [];

    const generalCommands: PaletteItem[] = [
      {
        id: 'home',
        category: '탐색',
        label: '프로젝트 홈 대시보드',
        run: () =>
          closeAnd(() =>
            navigate(projectId !== undefined ? appRailHref('home', projectId) : '/'),
          ),
      },
      {
        id: 'voice-settings',
        category: '환경 설정',
        label: '마이크 점검 및 장치 설정',
        hint: '모달',
        run: () => closeAnd(() => onOpenSettings('voice')),
      },
      {
        id: 'acct-settings',
        category: '환경 설정',
        label: '계정 이름·비밀번호 설정',
        hint: '모달',
        run: () => closeAnd(() => onOpenSettings('account')),
      },
      {
        id: 'display-settings',
        category: '환경 설정',
        label: '화면 테마 (밝은/어두운 화면)',
        hint: '모달',
        run: () => closeAnd(() => onOpenSettings('display')),
      },
    ];

    const needle = query.trim().toLowerCase();
    const all = [...projectCommands, ...generalCommands];
    if (!needle) return all;
    return all.filter(
      (cmd) =>
        cmd.label.toLowerCase().includes(needle) ||
        cmd.category.toLowerCase().includes(needle) ||
        (cmd.detail?.toLowerCase().includes(needle) ?? false),
    );
  }, [navigate, onClose, onOpenCall, onOpenSettings, projectId, query, unreadCount]);

  const searchItems = useMemo<PaletteItem[]>(() => {
    if (projectId === undefined || !canSearch(debouncedQuery, null)) return [];
    const base = hits.map((hit, index) => {
      const target = appHrefForHit(hit, projectId);
      const snippet = hit.body ? excerpt(hit.body, debouncedQuery, 68) : '';
      const detailParts = [hit.who, snippet, hit.status].filter(Boolean);
      const disabled = target === null;
      return {
        id: `hit-${hit.kind}-${hit.task_id ?? hit.meeting_id ?? index}-${index}`,
        category: describeKind(hit.kind),
        label: hit.title || snippet || describeKind(hit.kind),
        detail: detailParts.join(' · '),
        hint: disabled
          ? '연결 없음'
          : hit.kind === 'utterance'
            ? '검토로 이동'
            : hit.kind === 'meeting'
              ? '로비로 이동'
              : '이동',
        disabled,
        run: () => {
          if (target === null) return;
          suppressRestoreRef.current = true;
          onClose();
          navigate(target);
        },
      };
    });
    const chatResults = chatHits.slice(0, 12).map((hit) => ({
      id: `chat-hit-${hit.message.id}`,
      category: '채팅',
      label: `#${hit.channel_name} · ${hit.message.author_name}`,
      detail: excerpt(hit.message.body, debouncedQuery, 68),
      hint: '채널로 이동',
      run: () => {
        suppressRestoreRef.current = true;
        onClose();
        navigate(`/project/${projectId}/chat?channel=${hit.channel_id}`);
      },
    }));
    return [...base, ...chatResults];
  }, [chatHits, debouncedQuery, hits, navigate, onClose, projectId]);

  const items = useMemo(() => [...commands, ...searchItems], [commands, searchItems]);
  const truncatedKinds = useMemo(
    () =>
      groupByKind(hits)
        .filter((g) => mayHaveMore(g.hits.length))
        .map((g) => describeKind(g.kind)),
    [hits],
  );

  useEffect(() => {
    setActiveIndex(0);
  }, [query, hits.length]);

  useEffect(() => {
    const activeEl = itemRefs.current[activeIndex];
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const moveIndex = (delta: number) => {
    if (items.length === 0) return;
    setActiveIndex((prev) => (prev + delta + items.length) % items.length);
  };

  const searchHint = projectId !== undefined ? blockedReason(query, null) : null;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dc-modal-backdrop dc-modal-backdrop--portal" />
        <Dialog.Content
          className="dc-cmdk dc-cmdk--portal"
          onOpenAutoFocus={(event) => {
            openerRef.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            event.preventDefault();
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!suppressRestoreRef.current && openerRef.current?.isConnected) {
              openerRef.current.focus();
            }
          }}
        >
          <Dialog.Title className="visually-hidden">빠른 명령 및 통합 검색</Dialog.Title>
          <Dialog.Description className="visually-hidden">
            화면을 이동하거나 현재 프로젝트의 업무, 회의, 발언을 검색합니다.
          </Dialog.Description>
          <input
            ref={inputRef}
            type="search"
            className="dc-cmdk__input"
            placeholder={
              projectId !== undefined
                ? '화면 이동 또는 업무·회의·발언 검색… (2글자 이상)'
                : '화면 이동 또는 빠른 실행 검색…'
            }
            aria-label="검색어 입력"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveIndex(1);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveIndex(-1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setActiveIndex(0);
              } else if (event.key === 'End' && items.length > 0) {
                event.preventDefault();
                setActiveIndex(items.length - 1);
              } else if (event.key === 'Enter' && items[activeIndex]) {
                event.preventDefault();
                if (!items[activeIndex].disabled) items[activeIndex].run();
              }
            }}
          />

          <div className="dc-cmdk__list" role="listbox" aria-label="실행 및 검색 결과">
            {commands.length > 0 && (
              <div className="dc-cmdk__section">빠른 이동 · 실행</div>
            )}
            {commands.map((cmd, idx) => (
              <button
                key={cmd.id}
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                type="button"
                role="option"
                aria-selected={idx === activeIndex}
                className={`dc-cmdk__item ${idx === activeIndex ? 'dc-cmdk__item--active' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={cmd.run}
              >
                <div className="dc-cmdk__main">
                  <span className="dc-badge">{cmd.category}</span>
                  <div className="dc-cmdk__text">
                    <span className="dc-cmdk__title">{cmd.label}</span>
                    {cmd.detail && <span className="dc-cmdk__detail">{cmd.detail}</span>}
                  </div>
                </div>
                {cmd.hint && <kbd className="dc-kbd">{cmd.hint}</kbd>}
              </button>
            ))}

            {projectId !== undefined && (searchHint !== null || canSearch(debouncedQuery, null)) && (
              <div className="dc-cmdk__section">프로젝트 검색 결과</div>
            )}

            {searchHint !== null && (
              <div className="dc-cmdk__status" role="status">
                {searchHint}
              </div>
            )}

            {canSearch(debouncedQuery, null) && searchQuery.isFetching && (
              <div className="dc-cmdk__status" role="status">
                프로젝트에서 찾는 중입니다…
              </div>
            )}

            {canSearch(debouncedQuery, null) && searchQuery.isError && (
              <div className="dc-cmdk__status dc-cmdk__status--error" role="alert">
                검색 결과를 불러오지 못했습니다.
              </div>
            )}

            {searchItems.map((item, hitOffset) => {
              const idx = commands.length + hitOffset;
              return (
                <button
                  key={item.id}
                  ref={(el) => {
                    itemRefs.current[idx] = el;
                  }}
                  type="button"
                  role="option"
                  aria-selected={idx === activeIndex}
                  aria-disabled={item.disabled}
                  className={`dc-cmdk__item ${idx === activeIndex ? 'dc-cmdk__item--active' : ''}`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={item.run}
                >
                  <div className="dc-cmdk__main">
                    <span className="dc-badge dc-badge--ok">{item.category}</span>
                    <div className="dc-cmdk__text">
                      <span className="dc-cmdk__title">{item.label}</span>
                      {item.detail && <span className="dc-cmdk__detail">{item.detail}</span>}
                    </div>
                  </div>
                  {item.hint && <kbd className="dc-kbd">{item.hint}</kbd>}
                </button>
              );
            })}

            {truncatedKinds.length > 0 && (
              <div className="dc-cmdk__status">
                {truncatedKinds.join('·')} 결과는 최대 건수에 도달했습니다 — 검색어를 더 구체적으로 입력해 좁혀 보세요.
              </div>
            )}

            {items.length === 0 && !searchQuery.isFetching && searchHint === null && (
              <div className="dc-cmdk__status">일치하는 기능이나 검색 결과가 없습니다.</div>
            )}
          </div>

          <div className="dc-cmdk__foot">
            <span>↑↓ 이동 · Enter 실행 · Esc 닫기</span>
            {projectId === undefined && <span>프로젝트에 들어가면 업무·회의 검색이 열립니다</span>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
