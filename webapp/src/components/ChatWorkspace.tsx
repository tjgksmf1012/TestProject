import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { api, ApiError } from '../api/client.ts';
import {
  useChatMutations,
  useMe,
  useMembers,
  useTaskMutations,
  type ChatMessageSearchHit,
} from '../api/hooks.ts';
import { DatePicker } from './DatePicker.tsx';
import { Problem } from './Problem.tsx';
import {
  canEdit,
  canSend,
  carriesMessages,
  channelTitle,
  continuesRun,
  dayGroups,
  DELETED_TEXT,
  describeEmptyChannel,
  describeTime,
  EDITED_MARK,
  hasOlderMessages,
  MAX_BODY,
  mentionSegments,
  MESSAGE_PAGE,
  offerableReactions,
  olderCursor,
  prependOlder,
  quoteFor,
  reactionAriaLabel,
  reactionIcon,
  scrollIntentFor,
  sendBlockedReason,
  streamClosedNote,
  voiceChannelNote,
  type ChatChannel,
  type ChatMessage,
  type ReactionChoice,
} from '@lib/chat/view.ts';
import { labelInList } from '@lib/people/labels.ts';
import { blockedReason, canSearch, excerpt } from '@lib/search/view.ts';
import { describeActionFailure, describeLoadFailure } from '@lib/ui/load.ts';

interface ChannelKindChoice {
  kind: string;
  label: string;
}

type StreamEvent =
  | { type: 'message.created'; message: ChatMessage }
  | { type: 'message.updated'; message: ChatMessage }
  | { type: 'message.deleted'; message_id: number }
  | {
      type: 'reaction.changed';
      message_id: number;
      reactions: ChatMessage['reactions'];
      actor_id: number;
      actor_reaction: string | null;
    };

function statusOf(error: unknown): number | null {
  return error instanceof ApiError ? error.status : null;
}

function detailOf(error: unknown): string | null {
  return error instanceof ApiError ? error.detail : null;
}

function ReactionGlyph({ mark }: { mark: string }) {
  const kind = reactionIcon(mark);
  if (kind === 'check') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M3.2 8.3l3.1 3.1 6.5-6.6"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'thumb') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M5.5 7.2V13H3.3V7.2h2.2zm1.1 5.8h4.6c.6 0 1.1-.4 1.2-1l.8-4c.1-.7-.4-1.3-1.1-1.3H9.2l.4-2.3c.1-.5-.2-1-.7-1.1l-.6-.1L5.8 7v6h.8z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (kind === 'ask') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M6.5 6.3a1.6 1.6 0 1 1 2.2 1.5c-.5.2-.7.5-.7 1v.3"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.3" r="0.75" fill="currentColor" />
      </svg>
    );
  }
  if (kind === 'heart') {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 13.2s-5-3.1-5-6.6A2.7 2.7 0 0 1 8 5.1a2.7 2.7 0 0 1 5 1.5c0 3.5-5 6.6-5 6.6z"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return null;
}

export interface ChatWorkspaceProps {
  projectId: number;
  embedded?: boolean;
  initialChannelId?: number;
  showCreateChannel?: boolean;
  onShowCreateChannelChange?: (open: boolean) => void;
  showSearch?: boolean;
  onShowSearchChange?: (open: boolean) => void;
  onActiveChannelChange?: (channel: ChatChannel | null) => void;
  onChannelUrlSync?: (channelId: number) => void;
  onNavigate?: (to: string) => void;
}

export function ChatWorkspace({
  projectId,
  embedded = false,
  initialChannelId = 0,
  showCreateChannel: controlledCreate,
  onShowCreateChannelChange,
  showSearch: controlledSearch,
  onShowSearchChange,
  onActiveChannelChange,
  onChannelUrlSync,
  onNavigate,
}: ChatWorkspaceProps) {
  const go = useCallback(
    (to: string) => {
      if (onNavigate) onNavigate(to);
      else window.location.assign(`/app${to}`);
    },
    [onNavigate],
  );
  const handleLinkClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>, to: string) => {
      if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onNavigate(to);
    },
    [onNavigate],
  );
  const { data: me } = useMe();
  const meId = me?.user_id ?? null;
  const membersQuery = useMembers(projectId);
  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const memberNames = useMemo(() => members.map((m) => m.name), [members]);
  const chatMutations = useChatMutations(projectId);
  const taskMutations = useTaskMutations(projectId);

  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reactionChoices, setReactionChoices] = useState<ReactionChoice[]>([]);
  const [channelKinds, setChannelKinds] = useState<ChannelKindChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [streamWarning, setStreamWarning] = useState<string | null>(null);

  // 작성·답글·수정·멘션 상태
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ChatMessage | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [openReactionPickerFor, setOpenReactionPickerFor] = useState<number | null>(null);
  const [showMentionBar, setShowMentionBar] = useState(false);

  // 채팅 → 칸반 업무 변환 인라인 모달/폼 상태
  const [promotingMsg, setPromotingMsg] = useState<ChatMessage | null>(null);
  const [promoteTitle, setPromoteTitle] = useState('');
  const [promoteStatus, setPromoteStatus] = useState<'todo' | 'in_progress'>('todo');
  const [promoteDeadline, setPromoteDeadline] = useState('');
  const [promoteAssignees, setPromoteAssignees] = useState<number[]>([]);
  const [promoting, setPromoting] = useState(false);
  const [promotedLinks, setPromotedLinks] = useState<Record<number, { id: number; title: string }>>({});

  // 채널 추가 / 이름 수정 상태
  const [localCreate, setLocalCreate] = useState(false);
  const showCreateChannel = controlledCreate ?? localCreate;
  const setShowCreateChannel = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === 'function' ? next(showCreateChannel) : next;
      if (onShowCreateChannelChange) onShowCreateChannelChange(value);
      else setLocalCreate(value);
    },
    [onShowCreateChannelChange, showCreateChannel],
  );
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelKind, setNewChannelKind] = useState('text');
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [renamingChannelId, setRenamingChannelId] = useState<number | null>(null);
  const [renameChannelDraft, setRenameChannelDraft] = useState('');

  // 대화 검색 상태 (본문 상단에 깔끔하게 열립니다)
  const [localSearch, setLocalSearch] = useState(false);
  const showSearch = controlledSearch ?? localSearch;
  const setShowSearch = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      const value = typeof next === 'function' ? next(showSearch) : next;
      if (onShowSearchChange) onShowSearchChange(value);
      else setLocalSearch(value);
    },
    [onShowSearchChange, showSearch],
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<ChatMessageSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [creatingVoiceMeeting, setCreatingVoiceMeeting] = useState(false);

  const sendReasonId = useId();
  const searchReasonId = useId();
  const createChannelReasonId = useId();

  const streamBoxRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const prevMessagesRef = useRef<readonly ChatMessage[]>([]);

  const activeChannel = useMemo(
    () => channels.find((c) => c.id === openId) ?? null,
    [channels, openId],
  );

  useEffect(() => {
    onActiveChannelChange?.(activeChannel);
  }, [activeChannel, onActiveChannelChange]);

  const loadChannelsAndVocab = useCallback(async () => {
    if (!Number.isFinite(projectId) || projectId <= 0) return;
    setLoading(true);
    setLoadFailed(null);
    try {
      const [chList, reactions, kinds] = await Promise.all([
        api.get<ChatChannel[]>(`/api/projects/${projectId}/channels`),
        api.get<ReactionChoice[]>('/api/chat/reactions').catch(() => []),
        api.get<ChannelKindChoice[]>('/api/chat/channel-kinds').catch(() => [
          { kind: 'text', label: '텍스트 채널' },
          { kind: 'voice', label: '음성 채널' },
        ]),
      ]);
      setChannels(chList);
      setReactionChoices(reactions);
      setChannelKinds(kinds);
      if (kinds.length > 0) setNewChannelKind(kinds[0]!.kind);

      const preferred =
        (initialChannelId > 0 ? chList.find((c) => c.id === initialChannelId) : undefined) ??
        chList.find((c) => carriesMessages(c)) ??
        chList[0] ??
        null;
      setOpenId(preferred?.id ?? null);
    } catch (err) {
      setLoadFailed(describeLoadFailure('채널 목록', statusOf(err)));
    } finally {
      setLoading(false);
    }
  }, [projectId, initialChannelId]);

  useEffect(() => {
    void loadChannelsAndVocab();
  }, [loadChannelsAndVocab]);

  useEffect(() => {
    if (initialChannelId > 0 && channels.some((c) => c.id === initialChannelId)) {
      setOpenId(initialChannelId);
    }
  }, [initialChannelId, channels]);

  const loadChannelMessages = useCallback(async (channel: ChatChannel | null) => {
    setStreamWarning(null);
    setProblem(null);
    setReplyTarget(null);
    setEditingId(null);
    setPromotingMsg(null);
    setOpenReactionPickerFor(null);
    if (channel === null || !carriesMessages(channel)) {
      setMessages([]);
      setHasOlder(false);
      return;
    }
    try {
      const rows = await api.get<ChatMessage[]>(
        `/api/channels/${channel.id}/messages?limit=${MESSAGE_PAGE}`,
      );
      setMessages(rows);
      setHasOlder(hasOlderMessages(rows.length));
    } catch (err) {
      setProblem(describeActionFailure('대화 내역 불러오기', statusOf(err), detailOf(err)));
    }
  }, []);

  useEffect(() => {
    void loadChannelMessages(activeChannel);
  }, [activeChannel, loadChannelMessages]);

  useEffect(() => {
    const box = streamBoxRef.current;
    const intent = scrollIntentFor(prevMessagesRef.current, messages);
    prevMessagesRef.current = messages;
    if (box === null) return;
    if (intent === 'to-bottom') {
      box.scrollTop = box.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (activeChannel === null || !carriesMessages(activeChannel)) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/api/channels/${activeChannel.id}/stream`);
    let onPurpose = false;
    let openedOnce = false;

    ws.onopen = () => {
      openedOnce = true;
      setStreamWarning(null);
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(String(ev.data)) as StreamEvent;
        if (data.type === 'message.created') {
          setMessages((prev) =>
            prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message],
          );
        } else if (data.type === 'message.updated') {
          setMessages((prev) =>
            prev.map((m) => (m.id === data.message.id ? data.message : m)),
          );
        } else if (data.type === 'message.deleted') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === data.message_id ? { ...m, deleted: true, body: '' } : m,
            ),
          );
        } else if (data.type === 'reaction.changed') {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== data.message_id) return m;
              return {
                ...m,
                reactions: data.reactions,
                my_reaction: data.actor_id === meId ? data.actor_reaction : m.my_reaction,
              };
            }),
          );
        }
      } catch {
        // ignore invalid frames
      }
    };
    ws.onclose = () => {
      if (openedOnce) {
        setStreamWarning(streamClosedNote(onPurpose));
      }
    };

    return () => {
      onPurpose = true;
      ws.close();
    };
  }, [activeChannel, meId]);

  const handleSelectChannel = (channelId: number) => {
    setOpenId(channelId);
    onChannelUrlSync?.(channelId);
  };

  const handleLoadOlder = async () => {
    if (activeChannel === null || loadingOlder) return;
    const cursor = olderCursor(messages);
    if (cursor === null) return;
    const box = streamBoxRef.current;
    const prevScrollHeight = box?.scrollHeight ?? 0;
    const prevScrollTop = box?.scrollTop ?? 0;
    setLoadingOlder(true);
    try {
      const older = await api.get<ChatMessage[]>(
        `/api/channels/${activeChannel.id}/messages?limit=${MESSAGE_PAGE}&before_id=${cursor}`,
      );
      setMessages((prev) => prependOlder(older, prev));
      setHasOlder(hasOlderMessages(older.length));
      requestAnimationFrame(() => {
        if (box !== null) {
          box.scrollTop = prevScrollTop + (box.scrollHeight - prevScrollHeight);
        }
      });
    } catch (err) {
      setProblem(describeActionFailure('이전 대화 불러오기', statusOf(err), detailOf(err)));
    } finally {
      setLoadingOlder(false);
    }
  };

  const insertMention = (name: string) => {
    const needsSpace = draft.length > 0 && !/\s$/.test(draft);
    const prefix = needsSpace ? ' ' : '';
    const next = draft.endsWith('@') ? `${draft}${name} ` : `${draft}${prefix}@${name} `;
    setDraft(next);
    setShowMentionBar(false);
    composerRef.current?.focus();
  };

  const handleSend = async () => {
    if (!canSend(draft, activeChannel) || activeChannel === null || sending) return;
    setSending(true);
    setProblem(null);
    try {
      const created = await chatMutations.sendMessage.mutateAsync({
        channelId: activeChannel.id,
        body: draft.trim(),
        replyToId: replyTarget?.id ?? null,
      });
      setMessages((prev) => (prev.some((m) => m.id === created.id) ? prev : [...prev, created]));
      setDraft('');
      setReplyTarget(null);
      setShowMentionBar(false);
      composerRef.current?.focus();
    } catch (err) {
      setProblem(describeActionFailure('메시지 보내기', statusOf(err), detailOf(err)));
    } finally {
      setSending(false);
    }
  };

  const handleSaveEdit = async (messageId: number) => {
    const trimmed = editDraft.trim();
    if (trimmed === '' || trimmed.length > MAX_BODY) return;
    setProblem(null);
    try {
      const updated = await chatMutations.editMessage.mutateAsync({
        messageId,
        body: trimmed,
      });
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      setEditingId(null);
      setEditDraft('');
    } catch (err) {
      setProblem(describeActionFailure('메시지 고치기', statusOf(err), detailOf(err)));
    }
  };

  const handleDeleteMessage = async (messageId: number) => {
    setProblem(null);
    try {
      await chatMutations.deleteMessage.mutateAsync(messageId);
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, deleted: true, body: '' } : m)),
      );
    } catch (err) {
      setProblem(describeActionFailure('메시지 지우기', statusOf(err), detailOf(err)));
    }
  };

  const handleToggleReaction = async (message: ChatMessage, mark: string) => {
    setProblem(null);
    if (message.my_reaction === mark) {
      try {
        await chatMutations.removeReaction.mutateAsync(message.id);
      } catch (err) {
        setProblem(describeActionFailure('반응 남기기', statusOf(err), detailOf(err)));
        return;
      }
    } else {
      try {
        await chatMutations.setReaction.mutateAsync({ messageId: message.id, mark });
      } catch (err) {
        setProblem(describeActionFailure('반응 남기기', statusOf(err), detailOf(err)));
        return;
      }
    }
    if (activeChannel !== null) {
      try {
        const refreshed = await api.get<ChatMessage[]>(
          `/api/channels/${activeChannel.id}/messages?limit=${Math.max(MESSAGE_PAGE, messages.length)}`,
        );
        setMessages(refreshed);
      } catch {
        // leave current list if background refresh fails
      }
    }
    setOpenReactionPickerFor(null);
  };

  const quickCreateChannel = async (name: string, kind = 'text') => {
    const trimmed = name.trim().replace(/^#+/, '');
    if (trimmed === '' || creatingChannel) return;
    setCreatingChannel(true);
    setProblem(null);
    try {
      const created = await chatMutations.createChannel.mutateAsync({
        name: trimmed,
        kind,
      });
      const updated = await api.get<ChatChannel[]>(`/api/projects/${projectId}/channels`);
      setChannels(updated);
      setNewChannelName('');
      setShowCreateChannel(false);
      handleSelectChannel(created.id);
    } catch (err) {
      setProblem(describeActionFailure('채널 만들기', statusOf(err), detailOf(err)));
    } finally {
      setCreatingChannel(false);
    }
  };

  const handleRenameChannel = async (channelId: number) => {
    const trimmed = renameChannelDraft.trim().replace(/^#+/, '');
    if (trimmed === '') return;
    setProblem(null);
    try {
      await chatMutations.renameChannel.mutateAsync({ channelId, name: trimmed });
      const updated = await api.get<ChatChannel[]>(`/api/projects/${projectId}/channels`);
      setChannels(updated);
      setRenamingChannelId(null);
      setRenameChannelDraft('');
    } catch (err) {
      setProblem(describeActionFailure('채널 이름 바꾸기', statusOf(err), detailOf(err)));
    }
  };

  const handleArchiveChannel = async (channel: ChatChannel) => {
    if (channels.length <= 1) return;
    if (!window.confirm(`${channelTitle(channel)} 채널을 목록에서 지울까요? 기존 대화 기록은 보존됩니다.`)) {
      return;
    }
    setProblem(null);
    try {
      await chatMutations.archiveChannel.mutateAsync(channel.id);
      const updated = await api.get<ChatChannel[]>(`/api/projects/${projectId}/channels`);
      setChannels(updated);
      if (openId === channel.id) {
        const fallback = updated.find((c) => carriesMessages(c)) ?? updated[0] ?? null;
        setOpenId(fallback?.id ?? null);
      }
    } catch (err) {
      setProblem(describeActionFailure('채널 지우기', statusOf(err), detailOf(err)));
    }
  };

  const handleMoveChannel = async (index: number, delta: -1 | 1) => {
    const targetIndex = index + delta;
    if (targetIndex < 0 || targetIndex >= channels.length) return;
    const reordered = [...channels];
    const [picked] = reordered.splice(index, 1);
    if (picked === undefined) return;
    reordered.splice(targetIndex, 0, picked);
    setChannels(reordered);
    try {
      await chatMutations.reorderChannels.mutateAsync(reordered.map((c) => c.id));
    } catch (err) {
      setProblem(describeActionFailure('채널 순서 바꾸기', statusOf(err), detailOf(err)));
    }
  };

  const handleSearch = async () => {
    if (!canSearch(searchQuery, null) || searching) return;
    setSearching(true);
    setProblem(null);
    try {
      const hits = await api.get<ChatMessageSearchHit[]>(
        `/api/projects/${projectId}/messages/search?q=${encodeURIComponent(searchQuery.trim())}`,
      );
      setSearchHits(hits);
    } catch (err) {
      setProblem(describeActionFailure('대화 찾기', statusOf(err), detailOf(err)));
    } finally {
      setSearching(false);
    }
  };

  const handleStartVoiceMeeting = async (channel: ChatChannel) => {
    if (creatingVoiceMeeting) return;
    setCreatingVoiceMeeting(true);
    setProblem(null);
    try {
      const created = await chatMutations.startVoiceMeeting.mutateAsync(
        `${channel.name} 회의`,
      );
      const targetMeetingId = created.meeting_id ?? created.id;
      go(`/meeting/${targetMeetingId}/lobby`);
    } catch (err) {
      setProblem(describeActionFailure('새 회의 열기', statusOf(err), detailOf(err)));
    } finally {
      setCreatingVoiceMeeting(false);
    }
  };

  const startPromoteToTask = (msg: ChatMessage) => {
    const cleanTitle = msg.body
      .replace(/@\S+\s*/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const mentionedIds = members
      .filter((m) => msg.mentions.includes(m.name))
      .map((m) => m.user_id);
    setPromotingMsg(msg);
    setPromoteTitle(cleanTitle || msg.body.slice(0, 60));
    setPromoteStatus('todo');
    setPromoteDeadline('');
    setPromoteAssignees(mentionedIds);
  };

  const handlePromoteTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promotingMsg || !promoteTitle.trim() || promoting) return;
    setPromoting(true);
    setProblem(null);
    try {
      const created = await taskMutations.createTask.mutateAsync({
        title: promoteTitle.trim(),
        status: promoteStatus,
        priority: 1,
        deadline: promoteDeadline ? promoteDeadline : null,
        assignee_ids: promoteAssignees,
      });
      setPromotedLinks((prev) => ({
        ...prev,
        [promotingMsg.id]: { id: created.id, title: created.title },
      }));
      setPromotingMsg(null);
    } catch (err) {
      setProblem(describeActionFailure('채팅에서 칸반 업무 만들기', statusOf(err), detailOf(err)));
    } finally {
      setPromoting(false);
    }
  };

  const groups = useMemo(() => dayGroups(messages), [messages]);
  const emptyInfo = describeEmptyChannel();
  const sendReason =
    sendBlockedReason(draft, activeChannel) ??
    (draft.trim() === '' ? '보낼 내용을 입력해 주세요.' : null);
  const sendAllowed = canSend(draft, activeChannel);
  const searchAllowed = canSearch(searchQuery, null);
  const searchReason =
    blockedReason(searchQuery, null) ??
    (!searchAllowed ? '두 글자 이상 입력해 주세요.' : null);
  const createChannelBlocked = newChannelName.trim().replace(/^#+/, '') === '' || creatingChannel;

  return (
    <div className={embedded ? 'tf-chat-wrap tf-chat-wrap--embedded' : 'tf-chat-wrap'}>
      {embedded && (
        <div className="tf-chat-embedded-bar">
          <span className="t12 muted">
            {activeChannel ? `${channelTitle(activeChannel)} · 실시간 동기화됨` : '프로젝트 채팅'}
          </span>
          <div className="tf-row-actions">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              aria-expanded={showSearch}
              onClick={() => setShowSearch((v) => !v)}
            >
              {showSearch ? '검색 닫기' : '대화 찾기'}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              aria-expanded={showCreateChannel}
              onClick={() => setShowCreateChannel((v) => !v)}
            >
              {showCreateChannel ? '채널 추가 닫기' : '+ 채널 만들기'}
            </button>
          </div>
        </div>
      )}

      {loadFailed !== null && (
        <Problem>
          <span>{loadFailed}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void loadChannelsAndVocab()}
          >
            다시 시도
          </button>
        </Problem>
      )}
      {problem !== null && (
        <Problem>
          <span>{problem}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setProblem(null)}
          >
            닫기
          </button>
        </Problem>
      )}
      {streamWarning !== null && (
        <div className="tf-chat-banner" role="status">
          <span>{streamWarning}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void loadChannelMessages(activeChannel)}
          >
            다시 불러오기
          </button>
        </div>
      )}

      {loading && loadFailed === null && (
        <div className="tf-loading-card" role="status">
          채널과 대화를 불러오는 중입니다…
        </div>
      )}

      {!loading && loadFailed === null && (
        <div className={`tf-chat-layout${embedded ? ' tf-chat-layout--embedded' : ''}`}>
          {/* 왼쪽: 채널 목록 */}
          <aside className="tf-chat-sidebar" aria-label="채널 목록">
            <div className="tf-chat-sidebar__head">
              <span className="tf-chat-sidebar__title">채널 ({channels.length})</span>
              <span className="tf-chat-sidebar__note">일상 대화는 점수에 반영되지 않습니다</span>
            </div>

            {showCreateChannel && (
              <div className="tf-chat-box" role="region" aria-label="새 채널 만들기">
                <label className="field__label" htmlFor="tf-chat-new-name">
                  채널 이름
                </label>
                <input
                  id="tf-chat-new-name"
                  type="text"
                  className="input"
                  placeholder="예: 디자인-논의"
                  value={newChannelName}
                  onChange={(e) => setNewChannelName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void quickCreateChannel(newChannelName, newChannelKind);
                    }
                  }}
                />
                {channelKinds.length > 0 && (
                  <div className="tf-chat-kind-row" role="radiogroup" aria-label="채널 종류">
                    {channelKinds.map((k) => (
                      <label key={k.kind} className="tf-chat-kind-opt">
                        <input
                          type="radio"
                          name="tf-chat-kind"
                          checked={newChannelKind === k.kind}
                          onChange={() => setNewChannelKind(k.kind)}
                        />
                        <span>{k.label}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="tf-row-actions">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    aria-disabled={createChannelBlocked}
                    aria-describedby={createChannelBlocked ? createChannelReasonId : undefined}
                    onClick={() => void quickCreateChannel(newChannelName, newChannelKind)}
                  >
                    {creatingChannel ? '만드는 중…' : '만들기'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setShowCreateChannel(false);
                      setNewChannelName('');
                    }}
                  >
                    취소
                  </button>
                </div>
                {createChannelBlocked && (
                  <span id={createChannelReasonId} className="tf-muted-note">
                    채널 이름을 입력하면 만들 수 있습니다.
                  </span>
                )}
              </div>
            )}

            <ul className="tf-chat-channel-list">
              {channels.map((ch, idx) => {
                const isSelected = ch.id === openId;
                const isRenaming = renamingChannelId === ch.id;
                return (
                  <li
                    key={ch.id}
                    className={`tf-chat-channel-item ${isSelected ? 'tf-chat-channel-item--active' : ''}`}
                  >
                    {isRenaming ? (
                      <div className="tf-chat-rename-row">
                        <input
                          type="text"
                          className="input"
                          aria-label="새 채널 이름"
                          value={renameChannelDraft}
                          onChange={(e) => setRenameChannelDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void handleRenameChannel(ch.id);
                            } else if (e.key === 'Escape') {
                              setRenamingChannelId(null);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => void handleRenameChannel(ch.id)}
                        >
                          저장
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          onClick={() => setRenamingChannelId(null)}
                        >
                          취소
                        </button>
                      </div>
                    ) : (
                      <div className="tf-chat-channel-row">
                        <button
                          type="button"
                          className="tf-chat-channel-btn"
                          aria-current={isSelected ? 'page' : undefined}
                          onClick={() => handleSelectChannel(ch.id)}
                        >
                          <span className="tf-chat-channel-badge">
                            {carriesMessages(ch) ? '#' : '음성'}
                          </span>
                          <span className="tf-chat-channel-name">{ch.name}</span>
                        </button>
                        {isSelected && (
                          <div className="tf-chat-channel-tools">
                            {idx > 0 && (
                              <button
                                type="button"
                                className="tf-chat-tool-btn"
                                title="위로 옮기기"
                                aria-label={`${ch.name} 채널 위로 옮기기`}
                                onClick={() => void handleMoveChannel(idx, -1)}
                              >
                                ▲
                              </button>
                            )}
                            {idx < channels.length - 1 && (
                              <button
                                type="button"
                                className="tf-chat-tool-btn"
                                title="아래로 옮기기"
                                aria-label={`${ch.name} 채널 아래로 옮기기`}
                                onClick={() => void handleMoveChannel(idx, 1)}
                              >
                                ▼
                              </button>
                            )}
                            <button
                              type="button"
                              className="tf-chat-tool-btn"
                              onClick={() => {
                                setRenamingChannelId(ch.id);
                                setRenameChannelDraft(ch.name);
                              }}
                            >
                              이름
                            </button>
                            {channels.length > 1 && (
                              <button
                                type="button"
                                className="tf-chat-tool-btn tf-chat-tool-btn--danger"
                                onClick={() => void handleArchiveChannel(ch)}
                              >
                                지우기
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* 오른쪽: 검색 바(열림 시) + 메시지 스트림 + 입력창 */}
          <section className="tf-chat-main" aria-label="대화창">
            {showSearch && (
              <div className="tf-chat-search-panel" role="search" aria-label="대화 찾기">
                <div className="tf-chat-search-row">
                  <input
                    id="tf-chat-search-input"
                    type="search"
                    className="input"
                    placeholder="이 프로젝트의 대화 검색 (두 글자 이상)"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleSearch();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    aria-disabled={!searchAllowed || searching}
                    aria-describedby={!searchAllowed || searching ? searchReasonId : undefined}
                    onClick={() => void handleSearch()}
                  >
                    {searching ? '찾는 중…' : '찾기'}
                  </button>
                </div>
                {(!searchAllowed || searching) && searchReason !== null && (
                  <span id={searchReasonId} className="tf-muted-note">
                    {searchReason}
                  </span>
                )}
                {searchHits !== null && (
                  <div className="tf-chat-search-results">
                    {searchHits.length === 0 ? (
                      <p className="tf-muted-note">일치하는 대화가 없습니다.</p>
                    ) : (
                      searchHits.map((hit) => (
                        <button
                          key={hit.message.id}
                          type="button"
                          className="tf-chat-search-hit"
                          onClick={() => handleSelectChannel(hit.channel_id)}
                        >
                          <div className="tf-chat-search-hit__meta">
                            <strong>#{hit.channel_name}</strong> · {hit.message.author_name} ·{' '}
                            {describeTime(hit.message.created_at)}
                          </div>
                          <div className="tf-chat-search-hit__body">
                            {excerpt(hit.message.body, searchQuery)}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            )}

            {activeChannel === null ? (
              <div className="empty">
                <p>
                  {channels.length === 0
                    ? '아직 열린 채널이 없습니다. 첫 채널을 만들어 팀 대화를 시작하세요.'
                    : '왼쪽 목록에서 채널을 고르면 대화 내역이 여기에 열립니다.'}
                </p>
                {channels.length === 0 && (
                  <div className="tf-row-actions" style={{ justifyContent: 'center', marginTop: 'var(--sp-3)' }}>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      disabled={creatingChannel}
                      onClick={() => void quickCreateChannel('일반', 'text')}
                    >
                      + #일반 채널 바로 시작
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      disabled={creatingChannel}
                      onClick={() => void quickCreateChannel('회의-공지', 'text')}
                    >
                      + #회의-공지 추가
                    </button>
                  </div>
                )}
              </div>
            ) : !carriesMessages(activeChannel) ? (
              <div className="tf-chat-voice-card">
                <h2 className="tf-chat-voice-card__title">{channelTitle(activeChannel)}</h2>
                <p className="tf-chat-voice-card__desc">{voiceChannelNote(activeChannel)}</p>
                <div className="tf-row-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={() => void handleStartVoiceMeeting(activeChannel)}
                  >
                    {creatingVoiceMeeting ? '회의 로비 여는 중…' : '새 회의 로비 열기'}
                  </button>
                  <a
                    href="/app/"
                    className="btn btn--ghost"
                    onClick={(e) => handleLinkClick(e, '/')}
                  >
                    홈에서 기존 회의 보기
                  </a>
                </div>
              </div>
            ) : (
              <>
                <header className="tf-chat-main__head">
                  <div>
                    <h2 className="tf-chat-main__title">{channelTitle(activeChannel)}</h2>
                    <span className="tf-chat-main__sub">
                      메시지 {messages.length}건 · 각 메시지에서 바로 칸반 업무로 등록할 수 있습니다
                    </span>
                  </div>
                </header>

                <div ref={streamBoxRef} className="tf-chat-stream">
                  {hasOlder && (
                    <div className="tf-chat-older-bar">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => void handleLoadOlder()}
                      >
                        {loadingOlder ? '불러오는 중…' : '이전 대화 더 보기'}
                      </button>
                    </div>
                  )}

                  {messages.length === 0 ? (
                    <div className="empty">
                      <strong>아직 대화가 없습니다</strong>
                      <p>{emptyInfo.why}</p>
                      <p>{emptyInfo.how}</p>
                    </div>
                  ) : (
                    groups.map((group) => (
                      <div key={group.date || group.label} className="tf-chat-day-group">
                        <div className="tf-chat-day-divider">
                          <span>{group.label}</span>
                        </div>
                        {group.messages.map((msg, idx) => {
                          const prev = idx > 0 ? group.messages[idx - 1] : undefined;
                          const compact = continuesRun(prev, msg);
                          const quote = quoteFor(msg.reply_to_id, messages);
                          const editable = canEdit(msg, meId);
                          const isEditing = editingId === msg.id;
                          const isPromoting = promotingMsg?.id === msg.id;
                          const promoted = promotedLinks[msg.id];
                          const availableReactions = offerableReactions(
                            reactionChoices,
                            msg.reactions,
                          );

                          return (
                            <article
                              key={msg.id}
                              className={`tf-chat-msg ${compact ? 'tf-chat-msg--compact' : ''} ${
                                msg.deleted ? 'tf-chat-msg--deleted' : ''
                              }`}
                            >
                              {!compact && (
                                <header className="tf-chat-msg__head">
                                  <strong className="tf-chat-msg__author">{msg.author_name}</strong>
                                  <time className="tf-chat-msg__time" dateTime={msg.created_at}>
                                    {describeTime(msg.created_at)}
                                  </time>
                                  {msg.edited_at !== null && !msg.deleted && (
                                    <span className="tf-chat-msg__edited">({EDITED_MARK})</span>
                                  )}
                                </header>
                              )}

                              {quote !== null && (
                                <div className="tf-chat-quote">
                                  {quote.kind === 'quote' ? (
                                    <>
                                      <strong>{quote.who}</strong>: {quote.body}
                                    </>
                                  ) : (
                                    <span>{quote.note}</span>
                                  )}
                                </div>
                              )}

                              {msg.deleted ? (
                                <p className="tf-chat-msg__deleted-text">{DELETED_TEXT}</p>
                              ) : isEditing ? (
                                <div className="tf-chat-edit-box">
                                  <textarea
                                    className="input tf-chat-edit-input"
                                    rows={2}
                                    aria-label="메시지 수정"
                                    value={editDraft}
                                    onChange={(e) => setEditDraft(e.target.value)}
                                  />
                                  <div className="tf-row-actions">
                                    <button
                                      type="button"
                                      className="btn btn--primary btn--sm"
                                      onClick={() => void handleSaveEdit(msg.id)}
                                    >
                                      저장
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn--ghost btn--sm"
                                      onClick={() => {
                                        setEditingId(null);
                                        setEditDraft('');
                                      }}
                                    >
                                      취소
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <p className="tf-chat-msg__body">
                                  {mentionSegments(msg.body, memberNames).map((seg, sIdx) =>
                                    seg.mention ? (
                                      <mark key={sIdx} className="tf-chat-mention">
                                        {seg.text}
                                      </mark>
                                    ) : (
                                      <span key={sIdx}>{seg.text}</span>
                                    ),
                                  )}
                                  {compact && msg.edited_at !== null && (
                                    <span className="tf-chat-msg__edited"> ({EDITED_MARK})</span>
                                  )}
                                </p>
                              )}

                              {promoted && (
                                <div className="tf-chat-promoted-badge">
                                  <span>칸반 등록됨: {promoted.title}</span>
                                  <a
                                    href={`/app/project/${projectId}/kanban?task=${promoted.id}`}
                                    onClick={(e) =>
                                      handleLinkClick(e, `/project/${projectId}/kanban?task=${promoted.id}`)
                                    }
                                  >
                                    보드에서 보기 →
                                  </a>
                                </div>
                              )}

                              {isPromoting && (
                                <form className="tf-chat-promote-form" onSubmit={(e) => void handlePromoteTask(e)}>
                                  <div className="tf-chat-promote-form__hdr">
                                    <strong>이 대화를 칸반 업무로 등록</strong>
                                    <span className="t11 muted">채팅 출처 수동 업무로 기록됩니다</span>
                                  </div>
                                  <input
                                    type="text"
                                    className="input"
                                    aria-label="업무 제목"
                                    value={promoteTitle}
                                    onChange={(e) => setPromoteTitle(e.target.value)}
                                    required
                                  />
                                  <div className="tf-chat-promote-form__row">
                                    <select
                                      className="input"
                                      aria-label="초기 상태"
                                      value={promoteStatus}
                                      onChange={(e) => setPromoteStatus(e.target.value as 'todo' | 'in_progress')}
                                    >
                                      <option value="todo">할 일</option>
                                      <option value="in_progress">진행 중</option>
                                    </select>
                                    <DatePicker
                                      id={`chat-promote-due-${msg.id}`}
                                      ariaLabel="업무 마감일(선택)"
                                      value={promoteDeadline || null}
                                      onChange={(v) => setPromoteDeadline(v ?? '')}
                                    />
                                  </div>
                                  {members.length > 0 && (
                                    <div className="tf-chat-mention-chips">
                                      {members.map((m) => {
                                        const active = promoteAssignees.includes(m.user_id);
                                        const label = labelInList(m, members);
                                        return (
                                          <button
                                            key={m.user_id}
                                            type="button"
                                            className={`tf-chat-mention-chip${active ? ' is-selected' : ''}`}
                                            aria-pressed={active}
                                            onClick={() =>
                                              setPromoteAssignees((prev) =>
                                                prev.includes(m.user_id)
                                                  ? prev.filter((id) => id !== m.user_id)
                                                  : [...prev, m.user_id],
                                              )
                                            }
                                          >
                                            {label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  )}
                                  <div className="tf-row-actions">
                                    <button
                                      type="submit"
                                      className="btn btn--primary btn--sm"
                                      disabled={!promoteTitle.trim() || promoting}
                                    >
                                      {promoting ? '등록 중…' : '칸반에 추가'}
                                    </button>
                                    <button
                                      type="button"
                                      className="btn btn--ghost btn--sm"
                                      onClick={() => setPromotingMsg(null)}
                                    >
                                      취소
                                    </button>
                                  </div>
                                </form>
                              )}

                              {!msg.deleted && (
                                <footer className="tf-chat-msg__foot">
                                  <div className="tf-chat-reactions">
                                    {msg.reactions.map((r) => {
                                      const mine = msg.my_reaction === r.mark;
                                      return (
                                        <button
                                          key={r.mark}
                                          type="button"
                                          className={`tf-chat-reaction-chip ${
                                            mine ? 'tf-chat-reaction-chip--mine' : ''
                                          }`}
                                          aria-pressed={mine}
                                          aria-label={reactionAriaLabel(r, mine)}
                                          onClick={() => void handleToggleReaction(msg, r.mark)}
                                        >
                                          <ReactionGlyph mark={r.mark} />
                                          <span>{r.label}</span>
                                          <strong>{r.count}</strong>
                                        </button>
                                      );
                                    })}

                                    {availableReactions.length > 0 && (
                                      <div className="tf-chat-reaction-picker-wrap">
                                        <button
                                          type="button"
                                          className="tf-chat-act-btn"
                                          aria-expanded={openReactionPickerFor === msg.id}
                                          onClick={() =>
                                            setOpenReactionPickerFor((cur) =>
                                              cur === msg.id ? null : msg.id,
                                            )
                                          }
                                        >
                                          + 반응
                                        </button>
                                        {openReactionPickerFor === msg.id && (
                                          <div
                                            className="tf-chat-reaction-picker"
                                            role="group"
                                            aria-label="반응 고르기"
                                          >
                                            {availableReactions.map((choice) => (
                                              <button
                                                key={choice.mark}
                                                type="button"
                                                className="tf-chat-reaction-option"
                                                onClick={() =>
                                                  void handleToggleReaction(msg, choice.mark)
                                                }
                                              >
                                                <ReactionGlyph mark={choice.mark} />
                                                <span>{choice.label}</span>
                                              </button>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </div>

                                  <div className="tf-chat-msg__actions">
                                    <button
                                      type="button"
                                      className="tf-chat-act-btn"
                                      onClick={() =>
                                        isPromoting ? setPromotingMsg(null) : startPromoteToTask(msg)
                                      }
                                      title="이 대화 내용을 바로 칸반 업무로 등록합니다"
                                    >
                                      업무로
                                    </button>
                                    <button
                                      type="button"
                                      className="tf-chat-act-btn"
                                      onClick={() => {
                                        setReplyTarget(msg);
                                        composerRef.current?.focus();
                                      }}
                                    >
                                      답글
                                    </button>
                                    {editable && (
                                      <>
                                        <button
                                          type="button"
                                          className="tf-chat-act-btn"
                                          onClick={() => {
                                            setEditingId(msg.id);
                                            setEditDraft(msg.body);
                                          }}
                                        >
                                          고치기
                                        </button>
                                        <button
                                          type="button"
                                          className="tf-chat-act-btn tf-chat-act-btn--danger"
                                          onClick={() => void handleDeleteMessage(msg.id)}
                                        >
                                          지우기
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </footer>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>

                {/* 하단 입력 영역 */}
                <div className="tf-chat-composer">
                  {replyTarget !== null && (
                    <div className="tf-chat-reply-bar">
                      <span>
                        <strong>{replyTarget.author_name}</strong> 님에게 답글 쓰는 중:{' '}
                        {replyTarget.body.slice(0, 60)}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setReplyTarget(null)}
                      >
                        답글 취소
                      </button>
                    </div>
                  )}

                  {(showMentionBar || draft.endsWith('@')) && members.length > 0 && (
                    <div className="tf-chat-mention-chips" role="group" aria-label="팀원 빠른 멘션">
                      <span className="t11 muted">언급하기:</span>
                      {members.map((m) => {
                        const label = labelInList(m, members);
                        return (
                          <button
                            key={m.user_id}
                            type="button"
                            className="tf-chat-mention-chip"
                            onClick={() => insertMention(m.name)}
                          >
                            @{label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div className="tf-chat-composer__row">
                    {members.length > 0 && (
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm tf-chat-mention-btn"
                        aria-expanded={showMentionBar}
                        title="팀원을 @멘션해 알림을 보냅니다"
                        onClick={() => setShowMentionBar((v) => !v)}
                      >
                        @ 멘션
                      </button>
                    )}
                    <textarea
                      ref={composerRef}
                      className="input tf-chat-composer__input"
                      rows={2}
                      aria-label={`${channelTitle(activeChannel)}에 메시지 쓰기`}
                      placeholder={`${channelTitle(activeChannel)}에 메시지 보내기 (Enter 전송 · @ 멘션)`}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          void handleSend();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn--primary tf-chat-composer__send"
                      aria-disabled={!sendAllowed || sending}
                      aria-describedby={!sendAllowed || sending ? sendReasonId : undefined}
                      onClick={() => void handleSend()}
                    >
                      {sending ? '보내는 중…' : '보내기'}
                    </button>
                  </div>
                  {(!sendAllowed || sending) && sendReason !== null && (
                    <span id={sendReasonId} className="tf-chat-composer__hint">
                      {sendReason}
                    </span>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
