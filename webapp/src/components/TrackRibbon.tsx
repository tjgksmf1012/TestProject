import clsx from 'clsx';

// 트랙 리본 — 이 제품의 시그니처. "측정된 것과 못 잰 것"을 한 줄로 그립니다.
//
// 불변식 (docs/05 · 검수 D · 수정 지시서 v2 F1):
// - 채움 길이는 기여도가 아니라 **확신도/커버리지**에 비례합니다.
// - 채움 색은 검정/흰색이 아니라 **인디고**(--ribbon-known)입니다 — 다크에서
//   화면의 가장 밝은 요소가 되면 "측정된 양"이 주인공이 됩니다. 주인공은
//   "모르는 폭"입니다.
// - unknown(못 잰 구간)은 색만이 아니라 2px 사선을 함께 그립니다 — 축소
//   캡처에서도 보여야 합니다 (v2 F1-1).
// - 여러 사람을 같은 축 위에 겹쳐 그리지 않습니다. 리본 하나 = 사람 하나.
//
// ⚠️ SVG 가 아니라 div 입니다. viewBox 를 늘리면 사선 각도가 폭마다
// 달라져서(preserveAspectRatio: none) 45° 가 거짓이 됩니다 — CSS
// repeating-linear-gradient 는 폭과 무관하게 각도가 고정입니다.

export type RibbonKind = 'known' | 'unknown' | 'empty';

export interface RibbonSegment {
  /** 축에서의 시작 위치, 0~1 */
  start: number;
  /** 축에서의 끝 위치, 0~1 */
  end: number;
  kind: RibbonKind;
}

interface TrackRibbonProps {
  segments: RibbonSegment[];
  size: 'lg' | 'md' | 'sm';
  /** role="img" 이므로 반드시 의미 있는 설명을 넣습니다. */
  label: string;
  /** 등간격 눈금(모노), 리본 위에. 빈 상태에도 축은 그립니다 — "아직 아무것도 없음"도 측정 결과입니다. */
  ticks?: string[];
  /** 마운트 시 채움을 한 번 쓸어 그립니다 (reduced-motion 이면 CSS 가 끕니다). */
  sweep?: boolean;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function TrackRibbon({ segments, size, label, ticks, sweep }: TrackRibbonProps) {
  return (
    <div>
      {ticks && ticks.length > 0 && (
        <div className="ribbon-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      )}
      <div
        className={clsx('ribbon', `ribbon--${size}`, sweep && 'ribbon--sweep')}
        role="img"
        aria-label={label}
      >
        <div className="ribbon__fill">
          {segments.map((seg, i) => {
            const left = clamp01(seg.start) * 100;
            const width = Math.max(0, clamp01(seg.end) - clamp01(seg.start)) * 100;
            if (width === 0 || seg.kind === 'empty') return null;
            return (
              <span
                key={i}
                className={`ribbon__seg ribbon__seg--${seg.kind}`}
                style={{ left: `${left}%`, width: `${width}%` }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
