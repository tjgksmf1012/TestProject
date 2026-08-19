import clsx from 'clsx';

// 값이 주인공, 뜻은 조연.
//
// ## 왜 이것이 필요한가 (실측)
//
// 리디자인 2차까지도 화면의 글자 위계 범위가 11~16px, 겨우 **1.45배**였습니다.
// 검토 화면은 12·13·14px 이 전체 글자의 93% — 모든 것이 같은 목소리 크기로
// 말하니 무엇을 먼저 볼지 알 수 없고, 그게 "지저분하다"의 정체였습니다.
//
// 그리고 값을 **문장으로** 썼습니다: `신뢰도 낮음 · 모르는 폭 20%p`.
// 이건 값 둘(낮음, 20%p)인데 문장 모양이라 읽는 데 시간이 걸립니다.
//
// 계기판은 문장을 쓰지 않습니다. 숫자를 크게 쓰고 단위를 작게 답니다.
// 값:라벨 = 최소 2:1 (22px : 11px). 라벨 하한이 11px 인 이유는 한글이
// 10px 이하에서 자소가 뭉개지기 때문입니다 — 영문 UI 의 10px 캡션을
// 그대로 가져오면 안 됩니다.

interface StatProps {
  /** 측정값. 모노 + tabular-nums 로 그립니다. */
  value: string;
  /** 이 값이 무엇인가 — **한 낱말**. 문장을 넣지 마십시오. */
  label: string;
  /** `unknown` 은 못 잰 값(황토), `evidence` 는 근거 있는 값(인디고). */
  tone?: 'plain' | 'unknown' | 'evidence';
  /** 값 옆에 붙는 것 — `Why` 버튼 등. */
  children?: React.ReactNode;
}

export function Stat({ value, label, tone = 'plain', children }: StatProps) {
  return (
    <span className={clsx('stat', tone !== 'plain' && `stat--${tone}`)}>
      <span className="stat__value">
        {value}
        {children}
      </span>
      <span className="stat__label">{label}</span>
    </span>
  );
}
