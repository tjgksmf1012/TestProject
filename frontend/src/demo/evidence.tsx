/**
 * 근거 발화 보기 — **이 저장소의 첫 React 화면 조각** (docs/19 §24).
 *
 * ## 왜 여기부터인가
 *
 * 스택을 옮기기로 했는데, 첫 삽을 `Hello World` 로 뜨면 파이프라인이
 * 도는지는 알아도 **이 제품에서 통하는지**는 모릅니다. 그래서 첫 조각을
 * 진짜 기능으로 골랐습니다 — 오랫동안 `근거 #5` 라고 적어 놓고 눌러도
 * 아무 데도 못 가던 그 자리입니다.
 *
 * 이 조각 하나로 셋을 한꺼번에 증명합니다:
 *   esbuild 가 TSX 를 묶는가 · Tailwind 가 우리 토큰을 쓰는가 ·
 *   Radix 가 접근성(포커스 가둠·Esc·ARIA)을 대신해 주는가.
 *
 * ## ⚠️ 판단은 여기 없습니다
 *
 * 무엇을 물을지·어떻게 읽을지·못 받은 것을 뭐라 할지는 전부
 * `lib/review/evidence.ts` 에 있고 테스트 18개가 붙어 있습니다.
 * 이 파일은 **그리기와 붙이기**만 합니다 — 화면 코드에는 자동 테스트가
 * 없으므로, 판단이 여기 섞이면 그만큼 검증 밖으로 나갑니다.
 */

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Dialog from '@radix-ui/react-dialog';

import {
  emptyEvidenceNote,
  evidenceQuery,
  evidenceView,
  missingNote,
  type EvidenceView,
  type Utterance,
} from '../lib/review/evidence.ts';
import { tryGet } from '../lib/http/send.ts';

interface Request {
  /**
   * 어느 회의의 발화인가.
   *
   * ⚠️ 예전에는 **상자를 붙일 때** 회의를 정했습니다(`mountEvidence(apiBase,
   * meetingId)`). 그러면 회의 하나짜리 화면(검토)에서만 쓸 수 있고, 칸반처럼
   * **카드마다 회의가 다른** 화면에서는 붙일 수가 없습니다 — 그래서 칸반은
   * 「근거 발화 3건」이라고 **개수만 적고** 원문으로 가는 문이 없었습니다
   * (결함 418). 회의는 **부를 때** 정합니다.
   */
  meetingId: number;
  ids: number[];
  title: string;
}

/** 지금 무엇을 보고 있는가. `null` 이면 상자가 닫혀 있습니다. */
type Ask = Request | null;

let setAsk: (ask: Ask) => void = () => {};

/**
 * 근거 발화 상자를 연다. 화면 어디서든 부를 수 있습니다.
 *
 * ⚠️ 인자로 **제목까지** 받습니다. 상자만 띄우면 사람이 "이게 어느
 * 후보의 근거였지" 를 잊습니다 — 상자는 카드를 덮으니까요.
 */
export function openEvidence(
  meetingId: number,
  ids: readonly number[],
  title: string,
): void {
  setAsk({ meetingId, ids: [...ids], title });
}

function Body({ apiBase, ask }: { apiBase: string; ask: Request }) {
  const meetingId = ask.meetingId;
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'done'; rows: Utterance[] } | { kind: 'unreachable' }
  >({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    const query = evidenceQuery(ask.ids);
    if (query === '') {
      setState({ kind: 'done', rows: [] });
      return;
    }
    setState({ kind: 'loading' });
    void tryGet(`${apiBase}/api/meetings/${meetingId}/utterances?ids=${query}`).then(
      async (response) => {
        if (!alive) return;
        // ⚠️ 닿지 못한 것과 "근거가 없다" 를 섞지 않습니다. 앞은 다시
        // 해 보면 되고, 뒤는 다시 해도 안 바뀝니다.
        if (response === null || !response.ok) {
          setState({ kind: 'unreachable' });
          return;
        }
        setState({ kind: 'done', rows: (await response.json()) as Utterance[] });
      },
    );
    return () => {
      alive = false;
    };
  }, [apiBase, meetingId, ask]);

  if (state.kind === 'loading') {
    return <p className="text-text-subtle text-label">불러오는 중…</p>;
  }
  if (state.kind === 'unreachable') {
    return (
      <p className="text-text-muted text-label">
        근거 발화를 불러오지 못했습니다 — 연결을 확인하고 다시 열어 주세요.
      </p>
    );
  }

  const views: EvidenceView[] = state.rows.map(evidenceView);
  const missing = missingNote(ask.ids, state.rows);

  if (views.length === 0) {
    return <p className="text-text-muted text-label">{emptyEvidenceNote(ask.ids)}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {views.map((view) => (
        <article key={view.id} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 text-caption text-text-subtle">
            {view.at !== null && <span className="tabular-nums">{view.at}</span>}
            <span className="font-semibold text-text-muted">{view.speaker}</span>
            {/* ⚠️ 유형은 서버가 오래전부터 보내고 있었는데 **화면이 안 쓰고
                있었습니다** — 대표 실패 ①. 이게 보여야 사람이 잘못 매겨진
                라벨을 발견할 수 있습니다. */}
            {view.type !== null && <span className="text-text-subtle">{view.type}</span>}
            {view.overlap && <span className="text-gap">동시 발언</span>}
          </div>
          {/* 원문. 손대지 않고 그대로 — 줄바꿈도 살립니다. */}
          {/* ⚠️ 이 줄이 이 제품의 대표 주장입니다 — 숫자에서 출발해 **몇 번째
              발언까지** 거슬러 올라간 그 원문. 크기를 px 로 적으면 브라우저
              기본 글자를 키운 사람에게 이 줄이 화면에서 **가장 작은 글자**가
              됩니다(제목은 40px 인데 원문은 14px — 결함 443). 14px 짜리
              토큰이 없어 `--fs-body`(15)로 올렸습니다 — 한 단계 커집니다. */}
          <p className="text-body leading-relaxed whitespace-pre-wrap text-text">{view.text}</p>
          {view.speakerNote !== null && (
            <p className="text-caption text-gap">{view.speakerNote}</p>
          )}
        </article>
      ))}
      {missing !== null && <p className="text-caption text-gap">{missing}</p>}
    </div>
  );
}

function EvidenceDialog({ apiBase }: { apiBase: string }) {
  const [ask, set] = useState<Ask>(null);
  setAsk = set;

  return (
    <Dialog.Root open={ask !== null} onOpenChange={(open) => !open && set(null)}>
      <Dialog.Portal>
        {/* ⚠️ 덮개를 새까맣게 하지 않습니다. 뒤의 카드가 비쳐야 "이 후보의
            근거" 라는 관계가 유지됩니다.

            ⚠️ **층을 적어야 합니다.** 이 상자는 `Dialog.Portal` 로 `<body>`
            끝에 붙으므로 뿌리 쌓임 맥락에 서는데, 층을 안 적으면 0 이라
            `#tabs`(30)·`.actionbar`(20) 같은 **고정 크롬 아래**로 깔립니다.
            1440x900 에서는 상자가 그 사이에 들어가 안 겹치지만, 확대 200%
            에서 23% · 브라우저 기본 글자 32px 에서 22% 가 덮였습니다
            (결함 442). SPA 의 `.dialog` 는 처음부터 50/51 이고 그 옆에
            왜인지가 적혀 있습니다 — 레거시만 빠져 있었습니다.
            ⚠️ `.skip`(100) 보다는 **아래**입니다. 그건 초점을 받을 때만
            나타나는 탈출구이고, 상자가 초점을 가두므로 만날 일이 없습니다. */}
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/25" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-51 w-[min(34rem,calc(100vw-2rem))] max-h-[80vh]
                     -translate-x-1/2 -translate-y-1/2 overflow-y-auto
                     rounded-card border border-line bg-surface p-6
                     focus:outline-none"
        >
          {/* ⚠️ 크기를 여기서 정하지 않습니다 — `app.css` 의 `h2` 가 정합니다
              (`--fs-title`). 저 파일은 **레이어가 없어서** `@layer utilities`
              안의 Tailwind 를 특성도와 상관없이 전부 이깁니다. 오래도록
              `text-[15px]` 가 적혀 있었는데 화면은 한 번도 15px 인 적이
              없었습니다(20px, 기본 글자 32px 에서는 40px — 결함 443). */}
          <Dialog.Title className="m-0 font-semibold text-text">
            회의에서 이렇게 말했습니다
          </Dialog.Title>
          <Dialog.Description className="mt-1 mb-5 text-caption text-text-subtle">
            {ask?.title ?? ''}
          </Dialog.Description>
          {ask !== null && <Body apiBase={apiBase} ask={ask} />}
          <div className="mt-6 flex justify-end">
            {/* ⚠️ 여기도 크기·높이를 안 적습니다 — `app.css` 의 `button` 이
                `--fs-item`(15) 과 `min-height: var(--tap)`(44) 을 정하고,
                레이어가 없어 언제나 이깁니다. 적혀 있던 `text-[13px]` 과
                `min-h-0` 은 둘 다 **한 번도 안 먹었습니다**(재 봤습니다:
                15px · 44px). ⚠️ 그리고 `min-h-0` 은 먹었다면 이 저장소의
                44px 손가락 표적 규칙을 깨는 것이었습니다 — 진 덕분에
                안 깨졌을 뿐이라 지웁니다. */}
            <Dialog.Close className="rounded-ctrl border border-line-strong bg-bg
                                     px-4 py-2 font-medium text-text-muted">
              닫기
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * 상자를 화면에 붙인다. 한 번만 부르면 됩니다.
 *
 * ⚠️ `document.body` 끝에 새 `<div>` 를 만듭니다. 기존 화면의 DOM 을
 * 건드리지 않으므로, 옮기지 않은 화면이 깨지지 않습니다 — 스택을
 * 하나씩 옮기는 동안 이 성질이 중요합니다.
 */
export function mountEvidence(apiBase: string): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(<EvidenceDialog apiBase={apiBase} />);
}
