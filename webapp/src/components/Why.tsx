import * as Popover from '@radix-ui/react-popover';

// 이유는 **부르면 온다**.
//
// ## 정보를 지우는 것이 아니라 옮기는 것입니다
//
// 이 제품은 정직해야 해서(측정 불가 ≠ 0점 · 판정에는 사유가 붙는다) 화면에
// 설명 문장이 쌓였습니다. 그런데 같은 문장이 카드마다 반복되면서 —
// 칸반은 `연결된 PR이 없습니다 — PR 제목이나 본문에 TASK-N을 적으면
// 붙습니다` 를 네 번(106자), 검토는 `회의에서 담당자가 지정되지
// 않았습니다` 를 다섯 번(98자) — 정작 그 문장을 아무도 안 읽게 됐습니다.
// 늘 있는 글자는 배경이 됩니다.
//
// 그래서 **지우지 않고 한 겹 아래로** 내립니다. 화면에는 `?` 한 글자,
// 누르면 원래 문장이 **그대로** 나옵니다. 요약하지 않습니다 — 요약하면
// 그게 곧 정보 손실이고, 이 저장소가 지켜 온 "사유를 남긴다" 가 깨집니다.
//
// ⚠️ **아이콘만 남기지 않습니다.** 2024~2025 년에 텍스트를 걷어낸 UI 가
// 실패한 자리는 전부 "아이콘만 남기고 뜻을 지운" 경우입니다. 여기서는
// `?` 옆에 언제나 값이나 라벨이 함께 서 있고, 버튼 자체에 `aria-label` 로
// 무엇에 대한 이유인지 적습니다. 낭독기는 팝오버를 열지 않고도 압니다.

interface WhyProps {
  /** 무엇에 대한 이유인가 — 낭독기와 팝오버 제목에 함께 씁니다. */
  about: string;
  /** 원문 그대로. **요약하지 마십시오.** */
  lines: string[];
}

export function Why({ about, lines }: WhyProps) {
  if (lines.length === 0) return null;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="why"
          aria-label={`${about} — 이유 ${lines.length}가지 보기`}
          onClick={(e) => e.stopPropagation()}
        >
          ?
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="why__pop" sideOffset={6} collisionPadding={12}>
          <p className="why__title">{about}</p>
          {lines.map((line) => (
            <p className="why__line" key={line}>
              {line.replace(/\*\*/g, '')}
            </p>
          ))}
          <Popover.Arrow className="why__arrow" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
