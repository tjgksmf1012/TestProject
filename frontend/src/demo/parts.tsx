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
