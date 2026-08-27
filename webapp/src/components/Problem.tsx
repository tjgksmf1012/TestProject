import type { ReactNode } from 'react';

import { plainText } from '@lib/ui/plain.ts';

/**
 * 사람에게 **"이건 아직 안 됩니다"** 를 말하는 자리.
 *
 * ## ⚠️ 화면에 뜨기만 하고 아무도 안 듣고 있었습니다
 *
 * 이 저장소에는 `.disabled-reason` 이 스무 곳 남짓 있는데, 그중 **둘만**
 * `role="alert"` 였습니다. 나머지는 눈으로 보는 사람에게만 나타나고
 * 낭독기에는 **아무 일도 안 일어난 것**과 같았습니다 (WCAG 4.1.3 상태
 * 메시지). 저장이 실패해도, 저장소 주소가 틀려도 조용했습니다.
 *
 * 스무 곳에 속성을 하나씩 흩뿌리면 반드시 몇 곳이 빠집니다. 그래서 자리
 * 자체를 한 벌로 올립니다.
 *
 * ## 두 가지 톤 — 끼어들 것인가, 기다릴 것인가
 *
 * ⚠️ 전부 `alert` 로 하면 안 됩니다. 저장소 주소 오류는 **글자를 칠 때마다**
 * 다시 나타나는데, `alert` 는 끼어들어 읽으므로 한 글자마다 낭독기가 말을
 * 끊습니다. 타자를 칠 수 없게 됩니다.
 *
 * - `failed` — **방금 한 일이 안 됐다.** 저장 실패·업로드 실패처럼 한 번
 *   일어나는 사건. 끼어들어 말합니다 (`role="alert"`).
 * - `incomplete` — **아직 조건이 안 찼다.** 입력하는 동안 계속 바뀌는 값.
 *   하던 말을 끊지 않고 기다렸다 말합니다 (`role="status"`).
 *
 * ⚠️ 라이브 영역은 **내용이 바뀌기 전에 DOM 에 있어야** 안정적으로
 * 읽힙니다. 조건부로 통째로 나타났다 사라지면 브라우저가 놓칠 수 있어
 * `role` 을 단 껍데기는 항상 두고 **안쪽 글자만** 바뀌게 합니다.
 */
export function Problem({
  children,
  id,
  tone = 'failed',
  inline = false,
}: {
  /** 없으면 껍데기만 남고 아무 말도 안 합니다 — 라이브 영역은 그대로 삽니다. */
  children?: ReactNode;
  id?: string;
  tone?: 'failed' | 'incomplete';
  /** 버튼과 같은 줄에 설 때. 바깥 여백을 지웁니다. */
  inline?: boolean;
}) {
  const empty = children === null || children === undefined || children === false;
  return (
    <p
      className={`disabled-reason${inline ? ' disabled-reason--inline' : ''}${empty ? ' disabled-reason--empty' : ''}`}
      {...(id !== undefined ? { id } : {})}
      role={tone === 'failed' ? 'alert' : 'status'}
    >
      {/* ⛔ 여기로 오는 문구는 대부분 **서버가 만든 것**입니다. 그 문구에는
          강조와 코드 표시가 섞여 있고(같은 문장이 마크다운 보고서로도
          나갑니다), 그대로 그리면 한국어 문장 안에 백틱이 남습니다
          (결함 262). 글자면 걷어내고, 아니면(조각이면) 그대로 둡니다. */}
      {typeof children === 'string' ? plainText(children) : children}
    </p>
  );
}
