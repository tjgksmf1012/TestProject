/**
 * 알림 화면 (요구사항 정의서 §19).
 *
 * ## ⚠️ 만들었으면 **볼 자리**를 줍니다
 *
 * 알림을 쌓아 두고 볼 화면이 없으면 그건 이 저장소가 반복해서 당한
 * 실패 ③ 입니다 — "할 일을 알려 주고 그 일을 할 자리를 안 줌".
 *
 * ## ⚠️ 문장은 **서버가** 만듭니다
 *
 * `notifications` 표에는 가리키는 번호만 있고 글자가 없습니다. 서버가
 * 읽을 때 만들어 주므로 업무 이름을 고치면 문장도 따라옵니다. 화면이
 * 자기 문장을 만들면 그 표가 두 벌이 되고 반드시 갈라집니다.
 *
 * ## ⚠️ 마감 알림은 **읽을 수 없습니다**
 *
 * 저장된 것이 아니라 지금 상태에서 나온 것이라, 읽음 표시를 보내 봐야
 * 서버가 할 일이 없습니다.
 *
 * ⚠️ 예전에는 화면이 `readableIds` 로 그것을 걸러 **번호를 모아** 보냈는데,
 * 그 방식 자체가 결함 432 의 원인이었습니다 — 목록은 `MAX_ITEMS` 로 잘리고
 * 배지는 DB 전수라 잘린 뒤쪽이 영영 안 읽혔습니다. 지금은 서버의
 * `mark_all_read`(`all_unread: true`) 가 「이 프로젝트의 내 것 전부」를 지우고, 파생 알림은
 * 애초에 행이 없어서 걸릴 것이 없습니다 — **판단이 한 자리로 모였습니다.**
 */

import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  badgeText,
  describeKind,
  emptyNote,
  hrefFor,
  isUrgent,
  canMarkAllRead,
  timeLabel,
  type Notice,
} from '../lib/notifications/view.ts';
import { isSessionExpired, loginUrlFor, safeApiBase } from '../lib/auth/session.ts';
import { tryGet, trySend, unreachableText } from '../lib/http/send.ts';
import { emptyHtml } from '../lib/ui/empty.ts';
import { detailText } from '../lib/http/detail.ts';
import { describeHttpStatus, failureHtml } from '../lib/ui/failure.ts';
import { whileLoading } from '../lib/ui/pending.ts';
import { rows as rowSkeleton } from '../lib/ui/skeleton.ts';
import { NoteLine, RawHtml, type Note } from './parts.tsx';
import { renderNav } from './nav.ts';
import { bootApp } from './pwa.ts';

const params = new URLSearchParams(location.search);
const apiBase = safeApiBase(params.get('api'), location.origin);
const projectId = Number(params.get('project') ?? '1');

const get = (path: string): Promise<Response | null> => tryGet(`${apiBase}${path}`);

function goToLogin(): void {
  location.href = loginUrlFor(location.pathname + location.search);
}

function App() {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const response = await whileLoading(
      get(`/api/projects/${projectId}/notifications`),
      () => setSlow(true),
      () => setSlow(false),
    );
    if (response === null) {
      setFailure(unreachableText('알림을 못 불러왔습니다'));
      setNotices([]);
      return;
    }
    if (isSessionExpired(response.status)) {
      goToLogin();
      return;
    }
    if (!response.ok) {
      setFailure(describeHttpStatus(response.status) ?? '알림을 못 불러왔습니다');
      setNotices([]);
      return;
    }
    setFailure(null);
    setNotices((await response.json()) as Notice[]);

    const badge = await get(`/api/projects/${projectId}/notifications/unread`);
    if (badge !== null && badge.ok) {
      setUnread(((await badge.json()) as { unread: number }).unread);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const markRead = useCallback(async (): Promise<void> => {
    /* ⚠️ **번호를 모아 보내지 않습니다.** 예전에는 `readableIds(notices)` 를
       보냈는데, 그 목록은 `MAX_ITEMS` 로 잘린 **이 페이지**뿐이고 배지는
       DB 전수입니다 — 61건에서 한 번 누르면 21건이 남고, 그때는 목록 안에
       안 읽은 것이 0 이라 버튼까지 잠겨 **영영 못 지웠습니다.**
       버튼이 「다」 라고 말하면 서버에도 「다」 라고 말할 자리가 있어야
       합니다. */
    if (!canMarkAllRead(unread)) return;
    setSending(true);
    try {
      const response = await trySend(() =>
        fetch(`${apiBase}/api/projects/${projectId}/notifications/read`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          /* ⚠️ **빈 목록이 「전부」 라는 뜻이 아닙니다** — 「전부」 는
             `all_unread` 로 따로 말합니다. 되돌릴 수 없는 일에 지름길을
             두면 화면이 실수로 빈 배열을 보냈을 때 알림이 통째로 사라집니다. */
          body: JSON.stringify({ notification_ids: [], all_unread: true }),
        }),
      );
      if (response === null) {
        setNote({ text: unreachableText('읽음 표시를 못 보냈습니다'), tone: 'bad' });
        return;
      }
      /* ⚠️ **세션부터 봅니다** (결함 427 과 같은 모양). 이 화면의 로드는
         이미 `isSessionExpired` → `goToLogin` 인데 **쓰기만** 빠져
         있었습니다 — 읽기와 쓰기가 다른 길이었습니다. */
      if (isSessionExpired(response.status)) {
        goToLogin();
        return;
      }
      if (!response.ok) {
        setNote({
          /* 서버가 쓴 문장이 먼저입니다 (결함 301) — `describeHttpStatus`
             는 400 에 아무 말도 없습니다. */
          text: detailText(
            await response.json().catch(() => null),
            describeHttpStatus(response.status) ?? '읽음 표시를 못 보냈습니다',
          ),
          tone: 'bad',
        });
        return;
      }
      setNote(null);
      await load();
    } finally {
      setSending(false);
    }
  }, [unread, load]);

  const badge = badgeText(unread);

  const header = (
    <header className="head">
      <h1>알림</h1>
      <p className="lede">
        나를 부른 대화, 맡은 업무, 다가오는 마감과 회의입니다. 마감과 지연은{' '}
        <b>따로 쌓아 두지 않고</b> 지금 상태에서 만들기 때문에, 마감일을 미루거나
        업무를 끝내면 그 자리에서 사라집니다.
      </p>
    </header>
  );

  if (failure !== null && notices !== null && notices.length === 0) {
    return (
      <>
        {header}
        <RawHtml html={failureHtml({ what: failure, retry: true })} onRetry={() => void load()} />
      </>
    );
  }

  if (notices === null) {
    return (
      <>
        {header}
        {slow && <div aria-busy="true" dangerouslySetInnerHTML={{ __html: rowSkeleton(4) }} />}
      </>
    );
  }

  /* ⚠️ 게이트를 **배지와 같은 축**으로 잽니다. 목록으로 재면 잘린 뒤쪽이
     남아 있는데도 버튼이 잠깁니다 (`canMarkAllRead` 머리말). */
  const canRead = canMarkAllRead(unread);

  return (
    <>
      {header}

      <div className="nbar">
        <p className="ncount">
          안 읽은 알림{' '}
          {/* ⚠️ 0 이면 배지를 안 그립니다 — "0건" 은 뜻이 없습니다. */}
          {badge === null ? <span className="none">없음</span> : <b className="badge">{badge}</b>}
        </p>
        {/* ⚠️ 읽을 것이 없으면 버튼을 잠급니다. 눌러도 아무 일이 안 일어나는
            버튼을 두면 사람은 화면이 고장 났다고 읽습니다. */}
        <button type="button" id="read-all" disabled={!canRead || sending} onClick={() => void markRead()}>
          다 읽음으로
        </button>
      </div>

      <NoteLine note={note} id="notice-note" />

      {notices.length === 0 ? (
        <RawHtml html={emptyHtml(emptyNote())} />
      ) : (
        <ul className="nlist">
          {notices.map((notice, i) => {
            const href = hrefFor(notice, projectId);
            const when = timeLabel(notice);
            const classes = ['nitem'];
            if (!notice.read && notice.notification_id !== null) classes.push('fresh');
            if (isUrgent(notice)) classes.push('urgent');
            return (
              <li key={`${notice.kind}-${notice.notification_id}-${i}`} className={classes.join(' ')}>
                <span className="nkind">{describeKind(notice.kind)}</span>
                {/* ⚠️ 시각을 그리는 곳 (결함 331). 서버는 `at` 을 줄곧 보내고
                    있었는데 **화면이 한 글자도 안 그렸습니다** — 목록이 그
                    값으로 정렬되는데도요. 무엇을 가리키는 시각인지는
                    `@lib` 이 정합니다(마감일과 일어난 때는 다릅니다). */}
                {when !== null && <span className="nwhen">{when}</span>}
                {href === null ? (
                  <span className="ntext">{notice.text}</span>
                ) : (
                  <a className="ntext" href={href}>
                    {notice.text}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

const host = document.getElementById('app');
if (host !== null) createRoot(host).render(<App />);
renderNav('notifications');
bootApp();
