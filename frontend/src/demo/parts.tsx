/**
 * 화면 둘 이상이 쓰는 React 조각.
 *
 * ⚠️ **두 번째로 필요해지는 순간 여기로 올립니다.** 같은 판단이 두 곳에
 * 있으면 반드시 갈라지고, 갈라지면 한쪽만 고쳐집니다 — 이 저장소가 반복해
 * 당한 셋 중 하나입니다. 검토 화면 하나만 React 일 때는 `review.tsx` 안에
 * 있었고, 칸반이 같은 것을 필요로 하는 지금 올렸습니다.
 *
 * ⚠️ 여기 있는 것은 **그리기뿐**입니다. 판단은 `src/lib/**` 에 있어야
 * 합니다 — 화면 코드에는 자동 테스트가 없습니다.
 */

import { useEffect, useRef } from 'react';

import { avatarInitial } from '../lib/ui/byline.ts';

/**
 * 서버가 준 HTML 을 그대로 꽂는 자리.
 *
 * `emptyHtml`·`failureHtml` 은 "무엇을·왜·다음에 뭘" 을 타입으로 강제하는
 * lib 함수라 문자열을 돌려줍니다. 그걸 React 로 다시 쓰면 **두 벌**이 되고,
 * 아직 그 함수를 쓰는 화면이 넷 남아 있습니다.
 *
 * `onRetry` 는 `failureHtml({retry: true})` 가 그린 버튼을 잇습니다.
 * 안 이으면 눌러도 아무 일이 안 일어나고, 사람은 화면이 더 고장 났다고
 * 생각합니다 — 만들어 놓고 안 부르는 그 방식 그대로입니다.
 */
export function RawHtml({
  html,
  onRetry,
}: {
  html: string;
  onRetry?: (() => void) | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const button = ref.current?.querySelector<HTMLButtonElement>('.retry');
    if (button === null || button === undefined || onRetry === undefined) return;
    const handler = (): void => onRetry();
    button.addEventListener('click', handler);
    return () => button.removeEventListener('click', handler);
  }, [html, onRetry]);
  return <div ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * "누가 보고 있는가" 한 줄. 명령형 화면의 `bylineHtml` 과 **같은 모양**입니다.
 *
 * 글자 고르기(`avatarInitial`)는 `lib` 에 있습니다 — 한 글자를 떼는 것도
 * 판단이고, 이모지·결합 문자에서 틀리기 쉬워 테스트가 붙어 있습니다.
 */
export function Byline({ name, what }: { name: string; what?: string }) {
  return (
    <p className="by">
      <span className="avatar" aria-hidden="true">
        {avatarInitial(name)}
      </span>
      {what === undefined ? name : `${name} · ${what}`}
    </p>
  );
}

/**
 * 색까지 같이 정하는 한 줄. 글자만 바꾸면 실패가 상태처럼 보입니다 (결함 98).
 *
 * ⚠️ **이 타입과 아래 `NoteLine` 이 `lobby.tsx`·`project.tsx` 에 두 벌
 * 있었습니다.** 그리고 이미 갈라져 있었습니다 — 로비 쪽은 `status` 클래스를
 * 늘 붙이는데 프로젝트 쪽은 안 붙였습니다. 이 파일이 막으려던 그 모양이
 * 이 파일 밖에서 일어난 것입니다.
 */
export interface Note {
  text: string;
  tone: 'bad' | 'plain';
}

/**
 * 한 줄 안내. **낭독기에게도 들립니다.**
 *
 * ⚠️ **비었을 때도 상자를 그립니다.** 예전에는 `note === null` 이면
 * `return null` 이라 요소가 DOM 에서 사라졌는데, 그러면 `role="status"` 를
 * 붙여도 소용이 없습니다 — 낭독기는 **이미 있던** live region 이 바뀔 때
 * 읽어 주지, 요소가 통째로 나타나는 것은 놓치기 쉽습니다. 로그인 오류
 * 상자에서 같은 이유로 같은 결정을 했습니다.
 * 비어 있으면 글자가 없어 화면에서는 아무것도 안 보입니다.
 *
 * ⚠️ `alert` 이 아니라 `status` 입니다. `alert` 은 읽던 것을 끊습니다 —
 * "저장했습니다" 가 끼어들 일은 아닙니다. 로그인의 검증 요약만 `alert`
 * 인데, 그건 사람이 방금 제출을 눌렀고 그것이 막힌 자리라서입니다.
 */
export function NoteLine({
  note,
  id,
  className = 'status',
}: {
  note: Note | null;
  id?: string;
  className?: string;
}) {
  const tone = note === null || note.tone !== 'bad' ? 'plain' : 'bad';
  return (
    <p id={id} role="status" className={`${className} ${tone}`}>
      {note === null ? '' : note.text}
    </p>
  );
}
