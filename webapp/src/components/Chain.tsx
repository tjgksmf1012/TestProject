import { Link } from 'react-router-dom';

// 사슬 — **빈 칸이 문장을 대신합니다.**
//
// ## 이 제품의 주장이 곧 이 모양입니다
//
// TeamFlow 가 하는 말은 한 줄입니다: *회의에서 한 말이 업무가 되고 코드가
// 된다.* 그런데 화면은 그 사슬을 문장으로 설명하고 있었습니다 —
//
//     연결된 PR이 없습니다 — PR 제목이나 본문에 TASK-4를 적으면 붙습니다
//
// 카드 넷에 같은 문장이 네 번(106자). 사슬을 그리면 이 문장이 통째로
// 필요 없어집니다. 고리 셋을 나란히 놓고 **마지막 고리를 비워 두면**,
// 그 빈 칸이 "여기가 아직 안 이어졌다" 를 말합니다.
//
// 이건 이 저장소가 원래 하던 것을 한 걸음 더 민 것입니다. 트랙 리본은
// 이미 "안 잰 구간" 을 빗금으로 그려 왔습니다 — 결측을 **그림으로** 말하는
// 문법이 이미 있었고, 사슬은 그 문법을 관계에 적용한 것입니다.
//
// ⚠️ **빈 칸을 0 으로 그리지 않습니다.** 값이 없는 고리는 `null` 이고
// 점선 자리로 남습니다. `0` 을 적으면 "0건 측정됨" 이 되는데, 대개는
// "아직 안 이어짐" 입니다 — 이 둘의 구분이 이 제품의 전부입니다.

export interface ChainLink {
  /** 한 낱말. 문장 금지. */
  label: string;
  /** 값. `null` 이면 **아직 안 이어진 고리** — 점선으로 비워 둡니다. */
  value: string | null;
  /** 눌러서 갈 곳 (SPA 라우트). 없으면 정적으로 그립니다. */
  to?: string;
  /** 마우스를 올렸을 때의 한 줄. 낭독기에는 aria-label 로 갑니다. */
  hint?: string;
}

interface ChainProps {
  links: ChainLink[];
  /** `sm` 은 카드 안(칸반), `md` 는 행(기여도). */
  size?: 'sm' | 'md';
}

export function Chain({ links, size = 'sm' }: ChainProps) {
  return (
    <div className={`chain chain--${size}`}>
      {links.map((link, i) => {
        const empty = link.value === null;
        const body = (
          <>
            {/* ⚠️ 빈 칸을 정말 비워 두면 "모양"만으로 말하게 됩니다.
                em dash 를 넣어 글자로도 말합니다 (색각이상·흑백 인쇄). */}
            <span className="chain__value">{link.value ?? '—'}</span>
            <span className="chain__label">{link.label}</span>
          </>
        );
        return (
          <div className="chain__cell" key={link.label}>
            {i > 0 && <span className="chain__arrow" aria-hidden="true" />}
            {link.to && !empty ? (
              <Link
                className="chain__link"
                to={link.to}
                title={link.hint}
                aria-label={link.hint ?? `${link.label} ${link.value}`}
                onClick={(e) => e.stopPropagation()}
              >
                {body}
              </Link>
            ) : (
              <span
                className={`chain__link${empty ? ' chain__link--empty' : ''}`}
                title={link.hint}
                aria-label={empty ? `${link.label} — 아직 이어지지 않았습니다` : undefined}
              >
                {body}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
