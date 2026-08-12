/**
 * 채팅 화면 — 텍스트 채널에서 대화한다 (요구사항 정의서 §6 · §7).
 *
 * ## ⚠️ 이 화면이 생긴 이유
 *
 * 정의서 §26 이 **채널·채팅을 1단계**로 정했는데, 이 저장소는 3~5단계
 * (AI 회의 분석·GitHub·보고서)부터 만들어져 있었습니다. `docs/20` 이 그
 * 어긋남을 적어 둔 문서입니다.
 *
 * ## 판단은 여기 없습니다
 *
 * 날짜를 어디서 가를지, 같은 사람의 연속 발언을 어떻게 묶을지, 무엇을
 * 강조할지, 언제 보낼 수 있는지는 전부 `lib/chat/view.ts` 에 있고 테스트가
 * 붙어 있습니다. 여기는 그리기와 배선만 합니다.
 *
 * ## ⚠️ 채팅은 기여도가 **아닙니다**
 *
 * 정의서 §7 머리말이 채팅에 대한 AI 분석·업무 자동 생성·프로젝트 분석을
 * 금지합니다. 메시지가 기여로 세어지면 **도배가 기여도를 올리는 방법**이
 * 됩니다. 이 화면에서 기여도로 가는 통로를 만들지 마십시오 —
 * `backend/tests/test_chat_is_not_measured.py` 가 양쪽을 다 잽니다.
 *
 * ## ⚠️ 소켓은 **읽기 전용**입니다
 *
 * 글은 HTTP 로 보내고, 저장된 뒤에 소켓으로 돌아옵니다. 소켓으로 보내면
 * 저장 안 된 메시지가 화면에만 뜨고 새로고침하면 사라집니다.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  canEdit,
  canSend,
  carriesMessages,
  channelTitle,
  continuesRun,
  dayGroups,
  describeTime,
  DELETED_TEXT,
  EDITED_MARK,
  MAX_BODY,
  mentionSegments,
  reactionAriaLabel,
  reactionIcon,
  REACTION_MARKS,
  sendBlockedReason,
  voiceChannelNote,
  type ChatChannel,
  type ChatMessage,
} from '../lib/chat/view.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as rowSkeleton } from '../lib/ui/skeleton.ts';
import { NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 링크 하나로 팀 대화가 어디로 가는지
// 바뀝니다. 채널에는 팀 내부 이야기가 쌓입니다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

const sendJson = (
  path: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<Response | null> =>
  trySend(() =>
    fetch(`${apiBase}${path}`, {
      method,
      credentials: 'same-origin',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  );

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

/** 아이콘 하나. ⚠️ 색 이모지 대신입니다 — 이유는 `lib/nav/icons.ts` 에. */
function Icon({ name }: { name: 'check' | 'thumb' | 'ask' | 'heart' }) {
  return <span className="ico" dangerouslySetInnerHTML={{ __html: iconSvg(name) }} />;
}

// ══════════════════════════════════════════════════════════════
// 한 줄
// ══════════════════════════════════════════════════════════════

function Body({ message }: { message: ChatMessage }) {
  if (message.deleted) return <p className="mbody mgone">{DELETED_TEXT}</p>;
  return (
    <p className="mbody">
      {/* ⚠️ 이 강조는 **꾸미기**입니다. 누가 알림을 받는지는 서버가
          `mentions` 로 정해서 보냅니다 — 여기가 틀려도 알림은 안 갑니다. */}
      {mentionSegments(message.body, message.mentions).map((segment, i) =>
        segment.mention ? (
          <b className="mat" key={i}>
            {segment.text}
          </b>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
      {message.edited_at !== null && <span className="medit">({EDITED_MARK})</span>}
    </p>
  );
}

/**
 * 반응 줄.
 *
 * ## ⚠️ 고를 것 넷을 **늘 펴 두지 않습니다**
 *
 * 처음에는 메시지마다 넷을 다 그렸습니다. 렌더해서 보니 **네모 넷이 줄마다
 * 쌓여서 사람이 쓴 말보다 더 눈에 띄었습니다** — 폰에서는 메시지 하나가
 * 두 줄인데 반응 줄이 한 줄을 통째로 먹었습니다. 글로는 안 보이고 캡처를
 * 보고 알았습니다.
 *
 * 그래서 **달린 것만** 늘 보이고, 고르는 넷은 `[반응]` 을 눌러야 펴집니다.
 */
function Reactions({
  message,
  onPick,
  busy,
  picking,
  onTogglePicker,
  labels,
}: {
  message: ChatMessage;
  onPick: (mark: string | null) => void;
  busy: boolean;
  picking: boolean;
  onTogglePicker: () => void;
  /** 반응 이름 → 사람 말. **서버가 줍니다** — 화면이 두 번째 표를 만들지 않습니다. */
  labels: Record<string, string>;
}) {
  if (message.deleted) return null;
  const unused = REACTION_MARKS.filter(
    (mark) => !message.reactions.some((r) => r.mark === mark),
  );
  return (
    <div className="rrow">
      {message.reactions.map((reaction) => {
        const icon = reactionIcon(reaction.mark);
        const mine = message.my_reaction === reaction.mark;
        return (
          <button
            type="button"
            key={reaction.mark}
            className={mine ? 'rchip on' : 'rchip'}
            disabled={busy}
            aria-label={reactionAriaLabel(reaction, mine)}
            aria-pressed={mine}
            onClick={() => onPick(mine ? null : reaction.mark)}
          >
            {icon !== null && <Icon name={icon} />}
            {/* ⚠️ 개수는 **글자**입니다. 폭으로 그리면 그 순간 막대이고,
                막대는 곧 순위표입니다 (`AGENTS.md` 불변식 1). */}
            <span className="rnum">{reaction.count}</span>
          </button>
        );
      })}

      {unused.length > 0 && (
        <button
          type="button"
          className="rmore"
          disabled={busy}
          aria-expanded={picking}
          onClick={onTogglePicker}
        >
          {picking ? '닫기' : '반응'}
        </button>
      )}

      {picking &&
        unused.map((mark) => {
          const icon = reactionIcon(mark);
          if (icon === null) return null;
          return (
            <button
              type="button"
              key={mark}
              className="rchip add"
              disabled={busy}
              // ⚠️ 아이콘뿐이라 낭독기에게는 **이름밖에 없습니다.** 서버가
              //    주는 사람 말(`label`)은 이미 달린 반응에만 오므로, 아직
              //    안 단 것은 여기서 말을 붙입니다.
              aria-label={`${labels[mark] ?? mark} 반응 달기`}
              onClick={() => onPick(mark)}
            >
              <Icon name={icon} />
            </button>
          );
        })}
    </div>
  );
}

function Row({
  message,
  parent,
  runOn,
  meId,
  busy,
  onReply,
  onEdit,
  onDelete,
  onReact,
  picking,
  onTogglePicker,
  labels,
}: {
  message: ChatMessage;
  parent: ChatMessage | undefined;
  runOn: boolean;
  meId: number | null;
  busy: boolean;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, mark: string | null) => void;
  picking: boolean;
  onTogglePicker: () => void;
  labels: Record<string, string>;
}) {
  return (
    <li className={runOn ? 'msg run' : 'msg'}>
      {parent !== undefined && (
        // ⚠️ 답글이 무엇에 달렸는지 **여기 보여 줍니다.** 안 보이면
        //    "근거 #5" 라고 적어 놓고 원문을 볼 방법이 없던 그 실패입니다.
        <p className="mquote">
          <span className="qwho">{parent.author_name}</span>
          <span className="qbody">{parent.deleted ? DELETED_TEXT : parent.body}</span>
        </p>
      )}
      {!runOn && (
        <p className="mhead">
          <span className="mwho">{message.author_name}</span>
          <time className="mwhen" dateTime={message.created_at}>
            {describeTime(message.created_at)}
          </time>
        </p>
      )}
      <Body message={message} />
      {/* ⚠️ 반응과 [답글]·[고치기]·[지우기] 를 **한 줄에** 둡니다. 처음에는
          두 줄이었는데, 줄마다 44px 이 둘이라 메시지 하나가 세 줄짜리
          덩어리가 됐습니다 — 폰 캡처를 보고 알았습니다. */}
      {!message.deleted && (
        <div className="mbar">
          <Reactions
            message={message}
            busy={busy}
            onPick={(mark) => onReact(message, mark)}
            picking={picking}
            onTogglePicker={onTogglePicker}
            labels={labels}
          />
          <div className="mtools">
            <button type="button" disabled={busy} onClick={() => onReply(message)}>
              답글
            </button>
            {canEdit(message, meId) && (
              <>
                <button type="button" disabled={busy} onClick={() => onEdit(message)}>
                  고치기
                </button>
                <button type="button" disabled={busy} onClick={() => onDelete(message)}>
                  지우기
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

// ══════════════════════════════════════════════════════════════
// 화면
// ══════════════════════════════════════════════════════════════

function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [channels, setChannels] = useState<ChatChannel[] | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editing, setEditing] = useState<ChatMessage | null>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [newName, setNewName] = useState('');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ channel_name: string; message: ChatMessage }[] | null>(
    null,
  );
  /** 지금 반응을 고르는 중인 메시지. ⚠️ **하나만** 펴 둡니다 — 여럿이
   *  펴지면 처음 상태로 되돌아갑니다(줄마다 네모 넷). */
  const [picking, setPicking] = useState<number | null>(null);
  /** 반응 이름 → 사람 말. **서버가 줍니다.** */
  const [labels, setLabels] = useState<Record<string, string>>({});

  const open = channels?.find((c) => c.id === openId) ?? null;
  const foot = useRef<HTMLDivElement>(null);

  const loadChannels = useCallback(async (): Promise<void> => {
    const response = await get(`/api/projects/${projectId}/channels`);
    if (response === null) {
      setFailure(unreachableText('채널 목록을 못 불러왔습니다'));
      setChannels([]);
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFailure(describeHttpStatus(response.status) ?? '채널 목록을 못 불러왔습니다');
      setChannels([]);
      return;
    }
    setFailure(null);
    const rows = (await response.json()) as ChatChannel[];
    setChannels(rows);
    setOpenId((current) => {
      if (current !== null && rows.some((c) => c.id === current)) return current;
      return rows.find(carriesMessages)?.id ?? rows[0]?.id ?? null;
    });
  }, []);

  const loadMessages = useCallback(async (channelId: number): Promise<void> => {
    setMessages(null);
    const response = await whileLoading(
      get(`/api/channels/${channelId}/messages`),
      () => setSlow(true),
      () => setSlow(false),
    );
    if (response === null) {
      setFailure(unreachableText('대화를 못 불러왔습니다'));
      setMessages([]);
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFailure(describeHttpStatus(response.status) ?? '대화를 못 불러왔습니다');
      setMessages([]);
      return;
    }
    setFailure(null);
    setMessages((await response.json()) as ChatMessage[]);
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await get('/api/auth/me');
      if (response === null) return;
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (response.ok) setMe((await response.json()) as Me);
    })();
    void (async () => {
      // 반응 이름표. ⚠️ 못 받아도 화면은 돕니다 — 낭독기 라벨이 이름
      //    그대로 나올 뿐이고, 여기서 빨간 줄을 띄울 일은 아닙니다.
      const response = await get('/api/chat/reactions');
      if (response === null || !response.ok) return;
      const rows = (await response.json()) as { mark: string; label: string }[];
      setLabels(Object.fromEntries(rows.map((r) => [r.mark, r.label])));
    })();
    void loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    if (openId === null) return;
    void loadMessages(openId);
  }, [openId, loadMessages]);

  /**
   * 새 메시지를 실시간으로 받는다.
   *
   * ⚠️ **소켓이 안 붙어도 화면은 돕니다.** 붙지 않으면 실시간만 없고,
   * 다시 열면 HTTP 로 읽어 옵니다. 그래서 여기서 실패를 화면에 적지
   * 않습니다 — 사람이 할 수 있는 것이 없는데 빨간 줄만 남습니다.
   */
  useEffect(() => {
    if (openId === null) return;
    const url = new URL(`${apiBase}/api/channels/${openId}/stream`, location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      return;
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      let payload: { kind?: string; message?: ChatMessage };
      try {
        payload = JSON.parse(event.data) as { kind?: string; message?: ChatMessage };
      } catch {
        return;
      }
      const incoming = payload.message;
      if (incoming === undefined) return;
      setMessages((current) => {
        if (current === null) return current;
        const at = current.findIndex((m) => m.id === incoming.id);
        // ⚠️ 남이 보낸 반응에는 `my_reaction` 이 없습니다. 그대로 덮으면
        //    내가 누른 표시가 사라집니다.
        if (at === -1) return [...current, incoming];
        const mine = current[at]?.my_reaction ?? null;
        const merged = [...current];
        merged[at] = { ...incoming, my_reaction: incoming.my_reaction ?? mine };
        return merged;
      });
    };
    return () => socket.close();
  }, [openId]);

  useEffect(() => {
    // 새 메시지가 오면 아래로. ⚠️ `smooth` 를 쓰지 않습니다 — 여러 개가
    // 연달아 오면 애니메이션이 겹쳐 화면이 출렁입니다.
    foot.current?.scrollIntoView();
  }, [messages]);

  const submit = useCallback(async (): Promise<void> => {
    if (open === null) return;
    setSending(true);
    try {
      const response =
        editing === null
          ? await sendJson(`/api/channels/${open.id}/messages`, 'POST', {
              body: draft,
              reply_to_id: replyTo?.id ?? null,
            })
          : await sendJson(`/api/messages/${editing.id}`, 'PATCH', { body: draft });

      if (response === null) {
        setNote({ text: unreachableText('메시지를 못 보냈습니다'), tone: 'bad' });
        return;
      }
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        setNote({
          text: describeHttpStatus(response.status) ?? '메시지를 못 보냈습니다',
          tone: 'bad',
        });
        return;
      }
      setNote(null);
      setDraft('');
      setReplyTo(null);
      setEditing(null);
      // 소켓이 안 붙었을 수도 있으므로 보낸 것은 직접 넣습니다.
      const saved = (await response.json()) as ChatMessage;
      setMessages((current) => {
        if (current === null) return [saved];
        const at = current.findIndex((m) => m.id === saved.id);
        if (at === -1) return [...current, saved];
        const merged = [...current];
        merged[at] = saved;
        return merged;
      });
    } finally {
      setSending(false);
    }
  }, [draft, editing, open, replyTo]);

  const react = useCallback(
    async (message: ChatMessage, mark: string | null): Promise<void> => {
      setSending(true);
      try {
        const response = await sendJson(`/api/messages/${message.id}/reaction`, 'PUT', {
          mark,
        });
        if (response === null) {
          setNote({ text: unreachableText('반응을 못 보냈습니다'), tone: 'bad' });
          return;
        }
        if (!response.ok) {
          setNote({
            text: describeHttpStatus(response.status) ?? '반응을 못 보냈습니다',
            tone: 'bad',
          });
          return;
        }
        setNote(null);
        const saved = (await response.json()) as ChatMessage;
        setMessages((current) =>
          current === null ? current : current.map((m) => (m.id === saved.id ? saved : m)),
        );
      } finally {
        setSending(false);
      }
    },
    [],
  );

  const remove = useCallback(async (message: ChatMessage): Promise<void> => {
    setSending(true);
    try {
      const response = await sendJson(`/api/messages/${message.id}`, 'DELETE');
      if (response === null) {
        setNote({ text: unreachableText('메시지를 못 지웠습니다'), tone: 'bad' });
        return;
      }
      if (!response.ok) {
        setNote({
          text: describeHttpStatus(response.status) ?? '메시지를 못 지웠습니다',
          tone: 'bad',
        });
        return;
      }
      setNote(null);
      const saved = (await response.json()) as ChatMessage;
      setMessages((current) =>
        current === null ? current : current.map((m) => (m.id === saved.id ? saved : m)),
      );
    } finally {
      setSending(false);
    }
  }, []);

  const addChannel = useCallback(async (): Promise<void> => {
    setSending(true);
    try {
      const response = await sendJson(`/api/projects/${projectId}/channels`, 'POST', {
        kind: 'text',
        name: newName,
      });
      if (response === null) {
        setNote({ text: unreachableText('채널을 못 만들었습니다'), tone: 'bad' });
        return;
      }
      if (!response.ok) {
        setNote({
          text: describeHttpStatus(response.status) ?? '채널을 못 만들었습니다',
          tone: 'bad',
        });
        return;
      }
      setNote(null);
      setNewName('');
      const made = (await response.json()) as ChatChannel;
      await loadChannels();
      setOpenId(made.id);
    } finally {
      setSending(false);
    }
  }, [newName, loadChannels]);

  const runSearch = useCallback(async (): Promise<void> => {
    if (query.trim().length < 2) {
      setFound(null);
      return;
    }
    const response = await get(
      `/api/projects/${projectId}/messages/search?q=${encodeURIComponent(query)}`,
    );
    if (response === null) {
      setNote({ text: unreachableText('찾지 못했습니다'), tone: 'bad' });
      return;
    }
    if (!response.ok) {
      setNote({ text: describeHttpStatus(response.status) ?? '찾지 못했습니다', tone: 'bad' });
      return;
    }
    setNote(null);
    setFound((await response.json()) as { channel_name: string; message: ChatMessage }[]);
  }, [query]);

  // ── 그리기 ───────────────────────────────────────────

  const blocked = sendBlockedReason(draft, open);

  const header = (
    <header className="head">
      <h1>채팅</h1>
      <p className="lede">
        회의 밖에서 오가는 이야기입니다. 채팅은 기여도로 세지 않습니다 —
        도배가 점수를 올리는 길이 되면 안 되기 때문입니다.
      </p>
    </header>
  );

  if (failure !== null && channels !== null && channels.length === 0) {
    return (
      <>
        {header}
        <RawHtml
          html={failureHtml({ what: failure, retry: true })}
          onRetry={() => void loadChannels()}
        />
      </>
    );
  }

  if (channels === null) {
    return (
      <>
        {header}
        <div aria-busy="true" dangerouslySetInnerHTML={{ __html: rowSkeleton(3) }} />
      </>
    );
  }

  return (
    <>
      {header}

      <div className="cols">
        <aside className="side">
          <h2 className="shead">채널</h2>
          {channels.length === 0 ? (
            <RawHtml
              html={emptyHtml({
                what: '아직 채널이 없습니다',
                why: '채널은 자동으로 생기지 않습니다 — 팀이 이름을 붙여 만듭니다.',
                how: '아래에 이름을 적고 [채널 만들기]를 누르세요.',
              })}
            />
          ) : (
            <ul className="clist">
              {channels.map((channel) => (
                <li key={channel.id}>
                  <button
                    type="button"
                    className={channel.id === openId ? 'citem current' : 'citem'}
                    {...(channel.id === openId ? { 'aria-current': 'true' as const } : {})}
                    onClick={() => setOpenId(channel.id)}
                  >
                    {channelTitle(channel)}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="cnew"
            onSubmit={(event) => {
              event.preventDefault();
              void addChannel();
            }}
          >
            <label className="clabel" htmlFor="new-channel">
              새 채널 이름
            </label>
            <input
              id="new-channel"
              value={newName}
              maxLength={100}
              placeholder="예: 디자인"
              onChange={(event) => setNewName(event.target.value)}
            />
            <button type="submit" id="add-channel" disabled={newName.trim() === '' || sending}>
              채널 만들기
            </button>
          </form>

          <form
            className="cnew"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <label className="clabel" htmlFor="q">
              대화 찾기
            </label>
            <input
              id="q"
              value={query}
              placeholder="두 글자 이상"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="submit" id="search" disabled={query.trim().length < 2}>
              찾기
            </button>
          </form>
        </aside>

        <section className="main">
          <NoteLine note={note} id="chat-note" />

          {found !== null ? (
            <div className="hits">
              <div className="hbar">
                <h2 className="shead">찾은 결과</h2>
                <button type="button" onClick={() => setFound(null)}>
                  대화로 돌아가기
                </button>
              </div>
              {found.length === 0 ? (
                <RawHtml
                  html={emptyHtml({
                    what: '찾는 말이 없습니다',
                    why: '지운 메시지는 검색에 안 나옵니다.',
                    how: '다른 낱말로 찾아보세요.',
                  })}
                />
              ) : (
                <ul className="hlist">
                  {found.map((hit) => (
                    <li key={hit.message.id} className="hit">
                      <p className="hwhere">
                        #{hit.channel_name} · {hit.message.author_name}
                      </p>
                      <p className="mbody">{hit.message.body}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : open === null ? (
            <p className="bempty">왼쪽에서 채널을 고르세요.</p>
          ) : !carriesMessages(open) ? (
            // ⚠️ 음성 채널에 입력창을 그려 놓고 보내면 빨간 줄이 뜨는
            //    화면을 만들지 않습니다 — 할 수 없는 일은 안 그립니다.
            <p className="bempty">{voiceChannelNote(open)}</p>
          ) : messages === null ? (
            slow && <div aria-busy="true" dangerouslySetInnerHTML={{ __html: rowSkeleton(4) }} />
          ) : messages.length === 0 ? (
            <RawHtml
              html={emptyHtml({
                what: '아직 아무 말도 없습니다',
                why: `${channelTitle(open)} 채널이 방금 만들어졌습니다.`,
                how: '아래에 첫 마디를 적어 보세요.',
              })}
            />
          ) : (
            <div className="stream">
              {dayGroups(messages).map((group) => (
                <section key={group.date} className="day">
                  {/* ⚠️ 날짜를 안 가르면 어제 온 말과 방금 온 말이 붙어
                      보입니다 — 언제 한 말인지를 통째로 잃습니다. */}
                  <h3 className="dhead">{group.label}</h3>
                  <ul className="mlist">
                    {group.messages.map((message, i) => (
                      <Row
                        key={message.id}
                        message={message}
                        parent={
                          message.reply_to_id === null
                            ? undefined
                            : messages.find((m) => m.id === message.reply_to_id)
                        }
                        runOn={continuesRun(group.messages[i - 1], message)}
                        meId={me?.user_id ?? null}
                        busy={sending}
                        onReply={(target) => {
                          setReplyTo(target);
                          setEditing(null);
                        }}
                        onEdit={(target) => {
                          setEditing(target);
                          setReplyTo(null);
                          setDraft(target.body);
                        }}
                        onDelete={(target) => void remove(target)}
                        onReact={(target, mark) => {
                          setPicking(null);
                          void react(target, mark);
                        }}
                        picking={picking === message.id}
                        onTogglePicker={() =>
                          setPicking((current) => (current === message.id ? null : message.id))
                        }
                        labels={labels}
                      />
                    ))}
                  </ul>
                </section>
              ))}
              <div ref={foot} />
            </div>
          )}

          {found === null && open !== null && carriesMessages(open) && (
            <form
              className="compose"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {(replyTo !== null || editing !== null) && (
                <p className="creply">
                  <span>
                    {editing !== null
                      ? '고치는 중'
                      : `${replyTo?.author_name ?? ''} 님에게 답글`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setReplyTo(null);
                      setEditing(null);
                      setDraft('');
                    }}
                  >
                    그만두기
                  </button>
                </p>
              )}
              {/* ⚠️ 값과 조사를 **띄우지 않습니다.** `#일반 에 쓸 말` 로
                  떠 있었고, 캡처를 보고 알았습니다 (결함 76). */}
              <label className="clabel" htmlFor="draft">
                {channelTitle(open)}에 쓸 말
              </label>
              <textarea
                id="draft"
                value={draft}
                rows={2}
                maxLength={MAX_BODY}
                placeholder="@이름으로 팀원을 부를 수 있습니다"
                onChange={(event) => setDraft(event.target.value)}
              />
              {/* ⚠️ 버튼만 흐려 두면 왜 안 되는지 모른 채 계속 누릅니다. */}
              {blocked !== null && <p className="cwhy">{blocked}</p>}
              <button type="submit" id="send" disabled={!canSend(draft, open) || sending}>
                {editing !== null ? '고치기' : '보내기'}
              </button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('chat');
bootApp();
