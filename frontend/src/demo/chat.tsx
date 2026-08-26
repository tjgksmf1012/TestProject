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
  describeEmptyChannel,
  hasOlderMessages,
  olderCursor,
  prependOlder,
  EDITED_MARK,
  MAX_BODY,
  mentionSegments,
  reactionAriaLabel,
  reactionIcon,
  offerableReactions,
  sendBlockedReason,
  streamClosedNote,
  quoteFor,
  voiceChannelNote,
  type ChatChannel,
  type ChatMessage,
  type ReactionChoice,
  type QuoteView,
} from '../lib/chat/view.ts';
import { isSessionExpired, loginUrlFor, safeApiBase, type Me } from '../lib/auth/session.ts';
import { detailText } from '../lib/http/detail.ts';
import { blockedReason, canSearch } from '../lib/search/view.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { iconSvg } from '../lib/nav/icons.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as rowSkeleton } from '../lib/ui/skeleton.ts';
import { NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

/** `GET /api/chat/channel-kinds` 한 줄. **서버가 어휘의 주인**입니다. */
interface ChannelKindChoice {
  kind: string;
  label: string;
  hint: string;
}

const params = new URLSearchParams(location.search);
// ⚠️ 주소창의 `?api=` 를 그대로 쓰면 링크 하나로 팀 대화가 어디로 가는지
// 바뀝니다. 채널에는 팀 내부 이야기가 쌓입니다.
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');
/**
 * 알림에서 넘어올 때 **어느 대화를 열 것인가** (결함 417).
 *
 * ⚠️ 없으면 지금까지처럼 첫 텍스트 채널을 엽니다. 이 값이 없던 동안
 * 「디자인 채널에서 나를 불렀습니다」를 눌러도 `#공지` 가 열렸습니다.
 */
const wantedChannel = Number(params.get('channel') ?? '') || null;

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

/**
 * 실패한 응답을 **사람이 읽을 한 줄**로.
 *
 * ⛔ 예전에는 `describeHttpStatus(status) ?? '채널을 못 만들었습니다'` 였고,
 * `describeHttpStatus` 는 **400 에 아무 말도 없습니다**(`null`). 그래서
 * 이미 있는 이름으로 채널을 만들면 서버가
 *
 *     400  `일반` 채널이 이미 있습니다
 *
 * 라고 정확히 말하는데 화면은 「채널을 못 만들었습니다」만 띄웠습니다
 * (결함 301). 사람은 이름이 겹친 건지, 권한이 없는 건지, 서버가 죽은
 * 건지 알 방법이 없습니다 — 바로 옆 목록에 `#일반` 이 보이는데도요.
 *
 * ⚠️ `detail` 을 `string` 으로 단언하지 않습니다 — 422 는 **객체 배열**
 * 이라 화면에 `[object Object]` 가 찍힙니다 (결함 51). 한 벌짜리
 * `detailText` 가 그 모양까지 봅니다.
 */
async function failureText(response: Response, fallback: string): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  return detailText(body, describeHttpStatus(response.status) ?? fallback);
}

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
  choices,
}: {
  message: ChatMessage;
  onPick: (mark: string | null) => void;
  busy: boolean;
  picking: boolean;
  onTogglePicker: () => void;
  /**
   * 고를 수 있는 반응 전부 — **서버가 줍니다**(`GET /api/chat/reactions`).
   *
   * ⚠️ 이름표만 꺼내 쓰고 **집합과 순서를 화면이 다시 정하면 안 됩니다**
   *    (결함 414). 못 받았으면 빈 배열이고, 그러면 고르는 자리를 안
   *    그립니다 — 채널 종류가 결함 360 에서 내린 결정과 같습니다.
   */
  choices: readonly ReactionChoice[];
}) {
  if (message.deleted) return null;
  const unused = offerableReactions(choices, message.reactions);
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
        unused.map((choice) => {
          const icon = reactionIcon(choice.mark);
          if (icon === null) return null;
          return (
            <button
              type="button"
              key={choice.mark}
              className="rchip add"
              disabled={busy}
              // ⚠️ 아이콘뿐이라 낭독기에게는 **이름밖에 없습니다.** 서버가
              //    주는 사람 말(`label`)은 이미 달린 반응에만 오므로, 아직
              //    안 단 것은 여기서 말을 붙입니다.
              aria-label={`${choice.label} 반응 달기`}
              onClick={() => onPick(choice.mark)}
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
  quote,
  runOn,
  meId,
  busy,
  onReply,
  onEdit,
  onDelete,
  onReact,
  picking,
  onTogglePicker,
  choices,
}: {
  message: ChatMessage;
  quote: QuoteView | null;
  runOn: boolean;
  meId: number | null;
  busy: boolean;
  onReply: (message: ChatMessage) => void;
  onEdit: (message: ChatMessage) => void;
  onDelete: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, mark: string | null) => void;
  picking: boolean;
  onTogglePicker: () => void;
  choices: readonly ReactionChoice[];
}) {
  return (
    <li className={runOn ? 'msg run' : 'msg'}>
      {/* ⚠️ 답글이 무엇에 달렸는지 **여기 보여 줍니다.** 안 보이면
          "근거 #5" 라고 적어 놓고 원문을 볼 방법이 없던 그 실패입니다.
          ⚠️ 원글이 **아직 안 불러온 앞쪽**에 있으면 예전에는 이 자리를
          통째로 비웠고, 그러면 답글이 평범한 글로 보였습니다(결함 419).
          판단은 `@lib` 의 `quoteFor` 가 합니다. */}
      {quote !== null &&
        (quote.kind === 'quote' ? (
          <p className="mquote">
            <span className="qwho">{quote.who}</span>
            <span className="qbody">{quote.body}</span>
          </p>
        ) : (
          <p className="mquote">{quote.note}</p>
        ))}
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
            choices={choices}
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
  /* ⚠️ **종류를 서버에서 받아 옵니다** (결함 360). 예전에는 만드는 자리에
     종류가 아예 없었고 `kind: 'text'` 가 박혀 있었습니다 — 서버는 처음부터
     둘 다 받았고 화면은 음성 채널을 제대로 그렸는데, 만들 길만 없었습니다.
     목록을 화면에 적으면 서버의 `CHANNEL_LABEL` 과 두 벌이 됩니다. */
  const [kinds, setKinds] = useState<ChannelKindChoice[]>([]);
  const [newKind, setNewKind] = useState('text');
  const [query, setQuery] = useState('');
  /* 찾기 게이트는 `@lib` 한 벌입니다 — 이 화면에는 거를 칸이 없으므로
     `filters` 는 `null` 입니다(결함 375). 규칙을 여기서 다시 적으면
     찾기 화면과 갈라집니다(대표 실패 ②). */
  const canFind = canSearch(query, null);
  const searchBlocked = blockedReason(query, null);
  const [found, setFound] = useState<{ channel_name: string; message: ChatMessage }[] | null>(
    null,
  );
  /** 지금 반응을 고르는 중인 메시지. ⚠️ **하나만** 펴 둡니다 — 여럿이
   *  펴지면 처음 상태로 되돌아갑니다(줄마다 네모 넷). */
  const [picking, setPicking] = useState<number | null>(null);
  /** 반응 이름 → 사람 말. **서버가 줍니다.** */
  const [choices, setChoices] = useState<ReactionChoice[]>([]);

  const open = channels?.find((c) => c.id === openId) ?? null;
  const foot = useRef<HTMLDivElement>(null);
  /* ⛔ **「고치기」·「답글」을 눌러도 초점이 그 자리에 남아 있었습니다**
     (결함 302). 글은 아래 작성칸으로 옮겨 가는데 초점은 안 갑니다 —
     키보드만 쓰는 사람은 **Tab 을 31~32번** 눌러야 그 칸에 닿습니다
     (남은 메시지마다 반응·답글·고치기·지우기 넷을 지나갑니다). 메시지가
     쌓일수록 더 멀어집니다.

     화면은 「고치는 중」이라고 말은 합니다 — 실패 ③ 「할 일을 알려 주고
     그 일을 할 자리를 안 줌」 그대로입니다. */
  const draftBox = useRef<HTMLTextAreaElement>(null);

  /** 글을 옮겨 놓은 칸으로 **데려다 줍니다.** 캐럿은 글 끝에 둡니다. */
  const goToDraft = useCallback((): void => {
    const box = draftBox.current;
    if (box === null) return;
    box.focus();
    const end = box.value.length;
    box.setSelectionRange(end, end);
  }, []);

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
      // ⚠️ 알림이 데려온 채널이 먼저입니다 — 없거나 내가 못 보는
      //    채널이면 지금까지처럼 첫 텍스트 채널로 떨어집니다.
      const asked = rows.find((c) => c.id === wantedChannel);
      if (asked !== undefined) return asked.id;
      return rows.find(carriesMessages)?.id ?? rows[0]?.id ?? null;
    });
  }, []);

  /* ⛔ **대화의 앞부분에 닿을 길이 없었습니다** (결함 315). 서버는 최신
     50개만 주는데(`MAX_PAGE`) 화면에 「더 보기」가 없어, 메시지 60개짜리
     채널에서 처음 열 줄이 제품 안에서 영영 안 보였습니다. 서버는 이미
     `before_id` 를 받을 수 있었고 화면이 한 번도 안 보냈습니다. */
  const [older, setOlder] = useState<'maybe' | 'none' | 'loading'>('none');

  const loadMessages = useCallback(async (channelId: number): Promise<void> => {
    setMessages(null);
    setOlder('none');
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
    const rows = (await response.json()) as ChatMessage[];
    setMessages(rows);
    setOlder(hasOlderMessages(rows.length) ? 'maybe' : 'none');
  }, []);

  /** 앞쪽 한 쪽 더. 판단(더 있을 수 있는가·어디서부터·어떻게 붙이는가)은 `@lib`. */
  const loadOlder = useCallback(async (channelId: number, cursor: number): Promise<void> => {
    setOlder('loading');
    const response = await get(`/api/channels/${channelId}/messages?before_id=${cursor}`);
    if (response === null) {
      setFailure(unreachableText('이전 대화를 못 불러왔습니다'));
      setOlder('maybe');
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFailure(describeHttpStatus(response.status) ?? '이전 대화를 못 불러왔습니다');
      setOlder('maybe');
      return;
    }
    setFailure(null);
    const rows = (await response.json()) as ChatMessage[];
    setMessages((current) => prependOlder(rows, current ?? []));
    setOlder(hasOlderMessages(rows.length) ? 'maybe' : 'none');
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
      // 고를 수 있는 반응. ⚠️ 못 받으면 **고르는 자리를 안 그립니다** —
      //    화면이 집합을 지어내면 서버의 어휘와 두 벌이 됩니다(결함 414).
      //    이미 달린 반응은 메시지에 `label` 이 딸려 오므로 그대로 보입니다.
      const response = await get('/api/chat/reactions');
      if (response === null || !response.ok) return;
      setChoices((await response.json()) as ReactionChoice[]);
    })();
    void (async () => {
      // 채널 종류. ⚠️ 못 받으면 **고르는 칸을 안 그립니다** — 종류를
      //    화면이 지어내면 서버의 어휘와 두 벌이 됩니다(결함 360).
      const response = await get('/api/chat/channel-kinds');
      if (response === null || !response.ok) return;
      setKinds((await response.json()) as ChannelKindChoice[]);
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
    // ⚠️ 우리가 닫는 것과 저쪽이 끊는 것을 갈라야 합니다 — 채널을
    //    옮길 때마다 「끊겼습니다」가 뜨면 그 말이 닳습니다.
    let onPurpose = false;

    socket.onclose = () => {
      const say = streamClosedNote(onPurpose);
      // ⚠️ 이 화면의 `Note` 는 `'bad' | 'plain'` 둘뿐입니다 — 세 번째를
      //    만들지 않습니다. 서버에 못 닿는 다른 문구들과 같은 부류이므로
      //    같은 톤을 씁니다.
      if (say !== null) setNote({ text: say, tone: 'bad' });
    };
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
    return () => {
      onPurpose = true;
      socket.close();
    };
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
          text: await failureText(response, '메시지를 못 보냈습니다'),
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
            text: await failureText(response, '반응을 못 보냈습니다'),
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
          text: await failureText(response, '메시지를 못 지웠습니다'),
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
        kind: newKind,
        name: newName,
      });
      if (response === null) {
        setNote({ text: unreachableText('채널을 못 만들었습니다'), tone: 'bad' });
        return;
      }
      if (!response.ok) {
        setNote({
          text: await failureText(response, '채널을 못 만들었습니다'),
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
    /* ⚠️ **`newKind` 가 여기 없으면 고른 종류가 조용히 버려집니다**
       (결함 376). 이 콜백은 `newName` 이 바뀔 때만 다시 만들어지는데,
       사람은 대개 **이름을 먼저 적고 종류를 고릅니다** — 그러면 클로저가
       쥔 `newKind` 는 이름을 마지막으로 친 시점의 값(`'text'`)이고, 서버는
       그 값을 받아 **201** 을 줍니다. 화면에는 아무 오류도 안 납니다. */
  }, [newName, newKind, loadChannels]);

  const runSearch = useCallback(async (): Promise<void> => {
    // ⚠️ 그리는 자리와 **같은 판단**을 씁니다 (결함 375).
    if (!canSearch(query, null)) {
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
    /* ⚠️ **세션부터 봅니다** (결함 425 와 같은 모양). 이 파일의 다른 자리는
       전부 `isSessionExpired` → `goToLogin` 입니다. ⚠️ 이 자리는 화면으로
       **재현하지 못했습니다**(글 찾기를 켜려면 채널과 글이 먼저 필요합니다)
       — 결함으로 세지 않고, 같은 파일이 이미 지키는 규칙을 여기에도
       적용했습니다. */
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setNote({ text: await failureText(response, '찾지 못했습니다'), tone: 'bad' });
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
            {/* ⚠️ **종류를 고를 자리** (결함 360). 서버는 처음부터 둘 다
                받았고 화면은 음성 채널을 제대로 그렸는데(`voiceChannelNote`),
                만드는 자리만 텍스트로 박혀 있었습니다 — `vocab.py` 는 「두
                종류 다 화면에서 만들 수 있고」라고, `docs/20` 은 CHANNEL-002
                를 ✅ 라고 적어 두고 있었습니다.

                ⚠️ 이름표와 설명은 **서버가 줍니다.** 여기 적으면 어휘가 두
                벌이 되고, 종류가 늘 때 한쪽만 고쳐집니다.

                ⚠️ 못 받았으면 **안 그립니다.** 빈 라디오 묶음을 그리면
                누를 수 있는데 아무 뜻이 없는 칸이 됩니다. */}
            {kinds.length > 0 && (
              <fieldset className="ckind">
                <legend>채널 종류</legend>
                {kinds.map((choice) => (
                  <label key={choice.kind} htmlFor={`kind-${choice.kind}`}>
                    <input
                      id={`kind-${choice.kind}`}
                      type="radio"
                      name="channel-kind"
                      value={choice.kind}
                      checked={newKind === choice.kind}
                      onChange={() => setNewKind(choice.kind)}
                    />
                    <span className="kname">{choice.label}</span>
                    <span className="khint">{choice.hint}</span>
                  </label>
                ))}
              </fieldset>
            )}
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
              aria-describedby={searchBlocked !== null ? 'q-why' : undefined}
              onChange={(event) => setQuery(event.target.value)}
            />
            {/* ⚠️ **한 글자를 적는 순간 placeholder 가 사라집니다** — 그때
                단추는 그대로 막혀 있는데 화면 어디에도 이유가 없었습니다
                (결함 375). 찾기 화면은 같은 규칙을 `@lib` 의
                `blockedReason` 으로 이미 말하고 있었고, 이 화면만 규칙을
                손으로 다시 적고 있었습니다(대표 실패 ②).
                ⚠️ 그리고 진짜 `disabled` 가 아니라 `aria-disabled` 입니다
                (결함 234·373·374) — 닿지 못하면 사유를 들려줄 수 없습니다. */}
            <button
              type="submit"
              id="search"
              aria-disabled={!canFind}
              aria-describedby={searchBlocked !== null ? 'q-why' : undefined}
              onClick={(event) => {
                if (!canFind) {
                  event.preventDefault();
                  document.getElementById('q')?.focus();
                }
              }}
            >
              찾기
            </button>
            {searchBlocked !== null && (
              <p id="q-why" className="status plain">
                {searchBlocked}
              </p>
            )}
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
              /* ⛔ 예전에는 「`${channelTitle(open)}` 채널이 **방금
                 만들어졌습니다**」였습니다 (결함 304 회차). 화면은 만든
                 시각을 받지 않습니다 — 채널 목록은 {id, kind, name,
                 position} 뿐이라 「방금」인지 알 수가 없었습니다. 문구는
                 한 벌(`@lib`)에서 옵니다. */
              html={emptyHtml({ what: '아직 아무 말도 없습니다', ...describeEmptyChannel() })}
            />
          ) : (
            <div className="stream">
              {/* ⭐ **대화의 앞부분으로 가는 문** (결함 315). 서버는 한 번에
                  50개만 줍니다 — 그 앞이 있는지 없는지 화면이 말하지
                  않으면, 사람은 처음 열 줄이 사라진 줄도 모릅니다.
                  판단은 `@lib` 의 `hasOlderMessages`·`olderCursor`. */}
              {older !== 'none' && olderCursor(messages) !== null && (
                <p className="more">
                  <button
                    type="button"
                    id="older"
                    disabled={older === 'loading'}
                    onClick={() => void loadOlder(open.id, olderCursor(messages) as number)}
                  >
                    {older === 'loading' ? '불러오는 중…' : '이전 대화 더 보기'}
                  </button>
                </p>
              )}
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
                        quote={quoteFor(message.reply_to_id, messages)}
                        runOn={continuesRun(group.messages[i - 1], message)}
                        meId={me?.user_id ?? null}
                        busy={sending}
                        onReply={(target) => {
                          setReplyTo(target);
                          setEditing(null);
                          goToDraft();
                        }}
                        onEdit={(target) => {
                          setEditing(target);
                          setReplyTo(null);
                          setDraft(target.body);
                          /* ⚠️ `setDraft` 는 다음 그리기에 반영되므로 캐럿을
                             끝에 두려면 그 뒤에 옮겨야 합니다. */
                          requestAnimationFrame(goToDraft);
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
                        choices={choices}
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
                ref={draftBox}
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
