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
export function openEvidence(ids: readonly number[], title: string): void {
  setAsk({ ids: [...ids], title });
}

function Body({ apiBase, meetingId, ask }: { apiBase: string; meetingId: number; ask: Request }) {
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
    return <p className="text-text-subtle text-[13px]">불러오는 중…</p>;
  }
  if (state.kind === 'unreachable') {
    return (
      <p className="text-text-muted text-[13px]">
        근거 발화를 불러오지 못했습니다 — 연결을 확인하고 다시 열어 주세요.
      </p>
    );
  }

  const views: EvidenceView[] = state.rows.map(evidenceView);
  const missing = missingNote(ask.ids, state.rows);

  if (views.length === 0) {
    return <p className="text-text-muted text-[13px]">{emptyEvidenceNote(ask.ids)}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {views.map((view) => (
        <article key={view.id} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-2 text-[12px] text-text-subtle">
            {view.at !== null && <span className="tabular-nums">{view.at}</span>}
            <span className="font-semibold text-text-muted">{view.speaker}</span>
            {view.overlap && <span className="text-gap">동시 발언</span>}
          </div>
          {/* 원문. 손대지 않고 그대로 — 줄바꿈도 살립니다. */}
          <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-text">{view.text}</p>
          {view.speakerNote !== null && (
            <p className="text-[12px] text-gap">{view.speakerNote}</p>
          )}
        </article>
      ))}
      {missing !== null && <p className="text-[12px] text-gap">{missing}</p>}
    </div>
  );
}

function EvidenceDialog({ apiBase, meetingId }: { apiBase: string; meetingId: number }) {
  const [ask, set] = useState<Ask>(null);
  setAsk = set;

  return (
    <Dialog.Root open={ask !== null} onOpenChange={(open) => !open && set(null)}>
      <Dialog.Portal>
        {/* ⚠️ 덮개를 새까맣게 하지 않습니다. 뒤의 카드가 비쳐야 "이 후보의
            근거" 라는 관계가 유지됩니다. */}
        <Dialog.Overlay className="fixed inset-0 bg-black/25" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 w-[min(34rem,calc(100vw-2rem))] max-h-[80vh]
                     -translate-x-1/2 -translate-y-1/2 overflow-y-auto
                     rounded-card border border-line bg-surface p-6
                     focus:outline-none"
        >
          <Dialog.Title className="m-0 text-[15px] font-semibold text-text">
            회의에서 이렇게 말했습니다
          </Dialog.Title>
          <Dialog.Description className="mt-1 mb-5 text-[12px] text-text-subtle">
            {ask?.title ?? ''}
          </Dialog.Description>
          {ask !== null && <Body apiBase={apiBase} meetingId={meetingId} ask={ask} />}
          <div className="mt-6 flex justify-end">
            <Dialog.Close className="min-h-0 rounded-ctrl border border-line-strong bg-bg
                                     px-4 py-2 text-[13px] font-medium text-text-muted">
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
export function mountEvidence(apiBase: string, meetingId: number): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  createRoot(host).render(<EvidenceDialog apiBase={apiBase} meetingId={meetingId} />);
}
