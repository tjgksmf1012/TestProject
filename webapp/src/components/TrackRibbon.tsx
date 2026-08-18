import { useId } from 'react';
import clsx from 'clsx';

// 트랙 리본 — 이 제품의 시그니처. "측정된 것과 못 잰 것"을 한 줄로 그립니다.
//
// 불변식 (docs/05 · 검수 D):
// - 채움 길이는 기여도가 아니라 **확신도/커버리지**에 비례합니다.
// - unknown(못 잰 구간)은 색만이 아니라 45° 빗금을 함께 그립니다 — 흑백·색각이상 대응.
// - 여러 사람을 같은 축 위에 겹쳐 그리지 않습니다. 리본 하나 = 사람 하나.

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
  const hatchId = useId();
  return (
    <div>
      {ticks && ticks.length > 0 && (
        <div className="ribbon-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      )}
      <svg
        className={clsx('ribbon', `ribbon--${size}`, sweep && 'ribbon--sweep')}
        role="img"
        aria-label={label}
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
      >
        <defs>
          <pattern
            id={hatchId}
            patternUnits="userSpaceOnUse"
            width="3"
            height="3"
            patternTransform="rotate(45)"
          >
            <rect width="3" height="3" fill="var(--c-unknown-tint)" />
            <line x1="0" y1="0" x2="0" y2="3" stroke="var(--ribbon-unknown)" strokeWidth="0.9" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="10" fill="var(--ribbon-empty)" />
        <g className="ribbon__fill">
          {segments.map((seg, i) => {
            const x = clamp01(seg.start) * 100;
            const w = Math.max(0, clamp01(seg.end) - clamp01(seg.start)) * 100;
            if (w === 0 || seg.kind === 'empty') return null;
            return (
              <rect
                key={i}
                x={x}
                y="0"
                width={w}
                height="10"
                fill={seg.kind === 'known' ? 'var(--ribbon-known)' : `url(#${hatchId})`}
              />
            );
          })}
        </g>
      </svg>
    </div>
  );
}
